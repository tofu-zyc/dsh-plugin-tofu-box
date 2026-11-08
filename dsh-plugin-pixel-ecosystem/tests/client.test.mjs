/**
 * Client half: registration, locale dictionaries, stylesheet and panel render.
 *
 * What this pins and why: the browser bundle is what the user actually sees, so
 * the things that break silently are the ones no engine test can catch — a slot
 * registered under two different ids (the sidebar icon would open nothing), a
 * locale key that exists in Chinese but not English (a blank label), a CSS class
 * without the pe- prefix (a selector leaking into shipped chrome), a panel that
 * throws on first render, or a save file that disappears without telling the
 * player. Everything runs through the boot harness with a fake React and a fake
 * locale service; no DOM, no browser.
 *
 * The dictionary test is deliberately strict in both directions: every key the
 * bundle asks for must exist, and every key defined must still be asked for. A
 * family that is rendered from a template literal (drives, causes, events, ...)
 * is enumerated from the contract list below or from the engine seam, so a new
 * drive or a new death cause cannot be added to the model without a label.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boot, createFakeLocale, expand, findAll, textOf, BUNDLE_SOURCE, LOCALE_NAMESPACE,
} from './_harness.mjs'

const { plugin, engine, seam } = boot()
const { CHINESE, ENGLISH, PANEL_GLYPH, GLYPHS, PanelIcon, PixelGlyph, TerrariumPanel } = seam

/**
 * Drive channels the inspector must draw, in contract order
 * (docs/20-CORE-LOOP.md section 2.2). Behaviour owns the list; it is repeated
 * here so a channel cannot be added to the model without a translated label.
 */
const DRIVE_KEYS = ['hunger', 'thirst', 'cold', 'fatigue', 'fear', 'social', 'curiosity', 'libido']

/** Event kinds the ticker can show. Mirrors EVENT_KINDS in the store. */
const EVENT_KINDS = ['predation', 'birth', 'death', 'migration', 'hoard', 'placed']

/** Storage keys the 0.3 build reads and writes. */
const STORAGE_KEY = 'dsh-pixel-ecosystem:v2'
const LEGACY_STORAGE_KEY = 'dsh-pixel-ecosystem:v1'

/**
 * Run plugin.apply() against a fake Cordis context and record what it seats.
 * @param {{ localeId?: string, layout?: object }} [options] - active locale id
 *   and the optional layout service (ctx.get('layout')).
 * @returns {{ locale: object, registrations: object[], injected: string[] }} the
 *   locale double, the slot registrations in call order and the slot names.
 */
function mount(options = {}) {
  const locale = createFakeLocale({ id: options.localeId ?? 'zh' })
  const registrations = []
  const injected = []
  plugin.apply({
    effect: callback => { callback() },
    get: name => (name === 'layout' ? options.layout : undefined),
    locale,
    slots: {
      inject(slot, callback) { injected.push(slot); callback() },
      register(entry, component) { registrations.push({ entry, component }); return () => {} },
    },
  })
  return { locale, registrations, injected }
}

/** @param {unknown} node - expanded tree. @returns {string[]} trimmed button labels. */
const buttonLabels = node => findAll(node, element => element.type === 'button').map(element => textOf(element).trim())

/** @param {unknown} node - expanded tree. @param {string} className - class to match. */
const textsWithClass = (node, className) => findAll(node, element => element.props?.className === className).map(textOf)

/** The stylesheet text the bundle injects, sliced out of the source. */
function cssText() {
  const marker = 'const CSS = `'
  const start = BUNDLE_SOURCE.indexOf(marker)
  assert.ok(start > 0, 'the bundle must define the stylesheet as a template literal')
  const open = start + marker.length
  const close = BUNDLE_SOURCE.indexOf('`', open)
  assert.ok(close > open, 'the stylesheet template literal must be closed')
  return BUNDLE_SOURCE.slice(open, close)
}

/**
 * A store with a live world, no storage and a frozen clock.
 * @returns {object} store.
 */
async function quietStore() {
  const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  await store.whenReady()
  return store
}

/**
 * Let the world run for a while and publish like the animation loop does.
 * @param {object} store - the store.
 * @param {number} [ticks] - how many fixed steps to take.
 * @returns {object} the last published snapshot.
 */
function runWorld(store, ticks = 40) {
  const world = store.getWorld()
  let snapshot = store.getSnapshot()
  for (let step = 0; step < ticks; step++) {
    engine.stepWorld(world, engine.TICK)
    if (step % 10 === 9) {
      store.setPaused(false)
      snapshot = store.getSnapshot()
    }
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the client injects exactly the slots and locale services', async () => {
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])
})

test('apply() seats the sidebar icon and the keyed main panel under one id', async () => {
  const { registrations, injected } = mount()
  assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'both additive seats must be injected')
  assert.equal(registrations.length, 2, 'the plugin adds exactly two seats')
  const [sidebar, main] = registrations
  assert.equal(sidebar.entry.name, 'sidebar.panellist')
  assert.equal(main.entry.name, 'main')
  assert.equal(sidebar.entry.id, 'pixel-ecosystem', 'the sidebar entry id must be the panel id')
  assert.equal(main.entry.key, 'pixel-ecosystem', 'the main slot key must be the panel id')
  assert.equal(sidebar.entry.id, main.entry.key, 'DESIGN 6.3: the two ids must be the same string')
  assert.equal(typeof sidebar.entry.order, 'number', 'the sidebar entry needs a numeric order')
  assert.equal(sidebar.component, PanelIcon, 'the sidebar seat renders the pixel icon')
  assert.equal(typeof main.component, 'function', 'the main seat renders a component')
})

test('the main seat hands the shared store, locale and layout to the panel', async () => {
  const layout = { selectPanel() {} }
  const { registrations, locale } = mount({ layout })
  let element = registrations[1].component({ someSlotProp: true })
  // The seat wraps the panel in an error boundary; unwrap it to reach the panel.
  while (element.type !== TerrariumPanel) element = element.children[0]
  assert.equal(element.type, TerrariumPanel, 'the main seat must render TerrariumPanel')
  assert.equal(element.props.locale, locale, 'the panel must translate through the live locale service')
  assert.equal(element.props.layout, layout, 'the panel must receive the layout service for "back to chat"')
  assert.equal(element.props.someSlotProp, true, 'slot props must be forwarded to the panel')
  assert.equal(typeof element.props.store.getSnapshot, 'function', 'one store must be created per plugin instance')
})

test('the sidebar label resolves through the active dictionary', async () => {
  assert.equal(mount({ localeId: 'zh' }).registrations[0].entry.label(), CHINESE['panel.title'])
  assert.equal(mount({ localeId: 'en' }).registrations[0].entry.label(), ENGLISH['panel.title'])
})

test('apply() registers both dictionaries for every built-in locale id', async () => {
  const { locale } = mount()
  assert.equal(locale.dictionaryFor(LOCALE_NAMESPACE, 'zh'), CHINESE)
  assert.equal(locale.dictionaryFor(LOCALE_NAMESPACE, 'en'), ENGLISH)
  // zh-CN / zh-Hans are what the harness catalog actually reports, so they matter.
  assert.equal(locale.dictionaryFor(LOCALE_NAMESPACE, 'zh-CN'), CHINESE)
  assert.equal(locale.dictionaryFor(LOCALE_NAMESPACE, 'zh-Hans'), CHINESE)
})

// ---------------------------------------------------------------------------
// Dictionaries and stylesheet
// ---------------------------------------------------------------------------

test('CHINESE and ENGLISH carry exactly the same keys', async () => {
  assert.deepEqual(Object.keys(CHINESE).sort(), Object.keys(ENGLISH).sort())
})

test('every key the panels render exists in both dictionaries, and no key is dead', async () => {
  const required = new Set()
  // Brushes, species, genes, intents, stages.
  for (const tool of ['grass', 'weed', 'tree', 'bush']) required.add('tool.' + tool)
  for (const tool of seam.TERRAIN_TOOL_IDS) required.add('tool.' + tool)
  for (const id of engine.SPECIES_IDS) required.add('species.' + id)
  for (const id of engine.SPECIES_IDS) {
    assert.ok(seam.LIFE_TOOLS.includes(id), 'LIFE_TOOLS is missing the ' + id + ' tool, so the player cannot place one')
  }
  for (const key of engine.GENE_KEYS) required.add('inspect.gene.' + key)
  for (const key of engine.INTENT_IDS) required.add('intent.' + key)
  for (const key of engine.CAUSE_KEYS) required.add('cause.' + key)
  for (const stage of ['juvenile', 'adult', 'elder']) required.add('stage.' + stage)
  for (const speed of [1, 2, 4, 8]) required.add('speed.' + speed)
  for (let index = 1; index <= 9; index++) required.add('help.' + index)
  // Inspector v2: eight drives, the timed state, the goal and the decision
  // record. The needs channels of 0.2.x are gone: five of them were aliases of
  // drives and the panel showed the same number twice.
  for (const key of DRIVE_KEYS) required.add('drive.' + key)
  for (const key of ['approach', 'execute', 'done']) required.add('phase.' + key)
  for (const key of ['search', 'idle']) required.add('reason.' + key)
  for (const key of [
    'state', 'remaining', 'nextDecision', 'goal', 'goalDistance', 'structure', 'maturity',
    'health', 'fatigue', 'decision', 'decisionWhy', 'decisionBeat', 'decisionNone',
    'decisionAgo', 'cause', 'causePredicted', 'causeInferred', 'causeNone', 'threats',
    'plan', 'planStep', 'kg', 'seconds', 'drives', 'drivesDerived',
  ]) required.add('inspect.' + key)
  // Event ticker.
  for (const kind of EVENT_KINDS) required.add('event.' + kind)
  required.add('event.all')
  for (const key of ['title', 'empty', 'filter', 'locate', 'count', 'justNow', 'secondsAgo']) required.add('events.' + key)
  // Species table.
  for (const key of ['panelTitle', 'extinct', 'empty', 'deadTotal']) required.add('species.' + key)
  for (const key of ['count', 'energy', 'age', 'causes']) required.add('metric.' + key)
  // Energy panel.
  for (const key of [
    'panelTitle', 'sun', 'plants', 'herbivores', 'carnivores', 'respire', 'plantRespire',
    'gpp', 'stock', 'animals', 'unit', 'note', 'waiting',
  ]) required.add('flow.' + key)
  for (const key of ['title', 'species', 'respire', 'intake', 'net']) required.add('budget.' + key)
  // Tabs, guide, status and the save-file notice.
  for (const key of ['tools', 'species', 'energy']) required.add('tab.' + key)
  for (const key of ['title', 'step1', 'step2', 'step3', 'dismiss', 'again']) required.add('onboard.' + key)
  for (const key of [
    'emptyWorld', 'emptyWorldHint', 'restock', 'temperature', 'pulse', 'loading',
    'saved', 'savePending', 'saveFailed',
  ]) required.add('status.' + key)
  // One sentence per save-error code, plus the legacy and generic fallbacks.
  for (const key of [
    'legacyTitle', 'legacyBody', 'loadTitle', 'loadBody', 'dismiss',
    'unsupportedVersion', 'corrupt', 'noDecompressor',
  ]) required.add('notice.' + key)
  for (const key of ['preview', 'cell']) required.add('brush.' + key)
  for (const key of ['erased']) required.add('toast.' + key)
  // Every literal t('...') the bundle calls, plus the DESIGN 7 key table.
  for (const match of BUNDLE_SOURCE.matchAll(/\bt\('([\w.]+)'\)/g)) required.add(match[1])
  for (const key of [
    'panel.title', 'action.back', 'action.play', 'action.pause', 'action.newWorld',
    'action.newWorldConfirm', 'action.help', 'action.close', 'action.fit',
    'speed.paused', 'stat.day', 'stat.corpses', 'tool.group.life', 'tool.group.terrain',
    'brush.label', 'brush.small', 'brush.medium', 'brush.large', 'chart.title',
    'inspect.empty', 'inspect.age', 'inspect.energy', 'inspect.generation', 'inspect.children',
    'inspect.follow', 'inspect.unfollow', 'inspect.title', 'inspect.emptyHint', 'help.title',
    'action.step', 'action.deselect', 'toast.placed', 'toast.blocked',
  ]) required.add(key)
  for (const key of required) {
    assert.equal(typeof CHINESE[key], 'string', 'CHINESE is missing ' + key)
    assert.equal(typeof ENGLISH[key], 'string', 'ENGLISH is missing ' + key)
    assert.notEqual(CHINESE[key], '', 'CHINESE has an empty message for ' + key)
    assert.notEqual(ENGLISH[key], '', 'ENGLISH has an empty message for ' + key)
  }
  // A dictionary entry nobody asks for is dead weight; keep the tables honest.
  for (const key of Object.keys(CHINESE)) {
    assert.ok(required.has(key), key + ' is defined but never used by the bundle or the key table')
  }
})

test('every life tool resolves to a dictionary entry', async () => {
  // Regression guard for the 0.1.0 test report: all eleven life tools were
  // labelled with t('tool.' + id), but the seven animal ids only exist as
  // 'species.*', so those palette buttons rendered a raw key.
  for (const tool of seam.LIFE_TOOLS) {
    const key = engine.SPECIES[tool] === undefined ? 'tool.' + tool : 'species.' + tool
    assert.equal(typeof CHINESE[key], 'string', 'CHINESE is missing ' + key)
    assert.equal(typeof ENGLISH[key], 'string', 'ENGLISH is missing ' + key)
  }
})

test('every CSS selector is pe- prefixed', async () => {
  const css = cssText()
  assert.ok(css.length > 1000, 'the stylesheet looks truncated (' + css.length + ' chars)')
  assert.equal(css.includes('/*'), false, 'the stylesheet must not carry comments: the selector scan reads them as selectors')
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map(match => match[1].trim()).filter(Boolean)
  assert.ok(selectors.length > 20, 'expected a real stylesheet, found ' + selectors.length + ' selectors')
  for (const selector of selectors) {
    if (selector.startsWith('@media')) continue
    for (const part of selector.split(',')) {
      assert.match(part.trim(), /^\.pe-/, 'unprefixed selector would leak into shipped chrome: ' + selector)
    }
  }
  // The classes the components actually use must all exist in the sheet.
  for (const className of [
    'pe-root', 'pe-head', 'pe-chips', 'pe-stage', 'pe-canvas', 'pe-side', 'pe-tool', 'pe-modal',
    'pe-eventbar', 'pe-event', 'pe-tab', 'pe-tabbody', 'pe-dock', 'pe-srow', 'pe-drive',
    'pe-flow-row', 'pe-onboard', 'pe-emptyworld', 'pe-notice', 'pe-brushpreview', 'pe-blank',
  ]) {
    assert.ok(css.includes('.' + className + '{') || css.includes('.' + className + ' ') || css.includes('.' + className + ','),
      'the stylesheet is missing .' + className)
  }
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test('TerrariumPanel renders against a real store with the panel title and one chip per species', async () => {
  const { locale } = mount()
  const store = await quietStore()
  assert.equal(store.getSnapshot().ready, true, 'the store must have built a world')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))

  assert.ok(textsWithClass(tree, 'pe-title').includes(CHINESE['panel.title']), 'the panel must show its localized title')

  const chips = findAll(tree, element => element.props?.className === 'pe-chip')
  assert.equal(chips.length, engine.SPECIES_IDS.length, 'the header must show one chip per species')
  assert.deepEqual(
    chips.map(chip => chip.props.title),
    engine.SPECIES_IDS.map(id => CHINESE['species.' + id]),
    'each chip must be labelled with its localized species name',
  )
  const counts = textsWithClass(tree, 'pe-chip-count')
  const stats = engine.sampleStats(store.getWorld())
  assert.deepEqual(counts, engine.SPECIES_IDS.map(id => String(stats.counts[id])),
    'each chip must show the live population')

  assert.equal(textsWithClass(tree, 'pe-tool-label').length, seam.LIFE_TOOLS.length + seam.TERRAIN_TOOL_IDS.length,
    'the palette must offer every life and terrain tool')
  const emptyCards = findAll(tree, element => element.props?.className === 'pe-empty')
  assert.equal(emptyCards.length, 1, 'with nothing selected the inspector shows one hint card')
  assert.ok(textOf(emptyCards[0]).includes(CHINESE['inspect.empty']),
    'with nothing selected the inspector shows the hint')
  const labels = buttonLabels(tree)
  for (const speed of [1, 2, 4, 8]) assert.ok(labels.includes(CHINESE['speed.' + speed]), 'the panel must offer ' + speed + 'x')
  assert.ok(labels.includes(CHINESE['action.newWorld']), 'the panel must offer a new world')
  assert.ok(labels.includes(CHINESE['action.help']), 'the panel must offer the help sheet')
  assert.ok(labels.includes(CHINESE['brush.small']), 'the panel must offer the brush sizes')
  store.dispose()
})

test('the species table lists every species with its reserve and death causes', async () => {
  const { locale } = mount()
  const store = await quietStore()
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const rows = findAll(tree, element => typeof element.props?.className === 'string' &&
    element.props.className.startsWith('pe-srow'))
  assert.ok(rows.length >= engine.SPECIES_IDS.length,
    'the species table must have a row per species, found ' + rows.length)
  for (const id of engine.SPECIES_IDS) {
    assert.ok(textOf(rows).includes(CHINESE['species.' + id]), 'the species table must name ' + id)
  }
  // The budget table and the species table share the row class on purpose.
  assert.ok(textOf(tree).includes(CHINESE['metric.count']), 'the table must label its count column')
  store.dispose()
})

test('the inspector shows the eight drives, the state clock and the decision record', async () => {
  const { locale } = mount()
  const store = await quietStore()
  runWorld(store, 30)
  const world = store.getWorld()
  const target = world.entities.find(entity => entity.state !== undefined) ?? world.entities[0]
  store.selectAt(target.x, target.y)
  const selected = store.getSnapshot().selected
  assert.notEqual(selected, null, 'the store must select the animal under the cursor')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))

  const drives = findAll(tree, element => typeof element.props?.className === 'string' &&
    element.props.className.startsWith('pe-drive ') || element.props?.className === 'pe-drive')
  assert.equal(drives.length, DRIVE_KEYS.length, 'the inspector must draw one bar per drive')
  const driveLabels = textsWithClass(tree, 'pe-drive-label')
  assert.deepEqual(driveLabels, DRIVE_KEYS.map(key => CHINESE['drive.' + key]), 'every drive bar must be labelled')

  const rendered = textOf(tree)
  assert.ok(rendered.includes(CHINESE['inspect.state']), 'the inspector must show the current state')
  assert.ok(rendered.includes(CHINESE['inspect.remaining']), 'the inspector must show how long it lasts')
  assert.ok(rendered.includes(CHINESE['inspect.decision']), 'the inspector must show the last decision')
  assert.ok(rendered.includes(CHINESE['inspect.cause']), 'the inspector must show the predicted cause')
  assert.equal(textsWithClass(tree, 'pe-quote').length, 1, 'the decision reason gets its own block')
  store.dispose()
})

test('the energy panel draws the four-stage cascade once the world runs', async () => {
  const { locale } = mount()
  const store = await quietStore()
  const snapshot = runWorld(store, 60)
  assert.ok(snapshot.flows.gpp > 0, 'primary production must be measured, got ' + snapshot.flows.gpp)
  assert.ok(snapshot.flows.herbs >= 0 && snapshot.flows.carns >= 0, 'both animal flows must be numbers')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const flowRows = findAll(tree, element => element.props?.className === 'pe-flow-row')
  assert.equal(flowRows.length, 5, 'sun, plants, herbivores and both respiration sides each get a bar')
  const rendered = textOf(tree)
  assert.ok(rendered.includes(CHINESE['flow.sun']), 'the cascade must name the sun stage')
  assert.ok(rendered.includes(CHINESE['budget.title']), 'the panel must show the per-species budget')
  assert.ok(rendered.includes(CHINESE['flow.unit']), 'the panel must state its unit')
  store.dispose()
})

test('the event ticker reports what the player did, and a click flies there', async () => {
  const { locale } = mount()
  const store = await quietStore()
  store.getSnapshot()
  const world = store.getWorld()
  const target = world.entities[0]
  const released = store.paintAt(target.x, target.y, false)
  store.setBrush('rabbit', 0)
  const placed = store.paintAt(target.x, target.y, false)
  store.setPaused(false)
  const snapshot = store.getSnapshot()
  assert.ok(released >= 0 && placed > 0, 'the brush must release at least one rabbit, got ' + placed)
  const events = snapshot.events.filter(event => event.kind === 'placed')
  assert.ok(events.length > 0, 'placing animals must show up in the ticker')
  assert.equal(events[0].species, 'rabbit', 'the event must carry the species')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const chips = findAll(tree, element => typeof element.props?.className === 'string' &&
    element.props.className.startsWith('pe-event '))
  assert.ok(chips.length > 0, 'the ticker must render one chip per event')
  assert.ok(chips[0].props.title.includes(CHINESE['event.placed']), 'the chip must be titled with the event kind')
  assert.equal(typeof chips[0].props.onClick, 'function', 'an event chip must be clickable so the camera can fly there')
  assert.ok(textOf(tree).includes(String(events[0].count)), 'the chip must show how many animals it covers')
  store.dispose()
})

test('the first-run guide shows until it is dismissed', async () => {
  const { locale } = mount()
  const store = await quietStore()
  assert.equal(store.getSnapshot().onboarding, false, 'a fresh store has not seen the guide')
  const before = expand(TerrariumPanel({ store, locale, layout: undefined }))
  assert.ok(textOf(before).includes(CHINESE['onboard.title']), 'the guide must greet a first-time player')
  assert.ok(buttonLabels(before).includes(CHINESE['onboard.dismiss']), 'the guide needs a dismiss button')
  store.markOnboardingSeen()
  assert.equal(store.getSnapshot().onboarding, true, 'dismissing must be remembered')
  const after = expand(TerrariumPanel({ store, locale, layout: undefined }))
  assert.equal(textOf(after).includes(CHINESE['onboard.title']), false, 'the guide must not come back')
  store.dispose()
})

test('an empty world says so and offers a restock', async () => {
  const { locale } = mount()
  const store = await quietStore()
  store.getSnapshot()
  const world = store.getWorld()
  world.entities.length = 0
  store.setPaused(false)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.world.empty, true, 'a world with no animals is empty')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const cards = findAll(tree, element => element.props?.className === 'pe-emptyworld')
  assert.equal(cards.length, 1, 'the stage must explain why nothing is moving')
  assert.ok(textOf(cards[0]).includes(CHINESE['status.emptyWorld']), 'the card must say the world is quiet')
  assert.ok(buttonLabels(tree).includes(CHINESE['status.restock']), 'the card must offer the restock button')
  assert.ok(store.restock() > 0, 'restock must put animals back')
  store.dispose()
})

test('the panel only offers "back to chat" when a layout service is available', async () => {
  const plain = mount()
  const plainTree = expand(plain.registrations[1].component({}))
  assert.equal(buttonLabels(plainTree).includes(CHINESE['action.back']), false,
    'without a layout service the back button has nowhere to go')

  const withLayout = mount({ layout: { selectPanel() {} } })
  const layoutTree = expand(withLayout.registrations[1].component({}))
  assert.equal(buttonLabels(layoutTree).includes(CHINESE['action.back']), true,
    'with a layout service the panel must offer "back to chat"')
})

test('PanelIcon renders a pixel grid as unit rects, with an outline when active', async () => {
  const inked = PANEL_GLYPH.reduce((total, row) => total + [...row].filter(cell => cell !== '.').length, 0)
  for (const row of PANEL_GLYPH) {
    assert.equal(row.length, PANEL_GLYPH[0].length, 'the icon glyph must be rectangular')
  }
  const inactive = expand(PanelIcon({ size: 18, active: false }))
  const active = expand(PanelIcon({ size: 18, active: true }))
  assert.equal(inactive.type, 'svg')
  assert.equal(inactive.props.viewBox, '0 0 9 9', 'the icon is a 9x9 pixel grid')
  assert.equal(inactive.props.width, 18, 'the requested size must be honoured')
  assert.equal(inactive.children.length, inked, 'one rect per inked glyph cell')
  for (const rect of inactive.children) {
    assert.equal(rect.type, 'rect')
    assert.equal(rect.props.width, 1, '1 unit = 1 pixel')
    assert.equal(rect.props.height, 1)
  }
  assert.equal(active.children.length, inked + 1, 'the active state adds exactly one outline rect')
  const outline = active.children.at(-1)
  assert.equal(outline.props.fill, 'none')
  assert.equal(outline.props.stroke, 'currentColor')
})

test('every species has its own glyph, and every event kind has one too', async () => {
  for (const id of engine.SPECIES_IDS) {
    const grid = GLYPHS[id]
    assert.ok(Array.isArray(grid), 'species ' + id + ' has no glyph, so the palette shows a generic blob')
    for (const row of grid) {
      assert.equal(row.length, grid[0].length, 'the ' + id + ' glyph must be rectangular')
    }
  }
  for (const kind of EVENT_KINDS) {
    const glyph = seam.GLYPHS[kind === 'predation' ? 'hunt' : kind === 'migration' ? 'migrate' : kind]
    assert.ok(Array.isArray(glyph), 'event kind ' + kind + ' has no glyph')
  }
})

test('the inspector never shows a raw {placeholder}', async () => {
  // Regression guard: placeholder text used to reach the screen whenever a
  // templated key was rendered without its parameters.
  const { locale } = mount()
  const store = await quietStore()
  runWorld(store, 30)
  const world = store.getWorld()
  store.selectAt(world.entities[0].x, world.entities[0].y)
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const rendered = textOf(tree)
  assert.doesNotMatch(rendered, /\{[a-z]+\}/, 'a placeholder leaked into the panel: ' + rendered)
  assert.match(rendered, new RegExp(CHINESE['inspect.generation'].replace('{n}', '\\d+')),
    'the lineage line must show the interpolated generation number')
  store.dispose()
})

// ---------------------------------------------------------------------------
// Persistence and the one-shot notices
// ---------------------------------------------------------------------------

test('the store writes a v2 save under the documented key and round-trips it', async () => {
  const data = new Map()
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
  }
  const options = { storage, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 }
  const store = engine.createStore(options)
  store.ensureWorld()
  await store.whenReady()
  engine.stepWorld(store.getWorld(), engine.TICK)
  assert.equal(await store.save(), true, 'save() must report that the world reached storage')
  assert.equal(data.has(STORAGE_KEY), true, 'the world must be saved under ' + STORAGE_KEY)
  const written = data.get(STORAGE_KEY)
  assert.match(written, /^gz:/, 'the autosave must be the gzipped payload, not bare JSON')
  const rawLength = JSON.stringify(engine.serializeWorld(store.getWorld(), { detail: 'full' })).length
  assert.ok(written.length < rawLength,
    'the gzipped payload must be smaller than the raw JSON (' + written.length + ' vs ' + rawLength + ' chars)')
  assert.ok(written.length < 5 * 1024 * 1024,
    'the save must fit a 5 MB localStorage quota, got ' + written.length + ' chars')
  const packed = await engine.unpackWorld(written)
  assert.equal(packed.version, 2, 'the save payload carries SAVE_VERSION 2')
  assert.equal(typeof engine.formatSaveSize(packed ? 1 : 0), 'string', 'the panel formats the save size through the engine')

  // A second store loads that save instead of starting over.
  const restoredStore = engine.createStore(options)
  restoredStore.ensureWorld()
  await restoredStore.whenReady()
  assert.equal(restoredStore.getWorld().tick, 1, 'the store must resume from the saved tick')
  assert.equal((await restoredStore.peekSave())?.tick, 1, 'peekSave must read the persisted world back')
  assert.equal(restoredStore.getSnapshot().notice, null, 'a healthy save produces no notice')
  const save = restoredStore.getSnapshot().save
  assert.equal(save.stored, true, 'the panel must know a save reached storage')
  assert.ok(save.size > 0, 'the panel must know how big the save is')
  for (const instance of [store, restoredStore]) instance.dispose()
})

test('a legacy save is reported once and left untouched', async () => {
  const data = new Map()
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  }
  data.set(LEGACY_STORAGE_KEY, '{"version":1,"tick":7}')
  const store = engine.createStore({ storage, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  await store.whenReady()
  const notice = store.getSnapshot().notice
  assert.notEqual(notice, null, 'an old save must be reported, not silently dropped')
  assert.equal(notice.kind, 'legacy', 'the notice must say the save is a legacy one')
  assert.equal(typeof store.getWorld().seed, 'number', 'a fresh world must still be built')
  assert.equal(data.get(LEGACY_STORAGE_KEY), '{"version":1,"tick":7}', 'the old save must survive untouched')
  assert.equal(data.has(STORAGE_KEY), false, 'reading must not rewrite the old key')
  store.markOnboardingSeen()
  store.dismissNotice()
  assert.equal(store.getSnapshot().notice, null, 'the notice is one-shot and can be dismissed')
  store.dispose()
})

test('a corrupt save reports why instead of starting over silently', async () => {
  const data = new Map([[STORAGE_KEY, '{not json']])
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
  }
  const store = engine.createStore({ storage, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  await store.whenReady()
  const notice = store.getSnapshot().notice
  assert.notEqual(notice, null, 'a corrupt save must be reported (G5)')
  assert.equal(notice.kind, 'load', 'the notice must be a load failure')
  assert.equal(notice.code, 'corrupt', 'the engine tags a damaged payload so the panel can say so')
  assert.equal(typeof notice.detail, 'string', 'the failure must carry its reason')
  assert.ok(notice.detail.length > 0, 'the reason must not be empty')
  assert.equal(typeof store.getWorld().seed, 'number', 'a fresh world must still be built')
  assert.equal(await store.peekSave(), null, 'a corrupt save reads back as nothing')
  store.newWorld(4242)
  assert.equal(store.getWorld().seed, 4242, 'newWorld must honour the requested seed')
  store.dispose()
})

test('a save from another format says so instead of "corrupt"', async () => {
  // The three save-error codes must reach the player as three different
  // sentences: an incompatible version is not a damaged file.
  const data = new Map([[STORAGE_KEY, JSON.stringify({ version: 1, tick: 7 })]])
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
  }
  const store = engine.createStore({ storage, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  await store.whenReady()
  const notice = store.getSnapshot().notice
  assert.notEqual(notice, null, 'an unusable save must be reported')
  assert.equal(notice.kind, 'load', 'the notice is a load failure')
  assert.equal(notice.code, 'unsupported_version', 'the code must distinguish a version mismatch from corruption')
  assert.equal(data.get(STORAGE_KEY), JSON.stringify({ version: 1, tick: 7 }), 'the unreadable save is left untouched')
  assert.equal(typeof store.getWorld().seed, 'number', 'a fresh world is built instead')
  store.dispose()
})

test('PixelGlyph renders one rect per inked cell and falls back for unknown names', async () => {
  const inked = GLYPHS.grass.reduce((total, row) => total + [...row].filter(cell => cell !== '.').length, 0)
  const glyph = expand(PixelGlyph({ name: 'grass', size: 16 }))
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.viewBox, '0 0 ' + GLYPHS.grass[0].length + ' ' + GLYPHS.grass.length)
  assert.equal(glyph.children.length, inked)
  const fallbackInked = GLYPHS.creature.reduce((total, row) => total + [...row].filter(cell => cell !== '.').length, 0)
  const fallback = expand(PixelGlyph({ name: 'not-a-glyph' }))
  assert.equal(fallback.children.length, fallbackInked, 'an unknown glyph name must fall back to the creature glyph')
})
