/**
 * Host half of the Pixel Terrarium plugin.
 *
 * The game runs entirely in the browser: the simulation, the canvas renderer
 * and the panel UI all live in `client.js`, and world state is persisted in
 * `localStorage`. So the Host half owns no service, no projection, no tool and
 * no timer — it exists only so the bundle has a place to hang its patch row and
 * so the Plugin Manager can show the row as an installed, healthy plugin.
 *
 * Registering anything here would buy nothing: a browser-side rAF loop cannot
 * be driven from the Host, and the world must not be folded into the Session log
 * (game state is not conversation truth).
 *
 * @module dsh-plugin-pixel-ecosystem
 */

/** Loader-visible plugin name. */
export const name = 'dsh-plugin-pixel-ecosystem'

/** Nothing to register; the Client half owns every behaviour. */
export function apply() {}
