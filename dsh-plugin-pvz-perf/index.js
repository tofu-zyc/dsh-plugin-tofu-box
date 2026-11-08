/**
 * Host half of the pvz_perf panel plugin.
 *
 * The plugin never ships, copies, downloads or modifies game assets. Instead it
 * finds a local pvz_perf web build (v3.3.x: a directory holding `index.html` and
 * `web-build-manifest.json`) and forwards that directory over one read-only,
 * loopback-only HTTP route on the composition's own web server:
 *
 *   GET  /pvz-perf/status   -> 200 JSON describing the resolved build
 *   GET  /pvz-perf/game/**  -> the build's bytes (the browser half's iframe src)
 *   HEAD /pvz-perf/game/**  -> the same headers, no body
 *
 * The route is registered as one `prefix` route, so it stays inside whatever
 * loopback bind and authentication fence the Harness web server already applies.
 * Nothing is published into the Cordis service namespace and nothing is written
 * to disk.
 *
 * Design notes:
 *
 * - The browser half embeds `${GAME_PREFIX}/` in an iframe. The build references
 *   assets with relative URLs (`./launcher.js`, `./pvz-perf.wasm.gz`) and never
 *   reads `location.pathname`, so serving it below a subpath is safe; only the
 *   route prefix is duplicated between the two halves because they cannot
 *   import each other.
 * - Asset bytes are streamed with `fs.createReadStream`: `pvz-perf.data` is
 *   about 38 MB and `pvz-perf.wasm.gz` about 2.7 MB, so no response buffers a
 *   whole file. `content-length` comes from `stat` so the page can show load
 *   progress.
 * - `.wasm.gz` is served as `application/gzip` with NO `content-encoding`. The
 *   build fetches the compressed bytes itself and inflates them through
 *   `DecompressionStream`; adding a content-encoding would make the browser
 *   decompress first, and the game's own inflate step would then fail.
 * - Every response is `cache-control: no-store`: the local build can be
 *   replaced in place, and a cached script mixed with a new wasm would break.
 * - When the build is absent, `GET /pvz-perf/game/**` answers 200 with an
 *   embedded HTML help page instead of a blank error, so the iframe shows the
 *   player where the files belong.
 * - Security: the route is read-only and never follows a path outside the
 *   resolved build directory. `gameRelativePath` rejects percent-encoded
 *   traversal, backslashes, absolute paths, NULs and `..` segments, and the
 *   resolved target is checked again with `path.relative`. Directory requests
 *   are 404s (no listings). Failures are answered with a status, never thrown
 *   out of the route.
 *
 * Node builtins only (`node:fs`, `node:fs/promises`, `node:os`, `node:path`);
 * there is no config schema and no runtime dependency.
 *
 * @module dsh-plugin-pvz-perf
 */

import fs from 'node:fs'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Loader id: same string as the package name and the browser bundle id. */
export const name = 'dsh-plugin-pvz-perf'
/** The composition services this plugin needs at activation. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. The browser half hardcodes the same value. */
export const ROUTE = '/pvz-perf'
/** Game asset subtree below the prefix; the iframe loads `${GAME_PREFIX}/`. */
export const GAME_PREFIX = '/pvz-perf/game'

/**
 * Directory suffixes tried under every drive root and under the user profile.
 * First existing complete build wins; the list is ordered from most likely.
 */
export const CANDIDATE_SUFFIXES = [
  path.join('Games', 'pvz_perf_web'),
  path.join('Games', 'pvz_perf'),
  path.join('Downloads', 'pvz_perf_web'),
  path.join('Downloads', 'pvz_perf'),
  'pvz_perf_web',
  'pvz_perf',
]

/** The status endpoint, always answered with JSON. */
const STATUS_PATH = ROUTE + '/status'
/** The build's entry page, also what the bare `/game` and `/game/` serve. */
const INDEX_FILE = 'index.html'
/** The manifest that proves a directory is a pvz_perf web build. */
const MANIFEST_FILE = 'web-build-manifest.json'
/** At least one of these scripts must be present next to the manifest. */
const ENTRY_SCRIPTS = ['launcher.js', 'pvz-perf.js']
/** Drive letters searched by default, mirroring the game's own install habits. */
const DRIVE_LETTERS = ['C', 'D', 'E', 'F', 'G', 'H']
/** Methods the game route and the status route answer. */
const ALLOWED_METHODS = 'GET, HEAD'

/** Content type per lower-case file extension; anything else is octet-stream. */
const MIME_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['map', 'application/json; charset=utf-8'],
  ['webmanifest', 'application/manifest+json'],
  ['wasm', 'application/wasm'],
  ['gz', 'application/gzip'],
  ['data', 'application/octet-stream'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['ico', 'image/x-icon'],
  ['txt', 'text/plain; charset=utf-8'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
  ['ttf', 'font/ttf'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
])

/** Machine-readable reason returned with an unsuccessful status. */
const MISSING_HINT = '没有找到 pvz_perf 网页版：把 web 构建目录（含 index.html 与 web-build-manifest.json）'
  + '放到 E:\\Games\\pvz_perf_web，或设置环境变量 DSH_PVZ_GAME_DIR 指向它，然后重试。'

/**
 * The page the game route serves while no build can be found, so an iframe that
 * was already pointed at `/pvz-perf/game/` explains the situation instead of
 * showing a blank error. Chinese first (the game's own audience), English last.
 */
const HELP_HTML = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pvz_perf · 未找到游戏文件</title>
<style>
  body { margin: 0; padding: 32px; font: 14px/1.7 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #101418; color: #e7edf3; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  p { margin: 8px 0; }
  code { font-family: ui-monospace, Consolas, monospace; background: #1b222b; padding: 1px 5px; border-radius: 6px; }
  pre { font-family: ui-monospace, Consolas, monospace; background: #1b222b; padding: 12px 14px;
    border-radius: 8px; overflow-x: auto; }
  ul { margin: 8px 0; padding-left: 22px; }
  .muted { color: #93a3b4; }
  a { color: #7fb6ff; }
</style>
<body>
<main>
<h1>未找到 pvz_perf 网页版</h1>
<p class="muted">The local pvz_perf web build was not found, so the game cannot start.</p>
<p>插件不打包也不下载游戏资源，只从本机目录原样转发文件。请先准备 pvz_perf 的<b>网页构建</b>
（v3.3.x；目录里必须有 <code>index.html</code>、<code>web-build-manifest.json</code>，
以及 <code>launcher.js</code> 或 <code>pvz-perf.js</code>）。</p>
<h2>1. 放到约定目录</h2>
<pre>C:\\Users\\&lt;你&gt;\\Games\\pvz_perf_web
D:\\Games\\pvz_perf_web
E:\\Games\\pvz_perf_web
%USERPROFILE%\\Downloads\\pvz_perf_web</pre>
<p>插件会依次检查 C:–H: 盘符下的 <code>Games\\pvz_perf_web</code>、<code>Games\\pvz_perf</code>、
<code>Downloads\\pvz_perf_web</code>，以及用户主目录下的同名目录。</p>
<h2>2. 或用环境变量指定</h2>
<p>启动 Harness 前设置（改完需要重启 Harness）：</p>
<pre>setx DSH_PVZ_GAME_DIR "E:\\Games\\pvz_perf_web"</pre>
<p>也可以设置 <code>PVZ_PERF_WEB_DIR</code>，但它的优先级低于 <code>DSH_PVZ_GAME_DIR</code>。</p>
<h2>3. 检查</h2>
<p>状态接口 <a href="${ROUTE}/status">${ROUTE}/status</a> 应返回 <code>ok: true</code> 和构建版本号；
然后回到面板点「重新检查」即可。</p>
<p class="muted">English: place the pvz_perf web build (v3.3.x, containing <code>index.html</code> and
<code>web-build-manifest.json</code>) under <code>E:\\Games\\pvz_perf_web</code>, or point
<code>DSH_PVZ_GAME_DIR</code> at its directory, then restart the harness and retry.</p>
</main>
</body>
</html>
`

/**
 * Whether a path currently exists and is a regular file. Never throws.
 * @param {string} filePath - an absolute path.
 * @returns {boolean} true for an existing file.
 */
function isFileSync(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * The user-profile root candidates hang off. `env` wins so tests and unusual
 * hosts can override it; the real process environment is only consulted when a
 * caller passes no env at all.
 * @param {object} env - a process-env-like object.
 * @returns {string} an absolute directory, or '' when there is none.
 */
function profileRoot(env) {
  for (const key of ['USERPROFILE', 'HOME']) {
    const value = typeof env[key] === 'string' ? env[key].trim() : ''
    if (value !== '') return value
  }
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/**
 * The candidate build directories searched when the caller does not name its own:
 * every drive root C:–H: and the user profile, each crossed with
 * {@link CANDIDATE_SUFFIXES}.
 * @param {object} env - the env the profile root is read from.
 * @returns {string[]} absolute candidate directories, most likely first.
 */
function defaultCandidates(env) {
  const roots = []
  if (process.platform === 'win32') {
    for (const letter of DRIVE_LETTERS) roots.push(letter + ':\\')
  } else {
    roots.push(path.parse(process.cwd()).root)
  }
  const profile = profileRoot(env)
  if (profile !== '') roots.push(profile)
  const candidates = []
  for (const root of roots) {
    for (const suffix of CANDIDATE_SUFFIXES) candidates.push(path.join(root, suffix))
  }
  return candidates
}

/**
 * Read `web-build-manifest.json` from one hypothetical build directory.
 *
 * The manifest is metadata only (version, source commit, backend); a missing or
 * malformed file yields null instead of throwing, because the game itself still
 * boots from `index.html` alone and this helper must never break activation.
 * @param {string} gameDir - the directory to read from.
 * @returns {{ version: string, sourceCommit: string, backend: string } | null}
 *   manifest fields on success; `''` stands for an absent field.
 */
export function readManifest(gameDir) {
  try {
    const raw = fs.readFileSync(path.join(String(gameDir), MANIFEST_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const text = (value) => (typeof value === 'string' ? value : '')
    return {
      version: text(parsed.version),
      // The build writes snake_case; accept camelCase too for hand-made folders.
      sourceCommit: text(parsed.source_commit) || text(parsed.sourceCommit),
      backend: text(parsed.backend),
    }
  } catch {
    return null
  }
}

/**
 * Whether a directory looks like a pvz_perf web build.
 *
 * The check is deliberately structural and synchronous: `index.html` and
 * `web-build-manifest.json` must be files, and at least one entry script must be
 * present. Nothing inside the files is parsed here.
 * @param {string} dir - the directory to test.
 * @returns {boolean} true only for a complete-enough build layout.
 */
export function isGameDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const root = path.resolve(dir.trim())
  if (isFileSync(path.join(root, INDEX_FILE)) !== true) return false
  if (isFileSync(path.join(root, MANIFEST_FILE)) !== true) return false
  return ENTRY_SCRIPTS.some((script) => isFileSync(path.join(root, script)) === true)
}

/**
 * Find the local pvz_perf web build to serve.
 *
 * Search order: `DSH_PVZ_GAME_DIR`, `PVZ_PERF_WEB_DIR`, then each candidate.
 * Invalid entries are skipped rather than fatal, so one stale env var cannot
 * hide a build sitting in the default location. Pick the first valid build.
 * @param {{ env?: object, candidates?: string[] }} [options] - `env` defaults to
 *   `process.env`; `candidates` defaults to
 *   {@link defaultCandidates the drive/profile scan}.
 * @returns {{ dir: string, version: string, sourceCommit: string } | null}
 *   the resolved build, or null when none was found.
 */
export function resolveGameDir(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const env = settings.env !== null && typeof settings.env === 'object' ? settings.env : process.env
  const wanted = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed !== '') wanted.push(trimmed)
  }
  push(env.DSH_PVZ_GAME_DIR)
  push(env.PVZ_PERF_WEB_DIR)
  const candidates = Array.isArray(settings.candidates) ? settings.candidates : defaultCandidates(env)
  for (const candidate of candidates) push(candidate)
  for (const candidate of wanted) {
    if (isGameDir(candidate) !== true) continue
    const dir = path.resolve(candidate)
    const manifest = readManifest(dir)
    return {
      dir,
      version: manifest === null ? '' : manifest.version,
      sourceCommit: manifest === null ? '' : manifest.sourceCommit,
    }
  }
  return null
}

// -----------------------------------------------------------------------------
// Toolkit lineup import
// -----------------------------------------------------------------------------
//
// The web build's "自定义存档 → 布阵与关卡" tab stores user lineups in the
// game origin's localStorage key `pvz_custom_lineups` (array of `{ name, code }`,
// Toolkit code format). The standalone PvZ Toolkit keeps its own lineup list in
// `setups.yml` next to its executable and auto-loads it at start. This half only
// finds and parses that read-only file; the browser half merges the codes into
// the game's list (same origin), so a bulk import does not need 339 manual pastes.

/** Directory-name prefix used by the standalone PvZ Toolkit releases. */
const TOOLKIT_DIR_PATTERN = /^pvz[_-]?toolkit/i
/** The lineup file the Toolkit auto-loads from its own directory. */
const TOOLKIT_SETUPS_FILE = 'setups.yml'
/** Shape the web build accepts after URL-safe normalisation and padding. */
const TOOLKIT_CODE_PATTERN = /^[A-Za-z0-9+/]{16,164}={0,2}$/

/**
 * Parse a Toolkit `setups.yml` lineup list.
 *
 * The file is the Toolkit's documented YAML subset: one `"name": CODE` line per
 * lineup, comments starting with `#`, other lines ignored. Codes are normalised
 * the same way the game's own `decodeLineup` does (URL-safe characters back to
 * Base64, padding restored) so the imported list is directly loadable.
 * @param {string} text - the file contents.
 * @returns {{ lineups: Array<{ name: string, code: string }>, skipped: number }}
 *   parsed lineups in file order plus the count of lines that did not qualify.
 */
export function parseToolkitSetups(text) {
  const lineups = []
  const seen = new Set()
  let skipped = 0
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^"((?:[^"\\]|\\.)*)"\s*:\s*([A-Za-z0-9+/=_-]{16,220})$/.exec(line)
    if (match === null) {
      skipped += 1
      continue
    }
    const name = match[1].replace(/\\(["\\])/g, '$1').trim().slice(0, 60)
    let code = match[2].replace(/-/g, '+').replace(/_/g, '/')
    if (code.length % 4 !== 0) code += '='.repeat(4 - (code.length % 4))
    if (name === '' || TOOLKIT_CODE_PATTERN.test(code) !== true || seen.has(code) === true) {
      skipped += 1
      continue
    }
    seen.add(code)
    lineups.push({ name, code })
  }
  return { lineups, skipped }
}

/**
 * Find the Toolkits's `setups.yml` on this machine, read-only.
 *
 * Resolution order: `DSH_PVZ_TOOLKIT_DIR` / `PVZ_TOOLKIT_DIR` (a Toolkit folder,
 * or a direct `.yml` path), then directories named like `PvZ_Toolkit*` under the
 * game folder's parent, then every drive's `Games` folder and the user's Games
 * folder. The first file that parses into at least one lineup wins.
 * @param {{ gameDir?: string, env?: object, roots?: string[] }} [options] -
 *   `env` defaults to `process.env`; `roots` overrides the search roots (tests).
 * @returns {{ dir: string, file: string, lineups: Array<{ name: string, code: string }>, skipped: number, version: string } | null}
 *   the parsed list, or null when no Toolkit lineups exist.
 */
export function findToolkitSetups(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const env = settings.env !== null && typeof settings.env === 'object' ? settings.env : process.env
  const files = []
  const seenFiles = new Set()
  /**
   * @param {string} value - a Toolkit directory or a `.yml`/`.yaml` file path.
   */
  const pushCandidate = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    let resolved
    try {
      resolved = path.resolve(value.trim())
    } catch {
      return
    }
    const lower = resolved.toLowerCase()
    const file = lower.endsWith('.yml') || lower.endsWith('.yaml') ? resolved : path.join(resolved, TOOLKIT_SETUPS_FILE)
    if (seenFiles.has(file) !== true) {
      seenFiles.add(file)
      files.push(file)
    }
  }
  for (const key of ['DSH_PVZ_TOOLKIT_DIR', 'PVZ_TOOLKIT_DIR']) pushCandidate(env[key])
  const roots = Array.isArray(settings.roots) ? settings.roots.filter((root) => typeof root === 'string' && root.trim() !== '') : []
  if (roots.length === 0) {
    const gameDir = typeof settings.gameDir === 'string' ? settings.gameDir.trim() : ''
    if (gameDir !== '') roots.push(path.dirname(path.resolve(gameDir)))
    if (process.platform === 'win32') {
      for (const letter of DRIVE_LETTERS) roots.push(letter + ':\\Games')
    }
    const profile = profileRoot(env)
    if (profile !== '') roots.push(path.join(profile, 'Games'))
  }
  for (const root of roots) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true || TOOLKIT_DIR_PATTERN.test(entry.name) !== true) continue
      pushCandidate(path.join(root, entry.name))
    }
  }
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = parseToolkitSetups(text)
      if (parsed.lineups.length === 0) continue
      const stat = fs.statSync(file)
      return {
        dir: path.dirname(file),
        file,
        lineups: parsed.lineups,
        skipped: parsed.skipped,
        version: parsed.lineups.length + ':' + Math.round(stat.mtimeMs),
      }
    } catch {
      /* unreadable candidate: try the next one */
    }
  }
  return null
}

/** Payload the browser half fetches before importing. */
export const TOOLKIT_ROUTE = ROUTE + '/toolkit/lineups'

/** Hint returned while no Toolkit lineups were found. */
const TOOLKIT_MISSING_HINT = '没有找到 PvZ Toolkit 的阵型文件：找一个含 setups.yml 的 PvZ_Toolkit 目录'
  + '（如 E:\\Games\\PvZ_Toolkit_v1.22.0），或设置 DSH_PVZ_TOOLKIT_DIR 指向它，然后重试。'

/**
 * Build the read-only HTTP handler for the Toolkit lineup list.
 *
 * Always answers 200 JSON so the browser half can distinguish "no Toolkit" from
 * a transport failure; the parsed file is re-read at most once every few seconds
 * so adding lineups in the Toolkit and pressing refresh shows up without a
 * plugin restart.
 * @param {{ resolve?: () => (object | null) }} [options] - the resolver.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   the route handler.
 */
export function createToolkitHandler(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const resolve = typeof settings.resolve === 'function' ? settings.resolve : () => null
  let cached = null
  let cachedAt = 0
  return async function toolkitRoute(req, res) {
    try {
      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'pvz-perf: GET only', { allow: 'GET, HEAD' })
        return
      }
      const now = Date.now()
      if (cached === null || now - cachedAt > 5000) {
        try {
          cached = await Promise.resolve().then(() => resolve())
        } catch {
          cached = null
        }
        cachedAt = now
      }
      const payload = cached === null
        ? { ok: false, file: null, count: 0, skipped: 0, version: null, lineups: [], hint: TOOLKIT_MISSING_HINT }
        : {
            ok: true,
            file: cached.file,
            count: cached.lineups.length,
            skipped: typeof cached.skipped === 'number' ? cached.skipped : 0,
            version: typeof cached.version === 'string' ? cached.version : '',
            lineups: cached.lineups,
            hint: '',
          }
      sendJson(res, 200, payload, method === 'HEAD')
    } catch (error) {
      try {
        sendText(res, 500, 'pvz-perf: ' + (error instanceof Error ? error.message : String(error)))
      } catch {
        /* the response is already gone */
      }
    }
  }
}

/**
 * The content type one file path is served as.
 *
 * Compound `.wasm.gz` is matched before the extension lookup so the compressed
 * wasm stream is not mistaken for `application/wasm`. The fallback is
 * `application/octet-stream` (which is also what the game's `.data` bundle is).
 * @param {string} filePath - a path or file name; both separators are accepted.
 * @returns {string} an HTTP content type.
 */
export function mimeTypeFor(filePath) {
  const name = typeof filePath === 'string' ? filePath.toLowerCase() : ''
  if (name.endsWith('.wasm.gz')) return 'application/gzip'
  const slashAt = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const dotAt = name.lastIndexOf('.')
  const extension = dotAt > slashAt ? name.slice(dotAt + 1) : ''
  const type = MIME_TYPES.get(extension)
  return type === undefined ? 'application/octet-stream' : type
}

/**
 * Validate one decoded relative path and normalize its separators.
 *
 * Empty segments and `.` are dropped; anything that could address a parent,
 * another drive/stream or a different file-system namespace is rejected. The
 * caller still re-checks the resolved absolute path, so this is one of two
 * independent guards.
 * @param {string} relative - the path portion after the route prefix.
 * @returns {string | null} a safe forward-slash relative path, or null.
 */
function safeRelativePath(relative) {
  if (relative === '') return ''
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return null // malformed percent escape
  }
  if (decoded === '') return ''
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null // NUL and other control bytes
  if (decoded.includes('\\')) return null // backslashes are path separators on Windows
  if (decoded.includes(':')) return null // drive letters and NTFS alternate data streams
  if (decoded.startsWith('/')) return null // absolute path
  const segments = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Map a request pathname below `/pvz-perf/game` to a safe relative asset path.
 *
 * The empty string means the game root (served as `index.html`). Both the full
 * pathname form (`/pvz-perf/game/index.html`) and the already-relative form
 * (`index.html`) are accepted, so the helper is convenient to test on its own.
 * Returns null for anything unsafe: encoded traversal, `..` segments,
 * backslashes, absolute paths, NULs and paths outside the game subtree.
 * @param {string} urlPathname - the URL pathname, with or without `/pvz-perf/game`.
 * @returns {string | null} the safe relative path; `''` for the game root.
 */
export function gameRelativePath(urlPathname) {
  if (typeof urlPathname !== 'string') return null
  let raw = urlPathname
  const queryAt = raw.search(/[?#]/)
  if (queryAt !== -1) raw = raw.slice(0, queryAt)
  if (raw === '') raw = '/'
  if (raw === GAME_PREFIX || raw === GAME_PREFIX + '/') return ''
  let relative
  if (raw.startsWith(GAME_PREFIX + '/')) {
    relative = raw.slice(GAME_PREFIX.length + 1)
  } else if (raw.startsWith(GAME_PREFIX)) {
    return null // /pvz-perf/game-extra is not the game subtree
  } else if (raw.startsWith('/')) {
    return null // absolute path outside the game subtree
  } else {
    relative = raw // relative path, accepted for direct helper use
  }
  return safeRelativePath(relative)
}

/**
 * Resolve `relativePath` below `root` and prove the result stays inside it.
 * @param {string} root - the absolute build directory.
 * @param {string} relativePath - a path already validated by `gameRelativePath`.
 * @returns {string | null} the absolute target, or null when it escapes.
 */
function resolveInside(root, relativePath) {
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(absoluteRoot, relativePath)
  const inside = path.relative(absoluteRoot, target)
  if (inside === '') return target
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) return null
  return target
}

/**
 * Write a plain-text response. `content-length` and `no-store` are always set.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {string} message - the body.
 * @param {object} [extraHeaders] - additional headers to merge in.
 * @param {boolean} [headOnly] - send headers only.
 */
function sendText(res, status, message, extraHeaders = {}, headOnly = false) {
  const bytes = Buffer.from(String(message), 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  if (headOnly === true) {
    res.end()
    return
  }
  res.end(bytes)
}

/**
 * Write an HTML response (the embedded help page). `no-store` and `nosniff` are
 * always set so a stale copy can never shadow a freshly found build.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {string} html - the page.
 * @param {boolean} headOnly - send headers only.
 */
function sendHtml(res, html, headOnly) {
  const bytes = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (headOnly === true) {
    res.end()
    return
  }
  res.end(bytes)
}

/**
 * Write a JSON response. `content-length` comes from the encoded payload.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {object} body - a JSON-safe body.
 * @param {boolean} headOnly - send headers only.
 */
function sendJson(res, status, body, headOnly) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  if (headOnly === true) {
    res.end()
    return
  }
  res.end(bytes)
}

/**
 * Extract the request pathname, dropping any query string or fragment.
 * @param {string | undefined} url - `req.url`.
 * @returns {string} the pathname, at least '/'.
 */
function requestPathname(url) {
  const raw = typeof url === 'string' && url !== '' ? url : '/'
  const end = raw.search(/[?#]/)
  if (end === -1) return raw
  const pathname = raw.slice(0, end)
  return pathname === '' ? '/' : pathname
}

/**
 * Coerce whatever a resolver returned into the handler's small, safe shape.
 * @param {unknown} value - the resolver's return value.
 * @returns {{ dir: string, version: string, sourceCommit: string } | null}
 *   a normalized build, or null when the value is not usable.
 */
function normalizeResolved(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.dir !== 'string' || value.dir === '') return null
  return {
    dir: value.dir,
    version: typeof value.version === 'string' ? value.version : '',
    sourceCommit: typeof value.sourceCommit === 'string' ? value.sourceCommit : '',
  }
}

/**
 * Pipe one file into the response without ever holding it in memory.
 *
 * Resolves when the response is finished or the client went away; a read error
 * after the headers are out can only destroy the connection (the browser sees a
 * truncated body instead of a clean 500), which is the correct signal for a
 * build that changed while it was being served.
 * @param {string} target - the absolute file to stream.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @returns {Promise<void>} resolves once the response or the stream ended.
 */
function streamFile(target, res) {
  const stream = fs.createReadStream(target)
  return new Promise((resolve) => {
    let settled = false
    const finish = (error) => {
      if (settled === true) return
      settled = true
      if (error !== undefined) {
        if (res.headersSent !== true) {
          try {
            sendText(res, 500, 'pvz-perf: 读取游戏文件失败')
          } catch {
            /* the response is already gone */
          }
        } else {
          res.destroy()
        }
      }
      resolve()
    }
    stream.on('error', (error) => finish(error))
    res.on('close', () => {
      stream.destroy()
      finish()
    })
    res.on('finish', () => finish())
    stream.pipe(res)
  })
}

/**
 * Answer the status endpoint: always 200 JSON, never 404.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {string} method - the already upper-cased request method.
 * @param {{ dir: string, version: string, sourceCommit: string } | null} game - the resolved build.
 */
function sendStatus(res, method, game) {
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(res, 405, 'pvz-perf: GET only', { allow: ALLOWED_METHODS })
    return
  }
  const payload = game === null
    ? {
        ok: false,
        dir: null,
        version: null,
        sourceCommit: null,
        gameUrl: GAME_PREFIX + '/',
        hint: MISSING_HINT,
      }
    : {
        ok: true,
        dir: game.dir,
        version: game.version,
        sourceCommit: game.sourceCommit,
        gameUrl: GAME_PREFIX + '/',
        hint: '',
      }
  sendJson(res, 200, payload, method === 'HEAD')
}

/**
 * Answer one GET/HEAD request below the game prefix.
 *
 * Order of decisions matters: a missing build wins over a missing file (the
 * help page is more useful than a 404), then traversal is a 400, then a missing
 * or non-file target is a 404, and everything else streams.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {string} method - the already upper-cased request method.
 * @param {string} pathname - the request pathname.
 * @param {{ dir: string, version: string, sourceCommit: string } | null} game - the resolved build.
 * @returns {Promise<void>} resolves when the response is done.
 */
async function sendGame(req, res, method, pathname, game) {
  if (game === null) {
    sendHtml(res, HELP_HTML, method === 'HEAD')
    return
  }
  const relative = gameRelativePath(pathname)
  if (relative === null) {
    sendText(res, 400, 'pvz-perf: unsafe game path')
    return
  }
  const name = relative === '' ? INDEX_FILE : relative
  const target = resolveInside(game.dir, name)
  if (target === null) {
    sendText(res, 400, 'pvz-perf: path escapes the game directory')
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    sendText(res, 404, 'pvz-perf: game file not found')
    return
  }
  if (info.isFile() !== true) {
    sendText(res, 404, 'pvz-perf: not a file')
    return
  }
  res.writeHead(200, {
    'content-type': mimeTypeFor(name),
    'content-length': String(info.size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  await streamFile(target, res)
}

/**
 * Build the HTTP handler for the plugin's whole route prefix.
 *
 * The handler re-resolves the build lazily: while no build is found every
 * request retries the search (so dropping files into a folder and pressing
 * 「重新检查」 just works), and once a build is found it is cached until the
 * plugin restarts. The returned function never rejects: every failure becomes a
 * 400/404/405/500 response, so a broken request cannot take the web server down.
 * @param {{ resolve?: () => ({ dir: string, version?: string, sourceCommit?: string } | null) }} [options]
 *   `resolve` returns the build to serve, or null while the game is absent.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   an async route handler.
 */
export function createGameHandler(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const resolve = typeof settings.resolve === 'function' ? settings.resolve : () => null
  let cached = null
  let pending = null

  const resolveGame = async () => {
    if (cached !== null) return cached
    if (pending === null) {
      pending = Promise.resolve()
        .then(() => resolve())
        .then((value) => {
          cached = normalizeResolved(value)
          return cached
        })
        .catch(() => null) // a throwing resolver is a missing build, never a crash
        .finally(() => {
          pending = null
        })
    }
    return pending
  }

  return async function gameRoute(req, res) {
    try {
      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
      const pathname = requestPathname(req?.url)
      if (pathname === STATUS_PATH) {
        const game = await resolveGame()
        sendStatus(res, method, game)
        return
      }
      if (pathname === GAME_PREFIX || pathname.startsWith(GAME_PREFIX + '/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'pvz-perf: method not allowed', { allow: ALLOWED_METHODS })
          return
        }
        const game = await resolveGame()
        await sendGame(req, res, method, pathname, game)
        return
      }
      sendText(res, 404, 'pvz-perf: not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        if (res.headersSent === true) res.destroy()
        else sendText(res, 500, 'pvz-perf: ' + message)
      } catch {
        /* the response is already gone; nothing left to say */
      }
    }
  }
}

/**
 * Host plugin entry: log what was found and register the one route.
 *
 * Activation must survive a missing game, so the resolution and even the log
 * call are defensive. The handler resolves again on demand, which means a build
 * that appears after activation is picked up without restarting the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  let resolved = null
  try {
    resolved = resolveGameDir()
  } catch {
    resolved = null
  }
  const log = (level, line) => {
    try {
      const logger = ctx?.logger
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, line)
    } catch {
      /* logging must never break activation */
    }
  }
  if (resolved === null) {
    log('warn', 'pvz-perf: 没有找到 pvz_perf 网页版；路由会返回安装说明'
      + '（把构建放到 E:\\Games\\pvz_perf_web，或设置 DSH_PVZ_GAME_DIR）')
  } else {
    const version = resolved.version === '' ? '版本未知' : resolved.version
    log('info', 'pvz-perf: 游戏目录 ' + resolved.dir + '（版本 ' + version + '）')
  }
  const handler = createGameHandler({ resolve: () => resolveGameDir() })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'pvz-perf: game route',
  )
  // Read-only Toolkit lineup list for the browser half's bulk import. Resolution
  // stays lazy: a Toolkit installed/moved after activation is picked up on the
  // next request, and the handler re-reads the file at most every few seconds.
  const toolkitHandler = createToolkitHandler({
    resolve: () => {
      const game = resolveGameDir()
      return findToolkitSetups({ gameDir: game === null ? '' : game.dir })
    },
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: TOOLKIT_ROUTE, handler: toolkitHandler }),
    'pvz-perf: toolkit lineups route',
  )
}
