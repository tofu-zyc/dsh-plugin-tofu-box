# 20 · 核心循环与数据契约

> 这是 **sim-core 与 behaviour 两个工作流之间的接口契约**。改字段先改这份文档，再改代码。

## 1. 每 tick 的执行顺序（顺序本身是设计的一部分）

```
stepWorld(world, dt)
├─ stepClimate        (13b)  太阳角度 → 光照强度/温度/季节相位
├─ stepCanopy         (13)   分片计算逐格光衰减（Beer-Lambert）
├─ stepProducers      (13)   逐格 GPP − 呼吸 − 凋落，分片刷新
├─ stepDetritus       (13)   尸体/粪便 → 碎屑 → 矿化 → 土壤养分
├─ stepEntities       (12)
│   └─ 每只：perceive → updateDrives → deliberate → execute → metabolise → consume → move → reproduce/die
├─ stepCaches         (13)   屯粮点衰减、被偷
├─ stepEffects / stepHistory / handleImmigration
```

**为什么先植物后动物**：同一 tick 内植物先更新，动物吃到的是本 tick 的存量，避免"同一片草被两次结算"。

## 2. 实体状态（`entity`）

### 2.1 身体（**sim-core 拥有**，behaviour 只读）

| 字段 | 类型 | 单位 | 含义 |
|---|---|---|---|
| `body.E` | float | kJ | 储能（储备库） |
| `body.Emax` | float | kJ | 储备上限 = `RESERVE_DENSITY × body.V` |
| `body.V` | float | kg 湿重 | 结构/体量（决定体型、力量、可储存量） |
| `body.M` | float | 0..1 | 成熟度，到 1 才算成年 |
| `body.health` | float | 0..1 | 健康；0 即死亡。饥饿/受冻/受伤扣它 |
| `body.fatigue` | float | 0..1 | 疲劳；由活动累积，休息清除 |
| `body.dead` | bool | | 死亡标记（替代现在的 `fate`） |
| `body.cause` | string | | 死因：`starved`/`frozen`/`predation`/`old`/`disease` |

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
| `caches[]` | | `{id,x,y,energy,owner,decay}` 屯粮点 |

## 4. 关键方程（sim-core 实现）

```
# 个体代谢（DEB-lite，Kleiber 标定）
f    = B / (B + K)                                 # Holling II 食物可得性
pA   = pAm * f * M_body^(2/3)                      # 同化功率 kJ/日
pM   = m0  * M_body^(3/4) * Q10^((T-20)/10) * activityFactor
if (pA > pM):  growth = κ_DEB*(pA-pM)/[EG];  dV/dt = growth;  dE/dt = pA-pM-EG*dV/dt
else:          dE/dt = pA - pM                     # 吃储备
E <= 0  → health 下降 → 死亡（cause=starved）

# 摄食（Holling II + 处理时间）
intakeRate = a*B/(1 + a*h*B)                       # h = 处理时间，天然产生"抓到后停下吃"

# 植物（逐格）
GPP  = mu * grass * f_light * f_water * f_nutrient * (1 - grass/Bmax)
resp = rho * grass * Q10^((T-20)/10)
litter = lambda * grass
dgrass/dt = GPP - resp - litter - 采食

# 光衰减（冠层竞争）
light[i] = sunlight * exp(-k * LAI[i])             # k ≈ 0.4–0.6
```

常数初值（写在 `01-constants.js` 的 `BIO` 表里，集中一处，禁止散落）：

| 常数 | 值 | 来源 |
|---|---|---|
| `FMR_A` / `FMR_B`（兽） | 4.82 / 0.734 | Nagy 1999 |
| `FMR_A` / `FMR_B`（鸟） | 10.5 / 0.681 | Nagy 1999 |
| 同化率 草食/肉食 | 0.40 / 0.80 | 生态学讲义 |
| `Q10` | 2.5 | ≈ Ea 0.65 eV |
| `k`（光衰减） | 0.5 | Beer-Lambert |
| `κ_DEB` | 0.8 | DEB 惯例 |
| `RESERVE_DENSITY` | 约 5 日 FMR | 真实动物体脂缓冲 |

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
