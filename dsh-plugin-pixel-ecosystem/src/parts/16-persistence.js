    // ---------------------------------------------------------------------
    // Persistence (save format 2)
    // ---------------------------------------------------------------------
    //
    // A 1024x640 world is 655,360 cells. Five quantised fields at one byte per
    // cell is 3.3 MB of JSON text before base64, which does not fit a
    // localStorage quota. Three things keep the save small:
    //
    //  1. Only fields that carry state are written. Moisture, depth, light and
    //     the canopy are recomputed from the terrain and the clock on load.
    //  2. Each field is bit-packed to the precision it needs (8 bits for the
    //     producer biomass the player actually sees, 4 for the slow indices).
    //     The scale of every field is stored in the header, so a field that
    //     happens to be full gets the full dynamic range of its bits.
    //  3. The payload is gzipped with CompressionStream where the host has it,
    //     and falls back to plain JSON with the coarser bit packing where it
    //     does not. Either way the player is told what happened; a save is
    //     never dropped silently (0.2.x did exactly that).

    /** Save format version lives in 00-preamble (LEAD scope): one number, two files would drift. */
    /** Marker in front of a gzipped payload, so a load can tell the two apart. */
    const SAVE_GZIP_PREFIX = 'gz:'

    /** Bits per field in each detail level: [index fields, mass fields]. */
    const FIELD_BITS = {
      full: { fertility: 8, waterFertility: 4, grass: 8, weed: 8, detritus: 4 },
      low: { fertility: 4, waterFertility: 4, grass: 4, weed: 4, detritus: 4 },
    }

    /**
     * Bytes → base64, chunked so a multi-megabyte payload never blows the stack.
     * @param {Uint8Array|Uint8ClampedArray} bytes - input.
     * @returns {string} base64 text.
     */
    function encodeBytes(bytes) {
      let text = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(text)
    }

    /**
     * base64 → typed array.
     * @param {string} text - base64 text.
     * @param {Function} Type - typed array constructor.
     * @returns {object} decoded typed array.
     */
    function decodeBytes(text, Type) {
      const raw = atob(String(text))
      const out = new Type(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
      return out
    }

    /**
     * Pack a float field into `bits` per cell, against an explicit scale.
     * @param {Float32Array} field - source values.
     * @param {number} bits - 4 or 8.
     * @param {number} scale - value that maps to the top of the range.
     * @returns {Uint8Array} packed bytes.
     */
    function packField(field, bits, scale) {
      const levels = (1 << bits) - 1
      const inverse = scale > 0 ? levels / scale : 0
      if (bits === 8) {
        const out = new Uint8Array(field.length)
        for (let i = 0; i < field.length; i++) {
          const value = field[i] * inverse
          out[i] = value <= 0 ? 0 : value >= levels ? levels : value | 0
        }
        return out
      }
      const out = new Uint8Array((field.length + 1) >> 1)
      for (let i = 0; i < field.length; i += 2) {
        const a = field[i] * inverse
        const hi = a <= 0 ? 0 : a >= levels ? levels : a | 0
        let byte = hi
        if (i + 1 < field.length) {
          const b = field[i + 1] * inverse
          const lo = b <= 0 ? 0 : b >= levels ? levels : b | 0
          byte |= lo << 4
        }
        out[i >> 1] = byte
      }
      return out
    }

    /**
     * Unpack a field written by `packField`.
     * @param {string} text - base64 bytes.
     * @param {number} size - expected cell count.
     * @param {number} bits - 4 or 8.
     * @param {number} scale - value the top of the range stands for.
     * @param {Float32Array} [target] - array to fill, when it already exists.
     * @returns {Float32Array} field.
     */
    function unpackField(text, size, bits, scale, target) {
      const bytes = decodeBytes(text, Uint8Array)
      const out = target !== undefined && target.length === size ? target : new Float32Array(size)
      const levels = (1 << bits) - 1
      if (bits === 8) {
        if (bytes.length !== size) throw new Error('bad field length in world save')
        const factor = scale / levels
        for (let i = 0; i < size; i++) out[i] = bytes[i] * factor
        return out
      }
      if (bytes.length !== (size + 1) >> 1) throw new Error('bad packed field length in world save')
      const factor = scale / levels
      for (let i = 0; i < size; i++) {
        const byte = bytes[i >> 1]
        const nibble = (i & 1) === 0 ? byte & 0x0f : byte >> 4
        out[i] = nibble * factor
      }
      return out
    }

    /**
     * Largest value in a field, used as that field's packing scale.
     * @param {Float32Array} field - source.
     * @returns {number} max (never zero).
     */
    function fieldScale(field) {
      let max = 0
      for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i]
      return max > 0 ? max : 1
    }

    /**
     * Serialize a world to a JSON-safe object (format 2).
     * @param {object} world - the world.
     * @param {{detail?: 'full'|'low'}} [options] - packing detail.
     * @returns {object} save payload.
     */
    function serializeWorld(world, options = {}) {
      const bits = FIELD_BITS[options.detail === 'low' ? 'low' : 'full']
      const scales = {
        fertility: 1,
        waterFertility: 1,
        grass: fieldScale(world.grass),
        weed: fieldScale(world.weed),
        detritus: fieldScale(world.detritus),
      }
      return {
        version: SAVE_VERSION,
        seed: world.seed,
        width: world.width,
        height: world.height,
        tick: world.tick,
        time: world.time,
        rngState: world.rngState,
        nextId: world.nextId,
        immigration: world.immigration !== false,
        immigrationTimer: world.immigrationTimer ?? null,
        budget: world.budget === undefined ? null : { ...world.budget },
        deaths: { ...(world.deaths ?? {}) },
        bits,
        scales,
        terrain: encodeBytes(world.terrain),
        fertility: encodeBytes(packField(world.fertility, bits.fertility, scales.fertility)),
        waterFertility: encodeBytes(packField(world.waterFertility, bits.waterFertility, scales.waterFertility)),
        grass: encodeBytes(packField(world.grass, bits.grass, scales.grass)),
        weed: encodeBytes(packField(world.weed, bits.weed, scales.weed)),
        detritus: encodeBytes(packField(world.detritus, bits.detritus, scales.detritus)),
        trees: world.trees.map(plant => ({ ...plant })),
        entities: world.entities.map(entity => serializeEntity(entity)),
        corpses: world.corpses.map(corpse => ({ ...corpse })),
        history: world.history.slice(-200),
      }
    }

    /**
     * One animal as JSON. The body is written in full — reserve, structure,
     * maturity, health, fatigue, death cause — because those are the values the
     * gate "save round-trips including body fat / maturity / state" is about.
     * @param {object} entity - the animal.
     * @returns {object} save record.
     */
    function serializeEntity(entity) {
      const body = entity.body
      const record = {
        id: entity.id,
        species: entity.species,
        x: entity.x,
        y: entity.y,
        heading: entity.heading,
        age: entity.age,
        generation: entity.generation,
        cooldown: entity.cooldown,
        thinkTimer: entity.thinkTimer,
        herdTimer: entity.herdTimer ?? 0,
        alarm: entity.alarm ?? 0,
        targetX: entity.targetX,
        targetY: entity.targetY,
        fleeing: entity.fleeing === true,
        children: entity.children ?? 0,
        phase: entity.phase,
        intent: entity.intent ?? null,
        intentScore: entity.intentScore ?? null,
        genes: { ...entity.genes },
        // Why each behaviour field is or is not here (docs/20 §5):
        //
        //  state   — the current bout {id, since, until, min, phase, why, score,
        //            x, y}. CANNOT be re-derived: without it a loaded animal
        //            starts a fresh bout from wherever it stands and the panel
        //            loses "why did it do that". Saved.
        //  plan    — the committed step list for that bout. Saved, same reason.
        //  belief  — remembered food/water/home/threat plus the cache list, every
        //            entry time-stamped. Saved: memory is the animal's history.
        //  drives  — a DERIVED cache, not missing: updateDrives() rebuilds all
        //            eight channels from body.E/Emax and the need channels on the
        //            first tick after a load (hunger is literally 1 - E/Emax).
        //            It is still written here so the inspector has numbers on the
        //            very first frame instead of a row of blanks.
        //  needs   — thirst / social / safety ARE stateful (nothing derives them
        //            from the body), so those are saved; hunger inside it is a
        //            getter over the reserve and is therefore ignored on restore.
        stateEndedAt: Number.isFinite(entity.stateEndedAt) ? entity.stateEndedAt : null,
        needs: entity.needs === undefined ? null : {
          hunger: entity.needs.hunger,
          thirst: entity.needs.thirst,
          energy: entity.needs.energy,
          safety: entity.needs.safety,
          social: entity.needs.social,
        },
        drives: entity.drives === undefined ? null : { ...entity.drives },
        state: entity.state === undefined ? null : JSON.parse(JSON.stringify(entity.state)),
        plan: entity.plan === undefined ? null : JSON.parse(JSON.stringify(entity.plan)),
        belief: entity.belief === undefined ? null : JSON.parse(JSON.stringify(entity.belief)),
      }
      if (body !== undefined) {
        record.body = {
          E: body.E,
          Emax: body.Emax,
          V: body.V,
          M: body.M,
          health: body.health,
          fatigue: body.fatigue,
          dead: body.dead === true,
          cause: body.cause ?? '',
          gut: body.gut ?? 0,
          injury: body.injury ?? 0,
          handlingCorpse: body.handling === null || body.handling === undefined
            ? null
            : (body.handling.corpse === undefined ? null : body.handling.corpse.id),
        }
      }
      return record
    }

    /**
     * Coerce one saved gene set, falling back to fresh genes per missing field.
     * @param {object} world - the world (RNG source for the fallback).
     * @param {string} speciesId - species id.
     * @param {unknown} genes - saved genes.
     * @returns {object} valid genes.
     */
    function restoreGenes(world, speciesId, genes) {
      const ranges = SPECIES[speciesId].genes
      const restored = {}
      for (const key of GENE_KEYS) {
        const value = genes !== null && typeof genes === 'object' ? genes[key] : undefined
        restored[key] = typeof value === 'number' && Number.isFinite(value)
          ? clamp(value, ranges[key][0], ranges[key][1])
          : randomBetween(world, ranges[key][0], ranges[key][1])
      }
      return restored
    }

    /**
     * Rebuild a world from a save payload.
     * @param {object} data - payload from `serializeWorld`.
     * @returns {object} the restored world.
     * @throws {Error} when the payload is not a save this build understands.
     */
    function deserializeWorld(data) {
      if (data === null || typeof data !== 'object') throw saveError('corrupt', 'world save is not an object')
      if (data.version !== SAVE_VERSION) {
        // A mismatch is not "no save": the player must be told their world is
        // from another build, and the old payload must be left alone (docs/20 §5).
        throw saveError('unsupported_version',
          'world save version ' + String(data.version) + ' cannot be read by build ' + SAVE_VERSION)
      }
      const width = data.width | 0
      const height = data.height | 0
      if (!(width > 0 && height > 0)) throw saveError('corrupt', 'bad world size in save')
      // A field that should be a list but is not must be an ERROR, not a silent
      // empty list: a truncated or hand-edited save used to load as a world with
      // a valid map and zero animals, which reads to the player as "my terrarium
      // vanished" with no explanation (docs/00-VISION G5, docs/20-CORE-LOOP §5).
      for (const field of ['entities', 'corpses', 'trees', 'caches']) {
        const value = data[field]
        if (value !== undefined && value !== null && !Array.isArray(value)) {
          throw saveError('corrupt', 'world save has a non-array ' + field)
        }
      }
      const size = width * height
      const bits = typeof data.bits === 'object' && data.bits !== null ? data.bits : FIELD_BITS.full
      const scales = typeof data.scales === 'object' && data.scales !== null ? data.scales : {}
      const scaleOf = (name, fallback) => (Number.isFinite(scales[name]) && scales[name] > 0 ? scales[name] : fallback)
      const world = {
        version: SAVE_VERSION,
        seed: (data.seed ?? 1) >>> 0,
        width,
        height,
        tick: Number.isFinite(data.tick) ? data.tick : 0,
        time: Number.isFinite(data.time) ? data.time : 0,
        rngState: (data.rngState ?? 1) >>> 0 || 1,
        immigration: data.immigration !== false,
        immigrationTimer: Number.isFinite(data.immigrationTimer) ? data.immigrationTimer : undefined,
        budget: data.budget === null || data.budget === undefined ? createBudget() : { ...createBudget(), ...data.budget },
        deaths: { ...(data.deaths ?? {}) },
        terrain: decodeBytes(data.terrain, Uint8Array),
        moisture: new Float32Array(size),
        depth: new Float32Array(size),
        waterFertility: new Float32Array(size),
        fertility: new Float32Array(size),
        grass: new Float32Array(size),
        weed: new Float32Array(size),
        detritus: new Float32Array(size),
        light: new Float32Array(size),
        canopy: new Float32Array(size),
        canopyDirty: true,
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: Number.isFinite(data.nextId) ? data.nextId : 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      if (world.terrain.length !== size) throw saveError('corrupt', 'bad terrain length in save')
      world.climate = createClimate(world.time)
      world.nutrient = world.fertility
      unpackField(data.fertility, size, bits.fertility ?? 8, scaleOf('fertility', 1), world.fertility)
      unpackField(data.grass, size, bits.grass ?? 8, scaleOf('grass', 1), world.grass)
      unpackField(data.weed, size, bits.weed ?? 8, scaleOf('weed', 1), world.weed)
      unpackField(data.detritus, size, bits.detritus ?? 4, scaleOf('detritus', 1), world.detritus)
      unpackField(data.waterFertility, size, bits.waterFertility ?? 4, scaleOf('waterFertility', 1), world.waterFertility)
      computeHydrology(world, false)
      for (const plant of Array.isArray(data.trees) ? data.trees : []) {
        if (!Number.isFinite(plant?.x) || !Number.isFinite(plant?.y)) continue
        world.trees.push({
          id: Number.isFinite(plant.id) ? plant.id : world.nextId++,
          x: plant.x,
          y: plant.y,
          variant: ['bush', 'lily', 'reed'].includes(plant.variant) ? plant.variant : 'tree',
          size: clamp(plant.size | 0 || 1, 1, 3),
          age: Number.isFinite(plant.age) ? plant.age : 0,
          foliage: clamp(Number.isFinite(plant.foliage) ? plant.foliage : 1, 0, 1),
          seedTimer: Number.isFinite(plant.seedTimer) ? plant.seedTimer : 45,
        })
      }
      for (const corpse of Array.isArray(data.corpses) ? data.corpses : []) {
        if (!Number.isFinite(corpse?.x) || !Number.isFinite(corpse?.y)) continue
        world.corpses.push({
          id: Number.isFinite(corpse.id) ? corpse.id : world.nextId++,
          x: corpse.x,
          y: corpse.y,
          species: SPECIES[corpse.species] === undefined ? null : corpse.species,
          decay: clamp(Number.isFinite(corpse.decay) ? corpse.decay : 0, 0, 1),
          energy: Number.isFinite(corpse.energy) ? corpse.energy : 20,
          mass: Number.isFinite(corpse.mass) ? corpse.mass : undefined,
          cause: typeof corpse.cause === 'string' ? corpse.cause : 'unknown',
        })
      }
      const pendingHandling = []
      // Restoring is not "energy being created": the saved budget already
      // accounts for these bodies, so the ledger accessor is muted while the
      // records are put back.
      ledgerWriteDepth += 1
      try {
      for (const saved of Array.isArray(data.entities) ? data.entities : []) {
        if (SPECIES[saved?.species] === undefined) continue
        if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue
        const entity = {
          id: Number.isFinite(saved.id) ? saved.id : world.nextId++,
          species: saved.species,
          x: saved.x,
          y: saved.y,
          heading: Number.isFinite(saved.heading) ? saved.heading : 0,
          age: Number.isFinite(saved.age) ? saved.age : 0,
          generation: Number.isFinite(saved.generation) ? saved.generation : 1,
          cooldown: Number.isFinite(saved.cooldown) ? saved.cooldown : 0,
          thinkTimer: Number.isFinite(saved.thinkTimer) ? saved.thinkTimer : 0,
          herdTimer: 0,
          herdAnchor: null,
          alarm: 0,
          targetX: Number.isFinite(saved.targetX) ? saved.targetX : saved.x,
          targetY: Number.isFinite(saved.targetY) ? saved.targetY : saved.y,
          fleeing: saved.fleeing === true,
          fate: '',
          children: Number.isFinite(saved.children) ? saved.children : 0,
          phase: Number.isFinite(saved.phase) ? saved.phase : 0,
          genes: restoreGenes(world, saved.species, saved.genes),
        }
        if (typeof saved.intent === 'string') {
          entity.intent = saved.intent
          entity.intentScore = Number.isFinite(saved.intentScore) ? saved.intentScore : 0
        }
        const body = installLedger(entity)
        if (saved.body !== undefined && saved.body !== null) {
          const savedBody = saved.body
          if (Number.isFinite(savedBody.V) && savedBody.V > 0) body.V = savedBody.V
          if (Number.isFinite(savedBody.Emax) && savedBody.Emax > 0) body.Emax = savedBody.Emax
          if (Number.isFinite(savedBody.E)) body.E = clamp(savedBody.E, 0, body.Emax)
          if (Number.isFinite(savedBody.M)) body.M = clamp(savedBody.M, 0, 1)
          if (Number.isFinite(savedBody.health)) body.health = clamp(savedBody.health, 0, 1)
          if (Number.isFinite(savedBody.fatigue)) body.fatigue = clamp(savedBody.fatigue, 0, 1)
          if (Number.isFinite(savedBody.gut)) body.gut = savedBody.gut
          if (Number.isFinite(savedBody.injury)) body.injury = savedBody.injury
          body.cause = typeof savedBody.cause === 'string' ? savedBody.cause : ''
          if (Number.isFinite(savedBody.handlingCorpse)) pendingHandling.push({ body, id: savedBody.handlingCorpse })
        }
        if (saved.needs !== null && typeof saved.needs === 'object') {
          const needs = needsOf(entity)
          for (const key of ['thirst', 'energy', 'safety', 'social']) {
            const value = saved.needs[key]
            if (Number.isFinite(value)) needs[key] = clamp(value, 0, 1)
          }
        }
        if (saved.drives !== null && typeof saved.drives === 'object') entity.drives = { ...saved.drives }
        if (saved.state !== null && typeof saved.state === 'object') entity.state = saved.state
        if (Number.isFinite(saved.stateEndedAt)) entity.stateEndedAt = saved.stateEndedAt
        if (saved.plan !== null && typeof saved.plan === 'object') entity.plan = saved.plan
        if (saved.belief !== null && typeof saved.belief === 'object') entity.belief = saved.belief
        world.entities.push(entity)
      }
      } finally {
        ledgerWriteDepth -= 1
      }
      // A predator that was mid-meal keeps eating after the reload.
      for (const pending of pendingHandling) {
        const corpse = world.corpses.find(candidate => candidate.id === pending.id)
        if (corpse !== undefined && corpse.energy > 0) pending.body.handling = { corpse }
      }
      world.history = Array.isArray(data.history) ? data.history.slice(-200) : []
      world.population = countPopulations(world)
      rebuildCanopy(world)
      return world
    }

    /**
     * gzip (or gunzip) a byte array with the Web CompressionStream API.
     * @param {Uint8Array} bytes - input.
     * @param {'gzip'|'gunzip'} mode - direction.
     * @returns {Promise<Uint8Array|null>} output, or null when unsupported.
     */
    async function transformBytes(bytes, mode) {
      const Ctor = mode === 'gzip' ? globalThis.CompressionStream : globalThis.DecompressionStream
      if (typeof Ctor !== 'function') return null
      const stream = new Ctor('gzip')
      const writer = stream.writable.getWriter()
      writer.write(bytes)
      writer.close()
      const reader = stream.readable.getReader()
      const chunks = []
      let length = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        length += value.length
      }
      const out = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    /**
     * Build a load failure the UI can branch on.
     *
     * A save is never thrown away quietly: the caller gets `code` (one of
     * `unsupported_version`, `corrupt`, `no_decompressor`) plus a message it can
     * put in front of the player, and the stored payload is left untouched.
     * @param {string} code - machine-readable reason.
     * @param {string} message - human-readable detail.
     * @returns {Error} tagged error.
     */
    function saveError(code, message) {
      const error = new Error(message)
      error.name = 'WorldSaveError'
      error.code = code
      return error
    }

    /**
     * Pack a world into a storage string.
     *
     * gzip where the host supports it (every current browser, and Node), plain
     * JSON with the coarser packing where it does not. The caller only has to
     * store the returned string; `unpackWorld` understands both.
     * @param {object} world - the world.
     * @returns {Promise<{text: string, compressed: boolean, detail: string, bytes: number}>} payload.
     */
    async function packWorld(world) {
      const compressed = typeof globalThis.CompressionStream === 'function'
      const detail = compressed ? 'full' : 'low'
      const json = JSON.stringify(serializeWorld(world, { detail }))
      if (!compressed) return { text: json, compressed: false, detail, bytes: json.length }
      const bytes = new TextEncoder().encode(json)
      const packed = await transformBytes(bytes, 'gzip')
      if (packed === null) return { text: json, compressed: false, detail: 'low', bytes: json.length }
      return { text: SAVE_GZIP_PREFIX + encodeBytes(packed), compressed: true, detail, bytes: packed.length }
    }

    /**
     * Unpack a string produced by `packWorld` (or a legacy plain-JSON save).
     * @param {string} text - stored payload.
     * @returns {Promise<object>} the save object.
     * @throws {Error} when the payload is corrupt or from another format.
     */
    async function unpackWorld(text) {
      const raw = String(text ?? '')
      try {
        if (raw.startsWith(SAVE_GZIP_PREFIX)) {
          const packed = decodeBytes(raw.slice(SAVE_GZIP_PREFIX.length), Uint8Array)
          const bytes = await transformBytes(packed, 'gunzip')
          if (bytes === null) throw saveError('no_decompressor', 'this host cannot decompress a world save')
          return JSON.parse(new TextDecoder().decode(bytes))
        }
        return JSON.parse(raw)
      } catch (error) {
        if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw error
        throw saveError('corrupt', 'world save could not be decoded: ' + (error?.message ?? 'unknown'))
      }
    }

    /**
     * Human-readable size of a save, for the panel's "saved" note.
     * @param {number} bytes - size.
     * @returns {string} e.g. "812 KB".
     */
    function formatSaveSize(bytes) {
      if (!(bytes > 0)) return '0 KB'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }
