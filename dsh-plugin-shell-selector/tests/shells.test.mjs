/**
 * Unit tests for the pure resolution, probe, and selection-planning core.
 *
 * These exercise real logic against an injected filesystem and environment; no
 * Cordis runtime, no Host, and no command execution is involved.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 } from 'node:path'

import {
  SHELL_KINDS,
  SHELL_LABEL_KEYS,
  SHELL_NAMESPACE,
  SHELL_PATH_FIELD,
  ShellSelectorError,
  buildCatalog,
  currentSelection,
  describeOption,
  dialectHint,
  executableState,
  executeSelection,
  gitBashLocations,
  isWindowsPowerShell51,
  isWslLauncher,
  planSelection,
  probeShells,
  pwsh5Path,
  pwsh7Locations,
  pwsh7StoreAlias,
} from '../shells.js'

const ENV = Object.freeze({
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
  PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
})

const PS7 = win32.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const PS51 = pwsh5Path(ENV)
const GIT_BASH = win32.join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
const WSL_BASH = win32.join('C:\\Windows', 'System32', 'bash.exe')

/** Build an lstat stand-in from an explicit path table. */
function fakeFs(entries) {
  const table = new Map(Object.entries(entries).map(([path, kind]) => [path.toLowerCase(), kind]))
  return path => {
    const kind = table.get(String(path).toLowerCase())
    if (kind === undefined) {
      const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`)
      error.code = 'ENOENT'
      throw error
    }
    return { isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' }
  }
}

/** A settings service double that records every write. */
function fakeSettings(sections, writable = true) {
  const writes = []
  return {
    writable,
    writes,
    describe: () => sections,
    async mutate(ns, ops, revision) { writes.push({ ns, ops, revision }) },
  }
}

/** One `settings.describe()` entry for the `shell` namespace. */
const shellDescriptor = (user, revision = 7) => ({ ns: SHELL_NAMESPACE, revision, value: { ...user }, user })

/** The `describe()` result a settings double returns. */
const shellSection = (user, revision = 7) => [shellDescriptor(user, revision)]

test('pwsh7Locations mirrors the shipped probe order', () => {
  assert.deepEqual(pwsh7Locations(ENV), [
    PS7,
    win32.join('C:\\Windows\\system32', 'pwsh.exe'),
    win32.join('C:\\Program Files\\Git\\cmd', 'pwsh.exe'),
  ])
})

test('pwsh7StoreAlias and pwsh5Path derive from the environment', () => {
  assert.equal(pwsh7StoreAlias(ENV), win32.join(ENV.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  assert.equal(pwsh7StoreAlias({}), undefined)
  assert.equal(pwsh5Path(ENV), win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert.equal(pwsh5Path({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

test('Git Bash resolution never consults PATH', () => {
  const candidates = gitBashLocations(ENV)
  assert.equal(candidates[0], GIT_BASH)
  for (const candidate of candidates) {
    assert.ok(!candidate.toLowerCase().includes('git\\cmd'), `PATH entry leaked into Git Bash candidates: ${candidate}`)
    assert.ok(!isWslLauncher(candidate, ENV))
  }
  // The WSL launcher is what a PATH-based `bash` lookup would have produced.
  assert.ok(ENV.PATH.toLowerCase().includes('system32'))
  assert.ok(isWslLauncher(WSL_BASH, ENV))
  assert.ok(!isWslLauncher(GIT_BASH, ENV))
})

test('executableState distinguishes files, aliases, directories, and misses', () => {
  const lstat = fakeFs({ [PS7]: 'file', [GIT_BASH]: 'link', 'C:\\somewhere': 'dir' })
  assert.equal(executableState(PS7, lstat), 'executable')
  assert.equal(executableState(GIT_BASH, lstat), 'executable', 'a Store-style alias must count as spawnable')
  assert.equal(executableState('C:\\somewhere', lstat), 'directory')
  assert.equal(executableState('C:\\nope\\pwsh.exe', lstat), 'missing')
})

test('a path containing spaces is resolved and passed through intact', () => {
  const lstat = fakeFs({ [PS7]: 'file' })
  const option = describeOption('pwsh7', ENV, lstat, 'win32')
  assert.equal(option.available, true)
  assert.equal(option.path, PS7)
  assert.ok(option.path.includes(' '), 'the fixture must actually contain a space')

  const plan = planSelection({ kind: 'pwsh7', settings: fakeSettings(shellSection({})), env: ENV, platform: 'win32', lstat })
  assert.deepEqual(plan.ops, [{ op: 'set', path: [SHELL_PATH_FIELD], value: PS7 }])
})

test('automatic prefers PowerShell 7 and reports where it landed', () => {
  const both = describeOption('auto', ENV, fakeFs({ [PS7]: 'file', [PS51]: 'file' }), 'win32')
  assert.equal(both.available, true)
  assert.equal(both.path, PS7)
  assert.equal(both.detailKey, 'reason.autoLanded7')

  const only51 = describeOption('auto', ENV, fakeFs({ [PS51]: 'file' }), 'win32')
  assert.equal(only51.available, true)
  assert.equal(only51.path, PS51)
  assert.equal(only51.detailKey, 'reason.autoLanded51')

  const neither = describeOption('auto', ENV, fakeFs({}), 'win32')
  assert.equal(neither.available, true)
  assert.equal(neither.path, 'pwsh', 'automatic keeps the shipped PATH fallback')
  assert.equal(neither.detailKey, 'reason.autoPathLookup')
})

test('an explicit PowerShell 7 choice never silently becomes 5.1', () => {
  const option = describeOption('pwsh7', ENV, fakeFs({ [PS51]: 'file' }), 'win32')
  assert.equal(option.available, false)
  assert.equal(option.path, null)
  assert.equal(option.reasonKey, 'reason.noPwsh7')
})

test('the Store alias satisfies an explicit PowerShell 7 choice', () => {
  const alias = pwsh7StoreAlias(ENV)
  const option = describeOption('pwsh7', ENV, fakeFs({ [alias]: 'link' }), 'win32')
  assert.equal(option.available, true)
  assert.equal(option.path, alias)
})

test('Windows PowerShell 5.1 is offered only when the in-box executable exists', () => {
  assert.equal(describeOption('pwsh5', ENV, fakeFs({ [PS51]: 'file' }), 'win32').available, true)
  const missing = describeOption('pwsh5', ENV, fakeFs({}), 'win32')
  assert.equal(missing.available, false)
  assert.equal(missing.reasonKey, 'reason.noPwsh5')
})

test('Git Bash stays unavailable whether missing or installed', () => {
  const missing = describeOption('gitbash', ENV, fakeFs({}), 'win32')
  assert.equal(missing.available, false)
  assert.equal(missing.reasonKey, 'reason.noGitBash')

  const installed = describeOption('gitbash', ENV, fakeFs({ [GIT_BASH]: 'file' }), 'win32')
  assert.equal(installed.available, false, 'an unverified shell must not be selectable')
  assert.equal(installed.path, GIT_BASH, 'the detected path is still reported for transparency')
  assert.equal(installed.reasonKey, 'reason.gitBashUnverified')
})

test('non-Windows platforms offer nothing', () => {
  for (const option of buildCatalog(ENV, fakeFs({}), 'darwin')) {
    assert.equal(option.available, false)
    assert.equal(option.reasonKey, 'reason.windowsOnly')
  }
})

test('the catalog always lists the four kinds in page order', () => {
  const catalog = buildCatalog(ENV, fakeFs({ [PS7]: 'file', [PS51]: 'file', [GIT_BASH]: 'file' }), 'win32')
  assert.deepEqual(catalog.map(option => option.kind), [...SHELL_KINDS])
  for (const option of catalog) assert.equal(option.labelKey, SHELL_LABEL_KEYS[option.kind])
})

test('the current selection is derived from the user layer, not from equality alone', () => {
  const lstat = fakeFs({ [PS7]: 'file', [PS51]: 'file' })
  assert.deepEqual(currentSelection(shellDescriptor({}), ENV, lstat), { kind: 'auto', source: 'default' })
  assert.equal(currentSelection(shellDescriptor({ [SHELL_PATH_FIELD]: PS51 }), ENV, lstat).kind, 'pwsh5')
  assert.equal(currentSelection(shellDescriptor({ [SHELL_PATH_FIELD]: PS7 }), ENV, lstat).kind, 'pwsh7')
  const custom = currentSelection(shellDescriptor({ [SHELL_PATH_FIELD]: 'D:\\tools\\pwsh.exe' }), ENV, lstat)
  assert.equal(custom.kind, 'custom')
  assert.equal(custom.path, 'D:\\tools\\pwsh.exe')
  assert.deepEqual(currentSelection(undefined, ENV, lstat), { kind: 'auto', source: 'default' })
})

test('automatic selection unsets the field instead of writing a value', () => {
  const plan = planSelection({ kind: 'auto', settings: fakeSettings(shellSection({ [SHELL_PATH_FIELD]: PS51 })), env: ENV, platform: 'win32' })
  assert.deepEqual(plan.ops, [{ op: 'unset', path: [SHELL_PATH_FIELD] }])
})

test('planning rejects every unusable request without writing', async () => {
  const cases = [
    ['unknown kind', { kind: 'zsh' }, 'shell-selector/invalid'],
    ['unavailable option', { kind: 'gitbash' }, 'shell-selector/unavailable'],
    ['no namespace', { kind: 'pwsh5', sections: [] }, 'shell-selector/absent'],
    ['read-only store', { kind: 'pwsh5', writable: false }, 'shell-selector/readonly'],
  ]
  for (const [label, overrides, code] of cases) {
    const settings = fakeSettings(overrides.sections ?? shellSection({}), overrides.writable ?? true)
    const lstat = fakeFs({ [PS51]: 'file', [GIT_BASH]: 'file' })
    await assert.rejects(
      () => executeSelection({ kind: overrides.kind, settings, env: ENV, platform: 'win32', lstat }),
      error => error instanceof ShellSelectorError && error.code === code,
      label,
    )
    assert.deepEqual(settings.writes, [], `${label} must not write`)
  }
})

test('executing a selection writes the namespace and revision through', async () => {
  const settings = fakeSettings(shellSection({}), true)
  const option = await executeSelection({ kind: 'pwsh5', revision: 7, settings, env: ENV, platform: 'win32', lstat: fakeFs({ [PS51]: 'file' }) })
  assert.equal(option.path, PS51)
  assert.deepEqual(settings.writes, [{ ns: SHELL_NAMESPACE, ops: [{ op: 'set', path: [SHELL_PATH_FIELD], value: PS51 }], revision: 7 }])
})

test('probing reports the executor executable rather than a re-derived guess', () => {
  const payload = probeShells({
    settings: fakeSettings(shellSection({ [SHELL_PATH_FIELD]: PS51 }), true),
    shell: { pwshPath: 'C:\\real\\pwsh.exe', sandboxMode: 'workspace-write' },
    env: ENV,
    platform: 'win32',
    lstat: fakeFs({ [PS51]: 'file' }),
  })
  assert.equal(payload.executable, 'C:\\real\\pwsh.exe')
  assert.equal(payload.executableBound, true)
  assert.equal(payload.sandboxMode, 'workspace-write')
  assert.equal(payload.revision, 7)
  assert.equal(payload.writable, true)
  assert.equal(payload.namespaceRegistered, true)
  assert.equal(payload.current.kind, 'pwsh5')
  assert.equal(payload.options.length, SHELL_KINDS.length)
})

test('probing tolerates a missing executor and settings service', () => {
  const payload = probeShells({ settings: undefined, shell: undefined, env: ENV, platform: 'win32', lstat: fakeFs({}) })
  assert.equal(payload.executable, null)
  assert.equal(payload.executableBound, false)
  assert.equal(payload.namespaceRegistered, false)
  assert.equal(payload.writable, false)
})

test('isWindowsPowerShell51 recognises the in-box path only', () => {
  assert.equal(isWindowsPowerShell51(PS51, ENV), true)
  assert.equal(isWindowsPowerShell51(PS51.toUpperCase(), ENV), true)
  assert.equal(isWindowsPowerShell51(PS7, ENV), false)
  assert.equal(isWindowsPowerShell51(null, ENV), false)
  assert.equal(isWindowsPowerShell51('', ENV), false)
})

test('the dialect hint appears only for Windows PowerShell 5.1', () => {
  const hint = dialectHint(PS51, ENV)
  assert.ok(hint.includes('Windows PowerShell 5.1'))
  assert.ok(hint.includes('&&'))
  assert.equal(dialectHint(PS7, ENV), '')
  assert.equal(dialectHint(null, ENV), '')
  assert.equal(dialectHint('pwsh', ENV), '')
})
