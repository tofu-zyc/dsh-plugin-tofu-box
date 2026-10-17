/**
 * The viewer contract: what the wheel and the touchpad do, how marks are
 * painted, grabbed, moved and resized, how the stage may be closed, and how a
 * picture reaches the composer.
 *
 * Everything here is decided by code that needs no DOM, so the recording
 * harness below is enough to pin it down; the live page is checked by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const bundlePath = process.env.READ_PREVIEW_CLIENT
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** Records the element tree instead of touching a DOM; hooks are inert. */
const React = {
  createElement: (type, props, ...children) => ({
    type: typeof type === 'function' ? type.name : type,
    props: props ?? {},
    children: children.flat(Infinity).filter(Boolean),
  }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useLayoutEffect: () => {},
  useId: () => 'id',
}

const PURE_NAMES = [
  'ImageZoomOverlay', 'ShotCaptureButton', 'ImageGallery', 'DRAW_TOOLS', 'COLORS', 'WIDTHS', 'IMAGE_SLOTS',
  'gestureOf', 'wheelFactor', 'zoomAbout', 'fitScale', 'originOf',
  'drawMark', 'drawMarks', 'paintCrop', 'rectOf', 'textSize', 'toolLabel',
  'closesOnTap', 'hitMark', 'handlesOf', 'hitHandle', 'moveMark', 'resizeMark',
  'cropCorners', 'resizeCrop', 'moveCrop', 'markIsVisible', 'findComposer', 'pasteImage',
]
const EXPORT_MARK = 'return module.exports'
const markAt = source.lastIndexOf(EXPORT_MARK)
assert.ok(markAt > 0, 'the bundle should end its factory with `return module.exports`')
const instrumented = source.slice(0, markAt)
  + `module.exports.__pure = { ${PURE_NAMES.join(', ')} };\n    `
  + source.slice(markAt)

let registration
new Function('window', 'require', instrumented)(
  { __ModuleLoader__: { load: (options) => { registration = options } } },
  (id) => { if (id === 'react') return React; throw new Error(`unexpected require(${id})`) },
)
const pure = registration.factory((id) => {
  if (id === 'react') return React
  // `toDocument` asks for react-dom and renders inline when the loader refuses.
  throw new Error(`unexpected require(${id})`)
}).__pure

/** Flatten a recorded tree into its text content. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return [node.props?.title, node.props?.children, ...node.children].map(textOf).join(' ')
}

/** Every node in the recorded tree, depth first. */
function walk(node, into = []) {
  if (node === null || node === undefined || Array.isArray(node) === false && typeof node !== 'object') return into
  if (Array.isArray(node)) {
    for (const child of node) walk(child, into)
    return into
  }
  into.push(node)
  for (const child of node.children) walk(child, into)
  return into
}

/** A canvas context that only remembers what it was told to do. */
function spyContext() {
  const calls = []
  const record = (name) => (...args) => { calls.push([name, ...args]) }
  return {
    calls,
    names: () => calls.map((call) => call[0]),
    strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    font: '', textBaseline: '', shadowColor: '', shadowBlur: 0, globalAlpha: 1,
    save: record('save'), restore: record('restore'),
    beginPath: record('beginPath'), closePath: record('closePath'),
    moveTo: record('moveTo'), lineTo: record('lineTo'), stroke: record('stroke'),
    fill: record('fill'), fillRect: record('fillRect'), strokeRect: record('strokeRect'),
    fillText: record('fillText'), ellipse: record('ellipse'), clearRect: record('clearRect'),
    translate: record('translate'), setTransform: record('setTransform'),
    setLineDash: record('setLineDash'), drawImage: record('drawImage'),
  }
}

const overlay = (props) => pure.ImageZoomOverlay({
  src: '/read-image-preview/token',
  shown: 'shot.png',
  pixels: '3200×2000',
  onClose: () => {},
  ...props,
})

test('a plain wheel zooms, Shift moves vertically and Ctrl moves horizontally', () => {
  // Scrolling up (negative delta) zooms in; the axes are signed so a push down
  // the wheel moves the picture down, which is what "scrolling" feels like.
  assert.deepEqual(pure.gestureOf({}, 0, -100, 0), { axis: 'zoom', amount: 100, smooth: true })
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 0, 100, 0), { axis: 'y', amount: -100 })
  assert.deepEqual(pure.gestureOf({ ctrlKey: true }, 0, 100, 0), { axis: 'x', amount: -100 })
  // One mouse notch is a gentle ~1.2×, not the old 1.5× jump.
  const notch = pure.wheelFactor(100)
  assert.ok(notch > 1.15 && notch < 1.25, 'one notch zooms about 1.2×, got ' + notch)
})

test('the wheel axis follows whichever delta moved, and honours line/page units', () => {
  // Windows browsers report Shift+wheel as a horizontal delta, so reading only
  // deltaY would silently turn a vertical request into a zoom.
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 120, 0, 0), { axis: 'y', amount: -120 })
  assert.deepEqual(pure.gestureOf({ ctrlKey: true }, 90, 0, 0), { axis: 'x', amount: -90 })
  assert.deepEqual(pure.gestureOf({}, 0, 0, 0), { axis: 'zoom', amount: 0, smooth: false })
  assert.deepEqual(pure.gestureOf({}, 0, -1, 1), { axis: 'zoom', amount: 33, smooth: true })
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 0, 1, 2), { axis: 'y', amount: -400 })
})

test('touchpad gestures are told apart from the mouse wheel', () => {
  // A pinch is Ctrl+wheel with small or fractional deltas: it zooms, immediately.
  const pinch = pure.gestureOf({ ctrlKey: true }, 0, -2.5, 0)
  assert.equal(pinch.axis, 'zoom', 'a pinch zooms instead of panning sideways')
  assert.ok(pinch.amount > 0, 'pinching out zooms in')
  assert.equal(pinch.smooth, false, 'a pinch is already continuous')
  assert.equal(pure.gestureOf({ ctrlKey: true }, 0, -3, 0).axis, 'zoom', 'a small whole delta is still a pinch')
  // A real Ctrl+notch keeps the requested horizontal pan.
  assert.equal(pure.gestureOf({ ctrlKey: true }, 0, -100, 0).axis, 'x')
  // A two-finger swipe carries deltaX without Shift, which a wheel never does: pan both axes.
  assert.deepEqual(pure.gestureOf({}, 12, -4, 0), { axis: 'pan', amount: 0, x: -12, y: 4 })
})

test('zoom stays anchored on the cursor and fit never upscales', () => {
  const view = { scale: 1, x: 0, y: 0 }
  const zoomed = pure.zoomAbout(view, 2, 100, 50)
  assert.equal(zoomed.scale, 2)
  // The point under the cursor (100, 50 from centre) stays put: x' = cx - (cx - x) * ratio.
  assert.deepEqual([zoomed.x, zoomed.y], [-100, -50])
  assert.equal(pure.zoomAbout(view, 1000, 0, 0).scale, 16, 'zoom is bounded')
  assert.equal(pure.fitScale({ w: 3200, h: 2000 }, { w: 1600, h: 1000 }), 0.47)
  assert.equal(pure.fitScale({ w: 100, h: 50 }, { w: 1600, h: 1000 }), 1, 'a small picture opens at 1:1')
  assert.deepEqual(pure.originOf({ scale: 0.5, x: 10, y: 0 }, { w: 400, h: 200 }, { w: 1000, h: 600 }), { x: 410, y: 250 })
})

test('both ways out work: the dark closes, and so do the labelled buttons', () => {
  let closed = 0
  const tree = overlay({ onClose: () => { closed += 1 } })
  const nodes = walk(tree)
  const texts = textOf(tree)
  assert.match(texts, /✕ 关闭/, 'a labelled close control is on top')
  assert.match(texts, /关闭 \(Esc\)/, 'and one on the bar names its key')
  const backdrop = nodes.find((node) => node.props.className === 'dsh-imgvw-backdrop')
  assert.ok(backdrop, 'the overlay root is rendered')
  assert.match(texts, /点图外或 Esc 关闭/, 'both ways out are spelled out')

  // The dark around the picture still closes; a click that lands on a bar does not.
  const self = {}
  const click = (target) => backdrop.props.onClick({ target, currentTarget: self, stopPropagation() {} })
  click(self)
  assert.equal(closed, 1, 'a click on the dark closes')
  click({})
  assert.equal(closed, 1, 'a click on a bar does not close')

  // What counts as "the dark, with nothing in flight".
  const tap = { tool: 'move', moved: false, crop: null, onPicture: false, dirty: false, snip: false }
  assert.equal(pure.closesOnTap(tap), true)
  assert.equal(pure.closesOnTap({ ...tap, onPicture: true }), false, 'a click on the picture is not the dark')
  assert.equal(pure.closesOnTap({ ...tap, moved: true }), false, 'a released drag was a pan, not a dismissal')
  assert.equal(pure.closesOnTap({ ...tap, tool: 'rect' }), false, 'an armed tool is not thrown away by a stray click')
  assert.equal(pure.closesOnTap({ ...tap, dirty: true }), false, 'unexported marks survive a click on the dark')
  assert.equal(pure.closesOnTap({ ...tap, crop: { x: 1, y: 1, w: 9, h: 9 } }), false, 'a pending crop survives too')
  assert.equal(pure.closesOnTap({ ...tap, snip: true }), false, 'a fresh grab is never dismissed by a click')
  assert.ok(nodes.find((node) => node.props.className === 'dsh-imgvw-stage'), 'the picture stage is rendered')
  assert.match(texts, /滚轮缩放/, 'the gestures are spelled out to the user')
})

test('events inside the portalled viewer never bubble into the row that opened it', () => {
  const backdrop = walk(overlay({})).find((node) => node.props.className === 'dsh-imgvw-backdrop')
  for (const handler of ['onPointerDown', 'onPointerUp', 'onMouseDown', 'onDoubleClick', 'onKeyDown']) {
    let stopped = false
    backdrop.props[handler]({ stopPropagation: () => { stopped = true } })
    assert.equal(stopped, true, handler + ' stops at the viewer root')
  }
  let stopped = false
  backdrop.props.onClick({ target: {}, currentTarget: backdrop, stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, 'clicks stop too, so a row header cannot toggle and unmount the viewer')
})

test('nothing of ours is anchored to the top-right corner the window buttons own', () => {
  // The CSS is part of the bundle, so the geometry contract is checkable here.
  assert.doesNotMatch(source, /\.dsh-imgvw-x\b/, 'the old corner ✕ button is gone')
  assert.doesNotMatch(source, /\.dsh-imgvw-legend\b/, 'the old floating legend is gone')
  assert.match(source, /--dsh-frame-overlay-top/, 'the stage starts below the native title bar')
  assert.match(source, /-webkit-app-region: no-drag/, 'and never turns into a window drag handle')
  const right = source.split('\n').filter((line) => /^\s*right:\s*\d/.test(line))
  for (const line of right) {
    assert.ok(!/top:/.test(line), 'no rule pins a control to the top-right: ' + line)
  }
})

test('the viewer is cheap to move: no full-screen blur, no picture-sized layer', () => {
  const cssStart = source.indexOf('const CSS = `')
  const css = source.slice(cssStart, source.indexOf('`\n', cssStart + 20))
  assert.doesNotMatch(css, /^\s*backdrop-filter:/m, 'a full-screen blur is recomputed on every pan frame')
  // The layer is sized from the stage (vpRef), never from natural × zoom.
  assert.doesNotMatch(source, /natural\.w \* raster/, 'the old picture-sized raster is gone')
  assert.match(source, /Math\.round\(vp\.w \* dpr\)/, 'the layer is stage-sized')
  assert.match(source, /requestAnimationFrame/, 'moves are written in an animation frame')
})

test('one mode: the tools, the outputs and the zoom are all on the bar', () => {
  assert.deepEqual(pure.DRAW_TOOLS, ['move', 'rect', 'ellipse', 'arrow', 'pen', 'text', 'crop'])
  assert.equal(pure.toolLabel('rect'), '矩形')
  assert.equal(pure.toolLabel('crop'), '裁剪')
  assert.equal(pure.toolLabel('move'), '移动')
  assert.equal(pure.COLORS[0], '#ff2d2d', 'red leads: a callout is drawn in red')
  const tree = textOf(overlay({}))
  for (const label of ['矩形', '椭圆', '箭头', '画笔', '文字', '裁剪', '撤销', '重做', '删除', '发到输入框', '复制', '保存', '适应']) {
    assert.match(tree, new RegExp(label), `${label} is on the toolbar without entering a mode`)
  }
  for (const gone of ['完成标注', '仅保存', '保存并复制', '退出标注']) {
    assert.doesNotMatch(tree, new RegExp(gone), `${gone} was folded into the three outputs`)
  }
  const snip = textOf(overlay({ snip: true, initialTool: 'crop' }))
  assert.match(snip, /拖动框选区域/, 'a fresh grab says what to do')
  assert.match(snip, /Enter 发到输入框/)
})

test('a gallery viewer can step between its pictures', () => {
  const items = [
    { src: '/a', shown: 'a.png', pixels: '1×1' },
    { src: '/b', shown: 'b.png', pixels: '2×2' },
  ]
  const nodes = walk(overlay({ items, index: 1 }))
  assert.match(textOf(nodes[0]), /2 \/ 2/, 'the position is shown')
  assert.ok(nodes.some((node) => node.props['data-side'] === 'prev'), 'a previous button')
  assert.ok(nodes.some((node) => node.props['data-side'] === 'next'), 'a next button')
  const img = nodes.find((node) => node.type === 'img')
  assert.equal(img.props.src, '/b', 'it opens on the picture that was clicked')
  assert.ok(!walk(overlay({})).some((node) => node.props['data-side'] === 'prev'), 'one picture has no stepping')
})

test('marks paint from source-image pixels, so the export matches the screen', () => {
  const context = spyContext()
  pure.drawMark(context, { type: 'rect', x0: 40, y0: 30, x1: 10, y1: 5, color: '#ff2d2d', width: 4 })
  const rect = context.calls.find((call) => call[0] === 'strokeRect')
  assert.deepEqual(rect, ['strokeRect', 10, 5, 30, 25], 'corners normalize to a box')
  assert.equal(context.strokeStyle, '#ff2d2d')

  const ellipse = spyContext()
  pure.drawMark(ellipse, { type: 'ellipse', x0: 0, y0: 0, x1: 20, y1: 10, color: '#000', width: 2 })
  assert.deepEqual(ellipse.calls.find((call) => call[0] === 'ellipse'), ['ellipse', 10, 5, 10, 5, 0, 0, Math.PI * 2])

  const arrow = spyContext()
  pure.drawMark(arrow, { type: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0, color: '#000', width: 4 })
  assert.deepEqual(arrow.names().slice(0, 3), ['setLineDash', 'beginPath', 'moveTo'])
  assert.ok(arrow.names().includes('fill'), 'the head is a filled triangle')
  const stub = spyContext()
  pure.drawMark(stub, { type: 'arrow', x0: 0, y0: 0, x1: 0.2, y1: 0, color: '#000', width: 4 })
  assert.ok(!stub.names().includes('stroke'), 'a dot is not an arrow')

  const pen = spyContext()
  pure.drawMark(pen, { type: 'pen', points: [1, 2, 3, 4, 5, 6], color: '#000', width: 3 })
  assert.deepEqual(pen.names().filter((name) => name === 'lineTo'), ['lineTo', 'lineTo'])
  const dot = spyContext()
  pure.drawMark(dot, { type: 'pen', points: [1, 2], color: '#000', width: 3 })
  assert.ok(!dot.names().includes('stroke'), 'a single point draws nothing')

  const text = spyContext()
  pure.drawMark(text, { type: 'text', x0: 8, y0: 9, text: '这里错位了', color: '#fff', size: 40 })
  assert.deepEqual(text.calls.find((call) => call[0] === 'fillText'), ['fillText', '这里错位了', 8, 9])
  assert.match(text.font, /40px/, 'the font size is in image pixels too')
})

test('a crop dims the outside and keeps a one-pixel edge at any zoom', () => {
  const context = spyContext()
  pure.paintCrop(context, { x: 10, y: 20, w: 30, h: 40 }, { w: 200, h: 200 }, 4)
  assert.equal(context.calls.filter((call) => call[0] === 'fillRect').length, 4, 'four dimmed sides')
  assert.ok(context.names().includes('strokeRect'), 'the crop edge is drawn')
  assert.equal(context.lineWidth, 1.5 / 4, 'the edge is divided by the zoom')
  assert.deepEqual(pure.rectOf({ x: 10, y: 12 }, { x: 2, y: 4 }), { x: 2, y: 4, w: 8, h: 8 })
  assert.equal(pure.textSize({ w: 3200, h: 2000 }, 4), 40, 'text scales with the picture')
  assert.equal(pure.textSize({ w: 0, h: 0 }, 2), 14, 'and never goes below readable')

  const marks = spyContext()
  pure.drawMarks(marks, [{ type: 'rect', x0: 0, y0: 0, x1: 4, y1: 4, color: '#000', width: 1 }],
    { type: 'rect', x0: 5, y0: 5, x1: 9, y1: 9, color: '#fff', width: 1 })
  assert.equal(marks.calls.filter((call) => call[0] === 'strokeRect').length, 2, 'the in-flight mark rides along')
})

test('existing marks can be grabbed on their line, moved and resized', () => {
  const box = { type: 'rect', x0: 100, y0: 100, x1: 300, y1: 200, color: '#f00', width: 4 }
  const arrow = { type: 'arrow', x0: 0, y0: 0, x1: 100, y1: 100, color: '#f00', width: 4 }
  const label = { type: 'text', x0: 500, y0: 500, text: '这里', color: '#f00', size: 20 }
  const ring = { type: 'ellipse', x0: 600, y0: 0, x1: 800, y1: 100, color: '#f00', width: 4 }
  const pen = { type: 'pen', points: [900, 0, 950, 50], color: '#f00', width: 4 }
  const marks = [box, arrow, label, ring, pen]
  assert.equal(pure.hitMark(marks, { x: 101, y: 150 }, 4), 0, 'a box is grabbed on its edge')
  assert.equal(pure.hitMark(marks, { x: 200, y: 150 }, 4), -1, 'but not in its middle, so a framed region can still be panned')
  assert.equal(pure.hitMark(marks, { x: 50, y: 52 }, 4), 1, 'an arrow along its shaft')
  assert.equal(pure.hitMark(marks, { x: 520, y: 510 }, 4), 2, 'a text label inside its box')
  assert.equal(pure.hitMark(marks, { x: 700, y: 1 }, 4), 3, 'an ellipse on its rim')
  assert.equal(pure.hitMark(marks, { x: 700, y: 50 }, 4), -1, 'not in its middle')
  assert.equal(pure.hitMark(marks, { x: 925, y: 26 }, 4), 4, 'a stroke along its path')
  assert.equal(pure.hitMark([box, { ...box }], { x: 101, y: 150 }, 4), 1, 'the topmost mark wins')

  assert.equal(pure.handlesOf(box).length, 4, 'a box has four corners')
  assert.deepEqual(pure.handlesOf(arrow), [{ x: 0, y: 0 }, { x: 100, y: 100 }], 'an arrow has its two ends')
  assert.deepEqual(pure.handlesOf(label), [], 'text is only moved')
  assert.equal(pure.hitHandle(pure.handlesOf(box), { x: 298, y: 203 }, 5), 2)

  assert.deepEqual(pure.moveMark(box, 10, -5), { ...box, x0: 110, y0: 95, x1: 310, y1: 195 })
  assert.deepEqual(pure.moveMark(pen, 1, 2).points, [901, 2, 951, 52])
  assert.deepEqual(pure.moveMark(label, 3, 4), { ...label, x0: 503, y0: 504 })
  assert.deepEqual(pure.resizeMark(box, 2, { x: 400, y: 260 }), { ...box, x1: 400, y1: 260 })
  assert.deepEqual(pure.resizeMark(box, 0, { x: 90, y: 80 }), { ...box, x0: 90, y0: 80 })
  assert.deepEqual(pure.resizeMark(arrow, 1, { x: 7, y: 8 }), { ...arrow, x1: 7, y1: 8 })

  assert.equal(pure.markIsVisible({ type: 'rect', x0: 0, y0: 0, x1: 1, y1: 1 }, 0.25), false, 'a stray click at 25% is not a box')
  assert.equal(pure.markIsVisible({ type: 'rect', x0: 0, y0: 0, x1: 1, y1: 1 }, 4), true, 'the same pixels at 400% are')
})

test('a crop is adjusted by its corners and moved inside the picture', () => {
  const crop = { x: 10, y: 10, w: 100, h: 50 }
  assert.deepEqual(pure.cropCorners(crop)[2], { x: 110, y: 60 })
  assert.deepEqual(pure.resizeCrop(crop, 2, { x: 150, y: 90 }), { x: 10, y: 10, w: 140, h: 80 }, 'the opposite corner stays')
  assert.deepEqual(pure.resizeCrop(crop, 0, { x: 200, y: 100 }), { x: 110, y: 60, w: 90, h: 40 }, 'dragging past it flips cleanly')
  assert.deepEqual(pure.moveCrop(crop, 1000, -1000, { w: 300, h: 200 }), { x: 200, y: 0, w: 100, h: 50 }, 'clamped to the picture')
})

test('send-to-composer pastes into the nearest editor, the way Ctrl+V would', () => {
  const editor = (name) => ({
    name,
    isContentEditable: true,
    isConnected: true,
    getClientRects: () => [1],
    focused: false,
    events: [],
    focus() { this.focused = true },
    dispatchEvent(event) {
      this.events.push(event)
      // The composer's paste command takes the files and cancels the event.
      if (event.clipboardData.files.length > 0) event.defaultPrevented = true
      return false
    },
  })
  const near = editor('near')
  const far = editor('far')
  const composer = { querySelector: (selector) => (selector === '[data-lexical-editor="true"]' ? near : null), parentElement: null }
  const button = { querySelector: () => null, parentElement: composer }
  const saved = { document: globalThis.document, DataTransfer: globalThis.DataTransfer, ClipboardEvent: globalThis.ClipboardEvent }
  globalThis.document = { querySelectorAll: () => [far] }
  globalThis.DataTransfer = class {
    constructor() {
      const files = []
      this.files = files
      this.items = { add: (file) => files.push(file) }
    }
  }
  globalThis.ClipboardEvent = class {
    constructor(type, init) {
      this.type = type
      this.clipboardData = init.clipboardData
      this.bubbles = init.bubbles
      this.defaultPrevented = false
    }
  }
  try {
    assert.equal(pure.findComposer(button), near, 'the composer the request came from wins')
    assert.equal(pure.findComposer(null), far, 'otherwise the last visible editor on the page')
    const accepted = pure.pasteImage(near, new Blob(['png'], { type: 'image/png' }), 'screenshot.png')
    assert.equal(accepted, true, 'a cancelled paste means the composer took the file')
    assert.equal(near.focused, true)
    const event = near.events[0]
    assert.equal(event.type, 'paste')
    assert.equal(event.bubbles, true)
    assert.equal(event.clipboardData.files[0].name, 'screenshot.png')
    assert.equal(event.clipboardData.files[0].type, 'image/png')
    globalThis.document = { querySelectorAll: () => [] }
    assert.equal(pure.findComposer(null), null, 'no composer: the viewer falls back to the clipboard')
  } finally {
    Object.assign(globalThis, saved)
  }
})

test('a gallery renders every picture, sized before its bytes arrive', () => {
  const att = (id) => ({ attachment: { attachmentId: id, width: 1600, height: 1000, bytes: 9, mediaType: 'image/png' } })
  const load = Object.assign(() => new Promise(() => {}), { peek: (ref) => (ref.attachmentId === 'a' ? 'blob:a' : undefined) })
  const single = walk(pure.ImageGallery({ images: [att('a')], loadImage: load, align: 'start' }))
  const img = single.find((node) => node.type === 'img')
  assert.equal(img.props.src, 'blob:a', 'a warm cache entry renders at once')
  assert.equal(img.props.width, 1600, 'width and height are on the element before it loads')
  assert.equal(img.props.height, 1000)
  assert.equal(single.find((node) => node.props['data-variant']).props['data-variant'], 'single')

  const many = walk(pure.ImageGallery({ images: [att('a'), att('b'), att('c')], loadImage: load, align: 'end' }))
  const frames = many.filter((node) => node.props.className === 'dsh-imgvw-frame')
  assert.equal(frames.length, 3, 'no picture is hidden behind "N more"')
  assert.ok(frames.every((node) => node.props['data-variant'] === 'tile'), 'several pictures render as tiles')
  assert.equal(many[0].props['data-align'], 'end', 'a user message keeps its right alignment')
  assert.match(textOf(many), /正在载入/, 'a picture still loading says so')

  const preview = walk(pure.ImageGallery({ images: [{ preview: { url: 'blob:local', name: 'paste.png' } }], loadImage: load, align: 'end' }))
  assert.equal(preview.find((node) => node.type === 'img').props.src, 'blob:local', 'a local submission preview needs no loader')
  assert.equal(pure.ImageGallery({ images: [], loadImage: load, align: 'start' }), null)
})

test('the galleries, the capture entry and the settings page are contributed by apply', () => {
  const injected = []
  const registered = []
  const style = { dataset: {}, textContent: '', remove() {} }
  globalThis.document = {
    createElement: () => style,
    head: { appendChild() {} },
  }
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        factory()
      },
      register: (decl, component) => {
        registered.push({ name: decl.name, key: decl.key, id: decl.id, label: decl.label, priority: decl.priority, component })
        if (decl.name === 'settings.section' || decl.name === 'conversation.input.right') {
          // Render the contributed components once: a throw here is a white slot.
          const tree = component({})
          assert.ok(tree !== null && tree !== undefined, decl.id + ' renders something')
        }
      },
    },
  }
  registration.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  }).apply(ctx)
  assert.deepEqual(injected, [...pure.IMAGE_SLOTS, 'tool.call.toolview', 'conversation.input.right', 'settings.section'])
  for (const name of ['tool.call.images', 'conversation.chat.user.images', 'conversation.chat.message.images', 'conversation.message.images']) {
    const row = registered.find((entry) => entry.name === name)
    assert.ok(row, name + ' gets the gallery')
    assert.equal(row.priority, -1, name + ' shadows the official gallery only in its own position')
    assert.equal(row.component.name, 'ImageGallery')
  }
  const toolviews = registered.filter((row) => row.name === 'tool.call.toolview')
  assert.ok(toolviews.length > 3, 'image-bearing tools without an official image row are claimed')
  assert.ok(!toolviews.some((row) => row.key === 'read_image'), 'read_image keeps its official row')
  const capture = registered.find((row) => row.id === 'read-image-preview-capture')
  assert.equal(capture.name, 'conversation.input.right')
  const page = registered.find((row) => row.id === 'read-image-preview')
  assert.equal(page.name, 'settings.section')
  assert.equal(page.label(), '截图与标注')
  const grab = textOf(pure.ShotCaptureButton({}))
  assert.match(grab, /截图/, 'the composer button is labelled')
})

test('the stylesheet and the routes stay inside this plugin’s own namespace', () => {
  assert.match(source, /const SHOT_ROUTE = '\/read-image-preview'/)
  for (const route of ['/state', '/list', '/save', '/delete', '/cleanup', '/capture', '/open']) {
    assert.ok(source.includes("SHOT_ROUTE + '" + route), `${route} is called from the client`)
  }
  assert.doesNotMatch(source, /globalShortcuts|registerHotkey/, 'no global hotkey is claimed away from the user')
  assert.doesNotMatch(source, /inputActions|addAttachments/, 'the composer is reached through paste, not a private surface')
})
