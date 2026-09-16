# dsh-plugin-computer-use

让模型**看见窗口和桌面并操作鼠标键盘**——v2 起整个后端换装 [Cua Driver](https://cua.ai) 的**进程内 SDK**（`@trycua/cua-driver`，Rust 原生运行时随 npm 包按平台分发，直接加载进 dsh 宿主进程）：**无守护进程、无 MCP、无 PowerShell**，装上即用，跨 Windows / macOS / Linux。

## 打开应用的行为（v2.3 起）

`computer_open` 只做一件事：**能复用就复用，确认没在跑才启动**。它按下面的顺序判断，顺序本身就是设计——"有没有进程"比"有没有窗口"可靠得多：

1. **进程在跑、窗口也在** → 直接复用那个窗口；窗口最小化时先唤醒它再截图；
2. **进程在跑、但没有任何窗口**（微信/企业微信/QQ/钉钉这类应用的托盘态很常见）→ **不动它**，把情况报给你，请你从托盘图标点开。让这类应用重走一遍自己的启动流程，可能把本地登录态弄丢（要重新扫码）；
3. **进程确实不在** → 按应用的启动入口（UWP 用 AUMID，桌面应用用快捷方式里的完整命令行）启动；启动后进程立刻退出、或窗口始终不出现，会明确报出来，不会假装成功。

要让它对第 2 种情况也去试着激活（部分应用点了就恢复），传 `activate_running=true`，或用行配置 `activateRunning: true`。

窗口句柄只当线索用：驱动给的窗口 id 可能在你操作前就失效了，插件会按 pid / 应用名重新取一次。

## v2.4：闲置后的窗口枚举、中文输入、截图存盘

一条真实会话记录（"操作微信给联系人打招呼"）暴露的三个问题，都在这一版修掉：

- **宿主闲置 ~5 分钟后，窗口/应用枚举静默变空。** 驱动的隐式会话闲置即报废，而 `list_windows` / `list_apps` / `launch_app` 之前**不带**命名会话标签——它们挂在隐式会话上，报废后报 "session has ended"，又被插件吞成"没有匹配的窗口"，模型被误导去乱试应用名、最后弃用插件改走 pwsh。v2.4 起**所有**驱动调用统一挂命名会话（查询也不例外），session 卡死按 `end_session 清尸 → start_session 复活 → 重试 → 整个运行时重建` 分级自愈（0.28.1 的 watchdog 数据竞争能把传输层卡死一整个进程生命周期，上游 0.28.2 已修，建议升级）。查询报错也**不再吞成"无窗口"**，原样抛给模型。
- **桌面打字输中文/emoji 必乱码。** 前台 SendInput 要过当前输入法，CJK 与代理对会被损坏（实测：这→！！、👋→🙏）。v2.4 起 `computer_type desktop=true` 遇到非 ASCII 文本自动改走**剪贴板 + ctrl+v**（驱动的 clipboard 工具），打完把你的剪贴板恢复回去（纯文本可恢复；图片等无法保存的剪贴板会被替换，结果里注明）。窗口内打字走 UIA/WM_CHAR，本身就是 Unicode 原生路径，不受影响。
- **桌面坐标给成了物理分辨率不再报错重来。** 模型经常按截图的原生尺寸（如 3200×2000）读坐标，而动作校验的是发给它的缩放帧（1568×980）——v2.4 自动按轴映射进帧坐标并在结果里注明，真正超出物理桌面才报错。
- **`computer_screenshot save="路径.png"`**：把截图写盘（桌面截图保**原生分辨率**，窗口截图保帧上限）并同时放进系统剪贴板，随后 `computer_key desktop ctrl+v` 即可把图贴进聊天框——"发一张证明截图"不再需要 pwsh 绕路（那条路还得自己重新发现 DPI 感知）。

## v2.2：高 DPI 截图与长时间空闲

- **高 DPI 屏幕的截图与坐标。** Windows 上驱动要求宿主进程已是 Per-Monitor-V2 DPI 感知，而 node.exe 不是：缩放屏上桌面截图只覆盖主屏一部分、坐标也随之偏移。v2.2 在驱动启动前把宿主进程切过去，之后所有数字都是真实物理像素（日志里会打印 `host process DPI awareness = per-monitor-v2`）。开关：行配置 `dpiAware`（默认开）。
- **放一会儿再用不再全体报错。** 驱动的会话闲置 5 分钟即报废，且普通调用不会复活它——v2.2 起固定使用命名会话，并在 `session_ended` 时自动复活重试一次。

## 范式：窗口为中心 · 元素优先 · 后台优先

- **元素优先。** `computer_screenshot(app=…)` 返回窗口截图**加**无障碍树元素表（带 `element=` 令牌）；`computer_click(element=令牌)` 走 UIA/AX 直调——对后台、最小化甚至移出屏幕的窗口同样有效，指针全程不动。
- **不抢焦点。** 一切输入默认 `delivery_mode: "background"`（PostMessage/UIA 注入，不动你的鼠标、不前置窗口）。个别拒收后台输入的表面（某些 Chromium/Electron 面）由插件**自动升级一次前台投递**，驱动随后把前台还给原窗口。
- **XAML 组合键兜底。** 现代 XAML/WinUI 应用的快捷键藏在收起的菜单后（如记事本 Ctrl+A），驱动的 UIA Accelerator 路由找不到时，插件自动降级为 `press_key + modifiers` 的**前台 SendInput 真实按键**。（若前台被系统前台锁抢占——比如 dsh 就跑在当前前台终端里——会原样抛回驱动的指引文本，模型改走"点开菜单再点元素"。）
- **KEYBOARD-FIRST 依然。** 所有描述继续引导模型优先 `computer_open` / `computer_key` / `computer_sequence`，像素点击是兜底手段。

## 13 个模型可见工具（全部 `computer_*`）

| 工具 | 作用 |
| --- | --- |
| `computer_screenshot` | 截**窗口**（默认：上一个操作对象；`app=` 任意应用，含最小化/其他显示器）或主桌面总览；窗口截图附带元素表（`element=` 令牌）；`save=路径.png` 额外存盘（桌面为原生分辨率）并放进剪贴板 |
| `computer_windows` | 列全部顶层窗口：pid / window_id / 应用名 / 标题 / 边界 / z 序 / 是否可见 |
| `computer_click` | 元素令牌 / 窗口内坐标 / 桌面坐标三选一；`button` `clicks` `keys`（修饰和弦） |
| `computer_drag` | 窗口内或桌面拖拽（标题栏拖拽自动升前台） |
| `computer_scroll` | 窗口滚动（后台投递，指针不动） |
| `computer_type` | 后台文本注入（字段元素令牌走 UIA SetValue 最稳）；`desktop=true` 打给当前前台应用，非 ASCII（中文/emoji）自动改走剪贴板粘贴，事后恢复剪贴板 |
| `computer_key` | 按键/组合键（XAML 应用自动走前台 SendInput 兜底，见上），`repeat` 1-10 |
| `computer_open` | **打开应用但绝不重复启动**：先在窗口表找已有窗口→复用/唤醒（最小化时 `bring_to_front`）；进程在跑却没有窗口（托盘态）时只报告、请你从托盘点开；确认没在跑才按 `launch_path`/`aumid` 启动 |
| `computer_sequence` | 多步 DSL 一气呵成：`key: / type: / wait: / click:x,y / scroll:dir,n / open:name`，全步先校验后执行，**一次审批一张终图** |
| `computer_zoom` | 窗口区域原生分辨率放大（读小字）；配 `from_zoom=true` 可在放大图上直接点 |
| `computer_cursor` / `computer_move` | 读 / 移动**真实**指针（桌面坐标；后台窗口操作根本不经过指针） |
| `computer_wait` | 等待动画/加载并回一张新截图 |

## 坐标系约定

- 窗口动作：x,y = **该窗口上一次截图**的窗口内像素（顶左原点）。
- 桌面动作（`desktop=true`）：x,y = **上一次桌面截图**的像素；桌面帧由驱动按物理像素捕获（`dpiAware` 生效时即真实分辨率），插件缩到 `maxDim` 以内并自动换算回驱动坐标。给成**物理桌面像素**（截图的原生尺寸）时自动按轴映射进帧并在结果里注明，超出物理桌面才报错。
- 元素令牌只活到**同窗口的下一次快照**——报过期就重新 `computer_screenshot` 再取。
- 驱动对窗口截图自行缩放（`set_config max_image_dimension`）且保持坐标/zoom 映射一致；桌面截图**只覆盖主显示器**——其他显示器上的窗口用 `computer_windows` + `app=` 直接操作窗口，别走桌面坐标。
- Windows 桌面目标当前仅支持 `display_id:"primary"`（驱动上游限制，非主屏没有桌面级截图/点击）。

## 审批

8 个动作类工具（move/click/drag/scroll/type/key/open/sequence）挂在原生 `tools/pre-execute` 审批水路上，默认 `askPolicy: once-per-agent`——**同一会话第一次写操作弹一次批准，之后整轮免批**；行 config 可改 `always` 每次一询、`never` 完全撤掉本插件闸门。截图、列窗口、读光标、zoom、wait 是只读，不审批。审批理由文案会说明"后台注入，不动鼠标不抢焦点"。

闸门**自动跟随会话审批策略**：会话本身处于"不弹审批"模式时（如完全权限下 `approval: never`——此时任何 ask 都会被自动拒绝），本闸门直接放行、由全局权限策略把关，不会自己把自己锁死。

## 行配置（可全部省略）

```yaml
- id: computer-use
  name: dsh-plugin-computer-use
  inject: [tools, attachments]
  config:
    maxDim: 1568               # 模型帧长边上限（px）
    settleMs: 600              # 动作后到结果图的等待（毫秒）
    askPolicy: once-per-agent  # 或 always / never
    telemetry: false           # Cua Driver 运行时的无内容产品遥测，默认关
    dpiAware: true             # Windows：驱动启动前把宿主进程切到 Per-Monitor-V2 DPI 感知
    restore: true              # 允许把已运行应用的最小化窗口唤醒到前台（false = 永不抢焦点）
    activateRunning: false     # 应用在跑但没窗口（托盘态）时，是否让它的启动入口去激活（默认否，只报告）
```

包内 `cordis.patch.yml` 经 `dsh.bundle.patch` 自 wiring，安装即注册这一行，不用手改 profile 配置。

## 图像显示在哪

本包**不带 client 半区**。结果图以 `{type:'image', attachment}` 进入工具结果，由 [`dsh-plugin-read-image-preview`](../dsh-plugin-read-image-preview/README.md) 的通用图像卡渲染（缩略图、点击放大、Ctrl+滚轮缩放、拖动平移；`computer_*` 键已在其 `TOOL_LABELS` 注册）。

## 平台与限制

- **Windows 11 实测**（自测脚本见下）；macOS / Linux 走同一代码路径但**未实测**——macOS 需给运行 dsh 的宿主进程授予"辅助功能/屏幕录制"（TCC）权限，且驱动的 macOS 前台叠加层在进程内形态不可用。
- Windows 高 DPI：启动日志会打印 `host process DPI awareness = …`；正常为 `per-monitor-v2`。若显示 `UNAWARE`（宿主 manifest 或他方抢先固定了感知级别），桌面截图/坐标在缩放屏上不可靠，插件会在每张桌面截图摘要里带显式警告——优先改用 `app=` 窗口操作。
- 桌面截图仅主显示器（窗口级截图不受限）；被最小化的窗口**读树可以、截图不行**，插件会先唤醒它再截——这是唯一会短暂占用前台的动作，`restore: false` 可关掉。
- **窗口枚举可能失灵**：长生命周期的宿主里可能出现 `list_windows` 恒返回 0 窗口（此时桌面截图、光标读取、指定窗口的截图都还正常）。这种情况下按进程判断的部分仍然可靠（不会重复启动应用），但没法定位/点击那个窗口——重启 dsh 可重建枚举。
- 无法向"以管理员权限运行"的窗口注入（Windows UIPI）；前台被终端等前台锁持有者抢占时，需要前台的兜底路径会带回驱动的指引。
- 原生包**没有构建脚本**（纯预编译 DLL/.node/.dylib），pnpm 安装即成功，不需要编译链。

## 自测

```sh
node selftest/run.mjs
```

在真实桌面上跑：启动记事本（**只操作它自己**，全程后台注入），验证 PNG 编解码、弹性坐标映射、13 工具注册、审批闸门、桌面/窗口截图、`save=` 存盘（原生分辨率）+ 剪贴板、元素输入与 UIA 回读、sequence 预校验与执行、zoom、卸载后运行时拒绝，最后自动回收它启动的那个记事本。会动**真实**指针/前台焦点的桌面域工具（桌面点击/拖拽/移动/桌面粘贴）刻意不测。

## 安装 / 卸载

```sh
dsh plugin --profile web add <本包路径或 tgz>   # pnpm 自动拉取本平台的原生运行时（~26 MB）
dsh plugin --profile web remove dsh-plugin-computer-use
```

装/卸后**重启 profile** 生效（composition 在进程启动时组树）。
