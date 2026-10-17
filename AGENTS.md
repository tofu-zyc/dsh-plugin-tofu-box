# AGENTS.md — dsh-plugins 工作区规则

适用于本仓库（`D:\program\dsh-plugins`）内所有插件开发、调试、验证工作。与子目录里的说明文件冲突时，以本文件为准。

## 环境隔离（硬性，用户明确要求）

- **禁止把用户的 desktop profile 当作开发/调试/验证环境。** 具体指：
  `C:\Users\Lenovo\.dsh\profiles\desktop`、它的 `node_modules`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`，
  以及正在运行的桌面端 Harness 进程（`DeepSeek Harness.exe`）。
- 不要在 desktop profile 上执行 `plugin_manager install_bundle` / `remove_bundle`、`dsh plugin --profile desktop ...`、
  或任何会写入该目录的命令。已装进去的东西必须卸载并清理干净（依赖、bundles 列表、patch、残留 junction）。
- 开发与验证一律使用**独立 profile**：用官方模板新建，不碰用户已有的 `web` / `dsh-tui` 等 profile。例如：

  ```powershell
  dsh --profile billing-dev --from-default-profile web --dump-config   # 新建/重置独立 web profile
  dsh plugin --profile billing-dev add D:\program\dsh-plugins\<plugin>  # 安装到独立 profile
  dsh --profile billing-dev --no-open --port 58121                      # 启动，不抢浏览器焦点
  ```

- 需要给用户看界面时，把带 `?token=` 的地址发给用户，由用户自己打开；不要代替用户操作他的窗口。

## 不要抢占用户的桌面输入

- 本仓库的 computer-use 插件能力（`computer_click` / `computer_type` / `computer_key` / `computer_move`、
  以及任何 `desktop=true` 的输入）**不得用于操作用户正在使用的桌面窗口**（浏览器、游戏、聊天工具、桌面端 Harness 等）。
- 只读的 `computer_windows` / `computer_screenshot` 也应避免对用户当前活动窗口做无必要的截取；优先使用
  独立 profile 的 HTTP 接口、日志、单元测试来验证。
- 血的教训（2026-10-17）：在用户 desktop profile 上装插件、并尝试用 computer-use 在桌面端 Harness 窗口里
  “点一下计费药丸”验证交互——合成点击落不到 Electron webview（官方自带按钮同样点不开），既没验证成功，
  又触碰了用户的鼠标、污染了他的 desktop profile。不要重蹈覆辙。

## 验证手段（按优先级）

1. 纯逻辑：`node --check` + `node --test`（每个插件自带 `tests/`）。
2. Host 集成：在独立 profile 里起 web 服务，用 HTTP/RPC 验证（例如 `session/projections` 返回的投影值）；
   不要把插件装进用户 profile 来“顺便看看”。
3. Client/UI：先在组件测试或 VM harness 覆盖；需要真实浏览器时，起独立 profile 的 web 服务，把 URL 交给用户，
   让用户自己打开确认。
4. 任何写进用户 profile 的临时状态，收尾时必须恢复原状并复查（`git`/文件内容对照），并在交付说明里写明。

## 交付约定

- 新插件放在 `dsh-plugin-<name>/` 目录；凭据、临时 profile、截图等产物不要提交（见 `.gitignore`）。
- 发布 npm 前先在仓库根跑 `./publish.ps1`（dry-run）确认文件清单；`-Publish` 需要用户明确同意。
- 发版纪律：已发布版本号不可复用；改代码必须 bump `package.json` 的 `version`。

## npm 发布与凭据（用户 2026-10-17 交代）

- 用户的 `NPM_TOKEN` 在 **PowerShell profile 里设置**（`~/.npmrc` 里是 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`）。
  注意：DSH 的 shell 子进程是 `pwsh -NoProfile` 启动的，**默认看不到该变量**，直接跑 `npm whoami` 会 E401；
  发版必须再套一层**会加载 profile 的 pwsh**：

  ```powershell
  pwsh -NoLogo -File publish.ps1            # dry-run 预览（加载 profile → NPM_TOKEN 生效）
  pwsh -NoLogo -File publish.ps1 -Publish dsh-plugin-billing-card tofu-box
  ```

- **绝不回显、打印、写入文件或在命令行明文出现 token**；只用环境变量透传。不要把 token 加进仓库、日志或提交信息。
- 发布顺序：先发子包，再发 `tofu-box` 伞包（伞包的 dependencies 依赖子包已发布版本）。
- 伞包成员由 `tools/check-umbrella-sync.mjs` 强制：所有 git 已跟踪且非 `private` 的 `dsh-plugin-*` 都必须同步进
  `tofu-box`（`patches/<name>.yml` 逐字节副本、`dependencies` 精确 `^当前版本`、`dsh.bundle.patch` 数组、peer 并集）。
  新增插件后必须补齐这几处并让 `node tools/check-umbrella-sync.mjs` 通过，否则 `publish.ps1` 会中止。
- 发布后核对：`npm view <pkg> version` 与 tarball 文件清单（`npm pack --dry-run`）；README 里的版本号同步更新。
- **npm 的 staged publishing（2026 起）**：`npm publish` 成功后，新包名会先出现一个 `0.0.0-stage` 占位版本
  （"Temporary package placeholder for staged publishing"），实际版本进入暂存队列，需要 maintainer 批准后才会
  出现在版本列表里（可能延后几分钟）。所以 publish 输出成功不等于立刻可装：用
  `npm view <pkg> versions --json` 确认目标版本已出现，再验证安装（可用一次性 profile：
  `dsh plugin --profile <tmp> add <pkg>@<version>`，验证后删除该 profile）。
