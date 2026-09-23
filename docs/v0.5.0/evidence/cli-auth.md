# Task T7c1 evidence — CLI auth commands and diagnostics

Status: **attempt 3 final; implementation and focused runtime evidence landed.
One known failure remains outside this scope** (`skill.contract` inventory).
Owner: Task T7c1 (`packages/cli/src/**` except `version.ts`/skill,
`packages/cli/test/**` except `skill.*`, this file). No SDK, application,
Worker, manifest, lockfile, version, or Skill edit was made.

## 1. Implemented

| Area | State |
| --- | --- |
| Commands | `auth status|set|connect|operation|complete|refresh|remove` and `diagnostics` wired in `args.ts`/`main.ts`, implemented in `src/commands/auth.ts` |
| Revision rule | set/complete/remove read the revision before the preview and submit exactly that value; connect/refresh read it too; `complete` submits the operation's expected revision, rejects an unfinished-operation mismatch locally, and preserves a completed replay's historical revision |
| Confirmation | `--yes`, or a real TTY prompt; non-TTY or declined set/complete/remove write nothing (exit 2 / exit 5) |
| Secrets | bounded 64 KiB chunked read from `--file` or piped stdin; abort-aware; owned stream destroyed on abort/overflow/failure; no path or raw cause echoed; every submitted string registered with the Reporter before validation |
| Redaction | structured values redacted before serialization; keys never rewritten; short and escaped secrets covered |
| URL | exact HTTPS endpoint plus required query keys; no userinfo/fragment/port; duplicate, unknown, empty, and control-character values rejected; raw length and control checked before parsing; normalized href returned |
| Counts | `authRequests {read, write}` initialized before configuration or secret work; a read counts only when the call is dispatched, so an already-aborted signal or locally rejected input reports `{read: 0, write: 0}`, while an abort after dispatch keeps its count |
| Doctor | read-only readiness from `auth.status`; only 404/405 degrades to the legacy unknown; aborts stay ABORTED (exit 130) through every read stage; malformed readiness fails |

The historical CLI keep-alive interval is removed (accepted SDK standalone
evidence), and the existing real-process `posts.wait` success, timeout, and
abort tests still pass.

## 2. Commands and results

```bash
# repository root, bundled Node 24 first on PATH
npm run check --workspace @syndroo/cli     # exit 0 (src + test typecheck)
npm run build --workspace @syndroo/sdk     # exit 0
npm run build --workspace @syndroo/cli     # exit 0
# packages/cli (loopback and pty fixtures need loopback escalation)
node_modules/.bin/vitest run
# -> 8 files, 136 tests, 135 passed, 1 failed (skill.contract inventory)
```

## 3. Focused coverage

Real subprocess runs of the built `dist/bin.js` against loopback fixtures that
record every HTTP method: status list and single platform, operation,
diagnostics, doctor readiness; set from a file and from piped stdin; short and
JSON-escaped secrets; `--token=sentinel` in neither stream; `__proto__` and
`constructor` credential documents rejected with zero writes; the 64 KiB
boundary; malformed JSON; unknown credential fields; one-object `--json` on
success, cancellation, usage, and ambiguity; TTY yes/no and non-TTY zero writes
for set/complete/remove; revision read before the prompt and stale-after-prompt
submission; completed-operation replay; the provider URL allowlist; truthful
per-command method counts; and the existing post-dispatch SIGINT ambiguity case
(one write).

Added in this attempt: an in-process pre-abort matrix proving `{read: 0,
write: 0}` with zero observed fixture requests for status, operation, and
diagnostics (exit 130); an undocumented platform reporting `{read: 0, write: 0}`
with zero requests; held-open stdin interrupted with SIGINT exiting 130
naturally with zero counts; an unreadable secret path with no path echo and zero
counts; nested and prototype-nested secret documents rejected identically;
doctor 405 fallback, malformed-readiness failure, and pre-aborted doctor at exit
130; and successful `auth remove` and `auth complete` with explicit LinkedIn
target flags asserting exact methods, counts, and request bodies. The tolerant
stdin helper now has a finite watchdog that kills a wedged child and reports
`timedOut: true`.

## 4. Remaining limits

* **Pre-dispatch read abort boundary.** The counter means dispatched attempts,
  not committed effects; no fixture distinguishes the millisecond boundary
  between a check and a dispatch.
* **Slow oversized stdin.** Oversize and SIGINT-while-held-open are covered; the
  ">64 KiB arriving slowly with the pipe open" variant relies on the watchdog
  rather than a dedicated natural-exit assertion.
* **`skill.contract` inventory failure.** The bundled Skill does not list the new
  commands; that is a separate Skill scope and the assertion was neither
  weakened nor deleted.
* No installed-artifact or full-product claim; local loopback readiness never
  proves a real account or a publish path. Node 22 is unavailable locally, so
  every number above is Node 24.19.0.

## 5. Routing note

Fixture work in attempt 2 was delegated to one child created with `spawn_agent`
using `agent_type: "router_opencode_go_deepseek_v4_1_flash"` and
`model: "opencode-go/deepseek-v4.1-flash"` (task
`/root/sdk_baseline_repairs/t7c1_cli_tests`); the tool returned
`{"task_name":"/root/sdk_baseline_repairs/t7c1_cli_tests"}`. Root interrupted
that child, and all of the above is owned and verified by T7c1.
