// 三种启动方式对质：name（插件现在用的）/ launch_path（快捷方式里存的完整命令行）/ aumid。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:\\program\\dsh-plugins\\node_modules\\@trycua\\cua-driver\\dist\\index.js').href)
const d = mod.CuaDriver.create()
const S = 'diag-launchraw'
const j = (r) => { try { return JSON.parse(r.structuredJson ?? '{}') } catch { return {} } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  const t = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8' })
  return /^\s*\S/.test(String(t.stdout ?? '')) && !/No tasks|没有运行|无运行/i.test(String(t.stdout ?? ''))
}

await d.callTool('start_session', JSON.stringify({ session: S }))
const attempts = [
  ['按 name（插件当前做法）', { name: 'Notepad' }],
  ['按 launch_path（快捷方式里存的）', { launch_path: 'shell:appsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }],
  ['按 aumid', { aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }],
]
try {
  for (const [label, args] of attempts) {
    spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
    await sleep(800)
    const t0 = Date.now()
    let r
    try { r = await d.callTool('launch_app', JSON.stringify(args)) } catch (e) { console.log(label + ' -> THREW ' + (e?.message ?? e)); continue }
    const sc = j(r)
    await sleep(2500)
    const wins = j(await d.callTool('list_windows', JSON.stringify({ on_screen_only: false }))).windows ?? []
    const nw = wins.filter((x) => /notepad/i.test(String(x.app_name ?? '')))
    console.log(label.padEnd(34)
      + ' | ' + String(Date.now() - t0).padStart(5) + 'ms'
      + ' | isError=' + r.isError
      + ' | pid=' + sc.pid
      + ' | 返回windows=' + (sc.windows ?? []).length
      + ' | 2.5s后进程存活=' + (sc.pid ? alive(sc.pid) : 'n/a')
      + ' | 窗口=' + (nw.length === 0 ? '无' : nw.map((x) => x.pid).join(','))
      + ' | text=' + JSON.stringify(String(r.text ?? '').slice(0, 90)))
  }
} finally {
  spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
  await Promise.resolve(d.callTool('end_session', JSON.stringify({ session: S }))).catch(() => {})
  await Promise.resolve(d.shutdown()).catch(() => {})
}
