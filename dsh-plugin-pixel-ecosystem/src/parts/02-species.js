    // ---------------------------------------------------------------------
    // Species table
    // ---------------------------------------------------------------------
    //
    // habitat  land | water | air      (which terrain the animal can occupy)
    // role     grazer | hunter | scavenger
    // flora    which per-cell biomass field a grazer eats ('grass' | 'weed')
    // prey     species ids a hunter will chase
    // meat     energy a hunter gains, and a scavenger gets a share of
    // cap      per-species population ceiling (stops one species monopolising
    //          the global entity budget; 0 would mean "no local cap")
    // minimum  below this an immigration event refills the species (§4.3)
    // color    chip/legend colour (the sprite has its own palette)
    //
    // `balance` is per species; `genes` are the ranges mutations are clamped to.

    // Field data behind the numbers below (see DESIGN.md §2 for the mapping):
    // - European rabbit: colonies of up to ~30 in warrens, sprint ~45 km/h,
    //   maturity ~3-4 months, litters of 4-12 several times a year, wild
    //   lifespan 1-3 years, crepuscular (dawn/dusk peaks).
    //   https://scottishwildlifetrust.org.uk/species/rabbit-european/
    // - Red fox: sprint ~72 km/h, 1 litter/year of 1-12 (usually 5-6), gestation
    //   ~52 days, maturity ~10 months, wild lifespan ~3-10 years, territorial.
    //   https://www.provancher.org/wp-content/uploads/2026/02/Renard-roux.pdf
    // - Grey wolf: packs of 2-15 (breeding pair + offspring), sprint ~60 km/h but
    //   famously a 10 km/h trotter, 1 litter/year of 4-7 pups, gestation 63 days,
    //   maturity 2-3 years, wild lifespan 6-8 years, territory 100-1000 km2.
    //   https://www.fws.gov/midwest/wolf/aboutwolves/biologueAugust2009.pdf
    // - Northern pike: ambush predator striking at 10-15 ft/s (3-4.6 m/s) rather
    //   than chasing, maturity 2-3 years, lifespan 7-15 years.
    //   https://www.fws.gov/sites/default/files/documents/northern-pike.pdf
    //
    // Time compression: one in-game DAY stands for one ecological YEAR, so a
    // "yearly" litter is a 120 s cooldown and a 3-month maturity is 36 s. Lengths
    // are compressed by SPEED_SCALE (a 45 km/h sprint is 4.4 cells/s, not 12.5)
    // because a 1:1 map would be 300 m across and crossing it would take minutes.
    const SPECIES = {
      rabbit: {
        habitat: 'land', role: 'grazer', flora: 'grass', meat: 18, cap: 400, minimum: 40, color: '#c9a97b',
        territory: { radius: 3, max: 7 },
        herd: { radius: 18, separation: 5, alarmRadius: 15 },
        // Crepuscular: busiest at dawn and dusk, skips the midday heat.
        activity: { dawn: 1, day: 0.45, dusk: 1, night: 0.7 },
        // Bursts, then tires: prey wins the sprint, the predator wins the chase.
        flight: { burst: 1.85, burstSeconds: 1.4, tired: 1.12 },
        genes: {
          speed: [2.6, 4.3], vision: [5, 13], size: [0.75, 1.35],
          metabolism: [0.75, 1.3], lifespan: [140, 240], fertility: [20, 30],
        },
        balance: {
          startEnergy: 58, maxEnergy: 100, drain: 1.0, breedEnergy: 80, breedCost: 20,
          maturity: 36, litter: [4, 7], eatRate: 1.6, floraEnergy: 6,
          fleeSpeed: 1.9, fleeDrain: 0.55,
        },
      },
      deer: {
        habitat: 'land', role: 'grazer', flora: 'grass', browse: true, meat: 45, cap: 260, minimum: 22, color: '#b98a5e',
        territory: { radius: 7, max: 6 },
        herd: { radius: 26, separation: 6, alarmRadius: 20 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.5 },
        flight: { burst: 1.5, burstSeconds: 2.2, tired: 1.15 },
        genes: {
          speed: [2.6, 3.8], vision: [8, 16], size: [1.4, 2.2],
          metabolism: [1.05, 1.5], lifespan: [1100, 1600], fertility: [110, 130],
        },
        balance: {
          startEnergy: 110, maxEnergy: 170, drain: 0.88, breedEnergy: 100, breedCost: 42,
          maturity: 150, litter: [1, 3], eatRate: 2.2, floraEnergy: 9,
          browseRate: 1.6, browseEnergy: 7, fleeSpeed: 1.85, fleeDrain: 0.8,
        },
      },
      fox: {
        habitat: 'land', role: 'hunter', prey: ['rabbit'], meat: 55, cap: 170, minimum: 12, color: '#d2733c',
        territory: { radius: 12, max: 2 },
        activity: { dawn: 1, day: 0.6, dusk: 1, night: 0.9 },
        genes: {
          speed: [3.9, 5.7], vision: [9, 19], size: [0.85, 1.55],
          metabolism: [0.85, 1.35], lifespan: [300, 420], fertility: [110, 130],
        },
        balance: {
          startEnergy: 72, maxEnergy: 130, drain: 0.88, breedEnergy: 92, breedCost: 34,
          maturity: 96, litter: [3, 6], catchRadius: 1.15, huntSpeed: 1.5, scavengeShare: 0.6, meatGain: 3.1,
        },
      },
      wolf: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'rabbit'], meat: 80, cap: 90, minimum: 6, color: '#8a8f99',
        territory: { radius: 19, max: 1 },
        herd: { radius: 20, separation: 3, alarmRadius: 0 },
        activity: { dawn: 1, day: 0.75, dusk: 1, night: 0.85 },
        genes: {
          speed: [4.3, 6.0], vision: [11, 22], size: [1.3, 2.1],
          metabolism: [1.25, 1.9], lifespan: [700, 900], fertility: [110, 130],
        },
        balance: {
          startEnergy: 110, maxEnergy: 200, drain: 1.15, breedEnergy: 126, breedCost: 50,
          maturity: 240, litter: [3, 5], catchRadius: 1.3, huntSpeed: 1.45, scavengeShare: 0.55, meatGain: 2.4,
        },
      },
      crow: {
        habitat: 'air', role: 'scavenger', meat: 20, cap: 220, minimum: 16, color: '#3b3b46',
        herd: { radius: 22, separation: 3.5, alarmRadius: 20 },
        activity: { dawn: 1, day: 1, dusk: 0.9, night: 0.15 },
        genes: {
          speed: [5.2, 7.6], vision: [14, 26], size: [0.8, 1.2],
          metabolism: [0.85, 1.3], lifespan: [500, 700], fertility: [110, 130],
        },
        balance: {
          startEnergy: 40, maxEnergy: 80, drain: 0.5, breedEnergy: 56, breedCost: 14,
          maturity: 200, litter: [3, 5], scavengeRadius: 1.7, corpseShare: 1.5,
        },
      },
      fish: {
        habitat: 'water', role: 'grazer', flora: 'weed', meat: 20, cap: 170, minimum: 40, color: '#5b9fd4',
        territory: { radius: 3, max: 8 },
        herd: { radius: 14, separation: 4, alarmRadius: 10 },
        activity: { dawn: 1, day: 0.9, dusk: 1, night: 0.5 },
        flight: { burst: 1.6, burstSeconds: 0.8, tired: 1.1 },
        genes: {
          speed: [2.2, 4.0], vision: [5, 11], size: [0.7, 1.3],
          metabolism: [0.7, 1.2], lifespan: [420, 560], fertility: [110, 130],
        },
        balance: {
          startEnergy: 40, maxEnergy: 80, drain: 0.68, breedEnergy: 50, breedCost: 10,
          maturity: 90, litter: [6, 10], eatRate: 1.5, floraEnergy: 9,
          fleeSpeed: 1.9, fleeDrain: 0.95,
        },
      },
      pike: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], meat: 60, cap: 70, minimum: 6, color: '#4a6b4a',
        // Ambush: it does not chase across the lake, it waits and then strikes.
        ambush: { approach: 0.45, strikeDistance: 7, strikeSpeed: 1.9, cooldown: 2.5 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [4.4, 6.2], vision: [8, 16], size: [1.1, 1.9],
          metabolism: [0.95, 1.4], lifespan: [1000, 1300], fertility: [110, 130],
        },
        balance: {
          startEnergy: 74, maxEnergy: 130, drain: 0.92, breedEnergy: 76, breedCost: 28,
          maturity: 260, litter: [2, 4], catchRadius: 1.8, huntSpeed: 1.5, scavengeShare: 0.4, meatGain: 2.8,
        },
      },
      // The next four are the land/water bridge. A heron and a bear stand in the
      // shallows and take fish out of the lake; an otter goes the other way and
      // swims after them. That is the cross-habitat link the food web was
      // missing: before them the lake was a closed loop that nothing on land
      // could reach.
      heron: {
        // Wades: can stand in shallow water, which is how it reaches the fish.
        habitat: 'land', role: 'hunter', prey: ['fish', 'frog'], meat: 34, cap: 60, minimum: 6, color: '#9aa4b2',
        wade: true,
        territory: { radius: 14, max: 3 },
        activity: { dawn: 1, day: 0.95, dusk: 1, night: 0.25 },
        genes: {
          speed: [3.2, 5.0], vision: [12, 22], size: [0.9, 1.3],
          metabolism: [0.8, 1.2], lifespan: [420, 620], fertility: [110, 130],
        },
        balance: {
          startEnergy: 62, maxEnergy: 110, drain: 0.72, breedEnergy: 74, breedCost: 24,
          maturity: 150, litter: [2, 4], catchRadius: 2.4, huntSpeed: 1.25, scavengeShare: 0.5, meatGain: 2.5,
        },
      },
      otter: {
        habitat: 'water', role: 'hunter', prey: ['fish', 'frog'], meat: 30, cap: 70, minimum: 7, color: '#7a5238',
        amphibious: true,
        territory: { radius: 12, max: 3 },
        activity: { dawn: 1, day: 0.85, dusk: 1, night: 0.6 },
        genes: {
          speed: [3.6, 5.4], vision: [10, 18], size: [0.9, 1.3],
          metabolism: [0.95, 1.35], lifespan: [380, 560], fertility: [110, 130],
        },
        balance: {
          startEnergy: 70, maxEnergy: 120, drain: 0.84, breedEnergy: 80, breedCost: 22,
          maturity: 130, litter: [2, 4], catchRadius: 1.7, huntSpeed: 1.55, scavengeShare: 0.5, meatGain: 2.4,
        },
      },
      bear: {
        habitat: 'land', role: 'hunter', prey: ['deer', 'fish', 'rabbit'], meat: 120, cap: 40, minimum: 3, color: '#6b4a34',
        wade: true,
        territory: { radius: 26, max: 1 },
        activity: { dawn: 0.9, day: 0.8, dusk: 1, night: 0.7 },
        genes: {
          speed: [3.0, 4.4], vision: [10, 18], size: [1.8, 2.6],
          metabolism: [0.8, 1.15], lifespan: [900, 1300], fertility: [110, 130],
        },
        balance: {
          startEnergy: 170, maxEnergy: 280, drain: 1.0, breedEnergy: 190, breedCost: 72,
          maturity: 300, litter: [1, 2], catchRadius: 2.1, huntSpeed: 1.3, scavengeShare: 0.7, meatGain: 2.2,
        },
      },
      frog: {
        // Grazes the shallow weed, so it is the land/water seam in miniature:
        // water plants feed it, and heron, otter and pike eat it.
        habitat: 'land', role: 'grazer', flora: 'weed', meat: 7, cap: 160, minimum: 26, color: '#6fae4e',
        wade: true,
        territory: { radius: 2, max: 9 },
        herd: { radius: 10, separation: 3, alarmRadius: 8 },
        activity: { dawn: 1, day: 0.8, dusk: 1, night: 0.55 },
        flight: { burst: 2.1, burstSeconds: 0.5, tired: 1.1 },
        genes: {
          speed: [1.4, 2.6], vision: [3, 7], size: [0.55, 0.9],
          metabolism: [0.6, 1.05], lifespan: [150, 260], fertility: [70, 100],
        },
        balance: {
          startEnergy: 18, maxEnergy: 36, drain: 0.42, breedEnergy: 22, breedCost: 5,
          maturity: 45, litter: [8, 14], eatRate: 1.4, floraEnergy: 7,
          fleeSpeed: 2.15, fleeDrain: 0.7,
        },
      },
    }
    /** Species ids in table order (also the legend/chip order). */
    const SPECIES_IDS = Object.keys(SPECIES)

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

    /** Starting population of a fresh world: fuller meadow, fewer predators. */
    const DEFAULT_STOCKS = {
      rabbit: 160, deer: 40, fox: 12, wolf: 5, crow: 20, fish: 120, pike: 12,
      heron: 10, otter: 10, bear: 4, frog: 90,
    }
