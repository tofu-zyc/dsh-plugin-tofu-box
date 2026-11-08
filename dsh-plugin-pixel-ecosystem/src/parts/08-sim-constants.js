    // ---------------------------------------------------------------------
    // Simulation step
    // ---------------------------------------------------------------------

    /**
     * Kill an animal and leave a carcass behind.
     * Single death path: starvation, old age and predation all end here, and the
     * cause is written down — a world where animals vanish without a reason is
     * unreadable (docs/20-CORE-LOOP.md invariant 3).
     * @param {object} world - the world.
     * @param {object} entity - the dying animal.
     * @param {string} [cause] - 'starved' | 'frozen' | 'predation' | 'old' | 'disease'.
     */
    function killEntity(world, entity, cause) {
      if (entity.fate === 'dead') return
      entity.fate = 'dead'
      if (cause !== undefined && entity.cause === undefined) entity.cause = cause
      if (entity.body !== undefined && entity.body.cause === undefined && cause !== undefined) entity.body.cause = cause
      for (let puff = 0; puff < 3; puff++) spawnEffect(world, entity.x, entity.y, PALETTE.effect.death, 0.5, 0.5)
      if (world.population !== undefined && world.population[entity.species] !== undefined) {
        world.population[entity.species] = Math.max(0, world.population[entity.species] - 1)
      }
      const species = SPECIES[entity.species]
      const meat = species === undefined ? 24 : species.meat
      world.corpses.push({
        id: world.nextId++,
        x: entity.x,
        y: entity.y,
        species: entity.species,
        decay: 0,
        energy: Math.round(meat * 0.8),
      })
      if (world.corpses.length > MAX_CORPSES) world.corpses.shift()
    }

    /**
     * Move an animal toward a target, sliding along terrain edges.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} targetX - destination.
     * @param {number} targetY - destination.
     * @param {number} dt - step in seconds.
     * @param {number} multiplier - speed multiplier.
     */
    /**
     * A standing spot near an animal, or null when it is truly boxed in.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {number} x - origin column.
     * @param {number} y - origin row.
     * @param {number} radius - search radius in cells.
     * @returns {{x: number, y: number}|null} reachable spot.
     */
    function nearbyStand(world, species, x, y, radius) {
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const angle = nextRandom(world) * Math.PI * 2
        const distance = 1.5 + nextRandom(world) * radius
        const nx = clamp(x + Math.cos(angle) * distance, 0.5, world.width - 0.5)
        const ny = clamp(y + Math.sin(angle) * distance, 0.5, world.height - 0.5)
        if (canStand(world, species, nx, ny)) return { x: nx, y: ny }
      }
      return null
    }

    function moveToward(world, entity, species, targetX, targetY, dt, multiplier) {
      let dx = targetX - entity.x
      let dy = targetY - entity.y
      const distance = Math.hypot(dx, dy)
      
      if (distance < 0.12 && entity.fleeing !== true) {
        // Already standing on the target (usually a patch of grass): graze in
        // place instead of twitching around it.
        return
      }
      if (distance < 0.08) {
        entity.heading += randomBetween(world, -1.4, 1.4)
      } else {
        dx /= distance
        dy /= distance
        const desired = Math.atan2(dy, dx)
        let delta = desired - entity.heading
        if (delta > Math.PI) delta -= Math.PI * 2
        if (delta < -Math.PI) delta += Math.PI * 2
        entity.heading += clamp(delta, -6 * dt, 6 * dt)
      }
      let wadeFactor = 1
      if (species.wade === true || species.amphibious === true) {
        const column = Math.max(0, Math.min(world.width - 1, Math.round(entity.x)))
        const row = Math.max(0, Math.min(world.height - 1, Math.round(entity.y)))
        const index = row * world.width + column
        const wet = world.terrain[index] === TERRAIN.WATER
        // Hauling out on the bank costs a water animal speed too: the water is
        // its home, the land is a place it visits.
        if (wet) wadeFactor = species.wade === true ? 0.62 : 1
        else if (species.amphibious === true) wadeFactor = 0.72
      }
      const pace = entity.genes.speed * multiplier * wadeFactor
        * (0.88 + 0.12 * Math.sin(world.time * 2.6 + entity.phase * 6.28))
      const stepX = Math.cos(entity.heading) * pace * dt
      const stepY = Math.sin(entity.heading) * pace * dt
      // Steer AROUND an obstacle instead of bouncing off it. The old code threw
      // away the heading and picked a random one on every blocked step, so an
      // animal whose target sat across a lake would aim at the water, get
      // blocked, spin, aim at the water again: that is the "pacing along the
      // shoreline forever" bug.
      let moved = false
      for (const offset of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
        const heading = entity.heading + offset
        const tryX = Math.cos(heading) * pace * dt
        const tryY = Math.sin(heading) * pace * dt
        if (!canStand(world, species, entity.x + tryX, entity.y + tryY)) continue
        entity.x += tryX
        entity.y += tryY
        // Face the way it actually travels, or a sliding animal reads as walking
        // sideways.
        if (offset !== 0) entity.heading = heading
        moved = true
        break
      }
      if (moved) {
        entity.stuck = 0
      } else {
        // Boxed in on every side. Shake loose toward a reachable spot close by
        // and drop the current target, so the next decision is not the same
        // unreachable patch on the far bank.
        entity.stuck = (entity.stuck ?? 0) + dt
        if (entity.stuck > 0.3) {
          entity.stuck = 0
          const spot = nearbyStand(world, species, entity.x, entity.y, 6)
          if (spot !== null) {
            entity.targetX = spot.x
            entity.targetY = spot.y
          }
        }
      }
      entity.x = clamp(entity.x, 0.05, world.width - 0.05)
      entity.y = clamp(entity.y, 0.05, world.height - 0.05)
    }

    /**
     * Nearest prey of a hunter, honouring the species' preference order.
     *
     * `prey` is ordered: a wolf lists deer first, so it looks for a deer and
     * only falls back to rabbits when no deer is in sight. Without the ordering
     * wolves would simply eat whatever is closest — usually rabbits — and the
     * deer population would run unmanaged.
     * @param {object} entity - the hunter.
     * @param {object} species - hunter species row.
     * @param {object} grid - grid of all animals.
     * @param {number} radius - search radius in cells.
     * @returns {object|null} the chosen prey.
     */
    function nearestPrey(entity, species, grid, radius) {
      // Grazers and scavengers have no prey list at all, and every caller
      // (perception included) asks unconditionally: an absent field must mean
      // "hunts nothing", not a TypeError that takes the whole world down.
      for (const preyId of species.prey ?? []) {
        const found = queryNearest(grid, entity.x, entity.y, radius,
          candidate => candidate.fate === '' && candidate.species === preyId)
        if (found !== null) return found
      }
      return null
    }

    /**
     * Nearest plant still carrying leaves, for browsing deer.
     * @param {object} world - the world.
     * @param {object} entity - the deer.
     * @param {number} radius - reach in cells.
     * @returns {object|null} the plant.
     */
    function nearestFoliage(world, entity, radius) {
      let best = null
      let bestDistance = radius * radius
      for (const plant of world.trees) {
        if (plant.variant === 'lily' || plant.variant === 'reed') continue
        if ((plant.foliage ?? 0) <= 0.06) continue
        const dx = plant.x - entity.x
        const dy = plant.y - entity.y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = plant }
      }
      return best
    }

    // ---------------------------------------------------------------------
    // Behaviour states (executed by the machine in 10b-execution.js)
    // ---------------------------------------------------------------------

    /**
     * States are ordered by urgency, and that order is what makes an interrupt
     * safe: something urgent may cut a lower state short, nothing may cut
     * something more urgent. A predator beats a drink, a drink beats a meal, a
     * meal beats a nap or a look around.
     */
    const STATE_CLASS = {
      flee: 3,
      drink: 2,
      forage: 1,
      hunt: 1,
      scavenge: 1,
      rest: 0,
      socialize: 0,
      explore: 0,
    }

    /**
     * Per state: the shortest time the animal stays committed, and the planned
     * length of a normal bout.
     *
     * `min` is the anti-twitch floor. The 0.2.x build re-rolled its whole intent
     * every 0.22-0.55 s, which is why nothing on screen ever looked like it was
     * doing something. `duration` is how long a bout runs before the animal
     * considers its options again.
     */
    const STATE_PLAN = {
      flee: { min: 2.5, duration: [4, 7] },
      drink: { min: 3, duration: [4, 8] },
      forage: { min: 8, duration: [14, 26] },
      hunt: { min: 8, duration: [14, 26] },
      scavenge: { min: 6, duration: [12, 22] },
      rest: { min: 10, duration: [20, 40] },
      socialize: { min: 6, duration: [10, 18] },
      explore: { min: 8, duration: [14, 26] },
    }

    /** How much better a rival must score before it may cut a state short. */
    const STATE_HYSTERESIS = 1.18

    /** Absolute score margin on top of the ratio, so a near-tie never flips. */
    const STATE_MARGIN = 0.1

    /**
     * How much of its hunger one kJ of travel is worth, i.e. the exchange rate
     * between a joule spent walking and a hunger drive unit: exactly the size of
     * the reserve, because hunger is 1 - E/Emax. This is what lets the decision
     * system subtract a real energy cost from a unitless score.
     * @param {object} species - species row.
     * @returns {number} hunger units per kJ.
     */
    function energyToDriveUnits(species) {
      return 1 / Math.max(1, species.balance.maxEnergy)
    }