# 发布：pixel-ecosystem 0.3.10（2026-11-11）

像素生态缸 **0.3.x 能量账本重写的首个 npm 版本**。npm 上此前只有 0.1.0 / 0.2.2 / 0.2.3；
0.3.0–0.3.9 一直在开发分支 `feat/terrarium-energy-core` 上，本次合并进 `main` 后以 0.3.10 发布。
本插件**不在 `tofu-box` 伞包里**（`dsh.umbrella: false`），伞包保持 1.2.3 不变。

## 发布内容

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `dsh-plugin-pixel-ecosystem` | 0.3.10 | 能量账本 + 行为层重写；面板可用性修复；低缩放渲染与死因观测修复 |

## 0.3.x 相对 0.2.3 变了什么

- **引擎换底**：`entity.energy + needs` 双账本 → **能量账本**（`body.E / V / M`，单位 kJ），
  代谢按真实异速生长标定（Nagy 1999 FMR + Q10），平衡从热量收支算出来，不再靠手调数值。
- **行为层**：感知 → 信念 → 驱动力 → 审议 → 执行状态机，决策有记录可查（检视器里能看到
  选了什么、赢了多少分、败给了谁）。
- **世界**：1024×640 格；气候/季节（物候、温度场、冻死路径）；存档 v2（`CompressionStream('gzip')`
  + base64，身体与心理状态全量往返）。
- **食物网不变**：仍是 11 个物种跨水陆两张网，遗骸腐烂回肥力闭环。

## 0.3.10 修了什么（相对 0.3.9）

1. **熊 / 水獭 / 苍鹭 / 青蛙在 1–2× 缩放下整体消失**：这 4 个物种只有显示分辨率图集帧，
   没有 1px 网格，「适应窗口」后 `frameFor` 返回 null 被跳过——数量、小地图点、拖影都在，
   动物本体没了。补齐 4 套 1px 网格与配色。
2. **同 4 个物种的移动拖影是纯黑**：`TRAIL_COLORS` 的字符→颜色表缺项时
   `dimColor(undefined)` 打包成不透明黑。补齐到 11 键。
3. **受伤致死的个体从死因条上消失**：引擎写 `body.cause = 'injury'`，面板 `CAUSE_KEYS`
   却写着 `disease`，`includes` 过滤把这类死亡全部丢掉（G5「失败可解释」的破洞）。
   词表端到端对齐：store、预测死因、推断兜底、中英 locale、文档。
4. 能量流面板两行共用 React key `'plants'` → 改 `'plantRespire'`；注册处重复导出
   `DAY_SECONDS` 去重，`TRAIL_COLORS` 导出供测试。

配套新增两个回归门：`tests/sprite-coverage.test.mjs`（5 用例，两条渲染路径的物种一致性）、
`tests/reproduction.test.mjs`（3 用例，11 物种逐个钉住繁殖机制 + 幼体/储备不足两条反例）。

## 安装 / 升级

```sh
dsh plugin --profile <p> add dsh-plugin-pixel-ecosystem@0.3.10
```

- 兼容性：`engines.dsh` 为 `>=0.2.0-rc.2 <0.3.0-0`；Client 半只声明 `platform: web`。
- **从 0.2.x 升级**：存档格式 v1 → v2，旧档会被**拒绝并提示**（不是静默清空），开新世界即可。
- 装完刷新页面；侧边栏像素图标进主面板。测试请走 `rc-dev` / `alpha-dev` profile
  （见 [TESTING-PROFILES.md](TESTING-PROFILES.md)），不要装进日常 desktop profile。

## 验证

- **134/134 测试全绿**（0 fail / 0 todo），含 `pretest` 构建新鲜度门（client.js = 33 个 part 的拼接）。
- 能量守恒单 tick 最差 **2.5×10⁻⁷** 相对残差；存档往返身体/心理状态误差 **0**。
- 行为探针（seed 12345，900 s）：rest **3.0%**、意图驻留中位数 **15.0 s**、路径方向性 **0.35**、
  决策切换 **1.6 次/分**、猎物饿死占比 **22.7%**。
- 吞吐：1024×640 / 实体总数 2394（动物峰值 1152）**79 ticks/s**（10 Hz 实时需要 10）。
- `tools/check-umbrella-sync.mjs` 通过（本插件按 `umbrella: false` 排除，伞包无需改动）。
- 数字的完整口径与限制见插件 `docs/FINAL-REPORT.md` 与 `docs/97-PROBES.md`。

## 已知限制

- **种群层平衡证据仍薄**：繁殖机制有逐物种测试门，但「11 物种靠繁殖自持」目前只有单种子
  9 000 tick 探针；多年期稳态未验证（FINAL-REPORT §6.6）。
- P3.2（捕食者饿死占比）仍是 INFO 门；P4「冬季死亡率显著高于夏季」没有实测数字；
  P5（特性卡/屯粮）未开始；G7 的撤销路径未做。
- 真浏览器验收（`tests/panel-layout.mjs` / `tools/ui-smoke.mjs`）要人带着 URL 手跑，未进 CI。
- 世界只活在当前浏览器 localStorage；一张存档一个世界，「新世界」覆盖旧档。