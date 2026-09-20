import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { discoverImageModels, generateImages, resolveRequest, validateConfig } from './core.js'

export const name = 'dsh-plugin-image-generation'
export const inject = ['tools', 'attachments', 'settings']
export const NS = 'image-generation'
const modelSchema = z.object({
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
export const Config = z.object({ models: z.array(modelSchema).default([]), defaultModel: z.string() })

const PARAMETERS = {
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

export function apply(ctx, config) {
  const scope = ctx.settings.register(NS, Config, { base: config, validate: validateConfig })
  const service = new ImageGenerationService(ctx, () => scope.get())
  const register = definition => ctx.effect(() => ctx.tools.register(defineTool(definition)), `image-generation: ${definition.name}`)
  register({
    name: 'list_image_models',
    description: 'List configured image-generation models and their supported protocol/default parameters. These models are separate from chat models.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute() {
      const config = scope.get()
      return { defaultModel: config.defaultModel ?? '', models: config.models.map(({ id, name, model, api, size, quality }) =>
        ({ id, name: name || id, model, api, ...(size ? { size } : {}), ...(quality ? { quality } : {}) })) }
    },
  })
  register({
    name: 'generate_image',
    description: 'Generate images with a separately configured Images API. Call list_image_models first if needed. This sends the prompt to the image provider and may incur charges. Results include original file paths and previews when the current chat model supports images. No automatic retries; a timeout may still have generated an image remotely. This tool generates new images only; it cannot edit or read reference images.',
    parameters: PARAMETERS,
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
