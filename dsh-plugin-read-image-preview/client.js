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

    const HOST_ROUTE = '/read-image-preview/resolve'

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
.dsh-imgvw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  background: rgba(8, 8, 10, 0.86);
  backdrop-filter: blur(2px);
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
.dsh-imgvw-big {
  max-width: none;
  max-height: none;
  will-change: transform;
}
.dsh-imgvw-x {
  position: absolute;
  top: 14px;
  right: 18px;
  z-index: 1;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.dsh-imgvw-x:hover {
  background: rgba(255, 255, 255, 0.22);
}
.dsh-imgvw-legend {
  position: absolute;
  left: 50%;
  top: 20px;
  transform: translateX(-50%);
  z-index: 1;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.82);
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
  pointer-events: none;
}
.dsh-imgvw-caption {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  line-height: 1.6;
}
.dsh-imgvw-caption b {
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.dsh-imgvw-caption button {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 6px;
  color: inherit;
  font: inherit;
  padding: 1px 8px;
  cursor: pointer;
}
.dsh-imgvw-caption button:hover {
  background: rgba(255, 255, 255, 0.14);
}
`

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

    /**
     * Decide what the card should render for one call.
     *
     * `file` when the call itself names a path (previewable before settle);
     * otherwise `attachment` when the settled content carries image refs —
     * collected together with the first text line, which becomes the note row.
     */
    function imageSpecOf(block) {
      const path = imagePathOf(block)
      if (path !== null) return { mode: 'file', path, atts: [], text: '' }
      const content = isRecord(block) && Array.isArray(block.content) ? block.content : null
      if (content === null) return null
      const atts = []
      let text = ''
      for (const item of content) {
        if (!isRecord(item)) continue
        if (item.type === 'image' && isRecord(item.attachment)
          && typeof item.attachment.attachmentId === 'string') {
          atts.push(item.attachment)
        } else if (item.type === 'text' && typeof item.text === 'string' && text === '') {
          text = String(item.text).split('\n')[0]
        }
      }
      if (atts.length === 0) return null
      return { mode: 'attachment', path: null, atts, text }
    }

    /**
     * Full-screen zoom and pan stage.
     *
     * The picture renders at natural size and is moved entirely by one transform,
     * so zooming is continuous rather than a set of steps. The wheel is consumed
     * only while Ctrl is held and only inside this stage, which is what keeps a
     * zoom gesture from fighting the chat's own scrolling. Zoom is anchored on the
     * cursor: the point under the pointer stays put, so zooming into a detail does
     * not make the user chase it with a drag afterwards.
     */
    function ImageZoomOverlay(props) {
      const [view, setView] = React.useState({ scale: 1, x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const stageRef = React.useRef(null)
      const imgRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const tapRef = React.useRef(null)
      const [natural, setNatural] = React.useState({ w: 0, h: 0 })
      const [vp, setVp] = React.useState({ w: 0, h: 0 })
      const close = props.onClose

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
        ? Math.min(1, (vp.w * 0.97) / natural.w, (vp.h * 0.97) / natural.h)
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

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [close])

      // Registered non-passively: a Ctrl+wheel gesture must not also scroll the page.
      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const onWheel = (event) => {
          if (event.ctrlKey !== true) return
          event.preventDefault()
          settled.current = 'user'
          const rect = stage.getBoundingClientRect()
          const cx = event.clientX - rect.left - rect.width / 2
          const cy = event.clientY - rect.top - rect.height / 2
          const factor = Math.exp(-event.deltaY / 420)
          setView((prev) => {
            const scale = Math.min(8, Math.max(0.05, prev.scale * factor))
            const ratio = scale / prev.scale
            return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio }
          })
        }
        stage.addEventListener('wheel', onWheel, { passive: false })
        return () => stage.removeEventListener('wheel', onWheel)
      }, [])

      const onPointerDown = (event) => {
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
       * Whether a pointer position lands on the picture itself.
       *
       * Testing the live rect rather than the event target is the point: a
       * letterboxed picture leaves stage area above and below (and sometimes
       * beside) itself, and a hit test there reports the stage, so target-based
       * emptiness would treat a click on the picture's own margin as a click on
       * the backdrop.
       */
      const landsOnPicture = (event) => {
        const node = imgRef.current
        if (node === null) return false
        const rect = node.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom
      }

      /**
       * A gesture that never moved: either the first half of a double tap or a
       * click outside the picture, which closes.
       *
       * Double tap is detected here rather than left to the native `dblclick`
       * because the pointer capture this stage takes for dragging is exactly the
       * kind of retargeting that stops the browser synthesising that event.
       */
      const onPointerUp = (event) => {
        const drag = dragRef.current
        dragRef.current = null
        setDragging(false)
        if (drag === null) return
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
        if (landsOnPicture(event) === false) close()
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

      const step = (factor) => setView((prev) => {
        settled.current = 'user'
        const scale = Math.min(8, Math.max(0.05, prev.scale * factor))
        const ratio = scale / prev.scale
        return { scale, x: prev.x * ratio, y: prev.y * ratio }
      })

      return React.createElement('div', {
        className: 'dsh-imgvw-backdrop',
        onDoubleClick: toFit,
      }, [
        React.createElement('button', {
          key: 'x',
          type: 'button',
          className: 'dsh-imgvw-x',
          title: '关闭 (Esc)',
          onClick: close,
        }, '×'),
        React.createElement('div', { key: 'legend', className: 'dsh-imgvw-legend' },
          'Ctrl + 滚轮缩放 · 按住拖动 · 双击适应窗口 · 点图外关闭'),
        React.createElement('div', {
          key: 'stage',
          ref: stageRef,
          className: 'dsh-imgvw-stage',
          'data-drag': dragging ? 'true' : 'false',
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        }, [
          React.createElement('img', {
            key: 'img',
            ref: imgRef,
            className: 'dsh-imgvw-big',
            src: props.src,
            alt: props.shown,
            draggable: false,
            style: {
              transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')',
              opacity: focused ? undefined : 0,
            },
            onLoad: (event) => {
              const w = event.target.naturalWidth
              const h = event.target.naturalHeight
              if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return
              setNatural({ w, h })
            },
          }),
        ]),
        React.createElement('div', { key: 'caption', className: 'dsh-imgvw-caption' }, [
          React.createElement('span', { key: 'name' }, props.shown),
          props.pixels === null ? null : React.createElement('span', { key: 'dims' }, props.pixels),
          React.createElement('span', { key: 'scale' }, [
            '缩放 ',
            React.createElement('b', { key: 'v' }, Math.round(view.scale * 100) + '%'),
          ]),
          React.createElement('button', { key: 'out', type: 'button', onClick: () => step(1 / 1.25) }, '−'),
          React.createElement('button', { key: 'in', type: 'button', onClick: () => step(1.25) }, '+'),
          React.createElement('button', { key: 'fit', type: 'button', onClick: toFit, title: '双击图片同样回到适应窗口' }, '适应窗口'),
          React.createElement('button', { key: 'actual', type: 'button', onClick: toActual }, '100%'),
        ]),
      ])
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
     * The preview card in `file` mode: frame, metadata line, one transient note.
     *
     * The host resolves the path once per call and answers with everything the
     * card needs, so there is exactly one request per rendered call and no state
     * to keep beyond this component's lifetime.
     */
    function FilePreview(props) {
      const block = props.block
      const path = imagePathOf(block)
      const live = isRecord(block) && block.isRunning === true
      const [info, setInfo] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [geometry, setGeometry] = React.useState(null)
      const [checker, setChecker] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        if (path === null) return undefined
        let alive = true
        setInfo(null)
        const params = new URLSearchParams()
        params.set('path', path)
        if (typeof props.cwd === 'string' && props.cwd !== '') params.set('cwd', props.cwd)
        fetch(HOST_ROUTE + '?' + params.toString()).then(
          (response) => response.json(),
          (error) => ({ ok: false, error: String(error) }),
        ).then((value) => {
          if (alive !== true) return
          setInfo(isRecord(value) ? value : { ok: false, error: 'unexpected reply' })
        }, (error) => {
          if (alive === true) setInfo({ ok: false, error: String(error) })
        })
        return () => { alive = false }
      }, [path, props.cwd])

      if (path === null) return null

      const cwd = typeof props.cwd === 'string' ? props.cwd : ''
      const shown = displayPathOf(path, cwd)
      const ok = info !== null && info.ok === true
      const bad = info !== null && info.ok === false
      const failure = bad ? String(info.error) : ''
      const src = ok && typeof info.url === 'string' ? info.url : null
      const bytes = ok ? formatBytes(info.bytes) : null
      const pw = ok && typeof info.width === 'number' ? info.width : null
      const ph = ok && typeof info.height === 'number' ? info.height : null
      const pixels = pw !== null && ph !== null ? pw + '×' + ph : null
      const mediaType = ok && typeof info.mediaType === 'string' ? info.mediaType : ''
      const format = mediaType === '' ? null : mediaType.replace('image/', '').toUpperCase()
      const aspect = pw !== null && ph !== null && ph > 0 ? pw / ph : null
      // v1.4.1：图片未加载就按已知尺寸定死一切布局。晚到的图片在已滚走的区域
      // 加载时不再撑高内容——那会让聊天流的吸底逻辑把浏览器自发的布局位移
      // 误判成用户上滚，从而停止自动跟随最新记录。
      const known = geometry !== null ? geometry : pw !== null && ph !== null && ph > 0 ? { w: pw, h: ph } : null
      const barWidth = known === null
        ? null
        : Math.max(320, Math.min(720, Math.round(160 * (known.w / known.h))))

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

      const copyPath = () => {
        console.log('read_image preview path', shown)
        try {
          const clip = navigator.clipboard
          if (clip && typeof clip.writeText === 'function') {
            clip.writeText(shown).then(
              () => setCopied(true),
              () => setNote('无法自动复制，路径已打到控制台'),
            )
            return
          }
        } catch {
          /* fall through to the console note */
        }
        setNote('无法自动复制，路径已打到控制台')
      }

      const frame = src !== null
        ? React.createElement('div', {
          key: 'frame',
          className: 'dsh-imgvw-frame',
          title: '点击打开缩放视图',
          onClick: () => setOpen(true),
        }, [
          React.createElement('img', {
            key: 'img',
            className: 'dsh-imgvw-img',
            src,
            alt: shown,
            width: pw === null ? undefined : pw,
            height: ph === null ? undefined : ph,
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
              'data-bad': bad ? 'true' : 'false',
            }, bad
              ? '无法预览：' + failure
              : live
                ? (TOOL_LABELS[props.toolName] === undefined
                  ? 'AI 正在查看这张图片…'
                  : TOOL_LABELS[props.toolName] + ' 执行中，画面稍后呈现…')
                : '正在载入预览…'),
          ]),
        ])

      return React.createElement('div', { className: 'dsh-imgvw-root' }, [
        frame,
        React.createElement(MediaBar, {
          key: 'bar',
          shown,
          live,
          bad,
          ok,
          pixels,
          bytes,
          format,
          copied,
          width: barWidth,
          onZoomIn: src === null ? null : () => setOpen(true),
          onCopy: copyPath,
          onOpenFile: typeof props.openFile === 'function' ? () => props.openFile(path) : null,
        }),
        note === null
          ? null
          : React.createElement('div', {
            key: 'note',
            className: 'dsh-imgvw-bar',
            style: { opacity: 0.75 },
          }, note),
        open && src !== null
          ? React.createElement(ImageZoomOverlay, {
            key: 'overlay',
            src,
            shown,
            pixels,
            onClose: () => setOpen(false),
          })
          : null,
      ])
    }

    /**
     * The preview card in `attachment` mode: the settled result owns the picture.
     *
     * Every stat renders straight off the attachment reference, and the URL
     * comes from the session-authorized loader (`peek` first — chat keeps a warm
     * cache of images it already resolved). There is no path semantics, so the
     * copy-path and open-in-editor actions fall away.
     */
    function AttachmentPreview(props) {
      const att = props.spec.atts[0]
      const extra = props.spec.atts.length - 1
      const load = props.loadImage
      const label = TOOL_LABELS[props.toolName] === undefined ? props.toolName : TOOL_LABELS[props.toolName]
      const [url, setUrl] = React.useState(() => (
        typeof load === 'function' && typeof load.peek === 'function' ? load.peek(att) ?? null : null
      ))
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [geometry, setGeometry] = React.useState(null)
      const [checker, setChecker] = React.useState(false)

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

      const shown = typeof att.name === 'string' && att.name !== '' ? att.name : label
      const hasDims = typeof att.width === 'number' && typeof att.height === 'number'
        && att.width > 0 && att.height > 0
      const pixels = hasDims ? att.width + '×' + att.height : null
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

      const src = failed === false && typeof url === 'string' ? url : null
      const frame = src !== null
        ? React.createElement('div', {
          key: 'frame',
          className: 'dsh-imgvw-frame',
          title: '点击打开缩放视图',
          onClick: () => setOpen(true),
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
          copied: false,
          width: barWidth,
          onZoomIn: src === null ? null : () => setOpen(true),
          onCopy: null,
          onOpenFile: null,
        }),
        note === null
          ? null
          : React.createElement('div', {
            key: 'note',
            className: 'dsh-imgvw-bar',
            style: { opacity: 0.75 },
          }, note),
        open && src !== null
          ? React.createElement(ImageZoomOverlay, {
            key: 'overlay',
            src,
            shown,
            pixels,
            onClose: () => setOpen(false),
          })
          : null,
      ])
    }

    /**
     * The one card for every claimed tool.
     *
     * Dispatch order: file preview (call names a path) → attachment preview
     * (settled content carries image refs) → a live skeleton while the call
     * runs → a plain one-line outcome for imageless/failed settled calls, so a
     * claimed row never renders an empty shell.
     */
    function ImageToolCard(props) {
      const block = props.block
      const spec = imageSpecOf(block)
      if (spec !== null && spec.mode === 'file') {
        return React.createElement(FilePreview, {
          block,
          cwd: props.cwd,
          home: props.home,
          openFile: props.openFile,
          toolName: props.toolName,
        })
      }
      if (spec !== null) {
        return React.createElement(AttachmentPreview, {
          spec,
          loadImage: props.loadImage,
          toolName: props.toolName,
        })
      }
      const live = isRecord(block) && block.isRunning === true
      const failed = !!(isRecord(block) && block.isError === true)
      if (live) {
        const liveLabel = TOOL_LABELS[props.toolName] === undefined ? props.toolName : TOOL_LABELS[props.toolName]
        return React.createElement('div', { className: 'dsh-imgvw-root' }, [
          React.createElement('div', { key: 'frame', className: 'dsh-imgvw-frame' }, [
            React.createElement('div', { key: 'skel', className: 'dsh-imgvw-skel' }, [
              React.createElement('span', {
                key: 'label',
                className: 'dsh-imgvw-skel-label',
              }, liveLabel + ' 执行中，画面稍后呈现…'),
            ]),
          ]),
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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
