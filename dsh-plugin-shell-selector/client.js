window.__ModuleLoader__.load({
  id: 'dsh-plugin-shell-selector',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'shell-selector'
    const SERVICE = 'shellSelector'

    // Every key exists in both dictionaries: the page never renders a missing
    // translation, and a host-supplied Chinese fallback is only used when the
    // host reported no key at all.
    //
    // Dictionaries are keyed by LOCALE ID. `@deepseek-ai/dsh-client-locale` ships
    // `zh` and `en` (`LOCALE_IDS`), and `bind(ns)` walks the active locale's
    // fallback chain — `zh` -> `en`. A dictionary registered only under a region
    // tag such as `zh-CN` therefore matches nothing, and Chinese silently renders
    // as English. `zh` is the id that must exist; region variants are covered by
    // registration-time enumeration below.
    const CHINESE = {
        title: 'Shell',
        intro: '选择 AI 执行命令时使用的 shell。改动会真实作用于之后启动的命令，并影响本机所有会话。',
        effective: '当前实际执行',
        sandbox: '沙箱默认模式',
        refresh: '刷新',
        unavailable: '不可用',
        applying: '正在切换…',
        'notice.applied': '已切换。下一条命令将使用所选 shell。',
        custom: '当前值由本页之外的配置写入，本页不会覆盖它；选择任一项即可接管。',
        readonly: '设置存储不可写，无法切换。',
        absent: '未找到 shell 执行器，请确认 PowerShell 执行器已加载后重启。',
        retry: '重试',
        'option.auto': '自动（保留当前默认）',
        'option.pwsh7': 'PowerShell 7',
        'option.pwsh5': 'Windows PowerShell 5.1',
        'option.gitbash': 'Git Bash',
        'reason.windowsOnly': 'Shell 选择器仅适用于 Windows 部署。',
        'reason.autoPathLookup': '未找到已知安装位置，将按 PATH 解析 pwsh。',
        'reason.autoLanded7': '自动优先使用 PowerShell 7。',
        'reason.autoLanded51': '未安装 PowerShell 7，自动回落到 Windows PowerShell 5.1。',
        'reason.noPwsh7': '未检测到 PowerShell 7（pwsh.exe）。',
        'reason.noPwsh5': '未检测到 Windows PowerShell 5.1（%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe）。',
        'reason.noGitBash': '未检测到 Git for Windows（%ProgramFiles%\\Git\\bin\\bash.exe）。',
        'reason.gitBashUnverified': '已安装，但尚未验证它能在 Windows 文件沙箱下受限运行，因此暂不可选。',
        'reason.wslBash': '解析结果是 WSL 启动器而非 Git Bash，已拒绝。',
        'reason.pwsh5Dialect': 'PowerShell 5.1 语法与 7 不同，见下方兼容提示。',
        'note.running': '已在运行的后台命令不受影响：它们仍使用启动时的 shell。改动只作用于之后启动的命令。',
        'note.pwsh5': '兼容提示（必须阅读）：Windows PowerShell 5.1 不支持 && 与 || 管道链、三元运算符 ? : 和 ?? 空合并运算符。命令与脚本需改用 ; 串联，并用 if (...) { } else { } 分支。',
        'note.gitbash': '为什么不可选：Windows 文件沙箱以受限令牌运行命令，只授予工作区与私有临时目录写权限，且两种受限模式下程序都无法打开命名管道，而 MSYS2 的 fork 模拟依赖命名管道。另外 PATH 上的 bash 是 WSL 启动器（另一个文件系统命名空间），不是 Git Bash，因此本插件只按 Git for Windows 显式路径解析。在受限运行验证完成之前不会提供该选项，也不会以无沙箱方式运行。',
    }

    const ENGLISH = {
        title: 'Shell',
        intro: 'Choose the shell the AI runs commands in. The change takes effect for commands started afterwards and applies to every session on this machine.',
        effective: 'Currently executing',
        sandbox: 'Default sandbox mode',
        refresh: 'Refresh',
        unavailable: 'Unavailable',
        applying: 'Switching…',
        'notice.applied': 'Switched. The next command uses the selected shell.',
        custom: 'The current value was written outside this page and is not overwritten here; picking any option takes it over.',
        readonly: 'The settings store is not writable, so the shell cannot be switched.',
        absent: 'No shell executor was found. Confirm the PowerShell executor is loaded, then restart.',
        retry: 'Retry',
        'option.auto': 'Automatic (keep the current default)',
        'option.pwsh7': 'PowerShell 7',
        'option.pwsh5': 'Windows PowerShell 5.1',
        'option.gitbash': 'Git Bash',
        'reason.windowsOnly': 'The shell selector applies to Windows deployments only.',
        'reason.autoPathLookup': 'No known install location was found, so `pwsh` resolves through PATH.',
        'reason.autoLanded7': 'Automatic prefers PowerShell 7.',
        'reason.autoLanded51': 'PowerShell 7 is not installed, so automatic falls back to Windows PowerShell 5.1.',
        'reason.noPwsh7': 'PowerShell 7 (pwsh.exe) was not detected.',
        'reason.noPwsh5': 'Windows PowerShell 5.1 was not detected (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe).',
        'reason.noGitBash': 'Git for Windows was not detected (%ProgramFiles%\\Git\\bin\\bash.exe).',
        'reason.gitBashUnverified': 'Installed, but it has not been verified to run confined under the Windows file sandbox, so it is not selectable.',
        'reason.wslBash': 'The resolved executable was the WSL launcher rather than Git Bash, so it was refused.',
        'reason.pwsh5Dialect': 'PowerShell 5.1 syntax differs from 7; see the compatibility note below.',
        'note.running': 'Background commands already running are unaffected: they keep the shell they started with. Only commands started afterwards change.',
        'note.pwsh5': 'Compatibility note (required reading): Windows PowerShell 5.1 has no `&&` or `||` pipeline chains, no ternary `? :`, and no `??`. Chain with `;` and branch with `if (...) { } else { }`.',
        'note.gitbash': 'Why this is unavailable: the Windows file sandbox runs commands under a restricted token whose write capabilities cover only the workspace and a private temp directory, and programs cannot open named pipes in either confined mode, while MSYS2 fork emulation depends on them. The `bash` on PATH is also the WSL launcher (a separate filesystem namespace), not Git Bash, so only explicit Git for Windows paths are resolved. The option stays unavailable until confined execution is verified, and it is never run unsandboxed.',
    }

    /** The locale ids the browser client ships; `zh` is mandatory, not `zh-CN`. */
    const BUILT_IN_LOCALE_IDS = ['zh', 'en']

    /** Pick the dictionary a locale id should receive, by its primary subtag. */
    function dictionaryFor(id) {
      const primary = String(id).toLowerCase().split('-')[0]
      if (primary === 'zh') return CHINESE
      if (primary === 'en') return ENGLISH
      return undefined
    }

    /**
     * Register the dictionary pair for the built-in ids plus every id the live
     * catalog exposes, so a language-pack locale such as `zh-CN` or `zh-Hans`
     * resolves Chinese instead of falling through to English.
     * @returns a disposer removing every registration this call made.
     */
    function registerDictionaries(locale) {
      const ids = new Set(BUILT_IN_LOCALE_IDS)
      for (const definition of locale.getSnapshot().locales) {
        if (definition !== null && typeof definition === 'object' && typeof definition.id === 'string') ids.add(definition.id)
      }
      const disposers = []
      for (const id of ids) {
        const dict = dictionaryFor(id)
        if (dict !== undefined) disposers.push(locale.register(NS, id, dict))
      }
      return () => { for (const dispose of disposers) dispose() }
    }

    const css = `
.ss-page{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;color:inherit}
.ss-page fieldset{border:1px solid #8886;border-radius:10px;padding:14px;min-width:0;display:flex;flex-direction:column;gap:10px}
.ss-page legend{font-weight:600;padding:0 6px}
.ss-option{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid #8885;border-radius:8px;cursor:pointer}
.ss-option-off{opacity:.6;cursor:default}
.ss-option input{margin-top:4px;flex:none}
.ss-option-body{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}
.ss-option-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ss-badge{font-size:11px;border:1px solid #8888;border-radius:999px;padding:1px 7px;opacity:.85}
.ss-path{font-size:12px;overflow-wrap:anywhere;opacity:.9}
.ss-note{font-size:12px;opacity:.78;line-height:1.6;margin:0}
.ss-warn{color:#d5533d}
.ss-error{color:#d5533d;white-space:pre-wrap;font-size:12px}
.ss-ok{font-size:12px;opacity:.85}
.ss-head{display:flex;flex-direction:column;gap:5px}
.ss-actions{display:flex;gap:8px;flex-wrap:wrap}
.ss-page button{padding:7px 11px;border:1px solid #8888;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.ss-page button:disabled{opacity:.5;cursor:default}
`

    /**
     * The Remote envelope: `{ ok: true, value }` or `{ ok: false, error }`.
     * Unwrapped once here so every caller sees the value or a thrown error.
     */
    const unwrap = response => {
      if (!response || response.ok !== true) throw new Error(response?.error?.message ?? '请求失败')
      return response.value
    }

    /**
     * Re-render on language change and return the current translator. The
     * snapshot is read through the store so a switch is reflected immediately.
     */
    function useTranslate(locale) {
      const subscribe = React.useCallback(callback => locale.subscribe(callback), [locale])
      const snapshot = React.useCallback(() => locale.getSnapshot(), [locale])
      React.useSyncExternalStore(subscribe, snapshot, snapshot)
      return locale.bind(NS)
    }

    function Page({ remote, call, locale, close }) {
      const translate = useTranslate(locale)
      const t = (key, fallback) => {
        const value = translate(key)
        return value === undefined || value === null || value === '' || value === key ? (fallback ?? key) : value
      }
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const refresh = React.useCallback(async () => {
        const next = await call('probe', {})
        setView(next)
        return next
      }, [call])

      React.useEffect(() => {
        let live = true
        refresh().then(() => { if (live) setError('') }, problem => { if (live) setError(problem.message) })
        return () => { live = false }
      }, [refresh])

      async function choose(kind) {
        if (view === null) return
        setBusy(kind); setError(''); setNotice('')
        try {
          const next = await call('select', { kind, revision: view.revision })
          setView(next)
          setNotice(t('notice.applied'))
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy('')
        }
      }

      async function retry() {
        setError(''); setNotice('')
        try { await refresh() } catch (problem) { setError(problem.message) }
      }

      if (view === null) {
        return h('div', { className: 'ss-page' },
          h('p', { className: 'ss-note' }, error === '' ? t('applying') : error),
          error === '' ? null : h('div', { className: 'ss-actions' }, h('button', { onClick: () => void retry() }, t('retry'))))
      }

      const locked = view.writable !== true || busy !== ''
      const rows = view.options.map(option => {
        const selected = view.current.kind === option.kind
        const reason = option.reasonKey ? t(option.reasonKey, option.reason) : option.reason
        const detail = option.detailKey ? t(option.detailKey) : ''
        const notes = []
        if (detail !== '') notes.push(h('p', { className: 'ss-note', key: 'detail' }, detail))
        if (reason) notes.push(h('p', { className: 'ss-note ss-warn', key: 'reason' }, reason))
        if (option.kind === 'pwsh5') notes.push(h('p', { className: 'ss-note', key: 'pwsh5' }, t('note.pwsh5')))
        if (option.kind === 'gitbash') notes.push(h('p', { className: 'ss-note', key: 'gitbash' }, t('note.gitbash')))
        return h('label', { key: option.kind, className: option.available ? 'ss-option' : 'ss-option ss-option-off' },
          h('input', {
            type: 'radio',
            name: 'shell-kind',
            checked: selected,
            disabled: !option.available || locked,
            onChange: () => void choose(option.kind),
          }),
          h('div', { className: 'ss-option-body' },
            h('div', { className: 'ss-option-head' },
              h('strong', null, t(option.labelKey, option.kind)),
              option.available ? null : h('span', { className: 'ss-badge' }, t('unavailable')),
              option.path ? h('code', { className: 'ss-path' }, option.path) : null),
            notes.length > 0 ? h('div', null, notes) : null))
      })

      return h('div', { className: 'ss-page' },
        h('p', { className: 'ss-note' }, t('intro')),
        h('div', { className: 'ss-head' },
          h('p', { className: 'ss-note' }, `${t('effective')}: `, h('code', null, view.executable ?? '—')),
          h('p', { className: 'ss-note' }, `${t('sandbox')}: `, h('code', null, view.sandboxMode ?? '—')),
          view.current.kind === 'custom' ? h('p', { className: 'ss-note ss-warn' }, t('custom')) : null,
          view.namespaceRegistered !== true ? h('p', { className: 'ss-note ss-warn' }, t('absent')) : null,
          view.writable !== true ? h('p', { className: 'ss-note ss-warn' }, t('readonly')) : null,
          view.supported !== true ? h('p', { className: 'ss-note ss-warn' }, t('reason.windowsOnly')) : null),
        h('fieldset', null, h('legend', null, t('title')), ...rows),
        h('p', { className: 'ss-note' }, t('note.running')),
        busy === '' ? null : h('p', { className: 'ss-ok' }, t('applying')),
        notice === '' ? null : h('p', { className: 'ss-ok', role: 'status' }, notice),
        error === '' ? null : h('p', { className: 'ss-error', role: 'alert' }, error),
        h('div', { className: 'ss-actions' },
          h('button', { disabled: busy !== '', onClick: () => void retry() }, t('refresh')),
          typeof close === 'function' ? h('button', { onClick: () => close() }, t('title')) : null))
    }

    return {
      inject: ['slots', 'connection', 'remote', 'remote.settings', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove())
        ctx.effect(() => registerDictionaries(ctx.locale))
        const t = ctx.locale.bind(NS)
        const call = async (method, args) => unwrap(await ctx.connection.rpc.call('/api', `${SERVICE}/${method}`, { args }))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: NS, order: 14, label: () => t('title') },
          props => h(Page, { ...props, remote: ctx.remote, call, locale: ctx.locale })))
      },
    }
  },
})
