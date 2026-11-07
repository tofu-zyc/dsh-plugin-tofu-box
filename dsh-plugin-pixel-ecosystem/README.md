# dsh-plugin-pixel-ecosystem（像素生态缸）

在 DeepSeek Harness 的侧边栏点一下图标，主面板就是一整块**活着的像素生态**：撒草、种树、放兔子放狼，
看它们长、吃、追、生、死。0.1.0 一上来就是**完整食物网**，不是草-兔-狐三人转：
陆地有草 → 兔子/鹿 → 狐狸/狼，水里有水草 → 小鱼 → 狗鱼，乌鸦专吃遗骸，遗骸腐烂再回肥力给草——
一圈闭环。动物带可遗传的基因（速度 / 视野 / 体型 / 代谢 / 寿命 / 繁殖率），生崽时小幅变异，
所以种群会自己波动；有昼夜明暗，世界自动存进浏览器本地，关掉页面再回来还在。
它就是给「AI 干活、你等结果的那几分钟」摸鱼用的，不联网、不改你的会话、不碰 Host。

> **状态：0.1.0，尚未发布到 npm。** npm 上没有 `dsh-plugin-pixel-ecosystem` 这个包，现在只能从本仓库
> `link:` 或 git 直装（见下面「安装」）。发版时要**先发子包 `dsh-plugin-pixel-ecosystem`，再发伞包 `tofu-box`**。
>
> 兼容性：`engines.dsh` 声明为 `>=0.2.0-rc.2 <0.3.0-0`；Client 半只声明 `platform: web`。
> 本文不声称做过浏览器里的视觉确认——那一步请按「测试」一节自己起服务、自己打开链接看。

主面板的样子（示意图，不是截图）：

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⬡ 像素生态缸  第 3 天 14:20  ●兔128 ●鹿44 ●狐9 ●狼2 ●鱼90 ●狗鱼3   │ 头部
│                              ⏸ 1× 2× 4× 8× · 新世界 · 玩法 · 回到对话 │
├────────────────────────────────────────┬─────────────────────────────┤
│                                        │ 生命工具 / 地形工具（网格）   │
│           像素画布（整数缩放）           │ 笔刷 小/中/大                │
│                                        │ 种群曲线（多色折线）          │
│                                        │ 选中生物基因条 / 提示          │
└────────────────────────────────────────┴─────────────────────────────┘
```

## 安装

包名 `dsh-plugin-pixel-ecosystem`，插件行 id 是 `pixel-ecosystem`。Client 半是手写浏览器模块，
**没有构建步骤**，仓库里是什么 npm 里就是什么。

```bash
# 1) npm（等 0.1.0 发布之后才有；现在跑这条会装不到，npm 上还没有这个包）
dsh plugin --profile <你的profile> add dsh-plugin-pixel-ecosystem

# 2) 或装整套伞包（tofu-box 1.3.0 起包含本插件；同样要等发布）
dsh plugin --profile <你的profile> add tofu-box

# 3) 开发 / 未发版：从本仓库本地目录安装（link 方式，改代码不用重装）
#    必须写绝对路径：dsh plugin ... 只是转发给 profile 里的 pnpm，相对路径会被锚定到 profile 内部
dsh plugin --profile <你的profile> add "link:D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem"

# 4) 未发版：从 git 直装（追 HEAD）
dsh plugin --profile <你的profile> add "github:tofu-zyc/dsh-plugin-tofu-box#path:dsh-plugin-pixel-ecosystem"
dsh plugin --profile <你的profile> add "git+https://github.com/tofu-zyc/dsh-plugin-tofu-box.git#path:dsh-plugin-pixel-ecosystem"
```

在当前会话里用 `plugin_manager` 装（会让该 profile 的所有会话生效）：

```
plugin_manager install_bundle target = D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem
```

手工维护 profile 的 `cordis.patch.yml` 时，等价写法是：

```yaml
- insert:
    - id: pixel-ecosystem
      name: dsh-plugin-pixel-ecosystem
```

要点：

- **新装的 Client 模块要刷新一次页面才会加载**；刷新后侧边栏多一枚像素图标，点它进主面板，
  点「回到对话」收回会话。
- `link:` 装法省掉的是「拷贝」，不是「重载」——改完 `client.js` 仍要重启 dsh。
  改了 `package.json` / `dsh.bundle` 这类结构，得把上面的 `add` 重跑一次。
- 建议在**隔离 profile** 里装：本仓库的规矩是只用 `rc-dev` / `alpha-dev` 两个测试 profile
  （见 [`docs/TESTING-PROFILES.md`](../docs/TESTING-PROFILES.md)），**不要**装进你日常用的
  `desktop` profile。

## 怎么玩

世界默认 200 × 130 格。地形 `水 / 沙 / 土 / 草地 / 石头` 由种子程序化生成（约 17% 水、4.5% 岩）。

### 头部与面板控制

| 控件 | 做什么 | locale key |
| --- | --- | --- |
| 暂停 / 继续 | 冻结或恢复模拟（暂停时仍可放置、缩放、观察） | `speed.paused`、`action.pause`、`action.play` |
| 1× / 2× / 4× / 8× | 时间倍速。1 天 = 120 秒（1× 下） | `speed.1` … `speed.8` |
| 新世界 | 换一个随机种子重开；**再点一次确认** | `action.newWorld`、`action.newWorldConfirm` |
| 玩法 | 弹出玩法提示（左键放置 / 右键擦除等 6 条） | `action.help`、`help.title`、`help.1` … `help.6` |
| 适应窗口 | 缩放与偏移归位 | `action.fit` |
| 回到对话 | 收起主面板、回到会话 | `action.back` |
| 关闭 | 关掉面板（模拟随之暂停，世界保留） | `action.close` |
| 时钟 | 第 N 天 HH:MM | `stat.day` |
| 计数 chip | 每个物种一枚，显示当前数量 | `species.*`、`stat.corpses` |

### 工具栏 · 生命（`tool.group.life`）

| 工具 | 放下去是什么 | locale key |
| --- | --- | --- |
| 草 | 陆地植被——草地格的生物量场，自己会长回来 | `tool.grass` |
| 水草 | 水下植被——只在水格长，鱼的口粮 | `tool.weed` |
| 树 | 一棵树实体：给周围土地加肥，慢慢播种 | `tool.tree` |
| 灌木 | 一丛灌木实体：同上，个头小 | `tool.bush` |
| 兔子 | 放一只兔子（食草，繁殖最快，生态底盘） | `species.rabbit` |
| 鹿 | 放一只鹿（食草，慢、视野广、寿命长、肉厚） | `species.deer` |
| 狐狸 | 放一只狐狸（小而快，只抓得动兔子） | `species.fox` |
| 狼 | 放一只狼（大而强，吃鹿也吃兔子，繁殖慢） | `species.wolf` |
| 乌鸦 | 放一只乌鸦（飞行，飞越水和石头，只吃遗骸） | `species.crow` |
| 小鱼 | 放一条小鱼（只能待在水里，吃水草） | `species.fish` |
| 狗鱼 | 放一条狗鱼（水里的顶级，只吃小鱼） | `species.pike` |

### 工具栏 · 地形（`tool.group.terrain`）与其它

| 工具 | 做什么 | locale key |
| --- | --- | --- |
| 水 | 挖成水格 | `tool.water` |
| 沙 | 刷成沙格 | `tool.sand` |
| 土 | 刷成土格 | `tool.dirt` |
| 石头 | 刷成岩格（陆地动物进不去） | `tool.stone` |
| 清除 | 擦掉笔刷范围内的东西 | `tool.erase` |
| 平移 | 拖动视野（不放置任何东西） | `tool.pan` |
| 笔刷 小 / 中 / 大 | 影响上面所有工具的半径（单位：格） | `brush.label`、`brush.small`、`brush.medium`、`brush.large` |

### 画布操作

| 操作 | 结果 |
| --- | --- |
| 左键点 / 拖 | 用当前工具放置；拖过的地方连续生效 |
| 右键点 / 拖 | 擦除（等价于「清除」，不用切工具） |
| 滚轮 | 整数倍缩放，1..12；默认 fit 到舞台 |
| 平移工具 + 拖动 | 移动视野 |
| 「适应窗口」 | 缩放与偏移归位 |
| 点一只生物 | 右侧显示它的详情，画布上给它描一圈 |

### 右侧观察区

| 项 | 说明 | locale key |
| --- | --- | --- |
| 物种 | 兔子 / 鹿 / 狐狸 / 狼 / 乌鸦 / 小鱼 / 狗鱼 | `species.*` |
| 年龄 | 活了多久（世界秒） | `inspect.age` |
| 能量 | 当前能量，饿了会掉到 0 | `inspect.energy` |
| 代数 | 第 {n} 代 | `inspect.generation` |
| 后代 | 已经生了 {n} 个 | `inspect.children` |
| 基因条 | 六项：速度 / 视野 / 体型 / 代谢 / 寿命 / 繁殖率 | `inspect.gene.*` |
| 跟随 / 取消跟随 | 镜头盯住这只生物 | `inspect.follow`、`inspect.unfollow` |
| 空态 | 「点一只生物，看看它的基因」 | `inspect.empty` |
| 种群曲线 | 最近 180 秒，每个物种一条线（只画有数量的） | `chart.title` |

> 动物工具的标签直接复用 `species.*`，不再有 `tool.herbivore` / `tool.carnivore` 这类单物种旧 key；
> 头部也不再有「食草 / 食肉」两个汇总计数，每个物种各一枚 chip。

## 生态机制

### 物种与食物网

| id | 中文 | 介质 | 角色 | 吃什么 | 被谁吃 |
| --- | --- | --- | --- | --- | --- |
| `rabbit` | 兔子 | 陆地 | 食草 | 草 | 狐狸、狼 |
| `deer` | 鹿 | 陆地 | 食草 | 草 | 狼 |
| `fox` | 狐狸 | 陆地 | 掠食 | 兔子 | — |
| `wolf` | 狼 | 陆地 | 掠食 | 鹿、兔子 | — |
| `crow` | 乌鸦 | 飞行 | 清道夫 | 遗骸 | — |
| `fish` | 小鱼 | 水下 | 食草 | 水草 | 狗鱼 |
| `pike` | 狗鱼 | 水下 | 掠食 | 小鱼 | — |

生产者有四种：草（陆地上逐格的生物量场）、水草（水下逐格的生物量场）、树、灌木（后两者是实体，
给周围土地加肥并慢慢播种）。

### 一圈闭环

```
草 ──→ 兔子 ──→ 狐狸
 │        └──→ 狼
 └──→ 鹿 ─────→ 狼

水草 ──→ 小鱼 ──→ 狗鱼

（一切死亡）──→ 遗骸 ──→ 乌鸦 / 狐狸 / 狼 吃
                   └──→ 腐烂 → 肥力 ↑ → 草 / 水草长得更好 ──┐
                                                          └──→ 回到最上面
```

- **谁吃谁**只由物种表里的 `prey` 决定：狐狸吃不到鹿，狗鱼只吃小鱼，乌鸦只吃尸体。
  同一个 tick 里同一具猎物不会被吃两次。
- **能量**：吃饱（能量过阈值）+ 成年 + 繁殖冷却结束 → 生崽；能量归零、或超过寿命 → 死亡。
  被吃也算死亡，走同一条路径：移除个体 + 掉一具遗骸。
- **遗骸**：腐烂过程中给周围土地加肥（水里是给水体加营养），所以「死」在这缸里是养分，不是删除。
- **介质是硬边界**：陆地物种进水或进岩会被挡住（沿着边滑），水生物种出不了水，只有乌鸦无视地形。
- **昼与夜**：1 天 = 120 秒（1× 下），画布上有昼夜明暗；**夜里草长得慢**，所以夜长的世界更容易饿死东西。
- **自动保存**：每 30 秒 + 页面卸载时写一次，key 是 `dsh-pixel-ecosystem:v1`；
  「新世界」会换种子重开一缸。

### 基因与变异

每只动物带六项基因：速度、视野、体型、代谢、寿命、繁殖率。生崽时子代继承父母的基因并
**小幅变异**（有小概率是大幅跳变），于是：
跑得快的更容易吃到东西、看得远的更容易先发现猎手、体型大的更能扛饿也更慢——
这些权衡是种群自己波动而不是数值崩盘的来源。点开任意一只生物就能看到这六条基因条。

### 平衡契约（不是对任何世界的承诺）

这是**会波动的**世界，不是稳态世界：兔子爆到 500 只、把草啃光、狐狸跟着饿死一批，属于正常剧情。
固定种子 soak（20k tick）看守的是三条底线，也是 DESIGN.md §8 的契约：

1. **不许永久灭绝**：某个物种可以跌到很低甚至归零，但会由「移民」自动补种回来
   （每 25–45 秒检查一次，低于 `minimum` 就从图外补 4–8 只），所以你回来时缸里总是有活物；
2. **每条链都得活着**：每个物种在整个 soak 里必须达到过各自的「能活的峰值」，
   证明它的食物链真的成立，而不只是数字没归零；
3. **不许失控**：任何物种都不许越过自己的 `cap`，否则一代之后会把别人全饿死。

实测（seed 777，20k tick，就是 `tests/balance.test.mjs` 每次跑出来的那行）：兔子 92..598、鹿 2..74、
狐狸 15..63、狼 3..13、乌鸦 12..79、小鱼 2..285、狗鱼 3..22；约 2300 tick/s（8× 需要 80）。
换种子数字会变，但三条底线不变——`tests/balance.test.mjs` 每次都会重新验证它们。

你自己手画的极端地形（全石头、全水、把猎手全堆在角落）里灭绝仍然是正常结果——移民只会补到
`minimum`，补不回一个被彻底破坏的生态。

## 它是怎么实现的

- **两个 slot，都是加法**：`sidebar.panellist` 注册一枚 `id: 'pixel-ecosystem'` 的图标，
  `main` 注册 `key: 'pixel-ecosystem'` 的面板。两个 id 是同一个字符串是故意的——侧边栏按钮打开的就是
  这个 key 的主面板。插入用的 `cordis.patch.yml` 只有一条 `insert`，不覆盖、不禁用任何官方行。
- **单文件 Client bundle**：`client.js` 一个文件装下引擎 + 渲染 + 面板 UI，手写浏览器模块，免构建。
  引擎是**纯函数层**（不碰 DOM、不读系统时钟，时间靠 `dt` 传进来），通过
  `module.exports.__engine` 导出，Node 里能直接跑几万 tick 做测试；这和「单文件 client」的仓库约定不冲突。
- **渲染**：`<canvas width=W height=H>`，CSS 尺寸 = `W × scale`（scale 是 1..12 的整数），
  配 `image-rendering: pixelated`——世界分辨率就是像素分辨率，1 格 = 1 个源像素，放大不糊。
  昼夜明暗是 `putImageData` 之后叠的一层半透明色。`requestAnimationFrame` 循环只在面板挂载时跑
  （`attach` / `detach`），面板不在就停，不烧 CPU。React 只订阅大约 2Hz 的统计快照，
  画布更新不走 React。
- **持久化**：`localStorage`，key `dsh-pixel-ecosystem:v1`，每 30 秒 + `beforeunload` 写一次；
  读档失败（版本不符 / 坏数据）静默丢弃，开一缸新的。
- **没有 Host 代码，这是有意的**：`index.js` 的 `apply()` 是空的，不注册 service、不注册投影、
  不注册工具、不起定时器。理由有两条——浏览器里的 rAF 循环没法被 Host 驱动；游戏的存档
  **不该折进 Session 日志**（世界状态不是会话真相，重放/分叉/fork 都不该带上它）。
  Host 半存在的唯一意义是让 bundle 有一行可以挂，让插件管理页能把它显示成一枚正常插件。
- 面板文字全部走 locale，颜色只用 `--dsw-alias-*` token（像素画布内部除外，那是美术）。

```js
// Client 的注入与两个席位（形状与 DESIGN.md §6.3 一致）
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'pixel-ecosystem', order: 20, label: () => t('panel.title') }, PanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'pixel-ecosystem' }, props => h(Panel, { ...props, store, locale })))
```

## 结构

```
dsh-plugin-pixel-ecosystem/
├── package.json         # dsh.bundle（profile 补丁）+ dsh.client（web 平台）+ 导出元数据
├── cordis.patch.yml     # 插入 pixel-ecosystem 行（不改动任何官方行）
├── index.js             # Host：空 apply，只为让 bundle 有一行可挂
├── client.js            # Client：引擎（__engine）+ 渲染 + 面板 UI，单文件免构建
├── DESIGN.md            # 设计稿与接口契约：引擎 API、物种表、locale key、调参目标
├── locale/{en,zh}.json  # 插件管理器里的标题 / 描述（只有 meta.*）
├── icon.svg             # 32×32 像素画图标
└── tests/               # node --test：引擎 / 渲染 / 平衡 / client boot
```

Host 半零运行时依赖；Client 半不引第三方运行时依赖，面板 UI 只用浏览器模块表里的 `react`。

## 测试

纯逻辑（不需要 dsh，也不需要浏览器）：

```sh
cd dsh-plugin-pixel-ecosystem
node --check client.js && node --check index.js
node --test tests/*.test.mjs
```

| 套件 | 覆盖什么 |
| --- | --- |
| `tests/engine.test.mjs` | 地形生成确定性（同种子同结果）、放置工具语义、介质边界（鱼出水 / 兔入水被挡）、死亡掉遗骸、繁殖带变异、捕食矩阵（狐狸不吃鹿、狗鱼只吃鱼、乌鸦只吃尸）、序列化往返、`dt` 夹取 |
| `tests/render.test.mjs` | `paintWorld` 尺寸与像素格式、精灵出界裁剪、同 `tick` 幂等、水与陆地颜色不同、水草可见 |
| `tests/balance.test.mjs` | 固定种子 soak 20k tick，对照调参目标带（`DESIGN.md` §8），断言核心几条链不归零 |
| `tests/client.test.mjs` | VM 里 boot bundle：`inject` 正确、两个 slot 的 id/key 正确、zh/en 字典 key 完全对齐、CSS 类名都有 `pe-` 前缀、组件能渲染出标题与计数 |

装进真实 dsh 看一眼（走 `rc-dev`，**不要**用 desktop profile）：

```powershell
pwsh -File tools\dev-dsh.ps1 rc-dev -Update                 # 先把 rc-dev 更新到 rc 通道最新版
pwsh -File tools\dev-dsh.ps1 rc-dev -Plugin add "link:D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem"
pwsh -File tools\dev-dsh.ps1 rc-dev --dump-config           # 组合检查：确认 pixel-ecosystem 行是激活的
pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0      # 启动冒烟
```

最后一步会打印一个带一次性 `?token=` 的地址，**视觉确认由你自己打开那个地址完成**：
点侧边栏的像素图标 → 主面板应该出现一缸在跑的世界。这一步（以及 `--dump-config` 的装配结果）
本仓库没有替你做，所以本文不声称做过视觉验证。

## 已知限制

- **0.1.0 还没发布到 npm**，现在只能 `link:` 或 git 直装；伞包 `tofu-box` 1.3.0 起才把它列进依赖。
- 只声明了 `platform: web`：浏览器里的视觉确认还没做（见上面「测试」）；桌面端（Electron）、Linux / macOS 都没有验证过。
- 世界只活在**当前浏览器的 localStorage** 里：换浏览器、清站点数据、换 profile 就是新世界；
  它也不进 Session 日志，所以没有跨设备/跨会话同步，也没有「存档分享」。
- 硬上限：动物 1200、树 460、遗骸 260。到顶只禁止新增，不杀已经存在的个体。
- 引擎按 200 × 130 = 26000 格设计并调参；更大的世界没调过，掉帧或生态崩掉都正常。
- 平衡靠固定种子 soak 看守；极端地形里灭绝是允许发生的结果（见上面「调参目标」）。
- 坏档静默丢弃：`version` 不符或数据坏了就直接开新世界，不会告诉你丢了什么。
- v0.1 明确不做：联网、多人、存档分享、Host 端工具、文明/建筑、天气、音效。
- 插件由 AI 实现，肯定还有没抓出来的 bug。

## 路线图

- **v0.2 交互**：画刷预设（撒一把兔子 / 一片森林 / 一场雨）、时间回溯（环形快照）、天气。
- **v0.3 生态深度**：更多物种（水獭 / 鹰 / 甲虫）、疾病、迁徙、领地。
- **v0.4 文明雏形**：小人（采集 → 农耕）、资源点、简易建造与繁衍、部落之间的冲突。
  这一步会给引擎加 `civilizations` 段与网格寻路——「文明 / 社会」是后期的方向，不是 0.1 的内容。
- **长期**：让 Agent 也能碰这个世界（Host 工具 `terrarium_seed` / `terrarium_observe`），
  等结果时不只是你在看，模型也能往缸里放东西。

## License

MIT
