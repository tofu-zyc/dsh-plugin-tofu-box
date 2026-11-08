    // ---------------------------------------------------------------------
    // Statistics
    // ---------------------------------------------------------------------

    /**
     * Format the in-world clock.
     * @param {object} world - the world.
     * @returns {string} `HH:MM`, 24h.
     */
    function formatClock(world) {
      const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
      const minutes = Math.floor(phase * 24 * 60) % 1440
      const hours = Math.floor(minutes / 60)
      return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    }

    /**
     * Snapshot the world's counters. Pure: the caller decides where to store it.
     * Producer counts are cells above a visible-vegetation threshold.
     * @param {object} world - the world.
     * @returns {object} stats record.
     */
    function sampleStats(world) {
      const counts = {}
      for (const id of SPECIES_IDS) counts[id] = 0
      for (const entity of world.entities) {
        if (counts[entity.species] === undefined) counts[entity.species] = 0
        counts[entity.species] += 1
      }
      let grassCells = 0
      let weedCells = 0
      for (let i = 0; i < world.grass.length; i++) {
        if (world.grass[i] > 0.2) grassCells += 1
        if (world.weed[i] > 0.2) weedCells += 1
      }
      return {
        day: Math.floor(world.time / DAY_SECONDS) + 1,
        clock: formatClock(world),
        grass: grassCells,
        weed: weedCells,
        counts,
        corpses: world.corpses.length,
      }
    }

    /**
     * Append one history sample (used by the population chart).
     * @param {object} world - the world.
     * @returns {object} the sample that was appended.
     */
    function pushHistory(world) {
      const stats = sampleStats(world)
      const sample = {
        t: Math.round(world.time),
        grass: stats.grass,
        weed: stats.weed,
        counts: { ...stats.counts },
      }
      world.history.push(sample)
      if (world.history.length > 200) world.history.shift()
      return sample
    }
