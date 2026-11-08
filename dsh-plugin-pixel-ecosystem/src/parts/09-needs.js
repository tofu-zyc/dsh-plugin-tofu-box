    // ---------------------------------------------------------------------
    // Needs, temperament and life stages
    // ---------------------------------------------------------------------
    //
    // Every animal carries five need channels (0 = satisfied, 1 = critical) and
    // picks an intention by scoring candidate actions against them. Behaviour is
    // therefore data, not an if-chain: a new species only needs a role and a few
    // trait numbers, and later systems (settlements, trade, war) can read the
    // same intent field instead of guessing what an animal is doing.

    /** Need channels every animal has. */
    const NEED_KEYS = ['hunger', 'thirst', 'energy', 'safety', 'social']

    /** Temperament defaults by feeding role; a species row may override `traits`. */
    const ROLE_TRAITS = {
      grazer: { bold: 0.35, social: 0.8, curious: 0.45, territorial: 0.25 },
      hunter: { bold: 0.85, social: 0.5, curious: 0.7, territorial: 0.8 },
      scavenger: { bold: 0.6, social: 0.75, curious: 0.95, territorial: 0.2 },
    }

    /** How loud each need is, per role: a rabbit values safety over food. */
    const NEED_WEIGHT = {
      grazer: { hunger: 1.2, thirst: 0.75, energy: 0.75, safety: 2.6, social: 0.35 },
      hunter: { hunger: 1.55, thirst: 0.8, energy: 0.85, safety: 1.7, social: 0.35 },
      scavenger: { hunger: 1.35, thirst: 0.85, energy: 0.6, safety: 1.2, social: 0.6 },
    }

    /** Size, speed and appetite multipliers per life stage. */
    const STAGE_SCALE = { juvenile: 0.6, adult: 1, elder: 1.03 }
    const STAGE_SPEED = { juvenile: 0.78, adult: 1, elder: 0.82 }
    const STAGE_APPETITE = { juvenile: 1.3, adult: 1, elder: 0.85 }

    /** Intent ids; the UI translates them, nothing else enumerates them. */
    const INTENT_IDS = ['flee', 'forage', 'hunt', 'scavenge', 'drink', 'rest', 'socialize', 'explore']

    /**
     * Temperament for a species (row override, else role default).
     * @param {object} species - species row.
     * @returns {object} trait record.
     */
    function traitsOf(species) {
      return species.traits ?? ROLE_TRAITS[species.role] ?? ROLE_TRAITS.grazer
    }

    /**
     * The need record of an entity, created on first use so restored saves work.
     * @param {object} entity - the animal.
     * @returns {object} mutable needs.
     */
    function needsOf(entity) {
      if (entity.needs === undefined) {
        entity.needs = { hunger: 0.32, thirst: 0.28, energy: 0.15, safety: 0, social: 0.3 }
      }
      return entity.needs
    }

    /**
     * Life stage from age: juveniles are smaller, slower and cannot breed.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {'juvenile'|'adult'|'elder'} stage.
     */
    function stageOf(entity, species) {
      const maturity = species.balance.maturity
      const elder = species.balance.elderAt ?? maturity * 2.6
      if (entity.age < maturity) return 'juvenile'
      if (entity.age > elder) return 'elder'
      return 'adult'
    }

    /**
     * Grow every need channel for one tick.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     */
    function decayNeeds(world, entity, species, dt) {
      const needs = needsOf(entity)
      const stage = stageOf(entity, species)
      const appetite = STAGE_APPETITE[stage] * entity.genes.metabolism
      const night = daylight(world) < 0.3
      needs.hunger = clamp(needs.hunger + 0.0105 * appetite * dt, 0, 1)
      needs.thirst = clamp(needs.thirst + 0.0082 * appetite * dt, 0, 1)
      needs.energy = clamp(needs.energy + 0.0068 * (night ? 1.7 : 0.85) * dt, 0, 1)
      needs.social = clamp(needs.social + 0.006 * traitsOf(species).social * dt, 0, 1)
      needs.safety = clamp(needs.safety - 0.3 * dt, 0, 1)
    }

    /**
     * Nearest reachable water cell, for drinking.
     * @param {object} world - the world.
     * @param {number} x - origin column.
     * @param {number} y - origin row.
     * @param {number} radius - search radius in cells.
     * @returns {{x: number, y: number}|null} water cell.
     */
    function nearestWater(world, x, y, radius) {
      const reach = Math.max(2, Math.round(radius))
      let best = null
      let bestDistance = Infinity
      for (let step = 1; step <= reach; step += 1) {
        const samples = step * 8
        for (let index = 0; index < samples; index += 1) {
          const angle = (index / samples) * Math.PI * 2
          const cellX = Math.round(x + Math.cos(angle) * step)
          const cellY = Math.round(y + Math.sin(angle) * step)
          if (cellX < 0 || cellY < 0 || cellX >= world.width || cellY >= world.height) continue
          if (world.terrain[cellY * world.width + cellX] !== TERRAIN.WATER) continue
          const distance = step
          if (distance < bestDistance) {
            bestDistance = distance
            best = { x: cellX, y: cellY }
          }
        }
        if (best !== null) return best
      }
      return best
    }
