    // ---------------------------------------------------------------------
    // Sprites: every species has idle / walk / flee frames
    // ---------------------------------------------------------------------
    //
    // A 2-3 cell creature needs two walk frames and a distinct "running" pose,
    // or the meadow reads as a still photograph with dots on it. Each frame is a
    // character grid: `.` transparent, other letters index the palette map.

    /** Raw character grids, compiled into `SPRITES` below. */
    const SPRITE_GRIDS = {
      rabbit: {
        idle: [
          '.e.e',
          'bbbb',
          'kbdb',
          '..bb',
        ],
        walk: [
          [
            '.e.e',
            'bbbb',
            'kbdb',
            '.b.b',
          ],
          [
            '.e.e',
            'bbbb',
            'kbdb',
            'b..b',
          ],
        ],
        flee: [
          '..ee',
          'bbbb',
          'kbdd',
          '.b.b',
        ],
      },
      deer: {
        idle: [
          'a....a',
          '.bbbb.',
          'bbbbbb',
          'bbbbbd',
          '.b..b.',
        ],
        walk: [
          [
            'a....a',
            '.bbbb.',
            'bbbbbb',
            'bbbbbd',
            'b.b.b.',
          ],
          [
            'a....a',
            '.bbbb.',
            'bbbbbb',
            'bbbbbd',
            '.b.b.b',
          ],
        ],
        flee: [
          'a....a',
          'bbbbbb',
          'bbbbbb',
          'bbbbbd',
          'b....b',
        ],
      },
      fox: {
        idle: [
          'f...f',
          'fffff',
          'kffff',
          '.f.f.',
        ],
        walk: [
          [
            'f...f',
            'fffff',
            'kffff',
            'f...f',
          ],
          [
            'f...f',
            'fffff',
            'kffff',
            '.f.f.',
          ],
        ],
        flee: [
          'f...f',
          'fffff',
          'kffdd',
          'f...f',
        ],
      },
      wolf: {
        idle: [
          'b....b',
          '.bbbb.',
          'bbbbbb',
          'kbdddb',
          '.b..b.',
        ],
        walk: [
          [
            'b....b',
            '.bbbb.',
            'bbbbbb',
            'kbdddb',
            'b.b.b.',
          ],
          [
            'b....b',
            '.bbbb.',
            'bbbbbb',
            'kbdddb',
            '.b.b.b',
          ],
        ],
        flee: [
          'b....b',
          'bbbbbb',
          'bbbbbb',
          'kbdddb',
          'b....b',
        ],
      },
      crow: {
        idle: [
          'b.w.b',
          'bbwbb',
          '.bbb.',
          '..k..',
        ],
        walk: [
          [
            'b...b',
            '.b.b.',
            'bbwbb',
            '..k..',
          ],
          [
            '..b..',
            '.bbb.',
            'bwbbb',
            '..k..',
          ],
        ],
        flee: [
          'b...b',
          'bb.bb',
          '.bwb.',
          '..k..',
        ],
      },
      fish: {
        idle: [
          '.ff.',
          'bbbd',
        ],
        walk: [
          [
            'ff..',
            'bbbd',
          ],
          [
            '..ff',
            'bbbd',
          ],
        ],
        flee: [
          'fff.',
          'bbbd',
        ],
      },
      pike: {
        idle: [
          '..fff',
          'bbbbd',
        ],
        walk: [
          [
            'f.fff',
            'bbbbd',
          ],
          [
            '...ff',
            'bbbbd',
          ],
        ],
        flee: [
          'f..ff',
          'bbbbd',
        ],
      },
    }

    /** Character → palette colour, per species. */
    const SPRITE_COLORS = {
      rabbit: { e: PALETTE.rabbit.ear, b: PALETTE.rabbit.body, k: PALETTE.rabbit.eye, d: PALETTE.rabbit.belly },
      deer: { a: PALETTE.deer.antler, b: PALETTE.deer.body, d: PALETTE.deer.belly },
      fox: { f: PALETTE.fox.body, k: PALETTE.fox.eye, d: PALETTE.fox.belly },
      wolf: { b: PALETTE.wolf.body, k: PALETTE.wolf.eye, d: PALETTE.wolf.belly },
      crow: { b: PALETTE.crow.body, w: PALETTE.crow.wing, k: PALETTE.crow.eye },
      fish: { b: PALETTE.fish.body, f: PALETTE.fish.fin, d: PALETTE.fish.belly },
      pike: { b: PALETTE.pike.body, f: PALETTE.pike.fin, d: PALETTE.pike.dark },
    }


    /** Compiled animation sets, one per species. */
    const SPRITES = Object.fromEntries(Object.entries(SPRITE_GRIDS).map(([species, set]) => [species, {
      idle: compileSprite(set.idle, SPRITE_COLORS[species]),
      walk: set.walk.map(rows => compileSprite(rows, SPRITE_COLORS[species])),
      flee: compileSprite(set.flee, SPRITE_COLORS[species]),
    }]))

    // ---------------------------------------------------------------------
    // State → pose table
    // ---------------------------------------------------------------------
    //
    // The atlas only carries idle (2 frames), walk (4) and run (4) per species.
    // Waiting for new artwork would leave "sleeping", "stalking" and "freezing"
    // invisible, so every behaviour state is expressed as a *pose variant* over
    // those three frame sets: hold a frame, settle into the ground, lean, squash,
    // nod at a grazing cadence, shiver. One table, two consumers — the 1-px
    // buffer pass (frameFor) and the atlas display pass (drawAtlasAnimal).

    /**
     * Pose defaults. A pose is a small, complete description; the renderer never
     * fills in missing fields at draw time.
     */
    const POSE_DEFAULTS = {
      /** Frame set to play: 'idle' | 'walk' | 'run'. */
      role: 'idle',
      /** Frame-rate multiplier for the walk cycle. */
      speed: 1,
      /** Hold the first frame instead of cycling (rest, sleep, huddle). */
      pause: false,
      /** 0..1 head-bob at a grazing cadence. */
      nod: 0,
      /** Lean in degrees; negative leans forward. */
      tilt: 0,
      /** How far the body settles into the ground, in cells. */
      sink: 0,
      /** Vertical scale: < 1 crouches, > 1 rears up. */
      squash: 1,
      /** Opacity; hiding animals fade. */
      alpha: 1,
      /** Shadow size multiplier, so a crouched animal casts a smaller shadow. */
      shadow: 1,
      /** 0..1 shiver jitter (cold, fighting). */
      shake: 0,
    }

    /**
     * Behaviour state id → pose.
     *
     * Keys are the ids `state.id` will carry once the execution state machine
     * lands (docs/20-CORE-LOOP.md 2.3); the intent ids the engine uses today are
     * listed too, so the renderer works on both engines. Unknown ids fall back
     * to the idle pose instead of freezing the animal at frame 0 of nothing.
     */
    const STATE_POSES = {
      // Standing still, breathing.
      idle: {},
      alert: { squash: 1.04, shadow: 0.9 },
      // Grazing / browsing: head down, a slow nod, body settles a little.
      graze: { role: 'idle', nod: 1, squash: 0.93, sink: 0.45 },
      eat: { role: 'idle', nod: 1, squash: 0.91, sink: 0.4 },
      forage: { role: 'idle', nod: 0.7, squash: 0.95, sink: 0.5 },
      browse: { role: 'idle', nod: 0.8, squash: 0.94, sink: 0.45 },
      // Drinking: leans down at the waterline.
      drink: { role: 'idle', tilt: 7, sink: 0.9, nod: 0.35 },
      // Resting and sleeping: a held frame, crouched, sunk into the grass.
      rest: { role: 'idle', pause: true, squash: 0.86, sink: 1 },
      sleep: { role: 'idle', pause: true, squash: 0.76, sink: 1.4, alpha: 0.92, shadow: 0.75 },
      bask: { role: 'idle', pause: true, squash: 0.88, sink: 1.1 },
      // Stalking (潜伏): low, slow, faded, minimal shadow.
      stalk: { role: 'walk', speed: 0.4, squash: 0.8, sink: 0.7, shadow: 0.55 },
      sneak: { role: 'walk', speed: 0.45, squash: 0.82, sink: 0.6, shadow: 0.6 },
      ambush: { role: 'idle', pause: true, squash: 0.82, sink: 0.8, shadow: 0.5 },
      // Hoarding (囤食): carrying/covering food, a smaller nod.
      hoard: { role: 'walk', speed: 0.75, nod: 0.5, sink: 0.5, squash: 0.95 },
      cache: { role: 'walk', speed: 0.7, nod: 0.45, sink: 0.55, squash: 0.95 },
      bury: { role: 'idle', nod: 0.9, sink: 0.8, squash: 0.88 },
      // Cold (受冻): hunched, shivering.
      cold: { role: 'idle', shake: 1, squash: 0.9, sink: 0.5 },
      shiver: { role: 'idle', shake: 1, squash: 0.88, sink: 0.6 },
      freeze: { role: 'idle', pause: true, shake: 0.45, squash: 0.9, sink: 0.7 },
      huddle: { role: 'idle', pause: true, squash: 0.84, sink: 0.9, shadow: 0.85 },
      // Moving.
      wander: { role: 'walk' },
      explore: { role: 'walk' },
      patrol: { role: 'walk', speed: 0.9 },
      walk: { role: 'walk' },
      travel: { role: 'walk', speed: 1.1 },
      migrate: { role: 'walk', speed: 1.15 },
      // Hunting: stretched, leaning forward, bigger shadow.
      hunt: { role: 'run', speed: 1.1, tilt: -3, squash: 1.02, shadow: 1.15 },
      chase: { role: 'run', speed: 1.2, tilt: -4, shadow: 1.15 },
      strike: { role: 'run', speed: 1.35, tilt: -6, squash: 1.05, shadow: 1.2 },
      scavenge: { role: 'walk', speed: 1.05 },
      // Flight.
      flee: { role: 'run', speed: 1.2 },
      fight: { role: 'run', speed: 1.1, shake: 1, tilt: 3, shadow: 1.1 },
      // A kill being worked through: crouched over the carcass, head down.
      feast: { role: 'idle', nod: 0.9, tilt: 4, squash: 0.9, sink: 0.9, shadow: 0.8 },
      // Social and reproductive.
      court: { role: 'walk', speed: 0.8, nod: 0.6 },
      socialize: { role: 'walk', speed: 0.9 },
      follow: { role: 'walk', speed: 1.05 },
      mate: { role: 'idle', pause: true, nod: 0.4, squash: 0.95 },
      birth: { role: 'idle', pause: true, squash: 0.88, sink: 0.7 },
      play: { role: 'run', speed: 1.05, nod: 0.3 },
    }

    /** Normalised poses, built once: the renderer must not allocate per animal. */
    const POSES = Object.fromEntries(Object.entries(STATE_POSES)
      .map(([id, pose]) => [id, { id, ...POSE_DEFAULTS, ...pose }]))

    /** The fallback for any state id the table does not know (or that is missing). */
    const POSE_FALLBACK = POSES.idle

    /**
     * The behaviour state id of an animal.
     *
     * `state.id` wins; the legacy `intent` field is the fallback so the renderer
     * works before the state machine lands, and a missing field reads as idle.
     * @param {object} animal - the animal.
     * @returns {string} state id.
     */
    function stateIdOf(animal) {
      const state = animal.state
      if (state !== null && state !== undefined && typeof state.id === 'string') return state.id
      if (typeof animal.intent === 'string') return animal.intent
      return 'idle'
    }

    /**
     * Resolve a pose for a state id, with a tolerant match.
     *
     * "eat:grass" and "hoard_cache" must still find their pose: the table is
     * matched on the leading word before any separator.
     * @param {string} id - state id.
     * @returns {object} normalised pose (falls back to idle).
     */
    function poseForId(id) {
      const direct = POSES[id]
      if (direct !== undefined) return direct
      const base = id.toLowerCase().split(/[^a-z0-9]+/)
      for (const word of base) {
        if (word.length === 0) continue
        const found = POSES[word]
        if (found !== undefined) return found
      }
      return POSE_FALLBACK
    }

    /**
     * Poses that only make sense standing at the target.
     *
     * `state.phase` is 'approach' while the animal is still walking to the
     * patch/carcass/water and 'do' once it is there (contract from
     * 10b-execution). A head-down grazing loop played while the animal is
     * crossing the meadow reads as an animal eating while it walks, so the
     * approach phase falls back to the moving pose.
     */
    const DO_POSES = new Set(['graze', 'eat', 'forage', 'browse', 'drink', 'bury',
      'feast', 'bask', 'huddle', 'mate', 'birth', 'socialize', 'court'])

    /**
     * The pose one animal is showing this frame.
     * @param {object} animal - the animal.
     * @returns {object} normalised pose.
     */
    function poseFor(animal) {
      if (animal.fleeing === true) return POSES.flee
      // A predator working through a kill stands still with its head down; the
      // execution state machine flags that with `handling` (12-step-entity), and
      // "intent" still says hunt/scavenge, which would otherwise show a run.
      if (animal.handling === true) return POSES.feast
      const pose = poseForId(stateIdOf(animal))
      const state = animal.state
      if (state === null || state === undefined || typeof state !== 'object') return pose
      // An ambusher does not pursue: for a stalk-and-strike hunter a crouched
      // approach and a short strike read as an ambush, a full run reads as a
      // chase across the meadow.
      if (pose === POSES.hunt) {
        const species = SPECIES[animal.species]
        if (species !== undefined && species.ambush !== undefined) {
          return state.phase === 'do' ? POSES.strike : POSES.stalk
        }
      }
      // Courtship only when the animal is actually receptive.
      if (pose === POSES.socialize) {
        const drives = animal.drives
        if (drives !== undefined && drives !== null && drives.libido > 0.5) return POSES.court
      }
      if (state.phase === 'approach' && DO_POSES.has(pose.id)) return POSES.walk
      return pose
    }

    /**
     * The frame set a pose plays, after the engine's own speed decision.
     * @param {object} animal - the animal.
     * @param {object} pose - its pose.
     * @returns {'idle'|'walk'|'run'} frame role.
     */
    function poseRole(animal, pose) {
      if (animal.fleeing === true) return 'run'
      if (pose.role === 'walk' && animal.running === true) return 'run'
      return pose.role
    }

    /**
     * Build a sprite from a per-pixel painter.
     * @param {number} width - sprite width in pixels.
     * @param {number} height - sprite height in pixels.
     * @param {(x: number, y: number) => number} paint - returns 0 for transparent.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildSprite(width, height, paint) {
      const pixels = new Uint32Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const color = paint(x, y)
          if (color !== 0) pixels[y * width + x] = color
        }
      }
      return { width, height, pixels }
    }

    // ---------------------------------------------------------------------
    // Plant silhouettes
    // ---------------------------------------------------------------------
    //
    // Every tree used to be the *same* shape, only recoloured and moved, and it
    // was the strongest "this was stamped by a machine" tell on the map: a forest
    // of forty identical umbrellas. Each plant now picks one of five silhouettes
    // from its own id, so the forest is made of individuals that never need to be
    // drawn by hand: round, tall, wide, leaning and spire crowns, plus three
    // evergreen cones and a leafless winter skeleton.

    /**
     * Deciduous crown silhouettes.
     *
     * Lobe offsets and radii are in units of the crown radius, so all three sizes
     * share the proportions; `spread`/`flatten` reshape the crown into an
     * ellipse, and the trunk may lean or stay upright.
     */
    const TREE_SHAPES = [
      // 0 · round — the classic compass crown
      {
        lobes: [[0, -0.1, 0.82], [-0.5, 0.3, 0.62], [0.52, 0.26, 0.6], [0, 0.34, 0.56]],
        spread: 1, flatten: 0.92, trunk: { lean: 0, rows: [2, 2, 3], width: [2, 2, 3] },
      },
      // 1 · tall — an upright crown, half a size narrower than round
      {
        lobes: [[0, -0.5, 0.58], [-0.32, 0.02, 0.62], [0.32, 0.16, 0.6], [0, 0.56, 0.52]],
        spread: 0.9, flatten: 1.3, trunk: { lean: 0, rows: [2, 3, 4], width: [2, 2, 2] },
      },
      // 2 · wide — a spreading old crown, wider than it is tall
      {
        lobes: [[-0.62, 0.16, 0.56], [0.62, 0.18, 0.54], [0, 0.02, 0.74], [0, 0.46, 0.5]],
        spread: 1.34, flatten: 0.62, trunk: { lean: 0, rows: [2, 2, 3], width: [3, 3, 4] },
      },
      // 3 · leaning — one side of the crown pushed out over a bent trunk
      {
        lobes: [[0.34, -0.06, 0.74], [-0.3, 0.3, 0.56], [0.66, 0.28, 0.5]],
        spread: 1.05, flatten: 0.9, trunk: { lean: 1.8, rows: [2, 3, 4], width: [2, 2, 3] },
      },
      // 4 · spire — a poplar: narrow and tall, pointed at the top
      {
        lobes: [[0, -0.66, 0.5], [0, -0.2, 0.62], [0, 0.26, 0.64], [0, 0.64, 0.48]],
        spread: 1, flatten: 1.2, trunk: { lean: 0, rows: [2, 3, 4], width: [2, 2, 2] },
      },
    ]

    /** Evergreen silhouettes: a fir, a slim spruce and a broad pine. */
    const CONIFER_SHAPES = [
      { tiers: 6, spread: 1.05, tallness: 1.5, taper: 0.95 },
      { tiers: 7, spread: 0.82, tallness: 1.72, taper: 0.86 },
      { tiers: 4, spread: 1.35, tallness: 1.05, taper: 1.1 },
    ]

    /**
     * Distance from a point to a line segment, for the bare-tree skeleton.
     * @param {number} px - point x.
     * @param {number} py - point y.
     * @param {number} ax - segment start x.
     * @param {number} ay - segment start y.
     * @param {number} bx - segment end x.
     * @param {number} by - segment end y.
     * @returns {number} distance in pixels.
     */
    function distanceToSegment(px, py, ax, ay, bx, by) {
      const vx = bx - ax
      const vy = by - ay
      const lengthSquared = vx * vx + vy * vy
      const t = lengthSquared === 0 ? 0 : clamp(((px - ax) * vx + (py - ay) * vy) / lengthSquared, 0, 1)
      return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
    }

    /**
     * A deciduous tree: an elliptical crown over a trunk.
     *
     * The rim is the whole point: a green blob on a green meadow is invisible, a
     * green blob with a near-black edge and a brown trunk is a tree. Snow settles
     * on the top edge of the crown, which is what keeps a winter forest readable
     * instead of turning it into grey blocks.
     * @param {number} size - 1, 2 or 3.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @param {number} [thin] - 0..1 share of interior canopy lost (autumn).
     * @param {number} [shapeIndex] - silhouette index into TREE_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the top of the crown.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildTreeSprite(size, leaf = PALETTE.leaf, thin = 0, shapeIndex = 0, snowCap = 0) {
      const shape = TREE_SHAPES[shapeIndex % TREE_SHAPES.length]
      const radius = [4.3, 6.0, 7.6][size - 1]
      const trunkRows = shape.trunk.rows[size - 1]
      const trunkWidth = shape.trunk.width[size - 1]
      const width = Math.ceil(radius * 2 * Math.max(1, shape.spread)) + 3
      const canopyHeight = Math.ceil(radius * 1.85 * shape.flatten)
      const height = canopyHeight + trunkRows + 1
      const cx = width / 2
      const cy = canopyHeight / 2
      // Pass 1: the crown mask, so pass 2 can find its own edge and top.
      const mask = new Uint8Array(width * height)
      for (let y = 0; y < canopyHeight; y++) {
        for (let x = 0; x < width; x++) {
          const px = x + 0.5
          const py = y + 0.5
          let margin = -Infinity
          for (const [offsetX, offsetY, lobeRadius] of shape.lobes) {
            const dx = (px - (cx + offsetX * radius)) / shape.spread
            const dy = (py - (cy + offsetY * radius)) / shape.flatten
            margin = Math.max(margin, lobeRadius * radius - Math.hypot(dx, dy))
          }
          if (margin > 0) mask[y * width + x] = 1
        }
      }
      // Pass 2: shade the crown, drop the autumn interior, cap the snow.
      return buildSprite(width, height, (x, y) => {
        if (mask[y * width + x] === 1) {
          const above = y === 0 ? 0 : mask[(y - 1) * width + x]
          const edge = above === 0
            || x === 0 || x === width - 1
            || mask[y * width + x - 1] === 0 || mask[y * width + x + 1] === 0
          // Snow sits on the upper edge only: the canopy keeps its own colour
          // underneath, so the tree still reads as a tree.
          if (snowCap > 0.3 && above === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
          if (thin > 0 && !edge && (((x * 37 + y * 61 + 5) & 31) / 31) < thin * 0.55) return 0
          if (edge) return leaf.outline
          const px = x + 0.5
          const py = y + 0.5
          // Light comes from the top left: -dx -dy is brightest up and left.
          const lit = -(px - cx) / radius * 0.55 - (py - cy) / radius * 0.85
          if (lit > 0.34) return leaf.light
          if (lit < -0.1) return leaf.dark
          return ((x * 5 + y * 3) & 15) < 5 ? leaf.light : leaf.mid
        }
        const trunkTop = canopyHeight - 1
        if (y >= trunkTop) {
          const t = (y - trunkTop) / Math.max(1, height - 1 - trunkTop)
          const centre = cx + shape.trunk.lean * t
          const offset = x + 0.5 - centre
          if (Math.abs(offset) <= trunkWidth / 2) {
            return Math.abs(offset) > trunkWidth / 2 - 1 ? PALETTE.trunkDark : PALETTE.trunk
          }
        }
        return 0
      })
    }

    /**
     * A leafless deciduous tree: trunk and branches only.
     *
     * The winter answer used to be "thin the same green crown by a hash", which
     * printed a grey ring. A real bare tree is a skeleton, so it is drawn as one.
     * @param {number} size - 1, 2 or 3.
     * @param {object} [leaf] - foliage palette, for the branch outline.
     * @param {number} [shapeIndex] - silhouette index, so the skeleton matches.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBareTreeSprite(size, leaf = PALETTE.leaf, shapeIndex = 0) {
      const shape = TREE_SHAPES[shapeIndex % TREE_SHAPES.length]
      const radius = [4.3, 6.0, 7.6][size - 1]
      const width = Math.ceil(radius * 2 * Math.max(1, shape.spread)) + 3
      const height = Math.ceil(radius * 1.95 * shape.flatten) + 2
      const cx = width / 2 + shape.trunk.lean * 0.4
      const baseY = height - 1
      const crownY = Math.max(1, height * 0.16)
      const trunkX = cx - shape.trunk.lean * 0.35
      // Trunk, then four branches per level as two-segment polylines that bend
      // upward: straight spokes read as a spider, a bend reads as a tree.
      const segments = [[cx, baseY, trunkX, crownY]]
      // Four long branches at a steep angle plus a fork at the top. Short flat
      // spokes read as a brown cross; the reach has to be close to the crown
      // radius or the skeleton stops looking like a tree at all.
      const levels = [[0.95, 0.95], [0.8, 1.0], [0.6, 1.0]]
      for (let step = 0; step < levels.length; step += 1) {
        const [spreadAt, rise] = levels[step]
        const t = 0.22 + step * 0.2
        const fromX = cx - (cx - trunkX) * t
        const fromY = baseY - (baseY - crownY) * t
        const reach = radius * spreadAt * Math.max(0.85, shape.spread)
        const side = step % 2 === 0 ? 1 : -1
        const tipX = fromX + side * reach
        const tipY = fromY - radius * rise * 0.8
        segments.push([fromX, fromY, fromX + side * reach * 0.55, fromY - radius * rise * 0.35])
        segments.push([fromX + side * reach * 0.55, fromY - radius * rise * 0.35, tipX, tipY])
        // A short twig on the other side keeps the skeleton from looking combed.
        if (step > 0) segments.push([fromX, fromY, fromX - side * reach * 0.45, fromY - radius * rise * 0.6])
      }
      segments.push([trunkX, crownY, trunkX - radius * 0.42, crownY - radius * 0.5])
      segments.push([trunkX, crownY + 1, trunkX + radius * 0.38, crownY - radius * 0.34])
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let best = Infinity
        for (const [ax, ay, bx, by] of segments) {
          const distance = distanceToSegment(px, py, ax, ay, bx, by)
          if (distance < best) best = distance
        }
        if (best > 0.62) return 0
        return best < 0.34 ? PALETTE.trunk : leaf.outline
      })
    }

    /**
     * An evergreen: stacked tiers of needles, snow-cap on every tier's top.
     *
     * Without evergreens a winter forest is nothing but grey sticks; with them the
     * map keeps a spine of dark green under the snow.
     * @param {number} size - 1, 2 or 3.
     * @param {object} needle - needle palette (seasonal).
     * @param {number} [shapeIndex] - silhouette index into CONIFER_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the tier tops.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildConiferSprite(size, needle, shapeIndex = 0, snowCap = 0) {
      const shape = CONIFER_SHAPES[shapeIndex % CONIFER_SHAPES.length]
      const radius = [3.4, 4.6, 5.8][size - 1]
      const height = Math.ceil(radius * 2.4 * shape.tallness) + 2
      const width = Math.ceil(radius * 2 * shape.spread) + 3
      const cx = width / 2
      const mask = new Uint8Array(width * height)
      const tierHeight = (height - 1) / shape.tiers
      for (let tier = 0; tier < shape.tiers; tier += 1) {
        const top = tier * tierHeight
        const bottom = top + tierHeight + 0.7
        const halfAtBottom = radius * shape.spread * shape.taper * (0.55 + 0.75 * ((tier + 1) / shape.tiers))
        for (let y = Math.round(top); y <= Math.round(bottom) && y < height; y += 1) {
          const t = (y - top) / Math.max(1, bottom - top)
          const half = halfAtBottom * t
          const from = Math.round(cx - half)
          const to = Math.round(cx + half)
          for (let x = from; x <= to; x += 1) {
            if (x >= 0 && x < width) mask[y * width + x] = 1
          }
        }
      }
      return buildSprite(width, height, (x, y) => {
        if (mask[y * width + x] !== 1) return 0
        const above = y === 0 ? 0 : mask[(y - 1) * width + x]
        const edge = above === 0 || x === 0 || x === width - 1
          || mask[y * width + x - 1] === 0 || mask[y * width + x + 1] === 0
        if (snowCap > 0.3 && above === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
        if (edge) return needle.outline
        const lit = -(x + 0.5 - cx) / radius * 0.5
        if (lit > 0.18) return needle.light
        if (lit < -0.2) return needle.dark
        return ((x * 3 + y * 5) & 7) < 3 ? needle.mid : needle.dark
      })
    }

    /** Shrub silhouettes: low and flat, tall and lanky, wide and spreading. */
    const BUSH_SHAPES = [
      [[0, 0, 0.78], [-0.55, 0.2, 0.55], [0.55, 0.16, 0.55]],
      [[0, -0.32, 0.6], [-0.2, 0.28, 0.5], [0.3, 0.24, 0.46], [0, 0.62, 0.36]],
      [[-0.62, 0.1, 0.46], [0.62, 0.14, 0.44], [0, 0, 0.72], [0, 0.4, 0.5]],
    ]

    /**
     * A shrub: the tree canopy without a trunk, so the meadow reads as layers.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @param {number} [thin] - 0..1 share of interior canopy lost.
     * @param {number} [shapeIndex] - silhouette index into BUSH_SHAPES.
     * @param {number} [snowCap] - 0..1 snow on the top of the shrub.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBushSprite(leaf = PALETTE.leaf, thin = 0, shapeIndex = 0, snowCap = 0) {
      const lobes = BUSH_SHAPES[shapeIndex % BUSH_SHAPES.length]
      const radius = 3.1
      const width = Math.ceil(radius * 2) + 2
      const height = Math.ceil(radius * 1.9) + 1
      const cx = width / 2
      const cy = height / 2
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of lobes) {
          margin = Math.max(margin, lobeRadius * radius - Math.hypot(px - (cx + offsetX * radius), (py - (cy + offsetY * radius)) / 0.9))
        }
        if (margin <= 0) return y === height - 1 && Math.abs(px - cx) < 1.2 ? PALETTE.trunkDark : 0
        // Snow caps the top row of the shrub, same rule as the tree crown.
        if (snowCap > 0.3 && y === 0) return snowCap > 0.6 ? SNOW_COLORS.light : SNOW_COLORS.mid
        if (thin > 0 && margin > 1.05 && (((x * 41 + y * 29 + 7) & 31) / 31) < thin * 0.55) return 0
        const lit = -(px - cx) / radius * 0.5 - (py - cy) / radius * 0.9
        if (margin < 1.05) return leaf.outline
        if (lit > 0.3) return leaf.light
        if (lit < -0.15) return leaf.dark
        return ((x * 3 + y * 5) & 15) < 5 ? leaf.light : leaf.mid
      })
    }

    /**
     * A lily pad: flat, notched, floating. The second variant carries a flower,
     * which is the cheapest way to make a pond look alive from a distance.
     * @param {number} variant - 0 plain, 1 flowering.
     * @param {number[]} [weed] - two-shade aquatic plant palette (seasonal).
     * @param {object} [leaf] - foliage palette, for the shaded underside.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildLilySprite(variant, weed = PALETTE.weed, leaf = PALETTE.leaf, snowCap = 0) {
      const width = 10
      const height = variant === 1 ? 7 : 5
      const cy = height - 2
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        const dx = (px - width / 2) / 4.4
        const dy = (py - cy) / 2.1
        if (dx * dx + dy * dy <= 1) {
          if (x >= 5 && y <= cy - 1) return 0
          if (snowCap > 0.4 && py < cy - 0.4) return SNOW_COLORS.mid
          if (py < cy - 0.6) return PALETTE.weedStalk
          if (py > cy + 0.8) return leaf.dark
          return weed[1]
        }
        if (variant === 1 && snowCap < 0.2 && y <= 2 && Math.abs(px - width / 2) < 1.6) {
          return y === 0 ? PALETTE.flowers[1] : PALETTE.flowers[3]
        }
        return 0
      })
    }

    /**
     * A reed clump: three stalks leaning out of the shallows.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildReedSprite(leaf = PALETTE.leaf, snowCap = 0) {
      const width = 9
      const height = 11
      return buildSprite(width, height, (x, y) => {
        const stalk = (baseX, lean, top) => {
          const t = 1 - y / top
          const spanX = baseX + lean * (1 - t) * (1 - t)
          return Math.abs(x + 0.5 - spanX) < 0.62
        }
        if (stalk(3, -1.6, 10) || stalk(5.5, 0.4, 9) || stalk(7.2, 1.8, 7)) {
          // A reed is olive, not teal: the teal read as a weed stalk in the water.
          // The tips stay clear of the snow so the clump still pokes out of it.
          if (snowCap > 0.5 && y > 3 && y < 8) return SNOW_COLORS.mid
          return y < 2 ? PALETTE.trunkDark : (y < 5 ? leaf.light : leaf.mid)
        }
        if (y >= height - 2 && Math.abs(x + 0.5 - 5) < 2.4) return leaf.dark
        return 0
      })
    }

    /**
     * Build the whole plant set for one seasonal look.
     *
     * The set carries every silhouette for every size, for both phenologies, so
     * the per-plant choice (`plantSpriteFor`) is a couple of array reads instead
     * of a sprite build in the draw loop.
     * @param {object} look - `{ leaf, needle, weed, bare, snow }`.
     * @returns {object} the plant sprite set.
     */
    function buildPlantSet(look) {
      const snowCap = look.snow ?? 0
      const thin = look.bare ?? 0
      return {
        // Kept for the engine test seam and for the species sheet.
        tree: [1, 2, 3].map(size => TREE_SHAPES.map((unused, shape) => buildTreeSprite(size, look.leaf, thin, shape, snowCap))),
        conifer: [1, 2, 3].map(size => CONIFER_SHAPES.map((unused, shape) => buildConiferSprite(size, look.needle, shape, snowCap))),
        leafless: [1, 2, 3].map(size => TREE_SHAPES.map((unused, shape) => buildBareTreeSprite(size, look.leaf, shape))),
        bush: BUSH_SHAPES.map((unused, shape) => buildBushSprite(look.leaf, thin, shape, snowCap)),
        lily: [0, 1].map(variant => buildLilySprite(variant, look.weed, look.leaf, snowCap)),
        reed: [buildReedSprite(look.leaf, snowCap)],
        bare: thin,
        snow: snowCap,
      }
    }

    /**
     * Which kind of plant this is, from its own id.
     *
     * Phenology has to be per plant, not per world: a forest where every tree
     * loses its leaves on the same frame pops, while a staggered one turns over
     * like a real autumn.
     * @param {object} plant - the plant record.
     * @returns {boolean} true for an evergreen.
     */
    function isConifer(plant) {
      // A modulus that shares no factor with the silhouette count, otherwise the
      // cone flags and the crown shapes line up and every conifer looks alike.
      return plant.variant === 'tree' && (plant.id % 7) < 2
    }

    /** Shared default look, so the exported sprite set works without a world. */
    const DEFAULT_PLANT_LOOK = {
      leaf: PALETTE.leaf,
      needle: SEASON_LOOK.summer.needle,
      weed: PALETTE.weed,
      bare: 0,
      snow: 0,
    }

    /** Every plant sprite at the default (high summer) palette. */
    const PLANT_SPRITES = buildPlantSet(DEFAULT_PLANT_LOOK)

    /** Seasonal plant sets, keyed by the look's coarse plant key. */
    const plantSetCache = new Map()

    /**
     * Plant sprites for the current seasonal look.
     *
     * Foliage is rebuilt, not tinted: at 6x a tinted canopy reads as a colour
     * filter over the meadow, while an ochre, a bare or a snow-capped one reads
     * as the season.
     * @param {object|null} look - seasonal look (`null` for the default palette).
     * @returns {object} plant sprite set.
     */
    function plantSpritesFor(look) {
      if (look === null || look === undefined) return PLANT_SPRITES
      const key = look.plantKey ?? 0
      const cached = plantSetCache.get(key)
      if (cached !== undefined) return cached
      const set = buildPlantSet(look)
      // Fifty-odd sprites per look and only a few looks are ever alive at once.
      if (plantSetCache.size > 12) plantSetCache.clear()
      plantSetCache.set(key, set)
      return set
    }

    /**
     * The sprite for one plant: size, silhouette and phenology from its id.
     * @param {object} set - plant sprite set for the current look.
     * @param {object} plant - the plant record.
     * @returns {{width: number, height: number, pixels: Uint32Array}|undefined} sprite.
     */
    function plantSpriteFor(set, plant) {
      if (set === null || set === undefined) return undefined
      const id = plant.id | 0
      if (plant.variant === 'lily') return set.lily[id % set.lily.length]
      if (plant.variant === 'reed') return set.reed[0]
      if (plant.variant === 'bush') return set.bush[id % set.bush.length]
      const size = clamp(plant.size ?? 1, 1, 3) - 1
      if (isConifer(plant)) {
        const cones = set.conifer[size]
        return cones[((id >> 1) % cones.length + cones.length) % cones.length]
      }
      // Deciduous trees drop their leaves one by one as the season turns: the
      // threshold is staggered by id so the forest does not pop.
      const leafless = (set.bare ?? 0) > ((id % 7) / 7)
      const group = leafless ? set.leafless[size] : set.tree[size]
      return group[id % group.length]
    }

    /** Carcass: two frames, meat then bones. */
    const CORPSE_SPRITES = [
      compileSprite(['bfb'], { b: PALETTE.corpse.bone, f: PALETTE.corpse.flesh }),
      compileSprite(['b.b'], { b: PALETTE.corpse.bone }),
    ]

    /** Faded body colours used to paint motion trails. */
    const TRAIL_COLORS = Object.fromEntries(SPECIES_IDS.map(id => [id, dimColor({
      rabbit: PALETTE.rabbit.body, deer: PALETTE.deer.body, fox: PALETTE.fox.body,
      wolf: PALETTE.wolf.body, crow: PALETTE.crow.body, fish: PALETTE.fish.body,
      pike: PALETTE.pike.body,
    }[id], 0.42)]))