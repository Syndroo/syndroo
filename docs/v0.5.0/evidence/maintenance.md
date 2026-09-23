# Task 8a evidence — portable bounded maintenance orchestration

Status: **T8a attempt 1 complete for review.** Owner: T8a scope only
(`packages/application/src/use-cases/run-maintenance.ts`,
`packages/application/test/run-maintenance.test.ts`, this file). No product
acceptance ID is claimed: `docs/v0.5.0/acceptance-results.json` stays `NOT_RUN`,
because this is fake-port orchestration proof. Real D1 statement/row metrics,
races and the runtime scheduler tick remain blocked under the exhausted T3
scope and are not claimed here.

## 1. Authority followed

`docs/v0.5.0/runtime-composition.md` (Scheduled work and diagnostics):

- the four steps are **separate transactions**; no whole-wake atomicity is claimed
- a fresh canonical clock is captured at each phase
- a failed cleanup stays visibly failed rather than reporting `removed: 0`
- a fixed total deadline stops starting later phases and new sends, but cannot
  cancel a D1 mutation or broker send already accepted
- per-phase row limits are explicit and dispatch is capped at twenty
- maintenance is not a refresh actor: no provider call, preparation,
  decryption, token reuse or silent connection change; OAuth cleanup retains
  completed receipts, and outbox collection follows its existing port semantics

## 2. Files, runtime, commands

```text
packages/application/src/use-cases/run-maintenance.ts     (new)
packages/application/test/run-maintenance.test.ts         (new, 13 tests)
docs/v0.5.0/evidence/maintenance.md                       (new, this file)
```

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled), Vitest `4.1.11` |
| Ports | `PublishingStore.recoverStaleClaims`, `CredentialStore.cleanupExpired`, `OutboxStore.collectFinished` + the accepted `dispatchReadyJobs` |
| Frozen | contracts, ports, fake, other use cases, `src/index.ts`, D1, crypto/R2/transport, runtime scheduler, manifests untouched |

```bash
npm run check -w @syndroo/application   # tsc src + test configs      -> exit 0
npm run build -w @syndroo/application   # tsc -p tsconfig.json        -> exit 0
npm run test  -w @syndroo/application   # build && vitest run         -> 23 files, 313 tests passed
```

The whole application suite (including other writers' files present at run
time) passes with this slice included; `test/run-maintenance.test.ts` runs
13 of those tests.

## 3. Implementation

`runMaintenance(limits, dependencies)` runs, sequentially:

1. `publishing.recoverStaleClaims`
2. `credentials.cleanupExpired`
3. `outbox.collectFinished`
4. `dispatchReadyJobs` (the accepted dispatcher, which applies its own
   twenty-job tick cap and de-duplicates per send)

Each phase returns its own frozen report with `status`
(`completed | failed | skipped`), a **fixed code**
(`COMPLETED | STORE_UNAVAILABLE | MALFORMED_RESULT | CLOCK_UNAVAILABLE |
BUDGET_EXHAUSTED`) and nullable counters. A failure or skip carries `null`
counts, so no fabricated zero or successful-looking number can reach a caller
that omits the logger; the same fixed code also goes to the structured log.

Dependency surface: `Pick<PublishingStore, "recoverStaleClaims">`,
`Pick<CredentialStore, "cleanupExpired">`, the outbox port, the queue port, the
clock, an optional logger and an optional continuation predicate. There is no
provider, preparation, cipher, refresh, claim or commit method to call, and the
module adds no scheduler or framework of its own.

## 4. Review corrections folded into this attempt

1. **Limits snapshotted before the first await.** All four limits are validated
   and copied into a frozen snapshot first, so a caller mutating its own object
   mid-wake (including to `0` or `NaN`) cannot change what the wake was
   authorized to do. `dispatchLimit` is now **explicit and required**, validated
   positive-safe-integer; the dispatcher still caps it.
2. **Counters whitelisted, not interpolated.** Every reported count is copied
   through `countOf` (finite, nonnegative, safe integer) and a malformed or
   throwing report becomes a fixed `MALFORMED_RESULT` failure with all counts
   `null` - no partial copy, no string/NaN/secret escape.
3. **Continuation latched.** The predicate is captured once and the first
   `false` or throw latches "stopped" for the rest of the wake, so a deadline
   exhaustion can never be undone by a later `true`, and later phases never
   resume.
4. **Fixed code in the report itself**, not only in the log.
5. **Clock failures are fixed and local.** A throwing or non-canonical clock
   yields `CLOCK_UNAVAILABLE` with null counts for that phase only; later phases
   still attempt their own fresh read, and the raw clock message never escapes.
6. **Limit validation is hostile-input safe**: a null object or throwing getter
   produces the same fixed `InvalidContractInputError` before any effect.

## 5. Behaviour covered by tests

| Required behaviour | Test |
| --- | --- |
| Four phases run in order, each with a fresh canonical instant and its own limit; dispatch uses its own fresh instant | `phase order and budgets > runs the four phases in order with a fresh canonical instant and its own limit` |
| Limits/predicate snapshotted before the first await (mutation across awaits) | `... snapshots the validated limits and the predicate before the first await` |
| Invalid or hostile limits rejected before any effect, fixed text, zero calls/reads | `... rejects invalid limits before any effect, even from a hostile object` |
| Deadline already exhausted: everything skipped, null counts, zero reads | `continuation and failures > skips every phase when the deadline check is false before the first phase` |
| First stop latches; a later `true` never resumes a phase | `... latches the first stop and never resumes a later phase on a true answer` |
| Each phase failure reported safely while later phases still run; no sentinel echo | `... reports each phase failure independently and still runs later phases` |
| Malformed numeric/throw-on-read reports become fixed failures, no partial copy | `... turns a malformed numeric report into a fixed failure, never a partial copy` |
| Throwing and malformed clocks: `CLOCK_UNAVAILABLE`, null counts, four fresh attempts, no raw text | `... fails a phase with a fixed clock code instead of a raw clock error` |
| Only the first clock read fails: later phases still complete (independent policy) | `... keeps later phases running when only the first clock read fails` |
| Throwing logger cannot change the report | `... keeps the report when the logger throws` |
| Real port results copied exactly (stale claim, expired operation, finished intent, due send) | `real port results > copies real recovery, cleanup, collection and dispatch counts` |
| Dispatch budget stops new sends while accepted marks/outcomes are preserved | `... lets the dispatch budget stop new sends while keeping accepted work` |
| No claim/provider/preparation/decryption/refresh path reachable; empty store untouched | `... reaches no claim, provider, preparation, decryption or refresh path` |

## 6. Limits and unresolved items

- **Fake-portable proof only.** The `recoverStaleClaims` statement/row counts and
  query plans, plus real D1 races, belong to the exhausted T3 scope; nothing here
  substitutes for them and no numeric profile is claimed.
- **Runtime tick not wired.** Cron scheduling, the real Worker wake, queue
  consumption/ack mapping and the operational alert path remain T9/runtime scope.
  This slice proves ordering, budgets, reports and failure isolation only.
- Dispatch counts are copied without the dispatcher's internal
  `confirmedJobIds`; the maintenance report is a summary, and the dispatcher
  keeps its own detailed return value for the fast path.
- A failed phase cannot be distinguished further than the fixed code
  (`STORE_UNAVAILABLE` vs `MALFORMED_RESULT` vs `CLOCK_UNAVAILABLE`); the raw
  cause is deliberately dropped, so diagnosis uses the phase code plus the
  runtime's own store/log evidence.
- Maintenance performs no retry of its own: the DLQ/queue runtime owns broker
  retries, and each phase is one call per wake.
