// 实验：同一个 app 调两次 launch_app，是"复用/激活已有实例"还是"再起一个进程"？
// 用立即退出的应用当照妖镜：能返回 pid 说明确实创建过进程；再看创建出的进程还剩几个。
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('D:\\program\\dsh-plugins\\dsh-plugin-computer-use\\index.js')
const DRIVER = 'D:\\program\\dsh-plugins\\node_modules\\@trycua\\cua-driver\\dist\\index.js'
const mod = await import(pathToFileURL(DRIVER).href)
const d = mod.CuaDriver.create()
const S = 'diag-relaunch'
const OUT = 'D:\\program\\dsh-plugins\\probe-out.txt'
const EXE = 'C:\\Windows\\System32\\cmd.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (r) => { try { return JSON.parse(r.structuredJson ?? '{}') } catch { return {} } }
const ps = (cmd) => new Promise((res) => { const p = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }); p.on('exit', res); p.on('error', res) })

// 常驻靶子：cmd.exe /k 会开个窗口一直待着，正好当"已经在运行的应用"
const launch = (args) => d.callTool('launch_app', JSON.stringify(args))
const countCmd = async (label) => {
  if (existsSync(OUT)) rmSync(OUT)
  await ps(`@(Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count | Set-Content '${OUT}' -Encoding UTF8`)
  await sleep(400)
  const n = existsSync(OUT) ? readFileSync(OUT, 'utf8').trim() : '?'
  const all = j(await d.callTool('list_windows', '{}')).windows ?? []
  const seen = all.filter((w) => /cmd\.exe/i.test(w.app_name))
  console.log(label.padEnd(30), '| cmd 有窗口进程数=' + n, '| 驱动枚举到的 cmd 窗口:', seen.map((w) => `win=${w.window_id} pid=${w.pid}`).join(',') || '(无)')
  return { n, seen }
}

await d.callTool('start_session', JSON.stringify({ session: S }))
try {
  const rawA = await launch({ path: EXE })
  const a = j(rawA)
  console.log('launch #1 -> pid=' + a.pid + ' windows=' + (a.windows ?? []).length + ' isError=' + rawA.isError + ' text=' + JSON.stringify(String(rawA.text ?? '').slice(0, 120)))
  await sleep(2000)
  const s1 = await countCmd('launch #1 之后')

  const b = j(await launch({ path: EXE }))
  await sleep(2000)
  console.log('launch #2 -> pid=' + b.pid + ' windows=' + (b.windows ?? []).length + '（#1 是 ' + a.pid + '）')
  const s2 = await countCmd('launch #2 之后')

  const resumed = s2.seen.some((w) => w.pid === (s1.seen[0]?.pid))
  console.log('\n结论：第二次 launch_app 是否复用了第一个实例 =', resumed ? '是（激活已有）' : '否（又创建了新的）')
  console.log('   #1 后 cmd 进程 pid =', s1.seen.map((w) => w.pid).join(','), ' #2 后 =', s2.seen.map((w) => w.pid).join(','))
} finally {
  await ps('Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq \'\' } | Stop-Process -Force')
  await ps('Get-Process cmd -ErrorAction SilentlyContinue | Stop-Process -Force')
  await Promise.resolve(d.callTool('end_session', JSON.stringify({ session: S }))).catch(() => {})
  await Promise.resolve(d.shutdown()).catch(() => {})
}
