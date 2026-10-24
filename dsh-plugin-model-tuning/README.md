# dsh-plugin-model-tuning

只补**官方没有的两块**：

1. **官方「设置 → 模型」卡片里的兼容与推理补丁**（内嵌在官方 Models 页，不再有独立参数页）；
2. **「设置 → 绘图」页**：绘图模型配置 + `generate_image` / `list_image_models` 工具 + 直接绘图面板。

> **v3 边界收缩（2026-10，基线 dsh 0.2.1-rc.1）**：v2 合并进来的「标题生成路由」交还官方 `session-title-llm` 行，「模型参数」页交还官方 Models 页。官方已经能做的，本插件不再复制；官方没有的，见下面两节。重叠盘点记录见 [docs/PLUGIN-SCOPE-dsh-0.2.1-rc.1.md](../docs/PLUGIN-SCOPE-dsh-0.2.1-rc.1.md)。

> 兼容性：`engines.dsh` = `>=0.2.0-rc.2 <0.3.0-0`，已在 dsh 0.2.1-rc.3 上实测运行。

## 1. 兼容与推理（官方 Models 页扩展）

通过官方为仓库外插件留的 `settings.models.provider-card` 席位，在每张 pi-ai provider 卡片里追加一节「兼容与推理（插件补充）」。**这些控件官方 Models 页没有**：

| 控件 | 写入位置 | 解决什么 |
| --- | --- | --- |
| **系统提示角色** `自动 / system / developer` | 模型条目的 `compat.supportsDeveloperRole` | 网关报 `role 'developer' is not allowed`（Kimi、部分 DeepSeek 网关）时改发 `system` |
| **思考格式** `自动 / 自适应 thinking` | 模型条目的 `compat.forceAdaptiveThinking` | Claude Opus 4.6+ / Sonnet 5 等只接受 `thinking.type=adaptive`，预算式请求会被 400 `requires adaptive thinking` 拒绝 |
| **可选推理档位**（内置目录路由） | 路由的 `modelOverrides.<id>.reasoningEfforts` | 官方只给**手写路由**的模型显示推理档位；内置目录路由借用 `modelOverrides` 声明/关掉档位，写入时保留官方已存的每档 API 值 |
| **绘图模型** 勾选 | 本插件的 `models` / `defaultModel` | 把该 provider 下的模型接到 `generate_image`：自动复用 provider 的 `baseURL`（+ `/images/generations`）与 `apiKeyEnv`，并在「设置 → 绘图」生成一条配置（对应旧版「模型参数 → 生图模型」勾选） |

说明：

- provider 卡片里只显示 **pi-ai** 家族；`llm-deepseek` 不出现这一节。
- 思考格式只在路由自己声明 `api: anthropic-messages` 时出现；推理档位只在**已安装目录路由**（`declared !== true`）出现——手写路由交给官方页面，避免两个编辑器抢同一字段。
- 写入走 provider 自己的 settings 命名空间（`llm-pi-ai`），下一次请求生效，无需重启。
- 「系统提示角色」的字段名与协议白名单由 `@deepseek-ai/dsh-llm-pi-ai` 决定；上游改名/收窄会在 `tests/adaptive-thinking.test.mjs` 的耦合守卫里失败，而不是在会话里变成 400。

## 2. 绘图（generate_image）

给模型一个扩散模型绘图工具；绘图配置不进入聊天模型列表、不改动会话存储或对话 provider。

**主要用法：在「设置 → 模型」里勾选。** 展开某个 pi-ai provider 卡片 → 「绘图模型（generate_image）」→ 勾上要用的模型。勾选会：

- 复用该 provider 的 `baseURL` 推导 `…/images/generations`，复用其 `apiKeyEnv` 凭据引用（不用重新填 Key）；
- 在「设置 → 绘图」生成一条配置；第一个生成的配置自动成为默认；
- 取消勾选只移除由此勾选生成的配置（手工添加的条目不受影响）。

**「设置 → 绘图」页**用于查看和管理这些配置：

- 单选按钮切换默认绘图模型（`generate_image` 不带 `model` 参数时用它）；
- 「手动添加端点」：给没有对应聊天模型的独立 Images 端点用（地址 + Key + 模型列表/手填模型 ID，高级参数在折叠区）；
- 底部「直接绘图（可选）」：不经过聊天，直接提交提示词、轮询状态、取消。

聊天中由助手调用：

- `list_image_models`：列出配置 ID、上游模型 ID 与默认参数；
- `generate_image`：按配置发起 OpenAI Images 请求（1–4 张），原图逐字节保留；当前聊天模型声明了图像输入时，预览也进模型上下文。

协议：OpenAI Images（`POST`，解析 `data[].b64_json` 或 `data[].url`）。凭据通过 dsh 凭据服务保存为引用（`apiKeyEnv`），不写明文。

## 配置结构

profile 条目 id `model-tuning` 的 Config（volatile，热更新即时生效）：

```yaml
- id: model-tuning
  name: dsh-plugin-model-tuning
  config:
    models:
      - id: my-art
        name: 我的绘图模型
        model: your-model-id
        api: openai-images
        endpoint: https://api.openai.com/v1/images/generations
        apiKeyEnv: IMAGE_API_KEY
        timeoutSeconds: 300
    defaultModel: my-art
```

v2 的标题字段（`titleMode` / `titleProvider` / `titleModel` 与四个预算字段）已从 schema 移除；Loader 的配置校验保留未知键，所以旧 profile 仍能启动，多余字段被忽略。

## 从 v2 升级

1. **标题生成**：v2 会禁用官方 `session-title-llm` 行并换上自己的 provider；v3 不再动组合，官方行恢复。需要独立标题模型时，在 profile 的 `cordis.patch.yml` 直接覆盖官方行（字段与官方一致）：

   ```yaml
   - id: session-title-llm
     name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
     config:
       targetWords: 5
       targetCjkCharacters: 10
       maxInputBytes: 4096
       maxOutputTokens: 4096
       timeoutMs: 60000
       provider: your-provider     # 成对出现；省略两者即继承会话路由
       model: your-model
   ```

   官方可选组合包「随对话更新的标题」也不再与本插件互斥。
2. **模型参数**：上下文窗口、最大输出、输入模态、模型列表、API Key、模型发现都在官方「设置 → 模型」页；本插件只保留上表的三项官方缺口。
3. **绘图**：配置键（`models` / `defaultModel`）与命名空间都没变，升级后原配置继续生效；「在模型行勾选生图模型」的入口已恢复，只是位置从旧「模型参数」页移到了官方「设置 → 模型」的 provider 卡片里。

## 安装 / 卸载

```powershell
dsh plugin --profile web add "link:D:\program\dsh-plugins\dsh-plugin-model-tuning"
dsh plugin --profile web remove dsh-plugin-model-tuning
```

装/卸后重启 profile 生效（组合在进程启动时组树）。卸载后：官方 Models 页少一节「兼容与推理」；绘图页消失、`generate_image` 工具下线；已存绘图配置留在 settings 里成为未注册命名空间的数据，不删除任何图片附件或共享凭据。

## 与 dsh 版本的耦合点

- 基线：**dsh 0.2.1-rc.1**（本机实测）。官方 `settings.models.provider-card` 席位自 0.1.2-alpha 存在，`plugins.row.config` 自 0.1.6；但本包只按 rc 线验证。
- 依赖宿主包：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/schemastery`。
- 绘图 Remote：浏览器 `ctx.connection.rpc.call('/api', 'imageGeneration/<method>')` × 宿主 `TypertRemoteService`。

## 测试与验证

```sh
node --test tests/*.test.mjs
```

- `image.test.mjs`：绘图传输、工具 schema、Remote 方法与热配置（本地 HTTP，不外联）；
- `image-link.test.mjs`：模型行「绘图」勾选的推导与增量写入（端点/凭据复用、默认项、取消勾选只删自己创建的条目）；
- `reasoning-efforts.test.mjs`：推理档位写入规划，不覆盖官方已存 API 值；
- `adaptive-thinking.test.mjs`：思考格式开关的写入规划 + 对已部署 pi-ai 的请求体耦合守卫（需要 `DSH_TEST_DEPLOY_ROOT`，跳过时不算失败）。

这些测试不是实机验证。实机验证放在隔离 profile（见 [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#隔离测试-profile不要动桌面端的-profile)）：确认官方 Models 卡片出现「兼容与推理」、开关写入后会话日志里的请求体变化、绘图页能出图。**不要用桌面端正在运行的 profile 做验证。**
