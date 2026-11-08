/**
 * Real-browser UI smoke test: drives actual input events, not synthetic clicks.
 *
 * A synthetic element.click() never fires pointerdown/pointerup, so it cannot
 * catch the class of bug that actually shipped: handlers on the stage calling
 * preventDefault() and eating the click before a nested button sees it. This
 * tool dispatches real Input.dispatchMouseEvent traffic and reads the panel back.
 *
 *   node tools/ui-smoke.mjs --url URL --real-click "知道了" --out a.png
 *   node tools/ui-smoke.mjs --url URL --wheel -120 --out b.png
 *
 * Requires Chrome and Node >= 22.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt }
const url = arg('url', '')
if (url === '') { console.error('need --url'); process.exit(2) }
const out = resolve(arg('out', '.review/panel.png'))
const panelLabel = arg('panel', '像素生态缸')
const realClick = arg('real-click', '')
const wheel = arg('wheel', '')
const settle = Number(arg('settle', '4000'))
/** Reuse a profile across runs, so the second run finds a save and takes the
 *  asynchronous load path (that is where the canvas sizing diverged). */
const profileDir = arg('profile', '')
/** Comma-separated milliseconds at which to sample the layout after opening. */
const sampleTimes = arg('samples', '0,100,500,2000').split(',').map(v => Number(v)).filter(v => Number.isFinite(v))
/** Click this speed label before waiting for a save (e.g. "8×"). */
const speedLabel = arg('speed', '')
/** TEMP-DIAGNOSTIC (render-hunt): delay gzip decompression by this many ms. */
const slowLoad = Number(arg('slow-load', '0'))
/** Poll for the sidebar entry for this long and click it the instant it exists. */
const clickEarly = Number(arg('click-early', '0'))
/** Click the four canvas corners and check the HUD cell each lands on. */
const corners = arg('corners', '') !== ''
/** Palette card to exercise: click it, then click the grass, then read the count. */
const placeLabel = arg('place', '')
/** Species-table row to exercise the same way (arms the brush from that tab). */
const placeRowLabel = arg('place-row', '')
/** Label of the species tab inside the side panel. */
const speciesTab = arg('species-tab', '物种')

/** Poll this long for an autosave to appear, so a second run can resume it. */
const waitSave = Number(arg('wait-save', '0'))
/** Reload once before probing (a restored open panel is the real-world case). */
const reload = arg('reload', '') !== ''
/** Write this packed payload into localStorage before the reload. */
const seedSave = arg('seed-save', '')
const chromePath = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const port = Number(arg('port', String(9333 + Math.floor(Math.random() * 400))))
const win = arg('win', '1600,1000')
const profile = arg('profile', '')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--window-size=' + win, '--force-device-scale-factor=1',
  '--user-data-dir=' + (profileDir !== '' ? profileDir : process.env.TEMP + '/pe-smoke-' + port),
  url,
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
const mouse = async (type, x, y, extra) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra || {}))

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
  if (slowLoad > 0) {
    // Only the decompression is slowed: everything else behaves normally, so the
    // panel mounts inside the load window exactly as it does on a slow machine.
    await send('Page.addScriptToEvaluateOnNewDocument', { source:
      '(() => {'
      + ' const Real = globalThis.DecompressionStream;'
      + ' if (typeof Real !== "function") return;'
      + ' globalThis.DecompressionStream = function (fmt) {'
      + '   const inner = new Real(fmt);'
      + '   const reader = inner.readable.getReader();'
      + '   const delayed = new ReadableStream({'
      + '     async start(controller) {'
      + '       await new Promise(r => setTimeout(r, ' + slowLoad + '));'
      + '       for (;;) { const n = await reader.read(); if (n.done) { controller.close(); return } controller.enqueue(n.value) }'
      + '     }'
      + '   });'
      + '   return { readable: delayed, writable: inner.writable };'
      + ' };'
      + ' })()' })
    console.log('slow-load: decompression delayed by ' + slowLoad + 'ms')
  }
  if (seedSave !== '') {
    const text = readFileSync(seedSave, 'utf8')
    const seed = '(() => { localStorage.setItem("dsh-pixel-ecosystem:v2", '
      + JSON.stringify(text) + '); return (localStorage.getItem("dsh-pixel-ecosystem:v2") || "").length; })()'
    // The document has no origin until the URL is committed, so retry: seeding
    // must happen before the reload that boots the app.
    let written = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        written = await evaluate(seed)
        if (written !== null) break
      } catch { /* about:blank has no localStorage yet */ }
      await sleep(250)
    }
    console.log('seeded save: ' + (written === null ? 'FAILED' : written + ' chars'))
  }
  if (reload) {
    await send('Page.reload', {})
    console.log('reloaded')
    await sleep(1200)
  }

  await sleep(settle)

  const clickPanel = '(() => {'
    + ' const want = ' + JSON.stringify(panelLabel) + ';'
    + " const nodes = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent || '').trim() === want);"
    + ' if (nodes.length === 0) return false;'
    + ' (nodes[0].closest("button,a,[role=button],li,div") || nodes[0]).click(); return true; })()'
  let opened = false
  if (clickEarly > 0) {
    // Poll fast: the whole point is to mount the panel inside a load window that
    // lasts a couple of hundred milliseconds.
    const deadline = Date.now() + clickEarly
    while (Date.now() < deadline) {
      opened = await evaluate(clickPanel)
      if (opened) break
      await sleep(30)
    }
    console.log('panel clicked early: ' + opened)
  } else {
    opened = await evaluate(clickPanel)
  }
  if (!opened) console.log('WARN: sidebar entry not found')
  await sleep(settle)

  if (speedLabel !== '' || waitSave > 0) {
    if (speedLabel !== '') {
      const picked = await evaluate('(() => {'
        + ' const want = ' + JSON.stringify(speedLabel) + ';'
        + " const b = [...document.querySelectorAll('.pe-root button')].find(x => (x.textContent || '').trim() === want);"
        + ' if (!b) return false; b.click(); return true; })()')
      console.log('speed ' + speedLabel + ': ' + picked)
    }
    if (waitSave > 0) {
      const deadline = Date.now() + waitSave
      let saved = null
      while (Date.now() < deadline) {
        saved = await evaluate("(() => { const v = localStorage.getItem('dsh-pixel-ecosystem:v2'); return v === null ? null : v.length; })()")
        if (saved !== null) break
        await sleep(500)
      }
      console.log('autosave in storage: ' + (saved === null ? 'no' : saved + ' chars'))
    }
  }

  const probe = '(() => {'
    + ' const r = el => { if (el === null) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };'
    + ' const canvas = document.querySelector(".pe-canvas");'
    + ' const hud = document.querySelector(".pe-hud-bl");'
    + ' const dbg = typeof window.__peDebug === "function" ? window.__peDebug() : null;'
    + ' const stage = r(document.querySelector(".pe-stage"));'
    + ' const rect = canvas === null ? null : r(canvas);'
    // Paint share: the reported fault is "one small block drawn, rest black",
    // which a size assertion cannot see. Sample a grid of the backing store.
    + ' let paint = null;'
    + ' if (canvas !== null && typeof canvas.getContext === "function") {'
    + '   try { const ctx = canvas.getContext("2d"); const w = canvas.width, h = canvas.height;'
    + '     const stepY = Math.max(1, Math.floor(h / 24)), stepX = Math.max(1, Math.floor(w / 24));'
    + '     let painted = 0, sampled = 0;'
    + '     for (let y = 0; y < h; y += stepY) for (let x = 0; x < w; x += stepX) {'
    + '       sampled += 1; const d = ctx.getImageData(x, y, 1, 1).data; if (d[0] + d[1] + d[2] > 24) painted += 1 }'
    + '     paint = sampled === 0 ? null : Math.round((painted / sampled) * 100) / 100'
    + '   } catch (e) { paint = "unreadable" }'
    + ' }'
    + ' return {'
    + '   paint,'
    + '   stage, wrap: r(document.querySelector(".pe-stagewrap")), bar: r(document.querySelector(".pe-eventbar")),'
    + '   body: r(document.querySelector(".pe-body")), root: r(document.querySelector(".pe-root")),'
    + '   canvas: rect,'
    + '   attr: canvas === null ? null : [canvas.width, canvas.height],'
    + '   style: canvas === null ? null : [canvas.style.width, canvas.style.height],'
    + '   dx: stage !== null && rect !== null ? rect.w - stage.w : null,'
    + '   dy: stage !== null && rect !== null ? rect.h - stage.h : null,'
    + '   hud: hud ? hud.textContent : null, onboard: document.querySelectorAll(".pe-onboard").length,'
    + '   errors: (window.__failures || []).slice(0,3), dbg };'
    + ' })()'
  const layout = await evaluate(probe)
  console.log('layout: ' + JSON.stringify(layout))
  if (layout && layout.dbg && layout.dbg.trace) {
    console.log('trace:')
    for (const entry of layout.dbg.trace) console.log('  ' + JSON.stringify(entry))
  }
  // The fault is a timing race, so it has to be sampled over time, not once.
  for (const ms of sampleTimes) {
    if (ms > 0) await sleep(ms)
    const sample = await evaluate('(() => {'
      + ' const r = el => { if (el === null) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };'
      + ' const canvas = document.querySelector(".pe-canvas");'
      + ' const stage = r(document.querySelector(".pe-stage"));'
      + ' const rect = canvas === null ? null : r(canvas);'
      + ' const dbg = typeof window.__peDebug === "function" ? window.__peDebug() : null;'
      + ' return { t: ' + ms + ', stage, canvas: rect, dx: stage && rect ? rect.w - stage.w : null, ddx: stage && rect ? Math.abs(rect.w - stage.w) : null, ddy: stage && rect ? Math.abs(rect.h - stage.h) : null, attr: canvas === null ? null : [canvas.width, canvas.height], style: canvas === null ? null : [canvas.style.width, canvas.style.height], view: dbg && dbg.view, hasOffscreen: dbg && dbg.hasOffscreen, imageData: dbg && dbg.imageData, hud: (document.querySelector(".pe-hud-bl") || {}).textContent };'
      + ' })()')
    console.log('sample +' + ms + 'ms: ' + JSON.stringify(sample))
  }

  if (realClick !== '') {
    const box = await evaluate('(() => {'
      + ' const want = ' + JSON.stringify(realClick) + ';'
      + " const b = [...document.querySelectorAll('.pe-root button')].find(x => (x.textContent || '').trim() === want);"
      + ' if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()')
    if (box === null) console.log('real-click: button not found')
    else {
      console.log('real-click at ' + JSON.stringify(box))
      await mouse('mouseMoved', box.x, box.y, { button: 'none' })
      await mouse('mousePressed', box.x, box.y, { button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await mouse('mouseReleased', box.x, box.y, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(500)
      const left = await evaluate("document.querySelectorAll('.pe-onboard').length")
      console.log('REAL CLICK RESULT -> onboard overlays left: ' + left)
    }
  }

  if (wheel !== '') {
    const deltaY = Number(wheel)
    const center = await evaluate('(() => { const r = document.querySelector(".pe-stage").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()')
    const before = await evaluate("document.querySelector('.pe-hud-bl').textContent")
    await mouse('mouseWheel', center.x, center.y, { deltaX: 0, deltaY, buttons: 0 })
    await sleep(400)
    const after = await evaluate("document.querySelector('.pe-hud-bl').textContent")
    console.log('WHEEL deltaY=' + deltaY + ' | hud before: ' + before + ' | after: ' + after)
  }

  if (corners) {
    // Hit test: the canvas stretches a floored cell count over the stage, so the
    // HUD cell under the cursor must still be the cell the player sees.
    const geom = await evaluate('(() => {'
      + ' const c = document.querySelector(".pe-canvas"); if (c === null) return null;'
      + ' const b = c.getBoundingClientRect(); const d = typeof window.__peDebug === "function" ? window.__peDebug() : null;'
      + ' return d === null ? null : { x: b.x, y: b.y, w: b.width, h: b.height, view: d.view }; })()')
    if (geom === null) console.log('corners: no canvas/state')
    else {
      const ppcX = geom.w / geom.view.width
      const ppcY = geom.h / geom.view.height
      // The bottom-right corner of the stage is covered by the minimap, which
      // swallows the hover; probe just outside it so the mapping itself is what
      // gets measured.
      const spots = [
        ['top-left', 0.02, 0.02], ['top-70%', 0.7, 0.02],
        ['bottom-left', 0.02, 0.98], ['bottom-45%', 0.45, 0.98],
      ]
      for (const spot of spots) {
        const px = geom.x + geom.w * spot[1]
        const py = geom.y + geom.h * spot[2]
        await mouse('mouseMoved', px, py, { button: 'none' })
        await sleep(160)
        const hud = await evaluate("(document.querySelector('.pe-hud-bl') || {}).textContent")
        const wantX = Math.round(geom.view.x + (geom.w * spot[1]) / ppcX)
        const wantY = Math.round(geom.view.y + (geom.h * spot[2]) / ppcY)
        console.log('corner ' + spot[0] + ' px ' + Math.round(px) + ',' + Math.round(py) + ' -> hud "' + hud + '" | expected cell ' + wantX + ',' + wantY)
      }
    }
  }

  if (placeLabel !== '') {
    // "The species card does nothing": click the palette card, then the meadow,
    // and check that the species count actually moved.
    const chipCount = await evaluate('(() => {'
      + ' const chip = [...document.querySelectorAll(".pe-chip")].find(c => (c.getAttribute("title") || "") === ' + JSON.stringify(placeLabel) + ');'
      + ' if (!chip) return null; const n = chip.querySelector(".pe-chip-count"); return n ? Number(n.textContent) : null; })()')
    const card = await evaluate('(() => {'
      + ' const want = ' + JSON.stringify(placeLabel) + ';'
      + ' const all = [...document.querySelectorAll(".pe-tool")];'
      + ' const b = all.find(x => (x.getAttribute("aria-label") || "") === want || (x.textContent || "").trim() === want);'
      + ' if (!b) return null; const r = b.getBoundingClientRect();'
      + ' return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),'
      + '   cards: all.length, pressed: b.getAttribute("aria-pressed"), cls: b.className }; })()')
    console.log('place-test: chip before=' + chipCount + ' card=' + JSON.stringify(card))
    if (card !== null && card.w > 0) {
      await mouse('mouseMoved', card.x, card.y, { button: 'none' })
      await mouse('mousePressed', card.x, card.y, { button: 'left', buttons: 1, clickCount: 1 })
      await sleep(50)
      await mouse('mouseReleased', card.x, card.y, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(250)
      const selected = await evaluate('(() => {'
        + ' const want = ' + JSON.stringify(placeLabel) + ';'
        + ' const b = [...document.querySelectorAll(".pe-tool")].find(x => (x.getAttribute("aria-label") || "") === want);'
        + ' return b === undefined ? null : { pressed: b.getAttribute("aria-pressed"), cls: b.className }; })()')
      console.log('place-test: card after click = ' + JSON.stringify(selected))
      // Somewhere near the middle of the view, then a few offsets in case the
      // middle is water or stone.
      const spots = await evaluate('(() => {'
        + ' const r = document.querySelector(".pe-stage").getBoundingClientRect();'
        + ' const cx = r.x + r.width / 2, cy = r.y + r.height / 2;'
        + ' return [[cx, cy], [cx - 120, cy - 60], [cx + 140, cy + 40], [cx - 60, cy + 120], [cx + 90, cy - 130]]'
        + '   .map(p => [Math.round(p[0]), Math.round(p[1])]); })()')
      let placed = null
      for (const spot of spots) {
        await mouse('mouseMoved', spot[0], spot[1], { button: 'none' })
        await mouse('mousePressed', spot[0], spot[1], { button: 'left', buttons: 1, clickCount: 1 })
        await sleep(60)
        await mouse('mouseReleased', spot[0], spot[1], { button: 'left', buttons: 0, clickCount: 1 })
        await sleep(350)
        const now = await evaluate('(() => {'
          + ' const chip = [...document.querySelectorAll(".pe-chip")].find(c => (c.getAttribute("title") || "") === ' + JSON.stringify(placeLabel) + ');'
          + ' if (!chip) return null; const n = chip.querySelector(".pe-chip-count"); return n ? Number(n.textContent) : null; })()')
        const toast = await evaluate("(document.querySelector('.pe-toast') || {}).textContent")
        console.log('place-test: click ' + spot.join(',') + ' -> count ' + now + ' toast "' + toast + '"')
        if (now !== null && chipCount !== null && now > chipCount) { placed = now; break }
      }
      console.log('place-test RESULT: ' + (placed === null ? 'NO CHANGE (card click did not place)' : 'count ' + chipCount + ' -> ' + placed))
    } else {
      console.log('place-test RESULT: no visible palette card labelled ' + placeLabel)
    }
  }

  if (placeRowLabel !== '') {
    // "Clicking the species card does nothing": the row in the species tab must
    // arm the same brush the palette card arms, then place on the next map click.
    const label = JSON.stringify(placeRowLabel)
    const readCount = '(() => {'
      + ' const chip = [...document.querySelectorAll(".pe-chip")].find(c => (c.getAttribute("title") || "") === ' + label + ');'
      + ' if (!chip) return null; const n = chip.querySelector(".pe-chip-count"); return n ? Number(n.textContent) : null; })()'
    const before = await evaluate(readCount)
    const tab = await evaluate('(() => {'
      + ' const want = ' + JSON.stringify(speciesTab) + ';'
      + ' const b = [...document.querySelectorAll(".pe-tab")].find(x => (x.textContent || "").trim() === want);'
      + ' if (!b) return null; const r = b.getBoundingClientRect();'
      + ' return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()')
    if (tab !== null) {
      await mouse('mouseMoved', tab.x, tab.y, { button: 'none' })
      await mouse('mousePressed', tab.x, tab.y, { button: 'left', buttons: 1, clickCount: 1 })
      await sleep(50)
      await mouse('mouseReleased', tab.x, tab.y, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(350)
    }
    const row = await evaluate('(() => {'
      + ' const rows = [...document.querySelectorAll(".pe-srow")];'
      + ' const row = rows.find(r => (r.textContent || "").includes(' + label + '));'
      + ' if (!row) return null; const b = row.getBoundingClientRect();'
      + ' return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), text: (row.textContent || "").slice(0, 40),'
      + '   locate: row.querySelectorAll(".pe-locate").length, rows: rows.length }; })()')
    console.log('place-row: chip before=' + before + ' | species tab found=' + (tab !== null) + ' | row=' + JSON.stringify(row))
    if (row !== null) {
      await mouse('mouseMoved', row.x, row.y, { button: 'none' })
      await mouse('mousePressed', row.x, row.y, { button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await mouse('mouseReleased', row.x, row.y, { button: 'left', buttons: 0, clickCount: 1 })
      await sleep(350)
      const toast = await evaluate("(document.querySelector('.pe-toast') || {}).textContent")
      const armed = await evaluate('(() => {'
        + ' const b = [...document.querySelectorAll(".pe-tool")].find(x => (x.getAttribute("aria-label") || "") === ' + label + ');'
        + ' return b === undefined ? null : b.getAttribute("aria-pressed"); })()')
      const hud = await evaluate("(document.querySelector('.pe-hud-bl') || {}).textContent")
      console.log('place-row: after click toast "' + toast + '" | palette card armed=' + armed + ' | hud "' + hud + '"')
      const spots = await evaluate('(() => {'
        + ' const r = document.querySelector(".pe-stage").getBoundingClientRect();'
        + ' const cx = r.x + r.width / 2, cy = r.y + r.height / 2;'
        + ' return [[cx, cy], [cx - 120, cy - 60], [cx + 140, cy + 40], [cx - 60, cy + 120], [cx + 90, cy - 130]]'
        + '   .map(p => [Math.round(p[0]), Math.round(p[1])]); })()')
      let after = null
      for (const spot of spots) {
        await mouse('mouseMoved', spot[0], spot[1], { button: 'none' })
        await mouse('mousePressed', spot[0], spot[1], { button: 'left', buttons: 1, clickCount: 1 })
        await sleep(60)
        await mouse('mouseReleased', spot[0], spot[1], { button: 'left', buttons: 0, clickCount: 1 })
        await sleep(350)
        after = await evaluate(readCount)
        const message = await evaluate("(document.querySelector('.pe-toast') || {}).textContent")
        console.log('place-row: click ' + spot.join(',') + ' -> count ' + after + ' toast "' + message + '"')
        if (after !== null && before !== null && after > before) break
      }
      console.log('place-row RESULT: ' + (after === null || before === null || after <= before
        ? 'NO CHANGE'
        : 'count ' + before + ' -> ' + after))
      // Requirement: picking must not cost the player plain "go and watch".
      const locateBox = await evaluate('(() => {'
        + ' const row = [...document.querySelectorAll(".pe-srow")].find(r => (r.textContent || "").includes(' + label + '));'
        + ' if (!row) return null; const b = row.querySelector(".pe-locate"); if (!b) return null;'
        + ' const q = b.getBoundingClientRect(); return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) }; })()')
      const viewBefore = await evaluate('(() => { const d = window.__peDebug ? window.__peDebug() : null; return d === null ? null : [d.view.x, d.view.y]; })()')
      await evaluate("(() => { const t = document.querySelector('.pe-toast'); if (t) t.textContent = ''; return true })()")
      if (locateBox !== null) {
        await mouse('mouseMoved', locateBox.x, locateBox.y, { button: 'none' })
        await mouse('mousePressed', locateBox.x, locateBox.y, { button: 'left', buttons: 1, clickCount: 1 })
        await sleep(60)
        await mouse('mouseReleased', locateBox.x, locateBox.y, { button: 'left', buttons: 0, clickCount: 1 })
        await sleep(400)
      }
      const viewAfter = await evaluate('(() => { const d = window.__peDebug ? window.__peDebug() : null; return d === null ? null : [d.view.x, d.view.y]; })()')
      const toastAfter = await evaluate("(document.querySelector('.pe-toast') || {}).textContent")
      console.log('place-row: locate button=' + JSON.stringify(locateBox) + ' view ' + JSON.stringify(viewBefore) + ' -> ' + JSON.stringify(viewAfter) + ' toast "' + toastAfter + '"')
    }
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot -> ' + out)
} catch (error) {
  console.error('SMOKE FAILED: ' + String(error).slice(0, 300))
} finally {
  try { if (ws) ws.close() } catch { /* ignore */ }
  chrome.kill()
}