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
