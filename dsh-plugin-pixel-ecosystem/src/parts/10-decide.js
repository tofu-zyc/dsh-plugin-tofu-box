    // ---------------------------------------------------------------------
    // Deliberation: utility scoring at state boundaries
    // ---------------------------------------------------------------------
    //
    // decide() is no longer called every few hundred milliseconds. It runs when
    // a bout ends, or when something urgent interrupts one, and it answers one
    // question: of the things this animal could do next, which is worth the
    // most? Every option is scored as
    //
    //   utility = sum over drives( weight x drive x opportunity ) - energy cost
    //
    // where the opportunity term is how well that action addresses the drive
    // (a full patch is better than a grazed one, a prey animal is better than
    // carrion), and the cost is the energy the trip itself will burn, converted
    // into the same units as hunger. Nothing here knows about species balance
    // knob-turning: the weights are role traits and the cost is drain/speed.

    /**
     * Energy in kJ an animal burns to walk a distance and then act for a while.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} distance - travel in cells.
     * @param {number} duration - seconds spent on the action itself.
     * @returns {number} kJ.
     */
    function tripCostKj(entity, species, distance, duration) {
      // kJ per second of upkeep. The body's field metabolic rate is the physical
      // number (Nagy 1999); the old flat drain is zero now that 09b owns the
      // ledger, so deriving it here is the only way the cost stays real.
      const body = entity.body
      const volume = body !== undefined && Number.isFinite(body.V) ? body.V : adultMassOf(species)
      const fmr = typeof fieldMetabolicRate === 'function'
        ? fieldMetabolicRate(species, volume)
        : Math.max(1, species.balance.maxEnergy) / 5
      const perSecond = (fmr / DAY_SECONDS) * (entity.genes.metabolism ?? 1)
      const speed = Math.max(0.4, entity.genes.speed)
      return perSecond * (distance / speed + duration)
    }

    /**
     * Turn a travel distance into the share of a bout it eats up.
     *
     * A trip is paid for in TIME, which is the budget a foraging animal actually
     * spends: a patch fifteen cells away is only worth it if it is close to
     * full value. Multiplying by this factor is what stops a walk across the
     * map for a marginally better bite, without banning long trips when the
     * animal is starving.
     * @param {number} distance - travel in cells.
     * @param {number} speed - cells per second.
     * @param {number} bout - planned seconds of the action itself.
     * @returns {number} 0..1 efficiency factor.
     */
    function tripEfficiency(distance, speed, bout) {
      const travel = distance / Math.max(0.4, speed)
      return bout / (bout + travel)
    }

    /**
     * A wander target that keeps going the way the animal was already going.
     *
     * Picking a random angle every time is what makes a walk look like a random
     * walk: the net displacement collapses toward zero no matter how fast the
     * animal moves. Keeping the current heading (with a small turn) gives a trip
     * a direction, which is what "it is going somewhere" looks like on screen.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} reach - how far ahead to aim.
     * @returns {{x: number, y: number}} target.
     */
    function wanderTarget(world, entity, reach) {
      let best = null
      for (let attempt = 0; attempt < 4; attempt++) {
        const angle = entity.heading + randomBetween(world, -1.1, 1.1)
        const x = clamp(entity.x + Math.cos(angle) * reach, 1, world.width - 2)
        const y = clamp(entity.y + Math.sin(angle) * reach, 1, world.height - 2)
        const index = cellIndex(world, x, y)
        if (index >= 0 && world.terrain[index] !== TERRAIN.STONE) return { x, y }
        if (best === null) best = { x, y }
      }
      return best ?? { x: entity.x + Math.cos(entity.heading) * reach, y: entity.y + Math.sin(entity.heading) * reach }
    }

    /**
     * Score every action this animal could take right now.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {{options: object[], best: object|null}} scored options, best first.
     */
    function scoreOptions(world, entity, species, grids) {
      const drives = entity.drives ?? updateDrives(world, entity, species, TICK)
      const weights = driveWeightsOf(species)
      const genes = entity.genes
      const belief = beliefOf(entity)
      const now = world.time
      const hungerWeight = weights.hunger ?? 1
      const options = []

      /**
       * Record one candidate. The travel charge is subtracted here so every
       * option pays the same rate for the same distance.
       * @param {string} kind - intent id.
       * @param {number} gain - weighted drive satisfaction.
       * @param {number} x - target column.
       * @param {number} y - target row.
       * @param {string} why - which drive chose this (for the inspector).
       * @returns {void}
       */
      const offer = (kind, gain, x, y, why) => {
        const distance = Math.hypot(x - entity.x, y - entity.y)
        const plan = STATE_PLAN[kind] ?? STATE_PLAN.rest
        const bout = plan.duration[0]
        // Energy actually spent getting there, in hunger units, plus the share
        // of the bout the walk eats up.
        const cost = tripCostKj(entity, species, distance, bout * 0.5)
          * energyToDriveUnits(species) * hungerWeight
        const score = gain * tripEfficiency(distance, entity.genes.speed, bout) - cost
        if (score <= 0.005) return
        options.push({ kind, score, x, y, why, distance })
      }

      // --- fear: nothing is worth standing next to a predator ----------------
      if (drives.fear > 0.22) {
        const threat = belief.threat
        const threatX = threat === null ? entity.threatX : threat.x
        const threatY = threat === null ? entity.threatY : threat.y
        let x = entity.x
        let y = entity.y
        if (threatX !== undefined && threatY !== undefined) {
          const dx = entity.x - threatX
          const dy = entity.y - threatY
          const length = Math.hypot(dx, dy) || 1
          const reach = genes.vision * 1.6
          x = clamp(entity.x + (dx / length) * reach, 1, world.width - 2)
          y = clamp(entity.y + (dy / length) * reach, 1, world.height - 2)
        }
        // No travel charge: running away is not an investment, and a predator
        // sitting on the best food in the county must still win every comparison.
        options.push({ kind: 'flee', score: weights.fear * drives.fear * 1.2 + 0.3, x, y, why: 'fear', distance: 0 })
      }

      // --- thirst -----------------------------------------------------------
      if (species.habitat !== 'water' && drives.thirst > 0.12 && belief.water !== null) {
        offer('drink', weights.thirst * drives.thirst * 1.1, belief.water.x, belief.water.y, 'thirst')
      }

      // --- food -------------------------------------------------------------
      if (species.role === 'grazer') {
        const food = belief.food
        if (food !== null && food !== undefined) {
          const confidence = beliefConfidence(food, now, BELIEF_LIFETIME.food)
          // Opportunity quality: how much food is there, how sure are we, and how
          // long would a bite last. A grazed-out cell is a bad place to walk to.
          const quality = clamp((food.value ?? 0) * (0.55 + 0.45 * confidence) * 1.15, 0.12, 1.25)
          offer('forage', weights.hunger * drives.hunger * quality, food.x, food.y, 'hunger')
        } else if (drives.hunger > 0.25) {
          // Nothing edible is in sight and the reserve is draining: go look.
          const spot = wanderTarget(world, entity, genes.vision * (1.1 + drives.hunger))
          offer('explore', weights.hunger * drives.hunger * 0.6, spot.x, spot.y, 'search')
        }
      } else if (species.role === 'hunter') {
        const prey = belief.food
        if (prey !== null && prey !== undefined) {
          const quality = clamp(0.7 + (prey.value ?? 0.5) * 0.5, 0.4, 1.2)
          offer('hunt', weights.hunger * clamp(drives.hunger + 0.18, 0, 1) * quality, prey.x, prey.y, 'hunger')
        }
        const carrion = belief.carrion
        if (carrion !== null && carrion !== undefined) {
          offer('scavenge', weights.hunger * drives.hunger * 0.85, carrion.x, carrion.y, 'hunger')
        } else if (drives.hunger > 0.45 && (prey === null || prey === undefined)) {
          const spot = wanderTarget(world, entity, genes.vision * 1.3)
          offer('explore', weights.hunger * drives.hunger * 0.55, spot.x, spot.y, 'search')
        }
      } else {
        const carrion = belief.carrion
        if (carrion !== null && carrion !== undefined) {
          offer('scavenge', weights.hunger * clamp(drives.hunger + 0.1, 0, 1) * (0.6 + carrion.value * 0.5),
            carrion.x, carrion.y, 'hunger')
        } else if (drives.hunger > 0.3) {
          const spot = wanderTarget(world, entity, genes.vision * 1.4)
          offer('explore', weights.hunger * drives.hunger * 0.5, spot.x, spot.y, 'search')
        }
      }

      // --- rest: only worth it when tired, fed enough and not scared ---------
      const restGain = weights.fatigue * drives.fatigue
        * clamp(0.3 + 0.7 * (1 - drives.fear), 0, 1)
        * clamp(1 - (drives.hunger - 0.5) / 0.45, 0, 1)
        * (1 - drives.cold * 0.5)
      if (restGain > 0.01) options.push({ kind: 'rest', score: restGain, x: entity.x, y: entity.y, why: 'fatigue', distance: 0 })

      // --- company ----------------------------------------------------------
      const herd = species.herd
      if (herd !== undefined && entity.herdAnchor !== null && entity.herdAnchor !== undefined) {
        const separation = herd.separation ?? 3
        const ring = separation + (species.genes.size?.[1] ?? 1) * 2.6
        // Each animal owns a slot on the ring instead of all of them aiming at
        // the centroid, which is what used to pile a herd onto one cell.
        const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
        const x = clamp(entity.herdAnchor.x + Math.cos(angle) * ring, 1, world.width - 2)
        const y = clamp(entity.herdAnchor.y + Math.sin(angle) * ring * 0.75, 1, world.height - 2)
        const pull = weights.social * (drives.social * 0.9 + drives.libido * 0.7)
        if (pull > 0.01) offer('socialize', pull, x, y, drives.libido > drives.social ? 'libido' : 'social')
      }

      // --- curiosity --------------------------------------------------------
      if (drives.curiosity > 0.06) {
        const reach = genes.vision * (0.7 + drives.curiosity * 1.2)
        const spot = wanderTarget(world, entity, reach)
        offer('explore', weights.curiosity * drives.curiosity, spot.x, spot.y, 'curiosity')
      }

      options.sort((a, b) => b.score - a.score)
      return { options, best: options[0] ?? null }
    }

    /**
     * Whether a drive has crossed the line where it may cut a bout short.
     *
     * This is the cheap per-tick guard: it reads numbers that are already on the
     * entity and never scores options. Full re-scoring only happens when one of
     * these fires (or when a bout ends on its own).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @returns {boolean} true when decide() should be woken early.
     */
    function interruptPending(world, entity) {
      const state = entity.state
      // No bout yet: the animal is between bouts and the think clock decides
      // when it starts one. Returning true here would overrun an intent that
      // was set from outside (a restored save, or a test that pins an intent).
      if (state === undefined) return false
      const drives = entity.drives
      if (drives === undefined) return false
      const klass = STATE_CLASS[state.id] ?? 0
      // A predator in sight ignores the commitment floor entirely.
      if (drives.fear > 0.5 && state.id !== 'flee') return true
      const elapsed = world.time - state.since
      if (elapsed < (state.min ?? 0)) return false
      if (drives.thirst > 0.85 && klass < STATE_CLASS.drink) return true
      if (drives.hunger > 0.92 && klass < 1) return true
      return false
    }

    /**
     * Start a new bout of the chosen action, with its own clock.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} option - the winning option.
     * @param {object[]} [rivals] - the options it beat (for the inspector).
     * @returns {void}
     */
    function startState(world, entity, species, option, rivals) {
      const plan = STATE_PLAN[option.kind] ?? STATE_PLAN.rest
      const duration = randomBetween(world, plan.duration[0], plan.duration[1])
      entity.state = {
        id: option.kind,
        since: world.time,
        until: world.time + duration,
        min: plan.min,
        phase: 'approach',
        why: option.why ?? 'idle',
        score: option.score,
        x: option.x,
        y: option.y,
      }
      entity.thinkTimer = duration
      entity.intent = option.kind
      entity.intentScore = option.score
      entity.targetX = option.x ?? entity.x
      entity.targetY = option.y ?? entity.y
      entity.fleeing = option.kind === 'flee'
      if (entity.fleeing) entity.flightTime = entity.flightTime ?? 0
      else entity.flightTime = 0
      // The inspector's "why": what was chosen, what it beat, and what the
      // animal wanted at that moment. Kept after the bout ends so the panel can
      // explain the last decision instead of only the current one.
      entity.decision = {
        at: world.time,
        picked: option.kind,
        score: Math.round(option.score * 1000) / 1000,
        why: option.why ?? 'idle',
        target: { x: option.x ?? entity.x, y: option.y ?? entity.y },
        alternatives: (rivals ?? []).slice(0, 3).map(rival => ({
          kind: rival.kind,
          score: Math.round(rival.score * 1000) / 1000,
        })),
        drives: entity.drives === undefined ? null : {
          hunger: Math.round(entity.drives.hunger * 100) / 100,
          thirst: Math.round(entity.drives.thirst * 100) / 100,
          cold: Math.round(entity.drives.cold * 100) / 100,
          fatigue: Math.round(entity.drives.fatigue * 100) / 100,
          fear: Math.round(entity.drives.fear * 100) / 100,
          social: Math.round(entity.drives.social * 100) / 100,
          curiosity: Math.round(entity.drives.curiosity * 100) / 100,
          libido: Math.round(entity.drives.libido * 100) / 100,
        },
      }
      // A plan is the sentence the inspector shows: walk there, then do the
      // thing. One step per phase is enough for now; the array shape is the
      // contract (docs/20-CORE-LOOP.md 2.3) so later systems can add steps.
      entity.plan = {
        goal: option.kind,
        index: 0,
        steps: [
          { x: option.x ?? entity.x, y: option.y ?? entity.y, act: option.kind, duration },
        ],
      }
    }

    /**
     * Keep the current bout but re-aim it at a better version of the same thing.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} option - the refreshed winner.
     * @returns {void}
     */
    function continueState(world, entity, species, option) {
      const plan = STATE_PLAN[option.kind] ?? STATE_PLAN.rest
      const duration = randomBetween(world, plan.duration[0], plan.duration[1])
      entity.state.since = world.time
      entity.state.until = world.time + duration
      entity.state.phase = 'approach'
      entity.state.score = option.score
      entity.state.why = option.why ?? 'idle'
      entity.state.x = option.x
      entity.state.y = option.y
      entity.thinkTimer = duration
      entity.targetX = option.x ?? entity.x
      entity.targetY = option.y ?? entity.y
      entity.intentScore = option.score
    }

    /**
     * Choose the next action, or keep the current one on its clock.
     *
     * Called at a state boundary or on an interrupt (see interruptPending).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {void}
     */
    function decide(world, entity, species, grids) {
      const scored = scoreOptions(world, entity, species, grids)
      const current = entity.state
      const best = scored.best
      if (best === null) {
        // Nothing scores: an animal with no want sits down. This is the only
        // zero-score state and it is honest — it means every drive is satisfied.
        startState(world, entity, species, { kind: 'rest', score: 0.02, x: entity.x, y: entity.y, why: 'idle' })
        return
      }
      if (current === undefined) {
        startState(world, entity, species, best, scored.options.slice(1))
        return
      }
      const sameKind = current.id === best.kind
      const rivals = scored.options.filter(option => option.kind !== current.id)
      if (sameKind) {
        // Same answer: keep going, with a fresh clock and a better target.
        continueState(world, entity, species, best)
        return
      }
      const currentScore = bestByKind(scored.options, current.id)
      const klassGap = (STATE_CLASS[best.kind] ?? 0) - (STATE_CLASS[current.id] ?? 0)
      const expired = world.time >= current.until
      const committed = world.time - current.since < (current.min ?? 0)
      // Hysteresis: a rival has to be clearly better, not merely ahead. This is
      // what makes the intent dwell worth watching instead of a twitch.
      const clearlyBetter = best.score > currentScore * STATE_HYSTERESIS + STATE_MARGIN
      const mayCut = klassGap > 0 || expired
      if (mayCut && (!committed || klassGap > 0) && (clearlyBetter || expired)) {
        startState(world, entity, species, best, rivals)
        return
      }
      // Otherwise the animal stays with what it was doing and finishes the bout.
      current.score = Math.max(current.score, best.score)
      entity.thinkTimer = Math.max(0.5, current.until - world.time)
    }

    /**
     * Score recorded for one kind among the scored options (0 when absent).
     * @param {object[]} options - scored options.
     * @param {string} kind - intent id.
     * @returns {number} that kind's best score.
     */
    function bestByKind(options, kind) {
      for (const option of options) if (option.kind === kind) return option.score
      return 0
    }
