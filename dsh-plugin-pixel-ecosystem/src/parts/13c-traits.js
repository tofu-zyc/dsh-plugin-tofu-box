/**
 * Trait cards: composable phenotype, compiled once per birth.
 *
 * OWNER: sim-core
 * A trait is data: { id, hooks: { metabolism, speed, ... }, params, upkeep }.
 * Phenotype = compilePhenotype(species, genes) evaluated at birth, never per tick.
 * Every trait pays upkeep in the energy ledger so no combo is free.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */
