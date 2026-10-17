# dsh-plugin-read-image-preview

会话里的图片（read_image 读到的图、computer-use 截图、你自己贴进来的图）共用一个全屏查看器：放大、平移、圈红框、加字、裁剪，然后**回车直接放进输入框**。输入框旁的 `✂ 截图` 抓屏后直接框选，选完回车同样进输入框——给模型看一个前端问题，不用再开外部截图器。

## 接在哪里

| 位置 | 做法 |
| --- | --- |
| read_image 行、用户消息里的图、助手消息里的图、轨迹里的图 | 只替换官方的**图库**位置（`tool.call.images`、`conversation.chat.user.images` / `conversation.chat.message.images`，0.2.0 叫 `conversation.message.images`；`conversation.trajectory.images`），priority `-1`。官方行自己的标题、路径、尺寸、Inspect 原样保留 |
| computer-use 各工具、generate_image | 这些工具没有官方图片行，继续整格认领 `tool.call.toolview`（priority `-1`），渲染同一个图库加一行信息（路径、尺寸、体积、格式、复制路径、在编辑器中打开） |
| 输入框右侧 | `✂ 截图` 按钮 |
| 设置 → 截图与标注 | 截图目录管理与按期清理 |

> **v1.6 起 read_image 不再整行接管。** 官方 read_image 行从 0.2.0 起把图片交给 `tool.call.images` 子 slot 渲染，并自带路径与尺寸信息；本插件只填这个图库，和官方重合的部分全部交还。代价是官方行默认折叠，点开才看到图。两版 dsh 的消息图片 slot 名不同，全部注册是安全的：`slots.inject` 会一直等到 slot 被声明，没有的名字永远不会激活。

图库：单张按真实宽高比显示缩略图（`min(420px, 100%)` × `max-height: 300px`），`<img>` 在字节到达前就带好 `width/height`，晚到的图片不会引起布局跳变（v1.4.1 修过的聊天吸底问题）；多张一律平铺成小图，全部可点开，查看器里 `←`/`→` 切换；透明 PNG/WebP/GIF 自动铺棋盘格；加载失败点一下重试。

## 查看器（v1.6 重写）

### 一个模式，工具常驻

不再区分「查看」和「标注」：底栏一直摆着工具，默认是**移动**。

| 组 | 内容 |
| --- | --- |
| 工具 | 移动 `V` · 矩形 `R` · 椭圆 `E` · 箭头 `A` · 画笔 `P` · 文字 `T` · 裁剪 `C` |
| 样式 | 6 色（红打头）· 细 / 中 / 粗（同时决定文字字号） |
| 编辑 | 撤销 `Ctrl+Z` · 重做 `Ctrl+Shift+Z`/`Ctrl+Y` · 删除选中 `Delete` · 清空 |
| 缩放 | − / 百分比 / + · 适应 `F` · 1:1 `0` |
| 输出 | **发到输入框** `Enter` · 复制 `Ctrl+C` · 保存 `Ctrl+S` · 关闭 `Esc` |

- **已画的标记可以改**：移动工具下点线条选中，拖动移位，拉角改大小（箭头拉两端），点颜色 / 粗细直接改选中的那个，`Delete` 删掉；文字双击改字。刚画完的框和箭头自动选中，可以马上调。
- 框和椭圆只在**线上**能抓住，框内照样拖动平移，圈起来的区域不会挡住手势。
- 裁剪是一块状态区域：外面压暗，四角可拖，框内可拖动整体移位；导出时只出这一块。
- 标记坐标一律是**源图像素**，放大多少倍导出都与所见一致；放大到 200% 以上切成像素级渲染，方便看 UI 截图的细节。

### 三个出口

- **发到输入框**：把当前图片（含标注，按裁剪区域）以附件形式放进输入框。走的是官方输入框的**粘贴**通路：往编辑器根节点派发一个带 PNG 文件的 `paste` 事件，官方的粘贴命令收下文件并取消事件——这和你按 Ctrl+V、拖文件进来是同一个入口，不依赖任何私有接口。找输入框的顺序：离发起位置最近的编辑器 → 最近一次获得焦点的编辑器 → 页面上最后一个可见的编辑器；找不到就改为复制到剪贴板并提示。
- **复制**：PNG 进剪贴板。
- **保存**：存进截图目录，提示条里给出路径和「复制路径」。

有没复制、保存或发出的标注时，关闭、点暗处、切换图片都会先停一下：「继续编辑 / 复制后离开 / 放弃（Esc）」，连按两次 Esc 即放弃。

### 手势

| 手势 | 行为 |
| --- | --- |
| 滚轮 | 以光标为锚缩放，每格约 1.2×，带缓动（0.05×–16×） |
| Shift + 滚轮 | 上下平移 |
| Ctrl + 滚轮 | 左右平移 |
| 触控板捏合 | 缩放（与 Ctrl+滚轮区分：捏合的 delta 很小或带小数，鼠标一格是整的 ~100） |
| 触控板双指滑动 | 双向平移（带横向 delta 却没按 Shift，只有触控板会这样） |
| 拖动空白处 | 平移（移动工具下） |
| 空格 / 中键按住拖动 | 任何工具下都能平移 |
| 双击 | 适应窗口 |
| 点图外暗处 / Esc / `✕ 关闭` / `关闭 (Esc)` | 关闭 |

点暗处只在「静止的点击、落在图外、移动工具、没有裁剪、没有未导出的标注、不是刚抓的屏」时才关闭，正在做的活儿不会被随手一点丢掉。

### 性能

拖动卡顿的三个来源都去掉了：

1. 平移、缩放不再走 React：视图放在 ref 里，每帧由一个 `requestAnimationFrame` 写图片的 `transform`、缩放读数和标注层；React 只在工具、标记这类离散变化时重渲染。
2. 标注层按**舞台（视口）**大小分配位图，而不是「原图 × 缩放倍数」——3200×2000 的截图放大到 300% 时，旧做法是一张约 9600×6000 的画布，每次移动都要重新光栅化。
3. 去掉全屏 `backdrop-filter: blur`，它会让每一帧平移都重新模糊整张背景。

实测（Playwright 驱动真实 dsh web，alpha.4）：120 次指针移动的平移 0 帧超过 50ms。

### 窗口按钮的避让（沿用 v1.5）

桌面端的三个窗口按钮是操作系统画在网页之上的（Electron WCO），任何 `z-index` 都盖不住。所以查看器顶部留出宿主公布的净空（`--dsh-frame-overlay-top`，Windows 60 / macOS 68 / 全屏 20），右上角不放任何本插件的控件，`✕ 关闭` 放在顶部居中；根节点 `-webkit-app-region: no-drag`。

查看器渲染在 `document.body` 的 portal 里，但 React 事件仍会沿声明它的组件树冒泡（工具行、消息、输入框）。根节点把指针、点击、键盘事件全部截停，避免例如工具行头部被误点折叠、连带把查看器卸载掉。键盘监听挂在捕获阶段，Esc 和工具字母不会漏到底下的会话里（Esc 在那里可能会中断正在运行的回合）。

## 截图

左键 `✂ 截图` 立刻抓全屏，**右键选延时**（立即 / 1 / 3 / 5 秒，选择会记住）——延时是为了那些「一点输入框就消失」的画面。抓到的是一张冻结的位图，查看器直接进入框选：拖出区域 → 区域旁浮出「发到输入框 ⏎ · 复制 · 保存 · 取消框选」→ 回车。要标注就先切工具再画，最后回车。

- Host 半区用 PowerShell 抓屏：先 `Application::SetHighDpiMode(PerMonitorV2)` 再 `CopyFromScreen`，拿到真实像素（本机 3200×2000，约 0.6 秒）而不是 DPI 虚拟化后的糊图；优先 `pwsh`，失败回落 `WindowsPowerShell 5.1`；macOS 用 `screencapture`，Linux 依次试 `grim` / `gnome-screenshot` / `spectacle` / `scrot` / `import`；
- 抓屏结果以 `image/png` 直接回给页面，不做 base64 往返；
- **没有全局热键**：页面拿不到全局快捷键，抢本地组合键又容易和宿主、输入框打架。

### 截图管理与定期清理

设置 → **截图与标注**：缩略图网格（懒加载）、复制路径、删除、打开目录、立即清理、加载更多，点缩略图进查看器（可左右切换）。

落盘位置默认 `~/.dsh/screenshots/`。清理策略：

- **按时间 + 按数量 + 按体积**三重上限，谁先到听谁的，从最旧的开始删；
- 只在启动后 8 秒与按 `cleanupIntervalMinutes`（默认 360 分钟）的心跳上运行，两个定时器都 `unref()`；
- **只删本插件按 `shot-YYYYMMDD-HHMMSSmmm-xx.png` 命名的文件**——把目录指到存了别的东西的文件夹，也不会被策略清掉。

## 设置项

设置页里本插件自己那一节（字段都会即时生效）：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `screenshotDir` | 空 = `~/.dsh/screenshots` | 截图落盘目录（支持 `~` 与相对路径，相对路径挂在 `~/.dsh` 下） |
| `retentionDays` | `7` | 保留天数，`0` = 不按时间清 |
| `retentionMaxFiles` | `300` | 目录里最多留多少个 |
| `retentionMaxMb` | `500` | 目录最多占多少 MB |
| `cleanupIntervalMinutes` | `360` | 定期清理间隔（最小 5） |
| `captureDelaySeconds` | `0` | 抓屏默认延时，页面里的延时菜单可以临时覆盖 |

## 两半的分工

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 截图目录的能力 token；抓屏、落盘、列表、删除、按期清理；服务下列回环路由（不读取任何工具传入的路径） |
| Client | `client.js` | 图库（官方图片位置）、工具卡片、全屏查看器与标注、抓屏入口、截图管理页 |

工具结果与消息里的图片都由会话授权的 `loadImage`（先 `peek` 缓存）取字节，像素尺寸、体积、格式、降采样前的原图尺寸都在附件引用上，零额外请求。

路由（全部在插件私有前缀上，每条都先过 `connection.requestRejection`，取不到该服务时一律 503）：

- `GET /read-image-preview/<token>` → 截图字节，供管理页缩略图与查看器使用（token 只由 list / save 签发）
- `GET /read-image-preview/state` → 目录、平台、保留策略、抓屏可用性
- `GET /read-image-preview/list?limit=&offset=` → 分页的截图清单
- `POST /read-image-preview/save`（请求体是 PNG 字节）→ 落盘结果与路径
- `POST /read-image-preview/delete?name=…` · `POST /read-image-preview/cleanup` · `POST /read-image-preview/open`
- `POST /read-image-preview/capture?delay=` → `image/png` 字节

安全边界：只放行 PNG / JPEG / WebP / GIF 四种位图；URL 里带的是不透明 token 而非路径，token 只指向截图目录里的文件；`save` 只写 PNG 魔数、只写截图目录、文件名由宿主生成；`delete` 只接收单段文件名。**不向 Cordis 服务命名空间发布任何东西**。

## 测试

```sh
cd dsh-plugin-read-image-preview
npm test    # node --test tests/*.test.mjs
```

- `tests/phases.test.mjs`：工具调用三阶段形状；认领范围（不含 read_image）；多图结果全部交给图库。
- `tests/gestures.test.mjs`：
  - 滚轮三档映射与触控板识别、以光标为锚的缩放与适应；
  - 标记绘制、命中、移动、改尺寸，裁剪角拖动与夹紧；
  - 关闭方式与右上角几何约束、portal 事件截停；
  - 性能约束：无全屏模糊、标注层按视口分配；
  - 发到输入框（粘贴事件、找输入框的顺序）、图库渲染、slot 注册。
- `tests/shots.test.mjs`：保留策略、抓屏脚本（先提 DPI 精度再取屏幕）、逐平台命令序列、存/查/删/清路由与鉴权围栏。

单测用的是记录元素树的假 React，覆盖不到真实浏览器里的行为。v1.6 另用 Playwright 驱动真实的 dsh web（0.2.1-alpha.4）跑了一遍：抓屏、框选、画框、平移、滚轮、回车。结果是图片进入输入框附件栏，焦点留在输入框，导出图按源图像素裁剪且带标注。

**没在真实页面验证的**：消息与 read_image 行里的图库，本机没有带图片的历史会话。

## 已知取向

文案目前是硬编码中文（和这个仓库里的同类插件一致），没有接 `ctx.locale`；要出英文得先把 i18n 一次性补齐，而不是在这里掺一半。

## 安装

```sh
dsh plugin --profile web add <本包路径或 tgz>
```

包内的 `cordis.patch.yml` 通过 `dsh.bundle.patch` 自 wiring（安装即注册），不需要手改 profile 的 `cordis.patch.yml`。装完**重启 profile**。

卸载：`dsh plugin --profile web remove dsh-plugin-read-image-preview`。
