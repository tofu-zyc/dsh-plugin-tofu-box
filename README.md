# 🧊 TOFU BOX

一块豆腐给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加料的插件仓库：模型菜单秒搜、推理档集中调、工具结果看图、还能让 AI 替你点鼠标。

| 插件 | 一句话 | 安装 |
| --- | --- | --- |
| [model-search](dsh-plugin-model-search/) | 模型选择菜单加搜索框（名称/ID/描述/provider 过滤） | 见下 |
| [model-tuning](dsh-plugin-model-tuning/) | 各模型的推理档位 / 上下文窗口 / 最大输出集中配置 | 见下 |
| [read-image-preview](dsh-plugin-read-image-preview/) | 工具结果里的图像渲染成可缩放图片卡（点击放大、滚轮缩放、拖动平移） | 见下 |
| [computer-use](dsh-plugin-computer-use/) | 12 个 `computer_*` 工具：截图、鼠标、键盘、开应用，AI 直接操作桌面（带审批门禁） | 见下 |

## 安装

`dsh plugin` 就是 pnpm，git 源原生支持。装单个插件（子目录语法 `#path:`）：

```sh
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-search
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-model-tuning
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-read-image-preview
dsh plugin --profile web add git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-computer-use
```

（`--profile web` 换成你自己的 profile 名；Windows 上如果 git 走代理，命令前加 `HTTPS_PROXY=http://127.0.0.1:7890` 这类前缀。）

装完**重启 dsh 进程**即可生效——每个包都带 `dsh.bundle.patch` 自注册，**不需要手写任何 cordis 配置**。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-model-search
```

## 各插件详情

- **model-search**：模型多了翻不动？输入栏的模型座位点开就有搜索框。
- **model-tuning**：每个模型该开多大上下文、几档推理，设置页一屏配完。
- **read-image-preview**：`read_image` 以及任何带图工具结果（含 computer-use 的截图）都会渲染成缩略图卡片，点开全屏、Ctrl+滚轮缩放。纯 UI，装了就有。
- **computer-use**：让模型看见桌面并操作。写操作走原生审批（默认同一会话批一次），鼠标动作结束后指针自动回到你的原位，多显示器/DPI 自适应。详见其 [README](dsh-plugin-computer-use/README.md)。

## 兼容性

开发适配于 dsh `0.1.x`（当前 0.1.5-rc）。dsh 还在快速演进，API 若变动会在新版本跟进；如遇新版不兼容，先看各插件 README，再欢迎开 issue。

## 维护说明

自用副产品，随缘维护：我们在用就会保持能跑，不承诺支持时限。PR 欢迎（先开 issue 对齐再动手更稳）。fork 自由，MIT。

## 许可

MIT，见 [LICENSE](LICENSE)。
