/**
 * Contract tests for the pvz-perf browser half.
 *
 * The real `client.js` is evaluated under a fake `window.__ModuleLoader__`, a
 * recording React and a fake service ctx, so every assertion here is about the
 * shipped bundle rather than a re-implementation. No browser, no jsdom, no
 * dependencies.
 *
 * Layout contract under test: the game lives inside the plugin's `main` panel
 * (the shell's own central column). It must never render a full-window fixed
 * layer, because that covers the sidebar and, in the desktop shell, hides its
 * controls underneath the window buttons.
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

/** The three seat descriptors the bundle must register, in registration order. */
const EXPECTED_SEATS = [
  { name: 'sidebar.panellist', id: 'pvz-perf', order: 26 },
  { name: 'main', id: undefined, key: 'pvz-perf' },
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

test('apply registers exactly the three additive seats', () => {
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

test('the plugin never claims a full-window layer seat', () => {
  const { ctx, registrations } = createFakeCtx()
  plugin.apply(ctx)
  const names = registrations.map((entry) => entry.entry.name)
  assert.deepEqual(names, ['sidebar.panellist', 'main', 'sidebar.footer.action'])
  assert.ok(!names.includes('shell.overlay'), 'a full-window overlay would cover the sidebar')
  assert.ok(!BUNDLE_SOURCE.includes('pvz-overlay'), 'no overlay layout may remain in the bundle')
  assert.ok(!/position:fixed/.test(BUNDLE_SOURCE), 'the game view must sit in the panel flow, not float over the app')
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

test('store open/reload/close lifecycle', async () => {
  const store = storeWith(READY)
  await store.refresh()

  store.open()
  assert.equal(store.getSnapshot().opened, true)

  const reloadKey = store.getSnapshot().reloadKey
  store.reload()
  assert.equal(store.getSnapshot().reloadKey, reloadKey + 1)
  assert.equal(store.getSnapshot().opened, true, 'reload keeps the game open')

  store.close()
  assert.equal(store.getSnapshot().opened, false)

  store.open()
  assert.equal(store.getSnapshot().opened, true, 'the game can be opened again after closing')
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
})

test('dispose stops notifications and later commits', async () => {
  const store = storeWith(READY)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  await store.refresh()
  const callsAfterRefresh = calls
  store.dispose()
  store.open()
  store.close()
  assert.equal(calls, callsAfterRefresh, 'a disposed store must not notify')
})

test('game view renders the iframe inside the panel only after open', () => {
  const store = storeWith(READY)
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const view = () => seam.COMPONENTS.GameEmbed({ store, locale, layout: undefined })

  assert.equal(view(), null, 'the game view renders nothing before its first open')

  store.open()
  const tree = expand(view())
  const iframe = findOne(tree, (element) => element.type === 'iframe')
  assert.ok(iframe, 'the panel must contain the game iframe')
  assert.equal(iframe.props.src, seam.GAME_URL)
  assert.match(iframe.props.allow, /fullscreen/)
  assert.equal(iframe.props.allowFullScreen, true)
  const root = findOne(tree, (element) => element.props.className === 'pvz-game')
  assert.ok(root, 'the game view is a panel-flow container')
  const buttons = byTag(tree, 'button')
  const texts = buttons.map((button) => textOf(button))
  assert.ok(texts.includes('返回对话'), 'game bar exposes back-to-chat: ' + texts.join('|'))
  assert.ok(texts.includes('全屏'), 'game bar exposes fullscreen')
  assert.ok(texts.includes('重新载入'), 'game bar exposes reload')
  assert.ok(texts.includes('结束'), 'game bar exposes end')

  store.reload()
  const reloaded = expand(view())
  const reloadedIframe = findOne(reloaded, (element) => element.type === 'iframe')
  assert.equal(reloadedIframe.props.key, 'pvz-frame-1', 'reload remounts with a fresh key')

  store.close()
  assert.equal(view(), null, 'ending unmounts the game page')
})

test('back button hands the main column back to the conversation', () => {
  const store = storeWith(READY)
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const layout = { calls: [], selectPanel(id) { this.calls.push(id) } }
  store.open()
  const tree = expand(seam.COMPONENTS.GameEmbed({ store, locale, layout }))
  const back = byTag(tree, 'button').find((button) => textOf(button).includes('返回对话'))
  assert.ok(back, 'back button exists')
  back.props.onClick()
  assert.deepEqual(layout.calls, ['conversation'])
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

test('the panel switches between hub and game without leaving the column', async () => {
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const store = storeWith(READY)
  await store.refresh()
  const panel = () => expand(seam.COMPONENTS.PvzPanel({ store, locale, layout: undefined }))

  const hubTree = panel()
  assert.ok(findOne(hubTree, (element) => element.props.className === 'pvz-hub'), 'closed panel shows the hub')
  assert.equal(findOne(hubTree, (element) => element.type === 'iframe'), undefined)

  store.open()
  const gameTree = panel()
  assert.ok(findOne(gameTree, (element) => element.props.className === 'pvz-game'), 'open panel shows the game')
  assert.ok(findOne(gameTree, (element) => element.type === 'iframe'))
})

test('footer shortcut selects the panel and starts the game once', async () => {
  const locale = createFakeLocale()
  seam.registerDictionaries(locale)
  const layout = { calls: [], selectPanel(id) { this.calls.push(id) } }
  const store = storeWith(READY)
  await store.refresh()

  const click = () => {
    const tree = expand(seam.COMPONENTS.FooterLaunch({ store, locale, layout, wide: true }))
    byTag(tree, 'button')[0].props.onClick()
    return tree
  }
  const closedTree = click()
  assert.deepEqual(layout.calls, [seam.PANEL_ID], 'the shortcut selects the plugin panel')
  assert.equal(store.getSnapshot().opened, true, 'the shortcut starts the game when closed')

  const openTree = click()
  assert.equal(textOf(openTree).includes('回到植物大战僵尸'), true, 'the shortcut offers a way back in')

  const rail = expand(seam.COMPONENTS.FooterLaunch({ store, locale, layout, wide: false }))
  assert.equal(findAll(rail, (element) => String(element.props.className ?? '').includes('pvz-footer-label')).length, 0,
    'the rail variant renders no label text')
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
      expand(seam.COMPONENTS.PvzPanel({ store, locale, layout: { selectPanel() {} } })),
      expand(seam.COMPONENTS.FooterLaunch({ store, locale, layout: { selectPanel() {} }, wide: true })),
    ]
    const text = trees.map(textOf).join(' ')
    assert.ok(!/\b(hub|game|footer|panel|common|error)\.[a-z]/i.test(text),
      'unresolved locale key surfaced in ' + id + ': ' + text.match(/\b(hub|game|footer|panel|common|error)\.[a-z.]+/i))
    assert.ok(text.includes('3.3.4') || text.includes('植物大战僵尸') || text.includes('Plants vs. Zombies'))
  }
})

test('game view stays inside the panel and never covers the app chrome', () => {
  // The Electron shell draws minimize/maximize/close above the page at the
  // window's right edge; anything placed under them is invisible and inert.
  // The game view must therefore live inside the panel and never paint a
  // full-window bar: that was the first real-machine round's bug.
  assert.match(BUNDLE_SOURCE, /pvz-game-bar/, 'the game has its own compact bar inside the panel')
  assert.ok(!BUNDLE_SOURCE.includes('260px'), 'no window-controls padding hack should be needed')
  assert.match(BUNDLE_SOURCE, /'Escape'/, 'an Escape fallback must exist for mouse-free exit')
})

test('fullscreen is a real toggle with a visible way back', () => {
  // Real-machine round two: fullscreen kept the tool bar as a "notch" and the
  // same button only re-entered it, so the browser had no exit affordance.
  assert.match(BUNDLE_SOURCE, /document\.exitFullscreen/, 'fullscreen must be exited explicitly')
  assert.match(BUNDLE_SOURCE, /fullscreenchange/, 'the label and overlay must follow browser fullscreen state')
  assert.match(BUNDLE_SOURCE, /pvz-game-exit/, 'a floating exit control must exist while fullscreen')
  assert.match(BUNDLE_SOURCE, /data-fullscreen/, 'fullscreen styling must be state-driven')
  assert.match(BUNDLE_SOURCE, /game\.exitFullscreen/, 'the toggle label must switch to exit fullscreen')
  assert.ok(/data-fullscreen="true"\][^}]*display:none/.test(BUNDLE_SOURCE), 'the tool bar is hidden in fullscreen')
})

test('styling stays inside pvz- classes and theme tokens', () => {
  const cssStart = BUNDLE_SOURCE.indexOf('const CSS = `')
  const css = BUNDLE_SOURCE.slice(cssStart + 13, BUNDLE_SOURCE.indexOf('`', cssStart + 13))
  assert.ok(css.length > 1000, 'style block present')
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])
  for (const name of classes) {
    assert.ok(name.startsWith('pvz-'), 'unprefixed class in plugin CSS: ' + name)
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/#(000|fff|ffffff)\b/gi, '')), 'chrome colours must use theme tokens')
})
