# Syndroo 0.5.0 — 可移植基础设施契约与故障矩阵

文档版本：2.0；状态：Proposed / 未实施。与 [主规格](01-DESIGN.md) 同为本次整合的行为规范。原始附件提供目标和概念示例；下文的具体端口、guard、预算和兼容策略是**整合设计选择**，不是声称原文已经定义了这些细节。

## 1. 必须维持的事实来源

Cloudflare reference profile：D1 保存 transactional/queryable state；Queue 负责可重复的唤醒/运输；R2 保存 blob 与有界归档；Logger 独立输出结构事件。真正的远程发布事实发生在 SNS，D1 保存本系统已知的状态；这不表示 D1 可以消除远程不确定性。

Future PostgreSQL/S3/Redis 替换点是下面的行为端口，不是将 Railway/Fly/Heroku 设计为各自的数据库类。新的基础设施实现仍须具备这些原子性和持久语义；通过 TypeScript interface 不自动证明可移植。未来迁移数据、密钥和运行拓扑仍有工作，本版只避免重写业务。

## 2. 名称、结果与持久身份

### 2.1 保留已有公开模型

| 新附件语义 | 本项目名 | 内部/公开表示 |
|---|---|---|
| publishing intent aggregate | Post | content/overrides + targets + scheduledAt + aggregate status |
| per-destination Delivery | Publication | 一个平台的一次逻辑发布；不同安全重试仍属同一Publication |
| remote outcome unknown | Publication结果 | status=failed, errorAmbiguous=true, terminalReason=unknown |
| infrastructure dead-lettered | Publication结果或Outbox transport metadata | 未claim当前job才可status=failed, errorAmbiguous=false, terminalReason=dead_lettered |
| retry_scheduled | Publication待重试 | status=pending, retry_at=T, current_job_id=新job |
| queued | 已受理、等待transport | public Post仍queued/scheduled；不把outbox dispatched当published |

`terminalReason` 是兼容新增字段，建议取 `provider_rejected | attempts_exhausted | unknown | dead_lettered | binding_mismatch | legacy_unbound | invalid_configuration`。既有 `errorCode` 集合不机械扩展：AUTH/NETWORK/UNKNOWN等配合安全原因字段；SDK容忍未来未知reason，不能因此把未知结果描述成安全重发。

`draft/cancelled` 是原附件的状态示例，不在本版增加草稿/取消API。目标绑定失配不是取消用户原始内容；保存原Post/Publication及幂等信息。未来单独增加Content或多账户功能不能反向改变本版ID含义。

### 2.2 三种ID不能混用

- `Publication.id`：一次逻辑provider写入的稳定业务ID，同时是 `provider_request_key` 默认值。仅当平台明确支持相应幂等机制时传给平台；不能捏造平台支持的header/参数。
- `OutboxJob.id`：某次计划的Publisher执行机会。基础设施重投、dispatcher重复发送、stalled recovery复用同一个jobId；业务retry生成新的jobId。
- `attempt_id` / `claim_token`：claim winner生成的执行记录ID与写回围栏。它们与provider幂等key不同；claim_token不应作为公开凭据或完整日志内容。

沿用应用生成的UUIDv4及现有post_/pub_前缀；新job/attempt亦应用生成。UUIDv7是原附件的推荐，不是为了未来换数据库就必须改ID。UTC Instant在端口中用规范化ISO字符串；禁止SQL timezone/rowid/自增行为进入domain。

## 3. 端口与事务边界

### 3.1 最小接口（设计签名，参数类型由实施阶段按后置条件完整定义）

```ts
interface PublishingStore {
  findIdempotentPost(scope: "posts.create.v1", key: string): Promise<Post | null>;
  createPostWithDispatch(input: CreatePostTransaction): Promise<CreateCommitResult>;
  getExecution(jobId: string, publicationId: string): Promise<ExecutionSnapshot | null>;
  claimExecution(input: ClaimCondition): Promise<ClaimResult>;
  commitExecution(input: ExecutionCommit): Promise<CommitResult>;
  rejectBeforeExecution(input: PreExecutionRejection): Promise<CommitResult>;
  settleDeadLetter(input: DeadLetterCondition): Promise<DeadLetterResult>;
  recoverStaleClaims(input: MaintenanceBudget): Promise<RecoveryResult>;
}
interface OutboxStore {
  listReady(input: ReadyQuery): Promise<OutboxJob[]>;
  recordDispatch(input: DispatchObservation): Promise<CommitResult>;
  rearmCurrentJob(input: RearmCondition): Promise<CommitResult>;
  collectFinished(input: MaintenanceBudget): Promise<CleanupResult>;
}
interface CredentialStore {
  readSlot(platform: Platform): Promise<EncryptedSlotSnapshot>;
  compareAndSetSlot(input: SlotMutation): Promise<CommitResult>;
  createAuthOperation(input: AuthOperation): Promise<void>;
  claimOAuthCallback(input: OAuthClaim): Promise<OAuthClaimResult>;
  saveCandidate(input: CandidateCommit): Promise<CommitResult>;
  activateCandidate(input: ActivationCommit): Promise<CommitResult>;
  acquireRefresh(input: RefreshClaim): Promise<RefreshClaimResult>;
  completeRefresh(input: RefreshCommit): Promise<CommitResult>;
  readAuthOperation(id: string): Promise<StoredAuthOperation | null>;
  cleanupExpired(input: MaintenanceBudget): Promise<CleanupResult>;
}
interface JobQueue {
  send(message: QueueEnvelopeV1): Promise<void>;
}
interface ArchiveStore {
  put(key: ArchiveKey, payload: SanitizedArchive): Promise<void>;
  get(key: ArchiveKey): Promise<SanitizedArchive | null>;
  delete(key: ArchiveKey): Promise<void>;
}
interface BlobStore {
  put(key: BlobKey, body: BinaryBody, metadata: BlobMetadata): Promise<StoredBlob>;
  get(key: BlobKey): Promise<BlobRead | null>;
  delete(key: BlobKey): Promise<void>;
  exists(key: BlobKey): Promise<boolean>;
}
interface CredentialCipher {
  encrypt(payload: Uint8Array, context: CipherContext): Promise<EncryptedCredential>;
  decrypt(envelope: EncryptedCredential, context: CipherContext): Promise<Uint8Array>;
}
interface Logger {
  write(event: SafeLogEvent): void;
}
interface DiagnosticsReader {
  readSnapshot(): Promise<SafeDiagnostics>;
}
```

这不是请求生成十几个空class。三个存储端口可以由**一个具体D1Repository**实现；不同端口对象必须共享同一个原子数据库，不可以悄悄各用一个D1实例。测试fake也必须实现后置条件，不能把Map里顺序写三次叫事务。

BinaryBody限标准Uint8Array或ReadableStream<Uint8Array>；StoredBlob返回logical key、size、contentType和可选校验摘要，不返回R2Object/公共URL。Port不暴露bucket实例、SQLite语句、D1Result/meta、Queue batch/ack/retry/Cloudflare delay、Env或ExecutionContext。Clock/ID/签名可注入小函数，不强制为每个函数增加interface/class。

Application内可由相同静态策略处理平台差异，但不能import具体provider包。composition root负责将已安装的typed策略和普通PlatformConfig注入；type参数被策略自身封装，application只取得Ready/Blocked、不可变Publisher、summary和binding信息。

### 3.2 行为结果与错误

持久化逻辑竞争返回 `applied | already_applied | conflict` 的判别结果；暂时存储故障抛出平台中立StoreUnavailable，损坏记录/配置错误有独立类型。不能把原始SQL错误文本送到API/Agent，也不能将失败都转换为成功的空结果。

Queue consumer的应用返回值仅为 `settled | infrastructure_retry` 加固定reason；retry延迟和message动作属于runtime adapter。Application暂不定义通用Broker API，也不向用户暴露broker重试次数等于provider尝试次数的错误关系。

### 3.3 不允许拆开的事务

| 事务 | 输入guard | 一起提交的状态 | 冲突的语义 |
|---|---|---|---|
| createPostWithDispatch | request key唯一、所有credential revision/slot状态 | Post+所有Publications+初始OutboxJobs+key | 全不写；幂等竞争读取原record比较 |
| claimExecution | current_job_id、job.entity/kind/attempt_no、status、到期、attempts<3、credential revision | publishing+attempt+token+Post聚合 | 不调用provider |
| commitExecution成功/终态 | claim_token+jobId+publishing | publication outcome+Post聚合+本job的小metadata | 旧写回不覆盖新结果 |
| commitExecution安全retry | 同上，attempts预算允许 | pending+retry_at+新current_job_id+future outbox+Post聚合 | 不得留下pending但无job或孤儿job |
| activateCandidate | operation phase/expiry+slot revision+起始配置匹配 | active encrypted credential+新binding+revision+operation receipt | 不得只改credential或只完成operation |
| completeRefresh | lease_token+revision | 新密文token+expiry+revision，原target/binding，lease清理 | 旧refresh不得覆写重连 |
| settleDeadLetter | 仍是当前job，非terminal且无active claim | dead_lettered结果+Post聚合+DLQ小metadata | 已成功/unknown/新job不变 |

D1 batch的事务语义不能代替这些业务条件。D1可以用条件SQL和提交标识让所有写入受同一guard保护；不要在提交之后通过JS发现0行才假称rollback。也不要照搬PostgreSQL数据修改CTE到SQLite。实现后必须用真实local D1执行中断、0行竞争和rollback测试。[E2]、[E5]

`commitExecution` 在同一attempt的提交响应丢失后应可用同一输入/预先生成的新jobId安全重放，返回already_applied；不得因此新建第二条retry intent。最多重试确定的本地结果提交，不重入Publisher。进程崩溃导致已知结果丢失时，不承诺将其重新推断出来。

## 4. OutboxJob模型与dispatcher

### 4.1 字段

| 字段 | 含义 |
|---|---|
| id / kind / payload_version | job UUID、delivery.execute、版本1 |
| aggregate_id | 现有Publication.id，不是Post.id |
| attempt_no | 期望的下一次Publisher序号，1..3；不能由Queue的attempts提供 |
| available_at | 最早执行UTC时间；存储长期调度与业务retry |
| status | pending / dispatched / cancelled；cancelled只表示投递意图不再需要 |
| dispatch_revision | 重置/重排意图的CAS版本，不是provider尝试次数 |
| dispatch_attempt_count | 已记录的dispatch观察次数；crash可能漏记，不当精确计费计数 |
| last_dispatch_error_code | 固定短错误码，不是provider raw body |
| dispatched_at / updated_at / created_at | 持久时间；状态变更不能修改原始created_at |
| recovery_count / recovery_after | stalled transport的有界恢复记录 |
| dlq_seen_at / transport_reason | 当前job的紧凑诊断，不覆盖provider outcome |

至少 `UNIQUE(kind,aggregate_id,attempt_no)` 以及 `(status,available_at,id)`。Publication.current_job_id以普通内部ID保存，避免为循环依赖设计复杂双向FK；outbox到publication有有效外键或同等完整性验证。

### 4.2 dispatchReadyJobs

1. 读取 `pending AND available_at<=now`，按 `(available_at,id)` 排序，limit由运行预算给定；空结果立即返回。
2. 每条发送完全相同的versioned job identity；不将整个Post序列化到Queue。
3. send明确成功才标dispatched；send失败/结果未知保留pending并记录固定短错误码；同tick不立刻重试，下一次正常wake再尝试，不修改业务available_at或另增一套退避字段。不rollback已受理Post。返回HTTP202仍代表D1已受理。
4. mark通过jobId+dispatch_revision条件更新。producer发送期间consumer已将job重置/取消，迟到mark不得覆盖较新的dispatch意图。多个dispatcher可发送重复消息，consumer负责execution CAS；不新增distributed dispatch lock。
5. 默认单次最多20 jobs，并在耗尽预算时不启动新send；Cloudflare adapter的binding调用未必支持Abort，预算是停止开始新操作，不能谎称能撤销已经accepted的send。

Cloudflare implementation可以批量执行mark更新，但JobQueue端口保持send；每条send的成功定义不能是“已放入进程内尚未flush的数组”。未来若增加bulk端口，必须定义部分失败/成功，不把一次batch等同全部已发送。

fast path和Cron使用同一dispatcher逻辑，不能分别维护两套发送/更新顺序。fast path中断也由持久pending恢复，禁止把waitUntil当可靠持久存储。

### 4.3 发送成功不代表执行成功

官方Queue retention到期可删除消息，不保证它必然进入DLQ；Free目前固定24小时。[E9]、[E17] 因而只有pending outbox恢复是不够的。

维护逻辑检查：`outbox.dispatched` 且对应Publication仍等待、`current_job_id`未变化、没有claim/terminal、`recovery_after<=now`。默认30分钟无进展后可将**同job**按CAS重置pending，dispatch_revision递增，recovery_count+1；不增加provider attempts。先到达的DLQ处理与这个重置必须通过同一当前job guard串行化。

每job最多3轮自动stalled恢复；到顶通过条件事务标记dead_lettered，transport_reason=`stalled_recovery_exhausted`，等待人工处置。这是本设计的补充边界，不是Cloudflare原生重试配置。它防止outbox无限重新发送而绕过基础设施重试/DLQ。已有dlq_seen或业务终态不得自动复活。

这个恢复只对从未执行当前job的等待状态安全。publishing超过15分钟变unknown，不重发；publisher失败但D1未存下结论同样不能被watchdog判作“没执行”。无限D1/Queue停机或人为删除权威数据不在自动恢复保证内；必须报告可见失败，不能承诺无条件永不丢。

## 5. QueueEnvelope与消费行为

```ts
type QueueEnvelopeV1 = {
  version: 1;
  jobId: string;
  kind: "delivery.execute";
  entityId: string; // 现有Publication.id
  enqueuedAt: string; // UTC；仅诊断，不决定是否到期
  traceId?: string;
};
```

decode拒绝非对象、未知version/kind、缺失/超长ID、非法时间、禁止字段与过大消息。建议应用envelope总量不超过2KiB；这是本项目的保守限制，不代替平台128KB上限。新字段需版本/兼容策略，不能吞掉含credential/body的额外字段后继续处理。

从D1加载job及Publication，核对entity/kind/attempt_no/current_job_id。不能把“格式合法”当成“允许执行”，也不使用message enqueuedAt推断当前domain状态。已经terminal、旧job/错entity重复到达，平台调用=0。

早到消息：以D1 available_at为准，禁止提前claim；只有确认当前job仍可在到期后由outbox唤醒，才settled。若该job被误标dispatched，则rearmCurrentJob把同job重新置pending且保留available_at，dispatch_revision递增以挡住迟到producer mark；写入失败返回infrastructure_retry。不能ACK掉唯一未来唤醒后将它永久留在dispatched。

已存在live claim的duplicate可以ACK，不安排900秒占位重试。stale recovery由D1维护逻辑负责。unknown或published的duplicate永远不调用provider，无论outbox是否还存在。

malformed/未知版本在main queue由runtime按有限次数重投后进入DLQ；不能猜测成旧协议并调用SNS。DLQ无法decode时只写固定、安全的quarantine诊断，不用payload里的伪ID改publication。不要把未经脱敏的异常message存入R2。

## 6. Provider与基础设施重试

Provider adapters保留PublishError.code/ambiguous，允许附加规范化 `retryAfterAt` 或固定分类。平台策略解释真实返回，Application只决策：明确可重试且没有副作用风险？是否还有Publisher预算？最早什么时候？

基础设施Queue max_retries=3表示首次外再重投3次；Publisher max=3表示总执行上限。两者独立，数值相同不意味着同一计数器。dlq consumer不建立第三套provider重试。

应用默认首/次retry至少等待60/120秒；可信Retry-After更晚时取更晚时间。非法/过期header回落默认；过大的等待值必须受明确的最大时间表示/配置限制，不能整数溢出后立即执行。不得把合法的较晚Retry-After截短成更早发送。所有重试的provider_request_key仍为同一Publication.id。

HTTP503在“provider已经可能执行”的阶段属于ambiguous；在明确的无写入预备请求或平台有可靠拒绝证据时才可能safe retry。仅因状态码5xx不是证明。确切代码映射保留在Provider Adapter，不在Application里按twitter/threads分支。

## 7. DLQ与失败矩阵

reference physical topology保留一个业务队列与一个DLQ，不按SNS分队列。新profile可用 `syndroo-publications-v050` 与 `syndroo-publications-v050-dlq` 作为示例名字；部署者可改，Application不知道。主逻辑binding仍PUBLICATION_QUEUE。DLQ必须配置到真实声明的资源，不能只写文档。

DLQ consumer对同job先记录dlq_seen小metadata，再做条件判定：

| D1观察 | 操作 |
|---|---|
| publication已published / failed / unknown | 保留终态；只记transport诊断；ACK |
| job非current或entity不匹配 | 旧消息，不碰publication；ACK |
| pending/scheduled当前job，未claim，已经到期 | 原子标dead_lettered + 聚合Post；attempts不增加；ACK |
| publishing仍在live claim窗口 | 保存dlq_seen并ACK；由stale recovery/原执行者最终落结果，不覆盖为失败 |
| publishing已stale | CAS恢复unknown，非dead_lettered可重试结果；ACK |
| D1不可用 / 小metadata提交失败 | 不ACK；DLQ自身有限runtime retry与运维告警；不循环转发自己 |
| 不能解析的版本/格式 | 固定quarantine元数据与告警；无domain写，诊断不得泄密 |

如果dlq handler恢复时该job仍等待且已经有dlq_seen，恢复逻辑按相同guard终结它，不再自动rearm。dlq记录不是“provider拒绝”的证据；unknown的人工核实不能通过简单redrive绕过。

### 完整故障矩阵

| ID | 故障窗口 | D1/应用结果 | transport / recovery | 禁止行为 |
|---|---|---|---|---|
| FM-01 | create事务语句失败或revision guard失败 | 没有部分Post/Publication/outbox/key | 客户端失败或幂等冲突处理 | 发Queue后再补记录 |
| FM-02 | commit成功、fast Queue send失败 | outbox pending；Post已受理 | Cron稍后发送 | rollback受理或误报已发布 |
| FM-03 | send accepted、dispatched写失败/未知 | 可再次发送同job | consumer CAS去重 | 认为send成功就不需D1记录 |
| FM-04 | dispatcher并行、重复send | 同一current job | 最多一个claim | 每个消息独立新provider key |
| FM-05 | prepare凭据read/decrypt基础设施暂时故障 | 未claim、attempts不变 | Queue infra retry / stalled恢复 | 标unknown并丢弃未执行工作 |
| FM-06 | claim结果未知 | 可能已claim，不能调用provider | 读权威结果；无法确认则stale→unknown | 根据本地猜测继续发 |
| FM-07 | claim后崩溃、是否发出不明 | publishing→stale unknown | 不自动provider retry | lease到期当作未发 |
| FM-08 | provider429，明确未应用 | 同事务pending+retry_at+future job | 提交后ACK旧job | 用Queue retry替代业务持久调度 |
| FM-09 | safe retry事务失败/响应丢失 | 原claim或完整新job，绝不half-state | 同结果/同新jobId可幂等提交；失去结果则保守恢复 | 重入Publisher |
| FM-10 | provider validation/auth确定拒绝 | failed/非ambiguous | ACK | 无上限刷新或换号重发 |
| FM-11 | provider写后连接reset/5xx/超时 | unknown | ACK或持久化失败后的stale恢复 | 将所有503当safe retry |
| FM-12 | provider成功、D1结果保存失败 | claim保留，不能断言published | 只恢复提交/最终unknown | 再发SNS取回结果 |
| FM-13 | D1 published、R2 put失败 | published不变，archive failed | ACK，安全日志 | 因R2失败重发provider |
| FM-14 | R2成功、archive状态更新失败 | published不变，archive状态可能未确认 | 查询logical key可核实；无发布重试 | 回滚published |
| FM-15 | 原job业务retry后晚到 | jobId已过时 | ACK旧job；新outbox按T执行 | 把旧消息解释成新attempt |
| FM-16 | duplicate进DLQ而原请求成功 | published保持 | 只记transport事件 | 覆盖成功为dead_lettered |
| FM-17 | active claim收到DLQ | 保留claim | stale或原result决定结局 | 在原provider仍在途时再发 |
| FM-18 | Queue retention前无人消费、消息被删 | waiting current job仍在D1 | 有界stalled恢复/可见dead_lettered | 只扫描pending outbox导致永远沉默 |
| FM-19 | Cron暂停一段时间 | pending意图及available_at不丢 | 恢复时有界分页发送 | 用Queue delay=30days |
| FM-20 | 归档读已过期或对象不在 | archive unavailable；业务状态保留 | 明确缺失，不伪造payload | 把归档缺失当provider失败 |
| FM-21 | cipher错误key/tag/AAD或明文未迁移 | readiness受控阻止/配置拒绝 | 零SNS；人工修复/完成迁移 | 明文fallback、打印cipher payload |
| FM-22 | 新旧部署/队列混用 | cutover应阻止；异常可见 | 停旧执行者，核实in-flight | 为兼容猜测legacy job并发布 |

## 8. Scheduling与运行预算

D1中表示 +5min/+7days/+30days；Queue不持有长期计时。每分钟Cron只是reference wakeup，时间与limit注入同一个OutboxDispatcher。最早时间不是精准的发帖SLA：Cron延迟、积压、provider限制和预算都会造成晚发，但不得早发。

默认正常tick：dispatch最多20 jobs；维护每tick分配少量stale/dispatch-recovery/auth清理预算，不对全表做无限循环。Cloudflare Free当前单Worker invocation D1查询上限50，必须按具体实现的statement数量验证，不假设db.batch天然绕过上限；每条SQL参数上限也应纳入批量设计。[E13]

建议预留20%请求/查询/CPU余量；若本地/runtime证据表明20jobs超过目标profile预算，降低adapter批量大小或减少语句，而不是把Cloudflare额度写进domain。端口仍允许传入一般正整数limit。增加Cron从15分钟到1分钟是明确部署行为变化，要同步wrangler、README、测试、运维告警。

## 9. R2与Logger边界

### 9.1 两类存储

- `ArchiveStore → R2ArchiveStore`生产路径：provider发布响应的已批准字段/有界脱敏快照、DLQ诊断；private。
- `BlobStore → R2BlobStore`：提供独立R2实现和相同fake contract tests；本版只实现infra能力，不新增图片/video上传及SNS功能。
- Logger：结构事件到console/stdout；不一行log建一个R2对象。

`ARCHIVE_BUCKET`与`MEDIA_BUCKET`生产建议分离。若共享物理bucket，则整个bucket必须private，后续用户访问由认证代理/签名策略在外层提供；**prefix不能阻止公开bucket通过另一个key访问archive**。archive不启用r2.dev或公共custom domain；即使媒体将来公开也不能连带公开archive。[E18]

### 9.2 持久key及返回值

```text
archive/provider-responses/YYYY/MM/<publication-id>/<attempt-id>.json
archive/dlq/YYYY/MM/<job-id>.json
archive/webhooks/YYYY/MM/<provider>/<event-id>.json   # 仅预留规范，无新ingestion
archive/audit/YYYY/MM/<event-id>.json                # 仅预留类别
media/posts/<post-id>/<object-id>
```

key由应用生成并校验前缀、长度、控制字符；禁止用户传入可穿越路径。D1只存key及状态/时间，不存r2.dev/S3 endpoint或签名URL。external SNS permalink不是存储key，继续存externalUrl。未来换S3必须复制同key对象和权限/生命周期，不能称“只换adapter无需搬数据”。

### 9.3 Sanitization与失败

原文的raw response在合并版意味着**有界、脱敏并获准字段的诊断副本**，不是无条件保存原始HTTP包。Provider adapter在交出诊断时使用明确allowlist；Archive边界再次验证schema/size/redaction版本。未知字段/未知格式默认省略body，最多保存安全status/request-id等metadata；不可靠的正则全局替换不能证明任意body安全。

Authorization/Cookie/Set-Cookie、OAuth/code/state/verifier、token/password/client_secret/API key、URL中的secret参数、connection payload绝不归档。OAuth端点返回体无条件禁归档。日志/SDK错误cause也不能带这些值。完整provider正文不经D1临时中转，单diagnostic最终编码上限64KiB，必要时标truncated/omitted及固定reason。

结果路径：先D1原子保存provider outcome及planned logical archive key/状态，再尝试有界archive（默认至多2秒等待，失败不进入provider catch），最后报告settled。runtime可以在已显式ack之后用受限生命周期收尾，但context只存在外层；无论采用哪种结构，archive异常不允许逃逸成provider retry。

D1归档字段可为 `not_requested | pending | available | failed | unavailable`。只更新同attemptId的元数据；archive写完后D1标记失败，不改变发布状态。进程在outcome提交后退出可能失去内存诊断数据，本版允许归档缺失；没有耐久archive重试队列，不为保证诊断必达牺牲秘密/发布安全。

### 9.4 retention与清理

采用附件推荐30天provider response、90天DLQ；未来webhook/audit30/90天。写入记录expiresAt，过期读返回null/expired，R2 lifecycle负责最终物理清理。Cloudflare说明对象通常在expiry后24小时内删除，可能更久；不能承诺即时擦除。[E12]

outbox只清理已结束且关联Publication终态、过30天的job，不删active/retry/unknown的业务记录和幂等信息；保留unknown业务结果不等于其所有诊断raw payload永久留存。删除archive不影响externalId、content或outcome。

## 10. CredentialCipher的最小实现

这是采用附件§28建议后的明确新增范围：v1不包含应用层加密，本合并版包含**最小envelope加密**；自动key轮换、KMS、跨平台迁移CLI仍不包含。

采用WebCrypto AES-256-GCM：32byte随机密钥、每次独立随机12byte IV、128-bit authentication tag；版本化envelope包含version、algorithm、keyId、IV、ciphertext-with-tag。通过标准库执行，不手写密码算法。[E15]、[E16]

AAD使用固定编码元组：`["syndroo-credential",1,purpose,recordId,platform,payloadSchemaVersion,payloadRevision]`。purpose区分active_slot、oauth_request_secret、oauth_candidate、pkce_verifier。解密时上下文由可信记录/流程提供并逐项核对，不能只信envelope自己声称的recordId。跨平台/跨purpose/旧revision替换必须拒绝。

`SYNDROO_CREDENTIAL_KEY`为显式base64的32byte密钥；`SYNDROO_CREDENTIAL_KEY_ID`为非秘密配置值（示例k1）。它们独立于API/BINDING key；运行时映射产生Cipher对象，Application不读取Env。加密前先decoder，解密后也进行严格schema检查；empty/invalid/tag mismatch不fallback到Env或明文。

payloadRevision只在payload更新时变更；单纯lease metadata变化不能使已有密文AAD失效。refresh准备读取原payloadRevision和revision，新token的envelope使用明确递增的payloadRevision，再以lease+槽位revision事务提交。payloadRevision与槽位revision是不同用途的版本，不因lease元数据更新强制相等。binding由连接身份语义生成，不取ciphertext/IV；正常refresh或同payload重加密不能因为新随机IV改变target绑定。

上线迁移必须覆盖active credentials、候选token、OAuth1 request secret与可选PKCE verifier。旧明文保留仅用于受控迁移工具，迁移完成后在线字段清除；日常application读不兼容明文。暂停的旧OAuth operation可以安全失效并要求重连，不能重新兑换同code。

key不入D1/R2/log，不能从API key可预测派生。迁移到其他runtime必须受控保留/迁移keyId、key和binding key，否则不能解密或保持任务连续性。key丢失不伪造恢复；轮换要单独维护方案，不增加静默自动fallback/key guessing。该机制减少数据库导出泄露风险，但不能防止有runtime secret权限的攻击者或既有明文备份泄露。

## 11. Query-plan、容量和只读诊断

### 11.1 索引对应实际查询

| 热路径 | 建议索引语义 |
|---|---|
| ready outbox | outbox_jobs(status,available_at,id) |
| stalled dispatched | outbox_jobs(status,recovery_after,id) |
| unique business attempt | UNIQUE(kind,aggregate_id,attempt_no) |
| Publication current job lookup | 主键id + 校验current_job_id；必要时current_job_id索引 |
| stale publishing | publications(status,publishing_at,id) |
| status polling / Post aggregation | publications(post_id)，posts主键 |
| safe retry count / due metadata | publications(status,retry_at) |
| 幂等 | posts.idempotency_key原唯一索引，scope由单create契约固定 |
| auth operation / TTL | operation_id唯一，phase/expires_at，credential平台主键 |

不为本版没有的webhook表虚构索引。Post不再承担primary scheduling scan，不能机械要求不存在的posts(status,scheduled_at)索引；规范的“publication scheduling index”由承担对应语义的outbox索引兑现。

EXPLAIN QUERY PLAN在代表性数据（包含大量终态和少量pending）上检查搜索索引、排序和扫描代价；不要只用空库/几行表要求固定完整计划字符串。记录D1 rows_read/rows_written，以及分组聚合/清理是否扫描不相关历史数据。[E19]

### 11.2 Diagnostics

GET /v1/diagnostics需Bearer，只读；SDK `client.diagnostics()`、CLI `syndroo diagnostics --json`可用。至少报告pendingOutbox、oldestDueAt/oldestAge、retryScheduled、deadLettered、latestAttemptArchiveFailures；计数表示当前状态快照，不冒充终身累计次数。

`storage.approximateBytes`在profile有安全数据源时报告；没有时返回null、reason、observedAt，不能返回0表示健康。线上不为取size自动申请Cloudflare管理token；可由管理员诊断脚本读取平台metadata并产生单独报告。Cloudflare专用size接口/PRAGMA仅在adapter/admin工具内。

capacity utilization需要明确实际profile limit；配置未知则utilization=null。<60%、60–80%、>80%仅运维建议。空跑Cron、读status、写outbox索引、加密字段、清理和多平台fanout都计入测量；不根据“100帖子/天”直接推算免费年限。

### 11.3 当前官方额度作为部署附录，不是领域规则

2026-09-21核对的公开文档：D1 Free每库500MB、账号5GB、每日读500万/写10万、每Worker调用50条查询；Queues Free每日10,000 operations、24小时retention，单条delay最多24小时。批量不意味着少计同样的Queue消息操作。[E9]、[E13]、[E14]、[E17]

这些事实可能变化，未来实施需按实际账户和锁定runtime再次核对。R2账户启用条件、billing权限和整体资源成本未被本设计验证；本版没有“永久免费”保证。

## 12. 可移植性与完成证据

必须有独立的application测试构建：不加载Cloudflare ambient types、不安装/导入Worker实现、不触发真实网络；替换PublishingStore、CredentialStore、OutboxStore、JobQueue、ArchiveStore、Logger、Cipher的测试实现，运行创建→到期→执行→safe retry→终态链路。

真实local D1 contract suite复用同一组行为断言，验证transaction/unique/CAS/zero-row/post聚合；fake通过不替代D1通过。R2 contract suite验证private映射、key/metadata、put/get/delete/exists和size/expiry行为；local验证不替代真实bucket公开设置检查。

原生workerd fetch集成保留五平台和OAuth真实参数路径，只替换出站服务。Queue/DLQ用实际本地runtime mapping并控制重复、乱序、timeout；publisher请求计数、密文/日志sentinel扫描必留。

public contract从SDK/CLI安装后的tarball观察，保持原posts/API状态与新增terminalReason兼容。所有本地产品验收本轮NOT_RUN。官方文档核对、文档矩阵和归档ZIP校验不是执行上述系统行为的证据。

[E2]: 05-SOURCES-AND-BASELINE.md#e2
[E5]: 05-SOURCES-AND-BASELINE.md#e5
[E9]: 05-SOURCES-AND-BASELINE.md#e9
[E10]: 05-SOURCES-AND-BASELINE.md#e10
[E11]: 05-SOURCES-AND-BASELINE.md#e11
[E12]: 05-SOURCES-AND-BASELINE.md#e12
[E13]: 05-SOURCES-AND-BASELINE.md#e13
[E14]: 05-SOURCES-AND-BASELINE.md#e14
[E15]: 05-SOURCES-AND-BASELINE.md#e15
[E16]: 05-SOURCES-AND-BASELINE.md#e16
[E17]: 05-SOURCES-AND-BASELINE.md#e17
[E18]: 05-SOURCES-AND-BASELINE.md#e18
[E19]: 05-SOURCES-AND-BASELINE.md#e19
