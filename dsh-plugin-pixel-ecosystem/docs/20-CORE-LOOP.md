# 20 · 核心循环与数据契约

> 这是 **sim-core 与 behaviour 两个工作流之间的接口契约**。改字段先改这份文档，再改代码。

## 1. 每 tick 的执行顺序（顺序本身是设计的一部分）

下面是 `13-fields.js` 里 `stepWorld`（`:492-510`）的**真实顺序**，照代码抄的，不是示意：

```
stepWorld(world, dt)                    // dt 夹到 ≤ 0.5 s；非正数/NaN 直接返回
├─ settleTerrain(world)                 地形惰性稳定
├─ tick += 1；time += dt
├─ stepClimate        (13b)  太阳角度 → 光照强度/温度/季节相位
├─ rebuildCanopy      (13)   world.canopyDirty 为真、或每 CANOPY_REBUILD_TICKS 一次：逐格光衰减（Beer-Lambert）
├─ stepDetritus       (13)   尸体/粪便/凋落 → 碎屑 → 矿化 → 土壤养分
├─ stepProducers      (13)   逐格 GPP − 呼吸 − 凋落，分片刷新
├─ growTrees          (13)   木本植物生长/枯死
├─ spawnAmbientEffects / stepEffects     粒子与效果
├─ handleImmigration  (12)   移民安全网
└─ stepEntities       (12)
    └─ 每只：metabolise（09b，身体先扣账；死了就跳过）→ stepEntity
        stepEntity 内部（`12-step-entity.js:15-170`）：
        decayNeeds → updateDrives → perceive → decide（只在边界/中断）→ execute
        → feed → moveToward → updateFatigue → 繁殖判定（成熟 × reserve 门 × cooldown）
```

**为什么先植物后动物**：同一 tick 内植物先更新，动物吃到的是本 tick 的存量，避免"同一片草被两次结算"。

**为什么代谢在行为之前**：`stepEntities` 先 `metabolise`（`13-fields.js:479`）再 `stepEntity`，注释写的是
"The body pays for being alive before the animal gets to act on it" —— 饿死/冻死/老死都在这一步进 `dieOf`，
行为层读到的永远是本 tick 的身体状态。

**文档里曾出现、但代码里不存在的步骤**：`stepCanopy`（现在是 `rebuildCanopy`，且按脏标记/周期触发，不是每 tick 全量）、
`stepCaches`（屯粮点衰减/被偷，属于 P5，`world.caches` 连创建者都没有）、`stepHistory`（从未实现）。

## 2. 实体状态（`entity`）

### 2.1 身体（**sim-core 拥有**，behaviour 只读）

| 字段 | 类型 | 单位 | 含义 |
|---|---|---|---|
| `body.E` | float | kJ | 储能（储备库） |
| `body.Emax` | float | kJ | 储备上限 = `RESERVE_DAYS × FMR(species, V)`，即「4 个游戏日的维持功率」（`01-constants.js:91`、`09b-body.js:81-83`） |
| `body.V` | float | kg 湿重 | 结构/体量（决定体型、力量、可储存量） |
| `body.M` | float | 0..1 | 成熟度，到 1 才算成年 |
| `body.health` | float | 0..1 | 健康；0 即死亡。饥饿/受冻/受伤扣它 |
| `body.fatigue` | float | 0..1 | 疲劳；由活动累积，休息清除 |
| `body.dead` | bool | | 死亡标记（替代现在的 `fate`） |
| `body.cause` | string | | 死因：`starved`/`frozen`/`injury`/`predation`/`old`（见下方词表说明） |

**死因词表以代码为准**（这份文档早先写成 `disease`，是 0.2.x 的展示口径，不是引擎写进 `body.cause` 的值）：

| 值 | 出处 |
|---|---|
| `starved` / `frozen` / `injury` | `09b-body.js:371` —— 健康耗尽时的三选一（储备空 = 饿死、受冻 = 冻死、否则 = 伤重） |
| `old` | `09b-body.js:375` —— `age > genes.lifespan` |
| `predation` | `11-feed.js:195`（吃空猎物）、`12-step-entity.js:24`（上个 tick 已被咬死） |

**展示层用的是同一张词表**（`21-store.js:24` 的 `CAUSE_KEYS` = `predation / starved / frozen / injury / old / unknown`）：
面板的"预测死因"（`21-store.js:279` 的 `predictCause`）和"推断死因"的兜底（`21-store.js:335` 的 `classifyDeath`，读不到 `corpse.cause` 时才走）
都只说这几个值，locale 键是 `cause.*`（`25-ui-locale.js`，中英各一份）。

> 历史：0.3.9 之前 `CAUSE_KEYS` 里写的是 `disease` 而没有 `injury`，于是**受伤致死的个体会被
> `CAUSE_KEYS.includes(corpse.cause)` 过滤掉**，物种表的死因条上直接看不到这类死亡（G5 要求的"失败可解释"
> 破了洞）。0.3.10 已改成与引擎同一张词表，`tests/client.test.mjs` 会从 `CAUSE_KEYS` 反推所需 locale 键。

### 2.2 驱动力（**behaviour 拥有**，由身体导出）

```
drives = { hunger, thirst, cold, fatigue, fear, social, curiosity, libido }   // 每个 0..1
```

**导出规则（不是计时器！）**：`hunger = clamp(1 - E/Emax, 0, 1)`。这一条修掉了 0.2.x 最致命的 bug——决策从不读身体，导致动物"吃不下也饿不死"地站着饿死。

### 2.3 行为（**behaviour 拥有**）

| 字段 | 含义 |
|---|---|
| `state` | `{ id, since, until, phase }` 当前活动 + 结束时间（**有时长**，替代每 0.3s 重掷） |
| `plan` | `{ goal, steps: [{x,y,act,duration}], index }` 去某地做某事 |
| `belief` | `{ food, threat, water, home, caches[] }` 每条带 `t` 时间戳和置信度，会过期 |
| `intent` | **保留字段**，由 `state.id` 派生，给渲染器和老 UI 用 |

### 2.4 不变式（写进测试）

1. `0 <= body.E <= body.Emax`，`body.V > 0`，`0 <= body.health <= 1`
2. 能量守恒：每 tick `ΔE_total == 摄入 − 呼吸 − 生长 − 繁殖 − 排泄`（浮点容差 1e-6 相对）
3. 任何实体死亡时必须写入 `body.cause`（旧的死亡路径**没有死因**，这是观测黑洞）
4. 同一 seed 跑 N tick 后状态哈希一致

## 3. 世界状态（`world`）新增

| 字段 | 单位 | 说明 |
|---|---|---|
| `climate.t` | 游戏秒 | 累计时间 |
| `climate.dayPhase` | 0..1 | 日内相位 |
| `climate.yearPhase` | 0..1 | 年内相位（季节） |
| `climate.temperature` | °C | 全局气温（海陆/海拔可后续加） |
| `climate.sunlight` | 0..1 | 地表光照强度（含季节振幅） |
| `grass[]` / `weed[]` | kg 干物质/m² | 生产者现存生物量（语义从 0..1 标量改为质量） |
| `nutrient[]` | 0..1 | 土壤养分（限制因子） |
| `detritus[]` | kg/m² | 碎屑池（尸体/粪便/凋落） |
| `light[]` | 0..1 | 逐格实际受光（冠层衰减后） |
| `caches[]` | | `{id,x,y,energy,owner,decay}` 屯粮点 —— **尚未接线（P5）**：`05-world-create.js` 不创建这个字段，目前只有 `08b-perception.js:394-400`（读到 `undefined` 就跳过）和存档/统计会碰它 |

## 4. 关键方程（设计意图 → 实现对照）

### 4.1 个体代谢：这是**设计意图**，实现见 `09b-body.js`

下面这段 DEB 形态的方程块**不是代码里跑的方程**，留在这里只当"我们借的是哪一套比例关系"的索引。
早先它被当成实现来读，于是出现了"文档说 `pA/pAm`、代码里没有 `pAm`"这种对不上的情况。

```
# 设计意图（DEB-lite 教科书形态，本仓库没有按这个实现）
f    = B / (B + K)                                 # Holling II 食物可得性
pA   = pAm * f * M_body^(2/3)                      # 同化功率 kJ/日
pM   = m0  * M_body^(3/4) * Q10^((T-20)/10) * activityFactor
if (pA > pM):  growth = κ_DEB*(pA-pM)/[EG];  dV/dt = growth;  dE/dt = pA-pM-EG*dV/dt
else:          dE/dt = pA - pM                     # 吃储备
```

**实现（唯一权威，`09b-body.js`）**：

| 环节 | 代码 | 实际做法 |
|---|---|---|
| 维持功率 | `09b-body.js:310-314` | `pM = FMR(V) × activity × q10(T)`，`FMR = a·M(g)^b`（Nagy 1999，kJ/游戏日） |
| 体温缩放 | `09b-body.js:108-118` | 变温动物整段走 Q10；**恒温动物只在低于下临界温度 `20 − 7·log10(M+1)` 时多花**，温血天气不扣它的代谢 |
| 生长 | `growBody`，`09b-body.js:397-416` | 目标结构由**年龄**给出：`target = 出生重 + (成体重−出生重)·age/maturity`；再两道闸：储备要高于 `GROWTH_RESERVE_FLOOR`(0.3)×Emax 才有钱长，每步合成最多 `GROWTH_RATE_CEILING`(4)×FMR 的能量 |
| 生长代价 | `09b-body.js:409-414` | `ΔV = 可支配能量 / STRUCTURE_COST`（7000 kJ/kg 湿重），储备减少量恒等于结构增加量 —— 账面是**转移**，不是凭空的产生 |
| 死亡 | `09b-body.js:362-373` | `health ≤ 0` → 按 `E ≤ 0 ? 'starved' : cold ? 'frozen' : 'injury'` 定死因；`age > lifespan` → `old` |

### 4.2 其余三块（这三块是按式子实现的）

```
# 摄食（Holling II + 处理时间）—— 11-feed.js:40
intake(B) = I_max * B / (K + B)                    # I_max = INTAKE_CEILING × 需求；K = (INTAKE_CEILING-1) × GRAZE_REFERENCE
                                                  # h（处理时间）在捕食侧：抓到后 entity.handling 让它停下吃完

# 植物（逐格）
GPP  = mu * grass * f_light * f_water * f_nutrient * (1 - grass/Bmax)
resp = rho * grass * Q10^((T-20)/10)
litter = lambda * grass
dgrass/dt = GPP - resp - litter - 采食

# 光衰减（冠层竞争）
light[i] = sunlight * exp(-k * LAI[i])             # k ≈ 0.4–0.6
```

### 4.3 常数（写在 `01-constants.js` 的 `BIO` 表里，集中一处，禁止散落）

| 常数 | 值 | 来源 |
|---|---|---|
| `FMR_A` / `FMR_B`（兽） | 4.82 / 0.734 | Nagy 1999 |
| `FMR_A` / `FMR_B`（鸟） | 10.5 / 0.681 | Nagy 1999 |
| 同化率 草食/肉食 | 0.40 / 0.80 | 生态学讲义 |
| `Q10` | 2.5 | ≈ Ea 0.65 eV |
| `k`（光衰减） | 0.5 | Beer-Lambert |
| `KAPPA_DEB` | 0.8 | DEB 惯例（**当前没有参与生长**：生长走 4.1 的年龄目标曲线） |
| `RESERVE_DAYS` | **4** | 储备 = 4 个游戏日的 FMR（`01-constants.js:91`）；真实小兽体脂是 5–10 日，压到 4 是为了让第一代活在一次观看时长里 |

## 5. 存档 v2

`SAVE_VERSION = 2`。新增 `body.*`、`drives`、`state`、`plan`、`belief`、`climate`、`nutrient`、`detritus`、`caches`。
旧档不迁移（直接重开世界），但读档失败必须**告诉玩家**，不能静默丢弃（0.2.x 是静默丢弃）。

### 量化步长（写进测试的判据）

每个浮点场按**自己这次存档的量程**量化，量程写进存档头（`scales[field]`）。所以

> **量化步长 = 该场量程 / 255**，不是 1/255。

草原长到 1.2 kg/m² 时，允许的绝对误差是 1.2/255 ≈ 0.0047，而不是 0.0039。
任何"读档后场值漂了多少"的断言都必须用 `scales[field]/255` 作为容差
（`tests/review.test.mjs`、`tests/engine.test.mjs` 已改成这个判据）。
8 位是字段位数的上限，不是"世界永远在 0..1 之间"的承诺。
