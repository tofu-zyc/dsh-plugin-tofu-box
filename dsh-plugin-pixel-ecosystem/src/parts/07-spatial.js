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
     * Where a herd animal drifts when it has nothing better to do: toward the
     * centroid of its neighbours, pushed away from the ones standing on top of
     * it. Returns null when it is alone, so solitary animals keep wandering.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @returns {{x: number, y: number}|null} a target, or null.
     */
    /**
     * Centroid of nearby conspecifics, or null when alone.
     * Used to bias grazing toward the rest of the herd, so a group keeps eating
     * the same patch instead of each animal drifting its own way.
     * @param {object} entity - the animal.
     * @param {object} species - its species row.
     * @param {object} grid - grid of all animals.
     * @returns {{x: number, y: number}|null} centroid or null.
     */
    function herdCentroid(entity, species, grid) {
      const herd = species.herd
      const neighbours = queryNearby(grid, entity.x, entity.y, herd.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species, 8)
      if (neighbours.length === 0) return null
      let sumX = 0
      let sumY = 0
      for (const neighbour of neighbours) { sumX += neighbour.x; sumY += neighbour.y }
      return { x: sumX / neighbours.length, y: sumY / neighbours.length }
    }

    function herdTarget(world, entity, species, grid) {
      const herd = species.herd
      const neighbours = queryNearby(grid, entity.x, entity.y, herd.radius,
        candidate => candidate !== entity && candidate.fate === '' && candidate.species === entity.species)
      if (neighbours.length === 0) return null
      let sumX = 0
      let sumY = 0
      let pushX = 0
      let pushY = 0
      for (const neighbour of neighbours) {
        sumX += neighbour.x
        sumY += neighbour.y
        const dx = entity.x - neighbour.x
        const dy = entity.y - neighbour.y
        const distance = Math.hypot(dx, dy)
        if (distance > 0.01 && distance < herd.separation) {
          pushX += dx / distance
          pushY += dy / distance
        }
      }
      const x = sumX / neighbours.length + pushX * herd.separation * 1.6
      const y = sumY / neighbours.length + pushY * herd.separation * 1.6
      return { x: clamp(x, 1, world.width - 2), y: clamp(y, 1, world.height - 2) }
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
