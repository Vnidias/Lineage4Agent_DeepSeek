// Render smoke test: loads lib/client.js like the shell does, with a fake ctx and
// a synthetic 4-agent tree, then renders the tab and the sidebar page in jsdom.
// Run from a directory whose node_modules has react, react-dom and jsdom:
//   NODE_PATH=../.dl-scratch/node_modules node scripts/test-render.cjs
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const assert = require('node:assert/strict');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

let factory;
window.__ModuleLoader__ = { load: (m) => { factory = m.factory; } };
eval(fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8'));
const mod = factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require ${id}`);
});

// ---- synthetic sessions -------------------------------------------------
let seq = 0;
const T0 = 1_800_000_000_000;
const ev = (type, t, data, extra = {}) => ({ type, seq: seq++, time: T0 + t, data, ...extra });
const user = (t, text, source = { kind: 'user' }) => ev('user/message', t, { content: [{ type: 'text', text }], source, role: 'user' }, { surfaceOp: 'append' });
const asst = (t, turn, step, parts, usage = { inputTokens: 10, outputTokens: 100, totalTokens: 1000 }) => ev('assistant/message', t, { turn, step, message: { role: 'assistant', content: parts, source: { kind: 'model', model: 'deepseek-v4' } }, usage });
const call = (t, turn, step, id, name, args) => ev('tool/call', t, { turn, step, callId: id, name, arguments: JSON.stringify(args) });
const result = (t, turn, step, id, text) => ev('tool/result', t, { turn, step, message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] } });

const sessions = {
  root: [
    ev('session/end-seed', 0, {}),
    ev('turn/start', 10, { turn: 1 }),
    ev('step/start', 11, { turn: 1, step: 1 }),
    user(12, 'Research X and Y, then summarize'),
    ev('user/message', 12, { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'time-context' } }, { surfaceOp: 'append' }),
    asst(500, 1, 1, [{ type: 'reasoning', text: 'delegate' }, { type: 'tool-call' }]),
    call(501, 1, 1, 'c1', 'subagent', { description: 'Research X', prompt: 'X' }),
    call(502, 1, 1, 'c2', 'subagent', { description: 'Research Y', prompt: 'Y' }),
    result(510, 1, 1, 'c1', 'started subagent child-a'),
    result(520, 1, 1, 'c2', 'started subagent child-b'),
    ev('step/end', 521, { turn: 1, step: 1 }),
    ev('step/start', 522, { turn: 1, step: 2 }),
    asst(600, 1, 2, [{ type: 'text', text: 'Waiting for subagents.' }]),
    ev('step/end', 601, { turn: 1, step: 2 }),
    ev('turn/end', 602, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 5000, { turn: 2 }),
    user(5001, 'X done', { kind: 'subagent-settled', senderSessionId: 'child-a', summary: 'Research X finished' }),
    ev('step/start', 5002, { turn: 2, step: 1 }),
    asst(5100, 2, 1, [{ type: 'text', text: 'Noted X.' }]),
    ev('step/end', 5101, { turn: 2, step: 1 }),
    ev('turn/end', 5102, { turn: 2, reason: { kind: 'completed' } }),
    ev('turn/start', 9000, { turn: 3 }),
    user(9001, 'Y done', { kind: 'subagent-settled', senderSessionId: 'child-b' }),
    ev('step/start', 9002, { turn: 3, step: 1 }),
    asst(9500, 3, 1, [{ type: 'text', text: 'Final summary: X and Y are great.' }]),
    ev('step/end', 9501, { turn: 3, step: 1 }),
    ev('turn/end', 9502, { turn: 3, reason: { kind: 'completed' } }),
  ],
  'child-a': [
    ev('turn/start', 512, { turn: 1 }),
    ev('step/start', 513, { turn: 1, step: 1 }),
    user(513, 'X', { kind: 'agent' }),
    asst(900, 1, 1, [{ type: 'tool-call' }]),
    call(901, 1, 1, 'a1', 'bash', { command: 'ls' }),
    result(1500, 1, 1, 'a1', 'file1\nfile2'),
    ev('step/end', 1501, { turn: 1, step: 1 }),
    ev('step/start', 1502, { turn: 1, step: 2 }),
    asst(4000, 1, 2, [{ type: 'text', text: 'X is a thing.' }]),
    ev('step/end', 4001, { turn: 1, step: 2 }),
    ev('turn/end', 4002, { turn: 1, reason: { kind: 'completed' } }),
  ],
  'child-b': [
    ev('turn/start', 522, { turn: 1 }),
    ev('step/start', 523, { turn: 1, step: 1 }),
    user(523, 'Y', { kind: 'agent' }),
    asst(800, 1, 1, [{ type: 'tool-call' }]),
    call(801, 1, 1, 'b1', 'workflow', { script: '...' }),
    result(7000, 1, 1, 'b1', '{"done":true}'),
    ev('step/end', 7001, { turn: 1, step: 1 }),
    ev('step/start', 7002, { turn: 1, step: 2 }),
    asst(8000, 1, 2, [{ type: 'text', text: 'Y is another thing.' }]),
    ev('step/end', 8001, { turn: 1, step: 2 }),
    ev('turn/end', 8002, { turn: 1, reason: { kind: 'completed' } }),
  ],
  'grand-c': [
    ev('turn/start', 1000, { turn: 1 }),
    ev('step/start', 1001, { turn: 1, step: 1 }),
    user(1001, 'sub-task of Y', { kind: 'agent' }),
    asst(3000, 1, 1, [{ type: 'text', text: 'sub result' }]),
    ev('step/end', 3001, { turn: 1, step: 1 }),
    ev('turn/end', 3002, { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }),
  ],
};
const catalogs = {
  root: [
    { id: 'child-a', mode: 'continuable', label: 'Research X', createdAt: T0 + 505 },
    { id: 'child-b', mode: 'one-shot', label: 'Research Y', createdAt: T0 + 515 },
  ],
  'child-b': [{ id: 'grand-c', mode: 'one-shot', label: 'workflow agent', createdAt: T0 + 999 }],
};

const calls = [];
const opened = [];
const ok = (value) => ({ ok: true, value });
const registrations = {};
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (_name, fn) => fn(),
    register: (def, Comp) => { registrations[`${def.name}:${def.id ?? def.key}`] = { def, Comp }; return () => {}; },
  },
  uiWorkspace: { openSession: (a) => opened.push(a) },
  remote: {
    session: {
      async page(req) {
        calls.push(['page', req.address]);
        const id = req.address.kind === 'session' ? req.address.sessionId : req.address.childSessionId;
        if (req.address.kind === 'subagent' && !catalogs[req.address.parentSessionId]?.some((c) => c.id === id)) return { ok: false, error: { code: 'subagent/unauthorized', message: 'bad parent' } };
        return ok({ cursor: 0, records: sessions[id].map((event) => ({ type: 'event', event })), hasMore: false });
      },
      async projections({ sessionId }) {
        return ok({ kind: 'sequenced', asOfSeq: 1, values: { subagentCatalog: catalogs[sessionId] ?? [], title: sessionId === 'root' ? 'Research task' : null } });
      },
      async list() {
        return ok({ items: [
          { sessionId: 'root', updatedAt: T0 + 9600, running: false, blank: false, projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Research task', subagentCatalog: catalogs.root } } },
          { sessionId: 'child-a', updatedAt: T0, running: false, blank: false, origin: 'subagent', parentSessionId: 'root' },
          { sessionId: 'empty', updatedAt: T0, running: false, blank: true },
        ] });
      },
    },
  },
};
mod.apply(ctx);
console.log('registered:', Object.keys(registrations));
console.log('style tag:', !!document.querySelector('style[data-dsh-plugin="dsh-lineage"]'));
check(Object.keys(registrations).length === 3, 'three slot registrations');
check(!!document.querySelector('style[data-dsh-plugin="dsh-lineage"]'), 'stylesheet injected');

const tick = () => new Promise((r) => setTimeout(r, 20));
async function settle() { for (let i = 0; i < 10; i++) await act(async () => { await tick(); }); }

(async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  // 1. Tab, opened from the child conversation -> resolves to root, highlights child.
  const tab = registrations['conversation.view:lineage'];
  const props = { ...tab.def.inject('child-a'), t: (k) => k };
  await act(async () => { root.render(React.createElement(tab.Comp, props)); });
  await settle();
  const nodes = [...container.querySelectorAll('.dl-node')];
  console.log('tab nodes:', nodes.length, 'lanes:', container.querySelectorAll('.dl-lane').length, 'edges:', container.querySelectorAll('.dl-edge').length);
  console.log('spawn edges:', container.querySelectorAll('.dl-edge-spawn').length, 'return edges:', container.querySelectorAll('.dl-edge-return').length);
  check(nodes.length === 20, 'tab renders 20 nodes');
  check(container.querySelectorAll('.dl-lane').length === 4, 'four agent lanes');
  check(container.querySelectorAll('.dl-edge-spawn').length === 3, 'three delegation edges');
  check(container.querySelectorAll('.dl-edge-return').length === 3, 'three return edges');
  console.log('stats:', container.querySelector('.dl-stats')?.textContent);
  for (const n of nodes) console.log('  ', n.style.left.padStart(5), n.style.top.padStart(6), '|', n.querySelector('.dl-node-title').textContent, '|', n.querySelector('.dl-node-sub').textContent, '|', n.querySelector('.dl-node-meta').textContent);
  console.log('highlight lane:', container.querySelectorAll('.dl-lane-current').length);
  check(container.querySelectorAll('.dl-lane-current').length === 1, 'child lane highlighted when opened from a subagent chat');
  // Click the step that spawned subagents.
  const spawner = nodes.find((n) => n.classList.contains('dl-spawner'));
  await act(async () => { spawner.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  console.log('detail:', container.querySelector('.dl-detail-title')?.textContent, '| calls:', container.querySelectorAll('.dl-call').length, '| child links:', container.querySelector('.dl-call-children')?.textContent);
  check(container.querySelectorAll('.dl-call').length === 2, 'detail lists both tool calls');
  // Navigate to a child through the link, then open its conversation.
  const link = container.querySelector('.dl-call-children a');
  await act(async () => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  console.log('after link:', container.querySelector('.dl-detail-title')?.textContent);
  check(container.querySelector('.dl-detail-title')?.textContent === 'Research X', 'child link selects the child session');
  const openBtn = [...container.querySelectorAll('.dl-btn-primary')].find((b) => b.textContent === 'Open conversation');
  await act(async () => { openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  console.log('opened:', JSON.stringify(opened));
  check(opened.length === 1 && opened[0].childSessionId === 'child-a', 'Open conversation uses the subagent address');
  // Turn filter: turn 3 only.
  const select = container.querySelector('.dl-select');
  await act(async () => { select.value = '3'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  console.log('turn 3 nodes:', container.querySelectorAll('.dl-node').length, [...container.querySelectorAll('.dl-node-title')].map((n) => n.textContent).join(', '));
  check(container.querySelectorAll('.dl-node').length === 11, 'turn filter keeps the turn and the subagents feeding it');
  // Collapse root subagents.
  await act(async () => { select.value = 'all'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const collapseBtn = container.querySelector('.dl-k-session .dl-collapse');
  await act(async () => { collapseBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  console.log('collapsed nodes:', container.querySelectorAll('.dl-node').length, 'button:', container.querySelector('.dl-k-session .dl-collapse').textContent);
  check(container.querySelectorAll('.dl-node').length === 8, 'collapsing hides the subtree');

  // 2. Sidebar page.
  const page = registrations['main:lineage'];
  await act(async () => { root.render(React.createElement(page.Comp, { ...page.def.inject(), t: (k) => k })); });
  await settle();
  console.log('page list:', [...container.querySelectorAll('.dl-session-list li')].map((li) => li.textContent).join(' || '));
  console.log('page nodes:', container.querySelectorAll('.dl-node').length);
  check(container.querySelectorAll('.dl-session-list li').length === 1, 'page lists only visible root conversations');
  check(container.querySelectorAll('.dl-node').length === 20, 'page renders the selected conversation');
  const icon = registrations['sidebar.panellist:lineage'];
  console.log('panel order:', icon.def.order, 'icon svg:', typeof icon.Comp({ size: 20 }));
  console.log('page reads:', calls.length);
  root.unmount();
  console.log(`PASS: ${checks} checks`);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
