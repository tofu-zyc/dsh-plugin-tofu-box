# 插件与官方功能重叠盘点（基线 dsh 0.2.1-rc.1）

目的：按「rc 即正式版」的节奏重定各插件的边界——官方已经做的交还官方，官方没做的单独拎出来，后续只维护这部分。

- 基线：npm `next` = **0.2.1-rc.1**（`latest` 仍是 0.2.0-rc.2），本机全局 CLI 与桌面端均为 0.2.1-rc.1。
- 官方实现以 `deepseek-harness/` 检出（tag `dsh-v0.2.1-rc.1`）为准，路径均相对 `deepseek-harness/packages/`。
- 验证环境：隔离 home `.dsh-rc-test` + profile `tofu-rc`（见 [DEVELOPMENT.md](DEVELOPMENT.md#隔离测试-profile不要动桌面端的-profile)），桌面端 profile 不参与。

## 0. 结论速览

| 插件 | 与官方重叠 | 结论 |
| --- | --- | --- |
| model-tuning | **高**。「模型参数」页的大部分字段官方 Models 页已覆盖；标题路由官方配置层已支持；绘图官方没有 | 已收窄为 v3：交还参数页、**删掉标题功能**，只保留官方没有的兼容开关/目录推理覆盖/绘图 |
| read-image-preview | 中。图库展示与原图灯箱官方已有；缩放平移、标注裁剪、发到输入框、抓屏与管理官方没有 | 保留，图库替换方式需持续跟官方 |
| shell-selector | 低。官方终端卡片只管超时/输出上限；`pwshPath` 有配置字段但无 UI | 保留（壳选择 + 方言提示） |
| mcp-ui | 无。官方 mcp-client 只能手写 patch，没有任何 MCP 配置 UI | 保留 |
| computer-use | 低。官方只有 experimental 提供方包：无 bundle、不能从插件页安装、无审批闸门 | 保留，跟踪上游产品化 |
| codex-login | 低。官方有 OAuth 授权 seam 与 provider-card 席位，但没有登录 UI | 保留，实验性 |

## 1. 判定口径

| 判定 | 含义 | 处置 |
| --- | --- | --- |
| **A 已覆盖** | 官方有该功能且用户能在官方 UI/默认组合里用上 | 从插件删除，README 指向官方位置 |
| **B 仅缺 UI** | 官方有配置字段/服务/扩展点，但没有界面 | 插件收窄为纯 UI 适配，不复制逻辑 |
| **C 官方缺失** | 官方没有实现，或只有未产品化的实验件 | 保留，并作为插件的存在理由单独维护 |

## 2. 逐插件盘点

### 2.1 model-tuning（重点）

现状：一个包三个页签（模型参数 / 用途 / 绘图），`client.js` 96 KB。v2 曾把 title-model、image-generation 合并进来，理由是「UI 早已同居」；现在官方 Models 页本身已经承担了那个同居的 UI，前提已经消失。

#### 「模型参数」页

| 功能点 | 官方 0.2.1-rc.1 现状 | 判定 | 处置 |
| --- | --- | --- | --- |
| 按 provider 分组展示模型目录 | `client/ui-settings-models`（Models 页）同一数据源 | A | 删 |
| provider 的 API Key / baseURL / 协议 / 显示名 | 官方 Models 页可增删改；`llm-deepseek` 同 | A | 删 |
| 模型发现「获取可用模型」+ 搜索勾选 | 官方 Models 页自带（0.2.1-alpha.2 起，`llm/discoverModels`） | A | 删 |
| 每模型 id / 显示名 | 官方模型行可编辑 | A | 删 |
| 上下文窗口 / 最大输出 tokens | 官方模型行可编辑（容量两列） | A | 删 |
| 输入模态（文本 / 图像，含继承显示与 `input` vs `inputModalities` 区分） | 官方模型行「输入类型」复选框，继承语义、DeepSeek 取消图像时清理 `imagePixelBudget`/`imageMaxBytes` 均已实现 | A | 删 |
| 推理档位：**手工声明的 pi-ai 路由** | 0.2.1-alpha.4 起官方可编辑 `reasoningEfforts` + 每档 API 值 | A | 删 |
| 推理档位：**内置目录路由**（走 `modelOverrides`） | 官方明确不为已安装目录路由显示推理控件（`ProviderEditor` 的 `reasoningLevelChoices` 只在 `declared === true` 时给选项） | **C** | 保留 |
| 系统提示角色 `compat.supportsDeveloperRole` | 官方 UI 无；字段只在 `llm/llm-pi-ai` 配置 schema 与适配器里 | **B** | 收窄为 UI |
| 思考格式 `compat.forceAdaptiveThinking` | 官方 UI 无；字段在 `llm-pi-ai` 的 `anthropic-messages` compat 白名单 | **B** | 收窄为 UI |
| 模型搜索框 | 官方 Models 页没有跨 provider 搜索 | C（小） | 可不保留 |
| 生图模型勾选（把模型链接进绘图配置） | 官方无绘图功能 | C | 随绘图能力迁移 |

#### 「用途」页（标题）

官方现状：

- 宿主行 `session-title-llm`（`session/session-title-first-prompt-llm`）的 Config 已含**成对的可选路由** `provider`/`model` 与预算 `targetWords` / `targetCjkCharacters` / `maxInputBytes` / `maxOutputTokens` / `timeoutMs`（后者默认 4096）。
- 只缺 UI：官方没有页面编辑它，用户只能改 `cordis.patch.yml`。
- 官方可选组合包「随对话更新的标题」（`experimental/session-titles-bundle`）会 `disabled: true` 掉这一行并插入自己的 provider；官方自定义标题路由还要求注册 LLM 适配器（0.2.1-alpha.1 起）。

本插件现状：

- `cordis.patch.yml` 先 `disable` 官方 `session-title-llm` 行，再插入自己的 provider 行；
- 自己实现 provider，依赖宿主 `@deepseek-ai/dsh-session-title-llm` 的内部导出，**0.2.1-alpha.1 已因此整行激活失败过一次**（2.1.0 用「新旧 API 择一」补丁修复）；
- 与官方「随对话更新的标题」互斥；
- 标题预算默认值与官方已漂移：官方行现在是 `maxOutputTokens: 4096`（给关不掉思考的推理模型留余量），本插件仍是 64，替换行后**默认行为比官方差**。

判定：**B（仅缺 UI）+ 实现方式过时**。处置（已定：删掉，不补 UI）：

- v2 的替换行实现整体删除：不再 disable/insert 任何行，不再 import 标题 helper；
- 标题路由回到官方行 Config，需要独立模型时在 profile 的 `cordis.patch.yml` 覆盖该行；
- 官方可选组合包「随对话更新的标题」不再互斥；
- 顺带消除预算默认值漂移（旧插件 64 vs 官方 4096）。

#### 「绘图」页

| 功能 | 官方现状 | 判定 |
| --- | --- | --- |
| `generate_image` / `list_image_models` 工具 | 官方无任何生图包/工具 | **C** |
| 绘图模型配置（OpenAI Images 协议、模型列表、高级参数） | 无 | **C** |
| 直接绘图面板（提交/轮询/取消） | 无 | **C** |
| 生图勾选跨配置链接 | 无 | **C** | 已随参数页删除（旧条目仍可显示/编辑） |

处置：整体保留在 model-tuning 包内（同一命名空间 `models`/`defaultModel`，用户数据不迁移），不单独拆包。

### 2.2 read-image-preview

| 功能 | 官方 0.2.1-rc.1 现状 | 判定 |
| --- | --- | --- |
| 消息图片 / 工具结果图片展示 | `client/ui-attachment` 的图库 + 四个图片 slot；`read_image` 行把图交给 `tool.call.images` 并显示路径/尺寸 | A |
| 原图灯箱（点击放大、Esc/遮罩/关闭按钮） | `ui-primitives/ImageLightbox` 已提供，但**无缩放平移、无标注裁剪** | A（基础形态） |
| 缩放 / 平移 / 双指手势 / 像素级渲染 | 无 | **C** |
| 标注（矩形/椭圆/箭头/画笔/文字）、编辑、撤销重做 | 无 | **C** |
| 裁剪、复制、保存、发到输入框 | 无 | **C** |
| 抓屏 + 框选（输入框旁按钮、延时、多平台） | 无 | **C** |
| 截图目录管理与按期清理 | 无 | **C** |
| 图库布局（宽高比、棋盘格、重试、左右切换） | 官方图库有自己的布局 | 部分重叠 |

处置：保留全部 C 能力；图库位置用官方 slot 替换（priority -1）是观看入口的必要手段，但要意识到它与已删除的 model-search 同类风险：官方以后给图库加的功能默认被这个替换挡住。每次 rc 升级要跑一遍「官方图库/灯箱有没有新能力」检查。

### 2.3 shell-selector

| 功能 | 官方现状 | 判定 |
| --- | --- | --- |
| 终端超时 / 单流输出上限 | 官方「插件 → 终端」卡片（`client/ui-settings-shell`） | A |
| 选 PowerShell 7 / 5.1 / 自定义 `pwshPath` | `shell/pwsh-sandbox` 的 Config 有 `pwshPath`，官方卡片不提供该字段 | **C** |
| 5.1 方言提示（systemPrompt context） | 无 | **C** |
| 路径校验与探测 | 无 | **C** |

处置：保留。页面上写清与官方终端卡片的分工（官方管超时/输出，我们管选壳）。写的是官方 `shell` 命名空间，沿用现有实现即可。

### 2.4 mcp-ui

官方 `mcp/mcp-client` 只支持在 `cordis.patch.yml` 里手写 server 行；`packages/client/` 下没有任何 MCP 配置界面，`ui-plugin-manager` 的通用 `plugins.row.config` 席位也没有 mcp-client 的贡献者。判定：**C 全保留**。

风险：官方已具备「任意行配置页」机制（`plugins.row.config`）。若上游给 mcp-client 补一个伴随 UI，本插件可直接退场。另外增删改路径至今没有实机验证（0 server 状态），这次适配应补上验证。

### 2.5 computer-use

官方现状：

- `computer-use/computer-use`：只有能力 seam（注册服务），**不提供任何模型可见工具**；
- `experimental/computer-use-cua-driver-native` / `-mcp`：会发 npm（`next` = 0.2.1-rc.1），但**没有 `dsh.bundle`**，插件页装不了，只能在组合里手工挂载；没有审批闸门（源码里无 approval/pre-execute）；工具名与 schema 直接复用 Cua Driver 目录。

本插件：13 个 `computer_*` 工具 + 审批 gate + 打开应用复用/唤醒 + DPI 截图 + GNOME Wayland 扩展安装 + 遥测关闭。

判定：**C（官方未产品化）**。保留；不迁移到官方 seam（官方提供方不解决审批与窗口语义）。跟踪上游产品化，如果官方产品化则评估退场。

### 2.6 codex-login（未发布，`private: true`）

官方：`llm/llm-pi-ai` 已有授权 seam 与 OpenAI Codex 的 OAuth 登录方法；Models 页声明了 `settings.models.provider-card`（外部插件扩展位）与 `settings.models.sign-in`（账号引导位）；但仓库里没有任何 provider 登录 UI。

判定：**B（仅缺 UI）**。保留为纯 UI 适配，不复制 OAuth 逻辑。风险：属于未发布在制品，验证依赖真实 ChatGPT 账号。

## 3. 官方未实现的功能清单（插件只该保留这些）

1. **模型兼容开关**：`compat.supportsDeveloperRole`、`compat.forceAdaptiveThinking` 的逐模型 UI（内嵌官方 Models 卡片）。
2. **内置目录路由的推理档位覆盖**：写 `modelOverrides.<id>.reasoningEfforts`（含每档 API 值、`false` 关闭推理）。
3. ~~标题路由 UI~~ **不保留**（已定）：标题路由走官方行 Config，不再由插件提供 UI。
4. **绘图**：绘图模型配置、`generate_image`/`list_image_models` 工具、直接绘图面板。
5. **图像后处理**：缩放平移、标注、裁剪、复制/保存/**发到输入框**。
6. **抓屏与截图管理**：输入框旁抓屏+框选、延时、目录管理、保留策略。
7. **Shell 选择与方言提示**：`pwshPath` UI 与 PowerShell 5.1 上下文。
8. **MCP 服务器配置 UI**：增删改 + 热生效。
9. **桌面自动化产品形态**：13 个 `computer_*` 工具 + 审批 + Wayland/DPI 处理。
10. **Codex OAuth 登录 UI**（实验性）。

## 4. 已定方案（2026-10-17 确认）

**`title-model` 不要了，model-tuning 只留 image-generation（加官方缺口补丁），不拆包。**

model-tuning 3.0.0 的最终边界：

1. **删掉「模型参数」页**。两个 compat 开关与内置目录路由的推理覆盖改为注册官方 `settings.models.provider-card` 扩展位（官方给仓库外插件留的席位），嵌在官方 Models 卡片里；
2. **删掉「用途」页与标题 provider**：不再 `disabled` 官方 `session-title-llm` 行、不再 insert 自己的行、不再 import 标题 helper。标题路由回到官方 Config（profile 的 `cordis.patch.yml`），官方可选包「随对话更新的标题」不再互斥；
3. **保留「绘图」页**（配置命名空间 `models`/`defaultModel` 原样，用户数据不迁移）；
4. `titleMode` / `titleProvider` / `titleModel` / 四个预算字段从 Config 移除（Loader 保留未知键，旧 profile 仍能启动）。

结果：`client.js` 96 KB / 1577 行 → 52 KB / 839 行，`index.js` 420 → 208 行，单测 76 → 26（删除的是参数页/标题页/链接逻辑的测试）。

**曾考虑但未采用**：把标题改成官方行 config 编辑器（仍要自建 UI，收益低）；拆成 `model-compat` / `title-model` / `image-generation` 三个包（官方正以 rc 节奏补齐，拆包迁移成本 > 收益）。

## 5. 其他插件的本轮动作

| 插件 | 动作 |
| --- | --- |
| read-image-preview | 不改功能；补一条 rc 升级检查项（官方图库/灯箱新增能力）；README 标注「替换图库是观看入口，不是跟官方抢功能」 |
| shell-selector | 不改功能；页面文案明确与官方「终端」卡片的分工 |
| mcp-ui | 补实机验证：隔离 profile 里加/改/删一个 MCP server，确认热生效与卸载后仍可加载 |
| computer-use | 不改；只做激活冒烟（避免操作用户桌面） |
| codex-login | 不改；保持 private，等真实账号验证 |

## 6. 实施进度

1. **P1 环境**（已完成）：隔离 home `.dsh-rc-test`、profile `tofu-rc`、五插件 link 安装。
2. **P2 兼容开关迁移**（已完成）：provider-card 扩展组件替换参数页；写入仍走 `llm-pi-ai` 命名空间。
3. **P3 标题页删除**（已完成）：patch 不再 disable/insert，host/client/Config/测试里的标题代码全部移除；预算默认值漂移（旧插件 64 vs 官方 4096）随行替换一起消失。
4. **P4 收窄**（已完成）：参数页、模态、容量、模型搜索、生图链接入口删除；`client.js` 52 KB。
5. **P5 验证**（部分完成）：
   - 单测 24 pass / 2 skip（skip 为需要 `DSH_TEST_DEPLOY_ROOT` 的 pi-ai 耦合守卫）；
   - 隔离 profile `--dump-config`：官方 `session-title-llm` 行恢复为启用态，model-tuning 行只 insert 自身；
   - 隔离 profile 启动冒烟：无 `did not activate`/跳过告警；HTTP 取到新 client bundle（含 `settings.models.provider-card`、无 `sessionTitle`/`titleMode`）；
   - **未做**：真实浏览器里的页面行为清单（官方 Models 卡片出现「兼容与推理」、开关写完后会话日志请求体变化、绘图页出图），需要模型凭据与一次可视化验证。
6. **P6 发版**（未做）：model-tuning 3.0.0 + tofu-box 依赖/patch 已同步（`check-umbrella-sync` 通过），等这批验证完再走 `publish.ps1`。

## 7. 剩余待确认

- 真实页面验证的凭据来源：隔离 home 没有模型 Key；是否允许为验证临时复制 web profile 的 provider 配置（不复制桌面 profile）。
- 发版时机：是否跟 0.2.1-rc.1 这一轮一起发，还是等 0.2.1 正式版（用户口径：rc 即正式版）。

## 8. 证据索引

| 结论 | 官方位置（相对 `deepseek-harness/packages/`） |
| --- | --- |
| Models 页能力 | `client/ui-settings-models/README.zh.md`、`src/client/ProviderEditor.tsx`、`src/client/ModelRow.tsx`、`src/client/operations.ts` |
| 推理档位仅手写路由 | `client/ui-settings-models/src/client/ProviderEditor.tsx`（`reasoningLevelChoices` 受 `declared === true` 门控） |
| 官方标题行 Config 与默认预算 | `session/session-title-first-prompt-llm/src/index.ts`、`bundle/base/cordis.patch.yml`（`session-title-llm` 行，`maxOutputTokens: 4096`） |
| 官方可选标题包 | `experimental/session-titles-bundle/cordis.patch.yml` |
| 图库与原图灯箱 | `client/ui-attachment/README.zh.md`、`src/ImageLightbox.tsx`；`client/ui-tool/README.zh.md`（`read_image` 行） |
| 官方终端卡片 | `client/ui-settings-shell/README.zh.md` |
| MCP 无 UI | `mcp/mcp-client/README.zh.md`；`packages/client/` 内无 mcp 配置界面 |
| 计算机使用仅实验件 | `computer-use/computer-use/README.zh.md`、`experimental/computer-use-cua-driver-{native,mcp}/README.zh.md` |
| Codex 授权 seam | `llm/llm-pi-ai/src/login.ts`、`README.zh.md`；`client/ui-settings-models/src/client/slot-contract.ts` |
| 扩展席位 | `client/ui-settings-models`（provider-card/footer）、`client/ui-plugin-manager`（row/bundle config）、`client/ui-settings`（settings.section） |
| 兼容性门禁变更 | `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md`（`engines.dsh` 优先于 peer） |
