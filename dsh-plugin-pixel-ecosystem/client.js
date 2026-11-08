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
    const MAX_TREES = 1150
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
        habitat: 'land', role: 'grazer', flora: 'grass', meat: 18, cap: 400, minimum: 40, color: '#c9a97b',
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
          fleeSpeed: 1.9, fleeDrain: 0.55,
        },
      },
      deer: {
        habitat: 'land', role: 'grazer', flora: 'grass', browse: true, meat: 45, cap: 260, minimum: 22, color: '#b98a5e',
        territory: { radius: 7, max: 6 },
        herd: { radius: 26, separation: 6, alarmRadius: 20 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.5 },
        flight: { burst: 1.5, burstSeconds: 2.2, tired: 1.15 },
        genes: {
          speed: [2.6, 3.8], vision: [8, 16], size: [1.4, 2.2],
          metabolism: [1.05, 1.5], lifespan: [1100, 1600], fertility: [110, 130],
        },
        balance: {
          startEnergy: 110, maxEnergy: 170, drain: 0.88, breedEnergy: 100, breedCost: 42,
          maturity: 150, litter: [1, 3], eatRate: 2.2, floraEnergy: 9,
          browseRate: 1.6, browseEnergy: 7, fleeSpeed: 1.85, fleeDrain: 0.8,
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
          maturity: 96, litter: [3, 6], catchRadius: 1.15, huntSpeed: 1.5, scavengeShare: 0.6, meatGain: 3.1,
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
          maturity: 240, litter: [3, 5], catchRadius: 1.3, huntSpeed: 1.45, scavengeShare: 0.55, meatGain: 2.4,
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
          startEnergy: 40, maxEnergy: 80, drain: 0.5, breedEnergy: 56, breedCost: 14,
          maturity: 200, litter: [3, 5], scavengeRadius: 1.7, corpseShare: 1.5,
        },
      },
      fish: {
        habitat: 'water', role: 'grazer', flora: 'weed', meat: 20, cap: 170, minimum: 40, color: '#5b9fd4',
        territory: { radius: 3, max: 8 },
        herd: { radius: 14, separation: 4, alarmRadius: 10 },
        activity: { dawn: 1, day: 0.9, dusk: 1, night: 0.5 },
        flight: { burst: 1.6, burstSeconds: 0.8, tired: 1.1 },
        genes: {
          speed: [2.2, 4.0], vision: [5, 11], size: [0.7, 1.3],
          metabolism: [0.7, 1.2], lifespan: [420, 560], fertility: [110, 130],
        },
        balance: {
          startEnergy: 40, maxEnergy: 80, drain: 0.68, breedEnergy: 50, breedCost: 10,
          maturity: 90, litter: [6, 10], eatRate: 1.5, floraEnergy: 9,
          fleeSpeed: 1.9, fleeDrain: 0.95,
        },
      },
      pike: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], meat: 60, cap: 70, minimum: 6, color: '#4a6b4a',
        // Ambush: it does not chase across the lake, it waits and then strikes.
        ambush: { approach: 0.45, strikeDistance: 7, strikeSpeed: 1.9, cooldown: 2.5 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [4.4, 6.2], vision: [8, 16], size: [1.1, 1.9],
          metabolism: [0.95, 1.4], lifespan: [1000, 1300], fertility: [110, 130],
        },
        balance: {
          startEnergy: 74, maxEnergy: 130, drain: 0.92, breedEnergy: 76, breedCost: 28,
          maturity: 260, litter: [2, 4], catchRadius: 1.8, huntSpeed: 1.5, scavengeShare: 0.4, meatGain: 2.8,
        },
      },
      // The next four are the land/water bridge. A heron and a bear stand in the
      // shallows and take fish out of the lake; an otter goes the other way and
      // swims after them. That is the cross-habitat link the food web was
      // missing: before them the lake was a closed loop that nothing on land
      // could reach.
      heron: {
        // Wades: can stand in shallow water, which is how it reaches the fish.
        habitat: 'land', role: 'hunter', prey: ['fish', 'frog'], meat: 34, cap: 60, minimum: 6, color: '#9aa4b2',
        wade: true,
        territory: { radius: 14, max: 3 },
        activity: { dawn: 1, day: 0.95, dusk: 1, night: 0.25 },
        genes: {
          speed: [3.2, 5.0], vision: [12, 22], size: [0.9, 1.3],
          metabolism: [0.8, 1.2], lifespan: [420, 620], fertility: [110, 130],
        },
        balance: {
          startEnergy: 62, maxEnergy: 110, drain: 0.72, breedEnergy: 74, breedCost: 24,
          maturity: 150, litter: [2, 4], catchRadius: 2.4, huntSpeed: 1.25, scavengeShare: 0.5, meatGain: 2.5,
        },
      },
      otter: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], meat: 30, cap: 70, minimum: 7, color: '#7a5238',
        amphibious: true,
        territory: { radius: 12, max: 3 },
        activity: { dawn: 1, day: 0.85, dusk: 1, night: 0.6 },
        genes: {
          speed: [3.6, 5.4], vision: [10, 18], size: [0.9, 1.3],
          metabolism: [0.95, 1.35], lifespan: [380, 560], fertility: [110, 130],
        },
        balance: {
          startEnergy: 70, maxEnergy: 120, drain: 0.84, breedEnergy: 80, breedCost: 22,
          maturity: 130, litter: [2, 4], catchRadius: 1.7, huntSpeed: 1.55, scavengeShare: 0.5, meatGain: 2.4,
        },
      },
      bear: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'fish', 'rabbit'], meat: 120, cap: 40, minimum: 3, color: '#6b4a34',
        wade: true,
        territory: { radius: 26, max: 1 },
        activity: { dawn: 0.9, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [3.0, 4.4], vision: [10, 18], size: [1.8, 2.6],
          metabolism: [0.8, 1.15], lifespan: [900, 1300], fertility: [110, 130],
        },
        balance: {
          startEnergy: 170, maxEnergy: 280, drain: 1.0, breedEnergy: 190, breedCost: 72,
          maturity: 300, litter: [1, 2], catchRadius: 2.1, huntSpeed: 1.3, scavengeShare: 0.7, meatGain: 2.2,
        },
      },
      frog: {
        // Grazes the shallow weed, so it is the land/water seam in miniature:
        // water plants feed it, and heron, otter and pike eat it.
        habitat: 'land', role: 'grazer', flora: 'weed', meat: 7, cap: 160, minimum: 26, color: '#6fae4e',
        wade: true,
        territory: { radius: 2, max: 9 },
        herd: { radius: 10, separation: 3, alarmRadius: 8 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.55 },
        flight: { burst: 2.1, burstSeconds: 0.5, tired: 1.1 },
        genes: {
          speed: [1.4, 2.6], vision: [3, 7], size: [0.55, 0.9],
          metabolism: [0.6, 1.05], lifespan: [150, 260], fertility: [70, 100],
        },
        balance: {
          startEnergy: 18, maxEnergy: 36, drain: 0.42, breedEnergy: 22, breedCost: 5,
          maturity: 45, litter: [8, 14], eatRate: 1.4, floraEnergy: 7,
          fleeSpeed: 2.15, fleeDrain: 0.7,
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
    const DEFAULT_STOCKS = {
      rabbit: 160, deer: 40, fox: 12, wolf: 5, crow: 20, fish: 120, pike: 12,
      heron: 10, otter: 10, bear: 4, frog: 90,
    }

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
      if (species.habitat === 'water') {
        if (terrain === TERRAIN.WATER) return true
        // An amphibious water animal may haul out on land to rest and to breed.
        return species.amphibious === true && terrain !== TERRAIN.STONE
      }
      if (terrain === TERRAIN.STONE) return false
      if (terrain !== TERRAIN.WATER) return true
      // Waders stand in the shallows only: depth is distance from the bank, so
      // this keeps a heron or a bear at the edge instead of walking the lake bed.
      if (species.wade !== true) return false
      const column = Math.max(0, Math.min(world.width - 1, Math.round(x)))
      const row = Math.max(0, Math.min(world.height - 1, Math.round(y)))
      return world.depth[row * world.width + column] < 0.34
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
      // Second pass the other way: how far a water cell is from the bank. This
      // is the lake's depth, and it drives both the wading rule and the water
      // shading, so it has to be refreshed with the rest of the hydrology.
      const depthDistance = new Int32Array(size).fill(1e9)
      head = 0
      tail = 0
      for (let i = 0; i < size; i++) {
        if (world.terrain[i] !== TERRAIN.WATER) { depthDistance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = depthDistance[index] + 1
        if (x > 0 && depthDistance[index - 1] > next) { depthDistance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && depthDistance[index + 1] > next) { depthDistance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && depthDistance[index - width] > next) { depthDistance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && depthDistance[index + width] > next) { depthDistance[index + width] = next; queue[tail++] = index + width }
      }
      const depth = world.depth !== undefined && world.depth.length === size ? world.depth : new Float32Array(size)
      for (let i = 0; i < size; i++) {
        depth[i] = world.terrain[i] === TERRAIN.WATER ? clamp(depthDistance[i] / 16, 0, 1) : 0
      }
      world.depth = depth
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
          if (Math.abs(plant.x - x) < 6 && Math.abs(plant.y - y) < 5) { crowded = true; break }
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
          seedTimer: randomBetween(world, 120, 260),
        })
      }
      seedAquaticPlants(world, Math.round(count * 0.22), Math.round(count * 0.14))
    }

    /**
     * Plant the shallows: lily pads in the water, reeds on the bank.
     *
     * These are not decoration. A lily pad raises the nutrients under it, so the
     * weed grows thicker there and the fish gather to graze; a reed bed does the
     * same for the bank and gives the shoreline a readable edge. Both live in
     * world.trees because they are the same kind of thing — a plant anchored to a
     * cell that other systems can query.
     * @param {object} world - the world.
     * @param {number} lilies - how many lily pads to aim for.
     * @param {number} reeds - how many reed clumps to aim for.
     */
    function seedAquaticPlants(world, lilies, reeds) {
      let placed = 0
      for (let attempt = 0; attempt < lilies * 40 && placed < lilies; attempt++) {
        const x = 2 + ((nextRandom(world) * (world.width - 4)) | 0)
        const y = 2 + ((nextRandom(world) * (world.height - 4)) | 0)
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== TERRAIN.WATER) continue
        // Only the shallows: a pad in the middle of the lake reads as a bug.
        if (world.depth[index] > 0.45) continue
        let crowded = false
        for (const plant of world.trees) {
          if (Math.abs(plant.x - x) < 5 && Math.abs(plant.y - y) < 5) { crowded = true; break }
        }
        if (crowded) continue
        world.trees.push({
          id: world.nextId++, x, y, variant: 'lily',
          size: 1, age: randomBetween(world, 10, 90), foliage: 1,
          seedTimer: randomBetween(world, 60, 140),
        })
        placed += 1
      }
      let reedCount = 0
      for (let attempt = 0; attempt < reeds * 40 && reedCount < reeds; attempt++) {
        const x = 2 + ((nextRandom(world) * (world.width - 4)) | 0)
        const y = 2 + ((nextRandom(world) * (world.height - 4)) | 0)
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== TERRAIN.SAND) continue
        let crowded = false
        for (const plant of world.trees) {
          if (Math.abs(plant.x - x) < 4 && Math.abs(plant.y - y) < 4) { crowded = true; break }
        }
        if (crowded) continue
        world.trees.push({
          id: world.nextId++, x, y, variant: 'reed',
          size: 1, age: randomBetween(world, 10, 90), foliage: 1,
          seedTimer: randomBetween(world, 50, 120),
        })
        reedCount += 1
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
        depth: new Float32Array(size),
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
      seedTrees(world, options.trees ?? 430)
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
    /**
     * A standing spot near an animal, or null when it is truly boxed in.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {number} x - origin column.
     * @param {number} y - origin row.
     * @param {number} radius - search radius in cells.
     * @returns {{x: number, y: number}|null} reachable spot.
     */
    function nearbyStand(world, species, x, y, radius) {
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const angle = nextRandom(world) * Math.PI * 2
        const distance = 1.5 + nextRandom(world) * radius
        const nx = clamp(x + Math.cos(angle) * distance, 0.5, world.width - 0.5)
        const ny = clamp(y + Math.sin(angle) * distance, 0.5, world.height - 0.5)
        if (canStand(world, species, nx, ny)) return { x: nx, y: ny }
      }
      return null
    }

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
      let wadeFactor = 1
      if (species.wade === true || species.amphibious === true) {
        const column = Math.max(0, Math.min(world.width - 1, Math.round(entity.x)))
        const row = Math.max(0, Math.min(world.height - 1, Math.round(entity.y)))
        const index = row * world.width + column
        const wet = world.terrain[index] === TERRAIN.WATER
        // Hauling out on the bank costs a water animal speed too: the water is
        // its home, the land is a place it visits.
        if (wet) wadeFactor = species.wade === true ? 0.62 : 1
        else if (species.amphibious === true) wadeFactor = 0.72
      }
      const pace = entity.genes.speed * multiplier * wadeFactor
        * (0.88 + 0.12 * Math.sin(world.time * 2.6 + entity.phase * 6.28))
      const stepX = Math.cos(entity.heading) * pace * dt
      const stepY = Math.sin(entity.heading) * pace * dt
      // Steer AROUND an obstacle instead of bouncing off it. The old code threw
      // away the heading and picked a random one on every blocked step, so an
      // animal whose target sat across a lake would aim at the water, get
      // blocked, spin, aim at the water again: that is the "pacing along the
      // shoreline forever" bug.
      let moved = false
      for (const offset of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
        const heading = entity.heading + offset
        const tryX = Math.cos(heading) * pace * dt
        const tryY = Math.sin(heading) * pace * dt
        if (!canStand(world, species, entity.x + tryX, entity.y + tryY)) continue
        entity.x += tryX
        entity.y += tryY
        // Face the way it actually travels, or a sliding animal reads as walking
        // sideways.
        if (offset !== 0) entity.heading = heading
        moved = true
        break
      }
      if (moved) {
        entity.stuck = 0
      } else {
        // Boxed in on every side. Shake loose toward a reachable spot close by
        // and drop the current target, so the next decision is not the same
        // unreachable patch on the far bank.
        entity.stuck = (entity.stuck ?? 0) + dt
        if (entity.stuck > 0.3) {
          entity.stuck = 0
          const spot = nearbyStand(world, species, entity.x, entity.y, 6)
          if (spot !== null) {
            entity.targetX = spot.x
            entity.targetY = spot.y
          }
        }
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
      // A starving animal searches further, not harder: nine samples inside its
      // eyesight almost never hit a patch when the meadow is patchy, which is
      // exactly why grazers used to stand in a meadow and starve.
      const hunger = needsOf(entity).hunger
      const radius = entity.genes.vision * (hunger > 0.4 ? 2.4 : 1)
      let best = null
      let bestScore = 0.05
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = nextRandom(world) * Math.PI * 2
        const distance = 1 + nextRandom(world) * radius
        const x = (entity.x + Math.cos(angle) * distance) | 0
        const y = (entity.y + Math.sin(angle) * distance) | 0
        const index = cellIndex(world, x, y)
        if (index < 0 || world.terrain[index] !== wanted) continue
        // A wader must not aim at a patch it cannot stand in: the frog used to
        // target deep water, drift to the bank and starve in sight of food.
        if (species.wade === true && wanted === TERRAIN.WATER && world.depth[index] > 0.34) continue
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
        if (plant.variant === 'lily' || plant.variant === 'reed') continue
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
        if (plant.variant === 'lily' || plant.variant === 'reed') continue
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
/**
 * Perception and belief: what an animal currently knows about its world.
 *
 * OWNER: behaviour
 * Scans the real neighbourhood (not random sampling) on a staggered ~1 Hz
 * schedule and writes belief entries with timestamps so they can go stale:
 *   belief.food   { x, y, t, value }
 *   belief.threat { x, y, t, predator }
 *   belief.water  { x, y, t }
 *   belief.home   { x, y }
 *   belief.caches [{ x, y, t }]
 * Contract: docs/20-CORE-LOOP.md section 2.3.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
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
 * The body: reserve, structure, maturity, health, fatigue, metabolism.
 *
 * OWNER: sim-core
 * Implements the DEB-lite equations in docs/20-CORE-LOOP.md section 4:
 *   metabolise(entity, dt)  -> consumes/produces body.E, body.V, body.M
 *   applyDamage(entity, amount, cause)
 * This is the single energy ledger. Nothing else may write body.E.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */

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
          const pull = anchor === null ? 0 : 0.12
          const x = patch.x + (anchor === null ? 0 : (anchor.x - patch.x) * pull)
          const y = patch.y + (anchor === null ? 0 : (anchor.y - patch.y) * pull)
          offer('forage', weights.hunger * (needs.hunger + 0.3), x, y)
        } else if (species.browse === true) {
          const plant = findFoliage(world, entity, genes.vision)
          if (plant !== null) offer('forage', weights.hunger * (needs.hunger + 0.06), plant.x, plant.y)
        }
      } else if (species.role === 'hunter') {
        // Predators work on scent as well as sight. With eyesight alone a fox
        // has a ~20% chance of a rabbit being in range on this map, so the whole
        // predator tier used to wander (explore 60%+) and starve at hunger 0.8.
        const reach = genes.vision * (species.huntReach ?? 2.6)
        const prey = nearestPrey(entity, species, grids.prey, reach)
        if (prey !== null) offer('hunt', weights.hunger * (needs.hunger + 0.25) * 1.7, prey.x, prey.y)
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision * 1.7)
        if (corpse !== null) offer('scavenge', weights.hunger * (needs.hunger - 0.1), corpse.x, corpse.y)
      } else {
        // Carrion is worth smelling from far off; a crow also patrols between
        // corpses instead of picking a random wander direction.
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision * 1.9)
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
          // Stand on a ring around the herd, not on the herd. Without this every
          // member of a herd walks to the exact same centroid and the meadow
          // fills with a pile of overlapping sprites. The golden angle gives each
          // animal its own stable slot in the ring.
          const separation = species.herd.separation ?? 3
          // Big animals need a bigger ring: a deer is six cells long, so a
          // six-cell ring still stacks them.
          const ring = separation + (species.genes.size?.[1] ?? 1) * 2.6
          const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
          const ringX = anchorPoint.x + Math.cos(angle) * ring
          const ringY = anchorPoint.y + Math.sin(angle) * ring * 0.75
          const crowd = entity.herdAnchor !== null
          offer('socialize', weights.social * (needs.social + (crowd ? 0.1 : 0.25)),
            clamp(ringX, 1, world.width - 2), clamp(ringY, 1, world.height - 2))
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
 * Execution: the state machine that turns a goal into timed action.
 *
 * OWNER: behaviour
 * States have a duration and a completion condition; decide() is only called at
 * state boundaries or on an interrupt. Interrupt priority:
 *   flee > survive (drink/warm) > opportunity (hunt/forage) > intrinsic (play/socialize)
 * Contract: docs/20-CORE-LOOP.md section 2.3.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */

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
            if (nextRandom(world) < 0.06) {
              const nibble = species.flora === 'weed' ? PALETTE.effect.nibble : PALETTE.effect.eat
              spawnEffect(world, entity.x, entity.y + 0.4, nibble, 0.3, 0.35)
            }
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
          // Nutrition extracted per kill. A rabbit is worth 18 energy as a
          // corpse, but a fox gets a whole meal out of it: without this factor a
          // fox had to kill every 20 seconds just to stay alive and the whole
          // predator tier starved at hunger 0.8.
          entity.energy += SPECIES[victim.species].meat * (balance.meatGain ?? 1)
          needs.hunger = clamp(needs.hunger - 0.85, 0, 1)
          const inWater = terrainAt(world, victim.x, victim.y) === TERRAIN.WATER
          if (inWater) {
            // A heron stabbing a fish or a bear swiping at one is a splash, not a
            // puff of red: the strike breaks the surface and the water answers.
            spawnEffect(world, victim.x, victim.y, PALETTE.effect.splash, 0.26, 1.9)
            spawnEffect(world, victim.x, victim.y, PALETTE.effect.splashDark, 0.3, 1.6)
            spawnEffect(world, victim.x, victim.y, PALETTE.effect.bubble, 0.55, 0.35, true)
          } else {
            for (let spark = 0; spark < 5; spark++) spawnEffect(world, victim.x, victim.y, PALETTE.effect.hunt, 0.42, 1.4)
          }
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
      // Animation phase from distance moved. Fish and birds also idle-animate so
      // a hovering fish keeps swimming instead of freezing mid-pixel.
      const travelled = Math.hypot(entity.x - entity.prevX, entity.y - entity.prevY)
      // Running is a decision made here, from the pace multiplier, not re-derived
      // from distance in the renderer: distance also carries the time-of-day
      // activity factor, so everything looked like it was running.
      entity.running = pace >= 1.25
      // A gallop covers more ground per stride than a walk, but legs still cycle
      // faster in real time; the cadence boost is what makes a chase read as fast.
      const gaitRate = (ATLAS_GAIT[entity.species] ?? 0.25) * (entity.running === true ? 1.45 : 1)
      const drift = species.habitat === 'water' || species.habitat === 'air' ? dt * 0.55 : 0
      entity.gait = ((entity.gait ?? 0) + travelled * gaitRate + drift) % 1
      // Personal space. Herds converge on a shared anchor, so without a small
      // repulsion a warren draws as a stack of sprites on one cell. It is a nudge,
      // not a collision system: 0.06 cells per tick is enough to unpile them.
      // Only while resting: pushing a foraging animal off its patch starves it,
      // and the pile only forms where animals stop.
      const kinGrid = species.role === 'hunter' ? grids.hunter : grids.prey
      const kin = entity.intent === 'rest'
        ? queryNearest(kinGrid, entity.x, entity.y, 1.5,
          candidate => candidate !== entity && candidate.species === entity.species && candidate.fate === '')
        : null
      if (kin !== null) {
        const awayX = entity.x - kin.x
        const awayY = entity.y - kin.y
        const apart = Math.hypot(awayX, awayY) || 1
        if (apart < 1.2) {
          const push = (1.2 - apart) * 0.035
          const nextX = entity.x + (awayX / apart) * push
          const nextY = entity.y + (awayY / apart) * push
          if (canStand(world, species, nextX, nextY)) {
            entity.x = nextX
            entity.y = nextY
          }
        }
      }
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
        if (plant.variant === 'lily' || plant.variant === 'reed') {
          // Feed the water (or the bank) under the plant so the producer field
          // actually grows where the plant is. This is what makes a lily pad a
          // fishing spot instead of a picture of one.
          const isLily = plant.variant === 'lily'
          const radius = isLily ? 3 : 2
          const enrich = isLily ? 0.06 : 0.04
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx * dx + dy * dy > radius * radius) continue
              const index = cellIndex(world, plant.x + dx, plant.y + dy)
              if (index < 0) continue
              if (isLily && world.terrain[index] === TERRAIN.WATER) {
                world.waterFertility[index] = Math.min(1, world.waterFertility[index] + dt * enrich)
              } else if (!isLily && world.terrain[index] === TERRAIN.GRASS) {
                world.fertility[index] = Math.min(1, world.fertility[index] + dt * enrich * 0.6)
              }
            }
          }
          plant.seedTimer -= dt
          if (plant.seedTimer > 0 || world.trees.length >= MAX_TREES) continue
          plant.seedTimer = randomBetween(world, 70, 160)
          const spread = isLily ? 7 : 5
          const x = clamp(Math.round(plant.x + randomBetween(world, -spread, spread)), 1, world.width - 2)
          const y = clamp(Math.round(plant.y + randomBetween(world, -spread, spread)), 1, world.height - 2)
          const index = cellIndex(world, x, y)
          if (index < 0) continue
          if (isLily ? world.terrain[index] !== TERRAIN.WATER || world.depth[index] > 0.45
            : world.terrain[index] !== TERRAIN.SAND) continue
          let crowded = false
          for (const other of world.trees) {
            if (Math.abs(other.x - x) < 4 && Math.abs(other.y - y) < 4) { crowded = true; break }
          }
          if (crowded) continue
          world.trees.push({
            id: world.nextId++, x, y, variant: plant.variant,
            size: 1, age: 0, foliage: 1, seedTimer: randomBetween(world, 70, 160),
          })
          continue
        }
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
        // A forest that doubles itself every minute fills the map in ten. Trees
        // spread slowly; the meadow keeps room for the herds.
        plant.seedTimer = isBush ? randomBetween(world, 70, 150) : randomBetween(world, 110, 240)
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
          seedTimer: randomBetween(world, 110, 240),
        })
      }
    }

    /**
     * Life under the surface: bubbles off the weed and the odd shimmer.
     *
     * Without this the lake is a flat blue rectangle with sprites on it. It is a
     * constant-cost decoration pass — a couple of random draws per tick, not a
     * scan of the water.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function spawnAmbientEffects(world, dt) {
      if (nextRandom(world) > dt * 2.2) return
      const entities = world.entities
      if (entities.length === 0) return
      const swimmer = entities[(nextRandom(world) * entities.length) | 0]
      if (swimmer === undefined) return
      if (SPECIES[swimmer.species]?.habitat !== 'water') return
      if (terrainAt(world, swimmer.x, swimmer.y) !== TERRAIN.WATER) return
      spawnEffect(world, swimmer.x + randomBetween(world, -0.6, 0.6), swimmer.y,
        PALETTE.effect.bubble, randomBetween(world, 0.5, 1.1), 0.25, true)
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
     * @param {boolean} [rise] - drift upward like a bubble instead of falling.
     */
    function spawnEffect(world, x, y, color, life = 0.35, spread = 0.6, rise = false) {
      if (world.effects.length > 260) world.effects.shift()
      world.effects.push({
        x,
        y,
        vx: randomBetween(world, -spread, spread),
        vy: rise ? randomBetween(world, -0.5, -1.4) : randomBetween(world, -spread, spread) - 0.2,
        life,
        maxLife: life,
        color,
        rise,
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
        // Bubbles accelerate upward and pop; sparks fall. One flag, not two systems.
        effect.vy += dt * (effect.rise === true ? -0.5 : 1.6)
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
      spawnAmbientEffects(world, step)
      stepEffects(world, step)
      handleImmigration(world, step)
      stepEntities(world, step)
    }

/**
 * Climate: sun angle, season phase, temperature.
 *
 * OWNER: sim-core
 * stepClimate(world, dt) writes world.climate: { t, dayPhase, yearPhase, temperature, sunlight }.
 * Everything that depends on time of day, season or temperature reads from here;
 * no other system may re-derive daylight.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */

/**
 * Trait cards: composable phenotype, compiled once per birth.
 *
 * OWNER: sim-core
 * A trait is data: { id, hooks: { metabolism, speed, ... }, params, upkeep }.
 * Phenotype = compilePhenotype(species, genes) evaluated at birth, never per tick.
 * Every trait pays upkeep in the energy ledger so no combo is free.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */

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
        } else if (terrain === TERRAIN.SAND || terrain === TERRAIN.DIRT) {
          // Damp ground right behind the bank grows weed too. It used to do
          // nothing at all outside water, which reads as "the water-weed brush is
          // broken": you click the shore next to the pond and the pond stays bare.
          world.weed[index] = Math.max(world.weed[index], 0.75)
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
        depth: new Float32Array(size),
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
          variant: ['bush', 'lily', 'reed'].includes(plant.variant) ? plant.variant : 'tree',
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
      // Depth ramp. Shallow water is bright and green-blue, the lake floor is
      // nearly navy: that gradient is what makes the lake read as water with a
      // bottom instead of a blue hole in the ground.
      waterSurface: rgb(112, 194, 210),
      waterShallow: rgb(72, 152, 182),
      waterMid: rgb(34, 100, 146),
      waterDeep: rgb(28, 76, 118),
      foam: rgb(210, 242, 248),
      caustic: rgb(150, 222, 232),
      weed: [rgb(64, 138, 104), rgb(96, 178, 124)],
      weedStalk: rgb(126, 210, 146),
      flowers: [rgb(244, 208, 96), rgb(232, 138, 172), rgb(198, 214, 236), rgb(186, 156, 236)],
      sand: [rgb(216, 198, 148), rgb(200, 180, 130), rgb(228, 212, 164)],
      dirt: [rgb(126, 100, 70), rgb(110, 86, 58), rgb(140, 112, 78)],
      stone: [rgb(126, 126, 134), rgb(108, 108, 118), rgb(146, 146, 154)],
      grassDry: [122, 118, 72],
      grassLush: [44, 104, 52],
      leaf: { dark: rgb(28, 68, 38), mid: rgb(46, 102, 50), light: rgb(82, 140, 68), outline: rgb(16, 38, 24) },
      trunk: rgb(96, 66, 42),
      trunkDark: rgb(64, 44, 28),
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
      // Water feedback: bubbles for anything that happens under the surface,
      // splash for a strike that breaks it.
      bubble: rgb(196, 238, 252),
      splash: rgb(178, 226, 244),
      splashDark: rgb(112, 178, 214),
      nibble: rgb(188, 240, 176),
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

    /** Plants: three tree sizes, a shrub, and the two aquatic plants. */
    const PLANT_SPRITES = {
      tree: [1, 2, 3].map(size => buildTreeSprite(size)),
      bush: buildBushSprite(),
      lily: [0, 1].map(variant => buildLilySprite(variant)),
      reed: buildReedSprite(),
    }

    /**
     * Build a sprite from a per-pixel painter.
     * @param {number} width - sprite width in pixels.
     * @param {number} height - sprite height in pixels.
     * @param {(x: number, y: number) => number} paint - returns 0 for transparent.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildSprite(width, height, paint) {
      const pixels = new Uint32Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const color = paint(x, y)
          if (color !== 0) pixels[y * width + x] = color
        }
      }
      return { width, height, pixels }
    }

    /**
     * A tree, drawn rather than hand-lettered so all three sizes share a shape.
     *
     * The canopy is three overlapping lobes with a hard dark rim, a lit top-left
     * and a shaded bottom. The rim is the whole point: a green blob on a green
     * meadow is invisible, a green blob with a near-black edge and a brown trunk
     * is a tree.
     * @param {number} size - 1, 2 or 3.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildTreeSprite(size) {
      const radius = [4.3, 6.0, 7.6][size - 1]
      const trunkHeight = [2, 2, 3][size - 1]
      const trunkWidth = size >= 3 ? 3 : 2
      const width = Math.ceil(radius * 2) + 3
      const canopyHeight = Math.ceil(radius * 1.85)
      const height = canopyHeight + trunkHeight + 1
      const cx = width / 2
      const cy = canopyHeight / 2
      const lobes = [
        [0, -radius * 0.1, radius * 0.82],
        [-radius * 0.5, radius * 0.3, radius * 0.62],
        [radius * 0.52, radius * 0.26, radius * 0.6],
        [0, radius * 0.34, radius * 0.56],
      ]
      const leaf = PALETTE.leaf
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of lobes) {
          const dx = px - (cx + offsetX)
          const dy = (py - (cy + offsetY)) / 0.92
          margin = Math.max(margin, lobeRadius - Math.hypot(dx, dy))
        }
        if (margin > 0) {
          // Light comes from the top left: -dx -dy is brightest up and left.
          const lit = -(px - cx) / radius * 0.55 - (py - cy) / radius * 0.85
          if (margin < 1.15) return leaf.outline
          if (lit > 0.34) return leaf.light
          if (lit < -0.1) return leaf.dark
          return ((x * 5 + y * 3) & 15) < 5 ? leaf.light : leaf.mid
        }
        const trunkTop = canopyHeight - 2
        if (y >= trunkTop && y < trunkTop + trunkHeight + 1) {
          const offset = px - cx
          if (Math.abs(offset) <= trunkWidth / 2) {
            if (Math.abs(offset) > trunkWidth / 2 - 1) return PALETTE.trunkDark
            return PALETTE.trunk
          }
        }
        return 0
      })
    }

    /**
     * A shrub: the tree canopy without a trunk, so the meadow reads as layers.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBushSprite() {
      const radius = 3.1
      const width = Math.ceil(radius * 2) + 2
      const height = Math.ceil(radius * 1.9) + 1
      const cx = width / 2
      const cy = height / 2
      const leaf = PALETTE.leaf
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of [[0, 0, radius * 0.78], [-radius * 0.55, radius * 0.2, radius * 0.55], [radius * 0.55, radius * 0.16, radius * 0.55]]) {
          margin = Math.max(margin, lobeRadius - Math.hypot(px - (cx + offsetX), (py - (cy + offsetY)) / 0.9))
        }
        if (margin <= 0) return y === height - 1 && Math.abs(px - cx) < 1.2 ? PALETTE.trunkDark : 0
        const lit = -(px - cx) / radius * 0.5 - (py - cy) / radius * 0.9
        if (margin < 1.05) return leaf.outline
        if (lit > 0.3) return leaf.light
        if (lit < -0.15) return leaf.dark
        return ((x * 3 + y * 5) & 15) < 5 ? leaf.light : leaf.mid
      })
    }

    /**
     * A lily pad: flat, notched, floating. The second variant carries a flower,
     * which is the cheapest way to make a pond look alive from a distance.
     * @param {number} variant - 0 plain, 1 flowering.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildLilySprite(variant) {
      const width = 10
      const height = variant === 1 ? 7 : 5
      const cy = height - 2
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        const dx = (px - width / 2) / 4.4
        const dy = (py - cy) / 2.1
        if (dx * dx + dy * dy <= 1) {
          if (x >= 5 && y <= cy - 1) return 0
          if (py < cy - 0.6) return PALETTE.weedStalk
          if (py > cy + 0.8) return PALETTE.leaf.dark
          return PALETTE.weed[1]
        }
        if (variant === 1 && y <= 2 && Math.abs(px - width / 2) < 1.6) {
          return y === 0 ? PALETTE.flowers[1] : PALETTE.flowers[3]
        }
        return 0
      })
    }

    /**
     * A reed clump: three stalks leaning out of the shallows.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildReedSprite() {
      const width = 9
      const height = 11
      return buildSprite(width, height, (x, y) => {
        const stalk = (baseX, lean, top) => {
          const t = 1 - y / top
          const spanX = baseX + lean * (1 - t) * (1 - t)
          return Math.abs(x + 0.5 - spanX) < 0.62
        }
        if (stalk(3, -1.6, 10) || stalk(5.5, 0.4, 9) || stalk(7.2, 1.8, 7)) {
          // A reed is olive, not teal: the teal read as a weed stalk in the water.
          return y < 2 ? PALETTE.trunkDark : (y < 5 ? PALETTE.leaf.light : PALETTE.leaf.mid)
        }
        if (y >= height - 2 && Math.abs(x + 0.5 - 5) < 2.4) return PALETTE.leaf.dark
        return 0
      })
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

    /** PNG atlas: 8 columns of 64x59 cells, bottom-aligned creatures. */
    const SPRITE_ATLAS_PNG = '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'
                                                                                                                                            /** Atlas geometry: one cell per animation frame, feet on the baseline. */
    const ATLAS = { cellWidth: 64, cellHeight: 59, columns: 8, baseline: 52 }
    /** Frame slot list per species: two idle frames and a four-frame gait cycle. */
    const ATLAS_SLOTS = {
      rabbit: { idle: [0, 1], walk: [2, 3, 4, 5], run: [6, 7, 8, 9] },
      deer: { idle: [10, 11], walk: [12, 13, 14, 15], run: [16, 17, 18, 19] },
      fox: { idle: [20, 21], walk: [22, 23, 24, 25], run: [26, 27, 28, 29] },
      wolf: { idle: [30, 31], walk: [32, 33, 34, 35], run: [36, 37, 38, 39] },
      bear: { idle: [40, 41], walk: [42, 43, 44, 45], run: [46, 47, 48, 49] },
      otter: { idle: [50, 51], walk: [52, 53, 54, 55], run: [56, 57, 58, 59] },
      frog: { idle: [60, 61], walk: [62, 63, 64, 65], run: [66, 67, 68, 69] },
      crow: { idle: [70, 71], run: [72, 73, 74, 75] },
      heron: { idle: [76, 77], walk: [78, 79, 80, 81], run: [82, 83, 84, 85] },
      fish: { idle: [86, 87], run: [88, 89, 90, 91] },
      pike: { idle: [92, 93], run: [94, 95, 96, 97] },
    }
    /** Display size of each species relative to the atlas cell at 6x zoom. */
    const ATLAS_SIZE = {
      rabbit: 0.7777777777777778,
      deer: 1.0232558139534884,
      fox: 0.9230769230769231,
      wolf: 1.1111111111111112,
      bear: 1,
      otter: 0.8095238095238095,
      frog: 0.6,
      crow: 0.72,
      heron: 0.75,
      fish: 0.62,
      pike: 0.75,
    }
    /** Gait cycles per cell travelled: a hop is short, a wolf stride is long. */
    const ATLAS_GAIT = {
      rabbit: 0.34,
      deer: 0.2,
      fox: 0.28,
      wolf: 0.2,
      bear: 0.17,
      otter: 0.26,
      frog: 0.5,
      crow: 0.3,
      heron: 0.22,
      fish: 0.42,
      pike: 0.34,
    }

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
      const moved = animal.prevX === undefined ? 0 : Math.hypot(animal.x - animal.prevX, animal.y - animal.prevY)
      if (moved < 0.06) return 'idle'
      const slots = ATLAS_SLOTS[animal.species]
      if (slots === undefined || slots.walk === undefined) return 'run'
      if (animal.fleeing === true) return 'run'
      // The engine already decided the gait from the pace multiplier (1 = walk,
      // 1.25+ = chase or flight). Re-deriving it from distance here made every
      // animal run all day, because distance is scaled by the time-of-day factor.
      return animal.running === true ? 'run' : 'walk'
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
      for (const { animal, x, y } of visible) drawAtlasAnimal(context, world, view, animal, x, y)
      context.restore()
    }

    /**
     * Paint one animal from the atlas at display resolution.
     * @param {CanvasRenderingContext2D} context - display context.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {object} animal - the animal.
     * @param {number} x - interpolated world column.
     * @param {number} y - interpolated world row.
     * @returns {void}
     */
    function drawAtlasAnimal(context, world, view, animal, x, y) {
      const scale = view.scale
        const baseScale = scale / 6
        const time = world.time ?? 0
        const slots = ATLAS_SLOTS[animal.species]
        if (slots === undefined) return
        const role = atlasFrameRole(animal)
        const frames = slots[role] ?? slots.run ?? slots.idle
        // The gait phase is accumulated from distance travelled, so the feet are
        // planted on the ground instead of skating: a slow animal takes slow
        // steps and a fleeing one takes fast ones, without a speed if-chain.
        const gait = animal.gait ?? 0
        const frame = role === 'run'
          ? frames[Math.min(frames.length - 1, Math.floor(gait * frames.length))]
          : frames[Math.floor(time * 1.15 + (animal.phase ?? 0) * 3) % frames.length]
        const slot = frame
        const column = slot % ATLAS.columns
        const row = Math.floor(slot / ATLAS.columns)
        const stageScale = STAGE_SCALE[animal.stage ?? 'adult'] ?? 1
        const size = ATLAS_SIZE[animal.species] * baseScale * stageScale
        // Gallop rhythm: a running animal rises and falls and stretches in step.
        const running = role === 'run'
        const gaitPhase = running ? gait * Math.PI * 2 : 0
        const bob = running ? Math.sin(gaitPhase) * 0.07 * ATLAS.cellHeight * size : 0
        const stretch = running ? 1 + Math.sin(gaitPhase + Math.PI / 2) * 0.04 : 1
        const drawWidth = ATLAS.cellWidth * size * stretch
        const drawHeight = ATLAS.cellHeight * size / stretch
        const screenX = (x - view.x) * scale
        const screenY = (y - view.y) * scale + bob
        const left = screenX - drawWidth / 2
        const top = screenY - ATLAS.baseline * size - (drawHeight - ATLAS.cellHeight * size)
        const speciesRow = SPECIES[animal.species]
        context.save()
        if (speciesRow !== undefined && speciesRow.habitat === 'water') {
          // A ground shadow under a fish makes it read as hovering in mid air.
          // Water animals get a ripple ring instead, and sit a little higher.
          context.strokeStyle = 'rgba(214, 246, 255, 0.38)'
          context.lineWidth = Math.max(1, size * 0.9)
          context.beginPath()
          context.ellipse(screenX, screenY - size * 2, ATLAS.cellWidth * size * 0.24,
            ATLAS.cellHeight * size * 0.085, 0, 0, Math.PI * 2)
          context.stroke()
        } else {
          // A soft shadow on the ground anchors the creature; without it a sprite
          // reads as a sticker pasted on the meadow.
          context.fillStyle = 'rgba(10, 22, 14, 0.22)'
          context.beginPath()
          context.ellipse(screenX, screenY + 1, ATLAS.cellWidth * size * 0.3, ATLAS.cellHeight * size * 0.09, 0, 0, Math.PI * 2)
          context.fill()
        }
        context.restore()
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


    /** Offscreen canvases for plant sprites: built once, drawn many times. */
    const plantCanvasCache = new Map()

    /**
     * Turn a 1-px-per-cell sprite into a drawable canvas.
     * @param {object} sprite - sprite record.
     * @returns {HTMLCanvasElement|null} canvas, or null when there is no DOM.
     */
    function spriteToCanvas(sprite) {
      const cached = plantCanvasCache.get(sprite)
      if (cached !== undefined) return cached
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
      const canvas = document.createElement('canvas')
      canvas.width = sprite.width
      canvas.height = sprite.height
      const painter = canvas.getContext('2d')
      if (painter === null) return null
      const image = painter.createImageData(sprite.width, sprite.height)
      const words = new Uint32Array(image.data.buffer)
      for (let index = 0; index < sprite.pixels.length; index += 1) {
        const color = sprite.pixels[index]
        if (color !== 0) words[index] = color
      }
      painter.putImageData(image, 0, 0)
      plantCanvasCache.set(sprite, canvas)
      return canvas
    }

    /**
     * Paint one plant sprite at display resolution.
     * @param {CanvasRenderingContext2D} context - display context.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {object} plant - the plant.
     * @returns {void}
     */
    function drawPlantSprite(context, world, view, plant) {
      const set = PLANT_SPRITES[plant.variant] ?? PLANT_SPRITES.tree
      const sprite = Array.isArray(set) ? set[clamp(plant.size, 1, set.length) - 1] : set
      if (sprite === undefined) return
      const canvas = spriteToCanvas(sprite)
      if (canvas === null) return
      const scale = view.scale
      const swayX = (((world.tick >> 3) + plant.id) % 16 < 8) ? 0 : 1
      const left = Math.round((plant.x - view.x - sprite.width / 2 + swayX) * scale)
      const top = Math.round((plant.y - view.y - sprite.height + 1) * scale)
      const drawWidth = sprite.width * scale
      const drawHeight = sprite.height * scale
      if (plant.variant !== 'lily' && sprite.width > 4) {
        context.save()
        context.fillStyle = 'rgba(10, 22, 14, 0.20)'
        context.beginPath()
        context.ellipse(left + drawWidth * 0.5, top + drawHeight - 1,
          drawWidth * 0.4, Math.max(1.5, drawWidth * 0.13), 0, 0, Math.PI * 2)
        context.fill()
        context.restore()
      }
      context.save()
      if ((plant.foliage ?? 1) < 0.35) context.globalAlpha = 0.85
      context.drawImage(canvas, left, top, drawWidth, drawHeight)
      context.restore()
    }

    /**
     * One depth-sorted pass over plants and animals.
     *
     * This is the fix for "the trees are made of glass": plants used to be
     * painted into the 1-px ground buffer and every animal was then drawn on top
     * of the whole forest, so nothing could ever be hidden behind a canopy.
     * Sorting both by their base row puts a nearer tree in front of a farther
     * animal, which is what the scene needs to read as 3D.
     * @param {CanvasRenderingContext2D} context - display context.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {number} alpha - interpolation between the last two ticks.
     * @returns {void}
     */
    function drawDepthLayers(context, world, view, alpha) {
      const layers = []
      for (const plant of world.trees) {
        if (plant.x < view.x - 14 || plant.x > view.x + view.width + 14) continue
        if (plant.y < view.y - 34 || plant.y > view.y + view.height + 10) continue
        layers.push({ y: plant.y, plant })
      }
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 12 || x > view.x + view.width + 12) continue
        if (y < view.y - 14 || y > view.y + view.height + 8) continue
        layers.push({ y, animal, x })
      }
      layers.sort((a, b) => a.y - b.y)
      context.save()
      context.imageSmoothingEnabled = false
      for (const layer of layers) {
        if (layer.plant !== undefined) drawPlantSprite(context, world, view, layer.plant)
        else drawAtlasAnimal(context, world, view, layer.animal, layer.x, layer.y)
      }
      context.restore()
    }

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

    /**
     * 16x16 cell hash, used as the texture noise everywhere.
     *
     * It must be a real hash, not an arithmetic ramp: x*73 + y*151 + x*y*17 has
     * strong diagonal structure and prints a visible grid over the whole meadow.
     * The avalanche mix below has no periodic component.
     */
    const DITHER = (() => {
      const table = new Uint8Array(256)
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          let hash = Math.imul(x * 374761393 + y * 668265263 + 1442695040, 1274126177)
          hash ^= hash >>> 15
          hash = Math.imul(hash, 1103515245)
          table[y * 16 + x] = (hash >>> 16) & 255
        }
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
      const depth = world.depth
      const time = world.tick * 0.05
      for (let row = 0; row < view.height; row++) {
        const worldY = view.y + row
        const rowBase = worldY * world.width
        const outBase = row * view.width
        for (let col = 0; col < view.width; col++) {
          const worldX = view.x + col
          const index = rowBase + worldX
          const surface = terrain[index]
          const noise = ditherAt(worldX, worldY)
          let color
          if (surface === TERRAIN.WATER) {
            color = waterColor(worldX, worldY, depth[index], time, noise)
            const cover = weed[index]
            if (cover > 0.05) {
              const lush = cover > 0.55
              const shade = SWAY[(worldX + (world.tick >> 3)) & 15]
              color = blendColor(color, PALETTE.weed[lush ? 1 : 0], Math.min(0.82, cover * 1.05))
              // A bright stalk every few cells turns a flat green wash into
              // something that reads as plants growing off the bottom.
              if (cover > 0.34 && noise > 168) color = blendColor(color, PALETTE.weedStalk, 0.5)
              else if (cover > 0.2 && shade > 2) color = nudgeColor(color, 5)
            }
          } else if (surface === TERRAIN.SAND || surface === TERRAIN.DIRT) {
            color = surface === TERRAIN.SAND
              ? nudgeColor(PALETTE.sand[noise > 200 ? 2 : 0], noiseAt(noise))
              : nudgeColor(PALETTE.dirt[noise > 205 ? 2 : 0], noiseAt(noise))
            // Damp weed on the bank has to be visible, or painting it looks
            // like nothing happened.
            const damp = weed[index]
            if (damp > 0.3) color = blendColor(color, PALETTE.weed[1], Math.min(0.5, damp * 0.55))
          } else if (surface === TERRAIN.STONE) {
            color = nudgeColor(PALETTE.stone[noise > 198 ? 2 : 1], noiseAt(noise))
          } else {
            const cover = grass[index]
            const step = cover <= 0 ? 0 : Math.min(7, (cover * 8) | 0)
            const sway = SWAY[((worldX * 5 + worldY * 11) + (world.tick >> 2)) & 15]
            // Two scales of variation: a cell-level flicker (blades) and a slow
            // field (patches of drier and lusher ground). Without the slow one
            // the meadow is one flat green sheet.
            const patch = Math.round(Math.sin(worldX * 0.055 + 0.7) * Math.sin(worldY * 0.043 - 1.1) * 7)
            color = nudgeColor(GRASS_RAMP[step], sway + patch + (noise < 48 ? 3 : 0))
            // Grass gets texture the way a real pixel meadow does: a scattering
            // of brighter blades and the odd flower on the thickest cells. This
            // is what separates "grass" from "green floor" at 6x zoom.
            if (cover > 0.3 && (noise & 63) < 3) color = nudgeColor(color, 12)
            else if (cover > 0.55 && (noise & 255) < 2) color = PALETTE.flowers[(worldX * 3 + worldY * 5) & 3]
            else if (cover < 0.08 && (noise & 63) === 5) color = blendColor(color, PALETTE.dirt[0], 0.5)
          }
          out[outBase + col] = color
        }
      }
    }

    /**
     * One cell of open water.
     *
     * Depth gives the lake a floor, the two crossed sine bands are the caustics
     * the sun throws onto it, and the last two bands of shallow water get foam so
     * the shoreline has a drawn edge instead of a colour change.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} depthValue - 0 at the bank, 1 at the deepest point.
     * @param {number} time - seconds, for the caustic drift.
     * @param {number} noise - 0..255 cell hash.
     * @returns {number} packed colour.
     */
    function waterColor(x, y, depthValue, time, noise) {
      const d = depthValue ?? 0
      let color = blendColor(PALETTE.waterSurface, PALETTE.waterShallow, Math.min(1, d * 5))
      color = blendColor(color, PALETTE.waterMid, clamp(d * 2.1, 0, 1))
      color = blendColor(color, PALETTE.waterDeep, Math.min(0.88, clamp((d - 0.28) * 1.9, 0, 1)))
      // Caustics: two travelling waves multiplied together give moving patches
      // rather than a plaid pattern.
      // Three terms, not two: the product of two sines is a lattice and prints a
      // visible grid over the whole lake. The third breaks the symmetry.
      const wave = Math.sin(x * 0.31 + y * 0.17 + time * 1.9) * Math.sin(x * 0.13 - y * 0.41 - time * 1.3)
        + 0.45 * Math.sin(x * 0.07 - y * 0.09 + time * 0.7)
      if (wave > 0.38) color = blendColor(color, PALETTE.caustic, Math.min(0.36, (wave - 0.38) * 0.5))
      // A second, finer ripple: the first band alone reads as a still puddle.
      if (((x * 3 + y * 5 + Math.round(time * 6)) & 15) < 2 && (d > 0.1)) color = blendColor(color, PALETTE.foam, 0.12)
      if (d < 0.055) color = blendColor(color, PALETTE.foam, 0.72)
      else if (d < 0.11) color = blendColor(color, PALETTE.foam, 0.3)
      else if (d < 0.16 && noise > 210) color = blendColor(color, PALETTE.foam, 0.22)
      // Dither by hand: nudgeColor takes integer channel deltas.
      return nudgeColor(color, noise < 60 ? -6 : (noise > 196 ? 6 : 0))
    }

    /**
     * Plants pass, sorted far→near so canopies overlap correctly.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintPlants(world, view, out) {
      const visible = []
      const margin = 16
      for (const plant of world.trees) {
        if (plant.x < view.x - margin || plant.x > view.x + view.width + margin) continue
        if (plant.y < view.y - margin - 10 || plant.y > view.y + view.height + margin) continue
        visible.push(plant)
      }
      visible.sort((a, b) => a.y - b.y)
      const tick = world.tick
      for (const plant of visible) {
        const set = PLANT_SPRITES[plant.variant] ?? PLANT_SPRITES.tree
        const sprite = Array.isArray(set) ? set[clamp(plant.size, 1, set.length) - 1] : set
        if (sprite === undefined) continue
        const baseX = Math.round(plant.x - view.x)
        const baseY = Math.round(plant.y - view.y)
        const swayX = ((tick >> 3) + plant.id) % 16 < 8 ? 0 : 1
        // Three shades keyed off the plant id: a forest of one identical stamp
        // reads as wallpaper, three shades read as a forest.
        const shade = [0.93, 1, 1.07][plant.id % 3]
        const factor = (plant.foliage ?? 1) < 0.35 ? 0.84 * shade : shade
        // A shadow anchors the plant to the ground; without it a canopy looks
        // like it is floating above the meadow.
        if (plant.variant !== 'lily') {
          shadeEllipse(out, view, baseX, baseY + 1,
            Math.max(2, sprite.width * 0.44), Math.max(1.3, sprite.width * 0.19))
        }
        drawSprite(out, view.width, view.height, sprite,
          baseX - (sprite.width >> 1) + swayX, baseY - sprite.height + 1, false, factor)
      }
    }

    /**
     * Darken a soft ellipse of ground pixels, for plant and creature shadows.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} view - viewport.
     * @param {number} cx - centre column in buffer space.
     * @param {number} cy - centre row in buffer space.
     * @param {number} rx - radius x.
     * @param {number} ry - radius y.
     */
    function shadeEllipse(out, view, cx, cy, rx, ry) {
      const spanX = Math.ceil(rx)
      const spanY = Math.ceil(ry)
      for (let dy = -spanY; dy <= spanY; dy++) {
        for (let dx = -spanX; dx <= spanX; dx++) {
          const nx = dx / rx
          const ny = dy / ry
          const distance = nx * nx + ny * ny
          if (distance > 1) continue
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
          const index = y * view.width + x
          // Two steps instead of one: a single flat ellipse reads as a painted
          // rectangle at the sizes trees have here.
          out[index] = dimColor(out[index], distance > 0.5 ? 0.86 : 0.72)
        }
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
     * Animals pass, with motion interpolation and the low-resolution gait frames.
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
      const plantsInBuffer = options === null || options.plants !== false
      paintGround(world, view, out)
      if (plantsInBuffer) paintPlants(world, view, out)
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
        }, { sprites: !useAtlas, plants: !useAtlas })
        const canvasWidth = view.width * (offscreenContext === null ? 1 : scale)
        const canvasHeight = view.height * (offscreenContext === null ? 1 : scale)
        if (offscreenContext !== null) {
          // Ground: 1 px per cell, upscaled with nearest neighbour.
          offscreenContext.putImageData(imageData, 0, 0)
          context.imageSmoothingEnabled = false
          context.drawImage(offscreen, 0, 0, view.width, view.height, 0, 0, canvasWidth, canvasHeight)
          // Plants and animals share one depth-sorted pass so a tree in front of
          // an animal actually covers it.
          if (useAtlas) drawDepthLayers(context, world, view, alpha)
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
      'species.heron': '苍鹭',
      'species.otter': '水獭',
      'species.bear': '棕熊',
      'species.frog': '青蛙',
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
      'species.heron': 'Heron',
      'species.otter': 'Otter',
      'species.bear': 'Bear',
      'species.frog': 'Frog',
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
    // Every species in SPECIES must appear here or the player cannot place it.
    // The palette is generated from SPECIES_IDS for exactly that reason: a new
    // species row used to be visible in the counters but missing from the tools.
    const LIFE_TOOLS = ['grass', 'weed', 'tree', 'bush', ...SPECIES_IDS]
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
      ATLAS,
      ATLAS_SLOTS,
      ATLAS_SIZE,
      ATLAS_GAIT,
      SPRITE_ATLAS_PNG,
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
      canStand,
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