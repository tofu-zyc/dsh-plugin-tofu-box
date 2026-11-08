/**
 * Perception and belief: what an animal currently knows about its world.
 *
 * OWNER: behaviour
 * Scans the real neighbourhood (not random sampling) on a staggered ~1 Hz
 * schedule and writes belief entries with timestamps so they can go stale:
 *   belief.food   { x, y, t, value }
 *   belief.threat { x, y, t, predator }
 *   belief.water  { x, y, t }
 *   belief.home   { x, y }
 *   belief.caches [{ x, y, t }]
 * Contract: docs/20-CORE-LOOP.md section 2.3.
 *
 * Not implemented yet: this part exists so the owner has a stable file to fill
 * without editing src/manifest.json (Lead owns that file).
 */
