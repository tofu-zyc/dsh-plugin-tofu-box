/**
 * Build the shippable single-file client bundle from src/parts/.
 *
 * The plugin ships exactly one browser file (client.js): a
 * `window.__ModuleLoader__.load({ id, factory })` call. To keep that contract
 * while letting several people edit the code, the sources live in
 * src/parts/*.js and are concatenated in manifest order into client.js.
 * The parts are NOT modules: they share the factory closure scope, so this is
 * a pure textual split and the build output is byte-stable.
 *
 * Usage:
 *   node tools/build-client.mjs           write client.js
 *   node tools/build-client.mjs --check   exit 1 when client.js is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('src/manifest.json', root), 'utf8'))
const parts = manifest.parts.map(part => readFileSync(new URL('src/parts/' + part.file, root), 'utf8'))
const text = parts.join('\n')
const target = new URL('client.js', root)
const check = process.argv.includes('--check')
if (check) {
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch { current = 'MISSING' }
  if (current !== text) {
    console.error('client.js is stale: run node tools/build-client.mjs')
    process.exit(1)
  }
  console.log('client.js is up to date (' + parts.length + ' parts)')
} else {
  writeFileSync(target, text)
  console.log('client.js written from ' + parts.length + ' parts, ' + Buffer.byteLength(text) + ' bytes')
}
