# Syndroo Agent-first Architecture v1

**正式架构设计规格 · 2026-10-08 · Revision 1**

| 项目 | 状态 |
|---|---|
| 产品与架构决策 | 用户已接受 Q1–Q39；grill-me 问答结束 |
| 本文 | 已完成整合与一致性审查，供书面评审；不代表新增实现细节已逐条获批 |
| 产品实现 / 自动化验收 / 真实 SNS 验收 | 均未由本次任务执行 |
| 版本含义 | 本文的 v1 是新架构及协议的第一代，不自行决定下一次 npm release 的版本号 |
| 仓库同步 | 本次 WebCodex 返回 `tunnel_client_not_connected`，未读取到最新仓库，未写回仓库 |
| 依据 | 当前对话中的 Q1–Q39 及用户明确答复；旧规格不得覆盖这些决定 |

本文使用“必须”表达目标实现的验收约束，而不是宣称这些能力已经存在。标有 **D** 的条目是把已接受决策落成可实现设计时补充的细节，应连同本文评审。它们不新增产品命令，也不引入另一套发布内核。

建议最终存放位置：`syndroo/docs/superpowers/specs/2026-10-08-agent-first-architecture-design.md`。此路径尚未写入用户仓库。

配套文件：`02-decisions-q1-q39.md` 是决定映射；`03-acceptance.md` 是全部标为 `NOT_RUN` 的验收矩阵。

---

## 1. 产品定义与范围

**Syndroo 是面向 Agent 的确定性社交发布运行时。** 自然语言由外部 Agent / Skill 解释；Syndroo 接收结构化请求，完成账号连接、精确内容确认、平台发送和结果查询。

产品只提供三个主要操作：

- `connect`：连接、重新认证和管理发布所需的账号连接。
- `publish`：准备、确认、发送，以及对确定未送达目标进行安全重试。
- `status`：只读查询运行时、平台能力、连接与发布结果。

CLI 和 HTTP Server 使用同一份业务实现。`@syndroo/sdk` 是 HTTP client；`@syndroo/provider-sdk` 是 Provider 作者的扩展接口。两者不是同一个包，也不承担同一种职责。

### 1.1 首版目标

| 维度 | 目标 |
|---|---|
| 主要使用者 | 通过 Agent 操作的独立开发者、小型技术团队，以及通过 SDK 集成的应用 |
| CLI | 只有 `connect / publish / status` 三个一级命令，另有全局帮助和版本信息 |
| SDK | `connect() / publish() / status()`，加纯客户端 `wait()` |
| Server | 完整远程运行时：保管凭据、执行 SNS 发布、保存结果；不只是 OAuth 代理 |
| 本地依赖 | 即时发布不要求 Server、数据库服务、Queue、Cache 或内置 LLM |
| 官方 Provider | Bluesky、Threads、LinkedIn、Mastodon、DEV.to，全部实现相同 Plugin contract |
| 扩展范围 | 只允许 Provider Plugin；新平台与平台适配修复，不允许任意 CLI / middleware 扩展 |
| 文档 | Agent-first 入门；每个官方平台单独说明凭据获取、连接、发布和排错 |

**内容范围说明（D）：**首批官方 Provider 的基础验收以短文本和 DEV.to 文章为准。前面讨论中的 `media / reply / thread` 是模型边界示例，不等于所有平台首版已经支持。新能力只有同时具备 schema、实现、预览、错误语义和测试后才能在 manifest 中声明。需要新的跨阶段副作用或文件传输协议时，不能只加一个布尔 capability 就宣称完成。

### 1.2 明确不做

不做内置 LLM、自然语言解析器、社媒管理台、AI 文案生成、通用 workflow engine、插件市场、运行时 npm 安装 API、通用查询 DSL、Webhook / event subscription、任意第三方代码的 Cloud 执行沙箱，也不为自托管首版做用户系统 / RBAC / 多租户管理。

PostgreSQL 等数据库不在首版实现。Core 不预建一套泛化 ORM、DI 容器或任意基础设施插件系统。

**旧版本彻底放弃。** 不保留旧命令、旧 API、旧文档解析、旧凭据引用、旧 state compatibility 或迁移脚本。此前第一阶段修整方案不再是新架构的实施依据；其中有价值的帮助、输出和错误测试要求由新实现吸收。该决定不授权自动删除用户机器上的凭据、文件或远端 SNS 内容。

---

## 2. 整体结构与依赖边界

```text
用户自然语言
    │
外部 Agent + Syndroo Skill
    │
    ├─ 本地：CLI ─────────────────────────┐
    │                                    │
    └─ 远程：SDK / HTTP → Server/Worker ──┤
                                         ▼
                           Core: connect / publish / status
                              │                    │
                              ▼                    ▼
                       Provider Registry      状态 / 凭据 / 执行 ports
                              │                    │
                              ▼                    ▼
                       Provider Plugins       runtime adapters
                              │
                              ▼
                            SNS API
```

图中的共享表示**共享代码和语义，不表示共享进程或自动同步状态**。本地 CLI 与远程 Server 的连接、凭据、operation 和幂等记录各自属于自己的运行时。把客户端从一个部署切到另一个部署不会自动迁移身份或去重历史。

### 2.1 目标目录

```text
syndroo/
├── packages/
│   ├── core/                 # private: use cases + domain + protocol + ports
│   ├── provider-sdk/         # public: Provider contract、defineProvider、testing
│   ├── sdk/                  # public: 纯 HTTP client
│   ├── cli/                  # public: Commander、renderers、local runtime、Skill
│   ├── server/               # public: Node self-hosted runtime、SQLite、HTTP
│   ├── cloudflare/           # public deployment artifact: Worker、D1、Queues
│   ├── provider-bluesky/
│   ├── provider-threads/
│   ├── provider-linkedin/
│   ├── provider-mastodon/
│   └── provider-devto/
├── scripts/                  # 构建、协议导出、Provider reference 导出、发布检查
├── tests/                    # 跨入口 / adapter / packaged-consumer 验收
└── docs/                     # 架构与开发设计；用户文档站在 syndroo-web
```

`core` 内可以按职责设目录，但不再拆成多个同步发布的 domain/application/services package：

```text
core/src/
├── protocol/                 # wire JSON Schema 与协议类型生成源
├── connect/
├── publish/
├── status/
├── domain/
├── ports/
└── providers/                # Registry 与已验证定义，不含平台特例
```

这些是职责边界，不是强制每个目录都要出现工厂、接口和实现三件套。

### 2.2 包职责

| 包 | 拥有 | 不拥有 |
|---|---|---|
| `@syndroo/core` | 用例、状态转换、连接绑定、确认、幂等、重试资格、统一结果 | Node fs、SQLite/D1 client、终端、HTTP Request、平台认证细节 |
| `@syndroo/provider-sdk` | Plugin contract、manifest/capability 类型、connect steps、write outcomes、测试 helper | Core 的存储实现、HTTP client、tenant 管理 |
| `@syndroo/provider-*` | 平台认证协议、身份验证、payload 编译、发送与错误归一化 | 自行落盘 secret、决定重试、改变 Core 状态格式 |
| `@syndroo/cli` | 参数解析、人类/JSON 输出、本地文件 adapters、动态加载、Skill 打包 | 第二份发布状态机、远程 Server fallback |
| `@syndroo/sdk` | HTTP、鉴权 header、请求/响应类型、polling、传输取消 | 本地发布、插件加载、Provider 类型、凭据仓库 |
| `@syndroo/server` | HTTP adapter、强制 API auth、SQLite、保护的 SecretStore、Node 执行组合 | Cloud 用户系统、另一套业务规则 |
| `@syndroo/cloudflare` | Worker adapter、D1、Queues、Cloudflare secret bindings | Node 文件系统和 SQLite 原生驱动 |

官方 Provider 和第三方 Provider 依赖 `provider-sdk`；Core 也依赖它。CLI / Server / Cloudflare 使用 Core 并组合 Provider。SDK 不依赖 Core 的运行时代码或 Provider SDK。

### 2.3 公共协议只有一个源码来源（D）

为避免“SDK 复制一套类型，Server 再写一套验证”，把 canonical wire schemas 放在 `core/src/protocol/`。构建时生成：

1. Core / transports 使用的验证器及类型。
2. SDK 随包分发的协议类型、轻量响应验证器。
3. API reference / JSON Schema 文档产物。

生成产物不得手工维护；CI 重新生成并检查差异。SDK 最终 `.js` / `.d.ts` 不引用 private workspace，也不包含 Core 状态机。无需因此新建第十二个 `contracts` package。

Cloudflare 的验证器必须可在部署时预编译。Ajv 提供 standalone validator 生成能力，可作为实现选择；该能力不是让 Worker 在请求时编译外部代码的理由。[S4]

---

## 3. 通用内容、目标与公共版本

### 3.1 普通内容文件

普通 `post.json` 只描述内容和目标，不带用户管理的 `key`、`schemaVersion` 或 raw SNS payload。

```json
{
  "content": {
    "text": "Syndroo now publishes through a small, consistent interface."
  },
  "targets": [
    {
      "provider": "bluesky",
      "connection": "personal"
    },
    {
      "provider": "mastodon",
      "options": {
        "visibility": "public"
      }
    },
    {
      "provider": "devto",
      "options": {
        "title": "Introducing Syndroo",
        "body": "# Introducing Syndroo\n\nA full Markdown article.",
        "tags": ["typescript"],
        "canonicalUrl": "https://example.com/posts/syndroo"
      }
    }
  ]
}
```

这是**新协议的目标示例**，不能拿来声称现有 `0.7.0-rc.1` 已接受此格式。

共同字段保持小型：`content` 和 `targets[]`。每个 target 有 `provider`、可选 `connection`、可选 provider-specific `options`。平台特殊正文和元数据由 Provider schema 描述；Core 不添加 `devtoTitle`、`mastodonVisibility` 等平台特例。

**逐目标正文（D）：**同为文本的平台需要不同文案时，可在 target 内提供可选 `content`，完整替代共享 `content`，不作隐式深合并。有效输入是 `target.content ?? document.content`。文章正文继续由 DEV.to options schema 定义。这不恢复独立的 `overrides` 映射。

只发布文章时允许 `content: {}`，但每个目标最终必须通过自身 schema 与 freeze 验证；不能把空文本无条件发送到文本平台。Core 不自动总结、裁剪、翻译、补全文或改变换行。

### 3.2 连接选择

Connection 的稳定身份包括 `connectionId`、provider id、平台账号 id，以及实例/服务 origin（适用时）。label 只是用户可读别名，不是发布身份。

第一次连接成为该 provider 的默认连接。未指定账号时选唯一连接或明确 default；多个连接且没有 default 返回 `TARGET_AMBIGUOUS`。同一 provider 的 label 必须唯一，不能让 label 与另一条稳定 ID 发生歧义。

prepare 阶段把 label/default 固定解析成稳定连接与平台账号身份。确认后不再重解析 default。一个请求中不同 label 若最终指向同一平台账号，视为重复目标拒绝，而不是发两次。重新认证同一账号不创造新的去重身份。

### 3.3 协议版本

HTTP 用 `/v1/connect`、`/v1/publish`、`/v1/status`；不使用自定义版本协商 header。Provider 声明整数 `apiVersion: 1`。CLI 的机器 envelope 使用 `protocolVersion: 1`。内部状态另有不供普通用户填写的格式标记。

移除内容文件版本不代表没有版本管理：它依赖执行它的 CLI/API 契约；Provider options 依赖选中的 Provider schema。变更已冻结 intent 时不得重新解释成新 schema。

请求 schema 对未知字段严格拒绝；客户端响应解码可以容忍无害的新可选字段，但遇到未知 action/status 时不能推断成功或自动 execute。新增字段也不自动等于兼容。新增枚举值、改变默认值、从忽略未知字段改成报错，都要经过兼容性检查。只有保持已发布语义的扩展留在 `/v1`；真正不兼容的新语义使用新 major contract。

---

## 4. Connect：可恢复认证，凭据由 Core 管

### 4.1 职责

Provider 决定认证协议和身份验证；Core 决定 session、过期、输入边界、凭据保存、连接提交；CLI/HTTP adapter 决定如何呈现 prompt、如何打开浏览器、如何接收 callback。插件不直接操作 stdin、浏览器 UI 或用户凭据文件。

协议采用小型 discriminated union。正式 wire request 用 `type` 区分 `start / resume`，不是让调用者混合两种请求字段。

```json
{
  "type": "start",
  "provider": "mastodon",
  "label": "personal",
  "options": {
    "instance": "https://mastodon.example"
  }
}
```

返回 `action_required` 或 `done`。非终态 action 只允许 `credential_input / open_url / wait_for_callback`。`done` 是结果，不再同时作为 action 类型。

```json
{
  "status": "action_required",
  "connectSessionId": "cs_example",
  "expiresAt": "2026-10-08T12:15:00Z",
  "action": {
    "type": "open_url",
    "url": "https://social.example/authorize?state=example"
  }
}
```

示例 URL 与时间只说明字段，并非可用授权链接。

### 4.2 Session 与输入安全（D）

Core 生成不可猜测的 session ID，绑定 runtime scope、provider、认证发起者、实现 fingerprint、目标连接基线及失效时间。默认 TTL 15 分钟。resume 必须使用当前 step revision；并发 resume、重复 callback 和过期 callback 不能重复换取凭据或覆盖其他连接。

OAuth callback 的 `state`、redirect URI 和 authorization server 身份必须与发起时一致。支持 PKCE 的 flow 使用 S256；没有经过验证的 PKCE 支持时不能假装得到它的保护。特殊 provider 的认证方案必须明确审核，不能运行时静默降级。相关边界依据 RFC 9700 的 redirect、CSRF 和 PKCE 要求。[S3]

客户端发送 `callback_complete` 只能请求检查状态，**不能证明 OAuth 已完成**。必须由 callback adapter 已验证并存下来的证据驱动后续 exchange。authorization code、PKCE verifier、refresh token、临时认证状态属于敏感存储，不能出现在通用 status 或诊断中。

Agent 不要求用户把 API token / App Password 粘贴进聊天。交互凭据通过隐藏终端输入、授权页或显式 HTTPS API 输入进入 runtime。CLI 不提供 `--token <secret>`；secret 不经普通 `--data`、命令历史或错误回显。

### 4.3 导入与持久化

`--from-env` / `--credential-file` 是 connect 当次的输入，成功后保存到 Core-owned CredentialStore，不保留外部来源依赖。删除或改名原文件、清除原 env 不影响后续 publish。CLI 不擅自删除导入文件。

Provider 返回的 credential bundle 是内部结果；公共 ConnectResult 只返回连接身份与安全的 observation。完成顺序为：验证身份 → 暂存受保护的新 secret → 以比较并交换方式提交 Connection 引用 → 返回 done。

SecretStore 与业务状态不要求分布式事务。先暂存的 secret 只有在 Connection 引用成功提交后才成为 active；提交失败不破坏旧绑定。故障清理只能删除可证明由本次创建且无人引用的 blob，不能凭超时猜测它没提交成功。

重新认证仅更新同一账号的凭据修订。身份发生变化时不得悄悄把旧 connectionId 绑定到新账号，应新建连接并重新确认。

### 4.4 连接维护与 scope（D）

为不增加第四个命令，设置默认连接、改 label、断开本地连接可以作为 `connect` 的显式维护 variant，由同一认证和状态提交边界处理。断开只移除本运行时的有效凭据/绑定，不宣称已撤销平台端 token；平台端撤销步骤放在各平台教程。

这些维护 variant 固定为 `type: update`（稳定 connectionId + label/isDefault 的有限 changes）和 `type: disconnect`（稳定 connectionId）。它们不能删除发布历史，也不能让 pending operation 自动改投其他账号；CLI 的便利 flag 在实施计划中映射到同一请求，不扩展成通用配置 CRUD。

---

## 5. Publish：准备、确认与执行同一份内容

### 5.1 三种协议输入

`publish` 接受 `type: prepare / execute / retry` 三个互斥 variant。CLI 文件输入适配成 prepare；普通 post 文件不承担 transport 元数据。

```json
{
  "type": "prepare",
  "content": { "text": "Hello from Syndroo" },
  "targets": [{ "provider": "bluesky" }]
}
```

```json
{
  "type": "execute",
  "approvalToken": "appr_example"
}
```

```json
{
  "type": "retry",
  "retryOf": "op_example",
  "targets": [{ "provider": "mastodon", "connection": "conn_example" }]
}
```

`retry` 先准备新一轮精确重试快照，仍返回确认要求；不是收到这个 variant 就立即重发。

### 5.2 正常 prepare 顺序

1. 验证请求体与机器幂等身份；相同请求首先复用已保存结果。
2. 将所有目标解析为稳定账号，校验重复目标和默认账号歧义。
3. 核对插件信任批准；未经允许不加载第三方代码。
4. 加载本次选择的所有 Provider，校验 id、Provider API、schema 与 runtime 可执行性。
5. 读取本次目标凭据，核对账号绑定和有效性证据；不把“未观测”当作“权限已验证”。
6. 验证每个 target 的 options 和有效内容，执行纯函数 `freeze`。
7. 形成精确 preview 和冻结 intent；没有任何 SNS 内容写入。
8. **持久保存 prepared intent 后**才返回 `confirmation_required`、operationId、approvalToken 和有效期。

第 8 点修正了问答示意中的顺序：两个独立 CLI 进程或两次 HTTP 请求之间，没有持久快照就无法安全恢复执行。prepared 持久化并不代表已经批准或已经发送。

所有目标的结构、插件、身份和内容预检必须在发送任一目标前完成。一项预检失败，本次 prepare 不产生任何 SNS 内容写入。实际 SNS 网络执行不是分布式事务，不能保证随后全平台同时成功或统一回滚。

### 5.3 冻结内容（D）

FrozenIntent 至少绑定：

| 内容 | 用途 |
|---|---|
| operationId 与内部 revision | 恢复、并发控制和幂等 |
| canonical 请求与摘要 | 同 key 冲突检查及可审计的输入 |
| 每个目标的稳定账号与绑定 revision | 防止 default/label/账号在确认期间漂移 |
| Provider id、API version、实现 fingerprint、schema fingerprint | 防止批准 A 插件、执行 B 插件 |
| canonical effective content、validated options、平台 payload | 精确内容与平台适配隔离 |
| 人类 / Agent 可读的完整 preview | 展示实际将发布的内容和可见性 |
| 创建时间、确认截止时间、确认 token 摘要 | 确认恢复与过期检查 |

冻结 payload 不得包含 access token、Cookie、Authorization header、任意用户可传的 URL/method/header 请求模板。它是 Provider 内部的 JSON 数据，不是允许调用者构建任意 HTTP 请求的逃生通道。

freeze 必须只依赖传入的数据、固定时间和显式随机种子/ID（有需要时）；不读取环境或文件，不联网，不上传媒体。Preview 必须覆盖正文、文章标题/全文、可见性、reply target、链接和任何会改变用户可见结果的 options；不能只展示标题而隐藏全文。

**多步骤平台调用（D）：**精确冻结指业务内容、目标和发送计划固定，不是声称未来每个 HTTP 字节都已存在。平台若需要先创建容器再发布，运行时返回的容器 ID、认证 header 等只能作为同一已批准执行的技术材料，不能改写正文或新增目标。容器/上传等副作用也必须在批准后发生；中途崩溃按已取得证据保守判断，插件不能自行隐式重试整个流程。

### 5.4 Execute 与批准边界

execute 必须验证调用者/运行时 scope、token、intent 状态、TTL、绑定与实现 fingerprint；然后原子完成确认消费与 execution admission。并发重复 execute 最多创建一轮执行，后续调用返回同一 operation 的状态。

token 默认 15 分钟内可用于首次 admission；已经成功 admission 的重放不得因 token 后来过期而再次发送或创造新任务。普通 status 不返回 approvalToken。token 原值只在受保护的 prepare 响应/恢复路径暴露，不写普通日志；状态表保存摘要，必要的响应重放材料保存在临时 SecretStore。

**必须诚实说明的限制：**如果同一个 Agent 拿着同一 API credential，既能 prepare 又能 execute，那么 Core 能证明“执行请求指向同一已冻结 intent，且经历了显式确认步骤”，但不能从 token 判断真人是否真的阅读并点击。CLI TTY 可取得交互确认；Agent/SDK 的用户授权属于受信任客户端责任。本文不加入未获批准的独立审批服务，也不宣称 token 能替代独立人审。恶意受信任插件同样不受该协议物理隔离。

Q22 的精确快照和显式确认规则仍然强制；不是改成默认自动发布，也不新增 `alwaysAllow` 或关闭确认的安全开关。

### 5.5 执行阶段

admission 成功后，先持久化执行状态，再调用 Provider。每个目标通过原子 claim 标记进入发送阶段；不得先发 SNS 再补本地记录。

同一 intent 的各目标首版串行发送，不在 Core 内引入通用 fan-out 调度器。单个平台返回确定失败或 unknown 后，可继续其他仍被批准且独立的目标；出现整体取消、状态损坏或超时则停止启动剩余目标。没有运行过的目标明确保持未发送证据。

插件改变、账号改变或当前实现不再能消费已冻结 payload 时，返回 stale intent / binding 错误，要求重新 prepare 和确认。不能重新读取原始文件、替换 payload 或回退插件后继续使用旧批准。

### 5.6 Dry-run 与 prepare 不是同一个保证

`publish --dry-run` 是只读预览：不读取 secret、不联网、不创建 intent/operation、不初始化 state、不批准插件。它只使用已信任实现及已存在的安全元数据；信息不足时返回具体未验证项或信任错误。

真实 prepare 可以读凭据并保存 prepared intent，因此不能将它宣传为“完全无状态 dry-run”。代码层的只读要求不构成对恶意同进程插件的 sandbox；这是 Q7 的明确限制。

---

## 6. 幂等、重试与结果语义

### 6.1 两类身份，只有一个主要产品 ID

用户主要看到 operationId。机器另维护稳定 request identity；每个逻辑 target 的内部身份至少绑定 operationId、provider、实例 origin 和平台账号 id，不以可变 label 或临时 credential 文件名为 key。

**HTTP 的 prepare / retry 要求 `Idempotency-Key`；SDK / CLI / Skill 负责生成和复用。** 这是幂等 header，不是版本协商 header。execute 则由 approvalToken + 已保存 admission 实现重放保护。

同样具有写入副作用的 connect start/update/disconnect 使用机器请求幂等身份；resume 还必须校验 connectSessionId 与当前 step revision，重复提交已消费的 step 只返回保存的结果，不再次 exchange。敏感 connect 输入的指纹由 runtime 密钥保护，不把凭据的裸 hash 暴露给客户端。

SDK 在一次逻辑方法调用内的网络重试使用同一 key。应用或 Agent 跨进程恢复时必须在第一次请求前保存 key，并通过 request options 重新传入。SDK 不能从两次独立的 `publish()` 调用判断它们是不是同一个自然语言意图。

CLI 人类调用会在运行时自己的私有 request journal 中先保存机器身份；Agent 通过机器参数显式复用。缺失响应时重复原 prepare + 同一 key 可以拿回 operationId，而不是换新 key 试运气。

### 6.2 规则

| 情况 | 结果 |
|---|---|
| 同一 runtime scope、同 key、同请求 | 返回原 prepared / admitted 结果，不重发 |
| 同 scope、同 key、不同请求 | `IDEMPOTENCY_CONFLICT` |
| 相同正文、新的明确用户发布意图、新 key | 新 operation；不按正文 hash 永久禁发 |
| operation 已成功的目标 | 只重放记录，不再次发送 |
| 同一 token 并发执行 | 一次 admission，其余返回该 operation |
| 新 CLI / 另一个 Server 的独立 state | 不承诺跨 runtime 去重 |
| outcome unknown | 不通过换 key、改 label、重连账号或恢复旧备份绕开 |

请求摘要采用确定性 JSON 编码：对象 key 顺序规范化，数组次序与字符串原值保留，不为去重而改写 Unicode、空白或换行。含 connection label/default 的原请求一旦取得同 key 映射，重放使用已解析的原目标，不重新根据新 default 生成另一次发布。

去重记录首版不做自动过期清理。未来若增加 retention，必须定义过期 key 的明确拒绝语义；不能在记录被清掉后把旧请求当作全新发送。

### 6.3 Safe retry

继续暴露原 operationId，不引入用户必须管理的 retry plan ID。Core 内部保存每轮重试 revision 和累计目标 attempt。

一次显式 retry 请求拥有新的**请求级**幂等 key，但绑定已有 operationId；重复该 retry 请求不重复创建轮次。仅选原 operation 中确定 `not_applied` 且满足原因、延迟、累计次数约束的目标。其余成功目标不动。重试默认最多三次内容提交（含初次）；基础设施投递次数不计入内容提交次数。

新的 retry prepare 不能携带不同正文或新增账号。需要改内容或发新目标时，必须作为新发布意图处理。插件 hotfix 后允许对确定未送达的原目标重新编译相同 canonical content，并让用户确认新的 payload；不得沿用旧 approvalToken。

operation 原来的 failed / partial 可在明确批准安全重试后进入新的 pending/running 轮次；“终态”指当前执行轮次结束，不禁止用户以后显式发起合规重试。unknown 目标第一版不提供人工改判为可重试的接口。

### 6.4 Provider 返回值与 Core 裁决

```ts
type ProviderWriteOutcome =
  | { status: "succeeded"; remoteId?: string; url?: string }
  | {
      status: "failed";
      disposition: "not_applied";
      retryable: boolean;
      reason: ProviderFailureReason;
      retryAfter?: string;
    }
  | {
      status: "unknown";
      disposition: "unknown";
      reason: ProviderFailureReason;
    };

type ProviderFailureReason =
  | "auth" | "validation" | "rate_limited" | "provider_unavailable"
  | "network" | "permission" | "unsupported" | "unknown";
```

`retryable` 是插件提供的事实性建议，不是授权。Core 校验整个返回值并决定 retry eligibility。返回不合法、发送后 throw、失联或无法证明未提交的取消，按 unknown 处理。不能仅靠 HTTP 5xx/timeout 就断言未发送。

Contract test 可以检查已覆盖 fixture 的行为，**不能证明一个恶意插件绝不撒谎**。官方 Provider 必须有足够的失败注入测试；第三方依赖 Q7 的显式信任模型。

执行层公开状态固定为 `pending / running / succeeded / partial / failed / unknown`。存在未解决的 unknown 时，聚合状态必须保留 unknown，不被部分成功掩盖。成功但本地结果持久化失败要报告 durability 异常，不能诱导重发。

已 prepared、未 admission 的状态属于确认流程，返回 `phase: prepared` 与 `confirmation: required/expired`，不伪装成执行中的 pending。`status(operation)` 能区分这两种生命周期阶段，但不会返回可执行 token。

---

## 7. Provider Plugin：单一 contract，明确执行信任

### 7.1 包与最小接口

插件是普通 ESM npm package，package root default-export 一个 ProviderPlugin。官方名称为 `@syndroo/provider-<id>`；第三方包名不限，但不能通过包名或自报字段取得“官方可信”身份。

```ts
interface ProviderPlugin {
  manifest: ProviderManifest;
  connect: ProviderConnect;
  freeze(input: FreezeInput): FrozenProviderPayload;
  publish(input: ProviderPublishInput): Promise<ProviderWriteOutcome>;
}
```

这是接口职责定义，具体 DTO 由 `provider-sdk` 与协议 schemas 提供；不意味着存在可直接运行的函数实现。

Manifest 只保存 id、name、package version、整数 Provider API、declaredCapabilities、connect/publish options schemas。它与实现共同定义，不要求作者再维护一份 manifest.json。package version 与 manifest.version 必须匹配；构建测试拒绝漂移。

`defineProvider()` 提供类型检查和开发期约束，不能在模块初始化时联网或执行登录。Contract tests 位于 `@syndroo/provider-sdk/testing` 的测试子入口（D），避免测试框架成为运行时依赖；核心 helper 仍是 `providerContractTests()`，不新增独立测试 package。

### 7.2 官方与第三方一致

官方 Provider 同样通过 Provider API、Registry、schema 校验、统一 outcomes 和 contract tests。Core 不提供 `if (official)` 绕过验证的调用路径。

“official / third-party”是 runtime 依据内置发行清单、解析后的包和管理员选择产生的 provenance，不是 Plugin manifest 自己声明即可取得的权限。

### 7.3 显式 Registry

```json
{
  "providers": {
    "bluesky": "@grant/syndroo-provider-bluesky"
  }
}
```

同一 provider id 只有一个 active implementation。未覆盖时使用内置实现；指定 override 后，包缺失、导出错误、id 不符、API 不兼容、schema 不合法都必须失败，不得静默回退。

**解析基准（D）：**本地第三方包从用户明确选择的 Syndroo 配置文件所在目录及其依赖树解析，不从全局 CLI 安装目录或任意当前工作目录猜测。禁止自动扫描 node_modules、网络 URL import 或自动下载安装。实现时必须测试全局 CLI + 项目本地安装插件的组合。

运行时锁定实际解析的 package/version/依赖完整性信息。删除 override 后，新操作恢复内置实现；这不是回滚已发出的 SNS 内容，也不意味着未完成的旧批准可直接切换实现。

### 7.4 信任批准必须早于 import（D）

模块加载与求值属于执行代码；加载器不能先 import 第三方包读取 manifest，再问用户是否信任它。Node 的模块与权限文档也不把同进程权限模型视为恶意代码安全边界。[S1][S2]

首次使用的正确顺序：读取静态包元数据/锁文件 → 展示解析到的来源与版本 → 获得用户/管理员明确启用授权 → 写入受保护的批准记录 → import → 验证 manifest/contract → 注册。

无人值守 Agent 遇到未批准实现时得到 `PROVIDER_TRUST_REQUIRED`，不能用普通 publish approval 替代插件信任批准。interactive connect / publish prepare 可以在第一次 import 前完成提示；不新增 plugin 命令。部署端由管理员在构建/配置阶段批准，业务 HTTP 请求不能自行安装或批准包。

批准记录绑定解析来源、版本和已审核依赖快照，不永久信任一个可变包名。升级后的新 artifact 必须重新明确授权；既有用户授权范围若已明确覆盖该固定发布 artifact，则不重复询问。npm 安装生命周期脚本也属于代码执行，因此 Agent 的安装授权不能晚于安装本身；Syndroo 不充当 npm 安全审计器。

### 7.5 加载模式与可移植性

| runtime | 加载方式 | 限制 |
|---|---|---|
| Local CLI | 用户配置驱动的动态 import | 在已授权且兼容的包中选择；下次调用生效 |
| Self-hosted Server | 管理员显式 import，构建/启动注册 | 无运行时 package install endpoint |
| Cloudflare | 显式 import，构建时 bundle | 不动态下载 npm，不引入 Node-only runtime 假设 |
| Syndroo Cloud | 官方或经过审核并随部署注册 | 不允许租户上传任意第三方可执行代码 |

**同一个 contract 不等于每个 npm 包天然跨 runtime 可运行。** 使用 Node 专属依赖的第三方插件可能只在 Node 使用；需在 Worker 使用的插件必须完成 Worker 构建/运行验证，不能靠接口相同就声称兼容。官方目标 Provider 必须分别经过两种参考 runtime 的检查。

“热修复”指新 CLI 调用或新的 Server 部署选择新的实现，不是给正在发送的 operation 进行代码热替换。单次 operation 从 prepare 到 execute 固定实现 fingerprint；变更后重新准备和确认。

### 7.6 信任模型的能力与局限

Core 只向 Plugin 传当前账号的必需凭据、有效内容、options、受限上下文；不传全量 CredentialStore、数据库句柄、完整 config 或其他账号秘密。

但 in-process trusted code 可以自行使用宿主权限；接口上的最小暴露不是 OS sandbox。测试和 SDK 不能阻止恶意插件直接访问文件、网络或撒谎。Cloud 不执行任意租户代码正是这一模型的必要边界，不是 Cloud 与自托管出现另一套 Provider API。

---

## 8. Schema、能力观测与只读发现

### 8.1 JSON Schema 规则（D）

采用标准 JSON Schema 2020-12 描述输入，不发明自定义 DSL。Core schema 描述共同字段，Provider schema 描述目标 options / connect 输入。unknown 字段默认拒绝；禁止自动 coercion、删除错误字段或在验证时静默补写会改变发布的值。

Provider 可明确实现默认值，但默认值必须在 freeze 前展开，体现在 preview 和摘要中。只有静态编译进实现的 schema 可以参与验证。禁止远程 `$ref` 抓取、任意执行关键字和客户端自带的 schema 覆盖。

Schema 总大小、嵌套深度与输入大小有上限；不接受循环 JS object。复杂 regex 需要审核。Ajv 官方明确提示 schema 编译/验证可能存在深度和性能风险，因此“JSON Schema 是数据”不能作为无限接受外部 schema 的理由。[S5]

Schema 的 description、插件错误说明和文章内容都是数据，不是给 Agent 的指令。Skill 必须明确拒绝从描述中执行 shell、改变目的地或泄露凭据。格式合法不保证模型生成正确，所以最终请求仍由 Core 验证。

### 8.2 声明与观测

`declaredCapabilities` 表示该固定实现代码上支持什么；`observedCapabilities` 表示特定账号/凭据/实例在某次验证中实际取得的证据。

每个 observation 记录来源、verifiedAt、适用账号、credential revision、implementation/schema fingerprint，以及已知有效期（有信息时）。未知不是 false，过期也不是 true。认证成功不能自动推导为发布权限、图片权限或所有文章选项均已验证。

插件、账号或凭据变化使旧 observation 失效或标为 stale。status 可计算 stale 标记，但不更新存储或偷偷刷新。没有证据证明发布权限时可显示 unknown；是否准许在明确确认后尝试，取决于必需前提是否满足，而不是把所有 unknown 一律误报为已就绪或永久不可用。

### 8.3 五种固定查询

```ts
type StatusRequest =
  | { type: "overview" }
  | { type: "provider"; provider: string }
  | { type: "connections"; provider?: string }
  | { type: "operation"; operationId: string }
  | { type: "operations"; limit?: number; cursor?: string };
```

不支持任意 where/filter/select/sort/expand。overview 是有界摘要；完整 schemas 只在 provider detail 返回。operations 默认 20 条、最多 100 条，固定创建时间倒序加稳定 ID 作为次序，cursor 为不透明续页标识。

connections 在首版设置明确容量上限，因此不引入第二套无限列表查询。超限必须报清晰容量错误；不能静默截断到让 Agent 误判只剩一个账号。

### 8.4 status 不以发现为名执行插件（D）

新设计的 status 和 help 不动态 import 未批准的插件，也不调用 Provider 的 connect、freeze 或 publish。官方 manifest 可从构建时生成的 catalog 读取；第三方 manifest 从上次明确启用/prepare/connect 时保存的安全快照读取。

配置或 artifact 已变更但没有完成新一轮批准与验证时，status 返回 `untrusted / unavailable / stale` 元数据，不假装拥有最新 schema。此快照是自动生成的内部 read model，**不是要求插件作者维护第二个 manifest**。

status 不读取 secret，不提交状态更新，不轮询 SNS、不刷新 OAuth token。远程 SDK 调 status 会有 SDK→Server 的网络请求，但 Server 不因此访问 SNS。

---

## 9. 存储端口必须规定原子语义

### 9.1 不用泛化 CRUD 冒充可靠性

只共享 Connection / Operation / Delivery 的字段是不够的。下面的多个 get/put 若没有共同原子边界，可能导致重复批准、重复发送或半提交连接。

因此 ConnectionStore / OperationStore 的接口围绕业务动作设计（D）：

| 原子动作 | 必须保证 |
|---|---|
| `reservePreparation` | 同 scope+request key 只有一份 canonical 请求与 operation；不同输入冲突 |
| `savePreparedIntent` | 完整快照及确认材料可恢复后才算 prepare 完成 |
| `admitExecution` | 一次消费批准、CAS 检查版本、写入批准状态与可执行工作记录 |
| `claimDelivery` | 只有一个拥有者取得目标的内容提交资格；已成功/unknown 不可重新 claim |
| `recordOutcome` | 仅当前有效 claim 可以提交对应结果，保留累计次数与 evidence |
| `commitConnection` | secretRef、账号身份与 default/label 约束共同一致；失败保留旧记录 |
| `prepareRetry` | 针对原 operation 的精确目标和累计次数进行 CAS；并发重试不会重复预留 |

这些动作属于既有 ports 内的方法，不新增通用 transaction DSL。ConnectionStore 和 OperationStore 可以由一个具体 state adapter 同时实现；不能为了接口数量把实际事务拆散。

CredentialStore 独立，只提供受保护 blob 的 get/put/delete 与版本引用。Provider 不取得它的 handle。跨 SecretStore 与业务库采用先暂存后引用的提交顺序，而不是假装共享事务。

### 9.2 Runtime adapters

| runtime | 业务状态 | secret | 范围 |
|---|---|---|---|
| Local CLI | 私有文件、单写者锁、崩溃可恢复提交 | 私有 `0700` 目录与 `0600` 文件；明确不是加密 | 单机，第一版针对可验证的 POSIX 环境 |
| Self-hosted Node | 一个 SQLite state DB、唯一约束、事务 | 独立受保护的加密 secret 存储，密钥由部署注入 | 单租户、单活动执行实例的参考部署 |
| Cloudflare | D1 条件写与原子批次 | 与普通操作数据分离的加密 blob/表，密钥放部署 secret | Worker/Queues reference runtime |
| Future Cloud | tenant-scoped adapter 与上下文 | 按 tenant 绑定的加密/密钥策略 | 必须另验租户隔离，不等于今天已实现 |

**Server secret 的实现补充（D）：**默认采用经过认证的加密（例如 AES-GCM），使用随机唯一 nonce 与包含 scope/connection/version 的关联数据；部署密钥不进入普通数据库。丢失密钥必须失败，不能回退明文。Keychain/Vault/KMS integration 并非首版依赖，密钥轮换工具与备份恢复验证属于上线前运维检查。

SQLite 与 D1 共享存储语义，不强迫逐字相同 SQL。D1 文档的 batch 提供事务回滚语义，但不能因此假定存在与 Node SQLite 完全相同的交互式事务 API。[S6]

### 9.3 本地文件并发与恢复（D）

本地 adapter 使用短时全局写锁、临时文件、必要 fsync、原子替换和事务/提交标记，确保 state adapter 的业务原子动作对外只有旧版本或新版本。网络请求不长期持有 metadata 写锁；持久 claim 负责跨调用互斥。

不得在不能证明持锁者已停止时删除锁。没有 owner 记录、损坏的提交记录和未完成的写入都不能因为“想让 CLI 继续”而被忽略。明确可恢复的文件提交可在下一次写操作开始时恢复；纯 status 保持只读报告问题。无法安全恢复时失败并给出运维指引，不新增 `state recover` 用户命令。

默认新本地状态根为 `$XDG_STATE_HOME/syndroo/runtime-v1/`，未设 XDG 时使用 `$HOME/.local/state/syndroo/runtime-v1/`（D）；配置文件可通过全局 `--config` 明确选择，不扫描当前仓库猜测执行代码。配置路径与 state root 是不同概念。

首次 connect / real prepare 可以建立新的运行时 state；help、version、status、dry-run 不初始化。新格式采用新标记并拒绝旧格式，不自动读旧 secret reference。数据删除、reset 和旧目录清理不作为隐藏的启动行为。

### 9.4 并发与取消底线

在调用 Provider 之前持久标记 in-flight。一旦可能提交过请求，进程失联、lease 过期和 timeout 都不能成为“确定未发送”的证明。数据库 fencing 可以拦截过时写回，但不能撤销已经发往 SNS 的请求；系统选择保留 unknown 并禁止替代发送者盲目重发。

AbortSignal 是取消请求，不是远端撤销。收到取消后不启动新的目标；已开始的请求除非有可验证结果，否则保留 unknown。不得把超时简单映射成 failed/not_applied。

---

## 10. 同步 / 异步执行与部署组合

### 10.1 同一 operation，不同执行时机

CLI 在前台执行；Node Server 可以同步执行，也可启用 SQLite-backed durable worker；Cloudflare 使用 D1 + Queues。队列、worker 和 claim 信息不变成新产品概念。

同步返回 terminal result；异步在**durable admission 成功后**返回同一 operationId 与 pending/running。pending 不是已发布，HTTP 202 也不是成功的 SNS 链接。

### 10.2 不丢单，也不让 Queue 重投变成重复发帖（D）

批准消费、operation pending 和待执行标记必须一起提交。Queue 只是唤醒机制，消息携带 operationId、内部执行 revision 和必需的 scope 路由信息，不携带 token 或正文。

D1 已提交但 enqueue 失败：保留可扫描的 pending 标记，由有界恢复扫描再次通知。无需自建通用消息总线；待执行 operation 本身可以承担最小 outbox 角色。只有在工作记录仍可恢复时才能向客户端声称 accepted。

Cloudflare Queues 文档明确为 at-least-once；Consumer 必须用数据库里的 admission/claim 判定是否可执行，而不是“消息收到一次就发一次”。[S7]

**队列 delivery retry 与 SNS content retry 是两回事。** Queue 重投可以唤醒从未开始的工作；不能再次发已成功或 unknown 的目标。已发生过的确定失败只能走 Q24 允许、Q22 已确认的安全重试流程，首版不增加隐式自动批准重试。

Node Server 的可选 async executor 直接轮询 durable pending state，不要求用户额外安装 Redis。参考部署只支持一个活动 Node worker；多副本吞吐不是首版承诺，但本机并发请求仍要正确去重。

### 10.3 启动组合

必需组成是 stores、Provider Registry、执行器、强制鉴权和安全策略。可选组成是 OAuth callback 与异步 worker。Webhook 不在 v1。

缺少必需配置，或已启用模块缺少 origin/key/DB/Queue 等配置时直接拒绝启动。禁止 `AUTH_DISABLED`、`SECURITY_ENABLED=false` 和“OAuth 配置坏了就静默关掉继续跑”。变更安全相关模块需要重新启动/部署；不建立动态管理 API。

Cloudflare deployment 是一种基础设施 adapter，不自动等于 Syndroo Cloud 商业服务。Self-hosted 用户也可以部署 Cloudflare runtime；多租户、计费和配额仍是未来 Cloud envelope 的职责。

---

## 11. Server / Cloud 安全边界

### 11.1 Self-hosted

一个 deployment 是一个信任域。所有业务路由必须验证启动时注入的 deployment-level Bearer secret；不做用户/RBAC/token 管理 API，不允许禁用鉴权。

公开 `/health` 只返回最低限度的存活信息，不输出账号、配置、Provider 列表或构建秘密。OAuth callback 是传输例外，用经过验证的短期认证会话证明归属，不用 API Bearer 暴露给浏览器。

Secret 不能出现在 URL、访问日志、状态表、错误、analytics 或 CLI argv。鉴权比较使用正确的固定长度/常量时间校验方案；缺失或无效 key 不能触发 Provider 加载、查询私密状态或任何业务副作用。公网入口要求 HTTPS，允许受信任反向代理终止 TLS；SDK 默认拒绝非 loopback 明文 HTTP 发送 Bearer（D）。

### 11.2 出站请求、callback 与不可信数据

联邦实例、重定向目标和以后可能出现的媒体 URL 都需要出站边界。拒绝 userinfo、危险 scheme、loopback/private/link-local/metadata 地址；DNS 解析与每一跳 redirect 都重新检查，防止校验与连接目标不同。反向代理 forwarded headers 只有来自显式受信代理时才能影响 canonical origin。OWASP 的 SSRF 指引支持使用 allowlist、IP/DNS 检查及限制 redirect 的组合，而不是只检查 URL 字符串前缀。[S8]

Provider SDK 可提供安全传输 helper，官方 Provider 必须使用它；第三方 trusted plugin 可以绕开 helper，因此不能把它宣传成对恶意插件的网络沙箱。

OAuth app secret 是部署级敏感配置，只按当前 Provider 需求注入，不能作为普通用户 publish options。Server 的存在不自动获得各平台的 app 审核或发布权限；官方平台教程应准确列出当前可用认证方式与需操作者准备的条件，不虚构统一 OAuth 能力。

### 11.3 Cloud

Cloud 的认证层先解析身份与 tenant，再构造 tenant-scoped stores/registry/secret/executor context。Core 不到处接收 tenantId，但隔离必须贯穿连接查找、approval token、request key、队列工作、缓存、凭据加密上下文与日志。

tenant 不能由 body 随意指定；“类型里没有 tenantId”不代表隔离已经成立。禁止把可变的当前 tenant 放进全局单例。任一 operationId 或 token 都必须在当前授权 scope 内查询，不得因为 ID 很难猜就省掉权限检查。

Cloud 只运行随部署注册的官方/审核实现；不让 tenant 提供 npm 包、原始 JS 或动态 import 路径。Cloud 的隔离与运维验收必须独立完成后才可上线，不因共用 Core 获得自动安全背书。

---

## 12. CLI、HTTP 与 SDK 契约

### 12.1 CLI

只保留三个一级命令和全局 `--help / --version`；裸 `syndroo` 展示帮助。

| 用途 | 目标语法示例 |
|---|---|
| 交互连接 | `syndroo connect bluesky` |
| 从文件导入凭据 | `syndroo connect bluesky --credential-file ./credentials.json` |
| 人类准备/确认/执行 | `syndroo publish --input post.json` |
| 离线预览 | `syndroo publish --input post.json --dry-run` |
| Agent prepare | `syndroo publish --input post.json --request-id req_example --json` |
| Agent execute | `syndroo publish --input - --json`，stdin 为 execute machine request |
| 精确重试 | `syndroo publish --retry op_example --to conn_example --json` |
| 状态摘要 | `syndroo status --json` |
| Provider schema | `syndroo status --provider bluesky --json` |
| 连接列表 | `syndroo status --connections --json` |
| Operation 查询 | `syndroo status --operation op_example --json` |
| 历史分页 | `syndroo status --operations --limit 20 --json` |

该表是目标命令设计，不是当前 CLI 使用指南。`--to` 在多账号模型中必须解析为明确目标连接，不能再仅靠 provider 名字表达两个相同平台账号；只有没有歧义时才允许短名。机器高级 flags 不放进普通 post document。

stdin 支持明确的机器 request；普通文件无 `type` 则按 canonical document 适配为 prepare，不保留旧 schema 探测。互斥 source、请求 variant、缺参数和重复参数必须明确拒绝。

JSON 模式无交互等待；需要连接输入、插件授权或内容确认时返回结构化结果。人类模式内部完成 prepare→TTY确认→execute。不把 `--json` 当成自动批准。旧 `--yes` / `--no-input` 组合不是新协议的兼容要求；新增 CLI 不保留一个可绕过确认快照的 `--yes` 快捷路径。

Commander 负责一套命令与参数声明、解析和帮助。帮助不访问 state/secret/network。未知参数错误不得回显原始参数，避免误传 secret 时泄漏。人类输出先脱敏/转义后着色；支持 `--verbose`、`--no-color`、NO_COLOR 和非 TTY 降级，不引入终端 UI 框架。

机器 stdout 每次调用恰好一个 JSON envelope；诊断只进入 stderr，不输出 ANSI。所有可发送内容在 preview 完整呈现，内部 digest/revision 等默认隐藏但安全警告不得隐藏。

**退出码补充（D）：**0 表示操作/查询已正常处理，可能只是 action_required、confirmation_required 或 pending；1 表示内部/持久化错误；2 表示输入/配置/权限/预检拒绝；4 表示本次返回未知写入结果；5 表示人类明确取消；6 表示执行已知但不全成功；130 表示本地调用取消。status 成功查询到 failed operation 时仍为查询成功，Agent 必须读取 JSON 状态而不是只看退出码。

### 12.2 HTTP

```text
POST /v1/connect
POST /v1/publish
POST /v1/status

GET  /health                        # 无业务信息
GET  /oauth/callback/:provider       # 仅启用 OAuth 的部署
```

status 使用 POST 但没有业务写副作用；响应 `Cache-Control: no-store`。callback path 不负责自动批准发布。不给 HTTP 增加 providers/connections/receipts/retry CRUD 家族。

统一 envelope（D）：

```json
{
  "protocolVersion": 1,
  "operation": "publish",
  "ok": true,
  "result": {
    "status": "pending",
    "operationId": "op_example"
  },
  "error": null
}
```

`ok` 表示这次协议调用得到有效处理，不等于 SNS 已成功。业务结果在 result 中；错误使用稳定 code、静态安全 message、有限 details，不携带 provider 原始响应或 stack。

HTTP 200 用于完成的协议回应（包括准备确认、连接 action_required 和查询）；202 只用于已经 durable admission 的非终态执行；400/401/403/409/413/415/429/5xx 分别用于对应传输或准入错误。不能把已接受的 operation 因 Queue 通知暂时失败伪装成“肯定未执行”。

### 12.3 SDK

```ts
const syndroo = new Syndroo({ baseUrl, apiKey });

const prepared = await syndroo.publish(
  {
    type: "prepare",
    content: { text: "Hello from Syndroo" },
    targets: [{ provider: "bluesky" }]
  },
  { idempotencyKey: requestId, signal }
);

if (prepared.status !== "confirmation_required") {
  throw new Error("No confirmable intent was returned");
}

// requestUserApproval 是调用者自己的确认界面，不是 SDK 方法。
const approved = await requestUserApproval(prepared.preview);
if (approved) {
  const execution = await syndroo.publish(
    { type: "execute", approvalToken: prepared.approvalToken },
    { signal }
  );
  // execute 成功回应返回 execution operation；错误按 SDK 错误契约处理。
  const outcome = await syndroo.wait(execution.operationId, { signal });
}
```

这段代码描述分阶段调用关系，不是可在当前包上直接执行的实现。真正 SDK 必须先按 result.status 缩窄到 confirmation_required 后才读取 approvalToken，并由调用者自己的确认流程决定是否执行，不能复制成默认自动批准。SDK 解包合法 envelope 的 result；对协议/传输错误抛出结构化 SyndrooError；合法的 failed/partial/unknown operation 是业务结果，不当作可自动重试的 transport exception。

`connect/publish/status` 返回与请求 union 对应的准确类型；`wait` 只轮询 `status({type:'operation'})`。默认每 2 秒一次、总等待 120 秒，可通过 options 调整并设置上限。超时或 AbortSignal 只结束客户端等待，不取消 Server 工作、不重新 publish。

SDK 不自动接受 approvalToken、不自动继续 credential step，也不将网络重试与内容重试混在一起。自动传输重试只在身份可稳定复用且语义允许时进行；未知结果使用原身份恢复/查询。请求级取消、timeout、retry options 是 transport 配置，不扩展第四个业务方法。

SDK 纯 HTTP，Server endpoint 的 token 不应下发给不受信浏览器代码；浏览器集成通过用户应用的受保护后端，或未来已设计的 Cloud 身份层。

### 12.4 Skill 分发

Skill 随 `@syndroo/cli` 的固定目录分发，文档提供安装/引用方式；取消旧 `skill` 命令不取消 Skill 本身。Skill 主流程固定为：必要的 status discovery → 选择明确连接 → 保存 request identity → prepare → 展示完整 preview 并取得确认 → execute → status/wait。

Skill 不硬编码全部平台字段，不自动安装或启用未经授权的插件，不猜测账号，不把 unknown 当可重试，也不自行改变已确认内容。具体客户端的 skill 安装细节在实施时按其官方文档验证，本文不宣称所有 Agent 客户端都有相同安装机制。

---

## 13. syndroo-web 信息架构

保留独立的 `syndroo-web` 仓库与现有网站/docs 分工，不因本轮设计再换框架。目标导航为：

```text
Getting Started
├── Overview
├── Use with an Agent
├── Local CLI
└── Self-hosted Server

Platforms
├── Bluesky
├── Threads
├── LinkedIn
├── Mastodon
└── DEV.to

Build
├── Agent / Skill
├── SDK / HTTP API
├── Self-hosting
└── Provider Plugins

Reference
├── CLI
├── HTTP API
├── SDK
├── Provider SDK
├── Publish Request
└── Security
```

每个平台独立 `/platforms/<provider>`，固定顺序：Overview → Requirements → 获取凭据/授权 → Connect → First publish → Capabilities → Options → Troubleshooting → Revoke/Security。

手写内容负责真实用户任务：具体凭据获取入口、哪些权限必须先申请、输入来源、完整示例、成功/失败输出、token 撤销。不能只给 `TOKEN_PLACEHOLDER` 而让用户自行猜来源。教程使用人类流程与完整最小请求，不一上来要求未知的 verified account ID。

能力和 schema reference 来自指定官方发布 artifact 的 manifest 导出，按固定版本/commit 校验，不读取随时间变化的 latest。网站不在请求时 import 用户插件，也不通过第三方描述生成可执行脚本。导出 catalog 包含 provider/version/apiVersion/schema fingerprint；它是构建产物，不是第二份手写 manifest。

CI 必须验证：每条文档命令属于构建后的三个命令；示例可以通过对应 schema；链接/导航/搜索/站点地图同步；retired route 不残留在 export；runtime minimum 与真实 package engines 一致。网站没有 matching product artifact 时应失败，不允许跳过协议一致性检查后宣称全绿。

第三方插件自己的平台教程留给作者；官方站仅提供通用“编写 Provider / 覆盖 / 信任风险”的开发指南，不成为 marketplace。

---

## 14. 实现默认值与边界汇总（D）

下表是本规格补齐的首版保守默认值，不是平台官方限制，实施计划可在明确评审后统一调整：

| 项目 | 默认值 / 边界 |
|---|---|
| Connect session / 首次批准 TTL | 各 15 分钟 |
| 每个逻辑目标的内容提交次数 | 最多 3 次，含初次；不包含 Queue 重投 |
| 请求体 | 64 KiB；严格 JSON，拒绝重复 key / 非法 UTF-8 / 无法表示的值 |
| 每次 publish targets | 1–20；禁止解析后相同账号重复目标 |
| operations 页大小 | 默认 20，最大 100 |
| overview 最近记录 | 最多 5 条；不含完整 schema 或正文 |
| 每个 runtime scope 的连接数 | 首版最多 100；超限明确拒绝，不截断连接列表 |
| Schema | 单份不超过 64 KiB、嵌套深度最多 32；只允许本地引用 |
| SDK wait | 默认 2 秒间隔、120 秒总等待，可配置但有界 |
| 去重保留 | 首版不自动清除；不与正文归档一起丢弃 |
| 首批 Node 验证环境 | Node 24 系列为实现参考；最终最低 patch/engines 与依赖锁定由实施计划验证 |
| Local OS | 首版只声明已执行验证的 POSIX 平台，不假装 Windows ACL 等同 0600 |
| 官方功能声明 | 只有实现、schema、预览、tests 全部存在才 advertised |

Provider 自身的文字、文章、图片等限制由 schema/capability 及实际验证决定，不从旧版本照搬未经检查的数值。

---

## 15. 从零重构的实施顺序

这里是架构实施的依赖顺序，不是已经批准开始执行的逐文件 implementation plan。不要先把旧 CLI 大面积迁移到新库，再反过来补 Core。

| 阶段 | 交付物 | 可以独立证明的结果 |
|---|---|---|
| A · 契约与 fake provider | Core protocol、Provider SDK、测试 fixture、状态 union | 新文档解析、capability/schema 边界和 typed errors 一致 |
| B · 本地纵向闭环 | 文件 adapters、connect import、prepare/execute/status、假 SNS | 三个命令完整闭环；确认、凭据、幂等与崩溃边界可测试 |
| C · 插件与五个平台 | 标准官方 Provider、可信加载、hotfix fixture | 同一 contract；override/no-fallback/stale-intent 正确；平台差异留在插件 |
| D · Node Server 与 SDK | Bearer auth、SQLite、保护的 secret、三个 HTTP endpoint、SDK | CLI 与 HTTP 通过同一语义测试；SDK 打包不依赖 private workspace |
| E · Cloudflare 与 durable async | D1 adapter、Queues、pending 扫描、callback adapter | enqueue gap、重投、并发、unknown 在边缘 runtime 下验证 |
| F · docs 与发布准备 | syndroo-web 新 IA、每平台教程、generated reference、Skill、tarballs | 文档/manifest/打包 CLI 一致；旧架构无残留；发布仍另行授权 |

OAuth 基础 step protocol 在 A/B 设计，具体 browser callback adapter 随对应 runtime 的安全验收实现。Cloud 的计费、租户管理和商业上线不是 E 的隐含交付；共享 Core 只是使其以后可组合。

旧代码在新闭环有验证后按 scope 删除，不保留兼容 shim。保留 LICENSE、NOTICE 与实际第三方许可证义务；未经授权不删除用户内容或远端资源。

---

## 16. 评审结论、执行门槛与剩余限制

### 16.1 本文已处理的架构接缝

- Q36 的单一 manifest 与 Q7 的信任模型：先批准包再 import；生成 catalog/snapshot 支持只读 discovery。
- Q22 的跨调用确认：prepared intent 必须先持久化；批准绑定账号、内容、schema 与插件 artifact。
- Q20 的机器幂等：SDK/Agent 只在同一稳定 request identity 下安全重放；不声称可自动识别两次独立自然语言意图。
- Q9/Q10 的共享 Core：ports 定义业务原子动作，不复制或假定所有 adapter 都能接受任意事务回调。
- Q26 的异步执行：durable pending 与 admission 一起提交；队列重投不直接触发第二次 SNS 提交。
- Q28 的 tenant-free Core：隔离必须存在于 scope-bound storage、secret、queue、cache，不是简单把 tenantId 从函数参数删掉。
- Q13 的 status 只读：状态维护不进入查询；metadata 导出不执行未授权插件；去掉 state 命令不去掉安全恢复责任。

### 16.2 明确不作的保证

不保证 SNS 全平台 exactly-once，不保证跨独立部署去重，不保证通过 approvalToken 验证真人阅读，不保证 trusted in-process Plugin 不能访问宿主资源，不保证 JSON Schema 会让 Agent 永不填错字段，不保证某 Provider 认证成功就拥有所有发布权限。

这些不是降低已接受的规则，而是把协议可验证的边界与无法由该信任模型证明的性质分开。

### 16.3 正式开工前的门槛

先评审本文的 D 条目和验收矩阵，再制定任务级 implementation plan；不重新启动 Q40 问答。新设计 approval 不能代替测试结果。认证、secret、幂等、并发、取消、callback 与异步恢复必须有实际隔离执行证据后才可验收。

架构、安全、最终审查由 Astra 负责。后续实施任务按项目规则显式检查并选择 `deepseek/deepseek-v4-flash` 路由，每个子任务最多三次尝试、默认最多两个活动子代理；路由不可用时不得自行替换。本文由架构编排者完成，未调用其他模型，不存在已完成的实施委派。

本次只生成会话文件并做规格静态检查。没有修改产品源码、安装依赖、提交、推送、发布、部署、连接真实 SNS 或删除状态。无法连接的仓库也没有被假定已同步。

---

## 17. 外部技术依据

下列来源于 2026-10-08 查询，仅用于验证基础设施和安全事实；Syndroo 的产品决策以 Q1–Q39 为准。源文档不是对本项目的授权，也不证明本规格已实施。

- **[S1] Node.js — ECMAScript modules**：模块解析、加载和执行模型。https://nodejs.org/api/esm.html
- **[S2] Node.js — Permissions**：进程权限模型不提供恶意代码安全保证。https://nodejs.org/api/permissions.html
- **[S3] IETF RFC 9700 — OAuth 2.0 Security Best Current Practice**：redirect URI、CSRF、state/PKCE、授权服务器身份绑定。https://www.rfc-editor.org/rfc/rfc9700.html
- **[S4] Ajv — Standalone validation code**：构建期生成独立验证器。https://ajv.js.org/standalone.html
- **[S5] Ajv — Security considerations**：schema 信任、深度、编译/验证成本与 regex 风险。https://ajv.js.org/security.html
- **[S6] Cloudflare D1 — D1 Database API**：batch 事务回滚与会话一致性。https://developers.cloudflare.com/d1/worker-api/d1-database/
- **[S7] Cloudflare Queues — Delivery guarantees**：at-least-once 与重复消息处理责任。https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- **[S8] OWASP — SSRF Prevention Cheat Sheet**：目标 allowlist、地址/DNS 和 redirect 防护。https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
