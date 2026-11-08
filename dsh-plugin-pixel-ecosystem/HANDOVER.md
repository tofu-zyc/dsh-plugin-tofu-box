# 交接文档（HANDOVER）

> 面向：接手 `dsh-plugin-pixel-ecosystem` 的下一个会话 / 下一个 agent。
> 读完这一份就应该能直接开工，不需要重新读 5000 行 `client.js`。
> 用户视角的玩法说明在 [README.md](README.md)，设计契约在 [DESIGN.md](DESIGN.md)；本文只讲**交接需要知道的东西**：现在是什么状态、代码在哪、怎么验、哪里有坑、下一步做什么。

---

## 0. 三十秒定位

一个 DeepSeek Harness 的**纯前端插件**：侧边栏点开，主面板整块画布上跑一缸 640×400 格的像素生态（草/水草两条生产者链 → 陆地与水下两个食物网 → 遗骸腐烂回肥力，闭环）。动物有五种需求、八种意图、三个生命阶段、六项可遗传基因。Host 半是空的 `apply()`，所有逻辑在 `client.js`，世界存在 `localStorage`。

**它现在能玩**：能放生物、能看它们觅食/逃跑/捕猎/繁殖、能放大缩小平移、能点开看详情。**但它还不是"完成品"**：奔跑只有两帧、捕食者种群偏低、没有社会系统——这三件事是下一阶段的主线。

---

## 1. 仓库与发布状态（事实）

| 项 | 值 |
| --- | --- |
| 代码位置 | `D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem\`（主检出，分支 `main`） |
| 本地 `main` | `9c87bb4`（插件本体 `826c2e8` + 移出伞包 `9c87bb4`） |
| 领先 `origin/main` | 5 个提交（其中 3 个是动手前就有的本地提交） |
| **是否 push** | **没有**。用户明确说先不发布到 GitHub |
| 任务 worktree | `D:\program\dsh-plugins\.agents\worktrees\dsh-618168f5-19d4`，分支 `dsh-618168f5-19d4`，停在 `826c2e8`（比 main 少"移出伞包"那个提交） |
| npm | `dsh-plugin-pixel-ecosystem@0.1.0` **已提交成功**，但 npm 2026 的 staged publishing 机制下当前只显示 `0.0.0-stage` 占位；**需要 maintainer 在 npm 页面批准**，`0.1.0` 才会出现在版本列表、才能被安装 |
| 伞包 | **本插件不进 `tofu-box`**。清单里 `dsh.umbrella: false`；`tofu-box` 仍是 `1.2.3`（6 个成员），未改动、未重新发布 |
| 未跟踪目录 | 主检出里有 `.npm-cache-dev/`、`.review/` 两个本地目录（曾是别的任务的临时产物）。一次 `git add -A` 误把它们提交进去，已 `reset --soft` 修正。**建议加进 `.gitignore`**（未擅自改） |

发布命令（在仓库根、用会加载 profile 的 pwsh，才能拿到 `NPM_TOKEN`）：

```powershell
pwsh -NoLogo -File publish.ps1                                   # dry-run 预览文件清单
pwsh -NoLogo -File publish.ps1 -Publish dsh-plugin-pixel-ecosystem
```

⚠️ `publish.ps1` 从**脚本所在目录（主检出根）**打包，并且只认主检出里 **git 已跟踪**的插件目录。所以从 worktree 分支发布必须先合并进本地 `main`——这就是当初合并的原因。

---

## 2. 代码地图

全部游戏逻辑在一个文件里（刻意如此：单文件 `client.js` 由 `window.__ModuleLoader__` 直接加载，无构建步骤）。

| 文件 | 职责 |
| --- | --- |
| `client.js`（约 5200 行 / 257 KB） | 引擎 + 渲染器 + Store + 面板 UI，全部在这里 |
| `index.js` | Host 半：只导出 `name` + 空 `apply()`，注释解释了为什么不注册任何东西 |
| `cordis.patch.yml` | bundle patch：插入一行 `pixel-ecosystem` |
| `package.json` | `dsh.bundle.patch`、`dsh.client.platform: web`、`dsh.umbrella: false`、`files` 白名单 |
| `locale/zh.json` `locale/en.json` | 只有插件元信息（面板标题），面板内的文案在 `client.js` 的 `CHINESE`/`ENGLISH` 字典里 |
| `assets/atlas.png` | 精灵图集**源文件**（运行时用的是内嵌 base64，此文件仅供参考/再生成） |
| `tests/*.test.mjs` | 58 个测试（引擎 / 渲染 / 平衡长跑 / 面板与 bundle） |
| `tests/browser-harness.html` | **真浏览器**验证页（见 §6） |
| `icon.svg` | 侧边栏图标 |

`client.js` 内部分区（按出现顺序，行号基于 `9c87bb4`）：

| 区段 | 大致行 | 内容 |
| --- | --- | --- |
| 常量 | 39–60 | `STORAGE_KEY` / `GRID_W=640` / `GRID_H=400` / `TICK=0.1` / `DAY_SECONDS=120` / `MAX_ENTITIES=3600` / `MAX_TREES=1900` |
| `SPECIES` 表 | 61–230 | 7 个物种，每个一行：栖息地、role、食物、天敌、领地、群聚、活动时段、飞扑参数、基因范围、平衡常数 |
| 地形生成 | 约 230–700 | 八度噪声 → 模糊 → 分位数取水 → 保留最大水体 → 岸距 → 沙/石/土 |
| 生产者与植被 | 约 1000–1300 | 两个场（`grass`/`weed`）、树与灌木、肥力 |
| 需求/决策/成长 | 约 1300–1700 | `NEED_KEYS` / `ROLE_TRAITS` / `NEED_WEIGHT` / `STAGE_*` / `decayNeeds` / `decide` |
| 实体步进 | 约 1700–2100 | `stepEntity` / `feed` / 繁殖（窝仔）/ 死亡 / 领地判定 |
| 放置与统计 | 约 2100–2400 | `place` / `releaseAnimals` / `nearestValidCell` / `sampleStats` / 存档序列化 |
| 精灵与调色板 | 约 2400–3000 | 程序化精灵（低分辨率回退用）、`PALETTE`、**内嵌图集 base64**、`ATLAS`/`ATLAS_SLOTS`/`ATLAS_SIZE` |
| 渲染器 | 约 3000–3400 | `paintView`（视口）/ `paintGround` / `paintPlants` / `paintAnimals` / `paintActivity` / `paintMinimap` / `drawAtlasAnimals` |
| Store | 约 3400–4000 | rAF 循环、`setView`/`draw`/`paintAt`/`selectAt`、离屏放大、自动存档、`markDirty` 合并快照 |
| 字典与文案 | 约 3950–4150 | `CHINESE` / `ENGLISH`（键必须完全对齐，有测试） |
| 相机与输入 | 约 4260–4700 | `viewFromCamera` / `worldFromPoint` / `cameraAfterZoom` + 面板的原生事件监听 |
| 面板 UI | 约 4400–5000 | `TerrariumPanel` / `Inspector` / `PopulationChart` / `Minimap` / `PanelBoundary`（错误边界） |
| 样式 | 约 5000–5150 | 单段 CSS，全部 `.pe-` 前缀 |

---

## 3. 引擎：数据模型与 API

### 3.1 `World`（可 JSON 序列化）

```js
{
  width, height, tick, time, seed, rng,
  terrain: Uint8Array,       // GRASS|WATER|SAND|DIRT|STONE
  grass: Float32Array,       // 陆地生产者 0..1
  weed: Float32Array,        // 水下生产者 0..1
  fertility, waterFertility, moisture, shore,
  trees: [{ id, x, y, variant: 'tree'|'bush', size, age, foliage, seedTimer }],
  entities: [{ id, species, x, y, prevX, prevY, heading, energy, age, generation,
               cooldown, genes, needs, intent, stage, alarm, fleeing, flightTime,
               phase, thinkTimer, herdTimer, herdAnchor, targetX, targetY, children }],
  corpses: [{ x, y, energy, age, decay }],
  effects: [{ x, y, vx, vy, life, maxLife, color }],   // 纯装饰，模拟不读
  population: { rabbit: n, ... },                      // 每物种计数缓存
  history: [{ tick, counts }],
  immigration: true|false,
}
```

`population` 是缓存：任何**直接替换 `world.entities`** 的代码路径都必须重建它（`countPopulations`）。`place`/`killEntity` 会自己维护。

### 3.2 导出（`module.exports.__engine`）

```
SPECIES SPECIES_IDS TERRAIN GENE_KEYS NEED_KEYS INTENT_IDS ROLE_TRAITS STAGE_SCALE
TUNING PALETTE SPRITES SPRITE_GRIDS PLANT_SPRITES SPRITE_COLORS
TICK DAY_SECONDS MAX_ENTITIES
createWorld stepWorld place spawnEntity findEntityAt sampleStats pushHistory
serializeWorld deserializeWorld
paintView paintWorld paintMinimap frameFor
viewFromCamera worldFromPoint cameraAfterZoom
countSpecies handleImmigration settleTerrain computeHydrology
createStore GLYPHS PANEL_GLYPH
```

`module.exports.__test` 额外导出组件与字典，供测试直接调用。

### 3.3 需求 → 决策 → 意图（这是接社会系统的地基）

- 五个需求通道：`hunger` `thirst` `energy` `safety` `social`，0 = 满足，1 = 临界。
- 每 0.22–0.55 秒决策一次，对所有候选行动打分：

  ```
  score = NEED_WEIGHT[role][need] × (need + 偏移) × 性格修正 − 距离成本(≤0.45)
  ```

- 八种意图：`flee` `forage` `hunt` `scavenge` `drink` `rest` `socialize` `explore`，写入 `entity.intent`。
- 三个生命阶段：`juvenile` / `adult` / `elder`，影响体型（0.6/1/1.03）、速度（0.78/1/0.82）、食量（1.3/1/0.85）；**只有 adult 能繁殖**。
- 详细表格见 [DESIGN.md §2.2](DESIGN.md)。

**加一个新物种只需要**：一条 `SPECIES` 行 + 一个图集槽位（`ATLAS_SLOTS`/`ATLAS_SIZE`），行为代码零改动。

---

## 4. 渲染管线（为什么它看起来像像素游戏）

1. **地面**（地形 / 草 / 水草 / 树 / 灌木 / 尸骸 / 特效）画进一个**每格 1 像素**的小缓冲：`paintView(world, view, buffer, alpha, overlay, options)`。
2. 该缓冲 `putImageData` 到离屏 canvas，再用 `drawImage` **最近邻放大**到显示 canvas（`imageSmoothingEnabled = false`）。
3. **动物**不画进小缓冲，而是从图集以**显示分辨率**绘制（`drawAtlasAnimals`）：idle / run 两帧 + 步态起伏（`bob`）+ 轻微拉伸挤压（`stretch`）+ 朝向翻转。
4. 位置插值：模拟固定 10 Hz（`TICK=0.1`），渲染时按 `alpha = accumulator / TICK` 在 `prevX/Y → x/y` 之间线性插值，所以 60fps 下是平滑移动。
5. 昼夜与晨昏：`draw()` 结尾两层 `fillRect`（夜色 55% + 晨昏暖色 16–18%）。
6. 图集：4×4 单元、每格 52×46 px、基线 44 px，14 个槽位（7 物种 × idle/run），**base64 内嵌**在 `client.js`（离线可用，无需 Host 路由）。

> 为什么不用 `<img>` 直接铺满：地面如果按显示分辨率渲染，640×400 全图放大 6 倍就是 900 万像素/帧，JS 里跑不动。所以地面低价、动物高清，这是刻意的混合分辨率。

---

## 5. 交互与相机（有强不变式，别绕开）

**唯一一套坐标换算**，渲染与输入都调用它：

```js
viewFromCamera(camera, stage, world)        // {x, y, width, height, scale, offsetX, offsetY}
worldFromPoint(view, stageRect, clientX, clientY)   // 屏幕 → 世界格
cameraAfterZoom(camera, stage, world, stageRect, clientX, clientY, nextScale) // 缩放锚定指针
```

验证过的数值（`probe-camera` 写法见 §6）：4× → 7× 缩放，指针下的世界点漂移 **0.319 格**（≈2 px，来自整数格取整），反算精确。

### 5.1 工具与手势

| 工具 | 左键单击 | 左键拖动 | 右键 | 滚轮 |
| --- | --- | --- | --- | --- |
| `pointer`（默认） | 选中动物 / 点空地取消 | 平移地图 | 取消选择 | 以指针为中心缩放 |
| 生命/地形刷子 | 落笔一次 | 连续涂抹 | 擦除 | 同上 |

中键拖动在任何工具下都是平移。放置动物后底部弹 toast（`放出了 N 只` / `这里放不下…`）。

### 5.2 不变式（踩过两次的坑）

1. **任何构造 `view` 对象的地方都必须带上 `scale`**。`setView()` 和 `newWorld()` 各漏过一次，症状是"画面塌到左上角 + 点击全部偏移"。
2. 相机数学**只能有一份**。曾经组件里一份、事件里一份，导致缩放锚点漂到右下角。
3. 事件用**原生监听**绑在 stage 上（`pointerdown/move/up/cancel` + `wheel{passive:false}` + `contextmenu`），capture 放在 canvas 上。
4. 拖动时若 `event.buttons === 0`（丢过 pointerup）必须**立即结束手势**，否则刷子会粘住。
5. `attach()` 只在换 store 时做一次；`detach()` **不要**存盘（曾经每次平移都序列化整个世界）。

---

## 6. 怎么跑、怎么验

### 6.1 单元测试（快，每次改完必跑）

```powershell
cd D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem
node --test tests/*.test.mjs
```

当前：**58 个测试全绿**。四个文件各自的分工：

- `engine.test.mjs`：地形、生产者、需求、决策、繁殖、领地、存档往返、放置上限
- `render.test.mjs`：像素缓冲、精灵尺寸、裁剪、图集槽位
- `balance.test.mjs`：两种子 × 长跑（约 20000 tick），断言"没有物种永久灭绝 / 每个物种能到可行峰值 / 不超过 cap / 生产者覆盖率 / 吞吐 > 80 ticks/s"
- `client.test.mjs`：bundle 在裸 VM 里启动、slot 注册、字典键对齐、CSS 前缀、面板渲染树

### 6.2 真浏览器渲染校验（改渲染/交互必跑）

```powershell
# 从工作树根目录跑（harness 里引用 ../client.js）
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --user-data-dir="$PWD\.chrome-verify" --window-size=1120,780 `
  --virtual-time-budget=6000 --screenshot="$PWD\shot.png" `
  "file:///$((Resolve-Path 'dsh-plugin-pixel-ecosystem\tests\browser-harness.html').Path -replace '\\','/')"
```

页面顶部会打印 `ready=… canvas …x… paintedSamples=N | failures=[]`。判据：`failures` 为空、`paintedSamples` 是四位数（不是 200 那种"只画了左上角"）。

### 6.3 起开发服务看真界面

```powershell
cd D:\program\dsh-plugins
pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0     # 输出带 ?token= 的 URL，交给用户打开
```

规矩（见仓库 `AGENTS.md`）：插件只在 `rc-dev` / `alpha-dev` 两个 profile 里测，**不许**装进 `desktop` / `web`；不要用 computer-use 去点用户正在用的窗口。

### 6.4 探针（调参用，写完就删）

临时脚本放在**工作树根**（不是插件目录），用裸 VM 启动 bundle：

```js
const source = readFileSync('./dsh-plugin-pixel-ecosystem/client.js', 'utf8')
const React = { createElement: () => null, Component: function () {}, Fragment: 'F',
  useState: v => [v, () => {}], useEffect() {}, useRef: v => ({ current: v }),
  useCallback: f => f, useMemo: f => f(), useSyncExternalStore() {} }
let entry
new Function('window', 'require', 'btoa', 'atob', source)(
  { __ModuleLoader__: { load: o => { entry = o } } },
  id => { if (id === 'react') return React; throw new Error(id) }, btoa, atob)
const E = entry.factory(id => id === 'react' ? React : (() => { throw new Error(id) })()).__engine
```

平衡长跑示例：`createWorld({ seed })` → 循环 `stepWorld(world, TICK)` 24000 次 → 每 1000 tick 记一次 `sampleStats(world).counts`。

---

## 7. 已知缺陷（按严重度）

| # | 问题 | 现状 / 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | **捕食者与乌鸦种群偏低** | 长跑峰值：fox 4–17（cap 170）、crow 6–21（cap 220）、deer 12–38（cap 260）；兔 5–607、鱼 16–91 | 食物网"看着不够热闹"，捕食压力不足 |
| 2 | **奔跑动作只有两帧** | `SPRITE_GRIDS[species].walk` 长度 2 + 程序化 bob/stretch | 用户明确吐槽"不像正常动物在跑" |
| 3 | **地面放大后偏块状** | 1 px/格 → 最近邻放大；没有 tile 贴图 | 凑近看是色块，不是手绘地形 |
| 4 | **性能余量不大** | 640×400、约 600 实体时 470–520 tick/s；8× 播放需要 80 tick/s | 8× 时 CPU 约 35%，再加物种会掉 |
| 5 | **狼没有真正的包抄** | 只有"朝同一目标靠近"的群巡 | 群体行为单薄 |
| 6 | **乌鸦没有群栖/迁徙** | 只在视野内找尸体 | 同上 |
| 7 | **单世界存档** | `localStorage` 一个 key，换世界会覆盖旧档 | 想对比两个世界得手动导出 |
| 8 | **假 React 测试有结构性盲区** | `useState` setter 是 noop、`useRef` 永不赋值、`useEffect` 只跑一次、无依赖比较、无 DOM | DOM/Canvas/交互类 bug 在单测里**永远测不出来** |
| 9 | **社会/文明系统只有接口** | `intent` / `needs` / `stage` / `genes` 已预留，没有实现 | 路线图 v0.4 |

---

## 8. 下一步做什么（带验收标准）

### 8.1 奔跑四帧动画（用户第一优先）

1. 用 imagegen 生成「7 物种 × 4 帧奔跑循环」条带（洋红底、每物种同一体型/朝向）。
2. 切片 → 加入图集（扩到 4×8 或两个图集）→ `ATLAS_SLOTS` 改成 `{ idle, run: [f0..f3] }`。
3. `drawAtlasAnimals` 按步态相位取帧：`phase = (world.tick * 0.55 + animal.phase) % 1`，四帧循环。
4. **验收**：`tests/browser-harness.html` 里连续截图 4 帧，四张的腿位不同；单测里断言 `ATLAS_SLOTS[species].run.length === 4`。

### 8.2 平衡调参（用数据，不要瞎试）

1. 先写一个**意图/需求分布**探针：跑 5000 tick，统计每个物种的 `intent` 直方图、平均 `hunger`/`energy`、平均寿命、死亡原因（饿死/老死/被捕食）。
2. 用探针结果定位瓶颈：是"找不到食物"（forage 失败率高）、"一直去喝水赶路"（drink 意图占比过高），还是"能量永远到不了 `breedEnergy`"。
3. 只调三个旋钮：`NEED_WEIGHT`、`decayNeeds` 速率、`balance.drain`。
4. **验收**：`balance.test.mjs` 里把 `VIABLE_PEAK` 的 fox/crow 提高到 40/60 且仍然两种子通过。

### 8.3 社会系统原型（v0.4 起点）

不改引擎内核，先加一个**聚落层**：`world.settlements`（`{ id, speciesId, x, y, members: Set, stores: { food }, buildings: [] }`）。
用现有字段驱动：动物的 `intent` 加一个 `returnHome`，`needs.social` 高且离聚落远时回家；聚落按成员数量累积/消耗 `stores.food`。
**验收**：一个物种的成员会稳定回到同一坐标附近聚集，聚落粮食随成员数增长，饿死率下降。

### 8.4 若要继续优化性能

先加计数器再优化：`stepEntities` 里分别计时「空间查询 / 决策 / 移动」，`growField` 计时「生长」。已知可优化点：`growField` 的切片（现在 `GROWTH_SLICES = 8`）与 `herdCentroid` 的缓存频率。

---

## 9. 决策记录（为什么是现在这样）

| 决策 | 理由 |
| --- | --- |
| 单文件 `client.js`、无构建 | 客户端半边由 `__ModuleLoader__` 直接加载，构建链会引入 CI/发布复杂度 |
| 640×400 格（不是 320×200） | 用户明确嫌地图小；靠**视口渲染**（只画可见格子）控制成本 |
| 1 游戏日 = 1 生态年 | 真实"一年一胎"要等 365 天没人看得到；压缩规则写在 DESIGN §2.1，可核查 |
| 速度按 0.35 缩放 | 真兔子 12.5 m/s（45 km/h）会 25 秒横穿地图 |
| 物种用数据表 | 加物种只写一行数据 + 一个图集槽位，行为代码零改动 |
| 需求/效用决策而非 if 链 | 用户要"决策/习性/饥饿/成长"系统，也是社会系统的前置 |
| 地面 1px/格 + 动物显示分辨率 | 地面全分辨率渲染跑不动（900 万像素/帧） |
| 图集 base64 内嵌 | 离线可用、不依赖 Host 路由、单文件发布 |
| 不进 `tofu-box` 伞包 | 用户明确要求；用 `dsh.umbrella: false` 让同步校验跳过 |
| 先不 push GitHub | 用户明确要求 |

---

## 10. 踩过的坑（必须记住）

1. **`view` 字面量漏 `scale`**：已发生两次（`setView`、`newWorld`）。症状是"画面只剩左上角 + 点击坐标全错"。加新代码时搜一下所有 `view = {`。
2. **相机数学不能有两份**：两份就会有一个锚点漂。现在只有 §5 那三个函数。
3. **假 React harness 测不出 DOM 问题**：`useState` 的 setter 是 `noop`、`useRef` 永远是初始值、`useEffect` 只跑一次且丢 cleanup、`useCallback` 不比较依赖、没有 DOM。凡是碰 canvas/事件/CSS 的改动，**必须**跑 §6.2 的真浏览器 harness。
4. **`publish.ps1` 只认主检出里被 git 跟踪的目录**：从 worktree 分支发布必须先合并进本地 `main`。
5. **npm staged publishing**：发布成功 ≠ 立即可装，需要 maintainer 批准；用 `npm view <pkg> versions --json` 确认。
6. **不要按进程名 kill 进程**：曾经 `Get-Process chrome | Stop-Process -Force` 把用户正在用的浏览器一起杀了。只 kill 自己 `Start-Process` 返回的那个 PID。
7. **`git add -A` 会带上未跟踪的本地目录**：主检出里 `.npm-cache-dev/`、`.review/` 就被误提交过一次。提交前先 `git status` 看清楚。
8. **`population` 缓存一致性**：任何直接替换 `world.entities` 的路径都要重建缓存，否则 immigration/上限判断会读旧数。
9. **饥饿会抢占休息**（`decide` 里 `needs.hunger < 0.62` 才考虑 `rest`）：去掉这个门会让动物"饿着不吃饭去睡觉"，种群直接崩。

---

## 11. 交接检查单

新会话开工前，按顺序确认：

- [ ] `cd D:\program\dsh-plugins\dsh-plugin-pixel-ecosystem && node --test tests/*.test.mjs` → 58 通过
- [ ] `git -C D:\program\dsh-plugins log --oneline -3` → 顶部是 `9c87bb4`
- [ ] `npm view dsh-plugin-pixel-ecosystem versions --json` → 若仍只有 `0.0.0-stage`，说明还没批准，别在 README 里写"已可安装"
- [ ] 跑一次 §6.2 的 harness，确认 `failures=[]`
- [ ] 需要看真界面：`pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0`，把带 token 的 URL 交给用户
- [ ] 动手前先读 §5.2 的不变式与 §10 的坑

---

**最后一件事**：这个项目的用户在评价时会**实际打开界面看**，并且多次因为"看起来没变化 / 点不动"而退回。所以任何改动交付前，至少要有一张真浏览器截图或一段可复现的验证输出，而不是"测试通过"四个字。
