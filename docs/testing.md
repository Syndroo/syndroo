# Testing Syndroo

## Local Mock SNS end-to-end gate

The Mock SNS gate in `e2e/` proves Syndroo's internal integration path without
contacting a social network:

```text
HTTP POST /v1/posts -> local D1 -> local Queue or controlled Cron
  -> real publisher (native Threads adapter, official Bluesky SDK)
  -> loopback Mock SNS HTTP server
  -> HTTP status query
```

Nothing inside Syndroo is replaced. The tests load the bundled production
Worker, apply the production D1 migrations, drive the real Queue binding and the
real `scheduled` handler, and use the real adapters. Only the network boundary
is replaced: an outbound policy forwards the exact SNS endpoints to a Mock SNS
server that listens on `127.0.0.1`.

This gate does not replace the separate live-account acceptance for Bluesky and
Threads. It proves wiring, persistence, idempotency, ambiguity handling, and
scheduling; it cannot prove provider permissions, API compatibility, or rate
limits.

## Gate layers and entry points

The local gate is the first of three layers. A pass at one layer never stands in
for another:

| Layer | Chain | Proves | Entry point |
| --- | --- | --- | --- |
| L1 local Mock | bundled Worker -> local D1/Queue/Cron -> real adapters -> Mock SNS | Internal delivery, idempotency, failure, and concurrency behaviour | `npm run e2e:local` |
| L2 installed artifact | install packed tarballs (or a registry RC) outside the repository -> real SDK and CLI -> L1 | The packages a user installs actually work, without workspace resolution | `npm run e2e:consumer -- --source tarball` |
| L3 real accounts | local SDK/CLI/Agent -> staging Worker -> real accounts | Real credentials, platform APIs, and the final remote post | `npm run e2e:live -- --plan <file>` |

`npm run e2e:local` is the same command as `npm run test:e2e`. It builds every
workspace, bundles the Worker, and then runs the Node-side Vitest project.

The L1 project also drives the two published client artifacts, not only the
Worker: `e2e/test/sdk-cli.spec.ts` starts the built SDK and the built `syndroo`
binary as a real child process against the same in-process Worker, through a
loopback proxy (`e2e/src/loopback-proxy.ts`) that forwards HTTP into
`Harness.fetch`. The CLI child is spawned asynchronously on purpose: the Worker
lives in the test process, so a blocking spawn would deadlock the loop that has
to answer the child's requests.

`npm run e2e:consumer -- --source tarball` packs `@syndroo/sdk`, `@syndroo/cli`,
and `@syndroo/cloudflare-worker` with `npm pack`, installs the tarballs into a
temporary directory outside this repository, and runs
`e2e/test/consumer.e2e.ts` there with the consumer's own `node_modules`. The
install uses `--ignore-scripts --offline` (falling back to `--prefer-offline`),
an `overrides` entry pins the CLI's SDK dependency at the tarball under test,
and the spec asserts that `import.meta.resolve("@syndroo/sdk")` stays inside the
consumer directory instead of resolving back into this checkout. The Syndroo
packages themselves are never fetched from a registry.

The same entry point with `--source registry --version <v>` only inspects the
published versions: a `404` is reported as `not published`, any other registry
answer fails closed, and an existing version is refused unless
`SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true` is set on an approved host. It
does not install from a real registry by default.

`npm run e2e:web -- --project=chrome` delegates to the website checkout next to
this repository (`--root` or `SYNDROO_WEB_ROOT` override the location). It runs
that repository's own `build`, `check`, and `test` scripts in order and then
Playwright with the named project. A missing checkout, a missing `node_modules`,
or a missing Playwright install is a failure with the command to fix it, never a
silent pass.

`npm run e2e:live -- --plan <absolute path>` is the only entry point that may
contact a real instance, and it is not part of `npm test` or `e2e:local`. It
validates the plan (instance, accounts, content, platforms, an absolute time
with an explicit timezone, an operation count, stop conditions, an approver, and
`"approved": true`) and then stops: a valid plan exits `3` without contacting
anything unless `--execute` is passed. Execution also requires
`SYNDROO_LIVE_CONFIRM` to equal the plan's `planId` and `SYNDROO_API_KEY` in the
environment. `--execute` alone is read-only (`doctor`); only `--write` reaches a
create, and it stops at the first failure instead of minting a new idempotency
key.

## Command

```bash
npm install
npm run test:e2e
```

`test:e2e` runs `npm run build:package` first and then the Node-side Vitest
project:

```bash
npx vitest run --config e2e/vitest.config.ts
```

No credentials are required. The harness injects fake `SYNDROO_API_KEY`,
`THREADS_ACCESS_TOKEN`, `BLUESKY_IDENTIFIER`, and `BLUESKY_PASSWORD` bindings and
binds loopback ports in the test process. It never reads `.dev.vars` and never
uses a real account.

## Bundled Worker requirement

The gate runs `packages/cloudflare-worker/dist/index.js`, the artifact produced
by `npm run build:package`. Before starting Miniflare it refuses to run when the
bundle is:

- missing,
- older than any `packages/*/src` file,
- missing expected production markers such as `https://graph.threads.net`,
- inconsistent with `wrangler.jsonc` (compatibility date, Queue binding, Queue
  name).

The failure message names the command to run. This keeps the gate honest: a
stale or unrelated bundle fails loudly instead of passing.

## Outbound security model

`e2e/src/outbound-policy.ts` replaces the Worker's internet access and is the
only egress path in the tests:

- Allowed requests are exactly these three, with an empty query string:
  `POST https://graph.threads.net/me/threads`,
  `POST https://bsky.social/xrpc/com.atproto.server.createSession`,
  `POST https://bsky.social/xrpc/com.atproto.repo.createRecord`.
- Everything else fails closed with `mock-sns-blocked: <reason>` before any
  socket is opened: unexpected origin, path, method, query, plaintext scheme, or
  unrelated host.
- Allowed requests are forwarded to the literal loopback Mock SNS origin. The
  forward origin must be exactly `http://127.0.0.1:<port>` with no credentials,
  path, query, or fragment, so no configuration can aim the harness at a real
  host.
- The forward hop uses `redirect: "manual"` and a bounded `AbortSignal`, and a
  redirect answer is treated as a policy violation instead of being followed,
  so a hijacked mock cannot bounce the request to a real host. The redirect
  response body is cancelled before the policy fails.
- Only the response status and content type travel back into the Worker; mock
  `location` and `set-cookie` headers are dropped.
- Fake credentials only. `e2e/src/redact.ts` masks every configured secret and
  any `Bearer` token before diagnostics or errors are printed.
- The Miniflare instance sets `cf: false`. Miniflare's `cf: true` (or a string
  cache path) fetches a real `cf` object from a Cloudflare endpoint and caches
  it in `node_modules/.mf`; `false` selects Miniflare's documented placeholder
  object instead, so the harness makes no background network request of its own.
  Miniflare's telemetry option already defaults to disabled in the pinned
  version, so the outbound policy remains the only egress path.

`e2e/test/outbound-policy.spec.ts` proves these properties directly, including
that a redirect target server receives zero requests.

## Coverage

`e2e/test/mock-sns.spec.ts` covers:

- Threads success through HTTP creation, Queue delivery, Mock SNS receipt of the
  exact form body and bearer token, stored `externalId`, and HTTP status query.
- Bluesky through the official SDK plus Threads with independent content
  overrides, where an explicit Threads rejection yields Post status `partial`.
  The Bluesky publication is asserted through the SDK's real success mapping
  (`externalId` from the returned CID and the `externalUrl` built from the
  returned `at://` URI), and link facets are asserted from the recorded
  `createRecord` body.
- HTTP idempotency: the same key and body replay the stored result with HTTP
  `200`, a conflicting body returns `409`, and neither creates a second Post.
- Duplicate Queue delivery: controlled redelivery of a completed job performs no
  second remote write.
- Ambiguous outcome: the Mock SNS records the request and destroys the socket.
  The publication is stored as `failed` with `errorAmbiguous: true`. Exactly one
  remote receipt is required, so an adapter-level duplicate write cannot hide
  behind the ambiguity, and redelivery plus Cron far past the staleness cutoff
  produce no additional receipt.

  A transport failure injected through the harness surfaces inside workerd as an
  opaque HTTP 500, so Syndroo records the conservative ambiguous classification
  (`UNKNOWN` or `PROVIDER_UNAVAILABLE` with `errorAmbiguous: true`) instead of
  claiming a definite rejection. The asserted contract is ambiguity, one remote
  receipt, and no automatic republication.
- Scheduled delivery: Cron one second before the due time publishes nothing;
  Cron exactly at the controlled due time publishes once through the real Queue.
  No test waits 15 real minutes.

Status checks use bounded polling with useful diagnostics (`Mock SNS` receipts,
outbound decisions, and recent Worker logs) and never fixed sleeps.

`e2e/test/sdk-cli.spec.ts` covers the shipped client artifacts through the
loopback proxy:

- The built SDK performs `health`, `create`, `get`, and `wait` over real HTTP
  against the bundled Worker, and one logical post produces exactly one Mock SNS
  receipt.
- An identical `create` with the same idempotency key returns the same post id
  and still produces exactly one remote write.
- The built CLI binary runs `doctor`, `posts validate`, `posts create`, `posts
  list`, `posts get`, `posts wait`, and `skill path` as a real child process;
  `posts validate` creates nothing, and a create without `--yes` and a stable
  `--idempotency-key` exits `2` with zero posts and zero platform calls.

`e2e/test/consumer.e2e.ts` (run only by `npm run e2e:consumer`) repeats the SDK
and CLI paths from an install outside this repository and asserts that the
resolved SDK path stays inside the consumer directory.

## Isolation and cleanup

Every test starts a fresh Miniflare instance with a unique D1 database id, a
fresh loopback Mock SNS server, and a fresh outbound policy. `afterEach` disposes
both through bounded cleanup. Cleanup failures and timeouts fail the gate
instead of being logged and ignored, and a startup failure never disposes a
previous test's instance.

## CI

CI runs `npm run test:e2e` after the existing build and unit test steps, with no
secrets configured. On Node.js 24 it also runs
`npm run e2e:consumer -- --source tarball`, which installs only local tarballs.
The suites fail closed on any outbound attempt outside the allowlist, so no live
SNS traffic is possible from CI.

## Interpreting failures

Failures print the observed post state plus harness diagnostics with redacted
secrets. Common causes:

- `The bundled Worker is stale` or `is missing`: run `npm run build:package`.
- `mock-sns-blocked: unexpected-*`: a publisher tried to reach a new endpoint;
  update the production adapter or extend the documented allowlist deliberately.
- `mock-sns-blocked: redirect-response`: the Mock SNS answered with a redirect.
  The harness refused it by design.
- A timeout showing `pending` publications: the local Queue consumer did not
  deliver; check that `queueConsumers` matches the queue name in
  `wrangler.jsonc`.
