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
