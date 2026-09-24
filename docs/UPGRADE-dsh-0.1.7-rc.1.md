# dsh 0.1.7-rc.1 插件兼容性检查（分支 `upgrade/dsh-0.1.7-rc.1`）

检查日期：2026-09-23。对照基线是已经完成迁移并验证过的 `upgrade/dsh-0.1.7-alpha.2`（提交 `c77ba6b`）。
**生产 3080 仍运行 0.1.6-alpha.2，本次没有改动生产。**

## 0. 结论速览

- npm 频道：`next` = **0.1.7-rc.1**，`alpha` 仍是 0.1.7-alpha.2，`latest` 仍是 0.1.5-rc.3。
- alpha.2 → rc.1 共 **156 个提交**，但我们九个插件用到的契约面几乎零改动：`settings`、`shell`、`session-title`、
  `attachment`、`typert`、`core/tools` 这些包**只有版本号 bump，src 一字未改**（逐个 `git diff --name-only` 核对）。
- **唯一真实破坏点**：`tool.call.toolview` 增加了第三个阶段 `preparing`（见 §2），影响 read-image-preview，已修复。
- **最需要注意的新行为不是改名，而是一道新的 peer 兼容门禁**（见 §3）：不匹配会**静默跳过整个 bundle**，只在 stderr 留一行。
- Session 格式仍是 `SESSION_FORMAT_VERSION = 4`（两个 tag 相同）→ 老 V3 会话的迁移行为不变。
- 逐插件结论：9 个里 **8 个无需改动**，read-image-preview 需要一处阶段判断（已改并加回归测试）。

## 1. 环境

| 用途 | 位置 | 说明 |
| --- | --- | --- |
| 分支 | `upgrade/dsh-0.1.7-rc.1` | 从已验证的 alpha.2 修复提交 `c77ba6b` 切出 |
| 工作树 | `.dsh-017rc1-test/source` | 九个插件链接到这里；生产与 `main` 的链接未动 |
| rc.1 部署 | `.dsh-017rc1-test/deploy`（510 包） | `@deepseek-ai/dsh@0.1.7-rc.1` |
| 隔离实例 | profile `web17rc1`，端口 3098 | 空 home，凭据由测试自行写入 |
| 生产数据副本 | `.dsh-017rc1-test/corpus-home`，profile `web`，端口 3101 | 由 `home-016` 静止快照复制，九个链接指向 rc.1 工作树 |

## 2. 唯一真实破坏点：`tool.call.toolview` 三阶段

提交 `feat(chat): present tools in preparing, start, and result stages`——**没有 `!`，也没有 BREAKING CHANGE 脚注**，
156 个提交里这类未标注的破坏点只有这一处（另一个是 §3 的门禁）。

- `packages/client/ui-conversation/src/client/contract/records.ts`：`RunningToolCall` 被拆成
  `PreparingToolCall`（**没有 `argsRaw`**）与 `StartedToolCall`（有 `argsRaw`）。
- `packages/client/ui-tool/src/client/contract/slots.ts`：owner props 从 `{ …, block: ToolCallBlock }` 变成
  `ToolCallCommonProps & ToolCallPhaseProps`，`phase ∈ preparing | start | result`，并新增 `hookContext`、
  `toolCallArgumentsPartial` 注入钩子。
- `packages/client/ui-chat/src/client/conversation-nodes/tool.ts`：`tool-call` 节点现在也匹配 `tool-call-delta`，
  所以**参数还在流式生成时视图就会被渲染**。

我们的插件是纯 JS，所以不会编译报错、也不会抛异常：`props.block` 仍然在，只是 preparing 阶段拿不到 `argsRaw`。
后果是 `read-image-preview` 的 `isRunningBlock()` 判定 preparing 为「已结束」，落到无内容的分支 `return null`——
**被我们占用的 key 在 preparing 阶段渲染成一行空白**（官方视图会显示参数流式过程，我们占位就得自己显示）。
用官方三阶段形状直接驱动组件即可复现：修复前 `NULL -> blank row`，修复后正常出卡。

修复：`dsh-plugin-read-image-preview/client.js` 的 `isRunningBlock()` 把 `phase === 'preparing' | 'start'` 都算运行中。
回归测试：`dsh-plugin-read-image-preview/tests/phases.test.mjs`（5 项，覆盖 preparing 无参数、start 半截 JSON、
settled 附件图、失败行、无图 settled 行仍让位官方行）。测试可用 `READ_PREVIEW_CLIENT=<client.js>` 指向别的副本，
指向未修复版本时会失败——确保它真的咬得住。

其余插件不注册 `tool.call.toolview`（只有 read-image-preview 注册），因此不受影响。

## 3. 新增 peer 兼容门禁（升级时最容易踩的坑）

`feat(plugins): enforce DSH peer compatibility with exact exemptions`：

- `packages/boot/app-boot/src/plugin-compatibility.ts`（新）：检查 `peerDependencies` 里所有
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，用 `semver.satisfies(运行时版本, range, { includePrerelease: true })` 判定。
- `packages/boot/app-boot/src/profile.ts`：**不匹配就跳过整个 bundle**，只在 stderr 打一行；
  `compatibility-preflight.ts` 会把相关 row 置 `disabled`。逃生门是 `<profile>/compatibility.json`
  或 `dsh plugin allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。
- 用部署自带的 semver 实测：我们六个 peer 声明（`>=0.1.5-rc.1`、`>=0.1.6-alpha.1`、`^0.1.6-alpha.1`、
  `^0.1.6-alpha.2`）**全部通过**；但把 peer 钉成 `0.1.7-alpha.2` 这种精确版本会**静默失效**。
  `@deepseek-ai/schemastery` 不在 `@deepseek-ai/dsh-` 前缀内，永远不会触发这道门。

**约束：以后升级一律保持开区间 peer（`>=` / `^0.1.x`），不要钉死精确版本。**

## 4. 逐插件结论

| 插件 | 结论 | 依据 |
| --- | --- | --- |
| model-search | 无需改动 | `conversation.input.model` 契约文件零 diff（只有官方 `ModelSelect.tsx` 变）；6 个 `…Regular` 图标在 rc.1 行号不变；无 dsh peer |
| image-generation | 无需改动 | settings 服务 src 零 diff；`defineTool`/`tools.register`/`attachments.*` 所在目录零 diff；volatile `.get()` 不变；peer 通过 |
| title-model | 无需改动 | `sessionTitle.register` 与 `generateSessionTitleWithLlm(ctx, config, request, selectedMessages, provider)` 签名不变；base 行 `session-title-llm` 仍在；peer 通过 |
| shell-selector | 无需改动 | base 条目仍是 `pwsh-sandbox` + volatile `pwshPath`；`ctx.get('shell')` 执行器服务名不变；`describe/mutate` 签名不变 |
| model-tuning | 无需改动 | `settings.section` 契约零 diff；`settings-controller/src` 零 diff；依赖的两个命名空间在 rc.1 下确认可见 |
| read-image-preview | **已改** | 见 §2；顺带记：官方新导出 `ImageLightbox`、`fileMediaUrl()`、Markdown 本地图预览已能覆盖我们自研缩放层的一部分，将来可简化，但本次不动 |
| computer-use | 无需改动 | `defineTool`/`tools.register`/`attachments.saveImage` 全部零 diff；peer 通过 |
| mcp-ui | 无需改动 | `TypertRemoteService`/`RemoteError`/`REMOTE_METHODS_KEY`/`connection.rpc.call` 全部零 diff；`dsh.bundle.patch` 仍接受字符串 |
| team-task-route | 无需改动（观察） | 官方 `@deepseek-ai/dsh-experimental-agent-team` **确实删了** `./typert`、`./remote` 导出与 `TeamView`/`remoteView`（改用 `agentTeam` Session 投影），但我们只用 `tryMembership(agent)`，签名未变 |

`@deepseek-ai/dsh-experimental-agent-team-web-profile` 在 alpha.2 与 rc.1 **两个 tag 都不存在**（比 alpha.2 更早删的），
所以生产 profile 里那条仍需在切换时删除，这一点与 alpha.2 计划一致。

## 5. 验证记录

- 单元测试（`DSH_TEST_DEPLOY_ROOT` 指向 rc.1 部署）：image-generation 14、shell-selector 30、
  title-model 路由/schema 与 provider 两组、model-tuning 图像联动 16 + 标题联动 13、
  read-image-preview 阶段回归 5 —— 全部通过。
- 隔离实例 3098（空 home）：`--dump-config` 无 skipped、无 incompatible 警告、9 个插件行齐全；
  无头 Edge 跑通绘图「配置→列表→生成→附件预览→原图下载」（假图像服务，未产生费用）；
  Shell 页选 5.1 再恢复自动，`pwsh-sandbox` volatile 写入与还原正常；用途页能看到 `title-model`；零 pageerror。
- 生产数据副本 3101（真实凭据/模型/会话）：rc.1 自动导入旧 `settings.yaml`，两个生产绘图模型
  （`ironman-gpt-image`、`ironman-gpt-image-2-5`）都在；`title-model` 命名空间照常发布；
  历史会话可打开；模型座位仍由我们接管（触发器 aria 文案是我们 `trigger.ariaEffort` 的格式，
  菜单里点「模型」分栏后搜索框出现——官方 `ModelSelect` 没有搜索框）；零 pageerror。
  注意：模型菜单默认停在「推理等级」摘要栏，搜索框要点「模型」分栏才渲染，脚本别按第一版那样直接等。
- 未覆盖：真实付费绘图调用；真实 agent 回合里 preparing 阶段的实际渲染（用官方三阶段形状代替，
  见 `dsh-plugin-read-image-preview/tests/phases.test.mjs`）。

## 6. 对生产切换的影响

切换目标建议直接用 **0.1.7-rc.1**（`next` 频道），不必先上 alpha.2 再跳一次。`tools/upgrade-dsh-017.ps1` 已经参数化：
默认 `-TargetVersion 0.1.7-rc.1`、`-SourceDir .dsh-017rc1-test\source`；不带 `-Execute` 仍是只读预检。
相比 alpha.2 版本它多做两件事：

1. **切换前把已验证源码逐文件哈希比对地暂存到 `.dsh-017-prod\source`**，生产 profile 的九条链接改指这份冻结副本。
   这样生产不再链接任何 Git 工作树（工作树会随分支切换变内容），回滚也不必动插件文件。
   代价：切换后生产跑的是冻结副本，日常改 `main` 里的插件不会自动生效——要生效就重新同步副本（或把分支合进 `main` 后把链接改回仓库根目录，二选一，随时可以做）。
2. **上线前跑一次 rc.1 那道 peer 门禁**（用装好的 DSH 自带的 semver + `includePrerelease`，与官方实现一致），
   判定不通过就直接失败，而不是让 bundle 被静默跳过后才发现功能不见了。

其余流程不变：停机 → 静止备份 → 装全局包 → profile 去掉已删除的 web bundle 并重链 → 启动 → 3080 无头验收 →
失败自动回滚（连 profile 与 home 一起恢复）。回滚仍然必须是「包 + 数据」一起回，因为 0.1.7 会写 V4 会话日志。

## 7. 待办

- 用户选定维护窗口后执行切换（会中断 3080 上的当前会话）。
- 切换成功后决定插件来源：继续用 `.dsh-017-prod\source` 冻结副本，或合并分支后把链接改回仓库根目录。
- 可选简化：官方 `ImageLightbox` / `fileMediaUrl()` / Markdown 本地图预览已经覆盖 read-image-preview 自研缩放层的一部分，
  `toolCallArgumentsPartial` 可以让我们在 preparing 阶段就显示正在流入的参数；本次都不动，等生产稳定后再评估。
- `mcp-ui` 与官方 config-editor 同写 profile patch 的并发编辑风险仍在（与版本无关）。
