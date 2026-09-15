# tools/probe — Cua Driver 诊断脚本

排查 `dsh-plugin-computer-use`（v2.1→v2.2）时沉淀的对质脚本。全部直连真实的
`@trycua/cua-driver` 进程内运行时——插件行为可疑时先拿它们问驱动，别猜。

| 脚本 | 用途 |
|---|---|
| `cua-probe.mjs <outdir>` | 转储 56 工具完整 schema（`tools.json`）+ 桌面/窗口截图 + 窗口列表 |
| `dpi-test.mjs` | 证明根因①：koffi 切 Per-Monitor-V2 前后 `get_desktop_state` 的尺寸对比（虚化 1600x1000 → 真实 3200x2000@2x） |
| `session-probe.mjs` | 证明根因②：隐式会话 idle TTL、`session_ended` 后普通调用永不复活、`start_session` 幂等复活、各工具的 `session` 参数支持面 |
| `verify-v22.mjs` | v2.2 修复的非破坏性回归：DPI 自举、命名会话、全主屏截图、无降级警告（**锁屏态也能跑**） |
| `lock-check.mjs` | 抓一张全屏 PNG 判断桌面是否锁定（跑带输入的自测前先看一眼） |
| `launch-reuse.mjs` | 证明驱动 `launch_app` **不复用已有实例**：对同一 app 连调两次，返回两个不同 pid（"打开已登录应用却要求重新登录"的根因） |
| `launch-selector.mjs` | 三种启动方式对质：按 `name` / 按 `launch_path` / 按 `aumid`，各自返回什么 pid、进程是否存活、窗口是否出现（v2.3 选启动方式的依据） |
| `enumwindows.mjs` | 用 koffi 直接问 user32：本进程能枚举多少窗口、在哪个 window station / desktop 上（判断"窗口枚举瞎掉"是环境还是进程） |

运行方式：`node tools/probe/<script>.mjs`（工作区根目录）。生成的 `out*/`、
`upstream/`（下载的官方文档/源码副本）与 `*.png` 不入库。
