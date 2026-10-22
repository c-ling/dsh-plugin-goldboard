/**
 * dsh-plugin-goldboard client half: hand-written factory-CJS browser bundle,
 * no build step.
 *
 * UI contributions (sidebar page model, matching the official Plugins and
 * Scheduled tasks entries):
 *   - sidebar.panellist: the "Gold Board" icon.
 *   - main key "goldboard": the standalone page with five tabs (overview,
 *     strategy/replay, analysis, data, settings). The old floating overlay and
 *     Settings section are gone.
 *
 * Target: DeepSeek Harness 0.2.1+ (Web and Desktop).
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
    var PAGE_ID = "goldboard";
    var API_PREFIX = "/api/dsh-plugin-goldboard";
    var SNAPSHOT_URL = API_PREFIX + "/snapshot";
    var CONFIG_URL = API_PREFIX + "/config";
    var MODELS_URL = API_PREFIX + "/models";
    var ANALYSIS_URL = API_PREFIX + "/analysis";
    var ANALYSIS_LOGS_URL = API_PREFIX + "/analysis-logs";
    var TEST_URL = API_PREFIX + "/test-notify";
    var SYSTEM_SETTINGS_URL = API_PREFIX + "/system-settings";
    var MANUAL_CMB_URL = API_PREFIX + "/manual-cmb-bars";
    var MANUAL_CMB_MISSING_URL = API_PREFIX + "/manual-cmb-missing";
    var REPLAY_STATS_URL = API_PREFIX + "/replay-stats";
    var STRATEGIES_URL = API_PREFIX + "/strategies";
    var STRATEGY_EXPERIMENTS_URL = API_PREFIX + "/strategy-experiments";
    var LEDGER_URL = API_PREFIX + "/ledger";
    var RESET_URL = API_PREFIX + "/reset";
    var API_LOGS_URL = API_PREFIX + "/api-logs";
    var DATA_SOURCES_URL = API_PREFIX + "/data-sources";
    var TABS = ["overview", "trading", "strategy", "analysis", "data", "settings"];
    // Configuration is partitioned per tab so each save only writes its own
    // sections; unsaved edits in other tabs are never captured by a save.
    var MODE_SECTIONS = {
      trading: ["position", "limits", "risk", "fee", "cmb", "manualPrevClose", "manualPrevCloseDate", "strategy", "tradingHours"],
      strategy: ["experiments"],
      analysis: ["analysis"],
      settings: ["sidebarPrice", "system", "webhooks"],
    };

    // ── css ────────────────────────────────────────────────────────────────

    (function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin="dsh-plugin-goldboard"]')) return;
      var style = document.createElement("style");
      style.setAttribute("data-plugin", "dsh-plugin-goldboard");
      style.setAttribute("data-pluginCss", "dsh-plugin-goldboard");
      style.textContent = [
        ".dsh-goldboard-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;background:transparent;}",
        ".dsh-goldboard-page *{box-sizing:border-box;}",
        ".dsh-goldboard-page-inner{width:100%;max-width:1056px;height:100%;min-height:0;margin:0 auto;padding:0 clamp(24px,4vw,48px);display:flex;flex-direction:column;}",
        ".dsh-goldboard-page-head{display:flex;flex:none;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px;flex-wrap:wrap;}",
        "[data-platform=darwin] .dsh-goldboard-page-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));}",
        ".dsh-goldboard-page-heading{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-page-title{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-page-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-head-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-head-actions{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-status-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));white-space:nowrap;}",
        ".dsh-goldboard-status-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#9aa0a6);}",
        ".dsh-goldboard-status-open .dsh-goldboard-status-dot{background:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-status-closed .dsh-goldboard-status-dot{background:var(--dsw-alias-state-warn-primary,#b7791f);}",
        ".dsh-goldboard-status-error .dsh-goldboard-status-dot{background:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-icon-button{width:32px;height:32px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none;transition:background .15s ease,border-color .15s ease,color .15s ease;}",
        ".dsh-goldboard-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);}",
        ".dsh-goldboard-icon-button:disabled{opacity:.45;cursor:not-allowed;}",
        ".dsh-goldboard-icon-button svg{width:16px;height:16px;display:block;}",
        ".dsh-goldboard-icon-button-spin svg{animation:dsh-goldboard-spin .9s linear infinite;}",
        "@keyframes dsh-goldboard-spin{to{transform:rotate(360deg)}}",
        ".dsh-goldboard-tabs-row{display:flex;flex:none;align-items:flex-end;justify-content:space-between;gap:16px;min-height:44px;margin-top:18px;padding-left:4px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:nowrap;}",
        ".dsh-goldboard-tabs{display:flex;flex:1;min-width:0;align-items:stretch;gap:24px;margin:0;padding:0;overflow-x:auto;scrollbar-width:none;}",
        ".dsh-goldboard-tab-actions{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding-bottom:8px;}",
        ".dsh-goldboard-tab-actions .dsh-goldboard-workbench-actions{position:static;margin:0;padding:0;border:0;background:transparent;}",
        ".dsh-goldboard-tabs::-webkit-scrollbar{display:none;}",
        ".dsh-goldboard-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:14px;font-weight:500;line-height:20px;height:auto;padding:0 0 10px;cursor:pointer;white-space:nowrap;margin-bottom:-1px;transition:color .15s ease,border-color .15s ease;}",
        ".dsh-goldboard-tab:hover{color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-tab[aria-selected=true]{color:var(--dsw-alias-state-business-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:500;}",
        ".dsh-goldboard-tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;}",
        ".dsh-goldboard-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;}",
        ".dsh-goldboard-tabpanel{display:flex;flex-direction:column;gap:16px;padding:20px 0 8px;min-width:0;}",
        ".dsh-goldboard-overview{display:flex;flex-direction:column;gap:16px;}",
        ".dsh-goldboard-banner{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-banner-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);color:var(--dsw-alias-state-warn-primary);}",
        ".dsh-goldboard-card-row{min-width:0;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));}",
        ".dsh-goldboard-card-row-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0;}",
        ".dsh-goldboard-card-row-header h3{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);min-width:0;}",
        ".dsh-goldboard-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-loading{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:4px 0;}",
        ".dsh-goldboard-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));white-space:nowrap;}",
        ".dsh-goldboard-tag-ok,.dsh-goldboard-tag-success{color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-tag-error{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-tag-warn{color:var(--dsw-alias-state-warn-primary);}",
        ".dsh-goldboard-quote-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}",
        ".dsh-goldboard-item{min-width:0;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);padding:14px 16px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));transition:border-color .15s ease,background .15s ease;}",
        ".dsh-goldboard-item-clickable{cursor:pointer;text-align:left;font:inherit;color:inherit;}",
        ".dsh-goldboard-item-clickable:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover);}",
        ".dsh-goldboard-item-clickable:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;}",
        ".dsh-goldboard-item-active{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);}",
        ".dsh-goldboard-item-label{display:flex;align-items:center;gap:4px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
        ".dsh-goldboard-item-label-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
        ".dsh-goldboard-item-value{font-size:24px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-cmb-row{grid-column:auto;}",
        ".dsh-goldboard-cmb-head{display:flex;align-items:flex-start;gap:8px;min-width:0;flex-wrap:wrap;}",
        ".dsh-goldboard-cmb-head .dsh-goldboard-item-label{flex:1;min-width:0;}",
        ".dsh-goldboard-cmb-prices{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
        ".dsh-goldboard-up{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-goldboard-down{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-goldboard-flat{color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-dashboard-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:16px;align-items:start;}",
        ".dsh-goldboard-dashboard-main,.dsh-goldboard-dashboard-side{display:flex;flex-direction:column;gap:16px;min-width:0;}",
        ".dsh-goldboard-chart-block{display:flex;flex-direction:column;gap:10px;min-width:0;}",
        ".dsh-goldboard-chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-chart-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);font-weight:500;}",
        ".dsh-goldboard-chart-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
        ".dsh-goldboard-chart-toggle{flex:none;padding:2px 9px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}",
        ".dsh-goldboard-chart-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-chart-toggle[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-series{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;}",
        ".dsh-goldboard-series button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap;}",
        ".dsh-goldboard-series button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary);font-weight:500;}",
        ".dsh-goldboard-chart{position:relative;width:100%;height:200px;border-radius:var(--dsw-radius-md);overflow:hidden;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2),transparent);}",
        ".dsh-goldboard-spark{width:100%;height:100%;display:block;}",
        ".dsh-goldboard-chart-tip{position:absolute;top:0;transform:translateX(-50%);pointer-events:none;z-index:2;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:nowrap;box-shadow:0 2px 8px rgba(15,23,42,.12);}",
        ".dsh-goldboard-chart-tip-time{color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-chart-tip-value{font-weight:600;font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-chart-hover-line{stroke:var(--dsw-alias-border-l3);stroke-width:1;stroke-dasharray:3 3;}",
        ".dsh-goldboard-chart-now-line{stroke:var(--dsw-alias-state-business-primary);stroke-width:1;stroke-dasharray:4 4;}",
        ".dsh-goldboard-chart-stats{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-chart-stat{display:inline-flex;align-items:center;gap:5px;}",
        ".dsh-goldboard-chart-stat b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-trend-empty{width:100%;box-sizing:border-box;min-height:120px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:16px;font-size:12px;line-height:18px;text-align:center;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-plan{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);padding:16px;display:flex;flex-direction:column;gap:10px;min-width:0;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));}",
        ".dsh-goldboard-plan-title{font-size:14px;font-weight:500;line-height:22px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-plan-row{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}",
        ".dsh-goldboard-plan-row>span:first-child{color:var(--dsw-alias-label-tertiary);flex:none;}",
        ".dsh-goldboard-plan-row>span:last-child{min-width:0;text-align:right;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-plan-action{margin-top:2px;padding:10px 12px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-plan-reason{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-risk-gate{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-risk-gate-blocked{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-risk{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-risk-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}",
        ".dsh-goldboard-kv{display:flex;flex-direction:column;min-width:0;}",
        ".dsh-goldboard-kv-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px;}",
        ".dsh-goldboard-kv-row:last-child{border-bottom:0;}",
        ".dsh-goldboard-kv-label{color:var(--dsw-alias-label-tertiary);flex:none;}",
        ".dsh-goldboard-kv-value{color:var(--dsw-alias-label-primary);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}",
        ".dsh-goldboard-kv-value-risk{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-kv-value-ok{color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-chip-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
        ".dsh-goldboard-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));white-space:nowrap;}",
        ".dsh-goldboard-chip-warn{color:var(--dsw-alias-state-warn-primary);}",
        ".dsh-goldboard-chip-error{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-card-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-workbench{display:flex;flex-direction:column;gap:16px;min-width:0;}",
        ".dsh-goldboard-workbench[hidden]{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-experiments,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-analysis,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-stats,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-sources,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-manual-cmb,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-alerts,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-webhooks,\n.dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-ledger{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-position,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-risk,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-fee,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-cmb,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-manual-prev,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-strategy,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-trading,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-experiments,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-analysis,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-stats,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-sources,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-manual-cmb,\n.dsh-goldboard-workbench[data-mode=\"settings\"] .dsh-goldboard-section-ledger{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-position,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-risk,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-fee,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-cmb,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-manual-prev,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-strategy,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-trading,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-alerts,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-webhooks,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-analysis,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-sources,\n.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-manual-cmb{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-position,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-risk,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-fee,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-cmb,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-manual-prev,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-strategy,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-trading,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-alerts,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-webhooks,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-experiments,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-stats,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-sources,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-manual-cmb,\n.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-ledger{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-position,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-risk,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-fee,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-cmb,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-manual-prev,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-strategy,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-trading,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-alerts,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-webhooks,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-experiments,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-analysis,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-stats,\n.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-ledger{display:none;}",
        ".dsh-goldboard-workbench-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px;}",
        ".dsh-goldboard-workbench-body{display:flex;flex-direction:column;gap:16px;min-width:0;}",
        ".dsh-goldboard-settings-layout{display:grid;grid-template-columns:172px minmax(0,1fr);gap:24px;align-items:start;}",
        ".dsh-goldboard-settings-nav{position:sticky;top:12px;display:flex;flex-direction:column;gap:2px;min-width:0;}",
        ".dsh-goldboard-settings-nav button{appearance:none;border:0;background:transparent;text-align:left;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        ".dsh-goldboard-settings-nav button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-settings-sections{display:flex;flex-direction:column;gap:16px;min-width:0;}",
        ".dsh-goldboard-settings-section{scroll-margin-top:16px;}",
        ".dsh-goldboard-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px;min-width:0;}",
        ".dsh-goldboard-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-field>span:first-child{overflow-wrap:anywhere;}",
        ".dsh-goldboard-input{width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;outline:none;transition:border-color .15s ease;}",
        ".dsh-goldboard-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary);}",
        ".dsh-goldboard-input::placeholder{color:var(--dsw-alias-label-dimmed);}",
        ".dsh-goldboard-input:disabled{opacity:.55;cursor:not-allowed;}",
        ".dsh-goldboard-lot-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-lots{display:flex;flex-direction:column;gap:8px;}",
        ".dsh-goldboard-lot-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-lot-row:last-child{border-bottom:0;padding-bottom:0;}",
        ".dsh-goldboard-lot-row .dsh-goldboard-field{flex:1 1 120px;min-width:0;}",
        ".dsh-goldboard-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}",
        ".dsh-goldboard-row>label{flex:1 1 220px;min-width:0;font-size:13px;line-height:20px;}",
        ".dsh-goldboard-btn{box-sizing:border-box;min-height:36px;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .15s ease,border-color .15s ease;}",
        ".dsh-goldboard-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);}",
        ".dsh-goldboard-btn:disabled{opacity:.45;cursor:not-allowed;}",
        ".dsh-goldboard-btn:focus-visible,.dsh-goldboard-primary:focus-visible,.dsh-goldboard-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}",
        ".dsh-goldboard-primary{box-sizing:border-box;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff);font-family:inherit;font-size:14px;line-height:22px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .15s ease;}",
        ".dsh-goldboard-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));}",
        ".dsh-goldboard-primary:disabled{opacity:.45;cursor:not-allowed;}",
        ".dsh-goldboard-add{width:100%;height:36px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;}",
        ".dsh-goldboard-add:hover{background:var(--dsw-alias-interactive-bg-hover);}",
        ".dsh-goldboard-generic{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0;}",
        ".dsh-goldboard-switch{position:relative;flex:none;width:40px;height:22px;border-radius:999px;border:0;padding:0;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease;}",
        ".dsh-goldboard-switch-on,.dsh-goldboard-switch-on:hover{background:var(--dsw-alias-state-business-primary);}",
        ".dsh-goldboard-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}",
        ".dsh-goldboard-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,23,42,.25);transition:transform .15s ease;}",
        ".dsh-goldboard-switch-on .dsh-goldboard-switch-knob{transform:translateX(18px);}",
        ".dsh-goldboard-savebar{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:4px;padding:12px 16px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:0 -4px 16px rgba(0,0,0,.06);}",
        ".dsh-goldboard-savebar-info{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0;}",
        ".dsh-goldboard-savebar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-analysis-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-analysis-primary-actions{width:100%;}",
        ".dsh-goldboard-analysis-primary-actions .dsh-goldboard-primary{width:100%;}",
        ".dsh-goldboard-analysis-status{min-height:20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-analysis-status-error{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-analysis-status-ok{color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-analysis-result{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;}",
        ".dsh-goldboard-analysis-result-row{display:grid;grid-template-columns:minmax(78px,auto) minmax(0,1fr);gap:8px;}",
        ".dsh-goldboard-analysis-result-label{color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-analysis-failures{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px;color:var(--dsw-alias-state-warn-primary);}",
        ".dsh-goldboard-stats-actions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-stats-summary{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-stats-scroll{overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);}",
        ".dsh-goldboard-stats-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}",
        ".dsh-goldboard-stats-table th,.dsh-goldboard-stats-table td{padding:6px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-stats-table th:first-child,.dsh-goldboard-stats-table td:first-child{text-align:left;}",
        ".dsh-goldboard-stats-table thead th{color:var(--dsw-alias-label-secondary);font-weight:600;background:var(--dsw-alias-bg-layer-2);position:sticky;top:0;}",
        ".dsh-goldboard-stats-table tbody tr:last-child td{border-bottom:0;}",
        ".dsh-goldboard-stats-net-pos{color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-stats-net-neg{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-stats-caveats{margin:4px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-stats-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-stats-overall{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px;}",
        ".dsh-goldboard-stats-card{flex:1 1 150px;min-width:140px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-stats-detail-button{flex:none;padding:2px 7px;font-size:11px;line-height:16px;}",
        ".dsh-goldboard-stats-card-value{font-size:18px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-stats-card-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-stats-card-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-stats-group-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);margin:12px 0 2px;}",
        ".dsh-goldboard-stats-group-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:0 0 6px;}",
        ".dsh-goldboard-stats-table .dsh-goldboard-btn{height:24px;min-height:24px;padding:0 8px;font-size:11px;}",
        ".dsh-goldboard-experiment{display:flex;flex-direction:column;gap:10px;}",
        ".dsh-goldboard-experiment-toolbar{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-experiment-toolbar>.dsh-goldboard-field{flex:1 1 150px;}",
        ".dsh-goldboard-experiment-list{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-experiment-strategy{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-experiment-strategy-main{min-width:0;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-experiment-strategy-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-experiment-strategy-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-experiment-checks{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}",
        ".dsh-goldboard-experiment-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-experiment-check input{accent-color:var(--dsw-alias-state-business-primary);}",
        ".dsh-goldboard-experiment-matrix{display:grid;grid-template-columns:minmax(140px,max-content) minmax(0,1fr);align-items:center;gap:6px 12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-experiment-matrix>.dsh-goldboard-btn{grid-column:1/-1;justify-self:start;}",
        ".dsh-goldboard-experiment-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-experiment-status-error{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-experiment-report-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-experiment-scroll{overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);}",
        ".dsh-goldboard-experiment-table{width:100%;border-collapse:collapse;font-size:11px;line-height:16px;}",
        ".dsh-goldboard-experiment-table th,.dsh-goldboard-experiment-table td{padding:6px 8px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-experiment-table th:first-child,.dsh-goldboard-experiment-table td:first-child{text-align:left;}",
        ".dsh-goldboard-experiment-table thead th{color:var(--dsw-alias-label-secondary);font-weight:600;background:var(--dsw-alias-bg-layer-2);}",
        ".dsh-goldboard-experiment-table tbody tr:last-child td{border-bottom:0;}",
        ".dsh-goldboard-source-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-source-row:last-child{border-bottom:0;}",
        ".dsh-goldboard-source-info{flex:1;min-width:180px;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-goldboard-source-name{font-size:13px;line-height:20px;font-weight:500;}",
        ".dsh-goldboard-source-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}",
        ".dsh-goldboard-log-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));padding:16px;overflow:auto;}",
        ".dsh-goldboard-log-dialog{width:min(720px,100%);max-height:min(80vh,760px);display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:16px;box-shadow:0 18px 48px rgba(15,23,42,.22);}",
        ".dsh-goldboard-log-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-log-title{flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px;}",
        ".dsh-goldboard-log-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;}",
        ".dsh-goldboard-log-item{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:8px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;}",
        ".dsh-goldboard-log-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-log-status{font-weight:600;}",
        ".dsh-goldboard-log-status-ok{color:var(--dsw-alias-state-success-primary);}",
        ".dsh-goldboard-log-status-fail{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-log-meta{color:var(--dsw-alias-label-tertiary);word-break:break-all;}",
        ".dsh-goldboard-log-error{color:var(--dsw-alias-state-error-primary);}",
        ".dsh-goldboard-tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:inherit;cursor:help;vertical-align:middle;flex:none;}",
        ".dsh-goldboard-tip svg{display:block;width:14px;height:14px;}",
        ".dsh-goldboard-tip-pop{position:fixed;z-index:10000;width:max-content;max-width:240px;padding:6px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;line-height:16px;font-weight:400;white-space:pre-line;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none;}",
        ".dsh-goldboard-indicator-title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:4px 0 2px;display:flex;align-items:center;gap:4px;}",
        ".dsh-goldboard-indicator-table-wrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);}",
        ".dsh-goldboard-indicator-table{width:100%;border-collapse:collapse;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-indicator-table th,.dsh-goldboard-indicator-table td{padding:5px 8px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-indicator-table th:first-child,.dsh-goldboard-indicator-table td:first-child{text-align:left;}",
        ".dsh-goldboard-indicator-table thead th{color:var(--dsw-alias-label-secondary);font-weight:600;background:var(--dsw-alias-bg-layer-2);}",
        ".dsh-goldboard-indicator-table tbody tr:last-child td{border-bottom:0;}",
        ".dsh-goldboard-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-header{display:flex;flex-direction:column;gap:4px;min-width:0;}",
        ".dsh-goldboard-header-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-title{margin:0;font-size:18px;font-weight:500;line-height:26px;}",
        ".dsh-goldboard-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-goldboard-page-footer{flex:none;margin-top:0;padding:10px 0 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}",
        ".dsh-goldboard-render-error{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;min-height:240px;}",
        ".dsh-goldboard-render-error pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:0;}",
        "@media (max-width:1000px){",
        ".dsh-goldboard-quote-grid{grid-template-columns:repeat(2,minmax(0,1fr));}",
        ".dsh-goldboard-dashboard-grid{grid-template-columns:minmax(0,1fr);}",
        ".dsh-goldboard-settings-layout{grid-template-columns:minmax(0,1fr);}",
        ".dsh-goldboard-settings-nav{position:static;flex-direction:row;overflow-x:auto;padding-bottom:2px;gap:2px;}",
        ".dsh-goldboard-settings-nav button{padding:4px 8px;}",
        "}",
        "@media (max-width:680px){",
        ".dsh-goldboard-page-inner{padding:0 16px;}",
        ".dsh-goldboard-page-head{padding-top:20px;}",
        "[data-platform=darwin] .dsh-goldboard-page-head{padding-top:calc(20px + var(--dsh-frame-top-clearance,0px));}",
        ".dsh-goldboard-page-title{font-size:18px;line-height:26px;}",
        ".dsh-goldboard-quote-grid{grid-template-columns:minmax(0,1fr);}",
        ".dsh-goldboard-item-value{font-size:22px;line-height:30px;}",
        ".dsh-goldboard-chart{height:160px;}",
        ".dsh-goldboard-card-row,.dsh-goldboard-plan,.dsh-goldboard-item{padding:12px;}",
        ".dsh-goldboard-savebar{padding:10px 12px;}",
        ".dsh-goldboard-savebar-actions{width:100%;justify-content:flex-end;}",
        ".dsh-goldboard-tab{padding:0 0 8px;font-size:13px;}",
        ".dsh-goldboard-status-pill{height:22px;}",
        ".dsh-goldboard-head-actions{width:100%;justify-content:flex-start;}",
        ".dsh-goldboard-chart-stats{gap:8px 12px;}",
        ".dsh-goldboard-log-dialog{padding:12px;max-height:88vh;}",
        ".dsh-goldboard-experiment-matrix{grid-template-columns:minmax(0,1fr);}",
        "}",
        "@media (prefers-reduced-motion:reduce){",
        ".dsh-goldboard-icon-button svg,.dsh-goldboard-chip,.dsh-goldboard-btn,.dsh-goldboard-primary,.dsh-goldboard-switch,.dsh-goldboard-switch-knob,.dsh-goldboard-item{transition:none!important;animation:none!important;}",
        "}",
        "body:not([data-ds-dark-theme]) .dsh-goldboard-item-active{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);}",
        ".dsh-goldboard-workbench-body>.dsh-goldboard-settings-nav{position:static;flex-direction:row;overflow-x:auto;gap:2px;padding-bottom:2px;scrollbar-width:none;}",
        ".dsh-goldboard-workbench-body>.dsh-goldboard-settings-nav::-webkit-scrollbar{display:none;}",
        ".dsh-goldboard-tabpanel[hidden]{display:none!important;}",
        ".dsh-goldboard-card-row[id^=\"dsh-goldboard-settings-\"]{scroll-margin-top:16px;}",
        ".dsh-goldboard-platform{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));}",
        ".dsh-goldboard-workbench-actions{position:sticky;top:0;z-index:8;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 0;margin-bottom:4px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-goldboard-workbench-actions-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}",
        ".dsh-goldboard-workbench-actions-buttons{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto;}",
        ".dsh-goldboard-indicator-label{display:inline-flex;align-items:center;gap:7px;min-width:0;}",
        ".dsh-goldboard-side-glyph{display:inline-flex;align-items:center;justify-content:center;}",
        "button:has(.dsh-goldboard-side-price){position:relative;padding-right:88px;}",
        ".dsh-goldboard-side-price{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;line-height:16px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;}",
        "[data-sidebar-collapsed] button:has(.dsh-goldboard-side-price){padding-right:8px;}",
        "[data-sidebar-collapsed] .dsh-goldboard-side-price{display:none;}",
        ".dsh-goldboard-log-dialog{max-width:calc(100vw - 32px);overflow:hidden;}",
        ".dsh-goldboard-log-body{min-width:0;max-width:100%;}",
        ".dsh-goldboard-stats-detail-dialog{width:min(880px,calc(100vw - 32px));max-height:min(82vh,900px);}",
        ".dsh-goldboard-stats-detail-body{display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%;flex:1;min-height:0;overflow-y:auto;padding-right:2px;}",
        ".dsh-goldboard-stats-detail-section{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;}",
        ".dsh-goldboard-stats-detail-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0;}",
        ".dsh-goldboard-stats-scroll{max-width:100%;}",
        ".dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-sidebar-price{display:none;}",
        ".dsh-goldboard-workbench[data-mode=\"trading\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"strategy\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"analysis\"] .dsh-goldboard-section-sidebar-price,.dsh-goldboard-workbench[data-mode=\"data\"] .dsh-goldboard-section-sidebar-price{display:none;}",
        ".dsh-goldboard-missing-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:340px;overflow-y:auto;padding:4px 2px;scrollbar-width:thin;}",
        ".dsh-goldboard-missing-row{display:flex;align-items:center;gap:8px;min-width:0;}",
        ".dsh-goldboard-missing-time{flex:none;width:42px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
        ".dsh-goldboard-missing-row .dsh-goldboard-input{height:30px;min-width:0;flex:1;font-size:12px;padding:0 8px;}",
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
        expand: "展开",
        copy: "复制委托",
        copied: "已复制",
        riskNote: "技术面参考，非投资建议",
        breakeven: "回本价",
        targetPrice: "卖出目标",
        stopPrice: "止损位",
        targetTrailLine: "回撤卖出线",
        grams: "克",
        position: "当前持仓",
        pnl: "扣费浮盈亏",
        action_buy_setup: "出现买入机会啦，可以考虑入手～",
        action_add_position: "金价回调企稳，可以考虑补一点仓～",
        action_reduce_position: "金价冲高回落，可以考虑先减点仓～",
        action_sell_take_profit: "当前金价已经达到盈利目标啦，可以考虑卖出哦～",
        action_sell_target_trail: "金价从目标位回落啦，建议按回撤线卖出～",
        action_sell_time_stop: "持仓太久还没到目标，建议先退出～",
        action_sell_trailing: "金价短线走弱啦，记得保护好利润～",
        action_sell_stop: "金价跌到止损位啦，注意控制风险～",
        action_sell_weakness: "盘面有点走弱，可以考虑减仓避险～",
        action_close_by_session_end: "快到收盘时间啦，注意日内了结～",
        action_wait: "暂时没有合适机会，再等等看～",
        action_market_closed: "现在是休市时间哦～",
        action_no_data: "还在等行情数据～",
        action_no_budget: "已经达到投入上限啦，先不加仓～",
        action_data_incomplete: "当前数据有缺失，暂不给出建议～",
          action_cancel_order: "原挂单建议已失效，请撤销未成交挂单～",
          action_order_updated: "挂单建议已更新，请按新建议处理～",
        panel: "黄金看板",
        tablistLabel: "黄金看板页面",
        tab_overview: "概览",
        tab_trading: "交易",
        tab_strategy: "策略与回放",
        tab_analysis: "分析",
        tab_data: "数据",
        tab_settings: "设置",
        autoRefresh: "每 10 秒自动刷新",
        platformDesktop: "桌面端",
        platformWeb: "Web",
        loadFailedShort: "加载失败",
        renderError: "黄金看板页面渲染失败",
        renderErrorHint: "请重试；若仍失败，请查看控制台错误详情。",
        renderErrorDetails: "错误详情",
        editPosition: "编辑持仓",
        resetPosition: "重置持仓",
        noPosition: "尚未记录持仓。",
        signalLane: "信号道",
        historicalRecords: "历史记录",
        dataDisclaimer: "数据来自公开行情源，可能存在延迟或缺失",
        chartOpen: "开",
        chartHigh: "高",
        chartLow: "低",
        chartLast: "最新",
        noTrend: "今日暂无可用走势数据",
        copyOrder: "复制委托",
        ledgerHint: "setup / decision / order 的有界只读投影；受阻断信号只记录 not_executed。",
        ledgerBlocked: "未执行",
        discard: "放弃更改",
        saveConflict: "配置已在其他窗口更新：草稿已保留，请确认后再次保存。",
        lane_cmb: "招行积存金",
        lane_au9999: "Au99.99",
        lane_xau: "国际金价",
        lane_unknown: "未知",
        riskMode_fixed_grams: "固定克数",
        riskMode_budget: "风险预算",
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
        riskTitle: "风险预算与加仓闸门",
        riskHint: "默认固定克数模式保持原有分档建议；预算模式按 ATR、可执行点差、费用、滑点及可用风险预算取最小建议规模。",
        riskMode: "建议规模模式",
        riskModeFixedGrams: "固定克数分档",
        riskModeBudget: "风险预算",
        referenceEquityCny: "参考权益（元）",
        referenceEquityHint: "仅用于计算风险占比，不代表真实账户余额。",
        maxAmountCny: "最大名义金额（元）",
        maxRiskPerTradeCny: "单笔最大风险（元）",
        maxDailyLossCny: "当日最大损失（元）",
        maxWeeklyLossCny: "当周最大损失（元）",
        maxDrawdownCny: "最大回撤（元）",
        volatilityTarget: "ATR 风险倍数",
        volatilityTargetHint: "止损距离使用 5 分钟 ATR × 此倍数，并与点差和滑点缓冲取最大值。",
        liquidityCapGrams: "单笔流动性上限（克）",
        maxAddsPerSetup: "同一 setup 最大加仓次数",
        maxAddsPerDay: "单日最大加仓次数",
        minAddPriceImprovement: "再次加仓最小价格改善（元/克）",
        consecutiveLossDeRisk: "连续亏损降档阈值（次）",
        zeroDisablesGate: "数值为 0 表示关闭对应约束；参考权益只是风险计算基准。",
        riskGateOpen: "新增买入闸门开放",
        riskGateBlocked: "新增买入已阻断",
        riskGateProtectiveExitAllowed: "保护性卖出仍允许",
        riskDailyLoss: "当日损失 {value} 元",
        riskWeeklyLoss: "当周损失 {value} 元",
        riskDrawdown: "当前回撤 {value} 元",
        riskAddsToday: "今日加仓 {value} 次",
        riskSetupAdds: "当前 setup 加仓 {value} 次",
        riskDailyLossLabel: "当日损失",
        riskWeeklyLossLabel: "当周损失",
        riskDrawdownLabel: "当前回撤",
        riskAddsTodayLabel: "今日加仓",
        riskSetupAddsLabel: "当前 setup 加仓",
        riskLedgerCounts: "决策 {decisions} · 订单 {orders} · 未执行 {blocked}",
        riskActiveSetup: "当前 setup：{id}",
        riskNoActiveSetup: "当前没有 active setup",
        riskEvidenceHint: "损失与成交来自本地建议账本和用户持仓确认，属于风险估算，不是真实账户流水。当日/当周损失与回撤包含已确认卖出的已实现亏损，因此空仓时也会显示；平仓不会清零当日额度，按北京时间 0 点重置当日。",
        riskNominalAmount: "名义金额",
        riskStopDistance: "止损距离",
        riskPerGram: "每克最坏风险",
        riskWorstCaseLoss: "最坏情景亏损",
        riskAvailableBudget: "可用风险预算",
        riskBudgetRatio: "参考权益占比",
        riskUnknown: "未知",
        ledgerTitle: "风险闸门与信号账本",
        ledgerDetails: "查看账本",
        ledgerRefresh: "刷新账本",
        resetLedger: "重置本地持仓与账本",
        resetConfirmText: "将清空本地持仓、建议账本、待处理挂单和回撤/当日损失统计；不会操作招行账户，且不可撤销。",
        resetConfirm: "确认重置",
        resetCancel: "取消",
        ledgerEmpty: "暂无 setup、决策或订单记录",
        ledgerOrders: "建议订单轨迹",
        ledgerDecisions: "主动与受抑制决策",
        ledgerTime: "时间",
        ledgerStatus: "状态",
        ledgerAction: "动作",
        ledgerSize: "克数 / 仓位",
        ledgerPrice: "建议价 / 风险预算",
        ledgerIds: "Setup / Decision / Order ID",
        ledgerReason: "原因",
        ledgerStatus_active: "主动信号",
        ledgerStatus_pending: "等待确认",
        ledgerStatus_filled: "用户持仓确认成交",
        ledgerStatus_expired: "已过期/撤销",
        ledgerStatus_replaced: "已替换",
        ledgerStatus_not_executed: "受闸门阻断，未执行",
        feeTitle: "报价外显式费用（招行积存金）",
        buyFee: "显式买入费（元/克）",
        sellFee: "显式卖出费（元/克）",
        feeTotal: "双边合计",
        deriveSellFromFee: "卖出价 = 买入价 − 手续费（忽略实时卖出价）",
        deriveSellFromFeeTip: "开启后：卖出价由实时买入价减去上面的卖出费推导，执行、风控与账本不再重复扣费；手续费变动时改上面的数字即可。关闭时使用招行实时双边报价。",
        deriveSellFromFeeActive: "手续费已含在推导出的卖出价中，不再重复扣费",
        cmbTitle: "招行积存金价格",
        cmbBuySpread: "买入价差（元/克，备用估算）",
        cmbSellSpread: "卖出价差（元/克，备用估算）",
        cmbHint: "优先从招行接口拉取实时客户买卖价；接口不可用时回退为国际金价按汇率折算 + 价差估算。实际以招行 App 报价为准。",
        cmbSpreadSourceLabel: "当前价差来源",
        cmbSpreadSourceLive: "招行实时报价",
        cmbSpreadSourceDynamic: "动态双边估算（近 {count} 个实时采样中位数）",
        cmbSpreadSourceLegacy: "旧版中间价估算（{count} 个 legacy 样本）",
        cmbSpreadSourceStatic: "静态配置价差（采样不足 {count} 个）",
        manualPrevCloseTitle: "手动昨收（今日参考）",
        manualPrevCloseHint: "留空自动获取；仅对今天有效，每天北京时间 00:00 自动清空。",
        manualCmbTitle: "手动补充今日招行积存金分钟价",
        manualCmbHint: "以下列出今日已到时间且缺失的分钟，填写价格后点击补充；不会覆盖已有数据。",
        manualCmbSubmit: "补充已填写价格",
        manualCmbSending: "补充中…",
        manualCmbAdded: "已补充 {added} 条，跳过 {skipped} 条。",
        manualCmbMissingLoading: "正在加载今日缺失分钟…",
        manualCmbMissingNone: "今日暂无缺失分钟价",
        manualCmbPricePlaceholder: "价格",
        strategyTitle: "日内信号参数",
        minProfit: "最小目标利润（元/克）",
        maxLoss: "最大可承受亏损（元/克）",
        slippage: "滑点估算（元/克）",
        estSpread: "Fallback 最小估算点差（元/克）",
        rsiOversold: "RSI 超卖阈值",
        rsiOverbought: "RSI 超买阈值",
        atrFactor: "ATR 目标系数",
        nearSupportPct: "接近支撑判定（%）",
        minRemainGrams: "最小保留底仓（克）",
        signalCooldownMinutes: "同方向建议冷却（分钟）",
        confirmBars: "连续确认次数",
        scoreThreshold: "信号强度阈值",
        closeBySessionEnd: "收盘前强制平仓提示",
        closeBySessionEndTip: "默认关闭：临近收盘 30 分钟不再固定建议卖出（不固定倾向于日内了结），持仓继续按止盈/止损/走弱等常规信号判断。开启后恢复收盘前建议全部了结。",
        orderRepricePct: "挂单偏离撤单阈值（%）",
        targetTrailPerGram: "目标回撤止盈（元/克，0=关）",
        targetPartialRatio: "首触目标卖出比例（0–0.9）",
        targetTrailBars: "未创新高最多观察（5分钟K线）",
        requirePriceAboveEma60: "买点需价格高于60分钟EMA20",
        requirePriceAboveEma60Tip: "开启后，5分钟买点还必须满足现价高于60分钟EMA20，用于过滤下跌趋势中的逆势做多。",
        requireDailyUptrend: "买点需日线收盘在EMA20上方且EMA20上行",
        requireDailyUptrendTip: "开启后，买点还要求最近一根已收盘日线收盘价高于日线EMA20、且EMA20上行；日线数据不足时不出买点。用于过滤日线空头里的逆势做多。",
        maxBarsBeforeTarget: "武装前最长持有（5分钟K线，0=关）",
        tradingTitle: "交易时段",
        weekdaysOnly: "仅工作日交易",
        openTime: "开盘时间",
        closeTime: "收盘时间（支持 26:00 表示次日 02:00）",
        holidays: "节假日（YYYY-MM-DD，逗号分隔）",
        alertsTitle: "提醒",
        systemEnabled: "宿主机系统通知",
        systemHint: "由 DSH 宿主进程发送，需要宿主保持运行；macOS 首次使用可能需要在系统设置 → 通知中允许脚本/终端通知。",
        webhookTitle: "Webhook",
        feishu: "飞书",
        dingtalk: "钉钉",
        wecom: "企业微信",
        webhookUrl: "Webhook 地址",
        webhookSecret: "签名密钥（可选）",
        webhookSecretSet: "已配置（留空保持不变）",
        webhookSecretBadge: "已配置",
        webhookSecretClear: "清除密钥",
        webhookEnabled: "启用该渠道",
        webhookTemplate: "消息模板（可选）",
        webhookTemplateHint: "占位符：{{action}} {{instrument}} {{price}} {{cmbPrice}} {{target}} {{grams}} {{time}}",
        test: "发送测试",
        testSending: "发送中…",
        testOk: "测试消息已发送",
        systemTestOk: "测试命令已执行；若未看到通知，请检查系统通知权限",
        testFailed: "测试失败：{error}",
        generic: "通用 Webhook",
        genericAdd: "添加",
        genericRemove: "移除",
        genericName: "名称",
        genericDefaultName: "通用 Webhook {n}",
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
        sourceCircuitOpen: "熔断中",
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
        sourceSuccessRate: "成功率 {rate}",
        sourceLatency: "延迟 P50 {p50}ms / P95 {p95}ms",
        sourceFallbacks: "可用备用源 {count}",
        sourceFailureDuration: "连续失败 {minutes} 分钟",
        sourceExecutionCoverage: "真实双边 {real} · 代理 {proxy} · synthetic {synthetic}",
        sourceGapCount: "历史缺口 {count} 个",
        noData: "暂无行情",
        reason: "参考理由",
        planTitle: "当前建议",
        dataCoverage: "数据覆盖率",
        coverageEffective: "有效 {effective}/{window} 分钟",
        coverageGap: "最大缺口 {minutes} 分钟",
        coverageReanchored: "已在最近缺口后重锚",
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
        analysisTitle: "模型与分析",
        analysisHint: "使用 Harness 已配置的模型解释已完成的指标与规则结果；即使数据质量门控未通过也可调用，模型会以数据不足/过期/无效等状态说明限制，且不能生成交易指令。",
        analysisEnabled: "启用模型分析",
        analysisProvider: "服务商",
        analysisModel: "模型",
        analysisReasoning: "推理强度",
        analysisTrigger: "触发方式",
        analysisTriggerManual: "手动",
        analysisCooldown: "分析冷却（分钟）",
        analysisTimeout: "模型超时（秒）",
         analysisMaxTokens: "最大输出 tokens",
        experimentTitle: "策略实验",
        experimentHint: "候选策略仅用于隔离回放；实时建议始终由固定 control 产生。未通过样本外准入的结果不会显示为验证结论或推荐。",
        experimentEnabled: "启用策略实验",
        experimentDisabledHint: "策略实验默认关闭。启用并保存配置后才可运行。",
        experimentCatalogLoading: "正在加载策略目录…",
        experimentCatalogError: "策略目录加载失败：{error}",
        experimentLatestError: "实验报告加载失败：{error}",
        experimentControl: "Control 趋势回调",
        experimentOrb: "ORB 趋势回调",
        experimentUnknownStrategy: "策略 {id}",
        experimentLiveFixed: "实时固定 · 不可关闭",
        experimentReplayOnly: "仅回放候选",
        experimentUnregistered: "未注册；请关闭并保存以清理旧配置",
        experimentStrategyVersion: "版本 {version}",
        experimentEnableCandidate: "启用 ORB 候选策略",
        experimentSignalLanes: "信号道",
        experimentLane_cmb: "招行积存金",
        experimentLane_au9999: "Au99.99",
        experimentLane_xau: "XAU 折算",
        experimentOrbParameters: "ORB 核心参数",
        experimentOpeningRangeBars: "开盘区间 K 线数",
        experimentBreakoutBuffer: "突破 ATR 缓冲",
        experimentPullbackTolerance: "回调 ATR 容差",
        experimentSetupExpiryBars: "Setup 失效 K 线数",
        experimentOrderValidityBars: "订单有效 K 线数",
        experimentStopAtrMultiplier: "止损 ATR 倍率",
        experimentTargetAtrMultiplier: "止盈 ATR 倍率",
        experimentGrams: "建议克数",
        experimentRequireTrend: "要求趋势状态",
        experimentRequiredFactors: "必需因子 ID",
        experimentFactorMaxAgeHours: "因子最大年龄（小时）",
        experimentCostMatrix: "成本倍率：{values}",
        experimentParameterMatrix: "参数倍率：{values}",
        experimentAblationMatrix: "消融：{values}",
        experimentAblation_none: "完整规则",
        experimentAblation_without_regime_filter: "移除状态过滤",
        experimentPromotionPreset: "载入完整晋级矩阵",
        experimentReportStale: "当前报告与未保存的配置或运行条件不一致，以下结果仅代表上次运行。",
        experimentDays: "回放天数",
        experimentMode: "实验模式",
        experimentMode_diagnostic: "短窗诊断",
        experimentMode_walk_forward: "长期验证",
        experimentRun: "运行实验",
        experimentSaveRequired: "请先保存完全一致的实验配置，并启用至少一个已注册候选策略",
        experimentRunning: "实验运行中…",
        experimentEmpty: "暂无实验报告。",
        experimentReportSchema: "Schema：{value}",
        experimentReportGeneratedAt: "生成：{value}",
        experimentReportAsOf: "As-of：{value}",
        experimentReportStatus: "状态：{value}",
        experimentReportId: "实验：{value}",
        experimentFingerprint: "Fingerprint：{value}",
        experimentScenarios: "场景矩阵",
        experimentScenarioStrategy: "策略",
        experimentScenarioLane: "信号道",
        experimentScenarioCost: "成本倍率",
        experimentScenarioParameter: "参数倍率",
        experimentScenarioAblation: "消融",
        experimentScenarioStatus: "状态",
        experimentScenarioNet: "净结果（元）",
        experimentScenarioDrawdown: "最大回撤（元）",
        experimentScenarioOos: "OOS",
        experimentComparisons: "Control 比较",
        experimentComparisonDelta: "净结果差值（元）",
        experimentComparisonDrawdownDelta: "回撤差值（元）",
        experimentPromotion: "晋级审查",
        experimentPromotionSafe: "晋级状态由 Host 样本外准入规则推导；未通过时仅为实验诊断。",
        experimentPromotionCandidate: "{strategy}：{status}",
        experimentPromotionNotEligible: "不满足晋级条件",
        experimentPromotionEligible: "可申请进入候选，不代表已推荐",
        experimentPromotionReasons: "原因：{reasons}",
        experimentReason_scenario_matrix_incomplete: "场景矩阵不完整",
        experimentReason_promotion_matrix_not_exact: "晋级评估只接受固定的信号道、成本、参数与消融矩阵",
        experimentReason_signal_lane_matrix_incomplete: "晋级所需的 CMB、Au99.99、XAU 信号道矩阵不完整",
        experimentReason_cost_stress_matrix_incomplete: "晋级所需的 1 倍与 2 倍成本矩阵不完整",
        experimentReason_lane_baseline_missing: "缺少信号道基线",
        experimentReason_oos_not_validated: "未通过样本外验证",
        experimentReason_scenario_validation_incomplete: "部分场景未通过完整验证准入",
        experimentReason_control_comparison_missing: "缺少 control 比较",
        experimentReason_control_oos_not_validated: "control 的样本外验证未通过",
        experimentReason_dataset_basis_mismatch: "候选与 control 的数据集基准不一致",
        experimentReason_execution_basis_mismatch: "候选与 control 的执行规则基准不一致",
        experimentReason_candidate_not_better_than_control: "候选未稳定优于 control",
        experimentReason_walk_forward_required: "只有 walk-forward 运行可进入晋级评估",
        experimentReason_fold_windows_misaligned: "候选与 control 的样本外折叠窗口未对齐",
        experimentReason_per_fold_control_not_dominated: "候选未在每个样本外折叠同时支配 control",
        experimentReason_per_fold_benchmark_not_dominated: "候选未在每个样本外折叠同时优于全部内建基准",
        experimentReason_per_fold_cost_stress_failed: "候选未在每个成本压力折叠支配 control",
        experimentReason_cost_stress_unstable: "成本压力结果不稳定",
        experimentReason_cost_stress_non_monotonic: "成本升高时净结果反而改善，需核查执行账本",
        experimentReason_cost_stress_control_missing: "缺少同成本口径的 control 场景",
        experimentReason_cost_stress_control_not_validated: "同成本口径的 control 未通过样本外验证",
        experimentReason_cost_stress_not_better_than_control: "候选在成本压力下未优于同口径 control",
        experimentReason_ablation_matrix_incomplete: "消融矩阵不完整",
        experimentReason_ablation_oos_not_validated: "消融场景缺少完整样本外验证",
        experimentReason_ablation_not_supportive: "完整策略未在样本外收益与回撤上支配消融版本",
        experimentReason_ablation_not_applicable: "基础配置已关闭趋势状态过滤，该消融不适用",
        experimentReason_ablation_no_observed_contribution: "完整策略与消融版本结果完全相同，未观察到功能贡献",
        experimentReason_parameter_sensitivity_incomplete: "参数敏感性矩阵不完整",
        experimentReason_parameter_sensitivity_unstable: "参数扰动后的收益或回撤不稳定",
        experimentReason_factor_evidence_missing: "因子证据缺失",
        experimentReason_invalid_replay_report: "回放报告未通过完整性校验",
        experimentReason_scenario_attestation_mismatch: "回放证据与请求场景不一致",
        experimentReason_scenario_failed: "场景执行失败",
        experimentReason_point_in_time_ingestion_unavailable: "没有可证明在 K 线收盘前已入库的数据",
        experimentReason_au9999_cmb_execution_basis_unavailable: "缺少与 Au99.99 信号时点对齐的 CMB point-in-time 执行路径",
        experimentReason_xau_usdcny_point_in_time_unavailable: "缺少 XAU 与 USDCNY 的 point-in-time 联合数据",
        experimentReason_unknown_strategy: "策略未注册",
        experimentReason_unsupported_lane: "策略不支持该信号道",
        experimentReason_scenario_failed: "场景执行失败",
        experimentBenchmarkCapabilities: "统计/ML 基准能力",
        experimentBenchmarkUnavailable: "{id}：不可用（{reason}）",
        experimentReason_training_artifact_missing: "缺少训练产物",
        experimentReason_point_in_time_features_missing: "缺少 point-in-time 因子",
        experimentStatus_completed: "已完成",
        experimentStatus_partial: "部分完成",
        experimentStatus_unavailable: "不可用",
        experimentStatus_failed: "失败",
        experimentStatus_insufficient_data: "数据不足",
        experimentStatus_ready: "待运行",
        experimentStatus_unknown_strategy: "未知策略",
        experimentStatus_unsupported_lane: "不支持该信号道",
        experimentStatus_not_eligible: "不满足晋级条件",
        experimentStatus_eligible_to_apply: "可申请进入候选",
        experimentStatus_unknown: "未知",
        experimentOosSummary: "{completed}/{registered} 折 · {status}",
        experimentRunError: "实验运行失败：{error}",
        experimentPersistWarning: "实验已完成，但报告未持久化；重启后可能丢失：{error}",
        error_STRATEGY_REGISTRY_UNAVAILABLE: "策略目录当前不可用",
        error_STRATEGY_EXPERIMENTS_UNAVAILABLE: "策略实验服务当前不可用",
        error_EXPERIMENTS_DISABLED: "请先启用并保存策略实验",
        error_EXPERIMENT_SAVE_REQUIRED: "实验配置已变化，请先保存后再运行",
        error_EXPERIMENT_PERSIST_FAILED: "实验已完成，但结果未能持久化保存",
        error_STRATEGY_DISABLED: "所选候选策略尚未启用",
        error_EXPERIMENT_LANE_DISABLED: "所选信号道尚未启用",
        error_EXPERIMENT_TOO_LARGE: "实验场景超过配置上限",
        error_EXPERIMENT_ALREADY_RUNNING: "已有策略实验正在运行",
        error_BAD_EXPERIMENT_MODE: "实验模式无效",
        error_BAD_EXPERIMENT_DAYS: "回放天数必须是 1 至 30 的整数",
        error_BAD_EXPERIMENT_STRATEGY_IDS: "策略列表格式无效",
        error_BAD_EXPERIMENT_SIGNAL_LANES: "信号道列表格式无效",
        error_BAD_EXPERIMENT_AS_OF: "实验时点无效或位于未来",
        error_REPLAY_WALK_FORWARD_LANE_UNAVAILABLE: "长期 walk-forward 当前只支持具备完整 CMB 执行历史的信号道",
        error_STRATEGY_EXPERIMENT_CANCELLED: "实验已取消",
        error_BAD_STRATEGY_EXPERIMENT: "策略实验请求无效",
        statsTitle: "回放与长期验证（report v6）",
        statsHint: "按明确的 as-of 和当前冻结参数重建策略，由 ReplaySimulator 推进订单、成交、账本与估值。数据不足、代理路径、费用未核实或 OOS 门槛未满足时只显示探索性诊断。",
        statsDays: "统计天数",
        statsGenerate: "生成短窗诊断",
        statsValidate: "运行长期验证",
        statsGenerating: "正在生成统计…（逐日回放中，请稍候）",
        statsCached: "（缓存）",
        statsEmpty: "暂无报告，点击「生成统计」开始。",
        statsLegacyReport: "旧版 v{version} 使用旧执行假设，不可与 v5 比较，也不构成可执行业绩证据。请重新生成报告。",
        statsV5Banner: "基于 5 分钟数据的限价单模拟成交，不代表实际成交。单边历史会明确标记为合成代理。",
        statsV6Banner: "ReplaySimulator v6 使用显式 as-of、数据集与报告 fingerprint；秒级成交策略仅为低粒度敏感性场景，不代表真实排队或成交。",
        statsDatasetTitle: "回放数据集",
        statsDatasetId: "数据集：{id}",
        statsDatasetRange: "数据范围：{from} ~ {to}",
        statsDatasetHistory: "历史跨度：{months} 个月",
        statsDatasetBars: "5 分钟 K：{complete}/{total} 根完整",
        statsDatasetRecords: "point-in-time 记录：{count}",
        statsInputFingerprint: "输入 fingerprint：{value}",
        statsReportFingerprint: "报告 fingerprint：{value}",
        statsMetricsTitle: "验证指标",
        statsMetricSharpe: "Sharpe {value}",
        statsMetricSortino: "Sortino {value}",
        statsMetricCalmar: "Calmar {value}",
        statsMetricExposure: "暴露时间 {value}",
        statsMetricUtilization: "资金使用率 {value}",
        statsMetricDrawdown: "最大回撤 {value} 元（{rate}）",
        statsMetricDrawdownDuration: "回撤持续 {value} 小时",
        statsMetricTurnover: "换手金额 {value} 元",
        statsMetricProfitFactor: "Profit factor {value}",
        statsReturnInterval: "收益 block-bootstrap 95% 区间 [{low}, {high}]",
        statsWinInterval: "胜率 Wilson 95% 区间 [{low}, {high}]",
        statsOosTitle: "Walk-forward 样本外折",
        statsOosSummary: "状态 {status} · 已注册 {registered} 折 · 已完成 {completed} 折",
        statsOosInsufficient: "长期 point-in-time 数据不足，当前不能形成可验证的 OOS 结论。",
        statsFoldTrain: "训练窗口",
        statsFoldTest: "测试窗口",
        statsFoldSamples: "测试样本",
        statsFoldStatus: "状态",
        statsStatus_ready: "已就绪",
        statsStatus_completed: "已完成",
        statsStatus_partial: "部分完成",
        statsStatus_insufficient_data: "数据不足",
        statsStatus_failed: "失败",
        statsStatus_ok: "可用",
        statsStatus_unavailable: "不可用",
        statsBenchmarksTitle: "同口径基准",
        statsBenchmarkName: "基准",
        statsBenchmarkNet: "净结果（元）",
        statsBenchmarkReturn: "总收益率",
        statsBenchmarkDrawdown: "最大回撤",
        statsBenchmark_no_trade: "不交易",
        statsBenchmark_buy_and_hold: "买入持有",
        statsBenchmark_fixed_interval_dca: "固定节奏定投",
        statsBenchmark_simple_moving_average: "简单均线",
        statsReportVersion: "报告 v{version}",
         statsGeneratedAt: "生成时间：{time}",
         statsStrategy: "策略：{id} · {version}",
         statsVersions: "口径版本：指标 {calculation} · 数据 {data} · 执行 {execution} · 日历 {calendar}",
         statsExecution: "执行口径：{version} · {fill} · {ambiguity}",
         statsFillPolicy_next_bar_limit: "下一根完整 5 分钟限价",
         statsFillPolicy_next_open: "下一根完整 K 线开盘",
         statsFillPolicy_signal_close: "信号 K 线收盘（敏感性）",
         statsFillPolicy_delay_30s: "延迟 30 秒（需秒级证据）",
         statsFillPolicy_delay_60s: "延迟 60 秒（需秒级证据）",
         statsFillPolicy_delay_120s: "延迟 120 秒（需秒级证据）",
         statsAmbiguityPolicy_conservative_stop: "双触及按保守止损",
         statsAmbiguityPolicy_unknown: "双触及记为未知",
         statsEvidenceExploratory: "探索性诊断",
         statsEvidenceValidated: "验证结果",
         statsEvidenceUnavailable: "证据状态未知（旧报告）",
         statsValidationNotEligible: "未达到验证准入门槛；当前结果不是已验证策略或真实业绩",
         statsValidationReasons: "未满足项：{reasons}",
         statsValidationReason_long_term_history_not_available: "缺少至少 12 个月的长期历史",
         statsValidationReason_no_oos_validation: "尚无样本外滚动验证",
         statsValidationReason_cost_semantics_unverified: "费用语义尚未按产品协议核实",
         statsValidationReason_no_benchmark_comparison: "尚无基准比较",
         statsValidationReason_no_uncertainty_intervals: "尚无不确定性区间",
         statsValidationReason_dataset_manifest: "数据集 manifest 版本或 fingerprint 无效",
         statsValidationReason_dataset_integrity: "所选数据集包含被隔离的损坏分区",
          statsValidationReason_session_coverage: "至少一个交易日缺少开盘、收盘或内部预期 K 线槽位",
         statsValidationReason_minimum_history_months: "历史不足 12 个月",
         statsValidationReason_oos_registry: "OOS registry 版本、ID 或数据集绑定无效",
         statsValidationReason_oos_fold_integrity: "已完成 OOS 折的边界、样本、区间或 result fingerprint 无效",
         statsValidationReason_simulation_diagnostics: "模拟输入含无效、未来或冲突 frame",
         statsValidationReason_multiple_oos_folds: "已完成的样本外折不足 2 个",
         statsValidationReason_frozen_oos_parameters: "测试折参数未全部冻结",
         statsValidationReason_real_bid_ask_evidence: "真实 bid/ask 覆盖未达到完整验证要求",
         statsValidationReason_verified_cost_semantics: "费用语义尚未按产品协议核实",
         statsValidationReason_benchmark_comparison: "四类同口径基准不完整",
         statsValidationReason_uncertainty_intervals: "总体或 OOS 折不确定性区间不完整",
         statsValidationReason_proxy_or_unknown_execution: "执行路径含代理或未知 bid/ask",
         statsValidationReason_incomplete_sessions: "存在部分、跳过或失败交易日",
         statsCostAssumptions: "成本假设",
         statsCostFees: "显式费用：买入 {buy} / 卖出 {sell} 元/克",
         statsCostSlippage: "滑点：买入 {buy} / 卖出 {sell} 元/克",
         statsCostFallback: "合成路径：买入偏移 {buy} / 卖出偏移 {sell}；估算点差 {spread} 元/克",
         statsCostProxy: "CMB 单边历史代理点差：{spread} 元/克",
         statsCostUnverified: "费用语义尚未按产品协议核实",
         statsCostQuotedSpread: "真实 bid/ask 已含报价内点差，不重复加估算点差",
         statsCostUnavailable: "旧报告未保存成本假设",
         statsRealBidAskCoverage: "真实 bid/ask 覆盖 {rate}（{count}/{total} 根）",
         statsProxyBidAskCoverage: "代理 bid/ask 覆盖 {rate}（{count}/{total} 根）",
         statsUnknownBidAskCoverage: "未知 bid/ask 覆盖 {rate}（{count}/{total} 根）",
         statsCoverageUnavailable: "bid/ask 覆盖分类未知（旧报告）",
         statsCaveatUnknown: "未翻译的局限：{code}",
        statsCompleteDays: "完整时段 {count}",
        statsPartialDays: "部分时段 {count}",
        statsFillRate: "模拟成交率 {rate}",
        statsExpiryRate: "过期率 {rate}",
        statsAmbiguousBars: "双触及歧义 {count}",
        statsBidAskCoverage: "真实双边覆盖 {rate}",
         statsAverageDelay: "平均模拟延迟 {ms} 毫秒",
        statsUnknown: "未知",
        valuationUnavailable: "无法估值",
        statsFailed: "生成失败：{error}",
        statsPersistWarning: "回放已完成，但部分报告未持久化；重启后可能丢失：{error}",
        statsCancelled: "已取消（连接断开）",
        statsWindow: "窗口：{from} ~ {to}",
        statsLane: "信号道：{lane}",
        statsLaneCmb: "招行积存金",
        statsLaneAu9999: "Au99.99",
        statsDaysEvaluated: "覆盖交易日 {evaluated}/{requested}",
        statsSteps: "总评估步数 {count}",
        statsEvents: "独立信号样本 {count} 条",
        statsUnexecutedCount: "账户约束未执行 {count} 条",
        statsUnexecutedCountUnavailable: "账户约束未执行：旧报告未知",
        statsBlocked: "数据不足步占比 {ratio}",
        statsPartialFailures: "{count} 个交易日数据拉取失败：{detail}",
        statsNoEvents: "窗口内无方向性信号事件。",
        statsOverallTitle: "连续账户表现（期初 0 克）",
        statsCardTotalNet: "模拟净结果（元）",
        statsCardTotalNetHint: "从 0 克开始，仅执行触及限价且未过期的模拟订单；剩余持仓按最后可执行卖价、显式费用和滑点估值。",
        statsCardRealizedNet: "已实现净收益（元）",
        statsCardRealizedNetHint: "已完成卖出相对其买入成本和费用产生的收益；未卖出仓位不计入此项。",
        statsCardUnrealizedNet: "期末持仓收益（元）",
        statsCardUnrealizedNetHint: "剩余持仓按期末可卖价、卖出费用和滑点假设平仓后的收益。",
        statsCardEndingPosition: "期末模拟持仓（克）",
        statsCardEndingPositionHint: "回放结束时尚未卖出的克数；它已计入期末模拟净收益。",
        statsDetails: "明细",
        statsDetailsTitle: "连续账户订单与未执行信号",
        statsDetailsHint: "订单表展示模拟限价单生命周期；未执行信号表展示策略条件已确认、但因仓位上限等账户约束没有创建订单的时点。未执行信号不计入成交率、现金流或收益。",
        statsDetailsRefresh: "刷新",
        statsDetailsLoading: "正在读取账户明细…",
        statsDetailsLoadError: "无法读取账户明细：{error}",
        statsDetailsEmpty: "当前报告没有可显示的订单或未执行信号。",
        statsDetailsUnavailable: "该旧报告未保存账户明细。请重新生成统计后再查看。",
        statsOrdersTitle: "模拟订单",
        statsUnexecutedTitle: "未执行策略信号",
        statsUnexecutedHint: "这些信号通过了策略确认与冷却，但没有进入连续账户订单，也没有产生模拟成交。明细最多保留最近 200 条，摘要计数保留窗口总数。",
        statsUnexecutedUnavailable: "当前报告生成于此诊断加入之前，无法判断是否存在账户约束未执行信号；请重新生成统计。",
        statsSignalNotExecuted: "未执行",
        statsUnexecutedSignalPrice: "建议限价（元/克）",
        statsUnexecutedPosition: "当时持仓 / 上限（克）",
        statsUnexecutedReason: "未执行原因",
        statsUnexecutedReason_position_limit: "已达仓位上限",
        statsDetailsTime: "时间",
        statsDetailsStatus: "订单状态",
        statsDetailsAction: "策略动作",
        statsOrderFilled: "已模拟成交",
        statsOrderExpired: "已过期",
        statsOrderPending: "等待中",
        statsOrderReplaced: "已替换",
        statsDetailsPrice: "模拟成交价（元/克）",
        statsDetailsGrams: "成交克数",
        statsDetailsFee: "手续费及滑点（元）",
        statsDetailsPositionBefore: "成交前持仓（克）",
        statsDetailsPositionAfter: "成交后持仓（克）",
        statsDetailsCashFlow: "现金流（元）",
        statsDetailsRealizedNet: "已实现收益（元）",
        statsDetailsSummary: "期末持仓 {grams} 克，期末可卖价 {price} 元/克；已实现 {realized} 元，期末持仓收益 {unrealized} 元，合计 {total} 元。",
        statsDetailsTipTime: "信号时点、最早可执行时点或最终模拟成交/过期时点。不会使用信号 K 线自身成交。",
        statsDetailsTipAction: "触发这笔模拟成交的策略规则动作。",
        statsDetailsTipPrice: "策略建议的招行积存金成交价；买入和卖出使用各自的报价口径。",
        statsDetailsTipGrams: "本笔成交的克数，受当前“最大克数”和分档策略限制。",
        statsDetailsTipFee: "本笔按当前买入或卖出手续费及滑点计算的成本。",
        statsDetailsTipPosition: "连续账户在这笔成交执行前后的模拟持仓。",
        statsDetailsTipCashFlow: "买入支付现金为负，卖出收到现金为正；不等于收益。",
        statsDetailsTipRealizedNet: "卖出收到的净现金减去对应持仓的含买入成本；买入尚未实现收益。",
        statsParamsTitle: "本次回放参数：",
        statsParamConfirmBars: "连续确认{n}根",
        statsParamScoreThreshold: "综合评分≥{n}",
        statsParamCooldown: "冷却{m}分钟",
        statsParamCloseOn: "收盘前平仓 开",
        statsParamCloseOff: "收盘前平仓 关",
        statsGroupEntryTitle: "信号质量：做多入场（独立样本）",
        statsGroupEntryHint: "每行是该入场信号的独立事后样本（元/克，含费用、价差和滑点），用于观察信号质量；不属于顶部连续账户的累计收益，不能相加。",
        statsGroupExitTitle: "信号质量：卖出与减仓（独立样本）",
        statsGroupExitHint: "每行是该卖出信号相对继续持有到当日时段末的独立差异（元/克）；正值代表离场更优。它不属于顶部连续账户的累计收益。",
        statsTableAction: "动作",
        statsTableCount: "触发次数",
        statsTableTargetHit: "目标触及率（执行价/代理）",
        statsTableStopHit: "止损触及率（执行价/代理）",
        statsTableMfe30: "MFE30m 均值（元/克）",
        statsTableMae30: "MAE30m 均值（元/克）",
        statsTableHoldNet: "持到时段末净益（元/克）",
        statsTableFallMfe30: "30m内续跌均值（元/克）",
        statsTableReboundMae30: "30m内反弹均值（元/克）",
        statsTableDrift60: "60m后漂移均值（元/克）",
        statsTableExitSaving: "卖出优于持有（元/克）",
        statsTipCount: "该信号在回放窗口内的触发次数（空仓/持仓两条模拟通道合计）。",
        statsTipTargetHit: "触发后至当日时段结束，价格曾触及该信号目标价的事件占比。",
        statsTipStopHit: "触发后至当日时段结束，价格曾跌破止损价的事件占比。",
        statsTipMfe30: "触发后30分钟内价格朝有利方向的最大偏移均值；入场信号为上涨幅度，卖出信号为继续下跌幅度。",
        statsTipMae30: "触发后30分钟内价格朝不利方向的最大偏移均值；入场信号为下跌幅度，卖出信号为反弹幅度。",
        statsTipDrift60: "离场后60分钟收盘价相对信号价的漂移均值；负值＝卖出后价格走低，说明离场正确。",
        statsTipHoldNet: "按信号价买入并持有到当日时段末的净收益均值（已扣双边手续费、估算价差与滑点）；正值代表该入场信号事后赚钱。",
        statsTipExitSaving: "在信号处离场、对比继续持有到时段末的平均净差异（同口径扣费）；正值代表离场优于持有。",
        statsConfidenceTitle: "规则强度分与目标触及率（入场事件）",
        statsCaveatsTitle: "统计口径与局限",
        caveat_lane_au9999_only: "统计仅在 Au99.99 信号道进行（Eastmoney 历史）：招行实时报价没有公开 K 线，该口径结论不能直接套用于招行实盘；如需实盘口径请用默认的积存金道回放。",
        caveat_lane_cmb_persisted_bars: "统计在招行积存金信号道进行：数据来自本机持久化的积存金报价序列（实时轮询 + 手动补录），客户卖出价按固定价差 5 元/克合成；回放深度受本地数据积累限制，最贴近招行实盘口径。",
        caveat_minute_coverage_from_5m: "分钟级数据覆盖率由真实 5 分钟 K 线拆分推导，5 分钟内的微观缺口不可见；数据门槛语义与实盘一致但粒度更粗。",
        caveat_synthetic_lane_sampling: "合成/低采样道保真度有限（如国际道每根 bar 样本 ≤2 个），其统计精度低于实盘轮询，勿将低保真道结论当作交易依据。",
        caveat_history_depth_limited: "回放深度受历史数据限制（Au99.99 道约 10+ 个交易日的 5m K 线；积存金道受本地滚动窗口约束），无数据的天数会计入 daysSkippedNoData 如实跳过。",
        caveat_continuous_zero_position: "顶部连续账户从 0 克开始，仅在后续 K 线触及限价时模拟成交；期末持仓按最后可执行卖价及成本估值。",
        caveat_next_bar_limit_fills: "建议单最早从下一根完整 5 分钟 K 线判断限价触及；未触及或超过有效期不成交。OHLC 无法恢复真实队列、部分成交或秒级路径。",
        caveat_conservative_ambiguous_bars: "同一 K 线同时触及目标和止损时标记为歧义，默认按多头止损先到的保守路径统计，并保留最佳/最差区间。",
        caveat_unknown_ambiguous_bars: "同一 K 线无法证明目标与止损的先后顺序，当前场景将该成交结果保留为 unknown。",
        caveat_sensitivity_fill_policy: "当前报告使用非默认成交时点，只能用于敏感性比较；5 分钟数据不能证明秒级路径或队列位置。",
        caveat_complete_session_only: "默认只纳入已到配置收盘时点且数据到达时段尾部的完整交易日；部分日仅在显式包含时按截至时点单列。",
        caveat_two_simulated_passes: "独立信号表每天按空仓与持仓两条诊断通道评估；它们不属于顶部连续账户。",
        caveat_past_performance_advisory: "历史命中率不代表未来表现；本报告仅为策略工程诊断，非投资建议。",
         enumStatus_analysis_ready: "分析完成",
         enumStatus_insufficient_data: "数据不足",
         enumStatus_stale: "行情过期",
         enumStatus_invalid: "输出无效",
         enumBias_bullish: "看涨",
         enumBias_bearish: "看跌",
         enumBias_neutral: "中性",
         enumBias_unknown: "未知",
         enumHorizon_intraday: "日内",
         enumHorizon_swing: "波段",
         enumAction_wait: "等待",
         enumAction_observe: "观察",
         enumAction_risk_reduce: "降低风险",
         enumAction_manual_review: "人工复核",
         enumAction_buy_setup: "买入准备",
         enumAction_add_position: "补仓",
         enumAction_reduce_position: "减仓",
         enumAction_sell_take_profit: "止盈卖出",
         enumAction_sell_target_trail: "目标回撤卖出",
         enumAction_sell_time_stop: "时间止损",
         enumAction_sell_trailing: "回撤卖出",
         enumAction_sell_stop: "止损卖出",
         enumAction_sell_weakness: "走弱减仓",
         enumAction_close_by_session_end: "收盘前平仓",
         enumAction_market_closed: "休市",
         enumAction_no_data: "暂无数据",
         enumAction_no_budget: "已达上限",
         enumAction_data_incomplete: "数据不完整",
         enumAction_data_stale: "数据过期",
         enumConfidence_low: "低",
         enumConfidence_medium: "中",
         enumConfidence_high: "高",
        modelsLoading: "正在读取 Harness 模型目录…",
        noModels: "暂无可用模型",
        selectedModelUnavailable: "已选模型当前不可用，请重新选择后保存。",
        providerFailures: "部分 Provider 目录读取失败",
        runAnalysis: "立即分析",
        analysisRunning: "分析中…",
        analysisSuccess: "分析完成",
        analysisBlocked: "数据质量门控未通过，未调用模型",
        analysisBias: "偏向",
        analysisAction: "动作",
        analysisHorizon: "周期",
        analysisConfidence: "置信度",
        analysisEvidence: "证据",
        analysisSupport: "支撑",
        analysisResistance: "阻力",
        analysisWarnings: "数据警告",
        analysisSummary: "简要解读",
        analysisFailed: "分析失败：{error}",
        analysisQueryId: "查询 ID",
        viewAnalysisLogs: "查询日志",
        queryLogsTitle: "模型分析查询日志",
        queryLogsDisclaimer: "模型解释，不是交易指令；日志内容已脱敏。",
        filterStatus: "状态",
        filterProvider: "Provider",
        filterModel: "Model",
        filterFrom: "开始时间",
        filterTo: "结束时间",
        filterAll: "全部",
        status_running: "运行中",
        status_success: "成功",
        status_error: "失败",
        status_aborted: "已取消",
        status_invalid: "输出无效",
        logRequestedAt: "请求时间",
        logSnapshotAsOf: "行情快照",
        logRuleAction: "规则动作",
        logProviderModel: "模型",
        logQueryId: "查询 ID",
        logUsage: "Token 用量",
        logQuality: "数据质量",
        logInput: "模型输入", logResult: "结构化结果",
        logModelOutput: "模型原始输出（脱敏）",
        logNoOutput: "没有可记录的模型输出",
        logError: "错误",
        selectLog: "选择一条查询查看详情",
        copyJson: "复制脱敏 JSON",
        jsonCopied: "已复制脱敏 JSON",
        loadMore: "加载更多",
        noMoreLogs: "没有更多记录",
        analysisLogUnavailable: "分析日志当前不可用",
        error_ANALYSIS_DISABLED: "模型分析未启用",
        error_LLM_UNAVAILABLE: "Harness 模型运行时不可用",
        error_MODEL_NOT_SELECTED: "请先选择 Provider 和 Model",
        error_MODEL_UNAVAILABLE: "所选模型当前不可用",
        error_SNAPSHOT_CHANGED: "行情快照已更新，请重新分析",
        error_DATA_STALE: "行情数据已过期",
        error_DATA_QUALITY_BLOCKED: "数据质量门控未通过",
        error_WARMUP_NOT_READY: "指标数据仍在预热",
        error_INSTRUMENT_MISMATCH: "行情品种口径不匹配",
        error_ANALYSIS_TIMEOUT: "模型分析超时",
        error_ANALYSIS_ABORTED: "模型分析已取消",
        error_INVALID_JSON: "模型未返回严格 JSON",
        error_INVALID_SCHEMA: "模型结果不符合结构约束",
        error_MAX_TOKENS: "模型输出达到 token 上限",
        error_ANALYSIS_FAILED: "模型分析失败",
        error_BAD_RESPONSE: "宿主返回无效响应",
        error_GENERIC_NOT_FOUND: "通用 Webhook 不存在",
        error_SYSTEM_DISABLED: "宿主机系统通知未启用",
        error_BAD_CHANNEL: "未知通知渠道",
        error_WEBHOOK_NOT_CONFIGURED: "Webhook 未配置或未启用",
        error_WEBHOOK_URL_BLOCKED: "Webhook 目标不符合公网安全策略",
        error_WEBHOOK_HTTP_ERROR: "Webhook 返回非成功状态",
        error_NOTIFY_FAILED: "测试消息发送失败",
        error_REPLAY_REPORT_CHANGED: "报告已更新，请关闭明细后重新打开",
        error_SETTINGS_TRANSPORT_UNAVAILABLE: "设置服务当前不可用",
        error_SETTINGS_WRITE_FAILED: "设置保存失败",
        error_STALE_CONFIG: "配置已被其他窗口更新，请确认后重试",
        error_UNKNOWN_CONFIG_KEY: "未知配置项：Host 可能尚未重启以加载新配置字段",
        error_BAD_CONFIG: "配置格式无效",
        error_BAD_REVISION: "配置版本号无效",
        error_STORAGE_FAILED: "配置写入磁盘失败",
        error_SYSTEM_UNSUPPORTED: "当前系统不支持打开通知设置",
        error_SYSTEM_SETTINGS_FAILED: "无法打开系统通知设置",
        error_UNAUTHORIZED: "会话已失效，请刷新页面",
        openSystemSettings: "打开系统通知设置",
        sidebarPriceTitle: "侧边栏金价",
        sidebarPriceHint: "在侧边栏「黄金看板」入口右侧显示所选金价的实时值。",
        sidebarPriceField: "展示金价",
        sidebarPriceDomestic: "国内金价 Au99.99",
        sidebarPriceXAU: "国际金价 XAU",
        sidebarPriceCMB: "招行积存金",
        systemSettingsOpened: "已打开系统通知设置",
        error_MANUAL_CMB_FAILED: "分钟价补充失败",
        error_REPLAY_STATS_FAILED: "回放报告生成失败",
        sellAll: "全部",
        validUntil: "建议有效期至",
          pendingOrder: "挂单跟踪",
          orderStanding: "监控中：等待成交或失效，不会反复提示撤单",
          // ── plan-05 B.6: rule-reason labels + analysis enum hints folded in
          // so the dictionary parity test covers every user-facing string.
        reason_quote_missing: "缺少行情",
        reason_market_closed: "休市",
        reason_stale_quote: "行情过期",
        reason_target_reached: "达到目标",
        reason_configured_spread_drift: "配置手续费与实时卖出价偏离",
        reason_target_armed_watching: "已达目标，观察回撤",
        reason_target_partial_sell: "首触目标减仓",
        reason_target_trail_hit: "回落触发回撤线",
        reason_target_trail_timeout: "目标后未创新高，超时了结",
        reason_pre_target_timeout: "武装前超时未触目标",
        reason_daily_trend_filter_not_met: "日线趋势过滤未满足",
        reason_stop_reached: "触发止损",
        reason_session_ending: "临近收盘",
        reason_rsi_overbought: "5分钟 RSI 超买",
        reason_bearish_bar: "5分钟阴线走弱",
        reason_reduce_on_weakness: "走弱减仓",
        reason_break_below_sma20_with_profit: "5分钟跌破 SMA20 且有浮盈",
        reason_trend_ema20_up: "10/30/60分钟 EMA20 向上",
        reason_near_support: "5分钟接近支撑",
        reason_near_lower_band: "5分钟接近布林下轨",
        reason_rsi_rebound: "5分钟 RSI 回升",
        reason_trigger_not_confirmed: "5分钟入场条件未确认",
        reason_trend_filter_not_met: "10/30/60分钟趋势过滤未满足",
        reason_no_budget: "已达投入上限",
        reason_target_band_add: "按目标仓位区间补仓",
        reason_target_band_reduce: "按目标仓位区间减仓并保留底仓",
        reason_already_light_position: "已处于轻仓区间，不再重复减仓",
        reason_position_limit: "已达仓位上限，信号未执行",
        reason_max_grams: "最大克数约束",
        reason_max_amount_reached: "已达最大名义金额",
        reason_max_risk_per_trade: "单笔风险预算不足",
        reason_max_daily_loss: "已达当日损失上限",
        reason_max_weekly_loss: "已达当周损失上限",
        reason_max_drawdown: "已达最大回撤上限",
        reason_liquidity_cap: "受单笔流动性上限约束",
        reason_max_adds_per_setup: "已达同一 setup 加仓次数上限",
        reason_max_adds_per_day: "已达单日加仓次数上限",
        reason_min_add_price_improvement: "再次加仓的价格改善不足",
        reason_min_add_price_unavailable: "缺少上一笔加仓价格，无法核验价格改善",
        reason_post_fill_cooldown: "成交后冷却中",
        reason_risk_budget_unconfigured: "预算模式尚未配置现金风险预算",
        reason_ledger_unavailable: "风险账本版本不可用，新增买入已关闭",
        reason_risk_per_gram_unavailable: "无法计算每克风险",
        reason_risk_budget_too_small: "剩余风险预算不足 0.01 克",
        reason_execution_ask_unavailable: "缺少可执行买入价",
        reason_risk_budget_sized: "按风险预算约束建议规模",
        reason_consecutive_loss_derisk: "连续亏损后建议规模已降档",
        reason_cooldown_active: "同方向建议冷却中",
        reason_signal_confirming: "信号确认中（连续确认）",
        reason_score_not_enough: "信号强度未达阈值",
        reason_spread_alert: "内外盘价差异常",
        reason_signal_lane_degraded: "信号源降级观察中",
        reason_weakness_rsi_overbought: "5分钟 RSI 超买走弱",
        reason_bearish_engulfing: "5分钟阴线吞没",
        reason_long_upper_shadow: "5分钟长上影线",
        reason_data_stale: "数据过期",
        reason_data_incomplete_5m: "5分钟数据不足",
        reason_data_incomplete_10m: "10分钟数据不足",
        reason_data_incomplete_30m: "30分钟数据不足",
        reason_data_incomplete_60m: "60分钟数据不足",
        reason_wait: "等待",
        reason_observe: "观察",
        reason_risk_reduce: "降低风险",
        reason_manual_review: "人工复核",
        reason_insufficient_data: "数据不足",
        reason_stale: "数据过期",
        reason_invalid: "数据无效",
        reason_analysis_ready: "分析完成",
        reason_suggestedOrder: "建议委托单",
        hint_Bias_bullish: "短期偏强，价格可能继续上行",
        hint_Bias_bearish: "短期偏弱，价格可能继续下行",
        hint_Bias_neutral: "多空力量接近，方向尚不明确",
        hint_Bias_unknown: "当前数据不足以判断方向",
        hint_Action_wait: "暂不操作，等待更明确信号",
        hint_Action_observe: "保持观察，不急于行动",
        hint_Action_risk_reduce: "适当降低仓位或收紧风险",
        hint_Action_manual_review: "建议人工复核后再决定",
        hint_Horizon_intraday: "适合日内短线视角",
        hint_Horizon_swing: "适合波段/中期视角",
        hint_Confidence_low: "可靠性较低，仅作参考",
        hint_Confidence_medium: "有一定参考价值",
        hint_Confidence_high: "信号较为明确",
        evidence_trend_ema20_up: "10/30/60m EMA20 {values} ↑",
        evidence_trend_filter_not_met: "10/30/60m EMA20 {values}",
        evidence_near_support: "5m 支撑 {value}",
        evidence_near_lower_band: "5m 布林下轨 {value}",
        evidence_rsi_rebound: "5m RSI {value}",
        evidence_break_below_sma20_with_profit: "5m 收盘<SMA20 {value}",
        evidence_bearish_bar: "5m 阴线",
        evidence_target_band_add: "目标仓位约 {value}g",
        evidence_target_band_reduce: "目标保留约 {value}g",
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
        cmbEstimate: "CMB Accumulated Gold",
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
        expand: "Expand",
        copy: "Copy order",
        copied: "Copied",
        riskNote: "Technical reference, not investment advice",
        breakeven: "Breakeven",
        targetPrice: "Sell target",
        stopPrice: "Stop level",
        targetTrailLine: "Trail exit line",
        grams: "g",
        position: "Position",
        pnl: "Fee-adjusted P&L",
        action_buy_setup: "Buy opportunity spotted!",
        action_add_position: "Time to add a bit?",
        action_reduce_position: "Consider trimming some",
        action_sell_take_profit: "Target reached — consider selling!",
        action_sell_target_trail: "Falling back from target — consider selling at the trail line",
        action_sell_time_stop: "Held too long without reaching target — consider exiting",
        action_sell_trailing: "Pullback detected — protect your profit",
        action_sell_stop: "Stop hit — manage risk",
        action_sell_weakness: "Momentum fading — consider reducing",
        action_close_by_session_end: "Session ending soon — consider closing",
        action_wait: "No opportunity yet",
        action_market_closed: "Market is closed",
        action_no_data: "Waiting for quotes",
        action_no_budget: "Position limit reached",
        action_data_incomplete: "Data incomplete — no suggestion for now",
          action_cancel_order: "Previous order suggestion is no longer valid — cancel any unfilled order",
          action_order_updated: "Order suggestion updated — follow the new suggestion",
        panel: "Gold Board",
        tablistLabel: "Gold Board pages",
        tab_overview: "Overview",
        tab_trading: "Trading",
        tab_strategy: "Strategy & replay",
        tab_analysis: "Analysis",
        tab_data: "Data",
        tab_settings: "Settings",
        autoRefresh: "Refresh every 10s",
        platformDesktop: "Desktop",
        platformWeb: "Web",
        loadFailedShort: "Load failed",
        renderError: "The Gold Board page failed to render",
        renderErrorHint: "Retry; if it keeps failing, check the console for details.",
        renderErrorDetails: "Error details",
        editPosition: "Edit position",
        resetPosition: "Reset position",
        noPosition: "No position recorded yet.",
        signalLane: "Signal lane",
        historicalRecords: "Historical records",
        dataDisclaimer: "Public market data may be delayed or incomplete",
        chartOpen: "Open",
        chartHigh: "High",
        chartLow: "Low",
        chartLast: "Last",
        noTrend: "No intraday trend data yet",
        copyOrder: "Copy order",
        ledgerHint: "Bounded read-only setup / decision / order projection; blocked signals are recorded as not_executed.",
        ledgerBlocked: "Not executed",
        discard: "Discard",
        saveConflict: "The config changed in another window: your draft is kept; review it and save again.",
        lane_cmb: "CMB accumulated gold",
        lane_au9999: "Au99.99",
        lane_xau: "International gold",
        lane_unknown: "Unknown",
        riskMode_fixed_grams: "Fixed grams",
        riskMode_budget: "Risk budget",
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
        riskTitle: "Risk budget & add gates",
        riskHint: "Fixed-gram mode keeps the existing staged sizing. Budget mode takes the smallest size allowed by ATR, executable spread, fees, slippage, and available risk budget.",
        riskMode: "Sizing mode",
        riskModeFixedGrams: "Fixed grams",
        riskModeBudget: "Risk budget",
        referenceEquityCny: "Reference equity (CNY)",
        referenceEquityHint: "Used only for risk ratios; this is not a real account balance.",
        maxAmountCny: "Max nominal amount (CNY)",
        maxRiskPerTradeCny: "Max risk per trade (CNY)",
        maxDailyLossCny: "Max daily loss (CNY)",
        maxWeeklyLossCny: "Max weekly loss (CNY)",
        maxDrawdownCny: "Max drawdown (CNY)",
        volatilityTarget: "ATR risk multiplier",
        volatilityTargetHint: "Stop distance uses 5-minute ATR times this multiplier, floored by spread and slippage buffers.",
        liquidityCapGrams: "Per-order liquidity cap (g)",
        maxAddsPerSetup: "Max adds per setup",
        maxAddsPerDay: "Max adds per day",
        minAddPriceImprovement: "Minimum price improvement for another add (CNY/g)",
        consecutiveLossDeRisk: "Consecutive-loss de-risk threshold",
        zeroDisablesGate: "A value of 0 disables that constraint. Reference equity is only a risk-calculation baseline.",
        riskGateOpen: "New-buy gate open",
        riskGateBlocked: "New buys blocked",
        riskGateProtectiveExitAllowed: "Protective sells remain allowed",
        riskDailyLoss: "Daily loss {value} CNY",
        riskWeeklyLoss: "Weekly loss {value} CNY",
        riskDrawdown: "Current drawdown {value} CNY",
        riskAddsToday: "Adds today {value}",
        riskSetupAdds: "Adds in active setup {value}",
        riskDailyLossLabel: "Daily loss",
        riskWeeklyLossLabel: "Weekly loss",
        riskDrawdownLabel: "Current drawdown",
        riskAddsTodayLabel: "Adds today",
        riskSetupAddsLabel: "Adds in active setup",
        riskLedgerCounts: "Decisions {decisions} · orders {orders} · not executed {blocked}",
        riskActiveSetup: "Active setup: {id}",
        riskNoActiveSetup: "No active setup",
        riskEvidenceHint: "Losses and fills come from the local advisory ledger and user position confirmations. They are risk estimates, not real account statements. Daily/weekly loss and drawdown include realized losses from confirmed sells, so they remain visible while flat; closing a position does not reset today's budget — it resets at 00:00 Beijing time.",
        riskNominalAmount: "Nominal amount",
        riskStopDistance: "Stop distance",
        riskPerGram: "Worst-case risk per gram",
        riskWorstCaseLoss: "Worst-case loss",
        riskAvailableBudget: "Available risk budget",
        riskBudgetRatio: "Reference-equity ratio",
        riskUnknown: "Unknown",
        ledgerTitle: "Risk gates & signal ledger",
        ledgerDetails: "View ledger",
        ledgerRefresh: "Refresh ledger",
        resetLedger: "Reset local position & ledger",
        resetConfirmText: "This clears the local position, advisory ledger, pending order and drawdown/daily-loss totals. It never touches your CMB account and cannot be undone.",
        resetConfirm: "Confirm reset",
        resetCancel: "Cancel",
        ledgerEmpty: "No setup, decision, or order records yet",
        ledgerOrders: "Advisory order lifecycle",
        ledgerDecisions: "Active and suppressed decisions",
        ledgerTime: "Time",
        ledgerStatus: "Status",
        ledgerAction: "Action",
        ledgerSize: "Grams / position",
        ledgerPrice: "Suggested price / risk budget",
        ledgerIds: "Setup / Decision / Order ID",
        ledgerReason: "Reason",
        ledgerStatus_active: "Active signal",
        ledgerStatus_pending: "Pending confirmation",
        ledgerStatus_filled: "Fill confirmed by user position",
        ledgerStatus_expired: "Expired/cancelled",
        ledgerStatus_replaced: "Replaced",
        ledgerStatus_not_executed: "Blocked by gate; not executed",
        feeTitle: "Explicit fees outside quote (CMB)",
        buyFee: "Explicit buy fee (CNY/g)",
        sellFee: "Explicit sell fee (CNY/g)",
        feeTotal: "Round trip",
        deriveSellFromFee: "Sell price = buy price − fee (ignore live sell price)",
        deriveSellFromFeeTip: "When on, the sell price is derived from the live buy price minus the sell fee above; execution, risk and the ledger stop charging that fee a second time. Change the fee here when the bank changes it. When off, the live CMB bid/ask is used as-is.",
        deriveSellFromFeeActive: "The fee is already inside the derived sell price and is not charged again",
        cmbTitle: "CMB Accumulated Gold price",
        cmbBuySpread: "Buy spread (CNY/g, fallback)",
        cmbSellSpread: "Sell spread (CNY/g, fallback)",
        cmbHint: "Prefers live CMB customer buy/sell prices from the CMB API; falls back to the international gold price converted at the exchange rate plus spread when unavailable. Always check the CMB app.",
        cmbSpreadSourceLabel: "Current spread source",
        cmbSpreadSourceLive: "Live CMB quote",
        cmbSpreadSourceDynamic: "Dynamic bid/ask estimate (median of {count} live samples)",
        cmbSpreadSourceLegacy: "Legacy mid-offset estimate ({count} old samples)",
        cmbSpreadSourceStatic: "Static configured spread (fewer than {count} samples)",
        manualPrevCloseTitle: "Manual prev close (today)",
        manualPrevCloseHint: "Leave blank to use the automatic value; applies to today only and clears automatically at Beijing midnight.",
        manualCmbTitle: "Manually add today's CMB minute prices",
        manualCmbHint: "The list below shows today's missing minutes up to now. Enter a price for each minute you want to fill; existing bars are never overwritten.",
        manualCmbSubmit: "Add filled prices",
        manualCmbSending: "Adding…",
        manualCmbAdded: "Added {added}, skipped {skipped}.",
        manualCmbMissingLoading: "Loading today's missing minutes…",
        manualCmbMissingNone: "No missing minute prices today",
        manualCmbPricePlaceholder: "Price",
        strategyTitle: "Intraday signal parameters",
        minProfit: "Min target profit (CNY/g)",
        maxLoss: "Max acceptable loss (CNY/g)",
        slippage: "Slippage estimate (CNY/g)",
        estSpread: "Fallback minimum spread (CNY/g)",
        rsiOversold: "RSI oversold threshold",
        rsiOverbought: "RSI overbought threshold",
        atrFactor: "ATR target factor",
        nearSupportPct: "Near-support threshold (%)",
        minRemainGrams: "Min base position (g)",
        signalCooldownMinutes: "Same-direction cooldown (min)",
        confirmBars: "Confirmation bars",
        scoreThreshold: "Signal score threshold",
        closeBySessionEnd: "Force close before session end",
        closeBySessionEndTip: "Off by default: the last 30 minutes no longer fixedly suggest selling (no forced intraday close) — holdings keep following the regular take-profit/stop/weakness signals. Turn on to restore full-close suggestions before the session ends.",
        orderRepricePct: "Order drift cancel threshold (%)",
        targetTrailPerGram: "Target retrace (CNY/g, 0 = off)",
        targetPartialRatio: "Sell this share at target (0–0.9)",
        targetTrailBars: "Max 5m bars without a new high",
        requirePriceAboveEma60: "Entry requires price above 60m EMA20",
        requirePriceAboveEma60Tip: "When on, a 5m entry also requires the current price to be above the 60m EMA20 — filters long entries inside a downtrend.",
        requireDailyUptrend: "Entry requires daily close above a rising EMA20",
        requireDailyUptrendTip: "When on, a long entry also requires the last completed daily bar to close above its EMA20 with that EMA20 rising. Missing daily history fails closed (no buy). Filters longs inside a daily downtrend.",
        maxBarsBeforeTarget: "Max 5m bars held before target (0 = off)",
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
        webhookSecretBadge: "Configured",
        webhookSecretClear: "Clear secret",
        webhookEnabled: "Enable this channel",
        webhookTemplate: "Message template (optional)",
        webhookTemplateHint: "Placeholders: {{action}} {{instrument}} {{price}} {{cmbPrice}} {{target}} {{grams}} {{time}}",
        test: "Send test",
        testSending: "Sending…",
        testOk: "Test message sent",
        systemTestOk: "Test command executed; if no banner appears, check system notification permission",
        testFailed: "Test failed: {error}",
        generic: "Generic webhooks",
        genericAdd: "Add",
        genericRemove: "Remove",
        genericName: "Name",
        genericDefaultName: "Webhook {n}",
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
        sourceCircuitOpen: "Circuit open",
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
        sourceSuccessRate: "Success {rate}",
        sourceLatency: "Latency P50 {p50}ms / P95 {p95}ms",
        sourceFallbacks: "{count} fallback source(s) available",
        sourceFailureDuration: "Failing continuously for {minutes} minute(s)",
        sourceExecutionCoverage: "Real bid/ask {real} · proxy {proxy} · synthetic {synthetic}",
        sourceGapCount: "{count} historical gap(s)",
        noData: "No quote data",
        reason: "Why",
        planTitle: "Current suggestion",
        dataCoverage: "Data coverage",
        coverageEffective: "Effective {effective}/{window} minutes",
        coverageGap: "Largest gap {minutes} minutes",
        coverageReanchored: "Re-anchored after the latest gap",
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
        analysisTitle: "Model & analysis",
        analysisHint: "Uses a configured Harness model to explain completed indicators and rule results. Analysis can still be invoked when data-quality gates fail; the model must report insufficient/stale/invalid status and cannot issue trading instructions.",
        analysisEnabled: "Enable model analysis",
        analysisProvider: "Provider",
        analysisModel: "Model",
        analysisReasoning: "Reasoning effort",
        analysisTrigger: "Trigger",
        analysisTriggerManual: "Manual",
        analysisCooldown: "Analysis cooldown (min)",
        analysisTimeout: "Model timeout (seconds)",
         analysisMaxTokens: "Max output tokens",
        experimentTitle: "Strategy experiments",
        experimentHint: "Candidate strategies run only in isolated replay. Live guidance always uses the fixed control. Results that fail out-of-sample admission are never shown as validated or recommended.",
        experimentEnabled: "Enable strategy experiments",
        experimentDisabledHint: "Strategy experiments are off by default. Enable and save the configuration before running them.",
        experimentCatalogLoading: "Loading strategy catalog…",
        experimentCatalogError: "Failed to load strategy catalog: {error}",
        experimentLatestError: "Failed to load experiment report: {error}",
        experimentControl: "Control trend pullback",
        experimentOrb: "ORB trend pullback",
        experimentUnknownStrategy: "Strategy {id}",
        experimentLiveFixed: "Fixed live control · cannot be disabled",
        experimentReplayOnly: "Replay-only candidate",
        experimentUnregistered: "Unregistered; disable and save to remove the stale configuration",
        experimentStrategyVersion: "Version {version}",
        experimentEnableCandidate: "Enable ORB candidate strategy",
        experimentSignalLanes: "Signal lanes",
        experimentLane_cmb: "CMB accumulated gold",
        experimentLane_au9999: "Au99.99",
        experimentLane_xau: "Converted XAU",
        experimentOrbParameters: "ORB core parameters",
        experimentOpeningRangeBars: "Opening-range bars",
        experimentBreakoutBuffer: "Breakout ATR buffer",
        experimentPullbackTolerance: "Pullback ATR tolerance",
        experimentSetupExpiryBars: "Setup expiry bars",
        experimentOrderValidityBars: "Order-validity bars",
        experimentStopAtrMultiplier: "Stop ATR multiplier",
        experimentTargetAtrMultiplier: "Target ATR multiplier",
        experimentGrams: "Suggested grams",
        experimentRequireTrend: "Require trend regime",
        experimentRequiredFactors: "Required factor IDs",
        experimentFactorMaxAgeHours: "Factor maximum age (hours)",
        experimentCostMatrix: "Cost multipliers: {values}",
        experimentParameterMatrix: "Parameter multipliers: {values}",
        experimentAblationMatrix: "Ablations: {values}",
        experimentAblation_none: "Full rules",
        experimentAblation_without_regime_filter: "Remove regime filter",
        experimentPromotionPreset: "Load full promotion matrix",
        experimentReportStale: "This report does not match the unsaved configuration or run controls. The results below belong to the previous run.",
        experimentDays: "Replay days",
        experimentMode: "Experiment mode",
        experimentMode_diagnostic: "Short-window diagnostic",
        experimentMode_walk_forward: "Long-term validation",
        experimentRun: "Run experiment",
        experimentSaveRequired: "Save the exact experiment configuration and enable at least one registered candidate first",
        experimentRunning: "Experiment running…",
        experimentEmpty: "No experiment report yet.",
        experimentReportSchema: "Schema: {value}",
        experimentReportGeneratedAt: "Generated: {value}",
        experimentReportAsOf: "As-of: {value}",
        experimentReportStatus: "Status: {value}",
        experimentReportId: "Experiment: {value}",
        experimentFingerprint: "Fingerprint: {value}",
        experimentScenarios: "Scenario matrix",
        experimentScenarioStrategy: "Strategy",
        experimentScenarioLane: "Signal lane",
        experimentScenarioCost: "Cost multiplier",
        experimentScenarioParameter: "Parameter multiplier",
        experimentScenarioAblation: "Ablation",
        experimentScenarioStatus: "Status",
        experimentScenarioNet: "Net result (CNY)",
        experimentScenarioDrawdown: "Max drawdown (CNY)",
        experimentScenarioOos: "OOS",
        experimentComparisons: "Control comparisons",
        experimentComparisonDelta: "Net-result delta (CNY)",
        experimentComparisonDrawdownDelta: "Drawdown delta (CNY)",
        experimentPromotion: "Promotion review",
        experimentPromotionSafe: "Promotion status is derived by the Host out-of-sample admission policy. A failed candidate remains an experiment diagnostic.",
        experimentPromotionCandidate: "{strategy}: {status}",
        experimentPromotionNotEligible: "Not eligible for promotion",
        experimentPromotionEligible: "Eligible to apply as a candidate, not a recommendation",
        experimentPromotionReasons: "Reasons: {reasons}",
        experimentReason_scenario_matrix_incomplete: "Scenario matrix is incomplete",
        experimentReason_promotion_matrix_not_exact: "Promotion accepts only the fixed lane, cost, parameter, and ablation matrix",
        experimentReason_signal_lane_matrix_incomplete: "The required CMB, Au99.99, and XAU signal-lane matrix is incomplete",
        experimentReason_cost_stress_matrix_incomplete: "The required 1x and 2x cost matrix is incomplete",
        experimentReason_lane_baseline_missing: "Signal-lane baseline is missing",
        experimentReason_oos_not_validated: "Out-of-sample validation has not passed",
        experimentReason_scenario_validation_incomplete: "Some scenarios have not passed the full validation gate",
        experimentReason_control_comparison_missing: "Control comparison is missing",
        experimentReason_control_oos_not_validated: "Control has not passed out-of-sample validation",
        experimentReason_dataset_basis_mismatch: "Candidate and control use different dataset bases",
        experimentReason_execution_basis_mismatch: "Candidate and control use different execution-rule bases",
        experimentReason_candidate_not_better_than_control: "Candidate is not consistently better than control",
        experimentReason_walk_forward_required: "Only walk-forward runs may enter promotion evaluation",
        experimentReason_fold_windows_misaligned: "Candidate and control out-of-sample fold windows are not aligned",
        experimentReason_per_fold_control_not_dominated: "Candidate does not dominate control in every out-of-sample fold",
        experimentReason_per_fold_benchmark_not_dominated: "Candidate does not beat every built-in benchmark in every out-of-sample fold",
        experimentReason_per_fold_cost_stress_failed: "Candidate does not dominate control in every cost-stress fold",
        experimentReason_cost_stress_unstable: "Cost-stress results are unstable",
        experimentReason_cost_stress_non_monotonic: "Net results improve as costs rise; execution accounting needs review",
        experimentReason_cost_stress_control_missing: "A same-cost control scenario is missing",
        experimentReason_cost_stress_control_not_validated: "The same-cost control has not passed out-of-sample validation",
        experimentReason_cost_stress_not_better_than_control: "The candidate does not beat same-basis control under cost stress",
        experimentReason_ablation_matrix_incomplete: "Ablation matrix is incomplete",
        experimentReason_ablation_oos_not_validated: "Ablation scenarios lack complete out-of-sample validation",
        experimentReason_ablation_not_supportive: "The full strategy does not dominate its ablation on OOS return and drawdown",
        experimentReason_ablation_not_applicable: "The base configuration already disables the regime filter, so this ablation is not applicable",
        experimentReason_ablation_no_observed_contribution: "The full and ablated strategies are identical, so no feature contribution was observed",
        experimentReason_parameter_sensitivity_incomplete: "Parameter-sensitivity matrix is incomplete",
        experimentReason_parameter_sensitivity_unstable: "Return or drawdown is unstable under parameter perturbation",
        experimentReason_factor_evidence_missing: "Factor evidence is missing",
        experimentReason_invalid_replay_report: "The replay report failed integrity validation",
        experimentReason_scenario_attestation_mismatch: "Replay evidence does not match the requested scenario",
        experimentReason_scenario_failed: "The scenario failed to execute",
        experimentReason_point_in_time_ingestion_unavailable: "No bars can prove ingestion by their close",
        experimentReason_au9999_cmb_execution_basis_unavailable: "No point-in-time CMB execution path is aligned to the Au99.99 signal timestamps",
        experimentReason_xau_usdcny_point_in_time_unavailable: "Point-in-time XAU and USDCNY data are not jointly available",
        experimentReason_unknown_strategy: "Strategy is not registered",
        experimentReason_unsupported_lane: "Strategy does not support this signal lane",
        experimentReason_scenario_failed: "Scenario execution failed",
        experimentBenchmarkCapabilities: "Statistical and ML benchmark capabilities",
        experimentBenchmarkUnavailable: "{id}: unavailable ({reason})",
        experimentReason_training_artifact_missing: "training artifact missing",
        experimentReason_point_in_time_features_missing: "point-in-time features missing",
        experimentStatus_completed: "Completed",
        experimentStatus_partial: "Partially completed",
        experimentStatus_unavailable: "Unavailable",
        experimentStatus_failed: "Failed",
        experimentStatus_insufficient_data: "Insufficient data",
        experimentStatus_ready: "Ready",
        experimentStatus_unknown_strategy: "Unknown strategy",
        experimentStatus_unsupported_lane: "Signal lane unsupported",
        experimentStatus_not_eligible: "Not eligible for promotion",
        experimentStatus_eligible_to_apply: "Eligible to apply as candidate",
        experimentStatus_unknown: "Unknown",
        experimentOosSummary: "{completed}/{registered} folds · {status}",
        experimentRunError: "Experiment failed: {error}",
        experimentPersistWarning: "The experiment completed, but its report was not persisted and may be lost after restart: {error}",
        error_STRATEGY_REGISTRY_UNAVAILABLE: "The strategy catalog is unavailable",
        error_STRATEGY_EXPERIMENTS_UNAVAILABLE: "The strategy experiment service is unavailable",
        error_EXPERIMENTS_DISABLED: "Enable and save strategy experiments first",
        error_EXPERIMENT_SAVE_REQUIRED: "The experiment configuration changed; save it before running",
        error_EXPERIMENT_PERSIST_FAILED: "The experiment completed, but its result could not be persisted",
        error_STRATEGY_DISABLED: "The selected candidate strategy is not enabled",
        error_EXPERIMENT_LANE_DISABLED: "The selected signal lane is not enabled",
        error_EXPERIMENT_TOO_LARGE: "The experiment exceeds the configured scenario limit",
        error_EXPERIMENT_ALREADY_RUNNING: "Another strategy experiment is already running",
        error_BAD_EXPERIMENT_MODE: "The experiment mode is invalid",
        error_BAD_EXPERIMENT_DAYS: "Replay days must be an integer from 1 through 30",
        error_BAD_EXPERIMENT_STRATEGY_IDS: "The strategy list is invalid",
        error_BAD_EXPERIMENT_SIGNAL_LANES: "The signal-lane list is invalid",
        error_BAD_EXPERIMENT_AS_OF: "The experiment as-of is invalid or in the future",
        error_REPLAY_WALK_FORWARD_LANE_UNAVAILABLE: "Long-horizon walk-forward currently requires a signal lane with complete CMB execution history",
        error_STRATEGY_EXPERIMENT_CANCELLED: "The experiment was cancelled",
        error_BAD_STRATEGY_EXPERIMENT: "The strategy experiment request is invalid",
        statsTitle: "Replay & long-term validation (report v6)",
        statsHint: "Rebuilds the strategy at an explicit as-of with frozen parameters while ReplaySimulator advances orders, fills, ledger events, and marks. Short history, proxy paths, unverified costs, or unmet OOS gates keep the result exploratory.",
        statsDays: "Days",
        statsGenerate: "Generate short-window diagnostic",
        statsValidate: "Run long-term validation",
        statsGenerating: "Generating statistics… (day-by-day replay, please wait)",
        statsCached: "(cached)",
        statsEmpty: "No report yet — click “Generate statistics” to start.",
        statsLegacyReport: "Legacy v{version} uses old execution assumptions. It is not comparable with v5 and is not evidence of executable performance. Generate a new report.",
        statsV5Banner: "Limit-order fills are simulated from 5-minute data and are not actual execution. One-sided history is explicitly marked as a synthetic proxy.",
        statsV6Banner: "ReplaySimulator v6 pins the as-of plus dataset and report fingerprints. Second-level timing policies are coarse sensitivity scenarios, not evidence of queue position or actual fills.",
        statsDatasetTitle: "Replay dataset",
        statsDatasetId: "Dataset: {id}",
        statsDatasetRange: "Data range: {from} ~ {to}",
        statsDatasetHistory: "History span: {months} months",
        statsDatasetBars: "Complete 5-minute bars: {complete}/{total}",
        statsDatasetRecords: "Point-in-time records: {count}",
        statsInputFingerprint: "Input fingerprint: {value}",
        statsReportFingerprint: "Report fingerprint: {value}",
        statsMetricsTitle: "Validation metrics",
        statsMetricSharpe: "Sharpe {value}",
        statsMetricSortino: "Sortino {value}",
        statsMetricCalmar: "Calmar {value}",
        statsMetricExposure: "Exposure time {value}",
        statsMetricUtilization: "Capital utilization {value}",
        statsMetricDrawdown: "Max drawdown {value} CNY ({rate})",
        statsMetricDrawdownDuration: "Drawdown duration {value} hours",
        statsMetricTurnover: "Turnover {value} CNY",
        statsMetricProfitFactor: "Profit factor {value}",
        statsReturnInterval: "Return block-bootstrap 95% interval [{low}, {high}]",
        statsWinInterval: "Win-rate Wilson 95% interval [{low}, {high}]",
        statsOosTitle: "Walk-forward out-of-sample folds",
        statsOosSummary: "Status {status} · {registered} registered · {completed} completed",
        statsOosInsufficient: "Long-term point-in-time data is insufficient, so no validated OOS conclusion is available.",
        statsFoldTrain: "Training window",
        statsFoldTest: "Test window",
        statsFoldSamples: "Test samples",
        statsFoldStatus: "Status",
        statsStatus_ready: "Ready",
        statsStatus_completed: "Completed",
        statsStatus_partial: "Partial",
        statsStatus_insufficient_data: "Insufficient data",
        statsStatus_failed: "Failed",
        statsStatus_ok: "Available",
        statsStatus_unavailable: "Unavailable",
        statsBenchmarksTitle: "Same-basis benchmarks",
        statsBenchmarkName: "Benchmark",
        statsBenchmarkNet: "Net result (CNY)",
        statsBenchmarkReturn: "Total return",
        statsBenchmarkDrawdown: "Max drawdown",
        statsBenchmark_no_trade: "No trade",
        statsBenchmark_buy_and_hold: "Buy and hold",
        statsBenchmark_fixed_interval_dca: "Fixed-interval DCA",
        statsBenchmark_simple_moving_average: "Simple moving average",
        statsReportVersion: "Report v{version}",
         statsGeneratedAt: "Generated: {time}",
         statsStrategy: "Strategy: {id} · {version}",
         statsVersions: "Provenance: indicators {calculation} · data {data} · execution {execution} · calendar {calendar}",
         statsExecution: "Execution: {version} · {fill} · {ambiguity}",
         statsFillPolicy_next_bar_limit: "next complete 5-minute limit",
         statsFillPolicy_next_open: "next complete bar open",
         statsFillPolicy_signal_close: "signal-bar close (sensitivity)",
         statsFillPolicy_delay_30s: "30-second delay (requires second-level evidence)",
         statsFillPolicy_delay_60s: "60-second delay (requires second-level evidence)",
         statsFillPolicy_delay_120s: "120-second delay (requires second-level evidence)",
         statsAmbiguityPolicy_conservative_stop: "conservative stop on dual touch",
         statsAmbiguityPolicy_unknown: "dual touch remains unknown",
         statsEvidenceExploratory: "Exploratory diagnostic",
         statsEvidenceValidated: "Validation result",
         statsEvidenceUnavailable: "Evidence status unavailable (legacy report)",
         statsValidationNotEligible: "Validation gate not met; this is not a validated strategy or actual performance",
         statsValidationReasons: "Unmet requirements: {reasons}",
         statsValidationReason_long_term_history_not_available: "No long-term history covering at least 12 months",
         statsValidationReason_no_oos_validation: "No rolling out-of-sample validation",
         statsValidationReason_cost_semantics_unverified: "Cost semantics have not been verified against the product agreement",
         statsValidationReason_no_benchmark_comparison: "No benchmark comparison",
         statsValidationReason_no_uncertainty_intervals: "No uncertainty intervals",
         statsValidationReason_dataset_manifest: "The dataset manifest version or fingerprint is invalid",
         statsValidationReason_dataset_integrity: "The selected dataset contains a quarantined corrupt partition",
          statsValidationReason_session_coverage: "At least one session is missing an opening, closing, or internal expected bar slot",
         statsValidationReason_minimum_history_months: "History is shorter than 12 months",
         statsValidationReason_oos_registry: "The OOS registry version, ID, or dataset binding is invalid",
         statsValidationReason_oos_fold_integrity: "A completed OOS fold has invalid bounds, samples, intervals, or result fingerprint",
         statsValidationReason_simulation_diagnostics: "Simulation input contains invalid, future, or conflicting frames",
         statsValidationReason_multiple_oos_folds: "Fewer than two OOS folds are completed",
         statsValidationReason_frozen_oos_parameters: "Test-fold parameters are not all frozen",
         statsValidationReason_real_bid_ask_evidence: "Real bid/ask coverage does not meet the validation requirement",
         statsValidationReason_verified_cost_semantics: "Cost semantics are not verified against the product agreement",
         statsValidationReason_benchmark_comparison: "The four same-basis benchmarks are incomplete",
         statsValidationReason_uncertainty_intervals: "Overall or OOS-fold uncertainty intervals are incomplete",
         statsValidationReason_proxy_or_unknown_execution: "Execution path contains proxy or unknown bid/ask data",
         statsValidationReason_incomplete_sessions: "Some sessions are partial, skipped, or failed",
         statsCostAssumptions: "Cost assumptions",
         statsCostFees: "Explicit fees: buy {buy} / sell {sell} CNY/g",
         statsCostSlippage: "Slippage: buy {buy} / sell {sell} CNY/g",
         statsCostFallback: "Synthetic path: buy offset {buy} / sell offset {sell}; estimated spread {spread} CNY/g",
         statsCostProxy: "CMB one-sided history proxy spread: {spread} CNY/g",
         statsCostUnverified: "Cost semantics have not been verified against the product agreement",
         statsCostQuotedSpread: "Real bid/ask already includes the quoted spread; no estimated spread is added",
         statsCostUnavailable: "Legacy report did not save cost assumptions",
         statsRealBidAskCoverage: "Real bid/ask coverage {rate} ({count}/{total} bars)",
         statsProxyBidAskCoverage: "Proxy bid/ask coverage {rate} ({count}/{total} bars)",
         statsUnknownBidAskCoverage: "Unknown bid/ask coverage {rate} ({count}/{total} bars)",
         statsCoverageUnavailable: "Bid/ask coverage classification unavailable (legacy report)",
         statsCaveatUnknown: "Untranslated limitation: {code}",
        statsCompleteDays: "Complete sessions {count}",
        statsPartialDays: "Partial sessions {count}",
        statsFillRate: "Simulated fill rate {rate}",
        statsExpiryRate: "Expiry rate {rate}",
        statsAmbiguousBars: "Ambiguous dual-touch bars {count}",
        statsBidAskCoverage: "Real bid/ask coverage {rate}",
         statsAverageDelay: "Average simulated delay {ms} ms",
        statsUnknown: "Unknown",
        valuationUnavailable: "Valuation unavailable",
        statsFailed: "Generation failed: {error}",
        statsPersistWarning: "The replay completed, but part of its report was not persisted and may be lost after restart: {error}",
        statsCancelled: "Cancelled (connection lost)",
        statsWindow: "Window: {from} ~ {to}",
        statsLane: "Signal lane: {lane}",
        statsLaneCmb: "CMB accumulated gold",
        statsLaneAu9999: "Au99.99",
        statsDaysEvaluated: "Trading days covered {evaluated}/{requested}",
        statsSteps: "Total evaluation steps {count}",
        statsEvents: "{count} independent signal samples",
        statsUnexecutedCount: "{count} blocked by account constraints",
        statsUnexecutedCountUnavailable: "Account-constraint signals: unknown in legacy report",
        statsBlocked: "Data-incomplete step ratio {ratio}",
        statsPartialFailures: "{count} trading days failed to fetch: {detail}",
        statsNoEvents: "No directional signal events in this window.",
        statsOverallTitle: "Continuous account (starts at 0 g)",
        statsCardTotalNet: "Simulated net result (CNY)",
        statsCardTotalNetHint: "Starts from zero grams and fills only unexpired orders whose limit is touched; remaining holdings are valued at the final executable bid after explicit fees and slippage.",
        statsCardRealizedNet: "Realized net P&L (CNY)",
        statsCardRealizedNetHint: "P&L from completed sales relative to their buy cost and fees; unsold holdings are excluded.",
        statsCardUnrealizedNet: "Ending holding P&L (CNY)",
        statsCardUnrealizedNetHint: "P&L from remaining holdings if liquidated at the final sell price after exit fees and slippage.",
        statsCardEndingPosition: "Ending simulated position (g)",
        statsCardEndingPositionHint: "Grams still held at the end of replay; their final valuation is included in total net P&L.",
        statsDetails: "Details",
        statsDetailsTitle: "Continuous account orders and unexecuted signals",
        statsDetailsHint: "The order table shows simulated limit-order lifecycles. The unexecuted-signal table shows confirmed strategy signals that did not create an order because of position limits or other account constraints. They do not count toward fill rate, cash flow, or P&L.",
        statsDetailsRefresh: "Refresh",
        statsDetailsLoading: "Loading account details…",
        statsDetailsLoadError: "Unable to load account details: {error}",
        statsDetailsEmpty: "This report has no orders or unexecuted signals to display.",
        statsDetailsUnavailable: "This older report has no saved account details. Generate the statistics again, then reopen details.",
        statsOrdersTitle: "Simulated orders",
        statsUnexecutedTitle: "Unexecuted strategy signals",
        statsUnexecutedHint: "These signals passed strategy confirmation and cooldown, but did not enter the continuous account and produced no simulated fill. Details retain the latest 200 rows; the summary count covers the full window.",
        statsUnexecutedUnavailable: "This report predates account-constraint signal diagnostics, so blocked signals cannot be determined. Generate the statistics again.",
        statsSignalNotExecuted: "Not executed",
        statsUnexecutedSignalPrice: "Suggested limit (CNY/g)",
        statsUnexecutedPosition: "Position / limit (g)",
        statsUnexecutedReason: "Reason not executed",
        statsUnexecutedReason_position_limit: "Position limit reached",
        statsDetailsTime: "Time",
        statsDetailsStatus: "Order status",
        statsDetailsAction: "Strategy action",
        statsOrderFilled: "Simulated fill",
        statsOrderExpired: "Expired",
        statsOrderPending: "Pending",
        statsOrderReplaced: "Replaced",
        statsDetailsPrice: "Simulated fill price (CNY/g)",
        statsDetailsGrams: "Filled grams",
        statsDetailsFee: "Fees and slippage (CNY)",
        statsDetailsPositionBefore: "Position before (g)",
        statsDetailsPositionAfter: "Position after (g)",
        statsDetailsCashFlow: "Cash flow (CNY)",
        statsDetailsRealizedNet: "Realized P&L (CNY)",
        statsDetailsSummary: "Ending position {grams} g at a final sell price of {price} CNY/g; realized {realized} CNY, ending holding P&L {unrealized} CNY, total {total} CNY.",
        statsDetailsTipTime: "Signal, eligibility, and final simulated fill/expiry times. The signal bar itself is never used as a fill.",
        statsDetailsTipAction: "The strategy rule that triggered this simulated trade.",
        statsDetailsTipPrice: "The strategy's suggested accumulated-gold fill price; buys and sells use their respective quote side.",
        statsDetailsTipGrams: "Grams filled by this trade, constrained by the current maximum grams and position bands.",
        statsDetailsTipFee: "This trade's configured buy or sell fee plus slippage.",
        statsDetailsTipPosition: "Continuous-account holdings immediately before and after this fill.",
        statsDetailsTipCashFlow: "Cash paid for buys is negative and cash received for sells is positive; it is not P&L.",
        statsDetailsTipRealizedNet: "Net cash received on a sale minus the associated holding's buy-inclusive cost; buys have no realized P&L yet.",
        statsParamsTitle: "Replay parameters:",
        statsParamConfirmBars: "confirm ×{n}",
        statsParamScoreThreshold: "score ≥{n}",
        statsParamCooldown: "cooldown {m}m",
        statsParamCloseOn: "session-end close ON",
        statsParamCloseOff: "session-end close OFF",
        statsGroupEntryTitle: "Signal quality: long entries (independent samples)",
        statsGroupEntryHint: "Each row is an independent after-the-fact sample for this entry signal (CNY/g, including fees, spread, and slippage). It measures signal quality only, is not part of the continuous account total above, and must not be summed.",
        statsGroupExitTitle: "Signal quality: sells / trims (independent samples)",
        statsGroupExitHint: "Each row is the independent difference between exiting at this signal and holding to session end (CNY/g); positive means exiting beat holding. It is not part of the continuous account total above.",
        statsTableAction: "Action",
        statsTableCount: "Triggers",
        statsTableTargetHit: "Target touch (bid/proxy)",
        statsTableStopHit: "Stop touch (bid/proxy)",
        statsTableMfe30: "Avg MFE 30m (CNY/g)",
        statsTableMae30: "Avg MAE 30m (CNY/g)",
        statsTableHoldNet: "Hold-to-end net (CNY/g)",
        statsTableFallMfe30: "Avg further fall 30m (CNY/g)",
        statsTableReboundMae30: "Avg rebound 30m (CNY/g)",
        statsTableDrift60: "Avg drift after 60m (CNY/g)",
        statsTableExitSaving: "Exit vs holding (CNY/g)",
        statsTipCount: "How often this signal fired in the replay window (both simulated passes combined).",
        statsTipTargetHit: "Share of events where price touched the signal's target before session end.",
        statsTipStopHit: "Share of events where price broke the signal's stop before session end.",
        statsTipMfe30: "Mean maximum favorable excursion within 30 minutes after the trigger; upside for entries, further downside for sell signals.",
        statsTipMae30: "Mean maximum adverse excursion within 30 minutes after the trigger; downside for entries, rebound for sell signals.",
        statsTipDrift60: "Mean close-vs-signal drift 60 minutes after the exit; negative = price fell afterwards, so exiting was right.",
        statsTipHoldNet: "Mean net P&L of buying at the signal price and holding to session end (buy+sell fees, spread and slippage included); positive = the entry made money afterwards.",
        statsTipExitSaving: "Mean net difference between exiting at the signal and holding to session end (same cost basis); positive = exiting beat holding.",
        statsConfidenceTitle: "Rule score vs target-touch rate (entry events)",
        statsCaveatsTitle: "Methodology and limitations",
        caveat_lane_au9999_only: "Statistics run on the Au99.99 lane only (Eastmoney history): live CMB quotes have no public history, so conclusions do not transfer 1:1 to the CMB desk — use the default accumulated-gold lane for desk-accurate terms.",
        caveat_lane_cmb_persisted_bars: "Statistics run on the CMB accumulated-gold lane: data comes from this host's persisted quote series (live polling + manual backfill); the customer sell price is synthesized at a fixed 5 CNY/g spread. Depth is bounded by local accumulation, and terms match the live desk most closely.",
        caveat_minute_coverage_from_5m: "Minute-level coverage is derived by splitting real 5m klines; micro-gaps under 5 minutes are invisible. Gate semantics match production but at coarser granularity.",
        caveat_synthetic_lane_sampling: "Synthetic/low-sample lanes have limited fidelity (e.g. the international lane carries ≤2 samples per bar); their statistics are below live-polling quality — do not treat them as trading evidence.",
        caveat_history_depth_limited: "Replay depth is bounded by available history (Au99.99: ~10+ trading days of 5m klines; CMB: the local rolling window). Days without data are counted in daysSkippedNoData and skipped honestly.",
        caveat_continuous_zero_position: "The continuous account starts at 0 g and fills only later bars that touch an active limit. Ending holdings are valued at the last executable bid after costs.",
        caveat_next_bar_limit_fills: "Orders are eligible from the next complete 5-minute bar and remain unfilled when the limit is not touched or validity ends. OHLC cannot recover queue position, partial fills, or second-level paths.",
        caveat_conservative_ambiguous_bars: "If one bar touches both target and stop, it is marked ambiguous and the default long-side result assumes the stop first while retaining best/worst bounds.",
        caveat_unknown_ambiguous_bars: "One bar cannot prove whether the target or stop came first, so this scenario leaves the fill outcome unknown.",
        caveat_sensitivity_fill_policy: "This report uses a non-default timing policy for sensitivity comparison only; 5-minute data cannot prove second-level paths or queue position.",
        caveat_complete_session_only: "By default, only sessions past the configured close with data reaching the session tail are included. Explicitly included partial sessions are marked to as-of and reported separately.",
        caveat_two_simulated_passes: "Independent signal tables evaluate flat and holding diagnostic passes; those samples are not part of the continuous account.",
        caveat_past_performance_advisory: "Past hit rates do not predict future results. This report is a strategy engineering diagnostic, not investment advice.",
         enumStatus_analysis_ready: "Analysis ready",
         enumStatus_insufficient_data: "Insufficient data",
         enumStatus_stale: "Stale market data",
         enumStatus_invalid: "Invalid output",
         enumBias_bullish: "Bullish",
         enumBias_bearish: "Bearish",
         enumBias_neutral: "Neutral",
         enumBias_unknown: "Unknown",
         enumHorizon_intraday: "Intraday",
         enumHorizon_swing: "Swing",
         enumAction_wait: "Wait",
         enumAction_observe: "Observe",
         enumAction_risk_reduce: "Reduce risk",
         enumAction_manual_review: "Manual review",
         enumAction_buy_setup: "Buy setup",
         enumAction_add_position: "Add position",
         enumAction_reduce_position: "Reduce position",
         enumAction_sell_take_profit: "Take-profit sell",
         enumAction_sell_target_trail: "Target-retrace sell",
         enumAction_sell_time_stop: "Time-stop exit",
         enumAction_sell_trailing: "Trailing sell",
         enumAction_sell_stop: "Stop-loss sell",
         enumAction_sell_weakness: "Reduce on weakness",
         enumAction_close_by_session_end: "Close before session end",
         enumAction_market_closed: "Market closed",
         enumAction_no_data: "No data",
         enumAction_no_budget: "Position limit reached",
         enumAction_data_incomplete: "Incomplete data",
         enumAction_data_stale: "Stale data",
         enumConfidence_low: "Low",
         enumConfidence_medium: "Medium",
         enumConfidence_high: "High",
        modelsLoading: "Loading the Harness model catalog…",
        noModels: "No available models",
        selectedModelUnavailable: "The selected model is unavailable. Select another model and save.",
        providerFailures: "Some provider catalogs failed",
        runAnalysis: "Analyze now",
        analysisRunning: "Analyzing…",
        analysisSuccess: "Analysis complete",
        analysisBlocked: "Data-quality gate failed; the model was not called",
        analysisBias: "Bias",
        analysisAction: "Action",
        analysisHorizon: "Horizon",
        analysisConfidence: "Confidence",
        analysisEvidence: "Evidence",
        analysisSupport: "Support",
        analysisResistance: "Resistance",
        analysisWarnings: "Data warnings",
        analysisSummary: "Plain-language summary",
        analysisFailed: "Analysis failed: {error}",
        analysisQueryId: "Query ID",
        viewAnalysisLogs: "Query logs",
        queryLogsTitle: "Model analysis query logs",
        queryLogsDisclaimer: "Model explanation, not a trading instruction. Log data is redacted.",
        filterStatus: "Status",
        filterProvider: "Provider",
        filterModel: "Model",
        filterFrom: "From",
        filterTo: "To",
        filterAll: "All",
        status_running: "Running",
        status_success: "Success",
        status_error: "Error",
        status_aborted: "Aborted",
        status_invalid: "Invalid output",
        logRequestedAt: "Requested",
        logSnapshotAsOf: "Market snapshot",
        logRuleAction: "Rule action",
        logProviderModel: "Model",
        logQueryId: "Query ID",
        logUsage: "Token usage",
        logQuality: "Data quality",
        logInput: "Model input", logResult: "Structured result",
        logModelOutput: "Raw model output (redacted)",
        logNoOutput: "No model output was captured",
        logError: "Error",
        selectLog: "Select a query to view details",
        copyJson: "Copy redacted JSON",
        jsonCopied: "Redacted JSON copied",
        loadMore: "Load more",
        noMoreLogs: "No more records",
        analysisLogUnavailable: "Analysis logs are currently unavailable",
        error_ANALYSIS_DISABLED: "Model analysis is disabled",
        error_LLM_UNAVAILABLE: "Harness model runtime is unavailable",
        error_MODEL_NOT_SELECTED: "Select a provider and model first",
        error_MODEL_UNAVAILABLE: "The selected model is unavailable",
        error_SNAPSHOT_CHANGED: "The market snapshot changed; run the analysis again",
        error_DATA_STALE: "Market data is stale",
        error_DATA_QUALITY_BLOCKED: "The data-quality gate failed",
        error_WARMUP_NOT_READY: "Indicators are still warming up",
        error_INSTRUMENT_MISMATCH: "Market instrument semantics do not match",
        error_ANALYSIS_TIMEOUT: "Model analysis timed out",
        error_ANALYSIS_ABORTED: "Model analysis was aborted",
        error_INVALID_JSON: "The model did not return strict JSON",
        error_INVALID_SCHEMA: "The model result failed structural validation",
        error_MAX_TOKENS: "The model output reached the token limit",
        error_ANALYSIS_FAILED: "Model analysis failed",
        error_BAD_RESPONSE: "The Host returned an invalid response",
        error_GENERIC_NOT_FOUND: "The generic webhook does not exist",
        error_SYSTEM_DISABLED: "Host system notifications are disabled",
        error_BAD_CHANNEL: "Unknown notification channel",
        error_WEBHOOK_NOT_CONFIGURED: "The webhook is not configured or enabled",
        error_WEBHOOK_URL_BLOCKED: "The webhook target violates the public-network safety policy",
        error_WEBHOOK_HTTP_ERROR: "The webhook returned a non-success status",
        error_NOTIFY_FAILED: "Unable to send the test message",
        error_REPLAY_REPORT_CHANGED: "The report changed; close and reopen the details",
        error_SETTINGS_TRANSPORT_UNAVAILABLE: "The settings service is unavailable",
        error_SETTINGS_WRITE_FAILED: "Unable to save settings",
        error_STALE_CONFIG: "The config changed in another window; review and retry",
        error_UNKNOWN_CONFIG_KEY: "Unknown config key: the Host may not have restarted with the new config fields",
        error_BAD_CONFIG: "Invalid config payload",
        error_BAD_REVISION: "Invalid config revision",
        error_STORAGE_FAILED: "Failed to write the config to disk",
        error_SYSTEM_UNSUPPORTED: "This system cannot open notification settings",
        error_SYSTEM_SETTINGS_FAILED: "Unable to open system notification settings",
        error_UNAUTHORIZED: "The session expired; refresh the page",
        openSystemSettings: "Open system notification settings",
        sidebarPriceTitle: "Sidebar gold price",
        sidebarPriceHint: "Show the selected live gold price to the right of the sidebar Gold Board entry.",
        sidebarPriceField: "Displayed price",
        sidebarPriceDomestic: "Domestic Au99.99",
        sidebarPriceXAU: "International XAU",
        sidebarPriceCMB: "CMB accumulated gold",
        systemSettingsOpened: "System notification settings opened",
        error_MANUAL_CMB_FAILED: "Unable to add the minute prices",
        error_REPLAY_STATS_FAILED: "Unable to generate the replay report",
        sellAll: "All",
        validUntil: "Suggested until",
          pendingOrder: "Tracked order",
          orderStanding: "standing — awaiting fill or invalidation, no repeated cancel prompts",
        reason_quote_missing: "Missing quote",
        reason_market_closed: "Market closed",
        reason_stale_quote: "Stale quote",
        reason_target_reached: "Target reached",
        reason_configured_spread_drift: "Configured fee diverges from the live sell price",
        reason_target_armed_watching: "Target reached — watching the retrace",
        reason_target_partial_sell: "Partial sell at target",
        reason_target_trail_hit: "Retrace line hit",
        reason_target_trail_timeout: "No new high after target — timed exit",
        reason_pre_target_timeout: "Held too long before reaching target",
        reason_daily_trend_filter_not_met: "Daily trend filter not met",
        reason_stop_reached: "Stop hit",
        reason_session_ending: "Session ending",
        reason_rsi_overbought: "5m RSI overbought",
        reason_bearish_bar: "5m bearish bar",
        reason_reduce_on_weakness: "Reduce on weakness",
        reason_break_below_sma20_with_profit: "5m broke below SMA20 with profit",
        reason_trend_ema20_up: "10/30/60m EMA20 rising",
        reason_near_support: "5m near support",
        reason_near_lower_band: "5m near lower Bollinger",
        reason_rsi_rebound: "5m RSI recovering",
        reason_trigger_not_confirmed: "5m entry not confirmed",
        reason_trend_filter_not_met: "10/30/60m trend filter not met",
        reason_no_budget: "Position limit reached",
        reason_target_band_add: "Add toward target position band",
        reason_target_band_reduce: "Reduce toward target position band and keep a base position",
        reason_already_light_position: "Already in light band, no repeated reduction",
        reason_position_limit: "Position limit reached; signal not executed",
        reason_max_grams: "Maximum gram constraint",
        reason_max_amount_reached: "Maximum nominal amount reached",
        reason_max_risk_per_trade: "Per-trade risk budget exhausted",
        reason_max_daily_loss: "Daily loss limit reached",
        reason_max_weekly_loss: "Weekly loss limit reached",
        reason_max_drawdown: "Maximum drawdown reached",
        reason_liquidity_cap: "Per-order liquidity cap applies",
        reason_max_adds_per_setup: "Maximum adds for this setup reached",
        reason_max_adds_per_day: "Maximum daily adds reached",
        reason_min_add_price_improvement: "Price has not improved enough for another add",
        reason_min_add_price_unavailable: "Previous add price unavailable; improvement cannot be verified",
        reason_post_fill_cooldown: "Post-fill cooldown active",
        reason_risk_budget_unconfigured: "Budget mode needs a cash risk budget",
        reason_ledger_unavailable: "Risk ledger version unavailable; new buys disabled",
        reason_risk_per_gram_unavailable: "Risk per gram is unavailable",
        reason_risk_budget_too_small: "Remaining risk budget is below 0.01 gram",
        reason_execution_ask_unavailable: "Executable buy price unavailable",
        reason_risk_budget_sized: "Suggestion sized by risk budget",
        reason_consecutive_loss_derisk: "Suggestion reduced after consecutive losses",
        reason_cooldown_active: "Same-direction cooldown active",
        reason_signal_confirming: "Confirming signal",
        reason_score_not_enough: "Signal score below threshold",
        reason_spread_alert: "Spread alert",
        reason_signal_lane_degraded: "Signal source degraded, watching",
        reason_weakness_rsi_overbought: "5m RSI overbought weakness",
        reason_bearish_engulfing: "5m bearish engulfing",
        reason_long_upper_shadow: "5m long upper shadow",
        reason_data_stale: "Stale data",
        reason_data_incomplete_5m: "5m data incomplete",
        reason_data_incomplete_10m: "10m data incomplete",
        reason_data_incomplete_30m: "30m data incomplete",
        reason_data_incomplete_60m: "60m data incomplete",
        reason_wait: "Wait",
        reason_observe: "Observe",
        reason_risk_reduce: "Reduce risk",
        reason_manual_review: "Manual review",
        reason_insufficient_data: "Insufficient data",
        reason_stale: "Stale",
        reason_invalid: "Invalid",
        reason_analysis_ready: "Analysis ready",
        reason_suggestedOrder: "Suggested order",
        hint_Bias_bullish: "Short-term bias is up; prices may keep rising",
        hint_Bias_bearish: "Short-term bias is down; prices may keep falling",
        hint_Bias_neutral: "Bulls and bears are balanced; direction is unclear",
        hint_Bias_unknown: "Not enough data to determine direction",
        hint_Action_wait: "No action for now; wait for a clearer signal",
        hint_Action_observe: "Keep watching; do not act yet",
        hint_Action_risk_reduce: "Consider reducing exposure or tightening risk",
        hint_Action_manual_review: "Review manually before deciding",
        hint_Horizon_intraday: "Best viewed as an intraday/short-term horizon",
        hint_Horizon_swing: "Best viewed as a swing/medium-term horizon",
        hint_Confidence_low: "Low reliability; use only as a reference",
        hint_Confidence_medium: "Moderately useful as a reference",
        hint_Confidence_high: "Relatively clear signal",
        hint_Confidence_high: "Relatively clear signal",
        evidence_trend_ema20_up: "10/30/60m EMA20 {values} ↑",
        evidence_trend_filter_not_met: "10/30/60m EMA20 {values}",
        evidence_near_support: "5m support {value}",
        evidence_near_lower_band: "5m Boll lower {value}",
        evidence_rsi_rebound: "5m RSI {value}",
        evidence_break_below_sma20_with_profit: "5m close<SMA20 {value}",
        evidence_bearish_bar: "5m bearish bar",
        evidence_target_band_add: "target ~{value}g",
        evidence_target_band_reduce: "keep ~{value}g",
      },
    };

    // plan-05 B.6: derived views over DICT for code that still wants a plain
    // {code: label} map (humanizeAnalysisText). Keys carry the reason_/hint_
    // prefixes inside DICT.
    function dictPrefixedView(dict, prefix) {
      var out = {};
      for (var key in dict) {
        if (key.indexOf(prefix) === 0) out[key.slice(prefix.length)] = dict[key];
      }
      return out;
    }
    var REASON_LABELS = { zh: dictPrefixedView(DICT.zh, "reason_"), en: dictPrefixedView(DICT.en, "reason_") };
    var ANALYSIS_ENUM_HINTS = { zh: dictPrefixedView(DICT.zh, "hint_"), en: dictPrefixedView(DICT.en, "hint_") };

    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;
    var ReactMemo = React.memo;
    var useSyncExternalStore = React.useSyncExternalStore;

    function format(t, key, params) {
      return typeof t === "function" ? t(key, params) : (DICT.zh[key] ?? key);
    }

    // ── shared JSON fetch (plan-05 B.1) ────────────────────────────────────
    //
    // One transport for every plugin endpoint: no-store, JSON accept header,
    // JSON content-type on writes, and a content-type guard that only throws
    // when a non-2xx response carries no JSON envelope (the per-call body.ok
    // branches keep their exact semantics).
    function fetchJson(url, options) {
      var opts = options || {};
      var init = {
        method: opts.method || "GET",
        cache: "no-store",
        headers: opts.body !== undefined && opts.body !== null
          ? { "content-type": "application/json; charset=utf-8", accept: "application/json" }
          : { accept: "application/json" },
      };
      if (opts.headers) {
        for (var headerKey in opts.headers) init.headers[headerKey] = opts.headers[headerKey];
      }
      if (opts.body !== undefined && opts.body !== null) init.body = JSON.stringify(opts.body);
      if (opts.signal) init.signal = opts.signal;
      return fetch(url, init).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok && (body === null || typeof body !== "object")) throw new Error("HTTP " + res.status);
          return body;
        }, function () {
          throw new Error("HTTP " + res.status);
        });
      });
    }

    function fmtPrice(value) {
      if (value === null || value === undefined || value === "") return "—";
      return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "—";
    }

    function fmtSigned(value, digits) {
      if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
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

    // ── Beijing wall-clock formatting (hoisted formatter + bounded memo) ──
    //
    // Intl.DateTimeFormat instances hold no mutable internal state, so a
    // single module-level instance is safe to share. The chart pipeline used
    // to construct ~7k formatters per snapshot render (one per bar lookup);
    // now every distinct epoch millisecond is computed once and memoized.
    var BEIJING_PARTS_FORMAT = null;
    try {
      BEIJING_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    } catch (_) {
      BEIJING_PARTS_FORMAT = null;
    }

    // Minute-bar timestamps are monotonically increasing, so the hit rate is
    // near-perfect; 8192 entries ≈ 5.7 days of 1m bars. When full, drop the
    // whole table (cheap, and the next render repopulates the hot range).
    var BEIJING_MEMO_MAX = 8192;
    var beijingMemo = new Map();

    function beijingPartsOf(timestamp) {
      var cached = beijingMemo.get(timestamp);
      if (cached) return cached;
      var entry;
      try {
        if (!BEIJING_PARTS_FORMAT) throw new Error("Intl timezone formatting unavailable");
        var parts = BEIJING_PARTS_FORMAT.formatToParts(new Date(timestamp));
        var map = {};
        for (var index = 0; index < parts.length; index += 1) map[parts[index].type] = parts[index].value;
        var day = map.year + "-" + map.month + "-" + map.day;
        var hourMinute = map.hour + ":" + map.minute;
        entry = {
          day: day,
          minutes: Number(map.hour) * 60 + Number(map.minute),
          text: day + " " + hourMinute + ":" + map.second,
          textShort: day + " " + hourMinute,
        };
      } catch (_) {
        // Fallback for engines without Intl timezone support: UTC+8 via ISO fields.
        var iso = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString();
        var fallbackDay = iso.slice(0, 10);
        entry = {
          day: fallbackDay,
          minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
          text: fallbackDay + " " + iso.slice(11, 19),
          textShort: fallbackDay + " " + iso.slice(11, 16),
        };
      }
      if (beijingMemo.size >= BEIJING_MEMO_MAX) beijingMemo.clear();
      beijingMemo.set(timestamp, entry);
      return entry;
    }

    /** Format an ISO timestamp as Beijing wall-clock time (Asia/Shanghai). */
    function formatBeijingTime(value, withSeconds) {
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "—";
      var entry = beijingPartsOf(date.getTime());
      return withSeconds === false ? entry.textShort : entry.text;
    }

    function beijingDateKey(value) {
      if (value === null || value === undefined || value === "") return "—";
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "—";
      return beijingPartsOf(date.getTime()).day;
    }

    /**
     * Calendar-day key of the *trading day* a timestamp belongs to. Sessions
     * may cross midnight (close "26:00" = 02:00 next day): minutes before
     * close−1440 belong to the session that opened the previous Beijing
     * calendar day, so they anchor to that earlier date. This keeps the
     * today-trend chart from truncating to the 00:00–02:00 slice after
     * midnight, in agreement with tradingMinuteIndex's compressed axis.
     */
    function tradingDayKey(value, tradingHours) {
      if (value === null || value === undefined || value === "") return "—";
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      var minutes = beijingMinutes(value);
      if (minutes !== null && close > 1440 && minutes < close - 1440) {
        // Beijing has no DST: minus 24h always lands on the previous date.
        return beijingDateKey(Number(new Date(value).getTime()) - 24 * 60 * 60 * 1000);
      }
      return beijingDateKey(value);
    }

    function beijingMinutes(value) {
      if (value === null || value === undefined || value === "") return null;
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return null;
      return beijingPartsOf(date.getTime()).minutes;
    }

    function parseTime(value, fallback) {
      var match = /^(\d{2}):(\d{2})$/.exec(value || "");
      if (!match) return fallback;
      return Number(match[1]) * 60 + Number(match[2]);
    }

    function isTradingMinute(minutes, tradingHours) {
      if (minutes === null || minutes === undefined) return false;
      var open = parseTime(tradingHours && tradingHours.open, 9 * 60);
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      var todayClose = Math.min(close, 1440);
      if (minutes >= open && minutes < todayClose) return true;
      if (close > 1440 && minutes < close - 1440) return true;
      return false;
    }

    // Compress the daily closed period out of the chart's x-axis, so the last
    // point before 02:00 sits next to the first point after 09:00.
    function tradingDayTotalMinutes(tradingHours) {
      var open = parseTime(tradingHours && tradingHours.open, 9 * 60);
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      if (close > 1440) {
        var earlyClose = close - 1440;
        return earlyClose + (1440 - open);
      }
      return Math.max(0, Math.min(close, 1440) - open);
    }

    function tradingMinuteIndex(minutes, tradingHours) {
      if (minutes === null || minutes === undefined) return null;
      var open = parseTime(tradingHours && tradingHours.open, 9 * 60);
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      if (close > 1440) {
        var earlyClose = close - 1440;
        if (minutes < earlyClose) return minutes;
        if (minutes >= open) return minutes - (open - earlyClose);
        return null;
      }
      var todayClose = Math.min(close, 1440);
      if (minutes >= open && minutes < todayClose) return minutes - open;
      return null;
    }

    function findBarAtBeijingMinute(bars, serverTime, minute) {
      // Deliberately compares *calendar* days, not tradingDayKey: the only
      // caller looks up the 00:00 price of serverTime's calendar date as the
      // CMB prev-close baseline. Anchoring this lookup to the trading day
      // would lose the midnight price every morning session and degrade the
      // baseline to the XAU-derived estimate.
      if (!Array.isArray(bars) || !serverTime) return null;
      var day = beijingDateKey(serverTime);
      if (!day || day === "—") return null;
      var target = Number(minute);
      for (var i = 0; i < bars.length; i += 1) {
        var bar = bars[i];
        if (!bar || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) continue;
        if (beijingDateKey(bar.t) === day && beijingMinutes(bar.t) === target) return Number(bar.c);
      }
      return null;
    }

    function filterTodayBars(bars, serverTime, tradingHours) {
      if (!Array.isArray(bars) || !serverTime) return [];
      var day = tradingDayKey(serverTime, tradingHours);
      if (!day || day === "—") return [];
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      var earlyClose = close > 1440 ? close - 1440 : null;
      var calendarDay = beijingDateKey(serverTime);
      return bars.filter(function (bar) {
        var minutes = beijingMinutes(bar && bar.t);
        if (!isTradingMinute(minutes, tradingHours)) return false;
        if (tradingDayKey(bar && bar.t, tradingHours) === day) return true;
        // The current calendar day's early-morning tail (00:00 – close−1440)
        // belongs to the *previous* trading day, but the compressed axis draws
        // it in the leading slots (tradingMinuteIndex), so it stays on today's
        // chart. Dropping it at 02:00 emptied the tail region for the rest of
        // the day, leaving only the synthetic 昨收 anchor there — stretched
        // into one straight line across the whole closed period.
        return earlyClose !== null
          && minutes !== null && minutes < earlyClose
          && beijingDateKey(bar && bar.t) === calendarDay;
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


    // Fill missing minute slots so the line breaks where data is absent.
    // Slots follow the compressed trading-day axis (see tradingMinuteIndex):
    // the early-morning tail (00:00 – close−1440) occupies the first slots
    // and the open→midnight session follows, so bars from both sides of
    // midnight stay on one axis instead of being cut off at 00:00.
    function fillMissingChartSlots(bars, serverTime, midnightPrice, tradingHours) {
      if (!Array.isArray(bars) || !serverTime) return bars;
      if (bars.length === 0 && !(Number.isFinite(Number(midnightPrice)) && Number(midnightPrice) > 0)) return bars;
      var nowMinutes = beijingMinutes(serverTime);
      if (nowMinutes === null) return bars;
      var nowIndex = tradingMinuteIndex(nowMinutes, tradingHours);
      if (nowIndex === null) return bars;
      var open = parseTime(tradingHours && tradingHours.open, 9 * 60);
      var close = parseTime(tradingHours && tradingHours.close, 26 * 60);
      var earlyClose = close > 1440 ? close - 1440 : null;
      var midnightBar = chartBaselineBar(serverTime, 0);
      if (!midnightBar) return bars;
      var midnight = midnightBar.t;
      var byTime = {};
      var firstIndex = null;
      bars.forEach(function (bar) {
        if (!bar) return;
        var t = new Date(bar.t).getTime();
        if (!Number.isFinite(t)) return;
        var aligned = Math.floor(t / 60_000) * 60_000;
        byTime[aligned] = bar;
        if (bar.baseline === true) return;
        var index = tradingMinuteIndex(beijingMinutes(bar.t), tradingHours);
        if (index !== null && (firstIndex === null || index < firstIndex)) firstIndex = index;
      });
      if (firstIndex === null) firstIndex = 0;
      // Axis slot → absolute ms. Morning-tail slots share serverTime's
      // calendar date; session slots belong to the previous calendar day
      // when "now" itself is still inside the early-morning tail.
      function slotTime(index) {
        var minuteOfDay = earlyClose !== null && index < earlyClose
          ? index
          : index + open - (earlyClose ?? 0);
        var crossesMidnight = earlyClose !== null && index >= earlyClose && nowMinutes < earlyClose;
        return midnight + minuteOfDay * 60_000 + (crossesMidnight ? -24 * 60 * 60 * 1000 : 0);
      }
      var result = [];
      function pushSlot(index) {
        var bar = byTime[slotTime(index)];
        if (bar) {
          result.push(bar);
        } else if (index === firstIndex && Number.isFinite(Number(midnightPrice)) && Number(midnightPrice) > 0) {
          result.push(chartBaselineBar(serverTime, midnightPrice));
        } else {
          // 没有行情的时间点保留为空，不要用 0 填充，避免折线被拉低。
          result.push(null);
        }
      }
      // Keep any synthetic baseline (or other pre-first bar) before the first
      // real bar. Without this, fillMissingChartSlots used to drop the
      // yesterday-close anchor from the chart.
      for (var index = 0; index < firstIndex; index += 1) pushSlot(index);
      // During the early-morning tail the whole previous evening session is
      // in the past even though its axis slots sit to the right of "now".
      var segments = earlyClose === null
        ? [[0, nowIndex]]
        : [
            [0, Math.min(nowIndex, earlyClose - 1)],
            [earlyClose, nowMinutes < earlyClose ? (tradingMinuteIndex(1439, tradingHours) ?? nowIndex) : nowIndex],
          ];
      for (var s = 0; s < segments.length; s += 1) {
        for (var index = Math.max(segments[s][0], firstIndex); index <= segments[s][1]; index += 1) {
          pushSlot(index);
        }
      }
      return result;
    }

    // Two valid samples are enough to draw: chartRuns turns consecutive points
    // into polylines and lone samples into dots, so a sparse day still renders
    // instead of falling back to the "no trend data" placeholder.
    function hasChartPoints(bars, tradingHours) {
      if (!Array.isArray(bars)) return false;
      var validCount = 0;
      for (var i = 0; i < bars.length; i += 1) {
        var bar = bars[i];
        if (!bar || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) continue;
        if (tradingMinuteIndex(beijingMinutes(bar.t), tradingHours) === null) continue;
        validCount += 1;
        if (validCount >= 2) return true;
      }
      return false;
    }

    // A gap wider than this many axis slots breaks the polyline in the
    // ">5 分钟断开" mode (see gapBreak/gapConnect).
    var CHART_GAP_SLOTS = 5;

    /**
     * Split plotted points ({ index, value }) into drawable runs.
     *
     * A gap wider than CHART_GAP_SLOTS starts a new run (unless gaps are
     * connected), but a single-point run becomes a *dot* instead of being
     * discarded: dropping lone samples hid real quotes on sparse days, and it
     * used to stretch the synthetic 昨收 anchor into a fake straight line
     * reaching the first bar (the 00:00→09:00 "trend" that was never data).
     */
    function chartRuns(points, connectGaps) {
      var runs = [];
      var dots = [];
      var current = [];
      function flush() {
        if (current.length >= 2) runs.push(current);
        else if (current.length === 1) dots.push(current[0]);
        current = [];
      }
      for (var i = 0; i < points.length; i += 1) {
        var point = points[i];
        if (!point || !Number.isFinite(Number(point.index))) continue;
        if (!connectGaps && current.length > 0
          && Number(point.index) - Number(current[current.length - 1].index) > CHART_GAP_SLOTS) {
          flush();
        }
        current.push(point);
      }
      flush();
      return { runs: runs, dots: dots };
    }

    // plan-05 B.6: rule-reason labels live in DICT under the reason_* keys
    // (single source of truth; the parity test covers them).

    // plan-05 B.6: prefer the live locale service (apply captures it); the
    // dictionary probe stays as the fallback for offline/unit contexts.
    var activeLocaleRef = null;
    var layoutServiceRef = null;
    function isChineseLocale(t) {
      try {
        var service = activeLocaleRef;
        var active = service && (service.activeLocale ?? service.locale ?? null);
        if (typeof active === "string" && active !== "") return active !== "en";
      } catch (_) { /* fall through to the dictionary probe */ }
      return format(t, "nav") === DICT.zh.nav;
    }

    function formatReasonCodes(t, codes) {
      return (codes || []).map(function (code) {
        if (!REASON_LABELS.zh[code] && !REASON_LABELS.en[code]) return code;
        var label = format(t, "reason_" + code);
        return label === "reason_" + code ? code : label;
      }).join(", ");
    }

    function analysisEnumLabel(t, kind, value) {
      if (!value) return "—";
      return format(t, "enum" + kind + "_" + value);
    }


    function analysisEnumHint(t, kind, value) {
      if (!value) return "";
      if (!ANALYSIS_ENUM_HINTS.zh[kind + "_" + value] && !ANALYSIS_ENUM_HINTS.en[kind + "_" + value]) return "";
      var label = format(t, "hint_" + kind + "_" + value);
      return label === "hint_" + kind + "_" + value ? "" : label;
    }

    // plan-05 B.6: hint parentheses follow the locale (EN gets half-width).
    function wrapHint(t, hintText) {
      return isChineseLocale(t) ? "（" + hintText + "）" : " (" + hintText + ")";
    }

    function humanizeAnalysisText(t, text) {
      return String(text).replace(/[A-Za-z_][A-Za-z0-9_]*/g, function (match) {
        if (!REASON_LABELS.zh[match] && !REASON_LABELS.en[match]) return match;
        var label = format(t, "reason_" + match);
        return label === "reason_" + match ? match : label;
      });
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

    // plan-05 B.6 (C-12): the per-code evidence fragments moved into DICT as
    // evidence_* entries; only the numeric extraction stays in code.
    function evidenceForCode(t, snap, code) {
      var inds = (snap && snap.indicators) || {};
      function ind(tf) { return inds["ind" + tf]; }
      function f(value, digits) { return fmtIndicator(value, digits); }
      function fill(codeKey, params) {
        var text = format(t, codeKey);
        if (text === codeKey) return "";
        if (params) for (var key in params) text = text.replace("{" + key + "}", String(params[key]));
        return text;
      }
      switch (code) {
        case "trend_ema20_up": {
          var up = ["10", "30", "60"].map(function (tf) { var i = ind(tf); return i ? f(i.ema20) : "—"; });
          return fill("evidence_trend_ema20_up", { values: up.join("/") });
        }
        case "trend_filter_not_met": {
          var vals = ["10", "30", "60"].map(function (tf) { var i = ind(tf); return i ? f(i.ema20) : "—"; });
          return fill("evidence_trend_filter_not_met", { values: vals.join("/") });
        }
        case "near_support": {
          var i5s = ind(5);
          return i5s ? fill("evidence_near_support", { value: f(i5s.recentLow) }) : "";
        }
        case "near_lower_band": {
          var i5b = ind(5);
          return i5b && i5b.boll ? fill("evidence_near_lower_band", { value: f(i5b.boll.lower) }) : "";
        }
        case "rsi_rebound":
        case "rsi_overbought": {
          var i5r = ind(5);
          return i5r ? fill("evidence_rsi_rebound", { value: f(i5r.rsi14, 1) }) : "";
        }
        case "break_below_sma20_with_profit": {
          var i5c = ind(5);
          return i5c ? fill("evidence_break_below_sma20_with_profit", { value: f(i5c.sma20) }) : "";
        }
        case "bearish_bar": {
          return ind(5) ? format(t, "evidence_bearish_bar") === "evidence_bearish_bar" ? "" : format(t, "evidence_bearish_bar") : "";
        }
        case "target_band_add": {
          var posA = snap && snap.position;
          var orderA = snap && snap.plan && snap.plan.suggestedOrder;
          var currentA = posA && Number.isFinite(Number(posA.grams)) ? Number(posA.grams) : 0;
          var add = orderA && Number.isFinite(Number(orderA.grams)) ? Number(orderA.grams) : 0;
          return add > 0 ? fill("evidence_target_band_add", { value: fmtIndicator(currentA + add) }) : "";
        }
        case "target_band_reduce": {
          var posR = snap && snap.position;
          var orderR = snap && snap.plan && snap.plan.suggestedOrder;
          var currentR = posR && Number.isFinite(Number(posR.grams)) ? Number(posR.grams) : 0;
          var sell = orderR && Number.isFinite(Number(orderR.grams)) ? Number(orderR.grams) : 0;
          return sell > 0 ? fill("evidence_target_band_reduce", { value: fmtIndicator(Math.max(0, currentR - sell)) }) : "";
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

    // Monotonic sequence for snapshot loads: a slow response that arrives
    // after a newer request must never overwrite fresher state, and bursts
    // of overlapping requests collapse naturally (only the latest seq wins).
    var snapSeq = 0;

    function useSnapshot(localeHint) {
      var state = useState(null);
      var snap = state[0];
      var setSnap = state[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var refreshRef = useRef(null);

      useEffect(function () {
        var alive = true;
        var timer = null;
        var failStreak = 0;

        var nextDelay = function () {
          if (failStreak > 0) {
            // Consecutive-failure backoff: 10s → 20s → 40s → capped at 60s.
            return Math.min(10000 * Math.pow(2, failStreak - 1), 60000);
          }
          return typeof document !== "undefined" && document.hidden ? 60000 : 10000;
        };
        var schedule = function () {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(load, nextDelay());
        };
        var load = function () {
          if (!alive) return;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          var seq = ++snapSeq;
          fetchJson(SNAPSHOT_URL, { headers: { "x-dsh-locale": localeHint === "en" ? "en" : "zh" } })
            .then(function (data) {
              if (!alive || seq !== snapSeq) return;
              if (data && data.ok) {
                failStreak = 0;
                setSnap(data);
                setError("");
              } else {
                failStreak += 1;
                setError(clientErrorText(null, data && data.error, "BAD_RESPONSE"));
              }
              schedule();
            })
            .catch(function (err) {
              if (!alive || seq !== snapSeq) return;
              failStreak += 1;
              setError(clientErrorText(null, "BAD_RESPONSE", "BAD_RESPONSE"));
              schedule();
            });
        };
        var onRefresh = function () {
          load();
        };
        var onVisibilityChange = function () {
          // Coming back to the tab refreshes immediately; hiding just
          // re-arms the slower hidden-interval timer.
          if (typeof document !== "undefined" && !document.hidden) load();
          else schedule();
        };
        var onOnline = function () {
          load();
        };
        refreshRef.current = load;
        load();
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", onVisibilityChange);
          document.addEventListener("dsh-plugin-goldboard:refresh", onRefresh);
        }
        if (typeof window !== "undefined") {
          window.addEventListener("online", onOnline);
        }
        return function () {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (refreshRef.current === load) refreshRef.current = null;
          if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisibilityChange);
            document.removeEventListener("dsh-plugin-goldboard:refresh", onRefresh);
          }
          if (typeof window !== "undefined") {
            window.removeEventListener("online", onOnline);
          }
        };
      }, [localeHint]);

      return {
        snap: snap,
        error: error,
        loading: snap === null && error === "",
        refresh: function () {
          if (refreshRef.current) refreshRef.current();
        },
      };
    }

    // ── small components ───────────────────────────────────────────────────

    var Sparkline = ReactMemo(function Sparkline(props) {
      var hoverState = useState(-1);
      var hoverIndex = hoverState[0];
      var setHoverIndex = hoverState[1];
      var bars = props.bars;
      var connectGaps = props.connectGaps === true;
      var tradingHours = props.tradingHours;
      if (!Array.isArray(bars) || bars.length < 2) return null;
      var width = props.width ?? 320;
      var height = props.height ?? 64;
      var serverTime = props.serverTime;
      var nowMinutes = serverTime ? beijingMinutes(serverTime) : null;
      var nowIndex = nowMinutes === null ? null : tradingMinuteIndex(nowMinutes, tradingHours);
      var totalMinutes = tradingDayTotalMinutes(tradingHours) || 1;
      var filtered = bars.filter(function (bar) {
        if (!bar || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) return false;
        var minute = beijingMinutes(bar.t);
        return minute !== null && tradingMinuteIndex(minute, tradingHours) !== null;
      });
      if (nowIndex !== null) {
        filtered = filtered.filter(function (bar) {
          var idx = tradingMinuteIndex(beijingMinutes(bar.t), tradingHours);
          return idx !== null && idx <= nowIndex;
        });
      }
      if (filtered.length < 2) return null;
      var closes = filtered.map(function (bar) { return Number(bar.c); });
      var times = filtered.map(function (bar) { return tradingMinuteIndex(beijingMinutes(bar && bar.t), tradingHours); });
      var min = Math.min.apply(null, closes);
      var max = Math.max.apply(null, closes);
      var range = max - min || 1;
      function xForTime(index) { return (index / totalMinutes) * width; }
      function yFor(value) { return height - (value - min) / range * (height - 4) - 2; }
      // chartRuns decides where the line breaks; single samples come back as
      // dots so a sparse day (or the 昨收 anchor) is still visible instead of
      // silently vanishing.
      var plotted = chartRuns(filtered.map(function (bar, i) {
        return { index: times[i], value: closes[i] };
      }), connectGaps);
      var segments = plotted.runs.map(function (run) {
        return run.map(function (point) {
          return xForTime(point.index).toFixed(2) + "," + yFor(point.value).toFixed(2);
        });
      });
      var dots = plotted.dots.map(function (point) {
        return { x: xForTime(point.index), y: yFor(point.value) };
      });
      var color = closes[closes.length - 1] >= closes[0] ? "var(--dsw-alias-state-error-primary,#e5484d)" : "var(--dsw-alias-state-success-primary,#3c9a5f)";
      var unit = props.unit || "";
      var onMouseMove = function (event) {
        var rect = event.currentTarget.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        var ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        var targetIndex = ratio * totalMinutes;
        var best = 0;
        var bestDiff = Infinity;
        for (var i = 0; i < times.length; i += 1) {
          var diff = Math.abs(times[i] - targetIndex);
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
      dots.forEach(function (dot) {
        children.push(el("circle", { cx: dot.x.toFixed(2), cy: dot.y.toFixed(2), r: 2, fill: color }));
      });
      if (nowIndex !== null) {
        var nowX = xForTime(nowIndex);
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
          fill: "var(--dsw-alias-bg-layer-3)",
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
    });

    function Switch(props) {
      return el("button", {
        type: "button",
        role: "switch",
        "aria-label": props.label,
        title: props.title ?? props.label,
        "aria-checked": props.checked === true,
        disabled: props.disabled === true,
        className: "dsh-goldboard-switch" + (props.checked ? " dsh-goldboard-switch-on" : ""),
        onClick: function () { props.onChange(!props.checked); },
      }, el("span", { className: "dsh-goldboard-switch-knob" }));
    }

    function NumberField(props) {
      return el("label", { className: "dsh-goldboard-field" },
        el("span", null, props.label),
        el("input", {
          className: "dsh-goldboard-input",
          type: "number",
          step: props.step ?? "any",
          min: props.min,
          max: props.max,
          disabled: props.disabled === true,
          value: props.value,
          onChange: function (event) { props.onChange(event.target.value); },
        }),
      );
    }

    function TextField(props) {
      return el("label", { className: "dsh-goldboard-field" },
        el("span", null, props.label),
        el("input", {
          className: "dsh-goldboard-input",
          type: props.type ?? "text",
          placeholder: props.placeholder,
          disabled: props.disabled === true,
          value: props.value,
          onChange: function (event) { props.onChange(event.target.value); },
        }),
      );
    }

    function SelectField(props) {
      return el("label", { className: "dsh-goldboard-field" },
        el("span", null, props.label),
        el("select", {
          className: "dsh-goldboard-input dsh-goldboard-select",
          value: props.value ?? "",
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value); },
        }, (props.options || []).map(function (option) {
          return el("option", { key: option.value, value: option.value, disabled: option.disabled === true }, option.label);
        })),
      );
    }

    function analysisErrorText(t, code) {
      var key = "error_" + String(code || "ANALYSIS_FAILED");
      var translated = format(t, key);
      return translated === key ? format(t, "error_ANALYSIS_FAILED") : translated;
    }

    function clientErrorText(t, error, fallbackCode) {
      var code = error && typeof error === "object" ? error.code : error;
      var key = "error_" + String(code || fallbackCode || "BAD_RESPONSE");
      var translated = format(t, key);
      return translated === key ? format(t, "error_" + String(fallbackCode || "BAD_RESPONSE")) : translated;
    }

    function analysisStatusLabel(t, status) {
      var key = "status_" + String(status || "error");
      var translated = format(t, key);
      return translated === key ? String(status || "") : translated;
    }

    function CardRow(props) {
      return el("div", {
        id: props.id,
        className: "dsh-goldboard-card-row" + (props.className ? " " + props.className : ""),
      },
        props.title || props.titleExtra ? el("div", { className: "dsh-goldboard-card-row-header" },
          props.title ? el("h3", null, props.title) : null,
          props.titleExtra || null,
        ) : null,
        props.hint ? el("div", { className: "dsh-goldboard-hint" }, props.hint) : null,
        props.children,
      );
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      return new Promise(function (resolve, reject) {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
        document.body.removeChild(textarea);
        if (ok) resolve();
        else reject(new Error("clipboard unavailable"));
      });
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


    // ── sidebar page shell ─────────────────────────────────────────────────

    function platformKind() {
      try {
        var value = document.documentElement && document.documentElement.dataset ? document.documentElement.dataset.platform : "";
        if (typeof value === "string" && value !== "") return value;
      } catch (_) { /* ignore */ }
      try {
        if (typeof location !== "undefined" && location.protocol === "dsh-app:") return "desktop";
      } catch (_) { /* ignore */ }
      try {
        if (typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.protocolVersion === 1) return "desktop";
      } catch (_) { /* ignore */ }
      return "web";
    }

    function isDesktop() {
      return platformKind() !== "web";
    }

    function tabLabel(t, id) {
      return format(t, "tab_" + id);
    }

    var SIDEBAR_PRICE_CHOICES = ["AU9999", "XAU", "CMB"];

    function firstTrendClose(snap, lane) {
      var bars = snap && snap.trend && snap.trend[lane + "_1m"];
      if (!Array.isArray(bars)) return NaN;
      for (var i = 0; i < bars.length; i += 1) {
        var value = Number(bars[i] && bars[i].c);
        if (Number.isFinite(value) && value > 0) return value;
      }
      return NaN;
    }

    function sidebarQuote(snap, preference) {
      if (!snap || !snap.quotes) return null;
      var manual = snap.manualPrevClose || {};
      if (preference === "XAU") {
        var xau = snap.quotes.XAU;
        if (!xau || !Number.isFinite(Number(xau.price))) return null;
        var xauPrev = Number(xau.prevClose);
        if (!Number.isFinite(xauPrev)) xauPrev = Number(manual.XAU);
        if (!Number.isFinite(xauPrev)) xauPrev = firstTrendClose(snap, "XAU");
        return {
          price: Number(xau.price),
          prevClose: xauPrev,
          stale: xau.stale === true,
          prefix: "$",
          labelKey: "sidebarPriceXAU",
        };
      }
      if (preference === "CMB") {
        var cmb = snap.derived && snap.derived.cmb;
        var cmbQuote = snap.quotes.CMB;
        if (!cmb || !Number.isFinite(Number(cmb.buyPrice))) return null;
        var cmbPrev = cmbQuote && Number(cmbQuote.prevClose);
        if (!Number.isFinite(cmbPrev)) cmbPrev = Number(manual.CMB);
        if (!Number.isFinite(cmbPrev)) cmbPrev = firstTrendClose(snap, "CMB");
        return {
          price: Number(cmb.buyPrice),
          prevClose: cmbPrev,
          stale: !!(cmbQuote && cmbQuote.stale),
          prefix: "¥",
          labelKey: "sidebarPriceCMB",
        };
      }
      var domestic = snap.quotes.AU9999;
      if (!domestic || !Number.isFinite(Number(domestic.price))) return null;
      var domesticPrev = Number(domestic.prevClose);
      if (!Number.isFinite(domesticPrev)) domesticPrev = Number(manual.AU9999);
      if (!Number.isFinite(domesticPrev)) domesticPrev = firstTrendClose(snap, "AU9999");
      return {
        price: Number(domestic.price),
        prevClose: domesticPrev,
        stale: domestic.stale === true,
        prefix: "¥",
        labelKey: "sidebarPriceDomestic",
      };
    }

    /**
     * Lightweight sidebar quote poller. The sidebar entry is mounted for the
     * whole app lifetime, so it keeps its own low-frequency snapshot watcher
     * instead of depending on the Gold Board page being open.
     */
    function useSidebarGold(t) {
      var state = useState({ preference: "AU9999", text: "", tone: "dsh-goldboard-flat", title: "" });
      var prefRef = useRef("AU9999");
      var snapRef = useRef(null);
      useEffect(function () {
        var alive = true;
        var timer = null;
        var configTicks = 0;
        var set = state[1];
        function render(snap, preference) {
          var quote = sidebarQuote(snap, preference);
          if (!quote) {
            set(function (previous) { return Object.assign({}, previous, { text: "" }); });
            return;
          }
          var tone = quote.stale ? "dsh-goldboard-flat" : changeClass(quote.price, quote.prevClose);
          set(function (previous) {
            return Object.assign({}, previous, {
              preference: preference,
              text: quote.prefix + fmtPrice(quote.price),
              tone: tone,
              title: format(t, quote.labelKey || "sidebarPriceDomestic") + " " + quote.prefix + fmtPrice(quote.price),
            });
          });
        }
        function loadConfig() {
          fetchJson(CONFIG_URL).then(function (body) {
            if (!alive || !body || body.ok !== true || !body.config) return;
            var preference = SIDEBAR_PRICE_CHOICES.indexOf(body.config.sidebarPrice) !== -1 ? body.config.sidebarPrice : "AU9999";
            prefRef.current = preference;
            render(snapRef.current, preference);
          }).catch(function () { /* keep the current preference */ });
        }
        function schedule(ms) {
          if (!alive) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            if (typeof document !== "undefined" && document.hidden) schedule(60000);
            else loadSnapshot();
          }, ms || 15000);
        }
        function loadSnapshot() {
          fetchJson(SNAPSHOT_URL).then(function (body) {
            if (!alive) return;
            if (body && body.ok) {
              snapRef.current = body;
              render(body, prefRef.current);
              configTicks += 1;
              if (configTicks % 4 === 0) loadConfig();
            }
            schedule(15000);
          }).catch(function () { schedule(30000); });
        }
        function onRefresh() {
          loadConfig();
          loadSnapshot();
        }
        function onVisibility() {
          if (typeof document !== "undefined" && !document.hidden) loadSnapshot();
        }
        loadConfig();
        loadSnapshot();
        if (typeof document !== "undefined") {
          document.addEventListener("dsh-plugin-goldboard:refresh", onRefresh);
          document.addEventListener("visibilitychange", onVisibility);
        }
        return function () {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (typeof document !== "undefined") {
            document.removeEventListener("dsh-plugin-goldboard:refresh", onRefresh);
            document.removeEventListener("visibilitychange", onVisibility);
          }
        };
      }, [t]);
      return state[0];
    }

    function GoldBoardIcon(props) {
      var size = Number(props && props.size) > 0 ? Number(props.size) : 16;
      var side = useSidebarGold(props && props.t);
      return el("span", { className: "dsh-goldboard-side-glyph" },
        el("svg", {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
          el("circle", { cx: 8, cy: 8, r: 6.3, stroke: "currentColor", strokeWidth: 1.3 }),
          el("path", { d: "M5.7 5.2 8 7.8l2.3-2.6M5.5 8.5h5M5.5 10.7h5", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round", strokeLinejoin: "round" }),
        ),
        side && side.text ? el("span", {
          className: "dsh-goldboard-side-price " + (side.tone || "dsh-goldboard-flat"),
          title: side.title,
        }, side.text) : null,
      );
    }

    function IconRefresh() {
      return el("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        el("path", { d: "M13.2 7.1A5.3 5.3 0 1 0 13 10", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
        el("path", { d: "M13.4 3.4v3.5H9.9", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
      );
    }

    function IconSettings() {
      return el("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        el("path", { d: "M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z", stroke: "currentColor", strokeWidth: 1.4 }),
        el("path", { d: "M13.1 9.7c.1-.4.2-.8.2-1.2s-.1-.8-.2-1.2l1-.8-1.1-1.9-1.2.5c-.6-.5-1.2-.8-1.9-1L9.6 2.6H7.4l-.3 1.5c-.7.2-1.3.5-1.9 1l-1.2-.5-1.1 1.9 1 .8c-.1.4-.2.8-.2 1.2s.1.8.2 1.2l-1 .8 1.1 1.9 1.2-.5c.6.5 1.2.8 1.9 1l.3 1.5h2.2l.3-1.5c.7-.2 1.3-.5 1.9-1l1.2.5 1.1-1.9-1-.8Z", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }),
      );
    }

    function IconCopy() {
      return el("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        el("rect", { x: 5.3, y: 5.3, width: 7.2, height: 7.2, rx: 1.2, stroke: "currentColor", strokeWidth: 1.3 }),
        el("path", { d: "M10.2 5.2V4.1c0-.7-.6-1.3-1.3-1.3H4.1c-.7 0-1.3.6-1.3 1.3v4.8c0 .7.6 1.3 1.3 1.3h1.1", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
      );
    }

    class PageErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        try { console.error("dsh-plugin-goldboard: page render failed", error, info); } catch (_) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          var t = this.props.t;
          return el("div", { className: "dsh-goldboard-page" },
            el("div", { className: "dsh-goldboard-page-inner" },
              el("div", { className: "dsh-goldboard-render-error" },
                el("strong", null, format(t, "renderError")),
                el("span", null, format(t, "renderErrorHint")),
                el("button", {
                  type: "button",
                  className: "dsh-goldboard-btn",
                  onClick: function () { this.setState({ error: null }); }.bind(this),
                }, format(t, "retry")),
                el("details", null,
                  el("summary", null, format(t, "renderErrorDetails")),
                  el("pre", null, String(this.state.error && this.state.error.stack || this.state.error)),
                ),
              ),
            ),
          );
        }
        return this.props.children;
      }
    }

    // plan-05 B.3: QuoteItem and CmbQuoteItem were ~90% identical; the shell
    // below owns the card chrome (className / click handling / label+tip) and
    // each variant only renders its own value block.
    function quoteCardShell(props) {
      var className = "dsh-goldboard-item" +
        (props.clickable ? " dsh-goldboard-item-clickable" : "") +
        (props.active ? " dsh-goldboard-item-active" : "") +
        (props.className ? " " + props.className : "");
      return {
        common: {
          className: className,
          onClick: props.onClick,
          role: props.onClick ? "button" : undefined,
          tabIndex: props.onClick ? 0 : undefined,
          "aria-pressed": props.onClick ? props.active === true : undefined,
          onKeyDown: props.onClick ? function (event) {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onClick();
            }
          } : undefined,
        },
        labelNode: el("div", { className: "dsh-goldboard-item-label" },
          el("span", { className: "dsh-goldboard-item-label-text" }, props.label),
          props.tip ? el(InfoTip, { text: props.tip, align: props.tipAlign }) : null,
        ),
      };
    }

    function QuoteItem(props) {
      var quote = props.quote;
      var t = props.t;
      var shell = quoteCardShell(props);
      var common = shell.common;
      var labelNode = shell.labelNode;
      if (!quote) return el("div", common,
        labelNode,
        el("div", { className: "dsh-goldboard-item-value" }, "—"),
      );
      var pct = changePct(quote.price, quote.prevClose);
      var prevClose = Number(quote.prevClose);
      var hasPrevClose = Number.isFinite(prevClose) && prevClose > 0;
      return el("div", common,
        labelNode,
        el("div", { className: "dsh-goldboard-item-value " + changeClass(quote.price, quote.prevClose) },
          fmtPrice(quote.price),
          props.unit ? " " + props.unit : null,
        ),
        pct !== null ? el("div", { className: "dsh-goldboard-meta" },
          el("span", { className: changeClass(quote.price, quote.prevClose) }, fmtSigned(Number(quote.price) - Number(quote.prevClose))),
          el("span", { className: changeClass(quote.price, quote.prevClose) }, fmtSigned(pct) + "%"),
          hasPrevClose ? el("span", null, format(t, "prevClose") + " " + fmtPrice(prevClose)) : null,
          quote.stale ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-warn" }, props.staleLabel) : null,
        ) : null,
      );
    }

    /** CMB card styled exactly like the domestic / international quote cards. */
    function CmbQuoteItem(props) {
      var cmb = props.cmb;
      var t = props.t;
      var shell = quoteCardShell(props);
      var common = shell.common;
      var labelNode = shell.labelNode;
      if (!cmb || !Number.isFinite(Number(cmb.buyPrice))) {
        return el("div", common,
          labelNode,
          el("div", { className: "dsh-goldboard-item-value" }, "—"),
        );
      }
      var preferredPrevClose = props.preferredPrevClose;
      var basePrice = props.fallbackBasePrice;
      var basePrevClose = props.fallbackPrevClose;
      var spread = basePrice && Number.isFinite(Number(basePrice))
        ? Number(cmb.buyPrice) - Number(basePrice)
        : null;
      var prevClose = preferredPrevClose && Number.isFinite(Number(preferredPrevClose)) && Number(preferredPrevClose) > 0
        ? Number(preferredPrevClose)
        : (spread !== null && basePrevClose && Number.isFinite(Number(basePrevClose))
          ? Number(basePrevClose) + spread
          : null);
      var pct = prevClose !== null ? changePct(cmb.buyPrice, prevClose) : null;
      var sellDisplay = cmb.sellPrice;
      var cmbQuote = props.cmbQuote;
      var cmbStale = !!(cmb && cmb.live && cmbQuote && cmbQuote.stale);
      var fallbackStale = !!(cmb && !cmb.live && props.fallbackStale);
      var showStale = cmbStale || fallbackStale;
      return el("div", common,
        labelNode,
        el("div", { className: "dsh-goldboard-item-value " + (pct !== null ? changeClass(cmb.buyPrice, prevClose) : "dsh-goldboard-flat") }, fmtPrice(cmb.buyPrice)),
        el("div", { className: "dsh-goldboard-meta" },
          pct !== null ? el("span", { className: changeClass(cmb.buyPrice, prevClose) }, fmtSigned(Number(cmb.buyPrice) - Number(prevClose))) : null,
          pct !== null ? el("span", { className: changeClass(cmb.buyPrice, prevClose) }, fmtSigned(pct) + "%") : null,
          prevClose !== null ? el("span", null, format(t, "prevClose") + " " + fmtPrice(prevClose)) : null,
          cmb && cmb.live === false ? el("span", { className: "dsh-goldboard-tag" }, format(t, "cmbEstimate")) : null,
          showStale ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-warn" }, props.staleLabel) : null,
          el("span", { className: "dsh-goldboard-cmb-prices" },
            format(t, "buy") + " " + fmtPrice(cmb.buyPrice) + " / " + format(t, "sell") + " " + fmtPrice(sellDisplay),
          ),
        ),
      );
    }

    function orderCmbDisplayPrice(snap, order) {
      if (!snap || !order) return "";
      return order.cmbEstimatedPrice;
    }

    function buildOrderText(snap, t) {
      var plan = snap && snap.plan;
      var order = plan && plan.suggestedOrder;
      if (!order) return "";
      var side = order.side === "buy" ? format(t, "buy") : format(t, "sell");
      var risk = order.risk || plan.risk;
      return [
        "[" + format(t, "boardTitle") + "]",
        side + " " + format(t, "action_" + order.action),
        order.instrument + " " + order.grams + format(t, "grams"),
        order.instrument + ": " + fmtPrice(order.signalPrice),
        "CMB: " + fmtPrice(orderCmbDisplayPrice(snap, order)) + " · " + format(t, "cmbAppNote"),
        "Target: " + fmtPrice(snap.plan.targetPrice) + " · " + format(t, "breakeven") + ": " + fmtPrice(snap.plan.breakeven),
        risk && Number(risk.nominalAmountCny) > 0 ? format(t, "riskNominalAmount") + ": ¥" + fmtPrice(risk.nominalAmountCny) : null,
        risk && Number(risk.worstCaseLossCny) > 0 ? format(t, "riskWorstCaseLoss") + ": ¥" + fmtPrice(risk.worstCaseLossCny) : null,
        risk && risk.riskBudgetRatio !== null && risk.riskBudgetRatio !== undefined ? format(t, "riskBudgetRatio") + ": " + (Number(risk.riskBudgetRatio) * 100).toFixed(2) + "%" : null,
        format(t, "validUntil") + ": " + (order.validUntil ?? "—"),
        format(t, "riskNote"),
      ].filter(Boolean).join("\n");
    }

    function laneLabel(t, lane) {
      var key = "lane_" + String(lane || "unknown");
      var translated = format(t, key);
      return translated === key ? String(lane || "—") : translated;
    }

    function OverviewTab(props) {
      var t = props.t;
      var snap = props.snap;
      var error = props.error;
      var loading = props.loading;
      var chartKeyState = useState("AU9999");
      var chartKey = chartKeyState[0];
      var setChartKey = chartKeyState[1];
      var gapModeState = useState("break");
      var gapMode = gapModeState[0];
      var setGapMode = gapModeState[1];
      var copiedState = useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var copiedTimerRef = useRef(null);

      var domestic = snap && snap.quotes && snap.quotes.AU9999;
      var xau = snap && snap.quotes && snap.quotes.XAU;
      var usdcny = snap && snap.quotes && snap.quotes.USDCNY;
      var derived = snap && snap.derived;
      var plan = snap && snap.plan;
      var position = snap && snap.position;
      var risk = snap && snap.risk;
      var planRisk = plan && plan.risk;
      var snapshotRiskGate = risk && risk.gate;
      var trendAU = snap && snap.trend && snap.trend.AU9999_1m;
      var trendXAU = snap && snap.trend && snap.trend.XAU_1m;
      var trendCMB = snap && snap.trend && snap.trend.CMB_1m;
      var fallbackBasePrice = derived && Number.isFinite(derived.xauCnyPerGram) ? derived.xauCnyPerGram : null;
      var fallbackPrevClose = null;
      if (xau && usdcny && Number.isFinite(Number(xau.prevClose)) && Number.isFinite(Number(usdcny.price))) {
        fallbackPrevClose = Math.round(Number(xau.prevClose) * Number(usdcny.price) / 31.1034768 * 100) / 100;
      }
      var cmbManualPrevClose = snap && snap.manualPrevClose && Number.isFinite(Number(snap.manualPrevClose.CMB)) && Number(snap.manualPrevClose.CMB) > 0
        ? Number(snap.manualPrevClose.CMB)
        : null;
      var cmbMidnightPrice = findBarAtBeijingMinute(trendCMB, snap && snap.serverTime, 0);
      var cmbPreferredPrevClose = cmbManualPrevClose !== null
        ? cmbManualPrevClose
        : (cmbMidnightPrice !== null && Number.isFinite(Number(cmbMidnightPrice)) && Number(cmbMidnightPrice) > 0
          ? Number(cmbMidnightPrice)
          : null);
      var fallbackStale = !!(derived && derived.cmb && !derived.cmb.live && (
        (xau && xau.stale) || (usdcny && usdcny.stale)
      ));
      var chartPipeline = useMemo(function () {
        var raw = filterTodayBars(chartKey === "XAU" ? trendXAU : chartKey === "CMB" ? trendCMB : trendAU, snap && snap.serverTime, snap && snap.market);
        var basePrice = null;
        if (chartKey === "AU9999") {
          basePrice = domestic && domestic.prevClose;
        } else if (chartKey === "XAU") {
          basePrice = xau && xau.prevClose;
        } else if (chartKey === "CMB" && derived && derived.cmb && (cmbPreferredPrevClose !== null || fallbackBasePrice !== null)) {
          basePrice = cmbPreferredPrevClose !== null
            ? cmbPreferredPrevClose
            : (fallbackPrevClose !== null
              ? Number(fallbackPrevClose) + (Number(derived.cmb.buyPrice) - Number(fallbackBasePrice))
              : null);
        }
        var withBase = withChartBaseline(raw, basePrice, snap && snap.serverTime);
        return {
          bars: fillMissingChartSlots(withBase, snap && snap.serverTime, basePrice, snap && snap.market),
          hasTrend: hasChartPoints(withBase, snap && snap.market),
          basePrice: basePrice,
        };
      }, [snap, chartKey, gapMode, cmbPreferredPrevClose, fallbackBasePrice, fallbackPrevClose, domestic, xau, derived, trendAU, trendXAU, trendCMB]);
      var chartBars = chartPipeline.bars;
      var hasTrend = chartPipeline.hasTrend;
      var chartStats = useMemo(function () {
        var rows = (chartBars || []).filter(function (bar) {
          return bar && bar.baseline !== true && Number.isFinite(Number(bar.c)) && Number(bar.c) > 0;
        });
        if (rows.length === 0) return null;
        var closes = rows.map(function (bar) { return Number(bar.c); });
        return {
          open: closes[0],
          high: Math.max.apply(null, closes),
          low: Math.min.apply(null, closes),
          last: closes[closes.length - 1],
        };
      }, [chartBars]);
      var cmbPrice = derived && derived.cmb && Number.isFinite(Number(derived.cmb.buyPrice)) ? Number(derived.cmb.buyPrice) : null;
      var nextOpen = snap && snap.market && snap.market.nextOpen;

      useEffect(function () {
        return function () {
          if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        };
      }, []);
      var flashCopied = function () {
        setCopied(true);
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(function () { setCopied(false); copiedTimerRef.current = null; }, 1800);
      };
      var onCopy = function () {
        var text = buildOrderText(snap, t);
        if (!text) return;
        copyText(text).then(flashCopied).catch(function () { setCopied(false); });
      };

      if (!snap) {
        return el("div", { className: "dsh-goldboard-overview" },
          error ? el("div", { className: "dsh-goldboard-banner dsh-goldboard-banner-error" },
            el("span", null, error),
            el("button", { type: "button", className: "dsh-goldboard-btn", onClick: props.onRefresh }, format(t, "retry")),
          ) : null,
          el("div", { className: "dsh-goldboard-card-row" }, el("div", { className: "dsh-goldboard-loading" }, loading ? format(t, "loading") : format(t, "noData"))),
        );
      }

      var riskGate = snapshotRiskGate;
      var positionGrams = position && Number(position.grams) > 0 ? Number(position.grams) : 0;
      var pnlAvailable = position && position.valuationAvailable !== false;
      var dailyLoss = risk && risk.losses ? risk.losses.dailyLossCny : null;
      var weeklyLoss = risk && risk.losses ? risk.losses.weeklyLossCny : null;
      var drawdown = risk && risk.losses ? risk.losses.drawdownCny : null;
      var addsToday = risk && risk.adds ? risk.adds.today : null;
      var setupAdds = risk && risk.adds ? risk.adds.activeSetup : null;

      return el("div", { className: "dsh-goldboard-overview" },
        error ? el("div", { className: "dsh-goldboard-banner dsh-goldboard-banner-error" },
          el("span", null, error),
          el("button", { type: "button", className: "dsh-goldboard-btn", onClick: props.onRefresh }, format(t, "retry")),
        ) : null,
        el("div", { className: "dsh-goldboard-quote-grid" },
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
            fallbackBasePrice: fallbackBasePrice,
            fallbackPrevClose: fallbackPrevClose,
            preferredPrevClose: cmbPreferredPrevClose,
            fallbackStale: fallbackStale,
            staleLabel: format(t, "stale"),
            t: t,
            clickable: true,
            active: chartKey === "CMB",
            onClick: function () { setChartKey("CMB"); },
            tip: derived && derived.cmb ? format(t, "cmbAppNote") : null,
            tipAlign: "left",
          }),
        ),
        el("div", { className: "dsh-goldboard-dashboard-grid" },
          el("div", { className: "dsh-goldboard-dashboard-main" },
            el("div", { className: "dsh-goldboard-card-row" },
              el("div", { className: "dsh-goldboard-chart-block" },
                el("div", { className: "dsh-goldboard-chart-head" },
                  el("div", { className: "dsh-goldboard-chart-title" }, format(t, "todayTrend")),
                  el("div", { className: "dsh-goldboard-chart-tools" },
                    el("div", { className: "dsh-goldboard-series", role: "group", "aria-label": format(t, "todayTrend") },
                      ["AU9999", "XAU", "CMB"].map(function (key) {
                        return el("button", {
                          key: key,
                          type: "button",
                          "aria-pressed": chartKey === key,
                          onClick: function () { setChartKey(key); },
                        }, key === "AU9999" ? format(t, "au9999") : key === "XAU" ? format(t, "xau") : format(t, "cmbEstimate"));
                      }),
                    ),
                    el("button", {
                      type: "button",
                      className: "dsh-goldboard-chart-toggle",
                      "aria-pressed": gapMode === "connect",
                      onClick: function () { setGapMode(gapMode === "break" ? "connect" : "break"); },
                    }, gapMode === "break" ? format(t, "gapBreak") : format(t, "gapConnect")),
                  ),
                ),
                snap.marketState === "closed"
                  ? el("div", { className: "dsh-goldboard-trend-empty" }, nextOpen ? format(t, "todayClosedNext", { time: formatBeijingTime(nextOpen, false) + "（" + format(t, "beijingTime") + "）" }) : format(t, "marketClosed"))
                  : hasTrend
                    ? el("div", { className: "dsh-goldboard-chart" },
                        el(Sparkline, { key: chartKey, bars: chartBars, serverTime: snap.serverTime, width: 960, height: 200, unit: chartKey === "XAU" ? " $/oz" : " ¥/g", connectGaps: gapMode === "connect", tradingHours: snap.market }),
                      )
                    : el("div", { className: "dsh-goldboard-trend-empty" }, format(t, "noTrend")),
                chartStats ? el("div", { className: "dsh-goldboard-chart-stats" },
                  el("span", { className: "dsh-goldboard-chart-stat" }, format(t, "chartOpen"), el("b", null, fmtPrice(chartStats.open))),
                  el("span", { className: "dsh-goldboard-chart-stat" }, format(t, "chartHigh"), el("b", null, fmtPrice(chartStats.high))),
                  el("span", { className: "dsh-goldboard-chart-stat" }, format(t, "chartLow"), el("b", null, fmtPrice(chartStats.low))),
                  el("span", { className: "dsh-goldboard-chart-stat" }, format(t, "chartLast"), el("b", null, fmtPrice(chartStats.last))),
                ) : null,
              ),
            ),
            plan ? el("div", { className: "dsh-goldboard-plan" },
              el("div", { className: "dsh-goldboard-plan-title" },
                el("span", null, format(t, "planTitle") + " · " + planActionLabel(t, plan.action)),
                plan.suggestedOrder ? el("button", {
                  type: "button",
                  className: "dsh-goldboard-btn",
                  onClick: onCopy,
                  title: format(t, "copyOrder"),
                }, el(IconCopy), copied ? format(t, "copied") : format(t, "copyOrder")) : null,
              ),
              riskGate ? el("div", { className: "dsh-goldboard-risk-gate" + (riskGate.triggered ? " dsh-goldboard-risk-gate-blocked" : "") },
                el("span", null, format(t, riskGate.triggered ? "riskGateBlocked" : "riskGateOpen")),
                riskGate.triggered ? el("span", null, format(t, "riskGateProtectiveExitAllowed")) : null,
              ) : null,
              snap.pendingOrder && !plan.suggestedOrder ? el("div", { className: "dsh-goldboard-plan-row" },
                el("span", null, format(t, "pendingOrder")),
                el("span", { title: format(t, "orderStanding") }, (snap.pendingOrder.side === "buy" ? format(t, "buy") : format(t, "sell")) + " " + fmtPrice(snap.pendingOrder.cmbEstimatedPrice) + " × " + snap.pendingOrder.grams + format(t, "grams") + " · " + format(t, "orderStanding")),
              ) : null,
              (plan.action === "data_incomplete" || Object.values(plan.dataCoverageDetails || {}).some(function (detail) { return detail && detail.reanchored === true; })) && plan.dataCoverage ? el("div", { className: "dsh-goldboard-plan-row" },
                el("span", null, format(t, "dataCoverage")),
                el("span", null, [5, 10, 30, 60].map(function (w) {
                  var pct = Number(plan.dataCoverage[w]);
                  var detail = plan.dataCoverageDetails && plan.dataCoverageDetails[w];
                  var text = w + "m " + (Number.isFinite(pct) ? Math.round(pct * 100) : 0) + "%";
                  if (detail && (detail.reanchored === true || Number(detail.effectiveSampleMinutes) < w)) {
                    text += " (" + format(t, "coverageEffective", { effective: detail.effectiveSampleMinutes, window: w }) + ")";
                  }
                  return text;
                }).join(" · ")),
              ) : null,
              el("div", { className: "dsh-goldboard-plan-row" },
                el("span", null, format(t, "confidence")),
                el("span", null, (plan.ruleScore ?? plan.confidenceScore ?? "—") + "/" + (plan.ruleScoreMax ?? plan.confidenceMax ?? 8)),
              ),
              plan.breakeven !== undefined ? el("div", { className: "dsh-goldboard-plan-row" }, el("span", null, format(t, "breakeven")), el("span", null, "¥" + fmtPrice(plan.breakeven) + "/g")) : null,
              plan.targetPrice !== undefined ? el("div", { className: "dsh-goldboard-plan-row" }, el("span", null, format(t, "targetPrice")), el("span", null, "¥" + fmtPrice(plan.targetPrice) + "/g")) : null,
              plan.stopPrice !== undefined ? el("div", { className: "dsh-goldboard-plan-row" }, el("span", null, format(t, "stopPrice")), el("span", null, "¥" + fmtPrice(plan.stopPrice) + "/g")) : null,
              plan.targetTrailLine !== null && plan.targetTrailLine !== undefined ? el("div", { className: "dsh-goldboard-plan-row" }, el("span", null, format(t, "targetTrailLine")), el("span", null, "¥" + fmtPrice(plan.targetTrailLine) + "/g")) : null,
              plan.suggestedOrder ? el("div", { className: "dsh-goldboard-plan-action" },
                el("span", null, (plan.suggestedOrder.side === "buy" ? format(t, "buy") : format(t, "sell")) + " " + format(t, "suggest")),
                el("span", null, "¥" + fmtPrice(orderCmbDisplayPrice(snap, plan.suggestedOrder)) + " × " + plan.suggestedOrder.grams + format(t, "grams")),
              ) : null,
              plan.reasonCodes && plan.reasonCodes.length > 0 ? el("div", { className: "dsh-goldboard-plan-reason" }, format(t, "reason") + ": " + formatDetailedReasons(t, snap)) : null,
              planRisk ? el("div", { className: "dsh-goldboard-risk-details" },
                Number(planRisk.nominalAmountCny) > 0 ? el("span", null, format(t, "riskNominalAmount") + " ¥" + fmtPrice(planRisk.nominalAmountCny)) : null,
                el("span", null, format(t, "riskStopDistance") + " ¥" + fmtPrice(planRisk.stopDistancePerGram) + "/g"),
                el("span", null, format(t, "riskPerGram") + " ¥" + fmtPrice(planRisk.riskPerGram) + "/g"),
                Number(planRisk.worstCaseLossCny) > 0 ? el("span", null, format(t, "riskWorstCaseLoss") + " ¥" + fmtPrice(planRisk.worstCaseLossCny)) : null,
                planRisk.availableRiskBudgetCny !== null && planRisk.availableRiskBudgetCny !== undefined ? el("span", null, format(t, "riskAvailableBudget") + " ¥" + fmtPrice(planRisk.availableRiskBudgetCny)) : null,
                planRisk.riskBudgetRatio !== null && planRisk.riskBudgetRatio !== undefined ? el("span", null, format(t, "riskBudgetRatio") + " " + (Number(planRisk.riskBudgetRatio) * 100).toFixed(2) + "%") : null,
              ) : null,
              shouldShowIndicatorDetail(plan.action) ? el(IndicatorTable, { t: t, indicators: snap.indicators }) : null,
              el("div", { className: "dsh-goldboard-risk" }, format(t, "riskNote")),
            ) : null,
          ),
          el("div", { className: "dsh-goldboard-dashboard-side" },
            el(CardRow, {
              title: format(t, "positionTitle"),
              titleExtra: el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { props.onOpenTab("trading"); } }, format(t, "editPosition")),
            },
              positionGrams > 0 ? el("div", { className: "dsh-goldboard-kv" },
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "totalGrams")), el("span", { className: "dsh-goldboard-kv-value" }, positionGrams.toFixed(2) + " g")),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "avgCost")), el("span", { className: "dsh-goldboard-kv-value" }, position && position.avgCostPerGram ? "¥" + fmtPrice(position.avgCostPerGram) + "/g" : "—")),
                el("div", { className: "dsh-goldboard-kv-row" },
                  el("span", { className: "dsh-goldboard-kv-label" }, format(t, "pnl")),
                  el("span", { className: "dsh-goldboard-kv-value " + (pnlAvailable ? (Number(position.feeAdjustedPnl) >= 0 ? "dsh-goldboard-up" : "dsh-goldboard-down") : "") }, pnlAvailable ? "¥" + fmtSigned(position.feeAdjustedPnl) : format(t, "valuationUnavailable")),
                ),
              ) : el("div", { className: "dsh-goldboard-hint" }, format(t, "noPosition")),
              el("div", { className: "dsh-goldboard-card-actions" },
                el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { if (typeof props.onOpenLedger === "function") props.onOpenLedger(true); } }, format(t, "resetPosition")),
                el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { if (typeof props.onOpenLedger === "function") props.onOpenLedger(); else props.onOpenTab("strategy"); } }, format(t, "ledgerDetails")),
              ),
            ),
            el(CardRow, { title: format(t, "riskTitle"), hint: format(t, "riskEvidenceHint") },
              riskGate ? el("div", { className: "dsh-goldboard-kv" },
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskMode")), el("span", { className: "dsh-goldboard-kv-value" }, format(t, "riskMode_" + (risk.mode || "fixed_grams")))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskDailyLossLabel")), el("span", { className: "dsh-goldboard-kv-value " + (Number(dailyLoss) > 0 ? "dsh-goldboard-kv-value-risk" : "") }, "¥" + fmtPrice(dailyLoss))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskWeeklyLossLabel")), el("span", { className: "dsh-goldboard-kv-value " + (Number(weeklyLoss) > 0 ? "dsh-goldboard-kv-value-risk" : "") }, "¥" + fmtPrice(weeklyLoss))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskDrawdownLabel")), el("span", { className: "dsh-goldboard-kv-value" }, "¥" + fmtPrice(drawdown))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskAddsTodayLabel")), el("span", { className: "dsh-goldboard-kv-value" }, String(addsToday ?? 0))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskSetupAddsLabel")), el("span", { className: "dsh-goldboard-kv-value" }, String(setupAdds ?? 0))),
              ) : el("div", { className: "dsh-goldboard-hint" }, format(t, "noData")),
            ),
            el(CardRow, { title: format(t, "sourceStatus"), titleExtra: el("button", { type: "button", className: "dsh-goldboard-btn", onClick: function () { props.onOpenTab("data"); } }, format(t, "tab_data")) },
              el("div", { className: "dsh-goldboard-kv" },
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "signalLane")), el("span", { className: "dsh-goldboard-kv-value" }, laneLabel(t, plan && plan.signalLane))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "beijingTime")), el("span", { className: "dsh-goldboard-kv-value" }, formatBeijingTime(snap.serverTime, true))),
                el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "historicalRecords")), el("span", { className: "dsh-goldboard-kv-value" }, snap.historical ? String(snap.historical.records ?? 0) : "—")),
              ),
            ),
          ),
        ),
      );
    }

    function PageTabs(props) {
      var t = props.t;
      var active = props.active;
      var onChange = props.onChange;
      var onKeyDown = function (event) {
        var index = TABS.indexOf(active);
        var next = null;
        if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
        else if (event.key === "ArrowLeft") next = TABS[(index - 1 + TABS.length) % TABS.length];
        else if (event.key === "Home") next = TABS[0];
        else if (event.key === "End") next = TABS[TABS.length - 1];
        if (next !== null) {
          event.preventDefault();
          onChange(next);
          var node = event.currentTarget.querySelector('[data-tab="' + next + '"]');
          if (node && typeof node.focus === "function") node.focus();
        }
      };
      return el("div", { className: "dsh-goldboard-tabs-row" },
        el("div", { className: "dsh-goldboard-tabs", role: "tablist", "aria-label": format(t, "tablistLabel"), onKeyDown: onKeyDown },
          TABS.map(function (id) {
            return el("button", {
              key: id,
              type: "button",
              role: "tab",
              id: "dsh-goldboard-tab-" + id,
              "data-tab": id,
              "aria-selected": active === id,
              "aria-controls": id === "overview" ? "dsh-goldboard-panel-overview" : "dsh-goldboard-panel-workbench",
              tabIndex: active === id ? 0 : -1,
              className: "dsh-goldboard-tab",
              onClick: function () { onChange(id); },
            }, tabLabel(t, id));
          }),
        ),
        el("div", { className: "dsh-goldboard-tab-actions", ref: props.actionsRef }),
      );
    }

    function GoldBoardPage(props) {
      var t = props.t;
      var pageRef = useRef(null);
      var tabState = useState("overview");
      var tab = tabState[0];
      var setTab = tabState[1];
      var actionsRef = useRef(null);
      var actionsSlotState = useState(null);
      var actionsSlot = actionsSlotState[0];
      var setActionsSlot = actionsSlotState[1];
      var snapshot = useSnapshot(isChineseLocale(t) ? "zh" : "en");
      var snap = snapshot.snap;
      var error = snapshot.error;
      var loading = snapshot.loading;
      var marketOpen = snap && snap.marketState === "open";
      var nextOpen = snap && snap.market && snap.market.nextOpen;
      var riskLedgerOpenState = useState(false);
      var riskLedgerOpen = riskLedgerOpenState[0];
      var setRiskLedgerOpen = riskLedgerOpenState[1];
      var riskLedgerResetArmState = useState(false);
      var riskLedgerResetArm = riskLedgerResetArmState[0];
      var setRiskLedgerResetArm = riskLedgerResetArmState[1];
      var openLedger = function (reset) {
        setRiskLedgerResetArm(reset === true);
        setRiskLedgerOpen(true);
      };

      var selectTab = function (next) {
        if (TABS.indexOf(next) === -1) next = "overview";
        setTab(next);
      };
      useEffect(function () {
        setActionsSlot(actionsRef.current);
      }, []);
      useEffect(function () {
        var layout = layoutServiceRef;
        var info = layout && layout.panelInfo;
        if (!info || typeof info.subscribe !== "function" || typeof info.getSnapshot !== "function") return undefined;
        var previous = info.getSnapshot().activePanelId;
        return info.subscribe(function () {
          var next = info.getSnapshot().activePanelId;
          if (next === PAGE_ID && previous !== PAGE_ID) setTab("overview");
          previous = next;
        });
      }, []);
      useEffect(function () {
        if (pageRef.current) pageRef.current.scrollTop = 0;
      }, [tab]);
      useEffect(function () {
        if (typeof document === "undefined") return undefined;
        var onRefresh = function () { snapshot.refresh(); };
        document.addEventListener("dsh-plugin-goldboard:refresh", onRefresh);
        return function () { document.removeEventListener("dsh-plugin-goldboard:refresh", onRefresh); };
      }, []);

      var workbenchMode = tab === "overview" ? "trading" : tab;
      return el("div", { className: "dsh-goldboard-page", ref: pageRef },
        el("div", { className: "dsh-goldboard-page-inner" },
          el("div", { className: "dsh-goldboard-page-head" },
            el("div", { className: "dsh-goldboard-page-heading" },
              el("h2", { className: "dsh-goldboard-page-title" }, format(t, "boardTitle")),
              el("div", { className: "dsh-goldboard-head-meta" },
                snap ? el("span", null, format(t, "beijingTime") + " " + formatBeijingTime(snap.serverTime, true)) : el("span", null, format(t, "loading")),
                snap ? el("span", null, format(t, "autoRefresh")) : null,
                el("span", { className: "dsh-goldboard-platform" }, isDesktop() ? "🖥 " + format(t, "platformDesktop") : "🌐 " + format(t, "platformWeb")),
              ),
            ),
            el("div", { className: "dsh-goldboard-head-actions" },
              el("span", { className: "dsh-goldboard-status-pill " + (snap ? (marketOpen ? "dsh-goldboard-status-open" : "dsh-goldboard-status-closed") : error ? "dsh-goldboard-status-error" : "") },
                el("span", { className: "dsh-goldboard-status-dot" }),
                snap ? (marketOpen ? format(t, "marketOpen") : format(t, "marketClosed")) : error ? format(t, "loadFailedShort") : format(t, "loading"),
              ),
              snap && !marketOpen && nextOpen ? el("span", { className: "dsh-goldboard-hint" }, format(t, "marketClosedNext", { time: formatBeijingTime(nextOpen, false) })) : null,
              el("button", {
                type: "button",
                className: "dsh-goldboard-icon-button" + (loading ? " dsh-goldboard-icon-button-spin" : ""),
                "aria-label": format(t, "refresh"),
                title: format(t, "refresh"),
                disabled: loading,
                onClick: function () { snapshot.refresh(); },
              }, el(IconRefresh)),
              el("button", {
                type: "button",
                className: "dsh-goldboard-icon-button",
                "aria-label": format(t, "tab_settings"),
                title: format(t, "tab_settings"),
                onClick: function () { selectTab("settings"); },
              }, el(IconSettings)),
            ),
          ),
          el(PageTabs, { t: t, active: tab, onChange: selectTab, actionsRef: actionsRef }),
          el("div", { className: "dsh-goldboard-scroll" },
          el("div", {
            className: "dsh-goldboard-tabpanel",
            id: "dsh-goldboard-panel-overview",
            role: "tabpanel",
            "aria-labelledby": "dsh-goldboard-tab-overview",
            hidden: tab !== "overview",
          },
            el(OverviewTab, {
              t: t,
              snap: snap,
              error: error,
              loading: loading,
              onRefresh: snapshot.refresh,
              onOpenTab: selectTab,
              onOpenLedger: openLedger,
            }),
          ),
          el("div", {
            className: "dsh-goldboard-tabpanel",
            id: "dsh-goldboard-panel-workbench",
            role: "tabpanel",
            "aria-labelledby": "dsh-goldboard-tab-" + tab,
            hidden: tab === "overview",
          },
            el(SettingsSection, { t: t, mode: workbenchMode, snapshot: snap, visible: tab !== "overview", actionsSlot: actionsSlot, onOpenLedger: openLedger }),
          ),
          ),
          el("div", { className: "dsh-goldboard-page-footer" },
            el("span", null, format(t, "riskNote")),
            el("span", null, format(t, "dataDisclaimer")),
          ),
        ),
        riskLedgerOpen ? el(RiskLedgerDialog, {
          t: t,
          initialResetArm: riskLedgerResetArm,
          onReset: function () { snapshot.refresh(); },
          onClose: function () {
            setRiskLedgerOpen(false);
            setRiskLedgerResetArm(false);
          },
        }) : null,
      );
    }

    function GoldBoardPageEntry(props) {
      return el(PageErrorBoundary, { t: props.t }, el(GoldBoardPage, props));
    }

    // ── shared modal shell (plan-05 B.2, C-19) ──────────────────────────────
    //
    // Overlay + dialog container + Escape + Tab focus trap + initial focus +
    // focus restore + portal. Both log dialogs render through it; the close
    // button registers itself so Escape-free flows (overlay click) share the
    // same focus-restore target.
    function ModalDialog(props) {
      var closeRef = useRef(null);
      useEffect(function () {
        var previous = typeof document !== "undefined" ? document.activeElement : null;
        if (closeRef.current) closeRef.current.focus();
        var onKey = function (event) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            props.onClose();
            return;
          }
          if (event.key === "Tab" && typeof document !== "undefined") {
            var dialog = document.querySelector('[aria-labelledby="' + props.titleId + '"]');
            if (!dialog) return;
            var focusable = Array.from(dialog.querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex=\"-1\"])")).filter(function (node) { return !node.disabled && node.offsetParent !== null; });
            if (focusable.length === 0) return;
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        };
        if (typeof document !== "undefined") document.addEventListener("keydown", onKey, true);
        return function () {
          if (typeof document !== "undefined") document.removeEventListener("keydown", onKey, true);
          if (previous && typeof previous.focus === "function" && previous.focus) previous.focus();
        };
      }, []);
      var dialog = el("div", { className: "dsh-goldboard-log-overlay", onClick: props.onClose },
        el("div", {
          className: (props.dialogClassName ?? "dsh-goldboard-log-dialog"),
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": props.titleId,
          onClick: function (event) { event.stopPropagation(); },
        },
          el("div", { className: "dsh-goldboard-log-header" },
            el("h3", { id: props.titleId, className: "dsh-goldboard-log-title" }, props.title),
            props.actions,
            el("button", {
              ref: closeRef,
              className: "dsh-goldboard-btn",
              onClick: props.onClose,
              "aria-label": props.closeLabel,
            }, props.closeLabel),
          ),
          props.children,
        ),
      );
      if (ReactDOM && ReactDOM.createPortal && typeof document !== "undefined" && document.body) return ReactDOM.createPortal(dialog, document.body);
      return dialog;
    }

    // ── replay statistics details dialog ───────────────────────────────────

    function ReplayStatsDetailsDialog(props) {
      var t = props.t;
      var tradesState = useState(null);
      var trades = tradesState[0];
      var setTrades = tradesState[1];
      var unexecutedState = useState(null);
      var unexecutedSignals = unexecutedState[0];
      var setUnexecutedSignals = unexecutedState[1];
      var summaryState = useState(null);
      var summary = summaryState[0];
      var setSummary = summaryState[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var loadingState = useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      var load = function () {
        setLoading(true);
        setError("");
        fetchJson(REPLAY_STATS_URL + "?detail=true" + (props.reportId ? "&reportId=" + encodeURIComponent(props.reportId) : ""))
          .then(function (body) {
            if (!body || body.ok !== true) {
              throw new Error((body && body.error && body.error.code) || "BAD_RESPONSE");
            }
            if (props.reportId && body.report && body.report.reportId !== props.reportId) {
              throw new Error("REPLAY_REPORT_CHANGED");
            }
            var allOrders = [];
            if (Array.isArray(body.orders)) allOrders = allOrders.concat(body.orders);
            if (Array.isArray(body.pendingOrders)) allOrders = allOrders.concat(body.pendingOrders);
            var fillsByOrder = {};
            (Array.isArray(body.fills) ? body.fills : []).forEach(function (fill) { fillsByOrder[fill.orderId] = fill; });
            var rows = allOrders.map(function (order) { return Object.assign({}, order, fillsByOrder[order.orderId] || {}); });
            if (rows.length === 0 && Array.isArray(body.trades)) rows = body.trades;
            setTrades(rows);
            setUnexecutedSignals(Array.isArray(body.unexecutedSignals) ? body.unexecutedSignals : null);
            setSummary(body.report && Number(body.report.version) >= 5 && typeof body.report.overall === "object" ? body.report.overall : null);
          })
          .catch(function (err) {
            setError(clientErrorText(t, err && err.message ? err.message : err, "BAD_RESPONSE"));
          })
          .then(function () { setLoading(false); });
      };
      useEffect(function () { load(); }, []);

      var actionLabel = function (action) {
        var key = "enumAction_" + String(action || "");
        var translated = format(t, key);
        return translated === key ? String(action || "") : translated;
      };
      var statusLabel = function (status) {
        var key = status === "filled" ? "statsOrderFilled"
          : status === "expired" ? "statsOrderExpired"
          : status === "replaced" ? "statsOrderReplaced"
          : status === "not_executed" ? "statsSignalNotExecuted"
          : "statsOrderPending";
        return format(t, key);
      };
      var unexecutedReasonLabel = function (reasonCode) {
        var key = "statsUnexecutedReason_" + String(reasonCode || "unknown");
        var translated = format(t, key);
        return translated === key ? String(reasonCode || format(t, "statsUnknown")) : translated;
      };
      var signed = function (value) {
        if (value === null || value === undefined || value === "") return format(t, "statsUnknown");
        var numeric = Number(value);
        if (!Number.isFinite(numeric)) return format(t, "statsUnknown");
        return el("span", { className: numeric >= 0 ? "dsh-goldboard-stats-net-pos" : "dsh-goldboard-stats-net-neg" }, (numeric >= 0 ? "+" : "") + numeric.toFixed(2));
      };

      return el(ModalDialog, {
        titleId: "dsh-goldboard-stats-details-title",
        title: format(t, "statsDetailsTitle"),
        closeLabel: format(t, "logsClose"),
        onClose: props.onClose,
        dialogClassName: "dsh-goldboard-log-dialog dsh-goldboard-stats-detail-dialog",
        actions: el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: load }, format(t, "statsDetailsRefresh")),
      },
        el("p", { className: "dsh-goldboard-stats-detail-hint" }, format(t, "statsDetailsHint")),
        !loading && !error && summary ? el("p", { className: "dsh-goldboard-stats-detail-hint" }, format(t, "statsDetailsSummary", {
          grams: fmtPrice(summary.endingGrams),
          price: fmtPrice(summary.endingMarkPrice),
          realized: fmtSigned(summary.realizedNetCny),
          unrealized: fmtSigned(summary.unrealizedNetCny),
          total: fmtSigned(summary.totalNetCny),
        })) : null,
        el("div", { className: "dsh-goldboard-stats-detail-body", "aria-live": "polite" },
          loading && trades === null && unexecutedSignals === null ? el("div", { className: "dsh-goldboard-loading" }, format(t, "statsDetailsLoading")) : null,
          error ? el("div", { className: "dsh-goldboard-error" }, format(t, "statsDetailsLoadError", { error: error })) : null,
          !loading && !error && trades === null && unexecutedSignals === null ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsDetailsUnavailable")) : null,
          !loading && !error && Array.isArray(trades) && trades.length === 0 && Array.isArray(unexecutedSignals) && unexecutedSignals.length === 0 ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsDetailsEmpty")) : null,
          Array.isArray(trades) && trades.length > 0 ? el("div", { className: "dsh-goldboard-stats-detail-section" },
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsOrdersTitle")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  el("th", { title: format(t, "statsDetailsTipTime") }, format(t, "statsDetailsTime")),
                  el("th", null, format(t, "statsDetailsStatus")),
                  el("th", { title: format(t, "statsDetailsTipAction") }, format(t, "statsDetailsAction")),
                  el("th", { title: format(t, "statsDetailsTipPrice") }, format(t, "statsDetailsPrice")),
                  el("th", { title: format(t, "statsDetailsTipGrams") }, format(t, "statsDetailsGrams")),
                  el("th", { title: format(t, "statsDetailsTipFee") }, format(t, "statsDetailsFee")),
                  el("th", { title: format(t, "statsDetailsTipPosition") }, format(t, "statsDetailsPositionBefore")),
                  el("th", { title: format(t, "statsDetailsTipPosition") }, format(t, "statsDetailsPositionAfter")),
                  el("th", { title: format(t, "statsDetailsTipCashFlow") }, format(t, "statsDetailsCashFlow")),
                  el("th", { title: format(t, "statsDetailsTipRealizedNet") }, format(t, "statsDetailsRealizedNet")),
                )),
                el("tbody", null, trades.map(function (trade, index) {
                  var displayTime = trade && (trade.fillAt || trade.expiredAt || trade.signalAt || trade.t);
                  return el("tr", { key: (trade && (trade.orderId || trade.t)) + "-" + (trade && trade.action) + "-" + index },
                    el("td", null, formatBeijingTime(displayTime, false)),
                    el("td", null, statusLabel(trade && trade.status)),
                    el("td", null, actionLabel(trade && trade.action)),
                    el("td", null, fmtPrice(trade && (trade.fillPrice ?? trade.limitPrice ?? trade.price))),
                    el("td", null, fmtPrice(trade && (trade.grams ?? trade.remaining))),
                    el("td", null, fmtPrice(trade && trade.feeCny)),
                    el("td", null, fmtPrice(trade && trade.positionBeforeGrams)),
                    el("td", null, fmtPrice(trade && trade.positionAfterGrams)),
                    el("td", null, signed(trade && trade.cashFlowCny)),
                    el("td", null, signed(trade && trade.realizedPnlCny)),
                  );
                })),
              ),
            ),
          ) : null,
          !loading && !error && Array.isArray(trades) && unexecutedSignals === null ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsUnexecutedUnavailable")) : null,
          Array.isArray(unexecutedSignals) && unexecutedSignals.length > 0 ? el("div", { className: "dsh-goldboard-stats-detail-section" },
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsUnexecutedTitle")),
            el("p", { className: "dsh-goldboard-stats-group-hint" }, format(t, "statsUnexecutedHint")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  el("th", null, format(t, "statsDetailsTime")),
                  el("th", null, format(t, "statsDetailsStatus")),
                  el("th", null, format(t, "statsDetailsAction")),
                  el("th", null, format(t, "statsUnexecutedSignalPrice")),
                  el("th", null, format(t, "statsUnexecutedPosition")),
                  el("th", null, format(t, "statsUnexecutedReason")),
                )),
                el("tbody", null, unexecutedSignals.map(function (signal, index) {
                  return el("tr", { key: String(signal && signal.signalAt) + "-" + String(signal && signal.action) + "-" + index },
                    el("td", null, formatBeijingTime(signal && signal.signalAt, false)),
                    el("td", null, statusLabel(signal && signal.status)),
                    el("td", null, actionLabel(signal && signal.action)),
                    el("td", null, fmtPrice(signal && (signal.limitPrice ?? signal.signalPrice))),
                    el("td", null, fmtPrice(signal && signal.positionBeforeGrams) + " / " + fmtPrice(signal && signal.maxGrams)),
                    el("td", null, unexecutedReasonLabel(signal && signal.reasonCode)),
                  );
                })),
              ),
            ),
          ) : null,
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
        fetchJson(API_LOGS_URL + "?source=" + encodeURIComponent(source.id))
          .then(function (body) {
            setLogs(body && Array.isArray(body.logs) ? body.logs : []);
          })
          .catch(function () {
            setError(clientErrorText(null, "BAD_RESPONSE", "BAD_RESPONSE"));
          })
          .then(function () {
            setLoading(false);
          });
      };

      useEffect(function () { load(); }, []);

      var sourceName = isChineseLocale(t)
        ? (source.nameZh || source.nameEn || source.id)
        : (source.nameEn || source.nameZh || source.id);
      // plan-05 B.2/C-20: this dialog previously lacked Escape, the focus
      // trap and the portal; it now shares ModalDialog with the analysis
      // dialog. A failed refresh keeps the stale list visible with a distinct
      // error line instead of collapsing into the empty state.
      return el(ModalDialog, {
        titleId: "dsh-goldboard-source-logs-title",
        title: format(t, "logsTitle") + " · " + sourceName,
        closeLabel: format(t, "logsClose"),
        onClose: onClose,
        actions: el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: load }, format(t, "logsRefresh")),
      },
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
      );
    }

    function AnalysisLogsDialog(props) {
      var t = props.t;
      var modelCatalog = props.modelCatalog;
      var onClose = props.onClose;
      var filtersState = useState({ status: "", provider: "", model: "", from: "", to: "" });
      var filters = filtersState[0];
      var setFilters = filtersState[1];
      var logsState = useState([]);
      var logs = logsState[0];
      var setLogs = logsState[1];
      var cursorState = useState(null);
      var cursor = cursorState[0];
      var setCursor = cursorState[1];
      var moreState = useState(false);
      var hasMore = moreState[0];
      var setHasMore = moreState[1];
      var selectedState = useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var loadingState = useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var copiedState = useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var dataTabState = useState("input");
       var dataTab = dataTabState[0];
       var setDataTab = dataTabState[1];
      var detailRequestRef = useRef(0);
      var copiedTimerRef = useRef(null);
      var flashCopied = function () {
        setCopied(true);
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(function () { setCopied(false); copiedTimerRef.current = null; }, 1800);
      };

      // plan-05 B.4: stable option arrays — rebuilding them per render made
      // every SelectField see new props.
      var optionsPair = useMemo(function () {
        var providers = [{ value: "", label: format(t, "filterAll") }];
        var models = [{ value: "", label: format(t, "filterAll") }];
        (modelCatalog && modelCatalog.groups || []).forEach(function (group) {
          providers.push({ value: group.id, label: group.name || group.id });
          (group.models || []).forEach(function (model) {
            if (!filters.provider || filters.provider === group.id) models.push({ value: model.id, label: model.name || model.id });
          });
        });
        return { providers: providers, models: models };
      }, [modelCatalog, filters.provider]);
      var providerOptions = optionsPair.providers;
      var modelOptions = optionsPair.models;

      var loadDetail = function (queryId) {
        var requestId = ++detailRequestRef.current;
        setSelected(null);
        setError("");
        fetchJson(ANALYSIS_LOGS_URL + "?queryId=" + encodeURIComponent(queryId) + "&detail=true")
          .then(function (body) {
            if (requestId !== detailRequestRef.current) return;
            if (body && body.ok && body.logs && body.logs[0]) setSelected(body.logs[0]);
            else setError(format(t, "logsLoadError", { error: clientErrorText(t, body && body.error, "BAD_RESPONSE") }));
          })
          .catch(function (err) {
            if (requestId === detailRequestRef.current) {
              setError(format(t, "logsLoadError", { error: clientErrorText(t, "BAD_RESPONSE", "BAD_RESPONSE") }));
            }
          });
      };

      var load = function (append) {
        setLoading(true);
        setError("");
        var params = new URLSearchParams();
        params.set("limit", "30");
        // plan-05 B.5 cursor guard: appending without a cursor would silently
        // reload page one and duplicate the list.
        if (append && !cursor) return;
        if (append) params.set("cursor", cursor);
        ["status", "provider", "model", "from", "to"].forEach(function (key) {
          if (filters[key]) params.set(key, filters[key]);
        });
        fetchJson(ANALYSIS_LOGS_URL + "?" + params.toString())
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error && body.error.code) || "BAD_RESPONSE");
            var nextLogs = Array.isArray(body.logs) ? body.logs : [];
            setLogs(function (current) { return append ? current.concat(nextLogs) : nextLogs; });
            setCursor(body.nextCursor || null);
            setHasMore(body.hasMore === true);
            if (!append && nextLogs.length > 0) loadDetail(nextLogs[0].queryId);
            if (!append && nextLogs.length === 0) setSelected(null);
            if (body.health && body.health.available === false) setError(format(t, "analysisLogUnavailable"));
          })
          .catch(function (err) {
            setError(format(t, "logsLoadError", { error: clientErrorText(t, err && err.message ? err.message : err, "BAD_RESPONSE") }));
          })
          .then(function () { setLoading(false); });
      };

      useEffect(function () { load(false); }, [filters.status, filters.provider, filters.model, filters.from, filters.to]);


      var updateFilter = function (key, value) {
        setFilters(function (current) {
          var next = { ...current };
          next[key] = value;
          if (key === "provider") next.model = "";
          return next;
        });
      };
      var detailJson = selected ? JSON.stringify(selected, null, 2) : "";
      // plan-05 B.2: shared modal shell supplies overlay/Escape/trap/portal.
      var dialog = el(ModalDialog, {
        titleId: "dsh-goldboard-analysis-logs-title",
        title: format(t, "queryLogsTitle"),
        closeLabel: format(t, "logsClose"),
        onClose: onClose,
        dialogClassName: "dsh-goldboard-log-dialog dsh-goldboard-analysis-dialog",
        actions: el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: function () { load(false); } }, format(t, "logsRefresh")),
      },
          el("div", { className: "dsh-goldboard-analysis-filters" },
            el(SelectField, { label: format(t, "filterStatus"), value: filters.status, options: [
              { value: "", label: format(t, "filterAll") },
              { value: "running", label: format(t, "status_running") },
              { value: "success", label: format(t, "status_success") },
              { value: "error", label: format(t, "status_error") },
              { value: "aborted", label: format(t, "status_aborted") },
              { value: "invalid", label: format(t, "status_invalid") },
            ], onChange: function (value) { updateFilter("status", value); } }),
            el(SelectField, { label: format(t, "filterProvider"), value: filters.provider, options: providerOptions, onChange: function (value) { updateFilter("provider", value); } }),
            el(SelectField, { label: format(t, "filterModel"), value: filters.model, options: modelOptions, onChange: function (value) { updateFilter("model", value); } }),
            el("div", { className: "dsh-goldboard-analysis-actions" },
              el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: function () { load(false); } }, format(t, "logsRefresh")),
            ),
            el(TextField, { label: format(t, "filterFrom"), type: "datetime-local", value: filters.from, onChange: function (value) { updateFilter("from", value); } }),
            el(TextField, { label: format(t, "filterTo"), type: "datetime-local", value: filters.to, onChange: function (value) { updateFilter("to", value); } }),
          ),
          error ? el("div", { className: "dsh-goldboard-error", style: { padding: "8px 16px" }, role: "alert" }, error) : null,
          el("div", { className: "dsh-goldboard-analysis-log-layout" },
            el("div", { className: "dsh-goldboard-analysis-log-list" },
              loading && logs.length === 0 ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading")) : null,
              !loading && logs.length === 0 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "logsEmpty")) : null,
              logs.map(function (entry) {
                var active = selected && selected.queryId === entry.queryId;
                return el("button", {
                  type: "button",
                  key: entry.queryId,
                  className: "dsh-goldboard-analysis-log-button" + (active ? " dsh-goldboard-analysis-log-button-active" : ""),
                  onClick: function () { loadDetail(entry.queryId); },
                },
                  el("div", { className: "dsh-goldboard-log-item-head" },
                    el("span", { className: "dsh-goldboard-log-status " + (entry.status === "success" ? "dsh-goldboard-log-status-ok" : entry.status === "running" ? "" : "dsh-goldboard-log-status-fail") }, analysisStatusLabel(t, entry.status)),
                    el("span", null, (entry.provider || "—") + "/" + (entry.model || "—")),
                  ),
                  el("span", { className: "dsh-goldboard-log-meta" }, formatBeijingTime(entry.requestedAt, true)),
                  el("span", { className: "dsh-goldboard-log-meta" }, entry.queryId),
                );
              }),
              el("div", { className: "dsh-goldboard-analysis-pagination" },
                el("span", { className: "dsh-goldboard-hint" }, hasMore ? "" : format(t, "noMoreLogs")),
                hasMore ? el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: function () { load(true); } }, format(t, "loadMore")) : null,
              ),
            ),
            el("div", { className: "dsh-goldboard-analysis-log-detail" },
              el("div", { className: "dsh-goldboard-hint" }, format(t, "queryLogsDisclaimer")),
              !selected ? el("div", { className: "dsh-goldboard-hint" }, format(t, "selectLog")) : null,
              selected ? el("div", { className: "dsh-goldboard-analysis-detail-grid" },
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logQueryId")), el("span", null, selected.queryId),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logRequestedAt")), el("span", null, formatBeijingTime(selected.requestedAt, true)),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logProviderModel")), el("span", null, (selected.provider || "—") + "/" + (selected.model || "—")),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logDuration")), el("span", null, Number.isFinite(Number(selected.durationMs)) ? selected.durationMs + " ms" : "—"),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logSnapshotAsOf")), el("span", null, formatBeijingTime(selected.snapshotAsOf, true)),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logRuleAction")), el("span", null, analysisEnumLabel(t, "Action", selected.ruleAction)),
                el("span", { className: "dsh-goldboard-analysis-detail-label" }, format(t, "logUsage")), el("span", null, selected.usage ? JSON.stringify(selected.usage) : "—"),
              ) : null,
              selected && selected.error ? el("div", { className: "dsh-goldboard-error", role: "alert" }, format(t, "logError") + ": " + analysisErrorText(t, selected.error.code) + (selected.error.message ? " (" + selected.error.message + ")" : "")) : null,
              selected ? el("div", { className: "dsh-goldboard-analysis-result" },
                el("div", { className: "dsh-goldboard-analysis-result-label" }, format(t, "logResult")),
                selected.result ? el("pre", { className: "dsh-goldboard-analysis-json" }, JSON.stringify(selected.result, null, 2)) : el("div", { className: "dsh-goldboard-hint" }, format(t, "logNoOutput")),
              ) : null,
              selected ? el("div", { className: "dsh-goldboard-analysis-result" },
                el("div", { className: "dsh-goldboard-analysis-result-label" }, format(t, "logModelOutput")),
                selected.modelOutput ? el("pre", { className: "dsh-goldboard-analysis-json" }, selected.modelOutput) : el("div", { className: "dsh-goldboard-hint" }, format(t, "logNoOutput")),
              ) : null,
              selected ? el("pre", { className: "dsh-goldboard-analysis-json" }, detailJson) : null,
              selected ? el("div", { className: "dsh-goldboard-analysis-actions" },
                el("button", { className: "dsh-goldboard-btn", onClick: function () { copyText(detailJson).then(flashCopied).catch(function () { setCopied(false); }); } }, format(t, "copyJson")),
                copied ? el("span", { className: "dsh-goldboard-ok", "aria-live": "polite" }, format(t, "jsonCopied")) : null,
              ) : null,
            ),
             el("div", { className: "dsh-goldboard-analysis-data" },
               el("div", { className: "dsh-goldboard-analysis-tabs", role: "tablist" },
                 el("button", { type: "button", role: "tab", className: "dsh-goldboard-analysis-tab" + (dataTab === "input" ? " dsh-goldboard-analysis-tab-active" : ""), onClick: function () { setDataTab("input"); } }, format(t, "logInput")),
                 el("button", { type: "button", role: "tab", className: "dsh-goldboard-analysis-tab" + (dataTab === "result" ? " dsh-goldboard-analysis-tab-active" : ""), onClick: function () { setDataTab("result"); } }, format(t, "logResult")),
                 el("button", { type: "button", role: "tab", className: "dsh-goldboard-analysis-tab" + (dataTab === "output" ? " dsh-goldboard-analysis-tab-active" : ""), onClick: function () { setDataTab("output"); } }, format(t, "logModelOutput")),
               ),
               selected ? el("div", { className: "dsh-goldboard-analysis-data-panel" },
                 dataTab === "input" ? el("pre", { className: "dsh-goldboard-analysis-json" }, selected.input ? JSON.stringify(selected.input, null, 2) : format(t, "logNoOutput")) : null,
                 dataTab === "result" ? el("pre", { className: "dsh-goldboard-analysis-json" }, selected.result ? JSON.stringify(selected.result, null, 2) : format(t, "logNoOutput")) : null,
                 dataTab === "output" ? (selected.modelOutput ? el("pre", { className: "dsh-goldboard-analysis-json" }, selected.modelOutput) : el("div", { className: "dsh-goldboard-hint" }, format(t, "logNoOutput"))) : null,
               ) : el("div", { className: "dsh-goldboard-hint" }, format(t, "selectLog")),
             ),
          ),
      );
      return dialog;
    }

    function RiskLedgerDialog(props) {
      var t = props.t;
      var dataState = useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var loadingState = useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var resetArmState = useState(props.initialResetArm === true);
      var resetArm = resetArmState[0];
      var setResetArm = resetArmState[1];
      var resetBusyState = useState(false);
      var resetBusy = resetBusyState[0];
      var setResetBusy = resetBusyState[1];
      var resetErrorState = useState("");
      var resetError = resetErrorState[0];
      var setResetError = resetErrorState[1];
      var doReset = function () {
        setResetBusy(true);
        setResetError("");
        fetchJson(RESET_URL, { method: "POST", body: { confirm: "reset" } })
          .then(function (body) {
            if (!body || body.ok !== true) throw new Error((body && body.error && body.error.code) || "BAD_RESPONSE");
            setResetArm(false);
            load();
            if (typeof props.onReset === "function") props.onReset();
          })
          .catch(function (err) {
            setResetError(clientErrorText(t, (err && err.message) || "BAD_RESPONSE", "BAD_RESPONSE"));
          })
          .then(function () { setResetBusy(false); });
      };
      var load = useCallback(function () {
        setLoading(true);
        setError("");
        fetchJson(LEDGER_URL + "?limit=100")
          .then(function (body) {
            if (!body || body.ok !== true) throw new Error((body && body.error && body.error.code) || "BAD_RESPONSE");
            setData(body);
          })
          .catch(function (err) {
            setError(clientErrorText(t, err && err.message || "BAD_RESPONSE", "BAD_RESPONSE"));
          })
          .then(function () { setLoading(false); });
      }, [t]);
      useEffect(function () { load(); }, [load]);
      var orders = data && Array.isArray(data.orders) ? data.orders : [];
      var decisions = data && Array.isArray(data.decisions) ? data.decisions : [];
      var statusLabel = function (status) {
        var key = "ledgerStatus_" + String(status || "");
        var translated = format(t, key);
        return translated === key ? String(status || format(t, "riskUnknown")) : translated;
      };
      var idBlock = function (setupId, decisionId, orderId) {
        return el("div", { className: "dsh-goldboard-ledger-id" },
          setupId ? el("span", null, setupId) : null,
          decisionId ? el("span", null, decisionId) : null,
          orderId ? el("span", null, orderId) : null,
        );
      };
      return el(ModalDialog, {
        titleId: "dsh-goldboard-risk-ledger-title",
        title: format(t, "ledgerTitle"),
        closeLabel: format(t, "logsClose"),
        onClose: props.onClose,
        dialogClassName: "dsh-goldboard-log-dialog dsh-goldboard-stats-detail-dialog",
        actions: el("div", { className: "dsh-goldboard-card-actions" },
          el("button", { className: "dsh-goldboard-btn", disabled: loading, onClick: load }, format(t, "ledgerRefresh")),
          el("button", { className: "dsh-goldboard-btn", disabled: resetBusy, onClick: function () { setResetArm(true); setResetError(""); } }, format(t, "resetLedger")),
        ),
      },
        el("p", { className: "dsh-goldboard-stats-detail-hint" }, format(t, "riskEvidenceHint")),
        resetArm ? el("div", { className: "dsh-goldboard-stats-detail-section", role: "alert" },
          el("p", { className: "dsh-goldboard-error" }, format(t, "resetConfirmText")),
          el("div", { className: "dsh-goldboard-card-actions" },
            el("button", { className: "dsh-goldboard-btn", disabled: resetBusy, onClick: doReset }, format(t, "resetConfirm")),
            el("button", { className: "dsh-goldboard-btn", disabled: resetBusy, onClick: function () { setResetArm(false); setResetError(""); } }, format(t, "resetCancel")),
          ),
          resetError ? el("p", { className: "dsh-goldboard-error" }, resetError) : null,
        ) : null,
        el("div", { className: "dsh-goldboard-stats-detail-body" },
          loading ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading")) : null,
          error ? el("div", { className: "dsh-goldboard-error", role: "alert" }, error) : null,
          !loading && !error && orders.length === 0 && decisions.length === 0 ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "ledgerEmpty")) : null,
          orders.length > 0 ? el("div", { className: "dsh-goldboard-stats-detail-section" },
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "ledgerOrders")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  el("th", null, format(t, "ledgerTime")),
                  el("th", null, format(t, "ledgerStatus")),
                  el("th", null, format(t, "ledgerAction")),
                  el("th", null, format(t, "ledgerSize")),
                  el("th", null, format(t, "ledgerPrice")),
                  el("th", null, format(t, "ledgerIds")),
                )),
                el("tbody", null, orders.map(function (order) {
                  return el("tr", { key: order.orderId },
                    el("td", null, formatBeijingTime(order.completedAt || order.updatedAt || order.issuedAt, true)),
                    el("td", null, statusLabel(order.status)),
                    el("td", null, analysisEnumLabel(t, "Action", order.action)),
                    el("td", null, fmtPrice(order.filledGrams ?? order.grams)),
                    el("td", null, order.fillPrice ?? order.limitPrice ?? "—"),
                    el("td", null, idBlock(order.setupId, order.decisionId, order.orderId)),
                  );
                })),
              ),
            ),
          ) : null,
          decisions.length > 0 ? el("div", { className: "dsh-goldboard-stats-detail-section" },
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "ledgerDecisions")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  el("th", null, format(t, "ledgerTime")),
                  el("th", null, format(t, "ledgerStatus")),
                  el("th", null, format(t, "ledgerAction")),
                  el("th", null, format(t, "ledgerSize")),
                  el("th", null, format(t, "ledgerPrice")),
                  el("th", null, format(t, "ledgerReason")),
                  el("th", null, format(t, "ledgerIds")),
                )),
                el("tbody", null, decisions.map(function (decision) {
                  return el("tr", { key: decision.decisionId },
                    el("td", null, formatBeijingTime(decision.at, true)),
                    el("td", null, statusLabel(decision.status)),
                    el("td", null, analysisEnumLabel(t, "Action", decision.candidateAction || decision.action)),
                    el("td", null, fmtPrice(decision.suggestedGrams) + " / " + fmtPrice(decision.positionGrams)),
                    el("td", null, decision.nominalAmountCny ?? decision.availableRiskBudgetCny ?? "—"),
                    el("td", null, formatReasonCodes(t, decision.blockedReasonCodes && decision.blockedReasonCodes.length > 0 ? decision.blockedReasonCodes : decision.reasonCodes)),
                    el("td", null, idBlock(decision.setupId, decision.decisionId, decision.orderId)),
                  );
                })),
              ),
            ),
          ) : null,
        ),
      );
    }

    // ── settings ───────────────────────────────────────────────────────────

    function emptyConfig() {
      return {
        fee: { buyPerGram: 0, sellPerGram: 5 },
        cmb: { buySpreadPerGram: 1.72, sellSpreadPerGram: 1.72, deriveSellFromFee: false },
        position: { grams: 0, avgCostPerGram: 0, lots: [] },
        limits: { maxGrams: 0 },
        risk: { version: "goldboard-risk-config-v1", mode: "fixed_grams", referenceEquityCny: 0, maxAmountCny: 0, maxRiskPerTradeCny: 0, maxDailyLossCny: 0, maxWeeklyLossCny: 0, maxDrawdownCny: 0, volatilityTarget: 0, liquidityCapGrams: 0, maxAddsPerSetup: 0, maxAddsPerDay: 0, minAddPriceImprovementPerGram: 0, consecutiveLossDeRisk: 0 },
        manualPrevClose: { AU9999: null, XAU: null, CMB: null },
        manualPrevCloseDate: "",
        strategy: { minProfitPerGram: 1, maxLossPerGram: 2, slippagePerGram: 0.2, estimatedSpreadPerGram: 0.2, rsiOversold: 35, rsiOverbought: 75, atrFactor: 0.3, nearSupportPct: 0.5, minRemainGrams: 0, signalCooldownMinutes: 30, confirmBars: 2, scoreThreshold: 5, weaknessRsi: 75, weaknessShadowAtrMult: 1, closeBySessionEnd: false, orderRepricePct: 0.5, targetTrailPerGram: 0, targetPartialRatio: 0, targetTrailBars: 24, requirePriceAboveEma60: false, requireDailyUptrend: false, maxBarsBeforeTarget: 0 },
        experiments: { version: "goldboard-strategy-experiment-config-v1", enabled: false, enabledStrategyIds: ["control"], signalLanes: ["cmb"], costMultipliers: [1, 2], parameterMultipliers: [0.8, 1, 1.2], ablations: ["none", "without-regime-filter"], maxScenarios: 48, orb: { openingRangeBars: 6, breakoutAtrBuffer: 0.1, pullbackAtrTolerance: 0.35, setupExpiryBars: 12, orderValidityBars: 3, stopAtrMultiplier: 0.75, targetAtrMultiplier: 1.5, grams: 1, requireTrendRegime: true, requiredFactorIds: [], factorMaxAgeMs: 86400000 } },
        tradingHours: { weekdaysOnly: true, open: "09:00", close: "26:00", holidays: [] },
        analysis: { enabled: false, provider: "", model: "", reasoningEffort: "", temperature: 0.1, maxTokens: 1600, trigger: "manual", cooldownMinutes: 5, timeoutMs: 60000, maxLogEntries: 500, riskDisclosure: "技术面参考，非投资建议。" },
        system: { enabled: false },
        webhooks: { feishu: { enabled: false, url: "", secret: "", bodyTemplate: "" }, dingtalk: { enabled: false, url: "", secret: "", bodyTemplate: "" }, wecom: { enabled: false, url: "", bodyTemplate: "" }, generic: [] },
      };
    }

    function StrategyExperimentPanel(props) {
      var t = props.t;
      var cfg = props.cfg || emptyConfig();
      var update = props.update;
      var experiments = cfg.experiments || emptyConfig().experiments;
      var catalogState = useState(null);
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var catalogConfigState = useState(null);
      var catalogConfig = catalogConfigState[0];
      var setCatalogConfig = catalogConfigState[1];
      var catalogBasisState = useState(null);
      var catalogBasisFingerprint = catalogBasisState[0];
      var setCatalogBasisFingerprint = catalogBasisState[1];
      var catalogBasisValueState = useState(null);
      var catalogBasis = catalogBasisValueState[0];
      var setCatalogBasis = catalogBasisValueState[1];
      var runControllerRef = useRef(null);
      var mountedRef = useRef(true);
      var reportState = useState(null);
      var report = reportState[0];
      var setReport = reportState[1];
      var runningState = useState(false);
      var running = runningState[0];
      var setRunning = runningState[1];
      var messageState = useState(null);
      var message = messageState[0];
      var setMessage = messageState[1];
      var daysState = useState(1);
      var days = daysState[0];
      var setDays = daysState[1];
      var modeState = useState("diagnostic");
      var mode = modeState[0];
      var setMode = modeState[1];

      var errorText = function (error, fallback) {
        return clientErrorText(t, error, fallback || "STRATEGY_EXPERIMENTS_UNAVAILABLE");
      };
      var messageText = message ? format(t, message.key, {
        error: errorText(message.error, message.fallback),
      }) : "";
      var statusLabel = function (status) {
        var key = "experimentStatus_" + String(status || "unknown").replace(/-/g, "_");
        return Object.prototype.hasOwnProperty.call(DICT.zh, key) ? format(t, key) : format(t, "experimentStatus_unknown");
      };
      var strategyLabel = function (strategyId) {
        if (strategyId === "control") return format(t, "experimentControl");
        if (strategyId === "orb-trend-pullback") return format(t, "experimentOrb");
        return format(t, "experimentUnknownStrategy", { id: String(strategyId || format(t, "experimentStatus_unknown")) });
      };
      var laneLabel = function (lane) {
        var key = "experimentLane_" + String(lane || "");
        return Object.prototype.hasOwnProperty.call(DICT.zh, key) ? format(t, key) : String(lane || format(t, "experimentStatus_unknown"));
      };
      var ablationLabel = function (ablation) {
        var key = "experimentAblation_" + String(ablation || "none").replace(/-/g, "_");
        return Object.prototype.hasOwnProperty.call(DICT.zh, key) ? format(t, key) : String(ablation || "none");
      };
      var reasonLabel = function (reason) {
        var key = "experimentReason_" + String(reason || "").replace(/-/g, "_");
        return Object.prototype.hasOwnProperty.call(DICT.zh, key) ? format(t, key) : String(reason || format(t, "experimentStatus_unknown"));
      };
      var numberText = function (value) {
        return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
          ? Number(value).toFixed(2) : format(t, "statsUnknown");
      };
      var signedText = function (value) {
        if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return format(t, "statsUnknown");
        var numeric = Number(value);
        return (numeric >= 0 ? "+" : "") + numeric.toFixed(2);
      };
      var updateExperiments = function (fn) {
        if (typeof update !== "function") return;
        update(function (next) {
          if (!next.experiments) next.experiments = JSON.parse(JSON.stringify(emptyConfig().experiments));
          if (!next.experiments.orb) next.experiments.orb = JSON.parse(JSON.stringify(emptyConfig().experiments.orb));
          fn(next.experiments);
        });
      };
      var toggleListValue = function (key, value, checked) {
        updateExperiments(function (next) {
          var values = Array.isArray(next[key]) ? next[key].slice() : [];
          if (checked && values.indexOf(value) === -1) values.push(value);
          if (!checked) values = values.filter(function (entry) { return entry !== value; });
          next[key] = values;
        });
      };
      var load = useCallback(function () {
        var active = true;
        Promise.all([
          fetchJson(STRATEGIES_URL),
          fetchJson(STRATEGY_EXPERIMENTS_URL),
        ]).then(function (values) {
          if (!active) return;
          var catalogBody = values[0];
          var reportBody = values[1];
          if (catalogBody && catalogBody.ok && Array.isArray(catalogBody.strategies)) {
            setCatalog(catalogBody.strategies);
            setCatalogConfig(catalogBody.config || null);
            setCatalogBasisFingerprint(catalogBody.basisFingerprint || null);
            setCatalogBasis(catalogBody.basis || null);
          } else {
            setCatalog([]);
            setCatalogConfig(null);
            setCatalogBasisFingerprint(null);
            setCatalogBasis(null);
            setMessage({ key: "experimentCatalogError", error: catalogBody && catalogBody.error, fallback: "STRATEGY_REGISTRY_UNAVAILABLE" });
          }
          if (reportBody && reportBody.ok) {
            setReport(reportBody.report || null);
            if (reportBody.report && reportBody.report.run) {
              setDays(Number(reportBody.report.run.days) || 1);
              setMode(reportBody.report.run.mode === "walk-forward" ? "walk-forward" : "diagnostic");
            }
            if (reportBody.report && reportBody.persisted === false) setMessage({
              key: "experimentPersistWarning",
              warning: true,
              error: reportBody.persistenceError,
              fallback: "EXPERIMENT_PERSIST_FAILED",
            });
          } else setMessage({ key: "experimentLatestError", error: reportBody && reportBody.error, fallback: "STRATEGY_EXPERIMENTS_UNAVAILABLE" });
        }).catch(function (error) {
          if (!active) return;
          setCatalog([]);
          setMessage({ key: "experimentCatalogError", error: error && error.message, fallback: "STRATEGY_REGISTRY_UNAVAILABLE" });
        });
        return function () { active = false; };
      }, []);
      useEffect(function () {
        var cleanup = load();
        var onRefresh = function () {
          if (typeof cleanup === "function") cleanup();
          cleanup = load();
        };
        if (typeof document !== "undefined") document.addEventListener("dsh-plugin-goldboard:refresh", onRefresh);
        return function () {
          if (typeof cleanup === "function") cleanup();
          if (typeof document !== "undefined") document.removeEventListener("dsh-plugin-goldboard:refresh", onRefresh);
        };
      }, [load]);

      useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          if (runControllerRef.current) runControllerRef.current.abort();
        };
      }, []);

      var run = function () {
        if (running || !canRun) return;
        if (runControllerRef.current) runControllerRef.current.abort();
        var controller = new AbortController();
        runControllerRef.current = controller;
        setRunning(true);
        setMessage(null);
        fetchJson(STRATEGIES_URL, { signal: controller.signal }).then(function (catalogBody) {
          if (!mountedRef.current || controller.signal.aborted) {
            var cancelled = new Error("strategy experiment request cancelled");
            cancelled.name = "AbortError";
            throw cancelled;
          }
          if (!catalogBody || !catalogBody.ok || !catalogBody.config) {
            var catalogError = new Error("STRATEGY_REGISTRY_UNAVAILABLE");
            catalogError.code = "STRATEGY_REGISTRY_UNAVAILABLE";
            throw catalogError;
          }
          setCatalog(Array.isArray(catalogBody.strategies) ? catalogBody.strategies : []);
          setCatalogConfig(catalogBody.config);
          setCatalogBasisFingerprint(catalogBody.basisFingerprint || null);
          setCatalogBasis(catalogBody.basis || null);
          var saved = catalogBody.config;
          var freshStrategies = Array.isArray(catalogBody.strategies) ? catalogBody.strategies : [];
          var freshRegisteredIds = freshStrategies.map(function (entry) { return entry.strategyId; });
          var freshEnabledIds = Array.isArray(saved.enabledStrategyIds) ? saved.enabledStrategyIds : [];
          var freshCandidateEnabled = freshEnabledIds.some(function (strategyId) {
            return strategyId !== "control" && freshRegisteredIds.indexOf(strategyId) !== -1;
          });
          var freshUnknownEnabled = freshEnabledIds.some(function (strategyId) {
            return freshRegisteredIds.indexOf(strategyId) === -1;
          });
          if (saved.enabled !== true || configSignature(saved) !== configSignature(experiments)
            || !catalogBody.basis || stableJson(catalogBody.basis) !== stableJson(draftBasis)
            || !freshCandidateEnabled || freshUnknownEnabled
            || saved.orb?.factorRequirementsValid === false) {
            var saveError = new Error("EXPERIMENT_SAVE_REQUIRED");
            saveError.code = "EXPERIMENT_SAVE_REQUIRED";
            throw saveError;
          }
          var strategyIds = freshEnabledIds.slice();
          if (strategyIds.indexOf("control") === -1) strategyIds.unshift("control");
          var signalLanes = Array.isArray(saved.signalLanes) ? saved.signalLanes.slice() : ["cmb"];
          return fetchJson(STRATEGY_EXPERIMENTS_URL, {
            method: "POST",
            signal: controller.signal,
            body: { days: days, mode: mode, strategyIds: strategyIds, signalLanes: signalLanes },
          });
        }).then(function (body) {
          if (!mountedRef.current || controller.signal.aborted) return;
          if (body && body.ok && body.report) {
            setReport(body.report);
            if (body.persisted === false) setMessage({
              key: "experimentPersistWarning",
              warning: true,
              error: body.persistenceError,
              fallback: "EXPERIMENT_PERSIST_FAILED",
            });
          } else setMessage({ key: "experimentRunError", error: body && body.error, fallback: "BAD_STRATEGY_EXPERIMENT" });
        }).catch(function (error) {
          if (!mountedRef.current || (error && error.name === "AbortError")) return;
          setMessage({ key: "experimentRunError", error: error, fallback: "BAD_STRATEGY_EXPERIMENT" });
        }).then(function () {
          if (runControllerRef.current === controller) runControllerRef.current = null;
          if (mountedRef.current) setRunning(false);
        });
      };

      var enabledIds = Array.isArray(experiments.enabledStrategyIds) ? experiments.enabledStrategyIds : ["control"];
      var lanes = Array.isArray(experiments.signalLanes) ? experiments.signalLanes : ["cmb"];
      var strategies = Array.isArray(catalog) && catalog.length > 0 ? catalog : [
        { strategyId: "control", strategyVersion: "goldboard-control-v1", live: true, enabled: true, canDisable: false },
        { strategyId: "orb-trend-pullback", strategyVersion: "goldboard-orb-trend-pullback-v1", live: false, enabled: enabledIds.indexOf("orb-trend-pullback") !== -1, canDisable: true },
      ];
      var knownStrategyIds = strategies.map(function (entry) { return entry.strategyId; });
      var staleStrategyIds = enabledIds.filter(function (strategyId) {
        return strategyId !== "control" && knownStrategyIds.indexOf(strategyId) === -1;
      });
      var displayedStrategies = strategies.concat(staleStrategyIds.map(function (strategyId) {
        return { strategyId: strategyId, strategyVersion: null, live: false, enabled: true, unregistered: true };
      }));
      var scenarios = Array.isArray(report && report.scenarios) ? report.scenarios : [];
      var comparisons = Array.isArray(report && report.comparisons) ? report.comparisons : [];
      var candidates = Array.isArray(report && report.promotion && report.promotion.candidates) ? report.promotion.candidates : [];
      var benchmarks = Array.isArray(report && report.benchmarkCapabilities) ? report.benchmarkCapabilities : [];
      var orb = experiments.orb || emptyConfig().experiments.orb;
      var matrixText = function (values) { return (Array.isArray(values) ? values : []).join(", ") || format(t, "statsUnknown"); };
      var configSignature = function (value) {
        var source = value || {};
        var sourceOrb = source.orb || {};
        var sorted = function (items) { return (Array.isArray(items) ? items.slice() : []).sort(); };
        return JSON.stringify({
          version: source.version || "goldboard-strategy-experiment-config-v1",
          enabled: source.enabled === true,
          enabledStrategyIds: sorted(source.enabledStrategyIds),
          signalLanes: sorted(source.signalLanes),
          costMultipliers: sorted(source.costMultipliers),
          parameterMultipliers: sorted(source.parameterMultipliers),
          ablations: sorted(source.ablations),
          maxScenarios: Number(source.maxScenarios),
          orb: {
            openingRangeBars: Number(sourceOrb.openingRangeBars),
            breakoutAtrBuffer: Number(sourceOrb.breakoutAtrBuffer),
            pullbackAtrTolerance: Number(sourceOrb.pullbackAtrTolerance),
            setupExpiryBars: Number(sourceOrb.setupExpiryBars),
            orderValidityBars: Number(sourceOrb.orderValidityBars),
            stopAtrMultiplier: Number(sourceOrb.stopAtrMultiplier),
            targetAtrMultiplier: Number(sourceOrb.targetAtrMultiplier),
            grams: Number(sourceOrb.grams),
            requireTrendRegime: sourceOrb.requireTrendRegime === true,
            requiredFactorIds: sorted(sourceOrb.requiredFactorIds),
            factorMaxAgeMs: Number(sourceOrb.factorMaxAgeMs),
          },
        });
      };
      var savedMatchesDraft = Boolean(catalogConfig
        && configSignature(catalogConfig) === configSignature(experiments));
      var savedEnabledIds = Array.isArray(catalogConfig && catalogConfig.enabledStrategyIds)
        ? catalogConfig.enabledStrategyIds : [];
      var registeredIds = strategies.map(function (entry) { return entry.strategyId; });
      var savedCandidateEnabled = savedEnabledIds.some(function (strategyId) {
        return strategyId !== "control" && registeredIds.indexOf(strategyId) !== -1;
      });
      var stableJson = function stableJson(value) {
        if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
        if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(function (key) {
          return JSON.stringify(key) + ":" + stableJson(value[key]);
        }).join(",") + "}";
        return JSON.stringify(value === undefined ? null : value);
      };
      var descriptorBasis = strategies.map(function (entry) {
        return {
          strategyId: entry.strategyId || null,
          strategyVersion: entry.strategyVersion || null,
          descriptorFingerprint: entry.descriptorFingerprint || null,
          adapterFingerprint: entry.adapterFingerprint || null,
          executionInstrument: entry.executionInstrument || null,
          lanes: Array.isArray(entry.lanes) ? entry.lanes.slice().sort() : [],
        };
      }).sort(function (left, right) { return String(left.strategyId).localeCompare(String(right.strategyId)); });
      var draftBasis = {
        experiments: JSON.parse(configSignature(experiments)),
        fee: cfg.fee || {},
        cmb: cfg.cmb || {},
        limits: { maxGrams: cfg.limits && cfg.limits.maxGrams !== undefined ? cfg.limits.maxGrams : null },
        risk: cfg.risk || {},
        controlStrategy: cfg.strategy || {},
        tradingHours: cfg.tradingHours || {},
        manualPrevClose: cfg.manualPrevClose || {},
        strategyDescriptors: descriptorBasis,
      };
      var savedBasisMatchesDraft = Boolean(catalogBasis && stableJson(catalogBasis) === stableJson(draftBasis));
      var canRun = Boolean(catalogConfig && catalogConfig.enabled === true && savedMatchesDraft
        && savedBasisMatchesDraft && savedCandidateEnabled && staleStrategyIds.length === 0
        && experiments?.orb?.factorRequirementsValid !== false
        && Array.isArray(catalogConfig.signalLanes) && catalogConfig.signalLanes.length > 0);
      var reportBasis = report && report.provenance && report.provenance.basis;
      var reportBasisFingerprint = report && report.provenance && report.provenance.basisFingerprint;
      var reportStale = Boolean(report && (
        !catalogBasisFingerprint || reportBasisFingerprint !== catalogBasisFingerprint
        || !catalogBasis || !reportBasis || stableJson(reportBasis) !== stableJson(catalogBasis)
        || stableJson(reportBasis) !== stableJson(draftBasis)
        || configSignature(report.config) !== configSignature(experiments)
        || Number(report.run && report.run.days) !== Number(days)
        || String(report.run && report.run.mode) !== String(mode)
      ));

      return el(CardRow, { className: "dsh-goldboard-section-experiments", title: format(t, "experimentTitle"), hint: format(t, "experimentHint") },
        el("div", { className: "dsh-goldboard-experiment" },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, {
              label: format(t, "experimentEnabled"),
              checked: experiments.enabled === true,
              onChange: function (value) { updateExperiments(function (next) { next.enabled = value; }); },
            }),
            el("span", null, format(t, "experimentEnabled")),
          ),
          experiments.enabled !== true ? el("div", { className: "dsh-goldboard-hint" }, format(t, "experimentDisabledHint")) : null,
          catalog === null ? el("div", { className: "dsh-goldboard-loading" }, format(t, "experimentCatalogLoading")) : null,
          el("div", { className: "dsh-goldboard-experiment-list" }, displayedStrategies.map(function (strategy) {
            var control = strategy.strategyId === "control" || strategy.live === true;
            var checked = control || enabledIds.indexOf(strategy.strategyId) !== -1;
            return el("div", { className: "dsh-goldboard-experiment-strategy", key: strategy.strategyId },
              el("div", { className: "dsh-goldboard-experiment-strategy-main" },
                el("span", { className: "dsh-goldboard-experiment-strategy-name" }, strategyLabel(strategy.strategyId)),
                el("span", { className: "dsh-goldboard-experiment-strategy-meta" },
                  format(t, strategy.unregistered ? "experimentUnregistered" : control ? "experimentLiveFixed" : "experimentReplayOnly") + " · " + format(t, "experimentStrategyVersion", { version: strategy.strategyVersion || format(t, "statsUnknown") })),
              ),
              control ? el("span", { className: "dsh-goldboard-tag" }, format(t, "experimentLiveFixed"))
                : el(Switch, {
                    label: format(t, strategy.unregistered ? "experimentUnregistered" : "experimentEnableCandidate"),
                    checked: checked,
                    onChange: function (value) { toggleListValue("enabledStrategyIds", strategy.strategyId, value); },
                  }),
            );
          })),
          el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "experimentSignalLanes")),
          el("div", { className: "dsh-goldboard-experiment-checks" }, ["cmb", "au9999", "xau"].map(function (lane) {
            return el("label", { className: "dsh-goldboard-experiment-check", key: lane },
              el("input", {
                type: "checkbox",
                checked: lanes.indexOf(lane) !== -1,
                disabled: lanes.indexOf(lane) !== -1 && lanes.length === 1,
                "aria-label": laneLabel(lane),
                onChange: function (event) { toggleListValue("signalLanes", lane, event.target.checked); },
              }),
              el("span", null, laneLabel(lane)),
            );
          })),
          el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "experimentOrbParameters")),
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "experimentOpeningRangeBars"), value: orb.openingRangeBars, min: 2, max: 24, step: 1, onChange: function (value) { updateExperiments(function (next) { next.orb.openingRangeBars = Math.floor(Number(value)); }); } }),
            el(NumberField, { label: format(t, "experimentBreakoutBuffer"), value: orb.breakoutAtrBuffer, min: 0, max: 5, step: 0.01, onChange: function (value) { updateExperiments(function (next) { next.orb.breakoutAtrBuffer = Number(value); }); } }),
            el(NumberField, { label: format(t, "experimentPullbackTolerance"), value: orb.pullbackAtrTolerance, min: 0, max: 5, step: 0.01, onChange: function (value) { updateExperiments(function (next) { next.orb.pullbackAtrTolerance = Number(value); }); } }),
            el(NumberField, { label: format(t, "experimentSetupExpiryBars"), value: orb.setupExpiryBars, min: 1, max: 144, step: 1, onChange: function (value) { updateExperiments(function (next) { next.orb.setupExpiryBars = Math.floor(Number(value)); }); } }),
            el(NumberField, { label: format(t, "experimentOrderValidityBars"), value: orb.orderValidityBars, min: 1, max: 24, step: 1, onChange: function (value) { updateExperiments(function (next) { next.orb.orderValidityBars = Math.floor(Number(value)); }); } }),
            el(NumberField, { label: format(t, "experimentStopAtrMultiplier"), value: orb.stopAtrMultiplier, min: 0.1, max: 10, step: 0.05, onChange: function (value) { updateExperiments(function (next) { next.orb.stopAtrMultiplier = Number(value); }); } }),
            el(NumberField, { label: format(t, "experimentTargetAtrMultiplier"), value: orb.targetAtrMultiplier, min: 0.1, max: 20, step: 0.05, onChange: function (value) { updateExperiments(function (next) { next.orb.targetAtrMultiplier = Number(value); }); } }),
            el(NumberField, { label: format(t, "experimentGrams"), value: orb.grams, min: 0.01, max: 100000, step: 0.01, onChange: function (value) { updateExperiments(function (next) { next.orb.grams = Number(value); }); } }),
            el(TextField, { label: format(t, "experimentRequiredFactors"), value: (Array.isArray(orb.requiredFactorIds) ? orb.requiredFactorIds : []).join(", "), onChange: function (value) { updateExperiments(function (next) { next.orb.requiredFactorIds = value.split(/[,，]/).map(function (entry) { return entry.trim(); }).filter(Boolean); }); } }),
            el(NumberField, { label: format(t, "experimentFactorMaxAgeHours"), value: Number(orb.factorMaxAgeMs) / 3600000, min: 0.001, max: 8760, step: 1, onChange: function (value) { updateExperiments(function (next) { next.orb.factorMaxAgeMs = Math.round(Number(value) * 3600000); }); } }),
            el("label", { className: "dsh-goldboard-field" },
              el("span", null, format(t, "experimentRequireTrend")),
              el(Switch, { label: format(t, "experimentRequireTrend"), checked: orb.requireTrendRegime === true, onChange: function (value) { updateExperiments(function (next) { next.orb.requireTrendRegime = value; }); } }),
            ),
          ),
          el("div", { className: "dsh-goldboard-experiment-matrix" },
            el("span", null, format(t, "experimentCostMatrix", { values: matrixText(experiments.costMultipliers) })),
            el("div", { className: "dsh-goldboard-experiment-checks" }, [1, 2].map(function (value) {
              var checked = Array.isArray(experiments.costMultipliers) && experiments.costMultipliers.indexOf(value) !== -1;
              return el("label", { className: "dsh-goldboard-experiment-check", key: "cost-" + value },
                el("input", { type: "checkbox", checked: value === 1 || checked, disabled: value === 1 || running, onChange: function (event) { toggleListValue("costMultipliers", value, event.target.checked); } }),
                el("span", null, value + "x"));
            })),
            el("span", null, format(t, "experimentParameterMatrix", { values: matrixText(experiments.parameterMultipliers) })),
            el("div", { className: "dsh-goldboard-experiment-checks" }, [0.8, 1, 1.2].map(function (value) {
              var checked = Array.isArray(experiments.parameterMultipliers) && experiments.parameterMultipliers.indexOf(value) !== -1;
              return el("label", { className: "dsh-goldboard-experiment-check", key: "parameter-" + value },
                el("input", { type: "checkbox", checked: value === 1 || checked, disabled: value === 1 || running, onChange: function (event) { toggleListValue("parameterMultipliers", value, event.target.checked); } }),
                el("span", null, String(value)));
            })),
            el("span", null, format(t, "experimentAblationMatrix", { values: (Array.isArray(experiments.ablations) ? experiments.ablations : []).map(ablationLabel).join(", ") || format(t, "statsUnknown") })),
            el("div", { className: "dsh-goldboard-experiment-checks" }, ["none", "without-regime-filter"].map(function (value) {
              var checked = Array.isArray(experiments.ablations) && experiments.ablations.indexOf(value) !== -1;
              return el("label", { className: "dsh-goldboard-experiment-check", key: "ablation-" + value },
                el("input", { type: "checkbox", checked: value === "none" || checked, disabled: value === "none" || running, onChange: function (event) { toggleListValue("ablations", value, event.target.checked); } }),
                el("span", null, ablationLabel(value)));
            })),
            el("button", {
              type: "button",
              className: "dsh-goldboard-btn",
              disabled: running,
              onClick: function () {
                updateExperiments(function (next) {
                  next.enabledStrategyIds = ["control", "orb-trend-pullback"];
                  next.signalLanes = ["cmb", "au9999", "xau"];
                  next.costMultipliers = [1, 2];
                  next.parameterMultipliers = [0.8, 1, 1.2];
                  next.ablations = ["none", "without-regime-filter"];
                  next.maxScenarios = Math.max(48, Number(next.maxScenarios) || 0);
                });
              },
            }, format(t, "experimentPromotionPreset")),
          ),
          el("div", { className: "dsh-goldboard-experiment-toolbar" },
            el(SelectField, { label: format(t, "experimentDays"), value: String(days), disabled: running, options: [1, 5, 10, 20, 30].map(function (value) { return { value: String(value), label: String(value) }; }), onChange: function (value) { setDays(Number(value) || 1); } }),
            el(SelectField, { label: format(t, "experimentMode"), value: mode, disabled: running, options: [
              { value: "diagnostic", label: format(t, "experimentMode_diagnostic") },
              { value: "walk-forward", label: format(t, "experimentMode_walk_forward") },
            ], onChange: setMode }),
            el("button", { type: "button", className: "dsh-goldboard-primary", disabled: running || !canRun, onClick: run }, running ? format(t, "experimentRunning") : format(t, "experimentRun")),
          ),
          !canRun && !running ? el("div", { className: "dsh-goldboard-experiment-status", role: "status" }, format(t, "experimentSaveRequired")) : null,
          messageText ? el("div", {
            className: "dsh-goldboard-experiment-status" + (message && message.warning ? "" : " dsh-goldboard-experiment-status-error"),
            role: message && message.warning ? "status" : "alert",
          }, messageText) : null,
          !report && !messageText ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "experimentEmpty")) : null,
          reportStale ? el("div", { className: "dsh-goldboard-experiment-status", role: "status" }, format(t, "experimentReportStale")) : null,
          report ? el("div", { className: "dsh-goldboard-experiment-report-meta" },
            el("span", null, format(t, "experimentReportSchema", { value: report.schema || format(t, "statsUnknown") })),
            el("span", null, format(t, "experimentReportGeneratedAt", { value: report.generatedAt || format(t, "statsUnknown") })),
            el("span", null, format(t, "experimentReportAsOf", { value: report.asOf || format(t, "statsUnknown") })),
            el("span", null, format(t, "experimentReportStatus", { value: statusLabel(report.status) })),
            el("span", null, format(t, "experimentReportId", { value: report.experimentId || format(t, "statsUnknown") })),
            el("span", { title: report.experimentFingerprint || format(t, "statsUnknown") }, format(t, "experimentFingerprint", { value: String(report.experimentFingerprint || format(t, "statsUnknown")).slice(0, 24) })),
          ) : null,
          scenarios.length > 0 ? el("div", null,
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "experimentScenarios")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  ["experimentScenarioStrategy", "experimentScenarioLane", "experimentScenarioCost", "experimentScenarioParameter", "experimentScenarioAblation", "experimentScenarioStatus", "experimentScenarioNet", "experimentScenarioDrawdown", "experimentScenarioOos"].map(function (key) { return el("th", { key: key }, format(t, key)); }))),
                el("tbody", null, scenarios.map(function (scenario) {
                  var oos = scenario.oos || {};
                  var reasons = Array.isArray(scenario.reasonCodes) && scenario.reasonCodes.length > 0 ? " · " + scenario.reasonCodes.map(reasonLabel).join(" · ") : "";
                  return el("tr", { key: scenario.scenarioId || [scenario.strategyId, scenario.signalLane, scenario.costMultiplier, scenario.parameterMultiplier, scenario.ablation].join("-") },
                    el("td", null, strategyLabel(scenario.strategyId)),
                    el("td", null, laneLabel(scenario.signalLane)),
                    el("td", null, numberText(scenario.costMultiplier)),
                    el("td", null, numberText(scenario.parameterMultiplier)),
                    el("td", null, ablationLabel(scenario.ablation)),
                    el("td", null, statusLabel(scenario.status) + reasons),
                    el("td", null, signedText(scenario.metrics && scenario.metrics.netPnlCny)),
                    el("td", null, numberText(scenario.metrics && scenario.metrics.maxDrawdownCny)),
                    el("td", null, format(t, "experimentOosSummary", { completed: Number(oos.completedFolds || 0), registered: Number(oos.registeredFolds || 0), status: statusLabel(oos.status) })),
                  );
                })),
              ),
            ),
          ) : null,
          comparisons.length > 0 ? el("div", null,
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "experimentComparisons")),
            el("div", { className: "dsh-goldboard-stats-scroll" },
              el("table", { className: "dsh-goldboard-stats-table" },
                el("thead", null, el("tr", null,
                  el("th", null, format(t, "experimentScenarioStrategy")),
                  el("th", null, format(t, "experimentScenarioLane")),
                  el("th", null, format(t, "experimentComparisonDelta")),
                  el("th", null, format(t, "experimentComparisonDrawdownDelta")),
                )),
                el("tbody", null, comparisons.map(function (comparison, index) {
                  return el("tr", { key: comparison.candidateScenarioId || "comparison-" + index },
                    el("td", null, strategyLabel(comparison.strategyId)),
                    el("td", null, laneLabel(comparison.signalLane)),
                    el("td", null, signedText(comparison.netPnlDeltaCny)),
                    el("td", null, signedText(comparison.maxDrawdownDeltaCny)),
                  );
                })),
              ),
            ),
          ) : null,
          report && report.promotion ? el("div", { className: "dsh-goldboard-experiment-promotion" },
            el("strong", null, format(t, "experimentPromotion")),
            el("span", { className: "dsh-goldboard-experiment-promotion-safe" }, format(t, "experimentPromotionSafe")),
            candidates.length === 0 ? el("span", null, format(t, "experimentPromotionNotEligible")) : candidates.map(function (candidate) {
              var eligible = !reportStale && candidate.eligible === true && candidate.status === "eligible_to_apply";
              var reasons = Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes.map(reasonLabel) : [];
              return el("span", { key: candidate.strategyId },
                format(t, "experimentPromotionCandidate", { strategy: strategyLabel(candidate.strategyId), status: format(t, eligible ? "experimentPromotionEligible" : "experimentPromotionNotEligible") }),
                reasons.length > 0 ? " · " + format(t, "experimentPromotionReasons", { reasons: reasons.join(" · ") }) : "",
              );
            }),
          ) : null,
          benchmarks.length > 0 ? el("div", null,
            el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "experimentBenchmarkCapabilities")),
            el("div", { className: "dsh-goldboard-experiment-benchmarks" }, benchmarks.map(function (benchmark) {
              return el("span", { key: benchmark.id }, format(t, "experimentBenchmarkUnavailable", { id: String(benchmark.id || format(t, "statsUnknown")).toUpperCase(), reason: reasonLabel(benchmark.reasonCode) }));
            })),
          ) : null,
        ),
      );
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
      var modelsState = useState(null);
      var models = modelsState[0];
      var setModels = modelsState[1];
      var analysisState = useState(null);
      var analysisResult = analysisState[0];
      var setAnalysisResult = analysisState[1];
      var analysisRunningState = useState(false);
      var analysisRunning = analysisRunningState[0];
      var setAnalysisRunning = analysisRunningState[1];
      var analysisLogsOpenState = useState(false);
      var analysisLogsOpen = analysisLogsOpenState[0];
      var setAnalysisLogsOpen = analysisLogsOpenState[1];
      var analysisLogsButtonRef = useRef(null);
      var spreadSourceState = useState(null);
      var spreadSource = spreadSourceState[0];
      var setSpreadSource = spreadSourceState[1];
      var riskStatusState = useState(null);
      var riskStatus = riskStatusState[0];
      var setRiskStatus = riskStatusState[1];
      var missingCmbState = useState(null);
      var missingCmb = missingCmbState[0];
      var setMissingCmb = missingCmbState[1];
      var missingCmbPricesState = useState({});
      var missingCmbPrices = missingCmbPricesState[0];
      var setMissingCmbPrices = missingCmbPricesState[1];
      var missingCmbLoadingState = useState(true);
      var missingCmbLoading = missingCmbLoadingState[0];
      var setMissingCmbLoading = missingCmbLoadingState[1];
      var manualCmbStatusState = useState(null);
      var manualCmbStatus = manualCmbStatusState[0];
      var setManualCmbStatus = manualCmbStatusState[1];
      var manualCmbSendingState = useState(false);
      var manualCmbSending = manualCmbSendingState[0];
      var setManualCmbSending = manualCmbSendingState[1];
      // plan-06: batch replay statistics card state.
      var statsDaysState = useState(10);
      var statsDays = statsDaysState[0];
      var setStatsDays = statsDaysState[1];
      var statsRunningState = useState(false);
      var statsRunning = statsRunningState[0];
      var setStatsRunning = statsRunningState[1];
      var statsResultState = useState(null);
      var statsResult = statsResultState[0];
      var setStatsResult = statsResultState[1];
      var statsMessageState = useState("");
      var statsMessage = statsMessageState[0];
      var setStatsMessage = statsMessageState[1];
       var statsDetailsOpenState = useState(false);
       var statsDetailsOpen = statsDetailsOpenState[0];
       var setStatsDetailsOpen = statsDetailsOpenState[1];
       var statsDetailsButtonRef = useRef(null);
       var riskLedgerButtonRef = useRef(null);

      var mode = props.mode || "settings";

      var load = useCallback(function () {
        fetchJson(CONFIG_URL)
          .then(function (body) {
            if (body && body.ok) {
              setData(body);
              setDraft(body.config);
              setStatus("");
            } else {
              setStatus(clientErrorText(t, body && body.error, "BAD_RESPONSE"));
            }
          })
          .catch(function () {
            setStatus(clientErrorText(t, "BAD_RESPONSE", "BAD_RESPONSE"));
          });
      }, [t]);

      useEffect(function () {
        load();
      }, [load]);

      var loadMissingCmb = useCallback(function () {
        setMissingCmbLoading(true);
        fetchJson(MANUAL_CMB_MISSING_URL)
          .then(function (body) {
            setMissingCmbLoading(false);
            if (body && body.ok && Array.isArray(body.slots)) {
              setMissingCmb(body.slots);
              setMissingCmbPrices({});
            } else {
              setMissingCmb([]);
            }
          })
          .catch(function () {
            setMissingCmbLoading(false);
            setMissingCmb([]);
          });
      }, []);

      useEffect(function () { loadMissingCmb(); }, [loadMissingCmb]);

      var loadModels = useCallback(function () {
        fetchJson(MODELS_URL)
          .then(function (body) {
            if (body && body.ok) setModels(body);
            else setModels({ ok: false, groups: [], failures: [{ id: "catalog", message: (body && body.error && body.error.code) || "MODEL_CATALOG_UNAVAILABLE" }] });
          })
          .catch(function (err) {
            setModels({ ok: false, groups: [], failures: [{ id: "catalog", message: String(err && err.message ? err.message : err) }] });
          });
      }, []);

      useEffect(function () { loadModels(); }, [loadModels]);

      useEffect(function () {
        fetchJson(DATA_SOURCES_URL)
          .then(function (body) {
            if (body && body.ok && Array.isArray(body.sources)) setSources(body.sources);
          })
          .catch(function () { setSources([]); });
      }, []);

      // Load spread provenance and the stage-2 risk/ledger projection without
      // deriving gate state from action strings in the browser.
      var loadRiskStatus = useCallback(function () {
        fetchJson(SNAPSHOT_URL)
          .then(function (body) {
            var cmb = body && body.derived && body.derived.cmb;
            if (cmb && cmb.spreadSource) setSpreadSource({ source: cmb.spreadSource, count: cmb.spreadSampleCount });
            else setSpreadSource(null);
            if (body && body.risk) {
              setRiskStatus({ risk: body.risk, ledger: body.ledger || null });
            }
          })
          .catch(function () { setSpreadSource(null); });
        fetchJson(LEDGER_URL + "?limit=10")
          .then(function (body) {
            if (body && body.ok && body.summary) {
              setRiskStatus(function (current) {
                return { risk: current && current.risk || null, ledger: body.summary };
              });
            }
          })
          .catch(function () { /* snapshot summary remains usable */ });
      }, []);
      useEffect(function () { loadRiskStatus(); }, [loadRiskStatus, mode]);

      var update = function (fn) {
        setStatus(function (current) { return current === "saved" ? "" : current; });
        setDraft(function (next) {
          if (!next) return next;
          var copy = JSON.parse(JSON.stringify(next));
          fn(copy);
          return copy;
        });
      };
      var updateRisk = function (fn) {
        update(function (next) {
          if (!next.risk) next.risk = JSON.parse(JSON.stringify(emptyConfig().risk));
          fn(next.risk);
        });
      };

      // One reporting funnel for every save failure.
      var reportSaveFailure = function (raw) {
        var detail = String(raw && raw.message ? raw.message : raw);
        setStatus(format(t, "saveError", { error: detail }));
      };

      var sectionsForMode = function (targetMode) {
        return MODE_SECTIONS[targetMode] || [];
      };
      var sliceSections = function (config, sections) {
        var out = {};
        (sections || []).forEach(function (section) { out[section] = config && config[section]; });
        return out;
      };

      var save = function () {
        var sections = sectionsForMode(mode);
        if (!draft || saving || sections.length === 0) return;
        setSaving(true);
        setStatus("");
        var payloadConfig = sliceSections(draft, sections);
        if (mode === "trading") {
          var todayKey = beijingDateKey(Date.now());
          // A form left open across Beijing midnight must not re-apply
          // yesterday's manual previous closes to today.
          if (draft.manualPrevCloseDate && draft.manualPrevCloseDate !== todayKey) {
            payloadConfig.manualPrevClose = { AU9999: null, XAU: null, CMB: null };
          }
          var manualValues = payloadConfig.manualPrevClose || {};
          var hasManual = ["AU9999", "XAU", "CMB"].some(function (key) {
            return manualValues[key] !== null && manualValues[key] !== undefined && Number(manualValues[key]) > 0;
          });
          payloadConfig.manualPrevCloseDate = hasManual ? todayKey : "";
        }
        var payload = {
          config: payloadConfig,
          clearSecrets: mode === "settings" ? clearSecrets : [],
        };
        if (data && Number.isInteger(data.revision)) payload.expectedRevision = data.revision;
        fetchJson(CONFIG_URL, {
          method: "POST",
          body: payload,
        })
          .then(function (body) {
            setSaving(false);
            if (body && body.ok) {
              setData(body);
              // Merge only this tab's sections back into the shared draft so
              // unsaved edits in other tabs survive an independent save.
              setDraft(function (previous) {
                var next = previous ? JSON.parse(JSON.stringify(previous)) : JSON.parse(JSON.stringify(body.config));
                sections.forEach(function (section) { next[section] = body.config[section]; });
                return next;
              });
              if (mode === "settings") setClearSecrets([]);
              setStatus("saved");
              if (typeof document !== "undefined") {
                document.dispatchEvent(new CustomEvent("dsh-plugin-goldboard:refresh"));
              }
              loadRiskStatus();
            } else if (body && body.error && body.error.code === "STALE_CONFIG") {
              // Keep the draft; adopt the current revision so the next save can
              // overwrite deliberately after the user has seen the conflict.
              setData(body);
              setStatus(format(t, "saveConflict"));
            } else {
              reportSaveFailure(clientErrorText(t, body && body.error, "SETTINGS_WRITE_FAILED"));
            }
          })
          .catch(function (err) {
            setSaving(false);
            reportSaveFailure(err);
          });
      };

      var runAnalysis = function () {
        if (!draft || !draft.analysis || analysisRunning) return;
        setAnalysisRunning(true);
        setAnalysisResult({ status: "running" });
        fetchJson(ANALYSIS_URL, {
          method: "POST",
          body: {
            force: false,
            provider: draft.analysis.provider,
            model: draft.analysis.model,
            reasoningEffort: draft.analysis.reasoningEffort,
            locale: isChineseLocale(t) ? "zh" : "en",
          },
        })
          .then(function (body) {
            setAnalysisResult(body || { ok: false, status: "error", error: { code: "ANALYSIS_FAILED" } });
            if (body && body.ok && typeof document !== "undefined") {
              document.dispatchEvent(new CustomEvent("dsh-plugin-goldboard:refresh"));
            }
          })
          .catch(function () {
            setAnalysisResult({ ok: false, status: "error", error: { code: "ANALYSIS_FAILED" } });
          })
          .then(function () { setAnalysisRunning(false); });
      };

      var runTest = function (channel, genericId, testConfig) {
        var testKey = channel + (genericId ? "-" + genericId : "");
        setTests(function (next) {
          var copy = { ...next };
          copy[testKey] = { status: "sending" };
          return copy;
        });
        fetchJson(TEST_URL, {
          method: "POST",
          body: { channel: channel, genericId: genericId, config: testConfig ?? {} },
        })
          .then(function (body) {
            setTests(function (next) {
              var copy = { ...next };
              copy[testKey] = body && body.ok
                ? { status: "ok" }
                : { status: "error", error: clientErrorText(t, body && body.error, "NOTIFY_FAILED") };
              return copy;
            });
          })
          .catch(function (err) {
            setTests(function (next) {
              var copy = { ...next };
              copy[testKey] = { status: "error", error: clientErrorText(t, "BAD_RESPONSE", "NOTIFY_FAILED") };
              return copy;
            });
          });
      };

      var submitManualCmb = function () {
        var entries = [];
        if (Array.isArray(missingCmb)) {
          for (var i = 0; i < missingCmb.length; i += 1) {
            var time = missingCmb[i];
            var raw = (missingCmbPrices[time] || "").trim();
            if (raw === "") continue;
            var price = Number(raw);
            if (Number.isFinite(price) && price > 0) entries.push({ time: time, price: price });
          }
        }
        if (entries.length === 0 || manualCmbSending) return;
        setManualCmbSending(true);
        setManualCmbStatus(null);
        fetchJson(MANUAL_CMB_URL, {
          method: "POST",
          body: { entries: entries },
        })
          .then(function (body) {
            setManualCmbSending(false);
            if (body && body.ok) {
              var message = format(t, "manualCmbAdded", { added: body.added, skipped: body.skipped });
              if (body.errors && body.errors.length > 0) message += " " + body.errors.join("; ");
              setManualCmbStatus({ ok: true, text: message });
              loadMissingCmb();
              if (typeof document !== "undefined") {
                document.dispatchEvent(new CustomEvent("dsh-plugin-goldboard:refresh"));
              }
              loadRiskStatus();
            } else {
              setManualCmbStatus({
                ok: false,
                text: clientErrorText(t, body && body.error, "MANUAL_CMB_FAILED"),
              });
            }
          })
          .catch(function (err) {
            setManualCmbSending(false);
            setManualCmbStatus({ ok: false, text: clientErrorText(t, "MANUAL_CMB_FAILED", "MANUAL_CMB_FAILED") });
          });
      };

      // ── plan-06: batch replay statistics ─────────────────────────────────
      //
      // Mount: show the most recent persisted report (GET is idempotent and
      // never throws). Generate: POST { days } — the host single-flights,
      // caches same-window results for an hour, and tolerates per-day source
      // failures inside the report (failures list), so the client only has to
      // render envelopes.
      var runStats = function (mode) {
        if (statsRunning) return;
        var requestedMode = mode === "walk-forward" ? "walk-forward" : "diagnostic";
        setStatsRunning(true);
        setStatsMessage("");
        fetchJson(REPLAY_STATS_URL, {
          method: "POST",
          body: { days: statsDays, mode: requestedMode, detail: false },
        })
          .then(function (body) {
            if (body && body.ok && body.report) {
              setStatsResult(body);
              var persistenceErrors = body.persistence && Array.isArray(body.persistence.errors)
                ? body.persistence.errors : [];
              setStatsMessage(persistenceErrors.length > 0
                ? format(t, "statsPersistWarning", {
                  error: persistenceErrors.map(function (entry) {
                    return clientErrorText(t, entry, entry && entry.code ? entry.code : "REPLAY_REPORT_PERSIST_FAILED");
                  }).join("; "),
                })
                : "");
            } else if (body && body.status === "cancelled") {
              setStatsMessage(format(t, "statsCancelled"));
            } else {
              var detail = clientErrorText(t, body && body.error, "REPLAY_STATS_FAILED");
              setStatsMessage(format(t, "statsFailed", { error: detail }));
            }
          })
          .catch(function () {
            setStatsMessage(format(t, "statsFailed", { error: clientErrorText(t, "REPLAY_STATS_FAILED", "REPLAY_STATS_FAILED") }));
          })
          .then(function () { setStatsRunning(false); });
      };
      var loadLastStats = useCallback(function () {
        var disposed = false;
        fetchJson(REPLAY_STATS_URL)
          .then(function (body) {
            if (!disposed && body && body.ok && body.report) setStatsResult({ ok: true, cached: true, report: body.report });
          })
          .catch(function () { /* first visit without a report — stay empty */ });
        return function () { disposed = true; };
      }, []);
      useEffect(function () { return loadLastStats(); }, [loadLastStats]);

      var statsReport = statsResult && typeof statsResult.report === "object" ? statsResult.report : null;
       var statsTotals = statsReport && statsReport.totals && typeof statsReport.totals === "object" ? statsReport.totals : {};
      var statsActionLabel = function (action) {
        var key = "enumAction_" + String(action || "");
        var translated = format(t, key);
        return translated === key ? String(action || "") : translated;
      };
      var statsPct = function (rate) {
        return rate !== null && rate !== undefined && rate !== "" && Number.isFinite(Number(rate))
          ? Math.round(Number(rate) * 1000) / 10 + "%"
          : format(t, "statsUnknown");
      };
      var statsNum = function (value) {
        return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
          ? Number(value).toFixed(2)
          : format(t, "statsUnknown");
      };
      var statsCount = function (value) {
         return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
           ? String(Number(value))
           : format(t, "statsUnknown");
       };
       var statsText = function (value) {
         return value === null || value === undefined || value === "" ? format(t, "statsUnknown") : String(value);
       };
       var statsHasDictKey = function (key) {
         return Object.prototype.hasOwnProperty.call(DICT.zh, key) || Object.prototype.hasOwnProperty.call(DICT.en, key);
       };
       var statsPolicyLabel = function (prefix, value) {
         if (!value) return format(t, "statsUnknown");
         var key = prefix + String(value).replace(/-/g, "_");
         return statsHasDictKey(key) ? format(t, key) : String(value);
       };
       var statsStatusLabel = function (value) {
         var key = "statsStatus_" + String(value || "unavailable");
         return statsHasDictKey(key) ? format(t, key) : format(t, "statsUnknown");
       };
       var statsLaneLabel = function (report) {
         var lane = report && typeof report.lane === "string" ? report.lane
           : report && report.params && typeof report.params.lane === "string" ? report.params.lane : null;
         if (lane === "cmb") return format(t, "statsLaneCmb");
         if (lane === "au9999") return format(t, "statsLaneAu9999");
         return format(t, "statsUnknown");
       };
       var statsEvidenceLabel = function (report) {
         var gate = report && report.validationGate;
         if (report && Number(report.version) === 6 && report.reportSchema === "goldboard-replay-report-v6" && report.evidenceStatus === "validated" && gate && gate.eligible === true) return format(t, "statsEvidenceValidated");
         if (report && report.evidenceStatus === "exploratory") return format(t, "statsEvidenceExploratory");
         return format(t, "statsEvidenceUnavailable");
       };
       var statsValidationReasonLabel = function (code) {
         var key = "statsValidationReason_" + String(code || "");
         return statsHasDictKey(key) ? format(t, key) : String(code || format(t, "statsUnknown"));
       };
       var statsCaveatLabel = function (code) {
         var key = "caveat_" + String(code || "").replace(/-/g, "_");
         return statsHasDictKey(key)
           ? format(t, key)
           : format(t, "statsCaveatUnknown", { code: String(code || format(t, "statsUnknown")) });
       };
       var statsCoverageSummary = function (report) {
         var coverage = report && report.executionCoverage;
         if (!coverage || typeof coverage !== "object") return [format(t, "statsCoverageUnavailable")];
         var total = statsCount(coverage.bars);
         return [
           format(t, "statsRealBidAskCoverage", { rate: statsPct(coverage.realBidAskCoverage), count: statsCount(coverage.realBidAskBars), total: total }),
           format(t, "statsProxyBidAskCoverage", { rate: statsPct(coverage.proxyBidAskCoverage), count: statsCount(coverage.proxyBars), total: total }),
           format(t, "statsUnknownBidAskCoverage", { rate: statsPct(coverage.unknownBidAskCoverage), count: statsCount(coverage.unknownBars), total: total }),
         ];
       };
       var statsCostSummary = function (report) {
         var costs = report && report.costAssumptions;
         if (!costs || typeof costs !== "object") return [format(t, "statsCostUnavailable")];
         var fee = costs.explicitFeePerGram || {};
         var slippage = costs.slippagePerGram || {};
         var fallback = costs.configuredFallbackOffsetPerGram || {};
         var parts = [
           format(t, "statsCostFees", { buy: statsNum(fee.buy), sell: statsNum(fee.sell) }),
           format(t, "statsCostSlippage", { buy: statsNum(slippage.buy), sell: statsNum(slippage.sell) }),
           format(t, "statsCostFallback", { buy: statsNum(fallback.buy), sell: statsNum(fallback.sell), spread: statsNum(costs.estimatedSpreadPerGram) }),
         ];
         if (costs.historicalCmbProxySpreadPerGram !== null && costs.historicalCmbProxySpreadPerGram !== undefined) {
           parts.push(format(t, "statsCostProxy", { spread: statsNum(costs.historicalCmbProxySpreadPerGram) }));
         }
         if (costs.productAgreementVerified !== true) parts.push(format(t, "statsCostUnverified"));
         if (costs.realBidAskQuotedSpreadIncluded === true && Number(report?.executionCoverage?.realBidAskBars) > 0) {
           parts.push(format(t, "statsCostQuotedSpread"));
         }
         return parts;
       };
       var statsValidationSummary = function (report) {
         var gate = report && report.validationGate;
         if (!gate || !Array.isArray(gate.unmet) || gate.unmet.length === 0) return "";
         return format(t, "statsValidationReasons", { reasons: gate.unmet.map(statsValidationReasonLabel).join(" · ") });
       };
       // Overall-block fallback for legacy v2 persisted reports: derive the
      // event count and a per-gram average from the per-action rows only
      // (win rate / CNY sums need event detail those reports never carried).
      var statsOverallOf = function (report) {
        if (!report || ![5, 6].includes(Number(report.version)) || !report.executionVersion) return null;
        if (!report.overall || report.overall.accounting !== "continuous-zero-position") return null;
        return report.overall;
      };
      var statsCard = function (key, valueNode, hintParams, actionNode) {
        return el("div", { className: "dsh-goldboard-stats-card", key: key },
          el("span", { className: "dsh-goldboard-stats-card-value" }, valueNode),
          el("span", { className: "dsh-goldboard-stats-card-label" }, format(t, key)),
          el("span", { className: "dsh-goldboard-stats-card-hint" }, format(t, key + "Hint", hintParams || {})),
           actionNode || null,
        );
      };

      var snapshotDay = props.snapshot && props.snapshot.serverTime ? beijingDateKey(props.snapshot.serverTime) : "";
      useEffect(function () {
        if (!snapshotDay || !data || !data.config || !data.config.manualPrevCloseDate) return;
        if (data.config.manualPrevCloseDate !== snapshotDay) load();
      }, [snapshotDay, data && data.config ? data.config.manualPrevCloseDate : ""]);

      useEffect(function () {
        setLogSource(null);
        setAnalysisLogsOpen(false);
        setStatsDetailsOpen(false);
        setStatus(function (current) { return current === "saved" ? "" : current; });
      }, [mode, props.visible]);

      if (!draft) {
        return el("div", { className: "dsh-goldboard-workbench", "data-mode": mode },
          el("div", { className: "dsh-goldboard-workbench-status" },
            status ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-error" }, status) : el("span", { className: "dsh-goldboard-tag" }, format(t, "loading")),
          ),
          el("div", { className: "dsh-goldboard-workbench-body" },
            status ? el("button", { className: "dsh-goldboard-btn", onClick: load }, format(t, "retryConfig")) : null,
            !status ? el("div", { className: "dsh-goldboard-card-row" }, el("div", { className: "dsh-goldboard-loading" }, format(t, "loading"))) : null,
          ),
        );
      }

      var cfg = draft;
      var manualPrevClose = cfg.manualPrevClose || { AU9999: null, XAU: null, CMB: null };
      var riskCfg = cfg.risk || emptyConfig().risk;
      var riskView = riskStatus && riskStatus.risk || null;
      var riskLedger = riskStatus && riskStatus.ledger || null;
      var riskGate = riskView && riskView.gate || null;
      var riskLosses = riskView && riskView.losses || {};
      var riskAdds = riskView && riskView.adds || {};
      var riskCounts = riskLedger && riskLedger.counts || {};
      var riskNumber = function (value) {
        return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : format(t, "riskUnknown");
      };
      var secretSet = data && data.secretSet ? data.secretSet : {};
      var modeSections = sectionsForMode(mode);
      var dirty = !!(data && data.config && (
        JSON.stringify(sliceSections(cfg, modeSections)) !== JSON.stringify(sliceSections(data.config, modeSections))
        || (mode === "settings" && clearSecrets.length > 0)
      ));
      var lotList = Array.isArray(cfg.position && cfg.position.lots) ? cfg.position.lots : [];
      var totalGrams = lotList.reduce(function (sum, lot) { return sum + Number(lot.grams || 0); }, 0);
      var totalCost = lotList.reduce(function (sum, lot) { return sum + Number(lot.grams || 0) * Number(lot.price || 0); }, 0);
      var avgCostValue = totalGrams > 0 ? totalCost / totalGrams : 0;
      var filledCmbCount = Array.isArray(missingCmb)
        ? missingCmb.filter(function (time) {
            var raw = (missingCmbPrices[time] || "").trim();
            if (raw === "") return false;
            var price = Number(raw);
            return Number.isFinite(price) && price > 0;
          }).length
        : 0;
      var analysisCfg = cfg.analysis || emptyConfig().analysis;
      var modelGroups = models && Array.isArray(models.groups) ? models.groups : [];
      var providerGroup = modelGroups.find(function (group) { return group.id === analysisCfg.provider; }) || null;
      var providerOptions = [{ value: "", label: format(t, "analysisProvider") }].concat(modelGroups.map(function (group) {
        return { value: group.id, label: group.name || group.id };
      }));
      if (analysisCfg.provider && !modelGroups.some(function (group) { return group.id === analysisCfg.provider; })) {
        providerOptions.push({ value: analysisCfg.provider, label: analysisCfg.provider + " (" + format(t, "selectedModelUnavailable") + ")" });
      }
      var availableModels = providerGroup && Array.isArray(providerGroup.models) ? providerGroup.models : [];
      var modelOptions = [{ value: "", label: format(t, "analysisModel") }].concat(availableModels.map(function (model) {
        return { value: model.id, label: model.name || model.id };
      }));
      if (analysisCfg.model && !availableModels.some(function (model) { return model.id === analysisCfg.model; })) {
        modelOptions.push({ value: analysisCfg.model, label: analysisCfg.model + " (" + format(t, "selectedModelUnavailable") + ")" });
      }
      var selectedModel = availableModels.find(function (model) { return model.id === analysisCfg.model; }) || null;
      var efforts = selectedModel && selectedModel.reasoning && Array.isArray(selectedModel.reasoning.efforts) ? selectedModel.reasoning.efforts : [];
      var reasoningOptions = efforts.map(function (effort) { return { value: effort.id, label: effort.name || effort.id }; });
      if (analysisCfg.reasoningEffort && !efforts.some(function (effort) { return effort.id === analysisCfg.reasoningEffort; })) {
        reasoningOptions.push({ value: analysisCfg.reasoningEffort, label: analysisCfg.reasoningEffort + " (" + format(t, "selectedModelUnavailable") + ")" });
      }
      var selectedModelUnavailable = !!analysisCfg.model && !selectedModel;

      // plan-05 B.3: one renderer for the three fixed channels and the
      // generic webhook cards (~90% shared markup, previously duplicated).
      var webhookCard = function (spec) {
        var channel = spec.channel;
        var key = spec.key;
        var testKey = spec.testKey;
        var testResult = tests[testKey];
        var sending = testResult && testResult.status === "sending";
        return el(CardRow, { key: key, title: spec.title, hint: format(t, "webhookTemplateHint") },
          spec.extraHeader || null,
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { label: format(t, "webhookEnabled") + " · " + spec.title, checked: channel.enabled === true, onChange: spec.onEnabled }),
            el("span", null, format(t, "webhookEnabled")),
            spec.onRemove ? el("button", { className: "dsh-goldboard-btn", onClick: spec.onRemove }, format(t, "genericRemove")) : null,
          ),
          spec.nameField || null,
          el(TextField, {
            label: format(t, "webhookUrl"),
            value: channel.url,
            placeholder: "https://…",
            onChange: spec.onUrl,
          }),
          spec.secretDotted ? el("div", { className: "dsh-goldboard-row" },
            el(TextField, {
              label: format(t, "webhookSecret"),
              value: typeof channel.secret === "string" ? channel.secret : "",
              placeholder: secretSet[spec.secretDotted] ? format(t, "webhookSecretSet") : "",
              onChange: spec.onSecret,
            }),
            secretSet[spec.secretDotted] ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-ok" }, format(t, "webhookSecretBadge")) : null,
            secretSet[spec.secretDotted] ? el("button", {
              className: "dsh-goldboard-btn",
              type: "button",
              onClick: function () {
                update(function (next) { if (spec.secretWriter(next)) spec.secretWriter(next).secret = ""; });
                setClearSecrets(function (next) { return next.includes(spec.secretDotted) ? next : next.concat(spec.secretDotted); });
              },
            }, format(t, "webhookSecretClear")) : null,
          ) : null,
          el(TextField, {
            label: format(t, "webhookTemplate"),
            value: channel.bodyTemplate,
            placeholder: "",
            onChange: spec.onTemplate,
          }),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              className: "dsh-goldboard-btn",
              disabled: sending,
              onClick: spec.onTest,
            }, sending ? format(t, "testSending") : format(t, "test")),
            testResult && testResult.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "testOk")) : null,
            testResult && testResult.status === "error" ? el("span", { className: "dsh-goldboard-error" }, format(t, "testFailed", { error: testResult.error || "" })) : null,
          ),
        );
      };

      var channelCard = function (key, title, hasSecret) {
        return webhookCard({
          key: key,
          title: title,
          channel: cfg.webhooks[key],
          testKey: key,
          secretDotted: hasSecret ? "webhooks." + key + ".secret" : null,
          onEnabled: function (value) { update(function (next) { next.webhooks[key].enabled = value; }); },
          onUrl: function (value) { update(function (next) { next.webhooks[key].url = value; }); },
          onSecret: hasSecret ? function (value) { update(function (next) { next.webhooks[key].secret = value; }); } : undefined,
          secretWriter: hasSecret ? function (next) { return next.webhooks[key]; } : undefined,
          onTemplate: function (value) { update(function (next) { next.webhooks[key].bodyTemplate = value; }); },
          onTest: function () { runTest(key, undefined, cfg.webhooks[key]); },
        });
      };

      var genericCards = cfg.webhooks.generic.map(function (item, index) {
        return el("div", { className: "dsh-goldboard-generic", key: item.id },
          webhookCard({
            key: "generic-" + item.id,
            title: item.name || format(t, "genericDefaultName", { n: index + 1 }),
            channel: item,
            testKey: "generic-" + item.id,
            secretDotted: null,
            extraHeader: null,
            onEnabled: function (value) { update(function (next) { next.webhooks.generic[index].enabled = value; }); },
            onRemove: function () { update(function (next) { next.webhooks.generic.splice(index, 1); }); },
            nameField: el(TextField, { label: format(t, "genericName"), value: item.name, onChange: function (value) { update(function (next) { next.webhooks.generic[index].name = value; }); } }),
            onUrl: function (value) { update(function (next) { next.webhooks.generic[index].url = value; }); },
            onTemplate: function (value) { update(function (next) { next.webhooks.generic[index].bodyTemplate = value; }); },
            onTest: function () { runTest("generic", item.id, item); },
          }),
        );
      });

      var saved = status === "saved";

      // ── 策略统计 render model ────────────────────────────────────────────
      // Two reading layers: the continuous zero-position account on top, then
      // per-action tables split into entry vs exit families because the same
      // columns mean different things for each family.
      var statsPerAction = Array.isArray(statsReport && statsReport.perAction) ? statsReport.perAction : [];
      var statsIsEntryRow = function (row) { return row.action === "buy_setup" || row.action === "add_position"; };
      var statsEntryRows = statsPerAction.filter(statsIsEntryRow);
      var statsExitRows = statsPerAction.filter(function (row) { return !statsIsEntryRow(row); });
      var statsSignedValue = function (value) {
        if (value === null || value === undefined || value === "") return format(t, "statsUnknown");
        var num = Number(value);
        if (!Number.isFinite(num)) return format(t, "statsUnknown");
        return el("span", { className: num >= 0 ? "dsh-goldboard-stats-net-pos" : "dsh-goldboard-stats-net-neg" }, (num >= 0 ? "+" : "") + num.toFixed(2));
      };
      var statsEntryRowNode = function (row) {
        return el("tr", { key: row.action },
          el("td", null, statsActionLabel(row.action)),
          el("td", null, String(row.count)),
          el("td", null, row.targetHitRate === null || row.targetHitRate === undefined ? "—" : statsPct(row.targetHitRate)),
          el("td", null, row.stopHitRate === null || row.stopHitRate === undefined ? "—" : statsPct(row.stopHitRate)),
          el("td", null, statsNum(row.avgMfe30m)),
          el("td", null, statsNum(row.avgMae30m)),
          el("td", null, statsSignedValue(row.sessionEndAvgNet)),
        );
      };
      var statsExitRowNode = function (row) {
        return el("tr", { key: row.action },
          el("td", null, statsActionLabel(row.action)),
          el("td", null, String(row.count)),
          el("td", null, statsNum(row.avgMfe30m)),
          el("td", null, statsNum(row.avgMae30m)),
          el("td", null, statsNum(row.avgPostExitDrift60m)),
          el("td", null, statsSignedValue(row.sessionEndAvgNet)),
        );
      };
      var statsGroupBlock = function (key, titleKey, hintKey, headerCells, rows, rowNode) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return el("div", { key: key },
          el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, titleKey)),
          el("p", { className: "dsh-goldboard-stats-group-hint" }, format(t, hintKey)),
          el("div", { className: "dsh-goldboard-stats-scroll" },
            el("table", { className: "dsh-goldboard-stats-table" },
              el("thead", null, el("tr", null, headerCells)),
              el("tbody", null, rows.map(rowNode)),
            ),
          ),
        );
      };
      var statsEntryGroup = statsGroupBlock("entry",
        "statsGroupEntryTitle", "statsGroupEntryHint",
        [
          el("th", { key: "a" }, format(t, "statsTableAction")),
          el("th", { key: "c", title: format(t, "statsTipCount") }, format(t, "statsTableCount")),
          el("th", { key: "t", title: format(t, "statsTipTargetHit") }, format(t, "statsTableTargetHit")),
          el("th", { key: "s", title: format(t, "statsTipStopHit") }, format(t, "statsTableStopHit")),
          el("th", { key: "mfe", title: format(t, "statsTipMfe30") }, format(t, "statsTableMfe30")),
          el("th", { key: "mae", title: format(t, "statsTipMae30") }, format(t, "statsTableMae30")),
          el("th", { key: "net", title: format(t, "statsTipHoldNet") }, format(t, "statsTableHoldNet")),
        ],
        statsEntryRows, statsEntryRowNode);
      var statsExitGroup = statsGroupBlock("exit",
        "statsGroupExitTitle", "statsGroupExitHint",
        [
          el("th", { key: "a" }, format(t, "statsTableAction")),
          el("th", { key: "c", title: format(t, "statsTipCount") }, format(t, "statsTableCount")),
          el("th", { key: "fall", title: format(t, "statsTipMfe30") }, format(t, "statsTableFallMfe30")),
          el("th", { key: "reb", title: format(t, "statsTipMae30") }, format(t, "statsTableReboundMae30")),
          el("th", { key: "drift", title: format(t, "statsTipDrift60") }, format(t, "statsTableDrift60")),
          el("th", { key: "save", title: format(t, "statsTipExitSaving") }, format(t, "statsTableExitSaving")),
        ],
        statsExitRows, statsExitRowNode);

      var discard = function () {
        if (data && data.config) {
          setDraft(function (previous) {
            var next = previous ? JSON.parse(JSON.stringify(previous)) : JSON.parse(JSON.stringify(data.config));
            sectionsForMode(mode).forEach(function (section) { next[section] = data.config[section]; });
            return next;
          });
        }
        if (mode === "settings") setClearSecrets([]);
        setStatus("");
      };
      var savedAt = status === "saved";
      var actionBar = modeSections.length > 0 ? el("div", { className: "dsh-goldboard-workbench-actions" },
        el("div", { className: "dsh-goldboard-workbench-actions-status" },
          saving ? el("span", { className: "dsh-goldboard-tag" }, format(t, "saving")) : null,
          dirty ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-warn" }, format(t, "unsaved")) : null,
          savedAt ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-ok" }, format(t, "saved")) : null,
          !saving && !dirty && !savedAt && status ? el("span", { className: "dsh-goldboard-tag dsh-goldboard-tag-error" }, status) : null,
        ),
        el("div", { className: "dsh-goldboard-workbench-actions-buttons" },
          el("button", { type: "button", className: "dsh-goldboard-btn", disabled: saving || !dirty, onClick: discard }, format(t, "discard")),
          el("button", { type: "button", className: "dsh-goldboard-primary", disabled: saving || !dirty, onClick: save }, saving ? format(t, "saving") : format(t, "save")),
        ),
      ) : null;
      var inlineActions = actionBar;
      var portalActions = null;
      if (actionBar && props.visible !== false && props.actionsSlot && ReactDOM && typeof ReactDOM.createPortal === "function") {
        portalActions = ReactDOM.createPortal(actionBar, props.actionsSlot);
        inlineActions = null;
      }

      return el("div", { className: "dsh-goldboard-workbench", "data-mode": mode },
        inlineActions,
        el("div", { className: "dsh-goldboard-workbench-body" },

        el(CardRow, { id: "dsh-goldboard-trading-position", className: "dsh-goldboard-section-position", title: format(t, "positionTitle"), hint: format(t, "positionHint") },
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

        el(CardRow, {
          id: "dsh-goldboard-trading-risk",
          className: "dsh-goldboard-section-risk",
          title: format(t, "riskTitle"),
          hint: format(t, "riskHint"),
          titleExtra: el("button", {
            ref: riskLedgerButtonRef,
            type: "button",
            className: "dsh-goldboard-btn",
            onClick: function () { if (typeof props.onOpenLedger === "function") props.onOpenLedger(); },
          }, format(t, "ledgerDetails")),
        },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(SelectField, {
              label: format(t, "riskMode"),
              value: riskCfg.mode,
              options: [
                { value: "fixed_grams", label: format(t, "riskModeFixedGrams") },
                { value: "budget", label: format(t, "riskModeBudget") },
              ],
              onChange: function (value) { updateRisk(function (risk) { risk.mode = value; }); },
            }),
            el(NumberField, { label: format(t, "referenceEquityCny"), value: riskCfg.referenceEquityCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.referenceEquityCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxAmountCny"), value: riskCfg.maxAmountCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.maxAmountCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxRiskPerTradeCny"), value: riskCfg.maxRiskPerTradeCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.maxRiskPerTradeCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxDailyLossCny"), value: riskCfg.maxDailyLossCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.maxDailyLossCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxWeeklyLossCny"), value: riskCfg.maxWeeklyLossCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.maxWeeklyLossCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxDrawdownCny"), value: riskCfg.maxDrawdownCny, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.maxDrawdownCny = Number(value); }); } }),
            el(NumberField, { label: format(t, "volatilityTarget"), value: riskCfg.volatilityTarget, min: 0, max: 10, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.volatilityTarget = Number(value); }); } }),
            el(NumberField, { label: format(t, "liquidityCapGrams"), value: riskCfg.liquidityCapGrams, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.liquidityCapGrams = Number(value); }); } }),
            el(NumberField, { label: format(t, "maxAddsPerSetup"), value: riskCfg.maxAddsPerSetup, min: 0, step: 1, onChange: function (value) { updateRisk(function (risk) { risk.maxAddsPerSetup = Math.floor(Number(value)); }); } }),
            el(NumberField, { label: format(t, "maxAddsPerDay"), value: riskCfg.maxAddsPerDay, min: 0, step: 1, onChange: function (value) { updateRisk(function (risk) { risk.maxAddsPerDay = Math.floor(Number(value)); }); } }),
            el(NumberField, { label: format(t, "minAddPriceImprovement"), value: riskCfg.minAddPriceImprovementPerGram, min: 0, step: 0.01, onChange: function (value) { updateRisk(function (risk) { risk.minAddPriceImprovementPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "consecutiveLossDeRisk"), value: riskCfg.consecutiveLossDeRisk, min: 0, step: 1, onChange: function (value) { updateRisk(function (risk) { risk.consecutiveLossDeRisk = Math.floor(Number(value)); }); } }),
          ),
          el("div", { className: "dsh-goldboard-hint", title: format(t, "volatilityTargetHint") }, format(t, "zeroDisablesGate") + " " + format(t, "referenceEquityHint")),
          riskGate || riskLedger ? el("div", { className: "dsh-goldboard-risk-overview", "aria-live": "polite" },
            riskGate ? el("span", { className: "dsh-goldboard-risk-overview-strong " + (riskGate.triggered ? "dsh-goldboard-risk-overview-blocked" : "dsh-goldboard-risk-overview-ok") }, format(t, riskGate.triggered ? "riskGateBlocked" : "riskGateOpen")) : null,
            riskGate && riskGate.triggered ? el("span", null, format(t, "riskGateProtectiveExitAllowed")) : null,
            el("span", null, format(t, "riskDailyLoss", { value: riskNumber(riskLosses.dailyLossCny) })),
            el("span", null, format(t, "riskWeeklyLoss", { value: riskNumber(riskLosses.weeklyLossCny) })),
            el("span", null, format(t, "riskDrawdown", { value: riskNumber(riskLosses.drawdownCny) })),
            el("span", null, format(t, "riskAddsToday", { value: Number(riskAdds.today ?? riskLedger?.addsToday ?? 0) })),
            el("span", null, format(t, "riskSetupAdds", { value: Number(riskAdds.activeSetup ?? riskLedger?.activeSetupAdds ?? 0) })),
            el("span", null, format(t, "riskLedgerCounts", { decisions: Number(riskCounts.decisions ?? 0), orders: Number(riskCounts.orders ?? 0), blocked: Number(riskCounts.notExecuted ?? 0) })),
            riskLedger && riskLedger.activeSetupId
              ? el("span", { className: "dsh-goldboard-ledger-id" }, format(t, "riskActiveSetup", { id: riskLedger.activeSetupId }))
              : el("span", null, format(t, "riskNoActiveSetup")),
            riskGate && Array.isArray(riskGate.reasonCodes) && riskGate.reasonCodes.length > 0 ? el("span", null, formatReasonCodes(t, riskGate.reasonCodes)) : null,
          ) : null,
          el("div", { className: "dsh-goldboard-hint" }, format(t, "riskEvidenceHint")),
        ),

        el(CardRow, { id: "dsh-goldboard-trading-fee", className: "dsh-goldboard-section-fee", title: format(t, "feeTitle") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "buyFee"), value: cfg.fee.buyPerGram, min: 0, onChange: function (value) { update(function (next) { next.fee.buyPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "sellFee"), value: cfg.fee.sellPerGram, min: 0, onChange: function (value) { update(function (next) { next.fee.sellPerGram = Number(value); }); } }),
          ),
          el("div", { className: "dsh-goldboard-hint" }, format(t, "feeTotal") + ": " + (Number(cfg.fee.buyPerGram) + Number(cfg.fee.sellPerGram)) + " ¥/g"),
          el("label", { className: "dsh-goldboard-field", title: format(t, "deriveSellFromFeeTip") },
            el("span", null, format(t, "deriveSellFromFee")),
            el(Switch, {
              checked: cfg.cmb.deriveSellFromFee === true,
              onChange: function (value) { update(function (next) { next.cmb.deriveSellFromFee = value; }); },
            }),
          ),
          cfg.cmb.deriveSellFromFee === true ? el("div", { className: "dsh-goldboard-hint" }, format(t, "deriveSellFromFeeActive")) : null,
        ),

        el(CardRow, { id: "dsh-goldboard-trading-cmb", className: "dsh-goldboard-section-cmb", title: format(t, "cmbTitle"), hint: format(t, "cmbHint") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "cmbBuySpread"), value: cfg.cmb.buySpreadPerGram, onChange: function (value) { update(function (next) { next.cmb.buySpreadPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "cmbSellSpread"), value: cfg.cmb.sellSpreadPerGram, onChange: function (value) { update(function (next) { next.cmb.sellSpreadPerGram = Number(value); }); } }),
          ),
          spreadSource ? el("div", { className: "dsh-goldboard-hint" },
            format(t, "cmbSpreadSourceLabel") + ": " + (
              spreadSource.source === "live"
                ? format(t, "cmbSpreadSourceLive")
                : spreadSource.source === "dynamic-bid-ask"
                  ? format(t, "cmbSpreadSourceDynamic", { count: Number(spreadSource.count) || 0 })
                  : spreadSource.source === "dynamic-legacy"
                    ? format(t, "cmbSpreadSourceLegacy", { count: Number(spreadSource.count) || 0 })
                    : format(t, "cmbSpreadSourceStatic", { count: 30 })
            )
          ) : null,
        ),

        el(CardRow, { id: "dsh-goldboard-trading-manual-prev", className: "dsh-goldboard-section-manual-prev", title: format(t, "manualPrevCloseTitle"), hint: format(t, "manualPrevCloseHint") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(NumberField, { label: format(t, "au9999"), value: manualPrevClose.AU9999 ?? "", min: 0, onChange: function (value) { update(function (next) { next.manualPrevClose.AU9999 = value === "" ? null : Number(value) || null; }); } }),
            el(NumberField, { label: format(t, "xau"), value: manualPrevClose.XAU ?? "", min: 0, onChange: function (value) { update(function (next) { next.manualPrevClose.XAU = value === "" ? null : Number(value) || null; }); } }),
            el(NumberField, { label: format(t, "cmbEstimate"), value: manualPrevClose.CMB ?? "", min: 0, onChange: function (value) { update(function (next) { next.manualPrevClose.CMB = value === "" ? null : Number(value) || null; }); } }),
          ),
        ),

        el(CardRow, { className: "dsh-goldboard-section-manual-cmb", title: format(t, "manualCmbTitle"), hint: format(t, "manualCmbHint") },
          missingCmbLoading
            ? el("div", { className: "dsh-goldboard-loading" }, format(t, "manualCmbMissingLoading"))
            : (!Array.isArray(missingCmb) || missingCmb.length === 0)
              ? el("div", { className: "dsh-goldboard-ok" }, format(t, "manualCmbMissingNone"))
              : el("div", { className: "dsh-goldboard-missing-list" },
                  missingCmb.map(function (time) {
                    return el("div", { className: "dsh-goldboard-missing-row", key: time },
                      el("span", { className: "dsh-goldboard-missing-time" }, time),
                      el("input", {
                        className: "dsh-goldboard-input",
                        type: "number",
                        step: "0.01",
                        min: "0",
                        placeholder: format(t, "manualCmbPricePlaceholder"),
                        value: missingCmbPrices[time] || "",
                        disabled: manualCmbSending,
                        onChange: function (event) {
                          var patch = {};
                          patch[time] = event.target.value;
                          setMissingCmbPrices(function (prev) { return Object.assign({}, prev, patch); });
                        },
                      }),
                    );
                  }),
                ),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              type: "button",
              className: "dsh-goldboard-btn",
              disabled: manualCmbSending || filledCmbCount === 0,
              onClick: submitManualCmb,
            }, manualCmbSending ? format(t, "manualCmbSending") : format(t, "manualCmbSubmit") + (filledCmbCount > 0 ? " (" + filledCmbCount + ")" : "")),
            manualCmbStatus ? el("span", { className: manualCmbStatus.ok ? "dsh-goldboard-ok" : "dsh-goldboard-error" }, manualCmbStatus.text) : null,
          ),
        ),

        el(CardRow, { id: "dsh-goldboard-trading-strategy", className: "dsh-goldboard-section-strategy", title: format(t, "strategyTitle") },
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
            el(NumberField, { label: format(t, "scoreThreshold"), value: cfg.strategy.scoreThreshold, min: 1, max: 8, onChange: function (value) { update(function (next) { next.strategy.scoreThreshold = Number(value); }); } }),
            el(NumberField, { label: format(t, "orderRepricePct"), value: cfg.strategy.orderRepricePct, min: 0, max: 10, onChange: function (value) { update(function (next) { next.strategy.orderRepricePct = Number(value); }); } }),
            el(NumberField, { label: format(t, "targetTrailPerGram"), value: cfg.strategy.targetTrailPerGram, min: 0, max: 100, step: 0.1, onChange: function (value) { update(function (next) { next.strategy.targetTrailPerGram = Number(value); }); } }),
            el(NumberField, { label: format(t, "targetPartialRatio"), value: cfg.strategy.targetPartialRatio, min: 0, max: 0.9, step: 0.05, onChange: function (value) { update(function (next) { next.strategy.targetPartialRatio = Number(value); }); } }),
            el(NumberField, { label: format(t, "targetTrailBars"), value: cfg.strategy.targetTrailBars, min: 0, max: 288, step: 1, onChange: function (value) { update(function (next) { next.strategy.targetTrailBars = Math.floor(Number(value)); }); } }),
            el("label", { className: "dsh-goldboard-field", title: format(t, "requirePriceAboveEma60Tip") },
              el("span", null, format(t, "requirePriceAboveEma60")),
              el(Switch, {
                checked: cfg.strategy.requirePriceAboveEma60 === true,
                onChange: function (value) { update(function (next) { next.strategy.requirePriceAboveEma60 = value; }); },
              }),
            ),
            el("label", { className: "dsh-goldboard-field", title: format(t, "requireDailyUptrendTip") },
              el("span", null, format(t, "requireDailyUptrend")),
              el(Switch, {
                checked: cfg.strategy.requireDailyUptrend === true,
                onChange: function (value) { update(function (next) { next.strategy.requireDailyUptrend = value; }); },
              }),
            ),
            el(NumberField, { label: format(t, "maxBarsBeforeTarget"), value: cfg.strategy.maxBarsBeforeTarget, min: 0, max: 10000, step: 1, onChange: function (value) { update(function (next) { next.strategy.maxBarsBeforeTarget = Math.floor(Number(value)); }); } }),
            el("label", { className: "dsh-goldboard-field", title: format(t, "closeBySessionEndTip") },
              el("span", null, format(t, "closeBySessionEnd")),
              el(Switch, {
                checked: cfg.strategy.closeBySessionEnd === true,
                onChange: function (value) { update(function (next) { next.strategy.closeBySessionEnd = value; }); },
              }),
            ),
          ),
        ),

        el(StrategyExperimentPanel, { t: t, cfg: cfg, update: update }),

        el(CardRow, { id: "dsh-goldboard-trading-hours", className: "dsh-goldboard-section-trading", title: format(t, "tradingTitle") },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { label: format(t, "weekdaysOnly"), checked: cfg.tradingHours.weekdaysOnly === true, onChange: function (value) { update(function (next) { next.tradingHours.weekdaysOnly = value; }); } }),
            el("span", null, format(t, "weekdaysOnly")),
          ),
          el("div", { className: "dsh-goldboard-form-grid" },
            el(TextField, { label: format(t, "openTime"), value: cfg.tradingHours.open, onChange: function (value) { update(function (next) { next.tradingHours.open = value; }); } }),
            el(TextField, { label: format(t, "closeTime"), value: cfg.tradingHours.close, onChange: function (value) { update(function (next) { next.tradingHours.close = value; }); } }),
          ),
          el(TextField, { label: format(t, "holidays"), value: cfg.tradingHours.holidays.join(", "), onChange: function (value) { update(function (next) { next.tradingHours.holidays = value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean); }); } }),
        ),

        el(CardRow, {
          className: "dsh-goldboard-section-analysis",
          title: format(t, "analysisTitle"),
          titleExtra: el("button", {
            ref: analysisLogsButtonRef,
            className: "dsh-goldboard-btn",
            onClick: function () { setAnalysisLogsOpen(true); },
          }, format(t, "viewAnalysisLogs")),
          hint: format(t, "analysisHint"),
        },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, {
              label: format(t, "analysisEnabled"),
              checked: analysisCfg.enabled === true,
              onChange: function (value) { update(function (next) { next.analysis.enabled = value; }); },
            }),
            el("span", null, format(t, "analysisEnabled")),
          ),
          models === null ? el("div", { className: "dsh-goldboard-loading" }, format(t, "modelsLoading")) : null,
          models && modelGroups.length === 0 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "noModels")) : null,
          el("div", { className: "dsh-goldboard-form-grid" },
            el(SelectField, {
              label: format(t, "analysisProvider"),
              value: analysisCfg.provider,
              options: providerOptions,
              disabled: models === null || modelGroups.length === 0,
              onChange: function (value) {
                update(function (next) {
                  var group = modelGroups.find(function (entry) { return entry.id === value; });
                  var firstModel = group && group.models && group.models[0];
                  var nextEfforts = firstModel && firstModel.reasoning && firstModel.reasoning.efforts || [];
                  var low = nextEfforts.find(function (entry) { return entry.id === "low"; });
                  next.analysis.provider = value;
                  next.analysis.model = firstModel ? firstModel.id : "";
                  next.analysis.reasoningEffort = low ? low.id : firstModel && firstModel.reasoning && firstModel.reasoning.defaultEffort || "";
                });
              },
            }),
            el(SelectField, {
              label: format(t, "analysisModel"),
              value: analysisCfg.model,
              options: modelOptions,
              disabled: !providerGroup,
              onChange: function (value) {
                update(function (next) {
                  var model = availableModels.find(function (entry) { return entry.id === value; });
                  var nextEfforts = model && model.reasoning && model.reasoning.efforts || [];
                  var low = nextEfforts.find(function (entry) { return entry.id === "low"; });
                  next.analysis.model = value;
                  next.analysis.reasoningEffort = low ? low.id : model && model.reasoning && model.reasoning.defaultEffort || "";
                });
              },
            }),
            efforts.length > 0 ? el(SelectField, {
              label: format(t, "analysisReasoning"),
              value: analysisCfg.reasoningEffort,
              options: reasoningOptions,
              onChange: function (value) { update(function (next) { next.analysis.reasoningEffort = value; }); },
            }) : null,
            el(NumberField, { label: format(t, "analysisCooldown"), value: analysisCfg.cooldownMinutes, min: 0, max: 1440, onChange: function (value) { update(function (next) { next.analysis.cooldownMinutes = Number(value); }); } }),
            el(NumberField, { label: format(t, "analysisTimeout"), value: Number(analysisCfg.timeoutMs) / 1000, min: 5, max: 180, step: 1, onChange: function (value) { update(function (next) { next.analysis.timeoutMs = Math.round(Number(value) * 1000); }); } }),
            el(NumberField, { label: format(t, "analysisMaxTokens"), value: analysisCfg.maxTokens, min: 128, max: 32000, step: 1, onChange: function (value) { update(function (next) { next.analysis.maxTokens = Number(value); }); } }),
          ),
          selectedModelUnavailable ? el("div", { className: "dsh-goldboard-error", role: "alert" }, format(t, "selectedModelUnavailable")) : null,
          models && Array.isArray(models.failures) && models.failures.length > 0 ? el("div", { className: "dsh-goldboard-analysis-failures" },
            el("strong", null, format(t, "providerFailures")),
            models.failures.map(function (failure) { return el("span", { key: failure.id }, (failure.name || failure.id) + ": " + (failure.message || "")); }),
          ) : null,
          el("div", { className: "dsh-goldboard-analysis-actions dsh-goldboard-analysis-primary-actions" },
            el("button", {
              className: "dsh-goldboard-primary",
              disabled: analysisRunning || dirty || analysisCfg.enabled !== true || !selectedModel,
              onClick: runAnalysis,
            }, analysisRunning ? format(t, "analysisRunning") : format(t, "runAnalysis")),
          ),
          el("div", { className: "dsh-goldboard-analysis-status" + (analysisResult && analysisResult.ok === false ? " dsh-goldboard-analysis-status-error" : analysisResult && analysisResult.ok === true ? " dsh-goldboard-analysis-status-ok" : ""), "aria-live": "polite" },
            analysisRunning ? format(t, "analysisRunning") : null,
            !analysisRunning && analysisResult && analysisResult.ok === true ? format(t, "analysisSuccess") : null,
            !analysisRunning && analysisResult && analysisResult.status === "blocked" ? format(t, "analysisBlocked") : null,
            !analysisRunning && analysisResult && analysisResult.ok === false && analysisResult.status !== "blocked" ? format(t, "analysisFailed", { error: analysisErrorText(t, analysisResult.error && analysisResult.error.code) }) : null,
            analysisResult && analysisResult.queryId ? el("span", null, format(t, "analysisQueryId") + ": " + analysisResult.queryId) : null,
          ),
          analysisResult && analysisResult.ok === true && analysisResult.analysis ? el("div", { className: "dsh-goldboard-analysis-result" },
            analysisResult.analysis.summary ? el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisSummary")), el("span", null, analysisResult.analysis.summary)) : null,
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisBias")), el("span", null, analysisEnumLabel(t, "Bias", analysisResult.analysis.bias) + (analysisEnumHint(t, "Bias", analysisResult.analysis.bias) ? wrapHint(t, analysisEnumHint(t, "Bias", analysisResult.analysis.bias)) : ""))),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisAction")), el("span", null, analysisEnumLabel(t, "Action", analysisResult.analysis.action) + (analysisEnumHint(t, "Action", analysisResult.analysis.action) ? wrapHint(t, analysisEnumHint(t, "Action", analysisResult.analysis.action)) : ""))),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisHorizon")), el("span", null, analysisEnumLabel(t, "Horizon", analysisResult.analysis.horizon) + (analysisEnumHint(t, "Horizon", analysisResult.analysis.horizon) ? wrapHint(t, analysisEnumHint(t, "Horizon", analysisResult.analysis.horizon)) : ""))),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisConfidence")), el("span", null, analysisEnumLabel(t, "Confidence", analysisResult.analysis.confidence) + (analysisEnumHint(t, "Confidence", analysisResult.analysis.confidence) ? wrapHint(t, analysisEnumHint(t, "Confidence", analysisResult.analysis.confidence)) : ""))),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisEvidence")), el("span", null, (analysisResult.analysis.evidence || []).map(function (item) { return humanizeAnalysisText(t, item); }).join(" · ") || "—")),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisSupport")), el("span", null, (analysisResult.analysis.support || []).join(" · ") || "—")),
            el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisResistance")), el("span", null, (analysisResult.analysis.resistance || []).join(" · ") || "—")),
            (analysisResult.analysis.dataWarnings || []).length > 0 ? el("div", { className: "dsh-goldboard-analysis-result-row" }, el("span", { className: "dsh-goldboard-analysis-result-label" }, format(t, "analysisWarnings")), el("span", null, (analysisResult.analysis.dataWarnings || []).map(function (item) { return humanizeAnalysisText(t, item); }).join(" · "))) : null,
          ) : null,
          el("div", { className: "dsh-goldboard-hint" }, format(t, "riskNote")),
        ),

        // plan-06: batch replay statistics (read-only rule hit-rate report).
        el(CardRow, {
          className: "dsh-goldboard-section-ledger",
          title: format(t, "ledgerTitle"),
          hint: format(t, "ledgerHint"),
          titleExtra: el("button", {
            ref: riskLedgerButtonRef,
            type: "button",
            className: "dsh-goldboard-btn",
            onClick: function () { if (typeof props.onOpenLedger === "function") props.onOpenLedger(); },
          }, format(t, "ledgerDetails")),
        },
          riskLedger ? el("div", { className: "dsh-goldboard-kv" },
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "ledgerDecisions")), el("span", { className: "dsh-goldboard-kv-value" }, String(Number(riskCounts.decisions ?? 0)))),
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "ledgerOrders")), el("span", { className: "dsh-goldboard-kv-value" }, String(Number(riskCounts.orders ?? 0)))),
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "ledgerBlocked")), el("span", { className: "dsh-goldboard-kv-value" }, String(Number(riskCounts.notExecuted ?? 0)))),
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "riskActiveSetup", { id: "" }).replace(/[：:]\s*$/, "")), el("span", { className: "dsh-goldboard-kv-value" }, riskLedger.activeSetupId || format(t, "riskNoActiveSetup"))),
          ) : el("div", { className: "dsh-goldboard-hint" }, format(t, "loading")),
        ),

        el(CardRow, { className: "dsh-goldboard-section-stats", title: format(t, "statsTitle"), hint: format(t, "statsHint") },
          el("div", { className: "dsh-goldboard-stats-actions" },
            el(SelectField, {
              label: format(t, "statsDays"),
              value: String(statsDays),
              disabled: statsRunning,
              options: [
                { value: "10", label: "10" },
                { value: "20", label: "20" },
                { value: "30", label: "30" },
              ],
              onChange: function (value) { setStatsDays(Number(value) || 10); },
            }),
            el("button", {
              type: "button",
              className: "dsh-goldboard-primary",
              disabled: statsRunning,
              onClick: function () { runStats("diagnostic"); },
            }, statsRunning ? format(t, "statsGenerating") : format(t, "statsGenerate")),
            el("button", {
              type: "button",
              className: "dsh-goldboard-btn",
              disabled: statsRunning,
              onClick: function () { runStats("walk-forward"); },
            }, format(t, "statsValidate")),
          ),
          el("div", { className: "dsh-goldboard-analysis-status" + (statsMessage ? " dsh-goldboard-analysis-status-error" : ""), "aria-live": "polite" },
            statsRunning ? format(t, "statsGenerating") : null,
            !statsRunning && statsMessage ? statsMessage : null,
          ),
          !statsReport && !statsRunning && !statsMessage ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsEmpty")) : null,
          statsReport ? el("div", { className: "dsh-goldboard-stats-summary" },
             statsCoverageSummary(statsReport).map(function (text, index) {
               return el("span", { key: "metadata-coverage-" + index }, text);
             }),
             el("span", { className: statsReport.evidenceStatus === "exploratory" ? "dsh-goldboard-tag dsh-goldboard-tag-warn" : "dsh-goldboard-tag" }, statsEvidenceLabel(statsReport)),
             el("span", null, format(t, "statsGeneratedAt", { time: formatBeijingTime(statsReport.generatedAt, true) === "—" ? format(t, "statsUnknown") : formatBeijingTime(statsReport.generatedAt, true) })),
             el("span", null, format(t, "statsStrategy", { id: statsText(statsReport.strategyId), version: statsText(statsReport.strategyVersion) })),
             el("span", null, format(t, "statsVersions", {
               calculation: statsText(statsReport.calculationVersion),
               data: statsText(statsReport.dataSchemaVersion),
               execution: statsText(statsReport.executionVersion),
               calendar: statsText(statsReport.calendarVersion),
             })),
             el("span", null, format(t, "statsExecution", {
               version: statsText(statsReport.executionVersion),
               fill: statsPolicyLabel("statsFillPolicy_", statsReport.fillPolicy),
               ambiguity: statsPolicyLabel("statsAmbiguityPolicy_", statsReport.ambiguityPolicy),
             })),
            el("span", null, format(t, "statsReportVersion", { version: statsText(statsReport.version) })),
            el("span", null, format(t, "statsWindow", { from: statsText(statsReport.window && statsReport.window.from), to: statsText(statsReport.window && statsReport.window.to) })),
            el("span", null, format(t, "statsLane", { lane: statsLaneLabel(statsReport) })),
            el("span", null, format(t, "statsDaysEvaluated", { evaluated: statsCount(statsReport.daysEvaluated), requested: statsCount(statsReport.daysRequested) })),
            Number(statsReport.version) >= 5 ? el("span", null, format(t, "statsCompleteDays", { count: statsCount(statsReport.completeDays) })) : null,
            Number(statsReport.version) >= 5 && Number(statsReport.partialDays) > 0 ? el("span", null, format(t, "statsPartialDays", { count: statsCount(statsReport.partialDays) })) : null,
            el("span", null, format(t, "statsSteps", { count: statsCount(statsTotals.steps) })),
            el("span", null, format(t, "statsEvents", { count: statsCount(statsTotals.directionalEvents) })),
            Number(statsReport.version) >= 5 ? el("span", null,
              Object.prototype.hasOwnProperty.call(statsReport.totals || {}, "unexecutedSignals")
                ? format(t, "statsUnexecutedCount", { count: statsCount(statsTotals.unexecutedSignals) })
                : format(t, "statsUnexecutedCountUnavailable")
            ) : null,
            el("span", null, format(t, "statsBlocked", { ratio: statsPct(statsTotals.coverageBlockedRatio) })),
            statsResult && statsResult.cached === true ? el("span", null, format(t, "statsCached")) : null,
          ) : null,
          statsReport && Number(statsReport.version) === 5 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "statsV5Banner")) : null,
          statsReport && Number(statsReport.version) === 6 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "statsV6Banner")) : null,
          statsReport && !statsOverallOf(statsReport) ? el("div", { className: "dsh-goldboard-hint" }, format(t, "statsLegacyReport", { version: statsText(statsReport.version) })) : null,
           statsReport && statsReport.evidenceStatus === "exploratory" ? el("div", { className: "dsh-goldboard-hint" }, format(t, "statsValidationNotEligible")) : null,
           statsReport && statsValidationSummary(statsReport) ? el("div", { className: "dsh-goldboard-hint" }, statsValidationSummary(statsReport)) : null,
           statsReport ? el("div", { className: "dsh-goldboard-hint" },
             el("strong", null, format(t, "statsCostAssumptions")),
             statsCostSummary(statsReport).map(function (text, index) {
               return el("span", { key: index }, index === 0 ? ": " : " · ", text);
             }),
           ) : null,
          statsReport && Number(statsReport.version) >= 5 ? el("div", { className: "dsh-goldboard-stats-summary" },
            el("span", null, format(t, "statsFillRate", { rate: statsPct(statsReport.fillRate) })),
            el("span", null, format(t, "statsExpiryRate", { rate: statsPct(statsReport.expiryRate) })),
            el("span", null, format(t, "statsAmbiguousBars", { count: statsCount(statsReport.ambiguousBarCount) })),
            el("span", null, format(t, "statsBidAskCoverage", { rate: statsPct(statsReport.realBidAskCoverage) })),
            el("span", null, format(t, "statsAverageDelay", { ms: statsCount(statsReport.averageDelayMs) })),
          ) : null,
          (function () {
            if (!statsReport || Number(statsReport.version) !== 6 || !statsReport.dataset) return null;
            var dataset = statsReport.dataset;
            var range = dataset.dateRange || {};
            var bars5 = dataset.bars && (dataset.bars[5] || dataset.bars["5"]) || {};
            var fingerprint = statsText(dataset.datasetId || statsReport.dataVersion);
            var inputFingerprint = statsText(statsReport.inputFingerprint);
            var reportFingerprint = statsText(statsReport.reportFingerprint);
            var shortHash = function (value) { return value === format(t, "statsUnknown") ? value : String(value).slice(0, 24); };
            return el("div", { key: "dataset" },
              el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsDatasetTitle")),
              el("div", { className: "dsh-goldboard-stats-summary" },
                el("span", { title: fingerprint }, format(t, "statsDatasetId", { id: shortHash(fingerprint) })),
                el("span", null, format(t, "statsDatasetRange", { from: statsText(range.from), to: statsText(range.to) })),
                el("span", null, format(t, "statsDatasetHistory", { months: statsNum(dataset.historyMonths) })),
                el("span", null, format(t, "statsDatasetBars", { complete: statsCount(bars5.complete), total: statsCount(bars5.total) })),
                el("span", null, format(t, "statsDatasetRecords", { count: statsCount(dataset.records && dataset.records.accepted) })),
                el("span", { title: inputFingerprint }, format(t, "statsInputFingerprint", { value: shortHash(inputFingerprint) })),
                el("span", { title: reportFingerprint }, format(t, "statsReportFingerprint", { value: shortHash(reportFingerprint) })),
              ),
            );
          })(),
          (function () {
            if (!statsReport || Number(statsReport.version) !== 6 || !statsReport.metrics) return null;
            var metrics = statsReport.metrics;
            var returnInterval = metrics.returnInterval || {};
            var winInterval = metrics.winRateInterval || {};
            return el("div", { key: "metrics" },
              el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsMetricsTitle")),
              el("div", { className: "dsh-goldboard-stats-summary" },
                el("span", null, format(t, "statsMetricSharpe", { value: statsNum(metrics.sharpe) })),
                el("span", null, format(t, "statsMetricSortino", { value: statsNum(metrics.sortino) })),
                el("span", null, format(t, "statsMetricCalmar", { value: statsNum(metrics.calmar) })),
                el("span", null, format(t, "statsMetricExposure", { value: statsPct(metrics.exposureRatio) })),
                el("span", null, format(t, "statsMetricUtilization", { value: statsPct(metrics.capitalUtilization) })),
                el("span", null, format(t, "statsMetricDrawdown", { value: statsNum(metrics.maxDrawdownCny), rate: statsPct(metrics.maxDrawdownPct) })),
                el("span", null, format(t, "statsMetricDrawdownDuration", { value: statsNum(Number(metrics.maxDrawdownDurationMs) / 3600000) })),
                el("span", null, format(t, "statsMetricTurnover", { value: statsNum(metrics.turnoverCny) })),
                el("span", null, format(t, "statsMetricProfitFactor", { value: statsNum(metrics.profitFactor) })),
                el("span", null, format(t, "statsReturnInterval", { low: statsPct(returnInterval.lower), high: statsPct(returnInterval.upper) })),
                el("span", null, format(t, "statsWinInterval", { low: statsPct(winInterval.lower), high: statsPct(winInterval.upper) })),
              ),
            );
          })(),
          (function () {
            if (!statsReport || Number(statsReport.version) !== 6 || !statsReport.oos) return null;
            var oos = statsReport.oos;
            var folds = Array.isArray(oos.folds) ? oos.folds : [];
            var completed = oos.observed && oos.observed.completedFolds || folds.filter(function (fold) { return fold.status === "completed"; }).length;
            return el("div", { key: "oos" },
              el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsOosTitle")),
              el("p", { className: "dsh-goldboard-stats-group-hint" }, format(t, "statsOosSummary", {
                status: statsStatusLabel(oos.status),
                registered: statsCount(folds.length),
                completed: statsCount(completed),
              })),
              folds.length === 0 ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsOosInsufficient"))
                : el("div", { className: "dsh-goldboard-stats-scroll" },
                    el("table", { className: "dsh-goldboard-stats-table" },
                      el("thead", null, el("tr", null,
                        el("th", null, format(t, "statsFoldTrain")),
                        el("th", null, format(t, "statsFoldTest")),
                        el("th", null, format(t, "statsFoldSamples")),
                        el("th", null, format(t, "statsFoldStatus")),
                      )),
                      el("tbody", null, folds.map(function (fold) {
                        return el("tr", { key: fold.foldId || fold.id },
                          el("td", null, statsText(fold.train && fold.train.from).slice(0, 10) + " ~ " + statsText(fold.train && fold.train.toExclusive).slice(0, 10)),
                          el("td", null, statsText(fold.test && fold.test.from).slice(0, 10) + " ~ " + statsText(fold.test && fold.test.toExclusive).slice(0, 10)),
                          el("td", null, statsCount(fold.sampleCount ?? (fold.test && fold.test.completeSessions))),
                          el("td", null, statsStatusLabel(fold.status)),
                        );
                      })),
                    ),
                  ),
            );
          })(),
          (function () {
            if (!statsReport || Number(statsReport.version) !== 6 || !statsReport.benchmarks) return null;
            var ids = ["no_trade", "buy_and_hold", "fixed_interval_dca", "simple_moving_average"];
            return el("div", { key: "benchmarks" },
              el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsBenchmarksTitle")),
              el("div", { className: "dsh-goldboard-stats-scroll" },
                el("table", { className: "dsh-goldboard-stats-table" },
                  el("thead", null, el("tr", null,
                    el("th", null, format(t, "statsBenchmarkName")),
                    el("th", null, format(t, "statsBenchmarkNet")),
                    el("th", null, format(t, "statsBenchmarkReturn")),
                    el("th", null, format(t, "statsBenchmarkDrawdown")),
                    el("th", null, format(t, "statsFoldStatus")),
                  )),
                  el("tbody", null, ids.map(function (id) {
                    var benchmark = statsReport.benchmarks[id] || {};
                    var metrics = benchmark.metrics || {};
                    return el("tr", { key: id },
                      el("td", null, format(t, "statsBenchmark_" + id)),
                      el("td", null, statsSignedValue(metrics.netPnlCny)),
                      el("td", null, statsPct(metrics.totalReturn)),
                      el("td", null, statsPct(metrics.maxDrawdownPct)),
                      el("td", null, statsStatusLabel(benchmark.status)),
                    );
                  })),
                ),
              ),
            );
          })(),
          (function () {
            // v5/v6 account total: one chronological portfolio starts at zero.
            // Legacy reports remain read-only diagnostics and never receive v5
            // execution labels or account cards.
            var ov = statsOverallOf(statsReport);
            if (!ov) return null;
            return el("div", { key: "overall" },
              el("div", { className: "dsh-goldboard-stats-group-title" }, format(t, "statsOverallTitle")),
              el("div", { className: "dsh-goldboard-stats-overall" },
                statsCard("statsCardTotalNet", statsSignedValue(ov.totalNetCny), null,
                  el("button", {
                    ref: statsDetailsButtonRef,
                    type: "button",
                    className: "dsh-goldboard-btn dsh-goldboard-stats-detail-button",
                    onClick: function () { setStatsDetailsOpen(true); },
                  }, format(t, "statsDetails")),
                ),
                statsCard("statsCardRealizedNet", statsSignedValue(ov.realizedNetCny)),
                statsCard("statsCardUnrealizedNet", statsSignedValue(ov.unrealizedNetCny)),
                statsCard("statsCardEndingPosition", fmtPrice(ov.endingGrams)),
              ),
            );
          })(),
          (function () {
            // Parameter snapshot: shows exactly which strategy
            // values this replay ran under — e.g. whether 收盘前强制平仓 was on.
            var snap = statsReport && statsReport.params && statsReport.params.strategy;
            if (!snap) return null;
            return el("div", { className: "dsh-goldboard-stats-summary", key: "params" },
              el("span", null, format(t, "statsParamsTitle")),
              el("span", null, format(t, "statsParamConfirmBars", { n: snap.confirmBars })),
              el("span", null, format(t, "statsParamScoreThreshold", { n: snap.scoreThreshold })),
              el("span", null, format(t, "statsParamCooldown", { m: snap.signalCooldownMinutes })),
              el("span", null, format(t, snap.closeBySessionEnd === true ? "statsParamCloseOn" : "statsParamCloseOff")),
            );
          })(),
          statsReport && statsReport.daysFailed > 0 ? el("div", { className: "dsh-goldboard-analysis-failures" },
            format(t, "statsPartialFailures", {
              count: statsReport.daysFailed,
              detail: (statsReport.failures || []).map(function (failure) { return failure.day + " (" + failure.error + ")"; }).join("; "),
            }),
          ) : null,
          statsReport && Number(statsReport.version) >= 5 ? statsEntryGroup : null,
          statsReport && Number(statsReport.version) >= 5 ? statsExitGroup : null,
          statsReport && statsPerAction.length === 0 && !statsRunning ? el("div", { className: "dsh-goldboard-stats-empty" }, format(t, "statsNoEvents")) : null,
          statsReport && Number(statsReport.version) >= 5 && ((statsReport.ruleScoreBuckets || statsReport.confidenceBuckets || []).length > 0) ? el("div", { className: "dsh-goldboard-stats-summary" },
            el("strong", null, format(t, "statsConfidenceTitle")),
            (statsReport.ruleScoreBuckets || statsReport.confidenceBuckets).map(function (bucket) {
              return el("span", { key: bucket.bucket }, bucket.bucket + ": " + bucket.events + " · " + statsPct(bucket.targetHitRate));
            }),
          ) : null,
          statsReport ? el("div", null,
            el("div", { className: "dsh-goldboard-hint" }, format(t, "statsCaveatsTitle")),
            el("ul", { className: "dsh-goldboard-stats-caveats" },
              (statsReport.caveats || []).map(function (code) {
                return el("li", { key: code }, statsCaveatLabel(code));
              })),
          ) : null,
        ),

        el(CardRow, { className: "dsh-goldboard-section-sources", title: format(t, "sourceStatus") },
          !sources ? el("div", { className: "dsh-goldboard-loading" }, format(t, "loading"))
            : sources.length === 0 ? el("div", { className: "dsh-goldboard-hint" }, format(t, "noData"))
            : sources.map(function (source) {
                var health = source.health || {};
                var statusLabel = source.status === "ok" ? format(t, "sourceOk") : source.status === "error" ? format(t, "sourceError") : source.status === "circuit_open" ? format(t, "sourceCircuitOpen") : format(t, "sourceUnknown");
                var statusClass = source.status === "ok" ? "dsh-goldboard-tag dsh-goldboard-tag-ok" : (source.status === "error" || source.status === "circuit_open") ? "dsh-goldboard-tag dsh-goldboard-tag-error" : "dsh-goldboard-tag";
                var currentText = source.current
                  ? format(t, "sourceCurrent") + ": " + fmtPrice(source.current.price) + (source.current.stale ? " (" + format(t, "stale") + ")" : "")
                  : format(t, "sourceNoCurrent");
                var lastText = source.lastTime ? format(t, "sourceLast") + ": " + formatBeijingTime(source.lastTime, true) : "";
                var successText = Number.isFinite(Number(health.successRate)) ? format(t, "sourceSuccessRate", { rate: Math.round(Number(health.successRate) * 100) + "%" }) : "";
                var latencyText = Number.isFinite(Number(health.latencyMs && health.latencyMs.p50)) && Number.isFinite(Number(health.latencyMs && health.latencyMs.p95))
                  ? format(t, "sourceLatency", { p50: health.latencyMs.p50, p95: health.latencyMs.p95 }) : "";
                var failureText = Number(health.consecutiveFailures) > 0
                  ? format(t, "sourceFailureDuration", { minutes: Math.max(1, Math.round(Number(health.consecutiveFailureDurationMs) / 60000)) }) : "";
                var fallbackText = Number.isFinite(Number(health.availableFallbackCount)) ? format(t, "sourceFallbacks", { count: health.availableFallbackCount }) : "";
                var historyText = health.executionHistory ? format(t, "sourceExecutionCoverage", {
                  real: statsPct(health.executionHistory.realRatio),
                  proxy: statsPct(health.executionHistory.proxyRatio),
                  synthetic: statsPct(health.executionHistory.syntheticRatio),
                }) + " · " + format(t, "sourceGapCount", { count: (health.executionHistory.gaps || []).length }) : "";
                return el("div", { key: source.id, className: "dsh-goldboard-source-row" },
                  el("div", { className: "dsh-goldboard-source-info" },
                    el("span", { className: "dsh-goldboard-source-name" }, isChineseLocale(t)
                    ? (source.nameZh || source.nameEn || source.id)
                    : (source.nameEn || source.nameZh || source.id)),
                    el("span", { className: "dsh-goldboard-source-meta" },
                      currentText,
                      lastText ? " · " + lastText : "",
                      source.logCount !== undefined ? " · " + format(t, "sourceLogCount", { count: source.logCount }) : "",
                      successText ? " · " + successText : "",
                      latencyText ? " · " + latencyText : "",
                      fallbackText ? " · " + fallbackText : "",
                      failureText ? " · " + failureText : "",
                      historyText ? " · " + historyText : "",
                    ),
                  ),
                  el("span", { className: statusClass }, statusLabel),
                  el("button", { className: "dsh-goldboard-btn", onClick: function () { setLogSource(source); } }, format(t, "viewLogs")),
                );
              }),
          props.snapshot && props.snapshot.historical ? el("div", { className: "dsh-goldboard-kv" },
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "historicalRecords")), el("span", { className: "dsh-goldboard-kv-value" }, String(props.snapshot.historical.records ?? 0))),
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "dataCoverage")), el("span", { className: "dsh-goldboard-kv-value" }, format(t, "sourceExecutionCoverage", { real: statsPct(props.snapshot.historical.realRatio), proxy: statsPct(props.snapshot.historical.proxyRatio), synthetic: statsPct(props.snapshot.historical.syntheticRatio) }))),
            el("div", { className: "dsh-goldboard-kv-row" }, el("span", { className: "dsh-goldboard-kv-label" }, format(t, "sourceLast")), el("span", { className: "dsh-goldboard-kv-value" }, props.snapshot.historical.lastValidAt ? formatBeijingTime(props.snapshot.historical.lastValidAt, true) : "—")),
          ) : null,
        ),

        el(CardRow, { className: "dsh-goldboard-section-sidebar-price", title: format(t, "sidebarPriceTitle"), hint: format(t, "sidebarPriceHint") },
          el("div", { className: "dsh-goldboard-form-grid" },
            el(SelectField, {
              label: format(t, "sidebarPriceField"),
              value: cfg.sidebarPrice || "AU9999",
              options: [
                { value: "AU9999", label: format(t, "sidebarPriceDomestic") },
                { value: "XAU", label: format(t, "sidebarPriceXAU") },
                { value: "CMB", label: format(t, "sidebarPriceCMB") },
              ],
              onChange: function (value) { update(function (next) { next.sidebarPrice = value; }); },
            }),
          ),
        ),

        el(CardRow, { id: "dsh-goldboard-settings-alerts", className: "dsh-goldboard-section-alerts", title: format(t, "alertsTitle") },
          el("div", { className: "dsh-goldboard-row" },
            el(Switch, { label: format(t, "systemEnabled"), checked: cfg.system.enabled === true, onChange: function (value) { update(function (next) { next.system.enabled = value; }); } }),
            el("span", null, format(t, "systemEnabled")),
          ),
          el("div", { className: "dsh-goldboard-hint" }, format(t, "systemHint")),
          el("div", { className: "dsh-goldboard-row" },
            el("button", {
              className: "dsh-goldboard-btn",
              disabled: tests.system && tests.system.status === "sending",
              onClick: function () { runTest("system", undefined, { enabled: cfg.system.enabled }); },
            }, tests.system && tests.system.status === "sending" ? format(t, "testSending") : format(t, "test")),
            tests.system && tests.system.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "systemTestOk")) : null,
            tests.system && tests.system.status === "error" ? el("span", { className: "dsh-goldboard-error" }, format(t, "testFailed", { error: tests.system.error || "" })) : null,
          ),
          isDesktop() ? el("div", { className: "dsh-goldboard-row" },
            el("button", {
              type: "button",
              className: "dsh-goldboard-btn",
              disabled: tests.systemSettings && tests.systemSettings.status === "sending",
              onClick: function () {
                setTests(function (next) { var copy = { ...next }; copy.systemSettings = { status: "sending" }; return copy; });
                fetchJson(SYSTEM_SETTINGS_URL, { method: "POST", body: {} })
                  .then(function (body) {
                    setTests(function (next) {
                      var copy = { ...next };
                      copy.systemSettings = body && body.ok ? { status: "ok" } : { status: "error", error: clientErrorText(t, body && body.error, "SYSTEM_SETTINGS_FAILED") };
                      return copy;
                    });
                  })
                  .catch(function () {
                    setTests(function (next) { var copy = { ...next }; copy.systemSettings = { status: "error", error: clientErrorText(t, "SYSTEM_SETTINGS_FAILED", "SYSTEM_SETTINGS_FAILED") }; return copy; });
                  });
              },
            }, format(t, "openSystemSettings")),
            tests.systemSettings && tests.systemSettings.status === "ok" ? el("span", { className: "dsh-goldboard-ok" }, format(t, "systemSettingsOpened")) : null,
            tests.systemSettings && tests.systemSettings.status === "error" ? el("span", { className: "dsh-goldboard-error" }, tests.systemSettings.error || format(t, "error_SYSTEM_SETTINGS_FAILED")) : null,
          ) : null,
        ),

        el(CardRow, { id: "dsh-goldboard-settings-webhooks", className: "dsh-goldboard-section-webhooks", title: format(t, "webhookTitle"), hint: format(t, "webhookTemplateHint") },
          channelCard("feishu", format(t, "feishu"), true),
          channelCard("dingtalk", format(t, "dingtalk"), true),
          channelCard("wecom", format(t, "wecom"), false),
          el("div", { className: "dsh-goldboard-generic" },
            genericCards.length > 0 ? genericCards : el("div", { className: "dsh-goldboard-hint" }, format(t, "genericNone")),
          ),
          el("button", { className: "dsh-goldboard-add", onClick: function () { update(function (next) { next.webhooks.generic.push({ id: "wh-" + Date.now().toString(36), name: "", enabled: false, url: "", bodyTemplate: "" }); }); } }, format(t, "genericAdd")),
        ),
        ),
        logSource ? el(DataSourceLogsDialog, {
          t: t,
          source: logSource,
          onClose: function () { setLogSource(null); },
        }) : null,
        analysisLogsOpen ? el(AnalysisLogsDialog, {
          t: t,
          modelCatalog: models,
          onClose: function () {
            setAnalysisLogsOpen(false);
            if (analysisLogsButtonRef.current) analysisLogsButtonRef.current.focus();
          },
        }) : null,
        statsDetailsOpen ? el(ReplayStatsDetailsDialog, {
          t: t,
          reportId: statsReport && statsReport.reportId,
          onClose: function () {
            setStatsDetailsOpen(false);
            if (statsDetailsButtonRef.current) statsDetailsButtonRef.current.focus();
          },
        }) : null,
        portalActions,
      );
    }

    // ── plugin body ────────────────────────────────────────────────────────

    var pluginName = "dsh-plugin-goldboard";
    var inject = ["slots", "locale", "layout"];

    function apply(ctx) {
      var locale = ctx.get("locale");
      activeLocaleRef = locale;
      layoutServiceRef = ctx.get("layout") || null;
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

      slots.inject("main", function () {
        return slots.register({
          name: "main",
          key: PAGE_ID,
          locale: NS,
        }, function GoldBoardPageSlot(props) {
          return el(GoldBoardPageEntry, props);
        });
      });

      slots.inject("sidebar.panellist", function () {
        return slots.register({
          name: "sidebar.panellist",
          id: PAGE_ID,
          order: 20,
          locale: NS,
          label: function () { return t("panel"); },
        }, GoldBoardIcon);
      });
    }

    exports.apply = apply;
    exports.name = pluginName;
    exports.inject = inject;
    exports.DICT = DICT;
    exports.StrategyExperimentPanel = StrategyExperimentPanel;
    exports.SettingsSection = SettingsSection;
    exports.OverviewTab = OverviewTab;
    exports.RiskLedgerDialog = RiskLedgerDialog;
    exports.GoldBoardPage = GoldBoardPage;
    exports.PageTabs = PageTabs;
    exports.PAGE_ID = PAGE_ID;
    return module.exports;
  },
});
