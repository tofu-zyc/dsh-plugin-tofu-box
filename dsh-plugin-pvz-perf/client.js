/**
 * Browser half of the pvz_perf shelf plugin.
 *
 * What it draws, and why it lives in these four seats:
 *
 * - `sidebar.panellist` gets the potted-sprout icon; the shell owns that button
 *   and dispatches the panel switch, and the key it switches to equals the entry
 *   id (`pvz-perf`), which is also the key registered in `main`.
 * - `main` (keyed by `pvz-perf`) is the hub panel: game state, version,
 *   directory, one primary action and the install help. It never owns the game
 *   itself, so switching back to the conversation costs nothing.
 * - `shell.overlay` owns the actual game `<iframe>`. That layer is root-scoped
 *   and stays mounted while the user works elsewhere, which is the whole point:
 *   "隐藏" only flips `display: none`, so the round keeps running and reopens
 *   exactly where it was. `结束` is the only action that unmounts it.
 * - `sidebar.footer.action` is the one-click toggle beside Settings, so a round
 *   can be opened or hidden without opening the hub first.
 *
 * The Host half serves the local web build from `/pvz-perf/game/`; this module
 * never touches game assets and only knows that URL plus `/pvz-perf/status`.
 *
 * Everything shared with the Host is literals: this file cannot import Host
 * code, so the two copies of the route prefix are asserted in tests.
 *
 * @module dsh-plugin-pvz-perf/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-pvz-perf',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** Locale namespace; equals the package name. */
    const NS = 'dsh-plugin-pvz-perf'
    /** Sidebar entry id and `main` panel key. The two must be the same string. */
    const PANEL_ID = 'pvz-perf'
    /** Host-owned route prefix. Keep in sync with index.js `ROUTE`. */
    const ROUTE = '/pvz-perf'
    /** The game page URL the iframe loads. */
    const GAME_URL = ROUTE + '/game/'
    /** The Host status endpoint. */
    const STATUS_URL = ROUTE + '/status'
    /** `sidebar.footer.action` seat id. */
    const SEAT_FOOTER = 'pvz-perf.launch'

    /** Shown where the game build is expected, in the hub help section. */
    const DEFAULT_DIR_HINT = 'E:\\Games\\pvz_perf_web'
    /** Environment variable the Host side reads first. */
    const ENV_OVERRIDE = 'DSH_PVZ_GAME_DIR'

    // ---------------------------------------------------------------------
    // Locale dictionaries
    // ---------------------------------------------------------------------
    //
    // UI strings live in the bundle rather than in locale/*.json: the exported
    // JSON files only carry the Plugin Manager `meta` block, because they are
    // read without activating either half. Every key a component asks for must
    // exist in both dictionaries, which tests/client.test.mjs enforces.

    /** Chinese UI copy. */
    const ZH = {
      'panel.title': '植物大战僵尸',
      'panel.subtitle': 'pvz_perf · 摸鱼面板',
      'hub.state.idle': '等待检查',
      'hub.state.loading': '检查中',
      'hub.state.ready': '就绪',
      'hub.state.missing': '未找到游戏',
      'hub.state.error': '检查失败',
      'hub.start': '开始游戏',
      'hub.resume': '继续游戏',
      'hub.refresh': '重新检查',
      'hub.external': '独立窗口打开',
      'hub.back': '返回对话',
      'hub.dir': '游戏目录',
      'hub.version': '版本',
      'hub.help.title': '怎么让这里亮起来',
      'hub.help.dir': '把 pvz_perf 的 web 构建整包解压到本机目录（当前默认认 {dir}，插件会把整包目录原样转播给页面，不复制、不改动）。',
      'hub.help.env': '放在别处时，在启动 DSH 的环境里设置 {env}=<目录>（指向含 index.html 与 web-build-manifest.json 的那一层）。',
      'hub.help.version': '需要 pvz_perf 网页版 v3.3.x（含 web-build-manifest.json；WebGPU 或 WebGL2 都能跑）。',
      'hub.help.saves': '存档在浏览器本地（同一个 GUI origin 的 IndexedDB），换浏览器/换端口不共享；游戏里正常退出才会把当前关卡写回去。',
      'hub.missing.hint': '没有在默认位置找到网页版游戏文件。',
      'game.title': '植物大战僵尸 · 摸鱼中',
      'game.fullscreen': '全屏',
      'game.exitFullscreen': '退出全屏',
      'game.fullscreenHint': '铺满屏幕；按 Esc 或点右上角「退出全屏」回来',
      'game.reload': '重新载入',
      'game.end': '结束',
      'game.endHint': '结束并卸载游戏页面；只有游戏内正常退出才会保存当前关卡。',
      'game.back': '返回对话',
      'game.backHint': '回到对话会卸载游戏页面；只有游戏内正常退出才会保存当前关卡。',
      'game.frameTitle': '植物大战僵尸（pvz_perf 网页版）',
      'game.unloadNote': '游戏只在当前面板里运行；离开这个面板会卸载游戏页面（游戏内正常退出才存档）。',
      'footer.toggle': '打开植物大战僵尸',
      'footer.resume': '回到植物大战僵尸',
      'error.boundary': '面板渲染出错',
      'common.na': '—',
    }

    /** English UI copy. */
    const EN = {
      'panel.title': 'Plants vs. Zombies',
      'panel.subtitle': 'pvz_perf shelf',
      'hub.state.idle': 'Not checked',
      'hub.state.loading': 'Checking',
      'hub.state.ready': 'Ready',
      'hub.state.missing': 'Game not found',
      'hub.state.error': 'Check failed',
      'hub.start': 'Start game',
      'hub.resume': 'Resume game',
      'hub.refresh': 'Check again',
      'hub.external': 'Open in a tab',
      'hub.back': 'Back to chat',
      'hub.dir': 'Game directory',
      'hub.version': 'Version',
      'hub.help.title': 'How to light this up',
      'hub.help.dir': 'Extract the pvz_perf web build somewhere on this machine (default location: {dir}). The plugin relays that directory to the page as-is; it never copies or edits it.',
      'hub.help.env': 'Somewhere else? Start DSH with {env}=<directory> pointing at the folder holding index.html and web-build-manifest.json.',
      'hub.help.version': 'Requires the pvz_perf web build v3.3.x (it ships web-build-manifest.json; WebGPU and WebGL2 both work).',
      'hub.help.saves': 'Saves live in this browser (IndexedDB on the GUI origin), so another browser or port does not share them, and a level is written back only on a normal in-game quit.',
      'hub.missing.hint': 'No web build was found at the default locations.',
      'game.title': 'Plants vs. Zombies · break',
      'game.fullscreen': 'Fullscreen',
      'game.exitFullscreen': 'Exit fullscreen',
      'game.fullscreenHint': 'Fills the screen; press Esc or click Exit fullscreen in the corner to come back',
      'game.reload': 'Reload',
      'game.end': 'End',
      'game.endHint': 'End unloads the game page; in-game progress is only saved on a normal in-game quit.',
      'game.back': 'Back to chat',
      'game.backHint': 'Going back unloads the game page; in-game progress is only saved on a normal in-game quit.',
      'game.frameTitle': 'Plants vs. Zombies (pvz_perf web build)',
      'game.unloadNote': 'The game runs inside this panel only; leaving the panel unloads the game page (progress is saved only on a normal in-game quit).',
      'footer.toggle': 'Open Plants vs. Zombies',
      'footer.resume': 'Back to Plants vs. Zombies',
      'error.boundary': 'Panel failed to render',
      'common.na': '—',
    }

    /**
     * Register both dictionaries on the client locale service.
     * @param {object} locale - the client locale service.
     * @returns {(() => void)[]} one disposer per registration.
     */
    function registerDictionaries(locale) {
      if (locale === undefined || locale === null || typeof locale.register !== 'function') return []
      return [locale.register(NS, 'zh', ZH), locale.register(NS, 'en', EN)]
    }

    // ---------------------------------------------------------------------
    // Store
    // ---------------------------------------------------------------------

    /**
     * Fetch the Host status payload.
     * @returns {Promise<object>} parsed `/pvz-perf/status` JSON.
     */
    async function defaultFetchStatus() {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this page')
      const response = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'same-origin' })
      if (response.ok !== true) throw new Error('status HTTP ' + response.status)
      return await response.json()
    }

    /**
     * The single observable source of truth for both halves' UI.
     *
     * The snapshot object is replaced (never mutated) on every change, which is
     * what makes `useSyncExternalStore` render only on real transitions.
     * `opened` owns the iframe's lifetime: the game page lives inside the
     * plugin's central panel, and closing returns the panel to its hub.
     * @param {{ fetchStatus?: () => Promise<object> }} [options] - test seam.
     * @returns {object} store with subscribe/getSnapshot and actions.
     */
    function createGameStore(options = {}) {
      const fetchStatus = typeof options.fetchStatus === 'function' ? options.fetchStatus : defaultFetchStatus
      /** @type {object} current frozen snapshot. */
      let snapshot = Object.freeze({
        phase: 'idle',
        info: null,
        error: null,
        opened: false,
        reloadKey: 0,
      })
      /** @type {Set<() => void>} React subscribers. */
      const listeners = new Set()
      /** Set once the owning effect disposes; late fetches then do nothing. */
      let disposed = false
      /** The in-flight status promise, so 重新检查 cannot stack requests. */
      let pending = null

      /** @param {object} patch - fields to merge into the next snapshot. */
      const commit = (patch) => {
        if (disposed) return
        snapshot = Object.freeze({ ...snapshot, ...patch })
        for (const listener of [...listeners]) listener()
      }

      /** @returns {object} the current snapshot. */
      const getSnapshot = () => snapshot

      /** @param {() => void} listener - React subscription callback. */
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      /** Read the Host status once and fold the result into the snapshot. */
      const refresh = () => {
        if (pending !== null) return pending
        commit({ phase: 'loading', error: null })
        pending = (async () => {
          try {
            const payload = await fetchStatus()
            const ok = payload !== null && typeof payload === 'object' && payload.ok === true
            if (ok) {
              commit({
                phase: 'ready',
                info: {
                  dir: typeof payload.dir === 'string' ? payload.dir : '',
                  version: typeof payload.version === 'string' ? payload.version : '',
                  sourceCommit: typeof payload.sourceCommit === 'string' ? payload.sourceCommit : '',
                  gameUrl: typeof payload.gameUrl === 'string' ? payload.gameUrl : GAME_URL,
                },
                error: null,
              })
            } else {
              commit({
                phase: 'missing',
                info: null,
                error: payload !== null && typeof payload === 'object' && typeof payload.hint === 'string' ? payload.hint : null,
              })
            }
          } catch (error) {
            commit({ phase: 'error', info: null, error: error instanceof Error ? error.message : String(error) })
          } finally {
            pending = null
          }
        })()
        return pending
      }

      /** Load the status at most once, unless the last attempt failed. */
      const ensureStatus = () => {
        if (snapshot.phase === 'idle' || snapshot.phase === 'error') return refresh()
        return undefined
      }

      /** Open the game in the central panel and check the Host status. */
      const open = () => {
        commit({ opened: true })
        return ensureStatus()
      }

      /** Remount the iframe (a page reload inside the game panel, essentially). */
      const reload = () => { commit({ reloadKey: snapshot.reloadKey + 1, opened: true }) }

      /** Close the game and go back to the hub inside the same panel. */
      const close = () => { commit({ opened: false }) }

      /** Stop accepting updates; called from the owning effect's disposer. */
      const dispose = () => {
        disposed = true
        listeners.clear()
      }

      return { getSnapshot, subscribe, refresh, ensureStatus, open, reload, close, dispose }
    }

    /**
     * Subscribe a component to the store.
     * @param {object} store - the game store.
     * @returns {object} the current snapshot.
     */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /**
     * Fill `{placeholders}` in one locale string.
     * @param {string} text - template text.
     * @param {Record<string, string>} values - replacements.
     * @returns {string} filled text.
     */
    function fill(text, values) {
      return String(text).replace(/\{([a-z]+)\}/gi, (match, name) => (values[name] === undefined ? match : values[name]))
    }

    // ---------------------------------------------------------------------
    // Shared art
    // ---------------------------------------------------------------------

    /**
     * The potted-sprout glyph, one character per cell.
     * `G` leaf, `P` pot, `.` transparent.
     */
    const GLYPH = [
      '....G....',
      '...GGG...',
      '..GGGGG..',
      '...GGG...',
      '....G....',
      '...GGG...',
      '..PPPPP..',
      '..PPPPP..',
      '...PPP...',
    ]
    /** Glyph palette. Artwork keeps its own colours; chrome uses theme tokens. */
    const GLYPH_COLORS = { G: '#5cb968', P: '#b06a3b' }

    /**
     * The plugin mark: a potted sprout in the sidebar, the hub header and the
     * overlay bar.
     * @param {{ size?: number, active?: boolean }} props - shell-provided sizing/state.
     * @returns {object} React element.
     */
    function SproutMark(props) {
      const size = Math.max(12, Math.min(32, Number(props?.size) > 0 ? Number(props.size) : 16))
      const rects = []
      for (let y = 0; y < GLYPH.length; y += 1) {
        for (let x = 0; x < GLYPH[y].length; x += 1) {
          const cell = GLYPH[y][x]
          if (cell === '.') continue
          rects.push(h('rect', { key: x + '-' + y, x, y, width: 1, height: 1, fill: GLYPH_COLORS[cell] ?? GLYPH_COLORS.G }))
        }
      }
      if (props?.active === true) {
        rects.push(h('rect', {
          key: 'outline', x: 0.25, y: 0.25, width: 8.5, height: 8.5,
          fill: 'none', stroke: 'currentColor', strokeOpacity: 0.5, strokeWidth: 0.5,
        }))
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 9 9',
        shapeRendering: 'crispEdges', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      }, rects)
    }

    /**
     * A small state dot whose colour comes from the theme.
     * @param {{ phase?: string }} props - current store phase.
     * @returns {object} React element.
     */
    function StateDot(props) {
      const phase = typeof props?.phase === 'string' ? props.phase : 'idle'
      return h('span', { className: 'pvz-dot pvz-dot-' + phase, 'aria-hidden': true })
    }

    /**
     * Error boundary around the hub and the overlay, so one bad render shows a
     * message instead of blanking a whole seat.
     */
    class Boundary extends (React.Component ?? Object) {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[pvz-perf] seat crashed', error, info)
        }
      }

      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          const stack = this.state.error.stack === undefined ? String(this.state.error) : this.state.error.stack
          const title = typeof this.props.title === 'string' ? this.props.title : 'Panel failed to render'
          return h('div', { className: 'pvz-boundary' },
            h('div', { className: 'pvz-boundary-title' }, title),
            h('pre', { className: 'pvz-boundary-body' }, String(stack)))
        }
        return this.props.children ?? null
      }
    }

    /** Only wrap in a real React; the test shim has no class components. */
    const BOUNDARY = typeof React.Component === 'function' ? Boundary : (props) => props.children ?? null

    // ---------------------------------------------------------------------
    // Hub panel
    // ---------------------------------------------------------------------

    /**
     * One labelled row in the hub's status grid.
     * @param {{ label: string, value: string, mono?: boolean }} props - row content.
     * @returns {object} React element.
     */
    function InfoRow(props) {
      return h('div', { className: 'pvz-row' },
        h('span', { className: 'pvz-row-label' }, props.label),
        h('span', { className: props.mono === true ? 'pvz-row-value pvz-mono' : 'pvz-row-value', title: props.value }, props.value))
    }

    /**
     * The hub: status, version, directory, primary action, and the install help.
     * @param {object} props - slot props plus `{ store, locale, layout }`.
     * @returns {object} React element.
     */
    function HubPanel(props) {
      const store = props.store
      const layout = props.layout
      const t = props.locale.bind(NS)
      const snapshot = useStore(store)
      const phase = snapshot.phase
      const info = snapshot.info
      const busy = phase === 'loading'
      const blocked = phase === 'missing' || phase === 'error'
      const label = snapshot.opened ? t('hub.resume') : t('hub.start')

      React.useEffect(() => { store.ensureStatus() }, [])

      const start = () => {
        if (blocked || busy) return
        store.open()
      }
      const openTab = () => {
        if (blocked) return
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(info?.gameUrl || GAME_URL, '_blank', 'noopener,noreferrer')
        }
      }
      const back = () => {
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel('conversation')
      }

      const version = info?.version !== undefined && info.version !== '' ? info.version : t('common.na')
      const dir = info?.dir !== undefined && info.dir !== '' ? info.dir : t('common.na')

      return h('div', { className: 'pvz-hub' },
        h('div', { className: 'pvz-hub-inner' },
          h('section', { className: 'pvz-card pvz-card-hero' },
            h('div', { className: 'pvz-hero-head' },
              h('span', { className: 'pvz-mark' }, h(SproutMark, { size: 28 })),
              h('div', { className: 'pvz-hero-titles' },
                h('div', { className: 'pvz-title' }, t('panel.title')),
                h('div', { className: 'pvz-subtitle' }, t('panel.subtitle')))),
            h('div', { className: 'pvz-chipline' },
              h('span', { className: 'pvz-chip' },
                h(StateDot, { phase }),
                h('span', null, t('hub.state.' + phase))),
              phase === 'ready' ? h('span', { className: 'pvz-chip pvz-chip-mono' }, t('hub.version') + ' ' + version) : null),
            h('div', { className: 'pvz-rows' },
              h(InfoRow, { label: t('hub.dir'), value: dir, mono: true }),
              h(InfoRow, { label: t('hub.version'), value: version, mono: true })),
            blocked || phase === 'error'
              ? h('p', { className: 'pvz-warn' }, snapshot.error ?? t('hub.missing.hint'))
              : null,
            h('div', { className: 'pvz-actions' },
              h('button', {
                type: 'button',
                className: 'pvz-btn pvz-btn-primary',
                disabled: blocked || busy,
                onClick: start,
              }, busy ? t('hub.state.loading') : label),
              h('button', { type: 'button', className: 'pvz-btn', onClick: () => store.refresh() }, t('hub.refresh')),
              h('button', { type: 'button', className: 'pvz-btn', disabled: blocked, onClick: openTab }, t('hub.external')),
              h('button', { type: 'button', className: 'pvz-btn pvz-btn-ghost', onClick: back }, t('hub.back')))),
          h('section', { className: 'pvz-card' },
            h('div', { className: 'pvz-card-title' }, t('hub.help.title')),
            h('ul', { className: 'pvz-help' },
              h('li', null, fill(t('hub.help.dir'), { dir: DEFAULT_DIR_HINT })),
              h('li', null, fill(t('hub.help.env'), { env: ENV_OVERRIDE })),
              h('li', null, t('hub.help.version')),
              h('li', null, t('hub.help.saves'))))))
    }

    // ---------------------------------------------------------------------
    // In-panel game view
    // ---------------------------------------------------------------------

    /**
     * One bar button.
     * @param {{ text: string, onClick?: () => void, title?: string, primary?: boolean, danger?: boolean }} props - button options.
     * @returns {object} React element.
     */
    function BarButton(props) {
      const classes = ['pvz-btn', 'pvz-btn-sm']
      if (props.primary === true) classes.push('pvz-btn-primary')
      if (props.danger === true) classes.push('pvz-btn-danger')
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        title: props.title ?? props.text,
        'aria-label': props.title ?? props.text,
        onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
      }, props.text)
    }

    /**
     * The game itself, rendered INSIDE the plugin's central panel.
     *
     * Layout is the whole point: the panel is the content column the shell
     * already allocated to this plugin, so the sidebar, the app titlebar and the
     * rest of the window stay visible and clickable. The first version rendered
     * into `shell.overlay` instead, which covered the sidebar and put its
     * right-most controls underneath the desktop window buttons — that is what
     * made the first real-machine round impossible to leave.
     * @param {object} props - panel props plus `{ store, locale, layout }`.
     * @returns {object|null} React element, or null before the first open.
     */
    function GameEmbed(props) {
      const store = props.store
      const layout = props.layout
      const t = props.locale.bind(NS)
      const snapshot = useStore(store)
      const panelRef = React.useRef(null)
      const [isFullscreen, setIsFullscreen] = React.useState(false)

      /** Leave the panel (the game page unmounts with it). */
      const back = () => {
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel('conversation')
      }

      /** Ask the browser to leave element fullscreen, if it is active. */
      const exitFullscreen = () => {
        if (typeof document === 'undefined' || typeof document.exitFullscreen !== 'function') return
        const result = document.exitFullscreen()
        if (result !== undefined && typeof result.catch === 'function') result.catch(() => { /* already gone */ })
      }

      /** Enter fullscreen on the panel, or leave it when already there. */
      const toggleFullscreen = () => {
        const panel = panelRef.current
        if (panel === null || panel === undefined) return
        if (typeof document !== 'undefined' && document.fullscreenElement === panel) {
          exitFullscreen()
          return
        }
        if (typeof panel.requestFullscreen === 'function') {
          const result = panel.requestFullscreen()
          if (result !== undefined && typeof result.catch === 'function') result.catch(() => { /* user or policy refused */ })
        }
      }

      // The button label, the hidden in-fullscreen bar and the floating exit
      // affordance all follow the browser's own fullscreen state.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        /** @param {Event} event - the fullscreenchange event. */
        const onChange = () => {
          const panel = panelRef.current
          setIsFullscreen(panel !== null && panel !== undefined && document.fullscreenElement === panel)
        }
        document.addEventListener('fullscreenchange', onChange)
        return () => { document.removeEventListener('fullscreenchange', onChange) }
      }, [])

      // Escape leaves fullscreen first, otherwise it returns to the chat.
      // Key events inside the game iframe never reach this document, so the
      // game's own Esc menu still works while playing.
      React.useEffect(() => {
        if (typeof document === 'undefined' || snapshot.opened !== true) return undefined
        /** @param {KeyboardEvent} event - the key press. */
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented === true) return
          if (document.fullscreenElement !== null) {
            exitFullscreen()
            return
          }
          back()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [snapshot.opened])

      if (snapshot.opened !== true) return null

      const phase = snapshot.phase
      return h('div', {
        className: 'pvz-game',
        ref: panelRef,
        'data-fullscreen': isFullscreen === true ? 'true' : 'false',
      },
      h('div', { className: 'pvz-game-bar' },
        h('div', { className: 'pvz-game-brand' },
          h(SproutMark, { size: 16 }),
          h('span', { className: 'pvz-game-title' }, t('game.title')),
          h(StateDot, { phase }),
          h('span', { className: 'pvz-game-state' }, t('hub.state.' + phase))),
        h('div', { className: 'pvz-game-actions' },
          h(BarButton, { text: t('game.back'), onClick: back, title: t('game.backHint') }),
          h(BarButton, {
            text: isFullscreen === true ? t('game.exitFullscreen') : t('game.fullscreen'),
            onClick: toggleFullscreen,
            title: t('game.fullscreenHint'),
          }),
          h(BarButton, { text: t('game.reload'), onClick: () => store.reload() }),
          h(BarButton, { text: t('game.end'), onClick: () => store.close(), title: t('game.endHint'), danger: true }))),
      h('div', { className: 'pvz-game-frame' },
        h('iframe', {
          key: 'pvz-frame-' + snapshot.reloadKey,
          className: 'pvz-frame',
          src: GAME_URL,
          title: t('game.frameTitle'),
          allow: 'fullscreen; autoplay; gamepad; clipboard-write',
          allowFullScreen: true,
          referrerPolicy: 'no-referrer',
        })),
      isFullscreen === true
        ? h('button', {
            type: 'button',
            className: 'pvz-game-exit',
            onClick: exitFullscreen,
            title: t('game.fullscreenHint'),
          }, t('game.exitFullscreen'))
        : null)
    }

    /**
     * The plugin's central panel: the hub until the game is opened, the game
     * itself afterwards. Both use the column the shell already gave this panel,
     * so the sidebar is never covered.
     * @param {object} props - slot props plus `{ store, locale, layout }`.
     * @returns {object} React element.
     */
    function PvzPanel(props) {
      const snapshot = useStore(props.store)
      return snapshot.opened === true
        ? h(GameEmbed, props)
        : h(HubPanel, props)
    }

    // ---------------------------------------------------------------------
    // Sidebar footer shortcut
    // ---------------------------------------------------------------------

    /**
     * The shortcut beside Settings: selects the plugin panel and, when the game
     * is not running yet, starts it in one click. It never covers the app — the
     * game is the shell's own central column.
     * @param {object} props - owner props (`wide`) plus `{ store, locale, layout }`.
     * @returns {object} React element.
     */
    function FooterLaunch(props) {
      const store = props.store
      const layout = props.layout
      const t = props.locale.bind(NS)
      const snapshot = useStore(store)
      const wide = props.wide === true
      const opened = snapshot.opened === true
      const label = opened ? t('footer.resume') : t('footer.toggle')
      const activate = () => {
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        if (opened !== true) store.open()
      }
      return h('button', {
        type: 'button',
        className: wide ? 'pvz-footer pvz-footer-wide' : 'pvz-footer',
        title: label,
        'aria-label': label,
        'aria-pressed': opened ? 'true' : 'false',
        onClick: activate,
      },
      h('span', { className: 'pvz-footer-icon' }, h(SproutMark, { size: 16, active: opened })),
      wide ? h('span', { className: 'pvz-footer-label' }, label) : null)
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /** Every class is `pvz-` prefixed; chrome colours come from theme tokens. */
    const CSS = `
.pvz-hub{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;box-sizing:border-box}
.pvz-hub-inner{max-width:760px;margin:0 auto;padding:20px 20px 28px;display:flex;flex-direction:column;gap:12px}
.pvz-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}
.pvz-card-hero{gap:14px}
.pvz-hero-head{display:flex;align-items:center;gap:12px;min-width:0}
.pvz-mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;flex:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.pvz-hero-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.pvz-title{font-size:16px;font-weight:700;line-height:22px;letter-spacing:.01em}
.pvz-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.pvz-chipline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pvz-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:17px}
.pvz-chip-mono{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pvz-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-label-secondary);opacity:.7}
.pvz-dot-ready{background:var(--dsw-alias-state-success-primary);opacity:1}
.pvz-dot-loading{background:var(--dsw-alias-brand-primary);opacity:1}
.pvz-dot-missing{background:var(--dsw-alias-state-warn-primary);opacity:1}
.pvz-dot-error{background:var(--dsw-alias-state-error-primary);opacity:1}
.pvz-rows{display:flex;flex-direction:column;gap:5px}
.pvz-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;align-items:baseline}
.pvz-row-label{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.pvz-row-value{color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pvz-mono{font-family:ui-monospace,Consolas,Menlo,monospace}
.pvz-warn{margin:0;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:17px;word-break:break-word}
.pvz-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pvz-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.pvz-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.pvz-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pvz-btn:disabled{opacity:.45;cursor:not-allowed}
.pvz-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pvz-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}
.pvz-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pvz-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pvz-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent}
.pvz-btn-danger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.pvz-btn-sm{height:24px;padding:0 10px;border-radius:7px;font-size:11.5px;font-weight:600}
.pvz-card-title{font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.pvz-help{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;word-break:break-word}
.pvz-boundary{padding:16px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}
.pvz-boundary-title{font-weight:700;color:var(--dsw-alias-state-error-primary);font-size:12px}
.pvz-boundary-body{margin:0;white-space:pre-wrap;font-family:ui-monospace,Consolas,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
/* The game view fills the shell's central column only. No fixed-position layer,
   no z-index war: the sidebar, the titlebar and the window buttons stay usable
   while a round runs. */
.pvz-game{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-sizing:border-box}
.pvz-game[data-fullscreen="true"]{background:#000}
.pvz-game[data-fullscreen="true"] .pvz-game-bar{display:none}
.pvz-game-exit{position:absolute;top:12px;right:12px;z-index:6;appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.42);background:rgba(10,12,16,.62);color:#fff;font:inherit;font-size:11.5px;font-weight:650;cursor:pointer;opacity:.72;transition:opacity .12s ease,background .12s ease}
.pvz-game-exit:hover{opacity:1;background:rgba(10,12,16,.82)}
.pvz-game-exit:focus-visible{outline:2px solid #fff;outline-offset:2px;opacity:1}
.pvz-game-bar{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;min-height:34px;padding:4px 10px 4px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.pvz-game-brand{display:flex;align-items:center;gap:8px;min-width:0;flex:0 1 auto;overflow:hidden}
.pvz-game-title{font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pvz-game-state{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.pvz-game-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;min-width:0}
.pvz-game-frame{position:relative;flex:1;min-height:0;background:#000}
.pvz-game-unload{margin:0;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:15px}
.pvz-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:#000}
.pvz-footer{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:32px;padding:0 10px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;max-width:100%}
.pvz-footer:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pvz-footer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pvz-footer[aria-pressed="true"]{color:var(--dsw-alias-label-primary)}
.pvz-footer-wide{width:100%;justify-content:flex-start;padding:0 8px}
.pvz-footer-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none}
.pvz-footer-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width: 720px){.pvz-hub-inner{padding:14px 12px 20px}.pvz-row{grid-template-columns:74px minmax(0,1fr)}}
`

    // ---------------------------------------------------------------------
    // Plugin registration
    // ---------------------------------------------------------------------

    /** `sidebar.panellist` icon component: the shell supplies its own button. */
    function PanelIcon(props) {
      return h(SproutMark, { size: props?.size, active: props?.active })
    }

    /** Client half: four additive seats, nothing replaced. */
    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = typeof document === 'undefined' ? null : document.createElement('style')
        if (style !== null) {
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => { style.remove() })
        }
        ctx.effect(() => {
          const disposers = registerDictionaries(ctx.locale)
          return () => { for (const dispose of disposers) dispose() }
        })
        const store = createGameStore()
        ctx.effect(() => () => store.dispose())
        const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 26,
          label: () => ctx.locale.bind(NS)('panel.title'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, (props) => h(BOUNDARY, { title: ctx.locale.bind(NS)('error.boundary') },
          h(PvzPanel, { ...props, store, locale: ctx.locale, layout }))))

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: SEAT_FOOTER,
          order: 42,
          label: () => ctx.locale.bind(NS)('footer.toggle'),
        }, (props) => h(FooterLaunch, { ...props, store, locale: ctx.locale, layout })))
      },
    }

    module.exports = plugin
    /** Test seam: the store, the URL literals and the seat graph. */
    module.exports.__test = {
      NS,
      ROUTE,
      GAME_URL,
      STATUS_URL,
      PANEL_ID,
      SEAT_FOOTER,
      DEFAULT_DIR_HINT,
      ENV_OVERRIDE,
      createGameStore,
      registerDictionaries,
      LOCALES: { zh: ZH, en: EN },
      COMPONENTS: { SproutMark, StateDot, HubPanel, GameEmbed, PvzPanel, FooterLaunch },
    }

    return module.exports
  },
})
