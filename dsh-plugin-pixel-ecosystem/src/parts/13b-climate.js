/**
 * Climate: sun angle, season phase, temperature.
 *
 * OWNER: sim-core
 * stepClimate(world, dt) writes world.climate: { t, dayPhase, yearPhase, temperature, sunlight }.
 * Everything that depends on time of day, season or temperature reads from here;
 * no other system may re-derive daylight.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */
