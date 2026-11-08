/**
 * Pose an AI-authored sprite rig into animation frames.
 *
 * The artwork comes from a generated image (see tools/pixel/ai_rig.py), sliced
 * into a torso and a set of legs. This module owns the motion: for each frame it
 * rotates every leg about its hip by a phase, bobs the torso, and composites the
 * parts into one atlas cell. Nothing here invents pixels - it only moves the ones
 * already drawn, which is why the animals keep their detail while gaining a gait.
 */

import { readFileSync } from 'node:fs'
import { CELL_W, CELL_H, DESIGN_SCALE } from './creatures.mjs'

/** Ground row inside the atlas cell, in output pixels. */
const CELL_GROUND = Math.round(39.5 * DESIGN_SCALE)

/**
 * Load a rig model written by ai_rig.py.
 * @param {string} path - path to the model JSON.
 * @returns {object} model with typed arrays instead of the JSON lists.
 */
export function loadRig(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const pixels = raw.width * raw.height
  return {
    name: raw.name,
    width: raw.width,
    height: raw.height,
    ground: raw.ground,
    belly: raw.belly,
    pixels,
    rgba: Uint8Array.from(raw.rgba),
    torso: Uint8Array.from(raw.torsoMask),
    legs: raw.legs.map((leg) => ({
      // leg.x is [pivotColumn, pivotRow] in the model JSON.
      x: leg.x[0],
      y: leg.x[1],
      mask: Uint8Array.from(leg.mask),
    })),
    head: raw.headMask === undefined ? null : {
      x: raw.headPivot[0],
      y: raw.headPivot[1],
      mask: Uint8Array.from(raw.headMask),
    },
    tail: raw.tailMask === undefined ? null : {
      x: raw.tailPivot[0],
      y: raw.tailPivot[1],
      mask: Uint8Array.from(raw.tailMask),
    },
  }
}

/**
 * Sample one model pixel.
 * @param {object} model - the rig.
 * @param {number} index - pixel index.
 * @returns {boolean} true when that pixel is painted.
 */
function painted(model, index) {
  return model.rgba[index * 4 + 3] > 0
}

/**
 * Composite one leg, rotated by an angle around its hip pivot.
 *
 * Inverse mapping, not forward mapping: for every destination pixel we ask which
 * source pixel lands there. Forward mapping leaves gaps in a rotated thin limb.
 * @param {Uint8Array} out - destination RGBA cell.
 * @param {object} model - the rig.
 * @param {object} leg - the leg record.
 * @param {number} angle - rotation in radians.
 * @param {number} offsetX - cell column of the model origin.
 * @param {number} offsetY - cell row of the model origin.
 * @param {number} shade - brightness multiplier for far legs.
 * @returns {void}
 */
function drawLeg(out, model, leg, angle, offsetX, offsetY, shade) {
  const cos = Math.cos(-angle)
  const sin = Math.sin(-angle)
  const pivotX = leg.x
  const pivotY = leg.y
  const spanX = Math.ceil(model.width * 1.1)
  const spanY = Math.ceil(model.height * 1.6)
  for (let y = -spanY; y <= spanY; y += 1) {
    for (let x = -spanX; x <= spanX; x += 1) {
      const sourceX = pivotX + x * cos - y * sin
      const sourceY = pivotY + x * sin + y * cos
      const sx = Math.round(sourceX)
      const sy = Math.round(sourceY)
      if (sx < 0 || sy < 0 || sx >= model.width || sy >= model.height) continue
      const index = sy * model.width + sx
      if (leg.mask[index] === 0 || !painted(model, index)) continue
      const destX = Math.round(pivotX + x + offsetX)
      const destY = Math.round(pivotY + y + offsetY)
      if (destX < 0 || destY < 0 || destX >= CELL_W || destY >= CELL_H) continue
      const target = (destY * CELL_W + destX) * 4
      if (out[target + 3] !== 0) continue
      const source = index * 4
      out[target] = Math.min(255, model.rgba[source] * shade)
      out[target + 1] = Math.min(255, model.rgba[source + 1] * shade)
      out[target + 2] = Math.min(255, model.rgba[source + 2] * shade)
      out[target + 3] = 255
    }
  }
}

/**
 * Composite the torso: head, neck, body and tail move as one rigid piece.
 * @param {Uint8Array} out - destination RGBA cell.
 * @param {object} model - the rig.
 * @param {number} offsetX - cell column of the model origin.
 * @param {number} offsetY - cell row of the model origin.
 * @returns {void}
 */
function drawTorso(out, model, offsetX, offsetY) {
  for (let y = 0; y < model.height; y += 1) {
    for (let x = 0; x < model.width; x += 1) {
      const index = y * model.width + x
      if (model.torso[index] === 0 || !painted(model, index)) continue
      const destX = x + offsetX
      const destY = y + offsetY
      if (destX < 0 || destY < 0 || destX >= CELL_W || destY >= CELL_H) continue
      const target = (destY * CELL_W + destX) * 4
      const source = index * 4
      out[target] = model.rgba[source]
      out[target + 1] = model.rgba[source + 1]
      out[target + 2] = model.rgba[source + 2]
      out[target + 3] = 255
    }
  }
}

/**
 * Leg phase per gait, in cycle fractions.
 *
 * A four-beat walk lands the feet a quarter cycle apart. A gallop gathers the
 * hind pair, then the front pair, and spends part of the cycle airborne. The
 * list is read left to right along the body, so a rig with more than four
 * detected legs still distributes its phases sensibly.
 * @param {string} anim - idle, walk or run.
 * @param {number} count - how many legs the rig has.
 * @returns {number[]} phase per leg.
 */
function legPhases(anim, count) {
  if (anim === 'run') {
    const gallop = [0.5, 0.6, 0.02, 0.1, 0.3, 0.42]
    return Array.from({ length: count }, (_, i) => gallop[i % gallop.length])
  }
  return Array.from({ length: count }, (_, i) => i / count)
}

/**
 * Render one animation frame of one rigged creature.
 * @param {object} model - rig from loadRig.
 * @param {string} anim - idle, walk or run.
 * @param {number} index - frame index.
 * @returns {Uint8Array} RGBA bytes of one atlas cell.
 */
export function renderRigFrame(model, anim, index) {
  const out = new Uint8Array(CELL_W * CELL_H * 4)
  const offsetX = Math.round((CELL_W - model.width) / 2)
  const groundRow = CELL_GROUND - 2
  const bob = anim === 'idle'
    ? (index % 2 === 0 ? 0 : -1)
    : (anim === 'run' ? [0, -1, -2, -1][index % 4] : [0, -1, 0, -1][index % 4])
  const offsetY = groundRow - model.ground + bob

  const swing = anim === 'idle' ? 0 : (anim === 'run' ? 0.3 : 0.15)
  const phases = legPhases(anim, model.legs.length)
  const order = model.legs.map((leg, i) => ({ leg, i })).sort((a, b) => a.leg.x - b.leg.x)
  // Every leg goes behind the barrel; the barrel then covers the hip end of each
  // one. Alternating shades give the far pair depth.
  const cycle = (index / 4) * Math.PI * 2
  // Tail goes behind the body, head in front of it, so each part hides its own
  // seam where the rig cut it.
  if (model.tail !== null) {
    drawLeg(out, model, model.tail, Math.sin(cycle) * (swing === 0 ? 0.05 : swing * 0.5),
      offsetX, offsetY, 0.9)
  }
  order.forEach((entry, orderIndex) => {
    const far = orderIndex % 2 === 0
    const angle = swing === 0
      ? 0
      : Math.sin((index / 4 + phases[entry.i]) * Math.PI * 2) * swing
    drawLeg(out, model, entry.leg, angle, offsetX, offsetY, far ? 0.82 : 1)
  })
  drawTorso(out, model, offsetX, offsetY)
  if (model.head !== null) {
    drawLeg(out, model, model.head, Math.sin(cycle + Math.PI * 0.5) * (swing === 0 ? 0.03 : swing * 0.25),
      offsetX, offsetY, 1)
  }
  return out
}

/**
 * Display size for a rig: how big the animal should look at 6x zoom.
 * @param {object} model - the rig.
 * @param {number} targetWidth - wanted on-screen width in pixels at 6x.
 * @returns {number} ATLAS_SIZE multiplier.
 */
export function rigDisplaySize(model, targetWidth) {
  return targetWidth / model.width
}

