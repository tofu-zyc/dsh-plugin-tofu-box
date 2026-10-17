# Billing Card — implementation contract (working design, not shipped docs)

Plugin package: `dsh-plugin-billing-card` at `D:\program\dsh-plugins\dsh-plugin-billing-card`.
Goal: a real-time **计费卡片** below the composer that shows per-model token usage and estimated
cost for the current Session, DeepSeek first, extensible to other providers through config.

Zero runtime dependencies on the Host half. The Client half imports only `react` / `react-dom`
from the browser module table. Do not add npm dependencies.

## File ownership (do not edit files outside your scope)

| Owner | Files |
|---|---|
| Lead | `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`, `DESIGN.md`, install + verification |
| host-billing teammate | `index.js`, `billing-core.js`, `tests/billing-core.test.mjs` |
| client-billing teammate | `client.js` |

The Lead installs the bundle in the profile and verifies it; implementers never run
`plugin_manager` and never touch the profile directory.

## Data source (read-only Session log)

The Host half registers one client-visible **session projection unit** with
`ctx.sessionProjections.register(definition)`. It folds durable Session events; no model calls,
no network. Relevant events (from `@deepseek-ai/dsh-session` types):

- `assistant/message` — `{ turn, step, message: AssistantMessage, stream, usage?: TokenUsage, interrupted?: true }`.
  `message.source` is `{ kind: 'model', provider, model, replayState? }`.
- `assistant/attempt` — `{ turn, step, stream: AssistantStreamRecord[] }`; usage is a raw stream
  chunk: scan the array backwards for `record.type === 'chunk' && record.chunk.type === 'usage'`,
  and take `record.chunk.usage`.
- `request/header` — `{ header: EpochHeader, reason, startsSeries? }`; `header.config` is
  `{ provider, model, ... }`.
- `llm/retry-started` — `{ retryId, turn, step, retry }`.

`TokenUsage` = `{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`.
`inputTokens` is **uncached (cache-miss) input**; the three prompt buckets are disjoint:
`inputTokens + cacheReadTokens + cacheWriteTokens`. Each event envelope carries `type`, `seq`,
`time` (epoch ms) and `data`.

## Pricing defaults (official DeepSeek docs, pinned 2026-10-17)

Off-peak is the base rate; peak price = off-peak × 2. Peak window (Beijing time, Mon–Fri,
excluding Chinese statutory holidays): 09:00–12:00 and 14:00–18:00.

CNY (per 1M tokens, off-peak base):

| model | input (cache miss) | cache hit | cache write | output |
|---|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash) | 1 | 0.02 | 0 | 4 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro) | 4.5 | 0.15 | 0 | 13.5 |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` (legacy names, billed as Flash) | 1 | 0.02 | 0 | 4 |

USD (per 1M tokens, off-peak base):

| model | input (cache miss) | cache hit | cache write | output |
|---|---|---|---|---|
| `deepseek-flash` | 0.15 | 0.003 | 0 | 0.6 |
| `deepseek-v4-pro` | 0.66 | 0.022 | 0 | 1.98 |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | 0.15 | 0.003 | 0 | 0.6 |

Default `currency` = `CNY` (Chinese platform account). Every default rule matches provider
`'*'` + an exact model id. Unknown models are **unpriced**, never guessed: their tokens are
counted but excluded from cost and the route is flagged `priced: false`.

## Config (raw object, validated by our own code — no schemastery/zod dependency)

```js
{
  currency: 'CNY' | 'USD',                 // default 'CNY'
  pricing: [                               // optional rules; matched BEFORE built-ins
    {
      provider: string,                    // exact provider route or '*' (default '*')
      model: string,                       // exact model id or '*' (default required)
      currency: 'CNY' | 'USD',             // default config.currency; rules of the other currency are ignored
      inputPerM: number,                   // cache-miss input, per 1M tokens
      cacheReadPerM: number,               // cache hit, per 1M tokens
      cacheWritePerM: number,              // optional, default 0
      outputPerM: number,
      peakMultiplier: number               // optional, default peak.multiplier (2)
    }
  ],
  peak: {                                  // optional policy object
    enabled: boolean,                      // default true
    utcOffsetMinutes: number,              // default 480 (Beijing, UTC+8)
    weekdays: number[],                    // ISO weekday numbers Mon=1..Sun=7, default [1,2,3,4,5]
    windows: [['HH:MM', 'HH:MM'], ...],    // default [['09:00','12:00'], ['14:00','18:00']]
    holidays: string[],                    // 'YYYY-MM-DD' Beijing dates treated as off-peak; default []
    multiplier: number                     // default 2
  }
}
```

Validation is strict and loud: unknown top-level keys, wrong types, non-finite/negative numbers,
invalid currency, invalid `HH:MM`, weekday outside 1..7, duplicate weekdays, invalid holiday
date — all throw an `Error` whose message names the config path, e.g.
`billing-card: config.pricing[0].inputPerM must be a finite non-negative number`.
Do not silently ignore user typo keys.

## Host files

### `billing-core.js` (pure, no Cordis imports; unit-tested by `node --test`)

Exports (named, ESM):

- `BILLING_PROJECTION_KEY = 'billingUsage'`
- `DEFAULT_CURRENCY = 'CNY'`
- `resolveBillingConfig(rawConfig = {})` → resolved config
  `{ currency, rules: PriceRule[], builtinRules: PriceRule[], peak: PeakPolicy }`
  where every rule is normalized (`provider`, `model`, `currency`, `inputPerM`, `cacheReadPerM`,
  `cacheWritePerM`, `outputPerM`, `peakMultiplier`).
- `classifyPeak(eventTimeMs, peakPolicy)` → `true` when the timestamp falls in a peak window.
  Deterministic: local time = `eventTimeMs + utcOffsetMinutes * 60_000`, weekday from that local
  date (Mon=1..Sun=7), local `YYYY-MM-DD` in `holidays` → off-peak, otherwise weekday must be in
  `weekdays` and local minute-of-day inside `[start, end)` of some window. `enabled !== true` → false.
- `resolvePrice(resolvedConfig, provider, model)` → normalized price object or `null`.
  Match precedence: user `rules` first (exact provider+exact model → exact provider+`'*'` →
  `'*'`+exact model → `'*'`+`'*'`), then the same ladder over `builtinRules` of
  `resolvedConfig.currency`. Only rules whose `currency === resolvedConfig.currency` participate.
- `createBillingProjection(resolvedConfig)` → the projection definition object
  `{ key, stateVersion, stateSchema, init, apply, wire: { viewSchema, view } }`.
- `billingView(state, resolvedConfig)` → the wire view (exported for tests; must be pure).

Projection definition:

```js
{
  key: 'billingUsage',
  stateVersion: 1,
  stateSchema,     // structural schema object (see below), validates state
  init: () => ({ routes: {}, current: null, last: null }),
  apply(state, event) { ... returns the SAME reference for ignored events ... },
  wire: {
    viewSchema,    // structural schema object, validates the view
    view(state) { ... cached: same state reference -> same view reference ... },
  },
}
```

State (plain JSON, checkpoint-safe):

```js
{
  routes: {
    [routeKey]: {
      provider: string,
      model: string,
      peak:    { input, cacheRead, cacheWrite, output },  // token buckets billed at peak price
      offPeak: { input, cacheRead, cacheWrite, output },  // token buckets billed at off-peak price
    },
  },
  current: { provider, model } | null,   // latest request/header route
  last: { turn, step, routeKey, tier: 'peak' | 'offPeak', buckets } | null,
}
```

`routeKey` must be collision-free for arbitrary provider/model strings; use
`` `${provider}\u001f${model}` `` and always read provider/model from the stored route entry.

`apply` rules (must mirror the shipped `tokenUsage` fold's billing semantics):

1. `request/header`: update `current` from `event.data.header.config` (`{ provider, model }`).
   Return the same reference when unchanged, otherwise a new state.
2. `llm/retry-started`: when `last` matches `event.data.turn`/`event.data.step`, return
   `{ ...state, last: null }` (the retried attempt is billed separately); otherwise the same state.
3. Usage sample: only `assistant/message` and `assistant/attempt`.
   - `assistant/message`: usage = `event.data.usage` if defined, else the stream usage chunk
     (backward scan as above). Route = `event.data.message.source` (`{ provider, model }`) when
     present, else `state.current`.
   - `assistant/attempt`: usage = stream usage chunk; route = `state.current`.
   - No usage, or no resolvable route → same state reference (do not invent a route).
   - Buckets from usage: `input = usage.inputTokens`, `cacheRead = usage.cacheReadTokens ?? 0`,
     `cacheWrite = usage.cacheWriteTokens ?? 0`, `output = usage.outputTokens`
     (each coerced with `Number.isFinite`; negative values treated as 0).
   - Tier = `classifyPeak(event.time, peak)` ? `'peak'` : `'offPeak'`.
   - Replacement scope: when `state.last` has the same `turn`/`step`, subtract `last.buckets`
     from the bucket at `last.routeKey`/`last.tier` (floor at 0), then add the new buckets to the
     new route/tier; always update `last = { turn, step, routeKey, tier, buckets }`. This makes a
     final assistant-message sample replace an in-attempt streaming sample exactly once, while
     `llm/retry-started` starts a fresh billed attempt.
   - Zero-token routes may stay in state; the view filters them out.
4. Every other event type returns the same state reference.

The fold must never throw for a well-formed Session event. Keep it O(1) in events (no scans of
prior events) and O(routes) in state.

Wire view (`view(state)`; stable reference while the state reference is unchanged):

```js
{
  version: 1,
  currency: 'CNY' | 'USD',
  routes: [                              // only routes with total > 0; deterministic order:
    {                                    // cost desc, then total desc, then provider, then model
      provider, model,
      input, cacheRead, cacheWrite, output, total,
      peak:    { input, cacheRead, cacheWrite, output },
      offPeak: { input, cacheRead, cacheWrite, output },
      cost, costPeak, costOffPeak,       // currency units; peak = off-peak price × peakMultiplier
      priced: boolean,
      pricing: null | { inputPerM, cacheReadPerM, cacheWritePerM, outputPerM, peakMultiplier },
    },
  ],
  totals: {
    input, cacheRead, cacheWrite, output, total,
    cost, costPeak, costOffPeak,
    pricedRoutes, unpricedRoutes,
  },
}
```

Cost math per route: `offPeakCost = (offPeak.input * inputPerM + offPeak.cacheRead * cacheReadPerM
+ offPeak.cacheWrite * cacheWritePerM + offPeak.output * outputPerM) / 1_000_000`;
`peakCost = (same formula over peak buckets) * peakMultiplier`; keep raw floats (the Client
formats). Unpriced route: all three cost fields `0`, `priced: false`, `pricing: null`; its tokens
still count in `totals` and `totals.unpricedRoutes`. `pricedRoutes` counts routes with a price.

Schemas: the shipped registry only calls `schema.parse(value)` (and the projection cache calls it
on restored checkpoint state), so implement a small frozen structural schema object:

```js
function structuralSchema(label, validate) {
  const parse = (value) => {
    const issue = validate(value)          // returns null | string
    if (issue !== null) throw new TypeError(`billing-card: invalid ${label}: ${issue}`)
    return value
  }
  return { parse, safeParse: (value) => { ... } }   // frozen
}
```

`stateSchema` validates the state shape recursively (plain objects, finite non-negative integer-ish
numbers, `last` nullable with tier in `{'peak','offPeak'}`, routes entries carry provider/model
strings). `viewSchema` validates the view shape. Do not use zod/schemastery: the Host package
must install with zero dependencies.

### `index.js`

```js
import { createBillingProjection, resolveBillingConfig } from './billing-core.js'

export const name = 'dsh-plugin-billing-card'
export const inject = ['sessionProjections']

export function apply(ctx, config) {
  const resolved = resolveBillingConfig(config ?? {})
  // register() is itself an effect on the calling plugin fiber; no nested ctx.effect needed.
  ctx.sessionProjections.register(createBillingProjection(resolved))
}
```

No default export, no `Config` export (raw config must reach `apply`; Cordis returns raw config
when a runtime has no `Config`, and our validator is the single source of truth). English JSDoc
on every export and non-obvious helper; comments state contracts, not narration.

### `tests/billing-core.test.mjs`

`node --test`. Import from `../billing-core.js`. Cover at minimum:

1. default config: currency CNY, China peak windows, built-in CNY/USD prices present.
2. strict config errors: unknown key, bad currency, missing/negative price fields, bad `HH:MM`,
   weekday 0/8, duplicate weekday, bad holiday date.
3. `resolvePrice`: exact built-in; legacy v4 names → Flash rates; user rule overrides built-in;
   user wildcard model; provider wildcard; null for unknown model; currency mismatch ignored;
   `peakMultiplier` default and override.
4. `classifyPeak`: Beijing Mon 10:00 peak; Mon 08:00 off; Mon 13:00 off; Mon 15:00 peak;
   Sat 10:00 off; configured holiday date off; `enabled: false` off; 12:00 boundary exclusive;
   09:00 inclusive; UTC timestamps (event.time is epoch ms).
5. apply: assistant/message off-peak CNY Flash → buckets; view cost exactly
   `1000*1 + 500*0.02 + 0*0 + 200*4` / 1e6 for a session with input 1000, cacheRead 500, output 200.
6. peak split: same usage at a peak timestamp → `costPeak` = 2× off-peak formula,
   `costOffPeak` = 0.
7. replacement: two assistant/message samples same turn/step count once (last wins); after
   `llm/retry-started` the next attempt adds.
8. assistant/attempt: usage from stream chunk, route from `request/header`.
9. assistant/message route from `message.source` overrides `current`.
10. unpriced route: tokens in totals, cost 0, `priced: false`, `unpricedRoutes` 1.
11. view reference cached for the same state reference; new object after a usage change.
12. `stateSchema.parse` rejects malformed state / foreign JSON; `viewSchema.parse` accepts view and
    rejects malformed view.
13. route ids with `/` in model (e.g. `GLM/glm-5.3`) and a provider containing odd characters.
14. cacheWrite: default 0 cost, custom rule prices it.

Use small helper builders for events. Tests must be deterministic (fixed epoch ms; no `Date.now()`).

## Client half — `client.js`

Shape (plain browser module, no build step):

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-billing-card',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')   // baseline module table includes react-dom
    const h = React.createElement
    // dictionaries, helpers, components …
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 1. component CSS via a <style> element; remove in ctx.effect cleanup
        // 2. register locale dictionaries for the live locale ids; cleanup via ctx.effect
        // 3. ctx.slots.inject('conversation.composer.dock', () =>
        //      ctx.slots.register({ name: 'conversation.composer.dock', id: 'billing-card', order: 2 },
        //        props => h(BillingCard, { ...props, locale: ctx.locale })))
      },
    }
  },
})
```

Registration details:

- Slot `conversation.composer.dock` (list, session scope; it is the ambient row under the
  composer card; existing shipped entries are `activity` order 0 and `usage` order 1). Our entry
  id `billing-card`, order 2. Do **not** reuse a shipped id; never replace shipped entries.
- Standard slot props used: `useProjection` (the projection hook). `t` is not supplied by the
  framework: pass `locale` through the component closure and bind inside the component, with
  re-render on language switch:
  ```js
  function useTranslate(locale) {
    const subscribe = React.useCallback(cb => locale.subscribe(cb), [locale])
    const snapshot = React.useCallback(() => locale.getSnapshot(), [locale])
    React.useSyncExternalStore(subscribe, snapshot, snapshot)
    return locale.bind('billing-card')
  }
  ```
- Locale namespace `billing-card`; dictionaries keyed by `zh` and `en` (host ships those ids;
  register for every id the live catalog exposes, primary-subtag match like
  `dsh-plugin-shell-selector/client.js`). Every visible string, aria-label and tooltip comes from
  the dictionary — no hardcoded Chinese/English copy in render code.

Projection read: `const view = props.useProjection('billingUsage')`.
Render nothing (`return null`) when `view === undefined`, `view.version !== 1`, or
`view.totals.total === 0`. The lead may install the plugin before a session produces usage — the
card must simply stay absent, never crash the slot.

Collapsed pill (always, when usage exists) — an inline pill matching the shipped stats pills:

- icon: small inline SVG (blocky receipt/coin/¥ glyph, `currentColor`), 12–14 px.
- text: `formatCost(totals.cost, view.currency)` · `formatCount(totals.total)` tokens.
- `aria-haspopup="dialog"`, `aria-expanded`, `aria-label` = full localized summary
  (cost + tokens + cache-hit percent).
- class names prefixed `bc-` (never generic names).

Expanded card — click toggles; render through `ReactDOM.createPortal(..., document.body)` with
`position: fixed`, anchored above the pill (`bottom = innerHeight - rect.top + 8`,
`left = clamp(8, rect.left + rect.width / 2 - PANEL_WIDTH / 2, innerWidth - PANEL_WIDTH - 8)`,
`PANEL_WIDTH ≈ 300`). Recompute the rect on open, on `resize` and on scroll (capture). Close on
Escape and outside pointer-down; restore nothing else. Panel content:

- header: localized title + total estimated cost (+ peak note when `totals.costPeak > 0`).
- token summary: total; input miss; cache hit (+ cache-hit percent); output.
- per-route rows (from `view.routes`): model name (show `provider` as secondary text only when it
  helps disambiguate), tokens `input+cacheRead → output`, cost, and a localized "未配置价格"
  badge plus "仅统计 token" hint when `priced === false`.
- footer notes: estimate disclaimer and the config hint (pricing/peak are configurable).

Formatting helpers:

- `formatCount(n)`: `< 1000` exact with locale-independent grouping off; `< 1e6` → one decimal + `K`
  (drop `.0`); else one decimal + `M`. Non-finite → `0`.
- `formatCost(value, currency)`: symbol map `CNY → ¥`, `USD → $`, otherwise `` `${currency} ` ``;
  `0 → symbol + '0.00'`; `>= 1 → 2` decimals; `>= 0.01 → 3`; `> 0 → 4`; a positive value below
  `0.00005` renders `<0.0001`.
- `cacheHitPercent(totals)`: `cacheRead / (input + cacheRead + cacheWrite) * 100`, rounded to
  integer; `null` when the denominator is 0.

Styling: only `--dsw-alias-*` theme tokens listed by the Theme inspection (e.g.
`--dsw-alias-label-secondary`, `--dsw-alias-label-primary`, `--dsw-alias-border-l1`,
`--dsw-alias-border-l2`, `--dsw-alias-bg-overlay`, `--dsw-alias-bg-layer-1`,
`--dsw-alias-brand-primary`). No literal colors, no purple gradients, no shadows unless expressed
with tokens; panel background uses `--dsw-alias-bg-overlay`, text `--dsw-alias-label-primary`,
secondary text `--dsw-alias-label-secondary`, radius 10–12 px. Respect both light and dark themes.

Cleanup rules: every `document`/`window` listener and the style element lives inside a component
effect or `ctx.effect` and is removed on unmount; `ctx.effect(() => () => style.remove())` for the
global stylesheet; dictionary registrations return their disposers from the same `ctx.effect`.

## Acceptance checklist

Host:
- [ ] `node --check index.js billing-core.js` passes.
- [ ] `cd dsh-plugin-billing-card; node --test tests/*.test.mjs` all green.
- [ ] No external imports in `index.js` / `billing-core.js` (built-in only).
- [ ] Projection definition matches the contract above exactly (key, state shape, view shape).

Client:
- [ ] `node --check client.js` passes.
- [ ] `require('react')` / `require('react-dom')` only; no Harness client packages, no CSS module
      imports, no build step, no bundler syntax.
- [ ] Every i18n key present in both `zh` and `en` dictionaries.
- [ ] Pill and panel use only theme tokens; no hardcoded visible copy.
- [ ] Slot entry id `billing-card`, order 2; component receives the standard kit via props.
- [ ] All listeners cleaned up; portal removed on close/unmount.

The Lead then installs the bundle, confirms the plugin row and Client slot occupancy, refreshes the
GUI, and verifies the rendered card and its live token/cost updates against a real Session.
