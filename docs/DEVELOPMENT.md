# 开发

面向本仓库的日常开发（改插件代码、调试 dsh 里的行为）。

## 依赖装成本地链接

改代码要"改完就能调试"，就别让 profile 依赖 GitHub 的 tarball——用 `link:` 指向本仓库，profile 里的 `node_modules/dsh-plugin-*` 会变成指到工作区的 junction，不再有"装了一份拷贝、改了不生效"的问题：

```sh
dsh plugin --profile web add \
  "link:D:\program\dsh-plugins\dsh-plugin-computer-use" \
  "link:D:\program\dsh-plugins\dsh-plugin-model-search" \
  "link:D:\program\dsh-plugins\dsh-plugin-model-tuning" \
  "link:D:\program\dsh-plugins\dsh-plugin-read-image-preview" \
  "link:D:\program\dsh-plugins\dsh-plugin-mcp-ui"
```

要点：

- **必须用绝对路径**。`dsh plugin --profile X add <args>` 只是转发给 profile 目录里的 pnpm（cwd = profile），相对路径会被锚定成 profile 内部的路径。
- **改完代码仍需重启 dsh**：插件是在进程启动时 `apply()` 一次的，链接省掉的是"拷贝"，不是"重载"。
- **改了结构（`package.json`、`dsh.bundle`）要重跑上面的 `add`**：`dsh.profile.bundles` 是按解析结果对账的。
- 回到发布版：把 `link:` 换成 `github:tofu-zyc/dsh-plugin-tofu-box#path:<插件>` 再 `add` 一次。

## 调试

- `tools/doctor/doctor.mjs`：dsh 升完起不来时定位是哪个插件的问题（二分、自动 `dsh plugin update`、可选禁用）。
- `tools/probe/`：直连真实 Cua Driver 的对质脚本，用来在**脱离 `computer_*` 工具**的情况下验证驱动行为（DPI、会话语义、`launch_app` 复用语义、启动方式差异、本进程能枚举多少窗口）。这些是诊断工具，不是替代工具调用的捷径。
- 各插件自带自测，例如 `node dsh-plugin-computer-use/selftest/run.mjs`：在真实桌面上跑，只操作它自己启动的记事本，结束时自行回收。
