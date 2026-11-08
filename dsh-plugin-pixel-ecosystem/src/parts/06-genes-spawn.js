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
