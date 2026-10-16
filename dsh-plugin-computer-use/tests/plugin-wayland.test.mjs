import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as linux from '../linux.js'

const originalEnv = { ...process.env }
Object.assign(process.env, { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' })
delete process.env[linux.WAYLAND_ENV]
let probeDone = false
let listError = false
let inputError = false
let png
const calls = []
const result = (structured = {}) => ({ isError: false, text: 'OK', structuredJson: JSON.stringify(structured), images: [] })

mock.module('../linux.js', { namedExports: {
  ...linux,
  configureLinuxDesktop: options => linux.configureLinuxDesktop({ ...options, platform: 'linux' }),
  probeGnomeHelper: async () => { probeDone = true; return { active: false, version: 0 } },
} })
mock.module('@trycua/cua-driver', { namedExports: { CuaDriver: { create() {
  assert.equal(process.env[linux.WAYLAND_ENV], '1', 'Wayland must be enabled before native runtime creation')
  assert.equal(probeDone, true)
  return {
    async callTool(tool, json) {
      const args = JSON.parse(json)
      calls.push({ tool, args })
      if (tool === 'list_windows') return listError ? { isError: true, text: 'compositor geometry unavailable' } : result({ windows: [] })
      if (tool === 'get_desktop_state') return { ...result({ screen_width: 2, screen_height: 2 }), images: [{ dataBase64: png.toString('base64') }] }
      if (tool === 'click') {
        if (inputError) return { isError: true, text: 'remote desktop permission denied' }
        if (args.delivery_mode !== 'foreground') return { isError: true, text: 'background_unavailable: raw Wayland input requires foreground' }
      }
      return result()
    },
    async shutdown() {},
  }
} } } })

const { apply, pngEncode } = await import('../index.js')
png = pngEncode({ width: 2, height: 2, data: Buffer.alloc(16, 255) })
const tools = new Map()
const logs = []
const disposers = []
let gate
const ctx = {
  get: () => undefined,
  logger: { info: value => logs.push(value), warn: value => logs.push(value) },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  on(event, fn) { if (event === 'tools/pre-execute') gate = fn },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  attachments: { async saveImage({ data, mediaType }) { return { attachmentId: 'test-image', mediaType, bytes: data.length, width: 2, height: 2 } } },
}
apply(ctx, { dpiAware: false, settleMs: 0 })
const exec = { agent: { id: 'wayland-agent' }, signal: new AbortController().signal }

test.after(() => {
  for (const dispose of disposers.reverse()) dispose()
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

test('real plugin wiring registers all tools and explains missing Wayland setup on an empty window list', async () => {
  const windows = await tools.get('computer_windows').execute({})
  assert.equal(tools.size, 13)
  assert.match(windows.table, /no windows matched.*dsh-computer-use-wayland install/)
  assert.ok(logs.some(value => /WinRects helper missing/.test(value)))
  assert.ok(calls.filter(call => !['start_session', 'end_session'].includes(call.tool)).every(call => call.args.session === 'dsh-computer-use'))
  assert.match(tools.get('computer_click').description, /On native Wayland/)
  assert.equal(gate({ name: 'computer_click', ...exec }, () => 'pass').kind, 'ask')
  assert.equal(gate({ name: 'computer_screenshot', ...exec }, () => 'pass'), 'pass')
})

test('driver query failures retain the original error and add the GNOME setup remedy', async () => {
  listError = true
  try { await assert.rejects(tools.get('computer_windows').execute({}), /compositor geometry unavailable.*GNOME\/Wayland setup/) }
  finally { listError = false }
})

test('Wayland screenshot and foreground fallback keep their exact desktop target and named session', async () => {
  const shot = await tools.get('computer_screenshot').execute({ desktop: true })
  assert.equal(shot.image.width, 2)
  const clicked = await tools.get('computer_click').execute({ desktop: true, x: 1, y: 1 }, exec)
  assert.match(clicked.summary, /re-delivered/)
  const input = calls.filter(call => call.tool === 'click')
  assert.equal(input.length, 2)
  assert.equal(input[1].args.delivery_mode, 'foreground')
  assert.deepEqual(input[1].args.target, { kind: 'desktop', display_id: 'primary' })
  assert.equal(input[1].args.session, 'dsh-computer-use')
})

test('a portal permission refusal reaches the caller with an actionable hint', async () => {
  inputError = true
  try { await assert.rejects(tools.get('computer_click').execute({ desktop: true, x: 1, y: 1 }, exec), /remote desktop permission denied.*Remote Desktop prompt/) }
  finally { inputError = false }
})
