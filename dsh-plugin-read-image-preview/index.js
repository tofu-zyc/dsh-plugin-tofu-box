/**
 * Host half of the read_image preview plugin.
 *
 * `read_image` hands the model a normalized copy of a local file, and a browser
 * slot view has no filesystem privileges of its own, so the bytes have to come
 * back over the page's own transport. This half reads the file through the
 * composed `fs` service, validates the container by magic bytes, and publishes
 * it on two plugin-private loopback routes:
 *
 * - `GET /read-image-preview/resolve?path=…&cwd=…` — resolve one tool-supplied
 *   path and answer with a JSON-safe description plus a capability URL;
 * - `GET /read-image-preview/<token>` — the bytes themselves, for `<img src>`.
 *
 * Only the four bitmap containers are served, and the sniffed media type — not
 * the file extension — is what goes out in `Content-Type`, so a file that
 * happens to be SVG or HTML can never be negotiated as script. A URL carries an
 * opaque token rather than a path, so the page never hands the host an arbitrary
 * path to read back.
 *
 * Both routes are plain HTTP on the plugin's own prefix; nothing is published
 * into the Cordis service namespace, so a sibling plugin cannot collide with it.
 *
 * The second half of this plugin is a screenshot workspace, which is why the
 * file also owns a directory, a subprocess, and a timer:
 *
 * - `POST /read-image-preview/capture` grabs the desktop (every monitor) and
 *   answers with the PNG, so the browser can crop and annotate it;
 * - `POST /read-image-preview/save` writes an annotated PNG into the screenshot
 *   directory and answers with its path plus a capability URL;
 * - `GET /read-image-preview/list`, `POST /read-image-preview/delete`, and
 *   `POST /read-image-preview/cleanup` drive the 截图 page and the retention
 *   policy, which also runs on a timer so the directory stays bounded.
 *
 * Everything the browser may reach goes through the composition's `connection`
 * trust check first (`requestRejection`), because these routes write files and
 * start a screen grab; the two read-only image routes keep their token-only
 * authorization. Grabs land in the OS temp directory and are unlinked as soon
 * as they are read back.
 *
 * @module dsh-plugin-read-image-preview
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Route prefix owned by this plugin. */
const ROUTE = '/read-image-preview'
/** Refuse to buffer an image larger than this, mirroring the read tool's own bound. */
const MAX_BYTES = 268435456
/** Header window large enough for a JPEG's leading segments and every other header. */
const HEAD_BYTES = 65536
/** Tokens are cheap; a card's worth of history is all anyone re-requests. */
const MAX_TOKENS = 256
/** An annotated multi-monitor grab is a few MB; this bounds what a save may carry. */
const MAX_SAVE_BYTES = 64 * 1024 * 1024
/**
 * A grab command that has not produced a file by now is treated as hung. The
 * Windows fallback path compiles its P/Invoke helper, which alone can take the
 * better part of that window on an old shell.
 */
const CAPTURE_TIMEOUT_MS = 30000
/** Where a grab lands before it is read back and unlinked. */
const CAPTURE_DIRNAME = 'dsh-read-image-preview'
/** The first request answers this many of the newest shots; the page loads more on demand. */
const LIST_PAGE = 60

/** Screenshot workspace settings. Every field is live without a restart. */
export const Config = z.object({
  /** Directory holding saved shots. Empty means `<dsh home>/screenshots`. */
  screenshotDir: z.string().default('').volatile(),
  /** Drop a shot once it is older than this many days; 0 turns age pruning off. */
  retentionDays: z.number().step(1).min(0).default(7).volatile(),
  /** Keep at most this many shots, newest first. */
  retentionMaxFiles: z.number().step(1).min(1).default(300).volatile(),
  /** Keep at most this many megabytes of shots, newest first. */
  retentionMaxMb: z.number().step(1).min(1).default(500).volatile(),
  /** How often the retention policy runs by itself. */
  cleanupIntervalMinutes: z.number().step(1).min(5).default(360).volatile(),
  /** Delay a grab waits by default, so the target window can be raised first. */
  captureDelaySeconds: z.number().step(1).min(0).max(60).default(0).volatile(),
})

/** Read one Config field whether it arrived as a live ref or as a plain value. */
function setting(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const read = value.get()
    return read === undefined || read === null ? fallback : read
  }
  return value === undefined || value === null ? fallback : value
}

const tokens = new Map()
let issued = 0

/**
 * Identify the container from its leading bytes.
 * @param {Uint8Array} bytes - the file's first bytes.
 * @returns {string | null} the exact media type, or null for anything else.
 */
function sniff(bytes) {
  if (bytes.length >= 4 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp'
  return null
}

/**
 * Read the pixel dimensions out of the container header alone.
 *
 * The card sizes its loading placeholder to the real aspect ratio and prints the
 * true size, both before the image itself has loaded, so this runs on the same
 * header window as the sniff and never touches the whole file.
 * @param {Uint8Array} bytes - the header window.
 * @param {string} mediaType - the container already identified by {@link sniff}.
 * @returns {{ width: number, height: number } | null} dimensions, or null when the header does not carry them.
 */
function dimensionsOf(bytes, mediaType) {
  try {
    if (bytes.length < 24) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (mediaType === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) }
    if (mediaType === 'image/gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    if (mediaType === 'image/webp') {
      // Only the extended (VP8X) form states a canvas size in the header.
      if (bytes.length >= 30 && bytes[15] === 86) {
        return { width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 }
      }
      return null
    }
    if (mediaType === 'image/jpeg') {
      let at = 2
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 255) {
          at += 1
          continue
        }
        const marker = bytes[at + 1]
        // Fill bytes and the standalone markers carry no length word.
        if (marker === 255) {
          at += 1
          continue
        }
        if (marker >= 208 && marker <= 215) {
          at += 2
          continue
        }
        if (marker === 217 || marker === 218) return null
        const length = view.getUint16(at + 2)
        if (length < 2) return null
        // Any SOFn frame header states the size; the arithmetic-coded forms do not.
        if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
          return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
        }
        at += 2 + length
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Mint or reuse the capability token for one resolved image.
 *
 * The same path asked for twice yields one token, so a re-render cannot grow the
 * registry; the oldest entry is evicted past the cap.
 * @param {string} path - the path as the tool received it.
 * @param {string} cwd - the session workspace root used to resolve it.
 * @param {string} mediaType - the sniffed container.
 * @param {number} size - the file's byte length.
 * @returns {string} the capability token.
 */
function issue(path, cwd, mediaType, size) {
  for (const [token, entry] of tokens) {
    if (entry.path === path && entry.cwd === cwd && entry.mediaType === mediaType) return token
  }
  const token = Math.floor(Math.random() * 4294967296).toString(36)
    + Math.floor(Date.now()).toString(36)
    + (issued++).toString(36)
  tokens.set(token, { path, cwd, mediaType, size })
  if (tokens.size > MAX_TOKENS) {
    const oldest = tokens.keys().next()
    if (oldest.done !== true) tokens.delete(oldest.value)
  }
  return token
}

/**
 * Read one query value from a request URL.
 * @param {string} url - the request URL.
 * @param {string} name - the parameter to read.
 * @returns {string} the decoded value, or the empty string when absent.
 */
function queryOf(url, name) {
  const queryAt = url.indexOf('?')
  if (queryAt === -1) return ''
  for (const pair of url.slice(queryAt + 1).split('&')) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    if (pair.slice(0, at) !== name) continue
    try {
      return decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '))
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {object} body - a JSON-safe body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/**
 * Write a short plain-text response.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {string} message - the body.
 */
function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/** The DSH home the screenshot directory hangs off, matching the host's own layout. */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * The directory saved shots live in.
 *
 * A configured path wins, `~` expands, and a relative path hangs off the DSH
 * home so that a bare `my-shots` never depends on which directory the host was
 * started from.
 * @param {object} config - the live plugin config.
 * @returns {string} an absolute directory.
 */
function shotsDirOf(config) {
  const raw = String(setting(config?.screenshotDir, '')).trim()
  if (raw === '') return path.join(dshHome(), 'screenshots')
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(os.homedir(), raw.slice(1))
    : raw
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(dshHome(), expanded)
}

/**
 * The live retention policy, with the byte cap converted out of megabytes.
 * @param {object} config - the live plugin config.
 * @returns {{ days: number, maxFiles: number, maxBytes: number }} the policy.
 */
function policyOf(config) {
  return {
    days: Number(setting(config?.retentionDays, 7)),
    maxFiles: Number(setting(config?.retentionMaxFiles, 300)),
    maxBytes: Number(setting(config?.retentionMaxMb, 500)) * 1024 * 1024,
  }
}

/**
 * Decide which shots the retention policy drops.
 *
 * Age goes first — a shot past its deadline leaves regardless of how much room
 * is left — then the newest-first count cap, then the newest-first byte cap.
 * @param {Array<{ name: string, bytes: number, mtime: number }>} entries - every shot, any order.
 * @param {{ days: number, maxFiles: number, maxBytes: number, now?: number }} policy - the caps to enforce.
 * @returns {{ kept: Array<{ name: string, bytes: number }>, removed: string[] }} the survivors and the doomed names.
 */
export function planCleanup(entries, policy) {
  const now = typeof policy.now === 'number' ? policy.now : Date.now()
  // A zero-day policy has no deadline at all, so nothing fails on age alone.
  const deadline = policy.days > 0 ? now - policy.days * 86400000 : 0
  const byAge = entries.slice().sort((a, b) => b.mtime - a.mtime)
  const kept = []
  const removed = []
  for (const entry of byAge) {
    if (entry.mtime < deadline) removed.push(entry.name)
    else kept.push({ name: entry.name, bytes: entry.bytes })
  }
  while (kept.length > policy.maxFiles) removed.push(kept.pop().name)
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0)
  while (kept.length > 0 && total > policy.maxBytes) {
    total -= kept.pop().bytes
  }
  removed.sort()
  return { kept, removed }
}

/** A shot name only ever produced by this plugin: `shot-<stamp>-<random>.png`. */
function shotName(now) {
  const stamp = new Date(now)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const at = stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate())
    + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + pad(stamp.getMilliseconds(), 3)
  return 'shot-' + at + '-' + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0') + '.png'
}

/** Whether a client-supplied string is one of this plugin's own shot file names. */
function isShotName(name) {
  return /^shot-[0-9]{8}-[0-9]{9}-[0-9a-z]{2}\.png$/.test(name)
}

/**
 * Read a request body with a hard ceiling.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @param {number} limit - the largest accepted body.
 * @returns {Promise<Buffer>} the body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体超过 ' + limit + ' 字节'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The PowerShell a Windows grab runs, with `target` spliced in as a literal.
 *
 * The process is made per-monitor DPI aware before any screen metric is read: a
 * plain capture under a scaling factor reports a virtualized, too-small desktop
 * and the bitmap comes back resampled (1600×1000 for a 3200×2000 screen at 200%).
 * `Application.SetHighDpiMode` does that with managed calls in about half a
 * second; the P/Invoke form behind it is kept for a shell whose framework is too
 * old to carry the type, and costs about twenty seconds of C# compilation there.
 * @param {string} target - the absolute file to write.
 * @returns {string} the script text.
 */
export function windowsCaptureScript(target) {
  const literal = target.replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'try {',
    '  [void][System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2)',
    '} catch {',
    '  Add-Type \'using System; using System.Runtime.InteropServices; '
      + 'public static class DshDpi { '
      + '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); '
      + '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'',
    '  [void][DshDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))',
    '  [void][DshDpi]::SetProcessDPIAware()',
    '}',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    'try {',
    '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '  try { $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size) }',
    '  finally { $graphics.Dispose() }',
    "  $bitmap.Save('" + literal + "', [System.Drawing.Imaging.ImageFormat]::Png)",
    '} finally { $bitmap.Dispose() }',
  ].join('\n')
}

/**
 * The grab commands to try, in order, for one platform.
 *
 * Windows goes through PowerShell because it is the one capture path present on
 * every install and the only one that can raise DPI awareness first; the other
 * platforms name the grabbers that exist there, tried until one produces a file.
 * @param {string} platform - `process.platform`.
 * @param {string} target - the absolute file the grabber must write.
 * @returns {Array<{ file: string, args: string[], note: string }>} candidate commands.
 */
export function captureCommands(platform, target) {
  if (platform === 'win32') {
    const args = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    const script = windowsCaptureScript(target)
    const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
      ? process.env.SystemRoot
      : 'C:\\Windows'
    return [
      { file: 'pwsh', args: args(script), note: 'PowerShell 7' },
      { file: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: args(script), note: 'Windows PowerShell' },
    ]
  }
  if (platform === 'darwin') {
    return [{ file: '/usr/sbin/screencapture', args: ['-x', '-t', 'png', target], note: 'screencapture（主显示器）' }]
  }
  return [
    { file: 'grim', args: [target], note: 'grim (Wayland)' },
    { file: 'gnome-screenshot', args: ['-f', target], note: 'gnome-screenshot' },
    { file: 'spectacle', args: ['-b', '-n', '-o', target], note: 'spectacle' },
    { file: 'scrot', args: ['--overwrite', target], note: 'scrot' },
    { file: 'import', args: ['-window', 'root', 'png:' + target], note: 'ImageMagick import (X11)' },
  ]
}

/**
 * Run one command to completion.
 * @param {string} file - the executable.
 * @param {string[]} args - its arguments.
 * @param {number} timeoutMs - the deadline after which the child is killed.
 * @returns {Promise<{ ok: boolean, message: string }>} success, or the reason it failed.
 */
function runCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null || error === undefined) {
          resolve({ ok: true, message: '' })
          return
        }
        const detail = String(stderr || stdout || error.message || '').trim().split('\n').slice(-3).join(' / ')
        resolve({ ok: false, message: (error.code === 'ENOENT' ? '没有这个命令: ' + file : detail || file + ' 执行失败') })
      })
  })
}

/**
 * Grab the desktop with the first command that works.
 * @param {string} platform - `process.platform`.
 * @param {{ timeoutMs?: number, log?: (line: string) => void }} options - overrides for the grab.
 * @returns {Promise<{ bytes: Buffer, mediaType: string }>} the captured PNG.
 */
export async function grabDesktop(platform, options = {}) {
  const dir = path.join(os.tmpdir(), CAPTURE_DIRNAME)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'grab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.png')
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : CAPTURE_TIMEOUT_MS
  const reasons = []
  try {
    for (const command of captureCommands(platform, target)) {
      const ran = await runCommand(command.file, command.args, timeoutMs)
      if (ran.ok !== true) {
        reasons.push(command.note + ': ' + ran.message)
        continue
      }
      let info
      try {
        info = await fs.stat(target)
      } catch {
        reasons.push(command.note + ': 没有写出截图文件')
        continue
      }
      if (info.size <= 0) {
        reasons.push(command.note + ': 截图文件是空的')
        continue
      }
      const bytes = await fs.readFile(target)
      if (sniff(bytes) !== 'image/png') {
        reasons.push(command.note + ': 输出的不是 PNG')
        continue
      }
      return { bytes, mediaType: 'image/png' }
    }
  } finally {
    fs.unlink(target).catch(() => {})
  }
  throw new Error('抓屏失败（' + platform + '）：' + reasons.join('；'))
}

/**
 * Host plugin: publish the resolve endpoint and the image route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - the live plugin config.
 */
export function apply(ctx, config) {
  /** Resolve one query-supplied path into a JSON-safe description. */
  const resolve = async (req, res) => {
    try {
      const url = typeof req.url === 'string' ? req.url : ''
      const raw = queryOf(url, 'path')
      if (raw.trim() === '') {
        sendJson(res, 400, { ok: false, error: 'no path supplied' })
        return
      }
      const cwd = queryOf(url, 'cwd')
      const target = await ctx.fs.resolve(raw, cwd === '' ? undefined : { cwd })
      const info = await ctx.fs.stat(target)
      if (info === undefined) {
        sendJson(res, 200, { ok: false, error: 'file not found: ' + raw })
        return
      }
      if (info.type !== 'file') {
        sendJson(res, 200, { ok: false, error: 'not a regular file: ' + raw })
        return
      }
      const head = await ctx.fs.readByteRange(target, { offset: 0, length: HEAD_BYTES })
      const mediaType = sniff(head)
      if (mediaType === null) {
        sendJson(res, 200, { ok: false, error: 'not a PNG/JPEG/WebP/GIF image' })
        return
      }
      const size = typeof info.size === 'number' ? info.size : 0
      const dimensions = dimensionsOf(head, mediaType)
      sendJson(res, 200, {
        ok: true,
        mediaType,
        bytes: size,
        url: ROUTE + '/' + issue(raw, cwd, mediaType, size),
        width: dimensions === null ? null : dimensions.width,
        height: dimensions === null ? null : dimensions.height,
        displayPath: typeof target.displayPath === 'string' ? target.displayPath : raw,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: message })
    }
  }

  /** Serve the bytes one issued token stands for. */
  const serve = async (req, res) => {
    try {
      const url = typeof req.url === 'string' ? req.url : ''
      const queryAt = url.indexOf('?')
      const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
      const token = pathname.slice(ROUTE.length + 1)
      const entry = token === '' ? undefined : tokens.get(token)
      if (entry === undefined) {
        sendText(res, 404, 'unknown image token')
        return
      }
      const target = await ctx.fs.resolve(entry.path, entry.cwd === '' ? undefined : { cwd: entry.cwd })
      const info = await ctx.fs.stat(target)
      if (info === undefined || info.type !== 'file') {
        sendText(res, 404, 'image is gone')
        return
      }
      const size = typeof info.size === 'number' ? info.size : entry.size
      res.writeHead(200, {
        'content-type': entry.mediaType,
        'content-length': String(size),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const bytes = await ctx.fs.readBytes(target, undefined, MAX_BYTES)
      res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        sendText(res, 500, 'image read failed: ' + message)
      } catch {
        /* the response is already gone; nothing left to say */
      }
    }
  }

  /**
   * The trust check every screenshot route runs first.
   *
   * These routes write files and start a screen grab, so they are gated by the
   * composition's own Host/Origin and authentication fence rather than by an
   * opaque token; a deployment without that service gets a refusal instead of
   * an unguarded writer. The two read-only image routes keep their existing
   * token-only authorization.
   * @param {import('node:http').IncomingMessage} req - the request to test.
   * @param {import('node:http').ServerResponse} res - the response to own on refusal.
   * @returns {boolean} true when the request was answered and must go no further.
   */
  const refuse = (req, res) => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      sendJson(res, 503, { ok: false, error: '当前部署没有 connection 服务，截图保存/抓屏已停用' })
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return true
  }

  /** Answer 405 unless the request carries the one method this route owns. */
  const wrongMethod = (req, res, method) => {
    if (req.method === method) return false
    res.writeHead(405, { allow: method, 'content-type': 'text/plain; charset=utf-8' })
    res.end(method + ' only')
    return true
  }

  /** The media type one saved shot serves as, or null when it is not a served container. */
  const shotMediaType = (name) => {
    const at = name.lastIndexOf('.')
    const extension = at === -1 ? '' : name.slice(at + 1).toLowerCase()
    if (extension === 'png') return 'image/png'
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
    if (extension === 'gif') return 'image/gif'
    if (extension === 'webp') return 'image/webp'
    return null
  }

  /**
   * Every shot file in the directory, newest first.
   *
   * A file that disappears between the listing and its stat is simply absent
   * from the answer; nothing else an entry says is trusted beyond its own stat.
   */
  const listShots = async (dir) => {
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const entries = []
    for (const name of names) {
      if (name.startsWith('.') || shotMediaType(name) === null) continue
      try {
        const info = await fs.stat(path.join(dir, name))
        if (info.isFile() === true) entries.push({ name, bytes: info.size, mtime: info.mtimeMs })
      } catch {
        /* it went away mid-listing */
      }
    }
    return entries.sort((a, b) => b.mtime - a.mtime)
  }

  /** Drop what the retention policy rejects, and report what that cost. */
  const runCleanup = async (reason) => {
    const dir = shotsDirOf(config)
    const policy = policyOf(config)
    const entries = await listShots(dir)
    const plan = planCleanup(entries.filter((entry) => isShotName(entry.name)), { ...policy, now: Date.now() })
    let freed = 0
    let failed = 0
    for (const name of plan.removed) {
      try {
        await fs.unlink(path.join(dir, name))
        freed += entries.find((entry) => entry.name === name)?.bytes ?? 0
      } catch {
        failed += 1
      }
    }
    if (plan.removed.length > 0 || failed > 0) {
      ctx.logger.info('read-image-preview: 清理截图（' + reason + '）删除 ' + (plan.removed.length - failed)
        + ' 个 / ' + formatBytes(freed) + '，保留 ' + plan.kept.length + ' 个')
    }
    return { removed: plan.removed.length - failed, failed, kept: plan.kept.length, freed }
  }

  /** Everything the 截图 page shows besides the list itself. */
  const state = (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'GET') === true) return
    const dir = shotsDirOf(config)
    const policy = policyOf(config)
    sendJson(res, 200, {
      ok: true,
      dir,
      platform: process.platform,
      policy,
      delaySeconds: Number(setting(config?.captureDelaySeconds, 0)),
      // Names this platform will try, shown when a grab has to explain itself.
      capture: captureCommands(process.platform, 'x.png').map((command) => command.note),
    })
  }

  /** The shot listing, newest first, with a capability URL per thumbnail. */
  const shots = async (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'GET') === true) return
    try {
      const url = typeof req.url === 'string' ? req.url : ''
      const limit = Math.max(1, Math.min(300, Number(queryOf(url, 'limit')) || LIST_PAGE))
      const offset = Math.max(0, Number(queryOf(url, 'offset')) || 0)
      const dir = shotsDirOf(config)
      const entries = await listShots(dir)
      const page = entries.slice(offset, offset + limit).map((entry) => ({
        name: entry.name,
        bytes: entry.bytes,
        mtime: entry.mtime,
        url: ROUTE + '/' + issue(entry.name, dir, shotMediaType(entry.name), entry.bytes),
      }))
      sendJson(res, 200, {
        ok: true, dir, total: entries.length, offset,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        items: page,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Write one annotated PNG into the screenshot directory. */
  const save = async (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'POST') === true) return
    try {
      const body = await readBody(req, MAX_SAVE_BYTES)
      const mediaType = sniff(body)
      if (mediaType !== 'image/png') {
        sendJson(res, 400, { ok: false, error: '只接受 PNG 图片内容' })
        return
      }
      const dir = shotsDirOf(config)
      await fs.mkdir(dir, { recursive: true })
      const name = shotName(Date.now())
      const target = path.join(dir, name)
      await fs.writeFile(target, body, { flag: 'wx' })
      sendJson(res, 200, {
        ok: true, name, path: target, dir, bytes: body.length,
        url: ROUTE + '/' + issue(name, dir, mediaType, body.length),
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Remove one named shot. Only a plain file name inside the shot directory reaches disk. */
  const remove = async (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'POST') === true) return
    try {
      const url = typeof req.url === 'string' ? req.url : ''
      const name = queryOf(url, 'name')
      if (name === '' || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
        sendJson(res, 400, { ok: false, error: '不是合法的截图文件名' })
        return
      }
      await fs.unlink(path.join(shotsDirOf(config), name))
      sendJson(res, 200, { ok: true, name })
    } catch (error) {
      const missing = error instanceof Error && error.code === 'ENOENT'
      sendJson(res, missing ? 404 : 500, {
        ok: false, error: missing ? '截图已经不在了' : (error instanceof Error ? error.message : String(error)),
      })
    }
  }

  /** Run the retention policy now, on request. */
  const cleanup = async (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'POST') === true) return
    try {
      sendJson(res, 200, { ok: true, ...(await runCleanup('手动')) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Grab the desktop and answer with the PNG, after the requested settle delay. */
  const capture = async (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'POST') === true) return
    try {
      const url = typeof req.url === 'string' ? req.url : ''
      const asked = Number(queryOf(url, 'delay'))
      const delay = Number.isFinite(asked) ? Math.max(0, Math.min(60000, asked))
        : Math.max(0, Math.min(60, Number(setting(config?.captureDelaySeconds, 0)))) * 1000
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const started = Date.now()
      const { bytes, mediaType } = await grabDesktop(process.platform)
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
      ctx.logger.info('read-image-preview: 抓屏 ' + bytes.length + ' 字节，用时 ' + (Date.now() - started) + 'ms')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('read-image-preview: ' + message.slice(0, 300))
      sendJson(res, 500, { ok: false, error: message })
    }
  }

  /** Reveal the screenshot directory in the platform's file manager. */
  const open = (req, res) => {
    if (refuse(req, res) === true || wrongMethod(req, res, 'POST') === true) return
    const dir = shotsDirOf(config)
    fs.mkdir(dir, { recursive: true }).then(() => {
      const launcher = process.platform === 'win32'
        ? { file: 'explorer.exe', args: [dir] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [dir] }
          : { file: 'xdg-open', args: [dir] }
      const child = spawn(launcher.file, launcher.args, { detached: true, stdio: 'ignore' })
      child.unref()
      sendJson(res, 200, { ok: true, dir })
    }, (error) => {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE + '/resolve', handler: resolve }),
    'read-image-preview: resolve endpoint',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: serve }),
    'read-image-preview: image route',
  )
  for (const [name, handler] of [
    ['state', state], ['list', shots], ['save', save],
    ['delete', remove], ['cleanup', cleanup], ['capture', capture], ['open', open],
  ]) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: ROUTE + '/' + name, handler }),
      'read-image-preview: ' + name + ' endpoint',
    )
  }

  // Retention runs by itself: once shortly after activation, then on a heartbeat
  // that re-reads its period, so changing cleanupIntervalMinutes needs no restart.
  const heartbeatMs = 5 * 60 * 1000
  let nextRun = Date.now() + 8000
  const first = setTimeout(() => {
    runCleanup('启动').catch((error) => {
      ctx.logger.warn('read-image-preview: 启动清理失败 ' + (error instanceof Error ? error.message : String(error)))
    })
  }, 8000)
  const heartbeat = setInterval(() => {
    const now = Date.now()
    if (now < nextRun) return
    const minutes = Math.max(5, Number(setting(config?.cleanupIntervalMinutes, 360)))
    nextRun = now + minutes * 60 * 1000
    runCleanup('定时').catch(() => { /* the next heartbeat tries again */ })
  }, heartbeatMs)
  // Neither timer may be the last thing holding the host open: retention is a
  // housekeeping job, and a host that wants to exit is not waiting on it.
  first.unref()
  heartbeat.unref()
  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(heartbeat)
  }, 'read-image-preview: retention timers')
}

/** Render a byte count at reading size, for the log line the cleanup writes. */
function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
