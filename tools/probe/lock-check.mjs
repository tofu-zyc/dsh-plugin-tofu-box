import fs from 'node:fs'
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'
const { CuaDriver } = await import('@trycua/cua-driver')
const d = CuaDriver.create()
const r = await d.callTool('get_desktop_state', '{}')
fs.writeFileSync('tools/probe/lock-check.png', Buffer.from(r.images[0].dataBase64, 'base64'))
await d.shutdown()
console.log('saved', r.text)
