    /**
     * Score the candidate actions and commit to the best one.
     *
     * This is the whole decision system: each option gets a score from the
     * needs it would satisfy, the temperament of the species, and the distance
     * it would cost. The winner becomes `entity.intent`, which the renderer,
     * the inspector and any future social layer can read directly.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     */
    function decide(world, entity, species, grids) {
      const genes = entity.genes
      const balance = species.balance
      const needs = needsOf(entity)
      const traits = traitsOf(species)
      const weights = NEED_WEIGHT[species.role] ?? NEED_WEIGHT.grazer
      const options = []
      const offer = (kind, score, x, y) => {
        if (score > 0) options.push({ kind, score, x, y })
      }

      // --- safety: a spotted predator always wins -------------------------
      if (species.role === 'grazer') {
        const predators = PREDATORS_OF[entity.species]
        const threat = queryNearest(grids.hunter, entity.x, entity.y, genes.vision,
          candidate => candidate.fate === '' && predators.has(candidate.species))
        if (threat !== null) {
          entity.alarm = ALARM_SECONDS
          entity.threatX = threat.x
          entity.threatY = threat.y
          spreadAlarm(entity, species, grids.prey, threat, world)
        }
        const threatX = threat !== null ? threat.x : entity.threatX
        const threatY = threat !== null ? threat.y : entity.threatY
        const distance = threatX === undefined || threatY === undefined
          ? Infinity
          : Math.hypot(entity.x - threatX, entity.y - threatY)
        // Bold animals let a threat come closer before they bolt.
        const nerve = genes.vision * (1.05 + traits.bold * 0.75)
        if (threat !== null || distance < nerve) {
          needs.safety = Math.max(needs.safety, threat !== null ? 1 : 0.75)
        }
      }
      if (needs.safety > 0.45) {
        const threatX = entity.threatX ?? entity.x - 1
        const threatY = entity.threatY ?? entity.y
        const dx = entity.x - threatX
        const dy = entity.y - threatY
        const length = Math.hypot(dx, dy) || 1
        offer('flee', weights.safety * needs.safety + 6,
          clamp(entity.x + (dx / length) * genes.vision * 1.5, 1, world.width - 2),
          clamp(entity.y + (dy / length) * genes.vision * 1.5, 1, world.height - 2))
      }

      // --- food ------------------------------------------------------------
      if (species.role === 'grazer') {
        const anchor = species.herd === undefined ? null : (entity.herdAnchor ?? null)
        const patch = findFlora(world, entity, species, anchor)
        if (patch !== null) {
          const pull = anchor === null ? 0 : 0.12
          const x = patch.x + (anchor === null ? 0 : (anchor.x - patch.x) * pull)
          const y = patch.y + (anchor === null ? 0 : (anchor.y - patch.y) * pull)
          offer('forage', weights.hunger * (needs.hunger + 0.3), x, y)
        } else if (species.browse === true) {
          const plant = findFoliage(world, entity, genes.vision)
          if (plant !== null) offer('forage', weights.hunger * (needs.hunger + 0.06), plant.x, plant.y)
        }
      } else if (species.role === 'hunter') {
        // Predators work on scent as well as sight. With eyesight alone a fox
        // has a ~20% chance of a rabbit being in range on this map, so the whole
        // predator tier used to wander (explore 60%+) and starve at hunger 0.8.
        const reach = genes.vision * (species.huntReach ?? 2.6)
        const prey = nearestPrey(entity, species, grids.prey, reach)
        if (prey !== null) offer('hunt', weights.hunger * (needs.hunger + 0.25) * 1.7, prey.x, prey.y)
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision * 1.7)
        if (corpse !== null) offer('scavenge', weights.hunger * (needs.hunger - 0.1), corpse.x, corpse.y)
      } else {
        // Carrion is worth smelling from far off; a crow also patrols between
        // corpses instead of picking a random wander direction.
        const corpse = nearestCorpse(world, entity.x, entity.y, genes.vision * 1.9)
        if (corpse !== null) offer('scavenge', weights.hunger * (needs.hunger + 0.2), corpse.x, corpse.y)
      }

      // --- water -----------------------------------------------------------
      if (needs.thirst > 0.2 && species.habitat !== 'water') {
        const water = nearestWater(world, entity.x, entity.y, genes.vision)
        if (water !== null) offer('drink', weights.thirst * (needs.thirst + 0.1), water.x, water.y)
      }

      // --- rest ------------------------------------------------------------
      // Diurnal animals rest harder at night; night animals rest by day.
      const activity = activityFactor(world, species)
      const restBias = activity < 0.6 ? 1.35 : 0.9
      if (needs.hunger < 0.62) {
        offer('rest', weights.energy * (needs.energy + 0.05) * restBias, entity.x, entity.y)
      }

      // --- company ---------------------------------------------------------
      if (species.herd !== undefined && needs.hunger < 0.65) {
        let anchorPoint = entity.herdAnchor ?? null
        if (entity.herdTimer <= 0 || anchorPoint === null) {
          anchorPoint = herdCentroid(entity, species, species.role === 'hunter' ? grids.hunter : grids.prey)
          entity.herdAnchor = anchorPoint
          entity.herdTimer = 0.8
        }
        if (anchorPoint !== null) {
          // Stand on a ring around the herd, not on the herd. Without this every
          // member of a herd walks to the exact same centroid and the meadow
          // fills with a pile of overlapping sprites. The golden angle gives each
          // animal its own stable slot in the ring.
          const separation = species.herd.separation ?? 3
          // Big animals need a bigger ring: a deer is six cells long, so a
          // six-cell ring still stacks them.
          const ring = separation + (species.genes.size?.[1] ?? 1) * 2.6
          const angle = (entity.id * 2.399963229728653) % (Math.PI * 2)
          const ringX = anchorPoint.x + Math.cos(angle) * ring
          const ringY = anchorPoint.y + Math.sin(angle) * ring * 0.75
          const crowd = entity.herdAnchor !== null
          offer('socialize', weights.social * (needs.social + (crowd ? 0.1 : 0.25)),
            clamp(ringX, 1, world.width - 2), clamp(ringY, 1, world.height - 2))
        }
      }

      // --- wander ----------------------------------------------------------
      if (traits.curious > 0 && needs.hunger < 0.55 && needs.safety < 0.2) {
        const angle = nextRandom(world) * Math.PI * 2
        const reach = genes.vision * (0.5 + traits.curious * 0.6)
        offer('explore', traits.curious * 0.55,
          clamp(entity.x + Math.cos(angle) * reach, 1, world.width - 2),
          clamp(entity.y + Math.sin(angle) * reach, 1, world.height - 2))
      }

      // Distance is a cost, not a blocker: a far meal still beats starving.
      let best = null
      for (const option of options) {
        const distance = Math.hypot(option.x - entity.x, option.y - entity.y)
        const scored = option.score - Math.min(0.45, distance / Math.max(4, genes.vision * 3))
        if (best === null || scored > best.score) best = { ...option, score: scored }
      }
      if (best === null) {
        best = { kind: 'explore', score: 0, x: entity.x, y: entity.y }
      }
      entity.intent = best.kind
      entity.intentScore = best.score
      entity.targetX = best.x
      entity.targetY = best.y
      entity.fleeing = best.kind === 'flee'
      if (entity.fleeing) {
        entity.flightTime = entity.flightTime ?? 0
      } else {
        entity.flightTime = 0
      }
      // Standing still is a behaviour, not a failure: the animal is resting.
      if (best.kind === 'rest') {
        entity.targetX = entity.x
        entity.targetY = entity.y
      }
    }

