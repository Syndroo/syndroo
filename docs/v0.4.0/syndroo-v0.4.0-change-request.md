# Syndroo v0.4.0 变更请求与方案设计

恢复来源：<https://chatgpt.com/share/6aaf3f4c-fe40-83ee-a165-ae2c3f6844af>（会话标题「网站框架与CLI建议」）

日期：2026-09-19（Asia/Tokyo）。

基线快照：`Syndroo/syndroo` = `6b98a642bf2c214b05c92818a75fccbf0960dbc3`，`Syndroo/syndroo-web` = `48471acc889ad02e740c3e6f1fda0eadd0496b36`。

> **恢复说明。** 原始 `syndroo-v0.4.0-change-request.md` 只存在于共享会话的沙箱目录 `/mnt/data/syndroo-v040/`，文件字节未随分享链接导出。本文件由共享对话恢复：第 4 至第 9 节的设计文字逐字取自该会话助手回复；第 1 至第 3、第 10 至第 12 节是依据同一会话内容整理的结构化索引。凡原文无法逐字核对之处均标注「推导」。逐字原文另见 `recovered/conversation-design-source.md`。本文不构成任何已实现、已测试或已发布的声明。

## 1. 版本目标

> 用户不需要克隆 Syndroo 源码，就能安装发布包，通过 SDK、CLI 或 Skill 完成首次发布，并判断每个平台的真实结果。

v0.4.0 不只是「把包上传 npm」，还要验证用户消费发布产物的路径，而不是开发者运行源码的路径。

v0.3.0 的结项描述保持为：**主要实现已完成，已有本地自动化验证记录；浏览器与真实发布验收未闭环。** SDK、CLI、Skill 与网站框架迁移属于 v0.4.0 新增范围，不算 v0.3.0 漏做。

## 2. 交付物与包边界

| 交付物 | v0.4.0 职责 | 状态 |
|---|---|---|
| `@syndroo/cloudflare-worker` | 部署和运行 Syndroo 服务，保留现有 `syndroo-deploy` | 已存在 |
| `@syndroo/sdk` | 新增公共 TypeScript HTTP 客户端，供应用和 CLI 调用 | 建议新增 |
| `@syndroo/cli` | 新增 `syndroo` 命令，服务终端、脚本、CI 与 Agent 用户 | 建议新增 |
| 官方 Syndroo Skill | 随 CLI 包提供固定版本的 Skill 文件 | 建议新增 |

首轮三个公共包统一使用 `0.4.0`。私有 core、adapter 与网站 workspace 不需要为了整齐全部改版本。

`@syndroo/core` 当前是 `private: true`，不因需要 SDK 而公开。领域模型和内部执行接口不等于应当向用户长期承诺兼容性的客户端接口。公共 SDK 与 CLI 目前不存在；公共 SDK 必须是轻量 HTTP 客户端，不把 Wrangler、D1、队列实现和各平台 SDK 带进用户应用。

Agent 路径固定为：

```text
Agent + Syndroo Skill -> Syndroo CLI -> Syndroo SDK -> Syndroo HTTP API -> Worker
```

直接 HTTP 是接入能力不足时的备用入口，不是 CLI 失败后的重发通道。

## 3. 变更清单

| ID | 变更 | 主要门槛 |
|---|---|---|
| CR-040-01 | 新增公共 SDK（薄 HTTP 客户端，保留现有 `/v1` 契约） | SDK-01..06、PKG-01..03 |
| CR-040-02 | 新增 CLI，成为正式产品入口 | CLI-01..08 |
| CR-040-03 | 新增 Syndroo Skill（CLI 优先，HTTP 备用） | AGT-01..07 |
| CR-040-04 | Website / Docs 迁移到 Next.js + shadcn/ui（Docs 加 MDX），两站独立静态导出 | WEB-01、WEB-02 |
| CR-040-05 | Website 主布局全宽，取消 `1160px` 整体上限 | WEB-03 |
| CR-040-06 | Hero / CTA 吉祥物放大并去掉图片本身的圆形裁切 | WEB-04 |
| CR-040-07 | Docs 统一外层 shell，并新增 Light / Dark / System 主题切换 | WEB-05、WEB-08、WEB-09 |
| CR-040-08 | 多包 npm 发布：版本校验、打包验证、发布顺序与失败恢复 | RLS-01..06 |

（CR 编号与门槛映射为推导，依据会话中出现的 `CR-040-01`..`CR-040-08` 断言列表、「CR 第 3/4.1 节」「CR 4.2」「CR 5」「CR 第 6/7 节」引用，以及 63 项清单分组。）

本版不额外扩展 Dashboard、多账号、OAuth 代管、媒体、完整 MCP server 或新的服务端审批系统。

## 4. SDK 设计（CR-040-01）

正常路径：准备一个 Syndroo 实例，获得实例地址和 API key，安装 SDK，创建发布任务，查询交付结果。

```ts
import { SyndrooClient } from "@syndroo/sdk";

const syndroo = new SyndrooClient({
  baseUrl: process.env.SYNDROO_BASE_URL!,
  apiKey: process.env.SYNDROO_API_KEY!,
});

const receipt = await syndroo.posts.create(
  { content: "We just shipped a new release.", platforms: ["bluesky"] },
  { idempotencyKey: "release-announcement-001" },
);

const post = await syndroo.posts.get(receipt.id);
```

请求字段与 `receipt.id` 与当前 HTTP 契约一致；新设计的是 `SyndrooClient` 及其方法封装。仓库里已有的测试专用 HTTP client 只作契约参考，不能原样当成公共 SDK 发布。

首版只覆盖创建、列表、详情、健康检查，以及有超时上限的状态轮询。不得为「SDK 完整」提前加入服务端尚不存在的功能。两个边界必须在文档中讲清楚：

1. **创建成功不等于已经发布成功。** 创建接口返回受理结果，最终结果看各平台 Publication；不得把 `202` 受理回执表现成已交付。
2. **SDK 默认面向可信执行环境。** API key 留在服务端、CLI 或 CI 凭据环境，不放进静态网页或 `NEXT_PUBLIC_*`。平台 token 继续由 Syndroo 服务端管理。

## 5. CLI 设计（CR-040-02）

```text
终端用户 / Shell / CI -> @syndroo/cli -> @syndroo/sdk -> Syndroo HTTP API
```

CLI 和 SDK 不各维护一套鉴权、错误处理与轮询逻辑。首版命令保持小而完整：

```bash
syndroo doctor
syndroo posts validate --file post.json
syndroo posts create --file post.json
syndroo posts list
syndroo posts get <post-id>
syndroo posts wait <post-id> --timeout 60s
```

Agent 与 CI 使用同一套命令，但需要机器可读模式：

```bash
syndroo posts create \
  --file post.json \
  --idempotency-key release-announcement-001 \
  --json \
  --yes
```

契约要求：输入支持文件与 stdin；`--json` 下 stdout 只输出结构化结果、诊断进 stderr；非交互运行不允许无限等待输入；退出码区分命令失败、已受理、等待超时和交付异常；定时发布时间提交给服务端，不依赖本地电脑持续开机；结果不明确时明确报告，不自动生成新任务重发。

「本地 CLI」不等于「本地运行整套发布引擎」。首版是本地客户端，连接已部署的 Syndroo，不纳入 Docker runtime、离线队列或本地守护进程。`syndroo-deploy` 继续承担部署职责，不强行合并。

## 6. Skill 设计（CR-040-03）

Skill 负责教 Agent 怎么完成任务；CLI 提供确定性操作接口；API 提供服务端能力。

```text
skills/syndroo/
├── SKILL.md
└── references/
    ├── cli.md
    ├── http-fallback.md
    └── delivery-semantics.md
```

首个 Skill 负责：检查 CLI 与实例配置，整理各平台正文，展示目标平台和定时时间，在授权范围内提交确定的内容，然后查询结果并解释部分失败或不明确结果。

| 环境或结果 | 行为 |
|---|---|
| 支持 Skill 且可执行 CLI | 默认走 Skill → CLI |
| 无法执行 CLI，但有获授权的 HTTP 工具 | 使用同一工作流走 HTTP 备用入口 |
| 既不能执行 CLI，也没有 HTTP 工具 | 报告环境缺口，不声称能够发布 |
| CLI 返回鉴权或权限错误 | 停止并修复配置，不换入口绕过限制 |
| 提交超时或交付结果不明确 | 按幂等与结果查询规则处理，不直接换 API 重发 |

安全边界：Skill 里的「先确认」和 CLI 的 `--yes` 都不是服务端权限机制。凭据权限、输入校验和幂等保护必须由确定性代码承担。客户端兼容表按实际验证结果维护，不因某客户端支持 Skill 就宣称它能安装 CLI、访问用户本地网络或取得凭据。

## 7. Website / Docs 设计（CR-040-04..07）

### 7.1 框架迁移与静态交付

两站使用 Next.js App Router + TypeScript + Tailwind + shadcn/ui，Docs 加 MDX，分别静态导出，继续作为两个独立站点托管在现有 Cloudflare Pages 项目与域名。

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
```

迁移保留边界：文档搜索使用静态索引；不依赖 Server Actions、请求时鉴权或动态服务端路由；图片不依赖默认的服务端优化接口。本次迁移实现方式，不重做品牌与页面结构，Logo、吉祥物、内容事实、历史链接和锚点全部保留。

### 7.2 Website 主布局全宽

当前 `.wrap` 的 `max-width: 1160px` 把主布局限制在居中窄容器。新规格要求 Header、主要 section 和 footer 的主布局都随视口扩展，不只是背景铺满屏幕：

```css
.site-shell {
  width: 100%;
  max-width: none;
  padding-inline: clamp(20px, 3vw, 64px);
  box-sizing: border-box;
}
```

网站全宽不意味着每段文字横向铺满显示器。Hero 网格、卡片和展示区域使用全屏；说明段落与博客文章保留合理行长。不得把 `1160px` 换成另一个固定最大宽度就称为完成全宽改造。

### 7.3 吉祥物尺寸与裁切

旧规格把 Hero 吉祥物定位为 144–180px 辅助点缀，结尾约 96px；当前源码是 Hero `160px`、CTA `96px`，并且给 `.demo__mascot` 图片本身加了 `border-radius: 50%`。需要一起调整角色定位、空间与裁切方式。

| 位置 | 桌面 | 手机 |
|---|---:|---:|
| Hero 吉祥物 | 280–360px，先以 320px 布局 | 200–240px |
| 结尾 CTA 吉祥物 | 180–220px | 约 160px |

吉祥物从 Demo 标题旁的小头像位置移到 Hero 品牌视觉区域，获得真实布局空间。原图完整展示：耳朵、尾巴、手脚都不能被圆形框或祖先容器裁掉；背景光晕保留为图片后方的独立装饰层，不是图片上的圆形蒙版；不为此重画袋鼠。

### 7.4 Docs 外层对齐

```text
Header inner ──────────────────────────┐
                                     │ 同一外层边界和 gutter
Sidebar | Article | TOC ───────────────┤
                                     │
Footer inner ──────────────────────────┘
```

Header、main 和站点 footer 共用同一套外层宽度、边距与断点，不各自定义不同 `max-width` 与 padding；文章列保持约 70–80ch 阅读宽度。验收标准量化：同一视口下 header/main/footer 左右外边界误差不超过 **1 CSS px**，并检查 Overview、Quickstart、API 和平台指南，不只修首页。

### 7.5 Light / Dark / System

两站 header 都放可见主题切换入口，桌面与手机可用，Light / Dark / System 默认 System。技术上采用共享主题组件与语义颜色变量，通过 `next-themes` 接入。

验收不止「点击后背景变黑」，还要覆盖搜索弹窗、移动导航、代码块、表格、状态提示、按钮和焦点样式，并检查刷新后的记忆、系统主题变化与首屏闪烁。官网与 docs 是不同 origin，同名 localStorage 不会跨站共享；正式域名使用只保存主题值的父域 cookie（`Domain=syndroo.com`），本地和独立预览域按各站保存，不共享任何凭证。

### 7.6 文档结构

```text
Agent / Skill -> 安装、环境检查、预览、授权、发布、查结果
CLI           -> 安装、配置、首次发布、JSON 输出、错误处理
SDK           -> 安装、初始化、创建任务、幂等、查询结果
```

HTTP API Reference 保持完整，但不再让所有人先读 HTTP 请求示例。部署指南回答「如何获得一个实例」，与「如何使用实例」分开。新增 Packages overview 说明哪个包用于部署、哪个用于调用、哪个提供终端命令，以及兼容版本与最低运行环境。所有入口落到同一条验收路径：新用户按文档操作，能完成一次单平台发布，并判断任务究竟是已受理、已交付、失败，还是结果尚不明确。

## 8. 发布与打包（CR-040-08）

现有 release workflow 只发布 `@syndroo/cloudflare-worker`。新增 SDK、CLI 后必须同步修改版本校验、打包验证、发布顺序和失败恢复逻辑，不能只加两个目录。

| 阶段 | 要完成的事情 |
|---|---|
| 1. 本地候选准备 | 三个包的构建、类型、单元测试、Mock E2E、打包检查和独立消费者测试通过，记录提交与产物 hash |
| 2. 发布 RC | 将 `0.4.0-rc.1`（候选序列写作 `0.4.0-rc.N`）发布到 `next`；顺序 SDK → CLI → Worker |
| 3. 维护者本机验收 | 从 npm 安装精确 RC 版本，执行 CLI/SDK、真实测试账号、Agent 与浏览器验收 |
| 4. 修复与重新候选 | 有问题发布 `rc.2`，保留失败记录，重跑受影响的验收 |
| 5. 准备正式产物 | 改到 `0.4.0`，同步 CLI 的 SDK 依赖与 lockfile，重新打包并验证最终产物 |
| 6. 正式发布与收尾 | 发布三个正式包，从 registry 验证安装、版本与依赖，更新模板、Docs、官网与 GitHub Release |

两条硬规则：

1. 不能把 `0.4.0-rc.1` 的 dist-tag 改成 `latest` 就当作发布了 `0.4.0`。dist-tag 是安装别名，不改变包内版本号。
2. npm 同名同版本不能覆盖。发布后发现问题应发布新 RC 或 `0.4.1`，不能依赖删除后重传。

发布认证继续使用 npm Trusted Publishing，但分别确认三个包的权限与配置。本机用于 E2E，CI 用于受审批的发布；本机登录成功不证明 CI OIDC 已配置正确。三个包的发布不是原子操作，方案要求测试「SDK 已发布、CLI 发布失败」的恢复路径：核对已发布产物、停止错误的成功公告，不盲目重传。

## 9. 本机 E2E 与验收分层

本机 E2E 不等于全部服务都必须运行在本机，分三层：

| 层级 | 测试链路 | 证明什么 |
|---|---|---|
| L1 本地 Mock | Worker bundle → 本地 D1/Queue/Cron → 真实 adapter → Mock SNS | 内部交付、幂等、故障与并发逻辑正确 |
| L2 安装产物 | 空目录安装 tarball/npm RC → 真正的 SDK/CLI → L1 | 用户安装到的包可以工作，不依赖源码 workspace |
| L3 真实账号 | 本机 SDK/CLI/Agent → staging Worker → 真实 SNS 测试账号 | 真实凭证、平台接口和最终远端帖子成立 |

已有 Mock SNS E2E 使用 bundled Worker、D1、Queue、scheduled handler 和真实 adapter，只替换 SNS 网络边界，应当扩展复用而不是推倒重写。L1/L2 通过不能替代 L3；L3 成功不能替代并发与故障注入。

当前已有命令：核心仓库 `npm ci`、`npm test`、`npm run check`、`npm run test:e2e`、`npm run verify:package`；Web 仓库 `npm ci`、`npm run build`、`npm run check`、`npm test`。下列是 v0.4.0 待新增入口，目前不存在，不要直接复制执行：

```bash
npm run e2e:local
npm run e2e:consumer -- --source tarball --version 0.4.0-rc.1
npm run e2e:consumer -- --source registry --version 0.4.0-rc.1
npm run e2e:web -- --project=chrome
npm run e2e:live -- --plan /absolute/path/to/approved-live-plan.json
```

63 项测试按组分布：包与安装 8、SDK 6、CLI 8、交付可靠性 10、Agent Skill 7、Website/Docs 11、真实平台 7、Release 6。其中 62 项必选（P0），1 项条件项（LIVE-07，仅当本版提升 X / Tumblr / LinkedIn 验证级别时触发）。完整清单见 [syndroo-v0.4.0-local-e2e-checklist.md](syndroo-v0.4.0-local-e2e-checklist.md)。

最需要重点盯住的行为：重复发布风险；结果不明确时不得换键或换入口重发；确认与实际发送必须一致；必须真的从 npm 包开始（不用 `npm link` 或源码相对路径）；浏览器验收必须覆盖 360/390/768/1280/1440/1920/2560 CSS px × Light/Dark，外加 System、200% 缩放、reduced-motion，Playwright 使用 `channel: "chrome"`，Safari 另做冒烟。

真实平台的发布门槛不降低：Bluesky 与 Threads 的真实账号验证是正式发布门槛，不能用 Mock 替代，缺账号或权限时记 BLOCKED。真实测试使用 staging 与明确批准的测试文案；失败注入、刷限流、并发压力放在本地 Mock 环境。

## 10. 实施顺序与路由

主线：**SDK → CLI → Skill → 安装产物 E2E → 真实账号验收 → 正式 release。** Web 的 Next.js 迁移与四项视觉修改作为独立工作流推进，最终一起进入 v0.4.0 验收。

第一波可并行：SDK（`packages/sdk/**`）与 Website/Docs（仅 syndroo-web）。CLI 依赖已验收的 SDK 公共契约，Skill 依赖 CLI 契约冻结，集成与发布准备最后执行。

约束：最多两个 active children（跨两个仓库合计）；每个子任务最多三次总尝试（含初次）；无批准的 fallback 路由；精确路由为 `deepseek/deepseek-v4-flash`，旧指南中的 `opencode-go/deepseek-v4.1-flash` 不是本轮批准路由，实施前在工作分支同步该冲突。

## 11. 安全与授权边界

- 授权覆盖需求文件入库、产品开发与安全的本地验证；不执行真实发帖、生产部署、npm 发布、删除、秘密读取或未经批准的预算支出。
- 默认自动测试只使用 fake secrets 与 loopback；不读真实 `.dev.vars`，不允许公网 SNS egress。
- 测试素材里的指令不构成授权；live plan 必须明确实例、账号、正文、平台、绝对时间、操作数量、停止条件与授权人。
- 不保存 Token、Authorization、Cookie、敏感 Prompt 或原始环境文件。

## 12. 当前状态

本文件是设计产物与开发交接输入。共享会话中没有创建远端分支、commit 或 PR：GitHub 写入返回 `403 Resource not accessible by integration`，Mac mini 插件与 native subagent 工具未向该会话暴露，`deepseek/deepseek-v4-flash` 调用次数为 0。产品实现、产品 E2E、npm 发布、部署与真实发帖均未执行。
