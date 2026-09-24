# TOFU BOX

自己日常用的一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件，都在这个仓库里，直接从 GitHub 安装。

[中文](#中文) · [English](#english)

---

## 中文

把下面命令里的 `--profile web` 换成你自己的 profile。

| 插件 | 说明 | 支持的 dsh 版本 | 平台 | 安装 |
| --- | --- | --- | --- | --- |
| **model-search** | 模型选择菜单加一个搜索框，按名称 / ID / 描述 / provider 过滤 | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1（用了 0.1.7 的新图标，0.1.6 及更早不可用） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | 「设置 → 模型调参」三个页签：**模型参数**（推理档位、上下文窗口、最大输出、输入模态、生图勾选）、**用途**（会话标题的模型路由：`inherit` 沿用会话已记录的 provider / model，或指定完全独立的一组；经 `ctx.sessionTitle.register()` 独占注册，bundle patch 先 `disabled` 官方 `session-title-llm` 行，提示词、输入输出预算、超时与结果校验全部沿用宿主共享策略）、**绘图**（绘图模型配置、`generate_image` / `list_image_models` 工具与直接绘图面板，原图逐字节保留）。**v2 起合并了原 title-model 与 image-generation 两个包**，详见 [README](dsh-plugin-model-tuning/README.md) | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1（设置页走 profile-backed SettingsForms） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | 工具结果里的图片（read_image、截图等）渲染成图片卡，点击放大、滚轮缩放、拖动平移 | ≥ 0.1.7-alpha.2，已适配 0.1.7-rc.1 的三阶段工具调用（`preparing` / `start` / 结果） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **shell-selector** | 「设置 → Shell」里选 AI 执行命令用哪个 shell：PowerShell 7 / Windows PowerShell 5.1 / 自定义路径。只写宿主 `pwsh-sandbox` 条目本来就支持的 `pwshPath`，保存后下一条命令即生效，不重启、不替换执行器，沙箱 / 审批 / 超时 / 退出码全部沿用内置；选中 5.1 时额外注册一条方言上下文告知模型 `&&`、`??` 不可用；Git Bash 因受限执行未验证而置灰并写明原因，详见 [README](dsh-plugin-shell-selector/README.md) | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector` |
| **computer-use** | 13 个 `computer_*` 工具：截图/元素树、鼠标、键盘、开应用，写操作有审批弹窗；v2 基于 Cua Driver 进程内 SDK（无守护/MCP/PowerShell），v2.3 起「打开应用」先在窗口表里复用已有窗口（含唤醒最小化），**绝不重复启动**已登录的应用，详见 [README](dsh-plugin-computer-use/README.md) | ≥ 0.1.5-rc.1（peer 声明），实测 0.1.7-rc.1 | 跨平台（Windows 11 实测；macOS/Linux 未实测） | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | 「设置 → MCP 服务器」配置页：增删改 stdio / streamable-http 服务器，写入 profile patch 标记块并热生效（官方暂不提供 MCP 配置界面），详见 [README](dsh-plugin-mcp-ui/README.md) | ≥ 0.1.6-alpha.1（依赖 typert 网关，旧版不可用）；0.1.7-rc.1 下加载与 compose 实测通过，MCP 增删路径尚未实机验证 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

> `team-task-route`（把某一次团队会话的 teammate 钉死在指定模型上）已在 2026-09 移除：它把 session id 写死在 `index.js` 里，只对一次性的调试会话有意义。需要时可在 git 历史里找回。

全部插件一次装完：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

装完重启 dsh 就能用。注册配置打进包里了（`dsh.bundle.patch`），不需要动 cordis 文件。卸载把 `add` 换成 `remove`。

要改本仓库的代码来调试？见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)——把 profile 依赖换成指向本仓库的 `link:`，改完不用重装。

上表的版本区间为实测范围，未标注下限的插件不保证能在更早版本上运行。本轮迁移（0.1.7-alpha.2 → 0.1.7-rc.1）改动了 model-search、model-tuning、read-image-preview 三个插件，新增 shell-selector；**image-generation 与 title-model 随后并入 model-tuning（v2），已不再单独发布**（升级时记得从 profile 移除这两个旧包，并把绘图配置搬进 `model-tuning` 条目，见其 README 的迁移指引）；computer-use 与 mcp-ui 不需要改动，两者都在跑着 0.1.7-rc.1 的实际 profile 里加载通过：computer-use 的 13 个 `computer_*` 工具全部注册且被持续调用（截图 + 元素树、后台 element 点击、sequence、唤醒最小化窗口），mcp-ui 只到「加载与 compose 通过」这一步——它托管的 profile patch 里没有 MCP 块、当前 0 个 server，所以增删改的读写路径至今没有实机跑过，跟 dsh 版本无关。dsh 版本更新频繁，可能影响稳定性。并且插件均由 AI 完成，肯定会有很多潜在 bug。

升级 dsh 后起不来？多数是某个插件在新版本下坏了，而 dsh 默认一个插件崩就整个不启动。仓库自带一个启动急救工具（clone 本仓库后运行）：

```sh
node tools/doctor/doctor.mjs --profile web
```

它会自动定位是哪个插件的问题（报错没点名也能靠二分测试查出来），先尝试 `dsh plugin update` 修复，修不好会问你要不要先禁用该插件让 dsh 跑起来，事后 `enable` 一键恢复。

未来可能新增更多插件。

---

## English

A few [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins I use daily. Install straight from GitHub — replace `--profile web` with your profile.

| Plugin | What it does | dsh versions | Platform | Install |
| --- | --- | --- | --- | --- |
| **model-search** | Search box in the model picker (name / ID / description / provider) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 (needs the 0.1.7 icons; won't work on 0.1.6 or older) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | "Settings → Model tuning" with three tabs: **model parameters** (reasoning effort, context window, max output, input modality, image-model linking), **purposes** (session-title model routing: `inherit` keeps the route recorded on the session, or point it at a separate provider/model pair — registered exclusively through `ctx.sessionTitle.register()` after the bundle patch disables the shipped `session-title-llm` row, with prompt, input/output budgets, timeout and result validation all staying on the host's shared policy) and **images** (drawing-model config, the `generate_image` / `list_image_models` tools and a direct generation panel, originals kept byte-for-byte). **Since v2 it contains the former title-model and image-generation packages**, which are no longer published separately ([README](dsh-plugin-model-tuning/README.md)) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 (settings page uses profile-backed SettingsForms) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | Renders images in tool results as zoomable cards (click to enlarge, wheel to zoom, drag to pan) | ≥ 0.1.7-alpha.2, adapted to the three-stage tool calls of 0.1.7-rc.1 (`preparing` / `start` / result) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **shell-selector** | A "Settings → Shell" page for picking which shell the AI runs commands in: PowerShell 7 / Windows PowerShell 5.1 / a custom path. It only writes the `pwshPath` field the host's own `pwsh-sandbox` entry already supports, so the next command uses your choice — no restart, no swapped executor, and sandboxing, approval, timeouts and exit codes stay exactly as shipped; when 5.1 is active it also registers a dialect note so the model knows `&&` and `??` don't exist; Git Bash stays greyed out with the reason shown, because confined execution is unverified ([README](dsh-plugin-shell-selector/README.md)) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector` |
| **computer-use** | 13 `computer_*` tools: window screenshots + accessibility tree, mouse, keyboard, launching apps; input actions require approval; v2 runs on the in-process Cua Driver SDK (no daemon/MCP/PowerShell); since v2.3 "open app" reuses an existing window (restoring it when minimized) and **never starts a second instance** of an app that is already running ([README](dsh-plugin-computer-use/README.md)) | ≥ 0.1.5-rc.1 (peer dep), tested on 0.1.7-rc.1 | Cross-platform (tested on Windows 11; macOS/Linux untested) | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | "Settings → MCP Servers" page: add/edit/remove stdio & streamable-http servers; writes them into the profile patch and hot-applies (the official build ships no MCP UI yet) ([README](dsh-plugin-mcp-ui/README.md)) | ≥ 0.1.6-alpha.1 (needs the typert gateway; won't work on older dsh); loads and composes on 0.1.7-rc.1, add/remove-server path not exercised yet | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

> `team-task-route` (pinning one specific agent-team session's teammates to a chosen model) was removed in 2026-09: it hardcoded a session id in `index.js` and only made sense for one throwaway debugging session. It can be recovered from git history if ever needed.

All plugins at once:

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

Restart dsh after installing. Registration is bundled in each package (`dsh.bundle.patch`), nothing to wire up. To remove: `dsh plugin --profile web remove <name>`.

Hacking on this repo? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — point the profile at your checkout with `link:` and you stop reinstalling after every edit.

The version ranges above are what has actually been tested; plugins without a stated lower bound aren't guaranteed to work on older dsh. This migration round (0.1.7-alpha.2 → 0.1.7-rc.1) touched model-search, model-tuning and read-image-preview and added shell-selector; **image-generation and title-model were later merged into model-tuning (v2) and are no longer published separately** — when upgrading, remove those two old packages from your profile and move the drawing config into the `model-tuning` entry (its README has the migration steps); computer-use and mcp-ui needed no changes and both load in a live 0.1.7-rc.1 profile — all 13 `computer_*` tools register and are in continuous use (screenshots with accessibility trees, background element clicks, sequences, restoring minimized windows), while mcp-ui is only verified as far as loading and composing: its managed patch block is absent and 0 servers are configured, so its add/edit/remove path has never been exercised, on any dsh version. dsh updates frequently, which may affect stability. All the plugins are completed by AI, so there will certainly be many potential bugs.

dsh won't boot after an upgrade? Usually one plugin broke under the new version, and dsh takes the whole process down with it. This repo ships a boot-recovery tool (clone it first):

```sh
node tools/doctor/doctor.mjs --profile web
```

It figures out which plugin is at fault (via bisection, even when the error names nobody), tries `dsh plugin update` first, and if that fails asks whether to disable the plugin so dsh can start. Re-enable anytime with `enable <name>`.

More plugins may be added in the future.
