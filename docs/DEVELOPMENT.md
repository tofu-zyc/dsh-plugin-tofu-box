# 开发

面向本仓库的日常开发（改插件代码、调试 dsh 里的行为）。

## 依赖装成本地链接

改代码要"改完就能调试"，就别让 profile 依赖 GitHub 的 tarball——用 `link:` 指向本仓库，profile 里的 `node_modules/dsh-plugin-*` 会变成指到工作区的 junction，不再有"装了一份拷贝、改了不生效"的问题：

```sh
dsh plugin --profile web add \
  "link:D:\program\dsh-plugins\dsh-plugin-computer-use" \
  "link:D:\program\dsh-plugins\dsh-plugin-model-tuning" \
  "link:D:\program\dsh-plugins\dsh-plugin-shell-selector" \
  "link:D:\program\dsh-plugins\dsh-plugin-read-image-preview" \
  "link:D:\program\dsh-plugins\dsh-plugin-mcp-ui"
```

要点：

- **必须用绝对路径**。`dsh plugin --profile X add <args>` 只是转发给 profile 目录里的 pnpm（cwd = profile），相对路径会被锚定成 profile 内部的路径。
- **改完代码仍需重启 dsh**：插件是在进程启动时 `apply()` 一次的，链接省掉的是"拷贝"，不是"重载"。
- **改了结构（`package.json`、`dsh.bundle`）要重跑上面的 `add`**：`dsh.profile.bundles` 是按解析结果对账的。
- 回到发布版：把 `link:` 换成 `github:tofu-zyc/dsh-plugin-tofu-box#path:<插件>` 再 `add` 一次。

## 隔离测试 profile（不要动桌面端的 profile）

桌面端（Electron）的 `desktop` profile 由应用独占管理，2026-10-17 已发生过 pnpm 重装穿过 junction 删空工作区目录的事故。**任何插件开发、冒烟、行为验证都在隔离环境里做，不碰 `~/.dsh` 与桌面端。**

隔离 home 与 profile 已就绪：`D:\program\dsh-plugins\.dsh-rc-test`（gitignore）里的 `tofu-rc`，由随附 `web` 模板初始化，五个工作区插件以 `link:` 装入。

```powershell
# 每一条命令都是一个新 shell，所以每条都要先设 DSH_HOME
$env:DSH_HOME = 'D:\program\dsh-plugins\.dsh-rc-test'

# 首次创建 / 重置 profile（web 模板的完整副本；不加 --dump-config 会直接启动）
dsh --profile tofu-rc --from-default-profile web --dump-config

# 把工作区插件按 link: 装进 profile（绝对路径；改了 package.json / dsh.bundle 后要重跑）
dsh plugin --profile tofu-rc add `
  "link:D:\program\dsh-plugins\dsh-plugin-model-tuning" `
  "link:D:\program\dsh-plugins\dsh-plugin-read-image-preview" `
  "link:D:\program\dsh-plugins\dsh-plugin-shell-selector" `
  "link:D:\program\dsh-plugins\dsh-plugin-mcp-ui" `
  "link:D:\program\dsh-plugins\dsh-plugin-computer-use"

# 组合检查（不启动）
dsh --profile tofu-rc --dump-config | Select-String 'dsh-plugin-'

# 启动冒烟（随机端口；改代码后需重启，apply 只在进程启动时跑一次）
dsh --profile tofu-rc --no-open --port 0
```

要点：

- 隔离 home 没有模型凭据：页面/组合/单测都能验证，**不覆盖**需要真实模型请求的行为（标题生成、`generate_image`）。这类验证先确认凭据来源，不要从桌面 profile 复制。
- `computer-use` 的工具会操作**真实桌面**，用户正在用电脑时不要跑自测或冒烟动作，只验证工具注册。
- 非交互 shell 里 `dsh plugin` 可能因 stdin 不关闭而挂住：用 `cmd /c 'dsh plugin ... < NUL'` 包一层。
- 隔离 home 与 `~/.dsh` 的会话、凭据、storages 完全分离，和正在运行的桌面端互不影响。

## 调试

- `tools/doctor/doctor.mjs`：dsh 升完起不来时定位是哪个插件的问题（二分、自动 `dsh plugin update`、可选禁用）。
- `tools/probe/`：直连真实 Cua Driver 的对质脚本，用来在**脱离 `computer_*` 工具**的情况下验证驱动行为（DPI、会话语义、`launch_app` 复用语义、启动方式差异、本进程能枚举多少窗口）。这些是诊断工具，不是替代工具调用的捷径。
- 各插件自带自测，例如 `node dsh-plugin-computer-use/selftest/run.mjs`：在真实桌面上跑，只操作它自己启动的记事本，结束时自行回收。
