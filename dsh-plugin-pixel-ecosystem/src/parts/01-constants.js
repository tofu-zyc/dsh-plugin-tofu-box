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
      FMR_ECTO_A: 1.2,
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
      /** Reserve buffer, in days of field metabolic rate. */
      RESERVE_DAYS: 5,
      /** Energy cost of one kg of new wet tissue (structure growth), kJ. */
      STRUCTURE_COST: 7000,
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
        bmax: 1.2,
        /** Potential relative growth, per in-world day. */
        mu: 26.0,
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
      /** Seconds a carcass takes to rot away completely. */
      corpseSeconds: 42,
    }

    /** Terrain codes stored in `world.terrain`. */
    const TERRAIN = { WATER: 0, SAND: 1, DIRT: 2, GRASS: 3, STONE: 4 }

    /** Gene keys in display order. */
    const GENE_KEYS = ['speed', 'vision', 'size', 'metabolism', 'lifespan', 'fertility']
