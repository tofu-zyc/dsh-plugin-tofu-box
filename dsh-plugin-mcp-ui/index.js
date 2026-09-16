import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'dsh-plugin-mcp-ui'

export const Config = z.object({
  // 被管理的 profile patch 文件。缺省时自动定位（见 resolvePatchPath）：
  // 1) 运行时锚点 ctx.baseUrl = profile 目录（dsh 每个顶层条目都挂在这棵
  //    include 树上，link: 开发安装也准）；
  // 2) 回退到安装位置 <profileDir>/node_modules/dsh-plugin-mcp-ui/（registry 安装）。
  // 两者都拿不到时才需要显式配置（覆盖行，勿重复 insert）。
  patchPath: z.string(),
})

const BEGIN = '# >>> dsh-plugin-mcp-ui managed (edits inside this block are owned by the settings UI) >>>'
const END = '# <<< dsh-plugin-mcp-ui managed <<<'
// profile 根配置文件名（dsh 的 include 锚点文件）与 patch 文件名。
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const MCP_ROW_NAME = '@deepseek-ai/dsh-mcp-client'
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const ROW_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const URL_RE = /^https?:\/\/\S+$/
// Remote 方法标记的原型属性名（@Remote() 装饰器的运行时等价物，见
// dsh-typert-protocol 的 addMarkerInitializer/mark）。
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

// ---- entry <-> YAML -------------------------------------------------------
// 块内容是本插件生成的确定性 YAML 子集：双引号标量（JSON 字符串是合法 YAML
// 双引号标量）、固定缩进。解析只针对自己写出的形状，永不解析用户区域。

function q(value) {
  return JSON.stringify(String(value))
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) return JSON.parse(text)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text)
  return text
}

function emitBlock(entries) {
  const lines = [BEGIN]
  if (entries.length > 0) {
    lines.push('- insert:')
    for (const entry of entries) {
      lines.push(`    - id: ${entry.id}`)
      lines.push(`      name: '${MCP_ROW_NAME}'`)
      if (entry.disabled === true) lines.push('      disabled: true')
      lines.push('      config:')
      lines.push(`        transport: ${entry.transport}`)
      lines.push(`        serverName: ${q(entry.serverName)}`)
      if (entry.transport === 'stdio') {
        lines.push(`        command: ${q(entry.command)}`)
        if (Array.isArray(entry.args) && entry.args.length > 0) {
          lines.push('        args:')
          for (const arg of entry.args) lines.push(`          - ${q(arg)}`)
        }
        if (entry.env && Object.keys(entry.env).length > 0) {
          lines.push('        env:')
          for (const [key, value] of Object.entries(entry.env)) lines.push(`          ${q(key)}: ${q(value)}`)
        }
        if (typeof entry.cwd === 'string' && entry.cwd !== '') lines.push(`        cwd: ${q(entry.cwd)}`)
      } else {
        lines.push(`        url: ${q(entry.url)}`)
        if (entry.headers && Object.keys(entry.headers).length > 0) {
          lines.push('        headers:')
          for (const [key, value] of Object.entries(entry.headers)) lines.push(`          ${q(key)}: ${q(value)}`)
        }
      }
      if (Number.isInteger(entry.toolCallTimeoutMs) && entry.toolCallTimeoutMs > 0) {
        lines.push(`        toolCallTimeoutMs: ${entry.toolCallTimeoutMs}`)
      }
      if (entry.failOnStartupError === true) lines.push('        failOnStartupError: true')
      if (entry.reconnect === false) {
        lines.push('        reconnect:')
        lines.push('          enabled: false')
      }
    }
  }
  lines.push(END)
  return lines.join('\n')
}

function parseBlock(body) {
  const entries = []
  let current = null
  let mode = null // 'args' | 'env' | 'headers' | null
  for (const raw of body.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    if (/^- insert:\s*$/.test(raw)) { mode = null; continue }
    const row = raw.match(/^ {4}- id: (\S+)\s*$/)
    if (row) {
      current = { id: row[1], disabled: false }
      entries.push(current)
      mode = null
      continue
    }
    if (!current) continue
    const rowKey = raw.match(/^ {6}(\S+): ?(.*)$/)
    if (rowKey) {
      if (rowKey[1] === 'disabled') current.disabled = parseScalar(rowKey[2]) === true
      mode = null
      continue
    }
    const cfgKey = raw.match(/^ {8}([A-Za-z][\w]*): ?(.*)$/)
    if (cfgKey) {
      const [, key, value] = cfgKey
      if (value === '') {
        if (key === 'args' || key === 'env' || key === 'headers') {
          current[key] = key === 'args' ? [] : {}
          mode = key
        }
      } else {
        current[key] = parseScalar(value)
        mode = null
      }
      continue
    }
    if (mode === 'args') {
      const item = raw.match(/^ {10}- (.+)$/)
      if (item) { current.args.push(parseScalar(item[1])); continue }
    } else if (mode === 'env' || mode === 'headers') {
      const item = raw.match(/^ {10}"?([^":"]+)"?: (.+)$/)
      if (item) { current[mode][parseScalar(item[1])] = parseScalar(item[2]); continue }
    }
    mode = null
  }
  return entries
}

function splitFile(text) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) {
    return { head: pruneEmptyFlow(text.replace(/\s*$/, '')), managed: [], tail: '' }
  }
  const head = pruneEmptyFlow(text.slice(0, begin).replace(/\s*$/, ''))
  const body = text.slice(begin + BEGIN.length, end)
  const tail = pruneEmptyFlow(text.slice(end + END.length).replace(/^\s*\n?/, '').replace(/\s*$/, ''))
  return { head, managed: parseBlock(body), tail }
}

// dsh 的 profile patch 模板自带一行空流数组 `[]`（仅此一行才有意义）。
// 管理块是块序列，若与 `[]` 并存会构成两个 YAML 文档节点 → 文件非法。
// 拼接前剔除这种独立成行的 `[]`；任何其他内容一律逐字保留。
function pruneEmptyFlow(text) {
  if (!/^\[\s*\]$/m.test(text)) return text
  return text
    .split('\n')
    .filter((line) => !/^\[\s*\]$/.test(line.trimEnd()))
    .join('\n')
    .replace(/\s*$/, '')
}

// 是否含真实的 YAML 数组内容（非注释、非空行）。
function hasArrayContent(text) {
  return text.split('\n').some((line) => {
    const t = line.trim()
    return t !== '' && !t.startsWith('#')
  })
}

function joinFile({ head, entries, tail }) {
  const parts = []
  if (head !== '') parts.push(head)
  parts.push(emitBlock(entries))
  if (tail !== '') parts.push(tail)
  let out = `${parts.join('\n')}\n`
  // 全文件（head + 标记块 + tail）若只剩注释，YAML 解析为 null，
  // dsh 会拒绝整个 profile patch。补一行 `[]` 保证顶层是合法空数组。
  if (entries.length === 0 && !hasArrayContent(head) && !hasArrayContent(tail)) {
    out = `${out}[]\n`
  }
  return out
}

// 只读扫描标记块之外的 mcp-client 行（用户手写 / 其它 patch 带来的），
// 仅供展示，UI 不编辑它们。
function scanExternal(text, managedIds) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  const outside =
    begin === -1 || end === -1 || end < begin
      ? text
      : text.slice(0, begin) + '\n' + text.slice(end + END.length)
  const external = []
  const lines = outside.split(/\r?\n/)
  let holder = null
  const flush = () => {
    if (holder && holder.name === MCP_ROW_NAME && holder.serverName !== '' && !managedIds.has(holder.id)) {
      external.push({ id: holder.id, serverName: holder.serverName, target: holder.target })
    }
    holder = null
  }
  for (const line of lines) {
    const id = line.match(/^\s*-? ?id: '?([\w-]+)'?\s*$/)
    if (id) {
      flush()
      holder = { id: id[1], name: '', serverName: '', target: '' }
      continue
    }
    if (!holder) continue
    if (/name: '?@deepseek-ai\/dsh-mcp-client'?/.test(line)) holder.name = MCP_ROW_NAME
    const serverName = line.match(/^\s*serverName: "?([^"\s]+)"?\s*$/)
    if (serverName && holder.name === MCP_ROW_NAME && holder.serverName === '') holder.serverName = serverName[1]
    const target = line.match(/^\s*(command|url): "?([^"\s]+)"?\s*$/)
    if (target && holder.name === MCP_ROW_NAME && holder.target === '') holder.target = target[2]
  }
  flush()
  return external
}

// ---- 校验 / 规范化 ---------------------------------------------------------

function parseKV(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const direct = {}
    for (const [key, value] of Object.entries(input)) direct[String(key)] = String(value ?? '')
    return direct
  }
  const out = {}
  for (const line of String(input ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`无法解析 "${line}"：应为 KEY=VALUE 每行一条`)
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

function normalizeEntry(input, existing) {
  const errors = {}
  const serverName = String(input.serverName ?? '').trim()
  if (!SERVER_NAME_RE.test(serverName)) {
    errors.serverName = 'serverName 只允许字母、数字、下划线、连字符，长度 1-32（与 dsh-mcp-client 约束一致）'
  }
  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const entry = {
    id: String(input.id ?? '').trim() || `mcp-${serverName}`.toLowerCase(),
    serverName,
    transport,
    disabled: input.disabled === true,
  }
  if (!ROW_ID_RE.test(entry.id)) errors.id = '行 id 需匹配 ^[a-z0-9][a-z0-9_-]{0,63}$'
  if (transport === 'stdio') {
    entry.command = String(input.command ?? '').trim()
    if (entry.command === '') errors.command = 'stdio 传输必须填写 command'
    const argsText = Array.isArray(input.args) ? input.args.join('\n') : String(input.args ?? '')
    entry.args = argsText.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
    try {
      entry.env = parseKV(input.env)
    } catch (error) {
      errors.env = error.message
    }
    entry.cwd = String(input.cwd ?? '').trim()
  } else {
    entry.url = String(input.url ?? '').trim()
    if (!URL_RE.test(entry.url)) errors.url = 'streamable-http 传输必须填写 http(s):// 开头的 url'
    try {
      entry.headers = parseKV(input.headers)
    } catch (error) {
      errors.headers = error.message
    }
  }
  if (input.toolCallTimeoutMs !== undefined && input.toolCallTimeoutMs !== null && input.toolCallTimeoutMs !== '') {
    const timeout = Number(input.toolCallTimeoutMs)
    if (!Number.isInteger(timeout) || timeout <= 0) errors.toolCallTimeoutMs = '超时须为正整数（毫秒）'
    else entry.toolCallTimeoutMs = timeout
  }
  entry.failOnStartupError = input.failOnStartupError === true
  entry.reconnect = input.reconnect === false ? false : true

  if (Object.keys(errors).length > 0) {
    const error = new Error('表单校验未通过')
    error.details = errors
    throw error
  }
  const clash = existing.find((e) => e.serverName === serverName && e.id !== input.__keepId)
  if (clash) {
    const error = new Error(`serverName "${serverName}" 已被行 "${clash.id}" 占用（同一注册范围内必须唯一）`)
    error.details = { serverName: error.message }
    throw error
  }
  const idTaken = existing.some((e) => e.id === entry.id && e.id !== input.__keepId)
  if (idTaken) {
    const error = new Error(`patch 行 id "${entry.id}" 已存在，请换一个或先删除旧行`)
    error.details = { id: error.message }
    throw error
  }
  return entry
}

function summarize(entry) {
  if (entry.transport === 'stdio') {
    return [entry.command, ...(entry.args ?? [])].join(' ')
  }
  return entry.url ?? ''
}

function invalidError(error) {
  if (error instanceof RemoteError) return error
  const remote = new RemoteError('mcp-ui/invalid', error?.message ?? String(error), error?.details ?? {})
  return remote
}

// ---- patch 文件读写 --------------------------------------------------------

function resolvePatchPath(ctx, config) {
  if (typeof config?.patchPath === 'string' && config.patchPath !== '') {
    return path.isAbsolute(config.patchPath) ? config.patchPath : path.resolve(process.cwd(), config.patchPath)
  }
  const anchored = profileDirFromContext(ctx)
  if (anchored !== '') return path.join(anchored, PROFILE_PATCH_FILENAME)
  const here = fileURLToPath(import.meta.url)
  // 回退：仅当本包物理位于 <profileDir>/node_modules/<pkg>/ 下时才按安装位置
  // 推导；link:/junction 开发安装的 realpath 在仓库里，这里一定推不出来，
  // 所以上面的运行时锚点才是主路径。
  const pkgDir = path.dirname(here)
  const nodeModulesDir = path.dirname(pkgDir)
  const profileDir = path.dirname(nodeModulesDir)
  if (
    path.basename(pkgDir) === 'dsh-plugin-mcp-ui' &&
    path.basename(nodeModulesDir) === 'node_modules' &&
    existsSync(path.join(profileDir, 'node_modules')) // pnpm .pnpm 内层 node_modules 也在此被排除
  ) {
    return path.join(profileDir, PROFILE_PATCH_FILENAME)
  }
  throw new Error(
    'tofu-mcp-ui: 无法定位 profile 的 cordis.patch.yml：既没有从 ctx.baseUrl 拿到 ' +
    'profile 目录（宿主未给出 include 锚点），也不是 node_modules 常规安装（开发安装/link 场景）。' +
    '请在 patch 行上用覆盖行配置 config.patchPath，例如 ' +
    "{ id: 'mcp-ui', name: 'dsh-plugin-mcp-ui', config: { patchPath: 'C:/Users/you/.dsh/profiles/web/cordis.patch.yml' } }",
  )
}

// 只有真正的 profile 目录才认：cordis.yml 存在 + manifest 带 dsh.profile。
// 既校验锚点合法，也防止锚点意外退化成别处时把 MCP 行写进错误的文件。
function isProfileDir(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  if (!existsSync(path.join(dir, PROFILE_ROOT_FILENAME))) return false
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return Boolean(manifest && typeof manifest === 'object' && manifest.dsh?.profile)
  } catch {
    return false
  }
}

// dsh 把「bundle 层 + profile 的 cordis.patch.yml + home 层 + --patch 覆盖层」
// 全部当作同一个 include（<profileDir>/cordis.yml）的 patch 传入，于是每个顶层
// 条目的 ctx.baseUrl 就是 profile 目录的 file URL；插件 ctx 继承同一个 baseUrl。
// 这是 link: 开发安装下唯一可靠的锚点（安装位置推导会指向仓库）。
function profileDirFromContext(ctx) {
  const baseUrl = ctx?.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return ''
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'file:') return ''
    const dir = fileURLToPath(url)
    return isProfileDir(dir) ? dir : ''
  } catch {
    return ''
  }
}

function readState(patchPath) {
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const { head, managed, tail } = splitFile(text)
  return { head, entries: managed, tail, external: scanExternal(text, new Set(managed.map((e) => e.id))) }
}

// 内容未变则不写盘（避免 patchReload: live 下的空转热重载）。
function writeEntries(patchPath, state, entries) {
  const next = joinFile({ head: state.head, entries, tail: state.tail })
  const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (next === current) return false
  const tmp = `${patchPath}.mcp-ui.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, patchPath)
  return true
}

// ---- Remote 服务 ------------------------------------------------------------
// 浏览器经官方 typert 网关调用 `/api/mcpUi/<method>`（api-gateway 的 SRC
// marker 发现路径），认证、路由、错误编码全部复用官方设施；本插件不再
// 自建通道。方法返回值必须是 JSON-safe 普通对象；失败抛 RemoteError。
// 注意：网关按函数源码解析参数名，签名必须是唯一标识符、无解构/默认值/rest，
// 且避免与 typert lookup 参数（如 id）重名。

class McpUiService extends TypertRemoteService {
  constructor(ctx, patchPath) {
    super(ctx, 'mcpUi')
    this.__patchPath = patchPath
  }

  list() {
    const state = readState(this.__patchPath)
    return {
      path: this.__patchPath,
      exists: existsSync(this.__patchPath),
      entries: state.entries.map((e) => ({ ...e, summary: summarize(e) })),
      external: state.external,
    }
  }

  save(entry, originalId) {
    try {
      const state = readState(this.__patchPath)
      const keepId = typeof originalId === 'string' ? originalId : ''
      if (keepId !== '' && !state.entries.some((e) => e.id === keepId)) {
        throw new Error(`要编辑的行 "${keepId}" 已不存在，请刷新列表`)
      }
      const rest = state.entries.filter((e) => e.id !== (keepId || entry?.id))
      const normalized = normalizeEntry({ ...entry, __keepId: keepId }, state.entries)
      const index = keepId === '' ? rest.length : state.entries.findIndex((e) => e.id === keepId)
      const merged = [...rest]
      merged.splice(Math.max(0, Math.min(index, merged.length)), 0, normalized)
      const changed = writeEntries(this.__patchPath, state, merged)
      return { changed, entry: { ...normalized, summary: summarize(normalized) } }
    } catch (error) {
      throw invalidError(error)
    }
  }

  remove(serverId) {
    try {
      const state = readState(this.__patchPath)
      const id = String(serverId ?? '')
      if (!state.entries.some((e) => e.id === id)) throw new Error(`行 "${id}" 不存在，请刷新列表`)
      const changed = writeEntries(this.__patchPath, state, state.entries.filter((e) => e.id !== id))
      return { changed }
    } catch (error) {
      throw invalidError(error)
    }
  }

  toggle(serverId, enabled) {
    try {
      const state = readState(this.__patchPath)
      const id = String(serverId ?? '')
      const index = state.entries.findIndex((e) => e.id === id)
      if (index === -1) throw new Error(`行 "${id}" 不存在，请刷新列表`)
      const entries = [...state.entries]
      entries[index] = { ...entries[index], disabled: enabled === false }
      const changed = writeEntries(this.__patchPath, state, entries)
      return { changed, entry: entries[index] }
    } catch (error) {
      throw invalidError(error)
    }
  }
}

// 等价于对四个方法各写一个 @Remote()：在原型上登记 version-1 方法标记。
Object.defineProperty(McpUiService.prototype, REMOTE_METHODS_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(
      ['list', 'save', 'remove', 'toggle'].map((method) =>
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })),
    ),
  }),
})

function apply(ctx, config) {
  const patchPath = resolvePatchPath(ctx, config)
  new McpUiService(ctx, patchPath)
  ctx.logger.info(`tofu-mcp-ui: managing MCP servers in ${patchPath}`)
}

export { apply }
