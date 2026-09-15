// 用 koffi 直接问 user32：本进程能不能枚举窗口、在哪个 window station / desktop 上。
// 用来判断"某个进程里 EnumWindows 恒为空"是环境问题还是驱动问题。
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const EnumWindows = user32.func('bool EnumWindows(void* lpEnumFunc, intptr_t lParam)')
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
const GetProcessWindowStation = user32.func('intptr_t GetProcessWindowStation()')
const GetThreadDesktop = user32.func('intptr_t GetThreadDesktop(uint32 dwThreadId)')
const GetUserObjectInformationW = user32.func('bool GetUserObjectInformationW(intptr_t hObj, int nIndex, void* pvInfo, uint32 nLength, uint32* lpnLengthNeeded)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(intptr_t hWnd, uint32* lpdwProcessId)')
const kernel32 = koffi.load('kernel32.dll')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')

// 用回调枚举
const pids = []
const WNDENUMPROC = koffi.proto('bool WNDENUMPROC(intptr_t hwnd, intptr_t lParam)')
const cb = koffi.register((hwnd) => {
  const buf = Buffer.alloc(4)
  GetWindowThreadProcessId(hwnd, buf)
  pids.push(buf.readUInt32LE(0))
  return true
}, koffi.pointer(WNDENUMPROC))

const total = EnumWindows(cb, 0)
const nameOf = (h) => {
  const buf = Buffer.alloc(512)
  const need = Buffer.alloc(4)
  const ok = GetUserObjectInformationW(h, 2 /* UOI_NAME */, buf, 512, need)
  if (!ok) return '(读取失败)'
  return buf.toString('utf16le').replace(/\0.*$/, '')
}
console.log('pid                =', process.pid)
console.log('EnumWindows 返回   =', total, ' 枚举到窗口数 =', pids.length, ' 涉及进程数 =', new Set(pids).size)
console.log('GetForegroundWindow=', GetForegroundWindow())
const ws = GetProcessWindowStation()
const td = GetThreadDesktop(GetCurrentThreadId())
console.log('window station     =', ws, nameOf(ws))
console.log('desktop            =', td, nameOf(td))
console.log('DLL 路径           =', koffi.load('user32.dll') ? 'ok' : 'n/a')
