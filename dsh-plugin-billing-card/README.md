# dsh-plugin-billing-card（计费卡片）

在 DeepSeek Harness 的输入框下方实时显示**当前会话**的 token 用量与估算费用，按模型分项统计，
默认内置 DeepSeek 官方价格（含**峰谷分时计价**），并保留完整的扩展能力：价格表、峰谷规则、
其他模型/提供商都可以在插件配置里追加，不需要改代码。0.2.0 起同时统计 **DeepSeek 官方网页搜索 /
抓取 API** 的调用次数与按次费用（Search 服务端调用免费至 2026-11-01 00:00，之后按每 1000 次
5 元估算）；0.3.0 起卡片按当前**实际生效的 provider** 标注——服务端搜索（`deepseek-official`）、
直连 Search / Fetch API（`deepseek-search-api` / `deepseek-fetch-api`）、本地 HTTP 抓取（`http`）
各按自己的计费口径显示，不会再把本地免费抓取或直连 API 标成「免费期内」。

> npm：[`dsh-plugin-billing-card@0.3.0`](https://www.npmjs.com/package/dsh-plugin-billing-card)
> · `tofu-box@1.2.2` 起包含本版本。
>
> 兼容性：`engines.dsh` 声明为 `>=0.2.0-rc.2 <0.3.0-0`，已实测运行于 dsh **0.2.1-rc.3**。

- **Host 半**：注册一个客户端可见的 Session 投影单元 `billingUsage`，在提交事件时折叠
  `assistant/message` / `assistant/attempt` 中模型上报的 `usage`（按 `request/header` 归属模型路由），
  并折叠 `tool/call` / `tool/result` 里的 `web_search` / `web_fetch` 调用来估算按次费用；
  纯函数、可重放、不产生任何模型调用。
- **Client 半**：在 `conversation.composer.dock`（输入框下方的环境条目区）新增一个
  `billing-card` 条目；平时是一枚只显示估算费用的小药丸（token 总量已由 DSH 自带用量药丸显示，
  这里不重复），点开后是明细卡片。

> 显示的是**按 token 数、按次价格与价格表计算的估算值**，不是官方账单。实际扣费以 DeepSeek 账单为准。

## 显示内容

药丸（收起态）：`¥0.0123`。只显示估算费用——会话 token 总量与缓存命中率已由 DSH 自带的用量药丸
显示，不重复占位。鼠标悬停/读屏可读到「预估费用 ¥…」。

卡片（展开态）：

- 本会话估算总费用；若包含高峰时段计价的 token，会标注「含高峰计价」。
- token 汇总：缓存未命中输入、缓存命中输入（及命中率）、输出、合计。
- 按模型分项：模型名、token 数、估算费用；没有配置价格的模型显示「未配置价格」，
  token 仍计入合计，但不计入费用。
- 联网搜索小节（本会话有搜索/抓取调用时出现）：搜索调用次数、provider 请求数、预计计费请求数、
  搜索费用、抓取次数；标注随当前 provider 变化——服务端搜索免费期内显示「免费期内（11/1 起 …）」，
  直连 API 直接显示按次费用，本地 HTTP 抓取显示「免费」。

会话还没有任何已结算的 token 用量时，卡片不显示（不会占位、不会报错）。

## 安装

已发布 npm：`dsh-plugin-billing-card@0.3.0`，同时也是 `tofu-box` 伞包（1.2.2 起）的成员。
插件行 id 为 `billing-card`，Client 半是手写浏览器模块，无需构建步骤。

```bash
# 1) 单装（npm）
dsh plugin --profile <你的profile> add dsh-plugin-billing-card

# 2) 或装整套伞包（自动包含本插件）
dsh plugin --profile <你的profile> add tofu-box

# 3) 开发/未发版：从本仓库本地目录安装（link 方式，改代码不用重装）
dsh plugin --profile <你的profile> add D:\program\dsh-plugins\dsh-plugin-billing-card
```

> 建议先在一个**独立 profile** 里验证，不要装进你日常使用的 `desktop` profile：用官方 web 模板新建
> `dsh --profile billing-dev --from-default-profile web --dump-config`，装好后
> `dsh --profile billing-dev --no-open --port 58121` 启动（日志会打印带一次性 `?token=` 的地址）。

> 新装的 Client 模块需要页面刷新一次才会加载；旧会话的投影基线也在刷新/重连后才会带上
> `billingUsage`，刷新后输入框下方就会出现计费药丸。

如果是在当前会话里用 `plugin_manager` 安装（会让该 profile 的所有会话生效），写法是：

```
plugin_manager install_bundle target = D:\program\dsh-plugins\dsh-plugin-billing-card
```

如手工维护 profile 的 `cordis.patch.yml`，等价写法是：

```yaml
- insert:
    - id: billing-card
      name: dsh-plugin-billing-card
```

## 默认价格表（官方价格，绑定于 2026-10-17）

计价口径：1) **缓存未命中输入** = `TokenUsage.inputTokens`；2) **缓存命中输入** =
`TokenUsage.cacheReadTokens`；3) **输出** = `TokenUsage.outputTokens`；4) `cacheWriteTokens`
默认按 0 元计（DeepSeek 不单独收缓存写入费），可用规则覆盖。

官方页面把**空闲时段价格**写成高峰时段的一半；本插件以空闲时段价格为基础价，
`peak.multiplier`（默认 2）在高峰时段生效。

### 人民币（默认 `currency: CNY`，单位：元 / 百万 tokens，空闲时段基础价）

| 模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | 1 | 0.02 | 4 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro） | 4.5 | 0.15 | 13.5 |
| `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`（旧名，按 Flash 计价） | 1 | 0.02 | 4 |

高峰时段（北京时间，周一至周五，不含中国法定节假日）：**09:00–12:00、14:00–18:00**；
其余时间（含周末与法定节假日全天）为空闲时段。

### 美元（`currency: USD`，单位：美元 / 百万 tokens，空闲时段基础价）

| 模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.15 | 0.003 | 0.6 |
| `deepseek-v4-pro` | 0.66 | 0.022 | 1.98 |
| `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` | 0.15 | 0.003 | 0.6 |

> 价格来源：DeepSeek 官方「模型 & 价格」页（中文 / 英文），核对时间 2026-10-17。
> 官方保留调价权利，请以官网与你的实际结算为准；调价后覆盖本插件配置即可。

## 联网搜索 / 抓取计费（0.3.0）

官方口径（Search / Fetch API，2026-10-17 上线）：

- 按**成功请求次数**计费：每 1,000 次成功请求 **5 元 / $0.75**；失败、空结果、超时不计费，
  `count` 只控制返回条数、不影响单价。
- 在 DeepSeek Harness / Claude Code / Codex 中由**服务端工具调用**触发的 Search / Fetch 目前免费，
  **北京时间 2026-11-01 00:00 起**按次收费；而直连 API（`web.searchProvider: deepseek-search-api` /
  `web.fetchProvider: deepseek-fetch-api`）自上线起就按次计费，没有免费期。
- 本插件从会话日志统计（不额外发请求）：
  - `web_search`：每次工具调用按**去重后的 query 数**计为 provider 请求数（工具本身就是每个
    query 发一个请求）；一次调用成功且结果源非空时，这些 query 计为「预计计费请求」。
  - `web_fetch`：按 HTTP 200 的成功抓取计为一次抓取请求。
- 费用 = 预计计费请求数 × `search.perRequest`（默认 0.005 元/次，美元 0.00075/次）。
- 卡片读取当前 `web` 行的 `searchProvider` / `fetchProvider`（「设置 → 插件 → Web 搜索」里的
  「启用新版 Web 搜索 API」开关写的就是这两个字段），据此标注：

  | 生效 provider | 搜索费用标签 | 抓取费用标签 |
  |---|---|---|
  | 服务端 Messages 搜索 `deepseek-official` | 免费期内显示「免费期内（11/1 起 ¥…）」 | —（默认抓取是 `http`） |
  | 直连 Search / Fetch API | 直接显示按次费用，并注明没有服务端免费期 | 显示 `次数 · 费用` |
  | 本地 HTTP 抓取 `http` | — | 显示 `次数 · 免费`，并注明不计费 |
  | 其他 provider（Exa / Perplexity 等） | 只显示按次估算，不声称免费期 | 同上 |

  读不到设置时按出厂默认（`deepseek-official` + `http`）标注，不会因此隐藏卡片。

已知限制（估算口径）：

- 服务端一次 provider 请求内部可能触发 1 次以上 Search（`max_uses`，默认 5），日志不记录实际
  次数，因此「预计计费」是**下限估算**。
- 多 query 批量搜索失败时，已成功的那部分可能已被官方计费，但这里整单失败、不计费；
  空结果的成功调用不计费（与官方一致）。
- 服务端搜索附带的辅助模型 token 费用不写入会话日志，本卡片不统计。
- 计数只按工具名（`web_search` / `web_fetch`），不区分 provider；换用 Exa / Perplexity 等
  第三方 provider 时次数仍会累计，卡片只会显示按 `search.perRequest` 的估算而不声称官方口径。
  这类部署若不想看到按次费用，把 `search.enabled` 设为 `false`。

## 配置

配置写在插件行 `billing-card` 的 `config` 里（profile 的 `cordis.patch.yml` 对整行 `config`
的覆盖会整表替换，未写的可选项使用默认值）。所有字段都有严格校验：拼写错误、负数、
非法时间窗口会直接报错并指出配置路径，不会静默忽略。

```yaml
- id: billing-card
  config:
    currency: CNY          # CNY | USD，默认 CNY

    # 追加/覆盖价格规则；优先于内置默认表，按顺序取第一条命中的规则。
    pricing:
      - provider: '*'      # 精确 provider 路由或 '*'，默认 '*'
        model: deepseek-flash
        inputPerM: 1       # 缓存未命中输入，元/百万 tokens
        cacheReadPerM: 0.02 # 缓存命中输入
        cacheWritePerM: 0  # 可选，默认 0
        outputPerM: 4
        peakMultiplier: 2  # 可选，默认取 peak.multiplier

    # 峰谷规则（默认即下方深色默认值，可整体调参或关闭）
    peak:
      enabled: true
      utcOffsetMinutes: 480        # 北京时间 UTC+8
      weekdays: [1, 2, 3, 4, 5]    # 周一=1 … 周日=7
      windows: [['09:00', '12:00'], ['14:00', '18:00']]
      holidays: []                 # 例：['2026-10-01', '2026-10-02']；列出的当地日期全天按空闲计价
      multiplier: 2

    # 联网搜索 / 抓取按次计价（0.2.0 起，默认即下方值）
    search:
      enabled: true                # false = 完全关闭搜索/抓取统计
      perRequest: 0.005            # 每次成功请求的价格（当前币种）；默认 CNY 0.005 / USD 0.00075
      searchFreeUntil: 2026-10-31T16:00:00.000Z  # 搜索服务端调用的免费截止（北京时间 11/1 00:00）；null = 已计费
      trackFetch: true             # 是否统计直连 DeepSeek Fetch API 的 web_fetch 调用
```

### 支持其他提供商 / 模型

规则的匹配优先级是：用户规则（精确 provider + 精确 model → 精确 provider + `model: '*'` →
`provider: '*'` + 精确 model → 全通配）→ 内置默认表。因此：

- 换用美元计价：`currency: USD`（内置美元表）。
- 给自建/第三方模型定价（例如经 OpenAI 兼容端点接入的 GLM）：

```yaml
- id: billing-card
  config:
    pricing:
      - provider: llm-pi-ai
        model: GLM/glm-5.3
        inputPerM: 2
        cacheReadPerM: 0.5
        outputPerM: 8
      - provider: llm-pi-ai      # 该 provider 下未单独定价的模型统一兜底
        model: '*'
        inputPerM: 2
        cacheReadPerM: 0.5
        outputPerM: 8
```

- 某提供商有自己的一套峰谷/折扣规则：给它的规则单独设置 `peakMultiplier`，
  或把全局 `peak.enabled` 设为 `false` 后按固定价计。

> 规则里的 `currency` 默认等于全局 `currency`；写别的币种会被忽略（不会混币种加总）。

## 数据口径与已知限制

- token 数来自会话日志里模型**上报的 usage**（与 Harness 内置 token 统计同源），不是本地估算；
  失败重试的尝试（`assistant/attempt`）与成功回复都计费，重试会被识别为独立计费尝试。
- 费用 = token 数 × 价格表；高峰/空闲按**该条 usage 在日志中记录的时间**判定，
  事件时间是持久化的，因此重放、恢复、fork 后结果一致。
- **辅助调用暂不计量**：会话标题生成、压缩摘要等旁路模型调用的响应 usage 不写入会话日志，
  因此不计入本卡片；如后续 Harness 落盘这类 usage，只需扩展折叠的事件类型。
- **法定节假日不会自动识别**：官方规则里中国法定节假日按空闲计价，插件无法内置年年变化的
  节假日表，请在 `peak.holidays` 里按需填写；不填写时只按「周一至周五 + 时间窗口」判断。
- 金额为估算值，浮点计算后仅用于展示（保留 2–4 位小数）；并发上限、搜索/抓取等按次计费的
  接口按上面的口径估算，不是账单金额。

## 结构

```
dsh-plugin-billing-card/
├── package.json         # dsh.bundle（profile 补丁）+ dsh.client（浏览器模块）+ 导出元数据
├── cordis.patch.yml     # 插入 billing-card 行（不改动任何官方行）
├── index.js             # Host：校验配置并注册 billingUsage 投影
├── billing-core.js      # Host 纯逻辑：事件折叠、价格解析、峰谷判定、视图构建、结构校验
├── client.js            # Client：输入框下方药丸 + 展开卡片（手写浏览器模块，免构建）
├── locale/{en,zh}.json  # 插件管理器里的标题/描述
├── icon.svg             # 插件图标
└── tests/billing-core.test.mjs  # node --test 单元测试
```

Host 半零运行时依赖；Client 半只使用浏览器模块表里的 `react` / `react-dom`。

## 开发

```sh
cd dsh-plugin-billing-card
node --check index.js && node --check billing-core.js && node --check client.js
node --test tests/*.test.mjs
```

## License

MIT
