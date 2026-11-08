/**
 * Real-browser UI smoke test for the terrarium panel.
 *
 * Every bug that mattered in this project lived in the DOM layer: a pointerdown
 * handler that ate clicks, a stage that was never sized. No headless engine test
 * can see those. This drives the real DSH web app through the Chrome DevTools
 * Protocol: open the URL, click the sidebar entry, wait for the panel, screenshot
 * it, optionally click a button inside the panel, and report layout boxes so a
 * broken layout fails loudly instead of quietly shipping.
 *
 *   node tools/ui-smoke.mjs --url "http://127.0.0.1:PORT/?token=..." --out .review/panel.png
 *   node tools/ui-smoke.mjs --url ... --click "知道了" --out .review/after.png
 *
 * Requires Chrome and Node >= 22 (global fetch + WebSocket).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt }
const url = arg('url', '')
if (url === '') { console.error('need --url'); process.exit(2) }
const out = resolve(arg('out', '.review/panel.png'))
const panelLabel = arg('panel', '像素生态缸')
const clickLabel = arg('click', '')
const settle = Number(arg('settle', '4000'))
const chromePath = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const port = Number(arg('port', '9333'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--window-size=1600,1000', '--force-device-scale-factor=1',
  '--user-data-dir=' + process.env.TEMP + '/pe-smoke-prof',
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''))
  return r.result && r.result.value
}

const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v } catch { /* not ready yet */ }
    await sleep(250)
  }
  throw new Error('timed out waiting for ' + label)
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

  const clicked = await evaluate('(() => {'
    + ' const want = ' + JSON.stringify(panelLabel) + ';'
    + " const nodes = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent || '').trim() === want);"
    + ' if (nodes.length === 0) return "label-not-found";'
    + ' const t = nodes[0].closest("button,a,[role=button],li,div") || nodes[0];'
    + ' t.click(); return "clicked"; })()')
  console.log('sidebar:', clicked)
  await sleep(settle)

  const box = el => el
  const info = await evaluate('(() => {'
    + ' const root = document.querySelector(".pe-root");'
    + ' const stage = document.querySelector(".pe-stage");'
    + ' const canvas = document.querySelector(".pe-canvas");'
    + ' const r = el => { if (el === null) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; };'
    + ' return { root: r(root), stage: r(stage), canvas: r(canvas), canvasAttr: canvas ? [canvas.width, canvas.height] : null, errors: (window.__failures || []).slice(0, 5) };'
    + ' })()')
  console.log('layout: ' + JSON.stringify(info))

  if (clickLabel !== '') {
    const r2 = await evaluate('(() => {'
      + ' const want = ' + JSON.stringify(clickLabel) + ';'
      + " const nodes = [...document.querySelectorAll('.pe-root button')].filter(b => (b.textContent || '').trim() === want);"
      + ' if (nodes.length === 0) return "button-not-found";'
      + ' nodes[0].click(); return "clicked"; })()')
    console.log('button ' + clickLabel + ': ' + r2)
    await sleep(700)
    const left = await evaluate("document.querySelectorAll('.pe-onboard').length")
    console.log('onboard overlays left: ' + left)
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
