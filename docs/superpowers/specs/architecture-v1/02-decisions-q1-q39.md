# Syndroo Q1–Q39 决策登记

**截至 2026-10-08，全部已由用户接受。** 本表根据当前对话重新整合，不冒充本次成功读取或更新了远程仓库记录。

本文对应 `01-architecture-design.md`。Q22 的真人批准可证明性、Q36 的 import 信任顺序等实现接缝，见正式规格中的 D 条目；不得把问答中的概念示例当作已经实现的安全保证。

| 决定 | 主题 | 已接受内容 | 规格章节 |
|---|---|---|---|
| Q1 | Provider-only 插件 | 插件只实现或替换 SNS Provider，不扩展 CLI、middleware、state 或 Core 执行规则。 | 1、7 |
| Q2 | 三个主要操作 | Agent/API 主要模型为 connect → publish → status；平台差异由 capabilities/options 描述。 | 1、3、12 |
| Q3 | 认证职责分离 | Provider 管平台特有认证与身份验证，Core 管凭据保存、脱敏、绑定及生命周期。 | 4、9 |
| Q4 | 两种 SDK 分开 | @syndroo/sdk 给 API 调用者；@syndroo/provider-sdk 给插件作者；Core 保持内部。 | 2、7、12 |
| Q5 | 显式 Registry | 一个 provider 一个 active implementation；用户 override 优先，删除 override 恢复内置选择；不做自动发现/包管理器。 | 7.3 |
| Q6 | 兼容性 fail closed | 整数 apiVersion；坏 override 不 fallback；发送前预检所有选中 Provider。 | 5.2、7 |
| Q7 | 明确可信同进程模型 | 第三方插件作为用户显式信任的代码运行；最小传参不是 sandbox；首次启用须授权。 | 7.4–7.6、11 |
| Q8 | 插件管理不是第四种产品用途 | 安装/覆盖/回滚属于开发者配置；核心仍是连接、发布、状态与恢复。 | 1、7、12 |
| Q9 | 共享业务层 | CLI 与 HTTP Server 调用同一 Core/Application；SDK 仅 HTTP，不承担 local execution。 | 2、12 |
| Q10 | 共享存储语义而非实现 | domain records/ports 一致，filesystem/SQLite/D1 adapters 不强制相同物理 schema。 | 9 |
| Q11 | 自然语言止于 Agent | Syndroo 接受结构化请求、不内置 LLM；Agent 固定消费 JSON 而非人类终端输出。 | 1、12.4 |
| Q12 | 运行时 JSON Schema | Provider options/connect inputs 由 JSON Schema 描述；TS 只改善开发体验，不替代运行时验证。 | 8.1 |
| Q13 | CLI 固定三个一级命令 | 只保留 connect/publish/status，另有全局帮助/版本；retry 是 publish mode；status 只读。 | 12.1 |
| Q14 | 统一 contract、不同 loader | 本地配置驱动 dynamic import；Server/Cloudflare 显式 import + 构建时注册。 | 7.5 |
| Q15 | 官方 Provider 无特权接口 | 官方与第三方实现同一 Plugin contract、Registry 路径与 contract tests。 | 2、7.2 |
| Q16 | 区分 declared 与 observed | 代码支持不等于账号验证可用；status 读取保存的 observation，不自动访问 SNS 刷新。 | 8.2–8.4 |
| Q17 | Connect 一次性导入凭据 | 后续发布使用 Core CredentialStore；不依赖原 env/文件；本地私有文件不宣称加密。 | 4.3、9.2 |
| Q18 | 最小可恢复 Connect 协议 | 固定 action_required/done，Core 管 session/TTL；Plugin 不控制 UI，不做通用 workflow engine。 | 4 |
| Q19 | 每个 Provider 多连接 | 稳定 Connection + 可选 label/default；首次成为默认；歧义拒绝，不由 Agent 猜账号。 | 3.2 |
| Q20 | 机器管理幂等 | 普通内容文件无 key；Agent/SDK/CLI 管一次意图的稳定身份，Core 保留 replay/conflict；UX 主要显示 operationId。 | 6 |
| Q21 | content + targets | 普通文档移除 schemaVersion、platforms/overrides；target 带 provider、connection 和 options；协议自身管理版本。 | 3 |
| Q22 | 精确两阶段发布 | prepare/freeze → confirmation_required → execute；确认后不能重读原始内容；CLI/Agent 共享流程。 | 5 |
| Q23 | 不公开 raw SNS payload | 调用者使用 canonical content/options；Plugin 编译和冻结平台原生 payload。 | 3、5.3、7 |
| Q24 | 统一 outcomes 与 Core 重试裁决 | succeeded / failed(not_applied) / unknown；少量 failure reason；Plugin 不直接授权重试。 | 6.3–6.4 |
| Q25 | 完全放弃旧版本 | 用户明确不考虑迁移成本；不保留旧命令、API、state、凭据引用或格式的兼容层。 | 1.2、9.3、15 |
| Q26 | 共享 operation 的同步/异步执行 | CLI 可前台同步，Server 可 durable async；operationId/status 一致；Server 确实执行 SNS 写入。 | 5、10 |
| Q27 | 共享核心、显式部署安全组合 | Self-hosted/Cloud 共享 Core/Provider contract；OAuth/worker 启动时组合；核心安全不可关闭。 | 10.3、11 |
| Q28 | Self-hosted 单租户 | Cloud 在外层提供 tenant-scoped context；Core 不堆 user/org/tenant 概念；Server 始终鉴权。 | 11.1、11.3 |
| Q29 | Self-hosted 简单强制认证 | 单 deployment Bearer secret；无 RBAC/token CRUD；callback 使用短期认证 session/state/PKCE 保护。 | 4.2、11.1 |
| Q30 | Status 承担 discovery | 返回 manifest/实现信息、能力、schemas、连接与 operation；Skill 不硬编码各平台字段。 | 8.3–8.4 |
| Q31 | 每个平台独立教程 | 人工维护凭据/任务/排错；reference 从官方 manifest/schema 派生或强校验；不收录第三方平台教程。 | 13 |
| Q32 | Cloud 禁任意租户插件 | 只运行官方或 Syndroo 审核并随部署注册的 Provider；第三方自由扩展留在本地/自托管。 | 7.5、11.3 |
| Q33 | 三个 HTTP endpoint 与 path version | POST /v1/connect、/v1/publish、/v1/status；不做 header 版本协商或额外业务 CRUD。 | 3.3、12.2 |
| Q34 | 首版无 Webhook | 用 status 观察异步完成，SDK wait() 客户端轮询；Webhook 留作未来独立可选能力。 | 1.2、10、12.3 |
| Q35 | 三种参考 persistence | Local filesystem；Self-hosted 默认 SQLite；Cloudflare D1；PostgreSQL 等不在首版实现。 | 9.2 |
| Q36 | 最小 ESM Provider 包规范 | package root 默认导出 Plugin；单一 defineProvider manifest；验证 id/API/schema；共享 contract-test helper。 | 7.1–7.5 |
| Q37 | 固定五种 Status queries | overview/provider/connections/operation/operations；无 DSL；只读且不默认访问 SNS。 | 8.3–8.4 |
| Q38 | SDK 三协议方法加 wait | connect/publish/status + 客户端 wait；discriminated unions；无 raw escape hatch、local runtime 或 Plugin API。 | 12.3 |
| Q39 | 最终 package 与 docs IA | core/provider-sdk/provider-*/cli/sdk/server/cloudflare；网站 Getting Started/Platforms/Build/Reference。 | 2、13 |

## 新设计与旧方案的优先级

Q25 的明确答复“完全放弃旧版本，不考虑迁移成本”取代此前兼容与迁移方向。Q39 接受新总体架构后，旧第一阶段 implementation plan 不应直接执行。保留旧文件作为会话资料，不代表其命令面、兼容要求或实施顺序仍有效。

新协议代际 v1 与 npm release semver 是不同概念；对话未确定的新 release 版本号，不在本表自行补为 1.0.0。

授权范围仍为设计整合。产品代码实现、安装依赖、真实账号授权/发帖、提交/推送/部署不因“Q39 接受”而自动发生。
