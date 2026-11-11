/**
 * Browser half of the Pixel Terrarium plugin.
 *
 * One panel, one canvas, one simulation:
 *
 * - Two additive seats only. `sidebar.panellist` gets the pixel icon that opens
 *   the panel, and the keyed `main` seat with the SAME id gets the panel body.
 *   Nothing shipped is replaced, overridden or disabled.
 * - The world lives in this module's closure, not in React and not in the
 *   Session log. The panel hands a canvas to the store, the store runs one
 *   `requestAnimationFrame` loop that steps the simulation and repaints, and
 *   React only re-renders ~2×/s for the counters, chart and inspector.
 * - The engine below is deliberately DOM-free and clock-free: `createWorld`,
 *   `stepWorld`, `place`, `paintWorld`, `serializeWorld` are plain functions
 *   over typed arrays, so `node --test` can drive tens of thousands of ticks
 *   headlessly (see DESIGN.md §5 and tests/). The bundle exports them under
 *   `module.exports.__engine` for exactly that purpose.
 *
 * The ecosystem is species-table driven: one `SPECIES` row plus one sprite is
 * all it takes to add a creature. Species carry their habitat, diet, gene
 * ranges and per-kind balance numbers; the step logic is shared.
 *
 * @module dsh-plugin-pixel-ecosystem/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-pixel-ecosystem',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /**
     * Build stamp shown in the panel header.
     *
     * Kept in sync with package.json by tests/build.test.mjs. It exists because
     * "the fix did not work" turned out twice to mean "the browser is running a
     * cached older module": without a visible stamp there is no way to tell a
     * stale bundle from a broken fix.
     */
    const BUILD_VERSION = '0.3.10'

    /** Locale namespace; equals the package name. */
    const NS = 'dsh-plugin-pixel-ecosystem'
    /** Sidebar entry id and `main` panel key. The two must be the same string. */
    const PANEL_ID = 'pixel-ecosystem'
    /** localStorage key for the autosaved world. */
    const STORAGE_KEY = 'dsh-pixel-ecosystem:v2'
    /**
     * Key the 0.2.x build used. v2 never writes it, so an old world survives a
     * version bump instead of being overwritten by the first autosave; the store
     * reads it once to tell the player why their old world is gone.
     */
    const LEGACY_STORAGE_KEY = 'dsh-pixel-ecosystem:v1'
    /**
     * Serialized world format version.
     *
     * 1 = the 0.2.x format (a 0..1 biomass scalar, a single `energy` number per
     * animal and no psychology). 2 = the energy ledger: `body` (reserve,
     * structure, maturity), drives, the behaviour state machine, belief, the
     * climate and the per-cell nutrient / detritus pools (docs/20-CORE-LOOP.md
     * section 5). There is no v1 -> v2 migration: a v2 build reads a v1 save as
     * unsupported and starts a fresh world, which the store must report to the
     * player instead of silently discarding it.
     */
    const SAVE_VERSION = 2
