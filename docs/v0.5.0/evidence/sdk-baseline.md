# Task T7a evidence — SDK baseline repairs (SDK-01, SDK-03/SDK-04)

Status: **the two assigned regressions are fixed and verified locally**, plus the
root-extended SDK-04 timer bound. Attempt 1 of 3. Owner: Task T7a
(`packages/sdk/src/{types,client,http}.ts`, the four `packages/sdk/test/**` files
listed below, and this file only). No auth, CLI, Worker, application, root,
manifest, or lockfile file was touched. No full 0.5.0 gate is claimed:
`docs/v0.5.0/acceptance-results.json` is unchanged.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f2` |
| Node | `v24.19.0` — bundled runtime `/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` (PATH-prefixed for every command below) |
| npm | `11.19.0` (Homebrew; the bundled runtime ships no npm) |
| TypeScript / Vitest | `7.0.2` / `4.1.11` |

```bash
# from the repository root, with the bundled Node 24 first on PATH
npm run build --workspace @syndroo/sdk   # tsc -p tsconfig.json            -> exit 0
npm run check --workspace @syndroo/sdk   # src --noEmit + test tsconfig    -> exit 0
git diff --check                         # exit 0 (no whitespace errors)

# from packages/sdk
<bundled-node> ../../node_modules/vitest/vitest.mjs run --reporter=verbose
# -> 7 files, 114 tests passed, ~1.1s (baseline was 50 tests in 6 files)
```

**Environment requirement:** the pre-existing SDK fixtures bind `127.0.0.1`
servers. Inside this session's sandbox that fails immediately
(`listen EPERM 127.0.0.1`, 42 tests failed in ~1s); every number below is from a
loopback-permitting (escalated) run. The three new files
(`response-context`, `timeout-validation`, `wait-subprocess`) start no listener
and pass sandboxed — verified with the bundled Node 24: 3 files, 64 tests
passed, no escalation.

## 2. Defect 1 — malformed 2xx lost the transport context (SDK-01)

`packages/sdk/src/types.ts:143` — `parsePostReceipt` called
`requireRecord(value, "the create response")` and let the helper default to an
empty `ParseContext`. Every malformed HTTP `202` success that failed at that
first record check (null, array, string, number, boolean, empty body) therefore
threw a `SyndrooResponseError` with `status: undefined` and
`requestMayHaveBeenApplied: false`, which reads as "the write never landed".

Fix: forward the caller's context (`requireRecord(value, "the create response",
context)`). All other readers in the file already forwarded it; rechecked every
`requireRecord`/`requireString`/`requireArray` call site (lines 159, 179, 193,
200, 209, 241, 245) and none was missing context.

New test `packages/sdk/test/response-context.test.ts` (9 cases) stubs
`globalThis.fetch` and asserts, per shape, `SyndrooResponseError` +
`code: "INVALID_RESPONSE"` + the real `status: 202` +
`requestMayHaveBeenApplied: true` + the shape-specific message + exactly one
recorded `POST /v1/posts` (no retry):

| Shape | Message detail asserted |
| --- | --- |
| `null` body | `received null` |
| `[]` body | `received an array of 0 item(s)` |
| `"queued"` body | `received string (queued)` |
| `42` body | `received number (42)` |
| `true` body | `received boolean (true)` |
| empty body | `received undefined` |
| missing `id` | `create response id must be a string` |
| non-string `status` | `create response status must be a string` |
| read (`GET /v1/posts/post_1`) with `null` | `status: 200`, `requestMayHaveBeenApplied: false`, one `GET` |

**Red proof.** The one-line fix was reverted in the sole-owned file, the test
re-run, and the fix restored (final `git diff` shows only the fix):

```
× reports HTTP 202 with a JSON null body ...   → expected undefined to be 202
× ... array body                               → expected undefined to be 202
× ... string body / number body / boolean body → expected undefined to be 202
× ... an empty body                            → expected undefined to be 202
Test Files  1 failed (1)   Tests  6 failed | 3 passed (9)
```

The three that passed in the red state are the two shapes that already
forwarded context (missing `id`, non-string `status`) and the read case.

## 3. Defect 2 — `posts.wait` did not hold a standalone process open (SDK-03/04)

`packages/sdk/src/client.ts` `sleep()` called `unrefTimer(handle)` on the poll
timer. With nothing else referencing the event loop, a standalone Node process
exited during the first pause: exit code 13 (`Detected unsettled top-level
await`) with the wait still pending.

Fix: removed the `unrefTimer(handle)` call and the now-unused `unrefTimer`
import from `client.ts`. Timer and listener cleanup is unchanged (`finish()`
still clears the timeout and removes the abort listener on resolve and on
abort). `unrefTimer` remains in `http.ts` for the per-request deadline timer,
which is deliberately unreferenced.

**Red/green probe** (bundled Node 24, script in `/tmp`, `globalThis.fetch`
stubbed to return `queued, queued, published`):

```
before: Warning: Detected unsettled top-level await ...   exit=13   (no marker)
after:  MARKER_OK {"calls":3,"status":"published"}        exit=0
```

New tests: `packages/sdk/test/wait-subprocess.test.ts` +
`packages/sdk/test/support/wait-child.ts`. The child is a real Node process
(bundled Node 24 by default, `SYNDROO_SDK_TEST_NODE` overrides, `process.execPath`
falls back) that loads `src/index.ts` directly — a `module.registerHooks`
resolver maps the SDK's NodeNext `./x.js` specifiers to the sibling `.ts`
sources, because Node 24 does not substitute `.js` → `.ts` on its own (probed).
`fetch` is stubbed with immediate `Response` fixtures, so no server, socket, or
live instance is involved. A parent watchdog (8s, SIGKILL) fails the test
instead of hanging the suite, and a child that exits without the marker fails
rather than skipping:

| Mode | Asserts |
| --- | --- |
| `resolve` | two waits settle (`published`), ≥4 reads, natural exit 0, no `POST` |
| `deadline` | `SyndrooWaitTimeoutError` / `WAIT_TIMEOUT`, `requestMayHaveBeenApplied: false`, ≥2 reads, natural exit |
| `abort` | `SyndrooAbortError` / `ABORTED`, `requestMayHaveBeenApplied: false`, natural exit, no lingering handle |
| `max-timer` | largest Node deadline accepted, timer cleared, no warning, natural exit (see §4) |

Each marker also carries Node's warning list, and every mode asserts it is
empty. The CLI's own keep-alive (`packages/cli/src/main.ts:44` comment, `:50`
`setInterval`, cleared at `:120`) is untouched.

## 4. Root-extended — SDK-04 timeout overflow bound

Node's timers take a signed 32-bit delay and do not fail above it. Probe on the
bundled Node 24:

```
setTimeout(fn, 2_147_483_647)  -> silent
setTimeout(fn, 2_147_483_648)  -> TimeoutOverflowWarning: 2147483648 does not fit
                                  into a 32-bit signed integer.
                                  Timeout duration was set to 1.
```

Before this change `new SyndrooClient({ timeoutMs: Number.MAX_SAFE_INTEGER })`
was accepted, and a request then created a clamped 1ms deadline (probe emitted
the warning above). After the change the same call throws
`SyndrooConfigError` (`code: "CONFIG"`, `requestMayHaveBeenApplied: false`)
before any fetch or timer exists.

Implementation (one shared internal validator, no framework):

* `packages/sdk/src/http.ts` — `MAX_TIMEOUT_MS = 2_147_483_647` and
  `durationError(value, label)`, which returns the message to raise for a
  non-finite, non-positive, or above-bound duration and `undefined` otherwise.
  Fractional values are kept as given.
* `packages/sdk/src/client.ts` — `validatePositiveDuration` now delegates to
  `durationError` and keeps throwing `SyndrooConfigError`, the pre-existing
  class for duration problems; `health`, `posts.create`, `posts.get`, and
  `posts.list` check a per-call `timeoutMs` through `validateRequestDuration`
  before `sendRequest`; `posts.wait` already validated all four of its duration
  options through the same function, so it inherits the bound.

New test `packages/sdk/test/timeout-validation.test.ts` (51 cases): six invalid
values (`0`, `-1`, `NaN`, `Infinity`, `Number.MAX_SAFE_INTEGER`,
`2_147_483_648`) × two constructor options (`timeoutMs`, `waitTimeoutMs`) and ×
seven per-call shapes (`health`/`create`/`get`/`list` `timeoutMs`, `wait`
`timeoutMs`/`pollIntervalMs`/`maxPollIntervalMs`) — each a `SyndrooConfigError`
with `requestMayHaveBeenApplied: false` and **zero** recorded fetches. The
boundary value is accepted for a request and for a wait budget/poll interval,
and the boundary request asserts no `TimeoutOverflowWarning` reached the
process. `wait-subprocess.test.ts` adds the real-timer proof: the child creates
a timer at exactly the bound against an immediate response and exits on its own
in under 100ms; an uncleared timer would have kept it alive for 24 days and been
killed by the watchdog.

## 5. Changed files

| File | Change |
| --- | --- |
| `packages/sdk/src/types.ts` | `parsePostReceipt` forwards `ParseContext` (1 line) |
| `packages/sdk/src/client.ts` | poll timer no longer unref'd; per-call duration checks; `validatePositiveDuration` delegates to the shared bound |
| `packages/sdk/src/http.ts` | `MAX_TIMEOUT_MS`, `durationError` |
| `packages/sdk/test/response-context.test.ts` | new — 9 malformed-success cases |
| `packages/sdk/test/timeout-validation.test.ts` | new — 51 duration-bound cases |
| `packages/sdk/test/wait-subprocess.test.ts` | new — 4 standalone-process cases |
| `packages/sdk/test/support/wait-child.ts` | new — the child harness |
| `docs/v0.5.0/evidence/sdk-baseline.md` | this file |

## 6. Unresolved and limits

* **CLI keep-alive.** `packages/cli/src/main.ts:50` still adds its own
  `setInterval` (its `:44` comment still describes the removed SDK behaviour).
  Removing it is CLI-04 and belongs to root; the CLI suite was not run here.
* **A wait holds the loop between reads, not during a request.** The
  per-request deadline timer stays unref'd by design (`http.ts`), so while a
  request is in flight the loop is held by the request's socket, as with any
  real `fetch`.
* **SDK auth / `operation` context.** Not implemented in this tree and out of
  scope here, so SDK-01/SDK-02/SDK-05 acceptance for auth writes is untouched.
* **Node 22 leg** is still unobtainable locally (baseline §1).
* **Test runtime default.** `test/wait-subprocess.test.ts` prefers the bundled
  Node 24 path when it exists and falls back to the runtime executing the
  suite; `SYNDROO_SDK_TEST_NODE` overrides both. The absolute default is an
  artifact of this environment and may need a decision before release.
* **Sandbox.** Loopback is denied without escalation, so the reported suite
  results come from a loopback-permitting run; the sandboxed failure mode is
  `listen EPERM`, not a product failure.
* **No full 0.5.0 gate claim.** `docs/v0.5.0/acceptance-results.json` is
  unchanged; this file only records the SDK repairs above.
