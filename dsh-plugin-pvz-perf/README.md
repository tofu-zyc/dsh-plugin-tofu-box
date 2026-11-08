# dsh-plugin-pvz-perf

把 **pvz_perf 网页版**（GitHub: [YuHao2006/pvz_perf](https://github.com/YuHao2006/pvz_perf)，WebGPU / WebGL2 wasm 构建）嵌进 DeepSeek Harness 的 Web UI：侧栏点开，游戏就在**中央面板**里跑，侧栏、会话输入框、窗口标题栏都不受影响；点「返回对话」随时切回去。

游戏本体不进 npm 包。插件只做两件事：在回环上把**你本机那份** web 构建目录原样转播给页面，以及在 Web UI 里放三个 additive 座位。

## 功能

- **中央面板里玩游戏**：游戏渲染在 shell 已经分配给本插件的 `main` 面板里，不再是全窗口浮层——侧栏、标题栏、窗口按钮全部保持可见可用。
- **侧栏图标 + hub**：图标点开先看到状态页（游戏状态、版本、解析到的目录），一个按钮开始游戏；游戏开起来后同一块面板顶部是一条紧凑工具条：`返回对话 / 全屏 / 重新载入 / 结束`，右侧侧栏始终在。
- **侧栏底部快捷入口**：Settings 旁边的幼苗图标，一键切到插件面板并开始游戏；游戏开着时显示「回到植物大战僵尸」。
- **Toolkit 阵型码一键导入**：插件读取本机 `PvZ_Toolkit_v1.22.0\setups.yml`（339 条在线阵型）并写进游戏「自定义存档 → 布阵与关卡」用的 `pvz_custom_lineups`，不用再一条条粘贴。首次激活会自动导入一次；hub 里有「导入 / 清空插件导入的阵型」可手动重跑或撤销（只删插件导入的，保留你自己存的阵型）。
- **全屏是可选动作**：只有你自己点「全屏」时才会铺满（按 Esc 或右上角「退出全屏」回来），平时永远只是中央面板。
- **自动找游戏**：按 `DSH_PVZ_GAME_DIR` → `PVZ_PERF_WEB_DIR` → 常见目录（各盘 `\Games\pvz_perf_web`、`\Games\pvz_perf`、`\Downloads\pvz_perf_web` 等）依次查找，找到含 `index.html` + `web-build-manifest.json` + `launcher.js` 的那一层就用它。
- 只读、同源、loopback：Host 路由只服务解析到的那个游戏目录，不做目录列表，不写任何文件。

## 环境要求

- dsh `>=0.2.0-rc.2 <0.3.0-0`（在 0.2.2-rc.1 上验证）。
- 一份 pvz_perf 网页版构建（v3.3.x），目录里应有 `index.html`、`web-build-manifest.json`、`launcher.js`、`pvz-perf.js`、`pvz-perf.wasm.gz`、`pvz-perf.data`、`audio/`。
  - 发布包在 pvz_perf 仓库的 Release 里；本机已经有一份的话直接指过去即可。
  - 构建对浏览器的要求：支持 WebGPU 或用 WebGL2 回退（Chrome / Edge 新版）；WebGPU 需要 `localhost` / HTTPS，插件走的就是 Harness 的 `127.0.0.1` 源，满足条件。
- 存档在**当前 GUI origin** 的 IndexedDB 里：换端口、换浏览器、换电脑都不共享。插件和游戏是同源的，所以和“直接在浏览器里打开游戏”是两套存档。

## 安装

插件页安装（发布后）：

```text
dsh plugin add dsh-plugin-pvz-perf
```

本地目录开发（profile 里 link 当前 checkout，改代码后重启 dsh）：

```text
dsh plugin --profile <profile> add "link:D:\path\to\dsh-plugin-pvz-perf"
```

安装后无需改 `cordis.patch.yml`：bundle 自带 patch，一行插入即注册两半。

## 游戏目录

默认会自动找。放在别处时，用环境变量覆盖（指向含 `index.html` 的那一层）：

```powershell
$env:DSH_PVZ_GAME_DIR = 'F:\games\pvz_perf_web'
```

Windows 下从桌面图标启动的 Harness 读不到临时 shell 的环境变量，稳妥做法是设置用户级变量后重启 Harness：

```powershell
[Environment]::SetEnvironmentVariable('DSH_PVZ_GAME_DIR', 'F:\games\pvz_perf_web', 'User')
```

hub 面板的「游戏目录」一栏会显示实际解析到的路径，`/pvz-perf/status` 也能直接看到。

## Toolkit 阵型码导入

游戏自带的「自定义存档 → 布阵与关卡」里有一个阵型下拉，读的是 `pvz_custom_lineups`（游戏 origin 的 localStorage，和插件同源）。插件把本机 PvZ Toolkit 的阵型表读出来批量写进去：

- 自动查找顺序：`DSH_PVZ_TOOLKIT_DIR` / `PVZ_TOOLKIT_DIR`（目录或直接给 `setups.yml`）→ 游戏目录旁边的 `PvZ_Toolkit*` 目录 → 各盘 `\Games\PvZ_Toolkit*` 与用户 `Games` 目录。
- 插件**首次激活会自动导入一次**（之后 Toolkit 文件版本变了才会再自动导入）；hub 面板有「导入到游戏阵型列表 / 清空插件导入的阵型」按钮，清空只删插件导入的，你自己存的阵型不受影响。
- 用的时候：游戏 →「自定义存档」→「布阵与关卡」→ 阵型下拉；对话框已经开着的话关掉重开一次。
- 当前机器实测：`E:\Games\PvZ_Toolkit_v1.22.0\setups.yml` → 339 条，全部解析成功。

## 工作原理

- Host half（`index.js`）：`ctx.webServer.register({ kind: 'prefix', path: '/pvz-perf', handler })`，提供
  - `GET /pvz-perf/status` — JSON：`{ ok, dir, version, sourceCommit, gameUrl, hint }`
  - `GET /pvz-perf/toolkit/lineups` — 本机 Toolkit 解析结果：`{ ok, file, count, version, lineups }`（只读 `setups.yml`）
  - `GET|HEAD /pvz-perf/game/…` — 游戏文件（`content-length` + `no-store`，流式发送，不做目录列表）
  - 游戏目录缺失时，`/game/` 返回一张中英文说明页，所以面板里看到的是“怎么装”，不是白屏。
- Browser half（`client.js`）：三个 additive 座位，不覆盖官方 UI——
  `sidebar.panellist`（入口图标）、`main`（hub ↔ 游戏面板，key = `pvz-perf`）、`sidebar.footer.action`（底部快捷入口）。
  游戏 iframe 只存在于 `main` 面板内部；卸载面板（返回对话/切换会话）时游戏页面随之卸载。
- 样式只用 `--dsw-alias-*` 主题变量；图标是插件自绘的像素小盆栽。

## 许可

- 本插件代码：MIT。
- **本插件只自用，不发布到 npm**：`package.json` 里 `private: true`（`publish.ps1` 会跳过，`npm publish` 也会拒绝），`dsh.umbrella: false` 不进 `tofu-box` 伞包。要改这个决定，得同时动这两处并自己确认下面的版权问题。
- 游戏本体与美术资源：版权归各自权利人（PopCap Games / PvZ-Portable / pvz_perf 项目）。本仓库**不打包、不分发**任何游戏文件，只在你的机器上转播你已有的构建。
- pvz_perf 源码许可见其仓库；web 构建自带的 `licenses/` 目录保留在你的游戏目录里，随构建一起分发。

## 排错

| 现象 | 处理 |
| --- | --- |
| hub 显示「未找到游戏」 | 确认目录里有 `index.html`、`web-build-manifest.json`，以及 `launcher.js` / `pvz-perf.js` 之一；用 `DSH_PVZ_GAME_DIR` 指过去后点「重新检查」。 |
| 面板里是说明页 | 同上：Host 没解析到游戏目录。 |
| 游戏黑屏 / 卡在加载 | 在游戏自己的启动页里把「图形接口」切到 WebGL2 再试；WebGPU 需要 localhost 安全上下文。 |
| 想边聊边玩 | 点「全屏」把面板铺满，或者把 Harness 窗口切小一点；「返回对话」会卸载游戏页面。 |
| 存档 | 只有游戏内正常退出（Quit）才写回当前关卡；直接「返回对话」/关闭窗口不会保存进行中的关卡。 |
| 想换一份游戏 | 改环境变量或替换目录内容后按「重新载入」；版本号来自 `web-build-manifest.json`。 |

## 变更

- **0.1.4**（2026-11-08）：标记 `private: true`，只自用不发布（`publish.ps1` / `npm publish` 都会跳过）。
- **0.1.3**（2026-11-08）：新增 Toolkit 阵型码一键导入（读本机 `setups.yml` → 写入游戏的 `pvz_custom_lineups`，含自动导入、手动重跑、只清插件导入的部分）。
- **0.1.2**（2026-11-08，真机第二轮后的修复）：全屏改成真正的切换：进入后工具条隐藏、游戏铺满整屏，右上角常驻「退出全屏」浮标，Esc 也可退出，退出后工具条恢复；再点按钮是切换而不是重复进入。
ode --test 客户端 19/19。
- **0.1.1**（2026-11-08，真机首轮后的修复）：不再使用 `shell.overlay` 全窗口浮层；游戏改为渲染在 `main` 中央面板内，侧栏与窗口控件不再被遮挡，游戏工具条四个按钮（返回对话/全屏/重新载入/结束）全部可见可点。
- **0.1.0**：首版 Host 路由 + hub，+ 全窗口浮层（已被 0.1.1 取代）。

