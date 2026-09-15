// Session lifecycle semantics probe (no input injection, capture-only).
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'
const { CuaDriver } = await import('@trycua/cua-driver')
const d = CuaDriver.create()
const call = async (n, a) => {
  const r = await d.callTool(n, JSON.stringify(a))
  return { err: r.isError, code: r.errorCode ?? null, text: String(r.text).slice(0, 160) }
}
console.log('1 implicit desktop   :', JSON.stringify(await call('get_desktop_state', {})))
console.log('2 start_session p1   :', JSON.stringify(await call('start_session', { session: 'p1' })))
console.log('3 start again (idemp):', JSON.stringify(await call('start_session', { session: 'p1' })))
console.log('4 get_session p1     :', JSON.stringify(await call('get_session', { session: 'p1' })))
console.log('5 end_session p1     :', JSON.stringify(await call('end_session', { session: 'p1' })))
console.log('6 desktop w/ p1      :', JSON.stringify(await call('get_desktop_state', { session: 'p1' })))
console.log('7 desktop implicit   :', JSON.stringify(await call('get_desktop_state', {})))
console.log('8 revive p1          :', JSON.stringify(await call('start_session', { session: 'p1' })))
console.log('9 desktop w/ p1 after:', JSON.stringify(await call('get_desktop_state', { session: 'p1' })))
console.log('10 list_sessions     :', JSON.stringify(await call('list_sessions', {})))
await d.shutdown()
console.log('done')
