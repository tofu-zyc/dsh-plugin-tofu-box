/**
 * The 用途 (purpose) tab's title-model view and write planning.
 *
 * Pure-function coverage only: it proves what the page would read and send, not
 * that a browser rendered it. Rendering and live writes are verified on the
 * installed page by the Lead.
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

test('reads the stored route out of the namespace view', () => {
  const view = { namespaces: [{ ns: 'title-model', value: { mode: 'custom', provider: 'tofu-gpt', model: 'gpt-5' }, revision: 4 }] }
  assert.deepEqual(module_.titleViewOf(view), {
    available: true, mode: 'custom', provider: 'tofu-gpt', model: 'gpt-5', revision: 4,
  })
})

test('an absent namespace reports unavailable instead of throwing', () => {
  // The page must still render its install hint when dsh-plugin-title-model is absent.
  assert.deepEqual(module_.titleViewOf({ namespaces: [] }), {
    available: false, mode: 'inherit', provider: null, model: null, revision: null,
  })
  assert.deepEqual(module_.titleViewOf(undefined), {
    available: false, mode: 'inherit', provider: null, model: null, revision: null,
  })
})

test('an empty stored section resolves to the inherit default', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'title-model', value: {}, revision: 0 }] })
  assert.equal(view.available, true)
  assert.equal(view.mode, 'inherit')
  assert.equal(view.provider, null)
  assert.equal(view.model, null)
})

test('an unknown stored mode falls back to inherit rather than being trusted', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'title-model', value: { mode: 'sometimes', provider: 'p', model: 'm' } }] })
  assert.equal(view.mode, 'inherit')
})

test('empty provider/model strings read as absent', () => {
  const view = module_.titleViewOf({ namespaces: [{ ns: 'title-model', value: { mode: 'custom', provider: '', model: '' } }] })
  assert.equal(view.provider, null)
  assert.equal(view.model, null)
})

test('saving inherit clears the whole route instead of leaving it authoritative', () => {
  assert.deepEqual(module_.planTitleWrite({ mode: 'inherit' }), {
    ns: 'title-model',
    ops: [
      { op: 'unset', path: ['mode'] },
      { op: 'unset', path: ['provider'] },
      { op: 'unset', path: ['model'] },
    ],
  })
})

test('saving a custom route writes all three fields', () => {
  assert.deepEqual(module_.planTitleWrite({ mode: 'custom', provider: 'local', model: 'tiny' }), {
    ns: 'title-model',
    ops: [
      { op: 'set', path: ['mode'], value: 'custom' },
      { op: 'set', path: ['provider'], value: 'local' },
      { op: 'set', path: ['model'], value: 'tiny' },
    ],
  })
})

test('an unrecognised mode is planned as inherit, never as a half route', () => {
  const plan = module_.planTitleWrite({ mode: 'nonsense', provider: 'p', model: 'm' })
  assert.equal(plan.ops[0].op, 'unset')
  assert.equal(plan.ops.length, 3)
})

test('the write never targets a namespace other than title-model', () => {
  for (const payload of [{ mode: 'inherit' }, { mode: 'custom', provider: 'a', model: 'b' }]) {
    assert.equal(module_.planTitleWrite(payload).ns, 'title-model')
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
