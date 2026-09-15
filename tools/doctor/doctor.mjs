#!/usr/bin/env node
/**
 * tofu doctor — diagnose a dsh profile that refuses to boot.
 *
 * dsh boots fail-fast: one broken plugin kills the whole process. This tool
 * boots the profile in a supervised loop, parses the loader's failure reports,
 * and for each blamed plugin:
 *
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
 *
 * Usage:
 *   node doctor.mjs --profile web            # diagnose & repair
 *   node doctor.mjs --profile web --no-update  # skip auto-update attempts
 *   node doctor.mjs --profile web --yes        # no prompts (disable freely)
 *   node doctor.mjs --profile web enable <name>
 *   node doctor.mjs --profile web disabled
 */

import { spawn, spawnSync } from 'node:child_process'
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
  else if (a === '--') { flags.appArgs = args.slice(i + 1); break }
  else positional.push(a)
}
const profile = flags.profile || 'web'
const dshBin = flags.dsh || 'dsh'
const aliveMs = (flags.alive ?? 40) * 1000
const canUpdate = flags.update !== false
const autoYes = !!flags.yes
const RL = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => RL.question(q, (a) => r(a.trim().toLowerCase())))
const log = (...a) => console.log('[tofu-doctor]', ...a)

const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const statePath = path.join(profileDir, 'tofu-doctor.json')
const overlayPath = path.join(profileDir, 'tofu-doctor-overlay.yml')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { disabled: [] }

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

/** Boot attempt. Resolves {ok, output}; ok = process stayed up for aliveMs. */
function bootOnce(extraPatch) {
  return new Promise((resolve) => {
    const argv = ['--profile', profile]
    if (extraPatch) argv.push('--patch', extraPatch)
    argv.push('web', ...(flags.appArgs || []))
    const child = spawn(dshBin, argv, { shell: true })
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
    const timer = setTimeout(() => finish(true), aliveMs)
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('exit', (code) => { if (code !== 0) finish(false); else { output += '\n(process exited with code 0 during boot window — counting as failure for diagnosis)'; finish(false) } })
  })
}

function tryUpdate(name) {
  const r = spawnSync(dshBin, ['plugin', '--profile', profile, 'update', name], { encoding: 'utf8', shell: true, stdio: 'inherit' })
  return r.status === 0
}

function depSpec(name) {
  try {
    const pj = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return (pj.dependencies || {})[name]
  } catch { return undefined }
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

  const overlay = existsSync(overlayPath) && state.disabled.length > 0 ? overlayPath : undefined
  let attempt = 0
  // shell: true makes output buffering flaky — boot once, then act.
  // Loop bound: each round must disable or update something concrete.
  while (attempt++ < 8) {
    const boot = await bootOnce(overlay)
    if (boot.ok) {
      log(attempt === 1
        ? '✔ 启动正常，没有发现问题（测试窗口内进程存活，已关闭测试实例）'
        : `✔ 修复成功，profile 现在能正常启动（第 ${attempt} 轮）`)
      if (state.disabled.length > 0) log(`提示：当前仍处于禁用状态的插件：${state.disabled.map((d) => d.name).join(', ')}；修好后记得 enable`)
      return
    }
    if (/EADDRINUSE|already in use|address already/i.test(boot.output)) {
      console.error('端口被占用（可能已有一个 dsh 在跑）。用 -- <dsh web 的参数...> 传个别的端口再试，例如 -- --port 13080')
      process.exit(3)
    }
    const names = parseFailures(boot.output)
    if (names.length === 0) {
      log('启动失败，但报错不是插件加载类问题。原始输出如下：\n')
      console.error(boot.output.slice(-4000))
      process.exit(4)
    }
    const map = idMap()
    for (const name of names) {
      if (state.disabled.some((d) => d.name === name)) continue
      const spec = depSpec(name)
      if (canUpdate && spec && !/^(link:|file:|workspace:)/.test(spec)) {
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
        log(`已禁用 ${name}（记录在 ${path.relative(process.cwd(), statePath)}；enable ${name} 恢复）`)
        return mainRerun()
      } else {
        log(`保持 ${name} 启用。修好后重跑 doctor；原始报错：\n`)
        console.error(boot.output.slice(-2500))
        process.exit(5)
      }
    }
  }
  console.error('超过最大修复轮数，停手。手动检查上面的记录。')
  process.exit(6)

  function mainRerun() {
    // small recursion via flag: after disabling, redo the boot loop with overlay
    return (async () => {
      const ov = overlayPath
      for (let i = 0; i < 5; i++) {
        const boot = await bootOnce(ov)
        if (boot.ok) { log(`✔ 禁用后启动成功（禁用清单：${state.disabled.map((d) => d.name).join(', ')}）`); return }
        const names = parseFailures(boot.output)
        const fresh = names.filter((n) => !state.disabled.some((d) => d.name === n))
        if (fresh.length === 0) { log('禁用后仍失败，且不是已记录插件的问题。原始输出：\n'); console.error(boot.output.slice(-3000)); process.exit(4) }
        for (const n of fresh) {
          let yes = autoYes
          if (!yes) yes = (await ask(`这个还炸：${n}。也禁用？[y/N] `)) === 'y'
          if (!yes) process.exit(5)
          const id = idMap().get(n)
          if (id) { state.disabled.push({ name: n, id, at: new Date().toISOString() }); saveState(); log(`已禁用 ${n}`) }
        }
      }
    })()
  }
}

main().then(() => process.exit(0)).finally(() => RL.close())
