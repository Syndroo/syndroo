# Syndroo Web v0.4.0 implementation entry

状态：待执行。此文件是交接，不是实现、截图、发布或测试通过记录。

## 统一需求来源

本轮完整 CR 与63项验收保存在核心仓库：

```text
Syndroo/syndroo
  docs/v0.4.0/README.md
  docs/v0.4.0/syndroo-v0.4.0-change-request.md
  docs/v0.4.0/syndroo-v0.4.0-local-e2e-checklist.md
  docs/v0.4.0/implementation-handoff.md
  docs/v0.4.0/acceptance-results.template.json
```

本包尚未写入GitHub，因此不提供假装已存在的远端文档链接。将两个仓库补丁应用到各自工作区后，从核心文档读取完整需求；不要用本页摘要代替原规格。

## 本仓库范围

CR-040-04..07：Next.js App Router + shadcn/ui + MDX；两站独立静态 out/；保留原品牌、平台事实、四类模拟Demo、全部旧页面/锚点、搜索和元数据。

四项视觉要求：

1. Hero 吉祥物桌面280–360px、手机200–240px；CTA桌面180–220px、手机约160px。原图不重画，不用圆形图片/祖先overflow裁耳尾脚；光晕独立置后。
2. Website header/section/footer 主布局全宽，取消整体1160px上限；不是仅背景全宽，也不是改另一个固定max-width。文章自身保留可读行长。
3. Docs header/main/site-footer共用外层shell与gutter，左右边界误差<=1 CSS px；文章可窄，代码/表格局部滚动。
4. 两站桌面/手机可见Light/Dark/System，默认System；共享语义tokens、持久化/初始主题/错误存储回退；生产只共享主题cookie，不共享凭证。完整细节遵循CR。

## 验收与诚实状态

WEB-01..11。测试生产静态输出；Chrome channel=chrome；360/390/768/1280/1440/1920/2560 CSS px×亮暗；另外System、200%缩放、reduced-motion、键盘、搜索弹窗、移动导航和实际Safari冒烟。Astra审查真实截图。单元测试或CSS审查不能替代浏览器验收。

文档提供Agent/CLI/SDK三条路径。未发布的SDK/CLI不得伪装成可从npm安装；平台状态必须依证据，不因代码构建通过变成live-validated。Demo永不发送真实请求。

## 路由与启动阻塞

本轮精确路由：deepseek/deepseek-v4-flash，无fallback。旧AGENTS.md里的opencode-go/deepseek-v4.1-flash不是本轮许可路由；实施前在工作分支同步这一冲突及框架约束，不改历史acceptance。

最多两名子代理，跨仓库合计；Web只占一个writer；每个子任务最多三次总尝试。按核心implementation-handoff的E任务合同执行，根package/lockfile与工作流只允许协调者安排的独占集成writer修改。

当前会话未暴露指定Mac mini插件/native subagent工具；GitHub写入返回403。没有创建远端分支，没有开始实现。先恢复可用工具与准确route并核对本机git status/已有children；不伪造请求ID、不更换模型、不覆盖用户改动。
