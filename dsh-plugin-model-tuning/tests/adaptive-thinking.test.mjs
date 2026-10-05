/**
 * The Anthropic adaptive-thinking compat switch (模型参数 → 思考格式).
 *
 * Two halves:
 *
 * 1. The pure planners in client.js: which route may take the switch, and what
 *    the write does to the model entry.
 * 2. A coupling guard against the DEPLOYED pi-ai build. The control exists only
 *    to change the request body — `thinking.type=adaptive` plus
 *    `output_config.effort` instead of `thinking.type=enabled` with
 *    `budget_tokens` — so the flag is asked to do exactly that, on the model
 *    description this page's own write produces. Skipped when
 *    `DSH_TEST_DEPLOY_ROOT` names no deployment; that is the same isolated
 *    deployment the title-provider suite uses.
 *
 * NEITHER HALF IS LIVE VERIFICATION: no gateway is contacted, so what a real
 * endpoint accepts is still read from the session log after an install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hostDeploymentRoot } from './_host.mjs'

const StubReact = { createElement: () => null, useState: (initial) => [initial, () => {}], useEffect: () => {} }
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const PURE_NAMES = ['adaptiveThinkingCompatKey', 'computeCompatWriteOps']
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
const helpers = registration.factory((id) => {
  if (id === 'react') return StubReact
  throw new Error(`unexpected require(${id})`)
})
const module_ = { ...helpers.__pure, apply: helpers.apply }

test('the bundle still exports apply alongside the compat planners', () => {
  assert.equal(typeof module_.apply, 'function')
  for (const name of PURE_NAMES) assert.equal(typeof module_[name], 'function', `helper ${name} is reachable`)
})

const ADAPTIVE_KEY = 'forceAdaptiveThinking'
const ROUTE = { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ironman-claude'] }

/** The reported route: hand-declared, anthropic-messages, one adaptive-only Claude. */
function claudeRouteView(models) {
  return {
    ns: 'llm-pi-ai',
    revision: 7,
    value: {
      providers: {
        'ironman-claude': {
          apiKeyEnv: 'IRONMAN_CLAUDE_API_KEY',
          api: 'anthropic-messages',
          baseURL: 'https://api.wpironman.top',
          models,
        },
      },
    },
  }
}

const CLAUDE_MODEL = {
  id: 'claude-opus-5-5',
  name: 'claude-opus-5-5',
  contextWindow: 256000,
  maxTokens: 32000,
  input: ['text', 'image'],
  reasoningEfforts: { off: null, medium: 'medium', high: 'high' },
  compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
}

test('the switch is offered exactly on an anthropic-messages pi-ai route', () => {
  assert.equal(module_.adaptiveThinkingCompatKey('llm-pi-ai', { api: 'anthropic-messages' }), ADAPTIVE_KEY)
  // The harness refuses a compat field the model's resolved api does not offer,
  // so every other protocol must show no control at all.
  assert.equal(module_.adaptiveThinkingCompatKey('llm-pi-ai', { api: 'openai-completions' }), null)
  assert.equal(module_.adaptiveThinkingCompatKey('llm-pi-ai', {}), null)
  assert.equal(module_.adaptiveThinkingCompatKey('llm-pi-ai', undefined), null)
  assert.equal(module_.adaptiveThinkingCompatKey('llm-deepseek', { api: 'anthropic-messages' }), null)
})

test('turning the switch on writes the flag beside the settings already there', () => {
  const view = claudeRouteView([CLAUDE_MODEL])
  const write = module_.computeCompatWriteOps(ROUTE, view, 'claude-opus-5-5', ADAPTIVE_KEY, true)
  assert.equal(write.ns, 'llm-pi-ai')
  assert.deepEqual(write.ops.map((op) => op.op), ['set'])
  assert.deepEqual(write.ops[0].path, ['providers', 'ironman-claude', 'models'])
  const written = write.ops[0].value[0]
  assert.equal(written.compat[ADAPTIVE_KEY], true)
  assert.deepEqual(written.compat.chatTemplateKwargs, {}, 'the materialized template dicts survive')
  assert.deepEqual(written.reasoningEfforts, CLAUDE_MODEL.reasoningEfforts)
  assert.equal(written.maxTokens, 32000)
  assert.equal(written.id, 'claude-opus-5-5')
})

test('turning it back to auto removes only this key', () => {
  const kept = { ...CLAUDE_MODEL, compat: { ...CLAUDE_MODEL.compat, [ADAPTIVE_KEY]: true, supportsStrictTools: true } }
  const write = module_.computeCompatWriteOps(ROUTE, claudeRouteView([kept]), 'claude-opus-5-5', ADAPTIVE_KEY, null)
  const written = write.ops[0].value[0]
  assert.equal(ADAPTIVE_KEY in written.compat, false)
  assert.equal(written.compat.supportsStrictTools, true)
})

test('removing the last compat key drops the empty dict', () => {
  const onlyFlag = { id: 'claude-opus-5-5', compat: { [ADAPTIVE_KEY]: true } }
  const write = module_.computeCompatWriteOps(ROUTE, claudeRouteView([onlyFlag]), 'claude-opus-5-5', ADAPTIVE_KEY, null)
  assert.equal('compat' in write.ops[0].value[0], false)
})

test('a catalog route falls back to the model override, not the served list', () => {
  // No `models` list: the route serves the installed catalog, so a per-model
  // switch belongs in `modelOverrides.<id>`.
  const view = {
    ns: 'llm-pi-ai',
    revision: 2,
    value: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseURL: 'https://api.wpironman.top' } } },
  }
  const write = module_.computeCompatWriteOps(
    { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
    view, 'claude-opus-5-5', ADAPTIVE_KEY, true,
  )
  assert.deepEqual(write.ops, [
    { op: 'set', path: ['providers', 'anthropic', 'modelOverrides', 'claude-opus-5-5', 'compat'], value: { [ADAPTIVE_KEY]: true } },
  ])
})

// ── Coupling guard: the deployed pi-ai must read this flag ────────────────────

/** pi-ai's package root, walked up from the deployment's own llm-pi-ai. */
function deployedPiAiRoot(anchor) {
  const require = createRequire(anchor)
  const llm = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
  for (let dir = dirname(llm); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

/** The model description this page's write produces for the reported route. */
function adaptiveOnlyModel(compat) {
  return {
    id: 'claude-opus-5-5', name: 'claude-opus-5-5', api: 'anthropic-messages', provider: 'ironman-claude',
    baseUrl: 'https://api.wpironman.top', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000, maxTokens: 32000,
    // `reasoningEfforts: {off: null, medium: 'medium', high: 'high'}` as
    // dsh-llm-pi-ai resolves it: declared levels carry their wire spelling,
    // undeclared ones are pinned to null, and an off with no value stays absent.
    thinkingLevelMap: { minimal: null, low: null, medium: 'medium', high: 'high', xhigh: null, max: null },
    ...compat === undefined ? {} : { compat },
  }
}

const anchor = hostDeploymentRoot()
const piAiRoot = anchor === undefined ? undefined : deployedPiAiRoot(anchor)
const skipGuard = piAiRoot === undefined
  ? 'set DSH_TEST_DEPLOY_ROOT to a dsh deployment to ask its pi-ai build'
  : false

/** One streamed request against a captured fetch; returns the request body. */
async function requestBody(piAi, model, options) {
  let captured
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) }
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    const stream = piAi.streamSimple(
      model,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }] },
      { apiKey: 'sk-test', maxTokens: 4096, ...options },
    )
    for await (const _chunk of stream) { /* the request is what this test reads */ }
  } catch (_stubStreamEnded) {
    // A stubbed response body may end the stream early; the request already happened.
  } finally {
    globalThis.fetch = previousFetch
  }
  return captured?.body
}

/** The deployed anthropic-messages build, imported once for both guard tests. */
let piAiPromise
function deployedPiAi() {
  piAiPromise ??= import(pathToFileURL(join(piAiRoot, 'dist', 'api', 'anthropic-messages.js')).href)
  return piAiPromise
}

test('the deployed pi-ai sends adaptive thinking only when the flag is set', { skip: skipGuard }, async () => {
  const piAi = await deployedPiAi()

  const legacy = await requestBody(piAi, adaptiveOnlyModel(undefined), { reasoning: 'high' })
  assert.deepEqual(legacy.thinking, { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
    'without the flag pi-ai sends the legacy budget form, which an adaptive-only model rejects with 400')

  const adaptive = await requestBody(piAi, adaptiveOnlyModel({ [ADAPTIVE_KEY]: true }), { reasoning: 'high' })
  assert.deepEqual(adaptive.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(adaptive.output_config, { effort: 'high' })

  const medium = await requestBody(piAi, adaptiveOnlyModel({ [ADAPTIVE_KEY]: true }), { reasoning: 'medium' })
  assert.deepEqual(medium.output_config, { effort: 'medium' }, 'the declared wire spelling is the effort sent')
})

test('an off level carries the map\'s own dispatch, not the plugin\'s', { skip: skipGuard }, async () => {
  const piAi = await deployedPiAi()

  // dsh-llm-pi-ai leaves a declared `off: null` OUT of the map, and pi-ai reads
  // an absent `off` as "tell the endpoint thinking is disabled" — it omits the
  // parameter only when the map pins `off` to null, which is how the installed
  // catalog states a model that cannot be told to stop thinking. The switch on
  // this page changes the enabled form only; the off form is the harness's.
  for (const compat of [undefined, { [ADAPTIVE_KEY]: true }]) {
    const body = await requestBody(piAi, adaptiveOnlyModel(compat), {})
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal('output_config' in body, false, 'no effort travels with a disabled request')
  }

  const pinned = adaptiveOnlyModel({ [ADAPTIVE_KEY]: true })
  pinned.thinkingLevelMap = { ...pinned.thinkingLevelMap, off: null }
  const omitted = await requestBody(piAi, pinned, {})
  assert.equal('thinking' in omitted, false, 'pinning off to null is what omits the parameter')
})
