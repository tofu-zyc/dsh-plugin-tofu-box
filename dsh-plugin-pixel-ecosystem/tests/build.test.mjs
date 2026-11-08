/**
 * The shipped bundle is generated: src/parts/*.js are concatenated by
 * tools/build-client.mjs into client.js. Every other suite boots client.js, so
 * a stale build would mean the tests exercise code nobody edited.
 *
 * This suite is the freshness gate. Run `node tools/build-client.mjs` after
 * editing any part.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('src/manifest.json', root), 'utf8'))
const shipped = readFileSync(new URL('client.js', root), 'utf8')

const readPart = part => readFileSync(new URL('src/parts/' + part.file, root), 'utf8')

test('the manifest lists every part and nothing else', () => {
  assert.ok(Array.isArray(manifest.parts))
  assert.ok(manifest.parts.length >= 20, 'engine, renderer, store and UI live in separate parts')
  const files = manifest.parts.map(part => part.file)
  assert.equal(new Set(files).size, files.length, 'duplicate part in the manifest')
  for (const part of manifest.parts) {
    assert.match(part.file, /^\d\d[a-z]?-[a-z0-9-]+\.js$/, part.file + ' is not NN[a]-name.js')
    assert.equal(typeof part.description, 'string')
    assert.ok(part.description.length > 0, part.file + ' has no description')
  }
  const sorted = [...files].sort()
  assert.deepEqual(files, sorted, 'parts must stay in filename order')
})

test('every part is non-empty and uses no module syntax', () => {
  for (const part of manifest.parts) {
    const text = readPart(part)
    assert.ok(text.trim().length > 0, part.file + ' is empty')
    assert.doesNotMatch(text, /^\s*(import|export)\s/m, part.file + ' must not use module syntax: parts share one closure')
  }
})

test('client.js is exactly the concatenation of the parts', () => {
  const built = manifest.parts.map(readPart).join('\n')
  assert.equal(shipped, built, 'client.js is stale: run node tools/build-client.mjs')
})
test('no identifier is declared by two parts', () => {
  // All parts share one closure, so a duplicate top-level declaration is a
  // SyntaxError in the built bundle and takes the whole panel down. This is how
  // two owners ended up both declaring DRIVE_KEYS.
  const DECLARATION = /^    (?:(?:async\s+)?function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
  const seen = new Map()
  const clashes = []
  for (const part of manifest.parts) {
    const text = readPart(part)
    for (const match of text.matchAll(DECLARATION)) {
      const name = match[1]
      const key = part.file + '\u0000' + name
      if (seen.has(key)) clashes.push(name + ' declared twice in ' + part.file)
      seen.set(key, part.file)
      const owner = seen.get(name)
      if (owner === undefined) seen.set(name, part.file)
      else if (owner !== part.file) clashes.push(name + ': ' + owner + ' + ' + part.file)
    }
  }
  assert.deepEqual(clashes, [], 'duplicate top-level declarations across parts')
})
test('the bundle parses (a SyntaxError takes the whole panel down)', () => {
  assert.doesNotThrow(() => new Function(shipped), 'client.js does not parse')
})
test('the build stamp matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const preamble = readFileSync(new URL('src/parts/00-preamble.js', root), 'utf8')
  const match = preamble.match(/const BUILD_VERSION = '([^']+)'/)
  assert.ok(match, 'BUILD_VERSION must exist in 00-preamble.js')
  assert.equal(match[1], pkg.version, 'BUILD_VERSION drifted from package.json: bump both together')
})
