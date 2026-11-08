
import { boot } from './_harness.mjs'
const { engine } = boot()
const store = engine.createStore({ storage: null, requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 })
store.ensureWorld()
const world = store.getWorld()
let last = null
for (let step = 0; step < 900; step++) {
  engine.stepWorld(world, engine.TICK)
  if (step % 10 === 0) { store.setPaused(false); last = store.getSnapshot() }
}
console.log('time', world.time.toFixed(1), 'counts', JSON.stringify(last.stats.counts))
console.log('events', last.events.length)
for (const e of last.events.slice(0, 8)) console.log('  ', e.kind, e.species, 'x' + e.count, '@', e.x, e.y)
console.log('pulse', JSON.stringify(last.pulse))
console.log('flows', JSON.stringify(last.flows))
console.log('plants', JSON.stringify({grass: +last.plants.grass.toFixed(3), weed: +last.plants.weed.toFixed(3), energy: Math.round(last.plants.energy)}))
console.log('climate', JSON.stringify(last.climate))
const dead = last.species.filter(s => s.dead > 0)
console.log('deaths', JSON.stringify(dead.map(s => [s.id, s.dead, s.deaths])))
console.log('budget', JSON.stringify(last.species.map(s => [s.id, s.count, +(s.meanRatio*100).toFixed(0), Math.round(s.respire), Math.round(s.intake)])))
const target = world.entities.find(e => e.decision && e.state)
store.selectAt(target.x, target.y)
const sel = store.getSnapshot().selected
console.log('selected', JSON.stringify({id: sel.id, why: sel.reason, state: sel.state, plan: sel.plan, cause: sel.cause, decisionAge: sel.decisionAge && Math.round(sel.decisionAge), goal: sel.goal && {x: Math.round(sel.goal.x), y: Math.round(sel.goal.y), d: +sel.goal.distance.toFixed(1)}}))
store.dispose()
