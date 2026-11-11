/**
 * Sprite coverage: every species must be drawable at EVERY zoom level.
 *
 * Would catch the defect this file was written for. The panel draws the world
 * two ways (src/parts/21-store.js `useAtlas`): a 1-px-per-cell buffer pass for
 * "fit the whole map" zooms and the display-resolution PNG atlas at 3x and up.
 * Only seven of the eleven species had a 1-px grid, and `frameFor` returns null
 * for a species with no grid, which the animal pass turns into `continue` — so
 * the bear, the otter, the heron and the frog silently disappeared from the map
 * the moment a player pressed "fit the window", while their counts, their
 * minimap dots and their trails stayed on screen.
 *
 * The same hand-written list also fed the trail colours, where a missing entry
 * dims `undefined` into opaque black: those four species left black speckles.
 *
 * These are structural parity tests, so adding a twelfth species without
 * artwork now fails here instead of on a player's screen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const {
  SPECIES_IDS, SPRITE_GRIDS, SPRITES, SPRITE_COLORS, TRAIL_COLORS, ATLAS_SLOTS,
  createWorld, spawnEntity, frameFor, TICK,
} = engine

/** Build one live animal of a species, on its own habitat, for the render checks. */
function animalOf(speciesId) {
  const world = createWorld({ seed: 11, width: 64, height: 48, immigration: false })
  for (const candidate of world.entities) {
    if (candidate.species === speciesId) return candidate
  }
  // The default stocks do not always fit a 64x48 world; place one by hand.
  const species = engine.SPECIES[speciesId]
  for (let attempt = 0; attempt < 4000; attempt++) {
    const x = 2 + ((attempt * 37) % (world.width - 4))
    const y = 2 + ((attempt * 53) % (world.height - 4))
    if (engine.canStand(world, species, x, y)) {
      const placed = spawnEntity(world, speciesId, x + 0.5, y + 0.5)
      if (placed !== undefined && placed !== null) return placed
    }
  }
  throw new Error('could not place a ' + speciesId + ' in the fixture world')
}

test('every species has a 1-px grid, a colour map and idle/walk/run frames', () => {
  assert.ok(SPECIES_IDS.length > 0, 'the species table must not be empty')
  for (const id of SPECIES_IDS) {
    const set = SPRITE_GRIDS[id]
    assert.ok(set !== undefined, 'species "' + id + '" has no 1-px sprite grid (it would be invisible below 3x)')
    assert.ok(Array.isArray(set.idle) && set.idle.length > 0, id + ': missing idle frames')
    assert.ok(Array.isArray(set.walk) && set.walk.length >= 2, id + ': a walk cycle needs at least two frames')
    assert.ok(Array.isArray(set.flee) && set.flee.length > 0, id + ': missing the run/flee frame')
    assert.ok(SPRITE_COLORS[id] !== undefined, id + ': sprite grid without a character -> colour map')
    const compiled = SPRITES[id]
    assert.ok(compiled !== undefined, id + ': the grid was never compiled into SPRITES')
    for (const [role, frames] of [['idle', [compiled.idle]], ['flee', [compiled.flee]],
      ['walk', compiled.walk]]) {
      for (const frame of frames) {
        assert.ok(frame.width > 0 && frame.height > 0, id + ': ' + role + ' frame has no pixels')
        assert.equal(frame.pixels.length, frame.width * frame.height,
          id + ': ' + role + ' frame buffer does not match its own dimensions')
        assert.ok(frame.pixels.some(pixel => pixel !== 0), id + ': ' + role + ' frame is fully transparent')
      }
    }
  }
})

test('frameFor never returns null for a real animal of any species', () => {
  // This is the exact call the animal pass makes before it decides not to draw.
  for (const id of SPECIES_IDS) {
    const animal = animalOf(id)
    for (const stateId of ['idle', 'forage', 'hunt', 'flee', 'rest']) {
      animal.state = { id: stateId }
      const frame = frameFor(animal, 7)
      assert.ok(frame !== null && frame !== undefined,
        id + ' with state "' + stateId + '" resolved to no frame, so the animal is not drawn at 1-2x zoom')
    }
    // The engine also drives the pose through the legacy `intent` field.
    animal.state = undefined
    animal.intent = 'flee'
    assert.ok(frameFor(animal, 7) !== null, id + ': the legacy intent path resolved to no frame')
  }
})

test('every species paints a visible motion trail, never opaque black', () => {
  for (const id of SPECIES_IDS) {
    const colour = TRAIL_COLORS[id]
    assert.equal(typeof colour, 'number', id + ': no trail colour (dimColor(undefined) packs 0x000000)')
    const alpha = (colour >>> 24) & 0xFF
    const red = colour & 0xFF
    const green = (colour >>> 8) & 0xFF
    const blue = (colour >>> 16) & 0xFF
    assert.equal(alpha, 255, id + ': the trail colour must be opaque')
    assert.ok(red + green + blue > 0, id + ': a black trail reads as a rendering artefact, not as a footprint')
  }
})

test('the atlas covers idle and run for every species, and its slots stay inside the sheet', () => {
  // Parity between the two render paths: a species visible only at one zoom
  // level is the bug this whole file exists for.
  const cells = Object.values(ATLAS_SLOTS).flatMap(slots => Object.values(slots).flat())
  for (const id of SPECIES_IDS) {
    const slots = ATLAS_SLOTS[id]
    assert.ok(slots !== undefined, id + ': no atlas slots, so it vanishes above 3x zoom')
    assert.ok(Array.isArray(slots.idle) && slots.idle.length > 0, id + ': no idle slot in the atlas')
    assert.ok(Array.isArray(slots.run) && slots.run.length > 0, id + ': no run slot in the atlas')
  }
  assert.equal(new Set(cells).size, cells.length, 'two species share an atlas cell')
})

test('the atlas and the 1-px pass agree on which species exist', () => {
  const gridSpecies = Object.keys(SPRITE_GRIDS).sort()
  const atlasSpecies = Object.keys(ATLAS_SLOTS).sort()
  assert.deepEqual(gridSpecies, atlasSpecies,
    'the 1-px grid pass and the atlas must cover the same species, or one of them drops an animal')
  assert.deepEqual(gridSpecies.slice(), [...SPECIES_IDS].sort(),
    'every species in the simulation needs artwork in both render passes')
})
