    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
.pe-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;-webkit-font-smoothing:antialiased}
.pe-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pe-brand{display:flex;align-items:center;gap:10px;min-width:0}
.pe-logo{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.pe-title{font-size:13.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.pe-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:15px;font-variant-numeric:tabular-nums;white-space:nowrap}
.pe-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.pe-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;font-variant-numeric:tabular-nums;line-height:17px}
.pe-chip-count{color:var(--dsw-alias-label-primary);font-weight:600}
.pe-swatch{width:9px;height:9px;border-radius:3px;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.18) inset}
.pe-swatch-sm{width:7px;height:7px;border-radius:2px}
.pe-controls{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.pe-seg{display:inline-flex;align-items:center;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-seg-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;line-height:16px;padding:3px 9px;border-radius:7px;cursor:pointer;min-width:34px}
.pe-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.pe-seg-btn.is-active{background:var(--dsw-alias-brand-primary);color:#fff}
.pe-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.pe-btn:hover{background:var(--dsw-alias-bg-overlay)}
.pe-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-btn-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pe-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.pe-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pe-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pe-btn-block{width:100%}
.pe-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.pe-icon-btn:hover{background:var(--dsw-alias-bg-overlay)}
.pe-icon-btn-lg{width:32px;height:32px;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.pe-divider{width:1px;height:20px;background:var(--dsw-alias-border-l1)}
.pe-body{display:flex;flex:1;min-height:0;min-width:0}
.pe-stage{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;background:radial-gradient(circle at 50% 40%, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-base) 70%)}
.pe-canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;image-rendering:crisp-edges;touch-action:none;display:block;border-radius:2px;box-shadow:0 10px 30px rgba(0,0,0,.22)}
.pe-toast{position:absolute;left:50%;bottom:104px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(20,22,28,.82);color:#fff;font-size:11.5px;line-height:16px;box-shadow:0 8px 20px rgba(0,0,0,.32);pointer-events:none}
.pe-hud{position:absolute;display:flex;align-items:center;gap:6px;pointer-events:none}
.pe-hud-bl{left:12px;bottom:12px}
.pe-hud-br{right:12px;bottom:12px;pointer-events:auto}
.pe-hud-item{padding:2px 7px;border-radius:7px;background:rgba(20,22,28,.55);color:#fff;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;backdrop-filter:blur(4px)}
.pe-minimap{padding:5px;border-radius:10px;background:rgba(20,22,28,.6);backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.28)}
.pe-minimap-canvas{display:block;border-radius:6px;cursor:pointer;image-rendering:pixelated}
.pe-side{width:320px;flex:none;display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.pe-panel{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.pe-panel-grow{flex:1;min-height:0}
.pe-panel-row{flex-direction:row;align-items:center;justify-content:space-between}
.pe-panel-title{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pe-tools{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.pe-tool{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:52px;padding:4px 2px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:12px;cursor:pointer;transition:transform .1s ease,border-color .12s ease,background .12s ease}
.pe-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pe-tool:active{transform:scale(.96)}
.pe-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-tool.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.pe-tool-label{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-chart{width:100%;height:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
.pe-legend{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}
.pe-legend-item{display:inline-flex;align-items:center;gap:4px}
.pe-card{display:flex;flex-direction:column;gap:8px}
.pe-card-head{display:flex;align-items:center;gap:7px}
.pe-card-title{font-weight:650;font-size:12.5px}
.pe-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}
.pe-tag-alert{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pe-chipline{display:flex;gap:6px;flex-wrap:wrap}
.pe-card-head .pe-icon-btn{margin-left:auto;width:22px;height:22px;border-radius:6px}
.pe-meter{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.pe-meter-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-success-primary))}
.pe-rows{display:flex;flex-direction:column;gap:3px}
.pe-row{display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.pe-row b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.pe-genes{display:flex;flex-direction:column;gap:5px}
.pe-gene{display:grid;grid-template-columns:52px 1fr 34px;align-items:center;gap:7px}
.pe-gene-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-gene-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-gene-fill{display:block;height:100%;border-radius:999px}
.pe-gene-value{text-align:right;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 8px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);text-align:center}
.pe-empty-icon{opacity:.55}
.pe-empty-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:11.5px}
.pe-empty-hint{font-size:10.5px;line-height:15px;opacity:.9}
.pe-modal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);z-index:6}
.pe-modal-card{width:min(560px,100%);max-height:100%;overflow:auto;padding:18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 44px rgba(0,0,0,.34);box-sizing:border-box}
.pe-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.pe-modal-body{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:7px;font-size:12px;line-height:18px}
.pe-fatal{display:flex;flex-direction:column;gap:8px;padding:18px;border-radius:12px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;overflow:auto}
.pe-fatal-title{font-weight:700;color:var(--dsw-alias-state-error-primary)}
.pe-fatal-body{margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.pe-needs{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pe-need{display:grid;grid-template-columns:44px 1fr 26px;align-items:center;gap:6px}
.pe-need-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px}
.pe-need-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-need-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),var(--dsw-alias-state-error-primary))}
.pe-need-value{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-tag-intent{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}@media (max-width: 980px){.pe-side{width:270px}.pe-tools{grid-template-columns:repeat(3,1fr)}}
.pe-stagewrap{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.pe-eventbar{display:flex;align-items:center;gap:8px;flex:none;height:46px;padding:0 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.pe-eventbar-title{flex:none;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pe-events-filters{display:flex;gap:3px;flex:none}
.pe-eventfilter{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:16px;padding:1px 6px;border-radius:999px;cursor:pointer}
.pe-eventfilter:hover{color:var(--dsw-alias-label-primary)}
.pe-eventfilter.is-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.pe-events{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.pe-event{appearance:none;display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:0 8px 0 5px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.pe-event:hover{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-border-l2)}
.pe-event:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pe-event-predation{border-color:var(--dsw-alias-state-error-primary)}
.pe-event-birth{border-color:var(--dsw-alias-state-success-primary)}
.pe-event-death{border-style:dashed}
.pe-event-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-event-time{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums}
.pe-event-where{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;opacity:.8}
.pe-events-empty{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}

.pe-tabs{display:flex;gap:4px;padding:3px;flex:none;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-tab{appearance:none;flex:1;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;line-height:16px;padding:4px 6px;border-radius:7px;cursor:pointer}
.pe-tab:hover{color:var(--dsw-alias-label-primary)}
.pe-tab.is-active{background:var(--dsw-alias-brand-primary);color:#fff}
.pe-tabbody{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow:auto}
.pe-dock{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);max-height:56%;overflow:auto}
.pe-blank{display:flex;align-items:center;gap:6px;padding:9px 10px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}
.pe-note{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
.pe-muted{color:var(--dsw-alias-label-secondary)}
.pe-mono{font-variant-numeric:tabular-nums}

.pe-srow{display:grid;grid-template-columns:13px 1fr 40px 52px 46px;align-items:center;gap:6px;font-size:11px;line-height:16px;cursor:pointer;border-radius:6px;padding:1px 3px}
.pe-srow:hover{background:var(--dsw-alias-bg-layer-2)}
.pe-srow-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-srow-num{text-align:right;font-variant-numeric:tabular-nums}
.pe-srow.is-gone .pe-srow-name{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.pe-srow-head{color:var(--dsw-alias-label-secondary);font-size:10px;cursor:default}
.pe-sbar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-sbar-fill{display:block;height:100%;border-radius:999px}
.pe-causes{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pe-cause{display:block;height:100%}

.pe-drive{display:grid;grid-template-columns:50px 1fr 28px;align-items:center;gap:6px}
.pe-drive-label{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-drive-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-drive-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-warn-primary))}
.pe-drive.is-high .pe-drive-fill{background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),var(--dsw-alias-state-error-primary))}
.pe-drive-value{text-align:right;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pe-kv{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:11px;line-height:15px}
.pe-kv-key{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pe-kv-value{text-align:right;font-variant-numeric:tabular-nums}
.pe-quote{padding:6px 8px;border-radius:8px;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px}
.pe-quote-meta{display:block;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;margin-top:2px}

.pe-flow{display:flex;flex-direction:column;gap:4px}
.pe-flow-row{display:grid;grid-template-columns:64px 1fr 60px;align-items:center;gap:6px;font-size:11px;line-height:15px}
.pe-flow-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pe-flow-track{position:relative;height:11px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.pe-flow-fill{display:block;height:100%;border-radius:4px;transition:width .25s ease}
.pe-flow-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}

.pe-onboard{position:absolute;left:50%;top:14px;transform:translateX(-50%);width:min(430px,calc(100% - 24px));padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 14px 34px rgba(0,0,0,.32);z-index:5}
.pe-onboard-title{font-weight:650;font-size:12.5px;line-height:18px;margin-bottom:6px}
.pe-onboard-steps{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.pe-onboard-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:9px}
.pe-emptyworld{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 18px;border-radius:12px;background:rgba(20,22,28,.72);color:#fff;text-align:center;z-index:4;backdrop-filter:blur(4px)}
.pe-emptyworld-title{font-weight:650;font-size:12.5px;line-height:18px}
.pe-emptyworld-hint{font-size:11px;line-height:15px;opacity:.86}
.pe-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;font-variant-numeric:tabular-nums}
.pe-pill-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pe-pill-live{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.pe-brushpreview{position:absolute;transform:translate(-50%,-50%);border:1px dashed rgba(255,255,255,.85);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;z-index:3}
.pe-notice{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);width:min(460px,calc(100% - 24px));padding:10px 12px;border-radius:11px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-warn-primary);box-shadow:0 12px 28px rgba(0,0,0,.3);z-index:6}
.pe-notice-title{font-weight:650;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}
.pe-notice-body{margin-top:3px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.pe-notice-actions{display:flex;justify-content:flex-end;margin-top:7px}
@media (max-width: 760px){.pe-eventbar{height:38px}}
`
