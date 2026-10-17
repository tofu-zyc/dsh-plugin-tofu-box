/**
 * Browser half of dsh-plugin-billing-card: one `conversation.composer.dock`
 * list entry that shows the current Session's estimated cost and token usage
 * as a compact pill, and expands into a per-model breakdown card.
 *
 * Hand-written browser bundle, no build step: `react` / `react-dom` come from
 * the baseline module table; no Harness client package is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-billing-card',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Locale namespace owning every visible string of this card. */
    const NS = 'billing-card'
    /** Host wire-view key of the billing projection. */
    const PROJECTION_KEY = 'billingUsage'
    /** Expanded card width in CSS px; the placement clamp uses the same value. */
    const PANEL_WIDTH = 300
    /** Distance kept between the pill's top edge and the card's bottom edge. */
    const PANEL_GAP = 8
    /** Viewport margin kept by the placement clamp. */
    const VIEWPORT_MARGIN = 8

    // Both dictionaries carry exactly the same key set; a missing key would
    // render the raw key. The locale registry keys dictionaries by locale id
    // (`zh` / `en` are the shipped ids) and `bind(NS)` walks the active
    // locale's fallback chain, so `zh` must be registered as `zh`, never only
    // as `zh-CN`; region variants are covered by registerDictionaries().
    const CHINESE = {
      title: '计费卡片',
      'cost.peakNote': '含高峰时段费用 {cost}',
      'tokens.total': '总用量',
      'tokens.input': '未缓存输入',
      'tokens.cacheRead': '缓存命中',
      'tokens.cacheWrite': '缓存写入',
      'tokens.output': '输出',
      'tokens.count': '{count} tok',
      'tokens.cacheHitPercent': '{count}（命中 {percent}%）',
      'routes.title': '分模型',
      'routes.unknownModel': '未知模型',
      'unpriced.badge': '未配置价格',
      'unpriced.hint': '仅统计 token',
      'footer.estimate': '费用为按配置价格表估算的预估值，非实际账单。',
      'footer.config': '价格与峰谷时段可在插件配置中调整。',
      'pill.aria': '预估费用 {cost}，{tokens}，缓存命中率 {percent}%',
      'pill.ariaNoCache': '预估费用 {cost}，{tokens}',
    }

    const ENGLISH = {
      title: 'Billing card',
      'cost.peakNote': 'Includes {cost} at peak rates',
      'tokens.total': 'Total',
      'tokens.input': 'Uncached input',
      'tokens.cacheRead': 'Cache hit',
      'tokens.cacheWrite': 'Cache write',
      'tokens.output': 'Output',
      'tokens.count': '{count} tok',
      'tokens.cacheHitPercent': '{count} ({percent}% hit)',
      'routes.title': 'By model',
      'routes.unknownModel': 'Unknown model',
      'unpriced.badge': 'Unpriced',
      'unpriced.hint': 'Tokens only',
      'footer.estimate': 'Costs are estimates from the configured price table, not an actual bill.',
      'footer.config': 'Pricing and peak windows are configurable in the plugin config.',
      'pill.aria': 'Estimated cost {cost}, {tokens}, cache hit {percent}%',
      'pill.ariaNoCache': 'Estimated cost {cost}, {tokens}',
    }

    /** Locale ids the browser client ships; `bind`'s fallback chain anchors on them. */
    const BUILT_IN_LOCALE_IDS = ['zh', 'en']

    /** Currency symbols; any other currency keeps its code as the prefix. */
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

    /** Pick the dictionary a locale id should receive, by its primary subtag. */
    function dictionaryFor(id) {
      const primary = String(id).toLowerCase().split('-')[0]
      if (primary === 'zh') return CHINESE
      if (primary === 'en') return ENGLISH
      return undefined
    }

    /**
     * Register one dictionary per built-in id plus every id the live catalog
     * exposes, so a language-pack locale such as `zh-CN` or `zh-Hans`
     * resolves Chinese instead of falling through to English.
     * @param locale - the harness locale service (`ctx.locale`).
     * @returns a disposer removing every registration this call made.
     */
    function registerDictionaries(locale) {
      const ids = new Set(BUILT_IN_LOCALE_IDS)
      const snapshot = locale.getSnapshot()
      const locales = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.locales)
        ? snapshot.locales
        : []
      for (const definition of locales) {
        if (definition !== null && typeof definition === 'object' && typeof definition.id === 'string') ids.add(definition.id)
      }
      const disposers = []
      for (const id of ids) {
        const dict = dictionaryFor(id)
        if (dict !== undefined) disposers.push(locale.register(NS, id, dict))
      }
      return () => { for (const dispose of disposers) dispose() }
    }

    /** Re-render on language change and return the current translator for the namespace. */
    function useTranslate(locale) {
      const subscribe = React.useCallback(callback => locale.subscribe(callback), [locale])
      const snapshot = React.useCallback(() => locale.getSnapshot(), [locale])
      React.useSyncExternalStore(subscribe, snapshot, snapshot)
      return locale.bind(NS)
    }

    /** Coerce arbitrary wire input to a finite number, defaulting to 0. */
    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    /**
     * Compact, locale-independent token count: exact below 1000, then one
     * decimal and a K/M suffix with a trailing `.0` dropped.
     * @param value - token count.
     * @returns display string; non-finite input reads `0`.
     */
    function formatCount(value) {
      const count = finite(value)
      if (count <= 0) return '0'
      if (count < 1000) return String(count)
      if (count < 1000000) return `${formatScaled(count / 1000)}K`
      return `${formatScaled(count / 1000000)}M`
    }

    /** One decimal at most, without a trailing `.0`. */
    function formatScaled(value) {
      const rounded = Math.round(value * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }

    /** Currency prefix: mapped symbol, otherwise `<code> ` (CNY when absent). */
    function currencySymbol(currency) {
      if (typeof currency !== 'string' || currency === '') return CURRENCY_SYMBOLS.CNY
      return CURRENCY_SYMBOLS[currency] ?? `${currency} `
    }

    /**
     * Currency cost with magnitude-dependent precision: `0.00` for zero, 2
     * decimals from 1 unit, 3 from 0.01, 4 for any smaller positive amount,
     * and `<0.0001` for positive amounts below 0.00005.
     * @param value - cost in currency units.
     * @param currency - `CNY` / `USD` / other currency code.
     * @returns display string.
     */
    function formatCost(value, currency) {
      const symbol = currencySymbol(currency)
      const amount = finite(value)
      if (amount <= 0) return `${symbol}0.00`
      if (amount < 0.00005) return `${symbol}<0.0001`
      if (amount >= 1) return `${symbol}${amount.toFixed(2)}`
      if (amount >= 0.01) return `${symbol}${amount.toFixed(3)}`
      return `${symbol}${amount.toFixed(4)}`
    }

    /**
     * Integer cache-hit share of prompt-side input.
     * @param totals - the wire view's totals (input/cacheRead/cacheWrite buckets).
     * @returns integer percent, or null when no prompt-side tokens were billed.
     */
    function cacheHitPercent(totals) {
      const cacheRead = finite(totals.cacheRead)
      const denominator = finite(totals.input) + cacheRead + finite(totals.cacheWrite)
      if (!(denominator > 0)) return null
      return Math.round(cacheRead / denominator * 100)
    }

    /**
     * Validate and normalize the Host wire view. Any value that does not match
     * the version-1 shape with a positive token total yields null, so a
     * missing projection, a future version, or a fresh Session leaves the
     * slot empty instead of throwing.
     * @param view - `useProjection('billingUsage')` result.
     * @returns `{ currency, routes, totals }` or null.
     */
    function renderableView(view) {
      if (view === null || typeof view !== 'object') return null
      if (view.version !== 1) return null
      const totals = view.totals
      if (totals === null || typeof totals !== 'object') return null
      if (!(finite(totals.total) > 0)) return null
      return {
        currency: view.currency,
        routes: Array.isArray(view.routes) ? view.routes : [],
        totals,
      }
    }

    /** Small coin-with-yuan glyph; `currentColor` follows the pill's state. */
    function billingIcon() {
      return h('svg', {
        className: 'bc-icon',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.3,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          d: 'M5.5 4.6 8 7.9l2.5-3.3M8 7.9v3.5M6.1 8.9h3.8M6.1 10.3h3.8',
        })
      )
    }

    /**
     * The dock entry. Renders the collapsed pill always (when usage exists)
     * and portals the expanded card above it while open.
     * @param props - framework standard props plus the plugin's `locale` service.
     */
    function BillingCard({ useProjection, locale }) {
      const t = useTranslate(locale)
      const data = renderableView(useProjection(PROJECTION_KEY))
      const visible = data !== null
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const pillRef = React.useRef(null)
      const panelRef = React.useRef(null)

      // Viewport placement: fixed coordinates above the pill, recomputed on
      // open, on resize, and on any (nested) scroll. Escape and outside
      // pointer-down close the card; every listener is removed on cleanup.
      const measurePanel = React.useCallback(() => {
        const pill = pillRef.current
        if (pill === null) return { left: VIEWPORT_MARGIN, bottom: 96 }
        const rect = pill.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const width = Math.min(PANEL_WIDTH, Math.max(0, viewportWidth - 2 * VIEWPORT_MARGIN))
        const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
        const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, VIEWPORT_MARGIN), maxLeft)
        const bottom = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + PANEL_GAP)
        return { left, bottom }
      }, [])

      // A Session switch or a projection reset can invalidate the view while
      // the card is open; close it rather than keeping a stale panel mounted.
      React.useEffect(() => {
        if (!visible && open) setOpen(false)
      }, [visible, open])

      React.useEffect(() => {
        if (!open || !visible) return undefined
        const sync = () => {
          const next = measurePanel()
          setPosition(previous => (previous !== null
            && previous.left === next.left
            && previous.bottom === next.bottom
            ? previous
            : next))
        }
        const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
        const onPointerDown = event => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (pillRef.current !== null && pillRef.current.contains(target)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          setOpen(false)
        }
        window.addEventListener('resize', sync)
        window.addEventListener('scroll', sync, true)
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.removeEventListener('resize', sync)
          window.removeEventListener('scroll', sync, true)
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, visible, measurePanel])

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        setPosition(measurePanel())
        setOpen(true)
      }

      if (!visible) return null

      const { currency, routes, totals } = data
      const percent = cacheHitPercent(totals)
      const costText = formatCost(totals.cost, currency)
      const tokenCount = value => t('tokens.count', { count: formatCount(value) })
      const totalTokensText = tokenCount(totals.total)
      const ariaLabel = percent === null
        ? t('pill.ariaNoCache', { cost: costText, tokens: totalTokensText })
        : t('pill.aria', { cost: costText, tokens: totalTokensText, percent })

      const panelStyle = position === null
        ? { visibility: 'hidden' }
        : { left: `${position.left}px`, bottom: `${position.bottom}px` }

      // Token summary rows: total, uncached input, cache hit (with percent),
      // cache write only when it moved, and output. Buckets are disjoint.
      const summaryRows = []
      const pushRow = (key, label, value) => {
        summaryRows.push(h('dt', { key: `${key}-label`, className: 'bc-row-label' }, label))
        summaryRows.push(h('dd', { key: `${key}-value`, className: 'bc-row-value' }, value))
      }
      pushRow('total', t('tokens.total'), tokenCount(totals.total))
      pushRow('input', t('tokens.input'), tokenCount(totals.input))
      const cacheReadText = percent === null
        ? tokenCount(totals.cacheRead)
        : t('tokens.cacheHitPercent', { count: tokenCount(totals.cacheRead), percent })
      pushRow('cacheRead', t('tokens.cacheRead'), cacheReadText)
      if (finite(totals.cacheWrite) > 0) pushRow('cacheWrite', t('tokens.cacheWrite'), tokenCount(totals.cacheWrite))
      pushRow('output', t('tokens.output'), tokenCount(totals.output))

      // Routes: only same-model-different-provider duplicates need the
      // provider line, so the common row stays a single clean item.
      const modelCounts = new Map()
      for (const route of routes) {
        if (route === null || typeof route !== 'object') continue
        const model = typeof route.model === 'string' ? route.model : ''
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
      }
      const routeRows = []
      for (const route of routes) {
        if (route === null || typeof route !== 'object') continue
        const model = typeof route.model === 'string' && route.model !== '' ? route.model : t('routes.unknownModel')
        const provider = typeof route.provider === 'string' ? route.provider : ''
        const priced = route.priced !== false
        const promptTokens = finite(route.input) + finite(route.cacheRead) + finite(route.cacheWrite)
        const key = `${provider}\u001f${model}`
        routeRows.push(h('div', { key, className: 'bc-route' },
          h('div', { className: 'bc-route-head' },
            h('div', { className: 'bc-route-name' },
              h('span', { className: 'bc-route-model', title: model }, model),
              priced ? null : h('span', { className: 'bc-badge' }, t('unpriced.badge'))),
            priced ? h('span', { className: 'bc-route-cost' }, formatCost(route.cost, currency)) : null),
          h('div', { className: 'bc-route-meta' },
            modelCounts.get(typeof route.model === 'string' ? route.model : '') > 1 && provider !== ''
              ? h('span', { className: 'bc-route-provider' }, provider)
              : null,
            h('span', { className: 'bc-route-tokens' },
              `${formatCount(promptTokens)} → ${formatCount(route.output)}`),
            priced ? null : h('span', { className: 'bc-route-hint' }, t('unpriced.hint')))))
      }

      const panel = open ? ReactDOM.createPortal(
        h('div', {
          ref: panelRef,
          className: 'bc-panel',
          role: 'dialog',
          'aria-label': t('title'),
          style: panelStyle,
        },
          h('div', { className: 'bc-head' },
            h('span', { className: 'bc-title' }, t('title')),
            h('span', { className: 'bc-total' }, costText)),
          finite(totals.costPeak) > 0
            ? h('div', { className: 'bc-peak' },
              t('cost.peakNote', { cost: formatCost(totals.costPeak, currency) }))
            : null,
          h('div', { className: 'bc-rule', 'aria-hidden': 'true' }),
          h('dl', { className: 'bc-rows' }, summaryRows),
          routeRows.length > 0
            ? h('div', { className: 'bc-routes' },
              h('div', { className: 'bc-section-title' }, t('routes.title')),
              routeRows)
            : null,
          h('div', { className: 'bc-footer' },
            h('p', { className: 'bc-note' }, t('footer.estimate')),
            h('p', { className: 'bc-note' }, t('footer.config')))),
        document.body,
      ) : null

      return h('span', { className: 'bc-anchor', 'data-billing-card': '' },
        h('button', {
          ref: pillRef,
          type: 'button',
          className: 'bc-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          title: ariaLabel,
          onClick: toggle,
        },
          billingIcon(),
          h('span', { className: 'bc-pill-cost' }, costText),
          h('span', { className: 'bc-pill-sep', 'aria-hidden': 'true' }, '·'),
          h('span', { className: 'bc-pill-tokens' }, totalTokensText)),
        panel)
    }

    const CSS = `
.bc-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.bc-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.bc-pill:hover,.bc-pill[aria-expanded='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.bc-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.bc-icon{width:14px;height:14px;flex:none}
.bc-pill-cost{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.bc-pill-sep{margin:0 6px;color:var(--dsw-alias-separator-primary)}
.bc-pill-tokens{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bc-panel{position:fixed;z-index:1100;box-sizing:border-box;width:300px;max-width:calc(100vw - 16px);max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;text-align:left;cursor:default}
.bc-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.bc-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.bc-total{font-size:13px;font-weight:600;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.bc-peak{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.bc-rule{margin:8px 0 10px;border-top:1px solid var(--dsw-alias-border-l2)}
.bc-rows{display:grid;grid-template-columns:minmax(72px,auto) minmax(0,1fr);gap:4px 14px;margin:0}
.bc-row-label{min-width:0;margin:0;color:var(--dsw-alias-label-secondary)}
.bc-row-value{min-width:0;margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.bc-routes{margin-top:12px}
.bc-section-title{margin-bottom:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;letter-spacing:.02em}
.bc-route{padding:6px 0 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.bc-route-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.bc-route-name{display:flex;align-items:center;gap:6px;min-width:0}
.bc-route-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:500}
.bc-route-cost{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.bc-route-meta{display:flex;align-items:center;gap:8px;min-width:0;margin-top:2px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.bc-route-provider{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-route-tokens{font-variant-numeric:tabular-nums;white-space:nowrap}
.bc-route-hint{color:var(--dsw-alias-label-secondary);opacity:.9}
.bc-badge{display:inline-flex;align-items:center;flex:none;padding:0 6px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:10.5px;line-height:16px;white-space:nowrap}
.bc-footer{display:flex;flex-direction:column;gap:3px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.bc-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // One global stylesheet per plugin fiber; every class name is `bc-`
        // prefixed, so the sheet cannot collide with shipped styles.
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-plugin-billing-card'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() })

        ctx.effect(() => registerDictionaries(ctx.locale))

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'billing-card', order: 2 },
          props => h(BillingCard, { ...props, locale: ctx.locale })))
      },
    }
  },
})
