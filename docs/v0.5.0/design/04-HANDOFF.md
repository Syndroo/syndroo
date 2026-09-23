# Syndroo 0.5.0 — 实施准备与交接任务包（整合修订版）

日期：2026-09-21；文档版本：2.0；状态：**待评审的实施输入，不是已批准的执行计划、已授权的代码写入或实施完成报告**。

本轮产出会话文件，不修改仓库、不执行migration、不调用SNS、不做npm发布。用户取消了OpenCode模型前置要求；不存在本轮实现模型调用或模型替换。

## 1. 恢复顺序与基线

先读 [阅读索引](00-README.md)、[整合审查](06-INTEGRATION-REVIEW.md)、[主规格](01-DESIGN.md)、[基础设施契约](07-CONTRACTS-AND-FAILURE-MATRIX.md)、[ADR](02-ARCHITECTURE-DECISIONS.md) 和 [验收矩阵](03-ACCEPTANCE.md)。原文和旧包在sources中只作来源，不能把旧“不加ports/outbox”的决策再当当前约束。

历史基线为 `main@d8206f298333eeb83d45d319ea244bbda72c78f7`；此前唯一dirty是`packages/cli/src/main.ts`删除keepAlive及清理3行。本轮没有再检查仓库，恢复时重新确认branch/HEAD/status/已有任务和较新指令，不能假设这些事实仍然最新。

读取README、AGENTS、package manifests、邻近测试、旧迁移与进度文件。用户原工作区不可reset/clean/stash覆盖。正式写代码应基于确认后的main建立隔离worktree，保留旧实现作回归基线；不要把已有dirty修改自动带入或丢掉。

先评审书面规格，再生成详细执行计划并确认执行方式。下面任务合同用于那份计划；文件列表并不授予本轮写入权限。不要因设计资料完整就自动启动paid agent或production操作。

## 2. 工作依赖与共享文件

```text
规格评审 → 详细执行计划 → T0 基线/验证环境
  → T1 端口/类型/依赖骨架（合同冻结）
      ├→ T2 transport + provider策略
      ├→ T3 D1事务 + 新schema + binding持久语义
      └→ T4 R2 + Cipher基础设施
  T1/T2/T3/T4 → T5 Outbox + 发布应用 + Queue/DLQ runtime
  T1/T2/T3/T4 → T6 授权/refresh完整应用
  稳定T5/T6 HTTP契约 → T7 SDK/CLI/Skill
  T3/T5 + T4 → T8 调度维护/诊断/升级runbook
  全部 → T9 集成/安装包/版本/最终审查
```

这是依赖关系，不要求每项一个package、PR或代理。最多两个active子任务；需要同一文件写入时串行，不允许互相覆盖。

协调者保留root `package.json`/lockfile、CI、`wrangler.jsonc`、三个公共包版本、core公共类型和迁移编号的所有权。T1冻结端口后，后续任务不能各自改变相同接口；提出变更，由单一所有者整合后再继续。T3独占D1实现和migration，T5/T6只提交持久化需求，不并行修改D1文件。T5/T6的公共HTTP adapter接线也由协调者串行合并。

## 3. 子任务合同

### T0 — 基线与本地验证环境

**目标：** 在隔离版本复现F01–F06，并定位原Worker suite停滞问题。历史99/50个测试通过不是0.5.0证据。

**输入：** 05中的历史位置/故障事实、Worker vitest配置、setup、现有e2e harness及Node22/24矩阵。

**允许候选文件：** 本地测试启动配置、隔离fixture、必要的测试环境辅助代码与`docs/testing.md`；产品修复需进入后续任务。

**约束：** fake credentials+受控出站；不读取真实.dev.vars；不删suite或把fetch全部mock掉掩盖runtime问题；不把缺secret警告直接当作已证实根因。

**产出与验收：** 实际命令/版本/退出码、根因与可重复失败fixture；PKG-02。若环境阻塞，说明能做的静态准备和未验证项，不宣称全部通过。

### T1 — 可移植边界与合同

**目标：** 建立私有application和按业务语义分组的ports，让同一应用逻辑可用fake替换CF。

**输入：** 主规格§3/12、07§2/3、ADR-050-01/05/13/20；现有domain/API类型。

**允许候选文件：** `packages/application/**`中的ports及边界测试；必要core类型由协调者处理。不同时开始大规模业务搬移和provider修改。

**约束：** 无Env/D1/R2/Queue/Worker/具体provider imports，type-only与ambient同样限制；不按表机械建泛型CRUD，不造任意transaction callback/DI框架。保持Post/Publication命名和公开/v1契约。

**产出与验收：** 端口完整类型、语义事务后置条件、rollback-capable fake、依赖正反fixture；ARC-01/02、PORT-01–06。接口名并非验收，行为边界才是。

### T2 — 共享transport与provider差异

**目标：** 五平台和OAuth复用真实相同的网络保护，同时保留各平台业务协议。

**输入：** 主规格§8、07§6/9.3、原provider源码和测试。

**允许候选文件：** 私有`packages/transport/**`、五个provider包src/test；typed strategy导出由T1合同约束。root manifest/lock由协调者更新。

**约束：** manual redirect、headers/body总deadline、有限读取和不挂起的清理；零自动写重试；构造Publisher零网络。不得为“不重复代码”把所有HTTP503统一改成安全retry；未知body不能直接写archive。

**产出与验收：** helper及所有调用者迁移、actual workerd fetch+隔离出站测试、平台成功/失败的归一化与可选安全diagnostic；NET-01–05、F02、OBX-09。

### T3 — D1语义事务与新schema

**目标：** 一个具体D1Repository实现多个消费侧ports，维护create/claim/commit/auth/refresh/outbox原子性。

**输入：** 主规格§5/6/10/12，07§3/4/11，原0001–0005及B绑定规则。

**允许候选文件：** Worker `src/infrastructure/d1/**`、追加migrations、D1合同测试；必要旧repository路径可留过渡导出，但不能保留第二份逻辑。

**约束：** 旧迁移不改写；create含key+Publications+jobs；安全retry含future job；current_job_id/attempt_no/claim_token/revision/dispatch_revision guard；0-row CAS必须全不写。SQL和D1 meta不逸出ports。只读lookup与single-command key复用，避免重复建表。

**产出与验收：** fresh/upgrade schema、同一行为合同的local D1结果、竞争与SQL故障注入、索引plan；CRT-01–04、BND-01–05、OBX-01/04/05/06、PORT-04、OPS-01、MIG-01/02。必须实际执行，不能只有SQL code review。

### T4 — R2边界与CredentialCipher

**目标：** 实现R2ArchiveStore/R2BlobStore和最小WebCrypto cipher，不新增媒体或KMS产品。

**输入：** 07§9/10、主规格§14、ADR-050-17/18。

**允许候选文件：** Worker `src/infrastructure/r2/**`、`crypto/**`、对应合同/加密fixture；纯sanitization可在单独application模块，须与T5约定唯一所有者。D1字段需求交T3。

**约束：** archive私有，prefix非ACL；logical key，不回R2Object；allowlist/deadline/size；OAuth响应永不归档；key不入D1/R2/log；AES-GCM AAD/nonce/用途隔离；无production noop/明文fallback。

**产出与验收：** 标准cipher向量与篡改测试、R2和fake同合同、private访问/expiry策略fixture；STO-01–04/07/08、CIP-01–04/06。Blob基础实现不等于已支持SNS媒体。

### T5 — Outbox、发布应用与Queue/DLQ

**目标：** create→outbox→dispatch→claim→provider→commit形成可恢复单链路；业务retry与infra完全区分。

**输入：** T1/T3冻结合同，T2 provider策略，07§4–7和FM-01–22。

**允许候选文件：** application publish/execute/retry/outbox模块；Worker queue producer/consumer/DLQ adapter；对应应用/真实local runtime测试。HTTP/bootstrap共享点协调者整合。

**约束：** 准备在claim前；Current job fencing；provider三次上限，retry以future outbox原子提交；旧job不触发新attempt。任何平台已成功/未知不能因D1/R2/Queue错误重复发送；DLQ不能覆盖active/terminal；保留原D1-only准入和receipt重放。

**产出与验收：** 重复/乱序/故障时间线和实际请求数、版本message codec、same-job infra恢复、旧队列拒绝；PUB-01–06、OBX-01–10、QUE-01–08、STO-05/06，F01/F03。归档在结果提交后独立处理，不能落在通用provider retry catch内。

### T6 — 凭据解析、OAuth候选与refresh

**目标：** 从Env/D1密文到统一resolution；callback仅candidate，明确target后CAS激活；refresh lease保护同grant更新。

**输入：** 原B主规格§4/6/7、T1/T3/T4合同、平台/app的实际协议能力。

**允许候选文件：** application credential/auth模块，必要auth HTTP adapter和协议映射；D1需求交T3，provider-owned目标规范化交T2，不交叉写同一路径。

**约束：** ciphertext与binding分离；直接重设或重连新binding；不能盲继承旧author或混合token组；state一次消费/OAuth1 token匹配；短时secret也加密；refresh未知结果不重复使用可能已旋转token。

**产出与验收：** 安全DTO、operation/complete/refresh契约、并发与前后端失败fixture；CFG-01–04、AUT-01–08、REF-01–04、BND-01–05、CIP-04/06，F05。授权状态不冒充live verification。

### T7 — SDK、CLI、Skill与只读诊断入口

**目标：** 完整auth+posts门面，修复SDK receipt上下文和进程等待；新增必要diagnostics读取。

**输入：** T5/T6冻结HTTP DTO，07§11诊断契约，原CLI确认/稳定key/Reporter规则。

**允许候选文件：** `packages/sdk/**`、`packages/cli/**`。SDK和CLI可先后推进；同一args/Reporter/Skill文件仅一个writer。

**约束：** SDK不依赖私有包，零自动写重试；secret走stdin/受控文件而非flag/聊天；callback不等于active。等待请求完成/timeout/abort前不退出，之后无泄漏保活。一个JSON stdout，不伪造createRequests或delivered。

**产出与验收：** 真实子进程、TTY/non-TTY、异常2xx、取消零写和tarball消费测试；SDK-01–05、CLI-01–05、SKL-01–03、OPS-03，F04/F06。

### T8 — Scheduling、维护、诊断与升级准备

**目标：** 每分钟有界wake、stalled恢复/安全GC、可查诊断，以及cipher+outbox+队列版本切换runbook。

**输入：** 07§4.3/8/9.4/11、主规格§10/13/15、T3数据合同、T5状态机。

**允许候选文件：** application maintenance/diagnostics；Worker scheduler/diagnostic adapters、隔离迁移管理脚本与runbook。Wrangler/资源声明由协调者独占，不自动修改真实resources。

**约束：** 20job参考预算不绕过D1每invocation queries；最多3轮同job stalled恢复，active/unknown排除；size不可查给null；清理不删域状态/key/current未结任务。停止旧消费者/Cron，保留旧Queue清单，禁止autopurge/隐式绑定legacy。

**产出与验收：** fake time四种schedule、broker无DLQ丢失消息恢复、retention/queryplan/统计证据、fresh/legacy安全切换；SCH-01–05、OPS-01–06、CIP-05、CUT-01–03、MIG-01–05。runbook也要明确旧备份中的历史明文无法被新schema自动抹去。

### T9 — 集成、版本与发布准备

**目标：** 安装后的三个公共产物跑通完整新链路，形成同commit验收与可审查交付。

**输入：** 全部子任务结果、120项标准、原发布列车和CI要求。

**允许候选文件：** `e2e/**`、`scripts/**`、CI、root manifests/lockfile、三个public package版本、README/AGENTS/CHANGELOG、必要docs；不修改syndroo-web仓库。

**约束：** 三public包版本0.5.0-rc.1一致，private application/transport正确bundle；release workflow效果单独审查。全程local/fake registry/loopback；没有授权不得npm publish、远端迁移、资源purge或真实发帖。

**产出与验收：** 全118个local gates的当前源码证据、原66项回归映射、artifact hash、剩余阻塞；PKG-01–06、CUT-04/05。LIV-01/02独立授权且不得用mock代替。

## 4. 最终验证命令（未来执行，不是本轮日志）

先确认脚本实际副作用与隔离配置，再聚焦新功能测试、local D1/R2 migrations/contract tests和依赖检查。新测试入口由实施计划按仓库真实结构定义，不捏造已经存在的npm script。完整回归仍包含：

```sh
npm test
npm run check
npm run bundle
npm run startup
npm run build:package
npm run e2e:local
npm run e2e:consumer -- --source tarball
npm run verify:package
npm run release:train
npm pack --workspace @syndroo/sdk --dry-run
npm pack --workspace @syndroo/cli --dry-run
npm pack --workspace @syndroo/cloudflare-worker --dry-run
git diff --check
```

`npm pack --dry-run`可能执行生命周期脚本，须在隔离工作区运行。release-train只用已检查过的离线/fixture配置；registry状态与实际发布动作分开。上面没有`e2e:live`、`--remote`、purge、deploy或publish，不得擅自串入。

## 5. 拟议CLI流程

下面展示规格目标，不是声称新命令现已可用：

```sh
syndroo doctor --json
syndroo auth status --json
syndroo auth connect linkedin --json
# 浏览器回调仅产生candidate；从operation读取状态和实际revision。
syndroo auth operation linkedin <operation-id> --json
syndroo auth complete linkedin <operation-id> \
  --file target.json --expected-revision 7 --yes --json
syndroo auth status linkedin --json

# 存在原始凭据时，经受控文件/stdin传入；禁止secret参数/回显。
syndroo auth set bluesky --file credentials.json \
  --expected-revision 0 --yes --json

syndroo posts validate --file post.json --json
syndroo posts create --file post.json --yes \
  --idempotency-key release-050-example --json
syndroo posts wait <post-id> --timeout 60s --json
syndroo diagnostics --json
```

revision示例不可照抄；target文件只包含明确非秘密选择，credentials文件不能发送到聊天或归档。authorize URL有协议必需短时参数，仅受鉴权交互输出，不写一般日志。diagnostics不解密/展示token、密文、state或媒体内容。

## 6. 进度、重试和回报

未来实施沿用项目现有进度机制；没有则协调者维护一个独占`scratch/v050-implementation/progress.md`。记录baseline、spec revision2、任务/文件所有权、每项实际验收、修改路径、子任务ID和attempt、剩余budget/阻塞/下一步。重启先reconcile已有子任务，不假设超时等于停止。

默认最多两个active子任务，每个最多三次执行尝试；重复失败需新证据/修正输入再试。完成结果须明确changes/verification/unresolved issues，架构负责人复核后才接受。模型路由遵循执行时的明确要求与可用权限；本次设计不再以OpenCode故障为前置阻塞，也不宣称本轮调用了编码模型。

最终报告分别说明源码、本地验收、安装产物、live以及实际发布状态。设计文件完成、合同定义或历史pass都不能替代产品执行证据。
