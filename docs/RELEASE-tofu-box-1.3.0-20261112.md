# 退役：mcp-ui / tofu-box 1.3.0（2026-11-12）

## 决定

用户 2026-11-12 决定退役 `dsh-plugin-mcp-ui`（npm 1.0.4）。原因：dsh **0.2.2-rc.2** 起官方
web-app bundle 新增 `mcp-manager` 行（`@deepseek-ai/dsh-mcp-manager`）——运行时管理 MCP 服务器
（增删改、启停、探测、凭据模板）并带官方设置 UI。本插件的唯一存在理由（官方没有 MCP 配置界面）消失。
[PLUGIN-SCOPE-dsh-0.2.1-rc.1.md](PLUGIN-SCOPE-dsh-0.2.1-rc.1.md) §2.4 早已写明退场条件：
「若上游给 mcp-client 补一个伴随 UI，本插件可直接退场」——条件成立。

与 2026-11-04 删除 codex-login（从未发布）不同，mcp-ui 是已发布包且是伞包成员，退役包含 npm 侧动作。

## 已装用户的影响与迁移

- **已配置的 MCP 服务器不受影响**。mcp-ui 把服务器写成 profile `cordis.patch.yml` 里独立的
  `@deepseek-ai/dsh-mcp-client` 行（managed 标记块只是注释）；插件 `apply()` 只注册 Remote 服务，
  **卸载没有任何删除标记块的清理逻辑**（已核对源码）。卸载插件后这些行照常组合、服务器照常连接。
- 卸载：`dsh plugin --profile <p> remove dsh-plugin-mcp-ui`；装伞包的用户更新 tofu-box 到 1.3.0 即自动移除。
- 新增/管理服务器：用官方「设置 → MCP」（mcp-manager，服务器存在它自己行的 `config.servers` 里）。
  旧的独立 mcp-client 行与官方 manager 可共存，但**同一个服务器不要在两边都配**（会挂两个实例、工具重名）。
  想迁到官方管理：把旧行的配置搬进 mcp-manager 的 servers，再删旧行。
- npm 包 `dsh-plugin-mcp-ui` 全部版本标记 deprecated（安装时显示退役提示）；不删除已发布版本，
  旧 profile 仍可解析安装，只是不再维护。

## 仓库变更

| 项 | 变更 |
| --- | --- |
| `dsh-plugin-mcp-ui/` | 整目录删除（git 历史可找回） |
| `tofu-box` | 1.2.5 → **1.3.0**：dependencies 与 `dsh.bundle.patch` 移除 mcp-ui，删 `patches/mcp-ui.yml` 副本；peer 并集不变（typert-protocol/schemastery 由其余成员覆盖） |
| README（中英） | 插件表、安装清单、版本线移除 mcp-ui；「已下线插件说明」补退役条目 |
| UPGRADE-CHECK.md | 清单行划掉并注记退役 |
| PLUGIN-SCOPE / DEVELOPMENT / 历史 UPGRADE·RELEASE 文档 | 状态注记「2026-11-12 已退役删除」，保留当时记录 |

## 验证

- `node tools/check-umbrella-sync.mjs`：**通过（5 个子包 / 5 份 patch 副本 / 5 条依赖）**。
- `publish.ps1` dry-run（profile 加载 NPM_TOKEN，发布身份 tofuzyc）：同步校验 5/5/5 通过；六个子包版本均已发布过、正确跳过；
  **tofu-box@1.3.0 tarball 8 个文件**：LICENSE / README.md / package.json + 5 份 patch 副本（无 mcp-ui.yml），5.6 kB。
- rc-dev（dsh 0.2.2-rc.2）：`-Plugin remove dsh-plugin-mcp-ui` 后 `--dump-config` 其余 7 个插件行全部照常合成，
  组合里无 mcp-ui 残留；重启冒烟后首页 boot manifest 不含 mcp-ui、其余 6 个 Client 半区齐全，`/pvz-perf/status` 200。
  rc-dev patch 本就无 managed 块（0 server），无迁移残留。
- 退役前兼容性审计（今早）已确认 mcp-ui 在 0.2.2-rc.2 上仍可运行——退役是产品决定，不是兼容性修复。

## registry 动作（需用户确认后执行）

- [ ] `npm deprecate dsh-plugin-mcp-ui@* "<退役提示>"`
- [ ] `./publish.ps1 -Publish tofu-box`（1.3.0；staged publishing 下用 `npm view tofu-box versions --json` 确认出现后再验证安装）

## 找回

`git checkout <退役提交>^ -- dsh-plugin-mcp-ui`（或从 npm 1.0.4 tarball）。
