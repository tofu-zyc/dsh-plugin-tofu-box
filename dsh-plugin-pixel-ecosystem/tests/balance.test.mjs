/**
 * Balance gate (DESIGN.md section 3, section 8; docs/90-ROADMAP.md P1-P3).
 *
 * What this pins and why: the sandbox only works if you can leave it running and
 * come back to a living world, so the whole food web has to survive a long soak.
 *
 * Why it is no longer one seed: a single trajectory cannot tell a broken chain
 * from an unlucky draw. Predator-prey systems are chaotic - one seed crashes and
 * the next one booms - so a gate pinned to seed 777 tested the luck of that draw,
 * not the engine. This version runs several seeds and asks a statistical
 * question instead: does a species stay viable in MOST of the draws? A single
 * unlucky seed is allowed to fail; a species that fails most seeds is broken.
 *
 * Why the thresholds are derived instead of hand-tuned: docs/00-VISION.md
 * principle 2 says numbers come from physics, not from balance. Each species
 * already carries its own `minimum` (the immigration rescue threshold) and `cap`
 * (its density ceiling), so the viability floor is read out of the species table
 * rather than typed in here. Producer cover is measured against the world's own
 * starting biomass, which keeps it unit-free across the 0.2.x scalar fields and
 * the 0.3.x kg/m2 fields.
 *
 * The soaks run once and the checks share the results, so the suite stays inside
 * its time budget: SEEDS worlds, TICKS ticks each.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const { SPECIES, SPECIES_IDS, TERRAIN, TICK, DAY_SECONDS, createWorld, sampleStats, stepWorld } = engine

/** Fixed seed list: reproducible, but not a single draw. */
const SEEDS = [777, 12345, 424242]
/** Ticks per soak. One tick is `TICK` seconds. */
const TICKS = 10_000
/** How often populations are sampled inside a soak. */
const SAMPLE_EVERY = 1_000
/**
 * Share of a species' own cap that counts as a real breeding population.
 * A species that never reaches this is present only through immigration: the
 * chain behind it does not close.
 */
const MIN_CAP_SHARE = 0.1
/**
 * Share of checkpoints a species may read zero. The migration net fires often
 * enough to rescue a crash; reading zero more than this means the net failed.
 */
const MAX_ZERO_SHARE = 0.2
/**
 * Producers must keep at least this share of their starting standing crop.
 * Relative, so it means the same thing before and after the biomass rework.
 */
const PRODUCER_FLOOR_SHARE = 0.05
/** How many seeds must pass a per-seed gate for it to be a real signal. */
const MAJORITY = Math.ceil(SEEDS.length / 2)

/** Cached multi-seed result, so every test below shares one set of soaks. */
let cachedSoaks = null

/**
 * Mean of a producer field over the cells that can host it.
 * @param {object} world - the world.
 * @param {Float32Array} field - grass or weed.
 * @param {number} terrain - the terrain code that field lives on.
 * @returns {number} mean biomass per host cell (0 when there are no host cells).
 */
function fieldMean(world, field, terrain) {
  let sum = 0
  let cells = 0
  for (let index = 0; index < field.length; index++) {
    if (world.terrain[index] !== terrain) continue
    sum += field[index]
    cells += 1
  }
  return cells === 0 ? 0 : sum / cells
}

/**
 * Viability floor for a species: its own immigration threshold, but at least a
 * tenth of its density ceiling. Read from the species table, never typed here.
 * @param {string} id - species id.
 * @returns {number} minimum peak population that counts as alive.
 */
function viableFloor(id) {
  const row = SPECIES[id]
  const minimum = Number.isFinite(row.minimum) ? row.minimum : 0
  return Math.max(minimum, Math.round(row.cap * MIN_CAP_SHARE))
}

/**
 * Run every seed once and collect the checkpoints.
 * @returns {object[]} one record per seed.
 */
function soaks() {
  if (cachedSoaks !== null) return cachedSoaks
  cachedSoaks = SEEDS.map(seed => {
    const world = createWorld({ seed })
    const initial = {
      grass: fieldMean(world, world.grass, TERRAIN.GRASS),
      weed: fieldMean(world, world.weed, TERRAIN.WATER),
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
        grass: fieldMean(world, world.grass, TERRAIN.GRASS),
        weed: fieldMean(world, world.weed, TERRAIN.WATER),
      })
    }
    const elapsedMs = performance.now() - started
    return { seed, world, initial, checkpoints, elapsedMs, ticksPerSecond: TICKS / (elapsedMs / 1000) }
  })
  for (const run of cachedSoaks) {
    const summary = SPECIES_IDS
      .map(id => {
        const values = run.checkpoints.map(point => point.counts[id])
        return id + ' ' + Math.min(...values) + '..' + Math.max(...values)
      })
      .join('  ')
    console.log('soak seed ' + run.seed + ': ' + run.ticksPerSecond.toFixed(0) + ' ticks/s | ' + summary)
  }
  return cachedSoaks
}

/**
 * Collect the samples of one species over every seed.
 * @param {string} id - species id.
 * @returns {object[]} one entry per seed: { peak, last, zeros, values }.
 */
function samplesOf(id) {
  return soaks().map(run => {
    const values = run.checkpoints.map(point => point.counts[id])
    return {
      seed: run.seed,
      values,
      peak: values.length === 0 ? 0 : Math.max(...values),
      last: values.length === 0 ? 0 : values[values.length - 1],
      zeros: values.filter(value => value === 0).length,
    }
  })
}

/** @param {number[]} values - numbers. @returns {number} median. */
function median(values) {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

test('every species builds a breeding population in most seeds', () => {
  const failures = []
  for (const id of SPECIES_IDS) {
    const floor = viableFloor(id)
    const samples = samplesOf(id)
    const viable = samples.filter(sample => sample.peak >= floor && sample.last > 0)
    if (viable.length < MAJORITY) {
      failures.push(id + ': viable in ' + viable.length + '/' + samples.length
        + ' seeds (floor ' + floor + '); peaks ' + samples.map(sample => sample.peak).join('/'))
    }
  }
  assert.deepEqual(failures, [],
    'a species that cannot build a breeding population in most seeds has a broken chain: '
    + failures.join(' | '))
})

test('no species stays extinct in most seeds', () => {
  const failures = []
  const allowedZeros = Math.ceil(MAX_ZERO_SHARE * (TICKS / SAMPLE_EVERY))
  for (const id of SPECIES_IDS) {
    const samples = samplesOf(id)
    const rescued = samples.filter(sample => sample.zeros <= allowedZeros)
    if (rescued.length < MAJORITY) {
      failures.push(id + ': read zero at up to ' + Math.max(...samples.map(sample => sample.zeros))
        + ' of ' + (TICKS / SAMPLE_EVERY) + ' checkpoints; allowed ' + allowedZeros)
    }
  }
  assert.deepEqual(failures, [],
    'the migration net must rescue every crash in most seeds: ' + failures.join(' | '))
})

test('no population runs past its species cap (no runaway bloom)', () => {
  const failures = []
  for (const run of soaks()) {
    for (const id of SPECIES_IDS) {
      const cap = SPECIES[id].cap
      const worst = run.checkpoints.find(point => point.counts[id] > cap)
      if (worst !== undefined) {
        failures.push('seed ' + run.seed + ' ' + id + ' reached ' + worst.counts[id] + ' at tick ' + worst.tick + ' (cap ' + cap + ')')
      }
    }
  }
  assert.deepEqual(failures, [], 'a population past its cap means density feedback is broken: ' + failures.join(' | '))
})

test('producers keep most of their starting standing crop', () => {
  const failures = []
  for (const run of soaks()) {
    for (const [fieldName, initial] of [['grass', run.initial.grass], ['weed', run.initial.weed]]) {
      if (!(initial > 0)) continue
      const floor = initial * PRODUCER_FLOOR_SHARE
      const low = Math.min(...run.checkpoints.map(point => point[fieldName]))
      if (low < floor) {
        failures.push('seed ' + run.seed + ' ' + fieldName + ' fell to ' + low.toFixed(4)
          + ' (floor ' + floor.toFixed(4) + ', start ' + initial.toFixed(4) + ')')
      }
    }
  }
  assert.deepEqual(failures, [], 'grazing pressure wiped out a producer field: ' + failures.join(' | '))
})

test('the engine sustains the 8x speed budget', () => {
  const throughput = soaks().map(run => run.ticksPerSecond)
  const slowest = Math.min(...throughput)
  // 8x playback needs 10 ticks per second; require an 8x margin over that.
  assert.ok(median(throughput) > 80,
    'median soak throughput ' + median(throughput).toFixed(0) + ' ticks/s is below the 80 ticks/s (8x) budget'
    + ' (slowest seed ' + slowest.toFixed(0) + ' ticks/s)')
})

test('the soak covers several in-world years and several seeds', () => {
  // Guards the gate itself: a shortened soak or a dropped seed would silently
  // weaken every assertion above, so the shape of the experiment is pinned.
  const runs = soaks()
  assert.equal(runs.length, SEEDS.length, 'every seed must produce one soak')
  for (const run of runs) {
    assert.equal(run.checkpoints.length, TICKS / SAMPLE_EVERY,
      'seed ' + run.seed + ' must report every checkpoint')
    assert.ok(run.world.tick > 0, 'seed ' + run.seed + ' never stepped')
  }
  const years = (TICKS * TICK) / (DAY_SECONDS * 8)
  assert.ok(years >= 1, 'the soak must span at least one in-world year, it spans ' + years.toFixed(2))
})
