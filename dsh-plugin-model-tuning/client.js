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
/* 模型参数 / 用途 / 绘图 三个页签：v2 起 title-model 与 image-generation
   并入本插件，标题路由与绘图模型列表都是本命名空间自己的字段。 */
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
.mcfg-model-list{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;margin:8px 0}
.mcfg-model-list button{text-align:left;overflow-wrap:anywhere}
.mcfg-model-list button[aria-pressed=true]{border-color:#3987d7;background:#3987d71a}
.mcfg-page details{margin:12px 0}
.mcfg-page summary{cursor:pointer;padding:6px 0}
`;

    /**
     * v2: ONE namespace. Before the merge, three plugins shared this page's
     * writes through two foreign namespaces (`title-model`,
     * `image-generation`). Both are now fields of `model-tuning` itself, so
     * every write below targets ns "model-tuning".
     */
    const NS = "model-tuning";

    /** Provenance marker on an image entry the 模型参数 tab linked. */
    const IMAGE_SOURCE_KEY = "source";
    const IMAGE_API = "openai-images";

    const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const CTX_OPTIONS = [
      { label: "64K", value: 64000 },
      { label: "128K", value: 128000 },
      { label: "256K", value: 256000 },
      { label: "512K", value: 512000 },
      { label: "1M", value: 1000000 },
      { label: "2M", value: 2000000 },
    ];
    const MAX_OPTIONS = [
      { label: "4K", value: 4000 },
      { label: "8K", value: 8000 },
      { label: "16K", value: 16000 },
      { label: "32K", value: 32000 },
      { label: "64K", value: 64000 },
      { label: "128K", value: 128000 },
      { label: "256K", value: 256000 },
      { label: "384K", value: 384000 },
      { label: "512K", value: 512000 },
    ];

    /**
     * Per-namespace settings field where a provider records the input
     * modalities one model accepts. The harness vocabulary is closed
     * (`text` | `image`) at both the adapter and the core content block, so a
     * provider that names no such field is shown without the control.
     */
    const MODALITY_FIELD_BY_NS = {
      "llm-pi-ai": "input",
      "llm-deepseek": "inputModalities",
    };
    /**
     * DeepSeek-side image request budgets. Its schema refuses these on a
     * text-only model, so clearing image capability must clear them too.
     */
    const DEEPSEEK_IMAGE_LIMIT_FIELDS = ["imagePixelBudget", "imageMaxBytes", "imageDetail"];
    /**
     * Tri-state of the control. `auto` states nothing and leaves resolution to
     * the installed catalog entry, then the route's `defaultInput` (default
     * `[text]`); an empty list means the same thing there, never "no modality".
     */
    const MODALITY_CHOICES = ["auto", "text", "text-image"];
    const MODALITY_LABELS = { auto: "自动", text: "纯文本", "text-image": "文本 + 图像" };

    function formatCapacity(n) {
      if (n == null || typeof n !== "number" || !Number.isFinite(n)) return "";
      if (n % 1000000 === 0) return String(n / 1000000) + "M";
      if (n % 1000 === 0) return String(n / 1000) + "K";
      return String(n);
    }

    function parseCapacity(text) {
      if (typeof text !== "string") return null;
      const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
      if (!match) return null;
      const base = parseFloat(match[1]);
      const suffix = match[2].toUpperCase();
      const value = suffix === "K" ? base * 1000 : suffix === "M" ? base * 1000000 : base;
      if (!Number.isInteger(value) || value <= 0) return null;
      return value;
    }

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

    function findNamespace(settingsView, ns) {
      const namespaces = settingsView && Array.isArray(settingsView.namespaces) ? settingsView.namespaces : [];
      return namespaces.find((item) => item && item.ns === ns);
    }

    /** v2: the page's own namespace view — always present once the host row is up. */
    function ownNsView(settingsView) {
      return findNamespace(settingsView, NS);
    }

    /**
     * Derive one image entry from the chat provider that already holds the
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

    /** Whether an entry is ours, in entries stored before the provider was recorded. */
    function isManagedEntry(entry, modelId) {
      const source = entry && entry[IMAGE_SOURCE_KEY];
      if (!source || typeof source !== "object" || source.model !== modelId) return false;
      return source.provider === undefined || source.provider === "" || typeof source.provider === "string";
    }

    /** The per-model view of the link, shared by the checkbox and its note. */
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

    function imageModelsOf(ownView) {
      const models = ownView ? ownView.value?.models : undefined;
      return Array.isArray(models) ? models : [];
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
     * Everything the image list needs for an incremental write: only the entry
     * the 模型参数 tab owns plus the default-model change it implies.
     */
    function planImageLink(ownView, profile, modelId, providerId) {
      const derived = deriveImageEntry(profile, modelId);
      const endpoint = normalizeImageEndpoint(derived.endpoint);
      if (!acceptableImageEndpoint(endpoint)) {
        return { models: null, reason: "该 provider 没有可用的供应商地址（api.baseURL），请先在「模型」页填写后再勾选。" };
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

    /** Unlink removes only the entry the 模型参数 tab created (has provenance). */
    function planImageUnlink(ownView, modelId) {
      const models = imageModelsOf(ownView);
      const entry = models.find((item) => item && typeof item === "object" && item.model === modelId);
      if (!entry) return { models: null, reason: "该模型未链接到绘图配置。" };
      // v2: a hand-authored entry is not this checkbox's to remove — deleting it
      // here would surprise an entry the user built on the 绘图 tab. It can be
      // deleted there directly.
      if (!isManagedEntry(entry, modelId)) return { models: null, reason: "该配置在「绘图」页手工创建，请在那边删除。" };
      const next = models.filter((item) => item !== entry);
      const currentDefault = ownView.value?.defaultModel;
      const defaultModel = currentDefault === entry.id ? (next[0]?.id ?? "") : currentDefault;
      return { models: next, defaultModel };
    }

    function readModelField(nsView, settingsPath, modelId, field) {
      if (!nsView) return undefined;
      const profile = at(nsView.value, settingsPath);
      if (!profile || typeof profile !== "object") return undefined;
      const models = Array.isArray(profile.models) ? profile.models : [];
      const index = models.findIndex((m) => m && typeof m === "object" && m.id === modelId);
      if (index >= 0) return models[index][field];
      const overrides = profile.modelOverrides;
      if (overrides && typeof overrides === "object" && overrides[modelId] && typeof overrides[modelId] === "object") {
        return overrides[modelId][field];
      }
      return undefined;
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

    /** The modality field one provider namespace records, or undefined when it records none. */
    function modalityFieldFor(ns) {
      return MODALITY_FIELD_BY_NS[ns];
    }

    /** Map a raw modality list to the control's tri-state. Absent and empty both mean `auto`. */
    function modalityChoice(raw) {
      if (!Array.isArray(raw) || raw.length === 0) return "auto";
      return raw.indexOf("image") >= 0 ? "text-image" : "text";
    }

    /**
     * Explain what the current state costs, in the terms the harness applies.
     */
    function modalityNote(choice, model) {
      if (choice === "text-image") {
        return "图像输入已开启：贴图与 read_image 可用，下一次请求即生效（无需重启）。";
      }
      if (choice === "text") {
        return "已显式声明为纯文本：附图会在发送前被拒绝，read_image 同样拒绝。";
      }
      if (!model.declared) {
        return "自动：由该 provider 内置的模型目录决定，本页读不到目录内容，不做推测。";
      }
      const route = model.routeDefaultInput;
      if (route && route.indexOf("image") >= 0) {
        return "自动：本路由未逐个声明，跟随路由 defaultInput，其中含图像。";
      }
      return "自动：手写路由没有模型目录可查，落到路由 defaultInput（未设置即为纯文本），"
        + "所以附图会被拒绝。端点确实收图时请选「文本 + 图像」。";
    }

    /**
     * Ops for one modality choice. Non-DeepSeek namespaces write a single
     * field; DeepSeek additionally drops the image request budgets its schema
     * refuses beside a text-only declaration.
     */
    function computeModalityWriteOps(entry, nsView, modelId, choice) {
      const field = modalityFieldFor(entry.settingsNs);
      if (!field) return null;
      const value = choice === "text-image" ? ["text", "image"] : choice === "text" ? ["text"] : null;
      const write = computeWriteOps(entry, nsView, modelId, field, value);
      if (!write || entry.settingsNs !== "llm-deepseek" || choice === "text-image") return write;
      const profile = at(nsView ? nsView.value : undefined, entry.settingsPath || []);
      const models = (profile && Array.isArray(profile.models)) ? profile.models : [];
      const current = models.find((m) => m && typeof m === "object" && m.id === modelId) || {};
      const stale = DEEPSEEK_IMAGE_LIMIT_FIELDS.filter((name) => current[name] !== undefined);
      if (stale.length === 0) return write;
      const modelsOp = write.ops[0];
      modelsOp.value = modelsOp.value.map((m) => {
        if (!m || typeof m !== "object" || m.id !== modelId) return m;
        const copy = { ...m };
        for (const name of stale) delete copy[name];
        return copy;
      });
      return write;
    }

    // ── 用途：标题生成（v2：本插件自己的字段，title* 键） ────────────────────
    /** Same vocabulary as the host schema (`inherit` is the default). */
    const TITLE_MODES = ["inherit", "custom"];

    /**
     * Read the title purpose view out of our own namespace view.
     * @param {object|undefined} settingsView - `remote.settings.describe()` value.
     * @returns the title view; `available` mirrors whether our host row is up.
     */
    function titleViewOf(settingsView) {
      const view = ownNsView(settingsView);
      if (!view) return { available: false, mode: "inherit", provider: null, model: null, revision: null };
      const value = view.value && typeof view.value === "object" ? view.value : {};
      const mode = TITLE_MODES.indexOf(value.titleMode) >= 0 ? value.titleMode : "inherit";
      return {
        available: true,
        mode,
        provider: typeof value.titleProvider === "string" && value.titleProvider !== "" ? value.titleProvider : null,
        model: typeof value.titleModel === "string" && value.titleModel !== "" ? value.titleModel : null,
        revision: typeof view.revision === "number" ? view.revision : null,
      };
    }

    /**
     * Plan the write for one title purpose edit.
     *
     * Always returns the COMPLETE field set: switching back to `inherit` must
     * clear a previously chosen route instead of leaving it behind in the user
     * section, where it would silently stay authoritative for a later switch.
     */
    function planTitleWrite(next) {
      const mode = next && next.mode === "custom" ? "custom" : "inherit";
      if (mode === "inherit") {
        return { ns: NS, ops: [
          { op: "unset", path: ["titleMode"] },
          { op: "unset", path: ["titleProvider"] },
          { op: "unset", path: ["titleModel"] },
        ] };
      }
      return { ns: NS, ops: [
        { op: "set", path: ["titleMode"], value: "custom" },
        { op: "set", path: ["titleProvider"], value: String(next.provider || "") },
        { op: "set", path: ["titleModel"], value: String(next.model || "") },
      ] };
    }

    function CapacityField(props) {
      const value = props.value;
      const options = props.options;
      const matched = value != null ? options.find((o) => o.value === value) : undefined;
      const [mode, setMode] = React.useState(matched ? "option" : "custom");
      const [text, setText] = React.useState(value != null ? formatCapacity(value) : "");

      React.useEffect(() => {
        const m = value != null ? options.find((o) => o.value === value) : undefined;
        setMode(m ? "option" : "custom");
        setText(value != null ? formatCapacity(value) : "");
      }, [value]);

      function commit() {
        const parsed = parseCapacity(text);
        if (parsed == null) {
          props.onToast("err", "请输入正整数，可用 K/M 后缀（如 256K、1M）");
          setText(value != null ? formatCapacity(value) : "");
          return;
        }
        if (parsed === value) return;
        props.onApply(props.provider, props.model, props.kind, parsed);
      }

      return React.createElement("label", { className: "mcfg-field" },
        React.createElement("span", { className: "mcfg-label" }, props.label),
        React.createElement("div", { className: "mcfg-fieldrow" },
          React.createElement("select", {
            className: "mcfg-select",
            disabled: props.disabled,
            value: mode === "option" ? String(value) : "__custom__",
            onChange: (e) => {
              if (e.target.value === "__custom__") {
                setMode("custom");
                setText(value != null ? formatCapacity(value) : "");
              } else {
                setMode("option");
                props.onApply(props.provider, props.model, props.kind, Number(e.target.value));
              }
            },
          },
            options.map((o) => React.createElement("option", { key: o.value, value: String(o.value) }, o.label)),
            React.createElement("option", { value: "__custom__" }, "自定义…")
          ),
          mode === "custom" ? React.createElement("input", {
            className: "mcfg-input mcfg-custom",
            type: "text",
            disabled: props.disabled,
            value: text,
            placeholder: "如 256K / 1M",
            onChange: (e) => setText(e.target.value),
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
          }) : null
        )
      );
    }

    // ── 绘图页组件（ex dsh-plugin-image-generation/client.js，样式前缀统一） ──
    const JOB_KEY = "dsh-image-generation-job";

    function imageField(label, value, change, options = {}) {
      return React.createElement("label", { className: "mcfg-field2", key: label }, label,
        React.createElement("input", { value: value ?? "", onChange: (event) => change(event.target.value), ...options }));
    }
    const freshImageEntry = () => ({ id: "", name: "", model: "", api: "openai-images", endpoint: "https://api.openai.com/v1/images/generations", apiKeyEnv: "IMAGE_API_KEY", timeoutSeconds: 300 })

    /** An entry the 模型参数 tab linked carries its origin. */
    function managedBy(item) { return item?.source?.provider ? `模型参数 · ${item.source.provider}` : "" }

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
       * Always re-reads immediately before writing (the same discipline the
       * 模型参数 tab uses). Using the view captured at render time made a page
       * left open across any other write fail on a stale revision — the
       * optimistic lock rejects it and the button silently looks dead.
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
          // v2: `source` is provenance display only. Editing a linked entry
          // keeps the marker (so 模型参数 still shows where it came from), but
          // its identity fields are now editable in place — one plugin owns
          // both tabs.
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

      return React.createElement("div", { className: "mcfg-page" },
        React.createElement("p", { className: "mcfg-note" }, "独立配置绘图模型。可在聊天中让助手调用 generate_image，也可在下方直接生成。接口使用 OpenAI Images 协议。"),
        notice ? React.createElement("div", { role: "status" }, notice) : null,
        !view ? React.createElement("p", null, "正在读取配置…") : React.createElement("fieldset", { disabled: busy }, React.createElement("legend", null, "绘图模型"),
          models.length === 0 ? React.createElement("p", { className: "mcfg-note" }, "尚未配置。添加模型后即可绘图；也可在「模型参数」页勾选生图模型自动生成。") : models.map((item) => React.createElement("div", { className: "mcfg-row", key: item.id },
            React.createElement("span", null, `${item.name || item.id} · ${item.model}${view.value.defaultModel === item.id ? " · 默认" : ""}${managedBy(item) ? " · " + managedBy(item) : ""}`),
            React.createElement("div", { className: "mcfg-actions2" },
              React.createElement("button", { disabled: !writable || !!form, onClick: () => { setForm({ ...item }); setEditing(item.id); setKey(""); setCatalog(null); } }, "编辑"),
              React.createElement("button", {
                // Disabled on the entry that already IS the default: the button
                // then states a fact instead of pretending to act.
                disabled: !writable || !!form || view.value?.defaultModel === item.id,
                onClick: () => void action(() => commit(
                  () => [{ op: "set", path: ["defaultModel"], value: item.id }],
                  `已将 ${item.name || item.id} 设为默认`,
                )),
              }, view.value?.defaultModel === item.id ? "当前默认" : "设为默认"),
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
              }, "删除")))),
          React.createElement("div", { className: "mcfg-actions2" },
            React.createElement("button", { disabled: !writable || !!form, onClick: () => { setForm(freshImageEntry()); setEditing(""); setKey(""); setCatalog(null); } }, "添加模型"),
            React.createElement("button", { onClick: () => void action(async () => { await refresh(); setForm(null); setKey(""); }) }, "重新加载")),
          !writable ? React.createElement("p", { className: "mcfg-note" }, "当前配置只读。") : null),
        form ? React.createElement("fieldset", { disabled: busy }, React.createElement("legend", null, editing ? "编辑模型" : "添加模型"),
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
          editing && managedBy(form) ? React.createElement("p", { className: "mcfg-note" }, `该配置最初由「模型参数」页从 ${managedBy(form)} 链接生成；如需同步 provider 最新地址，可在那边取消勾选后重新勾选，或直接在此修改。`) : null),
          React.createElement("div", { className: "mcfg-actions2" }, React.createElement("button", { onClick: () => void action(save) }, "保存"), React.createElement("button", { onClick: () => { setForm(null); setKey(""); } }, "取消"))) : null,
        React.createElement("fieldset", { disabled: busy || running }, React.createElement("legend", null, "直接绘图"),
          React.createElement("label", { className: "mcfg-field2" }, "绘图模型", React.createElement("select", { value: selected, onChange: (event) => setSelected(event.target.value) },
            React.createElement("option", { value: "" }, "使用默认模型"), ...models.map((item) => React.createElement("option", { key: item.id, value: item.id }, item.name || item.id)))),
          React.createElement("label", { className: "mcfg-field2" }, "提示词", React.createElement("textarea", { value: prompt, onChange: (event) => setPrompt(event.target.value), placeholder: "描述你想生成的画面…" })),
          imageField("图片数量", count, setCount, { type: "number", min: 1, max: 4 }),
          React.createElement("button", { disabled: models.length === 0 || !prompt.trim(), onClick: () => void action(generate) }, "生成图片"),
          React.createElement("p", { className: "mcfg-note" }, "点击生成会调用所选服务，可能产生费用。此面板不发送聊天历史，结果不插入对话。任务预览保留到宿主重启、过期或被后续任务替换前，请及时下载原图。")),
        running ? React.createElement("div", { role: "status" }, "正在生成… ", React.createElement("button", { onClick: () => void action(async () => { await call("cancel", { jobId }); }) }, "取消等待")) : null,
        job?.status === "error" ? React.createElement("div", { className: "mcfg-error", role: "alert" }, job.error) : null,
        job?.result ? React.createElement("div", { className: "mcfg-gallery" }, job.result.images.map((image, index) => React.createElement(PanelImage, { key: `${jobId}-${index}`, call, jobId, image, index }))) : null);
    }

    function ModelTuningPage(props) {
      const api = props.api;
      const timer = props.timer;
      const [data, setData] = React.useState(null);
      const [ownView, setOwnView] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [query, setQuery] = React.useState("");
      const [tab, setTab] = React.useState("models");
      const [title, setTitle] = React.useState(null);
      const [titleDraft, setTitleDraft] = React.useState(null);
      const [titleBusy, setTitleBusy] = React.useState(false);

      async function reload() {
        try {
          const [providersRes, modelsRes, settingsRes] = await Promise.all([
            api.llm.providers({}),
            api.llm.models({}),
            api.settings.describe({}),
          ]);
          if (!providersRes.result.ok) throw new Error(providersRes.result.error.message);
          if (!modelsRes.result.ok) throw new Error(modelsRes.result.error.message);
          if (!settingsRes.result.ok) throw new Error(settingsRes.result.error.message);

          const providers = providersRes.result.value.providers;
          const groups = modelsRes.result.value.groups;
          const namespaces = settingsRes.result.value.namespaces;
          const writable = settingsRes.result.value.writable;

          const metaByProvider = new Map(providers.map((p) => [p.provider, p]));
          const nsByNs = new Map(namespaces.map((n) => [n.ns, n]));
          // v2: our own view; absent only when our host row failed to activate.
          const view = ownNsView(settingsRes.result.value);
          setTitle(titleViewOf(settingsRes.result.value));
          setTitleDraft(null);
          setError(null);

          const built = { writable, providers: [] };
          for (const group of groups) {
            const entry = metaByProvider.get(group.id);
            const nsView = entry ? nsByNs.get(entry.settingsNs) : undefined;
            const providerProfile = profileOf(nsView, entry ? entry.settingsPath : []);
            const reasoningEditable = !!(entry && entry.settingsNs === "llm-pi-ai");
            const routeDefaultInput = providerProfile && Array.isArray(providerProfile.defaultInput)
              ? providerProfile.defaultInput
              : null;
            const models = group.models.map((m) => {
              const ctx = readModelField(nsView, entry ? entry.settingsPath : [], m.id, "contextWindow");
              const mx = readModelField(nsView, entry ? entry.settingsPath : [], m.id, "maxTokens");
              const devRole = entry && entry.settingsNs === "llm-pi-ai"
                ? readCompatField(nsView, entry.settingsPath, m.id, "supportsDeveloperRole")
                : undefined;
              const modalityField = entry ? modalityFieldFor(entry.settingsNs) : undefined;
              const rawInput = modalityField
                ? readModelField(nsView, entry.settingsPath, m.id, modalityField)
                : undefined;
              const image = computeImageModelState(view, providerProfile, m.id);
              return {
                id: m.id,
                name: m.name,
                description: m.description != null ? m.description : null,
                contextWindow: ctx != null ? ctx : null,
                maxTokens: mx != null ? mx : null,
                supportsDeveloperRole: devRole,
                modalityField: modalityField || null,
                modality: modalityField ? modalityChoice(rawInput) : null,
                imageAvailable: image.available,
                imageLinked: image.hasEntry,
                imageManaged: image.managed,
                imageEndpoint: image.endpoint || null,
                imageApiKeyEnv: image.apiKeyEnv || null,
                declared: !!(entry && entry.declared),
                routeDefaultInput: routeDefaultInput,
                efforts: (m.reasoning && Array.isArray(m.reasoning.efforts)) ? m.reasoning.efforts.map((e) => ({ id: e.id, name: e.name })) : [],
                defaultEffort: (m.reasoning && m.reasoning.defaultEffort != null) ? m.reasoning.defaultEffort : null,
              };
            });
            built.providers.push({
              provider: group.id,
              name: group.name,
              configurable: !!entry,
              reasoningEditable,
              imageNsAvailable: !!view,
              models,
            });
          }
          const imageModels = imageModelsOf(view);
          const linkedIds = new Set(imageModels.filter((item) => item && item.model).map((item) => item.model));
          for (const row of built.providers) {
            row.imageLinkedCount = row.models.filter((m) => linkedIds.has(m.id)).length;
          }
          built.imageModels = imageModels.map((item) => item?.model).filter(Boolean);
          built.imageDefault = typeof view?.value?.defaultModel === "string" ? view.value.defaultModel : "";
          setData(built);
          setOwnView(view ?? null);
          setError(null);
          return true;
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          return false;
        } finally {
          setLoading(false);
        }
      }

      React.useEffect(() => {
        reload();
      }, []);

      function showToast(kind, text) {
        setToast({ kind, text });
        if (timer) timer.timeout(() => setToast(null), 3000);
      }

      async function applyChange(provider, model, kind, value) {
        try {
          const [providersRes, settingsRes] = await Promise.all([
            api.llm.providers({}),
            api.settings.describe({}),
          ]);
          if (!providersRes.result.ok) throw new Error(providersRes.result.error.message);
          if (!settingsRes.result.ok) throw new Error(settingsRes.result.error.message);

          const entry = providersRes.result.value.providers.find((p) => p.provider === provider);
          if (!entry) throw new Error("该 provider 不可配置");
          const nsView = settingsRes.result.value.namespaces.find((n) => n.ns === entry.settingsNs);

          if (kind === "imageLink") {
            // Re-read immediately before writing, so the plan and the revision
            // it is applied against come from the same document.
            const freshRes = await api.settings.describe({});
            if (!freshRes.result.ok) throw new Error(freshRes.result.error.message);
            const freshView = ownNsView(freshRes.result.value);
            if (!freshView) throw new Error("模型调参宿主行未激活，无法写入绘图配置。");
            const providerProfile = profileOf(nsView, entry.settingsPath);
            const plan = value === true
              ? planImageLink(freshView, providerProfile, model, provider)
              : planImageUnlink(freshView, model);
            if (!plan || !plan.models) throw new Error((plan && plan.reason) || "无法写入绘图配置");
            const written = await api.settings.mutate({
              ns: NS,
              ops: [
                { op: "set", path: ["models"], value: plan.models },
                { op: "set", path: ["defaultModel"], value: plan.defaultModel || "" },
              ],
              expectedRevision: freshView.revision,
            });
            if (!written.result.ok) throw new Error(written.result.error.message);
            showToast("ok", value === true ? "已在「绘图」页生成模型配置" : "已取消生图标记");
            await reload();
            return;
          }

          let field;
          let payload;
          if (kind === "reasoningLevels") {
            field = "reasoningEfforts";
            const raw = value && Array.isArray(value.levels) ? value.levels : [];
            const levels = REASONING_LEVELS.filter((level) => raw.indexOf(level) >= 0);
            if (levels.length === 0) {
              payload = false;
            } else {
              const dict = { off: null };
              for (const level of levels) dict[level] = level;
              payload = dict;
            }
          } else if (kind === "contextWindow" || kind === "maxTokens") {
            field = kind;
            if (value != null && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
              throw new Error("取值必须是正整数");
            }
            payload = value;
          } else if (kind === "supportsDeveloperRole") {
            if (value !== null && typeof value !== "boolean") {
              throw new Error("取值必须是布尔值");
            }
            const write = computeCompatWriteOps(entry, nsView, model, "supportsDeveloperRole", value);
            if (write) {
              const res = await api.settings.mutate({ ns: write.ns, ops: write.ops });
              if (!res.result.ok) throw new Error(res.result.error.message);
            }
            showToast("ok", "已保存");
            await reload();
            return;
          } else if (kind === "modalities") {
            if (MODALITY_CHOICES.indexOf(value) < 0) throw new Error("未知的模态取值");
            const write = computeModalityWriteOps(entry, nsView, model, value);
            if (!write) throw new Error("该 provider 不接受模态声明");
            const res = await api.settings.mutate({ ns: write.ns, ops: write.ops });
            if (!res.result.ok) throw new Error(res.result.error.message);
            showToast("ok", value === "text-image" ? "已开启图像输入，下一次请求即生效" : "已保存");
            await reload();
            return;
          } else {
            throw new Error("未知的修改类型");
          }

          const write = computeWriteOps(entry, nsView, model, field, payload);
          if (write) {
            const res = await api.settings.mutate({ ns: write.ns, ops: write.ops });
            if (!res.result.ok) throw new Error(res.result.error.message);
          }
          showToast("ok", "已保存");
          await reload();
        } catch (err) {
          showToast("err", err && err.message ? err.message : String(err));
        }
      }

      if (loading) {
        return React.createElement("div", { className: "mcfg-state" }, "正在加载模型配置…");
      }
      if (error) {
        return React.createElement("div", { className: "mcfg-state mcfg-error" }, "加载失败：" + error);
      }

      /** The effective title selection: an unsaved draft wins over the stored value. */
      const titleShown = titleDraft || title || { available: false, mode: "inherit", provider: null, model: null, revision: null };
      const titleProviders = data && data.providers ? data.providers : [];
      const titleProvider = titleProviders.find((p) => p.provider === titleShown.provider) || null;
      const titleModels = titleProvider ? titleProvider.models : [];
      const titleDirty = !!title && (
        titleShown.mode !== title.mode
        || (titleShown.provider || null) !== (title.provider || null)
        || (titleShown.model || null) !== (title.model || null)
      );
      const titleSaveDisabled = !data || !data.writable || !titleShown.available || titleBusy
        || (titleShown.mode === "custom" && (!titleShown.provider || !titleShown.model));

      function editTitleDraft(patch) {
        setTitleDraft({ ...titleShown, ...patch });
      }

      async function saveTitle() {
        const payload = titleShown.mode === "custom"
          ? { mode: "custom", provider: titleShown.provider, model: titleShown.model }
          : { mode: "inherit" };
        setTitleBusy(true);
        let saved = false;
        try {
          const write = planTitleWrite(payload);
          const res = await api.settings.mutate({ ns: write.ns, ops: write.ops });
          if (!res.result.ok) throw new Error(res.result.error.message);
          saved = true;
        } catch (err) {
          showToast("err", err && err.message ? err.message : String(err));
        } finally {
          setTitleBusy(false);
        }
        if (!saved) return;
        showToast("ok", "标题生成设置已保存，对之后生成的标题生效");
        if (!await reload()) showToast("err", "设置已保存，但页面数据刷新失败，请重新打开本页确认。");
      }

      const q = query.trim().toLowerCase();
      const filtered = !data || !data.providers || data.providers.length === 0 ? [] : q.length === 0 ? data.providers : data.providers.map((provider) => {
        const providerMatch = provider.name.toLowerCase().indexOf(q) >= 0 || provider.provider.toLowerCase().indexOf(q) >= 0;
        const models = providerMatch ? provider.models : provider.models.filter((m) =>
          m.id.toLowerCase().indexOf(q) >= 0 ||
          m.name.toLowerCase().indexOf(q) >= 0 ||
          (m.description || "").toLowerCase().indexOf(q) >= 0
        );
        return models.length > 0 ? { ...provider, models } : null;
      }).filter(Boolean);
      const totalMatched = filtered.reduce((n, p) => n + p.models.length, 0);

      const tabButton = (id, label) => React.createElement("button", {
        key: id,
        type: "button",
        className: "mcfg-tab" + (tab === id ? " mcfg-tab-on" : ""),
        "aria-pressed": tab === id,
        onClick: () => setTab(id),
      }, label);
      const tabBar = React.createElement("div", { className: "mcfg-tabs", role: "tablist" },
        tabButton("models", "模型参数"),
        tabButton("purpose", "用途"),
        tabButton("image", "绘图")
      );

      const modelsPanel = [
        React.createElement("div", { className: "mcfg-searchrow", key: "search" },
          React.createElement("input", {
            className: "mcfg-search",
            type: "text",
            value: query,
            placeholder: "搜索模型 / provider…",
            onChange: (e) => setQuery(e.target.value),
          }),
          query.trim().length > 0 ? React.createElement("span", { className: "mcfg-count" }, totalMatched + " 个模型") : null
        ),
        data.imageModels.length > 0
          ? React.createElement("div", { className: "mcfg-note", key: "img" },
              "绘图页当前 " + data.imageModels.length + " 个配置：" + data.imageModels.join("、")
                + (data.imageDefault ? "（默认 " + data.imageDefault + "）" : "（未设默认，generate_image 需显式指定）"))
          : React.createElement("div", { className: "mcfg-note", key: "img" }, "绘图页尚未配置任何模型。"),
        !data.providers || data.providers.length === 0
          ? React.createElement("div", { className: "mcfg-state", key: "none" }, "当前没有已注册的模型。")
          : filtered.length === 0
            ? React.createElement("div", { className: "mcfg-state", key: "empty" }, "没有匹配的模型。")
            : filtered.map((provider) =>
              React.createElement("div", { key: provider.provider, className: "mcfg-provider" },
                React.createElement("div", { className: "mcfg-provider-name" },
                  provider.name,
                  React.createElement("span", { className: "mcfg-provider-id" }, provider.provider)
                ),
                provider.models.map((model) => {
                  const editable = data.writable && provider.configurable;
                  const selectedLevels = new Set((model.efforts || []).filter((e) => e.id !== "off").map((e) => e.id));

                  return React.createElement("div", { key: model.id, className: "mcfg-model" },
                    React.createElement("div", { className: "mcfg-model-head" },
                      React.createElement("div", { className: "mcfg-model-title" },
                        React.createElement("span", { className: "mcfg-model-name" }, model.name),
                        React.createElement("span", { className: "mcfg-model-id" }, model.id),
                        model.modality === "text-image"
                          ? React.createElement("span", { className: "mcfg-chip mcfg-chip-on" }, "图像输入")
                          : null,
                        model.imageLinked
                          ? React.createElement("span", { className: "mcfg-chip mcfg-chip-on" }, "生图模型")
                          : null
                      )
                    ),
                    model.description ? React.createElement("div", { className: "mcfg-desc" }, model.description) : null,
                    provider.reasoningEditable ? React.createElement("div", { className: "mcfg-reasoning" },
                      React.createElement("span", { className: "mcfg-label" }, "可选推理档位"),
                      React.createElement("div", { className: "mcfg-levels" },
                        REASONING_LEVELS.map((level) =>
                          React.createElement("label", { key: level, className: "mcfg-level" },
                            React.createElement("input", {
                              type: "checkbox",
                              checked: selectedLevels.has(level),
                              onChange: () => {
                                const next = new Set(selectedLevels);
                                if (next.has(level)) next.delete(level); else next.add(level);
                                applyChange(provider.provider, model.id, "reasoningLevels", { levels: [...next] });
                              },
                            }),
                            React.createElement("span", null, level)
                          )
                        )
                      ),
                      selectedLevels.size === 0 ? React.createElement("div", { className: "mcfg-note" }, "未勾选任何档位 → 该模型视为无推理能力") : null
                    ) : React.createElement("div", { className: "mcfg-reasoning" },
                      React.createElement("span", { className: "mcfg-label" }, "推理档位（由 provider 固定）"),
                      React.createElement("div", { className: "mcfg-levels" },
                        (model.efforts || []).map((effort) =>
                          React.createElement("span", { key: effort.id, className: "mcfg-chip" }, effort.name)
                        )
                      )
                    ),
                    provider.reasoningEditable ? React.createElement("div", { className: "mcfg-reasoning" },
                      React.createElement("span", { className: "mcfg-label" }, "系统提示角色（兼容开关）"),
                      React.createElement("div", { className: "mcfg-levels" },
                        ["auto", "system", "developer"].map((role) =>
                          React.createElement("label", { key: role, className: "mcfg-level" },
                            React.createElement("input", {
                              type: "radio",
                              name: "devrole-" + model.id,
                              checked: role === "auto"
                                ? model.supportsDeveloperRole === undefined
                                : (role === "developer" ? model.supportsDeveloperRole === true : model.supportsDeveloperRole === false),
                              onChange: () => {
                                if (role === "auto") {
                                  applyChange(provider.provider, model.id, "supportsDeveloperRole", null);
                                } else {
                                  applyChange(provider.provider, model.id, "supportsDeveloperRole", role === "developer");
                                }
                              },
                            }),
                            React.createElement("span", null,
                              role === "auto" ? "自动" : (role === "system" ? "system（推荐 Kimi/DeepSeek）" : "developer")
                            )
                          )
                        )
                      ),
                      React.createElement("div", { className: "mcfg-note" },
                        "自动：跟随网关检测；如遇 role 'developer' is not allowed，请选 system"
                      )
                    ) : null,
                    model.modalityField ? React.createElement("div", { className: "mcfg-reasoning" },
                      React.createElement("span", { className: "mcfg-label" }, "输入模态（写入 " + model.modalityField + "）"),
                      React.createElement("div", { className: "mcfg-levels" },
                        MODALITY_CHOICES.map((choice) =>
                          React.createElement("label", { key: choice, className: "mcfg-level" },
                            React.createElement("input", {
                              type: "radio",
                              name: "modality-" + model.id,
                              disabled: !editable,
                              checked: model.modality === choice,
                              onChange: () => applyChange(provider.provider, model.id, "modalities", choice),
                            }),
                            React.createElement("span", null, MODALITY_LABELS[choice])
                          )
                        )
                      ),
                      React.createElement("div", { className: "mcfg-note" },
                        modalityNote(model.modality, model)
                      )
                    ) : null,
                    model.imageAvailable ? React.createElement("div", { className: "mcfg-reasoning" },
                      React.createElement("span", { className: "mcfg-label" }, "生图模型"),
                      React.createElement("div", { className: "mcfg-img-actions" },
                        React.createElement("label", { className: "mcfg-level" },
                          React.createElement("input", {
                            type: "checkbox",
                            checked: model.imageLinked,
                            disabled: !editable,
                            onChange: () => applyChange(provider.provider, model.id, "imageLink", !model.imageLinked),
                          }),
                          React.createElement("span", null, "在「绘图」页自动配置该模型")
                        ),
                        model.imageLinked ? React.createElement("span", { className: "mcfg-chip mcfg-chip-on" }, "已在绘图页配置") : null
                      ),
                      React.createElement("div", { className: "mcfg-note" },
                        model.imageLinked
                          ? "端点 " + (model.imageEndpoint || "（未填写）") + (model.imageApiKeyEnv ? "，凭据 " + model.imageApiKeyEnv : "")
                            + "。取消勾选会移除该配置；也可以直接在「绘图」页编辑或删除它。"
                          : "勾选后写入「绘图」页的模型列表（模型 ID 复用 " + model.id + "，端点由本 provider 的供应商地址加 /images/generations 推导）。"
                      )
                    ) : null,
                    React.createElement("div", { className: "mcfg-fields" },
                      React.createElement(CapacityField, {
                        label: "上下文窗口", options: CTX_OPTIONS, value: model.contextWindow, disabled: !editable,
                        provider: provider.provider, model: model.id, kind: "contextWindow", onApply: applyChange, onToast: showToast,
                      }),
                      React.createElement(CapacityField, {
                        label: "最大输出", options: MAX_OPTIONS, value: model.maxTokens, disabled: !editable,
                        provider: provider.provider, model: model.id, kind: "maxTokens", onApply: applyChange, onToast: showToast,
                      })
                    )
                  );
                })
              )
            )
      ];

      // ── 用途页 ────────────────────────────────────────────────────────────
      const purposePanel = [
        React.createElement("div", { className: "mcfg-purpose", key: "title" },
          React.createElement("div", { className: "mcfg-purpose-head" },
            React.createElement("span", { className: "mcfg-purpose-name" }, "标题生成"),
            React.createElement("span", { className: "mcfg-chip" }, "独立请求"),
            title && title.available
              ? React.createElement("span", { className: "mcfg-chip mcfg-chip-on" }, "已启用")
              : React.createElement("span", { className: "mcfg-chip" }, "宿主行未激活")
          ),
          React.createElement("div", { className: "mcfg-desc" },
            "会话标题由一次独立的辅助请求生成，不会改动对话模型。默认继承当前会话的 provider / model。"
          ),
          !titleShown.available
            ? React.createElement("div", { className: "mcfg-state mcfg-error" },
                "未检测到 model-tuning 设置命名空间：宿主半区未激活（标题 provider 未注册），请检查插件是否启用并重启 dsh。"
              )
            : [
                React.createElement("div", { className: "mcfg-radio", key: "mode" },
                  React.createElement("label", { className: "mcfg-radio-row" },
                    React.createElement("input", {
                      type: "radio",
                      name: "title-mode",
                      checked: titleShown.mode === "inherit",
                      disabled: !data.writable || titleBusy,
                      onChange: () => editTitleDraft({ mode: "inherit", provider: null, model: null }),
                    }),
                    React.createElement("span", null,
                      "继承当前会话（默认）",
                      React.createElement("div", { className: "mcfg-note" },
                        "标题请求沿用该会话已记录的 provider / model，行为与内置标题生成一致。")
                    )
                  ),
                  React.createElement("label", { className: "mcfg-radio-row" },
                    React.createElement("input", {
                      type: "radio",
                      name: "title-mode",
                      checked: titleShown.mode === "custom",
                      disabled: !data.writable || titleBusy,
                      onChange: () => {
                        const fallback = titleProviders[0];
                        editTitleDraft({
                          mode: "custom",
                          provider: titleShown.provider || (fallback ? fallback.provider : null),
                          model: titleShown.model || (fallback && fallback.models[0] ? fallback.models[0].id : null),
                        });
                      },
                    }),
                    React.createElement("span", null,
                      "使用指定模型",
                      React.createElement("div", { className: "mcfg-note" },
                        "标题请求改投所选 provider / model；会话的对话模型保持不变。")
                    )
                  )
                ),
                titleShown.mode === "custom"
                  ? React.createElement("div", { className: "mcfg-fields", key: "route" },
                      React.createElement("label", { className: "mcfg-field" },
                        React.createElement("span", { className: "mcfg-label" }, "Provider"),
                        React.createElement("select", {
                          className: "mcfg-select",
                          disabled: !data.writable || titleBusy,
                          value: titleShown.provider || "",
                          onChange: (e) => {
                            const next = titleProviders.find((p) => p.provider === e.target.value);
                            editTitleDraft({
                              provider: e.target.value,
                              model: next && next.models[0] ? next.models[0].id : null,
                            });
                          },
                        },
                          React.createElement("option", { value: "" }, "（请选择 provider）"),
                          titleProviders.map((p) => React.createElement("option", { key: p.provider, value: p.provider },
                            p.name + " · " + p.provider))
                        )
                      ),
                      React.createElement("label", { className: "mcfg-field" },
                        React.createElement("span", { className: "mcfg-label" }, "Model"),
                        React.createElement("select", {
                          className: "mcfg-select",
                          disabled: !data.writable || titleBusy || !titleShown.provider,
                          value: titleShown.model || "",
                          onChange: (e) => editTitleDraft({ model: e.target.value }),
                        },
                          React.createElement("option", { value: "" }, "（请选择 model）"),
                          titleModels.map((m) => React.createElement("option", { key: m.id, value: m.id },
                            m.name + " · " + m.id))
                        )
                      )
                    )
                  : null,
                React.createElement("div", { className: "mcfg-note", key: "scope" },
                  "生效范围：保存后对本 profile 之后生成的标题生效（包含新会话与后续标题生成）；不会改动已有标题、手动重命名，也不会改动会话的对话模型。"
                ),
                React.createElement("div", { className: "mcfg-note", key: "budget" },
                  "标题请求沿用宿主既有策略：提示词、输入字节上限、输出 token 上限与超时均由标题生成策略固定，因此这里不提供推理档位控件。"
                ),
                React.createElement("div", { className: "mcfg-actions", key: "actions" },
                  React.createElement("button", {
                    type: "button",
                    className: "mcfg-save",
                    disabled: titleSaveDisabled || !titleDirty,
                    onClick: saveTitle,
                  }, titleBusy ? "正在保存…" : (titleDirty ? "保存标题设置" : "已保存")),
                  titleDirty ? React.createElement("span", { className: "mcfg-note" }, "有未保存的修改") : null
                )
              ]
        ),
        React.createElement("div", { className: "mcfg-purpose", key: "image" },
          React.createElement("div", { className: "mcfg-purpose-head" },
            React.createElement("span", { className: "mcfg-purpose-name" }, "绘图"),
            React.createElement("span", { className: "mcfg-chip" }, "图像专有参数")
          ),
          React.createElement("div", { className: "mcfg-desc" },
            "绘图模型、端点、尺寸与质量属于图像专有参数，请在「绘图」页签配置；本页的「生图模型」勾选会把所选模型写入那里的模型列表。"
          ),
          data.imageModels && data.imageModels.length > 0
            ? React.createElement("div", { className: "mcfg-note" },
                "绘图页当前 " + data.imageModels.length + " 个配置：" + data.imageModels.join("、")
                  + (data.imageDefault ? "（默认 " + data.imageDefault + "）" : "（未设默认，generate_image 需显式指定）"))
            : React.createElement("div", { className: "mcfg-note" }, "绘图页尚未配置任何模型。")
        )
      ];

      return React.createElement("div", { className: "mcfg" },
        React.createElement("div", { className: "mcfg-head" },
          React.createElement("div", { className: "mcfg-title" }, "模型调参"),
          React.createElement("div", { className: "mcfg-sub" },
            "集中配置每个模型的可选推理档位、上下文窗口、最大输出和输入模态；「用途」页管理标题生成路由；「绘图」页管理绘图模型与直接绘图。" +
            "修改即时保存；API 密钥与端点请在「模型」页配置。" +
            (data.writable ? "" : "（当前部署为只读，无法保存。）")
          )
        ),
        tabBar,
        toast ? React.createElement("div", { className: "mcfg-toast " + (toast.kind === "ok" ? "mcfg-toast-ok" : "mcfg-toast-err") }, toast.text) : null,
        tab === "models" ? modelsPanel : null,
        tab === "purpose" ? purposePanel : null,
        tab === "image" && ownView ? React.createElement(ImagePanel, {
          remote: props.remote, call: props.call,
          writable: !!data.writable, view: ownView, refresh: reload, showToast,
        }) : null,
        tab === "image" && !ownView ? React.createElement("div", { className: "mcfg-state mcfg-error" }, "宿主行未激活，无法读写绘图配置。") : null
      );
    }

    // 2026-09-08 (DSH 0.1.2-rc.1): `ctx.connection.api` no longer exists — the
    // client API moved to the `remote.*` service namespace (remote.llm.*,
    // remote.settings.*, remote.session.*). Declaring them also defers this
    // plugin until the mux connection is up, so the settings page never loads
    // against a dead API surface.
    const inject = ["slots", "remote", "remote.llm", "remote.settings", "remote.session", "remote.credentials", "locale", "connection"];

    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-model-tuning";
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => { style.remove(); });

      if (ctx.locale) {
        // 生产 dsh-client-locale 的 LOCALE_IDS 是 ["zh", "en"]；multi-locale
        // 形态一次写入 zh / en。ctx.effect 挂进 fiber 生命周期，HMR 再激活
        // 不会重复注册。
        ctx.effect(() => ctx.locale.register("dsh-plugin-model-tuning", {
          en: {
            "tab.models": "Model parameters",
            "tab.purpose": "Purposes",
            "tab.image": "Images",
            "title.name": "Session titles",
            "title.desc": "A session title comes from a separate auxiliary request and never changes the chat model. By default it inherits the session's provider / model.",
            "title.inherit": "Inherit from the current session (default)",
            "title.custom": "Use a specific model",
            "title.scope": "Scope: applying this affects titles generated afterwards in this profile. Existing titles, manual renames, and the session's chat model are left untouched.",
            "title.missing": "The model-tuning settings namespace is missing: the host half did not activate (no title provider registered). Check that the plugin is enabled and restart dsh.",
            "title.save": "Save title settings",
          },
          zh: {
            "tab.models": "模型参数",
            "tab.purpose": "用途",
            "tab.image": "绘图",
            "title.name": "标题生成",
            "title.desc": "会话标题由一次独立的辅助请求生成，不会改动对话模型。默认继承当前会话的 provider / model。",
            "title.inherit": "继承当前会话（默认）",
            "title.custom": "使用指定模型",
            "title.scope": "生效范围：保存后对本 profile 之后生成的标题生效；不会改动已有标题、手动重命名，也不会改动会话的对话模型。",
            "title.missing": "未检测到 model-tuning 设置命名空间：宿主半区未激活（标题 provider 未注册），请检查插件是否启用并重启 dsh。",
            "title.save": "保存标题设置",
          },
        }));
      }

      const remote = ctx.remote;
      const wrap = (response, map) => response.ok
        ? { result: { ok: true, value: map(response.value) } }
        : { result: { ok: false, error: response.error } };
      const api = {
        llm: {
          providers: async () => {
            const response = await remote.llm.listConfigurableProviders();
            return wrap(response, (value) => ({ providers: value }));
          },
          models: async () => {
            const response = await remote.session.modelCatalog();
            return wrap(response, (value) => ({ groups: value.groups }));
          },
        },
        settings: {
          describe: async () => {
            const response = await remote.settings.describe();
            return wrap(response, (value) => value);
          },
          mutate: async (args) => {
            const response = await remote.settings.mutate(args.ns, args.ops, args.expectedRevision);
            return wrap(response, () => ({}));
          },
        },
      };
      const timer = ctx.get("timer");

      // v2: the Remote call path for the 直接绘图 panel (ex image-generation
      // client half). `connection.rpc.call('/api', 'imageGeneration/<method>')`.
      const unwrap = (response) => { if (!response.ok) throw new Error(response.error?.message ?? "请求失败"); return response.value; };
      const call = async (method, args) => unwrap(await ctx.connection.rpc.call("/api", `imageGeneration/${method}`, { args }));

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "model-tuning", order: 11, label: () => "模型调参" },
        () => React.createElement(ModelTuningPage, { api, timer, remote, call }),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
