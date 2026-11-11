/**
 * settings/mutate arity and revision discipline for the compat card.
 *
 * Would catch the defect this file was written for: saveCompat() called
 * `remote.settings.mutate(ns, ops)` with TWO arguments, while the deployed
 * client bridge declares three (ns, ops, expectedRevision) and refuses the
 * call outright — "client api: settings/mutate expected 3 argument(s), got 2".
 * Every 模型参数 edit (reasoning levels, developer role, adaptive thinking)
 * died on that error before reaching the host.
 *
 * The fake remote below enforces the same arity gate as the bridge, so a
 * regression fails here with the user's exact error message. It also pins the
 * write discipline the drawing page already follows: re-read the target
 * namespace immediately before writing, derive the ops AND the revision from
 * that one fresh document, and send the revision back as expectedRevision.
 *
 * Set MT_CLIENT_BUNDLE to run these assertions against another build of
 * client.js (used to prove the pre-fix bundle fails them).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const StubReact = { createElement: () => null, useState: (initial) => [initial, () => {}], useEffect: () => {} }
const bundlePath = process.env.MT_CLIENT_BUNDLE
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

let registration
new Function('window', 'require', source)(
  { __ModuleLoader__: { load: (options) => { registration = options } } },
  (id) => {
    if (id === 'react') return StubReact
    throw new Error(`unexpected require(${id})`)
  },
)
const bundle = registration.factory((id) => {
  if (id === 'react') return StubReact
  throw new Error(`unexpected require(${id})`)
})

// apply() touches document for its style tag; nothing else DOM-shaped runs here.
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}

const MODEL = {
  id: 'claude-opus-5-5',
  name: 'claude-opus-5-5',
  contextWindow: 256000,
  maxTokens: 32000,
  reasoningEfforts: { off: null, medium: 'medium', high: 'high' },
}

/**
 * Boot apply() against a fake remote and hand back the provider-card seat's
 * { load, save } plus the recorded mutate calls.
 * @param state - mutable fixture: providers, catalog, namespaces(), refuseMutate.
 */
function boot(state) {
  const calls = { mutate: [], describe: 0 }
  const ok = (value) => ({ ok: true, value })
  const remote = {
    llm: { listConfigurableProviders: async () => ok(state.providers) },
    session: { modelCatalog: async () => ok(state.catalog) },
    credentials: { set: async () => ok(true) },
    settings: {
      describe: async () => {
        calls.describe += 1
        return ok({ writable: true, namespaces: state.namespaces() })
      },
      // The deployed bridge checks the declared parameter count before the
      // call ever reaches the host; arguments.length is the same check.
      mutate: async function (ns, ops, expectedRevision) {
        if (arguments.length !== 3) {
          throw new Error(`client api: settings/mutate expected 3 argument(s), got ${arguments.length}`)
        }
        calls.mutate.push({ ns, ops, expectedRevision })
        if (state.refuseMutate) return { ok: false, error: { message: state.refuseMutate } }
        return ok({ ns, revision: (typeof expectedRevision === 'number' ? expectedRevision : 0) + 1 })
      },
    },
  }
  const seats = {}
  const ctx = {
    effect() {},
    get: () => undefined,
    remote,
    connection: { rpc: { call: async () => ok({}) } },
    slots: {
      inject: (name, seat) => { seats[name] = seat() },
      register: (descriptor) => descriptor,
    },
  }
  bundle.apply(ctx)
  const seat = seats['settings.models.provider-card']
  assert.ok(seat, 'the provider-card seat must be registered')
  return { ...seat.inject(), calls }
}

/** A hand-declared anthropic-messages pi-ai route with one Claude model. */
function fixture(revision = 7, models = [MODEL]) {
  return {
    providers: [{
      provider: 'ironman-claude',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'ironman-claude'],
      declared: false,
    }],
    catalog: {
      groups: [{
        id: 'ironman-claude',
        models: [{ id: 'claude-opus-5-5', name: 'claude-opus-5-5', reasoning: { efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'high' }] } }],
      }],
    },
    namespaces: () => [
      {
        ns: 'llm-pi-ai',
        revision,
        value: {
          providers: {
            'ironman-claude': { apiKeyEnv: 'IRONMAN_CLAUDE_API_KEY', api: 'anthropic-messages', baseURL: 'https://api.example.test', models },
          },
        },
      },
      { ns: 'model-tuning', revision: 3, value: { models: [], defaultModel: '' } },
    ],
  }
}

test('a reasoning-level edit sends ns, ops AND the revision it read', async () => {
  const state = fixture(7)
  const { save, calls } = boot(state)
  await save('ironman-claude', 'claude-opus-5-5', 'reasoningLevels', ['high'])
  assert.equal(calls.mutate.length, 1)
  const call = calls.mutate[0]
  assert.equal(call.ns, 'llm-pi-ai')
  assert.equal(call.expectedRevision, 7, 'the revision of the namespace view the ops were derived from')
  assert.deepEqual(call.ops[0].path, ['providers', 'ironman-claude', 'models'])
  assert.deepEqual(call.ops[0].value[0].reasoningEfforts, { off: null, high: 'high' })
})

test('developer-role and adaptive-thinking edits carry the revision too', async () => {
  for (const [kind, value, key] of [
    ['supportsDeveloperRole', true, 'supportsDeveloperRole'],
    ['adaptiveThinking', true, 'forceAdaptiveThinking'],
    ['adaptiveThinking', null, 'forceAdaptiveThinking'],
  ]) {
    const state = fixture(11)
    const { save, calls } = boot(state)
    await save('ironman-claude', 'claude-opus-5-5', kind, value)
    assert.equal(calls.mutate.length, 1, kind)
    assert.equal(calls.mutate[0].expectedRevision, 11, kind)
    const written = calls.mutate[0].ops[0].value[0]
    if (value === null) assert.equal(key in (written.compat ?? {}), false, kind)
    else assert.equal(written.compat[key], value, kind)
  }
})

test('the plan and its revision come from the freshest read, not the snapshot', async () => {
  // A concurrent write lands between the card's snapshot and the save click:
  // revision bumps and another model row appears. The save must rebuild its
  // ops from the fresh document (keeping the concurrent row) and send the
  // fresh revision — not overwrite the row with the stale snapshot's list.
  const state = fixture(7)
  const concurrent = { id: 'claude-haiku-4-5', name: 'haiku', maxTokens: 8192 }
  let reads = 0
  const baseNamespaces = state.namespaces
  state.namespaces = () => {
    reads += 1
    if (reads === 1) return baseNamespaces()
    return [
      { ...baseNamespaces()[0], revision: 8, value: { providers: { 'ironman-claude': { apiKeyEnv: 'IRONMAN_CLAUDE_API_KEY', api: 'anthropic-messages', baseURL: 'https://api.example.test', models: [MODEL, concurrent] } } } },
      baseNamespaces()[1],
    ]
  }
  const { save, calls } = boot(state)
  await save('ironman-claude', 'claude-opus-5-5', 'reasoningLevels', ['medium', 'high'])
  assert.equal(calls.mutate.length, 1)
  assert.equal(calls.mutate[0].expectedRevision, 8, 'the fresh revision, not the snapshot\'s 7')
  const rows = calls.mutate[0].ops[0].value
  assert.equal(rows.length, 2, 'the concurrently added model row survives the write')
  assert.deepEqual(rows.find((row) => row.id === 'claude-haiku-4-5'), concurrent)
})

test('a refused write surfaces the host error instead of looking saved', async () => {
  const state = fixture(7)
  state.refuseMutate = 'stale revision: the settings changed since you read them'
  const { save } = boot(state)
  await assert.rejects(
    save('ironman-claude', 'claude-opus-5-5', 'reasoningLevels', ['high']),
    /stale revision/,
  )
})

test('an unknown edit kind is refused before any write', async () => {
  const state = fixture(7)
  const { save, calls } = boot(state)
  await assert.rejects(save('ironman-claude', 'claude-opus-5-5', 'bogus', true), /未知的修改类型/)
  assert.equal(calls.mutate.length, 0)
})