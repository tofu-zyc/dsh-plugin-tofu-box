#!/usr/bin/env node
import { readFile, mkdir, copyFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configureLinuxDesktop, probeGnomeHelper, runDesktopCommand, HELPER_UUID } from '../linux.js'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(pluginDir, 'wayland-helper', HELPER_UUID)

// gsettings prints GVariant, not JSON. Extension UUIDs cannot contain quotes
// or escapes, so accept only its narrow string-array representation.
export function parseEnabledExtensions(value) {
  const text = value.trim().replace(/^@as\s+/, '')
  if (!/^\[\s*(?:'[^'\\]*'\s*(?:,\s*'[^'\\]*'\s*)*)?\]$/.test(text)) {
    throw new Error('Cannot parse GNOME enabled-extensions; no settings were changed: ' + value)
  }
  return [...text.matchAll(/'([^']*)'/g)].map(match => match[1])
}

export async function installHelper({ env = process.env, home = homedir(), run = runDesktopCommand, sourceDir = source } = {}) {
  const version = await run('gnome-shell', ['--version'])
  if (!version.ok) throw new Error('gnome-shell is unavailable; run this command in your GNOME desktop session.')
  const major = /\b(\d+)(?:\.\d+)?\b/.exec(version.stdout)?.[1]
  const metadata = JSON.parse(await readFile(join(sourceDir, 'metadata.json'), 'utf8'))
  if (!metadata['shell-version'].includes(major)) throw new Error('This bundled helper does not support GNOME ' + major + '; supported versions: ' + metadata['shell-version'].join(', '))
  // Read and validate settings BEFORE copying files or changing anything.
  const current = await run('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'])
  if (!current.ok) throw new Error('Cannot read GNOME settings: ' + current.error)
  const enabled = parseEnabledExtensions(current.stdout)
  const blocked = await run('gsettings', ['get', 'org.gnome.shell', 'disabled-extensions'])
  if (!blocked.ok) throw new Error('Cannot read GNOME disabled-extensions: ' + blocked.error)
  const disabled = parseEnabledExtensions(blocked.stdout)
  const destination = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'gnome-shell', 'extensions', HELPER_UUID)
  await mkdir(destination, { recursive: true })
  for (const file of ['extension.js', 'metadata.json']) await copyFile(join(sourceDir, file), join(destination, file))
  if (!enabled.includes(HELPER_UUID)) {
    enabled.push(HELPER_UUID)
    const updated = await run('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', JSON.stringify(enabled)])
    if (!updated.ok) throw new Error('Helper files were installed, but enabling failed: ' + updated.error)
  }
  // GNOME's forced-disabled list takes precedence over enabled-extensions.
  if (disabled.includes(HELPER_UUID)) {
    const updated = await run('gsettings', ['set', 'org.gnome.shell', 'disabled-extensions', JSON.stringify(disabled.filter(uuid => uuid !== HELPER_UUID))])
    if (!updated.ok) throw new Error('Helper files were installed, but clearing its disabled state failed: ' + updated.error)
  }
  return destination
}

export async function desktopStatus({ env = process.env, platform = process.platform, run = runDesktopCommand } = {}) {
  // Inspect a copy: a status command must not change the caller's environment.
  const state = configureLinuxDesktop({ platform, env: { ...env } })
  if (!state.linux || !state.wayland || !state.gnome) return { ready: false, lines: ['This setup command targets a GNOME/Wayland user session.', 'Detected: ' + platform + ' / ' + (env.XDG_SESSION_TYPE || '?') + ' / ' + (env.XDG_CURRENT_DESKTOP || '?')] }
  const [helper, portal, accessibility, disabled] = await Promise.all([
    probeGnomeHelper(run),
    run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.portal.RemoteDesktop', 'AvailableDeviceTypes']),
    run('gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress']),
    run('gsettings', ['get', 'org.gnome.shell', 'disable-user-extensions']),
  ])
  const devices = portal.ok ? Number(/uint32\s+(\d+)/.exec(portal.stdout)?.[1] ?? 0) : 0
  const input = (devices & 3) === 3
  const session = !!env.WAYLAND_DISPLAY && !!env.XDG_RUNTIME_DIR && !!env.DBUS_SESSION_BUS_ADDRESS
  return {
    ready: state.native && session && helper.active && input && accessibility.ok && disabled.ok && disabled.stdout === 'false',
    lines: [
      'Wayland environment: ' + (session ? 'OK' : 'MISSING (WAYLAND_DISPLAY / XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS)'),
      'Native Wayland backend: ' + (state.native ? 'automatic' : 'disabled by CUA_DRIVER_RS_ENABLE_WAYLAND; unset it or use config wayland: on'),
      'WinRects helper: ' + (helper.active ? 'ACTIVE (v' + helper.version + ')' : 'MISSING/OUTDATED; run install, then log out and back in once'),
      'GNOME user extensions: ' + (disabled.ok && disabled.stdout === 'false' ? 'enabled' : 'disabled or unreadable; enable Extensions in GNOME first'),
      'Remote Desktop portal (keyboard + pointer): ' + (input ? 'available (consent is requested on first use)' : 'MISSING; install xdg-desktop-portal and xdg-desktop-portal-gnome'),
      'Accessibility bus: ' + (accessibility.ok ? 'available' : 'MISSING; install at-spi2-core'),
      'Run dsh from this same graphical user session; restart it after setup.',
    ],
  }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'status'
  if (!['status', 'install', '--help', '-h'].includes(command) || args.length > 1) throw new Error('Usage: dsh-computer-use-wayland [status|install]')
  if (command === '--help' || command === '-h') { console.log('Usage: dsh-computer-use-wayland [status|install]'); return }
  if (process.platform !== 'linux') throw new Error('Run this command on the Ubuntu/GNOME machine where dsh controls the desktop.')
  if (command === 'install') {
    const state = configureLinuxDesktop({ env: { ...process.env } })
    if (!state.wayland || !state.gnome) throw new Error('Run install from your GNOME/Wayland graphical session.')
    const destination = await installHelper()
    console.log('Installed ' + HELPER_UUID + ' to ' + destination + '.\nLog out and back in once, restart dsh, then run dsh-computer-use-wayland status.\nOn Wayland, restarting GNOME Shell with Alt+F2 r is unavailable.')
  } else {
    const status = await desktopStatus()
    console.log(status.lines.join('\n'))
    if (!status.ready) process.exitCode = 1
  }
}

// npm exposes bins as symlinks on Linux; compare resolved files so the command
// also executes when launched through node_modules/.bin or npx.
if (process.argv[1] && pathToFileURL(await realpath(resolve(process.argv[1]))).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
