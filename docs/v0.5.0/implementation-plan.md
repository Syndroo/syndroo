# Syndroo 0.5.0 Implementation Plan

**Goal:** Implement revision2 reliability, authorization and portable execution in the existing monorepo, with current evidence for every required local acceptance gate.

**Architecture:** Private application owns semantic ports and use cases. Existing platform adapters own typed provider behavior and private transport; Cloudflare composition supplies one D1Repository, Queue, R2 and WebCrypto adapters. Public SDK/CLI stay independent of private runtime packages.

**Tech stack:** Existing TypeScript/NodeNext npm workspaces, Vitest, workerd/Miniflare, D1/SQL, WebCrypto, R2 and Cloudflare Queues. No new production database, UI, provider or media API.

**Spec:** [Main design](design/01-DESIGN.md), [contracts](design/07-CONTRACTS-AND-FAILURE-MATRIX.md), [acceptance](design/03-ACCEPTANCE.md), [review decisions](conflict-review.md).

## Global constraints

- Worktree branch codex/v0.5.0 from d8206f2; original checkout preserved.
- Local-only, synthetic credentials, isolated storage and outbound fixtures. Never read real .env/.dev.vars. No commit/push/deploy/publish/live SNS.
- Native DeepSeek route for bounded implementation/debugging; root Astra owns decisions and final acceptance. At most two active children, disjoint ownership, at most three attempts per subtask; no fallback.
- Preserve /v1/posts, Post/Publication IDs, public status enums, stable idempotency keys, 64KiB input limit and three total Publisher attempts.
- Unknown remote outcomes never automatically resend. Migration never grants authorization or resets attempt budget.
- No edit to applied migrations 0001–0005 or copied design input. Append 0006 for 0.5 schema unless root records a further migration assignment.
- Public target 0.5.0-rc.1 for SDK/CLI/Worker; all other packages remain private. No claim of full release until acceptance is complete.
- Root owns progress in project scratch/v050-implementation-progress.md. Product docs and evidence live in docs/v0.5.0/.

## Review focus

1. Zero-row CAS must leave all related rows unchanged, including create, retry and activation; test real D1 plus rollback-capable fake.
2. Claim response loss and provider result persistence failure must never issue a second provider request; record actual calls.
3. Expired refresh leases cannot authorize reusing a rotated token; direct set/delete defeats late refresh.
4. Slow body and hanging stream cancellation must terminate within deadline without exposing raw secrets.
5. Early/old messages, future DLQ and late dispatch marks must preserve due time and current-job fences.

## Task 0: Baseline and verification environment

**Ownership:** Worker test configuration/setup only, dedicated local fixture files, docs/v0.5.0/evidence/baseline.md. No product source changes.

- [ ] Reproduce the known Worker-suite stall with a bounded parent watchdog and fixed fake bindings; record runtime versions and last reached boundary.
- [ ] Change one demonstrated cause at a time. Preserve real workerd/D1 testing and all existing assertions; no deletion of suites or indefinite timeout increases.
- [ ] Execute one focused Worker test and the full Worker suite. If blocked by environment, record exact failure rather than treating it as product failure.
- [ ] Check Node 22/24 availability and run the supported matrix where obtainable without account changes. Report any unavailable runtime.

Run from repository root: `npm run build`, then `npm test --workspace @syndroo/cloudflare-worker -- --reporter=verbose`; bound the process externally to detect a stall. Intended outcome: finite, interpretable test completion.

## Task 1: Portable contracts and atomic fake

**Ownership:** packages/application/** only. Root separately coordinates core/root manifest integration.

**Produces:** Exported complete types for PublishingStore, CredentialStore, OutboxStore, JobQueue, ArchiveStore, BlobStore, CredentialCipher, Logger and DiagnosticsReader, with signatures/semantics from contracts §3; versioned envelope, encrypted snapshot, binding snapshot, operation and semantic transaction inputs/results. No Cloudflare or concrete provider imports.

- [x] Add dependency-negative fixtures and fake-contract tests first.
- [x] Implement interfaces and a rollback-capable fake using staged state replacement; conflict outcomes must preserve original snapshots.
- [x] Test create all-or-nothing, concurrent claims, same-input commit replay, atomic safe retry, activation replay and lease fencing.
- [x] Build/check/test application independently without Worker ambient types. Root reviewed and froze exported contracts after three implementation attempts: Node24 check/build/test65 passed; shared fake report49/49. Actual D1/Queue/R2 validation remains separate.

Representative invariant:

```ts
const before = fake.snapshot();
expect(await fake.createPostWithDispatch(staleRevisionInput)).toMatchObject({ kind: "conflict" });
expect(fake.snapshot()).toEqual(before);
```

## Task 2: Transport and provider behavior

**Ownership:** packages/transport/** and five provider packages; no Worker/application/SDK source edits.

**Produces:** Bounded manual-redirect request helper and strict OAuth1 signing; typed per-provider credential decoding/construction, safe provider errors/diagnostics. OAuth caller wiring consumes these later.

- [ ] Add failures for all redirect codes, body overflow, slow body, aborted requests and hanging cancel. Provider writes must remain exactly once per attempt.
- [ ] Implement zero-retry transport deadline covering headers/body; preserve platform-specific success and ambiguity decisions.
- [ ] Migrate all five adapters, keeping pure construction and configured official SDK write retries disabled.
- [ ] Run provider tests, type-negative credential fixtures and isolated native-workerd outbound fixtures. No live host traffic.

## Task 3: D1 semantic transactions and schema

**Ownership:** Worker repository.ts / infrastructure/d1/**, migrations/0006_v050.sql and dedicated D1 contract tests. No runtime handler edits.

**Consumes:** Frozen application ports. **Produces:** One D1Repository implementing them; existing public read projection preserved.

- [ ] Run shared contract assertions against local D1, starting with zero-row conflict and injected SQL rollback.
- [ ] Append schema: publication binding/claim/attempt/current-job/terminal/archive fields; credential revision/tombstone/payload revision/envelope/refresh; OAuth operations; indexed outbox_jobs.
- [ ] Implement guarded create/claim/outcome/retry/activation/refresh transactions with idempotent commit replay. Never interpret post-commit zero-row detection as rollback.
- [ ] Implement due/recovery/cleanup/diagnostics reads and collect actual statement/row metrics with representative data and EXPLAIN QUERY PLAN.
- [ ] Fresh/legacy migrations preserve old IDs/content/keys and never create executable publishing/unknown records.

## Task 4: Cipher, archive and blob adapters

**Ownership:** Worker infrastructure/crypto/**, infrastructure/r2/** and dedicated tests.

**Consumes:** Frozen cipher/blob/archive contracts. **Produces:** AES-256-GCM envelopes and independent private R2 adapters.

- [ ] Test random IVs, wrong key/purpose/record/platform/payload revision and corrupted tag; fail closed with safe errors.
- [ ] Implement fixed AAD tuple and strict base64 32-byte key/keyId validation; no key derivation from API key.
- [ ] Implement logical-key validation, allowed diagnostic schema, 64KiB archive bound, expiry and private bucket mapping. Test independent blob put/get/delete/exists.
- [ ] Verify actual local R2 operations and workerd/Node cipher interoperability; report production bucket ACL as deployment-time validation.

## Task 5: Publishing, dispatcher, Queue and DLQ

**Ownership:** Application create/execute/retry/dispatcher modules and Worker posts/publishing/jobs plus queue adapters, with named tests. Runtime composition ownership serially coordinated with Task 6.

**Consumes:** Frozen stores, credential preparation strategy, cipher/archive/queue. **Produces:** createPost, executePublication, dispatchReadyJobs and settleDeadLetter use cases with thin runtime mapping.

- [ ] Test idempotent replay before current credential checks; preserve 200 replay / 202 new acceptance.
- [ ] Prepare before claim; guard job/entity/attempt/revision/due time; freeze publisher snapshot.
- [ ] Separate provider invocation from outcome persistence and best-effort archive. Known result commit replay never invokes publisher again.
- [ ] Safe retries persist future jobs atomically (60/120s or later valid Retry-After); return settled for old message.
- [ ] Strict versioned envelopes <=2KiB; malformed messages use bounded infrastructure retry/DLQ. Early messages rearm same future job; old messages cannot execute a newer attempt.
- [ ] Verify duplicate/concurrent consumers, late results, early/future DLQ, archive failure and lost dispatch acknowledgements with actual provider call counts.

## Task 6: Unified credentials and auth lifecycle

**Ownership:** Application credential/auth modules; Worker composition/platform-descriptors/publishers/auth/API wiring and dedicated auth tests. Root serializes overlapping composition/API changes.

- [ ] Share one pure resolver among status/admission/execution; separate direct-user decoder from final app+user typed credential assembly.
- [ ] Bind connections with separate HMAC key; D1 complete credential groups, tombstones and payload revision independent of slot revision.
- [ ] Implement direct set/remove CAS, canonical URL, authenticated POST connect and legacy GET bridge; exact public callback only.
- [ ] Atomically claim state, encrypt request secret/candidate, save safe phase; complete requires explicit target and observed revision and replays stored receipt.
- [ ] Persistent refresh lease before network, one exchange; preserve target/binding, strict expiry parsing, unknown result => reconnect_required.
- [ ] Execute real local D1 concurrency, spoofed callback/host/input, secret sentinel and candidate expiry tests.

## Task 7: SDK, CLI and Skill

**Ownership:** packages/sdk/** and packages/cli/**; root handles versions/lockfile. Starts after public auth DTO contract is frozen.

- [x] Fix malformed successful responses and live wait timer through public API/subprocess regression tests. Root Node24 build/check/full SDK114 passed; SDK-01/03/04 recorded with current evidence. Auth and installed-artifact gates remain open.
- [x] Add typed auth status/set/connect/operation/complete/refresh/remove and read-only diagnostics; no private dependencies or automatic write retry. Root accepted the facade after the second attempt: Node24 check/build and 240 SDK tests passed. Installed-artifact and isolated Worker calls remain separate gates.
- [ ] Add matching CLI commands using existing Reporter/confirmation. Secrets only bounded stdin/file/controlled input, never argv values; set/complete/remove require confirmation and observed revision.
- [ ] Remove CLI keepalive after SDK independent-process pass; every --json output exactly one object, diagnostics on stderr.
- [ ] Update shipped Skill for auth phases, secret handling, target confirmation and ambiguity; run hostile text and command-contract fixtures.
- [ ] Test installed SDK/CLI tarballs outside monorepo, TTY and non-TTY, cancellation and secret scans.

## Task 8: Maintenance, diagnostics and cutover tooling

**Ownership:** Application maintenance/diagnostics, Worker scheduler/diagnostic adapter, isolated migration tooling and docs/v0.5.0/cutover.md. Coordinate repository additions with Task 3 owner; no parallel writes.

- [ ] Every-minute dispatcher bounded by actual statements and at most 20 jobs. Stalled unclaimed current job: 30-minute wait, at most three recoveries, then dead_lettered.
- [ ] Stale claims after 15 minutes => unknown; never automatic resend. DLQ seen blocks rearm and due future-DLQ settlement follows review ruling.
- [ ] Read-only authenticated diagnostics; unknown size => null/reason/observedAt. GC excludes active/unknown/domain/idempotency records.
- [ ] Build explicit report/dry-run/apply local migration tooling: encrypt+CAS+clear legacy plaintext, invalidate old OAuth safely, backfill one eligible job with preserved attempt budget; explicit legacy binding review only when attempts=0 and not ambiguous.
- [ ] Disposable upgrade rehearsal and runbook: stop old consumers/Cron, versioned Queue/DLQ, in-flight review, backup, verify; no purge or automatic old-worker rollback.

## Task 9: Integration, packaging and documentation

**Ownership:** Root manifests/lockfile, core additions if needed, Wrangler/resources/generated types, scripts/e2e/CI, three public versions, README/AGENTS/CHANGELOG and remaining docs. Assigned serially after dependency contracts stabilize.

- [ ] Wire build order/application/transport workspace dependencies; private packages bundled, never required from registry by public consumers.
- [ ] Configure versioned queue+DLQ, one-minute Cron, separate secrets/public URL/private archive bucket and optional media bucket in source/templates only.
- [ ] Align public package versions at 0.5.0-rc.1 and exact CLI SDK dependency; review release scripts in local fake-registry mode only.
- [ ] Run full test/check/bundle/startup/build:package, local E2E, external tarball consumers, package verification and offline release train; inspect every exit result.
- [ ] Record each acceptance ID with actual command/runtime/result/source tree evidence. Preserve failures/unrun items and live restrictions.
- [ ] Update docs/testing.md, release/cutover/usage docs, AGENTS architecture rules and main docs index to match delivered behavior.
- [ ] Root final diff review and git diff --check; verify input copies unchanged and original checkout untouched.

## Remaining runtime slices

T6d1 and T6d2 are accepted after their first attempts (root16 and29native tests, scoped/config typechecks). T5c is accepted after attempt2 (root19native tests and scoped source/test/config check). T9a is accepted after attempt2 (root8projects/404tests and failure-propagation fixture), with a main-suite teardown exception retained for T0 diagnosis. The first T8b1 scheduled-deadline attempt and T0 diagnostic attempt2 are active. Other runtime slices remain unstarted. They separate new composition work from the exhausted adapter corrections; none grants another adapter attempt.

| Slice | Ownership | Acceptance boundary |
| --- | --- | --- |
| T6d1 lazy dependencies | New composition/runtime-dependencies module, dedicated native tests and evidence | Copy configuration once; lazy read/write ciphers and publishing signer; fixed readiness names; construction, removal and replay without keys; selected corrupt slot never falls back. Uses current adapters without changing or accepting T4. |
| T6d2 inbound HTTP body | Existing http.ts reader plus dedicated tests/evidence | 64KiB copied chunks, total deadline and abort, nonblocking disposal, strict UTF-8/JSON/media type, optional empty legacy body; fixed safe errors. Separate from exhausted outgoing T2 transport. |
| T5c runtime queue mapping | New composition/queue-consumer.ts and dedicated queue/DLQ tests | Exact physical queue selection; accepted usecases; ack/retry mapping; fixed quarantine-before-ack; no provider call in DLQ. Preserve legacy jobs/index until coordinated cutover; module acceptance is not deployed-entrypoint acceptance. Composition dependencies must be reviewed first. |
| T6d3 HTTP route cutover | auth.ts, api.ts, posts.ts, publishers.ts, index.ts and native route tests | Compose accepted use cases and one semantic repository; exact callback exemption; guarded auth and replay precedence; preserve posts projection. Blocked on T3 public list/get convergence. |
| T8b1 scheduled deadline (accepted portable-runtime boundary) | New composition/scheduled-maintenance module and own dedicated tests/evidence | Twenty-second total deadline around accepted maintenance; explicit profile limits, latched stop, bounded wrapper, observed late completion and no later sends. Legacy entrypoint, diagnostics and measured D1 profile remain separate. |
| T8b scheduled/diagnostics wiring | scheduler.ts, diagnostic HTTP composition and focused tests | Use reviewed maintenance report, fixed runtime deadline and measured D1 limits. Production profile remains blocked on T3 measurement. |
| T9a test isolation and watchdog | Worker test configurations, runner/support/own tests, Worker test script, evidence | Apply test-isolation.md: synthetic local bindings, fail-closed outbound, exact complete discovery, aggregate failure propagation and finite process cleanup. No adapter or application test repair through this scope. |

A slice owns only its named files. Application index updates have one separately coordinated owner. Tests must distinguish isolated composition proof from unresolved real-adapter behavior. No route cutover may silently keep the legacy mutation repository to sidestep T3.

## Dependency and ownership review

### Packaging metadata slice (T9b, accepted after attempt1)

Own root package.json/package-lock.json and the SDK, CLI and Worker manifests only. Add private application/transport to the root build/test sequence in dependency order and to the Worker's development dependencies, preserving its accepted test scripts. Align the three public versions at0.5.0-rc.1 with an exact CLI-to-SDK dependency; keep private package versions unchanged. Update lockfile metadata offline with lifecycle scripts disabled and verify that no third-party dependency version changed. No provider, SDK/CLI command or runtime source repair is part of this slice. Verify current workspace resolution, root build, manifest constraints and local fake-registry release checks; report any pre-existing/frozen-scope failures without repairing them. Full bundling, installed artifacts and release acceptance remain after coordinated runtime integration. Do not run a live registry publish, production deployment, automatic migration or credential-loading Wrangler command to verify metadata.

Execution may split Tasks 5–7 into dependency-ordered subscopes before starting them: portable publishing use cases; unified credential preparation/direct credentials; runtime publishing/Queue wiring; OAuth lifecycle; SDK; CLI/Skill. This preserves the original acceptance scope and gives each implementation owner disjoint files and its own bounded initial assignment. It does not reset an already-started or rejected subtask's attempt count.

Accepted Task 5 slices are T5a create/dispatch, T5b1 execute/policy/archive, and T5b2 standalone DLQ consumption plus the narrow Queue adapter. Runtime posts/main-queue/DLQ wiring remains pending. The standalone DLQ path calls the store's semantic settlement transaction, never preparation, claim or provider. Unlike the main consumer, an invalid DLQ envelope returns a usecase-local `quarantined` outcome: fixed alert metadata, zero domain reads/writes, no echo of malformed input and no forwarding back to the queue. Runtime must record the fixed quarantine event before acknowledging; portable acceptance does not claim durable operational alert delivery. Valid settlement is acknowledged only after authoritative metadata succeeds; metadata failures use bounded DLQ runtime retry. The frozen shared ConsumerOutcome is unchanged. Any DLQ archive is a separate diagnostic category and must not overwrite a provider attempt's archive status. Real D1 and runtime tests remain necessary after portable proof.

Accepted Task 6 slices are static platform strategies/direct decoding, portable preparation/direct set/remove, portable connect/callback/operation reads, candidate completion, and refresh. Root independently passed Node24 application check/build and 300 tests after refresh, plus eleven malformed acquired-lease probes that all rejected before provider calls or commits. Concrete OAuth drivers are accepted with root33 native tests and scoped type checks. Runtime routes and actual-D1 lifecycle evidence remain pending. Task 7's SDK facade and shipped Skill are accepted; root independently passed CLI check/build and159tests after the Skill's third delivery. CLI command implementation has exhausted three attempts and remains unaccepted for specific missing boundary evidence. Static Skill checks do not resolve those command gaps or prove model adherence; installed artifacts follow later. Portable bounded maintenance is accepted after its first attempt: root Node24 check/build and313 application tests, plus cap20/frozen-report/predicate-snapshot probes. Real D1 limits and scheduler wiring remain open. Acceptance details and limitations are recorded in evidence/root-review.md. T2, T3, T4 and T7c1 exhausted their initial three attempts and remain unaccepted; their documented corrections need a revised attempt budget before execution.

Publishing use cases consume an injected asynchronous preparation function returning the frozen `PublisherPreparation`, plus the existing `BindingSigner`; they do not duplicate decryption or platform configuration rules. The eventual unified resolver supplies that function to admission and execution and supplies the same status to auth reads. Only one owner may edit `packages/application/src/index.ts` at a time; new modules can be tested through relative source imports until their coordinated export update.

Composition must permit authenticated reads, idempotent replay and credential deletion when publishing configuration is unavailable. It cannot eagerly reject construction before a create request has checked its idempotency record. Key/configuration readiness is enforced before new admission, encryption and provider execution; an existing receipt may be read without rebuilding a Publisher. The delete path needs slot CAS, not decryption.

| Pair | Shared contract/file | Coordination |
| --- | --- | --- |
| T0/T1 | none | Parallel allowed; test config vs new application package. |
| T1/T3/T4/T5/T6 | ports and transaction DTOs | T1 sole writer; freeze before consumers; later changes via same owner/root review. |
| T2/T6 | typed provider/OAuth strategies | T2 exports; T6 consumes, no parallel provider edits. |
| T3/T5/T6/T8 | persistence behavior | T3 sole D1/migration writer; requests queued to owner. |
| T5/T6/T8 | composition/API/runtime entry | Serial wiring ownership, no concurrent edits. |
| T6/T7 | public auth/diagnostic DTOs | Freeze before SDK implementation; no private package dependency. |
| T1/T2/T9 | root manifest/lockfile | T9 designated sole writer for shared integration. |
| All | docs/evidence | Each named evidence file disjoint; root main docs/ledger. |

Each task includes executable verification relevant to its requirements; T0 environment failures do not justify weakening later tests. Root reviews exported interfaces and actual diffs before accepting task output. No local PASS is inferred from the reference documents or historical results.
