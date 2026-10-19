/**
 * Behavior tests for the Billing Card Host half.
 *
 * These import the real `billing-core.js` and `index.js` modules: the fold, the
 * config validator, the price resolver, the peak classifier, the wire view, the
 * structural schemas, and the plugin registration are executed, not
 * pattern-matched. Every timestamp is a fixed epoch value — no `Date.now()` and
 * no host-time-zone reads — so the suite is deterministic everywhere.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BILLING_PROJECTION_KEY,
  DEFAULT_CURRENCY,
  billingView,
  classifyPeak,
  createBillingProjection,
  resolveBillingConfig,
  resolvePrice,
} from '../billing-core.js'
import * as pluginModule from '../index.js'

// --------------------------------------------------------------------------
// Fixed fixtures and event builders
// --------------------------------------------------------------------------

/** Beijing is UTC+8; every fixture below is expressed as a Beijing wall clock. */
const BEIJING_OFFSET_MS = 480 * 60_000

/**
 * Epoch milliseconds of one Beijing wall-clock instant.
 * @param {number} year - full year.
 * @param {number} month - 1-based month.
 * @param {number} day - day of month.
 * @param {number} hour - local hour.
 * @param {number} [minute] - local minute.
 * @returns {number} Unix epoch milliseconds.
 */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

/** Monday 2026-10-19 08:00 Beijing: inside no peak window. */
const OFF_PEAK_TIME = beijing(2026, 10, 19, 8, 0)

/** Monday 2026-10-19 10:00 Beijing: inside the first peak window. */
const PEAK_TIME = beijing(2026, 10, 19, 10, 0)

/** One model-sourced assistant message route. */
const FLASH_SOURCE = Object.freeze({ kind: 'model', provider: 'deepseek', model: 'deepseek-flash' })

/** One model-sourced assistant message route on the Pro model. */
const PRO_SOURCE = Object.freeze({ kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' })

/** The zero bucket object, for fixture slicing. */
const ZERO_BUCKETS = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** Sequence counter for realistic event envelopes; the fold never reads `seq`. */
let nextSeq = 0

/**
 * Build one committed Session event envelope.
 * @param {string} type - event type.
 * @param {unknown} data - event payload.
 * @param {number} time - event time, epoch milliseconds.
 * @returns {{ type: string, seq: number, time: number, data: unknown }} the envelope.
 */
function event(type, data, time) {
  nextSeq += 1
  return { type, seq: nextSeq, time, data }
}

/**
 * Build a `request/header` event carrying one provider/model route.
 * @param {string} provider - route provider.
 * @param {string} model - route model id.
 * @param {number} [time] - event time.
 * @returns {object} the event envelope.
 */
function requestHeaderEvent(provider, model, time = OFF_PEAK_TIME) {
  return event('request/header', { header: { config: { provider, model } }, reason: 'initial' }, time)
}

/**
 * Build the durable stream records for one usage chunk.
 * @param {object} usage - raw provider usage.
 * @returns {Array<object>} one raw `chunk` stream record.
 */
function usageStream(usage) {
  return [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }]
}

/**
 * Build an `assistant/message` event. `stream` defaults to a usage chunk when
 * `usage` is given; pass `stream` explicitly to test the fallback path.
 * @param {{ turn: number, step: number, usage?: object, source?: object, stream?: Array<object>, time?: number }} fields - event payload fields.
 * @returns {object} the event envelope.
 */
function assistantMessageEvent({ turn, step, usage, source, stream, time = OFF_PEAK_TIME }) {
  const data = {
    turn,
    step,
    message: { role: 'assistant', content: [], ...(source === undefined ? {} : { source }) },
    stream: stream ?? (usage === undefined ? [] : usageStream(usage)),
  }
  if (usage !== undefined) data.usage = usage
  return event('assistant/message', data, time)
}

/**
 * Build an `assistant/attempt` event carrying one stream usage chunk.
 * @param {{ turn: number, step: number, usage?: object, stream?: Array<object>, time?: number }} fields - event payload fields.
 * @returns {object} the event envelope.
 */
function assistantAttemptEvent({ turn, step, usage, stream, time = OFF_PEAK_TIME }) {
  return event('assistant/attempt', { turn, step, stream: stream ?? usageStream(usage) }, time)
}

/**
 * Build an `llm/retry-started` event for one turn/step.
 * @param {number} turn - retried turn.
 * @param {number} step - retried step.
 * @param {number} [time] - event time.
 * @returns {object} the event envelope.
 */
function retryStartedEvent(turn, step, time = OFF_PEAK_TIME) {
  return event('llm/retry-started', { retryId: 'retry-1', turn, step, retry: 1 }, time)
}

/**
 * Build one `tool/call` event.
 * @param {string} name - tool name.
 * @param {unknown} args - parsed arguments object (the log stores JSON text).
 * @param {string} callId - tool call id.
 * @param {number} [time] - event time.
 * @returns {object} the event envelope.
 */
function toolCallEvent(name, args, callId, time = OFF_PEAK_TIME) {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, time)
}

/**
 * Build one `tool/result` event.
 * @param {string} callId - tool call id.
 * @param {boolean} isError - whether the tool failed.
 * @param {unknown} [meta] - persisted result metadata.
 * @param {number} [time] - event time.
 * @returns {object} the event envelope.
 */
function toolResultEvent(callId, isError = false, meta, time = OFF_PEAK_TIME) {
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [],
      isError,
    },
  }
  if (meta !== undefined) data.meta = meta
  return event('tool/result', data, time)
}

/**
 * Fold events through one projection.
 * @param {object} projection - projection definition.
 * @param {Array<object>} events - committed events.
 * @param {object} [state] - starting state, defaults to `init()`.
 * @returns {object} the final state.
 */
function fold(projection, events, state = projection.init()) {
  return events.reduce((current, item) => projection.apply(current, item), state)
}

/**
 * Project one event list with a fresh projection built from `config`.
 * @param {object} config - resolved config.
 * @param {Array<object>} events - committed events.
 * @returns {object} the wire view.
 */
function buildView(config, events) {
  const projection = createBillingProjection(config)
  return projection.wire.view(fold(projection, events))
}

/**
 * Reduce one normalized rule to the five price fields the wire carries.
 * @param {object} rule - normalized price rule.
 * @returns {{ inputPerM: number, cacheReadPerM: number, cacheWritePerM: number, outputPerM: number, peakMultiplier: number }} price fields.
 */
function priceFieldsOf(rule) {
  return {
    inputPerM: rule.inputPerM,
    cacheReadPerM: rule.cacheReadPerM,
    cacheWritePerM: rule.cacheWritePerM,
    outputPerM: rule.outputPerM,
    peakMultiplier: rule.peakMultiplier,
  }
}

/**
 * Assert that one raw config is rejected with a message naming the config path.
 * @param {unknown} rawConfig - invalid raw config.
 * @param {RegExp} pattern - expected path/failure fragment.
 */
function rejectsConfig(rawConfig, pattern) {
  assert.throws(
    () => resolveBillingConfig(rawConfig),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, pattern)
      assert.ok(error.message.startsWith('billing-card: '), `expected the billing-card prefix, got: ${error.message}`)
      return true
    },
  )
}

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

describe('resolveBillingConfig', () => {
  it('defaults to CNY with the China peak policy and the pinned DeepSeek tables', () => {
    const config = resolveBillingConfig()
    assert.equal(DEFAULT_CURRENCY, 'CNY')
    assert.equal(config.currency, 'CNY')
    assert.deepEqual(config.peak, {
      enabled: true,
      utcOffsetMinutes: 480,
      weekdays: [1, 2, 3, 4, 5],
      windows: [['09:00', '12:00'], ['14:00', '18:00']],
      holidays: [],
      multiplier: 2,
    })
    assert.deepEqual(config.rules, [])
    assert.equal(config.builtinRules.length, 8)

    const find = (currency, model) => config.builtinRules.find(rule => rule.currency === currency && rule.model === model)
    for (const rule of config.builtinRules) {
      assert.equal(rule.provider, '*')
      assert.equal(rule.peakMultiplier, 2)
    }
    // CNY table, per 1M tokens, off-peak base.
    assert.deepEqual(priceFieldsOf(find('CNY', 'deepseek-flash')), {
      inputPerM: 1,
      cacheReadPerM: 0.02,
      cacheWritePerM: 0,
      outputPerM: 4,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('CNY', 'deepseek-v4-pro')), {
      inputPerM: 4.5,
      cacheReadPerM: 0.15,
      cacheWritePerM: 0,
      outputPerM: 13.5,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('CNY', 'deepseek-v4-flash')), {
      inputPerM: 1,
      cacheReadPerM: 0.02,
      cacheWritePerM: 0,
      outputPerM: 4,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('CNY', 'deepseek-v4-flash-vision-exp')), {
      inputPerM: 1,
      cacheReadPerM: 0.02,
      cacheWritePerM: 0,
      outputPerM: 4,
      peakMultiplier: 2,
    })
    // USD table, per 1M tokens, off-peak base.
    assert.deepEqual(priceFieldsOf(find('USD', 'deepseek-flash')), {
      inputPerM: 0.15,
      cacheReadPerM: 0.003,
      cacheWritePerM: 0,
      outputPerM: 0.6,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('USD', 'deepseek-v4-pro')), {
      inputPerM: 0.66,
      cacheReadPerM: 0.022,
      cacheWritePerM: 0,
      outputPerM: 1.98,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('USD', 'deepseek-v4-flash')), {
      inputPerM: 0.15,
      cacheReadPerM: 0.003,
      cacheWritePerM: 0,
      outputPerM: 0.6,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(find('USD', 'deepseek-v4-flash-vision-exp')), {
      inputPerM: 0.15,
      cacheReadPerM: 0.003,
      cacheWritePerM: 0,
      outputPerM: 0.6,
      peakMultiplier: 2,
    })
  })

  it('normalizes explicit pricing rules and peak overrides', () => {
    const config = resolveBillingConfig({
      currency: 'USD',
      pricing: [
        {
          provider: 'openrouter',
          model: 'glm/glm-5.3',
          currency: 'USD',
          inputPerM: 0.5,
          cacheReadPerM: 0.05,
          cacheWritePerM: 0.1,
          outputPerM: 2,
          peakMultiplier: 1.5,
        },
        { model: 'deepseek-flash', inputPerM: 9, cacheReadPerM: 1, outputPerM: 9 },
      ],
      peak: {
        enabled: false,
        utcOffsetMinutes: 0,
        weekdays: [6, 7],
        windows: [['10:00', '11:30']],
        holidays: ['2026-10-19'],
        multiplier: 3,
      },
    })
    assert.equal(config.currency, 'USD')
    assert.deepEqual(config.peak, {
      enabled: false,
      utcOffsetMinutes: 0,
      weekdays: [6, 7],
      windows: [['10:00', '11:30']],
      holidays: ['2026-10-19'],
      multiplier: 3,
    })
    assert.deepEqual(config.rules[0], {
      provider: 'openrouter',
      model: 'glm/glm-5.3',
      currency: 'USD',
      inputPerM: 0.5,
      cacheReadPerM: 0.05,
      cacheWritePerM: 0.1,
      outputPerM: 2,
      peakMultiplier: 1.5,
    })
    // Defaults on an omitted rule field: provider '*', currency from config,
    // cacheWritePerM 0, peakMultiplier from peak.multiplier.
    assert.equal(config.rules[1].provider, '*')
    assert.equal(config.rules[1].currency, 'USD')
    assert.equal(config.rules[1].cacheWritePerM, 0)
    assert.equal(config.rules[1].peakMultiplier, 3)
    // Built-ins always carry both currency tables and the configured multiplier.
    assert.equal(config.builtinRules.length, 8)
    assert.equal(config.builtinRules.every(rule => rule.peakMultiplier === 3), true)
    // Calls never share mutable default objects.
    const first = resolveBillingConfig()
    const second = resolveBillingConfig()
    assert.notEqual(first.peak, second.peak)
    assert.notEqual(first.peak.weekdays, second.peak.weekdays)
    assert.notEqual(first.peak.windows, second.peak.windows)
    assert.notEqual(first.builtinRules, second.builtinRules)
  })

  it('rejects unknown fields and malformed values with the config path', () => {
    // Top-level container and typos.
    assert.throws(() => resolveBillingConfig(null), /billing-card: config must be a plain object/)
    rejectsConfig([], /config must be a plain object/)
    rejectsConfig({ curreny: 'CNY' }, /config\.curreny is not a recognized option/)
    rejectsConfig({ bogus: 1 }, /config\.bogus is not a recognized option/)
    rejectsConfig({ currency: 'EUR' }, /config\.currency must be 'CNY' or 'USD'/)

    // Pricing container and fields.
    rejectsConfig({ pricing: {} }, /config\.pricing must be an array of price rules/)
    rejectsConfig({ pricing: ['free'] }, /config\.pricing\[0\] must be a plain object/)
    rejectsConfig({ pricing: [{ model: 'm' }] }, /config\.pricing\[0\]\.inputPerM must be a finite non-negative number/)
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1, peakMultiplier: -1 }] },
      /config\.pricing\[0\]\.peakMultiplier must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.model must be a non-empty string/,
    )
    rejectsConfig(
      { pricing: [{ provider: '', model: 'm', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.provider must be a non-empty string/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', currency: 'EUR', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.currency must be 'CNY' or 'USD'/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: 1, cacheReadPerM: 0 }] },
      /config\.pricing\[0\]\.outputPerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: -1, cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.inputPerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1, cacheWritePerM: -2 }] },
      /config\.pricing\[0\]\.cacheWritePerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: NaN, cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.inputPerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: 1, cacheReadPerM: Infinity, outputPerM: 1 }] },
      /config\.pricing\[0\]\.cacheReadPerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: '1', cacheReadPerM: 0, outputPerM: 1 }] },
      /config\.pricing\[0\]\.inputPerM must be a finite non-negative number/,
    )
    rejectsConfig(
      { pricing: [{ model: 'm', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1, bogus: true }] },
      /config\.pricing\[0\]\.bogus is not a recognized option/,
    )

    // Peak policy.
    rejectsConfig({ peak: null }, /config\.peak must be a plain object/)
    rejectsConfig({ peak: { enabled: 'yes' } }, /config\.peak\.enabled must be a boolean/)
    rejectsConfig({ peak: { utcOffsetMinutes: 1.5 } }, /config\.peak\.utcOffsetMinutes must be a whole number/)
    rejectsConfig({ peak: { weekdays: 'mon' } }, /config\.peak\.weekdays must be an array/)
    rejectsConfig({ peak: { weekdays: [0] } }, /config\.peak\.weekdays\[0\] must be an integer between 1 and 7/)
    rejectsConfig({ peak: { weekdays: [8] } }, /config\.peak\.weekdays\[0\] must be an integer between 1 and 7/)
    rejectsConfig({ peak: { weekdays: [1, 1] } }, /config\.peak\.weekdays\[1\] repeats weekday 1/)
    rejectsConfig({ peak: { windows: [['09:00']] } }, /config\.peak\.windows\[0\] must be an \[start, end\] pair/)
    rejectsConfig({ peak: { windows: [['9:00', '12:00']] } }, /config\.peak\.windows\[0\]\[0\] must be a valid HH:MM time/)
    rejectsConfig({ peak: { windows: [['24:00', '25:00']] } }, /config\.peak\.windows\[0\]\[0\] must be a valid HH:MM time/)
    rejectsConfig({ peak: { windows: [['12:00', '09:00']] } }, /config\.peak\.windows\[0\] must start before it ends/)
    rejectsConfig({ peak: { holidays: ['2026-13-01'] } }, /config\.peak\.holidays\[0\] must be a real calendar date/)
    rejectsConfig({ peak: { holidays: ['2026-02-30'] } }, /config\.peak\.holidays\[0\] must be a real calendar date/)
    rejectsConfig({ peak: { holidays: ['17/10/2026'] } }, /config\.peak\.holidays\[0\] must be a valid YYYY-MM-DD date/)
    rejectsConfig({ peak: { holidays: [20261017] } }, /config\.peak\.holidays\[0\] must be a valid YYYY-MM-DD date/)
    rejectsConfig({ peak: { multiplier: -2 } }, /config\.peak\.multiplier must be a finite non-negative number/)
    rejectsConfig({ peak: { bogus: true } }, /config\.peak\.bogus is not a recognized option/)
  })
})

// --------------------------------------------------------------------------
// Price resolution
// --------------------------------------------------------------------------

describe('resolvePrice', () => {
  it('prices the built-in DeepSeek models in the configured currency', () => {
    const cny = resolveBillingConfig()
    const flash = resolvePrice(cny, 'deepseek', 'deepseek-flash')
    assert.ok(flash !== null)
    assert.equal(flash.provider, '*')
    assert.equal(flash.currency, 'CNY')
    assert.deepEqual(priceFieldsOf(flash), {
      inputPerM: 1,
      cacheReadPerM: 0.02,
      cacheWritePerM: 0,
      outputPerM: 4,
      peakMultiplier: 2,
    })
    // The built-in wildcard provider matches any route provider.
    assert.deepEqual(priceFieldsOf(resolvePrice(cny, 'some-other-provider', 'deepseek-v4-pro')), {
      inputPerM: 4.5,
      cacheReadPerM: 0.15,
      cacheWritePerM: 0,
      outputPerM: 13.5,
      peakMultiplier: 2,
    })

    const usd = resolveBillingConfig({ currency: 'USD' })
    assert.deepEqual(priceFieldsOf(resolvePrice(usd, 'deepseek', 'deepseek-flash')), {
      inputPerM: 0.15,
      cacheReadPerM: 0.003,
      cacheWritePerM: 0,
      outputPerM: 0.6,
      peakMultiplier: 2,
    })
    assert.deepEqual(priceFieldsOf(resolvePrice(usd, 'deepseek', 'deepseek-v4-pro')), {
      inputPerM: 0.66,
      cacheReadPerM: 0.022,
      cacheWritePerM: 0,
      outputPerM: 1.98,
      peakMultiplier: 2,
    })
    // Legacy model ids bill as Flash.
    for (const legacyModel of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      assert.deepEqual(priceFieldsOf(resolvePrice(usd, 'deepseek', legacyModel)), {
        inputPerM: 0.15,
        cacheReadPerM: 0.003,
        cacheWritePerM: 0,
        outputPerM: 0.6,
        peakMultiplier: 2,
      })
    }
  })

  it('lets user rules override built-ins through the provider/model ladder', () => {
    const config = resolveBillingConfig({
      pricing: [
        { provider: 'acme', model: '*', inputPerM: 7, cacheReadPerM: 7, outputPerM: 7 },
        { provider: '*', model: 'deepseek-v4-pro', inputPerM: 5, cacheReadPerM: 5, outputPerM: 5 },
        { provider: '*', model: '*', inputPerM: 1, cacheReadPerM: 1, outputPerM: 1 },
      ],
    })
    // exact provider + wildcard model beats wildcard provider + exact model.
    assert.equal(resolvePrice(config, 'acme', 'deepseek-flash').inputPerM, 7)
    assert.equal(resolvePrice(config, 'acme', 'deepseek-v4-pro').inputPerM, 7)
    // wildcard provider + exact model beats both-wildcards.
    assert.equal(resolvePrice(config, 'beta', 'deepseek-v4-pro').inputPerM, 5)
    // both-wildcards is the final fallback.
    assert.equal(resolvePrice(config, 'beta', 'unknown-model').inputPerM, 1)
    // A user exact match overrides the more specific built-in.
    const override = resolveBillingConfig({
      pricing: [{ model: 'deepseek-flash', inputPerM: 9, cacheReadPerM: 9, outputPerM: 9 }],
    })
    assert.equal(resolvePrice(override, 'deepseek', 'deepseek-flash').inputPerM, 9)
    // An unknown model falls to the user both-wildcards rule above the built-in table.
    assert.equal(resolvePrice(config, 'deepseek', 'not-a-builtin').inputPerM, 1)
  })

  it('ignores rules of another currency and never guesses unknown routes', () => {
    const cny = resolveBillingConfig({
      pricing: [{ model: 'custom-model', currency: 'USD', inputPerM: 3, cacheReadPerM: 3, outputPerM: 3 }],
    })
    assert.equal(resolvePrice(cny, 'provider', 'custom-model'), null)
    const usd = resolveBillingConfig({
      currency: 'USD',
      pricing: [{ model: 'custom-model', currency: 'CNY', inputPerM: 3, cacheReadPerM: 3, outputPerM: 3 }],
    })
    assert.equal(resolvePrice(usd, 'provider', 'custom-model'), null)
    assert.equal(resolvePrice(cny, 'deepseek', 'not-a-deepseek-model'), null)
    // Opaque non-string ids resolve no price.
    assert.equal(resolvePrice(cny, null, 'deepseek-flash'), null)
    assert.equal(resolvePrice(cny, 'deepseek', undefined), null)
  })

  it('carries the configured peak multiplier into every resolved rule', () => {
    const config = resolveBillingConfig({ peak: { multiplier: 3 } })
    assert.equal(resolvePrice(config, 'deepseek', 'deepseek-flash').peakMultiplier, 3)
    const defaulted = resolveBillingConfig({
      pricing: [{ model: 'custom', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1 }],
    })
    assert.equal(resolvePrice(defaulted, 'any', 'custom').peakMultiplier, 2)
    const overridden = resolveBillingConfig({
      pricing: [{ model: 'custom', inputPerM: 1, cacheReadPerM: 0, outputPerM: 1, peakMultiplier: 1.5 }],
    })
    assert.equal(resolvePrice(overridden, 'any', 'custom').peakMultiplier, 1.5)
  })
})

// --------------------------------------------------------------------------
// Peak classification
// --------------------------------------------------------------------------

describe('classifyPeak', () => {
  it('splits the default Beijing windows on weekdays with exclusive ends', () => {
    const { peak } = resolveBillingConfig()
    const at = (day, hour, minute = 0) => beijing(2026, 10, day, hour, minute)
    assert.equal(classifyPeak(at(19, 10), peak), true) // Monday 10:00
    assert.equal(classifyPeak(at(19, 8), peak), false) // Monday 08:00
    assert.equal(classifyPeak(at(19, 11), peak), true) // Monday 11:00 still inside the first window
    assert.equal(classifyPeak(at(19, 13), peak), false) // Monday 13:00 between windows
    assert.equal(classifyPeak(at(19, 15), peak), true) // Monday 15:00
    assert.equal(classifyPeak(at(24, 10), peak), false) // Saturday 10:00
    assert.equal(classifyPeak(at(18, 10), peak), false) // Sunday 10:00
    // 09:00 inclusive.
    assert.equal(classifyPeak(at(19, 9), peak), true)
    assert.equal(classifyPeak(at(19, 8, 59), peak), false)
    // 12:00 exclusive.
    assert.equal(classifyPeak(at(19, 11, 59), peak), true)
    assert.equal(classifyPeak(at(19, 12), peak), false)
    // 14:00 inclusive, 18:00 exclusive.
    assert.equal(classifyPeak(at(19, 14), peak), true)
    assert.equal(classifyPeak(at(19, 17, 59), peak), true)
    assert.equal(classifyPeak(at(19, 18), peak), false)
    // Weekends are off-peak even inside a window.
    assert.equal(classifyPeak(at(24, 15), peak), false)
  })

  it('treats configured holidays and a disabled policy as off-peak', () => {
    const holiday = resolveBillingConfig({ peak: { holidays: ['2026-10-19'] } }).peak
    assert.equal(classifyPeak(beijing(2026, 10, 19, 10), holiday), false)
    assert.equal(classifyPeak(beijing(2026, 10, 20, 10), holiday), true) // Tuesday still peak
    const disabled = resolveBillingConfig({ peak: { enabled: false } }).peak
    assert.equal(classifyPeak(beijing(2026, 10, 19, 10), disabled), false)
  })

  it('honours a custom offset, weekdays, and windows independent of the host time zone', () => {
    const utc = resolveBillingConfig({ peak: { utcOffsetMinutes: 0 } }).peak
    assert.equal(classifyPeak(Date.UTC(2026, 9, 19, 10, 0), utc), true) // UTC Monday 10:00
    assert.equal(classifyPeak(Date.UTC(2026, 9, 19, 8, 0), utc), false) // UTC Monday 08:00
    assert.equal(classifyPeak(Date.UTC(2026, 9, 19, 15, 0), utc), true) // UTC Monday 15:00
    assert.equal(classifyPeak(Date.UTC(2026, 9, 24, 10, 0), utc), false) // UTC Saturday 10:00

    const weekend = resolveBillingConfig({ peak: { weekdays: [6, 7], windows: [['10:00', '12:00']] } }).peak
    assert.equal(classifyPeak(beijing(2026, 10, 24, 10, 30), weekend), true) // Saturday 10:30
    assert.equal(classifyPeak(beijing(2026, 10, 25, 10, 30), weekend), true) // Sunday 10:30
    assert.equal(classifyPeak(beijing(2026, 10, 19, 10, 30), weekend), false) // Monday 10:30
    assert.equal(classifyPeak(beijing(2026, 10, 24, 12), weekend), false) // window end exclusive
    assert.equal(classifyPeak(beijing(2026, 10, 24, 9, 59), weekend), false) // window start exclusive

    // A plain epoch value is read through the policy offset, never through the
    // host time zone: 2026-10-19T02:00:00Z is Beijing 10:00.
    assert.equal(classifyPeak(Date.UTC(2026, 9, 19, 2, 0), resolveBillingConfig().peak), true)
    assert.equal(classifyPeak(Number.NaN, resolveBillingConfig().peak), false)
  })
})

// --------------------------------------------------------------------------
// Fold and wire view
// --------------------------------------------------------------------------

describe('billingUsage projection', () => {
  it('starts from the empty state and ignores unrelated events', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const initial = projection.init()
    assert.equal(BILLING_PROJECTION_KEY, 'billingUsage')
    assert.equal(projection.key, 'billingUsage')
    assert.equal(projection.stateVersion, 2)
    assert.deepEqual(initial, {
      routes: {},
      current: null,
      last: null,
      search: {
        calls: 0,
        requests: 0,
        billable: 0,
        emptyCalls: 0,
        failedCalls: 0,
        fetchCalls: 0,
        fetchBillable: 0,
        pending: {},
        pendingFetch: {},
      },
    })
    assert.notEqual(projection.init(), initial)

    assert.equal(projection.apply(initial, event('step/start', { turn: 1, step: 1 }, OFF_PEAK_TIME)), initial)
    assert.equal(
      projection.apply(initial, event('tool/call', { turn: 1, step: 1, callId: 'c', name: 'n', arguments: '{}' }, OFF_PEAK_TIME)),
      initial,
    )
    // A usage-free assistant message changes nothing.
    assert.equal(projection.apply(initial, assistantMessageEvent({ turn: 1, step: 1, source: FLASH_SOURCE })), initial)
    // A usage sample with no resolvable route changes nothing.
    assert.equal(
      projection.apply(initial, assistantMessageEvent({ turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } })),
      initial,
    )
    // Empty route ids are not resolvable, so a header/source cannot store a
    // route the state schema would reject.
    assert.equal(
      projection.apply(initial, requestHeaderEvent('', 'deepseek-flash')),
      initial,
    )
    assert.equal(
      projection.apply(initial, assistantMessageEvent({
        turn: 1,
        step: 1,
        usage: { inputTokens: 5, outputTokens: 1 },
        source: { kind: 'model', provider: 'deepseek', model: '' },
      })),
      initial,
    )
    // A retry with no replacement slot changes nothing.
    assert.equal(projection.apply(initial, retryStartedEvent(1, 1)), initial)

    const view = projection.wire.view(initial)
    assert.deepEqual(view, {
      version: 1,
      currency: 'CNY',
      routes: [],
      totals: {
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
      },
      search: {
        enabled: true,
        perRequest: 0.005,
        searchFreeUntil: Date.parse('2026-10-31T16:00:00.000Z'),
        calls: 0,
        requests: 0,
        billable: 0,
        emptyCalls: 0,
        failedCalls: 0,
        fetchCalls: 0,
        fetchBillable: 0,
        searchCost: 0,
        fetchCost: 0,
        totalCost: 0,
      },
    })
    assert.equal(projection.wire.view(initial), view)

    // The latest request/header route is remembered; repeating it is a no-op.
    const routed = projection.apply(initial, requestHeaderEvent('deepseek', 'deepseek-flash'))
    assert.notEqual(routed, initial)
    assert.deepEqual(routed.current, { provider: 'deepseek', model: 'deepseek-flash' })
    assert.equal(projection.apply(routed, requestHeaderEvent('deepseek', 'deepseek-flash')), routed)
  })

  it('bills an off-peak assistant message at the off-peak Flash rate', () => {
    const config = resolveBillingConfig()
    const projection = createBillingProjection(config)
    const usage = { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 }
    const state = fold(projection, [assistantMessageEvent({ turn: 1, step: 1, usage, source: FLASH_SOURCE })])
    const view = projection.wire.view(state)

    assert.equal(view.version, 1)
    assert.equal(view.currency, 'CNY')
    assert.equal(view.routes.length, 1)
    const route = view.routes[0]
    assert.equal(route.provider, 'deepseek')
    assert.equal(route.model, 'deepseek-flash')
    assert.equal(route.input, 1000)
    assert.equal(route.cacheRead, 500)
    assert.equal(route.cacheWrite, 0)
    assert.equal(route.output, 200)
    assert.equal(route.total, 1700)
    assert.deepEqual(route.peak, ZERO_BUCKETS)
    assert.deepEqual(route.offPeak, { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200 })
    const expectedCost = (1000 * 1 + 500 * 0.02 + 0 * 0 + 200 * 4) / 1_000_000
    assert.equal(route.costOffPeak, expectedCost)
    assert.equal(route.costPeak, 0)
    assert.equal(route.cost, expectedCost)
    assert.equal(route.priced, true)
    assert.deepEqual(route.pricing, {
      inputPerM: 1,
      cacheReadPerM: 0.02,
      cacheWritePerM: 0,
      outputPerM: 4,
      peakMultiplier: 2,
    })
    assert.deepEqual(view.totals, {
      input: 1000,
      cacheRead: 500,
      cacheWrite: 0,
      output: 200,
      total: 1700,
      cost: expectedCost,
      costPeak: 0,
      costOffPeak: expectedCost,
      pricedRoutes: 1,
      unpricedRoutes: 0,
    })
    // The exported pure projection produces the same value.
    assert.deepEqual(billingView(state, config), view)
    // The wire view validates against the projection's own schema.
    assert.equal(projection.wire.viewSchema.parse(view), view)
  })

  it('bills a peak sample at double the off-peak rate', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const usage = { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 }
    const state = fold(projection, [assistantMessageEvent({ turn: 1, step: 1, usage, source: FLASH_SOURCE, time: PEAK_TIME })])
    const view = projection.wire.view(state)
    const route = view.routes[0]
    const expectedPeak = (1000 * 1 + 500 * 0.02 + 0 * 0 + 200 * 4) / 1_000_000 * 2
    assert.deepEqual(route.peak, { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200 })
    assert.deepEqual(route.offPeak, ZERO_BUCKETS)
    assert.equal(route.costOffPeak, 0)
    assert.equal(route.costPeak, expectedPeak)
    assert.equal(route.cost, expectedPeak)
    assert.equal(view.totals.costPeak, expectedPeak)
    assert.equal(view.totals.costOffPeak, 0)
    assert.equal(view.totals.cost, expectedPeak)
  })

  it('replaces the previous sample of the same turn and step', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const build = usage => assistantMessageEvent({ turn: 1, step: 1, usage, source: FLASH_SOURCE })
    const first = build({ inputTokens: 100, outputTokens: 10 })
    const second = build({ inputTokens: 150, outputTokens: 20 })
    const state = fold(projection, [first, second])
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 1)
    assert.equal(view.routes[0].input, 150)
    assert.equal(view.routes[0].output, 20)
    assert.equal(view.totals.total, 170)
    assert.equal(view.totals.cost, (150 * 1 + 20 * 4) / 1_000_000)
    // A different turn adds instead of replacing.
    const later = assistantMessageEvent({ turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 1 }, source: FLASH_SOURCE })
    const extended = projection.wire.view(projection.apply(state, later))
    assert.equal(extended.totals.input, 157)
    assert.equal(extended.totals.output, 21)
    assert.equal(extended.totals.total, 178)
  })

  it('bills a retried attempt in addition to the replaced sample', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const events = [
      requestHeaderEvent('deepseek', 'deepseek-flash'),
      assistantMessageEvent({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 }, source: FLASH_SOURCE }),
      retryStartedEvent(1, 1),
      assistantAttemptEvent({ turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 5 } }),
    ]
    const state = fold(projection, events)
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 1)
    assert.equal(view.totals.input, 140)
    assert.equal(view.totals.output, 15)
    assert.equal(view.totals.total, 155)
    // A retry for another turn/step does not disturb the replacement slot.
    const withSample = projection.apply(projection.init(), assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      source: FLASH_SOURCE,
    }))
    assert.equal(projection.apply(withSample, retryStartedEvent(9, 9)), withSample)
    const cleared = projection.apply(withSample, retryStartedEvent(1, 1))
    assert.deepEqual(cleared.last, null)
  })

  it('reads the stream usage chunk when the message carries no usage field', () => {
    const usage = { inputTokens: 30, outputTokens: 3 }
    const fallback = assistantMessageEvent({ turn: 1, step: 1, source: FLASH_SOURCE, stream: usageStream(usage) })
    const fallbackView = buildView(resolveBillingConfig(), [fallback])
    assert.equal(fallbackView.routes[0].input, 30)
    assert.equal(fallbackView.routes[0].output, 3)
    // The explicit event usage wins over the embedded stream chunk.
    const both = assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 11, outputTokens: 1 },
      source: FLASH_SOURCE,
      stream: usageStream({ inputTokens: 99, outputTokens: 9 }),
    })
    const bothView = buildView(resolveBillingConfig(), [both])
    assert.equal(bothView.routes[0].input, 11)
    assert.equal(bothView.routes[0].output, 1)
    // The backward scan takes the LAST usage chunk of the stream.
    const stream = [
      ...usageStream({ inputTokens: 1, outputTokens: 1 }),
      { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['hi'] },
      ...usageStream(usage),
    ]
    const lastView = buildView(resolveBillingConfig(), [
      assistantMessageEvent({ turn: 1, step: 1, source: FLASH_SOURCE, stream }),
    ])
    assert.equal(lastView.routes[0].input, 30)
  })

  it('takes the attempt route from the latest request header', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      requestHeaderEvent('deepseek', 'deepseek-v4-pro'),
      assistantAttemptEvent({ turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 } }),
    ])
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 1)
    const route = view.routes[0]
    assert.equal(route.provider, 'deepseek')
    assert.equal(route.model, 'deepseek-v4-pro')
    assert.equal(route.input, 10)
    assert.equal(route.output, 2)
    assert.equal(route.cost, (10 * 4.5 + 2 * 13.5) / 1_000_000)
  })

  it('prefers the assistant message source route over the current route', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      requestHeaderEvent('deepseek', 'deepseek-v4-pro'),
      assistantMessageEvent({
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 2 },
        source: FLASH_SOURCE,
      }),
      // No message source: falls back to the latest request route.
      assistantMessageEvent({ turn: 2, step: 1, usage: { inputTokens: 20, outputTokens: 4 } }),
    ])
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 2)
    const flash = view.routes.find(route => route.model === 'deepseek-flash')
    const pro = view.routes.find(route => route.model === 'deepseek-v4-pro')
    assert.ok(flash !== undefined)
    assert.ok(pro !== undefined)
    assert.equal(flash.input, 10)
    assert.equal(flash.output, 2)
    assert.equal(pro.input, 20)
    assert.equal(pro.output, 4)
  })

  it('keeps an unpriced route in the totals without inventing a price', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 1000, outputTokens: 500 },
      source: { kind: 'model', provider: 'local', model: 'mystery-model' },
    })])
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 1)
    const route = view.routes[0]
    assert.equal(route.provider, 'local')
    assert.equal(route.model, 'mystery-model')
    assert.equal(route.priced, false)
    assert.equal(route.pricing, null)
    assert.equal(route.cost, 0)
    assert.equal(route.costPeak, 0)
    assert.equal(route.costOffPeak, 0)
    assert.equal(route.input, 1000)
    assert.equal(route.output, 500)
    assert.equal(route.total, 1500)
    assert.equal(view.totals.input, 1000)
    assert.equal(view.totals.output, 500)
    assert.equal(view.totals.total, 1500)
    assert.equal(view.totals.cost, 0)
    assert.equal(view.totals.pricedRoutes, 0)
    assert.equal(view.totals.unpricedRoutes, 1)
  })

  it('keeps routes distinct when provider and model ids contain separators', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      // provider 'a/b' + model 'c' versus provider 'a' + model 'b/c'.
      assistantMessageEvent({
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 1 },
        source: { kind: 'model', provider: 'a/b', model: 'c' },
      }),
      assistantMessageEvent({
        turn: 2,
        step: 1,
        usage: { inputTokens: 20, outputTokens: 2 },
        source: { kind: 'model', provider: 'a', model: 'b/c' },
      }),
      assistantMessageEvent({
        turn: 3,
        step: 1,
        usage: { inputTokens: 30, outputTokens: 3 },
        source: { kind: 'model', provider: 'vendor (beta)/v2', model: 'GLM/glm-5.3' },
      }),
    ])
    assert.equal(Object.keys(state.routes).length, 3)
    const view = projection.wire.view(state)
    assert.equal(view.routes.length, 3)
    const route = (provider, model) => view.routes.find(candidate => candidate.provider === provider && candidate.model === model)
    assert.ok(route('a/b', 'c') !== undefined)
    assert.ok(route('a', 'b/c') !== undefined)
    assert.ok(route('vendor (beta)/v2', 'GLM/glm-5.3') !== undefined)
    assert.equal(route('a/b', 'c').input, 10)
    assert.equal(route('a', 'b/c').input, 20)
    assert.equal(route('vendor (beta)/v2', 'GLM/glm-5.3').input, 30)
  })

  it('charges cache-write tokens only when a rule prices them', () => {
    const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100, outputTokens: 0 }
    const defaultView = buildView(resolveBillingConfig(), [
      assistantMessageEvent({ turn: 1, step: 1, usage, source: FLASH_SOURCE }),
    ])
    const defaultRoute = defaultView.routes[0]
    assert.equal(defaultRoute.cacheWrite, 100)
    assert.equal(defaultRoute.priced, true)
    assert.equal(defaultRoute.pricing.cacheWritePerM, 0)
    assert.equal(defaultRoute.cost, 0)
    assert.equal(defaultRoute.costOffPeak, 0)
    // A custom rule prices the cache-write bucket.
    const custom = resolveBillingConfig({
      pricing: [{
        provider: 'acme',
        model: 'custom-model',
        inputPerM: 1,
        cacheReadPerM: 2,
        cacheWritePerM: 5,
        outputPerM: 10,
      }],
    })
    const customView = buildView(custom, [assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 50 },
      source: { kind: 'model', provider: 'acme', model: 'custom-model' },
    })])
    const customRoute = customView.routes[0]
    assert.equal(customRoute.cacheWrite, 100)
    assert.equal(customRoute.pricing.cacheWritePerM, 5)
    assert.equal(customRoute.cost, (200 * 1 + 300 * 2 + 100 * 5 + 50 * 10) / 1_000_000)
  })

  it('splits peak and off-peak samples across the same route', () => {
    const view = buildView(resolveBillingConfig(), [
      assistantMessageEvent({ turn: 1, step: 1, usage: { inputTokens: 1000 }, source: FLASH_SOURCE, time: PEAK_TIME }),
      assistantMessageEvent({ turn: 2, step: 1, usage: { inputTokens: 500 }, source: FLASH_SOURCE, time: OFF_PEAK_TIME }),
    ])
    assert.equal(view.routes.length, 1)
    const route = view.routes[0]
    assert.equal(route.peak.input, 1000)
    assert.equal(route.offPeak.input, 500)
    assert.equal(route.input, 1500)
    const expectedPeak = 1000 * 1 / 1_000_000 * 2
    const expectedOffPeak = 500 * 1 / 1_000_000
    assert.equal(route.costPeak, expectedPeak)
    assert.equal(route.costOffPeak, expectedOffPeak)
    assert.equal(route.cost, expectedPeak + expectedOffPeak)
    assert.equal(view.totals.costPeak, expectedPeak)
    assert.equal(view.totals.costOffPeak, expectedOffPeak)
    assert.equal(view.totals.cost, expectedPeak + expectedOffPeak)
  })

  it('orders routes deterministically and totals priced and unpriced routes', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const message = (turn, provider, model, usage) => assistantMessageEvent({
      turn,
      step: 1,
      usage,
      source: { kind: 'model', provider, model },
    })
    const state = fold(projection, [
      message(1, 'deepseek', 'deepseek-flash', { inputTokens: 1000 }), // cost 0.001, total 1000
      message(2, 'deepseek', 'deepseek-v4-pro', { outputTokens: 100 }), // cost 0.00135, total 100
      message(3, 'local', 'unpriced-big', { inputTokens: 5000 }), // cost 0, total 5000
      message(4, 'local', 'unpriced-mid', { inputTokens: 300 }), // cost 0, total 300
      message(5, 'local', 'unpriced-small', { inputTokens: 100 }), // cost 0, total 100
      message(6, 'z', 'm1', { inputTokens: 50 }), // cost 0, total 50, provider 'z'
      message(7, 'a', 'm2', { inputTokens: 50 }), // cost 0, total 50, provider 'a'
    ])
    const view = projection.wire.view(state)
    assert.deepEqual(
      view.routes.map(route => `${route.provider}/${route.model}`),
      [
        'deepseek/deepseek-v4-pro',
        'deepseek/deepseek-flash',
        'local/unpriced-big',
        'local/unpriced-mid',
        'local/unpriced-small',
        'a/m2',
        'z/m1',
      ],
    )
    // Ties on cost and total break on provider, then model.
    const expectedCost = (100 * 13.5) / 1_000_000 + (1000 * 1) / 1_000_000
    assert.equal(view.totals.input, 6500)
    assert.equal(view.totals.output, 100)
    assert.equal(view.totals.total, 6600)
    assert.equal(view.totals.cost, expectedCost)
    assert.equal(view.totals.costPeak, 0)
    assert.equal(view.totals.costOffPeak, expectedCost)
    assert.equal(view.totals.pricedRoutes, 2)
    assert.equal(view.totals.unpricedRoutes, 5)
  })

  it('caches the wire view for one state reference and rebuilds it after a change', () => {
    const config = resolveBillingConfig()
    const projection = createBillingProjection(config)
    const first = projection.init()
    const firstView = projection.wire.view(first)
    assert.equal(projection.wire.view(first), firstView)
    assert.equal(projection.wire.view(projection.apply(first, event('step/start', { turn: 1, step: 1 }, OFF_PEAK_TIME))), firstView)

    const state = projection.apply(first, assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      source: FLASH_SOURCE,
    }))
    assert.notEqual(state, first)
    const view = projection.wire.view(state)
    assert.notEqual(view, firstView)
    assert.equal(projection.wire.view(state), view)
    assert.equal(view.totals.total, 11)
    assert.equal(firstView.totals.total, 0)

    // The exported pure projection is not reference-cached: same value, new object.
    const pure = billingView(state, config)
    assert.deepEqual(pure, view)
    assert.notEqual(pure, view)
  })
})

// --------------------------------------------------------------------------
// Search / fetch billing
// --------------------------------------------------------------------------

describe('search billing', () => {
  it('defaults to the official per-request prices and the server-side free window', () => {
    assert.deepEqual(resolveBillingConfig().search, {
      enabled: true,
      perRequest: 0.005,
      searchFreeUntil: Date.parse('2026-10-31T16:00:00.000Z'),
      trackFetch: true,
    })
    assert.equal(resolveBillingConfig({ currency: 'USD' }).search.perRequest, 0.00075)
  })

  it('accepts search overrides and rejects malformed options with the config path', () => {
    assert.deepEqual(resolveBillingConfig({
      search: { enabled: false, perRequest: 0.01, searchFreeUntil: null, trackFetch: false },
    }).search, { enabled: false, perRequest: 0.01, searchFreeUntil: null, trackFetch: false })
    for (const [raw, pattern] of [
      [{ search: [] }, /config\.search/],
      [{ search: { enabled: 'yes' } }, /config\.search\.enabled/],
      [{ search: { trackFetch: 1 } }, /config\.search\.trackFetch/],
      [{ search: { perRequest: -1 } }, /config\.search\.perRequest/],
      [{ search: { searchFreeUntil: 'tomorrow' } }, /config\.search\.searchFreeUntil/],
      [{ search: { unknown: true } }, /config\.search\.unknown/],
    ]) {
      assert.throws(() => resolveBillingConfig(raw), pattern)
    }
  })

  it('bills a successful multi-query search call per distinct query', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      toolCallEvent('web_search', { queries: ['a', 'b', 'a'] }, 'call-1'),
      toolResultEvent('call-1', false, { sources: [{ url: 'https://a.test' }], truncated: false }),
    ])
    const view = projection.wire.view(state)
    assert.equal(view.search.calls, 1)
    assert.equal(view.search.requests, 2)
    assert.equal(view.search.billable, 2)
    assert.equal(view.search.searchCost, 0.01)
    assert.equal(view.search.totalCost, 0.01)
    assert.equal(projection.wire.viewSchema.parse(view), view)
    // The search counter block survives a JSON checkpoint round-trip.
    assert.equal(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))).search.billable, 2)
  })

  it('does not bill a failed or empty-result search call', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const failed = fold(projection, [
      toolCallEvent('web_search', { queries: ['a'] }, 'call-fail'),
      toolResultEvent('call-fail', true),
    ])
    assert.equal(failed.search.failedCalls, 1)
    assert.equal(failed.search.billable, 0)
    const empty = fold(projection, [
      toolCallEvent('web_search', { queries: ['a', 'b'] }, 'call-empty'),
      toolResultEvent('call-empty', false, { sources: [], truncated: false }),
    ])
    assert.equal(empty.search.emptyCalls, 1)
    assert.equal(empty.search.billable, 0)
    assert.equal(projection.wire.view(empty).search.searchCost, 0)
  })

  it('counts direct Fetch API calls only on HTTP 200', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      toolCallEvent('web_fetch', { url: 'https://a.test' }, 'fetch-1'),
      toolResultEvent('fetch-1', false, { url: 'https://a.test', statusCode: 200, truncated: false }),
      toolCallEvent('web_fetch', { url: 'https://b.test' }, 'fetch-2'),
      toolResultEvent('fetch-2', true, { url: 'https://b.test', statusCode: 404, truncated: false }),
    ])
    const view = projection.wire.view(state)
    assert.equal(view.search.fetchCalls, 2)
    assert.equal(view.search.fetchBillable, 1)
    assert.equal(view.search.fetchCost, 0.005)
    assert.equal(view.search.totalCost, 0.005)
  })

  it('ignores a duplicate replacement result for the same call', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      toolCallEvent('web_search', { queries: ['a', 'b'] }, 'call-1'),
      toolResultEvent('call-1', false, { sources: [{ url: 'https://a.test' }], truncated: false }),
      toolResultEvent('call-1', false, { sources: [{ url: 'https://a.test' }], truncated: false }),
      toolCallEvent('web_fetch', { url: 'https://a.test' }, 'fetch-1'),
      toolResultEvent('fetch-1', false, { url: 'https://a.test', statusCode: 200, truncated: false }),
      toolResultEvent('fetch-1', false, { url: 'https://a.test', statusCode: 200, truncated: false }),
    ])
    assert.equal(state.search.billable, 2)
    assert.equal(state.search.fetchBillable, 1)
  })

  it('counts nothing when search tracking is disabled or fetch tracking is off', () => {
    const disabled = createBillingProjection(resolveBillingConfig({ search: { enabled: false } }))
    const idle = fold(disabled, [
      toolCallEvent('web_search', { queries: ['a'] }, 'call-1'),
      toolResultEvent('call-1', false, { sources: [{ url: 'https://a.test' }], truncated: false }),
      toolCallEvent('web_fetch', { url: 'https://a.test' }, 'fetch-1'),
      toolResultEvent('fetch-1', false, { url: 'https://a.test', statusCode: 200, truncated: false }),
    ])
    assert.equal(idle.search.calls, 0)
    assert.equal(idle.search.requests, 0)
    assert.equal(disabled.wire.view(idle).search.enabled, false)
    assert.equal(disabled.wire.view(idle).search.totalCost, 0)

    const noFetch = createBillingProjection(resolveBillingConfig({ search: { trackFetch: false } }))
    const fetchState = fold(noFetch, [
      toolCallEvent('web_fetch', { url: 'https://a.test' }, 'fetch-1'),
      toolResultEvent('fetch-1', false, { url: 'https://a.test', statusCode: 200, truncated: false }),
    ])
    assert.equal(fetchState.search.fetchCalls, 0)
    assert.equal(fetchState.search.fetchBillable, 0)
  })
})

// --------------------------------------------------------------------------
// Structural schemas
// --------------------------------------------------------------------------

describe('projection schemas', () => {
  it('exposes the registry registration contract', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    assert.equal(projection.key, 'billingUsage')
    assert.equal(projection.stateVersion, 2)
    assert.equal(typeof projection.init, 'function')
    assert.equal(typeof projection.apply, 'function')
    assert.equal(typeof projection.stateSchema.parse, 'function')
    assert.equal(typeof projection.stateSchema.safeParse, 'function')
    assert.equal(typeof projection.wire.view, 'function')
    assert.equal(typeof projection.wire.viewSchema.parse, 'function')
    assert.equal(typeof projection.wire.viewSchema.safeParse, 'function')
    assert.equal(Object.isFrozen(projection.stateSchema), true)
    assert.equal(Object.isFrozen(projection.wire.viewSchema), true)
  })

  it('accepts a checkpoint round-trip and rejects malformed state', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [
      requestHeaderEvent('deepseek', 'deepseek-flash'),
      assistantMessageEvent({ turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, source: FLASH_SOURCE }),
    ])
    assert.equal(projection.stateSchema.parse(state), state)
    const restored = JSON.parse(JSON.stringify(state))
    assert.deepEqual(restored, state)
    assert.equal(projection.stateSchema.parse(restored), restored)

    const malformedStates = [
      null,
      [],
      { routes: {}, current: null }, // missing last
      { ...state, extra: true },
      { ...state, routes: [] },
      { ...state, current: { provider: 'deepseek' } },
      { ...state, current: 'deepseek' },
      {
        ...state,
        routes: {
          'p\u001fm': { provider: 'p', model: 'm', peak: { ...ZERO_BUCKETS, input: -1 }, offPeak: ZERO_BUCKETS },
        },
      },
      {
        ...state,
        routes: { 'p\u001fm': { provider: 'p', model: 42, peak: ZERO_BUCKETS, offPeak: ZERO_BUCKETS } },
      },
      { ...state, last: { ...state.last, tier: 'mid' } },
      { ...state, last: { ...state.last, turn: '1' } },
      { ...state, last: { ...state.last, routeKey: '' } },
      { hello: 'world' },
    ]
    for (const malformed of malformedStates) {
      assert.throws(() => projection.stateSchema.parse(malformed), TypeError)
      assert.equal(projection.stateSchema.safeParse(malformed).success, false)
    }
    const safe = projection.stateSchema.safeParse(state)
    assert.equal(safe.success, true)
    assert.equal(safe.data, state)
  })

  it('accepts the wire view and rejects malformed views', () => {
    const projection = createBillingProjection(resolveBillingConfig())
    const state = fold(projection, [assistantMessageEvent({
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      source: FLASH_SOURCE,
    })])
    const view = projection.wire.view(state)
    assert.equal(projection.wire.viewSchema.parse(view), view)
    assert.equal(projection.wire.viewSchema.parse(projection.wire.view(projection.init())).routes.length, 0)

    const malformedViews = [
      null,
      {},
      { foo: 'bar' },
      { ...view, version: 2 },
      { ...view, currency: 'EUR' },
      { ...view, routes: {} },
      { ...view, routes: [{ ...view.routes[0], cost: -1 }] },
      { ...view, routes: [{ ...view.routes[0], provider: 1 }] },
      { ...view, routes: [{ ...view.routes[0], pricing: { inputPerM: 1 } }] },
      { ...view, routes: [{ ...view.routes[0], priced: 'yes' }] },
      { ...view, totals: { ...view.totals, pricedRoutes: 0.5 } },
      { ...view, totals: { ...view.totals, costPeak: null } },
      { ...view, totals: { ...view.totals, input: -1 } },
    ]
    for (const malformed of malformedViews) {
      assert.throws(() => projection.wire.viewSchema.parse(malformed), TypeError)
      assert.equal(projection.wire.viewSchema.safeParse(malformed).success, false)
    }
    const safe = projection.wire.viewSchema.safeParse(view)
    assert.equal(safe.success, true)
    assert.equal(safe.data, view)
  })
})

// --------------------------------------------------------------------------
// Plugin entry point
// --------------------------------------------------------------------------

describe('index plugin', () => {
  it('exports the function-plugin surface and registers exactly one unit', () => {
    assert.equal(pluginModule.name, 'dsh-plugin-billing-card')
    assert.deepEqual(pluginModule.inject, ['sessionProjections'])
    assert.equal(typeof pluginModule.apply, 'function')
    // No Config export and no default export: the raw config must reach apply().
    assert.equal('Config' in pluginModule, false)
    assert.equal('default' in pluginModule, false)

    const registered = []
    const ctx = {
      sessionProjections: {
        register: definition => {
          registered.push(definition)
          return () => {}
        },
      },
    }
    pluginModule.apply(ctx, { currency: 'USD' })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].key, 'billingUsage')
    assert.equal(registered[0].stateVersion, 2)
    assert.equal(registered[0].wire.view(registered[0].init()).currency, 'USD')
  })

  it('rejects an invalid config before touching the registry', () => {
    const registered = []
    const ctx = {
      sessionProjections: {
        register: definition => {
          registered.push(definition)
          return () => {}
        },
      },
    }
    assert.throws(() => pluginModule.apply(ctx, { currency: 'EUR' }), /billing-card: config\.currency/)
    assert.equal(registered.length, 0)
  })
})
