import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * The bundle registers itself with the browser module loader and closes over
 * React. A stub React keeps it parseable without running `apply()`, and the
 * factory's final `return module.exports` is swapped for one that also hands
 * out the settings planners, which are otherwise module-private.
 */
const StubReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const PURE_NAMES = [
  'deriveImageEntry', 'isManagedEntry', 'computeImageModelState', 'imageModelsOf',
  'normalizeImageEndpoint', 'acceptableImageEndpoint', 'sanitizeImageId', 'uniqueImageId',
  'planImageLink', 'planImageUnlink',
]

const EXPORT_MARK = 'return module.exports;'
const markAt = source.lastIndexOf(EXPORT_MARK)
assert.ok(markAt > 0, 'the bundle should end its factory with `return module.exports;`')
const instrumented = source.slice(0, markAt)
  + `module.exports.__pure = { ${PURE_NAMES.join(', ')} };\n    `
  + source.slice(markAt)

const load = new Function('window', 'require', instrumented)
let registration
load(
  { __ModuleLoader__: { load: (options) => { registration = options } } },
  (id) => {
    if (id === 'react') return StubReact
    throw new Error(`unexpected require(${id})`)
  },
)

assert.ok(registration, 'the bundle registers itself with the module loader')
const helpers = registration.factory((id) => {
  if (id === 'react') return StubReact
  throw new Error(`unexpected require(${id})`)
})
const module_ = { ...helpers.__pure, apply: helpers.apply }

assert.equal(typeof module_.apply, 'function', 'the bundle still exports apply')
for (const name of PURE_NAMES) assert.equal(typeof module_[name], 'function', `helper ${name} is reachable`)

const IMAGE_API = 'openai-images'
const providerProfile = { baseURL: 'https://ai.tofuzyc.site/openai/v1', apiKeyEnv: 'TOFU_GPT_API_KEY' }
const viewOf = (value, revision = 3) => ({ ns: 'image-generation', value, revision })

test('derives the Images endpoint and credential from the chat provider', () => {
  assert.deepEqual(module_.deriveImageEntry(providerProfile, 'ironman/gpt-image-2.5'), {
    model: 'ironman/gpt-image-2.5',
    endpoint: 'https://ai.tofuzyc.site/openai/v1/images/generations',
    apiKeyEnv: 'TOFU_GPT_API_KEY',
  })
})

test('derives nothing usable from a provider without a base URL', () => {
  assert.deepEqual(module_.deriveImageEntry({}, 'm'), { model: 'm', endpoint: '', apiKeyEnv: '' })
  assert.deepEqual(module_.deriveImageEntry(undefined, 'm'), { model: 'm', endpoint: '', apiKeyEnv: '' })
})

test('links a model into an empty image namespace and defaults it', () => {
  const plan = module_.planImageLink(viewOf({ models: [] }), providerProfile, 'ironman/gpt-image-2.5', 'tofu-gpt')
  assert.equal(plan.reason, undefined)
  assert.equal(plan.models.length, 1)
  assert.equal(plan.models[0].id, 'ironman-gpt-image-2-5')
  assert.equal(plan.models[0].model, 'ironman/gpt-image-2.5')
  assert.equal(plan.models[0].endpoint, 'https://ai.tofuzyc.site/openai/v1/images/generations')
  assert.equal(plan.models[0].apiKeyEnv, 'TOFU_GPT_API_KEY')
  assert.equal(plan.models[0].api, IMAGE_API)
  // The image schema's timeout default is written explicitly, not left implicit.
  assert.equal(plan.models[0].timeoutSeconds, 300)
  assert.deepEqual(plan.models[0].source, { provider: 'tofu-gpt', model: 'ironman/gpt-image-2.5' })
  assert.equal(plan.defaultModel, plan.models[0].id)
})

test('refuses a link when the provider has no base URL', () => {
  const plan = module_.planImageLink(viewOf({ models: [] }), {}, 'm', 'p')
  assert.equal(plan.models, null)
  assert.match(plan.reason, /供应商地址/)
})

test('refuses the stock OpenAI endpoint rather than silently calling it', () => {
  const plan = module_.planImageLink(viewOf({ models: [] }), { apiKeyEnv: 'K' }, 'm', 'p')
  assert.equal(plan.models, null)
})

test('keeps an existing default instead of overwriting it', () => {
  const existing = { id: 'other', model: 'gpt-image-2.5', api: IMAGE_API, endpoint: 'https://gw.example/v1/images/generations' }
  const plan = module_.planImageLink(viewOf({ models: [existing], defaultModel: 'other' }), providerProfile, 'x', 'p')
  assert.equal(plan.defaultModel, 'other')
  assert.equal(plan.models.length, 2)
})

test('adopts a hand-authored entry without touching the user other fields', () => {
  const existing = {
    id: 'hand', name: '我的手写条目', model: 'ironman/gpt-image-2.5', api: IMAGE_API,
    endpoint: 'https://stale.example/v1/images/generations', apiKeyEnv: 'KEEP_ME',
    size: '1536x1024', quality: 'high', timeoutSeconds: 600, downloadOrigins: ['https://cdn.example.com'],
  }
  const plan = module_.planImageLink(viewOf({ models: [existing] }), providerProfile, 'ironman/gpt-image-2.5', 'tofu-gpt')
  assert.equal(plan.models.length, 1)
  const merged = plan.models[0]
  assert.equal(merged.id, 'hand')
  assert.equal(merged.size, '1536x1024')
  assert.equal(merged.quality, 'high')
  assert.equal(merged.timeoutSeconds, 600)
  assert.deepEqual(merged.downloadOrigins, ['https://cdn.example.com'])
  assert.deepEqual(merged.source, { provider: 'tofu-gpt', model: 'ironman/gpt-image-2.5' })
  assert.equal(merged.endpoint, 'https://ai.tofuzyc.site/openai/v1/images/generations')
  assert.equal(merged.apiKeyEnv, 'KEEP_ME', 'an existing credential reference is not overwritten')
})

test('unlinking removes only an entry this page owns', () => {
  const owned = { id: 'a', model: 'ironman/gpt-image-2.5', api: IMAGE_API, source: { provider: 'tofu-gpt', model: 'ironman/gpt-image-2.5' } }
  const hand = { id: 'b', model: 'other-model', api: IMAGE_API }
  const plan = module_.planImageUnlink(viewOf({ models: [owned, hand], defaultModel: 'a' }), 'ironman/gpt-image-2.5')
  assert.equal(plan.reason, undefined)
  assert.deepEqual(plan.models, [hand])
  assert.equal(plan.defaultModel, 'b', 'the default falls through to the next entry')
})

test('unlinking refuses an entry authored on the 绘图 page', () => {
  const hand = { id: 'b', model: 'ironman/gpt-image-2.5', api: IMAGE_API }
  const plan = module_.planImageUnlink(viewOf({ models: [hand] }), 'ironman/gpt-image-2.5')
  assert.equal(plan.models, null)
  assert.match(plan.reason, /手工维护/)
})

test('unlinking an unlinked model reports instead of writing', () => {
  const plan = module_.planImageUnlink(viewOf({ models: [] }), 'nope')
  assert.equal(plan.models, null)
  assert.match(plan.reason, /未链接/)
})

test('identifier collisions get a numeric suffix within the schema limit', () => {
  assert.equal(module_.sanitizeImageId('ironman/gpt-image-2.5'), 'ironman-gpt-image-2-5')
  assert.equal(module_.sanitizeImageId('///'), '')
  const long = module_.sanitizeImageId('/'.repeat(10) + 'a'.repeat(200))
  assert.ok(long.length <= 64, `id must fit the schema, got ${long.length}`)
  const taken = [{ id: 'ironman-gpt-image-2-5' }, { id: 'ironman-gpt-image-2-5-2' }]
  assert.equal(module_.uniqueImageId('ironman/gpt-image-2.5', taken), 'ironman-gpt-image-2-5-3')
})

test('every derived id satisfies the image-generation plugin schema', () => {
  const pattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
  for (const model of ['ironman/gpt-image-2.5', 'xcpcai/gpt-image-2.5-flare', '2024-model', '-leading', 'a'.repeat(120)]) {
    assert.match(module_.uniqueImageId(model, []), pattern, `derived id for ${model}`)
  }
})

test('an endpoint is normalized once and accepted only when it is not the stock one', () => {
  assert.equal(module_.normalizeImageEndpoint('https://gw.example/v1/'), 'https://gw.example/v1/images/generations')
  assert.equal(module_.normalizeImageEndpoint('https://gw.example/v1/images/generations/'), 'https://gw.example/v1/images/generations')
  assert.equal(module_.acceptableImageEndpoint('https://gw.example/v1/images/generations'), true)
  assert.equal(module_.acceptableImageEndpoint('https://api.openai.com/v1/images/generations'), false)
  assert.equal(module_.acceptableImageEndpoint('not-a-url'), false)
  assert.equal(module_.acceptableImageEndpoint('ftp://gw.example/v1/images/generations'), false)
})

test('the checkbox state comes from the stored entry', () => {
  const view = viewOf({ models: [{ id: 'a', model: 'ironman/gpt-image-2.5', source: { provider: 'tofu-gpt', model: 'ironman/gpt-image-2.5' } }] })
  const state = module_.computeImageModelState(view, providerProfile, 'ironman/gpt-image-2.5')
  assert.deepEqual(
    { available: state.available, hasEntry: state.hasEntry, managed: state.managed },
    { available: true, hasEntry: true, managed: true },
  )
  const absent = module_.computeImageModelState(view, providerProfile, 'other')
  assert.deepEqual(
    { available: absent.available, hasEntry: absent.hasEntry, managed: absent.managed },
    { available: true, hasEntry: false, managed: false },
  )
  assert.equal(module_.computeImageModelState(undefined, providerProfile, 'x').available, false)
})

test('an entry stored before provenance existed is not treated as owned', () => {
  assert.equal(module_.isManagedEntry({ id: 'a', model: 'm' }, 'm'), false)
  assert.equal(module_.isManagedEntry({ source: { provider: 'p', model: 'other' } }, 'm'), false)
  assert.equal(module_.isManagedEntry(undefined, 'm'), false)
})

test('relinking from another provider updates provenance', () => {
  const owned = {
    id: 'a', model: 'ironman/gpt-image-2.5', api: IMAGE_API,
    endpoint: 'https://old.example/v1/images/generations', apiKeyEnv: 'OLD_KEY',
    source: { provider: 'xcpcai', model: 'ironman/gpt-image-2.5' },
  }
  const plan = module_.planImageLink(viewOf({ models: [owned] }), providerProfile, 'ironman/gpt-image-2.5', 'tofu-gpt')
  assert.deepEqual(plan.models[0].source, { provider: 'tofu-gpt', model: 'ironman/gpt-image-2.5' })
  assert.equal(plan.models[0].endpoint, 'https://ai.tofuzyc.site/openai/v1/images/generations')
})
