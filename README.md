# TOFU BOX

DeepSeek Harness 插件合集 / A collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins.

[中文](#中文) · [English](#english)

---

## 中文

为 DeepSeek Harness（dsh）日常使用而生的一组插件：模型菜单秒搜、推理档集中调、工具结果看图、以及让 AI 在审批门禁下直接操作桌面。

| 插件 | 一句话 |
| --- | --- |
| [model-search](dsh-plugin-model-search/) | 模型选择菜单加搜索框（名称 / ID / 描述 / provider 过滤） |
| [model-tuning](dsh-plugin-model-tuning/) | 各模型的推理档位 / 上下文窗口 / 最大输出集中配置 |
| [read-image-preview](dsh-plugin-read-image-preview/) | 工具结果里的图像渲染成可缩放图片卡（点击放大、滚轮缩放、拖动平移） |
| [computer-use](dsh-plugin-computer-use/) | 12 个 `computer_*` 工具：截图、鼠标、键盘、开应用（带审批门禁） |

### 安装

`dsh plugin` 就是 pnpm，git 源原生支持。装单个插件用子目录语法 `#path:`：

```sh
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

- `--profile web` 换成你自己的 profile 名。
- Windows 上 git 走代理的话，命令前加 `HTTPS_PROXY=http://127.0.0.1:7890` 这类前缀。
- 装完**重启 dsh 进程**生效。每个包都带 `dsh.bundle.patch` 自注册，**不需要手写任何 cordis 配置**。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-model-search
```

### 各插件详情

- **model-search**：模型多了翻不动？输入栏的模型座位点开就有搜索框。
- **model-tuning**：每个模型开多大上下文、几档推理，设置页一屏配完。
- **read-image-preview**：`read_image` 以及任何带图工具结果（含 computer-use 的截图）都会渲染成缩略图卡片，点开全屏、Ctrl+滚轮缩放。纯 UI，装了就有；与其他带图插件天然兼容。
- **computer-use**：让模型看见桌面并操作。写操作走原生审批（默认同一会话批一次），指针动作结束后自动回到你的原位，多显示器 / DPI 自适应。详见其 [README](dsh-plugin-computer-use/README.md)。

### 兼容性与维护

开发适配于 dsh `0.1.x`（当前 0.1.5-rc）。dsh 还在快速演进，API 变动会在新版本跟进；遇到不兼容欢迎开 issue。

自用副产品，随缘维护：在用就会保持能跑，不承诺支持时限。PR 欢迎（先开 issue 对齐再动手更稳）。MIT。

---

## English

A set of plugins born from daily DeepSeek Harness use: instant model-menu search, centralized per-model tuning, image cards for tool results, and — behind an approval gate — letting the AI drive your desktop.

| Plugin | In one line |
| --- | --- |
| [model-search](dsh-plugin-model-search/) | Adds a search box to the model picker (filter by name / ID / description / provider) |
| [model-tuning](dsh-plugin-model-tuning/) | Central config for per-model reasoning effort, context window and max output |
| [read-image-preview](dsh-plugin-read-image-preview/) | Renders images in tool results as zoomable cards (click to fullscreen, wheel to zoom, drag to pan) |
| [computer-use](dsh-plugin-computer-use/) | 12 `computer_*` tools: screenshot, mouse, keyboard, launch apps — with an approval gate |

### Install

`dsh plugin` is pnpm under the hood, so git sources work natively. Use the sub-directory syntax `#path:` to install a single plugin:

```sh
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

- Replace `--profile web` with your own profile name.
- Restart your dsh process after installing. Every package self-registers via `dsh.bundle.patch` — **no cordis config to hand-write**.
- Uninstall: `dsh plugin --profile web remove dsh-plugin-model-search`.

### Details

- **model-search**: too many models to scroll? The picker now has a search box.
- **model-tuning**: context window, reasoning effort and max output for every model, configured on one settings page.
- **read-image-preview**: `read_image` and any image-bearing tool result (including computer-use screenshots) renders as a thumbnail card — click for fullscreen, Ctrl+wheel to zoom. Pure UI; composes with any plugin that returns images.
- **computer-use**: lets the model see the desktop and act on it. Every mutating action goes through the native approval flow (once per session by default); the cursor returns to where you left it after pointer gestures; multi-monitor and DPI aware. See its [README](dsh-plugin-computer-use/README.md).

### Compatibility & maintenance

Developed against dsh `0.1.x` (currently 0.1.5-rc). dsh is evolving fast; breakages from upstream API changes will be fixed in new releases — please open an issue if something breaks.

Side projects we dogfood: maintained as we use them, no support guarantees. PRs welcome (open an issue first for anything non-trivial). MIT.
