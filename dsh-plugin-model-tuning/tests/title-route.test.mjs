/**
 * Pure-function tests for the merged host half's title routing.
 *
 * These run with plain `node` (no test framework, no network): they cover route
 * resolution and settings validation only. They are NOT evidence that a real
 * model request was routed — that requires a live install and is verified from
 * the session log by the Lead.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, NS, validateTitleModel, resolveTitleRoute, titleBudgetOf } from '../index.js'

test('inherit keeps the exact logged session route', () => {
  const route = resolveTitleRoute(
    { titleMode: 'inherit' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('inherit ignores a configured provider/model when mode is inherit', () => {
  const route = resolveTitleRoute(
    { titleMode: 'inherit', titleProvider: 'other', titleModel: 'other-model' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('custom overrides the logged route', () => {
  const route = resolveTitleRoute(
    { titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'local', model: 'tiny-title' })
})

test('custom wins even when no session route is logged', () => {
  const route = resolveTitleRoute({ titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' }, {})
  assert.deepEqual(route, { provider: 'local', model: 'tiny-title' })
})

test('inherit with no logged route throws instead of inventing one', () => {
  assert.throws(
    () => resolveTitleRoute({ titleMode: 'inherit' }, {}),
    /no logged request route is available/,
  )
})

test('validateTitleModel accepts the default section', () => {
  validateTitleModel({ titleMode: 'inherit' })
})

test('validateTitleModel accepts a complete explicit pair', () => {
  validateTitleModel({ titleMode: 'custom', titleProvider: 'deepseek-official', titleModel: 'deepseek-flash' })
})

test('validateTitleModel rejects a lone provider', () => {
  assert.throws(() => validateTitleModel({ titleMode: 'inherit', titleProvider: 'deepseek-official' }), /必须同时/)
})

test('validateTitleModel rejects a lone model', () => {
  assert.throws(() => validateTitleModel({ titleMode: 'inherit', titleModel: 'deepseek-flash' }), /必须同时/)
})

test('validateTitleModel rejects custom mode without a route', () => {
  assert.throws(() => validateTitleModel({ titleMode: 'custom' }), /custom/)
})

test('validateTitleModel treats empty strings as absent', () => {
  assert.throws(() => validateTitleModel({ titleMode: 'custom', titleProvider: '', titleModel: '' }), /custom/)
})

test('Config defaults to inherit, unifies image fields and title fields in one namespace', () => {
  const resolved = Config({})
  assert.equal(resolved.titleMode.get(), 'inherit')
  assert.equal(resolved.titleProvider.get(), undefined)
  assert.equal(resolved.titleModel.get(), undefined)
  assert.deepEqual(resolved.models.get(), [])
  assert.equal(resolved.defaultModel.get(), undefined)
  assert.deepEqual(titleBudgetOf(resolved), {
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000,
  })
})

test('every title budget field is user-writable (volatile), not frozen row config', () => {
  const resolved = Config({ maxOutputTokens: 1024, targetWords: 8 })
  assert.equal(resolved.maxOutputTokens.get(), 1024)
  assert.equal(resolved.targetWords.get(), 8)
  // The remaining fields keep their shipped defaults yet stay writable.
  for (const key of ['targetCjkCharacters', 'maxInputBytes', 'timeoutMs']) {
    assert.equal(typeof resolved[key].get, 'function', `${key} must expose a live reference`)
  }
})

test('titleBudgetOf reads the live values and guards a non-positive budget', () => {
  const resolved = Config({ maxOutputTokens: 1024 })
  assert.equal(titleBudgetOf(resolved).maxOutputTokens, 1024)

  // The schema already refuses a non-positive value at resolution time…
  assert.throws(() => Config({ maxOutputTokens: 0 }), /maxOutputTokens/)

  // …and the runtime guard covers a value that reaches the plugin some other way.
  const live = (value) => ({ get: () => value })
  const forged = {
    targetWords: live(5), targetCjkCharacters: live(10), maxInputBytes: live(4096),
    maxOutputTokens: live(0), timeoutMs: live(60000),
  }
  assert.throws(() => titleBudgetOf(forged), /maxOutputTokens/)
})

test('Config rejects an unknown title mode', () => {
  assert.throws(() => Config({ titleMode: 'sometimes' }))
})

test('namespace is the unified model-tuning namespace', () => {
  assert.equal(NS, 'model-tuning')
  assert.match(NS, /^[a-z][a-z0-9-]*$/)
})
