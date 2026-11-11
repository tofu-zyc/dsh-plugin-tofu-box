/**
 * Climate: sun angle, season phase, temperature.
 *
 * OWNER: sim-core
 * stepClimate(world, dt) writes world.climate: { t, dayPhase, yearPhase, temperature, sunlight }.
 * Everything that depends on time of day, season or temperature reads from here;
 * no other system may re-derive daylight.
 */
    // ---------------------------------------------------------------------
    // Climate
    // ---------------------------------------------------------------------

    /** Sunrise and sunset as fractions of the in-world day (06:00 and 18:00). */
    const SUNRISE_PHASE = 0.25
    const SUNSET_PHASE = 0.75
    /** Annual mean temperature and the half-amplitude of the seasonal swing, C. */
    const CLIMATE_MEAN_C = 12.5
    const CLIMATE_SEASON_AMPLITUDE_C = 13.5
    /** Diurnal swing around the daily mean, C: warm at noon, cold before dawn. */
    const CLIMATE_DIURNAL_AMPLITUDE_C = 5
    /**
     * How much of the diurnal swing the water feels. A lake is a heat sink: it
     * lags the air and barely moves over a day, which keeps fish from freezing
     * on a winter night the way a bare air formula would make them.
     */
    const WATER_THERMAL_DAMPING = 0.25
    /**
     * Which in-world day the year starts on. Day 1 should be spring, not the
     * dead of winter: a fresh world has to look alive in its first seconds.
     */
    const SEASON_DAY_OFFSET = 2

    /**
     * Evaluate the sky at one instant. Pure: a save only needs the clock, never
     * the climate, because the weather is recomputed from time.
     * @param {object} climate - record to fill in place.
     * @param {number} time - in-world seconds since the start.
     */
    function applyClimate(climate, time) {
      const dayIndex = Math.floor(time / DAY_SECONDS)
      const dayPhase = ((time % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS / DAY_SECONDS
      const yearPhase = (((dayIndex + SEASON_DAY_OFFSET) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS / YEAR_DAYS
      // Sun height: half a sine between sunrise and sunset, exactly zero at
      // night. This is the only place the day/night curve is written down.
      const arc = (dayPhase - SUNRISE_PHASE) / (SUNSET_PHASE - SUNRISE_PHASE)
      const sunHeight = arc <= 0 || arc >= 1 ? 0 : Math.sin(Math.PI * arc)
      // Season: +1 at midsummer (yearPhase 0.5), -1 at midwinter.
      const season = Math.cos(2 * Math.PI * (yearPhase - 0.5))
      // Light at the TOP of the canopy: sun height scaled by how high the sun
      // climbs on this date, so a winter noon is a weak noon.
      const sunlight = clamp(sunHeight * (0.55 + 0.45 * season), 0, 1)
      const dailyMean = CLIMATE_MEAN_C + CLIMATE_SEASON_AMPLITUDE_C * season
      const diurnal = CLIMATE_DIURNAL_AMPLITUDE_C * (sunHeight - 0.5)
      climate.t = time
      climate.day = dayIndex + 1
      climate.dayPhase = dayPhase
      climate.yearPhase = yearPhase
      climate.season = season
      climate.sunlight = sunlight
      climate.temperature = dailyMean + diurnal
      climate.waterTemperature = dailyMean + diurnal * WATER_THERMAL_DAMPING
    }

    /**
     * A fresh climate record (world creation and save restore both use it).
     * @param {number} [time] - in-world seconds.
     * @returns {object} climate.
     */
    function createClimate(time = 0) {
      const climate = {
        /** In-world seconds since the world started. */
        t: time,
        /** In-world day number, 1-based. */
        day: 1,
        /** 0..1 position inside the current day (0 = midnight). */
        dayPhase: 0,
        /** 0..1 position inside the current year (0 = midwinter). */
        yearPhase: 0,
        /** Air temperature, degrees C, at this instant. */
        temperature: CLIMATE_MEAN_C,
        /** Water temperature, degrees C: the air swing damped by the lake. */
        waterTemperature: CLIMATE_MEAN_C,
        /** Surface light reaching the top of the canopy, 0..1. */
        sunlight: 0,
        /** -1 midwinter .. +1 midsummer; the season as one number. */
        season: 0,
      }
      applyClimate(climate, time)
      return climate
    }

    /**
     * Advance the climate by one step (docs/20-CORE-LOOP.md step 1).
     * @param {object} world - the world.
     * @param {number} [dt] - step in seconds; unused, the clock is `world.time`.
     */
    function stepClimate(world, dt) {
      if (world.climate === undefined) world.climate = createClimate(world.time)
      else applyClimate(world.climate, world.time)
    }

    /**
     * Temperature an animal actually feels, C: air for terrestrial bodies, the
     * damped lake temperature for anything living in the water.
     * @param {object} world - the world.
     * @param {object} species - species row.
     * @returns {number} degrees C.
     */
    function feltTemperature(world, species) {
      const climate = world.climate
      if (climate === undefined) return BIO.Q10_REFERENCE_C
      return species?.habitat === 'water' ? climate.waterTemperature : climate.temperature
    }
