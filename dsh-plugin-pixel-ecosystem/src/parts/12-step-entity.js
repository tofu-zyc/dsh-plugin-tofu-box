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
      if (entity.fate === 'eaten') {
        killEntity(world, entity, 'predation')
        return false
      }
      // While a predator is working through a kill it stands still: the carcass
      // is being eaten, not carried. Without this the animal is nailed to its
      // target position and jitters in place for the whole handling time.
      // intent keeps its last value (hunt/scavenge) so the panel still says what
      // it is doing; entity.handling is the flag the renderer uses for the
      // crouched, head-down eating pose.
      entity.handling = entity.body !== undefined && entity.body.handling !== null
      if (entity.handling) {
        entity.targetX = entity.x
        entity.targetY = entity.y
        entity.running = false
        entity.gait = (entity.gait ?? 0)
        updateFatigue(entity, dt, 0.12)
        return true
      }
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
      if (entity.intent === 'rest') {
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
      // drain, or an animal would pay for existing twice. A body-less entity
      // (an old save opened by a build without the ledger) still gets the flat
      // fallback drain so it cannot live forever.
      const body = entity.body
      const hasBody = body !== undefined && Number.isFinite(body.E)
      if (!hasBody) {
        entity.energy -= (balance.drain * genes.metabolism + (entity.fleeing ? (balance.fleeDrain ?? 0) : 0)) * dt
        entity.energy = Math.min(entity.energy, balance.maxEnergy)
        const reserve = entity.energy
        if (reserve <= 0 || entity.age > genes.lifespan) {
          killEntity(world, entity, reserve <= 0 ? 'starved' : 'old')
          return false
        }
      }
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
          const child = spawnEntity(world, entity.species, childX, childY,
            mutateGenes(world, genes, entity.species), entity.generation + 1)
          if (child === null) break
          child.energy = balance.startEnergy * 0.4
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
