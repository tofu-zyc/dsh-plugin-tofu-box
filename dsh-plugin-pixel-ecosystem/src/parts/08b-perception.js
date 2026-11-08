/**
 * Perception and belief: what an animal currently knows about its world.
 *
 * OWNER: behaviour
 *
 * Perception is a real neighbourhood scan on a staggered ~1 Hz schedule, not a
 * handful of random samples. That difference is the whole point of this part:
 * twelve random draws inside eyesight used to miss a meadow that was standing
 * right there, so a hungry animal "saw nothing" and went back to resting. A scan
 * that walks the same cells every time is also reproducible, which keeps the
 * whole simulation deterministic from its seed.
 *
 * Belief is what the animal remembers between scans (docs/20-CORE-LOOP.md 2.3):
 *   belief.food    { x, y, t, value, kind }  best edible patch or prey in sight
 *   belief.carrion { x, y, t, value }        closest corpse in sight
 *   belief.threat  { x, y, t, species }      predator currently in sight
 *   belief.water   { x, y, t }               nearest drinkable water
 *   belief.home    { x, y, t }               last resting site (home range anchor)
 *   belief.caches  [{ x, y, t, energy }]     own food caches (world.caches)
 *   belief.sites   [{ x, y, t, value }]      remembered foraging sites
 *   belief.marks   [{ x, y, t }]             remembered danger spots
 *
 * Every entry carries `t` (world time) so callers can tell a fresh sighting
 * from a memory; stale entries are dropped by trimBelief(). Remembered sites
 * decay and are reinforced by revisits (see rememberFood), which is what makes
 * an animal return to the patch that fed it instead of wandering at random.
 */

    // ---------------------------------------------------------------------
    // Perception and belief
    // ---------------------------------------------------------------------

    /** Channels every belief record carries. */
    const BELIEF_CHANNELS = ['food', 'carrion', 'threat', 'water', 'home', 'caches']

    /** Neighbourhood scans per second per animal (staggered across ticks). */
    const PERCEPTION_HZ = 1

    /** How long one entry stays usable, in seconds. */
    const BELIEF_LIFETIME = {
      food: 35,
      carrion: 25,
      threat: 6,
      water: 70,
      /** Remembered foraging sites outlive a sighting: that is the point. */
      site: 120,
      /** A danger spot keeps steering patch choice for a while. */
      mark: 60,
    }

    /** Remembered foraging sites kept per animal. */
    const MEMORY_SITES = 4
    /** Remembered danger spots kept per animal. */
    const MEMORY_MARKS = 3

    /** How strongly a remembered danger spot spoils a spot's appeal. */
    const THREAT_HEAT_RADIUS = 7

    /**
     * The belief record of an animal, created on first use so restored saves and
     * hand-made test animals both work.
     * @param {object} entity - the animal.
     * @returns {object} mutable belief record.
     */
    function beliefOf(entity) {
      if (entity.belief === undefined) {
        entity.belief = {
          food: null,
          carrion: null,
          threat: null,
          water: null,
          home: null,
          caches: [],
          sites: [],
          marks: [],
        }
      }
      return entity.belief
    }

    /**
     * Whether a belief entry is still fresh enough to act on.
     * @param {{t: number}|null|undefined} entry - belief entry.
     * @param {number} now - world time in seconds.
     * @param {number} lifetime - seconds the entry may age.
     * @returns {boolean} true when the entry can be used.
     */
    function beliefFresh(entry, now, lifetime) {
      return entry !== null && entry !== undefined && now - entry.t <= lifetime
    }

    /**
     * Confidence of a belief entry, decaying linearly to zero at its lifetime.
     * @param {{t: number}|null|undefined} entry - belief entry.
     * @param {number} now - world time in seconds.
     * @param {number} lifetime - seconds of useful life.
     * @returns {number} 0..1 confidence.
     */
    function beliefConfidence(entry, now, lifetime) {
      if (entry === null || entry === undefined) return 0
      const age = now - entry.t
      if (age <= 0) return 1
      return clamp(1 - age / lifetime, 0, 1)
    }

    /**
     * Remember a foraging site, or reinforce one the animal already knows.
     *
     * Reinforcement is why memory is worth having: a patch that fed the animal
     * grows in its estimate, a patch it merely walked past does not. The oldest
     * sites fade so a moved patch is eventually forgotten.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} value - food quality found there (0..1+).
     * @param {number} now - world time.
     * @returns {void}
     */
    function rememberFood(entity, x, y, value, now) {
      const belief = beliefOf(entity)
      const sites = belief.sites
      let nearest = null
      let nearestDistance = 36
      for (const site of sites) {
        const distance = (site.x - x) * (site.x - x) + (site.y - y) * (site.y - y)
        if (distance < nearestDistance) { nearestDistance = distance; nearest = site }
      }
      if (nearest !== null) {
        // Revisiting a known site is evidence: raise its weight rather than
        // replacing it, so a good patch keeps winning over a lucky sample.
        nearest.x = x
        nearest.y = y
        nearest.t = now
        nearest.value = clamp(nearest.value * 0.55 + value * 0.65, 0, 1.6)
        return
      }
      sites.push({ x, y, t: now, value: clamp(value, 0, 1.6) })
      if (sites.length > MEMORY_SITES) {
        let worst = 0
        for (let index = 1; index < sites.length; index++) {
          const spent = sites[index].value - (now - sites[index].t) / BELIEF_LIFETIME.site
          const worstSpent = sites[worst].value - (now - sites[worst].t) / BELIEF_LIFETIME.site
          if (spent < worstSpent) worst = index
        }
        sites.splice(worst, 1)
      }
    }

    /**
     * Remember a danger spot, so patch choice keeps steering around it.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} now - world time.
     * @returns {void}
     */
    function rememberThreat(entity, x, y, now) {
      const belief = beliefOf(entity)
      const marks = belief.marks
      let nearest = null
      let nearestDistance = 25
      for (const mark of marks) {
        const distance = (mark.x - x) * (mark.x - x) + (mark.y - y) * (mark.y - y)
        if (distance < nearestDistance) { nearestDistance = distance; nearest = mark }
      }
      if (nearest !== null) { nearest.x = x; nearest.y = y; nearest.t = now; return }
      marks.push({ x, y, t: now })
      if (marks.length > MEMORY_MARKS) marks.shift()
    }

    /**
     * How dangerous a spot feels, from remembered danger recent enough to matter.
     * @param {object} entity - the animal.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} now - world time.
     * @returns {number} 0 (safe) .. 1 (just escaped from there).
     */
    function threatHeat(entity, x, y, now) {
      const belief = beliefOf(entity)
      let heat = 0
      for (const mark of belief.marks) {
        const confidence = beliefConfidence(mark, now, BELIEF_LIFETIME.mark)
        if (confidence <= 0) continue
        const distance = Math.hypot(mark.x - x, mark.y - y)
        if (distance > THREAT_HEAT_RADIUS) continue
        const near = 1 - distance / THREAT_HEAT_RADIUS
        heat = Math.max(heat, confidence * near)
      }
      return heat
    }

    /**
     * Best remembered foraging site still worth walking to.
     * @param {object} entity - the animal.
     * @param {number} now - world time.
     * @returns {{x: number, y: number, t: number, value: number}|null} the site.
     */
    function recallFood(entity, now) {
      const belief = beliefOf(entity)
      let best = null
      let bestScore = 0.04
      for (const site of belief.sites) {
        const confidence = beliefConfidence(site, now, BELIEF_LIFETIME.site)
        if (confidence <= 0) continue
        const score = site.value * confidence - threatHeat(entity, site.x, site.y, now) * 0.4
        if (score > bestScore) { bestScore = score; best = site }
      }
      return best
    }

    /**
     * Drop beliefs that have gone stale, so nothing acts on a week-old sighting.
     * @param {object} entity - the animal.
     * @param {number} now - world time.
     * @returns {void}
     */
    function trimBelief(entity, now) {
      const belief = beliefOf(entity)
      for (const channel of ['food', 'carrion', 'water']) {
        if (!beliefFresh(belief[channel], now, BELIEF_LIFETIME[channel])) belief[channel] = null
      }
      if (!beliefFresh(belief.threat, now, BELIEF_LIFETIME.threat)) belief.threat = null
      let write = 0
      for (let index = 0; index < belief.sites.length; index++) {
        const site = belief.sites[index]
        if (!beliefFresh(site, now, BELIEF_LIFETIME.site)) continue
        belief.sites[write++] = site
      }
      belief.sites.length = write
      write = 0
      for (let index = 0; index < belief.marks.length; index++) {
        const mark = belief.marks[index]
        if (!beliefFresh(mark, now, BELIEF_LIFETIME.mark)) continue
        belief.marks[write++] = mark
      }
      belief.marks.length = write
    }

    /**
     * Scan for the nearest corpse (food for a hunter, a meal for a scavenger).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} radius - reach in cells.
     * @returns {object|null} the corpse.
     */
    function scanCarrion(world, entity, radius) {
      const corpse = nearestCorpse(world, entity.x, entity.y, radius)
      if (corpse === null) return null
      return { x: corpse.x, y: corpse.y, value: clamp((corpse.energy ?? 20) / 40, 0.2, 1.2) }
    }

    /**
     * One perception pass: refresh every belief channel this species cares about.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @returns {void}
     */
    function perceiveNow(world, entity, species, grids) {
      const belief = beliefOf(entity)
      const now = world.time
      const genes = entity.genes
      if (belief.home === null) belief.home = { x: entity.x, y: entity.y, t: now }

      // --- danger: the highest-priority channel -----------------------------
      const predators = PREDATORS_OF[entity.species]
      if (predators !== undefined && predators.size > 0) {
        const sighted = queryNearest(grids.hunter, entity.x, entity.y, genes.vision,
          candidate => candidate.fate === '' && predators.has(candidate.species))
        if (sighted !== null) {
          belief.threat = { x: sighted.x, y: sighted.y, t: now, species: sighted.species }
          entity.alarm = ALARM_SECONDS
          entity.threatX = sighted.x
          entity.threatY = sighted.y
          rememberThreat(entity, sighted.x, sighted.y, now)
          // A whole warren bolting reads as an event; one rabbit twitching does not.
          spreadAlarm(entity, species, grids.prey, sighted, world)
        }
      }

      // --- food -------------------------------------------------------------
      const hunger = entity.drives === undefined ? 0.3 : entity.drives.hunger
      if (species.role === 'grazer') {
        const patch = scanFlora(world, entity, species, hunger, now)
        if (patch !== null) {
          belief.food = { x: patch.x, y: patch.y, t: now, value: patch.value, kind: 'flora' }
          rememberFood(entity, patch.x, patch.y, patch.value, now)
        } else if (species.browse === true) {
          const plant = scanFoliage(world, entity, genes.vision, now)
          if (plant !== null) {
            belief.food = { x: plant.x, y: plant.y, t: now, value: (plant.foliage ?? 0) * 0.8, kind: 'foliage' }
          } else {
            belief.food = null
          }
        } else {
          belief.food = null
        }
        // Nothing in sight: fall back on a remembered patch, which is what lets
        // an animal cross bare ground with a purpose instead of grazing at random.
        if (belief.food === null) {
          const recalled = recallFood(entity, now)
          if (recalled !== null) {
            belief.food = { x: recalled.x, y: recalled.y, t: now, value: recalled.value, kind: 'memory' }
          }
        }
      } else {
        // A hunter looks for the nearest animal it is allowed to eat; a
        // scavenger only ever looks for carrion, so it must not run the prey
        // query at all (its species row has no prey table).
        const carrion = scanCarrion(world, entity, genes.vision * (species.role === 'hunter' ? 1.7 : 1.9))
        belief.carrion = carrion === null ? null : { x: carrion.x, y: carrion.y, t: now, value: carrion.value }
        const prey = species.role === 'hunter'
          ? nearestPrey(entity, species, grids.prey, genes.vision * (species.huntReach ?? 1.6))
          : null
        if (prey !== null) {
          belief.food = { x: prey.x, y: prey.y, t: now, value: 0.9, kind: 'prey', speciesId: prey.species }
        } else {
          belief.food = null
        }
      }

      // --- water: only worth looking for once the animal is actually dry -----
      if (species.habitat !== 'water' && entity.drives !== undefined && entity.drives.thirst > 0.12) {
        const water = nearestWater(world, entity.x, entity.y, genes.vision)
        if (water !== null) belief.water = { x: water.x + 0.5, y: water.y + 0.5, t: now }
      }

      // --- company: a herd is a place as much as a crowd ---------------------
      entity.socialCount = 0
      entity.herdAnchor = null
      if (species.herd !== undefined) {
        const kin = species.role === 'hunter' ? grids.hunter : grids.prey
        const neighbours = queryNearby(kin, entity.x, entity.y, species.herd.radius,
          candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species, 12)
        entity.socialCount = neighbours.length
        if (neighbours.length > 0) {
          let sumX = 0
          let sumY = 0
          for (const neighbour of neighbours) { sumX += neighbour.x; sumY += neighbour.y }
          entity.herdAnchor = { x: sumX / neighbours.length, y: sumY / neighbours.length }
        }
      }

      // --- own caches (P5): read-only until the sim-core side fills them -----
      const caches = world.caches
      if (Array.isArray(caches) && caches.length > 0) {
        belief.caches.length = 0
        for (const cache of caches) {
          if (cache.owner !== entity.id) continue
          belief.caches.push({ x: cache.x, y: cache.y, t: now, energy: cache.energy ?? 0 })
        }
      }

      trimBelief(entity, now)
    }

    /**
     * Advance the perception clock; scans when this animal's ~1 Hz slot lands.
     *
     * The first slot is staggered per animal from the world RNG, so a herd does
     * not all scan (and all decide) on the same tick: that staggering is what
     * keeps a thousand animals affordable and stops the whole meadow from
     * twitching in lockstep.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} grids - spatial grids for prey/hunters.
     * @param {number} dt - step in seconds.
     * @returns {void}
     */
    function perceive(world, entity, species, grids, dt) {
      if (entity.perceiveTimer === undefined) entity.perceiveTimer = randomBetween(world, 0, 1 / PERCEPTION_HZ)
      entity.perceiveTimer -= dt
      if (entity.perceiveTimer > 0) return
      entity.perceiveTimer = (0.85 + randomBetween(world, 0, 0.3)) / PERCEPTION_HZ
      perceiveNow(world, entity, species, grids)
    }
