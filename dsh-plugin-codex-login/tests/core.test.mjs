import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexLoginController, CodexLoginError } from '../core.js'

const KEY = 'llm-pi-ai/openai-codex'
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let record
  let running = false
  let request
  let resolveAttempt
  let cancelCount = 0
  const credentials = {
    async describeRecord() { return { configured: record !== undefined, kind: record?.kind } },
    async deleteRecord() { record = undefined },
  }
  const authorization = {
    describe() { return { key: KEY, methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: running } },
    begin(next) {
      running = true
      request = next
      return new Promise(resolve => {
        resolveAttempt = outcome => { running = false; resolve(outcome) }
        if (next.signal.aborted) resolveAttempt({ status: 'cancelled' })
        else next.signal.addEventListener('abort', () => resolveAttempt({ status: 'cancelled' }), { once: true })
      })
    },
    cancel() { cancelCount += 1; resolveAttempt?.({ status: 'cancelled' }) },
  }
  const login = new CodexLoginController({ authorization, credentials, key: KEY })
  return {
    login, authorization, credentials,
    get request() { return request },
    get cancelCount() { return cancelCount },
    grant() { record = { kind: 'grant', payload: { access: 'ACCESS_SECRET', refresh: 'REFRESH_SECRET' } } },
    complete(status = 'authorized') { resolveAttempt({ status }) },
  }
}

test('only the existing pi-ai OAuth flow writes a grant; status never returns tokens', async () => {
  const f = fixture()
  const { ticket } = f.login.start()
  await turn()
  assert.equal(f.request.key, KEY)
  assert.equal(f.request.method, 'oauth')
  assert.equal(f.request.signal.aborted, false)
  f.request.interaction.notify({ message: 'Continue', url: 'https://auth.openai.com/authorize', code: 'ABCD' })
  f.request.interaction.notify({ message: 'No script link', url: 'javascript:alert(1)' })
  const running = await f.login.status(ticket)
  assert.equal(running.notices[0].url, 'https://auth.openai.com/authorize')
  assert.equal(running.notices[1].url, undefined)
  assert.equal(running.notices[0].code, 'ABCD')
  assert.throws(() => f.login.start(), { code: 'busy' })
  f.grant()
  f.complete()
  await turn()
  const status = await f.login.status(ticket)
  assert.equal(status.state, 'authorized')
  assert.equal(status.authorized, true)
  assert.deepEqual(status.notices, [])
  assert.doesNotMatch(JSON.stringify(status), /ACCESS_SECRET|REFRESH_SECRET/)
  assert.equal((await f.login.status('')).state, 'idle')
  await f.login.dispose()
})

test('only a matching ticket and prompt id can answer; secret answer is not in status', async () => {
  const f = fixture()
  const { ticket } = f.login.start()
  await turn()
  const answer = f.request.interaction.prompt({ kind: 'secret', message: 'Paste code', placeholder: 'code' })
  const status = await f.login.status(ticket)
  const [prompt] = status.prompts
  assert.equal(prompt.kind, 'secret')
  assert.throws(() => f.login.answer('wrong', prompt.id, 'secret'), { code: 'not-found' })
  assert.throws(() => f.login.answer(ticket, 'wrong', 'secret'), { code: 'prompt-expired' })
  assert.throws(() => f.login.answer(ticket, prompt.id, 'x'.repeat(4097)), { code: 'invalid' })
  assert.deepEqual(f.login.answer(ticket, prompt.id, 'one-time-code'), { accepted: true })
  assert.equal(await answer, 'one-time-code')
  assert.deepEqual((await f.login.status(ticket)).prompts, [])
  assert.doesNotMatch(JSON.stringify(await f.login.status(ticket)), /one-time-code/)
  f.complete('cancelled')
  await turn()
  await f.login.dispose()
})

test('prompt signal withdrawal, selection validation and cancellation do not leak a pending answer', async () => {
  const f = fixture()
  const { ticket } = f.login.start()
  await turn()
  const withdrawn = new AbortController()
  const lost = f.request.interaction.prompt({ kind: 'text', message: 'Enter code', signal: withdrawn.signal })
  withdrawn.abort()
  await assert.rejects(lost, { name: 'AbortError' })
  assert.deepEqual((await f.login.status(ticket)).prompts, [])
  const selected = f.request.interaction.prompt({ kind: 'select', message: 'Account', options: [{ id: 'a', label: 'A' }] })
  const promptId = (await f.login.status(ticket)).prompts[0].id
  assert.throws(() => f.login.answer(ticket, promptId, 'unlisted'), { code: 'invalid' })
  assert.deepEqual(f.login.answer(ticket, promptId, 'a'), { accepted: true })
  assert.equal(await selected, 'a')
  const pending = f.request.interaction.prompt({ kind: 'text', message: 'Waiting' })
  assert.deepEqual(f.login.cancel(ticket), { cancelled: true })
  await assert.rejects(pending, { name: 'AbortError' })
  await turn()
  assert.equal((await f.login.status(ticket)).state, 'cancelled')
  assert.equal(f.cancelCount, 1)
  await f.login.dispose()
})

test('logout refuses an in-flight login and deletes only the plugin-owned record', async () => {
  const f = fixture()
  f.grant()
  assert.equal((await f.login.status('')).authorized, true)
  const { ticket } = f.login.start()
  await turn()
  await assert.rejects(f.login.logout(), { code: 'busy' })
  f.complete()
  await turn()
  assert.deepEqual(await f.login.logout(), { loggedOut: true })
  assert.equal((await f.login.status(ticket)).authorized, false)
  await f.login.dispose()
})

test('disposal aborts its attempt; unavailable or duplicate external flow is reported', async () => {
  const f = fixture()
  f.authorization.describe = () => undefined
  assert.throws(() => f.login.start(), { code: 'no-flow' })
  f.authorization.describe = () => ({ methods: [{ id: 'oauth' }], inFlight: true })
  assert.throws(() => f.login.start(), { code: 'busy' })
  f.authorization.describe = () => ({ methods: [{ id: 'oauth' }], inFlight: false })
  const { ticket } = f.login.start()
  await turn()
  await f.login.dispose()
  assert.equal(f.request.signal.aborted, true)
  assert.equal(f.cancelCount, 1)
  assert.throws(() => f.login.start(), { code: 'unavailable' })
  await assert.rejects(f.login.status(ticket), { code: 'not-found' })
})

test('logout does not remove an API-key record or race a new login', async () => {
  const f = fixture()
  let releaseDelete
  let enteredDelete
  const deleting = new Promise(resolve => { enteredDelete = resolve })
  f.credentials.describeRecord = async () => ({ configured: true, kind: 'grant' })
  f.credentials.deleteRecord = async () => {
    enteredDelete()
    await new Promise(resolve => { releaseDelete = resolve })
  }
  const logout = f.login.logout()
  await deleting
  assert.throws(() => f.login.start(), { code: 'busy' })
  releaseDelete()
  await logout
  f.credentials.describeRecord = async () => ({ configured: true, kind: 'api-key' })
  await assert.rejects(f.login.logout(), { code: 'not-oauth' })
  await f.login.dispose()
})

test('disposal waits for the in-progress local logout', async () => {
  const f = fixture()
  f.grant()
  let enteredDelete
  let releaseDelete
  const entered = new Promise(resolve => { enteredDelete = resolve })
  f.credentials.deleteRecord = async () => {
    enteredDelete()
    await new Promise(resolve => { releaseDelete = resolve })
  }
  const logout = f.login.logout()
  await entered
  let settled = false
  const dispose = f.login.dispose().then(() => { settled = true })
  await turn()
  assert.equal(settled, false)
  releaseDelete()
  await Promise.all([logout, dispose])
  assert.equal(settled, true)
})

test('timeout aborts the flow and clears its pending prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const { ticket } = f.login.start()
  await turn()
  const pending = f.request.interaction.prompt({ kind: 'text', message: 'Waiting' })
  t.mock.timers.tick(600_000)
  await assert.rejects(pending, { name: 'AbortError' })
  await turn()
  assert.equal((await f.login.status(ticket)).state, 'timeout')
  assert.equal(f.cancelCount, 1)
  await f.login.dispose()
})

test('provider errors are generic on the wire and are not logged with secret content', async () => {
  const warnings = []
  const f = fixture()
  const login = new CodexLoginController({
    authorization: { ...f.authorization, begin: async () => {
      const error = new Error('ACCESS_SECRET')
      error.name = 'REFRESH_SECRET'
      throw error
    } },
    credentials: f.credentials, key: KEY, logger: { warn: (...args) => warnings.push(args) },
  })
  const { ticket } = login.start()
  await turn()
  assert.equal((await login.status(ticket)).state, 'error')
  assert.equal((await login.status(ticket)).failure, 'unknown')
  assert.doesNotMatch(JSON.stringify(await login.status(ticket)), /ACCESS_SECRET|REFRESH_SECRET/)
  assert.doesNotMatch(JSON.stringify(warnings), /ACCESS_SECRET|REFRESH_SECRET/)
  await login.dispose()
  assert.throws(() => new CodexLoginController({ authorization: f.authorization, credentials: f.credentials, key: KEY, timeoutMs: 1 }), RangeError)
  assert.ok(CodexLoginError)
})

test('only whitelisted failure categories reach the matching ticket and logger', async () => {
  const cases = [
    [Object.assign(new Error('ACCESS_SECRET'), { code: 'NOT_COMMITTED' }), 'record-not-committed'],
    [Object.assign(new Error('ACCESS_SECRET'), { code: 'NO_CREDENTIAL_STORE' }), 'credential-store'],
    [new TypeError('fetch failed', { cause: Object.assign(new Error('REFRESH_SECRET'), { code: 'ETIMEDOUT' }) }), 'network'],
    [Object.assign(new Error('ACCESS_SECRET'), { response: { status: 403, body: 'REFRESH_SECRET' } }), 'http-403'],
    [Object.assign(new Error('ACCESS_SECRET'), { code: 'REFRESH_SECRET', status: 799 }), 'unknown'],
  ]
  for (const [failure, expected] of cases) {
    const f = fixture()
    const warnings = []
    const login = new CodexLoginController({
      authorization: { ...f.authorization, begin: async () => { throw failure } },
      credentials: f.credentials, key: KEY, logger: { warn: (...args) => warnings.push(args) },
    })
    const { ticket } = login.start()
    await turn()
    assert.equal((await login.status(ticket)).failure, expected)
    assert.equal((await login.status('')).failure, undefined)
    assert.deepEqual(warnings, [['codex-login: OAuth attempt failed (%s)', expected]])
    assert.doesNotMatch(JSON.stringify([await login.status(ticket), warnings]), /ACCESS_SECRET|REFRESH_SECRET/)
    await login.dispose()
  }
})
