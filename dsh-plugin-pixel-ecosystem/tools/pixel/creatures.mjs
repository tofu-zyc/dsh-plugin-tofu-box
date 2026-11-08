/**
 * Creature pixel models.
 *
 * Every animal is a small rig — barrel, head, neck, tail, four limbs — re-posed
 * per frame instead of being drawn as a separate hand-made sprite. That is what
 * makes a real four-frame gait possible: the legs are placed by the pose data,
 * so the walk cycle is authored as numbers, not as four unrelated pictures.
 *
 * Anatomy notes that the shapes below follow, because getting these wrong is the
 * difference between "a deer" and "a green blob with legs":
 *
 * - Digitigrade mammals stand on their toes. The joint that points BACKWARD on a
 *   hind leg is the hock (the ankle), roughly two thirds of the way down; the
 *   knee points forward and sits in the upper third. Front legs are close to
 *   vertical with the elbow tucked backward under the chest.
 *   Reference: https://www.skeletaldrawing.com/blog/um-hey-scientific-american-bird-knees/
 * - Body length from point of shoulder to buttock is about 1.0-1.1 x shoulder
 *   height in a dog-shaped animal, and smaller in a bear (compact) or an otter
 *   (long). Leg length runs from 38% of shoulder height (bear) to 56% (deer).
 * - Front and hind legs are the SAME length; a quadruped's back is level because
 *   the two pairs attach at the same height.
 *
 * Art is authored in a 48 x 44 design grid and rendered into a 64 x 59 cell, so
 * every landmark lands on a finer pixel grid without re-deriving the numbers.
 */

import { Raster } from './raster.mjs'

/** Output cell size in atlas pixels. */
export const CELL_W = 64
export const CELL_H = 59
/** Design-space size (what the numbers below are written in). */
export const DESIGN_W = 48
export const DESIGN_H = 44
/** Design units per output pixel. */
export const DESIGN_SCALE = CELL_W / DESIGN_W
/** The ground row in output pixels: the design ground line, scaled up. */
export const BASELINE = Math.round(39.5 * DESIGN_SCALE)
/** Where feet touch, in design space. */
const GROUND = 39.5

/** Shorthand for a material record. */
function material(color, light, dark, outline, flat) {
  return { color, light, dark, outline, flat }
}

/**
 * Build the shade materials a creature needs from a base hue.
 *
 * Four body tones, not one: rim light on the top edge (from composeFrame), a lit
 * band under the back, the base coat, and a shaded underside. The edge material
 * is a flat copy of the outline colour: limbs are drawn once in edge and once in
 * their own colour, which is what separates a leg from the body it overlaps.
 * @param {number[]} base - mid tone RGB.
 * @param {number[]} outline - outline RGB.
 * @returns {Record<string, object>} body materials.
 */
function bodyMaterials(base, outline) {
  const shift = (amount) => base.map((channel) => Math.max(0, Math.min(255, channel + amount)))
  return {
    body: material(base, shift(26), shift(-30), outline),
    bodyLight: material(shift(28), shift(46), shift(6), outline),
    bodyShade: material(shift(-24), shift(-8), shift(-44), outline),
    bodyFar: material(shift(-40), shift(-24), shift(-60), outline),
    belly: material(shift(58), shift(76), shift(34), outline),
    edge: material(outline, outline, outline, outline, true),
  }
}

/**
 * Draw a segmented limb through joint positions, tapering toward the toe, with a
 * wider edge pass underneath so it stays readable over the body.
 * @param {Raster} r - raster.
 * @param {number[][]} joints - hip → joint → joint → toe, in design space.
 * @param {number} thickness - limb width at the top.
 * @param {string} name - upper limb material.
 * @param {boolean} edge - draw the separating edge pass.
 * @param {{material?: string, from?: number}} [lower] - distal segment override.
 * @returns {void}
 */
function drawChain(r, joints, thickness, name, edge, lower) {
  const lowerFrom = lower?.from ?? 2
  const materialAt = (index) => (lower !== undefined && index >= lowerFrom ? lower.material : name)
  if (edge) {
    for (let i = 0; i + 1 < joints.length; i += 1) {
      r.limb(joints[i][0], joints[i][1], joints[i + 1][0], joints[i + 1][1],
        thickness * (1 - i * 0.08) + 1.5, 'edge')
    }
  }
  for (let i = 0; i + 1 < joints.length; i += 1) {
    r.limb(joints[i][0], joints[i][1], joints[i + 1][0], joints[i + 1][1],
      thickness * (1 - i * 0.14), materialAt(i))
  }
  const [toeX, toeY] = joints[joints.length - 1]
  r.ellipse(toeX, toeY - 0.25, thickness * 0.78, thickness * 0.44,
    materialAt(joints.length - 2))
}

/**
 * A front leg of a walking mammal: shoulder → elbow → wrist → toe.
 *
 * The elbow points backward and sits tucked under the chest; the forearm is
 * close to vertical. Drawing the front leg like a hind leg — which a single
 * generic knee joint does — is the most obvious way to make a quadruped look
 * wrong.
 * @param {Raster} r - raster.
 * @param {number} shoulderX - shoulder column.
 * @param {number} shoulderY - shoulder row.
 * @param {number} footX - toe column.
 * @param {number} footY - toe row.
 * @param {number} thickness - limb width.
 * @param {string} name - upper limb material.
 * @param {number} fold - 0 planted, 1 fully folded during the swing.
 * @param {boolean} edge - draw the separating edge pass.
 * @param {object} [lower] - distal segment override (socks, hooves).
 * @returns {void}
 */
function drawFrontLeg(r, shoulderX, shoulderY, footX, footY, thickness, name, fold, edge = true, lower) {
  const span = Math.max(2, footY - shoulderY)
  const elbowX = shoulderX - 1.1 - fold * 1
  const elbowY = shoulderY + span * 0.38
  const wristX = footX - 0.3
  const wristY = footY - span * 0.18
  drawChain(r, [[shoulderX, shoulderY], [elbowX, elbowY], [wristX, wristY], [footX, footY]],
    thickness, name, edge, lower)
}

/**
 * A hind leg of a digitigrade mammal: hip → knee → hock → toe.
 *
 * The knee points forward in the upper third, the hock points backward about two
 * thirds of the way down, and only the toes touch the ground. That
 * backward-pointing hock is the shape people read as "animal leg".
 * @param {Raster} r - raster.
 * @param {number} hipX - hip column.
 * @param {number} hipY - hip row.
 * @param {number} footX - toe column.
 * @param {number} footY - toe row.
 * @param {number} thickness - limb width.
 * @param {string} name - upper limb material.
 * @param {number} fold - 0 planted, 1 folded during the swing.
 * @param {boolean} edge - draw the separating edge pass.
 * @param {boolean} [plantigrade] - bear-style flat foot: shorter levers.
 * @param {object} [lower] - distal segment override (socks, hooves).
 * @returns {void}
 */
function drawHindLeg(r, hipX, hipY, footX, footY, thickness, name, fold, edge = true, plantigrade = false, lower) {
  const span = Math.max(2, footY - hipY)
  const kneeForward = plantigrade ? 1 : 1.4
  const hockBack = plantigrade ? 1.2 : 2.2
  const kneeX = hipX + kneeForward + fold * 1.4
  const kneeY = hipY + span * (plantigrade ? 0.3 : 0.34)
  const hockX = hipX - hockBack - fold * 1.1
  const hockY = hipY + span * (plantigrade ? 0.6 : 0.66)
  drawChain(r, [[hipX, hipY], [kneeX, kneeY], [hockX, hockY], [footX, footY]],
    thickness, name, edge, lower)
}

/**
 * A bird leg: hip → ankle → toe.
 *
 * What looks like a backwards knee on a bird is the ankle; the real knee is
 * tucked up inside the feathers. One visible backward joint is the whole shape.
 * @param {Raster} r - raster.
 * @param {number} hipX - hip column.
 * @param {number} hipY - hip row.
 * @param {number} footX - toe column.
 * @param {number} footY - toe row.
 * @param {number} thickness - limb width.
 * @param {string} name - leg material.
 * @param {boolean} edge - draw the separating edge pass.
 * @returns {void}
 */
function drawBirdLeg(r, hipX, hipY, footX, footY, thickness, name, edge = false) {
  const span = Math.max(2, footY - hipY)
  drawChain(r, [[hipX, hipY], [hipX - 1.2, hipY + span * 0.45], [footX, footY]], thickness, name, edge)
}

/**
 * An ellipse with a separating edge ring under it.
 * @param {Raster} r - raster.
 * @param {number} cx - centre column.
 * @param {number} cy - centre row.
 * @param {number} rx - radius x.
 * @param {number} ry - radius y.
 * @param {string} name - fill material.
 * @returns {void}
 */
function edgedEllipse(r, cx, cy, rx, ry, name) {
  r.ellipse(cx, cy, rx + 1, ry + 1, 'edge')
  r.ellipse(cx, cy, rx, ry, name)
}

/**
 * A band of colour hugging a line, with a sawtooth far edge that reads as fur.
 *
 * Real pelts are not flat fills: there is a lit strip along the spine and a
 * shaded strip along the belly, and both boundaries are broken up rather than
 * smooth. A one-pixel zigzag does that at this resolution.
 * @param {Raster} r - raster.
 * @param {number[]} from - start point [x, y].
 * @param {number[]} to - end point [x, y].
 * @param {number} thickness - band depth in design units.
 * @param {number} jag - sawtooth amplitude.
 * @param {string} name - material.
 * @param {boolean} [upward] - band goes toward smaller y.
 * @returns {void}
 */
function furBand(r, from, to, thickness, jag, name, upward = false) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  const steps = Math.max(3, Math.round(length))
  const top = []
  const bottom = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const x = from[0] + (to[0] - from[0]) * t
    const y = from[1] + (to[1] - from[1]) * t
    top.push([x, y])
    const tooth = i % 2 === 0 ? 0 : jag
    bottom.push([x, y + (upward ? -(thickness + tooth) : thickness + tooth)])
  }
  r.polygon(top.concat(bottom.reverse()), name)
}

/**
 * Draw one quadruped from body landmarks.
 *
 * A quadruped is a barrel with a front and a rear, not a circle: the back line
 * runs from the withers (top of the shoulder) to the croup (top of the rump), the
 * chest hangs lower than the belly, and the limbs hang off the two ends.
 * @param {Raster} r - target raster.
 * @param {object} spec - body landmarks (see the species table below).
 * @param {object} pose - offsets for this frame.
 * @returns {void}
 */
function drawQuadruped(r, spec, pose) {
  const dy = pose.bodyY ?? 0
  const groundY = spec.ground ?? GROUND
  const withersX = spec.withers[0]
  const withersY = spec.withers[1] + dy
  const croupX = spec.croup[0]
  const croupY = spec.croup[1] + dy
  const brisketY = spec.brisket
  const bellyY = brisketY - (spec.bellyLift ?? 2)
  const depth = brisketY - withersY
  const plantigrade = spec.plantigrade === true

  const rear = spec.legs.hind
  const front = spec.legs.front
  const rearPose = pose.hind ?? [0, 0]
  const frontPose = pose.front ?? [0, 0]
  const rearFarPose = pose.hindFar ?? rearPose
  const frontFarPose = pose.frontFar ?? frontPose
  const rearLift = rearPose[1] ?? 0
  const frontLift = frontPose[1] ?? 0

  // Front and hind legs attach at the SAME height, one unit above the brisket.
  // That equality is what keeps the back level.
  const hipY = brisketY - 1
  const shoulderY = brisketY - 1
  const hindLower = spec.socks === true ? { material: 'sock', from: 2 } : undefined
  const frontLower = spec.socks === true ? { material: 'sock', from: 2 } : undefined
  const hoof = spec.hooves === true ? { material: 'hoof', from: 3 } : undefined

  // --- far pair, behind the barrel -----------------------------------------
  // The far pair sits just one unit behind and one shade darker. It is not a
  // second animal: keep it thin and let the barrel cover everything above the
  // belly line.
  drawHindLeg(r, rear.x - 1.2, hipY - 0.3, rear.x - 1.2 + (rearFarPose[0] ?? 0), groundY - (rearFarPose[1] ?? 0) + 0.4,
    rear.thickness * 0.76, 'bodyFar', (rearFarPose[1] ?? 0) * 0.8, false, plantigrade, hindLower)
  drawFrontLeg(r, front.x - 1.2, shoulderY + 0.2, front.x - 1.2 + (frontFarPose[0] ?? 0), groundY - (frontFarPose[1] ?? 0) + 0.4,
    front.thickness * 0.76, 'bodyFar', (frontFarPose[1] ?? 0) * 0.8, false, frontLower)

  // --- tail ----------------------------------------------------------------
  if (spec.tail !== undefined) {
    const tail = spec.tail
    const sway = (pose.tail ?? 0) * 0.7
    const baseX = croupX + 0.4
    const baseY = croupY + (tail.dy ?? 1.6)
    const tipX = baseX + (tail.dx ?? -4) + sway
    const tipY = baseY + (tail.dy2 ?? 2.2)
    if (tail.bushy === true) {
      const midX = baseX + (tail.dx ?? -4) * 0.5 + sway * 0.5
      const midY = baseY + (tail.dy2 ?? 2.2) * 0.35
      const radius = tail.r ?? 2
      r.ellipse(midX, midY, radius + 0.9, radius * 0.95 + 0.9, 'edge')
      r.ellipse(tipX, tipY, radius * 0.95 + 0.9, radius * 0.9 + 0.9, 'edge')
      r.ellipse(midX, midY, radius, radius * 0.95, 'tail')
      r.ellipse(tipX, tipY, radius * 0.95, radius * 0.9, 'tail')
      // A lit strip along the top of the tail.
      furBand(r, [midX, midY - radius * 0.5], [tipX, tipY - radius * 0.4], radius * 0.45, 0.3, 'bodyLight')
      if (tail.tip !== undefined) r.ellipse(tipX - 0.5, tipY - 0.3, tail.tip, tail.tip * 0.85, 'tailTip')
    } else {
      r.limb(baseX, baseY, tipX, tipY, (tail.thickness ?? 1.6) + 1.5, 'edge')
      r.limb(baseX, baseY, tipX, tipY, tail.thickness ?? 1.6, 'tail')
    }
  }

  // --- barrel --------------------------------------------------------------
  const buttockY = croupY + depth * 0.62
  const bellyBackX = croupX + depth * 0.22
  const bellyFrontX = withersX - depth * 0.28
  // The belly line rises toward the loin (the "tuck"): a level belly line is
  // what makes a barrel read as a sausage.
  const bellyBackY = bellyY - depth * 0.14
  // The back is an arc, not a chord: a straight top edge reads as a plastic tube.
  const backCurve = []
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4
    const sag = Math.sin(Math.PI * t) * (spec.backDip ?? 1)
    const rise = i === 0 ? -(spec.shoulderRise ?? 0.8) : 0
    backCurve.push([
      withersX + (croupX - withersX) * t,
      withersY + (croupY - withersY) * t + sag + rise,
    ])
  }
  // Shoulder mass and loin dip: a perfectly straight back line is the other half
  // of the "tube" problem.
  r.polygon([
    ...backCurve,
    [croupX - 0.6, buttockY],
    [bellyBackX, bellyBackY],
    [bellyFrontX, bellyY],
    [withersX + 0.8, brisketY],
  ], 'body')
  // Round off the two ends so the barrel is not a hexagon.
  r.ellipse(withersX - depth * 0.2, brisketY - depth * 0.44, depth * 0.36, depth * 0.48, 'body')
  r.ellipse(croupX + depth * 0.22, croupY + depth * 0.36, depth * 0.32, depth * 0.42, 'body')
  // Shoulder and haunch bulges: the two masses a mammal's silhouette is built on.
  r.ellipse(withersX - depth * 0.12, withersY + depth * 0.16, depth * 0.3, depth * 0.34, 'body')
  r.ellipse(croupX + depth * 0.26, croupY + depth * 0.2, depth * 0.32, depth * 0.38, 'body')

  // Lit strip along the spine and a shaded strip above the belly.
  for (let i = 0; i + 1 < backCurve.length; i += 1) {
    furBand(r, [backCurve[i][0], backCurve[i][1] + 0.9], [backCurve[i + 1][0], backCurve[i + 1][1] + 0.9],
      Math.max(1, depth * 0.1), 0.6, 'bodyLight')
  }
  furBand(r, [bellyFrontX + 0.5, bellyY], [bellyBackX - 0.5, bellyBackY], Math.max(1, depth * 0.1), 0.45, 'bodyShade', true)

  // Species markings that sit on the coat, before the belly takes its turn.
  if (spec.markSaddle === true) {
    r.polygon([
      [withersX + 1, withersY + depth * 0.1],
      [croupX + 0.5, croupY + depth * 0.12],
      [croupX + depth * 0.15, croupY + depth * 0.52],
      [withersX - depth * 0.2, withersY + depth * 0.62],
    ], 'mark')
  }
  if (spec.markRump === true) {
    r.ellipse(croupX + depth * 0.16, croupY + depth * 0.3, depth * 0.26, depth * 0.3, 'mark')
  }
  // Underbelly band, last so it wins over the shading.
  r.polygon([
    [bellyBackX - 0.8, bellyBackY],
    [croupX + 0.5, buttockY - 1],
    [bellyFrontX + 1, bellyY],
    [withersX + 0.2, brisketY - 0.8],
    [withersX - depth * 0.22, brisketY - 1.4],
    [bellyFrontX + depth * 0.16, bellyY - depth * 0.1],
  ], 'belly')
  if (spec.chestBib === true) {
    // A pale throat and chest, tucked between the front legs — not a bib plate
    // across the whole brisket.
    r.ellipse(withersX - depth * 0.06, withersY + depth * 0.58, depth * 0.16, depth * 0.26, 'bodyLight')
  }
  if (spec.flankSpots !== undefined) {
    for (const spot of spec.flankSpots) {
      r.ellipse(withersX - (withersX - croupX) * spot[0], withersY + depth * spot[1], spot[2], spot[2] * 0.8, 'spot')
    }
  }

  // --- neck and head -------------------------------------------------------
  const head = spec.head
  const headX = head.x + (pose.headX ?? 0)
  const headY = head.y + dy + (pose.headY ?? 0)
  const neckBaseX = withersX - 1.2
  const neckBaseY = withersY + depth * 0.28
  if (spec.neck !== undefined) {
    const neck = spec.neck
    r.limb(neckBaseX, neckBaseY, headX - head.rx * 0.55, headY + head.ry * 0.55,
      (neck.thickness ?? 3) + 1.5, 'edge')
    r.limb(neckBaseX, neckBaseY, headX - head.rx * 0.55, headY + head.ry * 0.55,
      neck.thickness ?? 3, 'body')
    // Lit top edge of the neck, and a mane down the back of it.
    furBand(r, [neckBaseX + 0.4, neckBaseY - (neck.thickness ?? 3) * 0.4],
      [headX - head.rx * 0.6, headY + head.ry * 0.2], Math.max(0.8, (neck.thickness ?? 3) * 0.28), 0.35, 'bodyLight')
    if (spec.mane === true) {
      // A ruff: a short fur collar where the neck meets the shoulder, plus the
      // mane running up the back of the neck.
      r.ellipse(neckBaseX + 0.2, neckBaseY + 0.2, (neck.thickness ?? 3) * 0.85, (neck.thickness ?? 3) * 0.95, 'mark')
      r.limb(neckBaseX - 0.6, neckBaseY - (neck.thickness ?? 3) * 0.5,
        headX - head.rx * 0.75, headY - head.ry * 0.15, (neck.thickness ?? 3) * 0.5, 'mark')
    }
  }
  edgedEllipse(r, headX, headY, head.rx, head.ry, 'body')
  // Skull highlight + cheek shadow give the head a direction.
  r.ellipse(headX - head.rx * 0.15, headY - head.ry * 0.42, head.rx * 0.62, head.ry * 0.34, 'bodyLight')
  r.ellipse(headX - head.rx * 0.05, headY + head.ry * 0.5, head.rx * 0.6, head.ry * 0.3, 'bodyShade')
  if (spec.muzzle !== undefined) {
    const muzzle = spec.muzzle
    const fill = muzzle.material ?? 'belly'
    if (muzzle.wedge === true) {
      // A canid snout is a wedge, not a snout-shaped lump: wide at the cheek,
      // narrow at the nose, with the lip line running forward.
      const baseX = headX + muzzle.dx - muzzle.rx
      const tipX = headX + muzzle.dx + muzzle.rx
      const wedge = [
        [baseX, headY + muzzle.dy - muzzle.ry],
        [tipX, headY + muzzle.dy - muzzle.ry * 0.5],
        [tipX, headY + muzzle.dy + muzzle.ry * 0.55],
        [baseX, headY + muzzle.dy + muzzle.ry],
      ]
      r.polygon(wedge.map(([x, y]) => [x, y - 0.8]).concat([[tipX + 1, headY + muzzle.dy]]), 'edge')
      r.polygon(wedge.map(([x, y]) => [x, y + 0.8]), 'edge')
      r.polygon(wedge, fill)
      r.limb(baseX + 0.6, headY + muzzle.dy + muzzle.ry * 0.6, tipX - 0.4, headY + muzzle.dy + muzzle.ry * 0.4, 0.6, 'bodyShade')
    } else {
      r.ellipse(headX + muzzle.dx, headY + muzzle.dy, muzzle.rx + 0.9, muzzle.ry + 0.9, 'edge')
      r.ellipse(headX + muzzle.dx, headY + muzzle.dy, muzzle.rx, muzzle.ry, fill)
      r.limb(headX + muzzle.dx - muzzle.rx * 0.7, headY + muzzle.dy + muzzle.ry * 0.7,
        headX + muzzle.dx + muzzle.rx * 0.6, headY + muzzle.dy + muzzle.ry * 0.5, 0.7, 'bodyShade')
    }
  }
  if (spec.ears !== undefined) {
    for (const ear of spec.ears) {
      const lift = pose.earLift ?? 0
      const ex = headX + ear.dx
      const ey = headY + ear.dy
      const tx = ex + ear.tx
      const ty = ey + ear.ty - lift
      if (ear.pointed === true) {
        // A pointed ear is a triangle, not a stick: two edges meeting at a tip.
        const half = ear.thickness * 0.7
        const base = [[ex - half, ey], [ex + half, ey], [tx, ty]]
        r.polygon([[ex - half - 0.7, ey + 0.4], [ex + half + 0.7, ey + 0.4], [tx, ty - 0.7]], 'edge')
        r.polygon(base, ear.material ?? 'body')
        r.polygon([[ex - half * 0.5, ey], [ex + half * 0.5, ey], [tx, ty + 0.6]], 'earInner')
      } else {
        r.limb(ex, ey, tx, ty, ear.thickness + 1.4, 'edge')
        r.limb(ex, ey, tx, ty, ear.thickness, ear.material ?? 'body')
        if (ear.inner !== false) {
          r.limb(ex + ear.tx * 0.25, ey + ear.ty * 0.25 - 0.3, ex + ear.tx * 0.78, ey + ear.ty * 0.78 - 0.4,
            ear.thickness * 0.4, 'earInner')
        }
      }
    }
  }
  if (spec.horns !== undefined) {
    for (const horn of spec.horns) {
      const baseX = headX + horn.dx
      const baseY = headY + horn.dy
      r.limb(baseX, baseY, baseX + horn.tx, baseY + horn.ty, (horn.thickness ?? 1.4) + 1.4, 'edge')
      r.limb(baseX, baseY, baseX + horn.tx, baseY + horn.ty, horn.thickness ?? 1.4, 'horn')
      for (const tine of horn.tines ?? []) {
        const px = baseX + horn.tx * tine.at
        const py = baseY + horn.ty * tine.at
        r.limb(px, py, px + tine.tx, py + tine.ty, 1.4, 'horn')
      }
    }
  }

  // --- near pair -----------------------------------------------------------
  // Clipped at the belly line. The thigh belongs to the barrel silhouette; a leg
  // painted from the middle of the body is what makes a quadruped look like a
  // stilt bolted to a balloon. Only the part below the belly is drawn.
  r.clipped({ minY: bellyY - 0.2 }, () => {
    drawHindLeg(r, rear.x, hipY, rear.x + (rearPose[0] ?? 0), groundY - rearLift,
      rear.thickness, 'leg', rearLift * 0.8, true, plantigrade, hoof ?? hindLower)
    drawFrontLeg(r, front.x, shoulderY, front.x + (frontPose[0] ?? 0), groundY - frontLift,
      front.thickness, 'leg', frontLift * 0.8, true, hoof ?? frontLower)
  })

  // --- face ----------------------------------------------------------------
  if (spec.eye !== undefined) {
    const eye = spec.eye
    const ex = headX + eye.dx
    const ey = headY + eye.dy
    r.ellipse(ex, ey, (eye.r ?? 1) + 0.5, (eye.r ?? 1) + 0.5, 'edge')
    r.ellipse(ex, ey, eye.r ?? 1, eye.r ?? 1, 'eye')
    r.ellipse(ex + 0.4, ey - 0.4, 0.5, 0.5, 'glint')
  }
  if (spec.pupil !== undefined) {
    r.ellipse(headX + spec.pupil.dx, headY + spec.pupil.dy, 0.85, 0.85, 'pupil')
  }
  if (spec.nose !== undefined) {
    const nose = spec.nose
    r.ellipse(headX + nose.dx, headY + nose.dy, 1.15, 0.9, 'nose')
  }
}

// ---------------------------------------------------------------------------
// Quadruped species
//
// Landmarks are written in a 48 x 44 design grid with the ground at y = 39.5.
// The ratios behind them (all measured against shoulder height H, the distance
// from the withers to the ground):
//
//   species  H(px)  legs/H  chest/H  body(shoulder->buttock)/H
//   wolf      24    0.50    0.48     1.10   working-dog standard, level back
//   deer      24    0.56    0.45     1.20   leggy, shallow chest
//   fox       17    0.46    0.48     1.15   long and low
//   bear      25    0.38    0.63     0.90   compact, deep, short-legged
//   otter     12    0.44    0.46     1.80   body twice as long as it is tall
//   rabbit    14    0.40    0.57     1.00   crouched, rump higher than withers
//   frog       8    0.40    0.55     1.60   squat, no neck
//
// Legs are digitigrade (only the toes touch down) except the bear, which is
// plantigrade. Front and hind pairs attach at the same height, which is why the
// back is level.
// ---------------------------------------------------------------------------

const RABBIT = {
  materials: {
    ...bodyMaterials([176, 148, 118], [58, 42, 32]),
    leg: material([166, 138, 108], [190, 162, 132], [132, 106, 80], [58, 42, 32]),
    tail: material([240, 236, 228], [252, 250, 246], [206, 200, 192], [58, 42, 32]),
    tailTip: material([252, 250, 246], [255, 255, 255], [216, 212, 206], [58, 42, 32]),
    earInner: material([216, 158, 158], [232, 176, 176], [186, 128, 130], [58, 42, 32]),
    eye: material([30, 22, 18], undefined, undefined, undefined, true),
    glint: material([252, 252, 252], undefined, undefined, undefined, true),
    nose: material([216, 148, 150], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [26, 25.5], croup: [13, 23.2], backDip: 1.8,
    brisket: 33.9, bellyLift: 2.4,
    legs: { hind: { x: 18, thickness: 3.5 }, front: { x: 27, thickness: 2.5 } },
    neck: { thickness: 3.9 },
    head: { x: 32.2, y: 22, rx: 4.7, ry: 4.4 },
    tail: { dx: -2.8, dy: 1.2, dy2: 2, r: 2.3, bushy: true },
    ears: [
      { dx: -0.6, dy: -3.2, tx: -1.6, ty: -5.6, thickness: 2.1 },
      { dx: 2, dy: -3, tx: -0.2, ty: -6.2, thickness: 2.1 },
    ],
    muzzle: { dx: 2.2, dy: 1.6, rx: 2.2, ry: 1.8 },
    eye: { dx: 1.4, dy: -1.2, r: 1.05 },
    nose: { dx: 3.4, dy: 1.4 },
  },
}

const DEER = {
  materials: {
    ...bodyMaterials([152, 106, 64], [42, 28, 18]),
    leg: material([136, 92, 54], [160, 114, 72], [106, 70, 40], [42, 28, 18]),
    hoof: material([36, 30, 28], [50, 42, 38], [24, 20, 18], [42, 28, 18]),
    mark: material([242, 236, 226], [252, 248, 242], [210, 204, 194], [42, 28, 18]),
    tail: material([242, 236, 226], [252, 248, 242], [210, 204, 194], [42, 28, 18]),
    horn: material([198, 176, 130], [222, 202, 160], [164, 142, 100], [42, 28, 18]),
    spot: material([226, 204, 166], [238, 220, 188], [202, 180, 144], [42, 28, 18]),
    earInner: material([176, 128, 96], [196, 148, 112], [148, 104, 76], [42, 28, 18]),
    eye: material([26, 20, 16], undefined, undefined, undefined, true),
    glint: material([252, 252, 252], undefined, undefined, undefined, true),
    nose: material([36, 26, 22], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [33, 15.5], croup: [4.4, 16.2], backDip: 0.9,
    brisket: 26.1, bellyLift: 2.8,
    hooves: true, markRump: true,
    legs: { hind: { x: 10.5, thickness: 3.5 }, front: { x: 29.5, thickness: 3.2 } },
    neck: { thickness: 4.2 },
    head: { x: 37.6, y: 13.4, rx: 4.1, ry: 4.2 },
    tail: { dx: -1.6, dy: 0, dy2: 1.2, r: 1.7, bushy: true },
    ears: [
      { dx: -1.4, dy: -2.2, tx: -2.8, ty: -2.8, thickness: 1.9 },
      { dx: 1, dy: -2.6, tx: 1.2, ty: -3, thickness: 1.9 },
    ],
    horns: [
      { dx: -0.8, dy: -3.6, tx: -2.6, ty: -3.6, thickness: 1.7, tines: [{ at: 0.62, tx: -2.4, ty: -1.6 }] },
      { dx: 1.6, dy: -3.8, tx: -1, ty: -4, thickness: 1.7, tines: [{ at: 0.68, tx: 2.4, ty: -1.4 }] },
    ],
    muzzle: { dx: 2.2, dy: 1.4, rx: 2.1, ry: 1.7 },
    eye: { dx: 1, dy: -1, r: 0.95 },
    nose: { dx: 3.4, dy: 1.3 },
    flankSpots: [[0.26, 0.36, 0.5], [0.4, 0.54, 0.45], [0.55, 0.34, 0.5], [0.68, 0.52, 0.45], [0.18, 0.56, 0.4], [0.84, 0.4, 0.4]],
  },
}

const FOX = {
  materials: {
    ...bodyMaterials([212, 118, 56], [54, 28, 15]),
    leg: material([172, 90, 42], [198, 112, 58], [140, 70, 32], [54, 28, 15]),
    sock: material([44, 34, 32], [60, 48, 44], [30, 22, 20], [54, 28, 15]),
    belly: material([250, 240, 226], [255, 252, 244], [226, 214, 198], [54, 28, 15]),
    tail: material([216, 122, 58], [236, 144, 76], [182, 96, 42], [54, 28, 15]),
    tailTip: material([250, 244, 232], [255, 252, 246], [224, 216, 202], [54, 28, 15]),
    earInner: material([246, 224, 208], [255, 240, 228], [216, 194, 178], [54, 28, 15]),
    eye: material([36, 26, 18], undefined, undefined, undefined, true),
    glint: material([252, 252, 252], undefined, undefined, undefined, true),
    nose: material([32, 24, 20], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [28.5, 22.5], croup: [9, 23.1], backDip: 1,
    brisket: 31.7, bellyLift: 2,
    socks: true, chestBib: true,
    legs: { hind: { x: 13.5, thickness: 3.4 }, front: { x: 26.5, thickness: 3 } },
    neck: { thickness: 4 },
    head: { x: 32.6, y: 19.8, rx: 4.2, ry: 4 },
    tail: { dx: -5.6, dy: 0.2, dy2: 2.6, r: 2.6, bushy: true, tip: 1.9 },
    ears: [
      { dx: -1.4, dy: -3.2, tx: -1.4, ty: -4, thickness: 2.6, pointed: true },
      { dx: 1.4, dy: -3.4, tx: 0.6, ty: -4.2, thickness: 2.6, pointed: true },
    ],
    muzzle: { dx: 2.6, dy: 1.4, rx: 2.2, ry: 1.3, wedge: true, material: 'body' },
    eye: { dx: 1, dy: -1, r: 0.95 },
    nose: { dx: 3.8, dy: 1.3 },
  },
}

const WOLF = {
  materials: {
    ...bodyMaterials([132, 138, 150], [26, 30, 38]),
    leg: material([122, 128, 140], [146, 152, 164], [94, 100, 112], [26, 30, 38]),
    mark: material([84, 90, 102], [102, 108, 120], [62, 68, 78], [26, 30, 38]),
    belly: material([206, 208, 214], [222, 224, 230], [176, 178, 186], [26, 30, 38]),
    tail: material([132, 138, 150], [152, 158, 170], [104, 110, 122], [26, 30, 38]),
    tailTip: material([52, 56, 66], [70, 74, 84], [38, 42, 50], [26, 30, 38]),
    earInner: material([150, 142, 138], [172, 164, 160], [120, 112, 108], [26, 30, 38]),
    eye: material([236, 210, 100], undefined, undefined, undefined, true),
    glint: material([255, 255, 255], undefined, undefined, undefined, true),
    nose: material([24, 26, 32], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [32, 15.5], croup: [5.6, 16.3], backDip: 0.8,
    brisket: 27.5, bellyLift: 2.6,
    markSaddle: true, mane: true, chestBib: true,
    legs: { hind: { x: 11.5, thickness: 4 }, front: { x: 29.5, thickness: 3.7 } },
    neck: { thickness: 5.4 },
    head: { x: 36.4, y: 12.8, rx: 4.9, ry: 4.5 },
    tail: { dx: -5, dy: 1.2, dy2: 3, r: 2.4, bushy: true, tip: 1.8 },
    ears: [
      { dx: -1.8, dy: -3.6, tx: -1.2, ty: -3.4, thickness: 3, pointed: true },
      { dx: 1.6, dy: -3.8, tx: 0.6, ty: -3.6, thickness: 3, pointed: true },
    ],
    muzzle: { dx: 3.4, dy: 1.7, rx: 3.2, ry: 1.5, wedge: true, material: 'body' },
    eye: { dx: 1, dy: -1.1, r: 0.95 },
    nose: { dx: 4.4, dy: 1.1 },
  },
}

const BEAR = {
  materials: {
    ...bodyMaterials([108, 82, 62], [20, 14, 9]),
    leg: material([98, 74, 56], [124, 96, 74], [74, 54, 40], [20, 14, 9]),
    mark: material([82, 60, 44], [100, 76, 58], [60, 42, 30], [20, 14, 9]),
    belly: material([146, 116, 86], [166, 136, 104], [120, 92, 66], [20, 14, 9]),
    tail: material([108, 82, 62], [128, 100, 76], [84, 62, 46], [20, 14, 9]),
    earInner: material([128, 100, 82], [148, 118, 98], [100, 76, 60], [20, 14, 9]),
    eye: material([26, 18, 12], undefined, undefined, undefined, true),
    glint: material([250, 250, 250], undefined, undefined, undefined, true),
    nose: material([38, 26, 18], undefined, undefined, undefined, true),
  },
  spec: {
    plantigrade: true,
    withers: [30, 14.5], croup: [7.5, 15.2], backDip: 1.2,
    brisket: 30, bellyLift: 2.4,
    markSaddle: true, mane: true,
    legs: { hind: { x: 12.5, thickness: 4.5 }, front: { x: 27.5, thickness: 4.1 } },
    neck: { thickness: 6.4 },
    head: { x: 34.4, y: 13.6, rx: 5.3, ry: 4.9 },
    tail: { dx: -1.4, dy: 1, dy2: 1.4, r: 1.8, bushy: true },
    ears: [
      { dx: -1.4, dy: -4, tx: -0.8, ty: -2.2, thickness: 2.5 },
      { dx: 2, dy: -4.2, tx: 0.6, ty: -2.4, thickness: 2.5 },
    ],
    muzzle: { dx: 3, dy: 1.7, rx: 2.9, ry: 2.2 },
    eye: { dx: 1.2, dy: -1.2, r: 1.05 },
    nose: { dx: 4.4, dy: 1.3 },
  },
}

const OTTER = {
  materials: {
    ...bodyMaterials([122, 86, 60], [26, 16, 10]),
    leg: material([106, 74, 52], [130, 96, 70], [80, 56, 38], [26, 16, 10]),
    belly: material([204, 168, 126], [222, 186, 144], [174, 140, 102], [26, 16, 10]),
    tail: material([106, 74, 52], [130, 96, 70], [80, 56, 38], [26, 16, 10]),
    earInner: material([142, 106, 82], [162, 126, 100], [112, 82, 62], [26, 16, 10]),
    eye: material([24, 18, 14], undefined, undefined, undefined, true),
    glint: material([250, 250, 250], undefined, undefined, undefined, true),
    nose: material([46, 32, 24], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [29, 27.5], croup: [7.4, 27], backDip: 1,
    brisket: 34.2, bellyLift: 1.6,
    legs: { hind: { x: 13, thickness: 2.8 }, front: { x: 26, thickness: 2.6 } },
    neck: { thickness: 5 },
    head: { x: 33, y: 26.2, rx: 4.6, ry: 4.1 },
    tail: { dx: -6.4, dy: 0.8, thickness: 2.5 },
    ears: [
      { dx: -1.2, dy: -2.8, tx: -1, ty: -1.2, thickness: 2 },
      { dx: 1, dy: -3, tx: 0.6, ty: -1.4, thickness: 2 },
    ],
    muzzle: { dx: 2.5, dy: 1.1, rx: 2.4, ry: 1.8 },
    eye: { dx: 1, dy: -0.8, r: 1 },
    nose: { dx: 4.2, dy: 0.8 },
  },
}

const FROG = {
  materials: {
    ...bodyMaterials([118, 170, 80], [18, 34, 14]),
    leg: material([100, 150, 66], [122, 174, 84], [78, 122, 50], [18, 34, 14]),
    belly: material([220, 232, 176], [238, 246, 196], [192, 206, 146], [18, 34, 14]),
    spot: material([86, 132, 56], [104, 150, 70], [66, 106, 40], [18, 34, 14]),
    eye: material([248, 246, 228], undefined, undefined, undefined, true),
    pupil: material([22, 22, 22], undefined, undefined, undefined, true),
    glint: material([252, 252, 252], undefined, undefined, undefined, true),
  },
  spec: {
    withers: [27, 31.5], croup: [14, 30.8], backDip: 1.6,
    brisket: 36.3, bellyLift: 1.4,
    legs: { hind: { x: 19, thickness: 3.4 }, front: { x: 28, thickness: 2 } },
    head: { x: 31.8, y: 29.4, rx: 4.3, ry: 3.3 },
    eye: { dx: 1.2, dy: -2.2, r: 1.5 },
    pupil: { dx: 1.9, dy: -2.1 },
    flankSpots: [[0.3, 0.42, 0.45], [0.5, 0.55, 0.4], [0.7, 0.42, 0.35]],
  },
}


// ---------------------------------------------------------------------------
// Birds
// ---------------------------------------------------------------------------

const CROW = {
  materials: {
    ...bodyMaterials([56, 56, 68], [10, 10, 16]),
    wing: material([46, 46, 58], [68, 68, 82], [30, 30, 40], [10, 10, 16]),
    wingFar: material([30, 30, 40], [44, 44, 56], [18, 18, 26], [10, 10, 16]),
    feather: material([72, 72, 88], [92, 92, 110], [50, 50, 62], [10, 10, 16]),
    beak: material([198, 178, 122], [220, 202, 152], [160, 142, 94], [10, 10, 16]),
    leg: material([122, 108, 90], [142, 128, 108], [96, 84, 68], [10, 10, 16]),
    eye: material([228, 208, 98], undefined, undefined, undefined, true),
    glint: material([255, 255, 255], undefined, undefined, undefined, true),
  },
  spec: { body: { x: 21, y: 26, rx: 7.2, ry: 4.6 }, head: { x: 29.6, dy: -4.4, rx: 3.2, ry: 3 } },
}

/**
 * Crow on the ground: perched, wings folded, tail on the grass.
 * @param {Raster} r - raster.
 * @param {object} pose - frame offsets.
 * @returns {void}
 */
function drawCrowStanding(r, pose) {
  const spec = CROW.spec
  const bodyY = spec.body.y + (pose.bodyY ?? 0)
  const headX = spec.head.x + (pose.headX ?? 0)
  const headY = bodyY + spec.head.dy + (pose.headY ?? 0)
  drawBirdLeg(r, spec.body.x - 1.4, bodyY + spec.body.ry * 0.7, spec.body.x - 2.6, GROUND, 1.2, 'leg')
  drawBirdLeg(r, spec.body.x + 2, bodyY + spec.body.ry * 0.7, spec.body.x + 2.2, GROUND, 1.2, 'leg')
  // Long wedge tail, then the folded wing with two feather layers.
  r.polygon([[spec.body.x - 4, bodyY - 1.2], [spec.body.x - 12.6, bodyY - 3.6],
    [spec.body.x - 12.2, bodyY + 0.6], [spec.body.x - 4, bodyY + 2]], 'wingFar')
  r.ellipse(spec.body.x, bodyY, spec.body.rx, spec.body.ry, 'body')
  r.ellipse(spec.body.x - 1.2, bodyY - 1.6, spec.body.rx * 0.72, spec.body.ry * 0.42, 'bodyLight')
  r.ellipse(spec.body.x - 1, bodyY + 1.4, spec.body.rx * 0.78, spec.body.ry * 0.46, 'wing')
  r.limb(spec.body.x - 3, bodyY + 0.4, spec.body.x + 2.5, bodyY + 1.8, 0.7, 'feather')
  edgedEllipse(r, headX, headY, spec.head.rx, spec.head.ry, 'body')
  r.ellipse(headX - 0.4, headY - 1.2, spec.head.rx * 0.6, spec.head.ry * 0.4, 'bodyLight')
  r.polygon([[headX + 2, headY - 1.6], [headX + 7.8, headY + 0.2], [headX + 2, headY + 1.5]], 'beak')
  r.limb(headX + 2, headY + 0.1, headX + 6.4, headY + 0.2, 0.6, 'bodyShade')
  r.ellipse(headX + 0.7, headY - 0.7, 1, 1, 'eye')
  r.ellipse(headX + 1, headY - 1, 0.4, 0.4, 'glint')
}

/**
 * Crow in flight: four wing beats with separated primaries.
 * @param {Raster} r - raster.
 * @param {object} pose - frame offsets.
 * @returns {void}
 */
function drawCrowFlying(r, pose) {
  const bodyY = 22 + (pose.bodyY ?? 0)
  const bx = 21
  const up = pose.wing ?? 0
  const tipY = bodyY - up * 1.5 - 3.5
  const tipX = bx - 5 - up * 0.55
  // Far wing.
  r.polygon([[bx + 1, bodyY - 1], [tipX - 2.5, tipY + 2.5], [tipX - 4, tipY + 5.5], [bx - 3, bodyY + 1.2]], 'wingFar')
  // Tail fan.
  r.polygon([[bx - 5, bodyY - 0.6], [bx - 13.6, bodyY - 2.6], [bx - 13.2, bodyY + 1.2], [bx - 5, bodyY + 1.8]], 'wingFar')
  r.limb(bx - 7, bodyY - 0.6, bx - 12.6, bodyY - 1.8, 0.6, 'feather')
  r.ellipse(bx, bodyY, 7.4, 3.8, 'body')
  r.ellipse(bx - 1, bodyY - 1.6, 5.6, 1.6, 'bodyLight')
  // Head and beak.
  edgedEllipse(r, bx + 8.6, bodyY - 2.6, 3, 2.8, 'body')
  r.polygon([[bx + 10.8, bodyY - 3.8], [bx + 16.4, bodyY - 2.2], [bx + 10.8, bodyY - 0.9]], 'beak')
  // Near wing with three separated primaries at the tip.
  r.polygon([[bx + 3, bodyY - 1], [tipX + 0.5, tipY], [tipX - 1.5, tipY + 3.5], [bx + 1, bodyY + 1.6]], 'wing')
  r.limb(tipX - 0.4, tipY + 1, tipX - 3.4, tipY + 4.2, 1.1, 'feather')
  r.limb(tipX + 0.2, tipY + 2.2, tipX - 2.6, tipY + 5.2, 1.1, 'feather')
  r.limb(bx - 1, bodyY - 0.6, tipX + 1.5, tipY + 2.2, 0.7, 'feather')
  r.ellipse(bx + 9.2, bodyY - 3.4, 0.9, 0.9, 'eye')
  r.ellipse(bx + 9.5, bodyY - 3.7, 0.35, 0.35, 'glint')
}

const HERON = {
  materials: {
    ...bodyMaterials([152, 160, 170], [22, 26, 32]),
    back: material([112, 122, 136], [136, 146, 160], [88, 96, 110], [22, 26, 32]),
    wing: material([134, 144, 156], [158, 168, 182], [106, 114, 128], [22, 26, 32]),
    wingFar: material([96, 104, 116], [116, 124, 138], [74, 82, 94], [22, 26, 32]),
    plume: material([196, 202, 212], [216, 222, 230], [168, 174, 186], [22, 26, 32]),
    beak: material([216, 188, 98], [238, 212, 128], [176, 150, 72], [22, 26, 32]),
    leg: material([98, 88, 72], [118, 106, 88], [74, 66, 54], [22, 26, 32]),
    legFar: material([72, 64, 52], [88, 78, 64], [56, 50, 40], [22, 26, 32]),
    crest: material([38, 42, 52], [56, 60, 72], [26, 28, 36], [22, 26, 32]),
    eye: material([242, 218, 98], undefined, undefined, undefined, true),
    glint: material([255, 255, 255], undefined, undefined, undefined, true),
  },
}

/**
 * Heron: long legs with a backward ankle, an S-neck, a dagger beak.
 * @param {Raster} r - raster.
 * @param {object} pose - frame offsets.
 * @returns {void}
 */
function drawHeron(r, pose) {
  const bodyY = 17 + (pose.bodyY ?? 0)
  const bx = 20
  const neck = pose.neck ?? 0
  const headX = 29 + (pose.headX ?? 0)
  const headY = 8.5 + neck + (pose.headY ?? 0)
  const legA = pose.legA ?? 0
  const legB = pose.legB ?? 0
  // Far leg, one shade darker.
  r.limb(bx - 1.4, bodyY + 3, bx - 2.4 + legB * 0.5, bodyY + 10, 1.6, 'edge')
  r.limb(bx - 2.4 + legB * 0.5, bodyY + 10, bx - 3 + legB, GROUND, 1.5, 'edge')
  r.limb(bx - 1.4, bodyY + 3, bx - 2.4 + legB * 0.5, bodyY + 10, 1.1, 'legFar')
  r.limb(bx - 2.4 + legB * 0.5, bodyY + 10, bx - 3 + legB, GROUND, 1, 'legFar')
  r.ellipse(bx - 3 + legB, GROUND - 0.4, 2.2, 0.8, 'legFar')
  // Tail plumes.
  r.polygon([[bx - 5, bodyY - 1.4], [bx - 13, bodyY - 0.4], [bx - 12.4, bodyY + 2.8], [bx - 5, bodyY + 2.6]], 'wingFar')
  r.ellipse(bx, bodyY, 8.6, 5, 'body')
  r.ellipse(bx - 1.4, bodyY - 2, 6.6, 2.6, 'back')
  r.ellipse(bx - 1.2, bodyY - 2.8, 5, 1.5, 'bodyLight')
  r.ellipse(bx - 1, bodyY + 2.4, 6, 2.4, 'wing')
  r.limb(bx - 4, bodyY + 1, bx + 3, bodyY + 2.4, 0.7, 'plume')
  // Neck: two segments so the S-curve survives at pixel scale.
  const neckA = [bx + 5, bodyY - 2.6]
  const neckKnee = [headX - 2.4, headY + 3.8]
  const neckTop = [headX - 0.4, headY + 1.4]
  r.limb(neckA[0], neckA[1], neckKnee[0], neckKnee[1], 3.2, 'edge')
  r.limb(neckKnee[0], neckKnee[1], neckTop[0], neckTop[1], 3, 'edge')
  r.limb(neckA[0], neckA[1], neckKnee[0], neckKnee[1], 2.1, 'body')
  r.limb(neckKnee[0], neckKnee[1], neckTop[0], neckTop[1], 1.9, 'body')
  furBand(r, [neckA[0] - 0.3, neckA[1] - 0.8], [neckKnee[0] - 0.2, neckKnee[1] - 0.6], 0.5, 0.2, 'bodyLight')
  edgedEllipse(r, headX, headY, 2.9, 2.7, 'body')
  r.ellipse(headX - 0.3, headY - 1, 1.9, 1.2, 'bodyLight')
  // Crest: two thin plumes off the back of the head.
  r.limb(headX + 0.4, headY - 2.4, headX - 1.8, headY - 3.8, 1.6, 'crest')
  r.limb(headX + 0.6, headY - 1.8, headX - 2.4, headY - 2.2, 0.8, 'crest')
  // Dagger beak with a shadow along the cutting edge.
  r.polygon([[headX + 2, headY - 1], [headX + 11.4, headY + 1.6], [headX + 2, headY + 1.8]], 'beak')
  r.limb(headX + 2.4, headY + 0.6, headX + 10.4, headY + 1.5, 0.5, 'bodyShade')
  // Near leg.
  r.limb(bx + 1, bodyY + 3, bx - 0.4 + legA * 0.5, bodyY + 10, 1.7, 'edge')
  r.limb(bx - 0.4 + legA * 0.5, bodyY + 10, bx - 1 + legA, GROUND, 1.6, 'edge')
  r.limb(bx + 1, bodyY + 3, bx - 0.4 + legA * 0.5, bodyY + 10, 1.2, 'leg')
  r.limb(bx - 0.4 + legA * 0.5, bodyY + 10, bx - 1 + legA, GROUND, 1.1, 'leg')
  r.ellipse(bx - 1 + legA, GROUND - 0.4, 2.3, 0.8, 'leg')
  r.ellipse(headX + 1.1, headY - 0.6, 1, 1, 'eye')
  r.ellipse(headX + 1.4, headY - 0.9, 0.4, 0.4, 'glint')
}

// ---------------------------------------------------------------------------
// Fish
// ---------------------------------------------------------------------------

/**
 * Fish body: a chain of ellipses along a travelling sine wave, with a gill
 * cover, a lateral line and rayed fins.
 *
 * The tail carries the phase and the head barely moves, which is what a real
 * fish does — a body that wobbles as a whole reads as a rubber toy.
 * @param {Raster} r - raster.
 * @param {object} spec - body shape and fins.
 * @param {number} wave - cycle position 0..1.
 * @returns {void}
 */
function drawFish(r, spec, wave) {
  const steps = 18
  const cx = spec.cx
  const cy = spec.cy + (spec.bob ?? 0)
  const headX = cx + spec.len / 2
  const phase = wave * Math.PI * 2
  const profile = (u) => Math.min(1, 0.44 + u * 3.2) * (1 - 0.6 * Math.pow(u, 1.5))
  let tailY = cy
  for (let i = 0; i < steps; i += 1) {
    const u = i / (steps - 1)
    const x = headX - u * spec.len
    const sway = Math.sin(u * 2.1 * Math.PI - phase) * spec.amp * u * u
    const y = cy + sway
    const height = spec.height * profile(u)
    const name = u > 0.9 ? 'bodyFar' : (u > 0.45 ? 'back' : 'body')
    r.ellipse(x, y, spec.len / steps * 1.8, Math.max(0.7, height / 2), name)
    if (i === steps - 1) tailY = y
  }
  // Lit top and pale belly lines.
  r.ellipse(headX - spec.len * 0.3, cy - spec.height * 0.28, spec.len * 0.24, spec.height * 0.14, 'bodyLight')
  r.ellipse(headX - spec.len * 0.26, cy + spec.height * 0.2, spec.len * 0.2, spec.height * 0.13, 'belly')
  // Gill cover: an arc behind the head.
  const gillX = headX - spec.len * 0.2
  r.limb(gillX + 0.4, cy - spec.height * 0.36, gillX - 0.6, cy, 0.6, 'bodyShade')
  r.limb(gillX - 0.6, cy, gillX + 0.2, cy + spec.height * 0.32, 0.6, 'bodyShade')
  // Lateral line: dashes down the flank.
  for (let i = 0; i < 7; i += 1) {
    const u = 0.22 + i * 0.1
    r.set(headX - u * spec.len, cy + Math.sin(u * 2.1 * Math.PI - phase) * spec.amp * u * u - 0.4, 'bodyLight')
  }
  // Tail fin with two rays.
  const tailX = headX - spec.len
  const flick = Math.sin(2.1 * Math.PI - phase) * spec.amp
  r.polygon([
    [tailX + 2, tailY],
    [tailX - spec.tailLen, tailY + flick * 0.6 - spec.tailSpread],
    [tailX - spec.tailLen * 0.5, tailY + flick * 0.35],
    [tailX - spec.tailLen, tailY + flick * 0.6 + spec.tailSpread],
  ], 'fin')
  r.limb(tailX - 0.5, tailY + flick * 0.15, tailX - spec.tailLen * 0.85, tailY + flick * 0.5 - spec.tailSpread * 0.6, 0.5, 'bodyShade')
  r.limb(tailX - 0.5, tailY + flick * 0.15, tailX - spec.tailLen * 0.85, tailY + flick * 0.5 + spec.tailSpread * 0.6, 0.5, 'bodyShade')
  // Dorsal fin with rays, plus a pectoral fin.
  r.polygon([
    [headX - spec.len * 0.3, cy - spec.height * 0.4],
    [headX - spec.len * 0.46, cy - spec.height * 0.4 - spec.dorsal],
    [headX - spec.len * 0.6, cy - spec.height * 0.34],
  ], 'fin')
  r.limb(headX - spec.len * 0.4, cy - spec.height * 0.38, headX - spec.len * 0.46, cy - spec.height * 0.36 - spec.dorsal * 0.8, 0.4, 'bodyShade')
  if (spec.pelvic !== false) {
    r.polygon([
      [headX - spec.len * 0.28, cy + spec.height * 0.26],
      [headX - spec.len * 0.42, cy + spec.height * 0.26 + spec.dorsal * 0.7],
      [headX - spec.len * 0.48, cy + spec.height * 0.18],
    ], 'fin')
    r.polygon([
      [headX - spec.len * 0.12, cy + spec.height * 0.1],
      [headX - spec.len * 0.2, cy + spec.height * 0.16 + spec.dorsal * 0.5],
      [headX - spec.len * 0.24, cy + spec.height * 0.06],
    ], 'fin')
  }
  if (spec.stripes === true) {
    for (let i = 0; i < 4; i += 1) {
      const sx = headX - spec.len * (0.34 + i * 0.14)
      r.ellipse(sx, cy + spec.height * 0.02, 0.9, spec.height * 0.26, 'stripe')
    }
  }
  // Eye with a ring and a catchlight.
  const eyeX = headX - 2.8
  const eyeY = cy - spec.height * 0.12
  r.ellipse(eyeX, eyeY, 1.5, 1.5, 'bodyShade')
  r.ellipse(eyeX, eyeY, 1.1, 1.1, 'eye')
  r.set(eyeX + 0.4, eyeY - 0.4, 'glint')
}

const FISH = {
  materials: {
    ...bodyMaterials([106, 170, 216], [14, 38, 60]),
    back: material([66, 132, 190], [88, 154, 208], [48, 108, 158], [14, 38, 60]),
    belly: material([212, 238, 248], [232, 248, 252], [182, 212, 230], [14, 38, 60]),
    fin: material([238, 198, 110], [252, 216, 136], [200, 162, 84], [14, 38, 60]),
    stripe: material([48, 112, 168], [66, 132, 190], [36, 92, 144], [14, 38, 60]),
    eye: material([20, 24, 32], undefined, undefined, undefined, true),
    glint: material([255, 255, 255], undefined, undefined, undefined, true),
  },
  spec: { cx: 23, cy: 24, len: 21, height: 10.4, amp: 2.2, tailLen: 5.2, tailSpread: 4.2, dorsal: 3.6, stripes: true },
}

const PIKE = {
  materials: {
    ...bodyMaterials([106, 132, 80], [18, 28, 16]),
    back: material([70, 96, 54], [88, 114, 70], [54, 76, 42], [18, 28, 16]),
    belly: material([218, 224, 184], [238, 242, 208], [190, 196, 158], [18, 28, 16]),
    fin: material([168, 178, 122], [188, 198, 142], [138, 148, 98], [18, 28, 16]),
    stripe: material([222, 228, 180], [240, 244, 204], [194, 202, 154], [18, 28, 16]),
    eye: material([230, 208, 98], undefined, undefined, undefined, true),
    glint: material([255, 255, 255], undefined, undefined, undefined, true),
  },
  spec: { cx: 24, cy: 24, len: 33, height: 8, amp: 1.8, tailLen: 6.4, tailSpread: 4.6, dorsal: 2.8, pelvic: false },
}

// ---------------------------------------------------------------------------
// Gaits: a walk cycle authored as numbers
//
// Duty factors come from quadruped locomotion data: a walk plants each foot for
// about 75% of the cycle and lands them a quarter cycle apart; a trot uses
// diagonal pairs with a 50% duty factor; a gallop drops to roughly a third and
// has a suspension phase where nothing is on the ground. Stride length grows
// from walk to gallop by roughly 8:5.
// ---------------------------------------------------------------------------

/**
 * Foot travel for one leg over a four-frame stride.
 * @param {number} offset - cycle offset 0..1.
 * @param {number} stride - total fore/aft travel in design units.
 * @param {number} lift - peak lift in design units.
 * @param {number} duty - fraction of the cycle the foot is planted.
 * @returns {number[][]} four pairs of horizontal offset and lift.
 */
function gaitOffsets(offset, stride, lift, duty) {
  const frames = []
  for (let i = 0; i < 4; i += 1) {
    const t = (i / 4 + offset) % 1
    if (t < duty) {
      frames.push([stride * (0.5 - t / duty), 0])
    } else {
      const u = (t - duty) / (1 - duty)
      frames.push([stride * (u - 0.5), Math.sin(Math.PI * u) * lift])
    }
  }
  return frames
}

/**
 * A four-beat lateral-sequence walk: near-hind, near-fore, far-hind, far-fore,
 * a quarter cycle apart, three feet down at all times.
 * @param {{stride?: number, lift?: number}} cfg - gait shape.
 * @returns {object[]} four poses.
 */
function walkPoses(cfg = {}) {
  const stride = cfg.stride ?? 4
  const lift = cfg.lift ?? 1.6
  const duty = 0.75
  const hind = gaitOffsets(0, stride, lift, duty)
  const front = gaitOffsets(0.5, stride, lift, duty)
  const hindFar = gaitOffsets(0.25, stride, lift, duty)
  const frontFar = gaitOffsets(0.75, stride, lift, duty)
  const bob = [0, -0.3, 0, -0.3]
  return [0, 1, 2, 3].map((i) => ({
    bodyY: bob[i],
    headY: 0.15,
    hind: hind[i],
    front: front[i],
    hindFar: hindFar[i],
    frontFar: frontFar[i],
    tail: [0, 0.6, 0, -0.6][i],
  }))
}

/**
 * A transverse gallop: the hind pair lands together, then the front pair, then
 * the animal is airborne. That suspension frame is what makes a runner look fast
 * instead of like a fast walk.
 * @param {{stride?: number, lift?: number}} cfg - gait shape.
 * @returns {object[]} four poses.
 */
function gallopPoses(cfg = {}) {
  const stride = cfg.stride ?? 7
  const lift = cfg.lift ?? 3
  const duty = 0.36
  const bob = [-1.2, 0.5, -2.4, -0.4]
  const hind = gaitOffsets(0.08, stride, lift, duty)
  const hindFar = gaitOffsets(0, stride, lift, duty)
  const front = gaitOffsets(0.6, stride, lift, duty)
  const frontFar = gaitOffsets(0.52, stride, lift, duty)
  return [0, 1, 2, 3].map((i) => ({
    bodyY: bob[i],
    headY: [-0.6, 0.4, -0.8, 0][i],
    hind: hind[i],
    front: front[i],
    hindFar: hindFar[i],
    frontFar: frontFar[i],
    tail: [1.2, 0.4, -1.2, 0][i],
  }))
}

/**
 * A trot: diagonal pairs move together, two feet down at a time.
 * @param {{stride: number, lift: number, bob?: number[], tailSway?: number[]}} cfg - gait shape.
 * @returns {object[]} four poses.
 */
function trotPoses(cfg) {
  const stride = cfg.stride ?? 4
  const lift = cfg.lift ?? 2.2
  const bob = cfg.bob ?? [-0.3, -1.2, -0.3, -1.2]
  const hind = gaitOffsets(0, stride, lift, 0.5)
  const front = gaitOffsets(0.5, stride, lift, 0.5)
  return [0, 1, 2, 3].map((i) => ({
    bodyY: bob[i],
    headY: (cfg.headBob ?? [0.3, -0.4, 0.3, -0.4])[i],
    hind: hind[i],
    front: front[i],
    hindFar: front[i],
    frontFar: hind[i],
    tail: (cfg.tailSway ?? [0, 1, 0, -1])[i],
  }))
}

/** Idle poses: settled feet with a slow breath. */
function idlePoses(cfg = {}) {
  const sink = cfg.sink ?? 0.4
  return [
    { bodyY: 0, headY: 0, hind: [0, 0], front: [0, 0], tail: 0 },
    { bodyY: -sink, headY: -sink * 0.6, hind: [0, 0], front: [0, 0], tail: cfg.tailSway ?? 1.1 },
  ]
}

/** Rabbits do not trot: they gather, push off, fly, land. */
const RABBIT_HOP = [
  { bodyY: 0.9, headY: 0.5, hind: [-1.8, 0], front: [1.8, 0], tail: 0 },
  { bodyY: -1.4, headY: -1, hind: [3.4, 0.2], front: [-1.6, 1.5], tail: 1.2 },
  { bodyY: -2.6, headY: -1.4, hind: [-0.9, 2.6], front: [1.4, 2.4], tail: 0.5 },
  { bodyY: 0.2, headY: 0.3, hind: [-1.4, 0.3], front: [3.8, 0.5], tail: -1 },
]

const FROG_HOP = [
  { bodyY: 1, headY: 0.4, hind: [-2.4, 0], front: [1.4, 0] },
  { bodyY: -1.8, headY: -0.8, hind: [3.8, 0.3], front: [-1.4, 1.6] },
  { bodyY: -3.8, headY: -1.6, hind: [-1.2, 2.8], front: [1.8, 2.6] },
  { bodyY: 0.4, headY: 0.4, hind: [-1.8, 0.4], front: [3.4, 0.6] },
]

/** Heron stalking: the near leg and the far leg swap, the neck pumps. */
const HERON_WALK = [
  { bodyY: 0, legA: -1.6, legB: 1.8, neck: 0.4, headX: 0 },
  { bodyY: -0.6, legA: 0.6, legB: 0.8, neck: -0.4, headX: 0.4 },
  { bodyY: 0, legA: 2, legB: -1.6, neck: 0.4, headX: 0.8 },
  { bodyY: -0.6, legA: 0.4, legB: 0.4, neck: -0.5, headX: 0.2 },
]

/** Crow wing beat: up, level, down, level. */
const CROW_FLAP = [
  { bodyY: -0.4, wing: 7 },
  { bodyY: 0.2, wing: 2 },
  { bodyY: 0.6, wing: -6 },
  { bodyY: 0.2, wing: -1 },
]

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every creature the atlas ships.
 *
 * idle, walk and run are frame lists; walk and run are four frames so the gait
 * reads as a cycle. display is the drawn size relative to the atlas cell at 6x
 * zoom; gait is gait cycles per world cell travelled while walking.
 */
export const CREATURES = {
  rabbit: {
    display: 0.8, gait: 0.34,
    materials: RABBIT.materials,
    idle: idlePoses({ sink: 0.5, tailSway: 0.9 }),
    walk: RABBIT_HOP,
    run: RABBIT_HOP,
    draw: (r, pose) => drawQuadruped(r, RABBIT.spec, pose),
  },
  deer: {
    display: 0.87, gait: 0.2,
    materials: DEER.materials,
    idle: idlePoses({ sink: 0.4, tailSway: 1.2 }),
    walk: walkPoses({ stride: 4.8, lift: 1.5 }),
    run: gallopPoses({ stride: 8.2, lift: 3.2 }),
    draw: (r, pose) => drawQuadruped(r, DEER.spec, pose),
  },
  fox: {
    display: 0.75, gait: 0.28,
    materials: FOX.materials,
    idle: idlePoses({ sink: 0.4, tailSway: 1.4 }),
    walk: walkPoses({ stride: 4, lift: 1.5 }),
    run: gallopPoses({ stride: 7.4, lift: 3 }),
    draw: (r, pose) => drawQuadruped(r, FOX.spec, pose),
  },
  wolf: {
    display: 0.84, gait: 0.2,
    materials: WOLF.materials,
    idle: idlePoses({ sink: 0.4, tailSway: 1.6 }),
    walk: walkPoses({ stride: 5, lift: 1.6 }),
    run: gallopPoses({ stride: 8.6, lift: 3.2 }),
    draw: (r, pose) => drawQuadruped(r, WOLF.spec, pose),
  },
  bear: {
    display: 0.98, gait: 0.17,
    materials: BEAR.materials,
    idle: idlePoses({ sink: 0.5, tailSway: 0.4 }),
    // A bear paces more than it trots: a four-beat amble at both speeds.
    walk: walkPoses({ stride: 4.4, lift: 1.2 }),
    run: walkPoses({ stride: 6.2, lift: 1.9 }),
    draw: (r, pose) => drawQuadruped(r, BEAR.spec, pose),
  },
  otter: {
    display: 0.81, gait: 0.26,
    materials: OTTER.materials,
    idle: idlePoses({ sink: 0.4, tailSway: 1.8 }),
    walk: walkPoses({ stride: 3.8, lift: 1.3 }),
    run: gallopPoses({ stride: 7, lift: 2.6 }),
    draw: (r, pose) => drawQuadruped(r, OTTER.spec, pose),
  },
  frog: {
    display: 0.6, gait: 0.5,
    materials: FROG.materials,
    idle: idlePoses({ sink: 0.6, tailSway: 0 }),
    walk: FROG_HOP,
    run: FROG_HOP,
    draw: (r, pose) => drawQuadruped(r, FROG.spec, pose),
  },
  crow: {
    display: 0.72, gait: 0.3,
    materials: CROW.materials,
    idle: [
      { bodyY: 0, headX: 0, headY: 0 },
      { bodyY: -0.4, headX: 0.6, headY: -0.3 },
    ],
    run: CROW_FLAP,
    draw: (r, pose, anim) => (anim === 'run' ? drawCrowFlying(r, pose) : drawCrowStanding(r, pose)),
  },
  heron: {
    display: 0.75, gait: 0.22,
    materials: HERON.materials,
    idle: [
      { bodyY: 0, neck: 0, headX: 0, headY: 0, legA: 0, legB: 0 },
      { bodyY: -0.4, neck: 0.7, headX: 0.4, headY: 0.4, legA: 0, legB: 0 },
    ],
    walk: HERON_WALK,
    run: HERON_WALK.map((pose) => ({ ...pose, legA: pose.legA * 1.6, legB: pose.legB * 1.6 })),
    draw: (r, pose) => drawHeron(r, pose),
  },
  fish: {
    display: 0.62, gait: 0.42,
    materials: FISH.materials,
    idle: [{ bodyY: 0 }, { bodyY: -0.6 }],
    run: [{ bodyY: 0 }, { bodyY: -0.4 }, { bodyY: -0.8 }, { bodyY: -0.4 }],
    draw: (r, pose, anim, index) => drawFish(r, { ...FISH.spec, bob: pose.bodyY ?? 0 },
      anim === 'run' ? index / 4 : (index === 0 ? 0.1 : 0.55)),
  },
  pike: {
    display: 0.75, gait: 0.34,
    materials: PIKE.materials,
    idle: [{ bodyY: 0 }, { bodyY: -0.5 }],
    run: [{ bodyY: 0 }, { bodyY: -0.35 }, { bodyY: -0.7 }, { bodyY: -0.35 }],
    draw: (r, pose, anim, index) => drawFish(r, { ...PIKE.spec, bob: pose.bodyY ?? 0 },
      anim === 'run' ? index / 4 : (index === 0 ? 0.15 : 0.6)),
  },
}

/** Animation roles, in atlas order. Missing roles fall back to run. */
export const ANIM_ROLES = ['idle', 'walk', 'run']

/**
 * Render one animation frame of one creature.
 * @param {string} speciesId - key into CREATURES.
 * @param {string} anim - idle, walk or run.
 * @param {number} index - frame index.
 * @returns {Uint8Array} RGBA bytes of one atlas cell.
 */
export function renderFrame(speciesId, anim, index) {
  const creature = CREATURES[speciesId]
  if (creature === undefined) throw new Error('unknown creature: ' + speciesId)
  const frames = creature[anim] ?? (anim === 'walk' ? creature.run : undefined)
  if (frames === undefined) throw new Error('unknown animation: ' + anim)
  const raster = new Raster(CELL_W, CELL_H, DESIGN_SCALE)
  creature.draw(raster, frames[index % frames.length], anim, index)
  return composeFrame(raster, creature.materials)
}

/**
 * RGBA for a finished raster (outline + rim shading).
 * @param {Raster} raster - painted raster.
 * @param {Record<string, object>} materials - palette.
 * @returns {Uint8Array} RGBA bytes.
 */
function composeFrame(raster, materials) {
  const { width, height } = raster
  const out = new Uint8Array(width * height * 4)
  const materialAt = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? null : raster.materials[y * width + x])
  const put = (index, color) => {
    out[index * 4] = color[0]
    out[index * 4 + 1] = color[1]
    out[index * 4 + 2] = color[2]
    out[index * 4 + 3] = 255
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const name = raster.materials[index]
      if (name === null) continue
      const material = materials[name]
      if (material === undefined) throw new Error('unknown material: ' + name)
      let color = material.color
      if (material.flat !== true) {
        if (materialAt(x, y - 1) === null && material.light !== undefined) color = material.light
        else if (materialAt(x, y + 1) === null && material.dark !== undefined) color = material.dark
      }
      put(index, color)
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (materialAt(x, y) !== null) continue
      const donors = [materialAt(x - 1, y), materialAt(x + 1, y), materialAt(x, y - 1), materialAt(x, y + 1)]
      let outline = null
      for (const donor of donors) {
        if (donor === null) continue
        const material = materials[donor]
        if (material === undefined || material.flat === true || material.outline === undefined) continue
        if (outline === null) outline = material.outline
      }
      if (outline !== null) put(y * width + x, outline)
    }
  }
  return out
}
