import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as host from '../index.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

// Load the same Cordis instance that the installed Typert peer uses.
const peerRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'))
const { Context, Service } = await import(pathToFileURL(peerRequire.resolve('@deepseek-ai/cordis')).href)

class FakeAuthorization extends Service {
  constructor(ctx) {
    super(ctx, 'authorization')
    this.active = false
    this.calls = []
  }
  describe() { return { methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: this.active } }
  begin(request) {
    this.calls.push(request)
    this.active = true
    return new Promise(resolve => {
      const done = result => { this.active = false; resolve(result) }
      this.finish = done
      request.signal.addEventListener('abort', () => done({ status: 'cancelled' }), { once: true })
    })
  }
  cancel() { this.finish?.({ status: 'cancelled' }) }
}

class FakeCredentials extends Service {
  constructor(ctx) { super(ctx, 'credentials') }
  async describeRecord() { return { configured: false, writable: true } }
  async deleteRecord() {}
}

test('real Cordis fiber mounts and disposes the SRC Remote with existing services', async () => {
  const ctx = new Context()
  await ctx.plugin(FakeAuthorization)
  await ctx.plugin(FakeCredentials)
  const fiber = ctx.plugin({ name: host.name, inject: host.inject, Config: host.Config, apply: host.apply },
    { timeoutSeconds: 600 })
  await fiber
  const remote = ctx.get('codexLogin')
  assert.ok(remote)
  assert.equal(remote.typertRemote.namespace, 'codexLogin')
  assert.deepEqual(remoteMethods(remote).map(method => method.method), ['start', 'status', 'answer', 'cancel', 'logout'])
  const { ticket } = remote.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.get('authorization').calls[0].key, 'llm-pi-ai/openai-codex')
  assert.equal((await remote.status(ticket)).state, 'running')
  await fiber.dispose()
  assert.equal(ctx.get('authorization').calls[0].signal.aborted, true)
  assert.equal(ctx.get('codexLogin'), undefined)
})
