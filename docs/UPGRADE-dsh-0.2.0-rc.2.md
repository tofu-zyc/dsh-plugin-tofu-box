# dsh 0.2.0-rc.2 插件兼容性检查（分支 `compat/dsh-0.2.0`）

## 0. 结论速览

- 桌面端（Electron，`desktop` profile）与全局 CLI 均为 **0.2.0-rc.2**；四个桌面插件
  （model-tuning / read-image-preview / computer-use / model-search）boot 全部 `active`。
- `check-compat.mjs` 对照 0.2.0-rc.2 部署：slot、注入包、bundle patch 机制**全部未变**，
  仅 `@deepseek-ai/*` 包版本统一升为 0.2.0-rc.2（导出面 `dsh-tools`/`dsh-typert-protocol`
  只增不减，无 breaking）。
- 唯一真实破坏点在 **peer 范围**：`^0.1.6-alpha.1` 这类 caret 在 0.x 上不覆盖 0.2.0，
  0.2.0 运行时的 profile 启动会**直接拒绝**对应插件行。`d53b7a8` 已修 model-tuning
  （2.0.1）与 computer-use（2.4.1）；本轮补修 **mcp-ui 1.0.3**（`dsh-typert-protocol`
  放宽为 `>=0.1.6-alpha.1`）。
- web profile 仍 `link:` 到 `.dsh-017-prod/source`（0.1.7 时代拷贝），其中 model-tuning
  2.0.0 / mcp-ui 1.0.2 被 0.2.0-rc.2 拒载、computer-use 2.4.0 还带旧审批探测。本轮全部
  切到工作区 `file:` 直链修复版，`dsh plugin ls` 零警告。
- 基线快照 `compat-before.yml` 已刷新为 0.2.0-rc.2 状态（gitignore，不入库）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 桌面端 | `D:\dsh-desktop`（Electron `desktop` profile，本会话即它） |
| 全局 CLI 部署 | `C:\Users\Lenovo\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` = 0.2.0-rc.2 |
| 桌面内嵌 dsh | 打包在 `app.asar` 内，unpacked 只留原生模块；契约面对照用同版本全局 CLI 部署 |
| 工作区分支 | `compat/dsh-0.2.0`（含 0.2.0 适配提交 `d53b7a8`） |

## 2. 契约面核查（四面全过）

| 面 | 结论 |
| --- | --- |
| ① bundle 机制 | `dsh.bundle.patch` + `cordis.patch.yml` `insert:` 语法未变；`dsh --profile web --dump-config` 1618 行正常输出 |
| ② 注入包 | `dsh-client-ui-settings` / `-tool` / `-model-selection` / `dsh-client-locale` / `dsh-api-remotes` 均在 0.2.0-rc.2 存在 |
| ③ Slot | `conversation.input.model`、`settings.section`、`tool.call.toolview` 注册点均未变 |
| ④ 服务方法 | 宿主 `webServer`/`fs`/`tools`/`attachments` 未变；`dsh-tools`/`dsh-typert-protocol` 导出只增不减（新增 `TYPERT_OWNED_VALUE`、`isRemoteJsonValue` 等，均为增量） |

## 3. 本轮修复：mcp-ui peer 范围（0.2.0 上被拒载）

症状（`dsh plugin --profile web ls`，0.2.0-rc.2 运行时）：

```
dsh: warning: Plugin dsh-plugin-mcp-ui@1.0.2 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-typert-protocol":"^0.1.6-alpha.1"}.
dsh: it stays installed but profile startup denies it until you grant an exemption.
```

修复（与 `d53b7a8` 同模式）：`>=0.1.6-alpha.1`，版本 bump 1.0.2 → 1.0.3；
tofu-box 伞包依赖连带 `^1.0.3`，`check-umbrella-sync` 通过。

## 4. 逐插件结论

| 插件 | 版本 | 0.2.0-rc.2 状态 |
| --- | --- | --- |
| model-search | 1.1.1 | 无需改动，slot/注入包未变 |
| model-tuning | 2.0.1 | `d53b7a8` 已放宽 `dsh-session-title-llm` peer；77 单测在 0.2.0-rc.2 部署锚点全绿 |
| read-image-preview | 1.4.1 | 无需改动，5 单测全绿 |
| shell-selector | 0.1.0 | 无需改动，30 单测全绿 |
| computer-use | 2.4.1 | `d53b7a8` 审批探测公理化（`effectivePolicy` → `overrideOf(session)` → `config.policy`，全失效保守放行）；本会话（danger-full-access）实测 13 工具未自锁 |
| mcp-ui | **1.0.3（本轮）** | peer 放宽 + 9 项 selftest 在 0.2.0-rc.2 部署全过 |
| codex-login | 0.1.0（private，未发布） | 13 单测全绿；`dsh-client-ui-settings-models` 注入包存在 |

## 5. 验证记录

- `node check-compat.mjs --profile desktop` / `--profile web`：全绿（web 之前 2 WARN 漂移已消除）。
- 单测（`DSH_TEST_DEPLOY_ROOT` 指向 0.2.0-rc.2 全局部署）：model-tuning 77、shell-selector 30、
  codex-login 13、read-image-preview 5 全部通过；mcp-ui selftest 9 项通过。
- `dsh plugin --profile web ls`：mcp-ui/model-tuning/computer-use 均为 `file:D:/program/dsh-plugins/…`
  直链，零 incompatible 警告。
- `dsh --profile web --dump-config`：正常，快照已更新为 `compat-before.yml`。
- `node tools/check-umbrella-sync.mjs`：6 子包 / 6 patch 副本 / 6 依赖，通过。
- 顺带修正 `tests/_host.mjs` 报错文案里硬编码的 "0.1.7-alpha.2"（现接受任何带标题 helper 的部署）。

## 6. 对生产切换的影响

- desktop profile（Electron 托管）：本会话已验证四插件 active，无需动作。
- web profile：已切 `file:` 直链到工作区修复版，`pnpm test`/selftest 全绿。**发布到 npm
  前保持 file: 直链即可用**；正式发布 = mcp-ui 1.0.3 + tofu-box 依赖 bump（publish.ps1
  会自动跑伞包同步校验）。
- 回滚：`git checkout main` + web profile 重装旧源即可；桌面端重装 0.1.7 安装包。

## 7. 待办

- [ ] mcp-ui 1.0.3 与 tofu-box 发 npm（publish.ps1）。
- [ ] 0.2.0 正式版发布后重跑本文档流程（rc.2 → 0.2.0 预计无破坏，重点盯 peer 门禁）。
- [ ] 页面行为清单人工过一遍（模型菜单搜索、设置页三页签、read_image 缩略图卡）。
