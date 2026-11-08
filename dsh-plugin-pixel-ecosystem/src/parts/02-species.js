    // ---------------------------------------------------------------------
    // Species table
    // ---------------------------------------------------------------------
    //
    // habitat  land | water | air      (which terrain the animal can occupy)
    // role     grazer | hunter | scavenger
    // flora    which per-cell biomass field a grazer eats ('grass' | 'weed')
    // prey     species ids a hunter will chase; [] for anything that does not
    //          hunt, so no caller has to guess and no guard has to hide a gap
    // mass     adult body mass, kg WET. This is the single number the whole
    //          energy model hangs off: metabolic rate, reserve capacity, what a
    //          carcass is worth and how big the animal reads on screen all come
    //          from it (see BIO in 01-constants and docs/10-SCALE-AND-UNITS.md).
    // taxon    mammal | bird | ectotherm — picks the field-metabolic-rate curve.
    // cap      per-species population ceiling (stops one species monopolising
    //          the global entity budget; 0 would mean "no local cap")
    // minimum  below this an immigration event refills the species
    // color    chip/legend colour (the sprite has its own palette)
    //
    // `balance` keeps the per-species DESIGN choices (how fast it matures, how
    // many in a litter, how close it must get to bite). Everything that physics
    // dictates — reserve size, breeding reserve, travelling cost — is DERIVED at
    // the bottom of this file and written back into `balance`, so no species row
    // can quietly disagree with the allometry.

    // Field data behind the numbers below (see DESIGN.md §2 for the mapping):
    // - European rabbit: 2 kg, colonies of up to ~30 in warrens, sprint ~45 km/h,
    //   maturity ~3-4 months, litters of 4-12 several times a year, wild
    //   lifespan 1-3 years, crepuscular (dawn/dusk peaks).
    //   https://scottishwildlifetrust.org.uk/species/rabbit-european/
    // - Red fox: 6 kg, sprint ~72 km/h, 1 litter/year of 1-12 (usually 5-6),
    //   gestation ~52 days, maturity ~10 months, wild lifespan ~3-10 years.
    //   https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf
    // - Grey wolf: 40 kg, packs of 2-15, 1 litter/year of 4-7 pups, maturity
    //   2-3 years, wild lifespan 6-8 years, territory 100-1000 km2.
    //   https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf
    // - Red deer stag: 60-200 kg (hinds ~60), maturity 2 years.
    // - Brown bear: 200 kg, maturity 4-6 years.
    // - Northern pike: 4 kg, ambush predator striking at 3-4.6 m/s.
    //   https://www.fws.gov/sites/default/files/documents/northern-pike.pdf
    //
    // Time compression: one in-world DAY is 90 s and one YEAR is 8 days
    // (docs/10-SCALE-AND-UNITS.md), so `history` is authored in YEARS and
    // converted by deriveLifeHistory(); lengths are compressed by SPEED_SCALE
    // (a 45 km/h sprint is 4.4 cells/s).
    const SPECIES = {
      rabbit: {
        habitat: 'land', role: 'grazer', flora: 'grass', prey: [], mass: 2, taxon: 'mammal',
        cap: 700, minimum: 80, color: '#c9a97b',
        territory: { radius: 3, max: 7 },
        herd: { radius: 18, separation: 5, alarmRadius: 15 },
        // Crepuscular: busiest at dawn and dusk, skips the midday heat.
        activity: { dawn: 1, day: 0.45, dusk: 1, night: 0.7 },
        // Bursts, then tires: prey wins the sprint, the predator wins the chase.
        flight: { burst: 1.85, burstSeconds: 1.4, tired: 1.12 },
        genes: {
          speed: [2.6, 4.3], vision: [5, 13], size: [0.75, 1.35],
          metabolism: [0.75, 1.3], lifespan: [140, 240], fertility: [70, 110],
        },
        history: { maturityYears: 0.3, lifespanYears: [1, 3], littersPerYear: 4.5, litterMassShare: 0.08 },
        balance: { litter: [4, 7], fleeSpeed: 1.9 },
      },
      deer: {
        habitat: 'land', role: 'grazer', flora: 'grass', prey: [], browse: true, mass: 60, taxon: 'mammal',
        cap: 200, minimum: 12, color: '#b98a5e',
        territory: { radius: 7, max: 6 },
        herd: { radius: 26, separation: 6, alarmRadius: 20 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.5 },
        flight: { burst: 1.5, burstSeconds: 2.2, tired: 1.15 },
        genes: {
          speed: [2.6, 3.8], vision: [8, 16], size: [1.4, 2.2],
          metabolism: [1.05, 1.5], lifespan: [1100, 1600], fertility: [600, 720],
        },
        history: { maturityYears: 2, lifespanYears: [10, 15], littersPerYear: 1, litterMassShare: 0.05 },
        balance: { litter: [1, 3], fleeSpeed: 1.85 },
      },
      fox: {
        habitat: 'land', role: 'hunter', prey: ['rabbit'], mass: 6, taxon: 'mammal',
        cap: 40, minimum: 2, color: '#d2733c',
        territory: { radius: 12, max: 2 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.9 },
        genes: {
          speed: [3.9, 5.7], vision: [9, 19], size: [0.85, 1.55],
          metabolism: [0.85, 1.35], lifespan: [300, 420], fertility: [600, 720],
        },
        history: { maturityYears: 0.8, lifespanYears: [3, 10], littersPerYear: 1, litterMassShare: 0.08 },
        balance: { litter: [3, 6], catchRadius: 1.15, huntSpeed: 1.5, scavengeShare: 0.6 },
      },
      wolf: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'rabbit'], mass: 40, taxon: 'mammal',
        cap: 20, minimum: 1, color: '#8a8f99',
        territory: { radius: 19, max: 1 },
        herd: { radius: 20, separation: 3, alarmRadius: 0 },
        activity: { dawn: 1, day: 0.75, dusk: 1, night: 0.85 },
        genes: {
          speed: [4.3, 6.0], vision: [11, 22], size: [1.3, 2.1],
          metabolism: [1.25, 1.9], lifespan: [700, 900], fertility: [600, 720],
        },
        history: { maturityYears: 2.5, lifespanYears: [6, 8], littersPerYear: 1, litterMassShare: 0.035 },
        balance: { litter: [3, 5], catchRadius: 1.3, huntSpeed: 1.45, scavengeShare: 0.55 },
      },
      crow: {
        habitat: 'air', role: 'scavenger', prey: [], mass: 0.45, taxon: 'bird',
        cap: 60, minimum: 4, color: '#3b3b46',
        herd: { radius: 22, separation: 3.5, alarmRadius: 20 },
        activity: { dawn: 1, day: 1, dusk: 0.9, night: 0.15 },
        genes: {
          speed: [5.2, 7.6], vision: [14, 26], size: [0.8, 1.2],
          metabolism: [0.85, 1.3], lifespan: [500, 700], fertility: [360, 600],
        },
        history: { maturityYears: 1, lifespanYears: [4, 8], littersPerYear: 1, litterMassShare: 0.12 },
        // A crow is a bird: it finds carrion from the air, not by brushing past it.
      // At 1.7 cells it lost every carcass to the fox before it arrived, and the
      // scavenger guild sat permanently below its own breeding reserve.
      balance: { litter: [3, 5], scavengeRadius: 4.0, corpseShare: 0.8 },
      },
      fish: {
        habitat: 'water', role: 'grazer', flora: 'weed', prey: [], mass: 1.2, taxon: 'ectotherm',
        cap: 170, minimum: 40, color: '#5b9fd4',
        territory: { radius: 3, max: 8 },
        herd: { radius: 14, separation: 4, alarmRadius: 10 },
        activity: { dawn: 1, day: 0.9, dusk: 1, night: 0.5 },
        flight: { burst: 1.6, burstSeconds: 0.8, tired: 1.1 },
        genes: {
          speed: [2.2, 4.0], vision: [5, 11], size: [0.7, 1.3],
          metabolism: [0.7, 1.2], lifespan: [420, 560], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 10], littersPerYear: 1, litterMassShare: 0.01 },
        balance: { litter: [6, 10], fleeSpeed: 1.9 },
      },
      pike: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], mass: 4.5, taxon: 'ectotherm',
        cap: 20, minimum: 2, color: '#4a6b4a',
        // Ambush: it does not chase across the lake, it waits and then strikes.
        ambush: { approach: 0.45, strikeDistance: 7, strikeSpeed: 1.9, cooldown: 2.5 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [4.4, 6.2], vision: [8, 16], size: [1.1, 1.9],
          metabolism: [0.95, 1.4], lifespan: [1000, 1300], fertility: [600, 720],
        },
        history: { maturityYears: 2.5, lifespanYears: [7, 15], littersPerYear: 1, litterMassShare: 0.0133 },
        balance: { litter: [2, 4], catchRadius: 1.8, huntSpeed: 1.5, scavengeShare: 0.4 },
      },
      // The next four are the land/water bridge. A heron and a bear stand in the
      // shallows and take fish out of the lake; an otter goes the other way and
      // swims after them. That is the cross-habitat link the food web was
      // missing: before them the lake was a closed loop that nothing on land
      // could reach.
      heron: {
        // Wades: can stand in shallow water, which is how it reaches the fish.
        habitat: 'land', role: 'hunter', prey: ['fish', 'frog'], mass: 1.6, taxon: 'bird',
        cap: 20, minimum: 2, color: '#9aa4b2',
        wade: true,
        territory: { radius: 14, max: 3 },
        activity: { dawn: 1, day: 0.95, dusk: 1, night: 0.25 },
        genes: {
          speed: [3.2, 5.0], vision: [12, 22], size: [0.9, 1.3],
          metabolism: [0.8, 1.2], lifespan: [420, 620], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 8], littersPerYear: 1, litterMassShare: 0.075 },
        balance: { litter: [2, 4], catchRadius: 2.4, huntSpeed: 1.25, scavengeShare: 0.5 },
      },
      otter: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], mass: 8, taxon: 'mammal',
        cap: 20, minimum: 2, color: '#7a5238',
        amphibious: true,
        territory: { radius: 12, max: 3 },
        activity: { dawn: 1, day: 0.85, dusk: 1, night: 0.6 },
        genes: {
          speed: [3.6, 5.4], vision: [10, 18], size: [0.9, 1.3],
          metabolism: [0.95, 1.35], lifespan: [380, 560], fertility: [500, 700],
        },
        history: { maturityYears: 1.5, lifespanYears: [5, 8], littersPerYear: 1, litterMassShare: 0.056 },
        balance: { litter: [2, 4], catchRadius: 1.7, huntSpeed: 1.55, scavengeShare: 0.5 },
      },
      bear: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'fish', 'rabbit'], mass: 200, taxon: 'mammal',
        cap: 8, minimum: 1, color: '#6b4a34',
        wade: true,
        territory: { radius: 26, max: 1 },
        activity: { dawn: 0.9, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [3.0, 4.4], vision: [10, 18], size: [1.8, 2.6],
          metabolism: [0.8, 1.15], lifespan: [900, 1300], fertility: [1200, 1440],
        },
        history: { maturityYears: 4.5, lifespanYears: [20, 25], littersPerYear: 0.4, litterMassShare: 0.004 },
        balance: { litter: [1, 2], catchRadius: 2.1, huntSpeed: 1.3, scavengeShare: 0.7 },
      },
      frog: {
        // Grazes the shallow weed, so it is the land/water seam in miniature:
        // water plants feed it, and heron, otter and pike eat it.
        habitat: 'land', role: 'grazer', flora: 'weed', prey: [], mass: 0.022, taxon: 'ectotherm',
        cap: 160, minimum: 26, color: '#6fae4e',
        wade: true,
        territory: { radius: 2, max: 9 },
        herd: { radius: 10, separation: 3, alarmRadius: 8 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.55 },
        flight: { burst: 2.1, burstSeconds: 0.5, tired: 1.1 },
        genes: {
          speed: [1.4, 2.6], vision: [3, 7], size: [0.55, 0.9],
          metabolism: [0.6, 1.05], lifespan: [150, 260], fertility: [500, 700],
        },
        history: { maturityYears: 1, lifespanYears: [3, 5], littersPerYear: 1, litterMassShare: 0.03 },
        balance: { litter: [8, 14], fleeSpeed: 2.15 },
      },
    }
    /** Species ids in table order (also the legend/chip order). */
    const SPECIES_IDS = Object.keys(SPECIES)

    /**
     * Derive every life-history number from the YEAR, and write it back.
     *
     * The species table authors maturity, lifespan and litter spacing in
     * ECOLOGICAL YEARS, which is the only unit that survives a change to
     * DAY_SECONDS or YEAR_DAYS. 0.2.x hard-coded seconds, and when the year went
     * from one day to eight the rabbit kept a 36-second maturity while its
     * lifespan stayed under three game-days — it physically could not live long
     * enough to breed. Nothing below may be typed as a number of seconds again:
     *
     *   maturity  = maturityYears x YEAR_SECONDS
     *   lifespan  = lifespanYears x YEAR_SECONDS
     *   cooldown  = YEAR_SECONDS / littersPerYear   (+/- 15% gene spread)
     *   elderAt   = 80% of the mean lifespan (senescence, not half a life)
     */
    function deriveLifeHistory() {
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const history = species.history
        if (history === undefined) continue
        const balance = species.balance ?? (species.balance = {})
        balance.maturity = history.maturityYears * YEAR_SECONDS
        const meanLifespan = (history.lifespanYears[0] + history.lifespanYears[1]) / 2
        balance.elderAt = 0.8 * meanLifespan * YEAR_SECONDS
        const genes = species.genes ?? (species.genes = {})
        genes.lifespan = [
          history.lifespanYears[0] * YEAR_SECONDS,
          history.lifespanYears[1] * YEAR_SECONDS,
        ]
        const cooldown = YEAR_SECONDS / Math.max(0.05, history.littersPerYear)
        genes.fertility = [Math.round(cooldown * 0.85), Math.round(cooldown * 1.15)]
      }
    }

    /**
     * Derive every number physics dictates and write it back into `balance`.
     *
     * This is the "compute the numbers, do not tune them" rule in code: reserve
     * capacity is five days of the animal's own field metabolic rate, an adult
     * starts at 70% of it, breeding costs a fixed share of it, and the carcass
     * energy an old feeding path may read is the animal's edible mass. A species
     * row can no longer carry a hand-picked energy number that contradicts its
     * own body mass.
     */
    function deriveSpeciesEnergy() {
      for (const id of SPECIES_IDS) {
        const species = SPECIES[id]
        const balance = species.balance ?? (species.balance = {})
        const capacity = reserveCapacity(species, adultMassOf(species))
        balance.maxEnergy = capacity
        balance.startEnergy = capacity * SPAWN_RESERVE_SHARE
        // --- what a litter actually costs ------------------------------------
        // A newborn is not free: it is tissue plus a reserve, and the parent has
        // to pay for both out of its own body, at a conversion efficiency below
        // 1 (the rest leaves as heat and is real respiration). Dividing the
        // litter's total wet mass by the litter size gives one newborn's mass,
        // so a rabbit kit is 43 g and a wolf pup is 350 g without either number
        // being typed anywhere.
        const history = species.history
        const litterMax = Math.max(1, balance.litter?.[1] ?? 1)
        const litterMass = adultMassOf(species) * (history?.litterMassShare ?? 0.05)
        const birthMass = litterMass / litterMax
        const birthReserve = reserveCapacity(species, birthMass) * BIRTH_RESERVE_SHARE
        balance.birthMass = birthMass
        /** What one whole litter costs the parent, kJ: tissue plus the kits' reserves. */
        balance.litterCost = (litterMass * BIO.MEAT_ENERGY + litterMax * birthReserve)
          / BIO.REPRODUCTION_EFFICIENCY
        // A species may only breed when its reserve covers the whole litter, so
        // the ledger never has to invent the difference.
        balance.breedEnergy = Math.min(capacity * 0.97, balance.litterCost * 1.02)
        // The litter is now charged per newborn inside spawnEntity(), out of the
        // parent's real reserve. This legacy field has to stay ZERO or the parent
        // would be billed twice for the same litter.
        balance.breedCost = 0
        // The reserve is spent inside metabolise() and nowhere else. These two
        // keys stay because other layers read them; they must stay zero or the
        // animal would be charged twice for standing still.
        balance.drain = 0
        balance.fleeDrain = 0
        // Assimilation efficiency of the diet, used by consume().
        balance.assimilation = species.role === 'grazer'
          ? BIO.ASSIMILATION_HERBIVORE
          : BIO.ASSIMILATION_CARNIVORE
        // Carcass energy of an adult, kJ. The legacy death path in 08 reads
        // `species.meat`; deriving it keeps that path in the same unit.
        species.meat = adultMassOf(species) * BIO.MEAT_FRACTION * BIO.MEAT_ENERGY
        // kJ per kg of dry matter the plant field holds (docs/10 §2): the panel
        // converts a biomass sum into energy with it, and it must not be a
        // second hand-tuned constant.
        if (species.flora === 'grass' || species.flora === 'weed') {
          balance.floraEnergy = BIO.GRASS_ENERGY
        }
      }
    }

    /** Per species: the set of hunter species that eat it. */
    const PREDATORS_OF = {}
    /** Per species: the set of species it hunts. */
    const PREY_OF = {}
    for (const id of SPECIES_IDS) {
      PREDATORS_OF[id] = new Set()
      PREY_OF[id] = new Set(SPECIES[id].prey ?? [])
    }
    for (const hunterId of SPECIES_IDS) {
      for (const preyId of PREY_OF[hunterId]) PREDATORS_OF[preyId].add(hunterId)
    }

    /**
     * Starting population of a fresh world, sized by the energy budget rather
     * than by what looked good in 0.2.x.
     *
     * A predator can only eat what its prey PRODUCE in a year, and terrestrial
     * production is roughly 1-5% of prey biomass per year, so the predator tier
     * has to be a small fraction of the prey tier. The old cast (12 foxes, 5
     * wolves, 4 bears on the same meadow) put predator biomass at ~45% of prey
     * biomass and demanded ~8x the prey's annual production: every predator
     * starved (measured: 98.9% of predator deaths were starvation). This cast
     * sits near the measured carrying capacity (tools/calibrate.mjs).
     */
    const DEFAULT_STOCKS = {
      rabbit: 320, deer: 40, fox: 4, wolf: 2, crow: 10, fish: 120, pike: 4,
      heron: 4, otter: 4, bear: 1, frog: 90,
    }
