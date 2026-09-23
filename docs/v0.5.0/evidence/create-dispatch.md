# Task 5a evidence — portable create and shared dispatcher

Status: **T5a attempt 2 complete for review** (attempt 1 was accepted apart from
the clock-ordering mismatch below). Owner: T5a scope
(`packages/application/src/use-cases/**`, two named test files and this file
only). No product acceptance ID is claimed here: `docs/v0.5.0/acceptance-results.json`
stays `NOT_RUN`, because this task produces portable application use cases
proven against the rollback-capable fake, not D1/Queue/Worker behaviour.

## 1. Tree, runtime, commands

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Package | `packages/application` (`@syndroo/application`, private) |
| Runtime | Node `v24.19.0` (bundled `codex-primary-runtime`), npm `11.19.0`, Vitest `4.1.11` |
| Dependency | `@syndroo/core` `0.1.0` only; no new dependency, no config/manifest edit |
| Fake | `src/testing/snapshot-fake.ts` via `createSnapshotFake` (unchanged) |

```bash
npm run check -w @syndroo/application   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json -> exit 0
npm run build -w @syndroo/application   # tsc -p tsconfig.json                                        -> exit 0
npm run test  -w @syndroo/application   # build && vitest run                                         -> 11 files, 99 tests passed
```

The pre-existing suite is unchanged and still green (9 files, 65 tests). The two
new files add 34 tests: `test/create-post.test.ts` 20, `test/dispatch-ready-jobs.test.ts`
14.

Changed files (exact allowed set):

```text
packages/application/src/use-cases/shared.ts               (new)
packages/application/src/use-cases/create-post.ts          (new)
packages/application/src/use-cases/dispatch-ready-jobs.ts  (new)
packages/application/test/create-post.test.ts              (new)
packages/application/test/dispatch-ready-jobs.test.ts      (new)
docs/v0.5.0/evidence/create-dispatch.md                    (new, this file)
```

`src/index.ts`, frozen contracts/ports/testing, Worker, providers and every
config/manifest are untouched. Both new modules are reachable by relative
import; the export line in `src/index.ts` is deliberately left to root
integration.

## 2. What was implemented

`shared.ts` — fixed, map-ready failure surface and injected wiring:

- `PublishingUseCaseError` with closed codes `INVALID_REQUEST`,
  `IDEMPOTENCY_CONFLICT`, `PUBLISHER_PREPARATION_BLOCKED`, `INSTANCE_NOT_READY`,
  `CREATE_CONFLICT` and an allowlisted `reason` enum (request field label,
  publisher block reason, create conflict reason, or `unavailable`). Messages
  come from a static table; no caller or provider value is interpolated.
- `UseCaseClock` / `UseCaseIdFactory`, `readClockNow`, `createUseCaseId`.
- `snapshotCreateInput` — deep copy plus structural validation (content,
  platforms, overrides, canonical `scheduledAt`), run before any `await`;
  `snapshotIdempotencyKey` — the existing public key alphabet.

`create-post.ts` — one accepted request, in this order:

1. Snapshot the caller's intent; the fingerprint is derived from the copy, so a
   caller mutating its own object while the use case is suspended cannot change
   the committed content or the identity used for replay comparison.
2. Reject structurally invalid input and a malformed key before any store read.
3. Answer an existing idempotency record before preparation, signing or any
   readiness check, and return it with an empty dispatch report — a replay
   needs no queue, dispatcher, clock or configuration at all.
4. Prepare each platform, then sign the connection binding, before the write;
   generate post/publication/job identities once.
5. Commit Post + Publications + initial outbox jobs + guards atomically through
   `createPostWithDispatch`; a guard conflict becomes a safe `CREATE_CONFLICT`
   with zero sends and no silent re-prepare.
6. Run the shared dispatcher as an optional fast path for immediate work only.
   A future-scheduled create skips it (`enqueueDeferred: false`), a replay skips
   it, and a fast-path failure is reported as deferred instead of rolling back
   or altering the accepted result.

`dispatch-ready-jobs.ts` — one shared function for the fast path and every later
wake: `listReady` bounded by `min(requested, 20)`; exactly one `envelopeForJob`
send per job per wake; a `JobQueueError` with `certainty: "failed"` records
`SEND_FAILED`, `certainty: "unknown"` and any other thrown value record
`SEND_UNKNOWN`; a successful send is marked with the observed
`dispatchRevision`, and a mark that conflicts or throws is counted
`markFailed` without a second send in the same invocation. The optional
`shouldContinue` predicate is consulted only before starting a new send, so an
accepted send is never described as aborted. Logging is best effort and carries
only fixed codes plus internal identifiers.

## 3. Failure-first evidence for this round

Written in the order root raised them; every item was red before it was green.

1. **Type red run** — immediately after the first implementation the test
   config failed on three real defects:

   ```text
   src/use-cases/create-post.ts(160,14): error TS2339: Property 'push' does not exist on type 'readonly PreparedEntry[]'.
   src/use-cases/dispatch-ready-jobs.ts(166,24): error TS2339: Property 'reason' does not exist on type '{ kind: "already_applied" } | { kind: "conflict"; reason: CommitConflictReason }'.
   test/create-post.test.ts(459,34): error TS2339: Property 'scheduledAt' does not exist on type 'PublicationSnapshot'.
   ```

2. **Behaviour red run** — the scheduler/override test failed with
   `PublishingUseCaseError: the create request conflicted with current credential state`
   (`test/create-post.test.ts:441`) because each dependency factory restarted the
   identity counter and collided with rows already committed. Fixed with one
   identity stream per fake store; the collision itself stays a safe conflict.

3. **Review red run — instance vs platform failure.** With the pre-review
   mapping (signer failure reported as `PUBLISHER_PREPARATION_BLOCKED`):

   ```text
   FAIL test/create-post.test.ts > ... never trusts an injected error class, even a subclass carrying a sentinel
   AssertionError: expected 'PUBLISHER_PREPARATION_BLOCKED' to be 'INSTANCE_NOT_READY'
   Expected: "INSTANCE_NOT_READY"   Received: "PUBLISHER_PREPARATION_BLOCKED"
   ```

4. **Review red run — fast-path confirmation.** With the unconfirmed-created-job
   check temporarily removed from the deferred decision:

   ```text
   FAIL test/create-post.test.ts > ... reports deferred when an older backlog consumes the fast-path budget
   AssertionError: expected false to be true
   ```

   Restoring the check returns the suite to green; the backlog fixture is the
   regression test.

5. **Attempt 2 red run — replay must not read the clock.** Attempt 1 still
   called `readClockNow` before the early record lookup, so a replay depended on
   clock wiring even though the code and this file claimed otherwise. With the
   hostile clock in place and the ordering unchanged:

   ```text
   FAIL test/create-post.test.ts > ... replays an accepted request before prepare, signing or readiness
   Error: the clock must not be read on replay
    ❯ Object.now test/create-post.test.ts:298:17
    ❯ readClockNow src/use-cases/shared.ts:92:23
    ❯ createPost src/use-cases/create-post.ts:125:15
   ```

   `readClockNow` now runs after the early existing-record return and before new
   planning; the same test passes with a clock that throws on every call, and the
   new clock test proves a new create still consumes a valid clock.

## 4. Acceptance coverage

| Required behaviour | Test |
| --- | --- |
| Replay before throwing `prepare`/signer/clock/queue/outbox, invalid dispatch budget | `createPost idempotency > replays an accepted request before prepare, signing or readiness` |
| New create uses the injected clock; a non-canonical clock fails before any write | `createPost idempotency > uses the injected clock for a new create and rejects a non-canonical one` |
| Different request under the same key -> `IDEMPOTENCY_CONFLICT` | `... compares requests canonically and rejects a different request under the same key` |
| Reversed platform order replays; no key creates new posts | `... replays a platform-order-insensitive request and creates without a key` |
| Concurrent store replay uses the same comparison | `... applies the same comparison when a concurrent create commits first` |
| Snapshot before the first awaited fingerprint | `... snapshots the caller's intent before the first awaited fingerprint`, `... snapshots overrides so a strategy cannot rewrite committed content` |
| Due/future scheduling, availability and override contents | `createPost guards, scheduling and preparation > preserves schedule intent and per-platform override content` |
| Prepared provider/revision/slot binding/HMAC recorded | `... records the prepared provider, revision, slot binding and HMAC` |
| Slot guard conflict = safe conflict, zero sends | `... treats a slot guard conflict as a safe conflict with zero sends` |
| Blocked preparation fails closed, no writes, no field echo | `... fails closed on a blocked preparation without writing or leaking fields` |
| Injected failure classes are not trusted | `... never trusts an injected error class, even a subclass carrying a sentinel` |
| Classified instance error preserved, unrelated code re-derived | `... preserves only a classified instance error from preparation` |
| Accepted send with lost mark -> one send, deferred | `... reports deferred when an accepted send loses its dispatch mark` |
| Older backlog cannot hide an unconfirmed new job | `... reports deferred when an older backlog consumes the fast-path budget` |
| Fast-path failure cannot roll back the create | `... keeps the accepted create when the fast-path dispatch fails` |
| Default cap 20, lower limit honoured, larger capped | `dispatchReadyJobs run budget > caps a wake at the tick budget ...`, `... honours a lower limit and caps a larger one` |
| Budget predicate stops new operations only | `... stops starting new sends when the budget predicate says stop` |
| Known failure vs unknown outcome, both stay pending | `... distinguishes a known send failure from an unknown outcome and keeps both pending` |
| One attempt per job per wake | `... attempts each failing job once per wake` |
| Accepted send + throwing mark = exactly one send | `... never sends a second copy when an accepted send loses its mark` |
| Late mark conflict does not overwrite newer intent | `... treats a mark that lost to newer intent as a duplicate rather than resending` |
| Sequential wakes reuse the same persisted job identity | `... reuses the same persisted job identity across wakes` |
| Limit/budget/instant/trace validation | `dispatchReadyJobs boundaries > validates the limit, budget predicate, instant and trace id` |
| Envelope shape is identity-only, sent once | `... sends only versioned identity envelopes, once per job` |
| Future work untouched until due | `... leaves future work untouched until its due time` |
| Throwing logger cannot change the workflow | `... keeps a throwing logger from changing the workflow` |
| Secret sentinel absent from logs and report | `... never lets queue failure text reach logs or the report` |
| Fast path and later wake are the same function | `... is the same dispatcher the create fast path uses` |

## 5. Root review corrections applied in this attempt

1. **Replay independence** — `replayExisting` returns the stored record with the
   empty dispatch report and no dispatcher, queue, clock or configuration call.
   Attempt 2 fixed the last gap: `readClockNow` also moved after the early replay
   return, so both the dispatch budget and the clock are consumed only by a
   request that may commit. Regression: the replay test passes a hostile
   `prepare`, a throwing signer, a clock that throws on every call, a throwing
   queue, a throwing `listReady` and `dispatchLimit: 0`.
2. **Future creates skip the fast path** — a `scheduled` create returns
   `enqueueDeferred: false` with an empty report instead of scanning unrelated
   due work.
3. **`markFailed` counts as deferred** — `dispatchReportDeferred` now includes
   `markFailed`, because an accepted send whose mark did not land leaves a
   durably pending job.
4. **Unconfirmed new jobs** — `DispatchReport.confirmedJobIds` records the jobs
   this wake durably marked, and `createPost` reports `enqueueDeferred` when any
   job it just created is missing from that list. Covered by the 25-job backlog
   fixture, which also proves the later wake drains the backlog plus the new job.
5. **Untrusted injected exceptions, and instance vs platform classification** —
   preparation and signing never rethrow an injected object. A signer/key
   failure is rebuilt as `INSTANCE_NOT_READY` (503-shaped instance condition),
   platform readiness stays `PUBLISHER_PREPARATION_BLOCKED` (422-shaped), a
   blocked envelope's reason is allowlisted, and a later composition may
   classify a preparation failure only through the allowlisted codes
   `INSTANCE_NOT_READY` / `PUBLISHER_PREPARATION_BLOCKED`, reconstructed with our
   own message and an allowlisted reason. Message, `cause` and custom fields of
   the thrown object are always discarded.

## 6. Limits and unresolved items

- Codes are map-ready but not mapped here: `INVALID_REQUEST` 400,
  `IDEMPOTENCY_CONFLICT` 409, `PUBLISHER_PREPARATION_BLOCKED` platform
  readiness, `INSTANCE_NOT_READY` 503 instance configuration/key failure,
  `CREATE_CONFLICT` controlled conflict. Root owns the HTTP wiring.
- The modules are intentionally not exported from `src/index.ts`; tests import
  `../src/use-cases/*.js` relatively until root coordinates the export update.
- `prepare` is modelled as an already-composed `async (platform, now) =>
  PublisherPreparation`. Any exception that is not one of the two allowlisted
  classifications is reported as platform readiness (`invalid_configuration` for
  the documented contract-violation shape, otherwise `unavailable`), with the
  raw cause dropped on purpose.
- Duplicate dispatch remains possible when a concurrent wake sends the same job;
  this is the documented at-least-once design and the consumer's execution CAS
  de-duplicates (FM-03/FM-04). No distributed lock or bulk abstraction is added.
- `enqueueDeferred` may be conservatively true when a concurrently running
  dispatcher already dispatched a created job before the fast path read the
  outbox: the job id is simply absent from `confirmedJobIds`. The outbox state,
  not the report, stays authoritative.
- A replay returns the stored record and never re-dispatches or re-arms by
  itself, so a replayed post's transport state is exactly what the store holds;
  recovery belongs to the routine wake and maintenance budget.
- Verification here is fake-store behaviour proof on Node 24. Local D1/Queue
  runtime validation of the same semantics remains Task 3/T5b+ scope and is not
  claimed by this file.
