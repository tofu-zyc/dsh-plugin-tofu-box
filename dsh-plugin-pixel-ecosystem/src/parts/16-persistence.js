    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------

    /**
     * Bytes → base64, chunked so a 26 KB terrain never blows the call stack.
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
     * Quantize a 0..1 float field to bytes (1 byte per cell keeps saves small).
     * @param {Float32Array} field - source field.
     * @returns {Uint8Array} quantized field.
     */
    function quantizeField(field) {
      const out = new Uint8Array(field.length)
      for (let i = 0; i < field.length; i++) {
        const value = field[i] * 255
        out[i] = value <= 0 ? 0 : value >= 255 ? 255 : value | 0
      }
      return out
    }

    /**
     * Expand a quantized field back to floats.
     * @param {string} text - base64 bytes.
     * @param {number} size - expected cell count.
     * @returns {Float32Array} restored field.
     */
    function dequantizeField(text, size) {
      const bytes = decodeBytes(text, Uint8Array)
      if (bytes.length !== size) throw new Error('bad field length in world save')
      const out = new Float32Array(size)
      for (let i = 0; i < size; i++) out[i] = bytes[i] / 255
      return out
    }

    /**
     * Serialize a world to a JSON-safe object.
     * Hydrology is dropped: it is recomputed from the terrain, byte for byte.
     * @param {object} world - the world.
     * @returns {object} save payload.
     */
    function serializeWorld(world) {
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
        terrain: encodeBytes(world.terrain),
        fertility: encodeBytes(quantizeField(world.fertility)),
        grass: encodeBytes(quantizeField(world.grass)),
        weed: encodeBytes(quantizeField(world.weed)),
        trees: world.trees.map(plant => ({ ...plant })),
        entities: world.entities.map(entity => ({
          id: entity.id,
          species: entity.species,
          x: entity.x,
          y: entity.y,
          heading: entity.heading,
          energy: entity.energy,
          age: entity.age,
          generation: entity.generation,
          cooldown: entity.cooldown,
          thinkTimer: entity.thinkTimer,
          targetX: entity.targetX,
          targetY: entity.targetY,
          fleeing: entity.fleeing === true,
          children: entity.children ?? 0,
          phase: entity.phase,
          genes: { ...entity.genes },
        })),
        corpses: world.corpses.map(corpse => ({ ...corpse })),
        history: world.history.slice(-200),
      }
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
      if (data === null || typeof data !== 'object' || data.version !== SAVE_VERSION) {
        throw new Error('unsupported world save')
      }
      const width = data.width | 0
      const height = data.height | 0
      if (!(width > 0 && height > 0)) throw new Error('bad world size in save')
      const size = width * height
      const world = {
        version: SAVE_VERSION,
        seed: (data.seed ?? 1) >>> 0,
        width,
        height,
        tick: Number.isFinite(data.tick) ? data.tick : 0,
        time: Number.isFinite(data.time) ? data.time : 0,
        rngState: (data.rngState ?? 1) >>> 0 || 1,
        immigration: data.immigration !== false,
        terrain: decodeBytes(data.terrain, Uint8Array),
        moisture: new Float32Array(size),
        depth: new Float32Array(size),
        waterFertility: new Float32Array(size),
        fertility: dequantizeField(data.fertility, size),
        grass: dequantizeField(data.grass, size),
        weed: dequantizeField(data.weed, size),
        trees: [],
        entities: [],
        corpses: [],
        effects: [],
        nextId: Number.isFinite(data.nextId) ? data.nextId : 1,
        stats: { day: 1, clock: '06:00', grass: 0, weed: 0, counts: {}, corpses: 0 },
        history: [],
      }
      if (world.terrain.length !== size) throw new Error('bad terrain in save')
      computeHydrology(world)
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
      for (const entity of Array.isArray(data.entities) ? data.entities : []) {
        if (SPECIES[entity?.species] === undefined) continue
        if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue
        world.entities.push({
          id: Number.isFinite(entity.id) ? entity.id : world.nextId++,
          species: entity.species,
          x: entity.x,
          y: entity.y,
          heading: Number.isFinite(entity.heading) ? entity.heading : 0,
          energy: Number.isFinite(entity.energy) ? entity.energy : SPECIES[entity.species].balance.startEnergy,
          age: Number.isFinite(entity.age) ? entity.age : 0,
          generation: Number.isFinite(entity.generation) ? entity.generation : 1,
          cooldown: Number.isFinite(entity.cooldown) ? entity.cooldown : 0,
          thinkTimer: Number.isFinite(entity.thinkTimer) ? entity.thinkTimer : 0,
          herdTimer: 0,
          herdAnchor: null,
          alarm: 0,
          targetX: Number.isFinite(entity.targetX) ? entity.targetX : entity.x,
          targetY: Number.isFinite(entity.targetY) ? entity.targetY : entity.y,
          fleeing: entity.fleeing === true,
          fate: '',
          children: Number.isFinite(entity.children) ? entity.children : 0,
          phase: Number.isFinite(entity.phase) ? entity.phase : 0,
          genes: restoreGenes(world, entity.species, entity.genes),
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
        })
      }
      world.history = Array.isArray(data.history) ? data.history.slice(-200) : []
      world.population = countPopulations(world)
      return world
    }
