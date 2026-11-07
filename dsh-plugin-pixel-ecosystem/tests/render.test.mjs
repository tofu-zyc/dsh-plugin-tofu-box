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
  createWorld, spawnEntity, paintWorld,
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

test('an animal at the frame edge is clipped instead of writing outside the buffer', () => {
  const sprite = SPRITES.rabbit.idle
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
    const minX = Math.max(0, left)
    const maxX = Math.min(world.width - 1, left + sprite.width - 1)
    const minY = Math.max(0, top)
    const maxY = Math.min(world.height - 1, top + sprite.height - 1)
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
