/**
 * Reproduction mechanism: every species can actually breed.
 *
 * The soak test in balance.test.mjs can only put a species on its "breeding"
 * gate when the window is at least three maturities long. At the default 900 s
 * that is the rabbit alone (maturity 216 s); a wolf needs 1800 s and a bear
 * 3240 s, so for ten of the eleven species that test can only prove "alive at
 * the end". The delivery note ("11 species, none extinct, every one maintained
 * by breeding") therefore rested on one probe run rather than on a gate.
 *
 * This file closes that gap the cheap way: instead of waiting for a multi-year
 * soak it puts ONE adult in breeding condition in front of the real step loop
 * and asserts a litter appears. That proves the mechanism works for every
 * species in the food web — that a stunted, starving or juvenile animal does
 * not breed stays balance.test.mjs's job, and how many animals a world can
 * actually carry stays behaviour-probe's job.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './_harness.mjs'

const { engine } = boot()
const { SPECIES, SPECIES_IDS, createWorld, spawnEntity, canStand, stepWorld, TICK } = engine

/**
 * Put one animal of a species on its own habitat in an empty world.
 * @param {object} world - the world.
 * @param {string} speciesId - which species.
 * @param {object} [options] - forwarded to spawnEntity (e.g. `{ juvenile: true }`).
 * @returns {object} the animal.
 */
function lone(world, speciesId, options = undefined) {
  const species = SPECIES[speciesId]
  for (let y = 2; y < world.height - 2; y += 1) {
    for (let x = 2; x < world.width - 2; x += 1) {
      if (!canStand(world, species, x + 0.5, y + 0.5)) continue
      const animal = spawnEntity(world, speciesId, x + 0.5, y + 0.5, undefined, 1, options)
      if (animal !== undefined && animal !== null) return animal
    }
  }
  throw new Error('could not place a ' + speciesId + ' on its habitat')
}

/** A fresh world with no animals in it. */
function emptyWorld() {
  const world = createWorld({ seed: 606, width: 320, height: 240, immigration: false })
  world.entities.length = 0
  return world
}

/** Make an animal a fed, rested, adult breeder. */
function makeBreeder(animal) {
  const balance = SPECIES[animal.species].balance
  animal.age = balance.maturity
  animal.body.M = 1
  animal.cooldown = 0
  animal.body.E = animal.body.Emax
  animal.children = 0
  return animal
}

test('every species produces a litter once adult, fed and off cooldown', () => {
  const results = []
  for (const id of SPECIES_IDS) {
    const world = emptyWorld()
    const parent = makeBreeder(lone(world, id))
    const before = world.entities.length
    for (let tick = 0; tick < 8; tick += 1) stepWorld(world, TICK)
    results.push({ id, born: parent.children, added: world.entities.length - before })
    assert.ok(parent.children >= 1,
      id + ' never bred as an adult with a full reserve: the species cannot renew itself'
      + ' (stage ' + parent.stage + ', reserve ' + Math.round(parent.body.E) + '/' + Math.round(parent.body.Emax)
      + ', breedEnergy ' + Math.round(SPECIES[id].balance.breedEnergy) + ')')
    assert.equal(world.entities.length - before, parent.children,
      id + ': the litter count and the animals actually added to the world disagree')
    assert.ok(parent.children <= SPECIES[id].balance.litter[1],
      id + ': a litter exceeded the species table maximum')
  }
  // A silent break in one species would otherwise look like "the web thinned
  // out over the year"; print the per-species counts so the probe and this test
  // can be compared directly.
  console.log('litters observed: ' + results.map(row => row.id + ' ' + row.born).join(', '))
})

test('a juvenile does not breed, however well fed', () => {
  const world = emptyWorld()
  const parent = lone(world, 'rabbit', { juvenile: true })
  // A well-fed baby is still a baby: the gate is the life stage, not the reserve.
  parent.body.E = parent.body.Emax
  parent.cooldown = 0
  parent.children = 0
  for (let tick = 0; tick < 8; tick += 1) stepWorld(world, TICK)
  assert.equal(parent.stage, 'juvenile', 'the fixture must actually be a juvenile')
  assert.equal(parent.children, 0, 'a juvenile must not breed')
})

test('an adult without the breeding reserve does not breed', () => {
  const world = emptyWorld()
  const parent = makeBreeder(lone(world, 'rabbit'))
  // Below the litter cost: the ledger forbids breeding on credit.
  parent.body.E = SPECIES.rabbit.balance.breedEnergy * 0.5
  for (let tick = 0; tick < 8; tick += 1) stepWorld(world, TICK)
  assert.equal(parent.children, 0, 'breeding must be paid for out of the parent reserve')
})
