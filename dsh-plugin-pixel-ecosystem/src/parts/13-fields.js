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
