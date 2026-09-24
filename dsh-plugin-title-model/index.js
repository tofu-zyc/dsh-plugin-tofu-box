/**
 * Host half of `dsh-plugin-title-model`.
 *
 * This plugin REPLACES the deployment's shipped title provider row
 * (`@deepseek-ai/dsh-session-title-first-prompt-llm`) through the bundle patch in
 * `cordis.patch.yml`. It is still exactly one provider: `ctx.sessionTitle.register()`
 * throws on a second registration, so a competing generator cannot coexist.
 *
 * Everything except the route is delegated to the public shared policy
 * `generateSessionTitleWithLlm` from `@deepseek-ai/dsh-session-title-llm`:
 * message framing, `maxInputBytes`, the `session/title-llm-request` log record,
 * the composed timeout, caller cancellation, output assembly and validation all
 * stay byte-identical to the shipped behaviour. Only `provider`/`model` are chosen
 * here, from the `title-model` profile entry's volatile route fields, so the
 * model recorded on the produced title is the model actually dispatched.
 *
 * The shipped helper (and therefore this plugin) does not forward
 * `reasoningEffort`: title generation inherits the host's own purpose policy.
 * For the DeepSeek adapter that policy is "thinking disabled for session-title"
 * by design; other adapters own their purpose-specific behaviour.
 *
 * @module dsh-plugin-title-model
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'

/** Loader row id / plugin name. */
export const name = 'dsh-plugin-title-model'

/** Services this plugin reads. */
export const inject = ['sessionTitle', 'llm']

/** Settings namespace owned by this plugin; the UI lives on the 模型调参 page. */
export const NS = 'title-model'

/**
 * Provider identity recorded with generated titles. Kept equal to the row this
 * plugin replaces so durable logs and the folded title source stay unchanged.
 */
const TITLE_PROVIDER_ID = 'session-title-llm'

/**
 * Route and budget policy.
 *
 * The budget fields mirror the `session-title-llm` config in `@deepseek-ai/dsh-base`
 * so that removing this bundle's `config:` block cannot change title behaviour.
 * `mode`/`provider`/`model` are volatile references read for each generation;
 * the budget fields are fixed by this plugin's entry configuration.
 */
export const Config = z.object({
  targetWords: z.number().step(1).min(1).default(5),
  targetCjkCharacters: z.number().step(1).min(1).default(10),
  maxInputBytes: z.number().step(1).min(1).default(4096),
  maxOutputTokens: z.number().step(1).min(1).default(64),
  timeoutMs: z.number().step(1).min(1).default(60000),
  mode: z.union([z.const('inherit'), z.const('custom')]).default('inherit').volatile(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
})

/** Reject a custom mode that cannot name both halves of a route. */
export function validateTitleModel(value) {
  const provider = value?.provider
  const model = value?.model
  const hasProvider = provider !== undefined && provider !== null && provider !== ''
  const hasModel = model !== undefined && model !== null && model !== ''
  if (hasProvider !== hasModel) throw new Error('title-model: provider 与 model 必须同时填写或同时留空')
  if (value?.mode === 'custom' && !hasProvider) throw new Error('title-model: mode 为 custom 时必须同时选择 provider 与 model')
}

/**
 * Resolve the exact route recorded for one generation request.
 * @param settings - resolved `title-model` section.
 * @param request - service-owned request carrying the session's logged route.
 * @returns the provider/model pair to dispatch.
 */
export function resolveTitleRoute(settings, request) {
  validateTitleModel(settings)
  if (settings?.mode === 'custom') {
    return { provider: settings.provider, model: settings.model }
  }
  if (request?.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return { provider: request.route.provider, model: request.route.model }
}

/** The shared policy module, loaded once per process. */
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
        `title-model: 无法从宿主解析 ${HELPER_PACKAGE}；本插件必须与提供该包的部署一起运行。`,
      )
    }
    const loaded = await import(pathToFileURL(require.resolve(HELPER_PACKAGE)).href)
    const generate = loaded.generateSessionTitleWithLlm
    if (typeof generate !== 'function') {
      throw new Error(`title-model: ${HELPER_PACKAGE} 未导出 generateSessionTitleWithLlm`)
    }
    return generate
  })()
  return helperPromise
}

/**
 * Register the settings-owned title provider.
 * @param ctx - context exposing session-title and LLM services.
 * @param config - required prompt, byte, token, and timeout policy.
 */
export async function apply(ctx, config) {
  const generateSessionTitleWithLlm = await loadTitleHelper()
  const policy = {
    targetWords: config.targetWords,
    targetCjkCharacters: config.targetCjkCharacters,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
  }
  validateTitleModel({ mode: config.mode.get(), provider: config.provider.get(), model: config.model.get() })
  ctx.sessionTitle.register({
    id: TITLE_PROVIDER_ID,
    automatic: 'first-prompt',
    async generate(request) {
      const route = resolveTitleRoute({
        mode: config.mode.get(), provider: config.provider.get(), model: config.model.get(),
      }, request)
      const selected = request.messages.slice(0, 1)
      return await generateSessionTitleWithLlm(ctx, policy, { ...request, route }, selected, TITLE_PROVIDER_ID)
    },
  })
}
