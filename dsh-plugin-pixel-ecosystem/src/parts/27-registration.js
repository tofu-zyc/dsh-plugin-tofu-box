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
      INTENT_IDS,
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
      paintView,
      paintWorld,
      paintMinimap,
      viewFromCamera,
      worldFromPoint,
      cameraAfterZoom,
      frameFor,
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