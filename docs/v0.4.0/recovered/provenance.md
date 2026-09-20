# v0.4.0 资料恢复来源与校验

## 来源

- 共享对话：<https://chatgpt.com/share/6aaf3f4c-fe40-83ee-a165-ae2c3f6844af>（标题「网站框架与CLI建议」）
- 恢复日期：2026-09-20（Asia/Tokyo）
- 对话内基线：`Syndroo/syndroo` = `6b98a642bf2c214b05c92818a75fccbf0960dbc3`，`Syndroo/syndroo-web` = `48471acc889ad02e740c3e6f1fda0eadd0496b36`
- 本仓库导入时 HEAD：`6b98a64`（与对话基线一致）

## 逐字恢复

| 文件 | 来源 |
|---|---|
| `syndroo-v0.4.0-local-e2e-checklist.md` | 对话中生成该文件的脚本逐字恢复并重跑，63 项（62 P0 + 1 条件项）|
| `README.md` | 对话中交接包生成脚本逐字恢复 |
| `implementation-handoff.md` | 同上 |
| `acceptance-results.template.json` | 同上，由脚本生成，全部 `NOT RUN` |
| `syndroo-web-handoff.md` | 已迁入 Web 仓库：`Syndroo/syndroo-web` `docs/v0.4.0/README.md`（commit `74743e3`）。核心仓库不再保留副本。 |
| `recovered/conversation-design-source.md` | 对话助手回复逐字引用 |

## 重建（非逐字）

| 文件 | 说明 |
|---|---|
| `syndroo-v0.4.0-change-request.md` | 原始文件只存在于共享会话沙箱 `/mnt/data/syndroo-v040/`，字节不可获取。本文由对话内容重建：第 4–9 节逐字取自对话回复，第 1–3、10–12 节为结构化索引，CR 编号到门槛的映射标注为推导。 |

## 无法取回

- 原始 `syndroo-v0.4.0-change-request.md` 与 `syndroo-v0.4.0-local-e2e-checklist.md` 的沙箱字节
- `syndroo-v0.4.0-repository-handoff.zip` 原始包（本地已重建等价内容）
- 两个 git patch 原始文件（本地已重建并验证可应用/可拒绝覆盖）
- 用户上传附件 `syndroo-web-v0.3.0-design-spec.md`（20,249 字节，未随分享链接导出）

## 文件校验（SHA-256）

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `README.md` | 1187 | `5a2dd0c81321ad84e6304f69148ae2dfb597816a908cb049fe3a9333917caa56` |
| `acceptance-results.template.json` | 18769 | `efad5312aedc865773eedec8b65896148fa665d9a16ad02941ab16e3a9883be1` |
| `implementation-handoff.md` | 9377 | `6918f3face19a40b2b8a9755a84b558ef2175bdb05018dd8748a01db404326ca` |
| `recovered/conversation-design-source.md` | 33302 | `21e1d0342f44638086bcdcb40eeda7418d45183bf23d0886495f1c370f8e1e47` |
| `syndroo-v0.4.0-change-request.md` | 17870 | `62462c38ca4fcab01ca8efd6c43717efd749688c5e71bc4bf4fce6a7408ca9e8` |
| `syndroo-v0.4.0-local-e2e-checklist.md` | 25870 | `e680f868f1c09dff3a5b93e81630d585cfd2dbc5326a1660c5cf75eac809219f` |
| `syndroo-web-handoff.md` | 2896 | `894aff05e433bfafcf0a7a846faf9cb1e7075acda1fae8b5f0c276db25220cb6` |

## 状态

本目录是设计与交接资料，不包含任何实现、测试通过、发布或部署记录。清单 63 项状态全部为 `NOT RUN`。

Web 仓库的交接入口已推送到 `Syndroo/syndroo-web` `docs/v0.4.0/README.md`（`48471ac..74743e3`）；核心仓库只保留这一份来源与校验记录。
