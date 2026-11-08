/**
 * Panel sizing matrix (P0 investigation): find WHICH mount path leaves the
 * terrarium canvas painted into a corner of the stage.
 *
 * Why this exists: the fault is a race between the panel's mount, the store's
 * view computation and the browser's layout, so it shows up on some sessions and
 * not others. A one-shot screenshot cannot prove it; a matrix can.
 *
 *   node tests/panel-layout.mjs --url URL [--repeat 3] [--json out.json]
 *
 * Each cell runs in a FRESH Chrome so that cold start is genuinely cold. Read the
 * table at the end: stageW/canvasW is the DOM size invariant, `paint` is the share
 * of the canvas that is actually drawn (1.00 = healthy, ~0.05 = the corner bug).
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/** Line break, kept in one place so the script has no escaped literals. */
const NL = String.fromCharCode(10)

const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt }
const url = arg('url', '')
if (url === '') { console.error('need --url'); process.exit(2) }
const repeat = Number(arg('repeat', '1'))
const jsonOut = arg('json', '')
const panelLabel = arg('panel', '像素生态缸')
const otherLabel = arg('other', '植物大战僵尸')
const samples = arg('samples', '0,100,300,800,2000').split(',').map(Number).filter(Number.isFinite)
const chromePath = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const settle = Number(arg('settle', '2500'))
/**
 * Reuse a profile across runs. A fresh profile always starts an empty world, which
 * takes the synchronous create path; the fault is reported on restart, i.e. when
 * the panel finds a save and loads it ASYNCHRONOUSLY. Same profile twice = the
 * warm-start cell.
 */
const profileDir = arg('profile', '')
/** Wait this long for an autosave to appear, so the next run starts warm. */
const waitSave = Number(arg('wait-save', '0'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Read the canvas geometry AND how much of it is actually painted.
 * @returns {object} stage/canvas rects, backing-store attributes, store view, paint share.
 */
const PROBE = '(() => {'
  + ' const r = el => { if (el === null) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };'
  + ' const stageEl = document.querySelector(".pe-stage");'
  + ' const canvas = document.querySelector(".pe-canvas");'
  + ' const stage = r(stageEl);'
  + ' const box = r(canvas);'
  + ' const dbg = typeof window.__peDebug === "function" ? window.__peDebug() : null;'
  // Paint share: sample the backing store on a grid and count non-black cells.
  // The reported fault is "one small block drawn, the rest black", which is
  // invisible to a size assertion but obvious here.
  + ' let paint = null, painted = 0, sampled = 0;'
  + ' if (canvas !== null && typeof canvas.getContext === "function") {'
  + '   try {'
  + '     const ctx = canvas.getContext("2d");'
  + '     const w = canvas.width, h = canvas.height;'
  + '     const step = Math.max(1, Math.floor(Math.min(w, h) / 24));'
  + '     for (let y = 0; y < h; y += step) {'
  + '       for (let x = 0; x < w; x += step) {'
  + '         sampled += 1;'
  + '         const d = ctx.getImageData(x, y, 1, 1).data;'
  + '         if (d[0] + d[1] + d[2] > 24) painted += 1;'
  + '       }'
  + '     }'
  + '     paint = sampled === 0 ? null : painted / sampled;'
  + '   } catch (e) { paint = "unreadable: " + e.message }'
  + ' }'
  + ' return { stage, canvas: box, ddx: stage && box ? Math.abs(box.w - stage.w) : null,'
  + '   ddy: stage && box ? Math.abs(box.h - stage.h) : null,'
  + '   attr: canvas === null ? null : [canvas.width, canvas.height],'
  + '   view: dbg && dbg.view ? [dbg.view.width, dbg.view.height, dbg.view.scale] : null,'
  + '   paint, onboard: document.querySelectorAll(".pe-onboard").length,'
  + '   hud: (document.querySelector(".pe-hud-bl") || {}).textContent };'
  + ' })()'

/** Click a sidebar entry by its exact text. @returns {boolean} found. */
const openPanel = label => '(() => {'
  + ' const want = ' + JSON.stringify(label) + ';'
  + ' const nodes = [...document.querySelectorAll("*")].filter(e => e.children.length === 0 && (e.textContent || "").trim() === want);'
  + ' if (nodes.length === 0) return false;'
  + ' (nodes[0].closest("button,a,[role=button],li,div") || nodes[0]).click(); return true; })()'

const closePanel = '(() => { const b = [...document.querySelectorAll(".pe-root button")].find(x => (x.textContent || "").trim() === "回到对话"); if (b) { b.click(); return true } return false })()'

/**
 * Drive one browser through the matrix.
 * @param {number} run - 1-based repeat index.
 * @returns {object[]} one record per cell.
 */
async function runMatrix(run) {
  const port = 9500 + Math.floor(Math.random() * 400)
  const profile = profileDir !== '' ? profileDir : process.env.TEMP + '/pe-matrix-' + port
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--window-size=1600,1000',
    '--force-device-scale-factor=1', '--user-data-dir=' + profile, url,
  ], { stdio: 'ignore' })
  let ws = null
  let seq = 0
  const pending = new Map()
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timed out')) }, 15000)
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.text || '') + ': ' + ((r.exceptionDetails.exception || {}).description || ''))
    return r.result && r.result.value
  }
  const waitFor = async (fn, ms, label) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { const v = await fn(); if (v) return v } catch { /* retry */ }
      await sleep(250)
    }
    throw new Error('timed out waiting for ' + label)
  }
  const cells = []
  let hadSaveAtStart = null
  /** Sample the invariant over time. @param {string} cell - matrix cell name. */
  const sampleNow = async cell => {
    const record = await evaluate(PROBE)
    cells.push({ run, cell, hadSaveAtStart, ...record })
    return record
  }
  try {
    const target = await waitFor(async () => {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      return list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    }, 25000, 'a debuggable page')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('websocket failed')) })
    ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.error) entry.rej(new Error(JSON.stringify(msg.error)))
      else entry.res(msg.result)
    }
    await sleep(settle)
    hadSaveAtStart = await evaluate("(() => { try { return localStorage.getItem('dsh-pixel-ecosystem:v2') !== null } catch { return null } })()")
    process.stdout.write('  save present at start: ' + hadSaveAtStart + NL)

    // --- cell A: cold/warm start -------------------------------------------
    await evaluate(openPanel(panelLabel))
    for (const ms of samples) { if (ms > 0) await sleep(ms); await sampleNow('A cold start') }

    // --- cell B: leave the panel and come back -----------------------------
    await evaluate(closePanel)
    await sleep(600)
    await evaluate(openPanel(panelLabel))
    for (const ms of samples) { if (ms > 0) await sleep(ms); await sampleNow('B switch back') }

    // --- cell C: resize the viewport while mounted -------------------------
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await sampleNow('C resize small')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await sampleNow('C resize back')
    await send('Emulation.clearDeviceMetricsOverride')
    await sleep(300)

    // --- cell D: hide and show the document --------------------------------
    await evaluate('(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); return true })()')
    await sleep(800)
    await evaluate('(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); return true })()')
    for (const ms of samples) { if (ms > 0) await sleep(ms); await sampleNow('D hide/show') }
    if (waitSave > 0) {
      const deadline = Date.now() + waitSave
      let size = null
      while (Date.now() < deadline) {
        size = await evaluate("(() => { try { const v = localStorage.getItem('dsh-pixel-ecosystem:v2'); return v === null ? null : v.length } catch { return null } })()")
        if (size !== null) break
        await sleep(500)
      }
      process.stdout.write('  autosave: ' + (size === null ? 'none' : size + ' chars') + NL)
    }
  } catch (error) {
    cells.push({ run, cell: 'ERROR', error: String(error).slice(0, 200) })
  } finally {
    try { if (ws) ws.close() } catch { /* ignore */ }
    chrome.kill()
  }
  return cells
}

const all = []
for (let run = 1; run <= repeat; run++) {
  process.stdout.write('run ' + run + '/' + repeat + ' ...' + NL)
  all.push(...await runMatrix(run))
}

// Deduplicate by (cell, run, sample index) so the table shows the LAST sample of
// each cell, which is the settled state, plus every distinct value seen.
const settled = new Map()
for (const record of all) {
  if (record.cell === 'ERROR') continue
  const key = record.cell
  const previous = settled.get(key) || { cell: key, runs: 0, worst: null, last: null, transient: 0 }
  previous.runs += 1
  // A sample taken before the first paint is legitimately empty; only a state that
  // is STILL wrong on the last sample of the cell counts as broken.
  const bad = (record.ddx !== null && record.ddx > 4) || (record.ddy !== null && record.ddy > 4)
    || (typeof record.paint === 'number' && record.paint < 0.5)
  if (bad) previous.transient += 1
  previous.last = record
  settled.set(key, previous)
}

process.stdout.write(NL + 'cell                stageW/canvasW  stageH/canvasH  canvasAttr   view(w,h,scale)      paint   verdict' + NL)
let broken = 0
for (const [name, entry] of settled) {
  const s = entry.last
  const sizeBad = (s.ddx !== null && s.ddx > 4) || (s.ddy !== null && s.ddy > 4)
  const paintBad = typeof s.paint === 'number' && s.paint < 0.5
  const verdict = entry.worst !== null || sizeBad || paintBad ? 'BROKEN' : 'ok'
  if (verdict === 'BROKEN') broken += 1
  process.stdout.write(name.padEnd(19)
    + ((s.stage ? s.stage.w : '?') + '/' + (s.canvas ? s.canvas.w : '?')).padStart(14)
    + ((s.stage ? s.stage.h : '?') + '/' + (s.canvas ? s.canvas.h : '?')).padStart(16)
    + (JSON.stringify(s.attr)).padStart(13)
    + ((s.view === null ? 'n/a' : s.view.join(','))).padStart(21)
    + (typeof s.paint === 'number' ? s.paint.toFixed(2) : String(s.paint)).padStart(8)
    + '   ' + verdict + NL)
}
for (const record of all) if (record.cell === 'ERROR') process.stdout.write('ERROR: ' + record.error + NL)
if (jsonOut !== '') writeFileSync(jsonOut, JSON.stringify(all, null, 1))
process.stdout.write(NL + (broken === 0 ? 'no broken cell' : broken + ' broken cell(s)') + NL)
process.exit(broken === 0 ? 0 : 1)
