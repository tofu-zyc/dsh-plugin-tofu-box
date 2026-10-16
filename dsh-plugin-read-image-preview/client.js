/**
 * Browser half of the generic image tool-preview plugin.
 *
 * One card claims the keyed presentation cell of every tool that puts a picture
 * in front of the model, at priority -1 (shadowing shipped rows and any dynamic
 * fallback cards). Two data sources feed the same interaction suite (thumbnail,
 * pixel/byte/format line, click-to-open zoom with Ctrl+wheel, drag pan,
 * double-click fit):
 *
 * - `file` mode — the call takes a `file_path` (the read family). Bytes come
 *   from the host half over `GET /read-image-preview/…`, and the card previews
 *   before the call settles. This is the original read_image behaviour.
 * - `attachment` mode — the settled result content carries `{type:'image',
 *   attachment}` blocks (computer-use screenshots today; any future image
 *   tool). Bytes come from the session-authorized `props.loadImage`, every
 *   stat rides the attachment reference, and no extra request is made.
 *
 * Adding a new image-bearing tool is one key in `TOOL_LABELS` — nothing else.
 *
 * v1.4.1: both modes carry the picture's pixel size before the bytes arrive
 * (resolve reply / attachment ref), so the img element gets width+height and
 * the metadata bar its width up front. A late-loading picture then lands with
 * zero layout delta — the fix for the chat's stick-to-bottom logic reading an
 * image-driven reflow as a reader scroll and dropping auto-follow.
 *
 * @module dsh-plugin-read-image-preview/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-read-image-preview',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** The screenshot workspace's routes, all owned by this plugin's host half. */
    const SHOT_ROUTE = '/read-image-preview'
    /** Draw tools, in toolbar order. `move` pans instead of drawing. */
    const DRAW_TOOLS = ['move', 'rect', 'ellipse', 'arrow', 'pen', 'text', 'crop']
    /** The annotation palette. Red first: it is what a callout is usually drawn in. */
    const COLORS = ['#ff2d2d', '#ffb300', '#12b76a', '#2f6fed', '#111111', '#ffffff']
    /** Stroke widths, in source-image pixels so they survive a crop or a resize. */
    const WIDTHS = [2, 4, 8]

    const CSS = `
.dsh-imgvw-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-imgvw-root ~ [class*="_root"] {
  display: none !important;
}
.dsh-imgvw-frame {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  max-width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.05));
  line-height: 0;
  cursor: zoom-in;
}
.dsh-imgvw-img {
  display: block;
  width: auto;
  height: auto;
  max-width: min(420px, 100%);
  max-height: 300px;
}
.dsh-imgvw-img[data-checker='true'] {
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.18) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.18) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.18) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.18) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.dsh-imgvw-img:hover {
  filter: brightness(1.04);
}
.dsh-imgvw-zoom {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(20, 20, 20, 0.55);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.dsh-imgvw-frame:hover .dsh-imgvw-zoom {
  opacity: 1;
}
.dsh-imgvw-skel {
  position: relative;
  width: 100%;
  min-width: 260px;
  max-width: 420px;
  min-height: 140px;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.07));
}
.dsh-imgvw-skel::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.16)) 50%,
    transparent 80%
  );
  transform: translateX(-100%);
  animation: dsh-imgvw-sweep 1.15s ease-in-out infinite;
}
.dsh-imgvw-skel-label {
  position: absolute;
  left: 12px;
  bottom: 10px;
  z-index: 1;
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
}
.dsh-imgvw-skel-label[data-bad='true'] {
  color: var(--dsw-alias-label-error, #d1495b);
}
@keyframes dsh-imgvw-sweep {
  to { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-imgvw-skel::after { animation: none; }
}
.dsh-imgvw-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.85));
}
.dsh-imgvw-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--dsw-alias-label-secondary, rgba(128, 128, 128, 0.95));
}
.dsh-imgvw-sep {
  opacity: 0.45;
}
.dsh-imgvw-stat {
  font-variant-numeric: tabular-nums;
}
.dsh-imgvw-link {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  cursor: pointer;
}
.dsh-imgvw-link:hover {
  text-decoration-color: currentColor;
  color: var(--dsw-static-deepseek-500, #4d6bfe);
}
.dsh-imgvw-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dsh-imgvw-dot[data-live='true'] {
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  animation: dsh-imgvw-pulse 1.2s ease-in-out infinite;
}
.dsh-imgvw-dot[data-bad='true'] {
  background: var(--dsw-alias-label-error, #d1495b);
}
.dsh-imgvw-dot[data-ok='true'] {
  background: var(--dsw-alias-label-success, #2f9e63);
}
@keyframes dsh-imgvw-pulse {
  50% { opacity: 0.25; }
}
/* ── 全屏查看 / 标注 ──────────────────────────────────────────────────────
 * 原生窗口标题栏（Windows 的 WCO 三个按钮、macOS 的红绿灯）画在网页之上，
 * 任何 z-index 都盖不住、也压不掉它的高亮。所以这里的做法是几何上的避让：
 * 顶栏净空用宿主公布的 --dsh-frame-overlay-top，图片、按钮、提示一律待在
 * 净空以下，右上区域里不出现任何本插件的控件。 */
.dsh-imgvw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  padding: var(--dsh-frame-overlay-top, 8px) 0 0;
  background: rgba(8, 8, 10, 0.88);
  backdrop-filter: blur(2px);
  -webkit-app-region: no-drag;
}
.dsh-imgvw-top {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 16px 4px;
  color: rgba(255, 255, 255, 0.78);
  font-size: 11px;
  line-height: 1.5;
}
.dsh-imgvw-top-name {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.dsh-imgvw-hint {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.42);
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
}
.dsh-imgvw-close {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font: inherit;
  padding: 3px 10px;
  cursor: pointer;
}
.dsh-imgvw-close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.dsh-imgvw-tools {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 5px;
  padding: 4px 12px;
}
.dsh-imgvw-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
  cursor: grab;
}
.dsh-imgvw-stage[data-drag='true'] {
  cursor: grabbing;
}
.dsh-imgvw-stage[data-draw='true'] {
  cursor: crosshair;
}
.dsh-imgvw-canvas {
  position: relative;
  flex: none;
  will-change: transform;
}
.dsh-imgvw-big {
  display: block;
  max-width: none;
  max-height: none;
}
.dsh-imgvw-layer {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}
.dsh-imgvw-input {
  position: fixed;
  z-index: 1;
  border: 1px dashed rgba(255, 255, 255, 0.8);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-family: var(--dsw-font-sans, system-ui, sans-serif);
  padding: 0 3px;
  outline: none;
}
.dsh-imgvw-toast {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 6px;
  font-size: 11px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.86);
}
.dsh-imgvw-toast[data-bad='true'] {
  color: #ff9a9a;
}
.dsh-imgvw-caption {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px 12px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  line-height: 1.6;
}
.dsh-imgvw-caption b {
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.dsh-imgvw-caption button,
.dsh-imgvw-tools button {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 6px;
  color: inherit;
  font: inherit;
  padding: 2px 8px;
  cursor: pointer;
}
.dsh-imgvw-caption button:hover,
.dsh-imgvw-tools button:hover {
  background: rgba(255, 255, 255, 0.14);
}
.dsh-imgvw-caption button[data-on='true'],
.dsh-imgvw-tools button[data-on='true'] {
  border-color: rgba(255, 255, 255, 0.66);
  background: rgba(255, 255, 255, 0.24);
  color: #fff;
}
.dsh-imgvw-caption button[data-strong='true'],
.dsh-imgvw-tools button[data-strong='true'] {
  border-color: var(--dsw-static-deepseek-500, #4d6bfe);
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: #fff;
}
.dsh-imgvw-caption button:disabled,
.dsh-imgvw-tools button:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-imgvw-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.45);
  cursor: pointer;
}
.dsh-imgvw-swatch[data-on='true'] {
  border-color: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}
.dsh-imgvw-group {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px;
  border-left: 1px solid rgba(255, 255, 255, 0.16);
}
.dsh-imgvw-group:first-child {
  border-left: 0;
}
/* ── 截图管理页 ──────────────────────────────────────────────────────────── */
.dsh-shot-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 900px;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 1.6;
}
.dsh-shot-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.dsh-shot-note {
  margin: 0;
  opacity: 0.75;
  font-size: 12px;
}
.dsh-shot-dir {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  word-break: break-all;
}
.dsh-shot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-shot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}
.dsh-shot-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  border-radius: 10px;
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.05));
}
.dsh-shot-thumb {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: contain;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.1);
  cursor: zoom-in;
}
.dsh-shot-meta {
  font-size: 11px;
  opacity: 0.8;
  word-break: break-all;
}
.dsh-shot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.dsh-shot-empty {
  padding: 26px 0;
  text-align: center;
  opacity: 0.6;
}
.dsh-shot-capture {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  cursor: pointer;
}
.dsh-shot-capture:hover {
  background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.12));
}
.dsh-shot-menu {
  position: absolute;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-width: 148px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.24));
  border-radius: 9px;
  background: var(--dsw-alias-bg-elevated, rgba(24, 24, 28, 0.96));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
}
.dsh-shot-menu button {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-shot-menu button:hover {
  background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, 0.16));
}
`

    /**
     * The error text for a failed request, preferring what the host said.
     * @param {unknown} error - the caught value.
     * @returns {string} a one-line message.
     */
    function failureOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * GET or POST one plugin route and unwrap `{ok:false}` answers.
     *
     * The write routes answer POST only, so a missing body still means a POST
     * here — passing `null` is how a caller says "no payload, but it is a write".
     * @param {string} url - the route, same-origin.
     * @param {BodyInit | null} [body] - the request body, or `null` for a bodyless POST.
     * @returns {Promise<object>} the parsed answer, already checked for `ok`.
     */
    async function requestJson(url, body) {
      const write = body !== undefined
      const response = await fetch(url, write
        ? {
          method: 'POST',
          body: body === null ? null : body,
          headers: { 'content-type': 'application/octet-stream' },
        }
        : { method: 'GET' })
      let value = null
      try {
        value = await response.json()
      } catch {
        value = null
      }
      if (response.ok !== true || value === null || value.ok !== true) {
        const said = value !== null && typeof value.error === 'string' ? value.error : ''
        throw new Error(said === '' ? '请求失败 (' + response.status + ')' : said)
      }
      return value
    }

    /**
     * Grab the desktop through the host half.
     *
     * The answer is the PNG itself rather than a JSON wrapper: a full-desktop
     * bitmap is a few hundred KB to a few MB, and handing the browser the bytes
     * directly avoids base64-ing them.
     * @param {number} delayMs - how long the host waits before it grabs.
     * @returns {Promise<{ url: string, bytes: number }>} an object URL for the grab.
     */
    async function captureScreen(delayMs) {
      const response = await fetch(SHOT_ROUTE + '/capture?delay=' + Math.max(0, Math.round(delayMs)), { method: 'POST' })
      const type = response.headers.get('content-type') ?? ''
      if (response.ok !== true || type.indexOf('image/') !== 0) {
        let said = ''
        try {
          const value = await response.json()
          if (value !== null && typeof value.error === 'string') said = value.error
        } catch {
          said = ''
        }
        throw new Error(said === '' ? '抓屏失败 (' + response.status + ')' : said)
      }
      const blob = await response.blob()
      return { url: URL.createObjectURL(blob), bytes: blob.size }
    }

    /**
     * Put a PNG on the clipboard as an image.
     *
     * This is the one clipboard write the page can do without a host helper: the
     * desktop app runs in a secure context with sanitized writes granted.
     * @param {Blob} blob - the PNG to hand over.
     */
    async function copyImageBlob(blob) {
      const clip = navigator.clipboard
      if (clip === undefined || typeof clip.write !== 'function' || typeof ClipboardItem !== 'function') {
        throw new Error('当前环境不能复制图片，请改用「保存」')
      }
      await clip.write([new ClipboardItem({ 'image/png': blob })])
    }

    /** Copy plain text, reporting the same failures the caller shows. */
    async function copyText(text) {
      const clip = navigator.clipboard
      if (clip === undefined || typeof clip.writeText !== 'function') throw new Error('当前环境不能复制')
      await clip.writeText(text)
    }

    /**
     * Paint one annotation.
     *
     * Coordinates are source-image pixels, so the same mark renders identically
     * on the on-screen layer and in the exported PNG.
     * @param {CanvasRenderingContext2D} context - the target context.
     * @param {object} mark - one entry of the mark list.
     */
    function drawMark(context, mark) {
      if (mark === null || mark === undefined) return
      context.strokeStyle = mark.color
      context.fillStyle = mark.color
      context.lineWidth = mark.width
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.setLineDash(mark.dashed === true ? [mark.width * 4, mark.width * 3] : [])
      if (mark.type === 'rect') {
        context.strokeRect(Math.min(mark.x0, mark.x1), Math.min(mark.y0, mark.y1),
          Math.abs(mark.x1 - mark.x0), Math.abs(mark.y1 - mark.y0))
        return
      }
      if (mark.type === 'ellipse') {
        context.beginPath()
        context.ellipse((mark.x0 + mark.x1) / 2, (mark.y0 + mark.y1) / 2,
          Math.abs(mark.x1 - mark.x0) / 2, Math.abs(mark.y1 - mark.y0) / 2, 0, 0, Math.PI * 2)
        context.stroke()
        return
      }
      if (mark.type === 'arrow') {
        const dx = mark.x1 - mark.x0
        const dy = mark.y1 - mark.y0
        const length = Math.sqrt(dx * dx + dy * dy)
        if (length < 1) return
        const head = Math.min(length / 2, mark.width * 5)
        const angle = Math.atan2(dy, dx)
        context.beginPath()
        context.moveTo(mark.x0, mark.y0)
        context.lineTo(mark.x1 - Math.cos(angle) * head * 0.6, mark.y1 - Math.sin(angle) * head * 0.6)
        context.stroke()
        context.beginPath()
        context.moveTo(mark.x1, mark.y1)
        context.lineTo(mark.x1 - Math.cos(angle - 0.42) * head, mark.y1 - Math.sin(angle - 0.42) * head)
        context.lineTo(mark.x1 - Math.cos(angle + 0.42) * head, mark.y1 - Math.sin(angle + 0.42) * head)
        context.closePath()
        context.fill()
        return
      }
      if (mark.type === 'pen') {
        const points = mark.points
        if (points.length < 4) return
        context.beginPath()
        context.moveTo(points[0], points[1])
        for (let i = 2; i + 1 < points.length; i += 2) context.lineTo(points[i], points[i + 1])
        context.stroke()
        return
      }
      if (mark.type === 'text') {
        context.font = mark.size + 'px system-ui, "Microsoft YaHei", "PingFang SC", sans-serif'
        context.textBaseline = 'top'
        context.shadowColor = 'rgba(0, 0, 0, 0.6)'
        context.shadowBlur = Math.max(2, mark.size / 4)
        context.fillText(mark.text, mark.x0, mark.y0)
        context.shadowBlur = 0
        return
      }
      context.setLineDash([])
    }

    /** Paint the whole mark list, then the mark still being dragged. */
    function drawMarks(context, marks, draft) {
      for (const mark of marks) drawMark(context, mark)
      if (draft !== null && draft !== undefined) drawMark(context, draft)
    }

    /**
     * Render the annotated picture out to a PNG blob.
     * @param {HTMLImageElement} image - the loaded source picture.
     * @param {{ x: number, y: number, w: number, h: number } | null} crop - the crop rect in source pixels, or none.
     * @param {object[]} marks - the annotations, in source pixels.
     * @returns {Promise<Blob>} the PNG.
     */
    function exportPng(image, crop, marks) {
      if (image === null || image === undefined || image.naturalWidth <= 0) {
        return Promise.reject(new Error('图片还没有准备好'))
      }
      const full = crop === null || crop === undefined
      const width = full ? image.naturalWidth : Math.max(1, Math.round(crop.w))
      const height = full ? image.naturalHeight : Math.max(1, Math.round(crop.h))
      const offsetX = full ? 0 : Math.round(crop.x)
      const offsetY = full ? 0 : Math.round(crop.y)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) return Promise.reject(new Error('无法创建导出画布'))
      context.drawImage(image, offsetX, offsetY, width, height, 0, 0, width, height)
      context.translate(-offsetX, -offsetY)
      drawMarks(context, marks, null)
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob === null || blob === undefined) reject(new Error('导出 PNG 失败（图片可能被跨域限制）'))
          else resolve(blob)
        }, 'image/png')
      })
    }

    /**
     * Map one wheel gesture onto the stage's three gestures.
     *
     * A plain wheel zooms — that is the whole point of opening a picture full
     * screen. Shift drives the vertical axis and Ctrl the horizontal one, which
     * is how an overflowed picture gets read without leaving the wheel. Windows
     * browsers report Shift+wheel as a horizontal delta, so the axis falls back
     * to whichever delta moved.
     * @param {{ ctrlKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} mods - the gesture's modifiers.
     * @param {number} deltaX - the horizontal delta.
     * @param {number} deltaY - the vertical delta.
     * @param {number} deltaMode - 0 pixels, 1 lines, 2 pages.
     * @returns {{ axis: 'zoom' | 'x' | 'y', amount: number }} the gesture to apply.
     */
    function gestureOf(mods, deltaX, deltaY, deltaMode) {
      const unit = deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1
      const moved = deltaY !== 0 ? deltaY : deltaX
      const amount = moved === 0 ? 0 : -moved * unit
      if (mods.shiftKey === true) return { axis: 'y', amount }
      if (mods.ctrlKey === true || mods.metaKey === true) return { axis: 'x', amount }
      return { axis: 'zoom', amount }
    }

    /** Render `node` at the document root so no ancestor's transform can clip it. */
    function toDocument(node) {
      try {
        const dom = require('react-dom')
        if (typeof dom.createPortal === 'function' && typeof document !== 'undefined') {
          return dom.createPortal(node, document.body)
        }
      } catch {
        /* no react-dom in this loader: the overlay renders where it was mounted */
      }
      return node
    }

    /** Narrow an unknown wire value to a plain record. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && Array.isArray(value) === false
    }

    /**
     * Read the `file_path` argument out of a Tool call block.
     *
     * The block is either a running call or a settled result; both carry the call
     * head, whose `argsRaw` is the JSON the model produced. A settled call with a
     * malformed head simply renders nothing rather than a broken card.
     */
    function imagePathOf(block) {
      const call = isRecord(block) && isRecord(block.call) ? block.call : block
      if (isRecord(call) === false) return null
      const raw = call.argsRaw
      if (typeof raw !== 'string' || raw === '') return null
      let args
      try {
        args = JSON.parse(raw)
      } catch {
        return null
      }
      if (isRecord(args) === false) return null
      const path = args.file_path
      if (typeof path !== 'string' || path.trim() === '') return null
      return path
    }

    /** Strip the workspace root from a workspace-rooted path, for display only. */
    function displayPathOf(path, cwd) {
      if (typeof cwd !== 'string' || cwd === '') return path
      const root = cwd.replace(/[/\\]+$/, '')
      if (root === '') return path
      if (path.startsWith(root + '/') || path.startsWith(root + '\\')) return path.slice(root.length + 1)
      return path
    }

    /** Render a byte count at reading size. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || bytes <= 0) return null
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
    }

    /**
     * The claim list: every tool whose card this plugin owns, with the Chinese
     * label shown while the call runs. `read_image` needs no label (the file
     * path speaks for itself). Adding an image-bearing tool = adding one line.
     */
    const TOOL_LABELS = {
      generate_image: '绘图',
      computer_screenshot: '屏幕截图',
      computer_zoom: '区域放大',
      computer_wait: '等待',
      computer_move: '移动鼠标',
      computer_click: '点击',
      computer_drag: '拖拽',
      computer_scroll: '滚动',
      computer_type: '输入文本',
      computer_key: '按键',
      computer_open: '启动应用',
      computer_sequence: '连续动作',
    }

    const IMAGE_TOOL_KEYS = ['read_image'].concat(Object.keys(TOOL_LABELS))

    /** The `<path>…</path>\n<type>image</type>` envelope read_image hands the model. */
    const IMAGE_ENVELOPE = /^<path>[^\n]*<\/path>\n<type>image<\/type>/

    /**
     * Decide what the card should render for one call: the settled content's
     * image refs, the first non-envelope text line (the note row), and the
     * call's `file_path` when it names one. Null until a result carries an image.
     */
    function imageSpecOf(block) {
      const content = isRecord(block) && Array.isArray(block.content) ? block.content : null
      if (content === null) return null
      const atts = []
      let text = ''
      for (const item of content) {
        if (!isRecord(item)) continue
        if (item.type === 'image' && isRecord(item.attachment)
          && typeof item.attachment.attachmentId === 'string') {
          atts.push(item.attachment)
        } else if (item.type === 'text' && typeof item.text === 'string' && text === ''
          && IMAGE_ENVELOPE.test(item.text) === false) {
          text = String(item.text).split('\n')[0]
        }
      }
      if (atts.length === 0) return null
      return { mode: 'attachment', path: imagePathOf(block), atts, text }
    }

    /**
     * Paint a pending crop: the picture dims outside it and its edge marches.
     * @param {CanvasRenderingContext2D} context - the annotation layer's context.
     * @param {{ x: number, y: number, w: number, h: number }} crop - the rect in source pixels.
     * @param {{ w: number, h: number }} natural - the picture's source size.
     */
    function paintCrop(context, crop, natural) {
      context.save()
      context.setLineDash([])
      context.fillStyle = 'rgba(0, 0, 0, 0.55)'
      context.fillRect(0, 0, natural.w, crop.y)
      context.fillRect(0, crop.y + crop.h, natural.w, Math.max(0, natural.h - crop.y - crop.h))
      context.fillRect(0, crop.y, crop.x, crop.h)
      context.fillRect(crop.x + crop.w, crop.y, Math.max(0, natural.w - crop.x - crop.w), crop.h)
      context.strokeStyle = '#ffffff'
      context.lineWidth = 1.5
      context.setLineDash([7, 5])
      context.strokeRect(crop.x, crop.y, crop.w, crop.h)
      context.restore()
    }

    /** The font size a text mark takes, in source pixels, from the stroke-width choice. */
    function textSize(natural, lineWidth) {
      const base = natural.h > 0 ? natural.h : 800
      return Math.max(14, Math.round((base * lineWidth) / 200))
    }

    /** Normalize two corners into a rectangle in source pixels. */
    function rectOf(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      }
    }

    /** The label of one draw tool. */
    function toolLabel(tool) {
      if (tool === 'move') return '移动'
      if (tool === 'rect') return '矩形'
      if (tool === 'ellipse') return '椭圆'
      if (tool === 'arrow') return '箭头'
      if (tool === 'pen') return '画笔'
      if (tool === 'text') return '文字'
      return '裁剪'
    }

    /**
     * Whether a released pointer tap on the dark area closes the stage.
     *
     * Clicking outside the picture is the oldest way out of a lightbox and it
     * stays available; the labelled close buttons are the addition, not the
     * replacement. A tap only closes when it is still (a drag was a pan), when
     * it landed off the picture, and when nothing is being annotated — a stray
     * click must not throw away strokes or a pending crop.
     * @param {object} facts - what the released gesture was.
     * @param {boolean} facts.editing - whether the annotation tools are up.
     * @param {boolean} facts.moved - whether the pointer travelled far enough to be a drag.
     * @param {object | null} facts.crop - the pending crop rect, if any.
     * @param {boolean} facts.onPicture - whether the pointer was over the picture.
     * @returns {boolean} close on this tap or not.
     */
    function closesOnTap(facts) {
      return facts.editing !== true
        && facts.moved !== true
        && facts.crop === null
        && facts.onPicture !== true
    }

    /**
     * The full-screen stage: view, annotate, then copy or save.
     *
     * The picture renders at its natural size inside a wrapper that carries the
     * one pan/zoom transform, and the annotation layer is a canvas laid exactly
     * over it, so a single coordinate system — source-image pixels — serves the
     * pointer, the layer, and the exported PNG. Zoom is anchored on the cursor:
     * the point under the pointer stays put, so zooming into a detail does not
     * make the user chase it with a drag afterwards.
     *
     * Gestures: a plain wheel zooms, Shift+wheel moves vertically, Ctrl+wheel
     * moves horizontally, a drag pans (or draws, once a tool is armed), and a
     * double tap returns to fit. Two ways out, both always there: a click on the
     * dark around the picture, and the labelled close buttons (or Esc). The
     * first is the fastest when you only wanted to look; the second is the one
     * you can see.
     *
     * The close button is not in the top-right corner. The desktop app draws its
     * window buttons over the page, so that corner is theirs and a plugin control
     * placed there reads as one of them; the top row is centered instead, and the
     * stage starts below the frame clearance the host publishes.
     */
    function ImageZoomOverlay(props) {
      const [view, setView] = React.useState({ scale: 1, x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const [natural, setNatural] = React.useState({ w: 0, h: 0 })
      const [vp, setVp] = React.useState({ w: 0, h: 0 })
      const [editing, setEditing] = React.useState(props.initialEdit === true)
      const [tool, setTool] = React.useState(props.initialTool === undefined ? 'rect' : props.initialTool)
      const [color, setColor] = React.useState(COLORS[0])
      const [lineWidth, setLineWidth] = React.useState(WIDTHS[1])
      const [track, setTrack] = React.useState([{ marks: [], crop: null }])
      const [stepAt, setStepAt] = React.useState(0)
      const [draft, setDraft] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const stageRef = React.useRef(null)
      const wrapRef = React.useRef(null)
      const imgRef = React.useRef(null)
      const layerRef = React.useRef(null)
      const drawRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const tapRef = React.useRef(null)
      const textSent = React.useRef(null)
      const close = props.onClose
      const shot = track[stepAt]

      /** Push a new annotation state and drop the redo tail it invalidates. */
      const commit = (next) => {
        setTrack((prev) => prev.slice(0, stepAt + 1).concat([next]))
        setStepAt(stepAt + 1)
      }

      // Open at a fit-to-viewport scale: 1:1 is the wrong entry point for a
      // screenshot, which is routinely larger than the window it must fit in.
      React.useEffect(() => {
        const measure = () => {
          const stage = stageRef.current
          if (stage === null) return
          const rect = stage.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) setVp({ w: rect.width, h: rect.height })
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      const fit = (natural.w > 0 && natural.h > 0 && vp.w > 0 && vp.h > 0)
        ? Math.min(1, (vp.w * 0.97) / natural.w, (vp.h * 0.94) / natural.h)
        : 1

      /** Land on the fit scale once, as soon as both the stage and the picture are measurable. */
      const settled = React.useRef(null)
      React.useEffect(() => {
        if (natural.w <= 0 || vp.w <= 0 || vp.h <= 0) return
        // Follow the window only while the view is still the one this overlay opened with;
        // a view the user has zoomed or panned is theirs to keep.
        if (settled.current === 'user' || settled.current === 'done') return
        settled.current = 'done'
        setView({ scale: fit, x: 0, y: 0 })
      }, [natural.w, natural.h, vp.w, vp.h, fit])

      /** Where a pointer sits in source-image pixels. */
      const atPoint = (event) => {
        const node = wrapRef.current
        if (node === null || natural.w <= 0 || natural.h <= 0) return null
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return {
          x: (event.clientX - rect.left) * (natural.w / rect.width),
          y: (event.clientY - rect.top) * (natural.h / rect.height),
        }
      }

      /** Whether a pointer sits over the picture rather than the dark around it. */
      const overPicture = (event) => {
        const node = wrapRef.current
        if (node === null) return false
        const rect = node.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom
      }

      const pushMark = (mark) => commit({ marks: shot.marks.concat([mark]), crop: shot.crop })

      const openText = (point) => {
        setPending({
          x: point.x,
          y: point.y,
          text: '',
          color,
          size: textSize(natural, lineWidth),
        })
      }

      const pushText = () => {
        // Enter commits the text and unmounts the input; removing a focused node
        // can still deliver a blur, and a second pass would drop a duplicate
        // mark. The pending object itself is the token: commit it at most once.
        if (pending === null || textSent.current === pending) return
        textSent.current = pending
        if (pending.text.trim() !== '') {
          pushMark({
            type: 'text', x0: pending.x, y0: pending.y,
            text: pending.text, color: pending.color, size: pending.size,
          })
        }
        setPending(null)
      }

      /** Render the annotated picture, honouring the crop, as a PNG blob. */
      const exportCurrent = () => exportPng(imgRef.current, shot.crop, shot.marks)

      const doCopy = async () => {
        setBusy(true)
        try {
          await copyImageBlob(await exportCurrent())
          setStatus({ bad: false, text: '已复制到剪贴板，可直接在输入框 Ctrl+V 粘贴' })
        } catch (error) {
          setStatus({ bad: true, text: failureOf(error) })
        }
        setBusy(false)
      }

      /** Save into the screenshot directory; optionally copy in the same gesture. */
      const doSave = async (alsoCopy) => {
        setBusy(true)
        try {
          const blob = await exportCurrent()
          let copied = ''
          if (alsoCopy === true) {
            try {
              await copyImageBlob(blob)
              copied = '，并已复制到剪贴板'
            } catch {
              copied = '（剪贴板复制失败，文件已保存）'
            }
          }
          const reply = await requestJson(SHOT_ROUTE + '/save', blob)
          setStatus({ bad: false, text: '已保存到 ' + reply.path + copied, path: reply.path })
        } catch (error) {
          setStatus({ bad: true, text: failureOf(error) })
        }
        setBusy(false)
      }

      /** Apply a wheel gesture to the stage. */
      const applyGesture = (gesture, clientX, clientY) => {
        settled.current = 'user'
        if (gesture.axis === 'zoom') {
          const stage = stageRef.current
          if (stage === null) return
          const rect = stage.getBoundingClientRect()
          const cx = clientX - rect.left - rect.width / 2
          const cy = clientY - rect.top - rect.height / 2
          setView((prev) => {
            const scale = Math.min(8, Math.max(0.05, prev.scale * Math.exp(gesture.amount / 240)))
            const ratio = scale / prev.scale
            return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio }
          })
          return
        }
        setView((prev) => (gesture.axis === 'x'
          ? { scale: prev.scale, x: prev.x + gesture.amount, y: prev.y }
          : { scale: prev.scale, x: prev.x, y: prev.y + gesture.amount }))
      }

      // Registered non-passively: a wheel over the stage is the stage's own
      // gesture, and must never scroll the page behind it as well.
      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          applyGesture(gestureOf(event, event.deltaX, event.deltaY, event.deltaMode), event.clientX, event.clientY)
        }
        stage.addEventListener('wheel', onWheel, { passive: false })
        return () => stage.removeEventListener('wheel', onWheel)
      }, [])

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const point = atPoint(event)
        if (editing === true && tool !== 'move' && point !== null) {
          if (tool === 'text') {
            openText(point)
            return
          }
          drawRef.current = { x: point.x, y: point.y, points: tool === 'pen' ? [point.x, point.y] : null }
          setDraft(tool === 'pen'
            ? { type: 'pen', points: drawRef.current.points, color, width: lineWidth }
            : {
              type: tool === 'crop' ? 'rect' : tool,
              x0: point.x, y0: point.y, x1: point.x, y1: point.y,
              color: tool === 'crop' ? '#ffffff' : color,
              width: tool === 'crop' ? 1.5 : lineWidth,
              dashed: tool === 'crop',
            })
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* capture is a nicety; drawing still works without it */
          }
          return
        }
        dragRef.current = {
          id: event.pointerId,
          fromX: event.clientX,
          fromY: event.clientY,
          baseX: view.x,
          baseY: view.y,
          moved: false,
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety; dragging still works without it */
        }
      }

      const onPointerMove = (event) => {
        const drawing = drawRef.current
        if (drawing !== null) {
          const point = atPoint(event)
          if (point === null) return
          if (tool === 'pen') {
            drawing.points = drawing.points.concat([point.x, point.y])
            setDraft({ type: 'pen', points: drawing.points, color, width: lineWidth })
            return
          }
          setDraft({
            type: tool === 'crop' ? 'rect' : tool,
            x0: drawing.x, y0: drawing.y, x1: point.x, y1: point.y,
            color: tool === 'crop' ? '#ffffff' : color,
            width: tool === 'crop' ? 1.5 : lineWidth,
            dashed: tool === 'crop',
          })
          return
        }
        const drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.fromX
        const dy = event.clientY - drag.fromY
        if (drag.moved === false && Math.abs(dx) + Math.abs(dy) > 3) {
          drag.moved = true
          setDragging(true)
        }
        if (drag.moved === true) {
          settled.current = 'user'
          setView((prev) => ({ scale: prev.scale, x: drag.baseX + dx, y: drag.baseY + dy }))
        }
      }

      /**
       * A gesture that never moved is either a click on the dark (which closes),
       * the first half of a double tap on the picture (which fits), or nothing at
       * all. Double tap is detected here rather than left to the native `dblclick`
       * because the pointer capture this stage takes is exactly the kind of
       * retargeting that stops the browser synthesising that event.
       */
      const onPointerUp = (event) => {
        const drawing = drawRef.current
        if (drawing !== null) {
          drawRef.current = null
          const mark = draft
          setDraft(null)
          if (mark === null) return
          if (tool === 'crop') {
            const crop = rectOf({ x: drawing.x, y: drawing.y }, { x: mark.x1, y: mark.y1 })
            if (crop.w >= 4 && crop.h >= 4) {
              commit({ marks: shot.marks, crop })
              setTool('move')
              setStatus({ bad: false, text: '已选定裁剪区域，保存时只导出这一块' })
            }
            return
          }
          if (tool === 'pen') {
            if (mark.points.length >= 4) pushMark(mark)
            return
          }
          if (Math.abs(mark.x1 - mark.x0) + Math.abs(mark.y1 - mark.y0) < 4) return
          pushMark(mark)
          return
        }
        const drag = dragRef.current
        dragRef.current = null
        setDragging(false)
        if (drag === null) return
        if (closesOnTap({
          editing,
          moved: drag.moved === true,
          crop: shot.crop,
          onPicture: overPicture(event),
        })) {
          close()
          return
        }
        if (drag.moved === true) return
        const now = Date.now()
        const last = tapRef.current
        if (last !== null
          && now - last.at < 400
          && Math.abs(event.clientX - last.x) < 20
          && Math.abs(event.clientY - last.y) < 20) {
          tapRef.current = null
          toFit()
          return
        }
        tapRef.current = { at: now, x: event.clientX, y: event.clientY }
      }

      // Double-click and the fit button land on the same view the card opened with.
      // Declared before the pointer handlers, which call it from a tap they own.
      function toFit() {
        settled.current = 'user'
        setView({ scale: fit, x: 0, y: 0 })
      }
      const toActual = () => {
        settled.current = 'user'
        setView({ scale: 1, x: 0, y: 0 })
      }
      // Before the first fit is known the picture is hidden rather than shown at a
      // scale it is about to leave, which is what a flash of an oversized image is.
      const focused = settled.current !== null

      const bump = (factor) => setView((prev) => {
        settled.current = 'user'
        const scale = Math.min(8, Math.max(0.05, prev.scale * factor))
        const ratio = scale / prev.scale
        return { scale, x: prev.x * ratio, y: prev.y * ratio }
      })

      const undo = () => {
        if (stepAt <= 0) return
        setStepAt(stepAt - 1)
        setDraft(null)
      }
      const redo = () => {
        if (stepAt >= track.length - 1) return
        setStepAt(stepAt + 1)
        setDraft(null)
      }

      const toggleEdit = () => {
        const next = editing !== true
        setEditing(next)
        if (next === true) setTool(props.initialTool === undefined ? 'rect' : props.initialTool)
        setDraft(null)
        setPending(null)
      }

      React.useEffect(() => {
        const onKey = (event) => {
          const tag = event.target instanceof Element ? event.target.tagName : ''
          if (tag === 'INPUT' || tag === 'TEXTAREA') {
            if (event.key === 'Escape') setPending(null)
            return
          }
          if (event.key === 'Escape') {
            if (pending !== null) setPending(null)
            else if (draft !== null) setDraft(null)
            else if (editing === true) setEditing(false)
            else close()
            return
          }
          if (event.key === '+' || event.key === '=') bump(1.25)
          else if (event.key === '-' || event.key === '_') bump(1 / 1.25)
          else if (event.key === '0') toActual()
          else if (event.key === 'f' || event.key === 'F') toFit()
          else if (editing !== true) return
          else if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault()
            if (event.shiftKey === true) redo()
            else undo()
          } else if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'y' || event.key === 'Y')) {
            event.preventDefault()
            redo()
          } else if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault()
            void doSave(true)
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            if (shot.marks.length > 0) commit({ marks: shot.marks.slice(0, -1), crop: shot.crop })
          } else if (event.key === 'Enter' && shot.crop !== null) setTool('move')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      })

      // The annotation layer mirrors the picture's box, with enough backing
      // pixels to stay crisp at the current zoom instead of upscaling a 1:1
      // bitmap while the user reads a detail at 400%.
      React.useEffect(() => {
        const canvas = layerRef.current
        if (canvas === null || editing !== true || natural.w <= 0 || natural.h <= 0) return
        const raster = Math.max(1, Math.min(3, view.scale * (window.devicePixelRatio || 1)))
        const width = Math.max(1, Math.round(natural.w * raster))
        const height = Math.max(1, Math.round(natural.h * raster))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const context = canvas.getContext('2d')
        if (context === null) return
        context.setTransform(raster, 0, 0, raster, 0, 0)
        context.clearRect(0, 0, natural.w, natural.h)
        drawMarks(context, shot.marks, draft)
        if (shot.crop !== null) paintCrop(context, shot.crop, natural)
      }, [shot, draft, natural, view.scale, editing])

      const textPoint = pending === null ? null : (() => {
        const node = wrapRef.current
        if (node === null || natural.w <= 0) return null
        const rect = node.getBoundingClientRect()
        return {
          left: rect.left + (pending.x * rect.width) / natural.w,
          top: rect.top + (pending.y * rect.height) / natural.h,
          size: Math.max(11, (pending.size * rect.width) / natural.w),
        }
      })()

      const button = (key, label, onClick, options) => React.createElement('button', {
        key,
        type: 'button',
        onClick,
        disabled: options !== undefined && options.busy === true && busy === true,
        'data-on': options !== undefined && options.on === true ? 'true' : 'false',
        'data-strong': options !== undefined && options.strong === true ? 'true' : 'false',
        title: options !== undefined ? options.title : undefined,
      }, label)

      const toolRow = editing === true
        ? React.createElement('div', { key: 'tools', className: 'dsh-imgvw-tools' }, [
          React.createElement('span', { key: 'tools', className: 'dsh-imgvw-group' },
            DRAW_TOOLS.map((id) => button(id, toolLabel(id), () => setTool(id), { on: tool === id }))),
          React.createElement('span', { key: 'colors', className: 'dsh-imgvw-group' },
            COLORS.map((value) => React.createElement('button', {
              key: value,
              type: 'button',
              className: 'dsh-imgvw-swatch',
              style: { background: value },
              'data-on': color === value ? 'true' : 'false',
              title: value,
              onClick: () => setColor(value),
            }))),
          React.createElement('span', { key: 'widths', className: 'dsh-imgvw-group' },
            WIDTHS.map((value) => button('w' + value, value + 'px', () => setLineWidth(value), { on: lineWidth === value }))),
          React.createElement('span', { key: 'steps', className: 'dsh-imgvw-group' }, [
            button('undo', '撤销', undo, { on: false, title: 'Ctrl+Z，取消最后一步' }),
            button('redo', '重做', redo, { on: false, title: 'Ctrl+Shift+Z' }),
            button('clear', '清空', () => commit({ marks: [], crop: null }), { on: false }),
            shot.crop === null ? null : button('uncrop', '取消裁剪',
              () => commit({ marks: shot.marks, crop: null }), { on: false }),
            button('done', '完成标注', () => {
              setEditing(false)
              void doSave(true)
            }, { strong: true, busy: true, title: '退出标注，并复制 + 保存这一张' }),
          ]),
        ])
        : null

      return toDocument(React.createElement('div', {
        className: 'dsh-imgvw-backdrop',
        // The bars own their own space, so only a click that lands on the
        // backdrop itself — its padding — counts as the dark.
        onClick: (event) => {
          if (event.target !== event.currentTarget) return
          if (closesOnTap({ editing, moved: false, crop: shot.crop, onPicture: false })) close()
        },
      }, [
        React.createElement('div', { key: 'top', className: 'dsh-imgvw-top' }, [
          React.createElement('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-imgvw-close',
            onClick: close,
            title: '关闭查看器，回到对话（Esc）',
          }, '✕ 关闭'),
          React.createElement('span', { key: 'name', className: 'dsh-imgvw-top-name', title: props.shown }, props.shown),
          props.pixels
            ? React.createElement('span', {
              key: 'pixels', className: 'dsh-imgvw-hint',
            }, props.pixels)
            : null,
          React.createElement('span', { key: 'hint', className: 'dsh-imgvw-hint' }, editing === true
            ? '选工具后在图上拖拽绘制 · 移动工具可拖动 · 滚轮缩放 · Shift/Ctrl+滚轮平移 · 双击适应'
            : '滚轮缩放 · Shift+滚轮上下 · Ctrl+滚轮左右 · 按住拖动 · 双击适应 · 点图外或 Esc 关闭'),
        ]),
        toolRow,
        React.createElement('div', {
          key: 'stage',
          ref: stageRef,
          className: 'dsh-imgvw-stage',
          'data-drag': dragging ? 'true' : 'false',
          'data-draw': editing === true && tool !== 'move' ? 'true' : 'false',
          onDoubleClick: toFit,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        }, [
          React.createElement('div', {
            key: 'wrap',
            ref: wrapRef,
            className: 'dsh-imgvw-canvas',
            style: {
              transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')',
            },
          }, [
            React.createElement('img', {
              key: 'img',
              ref: imgRef,
              className: 'dsh-imgvw-big',
              src: props.src,
              alt: props.shown,
              draggable: false,
              style: { opacity: focused ? undefined : 0 },
              onLoad: (event) => {
                const w = event.target.naturalWidth
                const h = event.target.naturalHeight
                if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return
                setNatural({ w, h })
              },
            }),
            editing === true
              ? React.createElement('canvas', { key: 'layer', ref: layerRef, className: 'dsh-imgvw-layer' })
              : null,
          ]),
        ]),
        status === null
          ? null
          : React.createElement('div', {
            key: 'status',
            className: 'dsh-imgvw-toast',
            'data-bad': status.bad === true ? 'true' : 'false',
          }, [
            React.createElement('span', { key: 'text' }, status.text),
            typeof status.path === 'string'
              ? React.createElement('button', {
                key: 'copy',
                type: 'button',
                className: 'dsh-imgvw-link',
                style: { color: 'inherit' },
                onClick: () => {
                  void copyText(status.path).then(
                    () => setStatus({ bad: false, text: '已复制路径', path: status.path }),
                    (error) => setStatus({ bad: true, text: failureOf(error) }),
                  )
                },
              }, '复制路径')
              : null,
          ]),
        React.createElement('div', { key: 'caption', className: 'dsh-imgvw-caption' }, [
          React.createElement('span', { key: 'zoom', className: 'dsh-imgvw-group' }, [
            React.createElement('span', { key: 'label' }, '缩放 '),
            React.createElement('b', { key: 'v' }, Math.round(view.scale * 100) + '%'),
            button('out', '−', () => bump(1 / 1.25), { on: false }),
            button('in', '+', () => bump(1.25), { on: false }),
            button('fit', '适应窗口', toFit, { on: false, title: '双击图片同样回到适应窗口' }),
            button('actual', '100%', toActual, { on: false }),
          ]),
          React.createElement('span', { key: 'edit', className: 'dsh-imgvw-group' }, [
            button('annotate', editing === true ? '退出标注' : '标注', toggleEdit,
              { on: editing === true, title: '画框、箭头、文字，然后复制或保存' }),
            button('copy', '复制图片', () => void doCopy(), { on: false, busy: true }),
            button('save', busy === true ? '处理中…' : '保存并复制', () => void doSave(true),
              { strong: true, busy: true, title: '存入截图目录，并复制到剪贴板（Ctrl+S）' }),
            button('saveonly', '仅保存', () => void doSave(false), { on: false, busy: true }),
          ]),
          React.createElement('span', { key: 'close', className: 'dsh-imgvw-group' }, [
            button('close', '关闭 (Esc)', close, { on: false }),
          ]),
        ]),
        textPoint === null || pending === null
          ? null
          : React.createElement('input', {
            key: 'input',
            className: 'dsh-imgvw-input',
            autoFocus: true,
            value: pending.text,
            placeholder: '输入标注后回车',
            style: {
              left: textPoint.left + 'px',
              top: textPoint.top + 'px',
              fontSize: textPoint.size + 'px',
              color: pending.color,
            },
            onChange: (event) => setPending({ ...pending, text: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                pushText()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setPending(null)
              }
            },
            onBlur: pushText,
          }),
      ]))
    }

    /**
     * The one metadata line under the picture: identity, size, format, actions.
     *
     * It is a separate component so the image's own re-render never rebuilds the
     * action buttons.
     */
    function MediaBar(props) {
      const parts = []
      parts.push(React.createElement('span', {
        key: 'dot',
        className: 'dsh-imgvw-dot',
        'data-live': props.live ? 'true' : 'false',
        'data-bad': props.bad ? 'true' : 'false',
        'data-ok': props.ok && props.live === false ? 'true' : 'false',
      }))
      parts.push(React.createElement('span', {
        key: 'name',
        className: 'dsh-imgvw-name',
        title: props.shown,
      }, props.shown))
      const add = (key, value) => {
        if (value === null) return
        parts.push(React.createElement(React.Fragment, { key: key + '-sep' },
          React.createElement('span', { className: 'dsh-imgvw-sep' }, '·')))
        parts.push(React.createElement('span', { key: key, className: 'dsh-imgvw-stat' }, value))
      }
      add('pixels', props.pixels)
      add('bytes', props.bytes)
      add('format', props.format)
      if (props.onZoomIn !== null) {
        parts.push(React.createElement(React.Fragment, { key: 'zoom-sep' },
          React.createElement('span', { className: 'dsh-imgvw-sep' }, '·')))
        parts.push(React.createElement('button', {
          key: 'zoom',
          type: 'button',
          className: 'dsh-imgvw-link',
          onClick: props.onZoomIn,
        }, '缩放查看'))
      }
      if (props.onAnnotate !== null && props.onAnnotate !== undefined) {
        parts.push(React.createElement(React.Fragment, { key: 'annotate-sep' },
          React.createElement('span', { className: 'dsh-imgvw-sep' }, '·')))
        parts.push(React.createElement('button', {
          key: 'annotate',
          type: 'button',
          className: 'dsh-imgvw-link',
          title: '放大后画红框、箭头、文字，再复制到剪贴板或存盘',
          onClick: props.onAnnotate,
        }, '标注'))
      }
      if (props.onCopy !== null) {
        parts.push(React.createElement(React.Fragment, { key: 'copy-sep' },
          React.createElement('span', { className: 'dsh-imgvw-sep' }, '·')))
        parts.push(React.createElement('button', {
          key: 'copy',
          type: 'button',
          className: 'dsh-imgvw-link',
          onClick: props.onCopy,
        }, props.copied ? '已复制路径' : '复制路径'))
      }
      if (props.onOpenFile !== null) {
        parts.push(React.createElement(React.Fragment, { key: 'open-sep' },
          React.createElement('span', { className: 'dsh-imgvw-sep' }, '·')))
        parts.push(React.createElement('button', {
          key: 'open',
          type: 'button',
          className: 'dsh-imgvw-link',
          onClick: props.onOpenFile,
        }, '在编辑器中打开'))
      }
      return React.createElement('div', {
        className: 'dsh-imgvw-bar',
        style: props.width === null ? undefined : { width: props.width + 'px' },
      }, parts)
    }

    /**
     * Running vs settled comes from the block's shape, not from a flag.
     *
     * `ToolCallBlock` is a union of `RunningToolCall` and `ToolResultNode`
     * (content, isError). There is no `isRunning` field, so reading one always
     * yielded false and an in-flight call fell through to the settled path —
     * which returns null when the block carries no content, leaving the row
     * blank for the whole call.
     *
     * dsh 0.1.7-rc.1 split `RunningToolCall` into `phase: 'preparing'` (the
     * model is still streaming arguments, so there is no `argsRaw` yet) and
     * `phase: 'start'`, and the slot now renders during preparation as well. The
     * preparing head must count as running too, or a claimed row renders nothing
     * until the call is dispatched.
     */
    function isRunningBlock(block) {
      if (isRecord(block) === false) return false
      if (block.phase === 'preparing' || block.phase === 'start') return true
      return block.isRunning !== false && typeof block.argsRaw === 'string'
    }
    function isFailedBlock(block) {
      return isRecord(block) && block.isError === true
    }

    /**
     * The preview card: the settled result's durable attachment owns the picture.
     *
     * Every stat renders straight off the attachment reference, and the URL
     * comes from the session-authorized loader (`peek` first — chat keeps a warm
     * cache of images it already resolved). `read_image` lands here too: since
     * dsh 0.1.7 its result carries the same durable reference (dimensions, bytes,
     * media type), so the plugin no longer reads the file itself. Its
     * `file_path` argument only names the row and drives copy-path / open-file.
     */
    function AttachmentPreview(props) {
      const att = props.spec.atts[0]
      const extra = props.spec.atts.length - 1
      const load = props.loadImage
      const path = props.spec.path
      const label = TOOL_LABELS[props.toolName] === undefined ? props.toolName : TOOL_LABELS[props.toolName]
      const [url, setUrl] = React.useState(() => (
        typeof load === 'function' && typeof load.peek === 'function' ? load.peek(att) ?? null : null
      ))
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(null)
      const [geometry, setGeometry] = React.useState(null)
      const [checker, setChecker] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [copyNote, setCopyNote] = React.useState(null)

      React.useEffect(() => {
        if (typeof load !== 'function') {
          setFailed(true)
          return undefined
        }
        let alive = true
        const peeked = typeof load.peek === 'function' ? load.peek(att) : null
        if (peeked !== null && peeked !== undefined) {
          setUrl(peeked)
          return undefined
        }
        setUrl(null)
        setFailed(false)
        Promise.resolve(load(att)).then(
          (value) => { if (alive === true) setUrl(typeof value === 'string' ? value : null) },
          () => { if (alive === true) setFailed(true) },
        )
        return () => { alive = false }
      }, [att.attachmentId])

      if (props.spec.atts.length === 0) return null

      const shown = path !== null
        ? displayPathOf(path, props.cwd)
        : typeof att.name === 'string' && att.name !== '' ? att.name : label
      const hasDims = typeof att.width === 'number' && typeof att.height === 'number'
        && att.width > 0 && att.height > 0
      // The store may have downscaled the image before the model saw it; the
      // reference then also records the input size, which is worth naming.
      const original = isRecord(att.originalDimensions)
        && typeof att.originalDimensions.width === 'number' && typeof att.originalDimensions.height === 'number'
        ? att.originalDimensions.width + '×' + att.originalDimensions.height
        : null
      const pixels = hasDims
        ? att.width + '×' + att.height + (original === null ? '' : '（原图 ' + original + '）')
        : null
      const bytes = formatBytes(att.bytes)
      const format = typeof att.mediaType === 'string' && att.mediaType.startsWith('image/')
        ? att.mediaType.slice('image/'.length).toUpperCase()
        : null
      const aspect = hasDims ? att.width / att.height : null
      // v1.4.1：附件的像素尺寸在图片加载前就在引用上，布局提前定死，加载零位移。
      const known = geometry !== null ? geometry : hasDims ? { w: att.width, h: att.height } : null
      const barWidth = known === null
        ? null
        : Math.max(320, Math.min(720, Math.round(160 * (known.w / known.h))))
      const noteParts = []
      if (props.spec.text !== '') noteParts.push(props.spec.text)
      if (extra > 0) noteParts.push('另有 ' + extra + ' 张未展开')
      if (copyNote !== null) noteParts.push(copyNote)
      const note = noteParts.length === 0 ? null : noteParts.join(' · ')

      /** Size the metadata line to the picture and detect a transparent container. */
      const onImageLoad = (event) => {
        const node = event.target
        const w = node.naturalWidth
        const h = node.naturalHeight
        if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return
        setGeometry({ w, h })
        if (format !== 'PNG' && format !== 'WEBP' && format !== 'GIF') return
        try {
          const size = 24
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const context = canvas.getContext('2d')
          if (context === null) return
          context.drawImage(node, 0, 0, size, size)
          const data = context.getImageData(0, 0, size, size).data
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 250) {
              setChecker(true)
              return
            }
          }
        } catch {
          /* an unreadable canvas just means no checkerboard */
        }
      }

      const copyPath = path === null ? null : () => {
        copyText(shown).then(
          () => setCopied(true),
          () => {
            console.log('read_image preview path', shown)
            setCopyNote('无法自动复制，路径已打到控制台')
          },
        )
      }

      const src = failed === false && typeof url === 'string' ? url : null
      const frame = src !== null
        ? React.createElement('div', {
          key: 'frame',
          className: 'dsh-imgvw-frame',
          title: '点击打开缩放视图',
          onClick: () => setOpen('view'),
        }, [
          React.createElement('img', {
            key: 'img',
            className: 'dsh-imgvw-img',
            src,
            alt: shown,
            width: hasDims ? att.width : undefined,
            height: hasDims ? att.height : undefined,
            'data-checker': checker ? 'true' : 'false',
            onLoad: onImageLoad,
          }),
          React.createElement('span', {
            key: 'zoom',
            className: 'dsh-imgvw-zoom',
            'aria-hidden': 'true',
          }, '⤢'),
        ])
        : React.createElement('div', { key: 'frame', className: 'dsh-imgvw-frame' }, [
          React.createElement('div', {
            key: 'skel',
            className: 'dsh-imgvw-skel',
            style: aspect === null ? undefined : { aspectRatio: String(aspect) },
          }, [
            React.createElement('span', {
              key: 'label',
              className: 'dsh-imgvw-skel-label',
              'data-bad': failed ? 'true' : 'false',
            }, failed ? '图片加载失败：附件不可读' : '正在载入画面…'),
          ]),
        ])

      return React.createElement('div', { className: 'dsh-imgvw-root' }, [
        frame,
        React.createElement(MediaBar, {
          key: 'bar',
          shown,
          live: false,
          bad: failed,
          ok: src !== null,
          pixels,
          bytes,
          format,
          copied,
          width: barWidth,
          onZoomIn: src === null ? null : () => setOpen('view'),
          onAnnotate: src === null ? null : () => setOpen('edit'),
          onCopy: copyPath,
          onOpenFile: path !== null && typeof props.openFile === 'function' ? () => props.openFile(path) : null,
        }),
        note === null
          ? null
          : React.createElement('div', {
            key: 'note',
            className: 'dsh-imgvw-bar',
            style: { opacity: 0.75 },
          }, note),
        open !== null && src !== null
          ? React.createElement(ImageZoomOverlay, {
            key: 'overlay',
            src,
            shown,
            pixels,
            initialEdit: open === 'edit',
            onClose: () => setOpen(null),
          })
          : null,
      ])
    }

    /** What the skeleton says while a claimed call runs. */
    function liveTextOf(toolName) {
      if (toolName === 'read_image') return 'AI 正在查看这张图片…'
      const label = TOOL_LABELS[toolName] === undefined ? toolName : TOOL_LABELS[toolName]
      return label + ' 执行中，画面稍后呈现…'
    }

    /**
     * The one card for every claimed tool.
     *
     * Dispatch order: attachment preview (settled content carries image refs) →
     * a live skeleton while the call runs → a plain one-line outcome for
     * imageless/failed settled calls, so a claimed row never renders an empty
     * shell.
     */
    function ImageToolCard(props) {
      const block = props.block
      const spec = imageSpecOf(block)
      if (spec !== null) {
        return React.createElement(AttachmentPreview, {
          spec,
          cwd: props.cwd,
          openFile: props.openFile,
          loadImage: props.loadImage,
          toolName: props.toolName,
        })
      }
      const live = isRunningBlock(block)
      const failed = isFailedBlock(block)
      if (live) {
        const path = imagePathOf(block)
        return React.createElement('div', { className: 'dsh-imgvw-root' }, [
          React.createElement('div', { key: 'frame', className: 'dsh-imgvw-frame' }, [
            React.createElement('div', { key: 'skel', className: 'dsh-imgvw-skel' }, [
              React.createElement('span', {
                key: 'label',
                className: 'dsh-imgvw-skel-label',
              }, liveTextOf(props.toolName)),
            ]),
          ]),
          path === null
            ? null
            : React.createElement('div', { key: 'path', className: 'dsh-imgvw-bar', style: { opacity: 0.75 } },
              displayPathOf(path, props.cwd)),
        ])
      }
      let line = ''
      if (isRecord(block) && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
            line = String(item.text).split('\n')[0]
            break
          }
        }
      }
      if (line === '' && failed === false) return null
      return React.createElement('div', { className: 'dsh-imgvw-root' }, [
        React.createElement('div', {
          key: 'line',
          className: 'dsh-imgvw-bar',
          style: failed ? { color: 'var(--dsw-danger, #c53030)' } : { opacity: 0.85 },
        }, line === '' ? '（无输出）' : line),
      ])
    }

    /** Where the composer remembers the last capture delay the user picked. */
    const DELAY_KEY = 'dsh.read-image-preview.delay'

    /** Read the stored delay, tolerating a storage area that refuses to answer. */
    function storedDelay() {
      try {
        const value = Number(localStorage.getItem(DELAY_KEY))
        if (Number.isFinite(value) === true && value >= 0 && value <= 60) return value
      } catch {
        /* private mode: fall back to the default */
      }
      return 0
    }

    /** Join a directory and a file name the way the host's platform would. */
    function joinPath(dir, name, platform) {
      const sep = platform === 'win32' ? '\\' : '/'
      return dir.replace(/[\\/]+$/, '') + sep + name
    }

    /**
     * The composer's 截图 button: freeze the desktop, annotate it, hand it over.
     *
     * The grab is one click; the delay menu exists because half of what worth
     * capturing is a state that closes the moment the composer gets a click. A
     * right-click opens it, so the button itself stays one glyph wide.
     */
    function ShotCaptureButton() {
      const [shot, setShot] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [menu, setMenu] = React.useState(false)
      const [delay, setDelay] = React.useState(storedDelay)
      const urlRef = React.useRef(null)

      React.useEffect(() => () => {
        if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
      }, [])

      const grab = async (seconds) => {
        if (busy === true) return
        const value = Number(seconds)
        setBusy(true)
        setMenu(false)
        setNote(null)
        setDelay(value)
        try {
          localStorage.setItem(DELAY_KEY, String(value))
        } catch {
          /* nothing to persist to */
        }
        try {
          if (urlRef.current !== null) {
            URL.revokeObjectURL(urlRef.current)
            urlRef.current = null
          }
          const fresh = await captureScreen(value * 1000)
          urlRef.current = fresh.url
          setShot(fresh)
        } catch (error) {
          setNote(failureOf(error))
        }
        setBusy(false)
      }

      const dismiss = () => {
        setShot(null)
        if (urlRef.current !== null) {
          URL.revokeObjectURL(urlRef.current)
          urlRef.current = null
        }
      }

      return React.createElement('span', { style: { position: 'relative', display: 'inline-flex' } }, [
        React.createElement('button', {
          key: 'grab',
          type: 'button',
          className: 'dsh-shot-capture',
          disabled: busy,
          title: '抓取整个屏幕并标注：' + (delay === 0 ? '立即' : delay + ' 秒后') + '（右键选延时）',
          onClick: () => void grab(delay),
          onContextMenu: (event) => {
            event.preventDefault()
            setMenu((prev) => prev !== true)
          },
        }, busy === true ? '抓屏中…' : '✂ 截图'),
        menu !== true
          ? null
          : React.createElement('span', {
            key: 'menu',
            className: 'dsh-shot-menu',
            style: { bottom: 'calc(100% + 6px)', right: 0 },
          }, [0, 1, 3, 5].map((seconds) => React.createElement('button', {
            key: seconds,
            type: 'button',
            onClick: () => void grab(seconds),
          }, seconds === 0 ? '立即抓屏' : seconds + ' 秒后抓屏'))),
        note === null
          ? null
          : React.createElement('span', {
            key: 'note',
            title: note,
            style: { fontSize: '11px', opacity: 0.7, maxWidth: '140px' },
          }, '截图失败'),
        shot === null
          ? null
          : React.createElement(ImageZoomOverlay, {
            key: 'stage',
            src: shot.url,
            shown: '刚抓取的全屏 · ' + formatBytes(shot.bytes),
            pixels: null,
            initialEdit: true,
            initialTool: 'crop',
            onClose: dismiss,
          }),
      ])
    }

    /**
     * 设置 → 截图与标注: the shelf the plugin's own pictures live on.
     *
     * Listing, copying a path, deleting one shot, opening the directory, and an
     * immediate cleanup run. The retention policy itself is edited in this
     * plugin's generated settings form; this page shows what is in force so the
     * two never disagree.
     */
    function ShotsPage() {
      const [info, setInfo] = React.useState(null)
      const [items, setItems] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [used, setUsed] = React.useState(0)
      const [offset, setOffset] = React.useState(0)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [peek, setPeek] = React.useState(null)

      const load = async (next) => {
        setBusy(true)
        try {
          const page = await requestJson(SHOT_ROUTE + '/list?limit=60&offset=' + next)
          setItems(next === 0 ? page.items : items.concat(page.items))
          setTotal(page.total)
          setUsed(page.bytes)
          setOffset(next)
          setNote(null)
          const nextInfo = await requestJson(SHOT_ROUTE + '/state')
          setInfo(nextInfo)
        } catch (error) {
          setNote(failureOf(error))
        }
        setBusy(false)
      }

      React.useEffect(() => {
        void load(0)
        return undefined
      }, [])

      const remove = async (name) => {
        setBusy(true)
        try {
          await requestJson(SHOT_ROUTE + '/delete?name=' + encodeURIComponent(name), null)
          setNote('已删除 ' + name)
          await load(0)
        } catch (error) {
          setNote(failureOf(error))
        }
        setBusy(false)
      }

      const cleanup = async () => {
        setBusy(true)
        try {
          const reply = await requestJson(SHOT_ROUTE + '/cleanup', null)
          setNote('清理完成：删除 ' + reply.removed + ' 个，释放 ' + formatBytes(reply.freed))
          await load(0)
        } catch (error) {
          setNote(failureOf(error))
        }
        setBusy(false)
      }

      const openDir = async () => {
        try {
          await requestJson(SHOT_ROUTE + '/open', null)
          setNote(null)
        } catch (error) {
          setNote(failureOf(error))
        }
      }

      const copyPath = async (name) => {
        try {
          await copyText(joinPath(info === null ? '' : info.dir, name, info === null ? '' : info.platform))
          setNote('已复制 ' + name + ' 的路径')
        } catch (error) {
          setNote(failureOf(error))
        }
      }

      const action = (key, label, onClick, title) => React.createElement('button', {
        key,
        type: 'button',
        className: 'dsh-shot-capture',
        disabled: busy,
        title,
        onClick,
      }, label)

      return React.createElement('div', { className: 'dsh-shot-page' }, [
        React.createElement('div', { key: 'head', className: 'dsh-shot-head' }, [
          React.createElement('div', { key: 'text' }, [
            React.createElement('p', { key: 'note', className: 'dsh-shot-note' },
              '标注后保存或复制的截图都落在这个目录里。清理策略只删除本插件按 shot- 命名的文件，'
              + '把目录指到别处也不会被误删。保留天数、数量与体积上限在下方本插件的设置项里改。'),
            React.createElement('p', { key: 'dir', className: 'dsh-shot-dir' },
              info === null ? '正在读取截图目录…' : info.dir),
            info === null
              ? null
              : React.createElement('p', { key: 'policy', className: 'dsh-shot-note' },
                '保留 ' + (info.policy.days > 0 ? info.policy.days + ' 天' : '不按天数')
                + ' · 最多 ' + info.policy.maxFiles + ' 个'
                + ' · 最多 ' + formatBytes(info.policy.maxBytes)
                + ' · 当前 ' + total + ' 张 / ' + formatBytes(used)
                + (info.capture.length > 0 ? ' · 抓屏：' + info.capture[0] : '')),
          ]),
          React.createElement('div', { key: 'actions', className: 'dsh-shot-actions' }, [
            action('refresh', '刷新', () => void load(0)),
            action('open', '打开目录', () => void openDir(), '在系统文件管理器里打开截图目录'),
            action('cleanup', '立即清理', () => void cleanup(), '按上面的策略删掉过期的截图'),
          ]),
        ]),
        note === null
          ? null
          : React.createElement('p', { key: 'note', className: 'dsh-shot-note' }, note),
        items.length === 0
          ? React.createElement('div', { key: 'empty', className: 'dsh-shot-empty' },
            total === 0 ? '还没有保存过截图。在图片查看器里点「保存并复制」，或用输入框旁的「✂ 截图」。' : '本页没有更多截图。')
          : React.createElement('div', { key: 'grid', className: 'dsh-shot-grid' }, items.map((item) => React.createElement('div', {
            key: item.name,
            className: 'dsh-shot-card',
          }, [
            React.createElement('img', {
              key: 'thumb',
              className: 'dsh-shot-thumb',
              src: item.url,
              alt: item.name,
              loading: 'lazy',
              title: '点击查看大图',
              onClick: () => setPeek(item),
            }),
            React.createElement('div', { key: 'meta', className: 'dsh-shot-meta' },
              new Date(item.mtime).toLocaleString() + ' · ' + formatBytes(item.bytes)),
            React.createElement('div', { key: 'row', className: 'dsh-shot-row' }, [
              React.createElement('button', {
                key: 'copy',
                type: 'button',
                className: 'dsh-imgvw-link',
                onClick: () => void copyPath(item.name),
              }, '复制路径'),
              React.createElement('button', {
                key: 'del',
                type: 'button',
                className: 'dsh-imgvw-link',
                disabled: busy,
                onClick: () => void remove(item.name),
              }, '删除'),
            ]),
          ]))),
        items.length < total
          ? React.createElement('div', { key: 'more', className: 'dsh-shot-actions' },
            action('more', '加载更多（还有 ' + (total - items.length) + ' 张）', () => void load(offset + 60)))
          : null,
        peek === null
          ? null
          : React.createElement(ImageZoomOverlay, {
            key: 'peek',
            src: peek.url,
            shown: peek.name,
            pixels: null,
            onClose: () => setPeek(null),
          }),
      ])
    }

    const inject = ['slots']

    /**
     * Claim every image-bearing tool's keyed cell at priority -1.
     *
     * Each cell is keyed by the wire Tool name and these keys are either
     * covered by the shipped composition (read_image) or by dynamic fallback
     * cards; the lower priority shadows them, and if one of our entries ever
     * throws, the slot's error boundary abdicates it and the previous card
     * returns.
     */
    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-read-image-preview'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        style.remove()
      })

      ctx.slots.inject('tool.call.toolview', () => {
        IMAGE_TOOL_KEYS.forEach((key) => {
          ctx.slots.register({
            name: 'tool.call.toolview',
            key,
            priority: -1,
          }, ImageToolCard)
        })
      })

      // The capture entry lives in the composer, next to the box the picture is
      // meant for; the shelf those pictures land on lives in settings.
      ctx.slots.inject('conversation.input.right', () => {
        ctx.slots.register({
          name: 'conversation.input.right',
          id: 'read-image-preview-capture',
          order: 8,
        }, () => React.createElement(ShotCaptureButton, null))
      })

      ctx.slots.inject('settings.section', () => {
        ctx.slots.register({
          name: 'settings.section',
          id: 'read-image-preview',
          order: 13,
          label: () => '截图与标注',
        }, () => React.createElement(ShotsPage, null))
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
