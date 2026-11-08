    // ---------------------------------------------------------------------
    // Plugin registration
    // ---------------------------------------------------------------------

    /** Client half exports: two additive slot registrations, nothing replaced. */
    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const style = typeof document === 'undefined' ? null : document.createElement('style')
        if (style !== null) {
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => { style.remove() })
        }
        ctx.effect(() => registerDictionaries(ctx.locale))
        const store = createStore({})
        ctx.effect(() => () => store.dispose())
        const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 24,
          label: () => ctx.locale.bind(NS)('panel.title'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, props => h(PANEL_BOUNDARY, null, h(TerrariumPanel, { ...props, store, locale: ctx.locale, layout }))))
      },
    }

    module.exports = plugin
    // Test seam: the engine and the renderer are DOM-free.
    module.exports.__engine = {
      SPECIES,
      SPECIES_IDS,
      TERRAIN,
      GENE_KEYS,
      NEED_KEYS,
      DRIVE_KEYS,
      CAUSE_KEYS,
      INTENT_IDS,
      // Scale and the two ledgers, so a headless probe can assert the physics
      // without reaching into the closure (docs/20-CORE-LOOP.md section 4).
      CELL_M,
      GRID_W,
      GRID_H,
      DAY_SECONDS,
      YEAR_DAYS,
      TICKS_PER_DAY,
      BIO,
      PRODUCERS,
      stepClimate,
      metabolise,
      bodyOf,
      dieOf,
      energyPools,
      snapshotEnergy,
      energyResidual,
      grazingIntake,
      dryMatterRequirement,
      GRAZE_REFERENCE,
      INTAKE_CEILING,
      ROLE_TRAITS,
      STAGE_SCALE,
      TUNING,
      PALETTE,
      SPRITES,
      SPRITE_GRIDS,
      PLANT_SPRITES,
      SPRITE_COLORS,
      ATLAS,
      ATLAS_SLOTS,
      ATLAS_SIZE,
      ATLAS_GAIT,
      SPRITE_ATLAS_PNG,
      TICK,
      DAY_SECONDS,
      MAX_ENTITIES,
      createWorld,
      stepWorld,
      place,
      spawnEntity,
      findEntityAt,
      sampleStats,
      pushHistory,
      serializeWorld,
      deserializeWorld,
      // Save v2 is an async, compressed codec: the store must await these, and a
      // headless test asserts the round trip without touching localStorage.
      packWorld,
      unpackWorld,
      formatSaveSize,
      saveError,
      metabolicTemperatureFactor,
      feltTemperature,
      paintView,
      paintWorld,
      paintMinimap,
      viewFromCamera,
      worldFromPoint,
      cameraAfterZoom,
      frameFor,
      // Visual contract: the pose table and the season/sun model are what the
      // renderer and the tests share, so a headless test can pin "state X draws
      // pose Y" without reading pixels back.
      poseFor,
      poseForId,
      STATE_POSES,
      seasonLook,
      sunState,
      drawDepthLayers,
      ensureAtlas,
      countSpecies,
      handleImmigration,
      settleTerrain,
      computeHydrology,
      canStand,
      createStore,
      GLYPHS,
      PANEL_GLYPH,
    }
    module.exports.__test = {
      CHINESE,
      ENGLISH,
      GLYPHS,
      PANEL_GLYPH,
      TerrariumPanel,
      isStageControl,
      STAGE_CONTROLS,
      Inspector,
      PopulationChart,
      Minimap,
      PanelIcon,
      PixelGlyph,
      BRUSHES,
      BRUSH_RADIUS,
      LIFE_TOOLS,
      TERRAIN_TOOL_IDS,
      SPECIES_TOOL_IDS: SPECIES_IDS,
    }

    return module.exports
  },
})