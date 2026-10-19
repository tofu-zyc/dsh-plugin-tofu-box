/**
 * Pure billing computation for the Billing Card Host half.
 *
 * This module owns the `billingUsage` Session projection: the fold that turns
 * durable Session events into per-route token buckets, the peak/off-peak split,
 * the config validator, the price resolver, and the client wire view. It has no
 * imports — no Cordis, no browser globals, no schema library — so the Host half
 * installs with zero dependencies and the fold is unit-testable under `node --test`.
 *
 * Every price is a list price per 1M tokens and every cost is an estimate: the
 * wire view keeps raw floats and the Client formats them.
 *
 * @module dsh-plugin-billing-card/billing-core
 */

/** The Session-projection key owned by this plugin. */
export const BILLING_PROJECTION_KEY = 'billingUsage'

/** Currency assumed when the config does not choose one. */
export const DEFAULT_CURRENCY = 'CNY'

/** Currencies that have a built-in price table. */
const CURRENCIES = Object.freeze(['CNY', 'USD'])

/**
 * Separator between the provider and the model id inside one route key. A
 * Session route is identified by the pair; the separator keeps `provider` and
 * `model` from running together when either id contains `/` or punctuation.
 */
const ROUTE_KEY_SEPARATOR = '\u001f'

/** The four disjoint token buckets, in wire order. */
const BUCKET_KEYS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output'])

/** Fields of one normalized price rule. */
const PRICE_RULE_FIELDS = Object.freeze([
  'provider',
  'model',
  'currency',
  'inputPerM',
  'cacheReadPerM',
  'cacheWritePerM',
  'outputPerM',
  'peakMultiplier',
])

/** Recognized top-level config fields; anything else is a typo. */
const CONFIG_FIELDS = Object.freeze(['currency', 'pricing', 'peak', 'search'])

/** Recognized `search` policy fields. */
const SEARCH_FIELDS = Object.freeze(['enabled', 'perRequest', 'searchFreeUntil', 'trackFetch'])

/**
 * Official DeepSeek Search / Fetch per-request prices, in the configured
 * currency: 5 CNY per 1,000 successful requests, $0.75 per 1,000.
 */
const DEFAULT_SEARCH_PER_REQUEST = Object.freeze({ CNY: 0.005, USD: 0.00075 })

/**
 * DeepSeek keeps server-side Search / Fetch calls free through Beijing
 * 2026-11-01 00:00 (2026-10-31T16:00:00Z); direct API requests are billed from
 * launch. Only the server-side search window is configurable here.
 */
const DEFAULT_SEARCH_FREE_UNTIL = '2026-10-31T16:00:00.000Z'

/** The all-zero search counters of a fresh fold state. */
const ZERO_SEARCH_COUNTERS = Object.freeze({
  calls: 0,
  requests: 0,
  billable: 0,
  emptyCalls: 0,
  failedCalls: 0,
  fetchCalls: 0,
  fetchBillable: 0,
})

/** Recognized `peak` policy fields. */
const PEAK_FIELDS = Object.freeze([
  'enabled',
  'utcOffsetMinutes',
  'weekdays',
  'windows',
  'holidays',
  'multiplier',
])

/** Default ISO weekdays of the China peak policy (Monday–Friday). */
const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5])

/** Default China peak windows, Beijing local time. */
const DEFAULT_WINDOWS = Object.freeze([
  Object.freeze(['09:00', '12:00']),
  Object.freeze(['14:00', '18:00']),
])

/** Default peak-policy UTC offset: +480 minutes (Beijing, UTC+8). */
const DEFAULT_UTC_OFFSET_MINUTES = 480

/** Default peak multiplier over the off-peak list price. */
const DEFAULT_PEAK_MULTIPLIER = 2

/** `HH:MM` in 24-hour local time. */
const HHMM_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/

/** One local `YYYY-MM-DD` calendar date. */
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/

/**
 * Off-peak list prices from the official DeepSeek pricing page, pinned
 * 2026-10-17. Order is the built-in match order; both legacy model ids bill as
 * Flash. Values are currency units per 1M tokens.
 */
const BUILTIN_PRICES = Object.freeze({
  CNY: Object.freeze([
    Object.freeze(['deepseek-flash', Object.freeze({ inputPerM: 1, cacheReadPerM: 0.02, cacheWritePerM: 0, outputPerM: 4 })]),
    Object.freeze(['deepseek-v4-pro', Object.freeze({ inputPerM: 4.5, cacheReadPerM: 0.15, cacheWritePerM: 0, outputPerM: 13.5 })]),
    Object.freeze(['deepseek-v4-flash', Object.freeze({ inputPerM: 1, cacheReadPerM: 0.02, cacheWritePerM: 0, outputPerM: 4 })]),
    Object.freeze(['deepseek-v4-flash-vision-exp', Object.freeze({ inputPerM: 1, cacheReadPerM: 0.02, cacheWritePerM: 0, outputPerM: 4 })]),
  ]),
  USD: Object.freeze([
    Object.freeze(['deepseek-flash', Object.freeze({ inputPerM: 0.15, cacheReadPerM: 0.003, cacheWritePerM: 0, outputPerM: 0.6 })]),
    Object.freeze(['deepseek-v4-pro', Object.freeze({ inputPerM: 0.66, cacheReadPerM: 0.022, cacheWritePerM: 0, outputPerM: 1.98 })]),
    Object.freeze(['deepseek-v4-flash', Object.freeze({ inputPerM: 0.15, cacheReadPerM: 0.003, cacheWritePerM: 0, outputPerM: 0.6 })]),
    Object.freeze(['deepseek-v4-flash-vision-exp', Object.freeze({ inputPerM: 0.15, cacheReadPerM: 0.003, cacheWritePerM: 0, outputPerM: 0.6 })]),
  ]),
})

/** Flat token buckets used by the state schema and the fold. */
const ZERO_BUCKETS = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

// --------------------------------------------------------------------------
// Small structural helpers
// --------------------------------------------------------------------------

/**
 * Whether `value` is a plain object (not an array, not null, no class prototype).
 * @param {unknown} value - candidate value.
 * @returns {boolean} `true` for `{}`-shaped data.
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Whether `value` owns exactly the given field names.
 * @param {Record<string, unknown>} value - plain object to test.
 * @param {readonly string[]} fields - required and only-allowed field names.
 * @returns {boolean} `true` when the key set matches exactly.
 */
function hasExactKeys(value, fields) {
  const keys = Object.keys(value)
  return keys.length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

/**
 * Build the one error shape every config failure uses: an `Error` whose message
 * names the config path.
 * @param {string} message - what is wrong, including the config path.
 * @returns {Error} the error to throw.
 */
function configError(message) {
  return new Error(`billing-card: ${message}`)
}

/**
 * Throw the standard config error.
 * @param {string} message - what is wrong, including the config path.
 */
function failConfig(message) {
  throw configError(message)
}

/**
 * Reject every field outside the recognized set, so a typo never falls through.
 * @param {Record<string, unknown>} value - object to inspect.
 * @param {readonly string[]} fields - recognized field names.
 * @param {string} path - config path of `value`.
 */
function rejectUnknownKeys(value, fields, path) {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) failConfig(`${path}.${field} is not a recognized option`)
  }
}

/**
 * Validate one required finite non-negative number.
 * @param {unknown} value - candidate value.
 * @param {string} path - config path of the value.
 * @returns {number} the value unchanged.
 */
function finiteNonNegative(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    failConfig(`${path} must be a finite non-negative number`)
  }
  return value
}

/**
 * Validate one required non-empty string.
 * @param {unknown} value - candidate value.
 * @param {string} path - config path of the value.
 * @returns {string} the value unchanged.
 */
function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) failConfig(`${path} must be a non-empty string`)
  return value
}

// --------------------------------------------------------------------------
// Config resolution
// --------------------------------------------------------------------------

/**
 * Validate the selected currency.
 * @param {unknown} value - candidate currency.
 * @param {string} path - config path of the value.
 * @returns {'CNY'|'USD'} the currency unchanged.
 */
function resolveCurrency(value, path) {
  if (!CURRENCIES.includes(/** @type {string} */ (value))) failConfig(`${path} must be 'CNY' or 'USD'`)
  return /** @type {'CNY'|'USD'} */ (value)
}

/**
 * Resolve one optional boolean flag.
 * @param {unknown} value - configured flag or `undefined`.
 * @param {string} path - config path of the flag.
 * @param {boolean} fallback - value used when the flag is absent.
 * @returns {boolean} the effective flag.
 */
function resolveBoolean(value, path, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') failConfig(`${path} must be a boolean`)
  return value
}

/**
 * Resolve one optional ISO-8601 timestamp, where `null` disables the window.
 * @param {unknown} value - configured timestamp, `null`, or `undefined`.
 * @param {string} path - config path of the value.
 * @param {string} fallback - ISO-8601 timestamp used when the value is absent.
 * @returns {number|null} epoch milliseconds, or `null` when the window is disabled.
 */
function resolveTimestamp(value, path, fallback) {
  if (value === undefined) return Date.parse(fallback)
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) failConfig(`${path} must be an ISO-8601 timestamp or null`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) failConfig(`${path} must be an ISO-8601 timestamp or null`)
  return parsed
}

/**
 * Validate the optional `search` policy and apply every default. The policy
 * covers DeepSeek's per-request Search / Fetch billing: one price for both
 * APIs, a free window for server-side search calls only, and a switch for the
 * direct Fetch API path used by the runtime's web fetch tool.
 * @param {unknown} rawSearch - raw `config.search` value.
 * @param {'CNY'|'USD'} currency - configured billing currency.
 * @returns {{ enabled: boolean, perRequest: number, searchFreeUntil: number|null, trackFetch: boolean }} resolved policy.
 */
function resolveSearchConfig(rawSearch, currency) {
  if (rawSearch === undefined) {
    return {
      enabled: true,
      perRequest: DEFAULT_SEARCH_PER_REQUEST[currency],
      searchFreeUntil: Date.parse(DEFAULT_SEARCH_FREE_UNTIL),
      trackFetch: true,
    }
  }
  if (!isPlainObject(rawSearch)) failConfig('config.search must be a plain object')
  rejectUnknownKeys(rawSearch, SEARCH_FIELDS, 'config.search')
  return {
    enabled: resolveBoolean(rawSearch.enabled, 'config.search.enabled', true),
    perRequest: rawSearch.perRequest === undefined
      ? DEFAULT_SEARCH_PER_REQUEST[currency]
      : finiteNonNegative(rawSearch.perRequest, 'config.search.perRequest'),
    searchFreeUntil: resolveTimestamp(rawSearch.searchFreeUntil, 'config.search.searchFreeUntil', DEFAULT_SEARCH_FREE_UNTIL),
    trackFetch: resolveBoolean(rawSearch.trackFetch, 'config.search.trackFetch', true),
  }
}

/**
 * Convert `HH:MM` to a minute-of-day offset.
 * @param {string} time - validated `HH:MM` string.
 * @returns {number} minutes since local midnight.
 */
function minuteOfDay(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

/**
 * Validate one `HH:MM` local time.
 * @param {unknown} value - candidate time.
 * @param {string} path - config path of the value.
 * @returns {string} the time unchanged.
 */
function resolveHhmm(value, path) {
  if (typeof value !== 'string' || !HHMM_PATTERN.test(value)) failConfig(`${path} must be a valid HH:MM time`)
  return value
}

/**
 * Resolve the peak-policy `enabled` flag.
 * @param {unknown} value - configured flag or `undefined`.
 * @returns {boolean} the effective flag.
 */
function resolvePeakEnabled(value) {
  if (value === undefined) return true
  if (typeof value !== 'boolean') failConfig('config.peak.enabled must be a boolean')
  return value
}

/**
 * Resolve the peak-policy UTC offset.
 * @param {unknown} value - configured offset or `undefined`.
 * @returns {number} whole minutes east of UTC.
 */
function resolveUtcOffsetMinutes(value) {
  if (value === undefined) return DEFAULT_UTC_OFFSET_MINUTES
  if (!Number.isInteger(value) || /** @type {number} */ (value) < -1440 || /** @type {number} */ (value) > 1440) {
    failConfig('config.peak.utcOffsetMinutes must be a whole number of minutes between -1440 and 1440')
  }
  return /** @type {number} */ (value)
}

/**
 * Resolve the peak-policy ISO weekdays.
 * @param {unknown} value - configured weekdays or `undefined`.
 * @returns {number[]} ISO weekday numbers, Monday=1 through Sunday=7.
 */
function resolveWeekdays(value) {
  if (value === undefined) return [...DEFAULT_WEEKDAYS]
  if (!Array.isArray(value)) failConfig('config.peak.weekdays must be an array of ISO weekday numbers')
  /** @type {number[]} */
  const weekdays = []
  for (let index = 0; index < value.length; index += 1) {
    const weekday = value[index]
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      failConfig(`config.peak.weekdays[${index}] must be an integer between 1 and 7`)
    }
    if (weekdays.includes(weekday)) failConfig(`config.peak.weekdays[${index}] repeats weekday ${weekday}`)
    weekdays.push(weekday)
  }
  return weekdays
}

/**
 * Resolve the peak-policy windows.
 * @param {unknown} value - configured windows or `undefined`.
 * @returns {Array<[string, string]>} `[start, end]` `HH:MM` pairs in local time.
 */
function resolveWindows(value) {
  if (value === undefined) return DEFAULT_WINDOWS.map(window => [...window])
  if (!Array.isArray(value)) failConfig('config.peak.windows must be an array of [start, end] HH:MM pairs')
  /** @type {Array<[string, string]>} */
  const windows = []
  for (let index = 0; index < value.length; index += 1) {
    const path = `config.peak.windows[${index}]`
    const window = value[index]
    if (!Array.isArray(window) || window.length !== 2) failConfig(`${path} must be an [start, end] pair of HH:MM times`)
    const start = resolveHhmm(window[0], `${path}[0]`)
    const end = resolveHhmm(window[1], `${path}[1]`)
    if (minuteOfDay(start) >= minuteOfDay(end)) failConfig(`${path} must start before it ends`)
    windows.push([start, end])
  }
  return windows
}

/**
 * Validate one `YYYY-MM-DD` calendar date.
 * @param {unknown} value - candidate date.
 * @param {string} path - config path of the value.
 * @returns {string} the date unchanged.
 */
function resolveHolidayDate(value, path) {
  if (typeof value !== 'string') failConfig(`${path} must be a valid YYYY-MM-DD date`)
  const match = DATE_PATTERN.exec(value)
  if (match === null) failConfig(`${path} must be a valid YYYY-MM-DD date`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    failConfig(`${path} must be a real calendar date`)
  }
  return value
}

/**
 * Resolve the peak-policy holiday list.
 * @param {unknown} value - configured holidays or `undefined`.
 * @returns {string[]} local `YYYY-MM-DD` dates treated as off-peak.
 */
function resolveHolidays(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) failConfig('config.peak.holidays must be an array of YYYY-MM-DD dates')
  return value.map((holiday, index) => resolveHolidayDate(holiday, `config.peak.holidays[${index}]`))
}

/**
 * Validate and default one `peak` policy object.
 * @param {unknown} rawPeak - configured policy or `undefined`.
 * @returns {{ enabled: boolean, utcOffsetMinutes: number, weekdays: number[], windows: Array<[string, string]>, holidays: string[], multiplier: number }} normalized policy.
 */
function resolvePeakPolicy(rawPeak) {
  if (rawPeak === undefined) rawPeak = {}
  if (!isPlainObject(rawPeak)) failConfig('config.peak must be a plain object')
  rejectUnknownKeys(rawPeak, PEAK_FIELDS, 'config.peak')
  return {
    enabled: resolvePeakEnabled(rawPeak.enabled),
    utcOffsetMinutes: resolveUtcOffsetMinutes(rawPeak.utcOffsetMinutes),
    weekdays: resolveWeekdays(rawPeak.weekdays),
    windows: resolveWindows(rawPeak.windows),
    holidays: resolveHolidays(rawPeak.holidays),
    multiplier: rawPeak.multiplier === undefined
      ? DEFAULT_PEAK_MULTIPLIER
      : finiteNonNegative(rawPeak.multiplier, 'config.peak.multiplier'),
  }
}

/**
 * Validate and default one user price rule.
 * @param {unknown} rawRule - configured rule.
 * @param {number} index - position in `config.pricing`, for error paths.
 * @param {string} defaultCurrency - currency assumed when the rule omits one.
 * @param {number} defaultPeakMultiplier - multiplier assumed when the rule omits one.
 * @returns {{ provider: string, model: string, currency: string, inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }} normalized rule.
 */
function resolvePriceRule(rawRule, index, defaultCurrency, defaultPeakMultiplier) {
  const path = `config.pricing[${index}]`
  if (!isPlainObject(rawRule)) failConfig(`${path} must be a plain object`)
  rejectUnknownKeys(rawRule, PRICE_RULE_FIELDS, path)
  return {
    provider: rawRule.provider === undefined ? '*' : nonEmptyString(rawRule.provider, `${path}.provider`),
    model: nonEmptyString(rawRule.model, `${path}.model`),
    currency: rawRule.currency === undefined
      ? defaultCurrency
      : resolveCurrency(rawRule.currency, `${path}.currency`),
    inputPerM: finiteNonNegative(rawRule.inputPerM, `${path}.inputPerM`),
    cacheReadPerM: finiteNonNegative(rawRule.cacheReadPerM, `${path}.cacheReadPerM`),
    cacheWritePerM: rawRule.cacheWritePerM === undefined
      ? 0
      : finiteNonNegative(rawRule.cacheWritePerM, `${path}.cacheWritePerM`),
    outputPerM: finiteNonNegative(rawRule.outputPerM, `${path}.outputPerM`),
    peakMultiplier: rawRule.peakMultiplier === undefined
      ? defaultPeakMultiplier
      : finiteNonNegative(rawRule.peakMultiplier, `${path}.peakMultiplier`),
  }
}

/**
 * Default and validate every user price rule.
 * @param {unknown} rawPricing - configured `pricing` array or `undefined`.
 * @param {string} currency - resolved config currency, the rule default.
 * @param {number} peakMultiplier - resolved peak multiplier, the rule default.
 * @returns {Array<Record<string, number|string>>} normalized rules.
 */
function resolvePriceRules(rawPricing, currency, peakMultiplier) {
  if (rawPricing === undefined) return []
  if (!Array.isArray(rawPricing)) failConfig('config.pricing must be an array of price rules')
  return rawPricing.map((rule, index) => resolvePriceRule(rule, index, currency, peakMultiplier))
}

/**
 * Flatten the pinned built-in tables into normalized rules. Both currencies are
 * always present; price matching filters them by the configured currency.
 * @param {number} peakMultiplier - resolved peak multiplier attached to each rule.
 * @returns {Array<{ provider: string, model: string, currency: string, inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }>} built-in rules.
 */
function buildBuiltinRules(peakMultiplier) {
  /** @type {Array<{ provider: string, model: string, currency: string, inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }>} */
  const rules = []
  for (const currency of CURRENCIES) {
    for (const [model, price] of BUILTIN_PRICES[currency]) {
      rules.push({
        provider: '*',
        model,
        currency,
        inputPerM: price.inputPerM,
        cacheReadPerM: price.cacheReadPerM,
        cacheWritePerM: price.cacheWritePerM,
        outputPerM: price.outputPerM,
        peakMultiplier,
      })
    }
  }
  return rules
}

/**
 * Validate one raw plugin config and apply every default.
 *
 * Validation is strict and loud: unknown fields, wrong types, non-finite or
 * negative prices, bad currencies, `HH:MM` times, weekdays, or holiday dates
 * throw an `Error` whose message names the config path.
 * @param {unknown} [rawConfig] - raw row config from the profile composition.
 * @returns {{ currency: 'CNY'|'USD', rules: Array<Record<string, number|string>>, builtinRules: Array<Record<string, number|string>>, peak: { enabled: boolean, utcOffsetMinutes: number, weekdays: number[], windows: Array<[string, string]>, holidays: string[], multiplier: number }, search: { enabled: boolean, perRequest: number, searchFreeUntil: number|null, trackFetch: boolean } }} resolved config.
 */
export function resolveBillingConfig(rawConfig = {}) {
  if (!isPlainObject(rawConfig)) failConfig('config must be a plain object')
  rejectUnknownKeys(rawConfig, CONFIG_FIELDS, 'config')
  const currency = rawConfig.currency === undefined
    ? DEFAULT_CURRENCY
    : resolveCurrency(rawConfig.currency, 'config.currency')
  const peak = resolvePeakPolicy(rawConfig.peak)
  const search = resolveSearchConfig(rawConfig.search, currency)
  const rules = resolvePriceRules(rawConfig.pricing, currency, peak.multiplier)
  const builtinRules = buildBuiltinRules(peak.multiplier)
  return { currency, rules, builtinRules, peak, search }
}

// --------------------------------------------------------------------------
// Peak classification and price resolution
// --------------------------------------------------------------------------

/**
 * Format the UTC view of a shifted timestamp as a local `YYYY-MM-DD` date.
 * @param {Date} date - timestamp already shifted into local time.
 * @returns {string} local calendar date.
 */
function localDateOf(date) {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Classify one event timestamp against a resolved peak policy.
 *
 * Local time is `eventTimeMs + utcOffsetMinutes * 60_000`; the weekday and the
 * `YYYY-MM-DD` date are read from that local time, never from the host time
 * zone. A configured holiday date is off-peak; otherwise the weekday must be
 * listed and the local minute-of-day must fall inside `[start, end)` of some
 * window. A disabled policy is always off-peak.
 * @param {number} eventTimeMs - event time, Unix epoch milliseconds.
 * @param {{ enabled: boolean, utcOffsetMinutes: number, weekdays: number[], windows: Array<[string, string]>, holidays: string[], multiplier: number }} peakPolicy - resolved policy.
 * @returns {boolean} `true` when the timestamp is billed at peak price.
 */
export function classifyPeak(eventTimeMs, peakPolicy) {
  if (!isPlainObject(peakPolicy) || peakPolicy.enabled !== true || !Number.isFinite(eventTimeMs)) return false
  const { utcOffsetMinutes, weekdays, windows, holidays } = peakPolicy
  if (!Number.isInteger(utcOffsetMinutes) || !Array.isArray(weekdays) || !Array.isArray(windows) || !Array.isArray(holidays)) {
    return false
  }
  const local = new Date(eventTimeMs + utcOffsetMinutes * 60_000)
  if (!Number.isFinite(local.getTime())) return false
  if (holidays.includes(localDateOf(local))) return false
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay()
  if (!weekdays.includes(weekday)) return false
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  for (const window of windows) {
    if (!Array.isArray(window) || window.length !== 2) continue
    if (typeof window[0] !== 'string' || typeof window[1] !== 'string') continue
    const start = minuteOfDay(window[0])
    const end = minuteOfDay(window[1])
    if (Number.isFinite(start) && Number.isFinite(end) && minute >= start && minute < end) return true
  }
  return false
}

/**
 * Find one price through the provider/model ladder
 * (`exact provider + exact model` → `exact provider + '*'` → `'*' + exact model`
 * → `'*' + '*'`), considering only rules of the configured currency.
 * @param {Array<Record<string, number|string>>} rules - candidate rules, in priority order.
 * @param {string} currency - currency that must equal the rule's currency.
 * @param {string} provider - exact provider route.
 * @param {string} model - exact model id.
 * @returns {Record<string, number|string>|undefined} the matching rule, if any.
 */
function matchPrice(rules, currency, provider, model) {
  const ladder = [
    [provider, model],
    [provider, '*'],
    ['*', model],
    ['*', '*'],
  ]
  for (const [candidateProvider, candidateModel] of ladder) {
    const rule = rules.find(candidate => candidate.currency === currency
      && candidate.provider === candidateProvider
      && candidate.model === candidateModel)
    if (rule !== undefined) return rule
  }
  return undefined
}

/**
 * Resolve the price of one exact Session route.
 *
 * User `pricing` rules win over the built-in tables; inside each set the ladder
 * is exact provider + exact model, exact provider + wildcard model, wildcard
 * provider + exact model, then two wildcards. Rules of another currency never
 * participate. Unknown models are unpriced: their tokens are counted but never
 * guessed into a cost.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - resolved config.
 * @param {string} provider - provider route of the Session event.
 * @param {string} model - model id of the Session event.
 * @returns {{ provider: string, model: string, currency: string, inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }|null} the matching price rule or `null`.
 */
export function resolvePrice(resolvedConfig, provider, model) {
  if (!isPlainObject(resolvedConfig) || typeof provider !== 'string' || typeof model !== 'string') return null
  const currency = resolvedConfig.currency
  const userRules = Array.isArray(resolvedConfig.rules) ? resolvedConfig.rules : []
  const builtinRules = Array.isArray(resolvedConfig.builtinRules) ? resolvedConfig.builtinRules : []
  return matchPrice(userRules, currency, provider, model)
    ?? matchPrice(builtinRules, currency, provider, model)
    ?? null
}

// --------------------------------------------------------------------------
// Fold helpers
// --------------------------------------------------------------------------

/** A fresh all-zero bucket object. */
function zeroBuckets() {
  return { ...ZERO_BUCKETS }
}

/**
 * Build the collision-free route key for one provider/model pair.
 * @param {string} provider - provider route.
 * @param {string} model - model id.
 * @returns {string} the route key stored in `state.routes`.
 */
function routeKeyOf(provider, model) {
  return `${provider}${ROUTE_KEY_SEPARATOR}${model}`
}

/**
 * Coerce one raw usage counter into a token count. Missing, non-finite, and
 * negative values count as 0; positive values are kept as reported.
 * @param {unknown} value - raw counter.
 * @returns {number} non-negative finite token count.
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Convert one provider `TokenUsage` record into state buckets. The buckets are
 * disjoint: `input` is cache-miss input only.
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage - provider usage record.
 * @returns {{ input: number, cacheRead: number, cacheWrite: number, output: number }} token buckets.
 */
function bucketsFromUsage(usage) {
  return {
    input: tokenCount(usage.inputTokens),
    cacheRead: tokenCount(usage.cacheReadTokens),
    cacheWrite: tokenCount(usage.cacheWriteTokens),
    output: tokenCount(usage.outputTokens),
  }
}

/**
 * Find the last usage sample embedded in a durable Assistant stream by scanning
 * backwards for a raw `chunk` record whose chunk is a `usage` chunk.
 * @param {unknown} stream - embedded `AssistantStreamRecord[]`.
 * @returns {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }|undefined} the usage record, if one was reported.
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (!isPlainObject(record) || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (!isPlainObject(chunk) || chunk.type !== 'usage') continue
    const usage = chunk.usage
    if (isPlainObject(usage)) return usage
  }
  return undefined
}

/**
 * Read a `{ provider, model }` route off a message source or a request header.
 * A route needs both ids; an empty or missing id is not resolvable and is
 * treated exactly like an absent source, so the fold can never store a route
 * that the state schema rejects.
 * @param {unknown} value - candidate source object.
 * @returns {{ provider: string, model: string }|undefined} the route, when both ids are non-empty strings.
 */
function routeOf(value) {
  if (!isPlainObject(value)) return undefined
  const { provider, model } = value
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Whether two bucket objects carry the same four counts.
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number }} left - one bucket object.
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number }} right - the other bucket object.
 * @returns {boolean} `true` when every bucket matches.
 */
function bucketsEqual(left, right) {
  return BUCKET_KEYS.every(key => left[key] === right[key])
}

/**
 * Subtract one replaced sample's buckets from a route/tier, flooring each
 * bucket at 0. Returns the same `routes` reference when nothing changes.
 * @param {Record<string, any>} routes - current route table.
 * @param {string} routeKey - route the replaced sample was billed to.
 * @param {'peak'|'offPeak'} tier - tier the replaced sample was billed at.
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number }} buckets - buckets to remove.
 * @returns {Record<string, any>} the updated route table.
 */
function subtractBuckets(routes, routeKey, tier, buckets) {
  const entry = routes[routeKey]
  if (entry === undefined) return routes
  const current = entry[tier]
  /** @type {Record<string, number>} */
  const next = { ...current }
  let changed = false
  for (const key of BUCKET_KEYS) {
    if (buckets[key] === 0) continue
    const value = Math.max(0, next[key] - buckets[key])
    if (value !== next[key]) {
      next[key] = value
      changed = true
    }
  }
  return changed ? { ...routes, [routeKey]: { ...entry, [tier]: next } } : routes
}

/**
 * Add one sample's buckets to a route/tier, creating the route entry when it is
 * new. Returns the same `routes` reference when every bucket is 0.
 * @param {Record<string, any>} routes - current route table.
 * @param {string} routeKey - route to bill.
 * @param {string} provider - provider route stored on a new entry.
 * @param {string} model - model id stored on a new entry.
 * @param {'peak'|'offPeak'} tier - tier to bill.
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number }} buckets - buckets to add.
 * @returns {Record<string, any>} the updated route table.
 */
function addBuckets(routes, routeKey, provider, model, tier, buckets) {
  if (BUCKET_KEYS.every(key => buckets[key] === 0)) return routes
  const entry = routes[routeKey] ?? { provider, model, peak: zeroBuckets(), offPeak: zeroBuckets() }
  /** @type {Record<string, number>} */
  const next = { ...entry[tier] }
  for (const key of BUCKET_KEYS) next[key] += buckets[key]
  return { ...routes, [routeKey]: { ...entry, [tier]: next } }
}

// --------------------------------------------------------------------------
// Search / fetch fold
// --------------------------------------------------------------------------

/**
 * Count the distinct non-blank queries of one `web_search` tool call. The tool
 * collapses exact duplicate queries before dispatching one provider request per
 * distinct query, so this count is that call's provider-request count.
 * @param {unknown} argumentsValue - raw `arguments` JSON string or parsed object.
 * @returns {number|null} distinct query count, or `null` when the payload is not a valid search call.
 */
function searchQueriesOf(argumentsValue) {
  let args = argumentsValue
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!isPlainObject(args) || !Array.isArray(args.queries)) return null
  const queries = new Set()
  for (const query of args.queries) {
    if (typeof query === 'string' && query.trim().length > 0) queries.add(query)
  }
  return queries.size === 0 ? null : queries.size
}

/**
 * Read the tool call id off one persisted `tool/result` message.
 * @param {Record<string, any>} message - the tool message.
 * @returns {string|undefined} the call id, when the message carries one.
 */
function resultCallId(message) {
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) return message.toolCallId
  const source = message.source
  if (isPlainObject(source) && typeof source.callId === 'string' && source.callId.length > 0) return source.callId
  return undefined
}

/**
 * Fold one `tool/call` event into the search / fetch counters. A search call
 * records one provider request per distinct query (the tool dispatches one per
 * query, and the current runtime logs no separate request event) under the call
 * id until the result arrives; a fetch call only records its call id (its
 * result meta carries the status).
 * @param {{ search: Record<string, any> }} state - current state.
 * @param {{ data?: any }} event - committed `tool/call` event.
 * @param {{ trackFetch: boolean }} searchPolicy - resolved search policy.
 * @returns {typeof state} the next state, or the same reference for other tools.
 */
function applySearchToolCall(state, event, searchPolicy) {
  const data = event.data
  if (!isPlainObject(data)) return state
  if (typeof data.callId !== 'string' || data.callId.length === 0) return state
  const search = state.search
  if (data.name === 'web_search') {
    const queries = searchQueriesOf(data.arguments)
    if (queries === null) return state
    return {
      ...state,
      search: {
        ...search,
        calls: search.calls + 1,
        requests: search.requests + queries,
        pending: { ...search.pending, [data.callId]: queries },
      },
    }
  }
  if (data.name === 'web_fetch' && searchPolicy.trackFetch === true) {
    return {
      ...state,
      search: {
        ...search,
        fetchCalls: search.fetchCalls + 1,
        pendingFetch: { ...search.pendingFetch, [data.callId]: 1 },
      },
    }
  }
  return state
}

/**
 * Fold one `tool/result` event that completes a tracked search or fetch call.
 *
 * A search result is billable only when the call succeeded with a non-empty
 * merged source list: the provider returns sources only when the Search API
 * returned results, and an empty source list is the tool's "No results found"
 * success. A fetch result is billable only with HTTP 200 and no tool error.
 * The pending entry is removed on the first result, so a compaction-pruner
 * replacement result for the same call is ignored.
 * @param {{ search: Record<string, any> }} state - current state.
 * @param {{ data?: any }} event - committed `tool/result` event.
 * @param {{ trackFetch: boolean }} searchPolicy - resolved search policy.
 * @returns {typeof state} the next state, or the same reference for other calls.
 */
function applySearchToolResult(state, event, searchPolicy) {
  const data = event.data
  if (!isPlainObject(data) || !isPlainObject(data.message)) return state
  const message = data.message
  const callId = resultCallId(message)
  if (callId === undefined) return state
  const search = state.search
  if (Object.hasOwn(search.pending, callId)) {
    const queries = search.pending[callId]
    const pending = { ...search.pending }
    delete pending[callId]
    const next = { ...search, pending }
    if (message.isError === true) {
      return { ...state, search: { ...next, failedCalls: next.failedCalls + 1 } }
    }
    const sources = isPlainObject(data.meta) && Array.isArray(data.meta.sources) ? data.meta.sources : null
    if (sources === null) return { ...state, search: { ...next, failedCalls: next.failedCalls + 1 } }
    if (sources.length === 0) return { ...state, search: { ...next, emptyCalls: next.emptyCalls + 1 } }
    return { ...state, search: { ...next, billable: next.billable + queries } }
  }
  if (searchPolicy.trackFetch === true && Object.hasOwn(search.pendingFetch, callId)) {
    const pendingFetch = { ...search.pendingFetch }
    delete pendingFetch[callId]
    const meta = isPlainObject(data.meta) ? data.meta : null
    const billable = message.isError !== true && meta !== null && meta.statusCode === 200
    return {
      ...state,
      search: {
        ...search,
        pendingFetch,
        fetchBillable: search.fetchBillable + (billable ? 1 : 0),
      },
    }
  }
  return state
}

// --------------------------------------------------------------------------
// Fold transitions
// --------------------------------------------------------------------------

/**
 * Fold one `request/header` event: remember the latest requested route.
 * @param {{ routes: Record<string, any>, current: { provider: string, model: string }|null, last: any }} state - current state.
 * @param {{ data?: { header?: { config?: unknown } } }} event - committed event.
 * @returns {typeof state} the next state.
 */
function applyRequestHeader(state, event) {
  const route = routeOf(event.data?.header?.config)
  if (route === undefined) return state
  if (state.current !== null && state.current.provider === route.provider && state.current.model === route.model) {
    return state
  }
  return { ...state, current: route }
}

/**
 * Fold one `llm/retry-started` event: close the replacement scope, so the
 * retried attempt bills in addition to the previous one.
 * @param {{ routes: Record<string, any>, current: { provider: string, model: string }|null, last: any }} state - current state.
 * @param {{ data?: { turn?: number, step?: number } }} event - committed event.
 * @returns {typeof state} the next state.
 */
function applyRetryStarted(state, event) {
  if (state.last === null) return state
  return state.last.turn === event.data?.turn && state.last.step === event.data?.step
    ? { ...state, last: null }
    : state
}

/**
 * Fold one usage-bearing event (`assistant/message` or `assistant/attempt`)
 * into the route table.
 *
 * A sample replaces the previous sample of the same turn/step: the previous
 * buckets are subtracted from their route/tier and the new buckets are added,
 * so an in-attempt streaming sample followed by the final message sample counts
 * once. `llm/retry-started` clears the replacement slot instead. A sample with
 * no usage or no resolvable route leaves the state untouched.
 * @param {{ routes: Record<string, any>, current: { provider: string, model: string }|null, last: any }} state - current state.
 * @param {{ type: 'assistant/message'|'assistant/attempt', time?: number, data?: any }} event - committed event.
 * @param {{ enabled: boolean, utcOffsetMinutes: number, weekdays: number[], windows: Array<[string, string]>, holidays: string[], multiplier: number }} peakPolicy - resolved peak policy.
 * @returns {typeof state} the next state.
 */
function applyUsage(state, event, peakPolicy) {
  const data = event.data
  if (!isPlainObject(data)) return state
  if (!Number.isFinite(data.turn) || !Number.isFinite(data.step)) return state
  const usage = event.type === 'assistant/message' && isPlainObject(data.usage)
    ? data.usage
    : streamUsage(data.stream)
  if (usage === undefined) return state
  const route = event.type === 'assistant/message'
    ? routeOf(data.message?.source) ?? state.current
    : state.current
  if (route === null || route === undefined) return state
  const routeKey = routeKeyOf(route.provider, route.model)
  const tier = classifyPeak(event.time, peakPolicy) ? 'peak' : 'offPeak'
  const buckets = bucketsFromUsage(usage)
  const previous = state.last !== null
    && state.last.turn === data.turn
    && state.last.step === data.step
    ? state.last
    : null
  // The same sample delivered again (the attempt chunk, then the final
  // message) must not churn the state reference.
  if (previous !== null
    && previous.routeKey === routeKey
    && previous.tier === tier
    && bucketsEqual(previous.buckets, buckets)) {
    return state
  }
  let routes = state.routes
  if (previous !== null) routes = subtractBuckets(routes, previous.routeKey, previous.tier, previous.buckets)
  routes = addBuckets(routes, routeKey, route.provider, route.model, tier, buckets)
  return {
    routes,
    current: state.current,
    last: { turn: data.turn, step: data.step, routeKey, tier, buckets },
    search: state.search,
  }
}

/**
 * The projection fold: the one transition from committed event to state.
 * @param {{ routes: Record<string, any>, current: { provider: string, model: string }|null, last: any, search: Record<string, any> }} state - state covering all prior events.
 * @param {any} event - the next committed Session event.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - resolved config.
 * @returns {typeof state} the next state; the same reference when the event is not this unit's.
 */
function applyEvent(state, event, resolvedConfig) {
  if (!isPlainObject(event) || typeof event.type !== 'string') return state
  if (event.type === 'request/header') return applyRequestHeader(state, event)
  if (event.type === 'llm/retry-started') return applyRetryStarted(state, event)
  const searchPolicy = resolvedConfig.search
  if (searchPolicy !== undefined && searchPolicy.enabled === true) {
    if (event.type === 'tool/call') return applySearchToolCall(state, event, searchPolicy)
    if (event.type === 'tool/result') return applySearchToolResult(state, event, searchPolicy)
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  return applyUsage(state, event, resolvedConfig.peak)
}

// --------------------------------------------------------------------------
// Wire view
// --------------------------------------------------------------------------

/**
 * Compare two strings by code unit, independent of the host locale.
 * @param {string} left - one string.
 * @param {string} right - the other string.
 * @returns {number} negative, 0, or positive for sort ordering.
 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Deterministic route order: cost descending, then total tokens descending,
 * then provider, then model.
 * @param {Record<string, any>} left - one route view.
 * @param {Record<string, any>} right - the other route view.
 * @returns {number} comparator result.
 */
function compareViewRoutes(left, right) {
  if (left.cost !== right.cost) return right.cost - left.cost
  if (left.total !== right.total) return right.total - left.total
  const providerOrder = compareText(left.provider, right.provider)
  return providerOrder !== 0 ? providerOrder : compareText(left.model, right.model)
}

/**
 * Build the wire view of one state route, including its estimated cost.
 * @param {{ provider: string, model: string, peak: Record<string, number>, offPeak: Record<string, number> }} entry - one state route entry.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - resolved config.
 * @returns {Record<string, any>} one `routes[]` wire entry.
 */
function viewRoute(entry, resolvedConfig) {
  const peak = { ...entry.peak }
  const offPeak = { ...entry.offPeak }
  const input = peak.input + offPeak.input
  const cacheRead = peak.cacheRead + offPeak.cacheRead
  const cacheWrite = peak.cacheWrite + offPeak.cacheWrite
  const output = peak.output + offPeak.output
  let cost = 0
  let costPeak = 0
  let costOffPeak = 0
  /** @type {null | { inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }} */
  let pricing = null
  const price = resolvePrice(resolvedConfig, entry.provider, entry.model)
  if (price !== null) {
    costOffPeak = (offPeak.input * price.inputPerM
      + offPeak.cacheRead * price.cacheReadPerM
      + offPeak.cacheWrite * price.cacheWritePerM
      + offPeak.output * price.outputPerM) / 1_000_000
    costPeak = (peak.input * price.inputPerM
      + peak.cacheRead * price.cacheReadPerM
      + peak.cacheWrite * price.cacheWritePerM
      + peak.output * price.outputPerM) / 1_000_000 * price.peakMultiplier
    cost = costOffPeak + costPeak
    pricing = {
      inputPerM: price.inputPerM,
      cacheReadPerM: price.cacheReadPerM,
      cacheWritePerM: price.cacheWritePerM,
      outputPerM: price.outputPerM,
      peakMultiplier: price.peakMultiplier,
    }
  }
  return {
    provider: entry.provider,
    model: entry.model,
    input,
    cacheRead,
    cacheWrite,
    output,
    total: input + cacheRead + cacheWrite + output,
    peak: { input: peak.input, cacheRead: peak.cacheRead, cacheWrite: peak.cacheWrite, output: peak.output },
    offPeak: { input: offPeak.input, cacheRead: offPeak.cacheRead, cacheWrite: offPeak.cacheWrite, output: offPeak.output },
    cost,
    costPeak,
    costOffPeak,
    priced: price !== null,
    pricing,
  }
}

/**
 * Coerce one persisted search counter into a non-negative integer. Missing,
 * non-finite, and negative values count as 0.
 * @param {unknown} value - raw counter.
 * @returns {number} the counter value.
 */
function counterValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Build the wire view of the search / fetch cost section. Counts are always
 * present; costs are estimates from the resolved per-request price. The search
 * cost is the post-free-window estimate (the client decides how to label it
 * while `searchFreeUntil` is still in the future), while the fetch cost is the
 * direct Fetch API spend, which is billable from launch.
 * @param {{ search?: Record<string, any> }} state - fold state.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - resolved config.
 * @returns {Record<string, any>} the `search` wire section.
 */
function searchView(state, resolvedConfig) {
  const policy = resolvedConfig.search
  const search = isPlainObject(state) && isPlainObject(state.search) ? state.search : {}
  const trackFetch = policy.trackFetch === true
  const calls = counterValue(search.calls)
  const requests = counterValue(search.requests)
  const billable = counterValue(search.billable)
  const fetchCalls = trackFetch ? counterValue(search.fetchCalls) : 0
  const fetchBillable = trackFetch ? counterValue(search.fetchBillable) : 0
  const searchCost = billable * policy.perRequest
  const fetchCost = fetchBillable * policy.perRequest
  return {
    enabled: policy.enabled === true,
    perRequest: policy.perRequest,
    searchFreeUntil: policy.searchFreeUntil,
    calls,
    requests,
    billable,
    emptyCalls: counterValue(search.emptyCalls),
    failedCalls: counterValue(search.failedCalls),
    fetchCalls,
    fetchBillable,
    searchCost,
    fetchCost,
    totalCost: searchCost + fetchCost,
  }
}

/**
 * Project one fold state to the client wire view.
 *
 * Pure: it reads the state and the resolved config and returns a fresh plain
 * object. Only routes with at least one token are listed; unpriced routes keep
 * their tokens in `totals` but carry `priced: false`, `pricing: null`, and zero
 * cost fields. Costs are raw floats in the configured currency.
 * @param {{ routes: Record<string, { provider: string, model: string, peak: Record<string, number>, offPeak: Record<string, number> }>, search?: Record<string, any> }} state - fold state.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - resolved config.
 * @returns {{ version: 1, currency: string, routes: Array<Record<string, any>>, totals: Record<string, number>, search: Record<string, any> }} the wire view.
 */
export function billingView(state, resolvedConfig) {
  const currency = isPlainObject(resolvedConfig) ? resolvedConfig.currency : DEFAULT_CURRENCY
  const sourceRoutes = isPlainObject(state) && isPlainObject(state.routes) ? state.routes : {}
  /** @type {Array<Record<string, any>>} */
  const routes = []
  for (const entry of Object.values(sourceRoutes)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.peak) || !isPlainObject(entry.offPeak)) continue
    const total = BUCKET_KEYS.reduce((sum, key) => sum + entry.peak[key] + entry.offPeak[key], 0)
    if (!(total > 0)) continue
    routes.push(viewRoute(entry, resolvedConfig))
  }
  routes.sort(compareViewRoutes)
  /** @type {Record<string, number>} */
  const totals = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
    cost: 0,
    costPeak: 0,
    costOffPeak: 0,
    pricedRoutes: 0,
    unpricedRoutes: 0,
  }
  for (const route of routes) {
    totals.input += route.input
    totals.cacheRead += route.cacheRead
    totals.cacheWrite += route.cacheWrite
    totals.output += route.output
    totals.total += route.total
    totals.cost += route.cost
    totals.costPeak += route.costPeak
    totals.costOffPeak += route.costOffPeak
    if (route.priced) totals.pricedRoutes += 1
    else totals.unpricedRoutes += 1
  }
  return { version: 1, currency, routes, totals, search: searchView(state, resolvedConfig) }
}

// --------------------------------------------------------------------------
// Structural schemas
// --------------------------------------------------------------------------

/**
 * Build a tiny frozen structural schema with the two methods the projection
 * registry uses. No third-party schema library: the Host half must install
 * with zero dependencies.
 * @param {string} label - value label used in the error message.
 * @param {(value: unknown) => string|null} validate - returns `null` or one issue description.
 * @returns {{ parse: (value: unknown) => unknown, safeParse: (value: unknown) => { success: boolean, data?: unknown, error?: TypeError } }} the schema object.
 */
function structuralSchema(label, validate) {
  const parse = (value) => {
    const issue = validate(value)
    if (issue !== null) throw new TypeError(`billing-card: invalid ${label}: ${issue}`)
    return value
  }
  const safeParse = (value) => {
    const issue = validate(value)
    if (issue !== null) return { success: false, error: new TypeError(`billing-card: invalid ${label}: ${issue}`) }
    return { success: true, data: value }
  }
  return Object.freeze({ parse, safeParse })
}

/**
 * Describe why a value is not a valid finite non-negative number.
 * @param {unknown} value - candidate number.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function numberIssue(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${path} must be a finite non-negative number`
  }
  return null
}

/**
 * Describe why a value is not a valid non-negative integer.
 * @param {unknown} value - candidate integer.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function integerIssue(value, path) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) return `${path} must be a non-negative integer`
  return null
}

/**
 * Describe why a value is not a valid token bucket object.
 * @param {unknown} value - candidate bucket object.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function bucketIssue(value, path) {
  if (!isPlainObject(value)) return `${path} must be a plain object`
  if (!hasExactKeys(value, BUCKET_KEYS)) return `${path} must carry exactly ${BUCKET_KEYS.join(', ')}`
  for (const key of BUCKET_KEYS) {
    const issue = numberIssue(value[key], `${path}.${key}`)
    if (issue !== null) return issue
  }
  return null
}

/**
 * Describe why a value is not a valid route entry of the fold state.
 * @param {unknown} value - candidate route entry.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function stateRouteIssue(value, path) {
  if (!isPlainObject(value)) return `${path} must be a plain object`
  if (!hasExactKeys(value, ['provider', 'model', 'peak', 'offPeak'])) {
    return `${path} must carry exactly provider, model, peak, and offPeak`
  }
  if (typeof value.provider !== 'string' || value.provider.length === 0) return `${path}.provider must be a non-empty string`
  if (typeof value.model !== 'string' || value.model.length === 0) return `${path}.model must be a non-empty string`
  return bucketIssue(value.peak, `${path}.peak`) ?? bucketIssue(value.offPeak, `${path}.offPeak`)
}

/**
 * Describe why a value is not a valid `state.current` route.
 * @param {unknown} value - candidate current route.
 * @returns {string|null} the issue, if any.
 */
function currentRouteIssue(value) {
  if (value === null) return null
  if (!isPlainObject(value)) return 'state.current must be null or a plain object'
  if (!hasExactKeys(value, ['provider', 'model'])) return 'state.current must carry exactly provider and model'
  if (typeof value.provider !== 'string' || value.provider.length === 0) return 'state.current.provider must be a non-empty string'
  if (typeof value.model !== 'string' || value.model.length === 0) return 'state.current.model must be a non-empty string'
  return null
}

/**
 * Describe why a value is not a valid `state.last` replacement slot.
 * @param {unknown} value - candidate last slot.
 * @returns {string|null} the issue, if any.
 */
function lastSampleIssue(value) {
  if (value === null) return null
  if (!isPlainObject(value)) return 'state.last must be null or a plain object'
  if (!hasExactKeys(value, ['turn', 'step', 'routeKey', 'tier', 'buckets'])) {
    return 'state.last must carry exactly turn, step, routeKey, tier, and buckets'
  }
  const turnIssue = integerIssue(value.turn, 'state.last.turn')
  if (turnIssue !== null) return turnIssue
  const stepIssue = integerIssue(value.step, 'state.last.step')
  if (stepIssue !== null) return stepIssue
  if (typeof value.routeKey !== 'string' || value.routeKey.length === 0) return 'state.last.routeKey must be a non-empty string'
  if (value.tier !== 'peak' && value.tier !== 'offPeak') return "state.last.tier must be 'peak' or 'offPeak'"
  return bucketIssue(value.buckets, 'state.last.buckets')
}

/**
 * Describe why a value is not a valid `state.search` pending map.
 * @param {unknown} value - candidate pending map.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function searchPendingIssue(value, path) {
  if (!isPlainObject(value)) return `${path} must be a plain object`
  for (const [callId, entry] of Object.entries(value)) {
    if (callId.length === 0) return `${path} keys must be non-empty call ids`
    const issue = integerIssue(entry, `${path}[${JSON.stringify(callId)}]`)
    if (issue !== null) return issue
  }
  return null
}

/**
 * Describe why a value is not a valid `state.search` counter block.
 * @param {unknown} value - candidate search state.
 * @returns {string|null} the issue, if any.
 */
function searchStateIssue(value) {
  if (!isPlainObject(value)) return 'state.search must be a plain object'
  const fields = [
    'calls',
    'requests',
    'billable',
    'emptyCalls',
    'failedCalls',
    'fetchCalls',
    'fetchBillable',
    'pending',
    'pendingFetch',
  ]
  if (!hasExactKeys(value, fields)) return `state.search must carry exactly ${fields.join(', ')}`
  for (const field of fields) {
    if (field === 'pending' || field === 'pendingFetch') continue
    const issue = integerIssue(value[field], `state.search.${field}`)
    if (issue !== null) return issue
  }
  return searchPendingIssue(value.pending, 'state.search.pending')
    ?? searchPendingIssue(value.pendingFetch, 'state.search.pendingFetch')
}

/**
 * Describe why a value is not a valid `billingUsage` fold state. Used by
 * `stateSchema` before a persisted checkpoint seeds a fold.
 * @param {unknown} value - candidate state.
 * @returns {string|null} the issue, if any.
 */
function stateIssue(value) {
  if (!isPlainObject(value)) return 'state must be a plain object'
  if (!hasExactKeys(value, ['routes', 'current', 'last', 'search'])) return 'state must carry exactly routes, current, last, and search'
  if (!isPlainObject(value.routes)) return 'state.routes must be a plain object'
  for (const [routeKey, route] of Object.entries(value.routes)) {
    const issue = stateRouteIssue(route, `state.routes[${JSON.stringify(routeKey)}]`)
    if (issue !== null) return issue
  }
  return currentRouteIssue(value.current) ?? lastSampleIssue(value.last) ?? searchStateIssue(value.search)
}

/**
 * Describe why a value is not a valid route pricing record on the wire.
 * @param {unknown} value - candidate pricing record.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function pricingIssue(value, path) {
  if (value === null) return null
  if (!isPlainObject(value)) return `${path} must be null or a plain object`
  const fields = ['inputPerM', 'cacheReadPerM', 'cacheWritePerM', 'outputPerM', 'peakMultiplier']
  if (!hasExactKeys(value, fields)) return `${path} must carry exactly ${fields.join(', ')}`
  for (const field of fields) {
    const issue = numberIssue(value[field], `${path}.${field}`)
    if (issue !== null) return issue
  }
  return null
}

/**
 * Describe why a value is not a valid `routes[]` entry of the wire view.
 * @param {unknown} value - candidate route view.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function viewRouteIssue(value, path) {
  if (!isPlainObject(value)) return `${path} must be a plain object`
  const fields = [
    'provider',
    'model',
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'total',
    'peak',
    'offPeak',
    'cost',
    'costPeak',
    'costOffPeak',
    'priced',
    'pricing',
  ]
  if (!hasExactKeys(value, fields)) return `${path} must carry exactly ${fields.join(', ')}`
  if (typeof value.provider !== 'string' || value.provider.length === 0) return `${path}.provider must be a non-empty string`
  if (typeof value.model !== 'string' || value.model.length === 0) return `${path}.model must be a non-empty string`
  for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'cost', 'costPeak', 'costOffPeak']) {
    const issue = numberIssue(value[field], `${path}.${field}`)
    if (issue !== null) return issue
  }
  const peakIssue = bucketIssue(value.peak, `${path}.peak`)
  if (peakIssue !== null) return peakIssue
  const offPeakIssue = bucketIssue(value.offPeak, `${path}.offPeak`)
  if (offPeakIssue !== null) return offPeakIssue
  if (typeof value.priced !== 'boolean') return `${path}.priced must be a boolean`
  return pricingIssue(value.pricing, `${path}.pricing`)
}

/**
 * Describe why a value is not a valid `totals` object of the wire view.
 * @param {unknown} value - candidate totals object.
 * @param {string} path - field path for the issue description.
 * @returns {string|null} the issue, if any.
 */
function totalsIssue(value, path) {
  if (!isPlainObject(value)) return `${path} must be a plain object`
  const fields = [
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'total',
    'cost',
    'costPeak',
    'costOffPeak',
    'pricedRoutes',
    'unpricedRoutes',
  ]
  if (!hasExactKeys(value, fields)) return `${path} must carry exactly ${fields.join(', ')}`
  for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'cost', 'costPeak', 'costOffPeak']) {
    const issue = numberIssue(value[field], `${path}.${field}`)
    if (issue !== null) return issue
  }
  const pricedIssue = integerIssue(value.pricedRoutes, `${path}.pricedRoutes`)
  if (pricedIssue !== null) return pricedIssue
  return integerIssue(value.unpricedRoutes, `${path}.unpricedRoutes`)
}

/**
 * Describe why a value is not a valid `search` section of the wire view.
 * @param {unknown} value - candidate search section.
 * @returns {string|null} the issue, if any.
 */
function searchViewIssue(value) {
  if (!isPlainObject(value)) return 'view.search must be a plain object'
  const fields = [
    'enabled',
    'perRequest',
    'searchFreeUntil',
    'calls',
    'requests',
    'billable',
    'emptyCalls',
    'failedCalls',
    'fetchCalls',
    'fetchBillable',
    'searchCost',
    'fetchCost',
    'totalCost',
  ]
  if (!hasExactKeys(value, fields)) return `view.search must carry exactly ${fields.join(', ')}`
  if (typeof value.enabled !== 'boolean') return 'view.search.enabled must be a boolean'
  const perRequestIssue = numberIssue(value.perRequest, 'view.search.perRequest')
  if (perRequestIssue !== null) return perRequestIssue
  if (value.searchFreeUntil !== null) {
    const issue = numberIssue(value.searchFreeUntil, 'view.search.searchFreeUntil')
    if (issue !== null) return issue
  }
  for (const field of ['calls', 'requests', 'billable', 'emptyCalls', 'failedCalls', 'fetchCalls', 'fetchBillable']) {
    const issue = integerIssue(value[field], `view.search.${field}`)
    if (issue !== null) return issue
  }
  for (const field of ['searchCost', 'fetchCost', 'totalCost']) {
    const issue = numberIssue(value[field], `view.search.${field}`)
    if (issue !== null) return issue
  }
  return null
}

/**
 * Describe why a value is not a valid wire view for this projection.
 * @param {unknown} value - candidate view.
 * @returns {string|null} the issue, if any.
 */
function viewIssue(value) {
  if (!isPlainObject(value)) return 'view must be a plain object'
  if (!hasExactKeys(value, ['version', 'currency', 'routes', 'totals', 'search'])) {
    return 'view must carry exactly version, currency, routes, totals, and search'
  }
  if (value.version !== 1) return 'view.version must be 1'
  if (!CURRENCIES.includes(/** @type {string} */ (value.currency))) return "view.currency must be 'CNY' or 'USD'"
  if (!Array.isArray(value.routes)) return 'view.routes must be an array'
  for (let index = 0; index < value.routes.length; index += 1) {
    const issue = viewRouteIssue(value.routes[index], `view.routes[${index}]`)
    if (issue !== null) return issue
  }
  return totalsIssue(value.totals, 'view.totals') ?? searchViewIssue(value.search)
}

/** Validates one persisted `billingUsage` fold state. */
const stateSchema = structuralSchema('billingUsage state', stateIssue)

/** Validates the client wire view before it leaves the Host. */
const viewSchema = structuralSchema('billingUsage view', viewIssue)

// --------------------------------------------------------------------------
// Projection definition
// --------------------------------------------------------------------------

/**
 * Build the `billingUsage` projection definition for one resolved config.
 *
 * The returned unit is the whole Host half of the plugin: the registry folds
 * every committed Session event through `apply`, validates restored checkpoint
 * state with `stateSchema`, and publishes `wire.view` (validated by
 * `viewSchema`) as the client value. `view` caches its result for one state
 * reference, so an unchanged state keeps the same published value.
 * @param {ReturnType<typeof resolveBillingConfig>} resolvedConfig - validated config.
 * @returns {{ key: string, stateVersion: number, stateSchema: { parse: Function, safeParse: Function }, init: () => object, apply: (state: object, event: unknown) => object, wire: { viewSchema: { parse: Function, safeParse: Function }, view: (state: object) => object } }} the projection definition.
 */
export function createBillingProjection(resolvedConfig) {
  let cachedState
  let cachedView
  const view = (state) => {
    if (state === cachedState) return cachedView
    cachedView = billingView(state, resolvedConfig)
    cachedState = state
    return cachedView
  }
  return {
    key: BILLING_PROJECTION_KEY,
    stateVersion: 2,
    stateSchema,
    init: () => ({
      routes: {},
      current: null,
      last: null,
      search: { ...ZERO_SEARCH_COUNTERS, pending: {}, pendingFetch: {} },
    }),
    apply: (state, event) => applyEvent(state, event, resolvedConfig),
    wire: { viewSchema, view },
  }
}
