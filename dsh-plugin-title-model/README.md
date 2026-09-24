# dsh-plugin-title-model

为「会话标题生成」提供**独立模型设置**的宿主侧插件：默认继承当前会话已记录的 provider / model，也可以在设置里指定一个完全独立的 provider / model。界面上位于
[`dsh-plugin-model-tuning`](../dsh-plugin-model-tuning/README.md) 设置页的**「用途」**页签，绘图专有参数仍留在「绘图」页。

本插件**只决定标题请求走哪个模型**。标题请求的提示词、输入字节上限、输出 token 上限、超时、取消与结果校验全部沿用宿主既有的共享策略，因此不会出现第二套标题生成行为。

## 它替换了什么

宿主自带一行标题生成 provider：

```yaml
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
```

`ctx.sessionTitle.register()` **只允许一个 provider，第二次注册直接抛错**，所以本插件的 `cordis.patch.yml` 按官方惯用法显式替换该行：

```yaml
- id: session-title-llm
  disabled: true          # 必须先摘掉原行，否则 boot 时重复注册会失败
- insert:
    - id: title-model
      name: dsh-plugin-title-model
      config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 }
```

- **顺序即语义**：`disabled` 必须排在 `insert` 之前，否则两行会同时注册。
- `config` 与 base 的数值逐项相同：即使本包的 `config:` 块被删掉，标题预算行为也不变。
- 注册时沿用原 provider id（`session-title-llm`）与原 cadence（`first-prompt`），因此会话日志里的标题归因不变。
- 卸载本 bundle 会同时移除 `disabled` 与 `insert` 两条 patch，宿主自带的 provider 自动恢复。
- 最终组合里只有**一个**可用的标题 provider（`session-title-llm` 行已 `disabled`，`title-model` 行启用），
  由 `session-title` 服务行提供注册缝。`tests/` 之外还有一条离线校验方式：用
  `@deepseek-ai/dsh-app-boot` 的 `composeEntries` 把本 profile 的全部 bundle patch 加上本包 patch
  组合一遍，确认目标行被禁用、插入行存在、且没有 patch 警告。

## 设置

profile 条目 id `title-model` 的三个 volatile Config 字段（可在设置页热更新）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `inherit` | `inherit` 沿用该会话已记录的 provider / model；`custom` 使用下面的路由 |
| `provider` | — | `custom` 时的 provider 路由，来自本机已注册的 provider 目录 |
| `model` | — | `custom` 时的 model id，来自该 provider 的真实 catalog |

- `provider` 与 `model` 必须**同时填写或同时留空**；`mode: custom` 缺少其一时，插件设置页拒绝提交；直接绕过页面写入的无效组合会在标题请求前被拒绝，不会触发错误的模型调用。
- 切回 `inherit` 会**清空**整条路由（`unset` 三个字段），不会残留一个仍具权威性的旧值。
- 每次生成都重新读取设置，因此保存后**下一次标题生成**即生效，不需要重启宿主。
- 生效范围是**本 profile 之后生成的标题**（含新会话与后续标题生成）；已有标题、手动重命名、会话的对话模型都不受影响。
- 不提供推理档位控件：共享策略不向标题请求传递 `reasoningEffort`，标题请求沿用宿主自身的 purpose 策略（DeepSeek 适配器对 `session-title` 按设计固定关闭思考）。加一个不生效的档位控件会误导使用者。

## 模块解析（重要）

`@deepseek-ai/dsh-session-title-llm` 由**运行本插件的那个部署**提供，而不是从本包目录解析。原因：本包在工作区里是 `link:` 依赖，若在包内安装该依赖，会连带把 `@deepseek-ai/dsh-llm` 等 peer 装成与部署不同的版本，形成重复模块图。

`index.js` 因此用宿主自身入口锚点 `createRequire(process.argv[1])` 定位并动态 `import()` 该包，并保留 `process.execPath`、`import.meta.url` 作为回退。解析失败时 `apply()` 会**大声失败**并给出明确文案，不会静默退化。

包的 `peerDependencies` 已声明 `@deepseek-ai/dsh-session-title-llm`（`optional`），部署本身已包含该包（`@deepseek-ai/dsh-base` 依赖它），因此通常无需额外安装。

## 测试

```bash
npm test
```

- `tests/route.test.mjs`：路由解析与设置校验（纯函数）。
- `tests/provider.test.mjs`：用**假 ctx + 真共享策略**（只 mock `ctx.llm.stream`）验证唯一注册、继承/指定路由、首条消息选择、辅助请求记录、失败与取消路径。

`tests/_host.mjs` 要求 `DSH_TEST_DEPLOY_ROOT` 显式指向隔离的 dsh 0.1.7-alpha.2 部署；只影响测试进程的解析锚点，不参与插件运行。测试前设置该环境变量，禁止用全局生产 0.1.6 包替代。

**这些测试不是实机验证**：它们不发出任何真实模型请求，因此不能证明实际派发的路由。实机验收请在安装后从会话日志读取 `session/title-llm-request` 的 `route` 与最终 `session/title` 的 `source.model`，确认二者一致且等于设置值。

## 卸载

从 profile 移除本 bundle 即可：两条 patch 同时消失，宿主自带标题 provider 恢复。用户 `settings.yaml` 里的 `title-model:` 段落会成为未注册命名空间的普通文本，不再被读取，也不会影响任何行为。
