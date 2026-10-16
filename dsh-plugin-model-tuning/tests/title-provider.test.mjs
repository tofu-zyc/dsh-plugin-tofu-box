/**
 * Behavioural tests for the merged `apply()` with a FAKE Cordis context.
 *
 * The provider is driven through the REAL public shared policy
 * (`generateSessionTitleWithLlm` from @deepseek-ai/dsh-session-title-llm) with only
 * `ctx.llm.stream` mocked. So these tests cover what this plugin actually
 * controls: the row it replaces, the settings namespace it registers, the
 * provider identity/cadence, the route handed to the shared policy, the first
 * human message it selects, and the failure/cancellation paths. The image half
 * is exercised in image.test.mjs against a local HTTP server.
 *
 * THEY ARE NOT LIVE VERIFICATION. No model request is made here, so they cannot
 * prove what a real install dispatches. Live verification reads
 * `session/title-llm-request` from the session log after the Lead installs.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { requireHostHelper } from './_host.mjs'
import { Config, apply } from '../index.js'

requireHostHelper()

const POLICY = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 }

/** A text-only chunk sequence the shipped BlockAssembler accepts. */
function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function fakeContext(options = {}) {
  const state = {
    provider: null,
    settings: { titleMode: 'inherit', ...(options.settings ?? {}) },
    calls: [],
    prepared: [],
    warnings: [],
    appended: [],
  }
  state.config = {
    ...Config({}),
    titleMode: { get: () => state.settings.titleMode },
    titleProvider: { get: () => state.settings.titleProvider },
    titleModel: { get: () => state.settings.titleModel },
  }
  const session = {
    id: 'session-under-test',
    append(type, data) {
      state.appended.push({ type, data })
    },
  }
  const tools = new Map()
  const services = new Map()
  const ctx = {
    logger: { warn: message => state.warnings.push(message), info() {} },
    sessionTitle: {
      register(provider) {
        if (state.provider !== null) throw new Error('a title provider is already registered')
        state.provider = provider
        return async () => {}
      },
    },
    llm: {
      stream(streamOptions) {
        state.calls.push(streamOptions)
        if (options.stream) return options.stream(streamOptions)
        return (async function* () { for (const chunk of textChunks(options.text ?? 'Mock Title')) yield chunk })()
      },
      // dsh ≥ 0.2.1 prepares the call first and lets the provider pick an
      // effort from the route's metadata; the old helper never calls this.
      async prepareCall(controls, _signal, configure) {
        const model = options.modelInfo ?? { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } }
        const config = typeof configure === 'function' ? configure(controls, model) : controls
        state.prepared.push(config)
        return { config, stream: streamOptions => ctx.llm.stream(streamOptions) }
      },
    },
    // Image-half stubs: apply() also registers tools and the Remote service;
    // they are inert here (no model entry drives them in these tests).
    attachments: {},
    reflect: { provide: (name, service) => services.set(name, service) },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }
  const cleanups = []
  return { ctx, state, session, tools, dispose() { for (const c of cleanups.reverse()) c() } }
}

function requestFor(route, session) {
  return {
    session: session ?? { id: 'session-under-test', append() {} },
    messages: [{ seq: 7, text: 'please help me tune the title model' }],
    ...(route === undefined ? {} : { route }),
    signal: new AbortController().signal,
  }
}

test('registers exactly one provider, with the replaced row identity and cadence', async () => {
  const { ctx, state } = fakeContext()
  await apply(ctx, state.config)
  assert.equal(state.provider.id, 'session-title-llm')
  assert.equal(state.provider.automatic, 'first-prompt')
  assert.equal(state.config.titleMode.get(), 'inherit')
})

test('a competing title provider costs only title routing, loudly, never the image half', async () => {
  const { ctx, state, tools } = fakeContext()
  await apply(ctx, state.config)
  const first = state.provider
  tools.clear()
  await apply(ctx, state.config)
  assert.equal(state.provider, first, 'the first registration stays the only provider')
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /标题路由未启用.*already registered/)
  assert.ok(tools.has('generate_image'), 'image tools still register after the title half fails')
})

test('a prepared-request host (dsh ≥ 0.2.1) gets the least effort and the shipped prompt shape', async (t) => {
  const appended = []
  const { ctx, state } = fakeContext({ text: '**Tune Title**\nbecause the user asked' })
  await apply(ctx, state.config)
  const session = { id: 'session-under-test', append: (type, data) => appended.push({ type, data }) }
  const result = await state.provider.generate(requestFor({ provider: 'p', model: 'm' }, session))
  if (state.prepared.length === 0) return t.skip('this host still ships the one-call helper')
  assert.equal(state.prepared[0].reasoningEffort, 'minimal', 'a title takes the route\'s least effort')
  assert.equal(result.title, 'Tune Title', 'first line, whole-line emphasis stripped')
  const record = appended.find(entry => entry.type === 'session/title-llm-request')
  assert.deepEqual(record.data.messageSeqs, [7])
  assert.match(record.data.system, /about 5 words .* or 10 CJK characters/)
})

test('inherit dispatches the logged session route and records it', async () => {
  const { ctx, state } = fakeContext({ text: 'Tune Title Model' })
  await apply(ctx, state.config)
  const result = await state.provider.generate(requestFor({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0].provider, 'deepseek-official')
  assert.equal(state.calls[0].model, 'deepseek-flash')
  assert.equal(state.calls[0].purpose, 'session-title')
  assert.equal(result.title, 'Tune Title Model')
  assert.deepEqual(result.model, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(result.messageSeqs, [7])
})

test('custom dispatches the configured route and records the same route', async () => {
  const { ctx, state } = fakeContext({ settings: { titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' } })
  await apply(ctx, state.config)
  const result = await state.provider.generate(requestFor({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  assert.equal(state.calls[0].provider, 'local')
  assert.equal(state.calls[0].model, 'tiny-title')
  assert.deepEqual(result.model, { provider: 'local', model: 'tiny-title' })
})

test('custom needs no logged session route at all', async () => {
  const { ctx, state } = fakeContext({ settings: { titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' } })
  await apply(ctx, state.config)
  await state.provider.generate(requestFor(undefined))
  assert.equal(state.calls[0].provider, 'local')
})

test('a settings read is taken per generation, so a live edit applies to the next title', async () => {
  const { ctx, state } = fakeContext()
  await apply(ctx, state.config)
  await state.provider.generate(requestFor({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  state.settings = { titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' }
  await state.provider.generate(requestFor({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  assert.equal(state.calls[0].model, 'deepseek-flash')
  assert.equal(state.calls[1].model, 'tiny-title')
})

test('only the first human message is selected (first-prompt cadence)', async () => {
  const { ctx, state } = fakeContext()
  await apply(ctx, state.config)
  const request = requestFor({ provider: 'p', model: 'm' })
  request.messages = [{ seq: 3, text: 'first' }, { seq: 9, text: 'second' }]
  const result = await state.provider.generate(request)
  assert.deepEqual(result.messageSeqs, [3])
  const framed = state.calls[0].messages[0].content[0].text
  assert.match(framed, /first/)
  assert.doesNotMatch(framed, /second/)
})

test('the auxiliary request record names the route actually dispatched', async () => {
  const { ctx, state, session } = fakeContext({ settings: { titleMode: 'custom', titleProvider: 'local', titleModel: 'tiny-title' } })
  await apply(ctx, state.config)
  const request = requestFor({ provider: 'deepseek-official', model: 'deepseek-flash' }, session)
  await state.provider.generate(request)
  const record = state.appended.find((entry) => entry.type === 'session/title-llm-request')
  assert.ok(record, 'the auxiliary request must be recorded')
  assert.deepEqual(record.data.route, { provider: 'local', model: 'tiny-title' })
  assert.deepEqual(record.data.messageSeqs, [7])
})

test('no source message fails instead of producing a title', async () => {
  const { ctx, state } = fakeContext()
  await apply(ctx, state.config)
  const request = requestFor({ provider: 'p', model: 'm' })
  request.messages = []
  await assert.rejects(() => state.provider.generate(request), /at least one source message/)
})

test('inherit without a logged route fails and keeps the caller fallback intact', async () => {
  const { ctx, state } = fakeContext()
  await apply(ctx, state.config)
  await assert.rejects(() => state.provider.generate(requestFor(undefined)), /no logged request route/)
  assert.equal(state.calls.length, 0, 'nothing may be dispatched without a route')
})

test('a provider error propagates (the service keeps the fallback title)', async () => {
  const { ctx, state } = fakeContext({
    stream: function* () { throw Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM' }) },
  })
  await apply(ctx, state.config)
  await assert.rejects(
    () => state.provider.generate(requestFor({ provider: 'p', model: 'm' })),
    /upstream unavailable/,
  )
})

test('an aborted caller rejects instead of hanging', async () => {
  const controller = new AbortController()
  const { ctx, state } = fakeContext({
    stream: () => (async function* () {
      controller.abort(new Error('caller cancelled'))
      await once(new Promise(() => {}), 'never')
    })(),
  })
  await apply(ctx, state.config)
  const request = requestFor({ provider: 'p', model: 'm' })
  request.signal = controller.signal
  await assert.rejects(() => state.provider.generate(request))
})

test('a title that reaches maxOutputTokens is rejected', async () => {
  const { ctx, state } = fakeContext({
    stream: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'cut off' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })(),
  })
  await apply(ctx, state.config)
  await assert.rejects(
    () => state.provider.generate(requestFor({ provider: 'p', model: 'm' })),
    /maxOutputTokens/,
  )
})

test('a tool call is rejected instead of becoming a title', async () => {
  const { ctx, state } = fakeContext({
    stream: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  })
  await apply(ctx, state.config)
  await assert.rejects(
    () => state.provider.generate(requestFor({ provider: 'p', model: 'm' })),
    /tool|text only/,
  )
})
