# Worker test isolation and finite watchdog

Task T9a. Implements `docs/v0.5.0/test-isolation.md`: the main Worker Vitest
project no longer inherits production Wrangler configuration, every project
fails closed on outbound traffic, test ownership is proven through Vitest's own
discovery, and long-running suites are bounded by a watchdog that cleans its
owned process group.

No product behaviour changed: only test configuration, test support, Worker test
scripts and this evidence file.

## What changed

`packages/cloudflare-worker/vitest.config.ts` (main project, rewritten)

- Removed `wrangler.configPath` and every Wrangler-derived binding; no remote
  proxy session, no account, database or queue identifier, no credential file.
- Declares explicit local bindings through `test/support/worker-test-project-v050.ts`:
  disposable local D1 (`DB`), the fixture queue producer/consumer
  (`PUBLICATION_QUEUE` to `syndroo-publications`), `TEST_MIGRATIONS` read from the
  immutable migration directory, and synthetic secret values only.
- `cf: false` (no Cloudflare metadata fetch) and a fail-closed outbound service
  that answers every request with a fixed `500` body
  `outbound network access is disabled in Worker tests`. The handler
  interpolates nothing, so no attempted URL, header or body can appear in the
  failure, and it returns a fixed `Response` instead of a stack-bearing throw.
- The publication queue producer and consumer are both declared, matching the
  previous Wrangler-derived shape. The consumer is required, not decorative:
  `test/orchestration.spec.ts` enqueues through the real binding and then polls
  for a publication to reach `published`/`failed`, which only happens when the
  broker delivers the batch back into the worker's queue handler. Removing the
  consumer fails four of those tests; the failed corrective attempt and its
  evidence are recorded in `docs/v0.5.0/evidence/worker-teardown.md`.
- `include: ["test/**/*.spec.ts"]` with
  `exclude: [...configDefaults.exclude, "test/{crypto,r2}-v050*.spec.ts"]`, so
  the crypto/R2 suites belong only to their dedicated project.

`packages/cloudflare-worker/test/canary-v050.vitest.config.ts` and
`test/canary-v050.native.ts` (new)

- Isolated egress canary that reuses the main project's real options and
  installs no global fetch mock. Three cases: an outbound GET with sentinel path
  and query, a POST with sentinel authorization header, custom header and body,
  and a `/cdn-cgi/trace` metadata URL. Each asserts status `500`, a body exactly
  equal to the fixed message, and the absence of every sentinel and host name.
  The expected message is an independent literal, so the assertion cannot pass
  by reading the handler's own constant and no host tooling is imported into
  workerd.

`packages/cloudflare-worker/test/support/bounded-run.ts` (rewritten)

- Importable `runBounded(options)` plus the CLI used by the runner.
- Exactly one terminal reason wins (natural exit, deadline, forwarded signal).
  It latches immediately and clears the deadline, so a natural exit keeps its
  own status even while the descendant grace and the final snapshot run.
- Every exit path cleans the owned process group: SIGTERM, bounded grace,
  SIGKILL, then a bounded final snapshot. A parent that exits first still has
  its descendants reaped, and a group that ignores SIGTERM is escalated.
- Diagnostics run in their own process groups with a hard deadline, an output
  cap and a target cap, are cancelled when the run finishes, and cannot delay group termination. Completion waits for a bounded final
  process snapshot. Their groups are killed on every settle,
  including a diagnostic that exits successfully while leaving descendants.
- Only the owned process group is described (filtered by process group id before
  printing). Child tools inherit process.env; environment values are not printed,
  and no credential file is loaded into Worker bindings.
- Deterministic exits: child code, `124` deadline, `127` spawn failure,
  `128+signal` when the watchdog itself is signalled, `64` misuse. Budgets are
  validated in the API (`RangeError`) as well as in the CLI.

`packages/cloudflare-worker/test/support/watchdog-fixtures.ts`,
`test/host-v050.vitest.config.ts`, `test/watchdog-v050.native.ts` (new)

- Node-host project (never default Worker discovery) running the watchdog
  against disposable subprocess fixtures: natural exit-code preservation,
  spawn failure, deadline kill, descendant reaping, SIGTERM-ignoring group,
  parent-exits-first descendant, hanging diagnostics, diagnostic descendant
  leak, unrelated-process survival and budget validation.
- Fake `ps`/`sample` programs are injected through an isolated PATH entry and
  record a marker file, so the "hanging diagnostics" and "diagnostic exits
  first" cases are real executions rather than code readings.

`packages/cloudflare-worker/test/support/test-inventory.ts`,
`test/inventory-v050.native.ts` (new)

- Ownership is authoritative: each configuration on disk is asked for its file
  list with `vitest list --filesOnly --json --config <config>` (no collection,
  no execution) through the bounded watchdog. No custom glob parser and no
  hardcoded project or file list.
- The report fails on orphans, duplicate claims, projects that list nothing,
  failed discovery, and files listed outside the test-like candidate set.
- A disposable fixture project created during the run proves discovery is
  dynamic: it is picked up, and re-listed after a second file appears.

`packages/cloudflare-worker/test/support/run-worker-tests.ts` (new) and
`package.json` test scripts

- The documented aggregate command runs the main project first and then every
  discovered dedicated project, sequentially, each under the finite watchdog,
  and exits nonzero if any project failed even when a later project passed.
- Scripts: `test` (aggregate), `test:worker:main`, `test:worker:canary`,
  `test:worker:watchdog`.

## Verification

All runs used Node `v24.19.0`
(`/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`)
first on `PATH`, from `packages/cloudflare-worker`, under an external finite
guard. workerd runs used local loopback escalation; nothing was deployed and no
live credential, `.dev.vars`, `.env` or remote resource was read.

1. Static type check of the Worker test tree

   `../../node_modules/.bin/tsc -p test/tsconfig.json --noEmit`

   Only four errors remain, all outside this task's scope and none in a file
   changed here: `src/platform-descriptors.ts` 308-309
   (`LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET` not in `keyof Env`),
   `test/crypto-v050.spec.ts:268`, `test/r2-v050.spec.ts:144`.

2. Egress canary (independent root execution, `session94677`)

   `../../node_modules/.bin/vitest run --config test/canary-v050.vitest.config.ts`

   Exit `0` at 07:42:24, 1 file / 3 tests passed in 747ms under root's own
   external 60s group deadline. This is the fail-closed gate that authorised
   broader execution.

3. Node-host watchdog and inventory suite (final tree)

   `../../node_modules/.bin/vitest run --config test/host-v050.vitest.config.ts`

   Exit `0`, 2 files / 20 tests passed, 10.40s
   (11 watchdog cases, 9 inventory cases).

4. Aggregate Worker suite

   `node test/support/run-worker-tests.ts --timeout-ms 600000 --kill-grace-ms 5000`

   Final tree: exit `0`, 8/8 projects passed (07:57:29-07:58:44).

   The earlier aggregate run on the same main and dedicated code
   (07:53:37-07:54:12, exit `0`) recorded per-project counts:

   | project | files | tests |
   | --- | --- | --- |
   | main | 17 | 228 |
   | canary-v050 | 1 | 3 |
   | host-v050 | 2 | 20 |
   | http-body-v050 | 1 | 29 |
   | oauth-drivers-v050 | 1 | 33 |
   | queue-consumer-v050 | 1 | 19 |
   | runtime-dependencies-v050 | 1 | 16 |
   | storage-v050 | 2 | 56 |

   Root's final 8-project aggregate (`session58504`, 08:04:30-08:05:07) recorded
   the same projects at 26 files / 404 tests, exit `0`: main 228, canary 3,
   host 20, http-body 29, oauth-drivers 33, queue-consumer 19,
   runtime-dependencies 16, storage 56. Those counts supersede the historical
   `host-v050` 18 from the earlier run, which grew by the two extra cleanup
   regressions.

   The dedicated `scheduled-maintenance-v050` project landed separately after
   those runs. The runner and the inventory both discover configuration files at
   runtime, so it is picked up without a code change; its counts are its owner's
   evidence, not this record's.

   Discovery inventory on the final tree: no orphan, no duplicate, no project
   listing nothing, no failed discovery, and no file listed outside the
   test-like candidate set.

## Limitations

### Known lifecycle artifact

The main project emits a non-failing `EnvironmentTeardownError` ("Closing rpc
while \"resolve\" was pending") during its run. It does not fail tests or change
the exit code, but a green exit does not prove teardown safety, and this record
does not treat it as harmless or as proven pre-existing. It reproduces from the
accepted configuration, it disappears when the automatic queue consumer is
removed, and removing that consumer breaks four `test/orchestration.spec.ts`
tests, so the accepted configuration retains the consumer. The full diagnosis,
all executions and the disproved correction are in
`docs/v0.5.0/evidence/worker-teardown.md`.

- Node 22 is unverified; only Node 24.19.0 was exercised.
- The canary proves the fixture behaviour of the configured handler. It does not
  prove live-provider compatibility and does not retroactively establish the
  absence of contact in the earlier ungated run.
- The four type errors listed above are outside this scope and remain unfixed
  here; they are reported rather than hidden.
- Runtime route cutover, deployment, publishing and the full 120-gate product
  ledger are separate acceptance work and are not claimed by this evidence.
- `docs/v0.5.0/test-isolation.md` describes the design; this file records the
  implementation evidence only.

## Independent root acceptance

Root accepted T9a isolation/discovery/finite cleanup after attempt2. Node24 host
suite20passed; a disposable aggregate fixture preserved an intermediate failure
(exit1) while still running its final passing project. Full aggregate at
08:04:30–08:05:07 passed8projects/26files/404tests, exit0. Main emitted an
EnvironmentTeardownError while closing a pending RPC, despite its228passing
tests; lifecycle diagnosis remains open. Whole Worker test-tree typechecking
continues to fail with the four listed outside-scope errors. See root-review.md
for exact independent command outputs and scope limits.
