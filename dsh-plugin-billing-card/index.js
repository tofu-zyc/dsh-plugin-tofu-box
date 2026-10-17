/**
 * Host half of the Billing Card plugin.
 *
 * The plugin owns no model calls, no network, and no UI: it registers exactly
 * one client-visible Session projection unit (`billingUsage`) that folds durable
 * Session events into per-route token buckets and estimated costs. The Client
 * half renders that wire view below the composer.
 *
 * The plugin exports no `Config` schema on purpose, so the raw row config reaches
 * `apply` and `resolveBillingConfig` is the single source of truth for defaults
 * and validation.
 *
 * @module dsh-plugin-billing-card
 */

import { createBillingProjection, resolveBillingConfig } from './billing-core.js'

/** Loader-visible plugin name. */
export const name = 'dsh-plugin-billing-card'

/** The projection registry this plugin contributes its unit to. */
export const inject = ['sessionProjections']

/**
 * Validate the row config and register the `billingUsage` Session projection.
 *
 * `register()` is itself an effect on the calling plugin fiber, so the unit is
 * unregistered when the plugin unloads; no nested `ctx.effect` is needed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the `sessionProjections` injection.
 * @param {unknown} config - raw row config from the profile composition; validated here.
 */
export function apply(ctx, config) {
  const resolved = resolveBillingConfig(config ?? {})
  ctx.sessionProjections.register(createBillingProjection(resolved))
}
