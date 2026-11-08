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
    const STORAGE_KEY = 'dsh-pixel-ecosystem:v2'
    /**
     * Key the 0.2.x build used. v2 never writes it, so an old world survives a
     * version bump instead of being overwritten by the first autosave; the store
     * reads it once to tell the player why their old world is gone.
     */
    const LEGACY_STORAGE_KEY = 'dsh-pixel-ecosystem:v1'
    /**
     * Serialized world format version.
     *
     * 1 = the 0.2.x format (a 0..1 biomass scalar, a single `energy` number per
     * animal and no psychology). 2 = the energy ledger: `body` (reserve,
     * structure, maturity), drives, the behaviour state machine, belief, the
     * climate and the per-cell nutrient / detritus pools (docs/20-CORE-LOOP.md
     * section 5). There is no v1 -> v2 migration: a v2 build reads a v1 save as
     * unsupported and starts a fresh world, which the store must report to the
     * player instead of silently discarding it.
     */
    const SAVE_VERSION = 2

    // ---------------------------------------------------------------------
    // World constants
    // ---------------------------------------------------------------------
    //
    // Units (docs/10-SCALE-AND-UNITS.md): energy is kJ, plant biomass is kg of
    // dry matter, animal body mass is kg wet weight, and every rate is stored
    // PER IN-WORLD DAY. One in-world day is DAY_SECONDS of 1x time, so a rate
    // in kJ/day becomes `rate * dt / DAY_SECONDS` for a step of `dt` seconds.
    // Rates are never written "per second" anywhere below the climate layer:
    // one table, one unit, and species numbers stay comparable.

    /** Default world size in cells (one cell = one pixel in the canvas buffer). */
    const GRID_W = 1024
    const GRID_H = 640
    /** Edge of one cell in metres; a cell therefore covers CELL_AREA square metres. */
    const CELL_M = 2
    const CELL_AREA = CELL_M * CELL_M
    /** Fixed simulation step. Callers slice real time into these. */
    const TICK = 0.1
    /** One in-world day, in seconds of 1x time. */
    const DAY_SECONDS = 90
    /** Ticks in one in-world day: the divisor that turns per-day rates per tick. */
    const TICKS_PER_DAY = Math.round(DAY_SECONDS / TICK)
    /** In-world days per ecological year (the season cycle). */
    const YEAR_DAYS = 8
    /**
     * One ecological year in seconds. Every life-history number in the species
     * table is authored in YEARS and divided by this, so a change to the day
     * length cannot silently turn a rabbit into a mayfly again.
     */
    const YEAR_SECONDS = YEAR_DAYS * DAY_SECONDS
    /** Global ceiling on animals; per-species caps do the real limiting. */
    const MAX_ENTITIES = 3600
    const MAX_TREES = 2900
    const MAX_CORPSES = 260

    /**
     * The biological constant table.
     *
     * Everything that converts a body mass, a temperature or a photon into
     * energy lives here exactly once. `kappa` (world productivity) is the only
     * free "make the world richer" knob, and it is the one the player sees as a
     * power setting, so no species number has to be retuned to balance the map.
     *
     * Sources are quoted per row because these are the numbers the whole model
     * hangs off; a silent edit here silently rebases every species.
     */
    const BIO = {
      // --- field metabolic rate (Nagy, Girard & Brown 1999) ----------------
      /** Mammal allometry: FMR = a * bodyMass_g ^ b, kJ per in-world day. */
      FMR_MAMMAL_A: 4.82,
      FMR_MAMMAL_B: 0.734,
      /** Bird allometry (same paper, passerine-ish include). */
      FMR_BIRD_A: 10.5,
      FMR_BIRD_B: 0.681,
      /** Ectotherms (fish, amphibians) run far below the endotherm line. */
      FMR_ECTO_A: 0.6,
      FMR_ECTO_B: 0.75,
      // --- digestion -------------------------------------------------------
      /** Assimilated fraction of gross intake: herbage vs animal tissue. */
      ASSIMILATION_HERBIVORE: 0.4,
      ASSIMILATION_CARNIVORE: 0.8,
      /** Digestive loss (faeces) is (1 - assimilation) and goes to detritus. */
      // --- metabolism vs temperature --------------------------------------
      /** Metabolic rate multiplier per 10 C. */
      Q10: 2.5,
      /** Reference temperature the allometries are quoted at. */
      Q10_REFERENCE_C: 20,
      // --- plants ----------------------------------------------------------
      /** Beer-Lambert canopy extinction coefficient. */
      LIGHT_EXTINCTION: 0.5,
      /** Leaf area per kg of dry leaf matter, m^2/kg; sets the self-shading. */
      LEAF_AREA_PER_KG: 5,
      /** Woody canopy leaf area index: a full tree shades its whole footprint. */
      TREE_LAI: 2.2,
      BUSH_LAI: 1.2,
      /** Energy content of dry plant matter, kJ/kg. */
      GRASS_ENERGY: 17500,
      // --- animals ---------------------------------------------------------
      /** DEB fraction of surplus power that becomes structure (not reserve). */
      KAPPA_DEB: 0.8,
      /**
       * Reserve buffer, in days of field metabolic rate.
       *
       * Real animals carry 5-10 days of fat, but a fat animal is a slow animal
       * to reproduce: at 5 days it takes five game-days of surplus to fill the
       * tank, and the player watches an empty world for ten minutes. Three days
       * is still a real body-fat figure for a small mammal and it keeps the
       * first generation inside one watching session.
       */
      RESERVE_DAYS: 4,
      /**
       * Energy cost of one kg of new wet tissue (structure growth), kJ. It MUST
       * equal MEAT_ENERGY: growth then moves energy from the reserve into the
       * structure without creating or destroying any, which is what makes the
       * world's energy book close exactly.
       */
      STRUCTURE_COST: 7000,
      /** Share of the parent's energy that becomes offspring tissue (rest: heat). */
      REPRODUCTION_EFFICIENCY: 0.8,
      /** Edible share of a body's wet mass when something eats it. */
      MEAT_FRACTION: 0.7,
      /** Energy content of animal tissue, kJ/kg wet. */
      MEAT_ENERGY: 7000,
      // --- survival --------------------------------------------------------
      /** Health lost per in-world day with an empty reserve. */
      STARVE_HEALTH_RATE: 0.9,
      /** Health regained per in-world day when fed and warm. */
      HEAL_HEALTH_RATE: 0.55,
      /** Health lost per in-world day at the cold limit. */
      COLD_HEALTH_RATE: 0.7,
      /** Reserve fraction below which cold starts to hurt. */
      COLD_RESERVE_FLOOR: 0.25,
      /** Health lost per in-world day from untreated injury (predation escape). */
      INJURY_HEALTH_RATE: 0.35,
    }

    /**
     * Plant production parameters, per species of producer.
     *
     * A producer cell is a tiny ecosystem: gross primary production is limited by
     * the light that reaches it (Beer-Lambert through its own canopy and through
     * the trees above it), by water, and by soil nutrient; respiration and litter
     * fall remove it again. The equilibrium standing crop therefore EMERGES and
     * varies from cell to cell, which is what gives a grazer somewhere to walk to.
     */
    const PRODUCERS = {
      grass: {
        /** Dry mass at which the cell is treated as "full", kg/m^2. */
        bmax: 1.4,
        /**
         * Potential relative growth, per in-world day.
         *
         * This is the world's productivity dial: a grazed sward regrows at a
         * rate that sets how many herbivores the map can carry, and therefore
         * how many predators the food web can carry one step up. Raised from 26
         * so a realistic predator tier fits inside the measured prey production
         * (tools/calibrate.mjs); the standing crop still EMERGES, it is not set.
         */
        mu: 40.0,
        /** Seed bank / basal meristem floor, kg/m^2: what regrows from bare soil. */
        seed: 0.04,
        /** Respiration loss, per in-world day, fraction of standing crop. */
        resp: 0.28,
        /** Litter fall, per in-world day, fraction of standing crop. */
        litter: 0.42,
        /** Water saturation where growth halves. */
        waterHalf: 0.3,
        /** Nutrient saturation where growth halves (0..1 soil index). */
        nutrientHalf: 0.35,
      },
      weed: {
        bmax: 0.9,
        mu: 18.0,
        seed: 0.03,
        resp: 0.30,
        litter: 0.40,
        waterHalf: 0.1,
        nutrientHalf: 0.3,
      },
    }

    /**
     * Detritus: corpses, dung and litter waiting to be mineralised back into the
     * soil index. Mass is tracked in kg/m^2 of dry matter, energy in kJ.
     */
    const DETRITUS = {
      /** Mineralisation rate, per in-world day, fraction of the pool. */
      mineralise: 1.6,
      /** Hard cap so a mass mortality cannot blow up the field, kg/m^2. */
      bmax: 6,
      /** Nutrient added to the soil index per kg/m^2 of mineralised matter. */
      nutrientPerKg: 0.55,
      /** Nutrient demand of production per kg/m^2 of new plant matter. */
      nutrientPerGrowth: 0.35,
    }

    /**
     * Global tuning knobs that are not per species. Exported through
     * `module.exports.__engine` so the soak probe can explore them without
     * editing the bundle.
     *
     * `productivity` is kappa from the design docs: the one intended dial. It
     * scales plant production only; animals inherit the change through the food
     * they can find, which is the whole point of a ledger.
     */
    const TUNING = {
      /** kappa: world productivity multiplier on plant production. */
      productivity: 1,
      /** Seconds between immigration checks (min, max). */
      immigration: [25, 45],
      /**
       * Seconds a carcass takes to rot away completely.
       *
       * A 2 kg carcass does not vanish in 42 in-world seconds: it is a larder
       * for every scavenger on the map (crow, fox, bear, and any hunter that
       * cannot find live prey). 42 s kept the scavenger guild permanently just
       * short of its breeding reserve, so carrion feeders never reproduced.
       */
      corpseSeconds: 90,
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
    // prey     species ids a hunter will chase; [] for anything that does not
    //          hunt, so no caller has to guess and no guard has to hide a gap
    // mass     adult body mass, kg WET. This is the single number the whole
    //          energy model hangs off: metabolic rate, reserve capacity, what a
    //          carcass is worth and how big the animal reads on screen all come
    //          from it (see BIO in 01-constants and docs/10-SCALE-AND-UNITS.md).
    // taxon    mammal | bird | ectotherm — picks the field-metabolic-rate curve.
    // cap      per-species population ceiling (stops one species monopolising
    //          the global entity budget; 0 would mean "no local cap")
    // minimum  below this an immigration event refills the species
    // color    chip/legend colour (the sprite has its own palette)
    //
    // `balance` keeps the per-species DESIGN choices (how fast it matures, how
    // many in a litter, how close it must get to bite). Everything that physics
    // dictates — reserve size, breeding reserve, travelling cost — is DERIVED at
    // the bottom of this file and written back into `balance`, so no species row
    // can quietly disagree with the allometry.

    // Field data behind the numbers below (see DESIGN.md §2 for the mapping):
    // - European rabbit: 2 kg, colonies of up to ~30 in warrens, sprint ~45 km/h,
    //   maturity ~3-4 months, litters of 4-12 several times a year, wild
    //   lifespan 1-3 years, crepuscular (dawn/dusk peaks).
    //   https://scottishwildlifetrust.org.uk/species/rabbit-european/
    // - Red fox: 6 kg, sprint ~72 km/h, 1 litter/year of 1-12 (usually 5-6),
    //   gestation ~52 days, maturity ~10 months, wild lifespan ~3-10 years.
    //   https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf
    // - Grey wolf: 40 kg, packs of 2-15, 1 litter/year of 4-7 pups, maturity
    //   2-3 years, wild lifespan 6-8 years, territory 100-1000 km2.
    //   https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf
    // - Red deer stag: 60-200 kg (hinds ~60), maturity 2 years.
    // - Brown bear: 200 kg, maturity 4-6 years.
    // - Northern pike: 4 kg, ambush predator striking at 3-4.6 m/s.
    //   https://www.fws.gov/sites/default/files/documents/northern-pike.pdf
    //
    // Time compression: one in-world DAY is 90 s and one YEAR is 8 days
    // (docs/10-SCALE-AND-UNITS.md), so `history` is authored in YEARS and
    // converted by deriveLifeHistory(); lengths are compressed by SPEED_SCALE
    // (a 45 km/h sprint is 4.4 cells/s).
    const SPECIES = {
      rabbit: {
        habitat: 'land', role: 'grazer', flora: 'grass', prey: [], mass: 2, taxon: 'mammal',
        cap: 700, minimum: 80, color: '#c9a97b',
        territory: { radius: 3, max: 7 },
        herd: { radius: 18, separation: 5, alarmRadius: 15 },
        // Crepuscular: busiest at dawn and dusk, skips the midday heat.
        activity: { dawn: 1, day: 0.45, dusk: 1, night: 0.7 },
        // Bursts, then tires: prey wins the sprint, the predator wins the chase.
        flight: { burst: 1.85, burstSeconds: 1.4, tired: 1.12 },
        genes: {
          speed: [2.6, 4.3], vision: [5, 13], size: [0.75, 1.35],
          metabolism: [0.75, 1.3], lifespan: [140, 240], fertility: [70, 110],
        },
        history: { maturityYears: 0.3, lifespanYears: [1, 3], littersPerYear: 4.5, litterMassShare: 0.08 },
        balance: { litter: [4, 7], fleeSpeed: 1.9 },
      },
      deer: {
        habitat: 'land', role: 'grazer', flora: 'grass', prey: [], browse: true, mass: 60, taxon: 'mammal',
        cap: 200, minimum: 12, color: '#b98a5e',
        territory: { radius: 7, max: 6 },
        herd: { radius: 26, separation: 6, alarmRadius: 20 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.5 },
        flight: { burst: 1.5, burstSeconds: 2.2, tired: 1.15 },
        genes: {
          speed: [2.6, 3.8], vision: [8, 16], size: [1.4, 2.2],
          metabolism: [1.05, 1.5], lifespan: [1100, 1600], fertility: [600, 720],
        },
        history: { maturityYears: 2, lifespanYears: [10, 15], littersPerYear: 1, litterMassShare: 0.05 },
        balance: { litter: [1, 3], fleeSpeed: 1.85 },
      },
      fox: {
        habitat: 'land', role: 'hunter', prey: ['rabbit'], mass: 6, taxon: 'mammal',
        cap: 40, minimum: 2, color: '#d2733c',
        territory: { radius: 12, max: 2 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.9 },
        genes: {
          speed: [3.9, 5.7], vision: [9, 19], size: [0.85, 1.55],
          metabolism: [0.85, 1.35], lifespan: [300, 420], fertility: [600, 720],
        },
        history: { maturityYears: 0.8, lifespanYears: [3, 10], littersPerYear: 1, litterMassShare: 0.08 },
        balance: { litter: [3, 6], catchRadius: 1.15, huntSpeed: 1.5, scavengeShare: 0.6 },
      },
      wolf: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'rabbit'], mass: 40, taxon: 'mammal',
        cap: 20, minimum: 1, color: '#8a8f99',
        territory: { radius: 19, max: 1 },
        herd: { radius: 20, separation: 3, alarmRadius: 0 },
        activity: { dawn: 1, day: 0.75, dusk: 1, night: 0.85 },
        genes: {
          speed: [4.3, 6.0], vision: [11, 22], size: [1.3, 2.1],
          metabolism: [1.25, 1.9], lifespan: [700, 900], fertility: [600, 720],
        },
        history: { maturityYears: 2.5, lifespanYears: [6, 8], littersPerYear: 1, litterMassShare: 0.035 },
        balance: { litter: [3, 5], catchRadius: 1.3, huntSpeed: 1.45, scavengeShare: 0.55 },
      },
      crow: {
        habitat: 'air', role: 'scavenger', prey: [], mass: 0.45, taxon: 'bird',
        cap: 60, minimum: 4, color: '#3b3b46',
        herd: { radius: 22, separation: 3.5, alarmRadius: 20 },
        activity: { dawn: 1, day: 1, dusk: 0.9, night: 0.15 },
        genes: {
          speed: [5.2, 7.6], vision: [14, 26], size: [0.8, 1.2],
          metabolism: [0.85, 1.3], lifespan: [500, 700], fertility: [360, 600],
        },
        history: { maturityYears: 1, lifespanYears: [4, 8], littersPerYear: 1, litterMassShare: 0.12 },
        // A crow is a bird: it finds carrion from the air, not by brushing past it.
      // At 1.7 cells it lost every carcass to the fox before it arrived, and the
      // scavenger guild sat permanently below its own breeding reserve.
      balance: { litter: [3, 5], scavengeRadius: 4.0, corpseShare: 0.8 },
      },
      fish: {
        habitat: 'water', role: 'grazer', flora: 'weed', prey: [], mass: 1.2, taxon: 'ectotherm',
        cap: 170, minimum: 40, color: '#5b9fd4',
        territory: { radius: 3, max: 8 },
        herd: { radius: 14, separation: 4, alarmRadius: 10 },
        activity: { dawn: 1, day: 0.9, dusk: 1, night: 0.5 },
        flight: { burst: 1.6, burstSeconds: 0.8, tired: 1.1 },
        genes: {
          speed: [2.2, 4.0], vision: [5, 11], size: [0.7, 1.3],
          metabolism: [0.7, 1.2], lifespan: [420, 560], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 10], littersPerYear: 1, litterMassShare: 0.01 },
        balance: { litter: [6, 10], fleeSpeed: 1.9 },
      },
      pike: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], mass: 4.5, taxon: 'ectotherm',
        cap: 20, minimum: 2, color: '#4a6b4a',
        // Ambush: it does not chase across the lake, it waits and then strikes.
        ambush: { approach: 0.45, strikeDistance: 7, strikeSpeed: 1.9, cooldown: 2.5 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [4.4, 6.2], vision: [8, 16], size: [1.1, 1.9],
          metabolism: [0.95, 1.4], lifespan: [1000, 1300], fertility: [600, 720],
        },
        history: { maturityYears: 2.5, lifespanYears: [7, 15], littersPerYear: 1, litterMassShare: 0.0133 },
        balance: { litter: [2, 4], catchRadius: 1.8, huntSpeed: 1.5, scavengeShare: 0.4 },
      },
      // The next four are the land/water bridge. A heron and a bear stand in the
      // shallows and take fish out of the lake; an otter goes the other way and
      // swims after them. That is the cross-habitat link the food web was
      // missing: before them the lake was a closed loop that nothing on land
      // could reach.
      heron: {
        // Wades: can stand in shallow water, which is how it reaches the fish.
        habitat: 'land', role: 'hunter', prey: ['fish', 'frog'], mass: 1.6, taxon: 'bird',
        cap: 20, minimum: 2, color: '#9aa4b2',
        wade: true,
        territory: { radius: 14, max: 3 },
        activity: { dawn: 1, day: 0.95, dusk: 1, night: 0.25 },
        genes: {
          speed: [3.2, 5.0], vision: [12, 22], size: [0.9, 1.3],
          metabolism: [0.8, 1.2], lifespan: [420, 620], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 8], littersPerYear: 1, litterMassShare: 0.075 },
        balance: { litter: [2, 4], catchRadius: 2.4, huntSpeed: 1.25, scavengeShare: 0.5 },
      },
      otter: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], mass: 8, taxon: 'mammal',
        cap: 20, minimum: 2, color: '#7a5238',
        amphibious: true,
        territory: { radius: 12, max: 3 },
        activity: { dawn: 1, day: 0.85, dusk: 1, night: 0.6 },
        genes: {
          speed: [3.6, 5.4], vision: [10, 18], size: [0.9, 1.3],
          metabolism: [0.95, 1.35], lifespan: [380, 560], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 8], littersPerYear: 1, litterMassShare: 0.056 },
        balance: { litter: [2, 4], catchRadius: 1.7, huntSpeed: 1.55, scavengeShare: 0.5 },
      },
      bear: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'fish', 'rabbit'], mass: 200, taxon: 'mammal',
        cap: 8, minimum: 1, color: '#6b4a34',
        wade: true,
        territory: { radius: 26, max: 1 },
        activity: { dawn: 0.9, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [3.0, 4.4], vision: [10, 18], size: [1.8, 2.6],
          metabolism: [0.8, 1.15], lifespan: [900, 1300], fertility: [1200, 1440],
        },
        history: { maturityYears: 4.5, lifespanYears: [20, 25], littersPerYear: 0.4, litterMassShare: 0.004 },
        balance: { litter: [1, 2], catchRadius: 2.1, huntSpeed: 1.3, scavengeShare: 0.7 },
      },
      frog: {
        // Grazes the shallow weed, so it is the land/water seam in miniature:
        // water plants feed it, and heron, otter and pike eat it.
        habitat: 'land', role: 'grazer', flora: 'weed', prey: [], mass: 0.022, taxon: 'ectotherm',
        cap: 160, minimum: 26, color: '#6fae4e',
        wade: true,
        territory: { radius: 2, max: 9 },
        herd: { radius: 10, separation: 3, alarmRadius: 8 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.55 },
        flight: { burst: 2.1, burstSeconds: 0.5, tired: 1.1 },
        genes: {
          speed: [1.4, 2.6], vision: [3, 7], size: [0.55, 0.9],
          metabolism: [0.6, 1.05], lifespan: [150, 260], fertility: [500, 700],
        },
        history: { maturityYears: 1, lifespanYears: [3, 5], littersPerYear: 1, litterMassShare: 0.03 },
        balance: { litter: [8, 14], fleeSpeed: 2.15 },
      },
    }
    /** Species ids in table order (also the legend/chip order). */
    const SPECIES_IDS = Object.keys(SPECIES)

    /**
     * Derive every life-history number from the YEAR, and write it back.
     *
     * The species table authors maturity, lifespan and litter spacing in
     * ECOLOGICAL YEARS, which is the only unit that survives a change to
     * DAY_SECONDS or YEAR_DAYS. 0.2.x hard-coded seconds, and when the year went
     * from one day to eight the rabbit kept a 36-second maturity while its
     * lifespan stayed under three game-days — it physically could not live long
     * enough to breed. Nothing below may be typed as a number of seconds again:
     *
     *   maturity  = maturityYears x YEAR_SECONDS
     *   lifespan  = lifespanYears x YEAR_SECONDS
     *   cooldown  = YEAR_SECONDS / littersPerYear   (+/- 15% gene spread)
     *   elderAt   = 80% of the mean lifespan (senescence, not half a life)
     */
    function deriveLifeHistory() {
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const history = species.history
        if (history === undefined) continue
        const balance = species.balance ?? (species.balance = {})
        balance.maturity = history.maturityYears * YEAR_SECONDS
        const meanLifespan = (history.lifespanYears[0] + history.lifespanYears[1]) / 2
        balance.elderAt = 0.8 * meanLifespan * YEAR_SECONDS
        const genes = species.genes ?? (species.genes = {})
        genes.lifespan = [
          history.lifespanYears[0] * YEAR_SECONDS,
          history.lifespanYears[1] * YEAR_SECONDS,
        ]
        const cooldown = YEAR_SECONDS / Math.max(0.05, history.littersPerYear)
        genes.fertility = [Math.round(cooldown * 0.85), Math.round(cooldown * 1.15)]
      }
    }

    /**
     * Derive every number physics dictates and write it back into `balance`.
     *
     * This is the "compute the numbers, do not tune them" rule in code: reserve
     * capacity is five days of the animal's own field metabolic rate, an adult
     * starts at 70% of it, breeding costs a fixed share of it, and the carcass
     * energy an old feeding path may read is the animal's edible mass. A species
     * row can no longer carry a hand-picked energy number that contradicts its
     * own body mass.
     */
    function deriveSpeciesEnergy() {
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const balance = species.balance ?? (species.balance = {})
        const capacity = reserveCapacity(species, adultMassOf(species))
        balance.maxEnergy = capacity
        balance.startEnergy = capacity * SPAWN_RESERVE_SHARE
        // --- what a litter actually costs ------------------------------------
        // A newborn is not free: it is tissue plus a reserve, and the parent has
        // to pay for both out of its own body, at a conversion efficiency below
        // 1 (the rest leaves as heat and is real respiration). Dividing the
        // litter's total wet mass by the litter size gives one newborn's mass,
        // so a rabbit kit is 43 g and a wolf pup is 350 g without either number
        // being typed anywhere.
        const history = species.history
        const litterMax = Math.max(1, balance.litter?.[1] ?? 1)
        const litterMass = adultMassOf(species) * (history?.litterMassShare ?? 0.05)
        const birthMass = litterMass / litterMax
        const birthReserve = reserveCapacity(species, birthMass) * BIRTH_RESERVE_SHARE
        balance.birthMass = birthMass
        /** What one whole litter costs the parent, kJ: tissue plus the kits' reserves. */
        balance.litterCost = (litterMass * BIO.MEAT_ENERGY + litterMax * birthReserve)
          / BIO.REPRODUCTION_EFFICIENCY
        // A species may only breed when its reserve covers the whole litter, so
        // the ledger never has to invent the difference.
        balance.breedEnergy = Math.min(capacity * 0.97, balance.litterCost * 1.02)
        // The litter is now charged per newborn inside spawnEntity(), out of the
        // parent's real reserve. This legacy field has to stay ZERO or the parent
        // would be billed twice for the same litter.
        balance.breedCost = 0
        // The reserve is spent inside metabolise() and nowhere else. These two
        // keys stay because other layers read them; they must stay zero or the
        // animal would be charged twice for standing still.
        balance.drain = 0
        balance.fleeDrain = 0
        // Assimilation efficiency of the diet, used by consume().
        balance.assimilation = species.role === 'grazer'
          ? BIO.ASSIMILATION_HERBIVORE
          : BIO.ASSIMILATION_CARNIVORE
        // Carcass energy of an adult, kJ. The legacy death path in 08 reads
        // `species.meat`; deriving it keeps that path in the same unit.
        species.meat = adultMassOf(species) * BIO.MEAT_FRACTION * BIO.MEAT_ENERGY
        // kJ per kg of dry matter the plant field holds (docs/10 §2): the panel
        // converts a biomass sum into energy with it, and it must not be a
        // second hand-tuned constant.
        if (species.flora === 'grass' || species.flora === 'weed') {
          balance.floraEnergy = BIO.GRASS_ENERGY
        }
      }
    }

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

    /**
     * Starting population of a fresh world, sized by the energy budget rather
     * than by what looked good in 0.2.x.
     *
     * A predator can only eat what its prey PRODUCE in a year, and terrestrial
     * production is roughly 1-5% of prey biomass per year, so the predator tier
     * has to be a small fraction of the prey tier. The old cast (12 foxes, 5
     * wolves, 4 bears on the same meadow) put predator biomass at ~45% of prey
     * biomass and demanded ~8x the prey's annual production: every predator
     * starved (measured: 98.9% of predator deaths were starvation). This cast
     * sits near the measured carrying capacity (tools/calibrate.mjs).
     */
    const DEFAULT_STOCKS = {
      rabbit: 320, deer: 40, fox: 4, wolf: 2, crow: 10, fish: 120, pike: 4,
      heron: 4, otter: 4, bear: 1, frog: 90,
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
        // Indices are clamped, not trusted: a caller may sample outside the
        // lattice (an offset coordinate, a brush near the edge) and an undefined
        // lattice read makes a whole field NaN silently. That is exactly the bug
        // that turned 58 water cells into NaN and poisoned the energy book.
        const x0 = Math.min(cols - 2, Math.max(0, fx | 0))
        const y0 = Math.min(rows - 2, Math.max(0, fy | 0))
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
     * Seed the two producer fields, in kg of dry matter per square metre.
     *
     * The starting sward is NOT uniform. A 26-cell value-noise field decides how
     * rank the meadow is from place to place, and soil moisture and nutrient build
     * on top of it. That matters for gameplay, not for looks: an animal's eyesight
     * is 5-26 cells, so a patch has to be about that wide before it can be seen
     * and walked to. A uniform field is a field with nowhere to go.
     * @param {object} world - the world.
     */
    function seedProducers(world) {
      const size = world.width * world.height
      const patch = createNoise(world, 26)
      const grain = createNoise(world, 7)
      for (let i = 0; i < size; i++) {
        const terrain = world.terrain[i]
        world.fertility[i] = baseFertility(world, i)
        if (terrain === TERRAIN.GRASS) {
          const x = i % world.width
          const y = (i / world.width) | 0
          const rank = 0.35 + 0.55 * patch(x, y) + 0.12 * grain(x, y)
          const wet = 0.5 + 0.5 * world.moisture[i]
          const soil = 0.45 + 0.55 * world.fertility[i]
          world.grass[i] = clamp(PRODUCERS.grass.bmax * rank * wet * soil, 0, PRODUCERS.grass.bmax)
          // A fresh world is not a sterile one: the detritus layer a meadow
          // carries between seasons is what recycles its nutrients, so it starts
          // at the steady state of its own litter fall instead of at zero (which
          // would mine the soil for the first days of the world).
          world.detritus[i] = world.grass[i] * 0.25
        } else if (terrain === TERRAIN.WATER) {
          const x = i % world.width
          const y = (i / world.width) | 0
          const rank = 0.3 + 0.5 * patch((x + 17) % world.width, (y + 29) % world.height)
          const soil = 0.4 + 0.6 * world.waterFertility[i]
          // The lake starts the way a lake looks: a weed fringe in the shallows
          // and open water past the light limit. Seeding it uniformly would give
          // the player a green carpet on the first frame and then a two-day
          // die-back, which reads as a bug rather than as a lake.
          const depth = world.depth[i]
          const suitable = clamp(1 - (depth - DEPTH_WEED_START) / (DEPTH_WEED_LIMIT - DEPTH_WEED_START), 0, 1)
          world.weed[i] = clamp(PRODUCERS.weed.bmax * rank * soil * suitable, 0, PRODUCERS.weed.bmax)
          world.detritus[i] = world.weed[i] * 0.25
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
          // A real population is not all newborns: seed the starting stock with
          // an age spread from just-mature to late in life, so the world opens
          // with animals old enough to breed and the age pyramid looks like one.
          const maxAge = species.genes.lifespan[0]
          spawnEntity(world, id, x, y, undefined, 1, {
            age: randomBetween(world, species.balance.maturity, maxAge),
          })
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
      const width = Math.max(32, Math.min(GRID_W, options.width ?? GRID_W))
      const height = Math.max(24, Math.min(GRID_H, options.height ?? GRID_H))
      // A world without an explicit seed gets a clock-derived one. `Math.random`
      // is banned in the engine so that any run can be replayed from its seed.
      const seed = (options.seed ?? (Date.now() & 0xffffffff)) >>> 0
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
        // Producer biomass, kg of dry matter per m^2 (docs/10 section 2).
        grass: new Float32Array(size),
        weed: new Float32Array(size),
        // Detritus: corpses, dung and litter waiting to be mineralised.
        detritus: new Float32Array(size),
        // Light reaching each cell after canopy attenuation, 0..1.
        light: new Float32Array(size),
        // Extra leaf area the woody plants cast (rebuilt when the forest moves).
        canopy: new Float32Array(size),
        canopyDirty: true,
        climate: createClimate(DAY_SECONDS * 0.26),
        budget: createBudget(),
        deaths: {},
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      // `nutrient` is the name the data contract uses (docs/CORE-LOOP 3); it is
      // the same array as `fertility` so the renderer and the player tools keep
      // reading the field they always read.
      world.nutrient = world.fertility
      generateTerrain(world)
      computeHydrology(world)
      seedProducers(world)
      seedTrees(world, options.trees ?? Math.round(430 * (size / 256000)))
      seedAnimals(world, { ...DEFAULT_STOCKS, ...(options.stocks ?? {}) })
      world.population = countPopulations(world)
      // Fill the shade field once so the first tick already has light.
      rebuildCanopy(world)
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
        age: 0,
        generation: generation ?? 1,
        // Adults do not all breed on the same tick: a staggered cooldown is what
        // keeps the first minute from being one population explosion.
        cooldown: options?.cooldown ?? (options?.juvenile === true || (generation !== undefined && generation > 1)
          ? 0
          : randomBetween(world, species.genes.fertility[0] * 0.3, species.genes.fertility[1])),
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
      // A birth is juvenile; anything else entering the world (starting stock,
      // immigration, a player release) is a full-grown animal. Births are the
      // only call that passes inherited genes.
      const newborn = options?.juvenile === true || (generation !== undefined && generation > 1)
      entity.age = options?.age ?? (newborn ? 0 : species.balance.maturity)
      // The body is the ledger: creating the animal means creating its reserve,
      // its structure and the derived views (energy accessor, hunger channel).
      // The reserve is seeded with the ledger MUTED and the whole cost is booked
      // in one place below: seeding through the accessor would enter the book as
      // an anonymous deposit and then as an anonymous withdrawal, and any drift
      // between those two entries is energy nobody can account for.
      ledgerWriteDepth += 1
      let body
      try {
        body = installLedger(entity)
        body.E = clamp(body.Emax * (options?.reserve ?? (newborn ? BIRTH_RESERVE_SHARE : SPAWN_RESERVE_SHARE)), 0, body.Emax)
      } finally {
        ledgerWriteDepth -= 1
      }
      // Where a new body's energy came from decides how it is booked.
      //
      //  - A NEWBORN is a transfer FROM ITS PARENT: the parent pays the whole
      //    cost out of its own reserve and the difference (conversion efficiency
      //    below 1) leaves as heat, which is real respiration. Nothing appears
      //    out of nowhere, so the energy panel stops being flattened by a fake
      //    "reproduction" source twice the size of everything else.
      //  - A PARENTLESS spawn (starting stock, immigration, a player release) is
      //    genuinely new energy, and the book names it rather than hiding it.
      if (world.budget !== undefined) {
        const newbornEnergy = body.V * BIO.MEAT_ENERGY + body.E
        const parent = options?.parent
        if (parent !== undefined && parent !== null && parent.body !== undefined && parent.body.dead !== true) {
          const paid = payFromReserve(parent, newbornEnergy / BIO.REPRODUCTION_EFFICIENCY)
          // Positive when the parent covered the litter: the gap is the heat.
          world.budget.animalRespired += paid - newbornEnergy
        } else {
          world.budget.reproduction += newbornEnergy
        }
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
     * Quality of a standing crop as the share of a full bite rate.
     *
     * Patch value has to be in the same unit as the intake the animal will
     * actually get, otherwise a decision compares apples to grass. The feeding
     * layer already owns that curve (Holling type II in 11-feed), so this reads
     * it instead of inventing a second one; the fallback is a plain saturation
     * curve for the case where the feeding part is not loaded.
     * @param {number} available - standing crop, kg dry matter/m^2.
     * @returns {number} 0..1 opportunity quality.
     */
    function swardQuality(available) {
      if (!(available > 0)) return 0
      if (typeof grazingIntake === 'function') {
        const ceiling = grazingIntake(1, 1e9)
        if (ceiling > 0) return clamp(grazingIntake(1, available) / ceiling, 0, 1)
      }
      return clamp(available / (0.5 + available), 0, 1)
    }
    /**
     * Scan the neighbourhood for the best edible cell of an animal's flora.
     *
     * The scan is a deterministic lattice walk, not a random sample: every cell
     * inside the search circle at the current stride is looked at, so an animal
     * cannot "miss" a full meadow standing in front of it. The stride coarsens
     * with the radius, which is how a real eye loses detail at the edge of its
     * vision — and it keeps a wide scan cheap enough for a thousand animals.
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @param {number} hunger - current hunger drive (0..1).
     * @param {number} now - world time.
     * @returns {{x: number, y: number, value: number}|null} best patch centre.
     */
    function scanFlora(world, entity, species, hunger, now) {
      const field = floraField(world, species)
      if (field === null) return null
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const reach = clamp(Math.round(entity.genes.vision * (0.4 + hunger * 0.9)), 3, 15)
      const stride = reach > 8 ? 2 : 1
      const originX = entity.x | 0
      const originY = entity.y | 0
      let best = null
      let bestScore = 0.02
      for (let offsetY = -reach; offsetY <= reach; offsetY += stride) {
        const cellY = originY + offsetY
        for (let offsetX = -reach; offsetX <= reach; offsetX += stride) {
          const offset = offsetX * offsetX + offsetY * offsetY
          if (offset > reach * reach) continue
          const cellX = originX + offsetX
          const index = cellIndex(world, cellX, cellY)
          if (index < 0 || world.terrain[index] !== wanted) continue
          const available = field[index]
          // Any standing crop is visible; what differs is what a bite is worth,
          // which is what the functional-response quality below expresses.
          if (available <= 0.004) continue
          // A wader must not aim at water it cannot stand in; a fish never leaves
          // the water, so canStand is the one legality test for both.
          if (!canStand(world, species, cellX + 0.5, cellY + 0.5)) continue
          const distance = Math.sqrt(offset)
          const heat = threatHeat(entity, cellX + 0.5, cellY + 0.5, now)
          const quality = swardQuality(available)
          const score = quality * (1 - heat * 0.6) - distance * 0.014
          if (score > bestScore) {
            bestScore = score
            best = { x: cellX + 0.5, y: cellY + 0.5, value: quality }
          }
        }
      }
      return best
    }

    /**
     * Nearest leafy plant inside a radius. Browsing is the fallback when the
     * ground is bare, so this only runs when the flora scan found little.
     * @param {object} world - the world.
     * @param {object} entity - the deer.
     * @param {number} radius - reach in cells.
     * @param {number} now - world time.
     * @returns {{x: number, y: number, value: number}|null} the plant.
     */
    function scanFoliage(world, entity, radius, now) {
      let best = null
      let bestScore = 0.12
      for (const plant of world.trees) {
        if (plant.variant === 'lily' || plant.variant === 'reed') continue
        const foliage = plant.foliage ?? 0
        if (foliage <= 0.12) continue
        const distance = Math.hypot(plant.x - entity.x, plant.y - entity.y)
        if (distance > radius) continue
        const heat = threatHeat(entity, plant.x, plant.y, now)
        const score = foliage * (1 - heat * 0.6) - distance * 0.014
        if (score > bestScore) { bestScore = score; best = plant }
      }
      return best
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
      // Grazers and scavengers have no prey list at all, and every caller
      // (perception included) asks unconditionally: an absent field must mean
      // "hunts nothing", not a TypeError that takes the whole world down.
      for (const preyId of species.prey ?? []) {
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

    // ---------------------------------------------------------------------
    // Behaviour states (executed by the machine in 10b-execution.js)
    // ---------------------------------------------------------------------

    /**
     * States are ordered by urgency, and that order is what makes an interrupt
     * safe: something urgent may cut a lower state short, nothing may cut
     * something more urgent. A predator beats a drink, a drink beats a meal, a
     * meal beats a nap or a look around.
     */
    const STATE_CLASS = {
      flee: 3,
      drink: 2,
      forage: 1,
      hunt: 1,
      scavenge: 1,
      rest: 0,
      socialize: 0,
      explore: 0,
    }

    /**
     * Per state: the shortest time the animal stays committed, and the planned
     * length of a normal bout.
     *
     * `min` is the anti-twitch floor. The 0.2.x build re-rolled its whole intent
     * every 0.22-0.55 s, which is why nothing on screen ever looked like it was
     * doing something. `duration` is how long a bout runs before the animal
     * considers its options again.
     */
    const STATE_PLAN = {
      flee: { min: 3, duration: [4, 7] },
      drink: { min: 5, duration: [6, 10] },
      forage: { min: 10, duration: [16, 28] },
      hunt: { min: 10, duration: [16, 28] },
      scavenge: { min: 8, duration: [14, 24] },
      rest: { min: 10, duration: [20, 40] },
      socialize: { min: 8, duration: [12, 20] },
      explore: { min: 10, duration: [16, 28] },
    }

    /** How much better a rival must score before it may cut a state short. */
    const STATE_HYSTERESIS = 1.18

    /** Absolute score margin on top of the ratio, so a near-tie never flips. */
    const STATE_MARGIN = 0.1

    /**
     * How much of its hunger one kJ of travel is worth, i.e. the exchange rate
     * between a joule spent walking and a hunger drive unit: exactly the size of
     * the reserve, because hunger is 1 - E/Emax. This is what lets the decision
     * system subtract a real energy cost from a unitless score.
     * @param {object} species - species row.
     * @returns {number} hunger units per kJ.
     */
    function energyToDriveUnits(species) {
      return 1 / Math.max(1, species.balance.maxEnergy)
    }
/**
 * Perception and belief: what an animal currently knows about its world.
 *
 * OWNER: behaviour
 *
 * Perception is a real neighbourhood scan on a staggered ~1 Hz schedule, not a
 * handful of random samples. That difference is the whole point of this part:
 * twelve random draws inside eyesight used to miss a meadow that was standing
 * right there, so a hungry animal "saw nothing" and went back to resting. A scan
 * that walks the same cells every time is also reproducible, which keeps the
 * whole simulation deterministic from its seed.
 *
 * Belief is what the animal remembers between scans (docs/20-CORE-LOOP.md 2.3):
 *   belief.food    { x, y, t, value, kind }  best edible patch or prey in sight
 *   belief.carrion { x, y, t, value }        closest corpse in sight
 *   belief.threat  { x, y, t, species }      predator currently in sight
 *   belief.water   { x, y, t }               nearest drinkable water
 *   belief.home    { x, y, t }               last resting site (home range anchor)
 *   belief.caches  [{ x, y, t, energy }]     own food caches (world.caches)
 *   belief.sites   [{ x, y, t, value }]      remembered foraging sites
 *   belief.marks   [{ x, y, t }]             remembered danger spots
 *
 * Every entry carries `t` (world time) so callers can tell a fresh sighting
 * from a memory; stale entries are dropped by trimBelief(). Remembered sites
 * decay and are reinforced by revisits (see rememberFood), which is what makes
 * an animal return to the patch that fed it instead of wandering at random.
 */

    // ---------------------------------------------------------------------
    // Perception and belief
    // ---------------------------------------------------------------------

    /** Channels every belief record carries. */
    const BELIEF_CHANNELS = ['food', 'carrion', 'threat', 'water', 'home', 'caches']

    /** Neighbourhood scans per second per animal (staggered across ticks). */
    const PERCEPTION_HZ = 1

    /** How long one entry stays usable, in seconds. */
    const BELIEF_LIFETIME = {
      food: 35,
      carrion: 25,
      threat: 6,
      water: 70,
      /** Remembered foraging sites outlive a sighting: that is the point. */
      site: 120,
      /** A danger spot keeps steering patch choice for a while. */
      mark: 60,
    }

    /** Remembered foraging sites kept per animal. */
    const MEMORY_SITES = 4
    /** Remembered danger spots kept per animal. */
    const MEMORY_MARKS = 3

    /** How strongly a remembered danger spot spoils a spot's appeal. */
    const THREAT_HEAT_RADIUS = 7

    /**
     * The belief record of an animal, created on first use so restored saves and
     * hand-made test animals both work.
     * @param {object} entity - the animal.
     * @returns {object} mutable belief record.
     */
    function beliefOf(entity) {
      if (entity.belief === undefined) {
        entity.belief = {
          food: null,
          carrion: null,
          threat: null,
          water: null,
          home: null,
          caches: [],
          sites: [],
          marks: [],
        }
      }
      return entity.belief
    }

    /**
     * Whether a belief entry is still fresh enough to act on.
     * @param {{t: number}|null|undefined} entry - belief entry.
     * @param {number} now - world time in seconds.
     * @param {number} lifetime - seconds the entry may age.
     * @returns {boolean} true when the entry can be used.
     */
    function beliefFresh(entry, now, lifetime) {
      return entry !== null && entry !== undefined && now - entry.t <= lifetime
    }

    /**
     * Confidence of a belief entry, decaying linearly to zero at its lifetime.
     * @param {{t: number}|null|undefined} entry - belief entry.
     * @param {number} now - world time in seconds.
     * @param {number} lifetime - seconds of useful life.
     * @returns {number} 0..1 confidence.
     */
    function beliefConfidence(entry, now, lifetime) {
      if (entry === null || entry === undefined) return 0
      const age = now - entry.t
      if (age <= 0) return 1
      return clamp(1 - age / lifetime, 0, 1)
    }

    /**
     * Remember a foraging site, or reinforce one the animal already knows.
     *
     * Reinforcement is why memory is worth having: a patch that fed the animal
     * grows in its estimate, a patch it merely walked past does not. The oldest
     * sites fade so a moved patch is eventually forgotten.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} value - food quality found there (0..1+).
     * @param {number} now - world time.
     * @returns {void}
     */
    function rememberFood(entity, x, y, value, now) {
      const belief = beliefOf(entity)
      const sites = belief.sites
      let nearest = null
      let nearestDistance = 36
      for (const site of sites) {
        const distance = (site.x - x) * (site.x - x) + (site.y - y) * (site.y - y)
        if (distance < nearestDistance) { nearestDistance = distance; nearest = site }
      }
      if (nearest !== null) {
        // Revisiting a known site is evidence: raise its weight rather than
        // replacing it, so a good patch keeps winning over a lucky sample.
        nearest.x = x
        nearest.y = y
        nearest.t = now
        nearest.value = clamp(nearest.value * 0.55 + value * 0.65, 0, 1.6)
        return
      }
      sites.push({ x, y, t: now, value: clamp(value, 0, 1.6) })
      if (sites.length > MEMORY_SITES) {
        let worst = 0
        for (let index = 1; index < sites.length; index++) {
          const spent = sites[index].value - (now - sites[index].t) / BELIEF_LIFETIME.site
          const worstSpent = sites[worst].value - (now - sites[worst].t) / BELIEF_LIFETIME.site
          if (spent < worstSpent) worst = index
        }
        sites.splice(worst, 1)
      }
    }

    /**
     * Remember a danger spot, so patch choice keeps steering around it.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} now - world time.
     * @returns {void}
     */
    function rememberThreat(entity, x, y, now) {
      const belief = beliefOf(entity)
      const marks = belief.marks
      let nearest = null
      let nearestDistance = 25
      for (const mark of marks) {
        const distance = (mark.x - x) * (mark.x - x) + (mark.y - y) * (mark.y - y)
        if (distance < nearestDistance) { nearestDistance = distance; nearest = mark }
      }
      if (nearest !== null) { nearest.x = x; nearest.y = y; nearest.t = now; return }
      marks.push({ x, y, t: now })
      if (marks.length > MEMORY_MARKS) marks.shift()
    }

    /**
     * How dangerous a spot feels, from remembered danger recent enough to matter.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} now - world time.
     * @returns {number} 0 (safe) .. 1 (just escaped from there).
     */
    function threatHeat(entity, x, y, now) {
      const belief = beliefOf(entity)
      let heat = 0
      for (const mark of belief.marks) {
        const confidence = beliefConfidence(mark, now, BELIEF_LIFETIME.mark)
        if (confidence <= 0) continue
        const distance = Math.hypot(mark.x - x, mark.y - y)
        if (distance > THREAT_HEAT_RADIUS) continue
        const near = 1 - distance / THREAT_HEAT_RADIUS
        heat = Math.max(heat, confidence * near)
      }
      return heat
    }

    /**
     * Best remembered foraging site still worth walking to.
     * @param {object} entity - the animal.
     * @param {number} now - world time.
     * @returns {{x: number, y: number, t: number, value: number}|null} the site.
     */
    function recallFood(entity, now) {
      const belief = beliefOf(entity)
      let best = null
      let bestScore = 0.04
      const headingX = Math.cos(entity.heading)
      const headingY = Math.sin(entity.heading)
      for (const site of belief.sites) {
        const confidence = beliefConfidence(site, now, BELIEF_LIFETIME.site)
        if (confidence <= 0) continue
        const dx = site.x - entity.x
        const dy = site.y - entity.y
        const length = Math.hypot(dx, dy) || 1
        // A patch behind the animal is worth less than the same patch ahead:
        // animals track food forward, and a memory that keeps pulling them
        // back is what turns a grazing trip into a random walk.
        const ahead = (dx * headingX + dy * headingY) / length
        const behind = ahead < 0 ? 0.12 * (1 - ahead) : 0
        const score = site.value * confidence - threatHeat(entity, site.x, site.y, now) * 0.4 - behind
        if (score > bestScore) { bestScore = score; best = site }
      }
      return best
    }

    /**
     * Drop beliefs that have gone stale, so nothing acts on a week-old sighting.
     * @param {object} entity - the animal.
     * @param {number} now - world time.
     * @returns {void}
     */
    function trimBelief(entity, now) {
      const belief = beliefOf(entity)
      for (const channel of ['food', 'carrion', 'water']) {
        if (!beliefFresh(belief[channel], now, BELIEF_LIFETIME[channel])) belief[channel] = null
      }
      if (!beliefFresh(belief.threat, now, BELIEF_LIFETIME.threat)) belief.threat = null
      let write = 0
      for (let index = 0; index < belief.sites.length; index++) {
        const site = belief.sites[index]
        if (!beliefFresh(site, now, BELIEF_LIFETIME.site)) continue
        belief.sites[write++] = site
      }
      belief.sites.length = write
      write = 0
      for (let index = 0; index < belief.marks.length; index++) {
        const mark = belief.marks[index]
        if (!beliefFresh(mark, now, BELIEF_LIFETIME.mark)) continue
        belief.marks[write++] = mark
      }
      belief.marks.length = write
    }

    /**
     * Where to stand to drink: the nearest bank cell next to the water, not the
     * water cell itself.
     *
     * A land animal that aims at the middle of the lake can never arrive, because
     * canStand refuses the cell; it would reach the shore, fail to get closer,
     * give up and decide to drink again. That treadmill is what made drinking
     * take a tenth of a predator's life. Aiming at the bank removes the loop:
     * the animal stands ON the spot and the feeding code finds water adjacent.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {{x: number, y: number}} water - a water cell (integer coordinates).
     * @returns {{x: number, y: number}} a standable spot beside the water.
     */
    function drinkSpot(world, species, water) {
      let best = null
      let bestDistance = Infinity
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const cellX = water.x + offsetX
          const cellY = water.y + offsetY
          if (!canStand(world, species, cellX + 0.5, cellY + 0.5)) continue
          const distance = offsetX * offsetX + offsetY * offsetY
          if (distance < bestDistance) {
            bestDistance = distance
            best = { x: cellX + 0.5, y: cellY + 0.5 }
          }
        }
      }
      return best ?? { x: water.x + 0.5, y: water.y + 0.5 }
    }
    /**
     * Scan for the nearest corpse (food for a hunter, a meal for a scavenger).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} radius - reach in cells.
     * @returns {object|null} the corpse.
     */
    function scanCarrion(world, entity, radius) {
      const corpse = nearestCorpse(world, entity.x, entity.y, radius)
      if (corpse === null) return null
      return { x: corpse.x, y: corpse.y, value: clamp((corpse.energy ?? 20) / 40, 0.2, 1.2) }
    }

    /**
     * One perception pass: refresh every belief channel this species cares about.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {void}
     */
    function perceiveNow(world, entity, species, grids) {
      const belief = beliefOf(entity)
      const now = world.time
      const genes = entity.genes
      if (belief.home === null) belief.home = { x: entity.x, y: entity.y, t: now }

      // --- danger: the highest-priority channel -----------------------------
      const predators = PREDATORS_OF[entity.species]
      if (predators !== undefined && predators.size > 0) {
        const sighted = queryNearest(grids.hunter, entity.x, entity.y, genes.vision,
          candidate => candidate.fate === '' && predators.has(candidate.species))
        if (sighted !== null) {
          belief.threat = { x: sighted.x, y: sighted.y, t: now, species: sighted.species }
          entity.alarm = ALARM_SECONDS
          entity.threatX = sighted.x
          entity.threatY = sighted.y
          rememberThreat(entity, sighted.x, sighted.y, now)
          // A whole warren bolting reads as an event; one rabbit twitching does not.
          spreadAlarm(entity, species, grids.prey, sighted, world)
        }
      }

      // --- food -------------------------------------------------------------
      const hunger = entity.drives === undefined ? 0.3 : entity.drives.hunger
      if (species.role === 'grazer') {
        const patch = scanFlora(world, entity, species, hunger, now)
        if (patch !== null) {
          belief.food = { x: patch.x, y: patch.y, t: now, value: patch.value, kind: 'flora' }
          rememberFood(entity, patch.x, patch.y, patch.value, now)
        } else if (species.browse === true) {
          const plant = scanFoliage(world, entity, genes.vision, now)
          if (plant !== null) {
            belief.food = { x: plant.x, y: plant.y, t: now, value: (plant.foliage ?? 0) * 0.8, kind: 'foliage' }
          } else {
            belief.food = null
          }
        } else {
          belief.food = null
        }
        // Nothing in sight: fall back on a remembered patch, which is what lets
        // an animal cross bare ground with a purpose instead of grazing at random.
        if (belief.food === null) {
          const recalled = recallFood(entity, now)
          if (recalled !== null) {
            belief.food = { x: recalled.x, y: recalled.y, t: now, value: recalled.value, kind: 'memory' }
          }
        }
      } else {
        // A hunter looks for the nearest animal it is allowed to eat; a
        // scavenger only ever looks for carrion, so it must not run the prey
        // query at all (its species row has no prey table).
        const carrion = scanCarrion(world, entity, genes.vision * (species.role === 'hunter' ? 1.7 : 1.9))
        belief.carrion = carrion === null ? null : { x: carrion.x, y: carrion.y, t: now, value: carrion.value }
        const prey = species.role === 'hunter'
          ? nearestPrey(entity, species, grids.prey, genes.vision * (species.huntReach ?? 1.6))
          : null
        if (prey !== null) {
          belief.food = { x: prey.x, y: prey.y, t: now, value: 0.9, kind: 'prey', speciesId: prey.species }
        } else {
          belief.food = null
        }
      }

      // --- water: worth looking for when dry, and always when the animal eats
      // something that only grows in water (a frog on land needs to know where
      // the pond is even when it is not thirsty) ----------------------------
      const aimsForWaterWeed = species.flora === 'weed' && species.habitat !== 'water'
      const thirsty = entity.drives !== undefined && entity.drives.thirst > 0.12
      if (species.habitat !== 'water' && (thirsty || aimsForWaterWeed)) {
        const water = nearestWater(world, entity.x, entity.y, genes.vision)
        if (water !== null) {
          const spot = drinkSpot(world, species, water)
          belief.water = { x: spot.x, y: spot.y, t: now }
        }
      }

      // --- company: a herd is a place as much as a crowd ---------------------
      entity.socialCount = 0
      entity.herdAnchor = null
      if (species.herd !== undefined) {
        const kin = species.role === 'hunter' ? grids.hunter : grids.prey
        const neighbours = queryNearby(kin, entity.x, entity.y, species.herd.radius,
          candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species, 12)
        entity.socialCount = neighbours.length
        if (neighbours.length > 0) {
          let sumX = 0
          let sumY = 0
          for (const neighbour of neighbours) { sumX += neighbour.x; sumY += neighbour.y }
          entity.herdAnchor = { x: sumX / neighbours.length, y: sumY / neighbours.length }
        }
      }

      // --- own caches (P5): read-only until the sim-core side fills them -----
      const caches = world.caches
      if (Array.isArray(caches) && caches.length > 0) {
        belief.caches.length = 0
        for (const cache of caches) {
          if (cache.owner !== entity.id) continue
          belief.caches.push({ x: cache.x, y: cache.y, t: now, energy: cache.energy ?? 0 })
        }
      }

      trimBelief(entity, now)
    }

    /**
     * Advance the perception clock; scans when this animal's ~1 Hz slot lands.
     *
     * The first slot is staggered per animal from the world RNG, so a herd does
     * not all scan (and all decide) on the same tick: that staggering is what
     * keeps a thousand animals affordable and stops the whole meadow from
     * twitching in lockstep.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @param {number} dt - step in seconds.
     * @returns {void}
     */
    function perceive(world, entity, species, grids, dt) {
      if (entity.perceiveTimer === undefined) entity.perceiveTimer = randomBetween(world, 0, 1 / PERCEPTION_HZ)
      entity.perceiveTimer -= dt
      if (entity.perceiveTimer > 0) return
      entity.perceiveTimer = (0.85 + randomBetween(world, 0, 0.3)) / PERCEPTION_HZ
      perceiveNow(world, entity, species, grids)
    }

    // ---------------------------------------------------------------------
    // Needs, drives, temperament and life stages
    // ---------------------------------------------------------------------
    //
    // Drives are what an animal *wants* right now, and every one of them is
    // derived from the animal's body or its situation, never from a timer:
    // hunger is the reserve emptied (1 - E/Emax), fatigue is what activity has
    // accumulated, fear is a predator in sight, social is "my herd is not here".
    //
    // That derivation is the fix for the 0.2.x bug that made the whole world
    // read as a reaction field: decisions used to run on their own counters, so
    // an animal could stand in grass and starve with its hunger channel pointing
    // the other way.
    //
    // The legacy `needs` record (NEED_KEYS) is kept as a derived view of the
    // drives for the inspector and the older UI, and is still the place where
    // the feeding code writes thirst back when an animal drinks.

    /** Drive channels every animal has (docs/20-CORE-LOOP.md section 2.2). */
    const DRIVE_KEYS = ['hunger', 'thirst', 'cold', 'fatigue', 'fear', 'social', 'curiosity', 'libido']

    /** Legacy need channels the inspector renders; a view over the drives. */
    const NEED_KEYS = ['hunger', 'thirst', 'energy', 'safety', 'social']

    /** Temperament defaults by feeding role; a species row may override `traits`. */
    const ROLE_TRAITS = {
      grazer: { bold: 0.35, social: 0.8, curious: 0.45, territorial: 0.25 },
      hunter: { bold: 0.85, social: 0.5, curious: 0.7, territorial: 0.8 },
      scavenger: { bold: 0.6, social: 0.75, curious: 0.95, territorial: 0.2 },
    }

    /**
     * How loud each drive is, per role. These are the utility weights: a rabbit
     * values safety over food, a wolf values food over safety, a crow is the
     * curious one. Nothing else in the decision system is hand-tuned per species.
     */
    const DRIVE_WEIGHT = {
      grazer: {
        hunger: 1.25, thirst: 0.85, cold: 0.9, fatigue: 0.8,
        fear: 2.4, social: 0.4, curiosity: 0.5, libido: 0.3,
      },
      hunter: {
        hunger: 1.6, thirst: 0.9, cold: 0.8, fatigue: 0.85,
        fear: 1.5, social: 0.35, curiosity: 0.55, libido: 0.4,
      },
      scavenger: {
        hunger: 1.4, thirst: 0.9, cold: 0.85, fatigue: 0.6,
        fear: 1.1, social: 0.6, curiosity: 0.85, libido: 0.3,
      },
    }

    /**
     * Structural maturity at which an animal counts as grown up, 0..1.
     * 0.98 rather than 1 because growth asymptotes: a body a fraction under its
     * adult size is an adult, not a juvenile that will never breed.
     */
    const ADULT_MATURITY_SHARE = 0.98

    /** Share of its own lifespan after which an animal counts as an elder. */
    const ELDER_LIFESPAN_SHARE = 0.75

    /** Size, speed and appetite multipliers per life stage. */
    const STAGE_SCALE = { juvenile: 0.6, adult: 1, elder: 1.03 }
    const STAGE_SPEED = { juvenile: 0.78, adult: 1, elder: 0.82 }
    const STAGE_APPETITE = { juvenile: 1.3, adult: 1, elder: 0.85 }

    /** Intent ids; the UI translates them, nothing else enumerates them. */
    const INTENT_IDS = ['flee', 'forage', 'hunt', 'scavenge', 'drink', 'rest', 'socialize', 'explore']

    /**
     * Reserves this full count as "not hungry". A reserve that is 88% full is
     * comfortable, so hunger reads zero there instead of nudging every animal
     * into a permanent search for food.
     */
    const SATIETY_DEADBAND = 0.12

    /** Seconds of normal activity that fill the thirst ledger. */
    const THIRST_SECONDS = 220

    /** Seconds a bout of company keeps the social channel satisfied. */
    const SOCIAL_SATIATION_SECONDS = 35

    /** Fatigue gained per second of walking, and cleared per second of rest. */
    const FATIGUE_PER_SECOND = 0.012
    const FATIGUE_RECOVERY = 0.055

    /** Seconds of habituation after a bout of exploring before curiosity returns. */
    const HABITUATION_SECONDS = 25

    /** Air temperature in degrees C, from the climate step when it exists. */
    function climateTemperature(world) {
      const climate = world.climate
      if (climate !== undefined && Number.isFinite(climate.temperature)) return climate.temperature
      // Fallback until stepClimate is wired in: a temperate day from the sun angle.
      return 4 + 18 * daylight(world)
    }

    /**
     * Temperament for a species (row override, else role default).
     * @param {object} species - species row.
     * @returns {object} trait record.
     */
    function traitsOf(species) {
      return species.traits ?? ROLE_TRAITS[species.role] ?? ROLE_TRAITS.grazer
    }

    /**
     * The legacy need record of an entity, created on first use so restored
     * saves work. Written back by whoever consumes something (feed() clears
     * thirst when an animal drinks), and re-synced from the drives every tick.
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
     * The body view the decision system reads, with a fallback to the flat
     * `entity.energy` field so behaviour works before and after the 09b ledger
     * lands (docs/20-CORE-LOOP.md section 2.1).
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {{reserve: number, reserveMax: number, maturity: number, fatigue: number}} body view.
     */
    function bodyView(entity, species) {
      const body = entity.body
      const reserveMax = species === undefined ? 100 : species.balance.maxEnergy
      const reserve = body !== undefined && Number.isFinite(body.E) ? body.E : entity.energy
      const cap = body !== undefined && Number.isFinite(body.Emax) && body.Emax > 0 ? body.Emax : reserveMax
      const maturity = body !== undefined && Number.isFinite(body.M)
        ? clamp(body.M, 0, 1)
        : (entity.stage === 'juvenile' ? 0.35 : 1)
      const needs = needsOf(entity)
      const fatigue = body !== undefined && Number.isFinite(body.fatigue)
        ? clamp(body.fatigue, 0, 1)
        : clamp(needs.energy, 0, 1)
      return { reserve: Number.isFinite(reserve) ? reserve : 0, reserveMax: cap, maturity, fatigue }
    }

    /** Fatness of an animal: reserve as a share of its reserve ceiling. */
    function fatnessOf(body) {
      return clamp(body.reserve / Math.max(1e-6, body.reserveMax), 0, 1)
    }

    /**
     * Lifespan of one animal in seconds (gene first, species ceiling second).
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {number} seconds, or Infinity when unknown.
     */
    function lifespanOf(entity, species) {
      const gene = entity.genes === undefined ? undefined : entity.genes.lifespan
      if (Number.isFinite(gene)) return gene
      if (Array.isArray(gene)) return gene[1]
      const ranges = species.genes === undefined ? undefined : species.genes.lifespan
      return Array.isArray(ranges) ? ranges[1] : Infinity
    }

    /**
     * Life stage.
     *
     * Maturity is a fact about the BODY, not about the clock: an animal is an
     * adult when its structure has actually grown (body.M), and a stunted
     * animal that never grew up stays a juvenile however old it is. The old
     * age-based rule marked a 174 s rabbit as an elder while its body was 9%
     * adult — and since only adults may breed, it banned reproduction for more
     * than half of every species' life.
     *
     * Age only decides the other end: an elder is an animal past three quarters
     * of its own lifespan. Elders still breed (see stepEntity); being old is a
     * handicap, not a prohibition.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {'juvenile'|'adult'|'elder'} stage.
     */
    function stageOf(entity, species) {
      const lifespan = lifespanOf(entity, species)
      const aged = Number.isFinite(lifespan) && entity.age > lifespan * ELDER_LIFESPAN_SHARE
      const body = entity.body
      const grown = body === undefined || !Number.isFinite(body.M)
        ? entity.age >= species.balance.maturity
        : body.M >= ADULT_MATURITY_SHARE
      // Still growing AND still inside its species' maturation window: juvenile.
      // The second half matters: structural growth is capped by what the animal
      // can afford to eat, so a poorly fed rabbit can reach the end of its life
      // with a 13% body. Calling that a baby for life would ban it from breeding
      // for ever (measured on seed 12345: 279 of 282 rabbits, median maturity
      // 0.13) which empties the food web. A stunted animal is a stunted ADULT.
      if (!grown && entity.age < species.balance.maturity) return 'juvenile'
      return aged && grown ? 'elder' : 'adult'
    }

    /**
     * Age the channels that are ledgers rather than body readings.
     *
     * Hunger, fatigue, fear and the rest are derived in updateDrives(); thirst is
     * a water balance, so it accumulates here and is paid off by drinking (the
     * feeding code writes needs.thirst back down).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     */
    function decayNeeds(world, entity, species, dt) {
      const needs = needsOf(entity)
      const stage = stageOf(entity, species)
      const appetite = STAGE_APPETITE[stage] * entity.genes.metabolism
      // Thirst follows metabolic turnover, so a hot day and a big body both dry
      // an animal out faster. This is the one channel without a body field yet.
      const heat = 1 + clamp((climateTemperature(world) - 16) / 20, 0, 1) * 0.6
      needs.thirst = clamp(needs.thirst + (1 / THIRST_SECONDS) * appetite * heat * dt, 0, 1)
    }

    /**
     * Accrue or clear fatigue from the effort just spent.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @param {number} effort - pace multiplier this tick (0.12 resting .. 2 running).
     */
    function updateFatigue(entity, dt, effort) {
      const needs = needsOf(entity)
      const body = entity.body
      const resting = effort < 0.5
      // 09b owns body.fatigue once the ledger exists (it charges effort in
      // metabolise()), so the behaviour-side ledger is only a fallback for a
      // body-less animal. Writing both would make the panel and the decision
      // disagree by one tick.
      if (body === undefined || !Number.isFinite(body.fatigue)) {
        const rate = resting
          ? -FATIGUE_RECOVERY * (1 - effort * 0.4)
          : FATIGUE_PER_SECOND * Math.max(0.4, effort)
        needs.energy = clamp(needs.energy + rate * dt, 0, 1)
      }
      const belief = beliefOf(entity)
      if (belief.sites !== undefined) {
        // Habituation fades on its own: a bored animal eventually wants to look
        // around again, but not the instant it stopped.
        entity.habituation = Math.max(0, (entity.habituation ?? 0) - dt / HABITUATION_SECONDS)
      }
    }

    /**
     * Recompute all eight drives from the body and the situation.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     * @returns {object} the drive record (also stored on the entity).
     */
    function updateDrives(world, entity, species, dt) {
      const body = bodyView(entity, species)
      const fatness = fatnessOf(body)
      const traits = traitsOf(species)
      const needs = needsOf(entity)
      const now = world.time
      const belief = beliefOf(entity)

      // Hunger is the reserve emptying, full stop. Doing this is what removes
      // the "standing in a meadow, starving" class of bug.
      const hunger = clamp((1 - fatness - SATIETY_DEADBAND) / (1 - SATIETY_DEADBAND), 0, 1)

      // Thirst: the water ledger, which only drinking lowers.
      const thirst = clamp(needs.thirst, 0, 1)

      // Cold: air temperature against a comfortable band, softened by body fat.
      const temperature = climateTemperature(world)
      const cold = clamp(((4 - temperature) / 18), 0, 1) * (1 - 0.45 * fatness)

      // Fatigue: the body's own channel when 09b provides one.
      const fatigue = clamp(body.fatigue, 0, 1)

      // Fear: a predator in sight right now, plus the afterglow of the alarm.
      const vision = entity.genes.vision
      let fear = 0
      const threat = belief.threat
      if (beliefFresh(threat, now, BELIEF_LIFETIME.threat)) {
        const nerve = vision * (1.05 + traits.bold * 0.75)
        const distance = Math.hypot(threat.x - entity.x, threat.y - entity.y)
        fear = clamp(1 - distance / Math.max(1, nerve * 1.35), 0.2, 1)
      }
      const alarm = clamp((entity.alarm ?? 0) / ALARM_SECONDS, 0, 1) * 0.85
      entity.fear = Math.max(fear, alarm, (entity.fear ?? 0) - dt * 0.45)
      fear = clamp(entity.fear, 0, 1)

      // Social: how far the animal is from a full herd. Solitary species read
      // zero here instead of carrying a channel they can never satisfy.
      // A bout of socialising also sates the channel for a while: otherwise
      // company stays attractive forever and standing in the herd becomes an
      // absorbing state instead of something an animal does and then leaves.
      entity.socialSated = Math.max(0, (entity.socialSated ?? 0) - dt / SOCIAL_SATIATION_SECONDS)
      let social = 0
      if (species.herd !== undefined) {
        const crowd = species.herd.crowd ?? 4
        const lonely = clamp(1 - (entity.socialCount ?? 0) / crowd, 0, 1)
        const sated = clamp(entity.socialSated, 0, 1)
        social = lonely * clamp(traits.social, 0, 1) * (1 - sated * 0.75)
      }

      // Curiosity: only when fed, calm and not just back from a look around.
      // Juveniles get extra: dispersal away from the natal range is one of the
      // most universal patterns in nature, and it is also what stops a booming
      // cohort from grazing its own birth metre to dust.
      const habituation = clamp(entity.habituation ?? 0, 0, 1)
      const dispersal = entity.stage === 'juvenile' ? 1.5 : 1
      const curiosity = clamp(traits.curious, 0, 1)
        * clamp(1 - hunger * 0.85, 0, 1)
        * clamp(1 - fear, 0, 1)
        * clamp(fatness * 4, 0, 1)
        * (1 - habituation)
        * dispersal

      // Libido: grown (by life stage, not by body size alone) and fat enough to
      // spare the energy, and not on cooldown.
      const libido = (entity.stage === 'juvenile' ? 0 : 1)
        * clamp((fatness - 0.5) / 0.35, 0, 1)
        * (entity.cooldown > 0 ? 0 : 1)

      const drives = {
        hunger: clamp(hunger, 0, 1),
        thirst,
        cold: clamp(cold, 0, 1),
        fatigue,
        fear,
        social: clamp(social, 0, 1),
        curiosity: clamp(curiosity, 0, 1),
        libido: clamp(libido, 0, 1),
      }
      entity.drives = drives

      // Legacy view for the inspector and the older panels. `energy` here means
      // "needs rest", `safety` means "afraid", exactly what NEED_KEYS promises.
      needs.hunger = drives.hunger
      needs.thirst = drives.thirst
      needs.energy = drives.fatigue
      needs.safety = drives.fear
      needs.social = drives.social
      return drives
    }

    /**
     * Weight table for a species' role.
     * @param {object} species - species row.
     * @returns {object} drive weights.
     */
    function driveWeightsOf(species) {
      return DRIVE_WEIGHT[species.role] ?? DRIVE_WEIGHT.grazer
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
 * Why it exists: 0.2.x kept TWO books per animal — `entity.energy` for the
 * feeding code and `needs.hunger` for the decision code — and `decide()` never
 * read the first one. An animal could therefore stand on a lawn with an empty
 * reserve and a flat hunger channel until it died "of old age". Here the reserve
 * is the only state, and every other number a decision or a panel wants
 * (hunger, fatness, condition) is DERIVED from it by a getter, so the two books
 * cannot drift apart again.
 */
    // ---------------------------------------------------------------------
    // Body ledger
    // ---------------------------------------------------------------------

    /** Fraction of adult mass a newborn starts with. */
    const BIRTH_MASS_SHARE = 0.35
    /** Reserve at birth, as a share of the newborn capacity. */
    const BIRTH_RESERVE_SHARE = 0.4
    /** Reserve an adult is spawned with, as a share of capacity. */
    const SPAWN_RESERVE_SHARE = 0.7
    /** Peak tissue growth, as a multiple of the body's own maintenance power. */
    const GROWTH_RATE_CEILING = 4
    /** Reserve share below which a juvenile stops growing (it is starving). */
    const GROWTH_RESERVE_FLOOR = 0.3
    /** How fast a predator strips a carcass, as a multiple of its own upkeep. */
    const HANDLING_RATE = 2.5
    /**
     * Cumulative kJ written straight into a reserve by the legacy `energy`
     * accessor. The ledger does not spend it, so the audit counts it as energy
     * entering the system rather than pretending it was always there.
     */
    let directReserveDeposits = 0
    /**
     * Cumulative kJ a legacy assignment took OUT of a reserve without naming a
     * sink (breeding spends `balance.breedCost` this way). Counted as a drain so
     * the audit stays closed instead of reporting a phantom leak.
     */
    let directReserveWithdrawals = 0
    /**
     * Non-zero while the ledger itself is moving the reserve. Writes made at
     * depth 0 are somebody else's, and get counted; writes made inside
     * metabolise() are already on the books as respiration, growth or overflow.
     */
    let ledgerWriteDepth = 0

    /** Taxon → [allometric coefficient, exponent] for field metabolic rate. */
    const FMR_TABLE = {
      mammal: [BIO.FMR_MAMMAL_A, BIO.FMR_MAMMAL_B],
      bird: [BIO.FMR_BIRD_A, BIO.FMR_BIRD_B],
      ectotherm: [BIO.FMR_ECTO_A, BIO.FMR_ECTO_B],
    }

    /**
     * Field metabolic rate of a body, in kJ per in-world day (Nagy et al. 1999).
     * @param {object} species - species row (needs `taxon`).
     * @param {number} volume - body mass in kg wet.
     * @returns {number} maintenance power, kJ/day.
     */
    function fieldMetabolicRate(species, volume) {
      const row = FMR_TABLE[species?.taxon ?? 'mammal'] ?? FMR_TABLE.mammal
      // The floor is 0.1 g, not 1 g: a 60 mg frog hatchling has a real metabolic
      // rate, and flooring it at a gram made every amphibian litter unaffordable.
      const grams = Math.max(0.1, volume * 1000)
      return row[0] * Math.pow(grams, row[1])
    }

    /**
     * Reserve capacity of a body: RESERVE_DAYS days of its own metabolic rate.
     * A 2 kg rabbit therefore carries ~6 400 kJ, which is roughly its fat mass.
     * @param {object} species - species row.
     * @param {number} volume - body mass in kg wet.
     * @returns {number} capacity in kJ.
     */
    function reserveCapacity(species, volume) {
      return BIO.RESERVE_DAYS * fieldMetabolicRate(species, volume)
    }

    /**
     * Adult body mass a species matures into, in kg wet.
     * @param {object} species - species row.
     * @returns {number} kg.
     */
    function adultMassOf(species) {
      return species?.mass ?? 1
    }

    /**
     * How temperature scales an animal's metabolism.
     *
     * Ectotherms follow Q10 over the whole range: their body IS the weather.
     * Endotherms do not — Nagy's field metabolic rate is measured at a normal
     * body temperature, so a mammal only spends MORE energy once the air drops
     * below its lower critical temperature, and spends the same amount in mild
     * weather. Applying a plant-style Q10 to a rabbit's air temperature was
     * quietly halving its metabolism every cool spring day (2.5^-0.75 = 0.48 at
     * 12.5 C), which is why a "fed" herbivore read as half-starved.
     * @param {object} species - species row.
     * @param {number} temperature - felt temperature, degrees C.
     * @returns {number} multiplier on the field metabolic rate.
     */
    function metabolicTemperatureFactor(species, temperature) {
      if (species?.taxon === 'ectotherm') {
        return Math.pow(BIO.Q10, (temperature - BIO.Q10_REFERENCE_C) / 10)
      }
      // Lower critical temperature falls with body size: a mouse shivers at 20 C,
      // a bear barely notices 0 C.
      const mass = adultMassOf(species ?? {})
      const lowerCritical = 20 - 7 * Math.log10(mass + 1)
      if (temperature >= lowerCritical) return 1
      return 1 + 0.06 * (lowerCritical - temperature)
    }

    /**
     * Cold tolerance derived from body size, not from a per-species knob:
     * small bodies lose heat faster, so the lethal temperature rises with the
     * surface-to-volume ratio (Bergmann's rule as a formula).
     * @param {object} body - body record.
     * @param {object} species - species row.
     * @returns {number} temperature in degrees C below which the body suffers.
     */
    function coldLimitOf(body, species) {
      const mass = Math.max(0.005, body.V)
      const span = species?.habitat === 'water' ? 4 : 8
      const base = species?.habitat === 'water' ? 2 : -6
      return base - span * Math.pow(mass, 0.25)
    }

    /**
     * Create the ledger for an animal and wire the derived views onto it.
     *
     * Installs two compatibility bridges so legacy code keeps one book:
     *  - `entity.energy` becomes an accessor over `body.E` (kJ), because the
     *    renderer, the inspector and the breeding code all read it.
     *  - `entity.needs.hunger` becomes a getter over `1 - E/Emax`, because the
     *    decision system reads it and must never be able to disagree with the
     *    reserve. Writes to it are ignored on purpose.
     * @param {object} entity - the animal.
     * @returns {object} its body record.
     */
    function installLedger(entity) {
      if (entity.body !== undefined) return entity.body
      const species = SPECIES[entity.species] ?? { taxon: 'mammal', mass: 1 }
      const adult = adultMassOf(species)
      const birthMass = species.balance?.birthMass ?? adult * 0.05
      const maturity = Math.max(1, species.balance?.maturity ?? 60)
      const phase = clamp((entity.age ?? 0) / maturity, 0, 1)
      const volume = birthMass + (adult - birthMass) * phase
      const body = {
        /** Reserve capacity, kJ: grows with the structure. */
        Emax: reserveCapacity(species, volume),
        /** Structure, kg wet. Sets metabolism, strength and what a carcass is worth. */
        V: volume,
        /** Maturity 0..1; 1 means adult. */
        M: phase,
        /** 0..1 condition. Zero kills. */
        health: 1,
        /** 0..1 fatigue; accumulated by running, cleared by resting. */
        fatigue: 0,
        /** Terminal flag; the entity list drops the animal on the same tick. */
        dead: false,
        /** Why it died: starved | frozen | predation | old | disease | injury. */
        cause: '',
        /** Assimilated energy waiting to enter the reserve (previous tick's meal). */
        gut: 0,
        /** Injury timer in days; while > 0 health drains. */
        injury: 0,
        /** Maintenance power used by the last metabolise call, kJ/day. */
        pMetabolism: 0,
        /** Last activity multiplier, for the inspector. */
        activity: 1,
        /** Handling state while eating a kill: { energy, left } in kJ / seconds. */
        handling: null,
      }
      // The reserve itself lives in a closure cell behind an accessor. Any code
      // in the bundle — including a part sim-core does not own — can therefore
      // still write `body.E`, but it cannot do so without being counted. That is
      // what keeps "one ledger" true even while the rest of the engine migrates.
      let reserve = 0
      Object.defineProperty(body, 'E', {
        configurable: true,
        enumerable: true,
        get() { return reserve },
        set(value) {
          const next = Number.isFinite(value) ? clamp(value, 0, body.Emax) : 0
          if (ledgerWriteDepth === 0) {
            if (next > reserve) directReserveDeposits += next - reserve
            else if (next < reserve) directReserveWithdrawals += reserve - next
          }
          reserve = next
        },
      })
      // Seeding goes through the accessor on purpose: the reserve a body comes
      // into existence with is energy entering the world, and the audit has to
      // see it (callers restoring a save mute the ledger first).
      body.E = Number.isFinite(entity.energy) ? entity.energy : body.Emax * SPAWN_RESERVE_SHARE
      entity.body = body
      Object.defineProperty(entity, 'energy', {
        configurable: true,
        enumerable: false,
        get() { return body.E },
        set(value) {
          // Compatibility write (renderer, inspector, breeding code). It goes
          // through the ledger's own accessor, so it is clamped and counted.
          body.E = value
        },
      })
      // The need channels belong to the behaviour layer, but hunger is not a
      // channel: it IS the reserve, seen from the other end.
      const needs = entity.needs ?? { hunger: 0, thirst: 0.28, energy: 0.15, safety: 0, social: 0.3 }
      Object.defineProperty(needs, 'hunger', {
        configurable: true,
        enumerable: true,
        get() { return clamp(1 - body.E / (body.Emax || 1), 0, 1) },
        set() { /* derived view: writing it must not create a second book */ },
      })
      entity.needs = needs
      return body
    }

    /**
     * The body record of an animal, created on first use (old saves, newborns).
     * @param {object} entity - the animal.
     * @returns {object} body.
     */
    function bodyOf(entity) {
      return entity.body ?? installLedger(entity)
    }

    /**
     * How hard the body is working, as a multiplier on maintenance.
     * @param {object} entity - the animal.
     * @returns {number} multiplier.
     */
    function activityOf(entity) {
      const body = entity.body
      if (body !== undefined && body.handling !== null) return 0.7
      // Nagy's field metabolic rate already folds in a typical day's activity, so
      // these multipliers have to average near 1 for the daily intake to land on
      // the 182 g/day calibration. A resting animal still stands up, looks around
      // and digests: 0.7, not 0.55, or a sleepy population quietly reads as an
      // under-fed one.
      if (entity.fleeing === true || entity.running === true) return 1.8
      if (entity.intent === 'hunt' || entity.intent === 'scavenge') return 1.6
      if (entity.intent === 'rest') return 0.7
      return 1
    }

    /**
     * Advance the body by one step: absorb the last meal, pay maintenance, grow,
     * and turn an empty reserve or a cold night into lost health.
     *
     * This is the ONLY function allowed to move `body.E`. Everything a player
     * sees about energy (the fatness ring, the hunger bar, the death cause) is a
     * read of what happened here.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @returns {boolean} false when the animal died during this step.
     */
    function metabolise(world, entity, dt) {
      ledgerWriteDepth += 1
      try {
        return metaboliseInner(world, entity, dt)
      } finally {
        ledgerWriteDepth -= 1
      }
    }

    /**
     * The real body step. Only called from `metabolise`, which holds the
     * ledger-write flag so the reserve moves it makes are booked as respiration,
     * growth or overflow rather than as anonymous writes.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @returns {boolean} false when the animal died during this step.
     */
    function metaboliseInner(world, entity, dt) {
      const species = SPECIES[entity.species]
      if (species === undefined) return false
      const body = bodyOf(entity)
      if (body.dead === true) return false
      const days = dt / DAY_SECONDS

      // Assimilation lands in the reserve one step after the meal was taken: the
      // gut is a one-tick buffer, never a second ledger.
      if (body.gut !== 0) {
        // A big meal can overflow the reserve. The excess has to be booked here,
        // because the reserve accessor clamps and a silent clamp is exactly how a
        // joule goes missing.
        const total = body.E + body.gut
        body.gut = 0
        if (total > body.Emax) {
          world.budget.overflow += total - body.Emax
          body.E = body.Emax
        } else {
          body.E = total
        }
      }

      growBody(world, entity, species, body, days)

      const temperature = feltTemperature(world, species)
      const q10 = metabolicTemperatureFactor(species, temperature)
      const activity = activityOf(entity) * (entity.genes?.metabolism ?? 1)
      const fmr = fieldMetabolicRate(species, body.V)
      const pM = fmr * activity * q10
      body.pMetabolism = pM
      body.activity = activity
      // Only what the reserve could actually pay is respired: an animal that runs
      // dry is starving, it is not allowed to burn energy it does not have.
      const due = pM * days
      const paid = body.E > due ? due : Math.max(0, body.E)
      body.E -= paid
      world.budget.animalRespired += paid
      // Digesting a kill is work on top of standing still, but it is charged
      // through the same reserve so the ledger stays single-entry.
      if (body.handling !== null) {
        const corpse = body.handling.corpse
        if (corpse === undefined || corpse.removed === true || !(corpse.energy > 0)) {
          body.handling = null
        } else {
          // A predator strips a carcass at a few times its upkeep. Everything it
          // takes leaves the carcass pool and lands in the gut: the transfer is
          // exact, so a kill that is shared with crows still adds up.
          const bite = Math.min(corpse.energy, pM * HANDLING_RATE * days)
          corpse.energy -= bite
          corpse.mass = Math.max(0, (corpse.mass ?? 0) - bite / BIO.MEAT_ENERGY)
          body.gut += bite
          if (corpse.energy <= 1e-9) body.handling = null
        }
      }

      // Fatigue is a by-product of effort, and rest is the only cure. Behaviour
      // reads it to decide when to stop; it never drives energy itself.
      if (activity > 1.2) body.fatigue = Math.min(1, body.fatigue + dt / (0.6 * DAY_SECONDS))
      else body.fatigue = Math.max(0, body.fatigue - dt / (0.35 * DAY_SECONDS))

      const coldLimit = coldLimitOf(body, species)
      const cold = temperature < coldLimit
      if (body.E <= 0) {
        body.E = 0
        body.health -= BIO.STARVE_HEALTH_RATE * days
      } else if (body.E > body.Emax * 0.5 && !cold) {
        body.health = Math.min(1, body.health + BIO.HEAL_HEALTH_RATE * days)
      }
      if (cold) {
        const severity = clamp((coldLimit - temperature) / 10, 0, 2)
        body.health -= BIO.COLD_HEALTH_RATE * severity * days
      }
      if (body.injury > 0) {
        body.injury = Math.max(0, body.injury - days)
        body.health -= BIO.INJURY_HEALTH_RATE * days
      }
      body.health = clamp(body.health, 0, 1)
      // Anything above the ceiling cannot be stored; it is counted rather than
      // silently dropped, so the energy book still closes.
      if (body.E > body.Emax) {
        world.budget.overflow += body.E - body.Emax
        body.E = body.Emax
      }

      if (body.health <= 0) {
        dieOf(world, entity, body.E <= 0 ? 'starved' : cold ? 'frozen' : 'injury')
        return false
      }
      if (entity.age > entity.genes.lifespan) {
        dieOf(world, entity, 'old')
        return false
      }
      return true
    }

    /**
     * Structure growth, paid for out of the reserve at a price of kJ per kg.
     *
     * Two limits, and both are real:
     *  - the age clock caps how fast a body may grow (`balance.maturity`);
     *  - tissue synthesis burns at most GROWTH_RATE_CEILING x maintenance, which
     *    is what actually binds: a 2 kg rabbit can lay on ~0.27 kg of tissue a
     *    day, so reaching adult mass takes several in-world days, not one tick.
     * The energy that leaves the reserve is exactly the structure energy that
     * arrives, so growth is a transfer inside the energy book, never a creation.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} body - body record.
     * @param {number} days - step length in in-world days.
     */
    function growBody(world, entity, species, body, days) {
      const maturity = Math.max(1, species.balance?.maturity ?? 60)
      const phase = clamp((entity.age ?? 0) / maturity, 0, 1)
      const adult = adultMassOf(species)
      const birth = species.balance?.birthMass ?? adult * 0.05
      const target = birth + (adult - birth) * phase
      body.M = clamp((body.V - birth) / Math.max(1e-9, adult - birth), 0, 1)
      if (target <= body.V + 1e-12) return
      // A starving juvenile stalls instead of growing on credit.
      const spendable = body.E - body.Emax * GROWTH_RESERVE_FLOOR
      if (spendable <= 0) return
      const fmr = fieldMetabolicRate(species, body.V)
      const affordable = Math.min(spendable, GROWTH_RATE_CEILING * fmr * days)
      const gain = Math.min(target - body.V, affordable / BIO.STRUCTURE_COST)
      if (gain <= 0) return
      body.V += gain
      body.E -= gain * BIO.STRUCTURE_COST
      body.Emax = reserveCapacity(species, body.V)
      body.M = clamp((body.V - birth) / Math.max(1e-9, adult - birth), 0, 1)
    }

    /**
     * Deposit assimilated energy from a meal. The gut is drained by the next
     * `metabolise` call, so only one function ever touches the reserve itself.
     * @param {object} entity - the animal.
     * @param {number} kilojoules - assimilated energy to credit.
     * @returns {number} energy actually accepted (0 when the animal is dead).
     */
    function absorb(entity, kilojoules) {
      const body = bodyOf(entity)
      if (body.dead === true || !(kilojoules > 0)) return 0
      body.gut += kilojoules
      return kilojoules
    }

    /**
     * Take energy out of a reserve to pay for something the body made (a litter).
     *
     * This is an internal transfer, not a spend: the caller books the conversion
     * loss itself, so the ledger is muted while the reserve moves and the energy
     * does not get counted twice.
     * @param {object} entity - the payer.
     * @param {number} kilojoules - what it owes, kJ.
     * @returns {number} what it could actually pay, kJ.
     */
    function payFromReserve(entity, kilojoules) {
      const body = bodyOf(entity)
      if (!(kilojoules > 0) || body.dead === true) return 0
      const paid = Math.min(body.E, kilojoules)
      ledgerWriteDepth += 1
      try {
        body.E -= paid
      } finally {
        ledgerWriteDepth -= 1
      }
      return paid
    }

    /**
     * Wound an animal; the health cost is paid over the next days, not at once.
     * @param {object} entity - the animal.
     * @param {number} days - how long the wound keeps hurting.
     */
    function applyDamage(entity, days) {
      const body = bodyOf(entity)
      body.injury = Math.max(body.injury, Math.max(0, days))
    }

    /**
     * The single death entry point: records the cause, drops the animal from the
     * population counter and leaves a carcass whose mass and energy come from the
     * body that died (so a fat animal feeds more than a starved one).
     * @param {object} world - the world.
     * @param {object} entity - the dying animal.
     * @param {string} cause - starvation/freezing/predation/old age/disease.
     * @returns {object|null} the carcass it left, or null when it was already dead.
     */
    function dieOf(world, entity, cause) {
      const body = bodyOf(entity)
      if (body.dead === true) return null
      body.dead = true
      body.cause = String(cause ?? 'unknown')
      entity.fate = 'dead'
      entity.cause = body.cause
      for (let puff = 0; puff < 3; puff++) spawnEffect(world, entity.x, entity.y, PALETTE.effect.death, 0.5, 0.5)
      if (world.population !== undefined && world.population[entity.species] !== undefined) {
        world.population[entity.species] = Math.max(0, world.population[entity.species] - 1)
      }
      // A carcass is worth what the animal was: its reserve plus its edible
      // tissue. That is exactly the animal's entry in the world energy book, so
      // the transfer is neutral and a fat animal really does feed more.
      const structure = Math.max(0, body.V) * BIO.MEAT_ENERGY
      // Read the gut BEFORE clearing it: food that was in the animal when it died
      // is part of the carcass, not something the world may forget.
      const carried = body.E + (body.gut ?? 0)
      body.gut = 0
      const corpse = {
        id: world.nextId++,
        x: entity.x,
        y: entity.y,
        species: entity.species,
        decay: 0,
        energy: carried + structure,
        // Mass is the WHOLE body, the same basis the energy figure uses, so a
        // carcass does not claim to be meatier than it is.
        mass: Math.max(0, body.V),
        cause: body.cause,
      }
      world.corpses.push(corpse)
      if (world.corpses.length > MAX_CORPSES) {
        // The carcass table has a hard ceiling (the renderer and the UI both walk
        // it). A corpse evicted by that ceiling is energy leaving the world, so it
        // is booked as overflow instead of quietly disappearing.
        const evicted = world.corpses.shift()
        // A carcass the table has forgotten must not keep feeding the predator
        // that was still holding it, or its energy would be spent twice: once as
        // the overflow the eviction booked, and once as a meal.
        evicted.removed = true
        if (world.budget !== undefined) world.budget.overflow += evicted.energy
      }
      if (world.deaths === undefined) world.deaths = {}
      world.deaths[body.cause] = (world.deaths[body.cause] ?? 0) + 1
      world.lastDeath = { species: entity.species, cause: body.cause, at: world.time, x: entity.x, y: entity.y }
      return corpse
    }

    /**
     * Edible mass of a carcass in kg. Saves written before the ledger existed
     * carry no `mass`, so it is reconstructed from the species table.
     * @param {object} corpse - carcass record.
     * @returns {number} kg wet.
     */
    function carcassMass(corpse) {
      if (Number.isFinite(corpse.mass) && corpse.mass > 0) return corpse.mass
      const species = SPECIES[corpse.species]
      const adult = species === undefined ? 1 : adultMassOf(species)
      return adult * BIO.MEAT_FRACTION
    }


    /**
     * Energy in the world right now, in kJ, split by pool.
     *
     * The book is open by design: sunlight pumps energy in through GPP, and
     * respiration, mineralisation and reproduction are the named taps. What must
     * hold exactly is that no tick invents or loses a joule between the pools.
     * @param {object} world - the world.
     * @returns {{plants: number, detritus: number, carcasses: number, animals: number, total: number}} pools.
     */
    function energyPools(world) {
      let plants = 0
      let detritus = 0
      const size = world.grass.length
      for (let i = 0; i < size; i++) {
        plants += world.grass[i] + world.weed[i]
        detritus += world.detritus[i]
      }
      plants *= CELL_AREA * BIO.GRASS_ENERGY
      detritus *= CELL_AREA * BIO.GRASS_ENERGY
      let carcasses = 0
      for (const corpse of world.corpses) carcasses += corpse.energy
      let animals = 0
      for (const entity of world.entities) {
        const body = entity.body
        if (body === undefined || body.dead === true) continue
        // The gut counts too: a bite leaves the plant pool the instant it is
        // taken, and the animal carries it until the next metabolise call.
        animals += body.E + (body.gut ?? 0) + body.V * BIO.MEAT_ENERGY
      }
      return { plants, detritus, carcasses, animals, total: plants + detritus + carcasses + animals }
    }

    /**
     * Snapshot both the pools and the cumulative taps, for a before/after check.
     * @param {object} world - the world.
     * @returns {object} snapshot.
     */
    function snapshotEnergy(world) {
      return {
        pools: energyPools(world),
        budget: {
          ...world.budget,
          directDeposits: directReserveDeposits,
          directWithdrawals: directReserveWithdrawals,
        },
      }
    }

    /**
     * Residual of the energy book between two snapshots, in kJ and relative.
     *
     * residual = change in stored energy
     *          - (GPP + reproduction injected)   // named sources
     *          + (plant respiration + animal respiration + mineralisation + overflow)
     * A value near zero means every joule that moved was accounted for exactly
     * once (docs/20-CORE-LOOP.md invariant 2).
     * @param {object} before - snapshot from `snapshotEnergy`.
     * @param {object} after - snapshot from `snapshotEnergy`.
     * @returns {{kJ: number, relative: number, detail: object}} residual.
     */
    function energyResidual(before, after) {
      const deltaPools = after.pools.total - before.pools.total
      const injected = (after.budget.gpp - before.budget.gpp)
        + (after.budget.reproduction - before.budget.reproduction)
        + ((after.budget.directDeposits ?? 0) - (before.budget.directDeposits ?? 0))
      const drained = (after.budget.plantRespired - before.budget.plantRespired)
        + (after.budget.animalRespired - before.budget.animalRespired)
        + (after.budget.mineralised - before.budget.mineralised)
        + (after.budget.overflow - before.budget.overflow)
        + ((after.budget.directWithdrawals ?? 0) - (before.budget.directWithdrawals ?? 0))
      const kJ = deltaPools - injected + drained
      const scale = Math.max(1, Math.abs(before.pools.total), Math.abs(after.pools.total))
      return { kJ, relative: Math.abs(kJ) / scale, detail: { deltaPools, injected, drained } }
    }

    /**
     * A fresh set of cumulative energy taps. Every pool that can be entered or
     * left has a counter here, so a leak shows up as a residual instead of a
     * mystery.
     * @returns {object} budget.
     */
    function createBudget() {
      return {
        /** Energy fixed by the plants, kJ. The source term. */
        gpp: 0,
        /** Energy breathed out by plants, kJ. */
        plantRespired: 0,
        /** Energy breathed out by animals, kJ. */
        animalRespired: 0,
        /** Detritus turned into soil organic matter, kJ. */
        mineralised: 0,
        /** Energy injected as newborn bodies, kJ (gestation is not modelled). */
        reproduction: 0,
        /** Energy injected by a direct write to a reserve, kJ. */
        directDeposits: 0,
        /** Energy removed by a direct write to a reserve, kJ. */
        directWithdrawals: 0,
        /** Reserve clamped away because a body was over capacity, kJ. */
        overflow: 0,
        /** Gross plant matter bitten off, kJ. */
        grazed: 0,
        /** Gross animal matter bitten off, kJ. */
        carnivory: 0,
      }
    }

    /**
     * Fill in every derived energy number in the species table.
     *
     * It runs here, at the end of the contract part, because the derivation needs
     * the allometry declared above; the species table itself only carries the
     * design choices (docs/00-VISION.md: numbers come from physics, not balance).
     */
    deriveLifeHistory()
    deriveSpeciesEnergy()

    // ---------------------------------------------------------------------
    // Deliberation: utility scoring at state boundaries
    // ---------------------------------------------------------------------
    //
    // decide() is no longer called every few hundred milliseconds. It runs when
    // a bout ends, or when something urgent interrupts one, and it answers one
    // question: of the things this animal could do next, which is worth the
    // most? Every option is scored as
    //
    //   utility = sum over drives( weight x drive x opportunity ) - energy cost
    //
    // where the opportunity term is how well that action addresses the drive
    // (a full patch is better than a grazed one, a prey animal is better than
    // carrion), and the cost is the energy the trip itself will burn, converted
    // into the same units as hunger. Nothing here knows about species balance
    // knob-turning: the weights are role traits and the cost is drain/speed.

    /**
     * Energy in kJ an animal burns to walk a distance and then act for a while.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} distance - travel in cells.
     * @param {number} duration - seconds spent on the action itself.
     * @returns {number} kJ.
     */
    function tripCostKj(entity, species, distance, duration) {
      // kJ per second of upkeep. The body's field metabolic rate is the physical
      // number (Nagy 1999); the old flat drain is zero now that 09b owns the
      // ledger, so deriving it here is the only way the cost stays real.
      const body = entity.body
      const volume = body !== undefined && Number.isFinite(body.V) ? body.V : adultMassOf(species)
      const fmr = typeof fieldMetabolicRate === 'function'
        ? fieldMetabolicRate(species, volume)
        : Math.max(1, species.balance.maxEnergy) / 5
      const perSecond = (fmr / DAY_SECONDS) * (entity.genes.metabolism ?? 1)
      const speed = Math.max(0.4, entity.genes.speed)
      return perSecond * (distance / speed + duration)
    }

    /**
     * Turn a travel distance into the share of a bout it eats up.
     *
     * A trip is paid for in TIME, which is the budget a foraging animal actually
     * spends: a patch fifteen cells away is only worth it if it is close to
     * full value. Multiplying by this factor is what stops a walk across the
     * map for a marginally better bite, without banning long trips when the
     * animal is starving.
     * @param {number} distance - travel in cells.
     * @param {number} speed - cells per second.
     * @param {number} bout - planned seconds of the action itself.
     * @returns {number} 0..1 efficiency factor.
     */
    function tripEfficiency(distance, speed, bout) {
      const travel = distance / Math.max(0.4, speed)
      return bout / (bout + travel)
    }

    /**
     * A wander target that keeps going the way the animal was already going.
     *
     * Picking a random angle every time is what makes a walk look like a random
     * walk: the net displacement collapses toward zero no matter how fast the
     * animal moves. Keeping the current heading (with a small turn) gives a trip
     * a direction, which is what "it is going somewhere" looks like on screen.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} reach - how far ahead to aim.
     * @returns {{x: number, y: number}} target.
     */
    function wanderTarget(world, entity, species, reach) {
      const bearing = roamBearingOf(world, entity)
      let fallback = null
      for (let attempt = 0; attempt < 6; attempt++) {
        // First tries hug the bearing, the rest fan out: a fish pointed at the
        // bank has to be able to notice that the bank is not water, or it
        // spends its life pushing at the shoreline.
        const spread = attempt < 3 ? 0.35 : 1.3
        const distance = attempt < 3 ? reach : reach * 0.5
        const angle = bearing + randomBetween(world, -spread, spread)
        const x = clamp(entity.x + Math.cos(angle) * distance, 1, world.width - 2)
        const y = clamp(entity.y + Math.sin(angle) * distance, 1, world.height - 2)
        if (canStand(world, species, x, y)) return { x, y }
        if (fallback === null) fallback = { x, y }
      }
      // Nowhere legal in sight: stand still here rather than walk into a wall.
      return fallback ?? { x: entity.x, y: entity.y }
    }

    /**
     * The direction an animal is roaming in, kept across bouts.
     *
     * A walk whose every leg is aimed with a fresh random angle is a random walk
     * no matter how brisk it looks: the legs cancel out and the animal never
     * gets anywhere. An animal that holds a bearing for a few bouts, and only
     * turns a little at a time, covers ground in the direction it is facing —
     * which is what reads as going somewhere, and what makes a home range drift
     * with the seasons instead of wobbling around one cell.
     * @param {object} world - the world (needed for the edge rebound).
     * @param {object} entity - the animal.
     * @returns {number} bearing in radians.
     */
    function roamBearingOf(world, entity) {
      if (!Number.isFinite(entity.roamHeading)) entity.roamHeading = entity.heading
      return entity.roamHeading
    }

    /**
     * Turn the roam bearing by a small amount, and keep the animal on the map.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} delta - radians to turn (small).
     * @returns {void}
     */
    function steerRoam(world, entity, delta) {
      const margin = Math.max(8, Math.min(world.width, world.height) * 0.12)
      const nearEdge = entity.x < margin || entity.y < margin
        || entity.x > world.width - margin || entity.y > world.height - margin
      if (nearEdge) {
        // Walking into the frame edge is not a destination: turn back toward
        // the middle, with a little noise so a herd does not turn as one body.
        const homeward = Math.atan2(world.height / 2 - entity.y, world.width / 2 - entity.x)
        entity.roamHeading = homeward + randomBetween(world, -0.5, 0.5)
        return
      }
      entity.roamHeading = roamBearingOf(world, entity) + delta
    }
    /**
     * Score every action this animal could take right now.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {{options: object[], best: object|null}} scored options, best first.
     */
    function scoreOptions(world, entity, species, grids) {
      const drives = entity.drives ?? updateDrives(world, entity, species, TICK)
      const weights = driveWeightsOf(species)
      const genes = entity.genes
      const belief = beliefOf(entity)
      const now = world.time
      const hungerWeight = weights.hunger ?? 1
      const options = []

      /**
       * Record one candidate. The travel charge is subtracted here so every
       * option pays the same rate for the same distance.
       * @param {string} kind - intent id.
       * @param {number} gain - weighted drive satisfaction.
       * @param {number} x - target column.
       * @param {number} y - target row.
       * @param {string} why - which drive chose this (for the inspector).
       * @returns {void}
       */
      const offer = (kind, gain, x, y, why) => {
        const distance = Math.hypot(x - entity.x, y - entity.y)
        const plan = STATE_PLAN[kind] ?? STATE_PLAN.rest
        const bout = plan.duration[0]
        // Energy actually spent getting there, in hunger units, plus the share
        // of the bout the walk eats up.
        const cost = tripCostKj(entity, species, distance, bout * 0.5)
          * energyToDriveUnits(species) * hungerWeight
        const score = gain * tripEfficiency(distance, entity.genes.speed, bout) - cost
        if (score <= 0.005) return
        options.push({ kind, score, x, y, why, distance })
      }

      // --- fear: nothing is worth standing next to a predator ----------------
      if (drives.fear > 0.22) {
        const threat = belief.threat
        const threatX = threat === null ? entity.threatX : threat.x
        const threatY = threat === null ? entity.threatY : threat.y
        let x = entity.x
        let y = entity.y
        if (threatX !== undefined && threatY !== undefined) {
          const dx = entity.x - threatX
          const dy = entity.y - threatY
          const length = Math.hypot(dx, dy) || 1
          const reach = genes.vision * 1.6
          x = clamp(entity.x + (dx / length) * reach, 1, world.width - 2)
          y = clamp(entity.y + (dy / length) * reach, 1, world.height - 2)
        }
        // No travel charge: running away is not an investment, and a predator
        // sitting on the best food in the county must still win every comparison.
        options.push({ kind: 'flee', score: weights.fear * drives.fear * 1.2 + 0.3, x, y, why: 'fear', distance: 0 })
      }

      // --- thirst -----------------------------------------------------------
      if (species.habitat !== 'water' && drives.thirst > 0.12 && belief.water !== null) {
        offer('drink', weights.thirst * drives.thirst * 1.1, belief.water.x, belief.water.y, 'thirst')
      }

      // --- food -------------------------------------------------------------
      if (species.role === 'grazer') {
        const food = belief.food
        if (food !== null && food !== undefined) {
          const confidence = beliefConfidence(food, now, BELIEF_LIFETIME.food)
          // Opportunity quality: how much food is there, how sure are we, and how
          // long would a bite last. A grazed-out cell is a bad place to walk to.
          const quality = clamp((food.value ?? 0) * (0.55 + 0.45 * confidence) * 1.15, 0.12, 1.25)
          offer('forage', weights.hunger * drives.hunger * quality, food.x, food.y, 'hunger')
        } else if (drives.hunger > 0.25) {
          // Nothing edible is in sight and the reserve is draining: go look.
          // A frog eats water weed but lives on land, so looking for food means
          // heading for the water — wandering inland is how it starved with a
          // full pond two cells behind it.
          const landlocked = species.flora === 'weed' && species.habitat !== 'water'
          const pond = belief.water
          const spot = landlocked && pond !== null
            ? { x: pond.x, y: pond.y }
            : wanderTarget(world, entity, species, Math.min(40, genes.vision * (1.6 + drives.hunger * 1.6)))
          offer('explore', weights.hunger * drives.hunger * 0.6, spot.x, spot.y, 'search')
        }
      } else if (species.role === 'hunter') {
        const prey = belief.food
        if (prey !== null && prey !== undefined) {
          const quality = clamp(0.7 + (prey.value ?? 0.5) * 0.5, 0.4, 1.2)
          offer('hunt', weights.hunger * clamp(drives.hunger + 0.18, 0, 1) * quality, prey.x, prey.y, 'hunger')
        }
        const carrion = belief.carrion
        if (carrion !== null && carrion !== undefined) {
          offer('scavenge', weights.hunger * drives.hunger * 0.85, carrion.x, carrion.y, 'hunger')
        } else if (drives.hunger > 0.45 && (prey === null || prey === undefined)) {
          const spot = wanderTarget(world, entity, species, Math.min(40, genes.vision * 2.1))
          offer('explore', weights.hunger * drives.hunger * 0.55, spot.x, spot.y, 'search')
        }
      } else {
        const carrion = belief.carrion
        if (carrion !== null && carrion !== undefined) {
          offer('scavenge', weights.hunger * clamp(drives.hunger + 0.1, 0, 1) * (0.6 + carrion.value * 0.5),
            carrion.x, carrion.y, 'hunger')
        } else if (drives.hunger > 0.3) {
          const spot = wanderTarget(world, entity, species, Math.min(40, genes.vision * 2.2))
          offer('explore', weights.hunger * drives.hunger * 0.5, spot.x, spot.y, 'search')
        }
      }

      // --- rest: only worth it when tired, fed enough and not scared ---------
      const restGain = weights.fatigue * drives.fatigue
        * clamp(0.3 + 0.7 * (1 - drives.fear), 0, 1)
        * clamp(1 - (drives.hunger - 0.5) / 0.45, 0, 1)
        * (1 - drives.cold * 0.5)
      if (restGain > 0.01) options.push({ kind: 'rest', score: restGain, x: entity.x, y: entity.y, why: 'fatigue', distance: 0 })

      // --- company ----------------------------------------------------------
      const herd = species.herd
      if (herd !== undefined && entity.herdAnchor !== null && entity.herdAnchor !== undefined) {
        const separation = herd.separation ?? 3
        const ring = separation + (species.genes.size?.[1] ?? 1) * 2.6
        // Each animal owns a slot on the ring instead of all of them aiming at
        // the centroid, which is what used to pile a herd onto one cell.
        const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
        const x = clamp(entity.herdAnchor.x + Math.cos(angle) * ring, 1, world.width - 2)
        const y = clamp(entity.herdAnchor.y + Math.sin(angle) * ring * 0.75, 1, world.height - 2)
        // Company is capped: a full herd satisfies the channel, and mating
        // eagerness alone must never outbid food for a whole lifetime.
        const pull = weights.social
          * clamp(drives.social * 0.9 + Math.min(drives.libido, 0.6) * 0.5, 0, 0.8)
        if (pull > 0.01) offer('socialize', pull, x, y, drives.libido > drives.social ? 'libido' : 'social')
      }

      // --- curiosity --------------------------------------------------------
      if (drives.curiosity > 0.06) {
        const reach = Math.min(40, genes.vision * (1.2 + drives.curiosity * 2.4))
        const spot = wanderTarget(world, entity, species, reach)
        offer('explore', weights.curiosity * drives.curiosity, spot.x, spot.y, 'curiosity')
      }

      options.sort((a, b) => b.score - a.score)
      return { options, best: options[0] ?? null }
    }

    /**
     * Whether a drive has crossed the line where it may cut a bout short.
     *
     * This is the cheap per-tick guard: it reads numbers that are already on the
     * entity and never scores options. Full re-scoring only happens when one of
     * these fires (or when a bout ends on its own).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @returns {boolean} true when decide() should be woken early.
     */
    function interruptPending(world, entity) {
      const state = entity.state
      // No bout yet: the animal is between bouts and the think clock decides
      // when it starts one. Returning true here would overrun an intent that
      // was set from outside (a restored save, or a test that pins an intent).
      if (state === undefined) return false
      const drives = entity.drives
      if (drives === undefined) return false
      const klass = STATE_CLASS[state.id] ?? 0
      // A predator in sight ignores the commitment floor entirely.
      if (drives.fear > 0.5 && state.id !== 'flee') return true
      const elapsed = world.time - state.since
      if (elapsed < (state.min ?? 0)) return false
      if (drives.thirst > 0.85 && klass < STATE_CLASS.drink) return true
      if (drives.hunger > 0.92 && klass < 1) return true
      return false
    }

    /**
     * Start a new bout of the chosen action, with its own clock.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} option - the winning option.
     * @param {object[]} [rivals] - the options it beat (for the inspector).
     * @returns {void}
     */
    function startState(world, entity, species, option, rivals) {
      const plan = STATE_PLAN[option.kind] ?? STATE_PLAN.rest
      const duration = randomBetween(world, plan.duration[0], plan.duration[1])
      if (option.kind === 'explore') steerRoam(world, entity, randomBetween(world, -0.25, 0.25))
      entity.state = {
        id: option.kind,
        since: world.time,
        until: world.time + duration,
        min: plan.min,
        phase: 'approach',
        why: option.why ?? 'idle',
        score: option.score,
        x: option.x,
        y: option.y,
      }
      entity.thinkTimer = duration
      entity.intent = option.kind
      entity.intentScore = option.score
      entity.targetX = option.x ?? entity.x
      entity.targetY = option.y ?? entity.y
      entity.fleeing = option.kind === 'flee'
      if (entity.fleeing) entity.flightTime = entity.flightTime ?? 0
      else entity.flightTime = 0
      // The inspector's "why": what was chosen, what it beat, and what the
      // animal wanted at that moment. Kept after the bout ends so the panel can
      // explain the last decision instead of only the current one.
      entity.decision = {
        at: world.time,
        picked: option.kind,
        score: Math.round(option.score * 1000) / 1000,
        why: option.why ?? 'idle',
        target: { x: option.x ?? entity.x, y: option.y ?? entity.y },
        alternatives: (rivals ?? []).slice(0, 3).map(rival => ({
          kind: rival.kind,
          score: Math.round(rival.score * 1000) / 1000,
        })),
        drives: entity.drives === undefined ? null : {
          hunger: Math.round(entity.drives.hunger * 100) / 100,
          thirst: Math.round(entity.drives.thirst * 100) / 100,
          cold: Math.round(entity.drives.cold * 100) / 100,
          fatigue: Math.round(entity.drives.fatigue * 100) / 100,
          fear: Math.round(entity.drives.fear * 100) / 100,
          social: Math.round(entity.drives.social * 100) / 100,
          curiosity: Math.round(entity.drives.curiosity * 100) / 100,
          libido: Math.round(entity.drives.libido * 100) / 100,
        },
      }
      // A plan is the sentence the inspector shows: walk there, then do the
      // thing. One step per phase is enough for now; the array shape is the
      // contract (docs/20-CORE-LOOP.md 2.3) so later systems can add steps.
      entity.plan = {
        goal: option.kind,
        index: 0,
        steps: [
          { x: option.x ?? entity.x, y: option.y ?? entity.y, act: option.kind, duration },
        ],
      }
    }

    /**
     * Keep the current bout but re-aim it at a better version of the same thing.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} option - the refreshed winner.
     * @returns {void}
     */
    function continueState(world, entity, species, option) {
      const plan = STATE_PLAN[option.kind] ?? STATE_PLAN.rest
      const duration = randomBetween(world, plan.duration[0], plan.duration[1])
      entity.state.since = world.time
      entity.state.until = world.time + duration
      entity.state.phase = 'approach'
      entity.state.score = option.score
      entity.state.why = option.why ?? 'idle'
      entity.state.x = option.x
      entity.state.y = option.y
      entity.thinkTimer = duration
      entity.targetX = option.x ?? entity.x
      entity.targetY = option.y ?? entity.y
      entity.intentScore = option.score
    }

    /**
     * Choose the next action, or keep the current one on its clock.
     *
     * Called at a state boundary or on an interrupt (see interruptPending).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {void}
     */
    function decide(world, entity, species, grids) {
      const scored = scoreOptions(world, entity, species, grids)
      const current = entity.state
      const best = scored.best
      if (best === null) {
        // Nothing scores: an animal with no want sits down. This is the only
        // zero-score state and it is honest — it means every drive is satisfied.
        startState(world, entity, species, { kind: 'rest', score: 0.02, x: entity.x, y: entity.y, why: 'idle' })
        return
      }
      if (current === undefined) {
        startState(world, entity, species, best, scored.options.slice(1))
        return
      }
      const sameKind = current.id === best.kind
      const rivals = scored.options.filter(option => option.kind !== current.id)
      if (sameKind) {
        // Same answer: keep going, with a fresh clock and a better target.
        continueState(world, entity, species, best)
        return
      }
      const currentScore = bestByKind(scored.options, current.id)
      const klassGap = (STATE_CLASS[best.kind] ?? 0) - (STATE_CLASS[current.id] ?? 0)
      const expired = world.time >= current.until
      const committed = world.time - current.since < (current.min ?? 0)
      // Hysteresis: a rival has to be clearly better, not merely ahead. This is
      // what makes the intent dwell worth watching instead of a twitch.
      const clearlyBetter = best.score > currentScore * STATE_HYSTERESIS + STATE_MARGIN
      // Only survival may cut a bout short: being killed or dried out cannot
      // wait out a nap. An OPPORTUNITY (food, a hunt) does not get to interrupt
      // an intrinsic bout — food is always somewhere, so that permission would
      // mean no bout ever runs its course.
      const survivalCut = klassGap >= 2
      const mayCut = expired || (klassGap > 0 && (survivalCut || !committed))
      if (mayCut && (clearlyBetter || expired)) {
        startState(world, entity, species, best, rivals)
        return
      }
      // Otherwise the animal stays with what it was doing and finishes the bout.
      current.score = Math.max(current.score, best.score)
      entity.thinkTimer = Math.max(0.5, current.until - world.time)
    }

    /**
     * Score recorded for one kind among the scored options (0 when absent).
     * @param {object[]} options - scored options.
     * @param {string} kind - intent id.
     * @returns {number} that kind's best score.
     */
    function bestByKind(options, kind) {
      for (const option of options) if (option.kind === kind) return option.score
      return 0
    }

/**
 * Execution: the state machine that turns a goal into timed action.
 *
 * OWNER: behaviour
 *
 * A state is a bout: a thing the animal is doing, with a clock, a completion
 * condition and a commitment floor. decide() only runs at a boundary or on an
 * interrupt; between those the animal *keeps doing the thing* — which is the
 * difference between a creature and a reaction field.
 *
 * Interrupt priority (docs/20-CORE-LOOP.md 2.3, table in 08-sim-constants):
 *   flee > survive (drink) > opportunity (forage/hunt/scavenge) > intrinsic
 *
 * Completion is per state, and every one of them can end three ways: the need
 * that opened the bout is satisfied, the bout's planned time runs out, or the
 * animal stops making progress toward the target. The third one is what stops a
 * rabbit pacing a shoreline for a minute because its patch was across the lake.
 */
    // ---------------------------------------------------------------------
    // Execution: timed states with completion conditions
    // ---------------------------------------------------------------------

    /** Seconds between re-aim checks inside a state. */
    const AIM_INTERVAL = 0.5

    /** Patch quality below which the animal has cropped the ground bare. */
    const CROPPED_SWARD = 0.12

    /** Seconds of no progress before a state gives up and re-decides. */
    const PROGRESS_WINDOW = 1.3
    /** Consecutive stalled windows before the animal abandons its target. */
    const PROGRESS_STALLS = 2

    /**
     * The closest edible cell right around an animal's feet.
     *
     * This is the "head down, keep grazing" loop: while a forage bout runs, the
     * animal steps from cell to cell in place instead of re-deciding every time
     * it finishes a bite. Cheap by construction — 9 cells, not a scan.
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @returns {{x: number, y: number, value: number}|null} the best nearby bite.
     */
    function bestLocalBite(world, entity, species) {
      const field = floraField(world, species)
      if (field === null) return null
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const originX = Math.round(entity.x)
      const originY = Math.round(entity.y)
      let best = null
      let bestScore = 0.02
      for (let offsetY = -2; offsetY <= 2; offsetY++) {
        for (let offsetX = -2; offsetX <= 2; offsetX++) {
          const cellX = originX + offsetX
          const cellY = originY + offsetY
          const index = cellIndex(world, cellX, cellY)
          if (index < 0 || world.terrain[index] !== wanted) continue
          const available = field[index]
          if (available <= 0.004) continue
          if (!canStand(world, species, cellX + 0.5, cellY + 0.5)) continue
          const quality = swardQuality(available)
          const distance = Math.hypot(offsetX, offsetY)
          const score = quality - distance * 0.1
          if (score > bestScore) { bestScore = score; best = { x: cellX + 0.5, y: cellY + 0.5, value: quality } }
        }
      }
      return best
    }

    /**
     * Quality of the sward directly under an animal's feet (0 when it is
     * standing on the wrong terrain or the cell is bare).
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @returns {number} 0..1 quality.
     */
    function swardUnderfoot(world, entity, species) {
      const field = floraField(world, species)
      if (field === null) return 0
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const index = cellIndex(world, entity.x, entity.y)
      if (index < 0 || world.terrain[index] !== wanted) return 0
      return swardQuality(field[index])
    }
    /**
     * Give an animal that has an intent but no clock (a restored save, a
     * hand-placed test animal) a bout it can run out.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @returns {object} the state.
     */
    function adoptState(world, entity) {
      const id = INTENT_IDS.includes(entity.intent) ? entity.intent : 'explore'
      const plan = STATE_PLAN[id] ?? STATE_PLAN.explore
      // Never shorter than the floor: a resumed bout is still a bout, and a
      // bout that ends under its own commitment time is the twitch this whole
      // part exists to remove.
      const until = Math.max(entity.thinkTimer ?? 0, plan.min)
      entity.state = {
        id,
        since: world.time,
        until: world.time + until,
        min: plan.min,
        phase: 'adopted',
        why: 'resume',
        score: 0,
        x: entity.targetX,
        y: entity.targetY,
        adopted: true,
      }
      entity.fleeing = id === 'flee'
      return entity.state
    }

    /**
     * Whether the animal has stopped closing on its target this window.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} state - the current state.
     * @returns {boolean} true when the target has proved unreachable.
     */
    function stalledAt(world, entity, state) {
      const now = world.time
      const remaining = Math.hypot(entity.targetX - entity.x, entity.targetY - entity.y)
      if (state.checkAt === undefined) {
        state.checkAt = now + PROGRESS_WINDOW
        state.checkDistance = remaining
        return false
      }
      if (now < state.checkAt) return false
      const gained = (state.checkDistance ?? remaining) - remaining
      state.checkDistance = remaining
      state.checkAt = now + PROGRESS_WINDOW
      state.stalls = gained < 0.06 ? (state.stalls ?? 0) + 1 : 0
      return state.stalls >= PROGRESS_STALLS
    }

    /**
     * Re-aim the current bout when the thing it is aimed at has moved.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} state - the current state.
     * @returns {void}
     */
    function reaim(world, entity, species, state) {
      const now = world.time
      if (now < (state.aimAt ?? 0)) return
      state.aimAt = now + AIM_INTERVAL
      const belief = beliefOf(entity)
      if (state.id === 'flee') {
        const threat = belief.threat
        const threatX = threat === null ? entity.threatX : threat.x
        const threatY = threat === null ? entity.threatY : threat.y
        if (threatX === undefined || threatY === undefined) return
        const dx = entity.x - threatX
        const dy = entity.y - threatY
        const length = Math.hypot(dx, dy) || 1
        const reach = entity.genes.vision * 1.6
        state.x = clamp(entity.x + (dx / length) * reach, 1, world.width - 2)
        state.y = clamp(entity.y + (dy / length) * reach, 1, world.height - 2)
        entity.targetX = state.x
        entity.targetY = state.y
        return
      }
      if (state.id === 'hunt' || state.id === 'scavenge') {
        const target = state.id === 'hunt' ? belief.food : belief.carrion
        if (target !== null && target !== undefined) { state.x = target.x; state.y = target.y }
        entity.targetX = state.x
        entity.targetY = state.y
        return
      }
      if (state.id === 'drink') {
        const water = belief.water
        if (water !== null) { state.x = water.x; state.y = water.y; entity.targetX = state.x; entity.targetY = state.y }
        return
      }
      if (state.id === 'socialize') {
        const herd = species.herd
        const anchor = entity.herdAnchor
        if (herd === undefined || anchor === null || anchor === undefined) return
        const ring = (herd.separation ?? 3) + (species.genes.size?.[1] ?? 1) * 2.6
        const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
        state.x = clamp(anchor.x + Math.cos(angle) * ring, 1, world.width - 2)
        state.y = clamp(anchor.y + Math.sin(angle) * ring * 0.75, 1, world.height - 2)
        entity.targetX = state.x
        entity.targetY = state.y
      }
    }

    /**
     * Advance the animal's current bout by one tick.
     *
     * Writes entity.intent from the state id (the renderer and the inspector
     * read that field), keeps the target aimed, and ends the bout when its
     * completion condition is met. It never calls decide(): that is stepEntity's
     * job at the next boundary, which is what keeps the two apart.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @param {number} dt - step in seconds.
     * @returns {void}
     */
    function execute(world, entity, species, grids, dt) {
      const state = entity.state === undefined ? adoptState(world, entity) : entity.state
      const drives = entity.drives
      const now = world.time
      entity.intent = state.id
      entity.fleeing = state.id === 'flee'
      // An adopted bout has no known goal: keep it alive until its clock runs
      // out, and let the next deliberation take over from there.
      if (state.adopted === true) {
        entity.targetX = state.x ?? entity.targetX
        entity.targetY = state.y ?? entity.targetY
        if (now >= state.until) { entity.state = undefined; entity.thinkTimer = 0 }
        return
      }

      let done = false
      const hunger = drives === undefined ? 0.3 : drives.hunger
      const thirst = drives === undefined ? 0 : drives.thirst
      const fear = drives === undefined ? 0 : drives.fear
      const fatigue = drives === undefined ? 0 : drives.fatigue

      if (state.id === 'flee') {
        reaim(world, entity, species, state)
        // The bout ends when the animal has calmed down, not on a timer: the
        // alarm afterglow is what decides, so a peek-and-bolt reads as one.
        done = fear < 0.3
      } else if (state.id === 'forage') {
        const local = bestLocalBite(world, entity, species)
        const standing = swardUnderfoot(world, entity, species)
        const distanceToPlan = Math.hypot(state.x - entity.x, state.y - entity.y)
        if (standing >= CROPPED_SWARD) {
          // Standing on good grass: put the head down and STAY. Stepping to a
          // neighbouring cell every tick is how a grazing animal accumulated a
          // long path without going anywhere.
          state.phase = 'do'
          entity.targetX = entity.x
          entity.targetY = entity.y
          if (local !== null) rememberFood(entity, local.x, local.y, local.value, now)
        } else if (local !== null && (distanceToPlan < 2.5 || local.value > 0.55)) {
          // This cell is cropped: step to the best bite next to it.
          state.phase = 'do'
          entity.targetX = local.x
          entity.targetY = local.y
          rememberFood(entity, local.x, local.y, local.value, now)
        } else if (distanceToPlan > 0.9) {
          state.phase = 'approach'
          entity.targetX = state.x
          entity.targetY = state.y
        } else {
          state.phase = 'do'
          entity.targetX = entity.x
          entity.targetY = entity.y
          // Arrived, nothing left to eat here: this patch is spent.
          if (local === null) done = true
        }
        if (hunger < 0.12) done = true
        // A cropped cell pays almost nothing under Holling II, so standing on it
        // is pointless: move on to a better patch. Without this an animal keeps
        // its head down on a bare cell and its whole life's path is spent
        // shuffling inside one metre.
        if (local !== null && local.value < CROPPED_SWARD && hunger > 0.2) done = true
      } else if (state.id === 'hunt' || state.id === 'scavenge') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.2 ? 'approach' : 'do'
        // Arrived and the prey is gone: the ambush failed, think again.
        const current = state.id === 'hunt' ? beliefOf(entity).food : beliefOf(entity).carrion
        if (distance <= 1.2 && (current === null || current === undefined)) done = true
        if (hunger < 0.1) done = true
      } else if (state.id === 'drink') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.2 ? 'approach' : 'do'
        if (state.phase === 'do') {
          // Standing at the bank: check that drinking is actually working. An
          // animal that cannot reach the water must abandon the attempt, not
          // stand there until the bout timer runs out and try again.
          if (state.thirstAtDo === undefined) {
            state.thirstAtDo = thirst
            state.doSince = now
          } else if (now - state.doSince > 2 && thirst > state.thirstAtDo - 0.02) {
            done = true
          }
        }
        if (thirst < 0.12) done = true
      } else if (state.id === 'rest') {
        // Resting marks the ground as home: this is where the animal comes back
        // to, and what makes a warren a place instead of a coordinate.
        const belief = beliefOf(entity)
        if (belief.home === null) belief.home = { x: entity.x, y: entity.y, t: now }
        state.phase = 'do'
        entity.targetX = entity.x
        entity.targetY = entity.y
        done = fatigue < 0.12
      } else if (state.id === 'socialize') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.5 ? 'approach' : 'do'
        // Close enough to the herd, or arrived at its own slot: the animal got
        // what it came for. The channel is marked sated so it goes back to its
        // own business instead of orbiting the herd for the rest of its life.
        const herd = species.herd
        const crowd = herd === undefined ? 0 : (herd.crowd ?? 4)
        if (distance <= 1.5 || (entity.socialCount ?? 0) >= crowd) {
          entity.socialSated = 1
          done = true
        }
      } else if (state.id === 'explore') {
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.5 ? 'approach' : 'do'
        if (distance <= 1.5) {
          // Arrived, but the bout is not over: pick the next leg from here, in
          // the direction the animal is already facing. A walk that re-rolls
          // its angle on every arrival is a random walk however fast it moves;
          // three legs of the same heading is a trip.
          const reach = Math.min(40, entity.genes.vision * (1.2 + (drives === undefined ? 0.2 : drives.curiosity) * 2.4))
            * (entity.stage === 'juvenile' ? 1.4 : 1)
          const ahead = wanderTarget(world, entity, species, reach)
          state.x = ahead.x
          state.y = ahead.y
          entity.targetX = ahead.x
          entity.targetY = ahead.y
          state.legs = (state.legs ?? 0) + 1
          if (state.legs >= 3) {
            // Curiosity is spent for a while (habituation), so the animal does
            // not immediately pick another random direction.
            entity.habituation = 1
            done = true
          }
        }
      }

      if (state.phase === 'approach' && stalledAt(world, entity, state)) done = true
      if (now >= state.until) done = true
      // The commitment floor applies to EVERY ending, not just to rivals: a
      // bout that starts and stops inside half a second is the twitch this
      // whole part exists to remove. Only a predator (flee) or the end of the
      // scheduled bout may finish before the floor.
      if (done && now - state.since < (state.min ?? 0) && now < state.until) done = false
      if (done) {
        entity.state = undefined
        entity.thinkTimer = 0
        entity.stateEndedAt = now
      }
    }

    // ---------------------------------------------------------------------
    // Feeding: Holling type II functional response
    // ---------------------------------------------------------------------
    //
    // Intake is not a per-species "eatRate" any more. The animal's DEMAND falls
    // out of its body mass (maintenance / assimilation efficiency / energy
    // density), the SUPPLY falls out of the local biomass, and the functional
    // response stitches them together:
    //
    //   intake(B) = I_max * B / (K + B)          Holling type II
    //
    // with the two constants fixed by the physics instead of chosen:
    //   I_max = INTAKE_CEILING * requirement     (peak intake, x upkeep)
    //   K     = (INTAKE_CEILING - 1) * GRAZE_REFERENCE
    //
    // The reference is the sward density at which intake equals upkeep, i.e. the
    // height a grazed lawn settles to. Everything above it is surplus, and
    // surplus is what pays for growth and for filling a breeding reserve: an
    // animal that only ever breaks even never matures.
    //
    // Consequences that matter to the player: a grazer on a bare cell starves
    // even with grass in sight, a depleted patch pays less than a lush one (so
    // there is a reason to walk), and the daily dry matter intake of a 2 kg
    // rabbit comes out at ~182 g — the calibration number in
    // docs/10-SCALE-AND-UNITS.md — without any species row carrying it.

    /** Reference sward density, kg dry matter/m^2, where intake is 2/3 of max. */
    const GRAZE_REFERENCE = 0.12
    /** Peak intake as a multiple of the animal's own maintenance requirement. */
    const INTAKE_CEILING = 5

    /**
     * Gross dry matter intake rate at a given local biomass, kg per day.
     * @param {number} requirement - kg of dry matter per day to break even.
     * @param {number} biomass - standing crop where the animal is standing, kg/m^2.
     * @returns {number} intake, kg/day (gross, before digestion).
     */
    function grazingIntake(requirement, biomass) {
      if (!(biomass > 0) || !(requirement > 0)) return 0
      return INTAKE_CEILING * requirement * biomass / ((INTAKE_CEILING - 1) * GRAZE_REFERENCE + biomass)
    }

    /**
     * Dry matter per day a body must take in GROSS to pay its own metabolism.
     *
     * intake = FMR / assimilation / energyDensity. A 2 kg rabbit needs 1 276 kJ
     * of maintenance, digests 40% of what it bites off, and each kg of grass
     * holds 17 500 kJ, so it must bite 0.182 kg per day. That is the rabbit
     * calibration in the design doc, derived instead of copied.
     * @param {object} species - species row.
     * @param {number} volume - body mass, kg.
     * @returns {number} kg of dry matter per in-world day.
     */
    function dryMatterRequirement(species, volume) {
      const assimilation = species.balance?.assimilation ?? BIO.ASSIMILATION_HERBIVORE
      return fieldMetabolicRate(species, volume) / assimilation / BIO.GRASS_ENERGY
    }

    /**
     * Credit one bite to the animal and the rest to the soil.
     *
     * Gross energy splits into what the gut assimilates (into the reserve) and
     * what it does not (out as dung, into the detritus under the animal). Both
     * halves are accounted, which is what keeps the world's energy book closed.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} grossKj - energy content of what was bitten off, kJ.
     * @returns {number} assimilated energy, kJ.
     */
    function consumeBite(world, entity, species, grossKj) {
      if (!(grossKj > 0)) return 0
      const assimilation = species.balance?.assimilation ?? BIO.ASSIMILATION_HERBIVORE
      const assimilated = grossKj * assimilation
      absorb(entity, assimilated)
      depositDung(world, entity.x, entity.y, grossKj - assimilated)
      world.budget.grazed += grossKj
      return assimilated
    }

    /**
     * Start eating a carcass: the predator commits to standing there until it is
     * done. This is the handling time that turns a kill into a process, and it is
     * the reason a predator cannot mow down a whole herd in one second.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} corpse - what it is eating.
     */
    function startHandling(world, entity, corpse) {
      const body = bodyOf(entity)
      body.handling = { corpse }
      // It is not going anywhere: keep the legs still for the next think ticks.
      entity.targetX = entity.x
      entity.targetY = entity.y
    }

    /**
     * Feed one animal: graze a producer field, catch prey, or scavenge a corpse.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @param {number} dt - step in seconds.
     */
    function feed(world, entity, species, grids, dt) {
      const balance = species.balance
      const needs = needsOf(entity)
      const body = bodyOf(entity)
      if (body.dead === true) return
      const days = dt / DAY_SECONDS
      // A predator that is still working through a kill does not hunt, and an
      // animal with its head down does not wander: digestion is charged by
      // metabolise(), here we only refuse to start something new.
      if (body.handling !== null) {
        entity.targetX = entity.x
        entity.targetY = entity.y
        return
      }

      // --- drinking --------------------------------------------------------
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
            // Water carries no usable energy: drinking clears thirst and nothing
            // else. The old code paid the animal 0.4 kJ/s for standing at the
            // shore, which quietly broke the ledger.
            needs.thirst = clamp(needs.thirst - 0.85 * dt, 0, 1)
            return
          }
        }
      }

      if (species.role === 'grazer') {
        // Opportunistic grazing: an animal standing in good grass nibbles even
        // while it is resting or watching the herd — otherwise it starves in a
        // meadow, which is what a strict intent gate caused.
        if (entity.intent !== 'forage' && needs.hunger < 0.35) return
        const field = floraField(world, species)
        if (field === null) return
        const index = cellIndex(world, entity.x, entity.y)
        const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
        if (index >= 0 && world.terrain[index] === wanted) {
          const available = field[index]
          if (available > 0) {
            // `available` is kg per SQUARE METRE and the intake curve is kg per
            // ANIMAL per day, so the bite is divided by the cell area before it
            // is taken off the field. Getting this wrong quietly multiplies the
            // whole herbivore appetite by four.
            const requirement = dryMatterRequirement(species, body.V)
            const bite = Math.min(available, grazingIntake(requirement, available) * days / CELL_AREA)
            if (bite > 0) {
              field[index] = available - bite
              consumeBite(world, entity, species, bite * CELL_AREA * BIO.GRASS_ENERGY)
              if (nextRandom(world) < 0.06) {
                const nibble = species.flora === 'weed' ? PALETTE.effect.nibble : PALETTE.effect.eat
                spawnEffect(world, entity.x, entity.y + 0.4, nibble, 0.3, 0.35)
              }
              return
            }
          }
        }
        // Browsers strip the canopy after the ground is bare, on the same
        // functional response: a chewed-out bush pays almost nothing.
        if (species.browse === true) {
          const plant = nearestFoliage(world, entity, 1.6)
          if (plant !== null && plant.foliage > 0) {
            const requirement = dryMatterRequirement(species, body.V)
            const bite = Math.min(plant.foliage, grazingIntake(requirement, plant.foliage) * days / CELL_AREA)
            if (bite > 0) {
              plant.foliage -= bite
              consumeBite(world, entity, species, bite * CELL_AREA * BIO.GRASS_ENERGY)
            }
          }
        }
        return
      }

      if (species.role === 'hunter') {
        const victim = nearestPrey(entity, species, grids.prey, balance.catchRadius ?? 1.2)
        if (victim !== null && victim.body?.dead !== true && victim.fate === '') {
          // The carcass carries the prey's REAL body energy, reserve included, so
          // a starving rabbit is a poor meal (docs/10 section 5).
          const corpse = dieOf(world, victim, 'predation')
          if (corpse !== null) {
            const inWater = terrainAt(world, victim.x, victim.y) === TERRAIN.WATER
            if (inWater) {
              spawnEffect(world, victim.x, victim.y, PALETTE.effect.splash, 0.26, 1.9)
              spawnEffect(world, victim.x, victim.y, PALETTE.effect.splashDark, 0.3, 1.6)
              spawnEffect(world, victim.x, victim.y, PALETTE.effect.bubble, 0.55, 0.35, true)
            } else {
              for (let spark = 0; spark < 5; spark++) spawnEffect(world, victim.x, victim.y, PALETTE.effect.hunt, 0.42, 1.4)
            }
            startHandling(world, entity, corpse)
          }
          return
        }
        // A predator that is not on a kill will take carrion rather than nothing.
        if (needs.hunger > 0.2) {
          const corpse = nearestCorpse(world, entity.x, entity.y, 1.6)
          if (corpse !== null && corpse.energy > 0) startHandling(world, entity, corpse)
        }
        return
      }

      // Scavenger: carrion from further away than a hunter would bother with.
      const corpse = nearestCorpse(world, entity.x, entity.y, balance.scavengeRadius ?? 1.5)
      if (corpse !== null && corpse.energy > 0) startHandling(world, entity, corpse)
    }

    /**
     * One animal's full tick.
     *
     * The order is the design (docs/20-CORE-LOOP.md section 1):
     *   perceive -> updateDrives -> deliberate -> execute -> feed -> move
     * Perception and drives come first because a decision that reads a stale
     * body state is exactly how the 0.2.x build ended up with animals starving
     * in a meadow: the intent never knew the reserve was empty.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {boolean} false when the animal died this tick.
     */
    function stepEntity(world, entity, dt, grids) {
      const species = SPECIES[entity.species]
      if (species === undefined) return false
      const balance = species.balance
      const genes = entity.genes
      // A predator may have bitten this animal earlier in the same tick. It must
      // die before feed() runs, otherwise it would graze back the energy the
      // predator already took and stay alive with fate === 'eaten' forever.
      if (entity.fate === 'eaten' || entity.body?.dead === true) {
        dieOf(world, entity, entity.body?.dead === true ? (entity.body.cause || 'predation') : 'predation')
        return false
      }
      // While a predator is working through a kill it stands still: the carcass
      // is being eaten, not carried. The flag is set here and honoured by the
      // pace chain below (pace 0), so the animal keeps perceiving and thinking
      // while its legs stay planted — pinning its target every tick made it
      // jitter in place for the whole handling time.
      entity.handling = entity.body !== undefined && entity.body.handling !== null
      entity.prevX = entity.x
      entity.prevY = entity.y
      entity.age += dt
      entity.cooldown = Math.max(0, entity.cooldown - dt)
      entity.alarm = Math.max(0, (entity.alarm ?? 0) - dt)
      entity.herdTimer = (entity.herdTimer ?? 0) - dt
      entity.stage = stageOf(entity, species)

      // 1. Ledgers that are not body readings (the water balance).
      decayNeeds(world, entity, species, dt)
      // 2. The eight drives, derived from the body and the situation.
      updateDrives(world, entity, species, dt)
      // 3. What the animal can actually see, on its own staggered ~1 Hz slot.
      perceive(world, entity, species, grids, dt)
      // 4. Deliberate only at a boundary or on an interrupt — not every tick.
      // A freshly spawned animal has no intent yet, so it has to be allowed to
      // make its first decision instead of adopting an empty bout for its
      // spawn clock (which used to produce a fake one-second intent).
      entity.thinkTimer -= dt
      const firstDecision = entity.state === undefined && entity.intent === undefined
      if (entity.thinkTimer <= 0 || firstDecision || interruptPending(world, entity)) {
        decide(world, entity, species, grids)
      }
      // 5. Run the chosen bout: aim, keep doing the thing, finish it.
      execute(world, entity, species, grids, dt)

      feed(world, entity, species, grids, dt)
      const activity = activityFactor(world, species)
      const stageSpeed = STAGE_SPEED[entity.stage] ?? 1
      let pace
      if (entity.handling === true) {
        // Head down over a kill: no travel, no gait, no wander.
        entity.targetX = entity.x
        entity.targetY = entity.y
        pace = 0
      } else if (entity.intent === 'rest') {
        // Resting is visible: the animal stops and the fatigue bar recovers.
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
      // Fatigue is paid for by the effort actually spent, so a grazing bout
      // tires an animal far less than a sprint does.
      updateFatigue(entity, dt, entity.fleeing ? 1.8 : pace)
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
      // Metabolism is 09b's ledger, called just before this function from
      // stepEntities(); behaviour must never write body.E or charge a second
      // drain, or an animal would pay for existing twice. Every animal has a
      // ledger (spawnEntity installs one), so there is no second death path:
      // starvation, cold and old age all end in metabolise() -> dieOf().
      const body = entity.body
      const hasBody = body !== undefined && Number.isFinite(body.E)
      const territory = species.territory
      const ownGrid = species.role === 'hunter' ? grids.hunter : grids.prey
      const crowded = territory !== undefined && countNearby(ownGrid, entity.x, entity.y, territory.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species) >= territory.max
      // Juveniles are still growing and do not reproduce; elders do, because
      // real animals breed until senescence and forbidding it turned every
      // species sterile for the back half of its life. Old age shows up as a
      // longer recovery instead. The reserve gate is relative to the animal's
      // OWN capacity, so a growing body is not asked for an adult's reserve.
      const breedTarget = balance.maxEnergy > 0
        ? balance.breedEnergy * clamp((hasBody ? body.Emax : balance.maxEnergy) / balance.maxEnergy, 0, 1.2)
        : balance.breedEnergy
      const breedReserve = hasBody ? body.E : entity.energy
      const mature = entity.stage === 'adult' || entity.stage === 'elder'
      if (!crowded && mature && breedReserve >= breedTarget && entity.cooldown <= 0) {
        // A litter, not a single pup: rabbits drop 4-7 kits at once, wolves 3-5.
        const range = balance.litter ?? [1, 1]
        const litterSize = range[0] + Math.floor(nextRandom(world) * (range[1] - range[0] + 1))
        let born = 0
        for (let index = 0; index < litterSize; index++) {
          const childX = clamp(entity.x + randomBetween(world, -1.1, 1.1), 0.5, world.width - 1.5)
          const childY = clamp(entity.y + randomBetween(world, -1.1, 1.1), 0.5, world.height - 1.5)
          if (!canStand(world, species, childX, childY)) continue
          // The parent is named so the ledger can charge the litter to the body
          // that made it: a newborn's structure is transferred tissue, not
          // energy invented by the world. Its reserve is spawnEntity's call.
          const child = spawnEntity(world, entity.species, childX, childY,
            mutateGenes(world, genes, entity.species), entity.generation + 1,
            { parent: entity, juvenile: true })
          if (child === null) break
          born += 1
        }
        if (born > 0) {
          for (let heart = 0; heart < 3; heart++) spawnEffect(world, entity.x, entity.y - 0.5, PALETTE.effect.birth, 0.8, 0.5)
          if (hasBody) body.E = Math.max(0, body.E - balance.breedCost)
          else entity.energy -= balance.breedCost
          // An elder is slower to recover, which is what "reduced fertility"
          // means without banning it outright.
          entity.cooldown = genes.fertility * (entity.stage === 'elder' ? 1.6 : 1)
          entity.children += born
        }
      }
      return true
    }


    // ---------------------------------------------------------------------
    // Producers, detritus and the world step
    // ---------------------------------------------------------------------
    //
    // The producer fields are MASS, not a 0..1 prettiness scalar: kg of dry
    // matter per square metre (docs/10-SCALE-AND-UNITS.md section 2). Every cell
    // runs the same balance every time its slice comes round:
    //
    //   d(grass)/dt = GPP - respiration - litter - grazing
    //
    // GPP is limited by the light that actually reaches the cell (Beer-Lambert
    // through its own canopy and through the trees above it), by soil water and
    // by the soil nutrient index. Respiration and litter are proportional to the
    // standing crop. Nothing in that list is tuned per cell, so the standing crop
    // EMERGES and differs from place to place — a shaded cell under a tree, a dry
    // rise and a damp hollow all settle at different heights. That patchiness is
    // the reason a grazer has anywhere to walk to; the old uniform 0.96 field gave
    // it none.

    /** Vegetation is refreshed in this many interleaved slices (see below). */
    const PRODUCER_SLICES = 16
    /** Canopy shade is rebuilt at most this often (ticks), even without a hint. */
    const CANOPY_REBUILD_TICKS = 60
    /** Share of a carcass that rots away per corpse-lifetime. */
    const CARCASS_ROT_RATE = 3.2
    /** Depth (0 bank .. 1 mid-lake) where aquatic plants start thinning. */
    const DEPTH_WEED_START = 0.08
    /** Depth at which the lake bed carries no plants at all: open water. */
    const DEPTH_WEED_LIMIT = 0.45

    /**
     * Recompute the extra leaf area the woody plants cast over the ground.
     *
     * Trees are few (thousands) and cells are many (655k), so the shade field is
     * accumulated when the forest changes instead of every tick. Anything that
     * plants or removes a tree only has to set `world.canopyDirty`.
     * @param {object} world - the world.
     */
    function rebuildCanopy(world) {
      const canopy = world.canopy
      canopy.fill(0)
      for (const plant of world.trees) {
        let radius = 1
        let lai = BIO.BUSH_LAI
        if (plant.variant === 'tree') { radius = 1 + (plant.size | 0); lai = BIO.TREE_LAI }
        else if (plant.variant === 'bush') { radius = 1; lai = BIO.BUSH_LAI }
        else if (plant.variant === 'reed') { radius = 1; lai = 0.6 }
        else { radius = 1; lai = 0.5 }
        const leafy = plant.foliage === undefined ? 1 : clamp(plant.foliage, 0, 1)
        const strength = lai * leafy
        const r2 = radius * radius
        const cx = plant.x | 0
        const cy = plant.y | 0
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const d2 = dx * dx + dy * dy
            if (d2 > r2) continue
            const index = cellIndex(world, cx + dx, cy + dy)
            if (index < 0) continue
            // Quadratic falloff: the middle of a crown is dark, the rim is dappled.
            canopy[index] += strength * (1 - d2 / (r2 + 0.5))
          }
        }
      }
      world.canopyDirty = false
    }

    /**
     * One producer cell, one slice: mineralise the detritus under it, work out
     * the light it receives, then run GPP - respiration - litter.
     * @param {object} world - the world.
     * @param {number} index - cell index.
     * @param {Float32Array} field - this producer's biomass field, kg/m^2.
     * @param {object} params - PRODUCERS row.
     * @param {number} water - soil water 0..1 for this cell.
     * @param {number} days - slice-adjusted step, in in-world days.
     */
    function updateProducerCell(world, index, field, params, water, days, suitability = 1) {
      const current = field[index]
      const nutrientField = field === world.weed ? world.waterFertility : world.fertility
      let soil = nutrientField[index]

      // --- detritus -> soil index ---------------------------------------
      const dung = world.detritus[index]
      if (dung > 0) {
        const mineralised = Math.min(dung, DETRITUS.mineralise * dung * days)
        world.detritus[index] = dung - mineralised
        world.budget.mineralised += mineralised * CELL_AREA * BIO.GRASS_ENERGY
        soil = Math.min(1, soil + mineralised * DETRITUS.nutrientPerKg)
      }

      // --- light reaching this cell -------------------------------------
      const lai = current * BIO.LEAF_AREA_PER_KG + world.canopy[index]
      const light = world.climate.sunlight * Math.exp(-BIO.LIGHT_EXTINCTION * lai)
      world.light[index] = light

      // --- losses first, so the cell can never go negative ----------------
      const q10 = Math.pow(BIO.Q10, ((world.climate.temperature - BIO.Q10_REFERENCE_C) / 10))
      const respired = params.resp * current * q10 * days
      const littered = params.litter * current * days
      world.budget.plantRespired += respired * CELL_AREA * BIO.GRASS_ENERGY
      let next = current - respired - littered
      if (next < 0) next = 0
      // Litter is not lost: it becomes the detritus the soil will recycle.
      if (littered > 0) {
        // `littered` is already kg per square metre, the same unit the detritus
        // field holds. Dividing by CELL_AREA here used to make three quarters of
        // the litter vanish, which is exactly the kind of leak the audit exists
        // to catch.
        const cell = world.detritus[index] + littered
        if (cell > DETRITUS.bmax) {
          world.budget.overflow += (cell - DETRITUS.bmax) * CELL_AREA * BIO.GRASS_ENERGY
          world.detritus[index] = DETRITUS.bmax
        } else {
          world.detritus[index] = cell
        }
      }

      // --- gross primary production --------------------------------------
      if (light > 0 && suitability > 0) {
        const waterFactor = water / (water + params.waterHalf)
        const nutrientFactor = soil / (soil + params.nutrientHalf)
        const gross = TUNING.productivity * params.mu * (next + params.seed)
          * light * waterFactor * nutrientFactor * suitability * days
        const cap = params.bmax * suitability
        const grown = next + gross > cap ? cap : next + gross
        world.budget.gpp += (grown - next) * CELL_AREA * BIO.GRASS_ENERGY
        next = grown
        // Uptake is proportional to how much was actually built, so a slow cell
        // does not drain the soil it cannot use.
        soil = Math.max(0, soil - gross * DETRITUS.nutrientPerGrowth)
      }
      // Above its habitat limit (deep water for weed, bare rock for grass) the
      // excess dies back into litter rather than being clipped: it is still mass
      // and still energy, so it goes to the detritus under the cell.
      const habitatCap = params.bmax * suitability
      if (next > habitatCap) {
        const diesBack = next - habitatCap
        const cell = world.detritus[index] + diesBack
        if (cell > DETRITUS.bmax) {
          world.budget.overflow += (cell - DETRITUS.bmax) * CELL_AREA * BIO.GRASS_ENERGY
          world.detritus[index] = DETRITUS.bmax
        } else {
          world.detritus[index] = cell
        }
        next = habitatCap
      }
      nutrientField[index] = soil
      field[index] = next
    }

    /**
     * Refresh the producer fields one slice per tick.
     *
     * Refreshing 655k cells every tick costs more than the entire rest of the
     * simulation; each cell is therefore updated on one tick in PRODUCER_SLICES
     * with a slice-sized dt, which gives the same average rate for a sixteenth of
     * the work. Slicing is why a freshly painted patch takes a few ticks to react
     * rather than one.
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function stepProducers(world, dt) {
      const slice = world.tick % PRODUCER_SLICES
      const days = (dt * PRODUCER_SLICES) / DAY_SECONDS
      const grass = world.grass
      const weed = world.weed
      const terrain = world.terrain
      const moisture = world.moisture
      for (let index = slice; index < terrain.length; index += PRODUCER_SLICES) {
        const ground = terrain[index]
        if (ground === TERRAIN.GRASS) {
          if (weed[index] !== 0) weed[index] = 0
          updateProducerCell(world, index, grass, PRODUCERS.grass, moisture[index], days)
        } else if (ground === TERRAIN.WATER) {
          if (grass[index] !== 0) grass[index] = 0
          // A lake is not a lawn: weed needs the bottom to be within reach of
          // light. Depth runs 0 at the bank to 1 in the middle of the lake, and
          // the bed stops carrying plants at DEPTH_WEED_LIMIT. Without this the
          // whole lake grew a uniform green carpet and read as a mint pond.
          const depth = world.depth[index]
          const suitability = clamp(1 - (depth - DEPTH_WEED_START) / (DEPTH_WEED_LIMIT - DEPTH_WEED_START), 0, 1)
          updateProducerCell(world, index, weed, PRODUCERS.weed, 1, days, suitability)
        } else {
          if (grass[index] !== 0) grass[index] = 0
          if (weed[index] !== 0) weed[index] = 0
          world.light[index] = world.climate.sunlight
        }
      }
    }

    /**
     * Corpses rot into the detritus pool under them.
     *
     * A carcass is a store of energy that predators, scavengers and the soil all
     * compete for. Whatever is left when the rot timer runs out goes back into
     * the ground, which is the only path by which animal matter returns to the
     * plants (docs/20-CORE-LOOP.md step 4).
     * @param {object} world - the world.
     * @param {number} dt - step in seconds.
     */
    function stepDetritus(world, dt) {
      let write = 0
      for (let i = 0; i < world.corpses.length; i++) {
        const corpse = world.corpses[i]
        corpse.decay = (corpse.decay ?? 0) + dt / TUNING.corpseSeconds
        const gone = corpse.decay >= 1
        const rot = gone ? corpse.energy : corpse.energy * Math.min(1, (dt * CARCASS_ROT_RATE) / TUNING.corpseSeconds)
        if (rot > 0) {
          const before = corpse.energy
          corpse.energy = Math.max(0, before - rot)
          const mass = carcassMass(corpse)
          corpse.mass = Math.max(0, mass * (corpse.energy / Math.max(1e-9, before)))
          const index = cellIndex(world, corpse.x, corpse.y)
          if (index >= 0) {
            // Converted through plant energy density so the detritus pool holds
            // exactly the joules the carcass gave up: rot is neutral to the book.
            const added = world.detritus[index] + (before - corpse.energy) / (CELL_AREA * BIO.GRASS_ENERGY)
            if (added > DETRITUS.bmax) {
              world.budget.overflow += (added - DETRITUS.bmax) * CELL_AREA * BIO.GRASS_ENERGY
              world.detritus[index] = DETRITUS.bmax
            } else {
              world.detritus[index] = added
            }
          }
        }
        if (!gone && corpse.energy > 0) world.corpses[write++] = corpse
      }
      world.corpses.length = write
    }

    /**
     * Drop a handful of dung at a position: the unassimilated part of a meal.
     * @param {object} world - the world.
     * @param {number} x - column.
     * @param {number} y - row.
     * @param {number} kilojoules - energy content of the dung.
     */
    function depositDung(world, x, y, kilojoules) {
      if (!(kilojoules > 0)) return
      const index = cellIndex(world, x, y)
      if (index < 0) return
      const added = world.detritus[index] + kilojoules / BIO.GRASS_ENERGY / CELL_AREA
      if (added > DETRITUS.bmax) {
        world.budget.overflow += (added - DETRITUS.bmax) * CELL_AREA * BIO.GRASS_ENERGY
        world.detritus[index] = DETRITUS.bmax
      } else {
        world.detritus[index] = added
      }
    }

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
          world.canopyDirty = true
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
        world.canopyDirty = true
      }
    }

    /**
     * Life under the surface: bubbles off the weed and the odd shimmer.
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

    /** Seconds between immigration checks. */
    const IMMIGRATION_INTERVAL = [45, 85]

    /**
     * Safety net: a species that has been wiped out (or nearly) gets a small
     * group wandering in from off-map.
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
        // The group has to be sized off the species' own floor, not a flat
        // 4-8: a flat group is meaningless for a species whose minimum is 1
        // (every death triggers a flood that multiplies the population) and it
        // is below a fifth of a rabbit-sized floor. Half the floor, at least 1.
        const group = clamp(Math.round(minimum * 0.5) + ((nextRandom(world) * 3) | 0), 1, 8)
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
     * Update every animal for one tick.
     *
     * Order matters and is the contract (docs/20-CORE-LOOP.md section 1): the
     * body pays for existing first, then `stepEntity` decides, moves and feeds.
     * Metabolism therefore never depends on what the animal managed to eat in
     * the same tick, which is what makes a starved animal actually starve.
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
        if (entity.fate === 'dead') continue
        // The body pays for being alive before the animal gets to act on it.
        if (!metabolise(world, entity, dt)) continue
        if (stepEntity(world, entity, dt, grids)) existing[write++] = entity
      }
      const newborns = existing.slice(count)
      existing.length = write
      for (const newborn of newborns) existing.push(newborn)
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
      // 1. the sky, before anything that depends on light or temperature.
      stepClimate(world, step)
      // 2. shade, when the forest moved or every so often as a safety net.
      if (world.canopyDirty === true || world.tick % CANOPY_REBUILD_TICKS === 0) rebuildCanopy(world)
      // 3. corpses back into the soil, 4. the producers, then 5. the animals.
      stepDetritus(world, step)
      stepProducers(world, step)
      growTrees(world, step)
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
 */
    // ---------------------------------------------------------------------
    // Climate
    // ---------------------------------------------------------------------

    /** Sunrise and sunset as fractions of the in-world day (06:00 and 18:00). */
    const SUNRISE_PHASE = 0.25
    const SUNSET_PHASE = 0.75
    /** Annual mean temperature and the half-amplitude of the seasonal swing, C. */
    const CLIMATE_MEAN_C = 12.5
    const CLIMATE_SEASON_AMPLITUDE_C = 13.5
    /** Diurnal swing around the daily mean, C: warm at noon, cold before dawn. */
    const CLIMATE_DIURNAL_AMPLITUDE_C = 5
    /**
     * How much of the diurnal swing the water feels. A lake is a heat sink: it
     * lags the air and barely moves over a day, which keeps fish from freezing
     * on a winter night the way a bare air formula would make them.
     */
    const WATER_THERMAL_DAMPING = 0.25
    /**
     * Which in-world day the year starts on. Day 1 should be spring, not the
     * dead of winter: a fresh world has to look alive in its first seconds.
     */
    const SEASON_DAY_OFFSET = 2

    /**
     * Evaluate the sky at one instant. Pure: a save only needs the clock, never
     * the climate, because the weather is recomputed from time.
     * @param {object} climate - record to fill in place.
     * @param {number} time - in-world seconds since the start.
     */
    function applyClimate(climate, time) {
      const dayIndex = Math.floor(time / DAY_SECONDS)
      const dayPhase = ((time % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS / DAY_SECONDS
      const yearPhase = (((dayIndex + SEASON_DAY_OFFSET) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS / YEAR_DAYS
      // Sun height: half a sine between sunrise and sunset, exactly zero at
      // night. This is the only place the day/night curve is written down.
      const arc = (dayPhase - SUNRISE_PHASE) / (SUNSET_PHASE - SUNRISE_PHASE)
      const sunHeight = arc <= 0 || arc >= 1 ? 0 : Math.sin(Math.PI * arc)
      // Season: +1 at midsummer (yearPhase 0.5), -1 at midwinter.
      const season = Math.cos(2 * Math.PI * (yearPhase - 0.5))
      // Light at the TOP of the canopy: sun height scaled by how high the sun
      // climbs on this date, so a winter noon is a weak noon.
      const sunlight = clamp(sunHeight * (0.55 + 0.45 * season), 0, 1)
      const dailyMean = CLIMATE_MEAN_C + CLIMATE_SEASON_AMPLITUDE_C * season
      const diurnal = CLIMATE_DIURNAL_AMPLITUDE_C * (sunHeight - 0.5)
      climate.t = time
      climate.day = dayIndex + 1
      climate.dayPhase = dayPhase
      climate.yearPhase = yearPhase
      climate.season = season
      climate.sunlight = sunlight
      climate.temperature = dailyMean + diurnal
      climate.waterTemperature = dailyMean + diurnal * WATER_THERMAL_DAMPING
    }

    /**
     * A fresh climate record (world creation and save restore both use it).
     * @param {number} [time] - in-world seconds.
     * @returns {object} climate.
     */
    function createClimate(time = 0) {
      const climate = {
        /** In-world seconds since the world started. */
        t: time,
        /** In-world day number, 1-based. */
        day: 1,
        /** 0..1 position inside the current day (0 = midnight). */
        dayPhase: 0,
        /** 0..1 position inside the current year (0 = midwinter). */
        yearPhase: 0,
        /** Air temperature, degrees C, at this instant. */
        temperature: CLIMATE_MEAN_C,
        /** Water temperature, degrees C: the air swing damped by the lake. */
        waterTemperature: CLIMATE_MEAN_C,
        /** Surface light reaching the top of the canopy, 0..1. */
        sunlight: 0,
        /** -1 midwinter .. +1 midsummer; the season as one number. */
        season: 0,
      }
      applyClimate(climate, time)
      return climate
    }

    /**
     * Advance the climate by one step (docs/20-CORE-LOOP.md step 1).
     * @param {object} world - the world.
     * @param {number} [dt] - step in seconds; unused, the clock is `world.time`.
     */
    function stepClimate(world, dt) {
      if (world.climate === undefined) world.climate = createClimate(world.time)
      else applyClimate(world.climate, world.time)
    }

    /**
     * Temperature an animal actually feels, C: air for terrestrial bodies, the
     * damped lake temperature for anything living in the water.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {number} degrees C.
     */
    function feltTemperature(world, species) {
      const climate = world.climate
      if (climate === undefined) return BIO.Q10_REFERENCE_C
      return species?.habitat === 'water' ? climate.waterTemperature : climate.temperature
    }

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
    // Persistence (save format 2)
    // ---------------------------------------------------------------------
    //
    // A 1024x640 world is 655,360 cells. Five quantised fields at one byte per
    // cell is 3.3 MB of JSON text before base64, which does not fit a
    // localStorage quota. Three things keep the save small:
    //
    //  1. Only fields that carry state are written. Moisture, depth, light and
    //     the canopy are recomputed from the terrain and the clock on load.
    //  2. Each field is bit-packed to the precision it needs (8 bits for the
    //     producer biomass the player actually sees, 4 for the slow indices).
    //     The scale of every field is stored in the header, so a field that
    //     happens to be full gets the full dynamic range of its bits.
    //  3. The payload is gzipped with CompressionStream where the host has it,
    //     and falls back to plain JSON with the coarser bit packing where it
    //     does not. Either way the player is told what happened; a save is
    //     never dropped silently (0.2.x did exactly that).

    /** Save format version lives in 00-preamble (LEAD scope): one number, two files would drift. */
    /** Marker in front of a gzipped payload, so a load can tell the two apart. */
    const SAVE_GZIP_PREFIX = 'gz:'

    /** Bits per field in each detail level: [index fields, mass fields]. */
    const FIELD_BITS = {
      full: { fertility: 8, waterFertility: 4, grass: 8, weed: 8, detritus: 4 },
      low: { fertility: 4, waterFertility: 4, grass: 4, weed: 4, detritus: 4 },
    }

    /**
     * Bytes → base64, chunked so a multi-megabyte payload never blows the stack.
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
     * Pack a float field into `bits` per cell, against an explicit scale.
     * @param {Float32Array} field - source values.
     * @param {number} bits - 4 or 8.
     * @param {number} scale - value that maps to the top of the range.
     * @returns {Uint8Array} packed bytes.
     */
    function packField(field, bits, scale) {
      const levels = (1 << bits) - 1
      const inverse = scale > 0 ? levels / scale : 0
      if (bits === 8) {
        const out = new Uint8Array(field.length)
        for (let i = 0; i < field.length; i++) {
          const value = field[i] * inverse
          out[i] = value <= 0 ? 0 : value >= levels ? levels : value | 0
        }
        return out
      }
      const out = new Uint8Array((field.length + 1) >> 1)
      for (let i = 0; i < field.length; i += 2) {
        const a = field[i] * inverse
        const hi = a <= 0 ? 0 : a >= levels ? levels : a | 0
        let byte = hi
        if (i + 1 < field.length) {
          const b = field[i + 1] * inverse
          const lo = b <= 0 ? 0 : b >= levels ? levels : b | 0
          byte |= lo << 4
        }
        out[i >> 1] = byte
      }
      return out
    }

    /**
     * Unpack a field written by `packField`.
     * @param {string} text - base64 bytes.
     * @param {number} size - expected cell count.
     * @param {number} bits - 4 or 8.
     * @param {number} scale - value the top of the range stands for.
     * @param {Float32Array} [target] - array to fill, when it already exists.
     * @returns {Float32Array} field.
     */
    function unpackField(text, size, bits, scale, target) {
      const bytes = decodeBytes(text, Uint8Array)
      const out = target !== undefined && target.length === size ? target : new Float32Array(size)
      const levels = (1 << bits) - 1
      if (bits === 8) {
        if (bytes.length !== size) throw new Error('bad field length in world save')
        const factor = scale / levels
        for (let i = 0; i < size; i++) out[i] = bytes[i] * factor
        return out
      }
      if (bytes.length !== (size + 1) >> 1) throw new Error('bad packed field length in world save')
      const factor = scale / levels
      for (let i = 0; i < size; i++) {
        const byte = bytes[i >> 1]
        const nibble = (i & 1) === 0 ? byte & 0x0f : byte >> 4
        out[i] = nibble * factor
      }
      return out
    }

    /**
     * Largest value in a field, used as that field's packing scale.
     * @param {Float32Array} field - source.
     * @returns {number} max (never zero).
     */
    function fieldScale(field) {
      let max = 0
      for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i]
      return max > 0 ? max : 1
    }

    /**
     * Serialize a world to a JSON-safe object (format 2).
     * @param {object} world - the world.
     * @param {{detail?: 'full'|'low'}} [options] - packing detail.
     * @returns {object} save payload.
     */
    function serializeWorld(world, options = {}) {
      const bits = FIELD_BITS[options.detail === 'low' ? 'low' : 'full']
      const scales = {
        fertility: 1,
        waterFertility: 1,
        grass: fieldScale(world.grass),
        weed: fieldScale(world.weed),
        detritus: fieldScale(world.detritus),
      }
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
        immigrationTimer: world.immigrationTimer ?? null,
        budget: world.budget === undefined ? null : { ...world.budget },
        deaths: { ...(world.deaths ?? {}) },
        bits,
        scales,
        terrain: encodeBytes(world.terrain),
        fertility: encodeBytes(packField(world.fertility, bits.fertility, scales.fertility)),
        waterFertility: encodeBytes(packField(world.waterFertility, bits.waterFertility, scales.waterFertility)),
        grass: encodeBytes(packField(world.grass, bits.grass, scales.grass)),
        weed: encodeBytes(packField(world.weed, bits.weed, scales.weed)),
        detritus: encodeBytes(packField(world.detritus, bits.detritus, scales.detritus)),
        trees: world.trees.map(plant => ({ ...plant })),
        entities: world.entities.map(entity => serializeEntity(entity)),
        corpses: world.corpses.map(corpse => ({ ...corpse })),
        history: world.history.slice(-200),
      }
    }

    /**
     * One animal as JSON. The body is written in full — reserve, structure,
     * maturity, health, fatigue, death cause — because those are the values the
     * gate "save round-trips including body fat / maturity / state" is about.
     * @param {object} entity - the animal.
     * @returns {object} save record.
     */
    function serializeEntity(entity) {
      const body = entity.body
      const record = {
        id: entity.id,
        species: entity.species,
        x: entity.x,
        y: entity.y,
        heading: entity.heading,
        age: entity.age,
        generation: entity.generation,
        cooldown: entity.cooldown,
        thinkTimer: entity.thinkTimer,
        herdTimer: entity.herdTimer ?? 0,
        alarm: entity.alarm ?? 0,
        targetX: entity.targetX,
        targetY: entity.targetY,
        fleeing: entity.fleeing === true,
        children: entity.children ?? 0,
        phase: entity.phase,
        intent: entity.intent ?? null,
        intentScore: entity.intentScore ?? null,
        genes: { ...entity.genes },
        // Why each behaviour field is or is not here (docs/20 §5):
        //
        //  state   — the current bout {id, since, until, min, phase, why, score,
        //            x, y}. CANNOT be re-derived: without it a loaded animal
        //            starts a fresh bout from wherever it stands and the panel
        //            loses "why did it do that". Saved.
        //  plan    — the committed step list for that bout. Saved, same reason.
        //  belief  — remembered food/water/home/threat plus the cache list, every
        //            entry time-stamped. Saved: memory is the animal's history.
        //  drives  — a DERIVED cache, not missing: updateDrives() rebuilds all
        //            eight channels from body.E/Emax and the need channels on the
        //            first tick after a load (hunger is literally 1 - E/Emax).
        //            It is still written here so the inspector has numbers on the
        //            very first frame instead of a row of blanks.
        //  needs   — thirst / social / safety ARE stateful (nothing derives them
        //            from the body), so those are saved; hunger inside it is a
        //            getter over the reserve and is therefore ignored on restore.
        stateEndedAt: Number.isFinite(entity.stateEndedAt) ? entity.stateEndedAt : null,
        needs: entity.needs === undefined ? null : {
          hunger: entity.needs.hunger,
          thirst: entity.needs.thirst,
          energy: entity.needs.energy,
          safety: entity.needs.safety,
          social: entity.needs.social,
        },
        drives: entity.drives === undefined ? null : { ...entity.drives },
        state: entity.state === undefined ? null : JSON.parse(JSON.stringify(entity.state)),
        plan: entity.plan === undefined ? null : JSON.parse(JSON.stringify(entity.plan)),
        belief: entity.belief === undefined ? null : JSON.parse(JSON.stringify(entity.belief)),
      }
      if (body !== undefined) {
        record.body = {
          E: body.E,
          Emax: body.Emax,
          V: body.V,
          M: body.M,
          health: body.health,
          fatigue: body.fatigue,
          dead: body.dead === true,
          cause: body.cause ?? '',
          gut: body.gut ?? 0,
          injury: body.injury ?? 0,
          handlingCorpse: body.handling === null || body.handling === undefined
            ? null
            : (body.handling.corpse === undefined ? null : body.handling.corpse.id),
        }
      }
      return record
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
      if (data === null || typeof data !== 'object') throw saveError('corrupt', 'world save is not an object')
      if (data.version !== SAVE_VERSION) {
        // A mismatch is not "no save": the player must be told their world is
        // from another build, and the old payload must be left alone (docs/20 §5).
        throw saveError('unsupported_version',
          'world save version ' + String(data.version) + ' cannot be read by build ' + SAVE_VERSION)
      }
      const width = data.width | 0
      const height = data.height | 0
      if (!(width > 0 && height > 0)) throw saveError('corrupt', 'bad world size in save')
      const size = width * height
      const bits = typeof data.bits === 'object' && data.bits !== null ? data.bits : FIELD_BITS.full
      const scales = typeof data.scales === 'object' && data.scales !== null ? data.scales : {}
      const scaleOf = (name, fallback) => (Number.isFinite(scales[name]) && scales[name] > 0 ? scales[name] : fallback)
      const world = {
        version: SAVE_VERSION,
        seed: (data.seed ?? 1) >>> 0,
        width,
        height,
        tick: Number.isFinite(data.tick) ? data.tick : 0,
        time: Number.isFinite(data.time) ? data.time : 0,
        rngState: (data.rngState ?? 1) >>> 0 || 1,
        immigration: data.immigration !== false,
        immigrationTimer: Number.isFinite(data.immigrationTimer) ? data.immigrationTimer : undefined,
        budget: data.budget === null || data.budget === undefined ? createBudget() : { ...createBudget(), ...data.budget },
        deaths: { ...(data.deaths ?? {}) },
        terrain: decodeBytes(data.terrain, Uint8Array),
        moisture: new Float32Array(size),
        depth: new Float32Array(size),
        waterFertility: new Float32Array(size),
        fertility: new Float32Array(size),
        grass: new Float32Array(size),
        weed: new Float32Array(size),
        detritus: new Float32Array(size),
        light: new Float32Array(size),
        canopy: new Float32Array(size),
        canopyDirty: true,
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: Number.isFinite(data.nextId) ? data.nextId : 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      if (world.terrain.length !== size) throw saveError('corrupt', 'bad terrain length in save')
      world.climate = createClimate(world.time)
      world.nutrient = world.fertility
      unpackField(data.fertility, size, bits.fertility ?? 8, scaleOf('fertility', 1), world.fertility)
      unpackField(data.grass, size, bits.grass ?? 8, scaleOf('grass', 1), world.grass)
      unpackField(data.weed, size, bits.weed ?? 8, scaleOf('weed', 1), world.weed)
      unpackField(data.detritus, size, bits.detritus ?? 4, scaleOf('detritus', 1), world.detritus)
      unpackField(data.waterFertility, size, bits.waterFertility ?? 4, scaleOf('waterFertility', 1), world.waterFertility)
      computeHydrology(world, false)
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
      for (const corpse of Array.isArray(data.corpses) ? data.corpses : []) {
        if (!Number.isFinite(corpse?.x) || !Number.isFinite(corpse?.y)) continue
        world.corpses.push({
          id: Number.isFinite(corpse.id) ? corpse.id : world.nextId++,
          x: corpse.x,
          y: corpse.y,
          species: SPECIES[corpse.species] === undefined ? null : corpse.species,
          decay: clamp(Number.isFinite(corpse.decay) ? corpse.decay : 0, 0, 1),
          energy: Number.isFinite(corpse.energy) ? corpse.energy : 20,
          mass: Number.isFinite(corpse.mass) ? corpse.mass : undefined,
          cause: typeof corpse.cause === 'string' ? corpse.cause : 'unknown',
        })
      }
      const pendingHandling = []
      // Restoring is not "energy being created": the saved budget already
      // accounts for these bodies, so the ledger accessor is muted while the
      // records are put back.
      ledgerWriteDepth += 1
      try {
      for (const saved of Array.isArray(data.entities) ? data.entities : []) {
        if (SPECIES[saved?.species] === undefined) continue
        if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue
        const entity = {
          id: Number.isFinite(saved.id) ? saved.id : world.nextId++,
          species: saved.species,
          x: saved.x,
          y: saved.y,
          heading: Number.isFinite(saved.heading) ? saved.heading : 0,
          age: Number.isFinite(saved.age) ? saved.age : 0,
          generation: Number.isFinite(saved.generation) ? saved.generation : 1,
          cooldown: Number.isFinite(saved.cooldown) ? saved.cooldown : 0,
          thinkTimer: Number.isFinite(saved.thinkTimer) ? saved.thinkTimer : 0,
          herdTimer: 0,
          herdAnchor: null,
          alarm: 0,
          targetX: Number.isFinite(saved.targetX) ? saved.targetX : saved.x,
          targetY: Number.isFinite(saved.targetY) ? saved.targetY : saved.y,
          fleeing: saved.fleeing === true,
          fate: '',
          children: Number.isFinite(saved.children) ? saved.children : 0,
          phase: Number.isFinite(saved.phase) ? saved.phase : 0,
          genes: restoreGenes(world, saved.species, saved.genes),
        }
        if (typeof saved.intent === 'string') {
          entity.intent = saved.intent
          entity.intentScore = Number.isFinite(saved.intentScore) ? saved.intentScore : 0
        }
        const body = installLedger(entity)
        if (saved.body !== undefined && saved.body !== null) {
          const savedBody = saved.body
          if (Number.isFinite(savedBody.V) && savedBody.V > 0) body.V = savedBody.V
          if (Number.isFinite(savedBody.Emax) && savedBody.Emax > 0) body.Emax = savedBody.Emax
          if (Number.isFinite(savedBody.E)) body.E = clamp(savedBody.E, 0, body.Emax)
          if (Number.isFinite(savedBody.M)) body.M = clamp(savedBody.M, 0, 1)
          if (Number.isFinite(savedBody.health)) body.health = clamp(savedBody.health, 0, 1)
          if (Number.isFinite(savedBody.fatigue)) body.fatigue = clamp(savedBody.fatigue, 0, 1)
          if (Number.isFinite(savedBody.gut)) body.gut = savedBody.gut
          if (Number.isFinite(savedBody.injury)) body.injury = savedBody.injury
          body.cause = typeof savedBody.cause === 'string' ? savedBody.cause : ''
          if (Number.isFinite(savedBody.handlingCorpse)) pendingHandling.push({ body, id: savedBody.handlingCorpse })
        }
        if (saved.needs !== null && typeof saved.needs === 'object') {
          const needs = needsOf(entity)
          for (const key of ['thirst', 'energy', 'safety', 'social']) {
            const value = saved.needs[key]
            if (Number.isFinite(value)) needs[key] = clamp(value, 0, 1)
          }
        }
        if (saved.drives !== null && typeof saved.drives === 'object') entity.drives = { ...saved.drives }
        if (saved.state !== null && typeof saved.state === 'object') entity.state = saved.state
        if (Number.isFinite(saved.stateEndedAt)) entity.stateEndedAt = saved.stateEndedAt
        if (saved.plan !== null && typeof saved.plan === 'object') entity.plan = saved.plan
        if (saved.belief !== null && typeof saved.belief === 'object') entity.belief = saved.belief
        world.entities.push(entity)
      }
      } finally {
        ledgerWriteDepth -= 1
      }
      // A predator that was mid-meal keeps eating after the reload.
      for (const pending of pendingHandling) {
        const corpse = world.corpses.find(candidate => candidate.id === pending.id)
        if (corpse !== undefined && corpse.energy > 0) pending.body.handling = { corpse }
      }
      world.history = Array.isArray(data.history) ? data.history.slice(-200) : []
      world.population = countPopulations(world)
      rebuildCanopy(world)
      return world
    }

    /**
     * gzip (or gunzip) a byte array with the Web CompressionStream API.
     * @param {Uint8Array} bytes - input.
     * @param {'gzip'|'gunzip'} mode - direction.
     * @returns {Promise<Uint8Array|null>} output, or null when unsupported.
     */
    async function transformBytes(bytes, mode) {
      const Ctor = mode === 'gzip' ? globalThis.CompressionStream : globalThis.DecompressionStream
      if (typeof Ctor !== 'function') return null
      const stream = new Ctor('gzip')
      const writer = stream.writable.getWriter()
      writer.write(bytes)
      writer.close()
      const reader = stream.readable.getReader()
      const chunks = []
      let length = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        length += value.length
      }
      const out = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    /**
     * Build a load failure the UI can branch on.
     *
     * A save is never thrown away quietly: the caller gets `code` (one of
     * `unsupported_version`, `corrupt`, `no_decompressor`) plus a message it can
     * put in front of the player, and the stored payload is left untouched.
     * @param {string} code - machine-readable reason.
     * @param {string} message - human-readable detail.
     * @returns {Error} tagged error.
     */
    function saveError(code, message) {
      const error = new Error(message)
      error.name = 'WorldSaveError'
      error.code = code
      return error
    }

    /**
     * Pack a world into a storage string.
     *
     * gzip where the host supports it (every current browser, and Node), plain
     * JSON with the coarser packing where it does not. The caller only has to
     * store the returned string; `unpackWorld` understands both.
     * @param {object} world - the world.
     * @returns {Promise<{text: string, compressed: boolean, detail: string, bytes: number}>} payload.
     */
    async function packWorld(world) {
      const compressed = typeof globalThis.CompressionStream === 'function'
      const detail = compressed ? 'full' : 'low'
      const json = JSON.stringify(serializeWorld(world, { detail }))
      if (!compressed) return { text: json, compressed: false, detail, bytes: json.length }
      const bytes = new TextEncoder().encode(json)
      const packed = await transformBytes(bytes, 'gzip')
      if (packed === null) return { text: json, compressed: false, detail: 'low', bytes: json.length }
      return { text: SAVE_GZIP_PREFIX + encodeBytes(packed), compressed: true, detail, bytes: packed.length }
    }

    /**
     * Unpack a string produced by `packWorld` (or a legacy plain-JSON save).
     * @param {string} text - stored payload.
     * @returns {Promise<object>} the save object.
     * @throws {Error} when the payload is corrupt or from another format.
     */
    async function unpackWorld(text) {
      const raw = String(text ?? '')
      try {
        if (raw.startsWith(SAVE_GZIP_PREFIX)) {
          const packed = decodeBytes(raw.slice(SAVE_GZIP_PREFIX.length), Uint8Array)
          const bytes = await transformBytes(packed, 'gunzip')
          if (bytes === null) throw saveError('no_decompressor', 'this host cannot decompress a world save')
          return JSON.parse(new TextDecoder().decode(bytes))
        }
        return JSON.parse(raw)
      } catch (error) {
        if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw error
        throw saveError('corrupt', 'world save could not be decoded: ' + (error?.message ?? 'unknown'))
      }
    }

    /**
     * Human-readable size of a save, for the panel's "saved" note.
     * @param {number} bytes - size.
     * @returns {string} e.g. "812 KB".
     */
    function formatSaveSize(bytes) {
      if (!(bytes > 0)) return '0 KB'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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

    // ---------------------------------------------------------------------
    // Seasons, weather and sun direction
    // ---------------------------------------------------------------------
    //
    // The look of the world is a *material* change, not a full-screen filter:
    // grass, foliage and water are rebuilt from a seasonal palette, and the sun
    // direction moves the cast shadows. A tint pass over the finished frame
    // would double up with the day/night wash the panel already draws and would
    // turn every sprite grey in winter.

    /** Seasons in year order; `seasonLook` blends between neighbours. */
    const SEASON_IDS = ['spring', 'summer', 'autumn', 'winter']

    /**
     * Days per year, used only until `climate.yearPhase` exists.
     * Matches docs/10 YEAR_DAYS (8); the stepped climate wins once it lands.
     */
    const SEASON_DAYS = 8

    /**
     * Per-season artwork.
     *
     * `grassDry`/`grassLush` are RGB triples (the ramp builder needs the raw
     * channels), everything else is a packed colour. `snow` is the ground snow
     * cover 0..1 and `bare` the share of canopy lost (autumn thins, winter is
     * bare): those two are what make winter read as winter rather than as "the
     * same meadow, slightly blue".
     */
    const SEASON_LOOK = {
      spring: {
        grassDry: [98, 132, 66],
        grassLush: [50, 118, 54],
        leaf: { dark: rgb(30, 76, 44), mid: rgb(54, 118, 58), light: rgb(98, 160, 76), outline: rgb(16, 40, 26) },
        weed: [rgb(70, 146, 110), rgb(104, 186, 130)],
        needle: { dark: rgb(26, 70, 50), mid: rgb(42, 98, 64), light: rgb(66, 128, 78), outline: rgb(12, 34, 26) },
        water: {
          surface: rgb(120, 200, 214), shallow: rgb(76, 158, 186), mid: rgb(34, 102, 148),
          deep: rgb(30, 80, 122), caustic: rgb(156, 226, 236), foam: rgb(214, 244, 250),
        },
      },
      summer: {
        grassDry: [136, 128, 66],
        grassLush: [36, 94, 46],
        leaf: { dark: rgb(22, 58, 32), mid: rgb(40, 94, 44), light: rgb(74, 132, 60), outline: rgb(12, 32, 20) },
        weed: [rgb(58, 132, 96), rgb(92, 174, 118)],
        needle: { dark: rgb(20, 60, 44), mid: rgb(34, 86, 56), light: rgb(56, 114, 68), outline: rgb(10, 28, 22) },
        water: {
          surface: rgb(104, 188, 204), shallow: rgb(66, 146, 178), mid: rgb(28, 94, 142),
          deep: rgb(24, 72, 112), caustic: rgb(146, 220, 232), foam: rgb(208, 240, 248),
        },
      },
      autumn: {
        grassDry: [166, 140, 62],
        grassLush: [126, 116, 50],
        leaf: { dark: rgb(92, 50, 24), mid: rgb(164, 98, 38), light: rgb(206, 148, 58), outline: rgb(56, 30, 16) },
        weed: [rgb(104, 118, 66), rgb(140, 148, 84)],
        needle: { dark: rgb(28, 62, 46), mid: rgb(46, 88, 58), light: rgb(70, 112, 66), outline: rgb(14, 32, 24) },
        water: {
          surface: rgb(128, 186, 190), shallow: rgb(84, 138, 148), mid: rgb(44, 96, 120),
          deep: rgb(34, 76, 100), caustic: rgb(170, 210, 210), foam: rgb(216, 236, 238),
        },
      },
      winter: {
        grassDry: [182, 176, 150],
        grassLush: [136, 140, 108],
        leaf: { dark: rgb(80, 72, 64), mid: rgb(108, 100, 86), light: rgb(146, 138, 122), outline: rgb(48, 42, 38) },
        weed: [rgb(120, 128, 104), rgb(154, 160, 136)],
        needle: { dark: rgb(26, 56, 44), mid: rgb(40, 76, 52), light: rgb(60, 100, 64), outline: rgb(12, 28, 22) },
        water: {
          surface: rgb(196, 228, 246), shallow: rgb(162, 204, 230), mid: rgb(116, 168, 210),
          deep: rgb(86, 134, 180), caustic: rgb(210, 238, 250), foam: rgb(244, 252, 255),
        },
      },
    }

    // ---------------------------------------------------------------------
    // Phenology: how much snow lies and how bare the canopy is, over the year
    // ---------------------------------------------------------------------
    //
    // These used to be one number per season, which made the whole of winter
    // read as a single white block for an eighth of the year: at yearPhase
    // 0.75–0.875 `seasonLook` reported snow 1 and every tree was grey. A real
    // winter has a short deep-snow window with long shoulders, so the cover is
    // now a profile over the year instead of a per-season constant:
    // deep snow only across ~4% of the year, with 0.2–0.6 banks either side.

    /** Snow cover over the year: `[yearPhase, cover]` control points. */
    const SNOW_PROFILE = [
      [0.0, 0.03],
      [0.3, 0.0],
      [0.58, 0.0],
      [0.7, 0.18],
      [0.76, 0.45],
      [0.8, 0.74],
      [0.82, 1.0],
      [0.86, 1.0],
      [0.89, 0.6],
      [0.93, 0.3],
      [0.97, 0.12],
      [1.0, 0.03],
    ]

    /**
     * How much of the canopy is gone: autumn thins, winter is bare, spring buds.
     * Evergreens ignore this (they keep their needles), so it only affects the
     * deciduous silhouettes.
     */
    const BARE_PROFILE = [
      [0.0, 0.08],
      [0.26, 0.0],
      [0.55, 0.02],
      [0.66, 0.35],
      [0.74, 0.72],
      [0.82, 0.96],
      [0.9, 1.0],
      [0.94, 0.88],
      [0.98, 0.45],
      [1.0, 0.08],
    ]

    /**
     * Sample a `[phase, value]` profile with linear interpolation.
     * @param {number[][]} profile - control points, sorted by phase, 0..1.
     * @param {number} phase - 0..1.
     * @returns {number} interpolated value.
     */
    function profileValue(profile, phase) {
      const clamped = clamp(phase, 0, 1)
      let previous = profile[0]
      if (clamped <= previous[0]) return previous[1]
      for (let index = 1; index < profile.length; index += 1) {
        const point = profile[index]
        if (clamped > point[0]) { previous = point; continue }
        const span = point[0] - previous[0]
        const t = span <= 0 ? 0 : (clamped - previous[0]) / span
        return mix(previous[1], point[1], t)
      }
      return profile[profile.length - 1][1]
    }

    /** Snow and frost colours shared by every season (the cover ramps to them). */
    const SNOW_COLORS = {
      light: rgb(240, 246, 252),
      mid: rgb(212, 226, 238),
      shade: rgb(176, 194, 214),
      blade: rgb(196, 206, 186),
    }

    /** Dust and track colours, for footfalls on dry ground. */
    const DUST_COLORS = [rgb(206, 190, 158), rgb(172, 156, 128)]

    /**
     * Blend two seasonal records of packed colours.
     * @param {object} from - record at t = 0.
     * @param {object} to - record at t = 1.
     * @param {number} t - 0..1.
     * @returns {object} blended record.
     */
    function blendPaletteRecord(from, to, t) {
      const out = {}
      for (const key of Object.keys(from)) out[key] = blendColor(from[key], to[key], t)
      return out
    }

    /**
     * Blend two RGB triples.
     * @param {number[]} from - triple at t = 0.
     * @param {number[]} to - triple at t = 1.
     * @param {number} t - 0..1.
     * @returns {number[]} blended triple.
     */
    function blendTriple(from, to, t) {
      return [mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t)]
    }

    /** Cover steps in the ground ramp. Sixteen reads smoother at 6x than eight. */
    const GRASS_STEPS = 16

    /**
     * Ground ramp between three anchors: bare, mixed, lush.
     *
     * Two scales is the whole trick behind a meadow that does not read as one
     * flat green sheet: the low half is dry/dormant ground, the high half is
     * living cover. Season only swaps the anchors; sixteen steps give the
     * per-cell dither enough room to layer without banding.
     * @param {number[]} dry - bare-ground triple.
     * @param {number[]} lush - full-cover triple.
     * @returns {number[]} `GRASS_STEPS` packed colours, bare → lush.
     */
    function grassRampFrom(dry, lush) {
      const mid = [(dry[0] + lush[0]) / 2, (dry[1] + lush[1]) / 2, (dry[2] + lush[2]) / 2]
      const ramp = new Array(GRASS_STEPS)
      for (let step = 0; step < GRASS_STEPS; step++) {
        const t = step / (GRASS_STEPS - 1)
        const from = t < 0.5 ? dry : mid
        const to = t < 0.5 ? mid : lush
        const local = t < 0.5 ? t * 2 : (t - 0.5) * 2
        ramp[step] = rgb(
          Math.round(mix(from[0], to[0], local)),
          Math.round(mix(from[1], to[1], local)),
          Math.round(mix(from[2], to[2], local)),
        )
      }
      return ramp
    }

    /**
     * Fraction of the year (0..1), from the climate when it has been stepped.
     * @param {object} world - the world.
     * @returns {number} year phase.
     */
    function yearPhaseOf(world) {
      const climate = world.climate
      if (climate !== null && climate !== undefined && typeof climate.yearPhase === 'number') {
        const phase = climate.yearPhase % 1
        return phase < 0 ? phase + 1 : phase
      }
      const seconds = typeof world.time === 'number' && Number.isFinite(world.time) ? world.time : 0
      const yearSeconds = DAY_SECONDS * SEASON_DAYS
      const phase = (seconds % yearSeconds) / yearSeconds
      return phase < 0 ? phase + 1 : phase
    }

    /**
     * Fraction of the day (0..1), from the climate when it has been stepped.
     * @param {object} world - the world.
     * @returns {number} day phase.
     */
    function dayPhaseOf(world) {
      const climate = world.climate
      if (climate !== null && climate !== undefined && typeof climate.dayPhase === 'number') {
        const phase = climate.dayPhase % 1
        return phase < 0 ? phase + 1 : phase
      }
      const seconds = typeof world.time === 'number' && Number.isFinite(world.time) ? world.time : 0
      const phase = (seconds % DAY_SECONDS) / DAY_SECONDS
      return phase < 0 ? phase + 1 : phase
    }

    /**
     * Where the sun stands: azimuth drives the shadow *direction*, elevation the
     * shadow *length* and the shadow *strength*.
     *
     * One shared vector: the ground pass paints plant shadows and the display
     * pass paints creature shadows, and they have to agree or the meadow looks
     * lit by two suns.
     * @param {object} world - the world.
     * @returns {{azimuth: number, elevation: number, length: number, strength: number}} sun state.
     */
    function sunState(world) {
      const phase = dayPhaseOf(world)
      // Sunrise at 0.22, sunset at 0.78 of the day (matches daylight()).
      const t = (phase - 0.22) / 0.56
      const elevation = t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t)
      const azimuth = (t - 0.5) * 2
      const length = 1 - elevation
      return {
        azimuth,
        elevation,
        length,
        strength: 0.3 + 0.7 * Math.max(0, elevation),
      }
    }

    /**
     * Shadow offset as a fraction of the caster's width.
     *
     * A low sun throws shadows away from it and makes them long; at noon the
     * shadow sits under the object. The cast is *horizontal on screen* because
     * the world is seen from the side, not from above.
     * @param {object} world - the world.
     * @returns {{x: number, y: number, strength: number}} offset fractions.
     */
    function shadowOffset(world) {
      const sun = sunState(world)
      return {
        x: -sun.azimuth * (0.1 + 0.5 * sun.length),
        y: 0.05 + 0.14 * sun.length,
        strength: sun.strength,
      }
    }

    /**
     * Year-phase steps per season. `SUMMER` would be index 1, step 0.
     *
     * Part of the look-key contract: `key = seasonIndex * 17 + step`, with
     * `step = round(local * 16)` therefore in 0..16. Decoding is
     * `index = floor(key / 17)`, `step = key % 17`. Two worlds at the same
     * yearPhase always get the same key, and the key only ever moves when the
     * quantised year phase does.
     */
    const SEASON_STEPS = 16

    /** Bumped whenever the shape of a look record changes, for cache safety. */
    const LOOK_MEMO_SIZE = 8

    /** Memo for the blended seasonal looks, keyed by `look.key`. */
    const seasonMemo = new Map()

    /**
     * The blended seasonal look for this frame.
     *
     * Rebuilt only when the quantised year phase moves, so the per-cell hot loop
     * never does colour maths for the season. The memo holds a few looks because
     * a probe (or a test) painting two worlds in the same frame must not thrash
     * the cache and rebuild 170 sprites per frame.
     * @param {object} world - the world.
     * @returns {object} look record.
     */
    function seasonLook(world) {
      const phase = yearPhaseOf(world)
      const seasons = SEASON_IDS.length
      const scaled = phase * seasons
      const index = Math.min(seasons - 1, Math.floor(scaled))
      const local = scaled - index
      const step = Math.round(local * SEASON_STEPS)
      const key = index * (SEASON_STEPS + 1) + step
      const cached = seasonMemo.get(key)
      if (cached !== undefined) return cached
      const from = SEASON_LOOK[SEASON_IDS[index]]
      const to = SEASON_LOOK[SEASON_IDS[(index + 1) % seasons]]
      const t = step / SEASON_STEPS
      // Each season holds its own palette for the first three quarters and only
      // bleeds into the next one at the end. Blending across the whole quarter
      // made mid-winter already half spring while the ground was still white.
      const eased = smooth(clamp((t - 0.75) / 0.25, 0, 1))
      // Snow and bareness are year-phase profiles, not per-season constants: the
      // deep-snow window is ~4% of the year with long 0.2–0.6 shoulders.
      const quantisedPhase = (index + t) / seasons
      const snow = profileValue(SNOW_PROFILE, quantisedPhase)
      const bare = profileValue(BARE_PROFILE, quantisedPhase)
      const look = {
        key,
        // Foliage sprites are rebuilt from scratch, so they use a coarser key.
        plantKey: index * 9 + Math.round(local * 8),
        index,
        step,
        t,
        phase: quantisedPhase,
        snow,
        bare,
        // Ice on the shallows appears a little before the ground is fully white.
        ice: clamp((snow - 0.42) / 0.5, 0, 1),
        leaf: blendPaletteRecord(from.leaf, to.leaf, eased),
        needle: blendPaletteRecord(from.needle, to.needle, eased),
        water: blendPaletteRecord(from.water, to.water, eased),
        weed: [
          blendColor(from.weed[0], to.weed[0], eased),
          blendColor(from.weed[1], to.weed[1], eased),
        ],
        ramp: grassRampFrom(
          blendTriple(from.grassDry, to.grassDry, eased),
          blendTriple(from.grassLush, to.grassLush, eased),
        ),
      }
      if (seasonMemo.size >= LOOK_MEMO_SIZE) seasonMemo.clear()
      seasonMemo.set(key, look)
      return look
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

    // ---------------------------------------------------------------------
    // State → pose table
    // ---------------------------------------------------------------------
    //
    // The atlas only carries idle (2 frames), walk (4) and run (4) per species.
    // Waiting for new artwork would leave "sleeping", "stalking" and "freezing"
    // invisible, so every behaviour state is expressed as a *pose variant* over
    // those three frame sets: hold a frame, settle into the ground, lean, squash,
    // nod at a grazing cadence, shiver. One table, two consumers — the 1-px
    // buffer pass (frameFor) and the atlas display pass (drawAtlasAnimal).

    /**
     * Pose defaults. A pose is a small, complete description; the renderer never
     * fills in missing fields at draw time.
     */
    const POSE_DEFAULTS = {
      /** Frame set to play: 'idle' | 'walk' | 'run'. */
      role: 'idle',
      /** Frame-rate multiplier for the walk cycle. */
      speed: 1,
      /** Hold the first frame instead of cycling (rest, sleep, huddle). */
      pause: false,
      /** 0..1 head-bob at a grazing cadence. */
      nod: 0,
      /** Lean in degrees; negative leans forward. */
      tilt: 0,
      /** How far the body settles into the ground, in cells. */
      sink: 0,
      /** Vertical scale: < 1 crouches, > 1 rears up. */
      squash: 1,
      /** Opacity; hiding animals fade. */
      alpha: 1,
      /** Shadow size multiplier, so a crouched animal casts a smaller shadow. */
      shadow: 1,
      /** 0..1 shiver jitter (cold, fighting). */
      shake: 0,
    }

    /**
     * Behaviour state id → pose.
     *
     * Keys are the ids `state.id` will carry once the execution state machine
     * lands (docs/20-CORE-LOOP.md 2.3); the intent ids the engine uses today are
     * listed too, so the renderer works on both engines. Unknown ids fall back
     * to the idle pose instead of freezing the animal at frame 0 of nothing.
     */
    const STATE_POSES = {
      // Standing still, breathing.
      idle: {},
      alert: { squash: 1.04, shadow: 0.9 },
      // Grazing / browsing: head down, a slow nod, body settles a little.
      graze: { role: 'idle', nod: 1, squash: 0.93, sink: 0.45 },
      eat: { role: 'idle', nod: 1, squash: 0.91, sink: 0.4 },
      forage: { role: 'idle', nod: 0.7, squash: 0.95, sink: 0.5 },
      browse: { role: 'idle', nod: 0.8, squash: 0.94, sink: 0.45 },
      // Drinking: leans down at the waterline.
      drink: { role: 'idle', tilt: 7, sink: 0.9, nod: 0.35 },
      // Resting and sleeping: a held frame, crouched, sunk into the grass.
      rest: { role: 'idle', pause: true, squash: 0.86, sink: 1 },
      sleep: { role: 'idle', pause: true, squash: 0.76, sink: 1.4, alpha: 0.92, shadow: 0.75 },
      bask: { role: 'idle', pause: true, squash: 0.88, sink: 1.1 },
      // Stalking (潜伏): low, slow, faded, minimal shadow.
      stalk: { role: 'walk', speed: 0.4, squash: 0.8, sink: 0.7, shadow: 0.55 },
      sneak: { role: 'walk', speed: 0.45, squash: 0.82, sink: 0.6, shadow: 0.6 },
      ambush: { role: 'idle', pause: true, squash: 0.82, sink: 0.8, shadow: 0.5 },
      // Hoarding (囤食): carrying/covering food, a smaller nod.
      hoard: { role: 'walk', speed: 0.75, nod: 0.5, sink: 0.5, squash: 0.95 },
      cache: { role: 'walk', speed: 0.7, nod: 0.45, sink: 0.55, squash: 0.95 },
      bury: { role: 'idle', nod: 0.9, sink: 0.8, squash: 0.88 },
      // Cold (受冻): hunched, shivering.
      cold: { role: 'idle', shake: 1, squash: 0.9, sink: 0.5 },
      shiver: { role: 'idle', shake: 1, squash: 0.88, sink: 0.6 },
      freeze: { role: 'idle', pause: true, shake: 0.45, squash: 0.9, sink: 0.7 },
      huddle: { role: 'idle', pause: true, squash: 0.84, sink: 0.9, shadow: 0.85 },
      // Moving.
      wander: { role: 'walk' },
      explore: { role: 'walk' },
      patrol: { role: 'walk', speed: 0.9 },
      walk: { role: 'walk' },
      travel: { role: 'walk', speed: 1.1 },
      migrate: { role: 'walk', speed: 1.15 },
      // Hunting: stretched, leaning forward, bigger shadow.
      hunt: { role: 'run', speed: 1.1, tilt: -3, squash: 1.02, shadow: 1.15 },
      chase: { role: 'run', speed: 1.2, tilt: -4, shadow: 1.15 },
      strike: { role: 'run', speed: 1.35, tilt: -6, squash: 1.05, shadow: 1.2 },
      scavenge: { role: 'walk', speed: 1.05 },
      // Flight.
      flee: { role: 'run', speed: 1.2 },
      fight: { role: 'run', speed: 1.1, shake: 1, tilt: 3, shadow: 1.1 },
      // A kill being worked through: crouched over the carcass, head down.
      feast: { role: 'idle', nod: 0.9, tilt: 4, squash: 0.9, sink: 0.9, shadow: 0.8 },
      // Social and reproductive.
      court: { role: 'walk', speed: 0.8, nod: 0.6 },
      socialize: { role: 'walk', speed: 0.9 },
      follow: { role: 'walk', speed: 1.05 },
      mate: { role: 'idle', pause: true, nod: 0.4, squash: 0.95 },
      birth: { role: 'idle', pause: true, squash: 0.88, sink: 0.7 },
      play: { role: 'run', speed: 1.05, nod: 0.3 },
    }

    /** Normalised poses, built once: the renderer must not allocate per animal. */
    const POSES = Object.fromEntries(Object.entries(STATE_POSES)
      .map(([id, pose]) => [id, { id, ...POSE_DEFAULTS, ...pose }]))

    /** The fallback for any state id the table does not know (or that is missing). */
    const POSE_FALLBACK = POSES.idle

    /**
     * The behaviour state id of an animal.
     *
     * `state.id` wins; the legacy `intent` field is the fallback so the renderer
     * works before the state machine lands, and a missing field reads as idle.
     * @param {object} animal - the animal.
     * @returns {string} state id.
     */
    function stateIdOf(animal) {
      const state = animal.state
      if (state !== null && state !== undefined && typeof state.id === 'string') return state.id
      if (typeof animal.intent === 'string') return animal.intent
      return 'idle'
    }

    /**
     * Resolve a pose for a state id, with a tolerant match.
     *
     * "eat:grass" and "hoard_cache" must still find their pose: the table is
     * matched on the leading word before any separator.
     * @param {string} id - state id.
     * @returns {object} normalised pose (falls back to idle).
     */
    function poseForId(id) {
      const direct = POSES[id]
      if (direct !== undefined) return direct
      const base = id.toLowerCase().split(/[^a-z0-9]+/)
      for (const word of base) {
        if (word.length === 0) continue
        const found = POSES[word]
        if (found !== undefined) return found
      }
      return POSE_FALLBACK
    }

    /**
     * Poses that only make sense standing at the target.
     *
     * `state.phase` is 'approach' while the animal is still walking to the
     * patch/carcass/water and 'do' once it is there (contract from
     * 10b-execution). A head-down grazing loop played while the animal is
     * crossing the meadow reads as an animal eating while it walks, so the
     * approach phase falls back to the moving pose.
     */
    const DO_POSES = new Set(['graze', 'eat', 'forage', 'browse', 'drink', 'bury',
      'feast', 'bask', 'huddle', 'mate', 'birth', 'socialize', 'court'])

    /**
     * The pose one animal is showing this frame.
     * @param {object} animal - the animal.
     * @returns {object} normalised pose.
     */
    function poseFor(animal) {
      if (animal.fleeing === true) return POSES.flee
      // A predator working through a kill stands still with its head down; the
      // execution state machine flags that with `handling` (12-step-entity), and
      // "intent" still says hunt/scavenge, which would otherwise show a run.
      if (animal.handling === true) return POSES.feast
      const pose = poseForId(stateIdOf(animal))
      const state = animal.state
      if (state === null || state === undefined || typeof state !== 'object') return pose
      // An ambusher does not pursue: for a stalk-and-strike hunter a crouched
      // approach and a short strike read as an ambush, a full run reads as a
      // chase across the meadow.
      if (pose === POSES.hunt) {
        const species = SPECIES[animal.species]
        if (species !== undefined && species.ambush !== undefined) {
          return state.phase === 'do' ? POSES.strike : POSES.stalk
        }
      }
      // Courtship only when the animal is actually receptive.
      if (pose === POSES.socialize) {
        const drives = animal.drives
        if (drives !== undefined && drives !== null && drives.libido > 0.5) return POSES.court
      }
      if (state.phase === 'approach' && DO_POSES.has(pose.id)) return POSES.walk
      return pose
    }

    /**
     * The frame set a pose plays, after the engine's own speed decision.
     * @param {object} animal - the animal.
     * @param {object} pose - its pose.
     * @returns {'idle'|'walk'|'run'} frame role.
     */
    function poseRole(animal, pose) {
      if (animal.fleeing === true) return 'run'
      if (pose.role === 'walk' && animal.running === true) return 'run'
      return pose.role
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

    // ---------------------------------------------------------------------
    // Plant silhouettes
    // ---------------------------------------------------------------------
    //
    // Every tree used to be the *same* shape, only recoloured and moved, and it
    // was the strongest "this was stamped by a machine" tell on the map: a forest
    // of forty identical umbrellas. Each plant now picks one of five silhouettes
    // from its own id, so the forest is made of individuals that never need to be
    // drawn by hand: round, tall, wide, leaning and spire crowns, plus three
    // evergreen cones and a leafless winter skeleton.

    /**
     * Deciduous crown silhouettes.
     *
     * Lobe offsets and radii are in units of the crown radius, so all three sizes
     * share the proportions; `spread`/`flatten` reshape the crown into an
     * ellipse, and the trunk may lean or stay upright.
     */
    const TREE_SHAPES = [
      // 0 · round — the classic compass crown
      {
        lobes: [[0, -0.1, 0.82], [-0.5, 0.3, 0.62], [0.52, 0.26, 0.6], [0, 0.34, 0.56]],
        spread: 1, flatten: 0.92, trunk: { lean: 0, rows: [2, 2, 3], width: [2, 2, 3] },
      },
      // 1 · tall — an upright crown, half a size narrower than round
      {
        lobes: [[0, -0.5, 0.58], [-0.32, 0.02, 0.62], [0.32, 0.16, 0.6], [0, 0.56, 0.52]],
        spread: 0.9, flatten: 1.3, trunk: { lean: 0, rows: [2, 3, 4], width: [2, 2, 2] },
      },
      // 2 · wide — a spreading old crown, wider than it is tall
      {
        lobes: [[-0.62, 0.16, 0.56], [0.62, 0.18, 0.54], [0, 0.02, 0.74], [0, 0.46, 0.5]],
        spread: 1.34, flatten: 0.62, trunk: { lean: 0, rows: [2, 2, 3], width: [3, 3, 4] },
      },
      // 3 · leaning — one side of the crown pushed out over a bent trunk
      {
        lobes: [[0.34, -0.06, 0.74], [-0.3, 0.3, 0.56], [0.66, 0.28, 0.5]],
        spread: 1.05, flatten: 0.9, trunk: { lean: 1.8, rows: [2, 3, 4], width: [2, 2, 3] },
      },
      // 4 · spire — a poplar: narrow and tall, pointed at the top
      {
        lobes: [[0, -0.66, 0.5], [0, -0.2, 0.62], [0, 0.26, 0.64], [0, 0.64, 0.48]],
        spread: 1, flatten: 1.2, trunk: { lean: 0, rows: [2, 3, 4], width: [2, 2, 2] },
      },
    ]

    /** Evergreen silhouettes: a fir, a slim spruce and a broad pine. */
    const CONIFER_SHAPES = [
      { tiers: 6, spread: 1.05, tallness: 1.5, taper: 0.95 },
      { tiers: 7, spread: 0.82, tallness: 1.72, taper: 0.86 },
      { tiers: 4, spread: 1.35, tallness: 1.05, taper: 1.1 },
    ]

    /**
     * Distance from a point to a line segment, for the bare-tree skeleton.
     * @param {number} px - point x.
     * @param {number} py - point y.
     * @param {number} ax - segment start x.
     * @param {number} ay - segment start y.
     * @param {number} bx - segment end x.
     * @param {number} by - segment end y.
     * @returns {number} distance in pixels.
     */
    function distanceToSegment(px, py, ax, ay, bx, by) {
      const vx = bx - ax
      const vy = by - ay
      const lengthSquared = vx * vx + vy * vy
      const t = lengthSquared === 0 ? 0 : clamp(((px - ax) * vx + (py - ay) * vy) / lengthSquared, 0, 1)
      return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
    }

    /**
     * A deciduous tree: an elliptical crown over a trunk.
     *
     * The rim is the whole point: a green blob on a green meadow is invisible, a
     * green blob with a near-black edge and a brown trunk is a tree. Snow settles
     * on the top edge of the crown, which is what keeps a winter forest readable
     * instead of turning it into grey blocks.
     * @param {number} size - 1, 2 or 3.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @param {number} [thin] - 0..1 share of interior canopy lost (autumn).
     * @param {number} [shapeIndex] - silhouette index into TREE_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the top of the crown.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildTreeSprite(size, leaf = PALETTE.leaf, thin = 0, shapeIndex = 0, snowCap = 0) {
      const shape = TREE_SHAPES[shapeIndex % TREE_SHAPES.length]
      const radius = [4.3, 6.0, 7.6][size - 1]
      const trunkRows = shape.trunk.rows[size - 1]
      const trunkWidth = shape.trunk.width[size - 1]
      const width = Math.ceil(radius * 2 * Math.max(1, shape.spread)) + 3
      const canopyHeight = Math.ceil(radius * 1.85 * shape.flatten)
      const height = canopyHeight + trunkRows + 1
      const cx = width / 2
      const cy = canopyHeight / 2
      // Pass 1: the crown mask, so pass 2 can find its own edge and top.
      const mask = new Uint8Array(width * height)
      for (let y = 0; y < canopyHeight; y++) {
        for (let x = 0; x < width; x++) {
          const px = x + 0.5
          const py = y + 0.5
          let margin = -Infinity
          for (const [offsetX, offsetY, lobeRadius] of shape.lobes) {
            const dx = (px - (cx + offsetX * radius)) / shape.spread
            const dy = (py - (cy + offsetY * radius)) / shape.flatten
            margin = Math.max(margin, lobeRadius * radius - Math.hypot(dx, dy))
          }
          if (margin > 0) mask[y * width + x] = 1
        }
      }
      // Pass 2: shade the crown, drop the autumn interior, cap the snow.
      return buildSprite(width, height, (x, y) => {
        if (mask[y * width + x] === 1) {
          const above = y === 0 ? 0 : mask[(y - 1) * width + x]
          const edge = above === 0
            || x === 0 || x === width - 1
            || mask[y * width + x - 1] === 0 || mask[y * width + x + 1] === 0
          // Snow sits on the upper edge only: the canopy keeps its own colour
          // underneath, so the tree still reads as a tree.
          if (snowCap > 0.3 && above === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
          if (thin > 0 && !edge && (((x * 37 + y * 61 + 5) & 31) / 31) < thin * 0.55) return 0
          if (edge) return leaf.outline
          const px = x + 0.5
          const py = y + 0.5
          // Light comes from the top left: -dx -dy is brightest up and left.
          const lit = -(px - cx) / radius * 0.55 - (py - cy) / radius * 0.85
          if (lit > 0.34) return leaf.light
          if (lit < -0.1) return leaf.dark
          return ((x * 5 + y * 3) & 15) < 5 ? leaf.light : leaf.mid
        }
        const trunkTop = canopyHeight - 1
        if (y >= trunkTop) {
          const t = (y - trunkTop) / Math.max(1, height - 1 - trunkTop)
          const centre = cx + shape.trunk.lean * t
          const offset = x + 0.5 - centre
          if (Math.abs(offset) <= trunkWidth / 2) {
            return Math.abs(offset) > trunkWidth / 2 - 1 ? PALETTE.trunkDark : PALETTE.trunk
          }
        }
        return 0
      })
    }

    /**
     * A leafless deciduous tree: trunk and branches only.
     *
     * The winter answer used to be "thin the same green crown by a hash", which
     * printed a grey ring. A real bare tree is a skeleton, so it is drawn as one.
     * @param {number} size - 1, 2 or 3.
     * @param {object} [leaf] - foliage palette, for the branch outline.
     * @param {number} [shapeIndex] - silhouette index, so the skeleton matches.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBareTreeSprite(size, leaf = PALETTE.leaf, shapeIndex = 0) {
      const shape = TREE_SHAPES[shapeIndex % TREE_SHAPES.length]
      const radius = [4.3, 6.0, 7.6][size - 1]
      const width = Math.ceil(radius * 2 * Math.max(1, shape.spread)) + 3
      const height = Math.ceil(radius * 1.95 * shape.flatten) + 2
      const cx = width / 2 + shape.trunk.lean * 0.4
      const baseY = height - 1
      const crownY = Math.max(1, height * 0.16)
      const trunkX = cx - shape.trunk.lean * 0.35
      // Trunk, then four branches per level as two-segment polylines that bend
      // upward: straight spokes read as a spider, a bend reads as a tree.
      const segments = [[cx, baseY, trunkX, crownY]]
      // Four long branches at a steep angle plus a fork at the top. Short flat
      // spokes read as a brown cross; the reach has to be close to the crown
      // radius or the skeleton stops looking like a tree at all.
      const levels = [[0.95, 0.95], [0.8, 1.0], [0.6, 1.0]]
      for (let step = 0; step < levels.length; step += 1) {
        const [spreadAt, rise] = levels[step]
        const t = 0.22 + step * 0.2
        const fromX = cx - (cx - trunkX) * t
        const fromY = baseY - (baseY - crownY) * t
        const reach = radius * spreadAt * Math.max(0.85, shape.spread)
        const side = step % 2 === 0 ? 1 : -1
        const tipX = fromX + side * reach
        const tipY = fromY - radius * rise * 0.8
        segments.push([fromX, fromY, fromX + side * reach * 0.55, fromY - radius * rise * 0.35])
        segments.push([fromX + side * reach * 0.55, fromY - radius * rise * 0.35, tipX, tipY])
        // A short twig on the other side keeps the skeleton from looking combed.
        if (step > 0) segments.push([fromX, fromY, fromX - side * reach * 0.45, fromY - radius * rise * 0.6])
      }
      segments.push([trunkX, crownY, trunkX - radius * 0.42, crownY - radius * 0.5])
      segments.push([trunkX, crownY + 1, trunkX + radius * 0.38, crownY - radius * 0.34])
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let best = Infinity
        for (const [ax, ay, bx, by] of segments) {
          const distance = distanceToSegment(px, py, ax, ay, bx, by)
          if (distance < best) best = distance
        }
        if (best > 0.62) return 0
        return best < 0.34 ? PALETTE.trunk : leaf.outline
      })
    }

    /**
     * An evergreen: stacked tiers of needles, snow-cap on every tier's top.
     *
     * Without evergreens a winter forest is nothing but grey sticks; with them the
     * map keeps a spine of dark green under the snow.
     * @param {number} size - 1, 2 or 3.
     * @param {object} needle - needle palette (seasonal).
     * @param {number} [shapeIndex] - silhouette index into CONIFER_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the tier tops.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildConiferSprite(size, needle, shapeIndex = 0, snowCap = 0) {
      const shape = CONIFER_SHAPES[shapeIndex % CONIFER_SHAPES.length]
      const radius = [3.4, 4.6, 5.8][size - 1]
      const height = Math.ceil(radius * 2.4 * shape.tallness) + 2
      const width = Math.ceil(radius * 2 * shape.spread) + 3
      const cx = width / 2
      const mask = new Uint8Array(width * height)
      const tierHeight = (height - 1) / shape.tiers
      for (let tier = 0; tier < shape.tiers; tier += 1) {
        const top = tier * tierHeight
        const bottom = top + tierHeight + 0.7
        const halfAtBottom = radius * shape.spread * shape.taper * (0.55 + 0.75 * ((tier + 1) / shape.tiers))
        for (let y = Math.round(top); y <= Math.round(bottom) && y < height; y += 1) {
          const t = (y - top) / Math.max(1, bottom - top)
          const half = halfAtBottom * t
          const from = Math.round(cx - half)
          const to = Math.round(cx + half)
          for (let x = from; x <= to; x += 1) {
            if (x >= 0 && x < width) mask[y * width + x] = 1
          }
        }
      }
      return buildSprite(width, height, (x, y) => {
        if (mask[y * width + x] !== 1) return 0
        const above = y === 0 ? 0 : mask[(y - 1) * width + x]
        const edge = above === 0 || x === 0 || x === width - 1
          || mask[y * width + x - 1] === 0 || mask[y * width + x + 1] === 0
        if (snowCap > 0.3 && above === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
        if (edge) return needle.outline
        const lit = -(x + 0.5 - cx) / radius * 0.5
        if (lit > 0.18) return needle.light
        if (lit < -0.2) return needle.dark
        return ((x * 3 + y * 5) & 7) < 3 ? needle.mid : needle.dark
      })
    }

    /** Shrub silhouettes: low and flat, tall and lanky, wide and spreading. */
    const BUSH_SHAPES = [
      [[0, 0, 0.78], [-0.55, 0.2, 0.55], [0.55, 0.16, 0.55]],
      [[0, -0.32, 0.6], [-0.2, 0.28, 0.5], [0.3, 0.24, 0.46], [0, 0.62, 0.36]],
      [[-0.62, 0.1, 0.46], [0.62, 0.14, 0.44], [0, 0, 0.72], [0, 0.4, 0.5]],
    ]

    /**
     * A shrub: the tree canopy without a trunk, so the meadow reads as layers.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @param {number} [thin] - 0..1 share of interior canopy lost.
     * @param {number} [shapeIndex] - silhouette index into BUSH_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the top of the shrub.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBushSprite(leaf = PALETTE.leaf, thin = 0, shapeIndex = 0, snowCap = 0) {
      const lobes = BUSH_SHAPES[shapeIndex % BUSH_SHAPES.length]
      const radius = 3.1
      const width = Math.ceil(radius * 2) + 2
      const height = Math.ceil(radius * 1.9) + 1
      const cx = width / 2
      const cy = height / 2
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of lobes) {
          margin = Math.max(margin, lobeRadius * radius - Math.hypot(px - (cx + offsetX * radius), (py - (cy + offsetY * radius)) / 0.9))
        }
        if (margin <= 0) return y === height - 1 && Math.abs(px - cx) < 1.2 ? PALETTE.trunkDark : 0
        // Snow caps the top row of the shrub, same rule as the tree crown.
        if (snowCap > 0.3 && y === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
        if (thin > 0 && margin > 1.05 && (((x * 41 + y * 29 + 7) & 31) / 31) < thin * 0.55) return 0
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
     * @param {number[]} [weed] - two-shade aquatic plant palette (seasonal).
     * @param {object} [leaf] - foliage palette, for the shaded underside.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildLilySprite(variant, weed = PALETTE.weed, leaf = PALETTE.leaf, snowCap = 0) {
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
          // Under ice the pad is pale all over with a shaded rim, so it reads as
          // a frozen pad rather than as a dark bar with a white stripe.
          if (snowCap > 0.4) return py > cy + 0.7 || x < 1 ? SNOW_COLORS.shade : SNOW_COLORS.mid
          // A pad has to read against the water it floats on: weed-on-weed was
          // invisible, which left the flower floating in mid air as a pink square.
          if (py < cy - 0.6) return PALETTE.weedStalk
          if (py > cy + 0.8 || x < 1) return leaf.outline
          return ((x + y) & 3) === 0 ? weed[1] : leaf.mid
        }
        if (variant === 1 && snowCap < 0.2 && y <= 1 && Math.abs(px - width / 2) < 1.1) {
          return y === 0 ? PALETTE.flowers[1] : PALETTE.flowers[3]
        }
        return 0
      })
    }

    /**
     * A reed clump: three stalks leaning out of the shallows.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildReedSprite(leaf = PALETTE.leaf, snowCap = 0) {
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
          // Snow is not painted on a stalk: a pale band mid-stalk turned the whole
          // reed bed into a row of fences. Stalks poke out of the snow instead.
          return y < 2 ? PALETTE.trunkDark : (y < 5 ? leaf.light : leaf.mid)
        }
        if (y >= height - 2 && Math.abs(x + 0.5 - 5) < 2.4) return leaf.dark
        return 0
      })
    }

    /**
     * Build the whole plant set for one seasonal look.
     *
     * The set carries every silhouette for every size, for both phenologies, so
     * the per-plant choice (`plantSpriteFor`) is a couple of array reads instead
     * of a sprite build in the draw loop.
     * @param {object} look - `{ leaf, needle, weed, bare, snow }`.
     * @returns {object} the plant sprite set.
     */
    function buildPlantSet(look) {
      const snowCap = look.snow ?? 0
      const thin = look.bare ?? 0
      return {
        // Kept for the engine test seam and for the species sheet.
        tree: [1, 2, 3].map(size => TREE_SHAPES.map((unused, shape) => buildTreeSprite(size, look.leaf, thin, shape, snowCap))),
        conifer: [1, 2, 3].map(size => CONIFER_SHAPES.map((unused, shape) => buildConiferSprite(size, look.needle, shape, snowCap))),
        leafless: [1, 2, 3].map(size => TREE_SHAPES.map((unused, shape) => buildBareTreeSprite(size, look.leaf, shape))),
        bush: BUSH_SHAPES.map((unused, shape) => buildBushSprite(look.leaf, thin, shape, snowCap)),
        lily: [0, 1].map(variant => buildLilySprite(variant, look.weed, look.leaf, snowCap)),
        reed: [buildReedSprite(look.leaf, snowCap)],
        bare: thin,
        snow: snowCap,
      }
    }

    /**
     * Which kind of plant this is, from its own id.
     *
     * Phenology has to be per plant, not per world: a forest where every tree
     * loses its leaves on the same frame pops, while a staggered one turns over
     * like a real autumn.
     * @param {object} plant - the plant record.
     * @returns {boolean} true for an evergreen.
     */
    function isConifer(plant) {
      // A modulus that shares no factor with the silhouette count, otherwise the
      // cone flags and the crown shapes line up and every conifer looks alike.
      return plant.variant === 'tree' && (plant.id % 7) < 2
    }

    /** Shared default look, so the exported sprite set works without a world. */
    const DEFAULT_PLANT_LOOK = {
      leaf: PALETTE.leaf,
      needle: SEASON_LOOK.summer.needle,
      weed: PALETTE.weed,
      bare: 0,
      snow: 0,
    }

    /** Every plant sprite at the default (high summer) palette. */
    const PLANT_SPRITES = buildPlantSet(DEFAULT_PLANT_LOOK)

    /** Seasonal plant sets, keyed by the look's coarse plant key. */
    const plantSetCache = new Map()

    /**
     * Plant sprites for the current seasonal look.
     *
     * Foliage is rebuilt, not tinted: at 6x a tinted canopy reads as a colour
     * filter over the meadow, while an ochre, a bare or a snow-capped one reads
     * as the season.
     * @param {object|null} look - seasonal look (`null` for the default palette).
     * @returns {object} plant sprite set.
     */
    function plantSpritesFor(look) {
      if (look === null || look === undefined) return PLANT_SPRITES
      const key = look.plantKey ?? 0
      const cached = plantSetCache.get(key)
      if (cached !== undefined) return cached
      const set = buildPlantSet(look)
      // Fifty-odd sprites per look and only a few looks are ever alive at once.
      if (plantSetCache.size > 12) plantSetCache.clear()
      plantSetCache.set(key, set)
      return set
    }

    /**
     * The sprite for one plant: size, silhouette and phenology from its id.
     * @param {object} set - plant sprite set for the current look.
     * @param {object} plant - the plant record.
     * @returns {{width: number, height: number, pixels: Uint32Array}|undefined} sprite.
     */
    function plantSpriteFor(set, plant) {
      if (set === null || set === undefined) return undefined
      const id = plant.id | 0
      if (plant.variant === 'lily') return set.lily[id % set.lily.length]
      if (plant.variant === 'reed') return set.reed[0]
      if (plant.variant === 'bush') return set.bush[id % set.bush.length]
      const size = clamp(plant.size ?? 1, 1, 3) - 1
      if (isConifer(plant)) {
        const cones = set.conifer[size]
        return cones[((id >> 1) % cones.length + cones.length) % cones.length]
      }
      // Deciduous trees drop their leaves one by one as the season turns: the
      // threshold is staggered by id so the forest does not pop.
      const leafless = (set.bare ?? 0) > ((id % 7) / 7)
      const group = leafless ? set.leafless[size] : set.tree[size]
      return group[id % group.length]
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
     * Which atlas frame *set* one animal shows.
     *
     * The frame set comes from the pose table (18-sprites): the engine already
     * decided walk vs run from the pace multiplier (1 = walk, 1.25+ = chase or
     * flight), and re-deriving it from distance here made every animal run all
     * day because distance is scaled by the time-of-day factor.
     * @param {object} animal - the animal.
     * @param {object} [pose] - its pose, when the caller already resolved it.
     * @returns {'idle'|'walk'|'run'} frame role.
     */
    function atlasFrameRole(animal, pose) {
      const resolved = pose ?? poseFor(animal)
      if (animal.fleeing === true) return 'run'
      const moved = animal.prevX === undefined ? 0 : Math.hypot(animal.x - animal.prevX, animal.y - animal.prevY)
      // A pose that says "standing" while the animal slides across the meadow
      // would read as a bug, so motion wins over the pose's frame set.
      if (resolved.role === 'idle' && moved >= 0.06) return 'walk'
      return poseRole(animal, resolved)
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
    function drawAtlasAnimals(context, world, view, alpha, look) {
      if (atlas.ready !== true) return
      const seasonal = look ?? seasonLook(world)
      const shadow = shadowOffset(world)
      const scratch = beginDepthScratch()
      collectAnimals(world, view, alpha, scratch)
      context.save()
      context.imageSmoothingEnabled = false
      for (const index of sortDepth(scratch)) {
        drawAtlasAnimal(context, world, view, scratch.items[index], scratch.xs[index], scratch.ys[index], seasonal, shadow)
      }
      context.restore()
    }

    /**
     * Reused depth-sort scratch.
     *
     * This pass runs at display refresh rate and the first version allocated one
     * `{ animal, x, y }` object per visible creature per frame, which is exactly
     * the kind of garbage that shows up as a stutter every few seconds once the
     * map is 1024x640 and the herds are dense.
     */
    const depthScratch = { items: [], xs: [], ys: [], kinds: [], order: [], count: 0 }

    /**
     * Reset the depth scratch for one pass.
     * @returns {object} the scratch record.
     */
    function beginDepthScratch() {
      depthScratch.count = 0
      return depthScratch
    }

    /**
     * Collect the visible animals into the depth scratch.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {number} alpha - interpolation between the last two ticks.
     * @param {object} scratch - depth scratch.
     * @returns {void}
     */
    function collectAnimals(world, view, alpha, scratch) {
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 12 || x > view.x + view.width + 12) continue
        if (y < view.y - 14 || y > view.y + view.height + 8) continue
        const slot = scratch.count
        scratch.items[slot] = animal
        scratch.xs[slot] = x
        scratch.ys[slot] = y
        scratch.kinds[slot] = 0
        scratch.count = slot + 1
      }
    }

    /**
     * Sort the depth scratch by base row, far to near.
     * @param {object} scratch - depth scratch.
     * @returns {number[]} iteration order (a reused array).
     */
    function sortDepth(scratch) {
      const order = scratch.order
      const ys = scratch.ys
      const count = scratch.count
      for (let index = 0; index < count; index++) order[index] = index
      order.length = count
      order.sort((a, b) => ys[a] - ys[b])
      return order
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
    function drawAtlasAnimal(context, world, view, animal, x, y, look, shadow) {
      const scale = view.scale
      const baseScale = scale / 6
      const time = world.time ?? 0
      const slots = ATLAS_SLOTS[animal.species]
      if (slots === undefined) return
      const pose = poseFor(animal)
      const role = atlasFrameRole(animal, pose)
      const frames = slots[role] ?? slots.run ?? slots.idle
      // The gait phase is accumulated from distance travelled, so the feet are
      // planted on the ground instead of skating: a slow animal takes slow
      // steps and a fleeing one takes fast ones, without a speed if-chain.
      const gait = animal.gait ?? 0
      const phase = animal.phase ?? 0
      let frame
      if (role === 'run') frame = frames[Math.min(frames.length - 1, Math.floor(gait * frames.length))]
      else if (pose.pause) frame = frames[0]
      else frame = frames[Math.floor(time * 1.15 * pose.speed + phase * 3) % frames.length]
      const column = frame % ATLAS.columns
      const row = Math.floor(frame / ATLAS.columns)
      const stageScale = STAGE_SCALE[animal.stage ?? 'adult'] ?? 1
      const size = ATLAS_SIZE[animal.species] * baseScale * stageScale
      // Gallop rhythm: a running animal rises and falls and stretches in step.
      const running = role === 'run'
      const gaitPhase = running ? gait * Math.PI * 2 : 0
      const bob = running ? Math.sin(gaitPhase) * 0.07 * ATLAS.cellHeight * size : 0
      const stretch = running ? 1 + Math.sin(gaitPhase + Math.PI / 2) * 0.04 : 1
      // Grazing nod: a slow dip of the whole body. It is the only way two idle
      // frames can say "head down, eating" without new artwork.
      const nod = pose.nod > 0 ? Math.sin(time * 3.4 + phase * 6.3) * pose.nod * 0.4 * scale : 0
      const shake = pose.shake > 0
        ? (((world.tick + (animal.id ?? 0)) & 1) === 0 ? 1 : -1) * pose.shake * Math.max(0.8, scale * 0.3)
        : 0
      const heightScale = pose.squash / stretch
      const drawWidth = ATLAS.cellWidth * size * stretch
      const drawHeight = ATLAS.cellHeight * size * heightScale
      const screenX = (x - view.x) * scale + shake
      const feetY = (y - view.y) * scale + bob + pose.sink * scale + nod
      const bottomOffset = (ATLAS.cellHeight - ATLAS.baseline) * size * heightScale
      const top = feetY - drawHeight + bottomOffset
      const facingLeft = Math.cos(animal.heading) < 0
      const species = SPECIES[animal.species]
      context.save()
      if (species !== undefined && species.habitat === 'water') {
        // A ground shadow under a fish makes it read as hovering in mid air.
        // Water animals get a ripple ring instead, and sit a little higher.
        context.strokeStyle = 'rgba(214, 246, 255, ' + (0.38 * pose.shadow).toFixed(3) + ')'
        context.lineWidth = Math.max(1, size * 0.9)
        context.beginPath()
        context.ellipse(screenX, feetY - size * 2, ATLAS.cellWidth * size * 0.24,
          ATLAS.cellHeight * size * 0.085, 0, 0, Math.PI * 2)
        context.stroke()
      } else {
        // A soft shadow on the ground anchors the creature; without it a sprite
        // reads as a sticker pasted on the meadow. Offsetting it by the sun is
        // what tells the player it is morning rather than noon.
        context.fillStyle = 'rgba(10, 22, 14, ' + (0.2 * shadow.strength).toFixed(3) + ')'
        context.beginPath()
        context.ellipse(screenX + shadow.x * drawWidth, feetY + 1 + shadow.y * drawWidth * 0.5,
          ATLAS.cellWidth * size * 0.3 * pose.shadow,
          ATLAS.cellHeight * size * 0.09 * pose.shadow, 0, 0, Math.PI * 2)
        context.fill()
      }
      context.restore()
      context.save()
      if (pose.alpha < 1) context.globalAlpha = Math.max(0.15, pose.alpha)
      else if (species !== undefined && animal.energy / species.balance.maxEnergy < 0.22) context.globalAlpha = 0.62
      // Pivot on the feet: a crouched or leaning animal has to stay planted, or
      // it reads as floating above its own shadow.
      context.translate(screenX, feetY)
      if (pose.tilt !== 0) context.rotate((facingLeft ? -pose.tilt : pose.tilt) * Math.PI / 180)
      if (facingLeft) context.scale(-1, 1)
      context.drawImage(atlas.image,
        column * ATLAS.cellWidth, row * ATLAS.cellHeight, ATLAS.cellWidth, ATLAS.cellHeight,
        -drawWidth / 2, top - feetY, drawWidth, drawHeight)
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
     * @param {object} look - seasonal look (foliage palette and bareness).
     * @param {object} shadow - shadow offset fractions from `shadowOffset`.
     * @returns {void}
     */
    function drawPlantSprite(context, world, view, plant, look, shadow) {
      const set = plantSpritesFor(look)
      const sprite = plantSpriteFor(set, plant)
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
        // The sun drags the shadow sideways and makes it long at dawn and dusk;
        // at noon it sits under the canopy.
        const centreX = left + drawWidth * 0.5 + shadow.x * drawWidth
        const centreY = top + drawHeight - 1 + shadow.y * drawWidth
        const radiusX = drawWidth * 0.34
        const radiusY = Math.max(1.5, drawWidth * 0.11)
        // Two ellipses, not one: a single flat disc reads as a painted puddle at
        // 6x, a lighter outer ring over a darker core reads as a shadow.
        context.fillStyle = 'rgba(10, 22, 14, ' + (0.08 * shadow.strength).toFixed(3) + ')'
        context.beginPath()
        context.ellipse(centreX, centreY, radiusX * 1.02, radiusY * 1.4, 0, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = 'rgba(10, 22, 14, ' + (0.12 * shadow.strength).toFixed(3) + ')'
        context.beginPath()
        context.ellipse(centreX, centreY, radiusX * 0.66, radiusY * 0.85, 0, 0, Math.PI * 2)
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
    function drawDepthLayers(context, world, view, alpha, look) {
      const seasonal = look ?? seasonLook(world)
      const shadow = shadowOffset(world)
      const scratch = beginDepthScratch()
      for (const plant of world.trees) {
        if (plant.x < view.x - 14 || plant.x > view.x + view.width + 14) continue
        if (plant.y < view.y - 34 || plant.y > view.y + view.height + 10) continue
        const slot = scratch.count
        scratch.items[slot] = plant
        scratch.xs[slot] = plant.x
        scratch.ys[slot] = plant.y
        scratch.kinds[slot] = 1
        scratch.count = slot + 1
      }
      collectAnimals(world, view, alpha, scratch)
      context.save()
      context.imageSmoothingEnabled = false
      for (const index of sortDepth(scratch)) {
        const item = scratch.items[index]
        if (scratch.kinds[index] === 1) drawPlantSprite(context, world, view, item, seasonal, shadow)
        else drawAtlasAnimal(context, world, view, item, scratch.xs[index], scratch.ys[index], seasonal, shadow)
      }
      context.restore()
    }

    // The grass and water ramps used to live here as fixed tables. Both are now
    // seasonal and are built by `seasonLook` (17-palette) into the ground tables
    // in 20-render, so nothing is left to keep in sync at this level.

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
    //
    // Two consumers share this part: `paintView` fills a 1-px-per-cell ARGB
    // buffer (the low-zoom path, the tests, one-shot captures) and `paintWorld`
    // is that buffer over the whole map. At 1024x640 that is 655,360 cells per
    // frame, so the ground pass is written as table lookups: the season decides
    // the tables once, and the per-cell loop does no colour maths it can avoid.
    // docs/70-VISUAL.md carries the measured numbers.

    /**
     * The frame set one animal plays this tick.
     *
     * The pose table (18-sprites) owns the state→pose decision; this only reads
     * the plan back: hold a frame when the pose is paused, otherwise cycle the
     * walk frames by time, and use the single flattened flee frame for a run.
     * @param {object} entity - the animal.
     * @param {number} tick - world tick (drives the walk cycle).
     * @returns {object} compiled sprite.
     */
    function frameFor(entity, tick) {
      const set = SPRITES[entity.species]
      if (set === undefined) return null
      const pose = poseFor(entity)
      const role = poseRole(entity, pose)
      if (role === 'run') return set.flee
      if (role === 'walk') {
        if (pose.pause === true) return set.walk[0]
        const phase = Math.floor(tick / 2 * pose.speed + (entity.phase ?? 0) * 4) % set.walk.length
        return set.walk[phase]
      }
      return set.idle
    }

    /**
     * Paint one sprite, clipped to the buffer.
     *
     * The optional pose applies three cheap transforms that need no canvas: a
     * vertical squash, a settle into the ground, and a per-row shear for the
     * lean. They are what let two idle frames express a crouch, a sleep or a
     * stalk at 1 px per cell.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} width - buffer width.
     * @param {number} height - buffer height.
     * @param {object} sprite - compiled sprite.
     * @param {number} left - buffer column of the sprite's left edge.
     * @param {number} top - buffer row of the sprite's top edge.
     * @param {boolean} flip - mirror horizontally.
     * @param {number} [factor] - brightness multiplier.
     * @param {object} [pose] - normalised pose (identity when omitted).
     */
    function drawSprite(out, width, height, sprite, left, top, flip, factor, pose) {
      const spriteWidth = sprite.width
      const squash = pose === undefined ? 1 : pose.squash
      const sink = pose === undefined ? 0 : pose.sink
      const shear = pose === undefined ? 0 : pose.tilt / 14
      const middle = (sprite.height - 1) / 2
      for (let y = 0; y < sprite.height; y++) {
        const targetY = top + Math.floor(y * squash + sink)
        if (targetY < 0 || targetY >= height) continue
        const rowBase = y * spriteWidth
        const targetBase = targetY * width
        const shift = shear === 0 ? 0 : Math.round(shear * (y - middle))
        for (let x = 0; x < spriteWidth; x++) {
          const color = sprite.pixels[rowBase + (flip ? spriteWidth - 1 - x : x)]
          if (color === 0) continue
          const targetX = left + x + shift
          if (targetX < 0 || targetX >= width) continue
          out[targetBase + targetX] = factor === undefined ? color : dimColor(color, factor)
        }
      }
    }

    // ---------------------------------------------------------------------
    // Ground tables
    // ---------------------------------------------------------------------

    /**
     * Grass colour table: 8 cover steps x 32 brightness deltas.
     *
     * The old per-cell path ran `nudgeColor` (three clamps and a repack) on
     * every one of 655k cells; a lookup is roughly a quarter of the cost and the
     * output is identical.
     */
    const GRASS_LUT = new Int32Array(GRASS_STEPS * 32)
    const grassLutState = { key: -1 }

    /**
     * Fill the grass table for one seasonal look.
     * @param {object} look - seasonal look.
     * @returns {Int32Array} the shared table.
     */
    function grassLutFor(look) {
      if (grassLutState.key === look.key) return GRASS_LUT
      for (let step = 0; step < GRASS_STEPS; step++) {
        for (let delta = 0; delta < 32; delta++) {
          GRASS_LUT[(step << 5) | delta] = nudgeColor(look.ramp[step], delta - 16)
        }
      }
      grassLutState.key = look.key
      return GRASS_LUT
    }

    /** Slow sine fields, cached per world size: the meadow's patches and snow drifts. */
    const patchState = {
      width: 0, height: 0, xs: null, ys: null,
      driftX: null, driftY: null, driftU: null, driftV: null, driftM: null, driftN: null,
    }

    /**
     * Build one separable sine table pair.
     * @param {number} length - table length in cells.
     * @param {number} frequency - radians per cell.
     * @param {number} offset - phase offset in radians.
     * @returns {Float64Array} table.
     */
    function sineTable(length, frequency, offset) {
      const table = new Float64Array(length)
      for (let index = 0; index < length; index += 1) table[index] = Math.sin(index * frequency + offset)
      return table
    }

    /**
     * Sine tables for the patch field and the snow drifts.
     *
     * Both fields are separable (`sin(x*a) * sin(y*b)`), so 1-D tables replace
     * `Math.sin` in the per-cell loop. The snow field is deliberately made of two
     * frequencies: a single hash-based dither printed a 2-cell checkerboard over
     * the whole winter map, which reads as static rather than as snow.
     * @param {number} width - world width in cells.
     * @param {number} height - world height in cells.
     * @returns {object} the table record.
     */
    function patchTablesFor(width, height) {
      if (patchState.width === width && patchState.height === height) return patchState
      patchState.xs = sineTable(width, 0.055, 0.7)
      patchState.ys = sineTable(height, 0.043, -1.1)
      // Drift field: three crossed undulations at 33, 18 and 11 cells. One pair
      // alone prints round polka dots; stacking scales gives banks that read as
      // depth instead of spots.
      patchState.driftX = sineTable(width, 0.19, 0.3)
      patchState.driftY = sineTable(height, 0.23, -0.7)
      patchState.driftU = sineTable(width, 0.35, 1.7)
      patchState.driftV = sineTable(height, 0.29, 0.2)
      patchState.driftM = sineTable(width, 0.11, -2.1)
      patchState.driftN = sineTable(height, 0.13, 0.9)
      patchState.width = width
      patchState.height = height
      return patchState
    }

    /** Snow tints as channel triplets, for the fixed-point snow blend. */
    const SNOW_TINT_LIGHT = [SNOW_COLORS.light & 0xFF, (SNOW_COLORS.light >>> 8) & 0xFF, (SNOW_COLORS.light >>> 16) & 0xFF]
    const SNOW_TINT_MID = [SNOW_COLORS.mid & 0xFF, (SNOW_COLORS.mid >>> 8) & 0xFF, (SNOW_COLORS.mid >>> 16) & 0xFF]

    /** Water depth buckets: the depth ramp is sampled, not recomputed per cell. */
    const WATER_BUCKETS = 128
    /** Caustic brightness steps; 17 keeps the banding below one channel step. */
    const CAUSTIC_STEPS = 17
    const waterState = { key: -1, base: null, caustic: null, ripple: null }

    /**
     * Water colour tables for one seasonal look.
     *
     * Depth ramp x three dither shades, plus a pre-blended caustic ramp per
     * depth: a water cell then costs two array reads instead of three blends.
     * @param {object} look - seasonal look.
     * @returns {object} `{ base, caustic, ripple }` tables.
     */
    function waterTablesFor(look) {
      if (waterState.key === look.key) return waterState
      const water = look.water
      const steps = WATER_BUCKETS + 1
      const base = new Int32Array(steps * 3)
      /** Foam strength per dither shade: the ring breaks up instead of being drawn. */
      const FOAM_BY_SHADE = [0.66, 0.92, 0.5]
      for (let bucket = 0; bucket < steps; bucket++) {
        const d = bucket / WATER_BUCKETS
        let color = blendColor(water.surface, water.shallow, Math.min(1, d * 5))
        color = blendColor(color, water.mid, clamp((d - 0.04) * 2.5, 0, 1))
        color = blendColor(color, water.deep, Math.min(0.92, clamp((d - 0.22) * 2.3, 0, 1)))
        // Shoreline foam. One hard step at 0.055 read as a sticker outline at 6x,
        // so it is four graded bands now, and each of the three dither shades gets
        // a different foam strength: the foam ring is interrupted cell by cell
        // instead of being a clean contour, and weed drawn afterwards covers it.
        const foamBase = d < 0.04 ? 0.8 : d < 0.085 ? 0.56 : d < 0.15 ? 0.32 : d < 0.24 ? 0.15 : 0
        for (let shade = 0; shade < 3; shade++) {
          let shaded = color
          if (foamBase > 0) shaded = blendColor(color, water.foam, foamBase * FOAM_BY_SHADE[shade])
          base[bucket * 3 + shade] = shade === 1 ? shaded : nudgeColor(shaded, shade === 0 ? -4 : 4)
        }
      }
      const caustic = new Int32Array(steps * 3 * CAUSTIC_STEPS)
      const ripple = new Int32Array(steps * 3)
      for (let bucket = 0; bucket < steps; bucket++) {
        for (let shade = 0; shade < 3; shade++) {
          const color = base[bucket * 3 + shade]
          ripple[bucket * 3 + shade] = blendColor(color, water.foam, 0.12)
          for (let step = 0; step < CAUSTIC_STEPS; step++) {
            caustic[(bucket * 3 + shade) * CAUSTIC_STEPS + step] =
              blendColor(color, water.caustic, (0.36 * step) / (CAUSTIC_STEPS - 1))
          }
        }
      }
      waterState.key = look.key
      waterState.base = base
      waterState.caustic = caustic
      waterState.ripple = ripple
      return waterState
    }

    /** Per-frame separable sine terms for the caustic field. */
    const waveState = { width: 0, height: 0, cols: null, rows: null }

    /**
     * Build the per-column and per-row sine terms of the caustic field.
     *
     * The three travelling waves are sums of `sin(A + B)` terms with A from the
     * column and B from the row, so each wave becomes two multiplies and an add
     * per cell instead of three `Math.sin` calls.
     * @param {number} width - view width in cells.
     * @param {number} height - view height in cells.
     * @param {number} originX - view origin column.
     * @param {number} originY - view origin row.
     * @param {number} time - seconds of ripple drift.
     * @returns {object} `{ cols, rows }` tables, six terms each.
     */
    function waveTablesFor(width, height, originX, originY, time) {
      if (waveState.width !== width || waveState.height !== height) {
        waveState.width = width
        waveState.height = height
        waveState.cols = new Float64Array(width * 6)
        waveState.rows = new Float64Array(height * 6)
      }
      const cols = waveState.cols
      for (let col = 0; col < width; col++) {
        const x = originX + col
        const base = col * 6
        cols[base] = Math.sin(x * 0.31)
        cols[base + 1] = Math.cos(x * 0.31)
        cols[base + 2] = Math.sin(x * 0.13)
        cols[base + 3] = Math.cos(x * 0.13)
        cols[base + 4] = Math.sin(x * 0.07)
        cols[base + 5] = Math.cos(x * 0.07)
      }
      const rows = waveState.rows
      const termB1 = time * 1.9
      const termB2 = time * 1.3
      const termB3 = -time * 0.7
      for (let row = 0; row < height; row++) {
        const y = originY + row
        const base = row * 6
        rows[base] = Math.cos(y * 0.17 + termB1)
        rows[base + 1] = Math.sin(y * 0.17 + termB1)
        rows[base + 2] = Math.cos(y * 0.41 + termB2)
        rows[base + 3] = Math.sin(y * 0.41 + termB2)
        rows[base + 4] = Math.cos(y * 0.09 + termB3)
        rows[base + 5] = Math.sin(y * 0.09 + termB3)
      }
      return waveState
    }

    /**
     * Ground pass: terrain, vegetation cover, water caustics, weed and snow.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} look - seasonal look.
     */
    function paintGround(world, view, out, look) {
      const terrain = world.terrain
      const grass = world.grass
      const weed = world.weed
      const depth = world.depth
      const time = world.tick * 0.05
      const tables = patchTablesFor(world.width, world.height)
      const patchXs = tables.xs
      const patchYs = tables.ys
      const tick = world.tick
      const ramp = grassLutFor(look)
      const water = waterTablesFor(look)
      const waterBase = water.base
      const waterCaustic = water.caustic
      const waterRipple = water.ripple
      const waves = waveTablesFor(view.width, view.height, view.x, view.y, time)
      const colTerms = waves.cols
      const rowTerms = waves.rows
      const snow = look.snow
      const weedColors = look.weed
      // Only the shallow shore sparks: a bright speck in deep water reads as a bug.
      const ripplePhase = Math.round(time * 6)
      for (let row = 0; row < view.height; row++) {
        const worldY = view.y + row
        const rowBase = worldY * world.width
        const outBase = row * view.width
        const termBase = row * 6
        const patchY = patchYs[worldY]
        // Hoisted out of the column loop: the clump field is separable too.
        const clumpRow = tables.driftV[worldY] * 3
        for (let col = 0; col < view.width; col++) {
          const worldX = view.x + col
          const index = rowBase + worldX
          const surface = terrain[index]
          const noise = ditherAt(worldX, worldY)
          let color
          if (surface === TERRAIN.WATER) {
            const rawDepth = depth[index]
            const d = rawDepth === undefined ? 0 : rawDepth
            const bucket = rawDepth === undefined ? 0 : Math.min(WATER_BUCKETS, (d * WATER_BUCKETS) | 0)
            const shade = noise < 60 ? 0 : (noise > 196 ? 2 : 1)
            // The field is two travelling waves multiplied (which gives moving
            // patches instead of a plaid) plus one third wave that breaks the
            // lattice symmetry of the product.
            const waveOne = colTerms[col * 6] * rowTerms[termBase] + colTerms[col * 6 + 1] * rowTerms[termBase + 1]
            const waveTwo = colTerms[col * 6 + 2] * rowTerms[termBase + 2] - colTerms[col * 6 + 3] * rowTerms[termBase + 3]
            const waveThree = colTerms[col * 6 + 4] * rowTerms[termBase + 4] - colTerms[col * 6 + 5] * rowTerms[termBase + 5]
            const wave = waveOne * waveTwo + 0.45 * waveThree
            const tableIndex = bucket * 3 + shade
            color = waterBase[tableIndex]
            if (wave > 0.38) {
              const step = Math.min(CAUSTIC_STEPS - 1, ((wave - 0.38) * 0.5 / 0.36 * (CAUSTIC_STEPS - 1)) | 0)
              color = waterCaustic[tableIndex * CAUSTIC_STEPS + step]
            }
            if (d > 0.1 && ((worldX * 3 + worldY * 5 + ripplePhase) & 15) < 2) {
              color = waterRipple[tableIndex]
            }
            // Icy shallows: in deep winter the rim of the lake freezes before the
            // middle does, and that white edge is most of what says "frozen". The
            // drift field breaks the contour up: a pure depth threshold printed a
            // perfect white disc wherever the lake had a shoal.
            if (snow > 0.4 && d < 0.24) {
              const ice = clamp((0.24 - d) * 3.4 * (0.55 + 0.9 * snowDriftAt(tables, worldX, worldY)), 0, 0.88)
              if (ice > 0.05) color = blendColor(color, snow > 0.8 ? SNOW_COLORS.light : SNOW_COLORS.mid, ice * snow)
            }
            const cover = weed[index]
            // Submerged weed dies back under the ice, so the frozen water shows
            // through in winter instead of staying a green soup.
            const weedStrength = snow > 0.4 ? 1 - snow * 0.55 : 1
            // Weed is shallow-water growth: it thins out over the deep water, so
            // even a lake covered edge to edge still reads blue in the middle
            // (it used to be a mint-green pond whenever the weed field was
            // saturated).
            const weedDepth = d < 0.16 ? 1 : clamp(1 - (d - 0.16) * 1.8, 0, 1)
            if (cover > 0.05 && weedStrength > 0.05 && weedDepth > 0.02) {
              const lush = cover > 0.55
              const sway = SWAY[(worldX + (world.tick >> 3)) & 15]
              color = blendColor(color, weedColors[lush ? 1 : 0], Math.min(0.82, cover * 1.05) * weedStrength * weedDepth)
              // A bright stalk every few cells turns a flat green wash into
              // something that reads as plants growing off the bottom.
              if (cover > 0.34 && noise > 168) color = blendColor(color, PALETTE.weedStalk, 0.5)
              else if (cover > 0.2 && sway > 2) color = nudgeColor(color, 5)
            }
          } else if (surface === TERRAIN.SAND || surface === TERRAIN.DIRT) {
            color = surface === TERRAIN.SAND
              ? nudgeColor(PALETTE.sand[noise > 200 ? 2 : 0], noiseAt(noise))
              : nudgeColor(PALETTE.dirt[noise > 205 ? 2 : 0], noiseAt(noise))
            // Damp weed on the bank has to be visible, or painting it looks
            // like nothing happened.
            const damp = weed[index]
            if (damp > 0.3) color = blendColor(color, weedColors[1], Math.min(0.5, damp * 0.55))
            // Snow settles in patches, not per-pixel: the dither is sampled in
            // 2x2 blocks, which at 6x reads as banks of snow instead of static.
            if (snow > 0.15) color = snowCovered(color, snow, 1, snowDriftAt(tables, worldX, worldY))
          } else if (surface === TERRAIN.STONE) {
            color = nudgeColor(PALETTE.stone[noise > 198 ? 2 : 1], noiseAt(noise))
            if (snow > 0.15) color = snowCovered(color, snow, 0.8, snowDriftAt(tables, worldX, worldY))
          } else {
            const cover = grass[index]
            const step = cover <= 0 ? 0 : Math.min(GRASS_STEPS - 1, (cover * GRASS_STEPS) | 0)
            // Wind sway, phased by the cell hash instead of by (x*5 + y*11): the
            // arithmetic version repeated every 16 cells and printed diagonal
            // bands over the whole meadow.
            const sway = SWAY[(noise + (tick >> 2)) & 15]
            // Three scales of variation: a cell-level flicker (blades), a medium
            // clump field, and the slow one for patches of drier and lusher
            // ground. Without them the meadow is one flat green sheet.
            const clump = (tables.driftU[worldX] * clumpRow) | 0
            let delta = sway + clump + ((patchXs[worldX] * patchY * 7) | 0)
            if (noise < 48) delta += 3
            if (delta < -16) delta = -16
            else if (delta > 15) delta = 15
            color = ramp[(step << 5) | (delta + 16)]
            // Grass gets texture the way a real pixel meadow does: a scattering
            // of brighter blades and the odd flower on the thickest cells. This
            // is what separates "grass" from "green floor" at 6x zoom.
            if (cover > 0.3 && (noise & 63) < 3) color = nudgeColor(color, 12)
            else if (cover > 0.55 && (noise & 255) < 2) color = PALETTE.flowers[(worldX * 3 + worldY * 5) & 3]
            else if (cover < 0.08 && (noise & 63) === 5) color = blendColor(color, PALETTE.dirt[0], 0.5)
            // Snow settles on open ground first: tall cover still pokes through,
            // which is the difference between "winter" and "white paint".
            if (snow > 0.15) color = snowCovered(color, snow, 0.78 + cover * 0.18, snowDriftAt(tables, worldX, worldY))
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
     * @param {object} look - seasonal look.
     * @param {object} shadow - sun shadow offset fractions.
     */
    function paintPlants(world, view, out, look, shadow) {
      const set = plantSpritesFor(look)
      const visible = plantScratch
      let count = 0
      const margin = 16
      for (const plant of world.trees) {
        if (plant.x < view.x - margin || plant.x > view.x + view.width + margin) continue
        if (plant.y < view.y - margin - 10 || plant.y > view.y + view.height + margin) continue
        visible.order[count] = plant
        visible.ys[count] = plant.y
        count += 1
      }
      if (count === 0) return
      const order = visible.sorted
      for (let index = 0; index < count; index++) order[index] = index
      order.length = count
      const ys = visible.ys
      order.sort((a, b) => ys[a] - ys[b])
      const tick = world.tick
      const strength = shadow.strength
      for (let index = 0; index < count; index++) {
        const plant = visible.order[order[index]]
        const sprite = plantSpriteFor(set, plant)
        if (sprite === undefined) continue
        const baseX = Math.round(plant.x - view.x)
        const baseY = Math.round(plant.y - view.y)
        const swayX = ((tick >> 3) + plant.id) % 16 < 8 ? 0 : 1
        // Three shades keyed off the plant id: a forest of one identical stamp
        // reads as wallpaper, three shades read as a forest.
        const shade = [0.93, 1, 1.07][plant.id % 3]
        const factor = (plant.foliage ?? 1) < 0.35 ? 0.84 * shade : shade
        // A shadow anchors the plant to the ground; without it a canopy looks
        // like it is floating above the meadow, and the sun angle is what makes
        // the same forest look different at dawn and at noon.
        if (plant.variant !== 'lily' && strength > 0.08) {
          shadeEllipse(out, view, baseX + shadow.x * sprite.width, baseY + 1 + shadow.y * sprite.width,
            Math.max(2, sprite.width * 0.36), Math.max(1.2, sprite.width * 0.16), strength, (look.snow ?? 0) * 0.6)
        }
        drawSprite(out, view.width, view.height, sprite,
          baseX - (sprite.width >> 1) + swayX, baseY - sprite.height + 1, false, factor)
      }
    }

    /**
     * Lay snow over one ground pixel.
     *
     * A binary "white or grass" test printed a checkerboard at 6x, which read as
     * static rather than snow. Blending by a blocky noise value instead keeps the
     * underlying terrain visible through the shallow cover and builds up to solid
     * white where the noise is high, so the meadow turns into banks.
     * @param {number} color - the ground colour.
     * @param {number} snow - seasonal snow cover 0..1.
     * @param {number} exposure - how much the surface pokes through (1 = open).
     * @param {number} flake - 0..1 drift field sample.
     * @returns {number} packed colour.
     */
    function snowCovered(color, snow, exposure, flake) {
      // `flake` is the smooth drift field (0..1), with a little per-cell texture on
      // top: the drifts give the banks, the texture keeps them from looking flat.
      const amount = snow * (0.64 + 0.44 * flake) - (exposure - 1) * 0.35
      if (amount < 0.06) return color
      // Fixed-point blend instead of blendColor: this runs on every land pixel
      // of a winter frame, and the float version measured 13 ms of the 32 ms
      // winter ground pass on its own.
      const q = amount > 1 ? 256 : (amount * 256) | 0
      const inv = 256 - q
      const tint = amount > 0.66 ? SNOW_TINT_LIGHT : SNOW_TINT_MID
      return (0xFF000000
        | (((((color >>> 16) & 0xFF) * inv + tint[2] * q) >> 8) << 16)
        | (((((color >>> 8) & 0xFF) * inv + tint[1] * q) >> 8) << 8)
        | ((((color & 0xFF) * inv + tint[0] * q) >> 8))) >>> 0
    }

    /**
     * Snow drift field at one cell, 0..1.
     *
     * Two crossed sine undulations plus a very small per-cell jitter. It is
     * smooth on purpose: the buffer is upscaled 6x, so any per-cell binary choice
     * prints as a checkerboard of 6-pixel squares.
     * @param {object} tables - patch tables.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @returns {number} 0..1 drift value.
     */
    function snowDriftAt(tables, x, y) {
      const broad = tables.driftX[x] * tables.driftY[y]
      const middle = tables.driftU[x] * tables.driftV[y]
      const fine = tables.driftM[x] * tables.driftN[y]
      return clamp(0.5 + 0.26 * broad + 0.16 * middle + 0.1 * fine, 0, 1)
    }

    /**
     * Darken a soft ellipse of ground pixels, for plant and creature shadows.
     *
     * Written as row spans rather than a bounding-box scan: every row is one
     * contiguous run of ground pixels, so the writes stay in a few cache lines
     * and the inner loop has no division and no ellipse test. That matters —
     * once a full forest is on screen this layer costs more than the ground
     * itself, and the bounding-box version measured 20x slower for the same
     * pixels (docs/70-VISUAL.md).
     *
     * Two intensity bands instead of one: a single flat ellipse reads as a
     * painted rectangle at the sizes trees have here.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} view - viewport.
     * @param {number} cx - centre column in buffer space.
     * @param {number} cy - centre row in buffer space.
     * @param {number} rx - radius x.
     * @param {number} ry - radius y.
     * @param {number} [strength] - 0..1 shadow opacity (sun elevation).
     * @param {number} [cool] - 0..1 how much the shadow keeps a blue cast (snow).
     */
    function shadeEllipse(out, view, cx, cy, rx, ry, strength = 1, cool = 0) {
      if (strength <= 0.02 || rx <= 0 || ry <= 0) return
      const viewWidth = view.width
      const viewHeight = view.height
      // Fixed-point multipliers: (channel * q) >> 8, no float per channel.
      const outerQ = Math.round((1 - 0.14 * strength) * 256)
      const innerQ = Math.round((1 - 0.28 * strength) * 256)
      const fromY = Math.max(0, Math.ceil(cy - ry))
      const toY = Math.min(viewHeight - 1, Math.floor(cy + ry))
      for (let y = fromY; y <= toY; y++) {
        const ny = (y - cy) / ry
        const inside = 1 - ny * ny
        if (inside <= 0) continue
        const span = Math.sqrt(inside) * rx
        const fromX = Math.max(0, Math.ceil(cx - span))
        const toX = Math.min(viewWidth - 1, Math.floor(cx + span))
        if (fromX > toX) continue
        const q = Math.abs(ny) > 0.72 ? outerQ : innerQ
        const rowBase = y * viewWidth
        // On snow a neutral multiply reads as grey paint; keeping a little more
        // blue in the shadow is what makes it read as snow in shade.
        const bq = cool <= 0 ? q : q + Math.round((256 - q) * cool * 0.2)
        for (let x = fromX; x <= toX; x++) {
          const color = out[rowBase + x]
          out[rowBase + x] = (0xFF000000
            | (((((color >>> 16) & 0xFF) * bq) >> 8) << 16)
            | (((((color >>> 8) & 0xFF) * q) >> 8) << 8)
            | (((color & 0xFF) * q) >> 8)) >>> 0
        }
      }
    }

    /**
     * Carcasses pass.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} shadow - sun shadow offset fractions.
     */
    function paintCorpses(world, view, out, shadow) {
      for (const corpse of world.corpses) {
        if (corpse.x < view.x - 4 || corpse.x > view.x + view.width + 4) continue
        if (corpse.y < view.y - 4 || corpse.y > view.y + view.height + 4) continue
        const sprite = CORPSE_SPRITES[corpse.decay > 0.6 ? 1 : 0]
        drawSprite(out, view.width, view.height, sprite,
          Math.round(corpse.x - view.x - sprite.width / 2 + shadow.x * 2),
          Math.round(corpse.y - view.y - 1),
          false, Math.max(0.45, 1 - corpse.decay * 0.5))
      }
    }

    /** Reused index buffers for the animal pass: no per-frame object garbage. */
    const animalScratch = { order: [], ys: [], xs: [], sorted: [], count: 0 }
    /** Reused index buffers for the plant pass. */
    const plantScratch = { order: [], ys: [], sorted: [] }

    /**
     * Animals pass, with motion interpolation, poses and body-sized shadows.
     *
     * Positions are interpolated between the last two simulation ticks (10 Hz)
     * up to the display refresh rate, which is what turns 10 stepping blobs into
     * sixty smooth ones.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} alpha - 0..1 between the last two ticks.
     * @param {object} shadow - sun shadow offset fractions.
     * @param {boolean} castShadow - whether creatures cast a ground shadow.
     */
    function paintAnimals(world, view, out, alpha, shadow, castShadow) {
      const scratch = animalScratch
      let count = 0
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 8 || x > view.x + view.width + 8) continue
        if (y < view.y - 10 || y > view.y + view.height + 6) continue
        scratch.xs[count] = x
        scratch.ys[count] = y
        scratch.order[count] = animal
        count += 1
      }
      if (count === 0) return
      const sorted = scratch.sorted
      for (let index = 0; index < count; index++) sorted[index] = index
      sorted.length = count
      const ys = scratch.ys
      sorted.sort((a, b) => ys[a] - ys[b])
      const strength = shadow.strength
      for (let index = 0; index < count; index++) {
        const slot = sorted[index]
        const animal = scratch.order[slot]
        const x = scratch.xs[slot]
        const y = scratch.ys[slot]
        const sprite = frameFor(animal, world.tick)
        if (sprite === null) continue
        const pose = poseFor(animal)
        const species = SPECIES[animal.species]
        const maxEnergy = species === undefined ? 1 : species.balance.maxEnergy
        const ratio = animal.energy / maxEnergy
        let factor
        if (ratio < 0.22) factor = 0.72
        else if (pose.alpha < 1) factor = pose.alpha
        const centreX = Math.round(x - view.x - sprite.width / 2)
        const feetX = centreX + (sprite.width >> 1)
        const feetY = Math.round(y - view.y)
        // Measure the top from the feet *through* the pose, so a crouched or
        // settled animal stays planted on its shadow instead of floating.
        const topY = feetY - Math.floor((sprite.height - 1) * pose.squash) - Math.round(pose.sink)
        if (species !== undefined && species.habitat === 'water') {
          // A shadow under a fish makes it read as hovering in mid air; a bright
          // ripple ring under it says "in the water" instead.
          if (feetX >= 0 && feetX < view.width && feetY >= 0 && feetY < view.height) {
            const cell = feetY * view.width + feetX
            out[cell] = blendColor(out[cell], PALETTE.waterSurface, 0.4)
          }
        } else if (castShadow && strength > 0.08) {
          // The cast shadow scales with the body: a juvenile's is visibly
          // smaller than an adult's, which is the cheapest way for size to be
          // readable before the camera is close enough to see the sprite.
          const bodyScale = STAGE_SCALE[animal.stage ?? 'adult'] ?? 1
          const radius = Math.max(1.3, sprite.width * 0.45 * pose.shadow * bodyScale)
          shadeEllipse(out, view,
            Math.round(feetX + shadow.x * sprite.width),
            Math.round(feetY + shadow.y * sprite.width),
            radius, Math.max(1, sprite.height * 0.24 * bodyScale), strength * pose.shadow)
        }
        drawSprite(out, view.width, view.height, sprite, centreX, topY, Math.cos(animal.heading) < 0, factor, pose)
      }
    }

    /**
     * Trails, footfalls and behaviour effects: the layer that says "something
     * happened".
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} budget - how many detail particles this view may spend.
     */
    function paintActivity(world, view, out, budget) {
      const tick = world.tick
      for (const animal of world.entities) {
        const trail = TRAIL_COLORS[animal.species]
        if (trail === undefined || animal.prevX === undefined) continue
        const movedX = animal.x - animal.prevX
        const movedY = animal.y - animal.prevY
        const moved = Math.hypot(movedX, movedY)
        if (moved < 0.3) continue
        const x = Math.round(animal.prevX) - view.x
        const y = Math.round(animal.prevY) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = trail
        // Footfall dust: one kick per stride, thrown behind a moving animal. It
        // is a close-up detail — on a full-map capture it would be noise — so it
        // shares the particle budget instead of running everywhere.
        if (budget <= 0) continue
        const gait = animal.gait ?? 0
        // One kick per stride: the first eighth of the gait cycle, so the dust
        // pulses with the feet instead of smoking continuously.
        const stride = gait * 4 - Math.floor(gait * 4)
        if (stride < 0.125 && moved > 0.35) {
          const offsetX = Math.round(x - (movedX / moved) * 1.5)
          const offsetY = Math.round(y - (movedY / moved) * 1.2)
          if (offsetX >= 0 && offsetY >= 0 && offsetX < view.width && offsetY < view.height) {
            const index = offsetY * view.width + offsetX
            out[index] = blendColor(out[index], DUST_COLORS[(tick + (animal.id ?? 0)) & 1], 0.45)
          }
        }
      }
      for (const effect of world.effects) {
        const life = clamp(effect.life / effect.maxLife, 0, 1)
        const x = (effect.x | 0) - view.x
        const y = (effect.y | 0) - view.y
        if (x < -3 || y < -3 || x > view.width + 3 || y > view.height + 3) continue
        if (x >= 0 && y >= 0 && x < view.width && y < view.height) {
          out[y * view.width + x] = dimColor(effect.color, 0.35 + life * 0.65)
        }
        // Splashes and strikes on water throw a ring that widens as it fades;
        // without it a hunt in the lake is a single flashing pixel. The water
        // test reads the terrain here, so the engine needs no new field.
        const effectX = effect.x | 0
        const effectY = effect.y | 0
        const effectCell = effectX >= 0 && effectY >= 0 && effectX < world.width && effectY < world.height
          ? effectY * world.width + effectX
          : -1
        if (effectCell >= 0 && world.terrain[effectCell] === TERRAIN.WATER) {
          const radius = 1 + Math.round((1 - life) * 2.5)
          for (let angle = 0; angle < 8; angle++) {
            const radians = (angle / 8) * Math.PI * 2
            const ringX = x + Math.round(Math.cos(radians) * radius)
            const ringY = y + Math.round(Math.sin(radians) * radius)
            if (ringX < 0 || ringY < 0 || ringX >= view.width || ringY >= view.height) continue
            out[ringY * view.width + ringX] = dimColor(PALETTE.effect.splash, 0.35 + life * 0.5)
          }
        }
      }
    }

    /** Falling flakes a single frame may draw, whatever the view size. */
    const WEATHER_FLAKES = 240

    /**
     * Weather pass: snow over a winter world.
     *
     * Flake positions come from the dither hash and the tick, so the same tick
     * always paints the same snow: the weather animates without making the frame
     * non-deterministic, and it costs one write per flake.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} look - seasonal look.
     */
    function paintWeather(world, view, out, look) {
      const snow = look.snow
      if (snow <= 0.15) return
      const cells = view.width * view.height
      const budget = Math.min(WEATHER_FLAKES, Math.max(0, (cells / 220) | 0))
      if (budget === 0) return
      const drift = world.tick * 0.31
      const fall = world.tick * 0.55
      const light = SNOW_COLORS.light
      for (let index = 0; index < budget; index++) {
        const seedX = DITHER[(index * 37) & 255]
        const seedY = DITHER[(index * 101 + 61) & 255]
        const speed = 0.6 + (DITHER[(index * 19 + 7) & 255] / 255) * 0.9
        const x = ((seedX / 255 * view.width + drift * speed) % view.width + view.width) % view.width
        const y = ((seedY / 255 * view.height + fall * speed) % view.height + view.height) % view.height
        const cell = (y | 0) * view.width + (x | 0)
        out[cell] = blendColor(out[cell], light, 0.5 + 0.4 * (snow - 0.15))
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

    /** Shared options record, so the hot path never allocates a default. */
    const EMPTY_VIEW_OPTIONS = { sprites: true, plants: true, weather: true, shadows: true }
    /** Shadow offset that paints nothing, used when the caller turns shadows off. */
    const NO_SHADOW = { x: 0, y: 0, strength: 0 }

    /**
     * Render one viewport of the world.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} [buffer] - reusable buffer of `width*height`.
     * @param {number} [alpha] - interpolation between the last two ticks.
     * @param {object|null} [overlay] - cursor and selection.
     * @param {object|null} [options] - `{ sprites, plants, weather, shadows }`;
     *   any of them may be false to skip that layer. Absent counts as on.
     * @returns {Uint32Array} the buffer that was written.
     */
    function paintView(world, view, buffer, alpha = 1, overlay = null, options = null) {
      const size = view.width * view.height
      const out = buffer !== undefined && buffer.length === size ? buffer : new Uint32Array(size)
      const opts = options === null || options === undefined ? EMPTY_VIEW_OPTIONS : options
      const spritesInBuffer = opts.sprites !== false
      const plantsInBuffer = opts.plants !== false
      const weatherInBuffer = opts.weather !== false
      const castShadow = opts.shadows !== false
      const look = seasonLook(world)
      const shadow = shadowOffset(world)
      paintGround(world, view, out, look)
      if (plantsInBuffer) paintPlants(world, view, out, look, castShadow ? shadow : NO_SHADOW)
      paintCorpses(world, view, out, shadow)
      if (spritesInBuffer) paintAnimals(world, view, out, alpha, shadow, castShadow)
      // The detail layers are close-up affordances: at a full-map view they cost
      // more than they show, so each one scales with how much of the world is on
      // screen. docs/70-VISUAL.md lists the budgets and the measured cost.
      const closeUp = size <= 48000
      paintActivity(world, view, out, closeUp ? 400 : 0)
      if (weatherInBuffer) paintWeather(world, view, out, look)
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
      const ramp = seasonLook(world).ramp
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
          else color = ramp[Math.min(GRASS_STEPS - 1, (world.grass[index] * GRASS_STEPS) | 0)]
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

    /** Event kinds the ticker understands, in display order. */
    const EVENT_KINDS = ['predation', 'birth', 'death', 'migration', 'hoard', 'placed']

    /**
     * Death causes the observer can attribute.
     *
     * The engine does not write a cause yet (docs/20-CORE-LOOP.md 2.1,
     * body.cause), so the store infers one from the last state it saw and the
     * panel labels it "inferred". A real cause wins the moment it exists.
     */
    const CAUSE_KEYS = ['predation', 'starved', 'frozen', 'old', 'disease', 'unknown']

    // The inspector draws DRIVE_KEYS, which behaviour owns in 09-needs.js: one
    // list, so a channel that exists in the model cannot be missing from the
    // panel. The order there is the contract order of docs/20-CORE-LOOP.md 2.2.

    /** How many events the store keeps, and how long an event stays news. */
    const MAX_EVENTS = 64
    const EVENT_TTL = 150

    /** Cells between plant-stock samples: the panel needs a trend, not a census. */
    const PLANT_STRIDE = 8

    /** Seconds of history the header pulse summarises. */
    const PULSE_SECONDS = 60

    /** Where the first-run guide remembers that it has been dismissed. */
    const ONBOARD_KEY = 'dsh-pixel-ecosystem:onboarded'

    /**
     * Energy a grazer draws from one cell-unit of each flora field.
     *
     * Derived from the species table instead of a second hand-tuned constant, so
     * the producer side of the energy panel moves when the diet data moves.
     */
    const FLORA_ENERGY = (() => {
      const sum = { grass: 0, weed: 0 }
      const count = { grass: 0, weed: 0 }
      for (const id of SPECIES_IDS) {
        const row = SPECIES[id]
        const field = row.flora
        if (field !== 'grass' && field !== 'weed') continue
        const energy = row.balance === undefined ? undefined : row.balance.floraEnergy
        if (!Number.isFinite(energy)) continue
        sum[field] += energy
        count[field] += 1
      }
      return {
        grass: count.grass === 0 ? 1 : sum.grass / count.grass,
        weed: count.weed === 0 ? 1 : sum.weed / count.weed,
      }
    })()

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
     * The body numbers the inspector shows, preferring the real ledger.
     *
     * sim-core owns body.{E,Emax,V,M,health,fatigue} (docs/20-CORE-LOOP.md 2.1).
     * Until a world carries them, the same fields are derived from state the
     * older model already has, and every derived value is flagged so the panel
     * never claims more than it knows.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {object} body view.
     */
    function bodyRecord(entity, species) {
      const balance = species.balance
      const body = entity.body
      if (body !== undefined && body !== null && Number.isFinite(body.E)) {
        return {
          reserve: body.E,
          reserveMax: Number.isFinite(body.Emax) ? body.Emax : balance.maxEnergy,
          structure: Number.isFinite(body.V) ? body.V : null,
          structureUnit: 'kg',
          maturity: Number.isFinite(body.M) ? body.M : null,
          health: Number.isFinite(body.health) ? body.health : null,
          fatigue: Number.isFinite(body.fatigue) ? body.fatigue : null,
          cause: typeof body.cause === 'string' && body.cause !== '' ? body.cause : null,
          derived: false,
        }
      }
      const needs = needsOf(entity)
      return {
        reserve: entity.energy,
        reserveMax: balance.maxEnergy,
        structure: entity.genes.size,
        structureUnit: 'gene',
        maturity: balance.maturity > 0 ? clamp(entity.age / balance.maturity, 0, 1) : 1,
        health: null,
        fatigue: clamp(needs.energy ?? 0, 0, 1),
        cause: null,
        derived: true,
      }
    }

    /**
     * Round to three decimals for display records; keeps snapshots comparable
     * and stops a score from rendering as 1.2400000000000002.
     * @param {number} value - number.
     * @returns {number} rounded, or 0 when not finite.
     */
    function round3(value) {
      return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
    }

    /**
     * Air temperature, preferring the climate step (13b-climate) and falling
     * back to the same sun-angle estimate the cold drive uses, so the header
     * thermometer and the cold bar can never disagree.
     * @param {object} world - the world.
     * @returns {number} degrees C.
     */
    function temperatureOf(world) {
      const climate = world.climate
      if (climate !== undefined && climate !== null && Number.isFinite(climate.temperature)) return climate.temperature
      if (typeof climateTemperature === 'function') return climateTemperature(world)
      return 4 + 18 * daylight(world)
    }

    /**
     * Cold stress, 0 comfortable to 1 freezing. Uses the same band as the drive
     * so an inferred death and a drawn bar agree.
     * @param {object} world - the world.
     * @returns {number} 0..1.
     */
    function coldOf(world) {
      return clamp((4 - temperatureOf(world)) / 18, 0, 1)
    }

    /**
     * The eight drive channels the inspector draws.
     *
     * Behaviour owns the real records (docs/20-CORE-LOOP.md 2.2). Until they
     * exist the panel derives every channel from the body and the needs it
     * already has, using the contract formula hunger = 1 - E/Emax. A drive bar
     * nobody can justify would be worse than an empty one, so the derivation is
     * returned flagged and the panel says so.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {{values: object, derived: boolean}} drives.
     */
    function drivesOf(world, entity, species) {
      if (entity.drives !== undefined && entity.drives !== null) {
        const values = {}
        for (const key of DRIVE_KEYS) values[key] = clamp(Number(entity.drives[key]) || 0, 0, 1)
        return { values, derived: false }
      }
      const needs = needsOf(entity)
      const body = bodyRecord(entity, species)
      const ratio = body.reserveMax > 0 ? clamp(body.reserve / body.reserveMax, 0, 1) : 0
      const traits = traitsOf(species)
      const values = {
        hunger: clamp(1 - ratio, 0, 1),
        thirst: clamp(needs.thirst ?? 0, 0, 1),
        cold: coldOf(world),
        fatigue: clamp(needs.energy ?? 0, 0, 1),
        fear: clamp(needs.safety ?? 0, 0, 1),
        social: clamp(needs.social ?? 0, 0, 1),
        libido: entity.stage === 'adult' && (entity.cooldown ?? 0) <= 0 ? clamp(ratio * 0.9, 0, 1) : 0.05,
        curiosity: 0,
      }
      // Curiosity is what is left when nothing is urgent: a bold, well-fed adult
      // is the one that wanders instead of standing still.
      const urgent = Math.max(values.hunger, values.thirst, values.cold, values.fear)
      values.curiosity = clamp((traits.curious ?? 0.5) * (1 - urgent) * (0.4 + ratio * 0.6), 0, 1)
      return { values, derived: true }
    }

    /**
     * Why this animal is doing what it is doing.
     *
     * Behaviour may publish its own sentence (entity.decideReason, or
     * entity.state.reason). Otherwise the loudest drive explains the intent. The
     * store returns a drive and its value, not a sentence, so the panel stays
     * bilingual.
     * @param {object} entity - the animal.
     * @param {object} drives - drive values.
     * @returns {object} reason record.
     */
    function reasonOf(entity, drives) {
      const decision = entity.decision
      if (decision !== undefined && decision !== null && typeof decision.picked === 'string') {
        const rivals = []
        if (Array.isArray(decision.alternatives)) {
          for (const rival of decision.alternatives.slice(0, 3)) {
            if (rival === null || typeof rival !== 'object') continue
            rivals.push({ kind: String(rival.kind), score: round3(rival.score) })
          }
        }
        return {
          text: typeof decision.text === 'string' ? decision.text : null,
          derived: false,
          picked: decision.picked,
          why: typeof decision.why === 'string' ? decision.why : 'idle',
          score: Number.isFinite(decision.score) ? round3(decision.score) : null,
          at: Number.isFinite(decision.at) ? decision.at : null,
          rivals,
          drive: null,
          driveValue: 0,
        }
      }
      // No decision record yet (a freshly spawned animal, or an older save):
      // the loudest drive still explains the intent, it just explains it less.
      let drive = 'curiosity'
      let top = -1
      for (const key of DRIVE_KEYS) {
        if (key === 'curiosity') continue
        const value = drives[key]
        if (value > top) { top = value; drive = key }
      }
      return {
        text: null, derived: true, picked: null, why: drive, score: null, at: null,
        rivals: [], drive, driveValue: clamp(top, 0, 1),
      }
    }

    /**
     * How many animals that hunt this one are within sight, using the last
     * observation instead of a fresh spatial query.
     * @param {object} observation - the last observation.
     * @param {string} speciesId - the species being looked at.
     * @param {number} x - position.
     * @param {number} y - position.
     * @param {number} radius - cells.
     * @returns {number} count.
     */
    function predatorsNear(observation, speciesId, x, y, radius) {
      if (observation === null) return 0
      const hunters = PREDATORS_OF[speciesId]
      if (hunters === undefined || hunters.size === 0) return 0
      const reach = radius * radius
      let found = 0
      for (const hunter of observation.hunters) {
        if (!hunters.has(hunter.species)) continue
        const dx = hunter.x - x
        const dy = hunter.y - y
        if (dx * dx + dy * dy <= reach) found += 1
      }
      return found
    }

    /**
     * The most likely way this animal dies if nothing changes.
     *
     * G5 wants failure to be explainable, and that has to work *before* the
     * animal is gone, which is exactly when the inspector can still be opened.
     * @param {object} entity - the animal.
     * @param {object} body - body view.
     * @param {object} drives - drive values.
     * @param {object} observation - the last observation.
     * @returns {string|null} cause key, or null when nothing is looming.
     */
    function predictCause(entity, body, drives, observation) {
      if (drives.hunger >= 0.75) return 'starved'
      if (drives.cold >= 0.65) return 'frozen'
      if (drives.fear >= 0.6 && predatorsNear(observation, entity.species, entity.x, entity.y, 8) > 0) return 'predation'
      if (Number.isFinite(entity.genes.lifespan) && entity.age >= entity.genes.lifespan * 0.85) return 'old'
      if (body.health !== null && body.health <= 0.25) return 'disease'
      return null
    }

    /**
     * Sample the standing producer stock without walking a quarter million cells.
     *
     * A strided sample is what an "is the meadow shrinking" panel needs; a full
     * census of the field costs more than drawing it.
     * @param {object} world - the world.
     * @returns {{grass: number, weed: number, energy: number}} mean cover and total energy.
     */
    function samplePlantStock(world) {
      const grass = world.grass
      const weed = world.weed
      const width = world.width
      const height = world.height
      let grassSum = 0
      let weedSum = 0
      let samples = 0
      for (let y = 0; y < height; y += PLANT_STRIDE) {
        const row = y * width
        for (let x = 0; x < width; x += PLANT_STRIDE) {
          grassSum += grass[row + x]
          weedSum += weed[row + x]
          samples += 1
        }
      }
      if (samples === 0) return { grass: 0, weed: 0, energy: 0 }
      const scale = (width * height) / samples
      return {
        grass: grassSum / samples,
        weed: weedSum / samples,
        // Biomass is kg per square metre, so one sample stands for a cell area of
        // ground, not one cell of pixels (docs/10 section 1: CELL_M = 2 m).
        energy: (grassSum * FLORA_ENERGY.grass + weedSum * FLORA_ENERGY.weed) * scale * CELL_AREA,
      }
    }

    /**
     * Attribute a death from the last state the animal was seen in.
     *
     * Order matters: the simulation kills on an empty reserve or on age, and a
     * predator removes an animal that still had reserves, so reserve is checked
     * first and a nearby hunter only decides an otherwise unexplained death.
     * @param {object} rec - last record of the animal.
     * @param {object[]} hunters - hunter positions from that sighting.
     * @returns {string} one of CAUSE_KEYS.
     */
    function classifyDeath(rec, hunters) {
      if (rec.cause !== null && rec.cause !== undefined) return rec.cause
      const predators = PREDATORS_OF[rec.species]
      let best = Infinity
      if (predators !== undefined && predators.size > 0 && rec.ratio > 0.02) {
        for (const hunter of hunters) {
          if (!predators.has(hunter.species)) continue
          const dx = hunter.x - rec.x
          const dy = hunter.y - rec.y
          const distance = dx * dx + dy * dy
          if (distance < best) best = distance
        }
      }
      if (best <= 20.25) return 'predation'
      if (rec.ratio <= 0.02) return 'starved'
      if (Number.isFinite(rec.lifespan) && rec.age >= rec.lifespan * 0.92) return 'old'
      if (rec.cold >= 0.6) return 'frozen'
      if (rec.health !== null && rec.health <= 0.2) return 'disease'
      return 'unknown'
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
      /** First-run flag; null means "not read from storage yet". */
      let onboardingFlag = null
      /** One-shot message about the save file: legacy format or a failed read. */
      let notice = null
      /** Bumped whenever the world object is replaced, to cancel stale work. */
      let worldToken = 0
      /** The in-flight first load, so every caller shares one. */
      let loadPromise = null
      /** True while a compressed save is being written. */
      let savePending = false
      /** What the panel says about the autosave: size, when, and how it went. */
      let saveState = { size: 0, at: 0, pending: false, failed: false, stored: false }

      /**
       * Install a world object and point the renderer at it.
       *
       * The view request may have arrived before the world did (the canvas is
       * attached during the first render), so it is replayed here: now that the
       * real world size is known, setView() clamps it and sizes the buffers.
       * @param {object} next - the world to adopt.
       * @returns {object} the same world.
       */
      function adoptWorld(next) {
        world = next
        worldToken += 1
        world.hydrologyDirty = false
        minimap = null
        const request = { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale }
        view = { x: 0, y: 0, width: 0, height: 0, scale: view.scale }
        // A first render has no view request yet; attach() picks the default.
        if (request.width > 0 && request.height > 0) setView(request)
        return world
      }

      /**
       * Unpack the first save and adopt it.
       *
       * Only this path is asynchronous: a save is gzipped, and gzip needs
       * unpackWorld(). The store therefore keeps `world === null` and `loading`
       * true for the few dozen milliseconds it takes, and the panel says so
       * instead of showing an empty world.
       * @param {string} raw - the stored payload.
       * @returns {Promise<object|null>} the world, once there is one.
       */
      function startLoad(raw) {
        if (loadPromise !== null) return loadPromise
        const token = worldToken
        loadPromise = decodeStored(raw)
          .then((stored) => {
            if (worldToken !== token) return world
            notice = stored.notice
            const adopted = adoptWorld(stored.world === null ? createWorld() : stored.world)
            if (stored.world !== null) {
              // A resumed world already has a save in storage; show its size in the
              // header straight away instead of waiting for the next autosave.
              saveState = { size: raw.length, at: adopted.time, pending: false, failed: false, stored: true }
            }
            return adopted
          })
          .catch(() => {
            // A world that cannot be loaded must never leave the panel empty.
            return worldToken === token ? adoptWorld(createWorld()) : world
          })
          .then(() => {
            publish()
            return world
          })
        return loadPromise
      }

      /**
       * The world for this store, creating one when there is nothing to load.
       *
       * Synchronous by contract: the tests, the scene lab and the panel's first
       * render all treat this as "give me the world now". That is possible in
       * every case except resuming a compressed save, which is the one path that
       * returns null and settles through whenReady().
       * @returns {object|null} the world, or null while a save is being unpacked.
       */
      function ensureWorld() {
        if (world !== null) return world
        const stored = readRaw()
        if (stored.raw === null || stored.raw === '') {
          // Nothing to decompress. An old build's world may still sit in the v1
          // key: report it, leave it exactly where it is, and start fresh.
          if (stored.legacy !== null && stored.legacy !== '') notice = { kind: 'legacy', detail: null }
          return adoptWorld(createWorld())
        }
        startLoad(stored.raw)
        return null
      }

      /**
       * Wait until a world exists. The formal entry point for the async path.
       * @returns {Promise<object|null>} the world.
       */
      function whenReady() {
        if (world !== null) return Promise.resolve(world)
        ensureWorld()
        return loadPromise === null ? Promise.resolve(world) : loadPromise.then(() => world)
      }

      /**
       * Read both storage keys without interpreting them. Synchronous on purpose:
       * deciding whether there is anything to decompress must not need a promise.
       * @returns {{raw: string|null, legacy: string|null}} stored payloads.
       */
      function readRaw() {
        const result = { raw: null, legacy: null }
        if (storage === null) return result
        try {
          result.raw = storage.getItem(STORAGE_KEY)
        } catch {
          result.raw = null
        }
        if (result.raw === null || result.raw === undefined || result.raw === '') {
          try {
            result.legacy = storage.getItem(LEGACY_STORAGE_KEY)
          } catch {
            result.legacy = null
          }
        }
        return result
      }

      /**
       * Unpack and validate one stored payload, turning a failure into a notice.
       *
       * 0.2.x swallowed every load failure, so a corrupted or version-mismatched
       * save looked exactly like a first run. G5 (failure must be explainable)
       * needs the opposite: the reason travels with the result and the panel
       * shows it instead of quietly starting over.
       * @param {string} raw - the stored payload.
       * @returns {Promise<{world: object|null, notice: object|null}>} world and notice.
       */
      async function decodeStored(raw) {
        try {
          // Both formats arrive here: a gzipped payload from packWorld, and the
          // plain JSON an older autosave or the teardown path may have written.
          const payload = await unpackWorld(raw)
          return { world: deserializeWorld(payload), notice: null }
        } catch (error) {
          const detail = error !== null && error !== undefined && error.message !== undefined
            ? String(error.message)
            : String(error)
          // saveError() tags the reason: unsupported_version | corrupt |
          // no_decompressor. The panel turns the code into a sentence instead of
          // showing one vague "load failed" to everyone.
          const code = error !== null && error !== undefined && typeof error.code === 'string'
            ? error.code
            : 'corrupt'
          return { world: null, notice: { kind: 'load', code, detail } }
        }
      }

      /**
       * Read the stored world and say what happened to it.
       *
       * 0.2.x swallowed every load failure, so a corrupted or version-mismatched
       * save looked exactly like a first run. G5 (failure must be explainable)
       * needs the opposite: the reason travels with the result and the panel
       * shows it instead of quietly starting over.
       * @returns {Promise<{world: object|null, notice: object|null}>} world and notice.
       */
      async function readStored() {
        const stored = readRaw()
        if (stored.raw === null || stored.raw === '') {
          return {
            world: null,
            notice: stored.legacy === null || stored.legacy === '' ? null : { kind: 'legacy', detail: null },
          }
        }
        return decodeStored(stored.raw)
      }

      /**
       * Persist the world, compressed, without blocking a frame.
       *
       * packWorld() gzips several megabytes of JSON, which is tens of
       * milliseconds: enough to drop frames if it ran on the animation loop. It
       * therefore runs off a microtask, and a re-entrancy guard stops a slow save
       * from stacking up when the player scrubs speed.
       * @returns {Promise<boolean>} true when the world reached storage.
       */
      function save() {
        if (storage === null || world === null) return Promise.resolve(false)
        if (savePending) return Promise.resolve(false)
        const token = worldToken
        const target = world
        const savedAt = target.time
        savePending = true
        saveState = { size: saveState.size, at: savedAt, pending: true, failed: false, stored: saveState.stored }
        markDirty()
        return Promise.resolve()
          .then(() => (typeof packWorld === 'function'
            ? packWorld(target)
            : { text: JSON.stringify(serializeWorld(target)), bytes: 0 }))
          .then((packed) => {
            // A world that was replaced while packing must not be written over
            // the new one.
            if (worldToken !== token) return false
            try {
              storage.setItem(STORAGE_KEY, packed.text)
              const size = Number.isFinite(packed.bytes) && packed.bytes > 0 ? packed.bytes : packed.text.length
              saveState = { size, at: savedAt, pending: false, failed: false, stored: true }
              return true
            } catch {
              // Quota or disabled storage: keep playing, and let the panel say so.
              saveState = { size: 0, at: savedAt, pending: false, failed: true, stored: saveState.stored }
              return false
            }
          })
          .catch(() => {
            saveState = { size: 0, at: savedAt, pending: false, failed: true, stored: saveState.stored }
            return false
          })
          .finally(() => {
            savePending = false
            markDirty()
          })
      }

      /**
       * Save right now, compressed. Awaitable, so a caller that is about to close
       * or hide the panel can make sure the write landed.
       * @returns {Promise<boolean>} true when the world reached storage.
       */
      function saveNow() {
        return save()
      }

      /**
       * Last-resort synchronous save, for page teardown only.
       *
       * A gzip cannot finish once the page is closing, so this writes the
       * uncompressed (coarsely packed) payload instead: roughly half the raw JSON
       * and over the 5 MB quota on a full-size world, which is why it is the
       * fallback and not the normal path. unpackWorld accepts both forms and the
       * header records the packing, so a save written here still loads.
       * @returns {boolean} true when the payload reached storage.
       */
      function saveSync() {
        if (storage === null || world === null) return false
        try {
          const text = JSON.stringify(serializeWorld(world, { detail: 'low' }))
          storage.setItem(STORAGE_KEY, text)
          saveState = { size: text.length, at: world.time, pending: false, failed: false, stored: true }
          return true
        } catch {
          return false
        }
      }

      /**
       * Whether the first-run guide has been dismissed.
       * Storage may be missing (private mode, tests); the flag then lives for
       * this session only, which is better than showing the guide forever.
       * @returns {boolean} seen.
       */
      function onboardingSeen() {
        if (onboardingFlag !== null) return onboardingFlag
        onboardingFlag = false
        if (storage !== null) {
          try {
            onboardingFlag = storage.getItem(ONBOARD_KEY) === '1'
          } catch {
            onboardingFlag = false
          }
        }
        return onboardingFlag
      }

      /** Remember that the guide was dismissed, and repaint. */
      function markOnboardingSeen() {
        onboardingFlag = true
        if (storage !== null) {
          try {
            storage.setItem(ONBOARD_KEY, '1')
          } catch {
            // Storage full or disabled: the guide stays dismissed this session.
          }
        }
        publish()
      }

      /** Dismiss the save-file notice for this session. */
      function dismissNotice() {
        notice = null
        publish()
      }

      /** Show the guide again ("How to play" -> start over). */
      function resetOnboarding() {
        onboardingFlag = false
        if (storage !== null) {
          try {
            storage.removeItem(ONBOARD_KEY)
          } catch {
            // Nothing to clean up.
          }
        }
        publish()
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

      // -------------------------------------------------------------------
      // Observation
      //
      // The engine records what happened; this layer answers the questions a
      // player actually asks: who is left, where was it, why did it die, and
      // where is the energy going. Everything below is derived by watching the
      // world and never writes to it, so it keeps working as the simulation
      // underneath is rewritten.
      // -------------------------------------------------------------------
      let observedWorld = null
      let observation = null
      let events = []
      let eventSeq = 0
      const causeTally = {}
      const deathCount = {}
      /** How many death causes came from a carcass and how many were inferred. */
      const causeSource = { exact: 0, inferred: 0 }
      const placedIds = new Set()
      const corpseSeen = new Set()
      const rateIntake = {}
      const rates = { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0 }

      /**
       * Drop the observation state and start watching a new world.
       * Ids restart with a new world, so keeping the old records would read as
       * one huge die-off the moment the player presses "new world".
       */
      function resetObservation() {
        observation = null
        events = []
        eventSeq = 0
        placedIds.clear()
        corpseSeen.clear()
        for (const key of Object.keys(causeTally)) delete causeTally[key]
        for (const key of Object.keys(deathCount)) delete deathCount[key]
        causeSource.exact = 0
        causeSource.inferred = 0
        for (const key of Object.keys(rateIntake)) delete rateIntake[key]
        rates.gpp = 0
        rates.herbs = 0
        rates.carns = 0
        rates.respire = 0
        rates.plantRespire = 0
      }

      /**
       * Record one species' death causes, creating the bucket on first use.
       * @param {string} speciesId - species id.
       * @returns {object} mutable cause buckets.
       */
      function causeBucket(speciesId) {
        if (causeTally[speciesId] === undefined) causeTally[speciesId] = {}
        return causeTally[speciesId]
      }

      /**
       * Push one event into the ticker and keep the ticker short.
       * @param {string} kind - EVENT_KINDS member.
       * @param {string} speciesId - species id.
       * @param {number} x - position.
       * @param {number} y - position.
       * @param {number} count - how many animals the event covers.
       * @param {number} [id] - entity id, when the event is about one animal.
       * @param {string} [cause] - death cause, when the kind carries one.
       */
      function pushEvent(kind, speciesId, x, y, count, id, cause) {
        eventSeq += 1
        events.push({
          seq: eventSeq,
          t: Math.round(observedWorld === null ? 0 : observedWorld.time),
          kind,
          species: speciesId,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          count: Math.max(1, count | 0),
          id: typeof id === 'number' ? id : 0,
          cause: typeof cause === 'string' ? cause : null,
        })
      }

      /**
       * Count same-species animals in the coarse cells around a point.
       * The bucket holds the species of every animal in a 4x4 cell block, so a
       * newborn is recognised by its litter and an arrival from off-map is not.
       * @param {Map<number, string[]>} cells - coarse occupancy index.
       * @param {number} x - position.
       * @param {number} y - position.
       * @param {string} speciesId - species to count.
       * @returns {number} neighbours, including the caller itself.
       */
      function kinsAround(cells, x, y, speciesId) {
        const cx = (x | 0) >> 2
        const cy = (y | 0) >> 2
        let found = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = cells.get((cx + dx) * 4096 + (cy + dy))
            if (bucket === undefined) continue
            for (const id of bucket) if (id === speciesId) found += 1
          }
        }
        return found
      }

      /**
       * Read the world once and turn it into a census, an event feed and a
       * measured energy budget.
       * @param {object} world - the world.
       * @returns {object|null} the observation, or null when there is no world.
       */
      function observe(world) {
        if (observedWorld !== world) {
          observedWorld = world
          resetObservation()
        }
        const now = world.time
        const previous = observation
        // A paused world still needs a fresh census (the player places animals
        // while paused), but a zero-length interval cannot carry a rate, so the
        // flows below are the only part gated on time actually passing.
        const dt = previous === null ? 0 : Math.max(0, now - previous.time)
        const hunters = []
        const seen = new Map()
        const cells = new Map()
        const species = {}
        for (const id of SPECIES_IDS) {
          species[id] = { count: 0, sumE: 0, sumMax: 0, sumAge: 0, respire: 0, hungry: 0 }
        }

        for (const entity of world.entities) {
          const row = SPECIES[entity.species]
          if (row === undefined) continue
          const balance = row.balance
          const body = entity.body
          const reserve = body === undefined || body === null || !Number.isFinite(body.E) ? entity.energy : body.E
          const reserveMax = body === undefined || body === null || !Number.isFinite(body.Emax) ? balance.maxEnergy : body.Emax
          const ratio = reserveMax > 0 ? clamp(reserve / reserveMax, 0, 1) : 0
          const bucket = species[entity.species]
          if (bucket !== undefined) {
            bucket.count += 1
            bucket.sumE += reserve
            bucket.sumMax += reserveMax
            bucket.sumAge += entity.age
            // Maintenance power, kJ per in-world day: the buffer's own number
            // from the DEB ledger. The old per-second drain stays as the
            // fallback so a save from before the ledger still shows a budget.
            bucket.respire += body !== undefined && body !== null && Number.isFinite(body.pMetabolism)
              ? Math.max(0, body.pMetabolism)
              : (balance.drain * entity.genes.metabolism + (entity.fleeing === true ? (balance.fleeDrain ?? 0) : 0)) * DAY_SECONDS
            if (ratio < 0.35) bucket.hungry += 1
          }
          if (row.role === 'hunter') hunters.push({ id: entity.id, species: entity.species, x: entity.x, y: entity.y })
          const key = ((entity.x | 0) >> 2) * 4096 + ((entity.y | 0) >> 2)
          const occupants = cells.get(key)
          if (occupants === undefined) cells.set(key, [entity.species])
          else occupants.push(entity.species)
          seen.set(entity.id, {
            species: entity.species,
            x: entity.x,
            y: entity.y,
            ratio,
            age: entity.age,
            lifespan: entity.genes.lifespan,
            cold: entity.drives === undefined || !Number.isFinite(entity.drives.cold) ? coldOf(world) : clamp(entity.drives.cold, 0, 1),
            health: body === undefined || body === null || !Number.isFinite(body.health) ? null : body.health,
            // A living body carries cause: '' — that is "not dead", not a cause.
            cause: body === undefined || body === null || typeof body.cause !== 'string' || body.cause === ''
              ? null
              : body.cause,
          })
        }

        const plants = samplePlantStock(world)
        const birthBatch = new Map()
        const deathBatch = new Map()
        const arrivalBatch = new Map()
        const placements = []
        // A carcass carries the cause the engine wrote (dieOf in 09b-body), which
        // makes the death panel exact instead of inferred. Scavengers eat corpses,
        // so some are gone before this sweep sees them; those fall back to the
        // inference in classifyDeath and are still counted.
        const explained = new Map()
        for (const corpse of world.corpses) {
          if (corpse === null || typeof corpse !== 'object') continue
          if (corpseSeen.has(corpse.id)) continue
          corpseSeen.add(corpse.id)
          if (typeof corpse.cause !== 'string' || corpse.cause === '') continue
          if (!CAUSE_KEYS.includes(corpse.cause)) continue
          const pool = explained.get(corpse.species)
          const hit = { cause: corpse.cause, x: corpse.x, y: corpse.y }
          if (pool === undefined) explained.set(corpse.species, [hit])
          else pool.push(hit)
        }
        if (corpseSeen.size > 2048) {
          // Corpses are transient; rebuilding from the live list keeps this set
          // from growing for the whole session.
          corpseSeen.clear()
          for (const corpse of world.corpses) {
            if (corpse !== null && typeof corpse === 'object') corpseSeen.add(corpse.id)
          }
        }

        if (previous !== null) {
          for (const [id, rec] of seen) {
            if (previous.seen.has(id)) continue
            if (placedIds.has(id)) {
              placedIds.delete(id)
              placements.push({ species: rec.species, x: rec.x, y: rec.y })
              continue
            }
            const immigration = world.lastImmigration
            const immigrated = immigration !== undefined && immigration !== null &&
              immigration.species === rec.species && (now - immigration.at) <= 2
            if (!immigrated && kinsAround(cells, rec.x, rec.y, rec.species) > 1) {
              birthBatch.set(rec.species, (birthBatch.get(rec.species) ?? 0) + 1)
            } else {
              arrivalBatch.set(rec.species, (arrivalBatch.get(rec.species) ?? 0) + 1)
            }
          }

          let kills = 0
          for (const [id, rec] of previous.seen) {
            if (seen.has(id)) continue
            const pool = explained.get(rec.species)
            const hit = pool === undefined || pool.length === 0 ? null : pool.pop()
            const cause = hit === null ? classifyDeath(rec, previous.hunters) : hit.cause
            // The panel marks the difference: a carcass carries the cause the
            // engine wrote, everything else is this layer's inference.
            if (hit === null) causeSource.inferred += 1
            else causeSource.exact += 1
            const atX = hit === null ? rec.x : hit.x
            const atY = hit === null ? rec.y : hit.y
            const causes = causeBucket(rec.species)
            causes[cause] = (causes[cause] ?? 0) + 1
            deathCount[rec.species] = (deathCount[rec.species] ?? 0) + 1
            if (cause === 'predation' && kills < 3) {
              kills += 1
              pushEvent('predation', rec.species, atX, atY, 1, 0, cause)
            } else {
              const key = rec.species + '|' + cause
              const row = deathBatch.get(key)
              if (row === undefined) deathBatch.set(key, { species: rec.species, cause, count: 1, x: atX, y: atY })
              else row.count += 1
            }
          }
          // Deaths are counted exactly once, by the population diff above. A
          // corpse that no vanished animal claimed is a death from an earlier
          // sweep whose cause was already attributed (or inferred) then, so it
          // is dropped rather than tallied twice.
        }

        // One ticker line per species per kind: a litter of seven is one piece of
        // news, not seven, or the ticker becomes unreadable during a boom.
        const originOf = (speciesId) => {
          for (const entity of world.entities) {
            if (entity.species === speciesId) return { x: entity.x, y: entity.y }
          }
          return { x: world.width / 2, y: world.height / 2 }
        }
        for (const [speciesId, count] of birthBatch) {
          const at = originOf(speciesId)
          pushEvent('birth', speciesId, at.x, at.y, count, 0)
        }
        for (const row of deathBatch.values()) {
          const at = Number.isFinite(row.x) ? row : originOf(row.species)
          pushEvent('death', row.species, at.x, at.y, row.count, 0, row.cause)
        }
        for (const [speciesId, count] of arrivalBatch) {
          const at = originOf(speciesId)
          pushEvent('migration', speciesId, at.x, at.y, count, 0)
        }
        for (const placed of placements) pushEvent('placed', placed.species, placed.x, placed.y, 1, 0)
        if (world.caches !== undefined && world.caches !== null) {
          for (const cache of world.caches) {
            if (cache === null || typeof cache !== 'object') continue
            const filled = Number(cache.energy) || 0
            const before = previous === null ? 0 : (previous.caches.get(cache.id) ?? 0)
            if (filled > before + 0.5) pushEvent('hoard', cache.owner ?? cache.species ?? 'rabbit', cache.x ?? 0, cache.y ?? 0, 1, 0)
          }
        }

        // Measured flows, all in kJ per in-world day so every row of the budget
        // is comparable (docs/10 section 2). Two sources, in order of authority:
        //  - world.budget: gross primary production and plant respiration, which
        //    the producer step counts itself;
        //  - the bodies: an animal's intake is whatever its reserve gained plus
        //    whatever it burned, since nothing else moves energy in or out.
        if (previous !== null && dt > 0) {
          const perDay = DAY_SECONDS / dt
          for (const id of SPECIES_IDS) {
            const nowBucket = species[id]
            const oldBucket = previous.species[id]
            if (nowBucket === undefined || oldBucket === undefined) continue
            const intake = (nowBucket.sumE - oldBucket.sumE) * perDay + nowBucket.respire
            rateIntake[id] = rateIntake[id] === undefined ? intake : rateIntake[id] + (intake - rateIntake[id]) * 0.35
          }
          let herbs = 0
          let carns = 0
          let respire = 0
          for (const id of SPECIES_IDS) {
            const role = SPECIES[id].role
            const value = Math.max(0, rateIntake[id] ?? 0)
            if (role === 'grazer') herbs += value
            else carns += value
            respire += species[id].respire
          }
          const budget = world.budget
          const before = previous.budget
          let gpp = 0
          let plantRespired = 0
          let animalRespired = respire
          if (budget !== undefined && budget !== null && before !== null && before !== undefined) {
            gpp = Math.max(0, (budget.gpp - before.gpp) * perDay)
            plantRespired = Math.max(0, (budget.plantRespired - before.plantRespired) * perDay)
            // The engine's own animal-respiration counter, when it exists, beats
            // summing pMetabolism here: it is what actually left the reserves.
            if (Number.isFinite(budget.animalRespired) && Number.isFinite(before.animalRespired)) {
              animalRespired = Math.max(0, (budget.animalRespired - before.animalRespired) * perDay)
            }
          } else {
            // No budget in this world: fall back to the net stock rise, which
            // understates growth by whatever the grazers took.
            gpp = Math.max(0, (plants.energy - previous.plants.energy) * perDay)
          }
          rates.gpp += (gpp - rates.gpp) * 0.35
          rates.herbs += (herbs - rates.herbs) * 0.35
          rates.carns += (carns - rates.carns) * 0.35
          rates.respire += (animalRespired - rates.respire) * 0.35
          rates.plantRespire += (plantRespired - rates.plantRespire) * 0.35
        }

        const caches = new Map()
        if (world.caches !== undefined && world.caches !== null) {
          for (const cache of world.caches) {
            if (cache === null || typeof cache !== 'object') continue
            caches.set(cache.id, Number(cache.energy) || 0)
          }
        }
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
        while (events.length > 0 && now - events[0].t > EVENT_TTL) events.shift()

        const budget = world.budget
        observation = {
          time: now,
          dt,
          species,
          hunters,
          seen,
          plants,
          caches,
          budget: budget === undefined || budget === null
            ? null
            : {
                gpp: budget.gpp,
                plantRespired: budget.plantRespired,
                animalRespired: Number.isFinite(budget.animalRespired) ? budget.animalRespired : 0,
                mineralised: budget.mineralised,
              },
        }
        return observation
      }

      /**
       * Events worth showing, newest first.
       * @returns {object[]} events.
       */
      function recentEvents() {
        const list = []
        for (let i = events.length - 1; i >= 0 && list.length < 24; i--) list.push(events[i])
        return list
      }

      /**
       * Births and deaths in the last minute, for the header pulse.
       * @param {object} world - the world.
       * @returns {{births: number, deaths: number, predations: number}} pulse.
       */
      function pulseOf(world) {
        const window = PULSE_SECONDS
        const since = world.time - window
        let births = 0
        let deaths = 0
        let predations = 0
        for (const event of events) {
          if (event.t < since) continue
          if (event.kind === 'birth') births += event.count
          else if (event.kind === 'death') deaths += event.count
          else if (event.kind === 'predation') { deaths += event.count; predations += event.count }
        }
        return { births, deaths, predations }
      }

      /**
       * One row per species for the species table and the energy budget.
       * @returns {object[]} rows in SPECIES_IDS order.
       */
      function speciesRows() {
        const rows = []
        for (const id of SPECIES_IDS) {
          const bucket = observation === null || observation.species[id] === undefined
            ? { count: 0, sumE: 0, sumMax: 0, sumAge: 0, respire: 0, hungry: 0 }
            : observation.species[id]
          const causes = causeTally[id] ?? {}
          let tally = 0
          for (const key of CAUSE_KEYS) tally += causes[key] ?? 0
          // A corpse can arrive one sweep after its animal vanished, so the cause
          // tally and the population diff can differ by one; report the larger of
          // the two so the number next to the bar never contradicts the bar.
          const dead = Math.max(deathCount[id] ?? 0, tally)
          const smoothed = rateIntake[id] ?? 0
          rows.push({
            id,
            count: bucket.count,
            meanRatio: bucket.count === 0 || bucket.sumMax <= 0 ? 0 : clamp(bucket.sumE / bucket.sumMax, 0, 1),
            meanEnergy: bucket.count === 0 ? 0 : bucket.sumE / bucket.count,
            meanAge: bucket.count === 0 ? 0 : bucket.sumAge / bucket.count,
            hungry: bucket.hungry,
            respire: bucket.respire,
            net: smoothed,
            intake: Math.max(0, smoothed),
            deaths: causes,
            dead,
            extinct: bucket.count === 0 && dead > 0,
          })
        }
        return rows
      }

      /**
       * The cascade the energy panel draws, in energy units per game second.
       * @returns {object} flows.
       */
      function flowView() {
        let animalStock = 0
        if (observation !== null) {
          for (const id of SPECIES_IDS) {
            const bucket = observation.species[id]
            if (bucket !== undefined) animalStock += bucket.sumE
          }
        }
        return {
          gpp: Math.max(0, rates.gpp),
          herbs: Math.max(0, rates.herbs),
          carns: Math.max(0, rates.carns),
          respire: Math.max(0, rates.respire),
          plantRespire: Math.max(0, rates.plantRespire),
          plantStock: observation === null ? 0 : observation.plants.energy,
          animalStock,
        }
      }

      /**
       * Climate as the header and the cold drive read it.
       * @param {object} world - the world.
       * @returns {object} climate view.
       */
      function climateView(world) {
        const climate = world.climate ?? null
        const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
        return {
          temperature: temperatureOf(world),
          sunlight: climate !== null && Number.isFinite(climate.sunlight) ? climate.sunlight : daylight(world),
          dayPhase: climate !== null && Number.isFinite(climate.dayPhase) ? climate.dayPhase : phase,
          yearPhase: climate !== null && Number.isFinite(climate.yearPhase) ? climate.yearPhase : null,
          season: climate !== null && typeof climate.season === 'string' ? climate.season : null,
        }
      }

      /** The inspected animal, if it is still alive. */
      function selectedEntity() {
        if (world === null || selectedId === 0) return undefined
        return findEntityById(world, selectedId)
      }

      /**
       * Flatten one entity for the inspector.
       *
       * The inspector is the answer to "what is it doing and why" (G2), so this
       * is everything needed to say that in one card: the body, the eight
       * drives, the timed state, the goal it walks toward, the sentence behind
       * the decision and the death it is heading for.
       * @param {object} entity - the animal.
       * @returns {object} inspector record.
       */
      function summariseEntity(entity) {
        const species = SPECIES[entity.species]
        const safe = species === undefined
          ? { balance: { maxEnergy: 100, maturity: 1 }, genes: {}, color: '#999', role: 'grazer' }
          : species
        const body = bodyRecord(entity, safe)
        const drives = drivesOf(world, entity, safe)
        const state = entity.state
        const stateId = state !== undefined && state !== null && typeof state.id === 'string'
          ? state.id
          : (entity.intent ?? 'explore')
        const remaining = state !== undefined && state !== null && Number.isFinite(state.until)
          ? Math.max(0, state.until - world.time)
          : null
        const hasGoal = Number.isFinite(entity.targetX) && Number.isFinite(entity.targetY)
        const plan = entity.plan
        const decision = entity.decision
        const decisionAge = decision !== undefined && decision !== null && Number.isFinite(decision.at)
          ? Math.max(0, world.time - decision.at)
          : null
        return {
          id: entity.id,
          species: entity.species,
          age: entity.age,
          energy: body.reserve,
          maxEnergy: body.reserveMax,
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
          body,
          drives: drives.values,
          drivesDerived: drives.derived,
          state: {
            id: stateId,
            phase: state !== undefined && state !== null && typeof state.phase === 'string' ? state.phase : null,
            since: state !== undefined && state !== null && Number.isFinite(state.since) ? state.since : null,
            remaining,
            nextDecision: Number.isFinite(entity.thinkTimer) ? Math.max(0, entity.thinkTimer) : null,
            score: state !== undefined && state !== null && Number.isFinite(state.score) ? round3(state.score) : null,
          },
          plan: plan === undefined || plan === null
            ? null
            : {
                goal: typeof plan.goal === 'string' ? plan.goal : null,
                index: Number.isFinite(plan.index) ? plan.index : 0,
                steps: Array.isArray(plan.steps)
                  ? plan.steps.slice(0, 4).map(step => ({
                      x: round3(step?.x ?? 0),
                      y: round3(step?.y ?? 0),
                      act: typeof step?.act === 'string' ? step.act : null,
                      duration: Number.isFinite(step?.duration) ? round3(step.duration) : null,
                    }))
                  : [],
              },
          decisionAge,
          goal: hasGoal
            ? { x: entity.targetX, y: entity.targetY, distance: Math.hypot(entity.targetX - entity.x, entity.targetY - entity.y) }
            : null,
          reason: reasonOf(entity, drives.values),
          cause: {
            predicted: predictCause(entity, body, drives.values, observation),
            actual: body.cause,
          },
          threats: predatorsNear(observation, entity.species, entity.x, entity.y, 8),
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
            // ready === false only ever means "unpacking a save right now"; a
            // store with nothing to load has a world before this runs.
            loading: true,
            paused,
            speed,
            time: 0,
            stats: emptyStats(),
            world: { width: GRID_W, height: GRID_H, empty: true },
            history: [],
            brush: { tool: brush.tool, radius: brush.radius },
            selected: null,
            following: false,
            view: { x: 0, y: 0, width: 0, height: 0 },
            events: [],
            pulse: { births: 0, deaths: 0, predations: 0 },
            species: [],
            flows: { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0, plantStock: 0, animalStock: 0 },
            plants: { grass: 0, weed: 0, energy: 0 },
            climate: { temperature: null, sunlight: 1, dayPhase: 0.26, yearPhase: null, season: null },
            onboarding: onboardingSeen(),
            notice,
            causeSource: { exact: 0, inferred: 0 },
            save: { size: saveState.size, at: saveState.at, pending: saveState.pending, failed: saveState.failed, stored: saveState.stored },
          }
        }
        const stats = sampleStats(world)
        // Observe before summarising: the inspector reads the predators and the
        // census from the same reading, so one card never mixes two moments.
        observe(world)
        const selected = selectedEntity()
        let population = 0
        for (const id of SPECIES_IDS) population += stats.counts[id] ?? 0
        return {
          ready: true,
          loading: false,
          paused,
          speed,
          time: world.time,
          stats,
          world: { width: world.width, height: world.height, empty: population === 0 },
          history: world.history.slice(-120),
          brush: { tool: brush.tool, radius: brush.radius },
          selected: selected === undefined ? null : summariseEntity(selected),
          following: follow && selected !== undefined,
          view: { x: view.x, y: view.y, width: view.width, height: view.height },
          events: recentEvents(),
          pulse: pulseOf(world),
          species: speciesRows(),
          flows: flowView(),
          plants: observation === null ? { grass: 0, weed: 0, energy: 0 } : observation.plants,
          climate: climateView(world),
          onboarding: onboardingSeen(),
          notice,
          causeSource: { exact: causeSource.exact, inferred: causeSource.inferred },
          save: { size: saveState.size, at: saveState.at, pending: saveState.pending, failed: saveState.failed, stored: saveState.stored },
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
        const scale = typeof next.scale === 'number' && next.scale > 0 ? next.scale : (view.scale ?? 1)
        if (world === null) {
          // The world is still being unpacked. Remember the request; the load
          // continuation replays it once the real size is known.
          ensureWorld()
          view = {
            x: Math.max(0, next.x | 0),
            y: Math.max(0, next.y | 0),
            width: Math.max(1, next.width | 0),
            height: Math.max(1, next.height | 0),
            scale,
          }
          return
        }
        const width = Math.max(1, Math.min(world.width, next.width | 0))
        const height = Math.max(1, Math.min(world.height, next.height | 0))
        const x = clamp(next.x | 0, 0, Math.max(0, world.width - width))
        const y = clamp(next.y | 0, 0, Math.max(0, world.height - height))
        const resized = width !== view.width || height !== view.height || imageData === null
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
        ensureBuffers()
        ensureAtlas(publish)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          // A gzip cannot finish once the page is tearing down, so unload writes
          // the uncompressed payload; hiding the tab still gets the real thing.
          window.addEventListener('beforeunload', saveSync)
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
          }
        }
        startLoop()
        publish()
      }

      /** Save as soon as the tab is hidden: the last chance an async write has. */
      function onVisibilityChange() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') save()
      }

      /**
       * Size the pixel buffers for the current view.
       *
       * Split out of attach() because the world may still be unpacking when the
       * canvas arrives: the load continuation calls this again once it knows the
       * real world size.
       */
      function ensureBuffers() {
        if (context === null || world === null) return
        if (view.width <= 0 || view.height <= 0) {
          view = {
            x: 0, y: 0,
            width: Math.min(world.width, 160),
            height: Math.min(world.height, 100),
            scale: view.scale ?? 1,
          }
        }
        imageData = context.createImageData(view.width, view.height)
        frameBuffer = new Uint32Array(imageData.data.buffer)
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && offscreen === null) {
          offscreen = document.createElement('canvas')
          offscreen.width = view.width
          offscreen.height = view.height
          offscreenContext = offscreen.getContext('2d', { alpha: false })
        }
      }

      /** Unbind the canvas and save. */
      function detach() {
        stopLoop()
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', saveSync)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
        }
        canvas = null
        context = null
        imageData = null
        frameBuffer = null
      }

      /**
       * Put a starter population back into an emptied world.
       *
       * This is the "the world went quiet" button: it places a few animals per
       * species through the same code path as the brush, so the arrival is
       * reported in the event ticker like any other placement and no rule is
       * bypassed (caps still refuse a species that is already full).
       * @returns {number} how many animals were released.
       */
      function restock() {
        if (world === null) {
          ensureWorld()
          return 0
        }
        let released = 0
        const spots = 6
        for (const id of SPECIES_IDS) {
          const want = id === 'rabbit' || id === 'fish' || id === 'frog' ? 3 : 2
          let placed = 0
          for (let attempt = 0; attempt < spots * 4 && placed < want; attempt++) {
            const x = randomBetween(world, 2, world.width - 3)
            const y = randomBetween(world, 2, world.height - 3)
            const before = Number.isFinite(world.nextId) ? world.nextId : 0
            const count = place(world, id, x, y, 1)
            const added = typeof count === 'number' ? count : 0
            if (added <= 0) continue
            if (before > 0 && Number.isFinite(world.nextId)) {
              for (let newId = before; newId < world.nextId; newId++) placedIds.add(newId)
            }
            placed += added
            released += added
          }
        }
        markDirty()
        publish()
        return released
      }

      /** Replace the world with a fresh one. */
      function newWorld(seed) {
        // Cancel any load still in flight: the player asked for a new world, and
        // an older save finishing late must not replace it.
        worldToken += 1
        adoptWorld(createWorld(seed === undefined ? {} : { seed }))
        selectedId = 0
        follow = false
        accumulator = 0
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
          if (world === null) {
            ensureWorld()
            // An empty frame is better than a crash: the panel repaints as soon
            // as the world lands.
            return { width, height, data: new Uint32Array(width * height) }
          }
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
          if (world === null) {
            ensureWorld()
            return
          }
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
          if (world === null) {
            ensureWorld()
            return 0
          }
          // Anything the brush spawns is the player's doing, not a birth: the
          // id watermark tells the observer exactly which animals appeared.
          const before = Number.isFinite(world.nextId) ? world.nextId : 0
          const result = place(world, erase ? 'erase' : brush.tool, x, y, brush.radius)
          const released = typeof result === 'number' ? result : 0
          if (released > 0 && before > 0 && Number.isFinite(world.nextId) && placedIds.size < 512) {
            for (let id = before; id < world.nextId; id++) placedIds.add(id)
          }
          // The canvas repaints on the next animation frame anyway; a full
          // snapshot here would rescan 200k cells per cell of a brush drag.
          markDirty()
          return released
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
        restock,
        whenReady,
        markOnboardingSeen,
        resetOnboarding,
        dismissNotice,
        save,
        saveNow,
        /** @returns {Promise<object|null>} the stored world, without side effects. */
        async peekSave() {
          // Peeking must not consume the notice that the panel has not shown yet.
          const stored = await readStored()
          return stored.world
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
      // One silhouette per species. The palette, the inspector header, the
      // species table and the event ticker all draw these, so a rabbit reads the
      // same wherever it appears; colour comes from the species row, shape from
      // here. Every grid must stay rectangular or PixelGlyph invents pixels.
      rabbit: ['..#..#..', '..#..#..', '.######.', '########', '########', '.######.', '..#..#..'],
      deer: ['#......#', '.#.##.#.', '..####..', '.######.', '########', '..####..', '..#..#..'],
      fox: ['#......#', '.##..##.', '..####..', '########', '########', '.######.', '....####'],
      wolf: ['.#....#.', '.##..##.', '..####..', '########', '########', '.######.', '..#..#..'],
      bear: ['.#....#.', '.######.', '########', '########', '########', '.######.', '..#..#..'],
      crow: ['##.##.##', '.#######', '..#####.', '...###..', '....#...', '........', '........'],
      fish: ['........', '.#....#.', '.##.###.', '########', '.##.###.', '.#....#.', '........'],
      pike: ['........', '..#.....', '.###.##.', '########', '.###.##.', '..#.....', '........'],
      heron: ['....##..', '....#...', '...#....', '..###...', '.#####..', '...#....', '..#.#...'],
      otter: ['........', '.#.####.', '########', '.######.', '..#..#..', '........', '........'],
      frog: ['.#....#.', '.######.', '########', '.######.', '.#....#.', '........', '........'],
      // Event ticker icons, one per event kind.
      birth: ['..#..#..', '...##...', '.######.', '#..##..#', '.######.', '...##...', '..#..#..'],
      death: ['..####..', '.#....#.', '#.#..#.#', '#......#', '#.#..#.#', '.#....#.', '..####..'],
      hunt: ['#......#', '.#....#.', '..#..#..', '...##...', '..#..#..', '.#....#.', '#......#'],
      migrate: ['..####..', '.#....#.', '#..#...#', '...##...', '.#....#.', '.#....#.', '...##...'],
      hoard: ['........', '...##...', '..####..', '.######.', '########', '.#.##.#.', '........'],
      placed: ['........', '...#....', '..###...', '.#####..', '..###...', '...#....', '........'],
    }

    /**
     * A species id is also its glyph name, so one lookup covers palette,
     * header, table and ticker.
     * @param {string} speciesId - species id from SPECIES.
     * @returns {string} glyph name.
     */
    function speciesGlyph(speciesId) {
      return GLYPHS[speciesId] === undefined ? 'creature' : speciesId
    }

    /** Glyph per event kind; an unknown kind falls back to the target ring. */
    const EVENT_GLYPHS = {
      predation: 'hunt',
      birth: 'birth',
      death: 'death',
      migration: 'migrate',
      hoard: 'hoard',
      placed: 'placed',
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
    //
    // Three ideas hold this file together:
    //
    //  1. Every panel answers a question a player would ask out loud: what is
    //     left, what is it doing, why, and where did the energy go. A number
    //     with no sentence next to it does not ship.
    //  2. Anything the engine does not publish yet is drawn as derived and
    //     labelled, never invented. The panels get richer for free as the
    //     simulation starts reporting (see docs/80-UI.md).
    //  3. All three side tabs are mounted and hidden with CSS rather than
    //     unmounted, so every panel is exercised by the render test instead of
    //     only the tab that happens to be active.

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

    /** Side-panel tabs, in reading order. */
    const SIDE_TABS = ['tools', 'species', 'energy']

    /** Ticker filter chips: everything, then one per event kind. */
    const EVENT_FILTERS = ['all', ...EVENT_KINDS]

    /**
     * Colour per death cause, shared by the species bar, the inspector chip and
     * the ticker, so a red kill reads red everywhere.
     */
    const CAUSE_COLORS = {
      predation: '#d9534f',
      starved: '#c98a2b',
      frozen: '#4f8fd0',
      old: '#8a8f99',
      disease: '#9a6bd0',
      unknown: '#5d6470',
    }

    /** Stage colours for the energy cascade. */
    const FLOW_COLORS = {
      sun: '#e0a13a',
      plants: '#4a9d54',
      herbs: '#c9a97b',
      carns: '#d2733c',
      respire: '#5d6470',
    }

    /**
     * Translation for a state id. A state behaviour adds later still renders, as
     * its raw id, instead of as a blank chip.
     * @param {Function} t - translator.
     * @param {string} id - state or intent id.
     * @returns {string} label.
     */
    function intentLabel(t, id) {
      if (typeof id !== 'string' || id === '') return ''
      return INTENT_IDS.includes(id) ? t('intent.' + id) : id
    }

    /**
     * Translation for the phase of a timed state. Behaviour may add a phase, and
     * an unknown one must fall back to its raw id instead of leaking the key.
     * @param {Function} t - translator.
     * @param {string} phase - phase id.
     * @returns {string} label.
     */
    function phaseLabel(t, phase) {
      if (typeof phase !== 'string' || phase === '') return ''
      if (phase === 'approach' || phase === 'execute' || phase === 'done') return t('phase.' + phase)
      if (phase === 'do') return t('phase.execute')
      if (phase === 'adopted') return t('phase.approach')
      return phase
    }

    /**
     * Translation for the drive code a decision says it acted on.
     * @param {Function} t - translator.
     * @param {string} code - why code from the decision record.
     * @returns {string} label.
     */
    function whyLabel(t, code) {
      if (typeof code !== 'string' || code === '') return ''
      if (DRIVE_KEYS.includes(code)) return t('drive.' + code)
      if (code === 'search') return t('reason.search')
      if (code === 'idle') return t('reason.idle')
      return code
    }

    /**
     * A duration as a compact chip value.
     * @param {number} seconds - in-world seconds.
     * @returns {string} e.g. '3.4s', '48s', '2:05'.
     */
    function shortTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '—'
      if (seconds < 10) return (Math.round(seconds * 10) / 10) + 's'
      if (seconds < 120) return Math.round(seconds) + 's'
      return Math.floor(seconds / 60) + ':' + String(Math.round(seconds % 60)).padStart(2, '0')
    }

    /**
     * Energy with a unit prefix, in kJ.
     * @param {number} kilojoules - energy.
     * @returns {string} e.g. '820', '12.4k', '2.31M'.
     */
    function formatEnergy(kilojoules) {
      const value = Number.isFinite(kilojoules) ? kilojoules : 0
      if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + 'M'
      if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(Math.round(value))
    }

    /**
     * 0..1 as a whole percentage.
     * @param {number} ratio - fraction.
     * @returns {number} 0..100.
     */
    function percentOf(ratio) {
      return Math.round(clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1) * 100)
    }

    /**
     * What the header says about the autosave: its size, that it is running, or
     * that the browser refused to store it.
     * @param {Function} t - translator.
     * @param {object} save - snapshot.save.
     * @returns {string} label, or an empty string when nothing was saved yet.
     */
    function saveLabel(t, save) {
      if (save === null || save === undefined) return ''
      if (save.pending === true) return t('status.savePending')
      if (save.failed === true) return t('status.saveFailed')
      if (save.stored !== true) return ''
      return t('status.saved', { size: formatSaveSize(save.size) })
    }

    /**
     * One sentence per save failure. saveError() tags the reason, so an
     * incompatible save is never described as a damaged one.
     * @param {Function} t - translator.
     * @param {object} notice - snapshot.notice.
     * @returns {string} body text.
     */
    function noticeBody(t, notice) {
      if (notice === null || notice === undefined) return ''
      if (notice.kind === 'legacy') return t('notice.legacyBody')
      if (notice.code === 'unsupported_version') return t('notice.unsupportedVersion')
      if (notice.code === 'no_decompressor') return t('notice.noDecompressor')
      if (notice.code === 'corrupt') return t('notice.corrupt')
      return t('notice.loadBody', { reason: notice.detail === null || notice.detail === undefined ? '' : notice.detail })
    }

    /**
     * The one and only camera to viewport conversion.
     *
     * The render path and the input path both call this. Two separate copies of
     * this maths is exactly how zoom-to-cursor and hit-testing drift apart.
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
     * Stage-relative client coordinates to world cell coordinates.
     * @param {object} view - result of viewFromCamera.
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
     * One label of a key/value block.
     * @param {object} props - props.label, props.title.
     * @returns {object} React element.
     */
    function KeyValue(props) {
      return h('span', { className: 'pe-kv-key', title: props.title }, props.label)
    }

    /**
     * Death-cause bar: one segment per cause, in a fixed cause order so the same
     * cause sits in the same place on every row and rows can be compared.
     * @param {object} props - props.deaths, props.t.
     * @returns {object} React element.
     */
    function CauseBar(props) {
      const deaths = props.deaths ?? {}
      const t = props.t
      let total = 0
      for (const key of CAUSE_KEYS) total += deaths[key] ?? 0
      if (total === 0) return h('span', { className: 'pe-note' }, '—')
      const segments = []
      for (const key of CAUSE_KEYS) {
        const value = deaths[key] ?? 0
        if (value === 0) continue
        segments.push(h('span', {
          key,
          className: 'pe-cause',
          style: { width: percentOf(value / total) + '%', background: CAUSE_COLORS[key] },
          title: t('cause.' + key) + ' ' + value,
        }))
      }
      return h('div', { className: 'pe-causes' }, segments)
    }

    /**
     * Inspector v2: what the animal is, what it is doing right now, why, and
     * what is most likely to kill it.
     * @param {object} props - props.selected, props.t, props.onFollow, props.onClear, props.following.
     * @returns {object} React element.
     */
    function Inspector(props) {
      const selected = props.selected
      const t = props.t
      if (selected === null || selected === undefined) {
        return h('div', { className: 'pe-empty' },
          h('div', { className: 'pe-empty-icon' }, h(PixelGlyph, { name: 'target', size: 22 })),
          h('div', { className: 'pe-empty-title' }, t('inspect.empty')),
          h('div', { className: 'pe-empty-hint' }, t('inspect.emptyHint')))
      }
      const species = SPECIES[selected.species]
      const color = species === undefined ? '#999' : species.color
      const body = selected.body ?? null
      const drives = selected.drives ?? {}
      const state = selected.state ?? null
      const reason = selected.reason ?? null
      const cause = selected.cause ?? { predicted: null, actual: null }
      const ratio = clamp(selected.energy / Math.max(1, selected.maxEnergy), 0, 1)
      // Gene bars: where this animal sits inside its species' range.
      const genes = species === undefined ? [] : GENE_KEYS.map((key) => {
        const range = species.genes[key]
        const value = selected.genes[key]
        const geneRatio = clamp((value - range[0]) / Math.max(1e-6, range[1] - range[0]), 0, 1)
        return h('div', { className: 'pe-gene', key },
          h('span', { className: 'pe-gene-label' }, t('inspect.gene.' + key)),
          h('span', { className: 'pe-gene-track' }, h('span', {
            className: 'pe-gene-fill',
            style: { width: percentOf(geneRatio) + '%', background: color },
          })),
          h('span', { className: 'pe-gene-value' }, value.toFixed(1)))
      })
      const driveBars = DRIVE_KEYS.map((key) => {
        const value = clamp(Number(drives[key]) || 0, 0, 1)
        return h('div', { className: 'pe-drive' + (value >= 0.7 ? ' is-high' : ''), key },
          h('span', { className: 'pe-drive-label' }, t('drive.' + key)),
          h('span', { className: 'pe-drive-track' }, h('span', {
            className: 'pe-drive-fill',
            style: { width: percentOf(value) + '%' },
          })),
          h('span', { className: 'pe-drive-value' }, String(percentOf(value))))
      })
      // The "why": the decision record when behaviour published one, otherwise
      // the loudest drive, and the card says which of the two it is showing.
      const whyText = reason === null
        ? t('inspect.decisionNone')
        : reason.derived === true
          ? t('inspect.decisionWhy', { why: whyLabel(t, reason.drive) })
          : t('inspect.decisionWhy', { why: whyLabel(t, reason.why) })
      const rivals = reason === null || reason.rivals === undefined || reason.rivals.length === 0
        ? null
        : h('span', { className: 'pe-quote-meta' },
            reason.rivals.map(rival => t('inspect.decisionBeat', {
              kind: intentLabel(t, rival.kind),
              score: rival.score.toFixed(2),
            })).join(' · '))
      const predicted = cause.predicted === null || cause.predicted === undefined
        ? h('span', null, t('inspect.causeNone'))
        : h('span', null, t('cause.' + cause.predicted))
      const goalLine = selected.goal === null || selected.goal === undefined
        ? h('span', null, '—')
        : h('span', null, Math.round(selected.goal.x) + ', ' + Math.round(selected.goal.y) + ' · ' +
            t('inspect.goalDistance', { n: Math.round(selected.goal.distance) }))
      const planLine = selected.plan === null || selected.plan === undefined || selected.plan.steps.length === 0
        ? h('span', null, '—')
        : h('span', null, t('inspect.planStep', {
            x: Math.round(selected.plan.steps[0].x),
            y: Math.round(selected.plan.steps[0].y),
            act: intentLabel(t, selected.plan.steps[0].act),
          }))
      return h('div', { className: 'pe-card' },
        h('div', { className: 'pe-card-head' },
          h(PixelGlyph, { name: speciesGlyph(selected.species), color, size: 16 }),
          h('span', { className: 'pe-card-title' }, t('species.' + selected.species)),
          h('span', { className: 'pe-tag' }, t('stage.' + (selected.stage ?? 'adult'))),
          selected.fleeing === true
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('intent.flee'))
            : h('span', { className: 'pe-tag pe-tag-intent' }, intentLabel(t, state === null ? selected.intent : state.id)),
          h('button', {
            type: 'button', className: 'pe-icon-btn', title: t('action.deselect'),
            'aria-label': t('action.deselect'), onClick: props.onClear,
          }, h(PixelGlyph, { name: 'close', size: 12 }))),
        h('div', { className: 'pe-meter' },
          h('span', { className: 'pe-meter-fill', style: { width: percentOf(ratio) + '%' } })),
        // The first two rows are the two numbers every version of this panel has
        // shown; the render test pins that order.
        h('div', { className: 'pe-rows' },
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.age')),
            h('b', null, t('inspect.seconds', { n: Math.round(selected.age) }))),
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.energy')),
            h('b', null, formatEnergy(selected.energy) + ' / ' + formatEnergy(selected.maxEnergy)))),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.structure') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.structure === null || body.structure === undefined
              ? '—'
              : body.structureUnit === 'kg'
                ? t('inspect.kg', { n: body.structure.toFixed(2) })
                : body.structure.toFixed(2)),
          h(KeyValue, { label: t('inspect.maturity') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.maturity === null || body.maturity === undefined ? '—' : percentOf(body.maturity) + '%'),
          h(KeyValue, { label: t('inspect.health') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.health === null || body.health === undefined ? '—' : percentOf(body.health) + '%'),
          h(KeyValue, { label: t('inspect.fatigue') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.fatigue === null || body.fatigue === undefined ? '—' : percentOf(body.fatigue) + '%')),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.state') }),
          h('span', { className: 'pe-kv-value' },
            intentLabel(t, state === null ? selected.intent : state.id) +
            (state === null || state.phase === null ? '' : ' · ' + phaseLabel(t, state.phase))),
          h(KeyValue, { label: t('inspect.remaining') }),
          h('span', { className: 'pe-kv-value' },
            state === null || state.remaining === null || state.remaining === undefined
              ? '—'
              : t('inspect.seconds', { n: Math.round(state.remaining) })),
          h(KeyValue, { label: t('inspect.nextDecision') }),
          h('span', { className: 'pe-kv-value' },
            state === null || state.nextDecision === null || state.nextDecision === undefined
              ? '—'
              : t('inspect.seconds', { n: Math.round(state.nextDecision) })),
          h(KeyValue, { label: t('inspect.goal') }),
          h('span', { className: 'pe-kv-value' }, goalLine),
          h(KeyValue, { label: t('inspect.plan') }),
          h('span', { className: 'pe-kv-value' }, planLine)),
        h('div', { className: 'pe-quote' },
          h('span', null, t('inspect.decision') + ' · ' + whyText),
          reason === null || reason.at === null || reason.at === undefined
            ? null
            : h('span', { className: 'pe-quote-meta' },
                t('inspect.decisionAgo', { n: Math.max(0, Math.round(selected.decisionAge ?? 0)) })),
          rivals),
        h('div', { className: 'pe-chipline' },
          h('span', { className: 'pe-tag' }, t('inspect.generation', { n: selected.generation })),
          h('span', { className: 'pe-tag' }, t('inspect.children', { n: selected.children })),
          selected.threats > 0
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('inspect.threats', { n: selected.threats }))
            : null),
        h('div', { className: 'pe-panel-title' }, t('inspect.drives') +
          (selected.drivesDerived === true ? ' · ' + t('inspect.drivesDerived') : '')),
        h('div', { className: 'pe-drives' }, driveBars),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.cause') + ' · ' + t('inspect.causePredicted') }),
          h('span', { className: 'pe-kv-value' }, predicted)),
        h('div', { className: 'pe-genes' }, genes),
        h('button', {
          type: 'button',
          className: 'pe-btn pe-btn-block' + (props.following ? ' pe-btn-active' : ''),
          onClick: props.onFollow,
        }, props.following ? t('inspect.unfollow') : t('inspect.follow')))
    }

    /**
     * Species table: counts, reserve, age and the cause breakdown, with a row
     * click that flies to a living member.
     * @param {object} props - props.rows, props.t, props.onLocate.
     * @returns {object} React element.
     */
    function SpeciesPanel(props) {
      const rows = props.rows ?? []
      const t = props.t
      if (rows.length === 0) return h('div', { className: 'pe-blank' }, t('species.empty'))
      const header = h('div', { className: 'pe-srow pe-srow-head' },
        h('span', null, ''),
        h('span', { className: 'pe-srow-name' }, t('budget.species')),
        h('span', { className: 'pe-srow-num' }, t('metric.count')),
        h('span', { className: 'pe-srow-num' }, t('metric.energy')),
        h('span', { className: 'pe-srow-num' }, t('metric.age')))
      const body = rows.map((row) => {
        const species = SPECIES[row.id]
        const color = species === undefined ? '#999' : species.color
        return h('div', {
          key: row.id,
          className: 'pe-srow' + (row.count === 0 ? ' is-gone' : ''),
          onClick: () => props.onLocate(row.id),
          title: row.count === 0 ? t('species.extinct') : t('species.deadTotal', { n: row.dead }),
        },
          h(PixelGlyph, { name: speciesGlyph(row.id), color, size: 12 }),
          h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
          h('span', { className: 'pe-srow-num' }, String(row.count)),
          h('span', { className: 'pe-sbar' }, h('span', {
            className: 'pe-sbar-fill',
            style: { width: percentOf(row.meanRatio) + '%', background: color },
          })),
          h('span', { className: 'pe-srow-num' }, row.count === 0 ? '—' : shortTime(row.meanAge)))
      })
      const deadRows = rows.filter(row => row.dead > 0).map((row) => {
        const species = SPECIES[row.id]
        const color = species === undefined ? '#999' : species.color
        return h('div', { className: 'pe-srow', key: 'dead-' + row.id, title: t('metric.causes') },
          h(PixelGlyph, { name: speciesGlyph(row.id), color, size: 12 }),
          h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
          h('span', { className: 'pe-srow-num' }, String(row.dead)),
          h('span', { style: { gridColumn: '4 / span 2' } }, h(CauseBar, { deaths: row.deaths, t })))
      })
      // Deaths whose cause came from the engine's own carcass record are facts;
      // the rest were inferred here, and the header says how many.
      const inferred = props.inferred ?? 0
      const causesTitle = deadRows.length === 0
        ? null
        : h('div', { className: 'pe-panel-title' },
            t('metric.causes') + (inferred > 0 ? ' · ' + t('inspect.causeInferred') + ' ' + inferred : ''))
      return h('div', { className: 'pe-rows' },
        header,
        body,
        causesTitle,
        deadRows)
    }

    /**
     * Energy flow: the cascade sun to plants to herbivores to carnivores, then
     * the per-species budget that produced it.
     * @param {object} props - props.flows, props.rows, props.t.
     * @returns {object} React element.
     */
    function EnergyFlowPanel(props) {
      const t = props.t
      const flows = props.flows ?? { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0, plantStock: 0, animalStock: 0 }
      const rows = props.rows ?? []
      const peak = Math.max(flows.gpp, flows.herbs, flows.carns, flows.respire, flows.plantRespire ?? 0, 1)
      const stage = (key, label, value, color) => h('div', {
        className: 'pe-flow-row',
        key,
        title: key === 'sun' ? t('flow.gpp') : label,
      },
        h('span', { className: 'pe-flow-label' }, label),
        h('span', { className: 'pe-flow-track' }, h('span', {
          className: 'pe-flow-fill',
          style: { width: Math.max(value > 0 ? 2 : 0, percentOf(Math.min(1, value / peak))) + '%', background: color },
        })),
        h('span', { className: 'pe-flow-value' }, formatEnergy(value)))
      const running = flows.gpp > 0 || flows.herbs > 0 || flows.carns > 0
      const cascade = running
        ? h('div', { className: 'pe-flow' },
            stage('sun', t('flow.sun'), flows.gpp, FLOW_COLORS.sun),
            stage('plants', t('flow.plants'), flows.herbs, FLOW_COLORS.plants),
            stage('herbs', t('flow.herbivores'), flows.carns, FLOW_COLORS.herbs),
            stage('carns', t('flow.respire'), flows.respire, FLOW_COLORS.respire),
            stage('plants', t('flow.plantRespire'), flows.plantRespire, FLOW_COLORS.respire))
        : h('div', { className: 'pe-blank' }, t('flow.waiting'))
      const budget = rows.filter(row => row.count > 0).map(row => h('div', { className: 'pe-srow', key: 'budget-' + row.id },
        h(PixelGlyph, { name: speciesGlyph(row.id), color: SPECIES[row.id]?.color, size: 12 }),
        h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.intake)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.respire)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.net ?? (row.intake - row.respire)))))
      return h('div', { className: 'pe-rows' },
        h('div', { className: 'pe-panel-title' }, t('flow.panelTitle')),
        cascade,
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('flow.stock') + ' · ' + t('flow.plants') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.plantStock) + ' ' + t('flow.unit')),
          h(KeyValue, { label: t('flow.stock') + ' · ' + t('flow.animals') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.animalStock) + ' ' + t('flow.unit')),
          h(KeyValue, { label: t('flow.respire') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.respire) + ' ' + t('flow.unit'))),
        h('div', { className: 'pe-panel-title' }, t('budget.title')),
        h('div', { className: 'pe-srow pe-srow-head' },
          h('span', null, ''),
          h('span', { className: 'pe-srow-name' }, t('budget.species')),
          h('span', { className: 'pe-srow-num' }, t('budget.intake')),
          h('span', { className: 'pe-srow-num' }, t('budget.respire')),
          h('span', { className: 'pe-srow-num' }, t('budget.net'))),
        budget,
        h('div', { className: 'pe-note' }, t('flow.note') + ' ' + t('flow.unit')))
    }

    /**
     * Event ticker: one chip per event, newest first, with the species icon, the
     * count and the coordinates. Clicking one flies the camera there.
     * @param {object} props - props.events, props.t, props.filter, props.onFilter, props.onLocate, props.now.
     * @returns {object} React element.
     */
    function EventBar(props) {
      const t = props.t
      const now = Number.isFinite(props.now) ? props.now : 0
      const filters = EVENT_FILTERS.map(kind => h('button', {
        key: kind,
        type: 'button',
        className: 'pe-eventfilter' + (props.filter === kind ? ' is-active' : ''),
        onClick: () => props.onFilter(kind),
      }, kind === 'all' ? t('event.all') : t('event.' + kind)))
      const all = props.events ?? []
      const shown = props.filter === undefined || props.filter === 'all'
        ? all
        : all.filter(event => event.kind === props.filter)
      const items = shown.slice(0, 16).map((event) => {
        const species = SPECIES[event.species]
        const color = species === undefined ? '#999' : species.color
        const age = Math.max(0, now - event.t)
        return h('button', {
          key: event.seq,
          type: 'button',
          className: 'pe-event pe-event-' + event.kind,
          title: t('event.' + event.kind) + ' · ' + t('species.' + event.species) + ' · ' +
            Math.round(event.x) + ', ' + Math.round(event.y),
          'aria-label': t('events.locate'),
          onClick: () => props.onLocate(event),
        },
          h(PixelGlyph, { name: EVENT_GLYPHS[event.kind] ?? 'target', color, size: 12 }),
          h('span', null, t('species.' + event.species)),
          event.count > 1 ? h('span', { className: 'pe-event-count' }, t('events.count', { n: event.count })) : null,
          event.cause === null || event.cause === undefined
            ? null
            : h('span', { className: 'pe-event-count' }, t('cause.' + event.cause)),
          h('span', { className: 'pe-event-where' }, Math.round(event.x) + ',' + Math.round(event.y)),
          h('span', { className: 'pe-event-time' },
            age < 3 ? t('events.justNow') : t('events.secondsAgo', { n: Math.round(age) })))
      })
      return h('div', { className: 'pe-eventbar' },
        h('span', { className: 'pe-eventbar-title' }, t('events.title')),
        h('div', { className: 'pe-events-filters', title: t('events.filter') }, filters),
        h('div', { className: 'pe-events' },
          items.length > 0 ? items : h('span', { className: 'pe-events-empty' }, t('events.empty'))))
    }

    /**
     * First-run guide: three steps, one button, remembered in the store.
     * @param {object} props - props.t, props.onDismiss.
     * @returns {object} React element.
     */
    function OnboardingOverlay(props) {
      const t = props.t
      return h('div', { className: 'pe-onboard', role: 'dialog', 'aria-label': t('onboard.title') },
        h('div', { className: 'pe-onboard-title' }, t('onboard.title')),
        h('ol', { className: 'pe-onboard-steps' },
          h('li', null, t('onboard.step1')),
          h('li', null, t('onboard.step2')),
          h('li', null, t('onboard.step3'))),
        h('div', { className: 'pe-onboard-actions' },
          h('button', { type: 'button', className: 'pe-btn pe-btn-active', onClick: props.onDismiss },
            t('onboard.dismiss'))))
    }

    /**
     * The world went quiet: say so and offer the restock button instead of
     * leaving the player with an empty meadow and no idea what to do.
     * @param {object} props - props.t, props.onRestock.
     * @returns {object} React element.
     */
    function EmptyWorldOverlay(props) {
      const t = props.t
      return h('div', { className: 'pe-emptyworld' },
        h('div', { className: 'pe-emptyworld-title' }, t('status.emptyWorld')),
        h('div', { className: 'pe-emptyworld-hint' }, t('status.emptyWorldHint')),
        h('button', { type: 'button', className: 'pe-btn', onClick: props.onRestock }, t('status.restock')))
    }

    /**
     * Population chart with filled areas and a legend.
     * @param {object} props - props.history, props.t.
     * @returns {object} React element.
     */
    function PopulationChart(props) {
      const history = props.history
      const t = props.t
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
          h(PixelGlyph, { name: speciesGlyph(id), color: SPECIES[id].color, size: 10 }),
          h('span', null, t('species.' + id))))))
    }

    /**
     * Minimap with the current viewport rectangle; click to jump.
     * @param {object} props - props.store, props.snapshot, props.onJump.
     * @returns {object} React element.
     */
    function Minimap(props) {
      const store = props.store
      const snapshot = props.snapshot
      const onJump = props.onJump
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
     * @param {object} props - slot props plus props.store, props.locale, props.layout.
     * @returns {object} React element.
     */
    function TerrariumPanel(props) {
      const store = props.store
      const locale = props.locale
      const layout = props.layout
      const t = useTranslate(locale)
      const snapshot = useStore(store)
      const worldSize = snapshot.world ?? { width: GRID_W, height: GRID_H }
      const [tool, setTool] = React.useState('pointer')
      const [brushIndex, setBrushIndex] = React.useState(1)
      const [helpOpen, setHelpOpen] = React.useState(false)
      const [confirmNew, setConfirmNew] = React.useState(false)
      const [tab, setTab] = React.useState('tools')
      const [eventFilter, setEventFilter] = React.useState('all')
      const [cameraTick, setCameraTick] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const [hover, setHover] = React.useState(null)
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

      /** Show a short message above the map. */
      const showToast = React.useCallback((message) => {
        if (message === null || message === undefined) return
        setToast(message)
        if (toastTimer.current !== 0) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 1800)
      }, [])

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

      /**
       * Fly to the place an event happened, and open the animal when it is still
       * alive. This is what makes the ticker a way to *watch* the world.
       */
      const locateEvent = React.useCallback((event) => {
        lookAt(event.x, event.y)
        if (event.id > 0) store.select(event.id)
      }, [store, lookAt])

      /** Fly to the first living member of a species (species table row). */
      const locateSpecies = React.useCallback((id) => {
        const world = store.getWorld()
        if (world === null || world === undefined) return
        const entity = world.entities.find(candidate => candidate.species === id)
        if (entity === undefined) return
        lookAt(entity.x, entity.y)
        store.select(entity.id)
      }, [store, lookAt])

      /** Put a starter population back into an empty world. */
      const restockWorld = React.useCallback(() => {
        const released = store.restock()
        showToast(t('toast.placed', { n: released }))
      }, [store, showToast, t])

      /** Close the help sheet and show the first-run guide again. */
      const replayGuide = React.useCallback(() => {
        setHelpOpen(false)
        store.resetOnboarding()
      }, [store])

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

        const report = (released, erased) => {
          const translate = translateRef.current
          let message = null
          if (erased === true) message = translate('toast.erased')
          else if (SPECIES[toolRef.current] !== undefined) {
            message = released > 0 ? translate('toast.placed', { n: released }) : translate('toast.blocked')
          }
          if (message === null) return
          setToast(message)
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
            drag.lastCell = Math.round(point.x) + ',' + Math.round(point.y)
            const erasing = event.button === 2
            report(store.paintAt(point.x, point.y, erasing), erasing)
          }
          if (typeof stage.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
            try { stage.setPointerCapture(event.pointerId) } catch { /* capture is optional */ }
          }
          event.preventDefault()
        }

        const handleMove = (event) => {
          const point = cellAt(event.clientX, event.clientY)
          const cell = Math.round(point.x) + ',' + Math.round(point.y)
          setHover({ x: point.x, y: point.y })
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
          setHover(null)
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
      const climate = snapshot.climate ?? { temperature: 0 }
      const pulse = snapshot.pulse ?? { births: 0, deaths: 0, predations: 0 }
      const bag = { width: worldSize.width, height: worldSize.height }

      const speciesChips = SPECIES_IDS.map((id) => h('span', {
        className: 'pe-chip', key: id, title: t('species.' + id),
      },
        h(PixelGlyph, { name: speciesGlyph(id), color: SPECIES[id].color, size: 11 }),
        h('span', { className: 'pe-chip-count' }, String(snapshot.stats?.counts?.[id] ?? 0))))

      const labelFor = (id) => (SPECIES[id] === undefined ? t('tool.' + id) : t('species.' + id))

      const toolButton = (id) => {
        const isSpecies = SPECIES[id] !== undefined
        const color = isSpecies ? SPECIES[id].color : undefined
        const label = labelFor(id)
        return h('button', {
          type: 'button', key: id,
          className: 'pe-tool' + (tool === id ? ' is-active' : ''),
          onClick: () => setTool(id),
          title: label,
          'aria-pressed': tool === id,
          'aria-label': label,
        },
          h(PixelGlyph, { name: isSpecies ? speciesGlyph(id) : id, color, size: 18 }),
          h('span', { className: 'pe-tool-label' }, label))
      }

      const speedButton = (value) => h('button', {
        type: 'button', key: value,
        className: 'pe-seg-btn' + (snapshot.speed === value && !snapshot.paused ? ' is-active' : ''),
        onClick: () => store.setSpeed(value),
        'aria-label': t('speed.' + value),
      }, t('speed.' + value))

      const tabButton = (id) => h('button', {
        type: 'button', key: id,
        className: 'pe-tab' + (tab === id ? ' is-active' : ''),
        'aria-selected': tab === id,
        onClick: () => setTab(id),
      }, t('tab.' + id))

      const showTab = id => (tab === id ? 'flex' : 'none')

      const brushRadius = BRUSH_RADIUS[brushIndex]
      const brushPreview = hover === null || tool === 'pointer'
        ? null
        : h('span', {
            className: 'pe-brushpreview',
            style: {
              left: ((hover.x - view.x) * view.scale + view.offsetX) + 'px',
              top: ((hover.y - view.y) * view.scale + view.offsetY) + 'px',
              width: Math.max(4, (brushRadius * 2 + 1) * view.scale) + 'px',
              height: Math.max(4, (brushRadius * 2 + 1) * view.scale) + 'px',
            },
          })

      return h('div', { className: 'pe-root' },
        h('header', { className: 'pe-head' },
          h('div', { className: 'pe-brand' },
            h('span', { className: 'pe-logo' }, h(PixelGlyph, { name: 'tree', color: '#4a9d54', size: 18 })),
            h('div', null,
              h('div', { className: 'pe-title' }, t('panel.title')),
              h('div', { className: 'pe-sub' },
                t('stat.day', { day: snapshot.stats?.day ?? 1 }) + ' · ' + (snapshot.stats?.clock ?? '06:00') +
                ' · ' + t('status.temperature', { n: Math.round(climate.temperature ?? 0) })))),
          h('div', { className: 'pe-statusbar' },
            h('span', { className: 'pe-pill' + (snapshot.paused ? '' : ' pe-pill-live') },
              snapshot.paused ? t('speed.paused') : t('status.pulse', { births: pulse.births, deaths: pulse.deaths })),
            h('span', { className: 'pe-pill' }, t('stat.corpses') + ' ' + (snapshot.stats?.corpses ?? 0)),
            h('span', { className: 'pe-pill' + (snapshot.save?.failed === true ? ' pe-pill-warn' : '') },
              saveLabel(t, snapshot.save))),
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
              className: 'pe-btn' + (confirmNew ? ' pe-btn-danger' : ''),
              onClick: () => {
                if (!confirmNew) { setConfirmNew(true); return }
                setConfirmNew(false)
                store.newWorld()
                fitAll()
              },
            }, confirmNew ? t('action.newWorldConfirm') : t('action.newWorld')),
            h('button', { type: 'button', className: 'pe-btn', onClick: fitAll }, t('action.fit')),
            h('button', {
              type: 'button', className: 'pe-btn' + (helpOpen ? ' pe-btn-active' : ''),
              onClick: () => setHelpOpen(open => !open),
            }, t('action.help')),
            layout !== undefined && typeof layout.selectPanel === 'function'
              ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => layout.selectPanel('conversation') }, t('action.back'))
              : null)),
        h('div', { className: 'pe-body' },
          h('div', { className: 'pe-stagewrap' },
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
                  width: (view.width * view.scale) + 'px',
                  height: (view.height * view.scale) + 'px',
                },
              }),
              brushPreview,
              h('div', { className: 'pe-hud pe-hud-bl' },
                h('span', { className: 'pe-hud-item' },
                  hover === null ? '—' : t('brush.cell', { x: Math.round(hover.x), y: Math.round(hover.y) })),
                h('span', { className: 'pe-hud-item' }, t('brush.preview', { tool: labelFor(tool) })),
                h('span', { className: 'pe-hud-item' }, view.scale + '×')),
              h('div', { className: 'pe-hud pe-hud-br' },
                h(Minimap, { store, snapshot, onJump: lookAt })),
              snapshot.ready === false
                ? h('div', { className: 'pe-emptyworld' },
                    h('div', { className: 'pe-emptyworld-title' }, t('status.loading')))
                : null,
              snapshot.ready === true && snapshot.world !== undefined && snapshot.world.empty === true
                ? h(EmptyWorldOverlay, { t, onRestock: restockWorld })
                : null,
              snapshot.onboarding === true
                ? null
                : h(OnboardingOverlay, { t, onDismiss: () => store.markOnboardingSeen() }),
              snapshot.notice === null || snapshot.notice === undefined
                ? null
                : h('div', { className: 'pe-notice', title: snapshot.notice.detail ?? '' },
                    h('div', { className: 'pe-notice-title' },
                      snapshot.notice.kind === 'legacy' ? t('notice.legacyTitle') : t('notice.loadTitle')),
                    h('div', { className: 'pe-notice-body' }, noticeBody(t, snapshot.notice)),
                    h('div', { className: 'pe-notice-actions' },
                      h('button', { type: 'button', className: 'pe-btn', onClick: () => store.dismissNotice() },
                        t('notice.dismiss')))),
              toast === null ? null : h('div', { className: 'pe-toast' }, toast)),
            h(EventBar, {
              events: snapshot.events ?? [],
              t,
              filter: eventFilter,
              onFilter: setEventFilter,
              onLocate: locateEvent,
              now: snapshot.time ?? 0,
            })),
          h('aside', { className: 'pe-side' },
            h('div', { className: 'pe-tabs' }, SIDE_TABS.map(tabButton)),
            h('div', { className: 'pe-tabbody' },
              h('section', { className: 'pe-panel', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('tool.group.life')),
                h('div', { className: 'pe-tools' }, LIFE_TOOLS.map(toolButton))),
              h('section', { className: 'pe-panel', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('tool.group.terrain')),
                h('div', { className: 'pe-tools' }, TERRAIN_TOOL_IDS.map(toolButton))),
              h('section', { className: 'pe-panel pe-panel-row', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('brush.label')),
                h('div', { className: 'pe-seg' }, BRUSHES.map((radius, index) => h('button', {
                  type: 'button', key: radius,
                  className: 'pe-seg-btn' + (brushIndex === index ? ' is-active' : ''),
                  onClick: () => setBrushIndex(index),
                  'aria-label': t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'),
                }, t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'))))),
              h('section', { className: 'pe-panel', style: { display: showTab('species') } },
                h('div', { className: 'pe-panel-title' }, t('species.panelTitle')),
                h(SpeciesPanel, {
                  rows: snapshot.species ?? [],
                  t,
                  onLocate: locateSpecies,
                  inferred: snapshot.causeSource === undefined ? 0 : snapshot.causeSource.inferred,
                })),
              h('div', { style: { display: showTab('species') } },
                h(PopulationChart, { history: snapshot.history ?? [], t })),
              h('section', { className: 'pe-panel', style: { display: showTab('energy') } },
                h(EnergyFlowPanel, { flows: snapshot.flows, rows: snapshot.species ?? [], t }))),
            h('div', { className: 'pe-dock' },
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
                [1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => h('li', { key: index }, t('help.' + index)))),
              h('div', { className: 'pe-onboard-actions' },
                h('button', { type: 'button', className: 'pe-btn', onClick: replayGuide }, t('onboard.again')))))
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

    /**
     * Keys the panel chrome adds on top of the base dictionary.
     *
     * Every key here is rendered by a template literal in 24-ui.js, so the
     * dictionary test enumerates the families (drive.*, cause.*, event.*, ...)
     * from the lists below instead of grepping for literals. CHINESE and ENGLISH
     * must stay key-for-key identical, and no key may be dead weight.
     */
    Object.assign(CHINESE, {
      // --- tabs and panel titles -------------------------------------------
      'action.step': '单步',
      'action.deselect': '取消选择',
      'inspect.title': '详情',
      'inspect.emptyHint': '左键放置，右键擦除；点一只生物看它的基因',
      'help.8': '空格暂停、1–4 调速度、F 适应窗口、Esc 取消选择。',
      'help.9': '面板下方是事件条：捕食、出生、死亡、迁入都记着位置，点一下镜头就过去。',
      'tab.tools': '工具',
      'tab.species': '物种',
      'tab.energy': '能量流',

      // --- life stage, intent, phase ---------------------------------------
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
      'phase.approach': '前往',
      'phase.execute': '进行中',
      'phase.done': '已完成',

      // --- needs (legacy channels, still shown) ----------------------------

      // --- the eight drives -------------------------------------------------
      'drive.hunger': '饥饿',
      'drive.thirst': '口渴',
      'drive.cold': '寒冷',
      'drive.fatigue': '疲劳',
      'drive.fear': '恐惧',
      'drive.social': '社交',
      'drive.curiosity': '好奇',
      'drive.libido': '求偶',
      'inspect.drives': '驱动力',
      'inspect.drivesDerived': '由身体推导',

      // --- inspector v2 -----------------------------------------------------
      'inspect.state': '状态',
      'inspect.remaining': '剩余',
      'inspect.nextDecision': '下次决策',
      'inspect.goal': '目标',
      'inspect.goalDistance': '{n} 格外',
      'inspect.structure': '体量',
      'inspect.maturity': '成熟度',
      'inspect.health': '健康',
      'inspect.fatigue': '疲劳',
      'inspect.decision': '最近决策',
      'inspect.decisionWhy': '因为 {why}',
      'inspect.decisionBeat': '胜过 {kind} {score}',
      'inspect.decisionNone': '还没做过决策',
      'inspect.decisionAgo': '{n} 秒前',
      'inspect.cause': '死因',
      'inspect.causePredicted': '预测',
      'inspect.causeInferred': '推断',
      'inspect.causeNone': '暂无风险',
      'inspect.threats': '附近威胁 {n}',
      'inspect.plan': '计划',
      'inspect.planStep': '去 ({x}, {y}) {act}',
      'inspect.kg': '{n} kg',
      'inspect.seconds': '{n} 秒',

      // --- why codes the decision system reports ---------------------------
      'reason.search': '找食物',
      'reason.idle': '无事可做',

      // --- death causes -----------------------------------------------------
      'cause.predation': '被捕食',
      'cause.starved': '饿死',
      'cause.frozen': '冻死',
      'cause.old': '老死',
      'cause.disease': '病死',
      'cause.unknown': '不明',

      // --- event ticker -----------------------------------------------------
      'events.title': '事件',
      'events.empty': '还没有事件。世界刚醒过来。',
      'events.filter': '筛选',
      'events.locate': '定位',
      'events.count': '×{n}',
      'events.justNow': '刚刚',
      'events.secondsAgo': '{n} 秒前',
      'event.predation': '捕食',
      'event.birth': '出生',
      'event.death': '死亡',
      'event.migration': '迁入',
      'event.hoard': '囤食',
      'event.placed': '投放',
      'event.all': '全部',

      // --- species panel ----------------------------------------------------
      'species.panelTitle': '物种',
      'species.extinct': '已消失',
      'species.empty': '这个世界还没有生物。选一个物种，点到地图上。',
      'species.deadTotal': '累计死亡 {n}',
      'metric.count': '数量',
      'metric.energy': '储能',
      'metric.age': '年龄',
      'metric.causes': '死因',

      // --- energy panel ------------------------------------------------------
      'flow.panelTitle': '能量流',
      'flow.sun': '阳光',
      'flow.plants': '植物',
      'flow.herbivores': '草食动物',
      'flow.carnivores': '肉食动物',
      'flow.respire': '动物呼吸',
      'flow.plantRespire': '植物呼吸',
      'flow.gpp': '净初级生产',
      'flow.stock': '现存',
      'flow.animals': '动物',
      'flow.unit': 'kJ/日',
      'flow.note': '宽度按每日能量比例；数字是每游戏日千焦。',
      'flow.waiting': '世界跑起来之后才有流量数据。',
      'budget.title': '收支表',
      'budget.species': '物种',
      'budget.respire': '呼吸',
      'budget.intake': '吸收',
      'budget.net': '净变化',

      // --- onboarding --------------------------------------------------------
      'onboard.title': '这是一个活着的小世界',
      'onboard.step1': '在左边选一个物种，比如兔子。',
      'onboard.step2': '在草地上点一下，把它放下来。',
      'onboard.step3': '点一只动物，看它此刻在做什么、为什么。',
      'onboard.dismiss': '知道了',
      'onboard.again': '重新看引导',

      // --- status, empty and error states -----------------------------------
      'status.emptyWorld': '这个世界安静了',
      'status.emptyWorldHint': '补一批生物，世界会自己接着跑。',
      'status.restock': '补充生物',
      'status.temperature': '{n} °C',
      'status.pulse': '近 60 秒 出生 {births} · 死亡 {deaths}',
      'status.loading': '正在读取世界…',
      'status.saved': '存档 {size}',
      'status.savePending': '保存中…',
      'status.saveFailed': '存不进本地存储',
      'notice.unsupportedVersion': '这份存档来自不兼容的版本，已经开了新世界；旧存档原样保留。',
      'notice.corrupt': '存档已损坏，读不出来，已经开了新世界。',
      'notice.noDecompressor': '这个浏览器不支持解压存档，已经开了新世界。',
      'notice.legacyTitle': '发现旧版存档',
      'notice.legacyBody': '0.3 的存档格式和旧版不兼容，已经为你开了新世界。旧存档原样保留，没被覆盖。',
      'notice.loadTitle': '读档失败',
      'notice.loadBody': '存档读不出来，已经开了新世界。原因：{reason}',
      'notice.dismiss': '知道了',
      'brush.preview': '放置 {tool}',
      'brush.cell': '格子 {x}, {y}',
      'toast.erased': '擦除了这一片',
      'toast.placed': '放出了 {n} 只',
      'toast.blocked': '这里放不下，附近也没有合适的地方',

      // --- population chart --------------------------------------------------
      'chart.title': '种群变化',
    })
    Object.assign(ENGLISH, {
      'action.step': 'Step',
      'action.deselect': 'Deselect',
      'inspect.title': 'Details',
      'inspect.emptyHint': 'Left-click places, right-click erases; click a creature for its genes',
      'help.8': 'Space pauses, 1–4 set speed, F fits the view, Esc clears the selection.',
      'help.9': 'The strip under the map is the event feed: kills, births, deaths and arrivals keep their coordinates, and one click flies the camera there.',
      'tab.tools': 'Tools',
      'tab.species': 'Species',
      'tab.energy': 'Energy',
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
      'phase.approach': 'Approach',
      'phase.execute': 'Doing',
      'phase.done': 'Done',
      'drive.hunger': 'Hunger',
      'drive.thirst': 'Thirst',
      'drive.cold': 'Cold',
      'drive.fatigue': 'Fatigue',
      'drive.fear': 'Fear',
      'drive.social': 'Social',
      'drive.curiosity': 'Curiosity',
      'drive.libido': 'Breeding',
      'inspect.drives': 'Drives',
      'inspect.drivesDerived': 'derived from the body',
      'inspect.state': 'State',
      'inspect.remaining': 'Left',
      'inspect.nextDecision': 'Re-decides',
      'inspect.goal': 'Goal',
      'inspect.goalDistance': '{n} cells away',
      'inspect.structure': 'Body mass',
      'inspect.maturity': 'Maturity',
      'inspect.health': 'Health',
      'inspect.fatigue': 'Fatigue',
      'inspect.decision': 'Last decision',
      'inspect.decisionWhy': 'because {why}',
      'inspect.decisionBeat': 'beat {kind} {score}',
      'inspect.decisionNone': 'No decision yet',
      'inspect.decisionAgo': '{n}s ago',
      'inspect.cause': 'Cause',
      'inspect.causePredicted': 'predicted',
      'inspect.causeInferred': 'inferred',
      'inspect.causeNone': 'no obvious risk',
      'inspect.threats': '{n} nearby',
      'inspect.plan': 'Plan',
      'inspect.planStep': 'go to ({x}, {y}) and {act}',
      'inspect.kg': '{n} kg',
      'inspect.seconds': '{n}s',
      'reason.search': 'looking for food',
      'reason.idle': 'nothing to do',
      'cause.predation': 'Predation',
      'cause.starved': 'Starved',
      'cause.frozen': 'Frozen',
      'cause.old': 'Old age',
      'cause.disease': 'Disease',
      'cause.unknown': 'Unknown',
      'events.title': 'Events',
      'events.empty': 'No events yet. The world just woke up.',
      'events.filter': 'Filter',
      'events.locate': 'Locate',
      'events.count': '×{n}',
      'events.justNow': 'now',
      'events.secondsAgo': '{n}s ago',
      'event.predation': 'Kill',
      'event.birth': 'Birth',
      'event.death': 'Death',
      'event.migration': 'Arrival',
      'event.hoard': 'Stash',
      'event.placed': 'Placed',
      'event.all': 'All',
      'species.panelTitle': 'Species',
      'species.extinct': 'Gone',
      'species.empty': 'No creatures yet. Pick a species and click the map.',
      'species.deadTotal': '{n} died',
      'metric.count': 'Count',
      'metric.energy': 'Reserve',
      'metric.age': 'Age',
      'metric.causes': 'Causes',
      'flow.panelTitle': 'Energy flow',
      'flow.sun': 'Sun',
      'flow.plants': 'Plants',
      'flow.herbivores': 'Herbivores',
      'flow.carnivores': 'Carnivores',
      'flow.respire': 'Animal respiration',
      'flow.plantRespire': 'Plant respiration',
      'flow.gpp': 'Primary production',
      'flow.stock': 'Standing',
      'flow.animals': 'Animals',
      'flow.unit': 'kJ/day',
      'flow.note': 'Width is the daily energy share; numbers are kJ per in-world day.',
      'flow.waiting': 'Flows appear once the world runs.',
      'budget.title': 'Budget',
      'budget.species': 'Species',
      'budget.respire': 'Burn',
      'budget.intake': 'Intake',
      'budget.net': 'Net',
      'onboard.title': 'This is a small living world',
      'onboard.step1': 'Pick a species on the left — a rabbit, say.',
      'onboard.step2': 'Click the meadow to set it down.',
      'onboard.step3': 'Click an animal to read what it is doing, and why.',
      'onboard.dismiss': 'Got it',
      'onboard.again': 'Show the guide again',
      'status.emptyWorld': 'The world has gone quiet',
      'status.emptyWorldHint': 'Drop in some animals and it will start again.',
      'status.restock': 'Restock',
      'status.temperature': '{n} °C',
      'status.pulse': 'last 60s  born {births} · died {deaths}',
      'status.loading': 'Reading the world…',
      'status.saved': 'Saved {size}',
      'status.savePending': 'Saving…',
      'status.saveFailed': 'Cannot save locally',
      'notice.unsupportedVersion': 'That save comes from an incompatible version, so a fresh world was started; the old save is left untouched.',
      'notice.corrupt': 'The save is damaged and could not be read, so a fresh world was started.',
      'notice.noDecompressor': 'This browser cannot decompress a save, so a fresh world was started.',
      'notice.legacyTitle': 'Older save found',
      'notice.legacyBody': 'The 0.3 save format cannot read the old world, so a fresh one was started. Your old save is untouched and was not overwritten.',
      'notice.loadTitle': 'Could not load the save',
      'notice.loadBody': 'The saved world could not be read, so a fresh one was started. Reason: {reason}',
      'notice.dismiss': 'Got it',
      'brush.preview': 'Place {tool}',
      'brush.cell': 'cell {x}, {y}',
      'toast.erased': 'Cleared that patch',
      'toast.placed': 'Released {n}',
      'toast.blocked': 'Nothing fits here, and no room nearby',
      'chart.title': 'Populations',
    })

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

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
.pe-side{width:320px;flex:none;display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
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
.pe-tag-intent{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}@media (max-width: 980px){.pe-side{width:270px}.pe-tools{grid-template-columns:repeat(3,1fr)}}
.pe-stagewrap{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.pe-eventbar{display:flex;align-items:center;gap:8px;flex:none;height:46px;padding:0 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.pe-eventbar-title{flex:none;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pe-events-filters{display:flex;gap:3px;flex:none}
.pe-eventfilter{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:16px;padding:1px 6px;border-radius:999px;cursor:pointer}
.pe-eventfilter:hover{color:var(--dsw-alias-label-primary)}
.pe-eventfilter.is-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.pe-events{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.pe-event{appearance:none;display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:0 8px 0 5px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.pe-event:hover{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-border-l2)}
.pe-event:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-event-predation{border-color:var(--dsw-alias-state-error-primary)}
.pe-event-birth{border-color:var(--dsw-alias-state-success-primary)}
.pe-event-death{border-style:dashed}
.pe-event-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-event-time{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums}
.pe-event-where{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;opacity:.8}
.pe-events-empty{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}

.pe-tabs{display:flex;gap:4px;padding:3px;flex:none;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-tab{appearance:none;flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;line-height:16px;padding:4px 6px;border-radius:7px;cursor:pointer}
.pe-tab:hover{color:var(--dsw-alias-label-primary)}
.pe-tab.is-active{background:var(--dsw-alias-brand-primary);color:#fff}
.pe-tabbody{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow:auto}
.pe-dock{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);max-height:56%;overflow:auto}
.pe-blank{display:flex;align-items:center;gap:6px;padding:9px 10px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}
.pe-note{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
.pe-muted{color:var(--dsw-alias-label-secondary)}
.pe-mono{font-variant-numeric:tabular-nums}

.pe-srow{display:grid;grid-template-columns:13px 1fr 40px 52px 46px;align-items:center;gap:6px;font-size:11px;line-height:16px;cursor:pointer;border-radius:6px;padding:1px 3px}
.pe-srow:hover{background:var(--dsw-alias-bg-layer-2)}
.pe-srow-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-srow-num{text-align:right;font-variant-numeric:tabular-nums}
.pe-srow.is-gone .pe-srow-name{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.pe-srow-head{color:var(--dsw-alias-label-secondary);font-size:10px;cursor:default}
.pe-sbar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-sbar-fill{display:block;height:100%;border-radius:999px}
.pe-causes{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-cause{display:block;height:100%}

.pe-drive{display:grid;grid-template-columns:50px 1fr 28px;align-items:center;gap:6px}
.pe-drive-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-drive-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-drive-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-warn-primary))}
.pe-drive.is-high .pe-drive-fill{background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),var(--dsw-alias-state-error-primary))}
.pe-drive-value{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-kv{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:11px;line-height:15px}
.pe-kv-key{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pe-kv-value{text-align:right;font-variant-numeric:tabular-nums}
.pe-quote{padding:6px 8px;border-radius:8px;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px}
.pe-quote-meta{display:block;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;margin-top:2px}

.pe-flow{display:flex;flex-direction:column;gap:4px}
.pe-flow-row{display:grid;grid-template-columns:64px 1fr 60px;align-items:center;gap:6px;font-size:11px;line-height:15px}
.pe-flow-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-flow-track{position:relative;height:11px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-flow-fill{display:block;height:100%;border-radius:4px;transition:width .25s ease}
.pe-flow-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}

.pe-onboard{position:absolute;left:50%;top:14px;transform:translateX(-50%);width:min(430px,calc(100% - 24px));padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 14px 34px rgba(0,0,0,.32);z-index:5}
.pe-onboard-title{font-weight:650;font-size:12.5px;line-height:18px;margin-bottom:6px}
.pe-onboard-steps{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.pe-onboard-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:9px}
.pe-emptyworld{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 18px;border-radius:12px;background:rgba(20,22,28,.72);color:#fff;text-align:center;z-index:4;backdrop-filter:blur(4px)}
.pe-emptyworld-title{font-weight:650;font-size:12.5px;line-height:18px}
.pe-emptyworld-hint{font-size:11px;line-height:15px;opacity:.86}
.pe-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;font-variant-numeric:tabular-nums}
.pe-pill-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pe-pill-live{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.pe-brushpreview{position:absolute;transform:translate(-50%,-50%);border:1px dashed rgba(255,255,255,.85);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;z-index:3}
.pe-notice{position:absolute;left:50%;top:14px;transform:translateX(-50%);width:min(460px,calc(100% - 24px));padding:10px 12px;border-radius:11px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-warn-primary);box-shadow:0 12px 28px rgba(0,0,0,.3);z-index:6}
.pe-notice-title{font-weight:650;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}
.pe-notice-body{margin-top:3px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.pe-notice-actions{display:flex;justify-content:flex-end;margin-top:7px}
@media (max-width: 760px){.pe-eventbar{height:38px}}
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
      DRIVE_KEYS,
      CAUSE_KEYS,
      INTENT_IDS,
      // Scale and the two ledgers, so a headless probe can assert the physics
      // without reaching into the closure (docs/20-CORE-LOOP.md section 4).
      CELL_M,
      GRID_W,
      GRID_H,
      DAY_SECONDS,
      YEAR_DAYS,
      TICKS_PER_DAY,
      BIO,
      PRODUCERS,
      stepClimate,
      metabolise,
      bodyOf,
      dieOf,
      energyPools,
      snapshotEnergy,
      energyResidual,
      grazingIntake,
      dryMatterRequirement,
      GRAZE_REFERENCE,
      INTAKE_CEILING,
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
      // Save v2 is an async, compressed codec: the store must await these, and a
      // headless test asserts the round trip without touching localStorage.
      packWorld,
      unpackWorld,
      formatSaveSize,
      saveError,
      metabolicTemperatureFactor,
      feltTemperature,
      paintView,
      paintWorld,
      paintMinimap,
      viewFromCamera,
      worldFromPoint,
      cameraAfterZoom,
      frameFor,
      // Visual contract: the pose table and the season/sun model are what the
      // renderer and the tests share, so a headless test can pin "state X draws
      // pose Y" without reading pixels back.
      poseFor,
      poseForId,
      STATE_POSES,
      seasonLook,
      sunState,
      drawDepthLayers,
      ensureAtlas,
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