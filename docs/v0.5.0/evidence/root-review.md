# 实施阶段独立复核

根代理负责验收；子代理报告本身不构成验收。以下记录对应各轮返回时的源码，后续修改须重新检查。当前没有完成 0.5.0 产品验收。

## 已复跑证据

运行时：Node 24.19.0，Vitest 4.1.11。本地 workerd 测试使用隔离存储及合成凭据；需要本机监听权限，不访问生产资源。

| 范围 | 复核命令 | 结果 | 验收状态 |
| --- | --- | --- | --- |
| T1 application 第 3 轮 | workspace check、build、test；共享场景报告 | 65 tests；49/49 shared scenarios；exit 0 | 接口与事务 fake 已验收；不是生产存储证据 |
| T2 第 3 轮：core、transport、五个平台 | 各 workspace 的 build、check、test | 261 tests；所有命令 exit 0 | 两项遗留问题，未整体验收 |
| T2 原生请求 | transport 内 `vitest run --config vitest.workerd.config.ts` | 11 tests；exit 0 | 包括五个平台成功路径、禁止重定向、流边界 |
| T2 原生测试类型 | transport 内 `tsc -p tsconfig.workerd.json --noEmit` | exit 1，TS5097 | `.ts` 导入与配置不匹配 |
| T3 第 1 轮 | Worker 内 `vitest run test/d1-v050-contracts.spec.ts test/d1-v050-faults.spec.ts` | 7 tests，内含 49 共享场景；exit 0 | 发现并发与错误边界缺口，第 2 轮修正中 |
| T4 第 1 轮 | Worker 内 `vitest run --config test/storage-v050.vitest.config.ts` | 55 tests；exit 0 | 跨运行时证据等未齐，第 2 轮修正中 |
| Worker 测试类型（T3/T4 第 1 轮） | `tsc -p test/tsconfig.json --noEmit` | exit 1 | 既有 LinkedIn Env 两项错误；D1 只读 metrics 赋值；crypto 非法版本测试断言 |

新增已接受的应用层范围：T5a 第 2 轮，根代理 Node24 实际执行 application check 和 test（含 build），11 files / 99 tests，全部 exit 0。源码核对了幂等重放顺序、凭据围栏、未来调度、积压与丢失 dispatch mark 的延期报告、固定安全错误及实例就绪分类。仅证明 portable create/dispatcher 与事务 fake；Worker/D1/Queue 集成仍需单独验收。

## 尚未接受的结果

T2 的 `parseRetryAfter("Tue, 31 Feb 2026 12:00:00 GMT", {now: new Date("2026-02-28T00:00:00.000Z")})` 返回 `2026-03-01T00:00:00.000Z`。不存在的日期应被忽略，当前可能造成错误延迟。T2 已用满项目规定的三轮，额外修正预算正等待用户决定，未执行第四轮。

T2 子代理确认：原生 TypeScript 检查的成功记录来自旧版 `.js` 导入文件；改成 `.ts` 导入后只复跑了 Vitest。因此 [transport.md](transport.md) 中原生 check=0 的记录不适用于当前源码；其中旧签名值和旧连接拒绝说明也待修正。以本记录中的独立结果为准。

继续对照主契约发现：transport 的 Retry-After 将合法长等待截为 24 小时，与基础设施契约 §6「不得把合法的较晚 Retry-After 截短成更早发送」冲突。此前根代理认可该上限属于审查失误；需要在获准的日期修正轮一并纠正，不能通过改写设计掩盖。规范化结果必须保留可表示的合法等待；超出明确表示范围须受控处理，不能整数溢出。该项目前是源码/设计复核发现，尚未新增运行证据。

T3 第 1 轮未覆盖提交成功但回执丢失、真实旧库迁移和完整语句计数。复核还发现原始数据库错误透出、损坏/未迁移凭据被当成空槽、刷新领取后读到后续租约、旧 DLQ 影响新尝试等问题。已按原范围交回原子代理修正。

T4 第 1 轮的 `node:crypto` 检查在 workerd 的兼容层内执行，不能据此声称真实 Node/workerd 互通。第 2 轮仅补归档 getter 异常；第 3 轮补版本校验、Blob 元数据快照/读取完整性、空明文解密拒绝，但没有新增对应回归。子代理报告 56 个既有测试通过不能证明这些新边界。跨运行时、存储错误、取消阻塞、缓冲区复用和测试类型验证仍未完成。三轮已用尽；进一步执行等待用户修订预算，不能标记验收通过。

T3 第 2 轮独立 Node24 复跑 3 files / 16 tests（含 49 共享场景），exit 0。类型检查仍报告既有 LinkedIn Env 两项错误。复核发现 metrics observer 异常未隔离、claim SQL 缺 payload_version 条件、维护终结写缺任务资格复查；旧库迁移及完整开销证据也未完成。原 owner 正进行最后第 3 轮修正。

T3 第 3 轮独立 Node24 复跑 3 files / 19 tests（含 49 共享场景），session 29711，exit 0；同一 scoped tsc 仍为上述两项错误，exit 1。已检查 observer/prepare/bind 隔离、协议围栏和维护写入条件的源码。完整读行数计量、实际查询计划、迁移夹具、OAuth/结果提交回执丢失，以及既有 parent 的零行 guard 证据仍缺。新增维护回归测试覆盖 rearm，不能据此替代 terminal 分支竞争测试；rearm 的 recovery_count 上限仍需在 UPDATE 中明确复查。三轮已经结束并释放子代理，未验收为完整 D1 实现。进一步执行等待用户修订预算。

以上局部通过项没有自动写成完整验收矩阵的 PASS。部署、线上权限、真实平台和发布链仍需各自证据及相应授权。
# SDK baseline acceptance, 2026-09-23

Root inspected the final three source changes and new response/timeout/subprocess tests. Bundled Node 24.19.0: SDK build and source/test type checks exited 0; full SDK test session 50567 exited 0 (7 files, 114 tests, start 02:26:33). The subprocess fixture has no keepalive interval, uses an 8-second parent watchdog, and requires natural exit with the expected marker for resolve, deadline, abort and maximum-timer cases. Malformed HTTP 202 writes retain status and `requestMayHaveBeenApplied=true` with exactly one POST. Invalid per-call durations send zero requests.

This accepts T7a and SDK-01/03/04 for the current uncommitted tree. SDK-02/05, auth functionality, CLI and installed artifacts remain unverified. Node 22 has not been run. The subprocess fixture currently prefers a machine-specific bundled runtime when present; installed-artifact verification must explicitly choose its runtime. No release or integration pass is inferred.
# Portable execution acceptance, 2026-09-23

Root inspected execution-policy, execute-publication and execution-archive plus their 48 new regressions. Fresh Node24 application source/test check exited 0; `npm test --workspace @syndroo/application` built successfully and passed all 147 tests in 13 files (start 02:36:24). This accepts T5b1's portable scope: duplicate/race call counts, unknown claims, fixed local outcome replay, fresh retry baseline, legacy/binding AUTH rejection, conservative unknown outcomes, and one bounded post-commit archive stage.

This uses the rollback-capable fake, not a real runtime. Standalone DLQ handling, Worker wiring and real D1/Queue/R2 integration remain pending. No full runtime acceptance gate is promoted from these tests. The transport's separate unresolved Retry-After clamp can still affect real-provider integration until its additional correction attempt is authorized.

Root supplemental Node24 execution probe exited 0 (tool command result a1f463). This explicitly wrapped `commitExecution` to commit to the fake and then throw on its first call; the existing `failNextCommitAfterStage` fixture alone would only prove rollback, not committed acknowledgment loss. Published result: 1 provider call, 2 identical-object commit calls, results applied/already_applied, 0 successor jobs, duplicate message terminal. Safe-retry result: 1 provider call, 2 identical-object commit calls, applied/already_applied, exactly 1 successor job, old duplicate stale_job. Persistent storage failure: 1 provider call, exactly 3 identical-object commit calls, 0 successor jobs; duplicate message settled without another provider call. This was an ad hoc acceptance probe against built application JavaScript, not a committed regression or real D1 proof. The real D1 committed-loss cases remain in T3's outstanding verification scope.
# Static platform preparation acceptance, 2026-09-23

Root reviewed both composition modules and focused tests, including the initial whole-group fallback and diagnostic field-name corrections. Bundled Node24 scoped source/test type check exited 0. Fresh native Worker run session3698 exited 0: 1 file, 97 tests, start 02:50:27. T6a's pure synchronous strategy/decoder boundary is accepted. Partial D1 credentials remain blocked despite complete Env credentials for all five platforms; constructor network count is zero. Binding continuity, source/target metadata, lease/expiry blocking and safe direct input errors are covered.

No runtime route, encryption/CAS orchestration, OAuth exchange or actual publishing integration is accepted by this result. Direct decoding accepts complete user groups with optional documented target/config fields, caps canonical plaintext at 64KiB and reports unknown direct expiry as null. Confirmed OAuth target fields must be stored in the payload as well as safe metadata. Full Worker type checking still has the previously recorded LinkedIn Env declaration errors; the scoped check isolates these new modules.
# T5b2 standalone DLQ and Queue producer acceptance

Root inspected final guarded decode boundaries, hostile getter/proxy fixtures, fixed error codes and settlement behavior. Node24 application check exited 0; application build/test passed 14 files / 157 tests (03:18:01). Queue scoped typecheck exited 0; root focused Worker run session57237 exited 0 with 6 tests (03:18:07). The bounded portable consumer and producer adapter are accepted. This establishes fake-store settlement and structural binding behavior only. Runtime acknowledgement/retry routing, durable quarantine event delivery and separate DLQ diagnostic archive remain unverified and unfinished.
# T6b preparation and direct credentials acceptance

Root final Node24 application check exited 0; build/full test exited 0, 16 files / 207 tests at 03:33:19. Reviewed actual platform AAD identity (x/linkedin), safe failed-read handling, lazy cipher lookup, safe generation before encryption, one CAS with lost acknowledgement, copied caller input and receipt projection from the committed snapshot. Explicit remove performs no read/decrypt/key lookup; repeated removal and revision-overflow cases are exercised. Accepted portable scope only. Real D1, production cipher and concrete strategy/runtime integration remain separate evidence requirements. OAuth and application exports are still pending.
# T7b1 SDK transport acceptance

Root Node24 check/build exited 0; full SDK run session91887 exited 0 with 9 files / 187 tests at 03:47:29. Inspected operation context, per-call error provenance, fixed diagnostic labels, closed error-code allowlists, redirect/late-response disposal, hanging read/cancel deadline and lock-release proof, copied chunks and standalone process fixtures. Existing HTTP status, ambiguity and exact request-count checks remain. Accepted transport scope; auth facade and installed artifacts remain pending. Documented wait lastPost/lastStatus resource snapshots remain available and are not automatically logged. Arbitrary caller-owned getters during argument validation can still throw the caller's own error. Only Node24 was executed; Node22 is unavailable locally.

# T6c1 first review: corrections required

Root Node24 application check/build succeeded; full run session60450 exited 0, 20 files / 255 tests at 03:54:13. This run did not establish acceptance. Source review found that the advertised async resolver still had a synchronous type, driver validation returned the original mutable object, connect's final expiry check preceded awaited encryption, callback success did not require protocol-specific code/verifier before claim, and failure persistence reused a timestamp taken before awaited exchange/decryption. Consequently a late failure could bypass the expiry guard. Several new untrusted boundaries also bypassed the previously accepted safe error reconstruction.

Attempt1 was rejected once, child interrupted before follow-up, and attempt2 assigned to the same owner with focused regression requirements. No frozen store, transport or crypto correction was authorized by this assignment. SDK T7b2 remains in its first implementation attempt; early review feedback aligns method signatures and actual wire fields before completion.

# T6c1 portable OAuth acceptance

Root reviewed attempt2 source and regressions, then independently ran Node24 application source/test check and build/full tests: 20 files / 265 tests, exit0 at04:08:27. The 58 OAuth cases cover the candidate codec, connect, single-claim callback and operation read. Required corrections are present: typed async resolver, captured immutable identity/methods, post-encryption connect expiry check, protocol-specific exact callback values before claim, fresh failure-persistence clock and fixed claimed cipher-failure reporting. Approved stored code CIPHER_UNAVAILABLE is coordinated with SDK/runtime. No callback writes active credentials. T6c1 accepted; candidate activation, refresh, concrete provider drivers and real storage/runtime proof remain open.

# T7b2 first review: corrections required

Root Node24 SDK check/build exited0; full suite session71690 passed 11 files / 231 tests at04:09:09. A subsequent built-JavaScript probe (tool output0fa1ae) demonstrated missing boundaries: a JSON own `__proto__` credential property supplied an inherited required access_token and caused one write; platform `constructor` produced a raw TypeError; diagnostics accepted non-ISO and impossible calendar dates and returned arbitrary reason text. These results prevent acceptance despite the passing suite. Attempt1 rejected once, completed child interrupted, attempt2 assigned to the same owner with own-property, canonical-date, closed-diagnostic and zero-request regressions. No private dependency, transport or CLI change was authorized in that correction.

# T6c2a portable completion acceptance

Root inspected the operation/receipt snapshot, candidate activation source and 17 new tests. Independent bundled Node24 source/test check and application build/full suite exited0:21 files/282 tests at04:47:14. Completed replay needs no current slot/key/config; active writes require original and current revision plus unchanged configuration. Target confirmation never imports the old target. Candidate decode/AAD/expiry and safe next generation precede one atomic activation. Concurrent completions, replacement/removal races, committed-lostack explicit replay and hostile/malformed values are exercised. This accepts only portable completion against fake ports; concrete confirmation, HTTP field mapping and real D1 atomics remain separate gates.

# T7b2 SDK authorization acceptance

Root reviewed attempt2's null-prototype credential/target snapshots, own-property field-spec lookup, canonical date roundtrip, fixed diagnostics reason and top-level operation missingFields. Independent bundled Node24 SDK source/test check and build exited0; full SDK session77484 exited0 with11 files/240 tests at04:47:20. Regression tests reject the own __proto__ bypass with zero requests, contain inherited table names, reject impossible dates and arbitrary diagnostic reason text, and preserve actual malformed-write status/ambiguity. Public overloads match public-api.md and complete permits target omission for replay/provider-confirmed target. T7b2 accepted after2 attempts. CLI, installed artifacts and Node22 remain unverified; no full-product acceptance is inferred.

# T7c1 first review: incomplete command proof

Child attempt1 supplied typechecked CLI source but no focused auth runtime tests or evidence file. Root inspected command/input/output/doctor code and independently reproduced the doctor regression: Node24 session80585, read-commands.test.ts, 18 passed/1 failed at05:00:26. The failing assertion expected two GET methods although the new readiness read correctly made three. The separate Skill command-inventory test is also expected to need its planned Skill update, and is not waived as a product gate.

Source review also found incomplete failed-input cleanup, abort mapped to usage instead of interruption, auth counters lost on thrown errors, and doctor swallowing every readiness failure instead of limiting compatibility fallback to404/405. Attempt1 was rejected once and the child interrupted; attempt2 retains the same ownership with executable TTY/non-TTY, held-open stdin, revision/confirmation, URL and sentinel fixtures required. No SDK or other agent-owned source correction was authorized.

# Input and original-workspace preservation check

Root read-only checks during implementation on2026-09-23: original checkout `/Users/daiyanze/Documents/work/syndroo` returned clean `git status --short` (output879ed5, exit0). The worktree's copied design passed all15 entries in SHA256SUMS.txt (output1d9ced, exit0). Current tracked diff whitespace check exited0 (outpute82ec5). These checks establish preservation at this point, not completion of the product or untracked-file validation.

# T6c2b portable refresh acceptance

Root inspected the final refresh source and18 new tests. Independent Node24 source/test check and build/full application session9394 exited0:22 files/300 tests at05:06:42. The flow checks capability and generation before claiming, validates the exact acquired lease/snapshot, permits one winning exchange, reads the commit clock after encryption, and preserves binding and target. Fenced reconnect recording covers failed exchange/encryption/save; committed-lostack leaves the committed new revision unchanged and returns a controlled storage error without retrying the provider.

Root additionally probed built JavaScript with11 malformed acquired results (tool outputa4b7e6): returned token/window/start, embedded lease, target, expiry, state, binding, ciphertext, platform and revision. All11 returned STORE_UNAVAILABLE/corrupt_record with0 provider calls and0 commits. This is an ad hoc acceptance probe against fake storage, not a committed regression or actual-D1 proof. Portable T6c2b accepted after1 attempt; concrete native token parsing, HTTP receipt mapping and real lease transactions remain separate gates.

# T7c1 second review: incomplete boundaries and false read count

Root independently passed Node24 CLI source/test check (333d61) and build (dbf090), then ran full CLI session51127 at05:27:52:128 passed/1 failed across8 files, exit1. The remaining suite failure names the eight new commands absent from the shipped Skill; that planned separate scope remains a required product gate. Tests passing elsewhere did not establish command acceptance.

A built-JavaScript probe (ecedea) called CLI run with an already-aborted signal for auth.status, auth.operation and diagnostics. All three returned ABORTED/130 with the explicit SDK message that nothing was sent, but authRequests.read was1. This contradicts dispatched-attempt semantics. The tests also lacked held-open stdin overflow, unreadable-path/nested input, malformed/aborted doctor readiness and some command DTO coverage; a custom tolerant-stdin helper still lacked a finite watchdog. The child's final incorrectly described the existing post-dispatch auth interruption test as absent; root reviewed and retained that case rather than assigning a duplicate.

Attempt2 rejected once; child interrupted and resumed for final initial-budget attempt3 with the demonstrated counter regression and a finite remaining checklist. The nested test-only child remains interrupted. Parent reported explicit router_opencode_go_deepseek_v4_1_flash/model opencode-go/deepseek-v4.1-flash spawn arguments, but root has not independently retrieved that nested tool record; routing provenance for that nested invocation remains reported, not independently verified.

# T7c1 final initial-budget review: partial verification, not accepted

Root inspected the final counter guard, doctor ABORTED preservation and new test cases. Node24 CLI source/test check exited0 (a554ba); independent full CLI session79463 at05:33:59 exited1 with135 passed/1 Skill inventory failure across8 files. Build ran successfully as part of that suite. The new pre-aborted real-entrypoint tests establish zero requests/zero counts for status, operation and diagnostics. Removal and explicit LinkedIn completion DTOs now have process coverage.

Mandatory gaps remain: slow input crossing64KiB while the parent keeps stdin open has no natural-exit assertion; the doctor pre-abort case stops before readiness and does not exercise abort during the readiness read; explicit Tumblr complete target coverage and focused failed-read count assertions are incomplete. The child acknowledged the held-open overflow gap while describing the attempt as otherwise complete. Root does not substitute the closed-input oversize case or the SIGINT case for that requirement. T7c1's three initial attempts are exhausted; it remains unaccepted, with no further command/source/test repairs authorized. The separately planned shipped Skill scope can proceed with disjoint document/Skill-test ownership; it cannot fix or absorb these command gaps.

## Resume review: shipped Skill T7c2, attempt 1

Root independently recovered the running CLI verification rather than starting a duplicate: Node 24.19.0, check c5a9be exit 0; full CLI session 12245 (2026-09-23 06:02:20), output a27a4a, 9 files / 147 tests passed, exit 0, build included. This resolves the command-inventory assertion but does not supply the missing T7c1 process-boundary evidence.

Source/text review rejected T7c2 attempt 1: the authorization list omitted refresh; the general current-revision rule conflicts with complete's operation revision and historical receipt replay; an auth-only no-retry rule was phrased as applying to all mutations, conflicting with stable-key post replay; auth/diagnostic entry triggers are absent; and declined-preview wording incorrectly implies zero reads. The eleven new security checks inspect strings; they do not execute forged-provider/target-change scenarios or establish model adherence. Correction attempt 2 is queued with unchanged Skill-only ownership, pending a free agent slot. No CLI command repair or additional T7c1 attempt is authorized through this scope.

## T8a portable maintenance accepted

Root reviewed run-maintenance.ts and all thirteen fake-port tests. Node24 check653570 exit0; full build/test d43d81 at2026-09-23 06:15:13:23files313tests, exit0. Supplemental built-JS probe b0ec2f seeded25duejobs and requested999: exactly20sends,5pending; outer/phase reports frozen; replacing continuation after the first await did not replace the captured predicate. Root accepts the portable slice after attempt1. Actual D1 measurement/races, production limits and Worker/Cron wiring remain unverified; no product gate promoted. The index owner will export the accepted entrypoint/types separately.

T6c3 verification coordination incident: child reported an unrequested main-config full Worker run in session69628, without the dedicated outbound interceptor. Root required termination, exact failure-stage review and an own-scope .native.ts filename so default discovery cannot run the dedicated suite without its fail-closed fixture. No conditional skip accepted. Final dedicated verification remains pending; no claim about live request absence has yet been established.

T6c3 child subsequently confirmed termination of node86695/workerd86728 and closed local listener ports. The buffered full-run pipeline retained no final output. Earlier single-file main-config OAuth failures occurred in the stats.invalid setup fetch; R2 failures occurred at undefined-bucket setup. Provider contact is not established, and its absence cannot be proved from those outputs. Only synthetic inputs were used. Future verification must use the exact fail-closed dedicated config; T9 must add safe global discovery/aggregation before another main Worker run.

## T6c3 concrete drivers accepted

Root Node24 scopedtsc5fbf42 exit0; dedicated fail-closed workerd session96732 at06:30:36,33tests, exit0/aed0fd. Application index build/test session7144 at06:29:24:313tests, exit0/01ded1. Source review confirms fixed supported-platform config failure, original opaque-value handling and strict native-field checks, explicit Tumblr/LinkedIn target confirmation, no-refresh-public-origin dependency, copied configuration and captured signer. Root corrected evidence wording: request signatures are checked through the accepted signer, not an independent crypto oracle; the final64KiB bound is also enforced by portable usecases; no blanket no-egress claim can cover the terminated main-config run. Accept concrete-driver/additive-index scope atattempt1; no runtime/live/D1 gate promoted.

T7c2 attempt2 rejected: despite a new correct prose paragraph, final exit-code table still said nothing was sent for codes2/5, and entry workflow still reduced doctor failures to onlyBASE_URL/API_KEY. Root check1b8437 passed; no duplicate full test was run before correction. Child started final attempt3 with the exact remaining prose/static-check fixes; command scopeT7c1 remains frozen.

## T7c2 shipped Skill accepted after attempt 3

Root inspected the saved entry workflow, exit-code rows2/5, revision/replay rules, attempt-count caveat, HTTP fallback and static contract tests. The assigned contradictions are corrected. Independent bundled Node24 source/test check10abc8 exited0; full CLI session68708 at2026-09-23 06:43:33 built successfully and passed9files/159tests, exit0/b0364e. The unchanged command/flag inventory test still exercises built CLI help. Child was already interrupted after its final delivery.

Accept the shipped-text and static-contract scope only. Static checks do not establish model adherence, installed-artifact behavior, or the missing T7c1 held-open overflow, readiness-stage abort, explicit Tumblr target and failed-read counter evidence. The child evidence's attempt2 title,156-test command transcript and19-check count are historical, not final-tree verification; this independently observed159-test result supersedes them. There were two rejected deliveries before this accepted third delivery. No public acceptance ledger gate is promoted.

## T6d1 lazy runtime dependencies accepted

Root reviewed the final module, all16 native tests, fixture configuration and evidence. Duplicate preparation/AAD/status logic has been removed in favor of the accepted application closure. Copied allowlisted configuration is deduplicated and frozen; cached cipher/signing adapters are frozen; validation remains lazy. Actual usecase tests cover missing-key create replay and completed OAuth replay, explicit removal with1CAS/0slot-reads/0cipher-lookups, direct-set failure before mutation, and Env-ready creation failing at the missing-binding signer before rows or queue sends.

Independent Node24 scoped source/test check1eed48 exited0. The dedicated config is not included by that tsconfig, so root separately typechecked it with explicit ESNext/Bundler/ES2022, Node and Worker types, --ignoreConfig and --skipLibCheck:0c9d46 exit0 (skipLibCheck covers declarations, not the config source). The first separate command was rejected by TS5112 because --ignoreConfig was absent; no source error or source change followed. Dedicated fail-closed native session50551 at2026-09-23 07:23:06 passed1file/16tests, exit0/55967f.

T6d1 accepted after attempt1, child interrupted. This proves composition order with fake semantic stores and current concrete crypto adapters. Real D1, exhausted T4 boundaries and full HTTP/Queue/Cron route wiring remain unaccepted local work, not merely deployment-time checks. Production account compatibility and deployment remain separately unverified. The ledger remains3PASS/117NOT_RUN; the child's phrase that the ledger "stays NOT_RUN" refers only to unpromoted gates for this slice, not every ledger entry.

## T6d2 inbound body reader accepted

Root inspected the final reader, all29 native tests and dedicated configuration. The reader caps received bytes before copying, uses fatal UTF-8 decoding, separates genuinely empty optional input from consumed or malformed input, guards read errors and cancellation, and checks stop state after awaited reads. Iteration-based yielding permits the deadline timer to run even after a nonempty chunk followed by only empty chunks. Cancel promises are observed without being awaited; the finally block clears the deadline/listener and releases the owned reader.

Independent Node24 scoped source/test/config check5dfcb9 exited0. Dedicated fail-closed native session12408 at2026-09-23 07:26:38 passed1file/29tests, exit0/8ae307. Root used a separate60second host process-group kill guard; the suite finished in699ms without using it. A byte comparison against HEAD proved json, requireBearer and verifyToken unchanged (254f94). The child was interrupted after delivery; its resumed long turn remained attempt1 and was not counted as a rejection.

Accept the inbound-reader slice only. Correct evidence limits: the test helper named withWatchdog is an in-workerd timer, not an external process watchdog; hot-loop fixtures are additionally producer-bounded, and root's outer guard is genuinely external. The periodic task hop has unmeasured cost for any request crossing64reads; "costs nothing in the normal path" is not established. JSON.stringify(Error) does not expose every nonenumerable error field; tests with exact fixed-message assertions plus source review establish the covered read/decode errors, not a universal serialized-error audit. API/no-store/auth boundary and legacy optional-route integration remain unaccepted. No public ledger gate is promoted.

Root then corrected acceptance documentation in cli-skill.md (attempt3/two rejections/159current versus156historical), runtime-dependencies.md (3PASS/117NOT_RUN and local runtime work still pending), and http-body.md (task-hop cost and external-guard/error-serialization limits). These are orchestrator acceptance-record corrections; no implementation or test was changed or re-executed as another subtask attempt.

## T9a first attempt incomplete; fresh-context second attempt

The reused SDK child delivered only file inspection and no implementation, citing its remaining session budget without tool quota evidence. It also reported that its read commands did not use the required rtk prefix. Root records this as one incomplete execution attempt, not a verified account/model limit. The child was interrupted. Main config and Worker package tracked diff remained empty (99d3c1); no main Worker run or canary was reported.

Root changed the approach to a fresh minimal-context child, /root/worker_test_isolation, with the same explicit native role router_opencode_go_deepseek_v4_1_flash and model opencode-go/deepseek-v4.1-flash; spawn accepted those exact arguments. This is T9a attempt2/3, not a new budget. It must implement and submit local fail-closed config for root static review before execution, then prove watchdog/discovery/aggregate behavior. No provider substitution or background driver was used. T5c remains the other active child, with disjoint ownership.

## T9a static isolation review and canary

Root inspected main configuration and shared fixture options (c640d0): no Wrangler or experimental config inheritance; remoteBindings:false; explicit synthetic local D1 and Queue; fixed synthetic string bindings; cf:false; fixed 500 outbound response with no request-derived text. Installed plugin source confirms Wrangler loading is conditional on experimental.newConfig or wrangler.configPath (99e83c). Both options are absent. Root requested removal of the native canary's host-tooling import; final canary asserts an independent fixed literal.

Root independently ran only test/canary-v050.vitest.config.ts under bundled Node24, with a separate sixty-second host process-group deadline and owned-group cleanup. Session94677 at2026-09-23 07:42:24 passed1file/3tests in747ms, exit0/0832f6; the deadline was unused. GET, POST with sentinel headers/body, and metadata-endpoint requests returned the fixed local rejection. This satisfies the configured outbound-fetch canary gate. It does not establish live-provider compatibility or prove absence of outbound contact in the earlier ungated run.

Broader Worker execution is now authorized only with finite external cleanup, after the owner verifies watchdog fixtures and complete discovery. Those checks, aggregate execution and final T9a acceptance remain pending. No adapter correction or public ledger promotion follows from the canary.

## T5c first delivery: ordering evidence incomplete

Root inspected final queue mapping and19 tests (c7dc9e/8d4a39). The module awaits sync/async alerts, selects exact queue before messages, maps guarded errors and attempts one disposition. However, the required test evidence was incomplete: async alert and acknowledgement used separate logs; DLQ metadata and multi-message sequential tests checked only final outcomes; unknown-route helper swallowed errors and tolerated a null result, while unchanged snapshots did not establish zero domain reads. The child claim of a shared alert-start/alert-end/ack trace was not supported by that first test implementation.

Root interrupted the completed child and rejected attempt1 once. Same child resumed targeted attempt2/3 for deferred ordering proofs, zero-call counters, dedicated-config typechecking, the inaccurate synchronous-alert source comment and own evidence. No frozen adapter, legacy runtime or main test configuration change is authorized. Root did not rerun tests already known to lack the assigned proof. T5c remains unaccepted pending revised evidence and independent execution.

## T5c queue mapping accepted after attempt2

Root inspected the revised deferred alert and DLQ settlement traces, forbidden-domain routing counters and the multi-message test held inside first preparation. The latter proves the second message cannot start while the first usecase is pending; its hold is at preparation, not inside a provider request. Main settled/malformed/business-retry and DLQ quarantine/error results also retain native MessageBatch/getQueueResult coverage. Fixed errors and one disposition attempt remain in the reviewed source. Legacy jobs/index remain unchanged.

Independent bundled Node24 scoped source/test/config check110f33 exited0. Exact dedicated native session48852 at2026-09-23 07:57:12 passed1file/19tests in643ms, exit0/d42367, under root's sixty-second process-group deadline and final owned-group cleanup (deadline unused). Child was interrupted after final delivery. Its Perl alarm kills only the direct exec process and is not proof of descendant cleanup; root's independent group guard provides the outer boundary for this verification.

Accept T5c module and isolated mapping only. Actual Cloudflare delivery limits/topology, DLQ R2 diagnostics, production log-export durability and the legacy exported Worker entrypoint remain unaccepted. Ledger unchanged at3PASS/117NOT_RUN.

## T9a isolation and finite runner accepted after attempt2

Root reviewed explicit fixture bindings, the default rejection service, actual Vitest discovery, sequential aggregate and single terminal-reason cleanup. Independent Node24 host session41014 at2026-09-23 08:01:32 passed2files/20tests in10.56s, exit0/5bf19d. Root then copied the actual aggregate and watchdog into a disposable directory and ran three fixture projects in order: successful main, failing a-fail, successful z-pass. The last project still ran and aggregate exited1 (116928); this independently proves failure propagation and discovery of new dedicated configurations.

Independent full aggregate session58504 ran08:04:30–08:05:07 with per-project60second deadline and1000ms kill grace, exit0/741890:8projects,26files,404tests. Counts: main17/228; canary1/3; host2/20; HTTP body1/29; OAuth drivers1/33; queue mapping1/19; runtime dependencies1/16; storage2/56. Scheduled-maintenance tests were not yet present and are not covered by this run. Typecheck22ce48 exited1 with exactly four outside-scope diagnostics: two legacy LinkedIn Env fields and two frozen crypto/R2 test casts. No generated Env step was run.

The main project emitted an uncaught EnvironmentTeardownError, `Closing rpc while "resolve" was pending`, during teardown (e78c65), despite reporting228passing tests and exit0. Root accepts test isolation, discovery and bounded-runner scope; it does not claim a clean runtime lifecycle, corrected frozen adapter boundaries, or full product acceptance. Same child was interrupted, then assigned read-only T0 continuation attempt2 to diagnose the teardown with bounded local execution; repository repairs are not authorized by that diagnostic assignment.

Documentation limits: mandatory group termination precedes optional diagnostics, but completion does await a bounded final process snapshot. The runner inherits process.env for child tools; it does not print environment values or load application credential files as Worker bindings. Therefore the child's broader phrases "no environment is read" and "diagnostics never awaited by cleanup" are narrowed accordingly. Production Queue/resource behavior, Node22 and all unpromoted ledger gates remain unverified.


# T8b1 scheduled deadline acceptance

Root reviewed the delivered source, dedicated fail-closed configuration and all15 native cases. Independent Node24 source/test/config typecheck exited0 (`e14eeb`). The dedicated workerd suite passed1file/15tests at08:27:27, session76400, exit0 (`037c14`), under the accepted60second process-group guard. The final process snapshot was empty. Root passed the unsupported `--grace-ms` flag in that invocation, so the guard retained its default10second grace rather than the intended1second; no timeout or termination was needed. This does not affect the observed test result.

Root also exercised two concurrent calls to the SAME returned wake function, because the committed concurrency case creates two separate wrappers. Disposable isolated workerd fixture `/tmp/root-syndroo-v050-scheduled-probe/shared-wake.native.ts` held the first recovery, completed the second wake, timed out the first, then released its recovery and asserted no later phases started. Session83681 at08:29:56 passed1test, exit0 (`76ae3b`); correct `--kill-grace-ms 1000` guard and empty final process snapshot. This is supplemental execution evidence, not an added committed regression.

T8b1 accepted after attempt1: accepted `runMaintenance` is used directly; explicit limits are copied; timer precedes domain work; clock/timer failures stay fixed;20second total deadline can only be lowered; final elapsed time is rechecked; timeout has no fabricated counts; accepted pending sends may mark but no later work starts; completed phase failures remain visible. Trusted dependency getters are captured outside the wake failure channel. Throwing cleanup hooks prove an attempt to clear, not successful cleanup. Production Cron wiring, measured D1 limits and full entrypoint integration remain unaccepted. Ledger stays3PASS/117NOT_RUN.

# T0 teardown diagnosis and T9a corrective scope

The T0 attempt2 owner initially returned an empty final. Root interrupted it and requested only a report of already-executed work. The clarification identified completed sessions, disposable logs and no repository edits; root interrupted the completed child again. It reports no remaining process/session. Root inspected both A/B configurations and logs (`ce97e5`): the same14-test retry-timing file passes with or without automatic `queueConsumers`; the consumer-enabled run emits two uncaught teardown exception lines, while the producer-only run does not. One earlier E/F/G subset hit the60second guard and was terminated; its final owned-process snapshot was empty. Root did not independently rerun that earlier bisection.

Installed-source analysis identifies pending Vitest module-resolution RPC rejection during teardown. Automatic consumer participation is evidence-backed; the precise late-delivery/resolve sequence remains a hypothesis. The observation must not be described as a proven pre-T9a issue: the original Wrangler-derived configuration was not tested in this A/B.

Root inspected fixture usages (`02635a`, `0df8ed`, `50f251`): queue outcome tests invoke `worker.queue` directly with `createMessageBatch`/`getQueueResult`; they do not assert automatic broker delivery. Root assigned the remaining T9a attempt3 to remove ONLY automatic consumers from the shared test-project helper, retaining the producer and all fail-closed bindings. The scope includes documenting diagnosis, exact hung-subset reproduction, main228tests, canary and focused helper typing; no test suppression, source repair or dependency change. This is within T9a's original three-attempt budget, not an additional exhausted-scope allowance. Final acceptance remains pending.


# T9a third attempt: producer-only correction disproved

The full main suite disproved root's earlier inference that direct queue calls cover every fixture assertion. Root inspected the new failure log and orchestration polling (`89c085`, `f2b7e7`): four tests poll for provider completion after actual broker delivery. Removing automatic consumers passed the3-case E/F/G reproducer but caused4failed/224passed in the full main suite, exit1. The child restored the consumer; only explanatory helper prose changed. No test assertion or timeout was weakened.

This unsuccessful correction consumes T9a's third initial attempt. Its previously accepted fail-closed isolation/discovery/watchdog behavior remains separate from the unresolved lifecycle defect. Precise cause is still unproven, and a green process exit does not establish harmlessness. The owner is documenting the result; root will verify the final restored state in the aggregate after metadata changes settle. A concrete additional attempt proposal is recorded in remaining-corrections.md, without granting execution permission.


# Final continuation verification: metadata accepted, Worker aggregate failed

T9b accepted after attempt1. Root reviewed the five-file metadata diff (`96aa69`) and the child evidence. The root lock snapshot was taken before edits and matched HEAD (`c8bb6d`); all319 external package records remain exactly equal (`a47457`). Independent manifest assertions proved topological/unique build and test order, public0.5.0-rc.1 versions, exact CLI SDK pin, private0.1.0 versions, development-only Worker dependencies and preserved Worker test scripts (`f3b728`). Offline workspace resolution passed (`64f996`).

Root Node24 build of all ten packages in the root build script passed at08:44:26, session35475, exit0 (`7e8ca0`); this script does not bundle the Worker or build experiments. Scripts build/typecheck passed (`3b1bfe`). The two existing release fixture files passed92tests/10suites at08:46:12, session54019, exit0 (`efd40c`), with fake registry responses. Current actual manifests passed release-train with registry checks explicitly disabled (`a28d4e`), version0.5.0-rc.1/tag next. The output's proposed publication step is data, not authorization; no publication was performed. Root npm verification used two distinct empty user/global config files, because npm rejects loading the same file twice.

The final Worker aggregate is FAILED. Root session64275 ran all9projects using per-project60second deadlines and1second kill grace. Main emitted `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "resolve" was pending`, then hung. Its guard reached60seconds at08:46:37, terminated the owned group, and returned124. The aggregate continued with every dedicated project and preserved exit124 (`c94a73`). No complete main test count was printed, so earlier228pass results cannot be counted in this final run.

| Current dedicated project | Files | Passed tests |
| --- | ---: | ---: |
| canary | 1 | 3 |
| host watchdog/inventory | 2 | 20 |
| HTTP body | 1 | 29 |
| OAuth drivers | 1 | 33 |
| Queue consumer | 1 | 19 |
| runtime dependencies | 1 | 16 |
| scheduled maintenance | 1 | 15 |
| storage | 2 | 56 |
| Total successful dedicated scopes | 10 | 191 |

Aggregate log `/tmp/root-worker-aggregate-final-v050.log` was inspected (`6e3d8d`, `d46311`). All9owned-process final snapshots are empty (`ce4045`), including the terminated main group. No extra lifecycle repair or blind rerun was started: T9a's three initial attempts are exhausted. Green dedicated suites do not replace the failed main project or fill the frozen adapter acceptance gaps.

Fresh full Worker test-tree typecheck (`89f72f`) exited1 with exactly4errors: LinkedIn client ID/secret missing from Env at platform-descriptors.ts:308/309; crypto-v050.spec.ts:268 version2 fixture assertion; r2-v050.spec.ts:144 archive assertion. No Wrangler type generation was invoked. Node22 remains unavailable and unverified.

Root corrected evidence-only overstatements: the teardown bisection sampled combinations rather than establishing a minimum count; the restored helper has a comment change; metadata changes cover four package manifests plus the lockfile, not every workspace build. Initial default npm invocations do not prove absence of implicit user-config reads. These editorial corrections make no source change and grant no new repair attempt.

Preservation: original checkout clean (`ffb829`);15design checksum entries and the checksum manifest remain byte-identical to Downloads input (`387337`); tracked diff check passed (`5391db`). Both children were interrupted after their final deliveries. This continuation reused the previously explicitly selected native DeepSeek children; no model substitution was made. Product ledger stays3PASS/117NOT_RUN, with full runtime/integration/release acceptance still open.
