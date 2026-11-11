# 交接文档（HANDOVER）

> **⚠️ 本文已失效：自述版本 v0.2.1，是一份 0.2.x 的交接书。**
> 它讲的状态、代码地图（5 800 行单文件 `client.js`）、65 个测试、512 × 400 世界、五种需求/八种意图、
> `VIABLE_PEAK` 契约、四个调参旋钮 —— 在 0.3.x 里**都已经换掉了**。0.3.x 是**能量账本**
> （`body.E / V / M`，单位 kJ）+ 感知/信念/决策/执行的行为层，源码已拆成 `src/parts/` 下 33 个 part。
>
> **0.3.x 请从 [docs/00-VISION.md](docs/00-VISION.md) 开始读**，再看 [docs/90-ROADMAP.md](docs/90-ROADMAP.md)
> 的"状态总览"了解当前进度；本文只作为 0.2.x 的历史记录保留（README / DESIGN 同样已标注失效）。

> 面向：接手 `dsh-plugin-pixel-ecosystem` 的下一个会话 / 下一个 agent。
> 读完这一份就应该能直接开工，不需要重新读 5 800 行 `client.js`。
> 用户视角的玩法说明在 [README.md](README.md)，设计契约在 [DESIGN.md](DESIGN.md)；
> 本文只讲**交接需要知道的东西**：现在是什么状态、代码在哪、怎么验、哪里有坑、下一步做什么。
>
> 本文档对应 **v0.2.1**（11 物种 + AI 出图/拆件美术管线 + 真实奔跑姿态 + 头颈摆动 + 植物与动物统一深度）
> 。v0.2.0 是它的前身（11 物种 + 四帧行走/奔跑 + 跨水陆食物网 + 图集重做）。

---

## 0. 三十秒定位

一个 DeepSeek Harness 的**纯前端插件**：侧边栏点开，主面板整块画布上跑一缸 **512 × 400 格**
的像素生态（草/水草两条生产者链 → 陆地与水下两个食物网 → 遗骸腐烂回肥力，闭环）。
11 个物种、五种需求、八种意图、三个生命阶段、六项可遗传基因。
Host 半是空的 `apply()`，所有逻辑在 `client.js`，世界存在 `localStorage`。

**它现在能玩，而且看起来是对的**：能放 15 种工具、能看它们觅食/逃跑/捕猎/繁殖、
能放大缩小平移、能点开看需求和基因、有 11 色种群曲线和小地图。
**但它还不是"完成品"**：捕食层平均饥饿偏高（0.58–0.90，食草层只有 0.12–0.27）、
地面放大后偏块状、美术帧来源正在换代、没有社会系统。这四件事是下一阶段的主线。

---

## 1. 仓库与发布状态（事实）

| 项 | 值 |
| --- | --- |
| 主检出 | `D:\program\dsh-plugins\`，分支 `main`，HEAD `af2bc5f`（0.2.0 的插件改动**不在**里面） |
| 本地 `main` vs `origin/main` | 领先 12 个提交，落后 0 个（**没有 push**，用户明确说先不发 GitHub） |
| 本文所在工作树 | `D:\program\dsh-plugins\.agents\worktrees\dsh-3217954e-9b62`，分支 `dsh-3217954e-9b62`，基于 `fe23273` |
| 0.2.0 的工作状态 | **全部未提交**：`client.js`、`assets/atlas.png`、`README.md`、`package.json`、`locale/*.json`、`tests/*` 都有改动，`assets/atlas.json`、`assets/models/`、`tools/`、`tests/animation.test.mjs`、`tests/scene-lab.html`、`tests/species-sheet.html` 是未跟踪文件 |
| npm | `dsh-plugin-pixel-ecosystem@0.1.0` **已提交成功**，但 npm 2026 的 staged publishing 机制下当前只显示 `0.0.0-stage` 占位；**需要 maintainer 在 npm 页面批准**。`0.2.0` **没发布过** |
| 伞包 | **本插件不进 `tofu-box`**。清单里 `dsh.umbrella: false`，没有"装伞包顺带装它"这条路 |
| 未跟踪的临时产物 | 插件目录下有 `.scratch/`（探针脚本与截图）。**不要提交**，也不要删——里面的 `balance.mjs` 是目前唯一的平衡探针 |

发布命令（在**仓库根**、用会加载 profile 的 pwsh，才能拿到 `NPM_TOKEN`）：

```powershell
pwsh -NoLogo -File publish.ps1                                   # dry-run 预览文件清单
pwsh -NoLogo -File publish.ps1 -Publish dsh-plugin-pixel-ecosystem
```

⚠️ `publish.ps1` 从**脚本所在目录（主检出根）**打包，并且只认主检出里 **git 已跟踪**的插件目录。
所以从工作树分支发布必须先合并进本地 `main`——这就是当初合并的原因。

---

## 2. 代码地图

全部游戏逻辑在一个文件里（刻意如此：单文件 `client.js` 由 `window.__ModuleLoader__` 直接加载，无构建步骤）。

| 文件 | 职责 |
| --- | --- |
| `client.js`（**约 5 800 行 / 285 KB**，其中约 41 KB 是图集 base64） | 引擎 + 渲染器 + Store + 面板 UI + 字典 + CSS，全部在这里 |
| `index.js` | Host 半：只导出 `name` + 空 `apply()`，注释解释了为什么不注册任何东西 |
| `cordis.patch.yml` | bundle patch：一条 `insert`，插入一行 `pixel-ecosystem` |
| `package.json` | `dsh.bundle.patch`、`dsh.client.platform: web`、`dsh.umbrella: false`、`files` 白名单 |
| `locale/zh.json` `locale/en.json` | 插件管理页的`meta.title`/`meta.description`；面板内 89 个 key 在 `client.js` 的字典里 |
| `assets/atlas.png` `assets/atlas.json` | 图集**源文件** + 机器可读几何（运行时用内嵌 base64，这两个文件**不进 npm 包**） |
| `tools/` | 图集构建/嵌入/区域替换脚本（**不进 npm 包**） |
| `tests/*.test.mjs` | 5 个套件、65 个测试 |
| `tests/scene-lab.html` `tests/species-sheet.html` `tests/browser-harness.html` | 真浏览器验证页（见 §6.2） |
| `icon.svg` | 侧边栏图标 |

`client.js` 内部分区（行号基于**本工作树的 0.2.0 状态**，改动后会漂，按 banner 注释找）：

| 区段 | 行 | 内容 |
| --- | --- | --- |
| 世界常量 | 43–57 | `STORAGE_KEY` / `SAVE_VERSION` / `GRID_W=640`（**实际被夹到 512**）/ `GRID_H=400` / `TICK=0.1` / `DAY_SECONDS=120` / `MAX_ENTITIES=3600` / `MAX_TREES=1150` / `MAX_CORPSES=260` |
| `TUNING` | 65–72 | `growth 0.035` / `immigration [25, 45]` / `corpseSeconds 42` |
| `SPECIES` 表 | 116–288 | **11 个物种**，每个一段：栖息地、role、`wade`/`amphibious`/`huntReach`/`browse`/`ambush`/`flight`、`activity`、`herd`、`territory`、`genes` 区间、`balance` |
| 派生表 + 初始种群 | 290–308 | `SPECIES_IDS` / `PREDATORS_OF` / `PREY_OF` / `DEFAULT_STOCKS`（开局 483 只） |
| 小工具 | 310–456 | `clamp` / `mix` / `rgb` / `hash2` / `nextRandom`（LCG）/ `canStand` / `floraField` / `daylight` |
| 地形与水文 | 458–740 | 八度 value noise → 两次 box blur → 20% 分位定海平面 → `keepLargestWaterBodies`(88%) → 岸距 → 沙/土/石；`computeHydrology` 出 `depth`/`moisture`/`waterFertility` |
| 植被与世界创建 | 742–903 | `seedTrees`(430) / `seedAquaticPlants`(睡莲+芦苇) / `seedAnimals` / `createWorld` |
| 基因与出生 | 905–1017 | `randomGenes` / `mutateGenes`(±7%，5% 概率 ±20%) / `countPopulations` / `countSpecies` / `spawnEntity`（含 `cap × 1.4` 的 `force`） |
| 空间查询 | 1018–1305 | `buildGrid` / `queryNearest` / `queryNearby` / `nearestCorpse` / `findEntityById` |
| 模拟步（前半） | 1306–1508 | `killEntity` / `moveToward`（沿边滑 + 涉水减速）/ `findFlora` / `nearestPrey` / `findFoliage` |
| 需求 · 决策 | 1509–1905 | `NEED_KEYS` / `ROLE_TRAITS` / `NEED_WEIGHT` / `STAGE_*` / `decayNeeds` / `stageOf` / `decide`（含 `huntReach`） |
| 模拟步（后半） | 1906–2343 | `stepEntity` / `feed`（`meatGain`）/ `growField` / `growTrees`（睡莲喂水）/ `stepWorld` / `decayCorpses` / `handleImmigration` |
| 放置 | 2344–2595 | `place` / `paintTerrain` / `sowProducer` / `plantFlora` / `releaseAnimals` / `clearBrushArea` |
| 统计 | 2596–2658 | `formatClock` / `sampleStats` / `pushHistory` |
| 存档 | 2659–2876 | 8-bit 量化 / `serializeWorld` / `deserializeWorld` |
| 调色板与程序化精灵 | 2877–3355 | `PALETTE` / `SPRITES` / `SPRITE_GRIDS` / `PLANT_SPRITES`（含睡莲、芦苇）—— 图集未就绪时的回退 |
| **图集** | 3356–3522 | `SPRITE_ATLAS_PNG`（base64）/ `ATLAS` / `ATLAS_SLOTS` / `ATLAS_SIZE` / `ATLAS_GAIT` / `ensureAtlas` / `atlasFrameRole` / `drawAtlasAnimals` |
| 颜色帮手 | 3523–3631 | `WATER_RAMP` / `GRASS_RAMP` / `DITHER` / `dimColor` |
| 渲染器 | 3632–4036 | `frameFor` / `drawSprite` / `paintGround` / `waterColor` / `paintPlants` / `shadeEllipse` / `paintCorpses` / `paintAnimals` / `paintActivity` / `paintOverlay` / `paintView` / `paintWorld` / `paintMinimap` |
| Store | 4037–4526 | rAF 循环、`advance`、`draw`、`paintAt`、`selectAt`、离屏放大、自动存档、`markDirty` 合并快照 |
| 字典 | 4527–4723 | `CHINESE` / `ENGLISH`（89 个 key，必须完全对齐，有测试） |
| 字形 | 4724–4817 | `PixelGlyph` / `GLYPHS` / `PANEL_GLYPH` |
| 面板 UI | 4818–5512 | `LIFE_TOOLS` / `TERRAIN_TOOL_IDS` / `BRUSHES` / `TerrariumPanel` / `Inspector` / `PopulationChart` / `Minimap` / `PanelBoundary` |
| 补充调色板与 key | 5513–5589 | `PALETTE.effect.cursor/select` + `Object.assign` 追加的 locale key |
| 样式 | 5590–5686 | 单段 CSS，全部 `.pe-` 前缀 |
| 注册与导出 | 5687–5791 | `apply` / `__engine` / `__test` |

```
client.js 只有一个需要小心的结构约定：SPRITE_ATLAS_PNG 之后那四个常量块
（ATLAS / SLOTS / SIZE / GAIT）由 tools/embed-atlas.mjs 整段重写，
它靠字符串定位（'/** Atlas geometry' → 'const atlas = { started: false'）。
手改里面任何一个数字都会被下一次 embed 覆盖——要改就改 assets/atlas.json 或生成它的脚本。
```

---

## 3. 引擎：数据模型与 API

### 3.1 `World`（可 JSON 序列化）

完整字段与语义见 [DESIGN.md §4](DESIGN.md)。三个容易踩的点：

- `world.depth`（水深 = `clamp(离岸格数/16, 0, 1)`）同时驱动**涉水规则**和**水面着色**。
  玩家改地形后必须 `settleTerrain(world)` 重算，否则她在水里画的陆地还是"深水"。
- `world.population` 是缓存。任何**直接替换 `world.entities`** 的路径都要 `countPopulations`；
  `spawnEntity` / `killEntity` 自己维护。`handleImmigration` 故意绕过缓存、直接数实体。
- `world.history` 每 1 秒一条 `{ t, counts }`；快照只取 `slice(-120)`。

### 3.2 导出（`module.exports.__engine`）

```
SPECIES SPECIES_IDS TERRAIN GENE_KEYS NEED_KEYS INTENT_IDS ROLE_TRAITS STAGE_SCALE TUNING
PALETTE SPRITES SPRITE_GRIDS PLANT_SPRITES SPRITE_COLORS
ATLAS ATLAS_SLOTS ATLAS_SIZE ATLAS_GAIT SPRITE_ATLAS_PNG
TICK DAY_SECONDS MAX_ENTITIES
createWorld stepWorld place spawnEntity findEntityAt sampleStats pushHistory
serializeWorld deserializeWorld countSpecies handleImmigration settleTerrain computeHydrology canStand
paintView paintWorld paintMinimap frameFor
viewFromCamera worldFromPoint cameraAfterZoom
createStore GLYPHS PANEL_GLYPH
```

`module.exports.__test` 额外导出 `CHINESE ENGLISH TerrariumPanel Inspector PopulationChart
Minimap PanelIcon PixelGlyph BRUSHES BRUSH_RADIUS LIFE_TOOLS TERRAIN_TOOL_IDS SPECIES_TOOL_IDS`。

### 3.3 需求 → 决策 → 意图（社会系统的地基）

- 五个需求通道：`hunger` `thirst` `energy` `safety` `social`，0 = 满足，1 = 临界。
- 每 0.22–0.55 秒决策一次，对所有候选行动打分：

  ```
  score = NEED_WEIGHT[role][need] × (need + 偏移) × 情境修正 − 距离成本(≤0.45)
  ```

- 八种意图：`flee` `forage` `hunt` `scavenge` `drink` `rest` `socialize` `explore`，写入 `entity.intent`。
- 三个生命阶段：`juvenile` / `adult` / `elder`（体型 0.60/1/1.03、速度 0.78/1/0.82、食量 1.30/1/0.85）；
  **只有 adult 能繁殖**。
- 详细表格见 [DESIGN.md §2.2](DESIGN.md)。

**加一个新物种只需要**：一条 `SPECIES` 行 + 一组图集槽位，行为代码零改动——
`LIFE_TOOLS` 是 `['grass','weed','tree','bush', ...SPECIES_IDS]`，工具按钮会自动多一个。

---

## 4. 渲染管线（为什么它看起来像像素游戏）

1. **地面**画进一个**每格 1 像素**的小缓冲：`paintView(world, view, buffer, alpha, overlay, options)`。
   顺序是地形 → 水波/焦散/泡沫 → 水草 → 草地植被 → 植物（带椭圆阴影）→ 遗骸 → 精灵/特效 → 光标。
2. 该缓冲 `putImageData` 到离屏 canvas，再 `drawImage` **最近邻放大**到显示 canvas
   （`imageSmoothingEnabled = false`）。逻辑分辨率 512×400，显示时乘 `scale`。
3. **动物不画进小缓冲**，而是从图集以**显示分辨率**画（`drawAtlasAnimals`），
   而且**只在 `scale >= 3` 且离屏 canvas 可用时**才启用；否则回退到程序化小精灵（`frameFor`）。
4. 位置插值：模拟固定 10 Hz（`TICK = 0.1`），渲染时按 `alpha = accumulator / TICK` 在
   `prevX/Y → x/y` 之间线性插值，所以 60fps 下是平滑移动。
5. 昼夜与晨昏：`draw()` 结尾在 canvas 上叠两层 `fillRect`（夜色 ≤50% 深蓝 + 晨昏 ≤18% 暖橙）。
6. **图集**：8 列 × 13 行、每格 **64 × 59**、`baseline = 52`、共 **98 帧**（11 物种 × idle 2 /
   walk 4 / run 4，乌鸦/鱼/狗鱼无 walk），PNG 是 **512 × 767**，base64 内嵌在 `client.js`。
   帧怎么选见 [DESIGN.md §6.4](DESIGN.md)——关键是**低于自身最高速 62% 走 walk，否则 run**，
   而跑动帧的相位是按**走过的距离**累加的（`entity.gait`）。

> 为什么不用 `<img>` 直接铺满：地面如果按显示分辨率渲染，512×400 全图放大 6 倍就是 740 万像素/帧，
> JS 里跑不动。所以地面低价、动物高清，这是刻意的混合分辨率。

---

## 5. 交互与相机（有强不变式，别绕开）

**唯一一套坐标换算**，渲染与输入都调用它：

```js
viewFromCamera(camera, stage, world)        // {x, y, width, height, scale, offsetX, offsetY}
worldFromPoint(view, stageRect, clientX, clientY)   // 屏幕 → 世界格
cameraAfterZoom(camera, stage, world, stageRect, clientX, clientY, nextScale) // 缩放锚定指针
```

### 5.1 工具与手势

| 工具 | 左键单击 | 左键拖动 | 右键 | 中键 | 滚轮 |
| --- | --- | --- | --- | --- | --- |
| `pointer`（默认） | 选中动物 / 点空地取消 | 平移地图 | 取消选择 | 平移 | 以指针为中心缩放 |
| 生命/地形刷子 | 落笔一次 | 连续涂抹（同格不重复） | 擦除 | 平移 | 同上 |

缩放范围 **1..16**（`MIN_SCALE` / `MAX_SCALE`）。放置动物后底部弹 toast
（`放出了 N 只` / `这里放不下…`）。键盘：空格、`1`–`4`、`F`、`H`、`Esc`。

### 5.2 不变式（踩过两次的坑）

1. **任何构造 `view` 对象的地方都必须带上 `scale`**。`setView()` 和 `newWorld()` 各漏过一次，
   症状是"画面塌到左上角 + 点击全部偏移"。
2. 相机数学**只能有一份**。曾经组件里一份、事件里一份，导致缩放锚点漂到右下角。
3. 事件用**原生监听**绑在 stage 上（`pointerdown/move/up/cancel` + `wheel{passive:false}` + `contextmenu`），
   `setPointerCapture` 放在 stage 上。
4. 拖动时若 `event.buttons === 0`（丢过 pointerup）必须**立即结束手势**，否则刷子会粘住。
5. `attach()` 只在换 store 时做一次；`detach()` **不要**存盘（曾经每次平移都序列化整个世界）。

---

## 6. 怎么跑、怎么验

### 6.1 单元测试（快，每次改完必跑）

```powershell
cd D:\program\dsh-plugins\.agents\worktrees\dsh-3217954e-9b62\dsh-plugin-pixel-ecosystem
node --test tests/*.test.mjs
```

当前：**65 个测试 / 5 个套件全绿，约 50 秒**（大头是 20 000 tick 的平衡 soak）。

| 套件 | 数量 | 分工 |
| --- | --- | --- |
| `engine.test.mjs` | 33 | 地形确定性、放置语义、介质边界、涉水规则、跨水陆捕食、睡莲喂水、死亡/繁殖/捕食矩阵、序列化往返、`dt` 夹取、`cap`、移民 |
| `render.test.mjs` | 9 | 像素缓冲格式、缓冲区复用、同 tick 幂等、只有水层动画、水草可见、地形配色、裁剪、不改世界 |
| `animation.test.mjs` | 3 | PNG 尺寸 ↔ 槽位表一致、每角色帧数、移动动物走遍四帧 |
| `balance.test.mjs` | 4 | 20 000 tick soak，四条断言共享一次运行 |
| `client.test.mjs` | 16 | bundle 在裸 VM 里启动、slot/id/key、字典对齐、工具覆盖全部物种、CSS 前缀、渲染树、存档 |

### 6.2 真浏览器校验（改渲染/交互/动画必跑）

三个页面都是 `file://` 直接打开，无需服务器；`failures=[]` 才算过。

**`tests/scene-lab.html`** —— 一屏世界 + 四帧步态条 + 物种表。URL 参数：

```
scale=6        画布缩放倍率
w=200 h=120    视口格数
seed=777       世界种子
ticks=4000     先跑多少 tick
cells=3        物种表每格放大倍率
clock=noon     或 dusk：把时间拨到正午/黄昏
focus=hunt     在浅水区现场撒鱼/青蛙 + 苍鹭/棕熊/水獭，拍跨水陆捕食
```

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --user-data-dir="$env:TEMP\pe-verify" --window-size=1400,1000 `
  --virtual-time-budget=15000 --screenshot="$env:TEMP\scene.png" `
  "file:///$((Resolve-Path 'tests\scene-lab.html').Path -replace '\\','/')?focus=hunt&clock=dusk"
```

判据：页面顶部 `failures=[]`、`counts` 里 11 个物种都有数、底部的
「gait strip」打印出四个**不同**的 `gait phases`（四张一样的裁剪说明动画没在换帧）。

**`tests/species-sheet.html`** —— 只画图集，逐帧肉眼验。参数：`scale=4`（每格放大）、
`only=rabbit,wolf`（只画这些物种）。每行左边是物种名，帧按 `idle → walk → run` 排，
左上角色条：蓝 = idle、绿 = walk、橙 = run。

**`tests/browser-harness.html`** —— 最老的冒烟页：1200 ms 后打印
`ready=… canvas …x… paintedSamples=N | failures=[]`。`paintedSamples` 应该是四位数
（不是 200 那种"只画了左上角"）。

### 6.3 起开发服务看真界面

```powershell
cd D:\program\dsh-plugins
pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0     # 输出带 ?token= 的 URL，交给用户打开
```

规矩（见仓库 `AGENTS.md`）：插件只在 `rc-dev` / `alpha-dev` 两个 profile 里测，
**不许**装进 `desktop` / `web`；不要用 computer-use 去点用户正在用的窗口。

### 6.4 探针（调参用，写完就删或放 `.scratch/`）

临时脚本用裸 VM 启动 bundle。**注意 `__engine` 在 `factory(...)` 的返回值上，不在 `entry` 上**：

```js
import { readFileSync } from 'node:fs'
const source = readFileSync('./client.js', 'utf8')
const React = { createElement: () => null, Component: function () {}, Fragment: 'F',
  useState: v => [v, () => {}], useEffect() {}, useRef: v => ({ current: v }),
  useCallback: f => f, useMemo: f => f(), useSyncExternalStore() {} }
let entry
new Function('window', 'require', 'btoa', 'atob', source)(
  { __ModuleLoader__: { load: o => { entry = o } } },
  id => { if (id === 'react') return React; throw new Error(id) }, btoa, atob)
const E = entry.factory(id => id === 'react' ? React : (() => { throw new Error(id) })()).__engine
// 平衡长跑：createWorld({ seed }) → 循环 stepWorld(world, TICK) → 每 1000 tick 记 sampleStats(world).counts
```

现成的平衡探针是 `.scratch/balance.mjs`：

```sh
node .scratch/balance.mjs 777,31,4242 20000
```

每个种子输出一行 `ticks/s`，再每个物种一行 `avg / min / max / zero@ / E(平均能量比) / H(平均饥饿) /
前三个意图占比`。**改平衡前后各跑一次，把两组数字贴进提交说明。**

---

## 7. 已知缺陷（按当前真实状态，带证据）

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | **捕食层平均饥饿偏高** | 三种子 soak：`E/H` = 狐 0.64–0.67、狼 0.63–0.66、狗鱼 0.58–0.64、水獭 0.64–0.71、苍鹭 0.73–0.80、熊 0.79–0.85；食草层只有 0.12–0.27 | 捕食者一直在"半饿着"跑，`explore` 仍占 27–50%，捕食压力不足 |
| 2 | **苍鹭/水獭/熊的种群余量很小** | 三种子峰值只有 9–23（`VIABLE_PEAK` 只要 5），熊的 `cap` 40 而峰值 11；seed 777 的水獭在 20 个检查点里读到过 1 次 0 | 换个种子或改一处参数就可能跌破测试线；这三种是"勉强活着" |
| 3 | **地面放大后偏块状** | 1 px/格 + 最近邻放大；草地有 patch 场和草叶噪声，但没有 tile 贴图 | 凑近看是色块拼贴，不是手绘地形 |
| 4 | **`GRID_W = 640` 但被静默夹到 512** | `createWorld` 里 `Math.min(512, options.width ?? GRID_W)`；实测 `createWorld({seed}).width === 512` | 读常量的人会以为世界是 640 宽；文档/注释/实测三个数不一致，是最容易写错的文档点 |
| 5 | **读档不恢复"心情"** | `serializeWorld` 不存 `needs`/`intent`/`stage`/`herdAnchor`/`alarm`/`gait`/`flightTime` | 刷新页面后所有动物重新从默认饥饿 0.32 开始决策；看不出 bug，但"世界连续感"断了一次 |
| 6 | **单世界存档** | `localStorage` 一个 key，`新世界` 直接覆盖 | 想对比两个世界得手动导出；没有存档槽位/命名 |
| 7 | **假 React 测试有结构性盲区** | `useState` setter 是 noop、`useRef` 永不赋值、`useEffect` 只跑一次、无依赖比较、无 DOM | DOM/Canvas/交互类 bug 在单测里**永远测不出来**，必须跑 §6.2 |
| 8 | **两处死代码** | `IMMIGRATION_INTERVAL = [45, 85]` 定义了但没人读（`handleImmigration` 用的是 `TUNING.immigration = [25, 45]`）；`tools/pixel/creatures.mjs` 里的 `trotPoses()` 也定义了但 `CREATURES` 没用它（美术换代时多半会一起消失） | 读代码的人会被误导（尤其 `IMMIGRATION_INTERVAL` 长得像配置） |
| 9 | **美术帧来源正在换代** | 旧的程序化四足骨架（`drawQuadruped`）正在被"AI 出图 → 拆件成可编辑骨骼模型"（`tools/pixel/ai_sprite.py` + `assets/models/*.json`）替代 | 图集帧内容会变，槽位/尺寸也可能变；**文档只锁「PNG + atlas.json → embed 回常量」这套接口**，帧怎么生成不在文档里承诺 |
| 10 | **狼没有真正的包抄** | 只有"朝同一目标靠近"的群巡（`herd` radius 20） | 群体行为单薄 |
| 11 | **乌鸦没有群栖/迁徙** | 只在视野 ×1.9 内找尸体 | 同上 |
| 12 | **性能余量 4–5 倍** | 512×400、实体数峰值 1 400–1 700 时烧 346–466 tick/s；8× 播放需要 80 tick/s | 8× 时大约吃掉单核 18–23%，再加物种或加世界尺寸会掉下来 |
| 13 | **社会/文明系统只有接口** | `intent` / `needs` / `stage` / `genes` 已预留，没有实现 | 路线图 v0.4 |
| 14 | **没有任何视觉确认记录** | 本文所有渲染结论来自代码与 headless 截图，没有人打开过真实 dsh 界面确认 | 首次安装可能撞上布局/CSS 问题 |

---

## 8. 下一步做什么（带验收标准）

### 8.1 平衡：把捕食层的饥饿压下来（最高优先，用户最直接的抱怨是"捕食者看着不干活"）

1. **先量，不要瞎调**。`.scratch/balance.mjs` 已经打印每个物种的意图直方图和平均 `E/H`，
   在此基础上加三项：**平均寿命**、**死亡原因分布**（饿死/老死/被捕食）、**每次 hunt 意图的成功率**。
2. 用数据定位瓶颈，三种可能分开处理：
   - `hunt` 占比低但 `explore` 高 → 嗅觉半径不够（`huntReach` 默认 2.6）或猎物密度不够；
   - `hunt` 高但饥饿不降 → `catchRadius` 太小 / `meatGain` 不够；
   - `rest` 抢了时间 → `NEED_WEIGHT.hunter.energy` 偏高，或夜间 `activity` 太低。
3. 只动四个旋钮：`huntReach`、`meatGain`、`catchRadius`、`NEED_WEIGHT`（必要时再动 `balance.drain`）。
4. **验收**：三种子（777/31/4242）× 20 000 tick 下，捕食层（狐/狼/狗鱼/苍鹭/水獭/熊）平均 `H` ≤ 0.5；
   同时把 `VIABLE_PEAK` 里的水獭/苍鹭/熊从 5/5/3 提到 10/10/6 且三个种子仍然全绿；
   `node --test tests/*.test.mjs` 65 个测试不回归。

> **这条建议已被推翻，勿照做。** `docs/00-VISION.md` 原则 2 规定"数字从物理推出，不从平衡推出"，
> 全局手调量只允许四个（格距、日内秒数、年天数、产能系数 κ）；`docs/10-SCALE-AND-UNITS.md` §1 把这条写成硬约束。
> 0.3.x 的现状是：`meatGain`、`NEED_WEIGHT`、`VIABLE_PEAK` 这几个名字在 `src/` 里**已经不存在**；
> `catchRadius`、`huntReach` 还在，但它们是每物种的结构参数（`02-species.js` 的 `balance` 行、
> `08b-perception.js:356` 的 `?? 1.6` 兜底），不是给人调平衡的旋钮。捕食者养不养得起由猎物产量与代谢算出来 ——
> 要改就改世界（产能 κ / 密度），不要改物种。

### 8.2 美术换代（进行中，别和它抢 `tools/pixel/`）

1. AI 出图 → 拆件成可编辑骨骼模型（`assets/models/*.json`），替代 `drawQuadruped`。
2. **这条线要保持的接口不变**：`assets/atlas.json` 的 `{cellWidth, cellHeight, columns, baseline,
   slots, display, gait}` 形状、`embed-atlas.mjs` 整段重写的那四个常量、以及
   「每物种 idle 2 / walk 4 / run 4，乌鸦/鱼/狗鱼无 walk」的槽位契约。
3. **验收**：`tests/animation.test.mjs` 3 个测试全绿（PNG 尺寸 ↔ 槽位表、每角色帧数、
   移动动物走遍四帧）；`tests/species-sheet.html` 里 11 个物种每行 10 帧都长得对；
   `tests/scene-lab.html?focus=hunt` 的四帧 gait strip 相位各不相同。
4. **不要**在换代过程中改 `client.js` 的 `atlasFrameRole` / `drawAtlasAnimals` 逻辑——
   那部分与帧来源解耦，是这轮改动里唯一应该保持不动的代码。

### 8.3 地面不再块状

优先做**程序化 tile**而不是引入素材：按 `(x,y)` 哈希在 2–4 个变体间选（草三种、沙两种、石两种），
变体由现有 `PLANT_SPRITES` 的同一套像素光栅器生成，仍然无外部资源。
**验收**：`scene-lab.html?scale=16` 截图里草地不再有重复方格感；
`tests/render.test.mjs` 的"同 tick 幂等"与"只画有植被的格子"断言仍绿；渲染耗时不超过现在的 1.3 倍。

### 8.4 存档健壮性

加**多槽位**（`dsh-pixel-ecosystem:v1:<slot>`，默认槽 + 手动导出/导入 JSON），
并把 `needs`/`intent`/`stage` 也序列化。
**验收**：`tests/client.test.mjs` 增加"旧版单槽存档能被读成默认槽"的迁移测试；
`tests/engine.test.mjs` 增加"存档往返后 needs 完全一致"的断言。

### 8.5 社会系统原型（v0.4 起点）

不改引擎内核，先加一个**聚落层**：`world.settlements`
（`{ id, speciesId, x, y, members: Set, stores: { food }, buildings: [] }`）。
用现有字段驱动：动物的 `intent` 加一个 `returnHome`，`needs.social` 高且离聚落远时回家；
聚落按成员数量累积/消耗 `stores.food`。
**验收**：一个物种的成员会稳定回到同一坐标附近聚集，聚落粮食随成员数增长，饿死率下降。

### 8.6 若要继续优化性能

先加计数器再优化（现在只有 soak 的总吞吐）：`stepEntities` 里分别计时
「空间查询 / 决策 / 移动」，`growField` 计时「生长」。已知可优化点：`buildGrid` 每 tick 重建两张网格、
`herdCentroid` 的 0.8 秒缓存是否够、`paintGround` 的逐格 `sin` 调用。

---

## 9. 决策记录（为什么是现在这样）

| 决策 | 理由 |
| --- | --- |
| 单文件 `client.js`、无构建 | 客户端半边由 `__ModuleLoader__` 直接加载，构建链会引入 CI/发布复杂度 |
| 世界 512 × 400（不是 320×200） | 用户明确嫌地图小；靠**视口渲染**（只画可见格子）控制成本。`GRID_W` 仍写 640 是 0.2.0 压缩世界尺寸后留下的不一致（见 §7.4） |
| 1 游戏日 = 1 生态年 | 真实"一年一胎"要等 365 天没人看得到；压缩规则写在 DESIGN §2.1，可核查 |
| 速度按 ~1/3 缩放 | 真兔子 12.5 m/s 会几秒横穿地图 |
| 物种用数据表 | 加物种只写一行数据 + 一组帧；`LIFE_TOOLS` 从 `SPECIES_IDS` 生成，漏不掉 |
| 需求/效用决策而非 if 链 | 用户要"决策/习性/饥饿/成长"系统，也是社会系统的前置 |
| 地面 1px/格 + 动物显示分辨率 | 地面全分辨率渲染跑不动（740 万像素/帧） |
| 图集 base64 内嵌 | 离线可用、不依赖 Host 路由、单文件发布；代价是 `client.js` 里有一行 40 KB 上下的 base64 |
| 生产场分 8 片交错刷新 | 每 tick 刷全部 20 万格比整个模拟其它部分加起来还贵 |
| 休息时才做私人空间排斥 | 推觅食中的动物会让它离开草皮饿死；精灵堆叠只发生在停下的时候 |
| 不进 `tofu-box` 伞包 | 用户明确要求；用 `dsh.umbrella: false` 让同步校验跳过 |
| 先不 push GitHub | 用户明确要求 |

---

## 10. 踩过的坑（必须记住）

1. **`view` 字面量漏 `scale`**：已发生两次（`setView`、`newWorld`）。症状是"画面只剩左上角 + 点击坐标全错"。
   加新代码时搜一下所有 `view = {`。
2. **相机数学不能有两份**：两份就会有一个锚点漂。现在只有 §5 那三个函数。
3. **假 React harness 测不出 DOM 问题**：`useState` 的 setter 是 noop、`useRef` 永远是初始值、
   `useEffect` 只跑一次且丢 cleanup、`useCallback` 不比较依赖、没有 DOM。
   凡是碰 canvas/事件/CSS 的改动，**必须**跑 §6.2 的真浏览器页。
4. **`publish.ps1` 只认主检出里被 git 跟踪的目录**：从 worktree 分支发布必须先合并进本地 `main`。
5. **npm staged publishing**：发布成功 ≠ 立即可装，需要 maintainer 批准；
   用 `npm view <pkg> versions --json` 确认。
6. **不要按进程名 kill 进程**：曾经 `Get-Process chrome | Stop-Process -Force` 把用户正在用的浏览器一起杀了。
   只 kill 自己 `Start-Process` 返回的那个 PID。
7. **`git add -A` 会带上未跟踪的本地目录**：`.npm-cache-dev/`、`.review/`、`.scratch/` 都被误带过。
   提交前先 `git status` 看清楚。
8. **`population` 缓存一致性**：任何直接替换 `world.entities` 的路径都要重建缓存；
   但**移民检查必须绕过缓存直接数**——缓存一陈旧就会出现"该补的物种没补"。
9. **饥饿会抢占休息**（`decide` 里 `needs.hunger < 0.62` 才考虑 `rest`）：去掉这个门会让动物"饿着不吃饭去睡觉"，种群直接崩。
10. **被咬死的猎物必须在 `feed()` 之前死**（`stepEntity` 开头就检查 `fate === 'eaten'`）：
    否则它能把捕食者刚拿走的能量重新吃回来，永远挂着 `fate === 'eaten'` 活着——这是"假稳态"的成因。
11. **图集那四个常量块是生成物**：手改会被 `tools/embed-atlas.mjs` 整段覆盖。要改就改
    `assets/atlas.json` 或生成它的脚本。
12. **噪声必须用真哈希**：`x*73 + y*151 + x*y*17` 这种算术斜坡有强对角结构，会在整片草地上印出可见网格。
13. **改水文后要 `settleTerrain`**：`depth` 同时驱动涉水规则和水面颜色，不重算会出现"水里能站"的幽灵地形。

---

## 11. 交接检查单

新会话开工前，按顺序确认：

- [ ] `cd <本插件目录> && node --test tests/*.test.mjs` → **65 通过 / 0 失败**（约 50 秒）
- [ ] `node .scratch/balance.mjs 777,31,4242 20000` → 记下当次的 min/max/E/H 与 ticks/s，
      后面改完对比（当前基线见 §7.1 与 README 的实测表）
- [ ] `git status` 看清楚：`.scratch/`、`.agents/` 之类不要提交
- [ ] 打开一次 `tests/scene-lab.html?focus=hunt`，确认 `failures=[]`、11 个物种都有数、
      gait strip 四个相位各不相同
- [ ] `npm view dsh-plugin-pixel-ecosystem versions --json` → 若仍只有 `0.0.0-stage`，
      说明 0.1.0 还没批准，别在 README 里写"已可安装"
- [ ] 需要看真界面：`pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0`，把带 token 的 URL 交给用户
- [ ] 动手前先读 §5.2 的不变式与 §10 的坑
- [ ] 要改 `tools/pixel/` 或图集帧内容，**先和用户确认**：那条线正在换代（§7.9 / §8.2）

---

## 12. 美术管线（0.2.0 起：AI 出图 → 拆件成可编辑模型）

上一版是**纯程序化像素模型**（`tools/pixel/creatures.mjs` 里用椭圆/多边形拼骨架）。
四足动物的体态一直不够像，用户三次退回，所以 0.2.0 改成用户建议的路线：
**先用图像模型出图，再把图拆成可编辑的部件，用部件摆出帧**。

### 12.1 两段式

```
generate_image  ──►  assets/models/<id>.json  ──►  tools/pixel/rig.mjs  ──►  assets/atlas.png
 (一张静态侧视像素图)     (躯干 + 若干腿的掩码与枢轴)      (按帧旋转腿部、躯干起伏)        (图集)
```

- **出图**：提示词固定为「32-bit 像素风、正侧视朝右、四腿着地、纯品红背景(#FF00FF)、
  无阴影无文字无边框、约 14 色、硬像素无抗锯齿」。品红底色是给下一步做色键用的。
- **拆件**：`tools/pixel/ai_rig.py`
  1. 品红键 → 裁到不透明包围盒；
  2. `estimate_pixel_size` 猜出"逻辑像素"的块大小（生成图是按某个整数倍块画的），
     逐块取众数颜色降采样 → 得到真正的像素网格，而不是模糊缩放；
  3. `reduce_palette` 量化到 20 色；
  4. 用最低几行（只有脚）的列连通段找出每条腿，过宽的段按中位宽度再切分；
  5. 腹线取 `ground - 22% 身高`（**不能按每条腿的连通高度算**：靠在胸前的近侧前腿
     和身体是连的，会把整条身体算成腿长）；
  6. 输出 `{width,height,ground,belly,legs:[{x,y,mask}],torsoMask,rgba}`。
     同时写 `assets/models/<id>-pixels.png`（降采样结果）和 `<id>-rig.png`（部件染色图），
     这两张是拆件是否正确的唯一可靠证据——**每次改拆件都要看它们**。
- **摆帧**：`tools/pixel/rig.mjs`
  - 每条腿绕枢轴（腹线上的腿中心）做**逆映射旋转**（正映射会在细腿上留下空洞），
    按相位摆动；离镜头远的那条（按 x 排序的奇偶）压暗到 0.82；
  - 躯干（头/颈/身/尾）作为整体做 1~2 px 的起伏；
  - 步态相位：走 = 四拍 `i/n`；跑 = `[0.5,0.6,0.02,0.1,0.3,0.42]`（后肢先收再前肢，中间腾空）。
- **装配**：`tools/build-atlas.mjs` 里有 `RIG_TARGET` 表：列在表里的物种走 rig，
  其余（乌鸦/苍鹭/鱼/狗鱼/青蛙）仍走 `creatures.mjs` 的程序化模型。表里的数字是
  "6× 缩放下想要的屏幕宽度"，会换算成 `ATLAS_SIZE = 屏幕宽 / 模型宽`。

### 12.2 现在哪些是 rig、哪些还是程序化

| 物种 | 来源 | 模型尺寸(逻辑像素) |
| --- | --- | --- |
| wolf / deer / fox / bear / rabbit / otter | **rig（AI 出图）** | 36x25 / 43x51 / 39x24 / 44x29 / 36x37 / 42x18 |
| frog / crow / heron / fish / pike | 程序化 | 见 `creatures.mjs` |

### 12.3 要加一个新物种（rig 路线）

1. `generate_image` 出一张（提示词照抄上面四条硬要求，尤其**品红底 + 纯侧视 + 四腿着地**）；
2. 把它加进一个 sprites JSON（`{ "id": "<png 路径>" }`）；
3. `python tools/pixel/ai_rig.py <sprites.json> assets/models`；
4. **看 `<id>-pixels.png` 和 `<id>-rig.png`**：腿有没有被拆开、腹线切得对不对；
5. 在 `build-atlas.mjs` 的 `RIG_TARGET` 里加一行（屏幕宽度）；
6. `node tools/build-atlas.mjs && node tools/embed-atlas.mjs`；
7. `node --test tests/*.test.mjs`（`animation.test.mjs` 会校验图集尺寸与槽位表一致）；
8. 打开 `tests/species-sheet.html?only=<id>&scale=6` 亲眼看。

### 12.4 已知不足

- **只有静态姿态的拆件**：所有帧都从同一张站立图变形而来，所以"跳"（rabbit/frog）和
  "低头啃草"这类**姿态本身变化**的动作做不出来——那需要为每个动作单独出一张图再拆。
- **头独立、尾巴没有**：头部按 `HEAD_CUT` 表里每个物种手标的比例切出来，绕颈线摆动；
  尾巴仍并进躯干（侧视时尾巴本来就藏在臀部后面，再切一条缝不划算）。
  早期的自动切分把"头"切到胸口（肩到吻的身体剖面几乎等高），所以那个函数保留但只在
  `SPLIT_PARTS` 且物种在 `HEAD_CUT` 里时才生效——加新物种要手工标这一列。
- **腿部旋转会让细腿出现 1 px 台阶**：像素画旋转的通病，幅度控制在 ±17°（走）/ ±34°（跑）以内。
- **生成图的分辨率不一致**：同一提示词，狼出来是 36x25、鹿是 43x51（鹿角把包围盒拉高了），
  所以各物种的像素密度不同，靠 `ATLAS_SIZE` 归一化。要严格统一得在提示词里锁死画布比例，
  或者出图后按"身体高度"而不是"包围盒"缩放。

---

## 13. 0.2.2 修掉的缺陷（2026-11，本轮交付）

§7 里原本挂着的几条，这一轮修完了，改动都在 \`client.js\`，都带实测证据：

| 缺陷 | 根因 | 代码位置 | 回归保护 |
| --- | --- | --- | --- |
| 动物在水陆边界无限打转 | \`moveToward\` 撞墙时 \`heading = nextRandom()\` 随机重设 | \`moveToward\` 的绕行循环 + 新增的 \`nearbyStand\` | 探针：贴水边 1 格内 70–85 只，连续 120 tick 位移 <1.2 格的为 **0** |
| 鱼看起来飘在空中 | 所有动物统一画地面椭圆阴影 | \`drawAtlasAnimal\` 里按 \`speciesRow.habitat === 'water'\` 分支 | 截图目视 |
| 水草放不下/看不见 | \`sowProducer\` 只在 WATER 写入；渲染也只处理水面 | \`sowProducer\` 增加 SAND/DIRT 分支；\`paintGround\` 增加湿草混色 | 目视 + \`weed cover is visible on water\` 用例仍绿 |
| 奔跑与行走无差别 | 角色由 \`moved/TICK\` 判（含昼夜活动系数）；追逐/逃跑倍率过低；步频不随跑动变化 | \`stepEntity\` 的 \`entity.running\` + \`atlasFrameRole\` + \`ATLAS_GAIT\` 乘 1.45 + SPECIES 的 flee/huntSpeed | 探针：稳态 40 跑 / 200 走 / 449 休息 |
| 生命工具条缺 4 个新物种 | \`LIFE_TOOLS\` 手写 11 项 | 改为 \`[...SPECIES_IDS]\` | \`client.test.mjs\`：每个 SPECIES_IDS 都必须在 LIFE_TOOLS 里 |
| 树挡不住动物 | 植物画进 1px 地面缓冲，动物最后画在显示层 | \`drawDepthLayers\`（植物与动物合并按 y 排序）+ \`spriteToCanvas\` | 截图目视 |

同时放宽/收紧了几个数值：种群上限 兔 620→400、鱼 520→170、青蛙 420→160（高倍下会叠成一堵墙）；
逃跑 1.35–1.7 → 1.85–2.15、捕猎 0.9–1.15 → 1.25–1.55。三种子 soak 复测：11 物种全部 \`zero@0\`，
吞吐 337–378 tick/s。

**还没做**（用户明确说后面再说）：衰老掉属性（\`STAGE_SPEED\` 只有速度差，能量/视力不随年龄变）、
同类争斗、疾病。尸体是**已有**的（\`meatGain\` + 乌鸦 scavenge 在用）。

---

**最后一件事**：这个项目的用户在评价时会**实际打开界面看**，并且多次因为"看起来没变化 / 点不动"而退回。
所以任何改动交付前，至少要有一张真浏览器截图或一段可复现的验证输出，而不是"测试通过"四个字。