/**
 * Behaviour contract (roadmap P2): perception, drives, deliberation, execution.
 *
 * What this pins and why: the 0.2.x build decided everything every 0.22-0.55 s
 * from a handful of random samples, so nothing on screen ever looked like it was
 * doing something, and decisions never read the body — an animal could starve
 * while standing in a meadow. These tests hold the four promises that fix that:
 *
 *   1. drives are DERIVED from the body (hunger = 1 - E/Emax), not from a timer;
 *   2. belief is a real scan with timestamps, and it expires;
 *   3. a bout of behaviour has a duration, a completion condition and a
 *      commitment floor, and intent is derived from state.id;
 *   4. the whole thing is deterministic from the seed.
 *
 * Everything here drives the shipped bundle through the __engine seam, so a
 * change that only works in the sources fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const {
  SPECIES, SPECIES_IDS, TERRAIN, TICK, createWorld, stepWorld, spawnEntity, bodyOf,
  INTENT_IDS,
} = engine

/** A world with no seeded animals, so a test owns exactly what it spawns. */
const EMPTY_STOCKS = Object.fromEntries(SPECIES_IDS.map(id => [id, 0]))

/**
 * A quiet test world: flat grassland, no plants, no migration.
 * @param {{ width?: number, height?: number, seed?: number, terrain?: number }} [options] - size, seed, ground.
 * @returns {object} the world.
 */
function quietWorld(options = {}) {
  const world = createWorld({
    seed: options.seed ?? 31,
    width: options.width ?? 64,
    height: options.height ?? 48,
    stocks: EMPTY_STOCKS,
    immigration: false,
  })
  world.terrain.fill(options.terrain ?? TERRAIN.GRASS)
  world.grass.fill(0)
  world.weed.fill(0)
  world.trees.length = 0
  world.entities.length = 0
  world.corpses.length = 0
  return world
}

/**
 * A grassland with an edible sward, so a grazer has something to find.
 * @param {object} world - the world.
 * @param {number} [biomass] - standing crop to fill in.
 * @returns {object} the world.
 */
function withSward(world, biomass = 0.6) {
  world.grass.fill(biomass)
  return world
}

/**
 * Step a world for a number of seconds.
 * @param {object} world - the world.
 * @param {number} seconds - simulated seconds.
 * @returns {void}
 */
function run(world, seconds) {
  const steps = Math.round(seconds / TICK)
  for (let index = 0; index < steps; index++) stepWorld(world, TICK)
}

// ---------------------------------------------------------------------------
// 1. Drives are derived from the body
// ---------------------------------------------------------------------------

test('hunger is the reserve emptying, not a timer', () => {
  const world = withSward(quietWorld())
  const rabbit = spawnEntity(world, 'rabbit', 30, 24)
  assert.ok(rabbit !== null, 'the rabbit must spawn')
  const body = bodyOf(rabbit)
  // Full reserve: no hunger at all, however long the animal stands there.
  body.E = body.Emax * 0.98
  run(world, 2)
  assert.equal(rabbit.drives.hunger, 0, 'a full reserve must read as no hunger')
  // Half empty: hungry, and the number must track 1 - E/Emax, not a clock.
  body.E = body.Emax * 0.5
  run(world, 0.2)
  assert.ok(rabbit.drives.hunger > 0.3 && rabbit.drives.hunger < 0.6,
    'half a reserve must read as moderate hunger, got ' + rabbit.drives.hunger)
  body.E = body.Emax * 0.2
  run(world, 0.2)
  assert.ok(rabbit.drives.hunger > 0.6,
    'a nearly empty reserve must read as severe hunger, got ' + rabbit.drives.hunger)
})

test('every drive channel is present and inside 0..1', () => {
  const world = withSward(quietWorld())
  const rabbit = spawnEntity(world, 'rabbit', 30, 24)
  const deer = spawnEntity(world, 'deer', 20, 20)
  const crow = spawnEntity(world, 'crow', 40, 30)
  run(world, 3)
  const keys = engine.DRIVE_KEYS ?? ['hunger', 'thirst', 'cold', 'fatigue', 'fear', 'social', 'curiosity', 'libido']
  for (const entity of [rabbit, deer, crow]) {
    assert.ok(entity.drives !== undefined, entity.species + ' must carry a drive record')
    for (const key of keys) {
      const value = entity.drives[key]
      assert.equal(typeof value, 'number', entity.species + ' drive ' + key + ' must be a number')
      assert.ok(value >= 0 && value <= 1, entity.species + ' drive ' + key + ' escaped 0..1: ' + value)
    }
    // The legacy view the inspector renders must agree with the drives.
    assert.ok(Math.abs(entity.needs.energy - entity.drives.fatigue) < 1e-9,
      entity.species + ' needs.energy must be the fatigue drive')
    assert.ok(Math.abs(entity.needs.safety - entity.drives.fear) < 1e-9,
      entity.species + ' needs.safety must be the fear drive')
  }
})

// ---------------------------------------------------------------------------
// 2. Perception: a real scan with timestamps that expire
// ---------------------------------------------------------------------------

test('perception finds a patch, remembers where it is, and stamps its beliefs', () => {
  const world = withSward(quietWorld())
  const rabbit = spawnEntity(world, 'rabbit', 30, 24)
  run(world, 2.5)
  const belief = rabbit.belief
  assert.ok(belief !== undefined, 'the animal must carry a belief record')
  assert.ok(belief.food !== null, 'a rabbit standing in a meadow must see food')
  assert.equal(typeof belief.food.t, 'number', 'a sighting must carry its timestamp')
  assert.ok(belief.food.value > 0, 'a sighting must carry a quality')
  assert.ok(belief.food.x > 0 && belief.food.y > 0, 'a sighting must carry a position')
  assert.ok(belief.home !== null, 'an animal must know where its home range is')
  assert.ok(Array.isArray(belief.sites) && belief.sites.length > 0,
    'a visit must be remembered as a foraging site')
})

test('a stale sighting expires instead of steering the animal forever', () => {
  const world = withSward(quietWorld())
  const rabbit = spawnEntity(world, 'rabbit', 30, 24)
  run(world, 1.5)
  // Plant a sighting from a minute ago: it must not survive the next scan.
  rabbit.belief.threat = { x: rabbit.x + 2, y: rabbit.y, t: world.time - 60, species: 'fox' }
  run(world, 3)
  assert.equal(rabbit.belief.threat, null, 'a minute-old predator sighting must be dropped')
})

// ---------------------------------------------------------------------------
// 3. Execution: timed bouts, completion conditions, commitment
// ---------------------------------------------------------------------------

test('intent is derived from state.id and every bout has a clock', () => {
  const world = withSward(quietWorld())
  const rabbit = spawnEntity(world, 'rabbit', 30, 24)
  run(world, 6)
  const state = rabbit.state
  assert.ok(state !== undefined, 'the animal must be inside a bout')
  assert.ok(INTENT_IDS.includes(state.id), 'state.id must be one of the intent ids, got ' + state.id)
  assert.equal(rabbit.intent, state.id, 'intent must be derived from state.id')
  assert.ok(state.until > state.since, 'a bout must have a positive duration')
  assert.ok(state.min > 0, 'a bout must have a commitment floor')
  assert.equal(typeof state.why, 'string', 'a bout must say WHICH drive opened it')
  const decision = rabbit.decision
  assert.ok(decision !== undefined, 'the animal must carry its last decision for the inspector')
  assert.ok(INTENT_IDS.includes(decision.picked), 'the last decision must name a real activity')
  assert.ok(Array.isArray(decision.alternatives), 'the last decision must record what it beat')
  assert.ok(decision.drives !== null && typeof decision.drives.hunger === 'number',
    'the last decision must record the drive levels it was made under')
})

test('no bout ends before its own commitment floor', () => {
  const world = withSward(quietWorld())
  const spawn = []
  for (let index = 0; index < 6; index++) spawn.push(spawnEntity(world, 'rabbit', 12 + index * 6, 24))
  const mins = new Map()
  let checked = 0
  const steps = Math.round(40 / TICK)
  for (let step = 0; step < steps; step++) {
    stepWorld(world, TICK)
    for (const entity of world.entities) {
      const state = entity.state
      if (state === undefined) continue
      const previous = mins.get(entity.id)
      if (previous === undefined || previous.id !== state.id) {
        if (previous !== undefined) {
          const dwell = world.time - previous.since
          assert.ok(dwell >= previous.min - 0.25,
            entity.species + ' #' + entity.id + ' left ' + previous.id + ' after ' + dwell.toFixed(2)
            + ' s (seen from t=' + previous.since.toFixed(2) + ', floor ' + previous.min + ' s) for '
            + String(entity.intent) + ' because ' + String(entity.state === undefined ? 'none' : entity.state.why))
          checked += 1
        }
        mins.set(entity.id, { id: state.id, since: Math.min(world.time, state.since), min: state.min })
      }
    }
  }
  assert.ok(checked > 3, 'the soak must have observed real bout transitions, saw ' + checked)
})

test('rest is a thing the animal does, not where it lives', () => {
  const world = withSward(quietWorld())
  for (let index = 0; index < 8; index++) spawnEntity(world, 'rabbit', 10 + index * 5, 12)
  for (let index = 0; index < 4; index++) spawnEntity(world, 'deer', 20 + index * 8, 34)
  const budget = new Map()
  let entitySeconds = 0
  const steps = Math.round(60 / TICK)
  for (let step = 0; step < steps; step++) {
    stepWorld(world, TICK)
    for (const entity of world.entities) {
      const intent = entity.state === undefined ? entity.intent : entity.state.id
      budget.set(intent, (budget.get(intent) ?? 0) + TICK)
      entitySeconds += TICK
    }
  }
  const rest = (budget.get('rest') ?? 0) / entitySeconds
  assert.ok(entitySeconds > 400, 'the sample must cover real entity time')
  assert.ok(rest < 0.35, 'rest must be a minority of the time budget, got ' + (rest * 100).toFixed(1) + '%')
  assert.ok(rest > 0, 'rest must still happen: a world with no rest is a treadmill')
})

// ---------------------------------------------------------------------------
// 4. Determinism and the single death exit
// ---------------------------------------------------------------------------

test('the same seed replays the same behaviour', () => {
  const fingerprint = (seed) => {
    const world = withSward(quietWorld({ seed }))
    for (let index = 0; index < 10; index++) {
      spawnEntity(world, 'rabbit', 8 + index * 5, 10 + (index % 4) * 6)
      spawnEntity(world, index % 3 === 0 ? 'deer' : 'crow', 14 + index * 4, 30)
    }
    run(world, 20)
    return world.entities.map(entity => [
      entity.id,
      Math.round(entity.x * 1000) / 1000,
      Math.round(entity.y * 1000) / 1000,
      entity.intent,
      entity.state === undefined ? null : Math.round(entity.state.until * 1000) / 1000,
      entity.body === undefined ? null : Math.round(entity.body.E * 1000) / 1000,
    ].join('|')).join(';')
  }
  assert.equal(fingerprint(4242), fingerprint(4242), 'the same seed must replay the same behaviour')
})

test('a death records its cause', () => {
  const world = withSward(quietWorld())
  const old = spawnEntity(world, 'rabbit', 30, 24)
  old.age = SPECIES.rabbit.genes.lifespan[1] + 5
  stepWorld(world, TICK)
  const cause = old.body === undefined ? old.cause : old.body.cause
  assert.equal(typeof cause, 'string', 'a death must write a cause')
  assert.ok(cause.length > 0, 'a death must write a non-empty cause')
  assert.equal(old.fate, 'dead', 'the dead animal must be flagged')
  assert.ok(world.corpses.length >= 1, 'a death must leave a carcass')
})
