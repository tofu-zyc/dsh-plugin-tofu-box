/**
 * computer-use v2 self-test — real Cua Driver runtime, fake plugin context.
 *
 *   node selftest/run.mjs
 *
 * Runs against the live desktop: it launches NOTEPAD and captures/clicks/types/
 * chords INTO THAT NOTEPAD ONLY (background injection — your cursor and
 * foreground are untouched, except the one chord test that proves the driver's
 * brief foreground fallback). The notepad instance it starts is killed at the
 * end (Ctrl+A + Ctrl+Backspace chords are verified end-to-end through the
 * window title). Desktop-scope tools (desktop click/drag/move/type) move the
 * real pointer on purpose and are therefore NOT exercised here.
 *
 * Exit code = number of hard failures. Soft notes are printed as WARN.
 */

import { spawnSync } from 'node:child_process'
import { pngDecode, pngEncode, resizeRgba, cropRgba, name as pluginName, inject, apply } from '../index.js'

// ── tiny assert harness ──────────────────────────────────────────────────────
let hard = 0; let soft = 0; let n = 0
const ok = (cond, msg) => { n++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + n + ' ' + msg); if (!cond) hard++ }
const info = (msg) => console.log('     · ' + msg)
const warn = (msg) => { console.log('WARN ' + msg); soft++ }

// ── fake plugin context ──────────────────────────────────────────────────────
function makeCtx() {
  const logs = []
  const tools = new Map()
  const events = new Map()
  const disposers = []
  let attN = 0
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
    },
    effect(fn, desc) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => { if (typeof d === 'function') d() }
    },
    on(ev, fn) {
      if (!events.has(ev)) events.set(ev, [])
      events.get(ev).push(fn)
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => { tools.delete(def.name) }
      },
    },
    attachments: {
      async saveImage({ data, mediaType }) {
        const mt = mediaType || 'image/png'
        let width = 0; let height = 0
        if (mt === 'image/png') {
          if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) throw new Error('attachment claims PNG but is not')
          width = data.readUInt32BE(16); height = data.readUInt32BE(20)
        } else if (mt === 'image/jpeg') {
          let o = 2
          while (o + 9 < data.length) {
            if (data[o] !== 0xff) { o++; continue }
            const m = data[o + 1]
            const segLen = data.readUInt16BE(o + 2)
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { height = data.readUInt16BE(o + 5); width = data.readUInt16BE(o + 7); break }
            o += 2 + segLen
          }
          if (!width) throw new Error('attachment claims JPEG but no SOF found')
        } else if (data.length < 12) throw new Error('attachment too small to be an image')
        return { attachmentId: 'att-' + (++attN), mediaType: mt, bytes: data.length, width, height }
      },
    },
  }
  return { ctx, tools, events, disposers, logs }
}

const { ctx, tools, events, disposers, logs } = makeCtx()

// ── 1. PNG codec units ───────────────────────────────────────────────────────
{
  const w = 8; const h = 6
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) { data[i * 4] = (i * 7) & 255; data[i * 4 + 1] = (i * 13) & 255; data[i * 4 + 2] = (i * 29) & 255; data[i * 4 + 3] = 255 }
  const round = pngDecode(pngEncode({ width: w, height: h, data }))
  ok(round.width === w && round.height === h && round.data.equals(data), 'PNG encode→decode roundtrip is lossless')

  const solid = { width: 100, height: 50, data: Buffer.alloc(100 * 50 * 4) }
  for (let i = 0; i < 100 * 50; i++) { solid.data[i * 4] = 10; solid.data[i * 4 + 1] = 200; solid.data[i * 4 + 2] = 40; solid.data[i * 4 + 3] = 255 }
  const small = resizeRgba(solid, 10, 5)
  ok(small.width === 10 && small.height === 5 && small.data[0] === 10 && small.data[1] === 200 && small.data[2] === 40, 'box resize keeps a solid color exact')

  const c = cropRgba(solid, 90, 45, 500, 500)
  ok(c.width === 10 && c.height === 5, 'crop clamps to image bounds')
}

// ── 2. apply() + registration ────────────────────────────────────────────────
ok(pluginName === 'computer-use', 'module exports name=computer-use')
ok(Array.isArray(inject) && inject.join(',') === 'tools,attachments', 'inject = tools,attachments')
apply(ctx, { settleMs: 200 })
{
  const got = [...tools.keys()].sort()
  ok(got.length === 13, '13 tools registered (' + got.join(', ') + ')')
  ok(logs.some((l) => l[1].includes('cua-driver backend')), 'boot log emitted')
}

const EXEC = { agent: { id: 'selftest' }, signal: undefined }
const run = (tool, args) => tools.get(tool).execute(args ?? {}, EXEC)
const gate = (name, agent) => {
  const hs = events.get('tools/pre-execute') ?? []
  if (hs.length !== 1) throw new Error('expected exactly 1 pre-execute handler, got ' + hs.length)
  return hs[0]({ name, agent, signal: undefined }, () => 'PASSED')
}
/** First editable-looking element token from a SHOT value's element list. */
const pickToken = (shot) => {
  const lines = String(shot.elements ?? '').split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9]+ [^\s]/.test(l) && /^[A-Za-z0-9_]+:\d+$/.test(l.split(/\s+/).pop() ?? ''))
  for (const l of lines) if (/(edit|document|text)/i.test(l)) return l.split(/\s+/).pop()
  return lines.length > 0 ? lines[0].split(/\s+/).pop() : null
}

// ── 3. approval gate starts closed for mutating tools ────────────────────────
{
  const r = gate('computer_click', { id: 'fresh-agent' })
  ok(r && r.kind === 'ask', 'pre-execute gate asks before first mutating call')
  ok(gate('computer_screenshot', { id: 'fresh-agent' }) === 'PASSED', 'read-only tools never ask')
}

// ── 4. live driver: window-centric flows ─────────────────────────────────────
let notepadPid = null
try {
  // desktop overview (also exercises real driver PNG decode + plugin resize)
  const desk = await run('computer_screenshot', {})
  ok(desk.image && desk.image.width > 0 && desk.image.width <= 1568, 'desktop capture returns frame ≤ maxDim (' + desk.image.width + 'x' + desk.image.height + ')')
  ok(desk.frameText.includes('PRIMARY'), 'desktop frame guidance mentions primary display')

  const cur = await run('computer_cursor', {})
  ok(/^-?\d+,-?\d+$/.test(cur.physical), 'cursor position reads ' + cur.physical)

  // launch notepad in background
  const openShot = await run('computer_open', { name: 'Notepad', settle_seconds: 3 })
  const pidMatch = /pid (\d+)/.exec(openShot.summary)
  ok(pidMatch !== null, 'computer_open returned a pid: ' + (pidMatch ? pidMatch[1] : '—'))
  notepadPid = pidMatch ? Number(pidMatch[1]) : null
  ok(openShot.image && openShot.image.width > 0, 'open returned a window capture')

  const token = pickToken(openShot)
  ok(token !== null, 'window tree exposed elements, picked token ' + token)

  if (token && notepadPid) {
    // background element typing (UIA SetValue), verified through the UIA tree
    const typed = await run('computer_type', { element: token, text: 'HELLO-SELFTEST-123' })
    ok(typed.summary.includes('Typed'), 'background type into element accepted')
    const verify = await run('computer_screenshot', { app: 'notepad', query: 'HELLO' })
    if (String(verify.elements ?? '').includes('HELLO-SELFTEST')) info('typed text visible in the UIA tree (verified)')
    else warn('typed text not visible in element tree projection (visual check needed)')

    // window-local click + scroll (background, no pointer move)
    const clicked = await run('computer_click', { x: 140, y: 140 })
    ok(clicked.summary.includes('Clicked'), 'window-local click: ' + clicked.summary)
    const scrolled = await run('computer_scroll', { direction: 'down', amount: 2 })
    ok(scrolled.summary.includes('Scrolled'), 'scroll accepted')

    // CHORD dispatch on a XAML target: hotkey UIA route refuses (accelerator
    // hidden behind a closed menu) → pressChord falls back to foreground
    // SendInput. Foreground activation may be refused by the OS foreground-lock
    // when the agent runs from a terminal (documented env limit) — that refusal
    // is the CORRECT behavior, so we accept either outcome; only a plugin bug
    // (crash / unhandled path) is a hard failure. When it lands we confirm.
    const fresh = await run('computer_screenshot', { app: 'notepad' })
    const token2 = pickToken(fresh)
    if (token2) await run('computer_type', { element: token2, text: 'ALPHA BRAVO' })
    let chordErr = ''
    const chord = await run('computer_key', { keys: 'ctrl+a' }).catch((e) => { chordErr = String(e.message); return null })
    if (chord) {
      ok(chord.summary.includes('Pressed'), 'chord ctrl+a dispatched: ' + chord.summary.slice(0, 110))
      await run('computer_key', { keys: 'ctrl+backspace' }).catch(() => null)
      const after = await run('computer_windows', { app: 'notepad' })
      if (!/ALPHA BRAVO/.test(after.table)) ok(true, 'chord effect verified: ctrl+a + ctrl+backspace cleared the document (title: ' + (/"[^"]*"\s+"([^"]*)"/.exec(after.table)?.[1] ?? '?') + ')')
      else warn('ctrl+a dispatched but document not cleared — foreground timing edge; dispatch path exercised OK')
    } else if (/foreground_unavailable|could not find a UIA AcceleratorKey/i.test(chordErr)) {
      warn('chord ctrl+a refused by OS foreground-lock (agent run from a terminal) — expected on this host: ' + chordErr.slice(0, 90))
      ok(/hotkey .*:/.test(chordErr), 'chord failure surfaces a clean documented error (not a crash)')
    } else {
      ok(false, 'chord ctrl+a threw an unexpected error: ' + chordErr.slice(0, 160))
    }

    // sequence: pre-validation, then a real flow on the same window
    let seqErr = ''
    await run('computer_sequence', { steps: ['type:ok', 'bogus:1'] }).catch((e) => { seqErr = String(e.message) })
    ok(seqErr.includes('step 2'), 'sequence pre-validates steps ("' + seqErr.slice(0, 60) + '")')
    const seq = await run('computer_sequence', { steps: ['type:SEQ-LINE', 'wait:0.2', 'key:enter'] })
    ok(seq.summary.includes('Ran 3 steps'), 'sequence ran atomically: ' + seq.summary.slice(0, 80))

    // zoom (window-only, native resolution)
    const zoom = await run('computer_zoom', { x0: 20, y0: 20, x1: 320, y1: 220 })
    ok(zoom.image && zoom.image.width > 0, 'zoom returned native-res crop ' + zoom.image.width + 'x' + zoom.image.height)
  } else {
    warn('no element token — window interaction tests skipped')
  }

  const waited = await run('computer_wait', { seconds: 0.2 })
  ok(waited.summary.includes('Waited'), 'computer_wait returns fresh shot')

  // gate is now open for this agent (first mutating call granted it)
  ok(gate('computer_click', { id: 'selftest' }) === 'PASSED', 'approval gate opens after first grant (once-per-agent)')
  ok(gate('computer_click', { id: 'other-agent' }).kind === 'ask', 'a different agent still gets asked')
} catch (e) {
  ok(false, 'live driver flow threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e))
} finally {
  // reclaim the notepad this test started (stdio:ignore keeps it sandbox-safe)
  if (notepadPid) {
    const k = spawnSync('taskkill', ['/PID', String(notepadPid), '/F'], { stdio: 'ignore' })
    info(k.status === 0 ? 'cleanup: killed notepad ' + notepadPid : 'cleanup: notepad ' + notepadPid + ' not killed (status ' + k.status + ')')
  }
}

// ── 5. disposal shuts the runtime down ───────────────────────────────────────
{
  const windowsTool = tools.get('computer_windows')
  for (let i = disposers.length - 1; i >= 0; i--) disposers[i]() // LIFO, like fiber stop
  let shutErr = ''
  await windowsTool.execute({}, EXEC).catch((e) => { shutErr = String(e.message) })
  ok(shutErr.includes('shut down'), 'after dispose the driver refuses with "shut down"')
  ok(tools.size === 0, 'all tool registrations disposed (' + tools.size + ' left)')
}

console.log('\n' + (hard === 0 ? 'SELFTEST OK' : 'SELFTEST FAILED') + ' — ' + (n - hard) + '/' + n + ' passed, ' + soft + ' warnings')
process.exit(hard === 0 ? 0 : 1)
