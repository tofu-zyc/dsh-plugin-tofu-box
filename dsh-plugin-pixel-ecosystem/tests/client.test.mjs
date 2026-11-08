/**
 * Client half: registration, locale dictionaries, stylesheet and panel render.
 *
 * What this pins and why: the browser bundle is what the user actually sees, so
 * the things that break silently are the ones no engine test can catch — a slot
 * registered under two different ids (the sidebar icon would open nothing), a
 * locale key that exists in Chinese but not English (a blank label), a CSS class
 * without the `pe-` prefix (a selector leaking into shipped chrome), or a panel
 * that throws on first render. Everything runs through the boot harness with a
 * fake React and a fake locale service; no DOM, no browser.
 *
 * Note on DESIGN §7: `legend.title` is listed there but neither dictionary
 * defines it and the panel has no legend block (the header chips act as the
 * legend). That mismatch is reported to the Lead rather than asserted, because
 * which side should change is a product decision.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boot, createFakeLocale, expand, findAll, textOf, BUNDLE_SOURCE, LOCALE_NAMESPACE,
} from './_harness.mjs'

const { plugin, engine, seam } = boot()
const { CHINESE, ENGLISH, PANEL_GLYPH, GLYPHS, PanelIcon, PixelGlyph, TerrariumPanel } = seam

/**
 * Run `plugin.apply()` against a fake Cordis context and record what it seats.
 * @param {{ localeId?: string, layout?: object }} [options] - active locale id
 *   and the optional layout service (`ctx.get('layout')`).
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the client injects exactly the slots and locale services', () => {
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])
})

test('apply() seats the sidebar icon and the keyed main panel under one id', () => {
  const { registrations, injected } = mount()
  assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'both additive seats must be injected')
  assert.equal(registrations.length, 2, 'the plugin adds exactly two seats')
  const [sidebar, main] = registrations
  assert.equal(sidebar.entry.name, 'sidebar.panellist')
  assert.equal(main.entry.name, 'main')
  assert.equal(sidebar.entry.id, 'pixel-ecosystem', 'the sidebar entry id must be the panel id')
  assert.equal(main.entry.key, 'pixel-ecosystem', 'the main slot key must be the panel id')
  assert.equal(sidebar.entry.id, main.entry.key, 'DESIGN §6.3: the two ids must be the same string')
  assert.equal(typeof sidebar.entry.order, 'number', 'the sidebar entry needs a numeric order')
  assert.equal(sidebar.component, PanelIcon, 'the sidebar seat renders the pixel icon')
  assert.equal(typeof main.component, 'function', 'the main seat renders a component')
})

test('the main seat hands the shared store, locale and layout to the panel', () => {
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

test('the sidebar label resolves through the active dictionary', () => {
  assert.equal(mount({ localeId: 'zh' }).registrations[0].entry.label(), CHINESE['panel.title'])
  assert.equal(mount({ localeId: 'en' }).registrations[0].entry.label(), ENGLISH['panel.title'])
})

test('apply() registers both dictionaries for every built-in locale id', () => {
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

test('CHINESE and ENGLISH carry exactly the same keys', () => {
  assert.deepEqual(Object.keys(CHINESE).sort(), Object.keys(ENGLISH).sort())
})

test('every tool, species, gene, help and speed key exists in both dictionaries', () => {
  const required = new Set()
  // The plant + terrain brushes are the ones that really resolve through tool.*.
  for (const tool of ['grass', 'weed', 'tree', 'bush']) required.add(`tool.${tool}`)
  for (const tool of seam.TERRAIN_TOOL_IDS) required.add(`tool.${tool}`)
  for (const id of engine.SPECIES_IDS) required.add(`species.${id}`)
  // Every species must also be placeable: the life palette is what the player
  // clicks, so a species missing from it exists only in the counters.
  for (const id of engine.SPECIES_IDS) {
    assert.ok(seam.LIFE_TOOLS.includes(id), `LIFE_TOOLS is missing the ${id} tool, so the player cannot place one`)
  }
  for (const key of engine.GENE_KEYS) required.add(`inspect.gene.${key}`)
  // The inspector renders needs, intents and life stages from a template
  // literal, so those families are enumerated from the engine instead.
  for (const key of engine.NEED_KEYS) required.add(`needs.${key}`)
  for (const key of engine.INTENT_IDS) required.add(`intent.${key}`)
  for (const stage of ['juvenile', 'adult', 'elder']) required.add(`stage.${stage}`)
  for (const key of ['toast.placed', 'toast.blocked', 'action.step', 'action.deselect', 'inspect.title', 'inspect.emptyHint', 'needs.title']) required.add(key)
  for (const speed of [1, 2, 4, 8]) required.add(`speed.${speed}`)
  for (let index = 1; index <= 8; index++) required.add(`help.${index}`)
  // Every literal t('...') the bundle calls, plus the DESIGN §7 key table.
  for (const match of BUNDLE_SOURCE.matchAll(/\bt\('([\w.]+)'\)/g)) required.add(match[1])
  for (const key of [
    'panel.title', 'action.back', 'action.play', 'action.pause', 'action.newWorld',
    'action.newWorldConfirm', 'action.help', 'action.close', 'action.fit',
    'speed.paused', 'stat.day', 'stat.corpses', 'tool.group.life', 'tool.group.terrain',
    'brush.label', 'brush.small', 'brush.medium', 'brush.large', 'chart.title',
    'inspect.empty', 'inspect.age', 'inspect.energy', 'inspect.generation', 'inspect.children',
    'inspect.follow', 'inspect.unfollow', 'help.title',
  ]) required.add(key)
  for (const key of required) {
    assert.equal(typeof CHINESE[key], 'string', `CHINESE is missing ${key}`)
    assert.equal(typeof ENGLISH[key], 'string', `ENGLISH is missing ${key}`)
    assert.notEqual(CHINESE[key], '', `CHINESE has an empty message for ${key}`)
    assert.notEqual(ENGLISH[key], '', `ENGLISH has an empty message for ${key}`)
  }
  // A dictionary entry nobody asks for is dead weight; keep the tables honest.
  for (const key of Object.keys(CHINESE)) {
    assert.ok(required.has(key), `${key} is defined but never used by the bundle or DESIGN §7`)
  }
})

test('every life tool resolves to a dictionary entry', () => {
  // Regression guard for the 0.1.0 test report: all eleven life tools were
  // labelled with t(`tool.${id}`), but the seven animal ids only exist as
  // `species.*`, so those palette buttons rendered a raw key. Each tool must
  // resolve through whichever namespace it belongs to.
  for (const tool of seam.LIFE_TOOLS) {
    const key = engine.SPECIES[tool] === undefined ? `tool.${tool}` : `species.${tool}`
    assert.equal(typeof CHINESE[key], 'string', `CHINESE is missing ${key}`)
    assert.equal(typeof ENGLISH[key], 'string', `ENGLISH is missing ${key}`)
  }
})

test('every CSS selector is pe- prefixed', () => {
  const css = cssText()
  assert.ok(css.length > 1000, `the stylesheet looks truncated (${css.length} chars)`)
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map(match => match[1].trim()).filter(Boolean)
  assert.ok(selectors.length > 20, `expected a real stylesheet, found ${selectors.length} selectors`)
  for (const selector of selectors) {
    if (selector.startsWith('@media')) continue
    for (const part of selector.split(',')) {
      assert.match(part.trim(), /^\.pe-/, `unprefixed selector would leak into shipped chrome: ${selector}`)
    }
  }
  // The classes the components actually use must all exist in the sheet.
  for (const className of ['pe-root', 'pe-head', 'pe-chips', 'pe-stage', 'pe-canvas', 'pe-side', 'pe-tool', 'pe-modal']) {
    assert.ok(css.includes(`.${className}{`) || css.includes(`.${className} `) || css.includes(`.${className},`),
      `the stylesheet is missing .${className}`)
  }
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test('TerrariumPanel renders against a real store with the panel title and one chip per species', () => {
  const { locale } = mount()
  const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  assert.equal(store.getSnapshot().ready, true, 'the store must have built a world')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))

  assert.ok(textsWithClass(tree, 'pe-title').includes(CHINESE['panel.title']), 'the panel must show its localized title')

  const chips = findAll(tree, element => element.props?.className === 'pe-chip')
  assert.equal(chips.length, engine.SPECIES_IDS.length, 'the header must show one chip per species')
  assert.deepEqual(
    chips.map(chip => chip.props.title),
    engine.SPECIES_IDS.map(id => CHINESE[`species.${id}`]),
    'each chip must be labelled with its localized species name',
  )
  const counts = textsWithClass(tree, 'pe-chip-count')
  const stats = engine.sampleStats(store.getWorld())
  assert.deepEqual(counts, engine.SPECIES_IDS.map(id => String(stats.counts[id])),
    'each chip must show the live population')

  // 11 life tools + 6 terrain tools. (The animal labels are covered by the
  // known-defect test above: they currently fall through to a missing key.)
  assert.equal(textsWithClass(tree, 'pe-tool-label').length, seam.LIFE_TOOLS.length + seam.TERRAIN_TOOL_IDS.length,
    'the palette must offer every life and terrain tool')
  const emptyCards = findAll(tree, element => element.props?.className === 'pe-empty')
  assert.equal(emptyCards.length, 1, 'with nothing selected the inspector shows one hint card')
  assert.ok(textOf(emptyCards[0]).includes(CHINESE['inspect.empty']),
    'with nothing selected the inspector shows the hint')
  const labels = buttonLabels(tree)
  for (const speed of [1, 2, 4, 8]) assert.ok(labels.includes(CHINESE[`speed.${speed}`]), `the panel must offer ${speed}×`)
  assert.ok(labels.includes(CHINESE['action.newWorld']), 'the panel must offer a new world')
  assert.ok(labels.includes(CHINESE['action.help']), 'the panel must offer the help sheet')
  assert.ok(labels.includes(CHINESE['brush.small']), 'the panel must offer the brush sizes')
})

test('TerrariumPanel inspects the animal it is asked to select', () => {
  const { locale } = mount()
  const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  const world = store.getWorld()
  const target = world.entities[0]
  store.selectAt(target.x, target.y)
  assert.equal(store.getSnapshot().selected?.id, target.id, 'the store must select the animal under the cursor')
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  assert.deepEqual(
    textsWithClass(tree, 'pe-gene-label'),
    engine.GENE_KEYS.map(key => CHINESE[`inspect.gene.${key}`]),
    'the inspector must show a bar per gene, localized',
  )
  const rows = findAll(tree, element => element.props?.className === 'pe-row').map(textOf)
  assert.ok(rows.length >= 2, 'the inspector must show a stats list')
  assert.ok(rows[0].includes(CHINESE['inspect.age']), 'the inspector must show age')
  assert.ok(rows[1].includes(CHINESE['inspect.energy']), 'the inspector must show energy')
  assert.ok(buttonLabels(tree).includes(CHINESE['inspect.follow']), 'the inspector must offer follow')
})

test('the panel only offers "back to chat" when a layout service is available', () => {
  const plain = mount()
  const plainTree = expand(plain.registrations[1].component({}))
  assert.equal(buttonLabels(plainTree).includes(CHINESE['action.back']), false,
    'without a layout service the back button has nowhere to go')

  const withLayout = mount({ layout: { selectPanel() {} } })
  const layoutTree = expand(withLayout.registrations[1].component({}))
  assert.equal(buttonLabels(layoutTree).includes(CHINESE['action.back']), true,
    'with a layout service the panel must offer "back to chat"')
})

test('PanelIcon renders a pixel grid as unit rects, with an outline when active', () => {
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

test('the inspector never shows a raw {placeholder}', () => {
  // Regression guard for the 0.1.0 test report: DESIGN §7 defines
  // inspect.generation as "第 {n} 代" / "Gen {n}", but Inspector() used it as a
  // static row label and printed the number in a separate value column, so the
  // label kept the literal braces ("第 {n} 代  1"). The lineage strings are now
  // rendered with their parameter interpolated.
  const { locale } = mount()
  const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
  store.ensureWorld()
  const target = store.getWorld().entities[0]
  store.selectAt(target.x, target.y)
  const tree = expand(TerrariumPanel({ store, locale, layout: undefined }))
  const rendered = textOf(tree)
  assert.doesNotMatch(rendered, /\{[a-z]+\}/, `a placeholder leaked into the inspector: ${rendered}`)
  assert.match(rendered, new RegExp(CHINESE['inspect.generation'].replace('{n}', '\\d+')),
    'the lineage line must show the interpolated generation number')
})

test('the store persists the world under the documented storage key and drops bad saves', () => {
  const storageKey = 'dsh-pixel-ecosystem:v1'
  const data = new Map()
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
  }
  const options = { storage, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 }
  const store = engine.createStore(options)
  store.ensureWorld()
  engine.stepWorld(store.getWorld(), engine.TICK)
  store.save()
  assert.equal(data.has(storageKey), true, `the world must be saved under ${storageKey}`)
  const saved = JSON.parse(data.get(storageKey))
  assert.equal(saved.version, 1, 'the save payload carries its format version')

  // A second store loads that save instead of starting over.
  const restoredStore = engine.createStore(options)
  restoredStore.ensureWorld()
  assert.equal(restoredStore.getWorld().tick, 1, 'the store must resume from the saved tick')
  assert.equal(restoredStore.peekSave()?.tick, 1, 'peekSave must read the persisted world back')

  // A corrupt save is dropped silently: the panel still gets a world.
  data.set(storageKey, '{not json')
  const recovered = engine.createStore(options)
  assert.doesNotThrow(() => recovered.ensureWorld(), 'a bad save must not break world creation')
  assert.equal(typeof recovered.getWorld().seed, 'number', 'a fresh world must still be built')
  assert.equal(recovered.peekSave(), null, 'a corrupt save reads back as nothing')

  // New world: a fresh seed replaces the stored one.
  recovered.newWorld(4242)
  assert.equal(recovered.getWorld().seed, 4242, 'newWorld must honour the requested seed')

  for (const instance of [store, restoredStore, recovered]) instance.dispose()
})

test('PixelGlyph renders one rect per inked cell and falls back for unknown names', () => {
  const inked = GLYPHS.grass.reduce((total, row) => total + [...row].filter(cell => cell !== '.').length, 0)
  const glyph = expand(PixelGlyph({ name: 'grass', size: 16 }))
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.viewBox, `0 0 ${GLYPHS.grass[0].length} ${GLYPHS.grass.length}`)
  assert.equal(glyph.children.length, inked)
  const fallbackInked = GLYPHS.creature.reduce((total, row) => total + [...row].filter(cell => cell !== '.').length, 0)
  const fallback = expand(PixelGlyph({ name: 'not-a-glyph' }))
  assert.equal(fallback.children.length, fallbackInked, 'an unknown glyph name must fall back to the creature glyph')
})
