/**
 * Execution: the state machine that turns a goal into timed action.
 *
 * OWNER: behaviour
 * States have a duration and a completion condition; decide() is only called at
 * state boundaries or on an interrupt. Interrupt priority:
 *   flee > survive (drink/warm) > opportunity (hunt/forage) > intrinsic (play/socialize)
 * Contract: docs/20-CORE-LOOP.md section 2.3.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */
