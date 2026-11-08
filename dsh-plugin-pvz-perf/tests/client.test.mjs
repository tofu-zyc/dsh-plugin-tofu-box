/**
 * Contract tests for the pvz-perf browser half.
 *
 * The real `client.js` is evaluated under a fake `window.__ModuleLoader__`, a
 * recording React and a fake service ctx, so every assertion here is about the
 * shipped bundle rather than a re-implementation. No browser, no jsdom, no
 * dependencies.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  boot,
  BUNDLE_SOURCE,
  LOCALE_NAMESPACE,
  createFakeLocale,
  createFakeCtx,
  expand,
  textOf,
  findOne,
  findAll,
  byTag,
  tick,
} from './_client_harness.mjs'

const { plugin, registration } = boot()
const seam = plugin.__test

/** The four seat descriptors the bundle must register, in registration order. */
const EXPECTED_SEATS = [
  { name: 'sidebar.panellist', id: 'pvz-perf', order: 26 },
  { name: 'main', id: undefined, key: 'pvz-perf' },
  { name: 'shell.overlay', id: 'pvz-perf.game-overlay', order: 900 },
  { name: 'sidebar.footer.action', id: 'pvz-perf.launch', order: 42 },
]

/**
 * Build a store whose status fetch resolves to the given payload.
 * @param {object|Error} payload - status payload, or an Error to throw.
 * @param {{ count?: { value: number } }} [counter] - optional call counter.
 * @returns {object} store.
 */
function storeWith(payload, counter) {
  return seam.createGameStore({
    fetchStatus: async () => {
      if (counter !== undefined) counter.value += 1
      if (payload instanceof Error) throw payload
      return payload
    },
  })
}

/** A ready status payload for E:\Games\pvz_perf_web. */
const READY = {
  ok: true,
  dir: 'E:\\Games\\pvz_perf_web',
  version: '3.3.4',
  sourceCommit: '79069204a7157f92d05f105e86ed50306ea09500',
  gameUrl: '/pvz-perf/game/',
}

test('bundle contract: loader id, inject list, single react dependency', () => {
  assert.equal(registration.id, 'dsh-plugin-pvz-perf')
  assert.equal(LOCALE_NAMESPACE, 'dsh-plugin-pvz-perf')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')

  const requires = [...BUNDLE_SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.ok(requires.length > 0, 'bundle must require react')
  for (const id of requires) assert.equal(id, 'react')

  // A plugin may not mount a second application or reach into the host DOM.
  assert.ok(!/document\.body/.test(BUNDLE_SOURCE), 'bundle must not append to document.body')
  assert.ok(!/@deepseek-ai\//.test(BUNDLE_SOURCE), 'bundle must not import a Harness client package')
})

test('route literals agree with the Host half when it exists', () => {
  assert.equal(seam.ROUTE, '/pvz-perf')
  assert.equal(seam.GAME_URL, '/pvz-perf/game/')
  assert.equal(seam.STATUS_URL, '/pvz-perf/status')
  assert.ok(BUNDLE_SOURCE.includes(seam.GAME_URL))
  assert.ok(BUNDLE_SOURCE.includes(seam.STATUS_URL))

  const hostPath = new URL('../index.js', import.meta.url)
  if (existsSync(hostPath)) {
    const host = readFileSync(hostPath, 'utf8')
    assert.ok(
      /['"`]\/pvz-perf['"`]/.test(host),
      'Host index.js no longer contains the /pvz-perf route literal the client assumes',
    )
  }
})

test('apply registers exactly the four additive seats', () => {
  const { ctx, registrations, effects } = createFakeCtx()
  plugin.apply(ctx)

  assert.equal(registrations.length, EXPECTED_SEATS.length)
  for (let index = 0; index < EXPECTED_SEATS.length; index += 1) {
    const expected = EXPECTED_SEATS[index]
    const actual = registrations[index].entry
    assert.equal(actual.name, expected.name)
    if (expected.id !== undefined) assert.equal(actual.id, expected.id)
    if (expected.key !== undefined) assert.equal(actual.key, expected.key)
    if (expected.order !== undefined) assert.equal(actual.order, expected.order)
    assert.equal(typeof registrations[index].component, 'function')
  }
  assert.ok(effects.length >= 2, 'apply must own its dictionary/style/store effects')
})

test('seat label thunks resolve through the locale service', () => {
  const locale = createFakeLocale()
  const { ctx, registrations } = createFakeCtx({ locale })
  plugin.apply(ctx)
  const panellist = registrations.find((entry) => entry.entry.name === 'sidebar.panellist')
  const footer = registrations.find((entry) => entry.entry.name === 'sidebar.footer.action')
  assert.equal(panellist.entry.label(), '植物大战僵尸')
  assert.equal(footer.entry.label(), '打开植物大战僵尸')
})

test('store folds a ready status and keeps one snapshot reference until changed', async () => {
  const store = storeWith(READY)
  const seen = []
  store.subscribe(() => seen.push(store.getSnapshot()))

  const before = store.getSnapshot()
  assert.equal(before.phase, 'idle')
  await store.refresh()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().info.dir, READY.dir)
  assert.equal(store.getSnapshot().info.version, '3.3.4')
  assert.ok(seen.length >= 2, 'loading and ready must both publish')
  assert.notEqual(seen[0], seen[seen.length - 1])
  assert.equal(store.getSnapshot(), store.getSnapshot(), 'unchanged state must keep its reference')
})

test('store open/hide/show/toggle/reload/close lifecycle', async () => {
  const store = storeWith(READY)
  await store.refresh()

  store.open()
  assert.deepEqual(
    [store.getSnapshot().opened, store.getSnapshot().visible],
    [true, true],
  )

  store.hide()
  assert.deepEqual([store.getSnapshot().opened, store.getSnapshot().visible], [true, false])

  store.show()
  assert.deepEqual([store.getSnapshot().opened, store.getSnapshot().visible], [true, true])

  store.toggle()
  assert.equal(store.getSnapshot().visible, false, 'toggle hides a visible layer')

  store.toggle()
  assert.equal(store.getSnapshot().visible, true, 'toggle re-shows a hidden layer')

  const reloadKey = store.getSnapshot().reloadKey
  store.reload()
  assert.equal(store.getSnapshot().reloadKey, reloadKey + 1)
  assert.equal(store.getSnapshot().visible, true)

  store.close()
  assert.deepEqual([store.getSnapshot().opened, store.getSnapshot().visible], [false, false])

  store.toggle()
  assert.equal(store.getSnapshot().opened, true, 'toggle reopens a closed layer')
})

test('ensureStatus fetches once and only retries after a failed check', async () => {
  const counter = { value: 0 }
  const store = storeWith(READY, counter)
  store.ensureStatus()
  await tick()
  assert.equal(counter.value, 1)
  assert.equal(store.getSnapshot().phase, 'ready')
  store.ensureStatus()
  await tick()
  assert.equal(counter.value, 1, 'a ready store must not refetch on every hub mount')
})

test('missing and failing status are distinct phases', async () => {
  const missing = storeWith({ ok: false, dir: null, hint: '没找到网页版' })
  await missing.refresh()
  assert.equal(missing.getSnapshot().phase, 'missing')
  assert.equal(missing.getSnapshot().info, null)
  assert.equal(missing.getSnapshot().error, '没找到网页版')
  missing.open()
  assert.equal(missing.getSnapshot().opened, true, 'the help page may still be opened')

  const broken = storeWith(new Error('status HTTP 500'))
  await broken.refresh()
  assert.equal(broken.getSnapshot().phase, 'error')
  assert.match(broken.getSnapshot().error, /status HTTP 500/)
  broken.ensureStatus()
  await tick()
  assert.equal(broken.getSnapshot().phase, 'error', 'a retry that fails again stays in error')
})

test('dispose stops notifications and later commits', async () => {
  const store = storeWith(READY)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  await store.refresh()
  const callsAfterRefresh = calls
  store.dispose()
  store.open()
  store.hide()
  assert.equal(calls, callsAfterRefresh, 'a disposed store must not notify')
})

test('overlay mounts the iframe only after open and hides without unmounting it', () => {
  const store = storeWith(READY)
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const overlay = () => seam.COMPONENTS.GameOverlay({ store, locale, layout: undefined })

  assert.equal(overlay(), null, 'overlay renders nothing before its first open')

  store.open()
  const visibleTree = expand(overlay())
  const iframe = findOne(visibleTree, (element) => element.type === 'iframe')
  assert.ok(iframe, 'the overlay must contain the game iframe')
  assert.equal(iframe.props.src, seam.GAME_URL)
  assert.match(iframe.props.allow, /fullscreen/)
  assert.equal(iframe.props.allowFullScreen, true)
  const layer = findOne(visibleTree, (element) => element.props.className === 'pvz-overlay')
  assert.equal(layer.props.style.display, 'flex')
  const buttons = byTag(visibleTree, 'button')
  const texts = buttons.map((button) => textOf(button))
  assert.ok(texts.includes('隐藏'), 'overlay exposes a hide action: ' + texts.join('|'))
  assert.ok(texts.includes('重新载入'), 'overlay exposes a reload action')
  assert.ok(texts.includes('结束'), 'overlay exposes an end action')

  store.hide()
  const hiddenTree = expand(overlay())
  const hiddenLayer = findOne(hiddenTree, (element) => element.props.className === 'pvz-overlay')
  assert.equal(hiddenLayer.props.style.display, 'none', 'hiding keeps the layer and iframe mounted')
  assert.ok(findOne(hiddenTree, (element) => element.type === 'iframe'), 'the game page survives hiding')

  store.reload()
  const reloaded = expand(overlay())
  const reloadedIframe = findOne(reloaded, (element) => element.type === 'iframe')
  assert.equal(reloadedIframe.props.key, 'pvz-frame-1', 'reload remounts with a fresh key')

  store.close()
  assert.equal(overlay(), null, 'ending unmounts the game page')
})

test('hub shows state, version and directory, and blocks start while missing', async () => {
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const layout = { calls: [], selectPanel(id) { this.calls.push(id) } }

  const ready = storeWith(READY)
  await ready.refresh()
  const readyTree = expand(seam.COMPONENTS.HubPanel({ store: ready, locale, layout }))
  const readyText = textOf(readyTree)
  assert.ok(readyText.includes('3.3.4'), 'hub shows the game version: ' + readyText)
  assert.ok(readyText.includes('E:\\Games\\pvz_perf_web'), 'hub shows the resolved directory')
  assert.ok(readyText.includes('就绪'), 'hub shows the ready chip')
  assert.ok(readyText.includes('开始游戏'), 'hub offers the primary start action')

  const start = byTag(readyTree, 'button').find((button) => textOf(button).includes('开始游戏'))
  assert.ok(start, 'start button exists')
  assert.equal(start.props.disabled, false)

  const back = byTag(readyTree, 'button').find((button) => textOf(button).includes('返回对话'))
  assert.ok(back, 'hub offers the back action when layout exists')
  back.props.onClick()
  assert.deepEqual(layout.calls, ['conversation'])

  const missing = storeWith({ ok: false, dir: null, hint: '没找到网页版' })
  await missing.refresh()
  const missingTree = expand(seam.COMPONENTS.HubPanel({ store: missing, locale, layout }))
  const missingText = textOf(missingTree)
  assert.ok(missingText.includes('未找到游戏'), 'hub shows the missing chip')
  assert.ok(missingText.includes(seam.ENV_OVERRIDE), 'help must name the environment override')
  assert.ok(missingText.includes(seam.DEFAULT_DIR_HINT), 'help must name the default directory')
  const blockedStart = byTag(missingTree, 'button').find((button) => textOf(button).includes('开始游戏'))
  assert.equal(blockedStart.props.disabled, true, 'start is disabled while no build is found')
})

test('footer toggle opens, hides and re-shows the game', () => {
  const store = storeWith(READY)
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const wide = () => seam.COMPONENTS.FooterLaunch({ store, locale, wide: true })
  const rail = () => seam.COMPONENTS.FooterLaunch({ store, locale, wide: false })

  const closedTree = expand(wide())
  const closedButton = byTag(closedTree, 'button')[0]
  assert.equal(closedButton.props['aria-pressed'], 'false')
  assert.ok(textOf(closedTree).includes('打开植物大战僵尸'))
  closedButton.props.onClick()
  assert.equal(store.getSnapshot().opened, true)

  const openTree = expand(wide())
  const openButton = byTag(openTree, 'button')[0]
  assert.equal(openButton.props['aria-pressed'], 'true')
  assert.ok(textOf(openTree).includes('隐藏植物大战僵尸'))
  openButton.props.onClick()
  assert.equal(store.getSnapshot().visible, false)

  const railTree = expand(rail())
  assert.equal(findAll(railTree, (element) => String(element.props.className ?? '').includes('pvz-footer-label')).length, 0,
    'the rail variant renders no label text')
  const railButton = byTag(railTree, 'button')[0]
  assert.ok(railButton.props.title.includes('继续'), 'the rail tooltip offers resume')
})

test('locale dictionaries cover the same keys and resolve in both languages', async () => {
  const { zh, en } = seam.LOCALES
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en must carry the same keys')

  for (const id of ['zh', 'en']) {
    const locale = createFakeLocale({ id })
    const { ctx } = createFakeCtx({ locale })
    plugin.apply(ctx)
    const store = storeWith(READY)
    await store.refresh()
    store.open()
    const trees = [
      expand(seam.COMPONENTS.HubPanel({ store, locale, layout: { selectPanel() {} } })),
      expand(seam.COMPONENTS.GameOverlay({ store, locale, layout: { selectPanel() {} } })),
      expand(seam.COMPONENTS.FooterLaunch({ store, locale, wide: true })),
    ]
    const text = trees.map(textOf).join(' ')
    assert.ok(!/\b(hub|overlay|footer|panel|common|error)\.[a-z]/i.test(text),
      'unresolved locale key surfaced in ' + id + ': ' + text.match(/\b(hub|overlay|footer|panel|common|error)\.[a-z.]+/i))
    assert.ok(text.includes('3.3.4'))
  }
})

test('styling stays inside pvz- classes and theme tokens', () => {
  const css = BUNDLE_SOURCE.slice(BUNDLE_SOURCE.indexOf('const CSS = `'), BUNDLE_SOURCE.indexOf('`', BUNDLE_SOURCE.indexOf('const CSS = `') + 13))
  assert.ok(css.length > 1000, 'style block present')
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])
  for (const name of classes) {
    assert.ok(name.startsWith('pvz-'), 'unprefixed class in plugin CSS: ' + name)
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/#(05070a|000|fff|ffffff)\b/gi, '')), 'chrome colours must use theme tokens')
})
