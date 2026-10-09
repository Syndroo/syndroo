# Self-hosted server and Cloudflare Worker

The remote surface is the same protocol v1 as the local CLI, served over HTTP.
It is a separate deployment with its own connections, credentials, operations
and idempotency records. It never reads the CLI's local state, and a local
failure is not a reason to switch to it.

Two runtimes implement it:

| Package | Runtime | State | Secrets |
| --- | --- | --- | --- |
| `@syndroo/server` | Node HTTP server | SQLite | encrypted store, key from deployment config |
| `@syndroo/cloudflare` | Cloudflare Worker | D1 | AES-GCM with AAD binding and crypto-shred |

Status: neither has been deployed from this tree, and the first-run behaviour
below has not been exercised against a real account. The SDK and Worker package
READMEs under `packages/` still describe the pre-v1 `posts` surface and are not
accurate for v1; the authoritative contract is this page.

## HTTP contract

```text
POST /v1/connect
POST /v1/publish
POST /v1/status
GET  /health                          # no business information
GET  /oauth/callback/:provider        # only when the OAuth module is configured
```

Every `/v1/*` request must carry `Authorization: Bearer <deployment secret>`.
Authentication runs before any business input is read. `/health` is the only
route that needs no credential; it returns `{"status":"ok"}` and proves
reachability only. `/oauth/callback/:provider` is owned by the optional OAuth
module and receives the browser request before authentication, because a browser
holds no deployment bearer; when no OAuth module is configured the path is a
plain `404`.

`POST /v1/status` has no business write side effect and responds with
`Cache-Control: no-store`. Responses also set `X-Content-Type-Options: nosniff`
and `Content-Security-Policy: default-src 'none'`.

Requests must be `application/json` (optionally `; charset=utf-8`),
`content-encoding` must be absent or `identity`, and the body is capped at 64 KiB.
An `Idempotency-Key` header, when present, must match `[A-Za-z0-9._:-]{1,128}`;
the same key with the same body replays the original result and the same key with
a different body is a conflict.

### Envelope

```json
{
  "protocolVersion": 1,
  "operation": "publish",
  "ok": true,
  "result": { "status": "pending", "operationId": "op_example", "phase": "execution", "deliveries": [] },
  "error": null
}
```

`ok` means the protocol call was handled, not that a platform published anything.
Business results live in `result`; a failure carries a stable `code`, a static
`message`, and bounded `details`.

### Status codes

| Code | When |
| --- | --- |
| `200` | Completed protocol response: a query, a connect action, or a prepared result |
| `202` | A durable admitted execution that is still non-terminal (`pending`/`running`) |
| `400` | Invalid input or an invalid provider |
| `401` / `403` | Missing or wrong bearer / a forbidden action or untrusted provider |
| `404` | Unknown route or record |
| `405` | Wrong method for a `/v1/*` route |
| `409` | A conflict such as `IDEMPOTENCY_CONFLICT`, `STALE_INTENT`, `APPROVAL_INVALID`, `RETRY_INELIGIBLE` |
| `413` / `415` | Body too large / unsupported media type |
| `429` / `504` | Rate limited / request timeout |
| `500` | Durability failure or an oversized response |
| `503` | Provider unavailable or state recovery required |

A `202` must never be reported as "not executed": an accepted operation whose
queue notification failed is still admitted, not cancelled.

## SDK

`@syndroo/sdk` is a dependency-free HTTP client for one deployment. It imports
no Core and no Provider code.

```ts
import { Syndroo } from "@syndroo/sdk";

const syndroo = new Syndroo({ baseUrl, apiKey });

const prepared = await syndroo.publish(
  { type: "prepare", content: { text: "Hello" }, targets: [{ provider: "bluesky" }] },
  { idempotencyKey: "req_example" },
);
```

- `connect`, `publish`, `status` mirror the protocol request unions and return the
  matching result type.
- `wait(operationId, options)` polls `status({ type: "operation" })` only. Defaults
  are a 2000 ms interval and a 120000 ms total wait, both bounded by the client.
- The client never approves, confirms or resumes anything itself, and never
  retries a business result. `failed`, `partial` and `unknown` are protocol
  successes, not transport exceptions.
- `timeoutMs` and `AbortSignal` end the client's wait only; they do not cancel
  server work or re-publish.
- Keep the API key in a trusted environment. It can publish; never ship it to a
  browser.

## Self-hosted server

`@syndroo/server` exposes `createSelfHostedRuntime(options)`, which returns an
HTTP `server`, the composed `core`, and a `close()` function. Options:

| Option | Meaning |
| --- | --- |
| `bearerSecret` | Exactly 32 random bytes encoded canonically as base64url (`[A-Za-z0-9_-]{43}`). |
| `statePath`, `secretsPath` | SQLite state and encrypted secret locations. |
| `secretStoreKey` | Key material for the encrypted credential store. |
| `providers`, `providerContext` | Registry and per-provider context; the server requires an explicit import and registration, never a filesystem scan. |
| `oauth` | Optional OAuth callback module. |
| `scope`, `principalId` | Single-deployment scope and principal identity. |
| `trustedProxyAddresses`, `requestTimeoutMs` | Canonical-origin resolution and request deadline (1 to 120000 ms). |

The server is single-tenant and always enforces bearer authentication: there is
no API to disable auth or disable security. An OAuth module is configuration, not
a runtime switch: a deployment either starts with a complete module
(`publicOrigin`, a `providers` list of 1 to 16 ids, and an optional `ttlMs` from
60000 to 900000 ms, defaulting to 900000) or refuses to start.

## Cloudflare Worker

`@syndroo/cloudflare` exports a Worker that composes the same Core with D1 state,
encrypted secrets, a work queue and cron recovery. It reads these bindings at
request time:

| Binding | Meaning |
| --- | --- |
| `DB` | D1 database. |
| `WORK_QUEUE` | Queue producer used to notify admitted work. |
| `QUEUE_NAME`, `DLQ_NAME` | Queue names; they must differ. |
| `API_BEARER` | Deployment bearer, 32 to 1024 characters, no whitespace. |
| `SECRET_KEY`, `RUNTIME_KEY` | Key material for the encrypted secret store and digests. |
| `SCOPE` | Deployment scope, `[A-Za-z0-9._:-]{1,128}`. |
| `PUBLIC_FETCH_STRICT` | Must be the exact string `enabled`. |

If a binding is missing or malformed, the Worker returns `503` before handling
the request. `queue` and `scheduled` entry points also assert the environment
before doing work.

### First-run behaviour

A freshly deployed Worker has no tables. `status` fails until the first `connect`
initializes storage; that is expected. The status path opens existing storage in
read-only mode and never creates or repairs it, while the connect path initializes
it. Connect once after a first deploy before relying on `status`.

### Deployment configuration

The Worker reads the bindings above, and the deployment must set Wrangler's
`global_fetch_strictly_public` flag so that outbound fetches never reach private
addresses. The `wrangler.jsonc` at the repository root is that config: it points
at the built `packages/cloudflare/dist/worker.js`, sets the compatibility flag,
and declares the bindings in the table above with no migrations directory,
because the D1 schema is created on demand. Build the Worker before deploying —
`npm run build --workspace @syndroo/cloudflare` — and create the D1 database, the
two queues and the three secrets in the target account first. `npx wrangler
deploy --dry-run` verifies the config without contacting an account; no
deployment has been performed from this tree.

## Migration from the pre-v1 path

There is none, by design. Protocol v1 does not read, migrate or delete the old
Worker's D1 data, the old CLI's local state, or any old credential reference.
Deploying v1 alongside an older instance creates an independent service with its
own records.

## What is not verified

- No server or Worker has been deployed from this tree.
- No HTTP integration has been run against a real deployment; the handler,
  authentication, SQLite, D1 and Worker paths are covered by tests and fixtures.
- The SDK README and the Worker README in `packages/` describe the pre-v1
  surface and have not been rewritten.

See [testing.md](testing.md) for what the test layers cover and
[releasing.md](releasing.md) for the release gates.
