/**
 * Render one frame of the terrarium to a PNG, headlessly.
 *
 * The plugin ships a single-file browser bundle, so visual work is otherwise
 * blind: nobody can see a change without opening the panel. This script boots
 * the real bundle in Node (same harness the tests use), runs the world forward,
 * paints a camera window with the shipped renderer and writes a PNG. Use it to
 * diff before/after of any render change.
 *
 *   node tools/render-scene.mjs                        # summer, centre of map
 *   node tools/render-scene.mjs --day 4.64 --out .review/winter.png
 *   node tools/render-scene.mjs --seed 31 --w 320 --h 200 --zoom 4
 *
 * Options: --seed --day (game days) --x --y --w --h (cells) --zoom --out
 *          --alpha (motion interpolation 0..1)
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { encodePng } from './pixel/png.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const num = (name, fallback) => {
  const raw = arg(name, null)
  return raw === null ? fallback : Number(raw)
}

const seed = num('seed', 777)
const day = num('day', 1.2)
const width = num('w', 240)
const height = num('h', 150)
const zoom = num('zoom', 4)
const alpha = num('alpha', 1)
const out = resolve(arg('out', '.review/scene.png'))

const { boot } = await import(new URL('../tests/_harness.mjs', import.meta.url).href)
const { engine } = boot()
const { createWorld, stepWorld, paintView, TICK, DAY_SECONDS, YEAR_DAYS } = engine

const world = createWorld({ seed })
const ticks = Math.max(0, Math.round((day * DAY_SECONDS) / TICK))
for (let i = 0; i < ticks; i += 1) stepWorld(world, TICK)

const x = num('x', Math.max(0, Math.round((world.width - width) / 2)))
const y = num('y', Math.max(0, Math.round((world.height - height) / 2)))
const view = { x, y, width, height, scale: zoom }
const buffer = new Uint32Array(width * height)
paintView(world, view, buffer, alpha, null, { sprites: true, plants: true })

// The frame buffer is little-endian ARGB; the PNG wants RGBA, nearest-neighbour
// upscaled so the pixel art stays crisp.
const outW = width * zoom
const outH = height * zoom
const rgba = new Uint8Array(outW * outH * 4)
for (let row = 0; row < height; row += 1) {
  for (let col = 0; col < width; col += 1) {
    const word = buffer[row * width + col]
    const r = word & 0xff
    const g = (word >>> 8) & 0xff
    const b = (word >>> 16) & 0xff
    for (let dy = 0; dy < zoom; dy += 1) {
      let index = ((row * zoom + dy) * outW + col * zoom) * 4
      for (let dx = 0; dx < zoom; dx += 1) {
        rgba[index] = r
        rgba[index + 1] = g
        rgba[index + 2] = b
        rgba[index + 3] = 255
        index += 4
      }
    }
  }
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(outW, outH, rgba))

// Read the climate, do not re-derive it: docs/20-CORE-LOOP.md makes the climate
// the single source of season/day state, and the engine applies a start offset
// that a naive time/YEAR_SECONDS formula would miss by more than a season.
const yearPhase = world.climate?.yearPhase ?? ((world.time / DAY_SECONDS) / YEAR_DAYS) % 1
const counts = {}
for (const entity of world.entities) counts[entity.species] = (counts[entity.species] ?? 0) + 1
console.log(JSON.stringify({
  out, seed, day: Number((world.time / DAY_SECONDS).toFixed(2)),
  yearPhase: Number(yearPhase.toFixed(3)),
  window: [x, y, width, height], zoom, size: [outW, outH],
  entities: world.entities.length, counts,
}, null, 1))
