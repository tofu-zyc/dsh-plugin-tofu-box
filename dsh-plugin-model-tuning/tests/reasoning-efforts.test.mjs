/**
 * 模型参数 → 可选推理档位, written as `reasoningEfforts`.
 *
 * dsh 0.2.1-alpha.4's own Models page edits the same field and lets each level
 * send its own API value. Toggling a level here must not rewrite the values the
 * official editor stored for the levels that stay.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const StubReact = { createElement: () => null, useState: (initial) => [initial, () => {}], useEffect: () => {} }
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

const PURE_NAMES = ['reasoningEffortsPayload', 'storedReasoningEfforts']
const EXPORT_MARK = 'return module.exports;'
const markAt = source.lastIndexOf(EXPORT_MARK)
assert.ok(markAt > 0, 'the bundle should end its factory with `return module.exports;`')
const instrumented = source.slice(0, markAt)
  + `module.exports.__pure = { ${PURE_NAMES.join(', ')} };\n    `
  + source.slice(markAt)

let registration
new Function('window', 'require', instrumented)(
  { __ModuleLoader__: { load: (options) => { registration = options } } },
  (id) => {
    if (id === 'react') return StubReact
    throw new Error(`unexpected require(${id})`)
  },
)
const { reasoningEffortsPayload, storedReasoningEfforts } = registration.factory((id) => {
  if (id === 'react') return StubReact
  throw new Error(`unexpected require(${id})`)
}).__pure

test('no checked level means the model does not reason', () => {
  assert.equal(reasoningEffortsPayload([], { off: null, high: 'deep' }), false)
})

test('a fresh declaration sends each level by its own name, off sends nothing', () => {
  assert.deepEqual(reasoningEffortsPayload(['high', 'low'], undefined), { off: null, low: 'low', high: 'high' })
})

test('levels that stay keep the API value the official editor stored', () => {
  const stored = { off: 'none', low: 'low', high: 'deep' }
  assert.deepEqual(
    reasoningEffortsPayload(['low', 'medium', 'high'], stored),
    { off: 'none', low: 'low', medium: 'medium', high: 'deep' },
  )
})

test('the stored value is read from models[] first, then pi-ai modelOverrides', () => {
  const entry = { settingsPath: ['providers', 'gw'] }
  const view = (profile) => ({ value: { providers: { gw: profile } } })
  assert.deepEqual(
    storedReasoningEfforts(entry, view({ models: [{ id: 'm', reasoningEfforts: { high: 'deep' } }] }), 'm'),
    { high: 'deep' },
  )
  assert.deepEqual(
    storedReasoningEfforts(entry, view({ modelOverrides: { m: { reasoningEfforts: { low: 'lo' } } } }), 'm'),
    { low: 'lo' },
  )
  assert.equal(storedReasoningEfforts(entry, view({ models: [] }), 'm'), undefined)
})
