# 95 · 工作流（团队协作约定）

## 分支与提交

- 开发分支：`feat/terrarium-energy-core`
- 提交前缀：`feat(terrarium)` / `fix(terrarium)` / `docs(terrarium)` / `refactor(terrarium)`
- **只提交自己 scope 内的文件**；不要 `git add -A`（仓库里有 `.npm-cache-dev/`、`.review/` 等未跟踪目录）。

## 构建与测试（必读）

`client.js` 是**生成物**，不要直接改。源码在 `src/parts/`。

```powershell
cd dsh-plugin-pixel-ecosystem
node tools/build-client.mjs        # 改完 part 之后必须重建
node --test tests/*.test.mjs       # 全套 68 个测试
node tools/build-client.mjs --check # 构建是否最新（pretest 会自动跑）
```

顺序错误的后果：`tests/build.test.mjs` 会红，提示"client.js is stale"。

## part 所有权

| part | 所有者 | 内容 |
|---|---|---|
| 00-preamble / 01-constants / 27-registration | **lead** | 契约与装配 |
| 02-species / 03-helpers / 04-terrain / 05-world-create / 06-genes-spawn | sim-core | 世界与物种 |
| 07-spatial / 08-sim-constants / 08b-perception | behaviour | 感知与空间查询 |
| 09-needs / 10-decide / 10b-execution / 12-step-entity | behaviour | 决策与状态机 |
| 09b-body / 11-feed / 13-fields / 13b-climate / 13c-traits / 16-persistence | sim-core | 身体、代谢、植物、存档 |
| 14-player-tools / 15-stats | lead | 笔刷与统计 |
| 17-palette / 18-sprites / 19-atlas / 20-render | render | 视觉 |
| 21-store / 22-locale / 23-glyphs / 24-ui / 25-ui-locale / 26-css | ui | 界面 |

**跨 part 的改动：先改 `20-CORE-LOOP.md` 的契约，再写代码，并在提交信息里写明。**

## 新增 part 的流程

1. 找 Lead 要一个编号（`manifest.json` 由 Lead 维护，避免并发改同一文件）。
2. 文件名必须是 `NN-name.js`（`tests/build.test.mjs` 会校验）。
3. part 之间共享同一个闭包，**禁止 `import`/`export`**（会被测试拦下）。

## 探针

```powershell
node tools/behaviour-probe.mjs --seed 12345 --seconds 900
```
输出：每物种时间预算、意图驻留、行程/家园半径、死因普查、年龄结构、能量散点、吞吐。
**任何影响行为/能量的改动，提交前必须贴改动前后的探针数字。**

## 评审

Lead 负责：看 diff、跑测试、跑探针、按 `90-ROADMAP.md` 的门禁验收。
门禁不过的改动不进分支。
## 并行作业踩过的坑（用结构防住，不靠记性）

1. **同一闭包内重复声明**。所有 part 共享一个闭包，两个 owner 各写一次 `const DRIVE_KEYS` 就会让整个 bundle SyntaxError、面板全挂。
   防线：`tests/build.test.mjs` 的 "no identifier is declared by two parts" 会扫出跨 part 的重复顶层声明。
   规矩：**共享词表（DRIVE_KEYS / CAUSE_KEYS / INTENT_IDS …）只许有一个出处**，别人只能引用。
2. **数据字段缺失导致运行时崩溃**。`nearestPrey` 直接 `for (const id of species.prey)`，而 grazer/scavenger 没有这个字段，于是任何 `stepWorld` 都崩。
   防线：读物种数据一律给默认值（`species.prey ?? []`），并在物种表里**显式**写空数组。
   规矩：新增必填字段时，同一次提交里补齐**所有**物种行；否则就是定时炸弹。
3. **中间态不可验证**。P1 把 `energy` 换成 kJ 但 `entity.body` 还没挂上时，别人没法做探针对照。
   规矩：涉及契约的改动，**先把字段挂上去并保持可运行**，宁可数值粗糙，也不要让世界跑不起来。
4. **构建竞态**。`node tools/build-client.mjs` 会拼所有人的 part；谁把 part 写坏，所有人的构建都红。
   规矩：每次编辑后立刻 `node --check src/parts/<你的文件>`；`client.js` 只由 Lead 提交。
5. **尺子要单独校准**。死因普查曾经是推断出来的，必须用一次性的交叉验证（把引擎真实写入的 `body.cause` 和推断结果逐 id 对齐）证明推断准确率，结果写进 `docs/97-PROBES.md`。v2 之后死因是权威记录，但这道验证流程保留：**任何"测量"都要先证明它测的是它声称的东西**。
6. **同步 API 不许悄悄变成异步**。`ensureWorld()` 被面板首帧、测试和 scene-lab 当作同步入口；解压必须是异步的，但"没有存档"这条路径必须同步建世界。契约变更要先改 `docs/20-CORE-LOOP.md` 再改代码。
