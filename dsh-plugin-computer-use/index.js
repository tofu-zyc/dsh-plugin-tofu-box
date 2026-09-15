/**
 * computer-use — let the model see the desktop and drive apps, on any OS.
 *
 * v2 rewires the whole backend onto the Cua Driver SDK (@trycua/cua-driver):
 * a Rust in-process computer-use runtime loaded directly into the dsh host.
 * No daemon, no MCP server, no PowerShell scripts — `pnpm` pulls one native
 * package per OS/arch and the tools just work (Windows tested; the same code
 * path drives the macOS / Linux natives).
 *
 * v2.2 fixes the two things that made v2 unusable on a real Windows desktop:
 *
 * - **DPI bootstrap.** The driver's whole Windows backend measures screens,
 *   captures pixels and maps coordinates through GetSystemMetrics/
 *   GetWindowRect — APIs that return DPI-VIRTUALIZED values unless the host
 *   process declared Per-Monitor-V2 awareness (upstream assumes the daemon
 *   exe; an in-process SDK inherits the HOST, and node.exe is unaware). On a
 *   200%-scaled primary the driver then captured only the top-left quarter of
 *   the display and every desktop coordinate was off by the scale factor.
 *   The plugin now flips the process to Per-Monitor-V2 via a tiny FFI call
 *   (koffi, prebuilt binaries, no compiler) BEFORE the driver runtime is
 *   created — after that the driver's own numbers are correct
 *   (`get_desktop_state` returns the true 3200x2000 @2x, not a crop).
 * - **Session lifecycle.** The driver's implicit session dies after 5 min of
 *   idle and ended names are never revived by ordinary actions — every call
 *   then failed with "session has ended" until the process restarted. The
 *   plugin now runs one named session (`dsh-computer-use`) that it starts at
 *   boot, passes explicitly on every call that accepts it, and revives with
 *   `start_session` + one retry whenever the driver reports `session_ended`.
 *
 * The driver's native paradigm is window-centric and background-first, so the
 * tool surface speaks it now:
 *
 * - **Element-first.** `computer_screenshot(app=…)` returns the window's
 *   screenshot AND its accessibility tree (indexed elements with tokens);
 *   `computer_click(element=token)` invokes through UIA/AX — works on
 *   backgrounded, minimized and even off-desktop windows.
 * - **No focus stealing.** Every action defaults to `delivery_mode:
 *   "background"`: PostMessage/UIA routes that never raise the window or move
 *   the human's cursor. When a target genuinely drops posted input (some
 *   Chromium/Electron surfaces), the plugin retries the same action with
 *   `delivery_mode: "foreground"` once — the driver restores the previous
 *   foreground afterwards.
 * - **Keyboard-first still.** Descriptions keep pushing `computer_open` /
 *   `computer_key` / `computer_sequence` over pixel hunts.
 *
 * Coordinates are pixels of the latest screenshot of the SAME target: window
 * actions use window-local px of the last window capture; desktop-scope
 * actions use px of the last `computer_screenshot` (primary display).
 *
 * Screenshots ride to the model as attachment images —
 * `dsh-plugin-read-image-preview` renders them with its generic image card;
 * nothing here ships a client half.
 *
 * @module dsh-plugin-computer-use
 */

import zlib from 'node:zlib'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'computer-use'
export const inject = ['tools', 'attachments']

export const Config = z.object({
  /** Model-visible frame long-edge cap, in px. */
  maxDim: z.natural().min(320).max(3840),
  /** Settle time between the gesture and the result screenshot. */
  settleMs: z.natural().max(5000),
  /** 'once-per-agent': the first mutating call asks, later ones run; 'never': no own gate. */
  askPolicy: z.union([z.const('once-per-agent'), z.const('always'), z.const('never')]),
  /** Content-free product telemetry of the bundled Cua Driver runtime. */
  telemetry: z.boolean(),
  /** Windows: switch the host process to Per-Monitor-V2 DPI awareness before the
   * driver starts (strongly recommended; set false only if some other component
   * already owns process DPI awareness and you must not touch it). */
  dpiAware: z.boolean(),
})

// ─────────────────────────────────────────────────────────────────────────────
// Minimal PNG codec (decode → RGBA, box resize, crop, encode). Screenshots
// arrive as 8-bit RGB/RGBA PNGs; the driver never downscales desktop captures,
// so the model-frame cap is enforced here. No native or third-party deps.
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Decode an 8-bit non-interlaced RGB/RGBA PNG into `{ width, height, data }` (RGBA). Exported for the self-test. */
export function pngDecode(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let off = 8
  let ihdr = null
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG without IHDR')
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.color !== 2 && ihdr.color !== 6)) {
    throw new Error('unsupported PNG (color=' + ihdr.color + ' depth=' + ihdr.depth + ' interlace=' + ihdr.interlace + ')')
  }
  const ch = ihdr.color === 6 ? 4 : 3
  const stride = ihdr.w * ch
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(ihdr.w * ihdr.h * 4)
  let pos = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[pos++]
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    if (filter === 1) { for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 0xff }
    else if (filter === 2) { for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff }
    else if (filter === 3) { for (let i = 0; i < stride; i++) line[i] = (line[i] + (((i < ch ? 0 : line[i - ch]) + prev[i]) >> 1)) & 0xff }
    else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i < ch ? 0 : line[i - ch]
        const b = prev[i]
        const c = i < ch ? 0 : prev[i - ch]
        const p = a + b - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    } else if (filter !== 0) throw new Error('bad PNG filter ' + filter)
    for (let x = 0; x < ihdr.w; x++) {
      const si = x * ch
      const di = (y * ihdr.w + x) * 4
      out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2]
      out[di + 3] = ch === 4 ? line[si + 3] : 255
    }
    prev = line
  }
  return { width: ihdr.w, height: ihdr.h, data: out }
}

/** Encode RGBA as a filter-0 PNG. Exported for the self-test. */
export function pngEncode(img) {
  const { width, height, data } = img
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
    const td = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([td, body])))
    return Buffer.concat([len, td, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    data.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Box-average resize of an RGBA image. Exported for the self-test. */
export function resizeRgba(img, tw, th) {
  const { width, height, data } = img
  const out = Buffer.alloc(tw * th * 4)
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * height) / th)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * width) / tw)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw))
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++
        }
      }
      const o = (ty * tw + tx) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return { width: tw, height: th, data: out }
}

/** Crop an RGBA image (bounds clamped). Exported for the self-test. */
export function cropRgba(img, x, y, w, h) {
  const cx = Math.max(0, Math.min(x, img.width - 1))
  const cy = Math.max(0, Math.min(y, img.height - 1))
  const cw = Math.max(1, Math.min(w, img.width - cx))
  const chh = Math.max(1, Math.min(h, img.height - cy))
  const out = Buffer.alloc(cw * chh * 4)
  for (let row = 0; row < chh; row++) {
    img.data.copy(out, row * cw * 4, ((cy + row) * img.width + cx) * 4, ((cy + row) * img.width + cx + cw) * 4)
  }
  return { width: cw, height: chh, data: out }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ maxDim?: number, settleMs?: number, askPolicy?: string, telemetry?: boolean }} [config]
 */
export function apply(ctx, config) {
  const maxDim = config && config.maxDim !== undefined ? config.maxDim : 1568
  const settleMs = config && config.settleMs !== undefined ? config.settleMs : 600
  const askPolicy = config && config.askPolicy === 'always' ? 'always' : config && config.askPolicy === 'never' ? 'never' : 'once-per-agent'
  const telemetry = !!(config && config.telemetry === true)
  const dpiAwareCfg = !(config && config.dpiAware === false)
  if (!telemetry) process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'

  // ── DPI bootstrap (Windows) ────────────────────────────────────────────────
  // The driver assumes a Per-Monitor-V2-aware host (its daemon exe ships that
  // manifest; upstream capture/input code comments say so outright). The
  // in-process SDK instead inherits THIS process — and node.exe is DPI-unaware.
  // Every screen metric the driver reads is then DPI-virtualized while BitBlt
  // and SendInput still work in physical pixels: on a 200%-scaled primary the
  // desktop capture silently covers only the top-left quarter of the display
  // and all desktop coordinates drift by the scale factor. Flip the process
  // BEFORE the driver runtime creates its worker threads (threads inherit the
  // process context at creation); afterwards every driver number is physical.
  /** { text, aware } — filled during the first getDriver() chain. */
  const dpiState = { text: 'pending', aware: false }
  const ensureProcessDpiAware = async () => {
    if (process.platform !== 'win32') { dpiState.text = 'n/a (not Windows)'; dpiState.aware = true; return }
    if (!dpiAwareCfg) { dpiState.text = 'skipped (dpiAware: false)'; dpiState.aware = false; return }
    try {
      const m = await import('koffi')
      const koffi = m.default && m.default.load ? m.default : m
      const user32 = koffi.load('user32.dll')
      let shcore = null
      try { shcore = koffi.load('shcore.dll') } catch {}
      // PROCESS_DPI_AWARENESS: 0 unaware, 1 system, 2 per-monitor; NULL handle = this process.
      const query = () => {
        if (!shcore) return -1
        try {
          const getProc = shcore.func('int32_t GetProcessDpiAwareness(void*, int32_t*)')
          const out = koffi.alloc('int32_t', 1)
          if (getProc(null, out) !== 0) return -1
          return koffi.decode(out, 'int32_t')
        } catch { return -1 }
      }
      let now = query()
      if (now !== 2) {
        try { user32.func('bool SetProcessDpiAwarenessContext(intptr_t)')(-4) } catch {} // PER_MONITOR_AWARE_V2
        now = query()
        if (now === 0 || now === -1) {
          try { user32.func('bool SetProcessDPIAware()')() } catch {}
          now = query()
        }
      }
      dpiState.aware = now >= 1
      dpiState.text = now === 2
        ? 'per-monitor-v2'
        : now === 1
          ? 'system-DPI-aware (fallback: metrics are physical, mixed-scale window captures may stretch)'
          : now === 0
            ? 'UNAWARE (runtime switch refused — HiDPI captures/coordinates are unreliable)'
            : 'unknown (shcore query unsupported)'
    } catch (e) {
      dpiState.aware = false
      dpiState.text = 'unknown (koffi unavailable: ' + (e && e.message ? e.message : e) + ')'
    }
  }

  // ── named driver session ───────────────────────────────────────────────────
  // The implicit session the runtime creates for a transport is private and,
  // once it ends (5-minute idle TTL / explicit end), ordinary calls against it
  // fail forever: “this session has ended; call start_session explicitly”.
  // A public label survives that: start_session revives it and is idempotent,
  // so the plugin tags every session-capable call with it and self-heals on
  // `session_ended`. (`session` is not sticky server-side — repeat it.)
  const SESSION_LABEL = 'dsh-computer-use'
  const SESSION_TOOLS = new Set(['get_desktop_state', 'get_window_state', 'click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'scroll', 'set_value', 'move_cursor', 'get_cursor_position'])
  const isSessionEnded = (r) => r.errorCode === 'session_ended' || /session has ended|call start_session/i.test(String((r && r.text) ?? ''))

  /** Lazily-created in-process Cua Driver runtime (one per profile process). */
  let driver = null
  let driverPromise = null
  let driverDead = false
  const getDriver = () => {
    if (driver) return Promise.resolve(driver)
    if (driverDead) throw new Error('Cua Driver runtime was shut down; restart dsh to reactivate computer-use')
    if (!driverPromise) {
      driverPromise = ensureProcessDpiAware().then(() => {
        ctx.logger.info('computer-use: host process DPI awareness = ' + dpiState.text)
        return import('@trycua/cua-driver')
      }).then((m) => {
        const created = m.CuaDriver.create()
        driver = created
        ctx.effect(() => () => {
          driverDead = true
          driver = null
          driverPromise = null
          Promise.resolve(created.callTool('end_session', JSON.stringify({ session: SESSION_LABEL }))).catch(() => {})
          Promise.resolve(created.shutdown()).catch(() => {})
        })
        return Promise.resolve(created.callTool('start_session', JSON.stringify({ session: SESSION_LABEL })))
          .then((r) => { if (r && r.isError) ctx.logger.warn('computer-use: start_session failed: ' + String(r.text).slice(0, 160)) }, () => {})
          .then(() => created)
      }, (e) => { driverPromise = null; throw new Error('cannot load @trycua/cua-driver native runtime: ' + (e && e.message ? e.message : e)) })
    }
    return driverPromise
  }

  /** Call one driver tool by name; returns the parsed ToolResult. */
  const raw = async (tool, args) => {
    const d = await getDriver()
    let a = args ?? {}
    if (SESSION_TOOLS.has(tool) && a.session === undefined) a = { ...a, session: SESSION_LABEL }
    const json = JSON.stringify(a)
    let r = await d.callTool(tool, json)
    if (r && r.isError && isSessionEnded(r)) {
      // Idle TTL tripped: revive the label once, retry the exact call once.
      await Promise.resolve(d.callTool('start_session', JSON.stringify({ session: SESSION_LABEL }))).catch(() => {})
      r = await d.callTool(tool, json)
    }
    return r
  }
  /** Same, but throws on isError with the driver's own message. */
  const call = async (tool, args) => {
    const r = await raw(tool, args)
    if (r.isError) throw new Error(tool + ': ' + String(r.text ?? 'failed').slice(0, 400))
    return r
  }
  const structured = (r) => {
    try { return JSON.parse(r.structuredJson) } catch {}
    try { return JSON.parse(r.rawJson ?? '{}').structuredContent ?? {} } catch { return {} }
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && signal.aborted) reject(new Error('cancelled'))
      else resolve()
    }, ms)
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
    }
  })

  // ── target bookkeeping ─────────────────────────────────────────────────────
  /** Last window the model captured or acted on; lets follow-ups omit targets. */
  let last = null
  /** Desktop frame mapping (get_desktop_state may be downscaled for the model). */
  let deskFrame = null

  const windowTarget = (t) => ({ kind: 'window', pid: t.pid, window_id: t.windowId })

  /** Resolve {app|pid|window_id} args to {pid, windowId, title}. */
  const resolveWindow = async (a) => {
    if (a.app !== undefined || a.pid !== undefined) {
      let pid
      if (a.pid !== undefined) pid = Math.round(Number(a.pid))
      const w = structured(await raw('list_windows', { on_screen_only: false }))
      const wins = w.windows ?? []
      if (pid === undefined) {
        const needle = String(a.app).toLowerCase()
        const cands = wins.filter((x) => String(x.app_name ?? '').toLowerCase().includes(needle) || String(x.title ?? '').toLowerCase().includes(needle))
        if (cands.length === 0) throw new Error('no window matches app "' + a.app + '" — check computer_windows')
        pid = cands[0].pid
      }
      let mine = wins.filter((x) => x.pid === pid)
      if (mine.length === 0) throw new Error('pid ' + pid + ' has no windows — check computer_windows')
      if (a.window_id !== undefined) {
        const hit = mine.find((x) => (x.window_id ?? x.windowId) === Math.round(Number(a.window_id)))
        if (!hit) throw new Error('window_id ' + a.window_id + ' not found under pid ' + pid)
        last = { pid, windowId: hit.window_id ?? hit.windowId, title: hit.title ?? '', app: String(a.app ?? '') }
        return last
      }
      mine = mine.filter((x) => x.is_on_screen !== false)
      mine.sort((x, y) => (y.z_index ?? 0) - (x.z_index ?? 0))
      last = { pid, windowId: mine[0].window_id ?? mine[0].windowId, title: mine[0].title ?? '', app: String(a.app ?? '') }
      return last
    }
    if (last) return last
    throw new Error('no target: pass app (e.g. app="notepad") or pid/window_id, or capture first — see computer_windows')
  }

  // ── capture ────────────────────────────────────────────────────────────────
  const IMAGE_VALUE = {
    type: 'object', additionalProperties: false, required: true,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
      bytes: { type: 'integer', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
    },
  }
  const SHOT_VALUE = {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string', required: true },
      frameText: { type: 'string', required: true },
      elements: { type: 'string' },
      image: IMAGE_VALUE,
    },
  }
  const SHOT_RENDER = { schema: SHOT_VALUE, render: (_a, v) => [
    { type: 'text', text: v.summary + '\n' + v.frameText + (v.elements ? '\n\n' + v.elements : '') },
    { type: 'image', attachment: v.image },
  ] }

  const attach = async (png, name) => {
    const ref = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name })
    return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
  }

  const renderElements = (els, total) => {
    if (!els || els.length === 0) return ''
    const CAP = 80
    const lines = els.slice(0, CAP).map((e) => {
      const label = String(e.label ?? '').replace(/\s+/g, ' ').slice(0, 60)
      const acts = (e.actions ?? []).join('/')
      return e.element_index + ' ' + (e.role ?? '?') + (label ? ' "' + label + '"' : '') + (acts ? ' [' + acts + ']' : '') + ' ' + e.element_token
    })
    let out = 'ELEMENTS (element= + token; from THIS snapshot only):\n' + lines.join('\n')
    if (els.length > CAP) out += '\n… ' + (els.length - CAP) + ' more; pass query= to filter'
    else if (total > els.length) out += '\n(' + total + ' elements total; pass query= to project)'
    return out
  }

  /** Window capture → screenshot (+ optional element tree) SHOT value. */
  const captureWindow = async (t, opts) => {
    const includeTree = !(opts && opts.tree === false)
    const args = { pid: t.pid, window_id: t.windowId, include_accessibility_tree: includeTree }
    if (opts && opts.query) args.query = opts.query
    const r = await call('get_window_state', args)
    const sc = structured(r)
    const png = Buffer.from((r.images[0] && r.images[0].dataBase64) ?? '', 'base64')
    if (png.length === 0) throw new Error('window capture returned no image')
    const els = sc.elements ?? []
    if (els.length > 0) last = { ...t, tokensByIndex: Object.fromEntries(els.map((e) => [e.element_index, e.element_token])) }
    return {
      summary: (opts && opts.summary) || ('Window "' + (sc.window_title ?? t.title ?? '') + '" captured (pid ' + t.pid + ', window ' + t.windowId + ').'),
      frameText: 'Coordinates for this window = pixels of THIS image (window-local, top-left origin). Screen bounds: ' + JSON.stringify(sc.window_bounds ?? {}) + '.',
      elements: renderElements(els, sc.total_element_count ?? els.length),
      image: await attach(png, 'win.png'),
    }
  }

  /** Primary-desktop capture → SHOT value. */
  const captureDesktop = async (summary) => {
    const r = await call('get_desktop_state', {})
    const sc = structured(r)
    const png = Buffer.from((r.images[0] && r.images[0].dataBase64) ?? '', 'base64')
    if (png.length === 0) throw new Error('desktop capture returned no image')
    let img = pngDecode(png)
    const long = Math.max(img.width, img.height)
    if (long > maxDim) img = resizeRgba(img, Math.round((img.width * maxDim) / long), Math.round((img.height * maxDim) / long))
    deskFrame = { sw: sc.screen_width ?? img.width, sh: sc.screen_height ?? img.height, fw: img.width, fh: img.height }
    const scale = typeof sc.scale_factor === 'number' && sc.scale_factor > 0 ? ' @' + sc.scale_factor + 'x' : ''
    const dpiWarn = dpiState.aware ? '' : ' ⚠ host DPI awareness inactive (' + dpiState.text + ') — on scaled displays this frame may cover only part of the primary display and desktop coordinates drift; prefer window-scoped actions via app=.'
    return {
      summary: (summary ?? 'Primary display captured') + ' (' + sc.screen_width + 'x' + sc.screen_height + scale + ' px' + dpiWarn + ')',
      frameText: 'Desktop coordinate frame = pixels of THIS image (top-left origin of the PRIMARY display). Windows on OTHER monitors are NOT in this image — capture and act on them via app=/computer_windows.',
      image: await attach(pngEncode(img), 'desktop.png'),
    }
  }

  /** Frame px → driver desktop-space px. */
  const deskXY = (x, y, label) => {
    if (deskFrame === null) throw new Error('no desktop screenshot yet: call computer_screenshot first')
    if (typeof x !== 'number' || !isFinite(x) || typeof y !== 'number' || !isFinite(y)) throw new Error(label + ' must be numbers')
    if (x < 0 || y < 0 || x > deskFrame.fw || y > deskFrame.fh) throw new Error(label + ' outside the ' + deskFrame.fw + 'x' + deskFrame.fh + ' screenshot')
    return { x: Math.round((x * deskFrame.sw) / deskFrame.fw), y: Math.round((y * deskFrame.sh) / deskFrame.fh) }
  }

  // ── action plumbing ────────────────────────────────────────────────────────
  const agentsGranted = new Set()
  const agentKey = (agent) => (agent && typeof agent.id === 'string' && agent.id !== '') ? agent.id : '__no-agent__'

  // The harness approval service ('approval') owns a per-session policy: 'ask'
  // prompts, 'never' (approvals disabled / full-access mode) auto-REJECTS every
  // ask. Emitting ask there would only self-block, so when the session cannot
  // prompt we pass actions through — the user's global policy is the gate.
  const approval = ctx.get('approval')
  const sessionRefusesPrompt = (exec) => {
    const session = exec && exec.agent && exec.agent.session
    if (session === undefined || !approval || typeof approval.effectivePolicy !== 'function') return false
    try { return approval.effectivePolicy(session) === 'never' } catch { return false }
  }

  const isEscalationHint = (r) => {
    const blob = String(r.text ?? '') + String(r.rawJson ?? '')
    // XAML hotkey refusals are NOT escalatable (the UIA-accelerator route ignores
    // delivery_mode) — their guidance must reach the model verbatim instead.
    return /background_unavailable|"effect":"refused"|not accepted in the background/i.test(blob)
  }

  /**
   * Run one input call: background first; if the driver refuses the background
   * route, retry the exact same call in foreground mode (driver restores the
   * previous foreground afterwards).
   */
  const action = async (tool, base) => {
    const r = await raw(tool, base)
    if (r.isError && isEscalationHint(r)) {
      const r2 = await raw(tool, { ...base, delivery_mode: 'foreground' })
      if (r2.isError) throw new Error(tool + ': ' + String(r2.text ?? 'failed').slice(0, 400))
      r2.escalated = true
      return r2
    }
    if (r.isError) throw new Error(tool + ': ' + String(r.text ?? 'failed').slice(0, 400))
    return r
  }
  const actionNote = (r) => (r.escalated ? ' [background input was refused; re-delivered with a brief foreground swap]' : /"effect":"suspected_noop"/.test(String(r.rawJson ?? '')) ? ' [driver suspects the target ignored the input — verify on the screenshot]' : '')

  /**
   * Press one chord. XAML/WinUI/UWP targets have no hotkey route beyond a
   * discoverable UIA AcceleratorKey (hidden menu items are invisible, so
   * ctrl+something often cannot be found) — when hotkey refuses, fall back to
   * press_key with a modifiers array in FOREGROUND: a real SendInput chord the
   * target's input pipeline cannot ignore; the driver restores the previous
   * foreground after the keystrokes flush.
   */
  const pressChord = async (targetArg, mods, key) => {
    if (mods.length === 0) return await action('press_key', { ...targetArg, key })
    const r = await raw('hotkey', { ...targetArg, keys: [...mods, key] })
    if (!r.isError) return r
    // Windows gates SetForegroundWindow (foreground lock), so the first swap can
    // be refused with foreground_unavailable; the delivery attempt itself grants
    // the process foreground rights, making a quick retry usually succeed.
    let r2 = await raw('press_key', { ...targetArg, key, modifiers: mods, delivery_mode: 'foreground' })
    if (r2.isError && /foreground_unavailable/i.test(String(r2.text ?? '') + String(r2.rawJson ?? ''))) {
      await sleep(350)
      r2 = await raw('press_key', { ...targetArg, key, modifiers: mods, delivery_mode: 'foreground' })
    }
    if (r2.isError) throw new Error('hotkey ' + mods.join('+') + '+' + key + ': ' + String(r.text ?? 'failed').slice(0, 260) + ' (foreground fallback too: ' + String(r2.text ?? 'failed').slice(0, 160) + ')')
    r2.escalated = true
    return r2
  }

  // ── key vocabulary (driver names) ─────────────────────────────────────────
  const KEY_ALIAS = {
    enter: 'return', return: 'return', esc: 'escape', escape: 'escape', tab: 'tab', space: 'space',
    backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert',
    home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
    up: 'up', down: 'down', left: 'left', right: 'right',
    win: 'win', meta: 'win', cmd: 'win', super: 'win',
    ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
  }
  const keyName = (tok) => {
    const t = tok.toLowerCase()
    if (KEY_ALIAS[t]) return KEY_ALIAS[t]
    if (/^f([1-9]|1[0-2])$/.test(t)) return t
    if (/^.$/.test(t)) return t // letters, digits, simple punctuation
    return null
  }
  const parseKeys = (spec) => {
    const toks = String(spec).toLowerCase().split('+').map((t) => t.trim()).filter((t) => t !== '')
    if (toks.length === 0) throw new Error('keys must look like "ctrl+s" or "alt+F4"')
    const mods = []
    let key = null
    for (const t of toks) {
      const n = keyName(t)
      if (n === null) throw new Error('unknown key "' + t + '" (a-z, 0-9, f1-f12, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, ctrl, alt, shift, win)')
      if (n === 'ctrl' || n === 'alt' || n === 'shift' || n === 'win') mods.push(n)
      else key = n
    }
    if (key === null) throw new Error('chord needs one non-modifier key after the modifiers')
    return { mods, key }
  }

  const COORD_DESC = 'Coordinate frames: with a window target, x/y are pixels of the LAST computer_screenshot OF THAT WINDOW; desktop scope uses pixels of the last desktop screenshot.'
  const KEYB_FIRST = ' KEYBOARD-FIRST: prefer computer_open / computer_key / computer_sequence over pixel clicks whenever a keyboard path exists. ELEMENT-FIRST: if the last window screenshot listed an element for the target, click by its element= token — it works on backgrounded/minimized windows and never touches the user\'s cursor.'
  const register = (definition) => ctx.effect(() => ctx.tools.register(defineTool(definition)), 'computer-use: tool ' + definition.name)

  /** Shared action wrapper: grant, run, settle, re-capture the acted-on view. */
  const actAndShot = async (exec, grant, summary, run) => {
    grant()
    const r = await run()
    const note = actionNote(r) + (r.verification && r.verification.verified === false ? ' [driver could not verify the effect]' : '')
    await sleep(settleMs, exec.signal)
    let value
    if (r.scopeView === 'desktop') value = await captureDesktop(summary + note)
    else value = await captureWindow(r.target ?? last, { tree: false, summary: summary + note })
    return value
  }
  const granting = (exec) => { agentsGranted.add(agentKey(exec.agent)) }

  // ── tools ──────────────────────────────────────────────────────────────────
  register({
    name: 'computer_screenshot',
    description: 'Capture a WINDOW (default target: the last window acted on) or the PRIMARY desktop. A window capture returns the screenshot PLUS the accessibility tree elements (indexed, with element= tokens valid for the NEXT action against that window). Pass app="name" to target any app — including windows on other monitors, hidden, or minimized. No args = desktop overview. ' + COORD_DESC,
    parameters: {
      app: { type: 'string', description: 'App/window name to capture (substring match), e.g. "notepad", "Chrome".' },
      pid: { type: 'number', description: 'Target pid (alternative to app).' },
      window_id: { type: 'number', description: 'Exact window under pid (from computer_windows).' },
      query: { type: 'string', description: 'Project the element list to this case-insensitive substring (window captures).' },
      desktop: { type: 'boolean', description: 'true = force the primary-desktop capture.' },
      elements: { type: 'boolean', description: 'false = skip the accessibility tree (screenshot only).' },
    },
    output: SHOT_RENDER,
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(a) {
      if (a.desktop === true || (a.app === undefined && a.pid === undefined && a.window_id === undefined && last === null)) {
        return await captureDesktop()
      }
      if (a.desktop === undefined && a.app === undefined && a.pid === undefined && a.window_id === undefined) {
        return await captureWindow(last, { tree: a.elements !== false })
      }
      const t = await resolveWindow(a)
      return await captureWindow(t, { tree: a.elements !== false, query: typeof a.query === 'string' ? a.query : undefined })
    },
  })

  register({
    name: 'computer_windows',
    description: 'List all top-level windows: pid, window_id, app name, title, screen bounds, z-order, on-screen flag. Read-only. Use it to find the pid/window_id for screenshots and actions, or to see what is open on monitors the desktop screenshot does not cover.',
    parameters: {
      app: { type: 'string', description: 'Optional substring filter on app name / title.' },
      on_screen_only: { type: 'boolean', description: 'Drop off-screen/minimized windows. Default false (they are capturable!).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { table: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.table }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    async execute(a) {
      const sc = structured(await raw('list_windows', { on_screen_only: a.on_screen_only === true }))
      let wins = sc.windows ?? []
      if (a.app !== undefined) {
        const needle = String(a.app).toLowerCase()
        wins = wins.filter((x) => String(x.app_name ?? '').toLowerCase().includes(needle) || String(x.title ?? '').toLowerCase().includes(needle))
      }
      if (wins.length === 0) return { table: 'no windows matched' }
      const rows = wins.slice(0, 40).map((w) => 'pid=' + w.pid + ' win=' + (w.window_id ?? w.windowId) + (w.is_on_screen === false ? ' [off-screen]' : '') + (w.minimized ? ' [minimized]' : '') + ' z=' + (w.z_index ?? '?') + ' ' + JSON.stringify(w.app_name ?? '') + ' ' + JSON.stringify(String(w.title ?? '').slice(0, 60)) + ' ' + JSON.stringify(w.bounds ?? {}))
      return { table: rows.join('\n') + (wins.length > 40 ? '\n… ' + (wins.length - 40) + ' more (filter with app=)' : '') }
    },
  })

  register({
    name: 'computer_click',
    description: 'Click IN A TARGET WINDOW (background — your cursor and focus are untouched) or on the desktop. Addressing, best first: element=<token from the last computer_screenshot of that window>; else window-local x,y of that window screenshot (the driver UIA hit-tests first, then posts raw events); else desktop x,y for taskbar/wallpaper. button=left|right|middle, clicks=1-3, keys=modifier chord held during the click. ' + COORD_DESC,
    parameters: {
      app: { type: 'string', description: 'Target app (default: last captured window). Omit with x,y only for DESKTOP clicks.' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      element: { type: 'string', description: 'element token from the last window capture.' },
      x: { type: 'number', description: 'X px of the last screenshot of the SAME target.' },
      y: { type: 'number', description: 'Y px of the last screenshot of the SAME target.' },
      button: { type: 'string', description: 'left | right | middle. Default left.' },
      clicks: { type: 'number', description: 'Click count 1-3. Default 1.' },
      keys: { type: 'string', description: 'Optional held modifiers, e.g. "ctrl" or "ctrl+shift". Windows background clicks DROP modifiers (UIA/PostMessage carry no key state) — they land only when the click escalates to foreground.' },
      desktop: { type: 'boolean', description: 'true = click on the primary desktop at desktop-screenshot x,y (moves the real pointer).' },
      from_zoom: { type: 'boolean', description: 'true = x,y are pixels of the latest computer_zoom image of this window (the driver maps them back to window coordinates).' },
    },
    output: SHOT_RENDER,
    timeoutMs: 30000,
    async execute(a, exec) {
      const button = a.button === undefined ? 'left' : String(a.button)
      if (button !== 'left' && button !== 'right' && button !== 'middle') throw new Error('button must be left|right|middle')
      const count = a.clicks === undefined ? 1 : Math.round(Number(a.clicks))
      if (!(count >= 1 && count <= 3)) throw new Error('clicks must be 1-3')
      const modifier = a.keys === undefined ? undefined : parseKeys(a.keys).mods
      let where
      if (a.desktop === true || (a.app === undefined && a.pid === undefined && a.element === undefined && last === null)) {
        if (a.x === undefined || a.y === undefined) throw new Error('desktop click needs x,y (pixels of the last desktop screenshot)')
        const p = deskXY(Number(a.x), Number(a.y), 'click target')
        where = { target: { kind: 'desktop', display_id: 'primary' }, x: p.x, y: p.y }
      } else {
        const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : (last ?? await resolveWindow(a))
        if (typeof a.element === 'string' && a.element !== '') {
          // element_token uses the legacy addressing form: token + its (pid, window_id) scope.
          where = { pid: t.pid, window_id: t.windowId, element_token: a.element }
        } else {
          if (a.x === undefined || a.y === undefined) throw new Error('pass element= or window-local x,y (pixels of the last computer_screenshot of this window)')
          where = { target: windowTarget(t), x: Number(a.x), y: Number(a.y) }
        }
      }
      const desc = 'Clicked ' + button + (count > 1 ? ' x' + count : '') + (a.keys ? ' holding ' + a.keys : '') + (a.element ? ' on element ' + a.element : a.x !== undefined ? ' at (' + a.x + ',' + a.y + ')' : '') + '.'
      return await actAndShot(exec, () => granting(exec), desc, async () => {
        const r = await action('click', { ...where, button, count, ...(modifier ? { modifier } : {}), ...(a.from_zoom === true ? { from_zoom: true } : {}) })
        r.scopeView = where.target && where.target.kind === 'desktop' ? 'desktop' : 'window'
        return r
      })
    },
  })

  register({
    name: 'computer_drag',
    description: 'Press-drag-release in a target window (window-local px of its last screenshot) or on the desktop (desktop px, real pointer). Title-bar/resize drags cannot be posted in background — the plugin auto-escalates those to foreground. moves real windows; prefer app-internal drags on content only.',
    parameters: {
      app: { type: 'string' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      fromX: { type: 'number', required: true },
      fromY: { type: 'number', required: true },
      toX: { type: 'number', required: true },
      toY: { type: 'number', required: true },
      desktop: { type: 'boolean', description: 'true = drag on the primary desktop (coordinates from the last desktop screenshot).' },
    },
    output: SHOT_RENDER,
    timeoutMs: 30000,
    async execute(a, exec) {
      let args
      let view
      if (a.desktop === true || (a.app === undefined && a.pid === undefined && last === null)) {
        const p1 = deskXY(Number(a.fromX), Number(a.fromY), 'drag start')
        const p2 = deskXY(Number(a.toX), Number(a.toY), 'drag end')
        args = { target: { kind: 'desktop', display_id: 'primary' }, from_x: p1.x, from_y: p1.y, to_x: p2.x, to_y: p2.y }
        view = 'desktop'
      } else {
        const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : last
        args = { target: windowTarget(t), from_x: Number(a.fromX), from_y: Number(a.fromY), to_x: Number(a.toX), to_y: Number(a.toY) }
        view = 'window'
      }
      return await actAndShot(exec, () => granting(exec), 'Dragged (' + a.fromX + ',' + a.fromY + ') → (' + a.toX + ',' + a.toY + ').', async () => {
        const r = await action('drag', args)
        r.scopeView = view
        return r
      })
    },
  })

  register({
    name: 'computer_scroll',
    description: 'Scroll a target window (posted to the window — background, no pointer move). direction=up|down|left|right, amount=1-20 ticks (default 3), by=line|page (default line).',
    parameters: {
      app: { type: 'string' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      direction: { type: 'string', required: true, description: 'up | down | left | right.' },
      amount: { type: 'number', description: 'Scroll ticks 1-20. Default 3.' },
      by: { type: 'string', description: 'line | page. Default line.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 30000,
    async execute(a, exec) {
      const direction = String(a.direction)
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('direction must be up|down|left|right')
      const amount = a.amount === undefined ? 3 : Math.round(Number(a.amount))
      if (!(amount >= 1 && amount <= 20)) throw new Error('amount must be 1-20')
      const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : last
      if (!t) throw new Error('no target window: pass app= or capture first')
      return await actAndShot(exec, () => granting(exec), 'Scrolled ' + direction + ' x' + amount + ' in window.', async () =>
        await action('scroll', { target: windowTarget(t), direction, amount, ...(a.by === 'page' ? { by: 'page' } : {}) }))
    },
  })

  register({
    name: 'computer_type',
    description: 'Type text into a target window IN THE BACKGROUND (UIA SetValue for fields listed in the last capture — pass element= for reliability; XAML/Store apps require element=; classic Win32 accepts plain WM_CHAR). Pass desktop=true to type into whatever the user currently has focused instead. Newlines are NOT typed; send computer_key enter between lines.',
    parameters: {
      app: { type: 'string' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      element: { type: 'string', description: 'element token of the field (last window capture).' },
      text: { type: 'string', required: true, description: 'Text to type. Max 5000 chars.' },
      desktop: { type: 'boolean', description: 'true = type into the current foreground app (no window target).' },
    },
    output: SHOT_RENDER,
    timeoutMs: 30000,
    async execute(a, exec) {
      if (typeof a.text !== 'string' || a.text.length === 0) throw new Error('text must be a non-empty string')
      if (a.text.length > 5000) throw new Error('text too long (max 5000 chars)')
      if (a.desktop === true) {
        return await actAndShot(exec, () => granting(exec), 'Typed ' + a.text.length + ' chars into the foreground app.', async () => {
          const r = await action('type_text', { target: { kind: 'desktop', display_id: 'primary' }, text: a.text })
          r.scopeView = 'desktop'
          return r
        })
      }
      const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : last
      if (!t) throw new Error('no target window: pass app= or capture first')
      const args = typeof a.element === 'string' && a.element !== ''
        ? { pid: t.pid, window_id: t.windowId, element_token: a.element, text: a.text }
        : { target: windowTarget(t), text: a.text }
      return await actAndShot(exec, () => granting(exec), 'Typed ' + a.text.length + ' chars into window.', () => action('type_text', args))
    },
  })

  register({
    name: 'computer_key',
    description: 'Press a key or chord in a target window (background; driver picks UIA-accelerator/PostMessage/SendInput automatically), repeat 1-10. For chords on XAML/WinUI/UWP apps that hide shortcuts behind menus (e.g. Notepad ctrl+a), it auto-falls back to a real foreground SendInput chord that briefly swaps focus then restores. Names: a-z, 0-9, f1-f12, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, ctrl, alt, shift, win. desktop=true sends to the foreground app instead.',
    parameters: {
      app: { type: 'string' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      keys: { type: 'string', required: true, description: 'Plus-joined key names, e.g. "ctrl+shift+s".' },
      repeat: { type: 'number', description: 'Press the chord N times, 1-10. Default 1.' },
      desktop: { type: 'boolean', description: 'true = send to the current foreground app.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 30000,
    async execute(a, exec) {
      const { mods, key } = parseKeys(a.keys)
      const repeat = a.repeat === undefined ? 1 : Math.round(Number(a.repeat))
      if (!(repeat >= 1 && repeat <= 10)) throw new Error('repeat must be 1-10')
      let targetArg
      if (a.desktop === true) {
        targetArg = { target: { kind: 'desktop', display_id: 'primary' } }
      } else {
        const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : last
        if (!t) throw new Error('no target window: pass app= or capture first')
        targetArg = { target: windowTarget(t) }
      }
      const view = a.desktop === true ? 'desktop' : 'window'
      return await actAndShot(exec, () => granting(exec), 'Pressed ' + a.keys + (repeat > 1 ? ' x' + repeat : '') + '.', async () => {
        let r
        for (let i = 0; i < repeat; i++) {
          r = await pressChord(targetArg, mods, key)
        }
        r.scopeView = view
        return r
      })
    },
  })

  register({
    name: 'computer_open',
    description: 'Launch (or focus-resolve) an app by name without stealing your foreground — returns the app pid and its first window captured. PREFERRED over Start-menu clicking. On Windows this activates Store-packaged apps (Notepad/Calculator/Settings) correctly via AUMID.',
    parameters: {
      name: { type: 'string', required: true, description: 'App name as the OS knows it, e.g. "notepad", "微信", "Chrome". Max 100 chars.' },
      settle_seconds: { type: 'number', description: 'Extra wait for the window to materialize, 0-15. Default 2.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 45000,
    async execute(a, exec) {
      const appName = typeof a.name === 'string' ? a.name.trim() : ''
      if (appName === '' || appName.length > 100) throw new Error('name must be 1-100 chars')
      const settle = a.settle_seconds === undefined ? 2000 : Math.min(15000, Math.max(0, Number(a.settle_seconds) * 1000))
      granting(exec)
      const r = await call('launch_app', { name: appName })
      const sc = structured(r)
      const pid = sc.pid
      let win = (sc.windows ?? [])[0]
      for (let waited = 0; !win && waited < settle + 4000; waited += 400) {
        await sleep(400, exec.signal)
        const w = structured(await raw('list_windows', { pid }))
        win = (w.windows ?? [])[0]
      }
      if (!win) return await captureDesktop('Launched "' + appName + '" (pid ' + pid + ') but no window showed up — check computer_windows.')
      last = { pid, windowId: win.window_id ?? win.windowId, title: win.title ?? '', app: appName }
      return await captureWindow(last, { summary: 'Launched "' + appName + '" (pid ' + pid + ', background — foreground untouched).' })
    },
  })

  const compileStep = (rawStep) => {
    const s = String(rawStep)
    const c1 = s.indexOf(':')
    const head = (c1 === -1 ? s : s.slice(0, c1)).toLowerCase().trim()
    const rest = c1 === -1 ? '' : s.slice(c1 + 1)
    if (head === 'key') {
      const { mods, key } = parseKeys(rest)
      return { kind: 'key', mods, key }
    }
    if (head === 'type') {
      if (rest === '' || rest.length > 5000) throw new Error('type text must be 1-5000 chars')
      return { kind: 'type', text: rest }
    }
    if (head === 'wait') {
      const sec = parseFloat(rest)
      if (!isFinite(sec) || sec < 0 || sec > 15) throw new Error('wait seconds must be 0-15')
      return { kind: 'wait', ms: Math.round(sec * 1000) }
    }
    if (head === 'click') {
      let button = 'left'
      let clicks = 1
      let xy = rest
      if (rest.indexOf(':') !== -1) {
        const li = rest.lastIndexOf(':')
        xy = rest.slice(li + 1)
        rest.slice(0, li).split(':').forEach((m) => {
          if (m === 'left' || m === 'right' || m === 'middle') button = m
          else if (/^[1-3]$/.test(m)) clicks = parseInt(m, 10)
          else if (m !== '') throw new Error('click modifiers must be left|right|middle or 1-3, got "' + m + '"')
        })
      }
      const seg = xy.split(',').map((t) => t.trim())
      if (seg.length !== 2 || !isFinite(Number(seg[0])) || !isFinite(Number(seg[1]))) throw new Error('click needs "x,y" in the target window\'s last screenshot px')
      return { kind: 'click', x: Number(seg[0]), y: Number(seg[1]), button, clicks }
    }
    if (head === 'scroll') {
      const seg = rest.split(',').map((t) => t.trim())
      if (!['up', 'down', 'left', 'right'].includes(seg[0])) throw new Error('scroll direction must be up|down|left|right')
      const amt = seg[1] !== undefined && seg[1] !== '' ? Number(seg[1]) : 3
      if (!(amt >= 1 && amt <= 20)) throw new Error('scroll amount must be 1-20')
      return { kind: 'scroll', direction: seg[0], amount: amt }
    }
    if (head === 'open') {
      const appName = rest.trim()
      if (appName === '' || appName.length > 100) throw new Error('open name must be 1-100 chars')
      return { kind: 'open', name: appName }
    }
    throw new Error('unknown action "' + head + '" (use key/type/wait/click/scroll/open — for held-modifier clicks use click:ctrl not keydown)')
  }

  register({
    name: 'computer_sequence',
    description: 'Run a multi-step flow atomically in ONE call with ONE approval and ONE final screenshot (intermediate states not shown). Steps target the last window (or app= for this sequence); step DSL, one string per step: key:ctrl+s · type:任意文本 · wait:1.5 · click:x,y or click:right:2:x,y · scroll:down,5 · open:微信 (launch + retarget). All steps validate before the first input. Coordinates = px of the last screenshot of the acting window.' + KEYB_FIRST,
    parameters: {
      steps: { type: 'array', required: true, description: 'Ordered step strings, max 30 steps.', items: { type: 'string' } },
      app: { type: 'string', description: 'Optional app to retarget this sequence to first.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 90000,
    async execute(a, exec) {
      if (!Array.isArray(a.steps) || a.steps.length === 0) throw new Error('steps must be a non-empty array of step strings')
      if (a.steps.length > 30) throw new Error('max 30 steps per sequence')
      const compiled = []
      for (let i = 0; i < a.steps.length; i++) {
        try { compiled.push(compileStep(a.steps[i])) } catch (e) {
          throw new Error('step ' + (i + 1) + ' "' + String(a.steps[i]).slice(0, 60) + '": ' + e.message)
        }
      }
      granting(exec)
      if (a.app !== undefined) await resolveWindow({ app: a.app })
      let view = last ? 'window' : 'desktop'
      for (const step of compiled) {
        if (step.kind === 'wait') { await sleep(step.ms, exec.signal); continue }
        if (step.kind === 'open') {
          const r = await call('launch_app', { name: step.name })
          const sc = structured(r)
          await sleep(1200, exec.signal)
          const w = structured(await raw('list_windows', { pid: sc.pid }))
          const win = (w.windows ?? [])[0]
          if (win) { last = { pid: sc.pid, windowId: win.window_id ?? win.windowId, title: win.title ?? '', app: step.name }; view = 'window' }
          continue
        }
        if (!last) throw new Error('sequence step needs a window target (pass app= or open: first): ' + step.kind)
        const t = last
        if (step.kind === 'key') {
          await pressChord({ target: windowTarget(t) }, step.mods, step.key)
        } else if (step.kind === 'type') {
          await action('type_text', { target: windowTarget(t), text: step.text })
        } else if (step.kind === 'click') {
          await action('click', { target: windowTarget(t), x: step.x, y: step.y, button: step.button, count: step.clicks })
        } else if (step.kind === 'scroll') {
          await action('scroll', { target: windowTarget(t), direction: step.direction, amount: step.amount })
        }
      }
      await sleep(settleMs, exec.signal)
      const summary = 'Ran ' + a.steps.length + ' steps: ' + a.steps.join(' → ').slice(0, 300)
      return view === 'window' ? await captureWindow(last, { tree: false, summary }) : await captureDesktop(summary)
    },
  })

  register({
    name: 'computer_zoom',
    description: 'Zoom into a region of a WINDOW at native resolution (reads small text/icons the model frame blurs). x0,y0,x1,y1 are px of the last screenshot OF THAT WINDOW; region ≤ ~500px wide (the driver pads 20% per side). The zoom image is NOT the coordinate frame — pass from_zoom=true to computer_click to click inside it.',
    parameters: {
      app: { type: 'string' },
      pid: { type: 'number' },
      window_id: { type: 'number' },
      x0: { type: 'number', required: true },
      y0: { type: 'number', required: true },
      x1: { type: 'number', required: true, description: 'Must be > x0.' },
      y1: { type: 'number', required: true, description: 'Must be > y0.' },
    },
    output: SHOT_RENDER,
    isConcurrencySafe: () => true,
    timeoutMs: 25000,
    async execute(a) {
      const t = (a.app !== undefined || a.pid !== undefined) ? await resolveWindow(a) : last
      if (!t) throw new Error('zoom needs a window: pass app= (or capture a window first). For desktop regions just look at the desktop screenshot again.')
      const r = await call('zoom', { pid: t.pid, window_id: t.windowId, x1: Number(a.x0), y1: Number(a.y0), x2: Number(a.x1), y2: Number(a.y1) })
      const img = r.images[0]
      if (!img) throw new Error('zoom returned no image')
      const png = Buffer.from(img.dataBase64, 'base64')
      const ref = await ctx.attachments.saveImage({ data: png, mediaType: img.mimeType === 'image/png' ? 'image/png' : (img.mimeType || 'image/jpeg'), name: 'zoom.jpg' })
      return {
        summary: 'Zoomed window region (' + a.x0 + ',' + a.y0 + ')-(' + a.x1 + ',' + a.y1 + ') at native resolution.',
        frameText: 'This zoom is NOT the coordinate frame; computer_click with from_zoom=true maps clicks from THIS image back to the window.',
        image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
      }
    },
  })

  register({
    name: 'computer_cursor',
    description: 'Read the real OS cursor position (primary-desktop pixel space, same as the desktop screenshot). Window actions do not use the real cursor — they post to the target window directly.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { physical: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: 'cursor at ' + v.physical + ' (primary-desktop px; background window actions ignore the pointer)' }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    async execute() {
      const sc = structured(await call('get_cursor_position', {}))
      return { physical: sc.x + ',' + sc.y }
    },
  })

  register({
    name: 'computer_move',
    description: 'Move the REAL OS pointer on the primary desktop to (x, y) of the last desktop screenshot and leave it there (hover state for the user/foreground apps). Background window actions never move the pointer, so use this only when a FOREGROUND app needs hover. Does not click.',
    parameters: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
    },
    output: SHOT_RENDER,
    timeoutMs: 25000,
    async execute(a, exec) {
      const p = deskXY(Number(a.x), Number(a.y), 'move target')
      return await actAndShot(exec, () => granting(exec), 'Real pointer moved to desktop px (' + a.x + ',' + a.y + ').', async () => {
        const r = await call('move_cursor', { target: { kind: 'desktop', display_id: 'primary' }, x: p.x, y: p.y })
        r.scopeView = 'desktop'
        return r
      })
    },
  })

  register({
    name: 'computer_wait',
    description: 'Wait for a few seconds (animations, loading) and return a fresh screenshot of the current target (window if captured, else desktop).',
    parameters: {
      seconds: { type: 'number', required: true, description: 'Seconds to wait, 0.1-15.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 25000,
    async execute(a, exec) {
      const s = Number(a.seconds)
      if (!isFinite(s) || s < 0.1 || s > 15) throw new Error('seconds must be 0.1-15')
      await sleep(Math.round(s * 1000), exec.signal)
      return last ? await captureWindow(last, { tree: false, summary: 'Waited ' + s + 's.' }) : await captureDesktop('Waited ' + s + 's.')
    },
  })

  const MUTATING = new Set(['computer_move', 'computer_click', 'computer_drag', 'computer_scroll', 'computer_type', 'computer_key', 'computer_open', 'computer_sequence'])
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!MUTATING.has(exec.name)) return next()
    if (askPolicy === 'never') return next()
    if (askPolicy === 'once-per-agent' && agentsGranted.has(agentKey(exec.agent))) return next()
    // Full-access / approvals-disabled session: asking would be auto-rejected by
    // the approval service — honor the session's mode instead of self-blocking.
    if (sessionRefusesPrompt(exec)) return next()
    return { kind: 'ask', reason: '允许 computer-use 操作应用？一次批准覆盖同一会话的后续动作（askPolicy: always 可改为每次一询）；默认后台注入——不移动你的鼠标、不抢焦点，仅个别拒收后台输入的应用会短暂前置。首个动作: ' + exec.name + '。' }
  })

  ctx.logger.info('computer-use v2.2: cua-driver backend (session "' + SESSION_LABEL + '"); ' + MUTATING.size + ' mutating tools gated; askPolicy=' + askPolicy + '; telemetry=' + telemetry)

  // Best-effort: push the model-frame cap into the driver for window captures
  // (the driver resizes window screenshots AND keeps x,y/zoom coordinates
  // consistent with the resized image; desktop captures are resized plugin-side).
  getDriver().then((d) => d.callTool('set_config', JSON.stringify({ key: 'max_image_dimension', value: maxDim }))).then(
    () => ctx.logger.info('computer-use: max_image_dimension=' + maxDim),
    () => {},
  )
}
