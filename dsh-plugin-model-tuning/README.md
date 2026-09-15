# dsh-plugin-model-tuning

「设置 → 模型调参」页面插件。

## 功能

- 按 provider 分组展示当前模型目录；
- 为每个模型配置：
  - 可选推理档位（仅 `llm-pi-ai` 可编辑，其他 provider 只读展示）；
  - 上下文窗口；
  - 最大输出 tokens；
  - 输入模态三态开关（见下）；
  - 系统提示角色兼容开关：`自动` / `system` / `developer`（仅 `llm-pi-ai`，
    写入模型条目的 `compat.supportsDeveloperRole`；遇到 kimi/DeepSeek 等
    报 `role 'developer' is not allowed` 时选 `system`）；
- 顶部搜索框按模型名 / ID / 描述 / provider 过滤；
- 修改即时保存（`remote.settings.mutate`；模型目录来自 `remote.session.modelCatalog()`）。

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

## 安装

```bash
cd model-tuning
./install.sh
```

本地开发环境已通过 `$DSH_HOME/profiles/node_modules` 软链和
`cordis.patch.yml` 中的 `model-tuning` insert 启用；改 `client.js` 后刷新
浏览器即可，无需重启 `dsh web`。

## 移动端

「容量字段」的「下拉框 + 自定义输入」在**所有视口**都上下堆叠（1.1.1 起）：
横排时 `.mcfg-select` 的 `width:100%` 占满整行，`.mcfg-custom` 被压到约 18px
宽、几乎不可见。`dsh-plugin-mobile-ui` 早期只在 `@media (max-width:900px)`
里做的堆叠补丁因此变成冗余（保留无害）。

## 回滚

从 `$DSH_HOME/profiles/web/cordis.patch.yml` 删除 `model-tuning` 的 insert
条目并删除对应软链即可。
