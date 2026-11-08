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