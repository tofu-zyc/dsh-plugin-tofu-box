/**
 * Host half of `dsh-plugin-model-tuning` (v2: merged with the former
 * `dsh-plugin-title-model` and `dsh-plugin-image-generation`).
 *
 * Three responsibilities, one entry:
 *
 * 1. Session-title routing (ex dsh-plugin-title-model). This plugin REPLACES
 *    the deployment's shipped title provider row
 *    (`@deepseek-ai/dsh-session-title-first-prompt-llm`) through the bundle
 *    patch in `cordis.patch.yml`. It is still exactly one provider:
 *    `ctx.sessionTitle.register()` throws on a second registration, so a
 *    competing generator cannot coexist. Everything except the route is
 *    delegated to the public shared policy `generateSessionTitleWithLlm` from
 *    `@deepseek-ai/dsh-session-title-llm`, resolved from the RUNNING
 *    deployment (see hostRequire) — never from this package's directory, which
 *    for a linked workspace package would risk a second copy of the host's
 *    shared module graph.
 *
 * 2. Image generation (ex dsh-plugin-image-generation): the `generate_image`
 *    and `list_image_models` tools plus the `imageGeneration` Remote service
 *    that the 直接绘图 panel drives. Transport lives in `./core.js`.
 *
 * 3. Nothing else: the settings surface (模型参数 / 用途 / 绘图 tabs) lives in
 *    the browser implementation exported from `./client`.
 *
 * @module dsh-plugin-model-tuning
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { discoverImageModels, generateImages, resolveRequest, validateConfig } from './core.js'

export const name = 'dsh-plugin-model-tuning'

/** Services this plugin reads. */
export const inject = ['tools', 'attachments', 'sessionTitle', 'llm']

/** Settings namespace owned by this plugin (one entry, one schema). */
export const NS = 'model-tuning'

/**
 * Provider identity recorded with generated titles. Kept equal to the row this
 * plugin replaces so durable logs and the folded title source stay unchanged.
 */
const TITLE_PROVIDER_ID = 'session-title-llm'

/**
 * Unified Config: image-generation fields (models / defaultModel) plus the
 * title route fields (titleMode / titleProvider / titleModel), all volatile.
 *
 * The title budget fields mirror the `session-title-llm` config in
 * `@deepseek-ai/dsh-base` so that removing this bundle's `config:` block
 * cannot change title behaviour. Title fields are prefixed `title` so the
 * pre-merge `title-model` section could be migrated mechanically; the former
 * `image-generation` section's `models`/`defaultModel` keys are kept verbatim.
 */
const imageModelSchema = z.object({
  id: z.string().required(), name: z.string(), model: z.string().required(),
  api: z.union(['openai-images']).default('openai-images'),
  endpoint: z.string().default('https://api.openai.com/v1/images/generations'), apiKeyEnv: z.string().role('credential-ref'),
  modelsEndpoint: z.string(),
  // Retained so sections written by earlier versions still parse. Results
  // returned as URLs are downloaded from whatever host the gateway names; the
  // scheme and redirect checks in core.js are what bound that fetch now.
  downloadOrigins: z.array(z.string()).default([]),
  timeoutSeconds: z.number().step(1).min(10).max(600).default(300),
  size: z.string(), quality: z.string(), background: z.string(),
  output_format: z.string(), response_format: z.string(), style: z.string(),
})

export const Config = z.object({
  // ── 绘图（ex image-generation；键名原样保留，旧数据可直接搬入） ──
  models: z.array(imageModelSchema).default([]).volatile(),
  defaultModel: z.string().volatile(),
  // ── 标题生成（ex title-model；title 前缀迁移自 mode/provider/model） ──
  titleMode: z.union([z.const('inherit'), z.const('custom')]).default('inherit').volatile(),
  titleProvider: z.string().volatile(),
  titleModel: z.string().volatile(),
  // ── 标题请求预算（用户可在「用途」页改；默认值与 dsh-base 的 session-title-llm 行一致） ──
  targetWords: z.number().step(1).min(1).default(5).volatile(),
  targetCjkCharacters: z.number().step(1).min(1).default(10).volatile(),
  maxInputBytes: z.number().step(1).min(1).default(4096).volatile(),
  maxOutputTokens: z.number().step(1).min(1).default(64).volatile(),
  timeoutMs: z.number().step(1).min(1).default(60000).volatile(),
})

/** Reject a custom title mode that cannot name both halves of a route. */
export function validateTitleModel(value) {
  const provider = value?.titleProvider
  const model = value?.titleModel
  const hasProvider = provider !== undefined && provider !== null && provider !== ''
  const hasModel = model !== undefined && model !== null && model !== ''
  if (hasProvider !== hasModel) throw new Error('model-tuning: titleProvider 与 titleModel 必须同时填写或同时留空')
  if (value?.titleMode === 'custom' && !hasProvider) throw new Error('model-tuning: titleMode 为 custom 时必须同时选择 provider 与 model')
}

/**
 * Resolve the exact route recorded for one generation request.
 * @param settings - resolved title fields (`titleMode`/`titleProvider`/`titleModel`).
 * @param request - service-owned request carrying the session's logged route.
 * @returns the provider/model pair to dispatch.
 */
export function resolveTitleRoute(settings, request) {
  validateTitleModel(settings)
  if (settings?.titleMode === 'custom') {
    return { provider: settings.titleProvider, model: settings.titleModel }
  }
  if (request?.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return { provider: request.route.provider, model: request.route.model }
}

/** The shared title policy module, loaded once per process. */
const HELPER_PACKAGE = '@deepseek-ai/dsh-session-title-llm'

/**
 * Resolve the shared title policy.
 *
 * A plain `import '@deepseek-ai/dsh-session-title-llm'` would have to be
 * resolvable from THIS package's directory, which for a linked workspace package
 * means risking another installation of the host's shared module graph. The
 * helper therefore resolves from the deployment that loads this plugin.
 */
function hostRequire() {
  const anchors = [process.argv[1], process.execPath, import.meta.url]
  for (const anchor of anchors) {
    if (anchor === undefined) continue
    try {
      const require = createRequire(anchor)
      require.resolve(HELPER_PACKAGE)
      return require
    } catch {
      // Try the next anchor: a test or tool process may not sit inside the deployment.
    }
  }
  return undefined
}

let helperPromise
function loadTitleHelper() {
  helperPromise ??= (async () => {
    const require = hostRequire()
    if (require === undefined) {
      throw new Error(
        `model-tuning: 无法从宿主解析 ${HELPER_PACKAGE}；本插件必须与提供该包的部署一起运行。`,
      )
    }
    const loaded = await import(pathToFileURL(require.resolve(HELPER_PACKAGE)).href)
    const generate = loaded.generateSessionTitleWithLlm
    if (typeof generate !== 'function') {
      throw new Error(`model-tuning: ${HELPER_PACKAGE} 未导出 generateSessionTitleWithLlm`)
    }
    return generate
  })()
  return helperPromise
}

/**
 * Read the live title budget.
 *
 * Every field is user-editable from the 用途 tab, so each generation re-reads
 * them instead of freezing the apply-time values. A reasoning model that only
 * starts answering after a long think needs a larger `maxOutputTokens` here;
 * that is the user's call, not a constant in this file.
 * @param config - the plugin's live Config.
 * @returns the prompt/byte/token/timeout policy for one title request.
 */
export function titleBudgetOf(config) {
  const policy = {
    targetWords: config.targetWords.get(),
    targetCjkCharacters: config.targetCjkCharacters.get(),
    maxInputBytes: config.maxInputBytes.get(),
    maxOutputTokens: config.maxOutputTokens.get(),
    timeoutMs: config.timeoutMs.get(),
  }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`model-tuning: ${key} 必须是正整数`)
  }
  return policy
}

/**
 * Register the settings-owned title provider.
 * @param ctx - context exposing session-title and LLM services.
 * @param config - the live Config (route and budget are re-read per generation).
 */
export async function registerTitleProvider(ctx, config) {
  const generateSessionTitleWithLlm = await loadTitleHelper()
  validateTitleModel({ titleMode: config.titleMode.get(), titleProvider: config.titleProvider.get(), titleModel: config.titleModel.get() })
  titleBudgetOf(config)
  ctx.sessionTitle.register({
    id: TITLE_PROVIDER_ID,
    automatic: 'first-prompt',
    async generate(request) {
      const route = resolveTitleRoute({
        titleMode: config.titleMode.get(), titleProvider: config.titleProvider.get(), titleModel: config.titleModel.get(),
      }, request)
      const selected = request.messages.slice(0, 1)
      return await generateSessionTitleWithLlm(ctx, titleBudgetOf(config), { ...request, route }, selected, TITLE_PROVIDER_ID)
    },
  })
}

// ── 绘图：工具 + Remote 服务（ex dsh-plugin-image-generation/index.js） ──

const IMAGE_PARAMETERS = {
  model: { type: 'string', description: 'Configuration ID from list_image_models, not the upstream model ID. Omit to use the configured default.' },
  prompt: { type: 'string', required: true, description: 'Full self-contained description of the image to generate. Chat history is not sent.' },
  n: { type: 'integer', description: 'Number of images, 1–4. Defaults to 1; the upstream model may support only 1.' },
  size: { type: 'string', description: 'Optional model-supported size, e.g. 1024x1024.' },
  quality: { type: 'string', description: 'Optional quality supported by this model.' },
}

export function resultText(value) {
  return `Generated ${value.images.length} image(s) with ${value.model}. Original files are retained without resizing.\n`
    + value.images.map((image, i) => `${i + 1}. ${image.path ?? `attachment:${image.original.attachmentId}`} (${image.original.bytes} bytes)`
      + (image.revisedPrompt ? `\nRevised prompt: ${image.revisedPrompt}` : '')).join('\n')
    + (value.includeImages ? '' : '\nImages were not added to model context because the selected model does not declare image input. Do not claim to have inspected their contents.')
}

/** Jobs are bounded, process-local tickets. Attachment bytes themselves are durable. */
export class ImageGenerationService extends TypertRemoteService {
  constructor(ctx, current) {
    super(ctx, 'imageGeneration')
    this.current = current
    this.jobs = new Map()
    this.lifetime = new AbortController()
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('绘图插件已卸载。'))
      this.jobs.clear()
    })
  }

  async run(args, signal) {
    return generateImages({
      config: this.current(), args, attachments: this.ctx.attachments,
      signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
      resolveKey: async ref => {
        const credentials = this.ctx.get('credentials')
        return credentials ? (await credentials.resolve(ref))?.value : process.env[ref]
      },
    })
  }

  async discover(request) {
    try {
      return await discoverImageModels({ request, signal: this.lifetime.signal,
        resolveKey: async ref => {
          const credentials = this.ctx.get('credentials')
          return credentials ? (await credentials.resolve(ref))?.value : process.env[ref]
        },
      })
    } catch (error) { throw new RemoteError('image-generation/discovery', error.message) }
  }

  start(request) {
    try { resolveRequest(this.current(), request) } catch (error) { throw new RemoteError('image-generation/invalid', error.message) }
    // Retain completed tickets for one hour, and cap memory even if a tab disappears.
    for (const [id, job] of this.jobs) if (job.status !== 'running' && Date.now() - job.created > 3600000) this.jobs.delete(id)
    if ([...this.jobs.values()].filter(job => job.status === 'running').length >= 2) throw new RemoteError('image-generation/busy', '已有两个绘图任务正在运行。')
    if (this.jobs.size >= 32) {
      const oldest = [...this.jobs].find(([, job]) => job.status !== 'running')
      if (oldest) this.jobs.delete(oldest[0])
    }
    const id = randomUUID()
    const controller = new AbortController()
    const job = { status: 'running', created: Date.now(), controller }
    this.jobs.set(id, job)
    void this.run(request, controller.signal).then(result => {
      job.result = result
      job.status = 'done'
    }, error => {
      job.error = controller.signal.aborted ? '已停止等待；服务端可能仍在生成。' : error.message
      job.status = 'error'
    })
    return { jobId: id }
  }

  status(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) throw new RemoteError('image-generation/missing', '绘图任务已过期或宿主已重启。')
    return { status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) }
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) throw new RemoteError('image-generation/missing', '绘图任务不存在。')
    if (job.status === 'running') job.controller.abort(new Error('绘图已取消。'))
    return { cancelled: job.status === 'running' }
  }

  async image(jobId, imageIndex, original) {
    const image = this.jobs.get(jobId)?.result?.images[imageIndex]
    if (!Number.isInteger(imageIndex) || !image) throw new RemoteError('image-generation/missing', '图片不存在。')
    if (original === true) {
      const chunks = []
      for await (const chunk of this.ctx.attachments.readFileStream(image.original, this.lifetime.signal)) chunks.push(chunk)
      return { data: Buffer.concat(chunks).toString('base64'), mediaType: image.mediaType, name: image.original.name }
    }
    const stored = await this.ctx.attachments.readImage(image.preview)
    return { data: Buffer.from(stored.data).toString('base64'), mediaType: stored.ref.mediaType, name: image.preview.name ?? 'preview.png' }
  }
}

Object.defineProperty(ImageGenerationService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: Object.freeze({ version: 1, methods: Object.freeze(['start', 'status', 'cancel', 'image', 'discover'].map(method =>
    Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))) }),
})

export function registerImageTools(ctx, config) {
  const current = () => {
    const value = { models: config.models.get(), defaultModel: config.defaultModel.get() }
    validateConfig(value)
    return value
  }
  current()
  const service = new ImageGenerationService(ctx, current)
  const register = definition => ctx.effect(() => ctx.tools.register(defineTool(definition)), `image-generation: ${definition.name}`)
  register({
    name: 'list_image_models',
    description: 'List configured image-generation models and their supported protocol/default parameters. These models are separate from chat models.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute() {
      const value = current()
      return { defaultModel: value.defaultModel ?? '', models: value.models.map(({ id, name, model, api, size, quality }) =>
        ({ id, name: name || id, model, api, ...(size ? { size } : {}), ...(quality ? { quality } : {}) })) }
    },
  })
  register({
    name: 'generate_image',
    description: 'Generate images with a separately configured Images API. Call list_image_models first if needed. This sends the prompt to the image provider and may incur charges. Results include original file paths and previews when the current chat model supports images. No automatic retries; a timeout may still have generated an image remotely. This tool generates new images only; it cannot edit or read reference images.',
    parameters: IMAGE_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: resultText(value) },
        ...(value.includeImages ? value.images.map(image => ({ type: 'image', attachment: image.preview })) : [])],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 610000,
    async execute(args, exec) {
      // Check capability before the paid request; never append images a text-only
      // route would reject on the next agent step.
      const selection = exec.agent?.session?.requestHeader()?.config
      const llm = ctx.get('llm')
      const info = selection && llm ? await llm.resolveModelInfo(selection.provider, selection.model, exec.signal) : undefined
      const includeImages = info?.inputModalities?.includes('image') === true
      return { ...await service.run(args, exec.signal), includeImages }
    },
  })
}

/**
 * Register everything: title provider, image tools, and the Remote service.
 * @param ctx - context exposing tools, attachments, sessionTitle and llm.
 * @param config - the unified Config described above.
 */
export async function apply(ctx, config) {
  await registerTitleProvider(ctx, config)
  registerImageTools(ctx, config)
}
