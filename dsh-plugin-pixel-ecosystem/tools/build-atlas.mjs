
/**
 * Build the creature atlas from the pixel models.
 *
 * Two outputs:
 *  - assets/atlas.png: the shipped artwork (packed 64x59 cells).
 *  - assets/atlas.json: cell geometry and the slot table client.js uses.
 *
 * Run with --preview to also write .scratch/atlas-preview.png, which is the
 * 4x contact sheet used to eyeball the gait frames.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { encodePng } from './pixel/png.mjs'
import { CREATURES, CELL_W, CELL_H, BASELINE, ANIM_ROLES, renderFrame } from './pixel/creatures.mjs'
import { loadRig, renderRigFrame, rigDisplaySize } from './pixel/rig.mjs'

/**
 * Species whose artwork comes from a generated image and is posed by the rig
 * renderer (tools/pixel/ai_rig.py -> assets/models/<id>.json). The number is the
 * wanted on-screen width in pixels at 6x zoom, which becomes ATLAS_SIZE.
 * Species not listed here fall back to the procedural models in creatures.mjs.
 */
const RIG_TARGET = { wolf: 40, deer: 44, fox: 36, bear: 44, rabbit: 28, otter: 34 }

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PREVIEW = process.argv.includes('--preview')
const COLUMNS = 8

const rigs = {}
for (const [id, targetWidth] of Object.entries(RIG_TARGET)) {
  const modelPath = resolve(root, 'assets/models/' + id + '.json')
  if (!existsSync(modelPath)) continue
  const model = loadRig(modelPath)
  // A separate rig cut from a galloping pose: rotating the standing legs can
  // never produce a real gallop silhouette, but a rig cut from one can.
  const runPath = resolve(root, 'assets/models/' + id + '-run.json')
  const runModel = existsSync(runPath) ? loadRig(runPath) : null
  rigs[id] = { model, runModel, display: rigDisplaySize(model, targetWidth) }
}

const species = Object.keys(CREATURES)
const slots = {}
const plan = []
for (const id of species) {
  slots[id] = {}
  for (const role of ANIM_ROLES) {
    const frames = CREATURES[id][role]
    // Not every species needs every cycle: a crow has no walk, a fish has no
    // legs. Missing roles are simply absent from the slot table and the renderer
    // falls back to run.
    if (frames === undefined) continue
    slots[id][role] = []
    for (let i = 0; i < frames.length; i += 1) {
      slots[id][role].push(plan.length)
      plan.push({ id, role, index: i })
    }
  }
}

const rows = Math.ceil(plan.length / COLUMNS)
const atlasW = COLUMNS * CELL_W
const atlasH = rows * CELL_H
const atlas = new Uint8Array(atlasW * atlasH * 4)

const bounds = {}
for (let slot = 0; slot < plan.length; slot += 1) {
  const { id, role, index } = plan[slot]
  const rig = rigs[id]
  const rigModel = rig === undefined ? null : (role === 'run' && rig.runModel !== null ? rig.runModel : rig.model)
  const cell = rig === undefined ? renderFrame(id, role, index) : renderRigFrame(rigModel, role, index)
  const baseX = (slot % COLUMNS) * CELL_W
  const baseY = Math.floor(slot / COLUMNS) * CELL_H
  let minX = CELL_W
  let maxX = 0
  let minY = CELL_H
  let maxY = 0
  for (let y = 0; y < CELL_H; y += 1) {
    for (let x = 0; x < CELL_W; x += 1) {
      const source = (y * CELL_W + x) * 4
      if (cell[source + 3] === 0) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      const target = ((baseY + y) * atlasW + (baseX + x)) * 4
      atlas[target] = cell[source]
      atlas[target + 1] = cell[source + 1]
      atlas[target + 2] = cell[source + 2]
      atlas[target + 3] = 255
    }
  }
  const box = bounds[id] ?? (bounds[id] = { minX: CELL_W, maxX: 0, minY: CELL_H, maxY: 0 })
  box.minX = Math.min(box.minX, minX)
  box.maxX = Math.max(box.maxX, maxX)
  box.minY = Math.min(box.minY, minY)
  box.maxY = Math.max(box.maxY, maxY)
}

mkdirSync(resolve(root, 'assets'), { recursive: true })
const png = encodePng(atlasW, atlasH, atlas)
writeFileSync(resolve(root, 'assets/atlas.png'), png)

/** Art bounding box per creature, printed so clipping is obvious at build time. */
const SIZE = {}
for (const id of Object.keys(bounds)) {
  const box = bounds[id]
  const width = box.maxX - box.minX + 1
  const height = box.maxY - box.minY + 1
  SIZE[id] = { width, height, top: box.minY }
}

const meta = {
  cellWidth: CELL_W,
  cellHeight: CELL_H,
  columns: COLUMNS,
  // Display baseline: the row that lands on the animal's ground position. Feet
  // are drawn at BASELINE - 1.5, so one pixel up keeps the outline on the floor.
  baseline: BASELINE - 1,
  slots,
  display: Object.fromEntries(Object.keys(CREATURES).map((id) => [id, rigs[id]?.display ?? CREATURES[id].display ?? 1])),
  gait: Object.fromEntries(Object.keys(CREATURES).map((id) => [id, CREATURES[id].gait ?? 0.25])),
}
writeFileSync(resolve(root, 'assets/atlas.json'), JSON.stringify(meta, null, 2) + '\n')

console.log('atlas', atlasW + 'x' + atlasH, 'cells', plan.length, 'png bytes', png.length)
for (const id of Object.keys(SIZE)) {
  const s = SIZE[id]
  console.log('  ' + id.padEnd(8) + ' art ' + s.width + 'x' + s.height + ' top=' + s.top)
}
if (PREVIEW) {
  const scale = 4
  const pad = 6
  const sheetW = COLUMNS * (CELL_W * scale + pad) + pad
  const sheetH = rows * (CELL_H * scale + pad) + pad
  const sheet = new Uint8Array(sheetW * sheetH * 4)
  const checker = (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? 46 : 38)
  for (let y = 0; y < sheetH; y += 1) {
    for (let x = 0; x < sheetW; x += 1) {
      const index = (y * sheetW + x) * 4
      const value = checker(x, y)
      sheet[index] = value
      sheet[index + 1] = value
      sheet[index + 2] = value + 6
      sheet[index + 3] = 255
    }
  }
  for (let slot = 0; slot < plan.length; slot += 1) {
    const baseX = (slot % COLUMNS) * (CELL_W * scale + pad) + pad
    const baseY = Math.floor(slot / COLUMNS) * (CELL_H * scale + pad) + pad
    for (let y = 0; y < CELL_H * scale; y += 1) {
      for (let x = 0; x < CELL_W * scale; x += 1) {
        const source = ((Math.floor(y / scale)) * CELL_W + Math.floor(x / scale)) * 4
        if (atlas[((Math.floor(slot / COLUMNS) * CELL_H + Math.floor(y / scale)) * atlasW
          + (slot % COLUMNS) * CELL_W + Math.floor(x / scale)) * 4 + 3] === 0) continue
        const target = ((baseY + y) * sheetW + (baseX + x)) * 4
        const atlasIndex = ((Math.floor(slot / COLUMNS) * CELL_H + Math.floor(y / scale)) * atlasW
          + (slot % COLUMNS) * CELL_W + Math.floor(x / scale)) * 4
        sheet[target] = atlas[atlasIndex]
        sheet[target + 1] = atlas[atlasIndex + 1]
        sheet[target + 2] = atlas[atlasIndex + 2]
        sheet[target + 3] = 255
      }
    }
  }
  mkdirSync(resolve(root, '.scratch'), { recursive: true })
  writeFileSync(resolve(root, '.scratch/atlas-preview.png'), encodePng(sheetW, sheetH, sheet))
  console.log('preview written')
}
writeFileSync(resolve(root, '.scratch/atlas-base64.txt'), png.toString('base64'))
console.log('base64 chars', png.toString('base64').length)
