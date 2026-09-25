/**
 * The 用途 (purpose) tab's title view and write planning.
 *
 * v2: the title fields are this plugin's OWN volatile Config (titleMode /
 * titleProvider / titleModel in the `model-tuning` namespace); the former
 * cross-package write into `title-model` is gone. Pure-function coverage only:
 * it proves what the page would read and send, not that a browser rendered it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const StubReact = { createElement: () => null, useState: (initial) => [initial, () => {}], useEffect: () => {} }
const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const PURE_NAMES = ['titleViewOf', 'planTitleWrite']
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

test('the bundle still exports apply alongside the title helpers', () => {
  assert.equal(typeof module_.apply, 'function')
  for (const name of PURE_NAMES) assert.equal(typeof module_[name], 'function', `helper ${name} is reachable`)
})

test('locale is declared in inject', () => {
  // cordis 的 ctx 代理对插件 fiber 读未 inject 的服务直接抛
  // 『cannot get property "locale" without inject』，apply() 连带整个 entry
  // 在 web boot 报 did not activate——`if (ctx.locale)` 挡不住属性读取本身。
  assert.ok(Array.isArray(helpers.inject), 'the client module declares its inject list')
  assert.ok(helpers.inject.includes('locale'), 'ctx.locale requires "locale" in inject')
})

const BUDGET_DEFAULTS = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 }
const budgetOps = (values) => Object.entries(values).map(([path, value]) => ({ op: 'set', path: [path], value }))

test('reads the stored route out of the plugin own namespace view', () => {
  const view = { namespaces: [{ ns: 'model-tuning', value: { titleMode: 'custom', titleProvider: 'tofu-gpt', titleModel: 'gpt-5' }, revision: 4 }] }
  assert.deepEqual(module_.titleViewOf(view), {
    available: true, mode: 'custom', provider: 'tofu-gpt', model: 'gpt-5', revision: 4, ...BUDGET_DEFAULTS,
  })
})

test('an absent namespace reports unavailable instead of throwing', () => {
  // The host row failed to activate; the tab must render its hint, not throw.
  assert.deepEqual(module_.titleViewOf({ namespaces: [] }), {
    available: false, mode: 'inherit', provider: null, model: null, revision: null, ...BUDGET_DEFAULTS,
  })
  assert.deepEqual(module_.titleViewOf(undefined), {
    available: false, mode: 'inherit', provider: null, model: null, revision: null, ...BUDGET_DEFAULTS,
  })
})

test('the stored budget is surfaced and a cleared field falls back to the shipped default', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'model-tuning', value: { maxOutputTokens: 1024, targetWords: 0 }, revision: 1 }] })
  assert.equal(view.maxOutputTokens, 1024, 'a user-set budget is shown')
  assert.equal(view.targetWords, 5, 'a non-positive stored value falls back to the default')
})

test('an empty stored section resolves to the inherit default', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'model-tuning', value: {}, revision: 0 }] })
  assert.equal(view.available, true)
  assert.equal(view.mode, 'inherit')
  assert.equal(view.provider, null)
  assert.equal(view.model, null)
})

test('an unknown stored mode falls back to inherit rather than being trusted', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'model-tuning', value: { titleMode: 'sometimes', titleProvider: 'p', titleModel: 'm' } }] })
  assert.equal(view.mode, 'inherit')
})

test('empty provider/model strings read as absent', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'model-tuning', value: { titleMode: 'custom', titleProvider: '', titleModel: '' } }] })
  assert.equal(view.provider, null)
  assert.equal(view.model, null)
})

test('saving inherit writes the budget and clears the whole route', () => {
  assert.deepEqual(module_.planTitleWrite({ mode: 'inherit' }), {
    ns: 'model-tuning',
    ops: [
      ...budgetOps(BUDGET_DEFAULTS),
      { op: 'unset', path: ['titleMode'] },
      { op: 'unset', path: ['titleProvider'] },
      { op: 'unset', path: ['titleModel'] },
    ],
  })
})

test('saving a custom route writes the budget and all three route fields', () => {
  assert.deepEqual(module_.planTitleWrite({ mode: 'custom', provider: 'local', model: 'tiny' }), {
    ns: 'model-tuning',
    ops: [
      ...budgetOps(BUDGET_DEFAULTS),
      { op: 'set', path: ['titleMode'], value: 'custom' },
      { op: 'set', path: ['titleProvider'], value: 'local' },
      { op: 'set', path: ['titleModel'], value: 'tiny' },
    ],
  })
})

test('a user-edited budget is written verbatim, so a reasoning model can be given room', () => {
  const plan = module_.planTitleWrite({ mode: 'custom', provider: 'lab', model: 'qwen3.8-flash-next', ...BUDGET_DEFAULTS, maxOutputTokens: 1024, timeoutMs: 120000 })
  assert.deepEqual(plan.ops.find((op) => op.path[0] === 'maxOutputTokens'), { op: 'set', path: ['maxOutputTokens'], value: 1024 })
  assert.deepEqual(plan.ops.find((op) => op.path[0] === 'timeoutMs'), { op: 'set', path: ['timeoutMs'], value: 120000 })
})

test('a cleared budget field returns to the shipped default instead of a stale value', () => {
  const plan = module_.planTitleWrite({ mode: 'inherit', maxOutputTokens: '' })
  assert.deepEqual(plan.ops.find((op) => op.path[0] === 'maxOutputTokens'), { op: 'set', path: ['maxOutputTokens'], value: 64 })
})

test('a non-positive budget is rejected before it can be written', () => {
  assert.throws(() => module_.planTitleWrite({ mode: 'inherit', maxOutputTokens: 0 }), /正整数/)
  assert.throws(() => module_.planTitleWrite({ mode: 'inherit', timeoutMs: -1 }), /正整数/)
})

test('an unrecognised mode is planned as inherit, never as a half route', () => {
  const plan = module_.planTitleWrite({ mode: 'nonsense', provider: 'p', model: 'm' })
  const routeOps = plan.ops.filter((op) => op.path[0].startsWith('title'))
  assert.equal(routeOps[0].op, 'unset')
  assert.equal(routeOps.length, 3)
})

test('the write never targets a namespace other than model-tuning', () => {
  for (const payload of [{ mode: 'inherit' }, { mode: 'custom', provider: 'a', model: 'b' }]) {
    assert.equal(module_.planTitleWrite(payload).ns, 'model-tuning')
  }
})

/**
 * Locale regression.
 *
 * The production client (`dsh-client-locale`) has `LOCALE_IDS = ["zh", "en"]`, so a
 * `zh-CN` dictionary is never selected (the fallback chain ends at `en`) and a
 * Chinese UI would render English keys. Registering a locale whose id fails
 * `LOCALE_ID_PATTERN` throws, and re-registering a namespace+locale throws too —
 * so both the id set and the single-registration shape are asserted here.
 */
const LOCALE_ID_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const ACTIVE_LOCALES = ['zh', 'en']

function applyWithLocaleSpy() {
  const calls = []
  const style = { dataset: {}, textContent: '', remove() {} }
  const sandbox = {
    document: { createElement: () => style, head: { appendChild: () => {} } },
    window: { __ModuleLoader__: { load: (options) => { sandbox.__registration = options } } },
    require: (id) => {
      if (id === 'react') return StubReact
      throw new Error(`unexpected require(${id})`)
    },
  }
  new Function('window', 'document', 'require', instrumented)(
    sandbox.window, sandbox.document, sandbox.require,
  )
  const locale = {
    register: (...args) => { calls.push(args); return () => {} },
    bind: () => (key) => key,
  }
  const ctx = {
    locale,
    remote: {},
    // 真实 cordis 的 ctx.effect(fn) 会立刻同步执行 fn 并把返回的 disposer 挂进
    // fiber；桩必须同样立即执行，否则测不到 effect 里的注册。
    effect: (fn) => fn(),
    get: () => undefined,
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  sandbox.__registration.factory((id) => {
    if (id === 'react') return StubReact
    throw new Error(`unexpected require(${id})`)
  }).apply(ctx)
  return calls
}

test('registers the title copy under the locales the client actually selects', () => {
  const calls = applyWithLocaleSpy()
  assert.equal(calls.length, 1, 'locale registration must happen exactly once')
  const [ns, dicts] = calls[0]
  assert.equal(ns, 'dsh-plugin-model-tuning')
  assert.ok(dicts && typeof dicts === 'object', 'a multi-locale dictionary keeps one registration')
  const locales = Object.keys(dicts)
  for (const locale of ACTIVE_LOCALES) {
    assert.ok(locales.includes(locale), `missing active locale "${locale}"`)
  }
  for (const locale of locales) {
    assert.match(locale, LOCALE_ID_PATTERN, `locale id "${locale}" would be rejected by the client`)
    assert.ok(Object.keys(dicts[locale]).length > 0, `locale "${locale}" carries no keys`)
  }
})

test('every locale carries the same keys, so no language falls back mid-page', () => {
  const [, dicts] = applyWithLocaleSpy()[0]
  const [first, ...rest] = Object.keys(dicts)
  const expected = Object.keys(dicts[first]).sort()
  for (const locale of rest) {
    assert.deepEqual(Object.keys(dicts[locale]).sort(), expected, `locale "${locale}" key set differs`)
  }
})
