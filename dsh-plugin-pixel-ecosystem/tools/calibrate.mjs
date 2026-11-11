/**
 * Energy-budget calculator for the terrarium (design tool, not part of the sim).
 *
 * Answers the question that blocks P1: given a map size and a wanted cast, does
 * the world's primary production pay for it, and how much predator is even
 * physically possible?
 *
 *   node tools/calibrate.mjs                 # the three candidate scenarios
 *   node tools/calibrate.mjs --cells 1024x640 --cell-m 2 --harvest 0.05
 *
 * Allometry: field metabolic rate, Nagy et al. 1999 (doubly labelled water):
 *   eutherian mammals  FMR(kJ/day) = 4.82 * M(g)^0.734
 *   birds              FMR(kJ/day) = 10.5 * M(g)^0.681
 *   ectotherms (fish, amphibians, most reptiles) run roughly an order of
 *   magnitude below endotherms; ECTOTHERM_FACTOR is that crude ratio.
 */

const DEFAULTS = { cells: [1024, 640], cellM: 2, anpp: 0.5, mjPerKg: 17.5, harvest: 0.05 }

/** kg, thermoregulation kind, annual biomass turnover (production / standing). */
const SPECIES = {
  rabbit: { kg: 2.0, kind: 'mammal', turnover: 3.0, diet: 'plant' },
  deer: { kg: 60, kind: 'mammal', turnover: 0.35, diet: 'plant' },
  frog: { kg: 0.03, kind: 'ectotherm', turnover: 2.0, diet: 'plant' },
  fish: { kg: 0.15, kind: 'ectotherm', turnover: 2.0, diet: 'plant' },
  crow: { kg: 0.4, kind: 'bird', turnover: 0.8, diet: 'meat' },
  fox: { kg: 5, kind: 'mammal', turnover: 0.6, diet: 'meat' },
  heron: { kg: 1.3, kind: 'bird', turnover: 0.5, diet: 'meat' },
  otter: { kg: 9, kind: 'mammal', turnover: 0.5, diet: 'meat' },
  pike: { kg: 5, kind: 'ectotherm', turnover: 0.3, diet: 'meat' },
  wolf: { kg: 40, kind: 'mammal', turnover: 0.3, diet: 'meat' },
  bear: { kg: 200, kind: 'mammal', turnover: 0.15, diet: 'meat' },
}

const ECTOTHERM_FACTOR = 0.12
const ASSIMILATION = { herbivore: 0.40, carnivore: 0.80 }
const TISSUE_MJ_PER_KG = 7.0          // wet animal tissue
const ORDERS = ['rabbit', 'deer', 'frog', 'fish', 'crow', 'fox', 'heron', 'otter', 'pike', 'wolf', 'bear']

function fmrKjPerDay(kg, kind) {
  const g = kg * 1000
  if (kind === 'bird') return 10.5 * Math.pow(g, 0.681)
  const mammal = 4.82 * Math.pow(g, 0.734)
  return kind === 'ectotherm' ? mammal * ECTOTHERM_FACTOR : mammal
}

function analyse(cast, opt) {
  const predatorFactor = opt.predatorFactor ?? 1
  const [w, h] = opt.cells
  const areaM2 = w * h * opt.cellM * opt.cellM
  const anppEnergyGJ = areaM2 * opt.anpp * opt.mjPerKg / 1000
  const supplyGJ = anppEnergyGJ * opt.harvest

  let herbDemand = 0, carnDemand = 0, herbBiomass = 0, carnBiomass = 0
  let preyProductionGJ = 0
  const rows = []
  for (const id of ORDERS) {
    const n = cast[id] ?? 0
    if (n === 0) continue
    const s = SPECIES[id]
    const base = fmrKjPerDay(s.kg, s.kind)
    const gj = (s.diet === 'plant' ? base : base * predatorFactor) * 365 / 1e6
    const biomass = n * s.kg
    const plantEater = s.diet === 'plant'
    if (plantEater) { herbDemand += gj * n; herbBiomass += biomass }
    else { carnDemand += gj * n; carnBiomass += biomass }
    rows.push({ id, n, kg: s.kg, kjDay: fmrKjPerDay(s.kg, s.kind), gjEach: gj, gjTotal: gj * n, biomass })
  }
  // Secondary production: the only thing predators can actually eat over a year.
  for (const id of ORDERS) {
    const s = SPECIES[id]
    if (s.diet !== 'plant') continue
    preyProductionGJ += (cast[id] ?? 0) * s.kg * s.turnover * TISSUE_MJ_PER_KG / 1000
  }
  const intakeGJ = herbDemand / ASSIMILATION.herbivore
  return {
    areaM2, anppEnergyGJ, supplyGJ, rows,
    herbDemand, carnDemand, herbBiomass, carnBiomass, preyProductionGJ, intakeGJ,
    harvestShare: intakeGJ / anppEnergyGJ,
    kappa: intakeGJ / supplyGJ,
    predatorRatio: carnBiomass / Math.max(1e-9, herbBiomass),
    carnPerPreyProduction: carnDemand / Math.max(1e-9, preyProductionGJ),
  }
}

const g = (x, d = 1) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
function report(title, cast, opt) {
  const a = analyse(cast, opt)
  console.log('\n=== ' + title + ' ===')
  console.log('map ' + opt.cells.join('x') + ' cells @ ' + opt.cellM + ' m = ' + g(a.areaM2 / 10000) + ' ha')
  console.log('ANPP ' + g(a.anppEnergyGJ) + ' GJ/yr  |  harvestable @' + (opt.harvest * 100) + '% = ' + g(a.supplyGJ) + ' GJ/yr')
  console.log('species      n    kg    kJ/day     GJ/yr each   GJ/yr total')
  for (const r of a.rows) console.log('  ' + r.id.padEnd(9) + String(r.n).padStart(5) + String(r.kg).padStart(6) + g(r.kjDay, 0).padStart(9) + g(r.gjEach, 2).padStart(12) + g(r.gjTotal, 1).padStart(13))
  console.log('  herbivore demand ' + g(a.herbDemand) + ' GJ/yr -> plant intake ' + g(a.intakeGJ) + ' GJ/yr = ' + g(100 * a.harvestShare) + '% of ANPP')
  console.log('  predator  demand ' + g(a.carnDemand) + ' GJ/yr')
  console.log('  predator biomass : prey biomass = ' + g(100 * a.predatorRatio) + '%   (nature: 1-5%)')
  console.log('  prey secondary production ' + g(a.preyProductionGJ) + ' GJ/yr -> predators want ' + g(a.carnPerPreyProduction) + 'x that')
  console.log('  => PRODUCTIVITY kappa needed to close the plant budget: ' + a.kappa.toFixed(2))
  const ok = a.carnPerPreyProduction <= 1.2
  console.log('  => predator tier is ' + (ok ? 'SUPPORTABLE' : 'OVER BUDGET by ' + g(a.carnPerPreyProduction) + 'x'))
  return a
}

const args = process.argv.slice(2)
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt }
const opt = {
  cells: (() => { const i = args.indexOf('--cells'); const v = i >= 0 ? args[i + 1] : null; return v ? v.split('x').map(Number) : DEFAULTS.cells })(),
  cellM: num('--cell-m', DEFAULTS.cellM),
  anpp: num('--anpp', DEFAULTS.anpp),
  mjPerKg: DEFAULTS.mjPerKg,
  harvest: num('--harvest', DEFAULTS.harvest),
}

// A: realistic densities scaled to the bigger map (predators at the 1-5% rule).
const A = { rabbit: 640, deer: 160, frog: 360, fish: 480, crow: 8, fox: 4, heron: 4, otter: 4, pike: 4, wolf: 1, bear: 1 }
// B: the 0.2.x cast scaled 4x with the map - predator density stays absurd.
const B = { rabbit: 640, deer: 160, frog: 360, fish: 480, crow: 80, fox: 48, heron: 40, otter: 40, pike: 48, wolf: 32, bear: 16 }
// C: B, but predators run at an ectotherm-like budget (game abstraction).
const C = { ...B }
report('A · realistic densities (predators cut to the 1-5% rule)', A, opt)
report('B · 0.2.x predators scaled 4x with the map', B, opt)
report('C · same cast as B, predator metabolism x0.12 (game abstraction)', C, { ...opt, predatorFactor: 0.12 })
console.log('\nnote: C is what "keep the old predator numbers" actually costs in fiction; A is what the physics allows.')
