window.__ModuleLoader__.load({
  id: 'dsh-plugin-image-generation',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'image-generation'
    const JOB_KEY = 'dsh-image-generation-job'
    const css = `
.ig-page{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;color:inherit}
.ig-page fieldset{border:1px solid #8886;border-radius:10px;padding:14px;min-width:0}
.ig-page legend{font-weight:600;padding:0 6px}.ig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.ig-field{display:flex;flex-direction:column;gap:5px;font-size:12px;margin:6px 0}.ig-page input,.ig-page select,.ig-page textarea{box-sizing:border-box;width:100%;padding:8px;border:1px solid #8888;border-radius:7px;background:transparent;color:inherit;font:inherit}
.ig-page textarea{min-height:100px;resize:vertical}.ig-page button,.ig-card button,.ig-card a{padding:7px 11px;border:1px solid #8888;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.ig-page button:disabled{opacity:.5;cursor:default}.ig-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.ig-note{font-size:12px;opacity:.75;line-height:1.6}.ig-error{color:#d5533d;white-space:pre-wrap}.ig-status{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.ig-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.ig-card{min-width:0;border:1px solid #8885;border-radius:8px;padding:10px}.ig-card img{display:block;max-width:100%;max-height:420px;object-fit:contain;margin:auto}.ig-card p{overflow-wrap:anywhere;font-size:12px}.ig-card a{display:inline-block;text-decoration:none}.ig-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;flex-wrap:wrap}
.ig-model-list{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;margin:8px 0}.ig-model-list button{text-align:left;overflow-wrap:anywhere}.ig-model-list button[aria-pressed=true]{border-color:#3987d7;background:#3987d71a}.ig-page details{margin:12px 0}.ig-page summary{cursor:pointer;padding:6px 0}
`
    function field(label, value, change, options = {}) {
      return h('label', { className: 'ig-field', key: label }, label,
        h('input', { value: value ?? '', onChange: event => change(event.target.value), ...options }))
    }
    const fresh = () => ({ id: '', name: '', model: '', api: 'openai-images', endpoint: 'https://api.openai.com/v1/images/generations', apiKeyEnv: 'IMAGE_API_KEY', timeoutSeconds: 300 })
    const unwrap = response => { if (!response.ok) throw new Error(response.error?.message ?? '请求失败'); return response.value }
    function storedJob() { try { return sessionStorage.getItem(JOB_KEY) ?? '' } catch { return '' } }
    function rememberJob(id) { try { sessionStorage.setItem(JOB_KEY, id) } catch { /* Storage may be disabled; the live panel still works. */ } }
    /**
     * An entry the 模型调参 page linked carries its origin. Such an entry is
     * authored there, so it is edited here but removed there — deleting it here
     * would silently break that page's checkbox.
     */
    function managedBy(item) { return item?.source?.provider ? `模型调参 · ${item.source.provider}` : '' }

    function PanelImage({ call, jobId, index, image }) {
      const [url, setUrl] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        let live = true
        call('image', { jobId, imageIndex: index, original: false }).then(value => {
          if (live) setUrl(`data:${value.mediaType};base64,${value.data}`)
        }, error => { if (live) setError(error.message) })
        return () => { live = false }
      }, [call, jobId, index])
      async function download() {
        setBusy(true); setError('')
        try {
          const value = await call('image', { jobId, imageIndex: index, original: true })
          const bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0))
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: value.mediaType }))
          const anchor = document.createElement('a')
          anchor.href = objectUrl; anchor.download = value.name; anchor.click()
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
        } catch (error) { setError(error.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'ig-card' },
        url ? h('a', { href: url, target: '_blank', rel: 'noreferrer', title: '打开预览' }, h('img', { src: url, alt: `生成图片 ${index + 1}` })) : h('p', null, '正在加载预览…'),
        h('p', null, `${image.preview.width} × ${image.preview.height} 预览 · 原图 ${(image.original.bytes / 1024).toFixed(0)} KB`),
        image.path ? h('p', null, image.path) : null,
        h('button', { onClick: download, disabled: busy }, busy ? '正在下载…' : '下载原图'),
        error ? h('p', { className: 'ig-error', role: 'alert' }, error) : null)
    }

    function Page({ remote, call }) {
      const [view, setView] = React.useState(null)
      const [writable, setWritable] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [editing, setEditing] = React.useState('')
      const [key, setKey] = React.useState('')
      const [catalog, setCatalog] = React.useState(null)
      const [modelQuery, setModelQuery] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [selected, setSelected] = React.useState('')
      const [prompt, setPrompt] = React.useState('')
      const [count, setCount] = React.useState('1')
      const [jobId, setJobId] = React.useState(storedJob)
      const [job, setJob] = React.useState(null)
      const models = view?.value?.models ?? []
      // The entry currently open in the form, when the 模型调参 page owns it:
      // its identity fields are that page's to change, so they render read-only.
      const linked = managedBy(models.find(item => item.id === editing))
      async function refresh() {
        const result = unwrap(await remote.settings.describe())
        const found = result.namespaces.find(item => item.ns === NS)
        if (!found) throw new Error('绘图宿主插件未加载，请检查插件安装并重启 dsh。')
        setView(found); setWritable(result.writable)
        return found
      }
      React.useEffect(() => { void refresh().catch(error => setError(error.message)) }, [])
      React.useEffect(() => {
        if (!jobId) return undefined
        let live = true
        let timer
        async function poll() {
          try {
            const next = await call('status', { jobId })
            if (!live) return
            setJob(next)
            if (next.status === 'running') timer = setTimeout(poll, 1500)
          } catch (error) { if (live) setJob({ status: 'error', error: error.message }) }
        }
        void poll()
        return () => { live = false; clearTimeout(timer) }
      }, [call, jobId])
      async function action(fn) {
        setBusy(true); setError(''); setNotice('')
        try { await fn() } catch (error) { setError(error.message) } finally { setBusy(false) }
      }
      async function write(nextModels, defaultModel) {
        unwrap(await remote.settings.mutate(NS, [
          { op: 'set', path: ['models'], value: nextModels },
          { op: 'set', path: ['defaultModel'], value: defaultModel || '' },
        ], view.revision))
        await refresh()
      }
      async function save() {
        const normalized = { ...form, id: form.id.trim(), model: form.model.trim(), endpoint: form.endpoint.trim(), apiKeyEnv: (form.apiKeyEnv ?? '').trim(), timeoutSeconds: Number(form.timeoutSeconds) }
        // A linked entry's identity belongs to the 模型调参 page: its id is what
        // that page's checkbox matches, and its model/endpoint/key follow the
        // provider. Editing them here would silently break the link, so they are
        // restored from the stored entry and only the rest of the form applies.
        const stored = editing ? models.find(item => item.id === editing) : undefined
        if (managedBy(stored)) {
          normalized.id = stored.id
          normalized.model = stored.model
          normalized.endpoint = stored.endpoint
          normalized.apiKeyEnv = stored.apiKeyEnv ?? ''
          normalized.source = stored.source
        }
        if (!normalized.model) throw new Error('请从供应商列表选择模型，或手动填写模型 ID。')
        if (!normalized.id) {
          const base = normalized.model.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 54) || 'image-model'
          normalized.id = base
          for (let i = 2; models.some(item => item.id === normalized.id); i++) normalized.id = `${base}-${i}`
        }
        if (models.some(item => item.id === normalized.id && item.id !== editing)) throw new Error('配置 ID 已存在。')
        if (key) {
          if (!normalized.apiKeyEnv) throw new Error('保存 Key 前请填写凭据引用。')
          unwrap(await remote.credentials.set(normalized.apiKeyEnv, key))
          setKey('')
        }
        const next = editing ? models.map(item => item.id === editing ? normalized : item) : [...models, normalized]
        const previousDefault = view.value.defaultModel
        await write(next, previousDefault === editing || !previousDefault ? normalized.id : previousDefault)
        setForm(null); setEditing(''); setNotice('已保存，下次生成即生效。')
      }
      async function generate() {
        const result = await call('start', { request: { ...(selected ? { model: selected } : {}), prompt, n: Number(count) } })
        rememberJob(result.jobId); setJob({ status: 'running' }); setJobId(result.jobId)
      }
      async function discover() {
        setCatalog(null)
        const result = await call('discover', { request: {
          endpoint: form.endpoint.trim(), modelsEndpoint: (form.modelsEndpoint ?? '').trim(),
          apiKeyEnv: (form.apiKeyEnv ?? '').trim(), ...(key ? { apiKey: key } : {}),
        } })
        setCatalog(result); setModelQuery('')
      }
      const update = name => value => {
        if (['endpoint', 'modelsEndpoint', 'apiKeyEnv'].includes(name)) setCatalog(null)
        setForm(previous => ({ ...previous, [name]: value }))
      }
      const visibleModels = (catalog?.models ?? []).filter(item => `${item.id} ${item.name}`.toLowerCase().includes(modelQuery.trim().toLowerCase()))
      const running = job?.status === 'running'
      return h('div', { className: 'ig-page' },
        h('p', { className: 'ig-note' }, '独立配置绘图模型。可在聊天中让助手调用 generate_image，也可在下方直接生成。接口使用 OpenAI Images 协议。'),
        error ? h('div', { className: 'ig-error', role: 'alert' }, error) : null,
        notice ? h('div', { role: 'status' }, notice) : null,
        !view ? h('p', null, '正在读取配置…') : h('fieldset', { disabled: busy }, h('legend', null, '绘图模型'),
          models.length === 0 ? h('p', { className: 'ig-note' }, '尚未配置。添加模型后即可绘图；可由「模型调参」页勾选生图模型自动生成。') : models.map(item => h('div', { className: 'ig-row', key: item.id },
            h('span', null, `${item.name || item.id} · ${item.model}${view.value.defaultModel === item.id ? ' · 默认' : ''}${managedBy(item) ? ' · ' + managedBy(item) : ''}`),
            h('div', { className: 'ig-actions' },
              h('button', { disabled: !writable || !!form, onClick: () => { setForm({ ...item }); setEditing(item.id); setKey(''); setCatalog(null) } }, '编辑'),
              h('button', { disabled: !writable || !!form, onClick: () => void action(() => write(models, item.id)) }, '设为默认'),
              h('button', {
                disabled: !writable || !!form || !!managedBy(item),
                title: managedBy(item) ? '该配置由「模型调参」页链接，请在那边取消生图模型勾选' : undefined,
                onClick: () => void action(async () => {
                  const next = models.filter(model => model.id !== item.id)
                  await write(next, view.value.defaultModel === item.id ? next[0]?.id : view.value.defaultModel)
                  if (selected === item.id) setSelected('')
                }),
              }, '删除')))),
          h('div', { className: 'ig-actions' },
            h('button', { disabled: !writable || !!form, onClick: () => { setForm(fresh()); setEditing(''); setKey(''); setCatalog(null) } }, '添加模型'),
            h('button', { onClick: () => void action(async () => { await refresh(); setForm(null); setKey('') }) }, '重新加载')),
          !writable ? h('p', { className: 'ig-note' }, '当前配置只读。') : null),
        form ? h('fieldset', { disabled: busy }, h('legend', null, editing ? '编辑模型' : '添加模型'),
          field('供应商 API 地址', form.endpoint.replace(/\/images\/generations\/?$/, ''), value => update('endpoint')(value.replace(/\/+$/, '').replace(/\/images\/generations$/, '') + '/images/generations'), { type: 'url', placeholder: 'https://api.example.com/v1' }),
          field('API Key（留空保留现有值）', key, value => { setKey(value); setCatalog(null) }, { type: 'password', autoComplete: 'new-password' }),
          h('button', { onClick: () => void action(discover) }, '获取模型列表'),
          catalog ? h('div', null,
            field('搜索供应商模型', modelQuery, setModelQuery, { placeholder: '按名称或模型 ID 搜索' }),
            h('p', { className: 'ig-note' }, `供应商返回 ${catalog.models.length} 个模型。列表可能包含聊天模型，请选择供应商明确支持绘图的型号。${catalog.truncated ? '供应商还有后续分页，当前只显示首批结果；未找到的型号可手动填写。' : ''}`),
            h('div', { className: 'ig-model-list' }, visibleModels.slice(0, 200).map(item => h('button', {
              key: item.id, 'aria-pressed': form.model === item.id,
              onClick: () => setForm(previous => ({ ...previous, model: item.id, name: previous.name || item.name })),
            }, item.name === item.id ? item.id : `${item.name} · ${item.id}`))),
            visibleModels.length === 0 ? h('p', { className: 'ig-note' }, '没有匹配的模型，可以更换搜索词或手动填写。') : null,
            visibleModels.length > 200 ? h('p', { className: 'ig-note' }, '当前显示前 200 项，请输入关键词缩小范围。') : null) : null,
          field('模型 ID', form.model, update('model'), { placeholder: '从列表选择，也可手动填写', disabled: !!linked}),
          h('details', null, h('summary', null, '高级设置（可选）'),
          h('div', { className: 'ig-grid' },
            field('配置 ID', form.id, update('id'), { placeholder: '留空自动生成', disabled: !!editing || !!linked}),
            field('显示名称', form.name, update('name')),
            field('接口类型', 'OpenAI Images', () => {}, { disabled: true }),
            field('完整生成接口', form.endpoint, update('endpoint'), { type: 'url', disabled: !!linked}),
            field('模型列表接口（留空自动推导）', form.modelsEndpoint, update('modelsEndpoint'), { type: 'url' }),
            field('凭据引用', form.apiKeyEnv, update('apiKeyEnv'), { placeholder: 'IMAGE_API_KEY', disabled: !!linked}),
            field('超时（秒）', form.timeoutSeconds, update('timeoutSeconds'), { type: 'number', min: 10, max: 600 }),
            ...[['尺寸', 'size'], ['质量', 'quality'], ['背景', 'background'], ['输出格式', 'output_format'], ['响应格式', 'response_format'], ['风格', 'style']].map(([label, name]) => field(`${label}（可选）`, form[name], update(name)))),
          h('p', { className: 'ig-note' }, '可选参数留空则不发送。GPT Image 的响应格式请留空。Key 通过 dsh 凭据服务单独保存；同名引用会被其他模型共享。'),
          editing && managedBy(form) ? h('p', { className: 'ig-note' }, `该配置由「模型调参」页链接（${managedBy(form)}）：模型 ID、端点和凭据引用随 provider 配置更新，其余参数可在此自由修改；如需删除，请在调参页取消「生图模型」勾选。`) : null),
          h('div', { className: 'ig-actions' }, h('button', { onClick: () => void action(save) }, '保存'), h('button', { onClick: () => { setForm(null); setKey('') } }, '取消'))): null,
        h('fieldset', { disabled: busy || running }, h('legend', null, '直接绘图'),
          h('label', { className: 'ig-field' }, '绘图模型', h('select', { value: selected, onChange: event => setSelected(event.target.value) },
            h('option', { value: '' }, '使用默认模型'), ...models.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
          h('label', { className: 'ig-field' }, '提示词', h('textarea', { value: prompt, onChange: event => setPrompt(event.target.value), placeholder: '描述你想生成的画面…' })),
          field('图片数量', count, setCount, { type: 'number', min: 1, max: 4 }),
          h('button', { disabled: models.length === 0 || !prompt.trim(), onClick: () => void action(generate) }, '生成图片'),
          h('p', { className: 'ig-note' }, '点击生成会调用所选服务，可能产生费用。此面板不发送聊天历史，结果不插入对话。任务预览保留到宿主重启、过期或被后续任务替换前，请及时下载原图。')),
        running ? h('div', { role: 'status' }, '正在生成… ', h('button', { onClick: () => void action(async () => { await call('cancel', { jobId }) }) }, '取消等待')) : null,
        job?.status === 'error' ? h('div', { className: 'ig-error', role: 'alert' }, job.error) : null,
        job?.result ? h('div', { className: 'ig-gallery' }, job.result.images.map((image, index) => h(PanelImage, { key: `${jobId}-${index}`, call, jobId, image, index }))) : null)
    }

    return {
      inject: ['slots', 'connection', 'remote', 'remote.settings', 'remote.credentials'],
      apply(ctx) {
        const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style)
        ctx.effect(() => () => style.remove())
        const call = async (method, args) => unwrap(await ctx.connection.rpc.call('/api', `imageGeneration/${method}`, { args }))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: NS, order: 13, label: () => '绘图' },
          () => h(Page, { remote: ctx.remote, call })))
        // No `tool.call.toolview` row for `generate_image` here: the generic
        // image card (dsh-plugin-read-image-preview) claims that key and renders
        // any result carrying image attachments, with the zoom/pan viewer this
        // panel never had. Two owners for one keyed cell would only compete.
      },
    }
  },
})
