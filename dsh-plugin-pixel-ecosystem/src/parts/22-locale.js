    // ---------------------------------------------------------------------

    /** Chinese dictionary. Keys must match `ENGLISH` exactly (tested). */
    const CHINESE = {
      'panel.title': '像素生态缸',
      'action.back': '回到对话',
      'action.play': '继续',
      'action.pause': '暂停',
      'action.newWorld': '新世界',
      'action.newWorldConfirm': '再点一次确认重开',
      'action.help': '玩法',
      'action.fit': '适应窗口',
      'action.close': '关闭',
      'stat.day': '第 {day} 天',
      'stat.corpses': '遗骸',
      'speed.paused': '暂停',
      'speed.1': '1×',
      'speed.2': '2×',
      'speed.4': '4×',
      'speed.8': '8×',
      'species.rabbit': '兔子',
      'species.deer': '鹿',
      'species.fox': '狐狸',
      'species.wolf': '狼',
      'species.crow': '乌鸦',
      'species.fish': '小鱼',
      'species.pike': '狗鱼',
      'species.heron': '苍鹭',
      'species.otter': '水獭',
      'species.bear': '棕熊',
      'species.frog': '青蛙',
      'tool.grass': '草',
      'tool.weed': '水草',
      'tool.tree': '树',
      'tool.bush': '灌木',
      'tool.water': '水',
      'tool.sand': '沙',
      'tool.dirt': '土',
      'tool.stone': '石头',
      'tool.pointer': '指针',
      'tool.erase': '清除',
      'tool.group.life': '生命',
      'tool.group.terrain': '地形',
      'brush.label': '笔刷',
      'brush.small': '小',
      'brush.medium': '中',
      'brush.large': '大',
      'chart.title': '种群变化',
      'inspect.empty': '点一只生物，看看它的基因',
      'inspect.age': '年龄',
      'inspect.energy': '能量',
      'inspect.generation': '第 {n} 代',
      'inspect.children': '后代 {n}',
      'inspect.gene.speed': '速度',
      'inspect.gene.vision': '视野',
      'inspect.gene.size': '体型',
      'inspect.gene.metabolism': '代谢',
      'inspect.gene.lifespan': '寿命',
      'inspect.gene.fertility': '繁殖',
      'inspect.follow': '跟随',
      'inspect.unfollow': '取消跟随',
      'help.title': '怎么玩',
      'help.1': '左键放置选中的东西，右键擦除。',
      'help.2': '草和水草会自己长回来，但兔子、鹿和鱼会把它们吃掉。',
      'help.3': '兔子吃草，狐狸吃兔子；鹿还会啃树上的叶子，狼更爱追鹿。',
      'help.4': '乌鸦飞过水面上空，只吃遗骸；狗鱼在水里追小鱼。',
      'help.5': '小崽会继承父母的基因，偶尔有点小变异，吃饱了才生。',
      'help.6': '滚轮缩放，平移工具拖动画布；点生物看基因，跟随可以盯住它。',
      'help.7': '世界会自动保存，关掉再回来还在。',
    }

    /** English dictionary. Keys must match `CHINESE` exactly (tested). */
    const ENGLISH = {
      'panel.title': 'Pixel terrarium',
      'action.back': 'Back to chat',
      'action.play': 'Resume',
      'action.pause': 'Pause',
      'action.newWorld': 'New world',
      'action.newWorldConfirm': 'Click again to confirm',
      'action.help': 'How to play',
      'action.fit': 'Fit view',
      'action.close': 'Close',
      'stat.day': 'Day {day}',
      'stat.corpses': 'Remains',
      'speed.paused': 'Paused',
      'speed.1': '1×',
      'speed.2': '2×',
      'speed.4': '4×',
      'speed.8': '8×',
      'species.rabbit': 'Rabbit',
      'species.deer': 'Deer',
      'species.fox': 'Fox',
      'species.wolf': 'Wolf',
      'species.crow': 'Crow',
      'species.fish': 'Fish',
      'species.pike': 'Pike',
      'species.heron': 'Heron',
      'species.otter': 'Otter',
      'species.bear': 'Bear',
      'species.frog': 'Frog',
      'tool.grass': 'Grass',
      'tool.weed': 'Weed',
      'tool.tree': 'Tree',
      'tool.bush': 'Shrub',
      'tool.water': 'Water',
      'tool.sand': 'Sand',
      'tool.dirt': 'Soil',
      'tool.stone': 'Stone',
      'tool.pointer': 'Pointer',
      'tool.erase': 'Erase',
      'tool.group.life': 'Life',
      'tool.group.terrain': 'Terrain',
      'brush.label': 'Brush',
      'brush.small': 'S',
      'brush.medium': 'M',
      'brush.large': 'L',
      'chart.title': 'Populations',
      'inspect.empty': 'Click a creature to read its genes',
      'inspect.age': 'Age',
      'inspect.energy': 'Energy',
      'inspect.generation': 'Gen {n}',
      'inspect.children': 'Offspring {n}',
      'inspect.gene.speed': 'Speed',
      'inspect.gene.vision': 'Vision',
      'inspect.gene.size': 'Size',
      'inspect.gene.metabolism': 'Metabolism',
      'inspect.gene.lifespan': 'Lifespan',
      'inspect.gene.fertility': 'Breeding',
      'inspect.follow': 'Follow',
      'inspect.unfollow': 'Unfollow',
      'help.title': 'How to play',
      'help.1': 'Left-click places the selected thing, right-click erases.',
      'help.2': 'Grass and weed regrow on their own — rabbits, deer and fish eat them.',
      'help.3': 'Rabbits eat grass, foxes eat rabbits; deer also browse leaves, wolves prefer deer.',
      'help.4': 'Crows fly over the water and eat only carcasses; pike hunt fish.',
      'help.5': 'Offspring inherit their parents\' genes with a small mutation, and only breed when well fed.',
      'help.6': 'Wheel zooms, the pan tool drags; click a creature to read its genes, follow keeps it in view.',
      'help.7': 'The world autosaves and is still here next time.',
    }

    /** Locale ids every build is known to serve, before the live catalog is read. */
    const BUILT_IN_LOCALE_IDS = ['en', 'zh', 'zh-CN', 'zh-Hans']

    /**
     * Pick the dictionary one locale id should receive, by primary subtag.
     * @param {string} id - locale id.
     * @returns {object|undefined} dictionary.
     */
    function dictionaryFor(id) {
      const primary = String(id).toLowerCase().split('-')[0]
      if (primary === 'zh') return CHINESE
      if (primary === 'en') return ENGLISH
      return undefined
    }

    /**
     * Register one dictionary per built-in id plus every id the live catalog
     * exposes, so `zh-CN` or a language pack resolves Chinese rather than
     * falling through to English.
     * @param {object} locale - the harness locale service.
     * @returns {() => void} disposer removing every registration made.
     */
    function registerDictionaries(locale) {
      const ids = new Set(BUILT_IN_LOCALE_IDS)
      const snapshot = locale.getSnapshot()
      const locales = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.locales)
        ? snapshot.locales
        : []
      for (const definition of locales) {
        if (definition !== null && typeof definition === 'object' && typeof definition.id === 'string') ids.add(definition.id)
      }
      const disposers = []
      for (const id of ids) {
        const dictionary = dictionaryFor(id)
        if (dictionary !== undefined) disposers.push(locale.register(NS, id, dictionary))
      }
      return () => { for (const dispose of disposers) dispose() }
    }

    /**
     * Re-render on language change and return the translator for this namespace.
     * @param {object} locale - the harness locale service.
     * @returns {(key: string, params?: object) => string} translator.
     */
    function useTranslate(locale) {
      const subscribe = React.useCallback(callback => locale.subscribe(callback), [locale])
      const read = React.useCallback(() => locale.getSnapshot(), [locale])
      React.useSyncExternalStore(subscribe, read, read)
      return React.useCallback((key, params) => {
        const translate = locale.bind(NS)
        const text = translate(key)
        if (params === undefined || typeof text !== 'string') return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }, [locale])
    }
