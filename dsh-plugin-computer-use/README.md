# dsh-plugin-computer-use

让模型**看见窗口和桌面并操作鼠标键盘**——v2 起整个后端换装 [Cua Driver](https://cua.ai) 的**进程内 SDK**（`@trycua/cua-driver`，Rust 原生运行时随 npm 包按平台分发，直接加载进 dsh 宿主进程）：**无守护进程、无 MCP、无 PowerShell**，装上即用，跨 Windows / macOS / Linux。

## 范式：窗口为中心 · 元素优先 · 后台优先

- **元素优先。** `computer_screenshot(app=…)` 返回窗口截图**加**无障碍树元素表（带 `element=` 令牌）；`computer_click(element=令牌)` 走 UIA/AX 直调——对后台、最小化甚至移出屏幕的窗口同样有效，指针全程不动。
- **不抢焦点。** 一切输入默认 `delivery_mode: "background"`（PostMessage/UIA 注入，不动你的鼠标、不前置窗口）。个别拒收后台输入的表面（某些 Chromium/Electron 面）由插件**自动升级一次前台投递**，驱动随后把前台还给原窗口。
- **XAML 组合键兜底。** 现代 XAML/WinUI 应用的快捷键藏在收起的菜单后（如记事本 Ctrl+A），驱动的 UIA Accelerator 路由找不到时，插件自动降级为 `press_key + modifiers` 的**前台 SendInput 真实按键**。（若前台被系统前台锁抢占——比如 dsh 就跑在当前前台终端里——会原样抛回驱动的指引文本，模型改走"点开菜单再点元素"。）
- **KEYBOARD-FIRST 依然。** 所有描述继续引导模型优先 `computer_open` / `computer_key` / `computer_sequence`，像素点击是兜底手段。

## 13 个模型可见工具（全部 `computer_*`）

| 工具 | 作用 |
| --- | --- |
| `computer_screenshot` | 截**窗口**（默认：上一个操作对象；`app=` 任意应用，含最小化/其他显示器）或主桌面总览；窗口截图附带元素表（`element=` 令牌） |
| `computer_windows` | 列全部顶层窗口：pid / window_id / 应用名 / 标题 / 边界 / z 序 / 是否可见 |
| `computer_click` | 元素令牌 / 窗口内坐标 / 桌面坐标三选一；`button` `clicks` `keys`（修饰和弦） |
| `computer_drag` | 窗口内或桌面拖拽（标题栏拖拽自动升前台） |
| `computer_scroll` | 窗口滚动（后台投递，指针不动） |
| `computer_type` | 后台文本注入（字段元素令牌走 UIA SetValue 最稳；`desktop=true` 改为打给当前前台应用） |
| `computer_key` | 按键/组合键（XAML 应用自动走前台 SendInput 兜底，见上），`repeat` 1-10 |
| `computer_open` | 按名启动应用（含 Store 打包的 AUMID 应用），回其 pid + 首窗截图，前台不动 |
| `computer_sequence` | 多步 DSL 一气呵成：`key: / type: / wait: / click:x,y / scroll:dir,n / open:name`，全步先校验后执行，**一次审批一张终图** |
| `computer_zoom` | 窗口区域原生分辨率放大（读小字）；配 `from_zoom=true` 可在放大图上直接点 |
| `computer_cursor` / `computer_move` | 读 / 移动**真实**指针（桌面坐标；后台窗口操作根本不经过指针） |
| `computer_wait` | 等待动画/加载并回一张新截图 |

## 坐标系约定

- 窗口动作：x,y = **该窗口上一次截图**的窗口内像素（顶左原点）。
- 桌面动作（`desktop=true`）：x,y = **上一次桌面截图**的像素；桌面帧由驱动按 DPI 虚拟化并由插件缩到 `maxDim` 以内，插件自动换算回驱动坐标。
- 元素令牌只活到**同窗口的下一次快照**——报过期就重新 `computer_screenshot` 再取。
- 驱动对窗口截图自行缩放（`set_config max_image_dimension`）且保持坐标/zoom 映射一致；桌面截图**只覆盖主显示器**——其他显示器上的窗口用 `computer_windows` + `app=` 直接操作窗口，别走桌面坐标。

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
```

包内 `cordis.patch.yml` 经 `dsh.bundle.patch` 自 wiring，安装即注册这一行，不用手改 profile 配置。

## 图像显示在哪

本包**不带 client 半区**。结果图以 `{type:'image', attachment}` 进入工具结果，由 [`dsh-plugin-read-image-preview`](../dsh-plugin-read-image-preview/README.md) 的通用图像卡渲染（缩略图、点击放大、Ctrl+滚轮缩放、拖动平移；`computer_*` 键已在其 `TOOL_LABELS` 注册）。

## 平台与限制

- **Windows 11 实测**（自测脚本 27 项全过，见下）；macOS / Linux 走同一代码路径但**未实测**——macOS 需给运行 dsh 的宿主进程授予"辅助功能/屏幕录制"（TCC）权限，且驱动的 macOS 前台叠加层在进程内形态不可用。
- 桌面截图仅主显示器（窗口级截图不受限）；被最小化的窗口可读无障碍树，但截图需要驱动先恢复窗口。
- 无法向"以管理员权限运行"的窗口注入（Windows UIPI）；前台被终端等前台锁持有者抢占时，需要前台的兜底路径会带回驱动的指引。
- 原生包**没有构建脚本**（纯预编译 DLL/.node/.dylib），pnpm 安装即成功，不需要编译链。

## 自测

```sh
node selftest/run.mjs
```

在真实桌面上跑：启动记事本（**只操作它自己**，全程后台注入），验证 PNG 编解码、13 工具注册、审批闸门、桌面/窗口截图、元素输入与 UIA 回读、sequence 预校验与执行、zoom、卸载后运行时拒绝，最后自动回收它启动的那个记事本。会动**真实**指针的桌面域工具（桌面点击/拖拽/移动）刻意不测。

## 安装 / 卸载

```sh
dsh plugin --profile web add <本包路径或 tgz>   # pnpm 自动拉取本平台的原生运行时（~26 MB）
dsh plugin --profile web remove dsh-plugin-computer-use
```

装/卸后**重启 profile** 生效（composition 在进程启动时组树）。
