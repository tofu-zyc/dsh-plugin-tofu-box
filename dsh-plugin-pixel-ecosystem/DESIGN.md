# 像素生态缸（Pixel Terrarium）设计稿

> 目标：AI 干活、你等结果的那几分钟里，有个能随手玩两下的东西。
> 侧边栏点一下图标，主面板就是一缸活着的像素生态：撒草、放兔子、放狼，
> 看它们长、吃、追、生、死。后期往「文明 / 社会」方向长。

状态：**v0.2.1 设计 + 实现基线**。本文是插件的**接口契约**：引擎 API、物种表、
图集几何、locale key、slot 用法、调参常量都以这里为准。玩法说明见 [README.md](README.md)，
交接状态与缺陷清单见 [HANDOVER.md](HANDOVER.md)。

---

## 1. 为什么是这个形态

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 入口 | 侧边栏图标（`sidebar.panellist`）+ 主面板（`main` keyed slot） | 主面板是整块画布，能玩；点侧边栏图标进来，点会话回对话。不做 iframe（拿不到主题 token） |
| 模拟跑在哪 | 浏览器端，纯 JS、无 Host RPC | 60fps 渲染要本地做；世界只有一份，不需要跨端同步 |
| 引擎在哪 | 同一个 `client.js` 里的纯函数层，`module.exports.__engine` 导出给测试 | 仓库约定是单文件 client bundle；纯函数层可以用 Node 直接跑几万 tick |
| 持久化 | `localStorage`（`dsh-pixel-ecosystem:v1`） | 关页面再回来还在；游戏状态不进 Session 日志 |
| 地形 | 2D 格子 + 程序化生成（value noise，百分位定海平面，只留最大水体） | 免美术资源，同种子可复现，测试可断言 |
| 生产者 | 草（陆地）/ 水草（水下）各一张逐格生物量场；树/灌木/睡莲/芦苇是实体 | 二十万格必须紧凑（1 字节/格存档）；植物实体数量小 |
| 消费者 | 物种表驱动的实体数组，**不是**硬编码的兔子/狐狸 | 加物种 = 加一行 `SPECIES` + 一组图集帧，不动行为代码 |
| 美术 | 代码生成的像素图集（`assets/atlas.png` → base64 内嵌） | 免手绘素材、可 diff、可回归测试；单文件发布 |
| 画风 | 地面 1 格 = 1 源像素 + 最近邻放大；动物从图集按**显示分辨率**画 | 地面全分辨率渲染跑不动（512×400×6² ≈ 740 万像素/帧），动物必须清晰 |
| 世界尺寸 | 512 × 400 格（`createWorld` 每边夹到 ≤ 512） | 一屏能看完一条湖岸；靠**视口渲染**（只画可见格）控制成本 |

非目标：联网、多人、存档分享、Host 端工具、文明/建筑、天气、音效。

---

## 2. 物种与食物网

**一开始就是完整食物网**：物种少的时候，一条链的阈值非常窄，草-兔-狐三人转很容易
一会儿全灭一会儿爆炸；物种多了能量有绕路，容错空间大得多。v0.2.0 又补上了
**跨水陆的那条边**（`wade` / `amphibious`）——在那之前湖是一个陆地动物够不到的闭环。

| id | 中文 | 介质 | 角色 | 吃什么 | 被谁吃 | `meat` | `cap` | `minimum` | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rabbit` | 兔子 | 陆地 | 食草 | 草 | 狐狸、狼、棕熊 | 18 | 620 | 40 | 繁殖最快；`flight` 冲刺后会疲劳 |
| `deer` | 鹿 | 陆地 | 食草 | 草、树叶 | 狼、棕熊 | 45 | 260 | 22 | `browse`：草地吃光后啃树冠 |
| `fox` | 狐狸 | 陆地 | 掠食 | 兔子 | — | 55 | 170 | 12 | 小而快，只抓得动兔子；领地 `{12, 2}` |
| `wolf` | 狼 | 陆地 | 掠食 | 鹿（优先）、兔子 | — | 80 | 90 | 6 | `prey` 有序；领地 `{19, 1}` |
| `crow` | 乌鸦 | 飞行 | 清道夫 | 遗骸 | — | 20 | 220 | 16 | 无视地形；夜间活跃度 0.15 |
| `fish` | 小鱼 | 水下 | 食草 | 水草 | 狗鱼、苍鹭、水獭、棕熊 | 20 | 520 | 55 | 只能在水里 |
| `pike` | 狗鱼 | 水下 | 掠食 | 小鱼、青蛙 | — | 60 | 70 | 6 | `ambush`：0.45×接近，7 格内 1.9×突进 |
| `heron` | 苍鹭 | 陆地（可涉浅水） | 掠食 | 小鱼、青蛙 | — | 34 | 60 | 6 | `wade`；`catchRadius` 2.4（最大） |
| `otter` | 水獭 | 水下（可上岸） | 掠食 | 小鱼、青蛙 | — | 30 | 70 | 7 | `amphibious`；`huntSpeed` 1.15（最快） |
| `bear` | 棕熊 | 陆地（可涉浅水） | 掠食 | 鹿、小鱼、兔子 | — | 120 | 40 | 3 | `wade`；`meat` 最高，繁殖最慢 |
| `frog` | 青蛙 | 陆地（可涉浅水） | 食草 | 水草 | 狗鱼、苍鹭、水獭 | 7 | 420 | 30 | `wade`；个头最小、肉最少、产卵最多 |

字段语义（就是 `client.js` 里 `SPECIES` 一行的键）：

| 键 | 含义 |
| --- | --- |
| `habitat` | `land` / `water` / `air`，决定 `canStand` 的基础同余 |
| `role` | `grazer` / `hunter` / `scavenger`，决定 `NEED_WEIGHT`、`ROLE_TRAITS` 默认性格与寻路分支 |
| `flora` | 食草者吃哪张场：`'grass'` / `'weed'` |
| `prey` | 掠食者的猎物列表，**有序 = 偏好顺序** |
| `wade` | `true` 时允许站在 `depth < 0.34` 的浅水里（涉水速度 ×0.62） |
| `amphibious` | `true` 时水生物种可以上岸（非岩石），岸上速度 ×0.72 |
| `huntReach` | 掠食者搜寻半径倍数，默认 **2.6**（视野 × 这个值就是嗅觉距离） |
| `browse` | 食草者可啃树冠 |
| `ambush` | `{ approach, strikeDistance, strikeSpeed, cooldown }`，伏击型掠食者 |
| `flight` | `{ burst, burstSeconds, tired }`，被追时的爆发速度与疲劳速度 |
| `activity` | `{ dawn, day, dusk, night }` 四段移动倍率 |
| `herd` | `{ radius, separation, alarmRadius }`，群聚与警报传染 |
| `territory` | `{ radius, max }`，附近同类达到 `max` 就停止繁殖（密度由领地决定，不是硬上限） |
| `genes` | 六项基因的变异区间 |
| `balance` | `startEnergy/maxEnergy/drain/breedEnergy/breedCost/maturity/litter` + 该角色专属项 |

### 2.1 现实参数与压缩规则

参数照着现实生态数据定，**压缩是显式的**，写在下面方便核查：

**时间压缩**：1 个游戏日 = 1 个生态年。于是「每年 1 胎」= 冷却 120 秒，「3 个月性成熟」= 36 秒。
**距离/速度压缩**：1 格 ≈ 1 米，但速度按 ~1/3 缩放——真实兔子冲刺 45 km/h（12.5 m/s）
会几秒横穿地图；压到 2.6–4.3 格/秒后，身长与位移的比例才是肉眼正常的。

| 物种 | 现实数据 | 来源 | 在模拟里的体现 |
| --- | --- | --- | --- |
| 兔子 | 兔穴群居（可达 30 只）、冲刺 ~45 km/h、3–4 月龄性成熟、每窝 4–12 只、一年多胎、野外寿命 1–3 年、晨昏活动 | [Scottish Wildlife Trust](https://scottishwildlifetrust.org.uk/species/rabbit-european/) | herd radius 18 + 警报传染、litter 4–7、成熟 36 s、寿命 140–240 s、晨昏 1.0 / 中午 0.45 |
| 赤狐 | 冲刺 ~72 km/h、每年 1 胎 1–12 只（常见 5–6）、孕期 ~52 天、10 月龄性成熟、野生寿命 3–10 年、领域性 | [Provancher](https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf)、[赤狐](https://baike.baidu.com/item/%E8%B5%A4%E7%8B%90-150/14434730) | 一年 1 胎（冷却 110–130 s）、litter 3–6、成熟 96 s、寿命 300–420 s、领地 `{12, 2}` |
| 狼 | 群 2–15 只、冲刺 ~60 km/h 但以 10 km/h 长途追踪、每年 1 胎 4–7 只、孕期 63 天、2–3 岁性成熟、野生寿命 6–8 年 | [US FWS](https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf) | 群巡、优先捕鹿、litter 3–5、成熟 240 s、寿命 700–900 s、领地 `{19, 1}` |
| 狗鱼 | 伏击型，突进 10–15 ft/s（3–4.6 m/s）而非长距离追击、2–3 岁性成熟、寿命 7–15 年 | [US FWS](https://www.fws.gov/sites/default/files/documents/northern-pike.pdf) | `ambush`：0.45× 接近，7 格内 1.9× 突进；一年 1 胎 |
| 乌鸦 | 长寿、2–3 岁繁殖、群栖、食腐与杂食、白天活动 | 通用资料（未逐条取源） | flock 22、只吃遗骸、夜间活跃度 0.15 |
| 鹿 | 群居（母鹿群）、1.5 岁性成熟、一年 1 胎（1–2 只）、寿命 10–15 年、晨昏觅食、草+树叶 | 通用资料（未逐条取源） | herd 26、litter 1–3、成熟 150 s、寿命 1100–1600 s、可啃树叶 |
| 苍鹭 | 涉水伏击，站在浅水里叉鱼，也吃蛙 | 通用资料（未逐条取源） | `wade`，`catchRadius` 2.4 格（最大）——"脖子那么长"就是这条 |
| 水獭 | 半水生，水中捕鱼、上岸休息 | 通用资料（未逐条取源） | `amphibious`，`huntSpeed` 1.15（最快），陆上速度 ×0.72 |
| 棕熊 | 杂食，捕鹿也捞鱼，体型与食量都大 | 通用资料（未逐条取源） | `wade`，`meat` 120、`maxEnergy` 280、成熟 300 s、litter 1–2 |
| 青蛙 | 浅水/岸边，吃水生植物与小虫，产卵多 | 通用资料（未逐条取源） | `wade`，`meat` 7（最小）、litter 8–14（最多）、寿命 150–260 s |

**还没对齐现实的地方（诚实清单）**：鹿、乌鸦、苍鹭、水獭、棕熊、青蛙的数值来自常识而非逐条引源；
没有季节性繁殖窗口、没有雌雄差异、没有幼体依赖期（幼崽出生即独立觅食）、没有疾病/寄生虫；
鱼类用"每次 4–10 尾"代替产卵量；狼群的协同围猎只是"朝同一目标靠近"，没有真正的包抄与轮换。

### 2.2 需求 · 决策 · 成长

行为不是 if 链，而是**需求驱动 + 效用打分**，动物的"意图"是显式字段。这是后面接社会/文明的地基。

**需求通道**（0 = 满足，1 = 临界）：`hunger` `thirst` `energy` `safety` `social`。

每 tick 的增长（`decayNeeds`，单位是每秒，再乘 `dt` 与 `STAGE_APPETITE × genes.metabolism`）：

| 通道 | 基础速率 | 修正 |
| --- | --- | --- |
| `hunger` | +0.0105 | × 食量基因 × 阶段食量 |
| `thirst` | +0.0082 | 同上 |
| `energy` | +0.0068 | 夜间 ×1.7、白天 ×0.85 |
| `social` | +0.006 | × 性格 `social` |
| `safety` | −0.3 | 看见捕食者时被直接顶到 1 |

**决策**：每 0.22–0.55 秒做一次，对候选行动打分：

```
score(行动) = 需求权重[角色][需求] × (需求强度 + 偏移) × 情境修正 − 距离成本(上限 0.45)
```

取最高分写入 `entity.intent`，同时给出 `targetX/targetY`。距离是**成本不是门槛**——
远处的食物仍然胜过饿死。

`NEED_WEIGHT`（谁能压过谁）：

| 角色 | hunger | thirst | energy | safety | social |
| --- | --- | --- | --- | --- | --- |
| `grazer` | 1.2 | 0.75 | 0.75 | **2.6** | 0.35 |
| `hunter` | 1.55 | 0.8 | 0.85 | 1.7 | 0.35 |
| `scavenger` | 1.35 | 0.85 | 0.6 | 1.2 | 0.6 |

| 候选行动 | 触发需求 | 说明 |
| --- | --- | --- |
| `flee` | safety | 看见捕食者时 +6 分压倒一切，并向同类传染警报 |
| `forage` | hunger | 走到草/水草格；鹿还能啃树冠 |
| `hunt` | hunger | 嗅觉半径内有猎物时权重 ×1.7 |
| `scavenge` | hunger | 掠食者顺带吃尸；乌鸦只认尸体（视野 ×1.9 找） |
| `drink` | thirst | 走到最近的水格旁补水（水生物种不需要） |
| `rest` | energy | 原地停下（速度 ×0.12）；**饥饿 > 0.62 时不再考虑休息** |
| `socialize` | social | 朝群体质心靠拢，站在 `separation + size_max×2.6` 的**环上**而不是质心上 |
| `explore` | 性格 curious | 饥饿 < 0.55 且安全 > 0.2 时才闲逛 |

**性格**（`traits`，物种可覆盖）：`bold` 胆量（决定多近才逃）、`social` 群体性、
`curious` 探索欲、`territorial` 领地性。

**生命阶段**：`juvenile` / `adult` / `elder`，由年龄对物种 `maturity` 与 `elderAt`（默认 `maturity × 2.6`）切分：

| 阶段 | 体型 `STAGE_SCALE` | 速度 `STAGE_SPEED` | 食量 `STAGE_APPETITE` | 能否繁殖 |
| --- | --- | --- | --- | --- |
| `juvenile` | 0.60 | 0.78 | 1.30 | 否 |
| `adult` | 1.00 | 1.00 | 1.00 | 是 |
| `elder` | 1.03 | 0.82 | 0.85 | 是 |

**加一个物种需要什么**：一条 `SPECIES` 行（栖息地、role、食物、天敌、参数）+ 一组图集槽位。
决策、需求、成长、详情卡、工具按钮会自动接管（`LIFE_TOOLS` 就是 `['grass','weed','tree','bush', ...SPECIES_IDS]`）。

**给社会层的接口**：`entity.intent`、`entity.needs`、`entity.stage`、`entity.genes`、
`entity.generation` / `children`。后续的聚落、分工、战争都可以读这些字段，不必重新发明状态机。

---

## 3. 玩法

- **世界**：512 × 400 格（`createWorld` 夹到每边 ≤ 512）。地形
  `water / sand / dirt / grass / stone`，实测约 17.7% 水、2.7% 沙、11.5% 土、67% 草地、1.0% 石头。
  生成顺序：三个八度 value noise → 两次 box blur → 20% 分位定海平面 → 只保留占候选面积 88% 的最大水体 →
  离岸距离决定沙（≤2 格）、土（近水少、远水多）、石（99% 分位以上）。
- **放置**：工具栏选工具，左键点/拖，右键擦除。工具分两组——
  生命：草、水草、树、灌木 + 11 个物种（共 15 个按钮）；
  地形：水、沙、土、石头、清除、指针（共 6 个）。笔刷半径 0/1/2 格（半边长）。
- **看**：滚轮缩放（整数倍 1..16），指针工具拖动平移，`适应窗口` 归位，右下小地图点击跳转。
- **观察**：点一只生物 → 右侧显示阶段、意图、五条需求、年龄、能量、代数、后代数、六项基因条；`跟随` 让镜头盯住它。
- **时间**：暂停 / 1× / 2× / 4× / 8×（默认 2×）+ 单步；1 天 = 120 秒（1×），有昼夜明暗，夜里草长得慢。
- **键盘**：空格、`1`–`4`、`F`、`H`、`Esc`。
- **死亡**：饿死、老死、被吃，统一走 `killEntity` 留遗骸；遗骸 42 秒腐烂完，给周围 3×3 加肥。
- **繁衍**：能量过 `breedEnergy` + 成年 + 冷却结束 + 领地不拥挤 → 生一窝，基因漂移 ±7%（5% 概率 ±20%）。
- **自动保存**：每 30 秒 + 页面卸载写 localStorage；`新世界` 换随机种子重开。

---

## 4. 数据模型（`World`）

```js
World = {
  version: 1,                       // SAVE_VERSION；不符就开新世界
  seed, width, height,              // 默认 512 × 400
  tick, time,                       // tick 固定 0.1 s；time 是秒
  rngState,                         // 32-bit LCG，序列化后继续可复现
  immigration: true,                // 移民安全网开关（createWorld({immigration:false}) 可关）
  immigrationTimer,                 // 距离下次移民检查的秒数（25–45 s 随机）
  terrain: Uint8Array,              // 0 water, 1 sand, 2 dirt, 3 grass, 4 stone
  depth: Float32Array,              // 水深 = clamp(离岸格数 / 16, 0, 1)；涉水与水面着色都读它
  moisture: Float32Array,           // 陆地水分 0..1（近水高）
  fertility: Float32Array,          // 陆地肥力 0..1
  waterFertility: Float32Array,     // 水体营养 0..1（决定水草长势）
  grass: Float32Array,              // 陆地植被生物量 0..1
  weed: Float32Array,               // 水下植被生物量 0..1
  trees: Plant[],                   // { id, x, y, variant:'tree'|'bush'|'lily'|'reed', size, age, foliage, seedTimer }
  entities: Entity[],
  corpses: Corpse[],                // { id, x, y, species, decay, energy }
  effects: Effect[],                // { x, y, vx, vy, life, maxLife, color, rise } —— 纯装饰，模拟不读
  nextId, population,               // population: 每物种计数缓存
  stats, history,                   // history: 每秒 { t, counts:{species: n} }
  hydrologyDirty,                   // 玩家改地形后置 true，settleTerrain 收尾并清掉
}
Entity = {
  id, species, x, y, prevX, prevY, heading,
  energy, age, generation, cooldown,
  genes: { speed, vision, size, metabolism, lifespan, fertility },
  needs: { hunger, thirst, energy, safety, social },   // 读档后重新初始化
  intent, intentScore, targetX, targetY, fleeing, flightTime,
  stage, alarm, threatX, threatY,
  phase,          // 动画相位种子 0..1
  gait,           // 按走过的距离累加的步态相位 0..1（渲染用）
  thinkTimer, herdTimer, herdAnchor, children, fate,
}
```

`corpses[].energy = SPECIES[species].meat × 0.8`；`killEntity` 是唯一死亡出口。
`population` 是缓存：任何**直接替换 `world.entities`** 的代码路径都必须重建它（`countPopulations`）；
`spawnEntity` / `killEntity` 会自己维护。`handleImmigration` 故意**绕过**缓存直接 `countSpecies` 数实体，
因为缓存一旦陈旧就会出现"该补的物种没补"。

**存档不保存的内容**：`needs` / `intent` / `stage` / `herdAnchor` / `alarm` / `gait` / `flightTime` /
`depth` / `moisture` / `waterFertility` / `effects`。前一组是"心情"，读档后从默认值重新开始；
后一组能从 `terrain` 逐字节重算。`terrain`/`fertility`/`grass`/`weed` 量化成每格 1 字节 base64。

---

## 5. 引擎 API（`module.exports.__engine`）

同步纯函数 / 原地修改，不碰 DOM、不读时钟；Node 里可直接跑。

```js
// 常量与表
SPECIES, SPECIES_IDS, TERRAIN, GENE_KEYS, NEED_KEYS, INTENT_IDS,
ROLE_TRAITS, STAGE_SCALE, TUNING, TICK, DAY_SECONDS, MAX_ENTITIES,
PALETTE, SPRITES, SPRITE_GRIDS, PLANT_SPRITES, SPRITE_COLORS,
ATLAS, ATLAS_SLOTS, ATLAS_SIZE, ATLAS_GAIT, SPRITE_ATLAS_PNG,

// 世界
createWorld({ seed?, width?, height?, stocks?, trees?, immigration? }) -> World
stepWorld(world, dt) -> void                              // dt 夹到 0.5，<=0/NaN 忽略
place(world, tool, cx, cy, radius) -> number|void          // 工具见 §3
spawnEntity(world, speciesId, x, y, genes?, generation?, options?) -> Entity|null
findEntityAt(world, x, y, radius?) -> Entity|undefined
sampleStats(world) -> { day, clock, grass, weed, counts, corpses }
pushHistory(world) -> object
serializeWorld(world) -> object
deserializeWorld(object) -> World                          // 版本不符/坏数据抛错
countSpecies(world, speciesId) -> number
handleImmigration(world, dt) -> void
settleTerrain(world) -> void                               // 改完地形后重算水文与肥力
computeHydrology(world, includeWaterFertility?) -> void
canStand(world, species, x, y) -> boolean

// 渲染
paintView(world, view, buffer?, alpha?, overlay?, options?) -> Uint32Array
paintWorld(world, pixels?) -> Uint32Array
paintMinimap(world, width, height) -> Uint32Array          // width*height，地形 + 每只动物一个色点
frameFor(entity, tick) -> sprite                            // 低分辨率回退用

// 相机（唯一一套坐标换算）
viewFromCamera(camera, stage, world) -> { x, y, width, height, scale, offsetX, offsetY }
worldFromPoint(view, stageRect, clientX, clientY) -> { x, y }
cameraAfterZoom(camera, stage, world, stageRect, clientX, clientY, nextScale) -> camera

// UI
createStore({ storage?, clock?, requestFrame?, cancelFrame? })
GLYPHS, PANEL_GLYPH
```

`module.exports.__test` 额外导出组件与字典（`CHINESE` `ENGLISH` `TerrariumPanel` `Inspector`
`PopulationChart` `Minimap` `PanelIcon` `PixelGlyph` `BRUSHES` `BRUSH_RADIUS` `LIFE_TOOLS`
`TERRAIN_TOOL_IDS` `SPECIES_TOOL_IDS`），供测试直接调用。

### 5.1 `paintView` / `paintWorld` 契约

- `pixels` 省略时新建 `Uint32Array(w*h)`；像素格式 little-endian `0xAABBGGRR`，每格不透明。
- 顺序：地形 → 水波/焦散/泡沫 → 水草 → 草地植被 → 树/灌木/睡莲/芦苇（按 y 排序，远的先画，带椭圆阴影）
  → 遗骸 → 动物（`options.sprites !== false` 时用程序化精灵，图集由 `drawAtlasAnimals` 单独叠在上面）
  → 行为特效 → 笔刷光标与选中环。
- 出土精灵裁剪，不抛错；同一 `world.tick` 下两次调用结果一致（只有水层随时间动画）。
- 这些函数**不碰画布状态**：昼夜与晨昏是 `draw()` 在 canvas 上叠的两层 `fillRect`，不写进 buffer。

### 5.2 `stepWorld` 保证

- **死亡只有一条路径**：`energy <= 0 || age > lifespan`（含被标记 `fate === 'eaten'`）→ `killEntity` → 掉遗骸。
  被咬过的猎物在 `feed()` **之前**就死，否则它能把捕食者刚拿走的能量重新吃回来，永远挂着 `fate === 'eaten'` 活着。
- **上限**：全局 `MAX_ENTITIES = 3600`；每物种 `cap`（玩家手动放置放宽到 `cap × 1.4`）；
  植物 `MAX_TREES = 1150`；遗骸 `MAX_CORPSES = 260`。到顶只禁止新增，不杀已有个体。
- **生产场**：草只长在 `GRASS` 格、水草只长在 `WATER` 格，其它地形清 0。
  生长是 logistic（`TUNING.growth = 0.035`）× 营养 × 水分 × 光照（`0.35 + 0.65 × daylight`），
  并且**分 8 片交错刷新**（`GROWTH_SLICES = 8`，每 tick 只跑 1/8 的格子、`dt × 8`）——
  每 tick 刷全部格子比整个模拟其它部分加起来还贵。
- **移动按介质判定**（`canStand`）：陆地物种进水/进岩被挡（沿边滑），水生物种出水被挡（`amphibious` 除外），
  飞行物种无视地形；`wade` 物种能站进 `depth < 0.34` 的浅水。
- **捕食**只在 `prey` 列表内、且**按列表顺序找**（狼有鹿时不抓兔）；同 tick 内同一猎物不会被吃两次。
  命中半径是 `balance.catchRadius`，收益是 `猎物 meat × balance.meatGain`。
- **领地**：声明了 `territory` 的物种，附近同类达到 `max` 时不再繁殖——掠食者密度由领地而不是硬上限决定。
- **移民**：每 `TUNING.immigration = [25, 45]` 秒检查一次，任何物种 `countSpecies < minimum`
  就补 4–8 只（陆地物种只落草地、飞行物种不落岩石）。这是安全网：没有它，一次坏运气可能让世界永远变成死水。
- **休息时的私人空间**：只在 `intent === 'rest'` 时检查 1.5 格内的同类，彼此 < 1.2 格就互推
  `(1.2 − 距离) × 0.035` 格/tick。推觅食中的动物会把它们从草皮上挤开、直接饿死；而精灵堆叠只发生在**停下**的地方。

---

## 6. 渲染与 UI

### 6.1 主面板

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⬡ 像素生态缸 第 3 天 14:20  ●×11 计数 chip                                   │
│                    ⏸ [1× 2× 4× 8×] 单步 · 新世界 · 适应窗口 · 玩法 · 回到对话 │
├──────────────────────────────────────────┬───────────────────────────────────┤
│  canvas（CSS 尺寸 = 视口格数 × scale）      │ tool.group.life（15）             │
│  左下 HUD：hover 格 · view x,y · 视口 · 倍率 │ tool.group.terrain（6）           │
│  右下：Minimap（168×105，点击跳转）          │ brush.label（小/中/大）            │
│                                            │ PopulationChart（240×64 + 图例）   │
│                                            │ Inspector（stage/intent/needs/基因）│
└──────────────────────────────────────────┴───────────────────────────────────┘
```

- 画布 `<canvas width=W*scale height=H*scale>`，CSS 尺寸同值，`image-rendering: pixelated`。
  `scale` 是 1..16 的整数，默认按舞台尺寸 fit；容器窄时右栏折到下面。
- 辉光/昼夜：`putImageData` 之后在 canvas 上叠夜色（≤50%）与晨昏暖色（≤18%）。
- 光标：画刷框（1 格笔刷框线）；选中生物画一圈 8 点亮环 + 详情卡。
- **图集只在 `scale >= 3` 且离屏 canvas 可用时启用**；否则用程序化小精灵（`frameFor`）。
- 颜色只用 `--dsw-alias-*` token（像素画布内部除外，那是美术）。

### 6.2 生命周期

- 一个 `Store` 在插件 `apply` 闭包里创建，懒初始化世界；`apply` 卸载时 `dispose()`。
- `attach(canvas)` / `detach()`：面板挂载时接画布，rAF 循环 `advance(elapsed × speed)` + `draw()`；
  面板不在时循环停止（不烧 CPU）。`advance` 按固定 `TICK` 切片，最多 60 片/帧，余量丢掉。
- React 只订阅快照：模拟时间每过 1 秒 `pushHistory` + `publish()` 一次；
  绘制/放置只 `markDirty()`，快照在下一个 1 秒边界才重建。**画布更新不走 React**。
- 存档：`localStorage` key `dsh-pixel-ecosystem:v1`，`beforeunload` + 每 30 秒；坏档静默丢弃。
  `detach()` **不存盘**（曾经每次平移都序列化整个世界）。

### 6.3 注册的两个 slot

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'pixel-ecosystem', order: 20,
    label: () => bindNs()('panel.title') }, PanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'pixel-ecosystem' },
  props => h(Panel, { ...props, store, locale, layout: ctx.get('layout') })))
```

`ctx.layout.selectPanel('conversation')` 用于「回到对话」（`layout` 是软取，取不到就不显示那个按钮）。
Client `inject`: `['slots','locale']`。`dsh.client.inject`: `@deepseek-ai/dsh-client-ui-layout` + `@deepseek-ai/dsh-client-ui-sidebar`。

### 6.4 图集几何与帧角色

```js
ATLAS      = { cellWidth: 64, cellHeight: 59, columns: 8, baseline: 52 }
ATLAS_SLOTS = { rabbit: { idle:[0,1], walk:[2,3,4,5], run:[6,7,8,9] }, … }   // 98 帧，11 物种
ATLAS_SIZE  = { rabbit: 0.8, deer: 0.87, … }        // 相对格子的显示尺寸（6× 缩放下为基准）
ATLAS_GAIT  = { rabbit: 0.34, frog: 0.5, … }        // 每走 1 格累加多少个步态循环
```

槽位是 `build-atlas.mjs` 排出来的连续编号，`embed-atlas.mjs` 写回 `client.js`。
**契约**：每物种 `idle` 2 帧；有四条腿的 `walk` 4 帧 + `run` 4 帧；乌鸦/鱼/狗鱼没有 `walk`
（渲染时回落 `run`）。PNG 是 8 列 × 13 行 = **512 × 767**。

**一帧怎么选**（`atlasFrameRole` + `drawAtlasAnimals`）：

| 条件 | 角色 | 帧序号 |
| --- | --- | --- |
| `entity.fleeing === true` | `run` | `floor(gait × 4)` |
| 本 tick 位移 < 0.06 格 | `idle` | `floor(time × 1.15 + phase × 3) % 2` |
| 速度 < `genes.speed × 0.62` | `walk` | 同上但 `% 4` |
| 其余 | `run` | `floor(gait × 4)` |

`gait` 是**按走过距离累加**的（`gait += travelled × ATLAS_GAIT[species]`，水生物种与鸟类额外加
`dt × 0.55` 的空转相位，所以停着的鱼也在摆尾），因此慢的动物迈小步、逃跑的动物迈快步，
不需要任何速度 if 链。跑动时再叠 ±7% 格高的上下起伏和 ±4% 的横向拉伸/纵向挤压。

每只动物在脚下画一个 `rgba(10, 22, 14, 0.22)` 的椭圆阴影（半径 = 格宽 × 0.3 / 格高 × 0.09），
没有它精灵会读成贴纸；`energy / maxEnergy < 0.22` 时整只降到 `globalAlpha 0.62`。

### 6.5 地面、水面、植物、影子

| 层 | 实现 |
| --- | --- |
| 水面 `waterColor` | 按 `world.depth` 三层混色（surface→shallow→mid→deep）→ 三项正弦相乘的**焦散**（两项相乘是格子，会印出网状纹理，第三项打散对称性）→ 一条更细的涟漪带 → 三档**泡沫**（`d<0.055` 0.72、`d<0.11` 0.30、`d<0.16` 且噪声 > 210 则 0.22）→ 手写 dither |
| 水草 | 覆盖度混色 + `SWAY` 表做出摆动；覆盖 > 0.34 且噪声高时插亮色茎 |
| 草地 `paintGround` | 8 级 `GRASS_RAMP` + 格级 `SWAY` 摆动 + **慢速 patch 场** `sin(x·0.055+0.7)·sin(y·0.043−1.1)·7`；厚草格出现亮草叶与四色小花，裸土格出现土色斑 |
| 沙/土/石 | 噪声二选一色 + `noiseAt` 微调 |
| 植物 `paintPlants` | 按 y 排序；`id % 3` 取三档明暗（一片全同的印章像壁纸）；`foliage < 0.35` 压暗；每 8 tick 横移 1px 的摇曳 |
| 影子 `shadeEllipse` | 除睡莲外每株植物都在脚下打椭圆软阴影，**两档衰减 0.86 / 0.72**——单档在树这个尺寸上会读成矩形 |

噪声必须是**真哈希**（`DITHER` 的 avalanche 混合），不能用算术斜坡：`x*73 + y*151 + x*y*17`
有很强的对角结构，会在整片草地上印出可见网格。

---

## 7. Locale key 表（namespace = 包名）

当前 **89 个 key**，`CHINESE` 与 `ENGLISH` 必须完全一致（`tests/client.test.mjs` 断言）。
`locale/{en,zh}.json` 只放插件管理页用的 `meta.title` / `meta.description`，**不含**下面这些 key。

| 分组 | key |
| --- | --- |
| 面板 | `panel.title` |
| 动作 | `action.back` `action.close` `action.deselect` `action.fit` `action.help` `action.newWorld` `action.newWorldConfirm` `action.pause` `action.play` `action.step` |
| 速度 | `speed.paused` `speed.1` `speed.2` `speed.4` `speed.8` |
| 时钟 | `stat.day`（`{day}`）`stat.corpses` |
| 物种 | `species.rabbit` `species.deer` `species.fox` `species.wolf` `species.crow` `species.fish` `species.pike` `species.heron` `species.otter` `species.bear` `species.frog` |
| 工具 | `tool.grass` `tool.weed` `tool.tree` `tool.bush` `tool.water` `tool.sand` `tool.dirt` `tool.stone` `tool.erase` `tool.pointer` |
| 分组标题 | `tool.group.life` `tool.group.terrain` |
| 笔刷 | `brush.label` `brush.small` `brush.medium` `brush.large` |
| 曲线 | `chart.title` |
| 详情 | `inspect.title` `inspect.empty` `inspect.emptyHint` `inspect.age` `inspect.energy` `inspect.generation`（`{n}`）`inspect.children`（`{n}`）`inspect.follow` `inspect.unfollow` |
| 基因 | `inspect.gene.speed` `.vision` `.size` `.metabolism` `.lifespan` `.fertility` |
| 阶段 | `stage.juvenile` `stage.adult` `stage.elder` |
| 意图 | `intent.flee` `intent.forage` `intent.hunt` `intent.scavenge` `intent.drink` `intent.rest` `intent.socialize` `intent.explore` |
| 需求 | `needs.title` `needs.hunger` `needs.thirst` `needs.energy` `needs.safety` `needs.social` |
| 提示 | `toast.placed`（`{n}`）`toast.blocked` |
| 玩法弹窗 | `help.title` `help.1` … `help.8` |

> 动物工具的标签**直接复用** `species.*`；没有 `tool.herbivore` / `tool.carnivore` 这类单物种旧 key。
> 头部也不再有「食草 / 食肉」汇总计数，每个物种各一枚 chip。平移工具的 key 是 **`tool.pointer`**
> （不是 `tool.pan`——`place()` 仍然接受 `'pan'` 作为无副作用的别名，但 UI 不用它）。

---

## 8. 测试

1. `node --check client.js` / `node --check index.js`。
2. `node --test tests/*.test.mjs` → **65 个测试 / 5 个套件，全绿，约 50 秒**。
   - `engine.test.mjs`（33）：地形确定性、放置语义、介质边界、涉水规则、跨水陆捕食、睡莲喂水、
     死亡掉遗骸、繁殖变异、捕食矩阵与偏好顺序、同 tick 不重复捕食、序列化往返、`dt` 夹取、`cap`、移民。
   - `render.test.mjs`（9）：尺寸/ARGB 格式/缓冲区复用/同 tick 幂等/只有水层动画/水草可见/地形配色/裁剪/不修改世界。
   - `animation.test.mjs`（3）：PNG 尺寸对得上槽位表、每角色帧数、移动的动物走遍四帧。
   - `balance.test.mjs`（4）：固定种子 20 000 tick soak，一次运行供四条断言共享。
   - `client.test.mjs`（16）：VM boot → slot/id/key、字典对齐、工具覆盖全部物种、CSS 前缀、渲染树、存档。
3. 平衡契约（`balance.test.mjs`，**不是稳态承诺**）：
   ① 不永久灭绝：`MAX_ZERO_CHECKPOINTS = 2`（20 个检查点里最多 2 个为 0），且 soak 结束时每个物种 > 0；
   ② 每条链活着：每个物种必须达到过 `VIABLE_PEAK`（兔 120 / 鹿 22 / 狐 12 / 狼 5 / 乌鸦 18 / 鱼 55 /
   狗鱼 5 / 苍鹭 5 / 水獭 5 / 熊 3 / 青蛙 20）；③ 不越过 `cap`；另有草/水草覆盖 ≥ 各自地形 3%、
   吞吐 > 80 tick/s。
   实测（seed 777，20 000 tick，两次运行）：**441 / 466 tick/s**，兔 1..611、鹿 12..26、狐 9..50、狼 4..17、乌鸦 17..79、
   鱼 8..447、狗鱼 4..12、苍鹭 1..12、水獭 0..14、熊 1..11、青蛙 4..162。三种子（777/31/4242）漂移见 README。
   早期版本曾用窄带（兔 40..800）断言，但那是「被咬的猎物不死」这个 bug 造成的假稳态；
   现在捕食真的生效了，种群就是会大幅波动——契约因此改成上面三条。
4. 真浏览器：`tests/scene-lab.html`（`scale` `w` `h` `seed` `ticks` `cells` `clock=noon|dusk` `focus=hunt`）
   与 `tests/species-sheet.html`（`scale` `only=a,b`），详细用法见 README「测试」一节。
5. 装进 `rc-dev`：`--dump-config` 确认行激活；起服务把带 token 的 URL 交给用户自己开（视觉确认）。

---

## 9. 路线图

当前进度：**v0.2.0**（11 物种 + 跨水陆食物网、四帧行走/奔跑、图集重做、水下深度/焦散/泡沫、
睡莲与芦苇、休息私人空间、`huntReach`/`meatGain` 平衡修复、视口渲染）。
剩下的事情、顺序与验收标准写在 [HANDOVER.md §8](HANDOVER.md)。

- **进行中 · 美术**：图集帧来源正在换代（AI 出图 → 拆件成可编辑骨骼模型），
  本文只锁定「PNG + atlas.json → `embed-atlas.mjs` 写回常量」这套接口。
- **进行中 · 平衡**：捕食层平均饥饿 0.58–0.90，仍明显高于食草层；地面放大后仍偏块状。
- **v0.4 文明雏形**：聚落层（`world.settlements`）+ `returnHome` 意图 + 粮食储备；
  市民分工、建造、部落冲突在聚落层之上再加，不改动物内核。
- **长期**：让 Agent 也能碰这个世界（Host 工具 `terrarium_seed` / `terrarium_observe`）。