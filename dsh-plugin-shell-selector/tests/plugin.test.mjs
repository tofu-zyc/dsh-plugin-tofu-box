/**
 * Contract tests for both halves of the plugin.
 *
 * These load the real modules: the Host half's Remote surface and the Client
 * half's `apply()` registration are executed, not pattern-matched. Rendering is
 * not exercised — no React tree is mounted — so these prove wiring, not the
 * visual result.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 } from 'node:path'

import { SHELL_KINDS, SHELL_LABEL_KEYS, buildCatalog, pwsh5Path } from '../shells.js'

const PS7 = win32.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const PS51 = pwsh5Path({ SystemRoot: 'C:\\Windows' })
const GIT_BASH = win32.join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
const ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\system32' }

/** Every key the page reads directly, in addition to the host-emitted ones. */
const PAGE_KEYS = [
  'title', 'intro', 'effective', 'sandbox', 'refresh', 'unavailable', 'applying',
  'notice.applied', 'custom', 'readonly', 'absent', 'retry',
  'note.running', 'note.pwsh5', 'note.gitbash',
]

/** `lstat` stand-in for the fixtures below. */
function fakeFs(paths) {
  const table = new Set(paths.map(path => path.toLowerCase()))
  return path => {
    if (!table.has(String(path).toLowerCase())) {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    return { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false }
  }
}

/**
 * Load the Client half by executing it against a ModuleLoader shim. `client.js`
 * calls the loader once at module scope, so the captured spec is memoized here
 * rather than re-imported per test (an `import()` of a cached module does not
 * re-run its top level).
 */
let clientSpec
async function loadClientPlugin() {
  if (!clientSpec) {
    globalThis.window = { __ModuleLoader__: { load: candidate => { clientSpec = candidate } } }
    globalThis.document = {
      createElement: () => ({ textContent: '', remove() {} }),
      head: { appendChild() {} },
    }
    await import('../client.js')
    assert.ok(clientSpec, 'client.js must register through window.__ModuleLoader__.load')
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => { throw new Error('components are not rendered in this test') },
    useEffect: () => {},
    useCallback: callback => callback,
    useSyncExternalStore: () => {},
  }
  const plugin = clientSpec.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  return { plugin, spec: clientSpec }
}

/**
 * A locale-service double that reproduces the shipped lookup rules:
 * `LOCALE_IDS` is `zh`/`en`, `zh` falls back to `en`, and `bind(ns)` walks the
 * ACTIVE locale's fallback chain. A double that matched dictionaries directly —
 * as an earlier version of this test did — hides exactly the defect where a
 * `zh-CN` dictionary is unreachable and Chinese renders as English.
 * @param active - initial active locale id.
 * @param extraLocales - additional catalog entries, e.g. a language pack.
 */
function makeLocale(active = 'zh', extraLocales = []) {
  const key = value => String(value).toLowerCase()
  const catalog = new Map([
    ['zh', { id: 'zh', label: '中文', fallback: 'en' }],
    ['en', { id: 'en', label: 'English' }],
    ...extraLocales.map(entry => [key(entry.id), { fallback: 'en', ...entry }]),
  ])
  const dicts = new Map()
  const registered = []
  let current = active
  const chainOf = start => {
    const chain = []
    const seen = new Set()
    let definition = catalog.get(key(start))
    while (definition !== undefined && !seen.has(key(definition.id))) {
      seen.add(key(definition.id))
      chain.push(definition.id)
      definition = definition.fallback === undefined ? undefined : catalog.get(key(definition.fallback))
    }
    return chain
  }
  return {
    registered,
    subscribe: () => () => {},
    getSnapshot: () => ({ active: current, locales: [...catalog.values()], revision: 0 }),
    setActive: next => { current = next },
    register: (ns, id, dict) => {
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      dicts.get(ns).set(key(id), dict)
      registered.push({ ns, code: id, dict })
      return () => { dicts.get(ns).delete(key(id)) }
    },
    bind: ns => translateKey => {
      for (const id of chainOf(current)) {
        const value = dicts.get(ns)?.get(key(id))?.[translateKey]
        if (value !== undefined) return value
      }
      return translateKey
    },
  }
}

/** Minimal Client context recording every registration. */
function fakeClientContext(locale = makeLocale()) {
  const calls = []
  const effects = []
  let slot
  const ctx = {
    locale,
    connection: {
      rpc: {
        call: async (channel, path, payload) => {
          calls.push({ channel, path, payload })
          return { ok: true, value: { ok: true } }
        },
      },
    },
    remote: { settings: {} },
    slots: {
      inject: (name, factory) => { assert.equal(name, 'settings.section'); factory() },
      register: (options, component) => { slot = { options, component }; return () => {} },
    },
    effect: callback => { const disposer = callback(); effects.push(disposer); return disposer },
  }
  return { ctx, registered: locale.registered, calls, effects, slot: () => slot }
}

test('the Host half exports the plane facts the composition relies on', async () => {
  const host = await import('../index.js')
  assert.equal(host.name, 'dsh-plugin-shell-selector')
  assert.deepEqual(host.inject, ['settings'], 'the executor is read optionally, never injected as a hard dependency')
  assert.equal(host.SERVICE, 'shellSelector')
  const descriptor = host.ShellSelectorService.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods']
  assert.equal(descriptor.version, 1)
  assert.deepEqual(descriptor.methods.map(entry => entry.method), ['probe', 'select'])
  for (const entry of descriptor.methods) assert.deepEqual(entry.invocation, { kind: 'direct' })
})

test('the Client half injects the services the page needs', async () => {
  const { plugin } = await loadClientPlugin()
  for (const name of ['slots', 'connection', 'remote', 'remote.settings', 'locale']) {
    assert.ok(plugin.inject.includes(name), `client must inject ${name}`)
  }
})

test('apply registers both dictionaries, the style, and the settings section', async () => {
  const { plugin } = await loadClientPlugin()
  const { ctx, registered, effects, slot } = fakeClientContext()
  plugin.apply(ctx)

  assert.deepEqual(registered.map(entry => entry.code).sort(), ['en', 'zh'], 'the built-in ids are zh and en, never zh-CN')
  for (const entry of registered) assert.equal(entry.ns, 'shell-selector')
  assert.ok(effects.length >= 2, 'style and the dictionaries must be owned by effects')

  const section = slot()
  assert.ok(section, 'the settings section must be registered')
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.id, 'shell-selector')
  assert.equal(section.options.order, 14)
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), 'Shell')
})

test('a zh active locale renders Chinese, not English', async () => {
  const { plugin } = await loadClientPlugin()
  const locale = makeLocale('zh')
  plugin.apply(fakeClientContext(locale).ctx)

  const t = locale.bind('shell-selector')
  assert.equal(t('unavailable'), '不可用')
  assert.notEqual(t('unavailable'), 'Unavailable', 'zh must not fall through to the English dictionary')
  assert.match(t('intro'), /选择 AI 执行命令时使用的 shell/u)
  assert.equal(t('option.gitbash'), 'Git Bash', 'shared values stay identical across locales')
})

test('an en active locale renders English', async () => {
  const { plugin } = await loadClientPlugin()
  const locale = makeLocale('en')
  plugin.apply(fakeClientContext(locale).ctx)

  assert.equal(locale.bind('shell-selector')('unavailable'), 'Unavailable')
})

test('a region-tagged or language-pack locale still resolves Chinese', async () => {
  const { plugin } = await loadClientPlugin()
  // The catalog is extensible, so a pack may introduce zh-CN or zh-Hans. Both
  // must reach the Chinese dictionary rather than the en fallback.
  const locale = makeLocale('zh-Hans', [{ id: 'zh-Hans', label: '简体中文', fallback: 'zh' }, { id: 'zh-CN', label: '中文', fallback: 'zh' }])
  plugin.apply(fakeClientContext(locale).ctx)

  assert.ok(locale.registered.some(entry => entry.code === 'zh-CN'), 'catalog locales must be enumerated at registration')
  assert.equal(locale.bind('shell-selector')('unavailable'), '不可用')
})

test('the translator follows the active locale at call time', async () => {
  const { plugin } = await loadClientPlugin()
  const locale = makeLocale('zh')
  const { ctx, slot } = fakeClientContext(locale)
  plugin.apply(ctx)

  assert.equal(slot().options.label(), 'Shell')
  const t = locale.bind('shell-selector')
  const before = t('refresh')
  locale.setActive('en')
  assert.equal(before, '刷新')
  assert.equal(t('refresh'), 'Refresh', 'bind reads the active locale when called, so a switch is picked up')
})

test('the dictionary registrations are disposed with the effect', async () => {
  const { plugin } = await loadClientPlugin()
  const locale = makeLocale('zh')
  const { ctx, effects } = fakeClientContext(locale)
  plugin.apply(ctx)

  assert.equal(locale.bind('shell-selector')('refresh'), '刷新')
  // The dictionaries effect is the one whose disposer clears both registrations.
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal(locale.bind('shell-selector')('refresh'), 'refresh', 'after disposal the key resolves untranslated')
})

test('the Client addresses the same Remote namespace the Host declares', async () => {
  const host = await import('../index.js')
  const { plugin } = await loadClientPlugin()
  const { ctx, calls, slot } = fakeClientContext()
  plugin.apply(ctx)

  const element = slot().component({ close: () => {} })
  assert.equal(typeof element.props.call, 'function', 'the page must receive the bound Remote caller')
  await element.props.call('probe', {})
  assert.deepEqual(calls, [{ channel: '/api', path: `${host.SERVICE}/probe`, payload: { args: {} } }])
})

test('both dictionaries cover every key the page and the Host can emit', async () => {
  const { plugin } = await loadClientPlugin()
  const { ctx, registered } = fakeClientContext()
  plugin.apply(ctx)
  const dictionaries = new Map(registered.map(entry => [entry.code, entry.dict]))

  const emitted = new Set(PAGE_KEYS)
  const fixtures = [
    [ENV, fakeFs([PS7, PS51]), 'win32'],
    [ENV, fakeFs([PS51]), 'win32'],
    [ENV, fakeFs([]), 'win32'],
    [ENV, fakeFs([GIT_BASH]), 'win32'],
    [ENV, fakeFs([]), 'darwin'],
  ]
  for (const [env, lstat, platform] of fixtures) {
    for (const option of buildCatalog(env, lstat, platform)) {
      for (const key of [option.labelKey, option.detailKey, option.reasonKey]) if (key) emitted.add(key)
    }
  }
  assert.deepEqual([...SHELL_KINDS].map(kind => SHELL_LABEL_KEYS[kind]).filter(key => !emitted.has(key)), [])

  const zh = dictionaries.get('zh')
  const en = dictionaries.get('en')
  assert.ok(zh, 'the zh dictionary must be registered')
  assert.ok(en, 'the en dictionary must be registered')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'dictionaries must stay key-for-key equal')
  for (const key of emitted) {
    assert.ok(key in zh, `zh is missing "${key}"`)
    assert.ok(key in en, `en is missing "${key}"`)
  }
})
