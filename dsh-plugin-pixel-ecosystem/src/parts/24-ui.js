    // ---------------------------------------------------------------------
    // Panel UI
    // ---------------------------------------------------------------------

    /**
     * Error boundary around the panel.
     *
     * A render error used to take the whole panel down to a blank area with no
     * explanation. Now the failure itself is on screen, with its stack, so the
     * next bug reports itself instead of looking like "nothing rendered".
     */
    class PanelBoundary extends (React.Component ?? Object) {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[pixel-ecosystem] panel crashed', error, info)
        }
      }

      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          const stack = this.state.error.stack === undefined ? String(this.state.error) : this.state.error.stack
          return h('div', { className: 'pe-fatal' },
            h('div', { className: 'pe-fatal-title' }, this.props.title ?? '面板渲染出错 / Panel failed to render'),
            h('pre', { className: 'pe-fatal-body' }, String(stack)))
        }
        return this.props.children ?? null
      }
    }

    /** Only wrap in the real React; the test shim has no class components. */
    const PANEL_BOUNDARY = typeof React.Component === 'function' ? PanelBoundary : props => props.children ?? null
    /** Tool groups for the side palette. */
    // Every species in SPECIES must appear here or the player cannot place it.
    // The palette is generated from SPECIES_IDS for exactly that reason: a new
    // species row used to be visible in the counters but missing from the tools.
    const LIFE_TOOLS = ['grass', 'weed', 'tree', 'bush', ...SPECIES_IDS]
    const TERRAIN_TOOL_IDS = ['water', 'sand', 'dirt', 'stone', 'erase', 'pointer']
    const BRUSHES = [0, 1, 2]
    const BRUSH_RADIUS = [0, 1, 2]
    const MIN_SCALE = 1
    const MAX_SCALE = 16

    /**
     * The one and only camera → viewport conversion.
     *
     * The render path and the input path both call this. Two separate copies of
     * this maths is exactly how zoom-to-cursor and hit-testing drift apart, which
     * is what made the canvas feel broken.
     * @param {{cx: number, cy: number, scale: number}} camera - camera state.
     * @param {{width: number, height: number}} stage - stage size in CSS px.
     * @param {{width: number, height: number}} world - world size in cells.
     * @returns {{x: number, y: number, width: number, height: number, scale: number, offsetX: number, offsetY: number}} viewport.
     */
    function viewFromCamera(camera, stage, world) {
      const scale = clamp(camera.scale, MIN_SCALE, MAX_SCALE)
      const width = Math.max(24, Math.min(world.width, Math.floor(stage.width / scale)))
      const height = Math.max(18, Math.min(world.height, Math.floor(stage.height / scale)))
      const x = clamp(Math.round(camera.cx - width / 2), 0, Math.max(0, world.width - width))
      const y = clamp(Math.round(camera.cy - height / 2), 0, Math.max(0, world.height - height))
      // The canvas is centred in the stage, so the leftover margin is a letterbox.
      const offsetX = Math.max(0, (stage.width - width * scale) / 2)
      const offsetY = Math.max(0, (stage.height - height * scale) / 2)
      return { x, y, width, height, scale, offsetX, offsetY }
    }

    /**
     * Stage-relative client coordinates → world cell coordinates.
     * @param {object} view - result of `viewFromCamera`.
     * @param {{left: number, top: number}} stageRect - stage bounding rect.
     * @param {number} clientX - pointer x.
     * @param {number} clientY - pointer y.
     * @returns {{x: number, y: number}} world cell (fractional).
     */
    function worldFromPoint(view, stageRect, clientX, clientY) {
      return {
        x: view.x + (clientX - stageRect.left - view.offsetX) / view.scale,
        y: view.y + (clientY - stageRect.top - view.offsetY) / view.scale,
      }
    }

    /**
     * Camera that keeps the world point under the cursor pinned while zooming.
     * @param {object} camera - current camera.
     * @param {{width: number, height: number}} stage - stage size.
     * @param {{width: number, height: number}} world - world size.
     * @param {{left: number, top: number}} stageRect - stage bounding rect.
     * @param {number} clientX - anchor x.
     * @param {number} clientY - anchor y.
     * @param {number} nextScale - requested zoom.
     * @returns {{cx: number, cy: number, scale: number}} new camera.
     */
    function cameraAfterZoom(camera, stage, world, stageRect, clientX, clientY, nextScale) {
      const before = viewFromCamera(camera, stage, world)
      const anchor = worldFromPoint(before, stageRect, clientX, clientY)
      const after = viewFromCamera({ cx: camera.cx, cy: camera.cy, scale: nextScale }, stage, world)
      const cursorX = clientX - stageRect.left - after.offsetX
      const cursorY = clientY - stageRect.top - after.offsetY
      return {
        cx: anchor.x - cursorX / after.scale + after.width / 2,
        cy: anchor.y - cursorY / after.scale + after.height / 2,
        scale: nextScale,
      }
    }

    /**
     * Subscribe a component to the store snapshot.
     * @param {object} store - the store.
     * @returns {object} snapshot.
     */
    function useStore(store) {
      const subscribe = React.useCallback(listener => store.subscribe(listener), [store])
      const read = React.useCallback(() => store.getSnapshot(), [store])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /**
     * Inspector card: species, energy, genes, lineage, follow and deselect.
     * @param {object} props - `{ selected, t, onFollow, onClear, following }`.
     * @returns {object} React element.
     */
    function Inspector(props) {
      const { selected, t, onFollow, onClear, following } = props
      if (selected === null || selected === undefined) {
        return h('div', { className: 'pe-empty' },
          h('div', { className: 'pe-empty-icon' }, h(PixelGlyph, { name: 'target', size: 22 })),
          h('div', { className: 'pe-empty-title' }, t('inspect.empty')),
          h('div', { className: 'pe-empty-hint' }, t('inspect.emptyHint')))
      }
      const species = SPECIES[selected.species]
      const energyRatio = clamp(selected.energy / Math.max(1, selected.maxEnergy), 0, 1)
      const genes = species === undefined ? [] : GENE_KEYS.map((key) => {
        const range = species.genes[key]
        const ratio = clamp((selected.genes[key] - range[0]) / Math.max(1e-6, range[1] - range[0]), 0, 1)
        return h('div', { className: 'pe-gene', key },
          h('span', { className: 'pe-gene-label' }, t(`inspect.gene.${key}`)),
          h('span', { className: 'pe-gene-track' }, h('span', {
            className: 'pe-gene-fill',
            style: { width: `${Math.round(ratio * 100)}%`, background: species.color },
          })),
          h('span', { className: 'pe-gene-value' }, selected.genes[key].toFixed(1)))
      })
      return h('div', { className: 'pe-card' },
        h('div', { className: 'pe-card-head' },
          h('span', { className: 'pe-swatch', style: { background: species?.color } }),
          h('span', { className: 'pe-card-title' }, t(`species.${selected.species}`)),
          h('span', { className: 'pe-tag' }, t(`stage.${selected.stage ?? 'adult'}`)),
          selected.intent === 'flee'
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('intent.flee'))
            : h('span', { className: 'pe-tag pe-tag-intent' }, t(`intent.${selected.intent ?? 'explore'}`)),
          h('button', {
            type: 'button', className: 'pe-icon-btn', title: t('action.deselect'),
            'aria-label': t('action.deselect'), onClick: onClear,
          }, h(PixelGlyph, { name: 'close', size: 12 }))),
        h('div', { className: 'pe-meter' },
          h('span', { className: 'pe-meter-fill', style: { width: `${Math.round(energyRatio * 100)}%` } })),
        h('div', { className: 'pe-rows' },
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.age')), h('b', null, `${Math.round(selected.age)}s`)),
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.energy')), h('b', null, `${Math.round(selected.energy)} / ${Math.round(selected.maxEnergy)}`))),
        h('div', { className: 'pe-chipline' },
          h('span', { className: 'pe-tag' }, t('inspect.generation', { n: selected.generation })),
          h('span', { className: 'pe-tag' }, t('inspect.children', { n: selected.children }))),
        h('div', { className: 'pe-needs' },
          NEED_KEYS.map(key => h('div', { className: 'pe-need', key },
            h('span', { className: 'pe-need-label' }, t(`needs.${key}`)),
            h('span', { className: 'pe-need-track' }, h('span', {
              className: 'pe-need-fill',
              style: { width: `${Math.round((selected.needs?.[key] ?? 0) * 100)}%` },
            })),
            h('span', { className: 'pe-need-value' }, String(Math.round((selected.needs?.[key] ?? 0) * 100)))))),
        h('div', { className: 'pe-genes' }, genes),
        h('button', {
          type: 'button',
          className: `pe-btn pe-btn-block${following ? ' pe-btn-active' : ''}`,
          onClick: onFollow,
        }, following ? t('inspect.unfollow') : t('inspect.follow')))
    }

    /**
     * Population chart with filled areas and a legend.
     * @param {object} props - `{ history, t }`.
     * @returns {object} React element.
     */
    function PopulationChart(props) {
      const { history, t } = props
      const canvasRef = React.useRef(null)
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.getContext !== 'function') return
        const context = canvas.getContext('2d')
        if (context === null) return
        const width = canvas.width
        const height = canvas.height
        context.clearRect(0, 0, width, height)
        context.strokeStyle = 'rgba(128,128,128,0.22)'
        context.lineWidth = 1
        for (let i = 1; i < 3; i++) {
          const y = Math.round((height / 3) * i) + 0.5
          context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke()
        }
        if (history.length < 2) return
        let peak = 1
        for (const sample of history) {
          for (const id of SPECIES_IDS) peak = Math.max(peak, sample.counts[id] ?? 0)
        }
        const stepX = width / Math.max(1, history.length - 1)
        for (const id of SPECIES_IDS) {
          const values = history.map(sample => sample.counts[id] ?? 0)
          if (!values.some(value => value > 0)) continue
          const color = SPECIES[id].color
          context.beginPath()
          values.forEach((value, index) => {
            const x = index * stepX
            const y = height - 2 - (value / peak) * (height - 4)
            if (index === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
          })
          context.lineTo(width, height)
          context.lineTo(0, height)
          context.closePath()
          context.fillStyle = color
          context.globalAlpha = 0.12
          context.fill()
          context.globalAlpha = 1
          context.beginPath()
          values.forEach((value, index) => {
            const x = index * stepX
            const y = height - 2 - (value / peak) * (height - 4)
            if (index === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
          })
          context.strokeStyle = color
          context.lineWidth = 1.4
          context.stroke()
        }
      }, [history])
      return h('div', { className: 'pe-panel' },
        h('div', { className: 'pe-panel-title' }, t('chart.title')),
        h('canvas', { ref: canvasRef, width: 240, height: 64, className: 'pe-chart' }),
        h('div', { className: 'pe-legend' }, SPECIES_IDS.map(id => h('span', { className: 'pe-legend-item', key: id },
          h('span', { className: 'pe-swatch pe-swatch-sm', style: { background: SPECIES[id].color } }),
          h('span', null, t(`species.${id}`))))))
    }

    /**
     * Minimap with the current viewport rectangle; click to jump.
     * @param {object} props - `{ store, snapshot, onJump }`.
     * @returns {object} React element.
     */
    function Minimap(props) {
      const { store, snapshot, onJump } = props
      const canvasRef = React.useRef(null)
      const MAP_W = 168
      const MAP_H = 105
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.getContext !== 'function') return
        const context = canvas.getContext('2d')
        if (context === null) return
        const minimap = store.getMinimap(MAP_W, MAP_H)
        const image = context.createImageData(MAP_W, MAP_H)
        const view32 = new Uint32Array(image.data.buffer)
        view32.set(minimap.data)
        context.putImageData(image, 0, 0)
        const world = snapshot?.world
        const view = snapshot?.view
        if (!world || !view || view.width <= 0) return
        const scaleX = MAP_W / world.width
        const scaleY = MAP_H / world.height
        context.strokeStyle = 'rgba(255,255,255,0.9)'
        context.lineWidth = 1
        context.strokeRect(view.x * scaleX + 0.5, view.y * scaleY + 0.5,
          Math.max(2, view.width * scaleX - 1), Math.max(2, view.height * scaleY - 1))
      }, [store, snapshot, MAP_W, MAP_H])
      return h('div', { className: 'pe-minimap' },
        h('canvas', {
          ref: canvasRef,
          width: MAP_W,
          height: MAP_H,
          className: 'pe-minimap-canvas',
          onPointerDown: (event) => {
            const canvas = canvasRef.current
            if (canvas === null) return
            const bounds = canvas.getBoundingClientRect()
            const world = snapshot.world
            if (world === null) return
            onJump(((event.clientX - bounds.left) / bounds.width) * world.width,
              ((event.clientY - bounds.top) / bounds.height) * world.height)
          },
        }))
    }

    /**
     * The whole panel.
     * @param {object} props - slot props plus `{ store, locale, layout }`.
     * @returns {object} React element.
     */
    function TerrariumPanel(props) {
      const { store, locale, layout } = props
      const t = useTranslate(locale)
      const snapshot = useStore(store)
      const worldSize = snapshot.world ?? { width: GRID_W, height: GRID_H }
      const [tool, setTool] = React.useState('pointer')
      const [brushIndex, setBrushIndex] = React.useState(1)
      const [helpOpen, setHelpOpen] = React.useState(false)
      const [confirmNew, setConfirmNew] = React.useState(false)
      const [cameraTick, setCameraTick] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const [hoverCell, setHoverCell] = React.useState(null)
      const toastTimer = React.useRef(0)
      const stageRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const cameraRef = React.useRef({ cx: worldSize.width / 2, cy: worldSize.height / 2, scale: 6, fitted: false })
      const dragRef = React.useRef({ mode: 'none', moved: 0, lastX: 0, lastY: 0, lastCell: '', button: 0 })
      const [stageSize, setStageSize] = React.useState({ width: 900, height: 560 })
      const stageSizeRef = React.useRef(stageSize)
      React.useEffect(() => { stageSizeRef.current = stageSize }, [stageSize])

      /** Viewport in cells; the exact same function the input layer uses. */
      const view = React.useMemo(
        () => viewFromCamera(cameraRef.current, stageSize, worldSize),
        [worldSize.width, worldSize.height, stageSize.width, stageSize.height, cameraTick],
      )

      React.useEffect(() => {
        store.ensureWorld()
        store.setView({ x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale })
        store.attach(canvasRef.current)
        return () => store.detach()
        // Attach once: the viewport effect below re-points the renderer, so a
        // pan must never tear the canvas binding down and rebuild it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [store])

      React.useEffect(() => {
        store.setView({ x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale })
      }, [store, view.x, view.y, view.width, view.height, view.scale])

      React.useEffect(() => {
        store.setBrush(tool, BRUSH_RADIUS[brushIndex])
      }, [store, tool, brushIndex])

      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const measure = () => {
          const bounds = stage.getBoundingClientRect()
          setStageSize({ width: Math.max(200, bounds.width), height: Math.max(160, bounds.height) })
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(stage)
        return () => observer.disconnect()
      }, [])

      // Open zoomed in enough to read the animals, centred on the map.
      React.useEffect(() => {
        if (cameraRef.current.fitted) return
        const fit = Math.max(1, Math.min(stageSize.width / worldSize.width, stageSize.height / worldSize.height))
        cameraRef.current.scale = clamp(Math.round(Math.max(5, fit * 4)), 4, 8)
        cameraRef.current.cx = worldSize.width / 2
        cameraRef.current.cy = worldSize.height / 2
        cameraRef.current.fitted = true
        setCameraTick(value => value + 1)
      }, [stageSize, worldSize])

      const bumpCamera = React.useCallback(() => setCameraTick(value => value + 1), [])

      /** Centre the camera on a world point. */
      const lookAt = React.useCallback((x, y) => {
        cameraRef.current.cx = clamp(x, 0, worldSize.width)
        cameraRef.current.cy = clamp(y, 0, worldSize.height)
        cameraRef.current.fitted = true
        bumpCamera()
      }, [worldSize, bumpCamera])

      /** Fit the whole map at an integer zoom. */
      const fitAll = React.useCallback(() => {
        const fit = Math.min(stageSize.width / worldSize.width, stageSize.height / worldSize.height)
        cameraRef.current.scale = clamp(Math.max(1, Math.floor(fit)), 1, MAX_SCALE)
        cameraRef.current.cx = worldSize.width / 2
        cameraRef.current.cy = worldSize.height / 2
        cameraRef.current.fitted = true
        bumpCamera()
      }, [stageSize, worldSize, bumpCamera])

      // ---------------------------------------------------------------------
      // Input: pointer mode pans and selects; the brush tools paint.
      // ---------------------------------------------------------------------
      const translateRef = React.useRef(t)
      const toolRef = React.useRef(tool)
      const viewRef = React.useRef(view)
      React.useEffect(() => {
        translateRef.current = t
        toolRef.current = tool
        viewRef.current = view
      }, [t, tool, view])

      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined

        const stageRect = () => stage.getBoundingClientRect()
        const cellAt = (clientX, clientY) => worldFromPoint(viewRef.current, stageRect(), clientX, clientY)

        const report = (released) => {
          if (SPECIES[toolRef.current] === undefined) return
          const translate = translateRef.current
          setToast(released > 0 ? translate('toast.placed', { n: released }) : translate('toast.blocked'))
          if (toastTimer.current !== 0) clearTimeout(toastTimer.current)
          toastTimer.current = setTimeout(() => setToast(null), 1800)
        }

        /** Pointer mode (or the middle button) drags the map; brushes paint. */
        const shouldPan = (event) => toolRef.current === 'pointer' || event.button === 1

        const handleDown = (event) => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
          const drag = dragRef.current
          drag.mode = shouldPan(event) ? 'pan' : 'paint'
          drag.button = event.button
          drag.moved = 0
          drag.lastX = event.clientX
          drag.lastY = event.clientY
          drag.lastCell = ''
          const point = cellAt(event.clientX, event.clientY)
          if (drag.mode === 'paint') {
            drag.lastCell = `${Math.round(point.x)},${Math.round(point.y)}`
            report(store.paintAt(point.x, point.y, event.button === 2))
          }
          if (typeof stage.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
            try { stage.setPointerCapture(event.pointerId) } catch { /* capture is optional */ }
          }
          event.preventDefault()
        }

        const handleMove = (event) => {
          const point = cellAt(event.clientX, event.clientY)
          const cell = `${Math.round(point.x)},${Math.round(point.y)}`
          setHoverCell(cell)
          store.setHover(point)
          const drag = dragRef.current
          if (drag.mode === 'none') return
          // A lost pointerup (alt-tab, browser gesture) must not leave the brush
          // or the map stuck to the cursor.
          if (event.buttons === 0) { drag.mode = 'none'; return }
          const dx = event.clientX - drag.lastX
          const dy = event.clientY - drag.lastY
          drag.moved += Math.abs(dx) + Math.abs(dy)
          const current = viewRef.current
          if (drag.mode === 'pan') {
            cameraRef.current.cx -= dx / current.scale
            cameraRef.current.cy -= dy / current.scale
            bumpCamera()
          } else if (cell !== drag.lastCell) {
            drag.lastCell = cell
            store.paintAt(point.x, point.y, (event.buttons & 2) === 2)
          }
          drag.lastX = event.clientX
          drag.lastY = event.clientY
        }

        const handleUp = (event) => {
          const drag = dragRef.current
          const wasTap = drag.moved < 10 && drag.button === event.button
          const mode = drag.mode
          drag.mode = 'none'
          if (!wasTap) return
          const point = cellAt(event.clientX, event.clientY)
          if (mode === 'pan' && event.button === 0) {
            // Pointer mode: a tap inspects, a drag pans.
            const entity = store.selectAt(point.x, point.y)
            if (entity === undefined) store.clearSelection()
          } else if (mode === 'paint' && event.button === 2) {
            store.clearSelection()
          }
        }

        const handleWheel = (event) => {
          event.preventDefault()
          const current = viewRef.current
          const nextScale = clamp(current.scale + (event.deltaY < 0 ? 1 : -1), MIN_SCALE, MAX_SCALE)
          if (nextScale === current.scale) return
          const world = store.getWorld() ?? { width: current.width, height: current.height }
          const camera = cameraAfterZoom(
            { cx: cameraRef.current.cx, cy: cameraRef.current.cy, scale: current.scale },
            stageSizeRef.current,
            world,
            stageRect(),
            event.clientX,
            event.clientY,
            nextScale,
          )
          cameraRef.current.cx = camera.cx
          cameraRef.current.cy = camera.cy
          cameraRef.current.scale = camera.scale
          bumpCamera()
        }

        const handleLeave = () => {
          store.setHover(null)
          setHoverCell(null)
          dragRef.current.mode = 'none'
        }

        const handleContext = (event) => event.preventDefault()

        stage.addEventListener('pointerdown', handleDown)
        stage.addEventListener('pointermove', handleMove)
        stage.addEventListener('pointerup', handleUp)
        stage.addEventListener('pointercancel', handleUp)
        stage.addEventListener('pointerleave', handleLeave)
        stage.addEventListener('wheel', handleWheel, { passive: false })
        stage.addEventListener('contextmenu', handleContext)
        return () => {
          stage.removeEventListener('pointerdown', handleDown)
          stage.removeEventListener('pointermove', handleMove)
          stage.removeEventListener('pointerup', handleUp)
          stage.removeEventListener('pointercancel', handleUp)
          stage.removeEventListener('pointerleave', handleLeave)
          stage.removeEventListener('wheel', handleWheel)
          stage.removeEventListener('contextmenu', handleContext)
        }
      }, [store, bumpCamera])


      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setHelpOpen(false)
            setConfirmNew(false)
            store.clearSelection()
            return
          }
          if (event.target !== null && event.target.tagName === 'INPUT') return
          if (event.code === 'Space') { event.preventDefault(); store.togglePause() }
          else if (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4') {
            store.setSpeed([1, 2, 4, 8][Number(event.key) - 1])
          } else if (event.key === 'f' || event.key === 'F') fitAll()
          else if (event.key === 'h' || event.key === 'H') setHelpOpen(open => !open)
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }
        return undefined
      }, [store, fitAll])

      React.useEffect(() => {
        if (!confirmNew) return undefined
        const timer = setTimeout(() => setConfirmNew(false), 2600)
        return () => clearTimeout(timer)
      }, [confirmNew])

      const selected = snapshot.selected ?? null

      const speciesChips = SPECIES_IDS.map((id) => h('span', {
        className: 'pe-chip', key: id, title: t(`species.${id}`),
      },
        h('span', { className: 'pe-swatch pe-swatch-sm', style: { background: SPECIES[id].color } }),
        h('span', { className: 'pe-chip-count' }, String(snapshot.stats?.counts?.[id] ?? 0))))

      const toolButton = (id) => {
        const isSpecies = SPECIES[id] !== undefined
        const color = isSpecies ? SPECIES[id].color : undefined
        const label = isSpecies ? t(`species.${id}`) : t(`tool.${id}`)
        return h('button', {
          type: 'button', key: id,
          className: `pe-tool${tool === id ? ' is-active' : ''}`,
          onClick: () => setTool(id),
          title: label,
          'aria-pressed': tool === id,
          'aria-label': label,
        },
          h(PixelGlyph, { name: isSpecies ? 'creature' : id, color, size: 18 }),
          h('span', { className: 'pe-tool-label' }, label))
      }

      const speedButton = (value) => h('button', {
        type: 'button', key: value,
        className: `pe-seg-btn${snapshot.speed === value && !snapshot.paused ? ' is-active' : ''}`,
        onClick: () => store.setSpeed(value),
        'aria-label': t(`speed.${value}`),
      }, t(`speed.${value}`))

      return h('div', { className: 'pe-root' },
        h('header', { className: 'pe-head' },
          h('div', { className: 'pe-brand' },
            h('span', { className: 'pe-logo' }, h(PixelGlyph, { name: 'tree', color: '#4a9d54', size: 18 })),
            h('div', null,
              h('div', { className: 'pe-title' }, t('panel.title')),
              h('div', { className: 'pe-sub' },
                `${t('stat.day', { day: snapshot.stats?.day ?? 1 })} · ${snapshot.stats?.clock ?? '06:00'}`))),
          h('div', { className: 'pe-chips' }, speciesChips),
          h('div', { className: 'pe-controls' },
            h('button', {
              type: 'button', className: 'pe-icon-btn pe-icon-btn-lg',
              onClick: () => store.togglePause(),
              title: snapshot.paused ? t('action.play') : t('action.pause'),
              'aria-label': snapshot.paused ? t('action.play') : t('action.pause'),
            }, h(PixelGlyph, { name: snapshot.paused ? 'play' : 'pause', size: 14 })),
            h('div', { className: 'pe-seg' }, SPEEDS.map(speedButton)),
            h('button', {
              type: 'button', className: 'pe-icon-btn',
              onClick: () => store.stepOnce(), title: t('action.step'), 'aria-label': t('action.step'),
            }, h(PixelGlyph, { name: 'step', size: 12 })),
            h('span', { className: 'pe-divider' }),
            h('button', {
              type: 'button',
              className: `pe-btn${confirmNew ? ' pe-btn-danger' : ''}`,
              onClick: () => {
                if (!confirmNew) { setConfirmNew(true); return }
                setConfirmNew(false)
                store.newWorld()
                fitAll()
              },
            }, confirmNew ? t('action.newWorldConfirm') : t('action.newWorld')),
            h('button', { type: 'button', className: 'pe-btn', onClick: fitAll }, t('action.fit')),
            h('button', {
              type: 'button', className: `pe-btn${helpOpen ? ' pe-btn-active' : ''}`,
              onClick: () => setHelpOpen(open => !open),
            }, t('action.help')),
            layout !== undefined && typeof layout.selectPanel === 'function'
              ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => layout.selectPanel('conversation') }, t('action.back'))
              : null)),
        h('div', { className: 'pe-body' },
          h('div', {
            className: 'pe-stage',
            ref: stageRef,
            style: { cursor: tool === 'pointer' ? 'grab' : 'crosshair' },
          },
            h('canvas', {
              ref: canvasRef,
              className: 'pe-canvas',
              width: view.width * view.scale,
              height: view.height * view.scale,
              style: {
                width: `${view.width * view.scale}px`,
                height: `${view.height * view.scale}px`,
              },
            }),
            h('div', { className: 'pe-hud pe-hud-bl' },
              h('span', { className: 'pe-hud-item' }, hoverCell === null ? '—' : hoverCell),
              h('span', { className: 'pe-hud-item' }, `${view.x},${view.y}`),
              h('span', { className: 'pe-hud-item' }, `${view.width}×${view.height}`),
              h('span', { className: 'pe-hud-item' }, `${view.scale}×`)),
            h('div', { className: 'pe-hud pe-hud-br' },
              h(Minimap, { store, snapshot, onJump: lookAt })),
            toast === null ? null : h('div', { className: 'pe-toast' }, toast)),
          h('aside', { className: 'pe-side' },
            h('section', { className: 'pe-panel' },
              h('div', { className: 'pe-panel-title' }, t('tool.group.life')),
              h('div', { className: 'pe-tools' }, LIFE_TOOLS.map(toolButton))),
            h('section', { className: 'pe-panel' },
              h('div', { className: 'pe-panel-title' }, t('tool.group.terrain')),
              h('div', { className: 'pe-tools' }, TERRAIN_TOOL_IDS.map(toolButton))),
            h('section', { className: 'pe-panel pe-panel-row' },
              h('div', { className: 'pe-panel-title' }, t('brush.label')),
              h('div', { className: 'pe-seg' }, BRUSHES.map((radius, index) => h('button', {
                type: 'button', key: radius,
                className: `pe-seg-btn${brushIndex === index ? ' is-active' : ''}`,
                onClick: () => setBrushIndex(index),
                'aria-label': t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'),
              }, t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'))))),
            h(PopulationChart, { history: snapshot.history ?? [], t }),
            h('section', { className: 'pe-panel pe-panel-grow' },
              h('div', { className: 'pe-panel-title' }, t('inspect.title')),
              h(Inspector, {
                selected,
                t,
                following: snapshot.following === true,
                onFollow: () => store.setFollow(!snapshot.following),
                onClear: () => store.clearSelection(),
              })))),
        helpOpen
          ? h('div', { className: 'pe-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('help.title'), onClick: () => setHelpOpen(false) },
            h('div', { className: 'pe-modal-card', onClick: event => event.stopPropagation() },
              h('div', { className: 'pe-modal-head' },
                h('span', { className: 'pe-title' }, t('help.title')),
                h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => setHelpOpen(false) }, t('action.close'))),
              h('ul', { className: 'pe-modal-body' },
                [1, 2, 3, 4, 5, 6, 7, 8].map(index => h('li', { key: index }, t(`help.${index}`))))))
          : null)
    }

