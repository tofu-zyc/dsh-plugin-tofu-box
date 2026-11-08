/**
 * Host-half tests for dsh-plugin-pvz-perf.
 *
 * The pure helpers are called directly; the route itself is driven through a
 * real `node:http` server listening on 127.0.0.1:0 and exercised with `fetch`
 * (plus plain `http.request` for literal dot-segment paths that a URL parser
 * would normalize before they reach the server). Everything is hermetic: the
 * fixtures under `tests/fixtures/` stand in for the game build, no test looks at
 * the real game directory and no external network is used.
 *
 * @module dsh-plugin-pvz-perf/tests/host
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as host from '../index.js'
import {
  CANDIDATE_SUFFIXES,
  GAME_PREFIX,
  ROUTE,
  TOOLKIT_ROUTE,
  apply,
  createGameHandler,
  createToolkitHandler,
  findToolkitSetups,
  gameRelativePath,
  isGameDir,
  mimeTypeFor,
  parseToolkitSetups,
  readManifest,
  resolveGameDir,
} from '../index.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const GAME_DIR = path.join(FIXTURES, 'game')
const ALT_DIR = path.join(FIXTURES, 'game-alt')
const INCOMPLETE_DIR = path.join(FIXTURES, 'game-incomplete')
const BAD_MANIFEST_DIR = path.join(FIXTURES, 'game-bad-manifest')
const SECRET_FILE = path.join(FIXTURES, 'secret.txt')
const MISSING_DIR = path.join(FIXTURES, 'does-not-exist')
const TOOLKIT_ROOT = path.join(FIXTURES, 'toolkit')

const MANIFEST = readManifest(GAME_DIR)
const ALT_MANIFEST = readManifest(ALT_DIR)
const INDEX_BYTES = await fs.readFile(path.join(GAME_DIR, 'index.html'))

/** Every server started by a test, closed by the `after` hook. */
const servers = []

/**
 * Start a real HTTP server around one route handler and return its origin.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler
 *   the route handler to serve.
 * @returns {Promise<{ server: import('node:http').Server, origin: string }>} the listening server.
 */
function startServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (res.headersSent !== true) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('handler failed')
        } catch {
          /* the response is already gone */
        }
      } else {
        res.destroy()
      }
    })
  })
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, origin: 'http://127.0.0.1:' + address.port })
    })
  })
}

/** Fetch a URL and read the body as text. */
async function getText(url, init) {
  const response = await fetch(url, init)
  return { response, body: await response.text() }
}

/** Fetch a URL and read the body as bytes. */
async function getBytes(url, init) {
  const response = await fetch(url, init)
  return { response, body: Buffer.from(await response.arrayBuffer()) }
}

/**
 * Send a request whose path is not normalized by `fetch`/`URL`.
 * @param {string} origin - the server origin.
 * @param {{ method?: string, path: string }} options - the raw request line.
 * @returns {Promise<{ status: number, headers: object, body: string }>} the response.
 */
function rawRequest(origin, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const req = request({
      hostname: url.hostname,
      port: url.port,
      method: options.method ?? 'GET',
      path: options.path,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

const resolvedBuild = () => ({ dir: GAME_DIR, version: MANIFEST.version, sourceCommit: MANIFEST.sourceCommit })

const main = await startServer(createGameHandler({ resolve: resolvedBuild }))
const absent = await startServer(createGameHandler({ resolve: () => null }))

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve())
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  })))
})

test('fixed names and plugin exports match the contract', () => {
  assert.equal(host.name, 'dsh-plugin-pvz-perf')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.createGameHandler, 'function')
  assert.equal(ROUTE, '/pvz-perf')
  assert.equal(GAME_PREFIX, '/pvz-perf/game')
  assert.ok(Array.isArray(CANDIDATE_SUFFIXES))
  assert.ok(CANDIDATE_SUFFIXES.includes('pvz_perf_web'))
  assert.ok(CANDIDATE_SUFFIXES.includes(path.join('Games', 'pvz_perf_web')))
  assert.ok(CANDIDATE_SUFFIXES.includes('pvz_perf'))
})

test('mimeTypeFor maps the build containers and falls back to octet-stream', () => {
  assert.equal(mimeTypeFor('index.html'), 'text/html; charset=utf-8')
  assert.equal(mimeTypeFor('launcher.js'), 'text/javascript; charset=utf-8')
  assert.equal(mimeTypeFor('module.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(mimeTypeFor('launcher.css'), 'text/css; charset=utf-8')
  assert.equal(mimeTypeFor('web-build-manifest.json'), 'application/json; charset=utf-8')
  assert.equal(mimeTypeFor('audio/libopenmpt.wasm'), 'application/wasm')
  assert.equal(mimeTypeFor('archive.gz'), 'application/gzip')
  assert.equal(mimeTypeFor('pvz-perf.data'), 'application/octet-stream')
  assert.equal(mimeTypeFor('icon.svg'), 'image/svg+xml')
  assert.equal(mimeTypeFor('favicon.png'), 'image/png')
  assert.equal(mimeTypeFor('favicon.ico'), 'image/x-icon')
  assert.equal(mimeTypeFor('README.txt'), 'text/plain; charset=utf-8')
  assert.equal(mimeTypeFor('font.woff2'), 'font/woff2')
  assert.equal(mimeTypeFor('music.mp3'), 'audio/mpeg')
  assert.equal(mimeTypeFor('sound.ogg'), 'audio/ogg')
  assert.equal(mimeTypeFor('sound.wav'), 'audio/wav')
  assert.equal(mimeTypeFor('LAUNCHER.CSS'), 'text/css; charset=utf-8')
  assert.equal(mimeTypeFor('E:\\Games\\pvz_perf_web\\launcher.js'), 'text/javascript; charset=utf-8')
  assert.equal(mimeTypeFor('pvz-perf.wasm.gz'), 'application/gzip')
  assert.equal(mimeTypeFor('pvz-perf-webgl.wasm.gz'), 'application/gzip')
  assert.equal(mimeTypeFor('mystery.bin'), 'application/octet-stream')
  assert.equal(mimeTypeFor('no-extension'), 'application/octet-stream')
  assert.equal(mimeTypeFor(''), 'application/octet-stream')
})

test('readManifest parses version, source commit and backend', () => {
  assert.ok(MANIFEST, 'the fixture manifest must parse')
  assert.deepEqual(MANIFEST, {
    version: '3.3.4',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    backend: 'WebGPU',
  })
  assert.equal(readManifest(ALT_DIR).version, '3.3.5')
  assert.equal(readManifest(BAD_MANIFEST_DIR), null, 'invalid JSON is a null manifest, not a throw')
  assert.equal(readManifest(MISSING_DIR), null, 'a missing manifest is null, not a throw')
  assert.equal(readManifest(''), null)
})

test('isGameDir accepts only a complete web-build layout', () => {
  assert.equal(isGameDir(GAME_DIR), true)
  assert.equal(isGameDir(ALT_DIR), true)
  assert.equal(isGameDir(BAD_MANIFEST_DIR), true, 'layout check only: manifest content is readManifest\'s job')
  assert.equal(isGameDir(INCOMPLETE_DIR), false, 'needs launcher.js or pvz-perf.js')
  assert.equal(isGameDir(FIXTURES), false, 'no index.html here')
  assert.equal(isGameDir(MISSING_DIR), false)
  assert.equal(isGameDir(''), false)
})

test('resolveGameDir searches env overrides before candidates, first valid wins', () => {
  const fromFirstEnv = resolveGameDir({
    env: { DSH_PVZ_GAME_DIR: GAME_DIR, PVZ_PERF_WEB_DIR: ALT_DIR },
    candidates: [],
  })
  assert.deepEqual(fromFirstEnv, {
    dir: GAME_DIR,
    version: '3.3.4',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  })

  const fromSecondEnv = resolveGameDir({
    env: { DSH_PVZ_GAME_DIR: MISSING_DIR, PVZ_PERF_WEB_DIR: ALT_DIR },
    candidates: [],
  })
  assert.equal(fromSecondEnv.dir, ALT_DIR)
  assert.equal(fromSecondEnv.version, '3.3.5', 'a stale first env var is skipped, not fatal')

  const fromCandidates = resolveGameDir({ env: {}, candidates: [MISSING_DIR, ALT_DIR] })
  assert.equal(fromCandidates.dir, ALT_DIR)

  const padded = resolveGameDir({ env: { DSH_PVZ_GAME_DIR: '  ' + GAME_DIR + '  ' }, candidates: [] })
  assert.equal(padded.dir, GAME_DIR, 'surrounding whitespace is trimmed')

  assert.equal(resolveGameDir({ env: { DSH_PVZ_GAME_DIR: '', PVZ_PERF_WEB_DIR: '' }, candidates: [MISSING_DIR] }), null)
  assert.equal(resolveGameDir({ env: {}, candidates: [] }), null)
})

test('gameRelativePath maps game URLs to safe relative paths', () => {
  // §3: the game root maps to '' — the handler resolves that to index.html.
  assert.equal(gameRelativePath(GAME_PREFIX), '')
  assert.equal(gameRelativePath(GAME_PREFIX + '/'), '')
  assert.equal(gameRelativePath(GAME_PREFIX + '/index.html'), 'index.html')
  assert.equal(gameRelativePath(GAME_PREFIX + '/audio/music-worklet.js'), 'audio/music-worklet.js')
  assert.equal(gameRelativePath(GAME_PREFIX + '/sub/asset.bin'), 'sub/asset.bin')
  // The handler strips the query string before mapping; the helper is defensive too.
  assert.equal(gameRelativePath(GAME_PREFIX + '/index.html?cache=1'), 'index.html')
  assert.equal(gameRelativePath(GAME_PREFIX + '/sub/./asset.bin'), 'sub/asset.bin')
  // Relative form is accepted so the helper can be tested on its own.
  assert.equal(gameRelativePath('index.html'), 'index.html')
  assert.equal(gameRelativePath('audio/music-worklet.js'), 'audio/music-worklet.js')
})

test('gameRelativePath rejects traversal and malformed inputs', () => {
  const rejected = [
    GAME_PREFIX + '/%2e%2e%2fsecret.txt', // encoded ../
    GAME_PREFIX + '/..%2fsecret.txt', // ..%2f
    GAME_PREFIX + '/..\\secret.txt', // literal backslash
    GAME_PREFIX + '/..%5csecret.txt', // encoded backslash
    GAME_PREFIX + '/a/%2e%2e/b', // encoded .. in the middle
    GAME_PREFIX + '/a/..%2fb', // encoded slash before ..
    GAME_PREFIX + '/%2Fsecret.txt', // encoded absolute path
    GAME_PREFIX + '//abs', // double slash after the prefix
    GAME_PREFIX + '/secret%00.txt', // encoded NUL
    '/game/%2e%2e%2fsecret.txt', // short form is not the route prefix
    '/pvz-perf/gamefu/secret.txt', // /gamefu is a different subtree
    '/pvz-perf/status', // outside the game subtree
    '..\\secret.txt',
    'a\\b',
    '//abs',
    '../../etc/passwd',
    '/absolute/path',
    'C:/Windows/win.ini',
    '%zz', // invalid percent escape
    '/pvz-perf/game/a' + String.fromCharCode(0) + 'b', // real NUL
    null,
  ]
  for (const input of rejected) {
    assert.equal(gameRelativePath(input), null, 'should reject ' + JSON.stringify(input))
  }
})

test('GET /pvz-perf/status reports the resolved build as JSON', async () => {
  const { response, body } = await getText(main.origin + ROUTE + '/status')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8$/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(JSON.parse(body), {
    ok: true,
    dir: GAME_DIR,
    version: '3.3.4',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    gameUrl: '/pvz-perf/game/',
    hint: '',
  })
})

test('status stays 200 and explains itself when no build is found', async () => {
  const { response, body } = await getText(absent.origin + ROUTE + '/status')
  assert.equal(response.status, 200, 'status never 404s')
  const payload = JSON.parse(body)
  assert.equal(payload.ok, false)
  assert.equal(payload.dir, null)
  assert.equal(payload.version, null)
  assert.equal(payload.sourceCommit, null)
  assert.equal(payload.gameUrl, '/pvz-perf/game/')
  assert.match(payload.hint, /DSH_PVZ_GAME_DIR/)
  assert.match(payload.hint, /pvz_perf_web/)
})

test('status answers only GET and HEAD', async () => {
  const posted = await getText(main.origin + ROUTE + '/status', { method: 'POST' })
  assert.equal(posted.response.status, 405)
  assert.equal(posted.response.headers.get('allow'), 'GET, HEAD')
  const headed = await getText(main.origin + ROUTE + '/status', { method: 'HEAD' })
  assert.equal(headed.response.status, 200)
  assert.ok(Number(headed.response.headers.get('content-length')) > 0)
  assert.equal(headed.body, '')
})

test('GET serves index.html at both /game and /game/', async () => {
  for (const suffix of ['', '/']) {
    const { response, body } = await getText(main.origin + GAME_PREFIX + suffix)
    assert.equal(response.status, 200, GAME_PREFIX + suffix)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.headers.get('content-length'), String(INDEX_BYTES.length))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(body.includes('PVZ-FIXTURE-INDEX'), 'the fixture page was served')
  }
})

test('GET serves nested assets with mapped types and exact bytes', async () => {
  const cases = [
    ['launcher.js', 'text/javascript; charset=utf-8'],
    ['audio/music-worklet.js', 'text/javascript; charset=utf-8'],
    ['sub/asset.bin', 'application/octet-stream'],
    ['pvz-perf.wasm.gz', 'application/gzip'],
    ['pvz-perf.data', 'application/octet-stream'],
  ]
  for (const [name, type] of cases) {
    const { response, body } = await getBytes(main.origin + GAME_PREFIX + '/' + name)
    assert.equal(response.status, 200, name)
    assert.equal(response.headers.get('content-type'), type, name)
    assert.equal(Number(response.headers.get('content-length')), body.length, name)
    assert.equal(response.headers.get('cache-control'), 'no-store', name)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name)
    const expected = await fs.readFile(path.join(GAME_DIR, ...name.split('/')))
    assert.ok(body.equals(expected), name + ' bytes match the fixture')
  }
})

test('the compressed wasm stream carries no content-encoding', async () => {
  // The build fetches .wasm.gz and inflates it with DecompressionStream itself.
  // A content-encoding here would make the browser inflate first and the game
  // would fail on already-decompressed bytes.
  const { response } = await getBytes(main.origin + GAME_PREFIX + '/pvz-perf.wasm.gz')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/gzip')
  assert.equal(response.headers.get('content-encoding'), null)
})

test('HEAD sends the same headers with an empty body', async () => {
  const { response, body } = await getText(main.origin + GAME_PREFIX + '/', { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('content-length'), String(INDEX_BYTES.length))
  assert.equal(body, '')

  const script = await getText(main.origin + GAME_PREFIX + '/launcher.js', { method: 'HEAD' })
  const launcherBytes = await fs.readFile(path.join(GAME_DIR, 'launcher.js'))
  assert.equal(script.response.status, 200)
  assert.equal(script.response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(script.response.headers.get('content-length'), String(launcherBytes.length))
  assert.equal(script.body, '')
})

test('a missing asset is a plain-text 404, and directories are not listed', async () => {
  const missing = await getText(main.origin + GAME_PREFIX + '/nope.js')
  assert.equal(missing.response.status, 404)
  assert.match(missing.response.headers.get('content-type'), /^text\/plain; charset=utf-8$/)
  assert.ok(missing.body.length > 0)

  const directory = await getText(main.origin + GAME_PREFIX + '/sub')
  assert.equal(directory.response.status, 404, 'a directory request must not become a listing')
  assert.ok(directory.body.includes('PVZ-FIXTURE') === false)
})

test('traversal attempts never leak the file outside the game root', async () => {
  const secret = await fs.readFile(SECRET_FILE, 'utf8')
  const marker = 'TOP-SECRET-FIXTURE'
  assert.ok(secret.includes(marker), 'the fixture secret is where the test expects it')

  const attempts = [
    GAME_PREFIX + '/%2e%2e%2fsecret.txt',
    GAME_PREFIX + '/..%2fsecret.txt',
    GAME_PREFIX + '/nested/%2e%2e%2f%2e%2e%2fsecret.txt',
    GAME_PREFIX + '/%2e%2e%5csecret.txt',
    GAME_PREFIX + '/%2Fsecret.txt',
  ]
  for (const attempt of attempts) {
    const { response, body } = await getText(main.origin + attempt)
    assert.equal(response.status, 400, attempt + ' must be a traversal refusal')
    assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/, attempt)
    assert.equal(body.includes(marker), false, attempt + ' must not leak the secret')
  }

  // fetch/URL would normalize literal (and percent-encoded) dot segments before
  // sending, so these go out over a raw request path; the server itself must
  // still refuse every one of them.
  for (const rawPath of [
    GAME_PREFIX + '/../secret.txt',
    GAME_PREFIX + '/%2e%2e/%2e%2e/secret.txt',
    GAME_PREFIX + '/sub/../../secret.txt',
    GAME_PREFIX + '/..%5csecret.txt',
    GAME_PREFIX + '/../WEB-INF/web.xml',
  ]) {
    const raw = await rawRequest(main.origin, { path: rawPath })
    assert.equal(raw.status, 400, rawPath + ' must be a traversal refusal')
    assert.equal(raw.body.includes(marker), false, rawPath + ' must not leak the secret')
  }

  // The refusals must not have broken the route.
  const healthy = await getText(main.origin + GAME_PREFIX + '/index.html')
  assert.equal(healthy.response.status, 200)
  assert.ok(healthy.body.includes('PVZ-FIXTURE-INDEX'))
})

test('malformed URL encodings are refused without taking the route down', async () => {
  const bad = await getText(main.origin + GAME_PREFIX + '/%zz')
  assert.equal(bad.response.status, 400)
  const good = await getText(main.origin + GAME_PREFIX + '/index.html')
  assert.equal(good.response.status, 200)
})

test('methods other than GET and HEAD are a 405 with Allow', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { response } = await getText(main.origin + GAME_PREFIX + '/index.html', { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET, HEAD', method)
  }
})

test('unknown paths under the route prefix are 404s', async () => {
  for (const suffix of ['', '/', '/nope', '/gamefu', '/status/extra', '/gam']) {
    const { response } = await getText(main.origin + ROUTE + suffix)
    assert.equal(response.status, 404, ROUTE + suffix)
    assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/, ROUTE + suffix)
  }
})

test('a missing build serves the embedded help page on every game request', async () => {
  const page = await getText(absent.origin + GAME_PREFIX + '/')
  assert.equal(page.response.status, 200)
  assert.equal(page.response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.response.headers.get('cache-control'), 'no-store')
  assert.ok(page.body.includes('DSH_PVZ_GAME_DIR'), 'names the env override')
  assert.ok(page.body.includes('PVZ_PERF_WEB_DIR'), 'documents the second env var')
  assert.ok(page.body.includes('pvz_perf_web'), 'names the expected directory')
  assert.ok(page.body.includes('web-build-manifest.json'), 'names the marker file')

  for (const suffix of ['/index.html', '/launcher.js', '/audio/music-worklet.js']) {
    const nested = await getText(absent.origin + GAME_PREFIX + suffix)
    assert.equal(nested.response.status, 200, suffix)
    assert.match(nested.response.headers.get('content-type'), /^text\/html; charset=utf-8$/, suffix)
    assert.ok(nested.body.includes('DSH_PVZ_GAME_DIR'), suffix)
  }

  const head = await getText(absent.origin + GAME_PREFIX + '/', { method: 'HEAD' })
  assert.equal(head.response.status, 200)
  assert.match(head.response.headers.get('content-type'), /^text\/html; charset=utf-8$/)
  assert.ok(Number(head.response.headers.get('content-length')) > 0)
  assert.equal(head.body, '')
})

test('the resolver is lazy, cached once found, and retried while missing', async () => {
  let calls = 0
  let available = false
  const lazy = await startServer(createGameHandler({
    resolve: () => {
      calls += 1
      return available ? resolvedBuild() : null
    },
  }))

  const first = await getText(lazy.origin + ROUTE + '/status')
  assert.equal(JSON.parse(first.body).ok, false)
  assert.equal(calls, 1)

  const second = await getText(lazy.origin + ROUTE + '/status')
  assert.equal(JSON.parse(second.body).ok, false)
  assert.equal(calls, 2, 'still missing: every request retries the search')

  available = true
  const third = await getText(lazy.origin + ROUTE + '/status')
  assert.equal(JSON.parse(third.body).ok, true)
  assert.equal(calls, 3)

  const fourth = await getText(lazy.origin + ROUTE + '/status')
  assert.equal(JSON.parse(fourth.body).ok, true)
  assert.equal(calls, 3, 'a found build is cached')
})

test('a throwing resolver degrades to the help page instead of a crash', async () => {
  const broken = await startServer(createGameHandler({
    resolve: () => {
      throw new Error('manifest exploded')
    },
  }))
  const first = await getText(broken.origin + GAME_PREFIX + '/')
  assert.equal(first.response.status, 200)
  assert.ok(first.body.includes('DSH_PVZ_GAME_DIR'))
  const second = await getText(broken.origin + GAME_PREFIX + '/index.html')
  assert.equal(second.response.status, 200, 'the failure is not cached as a crash')
})

test('the game route streams files instead of buffering them', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /fs\.createReadStream\(/, 'the route must stream with fs.createReadStream')
  assert.doesNotMatch(source, /\bfs\.readFile\(/, 'the route must never buffer a whole game file')
})

test('parseToolkitSetups keeps valid lineups, normalises codes, skips the rest', async () => {
  const text = await fs.readFile(path.join(TOOLKIT_ROOT, 'PvZ_Toolkit_Test', 'setups.yml'), 'utf8')
  const parsed = parseToolkitSetups(text)
  assert.deepEqual(parsed.lineups.map((lineup) => lineup.name), ['[DE] 双核无炮', '[DE] 长矛无炮', '我的阵型'])
  assert.equal(parsed.skipped, 3, 'one duplicate, one junk line and one short code are skipped')
  for (const lineup of parsed.lineups) {
    assert.match(lineup.code, /^[A-Za-z0-9+/]{16,164}={0,2}$/)
    assert.equal(lineup.code.length % 4, 0, 'codes are padded for the game decoder')
  }
  const urlSafe = parseToolkitSetups('"n": ' + 'A'.repeat(16) + '-_A=')
  assert.equal(urlSafe.lineups[0].raw_code, undefined)
  assert.match(urlSafe.lineups[0].code, /^[A-Za-z0-9+/]+={0,2}$/, 'URL-safe characters are normalised')
})

test('findToolkitSetups scans Toolkit directories and honours the env override', async () => {
  const byRoot = findToolkitSetups({ env: {}, roots: [TOOLKIT_ROOT] })
  assert.ok(byRoot, 'the fixture Toolkit directory is found')
  assert.equal(byRoot.lineups.length, 3)
  assert.ok(byRoot.file.endsWith('setups.yml'))
  assert.match(byRoot.version, /^3:\d+$/)

  const byEnv = findToolkitSetups({
    env: { DSH_PVZ_TOOLKIT_DIR: path.join(TOOLKIT_ROOT, 'PvZ_Toolkit_Test', 'setups.yml') },
    roots: [MISSING_DIR],
  })
  assert.ok(byEnv, 'a direct .yml path is accepted')
  assert.equal(byEnv.lineups.length, 3)

  assert.equal(findToolkitSetups({ env: {}, roots: [MISSING_DIR] }), null, 'a missing Toolkit yields null')
})

test('the toolkit route answers the parsed list and degrades to an empty hint', async () => {
  const found = await startServer(createToolkitHandler({
    resolve: () => findToolkitSetups({ env: {}, roots: [TOOLKIT_ROOT] }),
  }))
  const answer = await fetch(found.origin + TOOLKIT_ROUTE)
  assert.equal(answer.status, 200)
  const payload = await answer.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.count, 3)
  assert.equal(payload.lineups.length, 3)
  assert.ok(payload.version.length > 0)
  assert.ok(payload.file.endsWith('setups.yml'))

  const missing = await startServer(createToolkitHandler({ resolve: () => null }))
  const absentPayload = await (await fetch(missing.origin + TOOLKIT_ROUTE)).json()
  assert.equal(absentPayload.ok, false)
  assert.equal(absentPayload.count, 0)
  assert.ok(absentPayload.hint.includes('PvZ_Toolkit'), 'the hint names the expected Toolkit folder')

  const rejected = await fetch(found.origin + TOOLKIT_ROUTE, { method: 'POST' })
  assert.equal(rejected.status, 405)
})

test('apply registers one prefix route and logs the resolved build', () => {
  const previous = process.env.DSH_PVZ_GAME_DIR
  process.env.DSH_PVZ_GAME_DIR = GAME_DIR
  try {
    const routes = []
    const logs = []
    const ctx = {
      effect: (fn) => fn(),
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
      logger: {
        info: (line) => logs.push(line),
        warn: (line) => logs.push(line),
      },
    }
    apply(ctx)
    assert.equal(routes.length, 2, 'the game prefix route plus the exact toolkit route')
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, ROUTE)
    assert.equal(typeof routes[0].handler, 'function')
    assert.equal(routes[1].kind, 'exact')
    assert.equal(routes[1].path, TOOLKIT_ROUTE)
    assert.equal(typeof routes[1].handler, 'function')
    assert.equal(logs.length, 1, 'exactly one log line on activation')
    assert.ok(logs[0].includes(GAME_DIR), 'the log names the resolved directory')
    assert.ok(logs[0].includes('3.3.4'), 'the log names the build version')
  } finally {
    if (previous === undefined) delete process.env.DSH_PVZ_GAME_DIR
    else process.env.DSH_PVZ_GAME_DIR = previous
  }
})

test('apply stays defensive when the composition hands over an incomplete logger', () => {
  // The handler path is fully covered above with an explicit null resolver; this
  // only pins down that apply itself tolerates a logger without the methods it
  // wants, which is the shape a half-initialized composition could hand over.
  const previous = process.env.DSH_PVZ_GAME_DIR
  process.env.DSH_PVZ_GAME_DIR = MISSING_DIR
  try {
    const routes = []
    const ctx = {
      effect: (fn) => fn(),
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      logger: {},
    }
    assert.doesNotThrow(() => apply(ctx))
  } finally {
    if (previous === undefined) delete process.env.DSH_PVZ_GAME_DIR
    else process.env.DSH_PVZ_GAME_DIR = previous
  }
})
