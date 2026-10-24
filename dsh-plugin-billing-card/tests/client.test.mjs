/**
 * Browser-half behavior: the expanded card labels each Search / Fetch
 * deployment by what it actually bills.
 *
 * The card reads `web.searchProvider` / `web.fetchProvider` through the
 * settings domain, because the billing projection folds only Session events and
 * therefore cannot know which provider answered a request.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Keys of one inline locale dictionary.
 * @param name - the dictionary constant (`CHINESE` / `ENGLISH`).
 * @returns its message keys in file order.
 */
function dictionaryKeys(name) {
  const start = SOURCE.indexOf(`const ${name} = {`)
  const end = SOURCE.indexOf('\n    }\n', start)
  return [...SOURCE.slice(start, end).matchAll(/^\s+'([\w.]+)':/gm)].map(match => match[1])
}

/**
 * Boot the browser bundle with a fake module loader.
 * @param options - `webProviders` seeds the `web` settings value; `configForms:
 *   false` omits the whole settings service to exercise the shipped fallback.
 * @returns the plugin object, the captured registration and the mutable form.
 */
function bootClient(options = {}) {
  let loaded
  const style = { dataset: {}, remove: () => {} }
  const document = { createElement: () => style, head: { appendChild() {} }, body: {} }
  let stateIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    // The first `useState` is the open flag, so the expanded card renders.
    useState: value => [stateIndex++ === 0 ? true : value, () => {}],
    useRef: () => ({ current: null }),
    useCallback: callback => callback,
    useEffect: () => {},
    useSyncExternalStore: () => {},
  }
  const ReactDOM = { createPortal: node => node }
  const window = { __ModuleLoader__: { load: entry => { loaded = entry } } }
  runInNewContext(SOURCE, { window, document })
  const plugin = loaded.factory(name => {
    if (name === 'react') return React
    assert.equal(name, 'react-dom')
    return ReactDOM
  })

  const dictionaries = new Map()
  const locale = {
    register: (ns, id, dict) => { dictionaries.set(`${ns}\u0000${id}`, dict); return () => {} },
    getSnapshot: () => ({ locales: [{ id: 'en' }] }),
    subscribe: () => () => {},
    bind: ns => (key, params) => {
      const dict = dictionaries.get(`${ns}\u0000zh`) ?? {}
      const template = typeof dict[key] === 'string' ? dict[key] : key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
  }

  /** The settings form the source resolves; tests mutate `snapshot`. */
  const form = {
    snapshot: { value: options.webProviders },
    getSnapshot() { return this.snapshot },
    subscribe: () => () => {},
  }
  const services = options.configForms === false
    ? {}
    : { configForms: { get: id => (id === 'web' ? form : undefined) } }

  let registration
  const ctx = {
    effect: callback => { callback() },
    get: name => services[name],
    locale,
    slots: {
      inject: (slot, callback) => {
        assert.equal(slot, 'conversation.composer.dock')
        callback()
      },
      register: (entry, component) => { registration = { entry, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  return { plugin, registration, form }
}

/**
 * One wire view whose server-side free window is open (or already closed).
 * @param options - `freeWindowOpen` picks which side of the window the clock is on.
 * @returns a version-1 `billingUsage` wire view.
 */
function wireView({ freeWindowOpen = true } = {}) {
  const now = Date.now()
  return {
    version: 1,
    currency: 'CNY',
    routes: [],
    totals: {
      input: 100, cacheRead: 0, cacheWrite: 0, output: 50, total: 150,
      cost: 0.01, costPeak: 0, costOffPeak: 0.01, pricedRoutes: 1, unpricedRoutes: 0,
    },
    search: {
      enabled: true,
      perRequest: 0.005,
      searchFreeUntil: freeWindowOpen ? now + 86_400_000 : now - 1000,
      calls: 1, requests: 2, billable: 2, emptyCalls: 0, failedCalls: 0,
      fetchCalls: 1, fetchBillable: 1, searchCost: 0.01, fetchCost: 0.005, totalCost: 0.015,
    },
  }
}

/**
 * Render the registration's component through the seats the framework binds.
 * The registration wraps the card in an element factory, so the test invokes
 * that element's component with the props the wrapper produced.
 * @param registration - captured `{ entry, component }`.
 * @param options - forwarded to {@link wireView}.
 * @returns the rendered element tree.
 */
function render(registration, options = {}) {
  const { hooks } = registration.entry.inject()
  const element = registration.component({
    useProjection: () => wireView(options),
    // The renderer binds a selector hook; identity is what the card passes.
    useWebSearchBilling: selector => selector(hooks.webSearchBilling.getSnapshot()),
  })
  return element.type(element.props)
}

/** Flatten rendered text, ignoring component boundaries. */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  const children = Array.isArray(node) ? node : node.children
  return Array.isArray(children) ? children.map(text).join(' ') : text(children)
}

test('shipped selection keeps the server-side free window and a free local fetch', () => {
  const { registration } = bootClient({ webProviders: { searchProvider: 'deepseek-official', fetchProvider: 'http' } })
  const rendered = text(render(registration))
  assert.match(rendered, /免费期内/)
  assert.match(rendered, /服务端搜索调用免费/)
  assert.match(rendered, /次 · 免费/)
  assert.match(rendered, /本地 HTTP/)
  assert.doesNotMatch(rendered, /直连 DeepSeek Fetch API/)
})

test('the direct Search and Fetch APIs bill from launch and claim no free window', () => {
  const { registration } = bootClient({ webProviders: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' } })
  const rendered = text(render(registration))
  assert.doesNotMatch(rendered, /免费期内/)
  assert.doesNotMatch(rendered, /服务端搜索调用免费/)
  assert.match(rendered, /直连 DeepSeek Search API/)
  assert.match(rendered, /直连 DeepSeek Fetch API/)
  assert.match(rendered, /次 · ¥/)
})

test('an expired window drops the free label even on the shipped selection', () => {
  const { registration } = bootClient({ webProviders: { searchProvider: 'deepseek-official', fetchProvider: 'http' } })
  const rendered = text(render(registration, { freeWindowOpen: false }))
  assert.doesNotMatch(rendered, /免费期内/)
  assert.doesNotMatch(rendered, /服务端搜索调用免费/)
})

test('an unknown provider charges no claimed rate and no free window', () => {
  const { registration } = bootClient({ webProviders: { searchProvider: 'acme-search', fetchProvider: 'acme-fetch' } })
  const rendered = text(render(registration))
  assert.doesNotMatch(rendered, /免费期内/)
  assert.doesNotMatch(rendered, /直连 DeepSeek/)
  assert.doesNotMatch(rendered, /本地 HTTP/)
})

test('without the settings service the card falls back to the shipped selection', () => {
  const { registration } = bootClient({ configForms: false })
  assert.match(text(render(registration)), /免费期内/)
})

test('an unset provider falls back to the shipped selection field by field', () => {
  const { registration } = bootClient({ webProviders: {} })
  const { hooks } = registration.entry.inject()
  assert.deepEqual({ ...hooks.webSearchBilling.getSnapshot() }, { search: 'side', fetch: 'local' })
})

test('the provider snapshot keeps one identity until the settings form changes', () => {
  const { registration, form } = bootClient({ webProviders: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' } })
  const source = registration.entry.inject().hooks.webSearchBilling
  const first = source.getSnapshot()
  assert.equal(first, source.getSnapshot())
  assert.equal(first.search, 'direct')
  form.snapshot = { value: { searchProvider: 'deepseek-official', fetchProvider: 'http' } }
  const next = source.getSnapshot()
  assert.notEqual(next, first)
  assert.equal(next, source.getSnapshot())
  assert.equal(next.search, 'side')
  assert.equal(next.fetch, 'local')
})

test('the registration adds only the provider hook to its entry', () => {
  const { plugin, registration } = bootClient({ webProviders: {} })
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])
  assert.deepEqual(Object.keys(registration.entry), ['name', 'id', 'order', 'inject'])
  assert.deepEqual(Object.keys(registration.entry.inject().hooks), ['webSearchBilling'])
})

test('both locale dictionaries carry the same keys', () => {
  const chinese = dictionaryKeys('CHINESE')
  const english = dictionaryKeys('ENGLISH')
  assert.deepEqual([...chinese].sort(), [...english].sort())
  for (const key of ['search.directNote', 'search.fetchLocalValue', 'search.fetchLocalNote']) {
    assert.ok(chinese.includes(key), `missing ${key}`)
  }
})
