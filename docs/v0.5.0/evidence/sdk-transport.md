# Task T7b1 evidence — operation-aware SDK transport and error boundary

Status: **implemented and verified locally**; attempt 1 of 3. Owner: Task T7b1
(`packages/sdk/src/{http,errors,client,types}.ts`, `src/index.ts` for the public
`SdkOperation` type only, the SDK tests listed in §6, and this file). No auth
facade, CLI, Worker, application, root, manifest, or lockfile file was touched.
This is the transport/error scope only; the auth wire types and thin facade are
the next scope in `sdk-client-boundary.md`.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime, PATH-prefixed for every command below |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
npm run build --workspace @syndroo/sdk   # tsc -p tsconfig.json          -> exit 0
npm run check --workspace @syndroo/sdk   # src --noEmit + test tsconfig  -> exit 0
git diff --check                                                       # exit 0

# from packages/sdk
<bundled-node> ../../node_modules/vitest/vitest.mjs run
# -> 9 files, 187 tests passed, ~1.6s
```

Per-file counts: `client` 12, `abort-timeout` 10, `errors` 15, `redirect` 13,
`response-context` 9, `timeout-validation` 51, `operation-context` 31,
`transport-boundary` 42, `wait-subprocess` 4. The T7a baseline was 114 tests in
7 files, so this scope adds 73 tests in 2 new files plus 1 subprocess fixture.

**Environment requirement:** the pre-existing fixtures bind `127.0.0.1`, which
the sandbox denies (`listen EPERM`), so those numbers come from a
loopback-permitting run. `operation-context`, `timeout-validation`,
`response-context` and the two subprocess files start no listener and also pass
sandboxed.

## 2. Operation context

`SdkOperation` (`errors.ts`) is a closed union of the 13 documented operations:
`health`, `posts.create`, `posts.get`, `posts.list`, `posts.wait`, `auth.status`,
`auth.set`, `auth.connect`, `auth.operation`, `auth.complete`, `auth.refresh`,
`auth.remove`, `diagnostics`. `isWriteOperation` fixes which of them can have
changed server state; everything else always reports
`requestMayHaveBeenApplied: false`. `index.ts` re-exports only the type.

Every SDK-generated error carries the operation: the transport stamps it on
transport, API, parse and size-limit errors; the client stamps it on validation,
config, abort and wait-timeout errors; `ParseContext.operation` carries it into
the response readers. `posts.wait` reuses one internal `#readPost` so its reads
report `posts.wait`, not `posts.get`. Nothing caller-supplied enters the field —
no platform, post id, operation id, or URL.

Recovery text follows the operation, asserted in `operation-context.test.ts`:
`posts.create` uncertainty names the same Idempotency-Key and `posts.get`;
`auth.*` uncertainty names `auth.status` (and `auth.operation` for connect and
complete) and never a post key; `auth.refresh` says the exchange is never
repeated automatically; `auth.complete` says a completed operation may be
replayed explicitly and that the SDK never does it; reads say they were reads.

## 3. Safe diagnostics

No SDK-generated error retains a raw fetch exception, abort reason, server
message body, invalid-JSON preview, secret-bearing URL, or raw response value in
`message`, `cause`, `preview`, enumerable fields, or stack text. `preview`
remains a public optional property for compatibility and is never filled from an
untrusted body. Validation reports field names and expected types only:
`describe()` returns shape words (`null`, `an array`, `a string`, …), override
keys from either direction are replaced by fixed labels, `baseUrl` messages no
longer repeat the rejected URL or scheme, and the wait message maps an
unrecognized status to "not one this SDK recognizes" while `lastStatus` and
`lastPost` keep the documented resource snapshot unchanged.

Codes come from closed allowlists:

| List | Entries |
| --- | --- |
| Server codes | `INVALID_REQUEST`, `INVALID_JSON`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `NOT_FOUND`, `UNAUTHORIZED`, `AUTH_CONFLICT`, `AUTH_IN_PROGRESS`, `POST_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `INVALID_CONTENT`, `RATE_LIMITED`, `RATE_LIMIT`, `PLATFORM_NOT_CONFIGURED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`, `INSTANCE_NOT_READY`, `STORE_UNAVAILABLE`, `AUTH`, `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`, `NETWORK`, `UNKNOWN` |
| SDK-generated | `REDIRECT_NOT_FOLLOWED` |
| Network codes | `ECONNREFUSED`, `ECONNRESET`, `ECONNABORTED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`, `EPIPE`, `EADDRNOTAVAIL`, `ABORT_ERR`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`, `UND_ERR_ABORTED`, `UND_ERR_CLOSED`, `UND_ERR_DESTROYED`, `UND_ERR_RESPONSE_STATUS_CODE`, `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED` |

Sources: README error table, `packages/cloudflare-worker/src/{http,api,auth}.ts`
`ApiError` codes, the SDK's public publication codes, and the 0.5.0 auth/storage
codes in `public-api.md` / `packages/application/src/use-cases/auth-errors.ts`
(`PROVIDER_ERROR` added on root's instruction as a public OAuth code). An
unrecognized or lower-case code becomes `HTTP_<status>`; a non-allowlisted
runtime code is dropped rather than repeated.

**Provenance.** `instanceof` is not proof that an error is ours: the classes are
public, so an injected fetch, body, or abort signal can hand back an object of
the same class — including one the SDK built earlier and the caller then
mutated. Each call creates its own `ErrorSink` (`createErrorSink`) and marks only
the errors it constructs; the transport's catch boundary and `wait`'s
`toSyndrooError` accept an error only when `errors.has(...)` is true. The sink
never escapes the call, so no external object can be in it.

## 4. Bounded requests

One transport serves GET, POST, and DELETE (`auth.remove` uses DELETE in the
tests). Duration validation uses the shared positive-finite
`<= 2_147_483_647ms` rule and is checked in the transport where the timer is
created, before any fetch or timer exists.

The deadline is a race, not a hope: `Promise.race([work, deadline, aborted])`
settles the SDK call at its budget even when an injected or hostile fetch
ignores `AbortSignal`. A response that arrives after the deadline or a caller
abort is disposed without a single read. A refused redirect aborts the
transport, disposes the body, and reports `REDIRECT_NOT_FOLLOWED` with
`requestMayHaveBeenApplied: false`; `redirect: "manual"` is asserted, so the
Authorization header can never reach another origin.

`readBody` reads through the same deadline: each read races a local stop that
the deadline or abort resolves, so the loop always reaches `finally` even if the
reader and its `cancel()` both hang. Every abandoned read gets a non-blocking
`cancel()` (never awaited) plus a best-effort `releaseLock()` on every path; a
raw read rejection cancels before it is classified; the size limit cancels
before it throws. Chunks are copied with `slice()` before the next read, so a
reader that reuses one buffer cannot corrupt the body. No write is retried, and
every outcome test asserts exactly one fetch call.

## 5. Red/green proofs

| Property | Red | Green |
| --- | --- | --- |
| Poll timer holds a standalone process open (T7a, `client.ts`) | exit 13, "unsettled top-level await", no marker | marker, exit 0 |
| `parsePostReceipt` forwards `ParseContext` (T7a, `types.ts`) | 6 shapes fail `expected undefined to be 202` | 9/9 pass |
| Per-request error marking (`http.ts`) | reverting to `error instanceof SyndrooError` forwards a mutated earlier SDK error: `expected SyndrooApiError: mutated SENTINEL… not to be SyndrooApiError: mutated SENTINEL…` | reclassified as a fresh network error, no sentinel |
| Deadline keeps a standalone process alive (`transport-child.ts`) | an unref'd deadline would exit 13 before the marker | marker with `code: TIMEOUT`, exit 0, ~0.25-0.75s |

The reverts were temporary, in sole-owned files, and were restored before the
final run; `git diff` confirms the final state.

## 6. Changed files

| File | Change |
| --- | --- |
| `packages/sdk/src/errors.ts` | `SdkOperation`, `isWriteOperation`, closed code allowlists, `publicErrorCode`/`publicNetworkCode`, `safeProperty`, per-call `ErrorSink`/`createErrorSink`, `operation` on every error class, optional `init` on config/validation errors |
| `packages/sdk/src/http.ts` | operation-required `TransportRequest` with DELETE, deadline race, late-response and redirect disposal with transport abort, hardened `readBody` (stop race, non-blocking cancel, best-effort release, chunk copies), safe messages with per-operation advice, allowlisted codes, no raw cause/preview, URL/Headers/serialization guards, no deadline unref |
| `packages/sdk/src/types.ts` | `ParseContext.operation`/`errors`, shape-only `describe`, `terminalReason`, fixed override labels |
| `packages/sdk/src/client.ts` | operation on every call, shared `#readPost`, operation-aware validators, per-call sinks, sanitized `toSyndrooError`, shape-only baseUrl/override/status messages |
| `packages/sdk/src/index.ts` | exports `type SdkOperation` only |
| `packages/sdk/test/operation-context.test.ts` | new — 31 operation/advice/context cases |
| `packages/sdk/test/transport-boundary.test.ts` | new — 42 boundary, allowlist and sentinel cases |
| `packages/sdk/test/support/transport-child.ts` | new — standalone hanging fetch/body deadline proof |
| `packages/sdk/test/errors.test.ts` | assertions updated for the intentional safe-message change (fixed text, `preview` undefined); semantic coverage kept |
| `packages/sdk/test/response-context.test.ts` | shape-only message details |
| `packages/sdk/test/wait-subprocess.test.ts` | runtime is now `process.execPath` or `SYNDROO_SDK_TEST_NODE`; the hardcoded bundled path is gone |
| `docs/v0.5.0/evidence/sdk-transport.md` | this file |

## 7. Unresolved and limits

* **No auth facade.** `auth.*` operations are exercised through the internal
  transport only; the public auth methods, their wire types, and the
  installed-artifact evidence are the next scope.
* **Node 22 is unavailable locally** (baseline §1), so runtime support is
  reported from the Node 24 run only, never claimed for 22.
* **Client-side input getters.** A caller object whose own getter throws during
  argument validation still surfaces that caller's error; the guarded paths are
  header construction, URL building, and body serialization, which are the ones
  that can echo configuration or content.
* **`lastStatus`/`lastPost` keep raw server values by design** as documented
  public snapshot properties; only the message text is mapped to a fixed label.
* **The server-code allowlist is deliberately conservative.** A documented code
  missing from §3 degrades to `HTTP_<status>`; extending it is a one-line
  addition to `PUBLIC_SERVER_CODES`.
* **Sandbox.** Loopback is denied without escalation, so suite numbers come from
  a loopback-permitting run.
* **No full 0.5.0 gate claim.** `docs/v0.5.0/acceptance-results.json` is
  unchanged; this file records the transport/error scope only.
