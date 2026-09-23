# Syndroo 0.5.0 — 基线、证据与外部依据

日期：2026-09-21（Asia/Tokyo）。这份文件区分v1仓库观察、历史复现、rev2附件整合和拟议设计，避免把三者混为“修复已完成”。


## 0. revision2本轮的证据范围

本轮输入是已挂载的v1设计文件包与用户附件《Portable Storage & Queue Architecture Spec》。只生成本会话文件，没有连接WebCodex、重读源码、改动仓库、调用模型、执行D1/R2/Queue/cipher产品测试或进行生产操作。下方A–C的“v1形成时”是保留的历史观察，不能当作本轮最新HEAD证明。

来源分层：**S-BASE**为v1设计（历史ZIP逐字保留）；**S-ADD**为用户新增spec（原文逐字保留）；**整合审查§2/ADR**为本轮整合决定；**E9–E20**为本轮公开一手资料核对。原文缺失的事务/retry/DLQ细节明确标为整合补充，不隐称源文件已有。

- S-BASE：[原v1设计ZIP](sources/v1-original-design-package.zip)。
- S-ADD：[原始新增spec](sources/portable-storage-queue.original.txt)，2323行；标题、53节组织和RULE-001–015保持原样。
- 逐节/逐RULE追踪：[整合审查](06-INTEGRATION-REVIEW.md)。
- 字节哈希见input-provenance.json；当前文件的自洽检查见document-validation.json，与产品验收无关。

## A. v1形成时的历史仓库观察

通过用户指定的 WebCodex MacBook 连接读取 `syndroo/`，不是从公共网站替代私有工作区内容。

| 项目 | v1形成时观察 |
|---|---|
| 分支 | main |
| 提交 | d8206f298333eeb83d45d319ea244bbda72c78f7 |
| 提交说明 | feat: agent-guided platform auth + descriptor refactor |
| 工作区变动 | 仅 packages/cli/src/main.ts，用户已有3行删除 |
| main与本地origin/main跟踪状态 | ahead=0、behind=0；未fetch，不声称再次查询了远端服务器 |
| v1形成时操作 | 只读源码/技能和文档，生成会话附件 |
| v1形成时产品测试/代码/迁移 | 未执行/未修改/未执行 |

v1形成时收尾再次读取了HEAD、git status和完整CLI diff：仍是原有3行删除。没有接受、撤销或提交它。

## B. 代码与仓库文档依据

以下相对路径均基于上述commit；只有明确标为dirty的CLI文件是用户工作区版本。某些完整调用链来自前一次审查；v1形成时对核心设计所依赖的关键段落进行了再读，未把全仓库重新完整扫描说成已完成。

<a id="b1"></a>

### B1 — 凭据规则与准入不一致

`packages/cloudflare-worker/src/posts.ts:25–33,160–181` 在解析时读取Env配置；`publishers.ts:9–25` 区分env-only判断和D1 publisher解析；`platform-descriptors.ts:51–80,104–310` 分别实现多套配置判断；`auth.ts:79–114` status又读取D1。

v1形成时重读 `platform-descriptors.ts:45–349`，文件SHA256：`d2baaf861561140969648e4bb731ac1da731a87f55d71d7bfbfbc27f0e2da315`。

<a id="b2"></a>

### B2 — 发布阶段和持久化边界

`packages/cloudflare-worker/src/publishing.ts:43–74,106–118,180–190` 将resolvePublisher与publish放在同一catch，并将非PublishError转换为UNKNOWN/ambiguous。

`repository.ts:207–230` 领取时增加attempt；`232–284` 结果更新原本未使用claim token；`337–362` stale recovery重新检查状态；`365–437` credential/state存储。

v1形成时重读 publishing完整文件与repository上述部分；SHA256分别为：

- publishing：`e29ce667fb43c0bf7d8e3b5ac5dc6b69fdb3c1f328c4fa7596ba4f496a68c003`
- repository：`b5b9a1b848d69f1e6f81a769ea85e1e3d46c9c3a44be272bd3682f791cf85a47`

<a id="b3"></a>

### B3 — SDK的异常receipt

`packages/sdk/src/types.ts:139–146` 的第一层requireRecord没有传context。v1形成时重读该段，文件SHA256：`ab5b24abc8c1257e7f7b321a236e1f57732c4a906e3ff8a22725de8fdf088f23`。

`packages/sdk/src/errors.ts:35–42` 默认把缺失的requestMayHaveBeenApplied解释为false；这段来自上一轮完整源码审查。

<a id="b4"></a>

### B4 — OAuth覆盖元数据与并发窗口

`packages/cloudflare-worker/src/auth.ts:257–264,398–417` 使用独立state读取/删除，callback构造新token对象后upsert；`443–487` refresh先外部请求再整条更新。

v1形成时重读 `240–519`，文件SHA256：`08723398c947c28890f34704119028aa7a44d4234dc7148648513ae8af6e7b89`。

<a id="b5"></a>

### B5 — SDK/CLI生命周期与命令入口

`packages/sdk/src/client.ts:545–577` unref轮询sleep；committed `packages/cli/src/main.ts:43–50,119–120` 用keepAlive补救；working tree删除了interval和finally清理。

v1形成时读取CLI args `1–160`，当前命令入口尚无auth操作；文件SHA256：`0be6c495fcf97dd944ec23186e6099ce3a72ea3ce3eb72df441333e38c8fd651`。

working tree的 `packages/cli/src/main.ts` SHA256（前次预检已读取）：`a6f8550c657449ebcfa0aa07f24ecb853b008d6e1e5bb68de19d7ba4afb92754`。v1形成时status确认该变动仍存在。

<a id="b6"></a>

### B6 — 网络与调度基线

上一轮在相同commit读取：X `src/index.ts:32–38`、Tumblr `76–81`、LinkedIn `47–58` 使用redirect:error；Bluesky `137–143`已使用manual；Threads `71–79`没有显式禁止跟随。

Worker `scheduler.ts:5,16–21` 每次取50条；`wrangler.jsonc:42–43` 每15分钟Cron；`api.ts:35–40` admission维护不暂停Queue/Cron。这是旧基线；revision2按新增附件把每分钟有界dispatcher纳入设计，但没有改过实际wrangler。

<a id="b7"></a>

### B7 — 多包发布准备

v1形成时重读 `docs/releasing.md:1–47,49–149`。文档列出SDK→CLI→Worker三包列车及当前版本不一致/工作流接线缺口。文件SHA256：`fbc9f489b004aaa4357145b84a2e9be175b516fe72863e5ca319c876e7ed0798`。

这是仓库文档记录的现状，不是v1形成时执行release-train或查询npm得到的结果。后续必须用当前源码与fake registry检查，真实registry/发布授权分别处理。

<a id="b8"></a>

### B8 — 使用的方法

v1形成时读取了提供的 Superpowers brainstorming 技能，并从本机读取用户指定的 curated Ponytail：`engineering-suite-ponytail/2.0.0` 的entry、ponytail和ponytail-review。

使用它们分别组织需求/边界/决策与检查无收益复杂度。没有替换成另一个同名Ponytail项目。没有调用编码子模型。文件中的设计方案由本次架构分析形成，不是技能文件提供的项目事实。

## C. 上一轮审查的历史执行证据

以下仅记录同一对话中已产生的结果，**v1形成时未重跑**：

| 历史检查 | 当时观察 | 适用限制 |
|---|---|---|
| D1-only凭据流程 | store200、status configured=true、创建解析422 | 内存repository + 实际源模块；不是完整真实账户E2E |
| 发布前D1故障注入 | ack、UNKNOWN/ambiguous、retry=false | 实际executor + 故障repository，不是线上事件 |
| SDK malformed202 | null/[]丢失status与应用可能性；{}保留 | 实际SDK源码 + 假HTTP响应 |
| LinkedIn callback | 原author/api_version被新token对象覆盖 | 实际处理函数 + fake OAuth响应 |
| pinned workerd fetch | error模式参数被拒绝；manual可到达出站stub | 当时安装的Miniflare/workerd与兼容日期，不推广到所有版本 |
| 独立SDK wait | 退出前仅1次read，Promise未settle | 独立Node + 源码与fake响应 |
| 既有测试 | Core+5个平台99通过；SDK50通过 | 不是0.5.0实现后的验收 |
| Worker测试 | Node26全量在Worker阶段600秒timeout；Node24单独45秒timeout | 具体根因尚未查明；日志缺secret警告不足以证明因果 |

revision2每一项产品验收从NOT_RUN开始，不能继承这149个历史测试通过来宣称0.5.0质量。

## D. 外部一手依据

只用于支持运行时/协议事实，设计中的API、字段、任务安排及取舍是本项目建议，不是下面来源的原文结论。资料于2026-09-21查询；实施时对平台app能力与锁定依赖再次核对。

<a id="e1"></a>

### E1 — Cloudflare Request

来源：<https://developers.cloudflare.com/workers/runtime-apis/request/>

用途：manual redirect与敏感header的转发风险。公开文档同时列出follow/error/manual；本地历史workerd对error的拒绝是另一条实测证据，不能把文档与实测的差异隐藏或外推。

<a id="e2"></a>

### E2 — Cloudflare D1 Database

来源：<https://developers.cloudflare.com/d1/worker-api/d1-database/>

用途：batch事务及SQL异常时的回滚。它不自动保证本项目的逻辑CAS，也不把UPDATE 0行变成异常；业务条件必须自行落实并验证。

<a id="e3"></a>

### E3 — Cloudflare Queues delivery guarantees

来源：<https://developers.cloudflare.com/queues/reference/delivery-guarantees/>

用途：at-least-once与重复投递处理。它不提供D1和SNS之间的共同事务或exactly-once业务承诺。

<a id="e4"></a>

### E4 — RFC 9700：OAuth 2.0 Security BCP

来源：<https://www.rfc-editor.org/rfc/rfc9700.html>

用途：授权码流程、state/PKCE保护、refresh token轮换及重放风险。Syndroo是保密服务端客户端；不把公共客户端的具体要求不加区分地套到本项目。持久refresh lease是本设计据风险作出的实现选择，不是RFC指定的表结构。

<a id="e5"></a>

### E5 — SQLite RETURNING

来源：<https://www.sqlite.org/lang_returning.html>

用途：UPDATE/DELETE的原子返回行能力及限制。不能把带RETURNING的DML嵌入CTE当作SQLite支持的通用能力；D1具体调用形式需实际local测试。

<a id="e6"></a>

### E6 — RFC 5849：OAuth 1.0

来源：<https://www.rfc-editor.org/rfc/inline-errata/rfc5849.html>

用途：临时token/verifier绑定、签名参数处理与percent encoding。只为本项目实际端点和载荷建立有限、测试充分的实现，不宣称覆盖任意OAuth1扩展。

<a id="e7"></a>

### E7 — LinkedIn native-client OAuth/PKCE

来源：<https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native>

用途：说明PKCE支持涉及应用配置和原生loopback场景，不能由“文档里出现PKCE”推出任意Worker保密客户端都可无条件启用。本文件没有验证用户的LinkedIn app权限。

<a id="e8"></a>

### E8 — Node timers

来源：<https://nodejs.org/api/timers.html>

用途：unref不保持事件循环存活，可能在timer触发前退出。SDK的默认生命周期是本项目设计选择，不是对Node行为的修补。

## E. 没有验证的事项

v1形成时没有测试新SQL、真实账户、真实OAuth/refresh、Worker生产版本、包发布或迁移后回退；没有读取真实secret。新HMAC绑定、OAuth候选流程、refresh lease与claim fencing都需要未来实现与验收证明。

该文件包记录了设计自查和附件完整性检查，不将其等同于安全审计完成或正式版本验收。

## F. 本轮新增的一手核对（2026-09-21）

仅核对公开产品/协议行为；不据此扩大生产授权。检索页均为官方资料，无需引用第三方营销或旧博客推测。

<a id="e9"></a>

### E9 — Cloudflare Queues Limits

来源：<https://developers.cloudflare.com/queues/platform/limits/>

本轮核对：send/retry delay最大24小时；达到retention的消息会删除；Free retention固定24小时。用于长期调度与stalled transport设计，不代表SNS幂等保证。

<a id="e10"></a>

### E10 — Cloudflare Queues batching/retries与JavaScript API

来源：<https://developers.cloudflare.com/queues/configuration/batching-retries/>

本轮核对：message ack/retry、批处理与max_retries属于Queue runtime；基础设施预算独立于Syndroo的Publisher三次预算。应用到runtime的映射是本项目设计。

<a id="e11"></a>

### E11 — Cloudflare Dead Letter Queues

来源：<https://developers.cloudflare.com/queues/configuration/dead-letter-queues/>

本轮核对：耗尽配置的重试后可转DLQ；没有DLQ的消息可能被删除。如何避免迟到DLQ覆盖published是本项目guard，并非平台自动处理。

<a id="e12"></a>

### E12 — Cloudflare R2 Object lifecycles

来源：<https://developers.cloudflare.com/r2/buckets/object-lifecycles/>

本轮核对prefix规则和生命周期删除；对象通常在expiry后24小时内移除，既有对象可能更久。30/90天默认值来自用户建议，不是平台必须值。

<a id="e13"></a>

### E13 — Cloudflare D1 Limits

来源：<https://developers.cloudflare.com/d1/platform/limits/>

本轮核对Free单库500MB/账号5GB/每调用50查询、每语句100绑定参数。实现必须在实际statement与runtime预算内；本设计未测量未来代码用量。

<a id="e14"></a>

### E14 — Cloudflare D1 Pricing

来源：<https://developers.cloudflare.com/d1/platform/pricing/>

本轮核对Free每日500万rows read/10万rows written；查询扫描和索引写入影响用量。不能把接口调用次数直接当row计量或预计数据寿命。

<a id="e15"></a>

### E15 — W3C Web Cryptography（AES-GCM）

来源：<https://www.w3.org/TR/webcrypto/>

本轮核对标准AES-GCM能力。选择256-bit key、96-bit随机IV、128-bit tag和业务AAD是本项目最小安全设计；未实现或运行密码测试。

<a id="e16"></a>

### E16 — Cloudflare Web Crypto

来源：<https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>

本轮核对WebCrypto/AES-GCM可用性。具体locked runtime仍需与Node/fake等互操作测试；不声称本轮已通过。

<a id="e17"></a>

### E17 — Cloudflare Queues Pricing

来源：<https://developers.cloudflare.com/queues/platform/pricing/>

本轮核对Free 10,000 operations/day和24h retention；operation按消息读写删除计量，batch不等于一次计费操作。参考，不保证整个Syndroo免费。

<a id="e18"></a>

### E18 — Cloudflare R2 Public buckets

来源：<https://developers.cloudflare.com/r2/buckets/public-buckets/>

本轮核对public bucket/r2.dev/custom domain设置。禁止公开archive以及prefix不是ACL是本项目访问边界设计；未检查用户真实bucket。

<a id="e19"></a>

### E19 — Cloudflare D1 Use indexes

来源：<https://developers.cloudflare.com/d1/best-practices/use-indexes/>

本轮核对EXPLAIN QUERY PLAN和索引定位。最终schema的计划、rows-read/write需本地实测，文档示例不能当执行证据。

<a id="e20"></a>

### E20 — Cloudflare R2 Workers API

来源：<https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>

本轮核对R2 bucket绑定的put/get/delete/head等能力；BlobStore/ArchiveStore对外仅返回平台中立值，具体mapping需contract验证。

补充端点文档：<https://developers.cloudflare.com/queues/configuration/javascript-apis/>；Cron配置：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>。仅用于runtime接线，不向application暴露相关类型。
