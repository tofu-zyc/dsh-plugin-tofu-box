// Fake dsh for doctor self-test. Boots get scripted via a counter file;
// entries whose id is disabled via the --patch overlay are not reported
// (mirroring the real loader audit, which skips disabled rows):
//   boot #1 → fail to load: bad-plugin, bad2-plugin
//   boot #2 → bad2 pending; success if bad2 is disabled by overlay
//   boot #3+ → success (stays alive until killed)
// plugin update: bad-plugin → exit 0; anything else → exit 1
// --dump-config → prints an id/name map
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const state = process.env.SELFTEST_STATE
const count = (n) => {
  const c = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0
  writeFileSync(state, String(c + n))
  return c
}
const disabledIds = (() => {
  const i = argv.indexOf('--patch')
  if (i === -1) return new Set()
  try {
    const txt = readFileSync(argv[i + 1], 'utf8')
    return new Set([...txt.matchAll(/id:\s*(\S+)/g)].map((m) => m[1]))
  } catch { return new Set() }
})()

if (argv.includes('--dump-config')) {
  console.log(`# == bad-bundle
- id: bad
  name: bad-plugin
- id: bad2
  name: bad2-plugin
- id: good
  name: good-plugin`)
  process.exit(0)
}
if (argv[0] === 'plugin') {
  const name = argv[argv.length - 1]
  console.log(`fake: pnpm update ${name}`)
  process.exit(name === 'bad-plugin' ? 0 : 1)
}
// boot invocation
const blame = (id) => !disabledIds.has(id)
const n = count(1)
if (n === 0) {
  const culprits = ['bad-plugin', 'bad2-plugin'].filter((_, idx) => blame(idx === 0 ? 'bad' : 'bad2'))
  if (culprits.length > 0) {
    console.error(`dsh: fatal load failure: plugin(s) failed to load: ${culprits.join(', ')}; Cordis startup failed because these plugin(s) could not be resolved`)
    process.exit(1)
  }
}
if (n === 1 && blame('bad2')) {
  console.error('dsh: 1 entry did not activate\nbad2-plugin: pending (waiting for service: tools)')
  process.exit(1)
}
console.log('fake dsh web: listening on http://127.0.0.1:13080')
setInterval(() => {}, 1000)
