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
     * The pose one animal is showing this frame.
     * @param {object} animal - the animal.
     * @returns {object} normalised pose.
     */
    function poseFor(animal) {
      if (animal.fleeing === true) return POSES.flee
      return poseForId(stateIdOf(animal))
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

    /** Plants: three tree sizes, a shrub, and the two aquatic plants. */
    const PLANT_SPRITES = {
      tree: [1, 2, 3].map(size => buildTreeSprite(size)),
      bush: buildBushSprite(),
      lily: [0, 1].map(variant => buildLilySprite(variant)),
      reed: buildReedSprite(),
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

    /**
     * A tree, drawn rather than hand-lettered so all three sizes share a shape.
     *
     * The canopy is three overlapping lobes with a hard dark rim, a lit top-left
     * and a shaded bottom. The rim is the whole point: a green blob on a green
     * meadow is invisible, a green blob with a near-black edge and a brown trunk
     * is a tree.
     * @param {number} size - 1, 2 or 3.
     * @param {object} [leaf] - foliage palette (seasonal); defaults to the shared one.
     * @param {number} [bare] - 0..1 share of interior canopy lost (autumn→winter).
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildTreeSprite(size, leaf = PALETTE.leaf, bare = 0) {
      const radius = [4.3, 6.0, 7.6][size - 1]
      const trunkHeight = [2, 2, 3][size - 1]
      const trunkWidth = size >= 3 ? 3 : 2
      const width = Math.ceil(radius * 2) + 3
      const canopyHeight = Math.ceil(radius * 1.85)
      const height = canopyHeight + trunkHeight + 1
      const cx = width / 2
      const cy = canopyHeight / 2
      const lobes = [
        [0, -radius * 0.1, radius * 0.82],
        [-radius * 0.5, radius * 0.3, radius * 0.62],
        [radius * 0.52, radius * 0.26, radius * 0.6],
        [0, radius * 0.34, radius * 0.56],
      ]
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of lobes) {
          const dx = px - (cx + offsetX)
          const dy = (py - (cy + offsetY)) / 0.92
          margin = Math.max(margin, lobeRadius - Math.hypot(dx, dy))
        }
        if (margin > 0) {
          // Winter thins the canopy to a skeleton: interior pixels drop out by a
          // hash while the rim and the trunk stay, so the tree keeps a readable
          // silhouette instead of turning into a grey ring.
          if (bare > 0 && margin > 1.15 && (((x * 37 + y * 61 + 5) & 31) / 31) < bare * 0.62) return 0
          // Light comes from the top left: -dx -dy is brightest up and left.
          const lit = -(px - cx) / radius * 0.55 - (py - cy) / radius * 0.85
          if (margin < 1.15) return leaf.outline
          if (lit > 0.34) return leaf.light
          if (lit < -0.1) return leaf.dark
          return ((x * 5 + y * 3) & 15) < 5 ? leaf.light : leaf.mid
        }
        const trunkTop = canopyHeight - 2
        if (y >= trunkTop && y < trunkTop + trunkHeight + 1) {
          const offset = px - cx
          if (Math.abs(offset) <= trunkWidth / 2) {
            if (Math.abs(offset) > trunkWidth / 2 - 1) return PALETTE.trunkDark
            return PALETTE.trunk
          }
        }
        return 0
      })
    }

    /**
     * A shrub: the tree canopy without a trunk, so the meadow reads as layers.
     * @param {object} [leaf] - foliage palette (seasonal).
     * @param {number} [bare] - 0..1 share of interior canopy lost.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBushSprite(leaf = PALETTE.leaf, bare = 0) {
      const radius = 3.1
      const width = Math.ceil(radius * 2) + 2
      const height = Math.ceil(radius * 1.9) + 1
      const cx = width / 2
      const cy = height / 2
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of [[0, 0, radius * 0.78], [-radius * 0.55, radius * 0.2, radius * 0.55], [radius * 0.55, radius * 0.16, radius * 0.55]]) {
          margin = Math.max(margin, lobeRadius - Math.hypot(px - (cx + offsetX), (py - (cy + offsetY)) / 0.9))
        }
        if (margin <= 0) return y === height - 1 && Math.abs(px - cx) < 1.2 ? PALETTE.trunkDark : 0
        if (bare > 0 && margin > 1.05 && (((x * 41 + y * 29 + 7) & 31) / 31) < bare * 0.55) return 0
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
    function buildLilySprite(variant, weed = PALETTE.weed, leaf = PALETTE.leaf) {
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
          if (py < cy - 0.6) return PALETTE.weedStalk
          if (py > cy + 0.8) return leaf.dark
          return weed[1]
        }
        if (variant === 1 && y <= 2 && Math.abs(px - width / 2) < 1.6) {
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
    function buildReedSprite(leaf = PALETTE.leaf) {
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
          return y < 2 ? PALETTE.trunkDark : (y < 5 ? leaf.light : leaf.mid)
        }
        if (y >= height - 2 && Math.abs(x + 0.5 - 5) < 2.4) return leaf.dark
        return 0
      })
    }

    /**
     * Build the whole plant set for one seasonal palette.
     * @param {object} leaf - foliage palette.
     * @param {number[]} weed - aquatic plant palette.
     * @param {number} bare - 0..1 canopy loss.
     * @returns {object} `{ tree, bush, lily, reed }` sprites.
     */
    function buildPlantSet(leaf, weed, bare) {
      return {
        tree: [1, 2, 3].map(size => buildTreeSprite(size, leaf, bare)),
        bush: buildBushSprite(leaf, bare),
        lily: [0, 1].map(variant => buildLilySprite(variant, weed, leaf)),
        reed: buildReedSprite(leaf),
      }
    }

    /** Seasonal plant sets, keyed by the look's coarse plant key. */
    const plantSetCache = new Map()

    /**
     * Plant sprites for the current seasonal look.
     *
     * Foliage is rebuilt, not tinted: at 6x a tinted canopy reads as a colour
     * filter over the meadow, while an ochre or a bare one reads as autumn and
     * winter.
     * @param {object|null} look - seasonal look (`null` for the default palette).
     * @returns {object} plant sprite set.
     */
    function plantSpritesFor(look) {
      if (look === null || look === undefined) return PLANT_SPRITES
      const key = look.plantKey ?? 0
      const cached = plantSetCache.get(key)
      if (cached !== undefined) return cached
      const set = buildPlantSet(look.leaf, look.weed, look.bare)
      plantSetCache.set(key, set)
      return set
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