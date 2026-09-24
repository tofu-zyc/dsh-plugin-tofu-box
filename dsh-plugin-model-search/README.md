# dsh-plugin-model-search

给 DSH Web 输入栏的**模型选择菜单**加一个搜索框：模型很多时，打开菜单 →
模型 → 直接输入关键字过滤（匹配模型名 / 模型 ID / 模型描述 / provider 名称）。

## 效果

- 模型面板顶部多一个搜索输入框，进入面板时自动聚焦；
- 输入即过滤，保留分组结构；清空后恢复完整列表；
- **最近使用**：每次选择模型都会记录（浏览器本地，最多 5 条），空搜索时
  在分组前显示“最近使用/Recent”分组，便于快速切回；
- `↑` / `↓` 从搜索框直接跳转到过滤后的第一项 / 最后一项，`Esc` 清空搜索或返回上一级；
- 选择模型、推理等级、加载失败重试、错误 Toast 等行为与原菜单完全一致；
- `/model` 命令不受影响（命令面板本身已内置搜索）。

## 实现方式

这是一个持久化浏览器插件（`dsh.client`，无宿主逻辑）。**`package.json` 必须
声明 `dsh.client`**（`platform: "web"`）：宿主 `index.js` 是空的 `apply()`，
缺声明时插件行照样装载成功、插件清单也显示已启用，但浏览器半边从不进入
`window.__DSH_BOOT__`，表现为「装了却完全没效果」。1.1.0 正是漏了这条声明。


- 用 `ctx.slots.inject("conversation.input.model")` 以 **priority: -1** 注册
  同名 slot。该 slot 是 single 类型，SlotCore 规定「低优先级胜出」，因此本插件
  渲染的搜索版菜单会覆盖内置 `@deepseek-ai/dsh-client-ui-model-selection`
  的注册（priority 0）；如果本插件渲染崩溃，slot 错误边界会自动回退到内置菜单。
- 数据与写入仍复用内置插件提供的 `modelDirectories` 服务（同一份
  `session.models` / `session.selectModel` 状态），不读取也不改写任何配置。
- 样式使用 DSH 的设计令牌变量（`--dsw-*`），自动适配明暗主题。

## 安装

```bash
cd model-search
./install.sh
```

脚本会：

1. 复制插件到 `$DSH_HOME/plugins/model-search`；
2. 软链到 `$DSH_HOME/profiles/node_modules/dsh-plugin-model-search`；
3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中追加 insert 条目（幂等）。

然后：

1. **重启 `dsh web`**（patch 层在进程启动时读取）；
2. 刷新浏览器页面。

## 卸载

- 从 `$DSH_HOME/profiles/web/cordis.patch.yml` 中删掉
  `- id: model-search` 那一行（及其 `name` 行）；
- 删除软链 `$DSH_HOME/profiles/node_modules/dsh-plugin-model-search`
  和目录 `$DSH_HOME/plugins/model-search`；
- 重启 `dsh web` 并刷新页面。

## 兼容性

已在 dsh 0.1.7-alpha.2 的隔离部署与生产数据副本中验证：6 个旧 `<Name><Size>` 图标导出已经换成 `…Regular`，历史会话中的搜索模型菜单可显示并接受输入。该分支专用于 0.1.7-alpha.2；旧 dsh 0.1.6-alpha.2 不提供这些新图标，请勿把此版本源码链接到旧生产部署。
