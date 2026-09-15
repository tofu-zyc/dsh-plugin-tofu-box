# TOFU BOX

DeepSeek Harness 插件合集 / A collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins.

[中文](#中文) · [English](#english)

---

## 中文

为 DeepSeek Harness（dsh）日常使用而生的一组插件：模型菜单秒搜、推理档集中调、工具结果看图、以及让 AI 在审批门禁下直接操作桌面。

### 安装全部

一条命令装下所有插件（`--profile web` 换成你自己的 profile 名）：

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

### 只装某一个

- **model-search** — 模型选择菜单加搜索框（名称 / ID / 描述 / provider 过滤）
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search
  ```
- **model-tuning** — 各模型的推理档位 / 上下文窗口 / 最大输出集中配置
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning
  ```
- **read-image-preview** — 工具结果里的图像渲染成可缩放图片卡（点击放大、滚轮缩放、拖动平移）
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview
  ```
- **computer-use** — 12 个 `computer_*` 工具：截图、鼠标、键盘、开应用（带审批门禁），详见其 [README](dsh-plugin-computer-use/README.md)
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
  ```

### 生效与卸载

- 每个包都带 `dsh.bundle.patch` 自注册，**不需要手写任何 cordis 配置**；装完**重启 dsh 进程**即生效。
- 卸载把 `add` 换成 `remove`、带上包名即可：

  ```sh
  dsh plugin --profile web remove dsh-plugin-model-search
  ```

### 兼容性与维护

开发适配于 dsh `0.1.x`（当前 0.1.5-rc）。dsh 还在快速演进，API 变动会在新版本跟进；遇到不兼容欢迎开 issue。

自用副产品，随缘维护：在用就会保持能跑，不承诺支持时限。PR 欢迎（先开 issue 对齐再动手更稳）。MIT。

---

## English

A set of plugins born from daily DeepSeek Harness use: instant model-menu search, centralized per-model tuning, image cards for tool results, and — behind an approval gate — letting the AI drive your desktop.

### Install everything

One command for the whole collection (replace `--profile web` with your own profile name):

```sh
dsh plugin --profile web add \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview \
  git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

### Install a single plugin

- **model-search** — a search box in the model picker (filter by name / ID / description / provider)
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search
  ```
- **model-tuning** — central config for per-model reasoning effort, context window and max output
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning
  ```
- **read-image-preview** — renders images in tool results as zoomable cards (click to fullscreen, wheel to zoom, drag to pan)
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview
  ```
- **computer-use** — 12 `computer_*` tools: screenshot, mouse, keyboard, launch apps, all behind an approval gate; see its [README](dsh-plugin-computer-use/README.md)
  ```sh
  dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
  ```

### Activate & uninstall

- Every package self-registers via `dsh.bundle.patch` — **no cordis config to hand-write**. Restart your dsh process after installing.
- To remove, swap `add` for `remove` with the package name:

  ```sh
  dsh plugin --profile web remove dsh-plugin-model-search
  ```

### Compatibility & maintenance

Developed against dsh `0.1.x` (currently 0.1.5-rc). dsh is evolving fast; breakages from upstream API changes will be fixed in new releases — please open an issue if something breaks.

Side projects we dogfood: maintained as we use them, no support guarantees. PRs welcome (open an issue first for anything non-trivial). MIT.
