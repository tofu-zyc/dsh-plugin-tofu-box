    // ---------------------------------------------------------------------
    // Store: owns the world, the viewport and the simulation loop
    // ---------------------------------------------------------------------

    /** Playback speeds, in simulation-time multipliers. */
    const SPEEDS = [1, 2, 4, 8]

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
      let pendingSnapshot = false
      let view = { x: 0, y: 0, width: 0, height: 0 }
      const brush = { tool: 'grass', radius: 1 }
      const listeners = new Set()

      /** Load the saved world, or create a fresh one. */
      function ensureWorld() {
        if (world !== null) return world
        world = load() ?? createWorld()
        world.hydrologyDirty = false
        minimap = null
        return world
      }

      /** Read and parse the saved world, ignoring anything unusable. */
      function load() {
        if (storage === null) return null
        try {
          const raw = storage.getItem(STORAGE_KEY)
          if (raw === null || raw === undefined) return null
          return deserializeWorld(JSON.parse(raw))
        } catch {
          return null
        }
      }

      /** Persist the world; a full or missing storage is not fatal. */
      function save() {
        if (storage === null || world === null) return
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(serializeWorld(world)))
        } catch {
          // Quota or disabled storage: keep running unsaved.
        }
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

      /** The inspected animal, if it is still alive. */
      function selectedEntity() {
        if (world === null || selectedId === 0) return undefined
        return findEntityById(world, selectedId)
      }

      /** Flatten one entity for the inspector. */
      function summariseEntity(entity) {
        const species = SPECIES[entity.species]
        return {
          id: entity.id,
          species: entity.species,
          age: entity.age,
          energy: entity.energy,
          maxEnergy: species === undefined ? 100 : species.balance.maxEnergy,
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
            paused,
            speed,
            stats: emptyStats(),
            world: { width: GRID_W, height: GRID_H },
            history: [],
            brush: { tool: brush.tool, radius: brush.radius },
            selected: null,
            following: false,
            view: { x: 0, y: 0, width: 0, height: 0 },
          }
        }
        const stats = sampleStats(world)
        const selected = selectedEntity()
        return {
          ready: true,
          paused,
          speed,
          stats,
          world: { width: world.width, height: world.height },
          history: world.history.slice(-120),
          brush: { tool: brush.tool, radius: brush.radius },
          selected: selected === undefined ? null : summariseEntity(selected),
          following: follow && selected !== undefined,
          view: { x: view.x, y: view.y, width: view.width, height: view.height },
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
        const useAtlas = atlas.ready === true && scale >= 3 && offscreenContext !== null
        paintView(world, view, frameBuffer, alpha, {
          hover,
          radius: brush.radius,
          selected: selected === undefined ? null : selected,
        }, { sprites: !useAtlas, plants: !useAtlas })
        const canvasWidth = view.width * (offscreenContext === null ? 1 : scale)
        const canvasHeight = view.height * (offscreenContext === null ? 1 : scale)
        if (offscreenContext !== null) {
          // Ground: 1 px per cell, upscaled with nearest neighbour.
          offscreenContext.putImageData(imageData, 0, 0)
          context.imageSmoothingEnabled = false
          context.drawImage(offscreen, 0, 0, view.width, view.height, 0, 0, canvasWidth, canvasHeight)
          // Plants and animals share one depth-sorted pass so a tree in front of
          // an animal actually covers it.
          if (useAtlas) drawDepthLayers(context, world, view, alpha)
        } else {
          context.putImageData(imageData, 0, 0)
        }
        // Day/night wash and dawn/dusk warmth, over the whole frame.
        const light = daylight(world)
        if (light < 0.98) {
          const darkness = Math.min(0.5, (1 - light) * 0.55)
          context.fillStyle = `rgba(12, 18, 44, ${darkness.toFixed(3)})`
          context.fillRect(0, 0, canvasWidth, canvasHeight)
        }
        const phase = (world.time % DAY_SECONDS) / DAY_SECONDS
        const warmth = phase > 0.17 && phase < 0.3
          ? 0.16 * (1 - Math.abs(phase - 0.235) / 0.065)
          : phase > 0.71 && phase < 0.85
            ? 0.18 * (1 - Math.abs(phase - 0.78) / 0.07)
            : 0
        if (warmth > 0.01) {
          context.fillStyle = `rgba(240, 150, 70, ${warmth.toFixed(3)})`
          context.fillRect(0, 0, canvasWidth, canvasHeight)
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
      function setView(next) {
        if (world === null) ensureWorld()
        const width = Math.max(1, Math.min(world.width, next.width | 0))
        const height = Math.max(1, Math.min(world.height, next.height | 0))
        const x = clamp(next.x | 0, 0, Math.max(0, world.width - width))
        const y = clamp(next.y | 0, 0, Math.max(0, world.height - height))
        const resized = width !== view.width || height !== view.height || imageData === null
        // Keep the zoom: the renderer needs it to size the display blit and to
        // decide whether the atlas sprites are worth drawing.
        const scale = typeof next.scale === 'number' && next.scale > 0 ? next.scale : (view.scale ?? 1)
        view = { x, y, width, height, scale }
        if (resized && context !== null) {
          imageData = context.createImageData(width, height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        if (resized && offscreen !== null) {
          offscreen.width = width
          offscreen.height = height
        }
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
        if (view.width <= 0 || view.height <= 0) {
          view = { x: 0, y: 0, width: Math.min(world.width, 160), height: Math.min(world.height, 100), scale: view.scale ?? 1 }
        }
        imageData = context.createImageData(view.width, view.height)
        frameBuffer = new Uint32Array(imageData.data.buffer)
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && offscreen === null) {
          offscreen = document.createElement('canvas')
          offscreen.width = view.width
          offscreen.height = view.height
          offscreenContext = offscreen.getContext('2d', { alpha: false })
        }
        ensureAtlas(publish)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('beforeunload', save)
        }
        startLoop()
        publish()
      }

      /** Unbind the canvas and save. */
      function detach() {
        stopLoop()
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', save)
        }
        canvas = null
        context = null
        imageData = null
        frameBuffer = null
      }

      /** Replace the world with a fresh one. */
      function newWorld(seed) {
        world = createWorld(seed === undefined ? {} : { seed })
        world.hydrologyDirty = false
        selectedId = 0
        follow = false
        accumulator = 0
        minimap = null
        if (context !== null) {
          const width = Math.min(world.width, Math.max(1, view.width))
          const height = Math.min(world.height, Math.max(1, view.height))
          view = { x: 0, y: 0, width, height, scale: view.scale ?? 1 }
          imageData = context.createImageData(width, height)
          frameBuffer = new Uint32Array(imageData.data.buffer)
        }
        save()
        publish()
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
          if (world === null) ensureWorld()
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
          if (world === null) ensureWorld()
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
          if (world === null) ensureWorld()
          const result = place(world, erase ? 'erase' : brush.tool, x, y, brush.radius)
          // The canvas repaints on the next animation frame anyway; a full
          // snapshot here would rescan 200k cells per cell of a brush drag.
          markDirty()
          return typeof result === 'number' ? result : 0
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
        save,
        peekSave() {
          return load()
        },
        dispose() {
          detach()
          listeners.clear()
          disposed = true
        },
      }
    }

    // Locale