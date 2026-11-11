    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /**
     * Clamp a number into an inclusive range.
     * @param {number} value - input.
     * @param {number} lo - lower bound.
     * @param {number} hi - upper bound.
     * @returns {number} clamped value.
     */
    function clamp(value, lo, hi) {
      return value < lo ? lo : value > hi ? hi : value
    }

    /**
     * Linear interpolation.
     * @param {number} a - value at t = 0.
     * @param {number} b - value at t = 1.
     * @param {number} t - progress.
     * @returns {number} interpolated value.
     */
    function mix(a, b, t) {
      return a + (b - a) * t
    }

    /**
     * Smoothstep, for value-noise interpolation.
     * @param {number} t - 0..1.
     * @returns {number} eased 0..1.
     */
    function smooth(t) {
      return t * t * (3 - 2 * t)
    }

    /**
     * Deterministic 2D hash in [0, 1): hydrology and texture noise that must be
     * reproducible from the terrain alone (no RNG stream position).
     * @param {number} x - column.
     * @param {number} y - row.
     * @param {number} seed - world seed.
     * @returns {number} hash value.
     */
    function hash2(x, y, seed) {
      let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2654435761)) >>> 0
      n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296
    }

    /**
     * Advance the world's 32-bit LCG and return a number in [0, 1).
     * @param {object} world - the world owning the stream.
     * @returns {number} pseudo-random number.
     */
    function nextRandom(world) {
      world.rngState = (Math.imul(world.rngState, 1664525) + 1013904223) >>> 0
      return world.rngState / 4294967296
    }

    /**
     * Pseudo-random number in [lo, hi).
     * @param {object} world - the world owning the stream.
     * @param {number} lo - lower bound.
     * @param {number} hi - upper bound.
     * @returns {number} random value.
     */
    function randomBetween(world, lo, hi) {
      return lo + (hi - lo) * nextRandom(world)
    }

    /**
     * Cell index for a coordinate pair, or -1 when outside the grid.
     * @param {object} world - the world.
     * @param {number} x - cell column.
     * @param {number} y - cell row.
     * @returns {number} index or -1.
     */
    function cellIndex(world, x, y) {
      const cx = x | 0
      const cy = y | 0
      if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return -1
      return cy * world.width + cx
    }

    /**
     * Terrain code at a fractional world position, or -1 outside the grid.
     * @param {object} world - the world.
     * @param {number} x - fractional column.
     * @param {number} y - fractional row.
     * @returns {number} terrain code or -1.
     */
    function terrainAt(world, x, y) {
      const index = cellIndex(world, x, y)
      return index < 0 ? -1 : world.terrain[index]
    }

    /**
     * Whether one species may occupy a fractional position.
     * Land animals avoid water and rock, fish stay in water, birds ignore terrain.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @param {number} x - fractional column.
     * @param {number} y - fractional row.
     * @returns {boolean} true when the position is valid for that species.
     */
    function canStand(world, species, x, y) {
      const terrain = terrainAt(world, x, y)
      if (terrain < 0) return false
      if (species.habitat === 'air') return true
      if (species.habitat === 'water') {
        if (terrain === TERRAIN.WATER) return true
        // An amphibious water animal may haul out on land to rest and to breed.
        return species.amphibious === true && terrain !== TERRAIN.STONE
      }
      if (terrain === TERRAIN.STONE) return false
      if (terrain !== TERRAIN.WATER) return true
      // Waders stand in the shallows only: depth is distance from the bank, so
      // this keeps a heron or a bear at the edge instead of walking the lake bed.
      if (species.wade !== true) return false
      const column = Math.max(0, Math.min(world.width - 1, Math.round(x)))
      const row = Math.max(0, Math.min(world.height - 1, Math.round(y)))
      return world.depth[row * world.width + column] < 0.34
    }

    /**
     * The biomass field a grazer eats (or `null`).
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {Float32Array|null} field.
     */
    function floraField(world, species) {
      if (species.flora === 'grass') return world.grass
      if (species.flora === 'weed') return world.weed
      return null
    }

    /**
     * Daylight factor for the current world time: 0 at night, 1 at noon.
     * @param {object} world - the world.
     * @returns {number} 0..1.
     */
    function daylight(world) {
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      const sun = (phase - 0.22) / 0.56
      if (sun <= 0 || sun >= 1) return 0.12
      return 0.12 + 0.88 * Math.sin(Math.PI * sun)
    }
