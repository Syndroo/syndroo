# Syndroo 0.5.0 — 新存储/队列spec整合审查

文档版本：2.0；状态：Proposed / 待评审；仅本会话文件。本文不是源码审查重跑或实施结果。

## 1. 输入、保真与决策层级

本轮输入是用户新增的 **Syndroo 0.5.0 — Portable Storage & Queue Architecture Spec**（53节、15条最终规则），与此前0.5.0设计包。原文逐字保存在 [portable-storage-queue.original.txt](sources/portable-storage-queue.original.txt)，旧包原样保存在 [v1-original-design-package.zip](sources/v1-original-design-package.zip)，输入hash见 [provenance](input-provenance.json)。

原附件说明不要全盘替换旧设计，允许沿用更强的domain命名，同时不能以保留旧实现为由弱化可移植/一致性/调度/幂等保证。因而本修订**保留B的六项回归和完整授权保护，明确替代与新要求冲突的旧架构决策**。不是把新原文变成可有可无的未来建议，也不是逐表照搬概念伪代码。

本文表中的“采纳”是对来源要求的保留；“适配/加强/明确选择”是本次整合判断，需连同主规格评审，不冒充来源已经规定了细节。“范围说明”不删除规范保证，只区分基础设施合同与尚未请求的产品功能。

## 2. 与旧方案冲突的核心决策

| 项目 | v1设计 | revision2合并结果 | 代价/限制 |
|---|---|---|---|
| 应用依赖 | 应用函数直接使用具体D1Repository | application拥有portable ports，D1只是实现 | 新私有application包、合同/依赖测试；不增加通用ORM/DI |
| Outbox | Publication兼任outbox，不加独立表 | 新增outbox_jobs，创建与安全retry均原子写入 | 增加存储/维护/索引；明确GC，不能无限增长 |
| Provider retry | durable retry_at但交给Queue delay重投 | future outbox+ACK旧消息；Queue retry仅infra | 旧job与新attempt必须fencing；默认业务仍三次 |
| 名称 | Post聚合、Publication单平台 | 保持公开名称；附件Delivery映射既有Publication | 不新增重复deliveries表或/v1/publications接口 |
| unknown/dead_lettered | failed+ambiguity，未独立DLQ语义 | 保留公开枚举；安全terminalReason；DLQ须当前job/claim guard | infra失败不等于SNS确定没发出 |
| 授权 | B的revision/binding、候选complete与refresh lease | 全部保留并通过语义事务ports实现 | 新port不能降低原CAS、未知结果和换号保护 |
| 密文凭据 | 完整加密暂不在原B范围 | 采纳附件§28 SHOULD，加入最小CredentialCipher/AES-GCM及明文迁移 | 新独立key、停机迁移、备份风险；仍不做自动轮换/KMS |
| R2/Logger | 原B不引入完整R2链路 | ArchiveStore和BlobStore独立R2实现，Logger到console/stdout | Blob只有infra合同，不额外发布媒体/webhook产品 |
| 归档“raw” | 禁止原始错误泄密 | 有界allowlist诊断快照，未知body省略；OAuth响应永不归档 | 不承诺完整原始wire payload可还原 |
| bucket隔离 | 未定新R2拓扑 | 默认private archive；media可独立bucket | 共用public bucket+prefix不算隔离 |
| Scheduling | D1 schedule，Cron每15分钟 | 每分钟有界dispatcher；默认20jobs/tick | 是唤醒精度改善，不是秒级SLA或无限吞吐 |
| retention丢失 | pending恢复为主 | dispatched-current-waiting有界rearm，最多3轮后可见终止 | 不依赖“所有丢失消息都必进DLQ”；不自动复活unknown |
| IDs/time | UUIDv4+旧前缀，UTC ISO | 保留；原UUIDv7/epoch示例非强制 | 可移植是语义和端口，不是格式迁移 |
| key/metadata表 | posts上已有唯一idempotency key | 单一posts.create.v1 scope继续复用；不机械新建重复表 | 新command需多scope时另设计，不冒充已有多scope能力 |
| 升级 | B新增schema/绑定复核 | 加cipher/outbox回填/新旧队列隔离 | 不自动purge旧queue、不把maintenance当消费者停止 |

### 必须澄清而不是机械合并的地方

**503示例不是安全重试许可。** 原附件§19列HTTP503为暂时失败示例，但§7、§46和原B都要求不盲重试ambiguous写入。这里以更强安全语义统一：只有能证明未产生发布副作用的temporary错误才排future job；提交后的503/连接中断仍unknown。

**Queue重复与业务重试是两层身份。** `Publication.id`稳定用于逻辑provider请求，`OutboxJob.id`固定一次执行机会；infra重投复用，业务retry新建。只检查Publication是否terminal会让旧消息在retry_at之后越权触发新attempt，因此增加current_job_id+attempt_no检查。

**DLQ不能无条件mark dead_lettered。** 别的重复消息可能已成功，或持有在途claim。late DLQ只能记录transport metadata；只有当前未claim等待任务可判为dead_lettered。unknown不能被改成“确定没发”。

**归档不是另一套可靠发布队列。** provider outcome先落D1，R2失败仅诊断；不为保存完整response而把它塞D1/Queue，也不追加持久raw archive job。本版接受崩溃时丢失少量diagnostic的best-effort边界，不能因此伪称archive成功。

**合同证明边界，不证明未来迁移零成本。** Fake执行证明application不依赖Cloudflare，D1共同合同证明当前事务语义；未来PostgreSQL/S3/Redis仍须实现并验证同一合同、迁移数据和密钥。未实现第二生产profile就不宣称已经跨平台部署成功。

## 3. 来源逐节与最终规则映射

下表行号是 **原始TXT文件自身的1-based行号**，不是其他工具的片段行号。完整机器可读版本见 [source-integration-map.json](source-integration-map.json)。

### 3.1 全部53节

| 原节 | 原标题 / 行号 | 处理与具体落点 | 合并规范位置 | 验收ID |
|---|---|---|---|---|
| §1 | Purpose<br>L10–L45 | **采纳**：CF只作为reference profile，application不依赖Cloudflare。 | 01 §1/3；07 §1 | PORT-01, PORT-03 |
| §2 | Goals<br>L46–L64 | **采纳**：D1状态、R2大对象、queue transport、outbox一致性与低扫描目标同时保留。 | 01 §12–15 | OBX-01, STO-03, OPS-01 |
| §3 | Non-goals<br>L65–L89 | **采纳**：不实现第二套生产PG/S3/Redis/部署profile；fake是测试替身。 | 01 §1；ADR-050-20 | PORT-03, CUT-04 |
| §4 | Architecture<br>L90–L145 | **适配**：ports由application拥有，adapter依赖ports；不用示意箭头误导源码依赖方向。 | 01 §3；07 §3 | PORT-01, PORT-02, PORT-05 |
| §5 | Data ownership<br>L146–L193 | **适配**：保留现有posts/publications/credential slot/key结构；增加outbox与紧凑archive metadata，不机械建所有示例表。 | 01 §10/12 | OBX-01, OBX-10, STO-03 |
| §6 | Domain semantics<br>L194–L273 | **适配**：沿用Post聚合与Publication单目标；Delivery为语义映射，避免破坏/v1。 | 01 §3.4；07 §2 | PORT-06 |
| §7 | Delivery state machine<br>L274–L339 | **适配**：unknown独立语义但映射failed+errorAmbiguous；dead_lettered需guard；不新增draft/cancel API。 | 01 §5；07 §2/7 | PUB-04, QUE-05, QUE-06 |
| §8 | Repository Ports<br>L340–L404 | **适配**：用PublishingStore/CredentialStore/OutboxStore语义事务端口，不按表制造泛型CRUD。 | 07 §3 | PORT-04, PORT-05 |
| §9 | Transaction boundary<br>L405–L450 | **加强**：create含Post/Publications/jobs/key及revision guard；0行CAS亦须全不写。 | 07 §3.3 | CRT-03, OBX-01 |
| §10 | Transactional Outbox<br>L451–L498 | **采纳**：新增独立outbox_jobs，替代v1 publication兼任outbox的取舍。 | 01 §13；ADR-050-05 | OBX-01, OBX-02 |
| §11 | Outbox schema<br>L499–L548 | **加强**：采用概念schema并加attempt_no/current_job_id/dispatch_revision/recovery metadata围栏。 | 07 §4.1 | OBX-05, OBX-06, OPS-01 |
| §12 | Immediate publishing<br>L549–L608 | **采纳**：快路径和Cron同dispatcher，commit后send失败仍保持受理与pending。 | 07 §4.2 | OBX-02, OBX-03, OBX-07 |
| §13 | Scheduled publishing<br>L609–L655 | **采纳**：长期schedule只在D1.available_at；采用每分钟有界wake，不靠Queue长delay。 | 01 §13；07 §8 | SCH-01, SCH-03 |
| §14 | Scheduler Port<br>L656–L692 | **适配**：OutboxDispatcher是应用函数，Cron是薄调用者，不另造Scheduler实现层次。 | 01 §3；07 §8 | PORT-03, SCH-03 |
| §15 | Queue Port<br>L693–L725 | **采纳**：JobQueue.send语义小且明确，ack/retry/CF delay只属runtime。 | 07 §3/5 | PORT-05, OBX-07 |
| §16 | Queue message contract<br>L726–L775 | **加强**：versioned ID-only envelope还需D1身份复核；2KiB是本项目限制。 | 07 §5 | QUE-01, QUE-02, OBX-10 |
| §17 | Queue delivery semantics<br>L776–L797 | **采纳**：consumer假定at-least-once，不以唯一消息ID代替原子claim。 | 07 §5 | PUB-02, QUE-03 |
| §18 | Delivery idempotency<br>L798–L832 | **适配**：原Publication.id作为稳定provider_request_key；平台不支持时不发送虚构幂等参数。 | 07 §2.2/6 | OBX-09 |
| §19 | Provider retry vs Queue retry<br>L833–L906 | **加强**：provider retry用future job；post-write503不因示例temporary列表而安全重试。 | 01 §5.4；07 §6 | PUB-03, PUB-04, OBX-04 |
| §20 | Dead Letter Queue<br>L907–L950 | **加强**：配置DLQ；只有当前未claim等待job可终止，迟到DLQ不覆盖成功/unknown/active。 | 07 §7 | QUE-04, QUE-05, QUE-06, QUE-07, QUE-08 |
| §21 | R2 responsibilities<br>L951–L967 | **采纳**：BlobStore/ArchiveStore与Logger三者语义分离。 | 01 §14；07 §9 | STO-01, STO-08 |
| §22 | BlobStore<br>L968–L1007 | **范围说明**：实现R2BlobStore与合同，但不新增媒体上传/发布产品；MEDIA_BUCKET只在需要时配置。 | 07 §9.1 | STO-01, STO-02 |
| §23 | ArchiveStore<br>L1008–L1036 | **采纳**：实现R2ArchiveStore及生产diagnostic路径，原始响应只保留有界脱敏允许字段。 | 07 §9 | STO-04, STO-05 |
| §24 | Never persist provider URLs<br>L1037–L1076 | **适配**：禁止存储R2/S3物理URL；不禁止外部SNS externalUrl/permalink。 | 07 §9.2 | STO-03 |
| §25 | R2 object layout<br>L1077–L1111 | **采纳**：archive/media逻辑前缀分离，日期+publication/attempt或job key。 | 07 §9.2 | STO-03, STO-06 |
| §26 | Bucket separation<br>L1112–L1144 | **加强**：archive不能public；共享bucket的prefix不是ACL，整体private才可共享。 | 07 §9.1 | STO-02 |
| §27 | Sensitive archive data<br>L1145–L1175 | **加强**：allowlist+大小/字段限制，unknown省略body；OAuth token response完全不归档。 | 07 §9.3 | NET-05, STO-04, CIP-04 |
| §28 | Connection storage<br>L1176–L1229 | **明确选择**：采纳SHOULD：本版加入最小AES-GCM CredentialCipher与旧明文迁移；不做自动轮换/KMS。 | 01 §10.3/14；07 §10 | CIP-01, CIP-02, CIP-03, CIP-04, CIP-05 |
| §29 | Raw response failure semantics<br>L1230–L1265 | **采纳**：D1结果先提交；归档故障不可改变provider结果或创建业务retry。 | 07 §9.3；FM-13/FM-14 | STO-05, STO-06 |
| §30 | D1 source-of-truth rule<br>L1266–L1294 | **澄清**：D1是系统已知状态权威，不意味着能推断SNS未知事实；Queue/R2均非业务状态权威。 | 07 §1 | PUB-04, STO-07 |
| §31 | SQL portability rules<br>L1295–L1330 | **采纳**：SQL/PRAGMA/SQLite/D1优化留adapter，合同不暴露底层语法。 | 07 §3/11 | PORT-02, PORT-05, OPS-01 |
| §32 | IDs<br>L1331–L1372 | **适配**：保留既有应用UUIDv4和前缀；UUIDv7是推荐非强制，不改历史ID。 | 07 §2.2 | PORT-06, CUT-02 |
| §33 | Timestamp model<br>L1373–L1404 | **适配**：UTC Instant为规范ISO字符串；不为epoch示例重写既有时间存储。 | 07 §2.2/8 | SCH-01, CUT-02 |
| §34 | Required indexes<br>L1405–L1447 | **适配**：索引按现有名称和实际hot queries，不为尚不存在webhook产品建表。 | 07 §11.1 | OPS-01, OPS-02 |
| §35 | Suggested project structure<br>L1448–L1505 | **适配**：新增私有application；CF infra留Worker包，migration路径不迁移。 | 01 §3.3 | PORT-01, PORT-05, CUT-04 |
| §36 | Cloudflare bindings<br>L1506–L1547 | **采纳**：Env/bucket/queue/database只在composition root与CF adapter读取。 | 01 §3；07 §3 | PORT-02, PORT-05 |
| §37 | Reference Queue topology<br>L1548–L1588 | **适配**：单业务主Queue+DLQ；物理版本化用于切换，不按provider拆队列。 | 01 §10.4；07 §5/7 | QUE-04, CUT-01 |
| §38 | Consumer algorithm<br>L1589–L1654 | **加强**：先加载/准备后claim，guard当前job与版本；保护原B前置故障/late commit。 | 01 §5.2；07 §5/7 | PUB-01, PUB-02, PUB-05, PUB-06 |
| §39 | Provider error normalization<br>L1655–L1693 | **适配**：保留PublishError兼容，加标准retryAfter/分类；application不按平台名if判断安全重试。 | 07 §6；ADR-050-02/14 | ARC-02, ARC-04, PUB-04 |
| §40 | Retry policy<br>L1694–L1734 | **适配**：沿用三次Publisher总上限与60/120秒，可信Retry-After可延后；示例五次非强制。 | 07 §6 | PUB-03, OBX-05 |
| §41 | Logging<br>L1735–L1775 | **采纳**：小Logger.write结构事件，经adapter到console/stdout；不按日志行写R2。 | 07 §9 | STO-08 |
| §42 | Retention<br>L1776–L1804 | **适配**：provider30天、DLQ90天；未来webhook/audit分别30/90不增产品，物理删除非精确到期。 | 07 §9.4 | STO-07, OPS-04, OPS-05 |
| §43 | Storage capacity policy<br>L1805–L1837 | **适配**：只读diagnostics有count/oldest/size；size不可得为null；阈值是ops config非domain。 | 07 §11.2/11.3 | OPS-02, OPS-03, OPS-06 |
| §44 | Portability target<br>L1838–L1868 | **澄清**：Future profile可以替换相同端口，仍需合同和数据/密钥迁移；本版不宣称迁移零成本。 | 07 §1/12 | PORT-03, PORT-04 |
| §45 | No platform-specific deployment adapters<br>L1869–L1898 | **采纳**：不造Railway/Heroku/Fly业务adapter；未来共享Node/Docker profile。 | 01 §1；ADR-050-20 | PORT-05 |
| §46 | Failure matrix<br>L1899–L1919 | **加强**：保留全部原失败语义并扩为FM-01–22，覆盖旧消息/DLQ/归档/留存/密钥。 | 07 §7 | OBX-01, OBX-03, PUB-04, STO-05, QUE-07, SCH-04 |
| §47 | Testing requirements<br>L1920–L2013 | **采纳**：architecture/repository/queue/scheduling/outbox/archive合同与真实localCF集成并行覆盖。 | 03 全文；07 §12 | PORT-04, QUE-01, SCH-01, STO-01, PKG-04 |
| §48 | Query-plan verification<br>L2014–L2037 | **采纳**：query plan用代表性数据和语义索引断言，实际rows计量不凭估算保证免费。 | 07 §11 | OPS-01, OPS-02 |
| §49 | Acceptance criteria<br>L2038–L2089 | **采纳**：原依赖/存储/queue/schedule/一致性/R2/portability验收全部映射到新矩阵。 | 03；本文件§3 | PORT-01, OBX-01, QUE-04, SCH-01, STO-02 |
| §50 | Integration into existing 0.5.0 design<br>L2090–L2220 | **采纳**：更新原主设计/ADR/验收/交接，不只把附件孤立放到附录。 | 01–07；acceptance-change-log.json | CUT-05, PKG-06 |
| §51 | Final architectural rules<br>L2221–L2277 | **采纳**：15条RULE分别保留并设验收，不以旧实现方便为由弱化。 | 本文件§3 | PORT-02, OBX-01, STO-05 |
| §52 | Recommended implementation scope for 0.5.0<br>L2278–L2305 | **采纳并明示补充**：原15项具体范围全部包含；另采纳Blob实现/最小cipher/有界stalled恢复满足完整保证，不做PG/S3/Redis。 | 01 §1；04 | STO-01, CIP-01, SCH-04, CUT-04 |
| §53 | Design review questions<br>L2306–L2323 | **逐项作答**：见本文件§4的12个问题，分清旧设计事实与新方案。 | 本文件§4 | CUT-05 |

### 3.2 全部15条最终规则

以下全部是本版必需保证，不是未来可选项。差异仅在名称/目录/安全细节，不降低最终规则。

| Rule | 保留的保证 | 验收ID |
|---|---|---|
| RULE-001 | Core零Cloudflare runtime API。 | PORT-01, PORT-02 |
| RULE-002 | CF资源经ports/adapters访问，application零bindings。 | PORT-05 |
| RULE-003 | D1域状态；R2 blob/archive；logs不入D1。 | OBX-10, STO-01, STO-08 |
| RULE-004 | Queue是transport，不是域状态源。 | QUE-02, OBX-08 |
| RULE-005 | 长期schedule持久在outbox.available_at。 | SCH-01, SCH-02 |
| RULE-006 | at-least-once与并发duplicate是正常输入。 | PUB-02, QUE-03 |
| RULE-007 | D1→Queue必须独立transactional outbox。 | OBX-01, OBX-02, OBX-03 |
| RULE-008 | 安全provider retry与infra redelivery分开。 | PUB-03, QUE-04 |
| RULE-009 | ID应用生成，不依赖数据库自增/rowid。 | PORT-06, CUT-02 |
| RULE-010 | 持久对象引用为logical key，不是R2 URL。 | STO-03 |
| RULE-011 | 大型/raw诊断不无限保留在D1。 | OBX-10, STO-04, OPS-04, OPS-05 |
| RULE-012 | archive故障不令成功SNS重新发布。 | STO-05, STO-06 |
| RULE-013 | 平台特有协议/成功信号/错误解释在provider策略。 | ARC-02, NET-04 |
| RULE-014 | CF/SQLite优化只存在infra。 | PORT-02, PORT-05, OPS-01 |
| RULE-015 | CF为reference profile非执行模型。 | PORT-01, PORT-03, PORT-04 |

## 4. 原附件§53的12个设计审查问题

以下“原基线”均来自v1文件及此前审查，不声称本轮又读取了当前仓库。

| 问题 | 原基线 / 合并结论 |
|---|---|
| 1. Core/Application有Cloudflare泄漏吗？ | 原core基本中立，但application行为留Worker且函数依赖Env、D1Repository。revision2抽到application，并同时约束type-only/ambient依赖。 |
| 2. Ports放哪里？ | 私有`packages/application/src/ports/`，core保留domain/provider contracts。接口由消费侧拥有，CF adapter从外侧实现。 |
| 3. intent+targets+outbox可原子提交吗？ | 设计要求可以，实际D1 implementation必须以batch/guard保证；原代码没有新增outbox，不能声称已实现。零行guard有专门测试。 |
| 4. 复用幂等吗？ | 是。保留posts现有key和请求比较/receipt，创建初始jobs纳入同事务；outbox另有kind+entity+attempt唯一性，不混成一层。 |
| 5. 需要unknown/dead_lettered吗？ | 需要语义，但不改旧status枚举；unknown=failed+ambiguity，dead_lettered只对安全guard状态。保留terminalReason投影。 |
| 6. 原retry耦合Queue吗？ | 原设计有durable retry_at，但计划通过Queue retry(delay)推进。现改future outbox；infra单独映射runtime retry。 |
| 7. 原长期schedule依赖Queue delay吗？ | 不是；原基线已用D1+15分钟Cron。这次是统一进outbox并改善wake节奏，不虚构原先按30天Queue delay实现。 |
| 8. 原设计把raw放D1吗？ | v1没有要求把大型raw provider/webhook入D1。新条款防止以后增长；新增archive存储的就是允许的脱敏快照。 |
| 9. R2曾被当Logger吗？ | v1并未建立R2日志后端。这次明确分离端口；不能把新规范写成已修复一个未经证实的旧R2实现。 |
| 10. 凭据独立加密吗？ | 原基线JSON凭据、v1完整加密排后。本版采纳最小cipher以及实际plain→cipher迁移验收，当前仍未实施。 |
| 11. 新复合索引？ | outbox due与stalled recovery、publication current/retry/stale、auth expiry/lease及现有lookup/key。按实际query plan确认，不机械照搬未来webhook索引。 |
| 12. 拔掉CF能跑应用吗？ | revision2要求fake合同能运行同一application代码；真实D1/R2/Queue合同另测。测试尚未运行，不能报告此能力已通过。 |

## 5. 自查时显式收紧的边界

合并自查还明确了四点，均是新规格的细化而非源文引用：provider结果写回用publishing/claim guard，pre-execution与DLQ结算用各自guard；legacy attempts已达3或结果自相矛盾时不能回填第4次执行；SDK可在可信未受理拒绝时保留false，不把所有已发请求都说成受理；cipher payloadRevision与slot revision分离，不能被lease元数据变化破坏AAD。dispatcher send失败只留pending到下一wake，不偷偷改变业务available_at。

## 6. 交付与评审范围

版本范围现在是 **B＋可移植存储/队列架构**。保留原66个验收ID，增加54项，总计120项（118本地＋2真实平台独立授权），目前全部NOT_RUN。20项原标准有明确文本修订，见 [acceptance-change-log.json](acceptance-change-log.json)。

新增设计成本在迁移与并发边界，不能把它描述成“只是几个interface”。但没有增加第二生产数据库、通用job系统、每平台queue、通用事件总线、媒体产品或多租户。具体实施仍应拆成受控任务，按 [交接文件](04-HANDOFF.md)重新评审书面执行计划。

本轮只检查文件/映射/引用/打包一致性；所有生产功能和安全行为需要未来以当前源码实测。原始输入hash相同不代表设计行为已被执行证明。
