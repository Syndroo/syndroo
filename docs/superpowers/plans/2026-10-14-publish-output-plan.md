# Publish output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 项目指定实现模型路由优先于技能的执行方式建议；当前仅完成规划，不实施、不提交。

**Goal:** 为 `publish` 与 `status --operation` 提供冻结账号与内容展示、明确确认、可靠逐目标进度及一致的机器输出。

**Architecture:** 扩展现有可选展示元数据与结果投影，不增加发布数据库。Core 负责冻结快照、执行轮次关联及持久化后通知；CLI 使用同一目标视图、renderer 和轻量输出控制器。保留串行发布、幂等、鉴权、审批和安全重试规则。

**Tech Stack:** TypeScript、NodeNext ESM、Node >=24.19.0、npm workspaces、Ajv2020 生成协议、Vitest；文件系统、SQLite、D1 现有适配器。

**Spec:** [完整设计](../specs/2026-10-14-publish-output-design.md)，420 行，SHA256 `796e3a90d4f0279d52d7e061a23c4c1ebd0d46643a10a8395a2eda0948d98c48`。

## Global Constraints

- 基线：`/Users/daiyanze/Documents/work/syndroo`，main `88216d2db2ccc0b89acbfae434aa6912b7b383b2`；既有未跟踪 `notes/` 保留。此计划存于任务工作区，源仓库只读核对。
- 默认正文最多 3 个渲染行；Reason 最多 2 行；追加布局宽度无法取得时使用 80 列；字素边界截断；URL 不截断。
- 身份回退前 12、后 4 个字素；碰撞扩展到完整 ID 与实例；accountName 为 1–256 Unicode 码点，profileUrl 最长 2048 字符。
- prepare 开始时刻起 900000ms 确认窗口不变；现有交互总期限 600000ms 不因 v 重置；执行器 60000ms 调用超时不变。
- `--yes` 只自动确认；`--yes --json` 一个最终 envelope；无 yes 的 JSON 只 prepare；`--dry-run --yes` 仍离线只读。
- 不变更请求格式、HTTP v1 路线、业务状态枚举、退出码、最大尝试次数、安全重试集合、串行顺序、异步模式或出站策略。
- 不改 `status --connections`/`--operations` 布局，不加 watch、SSE、消息总线、自动重试、平台、新账号命令或破坏性迁移。
- 敏感字段先在结果入库之前排除；不以截断代替脱敏；不输出原始异常、HTTP body/header 或凭证。approvalToken 只保留既有受控 prepared/execute 交接边界。
- 所有验证使用隔离目录、假凭证、假时钟、mock Provider/transport；禁止真实 SNS 发布、push、deploy、真实凭证操作及 WebCodex trusted OAuth 绕过。不运行 release/install-global 命令。
- 仅实现模型 `deepseek/deepseek-v4-flash` 经已验证 codex-router 路由可执行后续实现；未批准 fallback，不可由规划模型静默代写。当前路由不可用。

## Review Focus

- retry 子集先后不同，且某轮未 claim 就停止：内容与身份仍关联真实执行轮次（任务 3）。
- 元数据含 ANSI/OSC、双向控制或带凭证 URL：可选字段丢弃或转义，实际发布 payload 不变（任务 1、5）。
- v 循环期间文件或绑定变化、Provider 升级、审批到期：旧授权不用于新意图（任务 6）。
- 已发送但结果落盘失败、stdout 故障或 callback 抛错：不得重发或伪造可靠成功（任务 4、7）。
- stdout 重定向但有控制终端、resize 使布局超高：可见确认、保留全文、安全降级及终端恢复（任务 6、7）。

## 源码事实与文件分工

- `packages/core/src/domain/rules.ts:executionView(op)` 当前仅输出身份、attempts、outcome；不输出内部 state/冻结 preview。`runtime.ts`、`prepare.ts`、`executor.ts`、`status.ts` 均有直接调用，必须一起改。
- `prepare.ts` 已冻结并摘要保护整个意图；retry 从第 0 轮找原始内容并保留 deliveryId。各存储保存 `operationId:executionRevision` 意图；`DeliveryRecord.history[].claim` 有执行轮次。
- 存储 `admitExecution` 只把选中目标设 ready、清 outcome/claim；`stopUnstarted` 不新增 claim history。因此不能仅靠当前 operation revision 或最新 history 推断所有旧目标的预览轮次。
- `runtime-helpers.ts:validateProviderResult` 直接严格校验 Provider 返回对象：增加可选字段的容错必须发生在该校验之前，不能放宽 identity/evidence 校验。
- `commands/publish.ts` 已一次解析输入、stdin-only execute、JSON 不询问；但没有 yes/v，确认提示写 stdout，读 `/dev/tty`。`CliIo` 暂无控制终端写入与尺寸接口。
- `human.ts` 目前全量预览且暴露内部 ID，控制转义不覆盖双向格式；`envelope.ts` 已有安全错误与退出码映射，应复用。
- `scripts/generate-protocol.ts` 同时写 Core/SDK generated 四文件与 `docs/generated/protocol/protocol.schema.json`；只改生成类型不足以完成协议变更。
- 已有 `tests/fixtures/providers/fake.ts`、`tests/fixtures/state/harness.ts`、`tests/contracts/state-store.ts` 和 CLI `support/harness.ts` 可复用；CLI harness 使用真实隔离文件系统、假 registry/transport，并支持 stateTree 字节对比。

新增文件控制在：Provider SDK 的展示安全工具、Core 共用投影/通知、CLI 目标视图/排版/输出控制器及对应聚焦测试。沿现有模块组织，不改大规模目录结构。

## 执行顺序

任务 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。每项先写下述断言，跑对应命令确认预期失败，再最小实现并跑绿；不得以 import 错误或环境故障代替行为失败。各项完成只记录本地 diff 与验证，不自动 commit。若需要隔离，先使用原生 worktree 流程，保留原库 notes/，在获准写入的 checkout 实施。

### 任务 1：可选元数据、安全诊断与协议（T02、T11、T14）

**Files:** 修改 `packages/provider-sdk/src/{types,index}.ts`、`packages/core/src/protocol/protocol.schema.json`、`packages/core/src/domain/records.ts`；新增 `packages/provider-sdk/src/presentation.ts`、`packages/provider-sdk/test/presentation.test.ts`；更新 `packages/core/test/protocol/{schema,generated}.test.ts`。生成 Core/SDK `src/**/generated/{types,compiled,validators,validation}.ts` 与协议文档。

**Interfaces:** `AccountPresentation={accountName?:string;profileUrl?:string}`、`TargetPresentation=AccountPresentation & {label?:string}`、`SafeDiagnostic={providerCode?:string;httpStatus?:number;message?:string}`；VerifiedIdentity、ConnectionView/Record、FrozenTarget、TargetPreview、DeliveryResult 添加相应可选 presentation；失败/unknown ProviderWriteOutcome 可选 diagnostic；DeliveryResult 可选 state/preview，内部 state 仍必填。

- [ ] 写 `drops_invalid_optional_presentation_without_accepting_invalid_identity`：非法名字/URL 丢字段；非法 account/evidence 仍 PROVIDER_INVALID；边界 256/257 码点和 2048/2049 字符明确验证。
- [ ] 写 `does_not_store_untrusted_diagnostics_or_sensitive_urls`：认证 userinfo、query/fragment 凭证、大小写/编码变体、控制字符 URL 被拒；不要尝试修复敏感链接。公开展示 URL 采用 HTTPS、无 userinfo、无 query/fragment 的保守契约；不得改变正文中的 URL 或网络出站策略。
- [ ] 实现 `sanitizeAccountPresentation(value: unknown): AccountPresentation | undefined` 和 `safePublicUrl(value: unknown): string | undefined`；不复制未知字段。诊断码限定 `[A-Za-z0-9_.-]{1,64}`、状态为整数 100–599、固定模板消息最多 512 码点。官方 Provider 只从固定 allowlist/模板产生诊断；类型校验不是任意响应文本的安全证明。
- [ ] 保持 identity 结构不变；为可选诊断设计固定安全消息映射，未知/无法证明安全的 message 丢弃；Core 入库前剔除非法可选展示/诊断字段，之后执行完整结构验证。
- [ ] 运行 `npm run generate:protocol`，再 `npm run test:v1 -- packages/provider-sdk/test packages/core/test/protocol`；预期全部通过，生成结果与 schema 一致，旧无新增字段 response 仍可读取。

### 任务 2：Provider 采集与冻结传播（T01、T02、T05、T11）

**Files:** 五个 `packages/provider-{bluesky,devto,linkedin,mastodon,threads}/src/index.ts` 及各自 `test/{connect,publish,fixtures}.ts`；Core `src/connect/connect.ts`、`publish/prepare.ts`、`runtime-helpers.ts`、`runtime.ts`、`status/status.ts`；`test/{connect,safety,publication-boundaries}.test.ts`。

**Interfaces:** Provider 在已有 connect/verify 响应上构造 `VerifiedIdentity.presentation`；Core `preview(intent)` 输出 FrozenTarget.presentation。prepare 选已验证的当前展示信息，缺失时可用保存的 connection presentation，label 使用当次连接 label；冻结后绝不借当前连接更新历史。

- [ ] 写 `presentation_is_not_identity_or_binding`、`old_preview_survives_label_change`、`presentation_is_covered_by_intent_digest`：只更名不改稳定身份/绑定；篡改冻结 presentation 导致完整性检查失败；未更改旧记录摘要。
- [ ] 修改官方解析器，仅利用已有 API 返回：Threads 已请求 id,username；Bluesky session、DEV.to user、Mastodon verify_credentials 有可用字段则采集；LinkedIn 若缺少可靠可读 handle/主页就省略，不拼猜用户名或增加请求。使用 fixture 证明每项来源。
- [ ] connect 持久化可选 presentation；prepare 将规范化 presentation 与 label 放入 frozen target 后再计算 digest；dry-run 使用连接已保存的 presentation，不验证凭证。
- [ ] 增加所有五家固定失败 fixture 的安全诊断；未确认平台 code 不制造 code，未知错误仍固定安全概述。
- [ ] 运行 `npm run test:v1 -- packages/provider-bluesky/test packages/provider-devto/test packages/provider-linkedin/test packages/provider-mastodon/test packages/provider-threads/test packages/core/test/connect.test.ts packages/core/test/safety.test.ts packages/core/test/publication-boundaries.test.ts`；请求次数不因展示改变，身份失败仍失败。

### 任务 3：共用执行投影与存储轮次（T02、T12、T13、T14）

**Files:** 新增 `packages/core/src/publish/projection.ts`、`packages/core/test/publish-projection.test.ts`；修改 `domain/{records,rules}.ts`、`runtime.ts`、`publish/{prepare,executor}.ts`、`status/status.ts`；适配器 `packages/cli/src/runtime/filesystem/state.ts`、`packages/server/src/state/state.ts`、`packages/cloudflare/src/state/state.ts` 及各自 rules/database（仅验证确有字段过滤时改）；`tests/fixtures/state/memory.ts`、`tests/contracts/state-store.ts`。

**Interfaces:** `projectExecution(state: StateStore, op: OperationRecord): Promise<ExecutionResult>` 取代所有对外 executionView 调用；内部 `DeliveryRecord.previewRevision?: Revision` 只记录快照来源轮次，不进入公共协议。首轮保存/执行受理为选中 delivery 原子写此值，未选目标保留，不复制正文。

- [ ] 写 `retry_subset_keeps_other_delivery_snapshot`：至少三目标、两次不同子集 retry，包含不 claim 就 stop 的轮次、重复平台账号、乱序目标；断言逐 deliveryId 的预览/名称正确，未重试结果保留。
- [ ] 首先验证旧数据能否唯一确定轮次：新记录按 previewRevision；旧记录当前已受理 intent 包含该目标时用当前轮次，其他有 claim/history 证据时用对应轮次；初始未重试操作可用 0。存在早先未 claim 的 retry 且无法唯一证明时显示预览不可用，不按数组、平台或“最近准备”猜测，不改旧记录。
- [ ] `projectExecution` 按所需 revision 缓存读取 intent，再按 deliveryId 关联；只从持久化 op 取 state/outcome/attempts。缺字段安全降级；不读取凭证、Provider 或原文件。保留原 outcome 与 durabilityWarning 语义。
- [ ] 写 `execute_replay_and_status_share_projection`，同 requestId/approval 重放调用数不变；status 完成/失败/unknown/pending/expired 查询对比 stateTree，且 Provider、文件读取替身均禁止调用。
- [ ] 将带可选字段、无可选字段、原始旧 digest、retry 轮次四组 fixture 加到共享存储契约。旧查询前后记录字节/逻辑值不变；三个适配器往返不丢字段。
- [ ] 运行 `npm run test:v1 -- packages/core/test/publish-projection.test.ts packages/core/test/status-queries.test.ts packages/cli/test/runtime/filesystem/contract.test.ts packages/server/test/state/contract.test.ts packages/cloudflare/test/state.test.ts`；全部通过后检索所有 executionView 调用确认无绕过共用投影的公开路径。

### 任务 4：持久化后轻量进度（T07、T08、T13）

**Files:** `packages/core/src/domain/records.ts`、`runtime.ts`、`publish/executor.ts`；新增 `publish/progress.ts`、`packages/core/test/publish-progress.test.ts`；扩展 CLI 真实存储 harness 的进度集成测试。

**Interfaces:** `ExecutionProgress={type:'admitted'|'claimed'|'recorded'|'stopped'|'finished';execution:ExecutionResult}`；`CallContext.onProgress?: (event:ExecutionProgress)=>void`；`Executor.run(work,signal,onProgress?)`。此回调不在 HTTP wire 中。`emitProgress` 克隆冻结快照并捕获回调错误，绝不进入 Provider catch。

- [ ] 写可控 deferred Provider：第一目标实际 claim 后停住，存储是 in_flight、第二项 ready，通知对应 Publishing/Waiting；释放后顺序执行第二项，attempts/调用次数保持原值。
- [ ] 写回调抛错、CAS claim 冲突、recordOutcome conflict/抛错、signal abort fixture：claim 失败无 claimed；落盘失败无 recorded success，并返回 OUTCOME_NOT_DURABLE；没有第二次发送或额外下一目标调用。
- [ ] 仅在 admit/claim/record/stop 成功提交后发通知，重新读取真实已提交 op；finished 可携带非终态或 durability warning，不能代表必然成功。通知投影失败不得改变已发送事实或重试 Provider。
- [ ] 运行 `npm run test:v1 -- packages/core/test/publish-progress.test.ts packages/core/test/safety.test.ts packages/cloudflare/test/executor.test.ts packages/cloudflare/test/queue.test.ts`，并用真实 filesystem fixture 重跑阻塞 Provider 用例；HTTP/durable_async 不添加订阅或轮询。

### 任务 5：共用目标视图与安全排版（T01、T03、T09、T11、T12）

**Files:** 新增 CLI `src/render/publication-view.ts`、`publication.ts`、`terminal-text.ts` 与 `test/v1/publication-render.test.ts`；修改 `render/human.ts`、`render/envelope.ts`（仅复用/导出安全分类）。

**Interfaces:** `publicationView(result: PreparedResult|ExecutionResult|OperationView|DryRunResult, mode:'preview'|'live'|'recorded'): PublicationView`；`renderPublication(view, {width,verbose,full,color}): string[]`；`summarizeText(text,width,maxLines): {lines:string[];truncated:boolean}`。PublicationView 仅供 UI，保存 account、presentation、preview、state/outcome、attempts，绝不含 token/secret。

- [ ] 参数化四种名称组合、同 label/handle、多实例、ID 缩略碰撞，按整个目标集合消歧；完整 ID/实例可自然换行，缺主页用验证后 origin；无帖子链接则不显示 Post 行。
- [ ] 用 `Intl.Segmenter` 保持字素，使用独立列宽函数处理组合字符、CJK/emoji、tab 和宽度 1/2/80；若采用依赖先评估现有可用库与 bundle/NOTICE 影响，不写庞大自制 Unicode 表。转义控制和双向格式后再测宽，保留正文真实换行，仅展示变换不改 payload/digest。
- [ ] 正文最多 3 行、Reason 最多 2 行；截断才加省略提醒。只去掉与 content.text 等值的 text 字段；标题、可见性及其他发布字段单独显示，v/verbose 全部安全预览。
- [ ] 单/多目标快照覆盖 succeeded、failed、partial、unknown、not_started、cancelled、prepare failure；非零汇总仅多目标，真实 operation ID 查询命令只一次；准备失败无虚假逐目标 outcome。
- [ ] recorded 未完成结果标 `Last recorded status`，无 state 显示运行阶段不可判断；OUTCOME_NOT_DURABLE 显著警告且不能渲染可靠 Successful；verbose 操作 ID 一次、各目标完整 ID/attempts/安全诊断；不伪造 expiresAt。
- [ ] 运行 `npm run test:v1 -- packages/cli/test/v1/publication-render.test.ts packages/cli/test/v1/render.test.ts`；断言 ANSI/OSC/CR/bidi 注入不能新增 Status 标题，原 payload 与 digest 深比较相等。

### 任务 6：yes/v 确认与控制终端（T04、T05、T06、T10）

**Files:** CLI `src/main.ts`、`commands/{publish,context}.ts`、`io.ts`、`test/v1/{human,usage,loop}.test.ts`、`test/v1/support/harness.ts`；新增 `test/v1/publish-confirmation.test.ts`。

**Interfaces:** `PublishOptions.yes?: boolean`；CliIo 添加可选 `writeTty(text:string): boolean`，生产通过可读写 `/dev/tty` 实现，失败则无确认能力；保留现有 stdin 文档与 secret 输入接口。确认 deadline 在首次询问前固定，剩余时长传入每次读取。

- [ ] 写表驱动 yes/json/noTTY/dryRun/execute/retry 测试；用 parseEnvelope 断言恰好一文档，yes+json 无中间 prepared/token；explicit execute 不额外 prepare，retry 仍仅显式合法选择。
- [ ] 写答案序列 v→无效→view→y、n、空、EOF，确认 v 不 prepare/verify/publish、不读文件、不延长 deadline；最终 y/yes 只发送同一冻结 payload 一次。
- [ ] 原生确认可见预览与提示写控制终端；stdout 重定向保持追加人类结果；控制终端不可安全读写则返回待确认，无阻塞和发送。JSON 不调用任何 TTY 方法。
- [ ] 在 v 回调中修改输入、label、账号绑定、Provider 指纹和假时钟，分别验证冻结内容/旧名称、STALE_BINDING/implementation 拒绝及 APPROVAL_EXPIRED。过期提示重新 prepare/review，不自动延长。普通预览隐藏 expiresAt，稍后交接与 verbose 给出准确有效期。
- [ ] 运行 `npm run test:v1 -- packages/cli/test/v1/publish-confirmation.test.ts packages/cli/test/v1/human.test.ts packages/cli/test/v1/usage.test.ts packages/cli/test/v1/loop.test.ts`；原有取消/业务退出码保持不变。

### 任务 7：动态输出集成与只读 status（T07–T12、T15）

**Files:** 新增 CLI `src/render/publication-output.ts`、`test/v1/publication-output.test.ts`；修改 `commands/{publish,status,context}.ts`、`io.ts`、`render/human.ts` 和测试 harness。

**Interfaces:** `createPublicationOutput(io,options)` 返回 `update(view)`, `diagnostic(safeText)`, `finish(view)`, `close()`；CliIo 提供可选终端列/行读取及 resize 订阅清理接口。Core onProgress 仅由 human 本地发布接入；JSON 不创建动态控制器。

- [ ] 写 stdoutTTY/TERM=dumb/redirect/高度不足/resize 矩阵：只有布局可完整容纳且可安全控制才重绘；降级后不再向非TTY发送控制序列；追加模式初始化内容一次、只追加改变的状态、最后完整结果。
- [ ] 将任务 4 的已提交快照接到共用 renderer；status --operation 只一次投影读取并用 recorded 模式，其他 status 布局不变。v 展开之后保留已展示全文，不被缩略重绘覆盖。
- [ ] 在 finally 恢复光标、清理 resize/signal/stream error listener；stderr 诊断先暂停重绘。stdout write 抛错、异步 error/EPIPE 被输出层记录，关闭渲染后允许 Core 安全完成或正常中断，不能回落成 Provider unknown 或额外发布；最终输出故障可非零，业务事实仍由存储判定。
- [ ] 写 JSON+verbose canary/审批token 测试：stdout 一 schema-valid envelope，stderr 仅固定安全诊断；查询/过期/未知不访问原文件或 Provider，stateTree 不变。
- [ ] 运行 `npm run test:v1 -- packages/cli/test/v1/publication-output.test.ts packages/cli/test/v1/human.test.ts packages/cli/test/v1/lazy-init.test.ts`；用伪终端测试 resize、Ctrl-C、结束恢复。伪终端工具若不可用，明确未验证物理终端行为，不冒充通过。

### 任务 8：跨运行时契约、文档与最终验收（T10、T11、T14、T16）

**Files:** `packages/sdk/test/{client,transport}.test.ts`、`packages/sdk/test/support/wire-fixtures.ts`、`packages/server/test/http/server.test.ts`、`packages/cloudflare/test/worker.test.ts`；`README.md`、`AGENTS.md`、`docs/{cli-manual,agent-quickstart,remote-compatibility,testing}.md`、`packages/cli/skills/syndroo/`、`packages/cli/test/v1/{surface,usage,package}.test.ts`。

- [ ] SDK/Server/Worker fixture 同时覆盖旧响应、新字段、未知字段兼容与整体预算；HTTP 202 仍只是已持久化受理，不能当作成功发布；测试不需要真实服务账号。
- [ ] 实现后同步 --help/手册/Skill：yes/v、3行摘要、verbose、JSON 单 envelope、控制终端及历史快照；AGENTS 的 retired --yes 条目改为此次授权的新语义。remote compatibility 明确本次协议字段扩展，以及验证过的客户端/服务端组合，不声称所有旧客户端兼容。
- [ ] 先运行 `npm run build`；再运行 `npm test`、`npm run check`。有 provider manifest 改动则 `npm run check:provider-catalog`；生成产物重跑 `npm run generate:protocol` 应无二次漂移。执行 `node packages/cli/dist/bin.js publish --help` 和 `status --help`，仅检查帮助，不运行真实发布。
- [ ] `git diff --check` 并逐项查看最终 diff；核对以下覆盖表、旧数据不变、无 secrets、无 notes/ 变化，且 build/check 没有 PENDING。只有查看实际输出后才勾选通过。
- [ ] Astra 最终复核身份/审批、retry 快照、持久化通知、stdout 故障和安全诊断边界；交付本地 diff、测试证据与剩余未验证项，不 commit/push/deploy。

## T01–T16 覆盖与未知点

| 验收 | 负责任务 |
|---|---|
| T01 名称/歧义 | 2、5 |
| T02 身份与历史 | 1、2、3 |
| T03 Unicode/注入 | 5 |
| T04 摘要/v/确认 | 5、6 |
| T05 冻结/过期/绑定 | 2、6 |
| T06 参数组合 | 6 |
| T07 串行真实进度 | 4、7 |
| T08 失败隔离/持久化 | 4、7 |
| T09 状态/汇总 | 5、7 |
| T10 单 JSON | 6、7、8 |
| T11 敏感信息 | 1、2、5、7、8 |
| T12 查询只读 | 3、5、7 |
| T13 retry/幂等 | 3、4 |
| T14 协议/三存储 | 1、3、8 |
| T15 终端恢复/降级 | 7 |
| T16 文档 | 8 |

未决事项按证据处理，不扩展任务：官方各平台账号名称/主页只能使用现有响应可证字段；缺失允许 fallback。旧记录无 claim 的历史 retry 若不能确定快照轮次必须显示不可用，禁止改写旧摘要。列宽辅助库与伪终端运行环境在实施前核对现有依赖/可用工具，缺环境单独报告。当前生成器显式提供 relaxed response validators，不能把“所有旧 SDK 必然拒绝新字段”当事实；兼容性结论以实际版本 fixture 为依据。

**当前阻碍：** 项目镜像 AGENTS 要求实现委派 `deepseek/deepseek-v4-flash` via codex-router，默认 fallback 为空。主代理已核实 native tools 未提供该模型，PATH、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin` 无 codex-router；此为路由不可用，不是已发起实现后被拒绝。没有模型替代、实现尝试、产品测试、真实发布或提交。本轮唯一交付是此计划；后续需恢复指定路由或取得明确的替代路由授权。


## Coordinator review gate (Astra, during implementation)

Magpie exact DeepSeek v4-flash route is now explicitly authorized and verified. The original route blocker above is resolved. Branch codex/publish-output-20261014 was created by the coordinator. Continue implementation without changing models or persistent settings.

Before declaring task 1 or final acceptance complete, read /Users/daiyanze/Documents/Codex/2026-10-14/task-2/scratch/protocol-review-findings.md and fix its three reproduced issues through this same DeepSeek route with regression tests: arbitrary single-line diagnostic secret, strict sibling validation lost during optional-field sanitizing (__proto__/non-enumerable/Symbol), and U+061C in display URLs. These are coordinator-delivered review findings, not a new product scope.

### New Task 5 review gate
The coordinator has appended four NEW reproduced renderer findings (7–10) to `/Users/daiyanze/Documents/Codex/2026-10-14/task-2/scratch/protocol-review-findings.md`. Re-read that file after Task 6 and resolve all four with regressions before final acceptance. Earlier six findings have independently passed 41 tests. Continue same authorized Magpie DeepSeek v4-flash route.

### New Task 6 review gate
Finding 11 appended to the same coordinator review file: confirmation ignores false from writeTty and still executes on y; must stop before reading/executing when preview/prompt cannot be displayed. Add preview/prompt/v failure tests. Findings 7–10 also remain open per Task 6 checkpoint. Resolve all before final acceptance.

### F09 follow-up before final acceptance
The coordinator found default Emoji_Presentation glyphs without VS16 (☔, ⌚, ⏰) are still counted as one cell by current terminal-text.ts. Read the newest finding-9 follow-up in the same review file; cover Unicode Emoji_Presentation, not only VS16, with regression tests.

### Task 7 review gate
New findings 12–14 appended to coordinator review file: abort closes output before final unknown/warning/query can print; physical terminal auto-wrap not counted (also width resize); missing real CLI two-target blocked-provider progress/failed-output integration. Read and fix these before final acceptance.

### Task 8 doc consistency gate
Finding15 in coordinator review file: actual wire field is diagnostic (type SafeDiagnostic), not safeDiagnostic, in five newly edited docs. Bundled delivery-semantics must say frozen presentation IS covered by intent digest, while identity/selection/provider payload are unchanged. Check these alongside pending12–14 and Emoji_Presentation before final acceptance.

### Final CLI residual F13
Finding17 in coordinator review file: ceil(totalWidth/columns) undercounts CJK in odd columns (中中中 at3 columns is3 rows, not2). Prefer simplest safe appended fallback whenever any line exceeds columns, or correctly simulate grapheme wraps. Add regression. Fix in current resumed pass before ending.

### Urgent F16 residual before final response
Finding18 appended to coordinator review file: legacy ready/null or not_started with missing/nonmember current intent still falls back to stale history. Return unavailable if unproven, add4 fixtures. Concrete round0fail→round1stopped-beforeclaim→round2other-target makes stalehistory wrong. Current-member fix works; fix residual in current resumed process.

## Final acceptance — completed

Implementation used the user-authorized Magpie route with `opencode-go/deepseek-v4-flash`; Astra performed final core/security and CLI reviews. Findings 1–18 are resolved, including the four legacy retry-projection cases and ambiguous wide-character terminal wrapping. Earlier pending review gates above are historical.

Independent coordinator verification on the completed source:
- `npm run build`: 11/11 packages built.
- `npm test`: 11/11 package checks and test stages passed.
- `npm run check`: 11/11 checks, zero static failures.
- `npm run test:v1 -- --maxWorkers=4`: 88 files / 903 tests passed, zero failed or skipped.
- Provider catalog current; protocol regeneration byte-identical across six artifacts; `git diff --check` clean.
- Real PTY normal/abort smoke and 40-column wrapped-row check passed. PTY evidence checks emitted control sequences, not a terminal emulator's rendered grid.

The final local run allowed localhost and used an isolated temporary npm cache, resolving earlier sandbox-only failures. No live SNS publish, remote push, deployment, credentials change or commit was performed. Branch: `codex/publish-output-20261014`; base HEAD: `88216d2db2ccc0b89acbfae434aa6912b7b383b2`. Pre-existing `notes/` remains outside this change.
