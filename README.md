# TOFU BOX

自己日常用的一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件，都在这个仓库里，直接从 GitHub 安装。

[中文](#中文) · [English](#english)

---

## 中文

把下面命令里的 `--profile web` 换成你自己的 profile。

| 插件 | 说明 | 平台 | 安装 |
| --- | --- | --- | --- |
| **model-search** | 模型选择菜单加一个搜索框，按名称 / ID / 描述 / provider 过滤 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | 集中配置各模型的推理档位、上下文窗口、最大输出、多模态支持等 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | 工具结果里的图片（read_image、截图等）渲染成图片卡，点击放大、滚轮缩放、拖动平移 | Win11 实测；Linux/macOS 未测 | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **computer-use** | 12 个 `computer_*` 工具：截图、鼠标、键盘、开应用，写操作有审批弹窗，详见 [README](dsh-plugin-computer-use/README.md) | 仅 Windows（依赖 PowerShell + Win32 API） | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | 「设置 → MCP 服务器」配置页：增删改 stdio / streamable-http 服务器，写入 profile patch 标记块并热生效（官方暂不提供 MCP 配置界面），详见 [README](dsh-plugin-mcp-ui/README.md) | Win11 实测；需 dsh 0.1.6+ | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

全装：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

装完重启 dsh 就能用。注册配置打进包里了（`dsh.bundle.patch`），不需要动 cordis 文件。卸载把 `add` 换成 `remove`。

已在 dsh 0.1.5-rc 和 0.1.6-alpha 两个版本上实测。dsh 版本更新频繁，可能影响稳定性。并且插件均由 AI 完成，肯定会有很多潜在 bug。

升级 dsh 后起不来？多数是某个插件在新版本下坏了，而 dsh 默认一个插件崩就整个不启动。仓库自带一个启动急救工具（clone 本仓库后运行）：

```sh
node tools/doctor/doctor.mjs --profile web
```

它会自动定位是哪个插件的问题（报错没点名也能靠二分测试查出来），先尝试 `dsh plugin update` 修复，修不好会问你要不要先禁用该插件让 dsh 跑起来，事后 `enable` 一键恢复。

未来可能新增更多插件。

---

## English

A few [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins I use daily. Install straight from GitHub — replace `--profile web` with your profile.

| Plugin | What it does | Platform | Install |
| --- | --- | --- | --- |
| **model-search** | Search box in the model picker (name / ID / description / provider) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search` |
| **model-tuning** | Per-model reasoning effort, context window, max output and multimodal support in one settings page | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning` |
| **read-image-preview** | Renders images in tool results as zoomable cards (click to enlarge, wheel to zoom, drag to pan) | Tested on Win11; Linux/macOS untested | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview` |
| **computer-use** | 12 `computer_*` tools: screenshots, mouse, keyboard, launching apps; input actions require approval ([README](dsh-plugin-computer-use/README.md)) | Windows only (PowerShell + Win32 API) | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use` |
| **mcp-ui** | "Settings → MCP Servers" page: add/edit/remove stdio & streamable-http servers; writes them into the profile patch and hot-applies (the official build ships no MCP UI yet) ([README](dsh-plugin-mcp-ui/README.md)) | Tested on Win11; requires dsh 0.1.6+ | `dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui` |

All at once:

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-mcp-ui
```

Restart dsh after installing. Registration is bundled in each package (`dsh.bundle.patch`), nothing to wire up. To remove: `dsh plugin --profile web remove <name>`.

Tested on both dsh 0.1.5-rc and 0.1.6-alpha. dsh updates frequently, which may affect stability. All the plugins are completed by AI, so there will certainly be many potential bugs.

dsh won't boot after an upgrade? Usually one plugin broke under the new version, and dsh takes the whole process down with it. This repo ships a boot-recovery tool (clone it first):

```sh
node tools/doctor/doctor.mjs --profile web
```

It figures out which plugin is at fault (via bisection, even when the error names nobody), tries `dsh plugin update` first, and if that fails asks whether to disable the plugin so dsh can start. Re-enable anytime with `enable <name>`.

More plugins may be added in the future.
