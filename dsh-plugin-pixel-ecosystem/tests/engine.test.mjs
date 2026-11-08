/**
 * Engine contract, headlessly through `module.exports.__engine`.
 *
 * What this pins and why: DESIGN.md §5 promises a DOM-free engine that a test
 * can drive for tens of thousands of ticks, and §5.1/§5.2 promise specific
 * behaviour — determinism from a seed, the tool semantics behind every brush,
 * habitat boundaries, the predator/prey matrix, one-carcass deaths, mutation
 * inside the gene ranges, a lossy-but-faithful save round-trip, `dt` guards and
 * per-species caps. Those are exactly the guarantees the panel relies on, so
 * every test below asserts one of them against the shipped bundle.
 *
 * One assertion is deliberately recorded as a known defect: it pins the
 * DESIGN §5.2 rule that a prey marked `fate === 'eaten'` dies, which the bundle
 * currently breaks. See `knownDefect()` below and the report to the Lead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const {
  SPECIES, SPECIES_IDS, TERRAIN, GENE_KEYS, TICK,
  createWorld, stepWorld, place, spawnEntity, findEntityAt, sampleStats, pushHistory,
  serializeWorld, deserializeWorld, countSpecies, handleImmigration, settleTerrain, computeHydrology,
} = engine

/** Stocks that seed nothing, so a test starts from an empty world. */
const EMPTY_STOCKS = Object.fromEntries(SPECIES_IDS.map(id => [id, 0]))

/**
 * A world with hand-made terrain: nothing seeded, flat terrain, no hydrology
 * work pending. Keeps a test's world small (~1200 cells) and fully controlled.
 * @param {{ width?: number, height?: number, seed?: number, terrain?: number }} [options] -
 *   grid size, seed and the terrain code every cell gets.
 * @returns {object} the world.
 */
function blankWorld(options = {}) {
  const world = createWorld({
    seed: options.seed ?? 7,
    width: options.width ?? 40,
    height: options.height ?? 30,
    stocks: EMPTY_STOCKS,
    // Isolated unit tests must keep exactly the animals they spawn; the
    // migration net is a gameplay feature, not something they should fight.
    immigration: false,
  })
  world.terrain.fill(options.terrain ?? TERRAIN.GRASS)
  world.grass.fill(0)
  world.weed.fill(0)
  world.fertility.fill(0)
  world.waterFertility.fill(0)
  world.moisture.fill(0)
  world.trees.length = 0
  world.entities.length = 0
  world.corpses.length = 0
  world.hydrologyDirty = false
  return world
}

/**
 * Fill an inclusive rectangle with one terrain code (test-side world building).
 * @param {object} world - the world.
 * @param {number} terrain - terrain code.
 * @param {number} x0 - first column.
 * @param {number} y0 - first row.
 * @param {number} x1 - last column.
 * @param {number} y1 - last row.
 * @returns {void}
 */
function fillRegion(world, terrain, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) world.terrain[y * world.width + x] = terrain
  }
}

/** @param {object} world - the world. @param {number} x - column. @param {number} y - row. */
const terrainAtCell = (world, x, y) => world.terrain[(y | 0) * world.width + (x | 0)]

/** @param {object} world - the world. @param {string} species - species id. */
const alive = (world, species) => countSpecies(world, species)

/** @param {object} world - the world. @param {number} count - ticks to run. */
function runTicks(world, count) {
  for (let i = 0; i < count; i++) stepWorld(world, TICK)
}

/**
 * Count cells where two typed arrays disagree.
 * @param {{length: number}} a - first array.
 * @param {{length: number}} b - second array.
 * @returns {number} number of differing cells (0 = identical).
 */
function diffCells(a, b) {
  if (a.length !== b.length) return Math.max(a.length, b.length)
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff += 1
  return diff
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same seed rebuilds terrain, producers and stock exactly', () => {
  const build = () => createWorld({ seed: 20261106, width: 96, height: 64 })
  const first = build()
  const second = build()
  assert.equal(diffCells(first.terrain, second.terrain), 0, 'terrain differs between two worlds of the same seed')
  assert.equal(diffCells(first.grass, second.grass), 0, 'grass field differs between two worlds of the same seed')
  assert.equal(diffCells(first.weed, second.weed), 0, 'weed field differs between two worlds of the same seed')
  assert.equal(diffCells(first.fertility, second.fertility), 0, 'fertility differs between two worlds of the same seed')
  assert.equal(diffCells(first.moisture, second.moisture), 0, 'moisture differs between two worlds of the same seed')
  assert.equal(first.rngState, second.rngState, 'the RNG stream position must be reproducible')
  assert.equal(first.nextId, second.nextId, 'id allocation must be reproducible')
  assert.deepEqual(
    first.trees.map(plant => [plant.x, plant.y, plant.variant, plant.size]),
    second.trees.map(plant => [plant.x, plant.y, plant.variant, plant.size]),
    'the initial forest differs between two worlds of the same seed',
  )
  assert.deepEqual(
    first.entities.map(entity => [entity.species, entity.x, entity.y]),
    second.entities.map(entity => [entity.species, entity.x, entity.y]),
    'the starting herds differ between two worlds of the same seed',
  )
  assert.ok(first.entities.length > 0, 'a default world must start with animals')
  assert.ok(first.trees.length > 0, 'a default world must start with plants')
})

// ---------------------------------------------------------------------------
// place(): one test per tool group
// ---------------------------------------------------------------------------

test('place(grass) turns land into grassland and never sows open water or rock', () => {
  const world = blankWorld()
  const cell = 15 * world.width + 20
  world.terrain[cell] = TERRAIN.SAND
  world.fertility[cell] = 0
  place(world, 'grass', 20, 15, 0)
  assert.equal(world.terrain[cell], TERRAIN.GRASS, 'the grass brush must reclaim sand')
  assert.equal(world.grass[cell], 1, 'the grass brush must fill the biomass field')
  // Float32 storage rounds 0.45 down to 0.449999988, hence the epsilon.
  assert.ok(world.fertility[cell] >= 0.45 - 1e-6, `reclaimed soil must be fertile, got ${world.fertility[cell]}`)

  world.terrain[cell] = TERRAIN.WATER
  world.grass[cell] = 0
  place(world, 'grass', 20, 15, 0)
  assert.equal(world.terrain[cell], TERRAIN.WATER, 'the grass brush must not turn water into land')
  assert.equal(world.grass[cell], 0, 'the grass brush must not sow grass in water')

  world.terrain[cell] = TERRAIN.STONE
  place(world, 'grass', 20, 15, 0)
  assert.equal(world.terrain[cell], TERRAIN.STONE, 'the grass brush must not soften rock')
})

test('place(weed) only plants in water, and stepWorld keeps each field on its own terrain', () => {
  const world = blankWorld()
  const land = 15 * world.width + 20
  fillRegion(world, TERRAIN.WATER, 0, 0, 9, 29)
  const water = 15 * world.width + 5
  place(world, 'weed', 20, 15, 0)
  assert.equal(world.weed[land], 0, 'the weed brush must not sow weed on land')
  place(world, 'weed', 5, 15, 0)
  assert.equal(world.weed[water], 1, 'the weed brush must fill weed in water')

  // The other direction: a stale field value on the wrong terrain is cleared.
  // Growth runs in interleaved slices (four ticks per full pass), so allow one
  // complete cycle before asserting the field has been cleaned.
  world.grass[water] = 1
  world.weed[land] = 1
  for (let tick = 0; tick < 8; tick++) stepWorld(world, TICK)
  assert.equal(world.grass[water], 0, 'grass must not survive on a water cell')
  assert.equal(world.weed[land], 0, 'weed must not survive on a land cell')
})

test('place(water/sand/dirt/stone) repaints terrain and evicts what cannot live there', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  world.trees.push({ id: 900, x: 20, y: 15, variant: 'tree', size: 2, age: 40, foliage: 1, seedTimer: 50 })
  const rabbit = spawnEntity(world, 'rabbit', 20.5, 15.5)
  const fish = spawnEntity(world, 'fish', 30.5, 15.5)

  place(world, 'water', 20, 15, 0)
  assert.equal(terrainAtCell(world, 20, 15), TERRAIN.WATER, 'the water brush must paint water')
  assert.equal(world.entities.includes(rabbit), false, 'a land animal in a newly flooded cell must drown')
  assert.equal(world.trees.length, 0, 'plants in a newly flooded cell must be removed')
  assert.ok(world.weed[15 * world.width + 20] > 0, 'new water must start with some weed')

  place(world, 'stone', 30, 15, 0)
  assert.equal(terrainAtCell(world, 30, 15), TERRAIN.STONE, 'the stone brush must paint rock')
  assert.equal(world.entities.includes(fish), false, 'a fish in a filled-in cell must be removed')

  place(world, 'sand', 5, 5, 1)
  for (const [x, y] of [[4, 4], [5, 5], [6, 6]]) {
    assert.equal(terrainAtCell(world, x, y), TERRAIN.SAND, `brush radius 1 must cover (${x},${y})`)
  }
  assert.equal(world.hydrologyDirty, true, 'painting terrain must ask for a hydrology refresh')
  place(world, 'dirt', 8, 8, 0)
  assert.equal(terrainAtCell(world, 8, 8), TERRAIN.DIRT, 'the dirt brush must paint soil')
})

test('place(tree|bush) plants one plant per cell, once', () => {
  const world = blankWorld()
  place(world, 'tree', 20, 20, 0)
  place(world, 'tree', 20, 20, 0)
  place(world, 'bush', 25, 20, 0)
  assert.equal(world.trees.length, 2, 'a second stroke on the same cell must not stack a plant')
  const tree = world.trees.find(plant => plant.x === 20 && plant.y === 20)
  const bush = world.trees.find(plant => plant.x === 25 && plant.y === 20)
  assert.equal(tree?.variant, 'tree')
  assert.equal(bush?.variant, 'bush')
  assert.equal(bush?.size, 1, 'a shrub is planted small')
  world.terrain[5 * world.width + 5] = TERRAIN.STONE
  place(world, 'tree', 5, 5, 0)
  assert.equal(world.trees.length, 2, 'plants must not be planted on rock')
  world.terrain[6 * world.width + 6] = TERRAIN.WATER
  place(world, 'bush', 6, 6, 0)
  assert.equal(world.trees.length, 2, 'plants must not be planted in water')
})

test('place(<species>) releases 1 / 3 / 6 animals per brush size, on legal habitat', () => {
  const expected = { 0: 1, 1: 3, 2: 6 }
  for (const id of SPECIES_IDS) {
    const species = SPECIES[id]
    const terrain = species.habitat === 'water' ? TERRAIN.WATER : TERRAIN.GRASS
    for (const [radius, count] of Object.entries(expected)) {
      const world = blankWorld({ terrain })
      place(world, id, 20, 15, Number(radius))
      assert.equal(alive(world, id), count, `${id} with brush radius ${radius} should release ${count}`)
      for (const entity of world.entities) {
        const here = terrainAtCell(world, entity.x, entity.y)
        if (species.habitat === 'water') assert.equal(here, TERRAIN.WATER, `${id} must be released in water`)
        else if (species.habitat === 'land') {
          assert.ok(here !== TERRAIN.WATER && here !== TERRAIN.STONE, `${id} must be released on land`)
        }
      }
    }
  }
})

test('place(erase) removes animals, plants and carcasses inside the brush only', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  world.weed.fill(0)
  const inside = spawnEntity(world, 'rabbit', 20.5, 15.5)
  const outside = spawnEntity(world, 'rabbit', 26.5, 15.5)
  world.trees.push({ id: 901, x: 20, y: 15, variant: 'tree', size: 2, age: 40, foliage: 1, seedTimer: 50 })
  world.trees.push({ id: 902, x: 26, y: 15, variant: 'tree', size: 2, age: 40, foliage: 1, seedTimer: 50 })
  world.corpses.push({ id: 903, x: 20.5, y: 15.5, species: 'rabbit', decay: 0, energy: 14 })
  place(world, 'erase', 20, 15, 1)
  assert.equal(world.entities.includes(inside), false, 'an animal inside the erase brush must be removed')
  assert.equal(world.entities.includes(outside), true, 'an animal outside the erase brush must survive')
  assert.equal(world.trees.length, 1, 'only the plant inside the brush may be removed')
  assert.equal(world.corpses.length, 0, 'a carcass inside the brush must be removed')
  assert.equal(world.grass[15 * world.width + 20], 0, 'the erase brush must clear biomass')
  assert.ok(world.grass[15 * world.width + 26] > 0, 'the erase brush must not clear biomass outside itself')
})

test('place(pan) and unknown tools change nothing', () => {
  const world = createWorld({ seed: 3, width: 60, height: 40 })
  runTicks(world, 20)
  const before = {
    entities: world.entities.length,
    trees: world.trees.length,
    tick: world.tick,
    terrain: [...world.terrain].join(','),
    grass: [...world.grass].join(','),
  }
  place(world, 'pan', 30, 20, 2)
  place(world, 'not-a-tool', 30, 20, 2)
  place(world, null, 30, 20, 2)
  assert.equal(world.entities.length, before.entities)
  assert.equal(world.trees.length, before.trees)
  assert.equal(world.tick, before.tick)
  assert.equal([...world.terrain].join(','), before.terrain)
  assert.equal([...world.grass].join(','), before.grass)
})

test('settleTerrain restores fertility on freshly painted land and clears the dirty flag', () => {
  const world = blankWorld()
  const cell = 15 * world.width + 20
  place(world, 'sand', 20, 15, 1)
  assert.equal(world.hydrologyDirty, true, 'a terrain edit must leave hydrology work pending')
  assert.equal(world.fertility[cell], 0, 'freshly painted cells start barren')
  settleTerrain(world)
  assert.equal(world.hydrologyDirty, false, 'settleTerrain must clear the pending flag')
  assert.ok(world.fertility[cell] > 0,
    `painted sand must get its base fertility back, got ${world.fertility[cell]}`)
  // Nutrition the player cannot see must not be overwritten a second time.
  world.fertility[cell] = 0
  settleTerrain(world)
  assert.equal(world.fertility[cell], 0, 'settleTerrain must do nothing when nothing is pending')
})

test('computeHydrology keeps both derived fields inside 0..1', () => {
  const world = createWorld({ seed: 17, width: 80, height: 50 })
  computeHydrology(world)
  for (const field of ['moisture', 'waterFertility']) {
    for (let index = 0; index < world[field].length; index++) {
      const value = world[field][index]
      assert.ok(value >= 0 && value <= 1, `${field}[${index}] escaped 0..1: ${value}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Habitat boundaries
// ---------------------------------------------------------------------------

test('fish never leave water and land animals never enter water', () => {
  const world = blankWorld()
  fillRegion(world, TERRAIN.WATER, 0, 0, 9, 29)
  for (let y = 0; y < 30; y++) for (let x = 10; x < 40; x++) world.grass[y * 40 + x] = 0.9
  world.weed.fill(0.9)
  const fish = spawnEntity(world, 'fish', 5.5, 15.5)
  const rabbit = spawnEntity(world, 'rabbit', 25.5, 15)
  let fishViolations = 0
  let rabbitViolations = 0
  let fishMaxX = 0
  let rabbitMinX = 40
  for (let tick = 0; tick < 500; tick++) {
    stepWorld(world, TICK)
    if (world.entities.includes(fish)) {
      if (terrainAtCell(world, fish.x, fish.y) !== TERRAIN.WATER) fishViolations += 1
      fishMaxX = Math.max(fishMaxX, fish.x)
    }
    if (world.entities.includes(rabbit)) {
      if (terrainAtCell(world, rabbit.x, rabbit.y) === TERRAIN.WATER) rabbitViolations += 1
      rabbitMinX = Math.min(rabbitMinX, rabbit.x)
    }
  }
  assert.equal(world.entities.includes(fish), true, 'the fish must survive the soak')
  assert.equal(world.entities.includes(rabbit), true, 'the rabbit must survive the soak')
  assert.equal(fishViolations, 0, 'a fish was seen on land')
  assert.equal(rabbitViolations, 0, 'a land animal was seen in water')
  assert.ok(fishMaxX < 10, `the fish crossed the shoreline, reached x=${fishMaxX}`)
  assert.ok(rabbitMinX >= 10, `the rabbit entered the water column, reached x=${rabbitMinX}`)
})

test('land animals never walk onto rock', () => {
  const world = blankWorld({ terrain: TERRAIN.STONE })
  fillRegion(world, TERRAIN.GRASS, 10, 10, 29, 19)
  for (let y = 10; y <= 19; y++) for (let x = 10; x <= 29; x++) world.grass[y * 40 + x] = 0.9
  const rabbit = spawnEntity(world, 'rabbit', 20, 15)
  let violations = 0
  for (let tick = 0; tick < 500; tick++) {
    stepWorld(world, TICK)
    if (world.entities.includes(rabbit) && terrainAtCell(world, rabbit.x, rabbit.y) !== TERRAIN.GRASS) violations += 1
  }
  assert.equal(violations, 0, 'a land animal was seen on rock')
  assert.equal(world.entities.includes(rabbit), true, 'the rabbit must survive the soak')
})

test('a crow flies over rock without terrain checks', () => {
  const world = blankWorld({ terrain: TERRAIN.STONE })
  const crow = spawnEntity(world, 'crow', 20, 15)
  let onStone = 0
  for (let tick = 0; tick < 100; tick++) {
    stepWorld(world, TICK)
    if (world.entities.includes(crow) && terrainAtCell(world, crow.x, crow.y) === TERRAIN.STONE) onStone += 1
  }
  assert.equal(world.entities.includes(crow), true, 'the crow must not drown in rock')
  assert.equal(onStone, 100, `the crow must ignore terrain, only ${onStone}/100 ticks were over rock`)
})

// ---------------------------------------------------------------------------
// Predator / prey matrix (DESIGN §2)
// ---------------------------------------------------------------------------

test('predators never attack outside their prey table', () => {
  // fox: prey is rabbit only, so deer next to a fox stay unmarked
  {
    const world = blankWorld()
    world.grass.fill(0.9)
    const fox = spawnEntity(world, 'fox', 20, 15)
    const deer = [0, 1, 2, 3].map(index => spawnEntity(world, 'deer', 20 + index * 0.6, 15))
    runTicks(world, 40)
    assert.equal(alive(world, 'deer'), 4, 'a fox ate a deer')
    assert.deepEqual(deer.map(entity => entity.fate), ['', '', '', ''], 'a fox must not even mark a deer as prey')
    assert.ok(world.entities.includes(fox), 'the fox must not starve during the check')
  }
  // pike: prey is fish only, so a rabbit one cell away on the bank is safe
  {
    const world = blankWorld()
    fillRegion(world, TERRAIN.WATER, 0, 0, 19, 29)
    for (let y = 0; y < 30; y++) for (let x = 20; x < 40; x++) world.grass[y * 40 + x] = 0.9
    const pike = spawnEntity(world, 'pike', 19.5, 15)
    const rabbit = spawnEntity(world, 'rabbit', 20.5, 15)
    const before = pike.energy
    runTicks(world, 30)
    assert.equal(alive(world, 'rabbit'), 1, 'a pike ate a rabbit')
    assert.equal(rabbit.fate, '', 'a pike must not mark a rabbit as prey')
    assert.ok(pike.energy < before, 'a pike that ate nothing must only lose energy')
  }
  // crow: scavenger, a live rabbit beside it is not food
  {
    const world = blankWorld()
    world.grass.fill(0.9)
    const crow = spawnEntity(world, 'crow', 20, 15)
    crow.genes.vision = 22
    spawnEntity(world, 'rabbit', 20.6, 15)
    runTicks(world, 60)
    assert.equal(alive(world, 'rabbit'), 1, 'a crow ate a living animal')
    assert.equal(world.corpses.length, 0, 'the crow must leave no carcass behind')
  }
})

test('a wolf takes the deer even when a rabbit is closer', () => {
  const world = blankWorld()
  const wolf = spawnEntity(world, 'wolf', 20, 15)
  // Both inside the wolf's catch radius; the rabbit is the closer animal.
  const deer = spawnEntity(world, 'deer', 21.1, 15)
  const rabbit = spawnEntity(world, 'rabbit', 20.5, 15)
  stepWorld(world, TICK)
  assert.equal(wolf.fate, '', 'the wolf itself is fine')
  assert.equal(world.entities.includes(rabbit), true, 'the wolf must not take the closer rabbit while a deer is in reach')
  assert.equal(rabbit.fate, '', 'the closer rabbit must stay untouched')
  assert.equal(world.entities.includes(deer), false, 'the wolf must take the deer (first entry in its prey list)')
  assert.deepEqual(world.corpses.map(corpse => corpse.species), ['deer'], 'the deer must be the only casualty')
})

test('a scavenger eats a carcass and gains its energy', () => {
  const world = blankWorld()
  const crow = spawnEntity(world, 'crow', 20, 15)
  const rabbit = spawnEntity(world, 'rabbit', 20.4, 15)
  rabbit.energy = 0
  stepWorld(world, TICK)
  assert.equal(world.corpses.length, 1, 'starvation must leave one carcass')
  const energyBefore = crow.energy
  stepWorld(world, TICK)
  assert.equal(world.corpses.length, 0, 'the crow must eat the carcass')
  assert.ok(crow.energy > energyBefore, `the crow must gain energy from the carcass, ${energyBefore} -> ${crow.energy}`)
})

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

test('death removes the animal and leaves exactly one carcass', () => {
  // starvation: five animals run out of energy on barren ground
  {
    const world = blankWorld()
    const starving = []
    for (let index = 0; index < 5; index++) starving.push(spawnEntity(world, 'rabbit', 10 + index, 10))
    for (const rabbit of starving) rabbit.energy = 0
    stepWorld(world, TICK)
    assert.equal(alive(world, 'rabbit'), 0, 'every starved animal must be removed')
    assert.equal(world.corpses.length, 5, 'each death must leave exactly one carcass')
    for (const corpse of world.corpses) {
      assert.equal(corpse.species, 'rabbit')
      assert.equal(corpse.energy, 14, 'a rabbit carcass carries round(meat * 0.8) energy')
      assert.equal(corpse.decay, 0, 'a fresh carcass starts undecayed')
    }
  }
  // old age
  {
    const world = blankWorld()
    const old = spawnEntity(world, 'rabbit', 10, 10)
    old.age = SPECIES.rabbit.genes.lifespan[1] + 1
    stepWorld(world, TICK)
    assert.equal(alive(world, 'rabbit'), 0, 'an animal past its lifespan must die')
    assert.equal(world.corpses.length, 1, 'old age must leave exactly one carcass')
  }
  // predation, on ground where the prey cannot graze its way back
  {
    const world = blankWorld()
    spawnEntity(world, 'fox', 20, 15)
    spawnEntity(world, 'rabbit', 20.9, 15)
    runTicks(world, 3)
    assert.equal(alive(world, 'rabbit'), 0, 'the bitten rabbit must be removed')
    assert.equal(world.corpses.length, 1, 'predation must leave exactly one carcass')
  }
})

test('the same prey is never eaten twice in one tick', () => {
  const world = blankWorld()
  spawnEntity(world, 'fox', 20, 15)
  spawnEntity(world, 'fox', 20.2, 15)
  spawnEntity(world, 'rabbit', 20.9, 15)
  runTicks(world, 5)
  assert.equal(alive(world, 'rabbit'), 0, 'the rabbit must be gone')
  assert.equal(world.corpses.length, 0, 'two foxes must not produce two carcasses from one rabbit')
})

test('DESIGN §5.2 — a prey marked eaten dies even when it can graze that same tick', () => {
  // Regression guard for the 0.1.0 test report: stepEntity() used to run feed()
  // before the `energy <= 0` check, so a bitten grazer refilled energy from the
  // grass under it (0.853 observed) and survived with `fate === 'eaten'`
  // forever. nearestPrey() only targets `fate === ''`, so the animal became
  // immune to predation while still being counted and still breeding.
  const world = blankWorld()
  world.grass.fill(0.9)
  const fox = spawnEntity(world, 'fox', 20, 15)
  const rabbit = spawnEntity(world, 'rabbit', 20.9, 15)
  for (let tick = 0; tick < 200; tick++) {
    fox.x = rabbit.x
    fox.y = rabbit.y
    fox.energy = SPECIES.fox.balance.maxEnergy
    stepWorld(world, TICK)
  }
  assert.equal(world.entities.includes(rabbit), false, 'a prey bitten by a predator must be removed from the world')
  assert.equal(world.corpses.length, 1, 'the bitten prey must leave exactly one carcass')
})

// ---------------------------------------------------------------------------
// Reproduction (DESIGN §3, §8)
// ---------------------------------------------------------------------------

test('breeding mutates genes inside the species ranges and increments the generation', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  const parent = spawnEntity(world, 'rabbit', 20, 15, undefined, 1)
  parent.energy = SPECIES.rabbit.balance.maxEnergy
  parent.age = SPECIES.rabbit.balance.maturity
  // Snapshot each newborn as it appears: the objects keep grazing afterwards.
  const children = []
  for (let round = 0; round < 12; round++) {
    const known = new Set(world.entities.map(entity => entity.id))
    parent.cooldown = 0
    parent.energy = SPECIES.rabbit.balance.maxEnergy
    stepWorld(world, TICK)
    for (const entity of world.entities) {
      if (known.has(entity.id)) continue
      children.push({ generation: entity.generation, energy: entity.energy, genes: { ...entity.genes } })
    }
    // Rabbits breed density-dependently (DESIGN §5.2 territory), so clear the
    // newborns before the next round: this test is about the gates, not crowding.
    world.entities = world.entities.filter(entity => known.has(entity.id))
  }
  // A litter, not a single pup: twelve breeding events yield twelve litters.
  const litter = SPECIES.rabbit.balance.litter
  assert.ok(children.length >= 12 * litter[0] && children.length <= 12 * litter[1],
    `twelve breeding events must yield litters of ${litter[0]}..${litter[1]} kits, got ${children.length}`)
  const ranges = SPECIES.rabbit.genes
  for (const child of children) {
    assert.equal(child.generation, 2, 'a child is one generation deeper than its parent')
    for (const key of GENE_KEYS) {
      const value = child.genes[key]
      assert.ok(value >= ranges[key][0] && value <= ranges[key][1],
        `${key} escaped the species range: ${value} not in [${ranges[key][0]}, ${ranges[key][1]}]`)
    }
  }
  const mutated = children.some(child => GENE_KEYS.some(key => child.genes[key] !== parent.genes[key]))
  assert.ok(mutated, 'no child gene ever drifted from the parent: mutation is not wired up')
  assert.equal(parent.children, children.length, 'the parent must count every kit in its litters')
  assert.ok(parent.cooldown > 0, 'a parent must be on cooldown after breeding')
  assert.equal(children[0].energy, SPECIES.rabbit.balance.startEnergy * 0.4, 'a newborn starts with 40% of the species start energy')
})

test('territory blocks breeding when the neighbourhood is already crowded', () => {
  // DESIGN §5.2: a species with `territory` must not breed past its local
  // density. Eight fed, mature rabbits inside one territory radius cannot all
  // litter in the same tick — that density feedback is what keeps herbivore
  // booms from mowing the whole meadow in one generation.
  const territory = SPECIES.rabbit.territory
  assert.ok(territory !== undefined, 'rabbits must keep a territory rule')

  /** Fed, mature, off-cooldown adults where asked; returns the world afterwards. */
  const crowd = (positions) => {
    const world = blankWorld()
    world.grass.fill(0.9)
    for (const [x, y] of positions) {
      const rabbit = spawnEntity(world, 'rabbit', x, y)
      rabbit.energy = SPECIES.rabbit.balance.maxEnergy
      rabbit.age = SPECIES.rabbit.balance.maturity
      rabbit.cooldown = 0
    }
    return world
  }

  // Crowded: every adult sees more than `max` neighbours, so nobody breeds.
  const crowded = crowd(Array.from({ length: territory.max + 2 }, (_, index) =>
    [20 + (index % 3) * 0.4, 15 + Math.floor(index / 3) * 0.4]))
  const before = crowded.entities.length
  stepWorld(crowded, TICK)
  assert.equal(crowded.entities.length - before, 0,
    `a neighbourhood already holding ${territory.max} rabbits must not breed`)

  // Sparse: the same adults, each alone in its own territory, all breed.
  const sparse = crowd([[10, 8], [24, 8], [38, 20]])
  const sparseBefore = sparse.entities.length
  stepWorld(sparse, TICK)
  const sparseBorn = sparse.entities.length - sparseBefore
  const litter = SPECIES.rabbit.balance.litter
  assert.ok(sparseBorn >= 3 * litter[0] && sparseBorn <= 3 * litter[1],
    `three fed adults spaced beyond the territory radius must each drop a litter, got `)
})

test('breeding is gated by maturity, energy and cooldown', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  const young = spawnEntity(world, 'rabbit', 20, 15)
  young.energy = SPECIES.rabbit.balance.maxEnergy
  young.age = 0
  stepWorld(world, TICK)
  assert.equal(alive(world, 'rabbit'), 1, 'an immature animal must not breed')

  const hungry = spawnEntity(world, 'rabbit', 25, 15)
  hungry.energy = SPECIES.rabbit.balance.breedEnergy - 20
  hungry.age = SPECIES.rabbit.balance.maturity
  stepWorld(world, TICK)
  assert.equal(alive(world, 'rabbit'), 2, 'an animal below the breed energy must not breed')

  const cooling = spawnEntity(world, 'rabbit', 30, 15)
  cooling.energy = SPECIES.rabbit.balance.maxEnergy
  cooling.age = SPECIES.rabbit.balance.maturity
  cooling.cooldown = 5
  stepWorld(world, TICK)
  assert.equal(alive(world, 'rabbit'), 3, 'an animal on cooldown must not breed')
})

// ---------------------------------------------------------------------------
// Persistence (DESIGN §5, §6.2)
// ---------------------------------------------------------------------------

test('serializeWorld -> deserializeWorld round-trips the world and keeps simulating', () => {
  const world = createWorld({ seed: 99, width: 60, height: 40 })
  runTicks(world, 50)
  const saved = serializeWorld(world)
  // Through JSON, exactly like localStorage would.
  const restored = deserializeWorld(JSON.parse(JSON.stringify(saved)))
  assert.equal(diffCells(world.terrain, restored.terrain), 0, 'terrain must survive the round-trip byte for byte')
  const tolerance = 1 / 255 + 1e-6
  for (const field of ['grass', 'weed', 'fertility']) {
    let worst = 0
    for (let i = 0; i < world[field].length; i++) worst = Math.max(worst, Math.abs(world[field][i] - restored[field][i]))
    assert.ok(worst <= tolerance, `${field} drifted by ${worst} (quantized saves allow ${tolerance})`)
  }
  assert.equal(restored.trees.length, world.trees.length, 'plant count must survive the round-trip')
  assert.equal(restored.entities.length, world.entities.length, 'animal count must survive the round-trip')
  assert.equal(restored.corpses.length, world.corpses.length, 'carcass count must survive the round-trip')
  assert.equal(restored.tick, world.tick, 'the tick counter must survive the round-trip')
  for (let index = 0; index < world.entities.length; index++) {
    const before = world.entities[index]
    const after = restored.entities[index]
    assert.equal(after.species, before.species, 'species order must survive the round-trip')
    assert.ok(Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6,
      `position drifted: (${before.x},${before.y}) -> (${after.x},${after.y})`)
    assert.equal(after.generation, before.generation, 'lineage depth must survive the round-trip')
    assert.equal(after.children, before.children, 'offspring count must survive the round-trip')
    for (const key of GENE_KEYS) assert.equal(after.genes[key], before.genes[key], `${key} gene must survive the round-trip`)
  }
  // and the restored world is a live world, not a snapshot
  const tickBefore = restored.tick
  runTicks(restored, 20)
  assert.equal(restored.tick, tickBefore + 20, 'a restored world must keep taking steps')
  assert.ok(restored.entities.length > 0, 'a restored world must still have animals')
  assert.equal(diffCells(world.terrain, restored.terrain), 0, 'simulating a restored world must not rewrite terrain')
})

test('deserializeWorld refuses data this build does not understand', () => {
  const world = createWorld({ seed: 5, width: 48, height: 32 })
  const saved = serializeWorld(world)
  assert.throws(() => deserializeWorld({ ...saved, version: 99 }), /unsupported world save/,
    'a save from another format version must be rejected')
  assert.throws(() => deserializeWorld(null), /unsupported world save/, 'null is not a save')
  assert.throws(() => deserializeWorld({ ...saved, width: 0 }), /bad world size in save/, 'a zero-sized world must be rejected')
  assert.throws(() => deserializeWorld({ ...saved, terrain: 'AAAA' }), /bad terrain in save/, 'a truncated terrain must be rejected')
})

// ---------------------------------------------------------------------------
// stepWorld guards and caps (DESIGN §5.2)
// ---------------------------------------------------------------------------

test('stepWorld ignores dt <= 0, NaN and non-numbers and clamps dt above 0.5', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  const frozen = () => ({ tick: world.tick, time: world.time })
  const before = frozen()
  for (const dt of [0, -1, NaN, undefined, null, '0.1']) {
    stepWorld(world, dt)
    assert.deepEqual(frozen(), before, `stepWorld(${String(dt)}) must be a no-op`)
  }
  stepWorld(world, 2)
  assert.equal(world.tick, before.tick + 1, 'one call is one tick')
  assert.equal(world.time, before.time + 0.5, 'dt above 0.5 must be clamped to 0.5')
  stepWorld(world, 0.1)
  assert.equal(world.time, before.time + 0.6, 'a normal dt must be applied verbatim')
})

test('a species at its cap refuses new animals but keeps the ones it has', () => {
  const world = blankWorld()
  world.grass.fill(0.9)
  const cap = SPECIES.wolf.cap
  let placed = 0
  for (let attempt = 0; attempt < cap * 3; attempt++) {
    if (spawnEntity(world, 'wolf', 5 + (attempt % 30), 5 + ((attempt / 30) | 0)) !== null) placed += 1
  }
  assert.equal(placed, cap, `the wolf cap is ${cap}, ${placed} were accepted`)
  assert.equal(spawnEntity(world, 'wolf', 20, 15), null, 'spawnEntity must refuse an animal past the cap')
  place(world, 'wolf', 20, 15, 2)
  // Player placement may overstock past the ecological cap, but only to the
  // forced-placement ceiling — it must never ignore density without limit.
  const ceiling = Math.round(cap * 1.4)
  const afterBrush = alive(world, 'wolf')
  assert.ok(afterBrush > cap, 'the brush must be able to add animals past the ecological cap')
  assert.ok(afterBrush <= ceiling, `the brush stopped at ${afterBrush}, ceiling is ${ceiling}`)
  runTicks(world, 10)
  assert.ok(alive(world, 'wolf') <= ceiling, 'reaching the ceiling must not explode the population')
  assert.ok(world.entities.length <= ceiling, 'the global entity list must stay under the ceiling')
})

test('handleImmigration refills a species that was wiped out and leaves the others alone', () => {
  const world = createWorld({ seed: 11, width: 100, height: 70 })
  world.entities = world.entities.filter(entity => entity.species !== 'wolf' && entity.species !== 'fish')
  assert.equal(alive(world, 'wolf'), 0)
  assert.equal(alive(world, 'fish'), 0)
  const untouched = { rabbit: alive(world, 'rabbit'), deer: alive(world, 'deer'), crow: alive(world, 'crow') }
  world.immigrationTimer = 0
  handleImmigration(world, TICK)
  const wolves = alive(world, 'wolf')
  const fish = alive(world, 'fish')
  assert.ok(wolves >= 4 && wolves <= 8, `immigration drops a group of 4..8 wolves, got ${wolves}`)
  assert.ok(fish >= 4 && fish <= 8, `immigration drops a group of 4..8 fish, got ${fish}`)
  for (const species of world.entities) {
    if (species.species !== 'wolf' && species.species !== 'fish') continue
    const row = SPECIES[species.species]
    const here = terrainAtCell(world, species.x, species.y)
    if (row.habitat === 'water') assert.equal(here, TERRAIN.WATER, 'immigrating fish must land in water')
    else assert.equal(here, TERRAIN.GRASS, 'immigrating land animals must land on grass')
  }
  assert.deepEqual(
    { rabbit: alive(world, 'rabbit'), deer: alive(world, 'deer'), crow: alive(world, 'crow') },
    untouched,
    'species already above their minimum must not be topped up',
  )
})

// ---------------------------------------------------------------------------
// Read-only helpers
// ---------------------------------------------------------------------------

test('findEntityAt returns the nearest animal inside the radius only', () => {
  const world = blankWorld()
  const near = spawnEntity(world, 'rabbit', 20, 15)
  spawnEntity(world, 'deer', 24, 15)
  assert.equal(findEntityAt(world, 20.5, 15.2), near, 'the nearest animal must win')
  assert.equal(findEntityAt(world, 21, 15, 2.5), near)
  assert.equal(findEntityAt(world, 10, 10), undefined, 'nothing within the default radius must mean undefined')
  assert.equal(findEntityAt(world, 26, 15, 1), undefined, 'an animal outside the radius must not be returned')
  assert.equal(findEntityAt(world, 23.5, 15, 0.2), undefined, 'a small radius must not reach the deer either')
})

test('sampleStats and pushHistory report the live world', () => {
  const world = createWorld({ seed: 21, width: 60, height: 40 })
  runTicks(world, 30)
  const stats = sampleStats(world)
  for (const id of SPECIES_IDS) {
    assert.equal(stats.counts[id], countSpecies(world, id), `sampleStats must count ${id} like countSpecies does`)
  }
  assert.equal(stats.day, Math.floor(world.time / engine.DAY_SECONDS) + 1)
  assert.match(stats.clock, /^\d{2}:\d{2}$/, `clock must be HH:MM, got ${stats.clock}`)
  assert.equal(stats.corpses, world.corpses.length)
  assert.ok(Number.isInteger(stats.grass) && stats.grass >= 0)
  assert.ok(Number.isInteger(stats.weed) && stats.weed >= 0)

  for (let index = 0; index < 250; index++) pushHistory(world)
  assert.equal(world.history.length, 200, 'the population chart keeps the last 200 samples')
  const sample = world.history.at(-1)
  assert.equal(sample.t, Math.round(world.time))
  for (const id of SPECIES_IDS) assert.equal(typeof sample.counts[id], 'number', `history must carry ${id}`)
})
// ---------------------------------------------------------------------------
// The land/water bridge: wading, amphibious animals and the cross-habitat hunt
// ---------------------------------------------------------------------------

test('a wader stands in the shallows but not in deep water', () => {
  const world = blankWorld({ width: 60, height: 40 })
  fillRegion(world, TERRAIN.WATER, 10, 5, 50, 35)
  computeHydrology(world)
  const shallowIndex = 20 * world.width + 11
  const deepIndex = 20 * world.width + 30
  assert.ok(world.depth[shallowIndex] < 0.34, 'the bank must be shallow, got ' + world.depth[shallowIndex])
  assert.ok(world.depth[deepIndex] > 0.8, 'the middle must be deep, got ' + world.depth[deepIndex])
  const { canStand } = engine
  assert.equal(canStand(world, SPECIES.heron, 11.5, 20.5), true, 'a heron must be able to wade at the bank')
  assert.equal(canStand(world, SPECIES.heron, 30.5, 20.5), false, 'a heron must not walk the lake bed')
  assert.equal(canStand(world, SPECIES.bear, 11.5, 20.5), true, 'a bear also wades')
  assert.equal(canStand(world, SPECIES.rabbit, 11.5, 20.5), false, 'a rabbit must not enter water')
  assert.equal(canStand(world, SPECIES.frog, 11.5, 20.5), true, 'a frog wades')
  assert.equal(canStand(world, SPECIES.otter, 30.5, 20.5), true, 'an otter swims')
  assert.equal(canStand(world, SPECIES.otter, 2.5, 2.5), true, 'an amphibious otter may haul out')
  assert.equal(canStand(world, SPECIES.fish, 2.5, 2.5), false, 'a fish must stay in the water')
  assert.equal(canStand(world, SPECIES.crow, 30.5, 20.5), true, 'a crow flies over everything')
})

test('a heron takes fish out of the shallows and leaves a carcass', () => {
  const world = blankWorld({ width: 40, height: 30 })
  fillRegion(world, TERRAIN.WATER, 0, 0, 9, 29)
  fillRegion(world, TERRAIN.GRASS, 10, 0, 39, 29)
  computeHydrology(world)
  const fish = spawnEntity(world, 'fish', 5.5, 15.5)
  const heron = spawnEntity(world, 'heron', 4.5, 15.5)
  assert.ok(fish !== null && heron !== null, 'both animals must spawn')
  for (let tick = 0; tick < 600 && countSpecies(world, 'fish') > 0; tick++) stepWorld(world, TICK)
  assert.equal(countSpecies(world, 'fish'), 0, 'the heron must catch the fish in its reach')
  assert.ok(world.corpses.some(corpse => corpse.species === 'fish'), 'the kill must leave a carcass')
})

test('a lily pad feeds the water under it, which is where fish graze', () => {
  const world = blankWorld({ width: 40, height: 30 })
  fillRegion(world, TERRAIN.WATER, 0, 0, 19, 29)
  fillRegion(world, TERRAIN.GRASS, 20, 0, 39, 29)
  computeHydrology(world)
  world.waterFertility.fill(0.05)
  world.trees.push({ id: 9001, x: 8, y: 15, variant: 'lily', size: 1, age: 0, foliage: 1, seedTimer: 9999 })
  for (let tick = 0; tick < 40; tick++) stepWorld(world, TICK)
  const under = world.waterFertility[15 * world.width + 8]
  const far = world.waterFertility[5 * world.width + 3]
  assert.ok(under > 0.06, 'the lily must enrich the water beneath it, got ' + under)
  assert.ok(Math.abs(far - 0.05) < 1e-6, 'water out of the lily footprint must be untouched, got ' + far)
})

test('the food web reaches across the water line', () => {
  for (const id of ['heron', 'bear', 'otter']) {
    assert.ok(SPECIES[id].prey.includes('fish'), id + ' must hunt fish')
  }
  assert.ok(SPECIES.pike.prey.includes('frog'), 'the pike also takes frogs')
  assert.ok(SPECIES.bear.prey.includes('deer'), 'the bear still takes deer on land')
  assert.ok(SPECIES.frog.flora === 'weed', 'the frog grazes the water plants')
  assert.equal(SPECIES_IDS.length, 11, 'the roster is eleven species')
})

