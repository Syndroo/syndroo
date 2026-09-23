# Syndroo 0.5.0 — 可靠性、授权闭环与可移植存储/队列架构

- 文档版本：2.0（整合修订版）；日期：2026-09-21（Asia/Tokyo）。
- 状态：**待评审设计规格；不是已实施、已测试或已发布的版本**。
- 用户已确认：推荐 B 范围与合理抽象；随后明确要求将 Portable Storage & Queue Architecture Spec 合并进同一 0.5.0。新增存储/队列要求扩展了原 B，不再沿用与其冲突的“不加 outbox/ports”约束。具体整合选择仍是待评审设计。
- 本轮交付：本会话文件；不修改源码、不执行迁移、不发布、不部署、不调用真实 SNS。
- 基线：`main@d8206f298333eeb83d45d319ea244bbda72c78f7`。该基线来自 v1 文档与此前源码审查；本轮只读取会话附件，没有重新连接/检查仓库，因此不声称它仍是最新 HEAD。此前复现结果不是本轮重跑结果。
- 规范层级：用户需求及新增附件的规范保证优先；本文件与 [基础设施契约](07-CONTRACTS-AND-FAILURE-MATRIX.md) 是无冲突的合并规范；[整合审查](06-INTEGRATION-REVIEW.md)逐项披露解释/取舍，原附件逐字保存在sources目录。[架构决策](02-ARCHITECTURE-DECISIONS.md)解释取舍；[验收矩阵](03-ACCEPTANCE.md)定义证据；[交接说明](04-HANDOFF.md)仅提供后续实施准备。

## 1. 版本目标与边界

### 1.1 要交付什么

0.5.0 是一个可靠性、授权完整和执行模型可移植版本，而不是 SNS 平台数量扩张版。Cloudflare 是 reference deployment，不是领域模型的一部分。主要用户仍是单用户自托管的开发者、创作者和通过 Skill/CLI 操作的 Agent。

完成下面这条链路，并在每一步给出真实、可恢复的结果：

```text
配置实例 → 配置/连接平台 → 确认目标 → 校验内容
    → 创建任务（稳定幂等键）→ 事务 Outbox → Queue/调度唤醒执行
    → 查询每个平台的结果 → 故障后按确定性恢复
```

**必须包含：**原 B 的六项缺陷、统一凭据解析、OAuth/state/refresh 并发、连接绑定、SDK/CLI/Skill 授权、必要迁移与安装产物验收；加上 Domain/Application 的 portable ports、Cloudflare D1/R2/Queue adapters、独立 `outbox_jobs`、版本化消息、业务重试 outbox、基础设施重试/DLQ、长期调度、私有脱敏归档、最小凭据加密、索引/有界清理/可移植契约测试与运维诊断。

**存储的最小交付层级：**本版实现 `ArchiveStore + R2ArchiveStore` 的生产诊断路径；同时定义 `BlobStore` 并实现/测试独立 R2BlobStore，但不开放媒体上传或 SNS 媒体发布 API。`CredentialCipher` 采用标准 AES-GCM envelope 的最小实现；自动轮换、KMS 和跨库迁移工具仍不实现。这里是对附件 SHOULD 的明确整合选择，不冒充附件指定的算法。

**明确不包含：**新 SNS 平台、媒体/长文产品能力、UI、多租户、多账户产品、团队权限、通用插件市场、自动密钥轮换/KMS、完整 observability 平台、PostgreSQL/S3/Redis production adapter、Docker/Railway/Fly 部署、跨数据库迁移 CLI。每分钟有界 dispatcher 和基本积压诊断已纳入；不承诺高吞吐扩容或精确秒级调度。真实发布/生产变更仍需另行授权。

“没有多账户产品”不等于“忽略换号”：每个平台仍只有一个有效凭据槽位，但任务必须绑定当时确认的连接，不能跟随槽位中的新账号。

### 1.2 稳定性优先级

优先顺序是：不误发/不重复发 > 不丢失可恢复的本地工作 > 准确报告 > 正常路径速度 > 代码行数。Ponytail 用来删掉无收益复杂度，不删除输入验证、并发保护或必要回归测试。

本次采用“保留现有模块化单体，优化真实边界”。不是只打补丁，也不是重建 Clean Architecture 框架。备选方案与不采用的理由见 ADR-050-01。

## 2. 当前问题到设计的映射

以下位置均相对上述提交；完整依据见 [基线与来源](05-SOURCES-AND-BASELINE.md)。

| 问题 | 当前代码依据 | 0.5.0 的决策 |
|---|---|---|
| D1 授权后仍被创建准入拒绝 | `posts.ts:160–181`；`publishers.ts:9–25` | 请求结构解析不读取配置；准入/状态/执行使用同一个 resolver |
| 三个平台使用当前本地 workerd 拒绝的 redirect 参数 | `x/src/index.ts:32–38`；Tumblr `76–81`；LinkedIn `47–58` | 统一 `manual`，原生 fetch + 出站边界测试，不靠 fetch mock 证明兼容 |
| 凭据读取故障误判为远程发布不确定 | `publishing.ts:43–74,180–190` | 准备在 claim 前完成；准备、调用、落库分开处理 |
| 异常 2xx receipt 丢失写入不确定性 | `sdk/src/types.ts:139–146` | 所有解析层必须透传 status/operation/应用可能性上下文 |
| LinkedIn callback 覆盖目标元数据 | `auth.ts:405–417` | callback 产生候选结果；确认目标后才原子激活；refresh 不整条替换 |
| SDK 独立进程等待提前结束 | `sdk/src/client.ts:545–577` | 活跃 wait 的 timer 默认保持进程存活；完成/中止后确定清理 |
| 同一平台配置存在多个不同结论 | `platform-descriptors.ts:51–80` | 一个解析结果，多个只读投影，不维护三套 Boolean 判断 |
| 领取、重连、刷新存在交错窗口 | `repository.ts:207–284,365–437` | 快照版本、事务条件更新、领取令牌、刷新前互斥 |

这里的 workerd 结论只对应历史实际复现的依赖组合。当前公开 Request 文档列举的参数与该本地运行时表现并不完全一致；设计选择 `manual`，不宣称所有 Cloudflare 版本均不支持 `error`。[E1]

## 3. 架构与合理抽象

### 3.1 逻辑依赖方向

```text
Skill → CLI → public SDK → HTTP API（Cloudflare runtime entry）
                                  │
                 composition root：注入普通配置与端口实现
                                  ↓
                 @syndroo/application（私有、runtime-neutral）
                 ├─ createPost / executePublication
                 ├─ auth lifecycle / credential resolution
                 ├─ retry policy / outbox dispatch / housekeeping
                 └─ ports：PublishingStore、CredentialStore、OutboxStore
                           JobQueue、ArchiveStore、BlobStore
                           CredentialCipher、Logger、只读诊断
                                  ↓
                    @syndroo/core（domain / provider contracts）

Cloudflare D1/R2/Queue adapters ───→ application ports / core
Platform adapters ────────────────→ core + private transport
WebCrypto implementation ─────────→ CredentialCipher port
```

箭头表示源码依赖，不表示“Domain 依赖 ports 再依赖基础设施”。Application 只看自身定义的 ports 与 core，绝不 import `@syndroo/cloudflare-worker`、`cloudflare:workers`、Env、D1/R2 类型、Queue message、ExecutionContext，type-only import 和 ambient types 也算泄漏。端口使用普通 TypeScript 数据、UTC 时间、Uint8Array/标准流，不返回 D1Result/R2Object。

公开 SDK 不依赖私有 domain/application/transport 包。五个平台的 typed credential 由各 adapter 自己持有；composition root 通过普通函数构造已封装类型关联的 platform strategies 注入 application，不让 application import 具体平台包。静态策略是现有五个平台的真实差异，不是动态插件框架。

### 3.2 模式及其真实责任

| 机制 | 责任 | 刻意不增加的内容 |
|---|---|---|
| Ports & Adapters | 隔离存储、队列、归档、密钥、运行时的替换边界 | 不做多层纯转发 Service/Manager/Interactor |
| Adapter + Strategy | 平台凭据、请求、成功信号与错误归一化 | 不做 BasePublisher hook 继承树 |
| Composition Root + 静态构造 | 只在外层把 Env/bindings 转为普通 config 和端口实例 | 不做反射、自动扫描、DI 容器 |
| Repository / 语义事务端口 | 一次业务原子操作跨 Post、Publication、Outbox、幂等信息 | 不暴露 SQL、任意 transaction callback 或泛型 CRUD |
| Transactional Outbox | D1 原子保存待发送意图，broker 可重复投递 | 明确新增 outbox_jobs；不是通用事件总线/事件溯源 |
| 有限状态机 + CAS/fencing | 领取、重试、迟到写回、DLQ 的竞态规则 | 不增加每状态一类或工作流引擎 |
| Facade | SDK/CLI 暴露统一 posts/auth/diagnostics | 不在客户端复制服务端重试规则 |

独立 `outbox_jobs` 取代 v1 的 publication 兼任 outbox；D1Repository 保留为具体 Cloudflare 实现，但 application 对它零依赖。新增 port 已有明确可移植需求，不能再用“目前只有一个生产实现”拒绝它；也不意味着要现在开发第二套生产基础设施。

### 3.3 文件归属

| 位置 | 本版职责 |
|---|---|
| `packages/core/src/` | Post/Publication/Publisher/PublishError 等既有域契约；平台中立 ID/time/结果类型 |
| `packages/application/src/ports/`（新） | 按行为分组的持久化、消息、存储、cipher、logger 端口；不按表机械造 repository |
| `packages/application/src/`（新） | 从 Worker 提取 create/execute/auth/credential/retry/dispatcher/maintenance 应用逻辑 |
| `packages/<platform>/src/` | 现有 typed provider strategies、请求与响应规范化 |
| `packages/transport/`（新、私有） | 有界网络生命周期及严格 OAuth1 签名工具；没有业务重试或日志 |
| Worker `src/composition/` | 唯一 Env mapping、配置校验、静态平台组装、端口 wiring |
| Worker `src/infrastructure/d1/` | 具体 D1Repository 可 implements 多个窄端口；SQL、rows_read、事务优化留在这里 |
| Worker `src/infrastructure/r2/` | R2ArchiveStore/R2BlobStore；private 访问和 bucket/prefix mapping |
| Worker `src/infrastructure/queues/` | CloudflareQueue producer、版本解析、ack/retry/DLQ runtime mapping |
| Worker `src/infrastructure/crypto/` | 使用 WebCrypto 的最小 CredentialCipher；无 KMS 框架 |
| Worker `index.ts`、`api.ts`、`jobs.ts`、`scheduler.ts` | 薄运行时 handlers；可保留原文件名作为外部接线点，不留第二份业务逻辑 |
| `packages/cloudflare-worker/migrations/` | 路径不搬家，保留既有 deploy/package 兼容，只追加迁移 |
| SDK / CLI / Skill | 既有 B 的公开门面，另加只读 diagnostics 投影；零私有安装依赖 |

新私有 `application` 与 `transport` 都必须参与 root build/check、Worker bundle、许可证和 tarball 校验；不得把私有包留作公开 npm 安装时缺失的依赖。具体目录可微调，依赖边界不能被降格成只靠注释约定。

### 3.4 术语与公开 API 保持连续

新增附件第6节允许保留现有名称；这里保留已有 `Post` 与 `Publication`，不直接把旧 Publication 改为多平台聚合。

| 新附件概念 | 本仓库落点 | 约束 |
|---|---|---|
| Post canonical content | 现有 Post 的 content/overrides（受理后不可变） | 不把 raw HTTP body 当 canonical content |
| Publication publishing intent | 现有 Post 的目标列表、scheduledAt、聚合结果 | 本版不增加可复用 Content 实体或草稿产品 |
| Delivery：intent × destination | 现有 Publication | 保持每平台独立 outcome、attempts、目标 binding |
| Connection | 现有每平台 credential slot 的 binding/revision 元数据 | 不引入多账户管理；敏感 payload 改为 encrypted envelope |
| Delivery execution job | OutboxJob(kind='delivery.execute', entityId=Publication.id) | 名称映射写入契约测试 |

`POST /v1/posts`、receipt、既有 status 枚举不改成附件中的概念示例 `/publications`。内部可明确 `unknown` / `dead_lettered` 结果，公开仍使用 failed 加 errorAmbiguous 与新增安全 `terminalReason` 投影；不要同时维护两套不同的 Delivery 记录。映射细节见基础设施契约第2节。

## 4. 统一凭据解析与状态

### 4.1 唯一事实来源

`resolvePlatformCredential(platform, decodedSnapshot, config, now)` 负责合并合法来源、解析字段、验证目标格式与已知过期时间，返回 ready 或 blocked。它是纯逻辑，时间作为显式参数，不请求平台、不写存储。解密是调用 CredentialCipher 的独立准备步骤；`config` 是 composition root 产生的普通值，不是 Env。

结构示意（设计契约，不是可直接覆盖的源码）：

```ts
type CredentialResolution<C> =
  | { kind: "ready"; credential: C; summary: SafePlatformStatus; snapshot: BindingSnapshot }
  | { kind: "blocked"; reason: ConfigIssue; summary: SafePlatformStatus };
```

`C` 是注入的平台策略内部的类型，不是贯穿系统的 `Record<string, string>`。通用 JSON 只存在于外部输入/持久化边界，随后必须 decode。动态平台分派在 composition root 注入的静态策略内封装类型关联，禁止用 `as any` 或重复的运行时猜测掩盖关联错误。

直接提交的 user credential 与最终合并后的 publishing credential 不是同一种输入：前者没有 Env app secret。可以有两个明确的 decoder，但底层字段规则必须复用，不能复制三套“配置完整”判断。

### 4.2 合并规则

1. 有有效 D1 凭据槽位时，用户凭据作为完整一组使用；不把 D1 access token 和 Env 的另一个 token secret 拼接。
2. X/Tumblr 的 app credentials 仍从 runtime secrets 经 composition root 获取；平台目标字段的允许 fallback 在 descriptor 中显式列举。
3. D1 中存在损坏、缺字段或已过期的凭据时，返回 blocked，不静默退回 Env 的另一个账号。
4. 没有 D1 用户凭据，或它已被显式删除时，可以按现有契约使用 Env。这个来源切换必须改变任务 binding。
5. 缺失 app secret、非法 blog/author/version、非法日期和非对象数据均是受控错误；不能变成无上下文的 TypeError/500。
6. `expires_at` 必须被读取和解释；未知 expiry 不冒充永不过期，不通过任意 truthiness 判断决定过期时间。

### 4.3 公开状态

继续保留既有 `configured`、`source`、`oauthSupported`。新增 `readiness`、`missingFields`、`expiresAt`、`revision` 和受保护的操作结果查询。

`readiness` 取 `ready | missing_credentials | needs_configuration | expired | reconnect_required | unavailable`。`configured` 是本地 readiness 为 ready 的兼容投影；不表示已对真实 SNS 验权。`source` 按实际被使用的来源计算为 `env | credential | mixed | null`，不是“Env 中恰好也有值”。

`configured=true`、成功存储、OAuth 拿到 token、真实发布成功是四个不同事实。状态不返回 token、password、client secret、refresh token、binding HMAC 或 OAuth state。

实例配置与平台配置分别报告：`GET /v1/auth` 增加 `instance: { publishingReady, missingFields }`，只返回缺少的配置名称。binding key 缺失/非法时，`publishingReady=false`，创建返回503/INSTANCE_NOT_READY，而不是把它伪装成某个平台未配置。`SYNDROO_PUBLIC_URL` 仅阻止OAuth启动，不阻止已正确配置的直接发布。新CLI doctor同时检查这两个层面。密文读写所需SYNDROO_CREDENTIAL_KEY/keyId缺失或配置非法同样反映instance readiness，不能以Env fallback绕过已有密文槽位。

## 5. 创建、幂等与发布状态机

### 5.1 创建順序与一个事务

```text
Bearer → maintenance → 64KiB/JSON/结构校验
  → 幂等查找
     ├─ 同key同内容：原receipt，不查当前凭据、不新增outbox
     ├─ 同key不同内容：409
     └─ 新请求：read/decrypt/resolve全部平台和binding（无SNS）
          → PublishingStore.createPostWithDispatch(...)
             一个逻辑事务：Post + Publications + 每项initial OutboxJob + key
             同时保证expected credential revisions仍成立
          → 可选快速dispatch同一批已提交outbox
          → 202（受理），Queue暂时失败可返回enqueueDeferred
```

幂等仍可保留 `posts.idempotency_key` 的现有唯一约束；0.5.0 单用户、单 create scope，不为了概念示例新建同义 idempotency_keys 表。端口显式标记 scope=`posts.create.v1`，未来出现第二命令/租户才扩展物理表；同一业务 key 与请求的归一化比较规则不变。

三个表集合及key必须全有或全无。D1 `batch()` 会在语句错误时回滚，但 CAS 0 行不是 SQL 错误；实现须让所有关联写入使用同一逻辑 guard/提交标识，并检查影响行数，不能提交部分数据后返回 conflict 冒充回滚。[E2] Application 不传 SQL、D1 statement 或 transaction callback；业务端口直接保证原子性。

### 5.2 Consumer：先准备，再领取，按当前job执行

```text
runtime校验versioned envelope → executePublication(job)
  → load Publication + 对应OutboxJob
  → terminal / 非current_job_id / 已过时：settled（零平台调用）
  → 到期判断；credential read/decrypt/resolve/binding，纯构造Publisher
  → 原子claim：status可领取 + current_job_id匹配 + 到期 + attempts<3
                 + credential revision匹配
  → 固定Publisher快照执行（claim后才可登录/发帖）
  → claim token + jobId条件下原子保存结果和Post聚合
```

`outbox.status='dispatched'` 不是 consumer 执行的必要条件：Queue 可能先送达而 producer 尚未写回 dispatched。是否执行由 current_job_id、到期时间、状态和领取 guard 决定。

准备期 D1 临时失败不 claim、不增加 attempts、不成为 ambiguous；返回可移植 `infrastructure_retry` 结果，由外层转为 Queue retry。已知配置错误/绑定失配/未复核 legacy 通过条件事务记为 failed/AUTH/非 ambiguous；不发给新账户。secret/key 配置问题也不能静默退回明文或另一个账号。

claim 未中选或 claim 结果未知时不得调用平台。被领取的 job 再次到达时直接返回 settled，不制造“占位重试直到 DLQ”；活动 claim 的崩溃由 D1 stale recovery 处理，而不是依赖重复消息继续存活。准备后的快照不能在 claim 后被“最新token”替换。

### 5.3 状态转移

公开枚举保持不变，内部通过 `terminal_reason`/`current_job_id`/`retry_at` 明确调度语义。

| 当前状态 | 事件 | 转移和持久行为 | runtime结果 |
|---|---|---|---|
| scheduled | outbox到期且claim CAS成立 | 原子激活并claim为publishing，attempts+1 | 执行provider |
| pending | 准备期基础设施错误 | 不耗provider预算；记录能力不足时只保留原意图 | infrastructure_retry |
| pending/scheduled | 永久配置/绑定失败 | failed/AUTH/非ambiguous，取消未发送关联job | settled |
| pending/scheduled | 到期且claim成功 | publishing，attempts+1，随机claim token与attemptId | 执行provider |
| publishing | provider确认成功 | published，当前结果与Post聚合同事务提交 | settled |
| publishing | 明确未应用且可重试、未达3次 | pending + retry_at + 新future OutboxJob + current_job_id切换，原子提交 | settled，ACK旧消息 |
| publishing | 明确拒绝/预算已尽 | failed，terminalReason=provider_rejected/attempts_exhausted | settled |
| publishing | 远程结果不确定 | failed + errorAmbiguous=true + terminalReason=unknown | settled，禁止自动重发 |
| publishing | 超过15分钟仍无结果 | 条件恢复为unknown，不创建重发job | 由maintenance处理 |
| 非终态pending当前job | DLQ且从未claim本job | 条件记录dead_lettered/非ambiguous；不是provider失败次数+1 | settled |
| 终态或旧job | duplicate/DLQ/late result | 不覆盖结果、不增attempts | settled |

所有claim之后的provider结果更新都匹配 `status='publishing' AND claim_token=? AND current_job_id=?`。Retry事务失败时，原claim仍存在，不能再发provider；只重试“同一个已知结果的提交”而非业务执行。失去结果的崩溃仍按unknown处理，不凭空重构成功。持久化与队列重试的完整窗口见基础设施契约第5–7节。

### 5.4 两种retry不可混用

Application `retry.ts` 唯一决定业务重试：Publisher最多3次；默认两次间隔60秒/120秒，明确可信的Retry-After更晚时优先。SQL只写入已决定的UTC时间，不维护第二套退避表。原附件的五次阶梯是示例，不覆盖已有三次预算。（原附件§40，见[S-ADD]）

**业务重试：**已确定未产生远程副作用的429/可用性错误 → 同事务更新publication并新增future outbox → 提交后ACK本条。**基础设施重试：**D1/Queue等暂时错误 → 返回 runtime-neutral decision → 外层Queue redelivery。Queue基础设施 `max_retries` 初始3（首次之外的重投次数），不等于Publisher预算。[E10]

发布请求之后的503/超时/连接中断仍可能是unknown。不能把附件§19中的HTTP503举例解释成“一律可重试”；必要证据必须由Provider Adapter归一化，Application不根据平台字符串猜测。SDK、HTTP helper、SNS官方SDK不另行自动重试写操作。

客户端create结果未知与单平台远程结果未知是两个层次，继续分别保留SDK context和Publication.errorAmbiguous。R2失败只影响归档状态，不进入任何provider retry决策。

## 6. 连接绑定：保护旧定时任务，不建设多账户系统

### 6.1 两个不同的版本

- `revision`：凭据槽位的写入版本，用于 CAS，任何成功修改都递增；删除后保留不含凭据的 tombstone，避免删除再创建导致旧版本复活。
- `binding_id`：一次明确授权连接的随机标识。直接重新提交、重新授权完成、目标变更、删除都建立新 binding。同一 refresh grant 的明确 token refresh 成功可以保留；同payload的受控重加密不属于连接变更，亦不建立新binding。

每个平台仍只有一个 active slot。没有账户列表、跨账户路由或账户合并。

### 6.2 Publication binding

新增 publication 内部 `credential_binding`，由固定版本、固定字段顺序的输入元组经 WebCrypto HMAC-SHA-256 得出。使用独立实例 secret `SYNDROO_BINDING_KEY`（至少 32 字节随机值，采用明确编码）；不复用发布 Bearer key，避免普通 API key 轮换使所有定时任务失效。

- Env-only：元组包括 platform、来源、完整有效用户凭据、app credentials、目标配置。
- D1/mixed：元组包括 platform、binding_id、实际 app 配置、目标配置；受控 refresh 更新的用户 token 不进入这个稳定连接元组。
- 外部输入绝不能直接指定 binding 值；摘要仅存在内部存储与校验，不写日志或公开 DTO。

这是相等性/连接连续性检查，不是凭据加密，更不是对真实平台身份的证明。绑定 key 丢失/更换会让未完成任务需要显式复核；0.5.0 不实现多 key 自动轮换。这个新增 secret 是明确的升级前置条件，不得用默认值或缺失时跳过绑定。需要计算/校验binding的发布、connect、complete在key缺失时受控拒绝；状态查询及清除秘密的管理动作不能因缺key而泄露数据或失去可恢复性。

### 6.3 必须保持的边界

D1 更换凭据、D1→Env fallback、Env token/host/author/app 变化都会使旧任务不匹配。受控 refresh 只更新同一 grant 的 token，保留 binding_id 与目标元数据。无法证明属于原 refresh 操作时，不保留连接连续性。

正常 reauthorize 即使人眼看来是同一账号，也默认产生新 binding；本版不额外建设通用身份发现来推断同号。其旧任务不能静默续发，必须让用户重新确认。这是有意的安全/便利性取舍。

所有支持的D1凭据变更都必须经统一repository写入并更新revision/binding。具有直接数据库写权限的管理员绕过这些方法修改secret，不在应用级连续性保证之内；文档不推荐用裸SQL改token。

claim 前替换 D1 槽位：SQL revision guard 拒绝旧快照。claim 后替换：当前执行只持有旧快照，不能拿新账号发旧内容。删除/重连不是对已经发出的 HTTP 请求的撤销；界面、CLI 和文档必须说明这一点。

## 7. OAuth 与凭据生命周期

### 7.1 HTTP 路由和输入

保持现有基础路径；严格匹配路径段与方法，不接受多余后缀。除了精确列出的 OAuth callback，所有 `/v1/*` 仍要求 Bearer。body 保留 64 KiB 上限，新增 auth body decoder 拒绝 null、数组、基本类型与非法字段。

新增非秘密 `SYNDROO_PUBLIC_URL` 作为 OAuth 的 canonical HTTPS origin（仅启用 OAuth 时要求）；回调 URL 从它和已知平台路径生成，不采用请求方任意 Host/redirect 参数。测试使用明确隔离配置，不能让 loopback 测试例外进入生产默认。

### 7.2 授权是两阶段完成，不是 callback 自动覆盖

```text
Bearer connect → 保存 auth operation → 返回 provider URL + operationId
    → 浏览器授权 → callback 原子占用 state → 换取候选 token
    → 保存 awaiting_confirmation/needs_configuration
    → Bearer 读取脱敏候选信息 → 用户确认目标
    → Bearer complete + expected revision → 原子激活新连接
```

两阶段仅用于已有 OAuth1/2 授权，并非通用审批引擎。callback 不再直接覆盖 active credential，因此缺失 LinkedIn author 或 Tumblr blog 时不会破坏已有连接。0.5.0 将这一行为变更写入 release notes：旧的“回调成功即已激活”自动化需要升级。

沿用 `oauth_state` 表作为短期 operation 存储，增加不可预测的 `operation_id`、phase、期望槽位 revision、起始配置 binding、canonical callback 和候选数据。OAuth state 与 operationId 分离：读 operation 必须 Bearer；公开 callback 只接受匹配的 state，不因持有 operationId 获得权限。

对于需要的 author/blog，complete 必须获得明确选择或已验证的平台返回值；不静默继承旧账号的 author。可显示旧目标供用户重新选择，但“用户声明的目标”和“平台验证的身份”必须标注不同来源。LinkedIn API version 必须显式有效，不依靠藏在工厂中的魔法默认值。

### 7.3 state 约束

phase 为 `pending_callback → exchanging → awaiting_confirmation/needs_configuration → completed`，以及终态 `failed/expired`。TTL 从创建起算 30 分钟，不因轮询或重试自动续期。

Application经CredentialStore.claimOAuthCallback语义端口抢占；D1 adapter用一次条件 `UPDATE … RETURNING` 抢占 `pending_callback`，同时检查平台、expiry、OAuth1 request token、起始配置仍有效；只有 winner 能换 token。若当前 D1 运行时的 RETURNING 支持不满足实现形式，应改成同事务内等价 CAS，不可退回 SELECT/DELETE 两次独立操作。[E2]、[E5]

state 与 request token 必须一致。OAuth1 严格 RFC 5849 编码/排序和固定请求范围，由共享、具测试向量的签名函数处理；不能只用裸 `encodeURIComponent` 代替规范编码。[E6]

OAuth2 使用现有保密客户端 authorization-code 方式。PKCE 的启用必须对应平台和 app 实际能力；不能把 LinkedIn 的受限原生 PKCE 文档当成 Worker callback 已普遍支持的证据。已证明支持的配置采用 S256；不支持的现有配置保留一次性 state、固定 callback、保密客户端认证及 Bearer complete，记录安全限制，不做静默协议降级。[E4]、[E7]

受鉴权的 connect 成功响应必须包含可打开的授权 URL，其中不可避免包含协议需要的短时 state/临时token参数；这是有限的交互输出例外，不是通用日志或status DTO的一部分。证据记录必须遮盖这些参数，不把完整URL放入持久日志。

callback 抢占后网络超时/进程崩溃，operation 不能自动重新兑换相同 code/verifier。过期 exchanging 标为失败并要求重新连接。complete 重复调用只重放该 operation 已保存的安全 receipt，不重复换取 token或重新覆盖后来的连接。

### 7.4 Token refresh 的并发安全

refresh 是写操作，不是普通 GET。不能先让两个请求都拿同一个 refresh token 请求平台，再仅靠落库 CAS 挑 winner。

必须先经CredentialStore取得持久refresh lease（Cloudflare实现使用D1），再执行一次外部兑换；并发 loser 返回 409/操作进行中，零外部请求。lease 含随机 token、开始时间与期望 revision。成功提交时匹配 lease 和 revision，原子更新 token/expiry，保留明确的目标元数据与 binding_id，并清理 lease。

无 refresh token 或平台不支持时，返回可执行的重新连接指引，不伪造可刷新能力。新响应没给 refresh token时保留旧值；明确空值/错误类型则作为无效 provider 响应处理。`expires_in` 的0表示立即到期，不是缺省；负值/非有限数/错误类型拒绝。没有新expiry且协议无可靠推导时标为未知，不把旧token的有效期无依据地套给新token，也不描述为永久有效。

refresh 请求结果不确定或崩溃超过安全期限时，不能简单释放锁然后重试可能已轮换的旧 refresh token。标记 `reconnect_required`，保留必要的脱敏诊断并阻止继续自动刷新。新的 direct set/complete/delete 可以取代这一状态；旧 refresh 的 late result 必须因 revision/lease 不匹配而被拒绝。[E4]

当前单用户实例沿用一个Bearer key管理发布和授权，因此该key具有敏感管理权限；本版不声称细粒度权限。合并新增附件后，active凭据、OAuth候选、OAuth1 request-token secret及PKCE verifier使用CredentialCipher密文envelope存D1（第14节）；运行中仍需受控解密，不能声称防御完全失陷的Worker。到期候选清除；历史明文备份另按权限和保留期处理，不能声称已被删除。自动轮换/KMS仍不在范围。

默认不在每次 publish 内自动 refresh，也不新增 Cron token 刷新服务。用户/Agent 可显式执行 refresh；未来自动刷新是独立需求。

### 7.5 最小必要 API 增量

| HTTP | 功能 | 重要结果 |
|---|---|---|
| `GET /v1/auth`、`GET /v1/auth/:platform` | 已有状态查询，扩展安全字段 | 本地 readiness 与 revision，不输出凭据 |
| `POST /v1/auth/:platform` | 已有直接凭据提交 | 完整校验后原子替换，绑定改变，200 |
| `DELETE /v1/auth/:platform` | 已有删除 | 清空 D1 秘密、保留 tombstone revision；可能仍有 Env fallback |
| `POST /v1/auth/:platform/connect` | 推荐的 OAuth 启动入口 | 200，URL + operationId + expiry；不等于连接完成 |
| `GET /v1/auth/:platform/connect` | 保留一版兼容入口 | 转入相同逻辑；no-store，不宣称它无副作用 |
| `GET /v1/auth/:platform/operations/:id` | 查询脱敏候选结果 | active 与 candidate 分开，不把旧配置当新授权成功 |
| `POST /v1/auth/:platform/operations/:id/complete` | 明确目标后完成连接 | 验证 expected revision，原子保存凭据和 receipt |
| `POST /v1/auth/:platform/refresh` | 已有刷新路径，增加 lease 保护 | 保留目标、单次外部调用 |
| 精确 `GET /v1/auth/:platform/callback` | 浏览器回调 | 受控 HTML，候选已收集/失败/需补配置 |

新连接、直接写入、删除和刷新遇到版本竞争返回 409；不得返回200然后丢失调用者的修改。既有客户端可不带 expected revision，由服务器在请求开始读取并用于本次 CAS；新 SDK/CLI 必须传入操作者看到的 revision，防止陈旧确认。已有 operation 的 complete 重放使用自己的 receipt，不要求 current revision 仍等于旧值。

错误仍是 `{ "error": { "code": "…", "message": "…" } }`。允许新增明确的 auth error code，但不改变既有 code 含义；callback 的有限 HTML 是被列明的例外。

## 8. 共享网络防护

私有 transport 返回有界的 status、headers 和 bytes/解析结果；deadline 必须覆盖响应头和 body 读取，不能在收到 headers 后就清掉 timer。大 body、慢 stream、挂起 cancel 都不能无限拖住执行。

固定政策：HTTPS；`redirect: "manual"`；明确拒绝 3xx；每次调用最多一次底层 fetch；发布请求和 OAuth 默认 15 秒、64 KiB（特定请求可取更小值）；释放 reader/timer/listener；不向Logger/API记录 token、body、Authorization 或原始 provider 错误。provider发布响应需要归档时，采用显式、受控的diagnostic投影交给ArchiveStore；OAuth token响应和credential payload一律禁止归档。LinkedIn 的 201 + header 成功契约保留，不强迫它返回 JSON。

平台错误含义仍由各 adapter 判定。wrapper 不能把所有 5xx 变成“安全重试”，也不能判断 OAuth refresh 与普通查询具有同样的重试语义。原始外部 message 不能直接进入 API/log/Agent 输出。

Bluesky 自托管 host 是显式受信配置：只允许规范化 HTTPS hostname，拒绝 userinfo/path/非批准端口与默认私网地址；自托管并不等于允许任意请求转发。不能宣称单靠字符串 host 校验解决 DNS rebinding；本版不提供通用用户自定义 fetch URL 功能。

Cloudflare 文档提醒自动跟随重定向可能转发敏感 header，故这里主动拒绝重定向，而不是为兼容而改成 follow。[E1]

## 9. SDK、CLI 与 Skill

### 9.1 SDK

保持零私有运行时依赖。新增 `client.auth.status/set/connect/operation/complete/refresh/remove` 与只读 `client.diagnostics()`，各方法明确请求方法、返回类型、AbortSignal、deadline 和写操作结果不确定性。

传输支持现有 GET/POST 与 auth 所需 DELETE；没有需求不加入 PATCH。错误上下文区分 post create 与 credential mutation：auth 写入失败的提示必须指向 auth 状态/operation 查询，不能提示重建帖子或使用新的 post key。

HTTP 2xx 的 body 为空、null、数组、基本类型、字段不合法，全部保留实际 status 与 `requestMayHaveBeenApplied=true`。只有确定尚未发出，或按服务端契约收到明确未受理的拒绝时才可宣称false；异常成功响应不能因为parser第一层缺context而改写事实。

`posts.wait()` 的活跃 sleep timer 默认 referenced。成功、超时、Abort 后清理；本版不增加 unref 选项，直到出现真实消费者需求。对构造器和单次调用的 timeout 都做有限正数及 timer 范围校验。`wait()` 只读，不会取消服务端任务。

### 9.2 CLI

新增命令：`auth status`、`auth set`、`auth connect`、`auth operation`、`auth complete`、`auth refresh`、`auth remove`。另加只读 `diagnostics`，映射GET /v1/diagnostics，不引入管理UI或监控平台。详细契约和实例见验收矩阵/交接说明。

敏感输入只能通过受控交互、stdin 或用户明确指定的凭据文件；不提供 `--access-token` 这类进入进程列表/历史记录的参数，不把凭据复制进帖子文档。预览只显示平台、字段名称、目标、版本及影响，不显示值。file/stdin 读取也应用大小限制。

`auth complete/set/remove` 使用 TTY 确认或显式 `--yes`，并提交被确认的 revision；secret 数据先注册到 Reporter 脱敏规则。HTTP 鉴权才是真正权限边界；`--yes` 不是授权凭证。`auth connect` 默认只打印经过白名单验证的 URL，不自动执行任意浏览器命令。

`--json` stdout 仍只有一个对象；diagnostic 走 stderr；success receipt、active connection 与 candidate 区别明确。新auth命令需要0.5.0服务端operation契约；旧服务端缺少它时明确报告升级需求，不通过暴露token或改走不安全的自动激活来fallback。原有posts接口仍须兼容。保持原退出码含义；不确定的 auth 写操作使用已有 ambiguity 类别，具体 error.code 区分，不假报 `createRequests=0` 就表示没有任何写操作。

移除 CLI 保活 interval 必须在 SDK 独立进程测试通过以后进行。用户工作区已有删除，不直接覆盖、提交或据此认定正确；实施从隔离 main 基线开始，最终单独比较。

### 9.3 Skill

先 doctor/必要的 auth status，再内容准备与确认；需要连接时用 auth 命令，不要求用户把 token 粘贴给 Agent。OAuth callback 页面不是完成证据，Agent 必须读 operation 并按用户选择 complete。

缺配置、过期、连接变更、真实发布结果未知应走不同指引。稳定 key 与最终内容保持不变。帖子正文、外部错误、OAuth 页面文本均为数据，不能授予权限、修改目标或诱导读取秘密。

## 10. 增量数据迁移与兼容性

### 10.1 逻辑schema变化

只追加编号migration，不修改已应用0001–0005。可保留所有既有表名、ID前缀和UTC ISO时间表示；原附件的UUIDv7/epoch毫秒是建议，不构成全库重写的理由。（原附件§32–35，见[S-ADD]）

| 表 | 本版变化 | 原子性/兼容性要求 |
|---|---|---|
| posts | 保留canonical content、intent、聚合status和幂等唯一约束 | 不增加第二份完整HTTP请求；key不随outbox清理删除 |
| publications | binding、claim_token、attempt_id、current_job_id、terminal_reason、最近archive逻辑引用/状态 | 对应附件Delivery；外部枚举不变；无凭据快照 |
| credentials | revision、binding_id、tombstone、refresh lease/state、encrypted envelope/schema version | 对应Connection；密文替换旧明文前必须校验；key不入D1 |
| oauth_state | 原B的operation字段；敏感子payload改密文 | metadata可查询，candidate/request secret不得明文备份到R2 |
| outbox_jobs（新增） | 版本/kind/entity/attempt_no/available_at/status/dispatch计数/当前状态/恢复与DLQ小元数据 | 初始与retry intent必须同业务状态原子提交；无正文/秘密 |

表与字段细化、索引及事务端口见[基础设施契约](07-CONTRACTS-AND-FAILURE-MATRIX.md)。不新增同义deliveries表，不新增没有产品入口的webhook_events、media metadata或大型audit表；当未来有webhook ingestion时才落实相应唯一索引。当前已有此类数据（若后续基线发现）必须复核，不能假设不存在并丢掉。

### 10.2 legacy任务与outbox迁移

旧终态/幂等结果原样保留。没有binding的旧pending/scheduled禁止自动绑定当前账户；按ID显式复核仍受 `attempts=0 && !ambiguous && binding为空` 条件限制，不复活已执行记录。

迁移只为旧非终态scheduled/pending建立唯一initial job，available_at取规范化原scheduled_at、retry_at与cutover时间的最大值；原attempts保留；仅attempts<3且非ambiguous时建立attempt_no=attempts+1的job。旧pending的预算已经耗尽时不建新job，按条件事务结束为attempts_exhausted；记录自相矛盾或原结果不确定则保留需人工核实，不从迁移推导“确定未发送”。生成新job不代表目标已获复核：未复核在新执行器中仍fail closed/AUTH/零平台请求。旧publishing不建立可执行新job，按旧claim恢复/人工核实处理。transactional backfill和迁移重跑必须不会产生重复job。

旧队列只有publicationId、没有version/jobId，不在新consumer里“猜一个current_job_id”后继续执行。cutover先暂停旧consumer/cron并检查in-flight；新profile使用单独versioned物理队列，旧队列保留供核实/排空，新outbox驱动新队列。不自动purge。仅凭换一个队列名字仍不安全：必须禁止旧部署恢复消费同一D1。

### 10.3 凭据密文迁移

使用显式维护程序而不是在SQL里放密钥。先增量schema；维护窗口内从旧payload读取、严格decode、CredentialCipher加密、按record/revision CAS提交envelope并清除在线明文字段；每批输出非敏感数量/schema一致性报告；不输出secret、密文或可离线比对的凭据明文hash。失败保留原记录或完整密文记录，不能半清空；崩溃重跑按envelope/schema version识别已完成项。

新代码不自动回退明文；迁移前的旧明文仅供这个受控迁移工具读取，未迁移完成时发布前置检查必须阻止旧payload上线。OAuth临时操作可在cutover取消并要求重连，避免迁移in-flight授权码；绝不重置已消费state。历史备份中的明文不随在线字段清理消失。

### 10.4 配置、发布和回退

新增/调整：独立binding key、Credential key/keyId、canonical public URL、ARCHIVE_BUCKET、可选MEDIA_BUCKET、versioned主队列+DLQ、每分钟Cron、retention配置。保留DB与PUBLICATION_QUEUE逻辑binding名以减少外部模板破坏，物理名称属于部署配置，不写死到application。

receipt/status枚举兼容不等于运行行为完全兼容：callback需complete、token组来源收紧、旧任务需复核、业务retry改outbox、每分钟唤醒、密文迁移和新队列均须release note。旧Worker忽略binding/fencing且不认识密文，不能在additive schema后无条件回退/混跑。

任何真实cutover前均需独立授权，停止旧消费者/触发源、处理in-flight、备份和验证；maintenance只限制准入，不是队列暂停。回退优先停执行而非恢复旧Worker自动发送。数据库恢复不能证明SNS副作用不存在。

三个公共包统一0.5.0-rc.1，验收后再统一0.5.0；CLI精确依赖SDK；新增私有包不对外发布。release train、lockfile、生成bindings、部署脚本和模板必须同时准备。本轮不执行任何发布。[B7]

## 11. 验收与完成定义

完整标准见 [03-ACCEPTANCE.md](03-ACCEPTANCE.md)，机器记录从 [acceptance-results.template.json](acceptance-results.template.json) 开始。所有产品测试本轮均为 NOT_RUN；不能继承以前的通过状态作为 0.5.0 的验收。

必须包含：没有Cloudflare依赖的application全fake契约；纯规则测试；真实 local D1 的迁移/CAS/状态聚合；原生 workerd fetch 的五平台及 OAuth 出站 fixture；独立 SDK/CLI 子进程；打包后 monorepo 之外安装的消费者；兼容/故障注入。测试必须记录实际外部调用次数，不只验证 mock 被调用。

先解决既有 Worker suite 卡住的原因，保留正确性门槛，不靠删除 suite、无限延长 timeout 或广泛替换真实依赖来“绿灯”。Node 22/24 按仓库 CI 目标验证，具体安装版本在证据中记录。

产品完成条件：原六项缺陷与授权/绑定/刷新门槛全部保留；新增ports、outbox、版本消息、业务retry、DLQ、长期调度、R2隔离脱敏、cipher/迁移、query-plan与有界运维门槛全部通过；文档/产物一致。真实平台未经独立授权与验收仍标 experimental/未验证，不能拿 Mock SNS 替代。

本文件的完成条件只是设计一致、边界明确、能够据此编写执行计划；它不证明任何源码已经修复。

## 12. Portable storage、queue和事务契约

Application定义窄行为端口，Cloudflare包提供实现。PublishingStore负责create/claim/complete/retry/DLQ原子操作；CredentialStore负责revision/state/refresh；OutboxStore负责待发送查询和dispatch记录。不要拆成多个各自commit的CRUD方法再由调用者“保证顺序”。同一个具体D1Repository可以实现三者，不引入ORM或泛型UnitOfWork。

JobQueue只暴露 `send(QueueEnvelopeV1)`。domain/application没有Cloudflare delaySeconds、MessageBatch、ack/retry、ExecutionContext；consumer返回通用 settled/infrastructure_retry 结果，由runtime映射。

BlobStore、ArchiveStore、Logger、CredentialCipher是不同语义端口。provider adapter仍持有实际API差异；connection binding通过注入的runtime-neutral签名函数计算，Env mapping只发生在bootstrap。所有端口的最小类型、返回结果、错误约束与原子性后置条件见基础设施契约第3节。

## 13. Outbox、scheduling、重试和DLQ

每个Publication初始/后续安全重试有独立稳定jobId；Queue envelope版本为1，kind=`delivery.execute`，entityId指既有Publication。消息只含ID、版本、时间和可选trace，不能含正文/token/raw archive；consumer验证其与D1 current_job_id和attempt_no的一致性。

D1是调度事实来源，outbox.available_at表示最早运行时刻。reference Cron改为 `* * * * *`，应用只接收now与预算；未来Docker timer/Kubernetes唤醒仍调用同一dispatcher。本版不依赖Queue长delay。官方当前限制单次send/retry delay为24小时；这不是可支持一个月调度的替代品。[E9]

dispatcher从有索引的pending/available_at读取，先send成功再mark dispatched；send结果未知/mark失败允许同job重复发送。业务retry经事务建立新的future job，ACK旧消息，不使用Queue retry实现业务等待。主队列基础设施耗尽进入DLQ，DLQ必须检查current job、terminal与claim状态，不能把已发布覆盖为失败、不能把unknown改成可重试。

`dispatched`不是“已执行”。Queue可能在retention期结束后删除尚未消费的消息，因此另有有界、基于D1的stalled-dispatch恢复；只恢复未claim的当前job，并限制自动恢复轮次。已claim/unknown禁止自动重发。DLQ与retention丢失的处理、旧消息乱序等窗口见基础设施契约。[E9]、[E11]

## 14. R2、归档与最小CredentialCipher

D1只放canonical content、queryable state、时间/状态、短错误、幂等/dispatch metadata、逻辑对象key。大型provider响应、binary、debug log、完整HTTP/webhook payload不入D1。外部SNS permalink仍可保留externalUrl；禁止的是把R2/S3物理URL当持久对象引用，不是禁止所有URL。

R2ArchiveStore是private诊断存储，BlobStore是用户内容存储。生产archive不得公开；单bucket只允许整个bucket都私有再由受鉴权代理区分逻辑prefix，prefix本身不是权限边界。媒体adapter实现不代表本版支持媒体发布。

本版归档provider发布response/DLQ诊断的有界脱敏投影。未知结构默认不归档body；原始OAuth response、cookie、header/token/credential绝不进入archive。成功结果先提交D1，再做有界best-effort archive；archive失败只记录失败/告警，不改变published/unknown、不新建provider retry。无法保证归档必达，不通过往Queue里塞raw payload或把raw body临时存D1来伪造保证。

新增 `SYNDROO_CREDENTIAL_KEY`（base64编码32字节随机密钥）及非秘密keyId，独立于API/BINDING key。CredentialCipher的合并选择是AES-256-GCM、每次新随机96-bit IV、128-bit tag和绑定record/platform/purpose/schema的AAD；envelope版本化，key只在runtime secret。采用标准WebCrypto，不自造加密算法。[E15]、[E16] 具体AAD、迁移和失败行为见基础设施契约第10节。只做最小加密，不做自动轮换/KMS。

## 15. 保留策略、索引和诊断

provider-response归档30天，DLQ诊断90天；webhook/audit分别30/90天仅是未来启用该类别时的政策，不因此增加webhook产品。R2 lifecycle在adapter/deploy配置，application理解expiresAt；到期读视为不可用，不能声称物理对象会在到期秒精确擦除。[E12]

outbox按当前job与terminal/时间条件做有界GC（默认终态关联已结束job保留30天）；不删除active/unresolved job，不顺手删除Post、幂等键或unknown记录。OAuth candidate遵循更短的30分钟期限，不能套archive保留期。

热查询必须有与真实WHERE/ORDER BY对应的索引，并在代表性数据上检查EXPLAIN QUERY PLAN及rows-read/write。基线保留UUIDv4前缀ID与UTC ISO字符串；UUIDv7/整数时间可另行引入但不作为本版移植前提。[E13]（原附件§32–34，见[S-ADD]）

只读GET /v1/diagnostics及SDK/CLI入口报告：pending outbox数量/最老年龄、safe retry数量、dead-lettered数量、archive failures、可得的D1 size信息和采样时间。读路径不发SNS、不写统计计数；不可得时用null+reason而不是0。60%/80%容量阈值是运维建议，不是业务模型硬限。

Free profile相关额度与CPU/查询次数仅在运维附录列明；每分钟dispatcher默认最多20 jobs，D1 adapter按实际statement数量限制总调用预算，并在无待发工作时停止。不能把20/min当作经测量的服务SLA，也不能从“SQL有索引”推导出“永久免费”。[E13]、[E14]、[E17]

## 16. 新附件的保真与整合边界

原附件53节和15条RULE逐项映射于[整合审查](06-INTEGRATION-REVIEW.md)。那里列明：直接采用、保留领域命名后的语义映射、把概念样例改为安全实现的原因、以及明确不做的产品扩展。新的可移植性、一致性、调度和幂等保证不能为了沿用旧实现而被削弱。

这是原B方案的增量整合，而非整个0.5.0推倒重写。旧v1附件逐字保留为sources内的历史ZIP；新附件原文亦逐字保存。实现者只以本包revision2主规格/契约/验收为执行依据，不把旧ZIP或原文中的概念伪代码当成另一份并行规范。

<!-- 跨文件证据索引：代码证据与公开协议事实分开。 -->
[B7]: 05-SOURCES-AND-BASELINE.md#b7
[E1]: 05-SOURCES-AND-BASELINE.md#e1
[E2]: 05-SOURCES-AND-BASELINE.md#e2
[E3]: 05-SOURCES-AND-BASELINE.md#e3
[E4]: 05-SOURCES-AND-BASELINE.md#e4
[E5]: 05-SOURCES-AND-BASELINE.md#e5
[E6]: 05-SOURCES-AND-BASELINE.md#e6
[E7]: 05-SOURCES-AND-BASELINE.md#e7

[E9]: 05-SOURCES-AND-BASELINE.md#e9
[E10]: 05-SOURCES-AND-BASELINE.md#e10
[E11]: 05-SOURCES-AND-BASELINE.md#e11
[E12]: 05-SOURCES-AND-BASELINE.md#e12
[E13]: 05-SOURCES-AND-BASELINE.md#e13
[E14]: 05-SOURCES-AND-BASELINE.md#e14
[E15]: 05-SOURCES-AND-BASELINE.md#e15
[E16]: 05-SOURCES-AND-BASELINE.md#e16
[E17]: 05-SOURCES-AND-BASELINE.md#e17
[S-ADD]: sources/portable-storage-queue.original.txt
