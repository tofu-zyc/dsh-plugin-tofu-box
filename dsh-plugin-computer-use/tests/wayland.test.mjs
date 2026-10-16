import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureLinuxDesktop, probeGnomeHelper, linuxDesktopHint, WAYLAND_ENV } from '../linux.js'
import { desktopStatus, installHelper, parseEnabledExtensions } from '../scripts/wayland.mjs'

const desktopEnv = () => ({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })
const success = stdout => ({ ok: true, stdout, error: '' })
const failure = { ok: false, stdout: '', error: 'not available' }

test('GNOME Wayland with XWayland DISPLAY enables native backend before loading', () => {
  const env = desktopEnv()
  const state = configureLinuxDesktop({ platform: 'linux', env })
  assert.deepEqual(state, { linux: true, wayland: true, native: true, gnome: true })
  assert.equal(env[WAYLAND_ENV], '1')
})

test('Wayland socket detects a session without XDG_SESSION_TYPE', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-1' }
  assert.equal(configureLinuxDesktop({ platform: 'linux', env }).native, true)
})

test('X11 and other platforms retain their existing backend', () => {
  const env = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', WAYLAND_DISPLAY: 'inherited-stale-value' }
  assert.equal(configureLinuxDesktop({ platform: 'linux', env }).native, false)
  assert.equal(env[WAYLAND_ENV], undefined)
  for (const platform of ['win32', 'darwin']) {
    const other = desktopEnv()
    assert.equal(configureLinuxDesktop({ platform, env: other, wayland: 'on' }).native, false)
    assert.equal(other[WAYLAND_ENV], undefined)
  }
})

test('automatic mode respects all explicit upstream disable values', () => {
  for (const flag of ['0', 'false', 'FALSE', '', ' 0 ']) {
    const env = { ...desktopEnv(), [WAYLAND_ENV]: flag }
    assert.equal(configureLinuxDesktop({ platform: 'linux', env }).native, false)
    assert.equal(env[WAYLAND_ENV], flag)
  }
})

test('on/off config overrides the env flag; native routing still requires a Wayland session', () => {
  const env = { ...desktopEnv(), [WAYLAND_ENV]: '0' }
  assert.equal(configureLinuxDesktop({ platform: 'linux', env, wayland: 'on' }).native, true)
  assert.equal(configureLinuxDesktop({ platform: 'linux', env, wayland: 'off' }).native, false)
  assert.equal(configureLinuxDesktop({ platform: 'linux', env: {}, wayland: 'on' }).native, false)
})

test('helper probe distinguishes missing, outdated and active APIs', async () => {
  assert.equal((await probeGnomeHelper(async () => failure)).active, false)
  assert.equal((await probeGnomeHelper(async () => success('(uint32 3,)'))).active, false)
  assert.deepEqual(await probeGnomeHelper(async (command, args) => {
    assert.equal(command, 'gdbus')
    assert.equal(args.at(-1), 'org.cua.WinRects.GetVersion')
    return success('(uint32 8,)')
  }), { active: true, version: 8, error: '' })
})

test('setup hints are specific to the active backend/compositor', () => {
  assert.equal(linuxDesktopHint({ native: false }), '')
  assert.match(linuxDesktopHint({ native: true, gnome: true }), /install.*log out/)
  assert.doesNotMatch(linuxDesktopHint({ native: true, gnome: false }), /WinRects|install/)
})

test('GVariant extension arrays parse without dropping existing extensions', () => {
  assert.deepEqual(parseEnabledExtensions("['ubuntu-dock@ubuntu.com', 'another@example.org']"), ['ubuntu-dock@ubuntu.com', 'another@example.org'])
  assert.deepEqual(parseEnabledExtensions('@as []'), [])
  assert.throws(() => parseEnabledExtensions('unexpected output'), /no settings were changed/)
})

async function withTemp(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wayland-test-'))
  try { await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('install on GNOME 50 copies the bundled helper and preserves existing extensions', async () => withTemp(async directory => {
  const writes = []
  const destination = await installHelper({ env: { XDG_DATA_HOME: directory }, run: async (command, args) => {
    if (command === 'gnome-shell') return success('GNOME Shell 50.2')
    if (args[0] === 'get') return success(args.at(-1) === 'enabled-extensions' ? "['ubuntu-dock@ubuntu.com']" : '@as []')
    writes.push(args)
    return success('')
  } })
  assert.equal(destination, join(directory, 'gnome-shell', 'extensions', 'winrects@cua'))
  assert.deepEqual(JSON.parse(writes[0].at(-1)), ['ubuntu-dock@ubuntu.com', 'winrects@cua'])
  assert.deepEqual(await readFile(join(destination, 'extension.js')), await readFile(new URL('../wayland-helper/winrects@cua/extension.js', import.meta.url)))
  assert.equal(JSON.parse(await readFile(join(destination, 'metadata.json'), 'utf8')).version, 8)
}))

test('reinstall is idempotent and honors the default user data directory', async () => withTemp(async directory => {
  const run = async (command, args) => {
    if (command === 'gnome-shell') return success('GNOME Shell 50.0')
    assert.equal(args[0], 'get', 'an enabled helper must not rewrite GNOME settings')
    return success(args.at(-1) === 'enabled-extensions' ? "['winrects@cua', 'ubuntu-dock@ubuntu.com']" : '@as []')
  }
  const destination = await installHelper({ env: {}, home: directory, run })
  assert.equal(destination, join(directory, '.local', 'share', 'gnome-shell', 'extensions', 'winrects@cua'))
}))

test('unsupported GNOME and unreadable settings stop installation before changing files', async () => {
  await assert.rejects(installHelper({ run: async () => success('GNOME Shell 51.0') }), /does not support GNOME 51/)
  await assert.rejects(installHelper({ run: async command => command === 'gnome-shell' ? success('GNOME Shell 50.0') : failure }), /Cannot read GNOME settings/)
  await assert.rejects(installHelper({ run: async command => command === 'gnome-shell' ? success('GNOME Shell 50.0') : success('invalid') }), /no settings were changed/)
})

test('install removes only WinRects from the forced-disabled list', async () => withTemp(async directory => {
  const writes = []
  await installHelper({ env: { XDG_DATA_HOME: directory }, run: async (command, args) => {
    if (command === 'gnome-shell') return success('GNOME Shell 50.0')
    if (args[0] === 'get') return success(args.at(-1) === 'enabled-extensions' ? "['winrects@cua']" : "['other@example.org', 'winrects@cua']")
    writes.push(args)
    return success('')
  } })
  assert.equal(writes.length, 1)
  assert.equal(writes[0][2], 'disabled-extensions')
  assert.deepEqual(JSON.parse(writes[0].at(-1)), ['other@example.org'])
}))

test('failed enabling is reported without claiming the helper is active', async () => withTemp(async directory => {
  await assert.rejects(installHelper({ env: { XDG_DATA_HOME: directory }, run: async (command, args) => command === 'gnome-shell' ? success('GNOME Shell 50.0') : args[0] === 'get' ? success('@as []') : failure }), /enabling failed/)
}))

function statusRun(overrides = {}) {
  return async (command, args) => {
    const key = command === 'gsettings' ? 'extensions' : args.at(-1)
    return overrides[key] ?? success({
      'org.cua.WinRects.GetVersion': '(uint32 8,)',
      AvailableDeviceTypes: '(<uint32 3>,)',
      'org.a11y.Bus.GetAddress': "('unix:path=/run/user/1000/at-spi/bus',)",
      extensions: 'false',
    }[key] ?? '')
  }
}

test('status checks live helper, portal, AT-SPI and GNOME extension state without mutation', async () => {
  const env = desktopEnv()
  assert.equal((await desktopStatus({ platform: 'linux', env, run: statusRun() })).ready, true)
  assert.equal(env[WAYLAND_ENV], undefined)
})

test('status refuses incomplete setups and a portal without both keyboard and pointer', async () => {
  for (const overrides of [
    { 'org.cua.WinRects.GetVersion': failure },
    { AvailableDeviceTypes: success('(<uint32 2>,)') },
    { 'org.a11y.Bus.GetAddress': failure },
    { extensions: success('true') },
  ]) assert.equal((await desktopStatus({ platform: 'linux', env: desktopEnv(), run: statusRun(overrides) })).ready, false)
  assert.equal((await desktopStatus({ platform: 'linux', env: { ...desktopEnv(), [WAYLAND_ENV]: '0' }, run: statusRun() })).ready, false)
  assert.equal((await desktopStatus({ platform: 'linux', env: { ...desktopEnv(), WAYLAND_DISPLAY: '' }, run: statusRun() })).ready, false)
})

test('status outside GNOME/Wayland does not invoke desktop commands', async () => {
  assert.equal((await desktopStatus({ platform: 'win32', env: {}, run: () => { throw new Error('unexpected command') } })).ready, false)
})

test('the shipped command executes directly', () => {
  assert.match(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/wayland.mjs', import.meta.url)), '--help'], { encoding: 'utf8' }), /Usage: dsh-computer-use-wayland/)
})

test('the command executes through a Linux npm-style symlink', { skip: process.platform === 'win32' }, async () => withTemp(async directory => {
  const bin = join(directory, 'dsh-computer-use-wayland')
  await symlink(fileURLToPath(new URL('../scripts/wayland.mjs', import.meta.url)), bin)
  assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }), /Usage: dsh-computer-use-wayland/)
}))
