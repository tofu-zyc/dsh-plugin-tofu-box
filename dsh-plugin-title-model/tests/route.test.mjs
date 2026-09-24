/**
 * Pure-function tests for the title-model host half.
 *
 * These run with plain `node` (no test framework, no network): they cover route
 * resolution and settings validation only. They are NOT evidence that a real
 * model request was routed — that requires a live install and is verified from
 * the session log by the Lead.
 */
import assert from 'node:assert/strict'
import { Config, NS, validateTitleModel, resolveTitleRoute } from '../index.js'

let failures = 0
function test(label, run) {
  try {
    run()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label}\n      ${error && error.message ? error.message : String(error)}`)
  }
}

console.log('resolveTitleRoute')

test('inherit keeps the exact logged session route', () => {
  const route = resolveTitleRoute(
    { mode: 'inherit' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('inherit ignores a configured provider/model when mode is inherit', () => {
  const route = resolveTitleRoute(
    { mode: 'inherit', provider: 'other', model: 'other-model' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('custom overrides the logged route', () => {
  const route = resolveTitleRoute(
    { mode: 'custom', provider: 'local', model: 'tiny-title' },
    { route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  )
  assert.deepEqual(route, { provider: 'local', model: 'tiny-title' })
})

test('custom wins even when no session route is logged', () => {
  const route = resolveTitleRoute({ mode: 'custom', provider: 'local', model: 'tiny-title' }, {})
  assert.deepEqual(route, { provider: 'local', model: 'tiny-title' })
})

test('inherit with no logged route throws instead of inventing one', () => {
  assert.throws(
    () => resolveTitleRoute({ mode: 'inherit' }, {}),
    /no logged request route is available/,
  )
})

console.log('validateTitleModel')

test('accepts the default section', () => {
  validateTitleModel({ mode: 'inherit' })
})

test('accepts a complete explicit pair', () => {
  validateTitleModel({ mode: 'custom', provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('rejects a lone provider', () => {
  assert.throws(() => validateTitleModel({ mode: 'inherit', provider: 'deepseek-official' }), /必须同时/)
})

test('rejects a lone model', () => {
  assert.throws(() => validateTitleModel({ mode: 'inherit', model: 'deepseek-flash' }), /必须同时/)
})

test('rejects custom mode without a route', () => {
  assert.throws(() => validateTitleModel({ mode: 'custom' }), /custom/)
})

test('treats empty strings as absent', () => {
  assert.throws(() => validateTitleModel({ mode: 'custom', provider: '', model: '' }), /custom/)
})

console.log('schemas')

test('Config defaults to inherit and exposes live route references', () => {
  const resolved = Config({})
  assert.equal(resolved.mode.get(), 'inherit')
  assert.equal(resolved.provider.get(), undefined)
  assert.equal(resolved.model.get(), undefined)
  assert.deepEqual({ targetWords: resolved.targetWords, targetCjkCharacters: resolved.targetCjkCharacters,
    maxInputBytes: resolved.maxInputBytes, maxOutputTokens: resolved.maxOutputTokens,
    timeoutMs: resolved.timeoutMs },
  { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 })
})

test('Config rejects an unknown mode', () => {
  assert.throws(() => Config({ mode: 'sometimes' }))
})

test('namespace is a lowercase hyphenated identifier', () => {
  assert.match(NS, /^[a-z][a-z0-9-]*$/)
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`)
  process.exit(1)
}
console.log('\nall route/schema tests passed')
