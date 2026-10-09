# Syndroo Architecture v1 — 验收矩阵

**59 项验收场景，当前全部为 `NOT_RUN`。** 这是设计交付的验收定义，不是运行结果。

每项执行证据必须记录：源码 commit/dirty 状态、runtime/adapter、隔离 fixture、实际命令、退出码、断言结果和相关输出。安全/并发/恢复不能只用代码审查替代执行。不得为验证而真实发布、删除远端内容、使用真实凭据或部署生产。

同一源码发生相关修改后，旧的通过结果不能替代新一轮验证。单元/fixture 通过不等于平台 live acceptance，更不等于 Cloud multi-tenant 安全验收。

## CLI/协议

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| CMD-01 | 仅三个一级业务命令；无 auth/posts/receipts/retry/state/plugin 等旧入口；裸 CLI 展示帮助。 | Q2,Q8,Q13,Q25,Q39 | 调用命令发现与 --help；旧命令拒绝且无业务副作用。 | NOT_RUN |
| CMD-02 | help/version 在缺配置、缺依赖插件、缺凭据和 stdin 未关闭时仍可完成。 | Q11,Q13 | secret/network/state-write/plugin-import spies 全部为 0。 | NOT_RUN |
| CMD-03 | 每次机器调用 stdout 恰好一个 JSON envelope，无 ANSI；诊断只在 stderr。 | Q11,Q38 | 解析完整 stdout，检查额外字节与各失败路径。 | NOT_RUN |
| CMD-04 | 未知/重复/冲突 flags、错误 type union 不回显原始 secret；不读取不需要的输入。 | Q11,Q13 | 假 token canaries 在 argv、路径及错误对象中均不泄漏。 | NOT_RUN |
| CMD-05 | JSON 模式返回 action_required/confirmation_required，不隐式提示或自动批准。 | Q18,Q22 | 无人值守输入无阻塞，provider write count=0。 | NOT_RUN |
| CMD-06 | dry-run 不读 secret、不联网、不初始化、不写 intent；不足的信息明确标为未验证。 | Q13,Q16,Q22 | 空 state 与已有 state 两种 fixture；检查状态目录和所有 side-effect spies。 | NOT_RUN |
| CMD-07 | 人类/JSON/verbose/color 只改变渲染，不改变提交正文、空白、Unicode 或选项。 | Q11,Q22,Q23 | 注入控制字符与多行文本；比较冻结及发出 payload 字节。 | NOT_RUN |
## Plugin

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| PLG-01 | 全局安装的 CLI 能从指定 config 的依赖树解析插件，切换 cwd 不改变选择。 | Q5,Q14,Q36 | 两个项目同名不同版本插件；显式 config 固定命中一个。 | NOT_RUN |
| PLG-02 | 未经授权时绝不 import；伪装为 official 的 manifest 不获得信任。 | Q7,Q15,Q36 | 带顶层执行计数器的未信任 fixture，计数为 0。 | NOT_RUN |
| PLG-03 | 坏 override、不符 id/API、非法 schema 均拒绝，无 fallback，无任意目标 SNS 写入。 | Q5,Q6,Q36 | 与有效的另两个目标混合请求；全部 write count=0。 | NOT_RUN |
| PLG-04 | 升级 package/依赖 fingerprint 后不复用旧批准；删除 override 只影响新操作。 | Q5,Q7,Q22 | 两份版本 fixture 交替激活；旧 token 执行应拒绝而不是切换。 | NOT_RUN |
| PLG-05 | 官方和第三方走同一接口/测试；Plugin API 不暴露 store、全部 env 或其他账号凭据。 | Q1,Q3,Q4,Q15 | 参数结构和 fake secrets 检查；不得声称由此证明 sandbox。 | NOT_RUN |
| PLG-06 | 同一来源 definition 导出 manifest/schema，package version 一致；源码和参考导出无漂移。 | Q12,Q31,Q36 | 重新生成 reference，比较 fingerprint 与版本。 | NOT_RUN |
| PLG-07 | Node-only 第三方依赖不会因 contract 一致被误称为 Cloudflare 兼容。 | Q14,Q36 | Worker bundle 反例必须失败；官方 Provider 各 runtime 单独测试。 | NOT_RUN |
| PLG-08 | Cloud 业务请求不能指定代码路径、上传包或启用任意 tenant Provider。 | Q27,Q32 | 请求注入 registry override 被 schema/authz 拒绝；代码计数为 0。 | NOT_RUN |
## Schema/发现

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| SCH-01 | schema 不远程加载 ref、不改写输入，拒绝循环/depth/size 超限与不支持方言。 | Q12 | fake network=0；验证前后请求 deep-equal；恶意 schema 明确失败。 | NOT_RUN |
| SCH-02 | status 只有五种 query；分页有界且稳定，错误 cursor 被拒绝。 | Q30,Q37 | 同时间 operation fixture、并发插入后无重复遍历；无通用 DSL。 | NOT_RUN |
| SCH-03 | status 不调用 Provider，不读 secret、不写状态、不联网刷新；元数据变化报告 stale。 | Q16,Q30,Q37 | 未授权与已批准插件都检查 import/side-effect spies。 | NOT_RUN |
| SCH-04 | declared/observed/unknown/stale 不混淆；身份验证成功不自动标记全部功能可用。 | Q16 | token/plugin/schema revision 变化使旧 observation 失效。 | NOT_RUN |
| SCH-05 | description/diagnostic 内嵌指令只作数据，不改变 Agent 目的地、授权或秘密输出。 | Q11,Q12,Q30 | Skill 安全 fixture 与 Core 目标验证；不宣称对所有模型注入已证明免疫。 | NOT_RUN |
## Connect

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| CON-01 | env/file 是一次性导入；成功后删源文件/清 env 仍用 managed secret；原文件不被主动删除。 | Q3,Q17 | 使用假凭据与 fake provider 完成连接、移除源、发布预检。 | NOT_RUN |
| CON-02 | 隐藏输入和 callback secret 不进入 public result/status/log/argv。 | Q3,Q17,Q18 | 所有输出、状态 metadata、异常快照扫描 canaries。 | NOT_RUN |
| CON-03 | Session TTL、scope、provider、implementation、step revision 固定，非法 resume 无副作用。 | Q18,Q29 | fake clock 与交叉 session 输入；exchange/write count=0。 | NOT_RUN |
| CON-04 | 伪造/重复/过期/混用 provider OAuth callback 拒绝；client callback_complete 不是认证证据。 | Q18,Q29 | state/redirect/PKCE 错配与并发 callback 隔离 fixtures。 | NOT_RUN |
| CON-05 | secret 暂存和 Connection CAS 任一步故障不破坏旧绑定，不误报完成。 | Q3,Q17 | 分步故障注入；无引用 blob 可安全识别；不擅删未知提交结果。 | NOT_RUN |
| CON-06 | 首次默认、多个账号选择、label 冲突、无 default 歧义和 duplicate target 都确定处理。 | Q19 | 两账号/两 label/一实际账号组合；错误时 write count=0。 | NOT_RUN |
| CON-07 | 重连同账号保留稳定身份；不同账号不覆盖旧 connection；disconnect 不删除历史。 | Q3,Q19,Q20 | 已有 succeeded delivery 在重连/改 label 后仍不能重发。 | NOT_RUN |
## Publish

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| PUB-01 | 新 content+targets 文档合法，旧 key/schemaVersion/platforms/overrides 不自动迁移。 | Q21,Q25 | 解析新旧 fixtures；错误定位对象与安全字段路径。 | NOT_RUN |
| PUB-02 | 多目标所有预检在任何 SNS 内容写入前完成；一目标非法则 0 写入。 | Q6,Q22 | 混合有效/无凭据/无权限证据/无插件 target。 | NOT_RUN |
| PUB-03 | prepared intent 在返回 token 前持久保存；进程重启后仍可执行同一快照。 | Q18,Q22 | prepare-response-loss 和 prepare-after-commit crash fixtures。 | NOT_RUN |
| PUB-04 | 确认期间修改输入文件/default/label 不改变 payload 或目标；变更绑定/插件则拒绝旧 token。 | Q19,Q22,Q23 | 冻结后修改源/配置/版本；比对发送内容与 stale 错误。 | NOT_RUN |
| PUB-05 | 错误 token、跨 scope token、过期未消费 token 不能 admission；并发 execute 只 admission 一次。 | Q22,Q27,Q29 | 隔离并发请求；精确计数 admission 与每目标提交。 | NOT_RUN |
| PUB-06 | 同 key 同请求 replay、不同请求 conflict；响应丢失后复用 key 拿回原 operation。 | Q20 | 在 prepare/admit/response 各边界注入断连，operation 数不增长。 | NOT_RUN |
| PUB-07 | 两次明确新意图可发布相同文字；不同 key 不能用作恢复 unknown 的安全建议。 | Q20,Q24 | 区分正常新发布 fixture 与恢复流程的 Skill 断言。 | NOT_RUN |
| PUB-08 | retry 保持原 operationId 和逻辑目标，重复 retry key 不增加轮次，成功目标不再发送。 | Q13,Q20,Q24 | 先 partial 后 retry；检查累计 attempts 和结果变化。 | NOT_RUN |
| PUB-09 | unknown/permanent failure/未到 retryAfter/三次上限/非原目标均不能获得可执行 retry。 | Q24 | 每一种反例检查无重试 intent 或明确拒绝、无额外 write。 | NOT_RUN |
| PUB-10 | Provider malformed result、发送后 throw/timeout/取消均保守 unknown，而非 not_applied。 | Q24 | 不同 HTTP/网络时序 fixtures；不按错误字符串猜判定。 | NOT_RUN |
| PUB-11 | freeze 无 I/O、无 secret、确定；preview 覆盖所有用户可见内容与有副作用选项。 | Q22,Q23,Q36 | 固定 clock/seed 重放；两平台/两账号不同正文比对。 | NOT_RUN |
| PUB-12 | 成功后记录失败，保留 durability 异常；不由 renderer/EPIPE 触发重新发送。 | Q22,Q24 | Provider success → state write fail / stdout fail；write count 保持 1。 | NOT_RUN |
| PUB-13 | timeout/lease 过期不抢占可能已发出的目标；旧执行者迟到结果不能开启新提交。 | Q20,Q24,Q26 | 两个 worker、延迟网络返回、重复消息 fixtures。 | NOT_RUN |
## 存储/执行

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| STR-01 | filesystem、SQLite、D1 实现相同业务原子动作，而不是仅通过接口编译。 | Q9,Q10,Q35 | 每个 adapter 运行同一状态迁移/冲突/幂等 contract suite。 | NOT_RUN |
| STR-02 | 文件锁、临时写、提交标记在任一崩溃点只呈现可判定状态；未知锁不自动删除。 | Q10,Q35 | disposable filesystem crash fixtures；status 只读不修复。 | NOT_RUN |
| STR-03 | admission 与 pending 工作记录原子；commit 后 enqueue 失败仍可恢复。 | Q26,Q35 | 强制 notifier 失败、恢复扫描再唤醒；不丢单也不二次 admission。 | NOT_RUN |
| STR-04 | Queues 重投/乱序/DLQ 不直接成为 SNS 重试；claim 拒绝已成功/unknown。 | Q24,Q26 | 重复消费同一 payload，多消息并发；SNS 写入计数不增长。 | NOT_RUN |
| STR-05 | 本地 CLI 与远程 Server state 不自动同步，不把跨部署 operation 当本地可重试。 | Q9,Q10,Q20 | 两个完全隔离的 stores；跨 runtime id 返回 not found/授权错误。 | NOT_RUN |
| STR-06 | secret 权限或 Server 加密密钥错误时失败；修改密文/AAD 不可读；无明文 fallback。 | Q3,Q17,Q27 | POSIX 权限 fixtures；AEAD tamper 与错 key 反例；日志无 secret。 | NOT_RUN |
## Server/SDK

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| API-01 | 三个业务路由强制 Bearer；缺 key 拒绝启动；未知/错误凭据不能加载插件或查私密数据。 | Q27,Q28,Q29,Q33 | HTTP 集成测试含 /health 最小输出与 callback 例外。 | NOT_RUN |
| API-02 | OAuth/async 配置仅启动组合；模块配置不全 fail closed；无动态管理或 auth-disable API。 | Q27 | 组合矩阵测试，不依赖人工读 config 判断。 | NOT_RUN |
| API-03 | SSRF 防护覆盖 URL、DNS rebinding、redirect、private/link-local/metadata 地址。 | Q27,Q29 | 隔离 resolver/transport fixtures，禁止访问实际 metadata 或内网。 | NOT_RUN |
| API-04 | CLI 与 HTTP 的 connect/publish/status 结果语义相同；202 只用于 durable admitted execution。 | Q9,Q26,Q33 | 共享 fixtures 对比协议结果；fake queue commit gap 反例。 | NOT_RUN |
| API-05 | SDK status 返回类型随 query 精确变化；wait 只查询，不发 publish。 | Q34,Q37,Q38 | 类型断言和 HTTP spy；wait 超时/取消不取消远端 operation。 | NOT_RUN |
| API-06 | SDK 打包消费者不依赖 Core/Provider SDK/private workspace；官方 Provider 可独立消费。 | Q4,Q36,Q38,Q39 | 从实际 tarballs 在干净临时项目安装并编译/运行 fixtures。 | NOT_RUN |
| API-07 | 同 Agent prepare+execute 不能证明真人阅读；产品文案、tests 不伪造独立人审保证。 | Q7,Q22 | 确认必须显式；书面审查能力边界，独立批准证明标为非本版能力。 | NOT_RUN |
| API-08 | 为 Cloud 接入时跨 tenant 的 token/key/connection/operation/queue/cache 不串用。 | Q27,Q28,Q32 | Cloud 开放前运行交叉 tenant fixtures；未实现时保持 NOT_RUN，不自动继承 Core 通过。 | NOT_RUN |
## 文档/交付

| ID | 验收断言 | 决策 | 所需证据 | 状态 |
|---|---|---|---|---|
| DOC-01 | 每个官方平台独立教程，包含可操作的凭据获取步骤，不仅有字段表。 | Q31,Q39 | 链接/教程结构检查；授权步骤按平台官方来源复核。 | NOT_RUN |
| DOC-02 | reference 来源固定官方 artifact 与 fingerprint，命令/示例/schema CI 不漂移。 | Q12,Q31,Q36 | 生成diff、JSON解析和真实 packaged CLI 对照；缺产品 checkout 不跳过。 | NOT_RUN |
| DOC-03 | Skill 可随包安装，无需恢复 skill 一级命令；完整 prepare→confirm→execute→status 例子。 | Q11,Q13,Q39 | 包内文件存在及 dry fake-Agent walkthrough；不调用真实 SNS。 | NOT_RUN |
| DOC-04 | 新版无 legacy 协议/命令/importer，不扫描、迁移或删除旧用户数据。 | Q25 | 旧目录 sentinel 不变；新目录重新初始化、旧格式明确拒绝。 | NOT_RUN |
| DOC-05 | 文档与报告严格区分设计、fixture-tested、live-validated、已发布/部署。 | Q31,Q39 | 检查 release 文案与对应证据；未真实验证不得升级状态。 | NOT_RUN |

## 本次真正执行的检查

本次只对交付文件进行静态规格检查：Q1–Q39 编号覆盖、验收 ID 唯一性、Markdown code fences、JSON 示例语法、相互引用与 ZIP 完整性。此类检查不能证明产品行为。具体检查结果在包内 README 中记录。

## 交付与授权边界

批准设计之后，先创建逐任务 implementation plan。真实 SNS 连接/撤销/发帖、部署、发布、购买、不可逆删除等仍需要对应的明确执行授权。旧版本无兼容义务，不等于可自动删除用户机器上的状态和凭据。
