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
.mcfg-label{font-size:11px;opacity:.6}
/* 选择框与自定义输入框竖排：横排时 .mcfg-select 的 width:100% 会吃掉整行
   flex 空间，.mcfg-custom 被压到约 18px 宽（几乎看不见）。 */
.mcfg-fieldrow{display:flex;flex-direction:column;gap:6px;align-items:stretch}
.mcfg-select,.mcfg-input{font-size:12.5px;padding:6px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.mcfg-custom{width:100%}
.mcfg-input:disabled,.mcfg-select:disabled{opacity:.5;cursor:not-allowed}
.mcfg-select:focus,.mcfg-input:focus{outline:none;border-color:rgba(80,140,255,.7)}
.mcfg-img-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.mcfg-warn{font-size:11.5px;line-height:1.5;color:#c9722c}
`;

    /**
     * The image-generation plugin's own settings namespace. Linking writes
     * there instead of duplicating its models here, so 绘图 stays the single
     * source of truth for what generate_image actually calls.
     */
    const IMAGE_NS = "image-generation";
    const IMAGE_API = "openai-images";
    /** Provenance marker on an entry this page created; its absence means the
     *  entry was authored by hand on the 绘图 page, which stays authoritative. */
    const IMAGE_SOURCE_KEY = "source";

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

    /**
     * The 绘图 namespace view. A describe response normally already carries it,
     * since the image plugin registers that namespace on the host; this only
     * re-reads when it is missing, so an uninstalled plugin degrades to
     * "hidden" instead of throwing.
     * @param describeRaw - re-reads the settings document.
     * @param settingsView - an already-fetched describe response, if any.
     * @returns the image-generation namespace view, or undefined.
     */
    async function ensureImageNs(describeRaw, settingsView) {
      const present = findNamespace(settingsView, IMAGE_NS);
      if (present) return present;
      try {
        const response = await describeRaw();
        return response.result.ok ? findNamespace(response.result.value, IMAGE_NS) : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Derive one image namespace entry from the chat provider that already
     * holds the endpoint and credential reference, so linking never asks the
     * user to retype either one.
     * @param profile - the provider's settings section.
     * @param modelId - the chat model id, reused verbatim as the upstream id.
     * @returns the fields derived from the provider, or an empty endpoint when
     *   the provider declares no base URL.
     */
    function deriveImageEntry(profile, modelId) {
      const base = typeof profile?.baseURL === "string" ? profile.baseURL.trim() : "";
      return {
        model: modelId,
        // The Images API lives beside the chat API on the same base; the
        // validation in planImageLink rejects anything unusable.
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

    /** The per-model view of the link, shared by the checkbox and its note. */    function computeImageModelState(imageNsView, profile, modelId) {
      if (!imageNsView) return { available: false, managed: false, hasEntry: false, entry: null };
      const models = Array.isArray(imageNsView.value?.models) ? imageNsView.value.models : [];
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

    function imageModelsOf(imageNsView) {      const models = imageNsView ? imageNsView.value?.models : undefined;
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

    /** The 绘图 namespace validates `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. */
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
     * Everything the image namespace needs for an incremental write: only the
     * models entry this page owns plus the default-model change it implies.
     * An entry may already exist without our marker because the 绘图 page
     * created it, or because it was stored before the marker existed; the
     * merge adopts it in place and never touches the user's other fields.
     * @param imageNsView - the resolved image-generation namespace view.
     * @param profile - the chat provider's settings section.
     * @param modelId - the chat model id being linked.
     * @param providerId - the providing route id, recorded for provenance.
     * @returns models and defaultModel, or a reason the link cannot be written.
     */
    function planImageLink(imageNsView, profile, modelId, providerId) {
      const derived = deriveImageEntry(profile, modelId);
      const endpoint = normalizeImageEndpoint(derived.endpoint);
      if (!acceptableImageEndpoint(endpoint)) {
        return { models: null, reason: "该 provider 没有可用的供应商地址（api.baseURL），请先在「模型」页填写后再勾选。" };
      }
      const models = imageModelsOf(imageNsView).slice();
      const index = models.findIndex((item) => item && typeof item === "object" && item.model === modelId);
      const owned = index >= 0
        // Adopt an existing entry; only the fields the link owns are refreshed.
        ? { ...models[index], model: modelId, endpoint, api: IMAGE_API, [IMAGE_SOURCE_KEY]: { provider: providerId, model: modelId } }
        // Write out every field the image schema defaults, so the stored
        // document stays readable and a later schema change cannot surprise it.
        : { id: uniqueImageId(modelId, models), name: modelId, model: modelId, endpoint, api: IMAGE_API, timeoutSeconds: 300 };
      if (index >= 0 && !owned.apiKeyEnv && derived.apiKeyEnv) owned.apiKeyEnv = derived.apiKeyEnv;
      if (index < 0) {
        if (derived.apiKeyEnv) owned.apiKeyEnv = derived.apiKeyEnv;
        owned[IMAGE_SOURCE_KEY] = { provider: providerId, model: modelId };
      }
      const next = index >= 0 ? models.map((item, i) => (i === index ? owned : item)) : [...models, owned];
      const currentDefault = imageNsView.value?.defaultModel;
      // Without a default the entry would never be called by generate_image.
      const defaultModel = typeof currentDefault === "string" && currentDefault ? currentDefault : owned.id;
      return { models: next, defaultModel };
    }

    /** Unlink removes only the entry this page created. */
    function planImageUnlink(imageNsView, modelId) {
      const models = imageModelsOf(imageNsView);
      const entry = models.find((item) => item && typeof item === "object" && item.model === modelId);
      if (!entry) return { models: null, reason: "该模型未链接到绘图配置。" };
      if (!isManagedEntry(entry, modelId)) return { models: null, reason: "该绘图配置由「绘图」页手工维护，不能在这里取消。" };
      const next = models.filter((item) => item !== entry);
      const currentDefault = imageNsView.value?.defaultModel;
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
     * The installed pi-ai catalog is invisible to the browser, so `auto` on a
     * shipped route states no result instead of guessing one.
     * @param choice - the declared state.
     * @param model - the row, carrying what the route disclosed about itself.
     * @returns one-line note under the control.
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
     * @param entry - the provider's configurable-provider view.
     * @param nsView - the resolved settings namespace view.
     * @param modelId - exact model id.
     * @param choice - the selected tri-state.
     * @returns the mutate namespace and ops, or null when nothing is writable.
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

    function ModelTuningPage(props) {
      const api = props.api;
      const timer = props.timer;
      const [data, setData] = React.useState(null);
      const [imageNs, setImageNs] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [query, setQuery] = React.useState("");

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
          const imageNsView = await ensureImageNs(() => api.settings.describe(), settingsRes.result.value);

          const built = { writable, providers: [] };
          for (const group of groups) {
            const entry = metaByProvider.get(group.id);
            const nsView = entry ? nsByNs.get(entry.settingsNs) : undefined;
            const providerProfile = profileOf(nsView, entry ? entry.settingsPath : []);
            const reasoningEditable = !!(entry && entry.settingsNs === "llm-pi-ai");
            // A hand-declared route has no installed catalog under it, so its
            // route-level `defaultInput` is the whole answer for `auto`.
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
              const image = computeImageModelState(imageNsView, providerProfile, m.id);
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
              imageNsAvailable: !!imageNsView,
              models,
            });
          }
          const imageModels = imageModelsOf(imageNsView);
          const linkedIds = new Set(imageModels.filter((item) => item && item.model).map((item) => item.model));
          for (const row of built.providers) {
            row.imageLinkedCount = row.models.filter((m) => linkedIds.has(m.id)).length;
          }
          built.imageModels = imageModels.map((item) => item?.model).filter(Boolean);
          built.imageDefault = typeof imageNsView?.value?.defaultModel === "string" ? imageNsView.value.defaultModel : "";
          setData(built);
          setImageNs(imageNsView ?? null);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
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
            const freshNs = await ensureImageNs(() => api.settings.describe(), freshRes.result.value);
            if (!freshNs) throw new Error("绘图插件未安装或不提供设置，请先安装 dsh-plugin-image-generation。");
            const providerProfile = profileOf(nsView, entry.settingsPath);
            const plan = value === true
              ? planImageLink(freshNs, providerProfile, model, provider)
              : planImageUnlink(freshNs, model);
            if (!plan || !plan.models) throw new Error((plan && plan.reason) || "无法写入绘图配置");
            const written = await api.settings.mutate({
              ns: IMAGE_NS,
              ops: [
                { op: "set", path: ["models"], value: plan.models },
                { op: "set", path: ["defaultModel"], value: plan.defaultModel || "" },
              ],
              expectedRevision: freshNs.revision,
            });
            if (!written.result.ok) throw new Error(written.result.error.message);
            showToast("ok", value === true ? "已在绘图页生成模型配置" : "已取消生图标记");
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
      if (!data || !data.providers || data.providers.length === 0) {
        return React.createElement("div", { className: "mcfg-state" }, "当前没有已注册的模型。");
      }

      const q = query.trim().toLowerCase();
      const filtered = q.length === 0 ? data.providers : data.providers.map((provider) => {
        const providerMatch = provider.name.toLowerCase().indexOf(q) >= 0 || provider.provider.toLowerCase().indexOf(q) >= 0;
        const models = providerMatch ? provider.models : provider.models.filter((m) =>
          m.id.toLowerCase().indexOf(q) >= 0 ||
          m.name.toLowerCase().indexOf(q) >= 0 ||
          (m.description || "").toLowerCase().indexOf(q) >= 0
        );
        return models.length > 0 ? { ...provider, models } : null;
      }).filter(Boolean);
      const totalMatched = filtered.reduce((n, p) => n + p.models.length, 0);

      return React.createElement("div", { className: "mcfg" },
        React.createElement("div", { className: "mcfg-head" },
          React.createElement("div", { className: "mcfg-title" }, "模型调参"),
          React.createElement("div", { className: "mcfg-sub" },
            "集中配置每个模型的可选推理档位、上下文窗口、最大输出和输入模态，修改即时保存；API 密钥与端点请在「模型」页配置。" +
            "勾选「生图模型」会把该模型写入绘图插件的模型列表，供 generate_image 与绘图页使用。" +
            (data.writable ? "" : "（当前部署为只读，无法保存。）")
          )
        ),
        React.createElement("div", { className: "mcfg-searchrow" },
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
          ? React.createElement("div", { className: "mcfg-note" },
              "绘图页当前 " + data.imageModels.length + " 个配置：" + data.imageModels.join("、")
                + (data.imageDefault ? "（默认 " + data.imageDefault + "）" : "（未设默认，generate_image 需显式指定）"))
          : React.createElement("div", { className: "mcfg-note" }, "绘图页尚未配置任何模型。"),
        toast ? React.createElement("div", { className: "mcfg-toast " + (toast.kind === "ok" ? "mcfg-toast-ok" : "mcfg-toast-err") }, toast.text) : null,
        filtered.length === 0
          ? React.createElement("div", { className: "mcfg-state" }, "没有匹配的模型。")
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
                            + "。由本页维护的条目不能在绘图页删除；尺寸、质量等参数仍可在绘图页修改。"
                          : "勾选后写入绘图插件的模型列表（模型 ID 复用 " + model.id + "，端点由本 provider 的供应商地址加 /images/generations 推导）。"
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
      );
    }

    // 2026-09-08 (DSH 0.1.2-rc.1): `ctx.connection.api` no longer exists — the
    // client API moved to the `remote.*` service namespace (remote.llm.*,
    // remote.settings.*, remote.session.*). Declaring them also defers this
    // plugin until the mux connection is up, so the settings page never loads
    // against a dead API surface.
    // 点分服务名需逐一声明（同官方 settings-models：remote.llm / remote.settings）。
    const inject = ["slots", "remote", "remote.llm", "remote.settings", "remote.session"];

    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-model-tuning";
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => { style.remove(); });

      // 旧客户端 API（ctx.connection.api）在 0.1.2 已移除；此处把新
      // remote.* 面适配回本插件既有的 {result:{ok,error,value}} 消费形状，
      // UI 代码不变。模型目录来自 remote.session.modelCatalog()（与官方
      // 模型选择器同源），其 groups 结构与旧 llm.models 相同。
      const remote = ctx.remote;
      const wrap = (response, map) => response.ok
        ? { result: { ok: true, value: map(response.value) } }
        : { result: { ok: false, error: response.error } };
      // remote.* RPC 按位置参数校验元数（官方签名：listProviders()、
      // modelCatalog()、describe()、mutate(ns, ops, expectedRevision)），
      // 旧客户端 API 的单对象调用形状在此展开。
      const api = {
        llm: {
          // 2026-09-08 修正：0.1.2-rc.1 的 llm.listProviders() 返回的是
          // LlmProviderInfo { id, name }（已注册路由的元数据），**没有**
          // settingsNs / settingsPath / declared。用它按 p.provider 建映射会得到
          // 一个只有 undefined 键的 Map，于是每个 model group 都查不到 entry，
          // configurable 恒为 false → 整页控件 disabled、推理档位显示
          // 「由 provider 固定」。
          // 官方 dsh-client-ui-settings-models 用的是 listConfigurableProviders()，
          // 其 LlmConfigurableProvider { provider, displayName, settingsNs,
          // settingsPath, declared } 正是本插件期望的形状（写 settings 也依赖
          // settingsNs / settingsPath 这两个字段）。
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

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "model-tuning", order: 11, label: () => "模型调参" },
        () => React.createElement(ModelTuningPage, { api, timer }),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
