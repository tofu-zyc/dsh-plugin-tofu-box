    // ---------------------------------------------------------------------
    // Needs, drives, temperament and life stages
    // ---------------------------------------------------------------------
    //
    // Drives are what an animal *wants* right now, and every one of them is
    // derived from the animal's body or its situation, never from a timer:
    // hunger is the reserve emptied (1 - E/Emax), fatigue is what activity has
    // accumulated, fear is a predator in sight, social is "my herd is not here".
    //
    // That derivation is the fix for the 0.2.x bug that made the whole world
    // read as a reaction field: decisions used to run on their own counters, so
    // an animal could stand in grass and starve with its hunger channel pointing
    // the other way.
    //
    // The legacy `needs` record (NEED_KEYS) is kept as a derived view of the
    // drives for the inspector and the older UI, and is still the place where
    // the feeding code writes thirst back when an animal drinks.

    /** Drive channels every animal has (docs/20-CORE-LOOP.md section 2.2). */
    const DRIVE_KEYS = ['hunger', 'thirst', 'cold', 'fatigue', 'fear', 'social', 'curiosity', 'libido']

    /** Legacy need channels the inspector renders; a view over the drives. */
    const NEED_KEYS = ['hunger', 'thirst', 'energy', 'safety', 'social']

    /** Temperament defaults by feeding role; a species row may override `traits`. */
    const ROLE_TRAITS = {
      grazer: { bold: 0.35, social: 0.8, curious: 0.45, territorial: 0.25 },
      hunter: { bold: 0.85, social: 0.5, curious: 0.7, territorial: 0.8 },
      scavenger: { bold: 0.6, social: 0.75, curious: 0.95, territorial: 0.2 },
    }

    /**
     * How loud each drive is, per role. These are the utility weights: a rabbit
     * values safety over food, a wolf values food over safety, a crow is the
     * curious one. Nothing else in the decision system is hand-tuned per species.
     */
    const DRIVE_WEIGHT = {
      grazer: {
        hunger: 1.25, thirst: 0.85, cold: 0.9, fatigue: 0.8,
        fear: 2.4, social: 0.4, curiosity: 0.5, libido: 0.3,
      },
      hunter: {
        hunger: 1.6, thirst: 0.9, cold: 0.8, fatigue: 0.85,
        fear: 1.5, social: 0.35, curiosity: 0.55, libido: 0.4,
      },
      scavenger: {
        hunger: 1.4, thirst: 0.9, cold: 0.85, fatigue: 0.6,
        fear: 1.1, social: 0.6, curiosity: 0.85, libido: 0.3,
      },
    }

    /**
     * Structural maturity at which an animal counts as grown up, 0..1.
     * 0.98 rather than 1 because growth asymptotes: a body a fraction under its
     * adult size is an adult, not a juvenile that will never breed.
     */
    const ADULT_MATURITY_SHARE = 0.98

    /** Share of its own lifespan after which an animal counts as an elder. */
    const ELDER_LIFESPAN_SHARE = 0.75

    /** Size, speed and appetite multipliers per life stage. */
    const STAGE_SCALE = { juvenile: 0.6, adult: 1, elder: 1.03 }
    const STAGE_SPEED = { juvenile: 0.78, adult: 1, elder: 0.82 }
    const STAGE_APPETITE = { juvenile: 1.3, adult: 1, elder: 0.85 }

    /** Intent ids; the UI translates them, nothing else enumerates them. */
    const INTENT_IDS = ['flee', 'forage', 'hunt', 'scavenge', 'drink', 'rest', 'socialize', 'explore']

    /**
     * Reserves this full count as "not hungry". A reserve that is 88% full is
     * comfortable, so hunger reads zero there instead of nudging every animal
     * into a permanent search for food.
     */
    const SATIETY_DEADBAND = 0.12

    /** Seconds of normal activity that fill the thirst ledger. */
    const THIRST_SECONDS = 220

    /** Seconds a bout of company keeps the social channel satisfied. */
    const SOCIAL_SATIATION_SECONDS = 35

    /** Fatigue gained per second of walking, and cleared per second of rest. */
    const FATIGUE_PER_SECOND = 0.012
    const FATIGUE_RECOVERY = 0.055

    /** Seconds of habituation after a bout of exploring before curiosity returns. */
    const HABITUATION_SECONDS = 25

    /** Air temperature in degrees C, from the climate step when it exists. */
    function climateTemperature(world) {
      const climate = world.climate
      if (climate !== undefined && Number.isFinite(climate.temperature)) return climate.temperature
      // Fallback until stepClimate is wired in: a temperate day from the sun angle.
      return 4 + 18 * daylight(world)
    }

    /**
     * Temperament for a species (row override, else role default).
     * @param {object} species - species row.
     * @returns {object} trait record.
     */
    function traitsOf(species) {
      return species.traits ?? ROLE_TRAITS[species.role] ?? ROLE_TRAITS.grazer
    }

    /**
     * The legacy need record of an entity, created on first use so restored
     * saves work. Written back by whoever consumes something (feed() clears
     * thirst when an animal drinks), and re-synced from the drives every tick.
     * @param {object} entity - the animal.
     * @returns {object} mutable needs.
     */
    function needsOf(entity) {
      if (entity.needs === undefined) {
        entity.needs = { hunger: 0.32, thirst: 0.28, energy: 0.15, safety: 0, social: 0.3 }
      }
      return entity.needs
    }

    /**
     * The body view the decision system reads, with a fallback to the flat
     * `entity.energy` field so behaviour works before and after the 09b ledger
     * lands (docs/20-CORE-LOOP.md section 2.1).
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {{reserve: number, reserveMax: number, maturity: number, fatigue: number}} body view.
     */
    function bodyView(entity, species) {
      const body = entity.body
      const reserveMax = species === undefined ? 100 : species.balance.maxEnergy
      const reserve = body !== undefined && Number.isFinite(body.E) ? body.E : entity.energy
      const cap = body !== undefined && Number.isFinite(body.Emax) && body.Emax > 0 ? body.Emax : reserveMax
      const maturity = body !== undefined && Number.isFinite(body.M)
        ? clamp(body.M, 0, 1)
        : (entity.stage === 'juvenile' ? 0.35 : 1)
      const needs = needsOf(entity)
      const fatigue = body !== undefined && Number.isFinite(body.fatigue)
        ? clamp(body.fatigue, 0, 1)
        : clamp(needs.energy, 0, 1)
      return { reserve: Number.isFinite(reserve) ? reserve : 0, reserveMax: cap, maturity, fatigue }
    }

    /** Fatness of an animal: reserve as a share of its reserve ceiling. */
    function fatnessOf(body) {
      return clamp(body.reserve / Math.max(1e-6, body.reserveMax), 0, 1)
    }

    /**
     * Lifespan of one animal in seconds (gene first, species ceiling second).
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {number} seconds, or Infinity when unknown.
     */
    function lifespanOf(entity, species) {
      const gene = entity.genes === undefined ? undefined : entity.genes.lifespan
      if (Number.isFinite(gene)) return gene
      if (Array.isArray(gene)) return gene[1]
      const ranges = species.genes === undefined ? undefined : species.genes.lifespan
      return Array.isArray(ranges) ? ranges[1] : Infinity
    }

    /**
     * Life stage.
     *
     * Maturity is a fact about the BODY, not about the clock: an animal is an
     * adult when its structure has actually grown (body.M), and a stunted
     * animal that never grew up stays a juvenile however old it is. The old
     * age-based rule marked a 174 s rabbit as an elder while its body was 9%
     * adult — and since only adults may breed, it banned reproduction for more
     * than half of every species' life.
     *
     * Age only decides the other end: an elder is an animal past three quarters
     * of its own lifespan. Elders still breed (see stepEntity); being old is a
     * handicap, not a prohibition.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {'juvenile'|'adult'|'elder'} stage.
     */
    function stageOf(entity, species) {
      const lifespan = lifespanOf(entity, species)
      const aged = Number.isFinite(lifespan) && entity.age > lifespan * ELDER_LIFESPAN_SHARE
      const body = entity.body
      const grown = body === undefined || !Number.isFinite(body.M)
        ? entity.age >= species.balance.maturity
        : body.M >= ADULT_MATURITY_SHARE
      // Still growing AND still inside its species' maturation window: juvenile.
      // The second half matters: structural growth is capped by what the animal
      // can afford to eat, so a poorly fed rabbit can reach the end of its life
      // with a 13% body. Calling that a baby for life would ban it from breeding
      // for ever (measured on seed 12345: 279 of 282 rabbits, median maturity
      // 0.13) which empties the food web. A stunted animal is a stunted ADULT.
      if (!grown && entity.age < species.balance.maturity) return 'juvenile'
      return aged && grown ? 'elder' : 'adult'
    }

    /**
     * Age the channels that are ledgers rather than body readings.
     *
     * Hunger, fatigue, fear and the rest are derived in updateDrives(); thirst is
     * a water balance, so it accumulates here and is paid off by drinking (the
     * feeding code writes needs.thirst back down).
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     */
    function decayNeeds(world, entity, species, dt) {
      const needs = needsOf(entity)
      const stage = stageOf(entity, species)
      const appetite = STAGE_APPETITE[stage] * entity.genes.metabolism
      // Thirst follows metabolic turnover, so a hot day and a big body both dry
      // an animal out faster. This is the one channel without a body field yet.
      const heat = 1 + clamp((climateTemperature(world) - 16) / 20, 0, 1) * 0.6
      needs.thirst = clamp(needs.thirst + (1 / THIRST_SECONDS) * appetite * heat * dt, 0, 1)
    }

    /**
     * Accrue or clear fatigue from the effort just spent.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @param {number} effort - pace multiplier this tick (0.12 resting .. 2 running).
     */
    function updateFatigue(entity, dt, effort) {
      const needs = needsOf(entity)
      const body = entity.body
      const resting = effort < 0.5
      // 09b owns body.fatigue once the ledger exists (it charges effort in
      // metabolise()), so the behaviour-side ledger is only a fallback for a
      // body-less animal. Writing both would make the panel and the decision
      // disagree by one tick.
      if (body === undefined || !Number.isFinite(body.fatigue)) {
        const rate = resting
          ? -FATIGUE_RECOVERY * (1 - effort * 0.4)
          : FATIGUE_PER_SECOND * Math.max(0.4, effort)
        needs.energy = clamp(needs.energy + rate * dt, 0, 1)
      }
      const belief = beliefOf(entity)
      if (belief.sites !== undefined) {
        // Habituation fades on its own: a bored animal eventually wants to look
        // around again, but not the instant it stopped.
        entity.habituation = Math.max(0, (entity.habituation ?? 0) - dt / HABITUATION_SECONDS)
      }
    }

    /**
     * Recompute all eight drives from the body and the situation.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {number} dt - step in seconds.
     * @returns {object} the drive record (also stored on the entity).
     */
    function updateDrives(world, entity, species, dt) {
      const body = bodyView(entity, species)
      const fatness = fatnessOf(body)
      const traits = traitsOf(species)
      const needs = needsOf(entity)
      const now = world.time
      const belief = beliefOf(entity)

      // Hunger is the reserve emptying, full stop. Doing this is what removes
      // the "standing in a meadow, starving" class of bug.
      const hunger = clamp((1 - fatness - SATIETY_DEADBAND) / (1 - SATIETY_DEADBAND), 0, 1)

      // Thirst: the water ledger, which only drinking lowers.
      const thirst = clamp(needs.thirst, 0, 1)

      // Cold: air temperature against a comfortable band, softened by body fat.
      const temperature = climateTemperature(world)
      const cold = clamp(((4 - temperature) / 18), 0, 1) * (1 - 0.45 * fatness)

      // Fatigue: the body's own channel when 09b provides one.
      const fatigue = clamp(body.fatigue, 0, 1)

      // Fear: a predator in sight right now, plus the afterglow of the alarm.
      const vision = entity.genes.vision
      let fear = 0
      const threat = belief.threat
      if (beliefFresh(threat, now, BELIEF_LIFETIME.threat)) {
        const nerve = vision * (1.05 + traits.bold * 0.75)
        const distance = Math.hypot(threat.x - entity.x, threat.y - entity.y)
        fear = clamp(1 - distance / Math.max(1, nerve * 1.35), 0.2, 1)
      }
      const alarm = clamp((entity.alarm ?? 0) / ALARM_SECONDS, 0, 1) * 0.85
      entity.fear = Math.max(fear, alarm, (entity.fear ?? 0) - dt * 0.45)
      fear = clamp(entity.fear, 0, 1)

      // Social: how far the animal is from a full herd. Solitary species read
      // zero here instead of carrying a channel they can never satisfy.
      // A bout of socialising also sates the channel for a while: otherwise
      // company stays attractive forever and standing in the herd becomes an
      // absorbing state instead of something an animal does and then leaves.
      entity.socialSated = Math.max(0, (entity.socialSated ?? 0) - dt / SOCIAL_SATIATION_SECONDS)
      let social = 0
      if (species.herd !== undefined) {
        const crowd = species.herd.crowd ?? 4
        const lonely = clamp(1 - (entity.socialCount ?? 0) / crowd, 0, 1)
        const sated = clamp(entity.socialSated, 0, 1)
        social = lonely * clamp(traits.social, 0, 1) * (1 - sated * 0.75)
      }

      // Curiosity: only when fed, calm and not just back from a look around.
      // Juveniles get extra: dispersal away from the natal range is one of the
      // most universal patterns in nature, and it is also what stops a booming
      // cohort from grazing its own birth metre to dust.
      const habituation = clamp(entity.habituation ?? 0, 0, 1)
      const dispersal = entity.stage === 'juvenile' ? 1.5 : 1
      const curiosity = clamp(traits.curious, 0, 1)
        * clamp(1 - hunger * 0.85, 0, 1)
        * clamp(1 - fear, 0, 1)
        * clamp(fatness * 4, 0, 1)
        * (1 - habituation)
        * dispersal

      // Libido: grown (by life stage, not by body size alone) and fat enough to
      // spare the energy, and not on cooldown.
      const libido = (entity.stage === 'juvenile' ? 0 : 1)
        * clamp((fatness - 0.5) / 0.35, 0, 1)
        * (entity.cooldown > 0 ? 0 : 1)

      const drives = {
        hunger: clamp(hunger, 0, 1),
        thirst,
        cold: clamp(cold, 0, 1),
        fatigue,
        fear,
        social: clamp(social, 0, 1),
        curiosity: clamp(curiosity, 0, 1),
        libido: clamp(libido, 0, 1),
      }
      entity.drives = drives

      // Legacy view for the inspector and the older panels. `energy` here means
      // "needs rest", `safety` means "afraid", exactly what NEED_KEYS promises.
      needs.hunger = drives.hunger
      needs.thirst = drives.thirst
      needs.energy = drives.fatigue
      needs.safety = drives.fear
      needs.social = drives.social
      return drives
    }

    /**
     * Weight table for a species' role.
     * @param {object} species - species row.
     * @returns {object} drive weights.
     */
    function driveWeightsOf(species) {
      return DRIVE_WEIGHT[species.role] ?? DRIVE_WEIGHT.grazer
    }

    /**
     * Nearest reachable water cell, for drinking.
     * @param {object} world - the world.
     * @param {number} x - origin column.
     * @param {number} y - origin row.
     * @param {number} radius - search radius in cells.
     * @returns {{x: number, y: number}|null} water cell.
     */
    function nearestWater(world, x, y, radius) {
      const reach = Math.max(2, Math.round(radius))
      let best = null
      let bestDistance = Infinity
      for (let step = 1; step <= reach; step += 1) {
        const samples = step * 8
        for (let index = 0; index < samples; index += 1) {
          const angle = (index / samples) * Math.PI * 2
          const cellX = Math.round(x + Math.cos(angle) * step)
          const cellY = Math.round(y + Math.sin(angle) * step)
          if (cellX < 0 || cellY < 0 || cellX >= world.width || cellY >= world.height) continue
          if (world.terrain[cellY * world.width + cellX] !== TERRAIN.WATER) continue
          const distance = step
          if (distance < bestDistance) {
            bestDistance = distance
            best = { x: cellX, y: cellY }
          }
        }
        if (best !== null) return best
      }
      return best
    }
