# dsh-plugin-mcp-ui

「设置 → MCP 服务器」页面插件。给 `@deepseek-ai/dsh-mcp-client` 补一个配置界面：
在网页上增删改 MCP 服务器，写入 profile 的 `cordis.patch.yml`，热生效。

官方 alpha（`0.1.6-alpha.1`）把 mcp-client 打包了但**一个服务器都不启用**，且
没有任何配置 UI——这个插件补的就是这一段。

## 功能

- 列表页：展示本插件管理的全部 MCP 服务器，支持启用/禁用、编辑、删除；
- 表单：`stdio`（command / args / env / cwd）与 `streamable-http`（url / headers）
  两种传输，外加超时、断线重连、`failOnStartupError`；
- 只读展示 patch 里**其它来源**的 mcp-client 行（手写或其它 patch 带入的），
  本页不会碰它们；
- 校验对齐 dsh-mcp-client 的 Config schema（serverName 字符集/长度、url 前缀、
  正整数超时、serverName 在注册范围内唯一）。

## 工作原理（重要）

**真实配置源是 profile 的 `cordis.patch.yml` 中的一个标记块**，不是数据库也不是
settings 命名空间：

```yaml
# >>> dsh-plugin-mcp-ui managed ... >>>
- insert:
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: "filesystem"
        command: "npx"
        args:
          - "-y"
# <<< dsh-plugin-mcp-ui managed <<<
```

- 块外内容**逐字保留**（字符串拼接 + 临时文件原子替换，不 YAML 重排整个文件）；
- profile 开着 `patchReload: live`（web profile 默认如此）时，保存后 Cordis 热应用
  补丁，**数秒内生效，无需重启**；否则重启 dsh 生效；
- 因此这个文件本身可以进 git，UI 写的内容和你手改的内容完全同构、可审计；
- 卸载本插件后标记块变成普通注释行包裹的合法配置，MCP 服务器照常加载，不会失联。

文件定位：安装后自动从 `node_modules/dsh-plugin-mcp-ui/` 的安装位置推导
`<profileDir>/cordis.patch.yml`。`link:` 开发安装（如本仓库）请显式配置——用
**覆盖行**（无 `insert:`，靠 id 命中自注册行、`name` 做安全校验），不要再 insert
造成同 id 双行：

```yaml
- id: mcp-ui
  name: dsh-plugin-mcp-ui
  config:
    patchPath: 'C:/Users/you/.dsh/profiles/web/cordis.patch.yml'
```

推导失败时插件会带着这条提示拒绝启动，不会写到错误的文件里。

## 安装

```sh
dsh plugin --profile web add github:tofu-zyc/dsh-plugin-tofu-box#path:dsh-plugin-mcp-ui
```

刷新设置页即可看到「MCP 服务器」标签。本包自带 `cordis.patch.yml` 自注册
（`dsh.bundle.patch` 机制），无需手工 insert。

## 注意

- 工具命名为 `mcp__<serverName>__<工具名>`；`serverName` 在同一注册范围唯一，
  重复注册会抛错（页面会先校验拦下）。
- stdio 服务器启动慢/挂起可能短暂阻塞工具注册；`failOnStartupError` 默认关闭，
  单个服务器坏了不会拖垮启动。
- env / headers 会以**明文**写进 `cordis.patch.yml`，注意 git 提交范围。
- MCP prompt 模板不被 dsh-mcp-client 支持，本页面也不提供。

## 与 DSH 版本的耦合点（0.1.6-alpha.1）

- 数据面走 `ctx.connection.rpc.intercept('/api', ...)`（宿主）×
  `ctx.connection.rpc.call('/api', ...)`（浏览器），认证复用官方连接层；
  旧的 `ctx.connection.api` 已在 0.1.2 移除，勿混淆。
- Config schema 对齐 `@deepseek-ai/dsh-mcp-client`：
  `transport: stdio | streamable-http` 判别联合、`toolCallTimeoutMs` 默认 60000、
  `reconnect { enabled, initialDelayMs, maxDelayMs, maxAttempts }`。
- headless（无 connection 服务）时宿主半边只打一条日志，不注册 UI 通道。
