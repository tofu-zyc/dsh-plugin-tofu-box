# dsh-plugin-read-image-preview

把**任何工具产出的图片直接画在会话里**——`read_image` 读的文件图，和 computer-use 截图这类**结果附件图**，共用同一张卡片与同一套交互。

## 通用模式（v1.4）

卡片按数据源分两轨，注册时一次认领所有图像工具（`tool.call.toolview` 的对应键，priority `-1`）：

| 轨道 | 触发条件 | 字节来源 | 元数据 |
| --- | --- | --- | --- |
| `file` | 调用参数里有 `file_path`（read 家族） | Host 半区回环路由 `/read-image-preview/resolve`（调用一开始就能出骨架/预览） | resolve 响应 |
| `attachment` | 结果 content 里有 `{type:'image', attachment}`（computer-use 截图及未来任何图像工具） | 会话授权的 `props.loadImage`（先 `peek` 缓存） | **全在附件引用上，零额外请求** |

没有图也没有报错的调用渲染一行结果摘要（失败标红），执行中渲染按真实宽高比撑开的骨架——认领的行永远不会是空壳。

**v1.4.1：图片加载零位移。** 两种模式下图片像素尺寸都在字节到达之前就已知（resolve 响应 / 附件引用），因此 `<img>` 直接带 `width/height` 渲染、信息行宽度也按已知比例预先定死。晚到的图片（上一张截图的 fetch/解码在新内容压上来之后才完成）落地时不再产生布局跳变——正是这个跳变会让 DSH 聊天流的吸底逻辑把浏览器自发的位移误读成「用户上滚」，从而停止自动跟随最新记录。

**接入新工具 = 在 `client.js` 的 `TOOL_LABELS` 加一行**，交互（缩略图、点击放大、Ctrl+滚轮、拖动、双击适应、骨架、透明棋盘格）全部自动继承。

## 它解决什么

DSH 自带的 `read_image` 卡片（`dsh-client-ui-tool` 的 `read-image-toolview`）有三个让人看不到图的地方：

1. 图片是 `ToolRow` 展开区里的内容，**默认折叠**，不点开那一行就没有画面；
2. 官方派生逻辑明确写着运行期的调用没有 content，所以 **AI 正在看图的那几秒卡片里是空的**；
3. 折叠状态只有一行路径摘要。

这个插件接管这些工具的展示位（`tool.call.toolview` 的对应键，priority `-1`，同时遮蔽内置行与动态插件的兜底卡片），把图片提到最外层：

- **调用一开始就出图**，不等 tool result；
- 加载中是按**真实宽高比**撑开的骨架（扫光动画，`prefers-reduced-motion` 下停用）；
- 图下一行信息：状态点（蓝闪=正在看 / 绿=看完 / 红=失败）、路径、像素尺寸、体积、格式；
- 默认是克制的缩略图（`min(420px, 100%)` × `max-height: 300px`），不占聊天流；
- **点图进入缩放视图**：`Ctrl + 滚轮` 连续缩放（0.2×–8×，锚定光标位置；滚轮只在按住 Ctrl 时被消费，所以不与页面滚动打架）、**按住拖动平移**、双击复位、`Esc` 或点背景关闭；底部有当前缩放百分比与 `−` / `+` / `100%`；
- 透明容器（PNG/WebP/GIF）自动铺棋盘格；
- 操作：复制路径、在编辑器中打开。

## 两半的分工

Slot 视图没有文件权限，所以字节要走页面自己的传输：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 用组合的 `fs` 服务解析路径、按魔数校验容器、解析像素尺寸，签发能力 token，并在插件私有前缀上提供两个回环路由 |
| Client | `client.js` | 接管 `read_image` 展示位并渲染卡片；通过 `GET /read-image-preview/resolve` 拿描述与 URL |

路由：

- `GET /read-image-preview/resolve?path=…&cwd=…` → JSON 描述 + 能力 URL
- `GET /read-image-preview/<token>` → 图片字节，供 `<img src>` 使用

安全边界：只放行 PNG / JPEG / WebP / GIF 四种位图，且 `Content-Type` 用的是**嗅探结果而非扩展名**，所以 SVG / HTML 永远不会被协商成脚本；URL 里带的是不透明 token 而非路径，页面无法让宿主读取任意路径。两条路由都是插件私有前缀上的普通 HTTP，**不向 Cordis 服务命名空间发布任何东西**，不会和别的插件撞名。

## 安装

```sh
dsh plugin --profile web add <本包路径或 tgz>
```

包内的 `cordis.patch.yml` 通过 `dsh.bundle.patch` 自 wiring（安装即注册），不需要手改 profile 的 `cordis.patch.yml`。装完**重启 profile**，然后随便让模型 `read_image` 一张图即可看到。

卸载：`dsh plugin --profile web remove dsh-plugin-read-image-preview`。
