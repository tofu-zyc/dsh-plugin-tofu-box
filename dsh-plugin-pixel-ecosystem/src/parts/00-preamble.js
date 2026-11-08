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

    /** Locale namespace; equals the package name. */
    const NS = 'dsh-plugin-pixel-ecosystem'
    /** Sidebar entry id and `main` panel key. The two must be the same string. */
    const PANEL_ID = 'pixel-ecosystem'
    /** localStorage key for the autosaved world. */
    const STORAGE_KEY = 'dsh-pixel-ecosystem:v1'
    /** Serialized world format version; a mismatch starts a fresh world. */
    const SAVE_VERSION = 1
