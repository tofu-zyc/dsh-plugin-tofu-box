# dsh-plugin-shell-selector

在 Web 界面 **设置 → Shell** 页面选择 AI 执行命令时使用的 shell。

本插件**不实现 shell 执行器**，也不覆盖任何内置行。它只做两件事：读取现有执行器的实时事实，以及通过 `settings.mutate('pwsh-sandbox', …)` 写入执行器**本来就支持**的 `pwshPath` volatile Config 字段。

## 选项与真实状态

| 选项 | 作用 | 本机只读探测结果 |
| --- | --- | --- |
| 自动（保留当前默认） | 清除用户层 `pwshPath`，回落到内置解析顺序 | 可用 → `…\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`（PowerShell 7.6.6） |
| PowerShell 7 | 写入解析到的 `pwsh.exe` | 可用 → 同上 |
| Windows PowerShell 5.1 | 写入 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | 可用（页面显示 5.1 语法兼容提示） |
| Git Bash | — | **不可选**：已检测到 `C:\Program Files\Git\bin\bash.exe`，但受限运行尚未验证 |

## 为什么改动是真实的

`@deepseek-ai/dsh-pwsh-local` 在 `pwsh-sandbox` profile 条目读取其 volatile `pwshPath`，并在后续 `argv()` 调用时解析该值。因此通过设置表单更新配置后，下一次 AI 命令便使用所选程序，**无需重启、无需替换执行器**。

由此保留的行为全部是内置实现：

- 沙箱（`ctx.sandbox` 经 `dsh-pwsh-sandbox` 包装 argv）、审批、workdir、timeout、取消、退出码、stdout/stderr、后台 jobs 一律不变；
- 插件不调用 `child_process`，不拼接 shell 字符串，不添加 argv 前缀，不启停任何行；
- 执行中的进程不受影响：它们的 argv 在启动时已确定，改动只作用于之后启动的命令。

`probe()` 报告的"当前实际执行"直接来自 `ctx.shell.pwshPath`（执行器自己解析出的路径），不是本插件的二次推导。

### 校验

执行器把配置的 `pwshPath` 视为可信、自身不校验，所以校验由本插件在**写入之前**完成：

- 用 `lstat` 判定（与内置 `candidateExists` 同语义），因此 Microsoft Store 执行别名（symlink）被正确接受；
- 拒绝目录、缺失、空路径；
- 含空格的路径（如 `C:\Program Files\...`）作为单个 argv 元素传递，不做任何字符串插值。

若清除 `pwshPath`（选"自动"）后内置解析仍失败，`shell.pwshPath` 会回落到按 PATH 解析 `pwsh` —— 与内置行为一致。

### 已知限制：自动档的预览路径

"自动"档的预览由本插件按内置解析顺序推导（`pwsh7Locations` 加 5.1 回落），**没有考虑组合层（composition base）的 `pwshPath`**。若某个部署在 `pwsh-sandbox` 行配置里写死了 `pwshPath`，选"自动"实际会回落到那个组合层值，而预览显示的是探针推导值 —— 两者会不一致，有误导风险。

当前部署未在组合层设置 `pwshPath`，因此两者一致，暂无影响。此问题留待后续修正（例如读取 `describe()` 的 `base` 层并与探针结果区分显示）。

注意页面上的"当前实际执行"始终取自 `ctx.shell.pwshPath`，所以即使预览有偏差，**生效值显示的仍是真值**。

## 语法提示一致性

`pwsh` 工具的名称与描述是静态的，运行期没有接缝可改。本版本提供或允许选择的三档**全部是 PowerShell**，因此工具名 `pwsh`、`pwsh -Command` 与 `$env:NAME` 提示始终成立。

唯一的偏差是 PowerShell 5.1 缺少 `&&`、`||`、三元 `? :` 与 `??`。这一点通过两种方式如实说明，**不修改工具本身**：

1. 页面在 5.1 选项下始终显示兼容提示；
2. 当生效 shell 确实是 5.1 时，注册一条运行时上下文（`shell-selector/dialect`）告知模型真实方言；其余情况返回空字符串，不产生任何上下文。

## Git Bash：为什么不可选

三条独立事实：

1. **win32 上没有 bash 执行器。** `@deepseek-ai/dsh-base` 的 `bash-sandbox` / `tool-bash` 行在 Windows 上 `disabled`，而 `ctx.shell` 每个 context 只允许一个实现（第二个注册直接抛错）。真要支持必须自写执行器并关掉 `pwsh-sandbox` 行。
2. **PATH 上的 `bash` 是 WSL 启动器。** 本机 `bash` → `C:\WINDOWS\system32\bash.exe`，它在另一个文件系统命名空间里执行，等于用 WSL VM 边界替换 DSH 文件沙箱。因此本插件**只按 Git for Windows 显式路径解析，从不查 PATH**（有专门的单元测试守住这一点）。
3. **受限运行未经验证。** Windows runner（`dsh-sandbox-windows-acl`）本身是 argv 无关且 fail-closed 的（`[node, runner.js, --workspace, --temp, --mode, --, <argv…>]`；任何 runner 侧失败打印 `windows-acl-run:` 并 exit 127，绝不无沙箱 spawn），所以它*能*包住 `bash.exe -c`。但受限令牌只授予工作区与私有临时目录写权限，且两种受限模式下程序都无法打开命名管道，而 MSYS2 的 `fork()` 模拟依赖命名管道。

在没有证据之前，Git Bash 保持**禁用并显示原因**，绝不以无沙箱方式运行，也绝不把 `pwshPath` 指向 bash 假装切换。

### 状态：待验证，且当前没有可执行的探测方案

曾有一版独立探测脚本（`tools/gitbash-sandbox-probe.mjs`），**已被删除且从未执行**。它不安全，已确认的问题：

- 以"stderr 里没有 `windows-acl-run` 签名"判定成功不可靠 —— 非零退出、`spawnError`、超时都可能被误判为通过；
- `child.kill()` 在 Windows 上无法可靠清理整个进程树，并可能跳过 runner 的 DACL 撤销；
- 它以整个仓库作为 `--workspace`，且未清理临时目录、未把 Bash 的临时目录指向专有 temp。

更关键的是：**`ctx.sandbox` 与 `ctx.subprocess` 只存在于宿主进程内，外部脚本无法安全取得。** 因此不存在安全的独立脚本实现，本仓库不再提供探测脚本，也**不会运行任何裸命令冒充安全验证**。

Git Bash 的状态是**待验证**：既不是"不可用"，也不是"已完成"。

将来若要真正验证，必须在宿主内走生产 API（此处仅记录约束，**未实现、未验证**）：`ctx.sandbox.confine(['<gitBash>', '-c', <script>], policy, signal)` 取得受管 argv（ACL 授权与撤销归沙箱 provider），再交给 `ctx.subprocess.spawn({ argv, cwd: <专用 probe workspace>, stdio, graceMs, signal })`（进程树取消归受管 subprocess，不使用裸 kill）；成功判定必须是 `exitCode === 0` **且**每个阶段的确切 marker 都出现，超时按真实 deadline 标志判定；probe workspace 与 temp 都必须是专用目录，不复用仓库。这需要在插件上增加一个仅用于验证的 Remote，超出当前版本范围。

即使将来探测通过，开放 Git Bash 还需要另一步：**语法诚实性**。`tool-pwsh` 在 `apply()` 时一次性构建 schema，`tool-bash` 行在 win32 被禁用，且换行是组合期决定、无法随设置热切。要让模型拿到 bash 语法，必须新增一个按设置重建 schema 的 tool。

## 界面语言

页面跟随 **设置 → 通用 → 语言** 的当前语言（`@deepseek-ai/dsh-client-locale` 的 active locale），不硬编码中文；`bind` 在调用时读取 active locale，切换语言后页面与菜单项标签都会跟着变。

字典按 **locale id** 注册。浏览器端内置 id 是 `zh` 与 `en`（`LOCALE_IDS`），`bind(ns)` 沿 active locale 的回退链查找（`zh` → `en`）。注册时会枚举实时 catalog，因此语言包引入的 `zh-CN`、`zh-Hans` 等变体同样拿到中文字典。

> **已修复的运行缺陷**：早先版本把中文字典注册在 `zh-CN` 下。active id 实际是 `zh`，该字典不可达，回退链于是落到英文字典，界面整体显示英文。现在以 `zh` 为准。注意 `dsh-client-locale` 内部把 `document.lang` 的 `zh` 映射为 `zh-CN`，那是该插件的 DOM 行为，**不能**当作字典键使用。

## 安装

由 Lead 统一安装（本插件不自行安装）：

```
plugin_manager action=install_bundle target=D:\program\dsh-plugins\dsh-plugin-shell-selector
```

依赖 `@deepseek-ai/dsh-typert-protocol`（workspace 内已可解析），无构建脚本、无安装脚本。

## 测试

```sh
npm test        # node --test tests/*.test.mjs
```

**已实际执行**：30 个用例全部通过。覆盖候选顺序、含空格路径、目录/缺失/Store 别名判定、WSL 启动器拒绝、显式 PS7 不静默回落 5.1、Git Bash 始终不可选、非 Windows 平台、当前选项派生、四种拒绝路径均不产生写入、`mutate` 参数与 revision、`ctx.shell.pwshPath` 优先于二次推导、方言提示条件、两侧契约（Remote 方法名与客户端寻址一致、`settings.section` 注册参数、中英文字典键完全对齐且覆盖宿主可能发出的每个 key），以及**中文 locale 渲染与回退**（见下）。

这些用例不是静态检查：测试里的 locale 替身复刻了真实的回退规则（内置 id 为 `zh`/`en`，`zh` 回退到 `en`，`bind` 沿 **active** locale 的回退链查找）。把实现改回"只注册 `zh-CN`"会使 6 个用例失败，其中就有"zh 生效时必须渲染中文而非英文"—— 该回归已被实际验证过。

探测脚本已删除，未执行任何探测。

## 尚未验证

- `pwsh-sandbox` 条目已在 `settings.describe()` 中显示，隔离实例 3099 的设置页已通过无头浏览器在 5.1 与自动之间切换并恢复；
- 生产安装后的实时行为尚需切换后验证：`ctx.shell.pwshPath` 是否立即变化，以及下一条命令是否真的换了可执行文件；
- 页面在隔离 0.1.7 浏览器中已无 pageerror；中文显示由中英字典单测覆盖。

中文界面已在隔离的 0.1.7-alpha.2 无头浏览器中确认可用。生产切换后仍应抽查下一条命令的实际执行器，不能用界面选择代替执行验证。
