# Syndroo 0.5.0 — 架构决策记录

日期：2026-09-21；文档修订2.0。所有 ADR 为 **Proposed**；用户已确认版本范围，不等于逐条技术决策已获批准或已经实施。规范行为以 [主设计](01-DESIGN.md)为准。

本版显式修订ADR-050-01/02/05/07/11，新增ADR-050-13至20；历史版本保存在sources的v1 ZIP，不能与当前条文并行使用。

本文件回答：为什么需要这些抽象、为什么不是更多、复杂度付在哪里、怎样证明它值得存在。

## ADR-050-01：可移植的模块化单体，不做通用框架

**状态：Proposed，修订v1。** 新附件把Application零Cloudflare依赖、ports/adapters列为本版目标；此前“无第二存储需求所以只保留具体repository依赖”的理由不再成立。

| 备选 | 结果 |
|---|---|
| v1只整理Worker内部函数 | 不满足新附件Application portability，不采用 |
| **轻量Ports & Adapters（采用）** | 新增private application包与行为ports，Cloudflare具体实现留外层，保留部署单元和现有public API |
| 立即开发PostgreSQL/Redis/Docker+通用框架 | 超出明确non-goals，增加维护面，不采用 |

**决策。** 改依赖方向，不机械重建所有文件。ports由使用者Application定义，core只保留领域契约；外层adapter实现它们。Application不import Env、D1Repository、Cloudflare类型或具体provider包；普通配置、策略和端口由composition root注入。静态类型/依赖图与不加载Cloudflare的执行测试共同验收。

**Ponytail边界。** 新port有明确需求；具体D1实现仍可集中，不需要泛型CRUD/BaseRepository/任意UnitOfWork。Future adapter必须满足事务语义，接口不是“未来无成本迁移”的保证。

## ADR-050-02：平台使用 typed Strategy/Adapter + 静态构造

**背景。** 五个平台有不同的凭据、签名、内容限制和成功信号，是真实的变化点；强行共用 BasePublisher 会形成大量条件分支和 hook。

**决策。** 保留 `Publisher.publish()`，每个平台提供 typed credential 和 adapter。外层composition root的static descriptor/map显式列举安装项、Env映射与创建函数；注入普通策略供Application使用，Application不import具体平台包。构造函数只做本地工作；禁止在构造时登录或刷新。

每个 static entry 在创建时封装自己的 credential 类型，动态分派返回统一的 Publisher 与安全状态。采用 `satisfies`、字面量判别或小范围显式 switch 维持类型关联，不用 `any`、双重 cast 或将所有凭据降级成无约束 Record。

**不是要做的。** 不做 runtime plugin discovery、装饰器自动注册、AbstractFactory 层级、反射 DI。静态映射是编译期选择机制，不是插件平台。旧 AGENTS 对 registry 的笼统限制需要同步为这个明确区别。

**验收。** 新增一个平台时修改固定的安装映射与平台包，不要求修改每个既有 adapter；错误平台凭据在类型/decoder 测试中被拒绝，构造过程零网络请求。

## ADR-050-03：一个 resolver，多种状态投影

**背景。** 授权状态、POST 准入、实际执行分别使用不同配置规则，已造成 configured=true 但 POST 422。[B1]

**决策。** 读取快照是副作用；合并/验证是纯函数；DTO 是脱敏投影。`resolvePlatformCredential` 输出 ready/blocked 及原因，各入口共享它。不通过调用 `publisher.publish()` 验证“已配置”。

平台级 user credential 必须整组选择来源。可复用 app-level Env secrets 和显式 target fallback，但不能拼接来自不同用户的 token/token-secret。损坏或过期的 D1 凭据不自动掉到 Env；显式删除后回到 Env 是被允许且被 binding 捕获的来源变更。

**权衡。** 这会收紧某些历史“部分字段碰巧能拼好”的配置。拒绝静默兼容，因为它让目标身份变得不确定。升级预检必须列出受影响配置，不能直接以500掩盖。

**验收。** 同一 credential snapshot 在 auth status、admission 和 publication prepare 中有同一判断；测试涵盖 env-only、D1-only、mixed、损坏、过期和删除 fallback。

## ADR-050-04：函数式状态机，而非 GoF State 对象树

**背景。** Publishing 已经有有限状态和基于 SQL 的领取规则；现在缺少的是阶段边界和写回条件，不是类的数量。

**决策。** 显式记录转移表；使用判别联合表达阶段与投递决策；在具体 repository 中用 SQL guard 落实。准备 → claim → Provider → persist 四段分别处理，不把所有异常塞入一个 catch。

把 credential read 和纯 Publisher construction 移到 claim 前，比“claim 后再补一个补偿释放状态”更小、更稳。D1 transient preparation failure 保留 pending，零新增尝试。只在 claim 成功后开始任何 SNS 网络工作。

**fencing。** 为 claim 增加随机令牌，markPublished/markFailed 匹配状态与令牌；late result 不能覆盖 stale recovery 的终态。Public status 不增加 preparing；旧消费者继续理解原枚举。

**不是要做的。** 不增加状态机依赖，不给每个状态建立类，不建设通用 Saga/补偿引擎。发布后的不可撤销外部副作用不能被“补偿重试”魔法消除。

**验收。** 两个消费者只有一个调用平台；准备失败可恢复；结果存储失败不会重复发布；过期恢复和迟到写回按规定顺序测试。

## ADR-050-05：语义事务端口 + 具体D1实现 + 独立Outbox

**状态：Proposed，替代v1本条。** 附件RULE-007要求transactional outbox，且业务重试/长期调度要有独立持久job身份。v1的Publication兼任待投递标记不再作为本版设计。

**采用。** 一个具体D1Repository可以实现PublishingStore、CredentialStore、OutboxStore等窄行为端口。创建Post+各Publication+初始outbox+幂等、提交safe retry+future outbox、OAuth激活+receipt，都由语义事务方法一次保证；Application不拼多个CRUD commit。

**关键约束。** D1.batch的SQL回滚不能把0行CAS变成异常。实现必须让所有关联写受同一guard/提交标识约束，发现conflict时完整不变，并以真实local D1验证。[E2] retry_at只由应用政策生成。

**Outbox。** 单独outbox_jobs保存version/kind/entity/available_at/dispatch状态和少量transport metadata，不放正文或token；Queue只发标识。send成功但mark失败可重复发，execution由current_job_id+claim fencing保证。不是事件溯源或通用消息平台。

**保留。** 不新增ORM、反射DI或泛型transaction callback；现有Post/Publication和幂等唯一记录不因示例命名重复建表。D1与SNS之间仍没有exactly-once事务。

## ADR-050-06：目标连接与 token 写入版本分离

**背景。** 任务只保存 platform，执行时用“最新 token”，会让定时任务的目标在重连后漂移。只记录 author 不适用于纯 token 平台；只记录 revision 又会使正常 refresh 必然失效。

**采用。** 一个 active credential slot + `revision` + `binding_id` + publication binding HMAC。它是连接连续性保护，不是多账户产品。

| 操作 | revision | binding | 旧未完成任务 |
|---|---|---|---|
| 完整 direct set | 递增 | 新建 | 不再自动执行 |
| OAuth complete/重新授权 | 递增 | 新建 | 不再自动执行；即使自称同号也不推断 |
| 明确同一 grant 的 token refresh | 递增 | 保留 | target/app 不变时仍可执行 |
| author/blog/host/app 变化 | 递增或 Env 指纹变化 | 有效摘要改变 | 拒绝旧任务 |
| D1 remove | 递增并保留 tombstone | 来源/绑定改变 | 不隐式跳到 Env 账号 |
| SYNDROO_API_KEY 轮换 | 不变 | 不变 | 不因入口 key 改变而失效 |
| SYNDROO_BINDING_KEY 轮换/丢失 | 不要求变更槽位 | 所有摘要不再匹配 | 需显式复核，不能关闭校验 |

独立 binding key 增加一个实例 secret，但把 API key 轮换和长期任务有效性解耦。HMAC 使用 WebCrypto；不自造密码算法，不把摘要当凭据加密。

**不采用。** 完整账户实体/组织/ACL/账户路由；把 raw credential 存入每个任务；只比较可修改的用户名；对 legacy 任务自动回填当前账号。

**权衡。** 普通重新授权可能暂停旧任务，这是本版的保守边界。以后确实需要无感同号重连，再在可靠身份验证与迁移协议基础上扩展，不增加一个未经验证的 `sameAccount=true` 开关。

## ADR-050-07：OAuth 的候选结果与 active credential 分开

**背景。** callback 自动 upsert token 既可能丢失 author，也会让公开回调直接改变实际发布目标。[B4]

**采用。** 复用 `oauth_state` 短期表记录 operation 生命周期，callback 只产生候选授权；敏感候选/request secret经CredentialCipher加密，operation metadata可查询。最终激活需要 Bearer complete、明确目标与 expected revision。它解决真实授权边界，不是通用审批系统。

操作 ID 不是 OAuth state；status/operation DTO 不返回候选 token；callback 错误页不显示 code、state、verifier 或 provider 原文。connect的授权URL含必需协议参数，是受鉴权的有限交互输出，不得进入普通日志。页面无第三方脚本/资源，设置 no-store、no-referrer 与限制性 CSP。

**兼容性成本。** callback 的200不再意味着 active credential 已替换。保留旧 GET connect 一版并标明有副作用；SDK/CLI 使用新的 POST connect。release notes 与 Skill 必须同步，不能称完全零行为变化。

**原子性。** state 从 pending 变为 exchanging 的条件更新只有一个 winner；完整交换失败不恢复为pending；complete 的成功 receipt 可重放，不使后来删除的凭据复活。完成激活与 operation receipt 同一条件事务提交。

**验收。** 并发 callback 仅一个 token exchange；旧 operation 不覆盖新凭据；缺目标时旧连接保留；complete 重放无 token exchange；账号A候选B必须显式选择，不自动沿用A的 author。

## ADR-050-08：refresh 前置 lease，不能用进程内锁或事后 CAS 代替

**背景。** 多个 Worker isolate 会同时收到 refresh 请求。只在结果落库时比较 revision，无法阻止两个请求已把同一个 refresh token 发送给平台。旋转 refresh token 的服务可能因此拒绝或撤销授权。[E4]

**采用。** CredentialStore的持久互斥端口取得带期限的refresh lease（D1 adapter用条件更新）；只有 winner 进行一次外部兑换。成功保存同时检查 revision 与 lease token。无法确认外部兑换结果时进入 reconnect_required，而不是过期后重新使用旧 token。

**期限定义。** 单次 token 请求的15秒 deadline；refresh lease 安全窗口为60秒；超时/失联记录由下一次受保护的 auth 写操作或 Cron 清理确认，read-only auth status 仅投影有效状态、不借机发外部请求。窗口是过期检测，不是自动重试许可。

**并发 direct set/delete。** 可以通过新的 revision 使旧 refresh 失效；旧执行者最终返回冲突且不能覆盖新连接。对仍有效的旧 access token，本版不承诺平台在 refresh 期间继续接受，目标绑定安全与 token 当前可用性是不同问题。

**不采用。** 模块级 Map/Promise singleflight 作为全局互斥；按时间到期无条件解锁并重试；每次发布自动刷新；带令牌的宽泛请求重试中间件。

## ADR-050-09：只共享真正相同的传输防护

**背景。** 多个 adapter 与 OAuth 都有同样的超时、大小和 redirect 需求，但 SDK 有不同的响应契约、体积上限及公共依赖限制。

**采用。** 新建一个 private transport utility 包供平台包和 Worker 使用，封装有界 body 生命周期、manual redirect、无自动重试与安全错误；复用现有工具链，无第三方新 HTTP 依赖。OAuth1 的严格签名 helper 只覆盖现有固定请求形式，若输入超出已覆盖规则应拒绝，不扩展为所有 OAuth 情形的框架。

接口以函数表达；可显式注入 fetch 用于窄单元测试，但至少一层 runtime 集成测试不替换原生 fetch。平台保留成功信号解析、content limits、错误到 PublishError 的语义映射。

SDK 保留自己的传输模块和零私有 runtime 依赖。这里允许少量相似代码，不通过共享私有包破坏公共安装契约。设计模式服务于边界，而不是强迫所有 HTTP 请求继承同一个类。

## ADR-050-10：公共错误传播与 SDK 进程生命周期优先于“纯粹不保活”

**背景。** receipt 的第一层 requireRecord 丢失 context；sleep timer unref 使独立程序可能没等完就退出。[B3]、[B5]

**采用。** 从 HTTP 到最外层错误全程携带 operation/status/requestMayHaveBeenApplied。解析任意错误形状仍反映2xx写入结果未知；禁止把 parser failure 当成确定未请求。

活跃 wait timer 默认 referenced，操作结束再清理；不增加配置旋钮/保活服务。Node 的 unref 明确允许在没有其他工作时提前退出，因此它不是一个安全的通用 await 行为。[E8]

**CLI。** SDK修复并通过独立进程测试后移除额外 keepAlive workaround。保留本地未提交修改，不将其混入审查基线。新增 auth 操作复用现有 Reporter/confirm，不复制第二套输出框架。

## ADR-050-11：受控 schema 升级，不把 additive 当成可随意回退

**采用。** 新 migration，旧 migrations 不修改；先 dry-run/report，再有授权的维护窗口迁移。legacy pending/scheduled 按任务ID显式复核绑定；未复核 fail closed；ambiguous/已终态任务不得因升级复活。

新增cipher/outbox/版本队列也属于本条cutover；在线明文必须受控迁移，旧消息不能在新consumer里猜测jobId。当前 maintenance 只拦新帖，不暂停队列/定时执行。[B6] 正式变更窗口必须另外停用相关消费者/触发源并确认 in-flight 工作；本设计不自动操作这些远端资源。

旧代码忽略新 guard，因此不允许新旧 Worker 同时消费同一活动数据。回退是一个操作方案，不是 `git checkout old`。数据备份恢复也不能证明社交平台没有收到发帖。

## ADR-050-12：模式的验收标准是边界清晰，不是模式数量

每个新增抽象提交时要能回答：谁使用、哪一种变化被隔离、删掉会造成什么真实重复、用现有函数是否就足够。

**需要删掉的复杂度：**三套配置 Boolean、重复的 SQL 退避政策、Worker OAuth dispatcher 里的平台特判、纯转发 Manager、全局保活 workaround、未经验证的魔法默认值、日志里原始第三方错误。

**必须留下的复杂度：**输入 decoder、credential revision、binding/claim token、OAuth state/refresh lease、故障与安装包测试。它们分别对应已观察到的缺陷或实际并发安全问题。

本次仅设计，不预测“净减少多少行”或宣称维护成本已经下降。实施后检查真实 diff、依赖变化、平台新增修改点和测试证据，再评价收益。


## ADR-050-13：保留Post/Publication语义映射，不新建重复Delivery模型

**来源。** 附件§6允许保留现有命名。**采用。** 原Post承载canonical content与publishing intent，原Publication承担附件Delivery的per-destination执行语义；不更换/v1/posts、不为命名新建同义表。

内部unknown/dead_lettered通过明确terminalReason表达，公开status枚举和errorAmbiguous保留。草稿/取消/可复用内容/多账户不是本次被动新增的产品功能。验收不仅检查类型名称，还检查一次多平台intent产生独立执行状态。

## ADR-050-14：业务重试只通过future Outbox，Queue retry只服务基础设施

**来源。** 附件§19/40及RULE-008。**采用。** 确定未应用的可重试结果，在一个事务中存pending/retry_at+future job，随后ACK旧job。保留Publisher总3次与默认60/120秒；附件五次阶梯是可选数值示例。

基础设施失败映射runtime retry，初始max_retries=3但不作为domain预算。发布后503/reset仍按unknown，不因“temporary”标签安全重发。验收旧job乱序和新current_job_id，并测量真实外部写次数。

## ADR-050-15：版本消息与job fencing，不能让旧消息执行新attempt

**来源。** 附件§16/18。**采用。** version1 envelope只含jobId/entityId/kind/time/trace，provider稳定key来自Publication.id而非jobId。每次safe业务retry生成新job；基础设施重投复用原job。

consumer核对D1 current_job_id和attempt_no，terminal/旧job不执行；outbox尚未标dispatched不妨碍执行。增加dispatch_revision只用于重新置pending时挡住迟到producer mark，不建立distributed dispatcher lock。

## ADR-050-16：DLQ不能覆盖业务结果；stalled transport也必须可见恢复

**来源。** 附件§20/46；官方Queue有retention到期删除行为。[E9]、[E11] **采用。** DLQ只终结未claim的当前等待job，成功/unknown/新job保持；active claim由结果或stale recovery判断。

dispatched不意味着完成；仅D1等待状态的当前job可以有界rearm（默认30分钟、最多3轮），与DLQ/current-job guard一致。达恢复上限给明确dead_lettered/transport reason，不无限循环send或复用provider预算。不是承诺broker永远不丢，也不是unknown的自动redrive。

## ADR-050-17：ArchiveStore/BlobStore/Logger分别承担不同语义

**来源。** 附件§21–27/29/41/42。**采用。** Archive生产路径为private R2、有界/脱敏provider诊断；Blob端口与R2实现有contract tests但不引入媒体产品；Logger走console/stdout而非R2逐行对象。

只存logical keys，archive不能共享公开bucket权限。先D1 outcome后best-effort archive，归档失败不重发provider；未知raw格式舍弃body优于“泛化正则脱敏后全部保存”。30/90天是保留政策，不是expiry瞬时物理擦除保证。[E12]

## ADR-050-18：采纳最小凭据envelope加密，不建设key管理平台

**来源。** 附件§28的SHOULD，整合设计选择采用。**明确范围变化。** v1把完整加密排除；revision2纳入CredentialCipher和AES-GCM最小实现，只把自动轮换/KMS排除。这是新增密钥、payload与迁移验收的实际成本。

32byte独立runtime key，versioned envelope，新随机96-bit IV，128-bit tag，AAD绑定purpose/record/platform/schema/payloadRevision。active与临时OAuth秘密都保护；key不进D1/R2。HMAC binding独立于随机ciphertext，重加密不改变目标。[E15]、[E16]

假cipher只能用于测试，production不得以identity/no-op cipher静默通过配置检查。保留旧明文备份的风险单独披露。没有声称自动处理key丢失或受损runtime。

## ADR-050-19：每分钟有界唤醒 + 实际索引/额度证据

**来源。** 附件§13/34/42/43/48。**采用。** long scheduling在available_at，Cron从15分钟改为1分钟，初始最多20jobs/次，按照profile的SQL/CPU预算限制。无无限while直到清空、无每分钟全历史扫描。

query-plan和rows-read/write测试与GC绑定真实WHERE/ORDER BY。旧UUIDv4/UTC ISO表示保留；无业务需求不为UUIDv7/整数时间大迁移。诊断read-only，未知size用null+reason。60/80%为operational建议，Free额度在profile附录而非domain。[E13]、[E14]

## ADR-050-20：用两类契约测试证明边界，而非现在实现第二个生产profile

**来源。** 附件§3/44/47/52。**采用。** Application在无Cloudflare环境中用完整fake行为跑全链路；相同store契约在local D1执行CAS/事务；R2/Queue单独adapter测试。type-only/ambient类型泄漏也由CI检测。

不在本版开发Postgres/S3/Redis/Docker，也不声称端口通过意味着迁移无需复制数据/密钥/重做运维。保留原B的五平台原生workerd、OAuth、SDK/CLI子进程及安装产物门槛；新增ports不能成为弱化原测试的理由。

<!-- 跨文件证据索引：代码证据与公开协议事实分开。 -->
[B1]: 05-SOURCES-AND-BASELINE.md#b1
[B2]: 05-SOURCES-AND-BASELINE.md#b2
[B3]: 05-SOURCES-AND-BASELINE.md#b3
[B4]: 05-SOURCES-AND-BASELINE.md#b4
[B5]: 05-SOURCES-AND-BASELINE.md#b5
[B6]: 05-SOURCES-AND-BASELINE.md#b6
[E2]: 05-SOURCES-AND-BASELINE.md#e2
[E3]: 05-SOURCES-AND-BASELINE.md#e3
[E4]: 05-SOURCES-AND-BASELINE.md#e4
[E8]: 05-SOURCES-AND-BASELINE.md#e8

[E9]: 05-SOURCES-AND-BASELINE.md#e9
[E11]: 05-SOURCES-AND-BASELINE.md#e11
[E12]: 05-SOURCES-AND-BASELINE.md#e12
[E13]: 05-SOURCES-AND-BASELINE.md#e13
[E14]: 05-SOURCES-AND-BASELINE.md#e14
[E15]: 05-SOURCES-AND-BASELINE.md#e15
[E16]: 05-SOURCES-AND-BASELINE.md#e16
