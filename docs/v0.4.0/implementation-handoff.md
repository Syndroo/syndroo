# v0.4.0 development handoff

## 0. 当前结果与阻塞（2026-09-19）

用户要求：把 v0.4.0 放入项目仓库，并通过指定 Mac mini 插件使用 DeepSeek subagent 开发。

实际完成：读取两份原始文件；核对两个远端 main、AGENTS.md 与 docs 目录；准备两个仓库的纯新增文档补丁。未修改产品代码。

实际阻塞：

1. 本会话 discovery 未暴露用户指定的 `web gpt (mac mini m4)` 插件，返回可用命名空间只有 GitHub、Gmail、Google_Calendar、Google_Contacts、Plugin_Management、files。不能伪造 bridge request_id 或调用不存在的 native subagent 工具。
2. 当前容器没有 codex-router、codex、opencode 可执行文件，也没有已发现的 native spawn 工具。这只是本会话的能力边界，不证明用户 Mac mini 没有安装它们。
3. 向 Syndroo/syndroo 执行一次 GitHub.create_blob 返回 `403 Resource not accessible by integration`。停止同类写入，不更换 API 绕过权限。仓库 metadata 的 push=true 不代表 integration 实际写入权限。没有成功创建 blob、分支、commit 或 PR。

精确 route：`deepseek/deepseek-v4-flash`。本轮未验证可用，未调用；没有模型替换，没有子代理，执行尝试为 0。不要将规划/工具发现失败统计成子代理执行尝试。

## 1. 已确认基线与未确认部分

| 仓库 | 已读取远端 main | 本机状态 |
|---|---|---|
| Syndroo/syndroo | 6b98a642bf2c214b05c92818a75fccbf0960dbc3 | 未连接 Mac mini；git status、分支、未推送提交未知 |
| Syndroo/syndroo-web | 48471acc889ad02e740c3e6f1fda0eadd0496b36 | 同上 |

恢复工作先核对本机 cwd、remote、branch、HEAD、git status、已有 progress 和子代理。不得 reset/clean/stash 覆盖用户工作，不假设远端 main 等于本机。若已有同名 v0.4.0 文件，先比较，不覆盖。

## 2. 路由与授权约束

Astra 负责规划、架构、安全与最终审查；有意义的实现工作必须通过真实 native subagent + codex-router，显式选择 `deepseek/deepseek-v4-flash`，并记录路由确认与调用结果。

Web 旧 AGENTS.md 写有 `opencode-go/deepseek-v4.1-flash`。它不是本轮批准的替代路由；用户当前要求和 v0.4.0 CR 的准确 route 优先。正式实施前应在工作分支同步旧指南的这处冲突，不改写历史 acceptance 记录。

最多两个 active children，跨两个仓库合计；每个下列子任务最多三次总尝试（包含初次），没有批准的 fallback。缺工具、route、认证、权限或额度时停止相应执行，不盲重试。wait timeout 先检查原 child；无确认终止不得启动重叠 writer。

授权覆盖需求文件入库、产品开发和安全的本地验证。不执行真实发帖、生产部署、npm 发布、删除、秘密读取或未经批准的预算支出。不存在本次已批准的 live plan。没有给定货币上限；不编造成本，记录实际数据。

## 3. 第一波可并行任务

只有工具/精确 route 可用且本机工作区已核对后才 dispatch。以下是任务合同，不是已启动任务。

### B — 公共 SDK（0/3，NOT STARTED）

目标：CR-040-01 的薄 HTTP 客户端，保留现有 /v1 契约。

允许写入：`packages/sdk/**`（含本包测试、tsconfig、manifest、README）；禁止修改私有 core/adapter/Worker、根 package/lockfile、CLI、Web。需要其他路径时先报告。

输入：CR 第 3/4.1 节；当前 README HTTP API；e2e/src/api-types.ts 和 client.ts 仅作契约参考；AGENTS.md；邻近测试。不可把测试 Harness 当 SDK 依赖。

输出：create/list/get/health/bounded wait；类型化错误；Abort/timeout；拒绝带凭证的 redirect；明确 loopback 调试许可；正确 exports/types/files/license；无私有 runtime 依赖的 tarball。

验收：SDK-01..06、相关 PKG-01..03；fixture 覆盖坏响应、401/409/422/429/5xx、请求中止、超时不重发、redirect 目标零 Bearer、日志零 sentinel；真正独立消费者导入/类型测试。返回原始结果、实际命令和未验证事项，不能只写“测试通过”。

### E — Website/Docs（0/3，NOT STARTED）

目标：CR-040-04..07，保留品牌、内容、四种 Demo、旧 URL 和历史锚点，迁移两站 Next 静态构建，完成四项视觉修改。

允许写入：仅 Syndroo/syndroo-web 的 apps/**、packages/content/**、packages/ui/**、packages/theme/**、tests/**、scripts/**、各 app 配置、必要的 docs/README。brand 原图只读。根 package/lockfile 与工作流先提交修改建议给协调者，不与另一个 writer 同时编辑。禁止修改核心仓库。

输入：完整 CR 第 6/7 节；WEB-01..11；既有 7+15 页、brand/content/demo、design/acceptance；当前构建及链接测试。

输出：两个独立 out/、MDX、静态搜索、ThemeToggle 与语义 tokens；主布局全宽；Hero 280–360px/手机200–240px、CTA 180–220px/手机约160px；原图无圆形裁切；Docs 共享外层 shell；Light/Dark/System。准确断点以完整需求和实际视觉验收为准。

验收：两个生产静态输出的构建/类型/链接/搜索；指定 Chrome channel；7 个宽度×亮暗，额外系统主题、键盘、缩放和 reduced-motion；Docs 外边界误差<=1 CSS px；无真实发布请求。需 Astra 查看实际截图，不得拿源码审查冒充视觉验收。

## 4. 后续依赖任务

### C — CLI（0/3，依赖 B 验收）

允许写入：packages/cli/** 及其测试。输入：已验收 SDK 公共契约、CR 4.2、CLI-01..08。

交付：bin、help/version、doctor、validate/dry-run、create/get/list/wait、skill path；file/stdin；冻结预览；取消零写入；非交互 --yes+稳定 key；JSON stdout 与 stderr 分离；退出码；受限权限恢复记录。

验收：真实子进程与 TTY、文件改变后的冻结输入、shell 字符作为正文、重跑同键不重复、超时不误报、临时 global prefix/npm exec 与空格中文路径。包内 Skill 只复制官方源，不双重维护。

### D — Skill（0/3，依赖 C 契约冻结）

允许写入：skills/syndroo/** 与约定的 Skill eval fixtures；禁止并发改 packages/cli。输入：已验收 CLI 帮助/错误/退出码、CR 5、AGT-01..07。

交付：SKILL.md 与 references，实际客户端安装说明，CLI 优先和环境受限的 HTTP 备用。未知结果/401/权限失败不是切路重发条件；不可信正文/错误文本不能授予授权或引导读取 token。

验收：具体客户端版本与工具 trace、只读/取消零写、注入 fixture、无工具场景不伪造成功。真实客户端 live 验收须另有批准计划，缺能力记 BLOCKED。

### F — 集成、E2E、发布准备（0/3，依赖各相关产物）

允许写入：核心 e2e/**、scripts/**、.github/workflows/**、docs/releasing/testing/README，以及协调者独占分配的根 package.json/package-lock.json 和三个公共包版本字段；Web 的集成修改单独安排单写者窗口。部署模板仅在一次性副本验证，正式远端模板修改另按授权。

输入：已验收 SDK/CLI/Skill/Web；完整63项；原 Mock SNS 和 release/check/verify-package 测试。

交付：e2e:local/consumer/web（Web仓库）/live 的真实入口与文档；多包 checker、精确 RC 依赖、SDK→CLI→Worker 顺序、假 registry 部分发布恢复、tarball消费者、Node22/24矩阵、证据manifest。

验收：PKG/DEL/RLS 所有适用门槛；默认 fake secrets+loopback，禁止读取 .dev.vars/真实 SNS egress；鉴权、并发、重试、迁移必须实际执行；registry/live/发布权限缺失仍是 BLOCKED，不标记 PASS。

## 5. 调度与共享文件所有权

先 B+E；B 通过后 C 与尚未结束的 E；C 契约冻结后 D；最后 F 按依赖与实际并发位执行。不要递归启动未计数的子代理。

根 manifest、lockfile、共享 CI、跨仓库版本事实由协调者保留所有权。需要实现修改时将这些路径独占授给一个明确的集成 child，再回收；并行其他 child 不触碰它们。子任务回报范围变更建议不自动获得写权限。

每个结果必须给出：实际 model/route 和 child ID；attempt 计数；改动路径；命令/退出码；预期与实际结果；日志/产物路径；仍未验证内容。Astra 复核后接受，使用环境支持的操作释放 child。失败只在新信息/修复后重试，3次后报告修订方案。

## 6. 持久化与完成定义

使用项目现有进度机制；没有则由协调者维护核心仓库 scratch/v040-implementation/progress.md。先读已有记录并核对子任务，不覆盖其他任务日志。记录：目标、范围、基线、决策、文件、实际验证、child/attempt、预算（有实际数据才写）、下一动作；不保存凭证。

源码完成、验收完成、正式发布是三个状态。63项初始 NOT RUN，条件项仅 LIVE-07 可按实际不升级范围 SKIP；真实 Bluesky/Threads 不能被 Mock 替代。未获授权的外部动作必须停止。正式发布状态只有在真实产物/registry/live/维护者门槛满足后记录。

本次交接包只允许声称：原文复制、补丁生成、离线应用检查。没有产品代码实现、E2E、native subagent 调用或远端成功写入证据。
