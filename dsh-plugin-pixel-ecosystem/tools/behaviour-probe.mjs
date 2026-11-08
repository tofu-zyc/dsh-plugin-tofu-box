/**
 * Behaviour probe for the pixel terrarium (roadmap P0-4).
 *
 * Why this file exists: every behaviour/energy change in this plugin used to be
 * judged by eyeballing the canvas. The probe turns a soak into numbers, so a
 * change can be compared before/after on the same seed.
 *
 * Contract (docs/95-WORKFLOW.md, docs/97-PROBES.md):
 *   node tools/behaviour-probe.mjs --seed 12345 --seconds 900
 *
 * It must run on BOTH engine generations at once:
 *   - legacy (0.2.x):        entity.energy + entity.needs + entity.fate, no body
 *   - energy ledger (0.3.x): entity.body.{E,Emax,M,health,cause} + drives + state.id
 * So every field read goes through the accessors below, and the report prints
 * which source it actually found. A missing field degrades to the legacy
 * reading, never to a crash: the probe is the measuring stick, it cannot be
 * blocked by the thing it measures.
 *
 * The probe only reads the engine. It never mutates the world, never calls
 * Math.random (determinism comes from createWorld({ seed })) and never touches
 * the DOM.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { boot } from '../tests/_harness.mjs'

/** Line break, kept in one place so no string literal needs an escape. */
const NL = String.fromCharCode(10)

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULTS = {
  seed: 12345,
  seconds: 900,
  width: 0,
  height: 0,
  immigration: true,
  sampleEvery: 10,
  top: 6,
  json: false,
  engineGeneration: false,
}

/** One line per flag, printed by --help. */
const USAGE = [
  'node tools/behaviour-probe.mjs [options]',
  '',
  '  --seed <int>          world seed (default 12345)',
  '  --seconds <number>    simulated seconds at 1x (default 900)',
  '  --width <int>         override world width  (default: engine default)',
  '  --height <int>        override world height (default: engine default)',
  '  --no-immigration      disable the migration safety net',
  '  --sample-every <int>  ticks between energy/age samples (default 10 = 1 s)',
  '  --top <int>           intents listed per species (default 6)',
  '  --json                machine-readable report (for before/after diffs)',
  '  --engine-generation   print legacy|v2 and exit (never compare across them)',
  '  --help                this text',
].join(NL)

/**
 * Parse argv into probe options.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {object} options, plus `help` when the caller should print usage.
 */
function parseArgs(argv) {
  const options = { ...DEFAULTS }
  const number = (raw, flag) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(flag + ' needs a number, got ' + raw)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(flag + ' needs a value')
      return argv[index]
    }
    if (flag === '--help' || flag === '-h') { options.help = true; continue }
    if (flag === '--json') { options.json = true; continue }
    if (flag === '--engine-generation') { options.engineGeneration = true; continue }
    if (flag === '--immigration') { options.immigration = true; continue }
    if (flag === '--no-immigration') { options.immigration = false; continue }
    if (flag === '--seed') { options.seed = Math.trunc(number(next(), flag)); continue }
    if (flag === '--seconds') { options.seconds = number(next(), flag); continue }
    if (flag === '--width') { options.width = Math.trunc(number(next(), flag)); continue }
    if (flag === '--height') { options.height = Math.trunc(number(next(), flag)); continue }
    if (flag === '--sample-every') { options.sampleEvery = Math.max(1, Math.trunc(number(next(), flag))); continue }
    if (flag === '--top') { options.top = Math.max(1, Math.trunc(number(next(), flag))); continue }
    throw new Error('unknown flag ' + flag)
  }
  if (!(options.seconds > 0)) throw new Error('--seconds must be positive')
  return options
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Load the shipped bundle and report whether it matches src/parts.
 *
 * A probe that silently measures a stale client.js is worse than no probe, so
 * the staleness check is a warning on stderr (never a hard failure: the Lead may
 * deliberately probe a work-in-progress bundle).
 * @returns {{ engine: object, stale: boolean|string }} the engine seam.
 */
function loadEngine() {
  let stale = false
  let hash = 'missing'
  try {
    const root = new URL('../', import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('src/manifest.json', root), 'utf8'))
    const expected = manifest.parts
      .map(part => readFileSync(new URL('src/parts/' + part.file, root), 'utf8'))
      .join(NL)
    const bundle = readFileSync(new URL('client.js', root), 'utf8')
    hash = createHash('sha1').update(bundle).digest('hex').slice(0, 12)
    stale = bundle !== expected
  } catch (error) {
    stale = 'unreadable: ' + error.message
  }
  let booted
  try {
    booted = boot()
  } catch (error) {
    throw new Error('the bundle did not boot: ' + error.message
      + NL + 'client.js may be mid-rebuild; run node tools/build-client.mjs')
  }
  if (stale !== false) {
    const detail = stale === true ? 'src/parts changed since the last build' : String(stale)
    process.stderr.write('warning: client.js is stale (' + detail + '); run node tools/build-client.mjs' + NL)
  }
  return { engine: booted.engine, stale, hash }
}

// ---------------------------------------------------------------------------
// Field accessors - the one place that knows both engine generations
// ---------------------------------------------------------------------------

/**
 * Build the accessor set for an engine, resolving every optional field once.
 *
 * Each accessor falls back from the energy-ledger field to the legacy one, so
 * the probe reads a half-migrated engine without special cases at the call site.
 * @param {object} engine - the __engine seam.
 * @returns {object} accessors plus a human-readable `sources` map.
 */
function createAccessors(engine) {
  const SPECIES = engine.SPECIES

  /** Reserve limit: the ledger stores it on the body, legacy on the balance row. */
  const emaxOf = entity => {
    const body = entity.body
    if (body !== undefined && Number.isFinite(body.Emax) && body.Emax > 0) return body.Emax
    const row = SPECIES[entity.species]
    return row === undefined || row.balance === undefined ? 0 : row.balance.maxEnergy
  }

  /** Current reserve (kJ in the ledger engine, abstract units in legacy). */
  const energyOf = entity => {
    const body = entity.body
    if (body !== undefined && Number.isFinite(body.E)) return body.E
    return Number.isFinite(entity.energy) ? entity.energy : 0
  }

  /** Reserve fullness 0..1 - the only cross-generation comparable energy number. */
  const energyRatioOf = entity => {
    const max = emaxOf(entity)
    if (!(max > 0)) return 0
    return clamp01(energyOf(entity) / max)
  }

  /** Activity id: P2 `state.id`, legacy `intent`. */
  const intentOf = entity => {
    const state = entity.state
    if (state !== undefined && typeof state.id === 'string' && state.id.length > 0) return state.id
    if (typeof entity.intent === 'string' && entity.intent.length > 0) return entity.intent
    return 'unknown'
  }

  /** Hunger 0..1. Per docs/20-CORE-LOOP.md section 2.2 it must be derived from the reserve. */
  const hungerOf = entity => {
    const drives = entity.drives
    if (drives !== undefined && Number.isFinite(drives.hunger)) return clamp01(drives.hunger)
    const needs = entity.needs
    if (needs !== undefined && Number.isFinite(needs.hunger)) return clamp01(needs.hunger)
    return clamp01(1 - energyRatioOf(entity))
  }

  /** Death cause: authoritative `body.cause` in the ledger engine, else undefined. */
  const causeOf = entity => {
    if (entity === undefined) return undefined
    const body = entity.body
    if (body !== undefined && typeof body.cause === 'string' && body.cause.length > 0) return body.cause
    if (typeof entity.cause === 'string' && entity.cause.length > 0) return entity.cause
    return undefined
  }

  /** Individual lifespan in seconds: a scalar gene on the animal, a range on the species. */
  const lifespanOf = entity => {
    if (entity !== undefined && entity.genes !== undefined) {
      const gene = entity.genes.lifespan
      if (Number.isFinite(gene)) return gene
      if (Array.isArray(gene)) return gene[1]
    }
    const row = entity === undefined ? undefined : SPECIES[entity.species]
    if (row !== undefined && row.genes !== undefined && Array.isArray(row.genes.lifespan)) return row.genes.lifespan[1]
    return Infinity
  }

  /** Maturity age in seconds (species constant; the body carries maturity instead). */
  const maturityOf = entity => {
    const row = SPECIES[entity.species]
    return row === undefined || row.balance === undefined ? 0 : row.balance.maturity
  }

  /** Life stage label, preferring the body's maturity when present. */
  const stageOf = entity => {
    const body = entity.body
    const maturity = maturityOf(entity)
    if (body !== undefined && Number.isFinite(body.M) && maturity > 0) {
      if (body.M < 1) return 'juvenile'
      return entity.age > maturity * 2.6 ? 'elder' : 'adult'
    }
    if (!(maturity > 0)) return 'adult'
    if (entity.age < maturity) return 'juvenile'
    return entity.age > maturity * 2.6 ? 'elder' : 'adult'
  }

  /**
   * Engine generation actually running under this world.
   *
   * `v2` is the energy-ledger build described by docs/20-CORE-LOOP.md: body
   * records, drives, timed state, climate and detritus fields. `legacy` is the
   * 0.2.x dead-tree engine: one `energy` scalar plus a need record.
   *
   * World-level fields are checked as well as the body because a half-migrated
   * build can allocate climate/detritus before the first body record: a probe
   * that only looked for `body` would call that build legacy and quietly read
   * the wrong fields.
   * @param {object} world - the world.
   * @returns {'v2'|'legacy'} generation label.
   */
  const generationOf = world => {
    if (world === undefined) return 'legacy'
    if (world.climate !== undefined || world.detritus !== undefined || world.caches !== undefined) return 'v2'
    if (Array.isArray(world.entities)) {
      for (const entity of world.entities) if (entity.body !== undefined) return 'v2'
    }
    return 'legacy'
  }

  /**
   * Report which physical field each metric happily read in THIS world, so the
   * report proves the degradation instead of claiming it. Called late enough
   * that a lazily-created body/state field has already appeared.
   * @param {object} entity - any live animal.
   * @param {object} world - the world it lives in.
   * @returns {object} source labels plus the engine generation.
   */
  const detectSources = (entity, world) => {
    const generation = generationOf(world)
    if (entity === undefined) return { generation, intent: 'none', reserve: 'none', hunger: 'none', cause: 'none' }
    const intent = entity.state !== undefined && typeof entity.state.id === 'string' ? 'state.id'
      : typeof entity.intent === 'string' ? 'intent' : 'none'
    let reserve = 'none'
    if (entity.body !== undefined && Number.isFinite(entity.body.E) && Number.isFinite(entity.body.Emax)) reserve = 'body.E/body.Emax'
    else if (Number.isFinite(entity.energy)) reserve = 'energy/maxEnergy'
    let hunger = 'none'
    if (entity.drives !== undefined && Number.isFinite(entity.drives.hunger)) hunger = 'drives.hunger'
    else if (entity.needs !== undefined && Number.isFinite(entity.needs.hunger)) hunger = 'needs.hunger'
    else if (reserve !== 'none') hunger = '1-E/Emax'
    // The cause field only carries a value at death, so presence of the slot is
    // what decides whether the census is authoritative or inferred.
    const cause = entity.body !== undefined && 'cause' in entity.body ? 'body.cause'
      : 'cause' in entity ? 'cause' : 'inferred'
    return { generation, intent, reserve, hunger, cause }
  }

  return {
    SPECIES,
    energyOf,
    energyRatioOf,
    intentOf,
    hungerOf,
    causeOf,
    lifespanOf,
    maturityOf,
    stageOf,
    detectSources,
    generationOf,
  }
}

/** @param {number} value - raw. @returns {number} clamped to 0..1. */
function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Median of a numeric array (copies before sorting).
 * @param {number[]} values - samples.
 * @returns {number} median, or NaN when empty.
 */
function median(values) {
  if (values.length === 0) return NaN
  const sorted = Float64Array.from(values).sort()
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Quantile of a numeric array.
 * @param {number[]} values - samples.
 * @param {number} p - 0..1.
 * @returns {number} quantile, or NaN when empty.
 */
function quantile(values, p) {
  if (values.length === 0) return NaN
  const sorted = Float64Array.from(values).sort()
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[index]
}

/** @param {number} value - seconds. @returns {string} fixed-width seconds or n/a. */
function seconds(value) {
  return Number.isFinite(value) ? value.toFixed(1).padStart(6) : '   n/a'
}

/** @param {number} value - share 0..1. @returns {string} percentage or n/a. */
function percent(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1).padStart(5) + '%' : '  n/a'
}

/** @param {number} value - count. @param {number} width - column width. @returns {string} right aligned. */
function count(value, width) {
  return String(Number.isFinite(value) ? Math.round(value) : '-').padStart(width)
}

/** @param {number} value - number. @returns {string} fixed decimals or n/a. */
function fixed(value, digits, width) {
  return Number.isFinite(value) ? value.toFixed(digits).padStart(width) : 'n/a'.padStart(width)
}

/**
 * Bucketed dwell histogram.
 *
 * Median and mean come from 0.25 s buckets, so a soak never has to keep one
 * sample per intent switch (there can be millions of them).
 */
class DwellHistogram {
  /** @param {number} bucketSeconds - bucket width; 0.25 s keeps the median honest. */
  constructor(bucketSeconds) {
    this.bucketSeconds = bucketSeconds
    this.buckets = new Float64Array(4096)
    this.samples = 0
    this.total = 0
    this.max = 0
  }

  /** @param {number} duration - dwell in seconds. @returns {void} */
  add(duration) {
    if (!Number.isFinite(duration) || duration < 0) return
    const index = Math.min(this.buckets.length - 1, Math.round(duration / this.bucketSeconds))
    this.buckets[index] += 1
    this.samples += 1
    this.total += duration
    if (duration > this.max) this.max = duration
  }

  /** @returns {number} arithmetic mean dwell in seconds. */
  get mean() {
    return this.samples === 0 ? NaN : this.total / this.samples
  }

  /** @returns {number} median dwell in seconds. */
  get median() {
    if (this.samples === 0) return NaN
    const target = this.samples / 2
    let seen = 0
    for (let index = 0; index < this.buckets.length; index++) {
      seen += this.buckets[index]
      if (seen >= target) return index * this.bucketSeconds
    }
    return this.max
  }
}

/** @returns {object} a fresh per-species accumulator. */
function createSpeciesStats() {
  return {
    intentSeconds: new Map(),
    intentDwell: new Map(),
    swaps: 0,
    entitySeconds: 0,
    indiv: [],
    deaths: [],
    born: 0,
    spawned: 0,
    samples: 0,
    hungerSum: 0,
    energySum: 0,
  }
}

// ---------------------------------------------------------------------------
// The soak
// ---------------------------------------------------------------------------

/**
 * Run one deterministic soak and collect behaviour metrics.
 *
 * Per tick the probe diffs the live-id set against the previous tick to detect
 * deaths. Diffing is the only way to see a death at all (the engine removes the
 * animal from world.entities), and it works on both engine generations.
 * @param {object} engine - the __engine seam.
 * @param {object} options - parsed CLI options.
 * @returns {object} the collected metrics.
 */
function soak(engine, options) {
  const TICK = engine.TICK
  const DAY_SECONDS = engine.DAY_SECONDS
  const SPECIES_IDS = engine.SPECIES_IDS
  const TERRAIN = engine.TERRAIN
  const accessors = createAccessors(engine)
  const worldOptions = { seed: options.seed, immigration: options.immigration }
  if (options.width > 0 && options.height > 0) {
    worldOptions.width = options.width
    worldOptions.height = options.height
  }
  const world = engine.createWorld(worldOptions)

  const stats = new Map()
  for (const id of SPECIES_IDS) stats.set(id, createSpeciesStats())

  /** id -> per-individual tracker. Dropped on death. */
  const tracked = new Map()
  /** Survival mark: a tracker the live loop does not re-mark belongs to a corpse. */
  let mark = 0

  const steps = Math.max(1, Math.round(options.seconds / TICK))
  const sampleEvery = options.sampleEvery
  /** 2D histogram [reserveRow][hungerColumn], 10 x 20 over 0..1. */
  const scatter = Array.from({ length: 10 }, () => new Float64Array(20))
  // Which fields this engine actually has. Resolved on the first sample tick
  // again, because a lazily created body record only appears once stepped.
  let detected = accessors.detectSources(world.entities[0], world)
  const population = []
  const producers = { grass: [], weed: [], grassBare: [] }
  const area = { grass: 0, water: 0 }
  for (let index = 0; index < world.terrain.length; index++) {
    if (world.terrain[index] === TERRAIN.GRASS) area.grass += 1
    else if (world.terrain[index] === TERRAIN.WATER) area.water += 1
  }
  const initialCounts = {}
  for (const id of SPECIES_IDS) initialCounts[id] = 0
  for (const entity of world.entities) initialCounts[entity.species] = (initialCounts[entity.species] ?? 0) + 1
  // The founding herd is reported as its own column, never as spawned stock.
  const initialIds = new Set(world.entities.map(entity => entity.id))

  // Thirty in-world seconds of hunger per animal, sampled once a second. This is
  // what lets the P1 gate ask "did it die hungry?" instead of "was its reserve
  // at zero?" - the two are not the same question.
  const hungerWindows = new WeakMap()

  /** @param {object} entity - the animal. @param {number} value - hunger 0..1. @returns {void} */
  function pushHunger(entity, value) {
    let window = hungerWindows.get(entity)
    if (window === undefined) {
      window = { values: [], cursor: 0 }
      hungerWindows.set(entity, window)
    }
    if (window.values.length < 30) window.values.push(value)
    else {
      window.values[window.cursor] = value
      window.cursor = (window.cursor + 1) % 30
    }
  }

  /** @param {object} entity - the animal. @returns {number} lowest hunger over the last 30 s. */
  function windowHungerMin(entity) {
    const window = hungerWindows.get(entity)
    if (window === undefined || window.values.length === 0) return NaN
    let lowest = Infinity
    for (const value of window.values) if (value < lowest) lowest = value
    return lowest
  }

  let stepMs = 0
  let tick = 0
  const started = performance.now()
  for (tick = 1; tick <= steps; tick++) {
    const stepStarted = performance.now()
    engine.stepWorld(world, TICK)
    stepMs += performance.now() - stepStarted

    mark += 1
    const isSampleTick = tick % sampleEvery === 0
    const isSecondTick = tick % 10 === 0

    for (const entity of world.entities) {
      const entry = stats.get(entity.species)
      if (entry === undefined) continue
      let record = tracked.get(entity.id)
      if (record === undefined) {
        record = {
          id: entity.id,
          species: entity.species,
          obj: entity,
          bornTick: tick,
          firstX: entity.x,
          firstY: entity.y,
          minX: entity.x,
          maxX: entity.x,
          minY: entity.y,
          maxY: entity.y,
          lastX: entity.x,
          lastY: entity.y,
          path: 0,
          intent: accessors.intentOf(entity),
          intentSince: tick,
          lastEnergyRatio: 0,
          lastHunger: NaN,
          lastAge: entity.age,
          lastFate: entity.fate,
          lastOnGrass: false,
        }
        tracked.set(entity.id, record)
        // Every animal past the founding herd is a birth or an immigration.
        if (!initialIds.has(entity.id)) entry.spawned += 1
        if (entity.generation > 1) entry.born += 1
      }
      record.mark = mark
      record.obj = entity

      const distance = Math.hypot(entity.x - record.lastX, entity.y - record.lastY)
      // A jump (immigration, restore) must not read as a marathon walk.
      if (distance < 8) record.path += distance
      record.lastX = entity.x
      record.lastY = entity.y
      if (entity.x < record.minX) record.minX = entity.x
      if (entity.x > record.maxX) record.maxX = entity.x
      if (entity.y < record.minY) record.minY = entity.y
      if (entity.y > record.maxY) record.maxY = entity.y

      const intent = accessors.intentOf(entity)
      if (intent !== record.intent) {
        if (record.intentSince < tick) {
          let histogram = entry.intentDwell.get(record.intent)
          if (histogram === undefined) {
            histogram = new DwellHistogram(0.25)
            entry.intentDwell.set(record.intent, histogram)
          }
          histogram.add((tick - record.intentSince) * TICK)
          entry.swaps += 1
        }
        record.intent = intent
        record.intentSince = tick
      }
      entry.intentSeconds.set(intent, (entry.intentSeconds.get(intent) ?? 0) + TICK)
      entry.entitySeconds += TICK
      record.lastEnergyRatio = accessors.energyRatioOf(entity)
      record.lastAge = entity.age
      record.lastFate = entity.fate
      record.lastHunger = accessors.hungerOf(entity)
      if (isSecondTick) pushHunger(entity, record.lastHunger)
      if (isSampleTick) {
        const column = (entity.x | 0)
        const row = (entity.y | 0)
        const cell = world.terrain[row * world.width + column]
        record.lastOnGrass = cell === TERRAIN.GRASS && world.grass[row * world.width + column] > 0.02
        const hungerBin = Math.min(19, Math.max(0, Math.floor(record.lastHunger * 20)))
        const reserveBin = Math.min(9, Math.max(0, Math.floor(record.lastEnergyRatio * 10)))
        scatter[reserveBin][hungerBin] += 1
        entry.samples += 1
        entry.hungerSum += record.lastHunger
        entry.energySum += record.lastEnergyRatio
      }
    }

    // Death detection. record.obj is the very object the engine just killed, so
    // post-mortem fields (fate, body.cause, final reserve) are still readable.
    for (const record of tracked.values()) {
      if (record.mark === mark) continue
      tracked.delete(record.id)
      const entry = stats.get(record.species)
      const lifetime = (tick - record.bornTick) * TICK
      const verdict = classifyDeath(accessors, record)
      const lifespan = accessors.lifespanOf(record.obj)
      entry.deaths.push({
        id: record.id,
        cause: verdict.cause,
        causeSource: verdict.source,
        age: record.lastAge,
        lifetime,
        energyRatio: record.lastEnergyRatio,
        hunger: record.lastHunger,
        hungerMin30: windowHungerMin(record.obj),
        lifespan: Number.isFinite(lifespan) ? lifespan : null,
        onGrass: record.lastOnGrass,
      })
      if (lifetime >= 10) {
        entry.indiv.push({
          path: record.path,
          net: Math.hypot(record.lastX - record.firstX, record.lastY - record.firstY),
          extent: Math.max(record.maxX - record.minX, record.maxY - record.minY),
          lifetime,
        })
      }
    }

    if (isSampleTick) {
      if (world.entities.length > 0) detected = accessors.detectSources(world.entities[0], world)
      const counts = {}
      for (const id of SPECIES_IDS) counts[id] = 0
      for (const entity of world.entities) counts[entity.species] = (counts[entity.species] ?? 0) + 1
      population.push({ t: tick * TICK, counts })
      let grassSum = 0
      let grassCells = 0
      let bare = 0
      for (let index = 0; index < world.grass.length; index++) {
        if (world.terrain[index] !== TERRAIN.GRASS) continue
        grassCells += 1
        grassSum += world.grass[index]
        if (world.grass[index] < 0.1) bare += 1
      }
      let weedSum = 0
      let weedCells = 0
      for (let index = 0; index < world.weed.length; index++) {
        if (world.terrain[index] !== TERRAIN.WATER) continue
        weedCells += 1
        weedSum += world.weed[index]
      }
      producers.grass.push(grassSum / Math.max(1, grassCells))
      producers.weed.push(weedSum / Math.max(1, weedCells))
      producers.grassBare.push(bare / Math.max(1, grassCells))
    }
  }
  const elapsedMs = performance.now() - started
  const finalTick = steps

  // Survivors still hold trackers; fold them into the individual stats too.
  for (const record of tracked.values()) {
    const entry = stats.get(record.species)
    const lifetime = (finalTick - record.bornTick) * TICK
    if (lifetime < 10) continue
    entry.indiv.push({
      path: record.path,
      net: Math.hypot(record.lastX - record.firstX, record.lastY - record.firstY),
      extent: Math.max(record.maxX - record.minX, record.maxY - record.minY),
      lifetime,
    })
  }

  const living = {}
  const stageCounts = {}
  for (const id of SPECIES_IDS) {
    living[id] = 0
    stageCounts[id] = { juvenile: 0, adult: 0, elder: 0 }
  }
  for (const entity of world.entities) {
    living[entity.species] = (living[entity.species] ?? 0) + 1
    const stages = stageCounts[entity.species]
    if (stages !== undefined) stages[accessors.stageOf(entity)] += 1
  }

  return {
    options, world, steps, stepMs, elapsedMs, area, producers, scatter, population,
    initialCounts, living, stageCounts, stats, accessors, detected, TICK, DAY_SECONDS, SPECIES_IDS,
    ticksPerSecondWall: steps / (elapsedMs / 1000),
    ticksPerSecondSim: steps / (Math.max(1e-6, stepMs) / 1000),
  }
}

/**
 * Classify one death: authoritative cause first, inference second.
 *
 * Order matters, and it was fixed the hard way in the first-round diagnosis:
 * a predation kill also ends with a zeroed reserve, so a naive
 * "reserve <= 0 means starved" test swallows every kill. The legacy order is
 *   1. fate === 'eaten'   (the predator's own mark, when it survived a tick)
 *   2. age > lifespan     (old age)
 *   3. reserve === 0      (the attacker zeroed it: predation)
 *   4. reserve < 0        (starvation leaves a negative residue)
 *   5. everything else     (unexplained: a real observability gap)
 * @param {object} accessors - field accessors.
 * @param {object} record - the tracker of the dead animal.
 * @returns {{ cause: string, source: string }} verdict.
 */
function classifyDeath(accessors, record) {
  const authoritative = accessors.causeOf(record.obj)
  if (authoritative !== undefined) return { cause: authoritative, source: 'body.cause' }
  if (record.lastFate === 'eaten') return { cause: 'predation', source: 'inferred:fate' }
  const lifespan = accessors.lifespanOf(record.obj)
  if (record.lastAge > lifespan - 2) return { cause: 'old', source: 'inferred:age' }
  const body = record.obj === undefined ? undefined : record.obj.body
  const deadReserve = body === undefined ? (record.obj === undefined ? NaN : record.obj.energy) : body.E
  if (deadReserve === 0 && record.lastEnergyRatio > 0) return { cause: 'predation', source: 'inferred:reserve' }
  if (deadReserve < 0) return { cause: 'starved', source: 'inferred:reserve' }
  if (!Number.isFinite(deadReserve)) return { cause: 'unknown', source: 'unknown' }
  if (deadReserve <= 0) return { cause: 'starved', source: 'inferred:reserve' }
  return { cause: 'unknown', source: 'unknown' }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Render the ASCII energy x hunger scatter.
 * @param {Float64Array[]} scatter - [reserveRow][hungerColumn] counts, row 0 = empty reserve.
 * @returns {string[]} printable lines.
 */
function renderScatter(scatter) {
  const rows = scatter.length
  const columns = scatter[0].length
  let peak = 0
  for (const row of scatter) for (const value of row) if (value > peak) peak = value
  const ramp = ' .:-=+*#%@'
  const bar = String.fromCharCode(124)
  const lines = []
  lines.push('reserve  (row = body reserve 0..1, column = hunger 0..1)')
  for (let row = rows - 1; row >= 0; row--) {
    let line = ((row / rows).toFixed(1)) + ' ' + bar
    for (let column = 0; column < columns; column++) {
      const value = scatter[row][column]
      const scale = peak === 0 || value === 0 ? 0 : Math.ceil((value / peak) * (ramp.length - 1))
      line += ramp[Math.min(ramp.length - 1, scale)]
    }
    lines.push(line)
  }
  lines.push('    ' + bar + '-'.repeat(columns) + '  hunger')
  lines.push('    ' + 'fed'.padEnd(columns - 6) + 'starving')
  return lines
}

/**
 * Evaluate the roadmap gates a soak can actually measure (docs/90-ROADMAP.md).
 * @param {object} result - the soak result.
 * @returns {object[]} gate rows: { id, label, value, threshold, pass, format }.
 */
function evaluateGates(result) {
  const stats = result.stats
  let entitySeconds = 0
  let restSeconds = 0
  let swaps = 0
  let deaths = 0
  let starved = 0
  const pooledDwell = new DwellHistogram(0.25)
  const paths = []
  const nets = []
  for (const id of result.SPECIES_IDS) {
    const entry = stats.get(id)
    entitySeconds += entry.entitySeconds
    restSeconds += entry.intentSeconds.get('rest') ?? 0
    swaps += entry.swaps
    for (const histogram of entry.intentDwell.values()) {
      for (let index = 0; index < histogram.buckets.length; index++) {
        pooledDwell.buckets[index] += histogram.buckets[index]
      }
      pooledDwell.samples += histogram.samples
      pooledDwell.total += histogram.total
      if (histogram.max > pooledDwell.max) pooledDwell.max = histogram.max
    }
    for (const individual of entry.indiv) {
      paths.push(individual.path)
      nets.push(individual.net)
    }
    deaths += entry.deaths.length
    for (const death of entry.deaths) if (death.cause === 'starved') starved += 1
  }
  const meanPath = meanOf(paths)
  const meanNet = meanOf(nets)
  const directionality = meanPath > 0 ? meanNet / meanPath : NaN
  const jitter = entitySeconds === 0 ? NaN : swaps / (entitySeconds / 60)
  const restShare = entitySeconds === 0 ? NaN : restSeconds / entitySeconds
  const starvedShare = deaths === 0 ? NaN : starved / deaths
  return [
    { id: 'P2.1', label: 'rest share of entity-time', value: restShare, format: percent, threshold: '< 35%', pass: restShare < 0.35 },
    { id: 'P2.2', label: 'median intent dwell', value: pooledDwell.median, format: seconds, threshold: '> 10 s', pass: pooledDwell.median > 10 },
    { id: 'P2.3', label: 'directionality (mean net / mean path)', value: directionality, format: v => fixed(v, 2, 6), threshold: '> 0.30', pass: directionality > 0.3 },
    { id: 'P2.4', label: 'intent switches per minute per animal', value: jitter, format: v => fixed(v, 1, 6), threshold: '< 12', pass: jitter < 12 },
    { id: 'P3.1', label: 'starved share of deaths', value: starvedShare, format: percent, threshold: '< 50%', pass: starvedShare < 0.5 },
  ]
}

/** @param {number} value - number. @returns {number|null} 3-decimal number or null. */
function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
}

/** @param {number[]} values - samples. @returns {number} arithmetic mean, NaN when empty. */
function meanOf(values) {
  if (values.length === 0) return NaN
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

/** @param {object[]} population - population samples. @param {string} id - species. @returns {number} peak count. */
function peakOf(population, id) {
  let peak = 0
  for (const sample of population) if (sample.counts[id] > peak) peak = sample.counts[id]
  return peak
}

/**
 * Build the JSON report (for before/after diffs by the Lead and by CI).
 * @param {object} result - the soak result.
 * @returns {object} lossless summary.
 */
function toJson(result) {
  const species = {}
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    const intents = {}
    const ordered = [...entry.intentSeconds].sort((a, b) => b[1] - a[1])
    for (const [intent, secs] of ordered) {
      const histogram = entry.intentDwell.get(intent)
      intents[intent] = {
        seconds: round3(secs),
        share: round3(secs / Math.max(1e-9, entry.entitySeconds)),
        dwellMedian: round3(histogram === undefined ? NaN : histogram.median),
        dwellMean: round3(histogram === undefined ? NaN : histogram.mean),
      }
    }
    const deaths = {}
    for (const death of entry.deaths) deaths[death.cause] = (deaths[death.cause] ?? 0) + 1
    const paths = entry.indiv.map(item => item.path)
    const extents = entry.indiv.map(item => item.extent)
    const nets = entry.indiv.map(item => item.net)
    const meanPath = meanOf(paths)
    species[id] = {
      start: result.initialCounts[id] ?? 0,
      alive: result.living[id] ?? 0,
      peak: peakOf(result.population, id),
      spawned: entry.spawned,
      born: entry.born,
      stage: result.stageCounts[id],
      entitySeconds: round3(entry.entitySeconds),
      intents,
      switchesPerMinute: round3(entry.entitySeconds === 0 ? NaN : entry.swaps / (entry.entitySeconds / 60)),
      pathMedian: round3(median(paths)),
      homeRadiusMedian: round3(median(extents) / 2),
      homeRadiusP90: round3(quantile(extents, 0.9) / 2),
      netMedian: round3(median(nets)),
      directionality: round3(meanPath > 0 ? meanOf(nets) / meanPath : NaN),
      deaths,
      deathAges: entry.deaths.map(death => Math.round(death.age)),
      starvationHungerAtDeath: entry.deaths.filter(death => death.cause === 'starved').map(death => round3(death.hunger)),
      meanHunger: round3(entry.samples === 0 ? NaN : entry.hungerSum / entry.samples),
      meanReserve: round3(entry.samples === 0 ? NaN : entry.energySum / entry.samples),
    }
  }
  return {
    tool: 'behaviour-probe',
    bundleHash: result.bundleHash,
    bundleStale: result.bundleStale,
    seed: result.options.seed,
    seconds: result.steps * result.TICK,
    ticks: result.steps,
    wallMs: Math.round(result.elapsedMs),
    ticksPerSecondWall: round3(result.ticksPerSecondWall),
    ticksPerSecondSim: round3(result.ticksPerSecondSim),
    world: { width: result.world.width, height: result.world.height, area: result.area },
    engineGeneration: result.detected === undefined ? 'legacy' : result.detected.generation,
    fieldSources: result.detected,
    species,
    producers: {
      grassMean: round3(meanOf(result.producers.grass)),
      grassBareShare: round3(meanOf(result.producers.grassBare)),
      weedMean: round3(meanOf(result.producers.weed)),
    },
    scatter: result.scatter.map(row => Array.from(row, value => Math.round(value))),
    gates: evaluateGates(result).map(gate => ({
      id: gate.id,
      label: gate.label,
      value: round3(gate.value),
      threshold: gate.threshold,
      pass: gate.pass,
    })),
  }
}

/**
 * Print the human report.
 * @param {object} result - the soak result.
 * @param {object} options - parsed CLI options.
 * @returns {void}
 */
function printReport(result, options) {
  const write = line => process.stdout.write((line === undefined ? '' : line) + NL)
  const rule = title => write('') || write('=== ' + title + ' ===')
  const gameSeconds = result.steps * result.TICK

  write('bundle ' + result.bundleHash + (result.bundleStale ? ' (STALE: src/parts not built)' : ''))
  write('seed ' + options.seed + ' | world ' + result.world.width + 'x' + result.world.height
    + ' | ' + result.steps + ' ticks = ' + gameSeconds.toFixed(0) + ' s = '
    + (gameSeconds / result.DAY_SECONDS).toFixed(2) + ' game days | immigration '
    + (options.immigration ? 'on' : 'off'))
  write('throughput ' + result.ticksPerSecondWall.toFixed(0) + ' ticks/s wall ('
    + result.ticksPerSecondSim.toFixed(0) + ' ticks/s sim only, '
    + result.elapsedMs.toFixed(0) + ' ms)')
  const detected = result.detected === undefined
    ? { generation: 'legacy', intent: 'none', reserve: 'none', hunger: 'none', cause: 'none' }
    : result.detected
  const generationLabel = detected.generation === 'v2' ? 'v2 (energy ledger)' : 'legacy (0.2.x dead tree)'
  write('engine generation ' + generationLabel)
  write('  fields actually read: intent=' + detected.intent
    + ' | reserve=' + detected.reserve + ' | hunger=' + detected.hunger
    + ' | cause=' + detected.cause)
  if (detected.generation !== 'v2') {
    write('  NOTE: legacy numbers are NOT comparable with v2 numbers - the reserve unit,')
    write('        the hunger derivation and the death causes all differ. Record the')
    write('        generation next to every baseline (docs/97-PROBES.md section 7).')
  }

  rule('population: start, alive, spawned (born), deaths, peak')
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    write(id.padEnd(7) + count(result.initialCounts[id], 6) + ' -> ' + count(result.living[id], 5)
      + '  +' + count(entry.spawned, 4) + ' (' + count(entry.born, 4) + ' born)'
      + '  deaths ' + count(entry.deaths.length, 4) + '  peak ' + count(peakOf(result.population, id), 4))
  }

  rule('time budget: intent x entity-seconds (share of that species entity-time)')
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    if (entry.entitySeconds === 0) { write(id.padEnd(7) + ' (never seen)'); continue }
    const parts = [...entry.intentSeconds].sort((a, b) => b[1] - a[1]).slice(0, options.top)
      .map(pair => pair[0] + ' ' + percent(pair[1] / entry.entitySeconds).trim()
        + '(' + pair[1].toFixed(0) + 's)')
    write(id.padEnd(7) + parts.join('  '))
  }

  rule('intent dwell: median/mean seconds per visit, plus switches per minute')
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    if (entry.entitySeconds === 0) { write(id.padEnd(7) + ' (never seen)'); continue }
    const parts = [...entry.intentSeconds].sort((a, b) => b[1] - a[1]).slice(0, options.top)
      .map(pair => {
        const histogram = entry.intentDwell.get(pair[0])
        if (histogram === undefined || histogram.samples === 0) return pair[0] + ' n/a'
        return pair[0] + ' ' + histogram.median.toFixed(1) + '/' + histogram.mean.toFixed(1)
      })
    const jitter = entry.entitySeconds === 0 ? NaN : entry.swaps / (entry.entitySeconds / 60)
    write(id.padEnd(7) + parts.join('  ') + '   switches/min ' + fixed(jitter, 1, 5))
  }

  rule('movement per individual (tracked >= 10 s): path, home radius, directionality')
  write('species      n  pathMed  homeRMed  homeRp90  netMed    dir')
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    const n = entry.indiv.length
    if (n === 0) { write(id.padEnd(7) + count(0, 6) + '  (no individual lived 10 s)'); continue }
    const paths = entry.indiv.map(item => item.path)
    const extents = entry.indiv.map(item => item.extent)
    const nets = entry.indiv.map(item => item.net)
    const meanPath = meanOf(paths)
    const directionality = meanPath > 0 ? meanOf(nets) / meanPath : NaN
    write(id.padEnd(7) + count(n, 6)
      + fixed(median(paths), 0, 9)
      + fixed(median(extents) / 2, 0, 10)
      + fixed(quantile(extents, 0.9) / 2, 0, 10)
      + fixed(median(nets), 0, 8)
      + fixed(directionality, 2, 7))
  }

  rule('death census (body.cause when present, else fate/reserve inference)')
  write('species  deaths   eaten starved    old  other  ageMed  ageP10  ageP90  source')
  const totals = { deaths: 0, predation: 0, starved: 0, old: 0, other: 0 }
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    const byCause = {}
    for (const death of entry.deaths) byCause[death.cause] = (byCause[death.cause] ?? 0) + 1
    const predation = byCause.predation ?? 0
    const starved = byCause.starved ?? 0
    const old = byCause.old ?? 0
    const other = entry.deaths.length - predation - starved - old
    totals.deaths += entry.deaths.length
    totals.predation += predation
    totals.starved += starved
    totals.old += old
    totals.other += other
    const ages = entry.deaths.map(death => death.age)
    const sources = [...new Set(entry.deaths.map(death => death.causeSource))]
    write(id.padEnd(7) + count(entry.deaths.length, 7) + count(predation, 8) + count(starved, 8)
      + count(old, 6) + count(other, 7) + fixed(median(ages), 0, 8)
      + fixed(quantile(ages, 0.1), 0, 8) + fixed(quantile(ages, 0.9), 0, 8) + '  '
      + (sources.length === 0 ? '-' : sources.join(',')))
  }
  write('ALL'.padEnd(7) + count(totals.deaths, 7) + count(totals.predation, 8)
    + count(totals.starved, 8) + count(totals.old, 6) + count(totals.other, 7))
  if (totals.deaths > 0) {
    write('shares: predation ' + percent(totals.predation / totals.deaths)
      + '  starvation ' + percent(totals.starved / totals.deaths)
      + '  old age ' + percent(totals.old / totals.deaths)
      + '  unexplained ' + percent(totals.other / totals.deaths))
  }

  const starveHunger = []
  let starvedOnFood = 0
  for (const id of result.SPECIES_IDS) {
    for (const death of result.stats.get(id).deaths) {
      if (death.cause !== 'starved') continue
      if (Number.isFinite(death.hunger)) starveHunger.push(death.hunger)
      if (death.onGrass) starvedOnFood += 1
    }
  }
  if (starveHunger.length > 0) {
    const belliesFull = starveHunger.filter(value => value <= 0.6).length
    write('starvation quality: hunger at death median ' + median(starveHunger).toFixed(2)
      + '; ' + belliesFull + '/' + starveHunger.length + ' starved with hunger <= 0.6 (died on a full belly)'
      + '; ' + starvedOnFood + ' starved while standing on grass with food under them')
  }

  rule('age structure at the end of the soak (juvenile / adult / elder)')
  for (const id of result.SPECIES_IDS) {
    const stages = result.stageCounts[id]
    const total = stages.juvenile + stages.adult + stages.elder
    if (total === 0) { write(id.padEnd(7) + '(extinct)'); continue }
    write(id.padEnd(7) + 'juv ' + percent(stages.juvenile / total)
      + '  ad ' + percent(stages.adult / total)
      + '  eld ' + percent(stages.elder / total) + '   n=' + total)
  }

  rule('energy x hunger scatter (entity samples; top row = full reserve, right = starving)')
  for (const line of renderScatter(result.scatter)) write(line)
  write('mean per species:')
  for (const id of result.SPECIES_IDS) {
    const entry = result.stats.get(id)
    if (entry.samples === 0) { write(id.padEnd(7) + '(never sampled)'); continue }
    write(id.padEnd(7) + 'reserve ' + fixed(entry.energySum / entry.samples, 2, 5)
      + '  hunger ' + fixed(entry.hungerSum / entry.samples, 2, 5))
  }

  rule('producers')
  write('grass mean biomass ' + fixed(meanOf(result.producers.grass), 3, 6)
    + '   bare-cell share ' + percent(meanOf(result.producers.grassBare)))
  write('weed mean biomass  ' + fixed(meanOf(result.producers.weed), 3, 6))

  rule('roadmap gates (docs/90-ROADMAP.md; informational until that phase lands)')
  for (const gate of evaluateGates(result)) {
    write(gate.id + ' ' + (gate.pass ? 'PASS' : 'FAIL') + ' ' + gate.label.padEnd(46)
      + gate.format(gate.value) + '  target ' + gate.threshold)
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Print just the engine generation and exit.
 *
 * Numbers from legacy and v2 are not comparable - the reserve unit, the hunger
 * derivation and the death causes all changed - so any script that compares two
 * probe reports must refuse the comparison when the generations differ.
 * @param {object} engine - the __engine seam.
 * @param {object} options - parsed CLI options.
 * @returns {void}
 */
function printEngineGeneration(engine, options) {
  const accessors = createAccessors(engine)
  const worldOptions = { seed: options.seed, immigration: options.immigration }
  if (options.width > 0 && options.height > 0) {
    worldOptions.width = options.width
    worldOptions.height = options.height
  }
  process.stdout.write(accessors.generationOf(engine.createWorld(worldOptions)) + NL)
}

/** Parse, soak, report. Exits non-zero only on a usage or boot error. */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(error.message + NL + NL + USAGE + NL)
    process.exit(2)
  }
  if (options.help === true) {
    process.stdout.write(USAGE + NL)
    return
  }
  if (options.engineGeneration === true) {
    let probe
    try {
      probe = loadEngine()
    } catch (error) {
      process.stderr.write(error.message + NL)
      process.exit(3)
    }
    printEngineGeneration(probe.engine, options)
    return
  }
  let loaded
  try {
    loaded = loadEngine()
  } catch (error) {
    process.stderr.write(error.message + NL)
    process.exit(3)
  }
  const result = soak(loaded.engine, options)
  result.bundleHash = loaded.hash
  result.bundleStale = loaded.stale !== false
  if (options.json) process.stdout.write(JSON.stringify(toJson(result), null, 2) + NL)
  else printReport(result, options)
}

// Only auto-run as a CLI; an importer gets the pieces without a 900 s soak.
export { soak, classifyDeath, parseArgs, toJson, evaluateGates, renderScatter, DwellHistogram, median, quantile, meanOf }
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
