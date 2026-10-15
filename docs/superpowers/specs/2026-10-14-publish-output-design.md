# Syndroo publish 输出改版设计

日期：2026-10-14  
状态：设计稿，待整体审核；尚未实现  
范围：`publish`、`status --operation`，以及实现这两处体验所需的账号展示元数据、协议投影与进度通知  
建议仓库路径：`docs/superpowers/specs/2026-10-14-publish-output-design.md`

> 本文是目标设计，不是当前 CLI 使用手册。`--yes`、`v` 展开预览、新字段和动态展示均需实现后才可使用。终端样例中的账号、URL、operation ID 为示意值，不代表实际发布结果。

## 1. 目标与已确认决策

用户需要一眼看清：发往哪个平台和账号、发布什么内容、正在进行哪一步、哪些成功或失败，以及下一步怎么处理。默认输出不再以内部 ID 为主体；脚本和 Agent 继续使用稳定的机器协议。

| 决策 | 已选方案 | 设计约束 |
|---|---|---|
| Q1 | A | 平台账号名为主，已有连接 `label` 为可选补充。 |
| Q2 | A | 缺少名称时回退到缩短的 `accountId`；发生显示歧义时展开更多字符。 |
| Q3 | A | 默认隐藏内部 ID；失败、部分失败、未知结果后提供一次含完整 operation ID 的查询命令。 |
| Q4 | A | 账号主页 URL 优先，缺少时回退平台／实例地址；帖子 URL 在成功后单独显示。 |
| Q5 | A | 合适的交互终端原地刷新；其他环境追加日志；JSON stdout 不混入进度文本。 |
| Q6 | B | 默认内容最多 3 行；确认前可以查看完整内容，查看不等于确认。 |
| Q7 | A | 支持 `--yes --json`；自动确认仍执行准备、校验、冻结和执行前检查。 |
| Q8 | A | 默认统一原因和处理建议，详细安全诊断放在 verbose；先脱敏再展示。 |
| Q9 | A | 默认隐藏确认有效期；稍后执行或过期时提示；verbose/JSON 保留完整时间。 |
| Q10 | A | 多目标结束时追加一行汇总；单目标不重复汇总。 |
| Q11 | A | 单次操作查询共用展示规则；查询历史快照，不重新发布或读取改过的输入文件。 |

以下字段名、终端降级规则和测试要求，是落实上述选择的具体设计，不是额外扩大的产品范围。

## 2. 目标终端体验

### 2.1 确认前

```text
❯ syndroo publish --input post.v1.json

Review publication — nothing has been sent

-> bluesky · @syndroo.bsky.social (Syndroo Official)
   https://bsky.app/profile/syndroo.bsky.social
Content:
  Syndroo now publishes from the command line.
  One document can target multiple accounts.
  More details about this release…
Status:
  Awaiting confirmation

-> devto · syndroo (Engineering)
   https://dev.to/syndroo
Content:
  Syndroo now publishes from the command line.
Status:
  Awaiting confirmation

Some content is shortened. View the full preview before confirming if needed.
Publish to 2 accounts? [y/N/v]
  y: publish · N: cancel · v: view full preview
```

内容未被截断时不显示缩略提醒。`v` 显示每个目标的完整冻结预览，包括内容及发布相关字段，再返回同一个确认提示。只有不含歧义的 `y`/`yes` 执行；空输入、EOF、`n`/`no` 取消；其他输入提示重新选择，不触发发布。`v`/`view` 不是授权。

展开不重新读取 `post.v1.json`，不重新准备、不重新调用 Provider，也不刷新原来的确认期限或交互截止时间。展开后内容仍保持完整可读，不立即被缩略视图覆盖。

### 2.2 执行中

```text
❯ syndroo publish --input post.v1.json --yes

-> bluesky · @syndroo.bsky.social (Syndroo Official)
   https://bsky.app/profile/syndroo.bsky.social
Content:
  Syndroo now publishes from the command line.
Status:
  Publishing…

-> devto · syndroo (Engineering)
   https://dev.to/syndroo
Content:
  Syndroo now publishes from the command line.
Status:
  Waiting
```

只有实际获得执行权并进入调用阶段的目标显示 `Publishing`。尚未开始的目标显示 `Waiting`。第一项结束后才进入第二项；本次不改变串行执行。

准备期间可显示单独的 `Preparing publication…`，不能把准备阶段的身份检查显示成“正在发布”。

### 2.3 全部成功

```text
-> bluesky · @syndroo.bsky.social (Syndroo Official)
   https://bsky.app/profile/syndroo.bsky.social
Content:
  Syndroo now publishes from the command line.
Status:
  Successful
Post:
  https://bsky.app/profile/syndroo.bsky.social/post/example-post

-> devto · syndroo (Engineering)
   https://dev.to/syndroo
Content:
  Syndroo now publishes from the command line.
Status:
  Successful
Post:
  https://dev.to/syndroo/example-post

Summary: 2 successful
```

帖子 URL 只在 Provider 返回可靠的公开链接时显示。没有链接仍可显示成功，但不显示空 `Post:` 字段、不猜测地址。这里的成功表示 Provider 按现有发布契约确认成功，不表示额外检查了所有终端用户可见性，也不保证帖子未来不会被删除。

### 2.4 部分失败

```text
-> bluesky · @syndroo.bsky.social (Syndroo Official)
   https://bsky.app/profile/syndroo.bsky.social
Content:
  Syndroo now publishes from the command line.
Status:
  Successful
Post:
  https://bsky.app/profile/syndroo.bsky.social/post/example-post

-> devto · syndroo (Engineering)
   https://dev.to/syndroo
Content:
  Syndroo now publishes from the command line.
Status:
  Failed
Reason:
  Authentication failed.
Next:
  Check this account's credentials or reconnect it.

Summary: 1 successful, 1 failed

Check this operation:
  syndroo status --operation op_example --verbose
```

查询命令使用实际 operation ID 的完整值，只出现一次。推荐直接加 `--verbose` 进入排查，但不建议“用 verbose 再跑一次 publish”。示意错误只适用于确实收到身份验证失败结果的目标；不根据通用失败推断出凭证失效。

### 2.5 结果未知

```text
Status:
  Unknown
Reason:
  The request may have been accepted, but the result could not be confirmed.
Next:
  Check the account and saved operation before publishing again.
```

`Unknown` 不是 `Failed`。不得提示直接重试该目标，更不得自动重新发布。查询本地状态也不等于访问平台核对帖子：若现有 Provider 没有核对能力，仍保留未知状态。

## 3. 账号与链接展示

### 3.1 优先级

| 数据 | 展示 |
|---|---|
| 平台账号名 + label | `@handle (Label)` |
| 只有平台账号名 | `@handle`，具体前缀遵从 Provider 提供的可读名称 |
| 只有 label | `Label` |
| 两者均无 | 缩短的 `accountId`，如 `did:plc:goxx…qf` |

优先使用有识别意义的 username/handle，而不是泛化的人物昵称。平台账号名是可选展示信息，不能取代稳定账号标识。名称和 label 完全相同时可以省略重复的括号部分。

身份回退默认保留前 12、后 4 个字素，中间加 `…`；短于该长度则完整展示。在本次目标集合中，对最终展示身份发生的碰撞统一检查：增加 ID 字符，必要时显示完整账号 ID 和实例地址。不因为可读名称相同就合并目标。完整 ID 极长时换行而不是制造歧义。

### 3.2 URL

标题使用可选 `profileUrl`；没有有效公开主页则使用经过验证的 `account.origin` 作为平台／实例地址。缺少主页不是发布失败。

账号主页与帖子 URL 分行展示，避免在窄终端挤在括号里。可复制 URL 不做摘要截断，允许自然换行。显示 URL 不会触发下载、浏览器打开或额外网络请求，也不改变 Provider 的出站权限。

URL 必须通过协议、长度、认证信息及控制字符检查；带用户名密码、凭证参数或终端控制内容的链接不得原样输出。不能仅因字符串以 `https://` 开头就认定安全。帖子正文中的链接属于用户发布内容，不能擅自改写实际载荷。

## 4. 状态与汇总

| 事实／阶段 | 人类展示 | 说明 |
|---|---|---|
| 准备进行中 | Preparing publication | 尚未提交发布。 |
| 已准备，等待授权 | Awaiting confirmation | 还没有发送。 |
| 执行已受理，目标仍为 ready | Waiting | 还未进入该目标调用。 |
| 目标已获得 claim，处于 in_flight | Publishing | 来自实际执行状态，不靠计时器猜测。 |
| outcome.succeeded | Successful | 保留机器状态 `succeeded`。 |
| outcome.failed / not_applied | Failed | 有明确失败依据。 |
| outcome.unknown 或写入结果无法可靠保存 | Unknown | 可能已发送，不自动重试。 |
| outcome.not_started | Not sent | 明确没有开始；不伪装成平台失败。 |
| 离线 dry-run | Preview only | 明确保留凭证／权限未验证提示。 |

`partial` 是整次操作的机器状态，不作为每个目标的新状态。最终多目标汇总只列非零数量，例如 `Summary: 1 successful, 1 failed, 1 unknown, 1 not sent`。仍在运行时可以显示完成数量，但不能用最终成功口吻宣布完成。

中断、超时及存储故障沿用 Core 的结果判定。超时不是“必然未发送”的证据；不能把整批目标全部标为 Failed。发生 `OUTCOME_NOT_DURABLE` 时必须显示明确的可靠性警告，不能因为某个临时事件看似成功就隐藏它。

CLI 退出码、JSON `ok` 与业务结果保持现有区分。成功调用 Core 的 `ok: true` 不代表全部平台发布成功；脚本仍需读业务状态。`failed`/`partial`、`unknown`、取消和输入错误沿用既有退出码映射，不为这次视觉改版重新编号。

若 Core 返回的是仍在等待或运行的结果，而不是终态，保留其真实状态并给出一次查询入口，不把正常进程退出等同于“已发布”。

## 5. 内容摘要、确认与终端行为

### 5.1 内容摘要

默认最多 3 个渲染行，按实际终端宽度计算；不可读取宽度的追加日志使用固定 80 列布局。只在确实截断时加省略号，并明确提醒可查看全文。截断保留 Unicode 字素边界，不切断汉字、emoji 组合或代理对。

摘要来自各目标冻结的 `ProviderPreview`，不是原始公共输入，更不能假定所有平台内容相同。去除现有输出中同一正文与等值 `text:` 字段的重复显示；不同内容的字段不能因为名称相似而丢弃。

发布对象、文章标题和 Provider 明确标记的可见性等关键发布字段，不得作为正文尾部一起静默截掉。普通视图可紧凑显示非正文选项；`v`/verbose 展示全部安全冻结预览字段。排版和控制字符转义只影响展示，不修改 payload 或 digest。

### 5.2 终端刷新

只有 stdout 为交互终端、具备安全重绘能力且区域能容纳当前布局时原地刷新。`TERM=dumb`、输出被重定向、布局超过终端高度或无法可靠重绘时，退回追加式文本。`--no-color` 只控制颜色，不授权控制字符进入管道。

追加日志模式先显示每个目标的身份及内容摘要，之后只追加有变化的状态行，最后显示最终结果及汇总；不要每个 tick 重印整块内容。进度不是百分比估算，不提供虚构剩余时间。

动态展示应保证光标恢复、窗口调整与 Ctrl-C 后终端可继续使用。渲染器失败不得让已发送的结果被判为平台失败，也不得额外触发发布。输出通道故障可以导致 CLI 非零退出，但业务结果仍以状态存储为准。

### 5.3 确认与输出终端分离

能否重绘与能否取得人类确认是两个判断。正常交互提示在控制终端读取，而不是把 post JSON 的 stdin 当作 `y`。stdout 被重定向但仍有控制终端时，确认所需预览和提示必须在该控制终端可见；stdout 保持追加文本。如果没有可安全展示和读取确认的终端，就只返回待确认信息，不等待输入，也不发送。

JSON 模式不显示任何交互提示。重绘期间的诊断先暂停重绘或通过同一输出协调器写入 stderr，不能破坏 stdout 的结果布局。

## 6. 参数与输出契约

| 命令／模式 | 发布行为 | stdout |
|---|---|---|
| `publish --input post.v1.json`，可交互 | 预览 → y/N/v → 确认后执行 | 人类输出 |
| 同上，无可用确认终端 | 只准备，不发送 | 待确认结果和安全的下一步说明 |
| `publish --input post.v1.json --yes` | 准备并自动确认同一冻结意图 | 人类进度及结果 |
| `publish --input post.v1.json --json` | 只准备，不交互、不发送 | 单个 prepared envelope |
| `publish --input post.v1.json --yes --json` | 准备 → 自动确认 → 执行 | 单个最终 execution/error envelope |
| `publish --input -`，合法 execute 请求 | 使用既有 token 执行 | 按所选输出模式返回结果 |
| `publish --input post.v1.json --dry-run` | 保持离线，只读预览 | 标记未验证项的预览 |
| `status --operation ID` | 只读取该操作 | 共用结果展示 |

`--yes` 是授权捷径，不是跳过安全检查的捷径。它不重新生成凭证、不绕过身份绑定、过期、Provider 校验、冻结载荷或幂等规则。重复 request ID 返回既有执行结果时不再创建或执行第二次操作。新的 request ID 仍可能是另一项发布，不能把 `--yes` 理解为全局去重。

`--yes` 与既有显式 execute 请求共用时是冗余选项，不创建新的 prepare。`--dry-run --yes` 仍保持 dry-run，绝不发送；该组合需要测试。显式 retry 使用 `--yes` 也只确认 Core 判定可重试且用户已选择的目标，不扩大重试集合、不改变次数限制。

`--verbose` 的人类 stdout 展示完整预览和更多结果字段：operation ID 在操作级完整显示一次，connection ID、accountId、attempts 和已有的安全诊断在对应目标下完整显示。确认到期时间只在具有该字段的待确认结果或专门交接说明中展示，不为了 verbose 给已完成结果伪造字段。执行过程诊断写 stderr。`--json --verbose` 的 stdout 仍然只有一个完整 JSON envelope，stderr 仅有安全诊断，不输出另一份人类正文或 approval token。

JSON 不受 3 行正文和 2 行错误摘要规则影响；仍遵守协议字段长度与敏感信息边界。新增字段不意味着输出内部状态文件、凭证、原始 HTTP 头、原始 response body 或任意异常栈。

## 7. 确认有效期与错误展示

### 7.1 有效期

本次保持当前 15 分钟的确认窗口，从 prepare 开始时刻计算，不改为从用户看到提示时开始。`expiresAt` 不是帖子过期时间，也不是发布网络请求的超时时间。[S4]

普通预览隐藏时间。verbose 显示确切时间和易读剩余时长；JSON 保留原始 `expiresAt`；提供稍后执行途径时显示剩余有效时间。到期后禁止执行，并提示重新运行、查看和确认；不自动延长，也不把旧确认用在新准备的内容上。

已经受理执行的操作不会因确认窗口之后到期而被撤销。超时处理中应区分 approval 的有效期与执行器自己的调用／claim 时间边界。

### 7.2 原因和建议

默认 `Reason` 最多 2 个渲染行，超出加省略号；`Next` 使用简短、受控的建议。错误类别来自现有的 `reason` 或经过验证的安全错误码，不从“没有收到结果”推断鉴权失败。

| 确认的类别 | 原因方向 | 建议方向 |
|---|---|---|
| auth | 身份验证失败 | 检查凭证或重新连接账号 |
| permission | 发布权限不足 | 检查该账号的授权范围 |
| validation | 内容／选项不被接受 | 核对对应目标内容与字段 |
| rate_limited | 平台限流 | 有可靠 retryAfter 时展示，按既有安全重试规则处理 |
| provider_unavailable | 平台暂不可用 | 查看状态；不承诺再次调用一定安全 |
| network + 明确 not_applied | 未能完成请求 | 检查网络；仅符合既有规则才允许重试 |
| unknown | 无法确认平台是否已接受 | 查询记录并核对平台，不自动重试 |

准备阶段失败可能尚未生成可执行的逐目标结果。此时显示 `Publication not started` 和安全的整体错误，不伪造“所有平台各失败了一次”；没有真实 operation ID 时不输出假的查询命令。

现有 ProviderWriteOutcome 只有分类原因，不能凭此显示平台原始错误描述。本次增加可选、受控的安全诊断字段：`providerCode`、`httpStatus`、`message`。前两者来自已验证的码值；message 采用 Provider 已审核的固定文案／模板，不任意反射 response body、输入或 error.message。[S2]

详细诊断可缺省，缺省不是错误。不新建一个无限制 debug dump。敏感信息要在进入结果存储和日志前去除，不能只靠 UI 截断或一条通用正则。

平台凭证、refresh/access token、Cookie 和 Authorization 值不进入人类输出、错误诊断或结果展示字段。approvalToken 属于既有授权协议的能力值，不因 verbose 而打印；现有受控 prepared 机器响应及执行交接路径不在本次删除字段，但它们不能被复用为通用日志渠道。`--yes --json` 不额外输出中间 prepared token。

## 8. 数据与实现边界

### 8.1 账号展示信息和身份分离

建议增加一个小的、可选类型：

```ts
// 目标契约示意，不是本轮已实现代码。
type AccountPresentation = {
  accountName?: string;
  profileUrl?: string;
};

type TargetPresentation = AccountPresentation & {
  label?: string;
};
```

不要把 `accountName` 或 `profileUrl` 塞进 `AccountIdentity`。稳定身份保持 `provider + origin + accountId`；可读名称、主页和 label 不参与目标选择、账号去重、鉴权或 bindingRevision 的判定。

Provider 在已有的连接／验证结果上可选返回 presentation。优先利用原有 API 返回的信息，不为了终端好看增加必需的网络请求。元数据缺失或可选展示字段无效时丢弃该展示字段并回退，不得忽略真正的身份校验失败。

可读账号名限制为 1–256 个 Unicode 码点；主页 URL 最大 2048 个字符，此外沿用协议总体大小限制。终端对所有不可信元数据、label、错误和 URL 进行控制字符／ANSI／OSC／回车／双向格式控制检查或可视化转义，不能允许伪造 Status 行。

建议传播路径：

```text
Provider VerifiedIdentity.presentation（可选）
  → ConnectionRecord / ConnectionView.presentation
  → FrozenTarget.presentation（同时保存当时的 label）
  → TargetPreview.presentation
  → DeliveryResult.presentation
```

presentation 本身不改变稳定身份，但本次操作保存的展示快照属于冻结意图的一部分，应受该意图完整性保护。此后连接更名不得修改旧 FrozenIntent 或导致查询历史时改用新名称。账号名只是一项当时的展示记录，不保证日后平台名称仍未变。

### 8.2 共用结果投影

在现有结果上添加必要的可选展示字段，而不是再建立一套独立发布数据库：

```ts
// 对现有 DeliveryResult 的增量字段示意。
{
  state?: 'ready' | 'in_flight' | 'settled';
  preview?: ProviderPreview;
  presentation?: TargetPresentation;
}
```

`state` 来自已存储的 DeliveryRecord，不能从 `outcome: null` 猜出目标是否已经开始。内部原有必填状态不放宽；可选性用于公共读模型兼容缺少字段的数据。新序列化器对可取得的字段始终提供实际值。

`preview` 从对应 operation 的冻结目标获取，不复制另一份正文进新表。投影按稳定 deliveryId 关联，不能按平台名或数组下标联接多账号结果。首次执行与后来 retry 的结果必须按其真实执行轮次关联已有快照，保留未重试目标的结果；不得把重试子集的内容套在整批目标上。

直接 execute、幂等 replay 和 status 查询都必须走同一投影，不依赖当前进程曾经看到过 prepared 响应。旧记录若已有冻结正文，就从其中恢复展示；确实缺失的字段显示不可用，不借当前连接或文件补造历史。

### 8.3 实时进度

Core/Executor 增加可选、运行时无关的轻量通知回调。它传递已提交状态的安全执行快照，CLI 据此更新共同视图。

通知至少覆盖：执行受理、目标 claim 成功、结果持久化、未开始目标被停止、整轮结束。claim 竞争失败不能产生“正在发布”事件，结果写入失败不能产生“已可靠成功”事件。回调失败必须与 Provider 调用异常隔离，不能落进将 Provider 结果转为 unknown 的同一个 catch 分支。

不引入消息总线、后台守护进程、WebSocket、SSE、跨进程订阅系统或新的队列表；不改成并行执行。HTTP/SDK 不因本地刷新需求新增流式协议。

### 8.4 CLI 共用展示

建议仅增加少量具体模块：一个将 prepared/execution 规范化为目标视图的函数组，一个共用发布结果 renderer，以及处理 TTY／追加输出的轻量控制器。`publish` 和 `status --operation` 调用它们。保留原有命令入口，不引入插件化 UI 框架或通用事件框架。

status 是一次读取，不自动轮询，不连接 Provider，不发送内容。对于尚未完成的保存状态，标注它是 `Last recorded status`；不能让一个保存的 in_flight 记录产生“已确认远端此刻仍在执行”的错觉。没有足够状态字段时显示“无法判断运行阶段”，不捏造 Publishing。

## 9. 协议、存储和文档影响

| 部分 | 必要改动 |
|---|---|
| Provider SDK / 官方 Provider | 可选账号展示信息、安全诊断类型及对应固定夹具；不强制每个平台立即返回全部字段。 |
| Core / protocol | 冻结 presentation、结果投影、可观察目标状态、进度回调；更新 schema 源文件和生成产物。 |
| CLI | 新参数、确认循环、共用 renderer、终端降级与 stdout/stderr 隔离。 |
| 状态适配器 | 验证可选字段在文件系统、SQLite、D1 中往返一致，不丢失快照；不擅自清空数据。 |
| SDK / Server / Worker | 与公共结果字段一致的 schema、序列化和契约测试；不是开发新后台发布功能。 |
| 文档 / Skill | 帮助、README、CLI manual、Agent quickstart、remote compatibility、bundled Skill 与新行为一致。 |

本次不改现有请求格式、HTTP URL v1 路线、业务状态枚举和退出码定义。新结果字段是协议扩展，不能宣称“JSON 字节和旧 schema 完全不变”。现有严格客户端可能拒绝未知字段，因此生成类型、校验器、SDK 与服务端必须协调更新，记录支持的版本组合，不假设旧客户端具有前向兼容性。[S2][S7]

修改 schema 源文件后重新生成，不能只手改 `generated/types.ts`。读取缺少可选字段的旧记录应正常回退，但不得就地重写旧冻结意图或重算其原有摘要来假装新字段一直存在。不增加历史内容回填任务或破坏性迁移。

仓库 AGENTS.md 当前把 `--yes` 列为废弃语法。用户 Q7 已明确授权此次设计重新引入它，实施时需要同步修正该条指南；在实现之前，不把本设计样例挪进“当前已可用”的操作指南。[S7]

本次不修改 `status --connections`、`status --operations` 的布局，不增加 `--watch`，不新增账号管理子命令、不扩平台清单、不加自动重试、不改变实时与异步部署模式。若兼容性工作揭示必须改动身份、迁移或发布语义，应另行提出，不隐藏在 renderer 重构内。

## 10. 验收要求

以下是实施后必须执行的测试要求，本轮没有运行这些产品测试。

| 编号 | 需要证明的行为 |
|---|---|
| T01 | 四种名称组合、重复 label、相同 handle、多实例、缩写碰撞、缺少主页，均能无歧义显示且不改变目标选择。 |
| T02 | 名称／label 改动不改变稳定身份；历史操作仍显示冻结时的信息。 |
| T03 | 中文、emoji、长行、多行、极窄终端、ANSI/OSC/回车/双向控制字符，摘要不破坏字符且不能伪造状态；完整 payload 不变。 |
| T04 | 默认最多 3 行；v 展示全部冻结预览再询问；v、n、EOF 都不调用 publish；y 只发送同一冻结内容一次。 |
| T05 | 在等待或 v 展开期间编辑原文件、换账号绑定、Provider 更新或 approval 到期，不能导致旧授权被应用于新意图。 |
| T06 | --yes、--yes --json、无 yes 的 json、无控制终端、dry-run --yes、显式 execute 和合法 retry 组合都遵循表中行为。 |
| T07 | 使用可控阻塞的假 Provider 和真实状态存储证明：目标一 Publishing 时目标二 Waiting；顺序、claim、attempts 不受进度影响。 |
| T08 | 注入回调抛错、输出异常、claim 冲突与结果落盘失败，证明无第二次发送、不伪造 Successful，可靠性警告不丢失。 |
| T09 | 成功、失败、部分失败、unknown、not_started、取消与准备失败的单目标／多目标输出、查询入口和汇总正确。 |
| T10 | --json stdout 恰好一个符合 schema 的 JSON 文档；无进度、提示、ANSI 或第二个 prepared envelope；verbose 诊断只进入 stderr。 |
| T11 | 凭证和敏感 URL 注入夹具不会进入元数据、错误、diagnostic、持久化结果、stderr 或 snapshot；授权协议能力值仅留在既有受控交接边界。 |
| T12 | 查询一个完成／失败／未知／未完成／已过期的操作时，不调用 Provider、不执行发布、不读取原输入文件、不更新历史记录。 |
| T13 | 执行轮次与 retry 子集按 deliveryId 正确关联；同 request ID 重放不增加外部调用。 |
| T14 | 文件系统、SQLite、D1 的共享状态契约和协议往返测试通过；缺少可选字段的旧记录不被改写。 |
| T15 | 合适 TTY 原地更新，非 TTY / dumb / 大布局安全降级；结束和中断恢复终端；错误不会污染机器 stdout。 |
| T16 | --help、README、manual、Agent quickstart、remote compatibility、AGENTS 和 bundled Skill 不再互相矛盾。 |

实施验证先用隔离状态目录、假时钟、可控 Provider 和伪终端，不使用真实社交账号发帖。按照仓库既有要求执行相关测试、整体共享契约测试、构建检查以及 diff 检查；只有实际执行并查看结果后，才可标记为通过。真实平台行为仍需单独授权和验证。

## 11. 方案取舍

采用“可选元数据 + 共用投影与 renderer + 本地轻量进度回调”。它比只改字符串多一些数据工作，但能满足真实进度和历史查询，不把复杂度藏在 CLI 猜测里。

不采用“只改 renderer”：当前执行结果缺少所需的目标阶段和内容预览，单纯格式化不能可靠满足 Q5/Q11。[S2][S3]

不采用“通用任务 UI／流式后台架构”：会扩大产品范围，而原地刷新并不需要新的后台系统。

## 12. 源码核对与审核状态

### 源码依据

本轮通过已连接的 WebCodex 仓库读取；路径相对 `syndroo/`。读取为非原子观察，不把这些摘录冒充整仓库所有文件的固定版本。

- [S1] `packages/cli/src/commands/publish.ts:155–218`：现有确认分支，JSON 不提示，确认后执行同一 token。读取 SHA-256：`1c1e8c0976fe67d60c888b6ce350d263effe33d98ac4584fb7d4f4fe17e15385`。
- [S2] `packages/core/src/protocol/generated/types.ts:22–37, 45–51`：身份、预览、执行结果和 Provider 失败类别；目前没有 account presentation、逐目标公开 state 或诊断描述。SHA-256：`c7428496d0014db59cb68256e5e5f1763b3b3eb61f635321229ddb3101481f2a`。
- [S3] `packages/core/src/status/status.ts:35–55`：执行阶段查询只返回 executionView，prepared 查询返回冻结 preview。SHA-256：`2ec341c7c05445bccd9ed3799d1e2ae93fbb05870cce00b3902f41130640b6c4`。
- [S4] `packages/core/src/publish/prepare.ts:70–126`：验证目标、冻结内容、prepare 开始时间加 900000ms，以及保存 intent。SHA-256：`51acf4fc2f64d7d3032d26b1d133c6d6c5c07d46481ca2595835ec4bbc7471a0`。
- [S5] `packages/core/src/publish/executor.ts:33–137`：逐目标执行、claim、60000ms 调用超时、unknown 和可靠性错误。SHA-256：`1b8e53c90cc1261665fbb24a1d4cf1c56356d6100271197ec067135cf07edf32`。
- [S6] `packages/cli/src/render/envelope.ts:37–43, 109–170`：静态安全错误与退出码映射；verbose 不能据此放开原始异常。SHA-256：`644373cc0fd390f0a4c0e792fff01dbf1ccd73795a940e0837a7f74b26ac1a4a`。
- [S7] `AGENTS.md:85–119, 139–153, 157–161, 199–219`：冻结输入、重试边界、共享状态契约、敏感信息限制和旧 --yes 文档约束。SHA-256：`762c55e6bc1200e511b2c308647d0810dc0ad93a313f7e9a8853cb39d71838d6`。
- [S8] `packages/core/src/domain/records.ts:51–108`：已有 ConnectionRecord、FrozenTarget 与内部 DeliveryRecord.state，可复用而非另建数据存储。SHA-256：`fc564f7ef473b22929b1a1abfa00f70323157ed84e67de4710d04059822efb5e`。

### 本轮交付边界

Q1–Q11 选择已全部纳入。设计与安全边界由主模型整理，没有启动实现子代理，也没有模型替代。本轮仅只读核对仓库并生成会话设计附件；没有修改仓库代码、提交、部署、迁移、发送真实帖子或调用外部付费模型任务。仓库观察到的既有未跟踪 `notes/` 未处理。

该文件是待审核的设计，不是已经通过产品测试的实现。整体设计审核通过后，再生成实现计划并选择执行方式。任何新增的安全／并发实现都必须用上述隔离测试提供证据，不以本次静态检查代替执行验证。
