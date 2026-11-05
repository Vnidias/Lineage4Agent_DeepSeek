// Styles use the shell's design tokens with fallbacks so both themes work.
export const STYLES = `
.dl-tab, .dl-root, .dl-page { --dl-fg: var(--dsw-alias-label-primary, #1f2328); --dl-fg2: var(--dsw-alias-label-secondary, #57606a);
  --dl-fg3: var(--dsw-alias-label-tertiary, #8c959f); --dl-bg: var(--dsw-alias-bg-base, #fff); --dl-bg1: var(--dsw-alias-bg-layer-1, #f6f8fa);
  --dl-bg2: var(--dsw-alias-bg-layer-2, #eef1f4); --dl-b1: var(--dsw-alias-border-l1, rgba(127,127,127,.18)); --dl-b2: var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  --dl-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); --dl-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dl-ok: var(--dsw-alias-state-success-primary, #1a9e5c); --dl-err: var(--dsw-alias-state-error-primary, #d1242f);
  --dl-warn: var(--dsw-alias-state-warn-primary, #bf8700); --dl-purple: #8b5cf6; --dl-font: var(--dsw-font-xxs-12, 12px/1.4 inherit);
  color: var(--dl-fg); font-size: 13px; }
.dl-tab { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.dl-root { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; height: 100%; }
.dl-center { display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center; }
.dl-grow { flex: 1; }
.dl-muted { color: var(--dl-fg3); }
.dl-pad { padding: 8px 12px; }
.dl-toolbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid var(--dl-b1); }
.dl-stats { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--dl-fg2); font-size: 12px; }
.dl-stats b { color: var(--dl-fg); font-weight: 600; }
.dl-live { color: var(--dl-ok); font-weight: 600; animation: dl-pulse 1.6s infinite; }
.dl-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dl-select, .dl-search { background: var(--dl-bg); color: var(--dl-fg); border: 1px solid var(--dl-b2); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 12px; max-width: 280px; }
.dl-search { margin: 0 12px 8px; max-width: none; }
.dl-btn { background: var(--dl-bg); color: var(--dl-fg); border: 1px solid var(--dl-b2); border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer; }
.dl-btn:hover, .dl-icon-btn:hover, .dl-zoom-val:hover { background: var(--dl-hover); }
.dl-btn-small { padding: 3px 9px; }
.dl-btn-primary { background: var(--dl-accent); border-color: var(--dl-accent); color: #fff; }
.dl-btn-primary:hover { filter: brightness(1.08); background: var(--dl-accent); }
.dl-icon-btn, .dl-zoom-val { background: transparent; border: 0; color: var(--dl-fg2); cursor: pointer; border-radius: 6px; padding: 2px 7px; font: inherit; font-size: 14px; line-height: 1.2; }
.dl-zoom-val { font-size: 12px; min-width: 44px; }
.dl-zoom { display: flex; align-items: center; gap: 2px; }
.dl-check { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dl-fg2); cursor: pointer; }
.dl-warn { padding: 4px 14px; font-size: 12px; color: var(--dl-warn); border-bottom: 1px solid var(--dl-b1); }
.dl-body { flex: 1; display: flex; min-height: 0; }
.dl-canvas { flex: 1; overflow: auto; position: relative; background-color: var(--dl-bg1);
  background-image: radial-gradient(var(--dl-b1) 1px, transparent 1px); background-size: 18px 18px; cursor: grab; user-select: none; }
.dl-canvas:active { cursor: grabbing; }
.dl-stage-size { position: relative; }
.dl-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.dl-lane { position: absolute; top: 0; border-radius: 14px; background: transparent; }
.dl-lane:nth-child(even) { background: rgba(127,127,127,.035); }
.dl-lane-current { background: color-mix(in srgb, var(--dl-accent) 8%, transparent) !important; }
.dl-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.dl-edge { fill: none; stroke-width: 1.5; }
.dl-edge-seq { stroke: var(--dl-b2); }
.dl-edge-spawn { stroke: var(--dl-accent); stroke-width: 2; }
.dl-edge-return { stroke: var(--dl-purple); stroke-width: 2; stroke-dasharray: 6 4; }
.dl-edge-dashed { stroke-dasharray: 3 4; opacity: .7; }
.dl-edge-active { stroke-width: 3; }
.dl-arrow-seq { fill: var(--dl-b2); } .dl-arrow-spawn { fill: var(--dl-accent); } .dl-arrow-return { fill: var(--dl-purple); }
.dl-node { position: absolute; box-sizing: border-box; background: var(--dl-bg); border: 1px solid var(--dl-b2); border-left: 4px solid var(--dl-fg3);
  border-radius: 10px; padding: 6px 10px 6px 9px; cursor: pointer; display: flex; flex-direction: column; justify-content: center; gap: 1px;
  box-shadow: 0 1px 2px rgba(0,0,0,.06); transition: box-shadow .12s, transform .12s; overflow: hidden; }
.dl-node:hover { box-shadow: 0 3px 10px rgba(0,0,0,.12); transform: translateY(-1px); }
.dl-node:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dl-accent)); outline-offset: 2px; }
.dl-node.dl-selected { box-shadow: 0 0 0 2px var(--dl-accent), 0 4px 14px rgba(0,0,0,.15); }
.dl-node.dl-highlight { box-shadow: 0 0 0 2px var(--dl-warn); }
.dl-node-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dl-node-title { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.dl-node-sub { font-size: 12px; color: var(--dl-fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-node-meta { font-size: 11px; color: var(--dl-fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dl-fg3); flex: none; }
.dl-collapse { border: 1px solid var(--dl-b2); background: var(--dl-bg1); color: var(--dl-fg2); border-radius: 6px; font-size: 11px; padding: 0 5px; cursor: pointer; line-height: 16px; }
.dl-k-session, .dl-k-external { border-left-color: var(--dl-fg); background: var(--dl-bg2); }
.dl-k-session .dl-node-title { font-size: 13px; }
.dl-k-external { border-style: dashed; }
.dl-k-prompt, .dl-k-trigger { border-left-color: var(--dl-accent); } .dl-k-prompt .dl-dot, .dl-k-trigger .dl-dot { background: var(--dl-accent); }
.dl-k-step .dl-dot { background: var(--dl-fg2); }
.dl-spawner { border-left-color: var(--dl-accent); }
.dl-k-answer { border-left-color: var(--dl-ok); } .dl-k-answer .dl-dot { background: var(--dl-ok); }
.dl-k-notice { border-left-color: var(--dl-purple); } .dl-k-notice .dl-dot { background: var(--dl-purple); }
.dl-k-error, .dl-k-stopped { border-left-color: var(--dl-err); } .dl-k-error .dl-dot, .dl-k-stopped .dl-dot { background: var(--dl-err); }
.dl-errored:not(.dl-k-error) .dl-node-meta::after { content: ' · tool error'; color: var(--dl-err); }
.dl-running .dl-dot { background: var(--dl-ok); animation: dl-pulse 1.2s infinite; }
@keyframes dl-pulse { 50% { opacity: .35; } }
.dl-detail { width: 380px; max-width: 45%; flex: none; border-left: 1px solid var(--dl-b1); background: var(--dl-bg); display: flex; flex-direction: column; min-height: 0; }
.dl-detail-empty { padding: 18px; gap: 8px; color: var(--dl-fg2); overflow: auto; }
.dl-hint-title { font-weight: 600; color: var(--dl-fg); font-size: 14px; }
.dl-legend { list-style: none; padding: 0; margin: 4px 0; display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
.dl-legend li { display: flex; align-items: center; gap: 8px; }
.dl-sw { width: 14px; height: 12px; border-radius: 3px; border: 1px solid var(--dl-b2); border-left-width: 4px; display: inline-block; }
.dl-sw-prompt { border-left-color: var(--dl-accent); } .dl-sw-step { border-left-color: var(--dl-fg3); } .dl-sw-answer { border-left-color: var(--dl-ok); }
.dl-sw-notice { border-left-color: var(--dl-purple); } .dl-sw-error { border-left-color: var(--dl-err); }
.dl-ln { width: 18px; height: 0; border-top: 2px solid; display: inline-block; }
.dl-ln-spawn { border-color: var(--dl-accent); } .dl-ln-return { border-color: var(--dl-purple); border-top-style: dashed; }
.dl-detail-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dl-b1); }
.dl-detail-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-detail-body { padding: 10px 14px 24px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.dl-pill { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--dl-b2); border-left-width: 3px; white-space: nowrap; }
.dl-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 12px; }
.dl-kv dt { color: var(--dl-fg3); } .dl-kv dd { margin: 0; overflow-wrap: anywhere; }
.dl-kv code { font-size: 11px; }
.dl-section > summary { cursor: pointer; font-weight: 600; font-size: 12px; color: var(--dl-fg2); padding: 2px 0; }
.dl-section-body { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.dl-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--dl-bg1);
  border: 1px solid var(--dl-b1); border-radius: 8px; padding: 8px 10px; max-height: 360px; overflow: auto; user-select: text; }
.dl-call { border: 1px solid var(--dl-b1); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.dl-call-error { border-color: color-mix(in srgb, var(--dl-err) 50%, transparent); }
.dl-call-head { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.dl-call details > summary { cursor: pointer; font-size: 11.5px; color: var(--dl-fg2); }
.dl-call-children { font-size: 12px; }
.dl-badge { font-size: 10.5px; border-radius: 999px; padding: 0 6px; background: var(--dl-bg2); color: var(--dl-fg2); }
.dl-badge-error { background: color-mix(in srgb, var(--dl-err) 15%, transparent); color: var(--dl-err); }
.dl-detail a, .dl-links a { color: var(--dl-accent); cursor: pointer; text-decoration: none; }
.dl-detail a:hover { text-decoration: underline; }
.dl-links { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.dl-actions { display: flex; gap: 8px; margin-top: 4px; }
.dl-error-box { color: var(--dl-err); border: 1px solid color-mix(in srgb, var(--dl-err) 40%, transparent); border-radius: 8px; padding: 8px 12px; margin: 8px 12px; font-size: 12px; max-width: 520px; overflow-wrap: anywhere; }
.dl-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--dl-b2); border-top-color: var(--dl-accent); animation: dl-spin .8s linear infinite; }
@keyframes dl-spin { to { transform: rotate(360deg); } }
.dl-page { display: flex; height: 100%; width: 100%; min-height: 0; background: var(--dl-bg); }
.dl-page-list { width: 280px; flex: none; border-right: 1px solid var(--dl-b1); display: flex; flex-direction: column; min-height: 0; }
.dl-page-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 10px; }
.dl-page-title { font-weight: 600; font-size: 16px; }
.dl-session-list { list-style: none; margin: 0; padding: 0 6px 12px; overflow: auto; flex: 1; }
.dl-session-list li { padding: 7px 10px; border-radius: 8px; cursor: pointer; }
.dl-session-list li:hover { background: var(--dl-hover); }
.dl-session-list li.dl-active { background: var(--dl-bg2); }
.dl-s-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
.dl-s-meta { font-size: 11px; color: var(--dl-fg3); }
.dl-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dl-ok); flex: none; animation: dl-pulse 1.2s infinite; }
.dl-page-main { flex: 1; display: flex; min-width: 0; min-height: 0; }
@media (max-width: 767px) {
  .dl-page-list { width: 200px; }
  .dl-detail { width: 260px; }
}
`;
