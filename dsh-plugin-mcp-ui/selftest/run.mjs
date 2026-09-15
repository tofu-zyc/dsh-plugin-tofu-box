// dsh-plugin-mcp-ui 宿主半边自测：直接实例化 McpUiService（fake ctx + 真实
// TypertRemoteService 基类），并用 @deepseek-ai/dsh 自带的 yaml 解析器验证
// 生成文件可被真实解析。Remote 方法约定：成功返回 JSON-safe 值，失败抛 RemoteError。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')
const YAML = require('yaml')

const { apply } = await import('../index.js')
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')

const BEGIN = '# >>> dsh-plugin-mcp-ui managed (edits inside this block are owned by the settings UI) >>>'
const END = '# <<< dsh-plugin-mcp-ui managed <<<'

const USER_HEAD = [
  '# 我的 web profile，手工内容必须逐字保留',
  '- insert:',
  '    - id: external-mcp',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        transport: stdio',
  '        serverName: "externally-added"',
  '        command: "npx"',
  '        args:',
  '          - "-y"',
  '',
].join('\n')
const USER_TAIL = '\n# 尾部注释：也要原样保留\n- insert:\n    - id: some-other-row\n      name: dsh-something\n'

function makeService(seedText) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-ui-test-'))
  const patchPath = path.join(dir, 'cordis.patch.yml')
  if (seedText !== undefined) writeFileSync(patchPath, seedText, 'utf8')
  const logs = []
  let provided = null
  const ctx = {
    logger: {
      info: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
    effect: () => {},
    reflect: {
      provide: (name, value) => { provided = { name, value } },
    },
    get: () => undefined,
  }
  apply(ctx, { patchPath })
  return {
    dir, patchPath, logs,
    service: () => {
      assert.equal(provided.name, 'mcpUi', '服务必须注册为 mcpUi')
      return provided.value
    },
    text: () => readFileSync(patchPath, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// 模拟网关的 RemoteError 编码：返回 {ok,value} / {ok:false,error:{code,message,details}}
async function rpc(service, method, args) {
  try {
    return { ok: true, value: service[method](...Object.values(args ?? {})) }
  } catch (error) {
    if (error?.isDSHRemoteError === true) {
      return { ok: false, error: { code: error.code, message: error.message, details: error.details ?? {} } }
    }
    return { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error), details: {} } }
  }
}

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`) }
  catch (error) { results.push(`FAIL ${name}: ${error?.stack ?? error}`) }
}

await test('服务注册为 mcpUi + Remote 标记齐备', async () => {
  const h = makeService('')
  const service = h.service()
  assert.equal(service.typertRemote.serviceKey, 'mcpUi')
  assert.equal(service.typertRemote.namespace, 'mcpUi')
  assert.equal(service.typertRemote.service, service)
  assert.deepEqual(remoteMethods(service).map((m) => m.method), ['list', 'save', 'remove', 'toggle'])
  const list = await rpc(service, 'list')
  assert.equal(list.ok, true)
  assert.deepEqual(list.value.entries, [])
  assert.deepEqual(list.value.external, [])
  assert.ok(list.value.path.endsWith('cordis.patch.yml'))
  h.cleanup()
})

await test('stdio 保存：YAML 可解析、字段回读一致、用户区保留', async () => {
  const h = makeService(USER_HEAD + USER_TAIL)
  const service = h.service()
  const save = await rpc(service, 'save', {
    entry: {
      serverName: 'demo_srv',
      transport: 'stdio',
      command: 'npx',
      args: '-y\r\n@modelcontextprotocol/server-fs "C:\\temp dir"中文',
      env: 'API_KEY=sk-abc#1\nQUOTED="x"\nCN=中文值',
      cwd: 'D:\\work',
      toolCallTimeoutMs: '90000',
    },
    originalId: '',
  })
  assert.equal(save.ok, true, JSON.stringify(save))
  assert.equal(save.value.changed, true)
  const text = h.text()
  assert.ok(text.startsWith('# 我的 web profile'), 'head 丢失')
  assert.ok(text.includes('尾部注释'), 'tail 丢失')
  const doc = YAML.parse(text) // 真实解析器，不过关即报错
  const rows = doc.flatMap((op) => op.insert ?? [])
  const managed = rows.find((r) => r.id === 'mcp-demo_srv')
  assert.ok(managed, `找不到生成行: ${JSON.stringify(rows.map((r) => r.id))}`)
  assert.equal(managed.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(managed.config.serverName, 'demo_srv')
  assert.deepEqual(managed.config.args, ['-y', '@modelcontextprotocol/server-fs "C:\\temp dir"中文'])
  assert.deepEqual(managed.config.env, { API_KEY: 'sk-abc#1', QUOTED: '"x"', CN: '中文值' })
  assert.equal(managed.config.cwd, 'D:\\work')
  assert.equal(managed.config.toolCallTimeoutMs, 90000)
  // list 回读（走自身解析器）必须与写入值一致
  const list = await rpc(service, 'list')
  const entry = list.value.entries.find((e) => e.serverName === 'demo_srv')
  assert.deepEqual(entry.args, managed.config.args)
  assert.deepEqual(entry.env, managed.config.env)
  // 外部行只读展示
  assert.deepEqual(list.value.external, [{ id: 'external-mcp', serverName: 'externally-added', target: 'npx' }])
  // 重复保存同内容 → changed:false（避免 HMR 抖动）
  const again = await rpc(service, 'save', { entry: { ...entry, toolCallTimeoutMs: 90000 }, originalId: entry.id })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(again.value.changed, false, '内容未变应 changed:false')
  h.cleanup()
})

await test('新建 profile 的 [] 模板：写入后剔除 [] 且仍为合法 YAML 数组', async () => {
  const template = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries.',
    '[]',
    '',
  ].join('\n')
  const h = makeService(template)
  const service = h.service()
  const save = await rpc(service, 'save', { entry: { serverName: 'fresh', transport: 'stdio', command: 'x' }, originalId: '' })
  assert.equal(save.ok, true, JSON.stringify(save))
  const text = h.text()
  assert.ok(!/^\[\s*\]$/m.test(text), '残留的 [] 会和块序列构成两个文档节点')
  const doc = YAML.parse(text)
  assert.ok(Array.isArray(doc), '顶层必须是 YAML 数组')
  const ids = doc.flatMap((op) => op.insert ?? []).map((r) => r.id)
  assert.ok(ids.includes('mcp-fresh'))
  // 删除全部条目后仍要合法：全注释文件会由 joinFile 补 `[]`（dsh 要求顶层数组）
  await rpc(service, 'remove', { serverId: 'mcp-fresh' })
  const after = YAML.parse(h.text())
  assert.deepEqual(after, [], '清空后应为合法空数组')
  // 幂等：再次清空保存不得产生第二个 []
  const again = await rpc(service, 'save', { entry: { serverName: 'fresh', transport: 'stdio', command: 'x' }, originalId: '' })
  await rpc(service, 'remove', { serverId: 'mcp-fresh' })
  assert.equal((h.text().match(/^\[\s*\]$/gm) ?? []).length, 1, '[] 不得重复')
  assert.equal(again.ok, true)
  h.cleanup()
})

await test('http 保存 + 编辑改 id + disabled 落盘', async () => {
  const h = makeService(USER_HEAD + USER_TAIL)
  const service = h.service()
  const save = await rpc(service, 'save', {
    entry: { serverName: 'remote1', transport: 'streamable-http', url: 'https://example.com/mcp', headers: 'Authorization=Bearer x.y.z' },
    originalId: '',
  })
  assert.equal(save.ok, true, JSON.stringify(save))
  const toggle = await rpc(service, 'toggle', { serverId: save.value.entry.id, enabled: false })
  assert.equal(toggle.ok, true)
  assert.match(h.text(), /disabled: true/)
  const edit = await rpc(service, 'save', {
    entry: { ...toggle.value.entry, id: 'http-remote-renamed', url: 'https://example.com/mcp2' },
    originalId: save.value.entry.id,
  })
  assert.equal(edit.ok, true, JSON.stringify(edit))
  const doc = YAML.parse(h.text())
  const row = doc.flatMap((op) => op.insert).find((r) => r.id === 'http-remote-renamed')
  assert.ok(row, '改 id 后找不到行')
  assert.equal(row.config.url, 'https://example.com/mcp2')
  assert.equal(row.disabled, true)
  assert.equal(row.config.headers.Authorization, 'Bearer x.y.z')
  h.cleanup()
})

await test('校验错误：RemoteError 编码 code=mcp-ui/invalid + details', async () => {
  const h = makeService('')
  const service = h.service()
  const badName = await rpc(service, 'save', { entry: { serverName: '不合法!', transport: 'stdio', command: 'x' }, originalId: '' })
  assert.equal(badName.ok, false)
  assert.equal(badName.error.code, 'mcp-ui/invalid')
  assert.ok(badName.error.details.serverName)
  const noCmd = await rpc(service, 'save', { entry: { serverName: 'a', transport: 'stdio', command: '  ' }, originalId: '' })
  assert.equal(noCmd.ok, false); assert.ok(noCmd.error.details.command)
  const badUrl = await rpc(service, 'save', { entry: { serverName: 'b', transport: 'streamable-http', url: 'ftp://x' }, originalId: '' })
  assert.equal(badUrl.ok, false); assert.ok(badUrl.error.details.url)
  const ok1 = await rpc(service, 'save', { entry: { serverName: 'dup', transport: 'stdio', command: 'x' }, originalId: '' })
  assert.equal(ok1.ok, true)
  const dupName = await rpc(service, 'save', { entry: { serverName: 'dup', transport: 'stdio', command: 'y', id: 'other-id' }, originalId: '' })
  assert.equal(dupName.ok, false); assert.match(dupName.error.message, /占用/)
  const dupId = await rpc(service, 'save', { entry: { serverName: 'third', transport: 'stdio', command: 'y', id: 'mcp-dup' }, originalId: '' })
  assert.equal(dupId.ok, false); assert.ok(dupId.error.details.id)
  const badKv = await rpc(service, 'save', { entry: { serverName: 'kv', transport: 'stdio', command: 'x', env: 'NO_EQUALS_LINE' }, originalId: '' })
  assert.equal(badKv.ok, false); assert.ok(badKv.error.details.env)
  const gone = await rpc(service, 'remove', { serverId: 'nope' })
  assert.equal(gone.ok, false); assert.equal(gone.error.code, 'mcp-ui/invalid')
  // 失败的保存不得污染文件：只剩 dup
  const list = await rpc(service, 'list')
  assert.deepEqual(list.value.entries.map((e) => e.serverName), ['dup'])
  h.cleanup()
})

await test('删除后文件仍然合法 YAML 且标记块保留', async () => {
  const h = makeService(USER_HEAD + USER_TAIL)
  const service = h.service()
  const save = await rpc(service, 'save', { entry: { serverName: 'tmp1', transport: 'stdio', command: 'x' }, originalId: '' })
  await rpc(service, 'remove', { serverId: save.value.entry.id })
  const text = h.text()
  assert.ok(text.includes('# >>>'), '标记块开始丢失')
  assert.ok(text.includes(END))
  const doc = YAML.parse(text)
  const ids = doc.flatMap((op) => op.insert ?? []).map((r) => r.id)
  assert.ok(!ids.includes('mcp-tmp1'))
  assert.ok(ids.includes('external-mcp') && ids.includes('some-other-row'), '用户行被误删')
  h.cleanup()
})

await test('link 开发安装拒绝推导（无 patchPath 时报错）', async () => {
  const ctx = { logger: { info() {}, warn() {} }, effect: () => {}, reflect: { provide() {} }, get: () => undefined }
  assert.throws(() => apply(ctx, {}), /patchPath/)
})

console.log(results.join('\n'))
process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0)
