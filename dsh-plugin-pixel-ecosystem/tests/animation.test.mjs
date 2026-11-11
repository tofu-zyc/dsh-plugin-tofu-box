/**
 * Animation contract: the shipped atlas, the slot table and the gait phase.
 *
 * What this pins and why: the whole point of the pixel-model pipeline is that
 * the artwork and the slot table cannot drift apart. The atlas is embedded as
 * base64 inside the bundle, so rebuilding the PNG and forgetting to re-embed it
 * is a silent failure that shows up as wrong or missing frames in the browser.
 * The PNG header is parsed here and checked against ATLAS and ATLAS_SLOTS,
 * which catches exactly that.
 *
 * The second half pins the gait: the run cycle is four frames selected from the
 * distance an animal has travelled, so a test can prove that a moving animal
 * visits all four frames and a standing one does not flicker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const { ATLAS, ATLAS_SLOTS, ATLAS_SIZE, ATLAS_GAIT, SPECIES_IDS, SPRITE_ATLAS_PNG } = engine

/** The embedded PNG, decoded out of the bundle. */
const atlasBytes = Buffer.from(SPRITE_ATLAS_PNG, 'base64')

test('the embedded atlas is a PNG whose pixel size matches the slot table', () => {
  assert.equal(atlasBytes.subarray(1, 4).toString('latin1'), 'PNG', 'the embedded data must be a PNG')
  const width = atlasBytes.readUInt32BE(16)
  const height = atlasBytes.readUInt32BE(20)
  const slots = []
  for (const id of SPECIES_IDS) {
    for (const slot of [...ATLAS_SLOTS[id].idle, ...ATLAS_SLOTS[id].run]) slots.push(slot)
  }
  const rows = Math.floor(Math.max(...slots) / ATLAS.columns) + 1
  assert.equal(width, ATLAS.columns * ATLAS.cellWidth, 'atlas width must be columns * cell width')
  assert.ok(height >= rows * ATLAS.cellHeight,
    'atlas is ' + height + 'px tall but the slot table needs ' + rows + ' rows of ' + ATLAS.cellHeight + 'px; rebuild and re-embed the atlas')
})

test('every species has two idle frames and a four-frame gait cycle', () => {
  assert.deepEqual(Object.keys(ATLAS_SLOTS).sort(), [...SPECIES_IDS].sort(),
    'the atlas must cover exactly the species table')
  const seen = new Set()
  for (const id of SPECIES_IDS) {
    const slots = ATLAS_SLOTS[id]
    assert.equal(slots.idle.length, 2, id + ' needs two idle frames')
    assert.equal(slots.run.length, 4, id + ' needs a four-frame run cycle')
    for (const slot of [...slots.idle, ...slots.run]) {
      assert.ok(Number.isInteger(slot) && slot >= 0, id + ' has a bogus atlas slot: ' + slot)
      assert.ok(!seen.has(slot), 'atlas slot ' + slot + ' is used twice')
      seen.add(slot)
    }
    assert.ok(ATLAS_SIZE[id] > 0, id + ' needs a display size')
    assert.ok(ATLAS_GAIT[id] > 0, id + ' needs a gait rate')
  }
})

test('a moving animal visits all four gait frames and a resting one does not', () => {
  const world = engine.createWorld({ seed: 12, width: 64, height: 48, immigration: false })
  const rabbit = engine.spawnEntity(world, 'rabbit', 32, 24)
  rabbit.thinkTimer = 999
  rabbit.intent = 'explore'
  rabbit.targetX = 62
  rabbit.targetY = 24
  const seen = new Set()
  let last = rabbit.gait
  let changes = 0
  for (let tick = 0; tick < 60; tick++) {
    engine.stepWorld(world, engine.TICK)
    seen.add(Math.min(3, Math.floor((rabbit.gait ?? 0) * 4)))
    if (rabbit.gait !== last) changes += 1
    last = rabbit.gait
  }
  assert.ok(changes > 10, 'the gait phase must advance while the animal moves, got ' + changes + ' changes')
  assert.equal(seen.size, 4, 'the gait must visit every frame index, saw ' + [...seen].join(','))

  // A quiet world: the decision system lets fear interrupt a rest through the
  // think timer by design, so a predator two cells away would make this a test
  // of the interrupt rule instead of a test of the gait.
  const quiet = Object.fromEntries(engine.SPECIES_IDS.map(id => [id, 0]))
  const calm = engine.createWorld({ seed: 13, width: 64, height: 48, stocks: quiet, immigration: false })
  const resting = engine.spawnEntity(calm, 'rabbit', 32, 24)
  resting.intent = 'rest'
  resting.thinkTimer = 999
  resting.targetX = 32
  resting.targetY = 24
  resting.gait = 0
  const before = resting.gait
  for (let tick = 0; tick < 20; tick++) engine.stepWorld(calm, engine.TICK)
  assert.equal(resting.gait, before, 'a resting animal must not advance its gait')
})
test('every behaviour state resolves to a frame set, unknown ids fall back to idle', () => {
  const world = engine.createWorld({ seed: 3, width: 48, height: 40, immigration: false })
  const rabbit = engine.spawnEntity(world, 'rabbit', 20, 20)
  rabbit.heading = 0
  rabbit.phase = 0
  rabbit.running = false
  rabbit.fleeing = false
  const setIdle = engine.SPRITES.rabbit.idle
  const setFlee = engine.SPRITES.rabbit.flee
  const walkFrames = new Set(engine.SPRITES.rabbit.walk)
  const standing = ['idle', 'alert', 'graze', 'eat', 'forage', 'browse', 'drink', 'rest', 'sleep',
    'bask', 'bury', 'ambush', 'cold', 'shiver', 'freeze', 'huddle', 'mate', 'birth']
  const walking = ['stalk', 'sneak', 'hoard', 'cache', 'wander', 'explore', 'patrol', 'walk',
    'travel', 'migrate', 'scavenge', 'court', 'socialize', 'follow']
  const running = ['hunt', 'chase', 'strike', 'flee', 'fight', 'play']
  for (const id of standing) {
    rabbit.state = { id }
    assert.equal(engine.frameFor(rabbit, 7), setIdle, `state "${id}" must show an idle frame`)
  }
  for (const id of walking) {
    rabbit.state = { id }
    assert.ok(walkFrames.has(engine.frameFor(rabbit, 7)), `state "${id}" must show a walk frame`)
  }
  for (const id of running) {
    rabbit.state = { id }
    assert.equal(engine.frameFor(rabbit, 7), setFlee, `state "${id}" must show the run frame`)
  }
  rabbit.state = { id: 'glorp' }
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'an unknown state must fall back to idle')
  rabbit.state = { id: 'sleeping-bag' }
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'an unknown multi-word state must fall back to idle')
})

test('state ids may be decorated, and the legacy intent field still drives the pose', () => {
  const world = engine.createWorld({ seed: 4, width: 48, height: 40, immigration: false })
  const rabbit = engine.spawnEntity(world, 'rabbit', 20, 20)
  rabbit.heading = 0
  rabbit.phase = 0
  rabbit.running = false
  rabbit.fleeing = false
  const setIdle = engine.SPRITES.rabbit.idle
  const walkFrames = new Set(engine.SPRITES.rabbit.walk)
  rabbit.state = { id: 'eat:grass' }
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'a decorated eating id must still show the eating pose')
  rabbit.state = { id: 'hoard_cache' }
  assert.ok(walkFrames.has(engine.frameFor(rabbit, 7)), 'a decorated hoarding id must still walk')
  delete rabbit.state
  rabbit.intent = 'hunt'
  assert.equal(engine.frameFor(rabbit, 7), engine.SPRITES.rabbit.flee, 'the legacy intent must still pick the run pose')
  rabbit.intent = 'rest'
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'the legacy rest intent must stand still')
  rabbit.state = { id: 'graze' }
  rabbit.fleeing = true
  assert.equal(engine.frameFor(rabbit, 7), engine.SPRITES.rabbit.flee, 'flight overrides any standing pose')
})

test('a paused pose holds one frame, a moving pose cycles', () => {
  const world = engine.createWorld({ seed: 5, width: 48, height: 40, immigration: false })
  const rabbit = engine.spawnEntity(world, 'rabbit', 20, 20)
  rabbit.heading = 0
  rabbit.phase = 0
  rabbit.running = false
  rabbit.fleeing = false
  rabbit.state = { id: 'sleep' }
  const asleepFirst = engine.frameFor(rabbit, 0)
  const asleepLater = engine.frameFor(rabbit, 91)
  assert.equal(asleepFirst, asleepLater, 'a sleeping animal must not flicker between frames')
  rabbit.state = { id: 'stalk' }
  const phases = new Set()
  for (let tick = 0; tick < 16; tick++) phases.add(engine.frameFor(rabbit, tick))
  assert.ok(phases.size > 1, 'a stalking animal must keep its legs moving')
})
test('a bout phase picks the pose: approach walks, do settles, handling bends the head down', () => {
  const quiet = Object.fromEntries(engine.SPECIES_IDS.map(id => [id, 0]))
  const world = engine.createWorld({ seed: 6, width: 48, height: 40, stocks: quiet, immigration: false })
  const rabbit = engine.spawnEntity(world, 'rabbit', 20, 20)
  rabbit.heading = 0
  rabbit.phase = 0
  rabbit.running = false
  rabbit.fleeing = false
  const setIdle = engine.SPRITES.rabbit.idle
  const walkFrames = new Set(engine.SPRITES.rabbit.walk)
  rabbit.state = { id: 'forage', phase: 'do' }
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'eating at the patch must be a head-down pose')
  rabbit.state = { id: 'forage', phase: 'approach' }
  assert.ok(walkFrames.has(engine.frameFor(rabbit, 7)), 'walking to the patch must be a moving pose')
  rabbit.state = { id: 'hunt', phase: 'do' }
  rabbit.handling = true
  assert.equal(engine.frameFor(rabbit, 7), setIdle, 'a kill being worked through must be head down, not a run')
  rabbit.handling = false
  rabbit.state = { id: 'socialize', phase: 'do' }
  rabbit.drives = { libido: 0.8 }
  assert.ok(walkFrames.has(engine.frameFor(rabbit, 7)), 'a receptive animal courts on the move')
  rabbit.drives = { libido: 0.1 }
  assert.ok(walkFrames.has(engine.frameFor(rabbit, 7)), 'a non-receptive animal still socialises')
})

test('an ambusher stalks in and strikes, a chaser runs', () => {
  const quiet = Object.fromEntries(engine.SPECIES_IDS.map(id => [id, 0]))
  const world = engine.createWorld({ seed: 7, width: 48, height: 40, stocks: quiet, immigration: false })
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < 8; x++) world.terrain[y * world.width + x] = engine.TERRAIN.WATER
  }
  const pike = engine.spawnEntity(world, 'pike', 4, 20)
  assert.ok(pike !== null, 'the pike must spawn in the water strip')
  pike.heading = 0
  pike.phase = 0
  pike.running = false
  pike.fleeing = false
  pike.state = { id: 'hunt', phase: 'approach' }
  const stalk = engine.frameFor(pike, 7)
  assert.ok(new Set(engine.SPRITES.pike.walk).has(stalk), 'an ambusher approaches on the slow gait, not a run')
  pike.state = { id: 'hunt', phase: 'do' }
  assert.equal(engine.frameFor(pike, 7), engine.SPRITES.pike.flee, 'the strike itself is the fast pose')
  const wolf = engine.spawnEntity(world, 'wolf', 30, 20)
  wolf.heading = 0
  wolf.phase = 0
  wolf.running = false
  wolf.fleeing = false
  wolf.state = { id: 'hunt', phase: 'approach' }
  assert.equal(engine.frameFor(wolf, 7), engine.SPRITES.wolf.flee, 'a chaser runs its prey down')
})
