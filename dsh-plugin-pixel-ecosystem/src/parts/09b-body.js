/**
 * The body: reserve, structure, maturity, health, fatigue, metabolism.
 *
 * OWNER: sim-core
 * Implements the DEB-lite equations in docs/20-CORE-LOOP.md section 4:
 *   metabolise(entity, dt)  -> consumes/produces body.E, body.V, body.M
 *   applyDamage(entity, amount, cause)
 * This is the single energy ledger. Nothing else may write body.E.
 *
 * Why it exists: 0.2.x kept TWO books per animal — `entity.energy` for the
 * feeding code and `needs.hunger` for the decision code — and `decide()` never
 * read the first one. An animal could therefore stand on a lawn with an empty
 * reserve and a flat hunger channel until it died "of old age". Here the reserve
 * is the only state, and every other number a decision or a panel wants
 * (hunger, fatness, condition) is DERIVED from it by a getter, so the two books
 * cannot drift apart again.
 */
    // ---------------------------------------------------------------------
    // Body ledger
    // ---------------------------------------------------------------------

    /** Fraction of adult mass a newborn starts with. */
    const BIRTH_MASS_SHARE = 0.35
    /** Reserve at birth, as a share of the newborn capacity. */
    const BIRTH_RESERVE_SHARE = 0.4
    /** Reserve an adult is spawned with, as a share of capacity. */
    const SPAWN_RESERVE_SHARE = 0.7
    /** Peak tissue growth, as a multiple of the body's own maintenance power. */
    const GROWTH_RATE_CEILING = 4
    /** Reserve share below which a juvenile stops growing (it is starving). */
    const GROWTH_RESERVE_FLOOR = 0.3
    /** How fast a predator strips a carcass, as a multiple of its own upkeep. */
    const HANDLING_RATE = 2.5
    /**
     * Cumulative kJ written straight into a reserve by the legacy `energy`
     * accessor. The ledger does not spend it, so the audit counts it as energy
     * entering the system rather than pretending it was always there.
     */
    let directReserveDeposits = 0
    /**
     * Cumulative kJ a legacy assignment took OUT of a reserve without naming a
     * sink (breeding spends `balance.breedCost` this way). Counted as a drain so
     * the audit stays closed instead of reporting a phantom leak.
     */
    let directReserveWithdrawals = 0
    /**
     * Non-zero while the ledger itself is moving the reserve. Writes made at
     * depth 0 are somebody else's, and get counted; writes made inside
     * metabolise() are already on the books as respiration, growth or overflow.
     */
    let ledgerWriteDepth = 0

    /** Taxon → [allometric coefficient, exponent] for field metabolic rate. */
    const FMR_TABLE = {
      mammal: [BIO.FMR_MAMMAL_A, BIO.FMR_MAMMAL_B],
      bird: [BIO.FMR_BIRD_A, BIO.FMR_BIRD_B],
      ectotherm: [BIO.FMR_ECTO_A, BIO.FMR_ECTO_B],
    }

    /**
     * Field metabolic rate of a body, in kJ per in-world day (Nagy et al. 1999).
     * @param {object} species - species row (needs `taxon`).
     * @param {number} volume - body mass in kg wet.
     * @returns {number} maintenance power, kJ/day.
     */
    function fieldMetabolicRate(species, volume) {
      const row = FMR_TABLE[species?.taxon ?? 'mammal'] ?? FMR_TABLE.mammal
      const grams = Math.max(1, volume * 1000)
      return row[0] * Math.pow(grams, row[1])
    }

    /**
     * Reserve capacity of a body: RESERVE_DAYS days of its own metabolic rate.
     * A 2 kg rabbit therefore carries ~6 400 kJ, which is roughly its fat mass.
     * @param {object} species - species row.
     * @param {number} volume - body mass in kg wet.
     * @returns {number} capacity in kJ.
     */
    function reserveCapacity(species, volume) {
      return BIO.RESERVE_DAYS * fieldMetabolicRate(species, volume)
    }

    /**
     * Adult body mass a species matures into, in kg wet.
     * @param {object} species - species row.
     * @returns {number} kg.
     */
    function adultMassOf(species) {
      return species?.mass ?? 1
    }

    /**
     * Cold tolerance derived from body size, not from a per-species knob:
     * small bodies lose heat faster, so the lethal temperature rises with the
     * surface-to-volume ratio (Bergmann's rule as a formula).
     * @param {object} body - body record.
     * @param {object} species - species row.
     * @returns {number} temperature in degrees C below which the body suffers.
     */
    function coldLimitOf(body, species) {
      const mass = Math.max(0.005, body.V)
      const span = species?.habitat === 'water' ? 4 : 8
      const base = species?.habitat === 'water' ? 2 : -6
      return base - span * Math.pow(mass, 0.25)
    }

    /**
     * Create the ledger for an animal and wire the derived views onto it.
     *
     * Installs two compatibility bridges so legacy code keeps one book:
     *  - `entity.energy` becomes an accessor over `body.E` (kJ), because the
     *    renderer, the inspector and the breeding code all read it.
     *  - `entity.needs.hunger` becomes a getter over `1 - E/Emax`, because the
     *    decision system reads it and must never be able to disagree with the
     *    reserve. Writes to it are ignored on purpose.
     * @param {object} entity - the animal.
     * @returns {object} its body record.
     */
    function installLedger(entity) {
      if (entity.body !== undefined) return entity.body
      const species = SPECIES[entity.species] ?? { taxon: 'mammal', mass: 1 }
      const adult = adultMassOf(species)
      const maturity = Math.max(1, species.balance?.maturity ?? 60)
      const phase = clamp((entity.age ?? 0) / maturity, 0, 1)
      const volume = adult * BIRTH_MASS_SHARE + (adult - adult * BIRTH_MASS_SHARE) * phase
      const body = {
        /** Reserve capacity, kJ: grows with the structure. */
        Emax: reserveCapacity(species, volume),
        /** Structure, kg wet. Sets metabolism, strength and what a carcass is worth. */
        V: volume,
        /** Maturity 0..1; 1 means adult. */
        M: phase,
        /** 0..1 condition. Zero kills. */
        health: 1,
        /** 0..1 fatigue; accumulated by running, cleared by resting. */
        fatigue: 0,
        /** Terminal flag; the entity list drops the animal on the same tick. */
        dead: false,
        /** Why it died: starved | frozen | predation | old | disease | injury. */
        cause: '',
        /** Assimilated energy waiting to enter the reserve (previous tick's meal). */
        gut: 0,
        /** Injury timer in days; while > 0 health drains. */
        injury: 0,
        /** Maintenance power used by the last metabolise call, kJ/day. */
        pMetabolism: 0,
        /** Last activity multiplier, for the inspector. */
        activity: 1,
        /** Handling state while eating a kill: { energy, left } in kJ / seconds. */
        handling: null,
      }
      // The reserve itself lives in a closure cell behind an accessor. Any code
      // in the bundle — including a part sim-core does not own — can therefore
      // still write `body.E`, but it cannot do so without being counted. That is
      // what keeps "one ledger" true even while the rest of the engine migrates.
      let reserve = 0
      Object.defineProperty(body, 'E', {
        configurable: true,
        enumerable: true,
        get() { return reserve },
        set(value) {
          const next = Number.isFinite(value) ? clamp(value, 0, body.Emax) : 0
          if (ledgerWriteDepth === 0) {
            if (next > reserve) directReserveDeposits += next - reserve
            else if (next < reserve) directReserveWithdrawals += reserve - next
          }
          reserve = next
        },
      })
      // Seeding goes through the accessor on purpose: the reserve a body comes
      // into existence with is energy entering the world, and the audit has to
      // see it (callers restoring a save mute the ledger first).
      body.E = Number.isFinite(entity.energy) ? entity.energy : body.Emax * SPAWN_RESERVE_SHARE
      entity.body = body
      Object.defineProperty(entity, 'energy', {
        configurable: true,
        enumerable: false,
        get() { return body.E },
        set(value) {
          // Compatibility write (renderer, inspector, breeding code). It goes
          // through the ledger's own accessor, so it is clamped and counted.
          body.E = value
        },
      })
      // The need channels belong to the behaviour layer, but hunger is not a
      // channel: it IS the reserve, seen from the other end.
      const needs = entity.needs ?? { hunger: 0, thirst: 0.28, energy: 0.15, safety: 0, social: 0.3 }
      Object.defineProperty(needs, 'hunger', {
        configurable: true,
        enumerable: true,
        get() { return clamp(1 - body.E / (body.Emax || 1), 0, 1) },
        set() { /* derived view: writing it must not create a second book */ },
      })
      entity.needs = needs
      return body
    }

    /**
     * The body record of an animal, created on first use (old saves, newborns).
     * @param {object} entity - the animal.
     * @returns {object} body.
     */
    function bodyOf(entity) {
      return entity.body ?? installLedger(entity)
    }

    /**
     * How hard the body is working, as a multiplier on maintenance.
     * @param {object} entity - the animal.
     * @returns {number} multiplier.
     */
    function activityOf(entity) {
      const body = entity.body
      if (body !== undefined && body.handling !== null) return 0.7
      if (entity.fleeing === true || entity.running === true) return 1.7
      if (entity.intent === 'hunt' || entity.intent === 'scavenge') return 1.5
      if (entity.intent === 'rest') return 0.55
      return 1
    }

    /**
     * Advance the body by one step: absorb the last meal, pay maintenance, grow,
     * and turn an empty reserve or a cold night into lost health.
     *
     * This is the ONLY function allowed to move `body.E`. Everything a player
     * sees about energy (the fatness ring, the hunger bar, the death cause) is a
     * read of what happened here.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @returns {boolean} false when the animal died during this step.
     */
    function metabolise(world, entity, dt) {
      ledgerWriteDepth += 1
      try {
        return metaboliseInner(world, entity, dt)
      } finally {
        ledgerWriteDepth -= 1
      }
    }

    /**
     * The real body step. Only called from `metabolise`, which holds the
     * ledger-write flag so the reserve moves it makes are booked as respiration,
     * growth or overflow rather than as anonymous writes.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {number} dt - step in seconds.
     * @returns {boolean} false when the animal died during this step.
     */
    function metaboliseInner(world, entity, dt) {
      const species = SPECIES[entity.species]
      if (species === undefined) return false
      const body = bodyOf(entity)
      if (body.dead === true) return false
      const days = dt / DAY_SECONDS

      // Assimilation lands in the reserve one step after the meal was taken: the
      // gut is a one-tick buffer, never a second ledger.
      if (body.gut !== 0) {
        // A big meal can overflow the reserve. The excess has to be booked here,
        // because the reserve accessor clamps and a silent clamp is exactly how a
        // joule goes missing.
        const total = body.E + body.gut
        body.gut = 0
        if (total > body.Emax) {
          world.budget.overflow += total - body.Emax
          body.E = body.Emax
        } else {
          body.E = total
        }
      }

      growBody(world, entity, species, body, days)

      const temperature = world.climate === undefined ? BIO.Q10_REFERENCE_C : world.climate.temperature
      const q10 = Math.pow(BIO.Q10, (temperature - BIO.Q10_REFERENCE_C) / 10)
      const activity = activityOf(entity) * (entity.genes?.metabolism ?? 1)
      const fmr = fieldMetabolicRate(species, body.V)
      const pM = fmr * activity * q10
      body.pMetabolism = pM
      body.activity = activity
      // Only what the reserve could actually pay is respired: an animal that runs
      // dry is starving, it is not allowed to burn energy it does not have.
      const due = pM * days
      const paid = body.E > due ? due : Math.max(0, body.E)
      body.E -= paid
      world.budget.animalRespired += paid
      // Digesting a kill is work on top of standing still, but it is charged
      // through the same reserve so the ledger stays single-entry.
      if (body.handling !== null) {
        const corpse = body.handling.corpse
        if (corpse === undefined || corpse.removed === true || !(corpse.energy > 0)) {
          body.handling = null
        } else {
          // A predator strips a carcass at a few times its upkeep. Everything it
          // takes leaves the carcass pool and lands in the gut: the transfer is
          // exact, so a kill that is shared with crows still adds up.
          const bite = Math.min(corpse.energy, pM * HANDLING_RATE * days)
          corpse.energy -= bite
          corpse.mass = Math.max(0, (corpse.mass ?? 0) - bite / BIO.MEAT_ENERGY)
          body.gut += bite
          if (corpse.energy <= 1e-9) body.handling = null
        }
      }

      // Fatigue is a by-product of effort, and rest is the only cure. Behaviour
      // reads it to decide when to stop; it never drives energy itself.
      if (activity > 1.2) body.fatigue = Math.min(1, body.fatigue + dt / (0.6 * DAY_SECONDS))
      else body.fatigue = Math.max(0, body.fatigue - dt / (0.35 * DAY_SECONDS))

      const coldLimit = coldLimitOf(body, species)
      const cold = temperature < coldLimit
      if (body.E <= 0) {
        body.E = 0
        body.health -= BIO.STARVE_HEALTH_RATE * days
      } else if (body.E > body.Emax * 0.5 && !cold) {
        body.health = Math.min(1, body.health + BIO.HEAL_HEALTH_RATE * days)
      }
      if (cold) {
        const severity = clamp((coldLimit - temperature) / 10, 0, 2)
        body.health -= BIO.COLD_HEALTH_RATE * severity * days
      }
      if (body.injury > 0) {
        body.injury = Math.max(0, body.injury - days)
        body.health -= BIO.INJURY_HEALTH_RATE * days
      }
      body.health = clamp(body.health, 0, 1)
      // Anything above the ceiling cannot be stored; it is counted rather than
      // silently dropped, so the energy book still closes.
      if (body.E > body.Emax) {
        world.budget.overflow += body.E - body.Emax
        body.E = body.Emax
      }

      if (body.health <= 0) {
        dieOf(world, entity, body.E <= 0 ? 'starved' : cold ? 'frozen' : 'injury')
        return false
      }
      if (entity.age > entity.genes.lifespan) {
        dieOf(world, entity, 'old')
        return false
      }
      return true
    }

    /**
     * Structure growth, paid for out of the reserve at a price of kJ per kg.
     *
     * Two limits, and both are real:
     *  - the age clock caps how fast a body may grow (`balance.maturity`);
     *  - tissue synthesis burns at most GROWTH_RATE_CEILING x maintenance, which
     *    is what actually binds: a 2 kg rabbit can lay on ~0.27 kg of tissue a
     *    day, so reaching adult mass takes several in-world days, not one tick.
     * The energy that leaves the reserve is exactly the structure energy that
     * arrives, so growth is a transfer inside the energy book, never a creation.
     * @param {object} world - the world.
     * @param {object} entity - the animal.
     * @param {object} species - species row.
     * @param {object} body - body record.
     * @param {number} days - step length in in-world days.
     */
    function growBody(world, entity, species, body, days) {
      const maturity = Math.max(1, species.balance?.maturity ?? 60)
      const phase = clamp((entity.age ?? 0) / maturity, 0, 1)
      const adult = adultMassOf(species)
      const birth = adult * BIRTH_MASS_SHARE
      const target = birth + (adult - birth) * phase
      body.M = clamp((body.V - birth) / Math.max(1e-9, adult - birth), 0, 1)
      if (target <= body.V + 1e-12) return
      // A starving juvenile stalls instead of growing on credit.
      const spendable = body.E - body.Emax * GROWTH_RESERVE_FLOOR
      if (spendable <= 0) return
      const fmr = fieldMetabolicRate(species, body.V)
      const affordable = Math.min(spendable, GROWTH_RATE_CEILING * fmr * days)
      const gain = Math.min(target - body.V, affordable / BIO.STRUCTURE_COST)
      if (gain <= 0) return
      body.V += gain
      body.E -= gain * BIO.STRUCTURE_COST
      body.Emax = reserveCapacity(species, body.V)
      body.M = clamp((body.V - birth) / Math.max(1e-9, adult - birth), 0, 1)
    }

    /**
     * Deposit assimilated energy from a meal. The gut is drained by the next
     * `metabolise` call, so only one function ever touches the reserve itself.
     * @param {object} entity - the animal.
     * @param {number} kilojoules - assimilated energy to credit.
     * @returns {number} energy actually accepted (0 when the animal is dead).
     */
    function absorb(entity, kilojoules) {
      const body = bodyOf(entity)
      if (body.dead === true || !(kilojoules > 0)) return 0
      body.gut += kilojoules
      return kilojoules
    }

    /**
     * Wound an animal; the health cost is paid over the next days, not at once.
     * @param {object} entity - the animal.
     * @param {number} days - how long the wound keeps hurting.
     */
    function applyDamage(entity, days) {
      const body = bodyOf(entity)
      body.injury = Math.max(body.injury, Math.max(0, days))
    }

    /**
     * The single death entry point: records the cause, drops the animal from the
     * population counter and leaves a carcass whose mass and energy come from the
     * body that died (so a fat animal feeds more than a starved one).
     * @param {object} world - the world.
     * @param {object} entity - the dying animal.
     * @param {string} cause - starvation/freezing/predation/old age/disease.
     * @returns {object|null} the carcass it left, or null when it was already dead.
     */
    function dieOf(world, entity, cause) {
      const body = bodyOf(entity)
      if (body.dead === true) return null
      body.dead = true
      body.cause = String(cause ?? 'unknown')
      entity.fate = 'dead'
      entity.cause = body.cause
      for (let puff = 0; puff < 3; puff++) spawnEffect(world, entity.x, entity.y, PALETTE.effect.death, 0.5, 0.5)
      if (world.population !== undefined && world.population[entity.species] !== undefined) {
        world.population[entity.species] = Math.max(0, world.population[entity.species] - 1)
      }
      // A carcass is worth what the animal was: its reserve plus its edible
      // tissue. That is exactly the animal's entry in the world energy book, so
      // the transfer is neutral and a fat animal really does feed more.
      const structure = Math.max(0, body.V) * BIO.MEAT_ENERGY
      // Read the gut BEFORE clearing it: food that was in the animal when it died
      // is part of the carcass, not something the world may forget.
      const carried = body.E + (body.gut ?? 0)
      body.gut = 0
      const corpse = {
        id: world.nextId++,
        x: entity.x,
        y: entity.y,
        species: entity.species,
        decay: 0,
        energy: carried + structure,
        mass: Math.max(0, body.V) * BIO.MEAT_FRACTION,
        cause: body.cause,
      }
      world.corpses.push(corpse)
      if (world.corpses.length > MAX_CORPSES) {
        // The carcass table has a hard ceiling (the renderer and the UI both walk
        // it). A corpse evicted by that ceiling is energy leaving the world, so it
        // is booked as overflow instead of quietly disappearing.
        const evicted = world.corpses.shift()
        // A carcass the table has forgotten must not keep feeding the predator
        // that was still holding it, or its energy would be spent twice: once as
        // the overflow the eviction booked, and once as a meal.
        evicted.removed = true
        if (world.budget !== undefined) world.budget.overflow += evicted.energy
      }
      if (world.deaths === undefined) world.deaths = {}
      world.deaths[body.cause] = (world.deaths[body.cause] ?? 0) + 1
      world.lastDeath = { species: entity.species, cause: body.cause, at: world.time, x: entity.x, y: entity.y }
      return corpse
    }

    /**
     * Edible mass of a carcass in kg. Saves written before the ledger existed
     * carry no `mass`, so it is reconstructed from the species table.
     * @param {object} corpse - carcass record.
     * @returns {number} kg wet.
     */
    function carcassMass(corpse) {
      if (Number.isFinite(corpse.mass) && corpse.mass > 0) return corpse.mass
      const species = SPECIES[corpse.species]
      const adult = species === undefined ? 1 : adultMassOf(species)
      return adult * BIO.MEAT_FRACTION
    }


    /**
     * Energy in the world right now, in kJ, split by pool.
     *
     * The book is open by design: sunlight pumps energy in through GPP, and
     * respiration, mineralisation and reproduction are the named taps. What must
     * hold exactly is that no tick invents or loses a joule between the pools.
     * @param {object} world - the world.
     * @returns {{plants: number, detritus: number, carcasses: number, animals: number, total: number}} pools.
     */
    function energyPools(world) {
      let plants = 0
      let detritus = 0
      const size = world.grass.length
      for (let i = 0; i < size; i++) {
        plants += world.grass[i] + world.weed[i]
        detritus += world.detritus[i]
      }
      plants *= CELL_AREA * BIO.GRASS_ENERGY
      detritus *= CELL_AREA * BIO.GRASS_ENERGY
      let carcasses = 0
      for (const corpse of world.corpses) carcasses += corpse.energy
      let animals = 0
      for (const entity of world.entities) {
        const body = entity.body
        if (body === undefined || body.dead === true) continue
        // The gut counts too: a bite leaves the plant pool the instant it is
        // taken, and the animal carries it until the next metabolise call.
        animals += body.E + (body.gut ?? 0) + body.V * BIO.MEAT_ENERGY
      }
      return { plants, detritus, carcasses, animals, total: plants + detritus + carcasses + animals }
    }

    /**
     * Snapshot both the pools and the cumulative taps, for a before/after check.
     * @param {object} world - the world.
     * @returns {object} snapshot.
     */
    function snapshotEnergy(world) {
      return {
        pools: energyPools(world),
        budget: {
          ...world.budget,
          directDeposits: directReserveDeposits,
          directWithdrawals: directReserveWithdrawals,
        },
      }
    }

    /**
     * Residual of the energy book between two snapshots, in kJ and relative.
     *
     * residual = change in stored energy
     *          - (GPP + reproduction injected)   // named sources
     *          + (plant respiration + animal respiration + mineralisation + overflow)
     * A value near zero means every joule that moved was accounted for exactly
     * once (docs/20-CORE-LOOP.md invariant 2).
     * @param {object} before - snapshot from `snapshotEnergy`.
     * @param {object} after - snapshot from `snapshotEnergy`.
     * @returns {{kJ: number, relative: number, detail: object}} residual.
     */
    function energyResidual(before, after) {
      const deltaPools = after.pools.total - before.pools.total
      const injected = (after.budget.gpp - before.budget.gpp)
        + (after.budget.reproduction - before.budget.reproduction)
        + ((after.budget.directDeposits ?? 0) - (before.budget.directDeposits ?? 0))
      const drained = (after.budget.plantRespired - before.budget.plantRespired)
        + (after.budget.animalRespired - before.budget.animalRespired)
        + (after.budget.mineralised - before.budget.mineralised)
        + (after.budget.overflow - before.budget.overflow)
        + ((after.budget.directWithdrawals ?? 0) - (before.budget.directWithdrawals ?? 0))
      const kJ = deltaPools - injected + drained
      const scale = Math.max(1, Math.abs(before.pools.total), Math.abs(after.pools.total))
      return { kJ, relative: Math.abs(kJ) / scale, detail: { deltaPools, injected, drained } }
    }

    /**
     * A fresh set of cumulative energy taps. Every pool that can be entered or
     * left has a counter here, so a leak shows up as a residual instead of a
     * mystery.
     * @returns {object} budget.
     */
    function createBudget() {
      return {
        /** Energy fixed by the plants, kJ. The source term. */
        gpp: 0,
        /** Energy breathed out by plants, kJ. */
        plantRespired: 0,
        /** Energy breathed out by animals, kJ. */
        animalRespired: 0,
        /** Detritus turned into soil organic matter, kJ. */
        mineralised: 0,
        /** Energy injected as newborn bodies, kJ (gestation is not modelled). */
        reproduction: 0,
        /** Energy injected by a direct write to a reserve, kJ. */
        directDeposits: 0,
        /** Energy removed by a direct write to a reserve, kJ. */
        directWithdrawals: 0,
        /** Reserve clamped away because a body was over capacity, kJ. */
        overflow: 0,
        /** Gross plant matter bitten off, kJ. */
        grazed: 0,
        /** Gross animal matter bitten off, kJ. */
        carnivory: 0,
      }
    }

    /**
     * Fill in every derived energy number in the species table.
     *
     * It runs here, at the end of the contract part, because the derivation needs
     * the allometry declared above; the species table itself only carries the
     * design choices (docs/00-VISION.md: numbers come from physics, not balance).
     */
    deriveLifeHistory()
    deriveSpeciesEnergy()
