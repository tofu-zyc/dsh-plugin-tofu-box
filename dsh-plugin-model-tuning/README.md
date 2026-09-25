# dsh-plugin-model-tuning

「设置 → 模型调参」页面插件。页面分为**「模型参数」「用途」「绘图」**三个页签。

> **v2.0 合并说明**：本插件现已并入原 `dsh-plugin-title-model`（标题生成独立路由）
> 与原 `dsh-plugin-image-generation`（绘图模型配置、`generate_image` 工具、直接绘图面板）。
> 三个曾经的包现在是一个包、一个设置命名空间（`model-tuning`）、一个 Config schema。
> 原 `title-model` 与 `image-generation` 两个包已从本仓库移除；合并动机与决策记录见文末。

## 功能

### 模型参数

- 按 provider 分组展示当前模型目录；
- 为每个模型配置：
  - 可选推理档位（仅 `llm-pi-ai` 可编辑，其他 provider 只读展示）；
  - 上下文窗口；
  - 最大输出 tokens；
  - 输入模态三态开关（见下）；
  - 系统提示角色兼容开关：`自动` / `system` / `developer`（仅 `llm-pi-ai`，
    写入模型条目的 `compat.supportsDeveloperRole`；遇到 kimi/DeepSeek 等
    报 `role 'developer' is not allowed` 时选 `system`）；
  - 生图模型勾选（把该模型写入「绘图」页签的模型列表，见「绘图页签」）；
- 顶部搜索框按模型名 / ID / 描述 / provider 过滤；
- 修改即时保存（`remote.settings.mutate`；模型目录来自 `remote.session.modelCatalog()`）。

### 用途（标题生成）

按「用途」组织的配置。目前含**标题生成**一项：

- 默认**继承当前会话**已记录的 provider / model（与内置标题生成一致）；
- 也可指定独立的 provider / model，选项全部来自真实模型目录（不提供自由输入框，避免臆造 ID）；
- **标题请求预算也在本页配置**（目标词数 / 汉字数、输入字节上限、输出 token 上限、超时）：
  这些字段是 volatile 配置，写入后按需覆盖插件行的默认值；清空某一项即回到默认；
- 每次生成都重新读取路由与预算，保存后下一次标题生成即生效，**不需要重启宿主**；
- 生效范围是本 profile 之后生成的标题；已有标题、手动重命名、会话的对话模型都不受影响；
- 不提供推理档位控件：标题策略不向标题请求传递 `reasoningEffort`，加一个不生效的控件会误导。
  但这意味着**是否思考由所选模型自己决定**——推理模型会先思考再作答，需要更大的
  「输出上限」（例如 1024）才能在预算内产出标题；直接作答的模型用默认的 64 就够。
  例外：内置 DeepSeek 适配器对 `purpose === "session-title"` 强制关闭思考
  （`dsh-llm-deepseek` 里 `options.purpose === "session-title" ? "off"`），所以
  `deepseek-official` 的模型在默认预算下即可直接出标题；
- 「宿主行未激活」提示只在标题 provider 注册失败（插件半区未启动）时出现。

### 绘图页签

独立配置绘图模型、`generate_image` / `list_image_models` 工具与「直接绘图」面板。
绘图模型不进入聊天模型列表，不改动现有会话存储或对话 provider。

- 添加模型：填供应商 API 地址（默认 `https://api.openai.com/v1`）与 API Key，
  点「获取模型列表」搜索并选择（只请求目录、不生成、不保存草稿 Key；模型 ID 可手填）；
- 也可在「模型参数」页勾选某模型的「生图模型」，自动按该 provider 的
  `baseURL + /images/generations` 与 `apiKeyEnv` 推导出一条配置（带 `source` 溯源标记）；
- 首个模型自动成为默认项；尺寸、质量、超时等高级参数按模型配置；
- 直接绘图面板：短请求启动任务 + 轮询状态 + 取消，不经过聊天模型；
- 协议：OpenAI Images（`POST`，解析 `data[].b64_json` 或 `data[].url`，1–4 张）。

## 配置结构（单一命名空间）

profile 条目 id `model-tuning` 的 Config 字段（volatile，热更新即时生效）：

```yaml
- id: model-tuning
  name: dsh-plugin-model-tuning
  config:
    # ── 绘图（原 image-generation 命名空间字段原样保留） ──
    models:
      - id: my-art
        name: 我的绘图模型
        model: your-model-id
        api: openai-images
        endpoint: https://api.openai.com/v1/images/generations
        apiKeyEnv: IMAGE_API_KEY
        timeoutSeconds: 300
    defaultModel: my-art
    # ── 标题生成（原 title-model 的 mode/provider/model 加 title 前缀） ──
    titleMode: inherit        # inherit | custom
    # titleProvider: tofu-gpt # custom 时必填
    # titleModel: gpt-5       # custom 时必填
    # ── 标题预算（volatile：可在「用途」页改；这里是未改时的默认值） ──
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 64
    timeoutMs: 60000
```

## 它替换了什么（标题行）

宿主自带一行标题生成 provider（`@deepseek-ai/dsh-session-title-first-prompt-llm`）。
`ctx.sessionTitle.register()` **只允许一个 provider，第二次注册直接抛错**，所以本包的
`cordis.patch.yml` 显式替换该行：

```yaml
- id: session-title-llm
  disabled: true          # 必须先摘掉原行，否则 boot 时重复注册会失败
- insert:
    - id: model-tuning
      name: dsh-plugin-model-tuning
      config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 }
```

- **顺序即语义**：`disabled` 必须排在 `insert` 之前，否则两行会同时注册。
- `config` 与 base 的数值逐项相同：**未在「用途」页改动预算时**，删掉本包的 `config:` 块也不改变标题行为；
  页面写入的用户层值会覆盖这些默认值。
- 注册时沿用原 provider id（`session-title-llm`）与原 cadence（`first-prompt`），会话日志里的标题归因不变。
- 标题请求的提示词组装、取消与结果校验沿用宿主共享策略
  （`@deepseek-ai/dsh-session-title-llm` 的 `generateSessionTitleWithLlm`）；
  本插件决定**路由**与**预算**（提示词目标词数 / 汉字数、输入字节上限、输出 token 上限、超时）。
- 卸载本 bundle 会同时移除 `disabled` 与 `insert` 两条 patch，宿主自带 provider 自动恢复。

## 模块解析（重要）

`@deepseek-ai/dsh-session-title-llm` 由**运行本插件的那个部署**提供，而不是从本包目录解析。
原因：本包在工作区里是 `link:` 依赖，若在包内安装该依赖，会连带把 `@deepseek-ai/dsh-llm` 等
peer 装成与部署不同的版本，形成重复模块图。`index.js` 用宿主自身入口锚点
`createRequire(process.argv[1])` 定位并动态 `import()` 该包。

## 输入模态

harness 的请求模态是**闭合集合 `text | image`**：`dsh-llm` 的 `ModelModalityMap` 与
`dsh-llm-pi-ai` 的 `MODALITY_GATE` 都只有这两个成员。**视频没有配置项可开**。

| 选项 | 写入值 | 生效语义 |
| --- | --- | --- |
| `自动` | 删除该字段 | 交由模型条目 → 已安装目录条目 → 路由 `defaultInput`（默认 `[text]`）解析。空数组 `[]` 与「不存在」等价。 |
| `纯文本` | `["text"]` | 显式声明。附图在发送前被拒，`read_image` 同样拒绝。 |
| `文本 + 图像` | `["text", "image"]` | 贴图、`read_image`、MCP 结果图全部可用。 |

- 字段名按 namespace 区分：`llm-pi-ai` 写模型条目的 `input`，`llm-deepseek` 写 `inputModalities`；
- 内置目录 provider 走 `modelOverrides.<id>.input`；
- `llm-deepseek` 从「文本 + 图像」切走会连 `imagePixelBudget` / `imageMaxBytes` / `imageDetail` 一起删除；
- 保存即生效，无需重启 `dsh web`。

> 注意：网关是否真收图像无法从配置读出。开「文本 + 图像」前建议先对端点实测一次。
> 「系统提示角色」开关依赖 DSH 适配层 `dsh-llm-pi-ai` 透传 `compat.supportsDeveloperRole`
>（`0.1.0-rc.6` 默认不透传，需按本仓库 `deepseek-harness` 的 catalog.ts 补丁同步，或等上游合入）。

## 与 DSH 版本的耦合点（0.1.7-alpha.2）

- **provider 目录必须取 `llm.listConfigurableProviders()`**（返回 `LlmConfigurableProvider`
  含 `settingsNs` / `settingsPath` / `declared`）。`llm.listProviders()` 返回的
  `LlmProviderInfo { id, name }` 没有这些字段，用错会让整页控件被禁用。
- 绘图 Remote 面板走 `ctx.connection.rpc.call('/api', 'imageGeneration/<method>', { args })`
  （浏览器半区）× `TypertRemoteService`（宿主半区）。
- 标题 helper `@deepseek-ai/dsh-session-title-llm` 需 `>=0.1.6-alpha.2`；
  `@deepseek-ai/schemastery` 需 `^3.18.4`（`volatile()` 链式方法 3.18.4 才有）。

## 测试

```sh
node --test tests/*.test.mjs                      # 全部（title-provider 需要 DSH_TEST_DEPLOY_ROOT）
# 或分开：
node --test tests/title-route.test.mjs            # 标题路由解析与 Config schema（纯函数）
node --test tests/title-purpose.test.mjs          # 用途页读写规划 + locale 回归
node --test tests/image-link.test.mjs             # 生图链接写入规划（纯函数）
node --test tests/image.test.mjs                  # 绘图传输/工具/Remote（本地 HTTP，不外联）
DSH_TEST_DEPLOY_ROOT=<隔离部署> node --test tests/title-provider.test.mjs   # 真 helper + 假 ctx
```

- `title-provider.test.mjs` 用**假 ctx + 真共享策略**（只 mock `ctx.llm.stream`）验证唯一注册、
  继承/指定路由、首条消息选择、辅助请求记录、失败与取消路径。`tests/_host.mjs` 要求
  `DSH_TEST_DEPLOY_ROOT` 指向隔离的 0.1.7-alpha.2 部署。
- **这些测试不是实机验证**。实机验收：标题从会话日志读 `session/title-llm-request` 的 `route`
  与最终 `session/title` 的 `source.model`；绘图确认「模型参数」勾选 → 绘图页出现条目 →
  直接绘图面板出图。

## 安装 / 卸载

```powershell
dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-model-tuning"
dsh plugin --profile web remove dsh-plugin-model-tuning
```

装/卸后**重启 profile** 生效（composition 在进程启动时组树；patch 层 live 重载只对 config 变更生效）。
卸载后：宿主自带标题 provider 恢复；绘图配置在用户 settings 里的段落成为未注册命名空间的普通文本，
不再被读取；已有图片附件与共享凭据不会被删除。

## 移动端

「容量字段」的「下拉框 + 自定义输入」在**所有视口**都上下堆叠（1.1.1 起）。

## v2 合并决策记录（2026-10）

**合并了什么**：`dsh-plugin-title-model`（宿主侧标题路由）与 `dsh-plugin-image-generation`
（绘图工具/面板）并入本包。9 包 → 7 包。

**为什么**：

1. **UI 早已同居**。「用途」页与「生图模型」勾选本来就在本页，旧结构下同一个页面要跨三个包、
   两个外部命名空间（`title-model`、`image-generation`）读写，任何一处 schema 变更都要双包同步，
   还有专门的跨包契约测试守着同步——这是分布式单体，不是解耦。
2. **卸载粒度论点不成立**。单 profile 部署下不存在「只要绘图不要调参」的场景；且旧结构下卸载
   image-generation 会让调参页的生图勾选静默降级，粒度本来就是假的。
3. **数据迁移可控**。绘图 `models`/`defaultModel` 字段名原样保留；标题 `mode/provider/model`
   改为 `titleMode/titleProvider/titleModel`（一次性迁移 cordis.patch.yml 中的配置块）。

**没合并谁**：`model-search`（占输入栏 slot，崩溃自动回退内置菜单，独立价值明确）、
`computer-use`（原生运行时）、`read-image-preview`（通用图像卡片，刻意为任何图像工具设计）、
`mcp-ui` / `shell-selector`（功能域不同）保持独立。

**迁移指引**（从旧结构升级时）：

1. `cordis.patch.yml` 里原 `- id: image-generation` 块的 `config:` 内容（models、defaultModel）
   原样搬进 `- id: model-tuning` 块；
2. 原用户 settings 里 `title-model:` 段的 `mode/provider/model` 若为 custom，改写到
   `model-tuning:` 段的 `titleMode/titleProvider/titleModel`；
3. 从 profile 移除 `dsh-plugin-image-generation` 与 `dsh-plugin-title-model` 两个 bundle；
4. 重启 profile。
