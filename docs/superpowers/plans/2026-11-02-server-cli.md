# Server CLI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with the user's exact-model delegation and attempt limits. Root owns architecture, security rulings and acceptance. No commits/pushes/deployments/releases during implementation.

**Goal:** Generate and operate a user-owned Cloudflare/Threads deployment repository through the shipped Syndroo CLI and skill.
**Architecture:** Separate server command context from existing local publishing runtime. Reuse packaged Worker and existing SDK Threads flows; concrete Node process/filesystem adapters orchestrate pinned Wrangler and optional GitHub CLI. User configuration stays distinct from automatically maintained deployment state and credentials.
**Tech Stack:** Existing TypeScript/Node >=24.19.0, Commander, SDK, installed jsonc-parser, Wrangler 4.132.0, Git/GitHub CLI.
**Spec:** ../specs/2026-11-02-server-cli-design.md

## Global Constraints

- Exact child model `opencode-go/deepseek-v4.1-flash`; max two active children, three attempts per subtask. No substitution.
- Sources read-only. Reuse current isolated clone; do not alter original checkout. Preserve existing untracked plan/spec files.
- No real Cloudflare/GitHub mutation, package publication or Threads post. Mock external effects; dry run only where safe.
- Secrets never in argv, logs, JSON results, tracked config or initial commits; no blanket git staging or shell interpolation.
- Existing local CLI behavior, Core protocol, auth restrictions and idempotency remain intact.
- New code/tests TypeScript with NodeNext .js imports. Keep generated user repo thin; lock exact package versions, ship required assets in CLI package.
- Credential storage uses private permission-protected files, not a claim of encryption; never replace existing encryption keys automatically.
- Code changes remain uncommitted until separately authorized. Existing project checkpoint replaces redundant skill bookkeeping.

## Review Focus

- Unrelated existing directories/remotes: refuse mutation and preserve all user content (Task 1 fixtures).
- Interrupted resource/secret operations: reconcile identity and preserve original keys before retry (Task 2 failure injection).
- Copied project on a new machine: missing credentials triggers explicit safe recovery, never rotation (Task 2 fixtures).
- OAuth/code or subprocess output in errors: redact secrets and emit one JSON envelope (Tasks 2/3 fixtures).
- Packed CLI installed outside source tree: templates, SDK imports and workflow runnable without workspace scripts (Task 4 smoke test).

## Task 1: Project foundation, init and server command boundary

Files: new packages/cli/src/server/{config,state,process,init,doctor,index}.ts as needed; packages/cli/src/main.ts, render/envelope.ts, package.json; new packages/cli/test/server-*.test.ts. Bundle helper changes only if dependencies require it. Templates embedded or shipped from CLI, never source-root file reads.

Interfaces: export registerServerCommands(program, io, globals, state) from server/index.ts or equally narrow attach function matching current parser. Server context uses CliIo directly. Export bounded config load/update with fields version:1, projectId UUID, scope default, optional publicOrigin, optional threads:{appId?,connectionId?}; strict unknown/duplicate rejection. Use --project directory scoped to server, cwd default, explicit Wrangler paths. A separate server result envelope uses operation:'server' and subcommand in result/details; local envelopes untouched.

- [x] Add failing tests: default init has no GitHub effects; explicit owner/repo private/public; collision/unrelated content; failed remote push preserves generated repo; rerun recognizes own init; malformed JSONC/duplicate/secret values; comment-preserving writes; server doesn't load local runtime; exactly one machine envelope.
- [x] Implement private generated manifest with exact current CLI/Worker/Wrangler pins, deterministic templates and .gitignore; install/lock generation via bounded safe runner with actionable package-unavailable failures. Explicit allowlisted initial commit, signoff per policy, no auto credential exposure. Separate external process boundary supports deterministic fixtures and timeout/output limits.
- [x] Implement basic read-only doctor for local config/tools/auth; remote readiness checks may be extended by Task 2. Attach available server subcommands; do not ship silent success placeholders.
- [x] Run focused CLI tests, typecheck, report exported interfaces, files and unresolved concerns. Root inspect changes before downstream work.

## Task 2: Deployment, state and credential recovery

Files: packages/cli/src/server/{deploy,state,process,doctor,index}.ts plus dedicated test files, config integration only after Task 1 owner finished.

Interfaces: consumes Task 1 config/state/process; deploy uses explicit account/Worker identity and server --project. Credential input through hidden TTY or narrowly documented stdin/environment; --json never prompts. Persist generated credentials privately before mutations. Secret stdin passed directly to process boundary, never included in diagnostics. --yes for explicit deploy invocation avoids interaction; it is not a blanket permission elsewhere.

- [x] Add failure-injection tests for create/upload/deploy/config-write, output redaction, permission/symlink checks, concurrent write lock, missing local keys for existing Worker, idempotent rerun and foreign same-name resources.
- [x] Implement verified identity selection and creation of missing D1/queues, using installed Wrangler/API contracts rather than guessed commands. Store account resource IDs privately/ignored; derive effective config from tracked configs. Preserve original project-relative bundle paths.
- [x] Support new Worker first-deploy secrets, origin resolution and final origin-configured deploy; existing Worker retains all secrets. Persist recovery metadata on ambiguous failures and don't auto-delete resources. Extend doctor to distinguish liveness, auth/resource presence and unverified publication.
- [x] Run focused mocks and isolated bundle/deploy dry run; report exact commands/contracts and gaps. No real account mutation.

## Task 3: Remote Threads connect, publish and GitHub CI

Files: packages/cli/src/server/{threads,github,index}.ts, reusable SDK helper location in CLI, scripts/lib/threads-ci.ts compatibility re-export or minimal shared extraction, dedicated tests. Maintain scripts test compilation and build boundaries.

Interfaces: connect threads consumes project config, securely obtains App Secret and admin credential, uses existing runThreadsBootstrap; persist returned connection. publish threads consumes project URL/connection, CI token, --input, --request-id, --yes; wraps existing runThreadsPublish preserving outcomes. ci setup github uses explicit owner/repo or verified origin, scoped Worker CI pair and GitHub environment.

- [x] Add tests for safe credential inputs/action_required, canonical callback, interrupted OAuth, persisted connection, lost publish reply/replay/no duplicate, manual-only CI, no admin upload, unrelated workflow conflict, partial CI setup recovery.
- [x] Reuse helper implementation rather than duplicate protocol; package SDK helper so outside-repo installed CLI works. Server publish defaults to scoped token only. CI pair must be set together; retain generated token across partial failure.
- [x] Create manual workflow invoking pinned installed CLI, stable publication identity and least permissions. CI setup reports local workflow changes without implicit commit/push; no real post or workflow dispatch.
- [x] Run focused CLI and original Threads script tests; review boundary behavior.

## Task 4: Shipped skill, docs and artifact acceptance

Files: packages/cli/skills/syndroo/SKILL.md and nearby references; packages/cli/README.md; docs/{cli-manual,agent-quickstart,threads-ci,remote-compatibility,testing,releasing}.md; root README/AGENTS only necessary scope alignment; package lock/build checks; disposable pack smoke fixture in scripts.

- [x] Update skill to ask GitHub preference/name/visibility, orchestrate exact implemented commands, preserve prior user authorization, guide browser actions and stop safely on missing recovery material.
- [x] Align help/examples/JSON/exit codes, secret storage limitations and manual publishing docs; document generated rather than user-maintained files. Existing local skill stays usable.
- [x] Build all packages; install packed CLI/Worker into disposable external directory and initialize/test generated repo with no source dependency. Check tarball contents/version pins/lockfile/workflow command and isolated Wrangler dry run.
- [x] Run npm test, npm run check, npm run test:scripts sequentially after build; git diff --check; inspect final diff. No repeated broad tests without new changes/failure.
- [ ] Exact-model final review requirement not met: review completed, but resumed child turn_context records show gpt-6-astra. Technical root acceptance complete; routing deviation disclosed, not silently treated as compliant.

## Execution

User explicitly approved design and development with exact-model delegation. Continue through tasks without another plan approval. Tasks 1–3 share interfaces and run sequentially; read-only root inspection and later docs may overlap only with disjoint ownership. Reuse same child for fixes, max three attempts. Record child IDs, attempt counters, acceptance and unresolved issues in scratch/server-cli-progress-20261102.md.

## Final acceptance — 2026-11-02

Technical gates passed: full build, check, npm test (11 packages), test:scripts (185/185), focused recovery/concurrency checks, packed external init/install and Wrangler dry run, diff check. No production deployment, GitHub mutation, real OAuth/post, npm release, product commit or push. Official skill validator unavailable (PyYAML missing); equivalent frontmatter/link checks passed.

Routing audit: initial child turns explicitly record opencode-go/deepseek-v4.1-flash; resumed turns record gpt-6-astra. This violates the requested fixed delegation route; prior assertions of exact routing across resumed work were incorrect. All children closed. No claim of full model-route compliance.
