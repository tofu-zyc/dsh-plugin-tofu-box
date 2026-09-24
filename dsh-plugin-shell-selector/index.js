/**
 * Host half of the Shell selector.
 *
 * This plugin owns no execution path. It reads the live facts off the composed
 * shell executor (`ctx.shell`) and the settings service, and its only write is
 * the already-supported `shell.pwshPath` field, which `dsh-pwsh-local` re-resolves
 * in its own `onChange` hook. Consequently the sandbox, approval, workdir,
 * timeout, cancellation, exit/stdout/stderr, and background-job behaviour are the
 * shipped ones, untouched — no `child_process`, no argv prefix, no row override.
 *
 * Command syntax stays honest too: the `pwsh` tool schema is correct for every
 * option this version can select. When the effective shell is Windows PowerShell
 * 5.1 the executor's own facts no longer match the schema's PowerShell 7
 * examples, so one runtime-context line states the real dialect. It adds nothing
 * for PowerShell 7, and it does not modify the tool.
 *
 * @module dsh-plugin-shell-selector
 */

import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ShellSelectorError, dialectHint, executeSelection, probeShells } from './shells.js'

export const name = 'dsh-plugin-shell-selector'

/** PowerShell sandbox Config is read through the profile-entry settings service; the executor is an optional read. */
export const inject = ['settings']

/** Remote namespace; the page calls `/api` with `<SERVICE>/<method>`. */
export const SERVICE = 'shellSelector'

/** Placement of the dialect note among the registered runtime contexts. */
const DIALECT_CONTEXT_ORDER = 45

/** Map a planning failure onto the Remote envelope the client unwraps. */
function toRemoteError(error) {
  if (error instanceof ShellSelectorError) return new RemoteError(error.code, error.message)
  return new RemoteError('shell-selector/failed', error instanceof Error ? error.message : String(error))
}

/**
 * Remote surface behind the settings page. Constructing it registers
 * `ctx.shellSelector`; the page holds no direct service access.
 */
export class ShellSelectorService extends TypertRemoteService {
  /** @param ctx - the plugin context carrying the `settings` injection. */
  constructor(ctx) {
    super(ctx, SERVICE)
  }

  /**
   * Live executor facts plus the selectable options.
   * @returns the page payload; `executable` is the path the next command will use.
   */
  probe() {
    return probeShells({
      settings: this.ctx.settings,
      shell: this.ctx.get('shell'),
      env: process.env,
      platform: process.platform,
    })
  }

  /**
   * Validate one requested option, write it, and return the refreshed payload.
   * @param kind - `auto`, `pwsh7`, `pwsh5`, or `gitbash`.
   * @param revision - the `shell` namespace revision the caller read.
   * @returns the payload after the write.
   */
  async select(kind, revision) {
    try {
      await executeSelection({
        kind,
        revision,
        settings: this.ctx.settings,
        env: process.env,
        platform: process.platform,
      })
    } catch (error) {
      throw toRemoteError(error)
    }
    return this.probe()
  }
}

Object.defineProperty(ShellSelectorService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(['probe', 'select'].map(method =>
      Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
})

/**
 * Register the Remote service and the dialect context.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  // Constructing the service is the registration; nothing else needs the handle.
  new ShellSelectorService(ctx)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  // An empty string renders as no context at all, so this contributes only while
  // the effective shell really is Windows PowerShell 5.1.
  ctx.effect(() => systemPrompt.context({
    name: 'shell-selector/dialect',
    order: DIALECT_CONTEXT_ORDER,
    text: () => dialectHint(ctx.get('shell')?.pwshPath, process.env),
  }))
}
