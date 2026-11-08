/**
 * `paintWorld` contract (DESIGN.md §5.1).
 *
 * What this pins and why: the panel blits this buffer straight into a
 * `putImageData`, so the renderer's guarantees are load-bearing — one packed
 * ARGB word per cell, deterministic output for a given `world.tick` (so a
 * repaint at the same tick cannot flicker), water as the only animated layer,
 * visible weed over water, sprites painted above the ground, and clipping at
 * the frame edge instead of writing outside it. Every assertion reads the
 * returned buffer, never a DOM, so the suite runs headless.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const {
  TERRAIN, PALETTE, SPRITES,
  createWorld, spawnEntity, paintWorld, paintView,
} = engine

const EMPTY_STOCKS = Object.fromEntries(engine.SPECIES_IDS.map(id => [id, 0]))

/**
 * A 40x30 world with a water column on the left, bare land on the right and no
 * animals, plants or carcasses, so a single layer can be observed at a time.
 * @param {{ grass?: number, weed?: number }} [options] - cover values to fill in.
 * @returns {object} the world.
 */
function mixedWorld(options = {}) {
  const world = createWorld({ seed: 31, width: 40, height: 30, stocks: EMPTY_STOCKS, immigration: false })
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const index = y * world.width + x
      world.terrain[index] = x < 20 ? TERRAIN.WATER : TERRAIN.GRASS
      world.grass[index] = x < 20 ? 0 : (options.grass ?? 0)
      world.weed[index] = x < 20 ? (options.weed ?? 0) : 0
      world.fertility[index] = 0
      world.waterFertility[index] = 0
    }
  }
  world.trees.length = 0
  world.entities.length = 0
  world.corpses.length = 0
  world.hydrologyDirty = false
  return world
}

/** @param {object} world - the world. @param {number} x - column. @param {number} y - row. */
const indexOf = (world, x, y) => y * world.width + x

/**
 * Indices where two buffers disagree.
 * @param {Uint32Array} a - first frame.
 * @param {Uint32Array} b - second frame.
 * @returns {number[]} differing indices.
 */
function changedCells(a, b) {
  const changed = []
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) changed.push(index)
  return changed
}

test('paintWorld fills one opaque ARGB word per cell', () => {
  const world = mixedWorld({ grass: 0.6 })
  const frame = paintWorld(world)
  assert.ok(frame instanceof Uint32Array, 'the frame buffer must be a Uint32Array')
  assert.equal(frame.length, world.width * world.height, 'the buffer must hold exactly W*H cells')
  for (let index = 0; index < frame.length; index += 1) {
    assert.equal(frame[index] >>> 24, 0xFF, `cell ${index} is not opaque: 0x${frame[index].toString(16)}`)
  }
})

test('paintWorld reuses a correctly sized buffer and allocates otherwise', () => {
  const world = mixedWorld()
  const supplied = new Uint32Array(world.width * world.height)
  const returned = paintWorld(world, supplied)
  assert.equal(returned, supplied, 'a correctly sized buffer must be painted in place')
  const wrong = new Uint32Array(7)
  const replaced = paintWorld(world, wrong)
  assert.notEqual(replaced, wrong, 'a wrongly sized buffer must be replaced')
  assert.equal(replaced.length, world.width * world.height, 'the replacement must be the right size')
})

test('painting the same tick twice is pixel-identical', () => {
  const world = mixedWorld({ grass: 0.7, weed: 0.5 })
  const rabbit = spawnEntity(world, 'rabbit', 25.5, 15.5)
  rabbit.heading = 0
  world.trees.push({ id: 800, x: 30, y: 12, variant: 'tree', size: 2, age: 40, foliage: 1, seedTimer: 50 })
  world.corpses.push({ id: 801, x: 33, y: 20, species: 'rabbit', decay: 0.2, energy: 14 })
  world.tick = 40
  const first = paintWorld(world)
  const second = paintWorld(world)
  assert.equal(changedCells(first, second).length, 0, 'two paints of the same tick must match exactly')
})

test('only the water layer animates between ticks', () => {
  const world = mixedWorld()
  world.tick = 0
  const first = paintWorld(world).slice()
  world.tick = 2 // the ripple phase advances on every second tick
  const second = paintWorld(world)
  const changed = changedCells(first, second)
  assert.ok(changed.length > 0, 'the water surface must move between ticks')
  for (const index of changed) {
    assert.equal(world.terrain[index], TERRAIN.WATER, `cell ${index % world.width},${(index / world.width) | 0} changed but is not water`)
  }
})

test('weed cover is visible on water and distinct from open water and from land', () => {
  const world = mixedWorld({ grass: 0.9 })
  world.weed[15 * world.width + 5] = 0.9
  world.weed[15 * world.width + 6] = 0
  const frame = paintWorld(world)
  const weedy = frame[indexOf(world, 5, 15)]
  const open = frame[indexOf(world, 6, 15)]
  const land = frame[indexOf(world, 25, 15)]
  assert.notEqual(weedy, open, 'a weed-covered cell must not look like open water')
  assert.notEqual(weedy, land, 'water must not look like land')
  assert.notEqual(open, land, 'open water must not look like land')
})

test('each terrain type paints its own colour', () => {
  const world = mixedWorld()
  const cells = [[5, 5, TERRAIN.WATER], [21, 5, TERRAIN.SAND], [22, 5, TERRAIN.DIRT], [23, 5, TERRAIN.STONE], [24, 5, TERRAIN.GRASS]]
  for (const [x, y, terrain] of cells) world.terrain[indexOf(world, x, y)] = terrain
  const frame = paintWorld(world)
  const colours = cells.map(([x, y]) => frame[indexOf(world, x, y)])
  assert.equal(new Set(colours).size, colours.length, `two terrain types share a colour: ${colours.map(value => value.toString(16)).join(',')}`)
})

test('an animal paints its sprite above the ground colour', () => {
  const world = mixedWorld({ grass: 0.2 })
  const rabbit = spawnEntity(world, 'rabbit', 25, 15)
  rabbit.heading = 0
  rabbit.phase = 0
  rabbit.energy = engine.SPECIES.rabbit.balance.maxEnergy
  world.tick = 0
  const sprite = SPRITES.rabbit.idle
  const left = Math.round(25 - sprite.width / 2)
  const top = Math.round(15 - sprite.height + 1)
  const frame = paintWorld(world)
  // Find each landmark in the sprite's own pixel data: the artwork may be
  // redrawn (it has been) and the test should not pin a hand-counted offset.
  const at = (colour) => {
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        if (sprite.pixels[y * sprite.width + x] === colour) return { x: left + x, y: top + y }
      }
    }
    throw new Error('the rabbit sprite is missing one of its palette colours')
  }
  const body = at(PALETTE.rabbit.body)
  const eye = at(PALETTE.rabbit.eye)
  const ear = at(PALETTE.rabbit.ear)
  assert.equal(frame[indexOf(world, body.x, body.y)], PALETTE.rabbit.body, 'the sprite body must be painted at the animal cell')
  assert.equal(frame[indexOf(world, eye.x, eye.y)], PALETTE.rabbit.eye, 'the sprite eye must be painted')
  assert.equal(frame[indexOf(world, ear.x, ear.y)], PALETTE.rabbit.ear, 'the sprite ear must be painted')
  const beside = frame[indexOf(world, left - 1, body.y)]
  for (const colour of [PALETTE.rabbit.body, PALETTE.rabbit.eye, PALETTE.rabbit.ear]) {
    assert.notEqual(beside, colour, 'the sprite must not spill one cell to the left')
  }
})

/** Brightness of a packed colour, for "darker than the ground" comparisons. */
const brightnessOf = color => (color & 0xFF) + ((color >>> 8) & 0xFF) + ((color >>> 16) & 0xFF)

test('an animal at the frame edge is clipped instead of writing outside the buffer', () => {
  const sprite = SPRITES.rabbit.idle
  // The creature's cast shadow widens the footprint: it is a deliberate layer
  // (docs/70-VISUAL.md), so the clip box is the sprite box plus its shadow
  // margin. The next test pins the sprite box exactly with shadows off.
  const SHADOW_MARGIN = 3
  for (const [x, y] of [[0.5, 0.5], [39.5, 29.5], [0.5, 29.5]]) {
    const world = mixedWorld({ grass: 0.5 })
    world.tick = 0
    const empty = paintWorld(world).slice()
    const animal = spawnEntity(world, 'rabbit', x, y)
    animal.heading = 0
    animal.phase = 0
    animal.energy = engine.SPECIES.rabbit.balance.maxEnergy
    const drawn = paintWorld(world)
    assert.equal(drawn.length, world.width * world.height, 'clipping must not change the buffer size')
    const left = Math.round(x - sprite.width / 2)
    const top = Math.round(y - sprite.height + 1)
    const minX = Math.max(0, left - SHADOW_MARGIN)
    const maxX = Math.min(world.width - 1, left + sprite.width - 1 + SHADOW_MARGIN)
    const minY = Math.max(0, top - SHADOW_MARGIN)
    const maxY = Math.min(world.height - 1, top + sprite.height - 1 + SHADOW_MARGIN)
    const changed = changedCells(empty, drawn)
    assert.ok(changed.length > 0, `the animal at ${x},${y} painted nothing`)
    for (const index of changed) {
      const cellX = index % world.width
      const cellY = (index / world.width) | 0
      assert.ok(cellX >= minX && cellX <= maxX && cellY >= minY && cellY <= maxY,
        `cell ${cellX},${cellY} is outside the clipped sprite box (${minX}..${maxX} x ${minY}..${maxY})`)
    }
  }
})

test('with shadows off an animal touches only its own sprite box', () => {
  const sprite = SPRITES.rabbit.idle
  const world = mixedWorld({ grass: 0.5 })
  world.tick = 0
  const view = { x: 0, y: 0, width: world.width, height: world.height }
  const buffer = new Uint32Array(world.width * world.height)
  const empty = paintView(world, view, buffer, 1, null, { shadows: false }).slice()
  const animal = spawnEntity(world, 'rabbit', 25.5, 15.5)
  animal.heading = 0
  animal.phase = 0
  const drawn = paintView(world, view, buffer, 1, null, { shadows: false })
  const left = Math.round(25.5 - sprite.width / 2)
  const top = Math.round(15.5 - sprite.height + 1)
  const changed = changedCells(empty, drawn)
  assert.ok(changed.length > 0, 'the animal painted nothing')
  for (const index of changed) {
    const cellX = index % world.width
    const cellY = (index / world.width) | 0
    assert.ok(cellX >= left && cellX < left + sprite.width, `cell ${cellX},${cellY} is outside the sprite box horizontally`)
    assert.ok(cellY >= top && cellY < top + sprite.height, `cell ${cellX},${cellY} is outside the sprite box vertically`)
  }
})

test('paintWorld never mutates the world', () => {
  const world = mixedWorld({ grass: 0.4, weed: 0.3 })
  spawnEntity(world, 'rabbit', 25.5, 15.5)
  world.trees.push({ id: 802, x: 30, y: 12, variant: 'bush', size: 1, age: 20, foliage: 1, seedTimer: 50 })
  world.corpses.push({ id: 803, x: 33, y: 20, species: 'deer', decay: 0.4, energy: 36 })
  world.tick = 12
  const before = {
    tick: world.tick,
    time: world.time,
    entities: world.entities.length,
    trees: world.trees.length,
    corpses: world.corpses.length,
    grass: [...world.grass].join(','),
  }
  paintWorld(world)
  paintWorld(world)
  const after = {
    tick: world.tick,
    time: world.time,
    entities: world.entities.length,
    trees: world.trees.length,
    corpses: world.corpses.length,
    grass: [...world.grass].join(','),
  }
  assert.deepEqual(after, before, 'painting must be read-only, otherwise the panel would perturb the simulation')
})
test('winter ground reads paler than summer and grows snow', () => {
  const sample = (yearPhase) => {
    const world = mixedWorld({ grass: 0.6 })
    world.tick = 0
    world.time = 0
    // Start from a REAL climate record so every field the renderer reads exists
    // (this fixture used to hand-write the record and went stale: it was missing
    // `season` and `waterTemperature`, so the snow test could not see the season
    // at all). Only the scenario values are pinned on top.
    engine.stepClimate(world, engine.TICK)
    world.climate.dayPhase = 0.5
    world.climate.yearPhase = yearPhase
    // Same relation 13b-climate uses: +1 midsummer, -1 midwinter.
    world.climate.season = Math.cos(2 * Math.PI * (yearPhase - 0.5))
    world.climate.temperature = 5
    world.climate.waterTemperature = 5
    world.climate.sunlight = 0.7
    const frame = paintWorld(world)
    let pale = 0
    let total = 0
    let land = 0
    for (let y = 0; y < world.height; y++) {
      for (let x = 20; x < world.width; x++) {
        const color = frame[y * world.width + x]
        const red = color & 0xFF
        const green = (color >>> 8) & 0xFF
        const blue = (color >>> 16) & 0xFF
        total += red + green + blue
        land += 3
        if (red > 195 && green > 195 && blue > 195) pale += 1
      }
    }
    return { mean: total / land, pale }
  }
  // Pick phases inside the snow PROFILE, not arbitrary ones: snow cover is a
  // year-phase profile now (17-palette SNOW_PROFILE), peaking at 0.82-0.86 and
  // only 0.2 at the 0.95 shoulder, which is too little to cross the pale
  // threshold this test counts. Summer sits on the profile's zero plateau.
  const summer = sample(0.4)
  const winter = sample(0.84)
  assert.ok(winter.mean > summer.mean + 25,
    `winter ground must read paler: summer ${summer.mean.toFixed(1)} vs winter ${winter.mean.toFixed(1)}`)
  assert.ok(winter.pale > 40, `winter must cover open ground with snow, only ${winter.pale} pale land cells`)
  assert.equal(summer.pale, 0, `summer must not paint snow, got ${summer.pale} pale land cells`)
})

test('a plant shadow swings across the ground as the sun moves', () => {
  const tree = { id: 900, x: 25.5, y: 16.5, variant: 'tree', size: 3, age: 40, foliage: 1, seedTimer: 50 }
  const centroid = (dayPhase) => {
    const world = mixedWorld({ grass: 0.5 })
    world.tick = 0
    world.time = 0
    world.climate = { dayPhase, yearPhase: 0.3, temperature: 12, sunlight: 0.8 }
    const before = paintWorld(world).slice()
    world.trees.push(tree)
    const after = paintWorld(world)
    // Only the rows under the base of the tree: the canopy itself is up in the
    // sprite rows, so anything darker down here is cast shadow.
    let sum = 0
    let count = 0
    for (let y = 17; y <= 22; y++) {
      for (let x = 12; x < world.width; x++) {
        const index = indexOf(world, x, y)
        if (brightnessOf(after[index]) >= brightnessOf(before[index])) continue
        sum += x
        count += 1
      }
    }
    return { x: count === 0 ? 0 : sum / count, count }
  }
  const morning = centroid(0.26)
  const afternoon = centroid(0.74)
  assert.ok(morning.count > 4 && afternoon.count > 4,
    `the tree must cast a shadow at both times, got ${morning.count} and ${afternoon.count} cells`)
  assert.ok(morning.x > afternoon.x,
    `the shadow must swing the other way by afternoon: morning ${morning.x.toFixed(2)} vs afternoon ${afternoon.x.toFixed(2)}`)
})

test('a smaller body casts a smaller shadow', () => {
  const shadowCells = (stage) => {
    const world = mixedWorld({ grass: 0.4 })
    world.tick = 0
    world.time = 0
    world.climate = { dayPhase: 0.5, yearPhase: 0.3, temperature: 12, sunlight: 0.8 }
    const view = { x: 0, y: 0, width: world.width, height: world.height }
    const buffer = new Uint32Array(world.width * world.height)
    const deer = spawnEntity(world, 'deer', 25.5, 15.5)
    deer.heading = 0
    deer.phase = 0
    deer.stage = stage
    const withShadow = paintView(world, view, buffer, 1, null).slice()
    const withoutShadow = paintView(world, view, buffer, 1, null, { shadows: false }).slice()
    return changedCells(withShadow, withoutShadow).length
  }
  const adult = shadowCells('adult')
  const juvenile = shadowCells('juvenile')
  assert.ok(adult > 0, 'an adult deer must cast a shadow')
  assert.ok(juvenile > 0, 'a juvenile deer must cast a shadow too')
  assert.ok(adult > juvenile, `the adult shadow must be bigger: adult ${adult} vs juvenile ${juvenile} cells`)
})

test('an animal outside the viewport does not paint inside it', () => {
  const world = mixedWorld({ grass: 0.5 })
  world.tick = 10
  const view = { x: 0, y: 0, width: 20, height: 15 }
  const first = paintView(world, view, new Uint32Array(20 * 15), 1, null).slice()
  spawnEntity(world, 'rabbit', 35, 25)
  const second = paintView(world, view, new Uint32Array(20 * 15), 1, null)
  assert.equal(changedCells(first, second).length, 0, 'a creature outside the view must not paint inside it')
})

test('snow falls only in winter and the weather layer can be switched off', () => {
  const landChanges = (yearPhase, options) => {
    const world = mixedWorld({ grass: 0.45 })
    world.time = 0
    world.climate = { dayPhase: 0.5, yearPhase, temperature: -4, sunlight: 0.6 }
    const view = { x: 0, y: 0, width: world.width, height: world.height }
    const buffer = new Uint32Array(world.width * world.height)
    world.tick = 40
    const first = paintView(world, view, buffer, 1, null, options).slice()
    world.tick = 42
    const second = paintView(world, view, buffer, 1, null, options)
    let changed = 0
    for (const index of changedCells(first, second)) if (world.terrain[index] !== TERRAIN.WATER) changed += 1
    return changed
  }
  assert.ok(landChanges(0.84, null) > 0, 'winter snow must move between ticks')
  assert.equal(landChanges(0.84, { weather: false }), 0, 'with the weather layer off the land must not animate')
  assert.equal(landChanges(0.3, null), 0, 'no snow outside winter')
})

test('a sleeping animal reads lower than a standing one', () => {
  const silhouette = (stateId) => {
    const world = mixedWorld({ grass: 0.3 })
    world.tick = 0
    world.time = 0
    const view = { x: 0, y: 0, width: world.width, height: world.height }
    const buffer = new Uint32Array(world.width * world.height)
    const empty = paintView(world, view, buffer, 1, null, { shadows: false }).slice()
    const rabbit = spawnEntity(world, 'rabbit', 25.5, 15.5)
    rabbit.heading = 0
    rabbit.phase = 0
    rabbit.state = { id: stateId }
    const frame = paintView(world, view, buffer, 1, null, { shadows: false })
    let top = world.height
    let bottom = -1
    let cells = 0
    for (const index of changedCells(empty, frame)) {
      const row = (index / world.width) | 0
      top = Math.min(top, row)
      bottom = Math.max(bottom, row)
      cells += 1
    }
    return { top, bottom, cells }
  }
  const standing = silhouette('idle')
  const sleeping = silhouette('sleep')
  assert.ok(standing.cells > 0 && sleeping.cells > 0, 'both poses must paint something')
  assert.ok(sleeping.top > standing.top,
    `the sleeping silhouette must start lower: standing top ${standing.top}, sleeping top ${sleeping.top}`)
  assert.ok(sleeping.bottom === standing.bottom, 'both poses must keep their feet planted on the same row')
  assert.ok(sleeping.cells < standing.cells,
    `sleeping must cover fewer pixels: standing ${standing.cells}, sleeping ${sleeping.cells}`)
})
/** How many land cells a phase paints as covered in snow. */
function snowCoverage(yearPhase) {
  const world = mixedWorld({ grass: 0.5 })
  world.tick = 0
  world.time = 0
  world.climate = { dayPhase: 0.5, yearPhase, temperature: -5, sunlight: 0.6 }
  const frame = paintWorld(world)
  let pale = 0
  for (let y = 0; y < world.height; y++) {
    for (let x = 20; x < world.width; x++) {
      const color = frame[y * world.width + x]
      if ((color & 0xFF) > 195 && ((color >>> 8) & 0xFF) > 195 && ((color >>> 16) & 0xFF) > 195) pale += 1
    }
  }
  return pale
}

test('deep snow is a short window with lighter banks either side', () => {
  const deep = snowCoverage(0.84)
  const before = snowCoverage(0.78)
  const after = snowCoverage(0.95)
  const summer = snowCoverage(0.38)
  assert.ok(deep > 150, `mid-winter must be snow covered, only ${deep} cells`)
  assert.ok(before > 5 && before < deep * 0.8, `early winter must be a bank, not a full cover: ${before} vs ${deep}`)
  assert.ok(after > 0 && after < deep * 0.6, `late winter must be melting: ${after} vs ${deep}`)
  assert.equal(summer, 0, 'high summer must have no snow at all')
})

test('trees are not all the same silhouette', () => {
  const paint = (id) => {
    const world = mixedWorld({ grass: 0.5 })
    world.tick = 0
    world.time = 0
    world.climate = { dayPhase: 0.5, yearPhase: 0.38, temperature: 16, sunlight: 0.9 }
    world.trees.push({ id, x: 25.5, y: 15.5, variant: 'tree', size: 3, age: 40, foliage: 1, seedTimer: 50 })
    const frame = paintWorld(world)
    const cells = []
    for (let y = 4; y < 16; y++) {
      for (let x = 17; x < 34; x++) cells.push(frame[y * world.width + x])
    }
    return cells.join(',')
  }
  const round = paint(5)
  const wide = paint(12)
  const leaning = paint(13)
  assert.notEqual(round, wide, 'a round crown and a wide crown must not paint the same cells')
  assert.notEqual(wide, leaning, 'a wide crown and a leaning crown must not paint the same cells')
  assert.notEqual(round, leaning, 'a round crown and a leaning crown must not paint the same cells')
})

test('evergreens stay green through winter, deciduous trees go bare', () => {
  const crown = (id) => {
    const world = mixedWorld({ grass: 0.5 })
    world.tick = 0
    world.time = 0
    world.climate = { dayPhase: 0.5, yearPhase: 0.84, temperature: -6, sunlight: 0.55 }
    world.trees.push({ id, x: 25.5, y: 15.5, variant: 'tree', size: 3, age: 40, foliage: 1, seedTimer: 50 })
    const frame = paintWorld(world)
    let green = 0
    let brown = 0
    for (let y = 2; y < 17; y++) {
      for (let x = 16; x < 35; x++) {
        const color = frame[y * world.width + x]
        const red = color & 0xFF
        const greenChannel = (color >>> 8) & 0xFF
        const blue = (color >>> 16) & 0xFF
        if (greenChannel > red + 18 && greenChannel > blue + 8) green += 1
        if (red > greenChannel + 14 && red > blue + 20) brown += 1
      }
    }
    return { green, brown }
  }
  // id 7 hits the evergreen modulus (id % 7 === 0); id 5 is deciduous.
  const evergreen = crown(7)
  const deciduous = crown(5)
  assert.ok(evergreen.green > 20, `a conifer must keep needles in winter, saw ${evergreen.green} green cells`)
  assert.equal(deciduous.green, 0, `a deciduous crown must have no green left, saw ${deciduous.green}`)
  assert.ok(deciduous.brown > 5, `a bare tree must still be visible as wood, saw ${deciduous.brown} brown cells`)
})

test('the ground ramp has more than eight cover levels', () => {
  const world = mixedWorld()
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const index = y * world.width + x
      world.terrain[index] = x < 20 ? TERRAIN.WATER : TERRAIN.GRASS
      world.grass[index] = x < 20 ? 0 : (x - 20) / 19
      world.weed[index] = 0
    }
  }
  world.tick = 0
  world.time = 0
  world.climate = { dayPhase: 0.6, yearPhase: 0.38, temperature: 18, sunlight: 0.9 }
  const frame = paintWorld(world)
  const shades = new Set()
  for (let y = 0; y < world.height; y++) {
    for (let x = 20; x < world.width; x++) shades.add(frame[y * world.width + x])
  }
  assert.ok(shades.size > 10, `twenty cover values must not collapse into ${shades.size} colours`)
})

test('the same year phase paints the same ground in two worlds', () => {
  const ground = () => {
    const world = mixedWorld({ grass: 0.55 })
    world.tick = 7
    world.time = 0
    world.climate = { dayPhase: 0.5, yearPhase: 0.84, temperature: -4, sunlight: 0.6 }
    const frame = paintWorld(world)
    return Array.from(frame.slice(0, 400)).join(',')
  }
  assert.equal(ground(), ground(), 'two worlds at the same year phase must share one look')
})
