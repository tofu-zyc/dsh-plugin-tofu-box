/**
 * The screenshot workspace: the retention plan, the per-platform grab commands,
 * and the HTTP routes that save, list, prune, and delete shots.
 *
 * The host half is driven through a fake composition (webServer, fs, connection,
 * logger) so the routes run their real bodies; the shot directory is a temp
 * `DSH_HOME`, so nothing here touches a real profile.
 *
 * @module dsh-plugin-read-image-preview/tests/shots
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-rip-home-'))
process.env.DSH_HOME = HOME

const { apply, planCleanup, windowsCaptureScript, captureCommands } = await import('../index.js')

/** A 1×1 PNG, which is what an annotated export looks like at the smallest. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** Register every route `apply` publishes and hand back a way to call one. */
function compose(connection) {
  const routes = new Map()
  const logged = []
  const target = (raw) => {
    const absolute = path.isAbsolute(raw.path) ? raw.path : path.resolve(raw.cwd ?? HOME, raw.path)
    return { absolute, displayPath: absolute }
  }
  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.set(route.kind + ' ' + route.path, route.handler)
        return () => routes.delete(route.kind + ' ' + route.path)
      },
    },
    fs: {
      resolve: async (raw, options) => ({ path: raw, cwd: options?.cwd ?? '', ...target({ path: raw, cwd: options?.cwd }) }),
      stat: async (resolved) => {
        try {
          const info = await fs.stat(resolved.absolute)
          return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
        } catch {
          return undefined
        }
      },
      readByteRange: async (resolved, options) => {
        const handle = await fs.open(resolved.absolute, 'r')
        try {
          const buffer = Buffer.alloc(options.length)
          const { bytesRead } = await handle.read(buffer, 0, options.length, options.offset)
          return buffer.subarray(0, bytesRead)
        } finally {
          await handle.close()
        }
      },
      readBytes: async (resolved) => new Uint8Array(await fs.readFile(resolved.absolute)),
    },
    get: (name) => (name === 'connection' ? connection : undefined),
    logger: { info: (line) => logged.push(line), warn: (line) => logged.push(line) },
  }
  const config = {}
  apply(ctx, config)
  return { routes, logged, config }
}

/** One request through one registered handler. */
function call(routes, key, { method = 'GET', url = '', body } = {}) {
  const handler = routes.get(key)
  assert.ok(handler, 'no handler for ' + key)
  const req = method === 'GET'
    ? Object.assign(new Readable({ read() {} }), { method, url })
    : Object.assign(Readable.from(body === undefined ? [] : [body]), { method, url })
  const sent = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    writeHead(status, headers) {
      sent.status = status
      Object.assign(sent.headers, headers ?? {})
      return this
    },
    end(chunk) {
      if (chunk !== undefined) sent.body = Buffer.concat([sent.body, Buffer.from(chunk)])
      return this
    },
  }
  return Promise.resolve(handler(req, res)).then(() => sent)
}

const json = (sent) => JSON.parse(sent.body.toString('utf8'))

test('retention drops by age first, then by count, then by bytes', () => {
  const now = 1700000000000
  const entries = Array.from({ length: 5 }, (_, index) => ({
    name: 'shot-' + index + '.png', bytes: 100, mtime: now - index * 86400000,
  }))
  const byAge = planCleanup(entries, { days: 2, maxFiles: 5, maxBytes: 1e9, now })
  assert.deepEqual(byAge.removed, ['shot-3.png', 'shot-4.png'])
  assert.equal(byAge.kept.length, 3)
  const byCount = planCleanup(entries, { days: 0, maxFiles: 2, maxBytes: 1e9, now })
  assert.deepEqual(byCount.kept.map((entry) => entry.name), ['shot-0.png', 'shot-1.png'])
  const byBytes = planCleanup(entries, { days: 0, maxFiles: 99, maxBytes: 250, now })
  assert.equal(byBytes.kept.length, 2)
  assert.equal(byBytes.kept.reduce((sum, entry) => sum + entry.bytes, 0), 200)
})

test('a Windows grab raises DPI awareness before it reads the screen', () => {
  const script = windowsCaptureScript('C:\\temp\\it\'s here.png')
  assert.ok(script.indexOf('SetHighDpiMode') < script.indexOf('VirtualScreen'))
  assert.ok(script.includes("'C:\\temp\\it''s here.png'"), 'the target is a quoted, escaped literal')
  assert.ok(script.includes('SetProcessDpiAwarenessContext'), 'an old shell keeps a working fallback')
})

test('each platform names its grabbers, fastest first', () => {
  const windows = captureCommands('win32', 'x.png')
  assert.deepEqual(windows.map((command) => command.file === 'pwsh' ? 'pwsh' : 'powershell'), ['pwsh', 'powershell'])
  assert.deepEqual(captureCommands('darwin', 'x.png').map((command) => command.file), ['/usr/sbin/screencapture'])
  assert.ok(captureCommands('linux', 'x.png').length >= 3)
})

test('a saved shot lands in the shot directory and reads back through its URL', async () => {
  const allowed = compose({ requestRejection: () => undefined })
  const saved = await call(allowed.routes, 'exact /read-image-preview/save', { method: 'POST', body: PNG })
  const reply = json(saved)
  assert.equal(reply.ok, true)
  assert.match(reply.name, /^shot-\d{8}-\d{9}-[0-9a-z]{2}\.png$/)
  assert.equal(reply.path, path.join(HOME, 'screenshots', reply.name))
  const written = await fs.readFile(reply.path)
  assert.equal(written.length, PNG.length)

  const listed = json(await call(allowed.routes, 'exact /read-image-preview/list'))
  assert.equal(listed.dir, path.join(HOME, 'screenshots'))
  assert.equal(listed.items[0].name, reply.name)
  const served = await call(allowed.routes, 'prefix /read-image-preview', { url: listed.items[0].url })
  assert.equal(served.headers['content-type'], 'image/png')
  assert.equal(served.body.length, PNG.length)

  const removed = json(await call(allowed.routes, 'exact /read-image-preview/delete', {
    method: 'POST', url: '/read-image-preview/delete?name=' + reply.name,
  }))
  assert.equal(removed.ok, true)
  await assert.rejects(() => fs.readFile(reply.path))
})

test('a save that is not a PNG is refused, and a name with a separator is refused', async () => {
  const allowed = compose({ requestRejection: () => undefined })
  const notAnImage = await call(allowed.routes, 'exact /read-image-preview/save', {
    method: 'POST', body: Buffer.from('<svg onload="alert(1)"/>'),
  })
  assert.equal(notAnImage.status, 400)
  const escaped = await call(allowed.routes, 'exact /read-image-preview/delete', {
    method: 'POST', url: '/read-image-preview/delete?name=..%2F..%2Fescape.png',
  })
  assert.equal(escaped.status, 400)
})

test('every screenshot route honors the connection rejection', async () => {
  const denied = compose({ requestRejection: () => 403 })
  const saved = await call(denied.routes, 'exact /read-image-preview/save', { method: 'POST', body: PNG })
  assert.equal(saved.status, 403)
  const listed = await call(denied.routes, 'exact /read-image-preview/list')
  assert.equal(listed.status, 403)
  const listedBody = json(listed)
  assert.notEqual(listedBody.ok, true)
  const unguarded = compose(undefined)
  const withoutService = await call(unguarded.routes, 'exact /read-image-preview/save', { method: 'POST', body: PNG })
  assert.equal(withoutService.status, 503)
})

test('cleanup removes an expired shot and keeps a fresh one', async () => {
  const allowed = compose({ requestRejection: () => undefined })
  const dir = path.join(HOME, 'screenshots')
  await fs.mkdir(dir, { recursive: true })
  const old = 'shot-20180101-000000000-aa.png'
  await fs.writeFile(path.join(dir, old), PNG)
  await fs.utimes(path.join(dir, old), new Date(1514764800000), new Date(1514764800000))
  const fresh = json(await call(allowed.routes, 'exact /read-image-preview/save', { method: 'POST', body: PNG }))
  const cleaned = json(await call(allowed.routes, 'exact /read-image-preview/cleanup', { method: 'POST' }))
  assert.equal(cleaned.ok, true)
  assert.equal(cleaned.removed, 1)
  await assert.rejects(() => fs.readFile(path.join(dir, old)))
  await fs.readFile(path.join(dir, fresh.name))
  await fs.rm(dir, { recursive: true, force: true })
})

test('the state route reports the directory, the policy, and this platform', async () => {
  const allowed = compose({ requestRejection: () => undefined })
  const state = json(await call(allowed.routes, 'exact /read-image-preview/state'))
  assert.equal(state.dir, path.join(HOME, 'screenshots'))
  assert.deepEqual(state.policy, { days: 7, maxFiles: 300, maxBytes: 500 * 1024 * 1024 })
  assert.equal(state.platform, process.platform)
  assert.ok(state.capture.length > 0)
})
