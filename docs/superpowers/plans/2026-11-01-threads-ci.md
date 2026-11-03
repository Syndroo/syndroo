# Threads CI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User requires native `opencode-go/deepseek-v4.1-flash`, at most two active agents, three execution attempts per subtask. Root reviews and executes acceptance checks. No commits or remote writes.

**Goal:** Connect Threads through Worker OAuth and publish from CI with durable results.
**Architecture:** Existing shared OAuth adapter becomes portable and async. Worker uses D1 attempt records and existing encrypted Core state; client scripts use existing SDK. CI gets one limited connection credential.
**Tech Stack:** TypeScript, Web Crypto, D1, Cloudflare Queues, existing SDK/Vitest.
**Spec:** `docs/superpowers/specs/2026-11-01-threads-ci-design.md`

## Global constraints

- Node >=24.19.0; preserve protocol v1, existing providers and original checkout.
- No new runtime dependencies; Worker bundle contains no `node:` imports.
- Secrets only in protected input/encrypted storage, never argv/output/fixtures with real values.
- Mock provider traffic; no deployment, GitHub dispatch, SNS publication, push, or commit.
- At most two workers; writers have disjoint file scope. Reuse existing child for fixes.
- Every report lists changed files, test commands/counts/outcomes and unresolved issues.

## Review focus

- Credentials-step resume opens OAuth after start returned credential_input: record original persisted state.
- Replayed connect start returns old URL: no replacement state/expiry or duplicate registration.
- Concurrent callback claim and acknowledgement loss: at most one accepted callback; fail closed if uncertain.
- CI supplies another connection or admin token's approval: reject before provider writes.
- HTTP/SDK success with failed/partial/unknown execution: CI must fail, with no blind republish.

### A — Portable OAuth and Worker integration

**Allowed files:** packages/server/src/oauth/**; packages/server/src/compose/self-hosted.ts; packages/server/src/http/index.ts; packages/server/src/state/database.ts only for narrow attempt-store adaptation; packages/server/test/oauth/**; packages/cloudflare/src/oauth/** (new); packages/cloudflare/src/state/schema.ts; packages/cloudflare/src/state/database.ts; packages/cloudflare/src/worker.ts; packages/cloudflare/test/oauth*.test.ts (new); packages/cloudflare/test/worker.test.ts. No other scope without root review.

**Consumes:** existing OAuthCallbackAdapter, CredentialStore, StateStore.acceptCallback and Threads provider protocol. **Produces:** portable adapter with awaitable attempt operations; D1-backed attempt store; optional PUBLIC_ORIGIN Threads callback integration.

- [x] Add focused failing tests for Worker Threads full connect flow, credential resume, start replay, forged callback, expired/wrong state, wrong provider/revision, duplicate params and concurrent single-use acceptance.
- [x] Port existing adapter to Web Crypto and structural attempt-store operations; await persistence and claim results. Preserve Node call sites and constant redacted responses. Fix recording for credential resume and Core replay; do not trust unverified state/redirect from arbitrary URLs.
- [x] Add scoped D1 OAuth attempt table/store with atomic conditional claim and safe replay behavior; do not introduce a generic repository abstraction.
- [x] Wire PUBLIC_ORIGIN, OAuth provider context, connect wrapping and callback handler. Existing deployments without origin keep behavior. Wrong auth does not initialize storage; malformed callback does not create schema.
- [x] Execute server OAuth, Worker, D1 and Threads focused tests; run package typechecks. Report commands and exact results; root runs broader checks after integration.

### B — Bootstrap and publishing clients (independent from A)

**Allowed files:** scripts/threads-connect.ts; scripts/threads-publish.ts; scripts/lib/threads-ci.ts; scripts/threads-ci.spec.ts; docs/threads-ci.md; examples/threads-ci/post.json; examples/threads-ci/workflow.yml. No root manifests, runtime packages or generated artifacts.

**Consumes:** existing SDK connect/publish/status/wait protocol; PUBLIC_ORIGIN callback contract and environment names from spec. **Produces:** TypeScript executable scripts, explicit workflow template and offline behavioral tests.

- [x] Write failing fixtures using fake HTTP/SDK transport for bootstrap and publication outcomes. No real API calls.
- [x] Bootstrap reads admin/app credentials from env, starts Threads connect with generated redirect URI, handles credential-input resume, prints only safe authorization instructions, resumes callback_complete with bounded polling, and outputs connection ID when done. Repeated action_required is not success. Handle cancellation/expiry clearly.
- [x] Publication reads strict text JSON, requires explicit --yes and caller stable --request-id, selects exact connection, prepares once, executes same approval, handles replayed execution and waits. Exit 0 only for succeeded; preserve operation ID on timeout/unknown, never print tokens.
- [x] Workflow template uses manual workflow_dispatch, repository/content revision/connection-derived stable ID, protected secrets and existing SDK build. Pin existing repository action SHAs; do not invent unavailable published Action/package versions. It must not include an admin credential.
- [x] Guide covers build/bootstrap, exact callback registration, CI credential setup, terminal-result behavior, rerun safety, current token-refresh limit and deployment prerequisites. Explain initial version is not live-validated.
- [x] Execute client fixture tests and scripts typecheck; report changed files, exact commands/results and concerns.

### C — Limit CI credentials (after A, same Worker file owner)

**Allowed files:** packages/cloudflare/src/worker.ts; packages/cloudflare/src/auth.ts (new if helpful); packages/cloudflare/test/ci-auth.test.ts; packages/cloudflare/test/worker.test.ts; narrow packages/server/src/http/handler.ts portable error recognition and adjacent HTTP tests. **Consumes:** existing shared HTTP handler and Core principal binding. **Produces:** optional CI_BEARER/CI_CONNECTION_ID pair, connection-bound threads-ci:<connectionId> principal and restricted Core facade.

- [x] Test admin and CI keys, missing/partial pair, identical keys, wrong credentials, forbidden connect/status variants, different target/provider, cross-principal approval and operation access.
- [x] Select role with secure token comparison. CI prepare/retry requires exactly one target with provider threads and explicit configured connection; execute uses Core approval ownership. Allow only operation status for CI. Keep admin semantics unchanged.
- [x] Run focused security tests and Worker typechecks. Root inspects credential handling before acceptance.

### D — Root integration and acceptance

- [x] Review each diff against spec; corrections return to same child with remaining attempt budget.
- [x] Update wrangler/example binding documentation for optional PUBLIC_ORIGIN and CI key/connection pair; reconcile bootstrap guide with actual names. Root may delegate these finishing edits.
- [x] Build changed packages in dependency order, then run npm test, npm run check, npm run check:provider-catalog, scripts checks/tests and git diff --check.
- [x] Run fresh Worker bundle dry-run without live credentials or remote mutations. Do not read/use real SNS credentials merely to test.
- [x] Inspect final changes and report verified local behavior separately from live blockers. Deployment requires renewed Cloudflare login and concrete account/app/content selection.

## Acceptance record

Local implementation accepted by root on 2026-11-01. Build/check/test gates passed for all eleven packages; script tests passed 185/185; catalog, script types, diff whitespace and Wrangler dry-run passed. Full package tests included local HTTP socket fixtures. Built Worker denied CI overview with 403 and zero storage access. User already has a Threads App and deferred account connection; deployment and live publication were not performed. Automatic token refresh remains outside this slice. See the project scratch checkpoint for attempt history and verification scheduling details.
