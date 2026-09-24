# dsh-plugin-model-tuning

「设置 → 模型调参」页面插件。页面分为**「模型参数」**与**「用途」**两个页签。

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
  - 生图模型勾选（写入绘图插件的设置，见「与绘图插件的联动」）；
- 顶部搜索框按模型名 / ID / 描述 / provider 过滤；
- 修改即时保存（`remote.settings.mutate`；模型目录来自 `remote.session.modelCatalog()`）。

### 用途

按「用途」而非「模型」组织的配置。目前含**标题生成**一项，由独立宿主包
[`dsh-plugin-title-model`](../dsh-plugin-title-model/README.md) 提供：

- 默认**继承当前会话**已记录的 provider / model（与内置标题生成一致）；
- 也可指定独立的 provider / model，选项全部来自真实模型目录（不提供自由输入框，避免臆造 ID）；
- 每次生成重新读取设置，保存后下一次标题生成即生效，**不需要重启宿主**；
- 生效范围是本 profile 之后生成的标题；已有标题、手动重命名、会话的对话模型都不受影响；
- 不提供推理档位控件：标题策略不向标题请求传递 `reasoningEffort`，加一个不生效的控件会误导；
- 未安装 `dsh-plugin-title-model` 时，用途页显示安装提示而不是报错。

绘图仍单独列出：绘图模型、端点、尺寸、质量属于**图像专有参数**，继续在「绘图」页维护，
本页只显示链接状态并保留「生图模型」勾选，不重复实现端点、凭据或模型发现。

新增文案通过 `ctx.locale.register("dsh-plugin-model-tuning", { en, zh })` 注册。
生产 `dsh-client-locale` 的活动 locale 是 **`zh` / `en`**（不是 `zh-CN`），
因此 `zh` 字典才是中文界面实际取用的那一份；`tests/title-purpose.test.mjs` 对此有回归测试。

## 与绘图插件的联动

勾选某模型的「生图模型」后，本页会在 `dsh-plugin-image-generation` 的
`image-generation` 设置里写入一条绘图配置，供 `generate_image` 工具和
「设置 → 绘图」页使用，无需在两处重复填写端点和密钥。

| 项 | 取值来源 |
| --- | --- |
| 模型 ID | 复用该模型的 ID（如 `ironman/gpt-image-2.5`），不做改写 |
| 生成接口 | 该 provider 的 `baseURL` 去掉尾部 `/` 后追加 `/images/generations` |
| 凭据引用 | 该 provider 的 `apiKeyEnv`（与聊天共用同一个 key） |
| 配置 ID | 由模型 ID 规范化而来（非 `[A-Za-z0-9_-]` 替换为 `-`，冲突时加数字后缀） |
| 其他参数 | 尺寸、质量等留空，可在绘图页按需填写 |

写入的条目带 `source: { provider, model }` 标记，据此划分归属：

- **取消勾选**只删除带该标记的条目；绘图页手工添加的条目不会被删，只会提示；
- 绘图页中带标记的条目**不能删除**（删除按钮禁用），其「配置 ID / 模型 ID /
  生成接口 / 凭据引用」也置为只读并在保存时还原——避免在那边改坏链接；显示名称、
  尺寸、质量、超时等其余参数仍可自由修改；
- 若条目已存在但无标记（绘图页手工建的同名条目，或早期版本写入的），勾选时会
  **就地接管**：只刷新上述属于链接的字段，其余字段保持不变。

链接是单向的（调参页 → 绘图页）。勾选时若绘图页尚无默认模型，会自动把该条目设为
默认，否则 `generate_image` 不指定模型时没有可用的默认项。绘图页的高级设置里不再
需要填写图片下载来源：网关把结果放在哪个主机（如第三方 CDN）都可以直接下载。

> 上游网关可能对「生图」与「图像账号」做不同授权。若生图请求报
> `model_not_found`，先确认该 virtual key 的账号组里没有仅用于生图、
> 不服务该模型的账号——这类失败是上游路由随机选中账号导致的，与本插件的配置无关。

## 输入模态

harness 的请求模态是**闭合集合 `text | image`**：`dsh-llm` 的 `ModelModalityMap`
与 `dsh-llm-pi-ai` 的 `MODALITY_GATE` 都只有这两个成员，`ContentBlockMap` 里唯一的
二进制块也只有 `image`。**视频没有配置项可开**——写 `input: [text, video]` 会被
provider 的 section schema 在写入时拒绝。

| 选项 | 写入值 | 生效语义 |
| --- | --- | --- |
| `自动` | 删除该字段 | 交由模型条目 → 已安装目录条目 → 路由 `defaultInput`（默认 `[text]`）解析。空数组 `[]` 与「不存在」等价，都表示本条不表态，不是「无模态」。 |
| `纯文本` | `["text"]` | 显式声明。附图在发送前被拒（`MODEL_DOES_NOT_SUPPORT_IMAGES`），`read_image` 同样拒绝。 |
| `文本 + 图像` | `["text", "image"]` | 贴图、`read_image`、MCP 结果图全部可用。 |

- 字段名按 namespace 区分：`llm-pi-ai` 写模型条目的 `input`，`llm-deepseek` 写
  `inputModalities`；没有对应字段的 provider 不显示该控件。
- 内置目录 provider 没有 `models` 列表可写，走 `modelOverrides.<id>.input`。
- `llm-deepseek` 的 schema 拒绝纯文本模型携带 `imagePixelBudget` / `imageMaxBytes`
  / `imageDetail`，所以从「文本 + 图像」切走会连这三个字段一起删除，否则下一次
  加载直接报配置错误。
- 保存即生效：适配层按 settings 快照身份 memoize profile，写入换掉快照，下一次
  请求重建模型描述，**不需要重启** `dsh web`。
- 「自动」在内置目录 provider 上显示为不推测：已安装目录的内容不下发到浏览器，
  页面无从得知，猜错会让用户误以为图像已经可用。

> 注意：网关是否真收图像无法从配置读出，harness 也不会去问端点。开「文本 + 图像」
> 前建议先对端点实测一次——少报只是发送前拒绝，多报则图像已经落进会话后被 provider
> 中途拒绝，会话会反复重放一个不可能成功的请求。

> 注意：「系统提示角色」开关依赖 DSH 适配层 `dsh-llm-pi-ai` 透传
> `compat.supportsDeveloperRole`（`0.1.0-rc.6` 默认不透传，需按本仓库
> `deepseek-harness` 的 catalog.ts 补丁同步，或等上游合入）。否则开关保存后
> 会被适配层丢弃、不生效。

## 与 DSH 版本的耦合点（0.1.2-rc.1）

- **provider 目录必须取 `llm.listConfigurableProviders()`**。`llm.listProviders()`
  返回的是 `LlmProviderInfo { id, name }`（已注册路由的元数据），**没有**
  `settingsNs` / `settingsPath`。本页按 `p.provider` 建索引并据此读写命名空间，
  用错会让每个模型分组都查不到 `entry`，`configurable` 恒为 `false`——整页控件
  被禁用、推理档位显示「由 provider 固定」。官方
  `dsh-client-ui-settings-models` 用的同样是 `listConfigurableProviders()`。

## 测试

```bash
node tests/image-link.test.mjs     # 绘图联动的写入规划（既有）
node tests/title-purpose.test.mjs  # 用途页：标题设置读写规划 + locale 回归
```

两个文件都以「解析 bundle 但用桩 React、不运行页面」的方式取出纯函数，因此
**不覆盖渲染**：页面实际长什么样、保存是否真的落到设置里，需要在已安装的页面上
当场验证。

## 安装

```bash
cd model-tuning
./install.sh
```

本地开发环境已通过 `$DSH_HOME/profiles/node_modules` 软链和
`cordis.patch.yml` 中的 `model-tuning` insert 启用。

改 `client.js` 后能否免重启刷新取决于是否在跑 `pnpm run dev:web`：**该 watcher
没有运行时，浏览器端 bundle 不会重建**，刷新页面拿到的仍是旧产物；此时需要让
宿主重启（或在 checkout 里跑 `pnpm run dev:web`）后才会加载新代码。安装/更新
bundle 时同理：以 `plugin_manager` 返回的 `applied` / `restart-required` 为准，
不要假定保存即生效。

## 移动端

「容量字段」的「下拉框 + 自定义输入」在**所有视口**都上下堆叠（1.1.1 起）：
横排时 `.mcfg-select` 的 `width:100%` 占满整行，`.mcfg-custom` 被压到约 18px
宽、几乎不可见。`dsh-plugin-mobile-ui` 早期只在 `@media (max-width:900px)`
里做的堆叠补丁因此变成冗余（保留无害）。

## 回滚

从 `$DSH_HOME/profiles/web/cordis.patch.yml` 删除 `model-tuning` 的 insert
条目并删除对应软链即可。
