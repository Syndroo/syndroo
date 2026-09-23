# Task 8b1 evidence — scheduled-runtime deadline wrapper

Status: **T8b1 attempt 1 complete for review**, with both early-review rounds
folded in. Owner: T8b1 scope only (the files listed below). The acceptance ledger
is unchanged: **3 PASS / 117 NOT_RUN**, and no gate is promoted — this slice
proves the deadline wrapper against the accepted portable `runMaintenance` and
the frozen fake, not production Cron behaviour, D1 row budgets or the legacy
entrypoint.

## 1. Authority followed

`docs/v0.5.0/runtime-composition.md` §"Scheduled work and diagnostics", final
paragraph (independent scheduled-runner slice):

- explicit `MaintenanceLimits` from the eventual measured profile; no guessed
  production row limits
- one twenty-second total runtime deadline per wake, with an internal test
  option allowed to lower it only
- dependencies and limits captured before starting
- a latched continuation check handed to the application, and completion raced
  against the deadline so a held-open binding cannot hold the wrapper
- on deadline: latch stopped before returning a fixed timeout outcome with no
  invented phase counts; a pending operation may finish afterwards, its eventual
  rejection is observed, later phases/sends are prevented, and the accepted
  operation is never claimed cancelled
- timers cleared on every completed/error path; completed reports retain the
  application's phase failures exactly; unexpected failures use a fixed error
  with no raw detail
- this slice does not change `scheduler.ts`/`index.ts`, choose a D1 query
  budget, implement diagnostics, or accept the production Cron profile

## 2. Files, runtime, commands

```text
packages/cloudflare-worker/src/composition/scheduled-maintenance.ts       (new)
packages/cloudflare-worker/test/scheduled-maintenance-v050.native.ts      (new, 15 tests)
packages/cloudflare-worker/test/scheduled-maintenance-v050.vitest.config.ts (new)
packages/cloudflare-worker/test/support/scheduled-maintenance-v050-worker.ts   (new)
packages/cloudflare-worker/test/support/scheduled-maintenance-v050-tsconfig.json (new)
docs/v0.5.0/evidence/scheduled-maintenance.md                             (new, this file)
```

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Runtime | Node `v24.19.0` (bundled first on PATH), Vitest `4.1.11`, native workerd pool |
| Application | accepted `runMaintenance` + `MaintenanceLimits` / `MaintenanceReport` / `RunMaintenanceDependencies` imported directly from `@syndroo/application` |
| Unchanged | `scheduler.ts`, `index.ts`, legacy `jobs.ts`, application package, D1/crypto/R2/transport, CLI, manifests, main test config and the T9a watchdog |

```bash
# scoped type check: source + test + dedicated config
tsc -p test/support/scheduled-maintenance-v050-tsconfig.json          # exit 0, zero errors

# exact dedicated native run under the reviewed external guard
node test/support/bounded-run.ts --timeout-ms 300000 --label scheduled-maintenance \
  --log /tmp/scheduled-maintenance-3.log -- ../../node_modules/.bin/vitest run \
  --config test/scheduled-maintenance-v050.vitest.config.ts
# watchdog: child exited code=0 signal=null elapsed=1.1s (08:17:50 run)
# vitest: 1 file, 15 tests passed, duration 741ms
```

The guard is the reviewed `test/support/bounded-run.ts`, which owns its process
group and performs SIGTERM → bounded grace → SIGKILL cleanup, so it reaps
descendants rather than only the direct child. The project itself sets
`cf: false`, uses its own support Worker stub (no legacy entry graph) and a
`outboundService` that always throws; the only escalation needed was the
documented local loopback listener for the `cloudflare-pool`.

## 3. Implementation

`createScheduledMaintenance(dependencies)` copies every reference once (ports,
clock, logger, caller continuation predicate, monotonic source, both timer
functions) and returns a per-wake function:

1. copies and validates the four explicit limits (positive safe integers, no
   defaults) and the optional internal deadline, rejecting anything above the
   fixed twenty seconds — failures return `{kind:"failed", code:"INVALID_OPTIONS"}`
   before any domain call or timer
2. reads a monotonic start (`performance.now()` by default; an injected source
   must produce finite numbers) and computes the deadline
3. arms the deadline timer **before** the application is invoked, so a timer
   setup failure has zero domain effect, and the timer callback latches the
   deadline and stop *before* resolving the race
4. hands the application a latched continuation check that distinguishes three
   outcomes: a caller predicate stop (phases stop, the report stands), proven
   elapsed time (deadline), and an unmeasurable clock (fixed failure)
5. races completion against the deadline; a deadline returns
   `{kind:"timed_out"}` with no report, latching stop and observing the pending
   work's eventual settle/rejection
6. re-reads the monotonic clock after the work finishes, so a last phase that
   completed after the deadline elapsed — with the timer callback still queued —
   is reported as `timed_out`, never as a completed wake
7. returns `{kind:"completed", report}` with the application's own frozen report
   verbatim, or `{kind:"failed", code:"MAINTENANCE_FAILED"}` for unexpected
   failures, and clears the timer on every path

## 4. Review corrections folded into this attempt

First review round:

1. **Captured one by one.** Ports, clock, logger, the caller's predicate and both
   timer functions are copied at construction (no retained mutable container),
   and the predicate is read through the captured reference — never re-read.
2. **Monotonic clock hardened.** The default source is `performance.now()`;
   non-finite or throwing reads are handled without a raw rejection.
3. **Timer before work.** Deadline observation is established before any domain
   call; `timers.set` is invoked outside the promise executor, so a throwing hook
   fails synchronously with zero domain effect, and the timer is cleared in a
   guarded `finally` rather than leaking through `.finally(clear)`.
4. **Deadline latched in the callback, and elapsed time honoured.** The callback
   latches before resolving, and an elapsed-time check that exhausts the deadline
   before the callback runs can no longer be reported as a completed wake.

Second (follow-up) review round:

5. **Post-race elapsed recheck.** After the application wins the race, the
   monotonic clock is read again; a last phase finishing past the deadline now
   yields `timed_out` with no invented report (fixture: a final mark that sets
   the elapsed clock while the twenty-second timer is still queued).
6. **Clock failure ≠ deadline.** An unmeasurable read latches stop but returns
   `{kind:"failed", code:"MAINTENANCE_FAILED"}` — only a fired timer or a
   measured elapsed time produces `timed_out`.
7. **Capture documented as trusted configuration.** Dependency references are
   read at construction, outside the wake failure channel; the module comment no
   longer claims to guard getter failures there.
8. **Cleanup wording exact.** The clear-hook-throwing fixture asserts the cleanup
   was *attempted* (once) and the outcome stayed intact; it does not claim the
   underlying handle was really cleared, because the hook threw.

## 5. Behaviour covered by the native suite (15 tests)

| Required behaviour | Test |
| --- | --- |
| Phase order, a fresh clock per phase, explicit limits, completed frozen report, timer cleaned | `runs the accepted phases in order with a fresh clock, explicit limits and a completed report` |
| A failed application phase is preserved, not turned into a zero | `preserves an application phase failure instead of a fabricated zero` |
| Invalid/missing limits and out-of-range deadlines fail before any call or timer | `fails cause-free with INVALID_OPTIONS before any call or timer` |
| Lower deadline accepted; the fixed deadline accepted; anything above rejected | `accepts a lower deadline option and rejects anything above the fixed deadline` |
| Held-open recovery → `timed_out`, later phases never start after it resolves or rejects | `returns timed_out for a held-open recovery and starts no later phase after it settles` |
| Held first send → `timed_out`; the late accepted send may mark, no second send starts | `returns timed_out while the first send is held and never starts a second send` |
| Concurrent wakes keep independent stop/deadline state | `keeps independent stop and deadline state across concurrent wakes` |
| Elapsed time is a deadline even without a timer callback | `treats elapsed time as a deadline even when the timer callback never fires` |
| Last phase finishing after elapsed time → `timed_out`, no invented counts | `returns timed_out when a last phase finishes after elapsed time with no timer callback` |
| Caller continuation stop is not a deadline (real report stands) | `keeps a caller continuation stop distinct from a deadline` |
| Explicit `dispatchLimit` above twenty still capped by the accepted dispatcher | `caps an explicit dispatch budget above twenty through the accepted dispatcher` |
| Captured dependency/predicate/timer/clock references survive container mutation | `uses the captured dependency, predicate and timer references after container mutation` |
| Invalid or throwing monotonic source → fixed failure, no timer, zero calls | `fails cause-free when the monotonic source is invalid or throws` |
| Later unusable monotonic read → fixed failure with latched stop | `fails cause-free when a later monotonic read is unusable` |
| Timer setup failure → fixed failure with zero domain calls; cleanup attempt with intact outcome | `handles timer setup and cleanup failures without leaking raw errors` |

## 6. Limits and unresolved items

- **No production Cron acceptance.** This slice does not change `scheduler.ts`
  or the Worker entry, does not choose a D1 query/row budget and does not accept
  the production Cron profile; T3's measured statement/row evidence remains
  exhausted and untouched.
- **Timer guard scope.** The reviewed `bounded-run.ts` guard owns and kills the
  whole process group, so it reaps descendants; it is still a user-space
  watchdog and cannot pre-empt a hung kernel-level syscall.
- **Fake-portable proof only.** Phase machinery is exercised against the frozen
  snapshot fake with counted ports; real D1 concurrency, query plans and
  production timings remain unverified here.
- **Main-suite lifecycle observation.** The main aggregate emitted an
  `EnvironmentTeardownError` while closing its RPC channel despite exiting 0;
  that is a pre-existing main-suite lifecycle issue, untouched by this slice and
  owned by the T9a isolation work.
- **Dedicated project only.** The new config includes exactly the `.native.ts`
  slice, uses its own stub and fail-closed outbound service, and neither imports
  nor modifies the main test setup/runner or its watchdog; the new files were
  reported to the T9a owner for dynamic inventory.
