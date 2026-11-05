// React UI. Uses the shell's shared `react` module; no JSX so the bundle needs no compiler.
import React from 'react';
import { LAYOUT, buildGraph, formatDuration, formatTokens, loadTree, totals } from './model.js';

const h = React.createElement;
const { useState, useEffect, useMemo, useRef, useCallback } = React;

const KIND_LABEL = {
  session: 'Session',
  external: 'External agent',
  prompt: 'Prompt',
  trigger: 'Trigger',
  notice: 'Subagent result',
  step: 'Step',
  answer: 'Answer',
  error: 'Error',
  stopped: 'Stopped',
};

function clip(text, max = 6000) {
  if (text === undefined || text === null) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

function prettyJson(text) {
  if (typeof text !== 'string') return clip(JSON.stringify(text, null, 2));
  try {
    return clip(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    return clip(text);
  }
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' });
}

/* --------------------------------------------------------------- canvas -- */

/** Rounded orthogonal path through the given points. */
function roundedPath(points, r = 10) {
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const ax = x - (k * (x - px)) / (inLen || 1);
    const ay = y - (k * (y - py)) / (inLen || 1);
    const bx = x + (k * (nx - x)) / (outLen || 1);
    const by = y + (k * (ny - y)) / (outLen || 1);
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

/**
 * Edge geometry. Sequence edges are straight. Delegation and return edges are
 * routed orthogonally through the empty row and lane gaps, so they never cross
 * the cards of lanes in between.
 */
function edgePath(e, from, to) {
  const { nodeW, nodeH, laneGap, rowGap } = LAYOUT;
  if (e.kind === 'seq') {
    const x = from.x + nodeW / 2;
    return `M ${x} ${from.y + nodeH} L ${x} ${to.y}`;
  }
  const sy = from.y + nodeH / 2;
  const ty = to.y + nodeH / 2;
  if (from.lane === to.lane) {
    const x = from.x + nodeW;
    return roundedPath([[x, sy], [x + laneGap / 3, sy], [x + laneGap / 3, ty], [x, ty]]);
  }
  if (to.lane > from.lane) {
    // Rightward (delegation): exit right, run in the row gap below the source, drop in the target's left gap.
    const sx = from.x + nodeW;
    const gx = to.x - laneGap / 2;
    if (to.lane === from.lane + 1) return roundedPath([[sx, sy], [gx, sy], [gx, ty], [to.x, ty]]);
    const g1 = sx + laneGap / 2;
    const gy = from.y + nodeH + rowGap / 2;
    return roundedPath([[sx, sy], [g1, sy], [g1, gy], [gx, gy], [gx, ty], [to.x, ty]]);
  }
  // Leftward (result returned): exit left, drop in the source's left gap, run in the row gap above the target.
  const sx = from.x;
  const g1 = from.x - laneGap / 2;
  const tx = to.x + nodeW;
  if (to.lane === from.lane - 1) return roundedPath([[sx, sy], [g1, sy], [g1, ty], [tx, ty]]);
  const gx = tx + laneGap / 2;
  const gy = to.y - rowGap / 2;
  return roundedPath([[sx, sy], [g1, sy], [g1, gy], [gx, gy], [gx, ty], [tx, ty]]);
}

function NodeCard({ node, selected, highlighted, onSelect, folded, onToggleCollapse, collapsed }) {
  const f = node.kind === 'session' || node.kind === 'external' ? folded.get(node.sessionId) : undefined;
  let meta = '';
  if (node.kind === 'step' || node.kind === 'answer') {
    const dur = node.endTime !== undefined ? formatDuration(node.endTime - node.time) : '…';
    meta = `${dur}${node.usage?.output ? ` · ${formatTokens(node.usage.output)} out` : ''}`;
  } else if (f) {
    const s = f.stats;
    const dur = s.firstTime !== undefined && s.lastTime !== undefined ? formatDuration(s.lastTime - s.firstTime) : '';
    meta = [s.running ? 'running' : null, `${s.steps} steps`, `${s.tools} tools`, dur].filter(Boolean).join(' · ');
  } else {
    meta = fmtTime(node.time);
  }
  const running = (node.kind === 'step' && node.endTime === undefined) || (f && f.stats.running);
  const errored = node.kind === 'error' || (node.calls && node.calls.some((c) => c.isError));
  const childCount = f ? f.session.projections?.subagentCatalog?.length ?? 0 : 0;
  return h(
    'div',
    {
      className: [
        'dl-node',
        `dl-k-${node.kind}`,
        node.hasSpawn ? 'dl-spawner' : '',
        selected ? 'dl-selected' : '',
        highlighted ? 'dl-highlight' : '',
        running ? 'dl-running' : '',
        errored ? 'dl-errored' : '',
      ].join(' '),
      style: { left: node.x, top: node.y, width: node.w, height: node.h },
      onClick: (ev) => {
        ev.stopPropagation();
        onSelect(node.id);
      },
      title: node.subtitle,
      role: 'button',
      tabIndex: 0,
      onKeyDown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onSelect(node.id);
        }
      },
    },
    h(
      'div',
      { className: 'dl-node-head' },
      h('span', { className: 'dl-dot' }),
      h('span', { className: 'dl-node-title' }, node.title),
      childCount > 0 && h(
        'button',
        {
          className: 'dl-collapse',
          title: collapsed ? 'Expand subagents' : 'Collapse subagents',
          onClick: (ev) => {
            ev.stopPropagation();
            onToggleCollapse(node.sessionId);
          },
        },
        collapsed ? `+${childCount}` : '−',
      ),
    ),
    h('div', { className: 'dl-node-sub' }, node.subtitle || '\u00a0'),
    h('div', { className: 'dl-node-meta' }, meta),
  );
}

function Canvas({ graph, folded, selectedId, highlightSession, onSelect, zoom, setZoom, collapsed, onToggleCollapse }) {
  const scroller = useRef(null);
  const drag = useRef(null);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // Ctrl/Cmd + wheel zoom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const onWheel = (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      setZoom((z) => Math.min(1.6, Math.max(0.25, z * (ev.deltaY < 0 ? 1.1 : 0.9))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // Scroll the selected node into view when selection changes from outside.
  useEffect(() => {
    const el = scroller.current;
    const n = selectedId ? byId.get(selectedId) : undefined;
    if (!el || !n) return;
    const x = n.x * zoom;
    const y = n.y * zoom;
    const w = n.w * zoom;
    const hh = n.h * zoom;
    if (x < el.scrollLeft || x + w > el.scrollLeft + el.clientWidth) el.scrollTo?.({ left: Math.max(0, x - 40), behavior: 'smooth' });
    if (y < el.scrollTop || y + hh > el.scrollTop + el.clientHeight) el.scrollTo?.({ top: Math.max(0, y - el.clientHeight / 3), behavior: 'smooth' });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (ev) => {
    if (ev.button !== 0 || ev.target.closest('.dl-node')) return;
    drag.current = { x: ev.clientX, y: ev.clientY, left: scroller.current.scrollLeft, top: scroller.current.scrollTop, moved: false };
    scroller.current.setPointerCapture?.(ev.pointerId);
  };
  const onPointerMove = (ev) => {
    const d = drag.current;
    if (!d) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    scroller.current.scrollLeft = d.left - dx;
    scroller.current.scrollTop = d.top - dy;
  };
  const onPointerUp = (ev) => {
    const d = drag.current;
    drag.current = null;
    scroller.current?.releasePointerCapture?.(ev.pointerId);
    if (d && !d.moved && !ev.target.closest('.dl-node')) onSelect(null);
  };

  const lanes = graph.lanes.map((id, i) => {
    const x = LAYOUT.pad + i * (LAYOUT.nodeW + LAYOUT.laneGap) - LAYOUT.laneGap / 2 + 6;
    return h('div', {
      key: id,
      className: `dl-lane ${highlightSession === id ? 'dl-lane-current' : ''}`,
      style: { left: x, width: LAYOUT.nodeW + LAYOUT.laneGap - 12, height: graph.height },
    });
  });

  return h(
    'div',
    {
      className: 'dl-canvas',
      ref: scroller,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    h(
      'div',
      { className: 'dl-stage-size', style: { width: graph.width * zoom, height: graph.height * zoom } },
      h(
        'div',
        { className: 'dl-stage', style: { width: graph.width, height: graph.height, transform: `scale(${zoom})` } },
        lanes,
        h(
          'svg',
          { className: 'dl-edges', width: graph.width, height: graph.height },
          h(
            'defs',
            null,
            ['seq', 'spawn', 'return'].map((k) =>
              h('marker', { key: k, id: `dl-arrow-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', className: `dl-arrow dl-arrow-${k}` })),
            ),
          ),
          graph.edges.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const active = selectedId && (e.from === selectedId || e.to === selectedId);
            return h('path', {
              key: e.id,
              d: edgePath(e, from, to),
              className: `dl-edge dl-edge-${e.kind} ${e.dashed ? 'dl-edge-dashed' : ''} ${active ? 'dl-edge-active' : ''}`,
              markerEnd: `url(#dl-arrow-${e.kind})`,
            });
          }),
        ),
        graph.nodes.map((n) =>
          h(NodeCard, {
            key: n.id,
            node: n,
            folded,
            selected: n.id === selectedId,
            highlighted: highlightSession && n.sessionId === highlightSession && n.kind === 'session',
            onSelect,
            collapsed: collapsed.has(n.sessionId),
            onToggleCollapse,
          }),
        ),
      ),
    ),
  );
}

/* --------------------------------------------------------------- detail -- */

function Section({ title, children, open = true }) {
  return h('details', { className: 'dl-section', open }, h('summary', null, title), h('div', { className: 'dl-section-body' }, children));
}

function Pre({ children }) {
  return h('pre', { className: 'dl-pre' }, children);
}

function KV({ rows }) {
  return h(
    'dl',
    { className: 'dl-kv' },
    rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').flatMap(([k, v]) => [h('dt', { key: `k${k}` }, k), h('dd', { key: `v${k}` }, v)]),
  );
}

function UsageRows(u) {
  if (!u || !u.total) return [];
  return [
    ['Tokens', `${formatTokens(u.total)} total`],
    ['Input / Output', `${formatTokens(u.input)} / ${formatTokens(u.output)}`],
    ['Cache read / write', `${formatTokens(u.cacheRead)} / ${formatTokens(u.cacheWrite)}`],
  ];
}

function Detail({ node, folded, onSelect, onOpen, onClose }) {
  if (!node) {
    return h(
      'div',
      { className: 'dl-detail dl-detail-empty' },
      h('div', { className: 'dl-hint-title' }, 'Select a node'),
      h('p', null, 'Each column is an agent: the main conversation on the left, and every subagent it delegated to on the right.'),
      h('ul', { className: 'dl-legend' },
        h('li', null, h('i', { className: 'dl-sw dl-sw-prompt' }), 'Prompt / task given to the agent'),
        h('li', null, h('i', { className: 'dl-sw dl-sw-step' }), 'Model step with its tool calls'),
        h('li', null, h('i', { className: 'dl-sw dl-sw-answer' }), 'Final answer of a turn'),
        h('li', null, h('i', { className: 'dl-sw dl-sw-notice' }), 'Result delivered back by a subagent'),
        h('li', null, h('i', { className: 'dl-sw dl-sw-error' }), 'Error / stopped turn'),
        h('li', null, h('i', { className: 'dl-ln dl-ln-spawn' }), 'Delegation (spawn)'),
        h('li', null, h('i', { className: 'dl-ln dl-ln-return' }), 'Result returned to parent'),
      ),
      h('p', { className: 'dl-muted' }, 'Drag to pan · Ctrl/⌘ + wheel to zoom'),
    );
  }
  const f = folded.get(node.sessionId);
  const sessionLabel = f?.header.title ?? node.sessionId;
  const goSession = (id) => onSelect(`${id}:session`);
  let body;
  switch (node.kind) {
    case 'session':
    case 'external': {
      const s = f.stats;
      const ses = f.session;
      const children = ses.projections?.subagentCatalog ?? [];
      body = h(
        React.Fragment,
        null,
        h(KV, {
          rows: [
            ['Session', h('code', null, ses.id)],
            ['Mode', ses.depth === 0 ? 'root conversation' : ses.mode],
            ['Parent', ses.parentId ? h('a', { onClick: () => goSession(ses.parentId) }, folded.get(ses.parentId)?.header.title ?? ses.parentId) : undefined],
            ['Model', s.model],
            ['Status', s.running ? 'running' : s.lastReason?.kind ?? 'idle'],
            ['Created', fmtTime(ses.createdAt ?? s.firstTime)],
            ['Active span', s.firstTime !== undefined ? formatDuration(s.lastTime - s.firstTime) : undefined],
            ['Steps / tool calls', `${s.steps} / ${s.tools}`],
            ...UsageRows(s.usage),
            ['Error', ses.error],
          ],
        }),
        children.length > 0 && h(Section, { title: `Subagents (${children.length})` },
          h('ul', { className: 'dl-links' }, children.map((c) => h('li', { key: c.id }, h('a', { onClick: () => goSession(c.id) }, c.label || c.id), h('span', { className: 'dl-muted' }, ` ${c.mode}`))))),
        node.kind === 'session' && h('div', { className: 'dl-actions' }, h('button', { className: 'dl-btn dl-btn-primary', onClick: () => onOpen(ses) }, 'Open conversation')),
      );
      break;
    }
    case 'prompt':
    case 'trigger':
    case 'notice': {
      const sender = node.sender ? folded.get(node.sender) : undefined;
      body = h(
        React.Fragment,
        null,
        h(KV, {
          rows: [
            ['Agent', sessionLabel],
            ['Turn', node.turn || undefined],
            ['Time', fmtTime(node.time)],
            ['Source', node.source?.kind],
            ['From', node.sender ? h('a', { onClick: () => goSession(node.sender) }, sender?.header.title ?? node.sender) : undefined],
          ],
        }),
        h(Section, { title: 'Message' }, h(Pre, null, clip(node.text))),
      );
      break;
    }
    case 'step':
    case 'answer': {
      body = h(
        React.Fragment,
        null,
        h(KV, {
          rows: [
            ['Agent', sessionLabel],
            ['Turn / step', `${node.turn} / ${node.step}`],
            ['Started', fmtTime(node.time)],
            ['Duration', node.endTime !== undefined ? formatDuration(node.endTime - node.time) : 'running…'],
            ['Model', node.model],
            ...UsageRows(node.usage),
          ],
        }),
        node.reasoning && h(Section, { title: 'Reasoning', open: false }, h(Pre, null, clip(node.reasoning))),
        node.text && h(Section, { title: node.kind === 'answer' ? 'Answer' : 'Assistant text' }, h(Pre, null, clip(node.text))),
        node.calls.length > 0 && h(Section, { title: `Tool calls (${node.calls.length})` },
          node.calls.map((c) => h(
            'div',
            { key: c.callId, className: `dl-call ${c.isError ? 'dl-call-error' : ''}` },
            h('div', { className: 'dl-call-head' },
              h('b', null, c.name),
              h('span', { className: 'dl-muted' }, c.resultTime !== undefined ? ` ${formatDuration(c.resultTime - c.time)}` : ' running…'),
              c.isError && h('span', { className: 'dl-badge dl-badge-error' }, 'error'),
              c.approval && h('span', { className: 'dl-badge' }, 'approval'),
            ),
            c.children.length > 0 && h('div', { className: 'dl-call-children' }, '→ ',
              c.children.map((id, i) => h(React.Fragment, { key: id }, i > 0 ? ', ' : '', h('a', { onClick: () => goSession(id) }, folded.get(id)?.header.title ?? id)))),
            h('details', null, h('summary', null, 'Arguments'), h(Pre, null, prettyJson(c.args))),
            c.result !== undefined && h('details', null, h('summary', null, 'Result'), h(Pre, null, clip(c.result, 4000))),
          ))),
      );
      break;
    }
    default:
      body = h(
        React.Fragment,
        null,
        h(KV, { rows: [['Agent', sessionLabel], ['Turn', node.turn], ['Time', fmtTime(node.time)]] }),
        h(Pre, null, clip(node.reason?.error?.message ?? JSON.stringify(node.reason ?? {}, null, 2))),
      );
  }
  return h(
    'div',
    { className: 'dl-detail' },
    h('div', { className: 'dl-detail-head' },
      h('span', { className: `dl-pill dl-k-${node.kind}` }, KIND_LABEL[node.kind] ?? node.kind),
      h('span', { className: 'dl-detail-title' }, node.title),
      h('button', { className: 'dl-icon-btn', title: 'Close', onClick: onClose }, '×')),
    h('div', { className: 'dl-detail-body' }, body),
  );
}

/* ---------------------------------------------------------------- graph -- */

export function LineageGraph({ api, root, highlightSession }) {
  const [state, setState] = useState({ status: 'loading', folded: null, error: null, at: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [turn, setTurn] = useState('all');
  const [zoom, setZoom] = useState(1);
  const [auto, setAuto] = useState(true);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [tick, setTick] = useState(0);
  const rootKey = `${root.id}|${JSON.stringify(root.address)}`;

  useEffect(() => {
    setSelectedId(null);
    setTurn('all');
    setCollapsed(new Set());
    setState({ status: 'loading', folded: null, error: null, at: 0 });
  }, [rootKey]);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    loadTree(api.reader, root, ctrl.signal)
      .then((folded) => {
        if (alive) setState({ status: 'ready', folded, error: null, at: Date.now() });
      })
      .catch((error) => {
        if (alive && !ctrl.signal.aborted) setState((s) => ({ ...s, status: s.folded ? 'ready' : 'error', error: error?.message ?? String(error) }));
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [rootKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = useMemo(() => (state.folded ? totals(state.folded) : null), [state.folded]);

  // Live refresh while any agent in the tree is running.
  useEffect(() => {
    if (!auto || !sum?.running) return undefined;
    const id = setTimeout(() => setTick((t) => t + 1), 3000);
    return () => clearTimeout(id);
  }, [auto, sum, state.at]);

  const graph = useMemo(
    () => (state.folded ? buildGraph(state.folded, root.id, turn, collapsed) : null),
    [state.folded, root.id, turn, collapsed],
  );
  const selected = useMemo(() => graph?.nodes.find((n) => n.id === selectedId) ?? null, [graph, selectedId]);
  const rootFold = state.folded?.get(root.id);
  const turnOptions = (rootFold?.turns ?? []).filter((t) => t.prompt || rootFold.nodes.some((n) => n.turn === t.turn && n.kind !== 'session'));

  const toggleCollapse = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const fit = () => {
    if (!graph) return;
    const el = document.querySelector('.dl-root .dl-canvas');
    if (!el) return;
    const z = Math.min(1, (el.clientWidth - 20) / graph.width, Math.max(0.35, (el.clientHeight - 20) / graph.height));
    setZoom(Math.max(0.25, z));
  };

  if (state.status === 'loading' && !state.folded) {
    return h('div', { className: 'dl-root dl-center' }, h('div', { className: 'dl-spinner' }), h('span', { className: 'dl-muted' }, 'Reading conversation logs…'));
  }
  if (state.status === 'error' && !state.folded) {
    return h('div', { className: 'dl-root dl-center' },
      h('div', { className: 'dl-error-box' }, h('b', null, 'Could not load lineage'), h('div', null, state.error)),
      h('button', { className: 'dl-btn', onClick: () => setTick((t) => t + 1) }, 'Retry'));
  }

  const span = sum.first !== undefined && sum.last !== undefined ? formatDuration(sum.last - sum.first) : '—';
  return h(
    'div',
    { className: 'dl-root' },
    h(
      'div',
      { className: 'dl-toolbar' },
      h('div', { className: 'dl-stats' },
        h('span', null, h('b', null, sum.sessions), sum.sessions === 1 ? ' agent' : ' agents'),
        h('span', null, h('b', null, sum.steps), ' steps'),
        h('span', null, h('b', null, sum.tools), ' tool calls'),
        h('span', null, h('b', null, formatTokens(sum.usage.total)), ' tokens'),
        h('span', null, h('b', null, span), ' span'),
        sum.running && h('span', { className: 'dl-live' }, '● live'),
      ),
      h('div', { className: 'dl-controls' },
        h('select', {
          className: 'dl-select',
          value: String(turn),
          onChange: (ev) => setTurn(ev.target.value === 'all' ? 'all' : Number(ev.target.value)),
          title: 'Show the steps of one turn (one question → answer)',
        },
        h('option', { value: 'all' }, 'All turns'),
        turnOptions.map((t) => h('option', { key: t.turn, value: String(t.turn) }, `Turn ${t.turn}: ${(t.prompt || '').trim().slice(0, 48) || '(automated)'}`))),
        h('div', { className: 'dl-zoom' },
          h('button', { className: 'dl-icon-btn', title: 'Zoom out', onClick: () => setZoom((z) => Math.max(0.25, z / 1.2)) }, '−'),
          h('button', { className: 'dl-zoom-val', title: 'Reset zoom', onClick: () => setZoom(1) }, `${Math.round(zoom * 100)}%`),
          h('button', { className: 'dl-icon-btn', title: 'Zoom in', onClick: () => setZoom((z) => Math.min(1.6, z * 1.2)) }, '+'),
          h('button', { className: 'dl-btn dl-btn-small', title: 'Fit to view', onClick: fit }, 'Fit')),
        h('label', { className: 'dl-check', title: 'Refresh automatically while agents are running' },
          h('input', { type: 'checkbox', checked: auto, onChange: (ev) => setAuto(ev.target.checked) }), 'Live'),
        h('button', { className: 'dl-btn dl-btn-small', onClick: () => setTick((t) => t + 1), title: 'Reload logs' }, 'Refresh'),
      ),
    ),
    state.error && h('div', { className: 'dl-warn' }, `Last refresh failed: ${state.error}`),
    h(
      'div',
      { className: 'dl-body' },
      graph.nodes.length <= 1
        ? h('div', { className: 'dl-center dl-grow' }, h('span', { className: 'dl-muted' }, 'This conversation has no recorded steps yet.'))
        : h(Canvas, { graph, folded: state.folded, selectedId, highlightSession, onSelect: setSelectedId, zoom, setZoom, collapsed, onToggleCollapse: toggleCollapse }),
      h(Detail, { node: selected, folded: state.folded, onSelect: setSelectedId, onOpen: api.openSession, onClose: () => setSelectedId(null) }),
    ),
  );
}

/* ------------------------------------------------------------- surfaces -- */

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('[dsh-lineage]', error);
  }
  render() {
    if (this.state.error) {
      return h('div', { className: 'dl-root dl-center' },
        h('div', { className: 'dl-error-box' }, h('b', null, 'Lineage view crashed'), h('div', null, String(this.state.error?.message ?? this.state.error))),
        h('button', { className: 'dl-btn', onClick: () => this.setState({ error: null }) }, 'Retry'));
    }
    return this.props.children;
  }
}

function SafeGraph(props) {
  return h(Boundary, null, h(LineageGraph, props));
}

/** Conversation View tab: lineage of the open chat, resolved to its root agent. */
export function LineageTab(props) {
  const { api, sessionId } = props;
  const [root, setRoot] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setRoot(null);
    setError(null);
    api.resolveRoot(sessionId).then((r) => alive && setRoot(r), (e) => alive && setError(e?.message ?? String(e)));
    return () => {
      alive = false;
    };
  }, [api, sessionId]);
  if (error) return h('div', { className: 'dl-root dl-center' }, h('div', { className: 'dl-error-box' }, error));
  if (!root) return h('div', { className: 'dl-root dl-center' }, h('div', { className: 'dl-spinner' }));
  return h('div', { className: 'dl-tab' }, h(SafeGraph, { api, root, highlightSession: sessionId !== root.id ? sessionId : undefined }));
}

/** Sidebar main page: pick any conversation and inspect its lineage. */
export function LineagePage(props) {
  const { api } = props;
  const [list, setList] = useState({ status: 'loading', items: [], error: null });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    api.listSessions(ctrl.signal).then(
      (items) => setList({ status: 'ready', items, error: null }),
      (e) => !ctrl.signal.aborted && setList((s) => ({ ...s, status: 'error', error: e?.message ?? String(e) })),
    );
    return () => ctrl.abort();
  }, [api, tick]);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.items.filter((it) => !q || (it.title ?? '').toLowerCase().includes(q) || it.sessionId.includes(q));
  }, [list.items, query]);
  useEffect(() => {
    if (!selected && items.length > 0) setSelected(items[0].sessionId);
  }, [items, selected]);
  const current = list.items.find((i) => i.sessionId === selected);
  return h(
    'div',
    { className: 'dl-page' },
    h(
      'aside',
      { className: 'dl-page-list' },
      h('div', { className: 'dl-page-head' },
        h('div', { className: 'dl-page-title' }, 'Lineage'),
        h('button', { className: 'dl-btn dl-btn-small', onClick: () => setTick((t) => t + 1) }, 'Refresh')),
      h('input', { className: 'dl-search', placeholder: 'Search conversations', value: query, onChange: (ev) => setQuery(ev.target.value) }),
      list.status === 'loading' && h('div', { className: 'dl-muted dl-pad' }, 'Loading…'),
      list.status === 'error' && h('div', { className: 'dl-error-box' }, list.error),
      h('ul', { className: 'dl-session-list' },
        items.map((it) => h(
          'li',
          {
            key: it.sessionId,
            className: it.sessionId === selected ? 'dl-active' : '',
            onClick: () => setSelected(it.sessionId),
          },
          h('div', { className: 'dl-s-title' }, it.running && h('span', { className: 'dl-live-dot' }), it.title || it.sessionId),
          h('div', { className: 'dl-s-meta' }, fmtTime(it.updatedAt), it.subagents ? ` · ${it.subagents} subagent${it.subagents === 1 ? '' : 's'}` : ''),
        ))),
    ),
    h(
      'section',
      { className: 'dl-page-main' },
      current
        ? h(SafeGraph, { key: current.sessionId, api, root: { id: current.sessionId, title: current.title, address: { kind: 'session', sessionId: current.sessionId } } })
        : h('div', { className: 'dl-center dl-grow' }, h('span', { className: 'dl-muted' }, list.status === 'ready' ? 'No conversations yet.' : '')),
    ),
  );
}

export function LineageIcon({ size = 20 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 3, y: 3, width: 6, height: 5, rx: 1.5 }),
    h('rect', { x: 15, y: 9.5, width: 6, height: 5, rx: 1.5 }),
    h('rect', { x: 15, y: 16, width: 6, height: 5, rx: 1.5 }),
    h('path', { d: 'M6 8v10.5h9M6 12h9' }),
  );
}
