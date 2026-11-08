    // ---------------------------------------------------------------------
    // Viewport renderer
    // ---------------------------------------------------------------------
    //
    // Two consumers share this part: `paintView` fills a 1-px-per-cell ARGB
    // buffer (the low-zoom path, the tests, one-shot captures) and `paintWorld`
    // is that buffer over the whole map. At 1024x640 that is 655,360 cells per
    // frame, so the ground pass is written as table lookups: the season decides
    // the tables once, and the per-cell loop does no colour maths it can avoid.
    // docs/70-VISUAL.md carries the measured numbers.

    /**
     * The frame set one animal plays this tick.
     *
     * The pose table (18-sprites) owns the state→pose decision; this only reads
     * the plan back: hold a frame when the pose is paused, otherwise cycle the
     * walk frames by time, and use the single flattened flee frame for a run.
     * @param {object} entity - the animal.
     * @param {number} tick - world tick (drives the walk cycle).
     * @returns {object} compiled sprite.
     */
    function frameFor(entity, tick) {
      const set = SPRITES[entity.species]
      if (set === undefined) return null
      const pose = poseFor(entity)
      const role = poseRole(entity, pose)
      if (role === 'run') return set.flee
      if (role === 'walk') {
        if (pose.pause === true) return set.walk[0]
        const phase = Math.floor(tick / 2 * pose.speed + (entity.phase ?? 0) * 4) % set.walk.length
        return set.walk[phase]
      }
      return set.idle
    }

    /**
     * Paint one sprite, clipped to the buffer.
     *
     * The optional pose applies three cheap transforms that need no canvas: a
     * vertical squash, a settle into the ground, and a per-row shear for the
     * lean. They are what let two idle frames express a crouch, a sleep or a
     * stalk at 1 px per cell.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} width - buffer width.
     * @param {number} height - buffer height.
     * @param {object} sprite - compiled sprite.
     * @param {number} left - buffer column of the sprite's left edge.
     * @param {number} top - buffer row of the sprite's top edge.
     * @param {boolean} flip - mirror horizontally.
     * @param {number} [factor] - brightness multiplier.
     * @param {object} [pose] - normalised pose (identity when omitted).
     */
    function drawSprite(out, width, height, sprite, left, top, flip, factor, pose) {
      const spriteWidth = sprite.width
      const squash = pose === undefined ? 1 : pose.squash
      const sink = pose === undefined ? 0 : pose.sink
      const shear = pose === undefined ? 0 : pose.tilt / 14
      const middle = (sprite.height - 1) / 2
      for (let y = 0; y < sprite.height; y++) {
        const targetY = top + Math.floor(y * squash + sink)
        if (targetY < 0 || targetY >= height) continue
        const rowBase = y * spriteWidth
        const targetBase = targetY * width
        const shift = shear === 0 ? 0 : Math.round(shear * (y - middle))
        for (let x = 0; x < spriteWidth; x++) {
          const color = sprite.pixels[rowBase + (flip ? spriteWidth - 1 - x : x)]
          if (color === 0) continue
          const targetX = left + x + shift
          if (targetX < 0 || targetX >= width) continue
          out[targetBase + targetX] = factor === undefined ? color : dimColor(color, factor)
        }
      }
    }

    // ---------------------------------------------------------------------
    // Ground tables
    // ---------------------------------------------------------------------

    /**
     * Grass colour table: 8 cover steps x 32 brightness deltas.
     *
     * The old per-cell path ran `nudgeColor` (three clamps and a repack) on
     * every one of 655k cells; a lookup is roughly a quarter of the cost and the
     * output is identical.
     */
    const GRASS_LUT = new Int32Array(8 * 32)
    const grassLutState = { key: -1 }

    /**
     * Fill the grass table for one seasonal look.
     * @param {object} look - seasonal look.
     * @returns {Int32Array} the shared table.
     */
    function grassLutFor(look) {
      if (grassLutState.key === look.key) return GRASS_LUT
      for (let step = 0; step < 8; step++) {
        for (let delta = 0; delta < 32; delta++) {
          GRASS_LUT[(step << 5) | delta] = nudgeColor(look.ramp[step], delta - 16)
        }
      }
      grassLutState.key = look.key
      return GRASS_LUT
    }

    /** Two slow sine fields, cached per world size: the meadow's large-scale patches. */
    const patchState = { width: 0, height: 0, xs: null, ys: null }

    /**
     * Sine tables for the patch field.
     *
     * The field is separable (`sin(x*a) * sin(y*b)`), so two 1-D tables replace
     * two `Math.sin` calls per grass cell.
     * @param {number} width - world width in cells.
     * @param {number} height - world height in cells.
     * @returns {object} `{ xs, ys }` tables.
     */
    function patchTablesFor(width, height) {
      if (patchState.width === width && patchState.height === height) return patchState
      const xs = new Float64Array(width)
      for (let x = 0; x < width; x++) xs[x] = Math.sin(x * 0.055 + 0.7)
      const ys = new Float64Array(height)
      for (let y = 0; y < height; y++) ys[y] = Math.sin(y * 0.043 - 1.1)
      patchState.width = width
      patchState.height = height
      patchState.xs = xs
      patchState.ys = ys
      return patchState
    }

    /** Water depth buckets: the depth ramp is sampled, not recomputed per cell. */
    const WATER_BUCKETS = 128
    /** Caustic brightness steps; 17 keeps the banding below one channel step. */
    const CAUSTIC_STEPS = 17
    const waterState = { key: -1, base: null, caustic: null, ripple: null }

    /**
     * Water colour tables for one seasonal look.
     *
     * Depth ramp x three dither shades, plus a pre-blended caustic ramp per
     * depth: a water cell then costs two array reads instead of three blends.
     * @param {object} look - seasonal look.
     * @returns {object} `{ base, caustic, ripple }` tables.
     */
    function waterTablesFor(look) {
      if (waterState.key === look.key) return waterState
      const water = look.water
      const steps = WATER_BUCKETS + 1
      const base = new Int32Array(steps * 3)
      for (let bucket = 0; bucket < steps; bucket++) {
        const d = bucket / WATER_BUCKETS
        let color = blendColor(water.surface, water.shallow, Math.min(1, d * 5))
        color = blendColor(color, water.mid, clamp(d * 2.1, 0, 1))
        color = blendColor(color, water.deep, Math.min(0.88, clamp((d - 0.28) * 1.9, 0, 1)))
        // Foam on the two shallowest bands draws the shoreline instead of
        // letting the bank end at a colour change.
        if (d < 0.055) color = blendColor(color, water.foam, 0.72)
        else if (d < 0.11) color = blendColor(color, water.foam, 0.3)
        base[bucket * 3] = nudgeColor(color, -4)
        base[bucket * 3 + 1] = color
        base[bucket * 3 + 2] = nudgeColor(color, 4)
      }
      const caustic = new Int32Array(steps * 3 * CAUSTIC_STEPS)
      const ripple = new Int32Array(steps * 3)
      for (let bucket = 0; bucket < steps; bucket++) {
        for (let shade = 0; shade < 3; shade++) {
          const color = base[bucket * 3 + shade]
          ripple[bucket * 3 + shade] = blendColor(color, water.foam, 0.12)
          for (let step = 0; step < CAUSTIC_STEPS; step++) {
            caustic[(bucket * 3 + shade) * CAUSTIC_STEPS + step] =
              blendColor(color, water.caustic, (0.36 * step) / (CAUSTIC_STEPS - 1))
          }
        }
      }
      waterState.key = look.key
      waterState.base = base
      waterState.caustic = caustic
      waterState.ripple = ripple
      return waterState
    }

    /** Per-frame separable sine terms for the caustic field. */
    const waveState = { width: 0, height: 0, cols: null, rows: null }

    /**
     * Build the per-column and per-row sine terms of the caustic field.
     *
     * The three travelling waves are sums of `sin(A + B)` terms with A from the
     * column and B from the row, so each wave becomes two multiplies and an add
     * per cell instead of three `Math.sin` calls.
     * @param {number} width - view width in cells.
     * @param {number} height - view height in cells.
     * @param {number} originX - view origin column.
     * @param {number} originY - view origin row.
     * @param {number} time - seconds of ripple drift.
     * @returns {object} `{ cols, rows }` tables, six terms each.
     */
    function waveTablesFor(width, height, originX, originY, time) {
      if (waveState.width !== width || waveState.height !== height) {
        waveState.width = width
        waveState.height = height
        waveState.cols = new Float64Array(width * 6)
        waveState.rows = new Float64Array(height * 6)
      }
      const cols = waveState.cols
      for (let col = 0; col < width; col++) {
        const x = originX + col
        const base = col * 6
        cols[base] = Math.sin(x * 0.31)
        cols[base + 1] = Math.cos(x * 0.31)
        cols[base + 2] = Math.sin(x * 0.13)
        cols[base + 3] = Math.cos(x * 0.13)
        cols[base + 4] = Math.sin(x * 0.07)
        cols[base + 5] = Math.cos(x * 0.07)
      }
      const rows = waveState.rows
      const termB1 = time * 1.9
      const termB2 = time * 1.3
      const termB3 = -time * 0.7
      for (let row = 0; row < height; row++) {
        const y = originY + row
        const base = row * 6
        rows[base] = Math.cos(y * 0.17 + termB1)
        rows[base + 1] = Math.sin(y * 0.17 + termB1)
        rows[base + 2] = Math.cos(y * 0.41 + termB2)
        rows[base + 3] = Math.sin(y * 0.41 + termB2)
        rows[base + 4] = Math.cos(y * 0.09 + termB3)
        rows[base + 5] = Math.sin(y * 0.09 + termB3)
      }
      return waveState
    }

    /**
     * Ground pass: terrain, vegetation cover, water caustics, weed and snow.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} look - seasonal look.
     */
    function paintGround(world, view, out, look) {
      const terrain = world.terrain
      const grass = world.grass
      const weed = world.weed
      const depth = world.depth
      const time = world.tick * 0.05
      const patch = patchTablesFor(world.width, world.height)
      const patchXs = patch.xs
      const patchYs = patch.ys
      const ramp = grassLutFor(look)
      const water = waterTablesFor(look)
      const waterBase = water.base
      const waterCaustic = water.caustic
      const waterRipple = water.ripple
      const waves = waveTablesFor(view.width, view.height, view.x, view.y, time)
      const colTerms = waves.cols
      const rowTerms = waves.rows
      const snow = look.snow
      const weedColors = look.weed
      // Only the shallow shore sparks: a bright speck in deep water reads as a bug.
      const ripplePhase = Math.round(time * 6)
      for (let row = 0; row < view.height; row++) {
        const worldY = view.y + row
        const rowBase = worldY * world.width
        const outBase = row * view.width
        const termBase = row * 6
        const patchY = patchYs[worldY]
        for (let col = 0; col < view.width; col++) {
          const worldX = view.x + col
          const index = rowBase + worldX
          const surface = terrain[index]
          const noise = ditherAt(worldX, worldY)
          let color
          if (surface === TERRAIN.WATER) {
            const rawDepth = depth[index]
            const d = rawDepth === undefined ? 0 : rawDepth
            const bucket = rawDepth === undefined ? 0 : Math.min(WATER_BUCKETS, (d * WATER_BUCKETS) | 0)
            const shade = noise < 60 ? 0 : (noise > 196 ? 2 : 1)
            // The field is two travelling waves multiplied (which gives moving
            // patches instead of a plaid) plus one third wave that breaks the
            // lattice symmetry of the product.
            const waveOne = colTerms[col * 6] * rowTerms[termBase] + colTerms[col * 6 + 1] * rowTerms[termBase + 1]
            const waveTwo = colTerms[col * 6 + 2] * rowTerms[termBase + 2] - colTerms[col * 6 + 3] * rowTerms[termBase + 3]
            const waveThree = colTerms[col * 6 + 4] * rowTerms[termBase + 4] - colTerms[col * 6 + 5] * rowTerms[termBase + 5]
            const wave = waveOne * waveTwo + 0.45 * waveThree
            const tableIndex = bucket * 3 + shade
            color = waterBase[tableIndex]
            if (wave > 0.38) {
              const step = Math.min(CAUSTIC_STEPS - 1, ((wave - 0.38) * 0.5 / 0.36 * (CAUSTIC_STEPS - 1)) | 0)
              color = waterCaustic[tableIndex * CAUSTIC_STEPS + step]
            }
            if (d > 0.1 && ((worldX * 3 + worldY * 5 + ripplePhase) & 15) < 2) {
              color = waterRipple[tableIndex]
            }
            // Icy shallows: in deep winter the rim of the lake freezes before the
            // middle does, and that white edge is most of what says "frozen".
            if (snow > 0.4 && d < 0.22) color = blendColor(color, SNOW_COLORS.light, snow * (0.22 - d) * 2.2)
            const cover = weed[index]
            if (cover > 0.05) {
              const lush = cover > 0.55
              const sway = SWAY[(worldX + (world.tick >> 3)) & 15]
              color = blendColor(color, weedColors[lush ? 1 : 0], Math.min(0.82, cover * 1.05))
              // A bright stalk every few cells turns a flat green wash into
              // something that reads as plants growing off the bottom.
              if (cover > 0.34 && noise > 168) color = blendColor(color, PALETTE.weedStalk, 0.5)
              else if (cover > 0.2 && sway > 2) color = nudgeColor(color, 5)
            }
          } else if (surface === TERRAIN.SAND || surface === TERRAIN.DIRT) {
            color = surface === TERRAIN.SAND
              ? nudgeColor(PALETTE.sand[noise > 200 ? 2 : 0], noiseAt(noise))
              : nudgeColor(PALETTE.dirt[noise > 205 ? 2 : 0], noiseAt(noise))
            // Damp weed on the bank has to be visible, or painting it looks
            // like nothing happened.
            const damp = weed[index]
            if (damp > 0.3) color = blendColor(color, weedColors[1], Math.min(0.5, damp * 0.55))
            // Snow settles in patches, not per-pixel: the dither is sampled in
            // 2x2 blocks, which at 6x reads as banks of snow instead of static.
            if (snow > 0.15 && ditherAt((worldX >> 1) + 5, (worldY >> 1) + 3) < snow * 190) color = snowed(color, 0.55 + snow * 0.4)
          } else if (surface === TERRAIN.STONE) {
            color = nudgeColor(PALETTE.stone[noise > 198 ? 2 : 1], noiseAt(noise))
            if (snow > 0.15 && ditherAt((worldX >> 1) + 5, (worldY >> 1) + 3) < snow * 150) color = snowed(color, 0.6 + snow * 0.35)
          } else {
            const cover = grass[index]
            const step = cover <= 0 ? 0 : Math.min(7, (cover * 8) | 0)
            const sway = SWAY[((worldX * 5 + worldY * 11) + (world.tick >> 2)) & 15]
            // Two scales of variation: a cell-level flicker (blades) and a slow
            // field (patches of drier and lusher ground). Without the slow one
            // the meadow is one flat green sheet.
            let delta = sway + Math.round(patchXs[worldX] * patchY * 7)
            if (noise < 48) delta += 3
            if (delta < -16) delta = -16
            else if (delta > 15) delta = 15
            color = ramp[(step << 5) | (delta + 16)]
            // Grass gets texture the way a real pixel meadow does: a scattering
            // of brighter blades and the odd flower on the thickest cells. This
            // is what separates "grass" from "green floor" at 6x zoom.
            if (cover > 0.3 && (noise & 63) < 3) color = nudgeColor(color, 12)
            else if (cover > 0.55 && (noise & 255) < 2) color = PALETTE.flowers[(worldX * 3 + worldY * 5) & 3]
            else if (cover < 0.08 && (noise & 63) === 5) color = blendColor(color, PALETTE.dirt[0], 0.5)
            // Snow settles on open ground first: tall cover still pokes through,
            // which is the difference between "winter" and "white paint".
            if (snow > 0.15) {
              const settle = snow * 205 - cover * 70
              const flake = ditherAt((worldX >> 1) + 5, (worldY >> 1) + 3)
              // Two snow tones, chosen on a coarser (4x4) sample so the cover
              // reads as banks with shading rather than a checkerboard.
              if (flake < settle) {
                color = ditherAt((worldX >> 2) + 11, (worldY >> 2) + 7) > 120 ? SNOW_COLORS.light : SNOW_COLORS.mid
              }
            }
          }
          out[outBase + col] = color
        }
      }
    }

    /**
     * Plants pass, sorted far→near so canopies overlap correctly.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} look - seasonal look.
     * @param {object} shadow - sun shadow offset fractions.
     */
    function paintPlants(world, view, out, look, shadow) {
      const set = plantSpritesFor(look)
      const visible = plantScratch
      let count = 0
      const margin = 16
      for (const plant of world.trees) {
        if (plant.x < view.x - margin || plant.x > view.x + view.width + margin) continue
        if (plant.y < view.y - margin - 10 || plant.y > view.y + view.height + margin) continue
        visible.order[count] = plant
        visible.ys[count] = plant.y
        count += 1
      }
      if (count === 0) return
      const order = visible.sorted
      for (let index = 0; index < count; index++) order[index] = index
      order.length = count
      const ys = visible.ys
      order.sort((a, b) => ys[a] - ys[b])
      const tick = world.tick
      const strength = shadow.strength
      for (let index = 0; index < count; index++) {
        const plant = visible.order[order[index]]
        const group = set[plant.variant] ?? set.tree
        const sprite = Array.isArray(group) ? group[clamp(plant.size, 1, group.length) - 1] : group
        if (sprite === undefined) continue
        const baseX = Math.round(plant.x - view.x)
        const baseY = Math.round(plant.y - view.y)
        const swayX = ((tick >> 3) + plant.id) % 16 < 8 ? 0 : 1
        // Three shades keyed off the plant id: a forest of one identical stamp
        // reads as wallpaper, three shades read as a forest.
        const shade = [0.93, 1, 1.07][plant.id % 3]
        const factor = (plant.foliage ?? 1) < 0.35 ? 0.84 * shade : shade
        // A shadow anchors the plant to the ground; without it a canopy looks
        // like it is floating above the meadow, and the sun angle is what makes
        // the same forest look different at dawn and at noon.
        if (plant.variant !== 'lily' && strength > 0.08) {
          shadeEllipse(out, view, baseX + shadow.x * sprite.width, baseY + 1 + shadow.y * sprite.width,
            Math.max(2, sprite.width * 0.44), Math.max(1.3, sprite.width * 0.19), strength)
        }
        drawSprite(out, view.width, view.height, sprite,
          baseX - (sprite.width >> 1) + swayX, baseY - sprite.height + 1, false, factor)
      }
    }

    /**
     * Darken a soft ellipse of ground pixels, for plant and creature shadows.
     *
     * Written as row spans rather than a bounding-box scan: every row is one
     * contiguous run of ground pixels, so the writes stay in a few cache lines
     * and the inner loop has no division and no ellipse test. That matters —
     * once a full forest is on screen this layer costs more than the ground
     * itself, and the bounding-box version measured 20x slower for the same
     * pixels (docs/70-VISUAL.md).
     *
     * Two intensity bands instead of one: a single flat ellipse reads as a
     * painted rectangle at the sizes trees have here.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} view - viewport.
     * @param {number} cx - centre column in buffer space.
     * @param {number} cy - centre row in buffer space.
     * @param {number} rx - radius x.
     * @param {number} ry - radius y.
     * @param {number} [strength] - 0..1 shadow opacity (sun elevation).
     */
    function shadeEllipse(out, view, cx, cy, rx, ry, strength = 1) {
      if (strength <= 0.02 || rx <= 0 || ry <= 0) return
      const viewWidth = view.width
      const viewHeight = view.height
      // Fixed-point multipliers: (channel * q) >> 8, no float per channel.
      const outerQ = Math.round((1 - 0.14 * strength) * 256)
      const innerQ = Math.round((1 - 0.28 * strength) * 256)
      const fromY = Math.max(0, Math.ceil(cy - ry))
      const toY = Math.min(viewHeight - 1, Math.floor(cy + ry))
      for (let y = fromY; y <= toY; y++) {
        const ny = (y - cy) / ry
        const inside = 1 - ny * ny
        if (inside <= 0) continue
        const span = Math.sqrt(inside) * rx
        const fromX = Math.max(0, Math.ceil(cx - span))
        const toX = Math.min(viewWidth - 1, Math.floor(cx + span))
        if (fromX > toX) continue
        const q = Math.abs(ny) > 0.72 ? outerQ : innerQ
        const rowBase = y * viewWidth
        for (let x = fromX; x <= toX; x++) {
          const color = out[rowBase + x]
          out[rowBase + x] = (0xFF000000
            | (((((color >>> 16) & 0xFF) * q) >> 8) << 16)
            | (((((color >>> 8) & 0xFF) * q) >> 8) << 8)
            | (((color & 0xFF) * q) >> 8)) >>> 0
        }
      }
    }

    /**
     * Carcasses pass.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} shadow - sun shadow offset fractions.
     */
    function paintCorpses(world, view, out, shadow) {
      for (const corpse of world.corpses) {
        if (corpse.x < view.x - 4 || corpse.x > view.x + view.width + 4) continue
        if (corpse.y < view.y - 4 || corpse.y > view.y + view.height + 4) continue
        const sprite = CORPSE_SPRITES[corpse.decay > 0.6 ? 1 : 0]
        drawSprite(out, view.width, view.height, sprite,
          Math.round(corpse.x - view.x - sprite.width / 2 + shadow.x * 2),
          Math.round(corpse.y - view.y - 1),
          false, Math.max(0.45, 1 - corpse.decay * 0.5))
      }
    }

    /** Reused index buffers for the animal pass: no per-frame object garbage. */
    const animalScratch = { order: [], ys: [], xs: [], sorted: [], count: 0 }
    /** Reused index buffers for the plant pass. */
    const plantScratch = { order: [], ys: [], sorted: [] }

    /**
     * Animals pass, with motion interpolation, poses and body-sized shadows.
     *
     * Positions are interpolated between the last two simulation ticks (10 Hz)
     * up to the display refresh rate, which is what turns 10 stepping blobs into
     * sixty smooth ones.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} alpha - 0..1 between the last two ticks.
     * @param {object} shadow - sun shadow offset fractions.
     * @param {boolean} castShadow - whether creatures cast a ground shadow.
     */
    function paintAnimals(world, view, out, alpha, shadow, castShadow) {
      const scratch = animalScratch
      let count = 0
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 8 || x > view.x + view.width + 8) continue
        if (y < view.y - 10 || y > view.y + view.height + 6) continue
        scratch.xs[count] = x
        scratch.ys[count] = y
        scratch.order[count] = animal
        count += 1
      }
      if (count === 0) return
      const sorted = scratch.sorted
      for (let index = 0; index < count; index++) sorted[index] = index
      sorted.length = count
      const ys = scratch.ys
      sorted.sort((a, b) => ys[a] - ys[b])
      const strength = shadow.strength
      for (let index = 0; index < count; index++) {
        const slot = sorted[index]
        const animal = scratch.order[slot]
        const x = scratch.xs[slot]
        const y = scratch.ys[slot]
        const sprite = frameFor(animal, world.tick)
        if (sprite === null) continue
        const pose = poseFor(animal)
        const species = SPECIES[animal.species]
        const maxEnergy = species === undefined ? 1 : species.balance.maxEnergy
        const ratio = animal.energy / maxEnergy
        let factor
        if (ratio < 0.22) factor = 0.72
        else if (pose.alpha < 1) factor = pose.alpha
        const centreX = Math.round(x - view.x - sprite.width / 2)
        const feetX = centreX + (sprite.width >> 1)
        const feetY = Math.round(y - view.y)
        // Measure the top from the feet *through* the pose, so a crouched or
        // settled animal stays planted on its shadow instead of floating.
        const topY = feetY - Math.floor((sprite.height - 1) * pose.squash) - Math.round(pose.sink)
        if (species !== undefined && species.habitat === 'water') {
          // A shadow under a fish makes it read as hovering in mid air; a bright
          // ripple ring under it says "in the water" instead.
          if (feetX >= 0 && feetX < view.width && feetY >= 0 && feetY < view.height) {
            const cell = feetY * view.width + feetX
            out[cell] = blendColor(out[cell], PALETTE.waterSurface, 0.4)
          }
        } else if (castShadow && strength > 0.08) {
          // The cast shadow scales with the body: a juvenile's is visibly
          // smaller than an adult's, which is the cheapest way for size to be
          // readable before the camera is close enough to see the sprite.
          const bodyScale = STAGE_SCALE[animal.stage ?? 'adult'] ?? 1
          const radius = Math.max(1.3, sprite.width * 0.45 * pose.shadow * bodyScale)
          shadeEllipse(out, view,
            Math.round(feetX + shadow.x * sprite.width),
            Math.round(feetY + shadow.y * sprite.width),
            radius, Math.max(1, sprite.height * 0.24 * bodyScale), strength * pose.shadow)
        }
        drawSprite(out, view.width, view.height, sprite, centreX, topY, Math.cos(animal.heading) < 0, factor, pose)
      }
    }

    /**
     * Trails, footfalls and behaviour effects: the layer that says "something
     * happened".
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} budget - how many detail particles this view may spend.
     */
    function paintActivity(world, view, out, budget) {
      const tick = world.tick
      for (const animal of world.entities) {
        const trail = TRAIL_COLORS[animal.species]
        if (trail === undefined || animal.prevX === undefined) continue
        const movedX = animal.x - animal.prevX
        const movedY = animal.y - animal.prevY
        const moved = Math.hypot(movedX, movedY)
        if (moved < 0.3) continue
        const x = Math.round(animal.prevX) - view.x
        const y = Math.round(animal.prevY) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = trail
        // Footfall dust: one kick per stride, thrown behind a moving animal. It
        // is a close-up detail — on a full-map capture it would be noise — so it
        // shares the particle budget instead of running everywhere.
        if (budget <= 0) continue
        const gait = animal.gait ?? 0
        // One kick per stride: the first eighth of the gait cycle, so the dust
        // pulses with the feet instead of smoking continuously.
        const stride = gait * 4 - Math.floor(gait * 4)
        if (stride < 0.125 && moved > 0.35) {
          const offsetX = Math.round(x - (movedX / moved) * 1.5)
          const offsetY = Math.round(y - (movedY / moved) * 1.2)
          if (offsetX >= 0 && offsetY >= 0 && offsetX < view.width && offsetY < view.height) {
            const index = offsetY * view.width + offsetX
            out[index] = blendColor(out[index], DUST_COLORS[(tick + (animal.id ?? 0)) & 1], 0.45)
          }
        }
      }
      for (const effect of world.effects) {
        const life = clamp(effect.life / effect.maxLife, 0, 1)
        const x = (effect.x | 0) - view.x
        const y = (effect.y | 0) - view.y
        if (x < -3 || y < -3 || x > view.width + 3 || y > view.height + 3) continue
        if (x >= 0 && y >= 0 && x < view.width && y < view.height) {
          out[y * view.width + x] = dimColor(effect.color, 0.35 + life * 0.65)
        }
        // Splashes and strikes on water throw a ring that widens as it fades;
        // without it a hunt in the lake is a single flashing pixel. The water
        // test reads the terrain here, so the engine needs no new field.
        const effectX = effect.x | 0
        const effectY = effect.y | 0
        const effectCell = effectX >= 0 && effectY >= 0 && effectX < world.width && effectY < world.height
          ? effectY * world.width + effectX
          : -1
        if (effectCell >= 0 && world.terrain[effectCell] === TERRAIN.WATER) {
          const radius = 1 + Math.round((1 - life) * 2.5)
          for (let angle = 0; angle < 8; angle++) {
            const radians = (angle / 8) * Math.PI * 2
            const ringX = x + Math.round(Math.cos(radians) * radius)
            const ringY = y + Math.round(Math.sin(radians) * radius)
            if (ringX < 0 || ringY < 0 || ringX >= view.width || ringY >= view.height) continue
            out[ringY * view.width + ringX] = dimColor(PALETTE.effect.splash, 0.35 + life * 0.5)
          }
        }
      }
    }

    /** Falling flakes a single frame may draw, whatever the view size. */
    const WEATHER_FLAKES = 240

    /**
     * Weather pass: snow over a winter world.
     *
     * Flake positions come from the dither hash and the tick, so the same tick
     * always paints the same snow: the weather animates without making the frame
     * non-deterministic, and it costs one write per flake.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} look - seasonal look.
     */
    function paintWeather(world, view, out, look) {
      const snow = look.snow
      if (snow <= 0.15) return
      const cells = view.width * view.height
      const budget = Math.min(WEATHER_FLAKES, Math.max(0, (cells / 220) | 0))
      if (budget === 0) return
      const drift = world.tick * 0.31
      const fall = world.tick * 0.55
      const light = SNOW_COLORS.light
      for (let index = 0; index < budget; index++) {
        const seedX = DITHER[(index * 37) & 255]
        const seedY = DITHER[(index * 101 + 61) & 255]
        const speed = 0.6 + (DITHER[(index * 19 + 7) & 255] / 255) * 0.9
        const x = ((seedX / 255 * view.width + drift * speed) % view.width + view.width) % view.width
        const y = ((seedY / 255 * view.height + fall * speed) % view.height + view.height) % view.height
        const cell = (y | 0) * view.width + (x | 0)
        out[cell] = blendColor(out[cell], light, 0.5 + 0.4 * (snow - 0.15))
      }
    }

    /**
     * Brush cursor and selection ring, drawn in buffer coordinates.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {object|null} overlay - `{ hover, radius, selected, highlight }`.
     */
    function paintOverlay(view, out, overlay) {
      if (overlay === null || overlay === undefined) return
      const put = (x, y, color) => {
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) return
        out[y * view.width + x] = color
      }
      const hover = overlay.hover
      if (hover !== null && hover !== undefined) {
        const radius = overlay.radius ?? 0
        const left = Math.round(hover.x) - radius - view.x
        const top = Math.round(hover.y) - radius - view.y
        const size = radius * 2 + 1
        const color = PALETTE.effect.cursor
        for (let i = 0; i < size; i++) {
          put(left + i, top, color)
          put(left + i, top + size - 1, color)
          put(left, top + i, color)
          put(left + size - 1, top + i, color)
        }
      }
      const selected = overlay.selected
      if (selected !== null && selected !== undefined) {
        const cx = Math.round(selected.x) - view.x
        const cy = Math.round(selected.y) - view.y
        const ring = PALETTE.effect.select
        for (let angle = 0; angle < 16; angle++) {
          const radians = (angle / 16) * Math.PI * 2
          const x = cx + Math.round(Math.cos(radians) * 4)
          const y = cy + Math.round(Math.sin(radians) * 4)
          if (angle % 4 === 0) put(x, y, ring)
        }
      }
    }

    /** Shared options record, so the hot path never allocates a default. */
    const EMPTY_VIEW_OPTIONS = { sprites: true, plants: true, weather: true, shadows: true }
    /** Shadow offset that paints nothing, used when the caller turns shadows off. */
    const NO_SHADOW = { x: 0, y: 0, strength: 0 }

    /**
     * Render one viewport of the world.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} [buffer] - reusable buffer of `width*height`.
     * @param {number} [alpha] - interpolation between the last two ticks.
     * @param {object|null} [overlay] - cursor and selection.
     * @param {object|null} [options] - `{ sprites, plants, weather, shadows }`;
     *   any of them may be false to skip that layer. Absent counts as on.
     * @returns {Uint32Array} the buffer that was written.
     */
    function paintView(world, view, buffer, alpha = 1, overlay = null, options = null) {
      const size = view.width * view.height
      const out = buffer !== undefined && buffer.length === size ? buffer : new Uint32Array(size)
      const opts = options === null || options === undefined ? EMPTY_VIEW_OPTIONS : options
      const spritesInBuffer = opts.sprites !== false
      const plantsInBuffer = opts.plants !== false
      const weatherInBuffer = opts.weather !== false
      const castShadow = opts.shadows !== false
      const look = seasonLook(world)
      const shadow = shadowOffset(world)
      paintGround(world, view, out, look)
      if (plantsInBuffer) paintPlants(world, view, out, look, castShadow ? shadow : NO_SHADOW)
      paintCorpses(world, view, out, shadow)
      if (spritesInBuffer) paintAnimals(world, view, out, alpha, shadow, castShadow)
      // The detail layers are close-up affordances: at a full-map view they cost
      // more than they show, so each one scales with how much of the world is on
      // screen. docs/70-VISUAL.md lists the budgets and the measured cost.
      const closeUp = size <= 48000
      paintActivity(world, view, out, closeUp ? 400 : 0)
      if (weatherInBuffer) paintWeather(world, view, out, look)
      paintOverlay(view, out, overlay)
      return out
    }

    /**
     * Low-resolution picture of the whole world, for the minimap.
     * @param {object} world - the world.
     * @param {number} width - minimap width in pixels.
     * @param {number} height - minimap height in pixels.
     * @returns {Uint32Array} `width*height` pixels.
     */
    function paintMinimap(world, width, height) {
      const out = new Uint32Array(width * height)
      const stepX = world.width / width
      const stepY = world.height / height
      const ramp = seasonLook(world).ramp
      for (let y = 0; y < height; y++) {
        const worldY = Math.min(world.height - 1, (y * stepY) | 0)
        for (let x = 0; x < width; x++) {
          const worldX = Math.min(world.width - 1, (x * stepX) | 0)
          const index = worldY * world.width + worldX
          const surface = world.terrain[index]
          let color
          if (surface === TERRAIN.WATER) color = PALETTE.water[2]
          else if (surface === TERRAIN.STONE) color = PALETTE.stone[1]
          else if (surface === TERRAIN.SAND) color = PALETTE.sand[1]
          else if (surface === TERRAIN.DIRT) color = PALETTE.dirt[1]
          else color = ramp[Math.min(7, (world.grass[index] * 8) | 0)]
          out[y * width + x] = color
        }
      }
      for (const animal of world.entities) {
        const x = Math.min(width - 1, (animal.x / stepX) | 0)
        const y = Math.min(height - 1, (animal.y / stepY) | 0)
        const species = SPECIES[animal.species]
        if (species === undefined) continue
        out[y * width + x] = rgb(
          parseInt(species.color.slice(1, 3), 16),
          parseInt(species.color.slice(3, 5), 16),
          parseInt(species.color.slice(5, 7), 16),
        )
      }
      return out
    }


    /**
     * Full-world render, kept for tests and for one-shot captures.
     * @param {object} world - the world.
     * @param {Uint32Array} [pixels] - reusable buffer.
     * @returns {Uint32Array} the buffer.
     */
    function paintWorld(world, pixels) {
      return paintView(world, { x: 0, y: 0, width: world.width, height: world.height }, pixels, 1, null)
    }
