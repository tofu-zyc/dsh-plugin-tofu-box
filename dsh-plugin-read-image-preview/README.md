# dsh-plugin-read-image-preview

把**任何工具产出的图片直接画在会话里**——`read_image` 读的文件图，和 computer-use 截图这类**结果附件图**，共用同一张卡片与同一套交互；并且就地放大、圈红框、加字、复制走人，不用再为了「让模型看一下这个前端问题」去装一个外部截图器。

## 通用模式

注册时一次认领所有图像工具（`tool.call.toolview` 的对应键，priority `-1`），**只有一条数据通路**：结果 content 里的 `{type:'image', attachment}`，字节经会话授权的 `props.loadImage`（先 `peek` 缓存）取，像素尺寸、体积、格式、降采样前的原图尺寸全在附件引用上，零额外请求。

> **v1.5 起删掉了 `file` 轨。** 早期版本为 `read_image` 单独开了一条 Host 回环路由 `/read-image-preview/resolve`：按路径读盘、嗅探魔数、解析像素尺寸、签 token。DSH 0.1.7 起 `read_image` 的结果本身就携带同样的持久化附件引用（官方卡片也用它），这条通路与宿主完全重复，已移除。`read_image` 的 `file_path` 参数只用来给卡片起名、复制路径、在编辑器中打开；执行中显示骨架和路径，结果回来才出图。

没有图也没有报错的调用渲染一行结果摘要（失败标红），执行中渲染按真实宽高比撑开的骨架——认领的行永远不会是空壳。

**v1.4.1：图片加载零位移。** 图片像素尺寸在字节到达之前就已知（附件引用），因此 `<img>` 直接带 `width/height` 渲染、信息行宽度也按已知比例预先定死。晚到的图片（上一张截图的 fetch/解码在新内容压上来之后才完成）落地时不再产生布局跳变——正是这个跳变会让 DSH 聊天流的吸底逻辑把浏览器自发的位移误读成「用户上滚」，从而停止自动跟随最新记录。

**dsh 0.1.7-rc.1 起工具调用分三阶段。** 官方把 `RunningToolCall` 拆成 `preparing`（参数还在流式生成，**没有 `argsRaw`**）与 `start`，并且参数开始流动时就把视图渲染出来（`tool.call.toolview` 的 owner 多了 `phase`）。因此判定「执行中」不能再只看 `argsRaw` 是否存在，否则我们认领的行在整个 preparing 阶段会是空壳——`isRunningBlock()` 现在把 `phase: 'preparing' | 'start'` 都算执行中，形状判断继续兼容更早的版本。`tests/phases.test.mjs` 用官方三种形状锁住这条约束（设 `READ_PREVIEW_CLIENT` 指向未修复的 `client.js` 可以验证它确实会失败）。

**接入新工具 = 在 `client.js` 的 `TOOL_LABELS` 加一行**，交互（缩略图、点击放大、滚轮、拖动、双击适应、骨架、透明棋盘格）全部自动继承。

## 它解决什么

DSH 自带的 `read_image` 卡片（`dsh-client-ui-tool` 的 `read-image-toolview`）有三个让人看不到图的地方：

1. 图片是 `ToolRow` 展开区里的内容，**默认折叠**，不点开那一行就没有画面；
2. 官方派生逻辑明确写着运行期的调用没有 content，所以 **AI 正在看图的那几秒卡片里是空的**；
3. 折叠状态只有一行路径摘要。

这个插件接管这些工具的展示位（`tool.call.toolview` 的对应键，priority `-1`，同时遮蔽内置行与动态插件的兜底卡片），把图片提到最外层：

- 执行中就出骨架与路径，结果一到立刻出图；
- 加载中是按**真实宽高比**撑开的骨架（扫光动画，`prefers-reduced-motion` 下停用）；
- 图下一行信息：状态点（蓝闪=正在看 / 绿=看完 / 红=失败）、路径、像素尺寸、体积、格式；
- 默认是克制的缩略图（`min(420px, 100%)` × `max-height: 300px`），不占聊天流；
- **点图进入全屏查看器**（手势见下），透明容器（PNG/WebP/GIF）自动铺棋盘格；
- 操作：复制路径、在编辑器中打开、**标注**。

## v1.5：查看器手势、标注、抓屏、截图管理

这一版对着三件真实的别扭来的。

### 1. 关闭：点暗处和明确按钮，两条路都在

毛病不是「点图外面能关闭」，而是**只有**这一条路，并且唯一的 `✕` 长在右上角——而**桌面端的三个窗口按钮是操作系统画在网页之上的**（Electron 的 WCO：`titleBarStyle: 'hidden'` + `titleBarOverlay`），任何 `z-index` 都盖不住它、也压不掉它的悬停高亮。于是那枚 `✕` 和窗口的「关闭」并排长在一起，鼠标一抬起来就分不清点的是图片的关闭还是窗口的关闭。所以两条路都留着，别扭的那一半用几何避让解决：

- 查看器根节点 `padding-top: var(--dsh-frame-overlay-top, 8px)`（宿主在 `html` 上公布的净空：Windows 60 / macOS 68 / 全屏 20），**画面与所有控件都待在原生标题栏净空以下**；
- 右上角**不放任何本插件的控件**，`✕ 关闭` 挪到顶部**居中**一行，底部操作条右端再放一枚 `关闭 (Esc)`；
- **点图片外的暗处照旧关闭**（手最快的那条），按钮是补上的第二条路：Esc、点暗处、点 `✕ 关闭`、点底部 `关闭 (Esc)` 都能关；
- 说清楚什么不算「点暗处」：拖动过（那是平移）、落在图上、标注中、还有没导出的裁剪区域——这四种情况都不会被一下误关，标注里的活儿不会被随手一点丢掉；
- 根节点带 `-webkit-app-region: no-drag`，绝不把覆盖层变成窗口拖拽把手。

`tests/gestures.test.mjs` 把这条约束写成了断言：树里必须有关闭控件、点暗处要触发关闭、落在操作条上不触发，以及样式表里不得再出现右上角定位的规则。

### 2. 滚轮：不按住任何东西就是缩放

| 手势 | 行为 |
| --- | --- |
| 滚轮 | 以光标为锚连续缩放（0.05×–8×） |
| **Shift + 滚轮** | 图片溢出时**上下平移** |
| **Ctrl + 滚轮** | 图片溢出时**左右平移** |
| 按住拖动 | 平移（未选标注工具时） |
| 双击图片 | 回到「适应窗口」 |
| 点图片外的暗处 / `Esc` | 关闭（和顶部 `✕ 关闭`、底部 `关闭 (Esc)` 一样有效） |
| `+` `-` `0` `f` | 放大 / 缩小 / 100% / 适应窗口 |

实现细节：Windows 浏览器会把 Shift+滚轮报成**横向** delta，所以取「哪个 delta 动了」而不是死读 `deltaY`；`deltaMode` 为行/页时按 33px / 400px 折算，触控板与滚轮鼠标手感一致。监听器注册为 `{ passive: false }` 并始终 `preventDefault`，滚轮不会同时滚动底下的聊天流。

已知代价：触控板的捏合缩放在浏览器里就是 `Ctrl+滚轮`，因此在本查看器里捏合会被当成左右平移——这是按用户明确要求的键位映射来的，需要捏合缩放时用滚轮或 `+`/`-`。

### 3. 标注 → 复制 + 存盘

在查看器里点「标注」（或卡片信息行的「标注」）即可就地画：

- 工具：**移动 / 矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 裁剪**；6 色（红打头）、3 档线宽；
- 撤销 / 重做 / 清空 / 取消裁剪，`Ctrl+Z`、`Ctrl+Shift+Z`、`Delete` 撤销最后一个标记，`Ctrl+S` 保存；
- 标注画在覆盖于图片的 `<canvas>` 上，坐标一律是**源图像素**，所以放大到 400% 线条仍然清晰（图层按缩放倍数加深位图，上限 3×），导出与所见完全一致；
- **裁剪**是一块状态区域（外面压暗、边缘虚线），导出时只出这一块；
- 出口有两个：**复制到剪贴板**（`navigator.clipboard.write` + `ClipboardItem`，回聊天框直接 `Ctrl+V` 就能发给模型）和**保存到截图目录**；「保存并复制」一次做两件事，并在底部把落盘路径显示出来，旁边是「复制路径」。

> 为什么终点是剪贴板而不是「插入到输入框」：会话作用域的 `inputActions.addAttachments` 不是对插件稳定的表面，绑上去迟早被升级打断。复制到剪贴板 + 给出路径，是既够用又不会腐坏的接口。

### 4. 一键抓全屏

输入框右侧多了一枚 **`✂ 截图`**：左键立刻抓全屏，**右键选延时**（立即 / 1 / 3 / 5 秒，选择会记住）——延时是为了那些「一点输入框就消失」的画面。抓到的是一张**冻结的位图**，直接进标注模式并预选裁剪工具。

- Host 半区用一条 PowerShell 完成抓屏：先 `Application::SetHighDpiMode(PerMonitorV2)` 再 `CopyFromScreen`，所以拿到的是**真实像素**（本机 3200×2000，约 0.6 秒 / 580 KB）而不是 DPI 虚拟化后的糊图（1600×1000）；
- 优先 `pwsh`（7+），失败回落系统 `WindowsPowerShell 5.1`；macOS 用 `screencapture`，Linux 依次试 `grim` / `gnome-screenshot` / `spectacle` / `scrot` / `import`；
- 抓屏结果以 `image/png` 直接回给页面，不做 base64 往返。

**没有全局热键**：页面拿不到全局快捷键，抢一个本地组合键又容易和宿主/输入框打架，所以只做按钮。

### 5. 截图管理与定期清理

设置 → **截图与标注**：缩略图网格（懒加载）、复制路径、删除、打开目录、立即清理、加载更多，以及当前生效的保留策略。

落盘位置默认 `~/.dsh/screenshots/`（可用下面设置项改到别处，支持 `~` 与相对路径，相对路径挂在 `~/.dsh` 下）。清理策略：

- **按时间 + 按数量 + 按体积**三重上限，谁先到听谁的，从最旧的开始删；
- 只在启动后 8 秒与按 `cleanupIntervalMinutes`（默认 360 分钟）的心跳上运行，两个定时器都 `unref()`，绝不会成为吊住进程的东西；
- **只删本插件按 `shot-YYYYMMDD-HHMMSSmmm-xx.png` 命名的文件**——把目录指到存了别的东西的文件夹，也不会被策略清掉。

## 设置项

设置页里本插件自己那一节（字段都会即时生效）：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `screenshotDir` | 空 = `~/.dsh/screenshots` | 截图落盘目录 |
| `retentionDays` | `7` | 保留天数，`0` = 不按时间清 |
| `retentionMaxFiles` | `300` | 目录里最多留多少个 |
| `retentionMaxMb` | `500` | 目录最多占多少 MB |
| `cleanupIntervalMinutes` | `360` | 定期清理间隔（最小 5） |
| `captureDelaySeconds` | `0` | 抓屏默认延时，页面里的延时菜单可以临时覆盖 |

## 两半的分工

Slot 视图没有文件权限，所以字节要走页面自己的传输：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 截图目录的能力 token；抓屏、落盘、列表、删除、按期清理；服务下列回环路由（不读取任何工具传入的路径） |
| Client | `client.js` | 接管图像工具展示位、全屏查看器、标注画布、抓屏入口、截图管理页 |

路由（全部在插件私有前缀上，每条都先过 `connection.requestRejection`，取不到该服务时一律 503 —— 宁可不可用，不放开一个读写文件的口子）：

- `GET /read-image-preview/<token>` → 截图字节，供管理页缩略图与查看器使用（token 只由 list / save 签发）
- `GET /read-image-preview/state` → 目录、平台、保留策略、抓屏可用性
- `GET /read-image-preview/list?limit=&offset=` → 分页的截图清单（缩略图直接复用 token 路由）
- `POST /read-image-preview/save`（请求体是 PNG 字节）→ 落盘结果与路径
- `POST /read-image-preview/delete?name=…` · `POST /read-image-preview/cleanup` · `POST /read-image-preview/open`
- `POST /read-image-preview/capture?delay=` → `image/png` 字节

安全边界：只放行 PNG / JPEG / WebP / GIF 四种位图；URL 里带的是不透明 token 而非路径，且 token 只指向截图目录里的文件，页面无法让宿主读取任意路径；`save` 只写 PNG 魔数、只写截图目录、文件名由宿主生成且不接收任何路径分隔符；`delete` 只接收单段文件名。**不向 Cordis 服务命名空间发布任何东西**，不会和别的插件撞名。

## 测试

```sh
cd dsh-plugin-read-image-preview
npm test    # node --test tests/*.test.mjs
```

- `tests/phases.test.mjs` —— 工具调用三阶段形状；
- `tests/gestures.test.mjs` —— 滚轮三档映射、标记绘制几何与裁剪、关闭方式与右上角几何约束、新增 slot 贡献；
- `tests/shots.test.mjs` —— 保留策略、抓屏脚本（先提 DPI 精度再取屏幕）、逐平台命令序列、存/查/删/清路由与鉴权围栏。

## 已知取向

**交互仍待打磨。** 实际用下来查看器与标注的手感还不顺手，后续版本继续优化；与官方重合的读盘通路已在 v1.5 删除，之后的改动集中在官方没有的部分（展开即见图、缩放平移、标注、抓屏、截图管理）。

文案目前是硬编码中文（和这个仓库里的同类插件一致），没有接 `ctx.locale`；要出英文得先把 i18n 一次性补齐，而不是在这里掺一半。

## 安装

```sh
dsh plugin --profile web add <本包路径或 tgz>
```

包内的 `cordis.patch.yml` 通过 `dsh.bundle.patch` 自 wiring（安装即注册），不需要手改 profile 的 `cordis.patch.yml`。装完**重启 profile**，然后随便让模型 `read_image` 一张图即可看到。

卸载：`dsh plugin --profile web remove dsh-plugin-read-image-preview`。
