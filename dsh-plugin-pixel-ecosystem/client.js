/**
 * Browser half of the Pixel Terrarium plugin.
 *
 * One panel, one canvas, one simulation:
 *
 * - Two additive seats only. `sidebar.panellist` gets the pixel icon that opens
 *   the panel, and the keyed `main` seat with the SAME id gets the panel body.
 *   Nothing shipped is replaced, overridden or disabled.
 * - The world lives in this module's closure, not in React and not in the
 *   Session log. The panel hands a canvas to the store, the store runs one
 *   `requestAnimationFrame` loop that steps the simulation and repaints, and
 *   React only re-renders ~2×/s for the counters, chart and inspector.
 * - The engine below is deliberately DOM-free and clock-free: `createWorld`,
 *   `stepWorld`, `place`, `paintWorld`, `serializeWorld` are plain functions
 *   over typed arrays, so `node --test` can drive tens of thousands of ticks
 *   headlessly (see DESIGN.md §5 and tests/). The bundle exports them under
 *   `module.exports.__engine` for exactly that purpose.
 *
 * The ecosystem is species-table driven: one `SPECIES` row plus one sprite is
 * all it takes to add a creature. Species carry their habitat, diet, gene
 * ranges and per-kind balance numbers; the step logic is shared.
 *
 * @module dsh-plugin-pixel-ecosystem/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-pixel-ecosystem',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** Locale namespace; equals the package name. */
    const NS = 'dsh-plugin-pixel-ecosystem'
    /** Sidebar entry id and `main` panel key. The two must be the same string. */
    const PANEL_ID = 'pixel-ecosystem'
    /** localStorage key for the autosaved world. */
    const STORAGE_KEY = 'dsh-pixel-ecosystem:v1'
    /** Serialized world format version; a mismatch starts a fresh world. */
    const SAVE_VERSION = 1

    // ---------------------------------------------------------------------
    // World constants
    // ---------------------------------------------------------------------

    /** Default world size in cells (one cell = one pixel in the canvas buffer). */
    const GRID_W = 640
    const GRID_H = 400
    /** Fixed simulation step. Callers slice real time into these. */
    const TICK = 0.1
    /** One in-world day, in seconds of 1× time. */
    const DAY_SECONDS = 120
    /** Global ceiling on animals; per-species caps do the real limiting. */
    const MAX_ENTITIES = 3600
    const MAX_TREES = 1900
    const MAX_CORPSES = 260
    /** Days per in-world day, exposed for the clock and the day/night wash. */

    /**
     * Global tuning knobs that are not per species. Exported through
     * `module.exports.__engine` so the soak probe can explore them without
     * editing the bundle.
     */
    const TUNING = {
      /** Logistic growth rate of grass and weed, per second. */
      growth: 0.035,
      /** Seconds between immigration checks (min, max). */
      immigration: [25, 45],
      /** Seconds a carcass takes to rot away completely. */
      corpseSeconds: 42,
    }

    /** Terrain codes stored in `world.terrain`. */
    const TERRAIN = { WATER: 0, SAND: 1, DIRT: 2, GRASS: 3, STONE: 4 }

    /** Gene keys in display order. */
    const GENE_KEYS = ['speed', 'vision', 'size', 'metabolism', 'lifespan', 'fertility']

    // ---------------------------------------------------------------------
    // Species table
    // ---------------------------------------------------------------------
    //
    // habitat  land | water | air      (which terrain the animal can occupy)
    // role     grazer | hunter | scavenger
    // flora    which per-cell biomass field a grazer eats ('grass' | 'weed')
    // prey     species ids a hunter will chase
    // meat     energy a hunter gains, and a scavenger gets a share of
    // cap      per-species population ceiling (stops one species monopolising
    //          the global entity budget; 0 would mean "no local cap")
    // minimum  below this an immigration event refills the species (§4.3)
    // color    chip/legend colour (the sprite has its own palette)
    //
    // `balance` is per species; `genes` are the ranges mutations are clamped to.

    // Field data behind the numbers below (see DESIGN.md §2 for the mapping):
    // - European rabbit: colonies of up to ~30 in warrens, sprint ~45 km/h,
    //   maturity ~3-4 months, litters of 4-12 several times a year, wild
    //   lifespan 1-3 years, crepuscular (dawn/dusk peaks).
    //   https://scottishwildlifetrust.org.uk/species/rabbit-european/
    // - Red fox: sprint ~72 km/h, 1 litter/year of 1-12 (usually 5-6), gestation
    //   ~52 days, maturity ~10 months, wild lifespan ~3-10 years, territorial.
    //   https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf
    // - Grey wolf: packs of 2-15 (breeding pair + offspring), sprint ~60 km/h but
    //   famously a 10 km/h trotter, 1 litter/year of 4-7 pups, gestation 63 days,
    //   maturity 2-3 years, wild lifespan 6-8 years, territory 100-1000 km2.
    //   https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf
    // - Northern pike: ambush predator striking at 10-15 ft/s (3-4.6 m/s) rather
    //   than chasing, maturity 2-3 years, lifespan 7-15 years.
    //   https://www.fws.gov/sites/default/files/documents/northern-pike.pdf
    //
    // Time compression: one in-game DAY stands for one ecological YEAR, so a
    // "yearly" litter is a 120 s cooldown and a 3-month maturity is 36 s. Lengths
    // are compressed by SPEED_SCALE (a 45 km/h sprint is 4.4 cells/s, not 12.5)
    // because a 1:1 map would be 300 m across and crossing it would take minutes.
    const SPECIES = {
      rabbit: {
        habitat: 'land', role: 'grazer', flora: 'grass', meat: 18, cap: 620, minimum: 40, color: '#c9a97b',
        territory: { radius: 3, max: 7 },
        herd: { radius: 18, separation: 5, alarmRadius: 15 },
        // Crepuscular: busiest at dawn and dusk, skips the midday heat.
        activity: { dawn: 1, day: 0.45, dusk: 1, night: 0.7 },
        // Bursts, then tires: prey wins the sprint, the predator wins the chase.
        flight: { burst: 1.85, burstSeconds: 1.4, tired: 1.12 },
        genes: {
          speed: [2.6, 4.3], vision: [5, 13], size: [0.75, 1.35],
          metabolism: [0.75, 1.3], lifespan: [140, 240], fertility: [20, 30],
        },
        balance: {
          startEnergy: 58, maxEnergy: 100, drain: 1.0, breedEnergy: 80, breedCost: 20,
          maturity: 36, litter: [4, 7], eatRate: 1.6, floraEnergy: 6,
          fleeSpeed: 1.45, fleeDrain: 0.55,
        },
      },
      deer: {
        habitat: 'land', role: 'grazer', flora: 'grass', browse: true, meat: 45, cap: 260, minimum: 22, color: '#b98a5e',
        territory: { radius: 7, max: 4 },
        herd: { radius: 26, separation: 6, alarmRadius: 20 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.5 },
        flight: { burst: 1.5, burstSeconds: 2.2, tired: 1.15 },
        genes: {
          speed: [2.6, 3.8], vision: [8, 16], size: [1.4, 2.2],
          metabolism: [1.05, 1.5], lifespan: [1100, 1600], fertility: [110, 130],
        },
        balance: {
          startEnergy: 110, maxEnergy: 170, drain: 0.92, breedEnergy: 108, breedCost: 46,
          maturity: 180, litter: [1, 2], eatRate: 2.1, floraEnergy: 8,
          browseRate: 1.6, browseEnergy: 7, fleeSpeed: 1.35, fleeDrain: 0.8,
        },
      },
      fox: {
        habitat: 'land', role: 'hunter', prey: ['rabbit'], meat: 55, cap: 170, minimum: 12, color: '#d2733c',
        territory: { radius: 12, max: 2 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.9 },
        genes: {
          speed: [3.9, 5.7], vision: [9, 19], size: [0.85, 1.55],
          metabolism: [0.85, 1.35], lifespan: [300, 420], fertility: [110, 130],
        },
        balance: {
          startEnergy: 72, maxEnergy: 130, drain: 0.88, breedEnergy: 92, breedCost: 34,
          maturity: 96, litter: [3, 6], catchRadius: 1.15, huntSpeed: 1.1, scavengeShare: 0.6,
        },
      },
      wolf: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'rabbit'], meat: 80, cap: 90, minimum: 6, color: '#8a8f99',
        territory: { radius: 19, max: 1 },
        herd: { radius: 20, separation: 3, alarmRadius: 0 },
        activity: { dawn: 1, day: 0.75, dusk: 1, night: 0.85 },
        genes: {
          speed: [4.3, 6.0], vision: [11, 22], size: [1.3, 2.1],
          metabolism: [1.25, 1.9], lifespan: [700, 900], fertility: [110, 130],
        },
        balance: {
          startEnergy: 110, maxEnergy: 200, drain: 1.15, breedEnergy: 126, breedCost: 50,
          maturity: 240, litter: [3, 5], catchRadius: 1.3, huntSpeed: 1.06, scavengeShare: 0.55,
        },
      },
      crow: {
        habitat: 'air', role: 'scavenger', meat: 20, cap: 220, minimum: 16, color: '#3b3b46',
        herd: { radius: 22, separation: 3.5, alarmRadius: 20 },
        activity: { dawn: 1, day: 1, dusk: 0.9, night: 0.15 },
        genes: {
          speed: [5.2, 7.6], vision: [14, 26], size: [0.8, 1.2],
          metabolism: [0.85, 1.3], lifespan: [500, 700], fertility: [110, 130],
        },
        balance: {
          startEnergy: 40, maxEnergy: 80, drain: 0.75, breedEnergy: 64, breedCost: 18,
          maturity: 240, litter: [3, 5], scavengeRadius: 1.4, corpseShare: 0.9,
        },
      },
      fish: {
        habitat: 'water', role: 'grazer', flora: 'weed', meat: 20, cap: 520, minimum: 55, color: '#5b9fd4',
        territory: { radius: 3, max: 8 },
        herd: { radius: 14, separation: 4, alarmRadius: 10 },
        activity: { dawn: 1, day: 0.9, dusk: 1, night: 0.5 },
        flight: { burst: 1.6, burstSeconds: 0.8, tired: 1.1 },
        genes: {
          speed: [2.2, 4.0], vision: [5, 11], size: [0.7, 1.3],
          metabolism: [0.7, 1.2], lifespan: [420, 560], fertility: [110, 130],
        },
        balance: {
          startEnergy: 40, maxEnergy: 80, drain: 0.75, breedEnergy: 58, breedCost: 12,
          maturity: 120, litter: [4, 8], eatRate: 1.3, floraEnergy: 8,
          fleeSpeed: 1.4, fleeDrain: 0.95,
        },
      },
      pike: {
        habitat: 'water', role: 'hunter', prey: ['fish'], meat: 60, cap: 120, minimum: 9, color: '#4a6b4a',
        // Ambush: it does not chase across the lake, it waits and then strikes.
        ambush: { approach: 0.45, strikeDistance: 7, strikeSpeed: 1.9, cooldown: 2.5 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [4.4, 6.2], vision: [8, 16], size: [1.1, 1.9],
          metabolism: [0.95, 1.4], lifespan: [1000, 1300], fertility: [110, 130],
        },
        balance: {
          startEnergy: 74, maxEnergy: 130, drain: 1.0, breedEnergy: 84, breedCost: 30,
          maturity: 360, litter: [2, 4], catchRadius: 1.55, huntSpeed: 1.1, scavengeShare: 0.4,
        },
      },
    }
    /** Species ids in table order (also the legend/chip order). */
    const SPECIES_IDS = Object.keys(SPECIES)

    /** Per species: the set of hunter species that eat it. */
    const PREDATORS_OF = {}
    /** Per species: the set of species it hunts. */
    const PREY_OF = {}
    for (const id of SPECIES_IDS) {
      PREDATORS_OF[id] = new Set()
      PREY_OF[id] = new Set(SPECIES[id].prey ?? [])
    }
    for (const hunterId of SPECIES_IDS) {
      for (const preyId of PREY_OF[hunterId]) PREDATORS_OF[preyId].add(hunterId)
    }

    /** Starting population of a fresh world: fuller meadow, fewer predators. */
    const DEFAULT_STOCKS = { rabbit: 160, deer: 40, fox: 12, wolf: 5, crow: 20, fish: 120, pike: 12 }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /**
     * Clamp a number into an inclusive range.
     * @param {number} value - input.
     * @param {number} lo - lower bound.
     * @param {number} hi - upper bound.
     * @returns {number} clamped value.
     */
    function clamp(value, lo, hi) {
      return value < lo ? lo : value > hi ? hi : value
    }

    /**
     * Linear interpolation.
     * @param {number} a - value at t = 0.
     * @param {number} b - value at t = 1.
     * @param {number} t - progress.
     * @returns {number} interpolated value.
     */
    function mix(a, b, t) {
      return a + (b - a) * t
    }

    /**
     * Smoothstep, for value-noise interpolation.
     * @param {number} t - 0..1.
     * @returns {number} eased 0..1.
     */
    function smooth(t) {
      return t * t * (3 - 2 * t)
    }

    /**
     * Deterministic 2D hash in [0, 1): hydrology and texture noise that must be
     * reproducible from the terrain alone (no RNG stream position).
     * @param {number} x - column.
     * @param {number} y - row.
     * @param {number} seed - world seed.
     * @returns {number} hash value.
     */
    function hash2(x, y, seed) {
      let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2654435761)) >>> 0
      n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296
    }

    /**
     * Advance the world's 32-bit LCG and return a number in [0, 1).
     * @param {object} world - the world owning the stream.
     * @returns {number} pseudo-random number.
     */
    function nextRandom(world) {
      world.rngState = (Math.imul(world.rngState, 1664525) + 1013904223) >>> 0
      return world.rngState / 4294967296
    }

    /**
     * Pseudo-random number in [lo, hi).
     * @param {object} world - the world owning the stream.
     * @param {number} lo - lower bound.
     * @param {number} hi - upper bound.
     * @returns {number} random value.
     */
    function randomBetween(world, lo, hi) {
      return lo + (hi - lo) * nextRandom(world)
    }

    /**
     * Cell index for a coordinate pair, or -1 when outside the grid.
     * @param {object} world - the world.
     * @param {number} x - cell column.
     * @param {number} y - cell row.
     * @returns {number} index or -1.
     */
    function cellIndex(world, x, y) {
      const cx = x | 0
      const cy = y | 0
      if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return -1
      return cy * world.width + cx
    }

    /**
     * Terrain code at a fractional world position, or -1 outside the grid.
     * @param {object} world - the world.
     * @param {number} x - fractional column.
     * @param {number} y - fractional row.
     * @returns {number} terrain code or -1.
     */
    function terrainAt(world, x, y) {
      const index = cellIndex(world, x, y)
      return index < 0 ? -1 : world.terrain[index]
    }

    /**
     * Whether one species may occupy a fractional position.
     * Land animals avoid water and rock, fish stay in water, birds ignore terrain.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {number} x - fractional column.
     * @param {number} y - fractional row.
     * @returns {boolean} true when the position is valid for that species.
     */
    function canStand(world, species, x, y) {
      const terrain = terrainAt(world, x, y)
      if (terrain < 0) return false
      if (species.habitat === 'air') return true
      if (species.habitat === 'water') return terrain === TERRAIN.WATER
      return terrain !== TERRAIN.WATER && terrain !== TERRAIN.STONE
    }

    /**
     * The biomass field a grazer eats (or `null`).
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {Float32Array|null} field.
     */
    function floraField(world, species) {
      if (species.flora === 'grass') return world.grass
      if (species.flora === 'weed') return world.weed
      return null
    }

    /**
     * Daylight factor for the current world time: 0 at night, 1 at noon.
     * @param {object} world - the world.
     * @returns {number} 0..1.
     */
    function daylight(world) {
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      const sun = (phase - 0.22) / 0.56
      if (sun <= 0 || sun >= 1) return 0.12
      return 0.12 + 0.88 * Math.sin(Math.PI * sun)
    }

    // ---------------------------------------------------------------------
    // Terrain and hydrology
    // ---------------------------------------------------------------------

    /**
     * Build one octave of bilinear value noise over the world.
     * @param {object} world - the world (RNG source).
     * @param {number} cellSize - lattice spacing in cells.
     * @returns {(x: number, y: number) => number} sampler in [0, 1].
     */
    function createNoise(world, cellSize) {
      const cols = Math.ceil(world.width / cellSize) + 2
      const rows = Math.ceil(world.height / cellSize) + 2
      const lattice = new Float32Array(cols * rows)
      for (let i = 0; i < lattice.length; i++) lattice[i] = nextRandom(world)
      return (x, y) => {
        const fx = x / cellSize
        const fy = y / cellSize
        const x0 = fx | 0
        const y0 = fy | 0
        const tx = smooth(fx - x0)
        const ty = smooth(fy - y0)
        const i0 = y0 * cols + x0
        const i1 = i0 + cols
        return mix(mix(lattice[i0], lattice[i0 + 1], tx), mix(lattice[i1], lattice[i1 + 1], tx), ty)
      }
    }

    /**
     * Fill `moisture` (and optionally `waterFertility`) from the terrain alone.
     *
     * Called at creation and again after a load, because neither array carries
     * gameplay state: distance-to-water plus a positional hash reproduces them
     * exactly, which keeps saves small. After the player reshapes the land only
     * moisture is refreshed, so nutrients built up by rotting carcasses survive.
     * @param {object} world - the world; `terrain` must already be filled.
     * @param {boolean} [includeWaterFertility] - refresh the water nutrient field too.
     */
    function computeHydrology(world, includeWaterFertility = true) {
      const width = world.width
      const height = world.height
      const size = width * height
      const distance = new Int32Array(size).fill(1e9)
      const queue = new Int32Array(size)
      let head = 0
      let tail = 0
      for (let i = 0; i < size; i++) {
        if (world.terrain[i] === TERRAIN.WATER) { distance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = distance[index] + 1
        if (x > 0 && distance[index - 1] > next) { distance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && distance[index + 1] > next) { distance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && distance[index - width] > next) { distance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && distance[index + width] > next) { distance[index + width] = next; queue[tail++] = index + width }
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          const near = clamp(1 - distance[i] / 30, 0, 1)
          world.moisture[i] = clamp(near * 0.82 + hash2(x, y, world.seed) * 0.18, 0, 1)
          if (includeWaterFertility) {
            // Shallow water is richer than the middle of the lake: weeds prefer it.
            world.waterFertility[i] = clamp(0.35 + near * 0.55 + hash2(x + 91, y + 17, world.seed) * 0.2, 0, 1)
          }
        }
      }
    }

    /**
     * Base fertility of one cell, from terrain and hydrology.
     * @param {object} world - the world.
     * @param {number} index - cell index.
     * @returns {number} 0..1.
     */
    function baseFertility(world, index) {
      const terrain = world.terrain[index]
      if (terrain === TERRAIN.STONE || terrain === TERRAIN.WATER) return 0
      if (terrain === TERRAIN.SAND) return 0.18
      const x = index % world.width
      const y = (index / world.width) | 0
      const base = terrain === TERRAIN.DIRT ? 0.42 : 0.5
      return clamp(base + world.moisture[index] * 0.42 + hash2(x + 7, y + 3, world.seed) * 0.12, 0, 1)
    }

    /**
     * 3×3 box blur over a height field, edge-clamped.
     *
     * Raw multi-octave noise thresholds into a speckled archipelago; one or two
     * passes of this turn it into shorelines. The shape survives, the confetti
     * does not.
     * @param {object} world - the world (for its size).
     * @param {Float32Array} field - source heights.
     * @returns {Float32Array} blurred heights.
     */
    function boxBlur(world, field) {
      const width = world.width
      const height = world.height
      const out = new Float32Array(field.length)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0
          let count = 0
          for (let dy = -1; dy <= 1; dy++) {
            const ny = clamp(y + dy, 0, height - 1)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = clamp(x + dx, 0, width - 1)
              sum += field[ny * width + nx]
              count += 1
            }
          }
          out[y * width + x] = sum / count
        }
      }
      return out
    }

    /**
     * Keep only the largest connected water bodies.
     *
     * A percentile sea level guarantees the right *amount* of water but not the
     * right *shape*: it scatters dozens of puddles. Knowing which puddles are
     * actually one lake makes the difference between a meadow with a lake and a
     * field of water stains.
     * @param {object} world - the world (for its size).
     * @param {Uint8Array} mask - 1 where the cell is a candidate water cell.
     * @param {number} share - fraction of candidate area to keep, largest first.
     * @returns {Uint8Array} 1 where the cell belongs to a kept body.
     */
    function keepLargestWaterBodies(world, mask, share) {
      const width = world.width
      const height = world.height
      const size = mask.length
      const labels = new Int32Array(size).fill(-1)
      const sizes = []
      const queue = new Int32Array(size)
      for (let start = 0; start < size; start++) {
        if (mask[start] !== 1 || labels[start] !== -1) continue
        const label = sizes.length
        let head = 0
        let tail = 0
        queue[tail++] = start
        labels[start] = label
        let count = 0
        while (head < tail) {
          const index = queue[head++]
          count += 1
          const x = index % width
          const y = (index / width) | 0
          if (x > 0 && mask[index - 1] === 1 && labels[index - 1] === -1) { labels[index - 1] = label; queue[tail++] = index - 1 }
          if (x < width - 1 && mask[index + 1] === 1 && labels[index + 1] === -1) { labels[index + 1] = label; queue[tail++] = index + 1 }
          if (y > 0 && mask[index - width] === 1 && labels[index - width] === -1) { labels[index - width] = label; queue[tail++] = index - width }
          if (y < height - 1 && mask[index + width] === 1 && labels[index + width] === -1) { labels[index + width] = label; queue[tail++] = index + width }
        }
        sizes.push(count)
      }
      const total = sizes.reduce((sum, value) => sum + value, 0)
      const order = sizes.map((size, label) => ({ label, size })).sort((a, b) => b.size - a.size)
      const kept = new Set()
      let running = 0
      for (const body of order) {
        if (running >= total * share && kept.size > 0) break
        kept.add(body.label)
        running += body.size
      }
      const keep = new Uint8Array(size)
      for (let i = 0; i < size; i++) keep[i] = labels[i] >= 0 && kept.has(labels[i]) ? 1 : 0
      return keep
    }

    /**
     * Fill `terrain` from the world seed.
     *
     * Large octaves give one continent, a blur pass kills speckle, and only the
     * biggest water bodies survive, so the default world reads as meadow + lake
     * rather than confetti. Sand hugs the shoreline (not a noise band), soil
     * appears in coherent dry patches, and rock only on the highest ridges.
     * @param {object} world - the world to fill.
     */
    function generateTerrain(world) {
      const width = world.width
      const height = world.height
      const size = width * height
      const octaves = [[56, 0.52], [28, 0.3], [13, 0.18]]
      const samplers = octaves.map(([cellSize]) => createNoise(world, cellSize))
      let field = new Float32Array(size)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = 0
          for (let o = 0; o < octaves.length; o++) value += octaves[o][1] * samplers[o](x, y)
          field[y * width + x] = value
        }
      }
      field = boxBlur(world, boxBlur(world, field))
      const sorted = Float32Array.from(field).sort()
      const waterLevel = sorted[Math.floor(size * 0.2)]
      const rockLevel = sorted[Math.floor(size * 0.99)]

      const candidate = new Uint8Array(size)
      for (let i = 0; i < size; i++) candidate[i] = field[i] <= waterLevel ? 1 : 0
      const water = keepLargestWaterBodies(world, candidate, 0.88)

      // Distance to the shoreline drives sand, soil and fertility.
      const distance = new Int32Array(size).fill(1e9)
      const queue = new Int32Array(size)
      let head = 0
      let tail = 0
      for (let i = 0; i < size; i++) {
        if (water[i] === 1) { distance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = distance[index] + 1
        if (x > 0 && distance[index - 1] > next) { distance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && distance[index + 1] > next) { distance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && distance[index - width] > next) { distance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && distance[index + width] > next) { distance[index + width] = next; queue[tail++] = index + width }
      }

      const soilNoise = createNoise(world, 17)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          if (water[i] === 1) { world.terrain[i] = TERRAIN.WATER; continue }
          const shore = distance[i]
          if (shore <= 2) { world.terrain[i] = TERRAIN.SAND; continue }
          if (field[i] >= rockLevel) { world.terrain[i] = TERRAIN.STONE; continue }
          // Far from water is drier ground: coherent soil patches, not speckle.
          const dryness = clamp((shore - 14) / 26, 0, 1)
          world.terrain[i] = soilNoise(x, y) > 0.66 + dryness * 0.16 ? TERRAIN.DIRT : TERRAIN.GRASS
        }
      }
    }

    /**
     * Seed the two producer fields from fertility/hydrology.
     * @param {object} world - the world.
     */
    function seedProducers(world) {
      const size = world.width * world.height
      for (let i = 0; i < size; i++) {
        const terrain = world.terrain[i]
        world.fertility[i] = baseFertility(world, i)
        if (terrain === TERRAIN.GRASS) {
          const x = i % world.width
          const y = (i / world.width) | 0
          world.grass[i] = clamp(0.3 + world.fertility[i] * 0.55 + hash2(x + 31, y + 53, world.seed) * 0.18, 0, 0.98)
        } else if (terrain === TERRAIN.WATER) {
          const x = i % world.width
          const y = (i / world.width) | 0
          world.weed[i] = clamp(0.12 + world.waterFertility[i] * 0.5 + hash2(x + 61, y + 11, world.seed) * 0.2, 0, 0.95)
        }
      }
    }

    // ---------------------------------------------------------------------
    // Flora and world creation
    // ---------------------------------------------------------------------

    /**
     * Plant the initial forest: trees and shrubs on fertile grassland.
     * @param {object} world - the world.
     * @param {number} count - how many plants to aim for.
     */
    function seedTrees(world, count) {
      for (let attempt = 0; attempt < count * 8 && world.trees.length < count; attempt++) {
        const x = 2 + ((nextRandom(world) * (world.width - 4)) | 0)
        const y = 2 + ((nextRandom(world) * (world.height - 4)) | 0)
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== TERRAIN.GRASS) continue
        if (world.fertility[index] < 0.52) continue
        let crowded = false
        for (const plant of world.trees) {
          if (Math.abs(plant.x - x) < 4 && Math.abs(plant.y - y) < 4) { crowded = true; break }
        }
        if (crowded) continue
        const bush = nextRandom(world) < 0.34
        world.trees.push({
          id: world.nextId++,
          x,
          y,
          variant: bush ? 'bush' : 'tree',
          size: bush ? 1 : 1 + ((nextRandom(world) * 3) | 0),
          age: randomBetween(world, 20, 160),
          foliage: randomBetween(world, 0.6, 1),
          seedTimer: randomBetween(world, 30, 90),
        })
      }
    }

    /**
     * Drop the starting herds on valid habitat: land animals on grassland,
     * fish in the lake, birds above everything.
     * @param {object} world - the world.
     * @param {object} stocks - species id → count.
     */
    function seedAnimals(world, stocks) {
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const target = stocks[id] ?? 0
        let placed = 0
        for (let attempt = 0; attempt < target * 60 && placed < target; attempt++) {
          const x = randomBetween(world, 1, world.width - 2)
          const y = randomBetween(world, 1, world.height - 2)
          const terrain = terrainAt(world, x, y)
          if (species.habitat === 'water') {
            if (terrain !== TERRAIN.WATER) continue
          } else if (species.habitat === 'air') {
            if (terrain === TERRAIN.STONE) continue
          } else if (terrain !== TERRAIN.GRASS) continue
          spawnEntity(world, id, x, y)
          placed += 1
        }
      }
    }

    /**
     * Create a fully populated world.
     * @param {object} [options] - `{ seed?, width?, height?, stocks?, trees? }`.
     * @returns {object} the new world.
     */
    function createWorld(options = {}) {
      const width = Math.max(32, Math.min(512, options.width ?? GRID_W))
      const height = Math.max(24, Math.min(512, options.height ?? GRID_H))
      const seed = (options.seed ?? ((Math.random() * 4294967295) | 0)) >>> 0
      const size = width * height
      const world = {
        version: SAVE_VERSION,
        seed,
        // The migration net can be switched off per world: a player who erased a
        // species on purpose should not see it wander back in, and isolated
        // engine tests need a world that stays exactly as they built it.
        immigration: options.immigration !== false,
        width,
        height,
        tick: 0,
        // Start at dawn: a fresh world should be lit, not a dark screen.
      time: DAY_SECONDS * 0.26,
        rngState: seed === 0 ? 1 : seed,
        terrain: new Uint8Array(size),
        moisture: new Float32Array(size),
        waterFertility: new Float32Array(size),
        fertility: new Float32Array(size),
        grass: new Float32Array(size),
        weed: new Float32Array(size),
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      generateTerrain(world)
      computeHydrology(world)
      seedProducers(world)
      seedTrees(world, options.trees ?? 700)
      seedAnimals(world, { ...DEFAULT_STOCKS, ...(options.stocks ?? {}) })
      world.population = countPopulations(world)
      sampleStats(world)
      return world
    }

    // ---------------------------------------------------------------------
    // Genes and spawning
    // ---------------------------------------------------------------------

    /**
     * Draw a fresh gene set for one species.
     * @param {object} world - the world (RNG source).
     * @param {string} speciesId - species id.
     * @returns {object} gene record.
     */
    function randomGenes(world, speciesId) {
      const ranges = SPECIES[speciesId].genes
      const genes = {}
      for (const key of GENE_KEYS) genes[key] = randomBetween(world, ranges[key][0], ranges[key][1])
      return genes
    }

    /**
     * Copy genes with a small drift, clamped to the species' ranges.
     * ~5% of draws mutate hard, which is what makes adaptation visible.
     * @param {object} world - the world (RNG source).
     * @param {object} genes - parent genes.
     * @param {string} speciesId - species id.
     * @returns {object} child genes.
     */
    function mutateGenes(world, genes, speciesId) {
      const ranges = SPECIES[speciesId].genes
      const strong = nextRandom(world) < 0.05 ? 0.2 : 0.07
      const child = {}
      for (const key of GENE_KEYS) {
        const drift = 1 + randomBetween(world, -strong, strong)
        child[key] = clamp(genes[key] * drift, ranges[key][0], ranges[key][1])
      }
      return child
    }

    /**
     * How many animals of one species are alive.
     * Counting beats a cached counter here: births are rare enough that an
     * occasional O(n) pass is cheaper than keeping counters in sync through
     * predation, drowning, erasing and loading.
     * @param {object} world - the world.
     * @param {string} speciesId - species id.
     * @returns {number} population.
     */
    /**
     * Recount every species once; used at creation and after a load.
     * @param {object} world - the world.
     * @returns {object} species id → count.
     */
    function countPopulations(world) {
      const population = {}
      for (const id of SPECIES_IDS) population[id] = 0
      for (const entity of world.entities) {
        population[entity.species] = (population[entity.species] ?? 0) + 1
      }
      return population
    }

    function countSpecies(world, speciesId) {
      let count = 0
      for (const entity of world.entities) if (entity.species === speciesId) count += 1
      return count
    }

    /**
     * Add one animal to the world.
     * @param {object} world - the world.
     * @param {string} speciesId - species id.
     * @param {number} x - position.
     * @param {number} y - position.
     * @param {object} [genes] - inherited genes; random when omitted.
     * @param {number} [generation] - lineage depth.
     * @returns {object|null} the entity, or null at a population cap.
     */
    function spawnEntity(world, speciesId, x, y, genes, generation, options) {
      const species = SPECIES[speciesId]
      if (species === undefined) return null
      if (world.entities.length >= MAX_ENTITIES) return null
      const population = world.population ?? (world.population = countPopulations(world))
      // orce is used by player placement: an explicit release is a decision,
      // not an ecology outcome, so the density cap only warns the UI.
      // Player placement may overstock the map a little, but not without limit:
      // the ceiling keeps the renderer and the food web from melting down.
      const ceiling = species.cap === undefined ? Infinity : (options?.force === true ? Math.round(species.cap * 1.4) : species.cap)
      if ((population[speciesId] ?? 0) >= ceiling) return null
      const entity = {
        id: world.nextId++,
        species: speciesId,
        x,
        y,
        heading: nextRandom(world) * Math.PI * 2,
        energy: species.balance.startEnergy,
        age: 0,
        generation: generation ?? 1,
        cooldown: 0,
        thinkTimer: randomBetween(world, 0, 0.3),
        herdTimer: randomBetween(world, 0, 0.8),
        herdAnchor: null,
        alarm: 0,
        targetX: x,
        targetY: y,
        fleeing: false,
        fate: '',
        children: 0,
        phase: nextRandom(world),
        genes: genes ?? randomGenes(world, speciesId),
      }
      world.entities.push(entity)
      world.population[speciesId] = (world.population[speciesId] ?? 0) + 1
      return entity
    }

    // ---------------------------------------------------------------------
    // Spatial queries
    // ---------------------------------------------------------------------

    /**
     * Bucket entities into a uniform grid for neighbour queries.
     * @param {object} world - the world (grid extent).
     * @param {object[]} list - entities to index.
     * @param {number} cellSize - bucket edge in cells.
     * @returns {{cellSize: number, cols: number, rows: number, buckets: object[][]}} grid.
     */
    function buildGrid(world, list, cellSize) {
      const cols = Math.ceil(world.width / cellSize)
      const rows = Math.ceil(world.height / cellSize)
      const buckets = new Array(cols * rows)
      for (const entity of list) {
        const cx = clamp((entity.x / cellSize) | 0, 0, cols - 1)
        const cy = clamp((entity.y / cellSize) | 0, 0, rows - 1)
        const slot = cy * cols + cx
        const bucket = buckets[slot]
        if (bucket === undefined) buckets[slot] = [entity]
        else bucket.push(entity)
      }
      return { cellSize, cols, rows, buckets }
    }

    /**
     * Nearest entity to a point within a radius.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - search radius in cells.
     * @param {(entity: object) => boolean} [filter] - optional predicate.
     * @returns {object|null} the nearest match.
     */
    function queryNearest(grid, x, y, radius, filter) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      let best = null
      let bestDistance = radius * radius
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (filter !== undefined && !filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            const distance = dx * dx + dy * dy
            if (distance < bestDistance) { bestDistance = distance; best = candidate }
          }
        }
      }
      return best
    }

    /**
     * How many entities matching a predicate sit within a radius.
     * Used for territorial breeding checks, where the nearest match is not the
     * interesting number — the crowd is.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - radius in cells.
     * @param {(entity: object) => boolean} filter - predicate.
     * @returns {number} matching entities in range (excluding nobody).
     */
    function countNearby(grid, x, y, radius, filter) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      const limit = radius * radius
      let count = 0
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (!filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            if (dx * dx + dy * dy <= limit) count += 1
          }
        }
      }
      return count
    }

    /**
     * Entities matching a predicate within a radius, bounded by `limit`.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - radius in cells.
     * @param {(entity: object) => boolean} filter - predicate.
     * @param {number} [limit] - stop after this many matches.
     * @returns {object[]} matching entities.
     */
    function queryNearby(grid, x, y, radius, filter, limit = 24) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      const limitSquared = radius * radius
      const found = []
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (!filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            if (dx * dx + dy * dy > limitSquared) continue
            found.push(candidate)
            if (found.length >= limit) return found
          }
        }
      }
      return found
    }

    /**
     * Movement multiplier for the current time of day, from the species'
     * activity window (rabbits and deer peak at dawn/dusk; crows roost at night).
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {number} multiplier in roughly 0.1..1.1.
     */
    function activityFactor(world, species) {
      const activity = species.activity
      if (activity === undefined) return 1
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      if (phase >= 0.17 && phase < 0.3) return activity.dawn
      if (phase >= 0.3 && phase < 0.71) return activity.day
      if (phase >= 0.71 && phase < 0.85) return activity.dusk
      return activity.night
    }

    /** Seconds one sighting keeps an animal spooked. */
    const ALARM_SECONDS = 4
    /** Seconds a neighbour stays spooked after hearing an alarm. */
    const ALARM_SHARE = 3

    /**
     * Spread an alarm to nearby conspecifics.
     *
     * One rabbit bolting is a sighting; a whole warren bolting is a stampede.
     * This is what makes a fox's approach read as an event instead of a single
     * unlucky animal twitching.
     * @param {object} entity - the animal that saw the threat.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @param {object} threat - the predator that was seen.
     */
    function spreadAlarm(entity, species, grid, threat, world) {
      const radius = species.herd?.alarmRadius ?? 10
      // Only a couple of puffs per alarm event, or the meadow turns yellow.
      let spreadEffectBudget = 2
      const neighbours = queryNearby(grid, entity.x, entity.y, radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species)
      for (const neighbour of neighbours) {
        if ((neighbour.alarm ?? 0) >= ALARM_SHARE) continue
        neighbour.alarm = ALARM_SHARE
        neighbour.threatX = threat.x
        neighbour.threatY = threat.y
        if (spreadEffectBudget > 0) {
          spawnEffect(world, neighbour.x, neighbour.y - 1, PALETTE.effect.alarm, 0.45, 0.4)
          spreadEffectBudget -= 1
        }
      }
    }

    /**
     * Where a herd animal drifts when it has nothing better to do: toward the
     * centroid of its neighbours, pushed away from the ones standing on top of
     * it. Returns null when it is alone, so solitary animals keep wandering.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @returns {{x: number, y: number}|null} a target, or null.
     */
    /**
     * Centroid of nearby conspecifics, or null when alone.
     * Used to bias grazing toward the rest of the herd, so a group keeps eating
     * the same patch instead of each animal drifting its own way.
     * @param {object} entity - the animal.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @returns {{x: number, y: number}|null} centroid or null.
     */
    function herdCentroid(entity, species, grid) {
      const herd = species.herd
      const neighbours = queryNearby(grid, entity.x, entity.y, herd.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species, 8)
      if (neighbours.length === 0) return null
      let sumX = 0
      let sumY = 0
      for (const neighbour of neighbours) { sumX += neighbour.x; sumY += neighbour.y }
      return { x: sumX / neighbours.length, y: sumY / neighbours.length }
    }

    function herdTarget(world, entity, species, grid) {
      const herd = species.herd
      const neighbours = queryNearby(grid, entity.x, entity.y, herd.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species)
      if (neighbours.length === 0) return null
      let sumX = 0
      let sumY = 0
      let pushX = 0
      let pushY = 0
      for (const neighbour of neighbours) {
        sumX += neighbour.x
        sumY += neighbour.y
        const dx = entity.x - neighbour.x
        const dy = entity.y - neighbour.y
        const distance = Math.hypot(dx, dy)
        if (distance > 0.01 && distance < herd.separation) {
          pushX += dx / distance
          pushY += dy / distance
        }
      }
      const x = sumX / neighbours.length + pushX * herd.separation * 1.6
      const y = sumY / neighbours.length + pushY * herd.separation * 1.6
      return { x: clamp(x, 1, world.width - 2), y: clamp(y, 1, world.height - 2) }
    }

    /**
     * Nearest carcass to a point within a radius.
     * @param {object} world - the world.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - search radius in cells.
     * @returns {object|null} the nearest corpse.
     */
    function nearestCorpse(world, x, y, radius) {
      let best = null
      let bestDistance = radius * radius
      for (const corpse of world.corpses) {
        const dx = corpse.x - x
        const dy = corpse.y - y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = corpse }
      }
      return best
    }

    /**
     * Find the animal nearest to a point, for click-to-inspect.
     * @param {object} world - the world.
     * @param {number} x - world position.
     * @param {number} y - world position.
     * @param {number} [radius] - search radius in cells.
     * @returns {object|undefined} the entity.
     */
    function findEntityAt(world, x, y, radius = 2.5) {
      let best
      let bestDistance = radius * radius
      for (const entity of world.entities) {
        const dx = entity.x - x
        const dy = entity.y - y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = entity }
      }
      return best
    }

    /**
     * Look an entity up by id.
     * @param {object} world - the world.
     * @param {number} id - entity id.
     * @returns {object|undefined} the entity.
     */
    function findEntityById(world, id) {
      for (const entity of world.entities) if (entity.id === id) return entity
      return undefined
    }

    // ---------------------------------------------------------------------
    // Simulation step
    // ---------------------------------------------------------------------

    /**
     * Kill an animal and leave a carcass behind.
     * Single death path: starvation, old age and predation all end here.
     * @param {object} world - the world.
     * @param {object} entity - the dying animal.
     */
    function killEntity(world, entity) {
      if (entity.fate === 'dead') return
      entity.fate = 'dead'
      for (let puff = 0; puff < 3; puff++) spawnEffect(world, entity.x, entity.y, PALETTE.effect.death, 0.5, 0.5)
      if (world.population !== undefined && world.population[entity.species] !== undefined) {
        world.population[entity.species] = Math.max(0, world.population[entity.species] - 1)
      }
      const species = SPECIES[entity.species]
      const meat = species === undefined ? 24 : species.meat
      world.corpses.push({
        id: world.nextId++,
        x: entity.x,
        y: entity.y,
        species: entity.species,
        decay: 0,
        energy: Math.round(meat * 0.8),
      })
      if (world.corpses.length > MAX_CORPSES) world.corpses.shift()
    }

    /**
     * Move an animal toward a target, sliding along terrain edges.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} targetX - destination.
     * @param {number} targetY - destination.
     * @param {number} dt - step in seconds.
     * @param {number} multiplier - speed multiplier.
     */
    function moveToward(world, entity, species, targetX, targetY, dt, multiplier) {
      let dx = targetX - entity.x
      let dy = targetY - entity.y
      const distance = Math.hypot(dx, dy)
      
      if (distance < 0.12 && entity.fleeing !== true) {
        // Already standing on the target (usually a patch of grass): graze in
        // place instead of twitching around it.
        return
      }
      if (distance < 0.08) {
        entity.heading += randomBetween(world, -1.4, 1.4)
      } else {
        dx /= distance
        dy /= distance
        const desired = Math.atan2(dy, dx)
        let delta = desired - entity.heading
        if (delta > Math.PI) delta -= Math.PI * 2
        if (delta < -Math.PI) delta += Math.PI * 2
        entity.heading += clamp(delta, -6 * dt, 6 * dt)
      }
      const pace = entity.genes.speed * multiplier * (0.88 + 0.12 * Math.sin(world.time * 2.6 + entity.phase * 6.28))
      const stepX = Math.cos(entity.heading) * pace * dt
      const stepY = Math.sin(entity.heading) * pace * dt
      if (canStand(world, species, entity.x + stepX, entity.y + stepY)) {
        entity.x += stepX
        entity.y += stepY
      } else if (canStand(world, species, entity.x + stepX, entity.y)) {
        entity.x += stepX
        entity.heading = nextRandom(world) * Math.PI * 2
      } else if (canStand(world, species, entity.x, entity.y + stepY)) {
        entity.y += stepY
        entity.heading = nextRandom(world) * Math.PI * 2
      } else {
        entity.heading = nextRandom(world) * Math.PI * 2
      }
      entity.x = clamp(entity.x, 0.05, world.width - 0.05)
      entity.y = clamp(entity.y, 0.05, world.height - 0.05)
    }

    /**
     * Pick the most nutritious producer cell within vision, preferring closer
     * ones. Sampling beats a full scan and produces natural grazing paths.
     * @param {object} world - the world.
     * @param {object} entity - the hungry grazer.
     * @param {object} species - species row.
     * @returns {object|null} `{ x, y }` cell centre, or null when nothing is in reach.
     */
    function findFlora(world, entity, species, anchor) {
      const field = floraField(world, species)
      if (field === null) return null
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const radius = entity.genes.vision
      let best = null
      let bestScore = 0.05
      for (let attempt = 0; attempt < 9; attempt++) {
        const angle = nextRandom(world) * Math.PI * 2
        const distance = 1 + nextRandom(world) * radius
        const x = (entity.x + Math.cos(angle) * distance) | 0
        const y = (entity.y + Math.sin(angle) * distance) | 0
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== wanted) continue
        const herdBias = anchor === undefined || anchor === null
          ? 0
          : Math.hypot(x - anchor.x, y - anchor.y) * 0.007
        const score = field[index] - distance * 0.012 - herdBias
        if (score > bestScore) { bestScore = score; best = { x: x + 0.5, y: y + 0.5 } }
      }
      return best
    }

    /**
     * Nearest prey of a hunter, honouring the species' preference order.
     *
     * `prey` is ordered: a wolf lists deer first, so it looks for a deer and
     * only falls back to rabbits when no deer is in sight. Without the ordering
     * wolves would simply eat whatever is closest — usually rabbits — and the
     * deer population would run unmanaged.
     * @param {object} entity - the hunter.
     * @param {object} species - hunter species row.
     * @param {object} grid - grid of all animals.
     * @param {number} radius - search radius in cells.
     * @returns {object|null} the chosen prey.
     */
    function nearestPrey(entity, species, grid, radius) {
      for (const preyId of species.prey) {
        const found = queryNearest(grid, entity.x, entity.y, radius,
          candidate => candidate.fate === '' && candidate.species === preyId)
        if (found !== null) return found
      }
      return null
    }

    /**
     * Nearest plant still carrying leaves, for browsing deer.
     * @param {object} world - the world.
     * @param {object} entity - the deer.
     * @param {number} radius - reach in cells.
     * @returns {object|null} the plant.
     */
    function nearestFoliage(world, entity, radius) {
      let best = null
      let bestDistance = radius * radius
      for (const plant of world.trees) {
        if ((plant.foliage ?? 0) <= 0.06) continue
        const dx = plant.x - entity.x
        const dy = plant.y - entity.y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = plant }
      }
      return best
    }

    /**
     * Best leafy plant within vision: the browser's equivalent of `findFlora`.
     * @param {object} world - the world.
     * @param {object} entity - the deer.
     * @param {number} radius - vision radius in cells.
     * @returns {object|null} the plant, or null when nothing leafy is in reach.
     */
    function findFoliage(world, entity, radius) {
      let best = null
      let bestScore = 0.2
      for (const plant of world.trees) {
        const dx = plant.x - entity.x
        const dy = plant.y - entity.y
        const distance = Math.hypot(dx, dy)
        if (distance > radius) continue
        const available = plant.foliage ?? 0
        const score = available - distance * 0.02
        if (score > bestScore) { bestScore = score; best = plant }
      }
      return best
    }

    /**
     * Steer one animal for this think tick.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grid - grid of all animals.
     */
    // ---------------------------------------------------------------------
    // Needs, temperament and life stages
    // ---------------------------------------------------------------------
    //
    // Every animal carries five need channels (0 = satisfied, 1 = critical) and
    // picks an intention by scoring candidate actions against them. Behaviour is
    // therefore data, not an if-chain: a new species only needs a role and a few
    // trait numbers, and later systems (settlements, trade, war) can read the
    // same intent field instead of guessing what an animal is doing.

    /** Need channels every animal has. */
    const NEED_KEYS = ['hunger', 'thirst', 'energy', 'safety', 'social']

    /** Temperament defaults by feeding role; a species row may override `traits`. */
    const ROLE_TRAITS = {
      grazer: { bold: 0.35, social: 0.8, curious: 0.45, territorial: 0.25 },
      hunter: { bold: 0.85, social: 0.5, curious: 0.7, territorial: 0.8 },
      scavenger: { bold: 0.6, social: 0.75, curious: 0.95, territorial: 0.2 },
    }

    /** How loud each need is, per role: a rabbit values safety over food. */
    const NEED_WEIGHT = {
      grazer: { hunger: 1.2, thirst: 0.75, energy: 0.75, safety: 2.6, social: 0.35 },
      hunter: { hunger: 1.55, thirst: 0.8, energy: 0.85, safety: 1.7, social: 0.35 },
      scavenger: { hunger: 1.35, thirst: 0.85, energy: 0.6, safety: 1.2, social: 0.6 },
    }

    /** Size, speed and appetite multipliers per life stage. */
    const STAGE_SCALE = { juvenile: 0.6, adult: 1, elder: 1.03 }
    const STAGE_SPEED = { juvenile: 0.78, adult: 1, elder: 0.82 }
    const STAGE_APPETITE = { juvenile: 1.3, adult: 1, elder: 0.85 }

    /** Intent ids; the UI translates them, nothing else enumerates them. */
    const INTENT_IDS = ['flee', 'forage', 'hunt', 'scavenge', 'drink', 'rest', 'socialize', 'explore']

    /**
     * Temperament for a species (row override, else role default).
     * @param {object} species - species row.
     * @returns {object} trait record.
     */
    function traitsOf(species) {
      return species.traits ?? ROLE_TRAITS[species.role] ?? ROLE_TRAITS.grazer
    }

    /**
     * The need record of an entity, created on first use so restored saves work.
     * @param {object} entity - the animal.
     * @returns {object} mutable needs.
     */
    function needsOf(entity) {
      if (entity.needs === undefined) {
        entity.needs = { hunger: 0.32, thirst: 0.28, energy: 0.15, safety: 0, social: 0.3 }
      }
      return entity.needs
    }

    /**
     * Life stage from age: juveniles are smaller, slower and cannot breed.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {'juvenile'|'adult'|'elder'} stage.
     */
    function stageOf(entity, species) {
      const maturity = species.balance.maturity
      const elder = species.balance.elderAt ?? maturity * 2.6
      if (entity.age < maturity) return 'juvenile'
      if (entity.age > elder) return 'elder'
      return 'adult'
    }

    /**
     * Grow every need channel for one tick.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     */
    function decayNeeds(world, entity, species, dt) {
      const needs = needsOf(entity)
      const stage = stageOf(entity, species)
      const appetite = STAGE_APPETITE[stage] * entity.genes.metabolism
      const night = daylight(world) < 0.3
      needs.hunger = clamp(needs.hunger + 0.0105 * appetite * dt, 0, 1)
      needs.thirst = clamp(needs.thirst + 0.0082 * appetite * dt, 0, 1)
      needs.energy = clamp(needs.energy + 0.0068 * (night ? 1.7 : 0.85) * dt, 0, 1)
      needs.social = clamp(needs.social + 0.006 * traitsOf(species).social * dt, 0, 1)
      needs.safety = clamp(needs.safety - 0.3 * dt, 0, 1)
    }

    /**
     * Nearest reachable water cell, for drinking.
     * @param {object} world - the world.
     * @param {number} x - origin column.
     * @param {number} y - origin row.
     * @param {number} radius - search radius in cells.
     * @returns {{x: number, y: number}|null} water cell.
     */
    function nearestWater(world, x, y, radius) {
      const reach = Math.max(2, Math.round(radius))
      let best = null
      let bestDistance = Infinity
      for (let step = 1; step <= reach; step += 1) {
        const samples = step * 8
        for (let index = 0; index < samples; index += 1) {
          const angle = (index / samples) * Math.PI * 2
          const cellX = Math.round(x + Math.cos(angle) * step)
          const cellY = Math.round(y + Math.sin(angle) * step)
          if (cellX < 0 || cellY < 0 || cellX >= world.width || cellY >= world.height) continue
          if (world.terrain[cellY * world.width + cellX] !== TERRAIN.WATER) continue
          const distance = step
          if (distance < bestDistance) {
            bestDistance = distance
            best = { x: cellX, y: cellY }
          }
        }
        if (best !== null) return best
      }
      return best
    }

    /**
     * Score the candidate actions and commit to the best one.
     *
     * This is the whole decision system: each option gets a score from the
     * needs it would satisfy, the temperament of the species, and the distance
     * it would cost. The winner becomes `entity.intent`, which the renderer,
     * the inspector and any future social layer can read directly.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     */
    function decide(world, entity, species, grids) {
      const genes = entity.genes
      const balance = species.balance
      const needs = needsOf(entity)
      const traits = traitsOf(species)
      const weights = NEED_WEIGHT[species.role] ?? NEED_WEIGHT.grazer
      const options = []
      const offer = (kind, score, x, y) => {
        if (score > 0) options.push({ kind, score, x, y })
      }

      // --- safety: a spotted predator always wins -------------------------
      if (species.role === 'grazer') {
        const predators = PREDATORS_OF[entity.species]
        const threat = queryNearest(grids.hunter, entity.x, entity.y, genes.vision,
          candidate => candidate.fate === '' && predators.has(candidate.species))
        if (threat !== null) {
          entity.alarm = ALARM_SECONDS
          entity.threatX = threat.x
          entity.threatY = threat.y
          spreadAlarm(entity, species, grids.prey, threat, world)
        }
        const threatX = threat !== null ? threat.x : entity.threatX
        const threatY = threat !== null ? threat.y : entity.threatY
        const distance = threatX === undefined || threatY === undefined
          ? Infinity
          : Math.hypot(entity.x - threatX, entity.y - threatY)
        // Bold animals let a threat come closer before they bolt.
        const nerve = genes.vision * (1.05 + traits.bold * 0.75)
        if (threat !== null || distance < nerve) {
          needs.safety = Math.max(needs.safety, threat !== null ? 1 : 0.75)
        }
      }
      if (needs.safety > 0.45) {
        const threatX = entity.threatX ?? entity.x - 1
        const threatY = entity.threatY ?? entity.y
        const dx = entity.x - threatX
        const dy = entity.y - threatY
        const length = Math.hypot(dx, dy) || 1
        offer('flee', weights.safety * needs.safety + 6,
          clamp(entity.x + (dx / length) * genes.vision * 1.5, 1, world.width - 2),
          clamp(entity.y + (dy / length) * genes.vision * 1.5, 1, world.height - 2))
      }

      // --- food ------------------------------------------------------------
      if (species.role === 'grazer') {
        const anchor = species.herd === undefined ? null : (entity.herdAnchor ?? null)
        const patch = findFlora(world, entity, species, anchor)
        if (patch !== null) {
          const pull = anchor === null ? 0 : 0.22
          const x = patch.x + (anchor === null ? 0 : (anchor.x - patch.x) * pull)
          const y = patch.y + (anchor === null ? 0 : (anchor.y - patch.y) * pull)
          offer('forage', weights.hunger * (needs.hunger + 0.3), x, y)
        } else if (species.browse === true) {
          const plant = findFoliage(world, entity, genes.vision)
          if (plant !== null) offer('forage', weights.hunger * (needs.hunger + 0.06), plant.x, plant.y)
        }
      } else if (species.role === 'hunter') {
        const prey = nearestPrey(entity, species, grids.prey, genes.vision)
        // Prey in sight beats water or a nap: predators commit to a chase.
        if (prey !== null) offer('hunt', weights.hunger * (needs.hunger + 0.25) * 1.7, prey.x, prey.y)
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision)
        if (corpse !== null) offer('scavenge', weights.hunger * (needs.hunger - 0.1), corpse.x, corpse.y)
      } else {
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision)
        if (corpse !== null) offer('scavenge', weights.hunger * (needs.hunger + 0.2), corpse.x, corpse.y)
      }

      // --- water -----------------------------------------------------------
      if (needs.thirst > 0.2 && species.habitat !== 'water') {
        const water = nearestWater(world, entity.x, entity.y, genes.vision)
        if (water !== null) offer('drink', weights.thirst * (needs.thirst + 0.1), water.x, water.y)
      }

      // --- rest ------------------------------------------------------------
      // Diurnal animals rest harder at night; night animals rest by day.
      const activity = activityFactor(world, species)
      const restBias = activity < 0.6 ? 1.35 : 0.9
      if (needs.hunger < 0.62) {
        offer('rest', weights.energy * (needs.energy + 0.05) * restBias, entity.x, entity.y)
      }

      // --- company ---------------------------------------------------------
      if (species.herd !== undefined && needs.hunger < 0.65) {
        let anchorPoint = entity.herdAnchor ?? null
        if (entity.herdTimer <= 0 || anchorPoint === null) {
          anchorPoint = herdCentroid(entity, species, species.role === 'hunter' ? grids.hunter : grids.prey)
          entity.herdAnchor = anchorPoint
          entity.herdTimer = 0.8
        }
        if (anchorPoint !== null) {
          const crowd = entity.herdAnchor !== null
          offer('socialize', weights.social * (needs.social + (crowd ? 0.1 : 0.25)),
            anchorPoint.x, anchorPoint.y)
        }
      }

      // --- wander ----------------------------------------------------------
      if (traits.curious > 0 && needs.hunger < 0.55 && needs.safety < 0.2) {
        const angle = nextRandom(world) * Math.PI * 2
        const reach = genes.vision * (0.5 + traits.curious * 0.6)
        offer('explore', traits.curious * 0.55,
          clamp(entity.x + Math.cos(angle) * reach, 1, world.width - 2),
          clamp(entity.y + Math.sin(angle) * reach, 1, world.height - 2))
      }

      // Distance is a cost, not a blocker: a far meal still beats starving.
      let best = null
      for (const option of options) {
        const distance = Math.hypot(option.x - entity.x, option.y - entity.y)
        const scored = option.score - Math.min(0.45, distance / Math.max(4, genes.vision * 3))
        if (best === null || scored > best.score) best = { ...option, score: scored }
      }
      if (best === null) {
        best = { kind: 'explore', score: 0, x: entity.x, y: entity.y }
      }
      entity.intent = best.kind
      entity.intentScore = best.score
      entity.targetX = best.x
      entity.targetY = best.y
      entity.fleeing = best.kind === 'flee'
      if (entity.fleeing) {
        entity.flightTime = entity.flightTime ?? 0
      } else {
        entity.flightTime = 0
      }
      // Standing still is a behaviour, not a failure: the animal is resting.
      if (best.kind === 'rest') {
        entity.targetX = entity.x
        entity.targetY = entity.y
      }
    }


    /**
     * Feed one animal: graze a producer field, catch prey, or scavenge a corpse.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grid - grid of all animals.
     * @param {number} dt - step in seconds.
     */
    function feed(world, entity, species, grids, dt) {
      const balance = species.balance
      const needs = needsOf(entity)
      if (entity.intent === 'drink' && species.habitat !== 'water') {
        const index = cellIndex(world, entity.x, entity.y)
        if (index >= 0) {
          const column = index % world.width
          const row = Math.floor(index / world.width)
          let adjacentWater = false
          for (let offsetY = -1; offsetY <= 1 && !adjacentWater; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const cellX = column + offsetX
              const cellY = row + offsetY
              if (cellX < 0 || cellY < 0 || cellX >= world.width || cellY >= world.height) continue
              if (world.terrain[cellY * world.width + cellX] === TERRAIN.WATER) { adjacentWater = true; break }
            }
          }
          if (adjacentWater) {
            needs.thirst = clamp(needs.thirst - 0.85 * dt, 0, 1)
            entity.energy = Math.min(balance.maxEnergy, entity.energy + 0.4 * dt)
            return
          }
        }
      }      if (species.role === 'grazer') {
        // Opportunistic grazing: an animal standing in good grass nibbles even
        // while it is resting or watching the herd — otherwise it starves in a
        // meadow, which is what a strict intent gate caused.
        if (entity.intent !== 'forage' && needs.hunger < 0.45) return
        const field = floraField(world, species)
        if (field === null) return
        const index = cellIndex(world, entity.x, entity.y)
        const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
        if (index >= 0 && world.terrain[index] === wanted) {
          const available = field[index]
          if (available > 0.02) {
            const bite = Math.min(available, balance.eatRate * dt)
            field[index] = available - bite
            entity.energy += bite * balance.floraEnergy
            needs.hunger = clamp(needs.hunger - bite * 0.55, 0, 1)
            if (nextRandom(world) < 0.06) spawnEffect(world, entity.x, entity.y + 0.4, PALETTE.effect.eat, 0.3, 0.35)
            return
          }
        }
        // Browsers strip the canopy after the ground is bare.
        if (species.browse === true) {
          const plant = nearestFoliage(world, entity, 1.6)
          if (plant !== null) {
            const bite = Math.min(plant.foliage, balance.browseRate * dt)
            plant.foliage -= bite
            entity.energy += bite * balance.browseEnergy
            needs.hunger = clamp(needs.hunger - bite * 0.45, 0, 1)
          }
        }
        return
      }

      if (species.role === 'hunter') {
        const victim = nearestPrey(entity, species, grids.prey, balance.catchRadius)
        if (victim !== null) {
          victim.fate = 'eaten'
          victim.energy = 0
          entity.energy += SPECIES[victim.species].meat
          needs.hunger = clamp(needs.hunger - 0.85, 0, 1)
          for (let spark = 0; spark < 5; spark++) spawnEffect(world, victim.x, victim.y, PALETTE.effect.hunt, 0.42, 1.4)
          entity.targetX = victim.x
          entity.targetY = victim.y
          return
        }
        if (entity.energy < balance.maxEnergy * 0.65) {
          const corpse = nearestCorpse(world, entity.x, entity.y, 1.2)
          if (corpse !== null) {
            entity.energy += corpse.energy * (balance.scavengeShare ?? 0.4)
            world.corpses.splice(world.corpses.indexOf(corpse), 1)
          }
        }
        return
      }
      const corpse = nearestCorpse(world, entity.x, entity.y, balance.scavengeRadius)
      if (corpse !== null) {
        entity.energy += corpse.energy * (balance.corpseShare ?? 0.8)
        world.corpses.splice(world.corpses.indexOf(corpse), 1)
      }
    }

    /**
     * One animal's full tick: think, feed, move, age, breed.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @param {object} grid - grid of all animals.
     * @returns {boolean} false when the animal died this tick.
     */
    function stepEntity(world, entity, dt, grids) {
      const species = SPECIES[entity.species]
      if (species === undefined) return false
      const balance = species.balance
      const genes = entity.genes
      // A predator may have bitten this animal earlier in the same tick. It must
      // die before `feed()` runs, otherwise it would graze back the energy the
      // predator already took and stay alive with `fate === 'eaten'` forever.
      if (entity.fate === 'eaten') {
        killEntity(world, entity)
        return false
      }
      entity.prevX = entity.x
      entity.prevY = entity.y
      entity.age += dt
      entity.cooldown = Math.max(0, entity.cooldown - dt)
      entity.thinkTimer -= dt
      entity.alarm = Math.max(0, (entity.alarm ?? 0) - dt)
      entity.herdTimer = (entity.herdTimer ?? 0) - dt
      decayNeeds(world, entity, species, dt)
      entity.stage = stageOf(entity, species)
      if (entity.thinkTimer <= 0) {
        entity.thinkTimer = randomBetween(world, 0.22, 0.55)
        decide(world, entity, species, grids)
      }
      feed(world, entity, species, grids, dt)
      const activity = activityFactor(world, species)
      const stageSpeed = STAGE_SPEED[entity.stage] ?? 1
      let pace
      if (entity.intent === 'rest') {
        // Resting is visible: the animal stops and the energy bar recovers.
        pace = 0.12
      } else if (species.ambush !== undefined && entity.intent === 'hunt') {
        // The pike does not chase: it drifts in, then strikes from cover.
        const distance = Math.hypot(entity.targetX - entity.x, entity.targetY - entity.y)
        pace = distance > species.ambush.strikeDistance ? species.ambush.approach : species.ambush.strikeSpeed
      } else if (entity.fleeing) {
        entity.flightTime = (entity.flightTime ?? 0) + dt
        const flight = species.flight
        pace = flight === undefined
          ? (balance.fleeSpeed ?? 1)
          : (entity.flightTime < flight.burstSeconds ? flight.burst : flight.tired)
      } else {
        entity.flightTime = 0
        pace = entity.intent === 'hunt' || entity.intent === 'scavenge' ? (balance.huntSpeed ?? 1) : 1
      }
      moveToward(world, entity, species, entity.targetX, entity.targetY, dt, pace * activity * stageSpeed)
      entity.energy -= (balance.drain * genes.metabolism + (entity.fleeing ? (balance.fleeDrain ?? 0) : 0)) * dt
      if (entity.energy <= 0 || entity.age > genes.lifespan) {
        killEntity(world, entity)
        return false
      }
      entity.energy = Math.min(entity.energy, balance.maxEnergy)

      const territory = species.territory
      const ownGrid = species.role === 'hunter' ? grids.hunter : grids.prey
      const crowded = territory !== undefined && countNearby(ownGrid, entity.x, entity.y, territory.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species) >= territory.max
      // Juveniles are still growing: only adults reproduce.
      if (!crowded && entity.stage === 'adult' && entity.energy >= balance.breedEnergy && entity.cooldown <= 0) {
        // A litter, not a single pup: rabbits drop 4-7 kits at once, wolves 3-5.
        const range = balance.litter ?? [1, 1]
        const litterSize = range[0] + Math.floor(nextRandom(world) * (range[1] - range[0] + 1))
        let born = 0
        for (let index = 0; index < litterSize; index++) {
          const childX = clamp(entity.x + randomBetween(world, -1.1, 1.1), 0.5, world.width - 1.5)
          const childY = clamp(entity.y + randomBetween(world, -1.1, 1.1), 0.5, world.height - 1.5)
          if (!canStand(world, species, childX, childY)) continue
          const child = spawnEntity(world, entity.species, childX, childY,
            mutateGenes(world, genes, entity.species), entity.generation + 1)
          if (child === null) break
          child.energy = balance.startEnergy * 0.4
          born += 1
        }
        if (born > 0) {
          for (let heart = 0; heart < 3; heart++) spawnEffect(world, entity.x, entity.y - 0.5, PALETTE.effect.birth, 0.8, 0.5)
          entity.energy -= balance.breedCost
          entity.cooldown = genes.fertility
          entity.children += born
        }
      }
      return true
    }

    /**
     * Update every animal for one tick.
     * The list is snapshotted first so animals born this tick wait for the next
     * one, and eaten prey is removed through the normal death path.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function stepEntities(world, dt) {
      const existing = world.entities
      const count = existing.length
      // Two grids, not one: with herds the "prey" buckets get very dense, and a
      // predator scanning them for a neighbour would touch hundreds of kin.
      const prey = []
      const hunters = []
      for (let i = 0; i < count; i++) {
        if (SPECIES[existing[i].species]?.role === 'hunter') hunters.push(existing[i])
        else prey.push(existing[i])
      }
      const grids = {
        prey: buildGrid(world, prey, 8),
        hunter: buildGrid(world, hunters, 12),
      }
      let write = 0
      for (let i = 0; i < count; i++) {
        const entity = existing[i]
        if (stepEntity(world, entity, dt, grids)) existing[write++] = entity
      }
      const newborns = existing.slice(count)
      existing.length = write
      for (const newborn of newborns) existing.push(newborn)
    }

    /**
     * Grow a producer field (logistic, daylight- and water-scaled) on its own
     * terrain type, and clear it everywhere else.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     * @param {Float32Array} field - `grass` or `weed`.
     * @param {number} terrainWanted - the only terrain this field lives on.
     * @param {Float32Array} nutrient - per-cell nutrient multiplier.
     */
    /** Vegetation is refreshed in this many interleaved slices (see below). */
    const GROWTH_SLICES = 8

    function growField(world, dt, field, terrainWanted, nutrient) {
      const light = daylight(world)
      const slice = world.tick % GROWTH_SLICES
      const scaled = dt * GROWTH_SLICES
      // Refreshing every cell every tick costs more than everything else in the
      // simulation put together (two 64k-cell passes per tick). Each cell is
      // therefore updated on one tick in GROWTH_SLICES with a matching dt, which
      // gives the same average growth rate for a quarter of the work.
      for (let i = slice; i < field.length; i += GROWTH_SLICES) {
        if (world.terrain[i] !== terrainWanted) {
          if (field[i] !== 0) field[i] = 0
          continue
        }
        const nutrientHere = nutrient[i]
        if (nutrientHere <= 0) continue
        const current = field[i]
        const rate = TUNING.growth * nutrientHere * (0.5 + 0.5 * world.moisture[i]) * (0.35 + 0.65 * light)
        const next = current + scaled * rate * (0.12 + current) * (1.02 - current)
        field[i] = next > 1 ? 1 : next
      }
    }

    /** Logistic growth rate shared by grass and weed. */
    const BALANCE_GRASS_RATE = 0.115

    /**
     * Age plants, enrich the soil beneath them, and let them seed nearby cells.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function growTrees(world, dt) {
      for (const plant of world.trees) {
        plant.age += dt
        const isBush = plant.variant === 'bush'
        // Leaves regrow after browsing; bushes are the fast-growing snack.
        plant.foliage = Math.min(1, (plant.foliage ?? 1) + dt * (isBush ? 0.075 : 0.045))
        if (!isBush && plant.size < 3 && plant.age > plant.size * 70) plant.size += 1
        const radius = isBush ? 1 : 1 + plant.size
        const enrich = isBush ? 0.03 : 0.05
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue
            const index = cellIndex(world, plant.x + dx, plant.y + dy)
            if (index < 0 || world.terrain[index] !== TERRAIN.GRASS) continue
            world.fertility[index] = Math.min(1, world.fertility[index] + dt * enrich)
          }
        }
        plant.seedTimer -= dt
        if (plant.seedTimer > 0) continue
        plant.seedTimer = isBush ? randomBetween(world, 18, 44) : randomBetween(world, 30, 70)
        if (world.trees.length >= MAX_TREES) continue
        const spread = isBush ? 4 : 6
        const x = clamp(Math.round(plant.x + randomBetween(world, -spread, spread)), 1, world.width - 2)
        const y = clamp(Math.round(plant.y + randomBetween(world, -spread, spread)), 1, world.height - 2)
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== TERRAIN.GRASS || world.fertility[index] < 0.5) continue
        let crowded = false
        for (const other of world.trees) {
          if (Math.abs(other.x - x) < 3 && Math.abs(other.y - y) < 3) { crowded = true; break }
        }
        if (crowded) continue
        world.trees.push({
          id: world.nextId++,
          x,
          y,
          variant: nextRandom(world) < 0.34 ? 'bush' : 'tree',
          size: 1,
          age: 0,
          foliage: 1,
          seedTimer: randomBetween(world, 30, 80),
        })
      }
    }

    /**
     * Rot carcasses, feeding the soil (or the shallows) around them.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function decayCorpses(world, dt) {
      let write = 0
      for (let i = 0; i < world.corpses.length; i++) {
        const corpse = world.corpses[i]
        corpse.decay += dt / TUNING.corpseSeconds
        const x = corpse.x | 0
        const y = corpse.y | 0
        const inWater = terrainAt(world, x, y) === TERRAIN.WATER
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const index = cellIndex(world, x + dx, y + dy)
            if (index < 0) continue
            const terrain = world.terrain[index]
            if (inWater && terrain === TERRAIN.WATER) {
              world.waterFertility[index] = Math.min(1, world.waterFertility[index] + dt * 0.35)
            } else if (!inWater && terrain === TERRAIN.GRASS) {
              world.fertility[index] = Math.min(1, world.fertility[index] + dt * 0.4)
            }
          }
        }
        if (corpse.decay < 1) world.corpses[write++] = corpse
      }
      world.corpses.length = write
    }

    /** Seconds between immigration checks. */
    const IMMIGRATION_INTERVAL = [45, 85]

    /**
     * Safety net: a species that has been wiped out (or nearly) gets a small
     * group wandering in from off-map.
     *
     * An unassisted food web can end in a dead lake — the player comes back to a
     * world with nothing moving and nothing to watch. Immigration makes the sand
     * box self-healing without pretending the die-off did not happen; the player
     * can still pause time and play god by hand.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function handleImmigration(world, dt) {
      if (world.immigration === false) return
      if (!Number.isFinite(world.immigrationTimer)) {
        world.immigrationTimer = randomBetween(world, TUNING.immigration[0], TUNING.immigration[1])
      }
      world.immigrationTimer -= dt
      if (world.immigrationTimer > 0) return
      world.immigrationTimer = randomBetween(world, TUNING.immigration[0], TUNING.immigration[1])
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const minimum = species.minimum ?? 2
        // Count from the entity list, not the cached counter: any code path that
        // replaces world.entities wholesale would leave the cache stale, and
        // immigration must never skip a species that is actually gone.
        if (countSpecies(world, id) >= minimum) continue
        const group = 4 + ((nextRandom(world) * 5) | 0)
        let placed = 0
        for (let attempt = 0; attempt < group * 60 && placed < group; attempt++) {
          const x = randomBetween(world, 1, world.width - 2)
          const y = randomBetween(world, 1, world.height - 2)
          if (!canStand(world, species, x, y)) continue
          if (species.habitat === 'land' && terrainAt(world, x, y) !== TERRAIN.GRASS) continue
          if (species.habitat === 'air' && terrainAt(world, x, y) === TERRAIN.STONE) continue
          if (spawnEntity(world, id, x, y) !== null) placed += 1
        }
        if (placed > 0) world.lastImmigration = { species: id, count: placed, at: world.time }
      }
    }

    /**
     * Queue one short-lived visual effect.
     *
     * Effects are what makes behaviour readable at sprite size: a grazing bite,
     * a kill, a birth and a death all look the same in a 3-pixel sprite unless
     * something pops. They are pure decoration — never read back by the sim.
     * @param {object} world - the world.
     * @param {number} x - position.
     * @param {number} y - position.
     * @param {number} color - packed colour.
     * @param {number} [life] - seconds.
     * @param {number} [spread] - initial velocity in cells/s.
     */
    function spawnEffect(world, x, y, color, life = 0.35, spread = 0.6) {
      if (world.effects.length > 220) world.effects.shift()
      world.effects.push({
        x,
        y,
        vx: randomBetween(world, -spread, spread),
        vy: randomBetween(world, -spread, spread) - 0.2,
        life,
        maxLife: life,
        color,
      })
    }

    /**
     * Age every effect and drop the expired ones.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function stepEffects(world, dt) {
      let write = 0
      for (let i = 0; i < world.effects.length; i++) {
        const effect = world.effects[i]
        effect.life -= dt
        if (effect.life <= 0) continue
        effect.x += effect.vx * dt
        effect.y += effect.vy * dt
        effect.vy += dt * 1.6
        world.effects[write++] = effect
      }
      world.effects.length = write
    }

    /**
     * Advance the world by `dt` seconds.
     * @param {object} world - the world.
     * @param {number} dt - seconds; clamped to 0.5 and ignored when <= 0 or NaN.
     */
    function stepWorld(world, dt) {
      if (typeof dt !== 'number' || !(dt > 0)) return
      settleTerrain(world)
      const step = Math.min(dt, 0.5)
      world.tick += 1
      world.time += step
      growField(world, step, world.grass, TERRAIN.GRASS, world.fertility)
      growField(world, step, world.weed, TERRAIN.WATER, world.waterFertility)
      growTrees(world, step)
      decayCorpses(world, step)
      stepEffects(world, step)
      handleImmigration(world, step)
      stepEntities(world, step)
    }

    // ---------------------------------------------------------------------
    // Player interaction: terrain, producers, plants, animals
    // ---------------------------------------------------------------------

    /** Terrain tools and the code each paints. */
    const TERRAIN_TOOLS = {
      water: TERRAIN.WATER,
      sand: TERRAIN.SAND,
      dirt: TERRAIN.DIRT,
      stone: TERRAIN.STONE,
    }

    /**
     * Visit every cell in a square brush footprint.
     * Square beats circular for terrain painting: strokes tile predictably.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - half edge in cells (0 = single cell).
     * @param {(index: number, x: number, y: number) => void} visit - callback.
     */
    function forEachBrushCell(world, cx, cy, radius, visit) {
      const centreX = Math.round(cx)
      const centreY = Math.round(cy)
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = centreX + dx
          const y = centreY + dy
          const index = cellIndex(world, x, y)
          if (index >= 0) visit(index, x, y)
        }
      }
    }

    /**
     * Remove every animal, plant and carcass inside a brush square.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - half edge in cells.
     */
    function clearBrushArea(world, cx, cy, radius) {
      const centreX = Math.round(cx)
      const centreY = Math.round(cy)
      const inside = (x, y) => Math.abs(x - centreX) <= radius && Math.abs(y - centreY) <= radius
      forEachBrushCell(world, cx, cy, radius, (index) => {
        world.grass[index] = 0
        world.weed[index] = 0
      })
      world.entities = world.entities.filter(entity => !inside(entity.x | 0, entity.y | 0))
      world.population = countPopulations(world)
      world.trees = world.trees.filter(plant => !inside(plant.x, plant.y))
      world.corpses = world.corpses.filter(corpse => !inside(corpse.x | 0, corpse.y | 0))
    }

    /**
     * Repaint terrain inside a brush square, drowning or evicting what cannot
     * live on the new surface.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - half edge in cells.
     * @param {number} terrain - the new terrain code.
     */
    function paintTerrain(world, cx, cy, radius, terrain) {
      const centreX = Math.round(cx)
      const centreY = Math.round(cy)
      const inside = (x, y) => Math.abs(x - centreX) <= radius && Math.abs(y - centreY) <= radius
      forEachBrushCell(world, cx, cy, radius, (index) => {
        const previous = world.terrain[index]
        if (previous === terrain) return
        world.terrain[index] = terrain
        world.grass[index] = 0
        world.weed[index] = 0
        world.fertility[index] = 0
        world.waterFertility[index] = 0
        if (terrain === TERRAIN.WATER) {
          world.weed[index] = 0.2
          world.waterFertility[index] = 0.6
        }
      })
      world.hydrologyDirty = true
      const drowned = world.entities.filter((entity) => {
        const species = SPECIES[entity.species]
        if (species === undefined || species.habitat === 'air') return false
        const x = entity.x | 0
        const y = entity.y | 0
        if (!inside(x, y)) return false
        const here = world.terrain[cellIndex(world, x, y)]
        const wantsWater = species.habitat === 'water'
        return wantsWater ? here !== TERRAIN.WATER : (here === TERRAIN.WATER || here === TERRAIN.STONE)
      })
      if (drowned.length > 0) {
        const drownedIds = new Set(drowned.map(entity => entity.id))
        world.entities = world.entities.filter(entity => !drownedIds.has(entity.id))
        world.population = countPopulations(world)
      }
      if (terrain === TERRAIN.WATER || terrain === TERRAIN.STONE) {
        world.trees = world.trees.filter(plant => !inside(plant.x, plant.y))
      }
    }

    /**
     * Sow one producer field inside a brush square.
     * `grass` also reclaims sand and soil; `weed` only takes existing water.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - half edge in cells.
     * @param {'grass'|'weed'} kind - which producer.
     */
    function sowProducer(world, cx, cy, radius, kind) {
      forEachBrushCell(world, cx, cy, radius, (index) => {
        const terrain = world.terrain[index]
        if (kind === 'grass') {
          if (terrain === TERRAIN.WATER || terrain === TERRAIN.STONE) return
          if (terrain !== TERRAIN.GRASS) {
            world.terrain[index] = TERRAIN.GRASS
            world.fertility[index] = Math.max(world.fertility[index], 0.45)
            world.hydrologyDirty = true
          }
          world.grass[index] = 1
        } else if (terrain === TERRAIN.WATER) {
          world.weed[index] = 1
        }
      })
    }

    /**
     * Plant one tree or shrub at the brush centre.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {'tree'|'bush'} variant - which plant.
     */
    function plantFlora(world, cx, cy, variant) {
      const x = Math.round(cx)
      const y = Math.round(cy)
      const index = cellIndex(world, x, y)
      if (index < 0 || world.terrain[index] !== TERRAIN.GRASS) return
      for (const plant of world.trees) {
        if (Math.abs(plant.x - x) < 2 && Math.abs(plant.y - y) < 2) return
      }
      if (world.trees.length >= MAX_TREES) return
      world.trees.push({
        id: world.nextId++,
        x,
        y,
        variant,
        size: variant === 'bush' ? 1 : 2,
        age: 40,
        foliage: 1,
        seedTimer: randomBetween(world, 30, 70),
      })
    }

    /**
     * Release a small group of one species inside the brush square.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - half edge in cells.
     * @param {string} speciesId - species id.
     */
    /**
     * Closest cell this species can actually occupy.
     *
     * Clicking water with a rabbit used to do nothing at all, which reads as a
     * broken tool. Placement now slides to the nearest legal cell instead.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {number} x - wanted column.
     * @param {number} y - wanted row.
     * @returns {{x: number, y: number}|null} legal cell.
     */
    function nearestValidCell(world, species, x, y) {
      const startX = clamp(Math.round(x), 1, world.width - 2)
      const startY = clamp(Math.round(y), 1, world.height - 2)
      if (canStand(world, species, startX, startY)) return { x: startX, y: startY }
      for (let step = 1; step <= 30; step += 1) {
        const samples = Math.max(8, step * 4)
        for (let index = 0; index < samples; index += 1) {
          const angle = (index / samples) * Math.PI * 2
          const cellX = Math.round(startX + Math.cos(angle) * step)
          const cellY = Math.round(startY + Math.sin(angle) * step)
          if (cellX < 1 || cellY < 1 || cellX >= world.width - 1 || cellY >= world.height - 1) continue
          if (canStand(world, species, cellX, cellY)) return { x: cellX, y: cellY }
          }
        }
      return null
    }

    /**
     * Release animals with the brush.
     * @param {object} world - the world.
     * @param {number} cx - centre column.
     * @param {number} cy - centre row.
     * @param {number} radius - brush extent.
     * @param {string} speciesId - species to release.
     * @returns {number} how many were placed.
     */
    function releaseAnimals(world, cx, cy, radius, speciesId) {
      const species = SPECIES[speciesId]
      if (species === undefined) return 0
      const count = radius <= 0 ? 1 : radius === 1 ? 3 : 6
      let placed = 0
      for (let index = 0; index < count; index += 1) {
        const anchor = nearestValidCell(world, species,
          cx + randomBetween(world, -radius, radius),
          cy + randomBetween(world, -radius, radius))
        if (anchor === null) continue
        const animal = spawnEntity(world, speciesId, anchor.x, anchor.y, undefined, 1, { force: true })
        if (animal !== null) placed += 1
      }
      return placed
    }

    /**
     * Apply one brush stroke.
     *
     * Tools: `grass` `weed` `tree` `bush` `water` `sand` `dirt` `stone` `erase`
     * `pan` (no world change) and any species id from `SPECIES`.
     * @param {object} world - the world.
     * @param {string} tool - tool id.
     * @param {number} cx - centre column (fractional).
     * @param {number} cy - centre row (fractional).
     * @param {number} [radius] - brush half edge in cells.
     */
    function place(world, tool, cx, cy, radius = 0) {
      if (world === null || typeof tool !== 'string') return 0
      const extent = Math.max(0, radius | 0)
      if (tool === 'pointer' || tool === 'pan') return 0
      if (tool === 'erase') {
        clearBrushArea(world, cx, cy, extent)
        return
      }
      const terrain = TERRAIN_TOOLS[tool]
      if (terrain !== undefined) {
        paintTerrain(world, cx, cy, extent, terrain)
        return
      }
      if (tool === 'grass' || tool === 'weed') {
        sowProducer(world, cx, cy, extent, tool)
        return
      }
      if (tool === 'tree' || tool === 'bush') {
        plantFlora(world, cx, cy, tool)
        return
      }
      if (SPECIES[tool] !== undefined) return releaseAnimals(world, cx, cy, extent, tool)
    }

    // ---------------------------------------------------------------------
    // Statistics
    // ---------------------------------------------------------------------

    /**
     * Format the in-world clock.
     * @param {object} world - the world.
     * @returns {string} `HH:MM`, 24h.
     */
    function formatClock(world) {
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      const minutes = Math.floor(phase * 24 * 60) % 1440
      const hours = Math.floor(minutes / 60)
      return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    }

    /**
     * Snapshot the world's counters. Pure: the caller decides where to store it.
     * Producer counts are cells above a visible-vegetation threshold.
     * @param {object} world - the world.
     * @returns {object} stats record.
     */
    function sampleStats(world) {
      const counts = {}
      for (const id of SPECIES_IDS) counts[id] = 0
      for (const entity of world.entities) {
        if (counts[entity.species] === undefined) counts[entity.species] = 0
        counts[entity.species] += 1
      }
      let grassCells = 0
      let weedCells = 0
      for (let i = 0; i < world.grass.length; i++) {
        if (world.grass[i] > 0.2) grassCells += 1
        if (world.weed[i] > 0.2) weedCells += 1
      }
      return {
        day: Math.floor(world.time / DAY_SECONDS) + 1,
        clock: formatClock(world),
        grass: grassCells,
        weed: weedCells,
        counts,
        corpses: world.corpses.length,
      }
    }

    /**
     * Append one history sample (used by the population chart).
     * @param {object} world - the world.
     * @returns {object} the sample that was appended.
     */
    function pushHistory(world) {
      const stats = sampleStats(world)
      const sample = {
        t: Math.round(world.time),
        grass: stats.grass,
        weed: stats.weed,
        counts: { ...stats.counts },
      }
      world.history.push(sample)
      if (world.history.length > 200) world.history.shift()
      return sample
    }

    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------

    /**
     * Bytes → base64, chunked so a 26 KB terrain never blows the call stack.
     * @param {Uint8Array|Uint8ClampedArray} bytes - input.
     * @returns {string} base64 text.
     */
    function encodeBytes(bytes) {
      let text = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(text)
    }

    /**
     * base64 → typed array.
     * @param {string} text - base64 text.
     * @param {Function} Type - typed array constructor.
     * @returns {object} decoded typed array.
     */
    function decodeBytes(text, Type) {
      const raw = atob(String(text))
      const out = new Type(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
      return out
    }

    /**
     * Quantize a 0..1 float field to bytes (1 byte per cell keeps saves small).
     * @param {Float32Array} field - source field.
     * @returns {Uint8Array} quantized field.
     */
    function quantizeField(field) {
      const out = new Uint8Array(field.length)
      for (let i = 0; i < field.length; i++) {
        const value = field[i] * 255
        out[i] = value <= 0 ? 0 : value >= 255 ? 255 : value | 0
      }
      return out
    }

    /**
     * Expand a quantized field back to floats.
     * @param {string} text - base64 bytes.
     * @param {number} size - expected cell count.
     * @returns {Float32Array} restored field.
     */
    function dequantizeField(text, size) {
      const bytes = decodeBytes(text, Uint8Array)
      if (bytes.length !== size) throw new Error('bad field length in world save')
      const out = new Float32Array(size)
      for (let i = 0; i < size; i++) out[i] = bytes[i] / 255
      return out
    }

    /**
     * Serialize a world to a JSON-safe object.
     * Hydrology is dropped: it is recomputed from the terrain, byte for byte.
     * @param {object} world - the world.
     * @returns {object} save payload.
     */
    function serializeWorld(world) {
      return {
        version: SAVE_VERSION,
        seed: world.seed,
        width: world.width,
        height: world.height,
        tick: world.tick,
        time: world.time,
        rngState: world.rngState,
        nextId: world.nextId,
        immigration: world.immigration !== false,
        terrain: encodeBytes(world.terrain),
        fertility: encodeBytes(quantizeField(world.fertility)),
        grass: encodeBytes(quantizeField(world.grass)),
        weed: encodeBytes(quantizeField(world.weed)),
        trees: world.trees.map(plant => ({ ...plant })),
        entities: world.entities.map(entity => ({
          id: entity.id,
          species: entity.species,
          x: entity.x,
          y: entity.y,
          heading: entity.heading,
          energy: entity.energy,
          age: entity.age,
          generation: entity.generation,
          cooldown: entity.cooldown,
          thinkTimer: entity.thinkTimer,
          targetX: entity.targetX,
          targetY: entity.targetY,
          fleeing: entity.fleeing === true,
          children: entity.children ?? 0,
          phase: entity.phase,
          genes: { ...entity.genes },
        })),
        corpses: world.corpses.map(corpse => ({ ...corpse })),
        history: world.history.slice(-200),
      }
    }

    /**
     * Coerce one saved gene set, falling back to fresh genes per missing field.
     * @param {object} world - the world (RNG source for the fallback).
     * @param {string} speciesId - species id.
     * @param {unknown} genes - saved genes.
     * @returns {object} valid genes.
     */
    function restoreGenes(world, speciesId, genes) {
      const ranges = SPECIES[speciesId].genes
      const restored = {}
      for (const key of GENE_KEYS) {
        const value = genes !== null && typeof genes === 'object' ? genes[key] : undefined
        restored[key] = typeof value === 'number' && Number.isFinite(value)
          ? clamp(value, ranges[key][0], ranges[key][1])
          : randomBetween(world, ranges[key][0], ranges[key][1])
      }
      return restored
    }

    /**
     * Rebuild a world from a save payload.
     * @param {object} data - payload from `serializeWorld`.
     * @returns {object} the restored world.
     * @throws {Error} when the payload is not a save this build understands.
     */
    function deserializeWorld(data) {
      if (data === null || typeof data !== 'object' || data.version !== SAVE_VERSION) {
        throw new Error('unsupported world save')
      }
      const width = data.width | 0
      const height = data.height | 0
      if (!(width > 0 && height > 0)) throw new Error('bad world size in save')
      const size = width * height
      const world = {
        version: SAVE_VERSION,
        seed: (data.seed ?? 1) >>> 0,
        width,
        height,
        tick: Number.isFinite(data.tick) ? data.tick : 0,
        time: Number.isFinite(data.time) ? data.time : 0,
        rngState: (data.rngState ?? 1) >>> 0 || 1,
        immigration: data.immigration !== false,
        terrain: decodeBytes(data.terrain, Uint8Array),
        moisture: new Float32Array(size),
        waterFertility: new Float32Array(size),
        fertility: dequantizeField(data.fertility, size),
        grass: dequantizeField(data.grass, size),
        weed: dequantizeField(data.weed, size),
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: Number.isFinite(data.nextId) ? data.nextId : 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      if (world.terrain.length !== size) throw new Error('bad terrain in save')
      computeHydrology(world)
      for (const plant of Array.isArray(data.trees) ? data.trees : []) {
        if (!Number.isFinite(plant?.x) || !Number.isFinite(plant?.y)) continue
        world.trees.push({
          id: Number.isFinite(plant.id) ? plant.id : world.nextId++,
          x: plant.x,
          y: plant.y,
          variant: plant.variant === 'bush' ? 'bush' : 'tree',
          size: clamp(plant.size | 0 || 1, 1, 3),
          age: Number.isFinite(plant.age) ? plant.age : 0,
          foliage: clamp(Number.isFinite(plant.foliage) ? plant.foliage : 1, 0, 1),
          seedTimer: Number.isFinite(plant.seedTimer) ? plant.seedTimer : 45,
        })
      }
      for (const entity of Array.isArray(data.entities) ? data.entities : []) {
        if (SPECIES[entity?.species] === undefined) continue
        if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue
        world.entities.push({
          id: Number.isFinite(entity.id) ? entity.id : world.nextId++,
          species: entity.species,
          x: entity.x,
          y: entity.y,
          heading: Number.isFinite(entity.heading) ? entity.heading : 0,
          energy: Number.isFinite(entity.energy) ? entity.energy : SPECIES[entity.species].balance.startEnergy,
          age: Number.isFinite(entity.age) ? entity.age : 0,
          generation: Number.isFinite(entity.generation) ? entity.generation : 1,
          cooldown: Number.isFinite(entity.cooldown) ? entity.cooldown : 0,
          thinkTimer: Number.isFinite(entity.thinkTimer) ? entity.thinkTimer : 0,
          herdTimer: 0,
          herdAnchor: null,
          alarm: 0,
          targetX: Number.isFinite(entity.targetX) ? entity.targetX : entity.x,
          targetY: Number.isFinite(entity.targetY) ? entity.targetY : entity.y,
          fleeing: entity.fleeing === true,
          fate: '',
          children: Number.isFinite(entity.children) ? entity.children : 0,
          phase: Number.isFinite(entity.phase) ? entity.phase : 0,
          genes: restoreGenes(world, entity.species, entity.genes),
        })
      }
      for (const corpse of Array.isArray(data.corpses) ? data.corpses : []) {
        if (!Number.isFinite(corpse?.x) || !Number.isFinite(corpse?.y)) continue
        world.corpses.push({
          id: Number.isFinite(corpse.id) ? corpse.id : world.nextId++,
          x: corpse.x,
          y: corpse.y,
          species: SPECIES[corpse.species] === undefined ? null : corpse.species,
          decay: clamp(Number.isFinite(corpse.decay) ? corpse.decay : 0, 0, 1),
          energy: Number.isFinite(corpse.energy) ? corpse.energy : 20,
        })
      }
      world.history = Array.isArray(data.history) ? data.history.slice(-200) : []
      world.population = countPopulations(world)
      return world
    }

    // ---------------------------------------------------------------------
    // Palette and sprites
    // ---------------------------------------------------------------------


    /**
     * Pack RGB into the little-endian ARGB word `paintWorld` writes.
     * @param {number} red - 0..255.
     * @param {number} green - 0..255.
     * @param {number} blue - 0..255.
     * @returns {number} packed colour.
     */
    function rgb(red, green, blue) {
      return ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0
    }

    /** The world's palette. Artwork only: the panel chrome uses theme tokens. */
    const PALETTE = {
      water: [rgb(36, 92, 132), rgb(44, 106, 150), rgb(56, 122, 168), rgb(74, 142, 188)],
      weed: [rgb(58, 122, 96), rgb(72, 146, 108)],
      sand: [rgb(214, 194, 142), rgb(206, 184, 132), rgb(222, 202, 152)],
      dirt: [rgb(124, 98, 68), rgb(116, 90, 62), rgb(134, 106, 74)],
      stone: [rgb(126, 126, 134), rgb(112, 112, 122), rgb(140, 140, 148)],
      grassDry: [122, 118, 72],
      grassLush: [46, 106, 54],
      leaf: { dark: rgb(34, 74, 42), mid: rgb(48, 100, 50), light: rgb(72, 126, 62) },
      trunk: rgb(92, 64, 40),
      trunkDark: rgb(70, 48, 30),
      rabbit: { body: rgb(158, 132, 104), belly: rgb(238, 228, 212), ear: rgb(196, 162, 148), eye: rgb(38, 28, 22) },
      deer: { body: rgb(136, 94, 58), belly: rgb(206, 182, 152), antler: rgb(178, 156, 116), eye: rgb(36, 26, 20) },
      fox: { body: rgb(208, 112, 58), belly: rgb(246, 232, 214), eye: rgb(42, 32, 24) },
      wolf: { body: rgb(122, 128, 138), dark: rgb(84, 90, 100), belly: rgb(214, 216, 220), eye: rgb(200, 190, 90) },
      crow: { body: rgb(44, 44, 54), wing: rgb(68, 68, 82), eye: rgb(210, 190, 90) },
      fish: { body: rgb(96, 160, 208), belly: rgb(190, 226, 240), fin: rgb(64, 122, 172) },
      pike: { body: rgb(86, 120, 78), dark: rgb(58, 86, 54), fin: rgb(120, 150, 104) },
      corpse: { flesh: rgb(120, 82, 74), bone: rgb(206, 198, 180) },
    }
    /** Effect colours: pure visual feedback, never read back by the simulation. */
    PALETTE.effect = {
      eat: rgb(150, 214, 106),
      hunt: rgb(226, 74, 64),
      death: rgb(96, 78, 70),
      birth: rgb(246, 164, 196),
      alarm: rgb(255, 226, 96),
    }

    /**
     * Compile a character-grid sprite into a pixel buffer.
     * `0` is transparent; every other character must name a palette colour.
     * @param {string[]} rows - equal-length rows of characters.
     * @param {object} colors - character → packed colour.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function compileSprite(rows, colors) {
      const height = rows.length
      const width = rows[0].length
      const pixels = new Uint32Array(width * height)
      for (let y = 0; y < height; y++) {
        if (rows[y].length !== width) throw new Error('ragged sprite row')
        for (let x = 0; x < width; x++) {
          const char = rows[y][x]
          if (char === '.') continue
          const color = colors[char]
          if (color === undefined) throw new Error(`unknown sprite colour ${char}`)
          pixels[y * width + x] = color
        }
      }
      return { width, height, pixels }
    }

    /** Every sprite the renderer can draw, compiled once at module load. */
    // ---------------------------------------------------------------------
    // Sprites: every species has idle / walk / flee frames
    // ---------------------------------------------------------------------
    //
    // A 2-3 cell creature needs two walk frames and a distinct "running" pose,
    // or the meadow reads as a still photograph with dots on it. Each frame is a
    // character grid: `.` transparent, other letters index the palette map.

    /** Raw character grids, compiled into `SPRITES` below. */
    const SPRITE_GRIDS = {
      rabbit: {
        idle: [
          '.e.e',
          'bbbb',
          'kbdb',
          '..bb',
        ],
        walk: [
          [
            '.e.e',
            'bbbb',
            'kbdb',
            '.b.b',
          ],
          [
            '.e.e',
            'bbbb',
            'kbdb',
            'b..b',
          ],
        ],
        flee: [
          '..ee',
          'bbbb',
          'kbdd',
          '.b.b',
        ],
      },
      deer: {
        idle: [
          'a....a',
          '.bbbb.',
          'bbbbbb',
          'bbbbbd',
          '.b..b.',
        ],
        walk: [
          [
            'a....a',
            '.bbbb.',
            'bbbbbb',
            'bbbbbd',
            'b.b.b.',
          ],
          [
            'a....a',
            '.bbbb.',
            'bbbbbb',
            'bbbbbd',
            '.b.b.b',
          ],
        ],
        flee: [
          'a....a',
          'bbbbbb',
          'bbbbbb',
          'bbbbbd',
          'b....b',
        ],
      },
      fox: {
        idle: [
          'f...f',
          'fffff',
          'kffff',
          '.f.f.',
        ],
        walk: [
          [
            'f...f',
            'fffff',
            'kffff',
            'f...f',
          ],
          [
            'f...f',
            'fffff',
            'kffff',
            '.f.f.',
          ],
        ],
        flee: [
          'f...f',
          'fffff',
          'kffdd',
          'f...f',
        ],
      },
      wolf: {
        idle: [
          'b....b',
          '.bbbb.',
          'bbbbbb',
          'kbdddb',
          '.b..b.',
        ],
        walk: [
          [
            'b....b',
            '.bbbb.',
            'bbbbbb',
            'kbdddb',
            'b.b.b.',
          ],
          [
            'b....b',
            '.bbbb.',
            'bbbbbb',
            'kbdddb',
            '.b.b.b',
          ],
        ],
        flee: [
          'b....b',
          'bbbbbb',
          'bbbbbb',
          'kbdddb',
          'b....b',
        ],
      },
      crow: {
        idle: [
          'b.w.b',
          'bbwbb',
          '.bbb.',
          '..k..',
        ],
        walk: [
          [
            'b...b',
            '.b.b.',
            'bbwbb',
            '..k..',
          ],
          [
            '..b..',
            '.bbb.',
            'bwbbb',
            '..k..',
          ],
        ],
        flee: [
          'b...b',
          'bb.bb',
          '.bwb.',
          '..k..',
        ],
      },
      fish: {
        idle: [
          '.ff.',
          'bbbd',
        ],
        walk: [
          [
            'ff..',
            'bbbd',
          ],
          [
            '..ff',
            'bbbd',
          ],
        ],
        flee: [
          'fff.',
          'bbbd',
        ],
      },
      pike: {
        idle: [
          '..fff',
          'bbbbd',
        ],
        walk: [
          [
            'f.fff',
            'bbbbd',
          ],
          [
            '...ff',
            'bbbbd',
          ],
        ],
        flee: [
          'f..ff',
          'bbbbd',
        ],
      },
    }

    /** Character → palette colour, per species. */
    const SPRITE_COLORS = {
      rabbit: { e: PALETTE.rabbit.ear, b: PALETTE.rabbit.body, k: PALETTE.rabbit.eye, d: PALETTE.rabbit.belly },
      deer: { a: PALETTE.deer.antler, b: PALETTE.deer.body, d: PALETTE.deer.belly },
      fox: { f: PALETTE.fox.body, k: PALETTE.fox.eye, d: PALETTE.fox.belly },
      wolf: { b: PALETTE.wolf.body, k: PALETTE.wolf.eye, d: PALETTE.wolf.belly },
      crow: { b: PALETTE.crow.body, w: PALETTE.crow.wing, k: PALETTE.crow.eye },
      fish: { b: PALETTE.fish.body, f: PALETTE.fish.fin, d: PALETTE.fish.belly },
      pike: { b: PALETTE.pike.body, f: PALETTE.pike.fin, d: PALETTE.pike.dark },
    }


    /** Compiled animation sets, one per species. */
    const SPRITES = Object.fromEntries(Object.entries(SPRITE_GRIDS).map(([species, set]) => [species, {
      idle: compileSprite(set.idle, SPRITE_COLORS[species]),
      walk: set.walk.map(rows => compileSprite(rows, SPRITE_COLORS[species])),
      flee: compileSprite(set.flee, SPRITE_COLORS[species]),
    }]))

    /** Plants: three tree sizes and a shrub. */
    const PLANT_SPRITES = {
      tree: [
        compileSprite([
          '..LL..',
          '.LLLl.',
          'LLLlLL',
          '.LLLL.',
          '..DD..',
          '..TT..',
          '..TT..',
          '..TT..',
        ], { L: PALETTE.leaf.mid, l: PALETTE.leaf.light, D: PALETTE.leaf.dark, T: PALETTE.trunk }),
        compileSprite([
          '...LL...',
          '..LLLl..',
          '.LLLLlL.',
          'LLLLLlLL',
          '.LLLLLL.',
          '..LLLL..',
          '...DD...',
          '...TT...',
          '...TT...',
          '...TT...',
        ], { L: PALETTE.leaf.mid, l: PALETTE.leaf.light, D: PALETTE.leaf.dark, T: PALETTE.trunk }),
        compileSprite([
          '....LL....',
          '...LLLl...',
          '..LLLLlL..',
          '.LLLLLlLL.',
          'LLLLLlLLLL',
          '.LLLLLLLL.',
          '..LLLLLL..',
          '...LLLL...',
          '...DDDD...',
          '....TT....',
          '....TT....',
          '....TT....',
          '....TT....',
        ], { L: PALETTE.leaf.mid, l: PALETTE.leaf.light, D: PALETTE.leaf.dark, T: PALETTE.trunk }),
      ],
      bush: compileSprite([
        '.LLL.',
        'LlllL',
        '.LLL.',
        '..T..',
      ], { L: PALETTE.leaf.mid, l: PALETTE.leaf.light, T: PALETTE.trunkDark }),
    }

    /** Carcass: two frames, meat then bones. */
    const CORPSE_SPRITES = [
      compileSprite(['bfb'], { b: PALETTE.corpse.bone, f: PALETTE.corpse.flesh }),
      compileSprite(['b.b'], { b: PALETTE.corpse.bone }),
    ]

    /** Faded body colours used to paint motion trails. */
    const TRAIL_COLORS = Object.fromEntries(SPECIES_IDS.map(id => [id, dimColor({
      rabbit: PALETTE.rabbit.body, deer: PALETTE.deer.body, fox: PALETTE.fox.body,
      wolf: PALETTE.wolf.body, crow: PALETTE.crow.body, fish: PALETTE.fish.body,
      pike: PALETTE.pike.body,
    }[id], 0.42)]))


    // ---------------------------------------------------------------------
    // Sprite atlas (generated pixel-art artwork, embedded as PNG)
    // ---------------------------------------------------------------------

    /** PNG atlas: 4×4 cells of 52×46 px, bottom-aligned creatures. */
    const SPRITE_ATLAS_PNG = 'iVBORw0KGgoAAAANSUhEUgAAANAAAAC4CAYAAACSA2JDAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAIBESURBVHhe7J0FdJRH97hf3CEh7i6bbLLJejbu7iEJJCEh7u4hwaE4FGgpxVtcCrSUunup40WKFSvQUjee/9nls9L2kxZo+/vvc84cwr42875zZ+7cuXNHEPTo0aNHjx49eu4oRYoMcn2S0f5dLhnHOPEY3d9asiWpR//+d1V4yT9+16NHz99oKS6mcuzYr7R/d5ZXMDo69SPt3+aCJfPrusi2THwjUohl8V2TCbby1wuRHj3/SrYm6PLKngbkJg4fzaytIjss8eDfjzX4x9OTnv1duo/6/ILxzbgM89ALkB49N1PiH/bt/BmR7F4ykQzbG+pcZ78SivunM1qu+mbd/Dy6CzL1wqNHz6/hZ+Hx/YbuNkZ7xegEpXlAlu5fsSAjTOT67eyKvL+8AAUaiz4dXxT35aOLW688u2L+lWDTGyppXt9oJvSvJGd4Ohpz0cfNIaFX93W1XenJTr3iJaT+5cut5w6QJuRQGZPAkqZ6cj2S6DQoIc0+6s1Kj3wi+itY3JBFbUDq8b+fn2CjPv3TO/z5GSVk4zbU4bOsAAmPTZuJv4XsnPb3WUYlFFjGnv37eea9LWlM8mPyOL3w6PkfEAti2iPTvlpV2kRlTAQLuuuoS8jTVbJgZ9F7M5vGkmonP1kdrKYzTc7A3kP/chVsjJBP0kgZj5Z0MTEt93ryCPn+DwJ3kWEqf/fv5xQKpUS5+Hx1z9ICMhyj/nJl1PMHEjBA8qb1sEEEODuwtDaXle1jfyi30apvg2mviaMsWUZrnAuNIXLceiv+spUrzcH3h921PUxNz2b9uA6akxO/8jeUkSOJ/268TRXFvUYTEi+hpSaDgmERunJ6CEoypf74GIk/uPl+evToCLH14K5MBUUKG1Qmg5lQEEJHZjLD+vb70l9hi8LClAqFC/6GXodvvvavhExQEWnp/uXCzHRemDCe+fV5ZPmreXTuEmJtwnW9rqKX64dZ6UE0J6ejMnL5pDjBh/s64zEaOOLDm++nR48On2G2H76/qIlX7yqhLsyJBE9zxqeJ6Up0pydeREu4iChzh+9uvu6vSLP3OOxGGGI6pC8l4SrWVlfx4pwZxKvln2uP+wn2hPmIWdo+mnFRrixv8uOu4lBsBVd9D6Tn1xnjq/x2e2suU1O82Fjlz/oyNbsnZrN7WhE7G0NoTxRdF/fy+suqb3/Hua8LKhcbQuyN8DMbgMsggfo4DetmVTJWnfGJt+D4rkRkTXOOP75GQymQ2eI/0pWs3rV/+bLruc1oRri+W6C2ZWOVH4+3htCTE0qYr4SJSZ7MHysi1dbrx5uv+athIzgcmJQcwOHl43mgPJwpCe44DOhFTpAvM4qz8DAZitRmBDLLEajsTAkyc8C/j1IvPHr+M+79bA+1xbnzYKUfj7SGsbEtkRljg5mWJGJViYw1RQrq5ArCRsj/shUqYXACMkNDTq2Zzt6Z5UxK9KQyyIEUD1Pmj1ayYJSUeameLBzlQ224G2HWzrQZF/xly6vnDpLtKmJ5kZoFuT6sL1ezozqAZ9oieKw+iF2VavZUB7K6NBg3V1Msh1jofOn+irj0sWWct5jH6lNoj/RgRqqI+/OkbCoNYE9zNG/fU8WjHalsqglhToEEpanVpzffQ4+en+Aq+NEd5M3GykBao5yYnyFiRb6U7ZUanu+KYVNDBEtyNTy3aiajUqIZ0cvw8s33+CuRMSCVKEvHK3ESM2ZnenF/voxtFX6sLfKjND2S3ORw5pWEs6hAQrjYEkvBTd8L6fl1bHtZsSDZm911ASwv07CmOZ6FBQoemzGWxxc1sWpOHR1FqUxvLkVtI/s/0SJLB9oci/UyZlGOLw+UqthZHcDjPfHkJagIVnkTbj+c+dliFhdIKfPxIqKf6s4IUb5v1JEkB/U/HhY5Qk2am/y4eoT0zmRAz/9MtLHs6qZyBdvKFDw7LYNvjz/Kx2+u5snNPYid7JALkneTB4eTahT9f+IbjuqXRpvam5W5vizNk7KuTM2mcg2vTEvhie44Vhf7sXysgrszvdlcoWFHeQAT430JtXP6bGRvk9v3DhQib04/u4ITi6fTGBl91UWQIDK0uDhzbAA5gb6378F6foZUUOHXX0R4P28C+nkjFSQ/e//RvfzwEcQn8lV2bK5Us7FExrPTRsGFV+CTl/n8xFZiZCrShNyfXXs7CBHCUAr/bHxvBw0DO4m2Nv9m81glWwrVLMmV6MZ8D5aoebBQyfZyP55oCOGJumAerwlmd3Ugm4rVPFigINBpBJYWI29f/qLsQzl/6HF+fGwrFx6cRYG/CqvBw76bma1hWXkYyeJ/+h/9X8BL8Lx9L/N3EDzS5eOqYC+2TxvDqqpQ1nfHMzEziDg7x0tqG7NDwQ42h2IsbS+vGhfO3fkKumLseLBUzaYyBU9NTuerj57k+ievwNUnmNVWjIXgftvLGTk0mvzIcNI0bkSYOl26+bgWrWuNjeCDk+CDneCAWPjPFkELQYyZYKc7L77PGBKMVNyV4MKT1QFsLVUwJdmNe3MlrClSsrpQwQNFcjaXythe4svGIh/uz/Fkc4mS15Z2cM/0LsxNjf7jM38z/kZqnnlkBdfffIzP197D6RVTifaypjlKwgOVkTQlakgY8n/D4zWwv4wkbyeS3XxQ9Prj1dPIfv5ohjtRKvbg/lEi3l9axdNTs3Uf//kpqTw/NY0tpVJ2tEezoyuaNUU+vLu0kEcaAlmQIWJZni8P1/mzsy6Ac2+u4vrF5/jh4mO88dQCgpw1r938vFuN4wCn7w68dD+ndk5gYowDmpHO5/9+LGVQFKkiFypiZWTJ3cnxcaUuKYJ0qRWRw8X7goXYn7z/SqEBTS8FwaZmF+sjHRkjs8ZhgDFexiZ0RjqwvVjBtnI5W8tlLBntwfxcGdPSPFmY7cO2mjBenJjB/mUNfPTMMlZOzWNqaSwLp7WQn5uKaORtbkzumd4JBx/j6gP38fnKe9k5LZd0H2sW5AYzMcOPkAHBtzcDtwHpCJsPpcY2xxX9xP/Iu78gfacryZsF+cGM8xeTaBxw6qdX3TlSBwYyJyeGe/Jk7GwO5fUFOawcK+bZGSlsrQ/jzTWNPFgkZ1dbJE9NTmZtmR+rS+RsrvFna7lCV5EWZojYXqlkS4WcQ9u7+PbkLr4+/Sh89hJZ0bHf3/zMW41tX+tPjr21ibOPL2LDWAkTY5zxNDQn0Nye+kAb5qab8t66WnZ0xPPgOBlv3lPDQ7W+zCuQUx7uTZrYi0xVJLEOrvib2VKjseGFu2J4Z2Eqq/M9GJ/gQk+MBysLZGwskbOxVMGWchm7GgM4tnsuTy5rZcOUPHbPrWJmZQGVKRmUp2ZTmJTEmIgouqoqiXUJ/TpOuM0LDatDMy9+++Eevn5oHecXLOTUjjlEephQFSamJ1VJXJ8bC7j+Koj6uH05cYySjU2JzCgIozJGQY5zCA6C/YfZcmsWjglgVVEE0zNDSbIJveNCFDUsiLmlBTx1fyOTYp15pDGE5yYn8OLsTLbW+LO8QM72riQ2lGt4vDWCp1rDebgxhI0Vfqwc681j3QnsqQtkc5GMOSnu3DtGzONTUvniwGa+PbGHL44/Qmb47bdAOfVz+HJ2Vzafv72W3a1ptIfa0R7pyP3ZXry/pIJHp41jVrwTy8ZIeGpmMU/NHMe6Ql8eb4visaYwHpuUyjtbp/JAuZJl43x1pulddWGsGuPL+hIV22r8WZEnY1OZUpfWlyrZWCrjpdkZfHNwFz+efYHPDu7iiXUzMBDMj3oJXlrjCRohgAghhjAh5La/g3+wpL2K628+xDt1tbyzuI2yBDFB9iaM83fEvbfLncvILcCjl/v7M0YH8OqMAt7sLuadifmsa4ykJlmGi8lQKsNF3D8ulHvHhTE2wBOPO+wzFu2gvnDo8WWMz1ExL82NraUyHm0L4flpqWwokvLAOB9W53nx7rounuqI4emJKTwzYzQrx3iyrlDGxlIlO8qVPFytZl66Bx3hDkxPdef4ozP47tjDfPr2Wtqzw297mcIG+KMYbMMzS1qYX51FpsiMxele3JPqxrMz8nh6xljuz3BlU6mCV5c28/aaiazO9GRNjpRXljSxuTqC+7K8eLg7i91Tcrl3jIQHy4N5f0MPm8v92TDOlwcLFWyvUrK1QsHGMgXrSqW8sXg0PxzbBZf2wmfv88ajyzHva33by/sfaciOP7VzehHPzq3j8anZPNiUxraONJY3JTA5K+7LbPO4Pz6T/yWx1l58+GAr706s4YWkUWyOCOHR/Bi21KWQ4GPDWLUTE1NVTMtSEmzjfP3m628nse7iL97YOIEImTWr8rzYVKJVUWT/+HdriZSHK1XsrAlge7mCh5vC2VIbzOpcMRuKZGytULKtQsGOSiUbS3x5bEo6K6vD2NAQySevLObJhcX4O5vesW/l3c/ukqfhQKZEu7CnMZgXJkRxf7oDG3JceLYznD1NoawY5cTqUS5sK9OwvSqIpyfnsL5QycocT56eMYYd7UmsyPVhY3kAuxoj2ZDvw64qFZtL5DxQKGN7pYot5Qo2VEg5uKWZbw5v44eLr8H3p3nu4eWYCsZ3rLz/lgg38cW9Kyv4cE0D53ZO4+iTazi5czLHNjeztHE0fsZ/DUe9UMGfKRnRnF3eypHacg6UFfBgaBCPjk7g2cm5yG1HEuxqSVeKD+WhEmyEO9fLhpvLruSGBONjP1InEJtLFbq0rVzBI7Uqlo3xZH2BlC0lcjaUKlhfKGPNWB/uG+3FxmIZO6rUbK3UCpGKDYVi3nuwlS+O7GRjRyJbJqUwtzwM9wFOn9383NuFn6CiVG3DpiIFWyv8eKRGxVOTEnl3eTkPFfvoetiVuWKdIJx4+j72b5vGsmQ7Npdp2NkUybpsFx4Y7caGEgWbytU6QXlpXg6PNQayo0LB7FR3lhf4sL7Yh0da/Lj81hq+O/4oP55/Cb4+xKKZNUh+weT/h5AvVn9yYE01pzZ3sHfzLEKiopjWXsjBda08v6AITzP7P0dG/wsC+kuYnKrhxIwyzk2t43hDLZtDI1gxOoCHmuORO5rgYW2IzMkU0VDrU8GDpCQJ8XesfKKRBt9sK5Gzs0LFQxVatUzBY/Uq7s7ypD3MmdX5vqwrkrGpWMmD4+QszPDmoXIF2ytUbK3Q+r75sz7fg9dXt8KPp7j0zoPsmJ1FWpD0R9EdrFBKQ6fLS7O82Vai1qldm8ZJ2FmlZmeNP5sKJazNl7Ayz4cVeT66CdAdTVGsynLh9RWdHH3qQbbkerKtyIfNpXK2lMp5qFLJY13RunvsqFazJEdCZ5wri8d4s/fuUVx5dz3fnXoGLrzId2efJC5MQtSfIbCIeoCcTR1pnN3RyZF19RzcMYP87FgiZE7svbeOvYtKua8w88LN1/2ZUfT1piDAh9UNMeyfW8kHk0q5K03KytIQnpw2ih1d6ezpGcUjEzLYMH4UTdGRxA4MuCMfw6W/7YfTk5x04xmtOvZQuZJHa9UszvamRGXH/QXaFlnFugIJyzPdmRDhzK5KFTsqtQKk0h27b7Qb727ugW/eh6svsePeakItJD/c/KzbRakwhSg7D3ZXqtlepmRbmVzX42wpkbKp2JeNJVLuHePFokxvXSOwtsCHtXnerB8nY3OFHw9V+LG90IfNRdo5HF8eKpezo1LB1hJftpZpLW9y1pcq6IxxYXqyK8d39PDl0d18c/Iprl94kSOvrMXaxpDYPjdCff2hePTyYNe0dM7saufYtk4+3NDIsS3tHFxVy3srqrn0zmbent9Ihqv8m5uvvZOEufseTPNJ+a9eWFavHNSmtgSIjShJ8CTCx4G8UE92dCZxeGUZJ9Y1cnbXdD5Y28xHu2azf8ME5uWnEDLw9kf4tBRcKFU4s75AxuYybc+i5NE6PybHuzMpJ4Tjj93F+Wfm89b9leyZmkVNkCuPVCjZWa1me6WCTWUyloz15qOnF3B1/waeXtOJwskaTS/Nbc/7vxJl53z9sSoVOytuqKHair+57G/jujIZczM8aI9wZXWBlA3FUjYWS9lQKGNdgQ8bx0nYWiRlvVaw8n105mptT6RNm0pv3GN9iYw5yS7smTGaj56Yxbm9a/jy+ONc/+Q1Nt03iaHCMAoGjr2jZf5F/IaKWTAugPdXVvLRjgl8tLWT45taObVrGl8ff4Ivrh7gtUfXMVod/4/QSXeaDGnghfMn9rJv1zqibALfkwgqVIN88R8oI3iAgvCBfkT2CyCgnxrPvuJ9eSoP3lqQz757S9jYGEtVhJhRKieemZHNh2trOLm5lWVzJxGsUfLg0jmc2LWIN5fX42XqcPLmZ98ONCaOx+4Z7cWDRb5sq5TzaL2GUrUtLuaGFMZLWTa5gL2bp3L6sflURvty7ygxW8vVPFKnYWaiE0tro3hsaSvV6RpktmY49XO6oxWpUugkwsaZhysUuh5Ua/TQTnjqUpmcnVUKFmZ7Uaa2577RPmwulrG5RMaGIjnrC+WsL5LrxoEPjJWwfIyYlXm+bClRsOVvQqhN2r/X5nnw3sbxfPTMAi7sXclXH+7k2GubSAiUIu7js+/mfN1R0gfEkOIgee2ByljeXVKos4q8fX8l766o5dDuBZx4/ylefPFRVt+9gIr0sf8IK3unMRVM2bxsBfA1Ly5qJNjWkpIgORtaU9k9aQyP9GTx8IQsNrQms6Y+nrVNcbyxMJeTDzbx4aoa3l5cylOTs3hhxmgOr65h3+pqjq1voLMwDpG3F26ONry+qJYPVtYwOz/u+mjjxNteGZ0Hmr23LNdbNyGqNSCsyZegMBvOaF97Er3McTQejMLKkXGhGuwtDWmJdOORmgB2VPsR72aMQmSFzNqIUJfheAy3uu35vRmtAGks7NlSqu15lGwtV+p6oe1agapQ8FidmqnxbqS7mDAx0pl7s0RsLpSysVDOOl3S9kRaI4kvs1NErM7zZWupXHf99goZ28plbC+X80CemEdnFvD9hzu4+PYDfH1wK+vn1DNEGHHx5jzdMYIFBV1R4defmprHu0uLOLyigqNr6zn8QCMHVtfx7qbxHN73OK+9tg2Nk89XfkLQHf9A/8oIwZClM2bB5XfY3p7C7q40Tq6p56PVdZxY28RH61r5aH0rJ9Y2cmJ1DSfW1HBkVQ0Hl1dxYHkl+++v5LUFhbwybxwfbmjj8KZODqxr4diWTh7oGc19zem8e18FBx6o47VFpUwIDkLd7/a6gahG2O/fXKRgd42GPbUaSjS2+FmOpFDpSHOcJ4lOHngIgbo8jBTMLtVoHHisxp+HKjWILYcj9BKIF5lQFu6Ir7HbHVet3QUpqXKrGwaAMqUu3RAiOQ+VaYVISbbElsZwCctKwtjeEsmGUhkPFHixcrQ7y7NErMwWs3K0J02BdsxOErGjQsaWChnbK7TjqRtp5RgPtvXkwPHH+OzdTTy5so1AL6fr2qisN+fpjpBuGciDFemc1Frc1jXz4QONHFpdpxvvHFpdy5EHmrjw2nK+O/8ccJyl0++6YwPTf0ewkerY+Kp0npwxmpMbWzjytzwfXF3H4dX1HFxdz6FV2r/rOLyqlv064anSCY82vXtvKc/PzOXwgy2c2X0Xx7ZO5MDaVj5cU8+RVWXse6CZHy/u550nHmJ+ZSZOt9HqGGUkZ3yo53c7y9XsrgmkKcYVJ4OhpIttqAh0I8ffHf/BP43rluPkyo4yGWvyFVgNGv6d6ZAh3xVrbGmNF+M50vHtfz33dlEoZBIkhGApWBNka868HNcbgqMdx2lVON1YSK4zQbfHuJKkcOOemlSenFPBxafmc+HF+ziyeyYv313AC3PHsLstihcmp7OkMIRJkU48UqkdO0l16ptWvVtbJGNSjBNPza/gk1dX88qGyci9LLEQbP+YOhk0UM3aqlTOrq/l0IoaDq9p4uCqBl3FO7KmgcNrGnn/3hI+fnkV339+jOvfneKDgy8QPDTytlWm/5ai3qWE2ruw//5ynZBoBUcnPGvqbzQAf0uH1tZzaI1WuGo4sKKaffdXsW9Zle7vd+4pZe+SEo49NIULr67jwnu7OPvGA1zZt4Vzh57m/f1v8OzzO6nIub0D0xxXd7YW+bG5WE2l2o2B/XsTYG9MZZA7qVIXfIf9fFWlZrgjG4p9WFkgRzPA+33fgU7vt4Q7kat2/dm5t4OYIXIKpVZUauyo9XfSGQa2FKvZVKLSCdG2Mhm7KuQ8WqPUmZ2dRg7GwcwAkY0JESoPmnKjeGByAYcfXgiHH+aHd9bzyWML+PrFlbyxcgJ1IW5sKvRle5l2YlnKqkI5E5JEZHqaMq8ikbu7xhLm40iEkxGJTrbX/fqJiBTucL2sUPt9feLBJg4ur+Ttu4t4fUEJh9c28M6SIt67t5zDD7RwYGUtxx6ZxfdfnQeu8czTG1H387uzGf0FRIIXq6oT+WhNFftXVnNA12M2cHBVPe8tLePIWq3wNNxIaxp0PdJ+rfAsr+aD5dXsX17DoRXVfLCmmUv7dnPtzFu68n366Qm2PvQgax+4j/vmzKQwJhvxbV7nEm1vydON4UyK9UYiiPEcaHGuOsSZfD8PfPr/8lqsMAMX9jQo2VoVSUg/9X5pP9cD3ZGepEt/Lmy3g1AjO3aUyHm1MZAX6gPZU611btWwscSPLSUqnSlba9JekeNLkJ0RQfZGZMns8HO2wl5wPjNcGEymg5pxESFkRwdSlRPGk0vr2L24jj33tpIbpaQ7yoUdZdrJZe1EstbbQjs2VJCncmTE0MGIjYbSEuBEc4gjYxX2hDqZoBjuwNgBt9lpVEuGEMHmxnROb27j3aXlvHNfNS/MHseW5gQeqI3jqSljOLqhnX0r6tm7cRp8f4GvPt9HVvyfY2WjpeDIluZ0Tq6tZf/KGp0AHV7TwL7ldTw2IZt3FhWxb1kFB1ZW6wTr/WXVvDh7nE4t3beimoOr6nj/vkoebE7j7TcfR8vrbz9JaKCMkYN64SJYfp8s3BmXpbARnp9uLwiiXSkhUhiH9yBn3UK5ZIk7DoL3L+YhZJj7sZVjpCzJDCCojwZxPydyVXZEedx+61uCEL23RGLD0zpHVgUrcmXcN1bB4lwZi8fIWJ4jZ91YFTV+jgRYa3sIc8oUDsR7WCIbLv+JuhUuJKBdvOnZx+dHTzMHPMzt8bRwxHqYOVIrQzYWydmmM3lr1UI1T9QF8WRjMLXBjrgZDEZjZkiJ3I66QCeaw52pTbAk0fKXG51bQqilH8XpRSeinaRnXpxbwNEHmjmwqpEP13VwfF0bT80qJEfmxKamZM7smMDOSdmsmdfOwX3P0F6Vf91acLh9mfsf8OrtzCNTR3PiwcZ/CJB2/PbOvVXcXxrFB8tqdcaBD7d1c3zndE48Oo+dMyt4654Sjqyt1fVMbywq5Z7CYBY1jKK7Ph9vmQfmg/szqzCExkR/Yl28zkcKt9+bOVBQcU+ignpvCaFCIrI+fgTaWhDj5oS18MtjL6mgpNpfRLXCA18hlNDe8ajtTNDYmf/i+bcSzz7WP85McWdLWQjhLsYYDO6PvelQRGZDdfHZXEyH6GK0KWyHEyU2JVNmh9rGjMj+mv9prCLrLztXrXFkcZo7Dxb4smGcnO2lKp6oD+CZ9kDuK5QQ4miM/ZDBaGwMyVfZMjHThZJgF3x7/ecFe7+J1qL6i9rWtig7gTcXjuPwmmb2r2pi/6pmPlhey/Gtk6gvSGdiUSxnt7ezc2YBURofWsaoSXD0ue1rS/4dpf3GUaIM+SbN1/77yVnBHN/SycE1DezXjm9WVnN2cyvrWjNZMr6CQy+s4/NzL8J3x/nx8xPwzWl2b7qbpdVxnN7cyYkt3Rxd18rFh7o4u6md95dXsLwrnYp4KQmeFlQn+DK9MY6WUbGkmQUeuDkvtxIPQcTcWBUVnv9sOTVm9kTZOWsHyL9YEZwFL0rUIipkniiEaFKEPMLtbIlw/GWBu1V4Cp4k2NuxvjSYOk8fYgS/SyMGDSRFbU6mxgof25FY97LEaaAVbkPt8B7hgucwd8IG/LbxSWQ/PwKN7cmVupMtcWO0jzPj/O1YMtqbnY1KHuoIw9vMGN/ePh8EDvQ8VuHryoR4VxLMPW6PD2B9bsm32vmTrqocXpgzlhMbO3UCtG9VE0cebGPv0kbumdLMwqnNPDUtmycWlCAyGcKSQj/yJAF/qABFmPgeevP+Rk5v7ODYA20cXd/JgdU3eqCzG5t4Y1EliQoRyVEKYoOl5Kek01JTwJ4n5/Hqq6vYum02mXFK5hdE8tH2Bj54sJqFNfFMGRvNpLwoXl5bzw/H17Fz+RR83Jzx9bRmyYxyHry3m2SnmNs27+UgOHNXrJJC8T/VtUBTR5LtRVgIv+yebyO4U6Jxo1IuIkBIIVSIJ8bRgTgX5188/1YhH2BxdVqqH1NVaqqFKNJ7pSO2MqA01plodxe8B3i+dfM1v5e43mk4C77YCiJsBXsUvcRvqcxMKdHYsasxgolhUjKEG14XiUO8jxarHGkJkpFuGHTm5nv9bnx6e7Fn9SpeeuReZo4N4oNlWlNvCwdWN/PBijYmZgQxuaWKoqzR1GokvLW8DHfL4UzPlpLn7v+HClBHfChXtt3FprZcXlvSwAdr2jm9tZuPHmxi95QcquNVNI4NYlJFHGojb104W4ngQ6R94LlAG/U5PwflOdfhosPhQ8WUqBWkKSVY9DH9VCJICRKiSHMI/f6BmfXAFdY/OBWTQaY/JnrFUhyXRbTF7VtX4yy4cm+aP5Wyf65HijJ3ocBTTEj/X/bHcxC8qA51ozXQk2ShWHdOhJMdMS63bwyUKkhpCJXSluBDdj8vnReKx2CLj5JkVqTK3QkbFHbbnn0zUUIIvr09LzaHeLGhIIQsKzddEP1sIQ+fITZUhrnSHiyjYVjWLRdoIWCwhsa0wpNKW6cfdoxP46MHtJarap6eXshdJUmUpEYTIwRSaK459daaalJCPZk+SsE9pTk/ZjmPvmMv6V+RDDO9oJ2TWlqTgnn/vqQHeZMeLKE0LpT8CA1SWztGaRTkaDTf+xv5/eY4AIGDAyjJyiPV/84YELR4C2JmpvkyL9GfgGE3eiEfA0vGyj2Itv7lZSPOgoTaCDfWZIeQaxhFTO84nIwMSPV2I9Tg1loN1YIGTW9H2tQiFhQHU+6iZGWfVgJ7+ZBg7aAztfsYul+9+bo7gbVgwZQYHx7MjSbeUHZI+1uykE2IhT3dGQ60+fqS2Tvhlr6Pf+AlyKmLDuCeqjSWlGezZWot54+9wJ4N85FZe+LVy/7U+jk9HHrrYV0lXTa9nJzkO2+Fi3CSffLMqikc2HEXBkMHEOxhxdyyVPzNvK7ZCmLstCG4dOk2Wl9uIyF9IghztKczVoLEwggvQYpE8EDuZoeHiwW2g+z+EaTj78h7q9DY2dOTqiLWww5JH5/PhwvDv/d1NsLHxQKHobdGlUsfkI7TIAsypFasrPajPFKMSe8RqPu6ozAyI8fTEz9jVxIG3KZK+h9IGzaadCsPtoyLZFVCApUDbyxDCegrJ9fDgVlpKprUsZQMKr0z+fN1liG28kAz9MbMt+8gJbGuEfgMl+r0T9fBjncmI39DaSZ75/HNK768fu3Y5fAg5WWx1YjL88rCL4/yDfhLLaf4T/gOFOMy0uyy1WCTqx69b2xR7zjQGcsBFrj2+2Vh8O7jha2B0WXzYQZXvfvcWPfjOdDzsnSo5LL7wH8GUfk92PW1PuvvZH61PlJ0pSTE44qz8bArfXv1uiJ3NLmaJHW+GmrpckXST3RLnvVbGWUcS77I9cqWoqArU+Sqz3OFtBtCNEByerTC5UpXStDVZE/lGUnf22SZ06NHjx49evTo0aNHjx49evTo0aNHjx49evTo0aNHjx49ev5P4t3P46jiF1awKv+km4np0fOnwsXOkyB1LOH9/uk5HmAc/JmDyBNpr9sfIFKPnr8sIcOCLuaOGkdCfCqevV3OaX8LFQLw8fZBGR9CQK+wD26+Ro8ePX8jxNGfuvpy2mvGkh2aeN2qt+MB04FGiL3cScuOJWZAwt6br9GjR8/fCHUOoL2tmuzkEKrH5RGmiCYrI42EmBjkUm+C+4Tf+oVlev53vHupSJTbXQkTOVz519/dDa2uuNkbXInt+yfYXuL/M8SCCA87T3q6GxA5O5KTk01TSx1tHc3U1FaSPS4Lqb3q65uv+6vjPNgBcR/xVzf/XmJUgndf8Xfx/e7cFjX/NT6DHD7Z1pjBPQWRJFhodGvOtbsLjPK0pSPWF3WvG+Fn9dw5orxDroYGh5GVnU5ZVTFVdRVUN1Qy+a5JrFpzP5W1JcxdNIUw96DPb772r0pqr7SLjm7OOLq7EtE7+It/PaYepqbf0AFIh6l+Jlx/OMl2tp8+OqOM5SUhLCpLQDNw+FcKw6HcFWTPorQgjAQzvQDdQYyEYeSkZ9PY2EhZZSnjigvIHJ1JSmYGozNi6Gwsp6GpntLKfFxM7uxiyNuFdqsalz6OJMTFkJ9fjKWhLTF9b8RjCOjlh/UIC2LjM/F0lhJ2p6OV/jvChHSqvCx5f8sCyv2debPOl9ezzHi/1IyDxcbMCjJFKqjevPk6PbcPRwOrKyVlxTQ0NdLQ0kB1QxVlVWUUlpXQ0liITCwiPCqB/JJCRI7i6x7Cnd1I+XbgJDgjcndgwezJJCckEpmcgEE/I7TRap0Ex8+cbGzJzi3Cx/NPtgLVWnCn1LEvpzd2s6M6hKNVVlwa78Llbnu+vUfFyfHWTIx0Jd+i7M+V8f+CqmEVFA7t/tV8tw7o+dVjfxRBvZTEhYRRWV3O6DGjae1s4ZXXn2Dv3ueYNG08zeNbqW6ppaKugp7J7Uye1EZyaCzy4b6fRA2K+dOV57/FUjAnLDiI1csXEqTxp3VSN5bW1rjbuiPz8iVAqiQ0NAIny9sXoeg3UWFn8/0zMYPZV2HP5YliPpko5lyHM7vH2LB7SR3nF8g4s0zCaMXtCwF1O+gZ3IxkkCtWg2woHdz6s7zHDRmF/RBb/IeE/al6V42RlNyCbErKikhLT2PxfQv47Oox+P4cl8+9zcmjL3Du7LtcunCEM6f28c3Xn7Ju/RKGmwzBbIDFz8r5ZyZ8hAyRgT0iUwdMB48gOMCf++5dgELiy9jCccTExJGdOZrislIKiovIHJONl483msG3P7Lsf4VksIYVUY583+3MuVY7zo134VSLC5sijChPisfe1IZV0Ra8OtYWl4EWf2j8uP8VlRB4SezUl5IIMzQmLsT0+umGWpZ9LZC7D8Jm2DCChKQ/xQcpssslLjCckooiOnvaCI8Ip3N8K6c+eoMfvjjK9a+OwvWPOXbkDXY+up1z509z5coVPjj8GtFxAfj0Vv6xu7n9B+L6RB+MEELOhYxQfult5UGgRs2YMaPJGZON2MODYL9A1j+4kiD/AJLiUykvr6K4oozS6kpq6rVjvnKyijJRy1QkD4/9479ZppHowqEKGy42O3C0xoLTTcZ83GnLyfKRbEs0pcdnCPdrRnA8x4LnYvsyxmLoBZ/Bd3aPzt+Ku+DzUV6KjGOP3c/kDAmKkbYo/hbp0l0IwMGoP5PCDSmS2uIg/HKctjvNKMsISqsKae9qoaOnjZyxOcgVCmbO6uajoy9z8cy7nDj6Bm+99SSPPrWFlesWsmbdAhYsmYDM2FfnqfBnJHtwCorhvjiMtMXI2AArWxtSM9IpKa+kvLKaquoqMkZl4CPxpahwHHV1dVTX1FNVVUdlVY3unEkTJ7F5/TrqGqqZuHACbTUtSIVbE6XoN5HTN4tWid2Pl5stOVE0ko+qTDm/uoDvLr3HFy/M5vP1FVxbW8nhCdGcGx8Euxp4emoiI4YNxGSA2Zc33+/Phrvgc6ZybBxfHzrAtDwlS6rNyfYwRyN4ohlhQZTFEJaGmVOudMZYkN6xD2EgmDBEGIKBMAQzwQAHwRJrwYyggV5Ea/wpLC9gwpQuGlrr6ehuJ2tMFskpcSxZNI2Pjr3BsSOvsm79ItR+PtiYW19LCIs6nh+a8+HNz/mzENY7GPeRdkSFhxEbG0dEZBSRMbEUl5VR29hIcXkp44oKKSweR0JiArn5edQ11FHT0EB5ZSWl5eUkpaQQGxVNR2Mz4woKKG+oRBmgxk9Qvn7z8+4YMQNVB+eHWvNxgwWvJw3ii7tj+O7qWb78/gu+52vd1iCXv/ySpffN5ak9W/niOrx94H3SUyJRDlf+aVu7vyMSZB8WJgZy/egB5tSNZXaxMc8VmLPA04h9OZYcK3fgg3w7JsmMiB+uuO0bK4sFMSFOQV/ExMTrKlJm+igS4xJJiEsg0D8Qqa8vdc21ZGRlUF5ZQmtnMzVNNVTVVbJ183IOH3iRj8++z7VPj3Lg4AtEBP9yeOA/G35DFUSHRVBaWEJ9Qz2p6akkJMVTVl5CVW01lXVVlJSXkhAfz9j8sdQ01FJVW0NFTTXVdXXU1tcxOm8MaWnJSL0keLh7MTovB0+5Fz6Dvc/nCDl3/j1E9smkxMnohxeyjbnQaMGr2eYsD7Xl+aUT+ejwy3x0/E3OfXyIs2cP8+reF1m7dTX3rV7ErLsnE+kZdnsi5N8GQobY/vjcvC4OvPwIKUHWvFRkybUmSy5oU4sTZxttudBsxq5sa+INbk+j4C8oUfdVHY4JiaZrQjuz5s9i/KTxjO/uZOqMKUycMoHaphpyx46mo7OVsePySEhOoLKmnPrmWsprytmwbinXPjnCV1+c5vKlA3z51TFa2spRj7i14X5vNYreju+G+atpamjkrrtm0NXTSUZmOlnZo8gvyKO8toLCsiKSU5NJS02hsqaSmoY6KmqqmDt/JuvWreD+ZYuYNX8GxRXFJKWmEB4eTW5BDo1dteTljSFB9AdYHtWCmOmi4VysNeNMkyVfdtvxdKIx26KteGFJM/v3v8CBD99i2fL5+HnISPKIuZTkHnUuzTX+jmwP/3tZKqzSvVQPwfVas9SST9aM49lqB040WHGtw4rLzbZ8NVXCt/f78ekcVy50mfJ0izv5zjGXbr7X7yFmpP9HvhJvohOj6ehpZ8bMGUyeMomeCeNpa2ump6ebyZMnMr67g6bmOt1vLR1NpGWmk5SSSEt7A5X1lUyY1MbFsx/wxafH+ezKYS5e2Muho88Q5HHnAr//Etr42p66eRonbAQb7AQrXAQHnAV7Ig0VV8L8ZBSVFjBn3mxmzZ3J+J4uquuqycwapettaxprGFcyjuDgIEaPzqKmvoba5loe2rmWa1ePce7Uexz84FmefXYLG7few87dK3j11Yc5sP9FXnvjCeYtmMyS+dNvzzvIGxBPirn7tSRr9y/Srb2+iDd2/SJmpPiL6GEeX0yTGHCswIwDY0fy+XgrLjRbcKrSiOPNEi68t4eLH+/n6rWzPPnsFnwGut129eZW0Ci0UtA35GicqdEXo0e64tnHhBzLQd8v8h7Iu1lDuNJmyrkWc863mHO2yYY1eR605yp5uk7ElXYbPrrbjQTFrVukFjxUtTc8OITEpCQ62juZMm0KPRO7aW1vobW9mc6uNtrbW+noaGP8+A6amuppaKyjtb2JhuYasnIyyc4ZRWl1CROmtHPm2JtcubSfa1cP8tWnB3jp5S14OXj/IW4tvoI3/jbyjyIDIghSBqLyUeLr4YuvSIKXmyf+Sg2Z2RlU1VZSVlFGS1szXV0ddI7vpHN8B4Ul4yivLKO+sZacsbn4a/zIyMygoGQcCxZO4/KF9/nms6N8cfUIX372IV9/fhi++5B97z7Cc89s4puvTgNfAZf44ZuLt+yb/YM2S+WHb5SqOD/Fm9PTFRybLudwjwOHezw4UGfHgUIzPm6044UsE05VmXK13ZQzDSac3jOXS+cP8c2X5/nuu8+4+tlZmirqdFtM/NGkCQ1ECDeCiUcKY4gXxjBKKCBNKGFUr1KSjV1YleDA1QkyXs81Zl20ITujhvN2vjHHa4050WDB8QatpdGUhzJMiFNLiE3MRDagF8cLLXg9zwKxoSVKoeh3f5DsIYkk+qcSERtPZHg4EydNoqOrk/bOTjq62mnvbKVzfDtd4zt0afz4Tl0v1N7RTFt7E23tDXR0NVPbWMnosVkkpCQyZWoPZ8++w7Wr+/n+q4948vEH8XS+/VaoMiGPVCGJfCGXMqGMgD7qzzRqJaUlhbS0N9PU3kx5VTkNzY2UV5brepjOni7GT+iiuraavIJcKqsqbjQWXW2M7+mgvrmO9Iw0xhUVUFxWSFBwICq1iqb2Wl58bjsXz7zBl1f3c+3yQV2P+8VnR/jy0yNEh6sZMaAXSWEqdu1ay54ntvD003tu3TuI7BVDo7Pp9f3jzPh+YQCfzfTj0gwN5zs8uDTFlytzAjjd5MSRMnPONlhwot6atwosOFVnzoVWSz7bVcelUy/z5bWTfPPtJ/z442ccPPoqwW4hp25+1n/LGCHhN29LosVHUBBnaPdFV7AJk2OtWBBsxsI4ERN9jZgYZkWbvzmV4qHsrbHl+3kKLnV6cKTMlufSrXkuzYgTtRZc6zHjQrsJ59sMuNRtxNWekRzttGNymClTfIZxMMeMzxvteGq0Dcm2zj8UGeTQPmDyb/4wASYKklKycXdzJS0thfauDlraW2nvaNO1wtW1VbR3tNDd06UTpPHj23Xjn+bmetram2lra6Kjs5nJ08bT1tnI5Mnt5BfksGXbaq5+coAPj7zCujWLUYhv34RirVCLf+/w93zMJEisvRCbiHAzdCEqMpKq2iomT5rIqhUr6Ohs16mk2kagp2c8EydNYPz4Ljo726ipraa0rJim5gZaWpt0nuTannf8hA4KivJJSk5kXEk+xeWFjM4fQ25RHi2d9bz0/FY+/+R9PvvkA65dPsQXn37I1Uv7OLT/ZcZlxNBLEIgYbsgUtR/m/Sz+py0mf5WCAVGMt7fhnWwDPu1x4uIkdz5uNOd8oyXna00532jFhTZHzrc6cKTaitMNVlxqt+HjZkfeybXgzXEWfD/dm6uHH+fY8bf4+pszfPfdSV56ZQvOVr8tUn9lUPrlZXdPJcs16n++vmroImKGBX4+VTGSl5IG88NdHvBQFj90msGOMn6cLIbFfnzc4c7pJnsut1tzeZoPn85WcKLOns1BI/mo1JQrXXZ82m7AZzOs+ea1afxwcDVfPlrOZ/eo+HFhIMyN5cr4EC5PDOD6XCUnerzwHTGUkYIxfkP9/+f1NtpxQYQ6mrxxlVjbWFFQkE9bVzutHVoBaqV7QheNLfVU11boeh2t4HR1tVHfUEN5eSkd7S261NnZzLTpPSxYNIsjB57lzdd2M2/RTF56aTdP7NlAclIsZr1vz96p0YODj4Q4B5Kcmkl+USFjcnMICQkmMyuThoYGWltbaWttZcrkKXR1dTJxUjddne1MmNjN+O4uXersatcJTn1D7Q3haWvWNRodnS263rW1o5GsMZmEhoeRmz+G9u5mKhqrqGitZcmyWRw98gInj7/C8eMvs//Ak7p06qO3OHHiXRbNn0SCsRNPqaJIGCD55ub8/yZiB1qe3RQ6gpPlZpxv1QqGBedaLDhZrRUere6vFSBbLnTa83GbDefa7bg43oFPOuw532DL7gxLnogy5Pm7yjj80bt8+dUpvvvuNK+9sY3YkP991teprxGrV90NXGfzslUkj0z+j/dI7x/+eeIQT2KHeqIe4sysgCFc6bDh8+lunK035mKPBxfGi7jYo+FKhx2XxjvwUa0xl6aKON9hzdkWSz7ucuFEjQ2PxRtzdJwx16a48tmGUr75YKvONH8d+JFv+PHbs3zz6UnefOFRTuzbC3yHdpvM69fOU140BicHc+x7//Jepv8O6WDJqdT0TMYWV2JtbUVxUaHO+tTepe192pgwUdurtJCYnKAb97S2Nel6ocJxY3Vq0YSeDsZ3tjCxp525s6aycNEsTh1/DX68wNmzB9iyZRVHj7zGXT2TEAm/rWH7d0iHun4ZFxNJdUMNTS1tVNXUEBEeSWxMLB0dHbo0cdJEusZ30t6uLVM7LW2NurJ1dd9QR7u6tSppp25s19hUT3Nzww3h6WihvVObmmnraKK+uYaY2GgqqotYuWoeux9dw1t7d/PRUa3J/k0OH3qWD/Y/zq49q2nqrKK2oZppM6fx6O4tPP7ECiY1JdFZ/l/UzciBfpQ4/voucmWD0igxN2RGqAFfd1lxvs2acx02XOiyZ1+xKafrzLjYYsH5Nlsu9ThxstmGs612XGi35VyzNeebLHkn35BFOTGsWjKPl19/lqufnuLTa4eYPrMZV3sxWf3/t82MBgoCu3c+AHzJD3zK0488RpRHyImbz9NSOCSFMTb2n90XbMXLSQY8EW/AruhhHC4y4EKPC5fm+3Gm3pBPehy5NMGTi5M1nG605MIEZ07Wm3C81oTTzeacabXiXI87HzdZ8Xa+OY9HDeFgs5zL+1/mxx/hx2+u8N1X5/jmyzN8980ZPrt2irXrl3PffQt46qnHePnN13jqpRfo6monwF5BhBD0P5VZi8xM8vnosWMpq67Dzc2F8tIiJk7tprO7ja7xbfT0dDBzzjQSk+JZt+5+Vq5awoLFs6itqyBnzGi6u9qY2N3OhO42use3MmveVA7ve5rrXxzn2ieH+PjU2zzx1EbiPG/tpmhtQjV+w32/jYkLp6Kqivq6Zqpr60jLSMdL7EV5WSkTerqZ0NNDZ2fXDTWtq12nknV0tep6Uq2BQDum6+4ZT8+Ebp0gaXugxsY63XGtEHV2as9tobOrhZ5JnZRUlhAVG8XKlXP58MBTfHr+Hb757AgXL3zAoQ+f58mntxAcHYyhYPK1vxBMiBBEfO/AQ1Orqpi/qIeCvJT//B56Opp56+XnqfZK/8WT2+w8v7jHbzAzI4z5tlvbu1hzvsOWC91OHG915OnMkVxssuBCmw0XOx05WG3F4SptD2XFxy1WnG204FDRcN66p4qLVz7h0cd38tpbT7HvgyeorS/ETHD9n609wb2kBzZtWqzbm5QfP+VHrrLv6GMUj80m2jP6+ywhn1FCBWmGYR+3akw4U+nEtVYlR/KcWBloxsujRnKuTjvot+FMsy0ft9hyutqIi81WnK0352SdOSdqTDlZb87pJnM+brHgbLMFZ+rNONVgwckGC17OMWdT+EieKRTzxKoZ7Dv4MteuHOWzS0c5feptTp58iyNH3+PJZx9m/qJpTJrZTn1XNZb9rAgUQn/xXf87NL19CVWFXK9raqa1qwsfXy9C/f2YO2s6ndpK1tVKd08rL7y8m3H5o1i+ZDrnT7zB9a9P8d47z5GcnER7azPjtb1Vl7albqKsvIB3X9/FN58d5PjRV7hn6TR8vLzINM36n/P3awT1kuFnJSUjPYXCgnGUl5ZTV1tP7thcvCWe+PpImDihm4kTu+nWqmjjx9OtTT1dNDTW0trSoBOQDu14rrvzHwI0acpEGhpqqKquoLWtmY6OVt3YSNuQjO/WGhTa6ZnaTVpWOm++9ihnjj3PZ+f3cu3i+1y68D5ffHGa3Y89xHDB6Gdzjy6CCwbCMMT/KbyX0lz16cdXTurUj2VTpxM04KetonKAM0+mmLHU34Ap/ob8MMGO8x1aIbLlXIe2xXZmc5Ixb4424nT1SC40mfHiGDMOlZhzod1G11OdbbXWVc43Zmfxg1aR+foK73/wNCvv7yEtMPVnmf9viO6lYf1Di4AvuP7jV7oEP/Dt9+c4vLObu9SGtPqZsS3Tmqt1NpyvduRCg4jXxtiQ7zyCl8cYca7ekjNtdpwf78xHTY68N8aQy802nGu24YxWcBrMOd1owfFaU840mXOuxZKzLVacabbioyZLTrda83a5Dc/m2fHygx28e+g1rl45zrEjr/P0C1vpntaGyl2OeJgIP2MZUdahxNiEMapf9r//KL9C0Agpo/PyqG1o0FmjRo/NxMvTgxlTJzFxonbsU8fdS2fzxrtPEegvxV/uQ2PVWB7dsZK333iSxPg45s+doVN5tGpeeXUJWZmJPPboOp55fjv1zeUYGo/AtbfHL/bk/ysRQgTRQ8IvxQQE/VBaWkBlRSUV2lRZSWFhIdFxkZhZmJCXl8P4Dq3VsF1njtaOe7TjnAkTxtPS0khVVQVt2nGb9lhPl86oMHHiBLon9Oh6oLy8XBqbG3RjvvHdWiHT3quNrp4Ops+cSt7YXN5583E+PPAsx448z8Uze/n82jF27nmAObOn4N/P/zcbsYQAq6DPTl489jft/TOefXgTpak5RLt7ngsaOPLqxqARXKuwYL7KkAznoZxrsOR8u5VOMM602nBlggNbM23Z25PAtbW5fLY0ju1JRuzLN+VyjyMXuh243O3AySpjXpyZx2fXLvDVtZOcPrmXrvJsRILbb6pMBcPTqRydy/GTb3L9+tdcv/6NrhH49rWZXG215fMmW640WPJJtQUXyiy51GDLoVIrpiqHEWI7mFNVWlO7JWe0ho52rRA5cbLRmrdHm3C+wYoL9WacrrshRKeaLDhSbcbZZivOac9vs+FsmzUnG815q86bz95+gM9PPMfXX17ih2+vcvniYZ59bqduviJGuHXLNEIdVd/llxTpzLp1DVU0dzbi4enB9KmTmTPvLlra6nn2pUdY+8DdBPv70dreRWx8ElKZD97eYpycbHh0z4Ns37aau5fMoKhoDIEahW45d2hEKFEpEXjYinU7lf8eKoQsJP3cCfUKu1ZTXElncztN9Y001jVQX1dPXn4+KakphIYHMXKkAXW1NXR3aYVHa/DQ/nvDBK/tjSZN6iEpMZGyinI6u8fTorU0dnUxvmcCrV2dlFZWkJaSynit+jpR2ztp1TxtT9SiE6Sp0ydRkJ/De289xfffnuWVVx5m//7neH3fU3RNb0Y8yOn3bXQcYhby9Ycfv6+tenD9gk4l+vrCM5yYpuBIqRVfNdhyrsSSHdEWaEyG8WK6KeebzPi43YrTLZZc67Fm/Rhn7p4/my8+fgc+fZc1k2t4OKwf55qsuTLJhWvdNuyIN+a5jYv54L3nefjRB8hNDUU2xPp3Va7gIXJeeGUL3371Md99/ymXPnyEL5ZruNbtyOkGe07XWnG+zopzddbsK7HgmUwLxkuHo7EewAVtQ9Bqz8cddnzcbqsToos9jryWZ8HD0aacqbTkktY40mTBe6Vm7C0y56K25+205bz2mg57znTac6TVkbMvrOG7b6/y1Wdn+P7rT+D6FUqKx2LT1+mWzXGFCYHERURR3VCns7DNXzybceXjkPiImTd3OkvvX8Rjj2/nww/3khobQU5mNrX1TfRMmkx+RSnqXj7fhghOHy+/fz5ffHGcE6deo729Wvv+cXd1Z9TodBomN+Ni7fXJzc/+X6gyy6IueiyrFt/LhM4JdLd20lhzQ3Dq6xsoLSshryCHyqpSsrJSMDEeSUNDLT3dnbqKrxUirTqqTVoBmDRpPLGx0ZQUFzJ79mQWLZ7K3LmTmDN7ImvW3asbw8VEhtHTrRUgbQ90Qz3VmuzLK0qIjY+mobGSfR+8yPtvP8OLL+zgpZd3Ep0QhrmFGR6C7e+LfZc0KJop7S38yHm4fpkvPz/JpeWhfNpmzefdzlxqsudMmTXPx1qRaz2CGYrhXGux1FUk7aD68x5Luv0M8TC3YExOJivWLqdnQiurA/tyvt6CL6basTvTiOYoBetWz2Hi1FaKohT4DOmPg/D7Vv+1DSugJDKFwx88y+ffX+HTffdwvseUs212nKm35lStNtlwoNicV3LN2ZNmTbvncGSGfTlWbsYnXS583GF7I2kNI21a9cyS8V4j2RNnwYlCIy7Wm/JuniFvFZpzeYIDF8bbc77TnrOdDpwe78jhSiPeXVDBD3zPF9fO8M3XF7l66h1yk7NQCcG/q3z/SqEk7Yd7F0/nrrsmsnL53dy9ZA5iiYi6+hLWrFrC2+++zKkTBxgdk4qjkTXllRW0d3Vyzz33MG5UMQW9ikgS/Fk4YzrXrh3j9Lm9FOaPZqgwmOCoUGpaa2id0YWllcvFm5/935Ju6ff1oqkT+OqLE7z/3nOsuP9unbGiuLSI0qpS6htraGiqoauzmSk9naj9ZBgajqC1uZ7Jk3ro7tb2Hm10dd0ws2vnqrQpJjKYlffO4tj+Z/jo8DPsf+8x9r37GHCePQ8/gErqSUN9OT09WsHTWuOaKS8v0XkraALUSCRi2jvqeHD9fTyw4X5iY8IxNjDA2cEZe1NbNAPlX0X0CT12c3n+a6LtQk9/ePxVnZn16qtL+Hq8KZ+0WnGp047zDTYczbPgxUALKq0MKXcexFWtharHka+mOvLIWHNCzIZRJLEk1nEkiSILTEcaMCdwKN+Mt+Dz6eYsijNC5OJKlMqbLHdz1oQ7EGdld0sql0JQv9ZW2caB/c/yzdPdul7voypzTlabc6rKnP3jzHk+1Zhd8aas9jOj1HYIRn0ENkaP4IseR50q+nGHFWe1wtNmzafjLZmkseKBpjF8vGMhF2fF8F7OUPakm3CmxZFPuh1vjAE7bDjdYsfBShsu7J4FfM/Vz05w5cpBmmtyCDEK/UnUl9+DpWBER3Ul33x+lr0v7+HQ+y9RMC6L7vFNPPrwRt595wVefvFZRqmTvhvXa9SpVJ8EuqdOYPaiBRQWlRA0wu897X1kgozS7Dw+v3qUj06+Qm5U5lf+guK9gPAAeu4aT0lVGc7DvX/Td8mUJR2bO2sS339zku++OsKnl/dx5vSbLL1/DrPnTOCZ53eyacsK7l06m1lzplKQNRap4ImZgen11rYGpk2ZpDMaaCd9x2uFoLOJts4GJkxsJz4ujKee3Mz5s/u4dvkoFz8+wCcXD+pccQ688xij0qJJSoph9vzpOlel5tZGGpvraWpvpKWjkbHFYwkKDsDO3hZ7W3tMRhqjVqiJjU8kKikR/4QIfAP8cBrq8PHN5fqvCBWiGJdSzDMvP85nO6fzZdUwzjVZcqLehn3aSdAwK+5ztyDZ2ID1wdq5IGOY486Z8c4ozAYSbGNEqcKOxgAX3QKyPkJvUhwH82W3JT/MMmGOxhk3IRj/EQM+3xbjyo4kESoTq9/0oX4J5cCwN7KUcbyYo+TtTEdeSrPl2ThbXkq05YUEKx4OsWCTyoZCW2Oc+o/8Xj7Q5/hY2+GcqbLhUK0lH7dbcK79xnjoWrc1nSGOdLZX8cFzu+HoXp6cU8OiYGM+b3fikzYbTjZacaTegpfHmTE3M4Cjh5/h5Mcf8Orex7hrQgsKQ6//2ar47wg31ZzYueMBfvj8HJ9cOMSZU28RHuXH2geWcv27K9x//0LcDJx1q0X9B4kvtFY20j6xm5iIuC9kvX4qEL7GbsfeeG0Xp069Qah94OVmoRovJxGT5/UQE/FfzHn8Aopeqh+6u5s5fewNzh59kVPHn+f8x29w4ezbnDv9Fpcuvsebex9n4+ZlLJp7F2NGjcVtgNuR+4UZOA5x/KGupYbpUybTM6GL7gmddHe309pSz5LFs5nY04aNtSXR0WGUFOezbdNqXnrpcZ5+fhsvPLuZp3c/SGn+KAI0KtZtWcP0WZNp72qlua1JZ1Rpaq2jo6eZ5tZqxk9sJGNUPI5W1qhUaiISEghPSiQ6PZWkjNHExCSgNpP9Nq/5ECGBWKfgb2clqNkaMZKnEsx5JMachwItWORsg3KgAYVSQ/blj+RguTW78p3wtx2G2cBBpIstyfOxJs/TCa+hJl9EG4SjGmHOrgJz3m+3IMfOQ/dhxKZDP6rzdyHBywSfwR631DPZS5AQbGpPuq0h8+SmbFZZsUNjzyOBzkz3sibGxAD/Pl7/CBQYMdjrg+WB1hwotuZkgyVnOyx1vdC1iXaM8TbB1dODwowYdm1awdaV85kVasGnrfZcabbkaKU52+NMyXYeTtioNGauW8qk+T2UjE7AauggxILXb7Is/hqj/NK+/OHrC5z/6C0+ePdJFs3swnjQULontwCfkhIf94+KbzPIRDdYb6hrYYgw7GcC4SO4svOhFVy9coRwh8CrzUIrLmbOTJreSXTEb5v7yRmUg8lgU1qbSjlx/CWOHHmGM6ffYN++pzh29EWee3abbt1Xa2kFEnsxIYPDdVY+PyEGd0sxHW2NTJ7YrTMCTJjcRU9PO/NmTWXbxlWkpiRgMMIAY1MTTMzNcXFzRSXXEKYMYWxmCj3tNbQ0lGBiakhhWR6PP/MQm7evYeXqJSxfvojlKxcz++6pvPjaHr75+jQXzn9AfGwg5ibmWLs4Yu5kg7PInZjwRMaOLkSt9kM1JODazWX8r4nupWC0hQvjbM3JNrckx8yc2P4ex0WC+8E4mTmtUS6EikzwGag4oewXeM5i2FAi3Z3xtrHCup/zgb/fR9zHmXSNE8XpHtgPt/yhUWjHrO9IXB1NsLQcTrAQ8e5Pn/z7KR2QS0SfgIOagSakWA4j386UYgcrAoZIkP3CeCTHzJgP8204VmHJ/gojPumxYU+RHf6WQ5EYDMRnYB8ipGJSk8IpV5hyrtqWa822fN5iycFCczplJvg5WmJtbo7d8BFEGw0j2cYYF4OhSPsrfva834rcWHLh+ee38/CelZTkZiEd4YFG8KajpR74nLFZmf94lk9vZ8Zk5tHe0YNF/58baVwEW3Y/sobPrnxIhFPQ1VKhFAdTeyZP6SAh/Lf1QFqC+4eSKkshMSKOpPBoEtMjWbZqHpu2rqC+sQxvF0/kfUWfjx8w9seRwvALhsLwd11HulGQk8PErhadAUErQD1Tu5g0uZNdW9dz1/RJmJiYEREdTWRyHMHx0QwdbIyfELQ/TcgipJd6v6OBPZ5WHjgMccHB2Pm7ceV51LVXU15fQlHFOAorC8kqHkNabjLvvvs41384xcmzL+OvkuMo2F7zFTwuWfcy/97Wyo7UmFHk5hXhKvJCMsjnN78LIaFvEt5CoC4FC/98qZ5G5uT6+2Az/IaPVIqQhmG/YSgdXRBbOCMR/rmKMaFfJL62tiSHemExyOzHJqEJO8H2XRvzkThaGxMixNzWABWpveLfSRNSSeibQfOQaT97GeXW2Yw1MuXxEENOllvwSZc9b1TaEWFtgOvQwYz2sqBY7IxVb0NMBKPj3oON2R5pyDc1dhwrdWBJtAsTwj2oUDmisjLEfuAQ4kxNSHGwIMbDHLmLOZ79vG9JT6SdTxkVlU2oOPAHd8FFV5ZAIZipHV26sde4nJ+umpR5+tLY2Ibd4J+7ClkJZjyyYwVXz79HiG3A1XqhFhcLe6bO7CYl4r+Ydf8PuAv2hAhSpILPNyF2IYRZBaHsJ/04RrixtihqqOKz7uoKakpzaaguYlJXE031ZTS11OpccGbMnMSLLzzO/ffdg6uLG5rAQCJj44hJTcfCw43o/hnn//V5KUI6o4R/zqupBAVRQtgb2vGVTBAjF3yQCiKcBJv9ancJzz+3gR9+PMGowBQ6hRsOvW39m/Ac6ojM0YuE2FTiMzLwcPFG3Ovn+yb9LnyHOTMmWI6rwT8/jLS3y3veDjZ42zvh3f+GqqYlqXcsHlY2JAf54vC3D+kouOFuY467nSXhQvLvMx/+TrwNbL6aH2jGkVHWnCmw5t1cG3Lsh2LRvz/xTmbEO1ugMLQnVAi50Vj0SUQzwIW5MltmB9kR72XDKIUjWQpX8oM8CPd2xHzgYBTmI1E6jCRcbYPU3Q7/3urfN8/wKwQJAczqnqKb+8rL/KnXgIe9B61VXYRIg76OGvRP9U6LsWDAru0ruXzhXUJtQnR5E1u5fjd5/niKs4tQCLd3TyC3kfZfLl00m2VL5jGxp4XpMzpZu24J69bfx8MPr+edd15gxrQeNGoF/oF+RMREE5uSjqdUiUt/z/8pVndlr7FU/W35SLUwDruBFjz6yH188elBUmQ/9Z2sHZ6J1WBDVGo5odGRuHh6aBfzHf7Xc343XsOdSQ+UYT/ipwYAkZE1Hs4O2A6w/kll8bSzITHcB+ehN8zVdoI9UmcrRHYWBArR+//13DuJi6DE18qIWZEObAqzY1WwBYHGfRnUqy8e5sYo7c3xHeb4g1jwf+Pma50Er3eMepm+bd/H+pjpYCNUbnakKUSk+4vRNiRGggFWfU2RiW0IVrthO9IMca9bH1QkWAimp6WN699/zuZ1SxntHXf078dMBhiTEJ1EcVERMeEpBFv9M/a4iWDIlg3LgausmD/vx4yR8VgbmH9c0lzAtLumkBmb8V2U5a2b/P1XYgaGkhEVev2B5Uu59+75TJ/azdQp41n3wDK2b1rNQw+tJm1MPCJvR0Iig0jITEcVEoSDgyfyof66mOr/LTUjK4m1TMJyqLPWz+3aUGHQ112tFXzx+X4e2noPPhbynwljeB85dsZ2mFlZ4mDoREq/398j/wTXYfZE+/kgdrTHp+8/14q4D3bEy9EFKxNLlENk//jdx8mR1FgFEitnJvZuw0sQ42RthNTVDvshVsQO/m2D1t9LUt8MJCNs8JMYE6ZwwGiEEbYDnBjcfxAyFxtsLEcg7ef37c3X/Z3SXjeiqMoEb4b0GXbQ2tCARIWYAJE7st6yd4L7BmNrYkCAlwsie3vMejnc8nJmCWnIXTx54609vPr8Q7Q21mHby0pXKcKEINwtRfgF+OOpkmBr8k+NwVmwJUSl4cMze3n0heVkJiczVBj6g9JTQWl5FXEZkYTa/3y8eCvw6u10qXhsOg9tXM+8ObNwd3bGzMiYkYaGjBg6DIchNngI7rgOccXJUoSTiRjRUNm3zr8hvFSSQcpBh4EuJASlEh8ZRUF2Cnvf2M1333zEuMx0PPt4/WLEnXxhHGOEX3es/l049rM/5+luezk5XH7Z39bzq5B+N160XW8rjEYYXva2E112tLW7Junt+rb2dwtj48txgT6XE2Tiy6FGsnMJvRIY0nvgx642FpfdXcyuehq53bK5kv8VdW9v3OwMr8SpXa742DhfqRtehLq313lnO+MrIb7uV9yMna6m9sr/2YsU9Xd/z6Wf9Q8VQq7uWEbfbMwGGV6J8hVf8XRwuhLcK+youpf0qNGwQVeczI2vuFjbXbH4DcsW/hsih4ejclVckdh7XnE1cr/i2f+fMazDhDD8BX8ShQRS+/006GPgwMDXvN09r7g6uFxxNnG7miMUoBBUWAh22PdyQdXv9uyW4TLI/PzUyQ1XNm154IpcqbgybPDgK35q+RV3iecVSS+vW67Suwg2uDg4X6kqGntl1+bFV95866Erjz3xwJVwu6BbagHWo0ePHj169OjRo0ePHj169OjRo0ePnt9Bct9ohg0d+Y2LXHnF3UN6Jbr/jVgEdkOtD3n7+11RhiVc8VAHXREZ3TrfNT16/k/h2MsRazsXAoPjkcuCcRnq9JVh30G4eYrQRCUSnpKNTBWOfKjfOzdfq0ePHu1uef28kHv7ExiZjCo0AktLK4YMHIBME0pwZCphCZm4uvkSKkTpJoH16NFzE94Goh+8lX46IfIPjcPGzh5zCyv8g2PxD01AExWLrZUzwcLtmYnXo+cvx5gRccj73ViVGSxIsDCxwEvqhzIgCr/QeJzcPfH0kuIXEIUqMAJ1RCTm1nbfugr/9CzXo+f/W0xNTL6y83TBzdgN+6EWX2sDhxsMH4mzqzea0CRC49JR+IciUwajDojAV6HGI9AfGxsRvn1vfWhbPXr+UtgPtj5q7eKEt6+MIE0IniJvTIzNsbd1QeLrR2h0OhFxmSg1ESjUYYjEElSacCLT8nB19Camb4ReiPT8/43HUA9sHZxwtHdCoQgkODSeoJA4VH6hyJVB+AfHofIPx8XNC2s7exTKIJLTignRhogydWVUn1u8LkSPnr8SGX0zsB5qe93a2hobawfc3CX4BUQSGpmCX2CUrsdxdRdjZW2LXBmMt68fgWEJJGbko46OwXKI7X8dILF4wFi9sOn5v0eZkIHnEPtr1o4uODi54+jggq9UQ3BECqGRqXj5KHBy8SA+MZfgiCSkqkBikseQml+ORB2M3a8EgSwZXKD7PWvIaFwGeyLqL9H9P3BYIPZDnVAP0KuAev7iSPq4HRP1cdjvOdT1SyNzS5TqMDSaCNTqEPwDY/Dzj8LT04eg4FjiE3OIiE1DqvQjJDKR5OwSItNycbIVfXHzdiSRA4LfcvrbalPfoTIG9BtGhHH8h9r/W/Qxu27gYYloiO9tiYmg5/8jbHuZY93HBHGvGxFl7jQ2vUxx6m2Pm6sMf79IAjVRBAXF6lKI1hIXloi3jwKFMpTI2Cz8g2Pw8PJB6R9KZGIWydmluHr4ohGUP8m/+WBrnIfZM7dXD+KByos2w+zJHBJLRu8kTAytr9tJpcgHB9yaLQL1/P9HZv8UfOwU+AdEovQLw1vqj9RK/du3kviNRPTz23+/MJ+IvsHv+dnL0PiHEhgShyYghsCgOF2PJJVrCIlIITw6A5UmAndPb0ReMgIjkkjOLsZdO1ck/DMORJAgfdfVyx+5dzARgs9BZ3NPfJ390fTyPOgoWOIp0yBWheN7C+PD6fn/iOTeETiZuaMOiUEdGI1fYDgyv0BclWo8DTy+dBIs71jFah5Y9kZQbzlFvfJxExwxNDJALJYTFJJEQHAiCmWYzoggUwURHpVBQEi8LrieTB1CaHQq6XnlusnWEMFPl+cGoYSQXtKDXqooxNJAhvQfgEQejEwZyoB+fTE1N0cVFIGLs4Lw/pF3rJx6/g/hPsz9mkimRqEJx9nTh7CIYHwlnlja2hMcGM240fWMja4kzTbmjlQwUW+X6+b2DrgrNLiKJLi4e+EtUSNXBCHy8EUskREdO4rImFH4BUYjkWkIi0knKjGbzLwKvFxvRKqM7BWJvI87iv7iK24+GrzEfhgNN0AVoB1LRWIwdAQSmQp1eBSuI/7D7mZ69PwatsbOqINjUPtH6iqkm6ccGzsn3F1FRIUlk55eSFZ+OaHxscgN/xkK63aiGqk65KUKwj8oDr+gKGTKANR+Yag0YXj5KgmLSCYi+kYP5CP3JyA0jvCYDFJHF+PmIsZZcGCQMOSi6UgjevXtjbuHHJGHHGNttP/AGJ0J3NnJncDwOETeCsR9f0d4WD3//xImaHBwcEUdGIWvzA+Jjx8SmT8Ozm6YmJrg4OiKo60LxoPNf3C09MTfJOJnAQxvNZo+wdgL5p8YDBmGs4M7/gFRhEePIiw6QyfknhKZzh9Oa9JWB0Tj7umjG7eFhKeQmJmPrbMzg3r3w8zUDAcHZ4YPHYG7mxRPbxWmpuYo/aNw85AhkaoJjEnE0+6nBgc9ev5rJIO9zio1oWiCYlGoQxFL5Ng5OTHS1IQhg4fiINyavYH+F+x7O2BsYYqnhxyxpxSFMhhNUBwKTQQ+Ug0e3lKCtBa5iAzUAVE4OLuj8AslOCyJ5KxxOLi6MWT4QJzc3XFwdMPLS4FCFYJMFaITGqkyCF9lIAr/MLy0BgRD+S8G7tOj59/i3tcNVycxQWFJOgHSBMfhFxCBp7cv5rY2OPZ1/F1bCP4e3IeJkDurkXjJkCg0eMv98fRW4+klRyT2ITQijYioTJ1PnL2TK3J1CEFhCaRlFyFRqBlhOhx7FxfsHNyRygPxD4xGqQ5FoQ5BqggiOCqZiOQsfNw0BPf6c1rfVIIl3oLhnypvqr5eGJlJPjVxCb+iVZNvPv7/BQm9QxCZemLv6Iqb2BcviQpfeQAKvzBkykDkqkAcxWJEfT3P3nztnSRO0GBhZKzzfwsISdIJi9hLibObB76yACKjM3VjNlsHZ3xkGkLCEknLLCYmJZsBQ/phMNIQW3tX3Nx9kStCdCZwbx+lTphCo5KRBYQRYnD7VdL/ldw+SpQ2kYgUWXj75eFpovnTVFS54IWZuQqn7Gn4hJbgP+j2Brj/06Ec6EmQPIyI5DRCo5IIj0vXqTWuriK8fVU6VUgVEI6nWom3gfwPDauqGux7zcbUEnMza6ytHfHy9kMi8cPFXYzIW6ozMGgX2LmKxDrVMyA4lrjEMaRnFmFjZ0ffvn2wsXHEydFDt4LVy0uJj1SNrZ0Tlja2DBw0CCfBkei/7erwRzNKiCKxbyAyeSohpXOIKllIYMlClJltiC2lv31f0FtMVN8IJMHlxE55GM+oIjx/4+7tfzlUA31fD/WPJiEth/ikTKLjM4iISSM+eTR+/sG4eXgRGB5PYEQ8mrBonB1E+PT+YwbYKkGF+3B33D29UKnD8VNHotFEo1JH6OZ5vGVqnUVOq5ZJpEpEnt5oAmMICk0gLi6byOhkBg4ayAgDA91KVnMrW8wsrTE0MsbYzEy7EA87FxH2Ht442nujuMlz4U6QKKhxMHG7KlJnf2MrCv3GSRyLa0whkrzJBBZMQ5PVgVt4IU5heTj6hCMSbt1Wm78XL6sYwto2kTxvJw6G/x8saAw29EejiiAkMpngsDjCI5OJjh9FTMIoklJziYhOxsXVU+ecGRKdgiY4BltHJ0YIRn/Yy8kUMgkwVJ+3c3TF3kGEWKzUCZNE6qczHLiJfJApgpApAvD08sVHFqCz0gUGJxCXMAZ1YBhGpiaMMBrJcEMDjM0tdCbwoIgEYlJyCAhLwMNXjTQ6GieRBJ/bsLXJv8PdWErw2FlEdm1FWjIH15QanING4SSPwcRBylBzNwwdZBg4KhniJGe4jS+exgG4G6q/tzbwPOv6B45B3CzDCay8n1ELnkSkSUXZ69fn0VR9pThbyi+42AdesLOWXzC18bngYR16IW5A/K9e86fCv7cUP+8gwqLSCA1PJDQikaCQWILD44mKSycqIQuJVIW2ooZGpRAWmaIblFvbOmDW649t9YKGq3+0sXDA3VOKXBlCgHZeKCBKZ0hwdffWrU71kih1KpybhzdiHyVyVTDBoUkkpOaj8A/HwdVTZ4SQq0IJCE3QuQFpF+dZ2ziSOyoDsY8UcYAfw4cZYtnX5kPbwdYEDv/9PZKtMPzf3sPXZwz+ZffhntWCfdBoRtp5M9xajIFbKFZh5biNmYJrzkxCWtagrF6GV/E9eBfOxSd/Bg6BBYx0D8PWNRKffl4E/c3z4k7h6ZhEUPVSQpuW4Ve7EKcB7t/8/ViMIMZ7hAipQywih0jcZSkE1SwjsnkNASUzcYseh1VoNqam3ogE+7c8BDtEgiParV5++pQ/Aar+fvg4KfGV+SOTa9AEhhMamURQeAJBusnHVIIikrCwtMHNw4fgiEQCgqNRaEKwsXdC0lf9hxYqZljMu34eoaj9Y5ArwhBLVHh6y/EQ++Lg4IKruxfuIgkeXjKdUDm7ues8FQKCY4iIydTNDYm9VUgVoQQGxRMQHEdIaDJRsdlIFYGoFApc3dxwchch8pCQlpHPuOJaRiWNYazVb18vFD4s6HXX0LE4q1OQDfnlSVrZIDHGTorvLcRhmInCsdHkIsqeiF/NcqI7NzNq7lOkLXiOkqUvU7z0NeKmPUX89GcJLV+IOmc6kU0Poqq4B9uYIqwUSbgO9dVt3JXVP+MXn3er0AwJQjl6Apq6JciLZyPOnITrYMll7TH5kGC87SORhdfglTMHt9HTcEutw0oZy0hrF0baemHkpMLcKxIbzWis1BlYShMwlcVjYivDYqjouvtA+ZdFwp9gYWTMoCjkLhpCwpMI1HoaaMJ1VjY/TTjBYQl/E54E3D3EjBxphLfUD3VgJOrAcMRKFaYj7pwP3L9DMVj+qdUQa0YYGuuEx1uqwkuiwNlZhKOTdpzkg7uHBJGnDyKxN95Shc4zQTvxqnVC1fZcKk0kGv9oNP5RhIWnEBU1isjoDLzlGt0KWIlETURoMonxOSRn5NPQM4Wxo8qI6PXb1ghp+vt+7TG6g4iWNUjSO/AxS/jHrnR/J18Iw6yX+Zemogh8cu8iafoeYiY/TNa858mY/RwZs56kbMXr5N39PNnzniFp+hP4pDcjSaxm9NynGT33ObxHTyMuvwJFZg1WYaU4m4cQO0BFSK/f34P+Gl5Gfkd96+YRULMYz6R6rNVjcO9/Q4C0iM1DrrmEj8XKLxUTVw0jLFwxctHgEFSAz6iJqCqWE9i2jcD6tQS3bias8yHkhXfjllCPWVAOpoH5WIhicBwiOfTTJ99hXI2cv1MogvHXROrcYLQtrtIvFKUqBE1glO5vkZcPVlaWuIu8daZsX4U/PioNZvYOSHtJ9958zz+KMEGN1WDzLx0d3bFzcMbR2V2nwmmFR+QpwdnVHQ+xDzJVgC5ij1+w1ilW6wIUhFQdhFQZiNovUrcMQqOJwl8rTJoo3e+2Ti6YmJljaG6MoZUxJnaWWDk74SKT4DlQ8pv23vTrq/jCLb6M0RM3E1h9Dx7pLdibKK+lCgGMESLwErxwtk/CLboR/9rlRE7ZQ/69LzHunheI6XmIhNnPM3rxq6RM3UF813qyFrxIwtSHsVcmENG+iajG+0no2YVPRgfp0XK8NYm4jpqKc1oz3mHpSEw1b92cp1uFVT/rs6Jxk/DN6sDWN4WhDkosBfN/bMDmLlgwsN8QDEY64yDNQpo9h6D6dYS2biVx2pNkznmWtNlPkTXzSSJaNpC24CWCalcgHzWZ2PHbiGxfj1vRQoxj6rBxjSNlUOqd3WI0QYhEMtLzG29PGRLtHI/UD5VfiO5frdBoB91aFcja1g5jY2NdBdQOxuWKQJ1J28HVHeOB5tdvvu8fja/gcbhP396Ympjj6uF9YxwkEuPi7qFT25SacN1ksDIgErlfKFJVMDJ1KD4Kf9w8JTr/N63VzluiQuQpxVHkjpGVOSNGGmHQezixQsh7cULkW2lC/Fs2gjmSfvLf3IqP6p+IvWsIWRO2k9i8DK+sVmwCC3D2HYWHfCzq7LuI7nmYlGmPEH/X48TMeoasu59n3LJXyb3/TeInb8M9MBU7VTIWbiqk8eMIKpqAb1wORaveJ6VrDaPmPIVv8XzcwzJxjG8hvn0dc9fvon3ePBSWoT/ZIfu3Eia4ojBQXHBXpuIcMgZnVQZ2QXm4Z3fgHl2OcuwsXFPHM0KViKlDAJZGPgy3kmCjzkWSNpHQpk2kTH+MrPnPk3DXsyTMeIqxS98kb8kr5C5+jdgpe/CvXYFXfC2jZj5O/MRHiOnejjSzC//MZjzyejB0CEQ2UHJnGnPlCF8k9lIk3kpksmCdxcpbotDNwGsNBdqlABaW1jrzrpGJKY4uIjzEUiQS7RyJChexJ1YmDsj6/LkmyPz7eb1uY2SDk7MHbu4+uLhrBchXp85plzb4Bcbo3H3UATGoAqJQ+ofrJobl6jDcPH10k8YiDx/c3L2wd3DG0NQYs2FmeA3wuiUV7ZdwNVF9E5DWSUD1QjyS6ggqvpv4np1E9DxCypxnyV38AkX3Pk/2wqfImP8UuXc/Tdmq18m77w0yJqzAIygdK7883MbMwj1zIsOc1Yj8gtjy5lGyW2cz67EPyJyzE/+2tdQteIjmzi5S40KRDbGmqm/O7/5+PgM98HCPIbL8HmK6HiSwfhnqqnsIrLsfcXIL8vROEibtJnnqw4RN2I6iaimeo6fhV7mchCkPkzD5IfLveZa8ux8nc/4zpCx4mdT5L5I6eQtJPetInPEksfNexTVwFLEt95G58AUimleiqllFWOIY6oszsfFJwGv0bEY6BuA/IlC3gvi24TrC6V1PFzFKVaBOTZP4qHUC4+TmgZW1HdZWVpibmWJpaYNWFXJx9cLRxUM3jnBydcPRxRVHS2dUg/88M9+jhGjsh1p/4+0tR+MXhVKlNSSo8ZH561xytN4FfgHRBATHowmMQxMYq0tKv3DkqpAb/n2+SmwcHbGyscPUyhKjIYa49bU/Fd474LaWM1Dwwt4tAJ9x0xGl1JI9fRd585+l9P5XKVy5l+Yt79G+9R0mP/wOrZv3UrnubTp2HaZx3V5mPPURLetfIDi/BRe/dMylSQSPG09oSjrPPvMED+3aweR589n/0Tnq5ixh4d2z2LVxFRs3rmLKvPEojAN/98SreogGN++kryWJlWiK7iK6ZR3RjWsIrViMR1Q13qmt1K1+jdateylb9yZpS14hfv6LJC14nrH3v0jJqlcoWPYCBfc9R+7dT5K3/A3KN39IxoxNRDTPR1PQQWDTSlxU0eTd8xwxM56gYfE2MuY8hU9mK26+AXjFN+GbPZfgxrWosqsJHXGb6mbpoHw8BrqcHTp4KAaGIzG3tGKkkRHDhw9n4OBBDB06GBtrKzw8fPGW+OlcYrSOlmbmlpiYW2BiZMnIgUaHfXv9cyXnH0lp72zkfSWX7YxtEfv6ERSaQlBYMv7aEFf+EcjVWgHRBlkM0TmUar0SAgK1QhSDQqUNgXXD503rwuMl88PO3YURhgY4DNCO7f73naR/C0GCGBuvKBRli3CMLCJr2kZeOfcJez98hWfefYkTF05z+fOLXLp2iUOnT/HEgaO8eehd9h98k31HD7Bt/xmeOXmWZ198iIcfX8PFiwc4cuh1WlqqefPVJ3h454Ns2byWl17aw57HtvLBvr0sf+A+YiIif/Abdmu+o1iwwNRdQWzjasKqlhJSfrfOO8I3cwJOozpp2b6Hl84fZc/xo9z99JtM2fkKk3e9Sc/Od+je/gad215n+iNvMOHRfcx97ghZM7cR3LAEv5rZeKcUoyqdgZ0mic7Vj9Cx9jGq71rCsiffJqJ7E6ra+4lpWUHP4lUk5xdg4iVCYa28fauko/uFYWvlhLWDsy4MrrO7p67l1aprBoaGjBw5EpFIho8iCCeRG0YGIxg6YhjDBxti2/uPm5S7mYQB0Xibe+Ms8ULmH45MFYbcL1wnKEqNVjD8UWoib/yu0jqIhup6IpVKm8JRKsOQKYIRiaW4e/ri7CnB1MIGl97ut+/l/wJOgxwuizJ70FTci2KUtiVtZ1x5J6mB4aSGxJGbmMKqxRN57aWt/PDFUfj+I378Yj98fQC++4hvvzwJ3x6H6yeBs/DdaeAyJw6/yswZXSxbPpfVm+9j9n0ziE2Oxt3OgxGC8S39jvb9XU5p8qcTWLaQgOKZRDQuR1m+EJfMdhzdo/FwCyM7K5tNjyzl5JlX+f67j/nyywt8cPIor314gJWvH2HD24fZ9f4Rnjh4grsffRZ5ah6OQQmEjh7HXQ9uIzavjHHF+Xz7zQVKG2p57tVn2P3OMVa8cJCOOYvIz0kmIlyKVOmBh5Hn7dlQQDrUA6UiCE14HN4yDY7uXli5OmNpZIe1YIFBr2FvmWjNwF5KHB08GTF4OIYGQ7Aws0QxMPRP4VApGei6X2rhi0YVR3jcGIIi0nU9jaODK25uXnh4SPDw9MbL2xe51rPaLxwvH7XOsVSuDMVX6o+P1F/3f5FYjotIgomNDRZmDrj29bhtVqlfw9ouAHXtJsLqlxFWPhsnnwR8/8VvLEYIxmywGa6eEurra3loz0M88szjvPD6a5w8+T4fn3mLM6fe5uMLBzjx8QEOnPyAN99/ic3bVjNv8Sxik+LxsPVCZOSC023wSkgXgvGRlhJYtozg0tn4V8zGKbECO/sgVIPD/2EZUwsaZH18TuUmJLJ4ySTeeGsPn399hG+/PsT5T/Zz8fIhvv/qOF99foIrV4/wwYGnOLD/EU4ffRS+2se50+9RWTaW3TtXcfD4eyxYPI8NG1aye8cD7H39SV5+/TkefnEHWRkpuoWSP83lLUA6QvaZp48MuX8EvuogbNzdMTO3xXOI+EhYr7B/PNDe0JqR2hgA/f2QC7KLxgYGeAzzuTPWjV+hsG8esj7uV+xN7RB7KwmNGUVUfC5+QQko/CJwcXTD1toOR0dXXN08cXUX4eTsqlsT5ObphYOTKx6evnhqJ1I9tBOpnrpka++IhZU1RgOMUfS7fXMiv4ZrL2fcwqsJa95MSPViXAKzUBoF/mQuSDxc+bFrXC62/rlYKksJKF5MVPsG/Irn6sJ4hfoFE+4XRlxIHFHBMWiUwXha+3webBrwrsxZjmMvr5/NLd1KXIbL8E2fQGj1CoIq5mIvi8C1n+j0zef9nXBBurd3PwPkan8S05LZ9OA8Lp95ka8vv8XVc2/y7WfvwvfHgHPASb65+hpvvPMEH1/4gE8/Ocy9iyczvqeRxcvu4Z4VS1m++l7mrpxPYl4KEpE3LoLFrf2OcQYJKO39cNeGubVxxsZRpFNXnI3dcOnl+rOHBfSVEGii+Yd5OtBYRJDpH2dtC+mvwcdWqvMUCNWFrErRqWnuXjJdcrZzxdLABNORZpgON8PQ0BhDc1PsXV1wdHfHxMIcA2MjDExGMtLMBGNLc4xNzTEdYorbAEdGCv3J6p/2h5TPorcJrkk1KItmYCNPRjIs6GeVPXJYMh4G4sN2Xkko8u8moHolyqb1uEiysRXM/m2+UwYm/dvjtwI397jv/KvvQZbcgbOT/9dq4dfHjmLBBWdn5Q++aR3IMttxDx+Lo7kL6UFRTGoq55Fd9/DWGxs4uH8HH+5/glnTW0kv78CvYiY5E2dz9MwHfHz+AJu3L6eoPIPRBfGI3BzxcPRCNODX/ex+F86DnA8amJlg6+SEuZ0VllZOuA2SHLn5vH8lyjriUoJ1is5CU2WfRKzzP3uoO0WC4EuglRo/dThh8aMICU/TqWDePmqdO5G1iytmRjZY9TZ7y0VwwF1wRSq44CM4YzzMWBfWd+iw4YwYPoTefXth2tuCoD6hb/n3Dn5L2ef2Wtb+Wyx7WWDoG4qVbyzOg29EQP01vCS5KMvuwb/qHuyiS3Af9AfPwGvVsoEhR22S8nUqm++wgM9vPn4zIb2j8bLw/1aUWIJr/Bgs7HxwFpx15Zb2UiBzlV/QuMm+CBRLkPn54ZvWideoCUiLpmPiG0h4ShhJqZEo/WXIbRTXNEbyC769ftkF6pbiO9DrnLuR++cuQ90+D/svdicIHCYh3emfXrCyEeLDMivZmZ+edftw7+14UOosRRWuDQYSgq88GL+QaN2Say9ftW5xnPNwVwL6/bRntO5ri8NIu+NOvt4EuMkIdfDA3skEs+GmRPRO/I/l/iNw7+NMSK9/b3aNFyJxUWehqF6MZ3I1zga+/5jR/yPRDAreb+ypwH6E97mbj/07wvtGfujf2/+Y4l/i8v0rYYIU1+Ai/GtXEVi9CFl+DyYDzMgQfK7ITGzxMPb6xev+VMR6R3wd7Bb0aYigwlwwPevi4ku4dfTBsIFhhAy6vTu+WfQ1u2Zhaqfb00csViBTB+GrCkQs1eDi6IPzQJf3b75G3icIZ1MnzCwscTP0QGMkQWnjia2RE+rhf0IP3v8RN1s/rJ38cBh8Z62E/4lyIf2Wv1u5UeSnytwZyEvnEdq2DCdpCsGCnMR+gd8FWqsIH3Hrn3nL0LgFfuftI8FXLiUmPo7gcK2VxQdrOxtstNIvk2Avc8RrhNdtDXFr09scL28lSlUQHl6+OLh54GQiuh44IPhXX55vPy/cBFfu7j0bZ8EWSd8/ZxwDPf8eaxM5snFz8K9eiL08meCB//Qct+zt+Of9pvIBamwNHfAy8jkgGiw67DdcSbBd2GVvQ5/LspHKy0pBimZYAF7DfC77Db69a0sS+kUiN5ddtrW1u2xuYXVZNkL1P6kJev66OBtLDzr7JV+2d1Je9u/36w2mHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj169OjRo0ePHj23jtHCjY13U4V0MoXRP4mKOUYYg1yQvmMyYuT7MlvRqQSjWH3UzP+f8BnoeshxgMUhpz42h8KF8P/48ZOEJGSC9E1Hwe6QUx+7Qw69bA6ZC1aHzAWLQ3aC3SH3Xi6H/ATlHd/V7VaS0C8el15OOPZyRDzY/X25uwiplzOhATI8nRxxMrA97W3kfkpi44qbix3hiWJqWyPJK5bjH2yPzyCfkzffU8//MZKGhRDr5My8XA9m5YgZP0ZCjr8HagvXi4re/wzAHjEgDPO+ZuctBxifdxhkdcndwQkPuRPKYA80wWJU/u7I1K5INS4oAt2Rh4pQBHojt/PGdogt8sHSy4H9VSftBOv/KJx/FI6CC6aCCaK+oms2A+0/EDs5owx3QRXpjm+oC3HZgTQ3FDN9YhUpWRoS0+QkZPqSkati4pRsprWl8uCMcWQFiMjOlRLiKv/TllXPLcJnmDVLC1x5qlnFg6UqJqZKaUwTMybWjQCRA/aC1ZdmfYy/NhxsiIu3A/5REvzjJISkKRlVHEZBXQxja2LIq4qhqDaBvIpYShsTKGuMZ2xVLGHpvogDnfAOcsUryAmRpz0ugx1OOfazxWqQOeH9Qv/QSlYplOA0wPags4HDCRcHJ9yU9vjGuOEV6E5qroaKljiq2+MY1xhKbnU8k7oa8HK2JTZRythCP2bOHsOqNRXU5YYwLSWOeFc5i1S5tIXmUeQ79g8tm57bjGMvCWPVVswb48HENA/ak7woj/AgwM0GH3tLnKxMEIltCIzxJjTel5hRKnKrwyhpjqB9QjjVHaGUdkaybMVoasZHM6o6hGlzkpkyM4nqzlgyS4IJipcwpjSE9s5EWlrjGVMSSkqmH9FpEpxV5kg8RHgbivAZ6Hn+5vzdTiL7ByExFuFr54ZftJjcpgiaJkdR0hZMTq0/qeOU1E+OorY7nKquYOomhVLaFUpOuR9pY6Qk53iyfEU+S++tozrVlXaJL8WmgX+KzZb1/A4Uhk6ED/jPYxgtkf1iyXKzpzDAmtxgZ8LEtng7WmJjbY6HjyMB8d7E5akpaI2iYXIiG9aX0D4lifymUHZuG83cRcnkN4Xx9O4Kps1OIqsmkE0b85h/zyjK26MJiPciqzyA4rZw8hqCyW0IoLwrjLIJocRkqmmsq0SmdsM/TYw4wh5HS3ukfZSkC9n/Vf5/C2lCNKKhLpe9vZ2Iz/IjuzSIUaXBlHZGs2h5CstWZ6CJd6OwPYj66RFUdwZS0xVEWYc/7dPDmD4niqIqBes3l7F5SwehlsZsFAUz0+inRgU9f1Gm5LtQlaEkXRT6Zf3A/6xCJPXT4DjCEDPDoZiZmyAP9iI6N4CM8lAqOyPYsjmFis4YGiYnc+yNFubOTSWtNIiS1mjGNUUxpiqM0ZVBFLaFk98SRmZNCNmNoUSk+xKTIaVuUixFnREUNAcxcV4UE+dFMrZBQ1pWEDWZYwlXuqEMdiMkxZvgLC88gx3wdHLBzdj+cphZ8G/aAby3bjfmIQhCf13qL/THVBiJqI/TSXtTS3wC3EgrUDGmJpAxVWqWLotn4X2p1E+Ipn1qHHJ/R1omxdM0I4qmyaF0z4hg9uwwJk0JorZByV13JXL26AMURGuoGWbN00NKrt2cBz1/UZ7ojqS5TEplnidhrs749f/3A1mxIMbWyAJnLxvkYWJyK4O4/94kajqiaZoUy7IVqYxriKaoOYqyujAKK4OpaA6nfVIE2zdnMXVmLGPrg5m9KJllK9Kp7wyhojUMhZ8zi2cms2ptNmNbw7hvYRJb12Vw17xo6rvCKK8OIjrImbQsHxILfclvDGDCXUk0dcdR1xlHVWMM0SkqJCaqD27O878j0Mj5k8mp7rSmOpIbbk2cyg6RnQnDBg/CVWJH6BglKeUBrF6dwqz58aSXK1n9QBo9M+Kp7oqkpDkMpa8dj66qZMrMGLqmh3Lf4mi++nAzW5aVUF6n4MC+VTwwtwmVIFAx0pL7jG+Yt/X8H+ChJj96yuSUJYsZG+FGvNQN/2E/3bc0WojHub/rZVsLB9ylLgSm+JBR5MfECcFUNAVy76J4KppDGdsUSllzGFOmRFHZHE7L+CimzUigoSuStkmR7Nw+mrVr0qgdH86WLQXse72OaVOi6BwfhVLmxPqFmbzxTB3lHWGsWpjGQ5tyeXBlOt092jFUNB0zo6idFM7s+8cyd+5omsvDqSkIJDNBgo+bFQ6OpgwfYvDVv+ZdS45QTrFQ/bNKKxlmvffuPHe2N8m5K9+L2kwvojUu2NmZIvZzIKMqkAlzU6iaEMGMhfG0dEeQWamkbXI4u7YW0Tw+ityqQCRSCx5eUsT7T3bx7LoiHl42iouH9vDKowuYt7SMQ29toCJGTYWdDTO8rJinVDHHfdzP8qPnL8jDDT7MyJdQGONBUaQnYyJE+Ktdsba0/sbEwPSkyYiRZx0cHXD0cyI4U0ZhWyR5jWEUtoQycWoE+VUaSpoCWHR3Ej0zIpkzL5pda5Mobw5l56YxnN9bQ1NXBJWt4TR0h/HMngLm3p1G69QYmnoiKK4PYcaMBCL8nGlIV/Hd4RVMaYlj3dRUXn+ilskzQmnviaCxO5SJ81LZvqmZu9vGUByhZlyImNoUObMb41g2LYG2RjW2Rtbf/mv50s2DSZa4Eersgl+fn/au8oGmb85OdmZmjg/jolxRedrg4WpJRLInuTXBVHRF8eSOUqbNSiS7RkX31HAmTwln0+oUNqzNoLM7lLtmRLJwSjS5SjdOvrqO0+/dz3uPtfHBI528vftu7p00is2TxvDlsT0cemYNm5szWB4lYl2SnB2FFZcmanLZW7xIl69U4xC9UP3VaIw2Z2m5F+1ZYkrjvEgM8yQ2W0ZcjoKMYg0ZJf6MbYhk6sxUZs1JpLo7nAX3ZtAwOYquqTE0doYyc248n7zeRvuUCGYvjGXB4gRapsUwZV48u7dmM3dBPD3ayjcrgtlLknhyfSab7o1l4V0R3DsznNWLkri7O5YodzM+2jGbQ4/dz8JMP95/pI09D5WzcVUZG9c28cjqZjZMK2X73V3sfWQNp15ay6kXlrJnSzt3T8kmXuyNqs9P98GMMPD9bnGxK3eXeVIW6UaUqebtvx8rEWJINrf/Nl1uh4v5COwdTIkb5UP7jBjWrsmloDmUvLoApt6VwDM7qumZFMH4ieFMnh7JpJmhPLsljYN7RvPlsbnc35hDlZM7H+24m0/fXMKpJ6ZwaGs3z9xTw0M9ubx8TzMXX1vBd0c2c+zZ1axuTmJhlhczspTsLs0n1NyWrsoEfAxc9/1r/vX8yUn1sGB2gYjqJDdKo0WMivJiVFkgY+vCqe6MoqYrkoquMMbPiKBncjAZJb6sfXA0E+fGsW5tBnfdFUtRoz93z0ugYUIwE2dGcc+iBOYtiGXOnGgWzI1kw8pkHlmXwcu78nn24QYOPlrEvh2jOfdaFyeebeatXRWcfK6H+xoSKJE4cvnVbbwyv4WtdaN4+4EJvLl+EseeWMmmqWV8+ORSDuyZy+buLBZXxDE61BVPS8svPXt5/mLrLR0g+nplvguba6S0pXtSnCxCZeN48e/HG4cW4mJghYW9AamjZdw9P5HuufGsX5vJ9NnRNHeH0D4hkhe3FLLm3jg23BvG69vTeHnbGI4/V8+1k9vhq4Nc//YAu+5qplEtZWF+IttnlPPa8nbeWz+V55Y0s2RcOJWB7rSPDmd+Zy4P3d/KsytbeGllLfOaQplYG05GlBeifuJjPy2Bnj81tr2sKImypjjKmfxwN7LCvShsi6KwLYyGCZE8sqWIhYvTmDM/np7J0Ty2rZiemQksXzWarhnRzJkbz5blqUyaGMSixfE8v20c7zxcyluPlLD/qRpOvjmJq0fu4fNja/nio61w6Um+P/8wP1x8BC4/BV+/yvXPX+HHK6/DtVfZ1JlHnrcLWzuKeL6rmoeqCtgzu55d88t4bGkdc9sSyEkQEyuT4W8j/dhDkPyi4Pwd/4GB1Abb8lC9N3cXSqlMFhERaoe9iRVG/U0Rm3geiU1RUNehndANZd6CFKomR9I4PYzF98ayZOH/a9/eg6Oq7gCOX8DQEKlgIAmb52Yf2d1kX3nsbh6bsJvH5rUhCWxCNiEPlKeER4AqEKYQmkAwEDBEkYmIQKQ1BCg+hoo8ldgWCjJBBbTyaMGMkA34whSp3w7OVAsI4qjTWvfzz/3jnnt/v3PnnDtzfmeOjWceT+eNF4rpOtbAhXfWcvnvbXzx4QG639rKm9vr6DlxfRIdpffiK/xxYzWz7DE4osVk6MU8aNcxbmQMObpINH1C/zZE8CVQEKH0E6ORSDBr5STpZFjUKhI8jXfsi9v/oPgAEUsrlEwbEUahWYYjTknR2Fi2by7h+KsPc+jVhRzcs4jOvbV07q3n3OFVHDuwmE/PbODC6d9y8cQaLh+toetQDRff2cyHJ1vpfX8n/+zu4Mq5HVy7uJfenkNc6enkkw/+zKWzf6Dn/E6uuDr49NLrvHVwIy+3TOX11kf4vOcQFw610fKrMmZlxVOdl8jMzGjssVJGxISTrQ9DNXDY1UhBe9Qu3P0i3KkRf7GrWs2jY7VMz1GQFi9FGhVMXJYOe1kc8+vzeOKpQn5dm8xjyzNYtng4L7ZksGOTk1Md1VzsXMZnZ56F3lPQ+y4fn91Nx9pKNlSZaK/WsrzKyiNTShiTbcUkk5Au1X5uC4zuTb3P2JvtZ+iNujfi/Ugh+a7zdfsJaXQqeHyChsocBU6rnDxTKLm2YIrHqMlNNyKVhyARBaFTKEhPMpFtjic308DvVo7l7dcaOXW4ha7j6+l+bwsfndnDR2d30XP6Fc51buZkx2reeHklHdsa6di+gv3tS9nXXsdji8ooGZXE3HFpPD09gbWTdDQ8YCQv1YglTotZr8KsV2KWypF5DyJECL6lsvZdRA2QntkwWU7L9EgeygkjJTGMlNEGyioTWNGUwYJaC8+tz2XHptEcbC/i7M4ZnOto4LOu3fDxMXpdnfScfo3zR9pZu3wmM3J1tFZGsn6ugTVVWobd50WApyfFmsFYB4mxC+XuyfJzsWWSmnVTdVQ7w5mcraTcEsJwTQBqD+2Jm9teVyoUoxAkl0y+nlQXqHl6Xg5tdXk0PZxOUbqF0gwrpWlWRlsScAxPYGRCHMWJKRQn2ShKSKYowYoyOJA83VCeqlDx3KxY1lbGUGyWMUjoS5SvF3EKb4IGet9QTfs+9IKRkRGBLClSMCFThiM7nIcWpVGzxMoL7WM4sncJ3W+28snJLZz/Uwtvb5vP6T0NnNjfxOGda9i6bgmzK7Iwh8vxHehJ85gwXqpPoK3WyJQ0Cfo+VhK85RcmxA0jy1fn3iT9Odk9J4rmSTrqK7QsdCrRBfljuCf1tn/QDG8j48wB12pGyKgpiKC2UMPicimmQH/CBSNmwUSKYMUmWL+85gjZOAQHDsGJU3DwoFBOio/q6oZpKl6cY2L15ChWTdCT6Bd+fpRX2mm72I/CrCAMIn3vzbG/D8NQP5Y5VEzMlJOZKGVuk5X3jtTz7l+aeH71PKaUj6RkZApT8uNprUpk5fhopo8IQxkoweiV+NdUDyMqIYrkAB8O1JjYttjAimkqsn0jL/87hryf5Lbfze3/1KZKLU3jNczLlxAXEEx43zsf7LIFy1lVGsSaB1TUFUlpLAulKi8QiYfi1M1tb6fUEMD+OWraZmnZODuKMlMo8R62L+PG9jd9oA0IxdJv1B3z+K6Sg/xoLFTiTJWRaRTjLFPT+mgGE9My0ffTMFjwRN7X8x/zbSIaCuTMtkuYaJOh8NB0/ed7HPJg9s1Vs266ilRF6A+ao9tP0EKnlGxjAJoBod02IfdbB4TFL4iXZmh4skLDUmcIi0uDiBb5oxdu3H+5E0e0D7tm6dlXY2BBYQgmL81XZeUfQ8QvRTxZLqW5RMmEHBVFFhnJsf5oRCFf5SwXQpmtCb62sej6WScFK8rV5GtDUQvmG/plCwnkNwVDsEeEYHAXBtzEXqKrEUL8XQ8EeX8fnigUs7UyggX5/sSI/LH0ybrr5+OE4aQqfNk6WcuCPAmRgyVXb27zQ7MGBvH7KhnN48OZWaBkql1FkjgCS/+v847pZ0Q75H7q7BKay8MZZ5YTPyDyln5l9bdh6qfvNAvpt9xzc/tWkr7i43m6+11TU/xchiCRSyXcfr30TQruKcIk8nfl63xcinuDL5j6/nhHEa6L65NGbX7Y5efnaV31ZQpXXbnEla1WuNI8Rt8SN3ZwWNco/VBXUpi3S/sL3TcWUdzc3Nzc3Nzc/vv+BRyP0TcfyE3IAAAAAElFTkSuQmCC'
    /** Atlas geometry. */
    const ATLAS = { cellWidth: 52, cellHeight: 46, columns: 4, baseline: 44 }
    /** Which atlas slot each species uses for its idle and moving frames. */
    const ATLAS_SLOTS = {
      rabbit: { idle: 0, run: 1 },
      deer: { idle: 2, run: 3 },
      fox: { idle: 4, run: 5 },
      wolf: { idle: 6, run: 7 },
      crow: { idle: 8, run: 9 },
      fish: { idle: 10, run: 11 },
      pike: { idle: 12, run: 13 },
    }
    /**
     * Display size of each species relative to the atlas artwork, in atlas pixels
     * per cell at 6× zoom. Bigger animals read as bigger on screen.
     */
    const ATLAS_SIZE = {
      rabbit: 0.62, deer: 0.82, fox: 0.68, wolf: 0.82, crow: 0.72, fish: 0.46, pike: 0.6,
    }

    /** Runtime atlas state, filled by nsureAtlas. */
    const atlas = { started: false, ready: false, image: null }

    /**
     * Start loading the embedded atlas once. Safe to call repeatedly and in
     * environments without Image (tests): the renderer keeps using the pixel
     * sprites until the image is decoded.
     * @param {Function} [onReady] - called once when the image is available.
     */
    function ensureAtlas(onReady) {
      if (atlas.started) return
      atlas.started = true
      if (typeof Image !== 'function') return
      const image = new Image()
      image.onload = () => {
        atlas.image = image
        atlas.ready = true
        if (typeof onReady === 'function') onReady()
      }
      image.src = 'data:image/png;base64,' + SPRITE_ATLAS_PNG
    }

    /**
     * Which atlas frame one animal shows.
     * @param {object} animal - the animal.
     * @returns {'idle'|'run'} frame role.
     */
    function atlasFrameRole(animal) {
      if (animal.fleeing === true) return 'run'
      const moved = animal.prevX === undefined ? 0 : Math.hypot(animal.x - animal.prevX, animal.y - animal.prevY)
      return moved < 0.06 ? 'idle' : 'run'
    }

    /**
     * Paint the animals from the atlas at display resolution.
     *
     * The ground is a 1 px-per-cell buffer upscaled with nearest neighbour, but
     * the creatures are drawn from the real artwork on top of it — that is what
     * makes a rabbit look like a rabbit instead of a three-pixel blob.
     * @param {CanvasRenderingContext2D} context - display context.
     * @param {object} world - the world.
     * @param {object} view - { x, y, width, height, scale }.
     * @param {number} alpha - interpolation between the last two ticks.
     */
    function drawAtlasAnimals(context, world, view, alpha) {
      if (atlas.ready !== true) return
      const scale = view.scale
      const baseScale = scale / 6
      const visible = []
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 12 || x > view.x + view.width + 12) continue
        if (y < view.y - 14 || y > view.y + view.height + 8) continue
        visible.push({ animal, x, y })
      }
      visible.sort((a, b) => a.y - b.y)
      context.save()
      context.imageSmoothingEnabled = false
      for (const { animal, x, y } of visible) {
        const slots = ATLAS_SLOTS[animal.species]
        if (slots === undefined) continue
        const role = atlasFrameRole(animal)
        const slot = role === 'run' ? slots.run : slots.idle
        const column = slot % ATLAS.columns
        const row = Math.floor(slot / ATLAS.columns)
        const stageScale = STAGE_SCALE[animal.stage ?? 'adult'] ?? 1
        const size = ATLAS_SIZE[animal.species] * baseScale * stageScale
        // Gallop rhythm: a running animal rises and falls and stretches in step.
        const running = role === 'run'
        const gaitPhase = running ? ((world.tick * 0.55 + animal.phase) % 1) * Math.PI * 2 : 0
        const bob = running ? Math.sin(gaitPhase) * 0.09 * ATLAS.cellHeight * size : 0
        const stretch = running ? 1 + Math.sin(gaitPhase + Math.PI / 2) * 0.045 : 1
        const drawWidth = ATLAS.cellWidth * size * stretch
        const drawHeight = ATLAS.cellHeight * size / stretch
        const screenX = (x - view.x) * scale
        const screenY = (y - view.y) * scale + bob
        const left = screenX - drawWidth / 2
        const top = screenY - ATLAS.baseline * size - (drawHeight - ATLAS.cellHeight * size)
        const facingLeft = Math.cos(animal.heading) < 0
        context.save()
        context.translate(left + drawWidth / 2, top)
        if (facingLeft) context.scale(-1, 1)
        const species = SPECIES[animal.species]
        const ratio = species === undefined ? 1 : animal.energy / species.balance.maxEnergy
        if (ratio < 0.22) context.globalAlpha = 0.62
        context.drawImage(atlas.image,
          column * ATLAS.cellWidth, row * ATLAS.cellHeight, ATLAS.cellWidth, ATLAS.cellHeight,
          -drawWidth / 2, 0, drawWidth, drawHeight)
        context.restore()
      }
      context.restore()
    }
    // ---------------------------------------------------------------------
    // Colour helpers
    // ---------------------------------------------------------------------

    /** Eight-step water ripple ramp, indexed by a moving pattern. */
    const WATER_RAMP = [0, 1, 2, 1, 3, 2, 1, 0].map(index => PALETTE.water[index])

    /**
     * Eight-step vegetation ramp: bare olive ground → mid green → lush cover.
     */
    const GRASS_RAMP = Array.from({ length: 8 }, (_, step) => {
      const t = step / 7
      const anchor = [78, 122, 58]
      const from = t < 0.5 ? PALETTE.grassDry : anchor
      const to = t < 0.5 ? anchor : PALETTE.grassLush
      const local = t < 0.5 ? t * 2 : (t - 0.5) * 2
      return rgb(
        Math.round(mix(from[0], to[0], local)),
        Math.round(mix(from[1], to[1], local)),
        Math.round(mix(from[2], to[2], local)),
      )
    })

    /** 16×16 ordered dither table: texture without a visible weave. */
    const DITHER = (() => {
      const table = new Uint8Array(256)
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) table[y * 16 + x] = (x * 73 + y * 151 + x * y * 17) & 255
      }
      return table
    })()

    /** Grass sway offsets (±3 brightness), scrolled across the field by time. */
    const SWAY = [0, 1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1, 0, 1, 2, 1]

    /**
     * Dither value for a cell, 0..255.
     * @param {number} x - column.
     * @param {number} y - row.
     * @returns {number} fixed pseudo-noise.
     */
    function ditherAt(x, y) {
      return DITHER[((y & 15) << 4) | (x & 15)]
    }

    /**
     * Nudge a packed colour by a small amount.
     * @param {number} color - packed colour.
     * @param {number} amount - signed channel delta.
     * @returns {number} nudged colour.
     */
    function nudgeColor(color, amount) {
      const red = clamp((color & 0xFF) + amount, 0, 255)
      const green = clamp(((color >>> 8) & 0xFF) + amount, 0, 255)
      const blue = clamp(((color >>> 16) & 0xFF) + amount, 0, 255)
      return rgb(red, green, blue)
    }

    /**
     * Map a dither value to a ±channel nudge.
     * @param {number} noise - 0..255.
     * @returns {number} signed channel delta.
     */
    function noiseAt(noise) {
      if (noise < 60) return -7
      if (noise > 196) return 7
      return 0
    }

    /**
     * Blend two packed colours.
     * @param {number} from - packed colour.
     * @param {number} to - packed colour.
     * @param {number} t - 0..1.
     * @returns {number} packed colour.
     */
    function blendColor(from, to, t) {
      return rgb(
        Math.round(mix(from & 0xFF, to & 0xFF, t)),
        Math.round(mix((from >>> 8) & 0xFF, (to >>> 8) & 0xFF, t)),
        Math.round(mix((from >>> 16) & 0xFF, (to >>> 16) & 0xFF, t)),
      )
    }

    /**
     * Scale a packed colour's channels.
     * @param {number} color - packed colour.
     * @param {number} factor - 0..1 multiplier.
     * @returns {number} dimmed colour.
     */
    function dimColor(color, factor) {
      return rgb(
        Math.round((color & 0xFF) * factor),
        Math.round(((color >>> 8) & 0xFF) * factor),
        Math.round(((color >>> 16) & 0xFF) * factor),
      )
    }

    // ---------------------------------------------------------------------
    // Viewport renderer
    // ---------------------------------------------------------------------

    /**
     * Pick the sprite frame for one animal.
     *
     * Motion is what sells a creature: a fleeing animal shows a flattened pose,
     * a walking one alternates two frames, and a grazing one stands still.
     * @param {object} entity - the animal.
     * @param {number} tick - world tick (drives the walk cycle).
     * @returns {object} compiled sprite.
     */
    function frameFor(entity, tick) {
      const set = SPRITES[entity.species]
      if (set === undefined) return null
      if (entity.fleeing === true) return set.flee
      const moved = entity.prevX === undefined
        ? 0
        : Math.hypot(entity.x - entity.prevX, entity.y - entity.prevY)
      if (moved < 0.06) return set.idle
      const phase = Math.floor(tick / 2 + entity.phase * 4) % set.walk.length
      return set.walk[phase]
    }

    /**
     * Paint one sprite, clipped to the buffer.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} width - buffer width.
     * @param {number} height - buffer height.
     * @param {object} sprite - compiled sprite.
     * @param {number} left - buffer column of the sprite's left edge.
     * @param {number} top - buffer row of the sprite's top edge.
     * @param {boolean} flip - mirror horizontally.
     * @param {number} [factor] - brightness multiplier.
     */
    function drawSprite(out, width, height, sprite, left, top, flip, factor) {
      const spriteWidth = sprite.width
      for (let y = 0; y < sprite.height; y++) {
        const targetY = top + y
        if (targetY < 0 || targetY >= height) continue
        const rowBase = y * spriteWidth
        const targetBase = targetY * width
        for (let x = 0; x < spriteWidth; x++) {
          const color = sprite.pixels[rowBase + (flip ? spriteWidth - 1 - x : x)]
          if (color === 0) continue
          const targetX = left + x
          if (targetX < 0 || targetX >= width) continue
          out[targetBase + targetX] = factor === undefined ? color : dimColor(color, factor)
        }
      }
    }

    /**
     * Ground pass: terrain, vegetation cover, water ripples and weed.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintGround(world, view, out) {
      const terrain = world.terrain
      const grass = world.grass
      const weed = world.weed
      const phase = (world.tick >> 1) & 7
      for (let row = 0; row < view.height; row++) {
        const worldY = view.y + row
        const rowBase = worldY * world.width
        const outBase = row * view.width
        for (let col = 0; col < view.width; col++) {
          const worldX = view.x + col
          const index = rowBase + worldX
          const surface = terrain[index]
          let color
          if (surface === TERRAIN.WATER) {
            color = WATER_RAMP[(worldX * 3 + worldY * 5 + phase) & 7]
            const cover = weed[index]
            if (cover > 0.15) color = blendColor(color, PALETTE.weed[cover > 0.6 ? 1 : 0], Math.min(0.7, cover * 0.8))
          } else if (surface === TERRAIN.SAND) {
            color = nudgeColor(PALETTE.sand[0], noiseAt(ditherAt(worldX, worldY)))
          } else if (surface === TERRAIN.DIRT) {
            color = nudgeColor(PALETTE.dirt[0], noiseAt(ditherAt(worldX, worldY)))
          } else if (surface === TERRAIN.STONE) {
            color = nudgeColor(PALETTE.stone[1], noiseAt(ditherAt(worldX, worldY)))
          } else {
            const cover = grass[index]
            const step = cover <= 0 ? 0 : Math.min(7, (cover * 8) | 0)
            const sway = SWAY[(worldX + (world.tick >> 2)) & 15]
            color = nudgeColor(GRASS_RAMP[step], sway + (ditherAt(worldX, worldY) < 48 ? 4 : 0))
          }
          out[outBase + col] = color
        }
      }
    }

    /**
     * Plants pass, sorted far→near so canopies overlap correctly.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintPlants(world, view, out) {
      const visible = []
      for (const plant of world.trees) {
        if (plant.x < view.x - 12 || plant.x > view.x + view.width + 12) continue
        if (plant.y < view.y - 16 || plant.y > view.y + view.height + 6) continue
        visible.push(plant)
      }
      visible.sort((a, b) => a.y - b.y)
      for (const plant of visible) {
        const sprite = plant.variant === 'bush' ? PLANT_SPRITES.bush : PLANT_SPRITES.tree[clamp(plant.size, 1, 3) - 1]
        const swayX = ((world.tick >> 3) + plant.id) % 16 < 8 ? 0 : 1
        const factor = (plant.foliage ?? 1) < 0.35 ? 0.82 : undefined
        drawSprite(out, view.width, view.height, sprite,
          Math.round(plant.x - view.x - sprite.width / 2) + swayX,
          Math.round(plant.y - view.y - sprite.height + 1), false, factor)
      }
    }

    /**
     * Carcasses pass.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintCorpses(world, view, out) {
      for (const corpse of world.corpses) {
        if (corpse.x < view.x - 4 || corpse.x > view.x + view.width + 4) continue
        if (corpse.y < view.y - 4 || corpse.y > view.y + view.height + 4) continue
        const sprite = CORPSE_SPRITES[corpse.decay > 0.6 ? 1 : 0]
        drawSprite(out, view.width, view.height, sprite,
          Math.round(corpse.x - view.x - sprite.width / 2), Math.round(corpse.y - view.y - 1),
          false, Math.max(0.45, 1 - corpse.decay * 0.5))
      }
    }

    /**
     * Animals pass, with motion interpolation and the two-frame walk cycle.
     *
     * Positions are interpolated between the last two simulation ticks (10 Hz)
     * up to the display refresh rate, which is what turns 10 stepping blobs into
     * sixty smooth ones.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} alpha - 0..1 between the last two ticks.
     */
    function paintAnimals(world, view, out, alpha) {
      const visible = []
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 8 || x > view.x + view.width + 8) continue
        if (y < view.y - 10 || y > view.y + view.height + 6) continue
        visible.push({ animal, x, y })
      }
      visible.sort((a, b) => a.y - b.y)
      for (const { animal, x, y } of visible) {
        const sprite = frameFor(animal, world.tick)
        if (sprite === null) continue
        const species = SPECIES[animal.species]
        const ratio = species === undefined ? 1 : animal.energy / species.balance.maxEnergy
        const factor = ratio < 0.22 ? 0.72 : undefined
        const facingLeft = Math.cos(animal.heading) < 0
        drawSprite(out, view.width, view.height, sprite,
          Math.round(x - view.x - sprite.width / 2),
          Math.round(y - view.y - sprite.height + 1),
          facingLeft, factor)
      }
    }

    /**
     * Trails and behaviour effects: the layer that says "something happened".
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintActivity(world, view, out) {
      for (const animal of world.entities) {
        const trail = TRAIL_COLORS[animal.species]
        if (trail === undefined || animal.prevX === undefined) continue
        if (Math.hypot(animal.x - animal.prevX, animal.y - animal.prevY) < 0.3) continue
        const x = Math.round(animal.prevX) - view.x
        const y = Math.round(animal.prevY) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = trail
      }
      for (const effect of world.effects) {
        const alpha = clamp(effect.life / effect.maxLife, 0, 1)
        const x = (effect.x | 0) - view.x
        const y = (effect.y | 0) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = dimColor(effect.color, 0.35 + alpha * 0.65)
      }
    }

    /**
     * Brush cursor and selection ring, drawn in buffer coordinates.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object|null} overlay - `{ hover, radius, selected, highlight }`.
     */
    function paintOverlay(view, out, overlay) {
      if (overlay === null || overlay === undefined) return
      const put = (x, y, color) => {
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) return
        out[y * view.width + x] = color
      }
      const hover = overlay.hover
      if (hover !== null && hover !== undefined) {
        const radius = overlay.radius ?? 0
        const left = Math.round(hover.x) - radius - view.x
        const top = Math.round(hover.y) - radius - view.y
        const size = radius * 2 + 1
        const color = PALETTE.effect.cursor
        for (let i = 0; i < size; i++) {
          put(left + i, top, color)
          put(left + i, top + size - 1, color)
          put(left, top + i, color)
          put(left + size - 1, top + i, color)
        }
      }
      const selected = overlay.selected
      if (selected !== null && selected !== undefined) {
        const cx = Math.round(selected.x) - view.x
        const cy = Math.round(selected.y) - view.y
        const ring = PALETTE.effect.select
        for (let angle = 0; angle < 16; angle++) {
          const radians = (angle / 16) * Math.PI * 2
          const x = cx + Math.round(Math.cos(radians) * 4)
          const y = cy + Math.round(Math.sin(radians) * 4)
          if (angle % 4 === 0) put(x, y, ring)
        }
      }
    }

    /**
     * Render one viewport of the world.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} [buffer] - reusable buffer of `width*height`.
     * @param {number} [alpha] - interpolation between the last two ticks.
     * @param {object|null} [overlay] - cursor and selection.
     * @returns {Uint32Array} the buffer that was written.
     */
    function paintView(world, view, buffer, alpha = 1, overlay = null, options = null) {
      const size = view.width * view.height
      const out = buffer !== undefined && buffer.length === size ? buffer : new Uint32Array(size)
      const spritesInBuffer = options === null || options.sprites !== false
      paintGround(world, view, out)
      paintPlants(world, view, out)
      paintCorpses(world, view, out)
      if (spritesInBuffer) paintAnimals(world, view, out, alpha)
      paintActivity(world, view, out)
      paintOverlay(view, out, overlay)
      return out
    }

    /**
     * Low-resolution picture of the whole world, for the minimap.
     * @param {object} world - the world.
     * @param {number} width - minimap width in pixels.
     * @param {number} height - minimap height in pixels.
     * @returns {Uint32Array} `width*height` pixels.
     */
    function paintMinimap(world, width, height) {
      const out = new Uint32Array(width * height)
      const stepX = world.width / width
      const stepY = world.height / height
      for (let y = 0; y < height; y++) {
        const worldY = Math.min(world.height - 1, (y * stepY) | 0)
        for (let x = 0; x < width; x++) {
          const worldX = Math.min(world.width - 1, (x * stepX) | 0)
          const index = worldY * world.width + worldX
          const surface = world.terrain[index]
          let color
          if (surface === TERRAIN.WATER) color = PALETTE.water[2]
          else if (surface === TERRAIN.STONE) color = PALETTE.stone[1]
          else if (surface === TERRAIN.SAND) color = PALETTE.sand[1]
          else if (surface === TERRAIN.DIRT) color = PALETTE.dirt[1]
          else color = GRASS_RAMP[Math.min(7, (world.grass[index] * 8) | 0)]
          out[y * width + x] = color
        }
      }
      for (const animal of world.entities) {
        const x = Math.min(width - 1, (animal.x / stepX) | 0)
        const y = Math.min(height - 1, (animal.y / stepY) | 0)
        const species = SPECIES[animal.species]
        if (species === undefined) continue
        out[y * width + x] = rgb(
          parseInt(species.color.slice(1, 3), 16),
          parseInt(species.color.slice(3, 5), 16),
          parseInt(species.color.slice(5, 7), 16),
        )
      }
      return out
    }


    /**
     * Full-world render, kept for tests and for one-shot captures.
     * @param {object} world - the world.
     * @param {Uint32Array} [pixels] - reusable buffer.
     * @returns {Uint32Array} the buffer.
     */
    function paintWorld(world, pixels) {
      return paintView(world, { x: 0, y: 0, width: world.width, height: world.height }, pixels, 1, null)
    }

    // ---------------------------------------------------------------------
    // Store: owns the world, the viewport and the simulation loop
    // ---------------------------------------------------------------------

    /** Playback speeds, in simulation-time multipliers. */
    const SPEEDS = [1, 2, 4, 8]

    /**
     * The browser's localStorage, or null where it is unavailable.
     * @returns {Storage|null} storage.
     */
    function safeLocalStorage() {
      try {
        if (typeof window === 'undefined') return null
        return window.localStorage ?? null
      } catch {
        return null
      }
    }

    /**
     * Create the world store for one plugin instance.
     *
     * The store owns the world and the rAF loop; the panel owns the camera and
     * tells the store which window to paint. Only the visible cells are rendered,
     * so a large map costs the same as a small one.
     * @param {object} [options] - `{ storage?, now?, requestFrame?, cancelFrame? }`.
     * @returns {object} the store.
     */
    function createStore(options = {}) {
      const storage = options.storage !== undefined ? options.storage : safeLocalStorage()
      const clock = typeof options.now === 'function'
        ? options.now
        : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now())
      const requestFrame = typeof options.requestFrame === 'function'
        ? options.requestFrame
        : callback => (typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(callback)
          : setTimeout(() => callback(clock()), 16))
      const cancelFrame = typeof options.cancelFrame === 'function'
        ? options.cancelFrame
        : handle => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle))

      let world = null
      let canvas = null
      let context = null
      let imageData = null
      let frameBuffer = null
      let frameHandle = 0
      let lastStamp = 0
      let accumulator = 0
      let alpha = 1
      let clockAccumulator = 0
      let saveAccumulator = 0
      let minimapAccumulator = 0
      let minimap = null
      let offscreen = null
      let offscreenContext = null
      let paused = false
      let speed = 2
      let selectedId = 0
      let follow = false
      let hover = null
      let disposed = false
      let snapshot = null
      let pendingSnapshot = false
      let view = { x: 0, y: 0, width: 0, height: 0 }
      const brush = { tool: 'grass', radius: 1 }
      const listeners = new Set()

      /** Load the saved world, or create a fresh one. */
      function ensureWorld() {
        if (world !== null) return world
        world = load() ?? createWorld()
        world.hydrologyDirty = false
        minimap = null
        return world
      }

      /** Read and parse the saved world, ignoring anything unusable. */
      function load() {
        if (storage === null) return null
        try {
          const raw = storage.getItem(STORAGE_KEY)
          if (raw === null || raw === undefined) return null
          return deserializeWorld(JSON.parse(raw))
        } catch {
          return null
        }
      }

      /** Persist the world; a full or missing storage is not fatal. */
      function save() {
        if (storage === null || world === null) return
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(serializeWorld(world)))
        } catch {
          // Quota or disabled storage: keep running unsaved.
        }
      }

      /** Ask for a React snapshot on the next tick, at most a few times a second. */
      function markDirty() {
        pendingSnapshot = true
      }

      /** Drop the snapshot and notify React. */
      function publish() {
        snapshot = null
        for (const listener of listeners) listener()
      }

      /** The inspected animal, if it is still alive. */
      function selectedEntity() {
        if (world === null || selectedId === 0) return undefined
        return findEntityById(world, selectedId)
      }

      /** Flatten one entity for the inspector. */
      function summariseEntity(entity) {
        const species = SPECIES[entity.species]
        return {
          id: entity.id,
          species: entity.species,
          age: entity.age,
          energy: entity.energy,
          maxEnergy: species === undefined ? 100 : species.balance.maxEnergy,
          generation: entity.generation,
          children: entity.children ?? 0,
          genes: { ...entity.genes },
          x: entity.x,
          y: entity.y,
          fleeing: entity.fleeing === true,
          stage: entity.stage ?? 'adult',
          intent: entity.intent ?? 'explore',
          needs: { ...needsOf(entity) },
          speed: entity.genes.speed * (STAGE_SPEED[entity.stage ?? 'adult'] ?? 1),
        }
      }

      /** Snapshot for React: counters, history, selection and camera hints. */
      /** An all-zero stats row, used before the world exists. */
      function emptyStats() {
        return {
          counts: Object.fromEntries(SPECIES_IDS.map(id => [id, 0])),
          day: 1,
          clock: '06:00',
          daylight: 1,
        }
      }

      function buildSnapshot() {
        if (world === null) {
          // Never a partial object: components read these fields on their very
          // first render, before the mount effect has created the world.
          return {
            ready: false,
            paused,
            speed,
            stats: emptyStats(),
            world: { width: GRID_W, height: GRID_H },
            history: [],
            brush: { tool: brush.tool, radius: brush.radius },
            selected: null,
            following: false,
            view: { x: 0, y: 0, width: 0, height: 0 },
          }
        }
        const stats = sampleStats(world)
        const selected = selectedEntity()
        return {
          ready: true,
          paused,
          speed,
          stats,
          world: { width: world.width, height: world.height },
          history: world.history.slice(-120),
          brush: { tool: brush.tool, radius: brush.radius },
          selected: selected === undefined ? null : summariseEntity(selected),
          following: follow && selected !== undefined,
          view: { x: view.x, y: view.y, width: view.width, height: view.height },
        }
      }

      /** One animation frame. */
      function frame() {
        frameHandle = 0
        if (disposed || canvas === null) return
        frameHandle = requestFrame(frame)
        const stamp = clock()
        let elapsed = (stamp - lastStamp) / 1000
        lastStamp = stamp
        if (!(elapsed > 0)) elapsed = 0
        if (elapsed > 0.5) elapsed = 0.5
        if (!paused && world !== null) advance(elapsed * speed)
        draw()
      }

      /**
       * Step the simulation in fixed slices and keep the interpolation fraction.
       * @param {number} delta - simulation seconds to consume.
       */
      function advance(delta) {
        accumulator += delta
        let guard = 0
        while (accumulator >= TICK && guard < 60) {
          stepWorld(world, TICK)
          accumulator -= TICK
          guard += 1
        }
        if (accumulator > TICK) accumulator = 0
        alpha = clamp(accumulator / TICK, 0, 1)
        clockAccumulator += delta
        if (clockAccumulator >= 1) {
          clockAccumulator -= 1
          pushHistory(world)
          publish()
        } else if (pendingSnapshot && clockAccumulator > 0.2) {
          pendingSnapshot = false
          publish()
        }
        minimapAccumulator += delta
        if (minimapAccumulator >= 2) {
          minimapAccumulator = 0
          minimap = null
        }
        saveAccumulator += delta
        if (saveAccumulator >= 30) {
          saveAccumulator = 0
          save()
        }
      }

      /** Repaint the attached canvas. */
      function draw() {
        if (context === null || world === null || frameBuffer === null) return
        if (view.width <= 0 || view.height <= 0) return
        const selected = selectedEntity()
        const scale = view.scale ?? 1
        const useAtlas = atlas.ready === true && scale >= 3 && offscreenContext !== null
        paintView(world, view, frameBuffer, alpha, {
          hover,
          radius: brush.radius,
          selected: selected === undefined ? null : selected,
        }, { sprites: !useAtlas })
        const canvasWidth = view.width * (offscreenContext === null ? 1 : scale)
        const canvasHeight = view.height * (offscreenContext === null ? 1 : scale)
        if (offscreenContext !== null) {
          // Ground: 1 px per cell, upscaled with nearest neighbour.
          offscreenContext.putImageData(imageData, 0, 0)
          context.imageSmoothingEnabled = false
          context.drawImage(offscreen, 0, 0, view.width, view.height, 0, 0, canvasWidth, canvasHeight)
          if (useAtlas) drawAtlasAnimals(context, world, view, alpha)
        } else {
          context.putImageData(imageData, 0, 0)
        }
        // Day/night wash and dawn/dusk warmth, over the whole frame.
        const light = daylight(world)
        if (light < 0.98) {
          const darkness = Math.min(0.5, (1 - light) * 0.55)
          context.fillStyle = `rgba(12, 18, 44, ${darkness.toFixed(3)})`
          context.fillRect(0, 0, canvasWidth, canvasHeight)
        }
        const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
        const warmth = phase > 0.17 && phase < 0.3
          ? 0.16 * (1 - Math.abs(phase - 0.235) / 0.065)
          : phase > 0.71 && phase < 0.85
            ? 0.18 * (1 - Math.abs(phase - 0.78) / 0.07)
            : 0
        if (warmth > 0.01) {
          context.fillStyle = `rgba(240, 150, 70, ${warmth.toFixed(3)})`
          context.fillRect(0, 0, canvasWidth, canvasHeight)
        }
      }

      /** Start the animation loop. */
      function startLoop() {
        if (frameHandle !== 0 || disposed) return
        lastStamp = clock()
        accumulator = 0
        frameHandle = requestFrame(frame)
      }

      /** Stop the animation loop. */
      function stopLoop() {
        if (frameHandle === 0) return
        cancelFrame(frameHandle)
        frameHandle = 0
      }

      /**
       * Point the renderer at a window of the world. The canvas must already be
       * sized to `width × height` cells.
       * @param {object} next - `{ x, y, width, height }` in cells.
       */
      function setView(next) {
        if (world === null) ensureWorld()
        const width = Math.max(1, Math.min(world.width, next.width | 0))
        const height = Math.max(1, Math.min(world.height, next.height | 0))
        const x = clamp(next.x | 0, 0, Math.max(0, world.width - width))
        const y = clamp(next.y | 0, 0, Math.max(0, world.height - height))
        const resized = width !== view.width || height !== view.height || imageData === null
        // Keep the zoom: the renderer needs it to size the display blit and to
        // decide whether the atlas sprites are worth drawing.
        const scale = typeof next.scale === 'number' && next.scale > 0 ? next.scale : (view.scale ?? 1)
        view = { x, y, width, height, scale }
        if (resized && context !== null) {
          imageData = context.createImageData(width, height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        if (resized && offscreen !== null) {
          offscreen.width = width
          offscreen.height = height
        }
      }

      /**
       * Bind a canvas and start rendering.
       * @param {HTMLCanvasElement} element - canvas sized to the current view.
       */
      function attach(element) {
        if (disposed || element === null || element === undefined) return
        if (canvas !== null) detach()
        ensureWorld()
        canvas = element
        context = typeof element.getContext === 'function' ? element.getContext('2d', { alpha: false }) : null
        if (context === null) {
          canvas = null
          return
        }
        if (view.width <= 0 || view.height <= 0) {
          view = { x: 0, y: 0, width: Math.min(world.width, 160), height: Math.min(world.height, 100), scale: view.scale ?? 1 }
        }
        imageData = context.createImageData(view.width, view.height)
        frameBuffer = new Uint32Array(imageData.data.buffer)
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && offscreen === null) {
          offscreen = document.createElement('canvas')
          offscreen.width = view.width
          offscreen.height = view.height
          offscreenContext = offscreen.getContext('2d', { alpha: false })
        }
        ensureAtlas(publish)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('beforeunload', save)
        }
        startLoop()
        publish()
      }

      /** Unbind the canvas and save. */
      function detach() {
        stopLoop()
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', save)
        }
        canvas = null
        context = null
        imageData = null
        frameBuffer = null
      }

      /** Replace the world with a fresh one. */
      function newWorld(seed) {
        world = createWorld(seed === undefined ? {} : { seed })
        world.hydrologyDirty = false
        selectedId = 0
        follow = false
        accumulator = 0
        minimap = null
        if (context !== null) {
          const width = Math.min(world.width, Math.max(1, view.width))
          const height = Math.min(world.height, Math.max(1, view.height))
          view = { x: 0, y: 0, width, height, scale: view.scale ?? 1 }
          imageData = context.createImageData(width, height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        save()
        publish()
      }

      return {
        ensureWorld,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          if (snapshot === null) snapshot = buildSnapshot()
          return snapshot
        },
        attach,
        detach,
        setView,
        getView() {
          return view
        },
        getWorld() {
          return world
        },
        isAttached() {
          return canvas !== null
        },
        /** @returns {{width: number, height: number, data: Uint32Array}} minimap. */
        getMinimap(width = 160, height = 100) {
          if (world === null) ensureWorld()
          if (minimap === null || minimap.width !== width || minimap.height !== height) {
            minimap = { width, height, data: paintMinimap(world, width, height) }
          }
          return minimap
        },
        setPaused(value) {
          paused = value === true
          publish()
        },
        togglePause() {
          paused = !paused
          publish()
        },
        setSpeed(value) {
          speed = SPEEDS.includes(value) ? value : 1
          paused = false
          publish()
        },
        /** Advance exactly one tick while paused. */
        stepOnce() {
          if (world === null) ensureWorld()
          stepWorld(world, TICK)
          pushHistory(world)
          publish()
        },
        setBrush(tool, radius) {
          if (typeof tool === 'string') brush.tool = tool
          if (typeof radius === 'number') brush.radius = clamp(radius | 0, 0, 2)
          publish()
        },
        setHover(point) {
          hover = point === null || point === undefined ? null : { x: point.x, y: point.y }
        },
        paintAt(x, y, erase = false) {
          if (world === null) ensureWorld()
          const result = place(world, erase ? 'erase' : brush.tool, x, y, brush.radius)
          // The canvas repaints on the next animation frame anyway; a full
          // snapshot here would rescan 200k cells per cell of a brush drag.
          markDirty()
          return typeof result === 'number' ? result : 0
        },
        selectAt(x, y) {
          if (world === null) return undefined
          const entity = findEntityAt(world, x, y, 3)
          selectedId = entity === undefined ? 0 : entity.id
          if (selectedId === 0) follow = false
          publish()
          return entity
        },
        select(id) {
          selectedId = typeof id === 'number' ? id : 0
          if (selectedId === 0) follow = false
          publish()
        },
        clearSelection() {
          selectedId = 0
          follow = false
          publish()
        },
        setFollow(value) {
          follow = value === true && selectedEntity() !== undefined
          publish()
        },
        selectedPosition() {
          const entity = selectedEntity()
          return entity === undefined ? null : { x: entity.x, y: entity.y }
        },
        isFollowing() {
          return follow
        },
        newWorld,
        save,
        peekSave() {
          return load()
        },
        dispose() {
          detach()
          listeners.clear()
          disposed = true
        },
      }
    }

    // Locale
    // ---------------------------------------------------------------------

    /** Chinese dictionary. Keys must match `ENGLISH` exactly (tested). */
    const CHINESE = {
      'panel.title': '像素生态缸',
      'action.back': '回到对话',
      'action.play': '继续',
      'action.pause': '暂停',
      'action.newWorld': '新世界',
      'action.newWorldConfirm': '再点一次确认重开',
      'action.help': '玩法',
      'action.fit': '适应窗口',
      'action.close': '关闭',
      'stat.day': '第 {day} 天',
      'stat.corpses': '遗骸',
      'speed.paused': '暂停',
      'speed.1': '1×',
      'speed.2': '2×',
      'speed.4': '4×',
      'speed.8': '8×',
      'species.rabbit': '兔子',
      'species.deer': '鹿',
      'species.fox': '狐狸',
      'species.wolf': '狼',
      'species.crow': '乌鸦',
      'species.fish': '小鱼',
      'species.pike': '狗鱼',
      'tool.grass': '草',
      'tool.weed': '水草',
      'tool.tree': '树',
      'tool.bush': '灌木',
      'tool.water': '水',
      'tool.sand': '沙',
      'tool.dirt': '土',
      'tool.stone': '石头',
      'tool.pointer': '指针',
      'tool.erase': '清除',
      'tool.group.life': '生命',
      'tool.group.terrain': '地形',
      'brush.label': '笔刷',
      'brush.small': '小',
      'brush.medium': '中',
      'brush.large': '大',
      'chart.title': '种群变化',
      'inspect.empty': '点一只生物，看看它的基因',
      'inspect.age': '年龄',
      'inspect.energy': '能量',
      'inspect.generation': '第 {n} 代',
      'inspect.children': '后代 {n}',
      'inspect.gene.speed': '速度',
      'inspect.gene.vision': '视野',
      'inspect.gene.size': '体型',
      'inspect.gene.metabolism': '代谢',
      'inspect.gene.lifespan': '寿命',
      'inspect.gene.fertility': '繁殖',
      'inspect.follow': '跟随',
      'inspect.unfollow': '取消跟随',
      'help.title': '怎么玩',
      'help.1': '左键放置选中的东西，右键擦除。',
      'help.2': '草和水草会自己长回来，但兔子、鹿和鱼会把它们吃掉。',
      'help.3': '兔子吃草，狐狸吃兔子；鹿还会啃树上的叶子，狼更爱追鹿。',
      'help.4': '乌鸦飞过水面上空，只吃遗骸；狗鱼在水里追小鱼。',
      'help.5': '小崽会继承父母的基因，偶尔有点小变异，吃饱了才生。',
      'help.6': '滚轮缩放，平移工具拖动画布；点生物看基因，跟随可以盯住它。',
      'help.7': '世界会自动保存，关掉再回来还在。',
    }

    /** English dictionary. Keys must match `CHINESE` exactly (tested). */
    const ENGLISH = {
      'panel.title': 'Pixel terrarium',
      'action.back': 'Back to chat',
      'action.play': 'Resume',
      'action.pause': 'Pause',
      'action.newWorld': 'New world',
      'action.newWorldConfirm': 'Click again to confirm',
      'action.help': 'How to play',
      'action.fit': 'Fit view',
      'action.close': 'Close',
      'stat.day': 'Day {day}',
      'stat.corpses': 'Remains',
      'speed.paused': 'Paused',
      'speed.1': '1×',
      'speed.2': '2×',
      'speed.4': '4×',
      'speed.8': '8×',
      'species.rabbit': 'Rabbit',
      'species.deer': 'Deer',
      'species.fox': 'Fox',
      'species.wolf': 'Wolf',
      'species.crow': 'Crow',
      'species.fish': 'Fish',
      'species.pike': 'Pike',
      'tool.grass': 'Grass',
      'tool.weed': 'Weed',
      'tool.tree': 'Tree',
      'tool.bush': 'Shrub',
      'tool.water': 'Water',
      'tool.sand': 'Sand',
      'tool.dirt': 'Soil',
      'tool.stone': 'Stone',
      'tool.pointer': 'Pointer',
      'tool.erase': 'Erase',
      'tool.group.life': 'Life',
      'tool.group.terrain': 'Terrain',
      'brush.label': 'Brush',
      'brush.small': 'S',
      'brush.medium': 'M',
      'brush.large': 'L',
      'chart.title': 'Populations',
      'inspect.empty': 'Click a creature to read its genes',
      'inspect.age': 'Age',
      'inspect.energy': 'Energy',
      'inspect.generation': 'Gen {n}',
      'inspect.children': 'Offspring {n}',
      'inspect.gene.speed': 'Speed',
      'inspect.gene.vision': 'Vision',
      'inspect.gene.size': 'Size',
      'inspect.gene.metabolism': 'Metabolism',
      'inspect.gene.lifespan': 'Lifespan',
      'inspect.gene.fertility': 'Breeding',
      'inspect.follow': 'Follow',
      'inspect.unfollow': 'Unfollow',
      'help.title': 'How to play',
      'help.1': 'Left-click places the selected thing, right-click erases.',
      'help.2': 'Grass and weed regrow on their own — rabbits, deer and fish eat them.',
      'help.3': 'Rabbits eat grass, foxes eat rabbits; deer also browse leaves, wolves prefer deer.',
      'help.4': 'Crows fly over the water and eat only carcasses; pike hunt fish.',
      'help.5': 'Offspring inherit their parents\' genes with a small mutation, and only breed when well fed.',
      'help.6': 'Wheel zooms, the pan tool drags; click a creature to read its genes, follow keeps it in view.',
      'help.7': 'The world autosaves and is still here next time.',
    }

    /** Locale ids every build is known to serve, before the live catalog is read. */
    const BUILT_IN_LOCALE_IDS = ['en', 'zh', 'zh-CN', 'zh-Hans']

    /**
     * Pick the dictionary one locale id should receive, by primary subtag.
     * @param {string} id - locale id.
     * @returns {object|undefined} dictionary.
     */
    function dictionaryFor(id) {
      const primary = String(id).toLowerCase().split('-')[0]
      if (primary === 'zh') return CHINESE
      if (primary === 'en') return ENGLISH
      return undefined
    }

    /**
     * Register one dictionary per built-in id plus every id the live catalog
     * exposes, so `zh-CN` or a language pack resolves Chinese rather than
     * falling through to English.
     * @param {object} locale - the harness locale service.
     * @returns {() => void} disposer removing every registration made.
     */
    function registerDictionaries(locale) {
      const ids = new Set(BUILT_IN_LOCALE_IDS)
      const snapshot = locale.getSnapshot()
      const locales = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.locales)
        ? snapshot.locales
        : []
      for (const definition of locales) {
        if (definition !== null && typeof definition === 'object' && typeof definition.id === 'string') ids.add(definition.id)
      }
      const disposers = []
      for (const id of ids) {
        const dictionary = dictionaryFor(id)
        if (dictionary !== undefined) disposers.push(locale.register(NS, id, dictionary))
      }
      return () => { for (const dispose of disposers) dispose() }
    }

    /**
     * Re-render on language change and return the translator for this namespace.
     * @param {object} locale - the harness locale service.
     * @returns {(key: string, params?: object) => string} translator.
     */
    function useTranslate(locale) {
      const subscribe = React.useCallback(callback => locale.subscribe(callback), [locale])
      const read = React.useCallback(() => locale.getSnapshot(), [locale])
      React.useSyncExternalStore(subscribe, read, read)
      return React.useCallback((key, params) => {
        const translate = locale.bind(NS)
        const text = translate(key)
        if (params === undefined || typeof text !== 'string') return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }, [locale])
    }

    // ---------------------------------------------------------------------
    // Pixel glyphs (inline SVG, 1 unit = 1 pixel)
    // ---------------------------------------------------------------------

    /** Glyph bitmaps: `.` transparent, `#` primary colour, `+` accent colour. */
    const GLYPHS = {
      grass: ['..#...#..', '..#.#.#..', '.#..#..#.', '.#.##.#..', '#..#..#.#', '...###...'],
      weed: ['..#..#...', '.#..#..#.', '.#.#..#..', '#..#.#...', '.#..#..#.', '..#..##..'],
      tree: ['...###...', '..#####..', '.#######.', '#########', '.#######.', '...###...', '....#....', '....#....'],
      bush: ['..###..', '.#####.', '#######', '.#####.', '...#...'],
      creature: ['.#...#.', '.#####.', '#######', '..#.#..'],
      water: ['#+#+#+#', '+#+#+#+', '#+#+#+#', '+#+#+#+'],
      solid: ['#######', '#+++++#', '#+++++#', '#+++++#', '#+++++#', '#+++++#', '#######'],
      erase: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
      pan: ['...#...', '..###..', '.#.#.#.', '#######', '.#.#.#.', '..###..', '...#...'],
      pointer: ['#.......', '##......', '###.....', '####....', '#####...', '##..#...', '#....#..', '.....#..'],
      pause: ['##.##', '##.##', '##.##', '##.##', '##.##'],
      play: ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],
      step: ['##..#', '##..#', '##..#', '##..#', '##..#'],
      target: ['..###..', '.#...#.', '#..#..#', '#.....#', '#..#..#', '.#...#.', '..###..'],
      close: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    }

    /**
     * Render one glyph as an SVG of 1-unit rects.
     * @param {object} props - `{ name, color, accent, size }`.
     * @returns {object} React element.
     */
    function PixelGlyph(props) {
      const rows = GLYPHS[props.name] ?? GLYPHS.creature
      const color = props.color ?? 'currentColor'
      const accent = props.accent ?? color
      const rects = []
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          const cell = rows[y][x]
          if (cell === '.') continue
          rects.push(h('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1, fill: cell === '+' ? accent : color }))
        }
      }
      return h('svg', {
        width: props.size ?? 16,
        height: props.size ?? 16,
        viewBox: `0 0 ${rows[0].length} ${rows.length}`,
        shapeRendering: 'crispEdges',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', pointerEvents: 'none' },
      }, rects)
    }

    /** The sidebar icon: meadow, tree, water. */
    const PANEL_GLYPH = [
      '..GGG....',
      '.GGGGG...',
      'GGGGGGGG.',
      'GGGGGGGGG',
      '..GGGGGG.',
      '...TTT...',
      '...TTT...',
      'BBBBBBBBB',
      'BbBBBbBBB',
    ]

    /**
     * Sidebar entry icon.
     * @param {object} props - `{ size, active }` from the shell.
     * @returns {object} React element.
     */
    function PanelIcon(props) {
      const size = Math.max(12, Math.min(32, props?.size ?? 18))
      const active = props?.active === true
      const colors = { G: '#4a9d54', T: '#7d5537', B: '#2f6ea8', b: '#63a9d8' }
      const rects = []
      for (let y = 0; y < PANEL_GLYPH.length; y++) {
        for (let x = 0; x < PANEL_GLYPH[y].length; x++) {
          const cell = PANEL_GLYPH[y][x]
          if (cell === '.') continue
          rects.push(h('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1, fill: colors[cell] ?? colors.G }))
        }
      }
      if (active) {
        rects.push(h('rect', {
          key: 'outline', x: 0.25, y: 0.25, width: 8.5, height: 8.5,
          fill: 'none', stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 0.5,
        }))
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 9 9',
        shapeRendering: 'crispEdges', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      }, rects)
    }

    // ---------------------------------------------------------------------
    // Panel UI
    // ---------------------------------------------------------------------

    /**
     * Error boundary around the panel.
     *
     * A render error used to take the whole panel down to a blank area with no
     * explanation. Now the failure itself is on screen, with its stack, so the
     * next bug reports itself instead of looking like "nothing rendered".
     */
    class PanelBoundary extends (React.Component ?? Object) {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[pixel-ecosystem] panel crashed', error, info)
        }
      }

      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          const stack = this.state.error.stack === undefined ? String(this.state.error) : this.state.error.stack
          return h('div', { className: 'pe-fatal' },
            h('div', { className: 'pe-fatal-title' }, this.props.title ?? '面板渲染出错 / Panel failed to render'),
            h('pre', { className: 'pe-fatal-body' }, String(stack)))
        }
        return this.props.children ?? null
      }
    }

    /** Only wrap in the real React; the test shim has no class components. */
    const PANEL_BOUNDARY = typeof React.Component === 'function' ? PanelBoundary : props => props.children ?? null
    /** Tool groups for the side palette. */
    const LIFE_TOOLS = ['grass', 'weed', 'tree', 'bush', 'rabbit', 'deer', 'fox', 'wolf', 'crow', 'fish', 'pike']
    const TERRAIN_TOOL_IDS = ['water', 'sand', 'dirt', 'stone', 'erase', 'pointer']
    const BRUSHES = [0, 1, 2]
    const BRUSH_RADIUS = [0, 1, 2]
    const MIN_SCALE = 1
    const MAX_SCALE = 16

    /**
     * The one and only camera → viewport conversion.
     *
     * The render path and the input path both call this. Two separate copies of
     * this maths is exactly how zoom-to-cursor and hit-testing drift apart, which
     * is what made the canvas feel broken.
     * @param {{cx: number, cy: number, scale: number}} camera - camera state.
     * @param {{width: number, height: number}} stage - stage size in CSS px.
     * @param {{width: number, height: number}} world - world size in cells.
     * @returns {{x: number, y: number, width: number, height: number, scale: number, offsetX: number, offsetY: number}} viewport.
     */
    function viewFromCamera(camera, stage, world) {
      const scale = clamp(camera.scale, MIN_SCALE, MAX_SCALE)
      const width = Math.max(24, Math.min(world.width, Math.floor(stage.width / scale)))
      const height = Math.max(18, Math.min(world.height, Math.floor(stage.height / scale)))
      const x = clamp(Math.round(camera.cx - width / 2), 0, Math.max(0, world.width - width))
      const y = clamp(Math.round(camera.cy - height / 2), 0, Math.max(0, world.height - height))
      // The canvas is centred in the stage, so the leftover margin is a letterbox.
      const offsetX = Math.max(0, (stage.width - width * scale) / 2)
      const offsetY = Math.max(0, (stage.height - height * scale) / 2)
      return { x, y, width, height, scale, offsetX, offsetY }
    }

    /**
     * Stage-relative client coordinates → world cell coordinates.
     * @param {object} view - result of `viewFromCamera`.
     * @param {{left: number, top: number}} stageRect - stage bounding rect.
     * @param {number} clientX - pointer x.
     * @param {number} clientY - pointer y.
     * @returns {{x: number, y: number}} world cell (fractional).
     */
    function worldFromPoint(view, stageRect, clientX, clientY) {
      return {
        x: view.x + (clientX - stageRect.left - view.offsetX) / view.scale,
        y: view.y + (clientY - stageRect.top - view.offsetY) / view.scale,
      }
    }

    /**
     * Camera that keeps the world point under the cursor pinned while zooming.
     * @param {object} camera - current camera.
     * @param {{width: number, height: number}} stage - stage size.
     * @param {{width: number, height: number}} world - world size.
     * @param {{left: number, top: number}} stageRect - stage bounding rect.
     * @param {number} clientX - anchor x.
     * @param {number} clientY - anchor y.
     * @param {number} nextScale - requested zoom.
     * @returns {{cx: number, cy: number, scale: number}} new camera.
     */
    function cameraAfterZoom(camera, stage, world, stageRect, clientX, clientY, nextScale) {
      const before = viewFromCamera(camera, stage, world)
      const anchor = worldFromPoint(before, stageRect, clientX, clientY)
      const after = viewFromCamera({ cx: camera.cx, cy: camera.cy, scale: nextScale }, stage, world)
      const cursorX = clientX - stageRect.left - after.offsetX
      const cursorY = clientY - stageRect.top - after.offsetY
      return {
        cx: anchor.x - cursorX / after.scale + after.width / 2,
        cy: anchor.y - cursorY / after.scale + after.height / 2,
        scale: nextScale,
      }
    }

    /**
     * Subscribe a component to the store snapshot.
     * @param {object} store - the store.
     * @returns {object} snapshot.
     */
    function useStore(store) {
      const subscribe = React.useCallback(listener => store.subscribe(listener), [store])
      const read = React.useCallback(() => store.getSnapshot(), [store])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /**
     * Inspector card: species, energy, genes, lineage, follow and deselect.
     * @param {object} props - `{ selected, t, onFollow, onClear, following }`.
     * @returns {object} React element.
     */
    function Inspector(props) {
      const { selected, t, onFollow, onClear, following } = props
      if (selected === null || selected === undefined) {
        return h('div', { className: 'pe-empty' },
          h('div', { className: 'pe-empty-icon' }, h(PixelGlyph, { name: 'target', size: 22 })),
          h('div', { className: 'pe-empty-title' }, t('inspect.empty')),
          h('div', { className: 'pe-empty-hint' }, t('inspect.emptyHint')))
      }
      const species = SPECIES[selected.species]
      const energyRatio = clamp(selected.energy / Math.max(1, selected.maxEnergy), 0, 1)
      const genes = species === undefined ? [] : GENE_KEYS.map((key) => {
        const range = species.genes[key]
        const ratio = clamp((selected.genes[key] - range[0]) / Math.max(1e-6, range[1] - range[0]), 0, 1)
        return h('div', { className: 'pe-gene', key },
          h('span', { className: 'pe-gene-label' }, t(`inspect.gene.${key}`)),
          h('span', { className: 'pe-gene-track' }, h('span', {
            className: 'pe-gene-fill',
            style: { width: `${Math.round(ratio * 100)}%`, background: species.color },
          })),
          h('span', { className: 'pe-gene-value' }, selected.genes[key].toFixed(1)))
      })
      return h('div', { className: 'pe-card' },
        h('div', { className: 'pe-card-head' },
          h('span', { className: 'pe-swatch', style: { background: species?.color } }),
          h('span', { className: 'pe-card-title' }, t(`species.${selected.species}`)),
          h('span', { className: 'pe-tag' }, t(`stage.${selected.stage ?? 'adult'}`)),
          selected.intent === 'flee'
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('intent.flee'))
            : h('span', { className: 'pe-tag pe-tag-intent' }, t(`intent.${selected.intent ?? 'explore'}`)),
          h('button', {
            type: 'button', className: 'pe-icon-btn', title: t('action.deselect'),
            'aria-label': t('action.deselect'), onClick: onClear,
          }, h(PixelGlyph, { name: 'close', size: 12 }))),
        h('div', { className: 'pe-meter' },
          h('span', { className: 'pe-meter-fill', style: { width: `${Math.round(energyRatio * 100)}%` } })),
        h('div', { className: 'pe-rows' },
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.age')), h('b', null, `${Math.round(selected.age)}s`)),
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.energy')), h('b', null, `${Math.round(selected.energy)} / ${Math.round(selected.maxEnergy)}`))),
        h('div', { className: 'pe-chipline' },
          h('span', { className: 'pe-tag' }, t('inspect.generation', { n: selected.generation })),
          h('span', { className: 'pe-tag' }, t('inspect.children', { n: selected.children }))),
        h('div', { className: 'pe-needs' },
          NEED_KEYS.map(key => h('div', { className: 'pe-need', key },
            h('span', { className: 'pe-need-label' }, t(`needs.${key}`)),
            h('span', { className: 'pe-need-track' }, h('span', {
              className: 'pe-need-fill',
              style: { width: `${Math.round((selected.needs?.[key] ?? 0) * 100)}%` },
            })),
            h('span', { className: 'pe-need-value' }, String(Math.round((selected.needs?.[key] ?? 0) * 100)))))),
        h('div', { className: 'pe-genes' }, genes),
        h('button', {
          type: 'button',
          className: `pe-btn pe-btn-block${following ? ' pe-btn-active' : ''}`,
          onClick: onFollow,
        }, following ? t('inspect.unfollow') : t('inspect.follow')))
    }

    /**
     * Population chart with filled areas and a legend.
     * @param {object} props - `{ history, t }`.
     * @returns {object} React element.
     */
    function PopulationChart(props) {
      const { history, t } = props
      const canvasRef = React.useRef(null)
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.getContext !== 'function') return
        const context = canvas.getContext('2d')
        if (context === null) return
        const width = canvas.width
        const height = canvas.height
        context.clearRect(0, 0, width, height)
        context.strokeStyle = 'rgba(128,128,128,0.22)'
        context.lineWidth = 1
        for (let i = 1; i < 3; i++) {
          const y = Math.round((height / 3) * i) + 0.5
          context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke()
        }
        if (history.length < 2) return
        let peak = 1
        for (const sample of history) {
          for (const id of SPECIES_IDS) peak = Math.max(peak, sample.counts[id] ?? 0)
        }
        const stepX = width / Math.max(1, history.length - 1)
        for (const id of SPECIES_IDS) {
          const values = history.map(sample => sample.counts[id] ?? 0)
          if (!values.some(value => value > 0)) continue
          const color = SPECIES[id].color
          context.beginPath()
          values.forEach((value, index) => {
            const x = index * stepX
            const y = height - 2 - (value / peak) * (height - 4)
            if (index === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
          })
          context.lineTo(width, height)
          context.lineTo(0, height)
          context.closePath()
          context.fillStyle = color
          context.globalAlpha = 0.12
          context.fill()
          context.globalAlpha = 1
          context.beginPath()
          values.forEach((value, index) => {
            const x = index * stepX
            const y = height - 2 - (value / peak) * (height - 4)
            if (index === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
          })
          context.strokeStyle = color
          context.lineWidth = 1.4
          context.stroke()
        }
      }, [history])
      return h('div', { className: 'pe-panel' },
        h('div', { className: 'pe-panel-title' }, t('chart.title')),
        h('canvas', { ref: canvasRef, width: 240, height: 64, className: 'pe-chart' }),
        h('div', { className: 'pe-legend' }, SPECIES_IDS.map(id => h('span', { className: 'pe-legend-item', key: id },
          h('span', { className: 'pe-swatch pe-swatch-sm', style: { background: SPECIES[id].color } }),
          h('span', null, t(`species.${id}`))))))
    }

    /**
     * Minimap with the current viewport rectangle; click to jump.
     * @param {object} props - `{ store, snapshot, onJump }`.
     * @returns {object} React element.
     */
    function Minimap(props) {
      const { store, snapshot, onJump } = props
      const canvasRef = React.useRef(null)
      const MAP_W = 168
      const MAP_H = 105
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.getContext !== 'function') return
        const context = canvas.getContext('2d')
        if (context === null) return
        const minimap = store.getMinimap(MAP_W, MAP_H)
        const image = context.createImageData(MAP_W, MAP_H)
        const view32 = new Uint32Array(image.data.buffer)
        view32.set(minimap.data)
        context.putImageData(image, 0, 0)
        const world = snapshot?.world
        const view = snapshot?.view
        if (!world || !view || view.width <= 0) return
        const scaleX = MAP_W / world.width
        const scaleY = MAP_H / world.height
        context.strokeStyle = 'rgba(255,255,255,0.9)'
        context.lineWidth = 1
        context.strokeRect(view.x * scaleX + 0.5, view.y * scaleY + 0.5,
          Math.max(2, view.width * scaleX - 1), Math.max(2, view.height * scaleY - 1))
      }, [store, snapshot, MAP_W, MAP_H])
      return h('div', { className: 'pe-minimap' },
        h('canvas', {
          ref: canvasRef,
          width: MAP_W,
          height: MAP_H,
          className: 'pe-minimap-canvas',
          onPointerDown: (event) => {
            const canvas = canvasRef.current
            if (canvas === null) return
            const bounds = canvas.getBoundingClientRect()
            const world = snapshot.world
            if (world === null) return
            onJump(((event.clientX - bounds.left) / bounds.width) * world.width,
              ((event.clientY - bounds.top) / bounds.height) * world.height)
          },
        }))
    }

    /**
     * The whole panel.
     * @param {object} props - slot props plus `{ store, locale, layout }`.
     * @returns {object} React element.
     */
    function TerrariumPanel(props) {
      const { store, locale, layout } = props
      const t = useTranslate(locale)
      const snapshot = useStore(store)
      const worldSize = snapshot.world ?? { width: GRID_W, height: GRID_H }
      const [tool, setTool] = React.useState('pointer')
      const [brushIndex, setBrushIndex] = React.useState(1)
      const [helpOpen, setHelpOpen] = React.useState(false)
      const [confirmNew, setConfirmNew] = React.useState(false)
      const [cameraTick, setCameraTick] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const [hoverCell, setHoverCell] = React.useState(null)
      const toastTimer = React.useRef(0)
      const stageRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const cameraRef = React.useRef({ cx: worldSize.width / 2, cy: worldSize.height / 2, scale: 6, fitted: false })
      const dragRef = React.useRef({ mode: 'none', moved: 0, lastX: 0, lastY: 0, lastCell: '', button: 0 })
      const [stageSize, setStageSize] = React.useState({ width: 900, height: 560 })
      const stageSizeRef = React.useRef(stageSize)
      React.useEffect(() => { stageSizeRef.current = stageSize }, [stageSize])

      /** Viewport in cells; the exact same function the input layer uses. */
      const view = React.useMemo(
        () => viewFromCamera(cameraRef.current, stageSize, worldSize),
        [worldSize.width, worldSize.height, stageSize.width, stageSize.height, cameraTick],
      )

      React.useEffect(() => {
        store.ensureWorld()
        store.setView({ x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale })
        store.attach(canvasRef.current)
        return () => store.detach()
        // Attach once: the viewport effect below re-points the renderer, so a
        // pan must never tear the canvas binding down and rebuild it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [store])

      React.useEffect(() => {
        store.setView({ x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale })
      }, [store, view.x, view.y, view.width, view.height, view.scale])

      React.useEffect(() => {
        store.setBrush(tool, BRUSH_RADIUS[brushIndex])
      }, [store, tool, brushIndex])

      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const measure = () => {
          const bounds = stage.getBoundingClientRect()
          setStageSize({ width: Math.max(200, bounds.width), height: Math.max(160, bounds.height) })
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(stage)
        return () => observer.disconnect()
      }, [])

      // Open zoomed in enough to read the animals, centred on the map.
      React.useEffect(() => {
        if (cameraRef.current.fitted) return
        const fit = Math.max(1, Math.min(stageSize.width / worldSize.width, stageSize.height / worldSize.height))
        cameraRef.current.scale = clamp(Math.round(Math.max(5, fit * 4)), 4, 8)
        cameraRef.current.cx = worldSize.width / 2
        cameraRef.current.cy = worldSize.height / 2
        cameraRef.current.fitted = true
        setCameraTick(value => value + 1)
      }, [stageSize, worldSize])

      const bumpCamera = React.useCallback(() => setCameraTick(value => value + 1), [])

      /** Centre the camera on a world point. */
      const lookAt = React.useCallback((x, y) => {
        cameraRef.current.cx = clamp(x, 0, worldSize.width)
        cameraRef.current.cy = clamp(y, 0, worldSize.height)
        cameraRef.current.fitted = true
        bumpCamera()
      }, [worldSize, bumpCamera])

      /** Fit the whole map at an integer zoom. */
      const fitAll = React.useCallback(() => {
        const fit = Math.min(stageSize.width / worldSize.width, stageSize.height / worldSize.height)
        cameraRef.current.scale = clamp(Math.max(1, Math.floor(fit)), 1, MAX_SCALE)
        cameraRef.current.cx = worldSize.width / 2
        cameraRef.current.cy = worldSize.height / 2
        cameraRef.current.fitted = true
        bumpCamera()
      }, [stageSize, worldSize, bumpCamera])

      // ---------------------------------------------------------------------
      // Input: pointer mode pans and selects; the brush tools paint.
      // ---------------------------------------------------------------------
      const translateRef = React.useRef(t)
      const toolRef = React.useRef(tool)
      const viewRef = React.useRef(view)
      React.useEffect(() => {
        translateRef.current = t
        toolRef.current = tool
        viewRef.current = view
      }, [t, tool, view])

      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined

        const stageRect = () => stage.getBoundingClientRect()
        const cellAt = (clientX, clientY) => worldFromPoint(viewRef.current, stageRect(), clientX, clientY)

        const report = (released) => {
          if (SPECIES[toolRef.current] === undefined) return
          const translate = translateRef.current
          setToast(released > 0 ? translate('toast.placed', { n: released }) : translate('toast.blocked'))
          if (toastTimer.current !== 0) clearTimeout(toastTimer.current)
          toastTimer.current = setTimeout(() => setToast(null), 1800)
        }

        /** Pointer mode (or the middle button) drags the map; brushes paint. */
        const shouldPan = (event) => toolRef.current === 'pointer' || event.button === 1

        const handleDown = (event) => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
          const drag = dragRef.current
          drag.mode = shouldPan(event) ? 'pan' : 'paint'
          drag.button = event.button
          drag.moved = 0
          drag.lastX = event.clientX
          drag.lastY = event.clientY
          drag.lastCell = ''
          const point = cellAt(event.clientX, event.clientY)
          if (drag.mode === 'paint') {
            drag.lastCell = `${Math.round(point.x)},${Math.round(point.y)}`
            report(store.paintAt(point.x, point.y, event.button === 2))
          }
          if (typeof stage.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
            try { stage.setPointerCapture(event.pointerId) } catch { /* capture is optional */ }
          }
          event.preventDefault()
        }

        const handleMove = (event) => {
          const point = cellAt(event.clientX, event.clientY)
          const cell = `${Math.round(point.x)},${Math.round(point.y)}`
          setHoverCell(cell)
          store.setHover(point)
          const drag = dragRef.current
          if (drag.mode === 'none') return
          // A lost pointerup (alt-tab, browser gesture) must not leave the brush
          // or the map stuck to the cursor.
          if (event.buttons === 0) { drag.mode = 'none'; return }
          const dx = event.clientX - drag.lastX
          const dy = event.clientY - drag.lastY
          drag.moved += Math.abs(dx) + Math.abs(dy)
          const current = viewRef.current
          if (drag.mode === 'pan') {
            cameraRef.current.cx -= dx / current.scale
            cameraRef.current.cy -= dy / current.scale
            bumpCamera()
          } else if (cell !== drag.lastCell) {
            drag.lastCell = cell
            store.paintAt(point.x, point.y, (event.buttons & 2) === 2)
          }
          drag.lastX = event.clientX
          drag.lastY = event.clientY
        }

        const handleUp = (event) => {
          const drag = dragRef.current
          const wasTap = drag.moved < 10 && drag.button === event.button
          const mode = drag.mode
          drag.mode = 'none'
          if (!wasTap) return
          const point = cellAt(event.clientX, event.clientY)
          if (mode === 'pan' && event.button === 0) {
            // Pointer mode: a tap inspects, a drag pans.
            const entity = store.selectAt(point.x, point.y)
            if (entity === undefined) store.clearSelection()
          } else if (mode === 'paint' && event.button === 2) {
            store.clearSelection()
          }
        }

        const handleWheel = (event) => {
          event.preventDefault()
          const current = viewRef.current
          const nextScale = clamp(current.scale + (event.deltaY < 0 ? 1 : -1), MIN_SCALE, MAX_SCALE)
          if (nextScale === current.scale) return
          const world = store.getWorld() ?? { width: current.width, height: current.height }
          const camera = cameraAfterZoom(
            { cx: cameraRef.current.cx, cy: cameraRef.current.cy, scale: current.scale },
            stageSizeRef.current,
            world,
            stageRect(),
            event.clientX,
            event.clientY,
            nextScale,
          )
          cameraRef.current.cx = camera.cx
          cameraRef.current.cy = camera.cy
          cameraRef.current.scale = camera.scale
          bumpCamera()
        }

        const handleLeave = () => {
          store.setHover(null)
          setHoverCell(null)
          dragRef.current.mode = 'none'
        }

        const handleContext = (event) => event.preventDefault()

        stage.addEventListener('pointerdown', handleDown)
        stage.addEventListener('pointermove', handleMove)
        stage.addEventListener('pointerup', handleUp)
        stage.addEventListener('pointercancel', handleUp)
        stage.addEventListener('pointerleave', handleLeave)
        stage.addEventListener('wheel', handleWheel, { passive: false })
        stage.addEventListener('contextmenu', handleContext)
        return () => {
          stage.removeEventListener('pointerdown', handleDown)
          stage.removeEventListener('pointermove', handleMove)
          stage.removeEventListener('pointerup', handleUp)
          stage.removeEventListener('pointercancel', handleUp)
          stage.removeEventListener('pointerleave', handleLeave)
          stage.removeEventListener('wheel', handleWheel)
          stage.removeEventListener('contextmenu', handleContext)
        }
      }, [store, bumpCamera])


      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setHelpOpen(false)
            setConfirmNew(false)
            store.clearSelection()
            return
          }
          if (event.target !== null && event.target.tagName === 'INPUT') return
          if (event.code === 'Space') { event.preventDefault(); store.togglePause() }
          else if (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4') {
            store.setSpeed([1, 2, 4, 8][Number(event.key) - 1])
          } else if (event.key === 'f' || event.key === 'F') fitAll()
          else if (event.key === 'h' || event.key === 'H') setHelpOpen(open => !open)
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }
        return undefined
      }, [store, fitAll])

      React.useEffect(() => {
        if (!confirmNew) return undefined
        const timer = setTimeout(() => setConfirmNew(false), 2600)
        return () => clearTimeout(timer)
      }, [confirmNew])

      const selected = snapshot.selected ?? null

      const speciesChips = SPECIES_IDS.map((id) => h('span', {
        className: 'pe-chip', key: id, title: t(`species.${id}`),
      },
        h('span', { className: 'pe-swatch pe-swatch-sm', style: { background: SPECIES[id].color } }),
        h('span', { className: 'pe-chip-count' }, String(snapshot.stats?.counts?.[id] ?? 0))))

      const toolButton = (id) => {
        const isSpecies = SPECIES[id] !== undefined
        const color = isSpecies ? SPECIES[id].color : undefined
        const label = isSpecies ? t(`species.${id}`) : t(`tool.${id}`)
        return h('button', {
          type: 'button', key: id,
          className: `pe-tool${tool === id ? ' is-active' : ''}`,
          onClick: () => setTool(id),
          title: label,
          'aria-pressed': tool === id,
          'aria-label': label,
        },
          h(PixelGlyph, { name: isSpecies ? 'creature' : id, color, size: 18 }),
          h('span', { className: 'pe-tool-label' }, label))
      }

      const speedButton = (value) => h('button', {
        type: 'button', key: value,
        className: `pe-seg-btn${snapshot.speed === value && !snapshot.paused ? ' is-active' : ''}`,
        onClick: () => store.setSpeed(value),
        'aria-label': t(`speed.${value}`),
      }, t(`speed.${value}`))

      return h('div', { className: 'pe-root' },
        h('header', { className: 'pe-head' },
          h('div', { className: 'pe-brand' },
            h('span', { className: 'pe-logo' }, h(PixelGlyph, { name: 'tree', color: '#4a9d54', size: 18 })),
            h('div', null,
              h('div', { className: 'pe-title' }, t('panel.title')),
              h('div', { className: 'pe-sub' },
                `${t('stat.day', { day: snapshot.stats?.day ?? 1 })} · ${snapshot.stats?.clock ?? '06:00'}`))),
          h('div', { className: 'pe-chips' }, speciesChips),
          h('div', { className: 'pe-controls' },
            h('button', {
              type: 'button', className: 'pe-icon-btn pe-icon-btn-lg',
              onClick: () => store.togglePause(),
              title: snapshot.paused ? t('action.play') : t('action.pause'),
              'aria-label': snapshot.paused ? t('action.play') : t('action.pause'),
            }, h(PixelGlyph, { name: snapshot.paused ? 'play' : 'pause', size: 14 })),
            h('div', { className: 'pe-seg' }, SPEEDS.map(speedButton)),
            h('button', {
              type: 'button', className: 'pe-icon-btn',
              onClick: () => store.stepOnce(), title: t('action.step'), 'aria-label': t('action.step'),
            }, h(PixelGlyph, { name: 'step', size: 12 })),
            h('span', { className: 'pe-divider' }),
            h('button', {
              type: 'button',
              className: `pe-btn${confirmNew ? ' pe-btn-danger' : ''}`,
              onClick: () => {
                if (!confirmNew) { setConfirmNew(true); return }
                setConfirmNew(false)
                store.newWorld()
                fitAll()
              },
            }, confirmNew ? t('action.newWorldConfirm') : t('action.newWorld')),
            h('button', { type: 'button', className: 'pe-btn', onClick: fitAll }, t('action.fit')),
            h('button', {
              type: 'button', className: `pe-btn${helpOpen ? ' pe-btn-active' : ''}`,
              onClick: () => setHelpOpen(open => !open),
            }, t('action.help')),
            layout !== undefined && typeof layout.selectPanel === 'function'
              ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => layout.selectPanel('conversation') }, t('action.back'))
              : null)),
        h('div', { className: 'pe-body' },
          h('div', {
            className: 'pe-stage',
            ref: stageRef,
            style: { cursor: tool === 'pointer' ? 'grab' : 'crosshair' },
          },
            h('canvas', {
              ref: canvasRef,
              className: 'pe-canvas',
              width: view.width * view.scale,
              height: view.height * view.scale,
              style: {
                width: `${view.width * view.scale}px`,
                height: `${view.height * view.scale}px`,
              },
            }),
            h('div', { className: 'pe-hud pe-hud-bl' },
              h('span', { className: 'pe-hud-item' }, hoverCell === null ? '—' : hoverCell),
              h('span', { className: 'pe-hud-item' }, `${view.x},${view.y}`),
              h('span', { className: 'pe-hud-item' }, `${view.width}×${view.height}`),
              h('span', { className: 'pe-hud-item' }, `${view.scale}×`)),
            h('div', { className: 'pe-hud pe-hud-br' },
              h(Minimap, { store, snapshot, onJump: lookAt })),
            toast === null ? null : h('div', { className: 'pe-toast' }, toast)),
          h('aside', { className: 'pe-side' },
            h('section', { className: 'pe-panel' },
              h('div', { className: 'pe-panel-title' }, t('tool.group.life')),
              h('div', { className: 'pe-tools' }, LIFE_TOOLS.map(toolButton))),
            h('section', { className: 'pe-panel' },
              h('div', { className: 'pe-panel-title' }, t('tool.group.terrain')),
              h('div', { className: 'pe-tools' }, TERRAIN_TOOL_IDS.map(toolButton))),
            h('section', { className: 'pe-panel pe-panel-row' },
              h('div', { className: 'pe-panel-title' }, t('brush.label')),
              h('div', { className: 'pe-seg' }, BRUSHES.map((radius, index) => h('button', {
                type: 'button', key: radius,
                className: `pe-seg-btn${brushIndex === index ? ' is-active' : ''}`,
                onClick: () => setBrushIndex(index),
                'aria-label': t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'),
              }, t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'))))),
            h(PopulationChart, { history: snapshot.history ?? [], t }),
            h('section', { className: 'pe-panel pe-panel-grow' },
              h('div', { className: 'pe-panel-title' }, t('inspect.title')),
              h(Inspector, {
                selected,
                t,
                following: snapshot.following === true,
                onFollow: () => store.setFollow(!snapshot.following),
                onClear: () => store.clearSelection(),
              })))),
        helpOpen
          ? h('div', { className: 'pe-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('help.title'), onClick: () => setHelpOpen(false) },
            h('div', { className: 'pe-modal-card', onClick: event => event.stopPropagation() },
              h('div', { className: 'pe-modal-head' },
                h('span', { className: 'pe-title' }, t('help.title')),
                h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => setHelpOpen(false) }, t('action.close'))),
              h('ul', { className: 'pe-modal-body' },
                [1, 2, 3, 4, 5, 6, 7, 8].map(index => h('li', { key: index }, t(`help.${index}`))))))
          : null)
    }


    // ---------------------------------------------------------------------
    // Extra palette entries and locale keys used by the panel chrome
    // ---------------------------------------------------------------------

    /**
     * Finish a terrain edit: refresh moisture from the new shoreline and give
     * freshly painted land a natural fertility again.
     * @param {object} world - the world.
     */
    function settleTerrain(world) {
      if (world.hydrologyDirty !== true) return
      computeHydrology(world, false)
      const fertility = world.fertility
      for (let i = 0; i < fertility.length; i++) {
        if (fertility[i] !== 0) continue
        const terrain = world.terrain[i]
        if (terrain === TERRAIN.WATER || terrain === TERRAIN.STONE) continue
        fertility[i] = baseFertility(world, i)
      }
      world.hydrologyDirty = false
    }
    PALETTE.effect.cursor = rgb(255, 255, 255)
    PALETTE.effect.select = rgb(255, 236, 140)

    Object.assign(CHINESE, {
      'action.step': '单步',
      'action.deselect': '取消选择',
      'inspect.title': '详情',
      'inspect.emptyHint': '左键放置，右键擦除；点一只生物看它的基因',
      'help.8': '空格暂停、1–4 调速度、F 适应窗口、Esc 取消选择。',
      'stage.juvenile': '幼崽',
      'stage.adult': '成年',
      'stage.elder': '老年',
      'intent.flee': '逃跑',
      'intent.forage': '觅食',
      'intent.hunt': '捕猎',
      'intent.scavenge': '食腐',
      'intent.drink': '喝水',
      'intent.rest': '休息',
      'intent.socialize': '结伴',
      'intent.explore': '游荡',
      'needs.title': '需求',
      'needs.hunger': '饥饿',
      'needs.thirst': '口渴',
      'needs.energy': '体力',
      'needs.safety': '安全',
      'needs.social': '社交',
      'toast.placed': '放出了 {n} 只',
      'toast.blocked': '这里放不下，附近也没有合适的地方',
    })
    Object.assign(ENGLISH, {
      'action.step': 'Step',
      'action.deselect': 'Deselect',
      'inspect.title': 'Details',
      'inspect.emptyHint': 'Left-click places, right-click erases; click a creature for its genes',
      'help.8': 'Space pauses, 1–4 set speed, F fits the view, Esc clears the selection.',
      'stage.juvenile': 'Juvenile',
      'stage.adult': 'Adult',
      'stage.elder': 'Elder',
      'intent.flee': 'Fleeing',
      'intent.forage': 'Foraging',
      'intent.hunt': 'Hunting',
      'intent.scavenge': 'Scavenging',
      'intent.drink': 'Drinking',
      'intent.rest': 'Resting',
      'intent.socialize': 'Socialising',
      'intent.explore': 'Wandering',
      'needs.title': 'Needs',
      'needs.hunger': 'Hunger',
      'needs.thirst': 'Thirst',
      'needs.energy': 'Energy',
      'needs.safety': 'Safety',
      'needs.social': 'Social',
      'toast.placed': 'Released {n}',
      'toast.blocked': 'Nothing fits here, and no room nearby',
    })

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /** Every class is `pe-` prefixed; colours come from theme tokens. */
    const CSS = `
.pe-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;-webkit-font-smoothing:antialiased}
.pe-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pe-brand{display:flex;align-items:center;gap:10px;min-width:0}
.pe-logo{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.pe-title{font-size:13.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.pe-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
.pe-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.pe-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;font-variant-numeric:tabular-nums;line-height:17px}
.pe-chip-count{color:var(--dsw-alias-label-primary);font-weight:600}
.pe-swatch{width:9px;height:9px;border-radius:3px;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.18) inset}
.pe-swatch-sm{width:7px;height:7px;border-radius:2px}
.pe-controls{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.pe-seg{display:inline-flex;align-items:center;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-seg-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;line-height:16px;padding:3px 9px;border-radius:7px;cursor:pointer;min-width:34px}
.pe-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.pe-seg-btn.is-active{background:var(--dsw-alias-brand-primary);color:#fff}
.pe-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.pe-btn:hover{background:var(--dsw-alias-bg-overlay)}
.pe-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-btn-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pe-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.pe-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pe-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pe-btn-block{width:100%}
.pe-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.pe-icon-btn:hover{background:var(--dsw-alias-bg-overlay)}
.pe-icon-btn-lg{width:32px;height:32px;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.pe-divider{width:1px;height:20px;background:var(--dsw-alias-border-l1)}
.pe-body{display:flex;flex:1;min-height:0;min-width:0}
.pe-stage{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;background:radial-gradient(circle at 50% 40%, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-base) 70%)}
.pe-canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;image-rendering:crisp-edges;touch-action:none;display:block;border-radius:2px;box-shadow:0 10px 30px rgba(0,0,0,.22)}
.pe-toast{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(20,22,28,.82);color:#fff;font-size:11.5px;line-height:16px;box-shadow:0 8px 20px rgba(0,0,0,.32);pointer-events:none}
.pe-hud{position:absolute;display:flex;align-items:center;gap:6px;pointer-events:none}
.pe-hud-bl{left:12px;bottom:12px}
.pe-hud-br{right:12px;bottom:12px;pointer-events:auto}
.pe-hud-item{padding:2px 7px;border-radius:7px;background:rgba(20,22,28,.55);color:#fff;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;backdrop-filter:blur(4px)}
.pe-minimap{padding:5px;border-radius:10px;background:rgba(20,22,28,.6);backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.28)}
.pe-minimap-canvas{display:block;border-radius:6px;cursor:pointer;image-rendering:pixelated}
.pe-side{width:290px;flex:none;display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.pe-panel{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.pe-panel-grow{flex:1;min-height:0}
.pe-panel-row{flex-direction:row;align-items:center;justify-content:space-between}
.pe-panel-title{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pe-tools{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.pe-tool{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:52px;padding:4px 2px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:12px;cursor:pointer;transition:transform .1s ease,border-color .12s ease,background .12s ease}
.pe-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pe-tool:active{transform:scale(.96)}
.pe-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-tool.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.pe-tool-label{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-chart{width:100%;height:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.pe-legend{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}
.pe-legend-item{display:inline-flex;align-items:center;gap:4px}
.pe-card{display:flex;flex-direction:column;gap:8px}
.pe-card-head{display:flex;align-items:center;gap:7px}
.pe-card-title{font-weight:650;font-size:12.5px}
.pe-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}
.pe-tag-alert{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pe-chipline{display:flex;gap:6px;flex-wrap:wrap}
.pe-card-head .pe-icon-btn{margin-left:auto;width:22px;height:22px;border-radius:6px}
.pe-meter{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.pe-meter-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-success-primary))}
.pe-rows{display:flex;flex-direction:column;gap:3px}
.pe-row{display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.pe-row b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.pe-genes{display:flex;flex-direction:column;gap:5px}
.pe-gene{display:grid;grid-template-columns:52px 1fr 34px;align-items:center;gap:7px}
.pe-gene-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-gene-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-gene-fill{display:block;height:100%;border-radius:999px}
.pe-gene-value{text-align:right;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 8px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);text-align:center}
.pe-empty-icon{opacity:.55}
.pe-empty-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:11.5px}
.pe-empty-hint{font-size:10.5px;line-height:15px;opacity:.9}
.pe-modal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);z-index:6}
.pe-modal-card{width:min(560px,100%);max-height:100%;overflow:auto;padding:18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 44px rgba(0,0,0,.34);box-sizing:border-box}
.pe-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.pe-modal-body{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:7px;font-size:12px;line-height:18px}
.pe-fatal{display:flex;flex-direction:column;gap:8px;padding:18px;border-radius:12px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;overflow:auto}
.pe-fatal-title{font-weight:700;color:var(--dsw-alias-state-error-primary)}
.pe-fatal-body{margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.pe-needs{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pe-need{display:grid;grid-template-columns:44px 1fr 26px;align-items:center;gap:6px}
.pe-need-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px}
.pe-need-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-need-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),var(--dsw-alias-state-error-primary))}
.pe-need-value{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-tag-intent{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}@media (max-width: 980px){.pe-side{width:250px}.pe-tools{grid-template-columns:repeat(3,1fr)}}
@media (max-width: 760px){.pe-body{flex-direction:column}.pe-side{width:auto;max-height:46%;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}}
`

    // ---------------------------------------------------------------------
    // Plugin registration
    // ---------------------------------------------------------------------

    /** Client half exports: two additive slot registrations, nothing replaced. */
    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = typeof document === 'undefined' ? null : document.createElement('style')
        if (style !== null) {
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => { style.remove() })
        }
        ctx.effect(() => registerDictionaries(ctx.locale))
        const store = createStore({})
        ctx.effect(() => () => store.dispose())
        const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 24,
          label: () => ctx.locale.bind(NS)('panel.title'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, props => h(PANEL_BOUNDARY, null, h(TerrariumPanel, { ...props, store, locale: ctx.locale, layout }))))
      },
    }

    module.exports = plugin
    // Test seam: the engine and the renderer are DOM-free.
    module.exports.__engine = {
      SPECIES,
      SPECIES_IDS,
      TERRAIN,
      GENE_KEYS,
      NEED_KEYS,
      INTENT_IDS,
      ROLE_TRAITS,
      STAGE_SCALE,
      TUNING,
      PALETTE,
      SPRITES,
      SPRITE_GRIDS,
      PLANT_SPRITES,
      SPRITE_COLORS,
      TICK,
      DAY_SECONDS,
      MAX_ENTITIES,
      createWorld,
      stepWorld,
      place,
      spawnEntity,
      findEntityAt,
      sampleStats,
      pushHistory,
      serializeWorld,
      deserializeWorld,
      paintView,
      paintWorld,
      paintMinimap,
      viewFromCamera,
      worldFromPoint,
      cameraAfterZoom,
      frameFor,
      countSpecies,
      handleImmigration,
      settleTerrain,
      computeHydrology,
      createStore,
      GLYPHS,
      PANEL_GLYPH,
    }
    module.exports.__test = {
      CHINESE,
      ENGLISH,
      GLYPHS,
      PANEL_GLYPH,
      TerrariumPanel,
      Inspector,
      PopulationChart,
      Minimap,
      PanelIcon,
      PixelGlyph,
      BRUSHES,
      BRUSH_RADIUS,
      LIFE_TOOLS,
      TERRAIN_TOOL_IDS,
      SPECIES_TOOL_IDS: SPECIES_IDS,
    }

    return module.exports
  },
})