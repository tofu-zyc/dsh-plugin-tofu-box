/**
 * A truncated or hand-edited save must fail loudly.
 *
 * It used to load as a world with a valid map and zero animals, which reads to
 * the player as "my terrarium vanished" with no explanation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const { createWorld, serializeWorld, deserializeWorld } = engine

test('a non-array entity list is rejected instead of becoming an empty world', () => {
  const saved = serializeWorld(createWorld({ seed: 5, width: 48, height: 32 }))
  for (const field of ['entities', 'corpses', 'trees']) {
    const broken = { ...saved, [field]: 'not-an-array' }
    assert.throws(() => deserializeWorld(broken), /corrupt|world save/i, field + ' must be rejected')
  }
})

test('a save that simply omits a list still loads (older payloads)', () => {
  const saved = serializeWorld(createWorld({ seed: 5, width: 48, height: 32 }))
  const lean = { ...saved }
  delete lean.corpses
  delete lean.caches
  const world = deserializeWorld(lean)
  assert.ok(world.entities.length > 0, 'the animals must survive')
  assert.equal(world.corpses.length, 0, 'a missing corpse list is empty, not fatal')
})
