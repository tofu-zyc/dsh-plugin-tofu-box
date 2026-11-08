# dsh-plugin-pvz-perf

把 **pvz_perf 网页版**（GitHub: [YuHao2006/pvz_perf](https://github.com/YuHao2006/pvz_perf)，WebGPU / WebGL2 wasm 构建）塞进 DeepSeek Harness 的 Web UI：侧边栏点开就是整屏游戏浮层，点「隐藏」游戏继续在后台挂着跑，等 AI 干活时来一局。

游戏本体不进 npm 包。插件只做两件事：在回环上把**你本机那份** web 构建目录原样转播给页面，以及在 Web UI 里放四个 additive 座位。

## 功能

- **侧栏图标 + hub 面板**：显示游戏状态、版本、解析到的目录；一个按钮开始/继续，一个按钮在独立标签页打开。
- **整屏游戏浮层**：`shell.overlay` 座位，iframe 直接跑游戏；顶栏有 隐藏 / 全屏 / 重新载入 / 回到对话 / 结束。
- **隐藏 ≠ 关闭**：隐藏只把浮层 `display:none`，游戏页面（含 IndexedDB 存档状态、正在进行的关卡）继续存活；再点侧栏底部的手柄图标就回来。只有「结束」会卸载页面——而游戏**只在正常退出时**才把当前关卡写回存档，所以想留进度请用游戏内菜单退出、而不是直接结束。
- **侧栏底部快捷开关**：Settings 旁边的幼苗图标，一键开/隐/恢复。
- **自动找游戏**：按 `DSH_PVZ_GAME_DIR` → `PVZ_PERF_WEB_DIR` → 常见目录（各盘 `\Games\pvz_perf_web`、`\Games\pvz_perf`、`\Downloads\pvz_perf_web` 等）依次查找，找到含 `index.html` + `web-build-manifest.json` 的那一层就用它。
- 只读、同源、loopback：Host 路由只服务解析到的那个游戏目录，不做目录列表，不写任何文件。

## 环境要求

- dsh `>=0.2.0-rc.2 <0.3.0-0`（在 0.2.2-rc.1 上验证）。
- 一份 pvz_perf 网页版构建（v3.3.x），目录里应有 `index.html`、`web-build-manifest.json`、`pvz-perf.js`、`pvz-perf.wasm.gz`、`pvz-perf.data`、`audio/`。
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

## 工作原理

- Host half（`index.js`）：`ctx.webServer.register({ kind: 'prefix', path: '/pvz-perf', handler })`，提供
  - `GET /pvz-perf/status` — JSON：`{ ok, dir, version, sourceCommit, gameUrl, hint }`
  - `GET|HEAD /pvz-perf/game/…` — 游戏文件（`content-length` + `no-store`，流式发送，不做目录列表）
  - 游戏目录缺失时，`/game/` 返回一张中英文说明页，所以浮层里看到的是“怎么装”，不是白屏。
- Browser half（`client.js`）：四个 additive 座位，不覆盖官方 UI——
  `sidebar.panellist`（入口图标）、`main`（hub 面板，key = `pvz-perf`）、`shell.overlay`（游戏浮层）、`sidebar.footer.action`（底部快捷开关）。
- 样式只用 `--dsw-alias-*` 主题变量；图标是插件自绘的像素小盆栽。

## 许可

- 本插件代码：MIT。
- 游戏本体与美术资源：版权归各自权利人（PopCap Games / PvZ-Portable / pvz_perf 项目）。本仓库**不打包、不分发**任何游戏文件，只在你的机器上转播你已有的构建。
- pvz_perf 源码许可见其仓库；web 构建自带的 `licenses/` 目录保留在你的游戏目录里，随构建一起分发。

## 排错

| 现象 | 处理 |
| --- | --- |
| hub 显示「未找到游戏」 | 确认目录里有 `index.html`、`web-build-manifest.json`，以及 `launcher.js` / `pvz-perf.js` 之一；用 `DSH_PVZ_GAME_DIR` 指过去后点「重新检查」。 |
| 浮层里是说明页 | 同上：Host 没解析到游戏目录。 |
| 游戏黑屏 / 卡在加载 | 在游戏自己的启动页里把「图形接口」切到 WebGL2 再试；WebGPU 需要 localhost 安全上下文。 |
| 隐藏后没声音了 | 浏览器会把后台页面的音视频/定时器降频；继续点开即可。想彻底停就点「结束」。 |
| 想换一份游戏 | 改环境变量或替换目录内容后按「重新载入」；版本号来自 `web-build-manifest.json`。 |
