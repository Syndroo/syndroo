# Worker teardown exception and the queue-consumer correction

Read-only diagnosis (T0 attempt 2) plus one authorised corrective attempt
(T9a attempt 3, now exhausted). The attempted configuration change was
reverted after verification failed; no functional repository change remains.
The shared test-project helper retains a changed explanatory comment. Other
remaining writes are this record, the update to
`docs/v0.5.0/evidence/test-isolation.md`, and disposable diagnostics under
`/tmp`.

## Symptom

The main Worker project reports, during a run whose tests all pass:

```
uncaught exception; source = Uncaught (in promise); stack = EnvironmentTeardownError:
[vitest-worker]: Closing rpc while "resolve" was pending
uncaught exception; exception = workerd/jsg/_virtual_includes/iterator/workerd/jsg/value.h:1477:
failed: jsg.Error: EnvironmentTeardownError: [vitest-worker]: Closing rpc while "resolve" was pending
```

The run still exits `0` with every test passing, and the second line is the same
rejection surfacing inside workerd. It is a lifecycle defect, not a test
failure, and a green exit is not evidence that teardown is safe.

## Source evidence (installed packages, read only)

- `node_modules/vitest/dist/chunks/init.k9zZ9sLh.js:126-135` - `execute()` pushes
  a cleanup that calls `rpc.$rejectPendingCalls(...)` and rejects each pending
  worker-to-host call with
  `new EnvironmentTeardownError('[vitest-worker]: Closing rpc while "<method>" was pending')`.
  The reported method here is `resolve`.
- `node_modules/vitest/dist/chunks/index.Chj8NDwU.js:137-139` - birpc
  `$rejectPendingCalls` walks the pending-call map and rejects every entry;
  `$close` in the same file rejects with
  `[birpc] rpc is closed, cannot call "<method>"`.
- `node_modules/vitest/dist/chunks/init.k9zZ9sLh.js:44` - the module-runner
  transport resolves module ids through the host:
  `async resolveId(id, importer) { return rpc.resolve(id, importer, "__vitest__"); }`.
  A pending `"resolve"` is therefore an in-flight module-resolution RPC from the
  test worker to the host, not an application provider call.
- `node_modules/vitest/dist/chunks/utils.BX5Fg8C4.js:4` - `EnvironmentTeardownError`
  definition; `init.k9zZ9sLh.js:113-118` shows vitest reporting it through the
  `uncaughtException`/`unhandledRejection` listeners, which is why it appears as
  "uncaught exception" without failing the file.
- `node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs` (`resolveId`/`load`
  hooks) - the plugin resolves `cloudflare:test` to a virtual module and its
  `load` hook appends `import "<main>"`, so the Worker entry (`src/index.ts`,
  including its `queue` and `scheduled` handlers) is imported into the Vitest
  test worker.
- `node_modules/miniflare/dist/src/index.d.ts` - `queueConsumers` entries accept
  `maxBatchSize`, `maxBatchTimeout` (bounded 0..60, seconds, matching Wrangler's
  `max_batch_timeout`), `maxRetries`, `retryDelay`, `deadLetterQueue`.

## Executions

All runs: Node `v24.19.0`
(`/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`)
first on `PATH`, cwd `packages/cloudflare-worker`. Every workerd execution was
wrapped in the reviewed finite guard
`test/support/bounded-run.ts --timeout-ms 60000 --kill-grace-ms 1000` (the
accepted spelling; no `--grace-ms`, which the guard would silently ignore).
workerd runs used local loopback escalation only.

| # | Run | Exit | Counts | Artifact | Log |
| --- | --- | --- | --- | --- | --- |
| 1 | main project, verbose | 0 | 17 files / 228 tests, 18.27s | present (2 lines) | `/tmp/t0-main-verbose.log` |
| 2 | `test/retry-timing.spec.ts`, verbose | 0 | 1 file / 14 tests, 2.8s | present (2 lines) | `/tmp/t0-retry-timing.log` |
| 3 | block `strict earliest retry time` | 0 | 7 passed / 7 skipped | present (2 lines) | `/tmp/t0-retry-strict-earliest-retry-time.log` |
| 4 | block `strict retry timing through the Queue` | 0 | 1 passed / 13 skipped | absent | `/tmp/t0-retry-queue.log` |
| 5 | block `SQL fallback retry delay parity` | 0 | 6 passed / 8 skipped | absent | `/tmp/t0-retry-SQL-fallback-retry-delay-parity.log` |
| 6 | each of the 7 tests of block 3 individually | 0 | 1 passed each | absent | `/tmp/t0-case-*.log` |
| 7 | subsets A+B, A+B+C, A+B+C+D, A+E, A..E, all-but-E | 0 | 2, 3, 4, 2, 5, 6 tests | absent | `/tmp/t0-sub-*.log` |
| 8 | subset E+F+G | **124** | timed out at 60s; group still alive at the deadline (node + workerd) | n/a (hang) | `/tmp/t0-sub-E-F-G.log` |
| 9 | `/tmp` probe A: accepted options with `queueConsumers` | 0 | 1 file / 14 tests | present (2 lines) | `/tmp/t0-probe-a-with-consumer.log` |
| 10 | `/tmp` probe B: identical options without `queueConsumers` | 0 | 1 file / 14 tests | absent | `/tmp/t0-probe-b-no-consumer.log` |
| 11 | T9a3 correction: E/F/G subset, consumer removed | 0 | 3 passed / 11 skipped, 2.41s, empty final group | absent | `/tmp/t9a3-subset-EFG.log` |
| 12 | T9a3 correction: main project, consumer removed | **1** | 1 file failed / 16 passed; 4 failed / 224 passed, 34.07s | absent | `/tmp/t9a3-main.log` |
| 13 | after revert: egress canary | 0 | 1 file / 3 tests, 1.1s, empty final group | absent | `/tmp/t9a3-canary.log` |
| 14 | `tsc -p test/tsconfig.json --noEmit` | 1 | only the 4 known outside-scope errors | n/a | terminal |

Probes 9 and 10 are disposable copies of the accepted main options under
`/tmp/t0-probe/` (with `package.json` `type: module` and a `node_modules`
symlink); they differ only in the `queueConsumers` declaration, and both ran the
same spec file. The subset labels are tests of `test/retry-timing.spec.ts`:
A `persists eligibility...`, B `keeps one claim...`, C `clears retry
eligibility...`, D `rolls back status...`, E `covers both scheduler branches...`,
F `treats pre-migration rows...`, G `keeps retry eligibility out of the public
post response`.

No aggregate was run in either effort. Root's earlier aggregate covered
8 projects; the scheduled-maintenance addition makes the current inventory
9 projects. Root owns the next aggregate verification.

## Localisation

The artifact reproduces from the repository configuration (runs 1-3) and from a
disposable copy of it (run 9). Within `test/retry-timing.spec.ts`, the full
`strict earliest retry time` block reproduced it (run 3), while each individual
test and the sampled subsets in runs 6-7 were clean. These samples do not
establish a minimum test count or an exhaustive set of failing combinations.
The `E+F+G` subset did not merely fail to reproduce - it hung
to the 60s deadline with the vitest process and workerd still alive (run 8), a
second and distinct symptom in the same area.

## Corrective attempt (T9a attempt 3, exhausted)

The authorised correction was to remove only the automatic `queueConsumers`
declaration, on the inference that the fixtures drive the consumer side directly
through `worker.queue(...)` with `createMessageBatch`/`getQueueResult` and that
automatic delivery was not on any assertion path.

That inference is incomplete and the correction failed its own acceptance
criteria:

- The previously hung subset became clean (run 11): exit 0, 3 passed /
  11 skipped, 2.41s, no `EnvironmentTeardownError`, empty final process group.
- The exact main project then failed (run 12): exit 1, 4 failed / 224 passed,
  34.07s. All four failures are in `test/orchestration.spec.ts` and are
  `Timed out waiting for ...` from `waitForCondition`
  (`test/orchestration.spec.ts:126-137`), which polls 300 times at 10ms for a
  publication to reach `published`/`failed`: `creates one Post and one provider
  publish for identical concurrent requests` (`:166`), `keeps the conflict
  response for concurrent requests with different content` (`:219`), `recovers a
  Post whose Queue enqueue failed on the next Cron run` (`:265`) and `does not
  republish after a provider timeout, duplicate delivery, or Cron` (`:368`).
  Those transitions only happen when the broker delivers the enqueued batch back
  into the worker's queue handler, so automatic delivery *is* on their assertion
  path.
- Because removing the consumer suppresses real coverage, the change was
  reverted. The helper's functional options are again identical to the accepted
  revision (producer, consumer, D1, synthetic secrets, `remoteBindings: false`,
  `cf: false`, `rejectAllOutbound`); only its doc comment changed, to record that
  the consumer is required and that delivery work is the leading explanation for
  the artifact. Run 13 re-verifies the restored state (canary clean, empty final
  process group) and run 14 confirms no new type errors.

T9a attempt 3 is therefore unsuccessful as a lifecycle correction and is
exhausted. No further attempt, repair, probe or descendant was started.

## Cause and hypotheses

Established:

- The two reported lines are Vitest rejecting a pending worker-to-host
  module-resolution RPC (`resolve`) during its own worker teardown, surfaced
  through the unhandled-rejection listener; the file's tests all pass and the
  process exits 0.
- The automatic consumer declaration is functionally required by
  `test/orchestration.spec.ts`, and it is the single toggling variable between
  run 9 (artifact present) and run 10 (artifact absent), and between run 8
  (hang) and run 11 (clean).

Hypothesis, not proven:

- Broker delivery work - module resolution performed while a delivered batch
  runs, and/or a delivery racing the test's D1 usage - is still in flight when
  Vitest tears the file's worker down, producing the rejected `resolve` and the
  `E+F+G` hang. The stack alone cannot distinguish delivery-side resolution from
  a lazily resolved module of the test file, and the delivery path inside the
  Vitest test worker was not instrumented.

Not established:

- Whether the pre-T9a Wrangler-derived configuration showed the same artifact.
  Only the accepted configuration and a disposable copy of it were exercised, so
  a pre-T9a regression is neither proven nor excluded.
- Whether the artifact indicates a real leak of pending work beyond the reported
  RPC. A green run does not prove lifecycle safety, and this record does not
  describe the artifact as harmless.

## Fix options for root (none implemented)

1. Keep the consumer and treat the artifact as an open lifecycle defect to be
   reported upstream (Vitest teardown rejecting pending module-resolution RPCs
   while a delivered batch is in flight).
2. Move the four delivery-dependent `test/orchestration.spec.ts` cases into a
   dedicated project that owns its consumer and drains deliveries explicitly - a
   test-structure change, outside this scope.
3. Give the Worker test project a delivery-aware teardown (await or cancel
   in-flight deliveries before the file's worker closes) - needs plugin-level
   support, outside this scope.

## Scope statement

T9a2 remains the accepted scope: Worker test isolation (local-only bindings,
fail-closed egress, canary, discovery inventory, aggregate runner) and the finite
watchdog. T9a3 was an unsuccessful lifecycle correction for the teardown
artifact; it changed no functional option in the end.

## Remaining risks

- The teardown artifact remains present in the delivered revision and is
  unproven-safe; it is retained as evidence, not suppressed.
- Subsets like `E+F+G` with the consumer can hang, so broad runs must keep the
  finite external guard.
- Node 22 is unverified; only Node 24.19.0 was exercised.
- The four known type errors outside this scope are unchanged.
