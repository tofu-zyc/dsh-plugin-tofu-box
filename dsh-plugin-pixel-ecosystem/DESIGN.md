# 像素生态缸（Pixel Terrarium）设计稿

> 目标：AI 干活、你等结果的那几分钟里，有个能随手玩两下的东西。
> 侧边栏点一下图标，主面板就是一缸活着的像素生态：撒草、放兔子、放狼，
> 看它们长、吃、追、生、死。后期往「文明 / 社会」方向长。

状态：v0.1 设计 + 实现基线。本文是插件的**接口契约**：引擎 API、物种表、
locale key、slot 用法、调参常量都以这里为准。

---

## 1. 为什么是这个形态

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 入口 | 侧边栏图标（`sidebar.panellist`）+ 主面板（`main` keyed slot） | 主面板是整块画布，能玩；点侧边栏图标进来，点会话回对话。不做 iframe（拿不到主题 token） |
| 模拟跑在哪 | 浏览器端，纯 JS、无 Host RPC | 60fps 渲染要本地做；世界只有一份，不需要跨端同步 |
| 引擎在哪 | 同一个 `client.js` 里的纯函数层，`module.exports.__engine` 导出给测试 | 仓库约定是单文件 client bundle；纯函数层可以用 Node 直接跑几万 tick |
| 持久化 | `localStorage`（`dsh-pixel-ecosystem:v1`） | 关页面再回来还在；游戏状态不进 Session 日志 |
| 地形 | 2D 格子 + 程序化生成（value noise，百分位定海平面） | 免美术资源，同种子可复现，测试可断言 |
| 生产者 | 草（陆地）/ 水草（水下）各一张逐格生物量场；树 / 灌木是实体 | 几十万格必须紧凑；植物实体数量小 |
| 消费者 | 物种表驱动的实体数组，**不是**硬编码的兔子/狐狸 | 加物种 = 加一行 `SPECIES` + 一张精灵，不动逻辑 |
| 画风 | 世界分辨率 = 像素分辨率（1 格 = 1 源像素），CSS `image-rendering: pixelated` 放大 | 便宜、真像素、缩放不糊 |

非目标（v0.1）：联网、多人、存档分享、Host 端工具、文明/建筑、天气、音效。

---

## 2. 物种与食物网

**一开始就是完整食物网**：物种少的时候，一条链的阈值非常窄，草-兔-狐三人转很容易
一会儿全灭一会儿爆炸；物种多了能量有绕路，容错空间大得多。

| id | 中文 | 介质 | 角色 | 吃什么 | 被谁吃 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `rabbit` | 兔子 | 陆地 | 食草 | 草 | 狐狸、狼 | 繁殖最快，是生态的底盘 |
| `deer` | 鹿 | 陆地 | 食草 / 啃叶 | 草、树和灌木的叶子 | 狼 | 慢、视野广、寿命长、肉质厚；草被吃光时改啃树叶，这是它和兔子分食的关键 |
| `fox` | 狐狸 | 陆地 | 掠食 | 兔子 | — | 小而快，只抓得动兔子；有领地，附近同类多时不繁殖 |
| `wolf` | 狼 | 陆地 | 掠食 | 鹿（优先）、兔子 | — | 大而强，繁殖慢，数量少；优先追鹿，视野里没有鹿才回头抓兔子 |
| `crow` | 乌鸦 | 飞行 | 清道夫 | 遗骸 | — | 飞越水和石头，专吃尸体 |
| `fish` | 小鱼 | 水下 | 食草 | 水草 | 狗鱼 | 只能在水中活动 |
| `pike` | 狗鱼 | 水下 | 掠食 | 小鱼 | — | 水域的顶级 |

### 2.1 现实参数与压缩规则

v0.1 的参数是照着现实生态数据定的，不是拍脑袋。**压缩是显式的**，写在下面，方便核查：

**时间压缩**：1 个游戏日 = 1 个生态年。于是「每年 1 胎」= 冷却 120 秒，「3 个月性成熟」= 36 秒。
**距离/速度压缩**：1 格 ≈ 1 米，但速度按 `SPEED_SCALE ≈ 0.35` 缩放——真实兔子冲刺 45 km/h
（12.5 m/s）在 320 格宽的地图上会 25 秒横穿，没法看；压到 4.4 格/秒后，身长与位移的比例
（每秒约 1–1.5 个身长）才是肉眼正常的。

| 物种 | 现实数据 | 来源 | 在模拟里的体现 |
| --- | --- | --- | --- |
| 兔子 | 兔穴群居（可达 30 只）、冲刺 ~45 km/h、3–4 月龄性成熟、每窝 4–12 只、一年多胎、野外寿命 1–3 年、晨昏活动 | [Scottish Wildlife Trust](https://scottishwildlifetrust.org.uk/species/rabbit-european/) | 群居（herd radius 18 + 警报传染）、litter 4–7、成熟 36 s、寿命 140–240 s、晨昏活跃度 1.0 / 中午 0.45 |
| 赤狐 | 冲刺 ~72 km/h、每年 1 胎 1–12 只（常见 5–6）、孕期 ~52 天、10 月龄性成熟、野生寿命 3–10 年、领域性 | [Provancher](https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf)、[赤狐](https://baike.baidu.com/item/%E8%B5%A4%E7%8B%90-150/14434730) | 一年 1 胎（冷却 110–130 s）、litter 3–6、成熟 96 s、寿命 300–420 s、领地密度上限 |
| 狼 | 群 2–15 只（繁殖对 + 后代）、冲刺 ~60 km/h 但以 10 km/h 长途追踪、每年 1 胎 4–7 只、孕期 63 天、2–3 岁性成熟、野生寿命 6–8 年、领地 100–1000 km² | [US FWS](https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf) | 群巡（pack roam）、优先捕鹿、一年 1 胎（litter 3–5）、成熟 240 s、寿命 700–900 s |
| 狗鱼 | 伏击型，突进 10–15 ft/s（3–4.6 m/s）而非长距离追击、2–3 岁性成熟、寿命 7–15 年 | [US FWS](https://www.fws.gov/sites/default/files/documents/northern-pike.pdf) | `ambush` 行为：平时以 0.45× 速度缓慢接近，进入 7 格才以 1.9× 突进；一年 1 胎 |
| 乌鸦 | 长寿、2–3 岁繁殖、群栖、食腐与杂食、白天活动 | 通用资料（未逐条取源，标注为"待补源"） | 翼展群的 flock、只吃遗骸、夜间活跃度 0.15 |
| 鹿 | 群居（母鹿群）、1.5 岁性成熟、一年 1 胎（1–2 只）、寿命 10–15 年、晨昏觅食、草+树叶 | 通用资料（待补源） | herd 26、litter 1–2、成熟 180 s、寿命 1100–1600 s、可啃树叶 |

**还没对齐现实的地方（诚实清单）**：鹿与乌鸦的数值来自常识而非逐条引源；没有季节性繁殖窗口、
没有雌雄差异、没有幼体依赖期（幼崽出生即独立觅食）、没有疾病/寄生虫；鱼类用"每年产卵"简化成
一次 4–8 尾；狼群的协同围猎只是"朝同一目标靠近"，没有真正的包抄与轮换。


### 2.2 需求 · 决策 · 成长（v0.2 骨架）

这是后面接社会/文明的地基：行为不再是 if 链，而是**需求驱动 + 效用打分**，动物的"意图"是显式字段。

**需求通道**（0 = 满足，1 = 临界）：`hunger` `thirst` `energy` `safety` `social`。
增长速率 = 基础速率 × 新陈代谢基因 × 生命阶段食量；夜间体力消耗 ×1.7。安全需求只在看见捕食者时被顶起来，平时缓慢衰减。

**决策**：每 0.22–0.55 秒做一次，对所有候选行动打分：

```
score(行动) = 需求权重[角色][需求] × (需求强度 + 偏移) × 性格修正 − 距离成本(上限 0.45)
```

取最高分写入 `entity.intent`，同时给出 `targetX/targetY`。距离是**成本不是门槛**——远处的食物仍然胜过饿死。

| 候选行动 | 触发需求 | 说明 |
| --- | --- | --- |
| `flee` | safety | 看见捕食者时权重压倒一切，并触发群体警报传染 |
| `forage` | hunger | 走到草/水草格；鹿还能啃树冠 |
| `hunt` | hunger | 视野内有猎物时 ×1.7 权重， predator 会真的扑上去 |
| `scavenge` | hunger | 食腐者（乌鸦）只认尸体 |
| `drink` | thirst | 走到最近的水格旁补水 |
| `rest` | energy | 原地停下；饥饿 > 0.62 时不再考虑休息 |
| `socialize` | social | 朝群体质心靠拢，但饥饿 > 0.65 时优先觅食 |
| `explore` | 性格 curious | 需求都满足时才闲逛 |

**性格**（`traits`，物种可覆盖角色默认）：`bold` 胆量（决定多近才逃）、`social` 群体性、`curious` 探索欲、`territorial` 领地性。

**生命阶段**：`juvenile` / `adult` / `elder`，由年龄对物种成熟期/老年期切分：

| 阶段 | 体型 | 速度 | 食量 | 能否繁殖 |
| --- | --- | --- | --- | --- |
| 幼崽 | 0.60 | 0.78 | 1.30 | 否 |
| 成年 | 1.00 | 1.00 | 1.00 | 是 |
| 老年 | 1.03 | 0.82 | 0.85 | 是 |

**加一个物种需要什么**：一条 `SPECIES` 行（栖息地、role、食物、天敌、参数）+ 精灵图集槽位。决策、需求、成长、详情卡会自动接管，不需要改任何行为代码。

**给社会层的接口**：`entity.intent`（当前意图）、`entity.needs`（五通道）、`entity.stage`（阶段）、`entity.genes`（可遗传）、`entity.generation` / `children`（谱系）。后续的聚落、分工、战争都可以读这些字段，而不必重新发明一套状态机。生产者：草（陆地逐格）、水草（水下逐格）、树、灌木（实体，给周围土地加肥、慢慢播种）。

能量流：草 → {兔, 鹿}；水草 → 鱼；兔 → {狐, 狼}；鹿 → 狼；鱼 → 狗鱼；一切死亡 → 遗骸 →
{乌鸦, 狐狸, 狼} → 腐烂回肥力 → 草/水草长得更好。闭环。

---

## 3. 玩法

- **世界**：默认 200 × 130 格。地形 `water / sand / dirt / grass / stone`，~17% 水、~4.5% 岩。
- **放置**：工具栏选工具，左键点/拖，右键擦除。工具分两组——
  生命：草、水草、树、灌木、兔子、鹿、狐狸、狼、乌鸦、鱼、狗鱼；
  地形：水、沙、土、石头、清除；外加平移。
- **看**：滚轮缩放（整数倍 1..12），平移工具拖动，`适应窗口` 归位。
- **观察**：点一只生物 → 右侧显示年龄、能量、代数、后代数、六项基因条；`跟随` 让镜头盯住它。
- **时间**：暂停 / 1× / 2× / 4× / 8×；1 天 = 120 秒（1×），有昼夜明暗，夜里草长得慢。
- **死亡**：饿死、老死、被吃，统一留遗骸；遗骸腐烂给周围加肥，乌鸦/掠食者会来吃。
- **繁衍**：能量过阈值 + 成年 + 冷却结束 → 生崽，基因小幅变异（5% 概率大幅）。
- **自动保存**：每 30s + 页面卸载写 localStorage；`新世界` 换随机种子重开。

---

## 4. 数据模型（`World`）

```js
World = {
  version: 1,
  seed, width, height,     // 默认 200 × 130
  tick, time,              // tick 固定 0.1s；time 秒
  rngState,                // 32-bit LCG，序列化后继续可复现
  terrain: Uint8Array,     // 0 water, 1 sand, 2 dirt, 3 grass, 4 stone
  fertility: Float32Array, // 陆地肥力 0..1
  moisture: Float32Array,  // 陆地水分 0..1
  waterFertility: Float32Array, // 水域营养 0..1（决定水草长势）
  grass: Float32Array,     // 陆地植被生物量 0..1
  weed: Float32Array,      // 水下植被生物量 0..1
  trees: Tree[],           // { id, x, y, variant:'tree'|'bush', size, age, seedTimer }
  entities: Entity[],
  corpses: Corpse[],       // { id, x, y, species, decay, energy }
  nextId, stats, history,  // history: 每秒 { t, counts:{species: n} }
}
Entity = {
  id, species,             // species 是 SPECIES 的 key
  x, y, heading,           // 浮点格坐标 + 朝向弧度
  energy, age, generation, cooldown, thinkTimer,
  targetX, targetY, fleeing, fate, children, phase,
  genes: { speed, vision, size, metabolism, lifespan, fertility },
}
```

`SPECIES[id]`：`{ habitat: 'land'|'water'|'air', role: 'grazer'|'hunter'|'scavenger',
flora: 'grass'|'weed'|null, prey: string[], meat: number, color, genes: 区间, balance: 常量 }`。
派生表 `PREDATORS_OF[id]` / `PREY_OF[id]` 在模块初始化时算一次。

---

## 5. 引擎 API（`module.exports.__engine`）

同步纯函数 / 原地修改，不碰 DOM、不读时钟；Node 里可直接跑。

```js
SPECIES, SPECIES_IDS, TERRAIN, GENE_KEYS, TUNING
createWorld({ seed?, width?, height?, stocks?, trees?, immigration? }) -> World
stepWorld(world, dt) -> void                                // dt 夹到 0.5，<=0/NaN 忽略
place(world, tool, cx, cy, radius) -> void                  // 工具见 §3
spawnEntity(world, speciesId, x, y, genes?, generation?) -> Entity|null
sampleStats(world) -> { day, clock, grass, weed, counts:{...}, corpses }
pushHistory(world) -> void
serializeWorld(world) -> object
deserializeWorld(object) -> World                           // 版本不符/坏数据抛错
findEntityAt(world, x, y, radius?) -> Entity|undefined
paintWorld(world, pixels?) -> Uint32Array                    // W*H，ARGB little-endian
SPRITES, PALETTE
```

### 5.1 `paintWorld` 契约

- `pixels` 省略时新建 `Uint32Array(w*h)`；像素格式 little-endian `0xAABBGGRR`。
- 顺序：地形 → 水波 → 陆地植被底色 → 水草 → 树/灌木 → 遗骸 → 动物（按 y 排序，近的盖远的）。
- 出土精灵裁剪，不抛错；同一 `world.tick` 下两次调用结果一致。

### 5.2 `stepWorld` 保证

- 死亡只有一条路径：`energy <= 0 || age > lifespan`（含被标记 `fate === 'eaten'`）→ 移除 + 掉遗骸。
- 动物上限：全局 MAX_ENTITIES（2400）+ 每物种 cap；达到上限只禁止新增，不杀已有个体。树 460、遗骸 260。
- 草只长在 `GRASS` 格、水草只长在 `WATER` 格；非对应地形清 0。
- 移动按介质判定：陆地物种进水/岩被挡，水生物种出水被挡，飞行物种无视地形。
- 猎手只在 `prey` 列表内捕食（列表有序 = 偏好顺序，狼因此先追鹿）；同 tick 内同一猎物不会被吃两次。
- 领地：声明了 `territory = { radius, max }` 的物种，附近同类达到 `max` 时不再繁殖——掠食者密度由领地而不是硬上限决定。
- 移民：每 `TUNING.immigration` 秒检查一次，任何物种低于 `minimum` 就从图外补 4..8 只。这是安全网：没有它，一次坏运气可能让世界永远变成死水。可用 `createWorld({ immigration: false })` 关掉（玩家自己清空某个物种时不该被塞回来）。

---

## 6. 渲染与 UI

### 6.1 主面板

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⬡ 像素生态缸  第 3 天 14:20  ●兔128 ●鹿44 ●狐9 ●狼2 ●鱼90 ●狗鱼3  │ 头部
│                              ⏸ 1× 2× 4× 8× · 新世界 · 玩法 · 回到对话 │
├────────────────────────────────────────┬─────────────────────────────┤
│                                        │ 生命工具 / 地形工具（网格）   │
│           像素画布（整数缩放）           │ 笔刷 小/中/大                │
│                                        │ 种群曲线（多色折线）          │
│                                        │ 选中生物基因条 / 提示          │
└────────────────────────────────────────┴─────────────────────────────┘
```

- 画布 `<canvas width=W height=H>`，CSS 尺寸 = `W*scale × H*scale`（scale 整数 1..12），
  默认 fit 舞台；容器窄于 780px 时右栏折到下面。
- 昼夜：`putImageData` 后在 canvas 上叠半透明色（夜偏蓝、晨昏偏橙）。
- 光标：画 1px 笔刷框；选中生物画一圈高亮。
- 曲线：小 canvas 220×64，每物种一条线（只画有数量的），最近 180 秒。
- 颜色只用 `--dsw-alias-*` token（像素画布内部除外，那是美术）。

### 6.2 生命周期

- 一个 `Store` 在插件 `apply` 闭包里创建，懒初始化世界；`apply` 卸载时清理。
- `attach(canvas)` / `detach()`：面板挂载时接画布，rAF 循环 `stepWorld` + 重绘；
  面板不在时循环停止（不烧 CPU）。React 只订阅 ~2Hz 的统计快照。
- 存档：`localStorage` key `dsh-pixel-ecosystem:v1`，`beforeunload` + 每 30s；坏档静默丢弃。

### 6.3 注册的两个 slot

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'pixel-ecosystem', order: 20,
    label: () => bindNs()('panel.title') }, PanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'pixel-ecosystem' },
  props => h(Panel, { ...props, store, locale, layout: ctx.get('layout') })))
```

`ctx.layout.selectPanel('conversation')` 用于「回到对话」。Client `inject`:
`['slots','locale']`（layout 用 `ctx.get` 软取）。`dsh.client.inject`: layout + sidebar。

---

## 7. Locale key 表（namespace = 包名）

| key | zh | en |
| --- | --- | --- |
| `panel.title` | 像素生态缸 | Pixel terrarium |
| `action.back` | 回到对话 | Back to chat |
| `action.play` / `action.pause` | 继续 / 暂停 | Resume / Pause |
| `action.newWorld` / `action.newWorldConfirm` | 新世界 / 再点一次确认 | New world / Click again to confirm |
| `action.help` / `action.close` / `action.fit` | 玩法 / 关闭 / 适应窗口 | How to play / Close / Fit view |
| `speed.paused` / `speed.1` / `speed.2` / `speed.4` / `speed.8` | 暂停 / 1× / 2× / 4× / 8× | Paused / 1× / 2× / 4× / 8× |
| `stat.day` | 第 {day} 天 | Day {day} |
| `stat.corpses` | 遗骸 | Remains |
| `species.rabbit` `species.deer` `species.fox` `species.wolf` `species.crow` `species.fish` `species.pike` | 兔子 鹿 狐狸 狼 乌鸦 小鱼 狗鱼 | Rabbit Deer Fox Wolf Crow Fish Pike |
| `tool.grass` / `tool.weed` / `tool.tree` / `tool.bush` | 草 / 水草 / 树 / 灌木 | Grass / Weed / Tree / Shrub |
| `tool.water` / `tool.sand` / `tool.dirt` / `tool.stone` / `tool.erase` / `tool.pan` | 水 / 沙 / 土 / 石头 / 清除 / 平移 | Water / Sand / Soil / Stone / Erase / Pan |
| `tool.group.life` / `tool.group.terrain` | 生命 / 地形 | Life / Terrain |
| `brush.label` / `brush.small` / `brush.medium` / `brush.large` | 笔刷 / 小 / 中 / 大 | Brush / S / M / L |
| `chart.title` | 种群变化 | Populations |
| `inspect.empty` | 点一只生物，看看它的基因 | Click a creature to read its genes |
| `inspect.age` / `inspect.energy` / `inspect.generation` / `inspect.children` | 年龄 / 能量 / 第 {n} 代 / 后代 {n} | Age / Energy / Gen {n} / Offspring {n} |
| `inspect.gene.speed` / `.vision` / `.size` / `.metabolism` / `.lifespan` | 速度 / 视野 / 体型 / 代谢 / 寿命 | Speed / Vision / Size / Metabolism / Lifespan |
| `inspect.follow` / `inspect.unfollow` | 跟随 / 取消跟随 | Follow / Unfollow |
| `help.title` / `help.1` … `help.6` | 见实现 | 见实现 |

`locale/en.json` / `locale/zh.json` 只放插件管理页用的 `meta.title` / `meta.description`。

---

## 8. 测试

1. `node --check client.js`。
2. `tests/engine.test.mjs`：地形确定性、放置语义、介质边界（鱼出水/兔入水被挡）、死亡掉遗骸、
   繁殖带变异、捕食矩阵（狐狸不吃鹿、狗鱼只吃鱼、乌鸦只吃尸）、序列化往返、dt 夹取。
3. `tests/render.test.mjs`：尺寸/像素格式/精灵裁剪/同 tick 幂等/水与草颜色不同/水草可见。
4. `tests/balance.test.mjs`：固定种子 soak 20k tick，看守三条底线（**不是稳态承诺**）——
   ① 不许永久灭绝：任何物种读数为 0 的检查点 ≤ 2 个，且 soak 结束时都 > 0（移民会补种）；
   ② 每条链都活着：每个物种必须达到过自己的「能活峰值」（兔 120 / 鹿 40 / 狐 15 / 狼 5 /
   乌鸦 20 / 鱼 60 / 狗鱼 5）；③ 不许失控：任何物种不许越过自己的 `cap`。
   另有草/水草覆盖 > 各自地形 3% 与吞吐 > 80 tick/s（8× 的预算）。
   实测（seed 777，20k tick）：兔 92..598、鹿 2..74、狐 15..63、狼 3..13、乌鸦 12..79、
   鱼 2..285、狗鱼 3..22；约 2300 tick/s，8× 有 28 倍余量。换种子数字会漂移，三条底线不漂。
   早期版本曾用窄带（兔 40..800）断言，但那是「被咬的猎物不死」这个 bug 造成的假稳态；
   现在捕食真的生效了，种群就是会大幅波动——契约因此改成上面三条。
5. `tests/client.test.mjs`：VM boot → `inject` 正确、两个 slot 注册 id/key 正确、
   zh/en 字典 key 完全对齐、CSS 类名都有 `pe-` 前缀、组件渲染出标题与计数。
6. 装进 `rc-dev`：`--dump-config` 确认行激活；起服务把 URL 交给用户自己开（视觉确认）。

---

## 9. 路线图

- **v0.2 交互**：画刷预设（撒一把兔子 / 一片森林 / 一场雨）、时间回溯（环形快照）、天气。
- **v0.3 生态深度**：更多物种（水獭 / 鹰 / 甲虫）、疾病、迁徙、领地。
- **v0.4 文明雏形**：小人（采集 → 农耕）、资源点、简易建造与繁衍、部落冲突。
  引擎要加 `civilizations` 段与网格寻路。
- **长期**：让 Agent 也能碰这个世界（Host 工具 `terrarium_seed` / `terrarium_observe`）。
