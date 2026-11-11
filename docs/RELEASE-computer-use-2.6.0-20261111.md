# computer-use 2.6.0 / tofu-box 1.2.5 发布说明（2026-11-11）

## 修复：PTC / 完全权限会话下写操作全被拒（自锁）

**现象**：PTC 模式 + 完全权限（danger-full-access）会话里，`computer_click` / `computer_type` / `computer_open` 等 8 个写操作工具一律报 `the user rejected tool "..."`，但用户从未看到审批弹窗；只读工具（截图/列窗口/缩放/光标/等待）正常。

**根因**：审批闸门在 `apply()` 时执行 `const approval = ctx.get('approval')` 并缓存结果。审批服务（dsh-user-approval）可能晚于 computer-use 激活（组合顺序竞态），缓存到 `undefined` 后永不刷新。闸门因此看不到会话的 `never` 策略，按默认发出 ask；完全权限会话里任何 ask 都被审批服务自动拒绝（`decide()` 在 `effectivePolicy === 'never'` 时直接返回 rejected）——工具自锁。PTC 模式本身不改变审批管线（嵌套调用同样携带 agent/session 走 tools/pre-execute），但 PTC 用户更常开完全权限，故在该组合下必现。

**修复**：`sessionRefusesPrompt` 改为**调用时**读取 `ctx.get('approval')`。策略探测（effectivePolicy → overrideOf → config.policy）恢复生效，`never` 会话直接放行，`ask` 会话正常弹窗。

**验证**：rc-dev（dsh 0.2.2-rc.1）+ link 安装 + PTC 执行器 overlay + 本地 mock LLM 走完整真实管线：
- 修复前：`computer_open` 在 pre-execute 挂起 120 s 后 ABORTED_BEFORE_DISPATCH（ask 无应答者）；桌面 PTC 会话实测报 `the user rejected tool "computer_open"`。
- 修复后：`/permission danger-full-access` 同一会话内 `computer_open` 成功启动记事本并回传元素树+截图（后台注入，未抢焦点），测试记事本已回收。
- 驱动升级后 rc-dev PTC 管线 e2e 复测：`computer_open` 经 `run_code` 嵌套调用成功，元素令牌正常。
- 自测 `selftest/run.mjs` **46/46 通过**（0.47.10）：元素树输入回读、窗口点击/滚动/和弦/sequence/zoom、微信托盘态只报告不重启（进程数 5→5）、审批闸门、dispose 回收。1 条 WARN 为 ctrl+a 前台时序边缘（软告警，非失败）。

## 升级：Cua Driver 0.28.3 → 0.47.10

上游 0.29–0.47 的破坏性变化与适配：

| 变化 | 适配 |
| --- | --- |
| `set_config` 删除 `{key, value}` 通用形式，改平铺键 | `set_config({ max_image_dimension })` |
| `get_window_state` 默认只回 markdown 树，`elements` 数组为空 | 显式 `tree_format: 'elements'`（字段与旧版一致，已实测） |
| `get_window_state` 元素树默认上限 5000 → 250 | 显式 `max_elements: 5000` 保持旧行为 |
| **`list_apps.running` 只覆盖有窗口的应用**：托盘态进程报 false，`computer_open` 会误判「没在跑」而拉起第二个已登录实例（自测实测微信被误启动） | 「在跑吗」改查 OS 进程表（Windows `tasklist /FO CSV`，macOS/Linux `ps -axo pid=,comm=`），按清单 exe 名/应用名匹配；`launchAndSettle` 的「进程立刻退出」检测同改 |
| click/type_text/press_key/hotkey/scroll 移除 `element_index`/`snapshot_id` 参数 | 插件一直走 `element_token` 透传，无需改 |
| 多数工具新增 `session` 参数 | v2.4 起全调用已挂命名会话，天然兼容 |
| 新增 4 工具（browser_select/get_guide/run_steps/run_script），共 61 | 不影响现有 13 工具面 |

不变（已逐项核对 0.47.10 的 d.ts 与 listToolsJson 实测 dump）：`callTool` 通用面、`ToolResult`/`ImageContent` 结构、JSON 面整型 window_id、`session_ended` 错误码与命名会话自愈、`CUA_DRIVER_RS_ENABLE_WAYLAND` / `CUA_DRIVER_RS_TELEMETRY_ENABLED` 环境变量。

注意：0.47 起 macOS 上 `CuaDriver.create()` 优先连接 CuaDriver.app 守护进程（未安装则回退进程内并告警）；Windows/Linux 仍纯进程内。macOS 未实机验证。

## 版本与发布

- `dsh-plugin-computer-use` 2.5.2 → **2.6.0**（engines/peers 不变）
- `tofu-box` 1.2.4 → **1.2.5**（依赖 `^2.6.0`，patch 副本无变化，同步校验通过）
- 发布顺序：先发子包再发伞包；npm staged publishing 下用 `npm view <pkg> versions --json` 确认目标版本出现后再验证安装。
