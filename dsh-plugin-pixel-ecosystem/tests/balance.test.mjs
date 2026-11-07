/**
 * Balance soak (DESIGN.md §3, §8).
 *
 * What this pins and why: the whole point of the sandbox is that you can leave
 * it running for a long session and come back to a living world. A 20 000-tick
 * soak (2 000 in-world seconds ≈ 16.7 days of 1× time at 120 s/day) on a fixed
 * seed is the cheapest way to catch a food web that quietly collapses or
 * explodes. The bands below are the v0.1 targets: a species that hits zero is a
 * dead chain, and a species that runs past the top of its band is a bloom that
 * starves everything else out one generation later.
 *
 * The soak runs once and the checks share its result, so the suite stays inside
 * its time budget: one world, one 20k-tick pass, ~15 s on this machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const { SPECIES, SPECIES_IDS, TERRAIN, TICK, createWorld, stepWorld, sampleStats } = engine

/** Fixed seed, so a regression is reproducible instead of a coin flip. */
const SEED = 777
/** Ticks in the soak; one tick is `TICK` seconds. */
const TICKS = 20_000
/** How often the populations are sampled. */
const SAMPLE_EVERY = 1_000
/**
 * A species that never reaches this peak during the soak is not really alive:
 * its chain does not work, and the sandbox would look empty even if the counter
 * never happens to read zero at a checkpoint.
 */
// Peaks are measured over a short run on a 640x400 world that now charges every
// animal for travelling to water and to resting spots, so the equilibrium sits
// lower than in the 320x200 build. The floor only has to prove a species can
// build a breeding population, not that it fills its cap.
const VIABLE_PEAK = { rabbit: 120, deer: 25, fox: 12, wolf: 5, crow: 18, fish: 55, pike: 5 }
/**
 * How many checkpoints a species may read zero while immigration rescues it.
 * The migration net fires every 25–45 world seconds, i.e. every 0.25–0.45 of a
 * 1000-tick checkpoint: one or two zero samples are a rescued crash, more means
 * the safety net is broken and the world really did die.
 */
const MAX_ZERO_CHECKPOINTS = 2
/** Minimum share of a producer's own terrain that must stay vegetated. */
const MIN_COVER = 0.03

/** Cached soak result, so the four assertions below share one simulation. */
let cachedSoak = null

/**
 * Run the soak once: step the world, snapshot the counters at every checkpoint.
 * @returns {{
 *   world: object, area: { grass: number, water: number },
 *   checkpoints: object[], elapsedMs: number,
 * }} the finished run.
 */
function soak() {
  if (cachedSoak !== null) return cachedSoak
  const world = createWorld({ seed: SEED })
  const area = { grass: 0, water: 0 }
  for (const cell of world.terrain) {
    if (cell === TERRAIN.GRASS) area.grass += 1
    else if (cell === TERRAIN.WATER) area.water += 1
  }
  const checkpoints = []
  const started = performance.now()
  for (let tick = 1; tick <= TICKS; tick++) {
    stepWorld(world, TICK)
    if (tick % SAMPLE_EVERY !== 0) continue
    const stats = sampleStats(world)
    checkpoints.push({
      tick,
      counts: { ...stats.counts },
      grass: stats.grass,
      weed: stats.weed,
    })
  }
  const elapsedMs = performance.now() - started
  cachedSoak = { world, area, checkpoints, elapsedMs }
  const summary = SPECIES_IDS
    .map(id => {
      const values = checkpoints.map(point => point.counts[id])
      return `${id} ${Math.min(...values)}..${Math.max(...values)}`
    })
    .join('  ')
  console.log(`soak seed ${SEED}: ${(TICKS / (elapsedMs / 1000)).toFixed(0)} ticks/s | ${summary}`)
  return cachedSoak
}

test('no species stays extinct and every chain reaches a viable peak', () => {
  const { checkpoints } = soak()
  assert.equal(checkpoints.length, TICKS / SAMPLE_EVERY, 'the soak must report every checkpoint')
  for (const id of SPECIES_IDS) {
    const values = checkpoints.map(point => point.counts[id])
    const zeros = values.filter(value => value === 0).length
    const peak = Math.max(...values)
    // Predator-prey cycles are the point of the sandbox: a trough is fine, being
    // wiped out for good is not. The migration net must catch every crash.
    assert.ok(zeros <= MAX_ZERO_CHECKPOINTS,
      `${id} read zero at ${zeros} of ${values.length} checkpoints — the migration net is not rescuing it`)
    assert.ok(peak >= VIABLE_PEAK[id],
      `${id} never reached its viable peak: peak ${peak} < ${VIABLE_PEAK[id]}`)
    assert.ok(values[values.length - 1] > 0, `${id} ended the soak extinct`)
  }
})

test('no population runs past its species cap (no runaway bloom)', () => {
  const { checkpoints } = soak()
  for (const id of SPECIES_IDS) {
    const cap = SPECIES[id].cap
    for (const point of checkpoints) {
      assert.ok(point.counts[id] <= cap,
        `${id} exceeded its cap ${cap} at tick ${point.tick}: ${point.counts[id]}`)
    }
  }
})

test('grass and weed keep at least 3% cover of their own terrain', () => {
  const { checkpoints, area } = soak()
  assert.ok(area.grass > 0 && area.water > 0, 'the generated world must have both grassland and water')
  for (const point of checkpoints) {
    const grassShare = point.grass / area.grass
    const weedShare = point.weed / area.water
    assert.ok(grassShare >= MIN_COVER,
      `grass cover fell to ${(grassShare * 100).toFixed(1)}% of ${area.grass} land cells at tick ${point.tick}`)
    assert.ok(weedShare >= MIN_COVER,
      `weed cover fell to ${(weedShare * 100).toFixed(1)}% of ${area.water} water cells at tick ${point.tick}`)
  }
})

test('the engine sustains the 8x speed budget', () => {
  const { elapsedMs } = soak()
  const ticksPerSecond = TICKS / (elapsedMs / 1000)
  // 8x playback needs 10 ticks per second; require an 8x margin over that.
  assert.ok(ticksPerSecond > 80,
    `the soak ran at ${ticksPerSecond.toFixed(0)} ticks/s, below the 80 ticks/s (8x) budget`)
})
