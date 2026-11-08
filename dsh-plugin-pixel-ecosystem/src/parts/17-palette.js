    // ---------------------------------------------------------------------
    // Palette and sprites
    // ---------------------------------------------------------------------


    /**
     * Pack RGB into the little-endian ARGB word `paintWorld` writes.
     * @param {number} red - 0..255.
     * @param {number} green - 0..255.
     * @param {number} blue - 0..255.
     * @returns {number} packed colour.
     */
    function rgb(red, green, blue) {
      return ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0
    }

    /** The world's palette. Artwork only: the panel chrome uses theme tokens. */
    const PALETTE = {
      water: [rgb(36, 92, 132), rgb(44, 106, 150), rgb(56, 122, 168), rgb(74, 142, 188)],
      // Depth ramp. Shallow water is bright and green-blue, the lake floor is
      // nearly navy: that gradient is what makes the lake read as water with a
      // bottom instead of a blue hole in the ground.
      waterSurface: rgb(112, 194, 210),
      waterShallow: rgb(72, 152, 182),
      waterMid: rgb(34, 100, 146),
      waterDeep: rgb(28, 76, 118),
      foam: rgb(210, 242, 248),
      caustic: rgb(150, 222, 232),
      weed: [rgb(64, 138, 104), rgb(96, 178, 124)],
      weedStalk: rgb(126, 210, 146),
      flowers: [rgb(244, 208, 96), rgb(232, 138, 172), rgb(198, 214, 236), rgb(186, 156, 236)],
      sand: [rgb(216, 198, 148), rgb(200, 180, 130), rgb(228, 212, 164)],
      dirt: [rgb(126, 100, 70), rgb(110, 86, 58), rgb(140, 112, 78)],
      stone: [rgb(126, 126, 134), rgb(108, 108, 118), rgb(146, 146, 154)],
      grassDry: [122, 118, 72],
      grassLush: [44, 104, 52],
      leaf: { dark: rgb(28, 68, 38), mid: rgb(46, 102, 50), light: rgb(82, 140, 68), outline: rgb(16, 38, 24) },
      trunk: rgb(96, 66, 42),
      trunkDark: rgb(64, 44, 28),
      rabbit: { body: rgb(158, 132, 104), belly: rgb(238, 228, 212), ear: rgb(196, 162, 148), eye: rgb(38, 28, 22) },
      deer: { body: rgb(136, 94, 58), belly: rgb(206, 182, 152), antler: rgb(178, 156, 116), eye: rgb(36, 26, 20) },
      fox: { body: rgb(208, 112, 58), belly: rgb(246, 232, 214), eye: rgb(42, 32, 24) },
      wolf: { body: rgb(122, 128, 138), dark: rgb(84, 90, 100), belly: rgb(214, 216, 220), eye: rgb(200, 190, 90) },
      crow: { body: rgb(44, 44, 54), wing: rgb(68, 68, 82), eye: rgb(210, 190, 90) },
      fish: { body: rgb(96, 160, 208), belly: rgb(190, 226, 240), fin: rgb(64, 122, 172) },
      pike: { body: rgb(86, 120, 78), dark: rgb(58, 86, 54), fin: rgb(120, 150, 104) },
      corpse: { flesh: rgb(120, 82, 74), bone: rgb(206, 198, 180) },
    }
    /** Effect colours: pure visual feedback, never read back by the simulation. */
    PALETTE.effect = {
      eat: rgb(150, 214, 106),
      hunt: rgb(226, 74, 64),
      death: rgb(96, 78, 70),
      birth: rgb(246, 164, 196),
      alarm: rgb(255, 226, 96),
      // Water feedback: bubbles for anything that happens under the surface,
      // splash for a strike that breaks it.
      bubble: rgb(196, 238, 252),
      splash: rgb(178, 226, 244),
      splashDark: rgb(112, 178, 214),
      nibble: rgb(188, 240, 176),
    }

    // ---------------------------------------------------------------------
    // Seasons, weather and sun direction
    // ---------------------------------------------------------------------
    //
    // The look of the world is a *material* change, not a full-screen filter:
    // grass, foliage and water are rebuilt from a seasonal palette, and the sun
    // direction moves the cast shadows. A tint pass over the finished frame
    // would double up with the day/night wash the panel already draws and would
    // turn every sprite grey in winter.

    /** Seasons in year order; `seasonLook` blends between neighbours. */
    const SEASON_IDS = ['spring', 'summer', 'autumn', 'winter']

    /**
     * Days per year, used only until `climate.yearPhase` exists.
     * Matches docs/10 YEAR_DAYS (8); the stepped climate wins once it lands.
     */
    const SEASON_DAYS = 8

    /**
     * Per-season artwork.
     *
     * `grassDry`/`grassLush` are RGB triples (the ramp builder needs the raw
     * channels), everything else is a packed colour. `snow` is the ground snow
     * cover 0..1 and `bare` the share of canopy lost (autumn thins, winter is
     * bare): those two are what make winter read as winter rather than as "the
     * same meadow, slightly blue".
     */
    const SEASON_LOOK = {
      spring: {
        grassDry: [98, 132, 66],
        grassLush: [50, 118, 54],
        leaf: { dark: rgb(30, 76, 44), mid: rgb(54, 118, 58), light: rgb(98, 160, 76), outline: rgb(16, 40, 26) },
        weed: [rgb(70, 146, 110), rgb(104, 186, 130)],
        water: {
          surface: rgb(120, 200, 214), shallow: rgb(76, 158, 186), mid: rgb(34, 102, 148),
          deep: rgb(30, 80, 122), caustic: rgb(156, 226, 236), foam: rgb(214, 244, 250),
        },
        snow: 0.04,
        bare: 0,
      },
      summer: {
        grassDry: [136, 128, 66],
        grassLush: [36, 94, 46],
        leaf: { dark: rgb(22, 58, 32), mid: rgb(40, 94, 44), light: rgb(74, 132, 60), outline: rgb(12, 32, 20) },
        weed: [rgb(58, 132, 96), rgb(92, 174, 118)],
        water: {
          surface: rgb(104, 188, 204), shallow: rgb(66, 146, 178), mid: rgb(28, 94, 142),
          deep: rgb(24, 72, 112), caustic: rgb(146, 220, 232), foam: rgb(208, 240, 248),
        },
        snow: 0,
        bare: 0,
      },
      autumn: {
        grassDry: [166, 140, 62],
        grassLush: [126, 116, 50],
        leaf: { dark: rgb(92, 50, 24), mid: rgb(164, 98, 38), light: rgb(206, 148, 58), outline: rgb(56, 30, 16) },
        weed: [rgb(104, 118, 66), rgb(140, 148, 84)],
        water: {
          surface: rgb(128, 186, 190), shallow: rgb(84, 138, 148), mid: rgb(44, 96, 120),
          deep: rgb(34, 76, 100), caustic: rgb(170, 210, 210), foam: rgb(216, 236, 238),
        },
        snow: 0.12,
        bare: 0.35,
      },
      winter: {
        grassDry: [182, 176, 150],
        grassLush: [136, 140, 108],
        leaf: { dark: rgb(80, 72, 64), mid: rgb(108, 100, 86), light: rgb(146, 138, 122), outline: rgb(48, 42, 38) },
        weed: [rgb(120, 128, 104), rgb(154, 160, 136)],
        water: {
          surface: rgb(196, 228, 246), shallow: rgb(162, 204, 230), mid: rgb(116, 168, 210),
          deep: rgb(86, 134, 180), caustic: rgb(210, 238, 250), foam: rgb(244, 252, 255),
        },
        snow: 1,
        bare: 1,
      },
    }

    /** Snow and frost colours shared by every season (the cover ramps to them). */
    const SNOW_COLORS = {
      light: rgb(240, 246, 252),
      mid: rgb(212, 226, 238),
      shade: rgb(176, 194, 214),
      blade: rgb(196, 206, 186),
    }

    /** Dust and track colours, for footfalls on dry ground. */
    const DUST_COLORS = [rgb(206, 190, 158), rgb(172, 156, 128)]

    /**
     * Blend two seasonal records of packed colours.
     * @param {object} from - record at t = 0.
     * @param {object} to - record at t = 1.
     * @param {number} t - 0..1.
     * @returns {object} blended record.
     */
    function blendPaletteRecord(from, to, t) {
      const out = {}
      for (const key of Object.keys(from)) out[key] = blendColor(from[key], to[key], t)
      return out
    }

    /**
     * Blend two RGB triples.
     * @param {number[]} from - triple at t = 0.
     * @param {number[]} to - triple at t = 1.
     * @param {number} t - 0..1.
     * @returns {number[]} blended triple.
     */
    function blendTriple(from, to, t) {
      return [mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t)]
    }

    /**
     * Eight-step ground ramp between three anchors: bare, mixed, lush.
     *
     * Two scales is the whole trick behind a meadow that does not read as one
     * flat green sheet: the low half is dry/dormant ground, the high half is
     * living cover. Season only swaps the anchors.
     * @param {number[]} dry - bare-ground triple.
     * @param {number[]} lush - full-cover triple.
     * @returns {number[]} eight packed colours, bare → lush.
     */
    function grassRampFrom(dry, lush) {
      const mid = [(dry[0] + lush[0]) / 2, (dry[1] + lush[1]) / 2, (dry[2] + lush[2]) / 2]
      const ramp = new Array(8)
      for (let step = 0; step < 8; step++) {
        const t = step / 7
        const from = t < 0.5 ? dry : mid
        const to = t < 0.5 ? mid : lush
        const local = t < 0.5 ? t * 2 : (t - 0.5) * 2
        ramp[step] = rgb(
          Math.round(mix(from[0], to[0], local)),
          Math.round(mix(from[1], to[1], local)),
          Math.round(mix(from[2], to[2], local)),
        )
      }
      return ramp
    }

    /**
     * Fraction of the year (0..1), from the climate when it has been stepped.
     * @param {object} world - the world.
     * @returns {number} year phase.
     */
    function yearPhaseOf(world) {
      const climate = world.climate
      if (climate !== null && climate !== undefined && typeof climate.yearPhase === 'number') {
        const phase = climate.yearPhase % 1
        return phase < 0 ? phase + 1 : phase
      }
      const seconds = typeof world.time === 'number' && Number.isFinite(world.time) ? world.time : 0
      const yearSeconds = DAY_SECONDS * SEASON_DAYS
      const phase = (seconds % yearSeconds) / yearSeconds
      return phase < 0 ? phase + 1 : phase
    }

    /**
     * Fraction of the day (0..1), from the climate when it has been stepped.
     * @param {object} world - the world.
     * @returns {number} day phase.
     */
    function dayPhaseOf(world) {
      const climate = world.climate
      if (climate !== null && climate !== undefined && typeof climate.dayPhase === 'number') {
        const phase = climate.dayPhase % 1
        return phase < 0 ? phase + 1 : phase
      }
      const seconds = typeof world.time === 'number' && Number.isFinite(world.time) ? world.time : 0
      const phase = (seconds % DAY_SECONDS) / DAY_SECONDS
      return phase < 0 ? phase + 1 : phase
    }

    /**
     * Where the sun stands: azimuth drives the shadow *direction*, elevation the
     * shadow *length* and the shadow *strength*.
     *
     * One shared vector: the ground pass paints plant shadows and the display
     * pass paints creature shadows, and they have to agree or the meadow looks
     * lit by two suns.
     * @param {object} world - the world.
     * @returns {{azimuth: number, elevation: number, length: number, strength: number}} sun state.
     */
    function sunState(world) {
      const phase = dayPhaseOf(world)
      // Sunrise at 0.22, sunset at 0.78 of the day (matches daylight()).
      const t = (phase - 0.22) / 0.56
      const elevation = t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t)
      const azimuth = (t - 0.5) * 2
      const length = 1 - elevation
      return {
        azimuth,
        elevation,
        length,
        strength: 0.3 + 0.7 * Math.max(0, elevation),
      }
    }

    /**
     * Shadow offset as a fraction of the caster's width.
     *
     * A low sun throws shadows away from it and makes them long; at noon the
     * shadow sits under the object. The cast is *horizontal on screen* because
     * the world is seen from the side, not from above.
     * @param {object} world - the world.
     * @returns {{x: number, y: number, strength: number}} offset fractions.
     */
    function shadowOffset(world) {
      const sun = sunState(world)
      return {
        x: -sun.azimuth * (0.1 + 0.5 * sun.length),
        y: 0.05 + 0.14 * sun.length,
        strength: sun.strength,
      }
    }

    /** Memo for the blended seasonal look: one slot is enough, one world is shown. */
    const seasonMemo = { key: -1, look: null }

    /**
     * The blended seasonal look for this frame.
     *
     * Rebuilt only when the quantised year phase moves, so the per-cell hot loop
     * never does colour maths for the season.
     * @param {object} world - the world.
     * @returns {object} look record.
     */
    function seasonLook(world) {
      const phase = yearPhaseOf(world)
      const seasons = SEASON_IDS.length
      const scaled = phase * seasons
      const index = Math.min(seasons - 1, Math.floor(scaled))
      const local = scaled - index
      const step = Math.round(local * 16)
      const key = index * 17 + step
      if (seasonMemo.key === key) return seasonMemo.look
      const from = SEASON_LOOK[SEASON_IDS[index]]
      const to = SEASON_LOOK[SEASON_IDS[(index + 1) % seasons]]
      const t = step / 16
      // Each season holds its own palette for the first three quarters and only
      // bleeds into the next one at the end. Blending across the whole quarter
      // made mid-winter already half spring: the snow cover was gone by the
      // middle of the season and the ground never actually turned white.
      const eased = smooth(clamp((t - 0.75) / 0.25, 0, 1))
      const look = {
        key,
        // Foliage sprites are rebuilt from scratch, so they use a coarser key.
        plantKey: index * 9 + Math.round(local * 8),
        index,
        t,
        snow: mix(from.snow, to.snow, eased),
        bare: mix(from.bare, to.bare, eased),
        leaf: blendPaletteRecord(from.leaf, to.leaf, eased),
        water: blendPaletteRecord(from.water, to.water, eased),
        weed: [
          blendColor(from.weed[0], to.weed[0], eased),
          blendColor(from.weed[1], to.weed[1], eased),
        ],
        ramp: grassRampFrom(
          blendTriple(from.grassDry, to.grassDry, eased),
          blendTriple(from.grassLush, to.grassLush, eased),
        ),
      }
      seasonMemo.key = key
      seasonMemo.look = look
      return look
    }

    /**
     * Blend a packed colour toward the snow palette.
     * @param {number} color - packed colour.
     * @param {number} amount - 0..1.
     * @returns {number} packed colour.
     */
    function snowed(color, amount) {
      return blendColor(color, SNOW_COLORS.light, amount)
    }

    /**
     * Compile a character-grid sprite into a pixel buffer.
     * `0` is transparent; every other character must name a palette colour.
     * @param {string[]} rows - equal-length rows of characters.
     * @param {object} colors - character → packed colour.
     * @returns {{width: number, height: number, pixels: Uint32Array}} sprite.
     */
    function compileSprite(rows, colors) {
      const height = rows.length
      const width = rows[0].length
      const pixels = new Uint32Array(width * height)
      for (let y = 0; y < height; y++) {
        if (rows[y].length !== width) throw new Error('ragged sprite row')
        for (let x = 0; x < width; x++) {
          const char = rows[y][x]
          if (char === '.') continue
          const color = colors[char]
          if (color === undefined) throw new Error(`unknown sprite colour ${char}`)
          pixels[y * width + x] = color
        }
      }
      return { width, height, pixels }
    }

    /** Every sprite the renderer can draw, compiled once at module load. */