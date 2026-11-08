    // ---------------------------------------------------------------------
    // Panel UI
    // ---------------------------------------------------------------------
    //
    // Three ideas hold this file together:
    //
    //  1. Every panel answers a question a player would ask out loud: what is
    //     left, what is it doing, why, and where did the energy go. A number
    //     with no sentence next to it does not ship.
    //  2. Anything the engine does not publish yet is drawn as derived and
    //     labelled, never invented. The panels get richer for free as the
    //     simulation starts reporting (see docs/80-UI.md).
    //  3. All three side tabs are mounted and hidden with CSS rather than
    //     unmounted, so every panel is exercised by the render test instead of
    //     only the tab that happens to be active.

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

    /** Side-panel tabs, in reading order. */
    const SIDE_TABS = ['tools', 'species', 'energy']

    /** Ticker filter chips: everything, then one per event kind. */
    const EVENT_FILTERS = ['all', ...EVENT_KINDS]

    /**
     * Colour per death cause, shared by the species bar, the inspector chip and
     * the ticker, so a red kill reads red everywhere.
     */
    const CAUSE_COLORS = {
      predation: '#d9534f',
      starved: '#c98a2b',
      frozen: '#4f8fd0',
      old: '#8a8f99',
      disease: '#9a6bd0',
      unknown: '#5d6470',
    }

    /** Stage colours for the energy cascade. */
    const FLOW_COLORS = {
      sun: '#e0a13a',
      plants: '#4a9d54',
      herbs: '#c9a97b',
      carns: '#d2733c',
      respire: '#5d6470',
    }

    /**
     * Translation for a state id. A state behaviour adds later still renders, as
     * its raw id, instead of as a blank chip.
     * @param {Function} t - translator.
     * @param {string} id - state or intent id.
     * @returns {string} label.
     */
    function intentLabel(t, id) {
      if (typeof id !== 'string' || id === '') return ''
      return INTENT_IDS.includes(id) ? t('intent.' + id) : id
    }

    /**
     * Translation for the phase of a timed state. Behaviour may add a phase, and
     * an unknown one must fall back to its raw id instead of leaking the key.
     * @param {Function} t - translator.
     * @param {string} phase - phase id.
     * @returns {string} label.
     */
    function phaseLabel(t, phase) {
      if (typeof phase !== 'string' || phase === '') return ''
      if (phase === 'approach' || phase === 'execute' || phase === 'done') return t('phase.' + phase)
      if (phase === 'do') return t('phase.execute')
      if (phase === 'adopted') return t('phase.approach')
      return phase
    }

    /**
     * Translation for the drive code a decision says it acted on.
     * @param {Function} t - translator.
     * @param {string} code - why code from the decision record.
     * @returns {string} label.
     */
    function whyLabel(t, code) {
      if (typeof code !== 'string' || code === '') return ''
      if (DRIVE_KEYS.includes(code)) return t('drive.' + code)
      if (code === 'search') return t('reason.search')
      if (code === 'idle') return t('reason.idle')
      return code
    }

    /**
     * A duration as a compact chip value.
     * @param {number} seconds - in-world seconds.
     * @returns {string} e.g. '3.4s', '48s', '2:05'.
     */
    function shortTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '—'
      if (seconds < 10) return (Math.round(seconds * 10) / 10) + 's'
      if (seconds < 120) return Math.round(seconds) + 's'
      return Math.floor(seconds / 60) + ':' + String(Math.round(seconds % 60)).padStart(2, '0')
    }

    /**
     * Energy with a unit prefix, in kJ.
     * @param {number} kilojoules - energy.
     * @returns {string} e.g. '820', '12.4k', '2.31M'.
     */
    function formatEnergy(kilojoules) {
      const value = Number.isFinite(kilojoules) ? kilojoules : 0
      if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + 'M'
      if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(Math.round(value))
    }

    /**
     * 0..1 as a whole percentage.
     * @param {number} ratio - fraction.
     * @returns {number} 0..100.
     */
    function percentOf(ratio) {
      return Math.round(clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1) * 100)
    }

    /**
     * The one and only camera to viewport conversion.
     *
     * The render path and the input path both call this. Two separate copies of
     * this maths is exactly how zoom-to-cursor and hit-testing drift apart.
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
     * Stage-relative client coordinates to world cell coordinates.
     * @param {object} view - result of viewFromCamera.
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
     * One label of a key/value block.
     * @param {object} props - props.label, props.title.
     * @returns {object} React element.
     */
    function KeyValue(props) {
      return h('span', { className: 'pe-kv-key', title: props.title }, props.label)
    }

    /**
     * Death-cause bar: one segment per cause, in a fixed cause order so the same
     * cause sits in the same place on every row and rows can be compared.
     * @param {object} props - props.deaths, props.t.
     * @returns {object} React element.
     */
    function CauseBar(props) {
      const deaths = props.deaths ?? {}
      const t = props.t
      let total = 0
      for (const key of CAUSE_KEYS) total += deaths[key] ?? 0
      if (total === 0) return h('span', { className: 'pe-note' }, '—')
      const segments = []
      for (const key of CAUSE_KEYS) {
        const value = deaths[key] ?? 0
        if (value === 0) continue
        segments.push(h('span', {
          key,
          className: 'pe-cause',
          style: { width: percentOf(value / total) + '%', background: CAUSE_COLORS[key] },
          title: t('cause.' + key) + ' ' + value,
        }))
      }
      return h('div', { className: 'pe-causes' }, segments)
    }

    /**
     * Inspector v2: what the animal is, what it is doing right now, why, and
     * what is most likely to kill it.
     * @param {object} props - props.selected, props.t, props.onFollow, props.onClear, props.following.
     * @returns {object} React element.
     */
    function Inspector(props) {
      const selected = props.selected
      const t = props.t
      if (selected === null || selected === undefined) {
        return h('div', { className: 'pe-empty' },
          h('div', { className: 'pe-empty-icon' }, h(PixelGlyph, { name: 'target', size: 22 })),
          h('div', { className: 'pe-empty-title' }, t('inspect.empty')),
          h('div', { className: 'pe-empty-hint' }, t('inspect.emptyHint')))
      }
      const species = SPECIES[selected.species]
      const color = species === undefined ? '#999' : species.color
      const body = selected.body ?? null
      const drives = selected.drives ?? {}
      const state = selected.state ?? null
      const reason = selected.reason ?? null
      const cause = selected.cause ?? { predicted: null, actual: null }
      const ratio = clamp(selected.energy / Math.max(1, selected.maxEnergy), 0, 1)
      // Gene bars: where this animal sits inside its species' range.
      const genes = species === undefined ? [] : GENE_KEYS.map((key) => {
        const range = species.genes[key]
        const value = selected.genes[key]
        const geneRatio = clamp((value - range[0]) / Math.max(1e-6, range[1] - range[0]), 0, 1)
        return h('div', { className: 'pe-gene', key },
          h('span', { className: 'pe-gene-label' }, t('inspect.gene.' + key)),
          h('span', { className: 'pe-gene-track' }, h('span', {
            className: 'pe-gene-fill',
            style: { width: percentOf(geneRatio) + '%', background: color },
          })),
          h('span', { className: 'pe-gene-value' }, value.toFixed(1)))
      })
      const driveBars = DRIVE_KEYS.map((key) => {
        const value = clamp(Number(drives[key]) || 0, 0, 1)
        return h('div', { className: 'pe-drive' + (value >= 0.7 ? ' is-high' : ''), key },
          h('span', { className: 'pe-drive-label' }, t('drive.' + key)),
          h('span', { className: 'pe-drive-track' }, h('span', {
            className: 'pe-drive-fill',
            style: { width: percentOf(value) + '%' },
          })),
          h('span', { className: 'pe-drive-value' }, String(percentOf(value))))
      })
      // The "why": the decision record when behaviour published one, otherwise
      // the loudest drive, and the card says which of the two it is showing.
      const whyText = reason === null
        ? t('inspect.decisionNone')
        : reason.derived === true
          ? t('inspect.decisionWhy', { why: whyLabel(t, reason.drive) })
          : t('inspect.decisionWhy', { why: whyLabel(t, reason.why) })
      const rivals = reason === null || reason.rivals === undefined || reason.rivals.length === 0
        ? null
        : h('span', { className: 'pe-quote-meta' },
            reason.rivals.map(rival => t('inspect.decisionBeat', {
              kind: intentLabel(t, rival.kind),
              score: rival.score.toFixed(2),
            })).join(' · '))
      const predicted = cause.predicted === null || cause.predicted === undefined
        ? h('span', null, t('inspect.causeNone'))
        : h('span', null, t('cause.' + cause.predicted))
      const goalLine = selected.goal === null || selected.goal === undefined
        ? h('span', null, '—')
        : h('span', null, Math.round(selected.goal.x) + ', ' + Math.round(selected.goal.y) + ' · ' +
            t('inspect.goalDistance', { n: Math.round(selected.goal.distance) }))
      const planLine = selected.plan === null || selected.plan === undefined || selected.plan.steps.length === 0
        ? h('span', null, '—')
        : h('span', null, t('inspect.planStep', {
            x: Math.round(selected.plan.steps[0].x),
            y: Math.round(selected.plan.steps[0].y),
            act: intentLabel(t, selected.plan.steps[0].act),
          }))
      return h('div', { className: 'pe-card' },
        h('div', { className: 'pe-card-head' },
          h(PixelGlyph, { name: speciesGlyph(selected.species), color, size: 16 }),
          h('span', { className: 'pe-card-title' }, t('species.' + selected.species)),
          h('span', { className: 'pe-tag' }, t('stage.' + (selected.stage ?? 'adult'))),
          selected.fleeing === true
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('intent.flee'))
            : h('span', { className: 'pe-tag pe-tag-intent' }, intentLabel(t, state === null ? selected.intent : state.id)),
          h('button', {
            type: 'button', className: 'pe-icon-btn', title: t('action.deselect'),
            'aria-label': t('action.deselect'), onClick: props.onClear,
          }, h(PixelGlyph, { name: 'close', size: 12 }))),
        h('div', { className: 'pe-meter' },
          h('span', { className: 'pe-meter-fill', style: { width: percentOf(ratio) + '%' } })),
        // The first two rows are the two numbers every version of this panel has
        // shown; the render test pins that order.
        h('div', { className: 'pe-rows' },
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.age')),
            h('b', null, t('inspect.seconds', { n: Math.round(selected.age) }))),
          h('div', { className: 'pe-row' }, h('span', null, t('inspect.energy')),
            h('b', null, formatEnergy(selected.energy) + ' / ' + formatEnergy(selected.maxEnergy)))),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.structure') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.structure === null || body.structure === undefined
              ? '—'
              : body.structureUnit === 'kg'
                ? t('inspect.kg', { n: body.structure.toFixed(2) })
                : body.structure.toFixed(2)),
          h(KeyValue, { label: t('inspect.maturity') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.maturity === null || body.maturity === undefined ? '—' : percentOf(body.maturity) + '%'),
          h(KeyValue, { label: t('inspect.health') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.health === null || body.health === undefined ? '—' : percentOf(body.health) + '%'),
          h(KeyValue, { label: t('inspect.fatigue') }),
          h('span', { className: 'pe-kv-value' },
            body === null || body.fatigue === null || body.fatigue === undefined ? '—' : percentOf(body.fatigue) + '%')),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.state') }),
          h('span', { className: 'pe-kv-value' },
            intentLabel(t, state === null ? selected.intent : state.id) +
            (state === null || state.phase === null ? '' : ' · ' + phaseLabel(t, state.phase))),
          h(KeyValue, { label: t('inspect.remaining') }),
          h('span', { className: 'pe-kv-value' },
            state === null || state.remaining === null || state.remaining === undefined
              ? '—'
              : t('inspect.seconds', { n: Math.round(state.remaining) })),
          h(KeyValue, { label: t('inspect.nextDecision') }),
          h('span', { className: 'pe-kv-value' },
            state === null || state.nextDecision === null || state.nextDecision === undefined
              ? '—'
              : t('inspect.seconds', { n: Math.round(state.nextDecision) })),
          h(KeyValue, { label: t('inspect.goal') }),
          h('span', { className: 'pe-kv-value' }, goalLine),
          h(KeyValue, { label: t('inspect.plan') }),
          h('span', { className: 'pe-kv-value' }, planLine)),
        h('div', { className: 'pe-quote' },
          h('span', null, t('inspect.decision') + ' · ' + whyText),
          reason === null || reason.at === null || reason.at === undefined
            ? null
            : h('span', { className: 'pe-quote-meta' },
                t('inspect.decisionAgo', { n: Math.max(0, Math.round(selected.decisionAge ?? 0)) })),
          rivals),
        h('div', { className: 'pe-chipline' },
          h('span', { className: 'pe-tag' }, t('inspect.generation', { n: selected.generation })),
          h('span', { className: 'pe-tag' }, t('inspect.children', { n: selected.children })),
          selected.threats > 0
            ? h('span', { className: 'pe-tag pe-tag-alert' }, t('inspect.threats', { n: selected.threats }))
            : null),
        h('div', { className: 'pe-panel-title' }, t('inspect.drives') +
          (selected.drivesDerived === true ? ' · ' + t('inspect.drivesDerived') : '')),
        h('div', { className: 'pe-drives' }, driveBars),
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('inspect.cause') + ' · ' + t('inspect.causePredicted') }),
          h('span', { className: 'pe-kv-value' }, predicted)),
        h('div', { className: 'pe-genes' }, genes),
        h('button', {
          type: 'button',
          className: 'pe-btn pe-btn-block' + (props.following ? ' pe-btn-active' : ''),
          onClick: props.onFollow,
        }, props.following ? t('inspect.unfollow') : t('inspect.follow')))
    }

    /**
     * Species table: counts, reserve, age and the cause breakdown, with a row
     * click that flies to a living member.
     * @param {object} props - props.rows, props.t, props.onLocate.
     * @returns {object} React element.
     */
    function SpeciesPanel(props) {
      const rows = props.rows ?? []
      const t = props.t
      if (rows.length === 0) return h('div', { className: 'pe-blank' }, t('species.empty'))
      const header = h('div', { className: 'pe-srow pe-srow-head' },
        h('span', null, ''),
        h('span', { className: 'pe-srow-name' }, t('budget.species')),
        h('span', { className: 'pe-srow-num' }, t('metric.count')),
        h('span', { className: 'pe-srow-num' }, t('metric.energy')),
        h('span', { className: 'pe-srow-num' }, t('metric.age')))
      const body = rows.map((row) => {
        const species = SPECIES[row.id]
        const color = species === undefined ? '#999' : species.color
        return h('div', {
          key: row.id,
          className: 'pe-srow' + (row.count === 0 ? ' is-gone' : ''),
          onClick: () => props.onLocate(row.id),
          title: row.count === 0 ? t('species.extinct') : t('species.deadTotal', { n: row.dead }),
        },
          h(PixelGlyph, { name: speciesGlyph(row.id), color, size: 12 }),
          h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
          h('span', { className: 'pe-srow-num' }, String(row.count)),
          h('span', { className: 'pe-sbar' }, h('span', {
            className: 'pe-sbar-fill',
            style: { width: percentOf(row.meanRatio) + '%', background: color },
          })),
          h('span', { className: 'pe-srow-num' }, row.count === 0 ? '—' : shortTime(row.meanAge)))
      })
      const deadRows = rows.filter(row => row.dead > 0).map((row) => {
        const species = SPECIES[row.id]
        const color = species === undefined ? '#999' : species.color
        return h('div', { className: 'pe-srow', key: 'dead-' + row.id, title: t('metric.causes') },
          h(PixelGlyph, { name: speciesGlyph(row.id), color, size: 12 }),
          h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
          h('span', { className: 'pe-srow-num' }, String(row.dead)),
          h('span', { style: { gridColumn: '4 / span 2' } }, h(CauseBar, { deaths: row.deaths, t })))
      })
      // Deaths whose cause came from the engine's own carcass record are facts;
      // the rest were inferred here, and the header says how many.
      const inferred = props.inferred ?? 0
      const causesTitle = deadRows.length === 0
        ? null
        : h('div', { className: 'pe-panel-title' },
            t('metric.causes') + (inferred > 0 ? ' · ' + t('inspect.causeInferred') + ' ' + inferred : ''))
      return h('div', { className: 'pe-rows' },
        header,
        body,
        causesTitle,
        deadRows)
    }

    /**
     * Energy flow: the cascade sun to plants to herbivores to carnivores, then
     * the per-species budget that produced it.
     * @param {object} props - props.flows, props.rows, props.t.
     * @returns {object} React element.
     */
    function EnergyFlowPanel(props) {
      const t = props.t
      const flows = props.flows ?? { gpp: 0, herbs: 0, carns: 0, respire: 0, plantRespire: 0, plantStock: 0, animalStock: 0 }
      const rows = props.rows ?? []
      const peak = Math.max(flows.gpp, flows.herbs, flows.carns, flows.respire, flows.plantRespire ?? 0, 1)
      const stage = (key, label, value, color) => h('div', {
        className: 'pe-flow-row',
        key,
        title: key === 'sun' ? t('flow.gpp') : label,
      },
        h('span', { className: 'pe-flow-label' }, label),
        h('span', { className: 'pe-flow-track' }, h('span', {
          className: 'pe-flow-fill',
          style: { width: Math.max(value > 0 ? 2 : 0, percentOf(Math.min(1, value / peak))) + '%', background: color },
        })),
        h('span', { className: 'pe-flow-value' }, formatEnergy(value)))
      const running = flows.gpp > 0 || flows.herbs > 0 || flows.carns > 0
      const cascade = running
        ? h('div', { className: 'pe-flow' },
            stage('sun', t('flow.sun'), flows.gpp, FLOW_COLORS.sun),
            stage('plants', t('flow.plants'), flows.herbs, FLOW_COLORS.plants),
            stage('herbs', t('flow.herbivores'), flows.carns, FLOW_COLORS.herbs),
            stage('carns', t('flow.respire'), flows.respire, FLOW_COLORS.respire),
            stage('plants', t('flow.plantRespire'), flows.plantRespire, FLOW_COLORS.respire))
        : h('div', { className: 'pe-blank' }, t('flow.waiting'))
      const budget = rows.filter(row => row.count > 0).map(row => h('div', { className: 'pe-srow', key: 'budget-' + row.id },
        h(PixelGlyph, { name: speciesGlyph(row.id), color: SPECIES[row.id]?.color, size: 12 }),
        h('span', { className: 'pe-srow-name' }, t('species.' + row.id)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.intake)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.respire)),
        h('span', { className: 'pe-srow-num' }, formatEnergy(row.net ?? (row.intake - row.respire)))))
      return h('div', { className: 'pe-rows' },
        h('div', { className: 'pe-panel-title' }, t('flow.panelTitle')),
        cascade,
        h('div', { className: 'pe-kv' },
          h(KeyValue, { label: t('flow.stock') + ' · ' + t('flow.plants') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.plantStock) + ' ' + t('flow.unit')),
          h(KeyValue, { label: t('flow.stock') + ' · ' + t('flow.animals') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.animalStock) + ' ' + t('flow.unit')),
          h(KeyValue, { label: t('flow.respire') }),
          h('span', { className: 'pe-kv-value' }, formatEnergy(flows.respire) + ' ' + t('flow.unit'))),
        h('div', { className: 'pe-panel-title' }, t('budget.title')),
        h('div', { className: 'pe-srow pe-srow-head' },
          h('span', null, ''),
          h('span', { className: 'pe-srow-name' }, t('budget.species')),
          h('span', { className: 'pe-srow-num' }, t('budget.intake')),
          h('span', { className: 'pe-srow-num' }, t('budget.respire')),
          h('span', { className: 'pe-srow-num' }, t('budget.net'))),
        budget,
        h('div', { className: 'pe-note' }, t('flow.note') + ' ' + t('flow.unit')))
    }

    /**
     * Event ticker: one chip per event, newest first, with the species icon, the
     * count and the coordinates. Clicking one flies the camera there.
     * @param {object} props - props.events, props.t, props.filter, props.onFilter, props.onLocate, props.now.
     * @returns {object} React element.
     */
    function EventBar(props) {
      const t = props.t
      const now = Number.isFinite(props.now) ? props.now : 0
      const filters = EVENT_FILTERS.map(kind => h('button', {
        key: kind,
        type: 'button',
        className: 'pe-eventfilter' + (props.filter === kind ? ' is-active' : ''),
        onClick: () => props.onFilter(kind),
      }, kind === 'all' ? t('event.all') : t('event.' + kind)))
      const all = props.events ?? []
      const shown = props.filter === undefined || props.filter === 'all'
        ? all
        : all.filter(event => event.kind === props.filter)
      const items = shown.slice(0, 16).map((event) => {
        const species = SPECIES[event.species]
        const color = species === undefined ? '#999' : species.color
        const age = Math.max(0, now - event.t)
        return h('button', {
          key: event.seq,
          type: 'button',
          className: 'pe-event pe-event-' + event.kind,
          title: t('event.' + event.kind) + ' · ' + t('species.' + event.species) + ' · ' +
            Math.round(event.x) + ', ' + Math.round(event.y),
          'aria-label': t('events.locate'),
          onClick: () => props.onLocate(event),
        },
          h(PixelGlyph, { name: EVENT_GLYPHS[event.kind] ?? 'target', color, size: 12 }),
          h('span', null, t('species.' + event.species)),
          event.count > 1 ? h('span', { className: 'pe-event-count' }, t('events.count', { n: event.count })) : null,
          event.cause === null || event.cause === undefined
            ? null
            : h('span', { className: 'pe-event-count' }, t('cause.' + event.cause)),
          h('span', { className: 'pe-event-where' }, Math.round(event.x) + ',' + Math.round(event.y)),
          h('span', { className: 'pe-event-time' },
            age < 3 ? t('events.justNow') : t('events.secondsAgo', { n: Math.round(age) })))
      })
      return h('div', { className: 'pe-eventbar' },
        h('span', { className: 'pe-eventbar-title' }, t('events.title')),
        h('div', { className: 'pe-events-filters', title: t('events.filter') }, filters),
        h('div', { className: 'pe-events' },
          items.length > 0 ? items : h('span', { className: 'pe-events-empty' }, t('events.empty'))))
    }

    /**
     * First-run guide: three steps, one button, remembered in the store.
     * @param {object} props - props.t, props.onDismiss.
     * @returns {object} React element.
     */
    function OnboardingOverlay(props) {
      const t = props.t
      return h('div', { className: 'pe-onboard', role: 'dialog', 'aria-label': t('onboard.title') },
        h('div', { className: 'pe-onboard-title' }, t('onboard.title')),
        h('ol', { className: 'pe-onboard-steps' },
          h('li', null, t('onboard.step1')),
          h('li', null, t('onboard.step2')),
          h('li', null, t('onboard.step3'))),
        h('div', { className: 'pe-onboard-actions' },
          h('button', { type: 'button', className: 'pe-btn pe-btn-active', onClick: props.onDismiss },
            t('onboard.dismiss'))))
    }

    /**
     * The world went quiet: say so and offer the restock button instead of
     * leaving the player with an empty meadow and no idea what to do.
     * @param {object} props - props.t, props.onRestock.
     * @returns {object} React element.
     */
    function EmptyWorldOverlay(props) {
      const t = props.t
      return h('div', { className: 'pe-emptyworld' },
        h('div', { className: 'pe-emptyworld-title' }, t('status.emptyWorld')),
        h('div', { className: 'pe-emptyworld-hint' }, t('status.emptyWorldHint')),
        h('button', { type: 'button', className: 'pe-btn', onClick: props.onRestock }, t('status.restock')))
    }

    /**
     * Population chart with filled areas and a legend.
     * @param {object} props - props.history, props.t.
     * @returns {object} React element.
     */
    function PopulationChart(props) {
      const history = props.history
      const t = props.t
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
          h(PixelGlyph, { name: speciesGlyph(id), color: SPECIES[id].color, size: 10 }),
          h('span', null, t('species.' + id))))))
    }

    /**
     * Minimap with the current viewport rectangle; click to jump.
     * @param {object} props - props.store, props.snapshot, props.onJump.
     * @returns {object} React element.
     */
    function Minimap(props) {
      const store = props.store
      const snapshot = props.snapshot
      const onJump = props.onJump
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
     * @param {object} props - slot props plus props.store, props.locale, props.layout.
     * @returns {object} React element.
     */
    function TerrariumPanel(props) {
      const store = props.store
      const locale = props.locale
      const layout = props.layout
      const t = useTranslate(locale)
      const snapshot = useStore(store)
      const worldSize = snapshot.world ?? { width: GRID_W, height: GRID_H }
      const [tool, setTool] = React.useState('pointer')
      const [brushIndex, setBrushIndex] = React.useState(1)
      const [helpOpen, setHelpOpen] = React.useState(false)
      const [confirmNew, setConfirmNew] = React.useState(false)
      const [tab, setTab] = React.useState('tools')
      const [eventFilter, setEventFilter] = React.useState('all')
      const [cameraTick, setCameraTick] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const [hover, setHover] = React.useState(null)
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

      /** Show a short message above the map. */
      const showToast = React.useCallback((message) => {
        if (message === null || message === undefined) return
        setToast(message)
        if (toastTimer.current !== 0) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 1800)
      }, [])

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

      /**
       * Fly to the place an event happened, and open the animal when it is still
       * alive. This is what makes the ticker a way to *watch* the world.
       */
      const locateEvent = React.useCallback((event) => {
        lookAt(event.x, event.y)
        if (event.id > 0) store.select(event.id)
      }, [store, lookAt])

      /** Fly to the first living member of a species (species table row). */
      const locateSpecies = React.useCallback((id) => {
        const world = store.getWorld()
        if (world === null || world === undefined) return
        const entity = world.entities.find(candidate => candidate.species === id)
        if (entity === undefined) return
        lookAt(entity.x, entity.y)
        store.select(entity.id)
      }, [store, lookAt])

      /** Put a starter population back into an empty world. */
      const restockWorld = React.useCallback(() => {
        const released = store.restock()
        showToast(t('toast.placed', { n: released }))
      }, [store, showToast, t])

      /** Close the help sheet and show the first-run guide again. */
      const replayGuide = React.useCallback(() => {
        setHelpOpen(false)
        store.resetOnboarding()
      }, [store])

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

        const report = (released, erased) => {
          const translate = translateRef.current
          let message = null
          if (erased === true) message = translate('toast.erased')
          else if (SPECIES[toolRef.current] !== undefined) {
            message = released > 0 ? translate('toast.placed', { n: released }) : translate('toast.blocked')
          }
          if (message === null) return
          setToast(message)
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
            drag.lastCell = Math.round(point.x) + ',' + Math.round(point.y)
            const erasing = event.button === 2
            report(store.paintAt(point.x, point.y, erasing), erasing)
          }
          if (typeof stage.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
            try { stage.setPointerCapture(event.pointerId) } catch { /* capture is optional */ }
          }
          event.preventDefault()
        }

        const handleMove = (event) => {
          const point = cellAt(event.clientX, event.clientY)
          const cell = Math.round(point.x) + ',' + Math.round(point.y)
          setHover({ x: point.x, y: point.y })
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
          setHover(null)
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
      const climate = snapshot.climate ?? { temperature: 0 }
      const pulse = snapshot.pulse ?? { births: 0, deaths: 0, predations: 0 }
      const bag = { width: worldSize.width, height: worldSize.height }

      const speciesChips = SPECIES_IDS.map((id) => h('span', {
        className: 'pe-chip', key: id, title: t('species.' + id),
      },
        h(PixelGlyph, { name: speciesGlyph(id), color: SPECIES[id].color, size: 11 }),
        h('span', { className: 'pe-chip-count' }, String(snapshot.stats?.counts?.[id] ?? 0))))

      const labelFor = (id) => (SPECIES[id] === undefined ? t('tool.' + id) : t('species.' + id))

      const toolButton = (id) => {
        const isSpecies = SPECIES[id] !== undefined
        const color = isSpecies ? SPECIES[id].color : undefined
        const label = labelFor(id)
        return h('button', {
          type: 'button', key: id,
          className: 'pe-tool' + (tool === id ? ' is-active' : ''),
          onClick: () => setTool(id),
          title: label,
          'aria-pressed': tool === id,
          'aria-label': label,
        },
          h(PixelGlyph, { name: isSpecies ? speciesGlyph(id) : id, color, size: 18 }),
          h('span', { className: 'pe-tool-label' }, label))
      }

      const speedButton = (value) => h('button', {
        type: 'button', key: value,
        className: 'pe-seg-btn' + (snapshot.speed === value && !snapshot.paused ? ' is-active' : ''),
        onClick: () => store.setSpeed(value),
        'aria-label': t('speed.' + value),
      }, t('speed.' + value))

      const tabButton = (id) => h('button', {
        type: 'button', key: id,
        className: 'pe-tab' + (tab === id ? ' is-active' : ''),
        'aria-selected': tab === id,
        onClick: () => setTab(id),
      }, t('tab.' + id))

      const showTab = id => (tab === id ? 'flex' : 'none')

      const brushRadius = BRUSH_RADIUS[brushIndex]
      const brushPreview = hover === null || tool === 'pointer'
        ? null
        : h('span', {
            className: 'pe-brushpreview',
            style: {
              left: ((hover.x - view.x) * view.scale + view.offsetX) + 'px',
              top: ((hover.y - view.y) * view.scale + view.offsetY) + 'px',
              width: Math.max(4, (brushRadius * 2 + 1) * view.scale) + 'px',
              height: Math.max(4, (brushRadius * 2 + 1) * view.scale) + 'px',
            },
          })

      return h('div', { className: 'pe-root' },
        h('header', { className: 'pe-head' },
          h('div', { className: 'pe-brand' },
            h('span', { className: 'pe-logo' }, h(PixelGlyph, { name: 'tree', color: '#4a9d54', size: 18 })),
            h('div', null,
              h('div', { className: 'pe-title' }, t('panel.title')),
              h('div', { className: 'pe-sub' },
                t('stat.day', { day: snapshot.stats?.day ?? 1 }) + ' · ' + (snapshot.stats?.clock ?? '06:00') +
                ' · ' + t('status.temperature', { n: Math.round(climate.temperature ?? 0) })))),
          h('div', { className: 'pe-statusbar' },
            h('span', { className: 'pe-pill' + (snapshot.paused ? '' : ' pe-pill-live') },
              snapshot.paused ? t('speed.paused') : t('status.pulse', { births: pulse.births, deaths: pulse.deaths })),
            h('span', { className: 'pe-pill' }, t('stat.corpses') + ' ' + (snapshot.stats?.corpses ?? 0))),
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
              className: 'pe-btn' + (confirmNew ? ' pe-btn-danger' : ''),
              onClick: () => {
                if (!confirmNew) { setConfirmNew(true); return }
                setConfirmNew(false)
                store.newWorld()
                fitAll()
              },
            }, confirmNew ? t('action.newWorldConfirm') : t('action.newWorld')),
            h('button', { type: 'button', className: 'pe-btn', onClick: fitAll }, t('action.fit')),
            h('button', {
              type: 'button', className: 'pe-btn' + (helpOpen ? ' pe-btn-active' : ''),
              onClick: () => setHelpOpen(open => !open),
            }, t('action.help')),
            layout !== undefined && typeof layout.selectPanel === 'function'
              ? h('button', { type: 'button', className: 'pe-btn pe-btn-ghost', onClick: () => layout.selectPanel('conversation') }, t('action.back'))
              : null)),
        h('div', { className: 'pe-body' },
          h('div', { className: 'pe-stagewrap' },
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
                  width: (view.width * view.scale) + 'px',
                  height: (view.height * view.scale) + 'px',
                },
              }),
              brushPreview,
              h('div', { className: 'pe-hud pe-hud-bl' },
                h('span', { className: 'pe-hud-item' },
                  hover === null ? '—' : t('brush.cell', { x: Math.round(hover.x), y: Math.round(hover.y) })),
                h('span', { className: 'pe-hud-item' }, t('brush.preview', { tool: labelFor(tool) })),
                h('span', { className: 'pe-hud-item' }, view.scale + '×')),
              h('div', { className: 'pe-hud pe-hud-br' },
                h(Minimap, { store, snapshot, onJump: lookAt })),
              snapshot.ready === false
                ? h('div', { className: 'pe-blank' }, t('status.ready'))
                : null,
              snapshot.world !== undefined && snapshot.world.empty === true
                ? h(EmptyWorldOverlay, { t, onRestock: restockWorld })
                : null,
              snapshot.onboarding === true
                ? null
                : h(OnboardingOverlay, { t, onDismiss: () => store.markOnboardingSeen() }),
              snapshot.notice === null || snapshot.notice === undefined
                ? null
                : h('div', { className: 'pe-notice' },
                    h('div', { className: 'pe-notice-title' },
                      snapshot.notice.kind === 'legacy' ? t('notice.legacyTitle') : t('notice.loadTitle')),
                    h('div', { className: 'pe-notice-body' },
                      snapshot.notice.kind === 'legacy'
                        ? t('notice.legacyBody')
                        : t('notice.loadBody', { reason: snapshot.notice.detail ?? '' })),
                    h('div', { className: 'pe-notice-actions' },
                      h('button', { type: 'button', className: 'pe-btn', onClick: () => store.dismissNotice() },
                        t('notice.dismiss')))),
              toast === null ? null : h('div', { className: 'pe-toast' }, toast)),
            h(EventBar, {
              events: snapshot.events ?? [],
              t,
              filter: eventFilter,
              onFilter: setEventFilter,
              onLocate: locateEvent,
              now: snapshot.time ?? 0,
            })),
          h('aside', { className: 'pe-side' },
            h('div', { className: 'pe-tabs' }, SIDE_TABS.map(tabButton)),
            h('div', { className: 'pe-tabbody' },
              h('section', { className: 'pe-panel', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('tool.group.life')),
                h('div', { className: 'pe-tools' }, LIFE_TOOLS.map(toolButton))),
              h('section', { className: 'pe-panel', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('tool.group.terrain')),
                h('div', { className: 'pe-tools' }, TERRAIN_TOOL_IDS.map(toolButton))),
              h('section', { className: 'pe-panel pe-panel-row', style: { display: showTab('tools') } },
                h('div', { className: 'pe-panel-title' }, t('brush.label')),
                h('div', { className: 'pe-seg' }, BRUSHES.map((radius, index) => h('button', {
                  type: 'button', key: radius,
                  className: 'pe-seg-btn' + (brushIndex === index ? ' is-active' : ''),
                  onClick: () => setBrushIndex(index),
                  'aria-label': t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'),
                }, t(index === 0 ? 'brush.small' : index === 1 ? 'brush.medium' : 'brush.large'))))),
              h('section', { className: 'pe-panel', style: { display: showTab('species') } },
                h('div', { className: 'pe-panel-title' }, t('species.panelTitle')),
                h(SpeciesPanel, {
                  rows: snapshot.species ?? [],
                  t,
                  onLocate: locateSpecies,
                  inferred: snapshot.causeSource === undefined ? 0 : snapshot.causeSource.inferred,
                })),
              h('div', { style: { display: showTab('species') } },
                h(PopulationChart, { history: snapshot.history ?? [], t })),
              h('section', { className: 'pe-panel', style: { display: showTab('energy') } },
                h(EnergyFlowPanel, { flows: snapshot.flows, rows: snapshot.species ?? [], t }))),
            h('div', { className: 'pe-dock' },
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
                [1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => h('li', { key: index }, t('help.' + index)))),
              h('div', { className: 'pe-onboard-actions' },
                h('button', { type: 'button', className: 'pe-btn', onClick: replayGuide }, t('onboard.again')))))
          : null)
    }
