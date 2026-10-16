import { execFile } from 'node:child_process'

export const WAYLAND_ENV = 'CUA_DRIVER_RS_ENABLE_WAYLAND'
export const HELPER_UUID = 'winrects@cua'
export const HELPER_VERSION = 8

/** DISPLAY is also set by XWayland; it must not hide a native Wayland session. */
export function configureLinuxDesktop({ platform = process.platform, env = process.env, wayland = 'auto' } = {}) {
  const state = { linux: platform === 'linux', wayland: false, native: false, gnome: false }
  if (!state.linux) return state
  const session = String(env.XDG_SESSION_TYPE ?? '').toLowerCase()
  state.wayland = session === 'wayland' || (session !== 'x11' && !!env.WAYLAND_DISPLAY)
  state.gnome = /gnome|ubuntu/i.test(String(env.XDG_CURRENT_DESKTOP ?? '') + ':' + String(env.DESKTOP_SESSION ?? ''))
  if (wayland === 'on') env[WAYLAND_ENV] = '1'
  else if (wayland === 'off') env[WAYLAND_ENV] = '0'
  else if (state.wayland && env[WAYLAND_ENV] === undefined) env[WAYLAND_ENV] = '1'
  const flag = String(env[WAYLAND_ENV] ?? '').trim()
  state.native = state.wayland && !!flag && !/^(0|false)$/i.test(flag)
  return state
}

/** Bounded, shell-free desktop probes; never request screen/input permission here. */
export function runDesktopCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? '').trim(), error: error ? String(stderr || error.message).trim() : '' })
    })
  })
}

export async function probeGnomeHelper(run = runDesktopCommand) {
  const result = await run('gdbus', ['call', '--session', '--dest', 'org.cua.WinRects', '--object-path', '/org/cua/WinRects', '--method', 'org.cua.WinRects.GetVersion'])
  const version = result.ok ? Number(/(?:uint32\s+)?(\d+)/.exec(result.stdout)?.[1] ?? 0) : 0
  return { active: result.ok && version >= HELPER_VERSION, version, error: result.error }
}

export function linuxDesktopHint(state) {
  if (!state.native) return ''
  if (!state.gnome) return ' Native Wayland is enabled; available capture and input routes depend on the compositor. Run dsh in the graphical user session with WAYLAND_DISPLAY, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS available.'
  return ' GNOME/Wayland setup: run dsh-computer-use-wayland install (or node <plugin-dir>/scripts/wayland.mjs install), then log out and back in once; run dsh-computer-use-wayland status in the same desktop session. Allow the system Remote Desktop prompt on the first input action. Keep WAYLAND_DISPLAY, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS available to the dsh process.'
}
