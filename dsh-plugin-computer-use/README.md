# dsh-plugin-computer-use

让模型**看见桌面并操作鼠标键盘**——computer-use 的持久插件形态（由 M0 动态原型固化而来）。

## 它提供什么

12 个模型可见工具（全部 `computer_*`）：

| 工具 | 作用 |
| --- | --- |
| `computer_screenshot` | 全虚拟桌面截图（多显示器拼接），同时标定坐标系 |
| `computer_zoom` | 区域放大截图（读小字/小图标） |
| `computer_cursor` | 读当前光标位置（物理 px + 帧 px） |
| `computer_move` / `computer_click` / `computer_drag` / `computer_scroll` | 鼠标：移动 / **原子点击**（移动+按下+松开一次完成）/ 拖拽 / 滚轮 |
| `computer_type` / `computer_key` | unicode 文本注入（免 IME）/ 按键与组合键 |
| `computer_open` | 「开始菜单搜索启动应用」一键流：Win → 输入名称 → 回车 → 截图 |
| `computer_sequence` | 多步 DSL 一气呵成：`key/type/wait/move/click/scroll/open/keydown/keyup`，全步先校验后执行，**一次审批一张终图** |
| `computer_wait` | 等待动画/加载并回一张新截图 |

三条不可妥协的交互约定（M0 实测教训）：

- **KEYBOARD-FIRST**：所有描述引导模型优先走键盘路径；缩放帧上的小图标点击极易脱靶，鼠标只留给真正需要的目标。
- **原子手势**：点击 = 移动+按下+松开在一次调用内完成，指针绝不会停在半路等人类"帮忙"。
- **指针回位**：移动型手势先存光标、截完结果图再把指针放回**你**的原位（`keep_cursor: true` 可留在目标处）。

## 审批

写操作（一切能动鼠标键盘的工具）挂在原生 `tools/pre-execute` 审批水路上，默认 `askPolicy: once-per-agent`——**同一会话第一次写操作弹一次批准，之后整轮免批**。行 config 可改 `always` 每次一询。截图、读光标是只读，不审批。

## 行配置（可全部省略）

```yaml
- id: computer-use
  name: dsh-plugin-computer-use
  inject: [tools, shell, fs, attachments]
  config:
    askPolicy: once-per-agent   # 或 always
    outDir: <tmp>/dsh-computer-use  # 截图暂存目录
    keep: 30                    # 暂存 PNG 保留数（滚动清理）
    maxDim: 1568                # 模型帧长边上限
    settleMs: 800               # 手势后到结果图的等待
```

包内 `cordis.patch.yml` 经 `dsh.bundle.patch` 自 wiring，安装即注册这一行，不用手改 profile 配置。

## 图像显示在哪

本包**不带 client 半区**。结果图以 `{type:'image', attachment}` 进入工具结果，由 [`dsh-plugin-read-image-preview`](../dsh-plugin-read-image-preview/README.md) 的通用图像卡渲染（缩略图、点击放大、Ctrl+滚轮缩放、拖动平移；`computer_*` 键已在其 `TOOL_LABELS` 注册）。新工具接入那套卡片 = 在那边加一行 key。

## 安全边界

- 触碰桌面的只有包内两个 PowerShell 脚本（`scripts/capture.ps1`、`scripts/input.ps1`）；模型只提供坐标/文本参数，**永远拼不出命令行**。
- 脚本经 `shell` 服务在 `workspace-write` 沙箱内运行，workspace 根钉死为截图暂存目录。
- 坐标系自适应任意多显示器 / DPI 布局：每次全帧截图重新测量虚拟桌面，帧 px → 物理 px 自动换算。

## 安装 / 卸载

```sh
dsh plugin --profile web add <本包路径或 tgz>
dsh plugin --profile web remove dsh-plugin-computer-use
```

装/卸后**重启 profile** 生效（composition 在进程启动时组树）。
