/**
 * Browser half of the image preview / screenshot workspace plugin.
 *
 * Three surfaces share one full-screen viewer (zoom, pan, annotate, then send
 * to the composer, copy, or save):
 *
 * - Image galleries. The official image positions — `tool.call.images` inside
 *   the read_image row, user and assistant message images, trajectory images —
 *   are filled at priority -1 with this plugin's gallery, so the official rows
 *   keep their own chrome (title, path, sizes, Inspect) and only the pictures
 *   and the viewer are ours. Older and newer hosts name the message slots
 *   differently; registering every name is safe because `slots.inject` waits
 *   for a declaration that never comes.
 * - Tool cards for image-bearing tools that have no official image row
 *   (computer-use, generate_image): their keyed `tool.call.toolview` cell is
 *   claimed at priority -1 and renders the same gallery plus one metadata line.
 * - The composer's ✂ button: grab the desktop, drag a region, press Enter and
 *   the picture lands in the composer as a pasted attachment.
 *
 * The viewer never re-renders React on a pointer move or a wheel tick: the
 * view lives in a ref and one animation frame writes the picture's transform
 * and repaints a viewport-sized annotation canvas.
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
    /** Draw tools, in toolbar order. `move` pans and selects instead of drawing. */
    const DRAW_TOOLS = ['move', 'rect', 'ellipse', 'arrow', 'pen', 'text', 'crop']
    /** One-key shortcuts for the draw tools. */
    const TOOL_KEYS = { v: 'move', r: 'rect', e: 'ellipse', a: 'arrow', p: 'pen', t: 'text', c: 'crop' }
    /** The annotation palette. Red first: it is what a callout is usually drawn in. */
    const COLORS = ['#ff2d2d', '#ffb300', '#12b76a', '#2f6fed', '#111111', '#ffffff']
    /** Stroke widths, in source-image pixels so they survive a crop or a resize. */
    const WIDTHS = [2, 4, 8]
    /** Zoom bounds. 16× is for reading single pixels of a UI screenshot. */
    const MIN_SCALE = 0.05
    const MAX_SCALE = 16
    /** How close, in screen pixels, a press must land to grab a mark or a handle. */
    const GRAB_PX = 8
    /** The composer is a Lexical editor; its root carries this attribute. */
    const EDITOR_SELECTOR = '[data-lexical-editor="true"]'
    /** An empty annotation state. Shared so "nothing was ever drawn" compares by identity. */
    const EMPTY_SHOT = { marks: [], crop: null }

    const CSS = `
.dsh-imgvw-root {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}
.dsh-imgvw-root ~ [class*="_root"] {
  display: none !important;
}
.dsh-imgvw-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}
.dsh-imgvw-gallery[data-align='end'] {
  justify-content: flex-end;
}
.dsh-imgvw-frame {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22));
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.05));
  color: inherit;
  font: inherit;
  line-height: 0;
  cursor: zoom-in;
}
.dsh-imgvw-frame:focus-visible {
  outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe);
  outline-offset: 2px;
}
.dsh-imgvw-img {
  display: block;
  width: auto;
  height: auto;
  max-width: min(420px, 100%);
  max-height: 300px;
}
.dsh-imgvw-frame[data-variant='tile'] {
  width: 120px;
  height: 90px;
}
.dsh-imgvw-frame[data-variant='thumb'] {
  width: 56px;
  height: 56px;
}
.dsh-imgvw-frame[data-variant='tile'] .dsh-imgvw-img,
.dsh-imgvw-frame[data-variant='thumb'] .dsh-imgvw-img {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
}
.dsh-imgvw-frame[data-variant='tile'] .dsh-imgvw-img {
  object-fit: cover;
}
.dsh-imgvw-frame[data-variant='thumb'] .dsh-imgvw-img {
  object-fit: contain;
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
.dsh-imgvw-frame:hover .dsh-imgvw-img {
  filter: brightness(1.04);
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
.dsh-imgvw-frame[data-variant='tile'] .dsh-imgvw-skel,
.dsh-imgvw-frame[data-variant='thumb'] .dsh-imgvw-skel {
  min-width: 0;
  min-height: 0;
  height: 100%;
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
 * 净空以下，右上区域里不出现任何本插件的控件。
 * 不用 backdrop-filter：全屏模糊在每一帧平移时都要重算，是拖动卡顿的来源之一。 */
.dsh-imgvw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  padding: var(--dsh-frame-overlay-top, 8px) 0 0;
  background: rgba(12, 12, 14, 0.94);
  color: rgba(255, 255, 255, 0.86);
  font-size: 12px;
  line-height: 1.5;
  outline: none;
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
  font-size: 11px;
}
.dsh-imgvw-top-name {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.dsh-imgvw-hint {
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.66);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
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
  contain: layout paint;
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
  transform-origin: 50% 50%;
}
.dsh-imgvw-canvas[data-pixel='true'] .dsh-imgvw-big {
  image-rendering: pixelated;
}
.dsh-imgvw-big {
  display: block;
  max-width: none;
  max-height: none;
}
.dsh-imgvw-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.dsh-imgvw-input {
  position: absolute;
  z-index: 3;
  min-width: 120px;
  border: 1px dashed rgba(255, 255, 255, 0.8);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.35);
  font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  line-height: 1.1;
  padding: 0 3px;
  outline: none;
}
.dsh-imgvw-float {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 90%;
  padding: 5px 12px;
  border-radius: 9px;
  background: rgba(20, 20, 24, 0.92);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.35);
  font-size: 12px;
}
.dsh-imgvw-toast {
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
}
.dsh-imgvw-toast[data-bad='true'] {
  color: #ff9a9a;
}
.dsh-imgvw-confirm {
  left: 50%;
  top: 14px;
  transform: translateX(-50%);
}
.dsh-imgvw-snip {
  flex-wrap: nowrap;
  gap: 4px;
  padding: 4px;
  max-width: none;
}
.dsh-imgvw-nav {
  position: absolute;
  z-index: 2;
  top: 50%;
  width: 34px;
  height: 56px;
  margin-top: -28px;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.dsh-imgvw-nav:hover {
  background: rgba(255, 255, 255, 0.22);
}
.dsh-imgvw-nav[data-side='prev'] {
  left: 10px;
}
.dsh-imgvw-nav[data-side='next'] {
  right: 10px;
}
.dsh-imgvw-tools {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px 0;
  padding: 6px 12px 10px;
}
.dsh-imgvw-group {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
}
.dsh-imgvw-group:first-child {
  border-left: 0;
}
.dsh-imgvw-tools button,
.dsh-imgvw-float button {
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.07);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-imgvw-tools button:hover,
.dsh-imgvw-float button:hover {
  background: rgba(255, 255, 255, 0.16);
}
.dsh-imgvw-tools button[data-on='true'] {
  border-color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.24);
  color: #fff;
}
.dsh-imgvw-tools button[data-strong='true'],
.dsh-imgvw-float button[data-strong='true'] {
  border-color: var(--dsw-static-deepseek-500, #4d6bfe);
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: #fff;
}
.dsh-imgvw-tools button:disabled,
.dsh-imgvw-float button:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-imgvw-tools .dsh-imgvw-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.45);
}
.dsh-imgvw-tools .dsh-imgvw-swatch[data-on='true'] {
  border-color: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}
.dsh-imgvw-zoomval {
  min-width: 46px;
  text-align: center;
  font-variant-numeric: tabular-nums;
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

    /** The composer editor that last had focus, kept by a focusin listener `apply` installs. */
    let lastEditor = null

    /**
     * Find the composer a picture should be sent to.
     *
     * The nearest editor to the element the request came from wins (the ✂
     * button sits inside the composer; a gallery sits in the conversation whose
     * composer it belongs to), then the editor that last had focus, then the
     * last visible one on the page.
     * @param {Element | null | undefined} anchor - where the request came from.
     * @returns {HTMLElement | null} the editor root, or null when there is none.
     */
    function findComposer(anchor) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      const usable = (node) => node !== null && node !== undefined && node.isContentEditable === true
        && node.isConnected !== false
      for (let node = anchor ?? null; node !== null && node !== undefined; node = node.parentElement) {
        if (typeof node.querySelector !== 'function') continue
        const found = node.querySelector(EDITOR_SELECTOR)
        if (usable(found)) return found
      }
      if (usable(lastEditor)) return lastEditor
      const all = Array.from(document.querySelectorAll(EDITOR_SELECTOR))
        .filter((node) => usable(node) && node.getClientRects().length > 0)
      return all.length === 0 ? null : all[all.length - 1]
    }

    /**
     * Hand a PNG to the composer the way a user's Ctrl+V would.
     *
     * The composer takes pasted files through its editor's paste command, which
     * is the same intake a real paste and a drop use — a user-facing behaviour,
     * not a private hook — and it cancels the event when it took the files.
     * @param {HTMLElement} editor - the composer's editor root.
     * @param {Blob} blob - the PNG.
     * @param {string} name - the file name the attachment shows.
     * @returns {boolean} whether the composer accepted the file.
     */
    function pasteImage(editor, blob, name) {
      if (typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function' || typeof File !== 'function') {
        return false
      }
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], name, { type: 'image/png' }))
      try {
        editor.focus({ preventScroll: true })
      } catch {
        /* focus is a courtesy: the paste command does not need it */
      }
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      return event.defaultPrevented === true
    }

    /** A file name for a picture sent to the composer. */
    function pastedName(now) {
      const at = new Date(now)
      const pad = (value) => String(value).padStart(2, '0')
      return 'screenshot-' + at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate())
        + '-' + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds()) + '.png'
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
     * Paint a pending crop: the picture dims outside it and its edge is drawn.
     * @param {CanvasRenderingContext2D} context - the annotation layer's context.
     * @param {{ x: number, y: number, w: number, h: number }} crop - the rect in source pixels.
     * @param {{ w: number, h: number }} natural - the picture's source size.
     * @param {number} [scale] - the current zoom, so the edge stays one screen pixel wide.
     */
    function paintCrop(context, crop, natural, scale) {
      const s = typeof scale === 'number' && scale > 0 ? scale : 1
      context.save()
      context.setLineDash([])
      context.fillStyle = 'rgba(0, 0, 0, 0.55)'
      context.fillRect(0, 0, natural.w, crop.y)
      context.fillRect(0, crop.y + crop.h, natural.w, Math.max(0, natural.h - crop.y - crop.h))
      context.fillRect(0, crop.y, crop.x, crop.h)
      context.fillRect(crop.x + crop.w, crop.y, Math.max(0, natural.w - crop.x - crop.w), crop.h)
      context.strokeStyle = '#ffffff'
      context.lineWidth = 1.5 / s
      context.setLineDash([7 / s, 5 / s])
      context.strokeRect(crop.x, crop.y, crop.w, crop.h)
      context.restore()
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
     * Map one wheel event onto the stage's gestures.
     *
     * A plain wheel zooms — that is the whole point of opening a picture full
     * screen. Shift drives the vertical axis and Ctrl the horizontal one, which
     * is how an overflowed picture gets read without leaving the wheel. Windows
     * browsers report Shift+wheel as a horizontal delta, so the axis falls back
     * to whichever delta moved.
     *
     * Two touchpad gestures are told apart from the mouse: a pinch arrives as
     * Ctrl+wheel with small or fractional deltas (a mouse notch is ~100px and
     * whole) and zooms; a two-finger swipe carries a horizontal delta without
     * Shift — which a mouse wheel never does — and pans on both axes.
     * @param {{ ctrlKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} mods - the gesture's modifiers.
     * @param {number} deltaX - the horizontal delta.
     * @param {number} deltaY - the vertical delta.
     * @param {number} deltaMode - 0 pixels, 1 lines, 2 pages.
     * @returns {{ axis: 'zoom' | 'x' | 'y' | 'pan', amount: number, x?: number, y?: number, smooth?: boolean }} the gesture.
     */
    function gestureOf(mods, deltaX, deltaY, deltaMode) {
      const unit = deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1
      const ctrl = mods.ctrlKey === true || mods.metaKey === true
      const shift = mods.shiftKey === true
      if (ctrl && shift === false && deltaMode === 0 && deltaX === 0 && deltaY !== 0
        && (Math.abs(deltaY) < 40 || Number.isInteger(deltaY) === false)) {
        return { axis: 'zoom', amount: -deltaY * 6, smooth: false }
      }
      const moved = deltaY !== 0 ? deltaY : deltaX
      const amount = moved === 0 ? 0 : -moved * unit
      if (shift) return { axis: 'y', amount }
      if (ctrl) return { axis: 'x', amount }
      if (deltaX !== 0 && deltaMode === 0) {
        return { axis: 'pan', amount: 0, x: -deltaX, y: -deltaY }
      }
      return { axis: 'zoom', amount, smooth: deltaMode !== 0 || Math.abs(moved) >= 40 }
    }

    /** The zoom factor one wheel amount stands for: about 1.2× per mouse notch. */
    function wheelFactor(amount) {
      return Math.exp(amount / 550)
    }

    /**
     * Zoom a view about a point, keeping that point still on screen.
     * @param {{ scale: number, x: number, y: number }} view - the current view; x/y offset the picture's centre from the stage's.
     * @param {number} factor - the zoom multiplier.
     * @param {number} cx - the anchor, relative to the stage centre.
     * @param {number} cy - the anchor, relative to the stage centre.
     * @returns {{ scale: number, x: number, y: number }} the new view.
     */
    function zoomAbout(view, factor, cx, cy) {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
      const ratio = scale / view.scale
      return { scale, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio }
    }

    /** The scale that fits the whole picture in the stage, never above 1:1. */
    function fitScale(natural, vp) {
      if (!(natural.w > 0 && natural.h > 0 && vp.w > 0 && vp.h > 0)) return 1
      return Math.min(1, (vp.w * 0.96) / natural.w, (vp.h * 0.94) / natural.h)
    }

    /** Where the picture's top-left corner sits in the stage, in screen pixels. */
    function originOf(view, natural, vp) {
      return {
        x: vp.w / 2 + view.x - (natural.w * view.scale) / 2,
        y: vp.h / 2 + view.y - (natural.h * view.scale) / 2,
      }
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
     * The claim list: every tool whose whole card this plugin owns, with the
     * Chinese label shown while the call runs. read_image is not here: its
     * official row hands its gallery to the `tool.call.images` slot, which this
     * plugin fills instead. Adding an image-bearing tool = adding one line.
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

    const IMAGE_TOOL_KEYS = Object.keys(TOOL_LABELS)

    /**
     * Every official image position this plugin's gallery fills. The message
     * slots were renamed between dsh 0.2.0 and 0.2.1; both names are listed and
     * the one the running host does not declare simply never activates.
     */
    const IMAGE_SLOTS = [
      'tool.call.images',
      'conversation.chat.user.images',
      'conversation.chat.message.images',
      'conversation.message.images',
      'conversation.trajectory.images',
    ]

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

    /** The shortcut key shown next to a tool. */
    function toolKey(tool) {
      for (const key of Object.keys(TOOL_KEYS)) if (TOOL_KEYS[key] === tool) return key.toUpperCase()
      return ''
    }

    /** The width of a text mark, estimated without a canvas: CJK glyphs are square, Latin about half. */
    function textWidth(mark) {
      let units = 0
      for (const char of String(mark.text)) units += char.codePointAt(0) > 255 ? 1 : 0.58
      return units * mark.size
    }

    /** Distance from a point to a segment. */
    function segmentDistance(p, ax, ay, bx, by) {
      const dx = bx - ax
      const dy = by - ay
      const length = dx * dx + dy * dy
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / length))
      const x = ax + t * dx - p.x
      const y = ay + t * dy - p.y
      return Math.sqrt(x * x + y * y)
    }

    /**
     * Whether a point grabs one mark.
     *
     * Outlines are grabbed on the line, not inside, so a box drawn around a
     * region does not swallow every press made inside that region.
     * @param {object} mark - the mark.
     * @param {{ x: number, y: number }} p - the point, in source pixels.
     * @param {number} tol - the grab distance, in source pixels.
     * @returns {boolean} hit or not.
     */
    function hitsMark(mark, p, tol) {
      const reach = tol + (typeof mark.width === 'number' ? mark.width / 2 : 0)
      if (mark.type === 'rect') {
        const r = rectOf({ x: mark.x0, y: mark.y0 }, { x: mark.x1, y: mark.y1 })
        const inside = p.x >= r.x - reach && p.x <= r.x + r.w + reach && p.y >= r.y - reach && p.y <= r.y + r.h + reach
        const deep = p.x > r.x + reach && p.x < r.x + r.w - reach && p.y > r.y + reach && p.y < r.y + r.h - reach
        return inside && !deep
      }
      if (mark.type === 'ellipse') {
        const rx = Math.abs(mark.x1 - mark.x0) / 2
        const ry = Math.abs(mark.y1 - mark.y0) / 2
        if (rx < 1 || ry < 1) return false
        const cx = (mark.x0 + mark.x1) / 2
        const cy = (mark.y0 + mark.y1) / 2
        const r = Math.sqrt(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2)
        return Math.abs(r - 1) * Math.min(rx, ry) <= reach
      }
      if (mark.type === 'arrow') return segmentDistance(p, mark.x0, mark.y0, mark.x1, mark.y1) <= reach
      if (mark.type === 'pen') {
        const points = mark.points
        for (let i = 0; i + 3 < points.length; i += 2) {
          if (segmentDistance(p, points[i], points[i + 1], points[i + 2], points[i + 3]) <= reach) return true
        }
        return false
      }
      if (mark.type === 'text') {
        return p.x >= mark.x0 - tol && p.x <= mark.x0 + textWidth(mark) + tol
          && p.y >= mark.y0 - tol && p.y <= mark.y0 + mark.size * 1.2 + tol
      }
      return false
    }

    /** The topmost mark under a point, or -1. */
    function hitMark(marks, p, tol) {
      for (let i = marks.length - 1; i >= 0; i -= 1) if (hitsMark(marks[i], p, tol)) return i
      return -1
    }

    /** The draggable handles of a mark, in source pixels: box corners, or an arrow's two ends. */
    function handlesOf(mark) {
      if (mark === null || mark === undefined) return []
      if (mark.type === 'rect' || mark.type === 'ellipse') {
        return [
          { x: mark.x0, y: mark.y0 }, { x: mark.x1, y: mark.y0 },
          { x: mark.x1, y: mark.y1 }, { x: mark.x0, y: mark.y1 },
        ]
      }
      if (mark.type === 'arrow') return [{ x: mark.x0, y: mark.y0 }, { x: mark.x1, y: mark.y1 }]
      return []
    }

    /** The four corners of a crop, clockwise from top-left. */
    function cropCorners(crop) {
      return [
        { x: crop.x, y: crop.y }, { x: crop.x + crop.w, y: crop.y },
        { x: crop.x + crop.w, y: crop.y + crop.h }, { x: crop.x, y: crop.y + crop.h },
      ]
    }

    /** The handle under a point, or -1. */
    function hitHandle(points, p, tol) {
      for (let i = 0; i < points.length; i += 1) {
        if (Math.abs(points[i].x - p.x) <= tol && Math.abs(points[i].y - p.y) <= tol) return i
      }
      return -1
    }

    /** A mark shifted by a delta in source pixels. */
    function moveMark(mark, dx, dy) {
      if (mark.type === 'pen') return { ...mark, points: mark.points.map((value, i) => value + (i % 2 === 0 ? dx : dy)) }
      if (mark.type === 'text') return { ...mark, x0: mark.x0 + dx, y0: mark.y0 + dy }
      return { ...mark, x0: mark.x0 + dx, y0: mark.y0 + dy, x1: mark.x1 + dx, y1: mark.y1 + dy }
    }

    /** A mark with one handle dragged to a point. */
    function resizeMark(mark, handle, p) {
      if (mark.type === 'arrow') return handle === 0 ? { ...mark, x0: p.x, y0: p.y } : { ...mark, x1: p.x, y1: p.y }
      if (mark.type !== 'rect' && mark.type !== 'ellipse') return mark
      const next = { ...mark }
      if (handle === 0 || handle === 3) next.x0 = p.x
      else next.x1 = p.x
      if (handle === 0 || handle === 1) next.y0 = p.y
      else next.y1 = p.y
      return next
    }

    /** A crop with one corner dragged to a point; the opposite corner stays. */
    function resizeCrop(crop, handle, p) {
      return rectOf(cropCorners(crop)[(handle + 2) % 4], p)
    }

    /** A crop moved by a delta, kept inside the picture. */
    function moveCrop(crop, dx, dy, natural) {
      return {
        x: Math.max(0, Math.min(natural.w - crop.w, crop.x + dx)),
        y: Math.max(0, Math.min(natural.h - crop.h, crop.y + dy)),
        w: crop.w,
        h: crop.h,
      }
    }

    /** Whether a freshly drawn mark is more than a stray click. */
    function markIsVisible(mark, scale) {
      if (mark.type === 'pen') return mark.points.length >= 4
      const min = 3 / (scale > 0 ? scale : 1)
      return Math.abs(mark.x1 - mark.x0) + Math.abs(mark.y1 - mark.y0) >= min
    }

    /** Replace one entry of a list without touching the others. */
    function replaceAt(list, index, value) {
      return list.map((item, i) => (i === index ? value : item))
    }

    /**
     * Whether a released tap on the dark area closes the stage.
     *
     * Clicking outside the picture is the oldest way out of a lightbox and it
     * stays available; the labelled close buttons are the addition, not the
     * replacement. A tap only closes when it is still (a drag was a pan), when
     * it landed off the picture, when no drawing tool is armed, and when there is
     * no unexported work — a stray click must not throw away marks or a crop.
     * @param {object} facts - what the released gesture was.
     * @returns {boolean} close on this tap or not.
     */
    function closesOnTap(facts) {
      return facts.moved !== true
        && facts.onPicture !== true
        && (facts.tool === undefined || facts.tool === 'move')
        && facts.crop === null
        && facts.dirty !== true
        && facts.snip !== true
    }

    /** Normalize the viewer's picture list: either `items` or the single `src`. */
    function itemsOf(props) {
      if (Array.isArray(props.items) && props.items.length > 0) return props.items
      return [{ src: props.src, shown: props.shown, pixels: props.pixels }]
    }

    /**
     * The full-screen stage: view, annotate, then send, copy, or save.
     *
     * The picture renders at its natural size inside a wrapper that carries the
     * one pan/zoom transform; the view lives in a ref and a single animation
     * frame writes that transform and repaints a canvas the size of the stage
     * (not of the picture — a 3200×2000 screenshot at 300% would otherwise be a
     * 9600×6000 bitmap re-rasterized on every move). Marks are kept in
     * source-image pixels, so the pointer, the layer, and the exported PNG share
     * one coordinate system.
     *
     * There is no separate annotation mode: the tools are always on the bar and
     * `move` is the default, which pans on empty space and selects, drags, and
     * resizes existing marks. Gestures: a plain wheel zooms (eased for a mouse),
     * Shift+wheel moves vertically, Ctrl+wheel horizontally, a touchpad pinch
     * zooms and a two-finger swipe pans, Space or the middle button pans under
     * any tool, and a double tap fits.
     *
     * The close button is not in the top-right corner. The desktop app draws its
     * window buttons over the page, so that corner is theirs and a plugin control
     * placed there reads as one of them; the top row is centered instead, and the
     * stage starts below the frame clearance the host publishes.
     */
    function ImageZoomOverlay(props) {
      const items = itemsOf(props)
      const snip = props.snip === true
      const [index, setIndex] = React.useState(() => Math.max(0, Math.min(items.length - 1, Number(props.index) || 0)))
      const item = items[Math.min(index, items.length - 1)]
      const [natural, setNatural] = React.useState({ w: 0, h: 0 })
      const [tool, setTool] = React.useState(props.initialTool === undefined ? 'move' : props.initialTool)
      const [color, setColor] = React.useState(COLORS[0])
      const [lineWidth, setLineWidth] = React.useState(WIDTHS[1])
      const [track, setTrack] = React.useState([EMPTY_SHOT])
      const [stepAt, setStepAt] = React.useState(0)
      const [selected, setSelected] = React.useState(-1)
      const [pending, setPending] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [exported, setExported] = React.useState(EMPTY_SHOT)
      const [confirm, setConfirm] = React.useState(null)
      const [ready, setReady] = React.useState(false)
      const rootRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const wrapRef = React.useRef(null)
      const imgRef = React.useRef(null)
      const layerRef = React.useRef(null)
      const zoomRef = React.useRef(null)
      const snipRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const viewRef = React.useRef({ scale: 1, x: 0, y: 0 })
      const targetRef = React.useRef(null)
      const vpRef = React.useRef({ w: 0, h: 0, left: 0, top: 0 })
      const gestureRef = React.useRef(null)
      const draftRef = React.useRef(null)
      const editRef = React.useRef(null)
      const frameRef = React.useRef(0)
      const userRef = React.useRef(false)
      const tapRef = React.useRef(null)
      const spaceRef = React.useRef(false)
      const textSent = React.useRef(null)
      const liveRef = React.useRef(null)
      const close = props.onClose
      const shot = track[stepAt]
      const marks = shot.marks
      const sel = selected >= 0 && selected < marks.length ? selected : -1
      // Work is "unexported" until the exact state on screen was copied, saved, or sent.
      const dirty = shot !== exported && (marks.length > 0 || shot.crop !== null)
      const composer = findComposer(props.anchor)

      /** Push a new annotation state and drop the redo tail it invalidates. */
      const commit = (next) => {
        setTrack((prev) => prev.slice(0, stepAt + 1).concat([next]))
        setStepAt(stepAt + 1)
      }

      /** Write the view to the DOM: the picture's transform, the zoom readout, the layer. */
      const paint = () => {
        frameRef.current = 0
        const target = targetRef.current
        let more = false
        if (target !== null) {
          // Ease towards the wheel's target: a notched mouse wheel then feels continuous.
          const view = viewRef.current
          const k = 0.38
          const ls = Math.log(view.scale)
          const lt = Math.log(target.scale)
          const arrived = Math.abs(lt - ls) < 0.002 && Math.abs(target.x - view.x) < 0.5 && Math.abs(target.y - view.y) < 0.5
          if (arrived) {
            viewRef.current = target
            targetRef.current = null
          } else {
            viewRef.current = {
              scale: Math.exp(ls + (lt - ls) * k),
              x: view.x + (target.x - view.x) * k,
              y: view.y + (target.y - view.y) * k,
            }
            more = true
          }
        }
        const view = viewRef.current
        const wrap = wrapRef.current
        if (wrap !== null) {
          wrap.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')'
          wrap.dataset.pixel = view.scale >= 2 ? 'true' : 'false'
        }
        if (zoomRef.current !== null) zoomRef.current.textContent = Math.round(view.scale * 100) + '%'
        drawLayer()
        if (more) schedule()
      }
      const paintRef = React.useRef(paint)
      paintRef.current = paint
      function schedule() {
        if (frameRef.current !== 0 || typeof requestAnimationFrame !== 'function') return
        frameRef.current = requestAnimationFrame(() => paintRef.current())
      }

      /** Repaint the annotation layer, the selection, and the floating snip bar. */
      function drawLayer() {
        const live = liveRef.current
        const canvas = layerRef.current
        const vp = vpRef.current
        const n = live.natural
        if (canvas === null || vp.w <= 0 || vp.h <= 0) return
        const dpr = window.devicePixelRatio || 1
        const width = Math.max(1, Math.round(vp.w * dpr))
        const height = Math.max(1, Math.round(vp.h * dpr))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const context = canvas.getContext('2d')
        if (context === null) return
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, width, height)
        const snipBar = snipRef.current
        if (n.w <= 0 || n.h <= 0) return
        const view = viewRef.current
        const s = view.scale
        const o = originOf(view, n, vp)
        const edit = editRef.current
        const shown = edit === null ? live.shot : edit
        context.setTransform(dpr * s, 0, 0, dpr * s, dpr * o.x, dpr * o.y)
        drawMarks(context, shown.marks, draftRef.current)
        if (shown.crop !== null && shown.crop !== undefined) paintCrop(context, shown.crop, n, s)
        // Handles are drawn in screen pixels so they stay grabbable at any zoom.
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        const handles = []
        const chosen = live.sel >= 0 ? shown.marks[live.sel] : undefined
        if (chosen !== undefined) handles.push(...handlesOf(chosen))
        if (live.tool === 'crop' && shown.crop !== null && shown.crop !== undefined) handles.push(...cropCorners(shown.crop))
        if (chosen !== undefined && handles.length === 0) {
          const box = boxOf(chosen)
          context.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          context.lineWidth = 1
          context.setLineDash([4, 3])
          context.strokeRect(o.x + box.x * s - 4, o.y + box.y * s - 4, box.w * s + 8, box.h * s + 8)
          context.setLineDash([])
        }
        for (const point of handles) {
          const x = o.x + point.x * s
          const y = o.y + point.y * s
          context.fillStyle = '#ffffff'
          context.strokeStyle = '#2f6fed'
          context.lineWidth = 1.5
          context.setLineDash([])
          context.fillRect(x - 4, y - 4, 8, 8)
          context.strokeRect(x - 4, y - 4, 8, 8)
        }
        if (snipBar !== null) {
          const crop = shown.crop
          if (crop === null || crop === undefined || gestureRef.current !== null) {
            snipBar.style.visibility = 'hidden'
          } else {
            const barW = snipBar.offsetWidth || 260
            const barH = snipBar.offsetHeight || 34
            const right = o.x + (crop.x + crop.w) * s
            const bottom = o.y + (crop.y + crop.h) * s
            const left = Math.max(8, Math.min(vp.w - barW - 8, right - barW))
            const top = bottom + 8 + barH <= vp.h - 8 ? bottom + 8 : Math.max(8, bottom - barH - 8)
            snipBar.style.left = left + 'px'
            snipBar.style.top = top + 'px'
            snipBar.style.visibility = 'visible'
          }
        }
        const input = inputRef.current
        if (input !== null && live.pending !== null) {
          input.style.left = (o.x + live.pending.x * s) + 'px'
          input.style.top = (o.y + live.pending.y * s) + 'px'
          input.style.fontSize = Math.max(11, live.pending.size * s) + 'px'
        }
      }

      /** The bounding box of a mark that has no handles (pen, text), in source pixels. */
      function boxOf(mark) {
        if (mark.type === 'text') return { x: mark.x0, y: mark.y0, w: textWidth(mark), h: mark.size * 1.2 }
        const points = mark.points ?? []
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let i = 0; i + 1 < points.length; i += 2) {
          minX = Math.min(minX, points[i])
          maxX = Math.max(maxX, points[i])
          minY = Math.min(minY, points[i + 1])
          maxY = Math.max(maxY, points[i + 1])
        }
        if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      }

      liveRef.current = { shot, sel, tool, natural, pending }

      /** Re-measure the stage and, while the user has not taken the view, keep it fitted. */
      const measure = () => {
        const stage = stageRef.current
        if (stage === null) return
        const rect = stage.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) return
        vpRef.current = { w: rect.width, h: rect.height, left: rect.left, top: rect.top }
        const n = liveRef.current.natural
        if (userRef.current !== true && n.w > 0) {
          viewRef.current = { scale: fitScale(n, vpRef.current), x: 0, y: 0 }
          targetRef.current = null
        }
        schedule()
      }

      React.useEffect(() => {
        measure()
        let observer = null
        if (typeof ResizeObserver === 'function' && stageRef.current !== null) {
          observer = new ResizeObserver(() => measure())
          observer.observe(stageRef.current)
        } else {
          window.addEventListener('resize', measure)
        }
        // Keystrokes belong to the viewer while it is open, not to the composer underneath.
        const before = typeof document !== 'undefined' ? document.activeElement : null
        if (rootRef.current !== null && typeof rootRef.current.focus === 'function') rootRef.current.focus({ preventScroll: true })
        return () => {
          if (observer !== null) observer.disconnect()
          else window.removeEventListener('resize', measure)
          if (frameRef.current !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
          // Hand focus back only if nothing took it on purpose (a send leaves it in the composer).
          const now = document.activeElement
          const orphaned = now === null || now === document.body
            || (rootRef.current !== null && typeof rootRef.current.contains === 'function' && rootRef.current.contains(now))
          if (orphaned && before !== null && before !== undefined && typeof before.focus === 'function' && before.isConnected !== false) {
            try {
              before.focus({ preventScroll: true })
            } catch {
              /* the old focus target went away */
            }
          }
        }
      }, [])

      // Every committed render can change what the layer shows; one frame repaints it.
      React.useEffect(() => {
        schedule()
      })

      // A transient note fades on its own; a note that carries a path stays until replaced.
      React.useEffect(() => {
        if (status === null || typeof status.path === 'string') return undefined
        const timer = setTimeout(() => setStatus(null), status.bad === true ? 6000 : 3200)
        return () => clearTimeout(timer)
      }, [status])

      React.useEffect(() => {
        if (pending !== null && inputRef.current !== null) inputRef.current.focus({ preventScroll: true })
      }, [pending === null])

      /** Where a pointer sits in source-image pixels. */
      const imagePoint = (clientX, clientY) => {
        const vp = vpRef.current
        if (natural.w <= 0 || natural.h <= 0 || vp.w <= 0) return null
        const view = viewRef.current
        const o = originOf(view, natural, vp)
        return { x: (clientX - vp.left - o.x) / view.scale, y: (clientY - vp.top - o.y) / view.scale }
      }
      const onPictureAt = (p) => p !== null && p.x >= 0 && p.y >= 0 && p.x <= natural.w && p.y <= natural.h
      const clampPoint = (p) => ({ x: Math.max(0, Math.min(natural.w, p.x)), y: Math.max(0, Math.min(natural.h, p.y)) })

      const openText = (p, at) => {
        const mark = typeof at === 'number' ? marks[at] : null
        setSelected(-1)
        setPending(mark !== null
          ? { x: mark.x0, y: mark.y0, text: mark.text, color: mark.color, size: mark.size, index: at }
          : { x: p.x, y: p.y, text: '', color, size: textSize(natural, lineWidth), index: null })
      }

      const pushText = () => {
        // Enter commits the text and unmounts the input; removing a focused node
        // can still deliver a blur, and a second pass would drop a duplicate
        // mark. The pending object itself is the token: commit it at most once.
        if (pending === null || textSent.current === pending) return
        textSent.current = pending
        const text = pending.text.trim() === '' ? null : {
          type: 'text', x0: pending.x, y0: pending.y,
          text: pending.text, color: pending.color, size: pending.size,
        }
        if (typeof pending.index === 'number') {
          const nextMarks = text === null
            ? marks.filter((_, i) => i !== pending.index)
            : replaceAt(marks, pending.index, text)
          commit({ marks: nextMarks, crop: shot.crop })
        } else if (text !== null) {
          commit({ marks: marks.concat([text]), crop: shot.crop })
        }
        setPending(null)
      }

      /** Render the annotated picture, honouring the crop, as a PNG blob. */
      const exportCurrent = () => exportPng(imgRef.current, shot.crop, marks)

      const doCopy = async () => {
        setBusy(true)
        try {
          await copyImageBlob(await exportCurrent())
          setExported(shot)
          setStatus({ bad: false, text: '已复制图片，可在输入框 Ctrl+V 粘贴' })
          setBusy(false)
          return true
        } catch (error) {
          setStatus({ bad: true, text: failureOf(error) })
          setBusy(false)
          return false
        }
      }

      const doSave = async () => {
        setBusy(true)
        try {
          const reply = await requestJson(SHOT_ROUTE + '/save', await exportCurrent())
          setExported(shot)
          setStatus({ bad: false, text: '已保存到 ' + reply.path, path: reply.path })
        } catch (error) {
          setStatus({ bad: true, text: failureOf(error) })
        }
        setBusy(false)
      }

      /** Put the picture into the composer as an attachment and get out of the way. */
      const doSend = async () => {
        setBusy(true)
        try {
          const blob = await exportCurrent()
          const editor = findComposer(props.anchor)
          if (editor !== null && pasteImage(editor, blob, pastedName(Date.now()))) {
            setBusy(false)
            close()
            return
          }
          await copyImageBlob(blob)
          setExported(shot)
          setStatus({ bad: false, text: '没找到可用的输入框，已复制到剪贴板，可手动 Ctrl+V' })
        } catch (error) {
          setStatus({ bad: true, text: failureOf(error) })
        }
        setBusy(false)
      }

      /** Load a different picture of the gallery; annotations belong to the picture they were drawn on. */
      const switchTo = (next) => {
        setIndex(next)
        setTrack([EMPTY_SHOT])
        setStepAt(0)
        setSelected(-1)
        setPending(null)
        setExported(EMPTY_SHOT)
        setNatural({ w: 0, h: 0 })
        setReady(false)
        userRef.current = false
      }

      const requestClose = () => {
        if (dirty) setConfirm({ then: 'close' })
        else close()
      }
      const go = (step) => {
        if (items.length < 2) return
        const next = (index + step + items.length) % items.length
        if (dirty) setConfirm({ then: next })
        else switchTo(next)
      }
      const discard = () => {
        const then = confirm === null ? 'close' : confirm.then
        setConfirm(null)
        if (then === 'close') close()
        else switchTo(then)
      }

      const toFit = () => {
        userRef.current = true
        targetRef.current = { scale: fitScale(natural, vpRef.current), x: 0, y: 0 }
        schedule()
      }
      const toActual = () => {
        userRef.current = true
        targetRef.current = zoomAbout(targetRef.current ?? viewRef.current,
          1 / (targetRef.current ?? viewRef.current).scale, 0, 0)
        schedule()
      }
      const bump = (factor) => {
        userRef.current = true
        targetRef.current = zoomAbout(targetRef.current ?? viewRef.current, factor, 0, 0)
        schedule()
      }

      const undo = () => {
        if (stepAt <= 0) return
        setStepAt(stepAt - 1)
        setSelected(-1)
      }
      const redo = () => {
        if (stepAt >= track.length - 1) return
        setStepAt(stepAt + 1)
        setSelected(-1)
      }
      const removeSelected = () => {
        if (sel < 0) return
        commit({ marks: marks.filter((_, i) => i !== sel), crop: shot.crop })
        setSelected(-1)
      }
      const pickTool = (next) => {
        setTool(next)
        if (next !== 'move') setSelected(-1)
      }
      const pickColor = (value) => {
        setColor(value)
        if (sel >= 0) commit({ marks: replaceAt(marks, sel, { ...marks[sel], color: value }), crop: shot.crop })
      }
      const pickWidth = (value) => {
        setLineWidth(value)
        if (sel < 0) return
        const mark = marks[sel]
        const next = mark.type === 'text' ? { ...mark, size: textSize(natural, value) } : { ...mark, width: value }
        commit({ marks: replaceAt(marks, sel, next), crop: shot.crop })
      }

      // Registered non-passively: a wheel over the stage is the stage's own
      // gesture, and must never scroll the page behind it as well.
      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const gesture = gestureOf(event, event.deltaX, event.deltaY, event.deltaMode)
          userRef.current = true
          if (gesture.axis === 'zoom') {
            const vp = vpRef.current
            const cx = event.clientX - vp.left - vp.w / 2
            const cy = event.clientY - vp.top - vp.h / 2
            const base = targetRef.current ?? viewRef.current
            const next = zoomAbout(base, wheelFactor(gesture.amount), cx, cy)
            if (gesture.smooth === true) {
              targetRef.current = next
            } else {
              targetRef.current = null
              viewRef.current = next
            }
          } else {
            const base = targetRef.current ?? viewRef.current
            targetRef.current = null
            viewRef.current = gesture.axis === 'pan'
              ? { scale: base.scale, x: base.x + gesture.x, y: base.y + gesture.y }
              : gesture.axis === 'x'
                ? { scale: base.scale, x: base.x + gesture.amount, y: base.y }
                : { scale: base.scale, x: base.x, y: base.y + gesture.amount }
          }
          schedule()
        }
        stage.addEventListener('wheel', onWheel, { passive: false })
        return () => stage.removeEventListener('wheel', onWheel)
      }, [])

      /** Point the cursor at what a press would do: resize, move, or the tool's own cursor. */
      const hoverCursor = (event) => {
        const stage = stageRef.current
        if (stage === null) return
        const p = imagePoint(event.clientX, event.clientY)
        let cursor = ''
        if (p !== null && spaceRef.current !== true) {
          const tol = GRAB_PX / viewRef.current.scale
          const corner = (i) => (i % 2 === 0 ? 'nwse-resize' : 'nesw-resize')
          if (tool === 'crop' && shot.crop !== null) {
            const h = hitHandle(cropCorners(shot.crop), p, tol)
            if (h >= 0) cursor = corner(h)
            else if (p.x >= shot.crop.x && p.x <= shot.crop.x + shot.crop.w
              && p.y >= shot.crop.y && p.y <= shot.crop.y + shot.crop.h) cursor = 'move'
          }
          if (cursor === '' && sel >= 0) {
            const h = hitHandle(handlesOf(marks[sel]), p, tol)
            if (h >= 0) cursor = marks[sel].type === 'arrow' ? 'crosshair' : corner(h)
          }
          if (cursor === '' && tool === 'move' && hitMark(marks, p, tol) >= 0) cursor = 'move'
          if (cursor === '' && tool === 'text' && hitMark(marks, p, tol) >= 0) cursor = 'text'
        }
        if (stage.style.cursor !== cursor) stage.style.cursor = cursor
      }

      const onPointerDown = (event) => {
        if (event.button !== 0 && event.button !== 1) return
        if (confirm !== null) setConfirm(null)
        // The first press away from an open text box commits it and does nothing else.
        if (pending !== null) {
          event.preventDefault()
          pushText()
          return
        }
        const stage = stageRef.current
        if (stage !== null) {
          const rect = stage.getBoundingClientRect()
          vpRef.current = { w: rect.width, h: rect.height, left: rect.left, top: rect.top }
        }
        const p = imagePoint(event.clientX, event.clientY)
        const tol = GRAB_PX / viewRef.current.scale
        const target = event.currentTarget
        const capture = () => {
          try {
            target.setPointerCapture(event.pointerId)
          } catch {
            /* capture is a nicety; the gesture still works without it */
          }
        }
        const start = (gesture) => {
          gestureRef.current = { fromX: event.clientX, fromY: event.clientY, moved: false, ...gesture }
          capture()
        }
        const pan = () => start({ kind: 'pan', base: { ...(targetRef.current ?? viewRef.current) }, onPicture: onPictureAt(p) })
        if (event.button === 1 || spaceRef.current === true || p === null) {
          event.preventDefault()
          pan()
          return
        }
        if (tool === 'crop') {
          const crop = shot.crop
          if (crop !== null) {
            const h = hitHandle(cropCorners(crop), p, tol)
            if (h >= 0) {
              editRef.current = { marks, crop }
              start({ kind: 'crop-resize', handle: h })
              return
            }
            if (p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
              editRef.current = { marks, crop }
              start({ kind: 'crop-move', from: p, base: crop })
              return
            }
          }
          editRef.current = { marks, crop: null }
          start({ kind: 'crop-new', from: clampPoint(p) })
          return
        }
        if (sel >= 0) {
          const h = hitHandle(handlesOf(marks[sel]), p, tol)
          if (h >= 0) {
            editRef.current = { marks, crop: shot.crop }
            start({ kind: 'resize', index: sel, handle: h })
            return
          }
        }
        if (tool === 'move') {
          const hit = hitMark(marks, p, tol)
          if (hit >= 0) {
            setSelected(hit)
            editRef.current = { marks, crop: shot.crop }
            start({ kind: 'drag-mark', index: hit, from: p, base: marks[hit] })
            return
          }
          if (sel >= 0) setSelected(-1)
          pan()
          return
        }
        if (tool === 'text') {
          // Without this the mousedown that follows moves focus off the new input.
          event.preventDefault()
          const hit = hitMark(marks, p, tol)
          if (hit >= 0 && marks[hit].type === 'text') openText(p, hit)
          else if (onPictureAt(p)) openText(p)
          return
        }
        if (onPictureAt(p) === false) {
          pan()
          return
        }
        setSelected(-1)
        draftRef.current = tool === 'pen'
          ? { type: 'pen', points: [p.x, p.y], color, width: lineWidth }
          : { type: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color, width: lineWidth }
        start({ kind: 'draw' })
        schedule()
      }

      const onPointerMove = (event) => {
        const gesture = gestureRef.current
        if (gesture === null) {
          hoverCursor(event)
          return
        }
        const dx = event.clientX - gesture.fromX
        const dy = event.clientY - gesture.fromY
        if (gesture.moved === false && Math.abs(dx) + Math.abs(dy) > 3) {
          gesture.moved = true
          if (gesture.kind === 'pan' && stageRef.current !== null) stageRef.current.dataset.drag = 'true'
        }
        if (gesture.kind === 'pan') {
          if (gesture.moved !== true) return
          userRef.current = true
          targetRef.current = null
          viewRef.current = { scale: gesture.base.scale, x: gesture.base.x + dx, y: gesture.base.y + dy }
          schedule()
          return
        }
        const p = imagePoint(event.clientX, event.clientY)
        if (p === null) return
        if (gesture.kind === 'draw') {
          const draft = draftRef.current
          if (draft === null) return
          if (draft.type === 'pen') draft.points.push(p.x, p.y)
          else {
            draft.x1 = p.x
            draft.y1 = p.y
          }
          schedule()
          return
        }
        const edit = editRef.current
        if (edit === null || gesture.moved !== true) return
        if (gesture.kind === 'crop-new') edit.crop = rectOf(gesture.from, clampPoint(p))
        else if (gesture.kind === 'crop-resize') edit.crop = resizeCrop(shot.crop, gesture.handle, clampPoint(p))
        else if (gesture.kind === 'crop-move') edit.crop = moveCrop(gesture.base, p.x - gesture.from.x, p.y - gesture.from.y, natural)
        else if (gesture.kind === 'drag-mark') {
          edit.marks = replaceAt(marks, gesture.index, moveMark(gesture.base, p.x - gesture.from.x, p.y - gesture.from.y))
        } else if (gesture.kind === 'resize') {
          edit.marks = replaceAt(marks, gesture.index, resizeMark(marks[gesture.index], gesture.handle, p))
        }
        schedule()
      }

      /** A second still tap within 400ms and 20px of the first. */
      const doubleTap = (event) => {
        const now = Date.now()
        const last = tapRef.current
        if (last !== null && now - last.at < 400
          && Math.abs(event.clientX - last.x) < 20 && Math.abs(event.clientY - last.y) < 20) {
          tapRef.current = null
          return true
        }
        tapRef.current = { at: now, x: event.clientX, y: event.clientY }
        return false
      }

      /**
       * End a gesture. A still tap is either a click on the dark (which closes),
       * half of a double tap (which fits, or edits a text mark), or nothing.
       * Double tap is detected here rather than left to the native `dblclick`
       * because pointer capture is exactly the kind of retargeting that stops
       * the browser synthesising that event.
       */
      const onPointerUp = (event) => {
        const gesture = gestureRef.current
        gestureRef.current = null
        if (stageRef.current !== null) stageRef.current.dataset.drag = 'false'
        if (gesture === null) return
        if (gesture.kind === 'draw') {
          const draft = draftRef.current
          draftRef.current = null
          if (draft !== null && markIsVisible(draft, viewRef.current.scale)) {
            commit({ marks: marks.concat([draft]), crop: shot.crop })
            // A fresh box or arrow is usually adjusted right away: keep its handles up.
            if (draft.type !== 'pen') setSelected(marks.length)
          }
          schedule()
          return
        }
        if (gesture.kind !== 'pan') {
          const edit = editRef.current
          editRef.current = null
          if (gesture.moved === true && edit !== null) {
            if (gesture.kind === 'crop-new') {
              if (edit.crop !== null && edit.crop.w >= 4 && edit.crop.h >= 4) {
                commit({ marks, crop: edit.crop })
                setStatus({ bad: false, text: '已框选 ' + Math.round(edit.crop.w) + '×' + Math.round(edit.crop.h)
                  + (snip ? ' · Enter 发到输入框' : '') })
              }
            } else {
              commit({ marks: edit.marks, crop: edit.crop })
            }
          } else if (gesture.kind === 'drag-mark' && doubleTap(event) && marks[gesture.index]?.type === 'text') {
            openText(null, gesture.index)
          }
          schedule()
          return
        }
        if (gesture.moved === true) return
        if (doubleTap(event)) {
          toFit()
          return
        }
        if (closesOnTap({ tool, moved: false, crop: shot.crop, onPicture: gesture.onPicture, dirty, snip })) close()
      }

      const onKey = (event) => {
        const tag = event.target instanceof Element ? event.target.tagName : ''
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const mod = event.ctrlKey === true || event.metaKey === true
        const key = typeof event.key === 'string' ? event.key : ''
        // A focused toolbar button keeps its own Enter / Space activation.
        if (tag === 'BUTTON' && (key === 'Enter' || key === ' ')) return
        const handled = () => {
          event.preventDefault()
          event.stopPropagation()
        }
        if (key === ' ') {
          spaceRef.current = true
          handled()
          return
        }
        if (key === 'Escape') {
          handled()
          if (confirm !== null) discard()
          else if (gestureRef.current !== null) {
            gestureRef.current = null
            draftRef.current = null
            editRef.current = null
            schedule()
          } else if (pending !== null) setPending(null)
          else if (sel >= 0) setSelected(-1)
          else requestClose()
          return
        }
        if (mod) {
          const lower = key.toLowerCase()
          if (lower === 'z') {
            handled()
            if (event.shiftKey === true) redo()
            else undo()
          } else if (lower === 'y') {
            handled()
            redo()
          } else if (lower === 's') {
            handled()
            void doSave()
          } else if (lower === 'c') {
            const text = typeof window.getSelection === 'function' ? String(window.getSelection() ?? '') : ''
            if (text !== '') return
            handled()
            void doCopy()
          }
          return
        }
        if (key === 'Enter') {
          handled()
          if (busy !== true) void doSend()
          return
        }
        if (key === 'Delete' || key === 'Backspace') {
          handled()
          removeSelected()
          return
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          if (items.length < 2) return
          handled()
          go(key === 'ArrowLeft' ? -1 : 1)
          return
        }
        if (key === '+' || key === '=') bump(1.25)
        else if (key === '-' || key === '_') bump(1 / 1.25)
        else if (key === '0') toActual()
        else if (key === 'f' || key === 'F') toFit()
        else if (TOOL_KEYS[key.toLowerCase()] !== undefined) pickTool(TOOL_KEYS[key.toLowerCase()])
        else return
        handled()
      }
      const keyRef = React.useRef(onKey)
      keyRef.current = onKey

      // Capture phase, so Esc and the tool letters never also reach the
      // conversation underneath (where Esc may stop a running turn).
      React.useEffect(() => {
        const down = (event) => keyRef.current(event)
        const up = (event) => {
          if (event.key === ' ') spaceRef.current = false
        }
        window.addEventListener('keydown', down, true)
        window.addEventListener('keyup', up, true)
        return () => {
          window.removeEventListener('keydown', down, true)
          window.removeEventListener('keyup', up, true)
        }
      }, [])

      const button = (key, label, onClick, options = {}) => React.createElement('button', {
        key,
        type: 'button',
        onClick,
        disabled: (options.busy === true && busy === true) || options.disabled === true,
        'data-on': options.on === true ? 'true' : 'false',
        'data-strong': options.strong === true ? 'true' : 'false',
        title: options.title,
      }, label)

      const sendTitle = composer === null
        ? '没找到输入框：会改为复制到剪贴板（Enter）'
        : '把当前图片（含标注、按裁剪区域）放进输入框作为附件（Enter）'
      const toolbar = React.createElement('div', { key: 'tools', className: 'dsh-imgvw-tools' }, [
        React.createElement('span', { key: 'draw', className: 'dsh-imgvw-group' },
          DRAW_TOOLS.map((id) => button(id, toolLabel(id), () => pickTool(id), {
            on: tool === id,
            title: toolLabel(id) + '（' + toolKey(id) + '）' + (id === 'move' ? '：拖空白处平移，点标记可选中、拖动、拉角改大小' : ''),
          }))),
        React.createElement('span', { key: 'colors', className: 'dsh-imgvw-group' },
          COLORS.map((value) => React.createElement('button', {
            key: value,
            type: 'button',
            className: 'dsh-imgvw-swatch',
            style: { background: value },
            'data-on': color === value ? 'true' : 'false',
            title: sel >= 0 ? '改选中标记的颜色' : value,
            onClick: () => pickColor(value),
          }))),
        React.createElement('span', { key: 'widths', className: 'dsh-imgvw-group' },
          WIDTHS.map((value, i) => button('w' + value, ['细', '中', '粗'][i], () => pickWidth(value), {
            on: lineWidth === value, title: '线宽 / 字号',
          }))),
        React.createElement('span', { key: 'steps', className: 'dsh-imgvw-group' }, [
          button('undo', '撤销', undo, { disabled: stepAt <= 0, title: 'Ctrl+Z' }),
          button('redo', '重做', redo, { disabled: stepAt >= track.length - 1, title: 'Ctrl+Shift+Z / Ctrl+Y' }),
          button('delete', '删除', removeSelected, { disabled: sel < 0, title: '删除选中的标记（Delete）' }),
          button('clear', '清空', () => {
            commit(EMPTY_SHOT)
            setSelected(-1)
          }, { disabled: marks.length === 0 && shot.crop === null, title: '清掉所有标记和裁剪' }),
        ]),
        React.createElement('span', { key: 'zoom', className: 'dsh-imgvw-group' }, [
          button('out', '−', () => bump(1 / 1.25), { title: '缩小（-）' }),
          React.createElement('span', { key: 'value', ref: zoomRef, className: 'dsh-imgvw-zoomval' }, '100%'),
          button('in', '+', () => bump(1.25), { title: '放大（+）' }),
          button('fit', '适应', toFit, { title: '适应窗口（F，或双击）' }),
          button('actual', '1:1', toActual, { title: '原始大小（0）' }),
        ]),
        React.createElement('span', { key: 'out', className: 'dsh-imgvw-group' }, [
          button('send', busy === true ? '处理中…' : '发到输入框', () => void doSend(), { strong: true, busy: true, title: sendTitle }),
          button('copy', '复制', () => void doCopy(), { busy: true, title: '复制图片到剪贴板（Ctrl+C）' }),
          button('save', '保存', () => void doSave(), { busy: true, title: '存进截图目录（Ctrl+S）' }),
          button('close', '关闭 (Esc)', requestClose, {}),
        ]),
      ])

      const hint = snip
        ? '拖动框选区域 · 拖角调整 · Enter 发到输入框 · Ctrl+C 复制 · Esc 取消'
        : '滚轮缩放 · 拖动平移 · Shift/Ctrl+滚轮 上下/左右 · 双击适应 · 点图外或 Esc 关闭'
      const stopPointer = (event) => event.stopPropagation()

      // The overlay is portalled to the body, but React still bubbles its
      // events through the tree it was declared in — a tool row, a message, the
      // composer. None of them may react to a click made inside the viewer
      // (a row header toggling would even unmount it).
      return toDocument(React.createElement('div', {
        ref: rootRef,
        className: 'dsh-imgvw-backdrop',
        tabIndex: -1,
        role: 'dialog',
        'aria-label': '图片查看器',
        onPointerDown: stopPointer,
        onPointerUp: stopPointer,
        onMouseDown: stopPointer,
        onMouseUp: stopPointer,
        onDoubleClick: stopPointer,
        onKeyDown: stopPointer,
        onKeyUp: stopPointer,
        // The bars own their own space, so only a click that lands on the
        // backdrop itself — its padding — counts as the dark.
        onClick: (event) => {
          event.stopPropagation()
          if (event.target !== event.currentTarget) return
          if (closesOnTap({ tool, moved: false, crop: shot.crop, onPicture: false, dirty, snip })) close()
        },
      }, [
        React.createElement('div', { key: 'top', className: 'dsh-imgvw-top' }, [
          React.createElement('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-imgvw-close',
            onClick: requestClose,
            title: '关闭查看器，回到对话（Esc）',
          }, '✕ 关闭'),
          React.createElement('span', { key: 'name', className: 'dsh-imgvw-top-name', title: item.shown }, item.shown),
          items.length > 1
            ? React.createElement('span', { key: 'count', className: 'dsh-imgvw-hint' }, (index + 1) + ' / ' + items.length)
            : null,
          item.pixels ? React.createElement('span', { key: 'pixels', className: 'dsh-imgvw-hint' }, item.pixels) : null,
          React.createElement('span', {
            key: 'hint',
            className: 'dsh-imgvw-hint',
            title: '空格或中键按住拖动：任何工具下都能平移 · V/R/E/A/P/T/C 切工具 · Delete 删除选中 · '
              + 'Ctrl+Z 撤销 · Ctrl+S 保存 · ←/→ 切换图片',
          }, hint),
        ]),
        React.createElement('div', {
          key: 'stage',
          ref: stageRef,
          className: 'dsh-imgvw-stage',
          'data-draw': tool !== 'move' ? 'true' : 'false',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        }, [
          React.createElement('div', { key: 'wrap', ref: wrapRef, className: 'dsh-imgvw-canvas' }, [
            React.createElement('img', {
              key: 'img:' + index,
              ref: imgRef,
              className: 'dsh-imgvw-big',
              src: item.src,
              alt: item.shown,
              draggable: false,
              // Hidden until the first fit is written, which is what a flash of an oversized image is.
              style: { opacity: ready ? 1 : 0 },
              onLoad: (event) => {
                const w = event.target.naturalWidth
                const h = event.target.naturalHeight
                if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return
                const n = { w, h }
                setNatural(n)
                liveRef.current = { ...liveRef.current, natural: n }
                if (userRef.current !== true) {
                  viewRef.current = { scale: fitScale(n, vpRef.current), x: 0, y: 0 }
                  targetRef.current = null
                }
                paintRef.current()
                setReady(true)
              },
            }),
          ]),
          React.createElement('canvas', { key: 'layer', ref: layerRef, className: 'dsh-imgvw-layer' }),
          items.length > 1
            ? [
              React.createElement('button', {
                key: 'prev', type: 'button', className: 'dsh-imgvw-nav', 'data-side': 'prev',
                title: '上一张（←）', onPointerDown: stopPointer, onClick: () => go(-1),
              }, '‹'),
              React.createElement('button', {
                key: 'next', type: 'button', className: 'dsh-imgvw-nav', 'data-side': 'next',
                title: '下一张（→）', onPointerDown: stopPointer, onClick: () => go(1),
              }, '›'),
            ]
            : null,
          shot.crop !== null && (snip || tool === 'crop')
            ? React.createElement('div', {
              key: 'snip',
              ref: snipRef,
              className: 'dsh-imgvw-float dsh-imgvw-snip',
              style: { visibility: 'hidden', left: '0px', top: '0px' },
              onPointerDown: stopPointer,
            }, [
              button('send', '发到输入框 ⏎', () => void doSend(), { strong: true, busy: true, title: sendTitle }),
              button('copy', '复制', () => void doCopy(), { busy: true }),
              button('save', '保存', () => void doSave(), { busy: true }),
              button('uncrop', '取消框选', () => commit({ marks, crop: null }), {}),
            ])
            : null,
          pending === null
            ? null
            : React.createElement('input', {
              key: 'input',
              ref: inputRef,
              className: 'dsh-imgvw-input',
              value: pending.text,
              placeholder: '输入文字后回车',
              style: (() => {
                const view = viewRef.current
                const o = originOf(view, natural, vpRef.current)
                return {
                  color: pending.color,
                  left: (o.x + pending.x * view.scale) + 'px',
                  top: (o.y + pending.y * view.scale) + 'px',
                  fontSize: Math.max(11, pending.size * view.scale) + 'px',
                }
              })(),
              onPointerDown: stopPointer,
              onChange: (event) => setPending({ ...pending, text: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  pushText()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setPending(null)
                }
              },
              onBlur: pushText,
            }),
          confirm === null
            ? null
            : React.createElement('div', { key: 'confirm', className: 'dsh-imgvw-float dsh-imgvw-confirm', onPointerDown: stopPointer }, [
              React.createElement('span', { key: 'text' }, '标注还没有复制、保存或发出'),
              button('keep', '继续编辑', () => setConfirm(null), {}),
              button('copy', '复制后离开', () => {
                void doCopy().then((ok) => {
                  if (ok === true) discard()
                })
              }, { strong: true }),
              button('drop', '放弃（Esc）', discard, {}),
            ]),
          status === null
            ? null
            : React.createElement('div', {
              key: 'status',
              className: 'dsh-imgvw-float dsh-imgvw-toast',
              'data-bad': status.bad === true ? 'true' : 'false',
              onPointerDown: stopPointer,
            }, [
              React.createElement('span', { key: 'text' }, status.text),
              typeof status.path === 'string'
                ? button('copypath', '复制路径', () => {
                  void copyText(status.path).then(
                    () => setStatus({ bad: false, text: '已复制路径' }),
                    (error) => setStatus({ bad: true, text: failureOf(error) }),
                  )
                }, {})
                : null,
              button('dismiss', '✕', () => setStatus(null), { title: '关掉提示' }),
            ]),
        ]),
        toolbar,
      ]))
    }

    /** The label of one gallery source. */
    function labelOf(image) {
      if (isRecord(image.attachment)) {
        if (typeof image.label === 'string' && image.label !== '') return image.label
        if (typeof image.attachment.name === 'string' && image.attachment.name !== '') return image.attachment.name
      }
      if (isRecord(image.preview) && typeof image.preview.name === 'string' && image.preview.name !== '') return image.preview.name
      return '图片'
    }

    /** The intrinsic size a gallery source already knows, before any byte arrives. */
    function dimsOf(image) {
      const source = isRecord(image.attachment) ? image.attachment : isRecord(image.preview) ? image.preview : null
      if (source === null) return null
      return typeof source.width === 'number' && typeof source.height === 'number' && source.width > 0 && source.height > 0
        ? { w: source.width, h: source.height }
        : null
    }

    /** "W×H", plus the original size when the store downscaled the picture before the model saw it. */
    function pixelsOf(image) {
      const dims = dimsOf(image)
      if (dims === null) return null
      const original = isRecord(image.attachment) && isRecord(image.attachment.originalDimensions)
        && typeof image.attachment.originalDimensions.width === 'number'
        ? image.attachment.originalDimensions.width + '×' + image.attachment.originalDimensions.height
        : null
      return dims.w + '×' + dims.h + (original === null ? '' : '（原图 ' + original + '）')
    }

    /** A stable identity for one gallery source. */
    function sourceKey(image) {
      if (isRecord(image.attachment)) return 'a:' + image.attachment.attachmentId
      if (isRecord(image.preview)) return 'p:' + image.preview.url
      return 'x'
    }

    /** The URL a source can show without waiting: a local preview's own, or the loader's warm cache. */
    function warmUrl(image, load) {
      if (isRecord(image.preview) && typeof image.preview.url === 'string') return image.preview.url
      if (isRecord(image.attachment) && typeof load === 'function' && typeof load.peek === 'function') {
        const peeked = load.peek(image.attachment)
        return typeof peeked === 'string' ? peeked : null
      }
      return null
    }

    /** Mark a transparent container so it renders over a checkerboard. */
    function detectChecker(node) {
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
            node.dataset.checker = 'true'
            return
          }
        }
      } catch {
        /* an unreadable canvas just means no checkerboard */
      }
    }

    /**
     * One gallery of images: thumbnails in the conversation, the viewer on click.
     *
     * Sources are durable attachment references (resolved through the
     * session-authorized loader, `peek` first) or local submission previews.
     * A lone image renders large with its known width/height attributes, so a
     * late-loading picture lands with zero layout shift — the v1.4.1 fix for the
     * chat's stick-to-bottom logic reading an image reflow as a reader scroll.
     */
    function ImageGallery(props) {
      const images = Array.isArray(props.images)
        ? props.images.filter((image) => isRecord(image) && (isRecord(image.attachment) || isRecord(image.preview)))
        : []
      const load = props.loadImage
      const key = images.map(sourceKey).join('|')
      const [urls, setUrls] = React.useState(() => images.map((image) => warmUrl(image, load)))
      const [failed, setFailed] = React.useState(() => images.map(() => false))
      const [attempt, setAttempt] = React.useState(0)
      const [open, setOpen] = React.useState(-1)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const warm = images.map((image) => warmUrl(image, load))
        setUrls(warm)
        setFailed(images.map(() => false))
        images.forEach((image, i) => {
          if (warm[i] !== null || isRecord(image.attachment) === false) return
          const fail = () => {
            if (alive) setFailed((prev) => replaceAt(prev, i, true))
          }
          if (typeof load !== 'function') {
            fail()
            return
          }
          Promise.resolve(load(image.attachment)).then((value) => {
            if (alive === false) return
            if (typeof value === 'string') setUrls((prev) => replaceAt(prev, i, value))
            else fail()
          }, fail)
        })
        return () => { alive = false }
      }, [key, attempt])

      if (images.length === 0) return null
      const variant = props.thumbnail === true ? 'thumb' : props.compact === true || images.length > 1 ? 'tile' : 'single'
      const shownOf = typeof props.shownOf === 'function' ? props.shownOf : labelOf
      const viewable = []
      images.forEach((image, i) => {
        if (typeof urls[i] === 'string') viewable.push({ at: i, src: urls[i], shown: shownOf(image), pixels: pixelsOf(image) })
      })

      const frames = images.map((image, i) => {
        const src = failed[i] === true ? null : urls[i] ?? null
        const dims = dimsOf(image)
        const label = labelOf(image)
        if (src === null) {
          return React.createElement('button', {
            key: sourceKey(image) + ':' + i,
            type: 'button',
            className: 'dsh-imgvw-frame',
            'data-variant': variant,
            title: failed[i] === true ? '加载失败，点击重试' : '正在载入',
            onClick: () => {
              if (failed[i] === true) setAttempt((value) => value + 1)
            },
          }, React.createElement('div', {
            className: 'dsh-imgvw-skel',
            style: variant === 'single' && dims !== null ? { aspectRatio: String(dims.w / dims.h) } : undefined,
          }, React.createElement('span', {
            className: 'dsh-imgvw-skel-label',
            'data-bad': failed[i] === true ? 'true' : 'false',
          }, failed[i] === true ? (variant === 'single' ? '图片加载失败，点击重试' : '重试') : (variant === 'single' ? '正在载入画面…' : ''))))
        }
        return React.createElement('button', {
          key: sourceKey(image) + ':' + i,
          type: 'button',
          className: 'dsh-imgvw-frame',
          'data-variant': variant,
          title: label + ' · 点击放大查看、标注',
          'aria-label': '查看 ' + label,
          onClick: () => setOpen(viewable.findIndex((entry) => entry.at === i)),
        }, React.createElement('img', {
          className: 'dsh-imgvw-img',
          src,
          alt: label,
          width: variant === 'single' && dims !== null ? dims.w : undefined,
          height: variant === 'single' && dims !== null ? dims.h : undefined,
          onLoad: variant === 'single' && (typeof image.attachment?.mediaType !== 'string'
            || /png|webp|gif/i.test(image.attachment.mediaType))
            ? (event) => detectChecker(event.target)
            : undefined,
        }))
      })

      return React.createElement('div', {
        ref: rootRef,
        className: 'dsh-imgvw-gallery',
        'data-align': props.align === 'end' ? 'end' : 'start',
      }, [
        ...frames,
        open >= 0 && open < viewable.length
          ? React.createElement(ImageZoomOverlay, {
            key: 'overlay',
            items: viewable,
            index: open,
            anchor: rootRef.current,
            onClose: () => setOpen(-1),
          })
          : null,
      ])
    }

    /**
     * The one metadata line under a tool card's picture: identity, size, format, actions.
     *
     * It is a separate component so the gallery's own re-render never rebuilds the
     * action buttons.
     */
    function MediaBar(props) {
      const parts = []
      parts.push(React.createElement('span', {
        key: 'dot',
        className: 'dsh-imgvw-dot',
        'data-live': props.live ? 'true' : 'false',
        'data-bad': props.bad ? 'true' : 'false',
        'data-ok': props.ok && props.live !== true ? 'true' : 'false',
      }))
      parts.push(React.createElement('span', {
        key: 'name',
        className: 'dsh-imgvw-name',
        title: props.shown,
      }, props.shown))
      const add = (key, value) => {
        if (value === null || value === undefined) return
        parts.push(React.createElement('span', { key: key + '-sep', className: 'dsh-imgvw-sep' }, '·'))
        parts.push(React.createElement('span', { key, className: 'dsh-imgvw-stat' }, value))
      }
      add('pixels', props.pixels)
      add('bytes', props.bytes)
      add('format', props.format)
      const link = (key, label, onClick) => {
        if (onClick === null || onClick === undefined) return
        parts.push(React.createElement('span', { key: key + '-sep', className: 'dsh-imgvw-sep' }, '·'))
        parts.push(React.createElement('button', { key, type: 'button', className: 'dsh-imgvw-link', onClick }, label))
      }
      link('copy', props.copied ? '已复制路径' : '复制路径', props.onCopy)
      link('open', '在编辑器中打开', props.onOpenFile)
      return React.createElement('div', { className: 'dsh-imgvw-bar' }, parts)
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
     * A claimed tool's settled card: the gallery of its result images plus one
     * metadata line. Every stat renders straight off the attachment reference.
     */
    function AttachmentPreview(props) {
      const spec = props.spec
      const first = spec.atts[0]
      const path = spec.path
      const label = TOOL_LABELS[props.toolName] === undefined ? props.toolName : TOOL_LABELS[props.toolName]
      const [copied, setCopied] = React.useState(false)
      const [copyNote, setCopyNote] = React.useState(null)
      const shown = path !== null
        ? displayPathOf(path, props.cwd)
        : typeof first.name === 'string' && first.name !== '' ? first.name : label
      const single = spec.atts.length === 1
      const images = spec.atts.map((attachment) => ({ attachment }))
      const format = typeof first.mediaType === 'string' && first.mediaType.startsWith('image/')
        ? first.mediaType.slice('image/'.length).toUpperCase()
        : null
      const noteParts = []
      if (spec.text !== '') noteParts.push(spec.text)
      if (copyNote !== null) noteParts.push(copyNote)

      const copyPath = path === null ? null : () => {
        copyText(shown).then(
          () => setCopied(true),
          () => {
            console.log('image preview path', shown)
            setCopyNote('无法自动复制，路径已打到控制台')
          },
        )
      }

      return React.createElement('div', { className: 'dsh-imgvw-root' }, [
        React.createElement(ImageGallery, {
          key: 'gallery',
          images,
          loadImage: props.loadImage,
          align: 'start',
          shownOf: (image) => (single ? shown : labelOf(image) === '图片' ? label : labelOf(image)),
        }),
        React.createElement(MediaBar, {
          key: 'bar',
          shown: single ? shown : shown + ' · 共 ' + spec.atts.length + ' 张',
          live: false,
          bad: false,
          ok: true,
          pixels: single ? pixelsOf({ attachment: first }) : null,
          bytes: single ? formatBytes(first.bytes) : null,
          format: single ? format : null,
          copied,
          onCopy: copyPath,
          onOpenFile: path !== null && typeof props.openFile === 'function' ? () => props.openFile(path) : null,
        }),
        noteParts.length === 0
          ? null
          : React.createElement('div', {
            key: 'note',
            className: 'dsh-imgvw-bar',
            style: { opacity: 0.75 },
          }, noteParts.join(' · ')),
      ])
    }

    /** What the skeleton says while a claimed call runs. */
    function liveTextOf(toolName) {
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
          React.createElement('div', { key: 'frame', className: 'dsh-imgvw-frame', 'data-variant': 'single' }, [
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
     * The composer's ✂ button: freeze the desktop, drag a region, Enter.
     *
     * The grab opens straight into region selection; the floating bar next to
     * the region (or Enter) puts the picture into this composer as an
     * attachment. The delay menu exists because half of what is worth capturing
     * is a state that closes the moment the composer gets a click; a
     * right-click opens it, so the button itself stays one glyph wide.
     */
    function ShotCaptureButton() {
      const [shot, setShot] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [menu, setMenu] = React.useState(false)
      const [delay, setDelay] = React.useState(storedDelay)
      const urlRef = React.useRef(null)
      const anchorRef = React.useRef(null)

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

      return React.createElement('span', { ref: anchorRef, style: { position: 'relative', display: 'inline-flex' } }, [
        React.createElement('button', {
          key: 'grab',
          type: 'button',
          className: 'dsh-shot-capture',
          disabled: busy,
          title: '截图：' + (delay === 0 ? '立即' : delay + ' 秒后') + '抓全屏，框选后回车放进输入框（右键选延时）',
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
            snip: true,
            initialTool: 'crop',
            anchor: anchorRef.current,
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
      const [peek, setPeek] = React.useState(-1)

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
          setNote('清理完成：删除 ' + reply.removed + ' 个，释放 ' + (formatBytes(reply.freed) ?? '0 B'))
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
              '在查看器里点「保存」的图片都落在这个目录里。清理策略只删除本插件按 shot- 命名的文件，'
              + '把目录指到别处也不会被误删。保留天数、数量与体积上限在下方本插件的设置项里改。'),
            React.createElement('p', { key: 'dir', className: 'dsh-shot-dir' },
              info === null ? '正在读取截图目录…' : info.dir),
            info === null
              ? null
              : React.createElement('p', { key: 'policy', className: 'dsh-shot-note' },
                '保留 ' + (info.policy.days > 0 ? info.policy.days + ' 天' : '不按天数')
                + ' · 最多 ' + info.policy.maxFiles + ' 个'
                + ' · 最多 ' + formatBytes(info.policy.maxBytes)
                + ' · 当前 ' + total + ' 张 / ' + (formatBytes(used) ?? '0 B')
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
            total === 0 ? '还没有保存过截图。在图片查看器里点「保存」，或用输入框旁的「✂ 截图」。' : '本页没有更多截图。')
          : React.createElement('div', { key: 'grid', className: 'dsh-shot-grid' }, items.map((item, i) => React.createElement('div', {
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
              onClick: () => setPeek(i),
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
        peek < 0 || peek >= items.length
          ? null
          : React.createElement(ImageZoomOverlay, {
            key: 'peek',
            items: items.map((item) => ({ src: item.url, shown: item.name, pixels: null })),
            index: peek,
            onClose: () => setPeek(-1),
          }),
      ])
    }

    const inject = ['slots']

    /**
     * Wire the plugin into the page.
     *
     * - the image galleries of the official image positions, at priority -1;
     * - the whole card of every image-bearing tool without an official image
     *   row, at priority -1 (if one of our entries ever throws, the slot's
     *   error boundary abdicates it and the previous card returns);
     * - the composer's ✂ button and the 截图与标注 settings page.
     */
    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-read-image-preview'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        style.remove()
      })

      // Remember which composer had focus last: a viewer opened far from any
      // composer sends its picture there.
      if (typeof document.addEventListener === 'function') {
        const onFocus = (event) => {
          const target = event.target
          if (target instanceof Element) {
            const editor = target.closest(EDITOR_SELECTOR)
            if (editor !== null) lastEditor = editor
          }
        }
        document.addEventListener('focusin', onFocus)
        ctx.effect(() => () => {
          document.removeEventListener('focusin', onFocus)
          lastEditor = null
        })
      }

      for (const name of IMAGE_SLOTS) {
        ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -1 }, ImageGallery))
      }

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
