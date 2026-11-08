/**
 * Execution: the state machine that turns a goal into timed action.
 *
 * OWNER: behaviour
 *
 * A state is a bout: a thing the animal is doing, with a clock, a completion
 * condition and a commitment floor. decide() only runs at a boundary or on an
 * interrupt; between those the animal *keeps doing the thing* — which is the
 * difference between a creature and a reaction field.
 *
 * Interrupt priority (docs/20-CORE-LOOP.md 2.3, table in 08-sim-constants):
 *   flee > survive (drink) > opportunity (forage/hunt/scavenge) > intrinsic
 *
 * Completion is per state, and every one of them can end three ways: the need
 * that opened the bout is satisfied, the bout's planned time runs out, or the
 * animal stops making progress toward the target. The third one is what stops a
 * rabbit pacing a shoreline for a minute because its patch was across the lake.
 */
    // ---------------------------------------------------------------------
    // Execution: timed states with completion conditions
    // ---------------------------------------------------------------------

    /** Seconds between re-aim checks inside a state. */
    const AIM_INTERVAL = 0.5

    /** Patch quality below which the animal has cropped the ground bare. */
    const CROPPED_SWARD = 0.12

    /** Seconds of no progress before a state gives up and re-decides. */
    const PROGRESS_WINDOW = 1.3
    /** Consecutive stalled windows before the animal abandons its target. */
    const PROGRESS_STALLS = 2

    /**
     * The closest edible cell right around an animal's feet.
     *
     * This is the "head down, keep grazing" loop: while a forage bout runs, the
     * animal steps from cell to cell in place instead of re-deciding every time
     * it finishes a bite. Cheap by construction — 9 cells, not a scan.
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @returns {{x: number, y: number, value: number}|null} the best nearby bite.
     */
    function bestLocalBite(world, entity, species) {
      const field = floraField(world, species)
      if (field === null) return null
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const originX = Math.round(entity.x)
      const originY = Math.round(entity.y)
      let best = null
      let bestScore = 0.02
      for (let offsetY = -2; offsetY <= 2; offsetY++) {
        for (let offsetX = -2; offsetX <= 2; offsetX++) {
          const cellX = originX + offsetX
          const cellY = originY + offsetY
          const index = cellIndex(world, cellX, cellY)
          if (index < 0 || world.terrain[index] !== wanted) continue
          const available = field[index]
          if (available <= 0.004) continue
          if (!canStand(world, species, cellX + 0.5, cellY + 0.5)) continue
          const quality = swardQuality(available)
          const distance = Math.hypot(offsetX, offsetY)
          const score = quality - distance * 0.1
          if (score > bestScore) { bestScore = score; best = { x: cellX + 0.5, y: cellY + 0.5, value: quality } }
        }
      }
      return best
    }

    /**
     * Quality of the sward directly under an animal's feet (0 when it is
     * standing on the wrong terrain or the cell is bare).
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @returns {number} 0..1 quality.
     */
    function swardUnderfoot(world, entity, species) {
      const field = floraField(world, species)
      if (field === null) return 0
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const index = cellIndex(world, entity.x, entity.y)
      if (index < 0 || world.terrain[index] !== wanted) return 0
      return swardQuality(field[index])
    }
    /**
     * Give an animal that has an intent but no clock (a restored save, a
     * hand-placed test animal) a bout it can run out.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @returns {object} the state.
     */
    function adoptState(world, entity) {
      const id = INTENT_IDS.includes(entity.intent) ? entity.intent : 'explore'
      const plan = STATE_PLAN[id] ?? STATE_PLAN.explore
      // Never shorter than the floor: a resumed bout is still a bout, and a
      // bout that ends under its own commitment time is the twitch this whole
      // part exists to remove.
      const until = Math.max(entity.thinkTimer ?? 0, plan.min)
      entity.state = {
        id,
        since: world.time,
        until: world.time + until,
        min: plan.min,
        phase: 'adopted',
        why: 'resume',
        score: 0,
        x: entity.targetX,
        y: entity.targetY,
        adopted: true,
      }
      entity.fleeing = id === 'flee'
      return entity.state
    }

    /**
     * Whether the animal has stopped closing on its target this window.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} state - the current state.
     * @returns {boolean} true when the target has proved unreachable.
     */
    function stalledAt(world, entity, state) {
      const now = world.time
      const remaining = Math.hypot(entity.targetX - entity.x, entity.targetY - entity.y)
      if (state.checkAt === undefined) {
        state.checkAt = now + PROGRESS_WINDOW
        state.checkDistance = remaining
        return false
      }
      if (now < state.checkAt) return false
      const gained = (state.checkDistance ?? remaining) - remaining
      state.checkDistance = remaining
      state.checkAt = now + PROGRESS_WINDOW
      state.stalls = gained < 0.06 ? (state.stalls ?? 0) + 1 : 0
      return state.stalls >= PROGRESS_STALLS
    }

    /**
     * Re-aim the current bout when the thing it is aimed at has moved.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} state - the current state.
     * @returns {void}
     */
    function reaim(world, entity, species, state) {
      const now = world.time
      if (now < (state.aimAt ?? 0)) return
      state.aimAt = now + AIM_INTERVAL
      const belief = beliefOf(entity)
      if (state.id === 'flee') {
        const threat = belief.threat
        const threatX = threat === null ? entity.threatX : threat.x
        const threatY = threat === null ? entity.threatY : threat.y
        if (threatX === undefined || threatY === undefined) return
        const dx = entity.x - threatX
        const dy = entity.y - threatY
        const length = Math.hypot(dx, dy) || 1
        const reach = entity.genes.vision * 1.6
        state.x = clamp(entity.x + (dx / length) * reach, 1, world.width - 2)
        state.y = clamp(entity.y + (dy / length) * reach, 1, world.height - 2)
        entity.targetX = state.x
        entity.targetY = state.y
        return
      }
      if (state.id === 'hunt' || state.id === 'scavenge') {
        const target = state.id === 'hunt' ? belief.food : belief.carrion
        if (target !== null && target !== undefined) { state.x = target.x; state.y = target.y }
        entity.targetX = state.x
        entity.targetY = state.y
        return
      }
      if (state.id === 'drink') {
        const water = belief.water
        if (water !== null) { state.x = water.x; state.y = water.y; entity.targetX = state.x; entity.targetY = state.y }
        return
      }
      if (state.id === 'socialize') {
        const herd = species.herd
        const anchor = entity.herdAnchor
        if (herd === undefined || anchor === null || anchor === undefined) return
        const ring = (herd.separation ?? 3) + (species.genes.size?.[1] ?? 1) * 2.6
        const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
        state.x = clamp(anchor.x + Math.cos(angle) * ring, 1, world.width - 2)
        state.y = clamp(anchor.y + Math.sin(angle) * ring * 0.75, 1, world.height - 2)
        entity.targetX = state.x
        entity.targetY = state.y
      }
    }

    /**
     * Advance the animal's current bout by one tick.
     *
     * Writes entity.intent from the state id (the renderer and the inspector
     * read that field), keeps the target aimed, and ends the bout when its
     * completion condition is met. It never calls decide(): that is stepEntity's
     * job at the next boundary, which is what keeps the two apart.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @param {number} dt - step in seconds.
     * @returns {void}
     */
    function execute(world, entity, species, grids, dt) {
      const state = entity.state === undefined ? adoptState(world, entity) : entity.state
      const drives = entity.drives
      const now = world.time
      entity.intent = state.id
      entity.fleeing = state.id === 'flee'
      // An adopted bout has no known goal: keep it alive until its clock runs
      // out, and let the next deliberation take over from there.
      if (state.adopted === true) {
        entity.targetX = state.x ?? entity.targetX
        entity.targetY = state.y ?? entity.targetY
        if (now >= state.until) { entity.state = undefined; entity.thinkTimer = 0 }
        return
      }

      let done = false
      const hunger = drives === undefined ? 0.3 : drives.hunger
      const thirst = drives === undefined ? 0 : drives.thirst
      const fear = drives === undefined ? 0 : drives.fear
      const fatigue = drives === undefined ? 0 : drives.fatigue

      if (state.id === 'flee') {
        reaim(world, entity, species, state)
        // The bout ends when the animal has calmed down, not on a timer: the
        // alarm afterglow is what decides, so a peek-and-bolt reads as one.
        done = fear < 0.3
      } else if (state.id === 'forage') {
        const local = bestLocalBite(world, entity, species)
        const standing = swardUnderfoot(world, entity, species)
        const distanceToPlan = Math.hypot(state.x - entity.x, state.y - entity.y)
        if (standing >= CROPPED_SWARD) {
          // Standing on good grass: put the head down and STAY. Stepping to a
          // neighbouring cell every tick is how a grazing animal accumulated a
          // long path without going anywhere.
          state.phase = 'do'
          entity.targetX = entity.x
          entity.targetY = entity.y
          if (local !== null) rememberFood(entity, local.x, local.y, local.value, now)
        } else if (local !== null && (distanceToPlan < 2.5 || local.value > 0.55)) {
          // This cell is cropped: step to the best bite next to it.
          state.phase = 'do'
          entity.targetX = local.x
          entity.targetY = local.y
          rememberFood(entity, local.x, local.y, local.value, now)
        } else if (distanceToPlan > 0.9) {
          state.phase = 'approach'
          entity.targetX = state.x
          entity.targetY = state.y
        } else {
          state.phase = 'do'
          entity.targetX = entity.x
          entity.targetY = entity.y
          // Arrived, nothing left to eat here: this patch is spent.
          if (local === null) done = true
        }
        if (hunger < 0.12) done = true
        // A cropped cell pays almost nothing under Holling II, so standing on it
        // is pointless: move on to a better patch. Without this an animal keeps
        // its head down on a bare cell and its whole life's path is spent
        // shuffling inside one metre.
        if (local !== null && local.value < CROPPED_SWARD && hunger > 0.2) done = true
      } else if (state.id === 'hunt' || state.id === 'scavenge') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.2 ? 'approach' : 'do'
        // Arrived and the prey is gone: the ambush failed, think again.
        const current = state.id === 'hunt' ? beliefOf(entity).food : beliefOf(entity).carrion
        if (distance <= 1.2 && (current === null || current === undefined)) done = true
        if (hunger < 0.1) done = true
      } else if (state.id === 'drink') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.2 ? 'approach' : 'do'
        if (state.phase === 'do') {
          // Standing at the bank: check that drinking is actually working. An
          // animal that cannot reach the water must abandon the attempt, not
          // stand there until the bout timer runs out and try again.
          if (state.thirstAtDo === undefined) {
            state.thirstAtDo = thirst
            state.doSince = now
          } else if (now - state.doSince > 2 && thirst > state.thirstAtDo - 0.02) {
            done = true
          }
        }
        if (thirst < 0.12) done = true
      } else if (state.id === 'rest') {
        // Resting marks the ground as home: this is where the animal comes back
        // to, and what makes a warren a place instead of a coordinate.
        const belief = beliefOf(entity)
        if (belief.home === null) belief.home = { x: entity.x, y: entity.y, t: now }
        state.phase = 'do'
        entity.targetX = entity.x
        entity.targetY = entity.y
        done = fatigue < 0.12
      } else if (state.id === 'socialize') {
        reaim(world, entity, species, state)
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.5 ? 'approach' : 'do'
        // Close enough to the herd, or arrived at its own slot: the animal got
        // what it came for. The channel is marked sated so it goes back to its
        // own business instead of orbiting the herd for the rest of its life.
        const herd = species.herd
        const crowd = herd === undefined ? 0 : (herd.crowd ?? 4)
        if (distance <= 1.5 || (entity.socialCount ?? 0) >= crowd) {
          entity.socialSated = 1
          done = true
        }
      } else if (state.id === 'explore') {
        const distance = Math.hypot(state.x - entity.x, state.y - entity.y)
        state.phase = distance > 1.5 ? 'approach' : 'do'
        if (distance <= 1.5) {
          // Arrived, but the bout is not over: pick the next leg from here, in
          // the direction the animal is already facing. A walk that re-rolls
          // its angle on every arrival is a random walk however fast it moves;
          // three legs of the same heading is a trip.
          const reach = Math.min(40, entity.genes.vision * (1.2 + (drives === undefined ? 0.2 : drives.curiosity) * 2.4))
            * (entity.stage === 'juvenile' ? 1.4 : 1)
          const ahead = wanderTarget(world, entity, species, reach)
          state.x = ahead.x
          state.y = ahead.y
          entity.targetX = ahead.x
          entity.targetY = ahead.y
          state.legs = (state.legs ?? 0) + 1
          if (state.legs >= 3) {
            // Curiosity is spent for a while (habituation), so the animal does
            // not immediately pick another random direction.
            entity.habituation = 1
            done = true
          }
        }
      }

      if (state.phase === 'approach' && stalledAt(world, entity, state)) done = true
      if (now >= state.until) done = true
      // The commitment floor applies to EVERY ending, not just to rivals: a
      // bout that starts and stops inside half a second is the twitch this
      // whole part exists to remove. Only a predator (flee) or the end of the
      // scheduled bout may finish before the floor.
      if (done && now - state.since < (state.min ?? 0) && now < state.until) done = false
      if (done) {
        entity.state = undefined
        entity.thinkTimer = 0
        entity.stateEndedAt = now
      }
    }
