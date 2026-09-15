#!/usr/bin/env node
/**
 * tofu doctor — diagnose a dsh profile that refuses to boot.
 *
 * dsh boots fail-fast: one broken plugin kills the whole process. This tool
 * boots the profile in a supervised loop and works out who to blame:
 *
 *   A. the loader audit names culprits ("plugin(s) failed to load: X",
 *      "N entry did not activate") → parse them;
 *   B. the crash is an anonymous stack (contract violations etc.) → scan the
 *      output for node_modules/<plugin> paths (or link:-install realpaths);
 *   C. still nobody named → bisect: disable every plugin you added, confirm
 *      the profile boots, then binary-search (log2(N) probe boots) for the
 *      culprit, repeating if several are broken.
 *
 * For each culprit it then:
 *   1. tries `dsh plugin update <name>` (git → HEAD, npm → semver, url → refetch;
 *      local link:/file: deps are skipped — they are not updatable);
 *   2. retries the boot;
 *   3. if it still fails, asks you whether to disable the plugin (writes a
 *      disable overlay passed via --patch; the loader audit skips disabled rows).
 *
 * Restoring a plugin: `doctor.mjs --profile <p> enable <name>`.
 *
 * State lives next to the profile:
 *   ~/.dsh/profiles/<p>/tofu-doctor.json          (what got disabled, why)
 *   ~/.dsh/profiles/<p>/tofu-doctor-overlay.yml   (generated disable patch)
 *   ~/.dsh/profiles/<p>/tofu-doctor-probe.yml     (temporary, bisect probes)
 *
 * Usage:
 *   node doctor.mjs --profile web              # diagnose & repair
 *   node doctor.mjs --profile web --no-update  # skip auto-update attempts
 *   node doctor.mjs --profile web --yes        # no prompts (disable freely)
 *   node doctor.mjs --profile web --probe 8    # per-probe window for bisect (s)
 *   node doctor.mjs --profile web enable <name>
 *   node doctor.mjs --profile web disabled
 */

import { spawn, spawnSync } from 'node:child_process'
// spawn(…, { shell: true }) is required on Windows to run dsh.cmd. Silence its
// DEP0190 warning: node's default printer is itself a 'warning' listener
// registered at bootstrap, so it must be removed before re-adding a filter
// (NODE_NO_WARNINGS alone only takes effect at bootstrap; keep it for children).
process.env.NODE_NO_WARNINGS = '1'
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name === 'DeprecationWarning' && w.code === 'DEP0190') return
  console.warn(`${w.name} ${w.message}`)
})
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--profile') flags.profile = args[++i]
  else if (a === '--dsh') flags.dsh = args[++i]
  else if (a === '--no-update') flags.update = false
  else if (a === '--yes') flags.yes = true
  else if (a === '--alive') flags.alive = Number(args[++i])
  else if (a === '--probe') flags.probe = Number(args[++i])
  else if (a === '--') { flags.appArgs = args.slice(i + 1); break }
  else positional.push(a)
}
const profile = flags.profile || 'web'
const dshBin = flags.dsh || 'dsh'
const aliveMs = (flags.alive ?? 40) * 1000
const probeMs = (flags.probe ?? 15) * 1000
const canUpdate = flags.update !== false
const autoYes = !!flags.yes
const RL = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => RL.question(q, (a) => r(a.trim().toLowerCase())))
const log = (...a) => console.log('[tofu-doctor]', ...a)

const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const statePath = path.join(profileDir, 'tofu-doctor.json')
const overlayPath = path.join(profileDir, 'tofu-doctor-overlay.yml')
const probePath = path.join(profileDir, 'tofu-doctor-probe.yml')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { disabled: [] }
process.on('exit', () => { try { rmSync(probePath, { force: true }) } catch {} })

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function saveState() {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
  writeFileSync(overlayPath, state.disabled.length === 0
    ? '# tofu-doctor: nothing disabled\n[]\n'
    : state.disabled.map((d) => `- id: ${d.id}\n  disabled: true # ${d.name}, disabled by tofu-doctor\n`).join(''))
}

/** name → row id map, scraped from `dsh --profile <p> --dump-config`. */
function idMap() {
  const r = spawnSync(dshBin, ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: true })
  const out = (r.stdout || '') + (r.stderr || '')
  const map = new Map()
  let pendingId = null
  for (const line of out.split(/\r?\n/)) {
    const idm = line.match(/^- id:\s*'?([^']+)'?\s*$/)
    if (idm) { pendingId = idm[1].trim(); continue }
    const nm = line.match(/^\s+name:\s*'?([^']+)'?\s*$/)
    if (nm && pendingId) { map.set(nm[1].trim(), pendingId); pendingId = null; continue }
    if (pendingId && /^\S/.test(line)) pendingId = null
  }
  return map
}

/** Dependencies `dsh plugin add` installed into this profile. */
function profileDeps() {
  try {
    const pj = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return pj.dependencies || {}
  } catch { return {} }
}

function depSpec(name) {
  return profileDeps()[name]
}

/** Names the loader audit blamed, from boot output. */
function parseFailures(text) {
  const names = new Set()
  const loaded = text.match(/plugin\(s\) failed to load:\s*([^;\n]+)/)
  if (loaded) loaded[1].split(',').forEach((n) => names.add(n.trim()))
  const act = text.match(/did not activate\n([\s\S]+)$/)
  if (act) for (const line of act[1].split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9@/_-][^:\s]*):/)
    if (m) names.add(m[1])
  }
  return [...names]
}

/** Crash stack names no plugin: match node_modules frames against profile deps. */
function guessFromStack(text) {
  const hits = []
  for (const name of Object.keys(profileDeps())) {
    const pat = new RegExp(esc('node_modules/' + name + '/').replaceAll('/', '[\\\\/]'))
    if (pat.test(text)) { hits.push(name); continue }
    const spec = depSpec(name)
    if (spec && /^(link:|file:)/.test(spec)) {
      const dir = path.resolve(profileDir, spec.slice(spec.indexOf(':') + 1))
      if (text.includes(dir)) hits.push(name)
    }
  }
  return hits
}

/** Boot attempt. Resolves {ok, output}; ok = process stayed up for windowMs. */
function bootOnce(extraPatch, windowMs) {
  return new Promise((resolve) => {
    // dsh 0.1.5+ CLI: `web` is a subcommand alias of `--profile web` and it
    // REJECTS a parent --profile ("takes none of parent --profile ...").
    // So: web profile → `dsh web [flags]`, custom profile → `dsh --profile <p> [flags]`
    // with no `web` token (the profile's composition picks the app).
    const argv = profile === 'web' ? ['web'] : ['--profile', profile]
    if (extraPatch) argv.push('--patch', extraPatch)
    argv.push(...(flags.appArgs || []))
    const child = spawn(dshBin, argv, { shell: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    let output = ''
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ok) {
        // Kill the whole tree: on Windows a plain kill() would orphan the real
        // dsh process behind the shell wrapper and keep this process alive.
        if (process.platform === 'win32') {
          try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
        } else {
          child.kill()
        }
        resolve({ ok: true, output })
      } else resolve({ ok: false, output })
    }
    const timer = setTimeout(() => finish(true), windowMs || aliveMs)
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('exit', (code) => { if (code !== 0) finish(false); else { output += '\n(process exited with code 0 during boot window — counting as failure for diagnosis)'; finish(false) } })
  })
}

const addrClash = (output) => /EADDRINUSE|already in use|address already/i.test(output)
// The dsh CLI rejected our own argv shape (doctor vs. dsh version mismatch) —
// never report that as a plugin problem.
const cliShapeError = (output) => /takes none of|unknown (?:option|command)|expected an argument|too many arguments/i.test(output)

function tryUpdate(name) {
  const r = spawnSync(dshBin, ['plugin', '--profile', profile, 'update', name], { encoding: 'utf8', shell: true, stdio: 'inherit' })
  return r.status === 0
}

/**
 * Binary-search the culprit when the error names nobody.
 * Probes disable sets via a throwaway --patch overlay (persistent disables from
 * state stay disabled); monotonicity is assumed: disabling a healthy plugin
 * cannot break boot.
 */
async function bisectCulprits(boot) {
  const map = idMap()
  const candidates = []
  for (const name of Object.keys(profileDeps())) {
    if (state.disabled.some((d) => d.name === name)) continue
    if (!map.get(name)) { log(`候选 ${name} 不在配置行里，跳过`); continue }
    candidates.push(name)
  }
  if (candidates.length === 0) return { notPlugins: true, output: boot.output }

  const probe = async (names) => {
    const ids = [...state.disabled.map((d) => d.id), ...names.map((n) => map.get(n))]
    writeFileSync(probePath, ids.map((id) => `- id: ${id}\n  disabled: true # tofu-doctor bisect probe\n`).join(''))
    const r = await bootOnce(probePath, probeMs)
    if (addrClash(r.output)) {
      console.error('端口被占用（可能已有一个 dsh 在跑）。用 -- <dsh web 的参数...> 传个别的端口再试，例如 -- --port 13080')
      process.exit(3)
    }
    if (cliShapeError(r.output)) {
      console.error('dsh 拒绝了 doctor 的探测参数（doctor 与本机 dsh CLI 的参数形式不匹配）。原始报错：\n')
      console.error(r.output.slice(-2000))
      process.exit(7)
    }
    return r
  }

  const all = await probe(candidates)
  if (!all.ok) return { notPlugins: true, output: boot.output }
  log(`${candidates.length} 个插件全部禁用后能启动 → 凶手在插件里，开始二分定位`)

  const found = []
  for (;;) {
    const rest = candidates.filter((n) => !found.includes(n))
    if (rest.length === 0) break
    let subset = rest
    while (subset.length > 1) {
      const half = subset.slice(0, Math.ceil(subset.length / 2))
      const r = await probe([...found, ...half])
      log(`  探测：禁用 ${[...found, ...half].join(', ')} → ${r.ok ? '能启动（凶手在这一半）' : '仍失败（凶手在另一半）'}`)
      subset = r.ok ? half : subset.filter((n) => !half.includes(n))
    }
    log(`  锁定嫌疑：${subset[0]}`)
    found.push(subset[0])
    const v = await probe(found)
    if (v.ok) break
    log(`  禁用 ${subset[0]} 后仍失败 → 不止一个坏插件，继续排查`)
  }
  return { culprits: found }
}

async function main() {
  if (positional[0] === 'disabled') {
    console.log(JSON.stringify(state.disabled, null, 2))
    return
  }
  if (positional[0] === 'enable') {
    const target = positional[1]
    if (!target) { console.error('enable <name> 需要插件名'); process.exit(2) }
    const before = state.disabled.length
    state.disabled = state.disabled.filter((d) => d.name !== target && d.id !== target)
    if (state.disabled.length === before) log(`没有关于 ${target} 的禁用记录`)
    else { saveState(); log(`已恢复 ${target} —— 下次启动它回来了`) }
    return
  }

  if (!existsSync(path.join(profileDir, 'package.json'))) {
    console.error(`profile 不存在：${profileDir}（dsh --profile ${profile} --from-default-profile web 可创建）`)
    process.exit(2)
  }
  log(`诊断 profile: ${profile}`)
  if (state.disabled.length > 0) log(`已有历史禁用: ${state.disabled.map((d) => d.name).join(', ')}（enable 可恢复）`)

  let overlay = existsSync(overlayPath) && state.disabled.length > 0 ? overlayPath : undefined
  const suspectQueue = []      // culprits identified in earlier rounds, unresolved
  const triedUpdate = new Set() // one update attempt per plugin per run
  let attempt = 0
  // shell: true makes output buffering flaky — boot once, then act.
  // Loop bound: each round must disable or update something concrete.
  while (attempt++ < 10) {
    const boot = await bootOnce(overlay)
    if (boot.ok) {
      log(attempt === 1
        ? '✔ 启动正常，没有发现问题（测试窗口内进程存活，已关闭测试实例）'
        : `✔ 修复成功，profile 现在能正常启动（第 ${attempt} 轮）`)
      if (state.disabled.length > 0) log(`提示：当前仍处于禁用状态的插件：${state.disabled.map((d) => d.name).join(', ')}；修好后记得 enable`)
      return
    }
    if (addrClash(boot.output)) {
      console.error('端口被占用（可能已有一个 dsh 在跑）。用 -- <dsh web 的参数...> 传个别的端口再试，例如 -- --port 13080')
      process.exit(3)
    }
    if (cliShapeError(boot.output)) {
      console.error('dsh 拒绝了 doctor 的启动参数（doctor 与本机 dsh CLI 的参数形式不匹配）。原始报错：\n')
      console.error(boot.output.slice(-2000))
      process.exit(7)
    }

    let names = parseFailures(boot.output)
    let how = 'loader 点名'
    if (!names.length && suspectQueue.length) { names = [...suspectQueue]; how = '前几轮已定位' }
    if (!names.length) {
      names = guessFromStack(boot.output)
      if (names.length) how = '堆栈路径'
    }
    if (!names.length) {
      log(`报错没有点名插件 → 自动二分定位（每次探测最多等 ${probeMs / 1000}s，可用 --probe 调整）`)
      const res = await bisectCulprits(boot)
      if (res.notPlugins) {
        log('把插件全部禁用后仍然起不来 → 不是（只是）插件的问题。原始输出如下：\n')
        console.error(res.output.slice(-4000))
        process.exit(4)
      }
      names = res.culprits
      how = '二分定位'
    }
    names = names.filter((n) => !state.disabled.some((d) => d.name === n))
    if (names.length === 0) {
      log('启动失败，但报错不是插件加载类问题。原始输出如下：\n')
      console.error(boot.output.slice(-4000))
      process.exit(4)
    }
    suspectQueue.length = 0
    for (const n of names) suspectQueue.push(n)
    log(`嫌疑插件（${how}）：${names.join(', ')}`)

    const map = idMap()
    for (const name of names) {
      const spec = depSpec(name)
      if (canUpdate && spec && !/^(link:|file:|workspace:)/.test(spec) && !triedUpdate.has(name)) {
        triedUpdate.add(name)
        log(`插件 ${name} 启动失败 → 先尝试更新（spec: ${spec.slice(0, 60)}）`)
        if (tryUpdate(name)) continue // retry boot first before blaming it further
      }
      const id = map.get(name)
      if (!id) { log(`无法把插件名 ${name} 对应到配置行 id，请手动检查`); continue }
      let yes = autoYes
      if (!yes) {
        const a = await ask(`插件 ${name}（行 id: ${id}）反复导致启动失败。禁用它让 dsh 先跑起来？[y/N] `)
        yes = a === 'y' || a === 'yes'
      }
      if (yes) {
        state.disabled.push({ name, id, at: new Date().toISOString() })
        saveState()
        overlay = overlayPath
        log(`已禁用 ${name}（记录在 ${path.relative(process.cwd(), statePath)}；enable ${name} 恢复）`)
        break // re-boot with the new overlay
      } else {
        log(`保持 ${name} 启用。修好后重跑 doctor；原始报错：\n`)
        console.error(boot.output.slice(-2500))
        process.exit(5)
      }
    }
  }
  console.error('超过最大修复轮数，停手。手动检查上面的记录。')
  process.exit(6)
}

main().then(() => process.exit(0)).finally(() => RL.close())
