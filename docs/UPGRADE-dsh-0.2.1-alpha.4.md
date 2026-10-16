# dsh 0.2.1-alpha.4 插件兼容性检查（分支 `upgrade/dsh-0.2.1-alpha.4`）

## 0. 结论速览

- 上游最新预发布 **0.2.1-alpha.4**（2026-10-15，npm `alpha` tag）；`latest`/`next` 仍是 0.2.0-rc.2。
  上游仓库没有 CHANGELOG，变更来源是 GitHub Releases 说明 + `dsh-v0.2.0-rc.2..dsh-v0.2.1-alpha.4` 的 1876 个提交。
- `check-compat.mjs` 对 alpha.4 部署**全绿**（slot / 注入包 / bundle 机制未变），但它看不见
  **宿主 helper 的导出改名**——本轮唯一的硬破坏就在这里：
  `@deepseek-ai/dsh-session-title-llm` 删掉 `generateSessionTitleWithLlm`，改为 `executeSessionTitleLlm`。
  model-tuning 2.0.x 在 alpha.4 上整行激活失败（单测 71/85）。已修：**model-tuning 2.1.0**。
- peer 门禁这次不拦：宿主 `semver.satisfies(..., { includePrerelease: true })`，`>=0.1.6-alpha.1` 覆盖 0.2.1-alpha.x。
  兼容判定新增 `engines.dsh`（优先于 peer），我们的包未声明，继续走 peer。
- 顺带清理：移除 **model-search**（官方菜单自 0.2.0-rc.2 自带搜索），删掉 read-image-preview 与官方重复的读盘通路。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 验证部署 | 临时目录 `npm i @deepseek-ai/dsh@0.2.1-alpha.4`，再用 junction 拼成 `check-compat --deploy` / `DSH_TEST_DEPLOY_ROOT` 能认的布局 |
| 对照部署 | 全局 CLI 0.2.0-rc.2 |
| 桌面端 | 仍为 0.2.0-rc.2：官方生产更新源 `download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` 只到 rc.2，`0.2.1-alpha.*` 安装包 404，GitHub Release 只有源码包 |

## 2. 与官方功能的重合 / 冲突

| 插件 | 官方 alpha 的情况 | 处理 |
| --- | --- | --- |
| model-search | 官方模型菜单 0.2.0-rc.2 起内置搜索；本插件以 priority -1 整块替换官方菜单 | **移除**。会挡住官方后续加进菜单的东西（alpha.4 的推理档位） |
| model-tuning · 模型参数 | alpha.4 官方 Models 页可编辑手工声明 pi-ai 模型的 `reasoningEfforts`，且每档可设 API 值 | 写入时保留已存的 API 值与 `off` 值（`reasoningEffortsPayload`）。官方未覆盖：目录路由 `modelOverrides`、`llm-deepseek`、两个 compat 开关、生图勾选 |
| model-tuning · 用途（标题） | 可选目录新增 `session-titles-bundle`（每条新消息刷新标题），同样独占 `ctx.sessionTitle.register()` | 二选一；本插件这边冲突时只 warn，不再拖垮绘图/设置页 |
| read-image-preview | 官方 read_image 卡片：默认折叠、结果后出图、无缩放 lightbox；10-09 起显示路径/尺寸/降采样信息。通用工具行不渲染附件图 | 删掉自建 `/resolve` 读盘通路（DSH 0.1.7 起 read_image 结果自带附件引用），read_image 改走附件轨。展开即见图、缩放平移、标注、抓屏、截图管理保留 |
| computer-use | 官方 `dsh-computer-use` 注册服务 + 实验性 Cua Driver native/MCP 提供方 + macOS CUA；均不在默认组合与可选目录 | 不冲突（我们不调 `ctx.computerUse.register`，工具名不同）；两边同装会出现两套桌面工具 |
| shell-selector | 官方新增「插件 → Shell」卡片，只有超时与输出上限；`pwshPath` 仍在 | 不冲突 |
| mcp-ui | 官方仍无 MCP 配置界面 | 无重合 |
| codex-login | — | `private: true`，不发布（publish.ps1 / 伞包校验都跳过），后续考虑删除 |

## 3. model-tuning 的修复

- `loadTitleHelper()` 按宿主导出择一：有 `executeSessionTitleLlm` 走新 API（提示词、JSON 包装输入、
  首行 + 去整行强调的解析均复刻官方 `session-title-first-prompt-llm`；推理档位取路由最低档；
  `normalizeSessionTitle` 从 helper 旁边解析 `@deepseek-ai/dsh-session-title`），否则回落旧 helper。
- `apply()` 里标题注册 try/catch：失败只 `ctx.logger.warn`，绘图工具照常注册。
- 推理档位写入保留已存 API 值。

## 4. 验证记录

| 插件 | alpha.4 | rc.2 |
| --- | --- | --- |
| model-tuning 2.1.0 | 90/90 | 90/90（prepared-request 用例按宿主跳过 1 个） |
| read-image-preview 1.5.0 | 24/24（纯前端 + host 单测，与宿主无关） | 同左 |
| shell-selector | 30/30 | — |
| codex-login | 13/13 | — |
| computer-use | 18/19，`plugin-wayland.test.mjs` 需 `--experimental-test-module-mocks`，rc.2 同样失败，与 dsh 无关 | 同左 |

`node tools/check-umbrella-sync.mjs`：5 子包 / 5 patch / 5 依赖，通过。

**没做的**：真实 alpha.4 实例里的启动冒烟与页面行为清单（标题实际生成一次、读 `session/title-llm-request`；
read_image 卡片；模型参数页勾档位后看 profile）。

## 5. 本机升级（方案 B：全局 CLI → alpha.4，桌面端留在 rc.2）

- `npm i -g @deepseek-ai/dsh@0.2.1-alpha.4`；回滚：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`。
- web profile 备份：`~/.dsh/backups/web-before-0.2.1-alpha.4-20261016/`（package.json / lock / cordis.patch.yml）。
- web profile 调整：移除 model-search；read-image-preview（原 link 到 `.dsh-017-prod` 旧拷贝 1.4.1）与
  model-tuning（原 `file:` 快照 2.0.1）改为 `link:` 工作区（1.5.0 / 2.1.0）；清掉残留的 model-search /
  shell-selector junction。computer-use / mcp-ui 仍是 `file:` 快照（computer-use 2.4.1 ≠ 工作区 2.5.0，未动）。
- **`llm-deepseek` 行换了包**：dsh-base 里该行现在是 `@deepseek-ai/dsh-llm-deepseek-api-key`，profile patch 里写死的
  `name: "@deepseek-ai/dsh-llm-deepseek"` 会触发 `patch: name mismatch … skipping`，**整段 DeepSeek 模型配置被静默跳过**。
  已删掉该 `name:` 行（按 id 打补丁，rc.2 / alpha.4 都命中）。配置字段两包相同，无需迁移。
  桌面 profile 也有同样的行，桌面端升级时要一起改。
- 会话格式两版都是 `SESSION_FORMAT_VERSION = 4`，桌面 rc.2 与 CLI alpha.4 共用 `~/.dsh` 安全。
- 启动冒烟：`dsh --profile web --no-open --port 0` 正常出 URL，无 `did not activate`；`--dump-config` 无告警；
  `/read-image-preview/state` 401（路由在、被信任围栏拦）、`/resolve` 404（已删）。

**`dsh plugin` 挂住的坑**：在非交互 shell 里 stdin 是不关闭的管道时，pnpm（11.7.0）完成工作（`Done in 642ms`）后
不退出，dsh 一直等它，profile 的 bundles 收尾也不执行。给命令加 `< /dev/null` 即正常退出。

**第三方 TUI（`@deepseek-harness-tui/dsh-tui`，`dsh-tui` profile）**：
- 本机装的 0.11.1 peer 只到 0.1.7-rc.2，**在 rc.2 上就已被拒载**（未授豁免）。
- npm 最新 0.15.0（10-13）README 写明主要兼容目标 0.2.0-rc.2，peer 精确锁 `dsh-app-boot` / `dsh-cmdline` /
  `dsh-plugin-manager` 等为 `0.2.0-rc.2`，在 alpha.4 上同样会被拒载，需 `dsh plugin allow-version` 精确豁免才能跑。
- 静态检查（0.15.0 对 alpha.4）：15 个宿主模块、30 个命名导出全部存在；patch 指向的 28 个 dsh-base 行全部存在。
  运行期行为未验证。未改动该 profile、未授豁免。

## 6. 待办

- [ ] 发布：model-tuning 2.1.0、read-image-preview 1.5.0、tofu-box 1.1.0（`./publish.ps1 -Publish`）。
  **2026-10-16 决定：等 dsh 0.2.1 正式版发布后再跟进**——届时按本文流程对正式版重跑一遍再发。
- [ ] npm 上给 `dsh-plugin-model-search` 打 deprecate 说明（对外操作，待确认）。
- [ ] 桌面端升级到 alpha：官方无安装包，需本地未签名打包或等官方发布，见会话结论。
- [ ] `check-compat.mjs` 增加「宿主 helper 导出」检查（本轮破坏它查不到）。
- [ ] read-image-preview 交互继续打磨。
