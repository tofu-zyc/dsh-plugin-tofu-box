window.__ModuleLoader__.load({
  id: "dsh-plugin-mcp-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const CSS = `
.mcpui{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;color:inherit}
.mcpui-head{display:flex;flex-direction:column;gap:4px}
.mcpui-title{font-size:15px;font-weight:600}
.mcpui-sub{font-size:12.5px;opacity:.72;line-height:1.5}
.mcpui-path{font-size:11.5px;opacity:.6;font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all}
.mcpui-warn{font-size:12px;line-height:1.55;padding:8px 12px;border-radius:8px;background:rgba(210,150,40,.14);border:1px solid rgba(210,150,40,.35)}
.mcpui-toast{position:sticky;top:8px;z-index:20;align-self:flex-start;padding:6px 12px;border-radius:8px;font-size:12.5px}
.mcpui-toast-ok{background:rgba(46,160,67,.18)}
.mcpui-toast-err{background:rgba(213,83,61,.18)}
.mcpui-state{padding:20px 8px;font-size:13px;opacity:.7}
.mcpui-error{color:#d5533d;opacity:1}
.mcpui-list{display:flex;flex-direction:column;gap:10px}
.mcpui-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid rgba(128,128,128,.28);border-radius:10px}
.mcpui-card-off{opacity:.55}
.mcpui-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.mcpui-card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.mcpui-name{font-size:13.5px;font-weight:600}
.mcpui-chip{font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(128,128,128,.16)}
.mcpui-chip-on{background:rgba(46,160,67,.22)}
.mcpui-chip-transport{background:rgba(80,140,255,.18)}
.mcpui-summary{font-size:12px;opacity:.72;font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all;line-height:1.45}
.mcpui-rowid{font-size:11px;opacity:.5;font-family:ui-monospace,SFMono-Regular,monospace}
.mcpui-actions{display:flex;align-items:center;gap:8px}
.mcpui-btn{font-size:12.5px;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
.mcpui-btn:hover{border-color:rgba(80,140,255,.7)}
.mcpui-btn-primary{background:rgba(80,140,255,.22);border-color:rgba(80,140,255,.55)}
.mcpui-btn-danger{color:#d5533d;border-color:rgba(213,83,61,.45)}
.mcpui-btn:disabled{opacity:.5;cursor:not-allowed}
.mcpui-switch{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer}
.mcpui-switch input{accent-color:rgb(80,140,255)}
.mcpui-form{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid rgba(80,140,255,.45);border-radius:10px}
.mcpui-form-title{font-size:13px;font-weight:600}
.mcpui-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.mcpui-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.mcpui-field-wide{grid-column:1 / -1}
.mcpui-label{font-size:11px;opacity:.6}
.mcpui-hint{font-size:11px;opacity:.5;line-height:1.4}
.mcpui-input,.mcpui-select,.mcpui-textarea{font-size:12.5px;padding:6px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:100%;box-sizing:border-box;font-family:inherit}
.mcpui-textarea{font-family:ui-monospace,SFMono-Regular,monospace;resize:vertical;min-height:56px}
.mcpui-input:focus,.mcpui-select:focus,.mcpui-textarea:focus{outline:none;border-color:rgba(80,140,255,.7)}
.mcpui-field-error{font-size:11.5px;color:#d5533d}
.mcpui-ext{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px dashed rgba(128,128,128,.4);border-radius:10px;opacity:.75}
.mcpui-ext-title{font-size:12px;font-weight:600}
.mcpui-ext-item{font-size:12px;font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all}
.mcpui-form-actions{display:flex;gap:8px;justify-content:flex-end}
`;

    const TRANSPORTS = [
      { value: "stdio", label: "stdio（本机命令）" },
      { value: "streamable-http", label: "streamable-http（远程 URL）" },
    ];

    const EMPTY_FORM = {
      id: "",
      serverName: "",
      transport: "stdio",
      disabled: false,
      command: "",
      args: "",
      env: "",
      cwd: "",
      url: "",
      headers: "",
      toolCallTimeoutMs: "",
      failOnStartupError: false,
      reconnect: true,
    };

    function entryToForm(entry) {
      return {
        id: entry.id ?? "",
        serverName: entry.serverName ?? "",
        transport: entry.transport ?? "stdio",
        disabled: entry.disabled === true,
        command: entry.command ?? "",
        args: Array.isArray(entry.args) ? entry.args.join("\n") : "",
        env: Object.entries(entry.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
        cwd: entry.cwd ?? "",
        url: entry.url ?? "",
        headers: Object.entries(entry.headers ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
        toolCallTimeoutMs: entry.toolCallTimeoutMs != null ? String(entry.toolCallTimeoutMs) : "",
        failOnStartupError: entry.failOnStartupError === true,
        reconnect: entry.reconnect !== false,
      };
    }

    function Switch({ checked, onChange, label, disabled }) {
      return React.createElement("label", { className: "mcpui-switch" },
        React.createElement("input", {
          type: "checkbox", checked: !!checked, disabled: !!disabled,
          onChange: (e) => onChange(e.target.checked),
        }),
        label,
      );
    }

    function Field({ label, hint, error, wide, children }) {
      return React.createElement("div", { className: "mcpui-field" + (wide ? " mcpui-field-wide" : "") },
        React.createElement("span", { className: "mcpui-label" }, label),
        children,
        hint ? React.createElement("span", { className: "mcpui-hint" }, hint) : null,
        error ? React.createElement("span", { className: "mcpui-field-error" }, error) : null,
      );
    }

    function ServerCard({ entry, onEdit, onDelete, onToggle, busy }) {
      return React.createElement("div", { className: "mcpui-card" + (entry.disabled ? " mcpui-card-off" : "") },
        React.createElement("div", { className: "mcpui-card-head" },
          React.createElement("div", { className: "mcpui-card-title" },
            React.createElement("span", { className: "mcpui-name" }, entry.serverName),
            React.createElement("span", { className: "mcpui-chip mcpui-chip-transport" },
              entry.transport === "stdio" ? "stdio" : "http"),
            React.createElement("span", { className: "mcpui-chip" + (entry.disabled ? "" : " mcpui-chip-on") },
              entry.disabled ? "已禁用" : "已启用"),
          ),
          React.createElement("div", { className: "mcpui-actions" },
            React.createElement(Switch, {
              checked: !entry.disabled, disabled: busy,
              onChange: (on) => onToggle(entry, on), label: "",
            }),
            React.createElement("button", { className: "mcpui-btn", disabled: busy, onClick: () => onEdit(entry) }, "编辑"),
            React.createElement("button", { className: "mcpui-btn mcpui-btn-danger", disabled: busy, onClick: () => onDelete(entry) }, "删除"),
          ),
        ),
        React.createElement("div", { className: "mcpui-summary" }, entry.summary ?? ""),
        React.createElement("div", { className: "mcpui-rowid" }, `patch 行 id: ${entry.id}`),
      );
    }

    function ServerForm({ initial, originalId, errors, saving, onSave, onCancel }) {
      const [form, setForm] = useState(initial);
      const set = (patch) => setForm((f) => ({ ...f, ...patch }));
      const input = (key, props) => React.createElement("input", Object.assign({
        className: "mcpui-input", value: form[key] ?? "",
        onChange: (e) => set({ [key]: e.target.value }),
      }, props));
      const textarea = (key, rows) => React.createElement("textarea", {
        className: "mcpui-textarea", rows: rows ?? 3, value: form[key] ?? "",
        onChange: (e) => set({ [key]: e.target.value }),
      });
      const isStdio = form.transport === "stdio";
      return React.createElement("div", { className: "mcpui-form" },
        React.createElement("div", { className: "mcpui-form-title" }, originalId ? `编辑服务器「${originalId}」` : "添加 MCP 服务器"),
        React.createElement("div", { className: "mcpui-fields" },
          Field({ label: "serverName", error: errors.serverName, hint: "工具将命名为 mcp__<serverName>__<工具名>；字母数字_-，1-32 位" },
            input("serverName", { placeholder: "例如 filesystem" })),
          Field({ label: "传输方式" },
            React.createElement("select", {
              className: "mcpui-select", value: form.transport,
              onChange: (e) => set({ transport: e.target.value }),
            }, TRANSPORTS.map((t) => React.createElement("option", { key: t.value, value: t.value }, t.label)))),
          isStdio
            ? Field({ label: "command", error: errors.command, hint: "可执行文件，如 npx / uvx / node" }, input("command", { placeholder: "npx" }))
            : Field({ label: "url", error: errors.url, hint: "http(s):// 开头的 MCP 端点" }, input("url", { placeholder: "https://example.com/mcp" })),
          isStdio
            ? Field({ label: "args（每行一个参数）", wide: true }, textarea("args", 3))
            : Field({ label: "headers（每行 KEY=VALUE）", wide: true, error: errors.headers, hint: "认证头写在这里，例如 Authorization=Bearer xxx" }, textarea("headers", 3)),
          isStdio
            ? Field({ label: "env（每行 KEY=VALUE）", wide: true, error: errors.env, hint: "传给子进程的环境变量，例如 API_KEY=xxx" }, textarea("env", 3))
            : null,
          isStdio
            ? Field({ label: "cwd（可选工作目录）" }, input("cwd", { placeholder: "留空则使用默认目录" }))
            : null,
          Field({ label: "toolCallTimeoutMs（可选）", error: errors.toolCallTimeoutMs, hint: "单次工具调用超时，默认 60000" },
            input("toolCallTimeoutMs", { placeholder: "60000", inputMode: "numeric" })),
          Field({ label: "行 id（可选，留空自动生成）", error: errors.id },
            input("id", { placeholder: "mcp-<serverName>" })),
        ),
        React.createElement("div", { className: "mcpui-actions" },
          Switch({ checked: !form.disabled, onChange: (on) => set({ disabled: !on }), label: "启用" }),
          Switch({ checked: form.reconnect, onChange: (on) => set({ reconnect: on }), label: "断线自动重连" }),
          Switch({ checked: form.failOnStartupError, onChange: (on) => set({ failOnStartupError: on }), label: "启动失败即报错（默认容忍）" }),
        ),
        React.createElement("div", { className: "mcpui-form-actions" },
          React.createElement("button", { className: "mcpui-btn", onClick: onCancel, disabled: saving }, "取消"),
          React.createElement("button", {
            className: "mcpui-btn mcpui-btn-primary", disabled: saving,
            onClick: () => onSave({ ...form, ...(isStdio ? { url: "", headers: "" } : { command: "", args: "", env: "", cwd: "" }) }),
          }, saving ? "保存中…" : "保存"),
        ),
      );
    }

    function McpUiPage({ call }) {
      const [state, setState] = useState({ loading: true, error: "", data: null });
      const [form, setForm] = useState(null); // { form, originalId } | null
      const [errors, setErrors] = useState({});
      const [saving, setSaving] = useState(false);
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const data = await call("list");
          setState({ loading: false, error: "", data });
        } catch (error) {
          setState((s) => ({ loading: false, error: error.message ?? String(error), data: s.data }));
        }
      }, [call]);
      useEffect(() => { void refresh(); }, [refresh]);

      const notify = (kind, text) => setToast({ kind, text });
      useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(t);
      }, [toast]);

      const guard = async (fn) => {
        try { await fn(); return true; }
        catch (error) {
          setErrors(error.details ?? {});
          notify("err", error.message ?? String(error));
          return false;
        }
      };

      const onSave = async (formValues) => {
        setSaving(true); setErrors({});
        const changed = await guard(async () => {
          await call("save", { entry: formValues, originalId: form?.originalId ?? "" });
        });
        setSaving(false);
        if (!changed) return;
        setForm(null);
        notify("ok", "已写入 patch 文件；patchReload: live 下数秒内热生效");
        void refresh();
      };
      const onDelete = (entry) => {
        if (!window.confirm(`删除 MCP 服务器「${entry.serverName}」（patch 行 ${entry.id}）？`)) return;
        setBusy(true);
        guard(async () => { await call("remove", { serverId: entry.id }); })
          .then((changed) => { if (changed) notify("ok", "已删除"); void refresh(); })
          .finally(() => setBusy(false));
      };
      const onToggle = (entry, on) => {
        setBusy(true);
        guard(async () => { await call("toggle", { serverId: entry.id, enabled: on }); })
          .then(() => { notify("ok", on ? "已启用" : "已禁用"); void refresh(); })
          .finally(() => setBusy(false));
      };
      const onEdit = (entry) => {
        setErrors({});
        setForm({ form: entryToForm(entry), originalId: entry.id });
      };

      const data = state.data;
      const startNew = () => { setErrors({}); setForm({ form: { ...EMPTY_FORM }, originalId: "" }); };

      return React.createElement("div", { className: "mcpui" },
        React.createElement("style", null, CSS),
        toast ? React.createElement("div", { className: "mcpui-toast mcpui-toast-" + toast.kind }, toast.text) : null,
        React.createElement("div", { className: "mcpui-head" },
          React.createElement("div", { className: "mcpui-title" }, "MCP 服务器"),
          React.createElement("div", { className: "mcpui-sub" },
            "这里的增删改会写入 profile 的 cordis.patch.yml 标记块（块外内容原样保留），由 @deepseek-ai/dsh-mcp-client 逐行挂载。",
            "profile 开启 patchReload: live 时保存后数秒热生效；否则重启 dsh 后生效。"),
          data?.path ? React.createElement("div", { className: "mcpui-path" }, `管理文件：${data.path}`) : null,
        ),
        React.createElement("div", { className: "mcpui-warn" },
          "注意：stdio 服务器若启动缓慢或挂起，可能短暂阻塞工具注册；「启动失败即报错」保持关闭可避免拖垮启动。密码/Token 会以明文保存在 patch 文件中，请留意 git 提交范围。"),
        form
          ? React.createElement(ServerForm, {
              key: form.originalId || "__new__",
              initial: form.form, originalId: form.originalId, errors, saving,
              onSave, onCancel: () => { setForm(null); setErrors({}); },
            })
          : null,
        state.loading && !data
          ? React.createElement("div", { className: "mcpui-state" }, "加载中…")
          : null,
        state.error
          ? React.createElement("div", { className: "mcpui-state mcpui-error" }, `读取失败：${state.error}`)
          : null,
        data
          ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "mcpui-list" },
                data.entries.length === 0 && !form
                  ? React.createElement("div", { className: "mcpui-state" }, "暂无由本页管理的 MCP 服务器。")
                  : null,
                data.entries.map((entry) => React.createElement(ServerCard, {
                  key: entry.id, entry, busy, onEdit, onDelete, onToggle,
                }))),
              data.external.length > 0
                ? React.createElement("div", { className: "mcpui-ext" },
                    React.createElement("div", { className: "mcpui-ext-title" }, "patch 中其它来源的 mcp-client 行（只读，本页不编辑）"),
                    data.external.map((row) => React.createElement("div", {
                      key: row.id, className: "mcpui-ext-item",
                    }, `${row.id} · ${row.serverName || "?"} · ${row.target || ""}`)))
                : null,
              !form
                ? React.createElement("div", { className: "mcpui-actions" },
                    React.createElement("button", { className: "mcpui-btn mcpui-btn-primary", onClick: startNew }, "添加 MCP 服务器"),
                    React.createElement("button", { className: "mcpui-btn", onClick: () => void refresh() }, "刷新"))
                : null)
          : null,
      );
    }

    const inject = ["slots", "connection"];

    function apply(ctx) {
      // 走官方 typert 网关：/api/mcpUi/<method>，payload 形如 { args: {...} }，
      // 服务端是 dsh-plugin-mcp-ui 的 TypertRemoteService（SRC marker 发现）。
      const call = async (method, args) => {
        const response = await ctx.connection.rpc.call("/api", `mcpUi/${method}`, { args: args ?? {} });
        if (!response.ok) {
          const error = new Error(response.error?.message ?? "请求失败");
          error.details = response.error?.details ?? {};
          throw error;
        }
        return response.value;
      };

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "mcp-ui", order: 12, label: () => "MCP 服务器" },
        () => React.createElement(McpUiPage, { call }),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
