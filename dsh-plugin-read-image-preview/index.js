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
 * @module dsh-plugin-read-image-preview
 */

/** Route prefix owned by this plugin. */
const ROUTE = '/read-image-preview'
/** Refuse to buffer an image larger than this, mirroring the read tool's own bound. */
const MAX_BYTES = 268435456
/** Header window large enough for a JPEG's leading segments and every other header. */
const HEAD_BYTES = 65536
/** Tokens are cheap; a card's worth of history is all anyone re-requests. */
const MAX_TOKENS = 64

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

/**
 * Host plugin: publish the resolve endpoint and the image route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
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

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE + '/resolve', handler: resolve }),
    'read-image-preview: resolve endpoint',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: serve }),
    'read-image-preview: image route',
  )
}
