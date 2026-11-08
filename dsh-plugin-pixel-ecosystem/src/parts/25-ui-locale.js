    // ---------------------------------------------------------------------
    // Extra palette entries and locale keys used by the panel chrome
    // ---------------------------------------------------------------------

    /**
     * Finish a terrain edit: refresh moisture from the new shoreline and give
     * freshly painted land a natural fertility again.
     * @param {object} world - the world.
     */
    function settleTerrain(world) {
      if (world.hydrologyDirty !== true) return
      computeHydrology(world, false)
      const fertility = world.fertility
      for (let i = 0; i < fertility.length; i++) {
        if (fertility[i] !== 0) continue
        const terrain = world.terrain[i]
        if (terrain === TERRAIN.WATER || terrain === TERRAIN.STONE) continue
        fertility[i] = baseFertility(world, i)
      }
      world.hydrologyDirty = false
    }
    PALETTE.effect.cursor = rgb(255, 255, 255)
    PALETTE.effect.select = rgb(255, 236, 140)

    Object.assign(CHINESE, {
      'action.step': '单步',
      'action.deselect': '取消选择',
      'inspect.title': '详情',
      'inspect.emptyHint': '左键放置，右键擦除；点一只生物看它的基因',
      'help.8': '空格暂停、1–4 调速度、F 适应窗口、Esc 取消选择。',
      'stage.juvenile': '幼崽',
      'stage.adult': '成年',
      'stage.elder': '老年',
      'intent.flee': '逃跑',
      'intent.forage': '觅食',
      'intent.hunt': '捕猎',
      'intent.scavenge': '食腐',
      'intent.drink': '喝水',
      'intent.rest': '休息',
      'intent.socialize': '结伴',
      'intent.explore': '游荡',
      'needs.title': '需求',
      'needs.hunger': '饥饿',
      'needs.thirst': '口渴',
      'needs.energy': '体力',
      'needs.safety': '安全',
      'needs.social': '社交',
      'toast.placed': '放出了 {n} 只',
      'toast.blocked': '这里放不下，附近也没有合适的地方',
    })
    Object.assign(ENGLISH, {
      'action.step': 'Step',
      'action.deselect': 'Deselect',
      'inspect.title': 'Details',
      'inspect.emptyHint': 'Left-click places, right-click erases; click a creature for its genes',
      'help.8': 'Space pauses, 1–4 set speed, F fits the view, Esc clears the selection.',
      'stage.juvenile': 'Juvenile',
      'stage.adult': 'Adult',
      'stage.elder': 'Elder',
      'intent.flee': 'Fleeing',
      'intent.forage': 'Foraging',
      'intent.hunt': 'Hunting',
      'intent.scavenge': 'Scavenging',
      'intent.drink': 'Drinking',
      'intent.rest': 'Resting',
      'intent.socialize': 'Socialising',
      'intent.explore': 'Wandering',
      'needs.title': 'Needs',
      'needs.hunger': 'Hunger',
      'needs.thirst': 'Thirst',
      'needs.energy': 'Energy',
      'needs.safety': 'Safety',
      'needs.social': 'Social',
      'toast.placed': 'Released {n}',
      'toast.blocked': 'Nothing fits here, and no room nearby',
    })
