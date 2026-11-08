    // ---------------------------------------------------------------------
    // Spatial queries
    // ---------------------------------------------------------------------

    /**
     * Bucket entities into a uniform grid for neighbour queries.
     * @param {object} world - the world (grid extent).
     * @param {object[]} list - entities to index.
     * @param {number} cellSize - bucket edge in cells.
     * @returns {{cellSize: number, cols: number, rows: number, buckets: object[][]}} grid.
     */
    function buildGrid(world, list, cellSize) {
      const cols = Math.ceil(world.width / cellSize)
      const rows = Math.ceil(world.height / cellSize)
      const buckets = new Array(cols * rows)
      for (const entity of list) {
        const cx = clamp((entity.x / cellSize) | 0, 0, cols - 1)
        const cy = clamp((entity.y / cellSize) | 0, 0, rows - 1)
        const slot = cy * cols + cx
        const bucket = buckets[slot]
        if (bucket === undefined) buckets[slot] = [entity]
        else bucket.push(entity)
      }
      return { cellSize, cols, rows, buckets }
    }

    /**
     * Nearest entity to a point within a radius.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - search radius in cells.
     * @param {(entity: object) => boolean} [filter] - optional predicate.
     * @returns {object|null} the nearest match.
     */
    function queryNearest(grid, x, y, radius, filter) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      let best = null
      let bestDistance = radius * radius
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (filter !== undefined && !filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            const distance = dx * dx + dy * dy
            if (distance < bestDistance) { bestDistance = distance; best = candidate }
          }
        }
      }
      return best
    }

    /**
     * How many entities matching a predicate sit within a radius.
     * Used for territorial breeding checks, where the nearest match is not the
     * interesting number — the crowd is.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - radius in cells.
     * @param {(entity: object) => boolean} filter - predicate.
     * @returns {number} matching entities in range (excluding nobody).
     */
    function countNearby(grid, x, y, radius, filter) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      const limit = radius * radius
      let count = 0
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (!filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            if (dx * dx + dy * dy <= limit) count += 1
          }
        }
      }
      return count
    }

    /**
     * Entities matching a predicate within a radius, bounded by `limit`.
     * @param {object} grid - grid from `buildGrid`.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - radius in cells.
     * @param {(entity: object) => boolean} filter - predicate.
     * @param {number} [limit] - stop after this many matches.
     * @returns {object[]} matching entities.
     */
    function queryNearby(grid, x, y, radius, filter, limit = 24) {
      const { cellSize, cols, rows, buckets } = grid
      const minCol = clamp(((x - radius) / cellSize) | 0, 0, cols - 1)
      const maxCol = clamp(((x + radius) / cellSize) | 0, 0, cols - 1)
      const minRow = clamp(((y - radius) / cellSize) | 0, 0, rows - 1)
      const maxRow = clamp(((y + radius) / cellSize) | 0, 0, rows - 1)
      const limitSquared = radius * radius
      const found = []
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const bucket = buckets[row * cols + col]
          if (bucket === undefined) continue
          for (let i = 0; i < bucket.length; i++) {
            const candidate = bucket[i]
            if (!filter(candidate)) continue
            const dx = candidate.x - x
            const dy = candidate.y - y
            if (dx * dx + dy * dy > limitSquared) continue
            found.push(candidate)
            if (found.length >= limit) return found
          }
        }
      }
      return found
    }

    /**
     * Quality of a standing crop as the share of a full bite rate.
     *
     * Patch value has to be in the same unit as the intake the animal will
     * actually get, otherwise a decision compares apples to grass. The feeding
     * layer already owns that curve (Holling type II in 11-feed), so this reads
     * it instead of inventing a second one; the fallback is a plain saturation
     * curve for the case where the feeding part is not loaded.
     * @param {number} available - standing crop, kg dry matter/m^2.
     * @returns {number} 0..1 opportunity quality.
     */
    function swardQuality(available) {
      if (!(available > 0)) return 0
      if (typeof grazingIntake === 'function') {
        const ceiling = grazingIntake(1, 1e9)
        if (ceiling > 0) return clamp(grazingIntake(1, available) / ceiling, 0, 1)
      }
      return clamp(available / (0.5 + available), 0, 1)
    }
    /**
     * Scan the neighbourhood for the best edible cell of an animal's flora.
     *
     * The scan is a deterministic lattice walk, not a random sample: every cell
     * inside the search circle at the current stride is looked at, so an animal
     * cannot "miss" a full meadow standing in front of it. The stride coarsens
     * with the radius, which is how a real eye loses detail at the edge of its
     * vision — and it keeps a wide scan cheap enough for a thousand animals.
     * @param {object} world - the world.
     * @param {object} entity - the grazer.
     * @param {object} species - species row.
     * @param {number} hunger - current hunger drive (0..1).
     * @param {number} now - world time.
     * @returns {{x: number, y: number, value: number}|null} best patch centre.
     */
    function scanFlora(world, entity, species, hunger, now) {
      const field = floraField(world, species)
      if (field === null) return null
      const wanted = species.flora === 'grass' ? TERRAIN.GRASS : TERRAIN.WATER
      const reach = clamp(Math.round(entity.genes.vision * (0.4 + hunger * 0.9)), 3, 15)
      const stride = reach > 8 ? 2 : 1
      const originX = entity.x | 0
      const originY = entity.y | 0
      let best = null
      let bestScore = 0.02
      for (let offsetY = -reach; offsetY <= reach; offsetY += stride) {
        const cellY = originY + offsetY
        for (let offsetX = -reach; offsetX <= reach; offsetX += stride) {
          const offset = offsetX * offsetX + offsetY * offsetY
          if (offset > reach * reach) continue
          const cellX = originX + offsetX
          const index = cellIndex(world, cellX, cellY)
          if (index < 0 || world.terrain[index] !== wanted) continue
          const available = field[index]
          // Any standing crop is visible; what differs is what a bite is worth,
          // which is what the functional-response quality below expresses.
          if (available <= 0.004) continue
          // A wader must not aim at water it cannot stand in; a fish never leaves
          // the water, so canStand is the one legality test for both.
          if (!canStand(world, species, cellX + 0.5, cellY + 0.5)) continue
          const distance = Math.sqrt(offset)
          const heat = threatHeat(entity, cellX + 0.5, cellY + 0.5, now)
          const quality = swardQuality(available)
          const score = quality * (1 - heat * 0.6) - distance * 0.014
          if (score > bestScore) {
            bestScore = score
            best = { x: cellX + 0.5, y: cellY + 0.5, value: quality }
          }
        }
      }
      return best
    }

    /**
     * Nearest leafy plant inside a radius. Browsing is the fallback when the
     * ground is bare, so this only runs when the flora scan found little.
     * @param {object} world - the world.
     * @param {object} entity - the deer.
     * @param {number} radius - reach in cells.
     * @param {number} now - world time.
     * @returns {{x: number, y: number, value: number}|null} the plant.
     */
    function scanFoliage(world, entity, radius, now) {
      let best = null
      let bestScore = 0.12
      for (const plant of world.trees) {
        if (plant.variant === 'lily' || plant.variant === 'reed') continue
        const foliage = plant.foliage ?? 0
        if (foliage <= 0.12) continue
        const distance = Math.hypot(plant.x - entity.x, plant.y - entity.y)
        if (distance > radius) continue
        const heat = threatHeat(entity, plant.x, plant.y, now)
        const score = foliage * (1 - heat * 0.6) - distance * 0.014
        if (score > bestScore) { bestScore = score; best = plant }
      }
      return best
    }

    /**
     * Movement multiplier for the current time of day, from the species'
     * activity window (rabbits and deer peak at dawn/dusk; crows roost at night).
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {number} multiplier in roughly 0.1..1.1.
     */
    function activityFactor(world, species) {
      const activity = species.activity
      if (activity === undefined) return 1
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      if (phase >= 0.17 && phase < 0.3) return activity.dawn
      if (phase >= 0.3 && phase < 0.71) return activity.day
      if (phase >= 0.71 && phase < 0.85) return activity.dusk
      return activity.night
    }

    /** Seconds one sighting keeps an animal spooked. */
    const ALARM_SECONDS = 4
    /** Seconds a neighbour stays spooked after hearing an alarm. */
    const ALARM_SHARE = 3

    /**
     * Spread an alarm to nearby conspecifics.
     *
     * One rabbit bolting is a sighting; a whole warren bolting is a stampede.
     * This is what makes a fox's approach read as an event instead of a single
     * unlucky animal twitching.
     * @param {object} entity - the animal that saw the threat.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @param {object} threat - the predator that was seen.
     */
    function spreadAlarm(entity, species, grid, threat, world) {
      const radius = species.herd?.alarmRadius ?? 10
      // Only a couple of puffs per alarm event, or the meadow turns yellow.
      let spreadEffectBudget = 2
      const neighbours = queryNearby(grid, entity.x, entity.y, radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species)
      for (const neighbour of neighbours) {
        if ((neighbour.alarm ?? 0) >= ALARM_SHARE) continue
        neighbour.alarm = ALARM_SHARE
        neighbour.threatX = threat.x
        neighbour.threatY = threat.y
        if (spreadEffectBudget > 0) {
          spawnEffect(world, neighbour.x, neighbour.y - 1, PALETTE.effect.alarm, 0.45, 0.4)
          spreadEffectBudget -= 1
        }
      }
    }

    /**
     * Nearest carcass to a point within a radius.
     * @param {object} world - the world.
     * @param {number} x - query point.
     * @param {number} y - query point.
     * @param {number} radius - search radius in cells.
     * @returns {object|null} the nearest corpse.
     */
    function nearestCorpse(world, x, y, radius) {
      let best = null
      let bestDistance = radius * radius
      for (const corpse of world.corpses) {
        const dx = corpse.x - x
        const dy = corpse.y - y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = corpse }
      }
      return best
    }

    /**
     * Find the animal nearest to a point, for click-to-inspect.
     * @param {object} world - the world.
     * @param {number} x - world position.
     * @param {number} y - world position.
     * @param {number} [radius] - search radius in cells.
     * @returns {object|undefined} the entity.
     */
    function findEntityAt(world, x, y, radius = 2.5) {
      let best
      let bestDistance = radius * radius
      for (const entity of world.entities) {
        const dx = entity.x - x
        const dy = entity.y - y
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { bestDistance = distance; best = entity }
      }
      return best
    }

    /**
     * Look an entity up by id.
     * @param {object} world - the world.
     * @param {number} id - entity id.
     * @returns {object|undefined} the entity.
     */
    function findEntityById(world, id) {
      for (const entity of world.entities) if (entity.id === id) return entity
      return undefined
    }
