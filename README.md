# TOFU BOX

自己日常用的一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件，都在这个仓库里，直接从 GitHub 安装。

[中文](#中文) · [English](#english)

---

## 中文

把下面命令里的 `--profile web` 换成你自己的 profile。

| 插件 | 说明 | 支持的 dsh 版本 | 平台 | 安装 |
| --- | --- | --- | --- | --- |
| **image-generation** | 独立绘图模型配置、Images API 工具和直接绘图面板，预览与原图下载；[使用说明](dsh-plugin-image-generation/README.md) | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-image-generation` |
| **model-search** | 模型选择菜单加一个搜索框，按名称 / ID / 描述 / provider 过滤 | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1（用了 0.1.7 的新图标，0.1.6 及更早不可用） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | 集中配置各模型的推理档位、上下文窗口、最大输出、多模态支持等；「用途」页签托管会话标题的模型路由 | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1（设置页走 profile-backed SettingsForms） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | 工具结果里的图片（read_image、截图等）渲染成图片卡，点击放大、滚轮缩放、拖动平移 | ≥ 0.1.7-alpha.2，已适配 0.1.7-rc.1 的三阶段工具调用（`preparing` / `start` / 结果） | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **shell-selector** | 「设置 → Shell」里选 AI 执行命令用哪个 shell：PowerShell 7 / Windows PowerShell 5.1 / 自定义路径。只写宿主 `pwsh-sandbox` 条目本来就支持的 `pwshPath`，保存后下一条命令即生效，不重启、不替换执行器，沙箱 / 审批 / 超时 / 退出码全部沿用内置；选中 5.1 时额外注册一条方言上下文告知模型 `&&`、`??` 不可用；Git Bash 因受限执行未验证而置灰并写明原因，详见 [README](dsh-plugin-shell-selector/README.md) | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector` |
| **title-model** | 给「会话标题生成」单独指定模型：默认 `inherit` 沿用该会话已记录的 provider / model，也可以在设置里指定完全独立的一组。通过 `ctx.sessionTitle.register()` 独占注册（bundle patch 里先 `disabled` 官方 `session-title-llm` 行），提示词、输入输出预算、超时与结果校验全部沿用宿主共享策略，不产生第二套标题行为；设置项在 model-tuning 的「用途」页签，详见 [README](dsh-plugin-title-model/README.md) | ≥ 0.1.7-alpha.2，实测 0.1.7-rc.1 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-title-model` |
| **computer-use** | 13 个 `computer_*` 工具：截图/元素树、鼠标、键盘、开应用，写操作有审批弹窗；v2 基于 Cua Driver 进程内 SDK（无守护/MCP/PowerShell），v2.3 起「打开应用」先在窗口表里复用已有窗口（含唤醒最小化），**绝不重复启动**已登录的应用，详见 [README](dsh-plugin-computer-use/README.md) | ≥ 0.1.5-rc.1（peer 声明），实测 0.1.6-alpha.2 | 跨平台（Windows 11 实测；macOS/Linux 未实测） | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | 「设置 → MCP 服务器」配置页：增删改 stdio / streamable-http 服务器，写入 profile patch 标记块并热生效（官方暂不提供 MCP 配置界面），详见 [README](dsh-plugin-mcp-ui/README.md) | ≥ 0.1.6-alpha.1（依赖 typert 网关，旧版不可用），实测 0.1.6-alpha.2 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |
| **team-task-route** | **私人配置，装了也没用**：把某一个智能体团队会话里的 teammate 固定到指定 provider / model / 推理档位，并 guard 掉 `subagent`、`spawn_teammate`、`workflow`、`create_goal`、`plugin_manager`。`index.js` 里写死了 session id，包本身标了 `private: true`，自用要先改那个 id | 实测 0.1.7-rc.1 | Win11 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-team-task-route` |

全部插件一次装完（`team-task-route` 是私人向，不在列表里）：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-image-generation \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-title-model \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

装完重启 dsh 就能用。注册配置打进包里了（`dsh.bundle.patch`），不需要动 cordis 文件。卸载把 `add` 换成 `remove`。

要改本仓库的代码来调试？见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)——把 profile 依赖换成指向本仓库的 `link:`，改完不用重装。

上表的版本区间为实测范围，未标注下限的插件不保证能在更早版本上运行。本轮迁移（0.1.7-alpha.2 → 0.1.7-rc.1）只改动了 image-generation、model-search、model-tuning、read-image-preview 四个插件并新增 shell-selector、title-model、team-task-route，**computer-use 与 mcp-ui 没有改动，也还没在 0.1.7 上复测**，它们的版本列仍是旧实测值。dsh 版本更新频繁，可能影响稳定性。并且插件均由 AI 完成，肯定会有很多潜在 bug。

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
| **image-generation** | Separate image models, Images API tools, a direct generation panel, previews and original downloads ([README](dsh-plugin-image-generation/README.md)) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-image-generation` |
| **model-search** | Search box in the model picker (name / ID / description / provider) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 (needs the 0.1.7 icons; won't work on 0.1.6 or older) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | Per-model reasoning effort, context window, max output and multimodal support in one settings page; the "Purposes" tab also hosts session-title model routing | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 (settings page uses profile-backed SettingsForms) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | Renders images in tool results as zoomable cards (click to enlarge, wheel to zoom, drag to pan) | ≥ 0.1.7-alpha.2, adapted to the three-stage tool calls of 0.1.7-rc.1 (`preparing` / `start` / result) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **shell-selector** | A "Settings → Shell" page for picking which shell the AI runs commands in: PowerShell 7 / Windows PowerShell 5.1 / a custom path. It only writes the `pwshPath` field the host's own `pwsh-sandbox` entry already supports, so the next command uses your choice — no restart, no swapped executor, and sandboxing, approval, timeouts and exit codes stay exactly as shipped; when 5.1 is active it also registers a dialect note so the model knows `&&` and `??` don't exist; Git Bash stays greyed out with the reason shown, because confined execution is unverified ([README](dsh-plugin-shell-selector/README.md)) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector` |
| **title-model** | Its own model for session-title generation: `inherit` (default) keeps the provider / model recorded on the session, or point it at a completely separate pair in settings. Registers exclusively through `ctx.sessionTitle.register()` (the bundle patch disables the shipped `session-title-llm` row first); prompt, input/output budgets, timeout and result validation all stay on the host's shared policy, so there is no second title pipeline. Settings live in the "Purposes" tab of model-tuning ([README](dsh-plugin-title-model/README.md)) | ≥ 0.1.7-alpha.2, tested on 0.1.7-rc.1 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-title-model` |
| **computer-use** | 13 `computer_*` tools: window screenshots + accessibility tree, mouse, keyboard, launching apps; input actions require approval; v2 runs on the in-process Cua Driver SDK (no daemon/MCP/PowerShell); since v2.3 "open app" reuses an existing window (restoring it when minimized) and **never starts a second instance** of an app that is already running ([README](dsh-plugin-computer-use/README.md)) | ≥ 0.1.5-rc.1 (peer dep), tested on 0.1.6-alpha.2 | Cross-platform (tested on Windows 11; macOS/Linux untested) | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | "Settings → MCP Servers" page: add/edit/remove stdio & streamable-http servers; writes them into the profile patch and hot-applies (the official build ships no MCP UI yet) ([README](dsh-plugin-mcp-ui/README.md)) | ≥ 0.1.6-alpha.1 (needs the typert gateway; won't work on older dsh), tested on 0.1.6-alpha.2 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |
| **team-task-route** | **Personal setup, useless to anyone else**: pins the teammates of one specific agent-team session to a chosen provider / model / reasoning effort and guards away `subagent`, `spawn_teammate`, `workflow`, `create_goal` and `plugin_manager`. The session id is hardcoded in `index.js` and the package is marked `private: true` — edit that id before using it | Tested on 0.1.7-rc.1 | Win11 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-team-task-route` |

All plugins at once (`team-task-route` is personal and left out):

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-image-generation \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-shell-selector \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-title-model \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

Restart dsh after installing. Registration is bundled in each package (`dsh.bundle.patch`), nothing to wire up. To remove: `dsh plugin --profile web remove <name>`.

Hacking on this repo? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — point the profile at your checkout with `link:` and you stop reinstalling after every edit.

The version ranges above are what has actually been tested; plugins without a stated lower bound aren't guaranteed to work on older dsh. This migration round (0.1.7-alpha.2 → 0.1.7-rc.1) touched image-generation, model-search, model-tuning and read-image-preview and added shell-selector, title-model and team-task-route; **computer-use and mcp-ui were not changed and have not been retested on 0.1.7**, so their version columns still show the older results. dsh updates frequently, which may affect stability. All the plugins are completed by AI, so there will certainly be many potential bugs.

dsh won't boot after an upgrade? Usually one plugin broke under the new version, and dsh takes the whole process down with it. This repo ships a boot-recovery tool (clone it first):

```sh
node tools/doctor/doctor.mjs --profile web
```

It figures out which plugin is at fault (via bisection, even when the error names nobody), tries `dsh plugin update` first, and if that fails asks whether to disable the plugin so dsh can start. Re-enable anytime with `enable <name>`.

More plugins may be added in the future.
