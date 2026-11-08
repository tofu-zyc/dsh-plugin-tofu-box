/**
 * Material-based pixel rasterizer used to build the creature atlas.
 *
 * Shapes are painted with material names, never colours, so the same pose code
 * can be re-shaded or re-paletted. composeFrame turns the material buffer into
 * RGBA and adds the two things that make flat blobs read as pixel art: an
 * outside outline and a light rim.
 *
 * The raster also carries a design-space scale. Art is authored in a 48x44 grid
 * (readable numbers) but rendered into a 64x58 cell, so every shape lands on a
 * finer pixel grid: the same animal gets ~33% more detail per body length
 * without re-deriving every landmark.
 */

/** @typedef {{ color: number[], light?: number[], dark?: number[], outline?: number[], flat?: boolean }} Material */

export class Raster {
  /**
   * @param {number} width - canvas width in output pixels.
   * @param {number} height - canvas height in output pixels.
   * @param {number} [scale] - design units to output pixels.
   */
  constructor(width, height, scale = 1) {
    this.width = width
    this.height = height
    this.scale = scale
    /** @type {(string|null)[]} */
    this.materials = new Array(width * height).fill(null)
    /** @type {{minX: number, maxX: number, minY: number, maxY: number}|null} */
    this.clip = null
  }

  /**
   * Paint one output pixel.
   *
   * Respects the clip rectangle, which is how a limb is kept from painting over
   * the body it belongs to: the near legs are drawn after the barrel but clipped
   * to start at the belly line.
   * @param {number} x - column.
   * @param {number} y - row.
   * @param {string} material - material name.
   * @returns {void}
   */
  set(x, y, material) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    if (this.clip !== null) {
      if (py < this.clip.minY || py > this.clip.maxY) return
      if (px < this.clip.minX || px > this.clip.maxX) return
    }
    this.materials[py * this.width + px] = material
  }

  /**
   * Run a paint callback with a clip rectangle in design units.
   * @param {{minX?: number, maxX?: number, minY?: number, maxY?: number}} box - clip in design units.
   * @param {Function} paint - callback that paints.
   * @returns {void}
   */
  clipped(box, paint) {
    const s = this.scale
    const previous = this.clip
    this.clip = {
      minX: (box.minX ?? -1e9) * s,
      maxX: (box.maxX ?? 1e9) * s,
      minY: (box.minY ?? -1e9) * s,
      maxY: (box.maxY ?? 1e9) * s,
    }
    try {
      paint()
    } finally {
      this.clip = previous
    }
  }

  /**
   * Material at an output pixel, or null.
   * @param {number} x - column.
   * @param {number} y - row.
   * @returns {string|null} material name.
   */
  at(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null
    return this.materials[y * this.width + x]
  }

  /**
   * Filled ellipse, positioned in design space.
   * @param {number} cx - centre column.
   * @param {number} cy - centre row.
   * @param {number} rx - radius x.
   * @param {number} ry - radius y.
   * @param {string} material - material name.
   * @returns {void}
   */
  ellipse(cx, cy, rx, ry, material) {
    if (rx <= 0 || ry <= 0) return
    const s = this.scale
    const ccx = cx * s
    const ccy = cy * s
    const crx = rx * s
    const cry = ry * s
    const x0 = Math.floor(ccx - crx)
    const x1 = Math.ceil(ccx + crx)
    const y0 = Math.floor(ccy - cry)
    const y1 = Math.ceil(ccy + cry)
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = (x + 0.5 - ccx) / crx
        const dy = (y + 0.5 - ccy) / cry
        if (dx * dx + dy * dy <= 1.02) this.set(x, y, material)
      }
    }
  }

  /**
   * Axis-aligned filled rectangle, in design space.
   * @param {number} x0 - left.
   * @param {number} y0 - top.
   * @param {number} x1 - right.
   * @param {number} y1 - bottom.
   * @param {string} material - material name.
   * @returns {void}
   */
  rect(x0, y0, x1, y1, material) {
    const s = this.scale
    for (let y = Math.round(y0 * s); y <= Math.round(y1 * s); y += 1) {
      for (let x = Math.round(x0 * s); x <= Math.round(x1 * s); x += 1) this.set(x, y, material)
    }
  }

  /**
   * Thick line: a run of discs, which keeps joints round instead of stepped.
   * @param {number} x0 - start column.
   * @param {number} y0 - start row.
   * @param {number} x1 - end column.
   * @param {number} y1 - end row.
   * @param {number} thickness - diameter in design units.
   * @param {string} material - material name.
   * @returns {void}
   */
  limb(x0, y0, x1, y1, thickness, material) {
    const s = this.scale
    const radius = Math.max(0.5, (thickness * s) / 2)
    const ax = x0 * s
    const ay = y0 * s
    const bx = x1 * s
    const by = y1 * s
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * 2))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      const x = ax + (bx - ax) * t
      const y = ay + (by - ay) * t
      if (radius <= 0.6) this.set(x, y, material)
      else {
        const span = Math.ceil(radius)
        for (let dy = -span; dy <= span; dy += 1) {
          for (let dx = -span; dx <= span; dx += 1) {
            if (dx * dx + dy * dy > radius * radius) continue
            this.set(x + dx, y + dy, material)
          }
        }
      }
    }
  }

  /**
   * Filled polygon (even-odd scanline), in design space.
   * @param {number[][]} points - polygon vertices.
   * @param {string} material - material name.
   * @returns {void}
   */
  polygon(points, material) {
    const s = this.scale
    const scaled = points.map(([x, y]) => [x * s, y * s])
    let minY = Infinity
    let maxY = -Infinity
    for (const [, y] of scaled) {
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += 1) {
      const scanY = y + 0.5
      const crossings = []
      for (let i = 0; i < scaled.length; i += 1) {
        const [ax, ay] = scaled[i]
        const [bx, by] = scaled[(i + 1) % scaled.length]
        if ((ay <= scanY && by > scanY) || (by <= scanY && ay > scanY)) {
          crossings.push(ax + ((scanY - ay) / (by - ay)) * (bx - ax))
        }
      }
      crossings.sort((a, b) => a - b)
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        for (let x = Math.round(crossings[i]); x <= Math.round(crossings[i + 1]) - 1; x += 1) {
          this.set(x, y, material)
        }
        if (Math.round(crossings[i + 1]) === Math.round(crossings[i])) this.set(crossings[i], y, material)
      }
    }
  }

  /**
   * Copy this raster into another at an integer output offset.
   * @param {Raster} target - destination.
   * @param {number} dx - column offset.
   * @param {number} dy - row offset.
   * @returns {void}
   */
  blitInto(target, dx, dy) {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const material = this.materials[y * this.width + x]
        if (material !== null) target.set(x + dx, y + dy, material)
      }
    }
  }
}
