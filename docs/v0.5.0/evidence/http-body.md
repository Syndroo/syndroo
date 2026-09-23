# Task T6d2 evidence — bounded inbound HTTP body reader

Status: **the scoped implementation is complete for this attempt (attempt 1 of
3); its dedicated native suite and scoped type check pass locally.** Owner:
Task T6d2. No broad 0.5.0 acceptance is claimed:
`docs/v0.5.0/acceptance-results.json` is unchanged, and routing, response
headers, auth boundaries and the legacy mutation routes remain other owners'
scopes.

Files in scope (no other file was touched):

- `packages/cloudflare-worker/src/http.ts` (modified in place, 509 lines)
- `packages/cloudflare-worker/test/http-body-v050.native.ts` (new, 694 lines, 29 tests)
- `packages/cloudflare-worker/test/http-body-v050.vitest.config.ts` (new, 41 lines)
- `packages/cloudflare-worker/test/support/http-body-v050-worker.ts` (new, 11 lines)
- `packages/cloudflare-worker/test/support/http-body-v050-tsconfig.json` (new, 15 lines)
- this file

No dependency, manifest, migration, frozen port/contract, adapter, legacy route,
main vitest config or `Env` file was modified. `json()` and `requireBearer()` are
unchanged, and `readJsonBody(request)` keeps its existing call signature, so
`src/api.ts` and `src/auth.ts` compile without edits.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Node | `v24.19.0` — bundled runtime `/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` (prepended to `PATH`) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
# from the repository root, bundled Node 24 first on PATH
node_modules/.bin/tsc -p packages/cloudflare-worker/test/support/http-body-v050-tsconfig.json --noEmit
# -> exit 0, zero diagnostics. `--listFiles` shows the program is exactly
#    src/http.ts, test/support/http-body-v050-worker.ts,
#    test/http-body-v050.native.ts and test/http-body-v050.vitest.config.ts.
#    `src/http.ts` imports nothing, so the real closure is that module itself.

# dedicated native project: the only configuration with a fail-closed outbound
# service, run behind a hard 180 s external kill guard
cd packages/cloudflare-worker
../../node_modules/.bin/vitest run --config test/http-body-v050.vitest.config.ts
# -> 1 test file, 29 tests, all passed, exit 0 (wall clock ~0.7 s; the guard was
#    never needed and no workerd process was left behind)

# worker source, unchanged baseline
node_modules/.bin/tsc -p packages/cloudflare-worker/tsconfig.json --noEmit
# -> exactly the two pre-existing errors in src/platform-descriptors.ts
#    (lines 308/309, LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not in Env).
#    src/http.ts reports no diagnostic.
```

## 2. Contract

| Situation | Result |
| --- | --- |
| `readJsonBody` with no body stream | 400 `INVALID_JSON` "Request body is required" |
| `readJsonBody` with a zero-byte body | 400 `INVALID_JSON` "Request body contains invalid JSON" |
| `readOptionalJsonBody` with no body or a zero-byte body | `undefined` |
| `readOptionalJsonBody` with the document `null` | `null` (distinct from `undefined`) |
| Nonempty body whose media type is not exactly `application/json` | 415 `UNSUPPORTED_MEDIA_TYPE` |
| Zero-byte body with any media type | allowed by the optional reader; nothing is decoded |
| Body over 64 KiB, by received bytes or by declared `content-length` | 413 `BODY_TOO_LARGE` |
| Malformed UTF-8 or malformed JSON | 400 `INVALID_JSON` "Request body contains invalid JSON" |
| Deadline exceeded, request cancelled, stream failure, locked or consumed body | 400 `INVALID_REQUEST` with one of three fixed messages |

Media type: the type is compared case-insensitively against exactly
`application/json`, with parameters allowed after `;`, so `application/jsonp`,
`application/json-seq` and `application/json-patch+json` are rejected instead of
being accepted by the previous `startsWith` comparison.

Options: `readJsonBody` and `readOptionalJsonBody` accept
`{ maxBytes?, deadlineMs? }`. Both are downward-only overrides of the fixed
production values (64 KiB, 15 s); anything above, zero, negative or
non-integer throws a `RangeError`, which is a wiring defect and never reaches an
HTTP caller.

The helper starts no mutation, opens no storage and makes no outbound request:
it only consumes the inbound body and returns a decoded value or a fixed error.

## 3. Bounded, cancellation-safe reading

- One total deadline per read (15 s default) plus the request's own
  `AbortSignal`. The deadline is enforced by the timer, by an elapsed-time check
  on every iteration, and by a periodic macrotask hop every 64 read iterations,
  so a stream that is always ready cannot starve it.
- The stop state is read directly and re-checked **after** the awaited read, so a
  cancellation or deadline that lands inside the final read can never become a
  success — not even when the last chunk and the close arrive in the same step.
- A pre-aborted request fails before any body handling, including when its
  stream already holds ready bytes.
- Every chunk is size-checked **before** it is copied, empty chunks are not
  stored, and each stored chunk is copied before the next await, so a reused
  runtime buffer cannot corrupt the result.
- Strict UTF-8 (`fatal: true`) decoding of the joined bytes, then `JSON.parse`;
  both failures share one fixed message.
- Cleanup is non-blocking: `cancel()` is never awaited, both settlement paths are
  observed so a late rejection cannot become an unhandled rejection, and the
  lock is released as soon as the runtime allows it. An early 413/415
  best-effort cancels an unread body without waiting.
- A `getReader()` failure and a `bodyUsed` body both become a fixed 400; a
  consumed body is never reported as an absent legacy payload, and a body the
  caller owns is neither cancelled nor released.

## 4. Review points applied

| Review point | Fix |
| --- | --- |
| A pre-aborted signal could lose `Promise.race` to an already-ready read | Explicit abort check before any body handling, plus a directly-read stop state before each read |
| No-body optional path returned before checking cancellation | Cancellation is decided first, so a pre-aborted empty or missing body is a 400, not `undefined` |
| `getReader()` outside a guarded try leaked a raw `TypeError` | Wrapped into the fixed 400 `INVALID_REQUEST` |
| A stream rejection carrying an `ApiError` was rethrown as trusted | The awaited read's rejection is never inspected; local `ApiError`s are only thrown outside that try/catch |
| `Uint8Array.from` before the size proof | `byteLength` is compared with the remaining budget first, and empty chunks are skipped |
| Early declared-oversize/media failure left the body unread | Best-effort non-blocking `cancel()` when a body exists |
| Deadline could be starved by an always-ready stream | Elapsed-time check plus a 64-iteration macrotask hop |
| A stop that landed inside the final read could still succeed | Stop state re-checked after the awaited read, before accepting `done` or bytes |
| Yield cadence keyed on stored chunks stalled after one nonempty chunk | Cadence counts read iterations instead |
| A consumed (`bodyUsed`) body looked like a genuine empty legacy body | Explicit `bodyUsed` guard returning the fixed 400 without touching the caller's stream |

## 5. Native coverage (29 tests, one file)

| Area | Cases |
| --- | --- |
| Presence | `readJsonBody` missing vs zero-byte body; optional `undefined` vs parsed `null` vs `0` vs object; zero-byte body with a non-JSON media type; malformed nonempty optional body; consumed (`bodyUsed`) body for both readers |
| Media type | accepted `application/json` / `APPLICATION/JSON` / with parameters; rejected `application/jsonp`, `application/json-seq`, `application/json-patch+json`, `text/json`, `text/plain`, `multipart/form-data`, and a missing header |
| Size | exactly 64 KiB in one chunk and in two; 65 537 bytes in one chunk and in two; an oversized single chunk before copying, with the lock released; a declared `content-length` of 99 999 999 that is never read (`pull` count 0) and whose hung `cancel()` does not delay the 413; an oversized still-open stream whose `cancel()` hangs; a rejecting `cancel()`; options accepted at the boundary and refused above it |
| Deadline | held-open read; slow trickle (one chunk per 25 ms) under one total deadline; always-ready empty chunks; one nonempty chunk followed by endless empty chunks — each with an external watchdog and a bounded producer |
| Cancellation | pre-aborted ready / empty / missing body for both readers; a non-cancelled control case that still parses; cancellation mid-read; cancellation in the same step as the final chunk and close |
| Bytes | reused buffer whose second pull overwrites the first chunk; split chunks including split multi-byte characters; byte-by-byte chunks |
| Failures | malformed UTF-8 (including an invalid byte inside otherwise valid JSON, which the previous decoder silently accepted), malformed JSON, stream error, forged `ApiError` from the stream, already-locked body — all fixed, sentinel-free |
| Isolation | the project's outbound service answers a stray fetch with 500 |

`expectApiError` additionally asserts on every failure that the serialized error
contains neither the body sentinel nor the cause sentinel.

## 6. Limitations

- Response `no-store` headers, API authentication, route mapping and the legacy
  delete/refresh routes are router acceptance and are **not** claimed here; this
  task only proves the isolated reader.
- No live endpoint, credential or provider was contacted. The only outbound
  path is the project's fail-closed service, asserted by a test.
- The package's main vitest config is not acceptance for this task and was not
  run; the file is named `*.native.ts`, which the installed vitest default
  include (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) does not match, so general
  discovery cannot collect it without the dedicated configuration.
- The macrotask yield also runs on ordinary bodies that cross64read iterations.
  Its steady-state effect under production load is unmeasured; no zero-cost
  claim is established.
- `test/support/bounded-run.ts` was not used or repaired (its known diagnostic
  hangs belong to T9).

Root acceptance note: Node24 scoped source/test/config check passed; dedicated
native run at2026-09-23 07:26:38 passed29tests, exit0, under a separate60second
host process-group guard that was not needed. The test's withWatchdog helper
is an in-workerd timer, not an external watchdog; bounded producers and the
host guard provide the additional safeguards. Error-message assertions and
source review supplement JSON.stringify(Error), which omits nonenumerable
fields. See [root review](root-review.md) for the exact evidence and limits.
