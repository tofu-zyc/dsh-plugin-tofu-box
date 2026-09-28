# tofu-box（伞包）

一条命令装齐 [TOFU BOX](https://github.com/tofu-zyc/dsh-plugin-tofu-box) 的全套
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件。
桌面端 / Web 端的插件管理页一次只能装一个包，本包把「六个一起装」压成一次。

```sh
dsh plugin --profile <你的profile> add tofu-box
```

桌面端：插件管理页的安装框里直接粘贴 `tofu-box` 即可。装完重启。

## 装到的是什么

| 子包 | 功能 |
| --- | --- |
| dsh-plugin-model-search | 模型选择菜单加搜索框 |
| dsh-plugin-model-tuning | 「设置 → 模型调参」：模型参数 / 标题路由 / 绘图 |
| dsh-plugin-read-image-preview | 工具结果图片渲染成可缩放卡片 |
| dsh-plugin-shell-selector | 「设置 → Shell」选择 AI 用的 shell |
| dsh-plugin-computer-use | 13 个 `computer_*` 桌面操作工具 |
| dsh-plugin-mcp-ui | 「设置 → MCP 服务器」管理页 |

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
