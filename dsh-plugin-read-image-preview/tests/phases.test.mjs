/**
 * The three Tool-call stages dsh 0.1.7-rc.1 feeds to `tool.call.toolview`.
 *
 * rc.1 split `RunningToolCall` into `preparing` (arguments still streaming, so
 * no `argsRaw` at all) and `start`, and it now renders the claimed view during
 * preparation too. A claimed key that returns null renders a blank row, so the
 * preparing head must be treated as running. Pure component coverage: rendering
 * on a live page is verified separately by the Lead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// `READ_PREVIEW_CLIENT` lets the same stage contract run against another copy of
// the bundle (e.g. the pre-fix branch) to prove the assertions actually bite.
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
}

const PURE_NAMES = ['ImageToolCard', 'isRunningBlock', 'imageSpecOf', 'IMAGE_TOOL_KEYS']
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
  throw new Error(`unexpected require(${id})`)
}).__pure

/** Flatten a recorded tree into its text content. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return [node.props?.title, node.props?.children, ...node.children].map(textOf).join(' ')
}
const head = { callId: 'c1', name: 'computer_screenshot', subCalls: [] }
const props = (block) => ({
  block,
  toolName: block.name,
  cwd: undefined,
  home: undefined,
  openFile: () => {},
  loadImage: () => undefined,
  useDisclosure: () => ({ open: false, toggle() {} }),
})

test('the image Tool keys still cover read_image and computer-use tools', () => {
  for (const key of ['read_image', 'computer_screenshot', 'computer_zoom', 'generate_image']) {
    assert.ok(pure.IMAGE_TOOL_KEYS.includes(key), `${key} stays claimed`)
  }
})

test('a preparing call (no argsRaw yet) renders the live card, never a blank row', () => {
  const block = { ...head, phase: 'preparing' }
  assert.equal(pure.isRunningBlock(block), true, 'preparing is a running stage')
  assert.equal(pure.imageSpecOf(block), null, 'nothing is previewable before the arguments land')
  const rendered = pure.ImageToolCard(props(block))
  assert.notEqual(rendered, null, 'a claimed key must not render an empty shell')
  assert.match(textOf(rendered), /执行中/)
})

test('a started call with partial arguments still counts as running', () => {
  const block = { ...head, phase: 'start', argsRaw: '{"x": 1' }
  assert.equal(pure.isRunningBlock(block), true)
  assert.notEqual(pure.ImageToolCard(props(block)), null)
})

test('a settled image result renders the attachment preview', () => {
  const block = {
    kind: 'tool-result',
    callId: 'c1',
    call: { name: 'computer_screenshot', argsRaw: '{}' },
    content: [
      { type: 'text', text: 'captured\nsecond line' },
      { type: 'image', attachment: { attachmentId: 'att-1', name: 'shot.png' } },
    ],
    isError: false,
    subCalls: [],
  }
  assert.equal(pure.isRunningBlock(block), false, 'a settled node is not running')
  const spec = pure.imageSpecOf(block)
  assert.equal(spec.mode, 'attachment')
  assert.equal(spec.text, 'captured', 'only the first text line becomes the note')
  assert.notEqual(pure.ImageToolCard(props(block)), null)
})

test('a settled result without images keeps the documented outcome line', () => {
  const failed = {
    kind: 'tool-result',
    callId: 'c2',
    call: { name: 'read_image', argsRaw: '{"file_path":"D:/missing.png"}' },
    content: [{ type: 'text', text: 'no such file' }],
    isError: true,
    subCalls: [],
  }
  // The path names a file, so this is the file-preview row rather than an
  // attachment row; the point is it renders something for a failed call.
  assert.notEqual(pure.ImageToolCard(props(failed)), null)
  const silent = {
    kind: 'tool-result',
    callId: 'c3',
    call: { name: 'computer_click', argsRaw: '{"x":1,"y":2}' },
    content: [{ type: 'text', text: '' }],
    isError: false,
    subCalls: [],
  }
  assert.equal(pure.ImageToolCard(props(silent)), null, 'an imageless settled call defers to the generic row')
})
