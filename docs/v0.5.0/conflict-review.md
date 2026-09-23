# 0.5.0 implementation conflict review

Reviewed 2026-09-23 against clean `main@d8206f298333eeb83d45d319ea244bbda72c78f7`. The user's current request authorizes local implementation of revision2. The copied [design](design/00-README.md) remains an immutable historical input: statements about that earlier design-only session, model cancellation, and approval are not instructions for this implementation.

## Decisions before implementation

| Existing behavior or ambiguity | Decision for 0.5.0 |
| --- | --- |
| AGENTS requires Worker-local business logic and explicit publisher switch | Adopt private application/transport and typed static composition per revision2. Retain one concrete D1Repository; no generic repository, runtime plugin system or DI framework. |
| AGENTS/README describe 15-minute Cron and Worker-only public package | Update to one-minute bounded dispatcher and SDK/CLI/Worker release train when implemented. |
| Env-only admission vs D1-aware execution/status | One resolver; complete user-credential group selected from one source, no fallback from corrupt/expired D1. |
| Callback directly activates credentials; state SELECT/DELETE; refresh lacks lease | Candidate/complete workflow, canonical callback origin, atomic state claim, revision and persistent refresh lease. |
| Claim precedes preparation; writes have no fence | Prepare first; current-job/revision CAS claim; token-fenced outcome transaction. |
| Publication doubles as outbox; retry uses Queue delay | Dedicated outbox_jobs, versioned ID-only envelopes, future business retry jobs; Queue retry only for infrastructure. |
| Plaintext credentials and no archive boundary | AES-256-GCM envelopes, separate binding key, private bounded archive; explicit migration tool and cutover instructions. |
| X/Tumblr/LinkedIn redirect:error and corresponding tests | Shared manual-redirect transport with native workerd coverage; no provider write retries. |
| SDK response parser drops context; wait unrefs timer | Preserve requestMayHaveBeenApplied throughout, referenced live timer; remove CLI keepalive only after subprocess evidence. |
| SDK-01 abbreviates mayHaveBeenApplied | Existing public field remains requestMayHaveBeenApplied. Do not introduce a second field. |
| Future current job reaches DLQ | Atomically record dlq_seen/early_dead_letter, preserve available_at and scheduled state before due. No auto-rearm or provider call after DLQ. At due, maintenance settles dead_lettered under current-job/no-claim guards. Diagnostics expose transport failure meanwhile. This applies the existing due guard without silently losing the future transition. |
| Post scheduledAt vs outbox availableAt | Post keeps immutable original user intent. Initial availableAt reflects that time; retry availableAt reflects application retry policy. No attempt to keep the two equal after retry. Legacy backfill takes max(schedule,retry,cutover). |
| Outbox lacks completed status | Keep pending/dispatched/cancelled. Consumed, superseded, or terminal jobs become cancelled (transport intent no longer needed); publication remains the outcome authority. Never GC active/unresolved/unknown-associated jobs. |
| 20 jobs vs statement budget | Twenty is a maximum, not a guaranteed batch size. Adapter measures statement cost and reserves maintenance budget within configured limit. |
| Public versions differ | Prepare all three as 0.5.0-rc.1 after integration; exact CLI SDK dependency. No registry publication. |

No unresolved product decision prevents local implementation. Runtime/test compatibility remains unverified at review time. Existing code differences above are required migrations, not reasons to reduce scope.

## Documentation ownership and acceptance

Root owns docs/v0.5.0/conflict-review.md, implementation-plan.md and the acceptance ledger. Subtasks may write only named evidence/report files. Integration owns README, docs/testing.md, release notes and cutover runbook in one serial task. Input files under docs/v0.5.0/design/ are retained byte-for-byte, including original sources. No edits to synced project sources/ or Downloads input.

Acceptance retains all 120 IDs (118 local, 2 live separately authorized). docs/ delivery adds an explicit review checklist without weakening any gate. Current source baseline and historical references matched; current original checkout is clean, so the historical CLI dirty deletion is no longer present. No live SNS, deployment, production migration, remote resource mutation, commit, push or package publication is authorized.

Both read-only audits used actual native spawn calls with explicit opencode-go/deepseek-v4.1-flash routing. Root reviewed their findings against main design, ADRs, contracts, repository rules and current source. Audits did not run product tests. Baseline npm run build passed on Node 26.7.0/npm 11.19.0; Node 22/24 and Worker suites remain separate checks.
