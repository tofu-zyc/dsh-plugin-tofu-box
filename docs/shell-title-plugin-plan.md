# Shell 选择与标题模型配置实施方案

## 决策与分工

- 使用 Agent Teams，Shell 与标题配置分别由 `shell-selector`、`title-model` 负责。
- 两位队友真实 request/header 已核实：provider `deepseek-official`，model `deepseek-flash`，reasoningEffort `max`。
- Team 专属路由插件只匹配本次 Lead session 的 teammate，不改变用户默认模型；禁止递归委派及队友自行安装。
- 队友先调查并提交精确 API 方案，Lead 审核后编码，Lead 统一审查安装。

## Shell

目标：设置内直接选择 AI 命令执行的 Shell，而非仅改变交互终端。

候选：自动、PowerShell 7、Windows PowerShell 5.1、Git Bash。是否开放每项由实测能力决定，不能把不可用选项伪装为成功。

运行页目前无独立 Shell 菜单；优先复用实际扩展点，否则增加标准 settings.section，不修改 DOM 或替换应用根。

安全约束：保留 sandbox/approval/workdir/timeout/cancellation/output/jobs；不能直接裸 spawn 绕开沙箱，不改变权限模式；工具描述、启动参数及实际语法一致。运行中的任务不受新选择影响。

## 标题模型

优先将标题用途配置合入现有 model-tuning：默认继承对话，也可选择本地目录中的独立 provider/model/effort。

不更改默认对话模型；不追溯重写已有标题，特别是手动标题；保留标题失败回退、取消和超时行为；不同时注册两个竞争生成器。

现有绘图联动已经通过 source 标记实现单向配置。保留该机制及用户参数，不复制端点/密钥管理，也不把标题设置塞进绘图专用面板。

## 验收矩阵

1. 安装结果明确区分 applied 与 restart-required；更新包不得假定模块已重新载入。
2. 设置 UI 在现有 127.0.0.1:3080 页面实际渲染，可读、加载/保存错误可见。
3. Shell 验证版本标识、包含空格的工作目录、Unicode、退出码、超时/取消、后台输出及设置持久化。
4. Shell 在受限模式不能越过安全边界；不可支持的组合明确拒绝。
5. 标题设置读写验证并保持既有配置；本地 provider/model/effort 验证；失败回退与手动标题保护测试。
6. 标题的实际模型请求与对话请求分离；静态/mock测试不冒充线上模型请求验收。
7. 不自动大改预设、部署源码、默认模型或绘图配置；重启及残余限制如实说明。

## 当前状态

路由安装成功且实际请求已核实。功能实现待队友方案及后续审核，尚未完成安装验收。
