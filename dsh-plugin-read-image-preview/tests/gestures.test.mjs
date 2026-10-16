/**
 * The lightbox contract: what the wheel does, how a mark is painted, and how the
 * stage is allowed to be closed.
 *
 * These are the three things the plugin got wrong for the user: the wheel needed
 * Ctrl, the only way out was clicking outside the picture (which fought the
 * desktop app's own window buttons), and there was no way to mark a picture up
 * and hand it to a model. All three are decided by code that needs no DOM, so
 * the recording harness below is enough to pin them down.
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
  'ImageZoomOverlay', 'ShotCaptureButton', 'DRAW_TOOLS', 'COLORS', 'WIDTHS',
  'gestureOf', 'drawMark', 'drawMarks', 'paintCrop', 'rectOf', 'textSize', 'toolLabel',
  'closesOnTap',
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
  assert.deepEqual(pure.gestureOf({}, 0, -3, 0), { axis: 'zoom', amount: 3 })
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 0, 3, 0), { axis: 'y', amount: -3 })
  assert.deepEqual(pure.gestureOf({ ctrlKey: true }, 0, 3, 0), { axis: 'x', amount: -3 })
  // A trackpad pinch is Ctrl+wheel; it must not be mistaken for a plain gesture.
  assert.equal(pure.gestureOf({ ctrlKey: true }, 0, -2, 0).axis, 'x')
})

test('the wheel axis follows whichever delta moved, and honours line/page units', () => {
  // Windows browsers report Shift+wheel as a horizontal delta, so reading only
  // deltaY would silently turn a vertical request into a zoom.
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 120, 0, 0), { axis: 'y', amount: -120 })
  assert.deepEqual(pure.gestureOf({ ctrlKey: true }, 90, 0, 0), { axis: 'x', amount: -90 })
  assert.deepEqual(pure.gestureOf({}, 0, 0, 0), { axis: 'zoom', amount: 0 })
  assert.deepEqual(pure.gestureOf({}, 0, -1, 1), { axis: 'zoom', amount: 33 })
  assert.deepEqual(pure.gestureOf({ shiftKey: true }, 0, 1, 2), { axis: 'y', amount: -400 })
})

test('both ways out work: the dark closes, and so do the labelled buttons', () => {
  let closed = 0
  const tree = overlay({ onClose: () => { closed += 1 } })
  const nodes = walk(tree)
  const texts = textOf(tree)
  assert.match(texts, /关闭/, 'a labelled close control is on screen')
  assert.match(texts, /关闭 \(Esc\)/, 'and it names its key')
  const backdrop = nodes.find((node) => node.props.className === 'dsh-imgvw-backdrop')
  assert.ok(backdrop, 'the overlay root is rendered')
  assert.equal(backdrop.props.onDoubleClick, undefined, 'double clicks belong to the stage, not the chrome')
  assert.match(texts, /点图外或 Esc 关闭/, 'both ways out are spelled out')

  // The dark around the picture still closes; a click that lands on a bar does not.
  const self = {}
  backdrop.props.onClick({ target: self, currentTarget: self })
  assert.equal(closed, 1, 'a click on the dark closes')
  backdrop.props.onClick({ target: {}, currentTarget: self })
  assert.equal(closed, 1, 'a click on a bar does not close')

  // What counts as "the dark, with nothing in flight".
  assert.equal(pure.closesOnTap({ editing: false, moved: false, crop: null, onPicture: false }), true)
  assert.equal(pure.closesOnTap({ editing: false, moved: false, crop: null, onPicture: true }), false,
    'a click on the picture is not the dark')
  assert.equal(pure.closesOnTap({ editing: false, moved: true, crop: null, onPicture: false }), false,
    'a released drag was a pan, not a dismissal')
  assert.equal(pure.closesOnTap({ editing: true, moved: false, crop: null, onPicture: false }), false,
    'annotating is not thrown away by a stray click')
  assert.equal(pure.closesOnTap({ editing: false, moved: false, crop: { x: 1, y: 1, w: 9, h: 9 }, onPicture: false }), false,
    'a pending crop survives a click on the dark')
  const stage = nodes.find((node) => node.props.className === 'dsh-imgvw-stage')
  assert.ok(stage, 'the picture stage is rendered')
  assert.match(texts, /滚轮缩放/, 'the gestures are spelled out to the user')
  assert.match(texts, /Shift\+滚轮/, 'including the two pan gestures')
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

test('every draw tool is reachable and named in Chinese', () => {
  assert.deepEqual(pure.DRAW_TOOLS, ['move', 'rect', 'ellipse', 'arrow', 'pen', 'text', 'crop'])
  assert.equal(pure.toolLabel('rect'), '矩形')
  assert.equal(pure.toolLabel('crop'), '裁剪')
  assert.equal(pure.toolLabel('move'), '移动')
  assert.equal(pure.COLORS[0], '#ff2d2d', 'red leads: a callout is drawn in red')
  const tree = textOf(overlay({ initialEdit: true, initialTool: 'crop' }))
  for (const label of ['矩形', '椭圆', '箭头', '画笔', '文字', '裁剪', '撤销', '重做']) {
    assert.match(tree, new RegExp(label), `${label} is on the toolbar`)
  }
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

test('a crop dims the outside and the export honours the rect', () => {
  const context = spyContext()
  pure.paintCrop(context, { x: 10, y: 20, w: 30, h: 40 }, { w: 200, h: 200 })
  assert.equal(context.calls.filter((call) => call[0] === 'fillRect').length, 4, 'four dimmed sides')
  assert.ok(context.names().includes('strokeRect'), 'the crop edge is drawn')
  assert.deepEqual(pure.rectOf({ x: 10, y: 12 }, { x: 2, y: 4 }), { x: 2, y: 4, w: 8, h: 8 })
  assert.equal(pure.textSize({ w: 3200, h: 2000 }, 4), 40, 'text scales with the picture')
  assert.equal(pure.textSize({ w: 0, h: 0 }, 2), 14, 'and never goes below readable')

  const marks = spyContext()
  pure.drawMarks(marks, [{ type: 'rect', x0: 0, y0: 0, x1: 4, y1: 4, color: '#000', width: 1 }],
    { type: 'rect', x0: 5, y0: 5, x1: 9, y1: 9, color: '#fff', width: 1 })
  assert.equal(marks.calls.filter((call) => call[0] === 'strokeRect').length, 2, 'the in-flight mark rides along')
})

test('the capture entry and the settings page are contributed by apply', () => {
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
        registered.push({ name: decl.name, key: decl.key, id: decl.id, label: decl.label })
        if (decl.name !== 'tool.call.toolview') {
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
  assert.deepEqual(injected, ['tool.call.toolview', 'conversation.input.right', 'settings.section'])
  const capture = registered.find((row) => row.id === 'read-image-preview-capture')
  assert.deepEqual(capture, {
    name: 'conversation.input.right', key: undefined, id: 'read-image-preview-capture', label: undefined,
  })
  const page = registered.find((row) => row.id === 'read-image-preview')
  assert.equal(page.name, 'settings.section')
  assert.equal(page.label(), '截图与标注')
  assert.equal(registered.filter((row) => row.name === 'tool.call.toolview').length > 3, true)
  const grab = textOf(pure.ShotCaptureButton({}))
  assert.match(grab, /截图/, 'the composer button is labelled')
})

test('the stylesheet and the routes stay inside this plugin’s own namespace', () => {
  assert.match(source, /const SHOT_ROUTE = '\/read-image-preview'/)
  for (const route of ['/state', '/list', '/save', '/delete', '/cleanup', '/capture', '/open']) {
    assert.ok(source.includes("SHOT_ROUTE + '" + route), `${route} is called from the client`)
  }
  assert.doesNotMatch(source, /globalShortcuts|registerHotkey/, 'no global hotkey is claimed away from the user')
})
