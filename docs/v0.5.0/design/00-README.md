# Syndroo 0.5.0 — 整合设计文件包 revision2

**范围：原B可靠性/授权闭环＋合理架构抽象＋Portable Storage & Queue Architecture Addendum。**

文档版本2.0；日期2026-09-21（Asia/Tokyo）。状态：**设计待评审，源码未实施，产品验收未运行**。本轮只生成会话附件，没有修改syndroo仓库、迁移数据、部署资源或调用真实SNS。

## 1. 本次并入了什么

新spec不是只放在附件目录：它已经改变主规格、ADR、状态机、迁移、验收和交接合同。Cloudflare现在是reference profile，Domain/Application经portable ports访问D1/R2/Queues；新增独立transactional outbox，业务retry经future job，infra retry/DLQ留runtime。R2ArchiveStore与R2BlobStore分离，Logger独立；采纳最小CredentialCipher并明确密钥/升级成本。

原B六项回归、统一credential resolution、连接binding、OAuth候选→确认激活、refresh lease、SDK/CLI/Skill和旧API兼容全部保留。不直接重命名Post/Publication、不新增多账户/媒体/webhook产品，不开发第二生产PG/S3/Redis或Node/Docker profile。

## 2. 阅读顺序

| 文件 | 作用 |
|---|---|
| [06-INTEGRATION-REVIEW.md](06-INTEGRATION-REVIEW.md) | 先读：与v1的冲突、53节来源映射、15条规则、12个审查问题与解释选择 |
| [01-DESIGN.md](01-DESIGN.md) | 合并后的完整0.5.0主规格；原B与新基础设施同一份规范 |
| [07-CONTRACTS-AND-FAILURE-MATRIX.md](07-CONTRACTS-AND-FAILURE-MATRIX.md) | 端口/事务/outbox/current-job fence/DLQ/R2/cipher/retention/query plan；22个故障场景 |
| [02-ARCHITECTURE-DECISIONS.md](02-ARCHITECTURE-DECISIONS.md) | 20条ADR；修订原决策并新增必要设计模式，不堆通用框架 |
| [03-ACCEPTANCE.md](03-ACCEPTANCE.md) | 120项标准，118本地必需＋2项真实平台独立授权，全部NOT_RUN |
| [04-HANDOFF.md](04-HANDOFF.md) | 后续执行计划输入、任务依赖、文件所有权与验证要求；不是执行授权 |
| [05-SOURCES-AND-BASELINE.md](05-SOURCES-AND-BASELINE.md) | 历史源码依据与本次官方平台资料，明确哪些没有重跑 |
| [acceptance-results.template.json](acceptance-results.template.json) | 与矩阵相同120个ID，供实际实施填写命令/commit/结果 |
| [acceptance-change-log.json](acceptance-change-log.json) | 原66项ID全部保留；20项标准的旧/新文本与加强原因 |
| [source-integration-map.json](source-integration-map.json) | 53节与15条规则的机器可读对应 |
| [input-provenance.json](input-provenance.json) | 两份输入的字节数和SHA256 |
| [document-validation.json](document-validation.json) | 本文件包实际完整性检查结果，不是产品测试报告 |
| [validate-package.py](validate-package.py) | 可重跑的标准库文档校验器；只验证文件/ID/映射/链接/hash/ZIP |
| [SHA256SUMS.txt](SHA256SUMS.txt) | 文件hash清单；排除自身与校验报告避免递归hash |

## 3. 原始输入保持不变

[新增spec原文](sources/portable-storage-queue.original.txt)保留全部2323行；[上一版设计包](sources/v1-original-design-package.zip)保留原ZIP字节，不在旧文档上静默覆盖历史决策。原文的概念命名/推荐数字与本版的具体映射在06中逐项披露。

规范阅读以01和07为准，02解释取舍，03规定证据。sources用于追溯，不把与本次明确决策冲突的旧ADR混作第二套当前规范。

## 4. 需要重点审核的边界

**可移植不等于零迁移成本。** 端口的事务后置条件要由D1及fake共同验证，未来数据库仍需自己的实现/数据/密钥迁移。

**成功发送到Queue不等于完成，也不保证消息必入DLQ。** 本版增加当前未claim job的有界stalled恢复；old job、active claim、unknown和late DLQ均有单独规则，不用无限重发掩盖问题。

**source的503示例不是安全重试许可。** provider已可能受理时仍unknown；future outbox只用于确定安全且预算允许的重试。

**最小加密是本次明确采纳的范围增量。** 新cipher key与API/binding key独立，旧明文需受控迁移；不含自动密钥轮换/KMS。归档严格private/脱敏，不记录OAuth原始响应。

**升级不是无感回退。** 新协议Queue和旧裸ID消息要隔离，停止旧consumer/Cron，无binding旧任务须复核；不得自动purge或重置Publisher attempt预算。

## 5. 完成状态

本包保留历史基线`d8206f298333eeb83d45d319ea244bbda72c78f7`，但本轮未连接仓库，因此不声称仍是当前HEAD。此前用户CLI dirty改动和Worker测试超时仅作历史风险输入，不能据此报告0.5.0产品状态。

文档校验与产品验收分开：120项产品检查全部NOT_RUN。只有未来当前源码的隔离执行证据才能升级为PASS；真实账户验收、生产迁移、部署和发布另需授权。OpenCode模型不再是本次文件交付的依赖。
