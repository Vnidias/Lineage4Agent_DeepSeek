// Synthetic session tree used by the standalone demo (no personal data).
// Scenario: a user asks the main agent to compare three charting libraries;
// it delegates one subagent per library, and one of them runs a workflow agent.
(function () {
  let seq = 0;
  const T0 = Date.UTC(2026, 10, 5, 21, 0, 0);
  const ev = (type, t, data, extra = {}) => ({ type, seq: seq++, time: T0 + t, data, ...extra });
  const user = (t, text, source = { kind: 'user' }) =>
    ev('user/message', t, { content: [{ type: 'text', text }], source, role: 'user' }, { surfaceOp: 'append' });
  const asst = (t, turn, step, parts, out = 180) =>
    ev('assistant/message', t, {
      turn, step,
      message: { role: 'assistant', content: parts, source: { kind: 'model', model: 'deepseek-v4' } },
      usage: { inputTokens: 40, outputTokens: out, cacheReadTokens: 9000, cacheWriteTokens: 600, totalTokens: 9640 + out },
    });
  const call = (t, turn, step, id, name, args) => ev('tool/call', t, { turn, step, callId: id, name, arguments: JSON.stringify(args) });
  const result = (t, turn, step, id, text, isError) =>
    ev('tool/result', t, { turn, step, message: { role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] } });
  const step = (turn, n, t0, t1, body) => [ev('step/start', t0, { turn, step: n }), ...body, ev('step/end', t1, { turn, step: n })];
  const turn = (n, t0, t1, body, reason = { kind: 'completed' }) => [ev('turn/start', t0, { turn: n }), ...body, ev('turn/end', t1, { turn: n, reason })];

  const libs = ['Chart.js', 'ECharts', 'Vega-Lite'];
  const sessions = {};
  const catalogs = {};

  sessions.root = [
    ev('session/end-seed', 0, {}),
    ...turn(1, 1000, 52000, [
      user(1001, 'Compare Chart.js, ECharts and Vega-Lite for our dashboard: bundle size, accessibility and license. Recommend one.'),
      ...step(1, 1, 1010, 4200, [
        asst(4000, 1, 1, [{ type: 'reasoning', text: 'Three independent research tasks: delegate one subagent per library, then merge the findings.' }]),
        call(4010, 1, 1, 'r1', 'subagent', { description: 'Research Chart.js', prompt: 'Measure bundle size, accessibility support and license of Chart.js.' }),
        call(4020, 1, 1, 'r2', 'subagent', { description: 'Research ECharts', prompt: 'Measure bundle size, accessibility support and license of ECharts.' }),
        call(4030, 1, 1, 'r3', 'subagent', { description: 'Research Vega-Lite', prompt: 'Measure bundle size, accessibility support and license of Vega-Lite.' }),
        result(4100, 1, 1, 'r1', 'started subagent child-chartjs'),
        result(4150, 1, 1, 'r2', 'started subagent child-echarts'),
        result(4190, 1, 1, 'r3', 'started subagent child-vega'),
      ]),
      ...step(1, 2, 4210, 6000, [
        asst(5900, 1, 2, [{ type: 'text', text: 'Three subagents are researching in parallel; I will merge their results when they report back.' }], 60),
      ]),
      user(21000, 'Chart.js: 68 kB gzipped, canvas only (needs fallback tables), MIT.', { kind: 'subagent-settled', senderSessionId: 'child-chartjs', summary: 'Chart.js research finished' }),
      user(30000, 'ECharts: 320 kB full / 140 kB tree-shaken, aria decal support, Apache-2.0.', { kind: 'subagent-settled', senderSessionId: 'child-echarts', summary: 'ECharts research finished' }),
      user(44000, 'Vega-Lite: 230 kB with vega, SVG renderer with titles, BSD-3-Clause.', { kind: 'subagent-settled', senderSessionId: 'child-vega', summary: 'Vega-Lite research finished' }),
      ...step(1, 3, 44100, 47000, [
        asst(46000, 1, 3, [{ type: 'reasoning', text: 'Need the dashboard bundle budget before recommending.' }]),
        call(46010, 1, 3, 'r4', 'read', { file_path: 'docs/perf-budget.md' }),
        result(46300, 1, 3, 'r4', 'Charts budget: 150 kB gzipped. Accessibility: WCAG 2.2 AA required.'),
      ]),
      ...step(1, 4, 47010, 52000, [
        asst(51800, 1, 4, [{ type: 'text', text: 'Recommendation: ECharts (tree-shaken, 140 kB) fits the 150 kB budget and has built-in ARIA support; Apache-2.0 is compatible. Chart.js is smaller but canvas-only; Vega-Lite exceeds the budget.' }], 420),
      ]),
    ]),
  ];

  const research = (id, lib, t0, t1, extra = [], finalStep = 3) => [
    ...turn(1, t0, t1, [
      user(t0 + 1, `Measure bundle size, accessibility support and license of ${lib}.`, { kind: 'agent' }),
      ...step(1, 1, t0 + 5, t0 + 3000, [
        asst(t0 + 2000, 1, 1, [{ type: 'reasoning', text: `Fetch the ${lib} package metadata and docs.` }]),
        call(t0 + 2010, 1, 1, `${id}-w1`, 'web_fetch', { url: `https://registry.npmjs.org/${lib.toLowerCase()}` }),
        result(t0 + 2900, 1, 1, `${id}-w1`, `{"name":"${lib.toLowerCase()}","license":"…"}`),
      ]),
      ...extra,
      ...step(1, finalStep, t1 - 2000, t1 - 10, [
        asst(t1 - 100, 1, finalStep, [{ type: 'text', text: `${lib} findings ready.` }], 240),
      ]),
    ]),
  ];

  sessions['child-chartjs'] = research('c', 'Chart.js', 4105, 20500, [
    ...step(1, 2, 7200, 15000, [
      asst(9000, 1, 2, [{ type: 'tool-call' }]),
      call(9010, 1, 2, 'c-b1', 'bash', { command: 'npx bundle-size chart.js' }),
      result(14800, 1, 2, 'c-b1', 'chart.js: 68.2 kB gzipped'),
    ]),
  ]);
  sessions['child-echarts'] = research('e', 'ECharts', 4155, 29500, [
    ...step(1, 2, 7300, 24000, [
      asst(8000, 1, 2, [{ type: 'reasoning', text: 'Measure full and tree-shaken builds in parallel with a workflow.' }]),
      call(8010, 1, 2, 'e-wf', 'workflow', { meta: { name: 'bundle-variants' } }),
      result(23500, 1, 2, 'e-wf', '{"full":"320 kB","treeShaken":"140 kB"}'),
    ]),
  ]);
  sessions['child-vega'] = research('v', 'Vega-Lite', 4195, 43500, [
    ...step(1, 2, 7400, 18000, [
      asst(8000, 1, 2, [{ type: 'tool-call' }]),
      call(8010, 1, 2, 'v-b1', 'bash', { command: 'npx bundle-size vega-lite vega' }),
      result(17000, 1, 2, 'v-b1', 'npm ERR! network timeout', true),
    ]),
    ...step(1, 3, 18100, 40000, [
      asst(19000, 1, 3, [{ type: 'reasoning', text: 'Network timeout; retry once.' }]),
      call(19010, 1, 3, 'v-b2', 'bash', { command: 'npx bundle-size vega-lite vega' }),
      result(39000, 1, 3, 'v-b2', 'vega-lite + vega: 231 kB gzipped'),
    ]),
  ], 4);
  sessions['grand-treeshake'] = [
    ...turn(1, 8100, 23000, [
      user(8101, 'Build ECharts with only line and bar charts and report the gzipped size.', { kind: 'agent' }),
      ...step(1, 1, 8105, 22900, [
        asst(9000, 1, 1, [{ type: 'tool-call' }]),
        call(9010, 1, 1, 't-b1', 'bash', { command: 'npm run build:charts && gzip -c dist/charts.js | wc -c' }),
        result(22000, 1, 1, 't-b1', '143360'),
      ]),
    ]),
  ];

  catalogs.root = [
    { id: 'child-chartjs', mode: 'continuable', label: 'Research Chart.js', createdAt: T0 + 4090 },
    { id: 'child-echarts', mode: 'continuable', label: 'Research ECharts', createdAt: T0 + 4140 },
    { id: 'child-vega', mode: 'one-shot', label: 'Research Vega-Lite', createdAt: T0 + 4180 },
  ];
  catalogs['child-echarts'] = [{ id: 'grand-treeshake', mode: 'one-shot', label: 'Tree-shaken build', createdAt: T0 + 8100 }];

  const list = [
    { sessionId: 'root', updatedAt: T0 + 52000, running: false, blank: false, projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Compare charting libraries', subagentCatalog: catalogs.root } } },
    { sessionId: 'other', updatedAt: T0 - 3600000, running: false, blank: false, projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Fix flaky login test' } } },
    { sessionId: 'child-echarts', updatedAt: T0, running: false, blank: false, origin: 'subagent', parentSessionId: 'root' },
  ];
  sessions.other = [
    ...turn(1, -3600000, -3590000, [
      user(-3599999, 'The login test fails about 1 in 10 runs. Find out why.'),
      ...step(1, 1, -3599990, -3595000, [asst(-3596000, 1, 1, [{ type: 'tool-call' }]), call(-3595990, 1, 1, 'o1', 'grep', { pattern: 'waitFor' }), result(-3595100, 1, 1, 'o1', 'tests/login.spec.ts:42')]),
      ...step(1, 2, -3594990, -3590010, [asst(-3590100, 1, 2, [{ type: 'text', text: 'The test races the redirect; await the URL change before asserting.' }])]),
    ]),
  ];

  window.LINEAGE_FIXTURE = { sessions, catalogs, list, titles: { root: 'Compare charting libraries', other: 'Fix flaky login test' } };
})();
