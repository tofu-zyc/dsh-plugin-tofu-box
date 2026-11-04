# 插件测试 profile：`rc-dev` 与 `alpha-dev`

> 用户 2026-11-04 定的规矩：**以后所有插件测试都在这两个 profile 上做，测之前先把它们更新到最新版。**
> 本文是执行细则；[AGENTS.md](../AGENTS.md) 只写摘要，冲突时以本文 + AGENTS.md 的硬性条款为准。

## 1. 一句话规矩

1. 插件兼容性 / 冒烟 / 页面对质，**只允许**在 `rc-dev` 与 `alpha-dev` 上做。
2. **每次开测前先更新**：`pwsh -File tools\dev-dsh.ps1 <profile> -Update`（运行时 + 插件依赖都到该通道最新）。
3. 两个 profile 只用**实验室自部署模型**（provider `lab`），**不配 DeepSeek 官方 key**。
4. `desktop` / `web` 不参与测试：不装插件、不改 patch、不当作结论来源。

## 2. 两个 profile 对应的是 dsh 的版本，不是插件版本

| profile | dsh 通道（npm dist-tag） | 运行时目录（gitignore） | 用途 |
| --- | --- | --- | --- |
| `rc-dev` | `next`（rc 线，相对稳定） | `.dsh-runtime\rc` | 插件对 rc 版 dsh 的适配验证 |
| `alpha-dev` | `alpha`（预览线，最早暴露问题） | `.dsh-runtime\alpha` | 插件对 alpha 版 dsh 的适配验证 |

关键点：**profile 只是 `~/.dsh/profiles/<name>` 下的一层配置（bundles 列表 + patch），dsh 版本由启动它的运行时决定。**

- 全局 `dsh`（`C:\Users\Lenovo\AppData\Roaming\npm`）**不是**这两条通道中的任何一条；
  `dsh --profile rc-dev` 这种写法会把 rc 通道的 profile 跑在全局版本上，结论无效。
- 所以一律用 `tools/dev-dsh.ps1`：它按 profile 名挑运行时，再转交参数。

两个 profile 本身是空的（只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 两个 bundle），
插件在测试时按需装进去，测完可留可删。

## 3. 模型：实验室 `lab` 供应商（无官方 key）

`~/.dsh/profiles/{rc-dev,alpha-dev}/cordis.patch.yml` 里写死了与 desktop profile 同源的 `lab` 供应商：

| 项 | 值 |
| --- | --- |
| provider id | `lab`（`@deepseek-ai/dsh-llm-pi-ai` 的 provider 路由） |
| baseURL | `http://10.111.138.180:36957/v1` |
| 协议 | `openai-completions` |
| 凭据引用 | `apiKeyEnv: LAB_API_KEY` |
| 模型 | `deepseek-v4.1-flash`（默认，1M 上下文 / 384k 输出）、`qwen3.8-flash-next`（256k / 64k） |
| 默认模型 | `agent-default-model` → `lab` / `deepseek-v4.1-flash` / `reasoningEffort: max` |

- `LAB_API_KEY` 的值在 `~/.dsh/.credentials.yaml`（与 desktop 共用同一个 DSH_HOME），
  **不要**复制到 profile、不要写进仓库、不要打印。
- 官方 DeepSeek 的两行（`llm-deepseek`、`llm-deepseek-account`）在 patch 里 `disabled: true`，
  模型菜单里不会出现需要官方 key 的条目；账号引导也置为 `step: done`，不会弹向导。
- 仍然会缺的：`web_search`（走 `web-search-deepseek`，要 `DEEPSEEK_API_KEY`）。测试时别依赖联网搜索，
  `web_fetch` 走 http 直连，可用。

## 4. 日常命令

```powershell
# 0) 开工：把两个 profile 都更新到通道最新（每次测试前的规定动作）
pwsh -File tools\dev-dsh.ps1 rc-dev    -Update
pwsh -File tools\dev-dsh.ps1 alpha-dev -Update

# 1) 装/换插件（走该通道运行时的 dsh plugin，等价于 pnpm add）
pwsh -File tools\dev-dsh.ps1 rc-dev -Plugin add dsh-plugin-billing-card@0.3.1
pwsh -File tools\dev-dsh.ps1 rc-dev -Plugin add "link:D:\program\dsh-plugins\dsh-plugin-billing-card"
pwsh -File tools\dev-dsh.ps1 rc-dev -Plugin remove dsh-plugin-billing-card

# 2) 组合检查（不启动）：确认插件行进树、没有 "did not activate" / "name mismatch"
pwsh -File tools\dev-dsh.ps1 rc-dev --dump-config | Select-String 'dsh-plugin-|provider: lab'

# 3) 启动冒烟：随机端口、不抢浏览器焦点；把带 token 的 URL 交给用户自己开
pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0
```

要点：

- 脚本会先打印 `==> rc-dev @ dsh 0.2.2-rc.1 (rc)`，**版本不对就是没走通**，别继续测。
- 参数是透传的：`--dump-config`、`--no-open --port <n>`、`--patch <file>` 等原样给 dsh。
- `-Plugin` 后的参数直接给 `dsh plugin --profile <name>`，所以 `add` / `remove` / `update` / `list` 都行。
  非交互 shell 里 pnpm 会等 stdin，脚本已经用 `cmd /c ... < NUL` 兜住，别自己手敲 `dsh plugin`。
- 测试插件改代码要重启（插件在进程启动时 `apply()` 一次）；`link:` 只省拷贝，不省重启。

## 5. 更新纪律

- `-Update` 做的事：
  1. `npm install -g @deepseek-ai/dsh@<tag> --prefix .dsh-runtime\<ch>` —— 把运行时换到该通道最新；
  2. `dsh plugin --profile <name> update --latest` —— 把 profile 里的插件依赖拉到最新（含大版本）。
- 一次 `-Update` 大约 1～2 分钟（npm 会重写整棵运行时依赖树）。**不要在它跑的时候并发做别的测试**。
- 想确认通道当前版本：`npm view @deepseek-ai/dsh dist-tags --json`（`next` = rc 线，`alpha` = 预览线，`latest` = 稳定发布）。
- **不要用 `npm i -g` 改全局 CLI**：全局那条是桌面端 / 日常自用的，升它等于给用户换环境，不属于测试动作。

## 6. 禁止事项

- 不在 `desktop` profile 上装/卸插件。rc.1 起 dsh 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`），
  插件页是唯一入口；历史上还发生过 pnpm 穿过 junction 删空工作区目录的事故（2026-10-17）。
- 不把 `link:` junction 放进 `desktop` profile。
- 不为了“顺便看看”把插件装进用户的 `web` profile。
- `computer-use` 类插件会操作**真实桌面**：用户在用电脑时只验证工具注册与元素树，不做点击/输入动作。
- 不把 `LAB_API_KEY` 或任何 token 写进 patch、日志、提交信息。

## 7. 重建（profile 坏了 / 想从零重来）

```powershell
# 1) 运行时（两条通道各一份，-g --prefix 才得到与真实全局一致的平铺布局）
npm install -g @deepseek-ai/dsh@next  --prefix D:\program\dsh-plugins\.dsh-runtime\rc
npm install -g @deepseek-ai/dsh@alpha --prefix D:\program\dsh-plugins\.dsh-runtime\alpha

# 2) profile（--from-default-profile 会重置成官方 web 模板，patch 需要按第 3 节重写）
D:\program\dsh-plugins\.dsh-runtime\rc\dsh.cmd    --profile rc-dev    --from-default-profile web --dump-config
D:\program\dsh-plugins\.dsh-runtime\alpha\dsh.cmd --profile alpha-dev --from-default-profile web --dump-config

# 3) 重新写 cordis.patch.yml 的 lab 段，然后自检
pwsh -File tools\dev-dsh.ps1 rc-dev --dump-config | Select-String 'provider: lab'
```

## 8. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `runtime 还没装` | 先 `-Update`；运行时目录被删了也会这样。 |
| 启动后模型报 `MISSING_CREDENTIAL ... LAB_API_KEY` | `~/.dsh/.credentials.yaml` 里的 `refs.LAB_API_KEY` 没读到（文件被删/改坏），或用了不带 credentials 服务的模板（headless 模板默认禁用该行）。web 模板不需要额外处理。 |
| `profile ... does not exist` | 第 7 节重建。 |
| `patch: name mismatch ... skipping` | patch 里写了 `name:` 而宿主换了实现包；按 id 打补丁，别写 `name`。 |
| `did not activate` | 插件 peer 不满足当前 dsh 版本——这正是要测的东西，记录版本后按需收窄/放宽 peer。 |

## 9. 本次搭建的验收记录（2026-11-04）

| 项 | 结果 |
| --- | --- |
| 运行时 | `.dsh-runtime\rc` = **0.2.2-rc.1**（flat `node_modules\@deepseek-ai` 只有 `dsh`，嵌套 329 个包，与真实全局一致）；`.dsh-runtime\alpha` = **0.2.2-alpha.3** |
| profile | `~/.dsh/profiles/rc-dev`、`alpha-dev`，bundles = `dsh-base` + `dsh-web-app`，无插件 |
| `--dump-config` | 两个 profile 都 exit 0；`provider: lab`、`model: deepseek-v4.1-flash` 出现；`llm-deepseek` / `llm-deepseek-account` 为 `disabled: true`；无 `name mismatch` |
| 启动冒烟 | 两个 profile 各自随对应运行时启动，打印 token URL，`curl` 返回 303（token 换发正常），stderr 为空，进程已回收 |
| lab 真实调用 | 在 rc 运行时下用同一份 patch 跑一次性任务，**未导出任何环境变量**，`LAB_API_KEY` 由 credentials 服务解析，模型正常回话 |
| 收尾 | 一次性验证 profile 已删除；`~/.dsh/profiles` 只剩 `desktop` / `web` / `rc-dev` / `alpha-dev` |

## 10. 变更历史

- **2026-11-04**：删除 `billing-dev`、`prompt-dev`、`npmlab`、`dsh-tui` 四个 profile
  （备份在 `~/.dsh/backups/profiles-removed-2026-11-04/`，`dsh-tui` 50 MB，如需释放可直接删该备份）；
  新建 `rc-dev` / `alpha-dev` 与 `tools/dev-dsh.ps1`，确立“测试只用这两个、测前先更新”的规矩。
- 旧的隔离 home `.dsh-rc-test`（profile `tofu-rc`）、`.rc3-home`、`.dsh-017*` 是历史升级验证环境，
  保留作档案，**不再作为插件测试基线**。
