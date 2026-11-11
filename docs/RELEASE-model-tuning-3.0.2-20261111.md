# 发布：model-tuning 3.0.2 / tofu-box 1.2.4（2026-11-11）

修复**模型参数卡片保存即报错**的 bug：在「设置 → 模型」的 provider 卡片里改推理档位、
developer role 或思考格式，点保存就弹 `client api: settings/mutate expected 3 argument(s), got 2`，
任何修改都写不进去。`tofu-box` 伞包同步升到 **1.2.4**（model-tuning 依赖 `^3.0.2`）。

## 发布内容

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-model-tuning` | 3.0.2 | saveCompat 补齐 settings/mutate 的第三个参数 expectedRevision |
| `tofu-box` | 1.2.4 | 伞包同步 model-tuning `^3.0.2`（patch 副本无变化，dependencies 更新） |

## 根因与修法

- **根因**：`settings/mutate` 的宿主签名是 `(ns, ops, expectedRevision)` 三个参数
  （`@deepseek-ai/dsh-api-settings-controller`），客户端桥按声明的参数个数做 arity 检查。
  插件的绘图页与绘图链接分支都传了三个参数，唯独 compat 卡片走的 `saveCompat`
  只传了 `(write.ns, write.ops)` 两个——于是这条路径的每次保存都被桥直接拒绝。
- **修法**：保存前**重读目标 provider 命名空间**，用同一份新文档重算 ops 并取它的
  `revision` 作为 `expectedRevision` 传回。这与绘图页 `commit()` 已有的纪律一致：
  计划和它应用的 revision 必须来自同一次读取——既过 arity 检查，又让乐观锁真正生效
  （并发写入会被拒绝而不是被静默覆盖）。
- 顺带移除 `saveCompat` 里不再使用的快照 `nsView` 局部变量。

## 安装 / 升级

```sh
# 单装
dsh plugin --profile <p> add dsh-plugin-model-tuning@3.0.2

# 已装伞包的 profile
dsh plugin --profile <p> update tofu-box
```

装完刷新页面。无配置迁移、无投影版本变化。

## 验证

- 新增 `tests/settings-mutate.test.mjs`（5 用例）：假 remote 强制执行与真实桥相同的
  3 参数 arity 门——**修复前的 bundle 精确复现用户报错**（`expected 3 argument(s), got 2`），
  修复后全绿；另钉住"写前重读、ops 与 revision 同源、并发写入不覆盖、宿主拒绝会 surfaced"。
- 全套 **47/47 测试通过**（含 `DSH_TEST_DEPLOY_ROOT` 指向 rc 运行时的部署耦合守卫：
  部署的 pi-ai 确实按 adaptive 开关改请求体）。
- `tools/check-umbrella-sync.mjs` 通过（6 个子包 / 6 份 patch 副本 / 6 条依赖）。

## 已知限制

- 本修复只覆盖 compat 卡片路径；绘图页路径原本就是三参数，未改动。
- 真浏览器里的点击确认仍按仓库规矩由用户自己打开 rc-dev 的 URL 完成。