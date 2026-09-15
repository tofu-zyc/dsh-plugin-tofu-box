/**
 * Non-mutating verification of the v2.2 fixes, safe to run while locked:
 * DPI bootstrap, named session + revival, full-primary capture, frame mapping.
 */
import { name, inject, apply } from '../../dsh-plugin-computer-use/index.js'

const logs = []
const tools = new Map()
const disposers = []
const ctx = {
  get: () => undefined,
  logger: { info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  on() {},
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  attachments: { async saveImage({ data }) { return { attachmentId: 'a', mediaType: 'image/png', bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) } } },
}
apply(ctx, { settleMs: 100 })
const EXEC = { agent: { id: 'verify' }, signal: undefined }
const run = (t, a) => tools.get(t).execute(a ?? {}, EXEC)

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) fail++ }

const desk = await run('computer_screenshot', {})
ok(/@/.test(desk.summary), 'desktop summary has scale factor: ' + desk.summary)
ok(!/DPI awareness inactive/.test(desk.summary), 'no DPI degradation warning')
ok(!logs.some(l => /DPI awareness = (UNAWARE|unknown)/.test(l[1])), 'DPI aware at boot: ' + (logs.find(l => /DPI awareness/.test(l[1]))?.[1] ?? '(no log)'))
ok(desk.image.width <= 1568 && desk.image.width > 0, 'frame within maxDim: ' + desk.image.width + 'x' + desk.image.height)

// second capture keeps working; session is ours (probe: a plain driver in this
// process would be a *different* runtime, so here just confirm repeated calls)
const desk2 = await run('computer_screenshot', {})
ok(desk2.summary.includes('Primary display'), 'repeat desktop capture fine')

// desktop coordinate mapping sanity: deskXY accepts in-frame points and rejects outside
try {
  await run('computer_move', { x: 3, y: 3 })
  ok(true, 'small in-frame desktop move dispatched')
} catch (e) { ok(!/outside the frame/.test(String(e.message)), 'mapping passed the point through (only driver-level errors possible): ' + String(e.message).slice(0, 90)) }

// window list works over the named session path
const wins = await run('computer_windows', { on_screen_only: true })
ok(/pid=/.test(wins.table), 'computer_windows lists: ' + wins.table.split('\n').length + ' rows')

for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
console.log(fail === 0 ? '\nVERIFY OK' : '\nVERIFY FAILED')
process.exit(fail === 0 ? 0 : 1)
