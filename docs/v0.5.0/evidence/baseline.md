# Task 0 evidence — baseline and verification environment

Status: **complete for the obtainable local matrix**; the Worker-suite stall was
reproduced, bounded, and localized to the test pool's startup path. No product
source was changed. Owner: Task 0 (test configuration/setup only).

## 1. Tree and runtime

| Item | Value |
| --- | --- |
| Worktree | `/Users/daiyanze/.codex/.chatgpt-projects/g-p-6a9a88c9a9008191ba8b96fdc0a7ddb4/scratch/syndroo-v050` |
| Branch / HEAD | `codex/v0.5.0` / `d8206f298333eeb83d45d319ea244bbda72c78f7` |
| Node 26 | `v26.7.0` (`/opt/homebrew/bin/node`), npm `11.19.0` |
| Node 24 | `v24.19.0` (`/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`) |
| Node 22 | **not obtainable locally** — no nvm/fnm/volta; Homebrew has only `node` (26) and `node@26`; mise installs under `~/.local/share/mise/installs/node` are 24.14.0, 24.15.0, 25.8.0 (no 22.x) |
| Vitest | `4.1.11`; `@cloudflare/vitest-plugin` `1.1.10` (bundles wrangler `4.132.0`, miniflare `5.20260915.0-alpha` — a prerelease, `"workers-sdk": {"prerelease": true}`) |
| test config | `packages/cloudflare-worker/vitest.config.ts` unchanged: real `cloudflareTest(...workerd/D1...)`, `maxWorkers: 1`, synthetic bindings, no `.dev.vars` |

## 2. Exact commands

Focused, serial, bounded (run from `packages/cloudflare-worker`):

```bash
node test/support/bounded-run.ts --timeout-ms 300000 --heartbeat-ms 15000 \
  --label focused --log /tmp/t0-focused.log \
  -- ../../node_modules/.bin/vitest run test/publishers.spec.ts --reporter=verbose
```

Full Worker suite, serial (same as `npm test --workspace @syndroo/cloudflare-worker`):

```bash
node test/support/bounded-run.ts --timeout-ms 300000 --heartbeat-ms 30000 \
  --label full --log /tmp/t0-full.log -- ../../node_modules/.bin/vitest run
```

Node 24 leg / on-deadline diagnostic capture:

```bash
N24=/Users/daiyanze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
"$N24" test/support/bounded-run.ts --timeout-ms 120000 --heartbeat-ms 60000 \
  --sample-seconds 3 --log /tmp/t0-n24.log \
  -- "$N24" ../../node_modules/.bin/vitest run
```

`test/support/bounded-run.ts` runs the command unchanged in its own process
group, forwards output verbatim, and on deadline emits a `ps` group listing plus
`sample` stacks for the runner and every `workerd` child before killing the
group. Exit `124` means "deadline reached", `0` means the suite passed.

**Environment requirement:** the pool binds loopback sockets and writes a
wrangler log outside the workspace. Under this session's sandbox both are
denied (`listen EPERM 127.0.0.1`, `open .../Library/Preferences/.wrangler/logs/... EPERM`)
and the suite fails in ~1.6s with `Failed to start cloudflare-pool worker`. Every
number below is from an **escalated (loopback-permitting)** run; no `.dev.vars`
was read and no real egress is reachable from these fixtures.

## 3. Results

| Run | Runtime | Result | Duration | Boundary reached |
| --- | --- | --- | --- | --- |
| focused `publishers.spec.ts` | Node 26 | **PASS** 6 tests | 4.76s | complete |
| full suite (12 files, 106 tests) | Node 26 | **PASS** | 13.78s | complete |
| full suite, `--maxWorkers=4` | Node 26 | **PASS** | 9.85s | complete |
| full suite | Node 26 ×3 (loop) | **PASS** | 14–17s | complete |
| full suite | Node 24 | **PASS** | 16.24s, 17s, 16s, 17s | complete |
| full suite | Node 24 | **STALL** (killed) | 345.6s | 7/12 workers started, no 8th |
| full suite | Node 24 | **STALL** (exit 124) | 90s | 7/12 |
| full suite | Node 24 | **STALL** (exit 124) | 94s | 6/12 (sampled) |
| full suite | Node 24 | **STALL** (exit 124) | 127s | 6/12 (sampled) |
| five provider specs individually | Node 24 | **PASS** | 2.3–2.6s each | complete |

Stall rate in this host: **Node 24 4/9 full-suite runs**, **Node 26 0/4**. The
sample is small, so this is a rate observation, not proof that the Node version
is the trigger.

Peer results supplied by root (not re-run here): Node 24 `core` + five adapters
99 tests PASS; Node 24 SDK 50 + CLI 78 PASS under escalated loopback with
`rtk proxy env PATH=/Users/daiyanze/.codex/.../node/bin:/opt/homebrew/bin:/usr/bin:/bin npm run test --workspace @syndroo/sdk --workspace @syndroo/cli`.

## 4. Observed boundary and working hypothesis

Every stall has the same shape: vitest prints N pool-worker starts
(`Using secrets defined in process.env`) and N test-file results, then goes
silent with **no** further worker start, no error, and never exits.

`node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs:63955` —
`CloudflarePoolWorker.start()`:

```js
this.mf = await getProjectMiniflare(...);
this.socket = await connectToMiniflareSocket(this.mf, getRunnerName(...));
```

There is **no timeout, abort, or health check** anywhere on this path, so a
startup that never completes blocks the run forever. Confirmed by sampling the
frozen run (`/tmp/t0-n24-sample-5.console`):

* runner process (pid 4777) — entirely idle; only frame of interest:
  `uv_run → uv__io_poll → kevent`. No pending socket read, no blocked pipe, no
  CPU spin: it is waiting on a promise that never settles.
* `workerd` child (pid 4800, parent 4777) — healthy and idle:
  `kj::EventLoop::wait() → UnixEventPort::doKqueueWait() → kevent`, V8 workers
  parked in `__psynch_cvwait`. Launched at `+8s`, i.e. it belongs to an earlier
  file and is not serving the file that never started.

**Hypothesis (not confirmed).** The stall sits in the test pool's per-file
startup path. The captured stacks show only that the runner is parked in its
event loop while a `workerd` child is alive and idle; they do not identify which
internal wait was lost, and they cannot exclude a lost wakeup in resource
lifecycle management (Miniflare/workerd start or teardown between files),
an interaction with this host, or a race in the prerelease
`miniflare 5.20260915.0-alpha` / `@cloudflare/vitest-plugin 1.1.10` pair. What
the evidence does establish is the *boundary*: the run stops between file
workers, before the next file starts, with no test executing and no error
raised — and this is a pre-existing condition, not something introduced by the
0.5.0 work. Treating it as "the prerelease startup race is the cause" would
overstate the evidence.

### Observed differences (each weakens a candidate; none is an exclusion)

* **Port bind:** 0 occurrences of `EADDRINUSE`/`listen` errors in any stalled
  run; `workerd` uses `--socket-addr=entry=127.0.0.1:0` (ephemeral port) and the
  live `workerd` is healthy.
* **Permissions:** sandbox denial produces an immediate, loud failure
  (`listen EPERM`, exit 1 in ~1.6s), unlike the silent stall; all stall runs
  above were escalated and had loopback available.
* **Test content:** every hung run stopped *before* the next file started, and
  all five provider specs pass individually on Node 24 while the suite passes
  5/9 on Node 24 and 3/3 on Node 26. That makes a specific failing assertion an
  unlikely trigger, but it is not a proof: a file that never starts cannot
  demonstrate that its content is unrelated, and the sample is small.
* **Stale host state:** an unrelated worktree
  (`/Users/daiyanze/Documents/work/copilot-worktrees/syndroo/daiyanze-automatic-couscous`)
  has had the same signature hung for **1d19h** (`pid 980` vitest + `pid 995`
  workerd), so this is a pre-existing, reproducible-elsewhere condition rather
  than an artifact of this worktree.

## 5. Correction applied and remaining decision

Applied (test environment only, no assertions weakened, real workerd/D1 kept):

* `packages/cloudflare-worker/test/support/bounded-run.ts` (new) — bounds a run
  externally, reports the last reached boundary, and captures stacks before
  killing the group. Typechecks under `tsc -p test/tsconfig.json`; Vitest does
  not collect it (not `*.spec.ts`).

Not applied, needs a root decision because it changes test semantics:

* `test.isolate: false` (or a persistent single worker) would cut per-file
  Miniflare/workerd churn, which is where the lost wakeup happens — but it
  removes per-file isolation, so it must not be adopted without review.
* Upstream fix: bump `@cloudflare/vitest-plugin`/`miniflare` when a release
  without this prerelease startup race exists. `npm run check` regenerating
  bindings is a separate concern (below).

## 6. Other baseline findings (not Task 0 fixes)

* `tsc -p packages/cloudflare-worker/test/tsconfig.json --noEmit` fails at
  `d8206f2` with exactly 2 errors, independent of any Task 0 change:
  `src/platform-descriptors.ts(308,5)` and `(309,5)` — `"LINKEDIN_CLIENT_ID"` /
  `"LINKEDIN_CLIENT_SECRET"` are not `keyof Env` because the generated
  `packages/cloudflare-worker/worker-configuration.d.ts` (last committed in
  `87ba42b`) contains no `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`, and root
  `package.json` `cloudflare.bindings` does not declare them either. Owner:
  bindings/manifest task (root/T9); not modified here.
* Vitest `maxWorkers: 1` is valid in Vitest 4.1.11
  (`node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts:2848-2853`), so the
  existing serialization setting is effective; the config comment's claim that
  parallel files hang was **not** reproducible (4 workers passed in 9.85s).

## 7. Unresolved

* Node 22 leg of the CI matrix could not be run locally (runtime unavailable).
* The stall is intermittent; the exact trigger inside the prerelease
  miniflare/workerd readiness handshake is not identified, so no in-repo fix
  beyond bounding the run is justified by the evidence.
* Full logs live in `/tmp/t0-*.console` / `/tmp/t0-*.log` (ephemeral); every
  command in section 2 regenerates them.
