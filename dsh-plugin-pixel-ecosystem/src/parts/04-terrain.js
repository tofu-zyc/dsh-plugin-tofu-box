    // ---------------------------------------------------------------------
    // Terrain and hydrology
    // ---------------------------------------------------------------------

    /**
     * Build one octave of bilinear value noise over the world.
     * @param {object} world - the world (RNG source).
     * @param {number} cellSize - lattice spacing in cells.
     * @returns {(x: number, y: number) => number} sampler in [0, 1].
     */
    function createNoise(world, cellSize) {
      const cols = Math.ceil(world.width / cellSize) + 2
      const rows = Math.ceil(world.height / cellSize) + 2
      const lattice = new Float32Array(cols * rows)
      for (let i = 0; i < lattice.length; i++) lattice[i] = nextRandom(world)
      return (x, y) => {
        const fx = x / cellSize
        const fy = y / cellSize
        // Indices are clamped, not trusted: a caller may sample outside the
        // lattice (an offset coordinate, a brush near the edge) and an undefined
        // lattice read makes a whole field NaN silently. That is exactly the bug
        // that turned 58 water cells into NaN and poisoned the energy book.
        const x0 = Math.min(cols - 2, Math.max(0, fx | 0))
        const y0 = Math.min(rows - 2, Math.max(0, fy | 0))
        const tx = smooth(fx - x0)
        const ty = smooth(fy - y0)
        const i0 = y0 * cols + x0
        const i1 = i0 + cols
        return mix(mix(lattice[i0], lattice[i0 + 1], tx), mix(lattice[i1], lattice[i1 + 1], tx), ty)
      }
    }

    /**
     * Fill `moisture` (and optionally `waterFertility`) from the terrain alone.
     *
     * Called at creation and again after a load, because neither array carries
     * gameplay state: distance-to-water plus a positional hash reproduces them
     * exactly, which keeps saves small. After the player reshapes the land only
     * moisture is refreshed, so nutrients built up by rotting carcasses survive.
     * @param {object} world - the world; `terrain` must already be filled.
     * @param {boolean} [includeWaterFertility] - refresh the water nutrient field too.
     */
    function computeHydrology(world, includeWaterFertility = true) {
      const width = world.width
      const height = world.height
      const size = width * height
      const distance = new Int32Array(size).fill(1e9)
      const queue = new Int32Array(size)
      let head = 0
      let tail = 0
      for (let i = 0; i < size; i++) {
        if (world.terrain[i] === TERRAIN.WATER) { distance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = distance[index] + 1
        if (x > 0 && distance[index - 1] > next) { distance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && distance[index + 1] > next) { distance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && distance[index - width] > next) { distance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && distance[index + width] > next) { distance[index + width] = next; queue[tail++] = index + width }
      }
      // Second pass the other way: how far a water cell is from the bank. This
      // is the lake's depth, and it drives both the wading rule and the water
      // shading, so it has to be refreshed with the rest of the hydrology.
      const depthDistance = new Int32Array(size).fill(1e9)
      head = 0
      tail = 0
      for (let i = 0; i < size; i++) {
        if (world.terrain[i] !== TERRAIN.WATER) { depthDistance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = depthDistance[index] + 1
        if (x > 0 && depthDistance[index - 1] > next) { depthDistance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && depthDistance[index + 1] > next) { depthDistance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && depthDistance[index - width] > next) { depthDistance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && depthDistance[index + width] > next) { depthDistance[index + width] = next; queue[tail++] = index + width }
      }
      const depth = world.depth !== undefined && world.depth.length === size ? world.depth : new Float32Array(size)
      for (let i = 0; i < size; i++) {
        depth[i] = world.terrain[i] === TERRAIN.WATER ? clamp(depthDistance[i] / 16, 0, 1) : 0
      }
      world.depth = depth
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          const near = clamp(1 - distance[i] / 30, 0, 1)
          world.moisture[i] = clamp(near * 0.82 + hash2(x, y, world.seed) * 0.18, 0, 1)
          if (includeWaterFertility) {
            // Shallow water is richer than the middle of the lake: weeds prefer it.
            world.waterFertility[i] = clamp(0.35 + near * 0.55 + hash2(x + 91, y + 17, world.seed) * 0.2, 0, 1)
          }
        }
      }
    }

    /**
     * Base fertility of one cell, from terrain and hydrology.
     * @param {object} world - the world.
     * @param {number} index - cell index.
     * @returns {number} 0..1.
     */
    function baseFertility(world, index) {
      const terrain = world.terrain[index]
      if (terrain === TERRAIN.STONE || terrain === TERRAIN.WATER) return 0
      if (terrain === TERRAIN.SAND) return 0.18
      const x = index % world.width
      const y = (index / world.width) | 0
      const base = terrain === TERRAIN.DIRT ? 0.42 : 0.5
      return clamp(base + world.moisture[index] * 0.42 + hash2(x + 7, y + 3, world.seed) * 0.12, 0, 1)
    }

    /**
     * 3×3 box blur over a height field, edge-clamped.
     *
     * Raw multi-octave noise thresholds into a speckled archipelago; one or two
     * passes of this turn it into shorelines. The shape survives, the confetti
     * does not.
     * @param {object} world - the world (for its size).
     * @param {Float32Array} field - source heights.
     * @returns {Float32Array} blurred heights.
     */
    function boxBlur(world, field) {
      const width = world.width
      const height = world.height
      const out = new Float32Array(field.length)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0
          let count = 0
          for (let dy = -1; dy <= 1; dy++) {
            const ny = clamp(y + dy, 0, height - 1)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = clamp(x + dx, 0, width - 1)
              sum += field[ny * width + nx]
              count += 1
            }
          }
          out[y * width + x] = sum / count
        }
      }
      return out
    }

    /**
     * Keep only the largest connected water bodies.
     *
     * A percentile sea level guarantees the right *amount* of water but not the
     * right *shape*: it scatters dozens of puddles. Knowing which puddles are
     * actually one lake makes the difference between a meadow with a lake and a
     * field of water stains.
     * @param {object} world - the world (for its size).
     * @param {Uint8Array} mask - 1 where the cell is a candidate water cell.
     * @param {number} share - fraction of candidate area to keep, largest first.
     * @returns {Uint8Array} 1 where the cell belongs to a kept body.
     */
    function keepLargestWaterBodies(world, mask, share) {
      const width = world.width
      const height = world.height
      const size = mask.length
      const labels = new Int32Array(size).fill(-1)
      const sizes = []
      const queue = new Int32Array(size)
      for (let start = 0; start < size; start++) {
        if (mask[start] !== 1 || labels[start] !== -1) continue
        const label = sizes.length
        let head = 0
        let tail = 0
        queue[tail++] = start
        labels[start] = label
        let count = 0
        while (head < tail) {
          const index = queue[head++]
          count += 1
          const x = index % width
          const y = (index / width) | 0
          if (x > 0 && mask[index - 1] === 1 && labels[index - 1] === -1) { labels[index - 1] = label; queue[tail++] = index - 1 }
          if (x < width - 1 && mask[index + 1] === 1 && labels[index + 1] === -1) { labels[index + 1] = label; queue[tail++] = index + 1 }
          if (y > 0 && mask[index - width] === 1 && labels[index - width] === -1) { labels[index - width] = label; queue[tail++] = index - width }
          if (y < height - 1 && mask[index + width] === 1 && labels[index + width] === -1) { labels[index + width] = label; queue[tail++] = index + width }
        }
        sizes.push(count)
      }
      const total = sizes.reduce((sum, value) => sum + value, 0)
      const order = sizes.map((size, label) => ({ label, size })).sort((a, b) => b.size - a.size)
      const kept = new Set()
      let running = 0
      for (const body of order) {
        if (running >= total * share && kept.size > 0) break
        kept.add(body.label)
        running += body.size
      }
      const keep = new Uint8Array(size)
      for (let i = 0; i < size; i++) keep[i] = labels[i] >= 0 && kept.has(labels[i]) ? 1 : 0
      return keep
    }

    /**
     * Fill `terrain` from the world seed.
     *
     * Large octaves give one continent, a blur pass kills speckle, and only the
     * biggest water bodies survive, so the default world reads as meadow + lake
     * rather than confetti. Sand hugs the shoreline (not a noise band), soil
     * appears in coherent dry patches, and rock only on the highest ridges.
     * @param {object} world - the world to fill.
     */
    function generateTerrain(world) {
      const width = world.width
      const height = world.height
      const size = width * height
      const octaves = [[56, 0.52], [28, 0.3], [13, 0.18]]
      const samplers = octaves.map(([cellSize]) => createNoise(world, cellSize))
      let field = new Float32Array(size)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = 0
          for (let o = 0; o < octaves.length; o++) value += octaves[o][1] * samplers[o](x, y)
          field[y * width + x] = value
        }
      }
      field = boxBlur(world, boxBlur(world, field))
      const sorted = Float32Array.from(field).sort()
      const waterLevel = sorted[Math.floor(size * 0.2)]
      const rockLevel = sorted[Math.floor(size * 0.99)]

      const candidate = new Uint8Array(size)
      for (let i = 0; i < size; i++) candidate[i] = field[i] <= waterLevel ? 1 : 0
      const water = keepLargestWaterBodies(world, candidate, 0.88)

      // Distance to the shoreline drives sand, soil and fertility.
      const distance = new Int32Array(size).fill(1e9)
      const queue = new Int32Array(size)
      let head = 0
      let tail = 0
      for (let i = 0; i < size; i++) {
        if (water[i] === 1) { distance[i] = 0; queue[tail++] = i }
      }
      while (head < tail) {
        const index = queue[head++]
        const x = index % width
        const y = (index / width) | 0
        const next = distance[index] + 1
        if (x > 0 && distance[index - 1] > next) { distance[index - 1] = next; queue[tail++] = index - 1 }
        if (x < width - 1 && distance[index + 1] > next) { distance[index + 1] = next; queue[tail++] = index + 1 }
        if (y > 0 && distance[index - width] > next) { distance[index - width] = next; queue[tail++] = index - width }
        if (y < height - 1 && distance[index + width] > next) { distance[index + width] = next; queue[tail++] = index + width }
      }

      const soilNoise = createNoise(world, 17)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          if (water[i] === 1) { world.terrain[i] = TERRAIN.WATER; continue }
          const shore = distance[i]
          if (shore <= 2) { world.terrain[i] = TERRAIN.SAND; continue }
          if (field[i] >= rockLevel) { world.terrain[i] = TERRAIN.STONE; continue }
          // Far from water is drier ground: coherent soil patches, not speckle.
          const dryness = clamp((shore - 14) / 26, 0, 1)
          world.terrain[i] = soilNoise(x, y) > 0.66 + dryness * 0.16 ? TERRAIN.DIRT : TERRAIN.GRASS
        }
      }
    }

    /**
     * Seed the two producer fields, in kg of dry matter per square metre.
     *
     * The starting sward is NOT uniform. A 26-cell value-noise field decides how
     * rank the meadow is from place to place, and soil moisture and nutrient build
     * on top of it. That matters for gameplay, not for looks: an animal's eyesight
     * is 5-26 cells, so a patch has to be about that wide before it can be seen
     * and walked to. A uniform field is a field with nowhere to go.
     * @param {object} world - the world.
     */
    function seedProducers(world) {
      const size = world.width * world.height
      const patch = createNoise(world, 26)
      const grain = createNoise(world, 7)
      for (let i = 0; i < size; i++) {
        const terrain = world.terrain[i]
        world.fertility[i] = baseFertility(world, i)
        if (terrain === TERRAIN.GRASS) {
          const x = i % world.width
          const y = (i / world.width) | 0
          const rank = 0.35 + 0.55 * patch(x, y) + 0.12 * grain(x, y)
          const wet = 0.5 + 0.5 * world.moisture[i]
          const soil = 0.45 + 0.55 * world.fertility[i]
          world.grass[i] = clamp(PRODUCERS.grass.bmax * rank * wet * soil, 0, PRODUCERS.grass.bmax)
          // A fresh world is not a sterile one: the detritus layer a meadow
          // carries between seasons is what recycles its nutrients, so it starts
          // at the steady state of its own litter fall instead of at zero (which
          // would mine the soil for the first days of the world).
          world.detritus[i] = world.grass[i] * 0.25
        } else if (terrain === TERRAIN.WATER) {
          const x = i % world.width
          const y = (i / world.width) | 0
          const rank = 0.3 + 0.5 * patch((x + 17) % world.width, (y + 29) % world.height)
          const soil = 0.4 + 0.6 * world.waterFertility[i]
          // The lake starts the way a lake looks: a weed fringe in the shallows
          // and open water past the light limit. Seeding it uniformly would give
          // the player a green carpet on the first frame and then a two-day
          // die-back, which reads as a bug rather than as a lake.
          const depth = world.depth[i]
          const suitable = clamp(1 - (depth - DEPTH_WEED_START) / (DEPTH_WEED_LIMIT - DEPTH_WEED_START), 0, 1)
          world.weed[i] = clamp(PRODUCERS.weed.bmax * rank * soil * suitable, 0, PRODUCERS.weed.bmax)
          world.detritus[i] = world.weed[i] * 0.25
        }
      }
    }
