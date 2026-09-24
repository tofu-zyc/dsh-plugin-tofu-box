# 问题交接：model-tuning「Failed to load plugins / did not activate」（2026-09-20）

## 症状（用户实际看到的）

浏览器打开 dsh web，HARNESS 启动卡报：

```
Failed to load plugins
dsh-plugin-model-tuning
web boot: 1 entry did not activate
dsh-plugin-model-tuning: failed
```

## 根因（已定位、已修）

`web boot: <id>: failed` 的判定来自 `dsh-web-frontend` 的 boot 收尾函数：它遍历每个
client entry 的 cordis fiber 状态，`failed` = **模块导入成功、但 `apply()` 里抛错**
（不是导入失败，也不是 waiting for service）。

抛错的代码是 v1.2.0 新增的、注册「用途」页文案的这两行：

```js
if (ctx.locale) {
  ctx.locale.register("dsh-plugin-model-tuning", { en: {...}, zh: {...} });
}
```

但 model-tuning 的 `exports.inject` 只有
`["slots","remote","remote.llm","remote.settings","remote.session"]`，**没有 `locale`**。

cordis 的 ctx 是 Proxy（`@deepseek-ai/cordis/lib/index.js` 的 `ReflectService.handler.get`），
对**插件 fiber**（`fiber.runtime` 存在）读取未声明在 inject 里的服务时，会逐层向上找，
到根 fiber 仍找不到就抛：

```
cannot get property "locale" without inject
```

所以 `if (ctx.locale)` 这行**属性读取本身**就把 `apply()` 炸了 → fiber 进入 `failed`
→ boot 报 `1 entry did not activate`。

关键教训：**`if (ctx.locale)` 这种“存在性判断”在 cordis ctx 上挡不住崩溃**——不是普通
对象的 `undefined` 判断，而是 getter 会抛。要么老实把 `locale` 写进 inject，要么用
`ctx.get("locale")`（返回 undefined，不抛）。官方 `dsh-client-locale` 自己就是这么做的。

## 修复（已改，工作区）

`dsh-plugin-model-tuning/client.js`：

1. `exports.inject` 加上 `"locale"`（第 1195 行附近）。这是 client.js 运行期返回值里的
   inject，被 client runner 直接读取用于 fiber 的 inject；**不是** package.json 里的
   `dsh.client.inject`（那是模块加载顺序，另一回事，无需改）。
2. 文案注册包进 `ctx.effect(() => ctx.locale.register(...))`：`register` 对同一
   `ns+locale` 重复注册会抛错（HMR 再激活必踩），挂到 effect 上可随 fiber dispose 自动注销。
3. 相应测试：
   - `tests/title-purpose.test.mjs` 的 `ctx.effect` 桩改为同步执行回调（对齐真实 cordis），
     否则测不到 effect 内的注册。
   - 新增回归用例「locale is declared in inject」。

验证：`node tests/title-purpose.test.mjs` 13/13、`node tests/image-link.test.mjs` 16/16 全过。

## 顺带（与本次崩溃无关）

- 新包 `dsh-plugin-title-model`（「用途」页的标题 provider 宿主半）此前只是躺在仓库、
  没装进 web profile。已用正确命令安装：
  `dsh plugin --profile web add link:D:/program/dsh-plugins/dsh-plugin-title-model`，
  `dsh --profile web --dump-config` 里确认 `session-title-llm` 让位、`title-model` 注册。
  **它是宿主侧包，装完/改完必须重启 dsh** 才生效（页面上会显示「标题生成 · 已安装」）。
- 用户之前看到的 `profile "plugins" does not exist`：那是 `dsh plugins ...` 打错命令被
  当成「启动名为 plugins 的 profile」，与本次加载失败无关。管理插件是
  `dsh plugin --profile web ...`（单数）。

## 复现/验证要点（给下一位）

- 看这类 boot 报错的真实抛出：`web boot` 收尾函数只报 state，不打印底层错误；底层
  `apply()` 抛错会进浏览器 console（cordis logger）。定位方向是「哪个服务访问没在 inject」。
- client 端改动生效方式：
  - 改 `client.js` 的 **inject / apply 结构**：需要刷新页面重跑 boot（本 bug 属于此类）。
  - 若没跑 `pnpm run dev:web`，浏览器端 bundle 不重建，光刷新拿到的还是旧产物——需宿主重启。
  - `dsh-plugin-title-model` 是宿主包：改完必须重启宿主，页面热刷无效。
- `link:` 开发模式下 profile 的 `node_modules/dsh-plugin-*` 是本仓库的 junction，
  改源码即改安装态。

## 待办

- [ ] 用户重启一次 dsh（让 title-model 生效 + 拉取新 client.js）。
- [ ] 打开「设置 → 模型调参 → 用途」确认「标题生成」显示「已安装」且可读写。
- [ ] 确认后提交工作区改动（model-tuning v1.2.0 四件套 + 新包 title-model、shell-selector、
      team-task-route）。
