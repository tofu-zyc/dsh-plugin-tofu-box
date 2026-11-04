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

**现行规矩（2026-11-04 起）**：插件测试只用 `rc-dev`（dsh rc 通道）与 `alpha-dev`（dsh alpha 通道）两个 profile，
每次测试前先把它们更新到该通道最新版。命令、模型配置、重建与排错全部写在
[TESTING-PROFILES.md](TESTING-PROFILES.md)，这里只留最短版本：

```powershell
pwsh -File tools\dev-dsh.ps1 rc-dev    -Update              # 开工：更新运行时 + 插件依赖
pwsh -File tools\dev-dsh.ps1 rc-dev    -Plugin add "link:D:\program\dsh-plugins\dsh-plugin-computer-use"
pwsh -File tools\dev-dsh.ps1 rc-dev    --dump-config        # 组合检查
pwsh -File tools\dev-dsh.ps1 rc-dev    --no-open --port 0   # 启动冒烟，URL 交给用户
```

要点：

- profile 只是配置层，dsh 版本由运行时（`.dsh-runtime\rc` / `.dsh-runtime\alpha`）决定，
  所以必须走 `tools/dev-dsh.ps1`；全局 `dsh --profile rc-dev` 会跑在错的版本上。
- 两个 profile 用实验室 `lab` 供应商（自部署），不需要 DeepSeek 官方 key；`LAB_API_KEY` 在
  `~/.dsh/.credentials.yaml`，不要复制进 profile。
- `computer-use` 的工具会操作**真实桌面**，用户正在用电脑时不要跑自测或冒烟动作，只验证工具注册。
- 非交互 shell 里 `dsh plugin` 可能因 stdin 不关闭而挂住：脚本内部已用 `cmd /c ... < NUL` 包了一层。

历史环境：`.dsh-rc-test`（隔离 home + `tofu-rc` profile，五个工作区插件 `link:` 装入）、`.rc3-home`、
`.dsh-017*` 都是早期升级验证留下的档案，保留但不作为测试基线。


## 调试

- `tools/doctor/doctor.mjs`：dsh 升完起不来时定位是哪个插件的问题（二分、自动 `dsh plugin update`、可选禁用）。
- `tools/probe/`：直连真实 Cua Driver 的对质脚本，用来在**脱离 `computer_*` 工具**的情况下验证驱动行为（DPI、会话语义、`launch_app` 复用语义、启动方式差异、本进程能枚举多少窗口）。这些是诊断工具，不是替代工具调用的捷径。
- 各插件自带自测，例如 `node dsh-plugin-computer-use/selftest/run.mjs`：在真实桌面上跑，只操作它自己启动的记事本，结束时自行回收。
