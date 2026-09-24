import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { Config, apply } from '../index.js'
import { discoverImageModels, discoveryUrl, generateImages, resolveRequest, validateConfig, imageType } from '../core.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVQ4jWPo23H3PyWYYdSA/6NhcHc0DHYMizAAALd0Ii6qzJXIAAAAAElFTkSuQmCC', 'base64')
const hash = data => createHash('sha256').update(data).digest('hex')
const config = overrides => {
  const parsed = Config({ models: [{ id: 'art', model: 'custom-image-model', ...overrides }], defaultModel: 'art' })
  return { models: parsed.models.get().map(item => ({ ...item })), defaultModel: parsed.defaultModel.get() }
}
function store() {
  const files = new Map()
  return {
    files,
    async saveImages(inputs) { return inputs.map(input => {
      const ref = { attachmentId: hash(input.data), mediaType: input.mediaType, name: input.name, bytes: input.data.length, width: 1, height: 1 }
      files.set(ref.attachmentId, input.data)
      return ref
    }) },
    async saveFile(input) { const ref = { attachmentId: hash(input.data), bytes: input.data.length, name: input.name }; files.set(ref.attachmentId, input.data); return ref },
    fileHostPath(ref) { return `D:/attachments/${ref.attachmentId}/${ref.name}` },
    async readImage(ref) { return { ref, data: files.get(ref.attachmentId) } },
    async *readFileStream(ref) { yield files.get(ref.attachmentId) },
  }
}
async function server(t, handle) {
  const requests = []
  const instance = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined })
    await handle(req, res, requests)
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  t.after(() => { instance.closeAllConnections(); instance.close() })
  return { origin: `http://127.0.0.1:${instance.address().port}`, requests }
}
const json = (res, value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
const imageResponse = { data: [{ b64_json: PNG.toString('base64') }] }
const run = (cfg, extra = {}) => generateImages({ config: cfg, args: { prompt: '画一只猫' }, attachments: store(), resolveKey: async () => 'test-key', ...extra })

test('configuration defaults, duplicate IDs, unsupported protocol and missing defaults', () => {
  const cfg = config()
  validateConfig(cfg)
  assert.equal(cfg.models[0].endpoint, 'https://api.openai.com/v1/images/generations')
  assert.equal(cfg.models[0].timeoutSeconds, 300)
  assert.throws(() => validateConfig({ ...cfg, models: [...cfg.models, ...cfg.models] }), /重复/)
  assert.throws(() => Config({ models: [{ id: 'art', model: 'm', api: 'openai-responses' }] }))
  assert.throws(() => validateConfig({ ...cfg, defaultModel: 'missing' }), /默认/)
  assert.throws(() => validateConfig(config({ endpoint: 'https://user:secret@example.com' })), /凭据/)
  assert.throws(() => resolveRequest(cfg, { prompt: 'x', n: 5 }), /1–4/)
  assert.throws(() => resolveRequest(cfg, { prompt: ' ' }), /提示词/)
})

test('real HTTP POST uses Images API, omits unset parameters and preserves original bytes', async t => {
  const host = await server(t, (_req, res) => json(res, imageResponse))
  const attachments = store()
  const result = await run(config({ endpoint: `${host.origin}/v1/images/generations`, apiKeyEnv: 'ART_KEY' }), { attachments })
  assert.equal(host.requests[0].path, '/v1/images/generations')
  assert.deepEqual(host.requests[0].body, { model: 'custom-image-model', prompt: '画一只猫', n: 1 })
  assert.equal(host.requests[0].headers.authorization, 'Bearer test-key')
  assert.deepEqual(attachments.files.get(result.images[0].original.attachmentId), PNG)
  assert.ok(result.images[0].path.endsWith('generated-1.png'))
})

test('per-model routing and parameter override, exact gateway aliases', async t => {
  const host = await server(t, (_req, res) => json(res, imageResponse))
  const cfg = config({ endpoint: `${host.origin}/images`, size: '1024x1024', response_format: 'b64_json' })
  cfg.models.push({ ...cfg.models[0], id: 'second', model: 'my/gateway-alias', quality: 'hd' })
  await run(cfg, { args: { model: 'second', prompt: 'sun', size: '1792x1024' } })
  assert.equal(host.requests[0].body.model, 'my/gateway-alias')
  assert.equal(host.requests[0].body.size, '1792x1024')
  assert.equal(host.requests[0].body.quality, 'hd')
  assert.equal(host.requests[0].body.response_format, 'b64_json')
})

test('URL download follows the host the gateway names and never forwards API credentials', async t => {
  const cdn = await server(t, (_req, res) => res.end(PNG))
  const host = await server(t, (_req, res) => json(res, { data: [{ url: `${cdn.origin}/signed.png?token=opaque` }] }))
  // A cross-origin CDN needs no pre-declaration; the gateway names where its
  // own result lives.
  await run(config({ endpoint: `${host.origin}/images`, apiKeyEnv: 'ART_KEY' }))
  assert.equal(cdn.requests[0].headers.authorization, undefined)
  assert.equal(cdn.requests[0].path, '/signed.png?token=opaque')
})

test('a result URL that is not a plain public HTTP(S) address is refused', async t => {
  for (const [url, expected] of [
    ['file:///etc/passwd', /公开的 HTTP\(S\) 地址/],
    ['https://user:secret@cdn.example/x.png', /公开的 HTTP\(S\) 地址/],
    // This one is already malformed before the scheme check can see it.
    ['not-a-url', /无效图片 URL/],
  ]) {
    const host = await server(t, (_req, res) => json(res, { data: [{ url }] }))
    await assert.rejects(run(config({ endpoint: `${host.origin}/images` })), expected, `url: ${url}`)
  }
})

test('failed generation is not retried or reflected verbatim, redirects cannot leak credentials', async t => {
  const target = await server(t, (_req, res) => res.end(PNG))
  const host = await server(t, (_req, res) => {
    res.statusCode = 302; res.setHeader('Location', `${target.origin}/steal`); res.end('test-key private error')
  })
  await assert.rejects(run(config({ endpoint: `${host.origin}/images`, apiKeyEnv: 'ART_KEY' })), error => {
    assert.doesNotMatch(error.message, /test-key|private error/)
    return true
  })
  assert.equal(host.requests.length, 1)
  assert.equal(target.requests.length, 0)
})

test('HTTP errors, malformed or empty output, invalid image data and byte limits', async () => {
  for (const [response, expected] of [
    [new Response('private test-key', { status: 429 }), /HTTP 429/],
    [new Response('<html>bad</html>'), /有效 JSON/],
    [Response.json({ data: [] }), /没有图片/],
    [Response.json({ data: [{ b64_json: '!!!!' }] }), /Base64/],
    [Response.json({ data: [{ b64_json: Buffer.from('hello').toString('base64') }] }), /不是支持/],
    [new Response('', { headers: { 'Content-Length': 200 * 1024 * 1024 } }), /大小限制/],
  ]) await assert.rejects(run(config(), { fetchImpl: async () => response }), expected)
  assert.throws(() => imageType(Buffer.from('not an image')), /不是支持/)
})

test('missing named key and pre-cancellation do not start a paid request', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return Response.json(imageResponse) }
  await assert.rejects(run(config({ apiKeyEnv: 'ABSENT_KEY' }), { fetchImpl, resolveKey: async () => undefined }), /未找到/)
  const controller = new AbortController(); controller.abort(new Error('stop'))
  await assert.rejects(run(config(), { fetchImpl, signal: controller.signal }), /stop/)
  assert.equal(calls, 0)
})

test('cancellation aborts a live HTTP request without retry', async t => {
  let received
  const pending = new Promise(resolve => { received = resolve })
  const host = await server(t, () => received())
  const controller = new AbortController()
  const task = run(config({ endpoint: `${host.origin}/images` }), { signal: controller.signal })
  await pending
  controller.abort(new Error('cancelled by user'))
  await assert.rejects(task, /cancelled by user/)
  assert.equal(host.requests.length, 1)
})

function pluginHarness(cfg) {
  let current = cfg
  const liveConfig = {
    models: { get: () => current.models },
    defaultModel: { get: () => current.defaultModel },
  }
  const tools = new Map(), cleanups = [], services = new Map()
  const attachments = store()
  let modalities = ['text']
  const ctx = {
    attachments,
    logger: { info() {}, warn() {}, error() {} },
    reflect: { provide: (name, service) => services.set(name, service) },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    get(name) {
      if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: modalities }) }
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) }
      return undefined
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  apply(ctx, liveConfig)
  return { tools, attachments, service: services.get('imageGeneration'),
    update(value) { current = value; validateConfig(current) },
    vision() { modalities = ['text', 'image'] },
    dispose() { for (const cleanup of cleanups.reverse()) cleanup() } }
}

test('host plugin registers real tool schemas and Remote methods; hot config and text/vision rendering', async t => {
  const host = await server(t, (_req, res) => json(res, imageResponse))
  const harness = pluginHarness(config({ endpoint: `${host.origin}/images` }))
  t.after(() => harness.dispose())
  assert.deepEqual(remoteMethods(harness.service).map(method => method.method), ['start', 'status', 'cancel', 'image', 'discover'])
  const tool = harness.tools.get('generate_image')
  const args = { prompt: 'cat' }
  const exec = { signal: new AbortController().signal, agent: { session: { requestHeader: () => ({ config: { provider: 'chat', model: 'text' } }) } } }
  const text = await tool.execute(args, exec)
  assert.equal(text.includeImages, false)
  assert.deepEqual(tool.output.render(args, text).map(block => block.type), ['text'])
  harness.vision()
  const vision = await tool.execute(args, exec)
  assert.deepEqual(tool.output.render(args, vision).map(block => block.type), ['text', 'image'])
  harness.update(config({ endpoint: `${host.origin}/new-endpoint`, model: 'changed' }))
  await tool.execute(args, exec)
  assert.equal(host.requests.at(-1).body.model, 'changed')
  assert.equal(host.requests.at(-1).path, '/new-endpoint')
  const directory = await harness.tools.get('list_image_models').execute({}, exec)
  assert.doesNotMatch(JSON.stringify(directory), /test-key|endpoint|apiKeyEnv/)
  harness.dispose()
  assert.equal(harness.tools.size, 0)
})

test('direct panel jobs return previews and exact original, and reject unknown image tickets', async t => {
  const host = await server(t, (_req, res) => json(res, imageResponse))
  const harness = pluginHarness(config({ endpoint: `${host.origin}/images` }))
  t.after(() => harness.dispose())
  const { jobId } = harness.service.start({ prompt: 'cat' })
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000
    function check() {
      const result = harness.service.status(jobId)
      if (result.status === 'done') return resolve()
      if (result.status === 'error' || Date.now() > deadline) return reject(new Error(result.error ?? 'job did not finish'))
      setTimeout(check, 10)
    }
    check()
  })
  assert.deepEqual(Buffer.from((await harness.service.image(jobId, 0, true)).data, 'base64'), PNG)
  assert.equal((await harness.service.image(jobId, 0, false)).mediaType, 'image/png')
  await assert.rejects(harness.service.image('unknown', 0, true), /不存在/)
  await assert.rejects(harness.service.image(jobId, -1, true), /不存在/)
  assert.throws(() => harness.service.start({ prompt: '' }), /提示词/)
})

test('model discovery derives sibling URLs, preserves gateway prefixes and blocks cross-origin key forwarding', () => {
  assert.equal(discoveryUrl('https://example.com/v1/images/generations/'), 'https://example.com/v1/models')
  assert.equal(discoveryUrl('https://example.com/proxy/openai/v1'), 'https://example.com/proxy/openai/v1/models')
  assert.equal(discoveryUrl('https://example.com/v1/images/generations', 'https://example.com/catalog'), 'https://example.com/catalog')
  assert.throws(() => discoveryUrl('https://example.com/v1', 'https://another.example/models'), /同源/)
})

test('discovery reads real supplier GET, deduplicates IDs, preserves unknown aliases, and uses draft key without resolving stored key', async t => {
  const host = await server(t, (_req, res) => json(res, { data: [
    { id: 'gateway/art', name: '画图模型' }, { id: 'chat-model' }, { id: 'gateway/art' }, { noId: true },
  ] }))
  const result = await discoverImageModels({ request: { endpoint: `${host.origin}/v1/images/generations`, apiKey: 'draft-secret', apiKeyEnv: 'STORED' },
    resolveKey: async () => { throw new Error('must not read stored key') } })
  assert.equal(host.requests[0].path, '/v1/models')
  assert.equal(host.requests[0].body, undefined)
  assert.equal(host.requests[0].headers.authorization, 'Bearer draft-secret')
  assert.deepEqual(result.models, [{ id: 'gateway/art', name: '画图模型' }, { id: 'chat-model', name: 'chat-model' }])
  assert.doesNotMatch(JSON.stringify(result), /draft-secret/)
  const harness = pluginHarness(config())
  t.after(() => harness.dispose())
  await harness.service.discover({ endpoint: `${host.origin}/v1/images/generations`, apiKeyEnv: 'STORED' })
  assert.equal(host.requests[1].headers.authorization, 'Bearer test-key')
  await assert.rejects(harness.service.discover({ endpoint: 'invalid' }), /地址/)
})

test('discovery handles empty catalogs, pagination hints, invalid responses and cancellation', async () => {
  const request = { endpoint: 'https://example.com/v1/images/generations' }
  const discover = (response, extra = {}) => discoverImageModels({ request, resolveKey: async () => undefined, fetchImpl: async () => response, ...extra })
  assert.deepEqual(await discover(Response.json({ data: [] })), { models: [], truncated: false })
  assert.equal((await discover(Response.json({ data: [{ id: 'art' }], has_more: true }))).truncated, true)
  await assert.rejects(discover(Response.json({ models: [] })), /data 数组/)
  await assert.rejects(discover(new Response('not json')), /有效 JSON/)
  await assert.rejects(discover(new Response('secret', { status: 401 })), /HTTP 401/)
  await assert.rejects(discover(new Response('', { headers: { 'Content-Length': 3 * 1024 * 1024 } })), /大小限制/)
  await assert.rejects(discover(Response.json({ data: [] }), { request: { ...request, apiKeyEnv: 'MISSING' } }), /未找到/)
  await assert.rejects(discover(Response.json({ data: [] }), { request: { ...request, apiKey: 'a\nb' } }), /格式无效/)
  const controller = new AbortController(); controller.abort(new Error('cancel discovery'))
  await assert.rejects(discover(Response.json({ data: [] }), { signal: controller.signal }), /cancel discovery/)
})
