# 发布：billing-card 0.2.0 / tofu-box 1.2.1（2026-10-19）

计费卡片新增 **DeepSeek 官方网页搜索 / 抓取 API 的按次费用统计**，并把底部药丸改成只显示费用；
`tofu-box` 伞包从 1.2.0 升到 **1.2.1**（billing-card 依赖 `^0.2.0`）。

## 发布内容

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-billing-card` | 0.2.0 | 新增搜索/抓取按次计费小节；药丸不再重复显示 token；投影 `stateVersion` 升到 2 |
| `tofu-box` | 1.2.1 | 伞包同步 billing-card `^0.2.0`（patch 副本、dependencies、peer 并集） |

## 本次变更

- **底部药丸只显示费用**：会话 token 总量与缓存命中率由 DSH 自带的用量药丸显示，本插件不再重复，
  药丸只保留图标 + `¥金额`，`aria-label` 也只读费用。
- **联网搜索 / 抓取小节**（展开卡片）：从会话日志折叠 `tool/call` / `tool/result`，统计
  `web_search` 调用次数、去重 query 数（= provider 请求数）、预计计费请求数，以及 `web_fetch`
  的成功抓取次数，并按每次 5 元 / $0.75 的价格估算费用。
- **免费期标注**：搜索服务端调用免费至北京时间 2026-11-01 00:00，期间卡片显示「免费期内（11/1 起 ¥…）」；
  `web_fetch` 直连 Fetch API，按官方规则自上线起计费，费用始终正常显示。
- **配置扩展**：`search.enabled` / `search.perRequest` / `search.searchFreeUntil` / `search.trackFetch`，
  与原有 `currency` / `pricing` / `peak` 一样严格校验。
- **投影升级**：`billingUsage` 状态新增 `search` 计数块，`stateVersion` 从 1 升到 2，旧缓存行自动丢弃重折。

## 计费口径（官方，2026-10-19 核对）

- Search / Fetch API 于 2026-10-17 上线，按**成功请求**计费：每 1,000 次 **5 元 / $0.75**；
  失败、空结果、超时不计费，`count` 不影响单价。
- 官方说明：在 DeepSeek Harness / Claude Code / Codex 中经**服务端工具调用**触发的 Search / Fetch
  目前免费，**北京时间 2026-11-01 00:00 起**按次收费。
- 参考：[网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
  · [价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。

## 安装 / 升级

```sh
# 单装
dsh plugin --profile <p> add dsh-plugin-billing-card@0.2.0

# 或用伞包（1.2.1 起带 0.2.0）
dsh plugin --profile <p> add tofu-box

# 已装伞包的 profile
dsh plugin --profile <p> update tofu-box
```

装完刷新页面；旧会话的投影缓存会在 `stateVersion` 变化后自动重折。

## 验证

- `node --test tests/billing-core.test.mjs`：**36/36** 通过（新增 7 个搜索/抓取计费用例）；
  `node --check` 三个入口通过。
- 真实会话日志重放（一个含 7 次 `web_search`、28 次 `web_fetch` 的会话）：搜索 12 个请求 / 预计计费
  12 次 / ¥0.06，抓取 25 次计费 / ¥0.125，与独立复算一致。
- 独立 profile `billing-dev` 重启后，Session Controller RPC 返回的 `billingUsage` 已带 `search` 小节，
  数值与离线重放一致；服务端下发的 Client bundle 已确认 `bc-pill-cost` 在、`bc-pill-tokens` 已移除。

## 已知限制

- 服务端一次 provider 请求内部可能触发 1 次以上 Search（`max_uses`，默认 5），日志不记录实际次数，
  「预计计费」是**下限估算**。
- 多 query 批量搜索失败时，官方可能已按成功部分计费，本插件整单记为失败、不计费（偏保守）。
- 服务端搜索附带的辅助模型 token 费用不写入会话日志，不统计。
- 统计假设 `web_search` / `web_fetch` 由 DeepSeek 官方 provider 提供；改配 Exa / 本地 HTTP 抓取时
  请设 `search.enabled: false`，否则按次费用会误计。
- 金额均为估算值，非官方账单。
