window.__ModuleLoader__.load({
  id: "dsh-plugin-model-search",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const {
      IconCheckOutline16,
      IconChevronDownOutline14,
      IconChevronRightOutline14,
      IconCloseFill14,
      IconSearchOutline16,
      IconWarningOutline16,
      Toast,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const CSS = `
.msrch_root{min-width:0;position:relative}
.msrch_trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}
.msrch_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.msrch_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.msrch_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.msrch_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.msrch_triggerEffort{color:var(--dsw-alias-label-caption);flex:none}
.msrch_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.msrch_chevronOpen{transform:rotate(180deg)}
.msrch_menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(260px,100vw - 32px);max-height:min(400px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}
.msrch_status,.msrch_empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}
.msrch_error,.msrch_warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}
.msrch_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
.msrch_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}
.msrch_groups{min-height:0;flex:1 1 auto;overflow-y:auto}
.msrch_group+.msrch_group{margin-top:4px}
.msrch_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}
.msrch_recent{border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px;margin-bottom:4px}
.msrch_option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex;touch-action:manipulation}
.msrch_option:hover:not(:disabled),.msrch_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.msrch_selected{background:0 0}
.msrch_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.msrch_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}
.msrch_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}
.msrch_description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}
.msrch_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}
.msrch_cell{width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex;touch-action:manipulation}
.msrch_cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msrch_cellLabel{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}
.msrch_cellValue{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:0 auto;overflow:hidden}
.msrch_cellChevron{color:var(--dsw-alias-label-tertiary);flex:none}
.msrch_searchWrap{flex:none;display:flex;align-items:center;gap:6px;margin:2px 2px 4px;padding:0 8px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.msrch_searchWrap:focus-within{border-color:var(--dsw-alias-brand-primary)}
.msrch_searchIcon{color:var(--dsw-alias-label-tertiary);flex:none}
.msrch_searchInput{flex:1;min-width:0;height:100%;border:0;outline:none;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0}
.msrch_searchInput::placeholder{color:var(--dsw-alias-label-dimmed)}
.msrch_searchClear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.msrch_searchClear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.msrch_count{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}
`;

    function cx(...values) {
      let out = "";
      for (const value of values) {
        if (value) out += (out ? " " : "") + value;
      }
      return out;
    }

    /**
     * Searchable replacement for the built-in ModelSelect seat. It renders
     * the same two-level menu (Model / Effort) and adds a search input at the
     * top of the model pane. All data and selection verbs still ride the
     * shared per-session ModelDirectory provided by
     * @deepseek-ai/dsh-client-ui-model-selection.
     */
    function ModelSearchSelect({ locked, available, directory, load, select, t }) {
      const subscribe = React.useCallback(
        (fn) => directory.subscribe(fn),
        [directory]
      );
      const getSnapshot = React.useCallback(
        () => directory.getSnapshot(),
        [directory]
      );
      const state = React.useSyncExternalStore(subscribe, getSnapshot);

      const [open, setOpen] = React.useState(false);
      const [pane, setPane] = React.useState("root");
      const [query, setQuery] = React.useState("");
      const [toast, setToast] = React.useState(null);
      // Most-recently-used model choices, persisted per browser. Kept tiny
      // (5 entries) and read defensively: bad JSON or a non-array is empty.
      const [recent, setRecent] = React.useState(() => {
        try {
          const raw = localStorage.getItem("dsh-plugin-model-search:recent");
          const list = raw === null ? [] : JSON.parse(raw);
          return Array.isArray(list) ? list.slice(0, 5) : [];
        } catch {
          return [];
        }
      });
      const recordRecent = (provider, model) => {
        setRecent((prev) => {
          const next = [
            { p: provider, m: model },
            ...prev.filter((x) => !(x.p === provider && x.m === model)),
          ].slice(0, 5);
          try {
            localStorage.setItem("dsh-plugin-model-search:recent", JSON.stringify(next));
          } catch {
            // Storage unavailable (private mode / quota): recents become
            // session-only, which is fine.
          }
          return next;
        });
      };
      const toastSeq = React.useRef(0);
      const lastActionRef = React.useRef("load");
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const itemRefs = React.useRef([]);
      const id = React.useId();

      const choices = React.useMemo(
        () =>
          state.groups.flatMap((group) =>
            group.models.map((model) => ({
              group,
              model,
              selection: {
                provider: group.id,
                model: model.id,
                ...(model.reasoning?.defaultEffort === undefined
                  ? {}
                  : { reasoningEffort: model.reasoning.defaultEffort }),
              },
            }))
          ),
        [state.groups]
      );

      const recentChoices = React.useMemo(
        () =>
          recent
            .map((r) =>
              choices.find(
                (c) =>
                  c.selection.provider === r.p && c.selection.model === r.m
              )
            )
            .filter((c) => c !== undefined),
        [recent, choices]
      );

      const currentChoice =
        choices[
          state.current === null
            ? -1
            : choices.findIndex(
                (c) =>
                  c.selection.provider === state.current?.provider &&
                  c.selection.model === state.current.model
              )
        ];
      const reasoning = currentChoice?.model.reasoning;
      const effectiveEffort =
        state.current?.reasoningEffort ?? reasoning?.defaultEffort;
      const effortLabel =
        reasoning === undefined
          ? undefined
          : effectiveEffort === undefined
            ? t("effort.providerDefault")
            : reasoning.efforts.find((level) => level.id === effectiveEffort)
                ?.name ?? effectiveEffort;
      const effortChoices = React.useMemo(
        () =>
          reasoning === undefined
            ? []
            : [
                ...(reasoning.defaultEffort === undefined
                  ? [
                      {
                        key: "provider-default",
                        effort: undefined,
                        label: t("effort.providerDefault"),
                      },
                    ]
                  : []),
                ...reasoning.efforts.map((effort) => ({
                  key: `effort:${effort.id}`,
                  effort: effort.id,
                  label: effort.name,
                  ...(effort.description === undefined
                    ? {}
                    : { description: effort.description }),
                })),
              ],
        [reasoning, t]
      );
      const busy = state.status === "selecting";

      const q = query.trim().toLowerCase();
      const visibleGroups = React.useMemo(() => {
        if (q.length === 0) return state.groups;
        const result = [];
        for (const group of state.groups) {
          const groupMatch =
            (group.name || "").toLowerCase().includes(q) ||
            String(group.id || "").toLowerCase().includes(q);
          const models = groupMatch
            ? group.models
            : group.models.filter(
                (model) =>
                  (model.name || "").toLowerCase().includes(q) ||
                  String(model.id || "").toLowerCase().includes(q) ||
                  (model.description || "").toLowerCase().includes(q)
              );
          if (models.length > 0) result.push({ ...group, models });
        }
        return result;
      }, [state.groups, q]);
      const visibleCount = visibleGroups.reduce(
        (n, group) => n + group.models.length,
        0
      );

      const reload = () => {
        lastActionRef.current = "load";
        load();
      };

      React.useEffect(() => {
        if (available) {
          lastActionRef.current = "load";
          load();
        }
      }, [available, load]);

      React.useEffect(() => {
        if (!open) return;
        const closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", closeOutside);
        return () => {
          document.removeEventListener("mousedown", closeOutside);
        };
      }, [open]);

      React.useEffect(() => {
        // Auto-focus only on desktop. On a phone the popover is meant to be
        // a calm picker: focusing the search box would pop the IME and cover
        // half the screen before the user even decided to search.
        if (!open || pane !== "model") return;
        if (window.matchMedia("(max-width: 900px)").matches) return;
        searchRef.current?.focus();
        searchRef.current?.select();
      }, [open, pane]);

      if (!available) return null;

      const show = () => {
        setPane("root");
        setQuery("");
        setOpen(true);
        reload();
      };
      const close = (restoreFocus = false) => {
        setOpen(false);
        setPane("root");
        setQuery("");
        if (restoreFocus) {
          queueMicrotask(() => {
            triggerRef.current?.focus();
          });
        }
      };
      const moveFocus = (offset) => {
        const items = itemRefs.current.filter((item) => item !== null);
        if (items.length === 0) return;
        const active = items.findIndex(
          (item) => item === document.activeElement
        );
        items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus();
      };
      const onRootKeyDown = (event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          if (pane !== "root") setPane("root");
          else close(true);
          return;
        }
        if (!open || event.target === searchRef.current) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(event.key === "ArrowDown" ? 1 : -1);
        }
      };
      const onSearchKeyDown = (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          moveFocus(event.key === "ArrowDown" ? 0 : -1);
          return;
        }
        if (event.key === "Escape") {
          event.stopPropagation();
          if (query.length > 0) {
            setQuery("");
          } else {
            setPane("root");
          }
        }
      };
      const onBlur = (event) => {
        if (
          event.relatedTarget instanceof Node &&
          rootRef.current?.contains(event.relatedTarget)
        ) {
          return;
        }
        close();
      };
      const settleSelection = (accepted) => {
        if (accepted) {
          if (rootRef.current !== null) close(true);
          return;
        }
        const message = directory.getSnapshot().error;
        if (message !== null) {
          toastSeq.current += 1;
          setToast({
            seq: toastSeq.current,
            text: t("error.action", { message }),
          });
        }
      };
      const choose = (selection) => {
        if (
          state.current?.provider === selection.provider &&
          state.current.model === selection.model
        ) {
          close(true);
          return;
        }
        recordRecent(selection.provider, selection.model);
        lastActionRef.current = "select";
        select(selection).then(settleSelection);
      };
      const chooseEffort = (effort) => {
        if (state.current === null) return;
        if (effectiveEffort === effort) {
          close(true);
          return;
        }
        const selection = {
          provider: state.current.provider,
          model: state.current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
        lastActionRef.current = "select";
        select(selection).then(settleSelection);
      };
      const modelLabel = currentChoice?.model.name ?? t("trigger.fallback");
      const triggerLabel =
        effortLabel === undefined
          ? modelLabel
          : `${modelLabel} · ${effortLabel}`;
      const triggerAria =
        currentChoice === undefined
          ? t("trigger.selectAria")
          : effortLabel === undefined
            ? t("trigger.aria", { model: modelLabel })
            : t("trigger.ariaEffort", { model: modelLabel, effort: effortLabel });

      itemRefs.current = [];
      let itemIndex = 0;
      const itemRef = () => {
        const at = itemIndex++;
        return (node) => {
          itemRefs.current[at] = node;
        };
      };

      /** One model row. Shared by provider groups and the recent section so
       * both render (and keyboard-navigate) identically. */
      const renderModelOption = (group, model) => {
        const selected =
          state.current?.provider === group.id &&
          state.current.model === model.id;
        return React.createElement(
          "button",
          {
            ref: itemRef(),
            type: "button",
            role: "menuitemradio",
            "aria-checked": selected,
            className: cx("msrch_option", selected && "msrch_selected"),
            title: `${model.name} · ${model.id}`,
            disabled: busy,
            key: `${group.id}:${model.id}`,
            onClick: () => {
              choose({ provider: group.id, model: model.id });
            },
          },
          React.createElement(
            "span",
            { className: "msrch_optionCopy" },
            React.createElement(
              "span",
              { className: "msrch_modelName" },
              model.name
            ),
            model.description !== undefined
              ? React.createElement(
                  "span",
                  { className: "msrch_description" },
                  model.description
                )
              : null
          ),
          React.createElement(
            "span",
            { className: "msrch_check" },
            selected ? React.createElement(IconCheckOutline16, {}) : null
          )
        );
      };

      const modelPane = () =>
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            { className: "msrch_searchWrap", role: "none" },
            React.createElement(IconSearchOutline16, {
              size: 14,
              className: "msrch_searchIcon",
            }),
            React.createElement("input", {
              ref: searchRef,
              className: "msrch_searchInput",
              type: "text",
              value: query,
              placeholder: t("search.placeholder"),
              "aria-label": t("search.placeholder"),
              disabled: busy,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: onSearchKeyDown,
            }),
            q.length > 0
              ? React.createElement("span", { className: "msrch_count" }, visibleCount)
              : null,
            query.length > 0
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "msrch_searchClear",
                    "aria-label": t("search.clear"),
                    onClick: () => {
                      setQuery("");
                      searchRef.current?.focus();
                    },
                  },
                  React.createElement(IconCloseFill14, { size: 12 })
                )
              : null
          ),
          state.status === "loading"
            ? React.createElement(
                "div",
                { className: "msrch_status" },
                t("status.loading")
              )
            : null,
          state.error !== null && lastActionRef.current === "load"
            ? React.createElement(
                "div",
                { className: "msrch_error" },
                React.createElement(
                  "span",
                  null,
                  t("error.action", { message: state.error })
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "msrch_retry",
                    onClick: reload,
                  },
                  t("retry")
                )
              )
            : null,
          state.failures.map((failure) =>
            React.createElement(
              "div",
              { className: "msrch_warning", key: failure.id },
              React.createElement(
                "span",
                null,
                t("warning.groupLoad", {
                  name: failure.name,
                  message: failure.message,
                })
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "msrch_retry",
                  onClick: reload,
                },
                t("retry")
              )
            )
          ),
          React.createElement(
            "div",
            { className: cx("msrch_groups", "scrollable") },
            q.length === 0 && recentChoices.length > 0
              ? React.createElement(
                  "section",
                  {
                    role: "group",
                    "aria-label": t("recent.title"),
                    className: "msrch_group msrch_recent",
                    key: "$recent",
                  },
                  React.createElement(
                    "div",
                    { className: "msrch_groupTitle" },
                    t("recent.title")
                  ),
                  recentChoices.map(({ group, model }) =>
                    renderModelOption(group, model)
                  )
                )
              : null,
            visibleGroups.map((group) => {
              const headingId = `${id}-${group.id}`;
              return React.createElement(
                "section",
                {
                  role: "group",
                  "aria-labelledby": headingId,
                  className: "msrch_group",
                  key: group.id,
                },
                React.createElement(
                  "div",
                  { className: "msrch_groupTitle", id: headingId },
                  group.name
                ),
                group.models.map((model) => renderModelOption(group, model))
              );
            }),
            state.status === "ready" && visibleCount === 0 && recentChoices.length === 0
              ? React.createElement(
                  "div",
                  { className: "msrch_empty" },
                  q.length > 0 ? t("empty.noMatch") : t("empty.models")
                )
              : null
          )
        );

      const effortPane = () =>
        React.createElement(
          React.Fragment,
          null,
          state.error !== null && lastActionRef.current === "load"
            ? React.createElement(
                "div",
                { className: "msrch_error" },
                React.createElement(
                  "span",
                  null,
                  t("error.action", { message: state.error })
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "msrch_retry",
                    onClick: reload,
                  },
                  t("retry")
                )
              )
            : null,
          effortChoices.length === 0
            ? React.createElement(
                "div",
                { className: "msrch_empty" },
                t("empty.efforts")
              )
            : effortChoices.map((level) =>
                React.createElement(
                  "button",
                  {
                    ref: itemRef(),
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": effectiveEffort === level.effort,
                    className: cx(
                      "msrch_option",
                      effectiveEffort === level.effort && "msrch_selected"
                    ),
                    disabled: busy,
                    key: level.key,
                    onClick: () => {
                      chooseEffort(level.effort);
                    },
                  },
                  React.createElement(
                    "span",
                    { className: "msrch_optionCopy" },
                    React.createElement(
                      "span",
                      { className: "msrch_modelName" },
                      level.label
                    ),
                    level.description !== undefined
                      ? React.createElement(
                          "span",
                          { className: "msrch_description" },
                          level.description
                        )
                      : null
                  ),
                  React.createElement(
                    "span",
                    { className: "msrch_check" },
                    effectiveEffort === level.effort
                      ? React.createElement(IconCheckOutline16, {})
                      : null
                  )
                )
              )
        );

      return React.createElement(
        "div",
        {
          ref: rootRef,
          className: "msrch_root",
          onKeyDown: onRootKeyDown,
          onBlur,
        },
        React.createElement(
          "button",
          {
            ref: triggerRef,
            type: "button",
            className: "msrch_trigger",
            "aria-label": triggerAria,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": open ? `${id}-menu` : undefined,
            title: triggerLabel,
            disabled: locked,
            onClick: () => {
              if (open) close();
              else show();
            },
          },
          React.createElement(
            "span",
            { className: "msrch_triggerLabel" },
            modelLabel
          ),
          effortLabel !== undefined
            ? React.createElement(
                "span",
                { className: "msrch_triggerEffort" },
                effortLabel
              )
            : null,
          React.createElement(IconChevronDownOutline14, {
            className: cx("msrch_chevron", open && "msrch_chevronOpen"),
          })
        ),
        open
          ? React.createElement(
              "div",
              {
                id: `${id}-menu`,
                className: "msrch_menu",
                role: "menu",
                "aria-label": t("menu.aria"),
                "aria-busy": state.status === "loading" || busy,
                // Inside taps must NEVER look like an outside tap. Some
                // mobile browsers deliver a synthetic mousedown after the
                // pointer sequence; stopping it at the menu boundary keeps
                // the document-level closeOutside handler from eating the
                // very tap that should navigate model → effort panes.
                onPointerDown: (event) => event.stopPropagation(),
                onMouseDown: (event) => event.stopPropagation(),
              },
              pane === "root"
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      "button",
                      {
                        ref: itemRef(),
                        type: "button",
                        role: "menuitem",
                        className: "msrch_cell",
                        onClick: () => {
                          setQuery("");
                          setPane("model");
                        },
                      },
                      React.createElement(
                        "span",
                        { className: "msrch_cellLabel" },
                        t("menu.model")
                      ),
                      React.createElement(
                        "span",
                        { className: "msrch_cellValue" },
                        modelLabel
                      ),
                      React.createElement(IconChevronRightOutline14, {
                        className: "msrch_cellChevron",
                      })
                    ),
                    reasoning !== undefined
                      ? React.createElement(
                          "button",
                          {
                            ref: itemRef(),
                            type: "button",
                            role: "menuitem",
                            className: "msrch_cell",
                            onClick: () => {
                              setQuery("");
                              setPane("effort");
                            },
                          },
                          React.createElement(
                            "span",
                            { className: "msrch_cellLabel" },
                            t("menu.effort")
                          ),
                          React.createElement(
                            "span",
                            { className: "msrch_cellValue" },
                            effortLabel
                          ),
                          React.createElement(IconChevronRightOutline14, {
                            className: "msrch_cellChevron",
                          })
                        )
                      : null
                  )
                : null,
              pane === "model" ? modelPane() : null,
              pane === "effort" ? effortPane() : null
            )
          : null,
        toast !== null
          ? React.createElement(Toast, {
              text: toast.text,
              icon: React.createElement(IconWarningOutline16, {}),
              anchor: rootRef.current?.closest("[data-composer-card]") ?? null,
              onDone: () => {
                setToast(null);
              },
            })
          : null
      );
    }

    /** Dictionary namespace owned by this plugin. */
    const NS = "model-search";

    const zh = {
      "trigger.fallback": "选择模型",
      "trigger.selectAria": "选择模型",
      "trigger.aria": "选择模型，当前 {model}",
      "trigger.ariaEffort": "选择模型，当前 {model}，推理等级 {effort}",
      "menu.aria": "模型与推理等级",
      "menu.model": "模型",
      "menu.effort": "推理等级",
      "effort.providerDefault": "Default",
      "status.loading": "正在刷新模型列表…",
      "error.action": "模型操作失败：{message}",
      "retry": "重试",
      "warning.groupLoad": "{name} 加载失败：{message}",
      "empty.models": "没有可用的模型。",
      "empty.efforts": "当前模型未提供推理等级。",
      "empty.noMatch": "没有匹配的模型。",
      "recent.title": "最近使用",
      "search.placeholder": "搜索模型名 / ID / 描述…",
      "search.clear": "清除搜索",
    };

    const en = {
      "trigger.fallback": "Select model",
      "trigger.selectAria": "Select model",
      "trigger.aria": "Select model, current {model}",
      "trigger.ariaEffort":
        "Select model, current {model}, reasoning effort {effort}",
      "menu.aria": "Model and reasoning effort",
      "menu.model": "Model",
      "menu.effort": "Effort",
      "effort.providerDefault": "Default",
      "status.loading": "Refreshing model list…",
      "error.action": "Model operation failed: {message}",
      "retry": "Retry",
      "warning.groupLoad": "{name} failed to load: {message}",
      "empty.models": "No models available.",
      "empty.efforts": "This model provides no reasoning effort levels.",
      "empty.noMatch": "No models match your search.",
      "recent.title": "Recent",
      "search.placeholder": "Search name / ID / description…",
      "search.clear": "Clear search",
    };

    /** Required services, resolved before `apply` runs. */
    // 2026-09-08 (DSH 0.1.2-rc.1): declare the connection-plane services so the
    // runner defers this plugin until remote.session is published. The
    // modelDirectories.directoryFor implementation resolves ctx.remote.session
    // internally; calling it before the mux connection exists throws and the
    // slot error boundary abdicates the seat. Deferral keeps the original
    // synchronous implementation correct with no lazy-store workaround.
    const inject = ["slots", "sessions", "modelDirectories", "locale", "remote", "remote.session"];

    /**
     * Register the searchable model seat at priority -1. The slot is
     * single-kind, so the lower priority shadows the built-in registration
     * (priority 0); if this entry ever crashes, the slot error boundary
     * abdicates it and the built-in seat renders again.
     */
    function apply(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-model-search";
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => {
        style.remove();
      });

      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "dsh-plugin-model-search: copy dictionaries"
      );

      const models = ctx.modelDirectories;
      const sessions = ctx.sessions;

      ctx.slots.inject("conversation.input.model", () =>
        ctx.slots.register(
          {
            name: "conversation.input.model",
            locale: NS,
            priority: -1,
            inject: (sessionId) => {
              const directory = models.directoryFor(sessionId);
              const available = sessions.subagentAddress(sessionId) === undefined;
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => {});
                },
                select: (selection) =>
                  available
                    ? directory.select(selection).then(() => true, () => false)
                    : Promise.resolve(false),
              };
            },
          },
          ModelSearchSelect
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
