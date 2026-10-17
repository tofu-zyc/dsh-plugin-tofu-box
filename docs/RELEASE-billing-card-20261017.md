# 发布：billing-card 0.1.0 / tofu-box 1.2.0（2026-10-17）

新增插件 **billing-card**（计费卡片），并把 `tofu-box` 伞包从 1.1.1 升到 **1.2.0**（成员 5 → 6）。

## 发布内容

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-billing-card` | 0.1.0 | 新插件：输入框下方实时显示当前会话按模型统计的 token 用量与估算费用 |
| `tofu-box` | 1.2.0 | 伞包纳入 billing-card（新增 `patches/billing-card.yml`、dependencies、peer 并集） |

## 安装

```sh
# 单装
dsh plugin --profile <p> add dsh-plugin-billing-card

# 或继续用伞包（自动带上 billing-card）
dsh plugin --profile <p> add tofu-box
```

升级已装伞包的 profile：`dsh plugin --profile <p> update tofu-box`（semver 范围，1.2.0 会被拉入）。

## 功能与口径

- Host 注册客户端可见的 Session 投影 `billingUsage`：折叠 `assistant/message` / `assistant/attempt`
  中模型上报的 `usage`，按 `request/header` 归属模型路由；重试的计费尝试也会计入。纯函数、可重放。
- 默认价格来自 DeepSeek 官方「模型 & 价格」页（2026-10-17 核对，中文/英文页）：
  - CNY（空闲时段，元/百万 tokens）：`deepseek-flash` 1 / 0.02 / 4；`deepseek-v4-pro` 4.5 / 0.15 / 13.5；
    旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按 Flash 计。
  - USD：`deepseek-flash` 0.15 / 0.003 / 0.6；`deepseek-v4-pro` 0.66 / 0.022 / 1.98。
  - 高峰时段（北京时间周一至周五 09:00–12:00、14:00–18:00，不含法定节假日）单价为空闲的 2 倍，
    由 `peak` 配置控制；`peak.holidays` 可手填法定节假日。
- 价格表/峰谷规则可通过插件 Config 扩展：`pricing` 规则支持精确或通配 provider+model，
  可加其他厂商模型；未知模型只统计 token、标「未配置价格」，不猜测费用。
- Client 是 `conversation.composer.dock` 里的一枚药丸 + 点击展开的分模型明细卡片，中英双语、主题 token。

## 验证

- `node --test tests/billing-core.test.mjs`：29/29 通过；`node --check` 三个入口全过。
- 用真实会话日志重放 Host 投影，与独立折叠实现逐字段一致；独立 profile 的 Session Controller RPC
  返回的 `billingUsage` 数值与 `input×价 + cacheRead×价 + output×价` 复算一致。
- Client 渲染在桌面端 Harness 实测（药丸金额随会话增长实时变化）；新 profile 的 web 首页已确认
  预加载 `dsh-plugin-billing-card/client.js`。
- 交互（点开卡片）由 client 侧组件断言覆盖；Electron 页面里合成点击不可用，未做自动化点击截图。

## 已知限制

- 会话标题生成、压缩摘要等旁路模型调用的 usage 不写入会话日志，因此不计入。
- 法定节假日不会自动识别（`peak.holidays` 手填）；金额为估算，非官方账单。
- 官方保留调价权利；调价后覆盖 `pricing` 配置即可。
