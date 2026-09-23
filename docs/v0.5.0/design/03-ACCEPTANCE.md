# Syndroo 0.5.0 — 验收矩阵（整合修订版）

文档版本：2.0；目标0.5.0，候选0.5.0-rc.1；状态：**全部产品标准 NOT_RUN**。

## 1. 验收范围与证据纪律

本矩阵保留v1全部66个ID，新增54项portable storage/queue合同门槛，共 **120项：118项本地必需，2项真实平台独立授权**。不是120个已经通过的测试，也不规定每项必须一份测试文件。一个参数化合同可以满足多项，但必须明确对应证据。

原标准中的20项为覆盖新架构而加强或调整路径，没有移除原安全目标；逐条旧/新文本见 [验收变更记录](acceptance-change-log.json)。原规格与新添附件原文均在sources中，便于独立审核。

[主规格](01-DESIGN.md)、[基础设施契约及FM故障矩阵](07-CONTRACTS-AND-FAILURE-MATRIX.md)规定行为；[整合映射](06-INTEGRATION-REVIEW.md)给出53节/15条规则到本矩阵的对应关系。机器可读的唯一ID清单见 [JSON模板](acceptance-results.template.json)。

### 状态

`NOT_RUN`=未执行，`PASS`=有当前源码的执行证据，`FAIL`=实际未达标，`BLOCKED`=能力/权限/环境阻塞。`SKIP`仅用于被维护者明确批准不适用的非必需检查，不能用来跳过上述本地必需安全门槛。无live授权就保持NOT_RUN或记录BLOCKED，不能以mock等价替换后记PASS。

每项PASS至少记录实际命令、退出码、源码commit、runtime版本、证据文件和观测结果。SQL原子性/加密/OAuth/并发必须有隔离执行证据；code review不等于执行。本文生成与Markdown/JSON校验不计入任何产品PASS。

产品测试必须使用fake secret、local D1/R2、封闭出站服务或事务fake；严禁为验证而执行真实发帖、生产删库、真实支付、密钥外传或未授权队列purge。原生workerd fetch测试替换的是出站服务，不是把fetch本身mock掉。

## 2. 原B范围的持续门槛

### 架构

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| ARC-01 | core与application零Cloudflare/Env/D1/R2/Queue runtime依赖；application只依赖ports/core和注入策略；SDK零私有包依赖，依赖图无环。 | 静态 import/manifest 检查，并运行各包类型检查。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：import 检查结果、manifest diff、tsc exit code。 | NOT_RUN |
| ARC-02 | 平台差异由 typed strategy/adapter 表达；没有 BasePublisher/通用 DI/动态插件系统；构造 Publisher 零网络。 | 逐平台类型负例与构造 spy，review 所有实际 caller。<br>证据：错误 credential 编译/decoder 失败证据，构造 fetch 次数=0。 | NOT_RUN |
| ARC-03 | auth 状态、创建准入和执行使用同一解析规则；不存在三套独立 configured 判断。 | 同一数据集覆盖三个入口；检索旧 helper caller。<br>证据：三个入口的对照结果与完整替换点。 | NOT_RUN |
| ARC-04 | 业务retry时间只由application policy决定；安全业务retry与future outbox原子保存；SQL仅落实guard，Queue retry只负责基础设施。 | 纯政策测试 + D1 retry_at 断言 + 结构 review。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：政策输入/输出、SQL 持久值与新增模块消费者清单。 | NOT_RUN |

### 凭据解析

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| CFG-01 | env-only、D1-only、mixed均可完成准入及隔离发布；D1中的用户凭据经CredentialCipher解密，必要app secret由外层普通配置提供。 | 真实 Worker/D1 + 假凭据 + 出站 mock；五平台表驱动。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：auth readiness、HTTP202、publication状态、实际出站计数。 | NOT_RUN |
| CFG-02 | 不混用不同来源的一组user token；D1解密失败、损坏、缺字段或过期不静默回退Env或旧明文。 | 完整/部分/损坏/过期 fixture，与 Env 另一个账户并存。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：blocked原因、零持久帖子、零平台请求、无 token 日志。 | NOT_RUN |
| CFG-03 | null、数组、基本类型、非法字段、非法 author/blog/host/version/expiry 返回受控错误。 | 通过 HTTP auth endpoint 发送恶意/错误输入。<br>证据：400/422及固定错误 envelope；没有未捕获TypeError或原始输入。 | NOT_RUN |
| CFG-04 | 公开 status 不包含秘密；source 反映实际来源，configured 不冒充 live verification。 | 成功/失败/expired/mixed响应契约测试。<br>证据：DTO字段与sentinel秘密扫描结果。 | NOT_RUN |

### 创建/幂等

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| CRT-01 | 相同 key+相同内容返回同一post；更改内容为409；凭据改变后仍能重放旧receipt。 | 真实 D1，先create再变更配置，重放/冲突；维护关闭。<br>证据：Post/Publication行数不增加，重放200，无第二次入队。 | NOT_RUN |
| CRT-02 | 并发同key只保存一个完整Post、Publication集合及各自初始OutboxJobs；无孤儿job或部分聚合。 | 并发HTTP调用和D1唯一键竞争；注入事务中途失败。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：唯一记录、无部分平台集合、无孤儿、原子回滚证据。 | NOT_RUN |
| CRT-03 | 结构/配置失败无部分写入；credential revision或slot状态竞争令创建事务全部不写；0-row guard不能留下Post或OutboxJob。 | 在解析与D1创建之间插入revision变更。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：0个新Post/Publication；明确冲突/拒绝，而非200/202。 | NOT_RUN |
| CRT-04 | 保留64KiB、Bearer和maintenance语义；commit后Queue失败仍返回受理，持久pending outbox可恢复。 | 超大body、无token、maintenance、Queue send异常fixture。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：状态码、无越权/误写、enqueueDeferred和Cron恢复日志。 | NOT_RUN |

### 执行状态机

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| PUB-01 | credential read短暂失败发生在claim前，零attempt增加、零SNS调用、不进入ambiguous终态。 | 真实publication+D1故障注入，再恢复D1并执行。<br>证据：pending/attempts对照、最终可恢复、总发布次数1。 | NOT_RUN |
| PUB-02 | 重复投递最多一个claim winner；job/entity/current_job_id/attempt_no/credential revision均满足条件后，才开始任何SNS调用。 | 并发消费者屏障；拦截session和publish出站顺序。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：claim token、时间顺序、平台写次数=1。 | NOT_RUN |
| PUB-03 | 真正安全的provider失败受retry_at及三次Publisher执行上限约束；失败状态与下一OutboxJob一起提交，然后ACK旧消息。 | 推进受控时钟，交错Queue重复消息与Cron。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：attempts不超过3，早到消息不发，retry_at持久化。 | NOT_RUN |
| PUB-04 | 平台已收到但响应丢失/超时/5xx时，记录不确定结果且永不自动重发。 | 出站stub记录请求后断开；重投Queue并运行Cron。<br>证据：errorAmbiguous=true，终态保留，总远程写次数1。 | NOT_RUN |
| PUB-05 | provider成功/失败后D1落库故障不触发第二次provider调用；父Post、Publication和必要future outbox无部分更新；同attempt提交可幂等重放。 | SQL失败触发器/隔离数据库注入。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：事务回滚，后续delivery不重发，最终保守恢复结果。 | NOT_RUN |
| PUB-06 | stale recovery、旧claim token、迟到provider结果、旧job/DLQ不得覆盖较新或已终结的业务结果。 | 受控时钟与顺序屏障，执行条件写回。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：旧token更新0行、终态不变、脱敏late-result诊断。 | NOT_RUN |

### 目标绑定

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| BND-01 | D1 A→B、D1删除回Env、Env token/host/author/app变化都不能使旧任务发到新目标。 | 每种变更后执行旧scheduled/pending。<br>证据：AUTH且非ambiguous、零SNS请求；新任务可用新binding。 | NOT_RUN |
| BND-02 | 同grant受控refresh保留target/binding，直接重设和OAuth重连总是建立新binding。 | 比较操作前后revision/binding及旧任务行为。<br>证据：refresh后正常；重连后旧任务拒绝，秘密不出现在差异日志。 | NOT_RUN |
| BND-03 | claim前凭据竞争被CAS挡住；claim后重连不把已有Publisher改成新token。 | 精确在claim前/后切换，记录出站sentinel账号。<br>证据：preclaim零发；postclaim最多使用原快照，绝不发到新账户。 | NOT_RUN |
| BND-04 | 独立binding key缺失/非法时新发布fail closed；API key轮换不改binding；binding key更换需复核。 | 配置矩阵+未完成任务fixture。<br>证据：拒绝原因、binding连续性、不存在默认key/绕过路径。 | NOT_RUN |
| BND-05 | legacy无绑定任务不会自动绑定当前账号；删除再创建不复活旧revision或旧OAuth确认。 | 旧schema fixture，credential删除/重建/complete交错。<br>证据：原ID/content/key保留、零误发、旧revision更新0行。 | NOT_RUN |

### OAuth

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| AUT-01 | 只有精确callback可免Bearer；额外路径段、未知平台、错误method不扩大授权例外。 | 路由表驱动、安全负例。<br>证据：401/404/405与零未授权D1写入/外部请求。 | NOT_RUN |
| AUT-02 | callback使用已保存canonical URL和平台配置；拒绝错误state/平台/expiry/OAuth1 token。 | 篡改callback参数、Host、app配置与时间。<br>证据：无token exchange、固定错误页、原active未改变。 | NOT_RUN |
| AUT-03 | 同一state并发callback仅一个进入exchange；崩溃或失败不能重置state重用。 | 真实D1 CAS+并发callback+中断。<br>证据：token endpoint调用次数1；operation phase正确。 | NOT_RUN |
| AUT-04 | callback不覆盖active；缺LinkedIn author/Tumblr blog时显示候选需配置，不复制旧目标。 | A活动连接、B候选令牌、目标缺失fixture。<br>证据：旧凭据未变，candidate phase与missingFields明确。 | NOT_RUN |
| AUT-05 | complete需要Bearer、明确target、正确revision；凭据激活与operation receipt原子提交。 | 正常/竞争/事务失败/未授权complete。<br>证据：成功一次或全不变；冲突409；无half-completed状态。 | NOT_RUN |
| AUT-06 | 重复complete只重放该operation的receipt；不能覆盖之后的direct set/delete。 | complete→后续credential变更→重复complete。<br>证据：零额外exchange、当前槽位保持较新值，receipt标记replayed。 | NOT_RUN |
| AUT-07 | OAuth1编码与签名具标准测试向量；OAuth2的PKCE设置有平台/app证据且不静默降级。 | 编码特殊字符向量、假授权服务器校验、配置审查。<br>证据：签名相等，支持的S256参数匹配；未证明能力不声称已支持。 | NOT_RUN |
| AUT-08 | 操作结果与HTML无code/state/token；no-store/no-referrer/CSP；过期候选秘密按期限清理。 | sentinel扫描、header断言、Cron/过期状态测试。<br>证据：零秘密泄露、到期候选不可complete、清理不误删active。 | NOT_RUN |

### 刷新

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| REF-01 | 并发refresh在外部请求前获得D1 lease；只有一个winner请求平台。 | 同revision两个refresh并发，通过真实localD1。<br>证据：token endpoint总次数1；loser409，非进程内锁。 | NOT_RUN |
| REF-02 | refresh保留author/blog/api_version与binding；正确处理expires_in和refresh token轮换。 | 缺失/更新/非法refresh token与expiry响应矩阵。<br>证据：只替换允许token字段、revision递增、旧目标未丢失。 | NOT_RUN |
| REF-03 | 网络结果未知、崩溃或保存失败不重用可能已旋转的refresh token。 | 外部收到后断开，推进60秒lease窗口与重试请求。<br>证据：reconnect_required、外部总请求仍为1、旧token不自动再发。 | NOT_RUN |
| REF-04 | refresh与direct set/complete/delete交错，旧refresh结果不能覆盖新连接。 | 响应屏障+revision和lease token竞争。<br>证据：新连接保留、旧写回0行，无binding降级。 | NOT_RUN |

### 传输

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| NET-01 | 五平台与OAuth使用原生workerd fetch通过隔离出站服务，不用fetch mock替代运行时验证。 | 生产bundle+localworkerd+fail-closed outbound fixture。<br>证据：真实原生参数可执行；每平台成功信号与结果正确。 | NOT_RUN |
| NET-02 | 301/302/303/307/308都不跟随，目标server收到零Authorization/body请求。 | 两个loopback服务，第一跳返回重定向。<br>证据：第二跳请求次数0，write结果保守分类。 | NOT_RUN |
| NET-03 | deadline覆盖headers与body；超大/慢流/中断/cancel挂起均有界结束。 | 真实stream/fault fixtures，有限外部test watchdog。<br>证据：耗时上限、reader/timer/listener清理、无泄漏事件。 | NOT_RUN |
| NET-04 | 共享transport不重试、不解释业务；官方SDK额外写重试保持关闭。 | 429、5xx、超时、SDK parsing失败组合。<br>证据：单次adapter尝试最多一次发布写请求；已声明session步骤除外。 | NOT_RUN |
| NET-05 | provider原始错误/凭据不经日志、cause序列化、API或R2泄露；仅有限allowlist脱敏diagnostic可进入ArchiveStore，OAuth原始token响应从不归档。 | 在URL/header/body/error中放fake sentinels。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：stdout/stderr/Worker日志/DTO/snapshot全部扫描为零。 | NOT_RUN |

### SDK

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| SDK-01 | HTTP2xx receipt为空/null/数组/基本类型/缺字段时保留实际status与mayHaveBeenApplied=true。 | SDK public create对坏响应表驱动测试。<br>证据：每一形状的error字段；无自动重发。 | NOT_RUN |
| SDK-02 | 区分未发送Abort、在途Abort、网络不确定和服务拒绝；post/auth提示指向正确恢复入口。 | public API fake server，写操作计数。<br>证据：context与错误消息正确、无post key误用于auth刷新。 | NOT_RUN |
| SDK-03 | 独立Node进程wait在queued之后会继续轮询并settle，而不是提前退出。 | 单独child process，不放保活interval；先pending再terminal。<br>证据：至少两次读取、Promisesettled、退出码与结果正确。 | NOT_RUN |
| SDK-04 | 成功/超时/Abort后进程能退出；timeout非法/溢出受控拒绝。 | 独立进程+有限父进程watchdog，多结局fixture。<br>证据：无悬挂句柄/未处理拒绝；退出未依赖强制kill。 | NOT_RUN |
| SDK-05 | auth完整门面与新增只读diagnostics是薄HTTP客户端；公开包不依赖私有application，post/auth写均不自动重试。 | 安装后的SDK对隔离Worker调用。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：正确HTTP方法/DTO/错误code与调用次数。 | NOT_RUN |

### CLI

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| CLI-01 | auth完整命令链可从无配置到已激活连接，再到post结果；candidate与active分开。 | 真实CLI child+隔离Worker/OAuth/SNS。<br>证据：每条命令输出/退出码与服务端记录对应。 | NOT_RUN |
| CLI-02 | secret通过stdin/文件/受控输入；无secret命令行flag；预览/log/JSON不输出秘密。 | 非交互文件/管道/非法文件/超大输入+sentinel扫描。<br>证据：进程argv、stdout/stderr、持久文件无秘密泄露。 | NOT_RUN |
| CLI-03 | 需要确认的set/complete/remove在取消或缺yes时零写；陈旧revision不会覆盖。 | TTY与非交互两组真实进程。<br>证据：退出码、写请求次数0或受控409。 | NOT_RUN |
| CLI-04 | SDK修复后移除保活workaround仍可wait；包括diagnostics在内每个JSON命令stdout恰好一个对象。 | 独立CLI进程，queued→terminal与timeout/Abort。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：stdout可单次JSON.parse，stderr独立，settle/退出正确。 | NOT_RUN |
| CLI-05 | 保持原post validate/dry-run/create/get/list/wait契约，稳定key、冻结内容和取消行为不退化。 | 现有CLI/SDK测试与consumer gate。<br>证据：原测试结果、发布请求数与预览输入哈希相同。 | NOT_RUN |

### Skill

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| SKL-01 | Agent通过CLI完成授权指引和确认，不索取聊天中的token，不把callback当发布成功。 | 固定fake trace/eval与规则契约测试。<br>证据：命令顺序、用户确认点、秘密值不进入会话。 | NOT_RUN |
| SKL-02 | 正文/provider错误/OAuth页面注入不能修改目标、读取秘密、调用额外工具或授予授权。 | 恶意文本fixture与既有Skill合同测试。<br>证据：零越权写、原内容/target/key保持，明确停止原因。 | NOT_RUN |
| SKL-03 | 未配置、过期、连接变更与ambiguity指引不同；无工具时不伪造完成。 | 离线流程fixture及HTTP fallback合同测试。<br>证据：明确状态、无换路重发/新key、限制说明。 | NOT_RUN |

### 迁移

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| MIG-01 | 只追加migration、不重写0001–0005；fresh与旧版本升级路径均通过，原记录、ID和幂等结果可追溯。 | 一次性localD1分别空库迁移和旧schema升级。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：migration列表、schema对照、旧数据行数。 | NOT_RUN |
| MIG-02 | 旧终态/幂等结果保留；无绑定pending/scheduled默认零发且明确需复核。 | 含旧Post、ambiguous、publishing的fixture。<br>证据：原ID/content/key保留；无自动复活或默认重绑。 | NOT_RUN |
| MIG-03 | 显式legacy绑定管理只处理列出的未执行任务；dry-run零写，陈旧状态/绑定被拒绝。 | 仅一次性localD1，按ID和expected状态/指纹操作。<br>证据：dry-run报告、准确影响行数、无外部请求。 | NOT_RUN |
| MIG-04 | 升级/回退明确停止旧Queue/Cron、处理in-flight和旧协议消息；新旧consumer不能同时执行同一域任务，maintenance不冒充消费者暂停。 | 静态runbook审查+本地模拟cutover，无生产调用。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：操作前置条件、回退禁止旧worker混跑和重发的检查点。 | NOT_RUN |
| MIG-05 | 新key/vars/R2/主Queue/DLQ及migration同步例子、bindings、generated types、deploy/package说明；安全校验失败不接受新写。 | 配置生成及独立临时部署模板build检查。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：无真实secret/D1ID进入产物；部署准备失败有明确原因。 | NOT_RUN |

### 构建/发布准备

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| PKG-01 | 三个公共包统一0.5.0-rc.1及CLI精确SDK依赖；新增application/transport保持private且正确bundle，不制造安装时的私有registry依赖。 | release-train离线验证、manifest/lockfile检查。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：版本一致、public/private依赖闭合。 | NOT_RUN |
| PKG-02 | 现有Worker suite卡住问题已定位并解决，不删suite/弱化mock换取通过；Node22/24验证。 | 干净隔离工作区、明确fake secret配置、有限测试时间。<br>证据：真实test数量/退出码/运行时版本；无遗留进程。 | NOT_RUN |
| PKG-03 | npm test/check/bundle/startup及脚本测试全部有当前源码的成功证据。 | 按项目命令执行，不混入用户未提交修改。<br>证据：命令、commit、exitcode、日志、测试数量。 | NOT_RUN |
| PKG-04 | monorepo外安装tarball后的SDK/CLI/Worker完成授权、Post→D1→Outbox→Queue→隔离SNS→状态回读与归档故障验证。 | e2e:consumer、verify:package、三个npm pack dry-run。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：resolved包路径、tarballsha、功能结果；没有私有包registry依赖。 | NOT_RUN |
| PKG-05 | 多包发布顺序/RC tag/部分失败恢复在fake registry验证；真实发布仍独立授权。 | release-train/check-release和workflow离线fixture。<br>证据：SDK→CLI→Worker计划；不重复已发布包；非404不当成缺包。 | NOT_RUN |
| PKG-06 | README/AGENTS/Skill/CHANGELOG和设计一致，明确ports/outbox、密钥、callback、legacy、DLQ、归档隐私及Free profile限制。 | 链接/例子/命令合同与最终diff审查。 整合修订新增的事务/端口路径亦须实测；以主规格与07契约为准。<br>证据：无过时“仅Worker公开包”或“所有v1含callback需Bearer”等矛盾。 | NOT_RUN |

### 真实平台

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| LIV-01 | 保持当前发布政策要求的真实平台账户验收，不用mock替代发布权限/身份/API能力验证。 | 另行批准的staging+内容/账户/数量明确的live plan；默认不执行。<br>证据：批准记录、平台可核查结果、实际路由/版本；缺授权记录BLOCKED而非PASS。 | NOT_RUN |
| LIV-02 | 真实OAuth/refresh能力按平台与app验证；未验证的集成明确experimental。 | 独立有授权的账户计划，包含callback/目标/expiry检查。<br>证据：provider/app能力证据、验证日期、未完成限制，不保存秘密。 | NOT_RUN |

## 3. 可移植存储与队列新增门槛

### 可移植依赖与合同

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| PORT-01 | application在无Cloudflare ambient types的独立tsconfig下可编译并执行。 | 独立构建application及其fake测试；禁止加载Worker package。<br>证据：编译日志、解析后的依赖图、fake入口执行日志。 | NOT_RUN |
| PORT-02 | CI拒绝core/application对cloudflare:workers、Worker模块、D1/R2/MessageBatch/Env等type-only或全局类型依赖。 | 注入违规import及ambient fixture使架构检查失败；恢复后通过。<br>证据：正反fixture、诊断位置和退出码。 | NOT_RUN |
| PORT-03 | 实际应用函数可注入事务fake、JobQueue fake、ArchiveStore fake和fake clock运行，业务代码无需改写。 | 同一应用模块完成create/duplicate/retry/unknown/30天schedule矩阵。<br>证据：应用模块hash一致、端口调用trace与SNS调用数。 | NOT_RUN |
| PORT-04 | D1实现与事务fake通过相同PublishingStore/CredentialStore/OutboxStore行为合同。 | 复用合同参数化执行local D1和rollback-capable fake；覆盖applied/already_applied/conflict。<br>证据：两份独立结果及跨实体原子性断言。 | NOT_RUN |
| PORT-05 | 端口输入输出只含平台中立数据/标准流；CF bindings仅composition/adapter读取。 | 检查导出声明、运行fake返回值与composition wiring；禁止SQL/SDK对象逸出。<br>证据：声明快照与依赖检查，无D1Result/R2Object/ack/retry/delay。 | NOT_RUN |
| PORT-06 | 保留Post/Publication/public status和API语义，新增unknown/dead_lettered映射不谎报安全重发。 | 旧SDK响应fixture和新客户端读取同一结果；reason未知值也可解析。<br>证据：兼容fixture、per-platform verdict及零误判断言。 | NOT_RUN |

### 事务Outbox

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| OBX-01 | Post、Publications、initial jobs、key与revision guard属于一个逻辑事务。 | 逐statement故障注入，以及任一guard零行的真实D1竞争。<br>证据：全部提交或全部不存在；无孤儿row。 | NOT_RUN |
| OBX-02 | Queue发送失败或结果未知不rollback受理记录，job保持可恢复pending。 | commit后使JobQueue失败并重启dispatcher；快路径与Cron均执行。<br>证据：原receipt/key不变，恢复后一个逻辑发布。 | NOT_RUN |
| OBX-03 | Queue成功而mark-dispatched失败允许重复发送，但只执行一次同job。 | 截断mark写入、重复dispatch/consume并检查CAS。<br>证据：queue receipt可多次、provider调用一次。 | NOT_RUN |
| OBX-04 | 同一安全provider retry原子保存retry_at、新current_job_id与future job。 | 重试commit各写入点中断；同attempt同jobId重放提交。<br>证据：无pending无job、无重复future intent、父状态一致。 | NOT_RUN |
| OBX-05 | 基础设施redelivery和stalled rearm复用jobId，业务retry才新建jobId；attempt_no唯一。 | 混合重投/业务retry直至三次预算。<br>证据：UNIQUE(kind,aggregate_id,attempt_no)与稳定ID轨迹。 | NOT_RUN |
| OBX-06 | dispatch_revision挡住早到rearm/取消之后的迟到producer mark。 | 按send→consumer rearm→late mark顺序和反序交错。<br>证据：当前pending/available_at不被旧mark抹掉。 | NOT_RUN |
| OBX-07 | dispatchReadyJobs不会把未实际提交broker的内存缓冲当发送成功。 | 替换成延迟/失败JobQueue并在flush前终止；观察标记行为。<br>证据：mark发生在可确认send之后，失败不变dispatched。 | NOT_RUN |
| OBX-08 | consumer可处理尚未mark-dispatched但已合法入队的当前job。 | send成功后暂停producer mark，先运行consumer。<br>证据：合法job不会因outbox仍pending而丢弃。 | NOT_RUN |
| OBX-09 | provider_request_key为稳定Publication业务ID，并只用于provider已支持的幂等机制。 | 同publication三个安全attempt记录平台请求；不支持平台检查无虚构header。<br>证据：key稳定、job/attempt可变化的请求fixture。 | NOT_RUN |
| OBX-10 | outbox不保存正文、原始response、token、二进制或无限诊断。 | 用含sentinel的内容和错误走全链路，检查outbox表列和实际行。<br>证据：仅ID/小metadata；SQL行和queue payload零secret/content副本。 | NOT_RUN |

### 版本化Queue与DLQ

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| QUE-01 | envelope验证version/kind/字段/大小/ID/time；不接受legacy裸publicationId或带secret扩展。 | 有效V1和恶意/未知版本/超2KiB fixture覆盖主consumer入口。<br>证据：拒绝轨迹、零provider调用、有限quarantine路径。 | NOT_RUN |
| QUE-02 | 从D1复核entity、job kind、attempt_no、current_job_id；旧消息不能触发下一attempt。 | A失败生成B后投递A；错entity和错attempt投递。<br>证据：current job不被旧消息推进，provider预算不变。 | NOT_RUN |
| QUE-03 | live claim重复可ACK但不得第二次调用SNS；stale处理仍由权威状态恢复。 | 并发两consumer+阻塞provider，再触发stale tick。<br>证据：一个winner与保守unknown，零自动重发。 | NOT_RUN |
| QUE-04 | 主Queue配置DLQ；基础设施max_retries与三次业务budget独立。 | 解析生产manifest，模拟初次+重投耗尽进入隔离DLQ。<br>证据：配置与runtime trace；没有把broker次数写成Publication.attempts。 | NOT_RUN |
| QUE-05 | 当前未claim等待job进入DLQ时，dead_lettered及父聚合原子且可见。 | DLQ handler用local D1运行，逐写入故障注入。<br>证据：reason/状态/metadata一致，D1失败不ACK。 | NOT_RUN |
| QUE-06 | 已published、unknown、旧job的迟到DLQ不覆盖业务结果。 | 为三种状态分别投递DLQ，重复多次。<br>证据：原externalId/ambiguity/current_job_id保持。 | NOT_RUN |
| QUE-07 | active claim到达DLQ只记录transport metadata，不判为确定未发送；随后结果或stale规则优先。 | 阻塞provider期间DLQ，再成功/超时/落库失败。<br>证据：成功保持published，stale为unknown，零重新发帖。 | NOT_RUN |
| QUE-08 | DLQ自身存储失败有限重投且可运维发现；malformed payload不按伪ID修改业务记录。 | DLQ数据库故障/非法版本/不存在ID fixture。<br>证据：无静默ACK、无递归DLQ链、固定安全诊断。 | NOT_RUN |

### 调度与消息到期恢复

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| SCH-01 | now、+5min、+7day、+30day由D1/outbox时间驱动，Queue port无长期delay。 | fake clock分别运行due前/恰好due/之后；暂停后重启dispatcher。<br>证据：due前零SNS，到期后可执行，无长delay参数。 | NOT_RUN |
| SCH-02 | 早到消息只在持久future wake可恢复后ACK；rearm保留原available_at。 | early消费且mark已为dispatched，随后推进到due。<br>证据：无提前claim，future job仍被dispatcher发现。 | NOT_RUN |
| SCH-03 | Cron只唤醒portable应用函数；默认每分钟、每次20jobs并有工作预算。 | manifest检查、fakeclock相同函数调用、慢binding耗尽预算。<br>证据：不启动超预算新send，明确不谎称取消已accepted请求。 | NOT_RUN |
| SCH-04 | dispatched但长期未claim的当前job可有界rearm，覆盖broker retention删除且无DLQ的情况。 | 模拟丢失已发消息，时间推进30分钟；最多3轮同job恢复。<br>证据：recovery_count/dispatch_revision正确、无provider attempts增加。 | NOT_RUN |
| SCH-05 | stalled恢复到顶可见终止；publishing/terminal/unknown/dlq_seen不得自动复活。 | 穷尽恢复预算与所有排除状态fixture。<br>证据：dead_lettered/stalled_recovery_exhausted或原结果，无无限重投。 | NOT_RUN |

### Blob/Archive/Logger隔离

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| STO-01 | R2BlobStore与R2ArchiveStore均实现独立端口合同，不因此新增媒体或webhook产品API。 | local R2/fake分别运行put/get/delete及blob exists，检查路由范围。<br>证据：合同结果、private包wiring；公开功能范围未扩大。 | NOT_RUN |
| STO-02 | ARCHIVE_BUCKET不可公开；共享bucket只有整体private+受控代理才允许。 | 部署配置与隔离访问fixture检查；拒绝仅靠prefix隔离的public配置。<br>证据：匿名archive读取拒绝，prefix不能被宣称为ACL。 | NOT_RUN |
| STO-03 | D1保存logical key而非R2 URL；外部SNS permalink仍允许保存。 | 归档/媒体key roundtrip并替换fake backend；检查D1值。<br>证据：替换backend无需改业务key、SNS externalUrl不误删。 | NOT_RUN |
| STO-04 | ArchiveStore只接收有界allowlist脱敏对象；unknown body省略，OAuth token response禁止归档。 | 嵌套/大小写/自由文本sentinel、headers和异常cause跨所有路径。<br>证据：archive/log/API零secret，单对象不超过64KiB。 | NOT_RUN |
| STO-05 | provider成功并存D1后archive失败保持published且不追加业务job。 | R2失败/超时/进程中断，重复Queue和Cron。<br>证据：provider调用一次、原结果不变、可见archive失败/不可用。 | NOT_RUN |
| STO-06 | R2写成功但archive metadata保存失败，不改变provider结果；重复同attempt归档可安全覆盖。 | 在archive put之后使D1 metadata更新失败再重放。<br>证据：无重发SNS，无将别的attempt归档标给当前attempt。 | NOT_RUN |
| STO-07 | 归档是best-effort，不把诊断丢失当域状态丢失；读过期/缺失key返回不可用。 | provider保存后进程停止，不执行archive；读取过期/404对象。<br>证据：发布结果仍完整，诊断不冒充存在，无durable raw payload队列。 | NOT_RUN |
| STO-08 | Logger独立于ArchiveStore；不为每条debug/info日志写R2。 | 启用日志fixture记录端口调用，断开R2再运行成功/失败流程。<br>证据：日志结构事件有界，日志本身不调用R2。 | NOT_RUN |

### 凭据加密与迁移

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| CIP-01 | 生产CredentialCipher为真实AES-256-GCM authenticated envelope，不允许noop或编码代替加密。 | 标准向量及WebCrypto roundtrip；检查bundle production wiring。<br>证据：算法/key-size/IV/tag证据，明文不等于ciphertext。 | NOT_RUN |
| CIP-02 | 新密文使用独立随机IV；AAD绑定purpose/record/platform/schema/payload revision，篡改或跨记录调换失败。 | 重复encrypt和篡改nonce/tag/AAD/key fixture。<br>证据：decrypt fail closed；无跨slot秘密误用。 | NOT_RUN |
| CIP-03 | API key、binding key、cipher key用途独立，key缺失/错误无明文或Env静默降级。 | 三个key分别变更，非法key和unknown key id fixture。<br>证据：API轮换不改binding；cipher故障停止依赖操作并安全报错。 | NOT_RUN |
| CIP-04 | active token、OAuth候选、OAuth1 request secret、PKCE verifier均以密文存储；主key不在D1/R2。 | 完整auth/refresh生命周期SQL与归档sentinel扫描。<br>证据：敏感payload不落明文，仅安全元数据可查询。 | NOT_RUN |
| CIP-05 | 旧明文迁移按记录读取→加密→CAS提交→清除active明文，可中断恢复。 | fresh/legacy混合夹具，各阶段故障/重复迁移/并发revision变化。<br>证据：已完成不损坏、冲突不覆盖、未迁移不能被正常发布路径读取。 | NOT_RUN |
| CIP-06 | 同grant refresh与相同绑定payload重加密不因随机ciphertext变化而误判换号。 | 控制binding材料和IV/revision变化，比较旧scheduled任务校验。<br>证据：binding稳定且revision fence有效；真实重连仍阻止旧任务改目标。 | NOT_RUN |

### 索引、预算、retention与诊断

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| OPS-01 | outbox due/recovery、publication retry/stale、lookup/idempotency热点使用适当索引。 | 有代表性数据量上EXPLAIN QUERY PLAN，检查语义索引而非脆弱完整字符串。<br>证据：query-plan输出、索引名称和无无界full-table扫描证明。 | NOT_RUN |
| OPS-02 | 本地/参考runtime实测每tick statements及rows-read/write；batch不绕过per-invocation预算。 | 空队列、20job、混合维护/恢复夹具采集adapter数据。<br>证据：采样数值/运行版本/预算截断；不把估算写成计费精确值。 | NOT_RUN |
| OPS-03 | 诊断只读且有鉴权；size未知给null/reason/observedAt，不捏造百分比。 | GET/SDK/CLI调用、权限拒绝和adapter无size权限fixture。<br>证据：零业务写/zero SNS，pending age/retry/DLQ/archive字段定义一致。 | NOT_RUN |
| OPS-04 | 30/90天archive lifecycle是policy而非到秒物理删除保证，core不调用lifecycle API。 | adapter policy配置测试、过期对象读测试、依赖检查。<br>证据：期限/prefix正确、延后物理删除如实说明。 | NOT_RUN |
| OPS-05 | outbox清理只移除保留期外已完成父任务的旧意图，不删活跃/未知/幂等或域结果。 | 30天边界、当前等待job、unknown与idempotency夹具。<br>证据：GC前后可恢复性/原receipt一致，有界删除且可重跑。 | NOT_RUN |
| OPS-06 | 容量60/80%阈值为配置诊断，不是domain上限；队列和存储预算不保证永远免费。 | 部署profile可替换限额，未知容量/达到阈值fixture。<br>证据：无500MB硬编码业务拒绝；运维提示与官方出处分离。 | NOT_RUN |

### 切换与兼容性

| ID | 标准 | 验证方法 / 必需证据 | 状态 |
|---|---|---|---|
| CUT-01 | 新物理版本化Queue/DLQ与旧裸ID消息隔离；不得自动清空旧队列。 | 旧新消息混合、停旧consumer后启动新consumer的隔离切换演练。<br>证据：旧协议不触发新执行，待处理消息有清单和处置记录。 | NOT_RUN |
| CUT-02 | legacy pending/scheduled回填最多一条相应attempt job，available_at取schedule/retry/cutover最大值。 | 旧attempts=0/1/2/3、未来/过去时间与重复backfill。<br>证据：无提前发送/重置budget/重复job；超预算记录不再可执行。 | NOT_RUN |
| CUT-03 | legacy publishing不能回填可执行job；无binding记录仍需原B显式复核。 | 迁移前含publishing/unknown/unbound的混合数据。<br>证据：zero unintended SNS，无将迁移视为授权。 | NOT_RUN |
| CUT-04 | 新增application/transport和R2/cipher/Queue资源完整打包且配置缺失fail closed。 | fresh tarball安装与缺key/bucket/queue配置fixture。<br>证据：Worker能启动或明确阻止写入；不回退绕过ports。 | NOT_RUN |
| CUT-05 | 旧B的六缺陷、auth/CAS/SDK/CLI安全门槛全部保留，不以新基础设施合同取代。 | 对原66项ID逐条对应新版结果和变化记录，执行相关回归。<br>证据：原ID无消失/改为可选；live仍需要独立授权。 | NOT_RUN |

## 4. 发布与兼容性门槛

本地达标、安装产物达标、live达标和实际发布是四种不同状态。只有其中某层证据完整才可声称该层完成。升级fixture必须涵盖停旧consumer/Cron、加密迁移、legacy binding复核、future job backfill和旧协议隔离；不得凭fresh install代替升级验证。

迁移脚本、R2/Queue配置和部署辅助工具的验证只能在一次性环境执行。不能把`--dry-run`自动解释为无本地生命周期副作用。当前设计交付没有运行以上任何产品步骤。
