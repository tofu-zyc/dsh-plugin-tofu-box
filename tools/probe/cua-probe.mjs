// One-off probe: dump the real tool surface + a real desktop/window capture
// from the in-process @trycua/cua-driver runtime, so we can compare against
// what dsh-plugin-computer-use assumes.
import fs from 'node:fs'
import path from 'node:path'

process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'
const OUT = process.argv[2] || 'tools/probe/out'
fs.mkdirSync(OUT, { recursive: true })

const { CuaDriver } = await import('@trycua/cua-driver')
const driver = CuaDriver.create()

// 1) tool inventory
let toolsJson = 'ERR'
try { toolsJson = await driver.listToolsJson() } catch (e) { toolsJson = 'listToolsJson threw: ' + (e && e.message) }
fs.writeFileSync(path.join(OUT, 'tools.json'), String(toolsJson))
try {
  const list = JSON.parse(toolsJson)
  const arr = Array.isArray(list) ? list : (list.tools ?? [])
  console.log('TOOL COUNT:', arr.length)
  for (const t of arr) console.log('-', t.name)
} catch { console.log('tools.json not JSON:', String(toolsJson).slice(0, 300)) }

const brief = (r) => ({
  isError: r.isError, errorCode: r.errorCode ?? null, degraded: r.degraded,
  text: String(r.text ?? '').slice(0, 500),
  images: (r.images ?? []).map(i => ({ mime: i.mimeType, bytes: Math.round((i.dataBase64 ?? '').length * 3 / 4) })),
  structuredJson: String(r.structuredJson ?? '').slice(0, 900),
  rawJsonTopKeys: (() => { try { return Object.keys(JSON.parse(r.rawJson ?? '{}')) } catch { return 'unparseable' } })(),
})

const saveImg = (r, name) => {
  const img = (r.images ?? [])[0]
  if (!img) return null
  const p = path.join(OUT, name)
  fs.writeFileSync(p, Buffer.from(img.dataBase64, 'base64'))
  return p
}

// 2) desktop state
const desk = await driver.callTool('get_desktop_state', '{}')
console.log('\n=== get_desktop_state ===')
console.log(JSON.stringify(brief(desk), null, 1))
const dp = saveImg(desk, 'desktop.png')
console.log('saved:', dp)

// 3) windows
const wins = await driver.callTool('list_windows', '{}')
console.log('\n=== list_windows ===')
console.log('text:', String(wins.text ?? '').slice(0, 400))
let winList = []
try {
  const sj = JSON.parse(wins.structuredJson ?? '{}')
  winList = sj.windows ?? []
  console.log('structuredJson keys:', Object.keys(sj))
} catch (e) { console.log('structuredJson parse fail:', e.message) }
fs.writeFileSync(path.join(OUT, 'windows.json'), wins.structuredJson ?? wins.rawJson ?? '')
console.log('sample windows:', JSON.stringify(winList.slice(0, 8), null, 1).slice(0, 1500))

// 4) window state of a visible window with a title
const pick = winList.find(w => w.is_on_screen !== false && String(w.title ?? '').trim() !== '' && !String(w.title).includes('probe'))
if (pick) {
  console.log('\n=== get_window_state for pid=' + pick.pid + ' win=' + (pick.window_id ?? pick.windowId) + ' "' + String(pick.title).slice(0, 50) + '" ===')
  const ws = await driver.callTool('get_window_state', JSON.stringify({ pid: pick.pid, window_id: pick.window_id ?? pick.windowId, include_accessibility_tree: true }))
  console.log(JSON.stringify(brief(ws), null, 1))
  const wp = saveImg(ws, 'window.png')
  console.log('saved:', wp)
  try {
    const sj = JSON.parse(ws.structuredJson ?? '{}')
    fs.writeFileSync(path.join(OUT, 'window-structured.json'), ws.structuredJson ?? '')
    console.log('window structured keys:', Object.keys(sj))
    const els = sj.elements ?? []
    console.log('elements:', els.length, 'total:', sj.total_element_count)
    console.log('first els:', JSON.stringify(els.slice(0, 4), null, 1).slice(0, 1200))
  } catch (e) { console.log('window structuredJson parse fail:', e.message) }
} else {
  console.log('\n(no suitable visible window to probe)')
}

await driver.shutdown()
if ('uniffiDestroy' in driver) driver.uniffiDestroy?.()
console.log('\ndone')
