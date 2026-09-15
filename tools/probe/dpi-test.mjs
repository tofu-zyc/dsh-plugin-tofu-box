import koffi from 'koffi'
const user32 = koffi.load('user32.dll')
const GetSystemMetrics = user32.func('int GetSystemMetrics(unsigned short)')
const show = (tag) => console.log(tag, 'SM_CXSCREEN=' + GetSystemMetrics(0), 'SM_CYSCREEN=' + GetSystemMetrics(1), 'virtual=' + GetSystemMetrics(78) + 'x' + GetSystemMetrics(79) + ' @' + GetSystemMetrics(76) + ',' + GetSystemMetrics(77))
show('before:')
const SetCtx = user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')
const PER_MONITOR_AWARE_V2 = -4n & 0xffffffffffffffffn
const ok = SetCtx(Number(-4))
console.log('SetProcessDpiAwarenessContext(PMv2) returned', ok)
show('after-set:')
import('@trycua/cua-driver').then(async (m) => {
  const d = m.CuaDriver.create()
  const r = await d.callTool('get_desktop_state', '{}')
  console.log('driver desktop text:', String(r.text).slice(0, 120))
  console.log('driver structured:', String(r.structuredJson).slice(0, 300))
  const size = await d.callTool('get_screen_size', '{}')
  console.log('get_screen_size text:', String(size.text).slice(0, 160))
  console.log('get_screen_size structured:', String(size.structuredJson).slice(0, 240))
  const img = (r.images ?? [])[0]
  if (img) {
    const buf = Buffer.from(img.dataBase64, 'base64')
    await import('node:fs').then(fs => fs.writeFileSync('tools/probe/out3-desktop.png', buf))
    console.log('png bytes', buf.length)
  }
  await d.shutdown()
  console.log('DONE')
})
