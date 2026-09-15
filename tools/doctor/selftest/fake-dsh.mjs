// Fake dsh for doctor self-test. Scenario picked by FAKE_SCENARIO env:
//
// named (default) — scripted via counter file; entries whose id is disabled
//   via the --patch overlay are not reported (mirroring the real loader audit):
//   boot #1 → fail to load: bad-plugin, bad2-plugin
//   boot #2 → bad2 pending; success if bad2 is disabled by overlay
//   boot #3+ → success (stays alive until killed)
//   plugin update: bad-plugin → exit 0; anything else → exit 1
//
// mystery — boot always dies with an anonymous stack (no plugin named, no
//   node_modules frame); alive only once id 'bad' is disabled. Update of any
//   plugin exits 1. Exercises doctor's bisect.
//
// mystery-stack — same boot behavior, but the stack contains a
//   node_modules\bad-plugin frame; updating bad-plugin succeeds yet fixes
//   nothing. Exercises stack-guess + suspect-queue + update-noop.
//
// --dump-config → prints an id/name map (all scenarios)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const scenario = process.env.FAKE_SCENARIO || 'named'
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

// Mirror the real dsh 0.1.5+ guard: the `web` subcommand REJECTS a parent
// --profile. Without this, the selftest cannot catch argv-shape regressions
// in doctor's own boot invocation (a bare `web` after `--profile <p>` must fail).
let sawParentProfile = false
for (let i = 0; i < argv.length; i++) {
  const t = argv[i]
  if (t === '--profile' || t === '--patch') {
    if (t === '--profile') sawParentProfile = true
    i++ // consume the option's value
    continue
  }
  if (t === 'web' && argv[0] !== 'plugin' && !argv.includes('--dump-config') && sawParentProfile) {
    console.error('error: web takes none of parent --profile, --from-default-profile, --patch, --dump-config, or --dump-default-config')
    process.exit(1)
  }
}

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
  if (scenario === 'mystery') process.exit(1) // no update fixes the mystery boot
  process.exit(name === 'bad-plugin' ? 0 : 1) // mystery-stack: update "works", changes nothing
}

const alive = () => {
  console.log('fake dsh web: listening on http://127.0.0.1:13080')
  setInterval(() => {}, 1000)
}

if (scenario === 'mystery' || scenario === 'mystery-stack') {
  count(1)
  if (!disabledIds.has('bad')) {
    const frame = scenario === 'mystery-stack'
      ? '    at Object.apply (C:\\Users\\dev\\.dsh\\profiles\\web\\node_modules\\bad-plugin\\lib\\index.js:12:3)\n'
      : ''
    console.error(`dsh: fatal: unhandled rejection during startup
TypeError: Cannot read properties of undefined (reading 'register')
${frame}    at CordisRealm.mount (file:///C:/Users/dev/AppData/Roaming/npm/node_modules/@deepseek-ai/cordis/lib/realm.js:212:14)
    at boot (file:///C:/Users/dev/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1525:3)`)
    process.exit(1)
  }
  console.log('fake dsh web: listening on http://127.0.0.1:13080')
  setInterval(() => {}, 1000)
} else {
  namedScenario()
}

// named scenario
function namedScenario() {
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
  alive()
}
