# tofu-box（伞包）

一条命令装齐 [TOFU BOX](https://github.com/tofu-zyc/dsh-plugin-tofu-box) 的全套
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件。
桌面端 / Web 端的插件管理页一次只能装一个包，本包把「六个一起装」压成一次。

```sh
dsh plugin --profile <你的profile> add tofu-box --ignore-scripts
```

桌面端：插件管理页的安装框里直接粘贴 `tofu-box` 即可。装完重启。

> **`--ignore-scripts` 不是可选项**：本包会拉入 `dsh-plugin-computer-use`，它依赖的原生模块 `koffi`
> 带一个 postinstall 脚本，pnpm 10/11 默认不执行并直接报
> `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi`，安装随之中断。
> `koffi` 走预编译二进制（`@koromix/koffi-<平台>`），跳过脚本不影响功能。
> 用桌面端插件管理页安装并遇到该错误时，把该 profile 的 `pnpm-workspace.yaml` 里
> `allowBuilds.koffi` 改成 `false` 再重试；细节见
> [`dsh-plugin-computer-use`](https://www.npmjs.com/package/dsh-plugin-computer-use) 的同一小节。

## 装到的是什么

| 子包 | 功能 |
| --- | --- |
| dsh-plugin-model-tuning | 官方 Models 卡片里的兼容/推理补丁 + 「设置 → 绘图」绘图模型与 `generate_image` 工具 |
| dsh-plugin-read-image-preview | 会话图片的全屏查看、标注、一键截图，回车直接进输入框 |
| dsh-plugin-shell-selector | 「设置 → Shell」选择 AI 用的 shell |
| dsh-plugin-computer-use | 13 个 `computer_*` 桌面操作工具 |
| dsh-plugin-mcp-ui | 「设置 → MCP 服务器」管理页 |
| dsh-plugin-billing-card | 输入框下方的实时费用卡片（DeepSeek 官方峰谷价 + 搜索/抓取按次计费，可配置扩展） |

各功能的说明、已知限制与兼容性见仓库
[README](https://github.com/tofu-zyc/dsh-plugin-tofu-box#中文)。

## 机制

本包不含任何代码，是 dsh 官方 `dsh-base` 同款的 bundle 模式：
`dependencies` 拉入六个子包（作为传递依赖，不会各自注册成独立层），
`dsh.bundle.patch` 用六个 patch 副本（`patches/`，与子包源文件逐字节一致，
`tools/check-umbrella-sync.mjs` 防漂移）在一个层里插入全部六条插件行。
Host 侧按闭包解析行，浏览器侧按行读各子包自己的 `dsh.client` 声明——
两条路径都是 dsh 的正式机制，无需 fork。

## 卸载与粒度

- 卸载整套：`dsh plugin --profile <p> remove tofu-box`。
- **本包与子包二选一，不要混装**：插件管理页按 profile 直接依赖展示，
  伞包装完后是一个整体条目，不能在 GUI 里单独禁用/移除某一个子插件。
  想按需取舍就别装本包，逐个安装对应的 `dsh-plugin-*` 子包。
- `dsh plugin update`（pnpm 语义）按 semver 更新子包，git 直装则永远追 HEAD。
