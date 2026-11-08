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
    //   I_max = INTAKE_CEILING * requirement     (an animal can eat ~3x upkeep)
    //   K     = (INTAKE_CEILING - 1) * reference (it reaches 2/3 of I_max on a
    //                                            sward of GRAZE_REFERENCE)
    //
    // Consequences that matter to the player: a grazer on a bare cell starves
    // even with grass in sight, a depleted patch pays less than a lush one (so
    // there is a reason to walk), and the daily dry matter intake of a 2 kg
    // rabbit comes out at ~182 g — the calibration number in
    // docs/10-SCALE-AND-UNITS.md — without any species row carrying it.

    /** Reference sward density, kg dry matter/m^2, where intake is 2/3 of max. */
    const GRAZE_REFERENCE = 0.12
    /** Peak intake as a multiple of the animal's own maintenance requirement. */
    const INTAKE_CEILING = 3

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
