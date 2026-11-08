/**
 * The body: reserve, structure, maturity, health, fatigue, metabolism.
 *
 * OWNER: sim-core
 * Implements the DEB-lite equations in docs/20-CORE-LOOP.md section 4:
 *   metabolise(entity, dt)  -> consumes/produces body.E, body.V, body.M
 *   applyDamage(entity, amount, cause)
 * This is the single energy ledger. Nothing else may write body.E.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */
