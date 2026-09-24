/**
 * Shell catalogue, executable resolution, and selection planning for the
 * settings-page Shell selector.
 *
 * The feature has exactly ONE source of truth: the shipped PowerShell executor's
 * `pwshPath` field in the `pwsh-sandbox` profile entry. The shipped executor
 * reads its volatile `pwshPath` reference before each new command, so writing
 * this one field changes the next spawned shell without touching the sandbox,
 * approval, jobs, timeouts, or other shipped rows.
 *
 * Nothing here guesses the live value: `probeShells` reports
 * `ctx.shell.pwshPath`, the executor's own resolved executable. The candidate
 * lists below only describe what each option WOULD resolve to.
 *
 * Windows-only by construction; paths are built with `win32` so the split and
 * join rules match the platform being targeted rather than the host running the
 * tests.
 *
 * @module dsh-plugin-shell-selector/shells
 */

import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'

/** The PowerShell sandbox profile entry whose Config owns `pwshPath`. */
export const SHELL_NAMESPACE = process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox'

/** The one field this plugin writes. */
export const SHELL_PATH_FIELD = 'pwshPath'

/** The four selectable shells, in page order. */
export const SHELL_KINDS = Object.freeze(['auto', 'pwsh7', 'pwsh5', 'gitbash'])

/** Locale dictionary keys used as the stable option labels. */
export const SHELL_LABEL_KEYS = Object.freeze({
  auto: 'option.auto',
  pwsh7: 'option.pwsh7',
  pwsh5: 'option.pwsh5',
  gitbash: 'option.gitbash',
})

/**
 * A selection failure that the Remote half maps onto a `RemoteError`. The `code`
 * is a stable identifier; `message` is already user-facing.
 */
export class ShellSelectorError extends Error {
  /**
   * @param code - stable failure identifier, e.g. `shell-selector/readonly`.
   * @param message - user-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ShellSelectorError'
    this.code = code
  }
}

/** Whether a path names the same executable, ignoring case and separators. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalize = value => win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/** Split a Windows `PATH` value into usable directory entries. */
function pathEntries(env) {
  const entries = []
  for (const entry of String(env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length > 0) entries.push(trimmed)
  }
  return entries
}

/**
 * The PowerShell 7 locations the shipped executor probes, in its order: the
 * machine-wide PowerShell 7 install, then every `PATH` entry.
 *
 * Mirrors `candidatePwshPaths` in `@deepseek-ai/dsh-pwsh-local` so the
 * "automatic" option previews the same executable the executor would pick.
 *
 * @param env - environment to probe; defaults to the process environment.
 * @returns candidate `pwsh.exe` paths in resolution order.
 */
export function pwsh7Locations(env = process.env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of pathEntries(env)) candidates.push(win32.join(entry, 'pwsh.exe'))
  return candidates
}

/**
 * An additional PowerShell 7 location: the per-user Microsoft Store execution
 * alias. The shipped probe reaches it only when its directory is on `PATH`,
 * which is not guaranteed; an EXPLICIT "PowerShell 7" choice should still find a
 * Store install, so this candidate is appended for that option alone.
 *
 * @param env - environment to probe.
 * @returns the Store alias path, or `undefined` without a `LOCALAPPDATA`.
 */
export function pwsh7StoreAlias(env = process.env) {
  const localAppData = env.LOCALAPPDATA
  if (typeof localAppData !== 'string' || localAppData.length === 0) return undefined
  return win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')
}

/**
 * The canned Windows PowerShell 5.1 executable shipped inside Windows.
 *
 * @param env - environment to probe.
 * @returns the absolute `powershell.exe` path.
 */
export function pwsh5Path(env = process.env) {
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Git for Windows install locations, most specific first.
 *
 * `PATH` is deliberately NOT consulted. On a machine with WSL enabled, the
 * `bash` on `PATH` is `%SystemRoot%\System32\bash.exe`, the WSL launcher, which
 * executes inside a separate Linux filesystem namespace. Using it would silently
 * replace the harness file sandbox with the WSL VM boundary, so only explicit
 * Git for Windows install roots are considered.
 *
 * @param env - environment to probe.
 * @returns candidate Git Bash paths in resolution order.
 */
export function gitBashLocations(env = process.env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [win32.join(programFiles, 'Git', 'bin', 'bash.exe')]
  const programFilesX86 = env['ProgramFiles(x86)']
  if (typeof programFilesX86 === 'string' && programFilesX86.length > 0) {
    candidates.push(win32.join(programFilesX86, 'Git', 'bin', 'bash.exe'))
  }
  const localAppData = env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push(win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
  }
  return candidates
}

/**
 * Whether a path is the WSL launcher rather than a Git for Windows executable.
 *
 * @param path - path to classify.
 * @param env - environment supplying `SystemRoot`.
 * @returns whether `path` is `%SystemRoot%\System32\bash.exe`.
 */
export function isWslLauncher(path, env = process.env) {
  return samePath(path, win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'bash.exe'))
}

/**
 * Whether a path is Windows PowerShell 5.1 rather than PowerShell 7.
 *
 * @param path - an executor executable path.
 * @param env - environment supplying `SystemRoot`.
 * @returns whether the path names the in-box 5.1 executable.
 */
export function isWindowsPowerShell51(path, env = process.env) {
  if (typeof path !== 'string' || path.length === 0) return false
  const lowered = win32.normalize(path).toLowerCase()
  return lowered.endsWith(win32.join('windowspowershell', 'v1.0', 'powershell.exe').toLowerCase())
    || samePath(path, pwsh5Path(env))
}

/**
 * Classify one candidate path the way the shipped executor does.
 *
 * `lstat` deliberately does not follow reparse points, so a Microsoft Store
 * execution alias is seen as the link it is instead of failing on the target's
 * ACL — the same reason `dsh-pwsh-local` uses `lstatSync`.
 *
 * @param path - candidate executable path.
 * @param lstat - stat function; injectable for tests.
 * @returns `executable`, `directory`, `missing`, or `other`.
 */
export function executableState(path, lstat = lstatSync) {
  try {
    const info = lstat(path)
    if (info.isDirectory()) return 'directory'
    return info.isFile() || info.isSymbolicLink() ? 'executable' : 'other'
  } catch {
    return 'missing'
  }
}

/** First candidate that exists as a spawnable file, or `undefined`. */
function firstExecutable(candidates, lstat) {
  for (const candidate of candidates) if (executableState(candidate, lstat) === 'executable') return candidate
  return undefined
}

/**
 * Resolve one option into the executable it would use and whether it is usable.
 *
 * @param kind - one of {@link SHELL_KINDS}.
 * @param env - environment to probe.
 * @param lstat - stat function; injectable for tests.
 * @param platform - target platform; defaults to the process platform.
 * @returns the option's preview: kind, availability, resolved path, reasons.
 */
export function describeOption(kind, env = process.env, lstat = lstatSync, platform = process.platform) {
  const labelKey = SHELL_LABEL_KEYS[kind]
  if (platform !== 'win32') {
    return { kind, labelKey, available: false, path: null, detailKey: null, reasonKey: 'reason.windowsOnly', reason: 'Shell 选择器仅适用于 Windows 部署。' }
  }
  if (kind === 'auto') {
    const candidates = [...pwsh7Locations(env), pwsh5Path(env)]
    const found = firstExecutable(candidates, lstat)
    if (found === undefined) {
      // Matches the shipped fallback: no known location, so `pwsh` resolves via PATH.
      return { kind, labelKey, available: true, path: 'pwsh', detailKey: 'reason.autoPathLookup', reasonKey: null, reason: null }
    }
    const landedOn51 = isWindowsPowerShell51(found, env)
    return {
      kind,
      labelKey,
      available: true,
      path: found,
      detailKey: landedOn51 ? 'reason.autoLanded51' : 'reason.autoLanded7',
      reasonKey: null,
      reason: null,
    }
  }
  if (kind === 'pwsh7') {
    const alias = pwsh7StoreAlias(env)
    const candidates = alias === undefined ? pwsh7Locations(env) : [...pwsh7Locations(env), alias]
    const found = firstExecutable(candidates, lstat)
    if (found === undefined) {
      // An explicit choice must never silently become a different shell.
      return { kind, labelKey, available: false, path: null, detailKey: null, reasonKey: 'reason.noPwsh7', reason: '未检测到 PowerShell 7（pwsh.exe）。' }
    }
    return { kind, labelKey, available: true, path: found, detailKey: null, reasonKey: null, reason: null }
  }
  if (kind === 'pwsh5') {
    const found = pwsh5Path(env)
    if (executableState(found, lstat) !== 'executable') {
      return { kind, labelKey, available: false, path: null, detailKey: null, reasonKey: 'reason.noPwsh5', reason: '未检测到 Windows PowerShell 5.1。' }
    }
    return { kind, labelKey, available: true, path: found, detailKey: 'reason.pwsh5Dialect', reasonKey: null, reason: null }
  }
  // Git Bash. Installed is not the same as usable: the Windows sandbox runs the
  // command under a WRITE_RESTRICTED token whose write capabilities cover only
  // the workspace and a private temp directory, and named pipes are unavailable
  // in both confined modes while MSYS2's fork emulation depends on them. Until
  // the confinement probe has actually been executed and reviewed, this option
  // stays unavailable rather than being offered as a working choice.
  const found = firstExecutable(gitBashLocations(env), lstat)
  if (found === undefined) {
    return { kind, labelKey, available: false, path: null, detailKey: null, reasonKey: 'reason.noGitBash', reason: '未检测到 Git for Windows（Program Files\\Git\\bin\\bash.exe）。' }
  }
  if (isWslLauncher(found, env)) {
    // Unreachable through the explicit candidate list; kept as a hard guard so a
    // future change to that list can never hand the AI a WSL shell.
    return { kind, labelKey, available: false, path: null, detailKey: null, reasonKey: 'reason.wslBash', reason: '解析结果是 WSL 启动器而非 Git Bash，已拒绝。' }
  }
  return {
    kind,
    labelKey,
    available: false,
    path: found,
    detailKey: 'reason.gitBashUnverified',
    reasonKey: 'reason.gitBashUnverified',
    reason: '已安装，但尚未验证它能在 Windows 文件沙箱下受限运行，因此暂不可选。',
  }
}

/**
 * Build the full option list.
 *
 * @param env - environment to probe.
 * @param lstat - stat function; injectable for tests.
 * @param platform - target platform.
 * @returns one entry per {@link SHELL_KINDS} member, in page order.
 */
export function buildCatalog(env = process.env, lstat = lstatSync, platform = process.platform) {
  return SHELL_KINDS.map(kind => describeOption(kind, env, lstat, platform))
}

/** Find this plugin's PowerShell sandbox profile section among the described entries. */
function findShellSection(settings) {
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
  const described = settings.describe({ redactSecrets: true })
  if (!Array.isArray(described)) return undefined
  return described.find(entry => entry !== null && typeof entry === 'object' && entry.ns === SHELL_NAMESPACE)
}

/**
 * Derive which option the current stored user layer represents.
 *
 * "Automatic" is the absence of a user-layer `pwshPath`, not a value that
 * happens to equal what automatic would resolve to, so the page can keep
 * showing the shipped default after an unrelated value changes.
 *
 * @param section - the described `shell` namespace, or `undefined`.
 * @param env - environment to probe.
 * @param lstat - stat function.
 * @returns `{ kind, source, path? }`.
 */
export function currentSelection(section, env = process.env, lstat = lstatSync) {
  const user = section?.user
  const hasUser = user !== null && typeof user === 'object' && Object.hasOwn(user, SHELL_PATH_FIELD)
  if (!hasUser) return { kind: 'auto', source: 'default' }
  const declared = user[SHELL_PATH_FIELD]
  if (typeof declared !== 'string') return { kind: 'custom', source: 'user' }
  if (samePath(declared, pwsh5Path(env))) return { kind: 'pwsh5', source: 'user' }
  const alias = pwsh7StoreAlias(env)
  const candidates = alias === undefined ? pwsh7Locations(env) : [...pwsh7Locations(env), alias]
  const ps7 = firstExecutable(candidates, lstat)
  if (ps7 !== undefined && samePath(declared, ps7)) return { kind: 'pwsh7', source: 'user' }
  return { kind: 'custom', source: 'user', path: declared }
}

/**
 * Read the live executor facts and the selectable options.
 *
 * `executable` is authoritative: it is the path the executor will spawn on the
 * next command, read from `ctx.shell.pwshPath` rather than re-derived here.
 *
 * @param input - settings service, optional shell service, environment, platform.
 * @returns the page payload.
 */
export function probeShells({ settings, shell, env = process.env, platform = process.platform, lstat = lstatSync }) {
  const section = findShellSection(settings)
  return {
    platform,
    supported: platform === 'win32',
    writable: settings?.writable === true,
    namespaceRegistered: section !== undefined,
    executableBound: shell !== undefined && shell !== null,
    executable: shell?.pwshPath ?? null,
    sandboxMode: shell?.sandboxMode ?? null,
    revision: section?.revision ?? null,
    current: currentSelection(section, env, lstat),
    options: buildCatalog(env, lstat, platform),
  }
}

/**
 * Validate one requested option and produce the settings edit it requires.
 *
 * Validation happens here, before any write, because the executor trusts a
 * configured `pwshPath` as-is and never checks it itself.
 *
 * @param input - the requested kind plus settings service, environment, platform.
 * @returns the `mutate` operations and the validated option.
 * @throws {ShellSelectorError} when the request cannot be honoured.
 */
export function planSelection({ kind, settings, env = process.env, platform = process.platform, lstat = lstatSync }) {
  if (!SHELL_KINDS.includes(kind)) {
    throw new ShellSelectorError('shell-selector/invalid', `未知的 Shell 选项：${String(kind)}`)
  }
  if (settings === undefined || settings === null) {
    throw new ShellSelectorError('shell-selector/unavailable', '设置服务不可用。')
  }
  if (findShellSection(settings) === undefined) {
    throw new ShellSelectorError('shell-selector/absent', '未注册 shell 设置命名空间，请确认 shell 执行器已加载。')
  }
  if (settings.writable !== true) {
    throw new ShellSelectorError('shell-selector/readonly', '当前设置存储不可写。')
  }
  const option = describeOption(kind, env, lstat, platform)
  if (!option.available) {
    throw new ShellSelectorError('shell-selector/unavailable', option.reason ?? '该选项当前不可用。')
  }
  const ops = kind === 'auto'
    // Unset, never `set(undefined)`: removing the user-layer field re-inherits the
    // composition base, which is exactly "keep the current default".
    ? [{ op: 'unset', path: [SHELL_PATH_FIELD] }]
    : [{ op: 'set', path: [SHELL_PATH_FIELD], value: option.path }]
  return { ops, option }
}

/**
 * Apply one selection through path-addressed settings edits, so fields this
 * plugin does not own (timeouts, output caps, `cwd`) are never restated.
 *
 * @param input - the requested kind, the revision the caller read, and services.
 * @returns the validated option.
 * @throws {ShellSelectorError} when the request cannot be honoured.
 */
export async function executeSelection(input) {
  const { ops, option } = planSelection(input)
  await input.settings.mutate(SHELL_NAMESPACE, ops, input.revision ?? undefined)
  return option
}

/**
 * The dialect note the model needs when the effective shell is not the one the
 * `pwsh` tool's schema describes. Empty for PowerShell 7 and for every
 * non-PowerShell path, so nothing is added unless it is true.
 *
 * @param executable - the executor's live executable path.
 * @param env - environment supplying `SystemRoot`.
 * @returns a model-facing sentence, or an empty string.
 */
export function dialectHint(executable, env = process.env) {
  if (!isWindowsPowerShell51(executable, env)) return ''
  return 'The command shell is Windows PowerShell 5.1, not PowerShell 7. It has no `&&`, `||`, ternary `? :`, '
    + 'or `??`. Chain commands with `;` and branch with `if (...) { } else { }`.'
}
