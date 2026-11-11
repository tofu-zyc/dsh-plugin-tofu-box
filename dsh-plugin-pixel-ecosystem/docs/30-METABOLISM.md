# 30 · 代谢、生产与生命史（数值从物理推出）

> 本文是 P1 能量账本的**实现口径**。所有数字只有两种来源：**物理公式**，或**物种的真实生态数据**（体重、寿命年数、每年胎数、幼崽占总质量的比例）。
> 唯一的全局手调量仍是 `κ = TUNING.productivity`（世界产能）。**没有任何一个物种带一个"为了让它活下去"的系数。**

## 1. 单位与时钟

| 量 | 单位 | 说明 |
|---|---|---|
| 能量 | **kJ** | 1 E = 1 kJ |
| 植物生物量 | **kg 干物质 / m²** | 一格 = 2 m，面积 4 m² |
| 动物体量 | **kg 湿重** | `body.V` |
| 所有速率 | **每游戏日** | tick 时乘 `dt / DAY_SECONDS` |
| `DAY_SECONDS` | 90 | 一个游戏日 |
| `YEAR_DAYS` | 8 | 一个生态年 = 8 游戏日 |
| `YEAR_SECONDS` | 720 | `YEAR_DAYS × DAY_SECONDS`，生命史的唯一换算基准 |
| `TICKS_PER_DAY` | 900 | `DAY_SECONDS / TICK` |

**生命史一律按"年"书写，再乘 `YEAR_SECONDS`**。0.2.x 把成熟期写成 36 秒，一旦一年从 1 天变成 8 天，兔子就变成"寿命 3 天、成熟期 0.4 天、永远来不及繁殖"的虫子——这不是调参能救的，是量纲错了。

## 2. 个体代谢（DEB-lite）

```
FMR(M)   = a · (1000·M_g)^b            # kJ/游戏日，Nagy 1999
Emax     = RESERVE_DAYS · FMR(M)       # 储备上限
pM       = FMR · activity · Q10^((T-20)/10) · gene.metabolism
E       -= min(pM·dt/D, E)             # 只扣得起的部分算呼吸
E       += gut                          # 上一 tick 同化的食物
if (E > Emax)  overflow += E - Emax     # 记账，不静默丢弃
```

动物曲线：

| taxon | a | b | 说明 |
|---|---|---|---|
| mammal | 4.82 | 0.734 | Nagy et al. 1999 |
| bird | 10.5 | 0.681 | 同上 |
| ectotherm | 0.6 | 0.75 | 鱼/两栖比恒温低一个量级 |

**第 2 条不变量**：`metabolise()` 是唯一允许移动 `body.E` 的地方。实现上用了一个带计数器的访问器包住储备格：旧代码（渲染器、检视器、繁殖）仍然可以写 `entity.energy` / `body.E`，但每一次外部写入都会作为"直接存入/支取"记进能量账，账本因此不会因为别处写了一行而破洞。

## 3. 摄食：Holling II

```
R    = FMR / 同化率 / 17 500        # 干物质维持需求，kg/日
     # 兔：1276 / 0.4 / 17 500 = 0.1823 kg/日 = 182 g/日  ← 这就是那个自校验数字
intake(B) = I_max · B / (K + B)
I_max = INTAKE_CEILING · R
K     = (INTAKE_CEILING - 1) · GRAZE_REFERENCE
take  = intake(B) · dt/D / CELL_AREA     # 折算成该格 kg/m² 的扣除
```

- `GRAZE_REFERENCE = 0.12 kg/m²` 是"吃回本"的草高，也就是被啃出的草坪最终稳定在的高度。**高于它是盈余，盈余才付得起生长和繁殖**——只够维持的动物永远长不大。
- 摄入的 `gross` 按 `assimilation`（草食 0.4 / 肉食 0.8）分成同化部分（进储备）和粪便（进 detritus），两部分都记账。
- 捕食：抓到即 `dieOf(victim, 'predation')`，尸骸的能量 = 猎物 `body.E + body.V × 7000`；捕食者随后进入 `body.handling`，以 `2.5 × pM` 的速度从尸骸里取食。**处理时间本身就是 Holling II 的 h**，它替代了"贴身光环秒杀"。

## 4. 生产（逐格质量平衡）

```
dG/dt = GPP - 呼吸 - 凋落 - 采食
GPP    = κ · μ · (G + seed) · light · f_water · f_nutrient
light  = sunlight · exp(-k · (G·SLA + canopy))     # Beer-Lambert
resp   = ρ · G · Q10^((T-20)/10)
litter = λ · G                                      # → detritus
```

- 自遮荫（`exp(-k·SLA·G)`）提供密度依赖，所以**平衡生物量是涌现出来的**，不需要 `(1-G/Bmax)` 这种人工上界。
- 因为光、水、养分逐格不同，平衡草高逐格不同（实测 p10 0.08 / p50 0.28 / p90 0.54 kg/m²），树冠下比开阔地低 20–30%。**这就是"有理由移动"的机制**：同一片地里，好格子的摄入量是差格子的 5–6 倍。
- 655 360 格不能每 tick 全刷：`PRODUCER_SLICES = 16`，每格每 16 tick 更新一次、dt 相应放大 16×，平均速率不变。
- 树冠 `world.canopy` 只在森林变化时重建（`canopyDirty`），另外每 60 tick 兜底重建一次。

## 5. 碎屑闭环

```
尸骸 ──rot(3.2/42s)──► detritus ──mineralise(1.6/日)──► 土壤养分指数 (0..1)
粪便（gross − 同化）──► detritus                        ↑
凋落 λ·G ────────────► detritus                         │
                                                    GPP 取用
```
`world.nutrient` 与 `world.fertility` 是同一个数组（契约名与历史名）。养分指数是**指标**不是能量池，所以矿化在账本里记为"离开系统"。

## 6. 能量账本（可测）

```
residual = Δ(草 + 杂草 + 碎屑 + 尸骸 + Σ(body.E + body.gut + body.V·7000))
         − (GPP + 繁殖注入 + 外部直接存入)
         + (植物呼吸 + 动物呼吸 + 矿化 + 溢出 + 外部直接支取)
```

- `STRUCTURE_COST` 必须 **等于** `MEAT_ENERGY`（7000 kJ/kg），生长才是"储备 → 结构"的纯转移。
- 溢出（吃到超过储备上限、碎屑池超上限、尸骸表超上限）逐项记账，不静默丢弃。
- 实测（256×160，完整食物网，9000 tick = 10 游戏日）：**单 tick 最差残差 2.5e-7 相对**；10 日累计 2.5e-6（Float32 场累加误差）。

## 7. 生命史（全部由 YEAR_SECONDS 推出）

| 推导量 | 公式 |
|---|---|
| `balance.maturity` | `maturityYears × YEAR_SECONDS` |
| `genes.lifespan` | `lifespanYears × YEAR_SECONDS` |
| `genes.fertility`（产仔冷却） | `YEAR_SECONDS / littersPerYear`（±15% 基因散布） |
| `balance.elderAt` | `0.8 × 平均寿命`（衰老，不是"半辈子不能繁殖"） |
| `balance.birthMass` | `体重 × litterMassShare / 最大胎数`（兔 43 g） |
| `balance.breedCost` | `(整胎湿重 × 7000 + 胎数 × 幼体初始储备) / REPRODUCTION_EFFICIENCY` |
| `balance.breedEnergy` | `breedCost × 1.02`（**储备必须覆盖整胎**，否则不许繁殖） |
| `balance.maxEnergy` | `RESERVE_DAYS × FMR(成体)` |
| `balance.startEnergy` | `0.7 × maxEnergy` |

`RESERVE_DAYS = 4`：约等于兔体重的 6–7% 脂肪，落在真实 5–10% 区间内。

实测（seed 12345，256×160，900 游戏秒 = 10 游戏日，immigration 开）：

| 物种 | 成熟(日) | 寿命(日) | 首胎(日) | Emax(kJ) | 整胎成本/Emax |
|---|---|---|---|---|---|
| rabbit | 2.4 | 24 | **3.14** | 5 106 | 0.72 |
| deer | 16.0 | 120 | 18.6 | 61 983 | 0.66 |
| fox | 6.4 | 80 | 13.2 | 11 436 | 0.66 |
| wolf | 20.0 | 64 | 35.5 | 46 028 | 0.41 |
| crow | 8.0 | 64 | 11.7 | 2 692 | 0.57 |
| fish | 12.0 | 80 | 20.1 | 489 | 0.24 |
| pike | 20.0 | 120 | 28.5 | 1 319 | 0.42 |
| heron | 12.0 | 64 | 32.0 | 6 386 | 0.30 |
| otter | 12.0 | 64 | 22.4 | 14 125 | 0.36 |
| bear | 36.0 | 200 | 未发生 | 149 990 | 0.06 |
| frog | 8.0 | 40 | 未发生 | 24 | 0.50 |

"首胎 = 3.14 日"对兔子成立；狼 20 日成熟是"1 年 = 8 游戏日"这个压缩比的直接推论（2.5 年 = 20 日），不是调出来的。**要缩短只能改 YEAR_DAYS，或承认大型物种是游戏生物并另加压缩常数**——后者是唯一允许出现的手调点，且必须写在这里。

## 8. 未做 / 已知偏差

1. **无妊娠期**：整胎成本在出生的那一个 tick 从母体储备扣除，而不是分摊到孕期。
2. **生长受年龄上限约束**，但真正的限制是能量（`GROWTH_RATE_CEILING × FMR`）。饥饿幼体停在原体量，不会"长在贷款上"。
3. **变温动物无冬眠**：冷到 `coldLimit` 以下直接扣健康。
4. **矿化产物的能量记为离开系统**（养分是指数而非能量池）。
5. **Float32 场累加**：单 tick 守恒 2.5e-7，10 游戏日累计 2.5e-6。
