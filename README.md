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

全装：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

装完重启 dsh 就能用。注册配置打进包里了（`dsh.bundle.patch`），不需要动 cordis 文件。卸载把 `add` 换成 `remove`。

目前基于 dsh 0.1.5-rc 开发，dsh 版本更新概率影响稳定性。并且插件均由 AI 完成，肯定会有很多潜在 bug。

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

All at once:

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

Restart dsh after installing. Registration is bundled in each package (`dsh.bundle.patch`), nothing to wire up. To remove: `dsh plugin --profile web remove <name>`.

Built against dsh 0.1.5-rc. dsh updates frequently, which may affect stability.

More plugins may be added in the future. All the plugins are completed by AI, so there will certainly be many potential bugs.
