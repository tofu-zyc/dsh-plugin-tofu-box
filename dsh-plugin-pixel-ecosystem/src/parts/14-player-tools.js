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
