    // ---------------------------------------------------------------------
    // Viewport renderer
    // ---------------------------------------------------------------------

    /**
     * Pick the sprite frame for one animal.
     *
     * Motion is what sells a creature: a fleeing animal shows a flattened pose,
     * a walking one alternates two frames, and a grazing one stands still.
     * @param {object} entity - the animal.
     * @param {number} tick - world tick (drives the walk cycle).
     * @returns {object} compiled sprite.
     */
    function frameFor(entity, tick) {
      const set = SPRITES[entity.species]
      if (set === undefined) return null
      if (entity.fleeing === true) return set.flee
      const moved = entity.prevX === undefined
        ? 0
        : Math.hypot(entity.x - entity.prevX, entity.y - entity.prevY)
      if (moved < 0.06) return set.idle
      const phase = Math.floor(tick / 2 + entity.phase * 4) % set.walk.length
      return set.walk[phase]
    }

    /**
     * Paint one sprite, clipped to the buffer.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} width - buffer width.
     * @param {number} height - buffer height.
     * @param {object} sprite - compiled sprite.
     * @param {number} left - buffer column of the sprite's left edge.
     * @param {number} top - buffer row of the sprite's top edge.
     * @param {boolean} flip - mirror horizontally.
     * @param {number} [factor] - brightness multiplier.
     */
    function drawSprite(out, width, height, sprite, left, top, flip, factor) {
      const spriteWidth = sprite.width
      for (let y = 0; y < sprite.height; y++) {
        const targetY = top + y
        if (targetY < 0 || targetY >= height) continue
        const rowBase = y * spriteWidth
        const targetBase = targetY * width
        for (let x = 0; x < spriteWidth; x++) {
          const color = sprite.pixels[rowBase + (flip ? spriteWidth - 1 - x : x)]
          if (color === 0) continue
          const targetX = left + x
          if (targetX < 0 || targetX >= width) continue
          out[targetBase + targetX] = factor === undefined ? color : dimColor(color, factor)
        }
      }
    }

    /**
     * Ground pass: terrain, vegetation cover, water ripples and weed.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintGround(world, view, out) {
      const terrain = world.terrain
      const grass = world.grass
      const weed = world.weed
      const depth = world.depth
      const time = world.tick * 0.05
      for (let row = 0; row < view.height; row++) {
        const worldY = view.y + row
        const rowBase = worldY * world.width
        const outBase = row * view.width
        for (let col = 0; col < view.width; col++) {
          const worldX = view.x + col
          const index = rowBase + worldX
          const surface = terrain[index]
          const noise = ditherAt(worldX, worldY)
          let color
          if (surface === TERRAIN.WATER) {
            color = waterColor(worldX, worldY, depth[index], time, noise)
            const cover = weed[index]
            if (cover > 0.05) {
              const lush = cover > 0.55
              const shade = SWAY[(worldX + (world.tick >> 3)) & 15]
              color = blendColor(color, PALETTE.weed[lush ? 1 : 0], Math.min(0.82, cover * 1.05))
              // A bright stalk every few cells turns a flat green wash into
              // something that reads as plants growing off the bottom.
              if (cover > 0.34 && noise > 168) color = blendColor(color, PALETTE.weedStalk, 0.5)
              else if (cover > 0.2 && shade > 2) color = nudgeColor(color, 5)
            }
          } else if (surface === TERRAIN.SAND || surface === TERRAIN.DIRT) {
            color = surface === TERRAIN.SAND
              ? nudgeColor(PALETTE.sand[noise > 200 ? 2 : 0], noiseAt(noise))
              : nudgeColor(PALETTE.dirt[noise > 205 ? 2 : 0], noiseAt(noise))
            // Damp weed on the bank has to be visible, or painting it looks
            // like nothing happened.
            const damp = weed[index]
            if (damp > 0.3) color = blendColor(color, PALETTE.weed[1], Math.min(0.5, damp * 0.55))
          } else if (surface === TERRAIN.STONE) {
            color = nudgeColor(PALETTE.stone[noise > 198 ? 2 : 1], noiseAt(noise))
          } else {
            const cover = grass[index]
            const step = cover <= 0 ? 0 : Math.min(7, (cover * 8) | 0)
            const sway = SWAY[((worldX * 5 + worldY * 11) + (world.tick >> 2)) & 15]
            // Two scales of variation: a cell-level flicker (blades) and a slow
            // field (patches of drier and lusher ground). Without the slow one
            // the meadow is one flat green sheet.
            const patch = Math.round(Math.sin(worldX * 0.055 + 0.7) * Math.sin(worldY * 0.043 - 1.1) * 7)
            color = nudgeColor(GRASS_RAMP[step], sway + patch + (noise < 48 ? 3 : 0))
            // Grass gets texture the way a real pixel meadow does: a scattering
            // of brighter blades and the odd flower on the thickest cells. This
            // is what separates "grass" from "green floor" at 6x zoom.
            if (cover > 0.3 && (noise & 63) < 3) color = nudgeColor(color, 12)
            else if (cover > 0.55 && (noise & 255) < 2) color = PALETTE.flowers[(worldX * 3 + worldY * 5) & 3]
            else if (cover < 0.08 && (noise & 63) === 5) color = blendColor(color, PALETTE.dirt[0], 0.5)
          }
          out[outBase + col] = color
        }
      }
    }

    /**
     * One cell of open water.
     *
     * Depth gives the lake a floor, the two crossed sine bands are the caustics
     * the sun throws onto it, and the last two bands of shallow water get foam so
     * the shoreline has a drawn edge instead of a colour change.
     * @param {number} x - world column.
     * @param {number} y - world row.
     * @param {number} depthValue - 0 at the bank, 1 at the deepest point.
     * @param {number} time - seconds, for the caustic drift.
     * @param {number} noise - 0..255 cell hash.
     * @returns {number} packed colour.
     */
    function waterColor(x, y, depthValue, time, noise) {
      const d = depthValue ?? 0
      let color = blendColor(PALETTE.waterSurface, PALETTE.waterShallow, Math.min(1, d * 5))
      color = blendColor(color, PALETTE.waterMid, clamp(d * 2.1, 0, 1))
      color = blendColor(color, PALETTE.waterDeep, Math.min(0.88, clamp((d - 0.28) * 1.9, 0, 1)))
      // Caustics: two travelling waves multiplied together give moving patches
      // rather than a plaid pattern.
      // Three terms, not two: the product of two sines is a lattice and prints a
      // visible grid over the whole lake. The third breaks the symmetry.
      const wave = Math.sin(x * 0.31 + y * 0.17 + time * 1.9) * Math.sin(x * 0.13 - y * 0.41 - time * 1.3)
        + 0.45 * Math.sin(x * 0.07 - y * 0.09 + time * 0.7)
      if (wave > 0.38) color = blendColor(color, PALETTE.caustic, Math.min(0.36, (wave - 0.38) * 0.5))
      // A second, finer ripple: the first band alone reads as a still puddle.
      if (((x * 3 + y * 5 + Math.round(time * 6)) & 15) < 2 && (d > 0.1)) color = blendColor(color, PALETTE.foam, 0.12)
      if (d < 0.055) color = blendColor(color, PALETTE.foam, 0.72)
      else if (d < 0.11) color = blendColor(color, PALETTE.foam, 0.3)
      else if (d < 0.16 && noise > 210) color = blendColor(color, PALETTE.foam, 0.22)
      // Dither by hand: nudgeColor takes integer channel deltas.
      return nudgeColor(color, noise < 60 ? -6 : (noise > 196 ? 6 : 0))
    }

    /**
     * Plants pass, sorted far→near so canopies overlap correctly.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintPlants(world, view, out) {
      const visible = []
      const margin = 16
      for (const plant of world.trees) {
        if (plant.x < view.x - margin || plant.x > view.x + view.width + margin) continue
        if (plant.y < view.y - margin - 10 || plant.y > view.y + view.height + margin) continue
        visible.push(plant)
      }
      visible.sort((a, b) => a.y - b.y)
      const tick = world.tick
      for (const plant of visible) {
        const set = PLANT_SPRITES[plant.variant] ?? PLANT_SPRITES.tree
        const sprite = Array.isArray(set) ? set[clamp(plant.size, 1, set.length) - 1] : set
        if (sprite === undefined) continue
        const baseX = Math.round(plant.x - view.x)
        const baseY = Math.round(plant.y - view.y)
        const swayX = ((tick >> 3) + plant.id) % 16 < 8 ? 0 : 1
        // Three shades keyed off the plant id: a forest of one identical stamp
        // reads as wallpaper, three shades read as a forest.
        const shade = [0.93, 1, 1.07][plant.id % 3]
        const factor = (plant.foliage ?? 1) < 0.35 ? 0.84 * shade : shade
        // A shadow anchors the plant to the ground; without it a canopy looks
        // like it is floating above the meadow.
        if (plant.variant !== 'lily') {
          shadeEllipse(out, view, baseX, baseY + 1,
            Math.max(2, sprite.width * 0.44), Math.max(1.3, sprite.width * 0.19))
        }
        drawSprite(out, view.width, view.height, sprite,
          baseX - (sprite.width >> 1) + swayX, baseY - sprite.height + 1, false, factor)
      }
    }

    /**
     * Darken a soft ellipse of ground pixels, for plant and creature shadows.
     * @param {Uint32Array} out - frame buffer.
     * @param {object} view - viewport.
     * @param {number} cx - centre column in buffer space.
     * @param {number} cy - centre row in buffer space.
     * @param {number} rx - radius x.
     * @param {number} ry - radius y.
     */
    function shadeEllipse(out, view, cx, cy, rx, ry) {
      const spanX = Math.ceil(rx)
      const spanY = Math.ceil(ry)
      for (let dy = -spanY; dy <= spanY; dy++) {
        for (let dx = -spanX; dx <= spanX; dx++) {
          const nx = dx / rx
          const ny = dy / ry
          const distance = nx * nx + ny * ny
          if (distance > 1) continue
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
          const index = y * view.width + x
          // Two steps instead of one: a single flat ellipse reads as a painted
          // rectangle at the sizes trees have here.
          out[index] = dimColor(out[index], distance > 0.5 ? 0.86 : 0.72)
        }
      }
    }

    /**
     * Carcasses pass.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintCorpses(world, view, out) {
      for (const corpse of world.corpses) {
        if (corpse.x < view.x - 4 || corpse.x > view.x + view.width + 4) continue
        if (corpse.y < view.y - 4 || corpse.y > view.y + view.height + 4) continue
        const sprite = CORPSE_SPRITES[corpse.decay > 0.6 ? 1 : 0]
        drawSprite(out, view.width, view.height, sprite,
          Math.round(corpse.x - view.x - sprite.width / 2), Math.round(corpse.y - view.y - 1),
          false, Math.max(0.45, 1 - corpse.decay * 0.5))
      }
    }

    /**
     * Animals pass, with motion interpolation and the low-resolution gait frames.
     *
     * Positions are interpolated between the last two simulation ticks (10 Hz)
     * up to the display refresh rate, which is what turns 10 stepping blobs into
     * sixty smooth ones.
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     * @param {number} alpha - 0..1 between the last two ticks.
     */
    function paintAnimals(world, view, out, alpha) {
      const visible = []
      for (const animal of world.entities) {
        const x = animal.prevX === undefined ? animal.x : animal.prevX + (animal.x - animal.prevX) * alpha
        const y = animal.prevY === undefined ? animal.y : animal.prevY + (animal.y - animal.prevY) * alpha
        if (x < view.x - 8 || x > view.x + view.width + 8) continue
        if (y < view.y - 10 || y > view.y + view.height + 6) continue
        visible.push({ animal, x, y })
      }
      visible.sort((a, b) => a.y - b.y)
      for (const { animal, x, y } of visible) {
        const sprite = frameFor(animal, world.tick)
        if (sprite === null) continue
        const species = SPECIES[animal.species]
        const ratio = species === undefined ? 1 : animal.energy / species.balance.maxEnergy
        const factor = ratio < 0.22 ? 0.72 : undefined
        const facingLeft = Math.cos(animal.heading) < 0
        drawSprite(out, view.width, view.height, sprite,
          Math.round(x - view.x - sprite.width / 2),
          Math.round(y - view.y - sprite.height + 1),
          facingLeft, factor)
      }
    }

    /**
     * Trails and behaviour effects: the layer that says "something happened".
     * @param {object} world - the world.
     * @param {object} view - viewport.
     * @param {Uint32Array} out - frame buffer.
     */
    function paintActivity(world, view, out) {
      for (const animal of world.entities) {
        const trail = TRAIL_COLORS[animal.species]
        if (trail === undefined || animal.prevX === undefined) continue
        if (Math.hypot(animal.x - animal.prevX, animal.y - animal.prevY) < 0.3) continue
        const x = Math.round(animal.prevX) - view.x
        const y = Math.round(animal.prevY) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = trail
      }
      for (const effect of world.effects) {
        const alpha = clamp(effect.life / effect.maxLife, 0, 1)
        const x = (effect.x | 0) - view.x
        const y = (effect.y | 0) - view.y
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) continue
        out[y * view.width + x] = dimColor(effect.color, 0.35 + alpha * 0.65)
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

    /**
     * Render one viewport of the world.
     * @param {object} world - the world.
     * @param {object} view - `{ x, y, width, height }` in cells.
     * @param {Uint32Array} [buffer] - reusable buffer of `width*height`.
     * @param {number} [alpha] - interpolation between the last two ticks.
     * @param {object|null} [overlay] - cursor and selection.
     * @returns {Uint32Array} the buffer that was written.
     */
    function paintView(world, view, buffer, alpha = 1, overlay = null, options = null) {
      const size = view.width * view.height
      const out = buffer !== undefined && buffer.length === size ? buffer : new Uint32Array(size)
      const spritesInBuffer = options === null || options.sprites !== false
      const plantsInBuffer = options === null || options.plants !== false
      paintGround(world, view, out)
      if (plantsInBuffer) paintPlants(world, view, out)
      paintCorpses(world, view, out)
      if (spritesInBuffer) paintAnimals(world, view, out, alpha)
      paintActivity(world, view, out)
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
          else color = GRASS_RAMP[Math.min(7, (world.grass[index] * 8) | 0)]
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
