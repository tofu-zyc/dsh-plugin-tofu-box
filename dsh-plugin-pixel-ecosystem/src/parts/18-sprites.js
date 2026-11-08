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
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildTreeSprite(size) {
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
      const leaf = PALETTE.leaf
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
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildBushSprite() {
      const radius = 3.1
      const width = Math.ceil(radius * 2) + 2
      const height = Math.ceil(radius * 1.9) + 1
      const cx = width / 2
      const cy = height / 2
      const leaf = PALETTE.leaf
      return buildSprite(width, height, (x, y) => {
        const px = x + 0.5
        const py = y + 0.5
        let margin = -Infinity
        for (const [offsetX, offsetY, lobeRadius] of [[0, 0, radius * 0.78], [-radius * 0.55, radius * 0.2, radius * 0.55], [radius * 0.55, radius * 0.16, radius * 0.55]]) {
          margin = Math.max(margin, lobeRadius - Math.hypot(px - (cx + offsetX), (py - (cy + offsetY)) / 0.9))
        }
        if (margin <= 0) return y === height - 1 && Math.abs(px - cx) < 1.2 ? PALETTE.trunkDark : 0
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
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildLilySprite(variant) {
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
          if (py > cy + 0.8) return PALETTE.leaf.dark
          return PALETTE.weed[1]
        }
        if (variant === 1 && y <= 2 && Math.abs(px - width / 2) < 1.6) {
          return y === 0 ? PALETTE.flowers[1] : PALETTE.flowers[3]
        }
        return 0
      })
    }

    /**
     * A reed clump: three stalks leaning out of the shallows.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function buildReedSprite() {
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
          return y < 2 ? PALETTE.trunkDark : (y < 5 ? PALETTE.leaf.light : PALETTE.leaf.mid)
        }
        if (y >= height - 2 && Math.abs(x + 0.5 - 5) < 2.4) return PALETTE.leaf.dark
        return 0
      })
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

