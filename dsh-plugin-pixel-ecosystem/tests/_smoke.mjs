
import { boot } from './_harness.mjs'
const { engine } = boot()
const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
store.ensureWorld()
const world = store.getWorld()
let snap = store.getSnapshot()
for (let step = 0; step < 600; step++) {
  engine.stepWorld(world, engine.TICK)
  if (step % 10 === 9) { store.setPaused(false); snap = store.getSnapshot() }
}
console.log('world', world.width + 'x' + world.height, 'time', world.time.toFixed(1), 'day', snap.stats.day)
console.log('counts', JSON.stringify(snap.stats.counts))
console.log('pulse', JSON.stringify(snap.pulse), 'events', snap.events.length)
const byKind = {}
for (const e of snap.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
console.log('events by kind', JSON.stringify(byKind))
console.log('causeSource', JSON.stringify(snap.causeSource))
const dead = snap.species.filter(s => s.dead > 0)
console.log('deaths', JSON.stringify(dead.map(s => [s.id, s.dead, s.deaths])))
console.log('flows kJ/day', JSON.stringify({gpp: Math.round(snap.flows.gpp), herbs: Math.round(snap.flows.herbs), carns: Math.round(snap.flows.carns), respire: Math.round(snap.flows.respire), plantStock: Math.round(snap.flows.plantStock), animalStock: Math.round(snap.flows.animalStock)}))
console.log('plants', JSON.stringify({grass: +snap.plants.grass.toFixed(3), weed: +snap.plants.weed.toFixed(3)}))
console.log('budget sample', JSON.stringify(snap.species.slice(0,3).map(s => [s.id, s.count, +(s.meanRatio*100).toFixed(0), Math.round(s.intake), Math.round(s.respire)])))
console.log('climate', JSON.stringify({t: Math.round(snap.climate.temperature), sun: +snap.climate.sunlight.toFixed(2)}))
const target = world.entities.find(e => e.decision && e.state) ?? world.entities[0]
store.selectAt(target.x, target.y)
const sel = store.getSnapshot().selected
console.log('inspector', JSON.stringify({species: sel.species, E: Math.round(sel.energy), Emax: Math.round(sel.maxEnergy), drivesDerived: sel.drivesDerived, drives: Object.fromEntries(Object.entries(sel.drives).map(([k,v]) => [k, +v.toFixed(2)])), state: sel.state, reason: {derived: sel.reason.derived, why: sel.reason.why, picked: sel.reason.picked, rivals: sel.reason.rivals.length}, cause: sel.cause, threats: sel.threats, body: {unit: sel.body.structureUnit, derived: sel.body.derived}}))
store.dispose()
