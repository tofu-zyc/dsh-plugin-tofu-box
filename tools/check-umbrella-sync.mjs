#!/usr/bin/env node
/**
 * tofu-box 伞包同步校验 —— 发布前必须通过（publish.ps1 会自动调用）。
 *
 * 伞包不含代码，它对世界的全部主张就是「patches/ 是子包 patch 的逐字节副本，
 * dependencies 精确指向子包当前版本」。任何一处漂移都会让伞包装出来的
 * 东西和单装子包不一致，所以三件事逐一核对：
 *
 *   1. patches/<name>.yml === dsh-plugin-<name>/cordis.patch.yml（逐字节）
 *   2. dependencies 恰好覆盖全部子包，且范围是 ^<子包当前 version>
 *      （子包 bump 后必须连带 bump 伞包依赖，否则装到旧版）
 *   3. peerDependencies 覆盖各子包声明的所有 peer，且下界不低于任一子包
 *      的下界（伞包是用户直接装的那个，安装期兼容检查读的是它的 peers）
 *
 * 用法：node tools/check-umbrella-sync.mjs   （在仓库根运行；exit 1 = 不同步）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const umbrellaDir = join(root, 'tofu-box')
const umbrella = JSON.parse(readFileSync(join(umbrellaDir, 'package.json'), 'utf8'))

// 会员集合 = git 已跟踪的插件目录（与 publish.ps1 的发布纪律一致）：
// 在制品目录（未 add/commit）不算伞包成员，直到它被正式入库。
const isTracked = (dir) => {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--', `${dir}/`], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim().length > 0
}
const pluginDirs = readdirSync(root, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^dsh-plugin-/.test(e.name))
  .map(e => e.name)
  .filter(isTracked)
  .sort()

const problems = []
const note = (msg) => problems.push(msg)

// ---- 1. patch 副本逐字节一致 -------------------------------------------------
const patchFiles = readdirSync(join(umbrellaDir, 'patches')).sort()
const expectedPatches = pluginDirs.map(d => `${d.slice('dsh-plugin-'.length)}.yml`).sort()
for (const f of expectedPatches.filter(f => !patchFiles.includes(f))) {
  note(`patches/ 缺 ${f}（对应 ${'dsh-plugin-' + f.replace(/\.yml$/, '')}）`)
}
for (const f of patchFiles.filter(f => !expectedPatches.includes(f))) {
  note(`patches/${f} 没有对应的子包目录`)
}
for (const dir of pluginDirs) {
  const name = dir.slice('dsh-plugin-'.length)
  const copy = `patches/${name}.yml`
  const file = patchFiles.includes(`${name}.yml`)
  const source = readFileSync(join(root, dir, 'cordis.patch.yml'))
  const target = file ? readFileSync(join(umbrellaDir, copy)) : null
  if (file && !source.equals(target)) {
    note(`${copy} 与 ${dir}/cordis.patch.yml 不一致（改了子包 patch 忘了同步副本？直接 cp 覆盖即可）`)
  }
}

// 伞包 manifest 里的 patch 数组必须与 patches/ 目录实际文件一致
const declared = umbrella.dsh?.bundle?.patch
if (!Array.isArray(declared)) {
  note('dsh.bundle.patch 必须是文件数组（伞包模式）')
} else {
  const declaredNames = declared.map(p => p.replace(/^\.\//, '').replace(/^patches\//, '')).sort()
  for (const f of patchFiles.filter(f => !declaredNames.includes(f))) note(`patches/${f} 未列入 dsh.bundle.patch`)
  for (const f of declaredNames.filter(f => !patchFiles.includes(f))) note(`dsh.bundle.patch 列了 ${f}，但 patches/ 里没有`)
}

// ---- 2. dependencies 精确覆盖子包当前版本 -----------------------------------
const subpackages = Object.fromEntries(pluginDirs.map(dir => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  return [pkg.name, pkg.version]
}))
const deps = umbrella.dependencies ?? {}
for (const [name, version] of Object.entries(subpackages)) {
  if (deps[name] === undefined) note(`dependencies 缺 ${name}`)
  else if (deps[name] !== `^${version}`) note(`dependencies[${name}] 是 ${deps[name]}，子包当前版本 ^${version}（子包 bump 后要连带改伞包）`)
}
for (const name of Object.keys(deps)) {
  if (!(name in subpackages)) note(`dependencies 里多了 ${name}：不是本仓库的插件`)
}

// ---- 3. peers 并集覆盖且下界不回退 ------------------------------------------
// 只比较可解析形状（>=x.y.z 与 ^x.y.z）的下界；预发布版本按 semver 优先级比较。
const lowerBound = (range) => {
  const m = /^(?:>=|\^)([0-9]+(\.[0-9]+){0,3}(-[0-9A-Za-z.-]+)?)$/.exec(range)
  if (!m) return undefined
  return { version: m[1], pinMinor: range.startsWith('^') }
}
const cmpPrerelease = (a, b) => {
  const [va, pa] = String(a).split('-', 2); const [vb, pb] = String(b).split('-', 2)
  const na = va.split('.').map(Number); const nb = vb.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0) }
  if (!pa && !pb) return 0
  if (!pa) return 1   // 正式版 > 预发布
  if (!pb) return -1
  return pa.localeCompare(pb)
}
const peerBounds = {}
for (const dir of pluginDirs) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
    const bound = lowerBound(range)
    if (bound) {
      const prev = peerBounds[peer]
      if (!prev || cmpPrerelease(bound.version, prev.version) > 0) peerBounds[peer] = bound
    }
  }
}
const umbrellaPeers = umbrella.peerDependencies ?? {}
for (const [peer, bound] of Object.entries(peerBounds)) {
  const range = umbrellaPeers[peer]
  if (range === undefined) { note(`peerDependencies 缺 ${peer}（子包们声明过它）`); continue }
  const own = lowerBound(range)
  if (own === undefined) { note(`peerDependencies[${peer}] = ${range} 不是可校验的 >=/^ 形状`); continue }
  if (cmpPrerelease(own.version, bound.version) < 0) {
    note(`peerDependencies[${peer}] = ${range}，下界低于子包要求的 ${bound.version}`)
  }
}

// ---- 汇总 ---------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`tofu-box 同步校验失败（${problems.length} 处）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`tofu-box 同步校验通过：${pluginDirs.length} 个子包 / ${patchFiles.length} 份 patch 副本 / ${Object.keys(deps).length} 条依赖`)
