# 发布与迁移说明：model-tuning v3（2026-10-17）

本轮把 `model-tuning` 收窄为「只补官方没有的能力」，并发布三个 npm 包。基线是 **dsh 0.2.1-rc.1**（用户口径：rc 即正式版）。

## 1. 本次发布

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-model-tuning` | **3.0.0** | 破坏性收窄：删「用途（标题）」页与「模型参数」页；标题路由交还官方；保留官方没有的兼容/推理补丁与绘图（`generate_image`）。详见 [插件 README](../dsh-plugin-model-tuning/README.md) |
| `dsh-plugin-read-image-preview` | **1.6.0** | 查看器重写（缩放/标注/裁剪/发到输入框）、read_image 只填官方图库、抓屏框选；首次发布 |
| `tofu-box` | **1.1.0** | 伞包：去掉 model-search，依赖 `model-tuning ^3.0.0`、`read-image-preview ^1.6.0` |

其余子包版本不变：`computer-use 2.5.0`、`mcp-ui 1.0.3`、`shell-selector 0.1.0`（已发布过）。

发布顺序固定：先子包（`model-tuning`、`read-image-preview`），最后 `tofu-box`——伞包依赖子包的已发布版本。

## 2. 下线的插件（重要）

| 插件 | 状态 | 原因 / 替代 |
| --- | --- | --- |
| `dsh-plugin-model-search` | **2026-10 下线**（npm 停在 1.1.1） | 官方模型菜单自 0.2.0-rc.2 起自带搜索；本插件以 priority -1 整块替换官方菜单，会挡住官方后续加进菜单的功能。**替代：官方模型菜单自带的搜索框** |
| `dsh-plugin-team-task-route` | **2026-09 下线** | 把某一次团队会话的 teammate 写死模型；session id 硬编码，只对一次性调试有用 |
| `dsh-plugin-title-model` | **2026-10 下线**（先并入 model-tuning v2，v3 起彻底删除） | 官方 `session-title-llm` 行本来就有 provider/model 路由与预算配置；插件不应再用「替换官方行」的方式抢标题 provider。**替代：见 §4.1 profile 覆盖** |
| `dsh-plugin-image-generation` | **2026-10 下线**（能力并入 model-tuning，不再单独发包） | 绘图模型、`generate_image` / `list_image_models` 工具现在都在 model-tuning 里，配置键不变 |
| `dsh-plugin-codex-login` | 从未发布（`private: true`） | 在制品：Codex OAuth 登录 UI，等真实账号验证 |

已装旧包时先卸载（`dsh plugin --profile <p> remove <包名>`，桌面端在插件页移除），再装新包；**不要和新包混装**。`title-model` / `image-generation` 的绘图配置可以直接沿用（键名与命名空间未变）。

## 3. 安装 / 升级 / 卸载

### 一键装全套（推荐）

```sh
dsh plugin --profile web add tofu-box
```

桌面端：插件管理页的安装框里直接粘贴 `tofu-box`。装完重启 dsh。

`tofu-box` 是伞包：装它**或**逐个装子包，二选一，不要混装。伞包在插件页是一个整体条目，不能单独禁用其中某一个。

### 单独安装

```sh
dsh plugin --profile web add \
  dsh-plugin-model-tuning \
  dsh-plugin-read-image-preview \
  dsh-plugin-shell-selector \
  dsh-plugin-computer-use \
  dsh-plugin-mcp-ui
```

### 升级

- npm 版：`dsh plugin --profile <p> add tofu-box`（或对应子包）重新解析版本，然后重启 dsh；桌面端在插件页点更新。
- git 直装：`dsh plugin --profile <p> update <包>` 永远追 HEAD。
- 首次安装 `computer-use` 时 pnpm 可能拦下 koffi 的构建脚本：按提示在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds: koffi: false`（koffi 用预编译二进制）后重试。

### 卸载

```sh
dsh plugin --profile <p> remove tofu-box          # 整套
dsh plugin --profile <p> remove dsh-plugin-model-tuning   # 单个
```

卸载 model-tuning 后：「设置 → 绘图」与 `generate_image`/`list_image_models` 工具下线；官方 Models 页的「兼容与推理」「绘图模型」两节消失；已存的绘图配置留在 settings 里成为未注册命名空间的数据，不删除任何图片或凭据。

## 4. 从 model-tuning v2 升级到 3.0.0

### 4.1 标题生成：交还官方

v2 会 `disabled` 官方 `session-title-llm` 行并注册自己的 provider；v3 不再动组合，官方行恢复。原来在「用途」页设置的 `titleMode` / `titleProvider` / `titleModel` 与四个预算字段**被忽略**（Loader 保留未知键，profile 仍能启动）。

需要独立标题模型时，在 profile 的 `cordis.patch.yml` 覆盖官方行：

```yaml
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  config:
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 4096
    timeoutMs: 60000
    provider: your-provider     # 成对出现；省略两者则继承会话路由
    model: your-model
```

官方可选组合包「随对话更新的标题」也与本插件不再互斥。

### 4.2 模型参数：交还官方

上下文窗口、最大输出、输入模态、模型列表、API Key、模型发现都在官方「设置 → 模型」页。v3 只在官方 Models 页补三样官方没有的：

- 每模型「系统提示角色」`compat.supportsDeveloperRole`；
- 每模型「思考格式」`compat.forceAdaptiveThinking`（仅 anthropic-messages 路由）；
- 已安装目录路由的推理档位覆盖 `modelOverrides.<id>.reasoningEfforts`。

### 4.3 绘图：入口从旧「模型参数」页移到官方 Models 页

v2 的「生图模型」勾选在已删除的「模型参数」页里；v3 恢复同样的能力，位置改为：

**设置 → 模型 → 展开某个 pi-ai provider 卡片 → 绘图模型（generate_image）→ 勾选模型。**

- 勾选复用该 provider 的 `baseURL`（+ `/images/generations`）与 `apiKeyEnv`，不需要重新填地址/Key；
- 取消勾选只移除由勾选创建的条目，不动手动添加的；
- 「设置 → 绘图」页负责：单选默认模型、编辑/删除、手动添加独立端点（可选）、直接绘图（默认折叠）。

v2 的 `models` / `defaultModel` 配置键与命名空间不变，升级后原配置直接生效。

## 5. 验证记录（本轮）

- 隔离开发 profile（`docs/DEVELOPMENT.md`）里：五个插件 `link:` 安装、`--dump-config` 组合正确、启动无 `did not activate`；官方 `session-title-llm` 行恢复启用。
- 单测：model-tuning 40 pass / 2 skip（skip 为需要部署目录的 pi-ai 耦合守卫）；read-image-preview、shell-selector、codex-login、computer-use 之前一轮均通过。
- v2 旧配置（含已删除的标题字段 + 旧绘图配置）启动兼容：实测通过。
- 真实页面（web 开发 profile）：官方 Models 页的「兼容与推理」「绘图模型（generate_image）」两节、绘图页的单选/手动端点/直绘折叠均人工确认。
- 未做：真实模型请求级回归（标题生成、`generate_image` 实际出图）——升级后按需用真实 Key 验一次即可。

## 6. 相关文档

- [插件与官方功能重叠盘点（dsh 0.2.1-rc.1）](PLUGIN-SCOPE-dsh-0.2.1-rc.1.md)
- [开发：隔离测试 profile](DEVELOPMENT.md#隔离测试-profile不要动桌面端的-profile)
- [dsh 0.2.1-alpha.4/rc.1 升级记录](UPGRADE-dsh-0.2.1-alpha.4.md)
- 各插件 README：[model-tuning](../dsh-plugin-model-tuning/README.md) · [read-image-preview](../dsh-plugin-read-image-preview/README.md) · [shell-selector](../dsh-plugin-shell-selector/README.md) · [computer-use](../dsh-plugin-computer-use/README.md) · [mcp-ui](../dsh-plugin-mcp-ui/README.md)
