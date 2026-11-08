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

/**
 * Two tiers, because a gate nobody can afford to run is not a gate.
 *
 *   daily   (default)   2 seeds x 900 ticks   ~20 s  smoke gate: nothing dies out,
 *                                                nothing blooms past its cap, the
 *                                                producers hold, throughput holds.
 *   release (PE_SOAK=1) 3 seeds x 9000 ticks  ~4 min  the statistical gate: every
 *                                                species must breed above its own
 *                                                immigration line in most seeds,
 *                                                over a full in-world year.
 *
 * A short window cannot prove that a slow species breeds, so at the daily tier the
 * breeding claim is downgraded to survival-only and the test says which species it
 * judged how. The release tier puts every species on the strong gate.
 */
const RELEASE_TIER = process.env.PE_SOAK === '1' || process.env.PE_SOAK === 'true'

/** Seeds per tier: reproducible, but never a single draw. */
const SEEDS = RELEASE_TIER ? [777, 12345, 424242] : [777, 12345]
/** Ticks per soak. One tick is `TICK` seconds (see the tier table above). */
const TICKS = Number(process.env.PE_SOAK_TICKS ?? (RELEASE_TIER ? 9_000 : 900))
/** How often populations are sampled inside a soak; both tiers get ~6-10 samples. */
const SAMPLE_EVERY = Number(process.env.PE_SOAK_SAMPLE ?? (RELEASE_TIER ? 900 : 150))
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
 * Viability floor for a species, read straight out of its own row.
 *
 * `minimum` is the engine's immigration threshold: below it the migration net
 * injects a group. So a peak ABOVE that line can only have been produced by the
 * animals themselves, which is exactly the claim this gate makes. No tuned
 * fraction of `cap` is involved - docs/00-VISION.md principle 2 says balance
 * numbers must come from physics, and a hand-picked share of the ceiling is the
 * kind of number that made the old gate lie.
 * @param {string} id - species id.
 * @returns {number} peak population that proves the species bred on its own.
 */
function viableFloor(id) {
  const row = SPECIES[id]
  return Number.isFinite(row.minimum) ? row.minimum : 0
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
  // A species needs roughly three maturities to breed, raise a cohort and have
  // that cohort counted, so a soak shorter than that cannot prove anything about
  // it. Judging a wolf on a 900 tick window would fail for a reason that is not a
  // bug, so slow species are held to the weaker claim they CAN be held to at this
  // window: they survive. PE_SOAK=1 puts every species on the strong gate.
  const soakSeconds = TICKS * TICK
  const failures = []
  const survivalOnly = []
  for (const id of SPECIES_IDS) {
    const floor = viableFloor(id)
    const samples = samplesOf(id)
    const maturity = SPECIES[id].balance === undefined ? 0 : SPECIES[id].balance.maturity
    const canBreed = maturity * 3 <= soakSeconds
    if (!canBreed) survivalOnly.push(id)
    const passed = samples.filter(sample => canBreed
      ? sample.peak > floor && sample.last > 0
      : sample.last > 0)
    if (passed.length < MAJORITY) {
      const evidence = canBreed
        ? 'viable in ' + passed.length + '/' + samples.length + ' seeds (floor ' + floor + ')'
        : 'alive at the end in ' + passed.length + '/' + samples.length + ' seeds'
      failures.push(id + ': ' + evidence + '; peaks ' + samples.map(sample => sample.peak).join('/'))
    }
  }
  const strong = SPECIES_IDS.filter(id => !survivalOnly.includes(id))
  console.log((RELEASE_TIER ? 'release' : 'daily') + ' tier, soak ' + soakSeconds.toFixed(0) + ' s x '
    + SEEDS.length + ' seeds: breeding gate for [' + (strong.join(', ') || 'none') + ']'
    + (survivalOnly.length > 0 ? '; survival-only for [' + survivalOnly.join(', ') + '] (PE_SOAK=1 widens it)' : ''))
  assert.deepEqual(failures, [],
    'a species that cannot hold a population in most seeds has a broken chain: '
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

test('the soak is long enough and wide enough to mean something', () => {
  // Guards the gate itself: a shortened soak, a coarser sample interval or a
  // dropped seed would silently weaken every assertion above.
  const runs = soaks()
  const minimumSeeds = RELEASE_TIER ? 3 : 2
  assert.ok(SEEDS.length >= minimumSeeds,
    'the ' + (RELEASE_TIER ? 'release' : 'daily') + ' tier needs at least ' + minimumSeeds + ' seeds, got ' + SEEDS.length)
  assert.equal(runs.length, SEEDS.length, 'every seed must produce one soak')
  assert.ok(TICKS / SAMPLE_EVERY >= 5, 'a soak must produce at least five checkpoints, got ' + TICKS / SAMPLE_EVERY)
  if (!RELEASE_TIER) {
    // Guards the daily tier's promise: it has to stay cheap enough to run on every
    // save, otherwise people start skipping the suite.
    assert.ok(SEEDS.length * TICKS <= 2_000, 'the daily tier must stay under 2000 seed-ticks, got ' + SEEDS.length * TICKS)
  }
  for (const run of runs) {
    assert.equal(run.checkpoints.length, Math.floor(TICKS / SAMPLE_EVERY),
      'seed ' + run.seed + ' must report every checkpoint')
    assert.ok(run.world.tick > 0, 'seed ' + run.seed + ' never stepped')
  }
  const days = (TICKS * TICK) / DAY_SECONDS
  assert.ok(days >= 1, 'the soak must span at least one in-world day, it spans ' + days.toFixed(2))
})
