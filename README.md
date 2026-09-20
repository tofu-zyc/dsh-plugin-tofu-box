# TOFU BOX

自己日常用的一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件，都在这个仓库里，直接从 GitHub 安装。

[中文](#中文) · [English](#english)

---

## 中文

把下面命令里的 `--profile web` 换成你自己的 profile。

| 插件 | 说明 | 支持的 dsh 版本 | 平台 | 安装 |
| --- | --- | --- | --- | --- |
| **image-generation** | 独立绘图模型配置、Images API 工具和直接绘图面板，预览与原图下载；[使用说明](dsh-plugin-image-generation/README.md) | ≥ 0.1.6-alpha.1；alpha.2 附件后端验证 | Win11 本地模拟接口与浏览器验证；真实服务未测 | 本地：`dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-image-generation"` |
| **model-search** | 模型选择菜单加一个搜索框，按名称 / ID / 描述 / provider 过滤 | 0.1.5-rc ~ 0.1.6-alpha 实测 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | 集中配置各模型的推理档位、上下文窗口、最大输出、多模态支持等 | 0.1.5-rc ~ 0.1.6-alpha 实测 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | 工具结果里的图片（read_image、截图等）渲染成图片卡，点击放大、滚轮缩放、拖动平移 | 0.1.5-rc ~ 0.1.6-alpha 实测 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **computer-use** | 13 个 `computer_*` 工具：截图/元素树、鼠标、键盘、开应用，写操作有审批弹窗；v2 基于 Cua Driver 进程内 SDK（无守护/MCP/PowerShell），v2.3 起「打开应用」先在窗口表里复用已有窗口（含唤醒最小化），**绝不重复启动**已登录的应用，详见 [README](dsh-plugin-computer-use/README.md) | ≥ 0.1.5-rc.1（peer 声明），实测至 0.1.6-alpha | 跨平台（Windows 11 实测；macOS/Linux 未实测） | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | 「设置 → MCP 服务器」配置页：增删改 stdio / streamable-http 服务器，写入 profile patch 标记块并热生效（官方暂不提供 MCP 配置界面），详见 [README](dsh-plugin-mcp-ui/README.md) | ≥ 0.1.6-alpha.1（依赖 typert 网关，旧版不可用），实测 0.1.6-alpha.1 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

已发布插件全装（绘图插件先按上表本地安装）：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

装完重启 dsh 就能用。注册配置打进包里了（`dsh.bundle.patch`），不需要动 cordis 文件。卸载把 `add` 换成 `remove`。

要改本仓库的代码来调试？见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)——把 profile 依赖换成指向本仓库的 `link:`，改完不用重装。

上表的版本区间为实测范围，未标注下限的插件不保证能在更早版本上运行。dsh 版本更新频繁，可能影响稳定性。并且插件均由 AI 完成，肯定会有很多潜在 bug。

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
| **image-generation** | Separate image models, Images API tools, a direct generation panel, previews and original downloads ([README](dsh-plugin-image-generation/README.md)) | ≥ 0.1.6-alpha.1; attachment backend checked on alpha.2 | Win11 local HTTP/browser tests; real providers untested | Local: `dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-image-generation"` |
| **model-search** | Search box in the model picker (name / ID / description / provider) | Tested on 0.1.5-rc ~ 0.1.6-alpha | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | Per-model reasoning effort, context window, max output and multimodal support in one settings page | Tested on 0.1.5-rc ~ 0.1.6-alpha | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | Renders images in tool results as zoomable cards (click to enlarge, wheel to zoom, drag to pan) | Tested on 0.1.5-rc ~ 0.1.6-alpha | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **computer-use** | 13 `computer_*` tools: window screenshots + accessibility tree, mouse, keyboard, launching apps; input actions require approval; v2 runs on the in-process Cua Driver SDK (no daemon/MCP/PowerShell); since v2.3 "open app" reuses an existing window (restoring it when minimized) and **never starts a second instance** of an app that is already running ([README](dsh-plugin-computer-use/README.md)) | ≥ 0.1.5-rc.1 (peer dep), tested through 0.1.6-alpha | Cross-platform (tested on Windows 11; macOS/Linux untested) | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | "Settings → MCP Servers" page: add/edit/remove stdio & streamable-http servers; writes them into the profile patch and hot-applies (the official build ships no MCP UI yet) ([README](dsh-plugin-mcp-ui/README.md)) | ≥ 0.1.6-alpha.1 (needs the typert gateway; won't work on older dsh), tested on 0.1.6-alpha.1 | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

All published plugins at once (install image-generation locally as shown above):

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

Restart dsh after installing. Registration is bundled in each package (`dsh.bundle.patch`), nothing to wire up. To remove: `dsh plugin --profile web remove <name>`.

Hacking on this repo? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — point the profile at your checkout with `link:` and you stop reinstalling after every edit.

The version ranges above are what has actually been tested; plugins without a stated lower bound aren't guaranteed to work on older dsh. dsh updates frequently, which may affect stability. All the plugins are completed by AI, so there will certainly be many potential bugs.

dsh won't boot after an upgrade? Usually one plugin broke under the new version, and dsh takes the whole process down with it. This repo ships a boot-recovery tool (clone it first):

```sh
node tools/doctor/doctor.mjs --profile web
```

It figures out which plugin is at fault (via bisection, even when the error names nobody), tries `dsh plugin update` first, and if that fails asks whether to disable the plugin so dsh can start. Re-enable anytime with `enable <name>`.

More plugins may be added in the future.
