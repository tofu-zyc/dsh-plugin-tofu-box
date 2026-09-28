import { randomUUID } from 'node:crypto'

/** A public, token-free failure reason for the browser login control. */
export class CodexLoginError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CodexLoginError'
    this.code = code
  }
}

const fail = (code, message) => new CodexLoginError(code, message)
const aborted = () => new DOMException('Login interaction cancelled', 'AbortError')
const short = (value, length) => typeof value === 'string' ? value.slice(0, length) : ''

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function noticeView(notice) {
  const view = { message: short(notice?.message, 1000) }
  const url = safeUrl(notice?.url)
  if (url) view.url = url
  if (typeof notice?.code === 'string') view.code = short(notice.code, 128)
  return view
}

function promptView(prompt, id) {
  const kind = ['text', 'secret', 'select'].includes(prompt?.kind) ? prompt.kind : 'text'
  const view = { id, kind, message: short(prompt?.message, 1000) }
  if (typeof prompt?.placeholder === 'string') view.placeholder = short(prompt.placeholder, 200)
  if (kind === 'select') {
    view.options = (Array.isArray(prompt?.options) ? prompt.options : []).slice(0, 32)
      .filter(option => typeof option?.id === 'string' && option.id.length <= 128)
      .map(option => ({ id: option.id, label: short(option.label, 200), description: short(option.description, 400) }))
  }
  return view
}

const NETWORK_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
])

/** Return a bounded diagnostic category; never copy provider-controlled error text. */
function oauthFailure(error) {
  const seen = new Set()
  for (let depth = 0; depth < 4 && error && typeof error === 'object' && !seen.has(error); depth += 1) {
    seen.add(error)
    try {
      if (error.code === 'NOT_COMMITTED') return 'record-not-committed'
      if (error.code === 'NO_CREDENTIAL_STORE') return 'credential-store'
      if (error.code === 'invalid_grant' || error.code === 'access_denied') return 'oauth-rejected'
      if (NETWORK_CODES.has(error.code)) return 'network'
      const status = error.status ?? error.statusCode ?? error.response?.status
      if (Number.isInteger(status) && status >= 400 && status <= 599) return `http-${status}`
      error = error.cause
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

/** One process-local Codex OAuth attempt, addressed by an unguessable ticket. */
export class CodexLoginController {
  constructor({ authorization, credentials, key, timeoutMs = 600_000, logger = undefined }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 3_600_000) {
      throw new RangeError('Codex login timeout must be between 60 and 3600 seconds')
    }
    this.authorization = authorization
    this.credentials = credentials
    this.key = key
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.current = undefined
    this.closed = false
    this.loggingOut = false
    this.pendingLogout = undefined
  }

  start() {
    if (this.closed) throw fail('unavailable', '登录插件已卸载。')
    if (this.loggingOut) throw fail('busy', '正在退出 Codex 登录。')
    const flow = this.authorization.describe(this.key)
    if (!flow?.methods?.some(method => method.id === 'oauth')) {
      throw fail('no-flow', '当前 DSH 未提供 openai-codex OAuth 登录流程。')
    }
    if (flow.inFlight || this.current?.state === 'running') {
      throw fail('busy', 'Codex 登录正在进行，请先完成或取消。')
    }

    const attempt = {
      ticket: randomUUID(), state: 'running', notices: [], prompts: new Map(),
      controller: new AbortController(), timedOut: false, timer: undefined, done: undefined,
    }
    this.current = attempt
    attempt.timer = setTimeout(() => {
      if (attempt.state === 'running') {
        attempt.timedOut = true
        attempt.controller.abort()
        this.authorization.cancel(this.key)
      }
    }, this.timeoutMs)
    attempt.done = Promise.resolve().then(() => this.authorization.begin({
      key: this.key,
      method: 'oauth',
      signal: attempt.controller.signal,
      interaction: {
        notify: notice => {
          if (attempt.state !== 'running' || attempt.controller.signal.aborted) return
          attempt.notices.push(noticeView(notice))
          if (attempt.notices.length > 16) attempt.notices.shift()
        },
        prompt: prompt => this.waitForAnswer(attempt, prompt),
      },
    })).then(outcome => {
      attempt.state = attempt.timedOut ? 'timeout'
        : outcome.status === 'authorized' ? 'authorized' : 'cancelled'
    }, error => {
      attempt.state = attempt.timedOut ? 'timeout'
        : attempt.controller.signal.aborted ? 'cancelled' : 'error'
      if (attempt.state === 'error') {
        attempt.failure = oauthFailure(error)
        this.logger?.warn?.('codex-login: OAuth attempt failed (%s)', attempt.failure)
      }
    }).finally(() => {
      clearTimeout(attempt.timer)
      for (const pending of attempt.prompts.values()) pending.reject(aborted())
      attempt.prompts.clear()
      attempt.notices.length = 0
    })
    return { ticket: attempt.ticket }
  }

  waitForAnswer(attempt, prompt) {
    if (attempt.controller.signal.aborted || attempt.state !== 'running') return Promise.reject(aborted())
    if (attempt.prompts.size >= 4) return Promise.reject(fail('too-many-prompts', '登录问题过多，请重试。'))
    const id = randomUUID()
    const view = promptView(prompt, id)
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        attempt.prompts.delete(id)
        attempt.controller.signal.removeEventListener('abort', onAbort)
        prompt?.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const onAbort = () => finish(reject, aborted())
      attempt.prompts.set(id, {
        view,
        resolve: value => finish(resolve, value),
        reject: reason => finish(reject, reason),
      })
      attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
      prompt?.signal?.addEventListener('abort', onAbort, { once: true })
      if (attempt.controller.signal.aborted || prompt?.signal?.aborted) onAbort()
    })
  }

  async status(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 64) throw fail('invalid', '无效的登录票据。')
    const record = await this.credentials.describeRecord(this.key)
    const base = {
      authorized: record.configured === true && record.kind === 'grant',
      inFlight: this.authorization.describe(this.key)?.inFlight === true,
    }
    if (ticket === '') return { ...base, state: 'idle', notices: [], prompts: [] }
    const attempt = this.owned(ticket)
    return {
      ...base, state: attempt.state,
      ...attempt.state === 'error' ? { failure: attempt.failure } : {},
      notices: [...attempt.notices],
      prompts: [...attempt.prompts.values()].map(pending => pending.view),
    }
  }

  answer(ticket, promptId, value) {
    const attempt = this.owned(ticket)
    if (attempt.state !== 'running' || attempt.controller.signal.aborted) {
      throw fail('not-running', '当前登录已结束。')
    }
    if (typeof promptId !== 'string' || typeof value !== 'string' || value.length > 4096) {
      throw fail('invalid', '登录回答无效。')
    }
    const pending = attempt.prompts.get(promptId)
    if (!pending) throw fail('prompt-expired', '该登录问题已结束，请刷新状态。')
    if (pending.view.kind === 'select' && !pending.view.options.some(option => option.id === value)) {
      throw fail('invalid', '请选择列出的选项。')
    }
    pending.resolve(value)
    return { accepted: true }
  }

  cancel(ticket) {
    const attempt = this.owned(ticket)
    if (attempt.state === 'running') {
      attempt.controller.abort()
      this.authorization.cancel(this.key)
    }
    return { cancelled: attempt.state === 'running' }
  }

  async logout() {
    if (this.loggingOut || this.current?.state === 'running' || this.authorization.describe(this.key)?.inFlight) {
      throw fail('busy', '请先结束正在进行的登录，再退出。')
    }
    this.loggingOut = true
    this.pendingLogout = (async () => {
      const record = await this.credentials.describeRecord(this.key)
      if (record.configured && record.kind !== 'grant') {
        throw fail('not-oauth', '这里保存的不是 Codex OAuth 凭据，无法从此处删除。')
      }
      if (record.configured) await this.credentials.deleteRecord(this.key)
      return { loggedOut: true }
    })()
    try {
      return await this.pendingLogout
    } finally {
      this.pendingLogout = undefined
      this.loggingOut = false
    }
  }

  owned(ticket) {
    if (typeof ticket !== 'string' || this.current?.ticket !== ticket) {
      throw fail('not-found', '登录票据已失效，请重新开始。')
    }
    return this.current
  }

  async dispose() {
    this.closed = true
    const attempt = this.current
    if (attempt?.state === 'running') {
      attempt.controller.abort()
      this.authorization.cancel(this.key)
      await attempt.done
    }
    // A remote logout may still be waiting for a serialized credential-store write.
    if (this.pendingLogout) await this.pendingLogout.catch(() => {})
    this.current = undefined
  }
}
