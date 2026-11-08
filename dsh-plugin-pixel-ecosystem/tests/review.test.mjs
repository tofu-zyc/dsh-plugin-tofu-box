/**
 * Review regressions (code review, 0.3 energy-ledger).
 *
 * What this pins: the boundaries a reviewer cannot verify by reading alone -
 * determinism, the energy ledger's hard invariants, the single death path, the
 * save round trip, and the cost of the corpse/food scans. Each test names the
 * failure it would catch, so a red here is a bug report with a reproduction.
 *
 * These are deliberately written to FAIL LOUDLY on a real defect and to stay
 * quiet on a tuning choice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const {
  SPECIES, SPECIES_IDS, TERRAIN, TICK, createWorld, stepWorld, spawnEntity,
  serializeWorld, deserializeWorld, countSpecies, dieOf, bodyOf,
} = engine

const EMPTY_STOCKS = Object.fromEntries(SPECIES_IDS.map(id => [id, 0]))

/** @param {{width?: number, height?: number, seed?: number}} [options] - grid. @returns {object} world. */
function blankWorld(options = {}) {
  const world = createWorld({
    seed: options.seed ?? 7,
    width: options.width ?? 40,
    height: options.height ?? 30,
    stocks: EMPTY_STOCKS,
    immigration: false,
  })
  world.terrain.fill(TERRAIN.GRASS)
  world.grass.fill(0.6)
  world.weed.fill(0)
  world.trees.length = 0
  world.entities.length = 0
  world.corpses.length = 0
  world.hydrologyDirty = false
  return world
}

/**
 * A cheap order-sensitive digest of everything the simulation must reproduce.
 * @param {object} world - the world.
 * @returns {string} digest.
 */
function digest(world) {
  let acc = 0
  for (const entity of world.entities) {
    acc = (acc * 31 + Math.round(entity.x * 1000)) % 1e12
    acc = (acc * 31 + Math.round(entity.y * 1000)) % 1e12
    acc = (acc * 31 + Math.round((bodyOf(entity).E || 0) * 100)) % 1e12
    acc = (acc * 31 + Math.round(entity.age * 100)) % 1e12
  }
  return acc + ':' + world.entities.length + ':' + Math.round(world.time * 10) + ':' + world.nextId
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same seed reproduces the same world after 400 ticks', () => {
  // Would catch: a stray Math.random, or an iteration order that depends on
  // object identity (Map/Set insertion from a non-deterministic source).
  const run = () => {
    const world = createWorld({ seed: 424242 })
    for (let tick = 0; tick < 400; tick++) stepWorld(world, TICK)
    return digest(world)
  }
  assert.equal(run(), run(), 'two runs of the same seed diverged')
})

test('a restored world continues on the same trajectory as the original', () => {
  // Would catch: save/restore losing hidden state (rng, think timers, belief),
  // which shows up as a world that 'forks' after a reload.
  const world = createWorld({ seed: 99 })
  for (let tick = 0; tick < 120; tick++) stepWorld(world, TICK)
  const restored = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world))))
  for (let tick = 0; tick < 120; tick++) {
    stepWorld(world, TICK)
    stepWorld(restored, TICK)
  }
  assert.equal(digest(restored), digest(world),
    'a restored world must keep simulating the original trajectory')
})

// ---------------------------------------------------------------------------
// Energy ledger boundaries
// ---------------------------------------------------------------------------

test('no animal ever leaves its reserve, structure or health range', () => {
  // Would catch: a negative reserve after an unaffordable breeding payment, an
  // Emax that shrank under the reserve, or a health that ran past 0..1 and hid a
  // death (docs/20-CORE-LOOP section 2.4 invariant 1).
  const world = createWorld({ seed: 2024 })
  const violations = []
  for (let tick = 0; tick < 600; tick++) {
    stepWorld(world, TICK)
    for (const entity of world.entities) {
      const body = bodyOf(entity)
      if (!Number.isFinite(body.E)) violations.push('tick ' + tick + ' ' + entity.species + ' E not finite')
      else if (!(body.E >= 0)) violations.push('tick ' + tick + ' ' + entity.species + ' E=' + body.E)
      else if (body.E > body.Emax * 1.000001) violations.push('tick ' + tick + ' ' + entity.species + ' E=' + body.E + ' > Emax=' + body.Emax)
      if (!(body.V > 0)) violations.push('tick ' + tick + ' ' + entity.species + ' V=' + body.V)
      if (!(body.health >= 0 && body.health <= 1)) violations.push('tick ' + tick + ' ' + entity.species + ' health=' + body.health)
      if (violations.length > 5) break
    }
    if (violations.length > 5) break
  }
  assert.deepEqual(violations, [], 'ledger invariant violated: ' + violations.join(' | '))
})

test('dieOf is idempotent: two calls leave one corpse and one cause', () => {
  // Would catch: a policy or a second predator calling dieOf on an animal that is
  // already dead, which would double the carcass and double-count the death in
  // the census (the energy book would gain a free body).
  const world = blankWorld()
  const rabbit = spawnEntity(world, 'rabbit', 20, 15)
  const first = dieOf(world, rabbit, 'starved')
  const second = dieOf(world, rabbit, 'predation')
  assert.ok(first !== null && first !== undefined, 'the first dieOf must produce a carcass')
  assert.ok(second === null || second === undefined, 'the second dieOf must refuse to kill again')
  assert.equal(world.corpses.length, 1, 'a double dieOf must not stack carcasses')
  assert.equal(world.corpses[0].cause, 'starved', 'the first cause must win')
  assert.equal(rabbit.body.cause, 'starved', 'the body cause must not be overwritten')
})

test('an unaffordable breeding payment cannot drive the reserve negative', () => {
  // Would catch: `body.E -= breedCost` without a floor, which would let a parent
  // spend energy it does not have and turn a birth into an energy source.
  const world = blankWorld()
  const parent = spawnEntity(world, 'rabbit', 20, 15)
  const body = bodyOf(parent)
  parent.age = SPECIES.rabbit.balance.maturity
  body.E = Math.max(1, SPECIES.rabbit.balance.breedCost * 0.2)
  parent.cooldown = 0
  for (let tick = 0; tick < 40; tick++) {
    stepWorld(world, TICK)
    if (!world.entities.includes(parent)) break
    assert.ok(body.E >= 0, 'reserve went negative after breeding: ' + body.E)
  }
})

// ---------------------------------------------------------------------------
// Save round trip
// ---------------------------------------------------------------------------

test('the body survives a save round trip, not just the genes', () => {
  // Would catch: a save that stores position and genes but loses the reserve,
  // structure or cooldown, so every reload silently resets every animal to a
  // fresh adult (DESIGN 6.2 / roadmap P1-6).
  const world = createWorld({ seed: 77, width: 64, height: 48 })
  for (let tick = 0; tick < 60; tick++) stepWorld(world, TICK)
  const saved = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world))))
  assert.equal(saved.entities.length, world.entities.length, 'entity count must survive')
  const mismatches = []
  for (let index = 0; index < world.entities.length; index++) {
    const before = bodyOf(world.entities[index])
    const after = bodyOf(saved.entities[index])
    if (Math.abs(after.E - before.E) > Math.max(1, before.E * 1e-6)) mismatches.push('E ' + before.E + ' -> ' + after.E)
    if (Math.abs(after.V - before.V) > Math.max(1e-6, before.V * 1e-6)) mismatches.push('V ' + before.V + ' -> ' + after.V)
    if (Math.abs(after.health - before.health) > 1e-6) mismatches.push('health ' + before.health + ' -> ' + after.health)
    if (Math.abs(world.entities[index].cooldown - saved.entities[index].cooldown) > 1e-6) {
      mismatches.push('cooldown ' + world.entities[index].cooldown + ' -> ' + saved.entities[index].cooldown)
    }
    if (mismatches.length > 6) break
  }
  assert.deepEqual(mismatches, [], 'body state lost in the save: ' + mismatches.join(' | '))
})

test('a save from a foreign version is refused instead of half-loaded', () => {
  // Would catch: a version check that warns but still returns a world, which is
  // how a player silently loses a save to a mismatched build.
  const world = createWorld({ seed: 5, width: 48, height: 32 })
  const saved = serializeWorld(world)
  assert.throws(() => deserializeWorld({ ...saved, version: 1 }), /save version/i,
    'a v1 save must be refused by a v2 build')
  assert.throws(() => deserializeWorld({ ...saved, entities: 'not-an-array' }), /entity|entities/i,
    'a corrupt entity list must be refused, not silently dropped')
})

// ---------------------------------------------------------------------------
// Cost of the food scans
// ---------------------------------------------------------------------------

test('tick cost does not explode with the number of carcasses', () => {
  // Would catch: nearestCorpse/findFoliage scanning the whole corpse list per
  // animal per tick. At 1024x640 with hundreds of carcasses that is the O(n^2)
  // cliff in docs/90-ROADMAP P1-5.
  const timeFor = (corpses) => {
    const world = createWorld({ seed: 31337, width: 160, height: 120 })
    world.corpses.length = 0
    for (let index = 0; index < corpses; index++) {
      world.corpses.push({
        id: 900000 + index,
        x: 5 + (index % 60),
        y: 5 + ((index * 7) % 50),
        species: 'rabbit',
        decay: 0,
        energy: 1000,
        mass: 1.4,
        cause: 'starved',
      })
    }
    const started = performance.now()
    for (let tick = 0; tick < 30; tick++) stepWorld(world, TICK)
    return performance.now() - started
  }
  timeFor(4) // warm the JIT
  const few = timeFor(4)
  const many = timeFor(160)
  // 40x the corpses must not cost anywhere near 40x the time; a linear scan per
  // animal would land well past this. 8x is the tripwire, not a benchmark.
  const ratio = many / Math.max(0.001, few)
  assert.ok(ratio < 8,
    'tick cost grew ' + ratio.toFixed(1) + 'x when corpses grew 40x ('
    + few.toFixed(1) + ' ms -> ' + many.toFixed(1) + ' ms), which smells like a full corpse scan per animal')
})
