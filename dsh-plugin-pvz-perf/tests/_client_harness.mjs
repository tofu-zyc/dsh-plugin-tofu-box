/**
 * Boot harness for the pvz-perf client bundle.
 *
 * The shipped `client.js` is a browser file: it calls
 * `window.__ModuleLoader__.load({ id, factory })`, and its factory only needs
 * `react` plus the slot/locale services the Harness passes in. Running the real
 * file under Node with a recording `window`, a fake `react` and a fake ctx is
 * therefore enough to pin the seat contract and the store behaviour without a
 * browser, jsdom or any test dependency.
 *
 * Exports:
 *  - `BUNDLE_SOURCE` — the raw bundle text, for source-level assertions.
 *  - `boot()` — evaluate the bundle, return `{ plugin, registration }`.
 *  - `createFakeReact()` / `createFakeLocale()` — React/locale doubles.
 *  - `createFakeCtx()` — a ctx that records slot registrations and effects.
 *  - `expand()`, `textOf()`, `findAll()`, `findOne()` — walk element trees.
 */
import { readFileSync } from 'node:fs'

/** Raw bundle text; the source-level assertions read this. */
export const BUNDLE_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Locale namespace the bundle registers under (equals the package name). */
export const LOCALE_NAMESPACE = 'dsh-plugin-pvz-perf'

/** Shared no-op. */
const noop = () => {}

/**
 * Evaluate the bundle in this process.
 * @param {{ react?: object, window?: object }} [options] - overrides.
 * @returns {{ plugin: object, registration: object, react: object, windowObject: object }}
 */
export function boot(options = {}) {
  const react = options.react ?? createFakeReact()
  const windowObject = options.window ?? {}
  let registration
  windowObject.__ModuleLoader__ = {
    load(entry) { registration = entry },
  }
  const requireReact = (id) => {
    if (id === 'react') return react
    throw new Error('the bundle required an unexpected module: ' + id)
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser artifact.
  new Function('window', BUNDLE_SOURCE)(windowObject)
  if (registration === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const plugin = registration.factory(requireReact)
  if (plugin === null || typeof plugin !== 'object') throw new Error('bundle factory returned no plugin object')
  return { plugin, registration, react, windowObject }
}

/**
 * A React stand-in: records element trees, hooks are inert and single-render.
 * @returns {object} React-shaped object.
 */
export function createFakeReact() {
  /**
   * @param {string|Function} type - host tag or component function.
   * @param {object|null} props - element props.
   * @param {...unknown} children - children.
   * @returns {object} recorded element.
   */
  function createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children
        .flat(Infinity)
        .filter((child) => child !== null && child !== undefined && child !== false && child !== true),
    }
  }
  /** Minimal class base so `class X extends React.Component` works. */
  function Component(props) { this.props = props }
  Component.prototype.setState = function setState(patch) { this.state = { ...(this.state ?? {}), ...patch } }
  return {
    createElement,
    Component,
    Fragment: 'Fragment',
    /** @returns {unknown[]} initial value + inert setter. */
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, noop] },
    /** Run once, like a first commit with no re-render. */
    useEffect(effect) { if (typeof effect === 'function') effect() },
    /** @param {unknown} initial - ref seed. @returns {{current: unknown}} */
    useRef(initial) { return { current: initial } },
    /** @param {Function} callback - identity. */
    useCallback(callback) { return callback },
    /** @param {Function} factory - immediate value. */
    useMemo(factory) { return factory() },
    /** @param {Function} subscribe - subscription. @param {Function} getSnapshot - reader. */
    useSyncExternalStore(subscribe, getSnapshot) {
      subscribe(noop)
      return getSnapshot()
    },
  }
}

/**
 * The client locale service double.
 * @param {{ id?: string }} [options] - active locale id.
 * @returns {object} locale double.
 */
export function createFakeLocale(options = {}) {
  const activeId = options.id ?? 'zh'
  const dictionaries = new Map()
  const keyOf = (namespace, id) => namespace + '\u0000' + id
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
    /** @param {string} namespace - plugin namespace. */
    bind(namespace) {
      return (messageKey) => {
        const dictionary = dictionaries.get(keyOf(namespace, activeId)) ?? {}
        const value = dictionary[messageKey]
        return typeof value === 'string' ? value : messageKey
      }
    },
    /** @param {string} namespace - plugin namespace. @param {string} id - locale id. */
    dictionaryFor(namespace, id) { return dictionaries.get(keyOf(namespace, id)) },
    /** @returns {object} catalog snapshot. */
    getSnapshot() { return { locale: activeId, locales: [{ id: 'en' }, { id: 'zh' }] } },
  }
}

/**
 * A ctx that records what `apply` registers.
 * @param {{ locale?: object, layout?: object }} [options] - service doubles.
 * @returns {{ ctx: object, registrations: object[], effects: Function[] }}
 */
export function createFakeCtx(options = {}) {
  const locale = options.locale ?? createFakeLocale()
  const registrations = []
  const effects = []
  const ctx = {
    locale,
    slots: {
      /**
       * @param {string} name - slot key.
       * @param {() => unknown} callback - registration callback.
       * @returns {Function} disposer.
       */
      inject(name, callback) {
        callback()
        return noop
      },
      /**
       * @param {object} entry - registration entry.
       * @param {Function} component - seat component.
       * @returns {Function} disposer.
       */
      register(entry, component) {
        registrations.push({ entry, component })
        return noop
      },
    },
    /**
     * @param {Function} fn - effect body; its return value is the cleanup.
     * @returns {Function} cleanup.
     */
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    /** @param {string} name - service name. */
    get(name) { return name === 'layout' ? options.layout : undefined },
    logger: { info: noop, warn: noop, error: noop },
  }
  return { ctx, registrations, effects }
}

/**
 * Expand a recorded element tree by invoking component functions.
 * @param {unknown} node - element, string, array or null.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} tree of host elements and strings.
 */
export function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1))
  if (depth > 60) throw new Error('element tree is deeper than 60 levels; component loop?')
  if (typeof node.type === 'function') {
    return expand(node.type({ ...node.props, children: node.children }), depth + 1)
  }
  return { type: node.type, props: node.props, children: node.children.map((child) => expand(child, depth + 1)) }
}

/**
 * Flatten an expanded tree to visible text.
 * @param {unknown} node - expanded tree.
 * @returns {string} space-separated text.
 */
export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children.map(textOf).join(' ')
}

/**
 * Collect every expanded host element matching a predicate.
 * @param {unknown} node - expanded tree.
 * @param {(element: object) => boolean} predicate - matcher.
 * @returns {object[]} matches.
 */
export function findAll(node, predicate) {
  const found = []
  const walk = (child) => {
    if (child === null || child === undefined || typeof child === 'string') return
    if (Array.isArray(child)) { for (const item of child) walk(item); return }
    if (predicate(child)) found.push(child)
    for (const item of child.children) walk(item)
  }
  walk(node)
  return found
}

/**
 * First matching element, or undefined.
 * @param {unknown} node - expanded tree.
 * @param {(element: object) => boolean} predicate - matcher.
 * @returns {object|undefined} first match.
 */
export function findOne(node, predicate) {
  return findAll(node, predicate)[0]
}

/**
 * Elements of one host tag.
 * @param {unknown} node - expanded tree.
 * @param {string} tag - host tag name.
 * @returns {object[]} matches.
 */
export function byTag(node, tag) {
  return findAll(node, (element) => element.type === tag)
}

/**
 * Text of one element subtree.
 * @param {object} element - expanded host element.
 * @returns {string} its text.
 */
export function textOfElement(element) {
  return textOf(element)
}

/**
 * Whether an element tree contains the given text.
 * @param {unknown} node - expanded tree.
 * @param {string} needle - substring.
 * @returns {boolean} match.
 */
export function hasText(node, needle) {
  return textOf(node).includes(needle)
}

/**
 * Await one macrotask so store promises settle.
 * @returns {Promise<void>} resolved after a tick.
 */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}
