import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CodexLoginController, CodexLoginError } from './core.js'

export const name = 'dsh-plugin-codex-login'
export const inject = ['authorization', 'credentials']
export const Config = z.object({
  timeoutSeconds: z.number().min(60).max(3600).step(1).default(600),
})

// credentialKey('llm-pi-ai', 'openai-codex') encodes this stable scoped address.
// A linked JS plugin need not load a second copy of the credential package.
const KEY = 'llm-pi-ai/openai-codex'

function remoteFailure(error) {
  if (error instanceof CodexLoginError) return new RemoteError(`codex-login/${error.code}`, error.message)
  return new RemoteError('codex-login/unavailable', 'Codex 登录操作失败，请稍后重试。')
}

/** Remote methods expose notices and questions, never the pi-ai grant. */
export class CodexLoginRemote extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, 'codexLogin')
    this.controller = controller
  }

  start() {
    try { return this.controller.start() } catch (error) { throw remoteFailure(error) }
  }

  async status(ticket) {
    try { return await this.controller.status(ticket) } catch (error) { throw remoteFailure(error) }
  }

  answer(ticket, promptId, value) {
    try { return this.controller.answer(ticket, promptId, value) } catch (error) { throw remoteFailure(error) }
  }

  cancel(ticket) {
    try { return this.controller.cancel(ticket) } catch (error) { throw remoteFailure(error) }
  }

  async logout() {
    try { return await this.controller.logout() } catch (error) { throw remoteFailure(error) }
  }
}

// SRC Remote discovery for plugins distributed outside the DSH build graph.
Object.defineProperty(CodexLoginRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: Object.freeze({ version: 1, methods: Object.freeze(['start', 'status', 'answer', 'cancel', 'logout'].map(method =>
    Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))) }),
})

export function apply(ctx, config) {
  const controller = new CodexLoginController({
    authorization: ctx.authorization, credentials: ctx.credentials, key: KEY,
    timeoutMs: config.timeoutSeconds * 1000, logger: ctx.logger,
  })
  new CodexLoginRemote(ctx, controller)
  ctx.effect(() => () => controller.dispose(), 'codex-login: settle OAuth attempt')
}
