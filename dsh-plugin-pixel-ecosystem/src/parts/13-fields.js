
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
    function updateProducerCell(world, index, field, params, water, days) {
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
        const cell = world.detritus[index] + littered / CELL_AREA
        if (cell > DETRITUS.bmax) {
          world.budget.overflow += (cell - DETRITUS.bmax) * CELL_AREA * BIO.GRASS_ENERGY
          world.detritus[index] = DETRITUS.bmax
        } else {
          world.detritus[index] = cell
        }
      }

      // --- gross primary production --------------------------------------
      if (light > 0) {
        const waterFactor = water / (water + params.waterHalf)
        const nutrientFactor = soil / (soil + params.nutrientHalf)
        const gross = TUNING.productivity * params.mu * (next + params.seed)
          * light * waterFactor * nutrientFactor * days
        const cap = params.bmax
        const grown = next + gross > cap ? cap : next + gross
        world.budget.gpp += (grown - next) * CELL_AREA * BIO.GRASS_ENERGY
        next = grown
        // Uptake is proportional to how much was actually built, so a slow cell
        // does not drain the soil it cannot use.
        soil = Math.max(0, soil - gross * DETRITUS.nutrientPerGrowth)
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
          updateProducerCell(world, index, weed, PRODUCERS.weed, 1, days)
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
