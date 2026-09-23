# 0.5.0 部署与发布交接

本文件给维护者一份可执行清单：现在能做什么、哪些门槛仍然关闭、未来部署与发布按什么顺序做。
它不替代任何验收证据，也不新增任何授权。

相关文档：[发布流程](../releasing.md)、[0.5.0 开发记录](README.md)、
[待授权的补正范围](remaining-corrections.md)、[Worker 接入边界](runtime-composition.md)、
[测试分层](../testing.md)。

## 当前结论

0.5.0-rc.1 目前只是元数据：三份公开包的 manifest 与 CLI 的精确 `@syndroo/sdk` 依赖已经
对齐到同一个 `0.5.0-rc.1` 候选版本，除此之外没有别的含义。

本次任务的范围是提交当前开发进度，并推送目标分支 `codex/v0.5.0`；推送前该分支尚不存在
于远端，推送是否成功要以实际结果为准。**本次任务没有创建 tag，没有创建 GitHub Release，
也没有发布任何 npm 版本。** 远端状态只核对了分支指向，没有查询 tag、Release 或
registry 状态。

计划的进度提交（把当前未提交的改动收拢成一次提交）不是发布：它既不生成 tag，也不触发
发布工作流。基线提交是 `d8206f298333eeb83d45d319ea244bbda72c78f7`。

## 当前关闭的门槛

这些是**就绪度**问题，不是许可问题：用户已经授权在条件允许时部署和发布，当前不能部署或
发布是因为下面的门槛没有通过。

1. **Worker 聚合测试不通过。** 主项目出现 `EnvironmentTeardownError`
   （`Closing rpc while "resolve" was pending`）后挂起，60 秒超时终止，退出码 124。
   最终一次运行没有打印完整的测试计数，因此更早的通过记录不能计入本次结果。
   证据见 [独立复核](evidence/root-review.md)。
2. **类型检查不通过。** 对 Worker 测试树直接运行 `tsc` 仍报告 4 项已知类型错误。
   这一项不是 `npm run check` 的结果：`npm run check` 会调用 Wrangler 生成 `Env` 类型，
   本轮没有运行它。
3. **运行时最终接入未完成。** HTTP/Queue/Cron 的入口切换、D1 的围栏与公开读投影、
   fresh/legacy 迁移演练、crypto 与 R2 的跨运行时互通、CLI 边界证据都还没有验收。
   范围与缺口见 [Worker 接入边界](runtime-composition.md) 和
   [待授权的补正范围](remaining-corrections.md)。
4. **补正范围尚未获授权。** 若干范围已经用尽初始尝试次数，继续执行需要显式修订尝试预算；
   在那之前它们保持未验收，不能靠改名或跳过绕过。
5. **打包与安装门尚未运行。** 外部 tarball 消费、Worker bundle 与完整门都还没有在本提交上
   跑出结果。已经通过的本地检查是：针对实际 manifest 的**离线 release train**，以及
   **92 项发布检查夹具**。这两项只证明版本一致与脚本夹具本身，不证明可发布。

## 提交与推送的影响

本次允许的动作是提交并推送 `codex/v0.5.0`。它的影响范围是：

- CI（[ci.yml](../../.github/workflows/ci.yml)）只在推送到 `main`、发起 Pull Request
  或手动 `workflow_dispatch` 时运行。**仅推送功能分支不会触发任何 CI 校验**，
  所以“推送成功”不代表任何门槛通过。
- 发布工作流（[release.yml](../../.github/workflows/release.yml)）只在 `release: published`
  事件或手动 `workflow_dispatch` 时运行，推送分支不会触发它。
- 因此这次推送既不产生 tag，也不产生 Release，也不发布任何包。

## 现在可以执行的本地检查

下面这一组边界明确、可以安全重复运行：

```bash
SYNDROO_CHECK_REGISTRY=false npm run release:train   # 显式离线：不查 registry
npm run build
npx tsc -p packages/cloudflare-worker/test/tsconfig.json --noEmit
git diff --check
```

Worker 测试要在有界看门狗下运行，不要直接跑无界的 `vitest run`：

```bash
node packages/cloudflare-worker/test/support/run-worker-tests.ts --only <项目名子串> --timeout-ms <毫秒>
```

补充说明，均可从仓库脚本核对：

- `npm run release:train` 只有在 `SYNDROO_CHECK_REGISTRY=true` 时才会读取 registry
  packument；显式设为 `false` 就是纯离线校验，只证明三包版本一致。
- `npm test` 已经包含 `npm run test:scripts`，后者编译脚本并运行发布检查夹具。
- `npm run e2e:local`（等价于 `npm run test:e2e`）是本地 Mock SNS 门，只证明内部接线，
  不证明真实平台权限或线上行为。
- `npm run e2e:consumer -- --source tarball` 在本仓库之外安装打包产物并运行真实 SDK 与 CLI；
  `--source registry --version <版本>` 只报告该版本是否已发布。

## 需要已复核的隔离配置与目标

下面这些命令会生成 Wrangler 类型、打包、启动本地 Mock SNS、或在仓库外安装产物。它们需要
在**已复核的隔离配置和明确目标**下运行；不要把它们当作对账号、网络与本地状态没有影响的
命令：

```bash
npm test
npm run check        # 会调用 Wrangler 生成 Env 类型
npm run bundle
npm run startup
npm run build:package
npm run e2e:local
npm run e2e:consumer -- --source tarball
npm run verify:package
npm pack --workspace @syndroo/sdk --dry-run
npm pack --workspace @syndroo/cli --dry-run
npm pack --workspace @syndroo/cloudflare-worker --dry-run
```

## 部署前置条件（由操作员决定，本文件不猜值）

以下名字、账号与设置全部属于具体部署，必须由操作员填写，本文件不提供默认值：

- Cloudflare 账号、Worker 名称与部署目标；
- D1 数据库、Queue（含 DLQ）与 R2 bucket 的名称和绑定；
- 实例的公开 URL，以及各平台凭据；
- npm 侧每个包各自的 trusted publishing 配置。

部署目标与密钥必须来自已复核的最终配置。当前 `wrangler.jsonc` 仍是 legacy 资源形态，
**不是 0.5 的就绪资源**：Cron 仍是每 15 分钟一次、Queue 没有版本化也没有 DLQ 配置、
并且没有 R2 绑定。

npm 侧：发布工作流固定使用 Node 24 并安装 `npm@11.19.0`（见
[release.yml](../../.github/workflows/release.yml)）；账号侧的 trusted publishing
配置由操作员在 npm 上自行核对，本文件不引用会随时间变化的 npm 最低版本要求。

密钥写入示例必须指向已确认的配置与目标，不要使用未限定的默认项目：

```bash
npx wrangler secret put <名称> --config <已确认的配置文件>
```

不要在文档、提交或模板里记录真实密钥值。

## 部署与切换：当前不可执行

**现有的 `scripts/deploy.ts` 不能当作 0.5 的就绪部署路径。** 它当前的行为是：查找或创建
D1 数据库、写入临时部署配置、自动 `wrangler d1 migrations apply DB --remote`，然后
`wrangler deploy`。它会在部署前静默升级线上数据库，**没有**针对既有 legacy 数据库的
升级/切换 preflight，也不提供安全的预演或 dry-run。

维护开关 `SYNDROO_MAINTENANCE` 也要说清楚：只有精确字符串 `"true"` 会拒绝新帖子，
**它不会暂停 Queue 或 Cron**。打开它既不会停止旧执行，也不会排空在途工作，所以不能把它
当作切换期间的暂停手段。

0.5 需要的切换能力仍然缺失：

- 迁移 `0006_v050.sql` 已经加入仓库，设计意图是 additive：保留既有 ID、内容、
  canonical request intent 和幂等键，并且不创建任何可执行 job（回填由显式的、经过复核的
  cutover 工具负责）。但**这些兼容性结论尚未被验证**：它目前只是拟议意图，不是已证明的
  向后兼容保证。
- `docs/v0.5.0/cutover.md`（实施计划中 Task 8 的交付物）目前不存在，回填/切换工具也尚未
  实现。
- 安全决策要求为既有 legacy 数据库补一个显式的升级/切换 preflight，同时保留全新安装的
  自动 provisioning 和临时配置清理；在它落地之前，部署助手会静默升级仍由旧 consumer
  提供服务的数据库。

切换真正执行前，至少需要满足（以下为**未来步骤**，现在不可运行）：

- 停止旧 consumer 与 Cron，并复核在途消息；
- 使用带版本的 Queue 与 DLQ，不自动 purge；
- 先备份数据库，再执行迁移，并验证结果；
- 明确旧 Worker 不做自动回滚。

## 未来部署验证与发布顺序（不是现在可执行的步骤）

三包作为一个发布序列，顺序固定为 SDK → CLI → Worker；CLI 依赖精确版本的 SDK，Worker 是
可部署产物，最后发布。所有包必须共享同一个版本。

当前三份 manifest 是 `0.5.0-rc.1`，因此未来发布针对的是候选通道（npm 的 `next`）。
稳定版发布需要新的、对齐的稳定 manifest 以及新一轮门槛，所以本文件不列稳定发布命令。

当前工作流（[release.yml](../../.github/workflows/release.yml)）**只发布
`@syndroo/cloudflare-worker` 一个包**；`workflow_dispatch` 仅做验证、不会发布。扩展到
三包是机械改动，但属于会影响生产行为的维护者决定，尚未落地。在那之前，SDK 和 CLI 需要
按顺序手工发布。

下面的顺序全部是**未来步骤**，用于在门槛全部通过之后执行；本文件不执行其中任何命令。

**锚点：** 每一步都固定在**已批准的精确提交 SHA** 上。提交一旦变化，之前获得的验证结果
全部作废，必须从第 1 步重新开始。

1. **部署前验证（必须在发布任何包之前完成）。**
   - 在已批准的 SHA 上跑完发布门并保留每项结果；任何一项失败就停在这里。
   - 迁移与切换按上文「部署与切换」一节的前置条件执行：先停止旧 consumer 与 Cron、
     复核在途工作并确认停止写入，再备份数据库、迁移并确认结果；使用带版本的 Queue
     与 DLQ，不自动 purge。具体停止写入与排空流程必须先在切换方案中验证。
   - 回滚前提：schema 变更或切换完成之后，**旧 Worker 不是自动安全的回滚目标**。
     回退版本不等于回退数据，必须另外准备并验证回滚方案。
   - 部署后检查：确认线上实际运行的是预期 SHA，并运行安全的隔离 smoke 检查（例如健康
     检查和只读端点）。这些检查不依赖真实平台账号；真实 SNS 的 live 检查是单独的门，
     需要单独授权，不要在未获授权时假定它可用。
2. **发布前确认 registry 状态。** `SYNDROO_CHECK_REGISTRY=true npm run release:train`
   会为每个包报告 `publish`、`already-published` 或 `blocked`。只有 HTTP `404` 才算未发布；
   `401`、`403`、`429`、`5xx` 或传输失败一律 fail closed。
3. **发布候选版本（`next`），一次只发一个包。** 仅对状态为 `publish` 的包，按
   SDK → CLI → Worker 顺序逐个执行：

   ```bash
   npm publish --workspace @syndroo/sdk --tag next
   npm publish --workspace @syndroo/cli --tag next
   npm publish --workspace @syndroo/cloudflare-worker --tag next
   ```

   - 每次只执行一条，成功后再执行下一条；任一步失败即停止。
   - `already-published` 跳过，`blocked` 停止；已发布的版本永不重发、永不覆盖。
   - 部分失败后：先修复原因，再用 `SYNDROO_CHECK_REGISTRY=true npm run release:train`
     重新确认状态，只为仍然缺失的包继续，不要重发已经成功的包。
4. **GitHub Release 的影响。** 发布一个 GitHub **prerelease**（tag 必须恰好是 `v<版本>`，
   prerelease 布尔值必须与版本形态一致，`-rc.<n>` 对应 prerelease）会触发现有的发布
   工作流，而该工作流目前**只发布 `@syndroo/cloudflare-worker`**；`workflow_dispatch`
   只做验证，不会发布。
   - 不要同时使用手工发布和触发工作流来发布同一个 Worker 版本：两条路径指向同一个包，
     只会造成重复尝试与状态混乱。选择一条路径并保持一致；如果版本已经存在，工作流会
     报告并跳过，但这不应成为有意重复触发的理由。
   - 扩展工作流到三包属于会影响生产行为的维护者决定，尚未落地。

规则：已发布的版本永不重发、永不覆盖；修复走新的 `-rc.<n>` 或新的 patch 版本。

## 授权边界

用户已经授权提交、推送，以及在条件允许时部署和发布。本文件不新增授权，也不要求对同一
范围内已经授权的动作重复批准。只有在目标、资源、风险或预算超出既有范围或明显未指定时
才需要再次确认；当前的阻塞是未就绪，而不是缺少发布同意。

## 参考

- [发布流程](../releasing.md)：三包发布序列、dist-tag 规则、工作流与 trusted publishing。
- [0.5.0 开发记录](README.md)：当前阶段、实施依据与验收台账入口。
- [待授权的补正范围](remaining-corrections.md)：已耗尽尝试次数的缺口与拟补正方案。
- [Worker 接入边界](runtime-composition.md)：HTTP/Queue/Cron 接入与所需证据。
- [测试分层](../testing.md)：L1 本地 Mock、L2 安装产物、L3 真实账号三层门槛。
- [独立复核](evidence/root-review.md)：实际测试结果与未通过项。
