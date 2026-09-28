import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

function bootClient(snapshot) {
  let loaded
  let stateIndex = 0
  const removals = []
  const style = { dataset: {}, remove: () => removals.push('style') }
  const document = { createElement: () => style, head: { appendChild() {} } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: value => [stateIndex++ === 1 && snapshot ? snapshot : value, () => {}],
    useEffect: () => {},
  }
  const window = { __ModuleLoader__: { load: entry => { loaded = entry } } }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window, document, setInterval, clearInterval, navigator: { clipboard: { writeText: async () => {} } },
  })
  const plugin = loaded.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  let registration
  const calls = []
  const ctx = {
    effect: callback => { const dispose = callback(); if (dispose) removals.push(dispose) },
    locale: {
      register: () => () => {},
      bind: () => key => key,
    },
    slots: {
      inject: (slot, callback) => {
        assert.equal(slot, 'settings.models.provider-card')
        callback()
      },
      register: (entry, component) => { registration = { entry, component }; return () => {} },
    },
    connection: { rpc: { call: async (...args) => {
      calls.push(args)
      return { ok: true, value: { ticket: 'test-ticket' } }
    } } },
  }
  plugin.apply(ctx)
  return { plugin, registration, calls, removals }
}

function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  return Array.isArray(node) ? node.map(text).join(' ') : text(node.children)
}

function buttons(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(buttons)
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.children)]
}

test('browser entry registers only the llm-pi-ai keyed model card', async () => {
  const { plugin, registration, calls, removals } = bootClient()
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'connection', 'locale'])
  assert.equal(registration.entry.name, 'settings.models.provider-card')
  assert.equal(registration.entry.key, 'llm-pi-ai')
  const injected = registration.entry.inject()
  const other = registration.component({ provider: { provider: 'openai' }, configured: true, ...injected })
  assert.equal(other, null)
  const draft = registration.component({ provider: { provider: 'openai-codex' }, configured: false, ...injected })
  assert.match(text(draft), /setup/)
  assert.equal(buttons(draft).length, 0)
  const saved = registration.component({ provider: { provider: 'openai-codex' }, configured: true, ...injected })
  assert.match(text(saved), /signedOut/)
  const [start] = buttons(saved)
  assert.equal(text(start), 'signIn')
  start.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0][0], '/api')
  assert.equal(calls[0][1], 'codexLogin/start')
  assert.equal(Object.keys(calls[0][2].args).length, 0)
  for (const dispose of removals) if (typeof dispose === 'function') dispose()
  assert.ok(removals.includes('style'))
})

test('Codex card renders a safe HTTP diagnostic from a ticket-bound status', () => {
  const { registration } = bootClient({
    authorized: false, inFlight: false, state: 'error', failure: 'http-403', notices: [], prompts: [],
  })
  const card = registration.component({ provider: { provider: 'openai-codex' }, configured: true,
    ...registration.entry.inject() })
  assert.match(text(card), /failedHttp HTTP 403/)
  assert.doesNotMatch(text(card), /token|secret/i)
})
