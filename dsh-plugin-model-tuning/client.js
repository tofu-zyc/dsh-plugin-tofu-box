window.__ModuleLoader__.load({
  id: "dsh-plugin-model-tuning",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const CSS = `
.mcfg{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;color:inherit}
.mcfg-head{display:flex;flex-direction:column;gap:4px}
.mcfg-title{font-size:15px;font-weight:600}
.mcfg-sub{font-size:12.5px;opacity:.72;line-height:1.5}
.mcfg-searchrow{display:flex;align-items:center;gap:8px}
.mcfg-search{flex:1;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}
.mcfg-search:focus{outline:none;border-color:rgba(80,140,255,.7)}
.mcfg-count{font-size:12px;opacity:.6;white-space:nowrap}
.mcfg-state{padding:24px 8px;font-size:13px;opacity:.7}
.mcfg-error{color:#d5533d;opacity:1}
.mcfg-toast{position:sticky;top:8px;z-index:20;align-self:flex-start;padding:6px 12px;border-radius:8px;font-size:12.5px}
.mcfg-toast-ok{background:rgba(46,160,67,.18)}
.mcfg-toast-err{background:rgba(213,83,61,.18)}
.mcfg-provider{display:flex;flex-direction:column;gap:10px}
.mcfg-provider-name{font-size:13px;font-weight:600;display:flex;align-items:baseline;gap:8px}
.mcfg-provider-id{font-size:11px;font-weight:400;opacity:.55;font-family:ui-monospace,SFMono-Regular,monospace}
.mcfg-model{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid rgba(128,128,128,.28);border-radius:10px}
.mcfg-model-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mcfg-model-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.mcfg-model-name{font-size:13.5px;font-weight:600}
.mcfg-model-id{font-size:11.5px;opacity:.55;font-family:ui-monospace,SFMono-Regular,monospace}
.mcfg-desc{font-size:12px;opacity:.6;line-height:1.4}
.mcfg-reasoning{display:flex;flex-direction:column;gap:6px}
.mcfg-levels{display:flex;flex-wrap:wrap;gap:6px 14px}
.mcfg-level{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;cursor:pointer}
.mcfg-level input{accent-color:rgb(80,140,255)}
.mcfg-chip{font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(128,128,128,.16)}
.mcfg-chip-on{background:rgba(46,160,67,.22)}
.mcfg-note{font-size:11.5px;opacity:.55}
.mcfg-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.mcfg-field{display:flex;flex-direction:column;gap:4px;min-width:0}
/* 选择框与自定义输入框竖排：横排时 .mcfg-select 的 width:100% 会吃掉整行
   flex 空间，.mcfg-custom 被压到约 18px 宽（几乎看不见）。 */
.mcfg-fieldrow{display:flex;flex-direction:column;gap:6px;align-items:stretch}
.mcfg-select,.mcfg-input{font-size:12.5px;padding:6px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.mcfg-custom{width:100%}
.mcfg-input:disabled,.mcfg-select:disabled{opacity:.5;cursor:not-allowed}
/* 页签样式：v3 起设置页只剩「绘图」一页，页签控件不再使用，样式保留给
   未来多页布局，不影响当前渲染。 */
.mcfg-tabs{display:flex;gap:6px;flex-wrap:wrap}
.mcfg-tab{font-size:12.5px;padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer}
.mcfg-tab:hover{border-color:rgba(128,128,128,.6)}
.mcfg-tab-on{border-color:rgba(80,140,255,.8);background:rgba(80,140,255,.14);font-weight:600}
.mcfg-purpose{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid rgba(128,128,128,.28);border-radius:10px}
.mcfg-purpose-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mcfg-purpose-name{font-size:13.5px;font-weight:600}
.mcfg-radio{display:flex;flex-direction:column;gap:8px}
.mcfg-radio-row{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;cursor:pointer}
.mcfg-radio-row input{margin-top:2px;accent-color:rgb(80,140,255)}
.mcfg-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mcfg-save{font-size:12.5px;padding:6px 14px;border-radius:8px;border:1px solid rgba(80,140,255,.6);background:transparent;color:inherit;cursor:pointer}
.mcfg-save:disabled{opacity:.5;cursor:not-allowed}
.mcfg-select:focus,.mcfg-input:focus{outline:none;border-color:rgba(80,140,255,.7)}
.mcfg-img-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.mcfg-warn{font-size:11.5px;line-height:1.5;color:#c9722c}
/* ── 绘图页（ex dsh-plugin-image-generation 的面板样式，统一前缀） ── */
.mcfg-page fieldset{border:1px solid #8886;border-radius:10px;padding:14px;min-width:0}
.mcfg-page legend{font-weight:600;padding:0 6px}
.mcfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.mcfg-field2{display:flex;flex-direction:column;gap:5px;font-size:12px;margin:6px 0}
.mcfg-page input,.mcfg-page select,.mcfg-page textarea{box-sizing:border-box;width:100%;padding:8px;border:1px solid #8888;border-radius:7px;background:transparent;color:inherit;font:inherit}
.mcfg-page textarea{min-height:100px;resize:vertical}
.mcfg-page button,.mcfg-card button,.mcfg-card a{padding:7px 11px;border:1px solid #8888;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.mcfg-page button:disabled{opacity:.5;cursor:default}
.mcfg-actions2{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.mcfg-status{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.mcfg-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.mcfg-card{min-width:0;border:1px solid #8885;border-radius:8px;padding:10px}
.mcfg-card img{display:block;max-width:100%;max-height:420px;object-fit:contain;margin:auto}
.mcfg-card p{overflow-wrap:anywhere;font-size:12px}
.mcfg-card a{display:inline-block;text-decoration:none}
.mcfg-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;flex-wrap:wrap}
.mcfg-draw-item{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 220px}
.mcfg-draw-name{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.mcfg-draw-meta{font-size:11.5px;opacity:.55;overflow-wrap:anywhere}
.mcfg-draw-row{align-items:center;gap:10px}
.mcfg-draw-radio{display:flex;align-items:center;padding:0 2px}
.mcfg-draw-radio input{accent-color:rgb(80,140,255);width:14px;height:14px;cursor:pointer}
.mcfg-primary{border-color:rgba(80,140,255,.65)!important;background:rgba(80,140,255,.10)!important}
.mcfg-advanced{margin-top:12px;border:1px solid #8884;border-radius:10px;padding:10px 14px}
.mcfg-advanced>summary{cursor:pointer;font-size:12.5px;opacity:.85}
.mcfg-advanced[open]>summary{margin-bottom:8px}
.mcfg-advanced fieldset{border:0;padding:0;margin:0;min-width:0}
.mcfg-model-list{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;margin:8px 0}
.mcfg-model-list button{text-align:left;overflow-wrap:anywhere}
.mcfg-model-list button[aria-pressed=true]{border-color:#3987d7;background:#3987d71a}
.mcfg-page details{margin:12px 0}
.mcfg-page summary{cursor:pointer;padding:6px 0}
`;

    /**
     * v3: one namespace. Drawing models (the former `dsh-plugin-image-generation`
     * Config keys) still live under `model-tuning` so existing profiles keep
     * working; the removed title fields are ignored.
     */
    const NS = "model-tuning";

    const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

    /** Provenance marker on a drawing entry linked from a provider model. */
    const IMAGE_SOURCE_KEY = "source";
    const IMAGE_API = "openai-images";

    /**
     * The compat switch that selects Anthropic's adaptive thinking request.
     *
     * pi-ai sends `thinking: {type:"adaptive"}` plus `output_config.effort` only
     * for a model whose `compat.forceAdaptiveThinking` is true; without it the
     * request carries the legacy budget form (`thinking.type="enabled"` with
     * `budget_tokens`). A model that requires adaptive thinking answers that
     * legacy request with HTTP 400 — "requires adaptive thinking; omit thinking
     * or use thinking.type=adaptive and output_config.effort". The installed
     * catalog states the flag for the model ids it ships; a route this profile
     * declares by hand has no catalog entry to inherit it from, so the switch
     * has to be written on the model entry here.
     */
    const ADAPTIVE_THINKING_COMPAT_KEY = "forceAdaptiveThinking";
    /**
     * The one wire protocol whose compat takes that switch. `llm-pi-ai` refuses
     * a compat field the model's resolved api does not offer, so the control is
     * shown only on a route whose own configuration names this protocol.
     */
    const ADAPTIVE_THINKING_API = "anthropic-messages";

    function at(value, path) {
      let current = value;
      for (const part of path || []) {
        if (current == null) return undefined;
        current = current[part];
      }
      return current;
    }

    /** The provider's own settings section, where its endpoint and key live. */
    function profileOf(nsView, settingsPath) {
      const profile = at(nsView ? nsView.value : undefined, settingsPath || []);
      return profile && typeof profile === "object" ? profile : undefined;
    }

    function imageModelsOf(ownView) {
      const models = ownView ? ownView.value?.models : undefined;
      return Array.isArray(models) ? models : [];
    }

    /**
     * Derive one drawing entry from the chat provider that already holds the
     * endpoint and credential reference, so linking never asks the user to
     * retype either one.
     */
    function deriveImageEntry(profile, modelId) {
      const base = typeof profile?.baseURL === "string" ? profile.baseURL.trim() : "";
      return {
        model: modelId,
        endpoint: base ? base.replace(/\/+$/, "") + "/images/generations" : "",
        apiKeyEnv: typeof profile?.apiKeyEnv === "string" ? profile.apiKeyEnv.trim() : "",
      };
    }

    /** Whether an entry came from linking this provider model (has provenance). */
    function isManagedEntry(entry, modelId) {
      const source = entry && entry[IMAGE_SOURCE_KEY];
      if (!source || typeof source !== "object" || source.model !== modelId) return false;
      return source.provider === undefined || source.provider === "" || typeof source.provider === "string";
    }

    /** The per-model view of the link: can it link, is it already linked, and where. */
    function computeImageModelState(ownView, profile, modelId) {
      if (!ownView) return { available: false, managed: false, hasEntry: false, entry: null };
      const models = imageModelsOf(ownView);
      const entry = models.find((item) => item && typeof item === "object" && item.model === modelId) ?? null;
      const derived = deriveImageEntry(profile, modelId);
      return {
        available: true,
        managed: !!entry && isManagedEntry(entry, modelId),
        hasEntry: !!entry,
        endpoint: entry ? entry.endpoint : derived.endpoint,
        apiKeyEnv: entry ? entry.apiKeyEnv : derived.apiKeyEnv,
      };
    }

    function normalizeImageEndpoint(value) {
      return typeof value === "string" ? value.trim().replace(/\/+$/, "").replace(/\/images\/generations$/, "") + "/images/generations" : "";
    }

    /** `/v1/images/generations` is the OpenAI address, not the configured one. */
    function acceptableImageEndpoint(value) {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return false;
      } catch {
        return false;
      }
      return !/api\.openai\.com/i.test(value);
    }

    /** The 绘图 schema validates `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. */
    function sanitizeImageId(value) {
      return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
    }

    function uniqueImageId(modelId, models) {
      const taken = new Set(models.filter((item) => item && typeof item.id === "string").map((item) => item.id));
      const base = sanitizeImageId(modelId) || "image-model";
      let id = base;
      for (let i = 2; taken.has(id); i++) id = sanitizeImageId(base.slice(0, 60) + "-" + i);
      return id;
    }

    /**
     * Everything the drawing list needs for an incremental write: only the entry
     * the provider checkbox owns plus the default-model change it implies.
     */
    function planImageLink(ownView, profile, modelId, providerId) {
      const derived = deriveImageEntry(profile, modelId);
      const endpoint = normalizeImageEndpoint(derived.endpoint);
      if (!acceptableImageEndpoint(endpoint)) {
        return { models: null, reason: "该 provider 没有可用的供应商地址（baseURL），请先在「设置 → 模型」里填写后再勾选。" };
      }
      const models = imageModelsOf(ownView).slice();
      const index = models.findIndex((item) => item && typeof item === "object" && item.model === modelId);
      const owned = index >= 0
        ? { ...models[index], model: modelId, endpoint, api: IMAGE_API, [IMAGE_SOURCE_KEY]: { provider: providerId, model: modelId } }
        : { id: uniqueImageId(modelId, models), name: modelId, model: modelId, endpoint, api: IMAGE_API, timeoutSeconds: 300 };
      if (index >= 0 && !owned.apiKeyEnv && derived.apiKeyEnv) owned.apiKeyEnv = derived.apiKeyEnv;
      if (index < 0) {
        if (derived.apiKeyEnv) owned.apiKeyEnv = derived.apiKeyEnv;
        owned[IMAGE_SOURCE_KEY] = { provider: providerId, model: modelId };
      }
      const next = index >= 0 ? models.map((item, i) => (i === index ? owned : item)) : [...models, owned];
      const currentDefault = ownView.value?.defaultModel;
      const defaultModel = typeof currentDefault === "string" && currentDefault ? currentDefault : owned.id;
      return { models: next, defaultModel };
    }

    /** Unlink removes only entries the provider checkbox created (has provenance). */
    function planImageUnlink(ownView, modelId) {
      const models = imageModelsOf(ownView);
      const entry = models.find((item) => item && typeof item === "object" && item.model === modelId);
      if (!entry) return { models: null, reason: "该模型未链接到绘图配置。" };
      // A hand-authored entry is not this checkbox's to remove.
      if (!isManagedEntry(entry, modelId)) return { models: null, reason: "该配置是在「绘图」页手工创建的，请到那边删除。" };
      const next = models.filter((item) => item !== entry);
      const currentDefault = ownView.value?.defaultModel;
      const defaultModel = currentDefault === entry.id ? (next[0]?.id ?? "") : currentDefault;
      return { models: next, defaultModel };
    }

    function readCompatField(nsView, settingsPath, modelId, compatKey) {
      if (!nsView) return undefined;
      const profile = at(nsView.value, settingsPath);
      if (!profile || typeof profile !== "object") return undefined;
      const models = Array.isArray(profile.models) ? profile.models : [];
      const index = models.findIndex((m) => m && typeof m === "object" && m.id === modelId);
      if (index >= 0) {
        const compat = models[index].compat;
        return compat && typeof compat === "object" ? compat[compatKey] : undefined;
      }
      const overrides = profile.modelOverrides;
      if (overrides && typeof overrides === "object" && overrides[modelId] && typeof overrides[modelId] === "object") {
        const compat = overrides[modelId].compat;
        return compat && typeof compat === "object" ? compat[compatKey] : undefined;
      }
      return undefined;
    }

    /**
     * The compat key this page may write for one route, or null when the route
     * cannot take it.
     *
     * The route's own `api` is the only place the protocol is known before a
     * model resolves: a hand-declared route spells it out, while a catalog route
     * omits it and resolves each model's protocol from the installed catalog.
     * The control therefore appears exactly where the switch is both needed (no
     * catalog entry to inherit the flag from) and accepted.
     * @param settingsNs - the provider's settings namespace.
     * @param profile - the route's own settings section.
     * @returns the adaptive-thinking compat key, or null.
     */
    function adaptiveThinkingCompatKey(settingsNs, profile) {
      if (settingsNs !== "llm-pi-ai") return null;
      if (!profile || typeof profile !== "object") return null;
      return profile.api === ADAPTIVE_THINKING_API ? ADAPTIVE_THINKING_COMPAT_KEY : null;
    }

    function computeWriteOps(entry, nsView, modelId, field, value) {
      const ns = entry.settingsNs;
      const settingsPath = entry.settingsPath || [];
      const profile = at(nsView ? nsView.value : undefined, settingsPath);
      const models = (profile && Array.isArray(profile.models)) ? profile.models : [];
      const index = models.findIndex((m) => m && typeof m === "object" && m.id === modelId);
      const basePath = [...settingsPath];
      const usesOverrides = ns === "llm-pi-ai";

      if (value === null) {
        if (index >= 0) {
          const next = models.map((m, i) => {
            if (i !== index) return m;
            const copy = { ...m };
            delete copy[field];
            return copy;
          });
          return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: next }] };
        }
        if (usesOverrides) {
          return { ns, ops: [{ op: "unset", path: [...basePath, "modelOverrides", modelId, field] }] };
        }
        return null;
      }

      if (index >= 0) {
        const next = models.map((m, i) => (i === index ? { ...m, [field]: value } : m));
        return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: next }] };
      }
      if (models.length > 0) {
        return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: [...models, { id: modelId, [field]: value }] }] };
      }
      if (usesOverrides) {
        return { ns, ops: [{ op: "set", path: [...basePath, "modelOverrides", modelId, field], value }] };
      }
      return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: [{ id: modelId, [field]: value }] }] };
    }

    /**
     * The stored `reasoningEfforts` of one model: its `models[]` row first,
     * then (pi-ai) its `modelOverrides` entry; undefined when neither declares it.
     */
    function storedReasoningEfforts(entry, nsView, modelId) {
      const profile = at(nsView ? nsView.value : undefined, entry.settingsPath || []);
      const models = (profile && Array.isArray(profile.models)) ? profile.models : [];
      const row = models.find((m) => m && typeof m === "object" && m.id === modelId);
      if (row && row.reasoningEfforts !== undefined) return row.reasoningEfforts;
      const overrides = profile && profile.modelOverrides && typeof profile.modelOverrides === "object"
        ? profile.modelOverrides[modelId] : undefined;
      return overrides && typeof overrides === "object" ? overrides.reasoningEfforts : undefined;
    }

    /**
     * The `reasoningEfforts` value for a set of checked levels.
     *
     * Since dsh 0.2.1-alpha.4 the official Models page also edits this field and
     * lets each level send its own API value (a gateway spelling `high` as
     * `deep`). Toggling a level here keeps every value already stored for the
     * levels that stay, including a non-null `off`; only a newly added level
     * defaults to its own name.
     * @param levels - checked levels, in any order.
     * @param existing - the stored value, or undefined.
     * @returns `false` for no reasoning, else the level → wire-value dict.
     */
    function reasoningEffortsPayload(levels, existing) {
      const ordered = REASONING_LEVELS.filter((level) => levels.indexOf(level) >= 0);
      if (ordered.length === 0) return false;
      const stored = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
      const dict = { off: stored.off !== undefined ? stored.off : null };
      for (const level of ordered) {
        const wire = stored[level];
        dict[level] = typeof wire === "string" && wire !== "" ? wire : level;
      }
      return dict;
    }

    function computeCompatWriteOps(entry, nsView, modelId, compatKey, value) {
      const ns = entry.settingsNs;
      const settingsPath = entry.settingsPath || [];
      const profile = at(nsView ? nsView.value : undefined, settingsPath);
      const models = (profile && Array.isArray(profile.models)) ? profile.models : [];
      const index = models.findIndex((m) => m && typeof m === "object" && m.id === modelId);
      const basePath = [...settingsPath];
      const usesOverrides = ns === "llm-pi-ai";

      if (index >= 0) {
        const next = models.map((m, i) => {
          if (i !== index) return m;
          const copy = { ...m };
          const compat = copy.compat && typeof copy.compat === "object" ? { ...copy.compat } : {};
          if (value === null) {
            delete compat[compatKey];
          } else {
            compat[compatKey] = value;
          }
          if (Object.keys(compat).length === 0) {
            delete copy.compat;
          } else {
            copy.compat = compat;
          }
          return copy;
        });
        return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: next }] };
      }
      if (models.length > 0) {
        const entryObj = { id: modelId };
        if (value !== null) entryObj.compat = { [compatKey]: value };
        return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: [...models, entryObj] }] };
      }
      if (usesOverrides) {
        const compatPath = [...basePath, "modelOverrides", modelId, "compat"];
        const exists = at(nsView ? nsView.value : undefined, compatPath);
        const compat = exists && typeof exists === "object" ? { ...exists } : {};
        if (value === null) {
          delete compat[compatKey];
        } else {
          compat[compatKey] = value;
        }
        if (Object.keys(compat).length === 0) {
          return { ns, ops: [{ op: "unset", path: compatPath }] };
        }
        return { ns, ops: [{ op: "set", path: compatPath, value: compat }] };
      }
      const entryObj = { id: modelId };
      if (value !== null) entryObj.compat = { [compatKey]: value };
      return { ns, ops: [{ op: "set", path: [...basePath, "models"], value: [entryObj] }] };
    }

    // ── 绘图页组件（ex dsh-plugin-image-generation/client.js，样式前缀统一） ──
    const JOB_KEY = "dsh-image-generation-job";

    function imageField(label, value, change, options = {}) {
      return React.createElement("label", { className: "mcfg-field2", key: label }, label,
        React.createElement("input", { value: value ?? "", onChange: (event) => change(event.target.value), ...options }));
    }
    const freshImageEntry = () => ({ id: "", name: "", model: "", api: "openai-images", endpoint: "https://api.openai.com/v1/images/generations", apiKeyEnv: "IMAGE_API_KEY", timeoutSeconds: 300 })

    /** An entry an earlier version's 模型参数 checkbox linked carries its origin. */
    function managedBy(item) { return item?.source?.provider ? `旧版链接 · ${item.source.provider}` : "" }

    function PanelImage({ call, jobId, index, image }) {
      const [url, setUrl] = React.useState("");
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        let live = true;
        call("image", { jobId, imageIndex: index, original: false }).then((value) => {
          if (live) setUrl(`data:${value.mediaType};base64,${value.data}`);
        }, (error) => { if (live) setError(error.message); });
        return () => { live = false; };
      }, [call, jobId, index]);
      async function download() {
        setBusy(true); setError("");
        try {
          const value = await call("image", { jobId, imageIndex: index, original: true });
          const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: value.mediaType }));
          const anchor = document.createElement("a");
          anchor.href = objectUrl; anchor.download = value.name; anchor.click();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) { setError(error.message); } finally { setBusy(false); }
      }
      return React.createElement("div", { className: "mcfg-card" },
        url ? React.createElement("a", { href: url, target: "_blank", rel: "noreferrer", title: "打开预览" },
          React.createElement("img", { src: url, alt: `生成图片 ${index + 1}` })) : React.createElement("p", null, "正在加载预览…"),
        React.createElement("p", null, `${image.preview.width} × ${image.preview.height} 预览 · 原图 ${(image.original.bytes / 1024).toFixed(0)} KB`),
        image.path ? React.createElement("p", null, image.path) : null,
        React.createElement("button", { onClick: download, disabled: busy }, busy ? "正在下载…" : "下载原图"),
        error ? React.createElement("p", { className: "mcfg-error", role: "alert" }, error) : null);
    }

    function ImagePanel({ remote, call, writable, view, refresh, showToast }) {
      const [form, setForm] = React.useState(null);
      const [editing, setEditing] = React.useState("");
      const [key, setKey] = React.useState("");
      const [catalog, setCatalog] = React.useState(null);
      const [modelQuery, setModelQuery] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [selected, setSelected] = React.useState("");
      const [prompt, setPrompt] = React.useState("");
      const [count, setCount] = React.useState("1");
      const [jobId, setJobId] = React.useState(() => {
        try { return sessionStorage.getItem(JOB_KEY) ?? ""; } catch { return ""; }
      });
      const [job, setJob] = React.useState(null);
      const models = view?.value?.models ?? [];

      React.useEffect(() => {
        if (!jobId) return undefined;
        let live = true;
        let timer;
        async function poll() {
          try {
            const next = await call("status", { jobId });
            if (!live) return;
            setJob(next);
            if (next.status === "running") timer = setTimeout(poll, 1500);
          } catch (error) { if (live) setJob({ status: "error", error: error.message }); }
        }
        void poll();
        return () => { live = false; clearTimeout(timer); };
      }, [call, jobId]);

      async function action(fn) {
        setBusy(true); setNotice("");
        try { await fn(); } catch (error) { showToast("err", error.message); } finally { setBusy(false); }
      }
      /** Re-read our own namespace: the write plan and the revision it is
       *  applied against must come from the same document. */
      async function freshOwn() {
        const response = await remote.settings.describe();
        if (!response.ok) throw new Error(response.error?.message ?? "读取设置失败");
        const found = (response.value?.namespaces ?? []).find((item) => item.ns === NS);
        if (!found) throw new Error("模型调参宿主行未激活，无法写入绘图配置。");
        return found;
      }
      /**
       * Commit one drawing-config edit.
       *
       * Always re-reads immediately before writing. Using the view captured at
       * render time made a page left open across any other write fail on a
       * stale revision — the optimistic lock rejects it and the button
       * silently looks dead.
       * @param buildOps - derives the ops from the freshly read view.
       * @param successMessage - toast shown after the write and refresh.
       */
      async function commit(buildOps, successMessage) {
        const fresh = await freshOwn();
        const response = await remote.settings.mutate(NS, buildOps(fresh), fresh.revision);
        if (!response.ok) throw new Error(response.error?.message ?? "保存失败");
        const refreshed = await refresh();
        if (refreshed === false) throw new Error("已保存，但页面刷新失败，请重新打开本页确认。");
        if (successMessage) showToast("ok", successMessage);
      }
      async function save() {
        const normalized = { ...form, id: form.id.trim(), model: form.model.trim(), endpoint: form.endpoint.trim(), apiKeyEnv: (form.apiKeyEnv ?? "").trim(), timeoutSeconds: Number(form.timeoutSeconds) };
        if (!normalized.model) throw new Error("请从供应商列表选择模型，或手动填写模型 ID。");
        if (key) {
          if (!normalized.apiKeyEnv) throw new Error("保存 Key 前请填写凭据引用。");
          const saved = await remote.credentials.set(normalized.apiKeyEnv, key);
          if (!saved.ok) throw new Error(saved.error?.message ?? "凭据保存失败");
          setKey("");
        }
        // Every field below is derived from the freshly read document, so a
        // page left open across another write can neither fail on a stale
        // revision nor write a stale model list back over it.
        await commit((fresh) => {
          const freshModels = imageModelsOf(fresh);
          // `source` is provenance display only. Editing a linked entry keeps
          // the marker so the row still tells where it came from; the identity
          // fields are editable in place.
          const stored = editing ? freshModels.find((item) => item.id === editing) : undefined;
          if (managedBy(stored)) normalized.source = stored.source;
          const entry = { ...normalized };
          if (!entry.id) {
            const base = entry.model.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 54) || "image-model";
            entry.id = base;
            for (let i = 2; freshModels.some((item) => item.id === entry.id); i++) entry.id = `${base}-${i}`;
          }
          if (freshModels.some((item) => item.id === entry.id && item.id !== editing)) throw new Error("配置 ID 已存在。");
          const next = editing ? freshModels.map((item) => item.id === editing ? entry : item) : [...freshModels, entry];
          const previousDefault = fresh.value?.defaultModel;
          const defaultModel = previousDefault === editing || !previousDefault ? entry.id : previousDefault;
          return [
            { op: "set", path: ["models"], value: next },
            { op: "set", path: ["defaultModel"], value: defaultModel || "" },
          ];
        });
        setForm(null); setEditing(""); setNotice("已保存，下次生成即生效。");
      }
      async function generate() {
        const result = await call("start", { request: { ...(selected ? { model: selected } : {}), prompt, n: Number(count) } });
        try { sessionStorage.setItem(JOB_KEY, result.jobId); } catch { /* Storage may be disabled. */ }
        setJob({ status: "running" }); setJobId(result.jobId);
      }
      async function discover() {
        setCatalog(null);
        const result = await call("discover", { request: {
          endpoint: form.endpoint.trim(), modelsEndpoint: (form.modelsEndpoint ?? "").trim(),
          apiKeyEnv: (form.apiKeyEnv ?? "").trim(), ...(key ? { apiKey: key } : {}),
        } });
        setCatalog(result); setModelQuery("");
      }
      const update = (name) => (value) => {
        if (["endpoint", "modelsEndpoint", "apiKeyEnv"].includes(name)) setCatalog(null);
        setForm((previous) => ({ ...previous, [name]: value }));
      };
      const visibleModels = (catalog?.models ?? []).filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(modelQuery.trim().toLowerCase()));
      const running = job?.status === "running";
      const defaultEntry = models.find((item) => item.id === view?.value?.defaultModel);

      return React.createElement("div", { className: "mcfg-page" },
        notice ? React.createElement("div", { role: "status" }, notice) : null,
        !view ? React.createElement("p", null, "正在读取配置…") : React.createElement("fieldset", { disabled: busy }, React.createElement("legend", null, "绘图模型"),
          React.createElement("p", { className: "mcfg-note" }, "每条配置是一个独立的 OpenAI Images 端点（地址 + Key + 上游模型），与「设置 → 模型」里的聊天模型无关。在模型页勾选「绘图」会自动生成配置；generate_image 默认使用标记为「默认」的那条。"),
          models.length === 0
            ? React.createElement("p", { className: "mcfg-note" }, "尚未配置。点「添加绘图模型」填供应商地址与 Key，再从模型列表里选一个即可。")
            : models.map((item) => {
              const isDefault = view.value?.defaultModel === item.id;
              return React.createElement("div", { className: "mcfg-row mcfg-draw-row", key: item.id },
                React.createElement("label", { className: "mcfg-draw-radio", title: isDefault ? "当前默认绘图模型" : "设为默认绘图模型" },
                  React.createElement("input", {
                    type: "radio",
                    name: "drawing-default",
                    checked: isDefault,
                    disabled: !writable || !!form || isDefault,
                    onChange: () => void action(() => commit(
                      () => [{ op: "set", path: ["defaultModel"], value: item.id }],
                      `已将 ${item.name || item.id} 设为默认`,
                    )),
                  })
                ),
                React.createElement("span", { className: "mcfg-draw-item" },
                  React.createElement("span", { className: "mcfg-draw-name" },
                    item.name || item.id,
                    isDefault ? React.createElement("span", { className: "mcfg-chip mcfg-chip-on" }, "默认") : null
                  ),
                  React.createElement("span", { className: "mcfg-draw-meta" },
                    "配置 " + item.id + " · 上游模型 " + item.model + (managedBy(item) ? " · " + managedBy(item) : "")
                  )
                ),
                React.createElement("div", { className: "mcfg-actions2" },
                  React.createElement("button", { disabled: !writable || !!form, onClick: () => { setForm({ ...item }); setEditing(item.id); setKey(""); setCatalog(null); } }, "编辑"),
                  React.createElement("button", {
                    disabled: !writable || !!form,
                    onClick: () => void action(async () => {
                      await commit((fresh) => {
                        const next = imageModelsOf(fresh).filter((model) => model.id !== item.id);
                        const currentDefault = fresh.value?.defaultModel;
                        return [
                          { op: "set", path: ["models"], value: next },
                          { op: "set", path: ["defaultModel"], value: currentDefault === item.id ? (next[0]?.id ?? "") : (currentDefault ?? "") },
                        ];
                      }, `已删除 ${item.name || item.id}`);
                      if (selected === item.id) setSelected("");
                    }),
                  }, "删除")));
            }),
          React.createElement("div", { className: "mcfg-actions2" },
            React.createElement("button", { className: "mcfg-primary", disabled: !writable || !!form, onClick: () => { setForm(freshImageEntry()); setEditing(""); setKey(""); setCatalog(null); } }, "手动添加端点"),
            React.createElement("button", { onClick: () => void action(async () => { await refresh(); setForm(null); setKey(""); }) }, "重新加载")),
          !writable ? React.createElement("p", { className: "mcfg-note" }, "当前配置只读。") : null),
        form ? React.createElement("fieldset", { disabled: busy }, React.createElement("legend", null, editing ? "编辑绘图模型" : "手动添加端点"),
          React.createElement("p", { className: "mcfg-note" }, "通常不需要手动添加：在「设置 → 模型」里勾选模型行的「绘图」即可自动生成。这里用于没有对应聊天模型的独立端点。填写顺序：供应商 API 地址 → API Key →「获取模型列表」选择模型 → 保存。"),
          imageField("供应商 API 地址", form.endpoint.replace(/\/images\/generations\/?$/, ""), (value) => update("endpoint")(value.replace(/\/+$/, "").replace(/\/images\/generations$/, "") + "/images/generations"), { type: "url", placeholder: "https://api.example.com/v1" }),
          imageField("API Key（留空保留现有值）", key, (value) => { setKey(value); setCatalog(null); }, { type: "password", autoComplete: "new-password" }),
          React.createElement("button", { onClick: () => void action(discover) }, "获取模型列表"),
          catalog ? React.createElement("div", null,
            imageField("搜索供应商模型", modelQuery, setModelQuery, { placeholder: "按名称或模型 ID 搜索" }),
            React.createElement("p", { className: "mcfg-note" }, `供应商返回 ${catalog.models.length} 个模型。列表可能包含聊天模型，请选择供应商明确支持绘图的型号。${catalog.truncated ? "供应商还有后续分页，当前只显示首批结果；未找到的型号可手动填写。" : ""}`),
            React.createElement("div", { className: "mcfg-model-list" }, visibleModels.slice(0, 200).map((item) => React.createElement("button", {
              key: item.id, "aria-pressed": form.model === item.id,
              onClick: () => setForm((previous) => ({ ...previous, model: item.id, name: previous.name || item.name })),
            }, item.name === item.id ? item.id : `${item.name} · ${item.id}`))),
            visibleModels.length === 0 ? React.createElement("p", { className: "mcfg-note" }, "没有匹配的模型，可以更换搜索词或手动填写。") : null,
            visibleModels.length > 200 ? React.createElement("p", { className: "mcfg-note" }, "当前显示前 200 项，请输入关键词缩小范围。") : null) : null,
          imageField("模型 ID", form.model, update("model"), { placeholder: "从列表选择，也可手动填写" }),
          React.createElement("details", null, React.createElement("summary", null, "高级设置（可选）"),
          React.createElement("div", { className: "mcfg-grid" },
            imageField("配置 ID", form.id, update("id"), { placeholder: "留空自动生成", disabled: !!editing }),
            imageField("显示名称", form.name, update("name")),
            imageField("接口类型", "OpenAI Images", () => {}, { disabled: true }),
            imageField("完整生成接口", form.endpoint, update("endpoint"), { type: "url" }),
            imageField("模型列表接口（留空自动推导）", form.modelsEndpoint, update("modelsEndpoint"), { type: "url" }),
            imageField("凭据引用", form.apiKeyEnv, update("apiKeyEnv"), { placeholder: "IMAGE_API_KEY" }),
            imageField("超时（秒）", form.timeoutSeconds, update("timeoutSeconds"), { type: "number", min: 10, max: 600 }),
            ...[["尺寸", "size"], ["质量", "quality"], ["背景", "background"], ["输出格式", "output_format"], ["响应格式", "response_format"], ["风格", "style"]].map(([label, name]) => imageField(`${label}（可选）`, form[name], update(name)))),
          React.createElement("p", { className: "mcfg-note" }, "可选参数留空则不发送。GPT Image 的响应格式请留空。Key 通过 dsh 凭据服务单独保存；同名引用会被其他模型共享。"),
          editing && managedBy(form) ? React.createElement("p", { className: "mcfg-note" }, `该配置来自「设置 → 模型」里勾选的绘图模型（${managedBy(form)}）。推荐回到那边勾选/取消，端点与凭据会自动跟随 provider。`) : null),
          React.createElement("div", { className: "mcfg-actions2" }, React.createElement("button", { onClick: () => void action(save) }, "保存"), React.createElement("button", { onClick: () => { setForm(null); setKey(""); } }, "取消"))) : null,
        React.createElement("details", { className: "mcfg-advanced" },
          React.createElement("summary", null, "直接绘图（可选，不经过聊天）"),
          React.createElement("fieldset", { disabled: busy || running },
            React.createElement("label", { className: "mcfg-field2" }, "绘图模型", React.createElement("select", { value: selected, onChange: (event) => setSelected(event.target.value) },
              React.createElement("option", { value: "" }, "使用默认模型" + (defaultEntry ? `（${defaultEntry.name || defaultEntry.id}）` : "")),
              ...models.map((item) => React.createElement("option", { key: item.id, value: item.id },
                (item.name || item.id) + (view.value?.defaultModel === item.id ? "（默认）" : "") + " · " + item.model)))),
            React.createElement("label", { className: "mcfg-field2" }, "提示词", React.createElement("textarea", { value: prompt, onChange: (event) => setPrompt(event.target.value), placeholder: "描述你想生成的画面…" })),
            imageField("图片数量", count, setCount, { type: "number", min: 1, max: 4 }),
            React.createElement("button", { className: "mcfg-primary", disabled: models.length === 0 || !prompt.trim(), onClick: () => void action(generate) }, "生成图片"),
            React.createElement("p", { className: "mcfg-note" }, "点击生成会调用所选服务，可能产生费用。此面板不发送聊天历史，结果不插入对话。任务预览保留到宿主重启、过期或被后续任务替换前，请及时下载原图。"))),
        running ? React.createElement("div", { role: "status" }, "正在生成… ", React.createElement("button", { onClick: () => void action(async () => { await call("cancel", { jobId }); }) }, "取消等待")) : null,
        job?.status === "error" ? React.createElement("div", { className: "mcfg-error", role: "alert" }, job.error) : null,
        job?.result ? React.createElement("div", { className: "mcfg-gallery" }, job.result.images.map((image, index) => React.createElement(PanelImage, { key: `${jobId}-${index}`, call, jobId, image, index }))) : null);
    }

    // ── 设置页：绘图（v3 后本插件唯一的独立页面） ─────────────────────────
    function DrawingPage(props) {
      const remote = props.remote;
      const timer = props.timer;
      const [view, setView] = React.useState(null);
      const [writable, setWritable] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [toast, setToast] = React.useState(null);

      async function refresh() {
        try {
          const response = await remote.settings.describe();
          if (!response.ok) throw new Error(response.error && response.error.message ? response.error.message : "读取设置失败");
          const namespaces = Array.isArray(response.value?.namespaces) ? response.value.namespaces : [];
          const found = namespaces.find((item) => item && item.ns === NS);
          setView(found ?? null);
          setWritable(response.value?.writable !== false);
          setError(null);
          return true;
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          return false;
        }
      }

      React.useEffect(() => { void refresh(); }, []);

      function showToast(kind, text) {
        setToast({ kind, text });
        if (timer) timer.timeout(() => setToast(null), 3000);
      }

      if (error) return React.createElement("div", { className: "mcfg-state mcfg-error" }, "加载失败：" + error);
      if (!view) return React.createElement("div", { className: "mcfg-state" }, "正在读取绘图配置…");

      return React.createElement("div", { className: "mcfg" },
        React.createElement("div", { className: "mcfg-head" },
          React.createElement("div", { className: "mcfg-title" }, "绘图"),
          React.createElement("div", { className: "mcfg-sub" },
            "这里管理 generate_image 使用的绘图模型。通常不用手动配置：去「设置 → 模型」给某个模型勾选「绘图」即可自动生成一条；标为默认的那条就是 generate_image 的默认模型。"
              + (writable ? "" : "（当前部署为只读，无法保存。）")
          )
        ),
        toast ? React.createElement("div", { className: "mcfg-toast " + (toast.kind === "ok" ? "mcfg-toast-ok" : "mcfg-toast-err") }, toast.text) : null,
        React.createElement(ImagePanel, {
          remote, call: props.call, writable, view, refresh, showToast,
        })
      );
    }

    // ── 官方「设置 → 模型」卡片的扩展：官方没有的兼容开关与目录推理覆盖 ──
    // 页面长度敏感：整段默认折叠（<details>），每个模型一行紧凑控件；
    // 推理档位是复选组，只在点开该模型时才渲染。
    function CompatCard(props) {
      const load = props.load;
      const save = props.save;
      const provider = props.provider;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [openLevels, setOpenLevels] = React.useState("");

      const reload = React.useCallback(async () => {
        try {
          const value = await load(provider.provider);
          setData(value);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
      }, [load, provider.provider]);

      React.useEffect(() => { void reload(); }, [reload]);

      async function commit(kind, modelId, value, message) {
        setBusy(true);
        setToast(null);
        try {
          await save(provider.provider, modelId, kind, value);
          await reload();
          setToast({ kind: "ok", text: message || "已保存，下一次请求生效" });
        } catch (err) {
          setToast({ kind: "err", text: err && err.message ? err.message : String(err) });
        } finally {
          setBusy(false);
        }
      }

      if (error) {
        return React.createElement("div", { className: "mcfg-compat" },
          React.createElement("div", { className: "mcfg-error" }, "兼容设置读取失败：" + error));
      }
      if (!data) return null;
      if (!data.models || data.models.length === 0) return null;
      const editable = !busy && data.writable;
      const overridden = data.models.filter((model) => model.hasOverride).length;

      const imageModels = data.models.filter((model) => model.imageAvailable);
      const linkedCount = imageModels.filter((model) => model.imageLinked).length;
      const toastLine = toast
        ? React.createElement("div", { className: "mcfg-toast " + (toast.kind === "ok" ? "mcfg-toast-ok" : "mcfg-toast-err"), role: "status" }, toast.text)
        : null;

      // Drawing link lives next to the compat switches because both are
      // per-model add-ons to the official Models page; this is also where the
      // old 模型调参 page offered its 「生图模型」 checkbox.
      const drawingSection = imageModels.length === 0 ? null : React.createElement("details", { className: "mcfg-compat" },
        React.createElement("summary", { className: "mcfg-compat-head" },
          React.createElement("span", null, "绘图模型（generate_image）"),
          React.createElement("span", { className: linkedCount > 0 ? "mcfg-chip mcfg-chip-on" : "mcfg-chip" },
            linkedCount > 0 ? linkedCount + " 个已勾选" : "未勾选"),
          React.createElement("span", { className: "mcfg-compat-hint" }, "勾选后自动加入「设置 → 绘图」")
        ),
        React.createElement("div", { className: "mcfg-compat-list" },
          imageModels.map((model) => React.createElement("label", {
            key: model.id, className: "mcfg-draw-check",
            title: "复用本 provider 的地址与凭据引用，自动生成一条绘图配置（generate_image 可直接使用）",
          },
            React.createElement("input", {
              type: "checkbox",
              checked: model.imageLinked,
              disabled: !editable,
              onChange: () => void commit(
                "imageLink",
                model.id,
                !model.imageLinked,
                model.imageLinked ? "已从「设置 → 绘图」移除" : "已加入「设置 → 绘图」",
              ),
            }),
            React.createElement("span", { className: "mcfg-draw-check-name" }, model.name || model.id),
            React.createElement("span", { className: "mcfg-draw-check-meta" },
              model.imageLinked ? "已加入绘图配置" : "未加入")
          ))
        )
      );

      const compatSection = React.createElement("details", { className: "mcfg-compat" },
        React.createElement("summary", { className: "mcfg-compat-head" },
          React.createElement("span", null, "兼容与推理（插件补充）"),
          React.createElement("span", { className: overridden > 0 ? "mcfg-chip mcfg-chip-on" : "mcfg-chip" },
            overridden > 0 ? overridden + " 个模型有覆盖" : data.models.length + " 个模型"),
          React.createElement("span", { className: "mcfg-compat-hint" }, "官方 Models 页没有这些控件")
        ),
        React.createElement("div", { className: "mcfg-compat-list" },
          data.models.map((model) => {
            const levelsOpen = openLevels === model.id;
            return React.createElement("div", { key: model.id, className: "mcfg-compat-row" + (levelsOpen ? " mcfg-compat-row-open" : "") },
              React.createElement("div", { className: "mcfg-compat-line" },
                React.createElement("span", { className: "mcfg-compat-name", title: model.id }, model.name || model.id),
                React.createElement("select", {
                  className: "mcfg-mini-select",
                  title: "系统提示角色：网关报 role 'developer' is not allowed 时选 system（Kimi/DeepSeek 网关常见）",
                  disabled: !editable,
                  value: model.supportsDeveloperRole === undefined ? "auto" : (model.supportsDeveloperRole ? "developer" : "system"),
                  onChange: (event) => {
                    const picked = event.target.value;
                    void commit("supportsDeveloperRole", model.id, picked === "auto" ? null : picked === "developer");
                  },
                },
                  React.createElement("option", { value: "auto" }, "角色：自动"),
                  React.createElement("option", { value: "system" }, "角色：system"),
                  React.createElement("option", { value: "developer" }, "角色：developer")
                ),
                model.adaptiveThinkingEditable ? React.createElement("select", {
                  className: "mcfg-mini-select",
                  title: "思考格式：只接受 adaptive thinking 的模型（Claude Opus 4.6+ / Sonnet 5 等）切到自适应，其余保持自动",
                  disabled: !editable,
                  value: model.adaptiveThinking ? "adaptive" : "auto",
                  onChange: (event) => void commit("adaptiveThinking", model.id, event.target.value === "adaptive" ? true : null),
                },
                  React.createElement("option", { value: "auto" }, "思考：自动"),
                  React.createElement("option", { value: "adaptive" }, "思考：自适应")
                ) : null,
                model.reasoningEditable ? React.createElement("button", {
                  type: "button",
                  className: "mcfg-mini-button" + (levelsOpen ? " mcfg-mini-button-on" : ""),
                  title: "内置目录路由的推理档位（写入 modelOverrides.<id>.reasoningEfforts）：当前 "
                    + (model.levels.length === 0 ? "无档位" : model.levels.join("/"))
                    + "；官方 Models 页只覆盖手写路由",
                  disabled: !editable,
                  onClick: () => setOpenLevels(levelsOpen ? "" : model.id),
                }, (model.levels.length === 0 ? "推理：无" : "推理：" + model.levels.length + " 档")
                  + (model.hasReasoningOverride ? " ·已改" : "")) : null
              ),
              levelsOpen ? React.createElement("div", { className: "mcfg-compat-levels" },
                React.createElement("div", { className: "mcfg-levels" },
                  REASONING_LEVELS.map((level) => React.createElement("label", { key: level, className: "mcfg-level" },
                    React.createElement("input", {
                      type: "checkbox",
                      checked: model.levels.indexOf(level) >= 0,
                      disabled: !editable,
                      onChange: () => {
                        const next = model.levels.slice();
                        const index = next.indexOf(level);
                        if (index >= 0) next.splice(index, 1); else next.push(level);
                        void commit("reasoningLevels", model.id, next);
                      },
                    }),
                    React.createElement("span", null, level)
                  ))
                ),
                React.createElement("div", { className: "mcfg-note" },
                  "不勾选任何档位 = 该模型视为无推理能力；已勾选档位写入该路由的 modelOverrides，官方已存的每档 API 值保持不变。")
              ) : null
            );
          })
        )
      );

      return React.createElement(React.Fragment, null, toastLine, drawingSection, compatSection);
    }

    /** Styles the official Models card extension (collapsed summary + one compact row per model). */
    const COMPAT_CSS = `
.mcfg-compat{display:block;padding:10px 0 2px;border-top:1px dashed rgba(128,128,128,.35);margin-top:12px}
.mcfg-compat>summary{cursor:pointer;display:flex;align-items:center;gap:8px;list-style:none;font-size:12.5px;font-weight:600}
.mcfg-compat>summary::-webkit-details-marker{display:none}
.mcfg-compat>summary::before{content:"▸";font-size:10px;opacity:.6;width:10px}
.mcfg-compat[open]>summary::before{content:"▾"}
.mcfg-compat-hint{font-size:11.5px;font-weight:400;opacity:.55}
.mcfg-compat-list{display:flex;flex-direction:column;gap:2px;padding-top:8px}
.mcfg-compat-row{display:flex;flex-direction:column;gap:6px;padding:5px 8px;border-radius:8px}
.mcfg-compat-row-open{background:rgba(128,128,128,.08)}
.mcfg-compat-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px}
.mcfg-compat-name{font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 130px}
.mcfg-mini-select{font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}
.mcfg-mini-select:disabled{opacity:.5;cursor:not-allowed}
.mcfg-mini-button{font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcfg-mini-button:hover{border-color:rgba(128,128,128,.65)}
.mcfg-mini-button:disabled{opacity:.5;cursor:not-allowed}
.mcfg-mini-button-on{border-color:rgba(80,140,255,.75);background:rgba(80,140,255,.12)}
.mcfg-draw-check{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12.5px;cursor:pointer}
.mcfg-draw-check:hover{background:rgba(128,128,128,.08)}
.mcfg-draw-check input{accent-color:rgb(80,140,255)}
.mcfg-draw-check-name{flex:1 1 130px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcfg-draw-check-meta{font-size:11.5px;opacity:.55}
.mcfg-compat-levels{display:flex;flex-direction:column;gap:6px;padding:2px 0 4px 2px}
`;

    // 2026-09-08 (DSH 0.1.2-rc.1): `ctx.connection.api` no longer exists — the
    // client API lives on the `remote.*` service namespace. Declaring them also
    // defers this plugin until the mux connection is up.
    const inject = ["slots", "remote", "remote.llm", "remote.settings", "remote.session", "remote.credentials", "connection"];

    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-model-tuning";
      style.textContent = CSS + COMPAT_CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => { style.remove(); });

      const remote = ctx.remote;
      const timer = ctx.get("timer");
      const unwrap = (response) => {
        if (!response.ok) throw new Error(response.error && response.error.message ? response.error.message : "请求失败");
        return response.value;
      };
      const call = async (method, args) => unwrap(await ctx.connection.rpc.call("/api", `imageGeneration/${method}`, { args }));

      /** Provider metadata, its settings section and the model catalog, read together. */
      async function compatSnapshot(providerId) {
        const [providers, catalog, settings] = await Promise.all([
          unwrap(await remote.llm.listConfigurableProviders()),
          unwrap(await remote.session.modelCatalog()),
          unwrap(await remote.settings.describe()),
        ]);
        const entry = providers.find((item) => item && item.provider === providerId);
        if (!entry) throw new Error("该 provider 不可配置");
        const namespaces = Array.isArray(settings.namespaces) ? settings.namespaces : [];
        const nsView = namespaces.find((item) => item && item.ns === entry.settingsNs);
        const ownView = namespaces.find((item) => item && item.ns === NS);
        const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
        const group = groups.find((item) => item && item.id === providerId);
        const profile = profileOf(nsView, entry.settingsPath);
        return {
          entry, nsView, ownView, group, profile,
          adaptiveKey: adaptiveThinkingCompatKey(entry.settingsNs, profile),
          writable: settings.writable !== false,
        };
      }

      /** One provider card's compat rows: the switches and the catalog-route levels. */
      async function loadCompat(providerId) {
        const snapshot = await compatSnapshot(providerId);
        const entry = snapshot.entry;
        const nsView = snapshot.nsView;
        const models = ((snapshot.group && snapshot.group.models) || []).map((model) => {
          const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
          const levels = efforts.map((effort) => effort.id).filter((id) => id !== "off");
          const stored = storedReasoningEfforts(entry, nsView, model.id);
          const devRole = entry.settingsNs === "llm-pi-ai"
            ? readCompatField(nsView, entry.settingsPath, model.id, "supportsDeveloperRole")
            : undefined;
          const adaptive = snapshot.adaptiveKey !== null
            ? readCompatField(nsView, entry.settingsPath, model.id, snapshot.adaptiveKey)
            : undefined;
          const image = computeImageModelState(snapshot.ownView, snapshot.profile, model.id);
          const hasBaseURL = typeof snapshot.profile?.baseURL === "string" && snapshot.profile.baseURL.trim() !== "";
          return {
            id: model.id,
            name: model.name,
            supportsDeveloperRole: devRole,
            adaptiveThinking: adaptive === true,
            adaptiveThinkingEditable: snapshot.adaptiveKey !== null && levels.length > 0,
            // The official Models page owns reasoning for hand-declared routes;
            // only installed-catalog routes need this override editor.
            reasoningEditable: entry.settingsNs === "llm-pi-ai" && entry.declared !== true,
            levels: stored === false ? [] : levels,
            hasReasoningOverride: stored !== undefined,
            // Drawing link: only a model whose provider carries a base URL can
            // derive an OpenAI-Images endpoint (and reuse its credential ref).
            imageAvailable: image.available && hasBaseURL,
            imageLinked: image.hasEntry,
            imageManaged: image.managed,
            // Count only fields this plugin actually wrote: catalog-declared
            // reasoning levels are the model's own capability, not an override.
            hasOverride: devRole !== undefined || adaptive !== undefined || stored !== undefined,
          };
        });
        return { writable: snapshot.writable, models };
      }

      /** Apply one compat edit through the provider's own settings namespace. */
      async function saveCompat(providerId, modelId, kind, value) {
        const snapshot = await compatSnapshot(providerId);
        const entry = snapshot.entry;
        const nsView = snapshot.nsView;
        if (kind === "imageLink") {
          // The drawing list lives in this plugin's own namespace; re-read it
          // right before writing so the plan and its revision come from one
          // document (the same discipline the drawing page uses).
          const freshSettings = unwrap(await remote.settings.describe());
          const namespaces = Array.isArray(freshSettings.namespaces) ? freshSettings.namespaces : [];
          const freshOwn = namespaces.find((item) => item && item.ns === NS);
          if (!freshOwn) throw new Error("model-tuning 宿主行未激活，无法写入绘图配置");
          const plan = value === true
            ? planImageLink(freshOwn, snapshot.profile, modelId, providerId)
            : planImageUnlink(freshOwn, modelId);
          if (!plan || !plan.models) throw new Error((plan && plan.reason) || "无法写入绘图配置");
          const response = await remote.settings.mutate(NS, [
            { op: "set", path: ["models"], value: plan.models },
            { op: "set", path: ["defaultModel"], value: plan.defaultModel || "" },
          ], freshOwn.revision);
          if (!response.ok) throw new Error(response.error && response.error.message ? response.error.message : "保存失败");
          return;
        }
        let write;
        if (kind === "supportsDeveloperRole" || kind === "adaptiveThinking") {
          if (value !== null && typeof value !== "boolean") throw new Error("取值必须是布尔值");
          const compatKey = kind === "supportsDeveloperRole" ? "supportsDeveloperRole" : snapshot.adaptiveKey;
          if (compatKey === null || compatKey === undefined) throw new Error("该路由不是 anthropic-messages，不能设置思考格式");
          write = computeCompatWriteOps(entry, nsView, modelId, compatKey, value);
        } else if (kind === "reasoningLevels") {
          const levels = Array.isArray(value) ? value : [];
          for (const level of levels) {
            if (REASONING_LEVELS.indexOf(level) < 0) throw new Error("未知的推理档位：" + level);
          }
          const payload = reasoningEffortsPayload(levels, storedReasoningEfforts(entry, nsView, modelId));
          write = computeWriteOps(entry, nsView, modelId, "reasoningEfforts", payload);
        } else {
          throw new Error("未知的修改类型");
        }
        if (!write) throw new Error("该 provider 不接受这个字段");
        const response = await remote.settings.mutate(write.ns, write.ops);
        if (!response.ok) throw new Error(response.error && response.error.message ? response.error.message : "保存失败");
      }

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "model-tuning", order: 11, label: () => "绘图" },
        () => React.createElement(DrawingPage, { remote, timer, call }),
      ));

      // Official seat for plugins distributed outside the repository: one
      // registration under the pi-ai settings namespace receives every pi-ai
      // provider card (shipped, added and hand-declared alike).
      ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register(
        {
          name: "settings.models.provider-card",
          key: "llm-pi-ai",
          inject: () => ({ load: loadCompat, save: saveCompat }),
        },
        CompatCard,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
