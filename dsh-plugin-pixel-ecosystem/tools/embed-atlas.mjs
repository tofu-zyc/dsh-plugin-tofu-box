
/**
 * Embed the built atlas into client.js.
 *
 * The client bundle is a single file with no runtime asset loading, so the PNG
 * travels as base64 and the slot table is regenerated here from assets/atlas.json.
 * Run tools/build-atlas.mjs first.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const clientPath = resolve(root, 'client.js')
const meta = JSON.parse(readFileSync(resolve(root, 'assets/atlas.json'), 'utf8'))
const base64 = readFileSync(resolve(root, 'assets/atlas.png')).toString('base64')

let source = readFileSync(clientPath, 'utf8')

if (!/const SPRITE_ATLAS_PNG = '[^']*'/.test(source)) throw new Error('SPRITE_ATLAS_PNG assignment not found')
source = source.replace(
  /const SPRITE_ATLAS_PNG = '[^']*'/,
  "const SPRITE_ATLAS_PNG = '" + base64 + "'",
)

const slotLines = Object.entries(meta.slots).map(([id, roles]) => {
  const parts = []
  for (const role of ['idle', 'walk', 'run']) {
    if (roles[role] === undefined) continue
    parts.push(role + ': [' + roles[role].join(', ') + ']')
  }
  return "      " + id + ": { " + parts.join(', ') + " },"
}).join('\n')

const sizeLines = Object.entries(meta.display).map(([id, value]) => "      " + id + ': ' + value + ',').join('\n')
const gaitLines = Object.entries(meta.gait).map(([id, value]) => "      " + id + ': ' + value + ',').join('\n')

const block = [
  '    /** Atlas geometry: one cell per animation frame, feet on the baseline. */',
  '    const ATLAS = { cellWidth: ' + meta.cellWidth + ', cellHeight: ' + meta.cellHeight
    + ', columns: ' + meta.columns + ', baseline: ' + meta.baseline + ' }',
  '    /** Frame slot list per species: two idle frames and a four-frame gait cycle. */',
  '    const ATLAS_SLOTS = {',
  slotLines,
  '    }',
  '    /** Display size of each species relative to the atlas cell at 6x zoom. */',
  '    const ATLAS_SIZE = {',
  sizeLines,
  '    }',
  '    /** Gait cycles per cell travelled: a hop is short, a wolf stride is long. */',
  '    const ATLAS_GAIT = {',
  gaitLines,
  '    }',
].join('\n')

const startOfBlock = source.indexOf('/** Atlas geometry')
const endOfBlock = source.indexOf('    const atlas = { started: false, ready: false, image: null }')
if (startOfBlock < 0 || endOfBlock < 0) throw new Error('atlas constant block not found')
source = source.slice(0, startOfBlock) + block + '\n\n' + source.slice(endOfBlock)

writeFileSync(clientPath, source)
console.log('embedded atlas:', base64.length, 'base64 chars;', Object.keys(meta.slots).length, 'species')
