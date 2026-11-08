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
