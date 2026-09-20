# 共享对话原文（v0.4.0 设计来源）

来源：<https://chatgpt.com/share/6aaf3f4c-fe40-83ee-a165-ae2c3f6844af>

以下内容逐字取自该分享对话的助手回复，未改写、未翻译。它们是从该对话可恢复的 v0.4.0 设计原文。
原始交付文件（change-request / checklist 的沙箱版、repository-handoff.zip 与两个 git patch）不在分享链接中，无法取回。

## 架构建议：SDK / CLI / Skill / Website 与 Docs（对话消息 #43，text）

**你的判断是对的：现在需要补的，不只是网站框架，而是 SDK、CLI、Skill 这套面向使用者的完整入口。**

核对两个仓库后，我的建议是：**website/docs 改用 Next.js + shadcn 静态构建；新增独立 SDK 和 CLI；Agent 默认通过 Skill 使用 CLI，直接调用 HTTP API 作为备用接入方式。**

其中需要澄清两点：目前“不使用框架”确实是写进设计约束的选择；现有 npm package 则是 **Worker 运行时，而不是用户调用 Syndroo 的客户端 SDK**。fileciteturn4file0L2-L2 fileciteturn5file0L2-L2

## 1. 网站不使用框架，是有意的，但不必继续坚持

当前 `syndroo-web` 的设计明确要求：使用 Node 内置 TypeScript type stripping 构建，不需要框架或编译器依赖；页面手写 HTML/CSS，再由脚本生成公共布局、资源和站点文件。README 甚至说明，`npm run dev` **不监听文件变化**，修改后需要重新构建。fileciteturn4file0L2-L2 fileciteturn3file0L2-L2

所以，这不是“忘了安装框架”，而是当前方案选择了零构建依赖。

但我认为，这个约束现在不值得保留。我们真正需要的是：

> **部署简单、输出静态文件、页面加载轻量，而不是开发时完全不用框架。**

现在已经需要自己维护导航注入、页面注册、搜索、公共布局和链接检查。我的判断是，继续坚持无框架，会把时间花在网站基础设施上，而不是 Syndroo 产品本身。

### 建议采用的组合

| 部分 | 建议 |
|---|---|
| Website | Next.js App Router + TypeScript + Tailwind + shadcn/ui |
| Docs | Next.js + MDX，复用品牌样式和必要的 shadcn 组件 |
| 构建输出 | 两个应用分别静态导出 |
| 托管 | 保留两个 Cloudflare Pages 项目和当前域名 |
| 共享内容 | 保留 `packages/content`、`packages/brand`，按实际复用需求增加 UI 组件 |

Next.js 支持通过 `output: "export"` 输出静态 HTML/CSS/JS；shadcn 有官方 Next.js 集成方式，Next.js 也有官方 MDX 支持。它们与静态部署并不冲突。citeturn831093view0turn831093view1turn153910view0

核心配置可以很简单：

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
```

Cloudflare Pages 可以直接构建和托管这种静态输出，不需要为了官网、文档引入一个 Next.js 服务端运行时。citeturn317886view0

迁移时应明确保留以下边界：文档搜索使用静态索引；不依赖 Server Actions、请求时鉴权或动态服务端路由；图片不依赖默认的服务端优化接口。静态导出对这些能力有明确限制。citeturn831093view0

**这次应当迁移实现方式，而不是顺便再重做一遍品牌和页面结构。** 现有 Logo、吉祥物、内容事实、历史链接和锚点都应保留。

## 2. 当前 npm package 不是 SDK，确实需要新增

目前的 `@syndroo/cloudflare-worker` 包提供 Worker 入口、D1 migrations 和 `syndroo-deploy`。它的直接使用方式是：

```ts
export { default } from "@syndroo/cloudflare-worker";
```

这是把 Syndroo **部署成服务**，不是从用户应用里调用 Syndroo。包内 README 也推荐用户通过部署模板使用它。fileciteturn6file0L2-L2

此外，`@syndroo/core` 当前是 `private: true`，不应因为需要 SDK 就直接把它公开。领域模型和内部执行接口，不等于应该向用户长期承诺兼容性的客户端接口。fileciteturn9file0L2-L2

我建议明确划分：

| 交付物 | 用途 | 状态 |
|---|---|---|
| `@syndroo/cloudflare-worker` | 部署、运行 Syndroo 服务 | 已存在 |
| `@syndroo/sdk` | 在 JavaScript/TypeScript 应用中调用 Syndroo | 建议新增 |
| `@syndroo/cli` | 在终端、脚本、CI、Agent 环境中操作 Syndroo | 建议新增 |
| Syndroo Skill | 指导 Agent 正确使用 CLI，必要时回退到 HTTP | 建议新增 |

这里的 SDK 应是一个**轻量 HTTP 客户端**，不应把 Wrangler、D1、队列实现和各平台 SDK 一起带进用户应用。

### 用户之后如何使用 SDK

正常路径应当是：

**先准备一个 Syndroo 实例 → 获得实例地址和 API key → 安装 SDK → 创建发布任务 → 查询交付结果。**

下面是建议采用的接口形态，**不是当前已经发布、可以安装的 SDK**：

```bash
npm install @syndroo/sdk
```

```ts
import { SyndrooClient } from "@syndroo/sdk";

const { SYNDROO_BASE_URL, SYNDROO_API_KEY } = process.env;

if (!SYNDROO_BASE_URL || !SYNDROO_API_KEY) {
  throw new Error("Missing Syndroo instance URL or API key");
}

const syndroo = new SyndrooClient({
  baseUrl: SYNDROO_BASE_URL,
  apiKey: SYNDROO_API_KEY,
});

const receipt = await syndroo.posts.create(
  {
    content: "We just shipped a new release.",
    platforms: ["bluesky"],
  },
  {
    idempotencyKey: "release-announcement-001",
  },
);

const post = await syndroo.posts.get(receipt.id);

console.log(post.status);
console.log(post.publications);
```

这里的请求字段和 `receipt.id` 与当前 HTTP 契约一致；新设计的是 `SyndrooClient` 及其方法封装。仓库里已有一个测试专用 HTTP client 可以作为契约参考，但它依赖测试 Harness，不能原样当成公共 SDK 发布。fileciteturn8file0L2-L2 fileciteturn10file0L2-L2

SDK 首版只需要覆盖创建、列表、详情、健康检查，以及有超时上限的状态轮询。不要为了“SDK 完整”提前加入服务端尚不存在的功能。

文档还必须讲清楚两个边界：

**创建成功不等于已经发布成功。** 创建接口返回的是任务受理结果，最终结果需要查看各平台 Publication；当前设计也明确禁止把 `202` 受理回执表现成已交付。fileciteturn4file0L2-L2

**SDK 默认面向可信执行环境。** API key 应保留在服务端、CLI 或 CI 的凭据环境中，不应放入静态网页或 `NEXT_PUBLIC_*` 配置。平台自身的 token 继续由 Syndroo 服务端管理。

## 3. CLI 应成为正式产品入口，而不是附带脚本

我赞成你把本地 CLI 用户纳入核心用户群。CLI 不应该只是为了让 Agent 有命令可调；人类用户也应该能够独立完成发布、定时和结果检查。

建议的关系是：

```text
终端用户 / Shell / CI
          ↓
     @syndroo/cli
          ↓
     @syndroo/sdk
          ↓
    Syndroo HTTP API
```

这样 CLI 和 SDK 不会各维护一套鉴权、错误处理与轮询逻辑。

### 首版命令保持小而完整

以下同样是**拟定命令**：

```bash
# 检查实例地址、连通性和鉴权配置，不输出密钥
syndroo doctor

# 只做本地输入校验，不创建任务
syndroo posts validate --file post.json

# 创建任务；交互环境展示摘要并请求确认
syndroo posts create --file post.json

# 查询任务
syndroo posts list
syndroo posts get <post-id>

# 有上限地等待交付结果，只查询，不重新提交
syndroo posts wait <post-id> --timeout 60s
```

Agent 和 CI 使用同一套命令，但需要机器可读模式，例如：

```bash
# 仅用于已获得发布授权的流程
syndroo posts create \
  --file post.json \
  --idempotency-key release-announcement-001 \
  --json \
  --yes
```

关键不是命令数量，而是以下契约：

| 方面 | 应有的行为 |
|---|---|
| 输入 | 支持文件和 stdin，避免把复杂正文拼进 shell 命令 |
| 输出 | `--json` 下 stdout 只输出结构化结果；诊断信息进入 stderr |
| 非交互运行 | 不允许无限等待输入；缺少必要确认时明确失败 |
| 退出码 | 区分命令失败、已受理、等待超时和交付异常 |
| 定时发布 | 把时间提交给服务端，不依赖本地电脑持续开机 |
| 结果不明确 | 明确报告，不自动生成新任务重发 |

另外，**“本地 CLI”不等于“本地运行整套发布引擎”**。首版是在本地运行客户端，连接已部署的 Syndroo；不需要因此把 Docker runtime、离线队列或本地守护进程一起纳入范围。

现有 `syndroo-deploy` 则继续承担部署职责，先不强行合并，避免发布内容的用户被迫安装整套部署工具。

## 4. Skill 优先是正确方向，但 Skill 和 API 不是替代关系

我建议把默认 Agent 路径明确为：

```text
用户表达意图
    ↓
Syndroo Skill
    ↓
Syndroo CLI
    ↓
Syndroo SDK
    ↓
Syndroo HTTP API
    ↓
队列、平台适配器与交付结果
```

**Skill 负责教 Agent 怎么完成任务；CLI 负责提供确定性的操作接口；API 负责服务端能力。**

Agent Skills 标准本身就是 `SKILL.md` 加可选脚本、参考资料等资源，并不是一个取代 HTTP 的通信协议。citeturn873364search2

### Skill 应提供的是完整工作流

不能只是写一句“调用 `syndroo posts create`”。

我建议首个 Skill 负责：检查 CLI 与实例配置，整理各平台正文，展示目标平台和定时时间，在授权范围内提交确定的内容，然后查询结果并解释部分失败或不明确结果。

详细命令和 HTTP 备用说明可以放入参考文件，让主 `SKILL.md` 保持简短：

```text
skills/syndroo/
├── SKILL.md
└── references/
    ├── cli.md
    ├── http-fallback.md
    └── delivery-semantics.md
```

这个结构符合 Skills 的按需加载方式。citeturn831093view3

### API 备用，需要定义清楚什么时候可以用

| 环境或结果 | 建议行为 |
|---|---|
| 支持 Skill，且可执行 CLI | 默认走 Skill → CLI |
| 无法执行 CLI，但有获授权的 HTTP 工具 | 使用同一工作流，通过 HTTP 备用入口执行 |
| 既不能执行 CLI，也没有 HTTP 工具 | 报告环境缺口，不声称能够发布 |
| CLI 返回鉴权或权限错误 | 停止并修复配置，不能换入口绕过限制 |
| 提交超时或交付结果不明确 | 按幂等和结果查询规则处理，不能直接换 API 重发 |

Skills 的规范允许声明系统工具和网络等环境要求，因此文档应该提供**按实际验证结果维护的客户端兼容表**，不能因为某客户端支持 Skill，就自动宣称它能安装 CLI、访问用户本地网络或取得凭据。citeturn153910view1

还有一个重要安全边界：**Skill 里的“先确认”，以及 CLI 的 `--yes`，都不是服务端权限机制。** 它们只能帮助规范操作流程。凭据权限、输入校验和幂等保护仍须由确定性的代码承担。

因此，我同意“API 作为备用”的产品表述，但建议写成：

> **Agent 优先通过 Skill 使用 CLI；需要自定义集成时，可直接使用 SDK 或 HTTP API。**

这不会把面向 SaaS、后端和自动化开发者的 API 降成次等能力。

## 5. Docs 应按使用者入口组织，而不只是按服务端模块组织

当前文档设计包含 Agent setup、HTTP API、部署和平台指南，但 README 明确说明没有 Syndroo SDK、Skill 或 MCP server。因此，目前的缺口不只是“漏写了一页 SDK 文档”，而是这些交付物还不存在。fileciteturn3file0L2-L2

建议文档首页直接给出三条主要路径：

| 用户目标 | 第一入口 | 必须走通的内容 |
|---|---|---|
| 让 Agent 帮我发布 | Agent / Skill Quickstart | 安装、环境检查、预览、授权、发布、查结果 |
| 从终端操作 | CLI Quickstart | 安装、配置、首次发布、JSON 输出、错误处理 |
| 集成到自己的应用 | SDK Quickstart | 安装、初始化、创建任务、幂等、查询结果 |

HTTP API Reference 保持完整，但不再让所有人先阅读 HTTP 请求示例。部署指南则回答“如何获得一个实例”，与“如何使用实例”分开。

另外必须增加一页 **Packages overview**，说明哪个包用于部署、哪个用于调用、哪个提供终端命令，以及兼容版本和最低运行环境。

所有入口最后都应该落到同一条验收路径：

> **新用户按文档操作，能够完成一次单平台发布，并判断任务究竟是已受理、已交付、失败，还是结果尚不明确。**

## 6. 下一阶段建议怎样安排

当前网站的 `0.3.0` 是设计迭代，不是产品版本；核心仓库的 `v0.3.0` 记录主要是内部架构整理，仍将公开 Worker 标注为 `0.2.0-rc.1` 候选版。这次新增 SDK、CLI、Skill，应该作为明确的产品能力范围追加，不能视为现有重构已经包含了它们。fileciteturn4file0L2-L2 fileciteturn7file0L2-L2

我建议按下面的顺序推进，网站迁移可以独立开展，但对外文案要跟着真实能力更新：

| 阶段 | 交付 | 验收重点 |
|---|---|---|
| SDK | 独立公共包、使用文档和契约测试 | 打包后能在空白消费者项目安装；不依赖未发布 workspace；错误和幂等语义正确 |
| CLI | 人类与机器共用的命令入口 | 实际子进程测试；stdout/stderr、退出码、非交互行为和凭据脱敏正确 |
| Skill | CLI 优先的完整工作流 | 在具体 Agent 客户端演练；验证授权、部分失败、不明确结果及 HTTP 备用路径 |
| Website / Docs | Next.js 静态迁移和三条上手路径 | 两站独立构建；旧链接可达；搜索、移动端、键盘操作和静态部署验证 |

这几个阶段应使用本地 mock 或隔离环境验证失败与重试行为，不能为了测试而发送未经授权的真实帖子。真实平台验收另外记录，不能用 mock 通过代替。

**我的最终建议是：保留 API-first 的技术底座，建立 Skill-first 的 Agent 体验，同时把 CLI 和 SDK 都作为正式产品交付。** 网站框架迁移解决维护问题；SDK、CLI、Skill 才解决“用户如何真正用起来”的问题。

本次完成的是源码核对和架构建议，未修改仓库、运行构建、发布 npm 包或发送真实帖子；上面的新包接口和命令均为待实现设计。

## v0.4.0 三份文档完成说明（对话消息 #86，text）

方案已整理为设计、Release Runbook 和 E2E 清单三份文档，清单含 64 项必测与 3 项可选验证。站点规范同时补充 Docs 外框统一、主题切换及迁移兼容要求。

## v0.4.0 范围、发布流程与本机验收方案（对话消息 #102，text）

**你的判断基本正确：v0.3.0 的主要开发已经完成，但还没有完成全部验收，也不能把它等同于一次正式 release。** 下一步应该保留这些已完成的成果，把 SDK、CLI、Skill、网站框架迁移和你这次提出的视觉修改，统一纳入 **v0.4.0**，而不是回头重做 v0.3.0。

我已整理成两份可交接的文件：

[**v0.4.0 Change Request 与方案设计**](sandbox:/mnt/data/syndroo-v040/syndroo-v0.4.0-change-request.md)  
[**本机 E2E 与发布验收清单：63 项**](sandbox:/mnt/data/syndroo-v040/syndroo-v0.4.0-local-e2e-checklist.md)

下面是核对结论，以及我建议确定下来的版本范围。

## 一、v0.3.0 到底完成了什么？

这次核对的是两个仓库当前默认分支可见的提交，而不是只看上传文档里的状态说明。

| 部分 | 核对结果 | 尚未完成的边界 |
|---|---|---|
| **Web v0.3.0** | Agent-first 首页、统一 Agent/API Demo、平台指南、Recipes、文档导航与元数据等主要改动已经提交。验收记录报告 **44 个测试、22 个页面、1,086 个本地引用检查通过**。 | 新版浏览器视觉、键盘、缩放、reduced-motion 检查没有执行。 |
| **核心 v0.3.0 架构工作** | 选定的发布编排与可靠性重构已提交。提交记录报告 **273 个 unit/script 测试与 12 个 Mock SNS E2E 测试通过**。 | 没有改变包版本或数据库 schema，也不代表真实平台验收完成。 |
| **正式发布** | Worker 仍标注为 `0.2.0-rc.1`；这次查询的核心仓库 GitHub Releases 集合为空。 | 仍需要完成真实账户、发布权限、registry 安装与正式发布验证。 |

以上测试数字来自仓库已有记录，**不是我这次重新运行的结果**。fileciteturn14file0L2-L2 fileciteturn13file0L2-L2 fileciteturn5file0L2-L2 fileciteturn20file0L2-L2

你上传的设计文件仍写着“设计建议，未实施”，那是它编写时的状态；当前源码已经向前推进，不能再据此判断“尚未开发”。同时，它也明确区分了 Web 设计版本、Worker 产品版本和文档版本。fileciteturn11file0L3-L5 fileciteturn11file0L21-L32

因此，v0.3.0 合适的结项描述是：

> **主要实现已完成，已有本地自动化验证记录；浏览器与真实发布验收未闭环。**

上一条提出的 SDK、CLI 和框架迁移，应该作为 **v0.4.0 新增范围**，不应算成原 v0.3.0 开发“漏做”。

## 二、v0.4.0：第一次真正可安装、可使用、可验证的公开交付

我建议把版本目标定成：

> **用户不需要克隆 Syndroo 源码，就能安装发布包，通过 SDK、CLI 或 Skill 完成首次发布，并判断每个平台的真实结果。**

这比“把包上传 npm”多了一步：**我们要验证用户消费发布产物的路径，而不只是开发者运行源码的路径。**

### 本次交付三个 npm 包

| 交付物 | v0.4.0 的职责 |
|---|---|
| `@syndroo/cloudflare-worker` | 部署和运行 Syndroo 服务，保留现有 `syndroo-deploy`。 |
| `@syndroo/sdk` | 新增公共 TypeScript HTTP 客户端，供应用和 CLI 调用。 |
| `@syndroo/cli` | 新增 `syndroo` 命令，服务本地终端、脚本、CI 和 Agent 用户。 |
| 官方 Syndroo Skill | 随 CLI 包提供固定版本的 Skill 文件，暂时不必再增加第四个 npm 包。 |

建议首轮三个公共包统一使用 `0.4.0`，方便维护和文档说明；私有 core、adapter、网站 workspace 不需要为了整齐而全部修改版本。

Agent 路径仍按照你确定的方向：

```text
Agent + Syndroo Skill
          ↓
     Syndroo CLI
          ↓
     Syndroo SDK
          ↓
     Syndroo HTTP API
          ↓
       Worker
```

**直接 HTTP 是接入能力不足时的备用入口，不是 CLI 失败后的重发通道。** 例如 CLI 返回鉴权失败、提交超时或结果不明确时，Skill 不能换成 HTTP 再创建一条帖子。

这版不额外扩展 Dashboard、多账号、OAuth 代管、媒体、完整 MCP server 或新的服务端审批系统。先把现有文本发布能力做成可靠的完整产品入口。

## 三、Website / Docs 的修改，明确写进 v0.4.0

这次不再把这些问题归成“以后再做视觉优化”。它们应当有具体的实现要求和验收标准。

### 1. 吉祥物：放大，并去掉图片本身的圆形裁切

你说的偏小，和旧规格直接相关：原设计把 Hero 吉祥物定位成约 **144–180px 的辅助点缀**，结尾则约 **96px**。当前源码实际设置为 Hero `160px`、CTA `96px`，并且给 `.demo__mascot` 图片本身加了 `border-radius: 50%`。fileciteturn11file0L198-L204 fileciteturn16file0L2-L2

所以不能只改一个 `width`，需要一起调整角色定位、空间和裁切方式。

**建议的新尺寸目标：**

| 位置 | 桌面 | 手机 |
|---|---:|---:|
| Hero 吉祥物 | 280–360px，先以 320px 布局 | 200–240px |
| 结尾 CTA 吉祥物 | 180–220px | 约 160px |

这些是新设计目标，最终以原图可见角色的大小和实际布局验收为准。

实现上，建议把它从 Demo 标题旁的小头像位置，移到 Hero 的品牌视觉区域，给它真实的布局空间。**原图必须完整展示：耳朵、尾巴、手脚都不能被圆形框或祖先容器裁掉。**

背景光晕可以保留，但应当是图片后方的独立装饰层，而不是图片上的圆形蒙版。也不需要为此重画袋鼠。

### 2. Website：主布局真正占满全屏

当前网站 `.wrap` 有 `max-width: 1160px`。这会把主布局限制在居中的窄容器里。fileciteturn16file0L2-L2

新规格应当是：

> **Header、主要 section 和 footer 的主布局都随视口扩展，不只是背景铺满屏幕。**

例如：

```css
.site-shell {
  width: 100%;
  max-width: none;
  padding-inline: clamp(20px, 3vw, 64px);
  box-sizing: border-box;
}
```

这里有一个区分：**网站全宽，不意味着每段文字都横跨整个显示器。** Hero 网格、卡片和展示区域可以利用全屏；说明段落、博客文章仍应保留合理行长。

也不应把 `1160px` 换成另一个固定最大宽度，就称为完成全宽改造。

### 3. Docs：统一外层宽度，不把文章本身拉成超长行

建议引入一个统一的 `DocsShell`：

```text
Header inner ──────────────────────────┐
                                     │ 同一外层边界和 gutter
Sidebar | Article | TOC ───────────────┤
                                     │
Footer inner ─────────────────────────┘
```

Header、main 和站点 footer 共用同一套外层宽度、边距和断点，不能各自定义不同的 `max-width` 与 padding。

文章列仍可以保持约 `70–80ch` 的阅读宽度。这与页面整体对齐不冲突。

**验收标准也直接量化：**在同一视口下，header/main/footer 的左右外边界误差不超过 **1 CSS px**；同时检查 Overview、Quickstart、API 和平台指南，避免只把首页修好。

### 4. 两站增加 Light / Dark 按钮，并保留 System

建议两站 header 都放可见的主题切换入口，桌面和手机均可用：

**Light / Dark / System，默认 System。**

技术上可以采用共享主题组件和语义颜色变量，通过 `next-themes` 接入；这是 shadcn 官方提供的 Next.js 主题实现路径。citeturn993855view1

验收不能止于“点击后背景变黑”，还要覆盖搜索弹窗、移动导航、代码块、表格、状态提示、按钮和焦点样式，并检查刷新后的记忆、系统主题变化和首屏闪烁。

另外，官网和 docs 是不同 origin，**同名 localStorage 不会自动跨站共享**。方案中建议正式域名使用只保存主题值的父域 cookie，让用户从官网跳转到 docs 后保持主题一致；本地和独立预览域则按各站保存，不共享任何凭证。citeturn324506view3turn324506view4

### 框架迁移也纳入本版

两站使用 **Next.js + shadcn/ui，Docs 加 MDX**，分别静态导出，继续作为两个独立站点托管。

Next.js 的 `output: "export"` 支持这种静态交付；但不能依赖请求时的服务端功能、Server Actions 或默认图片优化服务。我们应当保留静态部署的简单性，而不是顺便引入一个 Next.js 服务端。citeturn993855view0

## 四、npm 发布：先有真实 RC，再形成正式 release

当前 release workflow 只发布 `@syndroo/cloudflare-worker`。新增 SDK、CLI 后，必须同步修改版本校验、打包验证、发布顺序和失败恢复逻辑，不能只增加两个目录。fileciteturn19file0L2-L2

建议采用下面的流程：

| 阶段 | 要完成的事情 |
|---|---|
| **1. 本地候选准备** | 三个包的构建、类型、单元测试、Mock E2E、打包检查和独立消费者测试通过。记录提交与产物 hash。 |
| **2. 发布 RC** | 将 `0.4.0-rc.1` 发布到 `next`；先 SDK，再 CLI，再 Worker。 |
| **3. 你在本机验收** | 从 npm 安装精确 RC 版本，执行 CLI/SDK、真实测试账号、Agent 和浏览器验收。 |
| **4. 修复与重新候选** | 有问题则发布 `rc.2`，保留失败记录，重跑受影响的验收。 |
| **5. 准备正式产物** | 修改到 `0.4.0`，同步 CLI 的 SDK 依赖和 lockfile，重新打包并验证最终产物。 |
| **6. 正式发布与收尾** | 发布三个正式包，再从 registry 验证安装、版本与依赖，更新模板、Docs、官网和 GitHub Release。 |

这里有两个容易混淆的地方。

**第一，不能把 `0.4.0-rc.1` 的 dist-tag 改成 `latest`，就当作发布了 `0.4.0`。** dist-tag 是安装别名，不会改变包里的版本号。citeturn324506view2

**第二，npm 同名同版本不能覆盖。** 发布后发现问题，应发布新的 RC 或 `0.4.1`，不能依赖删除后重传。citeturn324506view1

发布认证建议继续使用 npm Trusted Publishing，但要分别确认三个包的权限和配置。你的电脑用于 E2E，CI 用于受审批的发布；不要假设本机登录成功就证明 CI OIDC 已配置正确。npm 当前也明确区分了受支持的云托管 runner 和 self-hosted runner。citeturn993855view2

三个包的发布不是一个原子操作，因此方案还要求测试“SDK 已发布、CLI 发布失败”的恢复路径：核对已发布产物、停止错误的成功公告，而不是盲目重传。

## 五、你在本机需要做的 E2E 测试

**本机 E2E 不等于全部服务都必须运行在本机。** 我建议分为三层：

| 层级 | 测试链路 | 证明什么 |
|---|---|---|
| **L1：本地 Mock** | Worker bundle → 本地 D1/Queue/Cron → 真实 adapter → Mock SNS | 内部交付、幂等、故障和并发逻辑正确。 |
| **L2：安装产物** | 空目录安装 tarball/npm RC → 真正的 SDK/CLI → L1 | 用户安装到的包可以工作，不依赖源码 workspace。 |
| **L3：真实账号** | 你电脑上的 SDK/CLI/Agent → staging Worker → 真实 SNS 测试账号 | 真实凭证、平台接口和最终远端帖子成立。 |

当前已有的 Mock SNS E2E 确实使用 bundled Worker、D1、Queue、scheduled handler 和真实 adapter，只替换 SNS 网络边界；这部分应该扩展复用，而不是推倒重写。fileciteturn18file0L2-L2

### 测试内容列表

完整文件中有 **63 项**，每项都包含操作、通过标准和需要保存的证据。主要内容如下：

| 测试组 | 数量 | 必须覆盖的内容 |
|---|---:|---|
| **包与安装** | 8 | 三包 tarball 内容；空目录安装；Node 支持矩阵；npm RC 安装；CLI bin；部署模板；基线升级；Skill 随包文件。 |
| **SDK** | 6 | 创建/查询/等待；各平台正文覆盖；HTTP 和坏响应；中止与超时；鉴权与重定向；轮询边界。 |
| **CLI** | 8 | doctor；文件/stdin；validate/dry-run；交互确认；非交互调用；JSON 与退出码；幂等恢复；关闭客户端后恢复查询。 |
| **交付可靠性** | 10 | 幂等重放和冲突；并发提交；重复 Queue；部分失败；结果不明确；退避与次数限制；定时时区；入队恢复；测试隔离。 |
| **Agent Skill** | 7 | 具体客户端安装；完整授权流程；取消/只读；不可信内容注入；HTTP 备用；禁止故障后换路重发；凭据和能力边界。 |
| **Website / Docs** | 11 | 静态产物；历史入口；全宽；吉祥物；Docs 对齐；键盘操作；四类 Demo；亮暗覆盖；主题持久化；响应式；照文档上手。 |
| **真实平台** | 7 | staging 实例；Bluesky；Threads；多平台差异正文；真实定时；真实 Agent 工作流；实验平台状态。 |
| **Release** | 6 | 多包校验；发布认证；RC 到正式产物；部分发布恢复；正式 registry 安装；发布收尾。 |

其中 **62 项是本次范围内的必选门槛，1 项为条件项**：X、Tumblr、LinkedIn 只有在本版要提升验证级别时，才追加对应真实发布验收。自动化能完成的部分，不需要你手工逐条操作。

### 最需要重点盯住的行为

**重复发布风险。** 同一 key/body 重跑、并发提交、重复 Queue，都应检查远端创建次数，而不只是检查返回值。

**不明确结果。** Mock SNS 已经收到创建请求但连接断开时，客户端必须保留不明确状态，不能换一个新 key 或改走 HTTP 再发。

**确认与实际发送一致。** CLI 展示预览后，即使输入文件发生变化，也不能发送未经确认的新正文。

**真的从 npm 包开始。** 不能通过 `npm link`、源码相对路径或开发机全局依赖，把包内缺文件的问题掩盖掉。

**网页是浏览器验收，不是 CSS 审查。** 这次需要覆盖：

```text
360 / 390 / 768 / 1280 / 1440 / 1920 / 2560 CSS px
× Light / Dark
另查 System、200% 缩放、reduced-motion
```

主验收可以用你本机 Chrome；Playwright 配置使用 `channel: "chrome"`，避免把默认 Chromium 结果写成 Chrome 实测。Safari 再做实际浏览器冒烟。citeturn790215view0

### 真实平台的发布门槛不要悄悄降低

当前核心计划已经把 **Bluesky 和 Threads 的真实账号验证**列为正式发布门槛。v0.4.0 应继承它，而不是只测通一个平台，就把另一项改成“以后再测”。fileciteturn6file0L2-L2

真实测试使用 staging 和明确批准的测试文案；失败注入、刷限流、并发压力等放在本地 Mock 环境，不拿真实账号冒险。

## 六、建议的实施顺序

主线是：

**SDK → CLI → Skill → 安装产物 E2E → 真实账号验收 → 正式 release。**

Web 的 Next.js 迁移和四项视觉修改可以作为独立工作流推进，但最终一起进入 v0.4.0 验收。这样既不会重写已经完成的核心逻辑，也不会让“包发了，但用户仍不知道怎么用”成为第一次正式发布的状态。

两份文件已包含变更 ID、包边界、拟新增测试命令、发布步骤、文件所有权和逐项验收标准。**其中拟新增命令都明确标注为尚未实现，63 项测试的初始状态全部是 `NOT RUN`。**

本次完成的是源码与记录核对、方案设计和清单整理；没有修改仓库、重跑产品测试、发布 npm 包、部署服务或发送真实帖子。

## 文档核对与执行阻塞（对话消息 #123，text）

两份文件已核对，E2E 共 63 项；但当前仅有 GitHub 只读通路，Mac mini 插件未暴露，因此 DeepSeek 开发尚未启动。

## 写入失败与交接包说明（对话消息 #155，text）

**这次没有成功写入仓库，也没有启动 DeepSeek 开发：两个执行入口都遇到了阻塞。** 我没有擅自更换模型，也没有把准备好的文件当作已入库或已开发。

| 操作 | 实际结果 |
|---|---|
| 调用你指定的 Mac mini 插件 | 当前会话没有暴露该插件的执行工具，无法操作你的本机仓库或启动 native subagent。 |
| 通过 GitHub 写入方案 | 实际写入请求返回 **`403 Resource not accessible by integration`**；已停止重试，没有创建分支、提交或 PR。 |
| 使用 `deepseek/deepseek-v4-flash` 开发 | **调用次数为 0**。没有使用旧路由或其他模型替代。 |

## 已准备好可直接入库的交接包

[**下载 v0.4.0 仓库补丁与开发交接包**](sandbox:/mnt/data/syndroo-v040/syndroo-v0.4.0-repository-handoff.zip)

包内按照两个仓库整理：

```text
syndroo/docs/v0.4.0/
├── README.md
├── syndroo-v0.4.0-change-request.md
├── syndroo-v0.4.0-local-e2e-checklist.md
├── implementation-handoff.md
└── acceptance-results.template.json

syndroo-web/docs/v0.4.0/
└── README.md
```

两份原始方案按字节保留。实施交接已明确 **SDK 与 Web 第一波并行、随后 CLI → Skill → 集成验收**，以及每个子任务的允许文件、输入、验收条件、准确模型路由、最多两个并行子代理和三次尝试限制。

另外附有两个**只新增文档、不修改产品代码**的 Git 补丁：

[核心仓库补丁](sandbox:/mnt/data/syndroo-v040/repository-handoff/syndroo-v0.4.0-docs.patch) · [Web 仓库补丁](sandbox:/mnt/data/syndroo-v040/repository-handoff/syndroo-web-v0.4.0-docs.patch)

## 已验证与未执行的部分

已经在一次性 Git 目录中验证：补丁可以应用，应用后文件与原文一致，遇到已有同名文件会拒绝覆盖；清单包含 **63 个唯一测试项**，结果模板全部保持 `NOT RUN`。

**尚未执行产品实现、产品 E2E、npm 发布、部署或真实发帖。**

继续开发需要让当前会话真正获得 **Mac mini 插件的执行与 native subagent 工具**。恢复该入口后，可以通过本机 Git 完成入库，不必依赖这次返回 403 的 GitHub 写入连接；接续入口已放在 `implementation-handoff.md`，无需重新整理方案。
