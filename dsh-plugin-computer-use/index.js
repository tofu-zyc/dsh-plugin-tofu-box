/**
 * computer-use — let the model see the desktop and drive mouse & keyboard.
 *
 * Twelve model-facing tools (`computer_*`): capture, zoom, cursor, move,
 * click, drag, scroll, type, key, open (Start-search launch), sequence (a
 * whole multi-step flow in one approved call), and wait. Two rules shape
 * every tool:
 *
 * - **Keyboard-first.** A click on a downscaled frame misses small targets;
 *   the descriptions push `computer_open` / `computer_key` / `computer_sequence`
 *   whenever a keyboard path exists, and reserve the mouse for what truly
 *   needs it.
 * - **Atomic gestures, one approval.** A click moves and clicks in a single
 *   call, so the pointer is never parked mid-gesture where a stray human
 *   move would break it. Mutating calls gate on the native
 *   `tools/pre-execute` waterfall; by default one approval covers every later
 *   action from the same agent, and pointer gestures return the cursor to
 *   where the human left it after the result screenshot.
 *
 * Coordinates are pixels of the latest screenshot; each capture re-measures
 * the virtual desktop and scales frame px back to physical px, so any
 * multi-monitor / DPI layout works.
 *
 * Screenshots are staged under `outDir` (default: a temp dir, pruned to the
 * newest `keep` PNGs) and handed to the model as attachment images — the
 * generic image card in `dsh-plugin-read-image-preview` renders them with
 * zoom/pan; nothing here ships a client half.
 *
 * The scripts under `scripts/` are the only thing that touches the desktop.
 * They run through the composed `shell` service with a workspace-write
 * sandbox pinned to `outDir`: the model chooses coordinates and text, never
 * a command line.
 *
 * @module dsh-plugin-computer-use
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fsNative from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'computer-use'
export const inject = ['tools', 'shell', 'fs', 'attachments']

export const Config = z.object({
  /** Where capture PNGs are staged before they become attachments. */
  outDir: z.string().min(1),
  /** Staged PNGs to keep (oldest pruned after each capture). */
  keep: z.natural().min(5).max(500),
  /** Long-edge cap of the model-visible frame, in px. */
  maxDim: z.natural().min(320).max(3840),
  /** Settle time between the gesture and the result screenshot. */
  settleMs: z.natural().max(5000),
  /** 'once-per-agent': the first mutating call asks, later ones run. */
  askPolicy: z.union([z.const('once-per-agent'), z.const('always')]),
})

const CAP = fileURLToPath(new URL('./scripts/capture.ps1', import.meta.url))
const INP = fileURLToPath(new URL('./scripts/input.ps1', import.meta.url))

/** Narrow an unknown value to a finite number, else throw a teaching error. */
function num(value, label) {
  if (typeof value !== 'number' || !isFinite(value)) throw new Error(label + ' must be a number')
  return value
}

function intIn(value, label, lo, hi, dflt) {
  if (value === undefined || value === null) return dflt
  if (typeof value !== 'number' || !isFinite(value) || value < lo || value > hi) {
    throw new Error(label + ' must be between ' + lo + ' and ' + hi)
  }
  return Math.round(value)
}

/** Single-quote a PowerShell argument, doubling embedded quotes. */
function psQuote(value) {
  return "'" + String(value).split("'").join("''") + "'"
}

/**
 * Register the tools and the approval gate on one context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ outDir?: string, keep?: number, maxDim?: number, settleMs?: number, askPolicy?: string }} [config] - row config.
 */
export function apply(ctx, config) {
  const outDir = (config && typeof config.outDir === 'string' && config.outDir !== '')
    ? config.outDir
    : path.join(os.tmpdir(), 'dsh-computer-use')
  const keep = config && config.keep !== undefined ? config.keep : 30
  const maxDim = config && config.maxDim !== undefined ? config.maxDim : 1568
  const settleMs = config && config.settleMs !== undefined ? config.settleMs : 800
  const askPolicy = (config && config.askPolicy === 'always') ? 'always' : 'once-per-agent'
  fsNative.mkdirSync(outDir, { recursive: true })

  /** Physical↔frame mapping of the last full capture; null until one exists. */
  let scale = null
  /** Agents whose approval covered this process (per-agent, not global). */
  const granted = new Set()

  const IMAGE_VALUE = {
    type: 'object', additionalProperties: false, required: true,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
      bytes: { type: 'integer', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
    },
  }
  const SHOT_VALUE = {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string', required: true },
      frameText: { type: 'string', required: true },
      image: IMAGE_VALUE,
    },
  }
  const SHOT_RENDER = { schema: SHOT_VALUE, render: (_a, v) => [
    { type: 'text', text: v.summary + '\n' + v.frameText },
    { type: 'image', attachment: v.image },
  ] }

  const agentKey = (agent) => (agent && typeof agent.id === 'string' && agent.id !== '') ? agent.id : '__no-agent__'

  const runRaw = async (body, signal) => {
    const spec = ctx.shell.resolve({
      command: body,
      workdir: outDir,
      timeoutMs: 25000,
      stdoutMaxBytes: 262144,
      signal,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: outDir },
    })
    const res = await ctx.shell.run(spec)
    const out = res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : ''
    if (res.exitCode !== 0) {
      const err = res.stderr && typeof res.stderr.text === 'string' ? res.stderr.text : out
      throw new Error('PowerShell failed (exit ' + res.exitCode + '): ' + err.slice(-500))
    }
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length === 0) throw new Error('PowerShell returned no output')
    return lines[lines.length - 1].trim()
  }

  const inputCall = (call, signal) => runRaw('& ' + psQuote(INP) + ' ' + call, signal)

  const getPos = async (signal) => {
    const p = (await inputCall('-Action pos', signal)).split(',')
    const x = parseInt(p[0], 10)
    const y = parseInt(p[1], 10)
    if (!isFinite(x) || !isFinite(y)) return null
    return [x, y]
  }

  const capture = async (signal, summary, crop) => {
    let body = '& ' + psQuote(CAP) + ' -OutDir ' + psQuote(outDir) + ' -Prefix screen -MaxDim ' + maxDim + ' -Keep ' + keep
    if (crop) body += ' -Crop ' + psQuote([crop.X, crop.Y, crop.W, crop.H].join(','))
    const meta = JSON.parse(await runRaw(body, signal))
    if (meta.kind !== 'zoom') {
      scale = { x: meta.x, y: meta.y, pw: meta.pw, ph: meta.ph, fw: meta.fw, fh: meta.fh }
    }
    const file = meta.kind === 'zoom' ? meta.crop : meta.small
    const target = await ctx.fs.resolve(file)
    const data = await ctx.fs.readBytes(target, signal, 33554432)
    const ref = await ctx.attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: String(file).split(/[\\/]/).pop(),
    })
    const frameText = meta.kind === 'zoom'
      ? 'Zoom crop of physical region (' + meta.cx + ',' + meta.cy + ') ' + meta.cw + 'x' + meta.ch + '. This image is NOT the coordinate frame; keep using the last full screenshot' + (scale === null ? '' : ' (' + scale.fw + 'x' + scale.fh + ')') + ' for coordinates.'
      : 'Coordinate frame: pixels of THIS ' + meta.fw + 'x' + meta.fh + ' image (top-left origin). Physical virtual desktop: ' + meta.pw + 'x' + meta.ph + ' at (' + meta.x + ',' + meta.y + '); your screenshot coordinates are scaled back automatically.'
    return {
      summary,
      frameText,
      image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
    }
  }

  const requireScale = () => {
    if (scale === null) throw new Error('No screen geometry yet: call computer_screenshot first — every coordinate is a pixel of the latest screenshot.')
    return scale
  }
  const toPhysical = (fx, fy, label) => {
    const s = requireScale()
    if (typeof fx !== 'number' || !isFinite(fx) || typeof fy !== 'number' || !isFinite(fy)) throw new Error(label + ' must be finite numbers')
    if (fx < 0 || fy < 0 || fx > s.fw || fy > s.fh) throw new Error(label + ' (' + fx + ', ' + fy + ') is outside the ' + s.fw + 'x' + s.fh + ' screenshot frame')
    return [Math.round(s.x + (fx * s.pw) / s.fw), Math.round(s.y + (fy * s.ph) / s.fh)]
  }
  const parseXY = (str, label) => {
    const seg = String(str).split(',')
    if (seg.length !== 2) throw new Error(label + ' needs "x,y"')
    const x = Number(seg[0])
    const y = Number(seg[1])
    if (!isFinite(x) || !isFinite(y)) throw new Error(label + ' x,y must be numbers')
    return [x, y]
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && signal.aborted) reject(new Error('cancelled'))
      else resolve()
    }, ms)
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
    }
  })

  const VK = {}
  for (let c = 97; c <= 122; c++) VK[String.fromCharCode(c)] = c - 32
  for (let d = 48; d <= 57; d++) VK[String.fromCharCode(d)] = d
  for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6f + i
  const named = {
    enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
    backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    win: 0x5b, meta: 0x5b, ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10,
    capslock: 0x14, printscreen: 0x2c,
    minus: 0xbd, equals: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf,
    backslash: 0xdc, semicolon: 0xba, quote: 0xde, grave: 0xc0,
  }
  Object.keys(named).forEach((k) => { VK[k] = named[k] })
  const parseKeys = (spec) => {
    const toks = String(spec).toLowerCase().split('+').map((t) => t.trim()).filter((t) => t !== '')
    if (toks.length === 0) throw new Error('keys must look like "ctrl+s" or "alt+F4"')
    return toks.map((t) => {
      const vk = VK[t]
      if (vk === undefined) throw new Error('unknown key "' + t + '" (a-z, 0-9, f1-f12, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, ctrl, alt, shift, win, minus, equals, comma, period, slash, backslash, semicolon, quote, grave)')
      return vk
    })
  }

  const COORD_DESC = 'Coordinates are PIXELS OF THE LATEST screenshot, top-left origin.'
  const KEYB_FIRST = ' KEYBOARD-FIRST: prefer computer_open / computer_key / computer_sequence over mouse clicks whenever the target has a keyboard path; reserve the mouse for targets that truly need it.'
  const KEEP_CURSOR = { keep_cursor: { type: 'boolean', description: 'true leaves the cursor at the target; default false returns it to where the human left it AFTER the result screenshot is taken.' } }
  const register = (definition) => ctx.effect(() => ctx.tools.register(defineTool(definition)), 'computer-use: tool ' + definition.name)

  register({
    name: 'computer_screenshot',
    description: 'Capture the whole virtual desktop (all monitors stitched). The returned image is the coordinate frame for every computer_* tool: ' + COORD_DESC + ' Wide screens are downscaled (max ' + maxDim + 'px long edge) and your coordinates are scaled back automatically. After any computer_* action you already receive a fresh screenshot — do not re-capture unnecessarily.' + KEYB_FIRST,
    parameters: {},
    output: SHOT_RENDER,
    isConcurrencySafe: () => true,
    timeoutMs: 25000,
    async execute(_args, exec) {
      return await capture(exec.signal, 'Desktop captured.', undefined)
    },
  })

  register({
    name: 'computer_cursor',
    description: 'Read the current mouse cursor position (physical px, plus screenshot px when a screenshot geometry is known).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        physical: { type: 'string', required: true },
        frame: { type: 'string' },
      } },
      render: (_a, v) => [{ type: 'text', text: 'cursor at physical px ' + v.physical + (v.frame === undefined ? ' (no screenshot yet — call computer_screenshot for the coordinate frame)' : ', screenshot px ' + v.frame) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    async execute(_args, exec) {
      const p = await getPos(exec.signal)
      if (p === null) throw new Error('unreadable cursor position')
      const value = { physical: p[0] + ',' + p[1] }
      if (scale !== null) {
        value.frame = Math.round(((p[0] - scale.x) * scale.fw) / scale.pw) + ',' + Math.round(((p[1] - scale.y) * scale.fh) / scale.ph)
      }
      return value
    },
  })

  const actionTool = (toolName, desc, params, build, cursorMoving) => register({
    name: toolName,
    description: desc + ' ' + COORD_DESC + ' The whole gesture runs atomically once approved (no separate move step needed), waits briefly, then returns a FRESH full screenshot.' + KEYB_FIRST,
    parameters: params,
    output: SHOT_RENDER,
    timeoutMs: 40000,
    async execute(args, exec) {
      const plan = await build(args)
      const restore = cursorMoving && args.keep_cursor !== true
      const before = restore ? await getPos(exec.signal) : null
      granted.add(agentKey(exec.agent))
      for (let i = 0; i < plan.calls.length; i++) {
        await inputCall(plan.calls[i], exec.signal)
      }
      await sleep(settleMs, exec.signal)
      const value = await capture(exec.signal, plan.summary)
      if (restore && before !== null) {
        await inputCall('-Action move -X ' + before[0] + ' -Y ' + before[1], exec.signal)
        value.summary = plan.summary + ' [cursor returned to the human\'s position (' + before[0] + ',' + before[1] + '); pass keep_cursor=true if the next action depends on hover/pointer state there]'
      }
      return value
    },
  })

  actionTool('computer_move', 'Move the mouse pointer to (x, y) and leave it there (hover state, or to aim computer_scroll). NOT needed before computer_click — click moves and clicks atomically.', {
    x: { type: 'number', required: true, description: 'X pixel in the latest screenshot.' },
    y: { type: 'number', required: true, description: 'Y pixel in the latest screenshot.' },
  }, async (a) => {
    const p = toPhysical(num(a.x, 'x'), num(a.y, 'y'), 'move target')
    return { calls: ['-Action move -X ' + p[0] + ' -Y ' + p[1]], summary: 'Mouse moved to screenshot px (' + a.x + ',' + a.y + ') = physical (' + p[0] + ',' + p[1] + ') and left there.' }
  }, false)

  actionTool('computer_click', 'Click the mouse AT (x, y): move, button-down and button-up happen as ONE atomic gesture in this single call — do NOT call computer_move first. button = left|right|middle (default left); clicks 1-3; keys = optional modifier chord held during the click. Clicking at the CURRENT position: omit x and y. Small targets in the downscaled frame are easy to miss — zoom first, or prefer a keyboard path.', {
    x: { type: 'number', description: 'X pixel of the target in the latest screenshot.' },
    y: { type: 'number', description: 'Y pixel of the target in the latest screenshot.' },
    button: { type: 'string', description: 'left | right | middle. Default left.' },
    clicks: { type: 'number', description: 'Click count 1-3. Default 1.' },
    keys: { type: 'string', description: 'Optional held modifiers, e.g. "ctrl" or "ctrl+shift".' },
    keep_cursor: KEEP_CURSOR.keep_cursor,
  }, async (a) => {
    const calls = []
    if (a.x !== undefined && a.y !== undefined) {
      const p = toPhysical(num(a.x, 'x'), num(a.y, 'y'), 'click target')
      calls.push('-Action move -X ' + p[0] + ' -Y ' + p[1])
    } else if (a.x !== undefined || a.y !== undefined) {
      throw new Error('click needs BOTH x and y, or neither (click at current position)')
    }
    const button = a.button === undefined ? 'left' : String(a.button)
    if (button !== 'left' && button !== 'right' && button !== 'middle') throw new Error('button must be left|right|middle')
    const clicks = intIn(a.clicks, 'clicks', 1, 3, 1)
    let call = '-Action click -Button ' + button + ' -Clicks ' + clicks
    if (a.keys !== undefined) call += ' -Vk ' + parseKeys(a.keys).join(',')
    calls.push(call)
    return { calls, summary: 'Clicked ' + button + ' x' + clicks + (a.keys === undefined ? '' : ' holding ' + a.keys) + (a.x === undefined ? ' at current cursor position' : ' at screenshot px (' + a.x + ',' + a.y + ')') + '.' }
  }, true)

  actionTool('computer_drag', 'Press-drag-release from (fromX, fromY) to (toX, toY) as one atomic gesture.', {
    fromX: { type: 'number', required: true },
    fromY: { type: 'number', required: true },
    toX: { type: 'number', required: true },
    toY: { type: 'number', required: true },
    keep_cursor: KEEP_CURSOR.keep_cursor,
  }, async (a) => {
    const p1 = toPhysical(num(a.fromX, 'fromX'), num(a.fromY, 'fromY'), 'drag start')
    const p2 = toPhysical(num(a.toX, 'toX'), num(a.toY, 'toY'), 'drag end')
    return { calls: ['-Action drag -X ' + p1[0] + ' -Y ' + p1[1] + ' -X2 ' + p2[0] + ' -Y2 ' + p2[1]], summary: 'Dragged from (' + a.fromX + ',' + a.fromY + ') to (' + a.toX + ',' + a.toY + ').' }
  }, true)

  actionTool('computer_scroll', 'Scroll the mouse wheel at the CURRENT cursor position (use computer_move first to aim; scroll leaves the cursor where it aimed). direction = up|down|left|right; amount = 1-20 notches (default 3).', {
    direction: { type: 'string', required: true, description: 'up | down | left | right.' },
    amount: { type: 'number', description: 'Wheel notches 1-20. Default 3.' },
    x: { type: 'number', description: 'Optional X pixel to move to before scrolling (cursor stays there).' },
    y: { type: 'number', description: 'Optional Y pixel to move to before scrolling (cursor stays there).' },
  }, async (a) => {
    const calls = []
    if (a.x !== undefined && a.y !== undefined) {
      const p = toPhysical(num(a.x, 'x'), num(a.y, 'y'), 'scroll position')
      calls.push('-Action move -X ' + p[0] + ' -Y ' + p[1])
    }
    const direction = String(a.direction)
    if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') throw new Error('direction must be up|down|left|right')
    const amount = intIn(a.amount, 'amount', 1, 20, 3)
    calls.push('-Action scroll -Direction ' + direction + ' -Amount ' + amount)
    return { calls, summary: 'Scrolled ' + direction + ' by ' + amount + '.' }
  }, false)

  actionTool('computer_type', 'Type text via unicode keyboard injection (independent of IME/layout); it goes to whatever currently has keyboard focus — click the field first (atomically in that click call). Does not move the cursor. For multi-step flows use computer_sequence to avoid one round-trip per step.', {
    text: { type: 'string', required: true, description: 'Text to type; newlines become Enter. Max 5000 chars.' },
  }, async (a) => {
    if (typeof a.text !== 'string' || a.text.length === 0) throw new Error('text must be a non-empty string')
    if (a.text.length > 5000) throw new Error('text too long (max 5000 chars)')
    return { calls: ['-Action type -Text ' + psQuote(a.text)], summary: 'Typed ' + a.text.length + ' characters.' }
  }, false)

  actionTool('computer_key', 'Press a key or chord: keys="ctrl+s", keys="alt+F4", keys="enter". Names: a-z, 0-9, f1-f12, enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, arrows, ctrl, alt, shift, win. repeat 1-10. Does not move the cursor.', {
    keys: { type: 'string', required: true, description: 'Plus-joined key names, e.g. "ctrl+shift+s".' },
    repeat: { type: 'number', description: 'Press the chord N times, 1-10. Default 1.' },
  }, async (a) => {
    const vks = parseKeys(a.keys)
    const repeat = intIn(a.repeat, 'repeat', 1, 10, 1)
    return { calls: ['-Action chord -Vk ' + vks.join(',') + ' -Repeat ' + repeat], summary: 'Pressed ' + a.keys + (repeat > 1 ? ' x' + repeat : '') + '.' }
  }, false)

  register({
    name: 'computer_open',
    description: 'Open/launch an app or file by name with a keyboard flow in ONE call: open Start (Win), wait, type the name (unicode), wait for Windows search, press Enter, wait, then return ONE screenshot. PREFERRED over clicking Start-menu icons. Returns after the flow; verify the result in the returned screenshot.' + KEYB_FIRST,
    parameters: {
      name: { type: 'string', required: true, description: 'App/file name as Windows search knows it, e.g. "微信", "notepad", "Chrome". Max 100 chars.' },
      settle_seconds: { type: 'number', description: 'Extra wait after Enter for slow launches, 0-10. Default 1.5.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 40000,
    async execute(a, exec) {
      const appName = typeof a.name === 'string' ? a.name.trim() : ''
      if (appName === '' || appName.length > 100) throw new Error('name must be 1-100 chars')
      const settle = intIn(a.settle_seconds, 'settle_seconds', 0, 10, 1.5) * 1000
      granted.add(agentKey(exec.agent))
      await inputCall('-Action chord -Vk 91', exec.signal)
      await sleep(700, exec.signal)
      await inputCall('-Action type -Text ' + psQuote(appName), exec.signal)
      await sleep(1400, exec.signal)
      await inputCall('-Action chord -Vk 13', exec.signal)
      await sleep(settle, exec.signal)
      return await capture(exec.signal, 'Opened "' + appName + '" via Start search (Win → type → Enter).', undefined)
    },
  })

  const compileStep = (raw) => {
    const s = String(raw)
    const c1 = s.indexOf(':')
    const head = (c1 === -1 ? s : s.slice(0, c1)).toLowerCase().trim()
    const rest = c1 === -1 ? '' : s.slice(c1 + 1)
    if (head === 'key') {
      return { items: [{ in: '-Action chord -Vk ' + parseKeys(rest).join(',') }], moves: false }
    }
    if (head === 'keydown') {
      return { items: [{ in: '-Action keydown -Vk ' + parseKeys(rest).join(',') }], moves: false }
    }
    if (head === 'keyup') {
      return { items: [{ in: '-Action keyup -Vk ' + parseKeys(rest).join(',') }], moves: false }
    }
    if (head === 'type') {
      if (rest === '' || rest.length > 5000) throw new Error('type text must be 1-5000 chars')
      return { items: [{ in: '-Action type -Text ' + psQuote(rest) }], moves: false }
    }
    if (head === 'wait') {
      const sec = parseFloat(rest)
      if (!isFinite(sec) || sec < 0 || sec > 15) throw new Error('wait seconds must be 0-15')
      return { items: [{ wait: Math.round(sec * 1000) }], moves: false }
    }
    if (head === 'move') {
      const f = parseXY(rest, 'move')
      const p = toPhysical(f[0], f[1], 'move')
      return { items: [{ in: '-Action move -X ' + p[0] + ' -Y ' + p[1] }], moves: true }
    }
    if (head === 'click') {
      let button = 'left'
      let clicks = 1
      let xy = rest
      if (rest.indexOf(':') !== -1) {
        const li = rest.lastIndexOf(':')
        xy = rest.slice(li + 1)
        rest.slice(0, li).split(':').forEach((m) => {
          if (m === 'left' || m === 'right' || m === 'middle') button = m
          else if (/^[1-3]$/.test(m)) clicks = parseInt(m, 10)
          else if (m !== '') throw new Error('click modifiers must be left|right|middle or 1-3, got "' + m + '"')
        })
      }
      if (xy.trim() === '') return { items: [{ in: '-Action click -Button ' + button + ' -Clicks ' + clicks }], moves: false }
      const f = parseXY(xy, 'click')
      const p = toPhysical(f[0], f[1], 'click')
      return { items: [{ in: '-Action move -X ' + p[0] + ' -Y ' + p[1] }, { in: '-Action click -Button ' + button + ' -Clicks ' + clicks }], moves: true }
    }
    if (head === 'scroll') {
      const seg = rest.split(',').map((t) => t.trim())
      const dir = seg[0]
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') throw new Error('scroll direction must be up|down|left|right')
      const amt = intIn(seg.length > 1 && seg[1] !== '' ? Number(seg[1]) : undefined, 'scroll amount', 1, 20, 3)
      const mods = seg.slice(2).filter((t) => t !== '')
      let call = '-Action scroll -Direction ' + dir + ' -Amount ' + amt
      if (mods.length > 0) call += ' -Vk ' + parseKeys(mods.join('+')).join(',')
      return { items: [{ in: call }], moves: false }
    }
    if (head === 'open') {
      const appName = rest.trim()
      if (appName === '' || appName.length > 100) throw new Error('open name must be 1-100 chars')
      return {
        items: [
          { in: '-Action chord -Vk 91' }, { wait: 700 },
          { in: '-Action type -Text ' + psQuote(appName) }, { wait: 1400 },
          { in: '-Action chord -Vk 13' }, { wait: 800 },
        ],
        moves: false,
      }
    }
    throw new Error('unknown action "' + head + '" (use key/keydown/keyup/type/wait/move/click/scroll/open)')
  }

  register({
    name: 'computer_sequence',
    description: 'Run a multi-step desktop flow atomically in ONE call with ONE approval and ONE final screenshot (intermediate states not shown). Step DSL, one string per step: key:ctrl+s · keydown:ctrl / keyup:ctrl (hold across steps) · type:任意文本 · wait:1.5 · open:微信 · move:x,y · click:845,302 or click:right:2:845,302 or click: (at current position) · scroll:down,5 or scroll:up,6,ctrl (3rd part = held modifiers). Coordinates = pixels of the latest screenshot. All steps validate before the first keystroke. Use for flows like open-app/type/enter instead of many single tool calls.' + KEYB_FIRST,
    parameters: {
      steps: { type: 'array', required: true, description: 'Ordered step strings, max 30 steps.', items: { type: 'string' } },
    },
    output: SHOT_RENDER,
    timeoutMs: 60000,
    async execute(a, exec) {
      if (!Array.isArray(a.steps) || a.steps.length === 0) throw new Error('steps must be a non-empty array of step strings')
      if (a.steps.length > 30) throw new Error('max 30 steps per sequence')
      const runner = []
      let moves = false
      for (let i = 0; i < a.steps.length; i++) {
        let compiled
        try {
          compiled = compileStep(a.steps[i])
        } catch (e) {
          throw new Error('step ' + (i + 1) + ' "' + String(a.steps[i]).slice(0, 60) + '": ' + e.message)
        }
        for (const item of compiled.items) runner.push(item)
        if (compiled.moves) moves = true
      }
      const before = moves ? await getPos(exec.signal) : null
      granted.add(agentKey(exec.agent))
      for (const item of runner) {
        if (item.wait !== undefined) await sleep(item.wait, exec.signal)
        else await inputCall(item.in, exec.signal)
      }
      await sleep(settleMs, exec.signal)
      const summary = 'Ran ' + a.steps.length + ' steps: ' + a.steps.join(' → ').slice(0, 300)
      const value = await capture(exec.signal, summary, undefined)
      if (moves && before !== null) {
        await inputCall('-Action move -X ' + before[0] + ' -Y ' + before[1], exec.signal)
        value.summary = summary + ' [cursor returned to the human\'s position (' + before[0] + ',' + before[1] + ')]'
      }
      return value
    },
  })

  register({
    name: 'computer_zoom',
    description: 'Capture a magnified crop of a screenshot region (x0, y0)-(x1, y1) to read small text or icons. The crop is NOT the coordinate frame — coordinates keep referring to the full screenshot.',
    parameters: {
      x0: { type: 'number', required: true },
      y0: { type: 'number', required: true },
      x1: { type: 'number', required: true, description: 'Must be > x0.' },
      y1: { type: 'number', required: true, description: 'Must be > y0.' },
    },
    output: SHOT_RENDER,
    isConcurrencySafe: () => true,
    timeoutMs: 25000,
    async execute(a, exec) {
      const p0 = toPhysical(num(a.x0, 'x0'), num(a.y0, 'y0'), 'zoom corner')
      const p1 = toPhysical(num(a.x1, 'x1'), num(a.y1, 'y1'), 'zoom corner')
      if (p1[0] <= p0[0] || p1[1] <= p0[1]) throw new Error('zoom region needs x1 > x0 and y1 > y0')
      return await capture(exec.signal, 'Zoomed region (' + a.x0 + ',' + a.y0 + ')-(' + a.x1 + ',' + a.y1 + ') of the desktop.', { X: p0[0], Y: p0[1], W: p1[0] - p0[0], H: p1[1] - p0[1] })
    },
  })

  register({
    name: 'computer_wait',
    description: 'Wait for a few seconds (animations, loading) and return a fresh full screenshot.',
    parameters: {
      seconds: { type: 'number', required: true, description: 'Seconds to wait, 0.1-15.' },
    },
    output: SHOT_RENDER,
    timeoutMs: 25000,
    async execute(a, exec) {
      const s = num(a.seconds, 'seconds')
      if (s < 0.1 || s > 15) throw new Error('seconds must be 0.1-15')
      await sleep(Math.round(s * 1000), exec.signal)
      return await capture(exec.signal, 'Waited ' + s + 's.', undefined)
    },
  })

  const MUTATING = new Set(['computer_move', 'computer_click', 'computer_drag', 'computer_scroll', 'computer_type', 'computer_key', 'computer_open', 'computer_sequence'])
  ctx.on('tools/pre-execute', (exec, next) => {
    if (MUTATING.has(exec.name) && (askPolicy === 'always' || !granted.has(agentKey(exec.agent)))) {
      return { kind: 'ask', reason: '允许 computer-use 控制鼠标/键盘？一次批准覆盖同一会话的后续动作（askPolicy: always 可改为每次一询）；鼠标动作默认会把指针放回你的原位。首个动作: ' + exec.name + '。' }
    }
    return next()
  })

  ctx.logger.info('computer-use: 12 tools; outDir=' + outDir + '; askPolicy=' + askPolicy)
}
