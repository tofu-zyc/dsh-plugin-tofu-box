    // ---------------------------------------------------------------------
    // Store: owns the world, the viewport and the simulation loop
    // ---------------------------------------------------------------------

    /** Playback speeds, in simulation-time multipliers. */
    const SPEEDS = [1, 2, 4, 8]

    /** Event kinds the ticker understands, in display order. */
    const EVENT_KINDS = ['predation', 'birth', 'death', 'migration', 'hoard', 'placed']

    /**
     * Death causes the observer can attribute.
     *
     * The engine does not write a cause yet (docs/20-CORE-LOOP.md 2.1,
     * body.cause), so the store infers one from the last state it saw and the
     * panel labels it "inferred". A real cause wins the moment it exists.
     */
    // Must mirror what the engine writes into body.cause (09b-body.js:371/375,
    // 11-feed.js:195): 'injury' used to be missing here, so every animal that
    // died of a failed escape was dropped from the species death-cause bar by
    // the \`CAUSE_KEYS.includes\` filter below — a death the panel could not
    // explain, which is exactly what G5 forbids. tests/client.test.mjs derives
    // the required locale keys from this list, so both sides move together.
    const CAUSE_KEYS = ['predation', 'starved', 'frozen', 'injury', 'old', 'unknown']

    // The inspector draws DRIVE_KEYS, which behaviour owns in 09-needs.js: one
    // list, so a channel that exists in the model cannot be missing from the
    // panel. The order there is the contract order of docs/20-CORE-LOOP.md 2.2.

    /** How many events the store keeps, and how long an event stays news. */
    const MAX_EVENTS = 64
    const EVENT_TTL = 150

    /** Cells between plant-stock samples: the panel needs a trend, not a census. */
    const PLANT_STRIDE = 8

    /** Seconds of history the header pulse summarises. */
    const PULSE_SECONDS = 60

    /** Where the first-run guide remembers that it has been dismissed. */
    const ONBOARD_KEY = 'dsh-pixel-ecosystem:onboarded'

    /**
     * Energy a grazer draws from one cell-unit of each flora field.
     *
     * Derived from the species table instead of a second hand-tuned constant, so
     * the producer side of the energy panel moves when the diet data moves.
     */
    const FLORA_ENERGY = (() => {
      const sum = { grass: 0, weed: 0 }
      const count = { grass: 0, weed: 0 }
      for (const id of SPECIES_IDS) {
        const row = SPECIES[id]
        const field = row.flora
        if (field !== 'grass' && field !== 'weed') continue
        const energy = row.balance === undefined ? undefined : row.balance.floraEnergy
        if (!Number.isFinite(energy)) continue
        sum[field] += energy
        count[field] += 1
      }
      return {
        grass: count.grass === 0 ? 1 : sum.grass / count.grass,
        weed: count.weed === 0 ? 1 : sum.weed / count.weed,
      }
    })()

    /**
     * The browser's localStorage, or null where it is unavailable.
     * @returns {Storage|null} storage.
     */
    function safeLocalStorage() {
      try {
        if (typeof window === 'undefined') return null
        return window.localStorage ?? null
      } catch {
        return null
      }
    }

    /**
     * The body numbers the inspector shows, preferring the real ledger.
     *
     * sim-core owns body.{E,Emax,V,M,health,fatigue} (docs/20-CORE-LOOP.md 2.1).
     * Until a world carries them, the same fields are derived from state the
     * older model already has, and every derived value is flagged so the panel
     * never claims more than it knows.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {object} body view.
     */
    function bodyRecord(entity, species) {
      const balance = species.balance
      const body = entity.body
      if (body !== undefined && body !== null && Number.isFinite(body.E)) {
        return {
          reserve: body.E,
          reserveMax: Number.isFinite(body.Emax) ? body.Emax : balance.maxEnergy,
          structure: Number.isFinite(body.V) ? body.V : null,
          structureUnit: 'kg',
          maturity: Number.isFinite(body.M) ? body.M : null,
          health: Number.isFinite(body.health) ? body.health : null,
          fatigue: Number.isFinite(body.fatigue) ? body.fatigue : null,
          cause: typeof body.cause === 'string' && body.cause !== '' ? body.cause : null,
          derived: false,
        }
      }
      const needs = needsOf(entity)
      return {
        reserve: entity.energy,
        reserveMax: balance.maxEnergy,
        structure: entity.genes.size,
        structureUnit: 'gene',
        maturity: balance.maturity > 0 ? clamp(entity.age / balance.maturity, 0, 1) : 1,
        health: null,
        fatigue: clamp(needs.energy ?? 0, 0, 1),
        cause: null,
        derived: true,
      }
    }

    /**
     * Round to three decimals for display records; keeps snapshots comparable
     * and stops a score from rendering as 1.2400000000000002.
     * @param {number} value - number.
     * @returns {number} rounded, or 0 when not finite.
     */
    function round3(value) {
      return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
    }

    /**
     * Air temperature, preferring the climate step (13b-climate) and falling
     * back to the same sun-angle estimate the cold drive uses, so the header
     * thermometer and the cold bar can never disagree.
     * @param {object} world - the world.
     * @returns {number} degrees C.
     */
    function temperatureOf(world) {
      const climate = world.climate
      if (climate !== undefined && climate !== null && Number.isFinite(climate.temperature)) return climate.temperature
      if (typeof climateTemperature === 'function') return climateTemperature(world)
      return 4 + 18 * daylight(world)
    }

    /**
     * Cold stress, 0 comfortable to 1 freezing. Uses the same band as the drive
     * so an inferred death and a drawn bar agree.
     * @param {object} world - the world.
     * @returns {number} 0..1.
     */
    function coldOf(world) {
      return clamp((4 - temperatureOf(world)) / 18, 0, 1)
    }

    /**
     * The eight drive channels the inspector draws.
     *
     * Behaviour owns the real records (docs/20-CORE-LOOP.md 2.2). Until they
     * exist the panel derives every channel from the body and the needs it
     * already has, using the contract formula hunger = 1 - E/Emax. A drive bar
     * nobody can justify would be worse than an empty one, so the derivation is
     * returned flagged and the panel says so.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @returns {{values: object, derived: boolean}} drives.
     */
    function drivesOf(world, entity, species) {
      if (entity.drives !== undefined && entity.drives !== null) {
        const values = {}
        for (const key of DRIVE_KEYS) values[key] = clamp(Number(entity.drives[key]) || 0, 0, 1)
        return { values, derived: false }
      }
      const needs = needsOf(entity)
      const body = bodyRecord(entity, species)
      const ratio = body.reserveMax > 0 ? clamp(body.reserve / body.reserveMax, 0, 1) : 0
      const traits = traitsOf(species)
      const values = {
        hunger: clamp(1 - ratio, 0, 1),
        thirst: clamp(needs.thirst ?? 0, 0, 1),
        cold: coldOf(world),
        fatigue: clamp(needs.energy ?? 0, 0, 1),
        fear: clamp(needs.safety ?? 0, 0, 1),
        social: clamp(needs.social ?? 0, 0, 1),
        libido: entity.stage === 'adult' && (entity.cooldown ?? 0) <= 0 ? clamp(ratio * 0.9, 0, 1) : 0.05,
        curiosity: 0,
      }
      // Curiosity is what is left when nothing is urgent: a bold, well-fed adult
      // is the one that wanders instead of standing still.
      const urgent = Math.max(values.hunger, values.thirst, values.cold, values.fear)
      values.curiosity = clamp((traits.curious ?? 0.5) * (1 - urgent) * (0.4 + ratio * 0.6), 0, 1)
      return { values, derived: true }
    }

    /**
     * Why this animal is doing what it is doing.
     *
     * Behaviour may publish its own sentence (entity.decideReason, or
     * entity.state.reason). Otherwise the loudest drive explains the intent. The
     * store returns a drive and its value, not a sentence, so the panel stays
     * bilingual.
     * @param {object} entity - the animal.
     * @param {object} drives - drive values.
     * @returns {object} reason record.
     */
    function reasonOf(entity, drives) {
      const decision = entity.decision
      if (decision !== undefined && decision !== null && typeof decision.picked === 'string') {
        const rivals = []
        if (Array.isArray(decision.alternatives)) {
          for (const rival of decision.alternatives.slice(0, 3)) {
            if (rival === null || typeof rival !== 'object') continue
            rivals.push({ kind: String(rival.kind), score: round3(rival.score) })
          }
        }
        return {
          text: typeof decision.text === 'string' ? decision.text : null,
          derived: false,
          picked: decision.picked,
          why: typeof decision.why === 'string' ? decision.why : 'idle',
          score: Number.isFinite(decision.score) ? round3(decision.score) : null,
          at: Number.isFinite(decision.at) ? decision.at : null,
          rivals,
          drive: null,
          driveValue: 0,
        }
      }
      // No decision record yet (a freshly spawned animal, or an older save):
      // the loudest drive still explains the intent, it just explains it less.
      let drive = 'curiosity'
      let top = -1
      for (const key of DRIVE_KEYS) {
        if (key === 'curiosity') continue
        const value = drives[key]
        if (value > top) { top = value; drive = key }
      }
      return {
        text: null, derived: true, picked: null, why: drive, score: null, at: null,
        rivals: [], drive, driveValue: clamp(top, 0, 1),
      }
    }

    /**
     * How many animals that hunt this one are within sight, using the last
     * observation instead of a fresh spatial query.
     * @param {object} observation - the last observation.
     * @param {string} speciesId - the species being looked at.
     * @param {number} x - position.
     * @param {number} y - position.
     * @param {number} radius - cells.
     * @returns {number} count.
     */
    function predatorsNear(observation, speciesId, x, y, radius) {
      if (observation === null) return 0
      const hunters = PREDATORS_OF[speciesId]
      if (hunters === undefined || hunters.size === 0) return 0
      const reach = radius * radius
      let found = 0
      for (const hunter of observation.hunters) {
        if (!hunters.has(hunter.species)) continue
        const dx = hunter.x - x
        const dy = hunter.y - y
        if (dx * dx + dy * dy <= reach) found += 1
      }
      return found
    }

    /**
     * The most likely way this animal dies if nothing changes.
     *
     * G5 wants failure to be explainable, and that has to work *before* the
     * animal is gone, which is exactly when the inspector can still be opened.
     * @param {object} entity - the animal.
     * @param {object} body - body view.
     * @param {object} drives - drive values.
     * @param {object} observation - the last observation.
     * @returns {string|null} cause key, or null when nothing is looming.
     */
    function predictCause(entity, body, drives, observation) {
      if (drives.hunger >= 0.75) return 'starved'
      if (drives.cold >= 0.65) return 'frozen'
      if (drives.fear >= 0.6 && predatorsNear(observation, entity.species, entity.x, entity.y, 8) > 0) return 'predation'
      if (Number.isFinite(entity.genes.lifespan) && entity.age >= entity.genes.lifespan * 0.85) return 'old'
      // Health only drains from starvation, cold and an untreated wound; the
      // first two are caught above, so the honest remaining prognosis is the wound.
      if (body.health !== null && body.health <= 0.25) return 'injury'
      return null
    }

    /**
     * Sample the standing producer stock without walking a quarter million cells.
     *
     * A strided sample is what an "is the meadow shrinking" panel needs; a full
     * census of the field costs more than drawing it.
     * @param {object} world - the world.
     * @returns {{grass: number, weed: number, energy: number}} mean cover and total energy.
     */
    function samplePlantStock(world) {
      const grass = world.grass
      const weed = world.weed
      const width = world.width
      const height = world.height
      let grassSum = 0
      let weedSum = 0
      let samples = 0
      for (let y = 0; y < height; y += PLANT_STRIDE) {
        const row = y * width
        for (let x = 0; x < width; x += PLANT_STRIDE) {
          grassSum += grass[row + x]
          weedSum += weed[row + x]
          samples += 1
        }
      }
      if (samples === 0) return { grass: 0, weed: 0, energy: 0 }
      const scale = (width * height) / samples
      return {
        grass: grassSum / samples,
        weed: weedSum / samples,
        // Biomass is kg per square metre, so one sample stands for a cell area of
        // ground, not one cell of pixels (docs/10 section 1: CELL_M = 2 m).
        energy: (grassSum * FLORA_ENERGY.grass + weedSum * FLORA_ENERGY.weed) * scale * CELL_AREA,
      }
    }

    /**
     * Attribute a death from the last state the animal was seen in.
     *
     * Order matters: the simulation kills on an empty reserve or on age, and a
     * predator removes an animal that still had reserves, so reserve is checked
     * first and a nearby hunter only decides an otherwise unexplained death.
     * @param {object} rec - last record of the animal.
     * @param {object[]} hunters - hunter positions from that sighting.
     * @returns {string} one of CAUSE_KEYS.
     */
    function classifyDeath(rec, hunters) {
      if (rec.cause !== null && rec.cause !== undefined) return rec.cause
      const predators = PREDATORS_OF[rec.species]
      let best = Infinity
      if (predators !== undefined && predators.size > 0 && rec.ratio > 0.02) {
        for (const hunter of hunters) {
          if (!predators.has(hunter.species)) continue
          const dx = hunter.x - rec.x
          const dy = hunter.y - rec.y
          const distance = dx * dx + dy * dy
          if (distance < best) best = distance
        }
      }
      if (best <= 20.25) return 'predation'
      if (rec.ratio <= 0.02) return 'starved'
      if (Number.isFinite(rec.lifespan) && rec.age >= rec.lifespan * 0.92) return 'old'
      if (rec.cold >= 0.6) return 'frozen'
      if (rec.health !== null && rec.health <= 0.2) return 'injury'
      return 'unknown'
    }

    /**
     * Create the world store for one plugin instance.
     *
     * The store owns the world and the rAF loop; the panel owns the camera and
     * tells the store which window to paint. Only the visible cells are rendered,
     * so a large map costs the same as a small one.
     * @param {object} [options] - `{ storage?, now?, requestFrame?, cancelFrame? }`.
     * @returns {object} the store.
     */
    function createStore(options = {}) {
      const storage = options.storage !== undefined ? options.storage : safeLocalStorage()
      const clock = typeof options.now === 'function'
        ? options.now
        : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now())
      const requestFrame = typeof options.requestFrame === 'function'
        ? options.requestFrame
        : callback => (typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(callback)
          : setTimeout(() => callback(clock()), 16))
      const cancelFrame = typeof options.cancelFrame === 'function'
        ? options.cancelFrame
        : handle => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle))

      let world = null
      let canvas = null
      let context = null
      let imageData = null
      let frameBuffer = null
      let frameHandle = 0
      let lastStamp = 0
      let accumulator = 0
      let alpha = 1
      let clockAccumulator = 0
      let saveAccumulator = 0
      let minimapAccumulator = 0
      let minimap = null
      let offscreen = null
      let offscreenContext = null
      let paused = false
      let speed = 2
      let selectedId = 0
      let follow = false
      let hover = null
      let disposed = false
      let snapshot = null
      /** Called by draw() when the painted size and the box size disagree. */
      let viewportListener = null
      let viewportAskedAt = 0
      let pendingSnapshot = false
      let view = { x: 0, y: 0, width: 0, height: 0 }
      const brush = { tool: 'grass', radius: 1 }
      const listeners = new Set()
      /** First-run flag; null means "not read from storage yet". */
      let onboardingFlag = null
      /** One-shot message about the save file: legacy format or a failed read. */
      let notice = null
      /** Bumped whenever the world object is replaced, to cancel stale work. */
      let worldToken = 0
      /** The in-flight first load, so every caller shares one. */
      let loadPromise = null
      /** True while a compressed save is being written. */
      let savePending = false
      /** What the panel says about the autosave: size, when, and how it went. */
      let saveState = { size: 0, at: 0, pending: false, failed: false, stored: false }

      /**
       * Install a world object and point the renderer at it.
       *
       * The view request may have arrived before the world did (the canvas is
       * attached during the first render), so it is replayed here: now that the
       * real world size is known, setView() clamps it and sizes the buffers.
       * @param {object} next - the world to adopt.
       * @returns {object} the same world.
       */
      function adoptWorld(next) {
        world = next
        worldToken += 1
        world.hydrologyDirty = false
        minimap = null
        const request = { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale }
        view = { x: 0, y: 0, width: 0, height: 0, scale: view.scale }
        // A first render has no view request yet; attach() picks the default.
        if (request.width > 0 && request.height > 0) setView(request)
        return world
      }

      /**
       * Unpack the first save and adopt it.
       *
       * Only this path is asynchronous: a save is gzipped, and gzip needs
       * unpackWorld(). The store therefore keeps `world === null` and `loading`
       * true for the few dozen milliseconds it takes, and the panel says so
       * instead of showing an empty world.
       * @param {string} raw - the stored payload.
       * @returns {Promise<object|null>} the world, once there is one.
       */
      function startLoad(raw) {
        if (loadPromise !== null) return loadPromise
        const token = worldToken
        loadPromise = decodeStored(raw)
          .then((stored) => {
            if (worldToken !== token) return world
            notice = stored.notice
            const adopted = adoptWorld(stored.world === null ? createWorld() : stored.world)
            if (stored.world !== null) {
              // A resumed world already has a save in storage; show its size in the
              // header straight away instead of waiting for the next autosave.
              saveState = { size: raw.length, at: adopted.time, pending: false, failed: false, stored: true }
            }
            return adopted
          })
          .catch(() => {
            // A world that cannot be loaded must never leave the panel empty.
            return worldToken === token ? adoptWorld(createWorld()) : world
          })
          .then(() => {
            publish()
            return world
          })
        return loadPromise
      }

      /**
       * The world for this store, creating one when there is nothing to load.
       *
       * Synchronous by contract: the tests, the scene lab and the panel's first
       * render all treat this as "give me the world now". That is possible in
       * every case except resuming a compressed save, which is the one path that
       * returns null and settles through whenReady().
       * @returns {object|null} the world, or null while a save is being unpacked.
       */
      function ensureWorld() {
        if (world !== null) return world
        const stored = readRaw()
        if (stored.raw === null || stored.raw === '') {
          // Nothing to decompress. An old build's world may still sit in the v1
          // key: report it, leave it exactly where it is, and start fresh.
          if (stored.legacy !== null && stored.legacy !== '') notice = { kind: 'legacy', detail: null }
          return adoptWorld(createWorld())
        }
        startLoad(stored.raw)
        return null
      }

      /**
       * Wait until a world exists. The formal entry point for the async path.
       * @returns {Promise<object|null>} the world.
       */
      function whenReady() {
        if (world !== null) return Promise.resolve(world)
        ensureWorld()
        return loadPromise === null ? Promise.resolve(world) : loadPromise.then(() => world)
      }

      /**
       * Read both storage keys without interpreting them. Synchronous on purpose:
       * deciding whether there is anything to decompress must not need a promise.
       * @returns {{raw: string|null, legacy: string|null}} stored payloads.
       */
      function readRaw() {
        const result = { raw: null, legacy: null }
        if (storage === null) return result
        try {
          result.raw = storage.getItem(STORAGE_KEY)
        } catch {
          result.raw = null
        }
        if (result.raw === null || result.raw === undefined || result.raw === '') {
          try {
            result.legacy = storage.getItem(LEGACY_STORAGE_KEY)
          } catch {
            result.legacy = null
          }
        }
        return result
      }

      /**
       * Unpack and validate one stored payload, turning a failure into a notice.
       *
       * 0.2.x swallowed every load failure, so a corrupted or version-mismatched
       * save looked exactly like a first run. G5 (failure must be explainable)
       * needs the opposite: the reason travels with the result and the panel
       * shows it instead of quietly starting over.
       * @param {string} raw - the stored payload.
       * @returns {Promise<{world: object|null, notice: object|null}>} world and notice.
       */
      async function decodeStored(raw) {
        try {
          // Both formats arrive here: a gzipped payload from packWorld, and the
          // plain JSON an older autosave or the teardown path may have written.
          const payload = await unpackWorld(raw)
          return { world: deserializeWorld(payload), notice: null }
        } catch (error) {
          const detail = error !== null && error !== undefined && error.message !== undefined
            ? String(error.message)
            : String(error)
          // saveError() tags the reason: unsupported_version | corrupt |
          // no_decompressor. The panel turns the code into a sentence instead of
          // showing one vague "load failed" to everyone.
          const code = error !== null && error !== undefined && typeof error.code === 'string'
            ? error.code
            : 'corrupt'
          return { world: null, notice: { kind: 'load', code, detail } }
        }
      }

      /**
       * Read the stored world and say what happened to it.
       *
       * 0.2.x swallowed every load failure, so a corrupted or version-mismatched
       * save looked exactly like a first run. G5 (failure must be explainable)
       * needs the opposite: the reason travels with the result and the panel
       * shows it instead of quietly starting over.
       * @returns {Promise<{world: object|null, notice: object|null}>} world and notice.
       */
      async function readStored() {
        const stored = readRaw()
        if (stored.raw === null || stored.raw === '') {
          return {
            world: null,
            notice: stored.legacy === null || stored.legacy === '' ? null : { kind: 'legacy', detail: null },
          }
        }
        return decodeStored(stored.raw)
      }

      /**
       * Persist the world, compressed, without blocking a frame.
       *
       * packWorld() gzips several megabytes of JSON, which is tens of
       * milliseconds: enough to drop frames if it ran on the animation loop. It
       * therefore runs off a microtask, and a re-entrancy guard stops a slow save
       * from stacking up when the player scrubs speed.
       * @returns {Promise<boolean>} true when the world reached storage.
       */
      function save() {
        if (storage === null || world === null) return Promise.resolve(false)
        if (savePending) return Promise.resolve(false)
        const token = worldToken
        const target = world
        const savedAt = target.time
        savePending = true
        saveState = { size: saveState.size, at: savedAt, pending: true, failed: false, stored: saveState.stored }
        markDirty()
        return Promise.resolve()
          .then(() => (typeof packWorld === 'function'
            ? packWorld(target)
            : { text: JSON.stringify(serializeWorld(target)), bytes: 0 }))
          .then((packed) => {
            // A world that was replaced while packing must not be written over
            // the new one.
            if (worldToken !== token) return false
            try {
              storage.setItem(STORAGE_KEY, packed.text)
              const size = Number.isFinite(packed.bytes) && packed.bytes > 0 ? packed.bytes : packed.text.length
              saveState = { size, at: savedAt, pending: false, failed: false, stored: true }
              return true
            } catch {
              // Quota or disabled storage: keep playing, and let the panel say so.
              saveState = { size: 0, at: savedAt, pending: false, failed: true, stored: saveState.stored }
              return false
            }
          })
          .catch(() => {
            saveState = { size: 0, at: savedAt, pending: false, failed: true, stored: saveState.stored }
            return false
          })
          .finally(() => {
            savePending = false
            markDirty()
          })
      }

      /**
       * Save right now, compressed. Awaitable, so a caller that is about to close
       * or hide the panel can make sure the write landed.
       * @returns {Promise<boolean>} true when the world reached storage.
       */
      function saveNow() {
        return save()
      }

      /**
       * Last-resort synchronous save, for page teardown only.
       *
       * A gzip cannot finish once the page is closing, so this writes the
       * uncompressed (coarsely packed) payload instead: roughly half the raw JSON
       * and over the 5 MB quota on a full-size world, which is why it is the
       * fallback and not the normal path. unpackWorld accepts both forms and the
       * header records the packing, so a save written here still loads.
       * @returns {boolean} true when the payload reached storage.
       */
      function saveSync() {
        if (storage === null || world === null) return false
        try {
          const text = JSON.stringify(serializeWorld(world, { detail: 'low' }))
          storage.setItem(STORAGE_KEY, text)
          saveState = { size: text.length, at: world.time, pending: false, failed: false, stored: true }
          return true
        } catch {
          return false
        }
      }

      /**
       * Whether the first-run guide has been dismissed.
       * Storage may be missing (private mode, tests); the flag then lives for
       * this session only, which is better than showing the guide forever.
       * @returns {boolean} seen.
       */
      function onboardingSeen() {
        if (onboardingFlag !== null) return onboardingFlag
        onboardingFlag = false
        if (storage !== null) {
          try {
            onboardingFlag = storage.getItem(ONBOARD_KEY) === '1'
          } catch {
            onboardingFlag = false
          }
        }
        return onboardingFlag
      }

      /** Remember that the guide was dismissed, and repaint. */
      function markOnboardingSeen() {
        onboardingFlag = true
        if (storage !== null) {
          try {
            storage.setItem(ONBOARD_KEY, '1')
          } catch {
            // Storage full or disabled: the guide stays dismissed this session.
          }
        }
        publish()
      }

      /** Dismiss the save-file notice for this session. */
      function dismissNotice() {
        notice = null
        publish()
      }

      /** Show the guide again ("How to play" -> start over). */
      function resetOnboarding() {
        onboardingFlag = false
        if (storage !== null) {
          try {
            storage.removeItem(ONBOARD_KEY)
          } catch {
            // Nothing to clean up.
          }
        }
        publish()
      }

      /** Ask for a React snapshot on the next tick, at most a few times a second. */
      function markDirty() {
        pendingSnapshot = true
      }

      /** Drop the snapshot and notify React. */
      function publish() {
        snapshot = null
        for (const listener of listeners) listener()
      }

      // -------------------------------------------------------------------
      // Observation
      //
      // The engine records what happened; this layer answers the questions a
      // player actually asks: who is left, where was it, why did it die, and
      // where is the energy going. Everything below is derived by watching the
      // world and never writes to it, so it keeps working as the simulation
      // underneath is rewritten.
      // -------------------------------------------------------------------
      let observedWorld = null
      let observation = null
      let events = []
      let eventSeq = 0
      const causeTally = {}
      const deathCount = {}
      /** How many death causes came from a carcass and how many were inferred. */
      const causeSource = { exact: 0, inferred: 0 }
      const placedIds = new Set()
      const corpseSeen = new Set()
      const rateIntake = {}
      const rates = { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0 }

      /**
       * Drop the observation state and start watching a new world.
       * Ids restart with a new world, so keeping the old records would read as
       * one huge die-off the moment the player presses "new world".
       */
      function resetObservation() {
        observation = null
        events = []
        eventSeq = 0
        placedIds.clear()
        corpseSeen.clear()
        for (const key of Object.keys(causeTally)) delete causeTally[key]
        for (const key of Object.keys(deathCount)) delete deathCount[key]
        causeSource.exact = 0
        causeSource.inferred = 0
        for (const key of Object.keys(rateIntake)) delete rateIntake[key]
        rates.gpp = 0
        rates.herbs = 0
        rates.carns = 0
        rates.respire = 0
        rates.plantRespire = 0
      }

      /**
       * Record one species' death causes, creating the bucket on first use.
       * @param {string} speciesId - species id.
       * @returns {object} mutable cause buckets.
       */
      function causeBucket(speciesId) {
        if (causeTally[speciesId] === undefined) causeTally[speciesId] = {}
        return causeTally[speciesId]
      }

      /**
       * Push one event into the ticker and keep the ticker short.
       * @param {string} kind - EVENT_KINDS member.
       * @param {string} speciesId - species id.
       * @param {number} x - position.
       * @param {number} y - position.
       * @param {number} count - how many animals the event covers.
       * @param {number} [id] - entity id, when the event is about one animal.
       * @param {string} [cause] - death cause, when the kind carries one.
       */
      function pushEvent(kind, speciesId, x, y, count, id, cause) {
        eventSeq += 1
        events.push({
          seq: eventSeq,
          t: Math.round(observedWorld === null ? 0 : observedWorld.time),
          kind,
          species: speciesId,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          count: Math.max(1, count | 0),
          id: typeof id === 'number' ? id : 0,
          cause: typeof cause === 'string' ? cause : null,
        })
      }

      /**
       * Count same-species animals in the coarse cells around a point.
       * The bucket holds the species of every animal in a 4x4 cell block, so a
       * newborn is recognised by its litter and an arrival from off-map is not.
       * @param {Map<number, string[]>} cells - coarse occupancy index.
       * @param {number} x - position.
       * @param {number} y - position.
       * @param {string} speciesId - species to count.
       * @returns {number} neighbours, including the caller itself.
       */
      function kinsAround(cells, x, y, speciesId) {
        const cx = (x | 0) >> 2
        const cy = (y | 0) >> 2
        let found = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = cells.get((cx + dx) * 4096 + (cy + dy))
            if (bucket === undefined) continue
            for (const id of bucket) if (id === speciesId) found += 1
          }
        }
        return found
      }

      /**
       * Read the world once and turn it into a census, an event feed and a
       * measured energy budget.
       * @param {object} world - the world.
       * @returns {object|null} the observation, or null when there is no world.
       */
      function observe(world) {
        if (observedWorld !== world) {
          observedWorld = world
          resetObservation()
        }
        const now = world.time
        const previous = observation
        // A paused world still needs a fresh census (the player places animals
        // while paused), but a zero-length interval cannot carry a rate, so the
        // flows below are the only part gated on time actually passing.
        const dt = previous === null ? 0 : Math.max(0, now - previous.time)
        const hunters = []
        const seen = new Map()
        const cells = new Map()
        const species = {}
        for (const id of SPECIES_IDS) {
          species[id] = { count: 0, sumE: 0, sumMax: 0, sumAge: 0, respire: 0, hungry: 0 }
        }

        for (const entity of world.entities) {
          const row = SPECIES[entity.species]
          if (row === undefined) continue
          const balance = row.balance
          const body = entity.body
          const reserve = body === undefined || body === null || !Number.isFinite(body.E) ? entity.energy : body.E
          const reserveMax = body === undefined || body === null || !Number.isFinite(body.Emax) ? balance.maxEnergy : body.Emax
          const ratio = reserveMax > 0 ? clamp(reserve / reserveMax, 0, 1) : 0
          const bucket = species[entity.species]
          if (bucket !== undefined) {
            bucket.count += 1
            bucket.sumE += reserve
            bucket.sumMax += reserveMax
            bucket.sumAge += entity.age
            // Maintenance power, kJ per in-world day: the buffer's own number
            // from the DEB ledger. The old per-second drain stays as the
            // fallback so a save from before the ledger still shows a budget.
            bucket.respire += body !== undefined && body !== null && Number.isFinite(body.pMetabolism)
              ? Math.max(0, body.pMetabolism)
              : (balance.drain * entity.genes.metabolism + (entity.fleeing === true ? (balance.fleeDrain ?? 0) : 0)) * DAY_SECONDS
            if (ratio < 0.35) bucket.hungry += 1
          }
          if (row.role === 'hunter') hunters.push({ id: entity.id, species: entity.species, x: entity.x, y: entity.y })
          const key = ((entity.x | 0) >> 2) * 4096 + ((entity.y | 0) >> 2)
          const occupants = cells.get(key)
          if (occupants === undefined) cells.set(key, [entity.species])
          else occupants.push(entity.species)
          seen.set(entity.id, {
            species: entity.species,
            x: entity.x,
            y: entity.y,
            ratio,
            age: entity.age,
            lifespan: entity.genes.lifespan,
            cold: entity.drives === undefined || !Number.isFinite(entity.drives.cold) ? coldOf(world) : clamp(entity.drives.cold, 0, 1),
            health: body === undefined || body === null || !Number.isFinite(body.health) ? null : body.health,
            // A living body carries cause: '' — that is "not dead", not a cause.
            cause: body === undefined || body === null || typeof body.cause !== 'string' || body.cause === ''
              ? null
              : body.cause,
          })
        }

        const plants = samplePlantStock(world)
        const birthBatch = new Map()
        const deathBatch = new Map()
        const arrivalBatch = new Map()
        const placements = []
        // A carcass carries the cause the engine wrote (dieOf in 09b-body), which
        // makes the death panel exact instead of inferred. Scavengers eat corpses,
        // so some are gone before this sweep sees them; those fall back to the
        // inference in classifyDeath and are still counted.
        const explained = new Map()
        for (const corpse of world.corpses) {
          if (corpse === null || typeof corpse !== 'object') continue
          if (corpseSeen.has(corpse.id)) continue
          corpseSeen.add(corpse.id)
          if (typeof corpse.cause !== 'string' || corpse.cause === '') continue
          if (!CAUSE_KEYS.includes(corpse.cause)) continue
          const pool = explained.get(corpse.species)
          const hit = { cause: corpse.cause, x: corpse.x, y: corpse.y }
          if (pool === undefined) explained.set(corpse.species, [hit])
          else pool.push(hit)
        }
        if (corpseSeen.size > 2048) {
          // Corpses are transient; rebuilding from the live list keeps this set
          // from growing for the whole session.
          corpseSeen.clear()
          for (const corpse of world.corpses) {
            if (corpse !== null && typeof corpse === 'object') corpseSeen.add(corpse.id)
          }
        }

        if (previous !== null) {
          for (const [id, rec] of seen) {
            if (previous.seen.has(id)) continue
            if (placedIds.has(id)) {
              placedIds.delete(id)
              placements.push({ species: rec.species, x: rec.x, y: rec.y })
              continue
            }
            const immigration = world.lastImmigration
            const immigrated = immigration !== undefined && immigration !== null &&
              immigration.species === rec.species && (now - immigration.at) <= 2
            if (!immigrated && kinsAround(cells, rec.x, rec.y, rec.species) > 1) {
              birthBatch.set(rec.species, (birthBatch.get(rec.species) ?? 0) + 1)
            } else {
              arrivalBatch.set(rec.species, (arrivalBatch.get(rec.species) ?? 0) + 1)
            }
          }

          let kills = 0
          for (const [id, rec] of previous.seen) {
            if (seen.has(id)) continue
            const pool = explained.get(rec.species)
            const hit = pool === undefined || pool.length === 0 ? null : pool.pop()
            const cause = hit === null ? classifyDeath(rec, previous.hunters) : hit.cause
            // The panel marks the difference: a carcass carries the cause the
            // engine wrote, everything else is this layer's inference.
            if (hit === null) causeSource.inferred += 1
            else causeSource.exact += 1
            const atX = hit === null ? rec.x : hit.x
            const atY = hit === null ? rec.y : hit.y
            const causes = causeBucket(rec.species)
            causes[cause] = (causes[cause] ?? 0) + 1
            deathCount[rec.species] = (deathCount[rec.species] ?? 0) + 1
            if (cause === 'predation' && kills < 3) {
              kills += 1
              pushEvent('predation', rec.species, atX, atY, 1, 0, cause)
            } else {
              const key = rec.species + '|' + cause
              const row = deathBatch.get(key)
              if (row === undefined) deathBatch.set(key, { species: rec.species, cause, count: 1, x: atX, y: atY })
              else row.count += 1
            }
          }
          // Deaths are counted exactly once, by the population diff above. A
          // corpse that no vanished animal claimed is a death from an earlier
          // sweep whose cause was already attributed (or inferred) then, so it
          // is dropped rather than tallied twice.
        }

        // One ticker line per species per kind: a litter of seven is one piece of
        // news, not seven, or the ticker becomes unreadable during a boom.
        const originOf = (speciesId) => {
          for (const entity of world.entities) {
            if (entity.species === speciesId) return { x: entity.x, y: entity.y }
          }
          return { x: world.width / 2, y: world.height / 2 }
        }
        for (const [speciesId, count] of birthBatch) {
          const at = originOf(speciesId)
          pushEvent('birth', speciesId, at.x, at.y, count, 0)
        }
        for (const row of deathBatch.values()) {
          const at = Number.isFinite(row.x) ? row : originOf(row.species)
          pushEvent('death', row.species, at.x, at.y, row.count, 0, row.cause)
        }
        for (const [speciesId, count] of arrivalBatch) {
          const at = originOf(speciesId)
          pushEvent('migration', speciesId, at.x, at.y, count, 0)
        }
        for (const placed of placements) pushEvent('placed', placed.species, placed.x, placed.y, 1, 0)
        if (world.caches !== undefined && world.caches !== null) {
          for (const cache of world.caches) {
            if (cache === null || typeof cache !== 'object') continue
            const filled = Number(cache.energy) || 0
            const before = previous === null ? 0 : (previous.caches.get(cache.id) ?? 0)
            if (filled > before + 0.5) pushEvent('hoard', cache.owner ?? cache.species ?? 'rabbit', cache.x ?? 0, cache.y ?? 0, 1, 0)
          }
        }

        // Measured flows, all in kJ per in-world day so every row of the budget
        // is comparable (docs/10 section 2). Two sources, in order of authority:
        //  - world.budget: gross primary production and plant respiration, which
        //    the producer step counts itself;
        //  - the bodies: an animal's intake is whatever its reserve gained plus
        //    whatever it burned, since nothing else moves energy in or out.
        if (previous !== null && dt > 0) {
          const perDay = DAY_SECONDS / dt
          for (const id of SPECIES_IDS) {
            const nowBucket = species[id]
            const oldBucket = previous.species[id]
            if (nowBucket === undefined || oldBucket === undefined) continue
            const intake = (nowBucket.sumE - oldBucket.sumE) * perDay + nowBucket.respire
            rateIntake[id] = rateIntake[id] === undefined ? intake : rateIntake[id] + (intake - rateIntake[id]) * 0.35
          }
          let herbs = 0
          let carns = 0
          let respire = 0
          for (const id of SPECIES_IDS) {
            const role = SPECIES[id].role
            const value = Math.max(0, rateIntake[id] ?? 0)
            if (role === 'grazer') herbs += value
            else carns += value
            respire += species[id].respire
          }
          const budget = world.budget
          const before = previous.budget
          let gpp = 0
          let plantRespired = 0
          let animalRespired = respire
          if (budget !== undefined && budget !== null && before !== null && before !== undefined) {
            gpp = Math.max(0, (budget.gpp - before.gpp) * perDay)
            plantRespired = Math.max(0, (budget.plantRespired - before.plantRespired) * perDay)
            // The engine's own animal-respiration counter, when it exists, beats
            // summing pMetabolism here: it is what actually left the reserves.
            if (Number.isFinite(budget.animalRespired) && Number.isFinite(before.animalRespired)) {
              animalRespired = Math.max(0, (budget.animalRespired - before.animalRespired) * perDay)
            }
          } else {
            // No budget in this world: fall back to the net stock rise, which
            // understates growth by whatever the grazers took.
            gpp = Math.max(0, (plants.energy - previous.plants.energy) * perDay)
          }
          rates.gpp += (gpp - rates.gpp) * 0.35
          rates.herbs += (herbs - rates.herbs) * 0.35
          rates.carns += (carns - rates.carns) * 0.35
          rates.respire += (animalRespired - rates.respire) * 0.35
          rates.plantRespire += (plantRespired - rates.plantRespire) * 0.35
        }

        const caches = new Map()
        if (world.caches !== undefined && world.caches !== null) {
          for (const cache of world.caches) {
            if (cache === null || typeof cache !== 'object') continue
            caches.set(cache.id, Number(cache.energy) || 0)
          }
        }
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
        while (events.length > 0 && now - events[0].t > EVENT_TTL) events.shift()

        const budget = world.budget
        observation = {
          time: now,
          dt,
          species,
          hunters,
          seen,
          plants,
          caches,
          budget: budget === undefined || budget === null
            ? null
            : {
                gpp: budget.gpp,
                plantRespired: budget.plantRespired,
                animalRespired: Number.isFinite(budget.animalRespired) ? budget.animalRespired : 0,
                mineralised: budget.mineralised,
              },
        }
        return observation
      }

      /**
       * Events worth showing, newest first.
       * @returns {object[]} events.
       */
      function recentEvents() {
        const list = []
        for (let i = events.length - 1; i >= 0 && list.length < 24; i--) list.push(events[i])
        return list
      }

      /**
       * Births and deaths in the last minute, for the header pulse.
       * @param {object} world - the world.
       * @returns {{births: number, deaths: number, predations: number}} pulse.
       */
      function pulseOf(world) {
        const window = PULSE_SECONDS
        const since = world.time - window
        let births = 0
        let deaths = 0
        let predations = 0
        for (const event of events) {
          if (event.t < since) continue
          if (event.kind === 'birth') births += event.count
          else if (event.kind === 'death') deaths += event.count
          else if (event.kind === 'predation') { deaths += event.count; predations += event.count }
        }
        return { births, deaths, predations }
      }

      /**
       * One row per species for the species table and the energy budget.
       * @returns {object[]} rows in SPECIES_IDS order.
       */
      function speciesRows() {
        const rows = []
        for (const id of SPECIES_IDS) {
          const bucket = observation === null || observation.species[id] === undefined
            ? { count: 0, sumE: 0, sumMax: 0, sumAge: 0, respire: 0, hungry: 0 }
            : observation.species[id]
          const causes = causeTally[id] ?? {}
          let tally = 0
          for (const key of CAUSE_KEYS) tally += causes[key] ?? 0
          // A corpse can arrive one sweep after its animal vanished, so the cause
          // tally and the population diff can differ by one; report the larger of
          // the two so the number next to the bar never contradicts the bar.
          const dead = Math.max(deathCount[id] ?? 0, tally)
          const smoothed = rateIntake[id] ?? 0
          rows.push({
            id,
            count: bucket.count,
            meanRatio: bucket.count === 0 || bucket.sumMax <= 0 ? 0 : clamp(bucket.sumE / bucket.sumMax, 0, 1),
            meanEnergy: bucket.count === 0 ? 0 : bucket.sumE / bucket.count,
            meanAge: bucket.count === 0 ? 0 : bucket.sumAge / bucket.count,
            hungry: bucket.hungry,
            respire: bucket.respire,
            net: smoothed,
            intake: Math.max(0, smoothed),
            deaths: causes,
            dead,
            extinct: bucket.count === 0 && dead > 0,
          })
        }
        return rows
      }

      /**
       * The cascade the energy panel draws, in energy units per game second.
       * @returns {object} flows.
       */
      function flowView() {
        let animalStock = 0
        if (observation !== null) {
          for (const id of SPECIES_IDS) {
            const bucket = observation.species[id]
            if (bucket !== undefined) animalStock += bucket.sumE
          }
        }
        return {
          gpp: Math.max(0, rates.gpp),
          herbs: Math.max(0, rates.herbs),
          carns: Math.max(0, rates.carns),
          respire: Math.max(0, rates.respire),
          plantRespire: Math.max(0, rates.plantRespire),
          plantStock: observation === null ? 0 : observation.plants.energy,
          animalStock,
        }
      }

      /**
       * Climate as the header and the cold drive read it.
       * @param {object} world - the world.
       * @returns {object} climate view.
       */
      function climateView(world) {
        const climate = world.climate ?? null
        const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
        return {
          temperature: temperatureOf(world),
          sunlight: climate !== null && Number.isFinite(climate.sunlight) ? climate.sunlight : daylight(world),
          dayPhase: climate !== null && Number.isFinite(climate.dayPhase) ? climate.dayPhase : phase,
          yearPhase: climate !== null && Number.isFinite(climate.yearPhase) ? climate.yearPhase : null,
          season: climate !== null && typeof climate.season === 'string' ? climate.season : null,
        }
      }

      /** The inspected animal, if it is still alive. */
      function selectedEntity() {
        if (world === null || selectedId === 0) return undefined
        return findEntityById(world, selectedId)
      }

      /**
       * Flatten one entity for the inspector.
       *
       * The inspector is the answer to "what is it doing and why" (G2), so this
       * is everything needed to say that in one card: the body, the eight
       * drives, the timed state, the goal it walks toward, the sentence behind
       * the decision and the death it is heading for.
       * @param {object} entity - the animal.
       * @returns {object} inspector record.
       */
      function summariseEntity(entity) {
        const species = SPECIES[entity.species]
        const safe = species === undefined
          ? { balance: { maxEnergy: 100, maturity: 1 }, genes: {}, color: '#999', role: 'grazer' }
          : species
        const body = bodyRecord(entity, safe)
        const drives = drivesOf(world, entity, safe)
        const state = entity.state
        const stateId = state !== undefined && state !== null && typeof state.id === 'string'
          ? state.id
          : (entity.intent ?? 'explore')
        const remaining = state !== undefined && state !== null && Number.isFinite(state.until)
          ? Math.max(0, state.until - world.time)
          : null
        const hasGoal = Number.isFinite(entity.targetX) && Number.isFinite(entity.targetY)
        const plan = entity.plan
        const decision = entity.decision
        const decisionAge = decision !== undefined && decision !== null && Number.isFinite(decision.at)
          ? Math.max(0, world.time - decision.at)
          : null
        return {
          id: entity.id,
          species: entity.species,
          age: entity.age,
          energy: body.reserve,
          maxEnergy: body.reserveMax,
          generation: entity.generation,
          children: entity.children ?? 0,
          genes: { ...entity.genes },
          x: entity.x,
          y: entity.y,
          fleeing: entity.fleeing === true,
          stage: entity.stage ?? 'adult',
          intent: entity.intent ?? 'explore',
          needs: { ...needsOf(entity) },
          speed: entity.genes.speed * (STAGE_SPEED[entity.stage ?? 'adult'] ?? 1),
          body,
          drives: drives.values,
          drivesDerived: drives.derived,
          state: {
            id: stateId,
            phase: state !== undefined && state !== null && typeof state.phase === 'string' ? state.phase : null,
            since: state !== undefined && state !== null && Number.isFinite(state.since) ? state.since : null,
            remaining,
            nextDecision: Number.isFinite(entity.thinkTimer) ? Math.max(0, entity.thinkTimer) : null,
            score: state !== undefined && state !== null && Number.isFinite(state.score) ? round3(state.score) : null,
          },
          plan: plan === undefined || plan === null
            ? null
            : {
                goal: typeof plan.goal === 'string' ? plan.goal : null,
                index: Number.isFinite(plan.index) ? plan.index : 0,
                steps: Array.isArray(plan.steps)
                  ? plan.steps.slice(0, 4).map(step => ({
                      x: round3(step?.x ?? 0),
                      y: round3(step?.y ?? 0),
                      act: typeof step?.act === 'string' ? step.act : null,
                      duration: Number.isFinite(step?.duration) ? round3(step.duration) : null,
                    }))
                  : [],
              },
          decisionAge,
          goal: hasGoal
            ? { x: entity.targetX, y: entity.targetY, distance: Math.hypot(entity.targetX - entity.x, entity.targetY - entity.y) }
            : null,
          reason: reasonOf(entity, drives.values),
          cause: {
            predicted: predictCause(entity, body, drives.values, observation),
            actual: body.cause,
          },
          threats: predatorsNear(observation, entity.species, entity.x, entity.y, 8),
        }
      }

      /** Snapshot for React: counters, history, selection and camera hints. */
      /** An all-zero stats row, used before the world exists. */
      function emptyStats() {
        return {
          counts: Object.fromEntries(SPECIES_IDS.map(id => [id, 0])),
          day: 1,
          clock: '06:00',
          daylight: 1,
        }
      }

      function buildSnapshot() {
        if (world === null) {
          // Never a partial object: components read these fields on their very
          // first render, before the mount effect has created the world.
          return {
            ready: false,
            // ready === false only ever means "unpacking a save right now"; a
            // store with nothing to load has a world before this runs.
            loading: true,
            paused,
            speed,
            time: 0,
            stats: emptyStats(),
            world: { width: GRID_W, height: GRID_H, empty: true },
            history: [],
            brush: { tool: brush.tool, radius: brush.radius },
            selected: null,
            following: false,
            view: { x: 0, y: 0, width: 0, height: 0 },
            events: [],
            pulse: { births: 0, deaths: 0, predations: 0 },
            species: [],
            flows: { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0, plantStock: 0, animalStock: 0 },
            plants: { grass: 0, weed: 0, energy: 0 },
            climate: { temperature: null, sunlight: 1, dayPhase: 0.26, yearPhase: null, season: null },
            onboarding: onboardingSeen(),
            notice,
            causeSource: { exact: 0, inferred: 0 },
            save: { size: saveState.size, at: saveState.at, pending: saveState.pending, failed: saveState.failed, stored: saveState.stored },
          }
        }
        const stats = sampleStats(world)
        // Observe before summarising: the inspector reads the predators and the
        // census from the same reading, so one card never mixes two moments.
        observe(world)
        const selected = selectedEntity()
        let population = 0
        for (const id of SPECIES_IDS) population += stats.counts[id] ?? 0
        return {
          ready: true,
          loading: false,
          paused,
          speed,
          time: world.time,
          stats,
          world: { width: world.width, height: world.height, empty: population === 0 },
          history: world.history.slice(-120),
          brush: { tool: brush.tool, radius: brush.radius },
          selected: selected === undefined ? null : summariseEntity(selected),
          following: follow && selected !== undefined,
          view: { x: view.x, y: view.y, width: view.width, height: view.height },
          events: recentEvents(),
          pulse: pulseOf(world),
          species: speciesRows(),
          flows: flowView(),
          plants: observation === null ? { grass: 0, weed: 0, energy: 0 } : observation.plants,
          climate: climateView(world),
          onboarding: onboardingSeen(),
          notice,
          causeSource: { exact: causeSource.exact, inferred: causeSource.inferred },
          save: { size: saveState.size, at: saveState.at, pending: saveState.pending, failed: saveState.failed, stored: saveState.stored },
        }
      }

      /** One animation frame. */
      function frame() {
        frameHandle = 0
        if (disposed || canvas === null) return
        frameHandle = requestFrame(frame)
        const stamp = clock()
        let elapsed = (stamp - lastStamp) / 1000
        lastStamp = stamp
        if (!(elapsed > 0)) elapsed = 0
        if (elapsed > 0.5) elapsed = 0.5
        if (!paused && world !== null) advance(elapsed * speed)
        draw()
      }

      /**
       * Step the simulation in fixed slices and keep the interpolation fraction.
       * @param {number} delta - simulation seconds to consume.
       */
      function advance(delta) {
        accumulator += delta
        let guard = 0
        while (accumulator >= TICK && guard < 60) {
          stepWorld(world, TICK)
          accumulator -= TICK
          guard += 1
        }
        if (accumulator > TICK) accumulator = 0
        alpha = clamp(accumulator / TICK, 0, 1)
        clockAccumulator += delta
        if (clockAccumulator >= 1) {
          clockAccumulator -= 1
          pushHistory(world)
          publish()
        } else if (pendingSnapshot && clockAccumulator > 0.2) {
          pendingSnapshot = false
          publish()
        }
        minimapAccumulator += delta
        if (minimapAccumulator >= 2) {
          minimapAccumulator = 0
          minimap = null
        }
        saveAccumulator += delta
        if (saveAccumulator >= 30) {
          saveAccumulator = 0
          save()
        }
      }

      /** Repaint the attached canvas. */
      function draw() {
        if (context === null || world === null || frameBuffer === null) return
        if (view.width <= 0 || view.height <= 0) return
        const selected = selectedEntity()
        const scale = view.scale ?? 1
        // The offscreen buffer is created lazily: on a warm start the world
        // arrives asynchronously, so attach() ran while world was still null and
        // skipped it. Without this the first paint fell back to one pixel per
        // cell and sized the canvas to the cell count instead of the pixel count
        // (194x148 instead of 970x740), which is the 'tiny map in the corner'
        // bug. Buffers are a precondition of drawing, not of attaching.
        ensureDrawBuffers()
        const useAtlas = atlas.ready === true && scale >= 3 && offscreenContext !== null
        paintView(world, view, frameBuffer, alpha, {
          hover,
          radius: brush.radius,
          selected: selected === undefined ? null : selected,
        }, { sprites: !useAtlas, plants: !useAtlas })
        // Two sizes, on purpose:
        //  - backingWidth/Height: what gets painted, one device pixel per
        //    rendered pixel (upscaled by the integer zoom when the offscreen
        //    canvas exists). This is the size putImageData/drawImage write into.
        //  - canvasWidth/Height: the CSS box, which is the stage rectangle the
        //    panel asked for. It is what the player sees and what the HUD counts.
        // Keeping them separate means a missing upscaler can no longer shrink the
        // visible map to 1/scale of the stage: CSS scales the 1:1 frame instead.
        const useOffscreen = offscreenContext !== null
        // Invariant: the backing store is always view.width x scale, whatever the
        // CSS box ends up being. Only the host that cannot create any canvas at
        // all (no document, no OffscreenCanvas) has to paint 1:1 instead.
        const backingScale = useOffscreen ? scale : 1
        const backingWidth = Math.max(1, Math.round(view.width * backingScale))
        const backingHeight = Math.max(1, Math.round(view.height * backingScale))
        const canvasWidth = Number.isFinite(view.cssWidth) && view.cssWidth > 0 ? view.cssWidth : backingWidth
        const canvasHeight = Number.isFinite(view.cssHeight) && view.cssHeight > 0 ? view.cssHeight : backingHeight
        // The canvas size has exactly ONE owner: this function. React used to set
        // width/height from its own copy of the view while the paint used the
        // store's copy, so whenever the two disagreed the frame was painted into
        // a corner of a larger canvas and the rest stayed black. Assigning here
        // makes the visible size and the painted size the same by construction.
        const element = context.canvas
        // Closed loop: if the canvas we are about to paint is not the size of the
        // box it sits in, the panel's saved viewport is stale (a panel that
        // mounted before layout settled, a hidden tab, a zoom change racing a
        // resize). Observers can miss those; the paint path cannot, because it
        // runs every frame. Ask for a re-measure instead of drawing into a corner.
        if (element !== null && element !== undefined && element.parentElement !== null
          && typeof element.parentElement.getBoundingClientRect === 'function') {
          const box = element.parentElement.getBoundingClientRect()
          const offBy = Math.abs(box.width - canvasWidth) > 2 || Math.abs(box.height - canvasHeight) > 2
          if (offBy && viewportListener !== null && clock() - viewportAskedAt > 200) {
            viewportAskedAt = clock()
            viewportListener(Math.max(200, Math.round(box.width)), Math.max(160, Math.round(box.height)))
          }
        }
        if (element !== null && element !== undefined) {
          if (element.width !== backingWidth) element.width = backingWidth
          if (element.height !== backingHeight) element.height = backingHeight
          const style = element.style
          const cssWidth = canvasWidth + 'px'
          const cssHeight = canvasHeight + 'px'
          if (style !== undefined && style.width !== cssWidth) style.width = cssWidth
          if (style !== undefined && style.height !== cssHeight) style.height = cssHeight
        }
        if (useOffscreen) {
          // Ground: 1 px per cell, upscaled with nearest neighbour.
          offscreenContext.putImageData(imageData, 0, 0)
          context.imageSmoothingEnabled = false
          context.drawImage(offscreen, 0, 0, view.width, view.height, 0, 0, backingWidth, backingHeight)
          // Plants and animals share one depth-sorted pass so a tree in front of
          // an animal actually covers it.
          if (useAtlas) drawDepthLayers(context, world, view, alpha)
        } else {
          // No upscaler at all: this host cannot create a canvas, so the frame is
          // painted one device pixel per cell and the CSS box scales it. In a
          // browser ensureDrawBuffers() has already created the offscreen, so this
          // branch is unreachable there.
          context.putImageData(imageData, 0, 0)
        }
        // Day/night wash and dawn/dusk warmth, over the whole frame.
        const light = daylight(world)
        if (light < 0.98) {
          const darkness = Math.min(0.5, (1 - light) * 0.55)
          context.fillStyle = `rgba(12, 18, 44, ${darkness.toFixed(3)})`
          context.fillRect(0, 0, backingWidth, backingHeight)
        }
        const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
        const warmth = phase > 0.17 && phase < 0.3
          ? 0.16 * (1 - Math.abs(phase - 0.235) / 0.065)
          : phase > 0.71 && phase < 0.85
            ? 0.18 * (1 - Math.abs(phase - 0.78) / 0.07)
            : 0
        if (warmth > 0.01) {
          context.fillStyle = `rgba(240, 150, 70, ${warmth.toFixed(3)})`
          context.fillRect(0, 0, backingWidth, backingHeight)
        }
      }

      /** Start the animation loop. */
      function startLoop() {
        if (frameHandle !== 0 || disposed) return
        lastStamp = clock()
        accumulator = 0
        frameHandle = requestFrame(frame)
      }

      /** Stop the animation loop. */
      function stopLoop() {
        if (frameHandle === 0) return
        cancelFrame(frameHandle)
        frameHandle = 0
      }

      /**
       * Point the renderer at a window of the world. The canvas must already be
       * sized to `width × height` cells.
       * @param {object} next - `{ x, y, width, height }` in cells.
       */
      /**
       * Let the owner of the layout tell the store how big the viewport should be.
       *
       * The panel passes a callback that re-measures and pushes a new view; the
       * store calls it when a paint proves the two disagree. Asking is the only
       * direction the store is allowed to go.
       * @param {Function|null} listener - called with (width, height) in CSS px.
       */
      function setViewportListener(listener) {
        viewportListener = typeof listener === 'function' ? listener : null
      }

      function setView(next) {
        const scale = typeof next.scale === 'number' && next.scale > 0 ? next.scale : (view.scale ?? 1)
        if (world === null) {
          // The world is still being unpacked. Remember the request; the load
          // continuation replays it once the real size is known.
          ensureWorld()
          view = {
            x: Math.max(0, next.x | 0),
            y: Math.max(0, next.y | 0),
            width: Math.max(1, next.width | 0),
            height: Math.max(1, next.height | 0),
            scale,
          }
          return
        }
        const width = Math.max(1, Math.min(world.width, next.width | 0))
        const height = Math.max(1, Math.min(world.height, next.height | 0))
        const x = clamp(next.x | 0, 0, Math.max(0, world.width - width))
        const y = clamp(next.y | 0, 0, Math.max(0, world.height - height))
        view = {
          x, y, width, height, scale,
          // The canvas box the panel measured for this view. draw() is the only
          // writer of the element size, and this is where it gets the box from.
          cssWidth: Number.isFinite(next.cssWidth) && next.cssWidth > 0 ? Math.round(next.cssWidth) : width * scale,
          cssHeight: Number.isFinite(next.cssHeight) && next.cssHeight > 0 ? Math.round(next.cssHeight) : height * scale,
        }
        // One owner for buffer creation and resizing. It must run even when the
        // world is absent: the buffers are a window onto the map, not the map.
        ensureBuffers()
      }

      /**
       * Bind a canvas and start rendering.
       * @param {HTMLCanvasElement} element - canvas sized to the current view.
       */
      function attach(element) {
        if (disposed || element === null || element === undefined) return
        if (canvas !== null) detach()
        ensureWorld()
        canvas = element
        context = typeof element.getContext === 'function' ? element.getContext('2d', { alpha: false }) : null
        if (context === null) {
          canvas = null
          return
        }
        ensureBuffers()
        ensureAtlas(publish)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          // A gzip cannot finish once the page is tearing down, so unload writes
          // the uncompressed payload; hiding the tab still gets the real thing.
          window.addEventListener('beforeunload', saveSync)
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
          }
        }
        startLoop()
        publish()
      }

      /** Save as soon as the tab is hidden: the last chance an async write has. */
      function onVisibilityChange() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') save()
      }

      /**
       * Size the pixel buffers for the current view.
       *
       * Split out of attach() because the world may still be unpacking when the
       * canvas arrives: the load continuation calls this again once it knows the
       * real world size.
       */
      /**
       * Create whatever the paint path is missing, right before it paints.
       *
       * ensureBuffers() bails out when the world is not unpacked yet, so the
       * warm-start path could reach draw() with no offscreen canvas at all.
       * This is the cheap idempotent version: it only fills the gaps.
       * @returns {boolean} true when the store is able to paint.
       */
      function ensureDrawBuffers() {
        if (context === null || world === null) return false
        if (imageData === null) {
          imageData = context.createImageData(view.width, view.height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        if (offscreen === null && typeof document !== 'undefined' && typeof document.createElement === 'function') {
          offscreen = document.createElement('canvas')
          offscreen.width = view.width
          offscreen.height = view.height
          offscreenContext = offscreen.getContext('2d', { alpha: false })
        }
        if (offscreen !== null && (offscreen.width !== view.width || offscreen.height !== view.height)) {
          offscreen.width = view.width
          offscreen.height = view.height
        }
        return true
      }

      function ensureBuffers() {
        if (context === null) {
          return
        }
        if (view.width <= 0 || view.height <= 0) {
          // No size requested yet. Only a real world can supply the default, but
          // a world that is still unpacking still gets buffers: the panel has a
          // view request in hand by the time attach() runs.
          if (world === null) {
            return
          }
          view = {
            x: 0, y: 0,
            width: Math.min(world.width, 160),
            height: Math.min(world.height, 100),
            scale: view.scale ?? 1,
            cssWidth: Math.min(world.width, 160) * (view.scale ?? 1),
            cssHeight: Math.min(world.height, 100) * (view.scale ?? 1),
          }
        }
        if (imageData === null || imageData.width !== view.width || imageData.height !== view.height) {
          imageData = context.createImageData(view.width, view.height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        // The offscreen canvas is the upscaler. Without it a frame can only be
        // painted 1:1, which is exactly how the map ended up drawn at 1/scale in
        // the corner of the stage. It needs a context and a size, never a world.
        if (offscreen === null) {
          if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            offscreen = document.createElement('canvas')
          } else if (typeof OffscreenCanvas === 'function') {
            offscreen = new OffscreenCanvas(view.width, view.height)
          }
          if (offscreen !== null) {
            offscreenContext = typeof offscreen.getContext === 'function' ? offscreen.getContext('2d') : null
          }
        }
        if (offscreen !== null && (offscreen.width !== view.width || offscreen.height !== view.height)) {
          offscreen.width = view.width
          offscreen.height = view.height
        }
      }

      /** Unbind the canvas and save. */
      function detach() {
        stopLoop()
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', saveSync)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
        }
        canvas = null
        context = null
        imageData = null
        frameBuffer = null
      }

      /**
       * Put a starter population back into an emptied world.
       *
       * This is the "the world went quiet" button: it places a few animals per
       * species through the same code path as the brush, so the arrival is
       * reported in the event ticker like any other placement and no rule is
       * bypassed (caps still refuse a species that is already full).
       * @returns {number} how many animals were released.
       */
      function restock() {
        if (world === null) {
          ensureWorld()
          return 0
        }
        let released = 0
        const spots = 6
        for (const id of SPECIES_IDS) {
          const want = id === 'rabbit' || id === 'fish' || id === 'frog' ? 3 : 2
          let placed = 0
          for (let attempt = 0; attempt < spots * 4 && placed < want; attempt++) {
            const x = randomBetween(world, 2, world.width - 3)
            const y = randomBetween(world, 2, world.height - 3)
            const before = Number.isFinite(world.nextId) ? world.nextId : 0
            const count = place(world, id, x, y, 1)
            const added = typeof count === 'number' ? count : 0
            if (added <= 0) continue
            if (before > 0 && Number.isFinite(world.nextId)) {
              for (let newId = before; newId < world.nextId; newId++) placedIds.add(newId)
            }
            placed += added
            released += added
          }
        }
        markDirty()
        publish()
        return released
      }

      /** Replace the world with a fresh one. */
      function newWorld(seed) {
        // Cancel any load still in flight: the player asked for a new world, and
        // an older save finishing late must not replace it.
        worldToken += 1
        adoptWorld(createWorld(seed === undefined ? {} : { seed }))
        selectedId = 0
        follow = false
        accumulator = 0
        save()
        publish()
      }

      /**
       * Read-only diagnostic seam for the browser verifiers.
       *
       * tools/ui-smoke.mjs and tests/panel-layout.mjs read the live view, the
       * buffer sizes and whether the upscaler exists to prove the canvas sizing
       * invariant from outside the bundle. It exposes numbers only: no handles,
       * no setters, nothing an app could use to change behaviour.
       */
      if (typeof window !== 'undefined') {
        window.__peDebug = () => ({
          view: { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale },
          world: world === null ? null : { width: world.width, height: world.height },
          attached: canvas !== null,
          hasContext: context !== null,
          hasImageData: imageData !== null,
          hasOffscreen: offscreenContext !== null,
          imageData: imageData === null ? null : [imageData.width, imageData.height],
          canvasAttr: canvas === null ? null : [canvas.width, canvas.height],
          canvasStyle: canvas === null ? null : [canvas.style.width, canvas.style.height],
          loading: world === null,
        })
      }

      return {
        ensureWorld,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          if (snapshot === null) snapshot = buildSnapshot()
          return snapshot
        },
        attach,
        detach,
        setView,
        getView() {
          return view
        },
        getWorld() {
          return world
        },
        isAttached() {
          return canvas !== null
        },
        /** @returns {{width: number, height: number, data: Uint32Array}} minimap. */
        getMinimap(width = 160, height = 100) {
          if (world === null) {
            ensureWorld()
            // An empty frame is better than a crash: the panel repaints as soon
            // as the world lands.
            return { width, height, data: new Uint32Array(width * height) }
          }
          if (minimap === null || minimap.width !== width || minimap.height !== height) {
            minimap = { width, height, data: paintMinimap(world, width, height) }
          }
          return minimap
        },
        setPaused(value) {
          paused = value === true
          publish()
        },
        togglePause() {
          paused = !paused
          publish()
        },
        setSpeed(value) {
          speed = SPEEDS.includes(value) ? value : 1
          paused = false
          publish()
        },
        /** Advance exactly one tick while paused. */
        stepOnce() {
          if (world === null) {
            ensureWorld()
            return
          }
          stepWorld(world, TICK)
          pushHistory(world)
          publish()
        },
        setBrush(tool, radius) {
          if (typeof tool === 'string') brush.tool = tool
          if (typeof radius === 'number') brush.radius = clamp(radius | 0, 0, 2)
          publish()
        },
        setHover(point) {
          hover = point === null || point === undefined ? null : { x: point.x, y: point.y }
        },
        paintAt(x, y, erase = false) {
          if (world === null) {
            ensureWorld()
            return 0
          }
          // Anything the brush spawns is the player's doing, not a birth: the
          // id watermark tells the observer exactly which animals appeared.
          const before = Number.isFinite(world.nextId) ? world.nextId : 0
          const result = place(world, erase ? 'erase' : brush.tool, x, y, brush.radius)
          const released = typeof result === 'number' ? result : 0
          if (released > 0 && before > 0 && Number.isFinite(world.nextId) && placedIds.size < 512) {
            for (let id = before; id < world.nextId; id++) placedIds.add(id)
          }
          // The canvas repaints on the next animation frame anyway; a full
          // snapshot here would rescan 200k cells per cell of a brush drag.
          markDirty()
          return released
        },
        selectAt(x, y) {
          if (world === null) return undefined
          const entity = findEntityAt(world, x, y, 3)
          selectedId = entity === undefined ? 0 : entity.id
          if (selectedId === 0) follow = false
          publish()
          return entity
        },
        select(id) {
          selectedId = typeof id === 'number' ? id : 0
          if (selectedId === 0) follow = false
          publish()
        },
        clearSelection() {
          selectedId = 0
          follow = false
          publish()
        },
        setFollow(value) {
          follow = value === true && selectedEntity() !== undefined
          publish()
        },
        selectedPosition() {
          const entity = selectedEntity()
          return entity === undefined ? null : { x: entity.x, y: entity.y }
        },
        isFollowing() {
          return follow
        },
        newWorld,
        restock,
        whenReady,
        setViewportListener,
        markOnboardingSeen,
        resetOnboarding,
        dismissNotice,
        save,
        saveNow,
        /** @returns {Promise<object|null>} the stored world, without side effects. */
        async peekSave() {
          // Peeking must not consume the notice that the panel has not shown yet.
          const stored = await readStored()
          return stored.world
        },
        dispose() {
          detach()
          listeners.clear()
          disposed = true
        },
      }
    }

    // Locale