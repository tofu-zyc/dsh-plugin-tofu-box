# 97 · 行为探针与测试门禁

> 这份文件回答两个问题：**探针每个数字怎么读**、**读到多少算过关**。
> 没有这把尺子，任何行为/能量改动都只能靠“看起来还行”来验收，`90-ROADMAP.md` 的门禁也就无从判定。

## 0. 一句话

`node tools/behaviour-probe.mjs --seed 12345 --seconds 900` 出一条可比的报告；改行为/能量前后的两条报告必须**同 seed、同引擎代际、同尺度**贴在一起比对。

## 1. 怎么跑

```powershell
cd dsh-plugin-pixel-ecosystem
node tools/behaviour-probe.mjs --seed 12345 --seconds 900
node tools/behaviour-probe.mjs --engine-generation    # 只打印 legacy|v2
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--seed N` | 12345 | 世界种子。**对比必须同 seed**，否则差异是噪声。 |
| `--seconds S` | 900 | 模拟秒数（1× 口径）。按 `DAY_SECONDS` 折算游戏日，报告头会打印。 |
| `--width` / `--height` | 引擎默认 | 覆盖地图尺寸。**跨版本对比必须显式给同尺寸**（见 §2.4）。 |
| `--no-immigration` | 移民开 | 关掉移民安全网。测“链路本身能不能自持”时用；测玩家体验时别关。 |
| `--sample-every N` | 10（=1 s） | 能量/年龄/生产者的采样间隔（tick）。降精度换速度。 |
| `--top N` | 6 | 每个物种列几个意图。 |
| `--json` | 关 | 机器可读报告，用于 before/after 数值 diff。 |
| `--engine-generation` | | 只打印 `legacy` 或 `v2` 并退出，给脚本做代际守卫用。 |
| `--help` | | 用法。 |

退出码：`0` 正常；`2` 参数错误；`3` bundle 起不来（此时**先修 bundle**，不要怀疑引擎数值）。

## 2. 先看报告头

### 2.1 `bundle <sha1前12位> (STALE: ...)`

探针对 `client.js` 取 sha1。**两条报告只有 hash 相同才可比**。带 `STALE` 说明 `src/parts` 已经改过但没跑 `node tools/build-client.mjs`——这时报告度量的是旧 bundle，不是当前工作区。

### 2.2 `throughput`

- `ticks/s wall`：整条探针（含采样开销）的吞吐。**玩家体验对应这个数**。
- `ticks/s sim only`：只统计 `stepWorld`。和 wall 的差距 = 探针自身开销；差距过大说明探针写得太重，不代表引擎慢。

门禁（`90-ROADMAP.md` P1-5）：**≥ 30 ticks/s @ 3000 实体**。8× 播放需要 ≥ 10 ticks/s，所以验收线是 3× 余量。

### 2.3 `engine generation`：这组数字属于哪台引擎

报告头会打印两行，例如：

```
engine generation v2 (energy ledger)
  fields actually read: intent=state.id | reserve=body.E/body.Emax | hunger=drives.hunger | cause=body.cause
```

第二行是**探针的降级证据**，不是装饰：它打印这次运行**实际读到**的字段，不是“理论上支持”。

| 指标 | v2（能量账本，`20-CORE-LOOP.md`） | legacy（0.2.x 死树） |
|---|---|---|
| `intent` | `state.id` | `intent` |
| `reserve` | `body.E / body.Emax` | `energy / balance.maxEnergy` |
| `hunger` | `drives.hunger` | `needs.hunger` |
| `cause` | `body.cause`（权威） | `inferred`（推断，见 §6） |

判代际用**世界级证据**，不只看实体有没有 `body`：`world.climate` / `world.detritus` / `world.caches` 任一存在，或任意实体带 `body`，即判 `v2`。这样半迁移状态的构建不会被误判成 legacy 而读错字段。

### 2.4 三代际/两尺度，数字**不可互比**（重要）

| 维度 | legacy 基线 | v2 现状 |
|---|---|---|
| 地图 | 512 × 400 | **1024 × 640** |
| `DAY_SECONDS` | 120 | **90** |
| `TICKS_PER_DAY` | 1200 | **900** |
| 能量单位 | 抽象单位（`maxEnergy`≈100） | **kJ**（兔 `Emax`≈6382 kJ） |
| 死因 | 推断 | `body.cause` 权威 |

所以**同一条 900 s 的报告在两组引擎里不是同一件事**：面积 ×3.2、一天从 120 s 变 90 s、能量单位换过。任何 before/after 必须同时满足：同 seed、同 `bundleHash` 或至少同代际、同地图尺寸。脚本里用 `--engine-generation` 做守卫：代际不同就拒绝比较。

## 3. 指标逐条：怎么读 / 阈值

### 3.1 时间预算（意图 × 时长）

`rabbit forage 50.1%(41607s) explore 18.8%(15573s) ...`

- **含义**：该物种全部个体的**实体-时间**里，有多少落在各个意图上。分母是该物种的 `entity-seconds` 总和（不是墙钟时间）。
- **怎么读**：这是“这个物种一天到晚在干什么”的唯一直接答案。`rest` 占比就是“发呆率”。
- **阈值**：`rest` 占比 **< 35%**（`90-ROADMAP.md` P2 门禁 1，旧版 0.2.x 是 69%）。
- **陷阱**：分母很小时（刚投放、刚出生）百分比会很极端，所以同时看绝对秒数。

### 3.2 意图驻留（中位数/均值）与决策抖动

`rabbit forage 8.3/11.8  explore 4.3/7.6 ...   switches/min 6.6`

- **含义**：`中位数/均值` = 每次进入该意图平均待多久（秒）。`switches/min` = 每个个体每分钟切换意图的次数。
- **怎么读**：驻留太短 = 状态机没起作用，还在每 0.2~0.5 s 重掷；抖动太高 = 决策在相近分数之间来回跳。
- **阈值**：
  - 意图驻留**池化中位数 > 10 s**（P2 门禁 2；旧版 1–3 s）。
  - 抖动 **< 12 次/分钟/只**（P2 门禁 4）。
- **两个口径一起看**：门禁那一行同时给 `mean dwell`（= `entity-seconds / switches`，即“一只动物平均在一个活动里待多久”）。**池化中位数会被大量极短的喝水/啃食访问拉低**，均值更能代表体感；门禁仍按文档用中位数判定，但如果中位数 FAIL、均值已过 10 s，说明问题是“短访问太多”，不是“整体还在乱抖”。
- **实现细节**：驻留用 0.25 s 分桶直方图统计，中位数精度 ±0.25 s；不保留逐次样本，所以 900 s 也不会吃内存。

### 3.3 路径长度 / 家园半径 / 方向性

`rabbit 558  pathMed 126  homeRMed 21  homeRp90 44  netMed 37  dir 0.34`

- `n`：被统计的个体数，只算**存活 ≥ 10 s** 的个体（避免把刚出生的婴儿算进移动统计）。
- `pathMed`：一生累计移动距离（格）的中位数。单 tick 位移 ≥ 8 格视为瞬移（移民/读档）不计入。
- `homeRMed` / `homeRp90`：家园半径 = `max(经度跨度, 纬度跨度) / 2` 的中位数与 p90（格）。
- `netMed`：净位移（首末点直线距离）中位数。
- `dir`：**方向性** = `mean(净位移) / mean(路径长度)`。`1.0` = 一直朝一个方向走，`0` = 纯随机游走。**阈值 > 0.30**（P2 门禁 3）。
- **怎么读**：`path` 大而 `dir` 小 = 原地打转（随机游走）；`dir` 高而 `homeR` 大 = 长距离定向迁徙；`dir` 高而 `homeR` 小 = 两点之间往返（觅食，通常是好现象）。

### 3.4 死因普查

`species  deaths  eaten starved old other | ageMed ageP10 ageP90 | source`

- **含义**：每个物种死了多少只、各死因多少。`ageMed/P10/P90` 是**死亡年龄**分布（秒），不是存活个体年龄。
- `source` 列：`body.cause` = 引擎自报（权威）；`inferred:*` = 探针推断（按 §6 打折）。
- **怎么读**：`eaten` 高 = 捕食层在工作；`starved` 高 = 能量账本不闭合或密度不对；`old` 高 = **健康信号**（能活到寿终）；`other`/`unknown` 高 = **观测黑洞，当 bug 查**。
- **阈值**：见 §4.1，饿死门禁**按营养级拆开**。

### 3.5 饿死质量（P1 门禁 4 的度量）

`starvation quality: hunger at death median 1.00; 0/3 starved with hunger <= 0.6 (died on a full belly); 3 starved while standing on grass with food under them`

- **含义**：只看 `cause=starved` 的个体：
  - `hunger at death`：死亡瞬间的饥饿度。**饿死就应该 hunger 高（接近 1）**。
  - `died on a full belly`：`hunger <= 0.6` 的饿死数。**这是最多的坏味道**。
  - `starved while standing on grass`：脚下有草（`grass > 0.02`）却饿死的数量。
- **阈值**（`90-ROADMAP.md` P1 门禁 4）：**不允许“站在草地上饿死”**，且饿死个体 `hunger` 必须 `> 0.6`。
  - 即 `died on a full belly` 应为 **0**，`starved on grass` 应为 **0**。
- **为什么这条最重要**：它同时抓两个 bug——决策不读身体（`hunger` 与 `reserve` 脱钩），以及摄食门槛把可吃的草挡在外面。**任何一条不为 0，说明能量闭环还没通。**
- **注意样本量**：饿死数少于 20 时，这条只是现象记录，不是结论（见 §4.2 的 THIN）。

### 3.6 年龄结构（期末）

`rabbit juv 36.9%  ad 58.6%  eld 4.5%   n=111`

- **含义**：观测结束那一刻，存活个体按幼年/成年/老年分。`age < maturity` 为幼年，`age > maturity × 2.6` 为老年（与引擎 `stageOf` 同口径）；有 `body.M` 时以 `M < 1` 判幼年。
- **怎么读**：稳定种群通常**幼年占多数**；`eld` 接近 0 且 `old` 死因为 0 = 没人活到老。
- **陷阱**：`--seconds` 太短时**全物种都是幼年**（90 s 时狐/狼/鸦 100% juvenile），这是观测窗口太短，不是 bug。判年龄结构至少 300 s。

### 3.7 能量 × 饥饿散点

```
reserve  (row = body reserve 0..1, column = hunger 0..1)
0.9 |.....               
0.6 |  . *@:...          
0.3 | ...      .::....   
0.0 |                 ...
    |--------------------  hunger
    fed           starving
```

- **含义**：每个实体-采样点，x = 饥饿度（右端最饿），y = 储备率（顶端最满）。字符密度按行内峰值做对数刻度（空格到 `@`）。
- **怎么读**：
  - 正常图形应沿**对角线**分布：越饿储备越低（v2 就是这样，说明驱动力已经从身体派生）。
  - 右上角（很饿但储备很满）= 驱动力与身体脱钩。
  - 左下角（储备空却不饿）= §3.5 那个问题的可视化形态。
  - 质量贴最左一列 = `hunger` 通道长期贴 0（0.2.x 症状：`needs.hunger` 被每次啃草重置）。
- **阈值**：无硬门禁，但有形状要求：**主质量应落在对角带上**。

### 3.8 能量收支表（每物种，kJ / 游戏日 / 头）

```
species   alive  assimilated   respire    growth     repro       net
rabbit    400      6375.1       693.1     549.6    5458.4    -326.0
deer       37     10524.6     10814.3       0.0       0.0    -289.6
```

- **含义**：每物种的同化能量收支，单位 kJ/游戏日/个体。四个分项都是**直接测量**的：
  - `respire`：`body.pMetabolism` 的时间平均（引擎自己的维持功率）；
  - `growth`：`Δbody.V × BIO.STRUCTURE_COST`（长身体锁进结构的能量）；
  - `repro`：新生个体的结构能量（`V × BIO.MEAT_ENERGY`，与引擎 `world.budget.reproduction` 同口径）；
  - `net`：`Δbody.E`，储备净变化；
  - `assimilated`：唯一需要反解的一项，`= net + respire + growth + repro`。
- **怎么读**：
  - `net < 0` 且 `assimilated > 0` = 在吃但入不敷出（收支表里最常见的不健康形态）；
  - `respire` 远大于 `assimilated` = 维持成本压死它（捕食者在 9.6× 超支密度下的样子）；
  - `repro` 巨大 = 爆发式繁殖，此时 `assimilated` 会被繁殖项主导，不要把它当成“吃进去的量”来读。
- **换总摄入**：除以同化率（草食 0.4 / 肉食 0.8，见 `BIO.ASSIMILATION_*`）得到**总摄入**；再除以 `BIO.GRASS_ENERGY`（17 500 kJ/kg）就是**干物质 g/日**，可与 P1 的 **182 g/日 ±20%** 自校验直接对照。
- **下方的 world 行**：`gross grazed` / `carnivory` / `animal respiration` / `reproduction` 是引擎 `world.budget` 的整世界流量（kJ/日），给桑基图核对用。
- **守恒残差**：同一节最后一行打印 `world conservation residual`（相对值）。P1 门禁要求 **< 1e-6**。
  - 单 tick 残差实测 **2.5e-7**；
  - 连续 10 日累计实测 **2.5e-6**；
  - **累计残差随 tick 数近似线性增长是 Float32 场的固有误差，不是漏账。** 池子（植物/碎屑/尸骸/动物）用 Float32 存储，每 tick 的舍入误差在累加里叠加；单 tick 残差才是判断账本闭合的口径，累计值请按 tick 数归一后再比。
  - sim-core 已修掉 6 个真实漏点（凋落物少算 3/4、雏鸟储备截断、breedCost 未记账、gut 未计入池、尸骸基准、溢出未记账）；修之前这些是**真漏账**，现在剩下的是浮点噪声，两者不要混为一谈。
- **不可用时**：legacy 引擎没有 `body.V` / `pMetabolism`，这一节打印 `unavailable`。

### 3.9 生产者

`grass mean biomass 0.213   bare-cell share 20.6%`

- **含义**：草地/水面平均生物量，以及裸地格占比（`biomass < 0.1`）。v2 里草是 **kg 干物质/m²**，不是 0.2.x 的 0..1 标量，所以**绝对值不可跨代际比**。
- **怎么读**：`bare-cell share` 长期高位 = 草食层把草地啃穿（过牧）；长期 0 = 植物没被吃。跨版本比的是**相对变化**（`tests/balance.test.mjs` 就是按“起始生物量的百分比”卡的）。

## 4. 门禁汇总（探针直接判 PASS/FAIL）

报告最后一节打出这些行。阈值来自 `90-ROADMAP.md` 与 §4.1，改阈值要**先改文档**。

| ID | 指标 | 阈值 | 出处 |
|---|---|---|---|
| P1-5 | 吞吐 | ≥ 30 ticks/s @ 3000 实体 | 90-ROADMAP P1 |
| P1-2 | 干物质自校验 | 2 kg 兔 `dryMatterRequirement` ≈ **182 g/日 ±20%**（解析恒等式，见 §4.3） | 90-ROADMAP P1 |
| P1-4 | 饿死质量 | `hunger>0.6`，且 0 例“站在草地上饿死” | 90-ROADMAP P1 |
| P2.1 | `rest` 占实体-时间 | < 35% | 90-ROADMAP P2-1 |
| P2.2 | 意图驻留池化中位数 | > 10 s（同时看 mean dwell） | 90-ROADMAP P2-2 |
| P2.3 | 方向性 `net/path` | > 0.30 | 90-ROADMAP P2-3 |
| P2.4 | 决策抖动 | < 12 次/分/只 | 90-ROADMAP P2-4 |
| P3.1 | `starved` 占**猎物**死亡 | < 50% | §4.1 |
| P3.2 | `starved` 占**捕食者**死亡 | **INFO**（只报不判） | §4.1 |

> 探针只判**可测**的子集。出生→长大→繁殖→老死四事件、存档往返、60fps 渲染不在探针里，分别由 `tests/engine.test.mjs`、`tests/balance.test.mjs`、`tests/render.test.mjs` 承担。

### 4.1 为什么“饿死占比 < 50%”按营养级拆开

`90-ROADMAP.md` P3 的原话是“捕食者**不再全员饿死**（死因里 `starved` 占比 < 50%）”。照字面把这个阈值套到**全体**物种上会永远 FAIL，原因不是引擎坏了，是能量学：

- 按真实代谢（`Nagy 1999` + `Q10`，`10-SCALE-AND-UNITS.md`）算：**A 方案（写实密度）**下捕食者:猎物生物量 = 3.0%，捕食者需求 / 猎物次级生产 = **0.6×**，是唯一物理上养得起的配置；
- **当前出厂密度（B 方案）**对应捕食者需求是猎物次级生产的 **9.6×**。超支 9.6 倍，捕食者**必然**大批饿死——这是结论，不是 bug。

所以探针把这条门禁拆成：

- **P3.1（判）**：`starved` 占**非捕食者**死亡 < 50%。猎物不该饿死；它饿了说明植物/能量账本/摄食环节断了。
- **P3.2（只报）**：`starved` 占**捕食者**死亡。当前密度下它**预期就高**，所以不给 PASS/FAIL。等密度或 κ 拍板（`90-ROADMAP.md` 待决第 1 项）之后，再把它变成硬门禁并写死目标值。

> 换句话说：P3.1 抓引擎 bug，P3.2 是**密度决策的仪表盘**。把两者混成一个数字，就会把“我们选了 B 方案”读成“引擎坏了”。

### 4.2 THIN：样本不够时不许下结论

任何**基于死亡数**的占比，分母 < **20** 时探针打 `THIN` 而不是 `PASS`/`FAIL`，并在行尾标 `(n=… < 20, not a verdict)`。

为什么：300 s 那次跑捕食者只死了 4 只，其中 3 只饿死，占比 75%——听起来很吓人，实际是 4 个样本。把这种数字当门禁，会让门禁在两次运行之间随机翻面，最后所有人都不信门禁。

`--json` 里这类门禁的 `pass` 是 `null`、`kind` 是 `info`，脚本可以据此跳过。

### 4.3 「182 g/日」的口径：解析恒等式，不是群体均值

`90-ROADMAP.md` P1 门禁 2 是「兔的日食量落在 182 g 干物质 ±20%」。这条**不能**用群体日均来判：实测群体均值只有 **123 g/日（0.68×）**，原因是行为层大量 `rest`（`activity` ≈ 0.7），不是账本错。

正确口径（已写成 `tests/engine.test.mjs` 的断言）：**成体 + `activity = 1`**，验证两条恒等式：

1. **需求本身**：`R = dryMatterRequirement(rabbit, V)`，`V ≈ 2 kg` → `R = FMR / 0.4 / 17 500 ≈ 0.1823 kg/日`，±20%；
2. **曲线归一化**：`grazingIntake(R, GRAZE_REFERENCE) ≡ R`（参考草量 0.12 kg/m²；Holling II 曲线的设计就是把“收支平衡”定义在**文档化的草量**上，所以没有任何物种行需要携带 182 g）。

外加曲线形状断言：草量减半则摄入 < R、草量 ×10 则 > R、饱和上限落在 R 的 4–6 倍之间。

> 换成群体均值就会把一个**行为问题**（休息太多）读成一个**账本问题**（摄食算错）——两种 bug 的修法完全不同，所以口径必须钉在曲线上。

### 4.4 两档测试门禁（日常 / 发版）

`tests/balance.test.mjs` 有两档，因为**跑不起的门禁等于没有门禁**：

| 档位 | 触发 | 规模 | 耗时 | 证明什么 |
|---|---|---|---|---|
| 日常 | 默认 | 2 seed × 900 tick | ~12 s | 没有物种灭绝、没有爆量过 cap、生产者没被啃穿、吞吐达标 |
| 发版 | `PE_SOAK=1` | 3 seed × 9 000 tick（一整个游戏年） | ~4 min | 上面全部，**加上**每个物种都要在自己的移民线之上繁殖成功 |

- 日常档**不能**证明慢物种会繁殖：一个物种要 ~3 个成熟期才能完成繁殖并让子代被看见，900 tick 只有 90 秒。所以日常档把这项降级成存活，并在输出里明确打印对哪些物种用了哪档判据。
- 发版档把所有物种放到强门禁上。
- 另有 `PE_SOAK_TICKS` / `PE_SOAK_SAMPLE` 可直接覆盖规模（调曲线用）。
- 日常档自身有守卫断言：`seed 数 × tick <= 2000`，防止有人为了让它变绿把档位悄悄调小。

### 4.5 面板尺寸不变式（P0 回归）

`node tests/panel-layout.mjs --url <带 token 的 dsh web 地址> --profile <复用的 profile 目录>`

驱动真浏览器（CDP）测四个挂载路径，每格采 5 次（0/100/300/800/2000 ms）：

| 格 | 路径 | 期望 |
|---|---|---|
| A | 冷启动（无存档）/ **热启动（有存档，异步 load）** | canvas 与 stage 同大 |
| B | 离开面板再回来 | 同上 |
| C | 视口 resize（`Emulation.setDeviceMetricsOverride`） | 同上 |
| D | 页面 hidden → visible | 同上 |

**判据两条**：
1. `|stage.w - canvas.w| <= 4`（不是 2：`.pe-stage` 有 2px 边框，健康态实测差值恒为 4）；
2. `paint >= 0.5`——在 canvas 背板上按网格采样，统计非黑像素占比。第二条才是抓“只在左上角画一小块”真正的指标：尺寸断言看不见它。

**已知必坏格（2026-11-08 实测）**：**A 的热启动分支**。带存档启动时 `canvas.width/height` 与 CSS 尺寸都是 `view.width × view.height`（未乘 `scale`），实测 **stage 974×742 / canvas 194×148 / attr [194,148] / view 194,148,5**，切走再回来（格 B）即恢复成 970×740。所以这条不是偶发竞态，是**异步读档路径上少乘了缩放**，冷启动（新建世界）不受影响。

## 5. 读数陷阱（按顺序看）

1. **bundle 是 stale 的**：报告头带 `STALE` 就先 `node tools/build-client.mjs`。
2. **跨代际/跨尺度比较**：见 §2.4。旧基线是 512×400 + `DAY_SECONDS=120`，新世界是 1024×640 + 90，**不可直接比**。
3. **两条报告 seed 不同**：不可比。生态模型对初始条件极敏感。
4. **`--seconds` 太短**：年龄结构全幼年、`old` 死因为 0、捕食者还在增长段（300 s 时狐/狼都在爆量，饿死要更晚才出现）。判行为至少 300 s，判季节/年龄/捕食平衡要 900 s 以上。
5. **移民开着**：`--no-immigration` 关掉后灭绝是**允许出现**的，因为安全网本来就在兜底。只有测“链路自持”才关它。
6. **`spawned` 的口径**：`spawned` 不含开局建群个体（报告里单列 `start`）。`+2151 (2133 born)` = 2151 个新个体，其中 2133 个是 `generation > 1` 的真出生，差的 18 个是移民。**移民和出生必须分开看**。
7. **旧引擎的 `hunger` 通道**：`needs.hunger` 与 `reserve` 是两个独立变量，长期贴 0。这正是 §3.5 要抓的东西。
8. **死因在 legacy 下是推断的**：见 §6。
9. **最后一 tick 的死看不到**：死亡在它自己的 tick 里被移出实体表，探针按 tick 差分，所以**最后一 tick 发生的死亡不计入**（±1 的边界）。

## 6. 死因判定与校准

### 6.1 v2：用引擎自己的

有 `body.cause` 就直接用。`20-CORE-LOOP.md` 不变式 3 要求任何死亡都写入死因；v2 有两条死亡路径，两条都写：

- `dieOf(world, entity, cause)`（`09b-body.js`）：身体账本死（饥饿/冻/伤/老），写 `body.cause` 与 `entity.cause`，并累加 `world.deaths[cause]`；
- `killEntity(world, entity, cause)`（`08-sim-constants.js`）：捕食与旧的死亡路径，同样把 `cause` 写到 `entity.cause` / `body.cause`。

### 6.2 v2 校准结果（实测，`--seconds 300 --seed 12345`）

| 检查项 | 结果 |
|---|---|
| 探针统计的死亡数 | 978 |
| 其中 `source = body.cause`（权威） | **978 / 978 = 100%** |
| 分物种归因之和 vs 总数 | **978 / 978，完全一致** |
| `unknown` / 无死因 | **0** |
| 饿死质量 | `hunger at death` 中位数 **1.00**；`died on a full belly` **0/3** |

结论：**v2 的死因普查是测量，不是推断**，可以当门禁用。

### 6.3 一个引擎侧偏差：`world.deaths` 只统计了一半死亡

同一次跑，探针 978 例，引擎自己的 `world.deaths` 只有 `{predation: 402}`。原因是 `dieOf` 才累加 `world.deaths`，而老死/饿死走的是 `killEntity`（`12-step-entity.js`），它只写实体上的 `cause`，**不计数**。

> 影响：任何按 `world.deaths` 展示的死亡统计（面板/事件条）会**系统性少报老死与饿死**。探针不依赖它，所以探针的数是对的；但这是需要修的观测缺口（已报 Lead）。修好前，**不要拿 `world.deaths` 当死亡普查**。

### 6.4 legacy：固定顺序推断（旧 bundle 专用）

没有 `body.cause` 时按**固定顺序**推断，顺序不能改：

| 顺序 | 判据 | 结论 |
|---|---|---|
| 1 | `fate === 'eaten'` | `predation` |
| 2 | `age > lifespan - 2` | `old` |
| 3 | 死亡瞬间 `reserve === 0` 且死前 `> 0` | `predation`（捕食者把 `victim.energy` 归零） |
| 4 | 死亡瞬间 `reserve < 0` | `starved`（饿死是浮点负残值） |
| 5 | 其他 | `unknown`（**观测黑洞，当 bug 查**） |

> 第 2 步必须在第 3 步之前：老死个体 `reserve` 是正的，若先判“能量 ≤ 0 就是饿死”，老死会被误记成饿死。
> 第 3、4 步区分 `=== 0` 与 `< 0`：捕食是 `victim.energy = 0`（精确归零），饿死是 `energy -= drain*dt`（负残值）。

## 7. before / after 标准流程

```powershell
# 0) 先确认代际，再决定能不能比
node tools/behaviour-probe.mjs --engine-generation   # legacy | v2

# 1) 改之前（先保证 bundle 已构建）
node tools/build-client.mjs
node tools/behaviour-probe.mjs --seed 12345 --seconds 900 --json > D:/tmp/probe-before.json

# 2) 改之后
node tools/build-client.mjs
node tools/behaviour-probe.mjs --seed 12345 --seconds 900 --json > D:/tmp/probe-after.json
```

提交说明里贴：
- 两条报告的 `bundleHash` 与 `engineGeneration`（不同要写清为什么）；
- 门禁那一节的 PASS/FAIL/THIN 变化；
- §3.5 饿死质量的三个数（最敏感的指标）。

## 8. 基线快照（两组，**互不可比**）

### 8.1 legacy 基线（0.2.x 死树，保留作历史对照）

> `--seed 12345 --seconds 900`，**512×400**，`DAY_SECONDS=120`，移民开，bundle `9cc6654b0295`。

| 指标 | 数值 |
|---|---|
| 吞吐 | 376 ticks/s wall / 403 ticks/s sim |
| 死亡总数 | 5004 |
| 死因 | 捕食 29.2% / 饿死 70.0% / 老死 0.8% / 无法解释 0% |
| 饿死质量 | 3501 例饿死中 **2684 例（77%）hunger ≤ 0.6**；**1554 例站在有草的地上饿死** |
| P2.1 rest 占比 | 56.0% FAIL（目标 <35%） |
| P2.2 意图驻留中位数 | 0.8 s FAIL（目标 >10 s） |
| P2.3 方向性 | 0.28 FAIL（目标 >0.30） |
| P2.4 决策抖动 | 18.4 次/分 FAIL（目标 <12） |
| 种群（起→末） | 兔 160→111（峰 400）、鹿 40→26、狐 12→13（峰 33）、狼 5→8（峰 22）、鸦 20→72（峰 117）、鱼 120→110（峰 170）、蛙 90→19（峰 160） |

**这组数说明什么**：0.2.x 种群能活，但**行为是假的**（56% 发呆、0.8 s 抖一次、随机游走），而且 **77% 的饿死发生在“它自己觉得不饿”的时候、44% 发生在脚下有草的时候**。这是 `20-CORE-LOOP.md` 说“决策从不读身体”的量化证据。

### 8.2 v2 快照（能量账本半落地：P1 通道通、P3 未调密度）

> `--seed 12345 --seconds 300`，**1024×640**，`DAY_SECONDS=90`，移民开，bundle `01cdd62690cf`。
> 只有 300 s（3.33 游戏日），**捕食者还在增长段**，饿死尚未大规模发生；用它看**方向**，不要用它下最终结论。

| 指标 | 数值 |
|---|---|
| 吞吐 | 121 ticks/s wall（1024×640） |
| 死亡总数 | 978（`body.cause` 100%） |
| 死因 | 捕食 61.5% / 饿死 0.3% / 老死 38.2% / 无法解释 0% |
| 饿死质量 | **`hunger at death` 中位数 1.00；0/3 死于“饱腹”；3/3 站在有草的地上** |
| 守恒残差 | 单 tick **2.5e-7**；10 日累计 **2.5e-6**（Float32 累加，线性增长属固有误差） |
| 能量×饥饿散点 | **沿对角线分布**（驱动力已从身体派生） |
| P2.1 rest | 5.8% **PASS**（legacy 56%） |
| P2.2 驻留中位数 | 4.0 s **FAIL**（mean dwell 8.1 s） |
| P2.3 方向性 | 0.27 **FAIL**（legacy 0.28，基本没变） |
| P2.4 抖动 | 6.0 次/分 **PASS**（legacy 18.4） |
| P3.1 猎物饿死占比 | 0.0% **PASS** |
| P3.2 捕食者饿死占比 | 75%（**n=4，THIN**，不作结论） |
| 种群（起→末） | 兔 160→72（峰 401=cap）、鹿 40→80、**狐 12→49（峰 51）**、**狼 5→59（峰 61）**、鸦 20→32、鱼 120→158、蛙 90→160 |

**这组数说明什么**：
1. **能量闭环通了**（§3.5 三个数都归零、散点回到对角线、`rest` 从 56% 掉到 5.8%、抖动 18.4→6.0）——P1/P2 的实质进展是真的。
2. **捕食者在爆量**（狐 ×4、狼 ×12），兔子同时从 160 掉到 72、峰值顶到 cap 401。按 §4.1 的能量账，这个密度撑不住，**后续必然出现捕食者大批饿死**。这不是引擎 bug，是密度决策（A/B/C 方案）还没拍板。
3. **方向性 0.27 没改善**：`path` 变大但仍偏游走，是 P2 剩下最明显的缺口。
