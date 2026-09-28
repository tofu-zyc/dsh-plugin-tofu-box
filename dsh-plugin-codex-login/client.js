window.__ModuleLoader__.load({
  id: 'dsh-plugin-codex-login',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const CSS = `
.codex-login{display:flex;flex-direction:column;gap:9px;margin:10px 0 2px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.codex-login__title{font-weight:600}
.codex-login__hint,.codex-login__notice{color:var(--dsw-alias-label-secondary);line-height:1.5;margin:0}
.codex-login__error{color:var(--dsw-alias-state-error-primary);margin:0}
.codex-login__ok{color:var(--dsw-alias-state-success-primary);margin:0}
.codex-login__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.codex-login__button{padding:5px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}
.codex-login__button:disabled{opacity:.5;cursor:default}
.codex-login__link{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
.codex-login__code{font:600 16px ui-monospace,monospace;user-select:all}
.codex-login__prompt{display:flex;flex-direction:column;gap:7px}
.codex-login__field{padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;max-width:360px}
`

    const copy = {
      zh: {
        title: 'Codex · ChatGPT 登录', setup: '先保存 openai-codex 提供商（API 密钥留空），再登录。',
        signIn: '使用 ChatGPT 登录', retry: '重新登录', signedIn: '已登录 ChatGPT', signedOut: '尚未登录 ChatGPT',
        waiting: '等待浏览器完成授权…', busy: '另一处登录正在进行，请稍后再试。',
        cancelled: '登录已取消。', timeout: '登录超时，请重试。', failed: '登录失败，原因暂未识别。',
        failedRecord: '授权流程结束，但 DSH 未收到新凭据。', failedStore: 'DSH 凭据存储不可用。',
        failedNetwork: 'Desktop 宿主的授权网络请求失败，请检查网络与代理。',
        failedOAuth: '授权结果被服务端拒绝，请重新登录。', failedHttp: '授权请求返回错误：',
        cancel: '取消登录', logout: '退出登录', confirmLogout: '确认退出', keep: '保留登录',
        logoutHint: '退出仅删除 DSH 保存的凭据，不会吊销 OpenAI 端的令牌。',
        submit: '提交', choose: '请选择', copyCode: '复制验证码', copied: '已复制', copyFailed: '复制失败，请手动选择验证码。',
        requestFailed: '请求失败，请重试。',
      },
      en: {
        title: 'Codex · ChatGPT sign-in', setup: 'Save the openai-codex provider without an API key before signing in.',
        signIn: 'Sign in with ChatGPT', retry: 'Sign in again', signedIn: 'Signed in to ChatGPT', signedOut: 'Not signed in to ChatGPT',
        waiting: 'Waiting for browser authorization…', busy: 'Another sign-in is in progress. Try again later.',
        cancelled: 'Sign-in cancelled.', timeout: 'Sign-in timed out. Try again.', failed: 'Sign-in failed; the reason is not identified.',
        failedRecord: 'The authorization flow ended without saving a new credential in DSH.',
        failedStore: 'The DSH credential store is unavailable.',
        failedNetwork: 'A Desktop host authorization request failed. Check the host network and proxy.',
        failedOAuth: 'The authorization result was rejected by the server. Try signing in again.',
        failedHttp: 'An authorization request returned an error:',
        cancel: 'Cancel sign-in', logout: 'Sign out', confirmLogout: 'Confirm sign-out', keep: 'Keep signed in',
        logoutHint: 'Signing out removes the credential saved in DSH; it does not revoke the token at OpenAI.',
        submit: 'Submit', choose: 'Choose an option', copyCode: 'Copy code', copied: 'Copied', copyFailed: 'Copy failed; select the code manually.',
        requestFailed: 'Request failed. Try again.',
      },
    }

    function CodexCard(props) {
      const { provider, configured, call, t } = props
      const isCodex = provider?.provider === 'openai-codex'
      const [ticket, setTicket] = React.useState('')
      const [snapshot, setSnapshot] = React.useState({ authorized: false, inFlight: false, state: 'idle', notices: [], prompts: [] })
      const [answer, setAnswer] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [confirmLogout, setConfirmLogout] = React.useState(false)
      const [copiedCode, setCopiedCode] = React.useState('')
      const [currentPromptId, setCurrentPromptId] = React.useState('')

      React.useEffect(() => {
        if (!isCodex || !configured) return undefined
        let mounted = true
        let requesting = false
        const refresh = async () => {
          if (requesting) return
          requesting = true
          try {
            const next = await call('status', { ticket })
            if (mounted) { setSnapshot(next); setError('') }
          } catch (cause) {
            if (mounted) setError(cause.message || t('requestFailed'))
          } finally { requesting = false }
        }
        void refresh()
        const timer = setInterval(refresh, 1800)
        return () => { mounted = false; clearInterval(timer) }
      }, [isCodex, configured, ticket, call, t])

      React.useEffect(() => {
        const promptId = snapshot.prompts[0]?.id || ''
        if (promptId !== currentPromptId) {
          setCurrentPromptId(promptId)
          setAnswer('')
        }
      }, [snapshot.prompts, currentPromptId])

      // Unmounting a card withdraws its own attempt; an unrelated tab's attempt is untouched.
      React.useEffect(() => () => {
        if (ticket && snapshot.state === 'running') void call('cancel', { ticket }).catch(() => {})
      }, [ticket, snapshot.state, call])

      if (!isCodex) return null
      const notices = snapshot.notices || []
      const prompt = snapshot.prompts?.[0]
      const running = ticket && snapshot.state === 'running'
      const canStart = configured && !busy && !snapshot.inFlight && !running
      const label = key => t(key)
      const failureText = () => {
        const reason = snapshot.failure
        if (reason === 'record-not-committed') return t('failedRecord')
        if (reason === 'credential-store') return t('failedStore')
        if (reason === 'network') return t('failedNetwork')
        if (reason === 'oauth-rejected') return t('failedOAuth')
        if (/^http-[45]\d\d$/.test(reason || '')) return `${t('failedHttp')} HTTP ${reason.slice(5)}`
        return t('failed')
      }
      const act = async (method, args, after) => {
        setBusy(true)
        setError('')
        try { const result = await call(method, args); after?.(result) }
        catch (cause) { setError(cause.message || t('requestFailed')) }
        finally { setBusy(false) }
      }
      const submit = event => {
        event.preventDefault()
        if (!prompt || !answer) return
        void act('answer', { ticket, promptId: prompt.id, value: answer }, () => setAnswer(''))
      }

      return h('section', { className: 'codex-login', 'aria-label': t('title') },
        h('div', { className: 'codex-login__title' }, t('title')),
        !configured ? h('p', { className: 'codex-login__hint' }, t('setup')) :
          h('p', { className: snapshot.authorized ? 'codex-login__ok' : 'codex-login__hint', role: 'status' },
            snapshot.authorized ? t('signedIn') : t('signedOut')),
        snapshot.inFlight && !running ? h('p', { className: 'codex-login__hint' }, t('busy')) : null,
        running ? h('p', { className: 'codex-login__hint' }, t('waiting')) : null,
        ['cancelled', 'timeout', 'error'].includes(snapshot.state)
          ? h('p', { className: 'codex-login__hint' }, snapshot.state === 'error' ? failureText() : label(snapshot.state)) : null,
        ...notices.map((notice, index) => h('div', { key: index, className: 'codex-login__notice' },
          h('p', { className: 'codex-login__notice' }, notice.message),
          notice.url ? h('a', { className: 'codex-login__link', href: notice.url, target: '_blank', rel: 'noopener noreferrer' }, notice.url) : null,
          notice.code ? h('div', { className: 'codex-login__actions' },
            h('code', { className: 'codex-login__code' }, notice.code),
            h('button', { type: 'button', className: 'codex-login__button', onClick: async () => {
              try { await navigator.clipboard.writeText(notice.code); setCopiedCode(notice.code) }
              catch { setError(t('copyFailed')) }
            } }, copiedCode === notice.code ? t('copied') : t('copyCode'))) : null,
        )),
        prompt && running ? h('form', { className: 'codex-login__prompt', onSubmit: submit },
          h('label', { htmlFor: `codex-prompt-${prompt.id}` }, prompt.message),
          prompt.kind === 'select'
            ? h('select', { id: `codex-prompt-${prompt.id}`, className: 'codex-login__field', value: answer,
              onChange: event => setAnswer(event.target.value) },
              h('option', { value: '' }, t('choose')),
              ...(prompt.options || []).map(option => h('option', { key: option.id, value: option.id }, option.label)))
            : h('input', { id: `codex-prompt-${prompt.id}`, className: 'codex-login__field',
              type: prompt.kind === 'secret' ? 'password' : 'text', autoComplete: 'off',
              placeholder: prompt.placeholder || '', value: answer, onChange: event => setAnswer(event.target.value) }),
          h('div', null, h('button', { type: 'submit', className: 'codex-login__button', disabled: !answer || busy }, t('submit')))) : null,
        error ? h('p', { className: 'codex-login__error', role: 'alert' }, error) : null,
        h('div', { className: 'codex-login__actions' },
          configured && !running ? h('button', { type: 'button', className: 'codex-login__button', disabled: !canStart,
            onClick: () => void act('start', {}, result => {
              setTicket(result.ticket)
              setSnapshot(current => ({ ...current, state: 'running', inFlight: true, notices: [], prompts: [] }))
            }) }, snapshot.authorized ? t('retry') : t('signIn')) : null,
          running ? h('button', { type: 'button', className: 'codex-login__button', disabled: busy,
            onClick: () => void act('cancel', { ticket }) }, t('cancel')) : null,
          snapshot.authorized && !snapshot.inFlight && !running && !confirmLogout
            ? h('button', { type: 'button', className: 'codex-login__button', disabled: busy,
              onClick: () => setConfirmLogout(true) }, t('logout')) : null,
          confirmLogout ? h('button', { type: 'button', className: 'codex-login__button', disabled: busy,
            onClick: () => void act('logout', {}, () => { setConfirmLogout(false); setTicket('');
              setSnapshot(current => ({ ...current, authorized: false, state: 'idle' })) }) }, t('confirmLogout')) : null,
          confirmLogout ? h('button', { type: 'button', className: 'codex-login__button', disabled: busy,
            onClick: () => setConfirmLogout(false) }, t('keep')) : null,
        ),
        confirmLogout ? h('p', { className: 'codex-login__hint' }, t('logoutHint')) : null,
      )
    }

    const inject = ['slots', 'connection', 'locale']
    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-codex-login'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove())
      ctx.effect(() => ctx.locale.register('dsh-plugin-codex-login', copy))
      const t = ctx.locale.bind('dsh-plugin-codex-login')
      const call = async (method, args) => {
        const response = await ctx.connection.rpc.call('/api', `codexLogin/${method}`, { args })
        if (!response.ok) throw new Error(response.error?.message || t('requestFailed'))
        return response.value
      }
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-pi-ai', inject: () => ({ call, t }),
      }, CodexCard))
    }
    module.exports = { apply, inject }
    return module.exports
  },
})
