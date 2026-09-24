# dsh 0.1.7-alpha.2 升级调查：改了什么 / 我们的插件会不会冲突

调查及隔离验证日期：2026-09-23。以下第 1–4 节保留升级前源码 tag 比较与原始故障调查；后续验证进度见文末第 5 节。**生产 3080 仍运行 0.1.6-alpha.2**；0.1.7-alpha.2 已单独装入工作区并在 3099/3100 的独立 profile 验证。

## 0. 结论速览

**版本现状**

| 项 | 值 | 证据 |
| --- | --- | --- |
| 源码 checkout | `dsh-v0.1.6-alpha.2` → **`dsh-v0.1.7-alpha.2`**（`00102833df`，2026-09-22 23:25 发布） | `git reflog`：2026-09-23 15:03:26 `pull: Fast-forward`；上一次 pull 是 09-18 11:38（`ddefc45fbc` = `dsh-v0.1.6-alpha.2`） |
| 实际安装/运行的部署 | **仍是 0.1.6-alpha.2** | `npm ls -g` = 0.1.6-alpha.2，包目录 mtime 09-18 11:56；本会话进程 15:02:26 启动，早于 15:03 的 pull；checkout 无 `node_modules`/`lib`（不是从源码跑） |
| npm 可升级性 | `alpha` dist-tag 已是 0.1.7-alpha.2 | `npm view @deepseek-ai/dsh dist-tags` → `alpha: 0.1.7-alpha.2` |

**冲突结论：契约面 ①②③ 全绿，④ 的 settings 服务被重写，⑤ 还有一类检查器完全覆盖不到的断点（shipped 包导出符号改名）。合计 4 个插件必须改代码。**

| 契约面 | 结果 |
| --- | --- |
| ① bundle 机制（`dsh.bundle.patch` + `insert:`） | ✅ 通过（`patch` 兼容 string，仍可用） |
| ② 客户端注入包（6 个 `@deepseek-ai/*`） | ✅ 包名全部仍存在 |
| ③ Slot 挂载点（`settings.section` / `conversation.input.model` / `tool.call.toolview`） | ✅ 全部仍注册，owner props 契约未破坏 |
| ④ 服务方法 | ⚠️ **`ctx.settings.register()` 已被删除**（settings 服务整体重写） |
| ⑤ shipped 包的**导出符号**（②的盲区） | ❌ **`@deepseek-ai/dsh-client-ui-primitives` 的 6 个图标改名** → model-search 硬断 |

| 插件 | 版本 | 结论 |
| --- | --- | --- |
| **dsh-plugin-model-search** | 1.1.1 | ❌ **硬断**：6 个图标导出改名，`React.createElement(undefined)` 首屏就抛（§3.1，5 分钟可修） |
| **dsh-plugin-image-generation** | 0.2.0 | ❌ **失效**：`ctx.settings.register` 不存在 → `apply()` 抛错 |
| **dsh-plugin-title-model** | 1.0.0 | ❌ **失效，且后果最重**：同一原因；它的 patch 先 disable 官方 `session-title-llm` 行，于是标题生成**彻底没有 provider** |
| **dsh-plugin-shell-selector** | 0.1.0 | ❌ **失效**：命名空间从 `shell` 变成 profile 条目 id `pwsh-sandbox`，读不到也写不进 |
| dsh-plugin-computer-use | 2.4.0 | ✅ 无需改动 |
| dsh-plugin-read-image-preview | 1.4.1 | ✅ 无需改动（`ToolCallOwnerProps` 新增 `useDisclosure`，加法） |
| dsh-plugin-team-task-route | 0.1.0 | ✅ 无需改动 |
| dsh-plugin-mcp-ui | 1.0.2 | ⚠️ 能跑，但与新的 config-editor 共写同一文件，需让路（§3.4） |
| dsh-plugin-model-tuning | 1.2.0 | ⚠️ 自身契约全部对得上，但它联动的 image-generation / title-model 命名空间会消失，功能降级（§3.6） |

另有 1 条 **profile 级迁移**（官方删掉了一个我们还在选的 bundle，见 §3.2）。

---

## 1. 这次更新改了什么

规模：**1461 个提交（1011 个非 merge）**，4995 个文件，`+371557 / -118376`。
类型分布：fix 440、test 196、feat 123、docs 111、refactor 72、perf 18、其余杂项。
本仓库没有 CHANGELOG / release notes 文件，以下按领域归纳（括号内为触及该路径的非 merge 提交数）。

**客户端 UI / 聊天**（`packages/client` 472、`apps/web` 271、`ui-chat` 99）
- 分组的工作过程详情 + 稳定历史分页（`1bcb633c3f`、`fab6622abb`）、回合触发器与完成页脚（`e17e1ac801`）
- 统一代码块样式与图标控件（`8d2cd0cf72`）、统一客户端视觉语言（`4937343a5e`）
- 会话行操作改为 slot 组合、可扩展的会话菜单（`21586fe28c`、`e5a72d73df`）
- **图标体系整体改名**：`ui-primitives/src/icons/index.tsx` 导出从 84 → 188 个，
  命名从 `<Name><Size>`（`IconSearchOutline16`）改为 `<Name><Weight>`（`IconSearchOutlineRegular`/`…Medium`），
  `+1391/-801`。这就是 §3.1 那个断点的来源。
- 性能：可见回合二分查找（`19e5af7ded`）、回合导航虚拟化（`f89cd786aa`）

**会话与 API**（`packages/api` 120、`packages/session` 46）
- **删除 activity 平面**（`0dca00b425`，本区间唯一带 `!` 的破坏性提交）：作业花名册合并、观察改走 `session.observeJob` / `ctx.jobOutput`；新增 `api/job-controller`
- **V4 会话格式** + 一次性迁移命令 + `session-format-v3-to-v4` 包（`669b724a78`、`8dc1d0e3ed`）
- 会话置顶 / 归档过滤、归档前停止运行中的工作（`33d496951c`、`cbae324bfa`）
- Remote 支持二进制字段、每个 Remote 流可带客户端上行（`ecf6acfb15`、`021bd03b70`）

**插件系统 / boot**（`packages/boot` 49）
- **`dsh.bundle.patch` 支持有序文件列表**（`654caa4bbd`）：`string | string[]`，`ProfileLayer.patchPath` → `patchPaths`；web-app 现在发 5 个 patch 文件（含 4 个 preset）
- **坏 bundle 不再中止启动**（`de662ee010`）：解析/manifest/patch 加载失败 → 打一行诊断并**跳过该 bundle**（旧行为是 "fails startup loudly"）
- 链接安装（`link:`）解析整体重写：运行时解析表、peer-aware 查找、profile 加载时清理 `.dsh-module-fallback`
- 插件展示元数据（图标 / 本地化名与描述，`8f0dd55c2c`、`0b7cb4102b`、`0d611ea151`）
- `OPTIONAL_BUNDLES`：出厂但默认关闭的 bundle（语音输入、agent-team）在插件页作为可选项

**设置（本次最伤我们的一块）**
- `dsh-settings-file` 包**删除**，`@deepseek-ai/dsh-settings` 重写：**volatile Config**（`3f7016a422`）+ profile-backed 表单（`601d6761e4`）
- 命名空间语义从「插件注册的 namespace」变成「**profile 条目 id**」；设置 = 该条目 Config 里标了 `.volatile()` 的字段
- 新增 4 个官方设置页包：`ui-settings-account` / `-agent-loop` / `-shell` / `-subagent` / `-web-search`（多注册在**插件页** `plugins.item`）

**其它**
- agent preset 包改名 `dsh-agent-presets` → `dsh-agent-preset`（+ `agent-preset-registry`），preset 改为 profile YAML 声明
- **agent teams 合并为单个 bundle**：`dsh-experimental-agent-team-web-profile` 从发布系列中移除（`9f21d7842a`）；Team 任务面板改为只读（`253fb5e66d`）
- 语音输入（本地 SenseVoice）、桌面端、DeepSeek 账号登录、`session-format` 迁移
- vendor 升级：cordis **4.0.4**、cosmokit 1.8.5、schemastery 3.18.4、timer 1.1.6、hmr 1.0.19 等
- 新增 slot：`conversation.header`（包裹原 `conversation.session.header`）、`conversation.input.activity`、`shell.leading`、会话行/菜单操作、`plugins.detail.*`、`plugins.bundle.config|activation`

---

## 2. 契约面验证方法（可复现）

```powershell
# 1) 源码 tag 对比
cd D:\program\dsh-plugins\deepseek-harness
git log --no-merges --oneline dsh-v0.1.6-alpha.2..dsh-v0.1.7-alpha.2
git diff --stat dsh-v0.1.6-alpha.2..dsh-v0.1.7-alpha.2 -- <契约包路径>

# 2) 把真实新版本装进工作区（不碰全局、不需要管理员）
npm install @deepseek-ai/dsh@0.1.7-alpha.2 --prefix D:\program\dsh-plugins\.probe-dsh `
  --cache D:\program\dsh-plugins\.npm-cache-probe --ignore-scripts --no-audit --no-fund
# npm 会把依赖平铺到 .probe-dsh\node_modules；check-compat 期望 <deploy>\dsh\node_modules 布局，
# 于是做一个 junction 影子目录：
#   .probe-deploy\dsh\package.json         <- 复制 .probe-dsh\node_modules\@deepseek-ai\dsh\package.json
#   .probe-deploy\dsh\node_modules         <- junction 指向 .probe-dsh\node_modules
node D:\program\dsh-plugins\check-compat.mjs --deploy D:\program\dsh-plugins\.probe-deploy\dsh
```

**实测结果（0.1.7-alpha.2）：全部通过。** 9 个 bundle 解析正常、6 个注入包存在、3 个 slot 仍注册：

- `conversation.input.model` → `dsh-client-ui-conversation/client.js`
- `settings.section` → `dsh-client-ui-agent-preset/client.js`（并由 `ui-settings-general/SettingsRoot.tsx:101` 渲染）
- `tool.call.toolview` → `dsh-client-ui-cordis/client.js`

> ⚠️ **检查器的覆盖盲区（本次实测踩到了）**：`check-compat.mjs` 的第 2 步只校验
> `dsh.client.inject` 里的**包名**是否存在，从不校验我们从这个包里**取了哪些导出符号**。
> §3.1 那个硬断就是在检查器全绿的情况下发生的 —— 建议给检查器加第 6 步：
> 把插件里 `require('@deepseek-ai/...')` 的解构名逐个到新部署的对应包里 grep。

---

## 3. 冲突逐项

### 3.1 model-search 的 6 个图标导出改名（硬断，且检查器查不到）

[dsh-plugin-model-search/client.js:8-16](dsh-plugin-model-search/client.js#L8-L16) 从
`@deepseek-ai/dsh-client-ui-primitives` 解构了 6 个图标 + `Toast`：

```js
const { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
        IconCloseFill14, IconSearchOutline16, IconWarningOutline16, Toast } = require(...)
```

| 符号 | 0.1.6-alpha.2 | 0.1.7-alpha.2 | 新名字 |
| --- | --- | --- | --- |
| `IconCheckOutline16` | FOUND | **GONE** | `IconCheckOutlineRegular` |
| `IconChevronDownOutline14` | FOUND | **GONE** | `IconChevronDownOutlineRegular` |
| `IconChevronRightOutline14` | FOUND | **GONE** | `IconChevronRightOutlineRegular` |
| `IconCloseFill14` | FOUND | **GONE** | `IconCloseFillRegular` |
| `IconSearchOutline16` | FOUND | **GONE** | `IconSearchOutlineRegular` |
| `IconWarningOutline16` | FOUND | **GONE** | `IconWarningOutlineRegular` |
| `Toast` | FOUND | 仍在（`ui-primitives/src/index.ts:57 export { Toast }`） | 不变 |

（`git grep -l IconSearchOutline16 dsh-v0.1.7-alpha.2 -- packages/` → 空；`…Regular` 全部命中。
官方自己的消费方已经改用新名：`ui-model-selection/src/client/ModelSelect.tsx:28-29`。）

**后果**：解构不存在的导出得到 `undefined`，模型座位首次渲染时 `React.createElement(undefined)` 直接抛错
→ 输入栏的模型搜索座位整块不可用。注意这个包**并没有**写进 model-search 的 `dsh.client.inject`
（它只声明了 model-selection / locale / remotes），所以不是"包没了"而是"符号没了"，
既不会在 boot 期报错，也不会被 `check-compat.mjs` 发现。

**修法**：把 `client.js:8-16` 的 6 个名字换成 `…Regular`，再改这 6 个标识符在 JSX 里的引用处；`Toast` 不动。

### 3.2 profile 选了一个已被删除的 bundle（需手工改一行）

`C:\Users\Lenovo\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 里有
`@deepseek-ai/dsh-experimental-agent-team-web-profile` —— 该包在新版本中**已从发布系列移除**（`9f21d7842a`
"enable tools and Web UI with one bundle"）。

- 旧版语义：`packages/boot/app-boot/README.md`（0.1.6）"A missing bundle or one without a patch declaration **fails startup loudly**."
- 新版语义：`loadProfileDirectory` 对每个 bundle 名 `try/catch`，失败即
  `process.stderr.write('dsh: skipping profile bundle "<name>": <error>')` 后继续（`profile.ts:648-662`）。
  README 新版："Bundle resolution, manifest, and patch-loading failures print a diagnostic and **skip that bundle**…
  profile and user-patch errors still fail startup."

所以升级**不会炸启动**，但会多一行 stderr，且这是官方明确记录的升级缺口（`.agents/notes/implemented/architecture/2026-09-18-agent-teams-single-bundle.md`：
"Existing profiles that select the removed Web bundle have an upgrade compatibility gap"）。

**修法**（官方 README `packages/experimental/agent-team-profile/README.md:45` 给了同一句）：
从 `dsh.profile.bundles` 删掉 `@deepseek-ai/dsh-experimental-agent-team-web-profile`，**保留**
`@deepseek-ai/dsh-experimental-agent-team-profile`（现在它一个 bundle 同时带 Team 服务、工具和 Web UI）。

顺带：profile 里的 `"patchReload": "live"` 在两个版本的源码里都**没有任何代码读取**（只出现在一篇设计笔记里），
是历史遗留字段；`ProfileManifest = Partial<DshPackageManifest>` 且 `readProfileManifest` 不做未知键校验，因此无害，可留可删。

### 3.3 `ctx.settings.register()` 被删除 → 3 个插件失效

新设置服务的类名是 `SettingsForms`（`packages/settings/settings/src/index.ts:223`），公开方法只有：

```
configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]   // ns = profile 条目 id
update(ns, patch, expectedRevision?) / replace(ns, section, expectedRevision?) / mutate(ns, ops, expectedRevision?)
```

- `git grep -n 'settings\.register(' dsh-v0.1.7-alpha.2` → **packages/ 下 0 个调用点**（旧 tag 有 7 处，含 locale/ui-chat/ui-conversation/ui-theme/agent-presets 等官方包）
- `types.ts:6-7`：`SettingsNamespace` 的注释从 "Nominal id of one **registered** settings namespace" 改成
  "Nominal id of one **profile plugin entry**"
- `index.ts:382-384`：`entries().find(row => row.options.id === ns)`，找不到就
  `throw new Error('No configurable plugin entry "<ns>"')`
- `index.ts:388`：只有 `.volatile()` 标记的字段可写（`isVolatilePath`）
- 新写法（官方已迁移）：Config 里 `pwshPath: z.string().volatile()`（`packages/shell/pwsh-local/src/index.ts:133`），
  插件直接读自己的 config；`ctx.settings.installSection` 与 `SHELL_SETTINGS_NAMESPACE` 一并删除

受影响的具体调用点：

| 插件 | 调用点 | 后果 |
| --- | --- | --- |
| image-generation | `index.js:130` `ctx.settings.register(NS, Config, { base: config, validate })`，`:131/:140` 用 `scope.get()` | `apply()` 抛 `ctx.settings.register is not a function` → 行不激活 → `generate_image` / `list_image_models` 两个工具消失 |
| title-model | `index.js:149-153`，`:160` 用 `scope.get()` | 同样抛错。**且它的 patch 先 `- id: session-title-llm / disabled: true` 摘掉了官方标题行**，于是没有任何 provider 注册 → 会话标题只剩回退标题（不再由模型生成） |
| shell-selector | `shells.js:28` `SHELL_NAMESPACE='shell'`；`:288` `describe({redactSecrets:true})`；`:290` 找 `entry.ns === 'shell'`；`:389` `settings.mutate('shell', ops, rev)` | 找不到分区（新 ns 是条目 id `pwsh-sandbox`，见 `ui-settings-shell/shell-card-controller.ts:12`）→ 页面永远显示「自动」；写入抛 `No configurable plugin entry "shell"` |

**修法（3 个插件同一条路）**：删掉 `register` 调用与 `scope`，把可编辑字段在导出的 `Config` schema 上标 `.volatile()`
（schemastery 3.18.4 已提供：`vendor/schemastery/src/index.ts:165 volatile()`），
直接读自己的 `config`（行配置即 base 层）。三个插件的 `NS` 常量（`'image-generation'` / `'title-model'`）**恰好等于各自行的 id**
（`cordis.patch.yml` 里 `id: image-generation` / `id: title-model`），所以迁移后命名空间字符串不变，
model-tuning 里硬编码的 `IMAGE_NS = 'image-generation'`（`client.js:73`）能继续对上。
shell-selector 则必须把 `'shell'` 换成解析出来的条目 id（win32 = `pwsh-sandbox`）。

### 3.4 mcp-ui 与新的 config-editor 共写同一个文件

mcp-ui 的定位方式仍然有效：`PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`（`profile.ts:38`）、`patchPath` 字段仍在（`:96`）、
模板仍是 `[]`（`:193-197`）、`ctx.baseUrl` 仍是 profile 目录（`index.ts:976`）。
但新版本里这个文件**同时是设置文档**：`config-editor/src/index.ts:34 get documentPath() { return this.ownerContext.profileContext.patchPath }`，
`settings/src/index.ts:292` 也指向它 —— 于是出现两个写者（mcp-ui 直接重写文件 vs settings/config-editor 带 revision 校验的写入）。
风险不是立刻报错，而是并发写被 revision 检查拒绝或互相覆盖。建议 mcp-ui 改为经由 config-editor / settings 的写入通道，
而不是自己重写 YAML。

另外：`de662ee010` 只跳过失败的 **bundle 层**，"profile and user patch errors still throw" ——
profile patch 格式错误依然是致命错误，mcp-ui 的失败模式没变（它写坏了文件仍然会炸启动）。

### 3.5 shell-selector 与官方新 shell 设置页**不**重叠

新版本发的 `@deepseek-ai/dsh-client-ui-settings-shell` 在**插件页**（`plugins.item` slot，
`ui-settings-shell/src/client/index.ts:50-52`，`id: 'shell'`）提供 shell 设置卡，
编辑「命令超时 / 每流输出上限」——它**不管选哪个 shell**（README："set how long one command may run and how
much of each output stream stays in memory"）。我们那个「选可执行文件」的页面仍有独立价值，
只需按 §3.3 把命名空间换成条目 id。

section id 也不撞。官方新版的 `settings.section` id 是 `account`(-10) / `general`(0) / `models`(10) /
`plugins`(15) / `agent-presets`(20)；我们的是 `model-tuning`(11) / `mcp-ui`(12) / `image-generation`(13) /
`shell-selector`(14)，正好插在中间，无重名（`git grep` 我们这 4 个 id 在新版为空）。

### 3.6 插件之间的耦合（升级后要一起看）

- **model-tuning ↔ image-generation ↔ title-model**：model-tuning 的页面靠 `remote.settings.describe()` 里
  这两个插件的命名空间来做联动（`client.js:73` `IMAGE_NS='image-generation'`、`titleViewOf(...)`）。
  它们坏掉时 model-tuning 会显示「未检测到…请安装」而不是报错 —— 所以 §3.3 修好后联动会自动恢复。
  它的其它远程契约已逐个核对无恙（见 §4）。
- **computer-use ↔ read-image-preview**：computer-use 不带 client 半区，13 个 `computer_*` 工具的展示
  依赖 read-image-preview 的通用图像卡（`read-image-preview/client.js:353-357` 里注册了 `computer_*` 标签）。
  两个插件在新版本都不需要改，耦合不变。
- title-model **故意 disable 官方行**：`session-title-llm` 行 id 在新版仍存在
  （`packages/bundle/base/cordis.patch.yml:62-63`），按 id `disabled: true` 也仍是官方用法
  （acp-app/sdk-app 的 patch 与 `profile-context.ts:54` 都这么做）。所以 patch 形状不用改 ——
  但正因为「先摘官方、再插自己」，它一旦 `apply()` 失败就没人兜底，这是 §3.3 里后果最重的原因。
- ⚠️ **`priority: -1` 在两个版本里其实都是空转**：动态客户端 runner 会把非 chain 注册的 priority 覆盖成
  分配值（`cordis-client-runner/src/client/guard.ts:128-132`，`allocatePriority` 让后注册者优先级更低）。
  model-search 抢占模型座位、read-image-preview 抢占 `read_image` 键，靠的是「我们的插件在官方 bootstrap
  模块之后挂载」这个事实，而不是我们传的 `-1`。升级后如果挂载顺序变化，抢占会静默失效（退回官方视图），
  这点值得在行为清单里专门确认。

---

## 4. 已验证安全、无需改动的面

| 面 | 我们的用法 | 新版本证据 |
| --- | --- | --- |
| `dsh.bundle.patch` | 每个插件 `"patch": "./cordis.patch.yml"`（字符串） | 仍接受字符串（`profile.ts:57 bundlePatchFiles`），只是新增了数组形式 |
| 注入包 | `dsh-client-ui-settings` / `-tool` / `-model-selection` / `dsh-client-locale` / `dsh-api-remotes` / `dsh-api-session-controller` | 6 个包在新部署里都在，名字与路径不变 |
| 其它 shipped 符号导入 | `defineTool`（`@deepseek-ai/dsh-tools`）、`TypertRemoteService` + `RemoteError`（`@deepseek-ai/dsh-typert-protocol`）、`z` 默认导出（`@deepseek-ai/schemastery`）、`generateSessionTitleWithLlm`（title-model 的 `HELPER_PACKAGE`） | 逐个 grep：**全部仍在**（`session-title-llm/src/index.ts:238`、`core/tools/src/index.ts:67`、`packages/typert`、`vendor/schemastery`）。即 §3.1 那类改名**只此一处** |
| `settings.section` slot | 4 个插件注册自定义分节 | slot 仍在，`SettingsSectionOwnerProps` **未变**（`ui-settings/src/client/contract/slots.ts` diff 只新增 `settings.launcher`），`SettingsRoot.tsx:101` 仍渲染；`props.close` 照旧提供 |
| `conversation.input.model` | model-search 接管模型座位 | 契约**未变**（仍 `single`/`session`/`InputControlOwnerProps={locked}`），`ModelSelectInjected` 与旧版逐字节相同；仅文档新增紧凑显示用的 CSS 变量提示 |
| `tool.call.toolview` | read-image-preview 接管 13 个键 | 契约未变；`ToolCallOwnerProps` 新增 `useDisclosure`（加法）；新版只加了「`tool.call.images` 子规则只能声明一次」，而我们不声明 `children` → 不冲突 |
| 宿主服务 | `webServer.register({kind,path,handler})`、`fs.resolve/stat/readBytes/readByteRange`、`attachments.saveImage/readImage/readFileStream`、`tools.register/guard`、`sessionTitle.register`、`agentTeams.tryMembership`、`ctx.effect`、`ctx.logger` | 签名逐一核对无变化（fs 只新增 `watch()`） |
| 客户端服务 | `ctx.locale.register/bind/getSnapshot/subscribe`、`ctx.slots.inject/register`、`ctx.get('timer')`、`ctx.connection.rpc.call`、`remote.*` | `locale` 全部重载一致（仅类型改名 `SettingsScope`→`ConfigForm`，与 JS 无关）；`timer` 服务名与 API 不变（`cordis-client-runner/src/client/timer.ts:33`）；`rpc.call(channel, endpoint, payload, signal?)` 两版相同；`remote.settings.describe()` 线上形状 `{writable, hasDocument, namespaces}` 两版相同（`SettingsNamespaceView` 仅新增 `autoGenerate`） |
| 远程方法 | `remote.llm.listConfigurableProviders()`、`remote.session.modelCatalog()`、`remote.settings.describe/mutate`、`remote.credentials.set`、`sessions.subagentAddress()` | 全部仍在：`llm/src/index.ts:544-545`（`LlmConfigurableProvider` 仍有 `provider/displayName/settingsNs/settingsPath`）、`session-controller/src/index.ts:291 @Remote('modelCatalog')`、`settings-controller/src/index.ts:98/152-157`、`credentials.ts:99-100`、`contract/sessions.ts:96` |
| 链接安装 | profile 里 9 个 `link:` 依赖（junction） | 新版本有专门的 linked-directories 规则，且会清理历史 `.dsh-module-fallback` 投影；pnpm 安装的包保留 |

**另外确认"新版本没有把我们的功能做掉"**（免得白改）：官方 `ModelSelect` 在新版**仍无搜索框**
（只有 DOM focus 辅助），model-search 不可替代；`ui-settings-models` 早在旧版就有 `contextWindow`/`maxTokens`，
且新版明确写"deliberately no reasoning-effort control"，model-tuning 不可替代；新版没有任何 MCP 设置界面，
mcp-ui 不可替代；官方 `read_image` 卡 + `tool.call.images` 相册在旧版就有、且没有缩放/平移，
read-image-preview 不可替代。

---

## 5. 隔离分支修复与运行验证（2026-09-23）

- Git 工作树：`.dsh-017-test/source`，分支 `upgrade/dsh-0.1.7-alpha.2`；隔离 profile 的九个插件只链接此工作树，主工作树 `main` 和当前生产九条链接未修改。
- 九个已验证的插件包已按文件哈希核对并暂存于 `.dsh-017-prod/source`；**生产尚未链接这里**。切换时该目录的 `node_modules` 必须指向升级后的全局 DSH 依赖，防止插件与宿主出现两份 Cordis/Tool 类实例。
- 真实 0.1.7-alpha.2 npm 安装和独立 `DSH_HOME` 在 3099 启动；修复 model-search 的 6 个图标、image-generation 和 title-model 的 volatile Config `.get()`、shell-selector 的 `pwsh-sandbox` 设置命名空间，保留 `ctx.get('shell')` 的执行器服务 key。移除 image-generation/title-model 对旧 `settings.register` 的调用与注入。
- 单元测试：image-generation 14 项、shell-selector 30 项、title-model 路由与 provider 两组、model-tuning 图像联动 16 项和标题联动 13 项，均通过。title-model 测试只使用隔离 0.1.7 部署提供的共享标题生成 helper。
- 3099 无头 Edge：真实 SettingsForms + credentials + Remote + 本机模拟 Images API 的图像生成、预览与原图下载通过；Shell 页面切到 Windows PowerShell 5.1 后恢复自动，`pwsh-sandbox` profile 配置确实写入并移除；标题用途页能找到 `title-model`；浏览器未报 pageerror。未产生外部绘图费用。
- 从完整生产备份克隆的**私有** `DSH_HOME` 在 3100 使用同一 0.1.7 部署和隔离插件工作树启动；官方 `settings.yaml` 导入逻辑将旧文件重命名为 `.imported` 并迁入 profile patch。逐项比较：`llm-pi-ai` 的 5 个 provider、默认会话模型、DeepSeek 模型和 image-generation 的 2 个模型 ID 全部保留。3 个桌面端专用分区不属于 Web profile，仍保存在 `.imported` 文件里。旧 V3 会话能打开，替代模型菜单的搜索框可显示；绘图与标题设置均可用，页面无错误。
- 已备份生产 `%USERPROFILE%\.dsh`（包含 sessions、附件、凭据、profiles）和全局 0.1.6-alpha.2 部署及 CLI wrapper 到 `.dsh-017-test/rollback`；清单见 `backup-manifest.json`。这份拷贝产生于生产仍在运行时，因此正式停机时**必须再做一份静止状态的最终数据快照**，不能用此前快照覆盖停机后新写入的数据。

## 6. 生产切换与剩余风险

> **2026-09-23 追补**：0.1.7-rc.1 已发布并检查完毕，建议把切换目标直接改为 rc.1（不必先上 alpha.2 再跳一次）。
> rc.1 与 alpha.2 的差异、唯一的真实破坏点（`tool.call.toolview` 三阶段）、以及新增的 peer 兼容门禁见
> [UPGRADE-dsh-0.1.7-rc.1.md](UPGRADE-dsh-0.1.7-rc.1.md)。下文保留 alpha.2 当时的结论；
> 其中「九个插件的修复」也包含后来在 rc.1 分支上补的 read-image-preview 阶段修复（已 cherry-pick 回来）。

生产 3080 仍是 0.1.6-alpha.2；尚未执行切换。准备好的 `tools/upgrade-dsh-017.ps1` 默认只做无写入预检；显式 `-Execute` 才进入停机、最终静止备份、全局 0.1.7-alpha.2 安装、生产 profile 九条链接改至 `.dsh-017-prod/source`、移除已删除的 Team Web bundle、启动及 3080 无头验证，并在失败时自动恢复旧版本。**停掉当前宿主会终止运行中的会话和本次对话**，因此必须选定允许中断 3080 的维护时刻。0.1.7 的 V4 Session 日志不能靠只降级二进制回滚；失败时以静止状态快照恢复原部署、profile 和会话文件。`mcp-ui` 与官方 config-editor 同写 profile patch 的并发编辑风险仍未修复，生产运行时避免同时修改同一 profile 文件。
