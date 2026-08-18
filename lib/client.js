/**
 * dsh-plugin-goldboard client half: hand-written factory-CJS browser bundle,
 * no build step.
 *
 * UI contributions:
 *   - shell.overlay: draggable top-right floating gold board, collapsible to
 *     a compact price bar showing SGE Au99.99 / XAU spot / CMB 积存金,
 *     with converted prices, a today-only interactive sparkline and
 *     fee-adjusted plan summary.
 *   - settings.section: position, limits, fee, CMB spread, strategy knobs,
 *     trading hours, host system notification and webhook channels.
 *
 * All user-visible strings go through the locale service (zh/en dictionaries
 * are registered under the dsh-plugin-goldboard namespace and live-switch
 * with Settings → General → Language). Dark/light theming uses
 * --dsw-alias-* tokens only.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-goldboard",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch (_) { }

    var NS = "dsh-plugin-goldboard";
    var SNAPSHOT_URL = "/dsh-plugin-goldboard/snapshot";
    var CONFIG_URL = "/dsh-plugin-goldboard/config";
    var TEST_URL = "/dsh-plugin-goldboard/test-notify";
    var POSITION_KEY = "dsh-plugin-goldboard:position";
    var COLLAPSED_KEY = "dsh-plugin-goldboard:collapsed";

    // ── css ────────────────────────────────────────────────────────────────

    (function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin="dsh-plugin-goldboard"]')) return;
      var style = document.createElement("style");
      style.setAttribute("data-plugin", "dsh-plugin-goldboard");
      style.setAttribute("data-pluginCss", "dsh-plugin-goldboard");
      style.textContent = [
        ".dsh-goldboard-root{position:absolute;z-index:21;user-select:none;-webkit-user-select:none;font-family:inherit;}",
        ".dsh-goldboard-orb{box-sizing:border-box;min-width:280px;max-width:calc(100vw - 16px);height:40px;border-radius:999px;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:0 16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-button-floating-fill,#fff);box-shadow:0 4px 14px rgba(15,23,42,.16);cursor:grab;touch-action:none;animation:dsh-goldboard-fade-in .18s ease-out;}",
        ".dsh-goldboard-orb:active{cursor:grabbing;}",
        ".dsh-goldboard-orb:hover{background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-overlay,#fff));}",
        ".dsh-goldboard-mini{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;line-height:1.2;}",
        ".dsh-goldboard-mini-label{font-size:9px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        ".dsh-goldboard-mini-value{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        ".dsh-goldboard-mini-arrow{flex:none;display:flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-mini-arrow svg{display:block;width:12px;height:12px;}",
        ".dsh-goldboard-card{width:400px;max-width:calc(100vw - 16px);box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:14px;background:#2C2C2E;color:#f5f5f7;box-shadow:0 12px 32px rgba(15,23,42,.18);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);max-height:calc(100vh - 24px);overflow-y:auto;scrollbar-width:thin;animation:dsh-goldboard-pop-in .16s ease-out;}",
        ".dsh-goldboard-card .dsh-goldboard-head-sub,.dsh-goldboard-card .dsh-goldboard-item-label,.dsh-goldboard-card .dsh-goldboard-meta,.dsh-goldboard-card .dsh-goldboard-chart-title,.dsh-goldboard-card .dsh-goldboard-trend-empty,.dsh-goldboard-card .dsh-goldboard-plan-reason,.dsh-goldboard-card .dsh-goldboard-risk,.dsh-goldboard-card .dsh-goldboard-foot,.dsh-goldboard-card .dsh-goldboard-loading{color:rgba(255,255,255,.62);}",
        ".dsh-goldboard-card .dsh-goldboard-plan-row{color:rgba(255,255,255,.82);}",
        ".dsh-goldboard-card .dsh-goldboard-plan-action{color:rgba(255,255,255,.96);}",
        ".dsh-goldboard-card .dsh-goldboard-iconbtn{color:rgba(255,255,255,.75);}",
        ".dsh-goldboard-card .dsh-goldboard-item-value.dsh-goldboard-flat{color:rgba(255,255,255,.9);}",
        ".dsh-goldboard-head{display:flex;align-items:flex-start;gap:8px;cursor:grab;touch-action:none;}",
        ".dsh-goldboard-head:active{cursor:grabbing;}",
        ".dsh-goldboard-head-title{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;}",
        ".dsh-goldboard-head-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-iconbtn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:14px;line-height:1;padding:4px 6px;border-radius:8px;}",
        ".dsh-goldboard-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
        ".dsh-goldboard-card .dsh-goldboard-iconbtn:hover{color:rgba(255,255,255,.9);}",
        ".dsh-goldboard-foot{flex:none;display:flex;align-items:center;justify-content:center;gap:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));cursor:grab;touch-action:none;}",
        ".dsh-goldboard-foot:active{cursor:grabbing;}",
        ".dsh-goldboard-foot:hover{color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-goldboard-card .dsh-goldboard-foot:hover{color:rgba(255,255,255,.85);}",
        ".dsh-goldboard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}",
        ".dsh-goldboard-item{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:10px;padding:8px;min-width:0;display:flex;flex-direction:column;gap:4px;}",
        ".dsh-goldboard-item-clickable{cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease;}",
        ".dsh-goldboard-item-clickable:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.6));}",
        ".dsh-goldboard-item-active{border-color:var(--dsw-alias-state-business-primary,#6d8dff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#6d8dff);}",
        ".dsh-goldboard-cmb-row{grid-column:1 / -1;}",
        ".dsh-goldboard-cmb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}",
        ".dsh-goldboard-cmb-head .dsh-goldboard-item-label{flex:1;min-width:0;}",
        ".dsh-goldboard-cmb-prices{flex:none;font-size:10px;line-height:16px;color:rgba(255,255,255,.72);text-align:right;white-space:nowrap;}",
        ".dsh-goldboard-tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:inherit;cursor:help;vertical-align:middle;}",
        ".dsh-goldboard-tip svg{display:block;width:14px;height:14px;}",
        ".dsh-goldboard-tip-pop{position:fixed;z-index:9999;width:max-content;max-width:220px;padding:6px 8px;border-radius:8px;background:#2C2C2E;border:1px solid rgba(255,255,255,.18);color:#f5f5f7;font-family:inherit;font-size:11px;line-height:16px;font-weight:400;white-space:pre-line;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none;}",
        ".dsh-goldboard-item-label{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));white-space:nowrap;overflow:visible;}",
        ".dsh-goldboard-item-label-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
        ".dsh-goldboard-item-value{font-size:15px;font-weight:600;line-height:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        ".dsh-goldboard-up{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-down{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-flat{color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-goldboard-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));display:flex;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-spark{width:100%;height:64px;display:block;}",
        ".dsh-goldboard-chart{position:relative;width:100%;height:64px;}",
        ".dsh-goldboard-chart-block{display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-chart-title{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));margin-bottom:2px;}",
        ".dsh-goldboard-chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
        ".dsh-goldboard-chart-toggle{flex:none;padding:2px 8px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;}",
        ".dsh-goldboard-chart-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
        ".dsh-goldboard-chart-tip{position:absolute;top:0;transform:translateX(-50%);pointer-events:none;z-index:2;background:#2C2C2E;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:3px 6px;font-size:11px;line-height:15px;color:#f5f5f7;white-space:nowrap;box-shadow:0 2px 8px rgba(15,23,42,.12);}",
        ".dsh-goldboard-chart-tip-time{color:rgba(255,255,255,.65);}",
        ".dsh-goldboard-chart-tip-value{font-weight:600;}",
        ".dsh-goldboard-chart-hover-line{stroke:var(--dsw-alias-border-l3,rgba(128,128,128,.55));stroke-width:1;stroke-dasharray:3 3;}",
        ".dsh-goldboard-chart-now-line{stroke:var(--dsw-alias-state-business-primary,#6d8dff);stroke-width:1;stroke-dasharray:4 4;}",
        ".dsh-goldboard-trend-empty{width:100%;box-sizing:border-box;height:64px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.45));border-radius:10px;padding:8px;font-size:12px;line-height:18px;text-align:center;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-plan{border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.45));border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;}",
        ".dsh-goldboard-plan-title{font-size:13px;font-weight:600;}",
        ".dsh-goldboard-plan-row{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);display:flex;justify-content:space-between;gap:8px;}",
        ".dsh-goldboard-plan-action{margin-top:2px;padding:6px 8px;border:1px solid var(--dsw-alias-state-business-primary,#6d8dff);border-radius:8px;background:rgba(109,141,255,.12);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);display:flex;justify-content:space-between;align-items:center;gap:8px;}",
        ".dsh-goldboard-plan-reason{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-indicator-detail{display:flex;flex-direction:column;gap:3px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));padding-top:5px;}",
        ".dsh-goldboard-indicator-title{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.75));}",
        ".dsh-goldboard-indicator-table{width:100%;border-collapse:collapse;font-size:10px;line-height:15px;table-layout:fixed;}",
        ".dsh-goldboard-indicator-table th,.dsh-goldboard-indicator-table td{padding:1px 3px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));}",
        ".dsh-goldboard-indicator-table th:first-child,.dsh-goldboard-indicator-table td:first-child{text-align:left;width:58px;}",
        ".dsh-goldboard-indicator-table th{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));font-weight:500;}",
        ".dsh-goldboard-indicator-table td{color:rgba(255,255,255,.85);}",
        ".dsh-goldboard-indicator-label{display:inline-flex;align-items:center;gap:2px;}",
        ".dsh-goldboard-indicator-table .dsh-goldboard-tip{width:10px;height:10px;}",
        ".dsh-goldboard-indicator-table .dsh-goldboard-tip svg{width:10px;height:10px;}",
        ".dsh-goldboard-indicator-table tr:last-child td{border-bottom:none;}",
        ".dsh-goldboard-indicator-up{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-indicator-down{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-copy{width:100%;border:none;border-radius:999px;padding:7px 10px;font:inherit;font-size:12px;font-weight:500;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#111417));color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer;}",
        ".dsh-goldboard-copy:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#111417));}",
        ".dsh-goldboard-risk{font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-loading{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-settings{box-sizing:border-box;max-width:720px;width:100%;height:calc(100% + 24px);min-height:0;display:flex;flex-direction:column;gap:12px;margin-bottom:-24px;}",
        ".dsh-goldboard-header{flex:none;display:flex;flex-direction:column;gap:4px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));}",
        ".dsh-goldboard-header-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;}",
        ".dsh-goldboard-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;}",
        ".dsh-goldboard-tag{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;font-weight:500;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));}",
        ".dsh-goldboard-tag-warn{color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        ".dsh-goldboard-tag-ok{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-tag-error{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-content{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:2px 8px 8px 2px;margin-right:-8px;scrollbar-width:thin;}",
        ".dsh-goldboard-content::-webkit-scrollbar{width:8px;background:transparent;}",
        ".dsh-goldboard-content::-webkit-scrollbar-thumb{background:transparent;border-radius:4px;}",
        ".dsh-goldboard-content:hover::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45));}",
        ".dsh-goldboard-footer{flex:none;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2,#fff);border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));padding:15px 2px 12px;}",
        ".dsh-goldboard-footer .dsh-goldboard-primary{width:100%;height:40px;border-radius:20px;padding:0 12px;}",
        ".dsh-goldboard-card-row{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:transparent;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}",
        ".dsh-goldboard-card-row h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}",
        ".dsh-goldboard-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 16px;}",
        ".dsh-goldboard-field{display:flex;flex-direction:column;gap:4px;min-width:0;}",
        ".dsh-goldboard-field > span:first-child{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-goldboard-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;}",
        ".dsh-goldboard-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#6d8dff);}",
        ".dsh-goldboard-input::placeholder{color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.6));}",
        ".dsh-goldboard-switch{position:relative;flex:none;width:40px;height:22px;border-radius:999px;border:none;padding:0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.42));cursor:pointer;transition:background .15s ease;}",
        ".dsh-goldboard-switch-on,.dsh-goldboard-switch-on:hover{background:var(--dsw-alias-state-business-primary,#6d8dff);}",
        ".dsh-goldboard-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#6d8dff);outline-offset:2px;}",
        ".dsh-goldboard-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,23,42,.25);transition:transform .15s ease;}",
        ".dsh-goldboard-switch-on .dsh-goldboard-switch-knob{transform:translateX(18px);}",
        ".dsh-goldboard-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
        ".dsh-goldboard-row > label{flex:1 1 240px;min-width:0;}",
        ".dsh-goldboard-btn{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer;}",
        ".dsh-goldboard-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.8));}",
        ".dsh-goldboard-btn:disabled{opacity:.4;cursor:not-allowed;}",
        ".dsh-goldboard-primary{border:none;border-radius:999px;padding:9px 12px;font-size:14px;font-weight:500;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#111417));color:var(--dsw-alias-label-primary-foreground,#fff);}",
        ".dsh-goldboard-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#111417));}",
        ".dsh-goldboard-primary:disabled{opacity:.4;cursor:not-allowed;}",
        ".dsh-goldboard-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-lot-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-goldboard-lots{display:flex;flex-direction:column;gap:8px;}",
        ".dsh-goldboard-lot-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-lot-row .dsh-goldboard-field{flex:1 1 120px;}",
        ".dsh-goldboard-generic{border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;}",
        ".dsh-goldboard-add{width:100%;height:40px;border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer;}",
        ".dsh-goldboard-add:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
        ".dsh-goldboard-log-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:16px;}",
        ".dsh-goldboard-log-dialog{width:min(680px,100%);max-height:80vh;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:14px;padding:16px;box-shadow:0 18px 48px rgba(15,23,42,.22);}",
        ".dsh-goldboard-log-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-log-title{flex:1;margin:0;font-size:14px;font-weight:600;}",
        ".dsh-goldboard-log-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;}",
        ".dsh-goldboard-log-item{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;}",
        ".dsh-goldboard-log-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-log-status{font-weight:600;}",
        ".dsh-goldboard-log-status-ok{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-log-status-fail{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-log-meta{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));word-break:break-all;}",
        ".dsh-goldboard-log-error{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-source-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));}",
        ".dsh-goldboard-source-info{flex:1;min-width:180px;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-source-name{font-size:13px;font-weight:500;}",
        ".dsh-goldboard-source-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        "@keyframes dsh-goldboard-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
        "@keyframes dsh-goldboard-pop-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card{background:#EDEFF4;color:#1c1c1e;border-color:rgba(0,0,0,.12);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-head-sub,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-item-label,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-meta,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-chart-title,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-trend-empty,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-plan-reason,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-risk,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-foot,body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-loading{color:rgba(0,0,0,.55);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-plan-row{color:rgba(0,0,0,.75);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-plan-action{color:rgba(0,0,0,.9);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-indicator-title{color:rgba(0,0,0,.65);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-indicator-table td{color:rgba(0,0,0,.8);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-iconbtn{color:rgba(0,0,0,.65);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-iconbtn:hover{color:rgba(0,0,0,.85);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-foot:hover{color:rgba(0,0,0,.75);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-item-value.dsh-goldboard-flat{color:rgba(0,0,0,.8);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-card .dsh-goldboard-cmb-prices{color:rgba(0,0,0,.6);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-chart-tip{background:#EDEFF4;border-color:rgba(0,0,0,.15);color:#1c1c1e;}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-chart-tip-time{color:rgba(0,0,0,.55);}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-tip-pop{background:#EDEFF4;border-color:rgba(0,0,0,.15);color:#1c1c1e;}",
      ].join("\n");
      document.head.appendChild(style);
    })();

    // ── i18n ───────────────────────────────────────────────────────────────

    var DICT = {
      zh: {
        nav: "黄金看板",
        boardTitle: "黄金看板",
        loading: "加载中…",
        loadError: "行情加载失败：{error}",
        retry: "重试",
        marketOpen: "交易中",
        marketClosed: "休市",
        marketClosedNext: "休市中，下次开市 {time}",
        todayClosedNext: "今日休市，下次开市时间 {time}",
        beijingTime: "北京时间",
        au9999: "国内金价 Au99.99",
        xau: "国际金价 XAU",
        shortAu9999: "国内",
        shortXau: "国际",
        shortCmb: "招行",
        todayTrend: "今日走势",
        gapConnect: "空缺连线",
        gapBreak: ">5分钟断开",
        usdcny: "美元人民币",
        cnyPerGram: "国际金价折算",
        premium: "内外价差",
        cmbEstimate: "招行积存金",
        cmbAppNote: "招行价以 App 为准",
        buy: "买入",
        sell: "卖出",
        suggest: "建议",
        current: "现价",
        high: "最高",
        low: "最低",
        open: "开盘",
        prevClose: "昨收",
        time: "时间",
        source: "来源",
        stale: "行情可能过期",
        collapse: "收起",
        expand: "展开",
        dragHint: "拖拽移动，点击展开",
        dragHintCard: "按住头部或底部拖动",
        copy: "复制委托",
        copied: "已复制",
        riskNote: "技术面参考，非投资建议",
        breakeven: "回本价",
        targetPrice: "卖出目标",
        stopPrice: "止损位",
        grams: "克",
        position: "当前持仓",
        pnl: "扣费浮盈亏",
        action_buy_setup: "出现买入机会啦，可以考虑入手～",
        action_add_position: "金价回调企稳，可以考虑补一点仓～",
        action_reduce_position: "金价冲高回落，可以考虑先减点仓～",
        action_sell_take_profit: "当前金价已经达到盈利目标啦，可以考虑卖出哦～",
        action_sell_trailing: "金价短线走弱啦，记得保护好利润～",
        action_sell_stop: "金价跌到止损位啦，注意控制风险～",
        action_sell_weakness: "盘面有点走弱，可以考虑减仓避险～",
        action_close_by_session_end: "快到收盘时间啦，注意日内了结～",
        action_wait: "暂时没有合适机会，再等等看～",
        action_market_closed: "现在是休市时间哦～",
        action_no_data: "还在等行情数据～",
        action_no_budget: "已经达到投入上限啦，先不加仓～",
        action_data_incomplete: "当前数据有缺失，暂不给出建议～",
        settingsNav: "黄金看板",
        settingsIntro: "管理黄金看板的持仓、交易参数与提醒渠道；修改后点击底部「保存」生效。",
        positionTitle: "持仓与上限",
        holdingsGrams: "当前持仓（克）",
        avgCost: "平均成本（元/克）",
        maxGrams: "最大投入（克）",
        positionLots: "持仓批次",
        lotGrams: "克数",
        lotPrice: "买入价（元/克）",
        addLot: "添加一笔",
        removeLot: "删除",
        positionHint: "按多笔买入记录，保存后自动汇总总克数和平均成本",
        totalGrams: "总克数",
        feeTitle: "手续费（招行积存金）",
        buyFee: "买入手续费（元/克）",
        sellFee: "卖出手续费（元/克）",
        feeTotal: "双边合计",
        cmbTitle: "招行积存金价格",
        cmbBuySpread: "买入价差（元/克，备用估算）",
        cmbSellSpread: "卖出价差（元/克，备用估算）",
        cmbHint: "优先从招行接口拉取实时客户买卖价；接口不可用时回退为国际金价按汇率折算 + 价差估算。实际以招行 App 报价为准。",
        strategyTitle: "日内信号参数",
        minProfit: "最小目标利润（元/克）",
        maxLoss: "最大可承受亏损（元/克）",
        slippage: "滑点估算（元/克）",
        estSpread: "点差估算（元/克）",
        rsiOversold: "RSI 超卖阈值",
        rsiOverbought: "RSI 超买阈值",
        atrFactor: "ATR 目标系数",
        nearSupportPct: "接近支撑判定（%）",
        minRemainGrams: "最小保留底仓（克）",
        signalCooldownMinutes: "同方向建议冷却（分钟）",
        confirmBars: "连续确认次数",
        scoreThreshold: "信号强度阈值",
        tradingTitle: "交易时段",
        weekdaysOnly: "仅工作日交易",
        openTime: "开盘时间",
        closeTime: "收盘时间（支持 26:00 表示次日 02:00）",
        holidays: "节假日（YYYY-MM-DD，逗号分隔）",
        alertsTitle: "提醒",
        systemEnabled: "宿主机系统通知",
        systemHint: "需要 DSH 宿主保持运行",
        webhookTitle: "Webhook",
        feishu: "飞书",
        dingtalk: "钉钉",
        wecom: "企业微信",
        webhookUrl: "Webhook 地址",
        webhookSecret: "签名密钥（可选）",
        webhookSecretSet: "已配置（留空保持不变）",
        webhookSecretClear: "清除密钥",
        webhookEnabled: "启用该渠道",
        webhookTemplate: "消息模板（可选）",
        webhookTemplateHint: "占位符：{{action}} {{instrument}} {{price}} {{cmbPrice}} {{target}} {{grams}} {{time}}",
        test: "发送测试",
        testSending: "发送中…",
        testOk: "测试消息已发送",
        testFailed: "测试失败：{error}",
        generic: "通用 Webhook",
        genericAdd: "添加",
        genericRemove: "移除",
        genericName: "名称",
        genericUrl: "URL",
        genericTemplate: "消息模板",
        genericNone: "暂无通用 webhook，点击「添加」创建。",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        saveError: "保存失败：{error}",
        unsaved: "有未保存的更改",
        retryConfig: "重试",
        loadConfigError: "无法加载配置：{error}",
        sourceStatus: "数据源状态",
        sourceFresh: "{source} · {time}",
        sourceStale: "{source} · 数据过期",
        sourceOk: "正常",
        sourceError: "异常",
        sourceUnknown: "未知",
        viewLogs: "查看日志",
        logsTitle: "接口调用日志",
        logsEmpty: "暂无日志",
        logsRefresh: "刷新",
        logsClose: "关闭",
        logsLoadError: "无法加载日志：{error}",
        logsSuccess: "成功",
        logsFailed: "失败",
        logTime: "时间",
        logDuration: "耗时",
        logUrl: "接口",
        logStatus: "状态",
        sourceCurrent: "当前",
        sourceNoCurrent: "未在用",
        sourceLast: "最近",
        sourceLogCount: "日志 {count} 条",
        noData: "暂无行情",
        reason: "参考理由",
        planTitle: "当前建议",
        dataCoverage: "数据覆盖率",
        confidence: "信号强度",
        indicatorDetail: "指标明细",
        indicatorTimeframe: "周期",
        indicatorEma20: "EMA20",
        indicatorEma20Tip: "指数移动平均线（周期20）。计算公式：EMA_t = 收盘价 × k + EMA_{t-1} × (1-k)，其中 k = 2/(20+1)。用于判断当前周期的趋势方向。",
        indicatorRsi: "RSI14",
        indicatorRsiTip: "相对强弱指标（周期14）。RSI = 100 × 平均涨幅 / (平均涨幅 + 平均跌幅)，基于最近 14 根 K 线的涨跌幅计算。用于衡量超买/超卖与回升力度。",
        indicatorSma5: "SMA5",
        indicatorSma5Tip: "5 周期简单移动平均线。SMA5 = 最近 5 根收盘价之和 ÷ 5。",
        indicatorSma20: "SMA20",
        indicatorSma20Tip: "20 周期简单移动平均线。SMA20 = 最近 20 根收盘价之和 ÷ 20。",
        indicatorSma60: "SMA60",
        indicatorSma60Tip: "60 周期简单移动平均线。SMA60 = 最近 60 根收盘价之和 ÷ 60。",
        indicatorBollLower: "布林下轨",
        indicatorBollLowerTip: "布林带下轨 = 中轨 − 2 × 标准差，其中中轨为 20 周期 SMA。用于判断短期超卖/支撑区域。",
        indicatorBollMid: "布林中轨",
        indicatorBollMidTip: "布林带中轨 = 20 周期简单移动平均线（SMA20）。",
        indicatorBollUpper: "布林上轨",
        indicatorBollUpperTip: "布林带上轨 = 中轨 + 2 × 标准差。用于判断短期超买/压力区域。",
        indicatorAtr: "ATR14",
        indicatorAtrTip: "14 周期平均真实波幅。TR = max(高−低, |高−前收|, |低−前收|)，ATR = 最近 14 个 TR 的均值。用于衡量波动幅度。",
        indicatorHigh20: "近20高",
        indicatorHigh20Tip: "最近 20 根 K 线中最高价的最大值，用于观察近期压力位。",
        indicatorLow20: "近20低",
        indicatorLow20Tip: "最近 20 根 K 线中最低价的最小值，用于观察近期支撑位。",
        indicatorMacd: "MACD",
        indicatorMacdTip: "MACD 柱 = DIF − DEA。DIF = EMA12 − EMA26，DEA 为 DIF 的 9 周期 EMA。柱体反映短期动能变化。",
        sellAll: "全部",
        validUntil: "建议有效期至",
      },
      en: {
        nav: "Gold Board",
        boardTitle: "Gold Board",
        loading: "Loading…",
        loadError: "Failed to load quotes: {error}",
        retry: "Retry",
        marketOpen: "Open",
        marketClosed: "Closed",
        marketClosedNext: "Market closed, next open {time}",
        todayClosedNext: "Closed today, next open {time}",
        beijingTime: "Beijing time",
        au9999: "Domestic Au99.99",
        xau: "International XAU",
        shortAu9999: "Domestic",
        shortXau: "Intl",
        shortCmb: "CMB",
        todayTrend: "Today",
        gapConnect: "Connect gaps",
        gapBreak: "Break >5min",
        usdcny: "USD/CNY",
        cnyPerGram: "XAU converted",
        premium: "Spread",
        cmbEstimate: "CMB 积存金",
        cmbAppNote: "Check the CMB app for the actual price",
        buy: "Buy",
        sell: "Sell",
        suggest: "suggest",
        current: "Last",
        high: "High",
        low: "Low",
        open: "Open",
        prevClose: "Prev close",
        time: "Time",
        source: "Source",
        stale: "Data may be stale",
        collapse: "Collapse",
        expand: "Expand",
        dragHint: "Drag to move, click to expand",
        dragHintCard: "Drag from the header or footer",
        copy: "Copy order",
        copied: "Copied",
        riskNote: "Technical reference, not investment advice",
        breakeven: "Breakeven",
        targetPrice: "Sell target",
        stopPrice: "Stop level",
        grams: "g",
        position: "Position",
        pnl: "Fee-adjusted P&L",
        action_buy_setup: "Buy opportunity spotted!",
        action_add_position: "Time to add a bit?",
        action_reduce_position: "Consider trimming some",
        action_sell_take_profit: "Target reached — consider selling!",
        action_sell_trailing: "Pullback detected — protect your profit",
        action_sell_stop: "Stop hit — manage risk",
        action_sell_weakness: "Momentum fading — consider reducing",
        action_close_by_session_end: "Session ending soon — consider closing",
        action_wait: "No opportunity yet",
        action_market_closed: "Market is closed",
        action_no_data: "Waiting for quotes",
        action_no_budget: "Position limit reached",
        action_data_incomplete: "Data incomplete — no suggestion for now",
        settingsNav: "Gold Board",
        settingsIntro: "Manage positions, trading parameters and alert channels for the gold board. Changes take effect after you save.",
        positionTitle: "Position & limits",
        holdingsGrams: "Current holding (g)",
        avgCost: "Average cost (CNY/g)",
        maxGrams: "Max position (g)",
        positionLots: "Position lots",
        lotGrams: "Grams",
        lotPrice: "Entry price (CNY/g)",
        addLot: "Add lot",
        removeLot: "Remove",
        positionHint: "Record multiple buys; total grams and average cost are calculated automatically.",
        totalGrams: "Total grams",
        feeTitle: "Fee (CMB 积存金)",
        buyFee: "Buy fee (CNY/g)",
        sellFee: "Sell fee (CNY/g)",
        feeTotal: "Round trip",
        cmbTitle: "CMB 积存金 price",
        cmbBuySpread: "Buy spread (CNY/g, fallback)",
        cmbSellSpread: "Sell spread (CNY/g, fallback)",
        cmbHint: "Prefers live CMB customer buy/sell prices from the CMB API; falls back to the international gold price converted at the exchange rate plus spread when unavailable. Always check the CMB app.",
        strategyTitle: "Intraday signal parameters",
        minProfit: "Min target profit (CNY/g)",
        maxLoss: "Max acceptable loss (CNY/g)",
        slippage: "Slippage estimate (CNY/g)",
        estSpread: "Spread estimate (CNY/g)",
        rsiOversold: "RSI oversold threshold",
        rsiOverbought: "RSI overbought threshold",
        atrFactor: "ATR target factor",
        nearSupportPct: "Near-support threshold (%)",
        minRemainGrams: "Min base position (g)",
        signalCooldownMinutes: "Same-direction cooldown (min)",
        confirmBars: "Confirmation bars",
        scoreThreshold: "Signal score threshold",
        tradingTitle: "Trading hours",
        weekdaysOnly: "Weekdays only",
        openTime: "Open time",
        closeTime: "Close time (26:00 means 02:00 next day)",
        holidays: "Holidays (YYYY-MM-DD, comma separated)",
        alertsTitle: "Alerts",
        systemEnabled: "Host system notifications",
        systemHint: "The DSH host must be running",
        webhookTitle: "Webhooks",
        feishu: "Feishu",
        dingtalk: "DingTalk",
        wecom: "WeCom",
        webhookUrl: "Webhook URL",
        webhookSecret: "Signing secret (optional)",
        webhookSecretSet: "Configured (leave blank to keep)",
        webhookSecretClear: "Clear secret",
        webhookEnabled: "Enable this channel",
        webhookTemplate: "Message template (optional)",
        webhookTemplateHint: "Placeholders: {{action}} {{instrument}} {{price}} {{cmbPrice}} {{target}} {{grams}} {{time}}",
        test: "Send test",
        testSending: "Sending…",
        testOk: "Test message sent",
        testFailed: "Test failed: {error}",
        generic: "Generic webhooks",
        genericAdd: "Add",
        genericRemove: "Remove",
        genericName: "Name",
        genericUrl: "URL",
        genericTemplate: "Message template",
        genericNone: "No generic webhooks. Click “Add” to create one.",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        saveError: "Save failed: {error}",
        unsaved: "Unsaved changes",
        retryConfig: "Retry",
        loadConfigError: "Failed to load config: {error}",
        sourceStatus: "Data source status",
        sourceFresh: "{source} · {time}",
        sourceStale: "{source} · stale",
        sourceOk: "OK",
        sourceError: "Error",
        sourceUnknown: "Unknown",
        viewLogs: "View logs",
        logsTitle: "API call logs",
        logsEmpty: "No logs yet",
        logsRefresh: "Refresh",
        logsClose: "Close",
        logsLoadError: "Could not load logs: {error}",
        logsSuccess: "Success",
        logsFailed: "Failed",
        logTime: "Time",
        logDuration: "Duration",
        logUrl: "URL",
        logStatus: "Status",
        sourceCurrent: "Current",
        sourceNoCurrent: "Not in use",
        sourceLast: "Last",
        sourceLogCount: "{count} log(s)",
        noData: "No quote data",
        reason: "Why",
        planTitle: "Current suggestion",
        dataCoverage: "Data coverage",
        confidence: "Signal strength",
        indicatorDetail: "Indicator details",
        indicatorTimeframe: "TF",
        indicatorEma20: "EMA20",
        indicatorEma20Tip: "Exponential moving average (period 20). Formula: EMA_t = close × k + EMA_{t-1} × (1-k), where k = 2/(20+1). Used to gauge the trend direction of the current timeframe.",
        indicatorRsi: "RSI14",
        indicatorRsiTip: "Relative Strength Index (period 14). RSI = 100 × average gain / (average gain + average loss), based on the last 14 bars. Used to measure overbought/oversold conditions and recovery momentum.",
        indicatorSma5: "SMA5",
        indicatorSma5Tip: "5-period simple moving average. SMA5 = sum of the last 5 closing prices ÷ 5.",
        indicatorSma20: "SMA20",
        indicatorSma20Tip: "20-period simple moving average. SMA20 = sum of the last 20 closing prices ÷ 20.",
        indicatorSma60: "SMA60",
        indicatorSma60Tip: "60-period simple moving average. SMA60 = sum of the last 60 closing prices ÷ 60.",
        indicatorBollLower: "Boll lower",
        indicatorBollLowerTip: "Bollinger lower band = middle band − 2 × standard deviation, where the middle band is the 20-period SMA. Used to identify short-term oversold/support areas.",
        indicatorBollMid: "Boll mid",
        indicatorBollMidTip: "Bollinger middle band = 20-period simple moving average (SMA20).",
        indicatorBollUpper: "Boll upper",
        indicatorBollUpperTip: "Bollinger upper band = middle band + 2 × standard deviation. Used to identify short-term overbought/resistance areas.",
        indicatorAtr: "ATR14",
        indicatorAtrTip: "14-period Average True Range. TR = max(high−low, |high−prev close|, |low−prev close|); ATR = average of the last 14 TR values. Used to measure volatility.",
        indicatorHigh20: "20-bar high",
        indicatorHigh20Tip: "Highest high of the last 20 bars. Used to identify recent resistance.",
        indicatorLow20: "20-bar low",
        indicatorLow20Tip: "Lowest low of the last 20 bars. Used to identify recent support.",
        indicatorMacd: "MACD",
        indicatorMacdTip: "MACD histogram = DIF − DEA. DIF = EMA12 − EMA26, and DEA is the 9-period EMA of DIF. The histogram reflects short-term momentum changes.",
        sellAll: "All",
        validUntil: "Suggested until",
      },
    };

    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    function format(t, key, params) {
      return typeof t === "function" ? t(key, params) : (DICT.zh[key] ?? key);
    }

    function fmtPrice(value) {
      return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "—";
    }

    function fmtSigned(value, digits) {
      if (!Number.isFinite(Number(value))) return "—";
      var n = Number(value);
      return (n >= 0 ? "+" : "") + n.toFixed(digits ?? 2);
    }

    function changeClass(price, prevClose) {
      if (!Number.isFinite(Number(price)) || !Number.isFinite(Number(prevClose))) return "dsh-goldboard-flat";
      if (Number(price) > Number(prevClose)) return "dsh-goldboard-up";
      if (Number(price) < Number(prevClose)) return "dsh-goldboard-down";
      return "dsh-goldboard-flat";
    }

    function changePct(price, prevClose) {
      if (!Number.isFinite(Number(price)) || !Number.isFinite(Number(prevClose)) || Number(prevClose) === 0) return null;
      return (Number(price) - Number(prevClose)) / Number(prevClose) * 100;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function pad2(value) {
      return String(value).padStart(2, "0");
    }

    /** Format an ISO timestamp as Beijing wall-clock time (Asia/Shanghai). */
    function formatBeijingTime(value, withSeconds) {
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "—";
      try {
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).formatToParts(date);
        var map = {};
        for (var index = 0; index < parts.length; index += 1) map[parts[index].type] = parts[index].value;
        var seconds = withSeconds === false ? "" : ":" + map.second;
        return map.year + "-" + map.month + "-" + map.day + " " + map.hour + ":" + map.minute + seconds;
      } catch {
        // Fallback for very old browsers: UTC+8 via ISO fields.
        var shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        var iso = shifted.toISOString();
        return withSeconds === false ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
      }
    }

    function beijingDateKey(value) {
      if (value === null || value === undefined || value === "") return "—";
      var text = formatBeijingTime(value, false);
      return text.slice(0, 10);
    }

    function beijingMinutes(value) {
      if (value === null || value === undefined || value === "") return null;
      var text = formatBeijingTime(value, false);
      var timePart = text.slice(11, 16);
      if (!/^\d{2}:\d{2}$/.test(timePart)) return null;
      return Number(timePart.slice(0, 2)) * 60 + Number(timePart.slice(3, 5));
    }

    function filterTodayBars(bars, serverTime) {
      if (!Array.isArray(bars) || !serverTime) return [];
      var day = beijingDateKey(serverTime);
      if (!day || day === "—") return [];
      return bars.filter(function (bar) {
        return beijingDateKey(bar && bar.t) === day;
      });
    }

    function chartBaselineBar(serverTime, price) {
      if (!serverTime || !Number.isFinite(Number(price))) return null;
      var day = beijingDateKey(serverTime);
      if (!day || day === "—") return null;
      var parts = day.split("-").map(Number);
      if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
      // 北京时间 00:00 = UTC 前一日 16:00
      var t = Date.UTC(parts[0], parts[1] - 1, parts[2]) - 8 * 60 * 60 * 1000;
      if (!Number.isFinite(t)) return null;
      var value = Number(price);
      return { t: t, o: value, h: value, l: value, c: value, baseline: true };
    }

    function withChartBaseline(bars, basePrice, serverTime) {
      if (!Array.isArray(bars) || bars.length === 0) return bars;
      var base = chartBaselineBar(serverTime, basePrice);
      if (!base || !(Number(base.c) > 0)) return bars;
      var hasMidnight = bars.some(function (bar) {
        return beijingMinutes(bar && bar.t) === 0;
      });
      if (hasMidnight) return bars;
      return [base].concat(bars);
    }


    function fillMissingChartSlots(bars, serverTime, midnightPrice) {
      if (!Array.isArray(bars) || !serverTime) return bars;
      if (bars.length === 0 && !(Number.isFinite(Number(midnightPrice)) && Number(midnightPrice) > 0)) return bars;
      var day = beijingDateKey(serverTime);
      if (!day || day === "—") return bars;
      var nowMinutes = beijingMinutes(serverTime);
      if (nowMinutes === null) return bars;
      var midnightBar = chartBaselineBar(serverTime, 0);
      if (!midnightBar) return bars;
      var midnight = midnightBar.t;
      var byTime = {};
      var firstMinute = null;
      bars.forEach(function (bar) {
        if (!bar) return;
        var t = new Date(bar.t).getTime();
        if (!Number.isFinite(t)) return;
        var aligned = Math.floor(t / 60_000) * 60_000;
        byTime[aligned] = bar;
        if (bar.baseline === true) return;
        var minute = beijingMinutes(bar.t);
        if (minute !== null && (firstMinute === null || minute < firstMinute)) firstMinute = minute;
      });
      if (firstMinute === null) firstMinute = 0;
      var result = [];
      for (var minute = firstMinute; minute <= nowMinutes; minute += 1) {
        var t = midnight + minute * 60_000;
        if (byTime[t]) {
          result.push(byTime[t]);
        } else if (minute === firstMinute && Number.isFinite(Number(midnightPrice)) && Number(midnightPrice) > 0) {
          result.push(chartBaselineBar(serverTime, midnightPrice));
        } else {
          // 没有行情的时间点保留为空，不要用 0 填充，避免折线被拉低。
          result.push(null);
        }
      }
      return result;
    }

    function hasChartLine(bars, connectGaps) {
      if (!Array.isArray(bars)) return false;
      var prevMinute = null;
      var validCount = 0;
      for (var i = 0; i < bars.length; i += 1) {
        var bar = bars[i];
        if (!bar || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) continue;
        var minute = beijingMinutes(bar.t);
        if (minute === null) continue;
        validCount += 1;
        if (connectGaps) {
          if (validCount >= 2) return true;
        } else if (prevMinute !== null && minute - prevMinute <= 5) {
          return true;
        }
        prevMinute = minute;
      }
      return false;
    }

    var REASON_LABELS = {
      zh: {
        quote_missing: "缺少行情",
        market_closed: "休市",
        stale_quote: "行情过期",
        target_reached: "达到目标",
        stop_reached: "触发止损",
        session_ending: "临近收盘",
        rsi_overbought: "5分钟 RSI 超买",
        bearish_bar: "5分钟阴线走弱",
        reduce_on_weakness: "走弱减仓",
        break_below_sma20_with_profit: "5分钟跌破 SMA20 且有浮盈",
        trend_ema20_up: "10/30/60分钟 EMA20 向上",
        near_support: "5分钟接近支撑",
        near_lower_band: "5分钟接近布林下轨",
        rsi_rebound: "5分钟 RSI 回升",
        trigger_not_confirmed: "5分钟入场条件未确认",
        trend_filter_not_met: "10/30/60分钟趋势过滤未满足",
        no_budget: "已达投入上限",
        target_band_add: "按目标仓位区间补仓",
        target_band_reduce: "按目标仓位区间减仓并保留底仓",
        already_light_position: "已处于轻仓区间，不再重复减仓",
        cooldown_active: "同方向建议冷却中",
        signal_confirming: "信号确认中（连续确认）",
        score_not_enough: "信号强度未达阈值",
        spread_alert: "内外盘价差异常",
        data_stale: "数据过期",
        data_incomplete_5m: "5分钟数据不足",
        data_incomplete_10m: "10分钟数据不足",
        data_incomplete_30m: "30分钟数据不足",
        data_incomplete_60m: "60分钟数据不足",
      },
      en: {
        quote_missing: "Missing quote",
        market_closed: "Market closed",
        stale_quote: "Stale quote",
        target_reached: "Target reached",
        stop_reached: "Stop hit",
        session_ending: "Session ending",
        rsi_overbought: "5m RSI overbought",
        bearish_bar: "5m bearish bar",
        reduce_on_weakness: "Reduce on weakness",
        break_below_sma20_with_profit: "5m broke below SMA20 with profit",
        trend_ema20_up: "10/30/60m EMA20 rising",
        near_support: "5m near support",
        near_lower_band: "5m near lower Bollinger",
        rsi_rebound: "5m RSI recovering",
        trigger_not_confirmed: "5m entry not confirmed",
        trend_filter_not_met: "10/30/60m trend filter not met",
        no_budget: "Position limit reached",
        target_band_add: "Add toward target position band",
        target_band_reduce: "Reduce toward target position band and keep a base position",
        already_light_position: "Already in light band, no repeated reduction",
        cooldown_active: "Same-direction cooldown active",
        signal_confirming: "Confirming signal",
        score_not_enough: "Signal score below threshold",
        spread_alert: "Spread alert",
        data_stale: "Stale data",
        data_incomplete_5m: "5m data incomplete",
        data_incomplete_10m: "10m data incomplete",
        data_incomplete_30m: "30m data incomplete",
        data_incomplete_60m: "60m data incomplete",
      },
    };

    function isChineseLocale(t) {
      return format(t, "nav") === DICT.zh.nav;
    }

    function formatReasonCodes(t, codes) {
      var zh = isChineseLocale(t);
      return (codes || []).map(function (code) {
        var zhLabel = REASON_LABELS.zh[code] || code;
        var enLabel = REASON_LABELS.en[code] || code;
        return zh ? zhLabel + " (" + enLabel + ")" : enLabel;
      }).join(", ");
    }

    function isNum(value) {
      return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
    }

    function fmtIndicator(value, digits) {
      if (!isNum(value)) return "—";
      return Number(value).toFixed(digits ?? 2);
    }

    function fmtIndicatorSigned(value, digits) {
      if (!isNum(value)) return "—";
      var n = Number(value);
      return (n >= 0 ? "+" : "") + n.toFixed(digits ?? 2);
    }

    function emaDirection(ind) {
      if (!ind || !isNum(ind.ema20) || !isNum(ind.ema20Prev)) return null;
      if (Number(ind.ema20) > Number(ind.ema20Prev)) return "up";
      if (Number(ind.ema20) < Number(ind.ema20Prev)) return "down";
      return "flat";
    }

    function indicatorRows(indicators) {
      if (!indicators) return [];
      var tfs = ["ind5", "ind10", "ind30", "ind60"];
      function val(tf, key, digits) {
        var ind = indicators[tf];
        if (!ind) return null;
        if (!isNum(ind[key])) return null;
        return { text: fmtIndicator(ind[key], digits) };
      }
      function bollVal(tf, key) {
        var ind = indicators[tf];
        if (!ind || !ind.boll || !isNum(ind.boll[key])) return null;
        return { text: fmtIndicator(ind.boll[key]) };
      }
      return [
        { key: "ema20", labelKey: "indicatorEma20", tipKey: "indicatorEma20Tip", values: tfs.map(function (tf) {
          var ind = indicators[tf];
          if (!ind || !isNum(ind.ema20)) return null;
          return { text: fmtIndicator(ind.ema20), dir: emaDirection(ind) };
        }) },
        { key: "rsi", labelKey: "indicatorRsi", tipKey: "indicatorRsiTip", values: tfs.map(function (tf) { return val(tf, "rsi14", 1); }) },
        { key: "sma5", labelKey: "indicatorSma5", tipKey: "indicatorSma5Tip", values: tfs.map(function (tf) { return val(tf, "sma5"); }) },
        { key: "sma20", labelKey: "indicatorSma20", tipKey: "indicatorSma20Tip", values: tfs.map(function (tf) { return val(tf, "sma20"); }) },
        { key: "sma60", labelKey: "indicatorSma60", tipKey: "indicatorSma60Tip", values: tfs.map(function (tf) { return val(tf, "sma60"); }) },
        { key: "bollLower", labelKey: "indicatorBollLower", tipKey: "indicatorBollLowerTip", values: tfs.map(function (tf) { return bollVal(tf, "lower"); }) },
        { key: "bollMid", labelKey: "indicatorBollMid", tipKey: "indicatorBollMidTip", values: tfs.map(function (tf) { return bollVal(tf, "mid"); }) },
        { key: "bollUpper", labelKey: "indicatorBollUpper", tipKey: "indicatorBollUpperTip", values: tfs.map(function (tf) { return bollVal(tf, "upper"); }) },
        { key: "atr", labelKey: "indicatorAtr", tipKey: "indicatorAtrTip", values: tfs.map(function (tf) { return val(tf, "atr14"); }) },
        { key: "macd", labelKey: "indicatorMacd", tipKey: "indicatorMacdTip", values: tfs.map(function (tf) {
          var ind = indicators[tf];
          if (!ind || !ind.macd || !isNum(ind.macd.histogram)) return null;
          return { text: fmtIndicatorSigned(ind.macd.histogram) };
        }) },
        { key: "high", labelKey: "indicatorHigh20", tipKey: "indicatorHigh20Tip", values: tfs.map(function (tf) { return val(tf, "recentHigh"); }) },
        { key: "low", labelKey: "indicatorLow20", tipKey: "indicatorLow20Tip", values: tfs.map(function (tf) { return val(tf, "recentLow"); }) },
      ].filter(function (row) {
        return row.values.some(function (cell) { return cell !== null; });
      });
    }

    function IndicatorTable(props) {
      var t = props.t;
      var indicators = props.indicators;
      if (!indicators) return null;
      var rows = indicatorRows(indicators);
      if (rows.length === 0) return null;
      var tfs = [5, 10, 30, 60];
      return el("div", { className: "dsh-goldboard-indicator-detail" },
        el("div", { className: "dsh-goldboard-indicator-title" }, format(t, "indicatorDetail")),
        el("table", { className: "dsh-goldboard-indicator-table" },
          el("thead", null,
            el("tr", null,
              el("th", null, format(t, "indicatorTimeframe")),
              tfs.map(function (tf) { return el("th", { key: tf }, tf + "m"); })
            )
          ),
          el("tbody", null,
            rows.map(function (row) {
              return el("tr", { key: row.key },
                el("td", null,
                  el("span", { className: "dsh-goldboard-indicator-label" },
                    format(t, row.labelKey),
                    row.tipKey ? el(InfoTip, { text: format(t, row.tipKey), align: "left" }) : null
                  )
                ),
                row.values.map(function (cell, index) {
                  if (!cell) return el("td", { key: index }, "—");
                  var cls = cell.dir === "up" ? "dsh-goldboard-indicator-up" : cell.dir === "down" ? "dsh-goldboard-indicator-down" : "";
                  return el("td", { key: index, className: cls || undefined }, cell.text);
                })
              );
            })
          )
        )
      );
    }

    function evidenceForCode(t, snap, code) {
      var inds = (snap && snap.indicators) || {};
      var zh = isChineseLocale(t);
      function ind(tf) { return inds["ind" + tf]; }
      function f(value, digits) { return fmtIndicator(value, digits); }
      switch (code) {
        case "trend_ema20_up": {
          var up = ["10", "30", "60"].map(function (tf) { var i = ind(tf); return i ? f(i.ema20) : "—"; });
          return (zh ? "10/30/60m EMA20 " : "10/30/60m EMA20 ") + up.join("/") + " ↑";
        }
        case "trend_filter_not_met": {
          var vals = ["10", "30", "60"].map(function (tf) { var i = ind(tf); return i ? f(i.ema20) : "—"; });
          return (zh ? "10/30/60m EMA20 " : "10/30/60m EMA20 ") + vals.join("/");
        }
        case "near_support": {
          var i5 = ind(5);
          return i5 ? (zh ? "5m 支撑 " : "5m support ") + f(i5.recentLow) : "";
        }
        case "near_lower_band": {
          var i5 = ind(5);
          return i5 && i5.boll ? (zh ? "5m 布林下轨 " : "5m Boll lower ") + f(i5.boll.lower) : "";
        }
        case "rsi_rebound":
        case "rsi_overbought": {
          var i5 = ind(5);
          return i5 ? (zh ? "5m RSI " : "5m RSI ") + f(i5.rsi14, 1) : "";
        }
        case "break_below_sma20_with_profit": {
          var i5 = ind(5);
          return i5 ? (zh ? "5m 收盘<SMA20 " : "5m close<SMA20 ") + f(i5.sma20) : "";
        }
        case "bearish_bar": {
          var i5 = ind(5);
          return i5 ? (zh ? "5m 阴线" : "5m bearish bar") : "";
        }
        case "target_band_add": {
          var pos = snap && snap.position;
          var order = snap && snap.plan && snap.plan.suggestedOrder;
          var current = pos && Number.isFinite(Number(pos.grams)) ? Number(pos.grams) : 0;
          var add = order && Number.isFinite(Number(order.grams)) ? Number(order.grams) : 0;
          return add > 0 ? (zh ? "目标仓位约 " : "target ~") + fmtIndicator(current + add) + "g" : "";
        }
        case "target_band_reduce": {
          var pos = snap && snap.position;
          var order = snap && snap.plan && snap.plan.suggestedOrder;
          var current = pos && Number.isFinite(Number(pos.grams)) ? Number(pos.grams) : 0;
          var sell = order && Number.isFinite(Number(order.grams)) ? Number(order.grams) : 0;
          return sell > 0 ? (zh ? "目标保留约 " : "keep ~") + fmtIndicator(Math.max(0, current - sell)) + "g" : "";
        }
        default:
          return "";
      }
    }

    function formatDetailedReasons(t, snap) {
      var plan = snap && snap.plan;
      var codes = (plan && plan.reasonCodes) || [];
      var base = formatReasonCodes(t, codes);
      var evidence = [];
      codes.forEach(function (code) {
        var text = evidenceForCode(t, snap, code);
        if (text) evidence.push(text);
      });
      if (evidence.length === 0) return base;
      return base + (isChineseLocale(t) ? "（" : " (") + evidence.join(isChineseLocale(t) ? "；" : "; ") + (isChineseLocale(t) ? "）" : ")");
    }

    function planActionLabel(t, action) {
      return format(t, "action_" + (action ?? "no_data"));
    }

    function shouldShowIndicatorDetail(action) {
      return ["buy_setup", "add_position", "reduce_position", "sell_take_profit", "sell_trailing", "sell_stop", "sell_weakness", "close_by_session_end", "wait", "no_budget"].indexOf(action) !== -1;
    }

    // ── snapshot hook ──────────────────────────────────────────────────────

    function useSnapshot() {
      var state = useState(null);
      var snap = state[0];
      var setSnap = state[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];

      useEffect(function () {
        var alive = true;
        var timer = null;
        var load = function () {
          fetch(SNAPSHOT_URL, { headers: { accept: "application/json", "x-dsh-locale": navigator.language?.startsWith("en") ? "en" : "zh" } })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (!alive) return;
              if (data && data.ok) {
                setSnap(data);
                setError("");
              } else {
                setError((data && data.error && data.error.message) || "bad response");
              }
            })
            .catch(function (err) {
              if (alive) setError(String(err && err.message ? err.message : err));
            });
        };
        var schedule = function () {
          if (timer !== null) clearInterval(timer);
          var delay = typeof document !== "undefined" && document.hidden ? 60000 : 10000;
          timer = setInterval(load, delay);
        };
        var onRefresh = function () {
          load();
          schedule();
        };
        load();
        schedule();
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", schedule);
          document.addEventListener("dsh-plugin-goldboard:refresh", onRefresh);
        }
        return function () {
          alive = false;
          if (timer !== null) clearInterval(timer);
          if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", schedule);
            document.removeEventListener("dsh-plugin-goldboard:refresh", onRefresh);
          }
        };
      }, []);

      return { snap: snap, error: error };
    }

    // ── small components ───────────────────────────────────────────────────

    function Sparkline(props) {
      var hoverState = useState(-1);
      var hoverIndex = hoverState[0];
      var setHoverIndex = hoverState[1];
      var bars = props.bars;
      var connectGaps = props.connectGaps === true;
      if (!Array.isArray(bars) || bars.length < 2) return null;
      var width = props.width ?? 320;
      var height = props.height ?? 64;
      var serverTime = props.serverTime;
      var nowMinutes = serverTime ? beijingMinutes(serverTime) : null;
      var filtered = bars.filter(function (bar) {
        return bar && Number.isFinite(Number(bar.c)) && Number(bar.c) > 0 && beijingMinutes(bar.t) !== null;
      });
      if (nowMinutes !== null) {
        filtered = filtered.filter(function (bar) {
          return beijingMinutes(bar.t) <= nowMinutes;
        });
      }
      if (filtered.length < 2) return null;
      var closes = filtered.map(function (bar) { return Number(bar.c); });
      var times = filtered.map(function (bar) { return beijingMinutes(bar && bar.t); });
      var min = Math.min.apply(null, closes);
      var max = Math.max.apply(null, closes);
      var range = max - min || 1;
      function xForTime(minutes) { return (minutes / 1440) * width; }
      function yFor(value) { return height - (value - min) / range * (height - 4) - 2; }
      var segments = [];
      var currentSegment = [];
      for (var i = 0; i < filtered.length; i += 1) {
        if (!connectGaps && i > 0 && times[i] - times[i - 1] > 5) {
          if (currentSegment.length >= 2) segments.push(currentSegment);
          currentSegment = [];
        }
        currentSegment.push(xForTime(times[i]).toFixed(2) + "," + yFor(closes[i]).toFixed(2));
      }
      if (currentSegment.length >= 2) segments.push(currentSegment);
      var color = closes[closes.length - 1] >= closes[0] ? "var(--dsw-alias-state-error-primary,#e5484d)" : "var(--dsw-alias-state-success-primary,#3c9a5f)";
      var unit = props.unit || "";
      var onMouseMove = function (event) {
        var rect = event.currentTarget.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        var ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        var targetMinutes = ratio * 1440;
        var best = 0;
        var bestDiff = Infinity;
        for (var i = 0; i < times.length; i += 1) {
          var diff = Math.abs(times[i] - targetMinutes);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = i;
          }
        }
        setHoverIndex(best);
      };
      var onMouseLeave = function () {
        setHoverIndex(-1);
      };
      var children = segments.map(function (segment) {
        return el("polyline", { points: segment.join(" "), fill: "none", stroke: color, strokeWidth: 2 });
      });
      if (nowMinutes !== null) {
        var nowX = xForTime(nowMinutes);
        children.push(el("line", {
          x1: nowX,
          y1: 0,
          x2: nowX,
          y2: height,
          className: "dsh-goldboard-chart-now-line",
        }));
      }
      var tip = null;
      if (hoverIndex >= 0 && hoverIndex < filtered.length) {
        var hx = xForTime(times[hoverIndex]);
        var hy = yFor(closes[hoverIndex]);
        children.push(el("line", {
          x1: hx,
          y1: 0,
          x2: hx,
          y2: height,
          className: "dsh-goldboard-chart-hover-line",
        }));
        children.push(el("circle", {
          cx: hx,
          cy: hy,
          r: 3,
          fill: "#2C2C2E",
          stroke: color,
          strokeWidth: 2,
        }));
        var tipLeft = clamp(hx / width * 100, 15, 85);
        tip = el("div", { className: "dsh-goldboard-chart-tip", style: { left: tipLeft + "%" } },
          el("div", { className: "dsh-goldboard-chart-tip-time" }, formatBeijingTime(filtered[hoverIndex].t, false).slice(11)),
          el("div", { className: "dsh-goldboard-chart-tip-value" }, fmtPrice(closes[hoverIndex]) + unit),
        );
      }
      return el("div", { className: "dsh-goldboard-chart", onMouseMove: onMouseMove, onMouseLeave: onMouseLeave },
        el("svg", {
          className: "dsh-goldboard-spark",
          viewBox: "0 0 " + width + " " + height,
          preserveAspectRatio: "none",
          "aria-hidden": true,
        }, children),
        tip,
      );
    }

    function Switch(props) {
      return el("button", {
        type: "button",
        role: "switch",
        "aria-checked": props.checked === true,
        className: "dsh-goldboard-switch" + (props.checked ? " dsh-goldboard-switch-on" : ""),
        onClick: function () { props.onChange(!props.checked); },
      }, el("span", { className: "dsh-goldboard-switch-knob" }));
    }

    function NumberField(props) {
      return el("div", { className: "dsh-goldboard-field" },
        el("span", null, props.label),
        el("input", {
          className: "dsh-goldboard-input",
          type: "number",
          step: props.step ?? "any",
          min: props.min,
          value: props.value,
          onChange: function (event) { props.onChange(event.target.value); },
        }),
      );
    }

    function TextField(props) {
      return el("div", { className: "dsh-goldboard-field" },
        el("span", null, props.label),
        el("input", {
          className: "dsh-goldboard-input",
          type: props.type ?? "text",
          placeholder: props.placeholder,
          value: props.value,
          onChange: function (event) { props.onChange(event.target.value); },
        }),
      );
    }

    function CardRow(props) {
      return el("div", { className: "dsh-goldboard-card-row" },
        props.title ? el("h3", null, props.title) : null,
        props.hint ? el("div", { className: "dsh-goldboard-hint" }, props.hint) : null,
        props.children,
      );
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return Promise.resolve();
    }

    function InfoTip(props) {
      var showState = useState(false);
      var show = showState[0];
      var setShow = showState[1];
      var posState = useState({ top: 0, left: 0 });
      var pos = posState[0];
      var setPos = posState[1];
      var tipRef = useRef(null);

      var updatePos = function () {
        var node = tipRef.current;
        if (!node) return;
        var rect = node.getBoundingClientRect();
        var top = rect.top - 8;
        var left = rect.left;
        if (props.align === "right") left = rect.right;
        else if (props.align !== "left") left = rect.left + rect.width / 2;
        setPos({ top: top, left: left });
      };

      useEffect(function () {
        if (show) updatePos();
      }, [show]);

      var showTip = function () {
        updatePos();
        setShow(true);
      };
      var hideTip = function () {
        setShow(false);
      };

      var icon = el("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": true,
      },
        el("path", { d: "M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z", fill: "currentColor" }),
        el("path", { d: "M6.18042 8.68184C6.18043 8.09153 6.32893 7.34655 6.92127 6.8481C7.28566 6.54148 7.76104 6.27318 8.0022 6.10811C8.28964 5.91137 8.42234 5.76562 8.48328 5.58944C8.57774 5.31609 8.53121 5.00904 8.34912 4.76741C8.17409 4.53522 7.83879 4.32222 7.28186 4.32222C5.99668 4.32225 5.46969 5.11832 5.46949 5.78939H4.24414C4.24436 4.39942 5.36327 3.09691 7.28186 3.09688C8.17773 3.09688 8.89489 3.45606 9.32752 4.02999C9.75287 4.59438 9.86938 5.32775 9.64026 5.99019C9.44847 6.5444 9.04722 6.87743 8.69434 7.11898C8.29506 7.39226 8.02318 7.52192 7.70996 7.78548C7.51943 7.94582 7.40577 8.24899 7.40577 8.68184V8.75533H6.18042V8.68184Z", fill: "currentColor" }),
        el("path", { d: "M7.39455 9.44026V10.8109H6.16921V9.44026H7.39455Z", fill: "currentColor" })
      );

      var trigger = el("span", {
        ref: tipRef,
        className: "dsh-goldboard-tip",
        tabIndex: 0,
        "aria-label": props.text,
        onMouseEnter: showTip,
        onMouseLeave: hideTip,
        onFocus: showTip,
        onBlur: hideTip,
        onClick: function (event) { event.stopPropagation(); },
        onKeyDown: function (event) { event.stopPropagation(); },
      }, icon);

      var popNode = null;
      if (show) {
        var transform = "translateX(-50%)";
        if (props.align === "left") transform = "none";
        else if (props.align === "right") transform = "translateX(-100%)";
        var pop = el("div", {
          className: "dsh-goldboard-tip-pop",
          style: { top: pos.top + "px", left: pos.left + "px", transform: transform },
        }, props.text);
        if (ReactDOM && ReactDOM.createPortal && typeof document !== "undefined" && document.body) {
          popNode = ReactDOM.createPortal(pop, document.body);
        } else {
          popNode = pop;
        }
      }
      return el("span", { style: { display: "contents" } }, trigger, popNode);
    }


    // ── floating board ─────────────────────────────────────────────────────

    var BOARD_MARGIN = 8;
    var BOARD_WIDTH = 400;
    var ORB_WIDTH = 300;

    function readPosition() {
      try {
        var raw = localStorage.getItem(POSITION_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Number.isFinite(parsed.right) && Number.isFinite(parsed.top)) {
            return { right: parsed.right, top: parsed.top };
          }
          // Migrate the old x/y top-left coordinate to the viewport-right anchor.
          if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            var viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
            return { right: viewportWidth - parsed.x - BOARD_WIDTH, top: parsed.y };
          }
        }
      } catch {
        // ignore
      }
      return null;
    }

    function clampPosition(position, width) {
      var viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
      var viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
      var safe = position && Number.isFinite(Number(position.right)) && Number.isFinite(Number(position.top))
        ? { right: Number(position.right), top: Number(position.top) }
        : { right: BOARD_MARGIN, top: 20 };
      return {
        right: clamp(safe.right, BOARD_MARGIN, Math.max(BOARD_MARGIN, viewportWidth - width - BOARD_MARGIN)),
        top: clamp(safe.top, BOARD_MARGIN, Math.max(BOARD_MARGIN, viewportHeight - 48)),
      };
    }

    function readCollapsed() {
      try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
    }

    function writeCollapsed(value) {
      try { localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); } catch { }
    }

    function writePosition(position) {
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { }
    }

    function QuoteItem(props) {
      var quote = props.quote;
      var className = "dsh-goldboard-item" +
        (props.clickable ? " dsh-goldboard-item-clickable" : "") +
        (props.active ? " dsh-goldboard-item-active" : "") +
        (props.className ? " " + props.className : "");
      var common = {
        className: className,
        onClick: props.onClick,
        role: props.onClick ? "button" : undefined,
        tabIndex: props.onClick ? 0 : undefined,
        onKeyDown: props.onClick ? function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onClick();
          }
        } : undefined,
      };
      var labelNode = el("div", { className: "dsh-goldboard-item-label" },
        el("span", { className: "dsh-goldboard-item-label-text" }, props.label),
        props.tip ? el(InfoTip, { text: props.tip, align: props.tipAlign }) : null,
      );
      if (!quote) return el("div", common,
        labelNode,
        el("div", { className: "dsh-goldboard-item-value" }, "—"),
      );
      var pct = changePct(quote.price, quote.prevClose);
      return el("div", common,
        labelNode,
        el("div", { className: "dsh-goldboard-item-value " + changeClass(quote.price, quote.prevClose) },
          fmtPrice(quote.price),
          props.unit ? " " + props.unit : null,
        ),
        pct !== null ? el("div", { className: "dsh-goldboard-meta" },
          el("span", { className: changeClass(quote.price, quote.prevClose) }, fmtSigned(Number(quote.price) - Number(quote.prevClose))),
          el("span", { className: changeClass(quote.price, quote.prevClose) }, fmtSigned(pct) + "%"),
          quote.stale ? el("span", null, props.staleLabel) : null,
        ) : null,
      );
    }

    /** CMB card styled exactly like the domestic / international quote cards. */
    function CmbQuoteItem(props) {
      var cmb = props.cmb;
      var t = props.t;
      var className = "dsh-goldboard-item" +
        (props.clickable ? " dsh-goldboard-item-clickable" : "") +
        (props.active ? " dsh-goldboard-item-active" : "") +
        (props.className ? " " + props.className : "");
      var common = {
        className: className,
        onClick: props.onClick,
        role: props.onClick ? "button" : undefined,
        tabIndex: props.onClick ? 0 : undefined,
        onKeyDown: props.onClick ? function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onClick();
          }
        } : undefined,
      };
      var labelNode = el("div", { className: "dsh-goldboard-item-label" },
        el("span", { className: "dsh-goldboard-item-label-text" }, props.label),
        props.tip ? el(InfoTip, { text: props.tip, align: props.tipAlign }) : null,
      );
      if (!cmb || !Number.isFinite(Number(cmb.buyPrice))) {
        return el("div", common,
          labelNode,
          el("div", { className: "dsh-goldboard-item-value" }, "—"),
        );
      }
      var basePrice = props.fallbackBasePrice;
      var basePrevClose = props.fallbackPrevClose;
      var spread = basePrice && Number.isFinite(Number(basePrice))
        ? Number(cmb.buyPrice) - Number(basePrice)
        : null;
      var prevClose = spread !== null && basePrevClose && Number.isFinite(Number(basePrevClose))
        ? Number(basePrevClose) + spread
        : null;
      var pct = prevClose !== null ? changePct(cmb.buyPrice, prevClose) : null;
      var sellDisplay = Number.isFinite(Number(cmb.sellPriceAfterFee)) ? cmb.sellPriceAfterFee : cmb.sellPrice;
      var cmbQuote = props.cmbQuote;
      // 招行实时价可用时，是否过期只看招行行情本身；回退估算时跟随国际金价/汇率是否过期。
      var cmbStale = !!(cmb && cmb.live && cmbQuote && cmbQuote.stale);
      var fallbackStale = !!(cmb && !cmb.live && props.fallbackStale);
      var showStale = cmbStale || fallbackStale;
      return el("div", common,
        el("div", { className: "dsh-goldboard-cmb-head" },
          labelNode,
          el("div", { className: "dsh-goldboard-cmb-prices" },
            format(t, "buy") + " " + fmtPrice(cmb.buyPrice) + " / " + format(t, "sell") + " " + fmtPrice(sellDisplay),
          ),
        ),
        el("div", { className: "dsh-goldboard-item-value " + (pct !== null ? changeClass(cmb.buyPrice, prevClose) : "dsh-goldboard-flat") }, fmtPrice(cmb.buyPrice)),
        el("div", { className: "dsh-goldboard-meta" },
          pct !== null ? el("span", { className: changeClass(cmb.buyPrice, prevClose) }, fmtSigned(Number(cmb.buyPrice) - Number(prevClose))) : null,
          pct !== null ? el("span", { className: changeClass(cmb.buyPrice, prevClose) }, fmtSigned(pct) + "%") : null,
          showStale ? el("span", null, props.staleLabel) : null,
        ),
      );
    }

    function orderCmbDisplayPrice(snap, order) {
      if (!snap || !order) return "";
      if (order.side === "sell" && snap.derived && snap.derived.cmb && Number.isFinite(Number(snap.derived.cmb.sellPriceAfterFee))) {
        return snap.derived.cmb.sellPriceAfterFee;
      }
      return order.cmbEstimatedPrice;
    }

    function buildOrderText(snap, t) {
      var plan = snap && snap.plan;
      var order = plan && plan.suggestedOrder;
      if (!order) return "";
      var side = order.side === "buy" ? format(t, "buy") : format(t, "sell");
      return [
        "[" + format(t, "boardTitle") + "]",
        side + " " + format(t, "action_" + order.action),
        order.instrument + " " + order.grams + format(t, "grams"),
        order.instrument + ": " + fmtPrice(order.signalPrice),
        "CMB: " + fmtPrice(orderCmbDisplayPrice(snap, order)) + " · " + format(t, "cmbAppNote"),
        "Target: " + fmtPrice(snap.plan.targetPrice) + " · " + format(t, "breakeven") + ": " + fmtPrice(snap.plan.breakeven),
        format(t, "validUntil") + ": " + (order.validUntil ?? "—"),
        format(t, "riskNote"),
      ].join("\n");
    }

    function GoldBoardOverlay(props) {
      var t = props.t;
      var snapshotState = useSnapshot();
      var snap = snapshotState.snap;
      var error = snapshotState.error;
      var collapsedState = useState(readCollapsed());
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];
      var copiedState = useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var chartKeyState = useState("AU9999");
      var chartKey = chartKeyState[0];
      var setChartKey = chartKeyState[1];
      var gapModeState = useState("break");
      var gapMode = gapModeState[0];
      var setGapMode = gapModeState[1];

      var posState = useState(function () {
        return clampPosition(readPosition() ?? { right: BOARD_MARGIN, top: 20 }, collapsedState[0] ? ORB_WIDTH : BOARD_WIDTH);
      });
      var pos = posState[0];
      var setPos = posState[1];
      var dragRef = useRef(null);
      var dragMovedRef = useRef(false);
      var posRef = useRef(pos);
      posRef.current = pos;
      var rootRef = useRef(null);
      var dragPosRef = useRef(pos);
      var draggingRef = useRef(false);

      // Like pet/newsboard: anchor to the viewport edge and re-clamp on resize
      // so the board stays visible when the browser window changes.
      useEffect(function () {
        if (typeof window === "undefined") return;
        var onResize = function () {
          setPos(function (prev) {
            var currentPos = draggingRef.current ? dragPosRef.current : posRef.current;
            var next = clampPosition(currentPos ?? prev, collapsed ? ORB_WIDTH : BOARD_WIDTH);
            writePosition(next);
            return next;
          });
        };
        window.addEventListener("resize", onResize);
        return function () { window.removeEventListener("resize", onResize); };
      }, [collapsed]);

      var onPointerDown = function (event) {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        var target = event.currentTarget;
        var startX = event.clientX;
        var startY = event.clientY;
        var base = posRef.current ?? { right: BOARD_MARGIN, top: 20 };
        var width = collapsed ? ORB_WIDTH : BOARD_WIDTH;
        var root = rootRef.current;
        dragMovedRef.current = false;
        draggingRef.current = true;
        dragPosRef.current = base;
        dragRef.current = {
          startX: startX,
          startY: startY,
          base: base,
          width: width,
          moved: false,
          last: base,
          card: root ? root.querySelector(".dsh-goldboard-card") : null,
        };
        target.setPointerCapture && target.setPointerCapture(event.pointerId);
        var onMove = function (moveEvent) {
          var drag = dragRef.current;
          if (!drag) return;
          var dx = moveEvent.clientX - drag.startX;
          var dy = moveEvent.clientY - drag.startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            drag.moved = true;
            dragMovedRef.current = true;
          }
          drag.last = clampPosition({ right: drag.base.right - dx, top: drag.base.top + dy }, drag.width);
          posRef.current = drag.last;
          dragPosRef.current = drag.last;
          // Update the DOM directly during drag to avoid re-rendering the whole
          // panel (including the chart) on every pointermove.
          if (root) {
            root.style.right = drag.last.right + "px";
            root.style.top = drag.last.top + "px";
            if (drag.card) {
              drag.card.style.maxHeight = "calc(100vh - " + drag.last.top + "px - 16px)";
            }
          } else {
            setPos(drag.last);
          }
        };
        var onUp = function () {
          var drag = dragRef.current;
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          target.removeEventListener("pointercancel", onUp);
          draggingRef.current = false;
          if (drag && drag.moved) {
            writePosition(drag.last);
            setPos(drag.last);
          }
          dragRef.current = null;
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
      };

      var toggleCollapsed = function () {
        var next = !collapsed;
        setCollapsed(next);
        writeCollapsed(next);
        setPos(function (prev) { return clampPosition(prev, next ? ORB_WIDTH : BOARD_WIDTH); });
      };

      // Collapse the expanded panel when the user clicks/taps outside it.
      useEffect(function () {
        if (collapsed || typeof window === "undefined" || typeof document === "undefined") return;
        var pressedInside = false;
        var collapseIfOutside = function (event) {
          if (event.button !== 0 && event.button !== undefined) return;
          var node = rootRef.current;
          if (node && node.contains(event.target)) {
            pressedInside = true;
            return;
          }
          pressedInside = false;
          setCollapsed(true);
          writeCollapsed(true);
          setPos(function (prev) { return clampPosition(prev, ORB_WIDTH); });
        };
        var onOutsideClick = function (event) {
          // A drag can finish outside the panel; don't treat that as an outside click.
          if (event.button !== 0 && event.button !== undefined) return;
          var wasInsidePress = pressedInside;
          pressedInside = false;
          if (dragMovedRef.current) {
            dragMovedRef.current = false;
            return;
          }
          if (wasInsidePress) return;
          collapseIfOutside(event);
          pressedInside = false;
        };
        document.addEventListener("pointerdown", collapseIfOutside, true);
        document.addEventListener("mousedown", collapseIfOutside, true);
        document.addEventListener("click", onOutsideClick, true);
        return function () {
          document.removeEventListener("pointerdown", collapseIfOutside, true);
          document.removeEventListener("mousedown", collapseIfOutside, true);
          document.removeEventListener("click", onOutsideClick, true);
        };
      }, [collapsed]);

      var onCopy = function () {
        var text = buildOrderText(snap, t);
        if (!text) return;
        copyText(text).then(function () {
          setCopied(true);
          setTimeout(function () { setCopied(false); }, 1800);
        });
      };

      var domestic = snap && snap.quotes && snap.quotes.AU9999;
      var xau = snap && snap.quotes && snap.quotes.XAU;
      var usdcny = snap && snap.quotes && snap.quotes.USDCNY;
      var derived = snap && snap.derived;
      var plan = snap && snap.plan;
      var trendAU = snap && snap.trend && snap.trend.AU9999_1m;
      var trendXAU = snap && snap.trend && snap.trend.XAU_1m;
      var trendCMB = snap && snap.trend && snap.trend.CMB_1m;
      var fallbackBasePrice = derived && Number.isFinite(derived.xauCnyPerGram) ? derived.xauCnyPerGram : null;
      var fallbackPrevClose = null;
      if (xau && usdcny && Number.isFinite(Number(xau.prevClose)) && Number.isFinite(Number(usdcny.price))) {
        fallbackPrevClose = Math.round(Number(xau.prevClose) * Number(usdcny.price) / 31.1034768 * 100) / 100;
      }
      var fallbackStale = !!(derived && derived.cmb && !derived.cmb.live && (
        (xau && xau.stale) || (usdcny && usdcny.stale)
      ));
      var chartBars = filterTodayBars(chartKey === "XAU" ? trendXAU : chartKey === "CMB" ? trendCMB : trendAU, snap && snap.serverTime);
      var chartBasePrice = null;
      if (chartKey === "AU9999") {
        chartBasePrice = domestic && domestic.prevClose;
      } else if (chartKey === "XAU") {
        chartBasePrice = xau && xau.prevClose;
      } else if (chartKey === "CMB" && derived && derived.cmb && fallbackBasePrice !== null) {
        chartBasePrice = fallbackPrevClose !== null
          ? Number(fallbackPrevClose) + (Number(derived.cmb.buyPrice) - Number(fallbackBasePrice))
          : null;
      }
      chartBars = withChartBaseline(chartBars, chartBasePrice, snap && snap.serverTime);
      chartBars = fillMissingChartSlots(chartBars, snap && snap.serverTime, chartBasePrice);
      var hasTrend = hasChartLine(chartBars, gapMode === "connect");
      var nextOpen = snap && snap.market && snap.market.nextOpen;
      var cmbPrice = derived && derived.cmb && Number.isFinite(Number(derived.cmb.buyPrice)) ? Number(derived.cmb.buyPrice) : null;
      var cmbBase = derived && derived.cmb && fallbackBasePrice !== null ? fallbackBasePrice : null;
      var cmbBasePrev = derived && derived.cmb && fallbackPrevClose !== null ? fallbackPrevClose : null;
      var cmbSpread = cmbPrice !== null && cmbBase && Number.isFinite(Number(cmbBase)) ? cmbPrice - Number(cmbBase) : 0;
      var cmbPrev = cmbPrice !== null && cmbBasePrev && Number.isFinite(Number(cmbBasePrev)) ? Number(cmbBasePrev) + cmbSpread : cmbPrice;
      var cmbClass = cmbPrice !== null ? changeClass(cmbPrice, cmbPrev) : "dsh-goldboard-flat";
      var displayPos = draggingRef.current ? dragPosRef.current : pos;

      if (collapsed) {
        return el("div", { ref: rootRef, className: "dsh-goldboard-root", style: { right: displayPos.right, top: displayPos.top } },
          el("div", { className: "dsh-goldboard-orb", title: format(t, "dragHint"), onPointerDown: onPointerDown, onClick: function () { if (!dragMovedRef.current) toggleCollapsed(); } },
            el("div", { className: "dsh-goldboard-mini" },
              el("span", { className: "dsh-goldboard-mini-label" }, format(t, "shortAu9999")),
              el("span", { className: "dsh-goldboard-mini-value " + (domestic ? changeClass(domestic.price, domestic.prevClose) : "dsh-goldboard-flat") }, domestic ? fmtPrice(domestic.price) : "—"),
            ),
            el("div", { className: "dsh-goldboard-mini" },
              el("span", { className: "dsh-goldboard-mini-label" }, format(t, "shortXau")),
              el("span", { className: "dsh-goldboard-mini-value " + (xau ? changeClass(xau.price, xau.prevClose) : "dsh-goldboard-flat") }, xau ? fmtPrice(xau.price) : "—"),
            ),
            el("div", { className: "dsh-goldboard-mini" },
              el("span", { className: "dsh-goldboard-mini-label" }, format(t, "shortCmb")),
              el("span", { className: "dsh-goldboard-mini-value " + cmbClass }, cmbPrice !== null ? fmtPrice(cmbPrice) : "—"),
            ),
            el("span", { className: "dsh-goldboard-mini-arrow" },
              el("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                el("path", { d: "M6 4l4 4-4 4", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }),
              ),
            ),
          ),
        );
      }

      return el("div", { ref: rootRef, className: "dsh-goldboard-root", style: { right: displayPos.right, top: displayPos.top } },
        el("div", { className: "dsh-goldboard-card", role: "region", "aria-label": format(t, "boardTitle"), style: { maxHeight: "calc(100vh - " + displayPos.top + "px - 16px)" } },
          el("div", { className: "dsh-goldboard-head", onPointerDown: onPointerDown, title: format(t, "dragHintCard") },
            el("div", { className: "dsh-goldboard-head-title" },
              format(t, "boardTitle"),
              el("div", { className: "dsh-goldboard-head-sub" },
                snap ? (snap.marketState === "open" ? format(t, "marketOpen") : format(t, "marketClosed")) : format(t, "loading"),
                snap ? " · " + format(t, "beijingTime") + " " + formatBeijingTime(snap.serverTime, true) : null,
              ),
            ),
            el("button", {
              type: "button",
              className: "dsh-goldboard-iconbtn",
              title: format(t, "collapse"),
              "aria-label": format(t, "collapse"),
              onPointerDown: function (event) { event.stopPropagation(); },
              onClick: toggleCollapsed,
            }, "—"),
          ),
          error ? el("div", { className: "dsh-goldboard-error" }, format(t, "loadError", { error: error })) : null,
          !snap && !error ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading")) : null,
          snap ? el("div", { className: "dsh-goldboard-grid" },
            el(QuoteItem, {
              label: format(t, "au9999") + " (¥/g)",
              quote: domestic,
              staleLabel: format(t, "stale"),
              t: t,
              clickable: true,
              active: chartKey === "AU9999",
              onClick: function () { setChartKey("AU9999"); },
              tip: derived && Number.isFinite(derived.domesticPremiumPerGram)
                ? format(t, "premium") + ": " + fmtSigned(derived.domesticPremiumPerGram) + " ¥/g"
                : null,
              tipAlign: "left",
            }),
            el(QuoteItem, {
              label: format(t, "xau") + " ($/oz)",
              quote: xau,
              staleLabel: format(t, "stale"),
              t: t,
              clickable: true,
              active: chartKey === "XAU",
              onClick: function () { setChartKey("XAU"); },
              tip: [
                derived && Number.isFinite(derived.xauCnyPerGram)
                  ? format(t, "cnyPerGram") + ": ¥" + fmtPrice(derived.xauCnyPerGram) + "/g"
                  : null,
                usdcny ? format(t, "usdcny") + ": " + fmtPrice(usdcny.price) : null,
              ].filter(Boolean).join("\n") || null,
              tipAlign: "right",
            }),
            el(CmbQuoteItem, {
              label: format(t, "cmbEstimate") + " (¥/g)",
              cmb: derived && derived.cmb,
              cmbQuote: snap && snap.quotes && snap.quotes.CMB,
              domestic: domestic,
              fallbackBasePrice: fallbackBasePrice,
              fallbackPrevClose: fallbackPrevClose,
              fallbackStale: fallbackStale,
              staleLabel: format(t, "stale"),
              t: t,
              className: "dsh-goldboard-cmb-row",
              clickable: true,
              active: chartKey === "CMB",
              onClick: function () { setChartKey("CMB"); },
              tip: derived && derived.cmb ? format(t, "cmbAppNote") : null,
              tipAlign: "left",
            }),
          ) : null,
          snap && snap.marketState === "closed"
            ? el("div", { className: "dsh-goldboard-trend-empty" }, nextOpen ? format(t, "todayClosedNext", { time: formatBeijingTime(nextOpen, false) + "（" + format(t, "beijingTime") + "）" }) : format(t, "marketClosed"))
            : hasTrend ? el("div", { className: "dsh-goldboard-chart-block" },
                el("div", { className: "dsh-goldboard-chart-head" },
                  el("div", { className: "dsh-goldboard-chart-title" },
                    format(t, "todayTrend") + " · " + format(t, chartKey === "XAU" ? "xau" : chartKey === "CMB" ? "cmbEstimate" : "au9999"),
                  ),
                  el("button", {
                    type: "button",
                    className: "dsh-goldboard-chart-toggle",
                    onClick: function () { setGapMode(gapMode === "break" ? "connect" : "break"); },
                  }, gapMode === "break" ? format(t, "gapBreak") : format(t, "gapConnect")),
                ),
                el(Sparkline, { key: chartKey, bars: chartBars, serverTime: snap.serverTime, width: 372, height: 64, unit: chartKey === "XAU" ? " $/oz" : " ¥/g", connectGaps: gapMode === "connect" }),
              ) : null,
          snap && plan ? el("div", { className: "dsh-goldboard-plan" },
            el("div", { className: "dsh-goldboard-plan-title" }, format(t, "planTitle") + ": " + planActionLabel(t, plan.action)),
            plan.action === "data_incomplete" && plan.dataCoverage ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "dataCoverage")),
              el("span", null, [5, 10, 30, 60].map(function (w) {
                var pct = Number(plan.dataCoverage[w]);
                return w + "m " + (Number.isFinite(pct) ? Math.round(pct * 100) : 0) + "%";
              }).join(" · ")),
            ) : null,
            plan.confidenceScore !== undefined ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "confidence")),
              el("span", null, plan.confidenceScore + "/" + (plan.confidenceMax ?? 8)),
            ) : null,
            plan.breakeven !== undefined ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "breakeven")),
              el("span", null, "¥" + fmtPrice(plan.breakeven) + "/g"),
            ) : null,
            plan.targetPrice !== undefined ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "targetPrice")),
              el("span", null, "¥" + fmtPrice(plan.targetPrice) + "/g"),
            ) : null,
            plan.stopPrice !== undefined ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "stopPrice")),
              el("span", null, "¥" + fmtPrice(plan.stopPrice) + "/g"),
            ) : null,
            snap.position && snap.position.grams > 0 ? el("div", { className: "dsh-goldboard-plan-row" },
              el("span", null, format(t, "pnl")),
              el("span", null, "¥" + fmtSigned(snap.position.feeAdjustedPnl)),
            ) : null,
            plan.suggestedOrder ? el("div", { className: "dsh-goldboard-plan-action" },
              el("span", null, (plan.suggestedOrder.side === "buy" ? format(t, "buy") : format(t, "sell")) + " " + format(t, "suggest")),
              el("span", null, "¥" + fmtPrice(orderCmbDisplayPrice(snap, plan.suggestedOrder)) + " × " + plan.suggestedOrder.grams + format(t, "grams")),
            ) : null,
            plan.reasonCodes && plan.reasonCodes.length > 0 ? el("div", { className: "dsh-goldboard-plan-reason" }, format(t, "reason") + ": " + formatDetailedReasons(t, snap)) : null,
            shouldShowIndicatorDetail(plan.action) ? el(IndicatorTable, { t: t, indicators: snap.indicators }) : null,
            el("div", { className: "dsh-goldboard-risk" }, format(t, "riskNote")),
          ) : null,
          el("div", { className: "dsh-goldboard-foot", title: format(t, "dragHintCard"), onPointerDown: onPointerDown },
            el("span", null, "⋮⋮"),
            el("span", null, format(t, "dragHintCard")),
          ),
        ),
      );
    }

    // ── data source logs dialog ────────────────────────────────────────────

    function DataSourceLogsDialog(props) {
      var t = props.t;
      var source = props.source;
      var onClose = props.onClose;
      var logsState = useState(null);
      var logs = logsState[0];
      var setLogs = logsState[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var loadingState = useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      var load = function () {
        setLoading(true);
        setError("");
        fetch("/dsh-plugin-goldboard/api-logs?source=" + encodeURIComponent(source.id), { cache: "no-store" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            setLogs(body && Array.isArray(body.logs) ? body.logs : []);
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .then(function () {
            setLoading(false);
          });
      };

      useEffect(function () { load(); }, []);

      var sourceName = source.nameZh || source.nameEn || source.id;
      return el("div", { className: "dsh-goldboard-log-overlay", onClick: onClose },
        el("div", { className: "dsh-goldboard-log-dialog", onClick: function (event) { event.stopPropagation(); } },
          el("div", { className: "dsh-goldboard-log-header" },
            el("h3", { className: "dsh-goldboard-log-title" }, format(t, "logsTitle") + " · " + sourceName),
            el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: load }, format(t, "logsRefresh")),
            el("button", { className: "dsh-goldboard-btn", onClick: onClose }, format(t, "logsClose")),
          ),
          el("div", { className: "dsh-goldboard-log-body" },
            error ? el("div", { className: "dsh-goldboard-error" }, format(t, "logsLoadError", { error: error }))
              : loading && logs === null ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading"))
              : logs !== null && logs.length === 0 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "logsEmpty"))
              : (logs || []).map(function (entry, index) {
                  var duration = entry.durationMs !== undefined ? String(entry.durationMs) + " ms" : "";
                  return el("div", { key: entry.id || "log-" + index, className: "dsh-goldboard-log-item" },
                    el("div", { className: "dsh-goldboard-log-item-head" },
                      el("span", { className: "dsh-goldboard-log-status " + (entry.ok ? "dsh-goldboard-log-status-ok" : "dsh-goldboard-log-status-fail") }, entry.ok ? format(t, "logsSuccess") : format(t, "logsFailed")),
                      el("span", null, entry.kind || ""),
                      duration ? el("span", null, format(t, "logDuration") + ": " + duration) : null,
                    ),
                    el("div", { className: "dsh-goldboard-log-meta" },
                      el("div", null, format(t, "logTime") + ": " + formatBeijingTime(entry.time, true)),
                      el("div", null, format(t, "logUrl") + ": " + (entry.url || "")),
                    ),
                    entry.error ? el("div", { className: "dsh-goldboard-log-error" }, String(entry.error)) : null,
                  );
                }),
          ),
        ),
      );
    }

    // ── settings ───────────────────────────────────────────────────────────

    function emptyConfig() {
      return {
        fee: { buyPerGram: 0, sellPerGram: 5 },
        cmb: { buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72 },
        position: { grams: 0, avgCostPerGram: 0, lots: [] },
        limits: { maxGrams: 0 },
        strategy: { minProfitPerGram: 1, maxLossPerGram: 2, slippagePerGram: 0.2, estimatedSpreadPerGram: 0.2, rsiOversold: 35, rsiOverbought: 75, atrFactor: 0.3, nearSupportPct: 0.5, minRemainGrams: 0, signalCooldownMinutes: 30, confirmBars: 2, scoreThreshold: 5 },
        tradingHours: { weekdaysOnly: true, open: "09:00", close: "26:00", holidays: [] },
        system: { enabled: false },
        webhooks: { feishu: { enabled: false, url: "", secret: "", bodyTemplate: "" }, dingtalk: { enabled: false, url: "", secret: "", bodyTemplate: "" }, wecom: { enabled: false, url: "", bodyTemplate: "" }, generic: [] },
      };
    }

    function SettingsSection(props) {
      var t = props.t;
      var dataState = useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var draftState = useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var statusState = useState("");
      var status = statusState[0];
      var setStatus = statusState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var testsState = useState({});
      var tests = testsState[0];
      var setTests = testsState[1];
      var clearState = useState([]);
      var clearSecrets = clearState[0];
      var setClearSecrets = clearState[1];
      var sourcesState = useState(null);
      var sources = sourcesState[0];
      var setSources = sourcesState[1];
      var logSourceState = useState(null);
      var logSource = logSourceState[0];
      var setLogSource = logSourceState[1];

      var load = useCallback(function () {
        fetch(CONFIG_URL, { headers: { accept: "application/json" } })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body && body.ok) {
              setData(body);
              setDraft(body.config);
              setStatus("");
            } else {
              setStatus((body && body.error && body.error.message) || "bad response");
            }
          })
          .catch(function (err) {
            setStatus(String(err && err.message ? err.message : err));
          });
      }, []);

      useEffect(function () { load(); }, [load]);

      useEffect(function () {
        fetch("/dsh-plugin-goldboard/data-sources", { cache: "no-store" })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body && body.ok && Array.isArray(body.sources)) setSources(body.sources);
          })
          .catch(function () { setSources([]); });
      }, []);

      var update = function (fn) {
        setStatus(function (current) { return current === format(t, "saved") ? "" : current; });
        setDraft(function (next) {
          if (!next) return next;
          var copy = JSON.parse(JSON.stringify(next));
          fn(copy);
          return copy;
        });
      };

      var save = function () {
        setSaving(true);
        setStatus("");
        fetch(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ config: draft, clearSecrets: clearSecrets }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            setSaving(false);
            if (body && body.ok) {
              setData(body);
              setDraft(body.config);
              setClearSecrets([]);
              setStatus(format(t, "saved"));
              if (typeof document !== "undefined") {
                document.dispatchEvent(new CustomEvent("dsh-plugin-goldboard:refresh"));
              }
            } else {
              setStatus(format(t, "saveError", { error: (body && body.error && body.error.message) || "bad response" }));
            }
          })
          .catch(function (err) {
            setSaving(false);
            setStatus(format(t, "saveError", { error: String(err && err.message ? err.message : err) }));
          });
      };

      var runTest = function (channel, genericId, testConfig) {
        var testKey = channel + (genericId ? "-" + genericId : "");
        setTests(function (next) {
          var copy = { ...next };
          copy[testKey] = { status: "sending" };
          return copy;
        });
        fetch(TEST_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ channel: channel, genericId: genericId, config: testConfig ?? {} }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            setTests(function (next) {
              var copy = { ...next };
              copy[testKey] = body && body.ok
                ? { status: "ok" }
                : { status: "error", error: (body && body.error && body.error.message) || "bad response" };
              return copy;
            });
          })
          .catch(function (err) {
            setTests(function (next) {
              var copy = { ...next };
              copy[testKey] = { status: "error", error: String(err && err.message ? err.message : err) };
              return copy;
            });
          });
      };

      if (!draft) {
        return el("div", { className: "dsh-goldboard-settings" },
          el("div", { className: "dsh-goldboard-header" },
            el("div", { className: "dsh-goldboard-header-row" },
              el("h2", { className: "dsh-goldboard-title" }, format(t, "settingsNav")),
            ),
            el("p", { className: "dsh-goldboard-intro" }, format(t, "settingsIntro")),
          ),
          el("div", { className: "dsh-goldboard-content" },
            status ? el("div", { className: "dsh-goldboard-error" }, status) : null,
            status ? el("button", { className: "dsh-goldboard-btn", onClick: load }, format(t, "retryConfig")) : null,
            !status ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading")) : null,
          ),
        );
      }

      var cfg = draft;
      var secretSet = data && data.secretSet ? data.secretSet : {};
      var dirty = !!(data && data.config && JSON.stringify(cfg) !== JSON.stringify(data.config));
      var lotList = Array.isArray(cfg.position && cfg.position.lots) ? cfg.position.lots : [];
      var totalGrams = lotList.reduce(function (sum, lot) { return sum + Number(lot.grams || 0); }, 0);
      var totalCost = lotList.reduce(function (sum, lot) { return sum + Number(lot.grams || 0) * Number(lot.price || 0); }, 0);
      var avgCostValue = totalGrams > 0 ? totalCost / totalGrams : 0;

      var channelCard = function (key, title, hasSecret) {
        var channel = cfg.webhooks[key];
        var testKey = key;
        var testResult = tests[testKey];
        var sending = testResult && testResult.status === "sending";
        return el(CardRow, { key: key, title: title, hint: format(t, "webhookTemplateHint") },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { checked: channel.enabled === true, onChange: function (value) { update(function (next) { next.webhooks[key].enabled = value; }); } }),
            el("span", null, format(t, "webhookEnabled")),
          ),
          el(TextField, {
            label: format(t, "webhookUrl"),
            value: channel.url,
            placeholder: "https://…",
            onChange: function (value) { update(function (next) { next.webhooks[key].url = value; }); },
          }),
          hasSecret ? el("div", { className: "dsh-goldboard-row" },
            el(TextField, {
              label: format(t, "webhookSecret"),
              value: channel.secret,
              placeholder: secretSet["webhooks." + key + ".secret"] ? format(t, "webhookSecretSet") : "",
              onChange: function (value) { update(function (next) { next.webhooks[key].secret = value; }); },
            }),
            secretSet["webhooks." + key + ".secret"] ? el("button", {
              className: "dsh-goldboard-btn",
              type: "button",
              onClick: function () {
                setClearSecrets(function (next) { return next.includes("webhooks." + key + ".secret") ? next : next.concat("webhooks." + key + ".secret"); });
              },
            }, format(t, "webhookSecretClear")) : null,
          ) : null,
          el(TextField, {
            label: format(t, "webhookTemplate"),
            value: channel.bodyTemplate,
            placeholder: "",
            onChange: function (value) { update(function (next) { next.webhooks[key].bodyTemplate = value; }); },
          }),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              className: "dsh-goldboard-btn",
              disabled: sending,
              onClick: function () { runTest(key, undefined, channel); },
            }, sending ? format(t, "testSending") : format(t, "test")),
            testResult && testResult.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "testOk")) : null,
            testResult && testResult.status === "error" ? el("span", { className: "dsh-goldboard-error" }, format(t, "testFailed", { error: testResult.error || "" })) : null,
          ),
        );
      };

      var genericCards = cfg.webhooks.generic.map(function (item, index) {
        var key = "generic-" + item.id;
        var testResult = tests[key];
        var sending = testResult && testResult.status === "sending";
        return el("div", { className: "dsh-goldboard-generic", key: item.id },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { checked: item.enabled === true, onChange: function (value) { update(function (next) { next.webhooks.generic[index].enabled = value; }); } }),
            el("span", null, format(t, "webhookEnabled")),
            el("button", { className: "dsh-goldboard-btn", onClick: function () { update(function (next) { next.webhooks.generic.splice(index, 1); }); } }, format(t, "genericRemove")),
          ),
          el(TextField, { label: format(t, "genericName"), value: item.name, onChange: function (value) { update(function (next) { next.webhooks.generic[index].name = value; }); } }),
          el(TextField, { label: format(t, "genericUrl"), value: item.url, onChange: function (value) { update(function (next) { next.webhooks.generic[index].url = value; }); } }),
          el(TextField, { label: format(t, "genericTemplate"), value: item.bodyTemplate, onChange: function (value) { update(function (next) { next.webhooks.generic[index].bodyTemplate = value; }); } }),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              className: "dsh-goldboard-btn",
              disabled: sending,
              onClick: function () { runTest("generic", item.id, item); },
            }, sending ? format(t, "testSending") : format(t, "test")),
            testResult && testResult.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "testOk")) : null,
            testResult && testResult.status === "error" ? el("span", { className: "dsh-goldboard-error" }, format(t, "testFailed", { error: testResult.error || "" })) : null,
          ),
        );
      });

      var saved = status === format(t, "saved");
      return el("div", { className: "dsh-goldboard-settings" },
        el("div", { className: "dsh-goldboard-header" },
          el("div", { className: "dsh-goldboard-header-row" },
            el("h2", { className: "dsh-goldboard-title" }, format(t, "settingsNav")),
            saving ? el("span", { className: "dsh-goldboard-tag" }, format(t, "saving")) : null,
            dirty ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-warn" }, format(t, "unsaved")) : null,
            saved ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-ok" }, format(t, "saved")) : null,
            !saving && !dirty && !saved && status ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-error" }, status) : null,
          ),
          el("p", { className: "dsh-goldboard-intro" }, format(t, "settingsIntro")),
        ),
        el("div", { className: "dsh-goldboard-content" },
        !saved && status ? el("div", { className: "dsh-goldboard-error" }, status) : null,

        el(CardRow, { title: format(t, "positionTitle"), hint: format(t, "positionHint") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "maxGrams"), value: cfg.limits.maxGrams, min: 0, onChange: function (value) { update(function (next) { next.limits.maxGrams = Number(value); }); } }),
          ),
          el("div", { className: "dsh-goldboard-lot-summary" },
            format(t, "totalGrams") + ": " + totalGrams.toFixed(2) + " g · " + format(t, "avgCost") + ": " + avgCostValue.toFixed(2) + " ¥/g",
          ),
          el("div", { className: "dsh-goldboard-lots" },
            lotList.map(function (lot, index) {
              return el("div", { key: lot.id || "lot-" + index, className: "dsh-goldboard-lot-row" },
                el(NumberField, { label: format(t, "lotGrams"), value: lot.grams, min: 0, onChange: function (value) { update(function (next) { next.position.lots[index].grams = Number(value); }); } }),
                el(NumberField, { label: format(t, "lotPrice"), value: lot.price, min: 0, step: 0.01, onChange: function (value) { update(function (next) { next.position.lots[index].price = Math.round(Number(value) * 100) / 100; }); } }),
                el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { update(function (next) { next.position.lots.splice(index, 1); }); } }, format(t, "removeLot")),
              );
            }),
            el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { update(function (next) { if (!next.position.lots) next.position.lots = []; next.position.lots.push({ id: "lot-" + Date.now() + "-" + next.position.lots.length, grams: 0, price: 0, time: new Date().toISOString(), status: "open" }); }); } }, format(t, "addLot")),
          ),
        ),

        el(CardRow, { title: format(t, "feeTitle") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "buyFee"), value: cfg.fee.buyPerGram, min: 0, onChange: function (value) { update(function (next) { next.fee.buyPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "sellFee"), value: cfg.fee.sellPerGram, min: 0, onChange: function (value) { update(function (next) { next.fee.sellPerGram = Number(value); }); } }),
          ),
          el("div", { className: "dsh-goldboard-hint" }, format(t, "feeTotal") + ": " + (Number(cfg.fee.buyPerGram) + Number(cfg.fee.sellPerGram)) + " ¥/g"),
        ),

        el(CardRow, { title: format(t, "cmbTitle"), hint: format(t, "cmbHint") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "cmbBuySpread"), value: cfg.cmb.buySpreadPerGram, onChange: function (value) { update(function (next) { next.cmb.buySpreadPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "cmbSellSpread"), value: cfg.cmb.sellSpreadPerGram, onChange: function (value) { update(function (next) { next.cmb.sellSpreadPerGram = Number(value); }); } }),
          ),
        ),

        el(CardRow, { title: format(t, "strategyTitle") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "minProfit"), value: cfg.strategy.minProfitPerGram, min: 0, onChange: function (value) { update(function (next) { next.strategy.minProfitPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxLoss"), value: cfg.strategy.maxLossPerGram, min: 0, onChange: function (value) { update(function (next) { next.strategy.maxLossPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "slippage"), value: cfg.strategy.slippagePerGram, min: 0, onChange: function (value) { update(function (next) { next.strategy.slippagePerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "estSpread"), value: cfg.strategy.estimatedSpreadPerGram, min: 0, onChange: function (value) { update(function (next) { next.strategy.estimatedSpreadPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "rsiOversold"), value: cfg.strategy.rsiOversold, min: 1, max: 49, onChange: function (value) { update(function (next) { next.strategy.rsiOversold = Number(value); }); } }),
            el(NumberField, { label: format(t, "rsiOverbought"), value: cfg.strategy.rsiOverbought, min: 50, max: 99, onChange: function (value) { update(function (next) { next.strategy.rsiOverbought = Number(value); }); } }),
            el(NumberField, { label: format(t, "atrFactor"), value: cfg.strategy.atrFactor, min: 0.05, max: 2, onChange: function (value) { update(function (next) { next.strategy.atrFactor = Number(value); }); } }),
            el(NumberField, { label: format(t, "nearSupportPct"), value: cfg.strategy.nearSupportPct, min: 0.05, max: 10, onChange: function (value) { update(function (next) { next.strategy.nearSupportPct = Number(value); }); } }),
            el(NumberField, { label: format(t, "minRemainGrams"), value: cfg.strategy.minRemainGrams, min: 0, onChange: function (value) { update(function (next) { next.strategy.minRemainGrams = Number(value); }); } }),
            el(NumberField, { label: format(t, "signalCooldownMinutes"), value: cfg.strategy.signalCooldownMinutes, min: 0, max: 1440, onChange: function (value) { update(function (next) { next.strategy.signalCooldownMinutes = Number(value); }); } }),
            el(NumberField, { label: format(t, "confirmBars"), value: cfg.strategy.confirmBars, min: 1, max: 10, onChange: function (value) { update(function (next) { next.strategy.confirmBars = Number(value); }); } }),
            el(NumberField, { label: format(t, "scoreThreshold"), value: cfg.strategy.scoreThreshold, min: 1, max: 10, onChange: function (value) { update(function (next) { next.strategy.scoreThreshold = Number(value); }); } }),
          ),
        ),

        el(CardRow, { title: format(t, "tradingTitle") },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { checked: cfg.tradingHours.weekdaysOnly === true, onChange: function (value) { update(function (next) { next.tradingHours.weekdaysOnly = value; }); } }),
            el("span", null, format(t, "weekdaysOnly")),
          ),
          el("div", { className: "dsh-goldboard-form-grid" },
            el(TextField, { label: format(t, "openTime"), value: cfg.tradingHours.open, onChange: function (value) { update(function (next) { next.tradingHours.open = value; }); } }),
            el(TextField, { label: format(t, "closeTime"), value: cfg.tradingHours.close, onChange: function (value) { update(function (next) { next.tradingHours.close = value; }); } }),
          ),
          el(TextField, { label: format(t, "holidays"), value: cfg.tradingHours.holidays.join(", "), onChange: function (value) { update(function (next) { next.tradingHours.holidays = value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean); }); } }),
        ),

        el(CardRow, { title: format(t, "sourceStatus") },
          !sources ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading"))
            : sources.length === 0 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "noData"))
            : sources.map(function (source) {
                var statusLabel = source.status === "ok" ? format(t, "sourceOk") : source.status === "error" ? format(t, "sourceError") : format(t, "sourceUnknown");
                var statusClass = source.status === "ok" ? "dsh-goldboard-tag dsh-goldboard-tag-ok" : source.status === "error" ? "dsh-goldboard-tag dsh-goldboard-tag-error" : "dsh-goldboard-tag";
                var currentText = source.current
                  ? format(t, "sourceCurrent") + ": " + fmtPrice(source.current.price) + (source.current.stale ? " (" + format(t, "stale") + ")" : "")
                  : format(t, "sourceNoCurrent");
                var lastText = source.lastTime ? format(t, "sourceLast") + ": " + formatBeijingTime(source.lastTime, true) : "";
                return el("div", { key: source.id, className: "dsh-goldboard-source-row" },
                  el("div", { className: "dsh-goldboard-source-info" },
                    el("span", { className: "dsh-goldboard-source-name" }, source.nameZh || source.nameEn || source.id),
                    el("span", { className: "dsh-goldboard-source-meta" },
                      currentText,
                      lastText ? " · " + lastText : "",
                      source.logCount !== undefined ? " · " + format(t, "sourceLogCount", { count: source.logCount }) : "",
                    ),
                  ),
                  el("span", { className: statusClass }, statusLabel),
                  el("button", { className: "dsh-goldboard-btn", onClick: function () { setLogSource(source); } }, format(t, "viewLogs")),
                );
              }),
        ),

        el(CardRow, { title: format(t, "alertsTitle") },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { checked: cfg.system.enabled === true, onChange: function (value) { update(function (next) { next.system.enabled = value; }); } }),
            el("span", null, format(t, "systemEnabled")),
          ),
          el("div", { className: "dsh-goldboard-hint" }, format(t, "systemHint")),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              className: "dsh-goldboard-btn",
              disabled: tests.system && tests.system.status === "sending",
              onClick: function () { runTest("system", undefined, { enabled: cfg.system.enabled }); },
            }, tests.system && tests.system.status === "sending" ? format(t, "testSending") : format(t, "test")),
            tests.system && tests.system.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "testOk")) : null,
            tests.system && tests.system.status === "error" ? el("span", { className: "dsh-goldboard-error" }, format(t, "testFailed", { error: tests.system.error || "" })) : null,
          ),
        ),

        el(CardRow, { title: format(t, "webhookTitle"), hint: format(t, "webhookTemplateHint") },
          channelCard("feishu", format(t, "feishu"), true),
          channelCard("dingtalk", format(t, "dingtalk"), true),
          channelCard("wecom", format(t, "wecom"), false),
          el("div", { className: "dsh-goldboard-generic" },
            genericCards.length > 0 ? genericCards : el("div", { className: "dsh-goldboard-hint" }, format(t, "genericNone")),
          ),
          el("button", { className: "dsh-goldboard-add", onClick: function () { update(function (next) { next.webhooks.generic.push({ id: "wh-" + Date.now().toString(36), name: "Webhook " + (next.webhooks.generic.length + 1), enabled: false, url: "", bodyTemplate: "" }); }); } }, format(t, "genericAdd")),
        ),
        ),
        el("div", { className: "dsh-goldboard-footer" },
          el("button", { className: "dsh-goldboard-primary", disabled: saving, onClick: save }, saving ? format(t, "saving") : format(t, "save")),
        ),
        logSource ? el(DataSourceLogsDialog, {
          t: t,
          source: logSource,
          onClose: function () { setLogSource(null); },
        }) : null,
      );
    }

    // ── plugin body ────────────────────────────────────────────────────────

    var pluginName = "dsh-plugin-goldboard";
    var inject = ["slots", "locale"];

    function apply(ctx) {
      var locale = ctx.get("locale");
      var fallbackT = function (key, params) {
        var text = DICT.zh[key] ?? key;
        if (params) for (var k in params) text = text.replace("{" + k + "}", String(params[k]));
        return text;
      };
      var t = locale && typeof locale.bind === "function" ? locale.bind(NS) : fallbackT;

      if (locale && typeof locale.register === "function") {
        ctx.effect(function () {
          return locale.register(NS, { zh: DICT.zh, en: DICT.en });
        }, NS + ": dictionaries");
      }

      var slots = ctx.get("slots");
      if (slots === undefined) return;

      slots.inject("shell.overlay", function () {
        return slots.register({
          name: "shell.overlay",
          id: "dsh-plugin-goldboard-board",
          order: 200,
          locale: NS,
          label: function () { return t("boardTitle"); },
        }, GoldBoardOverlay);
      });

      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "dsh-plugin-goldboard",
          order: 72,
          locale: NS,
          label: function () { return t("settingsNav"); },
        }, SettingsSection);
      });
    }

    exports.apply = apply;
    exports.name = pluginName;
    exports.inject = inject;
    exports.DICT = DICT;
    return module.exports;
  },
});
