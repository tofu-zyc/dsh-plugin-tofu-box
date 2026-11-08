    // ---------------------------------------------------------------------
    // Pixel glyphs (inline SVG, 1 unit = 1 pixel)
    // ---------------------------------------------------------------------

    /** Glyph bitmaps: `.` transparent, `#` primary colour, `+` accent colour. */
    const GLYPHS = {
      grass: ['..#...#..', '..#.#.#..', '.#..#..#.', '.#.##.#..', '#..#..#.#', '...###...'],
      weed: ['..#..#...', '.#..#..#.', '.#.#..#..', '#..#.#...', '.#..#..#.', '..#..##..'],
      tree: ['...###...', '..#####..', '.#######.', '#########', '.#######.', '...###...', '....#....', '....#....'],
      bush: ['..###..', '.#####.', '#######', '.#####.', '...#...'],
      creature: ['.#...#.', '.#####.', '#######', '..#.#..'],
      water: ['#+#+#+#', '+#+#+#+', '#+#+#+#', '+#+#+#+'],
      solid: ['#######', '#+++++#', '#+++++#', '#+++++#', '#+++++#', '#+++++#', '#######'],
      erase: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
      pan: ['...#...', '..###..', '.#.#.#.', '#######', '.#.#.#.', '..###..', '...#...'],
      pointer: ['#.......', '##......', '###.....', '####....', '#####...', '##..#...', '#....#..', '.....#..'],
      pause: ['##.##', '##.##', '##.##', '##.##', '##.##'],
      play: ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],
      step: ['##..#', '##..#', '##..#', '##..#', '##..#'],
      target: ['..###..', '.#...#.', '#..#..#', '#.....#', '#..#..#', '.#...#.', '..###..'],
      close: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    }

    /**
     * Render one glyph as an SVG of 1-unit rects.
     * @param {object} props - `{ name, color, accent, size }`.
     * @returns {object} React element.
     */
    function PixelGlyph(props) {
      const rows = GLYPHS[props.name] ?? GLYPHS.creature
      const color = props.color ?? 'currentColor'
      const accent = props.accent ?? color
      const rects = []
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          const cell = rows[y][x]
          if (cell === '.') continue
          rects.push(h('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1, fill: cell === '+' ? accent : color }))
        }
      }
      return h('svg', {
        width: props.size ?? 16,
        height: props.size ?? 16,
        viewBox: `0 0 ${rows[0].length} ${rows.length}`,
        shapeRendering: 'crispEdges',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', pointerEvents: 'none' },
      }, rects)
    }

    /** The sidebar icon: meadow, tree, water. */
    const PANEL_GLYPH = [
      '..GGG....',
      '.GGGGG...',
      'GGGGGGGG.',
      'GGGGGGGGG',
      '..GGGGGG.',
      '...TTT...',
      '...TTT...',
      'BBBBBBBBB',
      'BbBBBbBBB',
    ]

    /**
     * Sidebar entry icon.
     * @param {object} props - `{ size, active }` from the shell.
     * @returns {object} React element.
     */
    function PanelIcon(props) {
      const size = Math.max(12, Math.min(32, props?.size ?? 18))
      const active = props?.active === true
      const colors = { G: '#4a9d54', T: '#7d5537', B: '#2f6ea8', b: '#63a9d8' }
      const rects = []
      for (let y = 0; y < PANEL_GLYPH.length; y++) {
        for (let x = 0; x < PANEL_GLYPH[y].length; x++) {
          const cell = PANEL_GLYPH[y][x]
          if (cell === '.') continue
          rects.push(h('rect', { key: `${x}-${y}`, x, y, width: 1, height: 1, fill: colors[cell] ?? colors.G }))
        }
      }
      if (active) {
        rects.push(h('rect', {
          key: 'outline', x: 0.25, y: 0.25, width: 8.5, height: 8.5,
          fill: 'none', stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 0.5,
        }))
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 9 9',
        shapeRendering: 'crispEdges', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      }, rects)
    }
