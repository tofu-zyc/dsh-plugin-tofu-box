/** Images API transport. No credentials or remote response bodies enter errors. */
export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 112 * 1024 * 1024
const PARAMS = ['size', 'quality', 'background', 'output_format', 'response_format', 'style']

function fail(message) { throw new Error(message) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function httpUrl(value, label) {
  let url
  try { url = new URL(value) } catch { fail(`${label} 必须是完整的 HTTP(S) 地址。`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    fail(`${label} 不得包含凭据、查询参数或片段，且必须使用 HTTP(S)。`)
  }
  return url
}

/** Preserve custom prefixes; accept either an API base or a full Images endpoint. */
export function discoveryUrl(endpoint, modelsEndpoint) {
  const generation = httpUrl(endpoint, '供应商地址')
  if (modelsEndpoint) {
    const listing = httpUrl(modelsEndpoint, '模型列表接口')
    if (listing.origin !== generation.origin) fail('模型列表接口必须与生成接口同源，避免向其他供应商发送凭据。')
    return listing.href
  }
  generation.pathname = generation.pathname.replace(/\/+$/, '').replace(/\/images\/generations$/, '') + '/models'
  return generation.href
}

/** Read a supplier's catalog without saving a draft model or its typed secret. */
export async function discoverImageModels({ request, resolveKey, signal, fetchImpl = fetch }) {
  if (!object(request) || typeof request.endpoint !== 'string') fail('请先填写供应商地址。')
  if (request.modelsEndpoint !== undefined && typeof request.modelsEndpoint !== 'string') fail('模型列表接口必须是地址。')
  if (request.apiKeyEnv && (typeof request.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.apiKeyEnv))) fail('凭据引用必须是有效的环境变量名。')
  if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 16384 || /[\r\n]/.test(request.apiKey))) fail('API Key 格式无效。')
  const url = discoveryUrl(request.endpoint, request.modelsEndpoint)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('获取模型列表超时，请检查服务地址或手动填写模型 ID。')), 20000)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    combined.throwIfAborted()
    const key = request.apiKey || (request.apiKeyEnv ? await resolveKey(request.apiKeyEnv) : undefined)
    if (request.apiKeyEnv && !key) fail(`未找到可用凭据 ${request.apiKeyEnv}。请填写 API Key 或选择已有凭据引用。`)
    if (key && (typeof key !== 'string' || /[\r\n]/.test(key))) fail('API Key 格式无效。')
    const response = await checkedFetch(fetchImpl, url, {
      method: 'GET', redirect: 'error', signal: combined,
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    })
    let payload
    const raw = await readBounded(response, 2 * 1024 * 1024, combined)
    try { payload = JSON.parse(raw.toString('utf8')) } catch { fail('模型列表接口未返回有效 JSON，可在高级设置中指定列表地址或手动填写模型 ID。') }
    if (!Array.isArray(payload?.data)) fail('模型列表应包含 data 数组；当前供应商可能不支持该接口，请手动填写模型 ID。')
    if (payload.data.length > 10000) fail('供应商返回的模型列表过大。')
    const models = new Map()
    for (const item of payload.data) {
      if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256) continue
      if (!models.has(item.id)) models.set(item.id, { id: item.id,
        name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 256) : item.id })
    }
    if (payload.data.length && !models.size) fail('供应商列表没有有效的模型 ID。')
    return { models: [...models.values()], truncated: payload.has_more === true }
  } finally { clearTimeout(timer) }
}

/** Validate cross-field settings both at registration and before a paid call. */
export function validateConfig(config) {
  const ids = new Set()
  for (const entry of config.models ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id)) fail('绘图配置 ID 只能包含字母、数字、下划线和连字符。')
    if (ids.has(entry.id)) fail(`绘图配置 ID 重复：${entry.id}`)
    ids.add(entry.id)
    if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 256) fail('必须填写绘图模型 ID（最长 256 字符）。')
    if (entry.api !== 'openai-images') fail('当前只支持 openai-images 协议。')
    httpUrl(entry.endpoint, '生成接口')
    if (entry.modelsEndpoint) discoveryUrl(entry.endpoint, entry.modelsEndpoint)
    if (entry.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv)) fail('凭据引用必须是有效的环境变量名。')
    if (!Number.isInteger(entry.timeoutSeconds) || entry.timeoutSeconds < 10 || entry.timeoutSeconds > 600) fail('超时必须在 10–600 秒之间。')
    for (const field of PARAMS) {
      if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field].length > 128)) fail(`无效的 ${field}。`)
    }
  }
  if (config.defaultModel && !ids.has(config.defaultModel)) fail('默认绘图配置不存在。')
}

export function resolveRequest(config, args) {
  validateConfig(config)
  if (!object(args)) fail('绘图参数必须是对象。')
  const id = args.model ?? config.defaultModel ?? ''
  const entries = config.models ?? []
  const entry = entries.find(item => item.id === id) ?? (!id && entries.length === 1 ? entries[0] : undefined)
  if (!entry) fail('请先在「设置 → 绘图」添加模型并选择默认项，或用 list_image_models 查看可选 ID。')
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000) fail('提示词不能为空，且不能超过 32000 字符。')
  const n = args.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) fail(`每次只能生成 1–${MAX_IMAGES} 张图片。`)
  const body = { model: entry.model, prompt: args.prompt, n }
  for (const field of PARAMS) {
    const value = args[field] ?? entry[field]
    if (value !== undefined && value !== '') {
      if (typeof value !== 'string' || value.length > 128) fail(`无效的 ${field}。`)
      body[field] = value
    }
  }
  // Unspecified parameters remain absent; GPT Image does not accept response_format.
  return { entry, body }
}

async function readBounded(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    fail('接口返回内容超过大小限制。')
  }
  if (!response.body) fail('接口返回空内容。')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) fail('接口返回内容超过大小限制。')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {}) // Cleanup cannot replace the original transport error.
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

async function checkedFetch(fetchImpl, url, options) {
  let response
  try { response = await fetchImpl(url, options) } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    throw new Error('绘图服务连接失败，请检查地址与网络。', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    fail(`绘图服务返回 HTTP ${response.status}。请检查接口、凭据、模型权限和参数；未自动重试。`)
  }
  return response
}

/** Detect the bytes, rather than trusting response headers or a configured format. */
export function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif'
  fail('接口返回的内容不是支持的 PNG、JPEG、WebP 或 GIF 图片。')
}

async function imageBytes(item, entry, fetchImpl, signal) {
  if (typeof item.b64_json === 'string' && item.b64_json) {
    const encoded = item.b64_json
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('图片 Base64 无效或超过 20 MiB。')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) fail('图片 Base64 编码无效。')
    if (bytes.length > MAX_IMAGE_BYTES) fail('图片超过 20 MiB。')
    return bytes
  }
  if (typeof item.url !== 'string') fail('接口没有返回 b64_json 或图片 URL。')
  let url
  try { url = new URL(item.url) } catch { fail('接口返回无效图片 URL。') }
  // Any host is accepted: a gateway may host results on a CDN, and pinning an
  // origin list here only broke that. `redirect: 'error'` below still refuses a
  // response that tries to bounce the download somewhere else, and the scheme,
  // credential, and fragment checks keep the fetch to a plain public URL.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    fail('图片 URL 必须是公开的 HTTP(S) 地址。')
  }
  const response = await checkedFetch(fetchImpl, url, { signal, redirect: 'error' })
  return readBounded(response, MAX_IMAGE_BYTES, signal)
}

/** One POST only: transport retries can create and bill for duplicate images. */
export async function generateImages({ config, args, resolveKey, attachments, signal, fetchImpl = fetch }) {
  const { entry, body } = resolveRequest(config, args)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('绘图请求超时；服务端可能仍在生成，请勿立即重复提交。')), entry.timeoutSeconds * 1000)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    combined.throwIfAborted()
    const key = entry.apiKeyEnv ? await resolveKey(entry.apiKeyEnv) : undefined
    if (entry.apiKeyEnv && (!key || /[\r\n]/.test(key))) fail(`未找到可用凭据 ${entry.apiKeyEnv}。请在设置中保存 API Key。`)
    const response = await checkedFetch(fetchImpl, entry.endpoint, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    })
    const raw = await readBounded(response, MAX_RESPONSE_BYTES, combined)
    let payload
    try { payload = JSON.parse(raw.toString('utf8')) } catch { fail('绘图接口未返回有效 JSON；请确认使用的是 Images API。') }
    if (!Array.isArray(payload?.data) || payload.data.length === 0 || payload.data.length > body.n) fail('绘图响应没有图片，或返回数量超过请求数量。')
    const inputs = []
    for (const item of payload.data) {
      if (!object(item)) fail('绘图响应中存在无效的图片条目。')
      combined.throwIfAborted()
      const data = await imageBytes(item, entry, fetchImpl, combined)
      const mediaType = imageType(data)
      inputs.push({ data, mediaType, name: `generated-${inputs.length + 1}.${mediaType.split('/')[1]}` })
    }
    combined.throwIfAborted()
    // AttachmentStore validates the entire batch before writing any previews.
    const previews = await attachments.saveImages(inputs)
    const images = []
    for (let i = 0; i < inputs.length; i++) {
      combined.throwIfAborted()
      const original = await attachments.saveFile({ data: inputs[i].data, name: inputs[i].name })
      const path = attachments.fileHostPath(original)
      images.push({ preview: previews[i], original, mediaType: inputs[i].mediaType, ...(path ? { path } : {}),
        ...(typeof payload.data[i].revised_prompt === 'string' ? { revisedPrompt: payload.data[i].revised_prompt.slice(0, 32000) } : {}) })
    }
    return { model: entry.id, prompt: args.prompt, images }
  } finally { clearTimeout(timer) }
}
