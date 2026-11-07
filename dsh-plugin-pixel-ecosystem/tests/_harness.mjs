/**
 * Boot harness for the pixel-terrarium client bundle.
 *
 * What it pins: nothing by itself — it is the shared fixture every suite in this
 * directory uses to run the *shipped* `client.js` outside a browser. The bundle
 * is a browser file (`window.__ModuleLoader__.load({ id, factory })`) whose
 * engine half is deliberately DOM-free (DESIGN.md §5), so a bare `window`
 * object plus a fake `react` is enough to drive the real code: no jsdom, no
 * timers, no network, no `document`.
 *
 * Why a fake React instead of the real package: `node --test` must stay
 * dependency-free (the repo ships no test deps), and the panel components only
 * need `createElement` plus inert hooks to produce an inspectable element tree.
 *
 * Exports:
 *  - `boot()` — loads the bundle, returns the plugin object and both test seams
 *    (`__engine`, `__test`).
 *  - `createFakeReact()` — element recorder with inert hooks.
 *  - `createFakeLocale()` — dictionary registry + translator shaped like the
 *    harness locale service (DESIGN.md §7).
 *  - `expand()`, `textOf()`, `findAll()` — walk the recorded element tree.
 *  - `BUNDLE_SOURCE` / `LOCALE_NAMESPACE` — the raw bundle text (for the
 *    source-level assertions in `client.test.mjs`) and the locale namespace.
 */
import { readFileSync } from 'node:fs'

/** Raw bundle text; the static (source-level) assertions read this. */
export const BUNDLE_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Locale namespace the bundle registers under (equals the package name). */
export const LOCALE_NAMESPACE = 'dsh-plugin-pixel-ecosystem'

/**
 * `require()` stand-in: the bundle may only ask for `react`.
 * @param {string} id - module id the bundle requested.
 * @returns {never} always throws, so an unexpected dependency fails loudly.
 */
function rejectRequire(id) {
  throw new Error(`the bundle required an unexpected module: ${id}`)
}

/**
 * Load the bundle in this process and return its registrations.
 *
 * The bundle calls `window.__ModuleLoader__.load({ id, factory })` at top level,
 * so booting it is: run the source with a `window` that records the call, then
 * invoke the factory with a `require` that resolves `react`.
 * @param {{ react?: object, window?: object }} [options] - inject the fake React
 *   and/or a pre-made `window` object.
 * @returns {{
 *   plugin: object, engine: object, seam: object, registration: object,
 *   react: object, windowObject: object,
 * }} plugin object (`module.exports`), both seams, and the loader registration.
 */
export function boot(options = {}) {
  const react = options.react ?? createFakeReact()
  const windowObject = options.window ?? {}
  let registration
  windowObject.__ModuleLoader__ = {
    load(entry) { registration = entry },
  }
  const requireReact = id => (id === 'react' ? react : rejectRequire(id))
  // `btoa`/`atob` are globals in Node >= 16; the save codec uses them. They are
  // passed explicitly so the bundle never depends on the host creating them.
  new Function('window', 'require', 'btoa', 'atob', BUNDLE_SOURCE)(
    windowObject, requireReact, btoa, atob,
  )
  if (registration === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const plugin = registration.factory(requireReact)
  if (plugin === null || typeof plugin !== 'object') throw new Error('bundle factory returned no plugin object')
  if (plugin.__engine === undefined) throw new Error('bundle is missing the __engine test seam')
  if (plugin.__test === undefined) throw new Error('bundle is missing the __test test seam')
  return {
    plugin,
    engine: plugin.__engine,
    seam: plugin.__test,
    registration,
    react,
    windowObject,
  }
}

/** Shared no-op for the inert hook stand-ins. */
const noop = () => {}

/**
 * A React stand-in that records element trees and makes hooks inert.
 *
 * Hooks behave like a single, permanent first render: `useState` always returns
 * its initial value, `useEffect` runs its callback once right away (the panel
 * effects are idempotent and tolerate a null canvas), `useSyncExternalStore`
 * subscribes and reads once. That is enough to render every component in the
 * bundle without a reconciler.
 * @returns {object} React-shaped object with createElement + hooks.
 */
export function createFakeReact() {
  /**
   * @param {string|Function} type - host tag or component.
   * @param {object|null} props - element props.
   * @param {...unknown} children - children, possibly nested arrays.
   * @returns {object} recorded element.
   */
  function createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children
        .flat(Infinity)
        .filter(child => child !== null && child !== undefined && child !== false && child !== true),
    }
  }
  return {
    createElement,
    Fragment: 'Fragment',
    /** @param {unknown|Function} initial - state seed. @returns {unknown[]} pair. */
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, noop] },
    /** Run the effect body once; cleanups are discarded (single render). */
    useEffect(effect) { if (typeof effect === 'function') effect() },
    /** @param {unknown} initial - ref seed. @returns {{current: unknown}} ref. */
    useRef(initial) { return { current: initial } },
    /** @param {Function} callback - memoised value. @returns {Function} identity. */
    useCallback(callback) { return callback },
    /** @param {Function} factory - memo body. @returns {unknown} value. */
    useMemo(factory) { return factory() },
    /** Subscribe once, then render the current snapshot. */
    useSyncExternalStore(subscribe, getSnapshot) {
      subscribe(noop)
      return getSnapshot()
    },
  }
}

/**
 * The harness locale service, in dictionary-registry form.
 *
 * `register()` keeps one dictionary per (namespace, locale id) — the bundle
 * registers four ids per language — and `bind(ns)` returns the translator the
 * components call. Templates keep their `{placeholder}` markers so the
 * component's own substitution (or the lack of it) is observable.
 * @param {{ id?: string, locales?: string[] }} [options] - active locale id and
 *   the ids the live catalog reports.
 * @returns {object} locale service double.
 */
export function createFakeLocale(options = {}) {
  const activeId = options.id ?? 'zh'
  const locales = options.locales ?? ['en', 'zh']
  const dictionaries = new Map()
  const listeners = new Set()
  const snapshot = { locale: activeId, locales: locales.map(id => ({ id })) }
  const keyOf = (namespace, id) => `${namespace}\u0000${id}`
  return {
    /**
     * @param {string} namespace - plugin namespace.
     * @param {string} id - locale id.
     * @param {object} dictionary - message table.
     * @returns {Function} disposer.
     */
    register(namespace, id, dictionary) {
      dictionaries.set(keyOf(namespace, id), dictionary)
      return () => { dictionaries.delete(keyOf(namespace, id)) }
    },
    /** @returns {object} catalog snapshot. */
    getSnapshot() { return snapshot },
    /** @param {Function} listener - change callback. @returns {Function} disposer. */
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /**
     * @param {string} namespace - plugin namespace.
     * @returns {(key: string) => string} translator for that namespace.
     */
    bind(namespace) {
      return (messageKey) => {
        const dictionary = dictionaries.get(keyOf(namespace, activeId)) ?? {}
        const value = dictionary[messageKey]
        return typeof value === 'string' ? value : messageKey
      }
    },
    /**
     * @param {string} namespace - plugin namespace.
     * @param {string} id - locale id.
     * @returns {object|undefined} dictionary registered for that pair.
     */
    dictionaryFor(namespace, id) { return dictionaries.get(keyOf(namespace, id)) },
    /** Fire every subscription, like a language change would. */
    emit() { for (const listener of listeners) listener() },
  }
}

/**
 * Render a recorded element tree: call every component function with its props.
 *
 * Host elements stay as `{ type, props, children }`; component elements are
 * replaced by their output, so the result contains only host tags and strings.
 * @param {unknown} node - recorded element, string, array or null.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} fully expanded tree.
 */
export function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => expand(child, depth + 1))
  if (depth > 50) throw new Error('element tree is deeper than 50 levels; component loop?')
  if (typeof node.type === 'function') {
    return expand(node.type({ ...node.props, children: node.children }), depth + 1)
  }
  return { type: node.type, props: node.props, children: node.children.map(child => expand(child, depth + 1)) }
}

/**
 * Flatten an expanded tree into its text content.
 * @param {unknown} node - expanded tree.
 * @returns {string} all visible text, space separated.
 */
export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children.map(textOf).join(' ')
}

/**
 * Collect every expanded element matching a predicate (depth first).
 * @param {unknown} node - expanded tree.
 * @param {(element: object) => boolean} predicate - matcher.
 * @returns {object[]} matching host elements.
 */
export function findAll(node, predicate) {
  const found = []
  const walk = (child) => {
    if (child === null || child === undefined || typeof child === 'string') return
    if (Array.isArray(child)) { for (const grandChild of child) walk(grandChild); return }
    if (predicate(child)) found.push(child)
    for (const grandChild of child.children) walk(grandChild)
  }
  walk(node)
  return found
}
