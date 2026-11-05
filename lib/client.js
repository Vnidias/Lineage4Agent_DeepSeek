window.__ModuleLoader__.load({
	id: "dsh-lineage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/model.js
// Pure data layer: session tree loading, event folding, graph building and layout.
// No DOM / React here so it can be tested in Node against real session logs.

/** user/message source kinds that are injected context, not real triggers. */
const CONTEXT_KINDS = new Set([
  'time-context',
  'runtime-context',
  'skill-catalog',
  'system-reminder',
  'context',
  'instructions',
  'harness-dev-context',
  'tmux-context',
  'repeat-tool-reminder',
]);

const TRIGGER_LABELS = {
  'agent-message': 'Message from subagent',
  'team-message': 'Team message',
  schedule: 'Scheduled run',
  webhook: 'Webhook',
  'tool-jobs': 'Background job finished',
  goal: 'Goal round',
  'cordis-host-runner': 'Plugin trigger',
};

const SUBAGENT_TOOLS = /subagent|workflow|agent_team|spawn|fork|delegate/i;

const LAYOUT = {
  nodeW: 248,
  nodeH: 66,
  laneGap: 72,
  rowGap: 26,
  pad: 28,
};

/** Join the text parts of a message content array. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === 'string') out.push(part);
    else if (part.type === 'text' && typeof part.text === 'string') out.push(part.text);
    else if (part.type === 'image') out.push('[image]');
  }
  return out.join('\n');
}

function firstLine(text, max = 90) {
  if (!text) return '';
  const line = String(text).trim().split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function addUsage(into, usage) {
  if (!usage) return;
  into.input += usage.inputTokens ?? 0;
  into.output += usage.outputTokens ?? 0;
  into.cacheRead += usage.cacheReadTokens ?? 0;
  into.cacheWrite += usage.cacheWriteTokens ?? 0;
  into.total += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * Keep only the session's own events: drop fork-seeded history that precedes
 * the last `session/end-seed` marker.
 */
function ownEvents(events) {
  let cut = -1;
  for (let i = 0; i < events.length; i++) if (events[i].type === 'session/end-seed') cut = i;
  return cut < 0 ? events : events.slice(cut + 1);
}

/**
 * Fold one session's events into lane nodes.
 * @param session - { id, label, mode, createdAt, events, projections, depth, parentId }
 */
function foldSession(session) {
  const sid = session.id;
  const events = session.events ?? [];
  const nodes = [];
  const steps = new Map();
  const calls = new Map();
  const turns = new Map();
  const usage = emptyUsage();
  let model;
  let toolCount = 0;
  let firstTime;
  let lastTime;

  const header = {
    id: `${sid}:session`,
    sessionId: sid,
    kind: session.mode === 'external' ? 'external' : 'session',
    time: session.createdAt ?? events[0]?.time ?? 0,
    title: session.label || (session.depth === 0 ? session.title || 'Conversation' : sid),
    subtitle: '',
    session,
  };
  nodes.push(header);

  const stepNode = (turn, step, time) => {
    const key = `${turn}:${step}`;
    let node = steps.get(key);
    if (!node) {
      node = {
        id: `${sid}:step:${key}`,
        sessionId: sid,
        kind: 'step',
        turn,
        step,
        time,
        endTime: undefined,
        text: '',
        reasoning: '',
        calls: [],
        usage: emptyUsage(),
        model: undefined,
        title: '',
        subtitle: '',
      };
      steps.set(key, node);
      nodes.push(node);
    }
    return node;
  };

  let currentTurn = 0;
  for (const ev of events) {
    const d = ev.data ?? {};
    if (typeof ev.time === 'number') {
      firstTime ??= ev.time;
      lastTime = ev.time;
    }
    switch (ev.type) {
      case 'turn/start': {
        currentTurn = d.turn ?? currentTurn + 1;
        turns.set(currentTurn, { turn: currentTurn, start: ev.time, startSeq: ev.seq, end: undefined, reason: undefined, prompt: '', output: false });
        break;
      }
      case 'turn/end': {
        const t = turns.get(d.turn ?? currentTurn) ?? { turn: d.turn ?? currentTurn, start: ev.time };
        t.end = ev.time;
        t.reason = d.reason;
        turns.set(t.turn, t);
        const kind = d.reason?.kind;
        if (kind && kind !== 'completed' && kind !== 'complete' && kind !== 'end' && kind !== 'done' && kind !== 'stop' && kind !== 'idle') {
          nodes.push({
            id: `${sid}:end:${t.turn}:${ev.seq}`,
            sessionId: sid,
            kind: kind === 'error' ? 'error' : 'stopped',
            turn: t.turn,
            time: ev.time,
            seq: ev.seq,
            title: kind === 'error' ? 'Error' : `Turn ended: ${kind}`,
            subtitle: firstLine(d.reason?.error?.message ?? d.reason?.message ?? ''),
            reason: d.reason,
          });
        }
        break;
      }
      case 'user/message': {
        if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') break;
        const source = d.source ?? {};
        const kind = source.kind ?? 'user';
        if (CONTEXT_KINDS.has(kind)) break;
        if (source.form === 'snapshot') break;
        const text = contentText(d.content);
        const turn = currentTurn;
        const owner = turns.get(turn);
        // A message that opened the turn sorts before the turn's first step.
        const opening = owner !== undefined && !owner.output;
        const time = opening ? owner.start : ev.time;
        const seq = opening ? owner.startSeq + 0.5 : ev.seq;
        if (kind === 'subagent-settled') {
          nodes.push({
            id: `${sid}:notice:${ev.seq}`,
            sessionId: sid,
            kind: 'notice',
            turn,
            time,
            seq,
            sender: source.senderSessionId,
            title: 'Subagent result',
            subtitle: firstLine(source.summary ?? text),
            text,
            source,
          });
        } else {
          const t = turns.get(turn);
          if (t && !t.prompt && kind === 'user') t.prompt = text;
          // A subagent's first message is the task its parent delegated.
          const isTask = session.depth > 0 && !nodes.some((n) => n.kind === 'prompt' || n.kind === 'trigger');
          if (isTask) {
            nodes.push({ id: `${sid}:prompt:${ev.seq}`, sessionId: sid, kind: 'prompt', turn, time, seq, title: 'Task', subtitle: firstLine(text), text, source });
            break;
          }
          nodes.push({
            id: `${sid}:prompt:${ev.seq}`,
            sessionId: sid,
            kind: kind === 'user' ? 'prompt' : 'trigger',
            turn,
            time,
            seq,
            title: kind === 'user' ? (session.depth === 0 ? 'Prompt' : 'Message') : TRIGGER_LABELS[kind] ?? `Trigger: ${kind}`,
            subtitle: firstLine(text),
            text,
            source,
            sender: source.senderSessionId,
          });
        }
        break;
      }
      case 'step/start': {
        stepNode(d.turn ?? currentTurn, d.step ?? 1, ev.time).seq ??= ev.seq;
        break;
      }
      case 'assistant/message': {
        const node = stepNode(d.turn ?? currentTurn, d.step ?? 1, ev.time);
        node.seq ??= ev.seq;
        const owner = turns.get(d.turn ?? currentTurn);
        if (owner) owner.output = true;
        const content = d.message?.content ?? [];
        for (const part of content) {
          if (part?.type === 'text' && part.text) node.text += (node.text ? '\n' : '') + part.text;
          else if (part?.type === 'reasoning' && part.text) node.reasoning += (node.reasoning ? '\n' : '') + part.text;
        }
        const m = d.message?.source?.model;
        if (m) node.model = model = m;
        addUsage(node.usage, d.usage);
        addUsage(usage, d.usage);
        break;
      }
      case 'tool/call': {
        const node = stepNode(d.turn ?? currentTurn, d.step ?? 1, ev.time);
        const call = {
          callId: d.callId,
          name: d.name,
          args: d.arguments,
          time: ev.time,
          resultTime: undefined,
          result: undefined,
          isError: false,
          approval: undefined,
          stepId: node.id,
          children: [],
        };
        node.calls.push(call);
        calls.set(d.callId, call);
        toolCount++;
        break;
      }
      case 'tool/result': {
        const msg = d.message ?? {};
        const call = calls.get(msg.toolCallId ?? msg.source?.callId ?? d.callId);
        if (call) {
          call.result = contentText(msg.content);
          call.resultTime = ev.time;
          call.isError = msg.isError === true || d.isError === true;
        }
        break;
      }
      case 'approval/asked': {
        const call = calls.get(d.callId);
        if (call) call.approval = { asked: ev.time, reason: d.reason };
        break;
      }
      case 'approval/decided': {
        for (const call of calls.values()) {
          if (call.approval && call.approval.decided === undefined && (d.id === undefined || call.approval.id === undefined || call.approval.id === d.id)) {
            call.approval.decided = ev.time;
            call.approval.decision = d.decision ?? d.outcome ?? d.approved;
            break;
          }
        }
        break;
      }
      case 'step/end': {
        const node = steps.get(`${d.turn ?? currentTurn}:${d.step ?? 1}`);
        if (node) node.endTime = ev.time;
        break;
      }
      case 'subagent/descriptor': {
        if (!header.session.label && d.label) header.title = d.label;
        if (d.agentModel) header.descriptorModel = d.agentModel;
        break;
      }
      default:
        break;
    }
  }

  // Drop finished steps that produced nothing visible (e.g. failed provider calls).
  for (const [key, node] of steps) {
    if (node.calls.length === 0 && !node.text && !node.reasoning && node.endTime !== undefined) {
      steps.delete(key);
      nodes.splice(nodes.indexOf(node), 1);
    }
  }
  // Finalize step nodes.
  for (const node of steps.values()) {
    if (node.calls.length === 0 && node.text) {
      node.kind = 'answer';
      node.title = `Answer · T${node.turn}`;
      node.subtitle = firstLine(node.text);
    } else {
      node.title = `Step ${node.turn}.${node.step}`;
      if (node.calls.length > 0) {
        const counts = new Map();
        for (const c of node.calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        node.subtitle = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(' · ');
      } else {
        node.subtitle = firstLine(node.reasoning || node.text) || (node.endTime === undefined ? 'Thinking…' : '(no output)');
      }
    }
    node.hasSpawn = node.calls.some((c) => SUBAGENT_TOOLS.test(c.name ?? ''));
  }

  let running = false;
  for (const t of turns.values()) if (t.end === undefined) running = true;
  const lastTurn = [...turns.values()].at(-1);

  header.subtitle = [session.mode && session.depth > 0 ? session.mode : null, model ?? header.descriptorModel].filter(Boolean).join(' · ');
  nodes.sort((a, b) => (a === header ? -1 : b === header ? 1 : (a.time - b.time) || ((a.seq ?? 0) - (b.seq ?? 0))));

  return {
    id: sid,
    session,
    header,
    nodes,
    calls,
    turns: [...turns.values()],
    stats: {
      steps: steps.size,
      tools: toolCount,
      usage,
      model: model ?? header.descriptorModel,
      firstTime,
      lastTime,
      running,
      lastReason: lastTurn?.reason,
    },
  };
}

/** Find the parent node from which a child session was spawned. */
function findSpawnSource(parent, child) {
  const cid = child.id;
  // 1. A tool result that names the child id.
  for (const call of parent.calls.values()) {
    if (typeof call.result === 'string' && call.result.includes(cid)) return { call };
    if (typeof call.args === 'string' && call.args.includes(cid)) return { call };
  }
  const created = child.session.createdAt ?? child.stats.firstTime;
  if (created !== undefined) {
    // 2. A delegation call whose execution window contains the creation time.
    let best;
    for (const call of parent.calls.values()) {
      const end = call.resultTime ?? Infinity;
      if (call.time <= created + 50 && created <= end + 50) {
        if (!best || (SUBAGENT_TOOLS.test(call.name ?? '') && !SUBAGENT_TOOLS.test(best.name ?? ''))) best = call;
      }
    }
    if (best) return { call: best };
    // 3. The latest node before the creation time.
    let node;
    for (const n of parent.nodes) if (n.kind !== 'session' && n.time <= created) node = n;
    if (node) return { node };
  }
  return { node: parent.header };
}

/**
 * Build a graph (nodes with lane/row and edges) from folded sessions.
 * @param folded - Map id -> folded session, insertion order = DFS order (root first)
 * @param rootId - root session id
 * @param turnFilter - 'all' or a root turn number
 */
function buildGraph(folded, rootId, turnFilter = 'all', collapsed = new Set()) {
  const root = folded.get(rootId);
  if (!root) return { nodes: [], edges: [], lanes: [], width: 0, height: 0 };

  // Resolve spawn sources for every child.
  const spawn = new Map(); // childId -> { sourceNodeId, call }
  for (const f of folded.values()) {
    const pid = f.session.parentId;
    if (!pid) continue;
    const parent = folded.get(pid);
    if (!parent) continue;
    const src = findSpawnSource(parent, f);
    const sourceNodeId = src.call ? src.call.stepId : src.node.id;
    if (src.call) src.call.children.push(f.id);
    spawn.set(f.id, { sourceNodeId, call: src.call });
  }

  // Choose included sessions and nodes.
  const included = new Map(); // id -> nodes[]
  const nodeById = new Map();
  const visit = (f, nodes) => {
    if (included.has(f.id)) return;
    included.set(f.id, nodes);
    for (const n of nodes) nodeById.set(n.id, n);
    if (collapsed.has(f.id)) return;
    for (const child of folded.values()) {
      if (child.session.parentId !== f.id) continue;
      const s = spawn.get(child.id);
      // Include a child spawned from a visible node, or one whose result lands in a visible node.
      const feedsVisible = nodes.some((n) => n.sender === child.id);
      if (s && !nodeById.has(s.sourceNodeId) && !feedsVisible) continue;
      visit(child, child.nodes);
    }
  };
  const rootNodes = turnFilter === 'all'
    ? root.nodes
    : root.nodes.filter((n) => n.kind === 'session' || n.turn === turnFilter);
  visit(root, rootNodes);

  // Lanes in DFS order of the folded map.
  const lanes = [];
  const laneOf = new Map();
  for (const id of folded.keys()) {
    if (!included.has(id)) continue;
    laneOf.set(id, lanes.length);
    lanes.push(id);
  }

  // Edges.
  const edges = [];
  const incoming = new Map();
  const addEdge = (e) => {
    edges.push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  };
  for (const [id, nodes] of included) {
    for (let i = 1; i < nodes.length; i++) {
      addEdge({ id: `seq:${nodes[i].id}`, from: nodes[i - 1].id, to: nodes[i].id, kind: 'seq' });
    }
    const s = spawn.get(id);
    if (s && nodeById.has(s.sourceNodeId)) {
      addEdge({ id: `spawn:${id}`, from: s.sourceNodeId, to: `${id}:session`, kind: 'spawn', label: s.call?.name });
    }
  }
  // Return edges: child's last node -> parent's notice (or next parent node after child end).
  for (const [id, nodes] of included) {
    const f = folded.get(id);
    const pid = f.session.parentId;
    if (!pid || !included.has(pid) || collapsed.has(pid)) continue;
    const parentNodes = included.get(pid);
    const last = nodes.at(-1);
    if (!last || last.kind === 'session') continue;
    const notices = parentNodes.filter((n) => (n.kind === 'notice' || n.kind === 'trigger') && n.sender === id);
    if (notices.length > 0) {
      for (const notice of notices) {
        // Source: the child's latest node at or before the notice time.
        let src = nodes[0];
        for (const n of nodes) if (n.time <= notice.time) src = n;
        if (src.kind === 'session') src = last;
        addEdge({ id: `ret:${id}:${notice.id}`, from: src.id, to: notice.id, kind: 'return' });
      }
    } else if (!f.stats.running) {
      const s = spawn.get(id);
      const end = last.endTime ?? last.time;
      const target = parentNodes.find((n) => n.kind !== 'session' && n.time >= end && n.id !== s?.sourceNodeId);
      if (target) addEdge({ id: `ret:${id}:${target.id}`, from: last.id, to: target.id, kind: 'return', dashed: true });
    }
  }

  // Row assignment: process in time order respecting lane order and incoming edges.
  const all = [];
  for (const [id, nodes] of included) nodes.forEach((n, i) => all.push({ n, lane: laneOf.get(id), i }));
  all.sort((a, b) => (a.n.time - b.n.time) || (a.lane - b.lane) || (a.i - b.i));
  const row = new Map();
  const laneLast = new Map();
  const pending = new Set(all.map((x) => x.n.id));
  // Iterate until stable to respect edges whose source sorts later (clock skew).
  const order = [];
  const ready = (x) => {
    const prev = x.i > 0 ? included.get(lanes[x.lane])[x.i - 1].id : undefined;
    if (prev && pending.has(prev)) return false;
    for (const e of incoming.get(x.n.id) ?? []) if (e.kind !== 'seq' && pending.has(e.from) && e.from !== x.n.id) return false;
    return true;
  };
  let queue = all;
  let guard = 0;
  while (queue.length > 0 && guard++ < 10000) {
    const rest = [];
    let progressed = false;
    for (const x of queue) {
      if (ready(x)) {
        order.push(x);
        pending.delete(x.n.id);
        progressed = true;
      } else rest.push(x);
    }
    if (!progressed) {
      // Break a cycle: take the earliest remaining node.
      const x = rest.shift();
      order.push(x);
      pending.delete(x.n.id);
    }
    queue = rest;
  }
  for (const x of order) {
    let r = (laneLast.get(x.lane) ?? -1) + 1;
    for (const e of incoming.get(x.n.id) ?? []) {
      if (e.kind === 'seq') continue;
      const rs = row.get(e.from);
      if (rs !== undefined) r = Math.max(r, rs + 1);
    }
    row.set(x.n.id, r);
    laneLast.set(x.lane, r);
  }

  const { nodeW, nodeH, laneGap, rowGap, pad } = LAYOUT;
  const placed = [];
  let maxRow = 0;
  for (const [id, nodes] of included) {
    const lane = laneOf.get(id);
    for (const n of nodes) {
      const r = row.get(n.id) ?? 0;
      maxRow = Math.max(maxRow, r);
      placed.push({ ...n, lane, row: r, x: pad + lane * (nodeW + laneGap), y: pad + r * (nodeH + rowGap), w: nodeW, h: nodeH });
    }
  }
  return {
    nodes: placed,
    edges,
    lanes,
    width: pad * 2 + lanes.length * nodeW + Math.max(0, lanes.length - 1) * laneGap,
    height: pad * 2 + (maxRow + 1) * nodeH + maxRow * rowGap,
  };
}

/** Totals across all folded sessions. */
function totals(folded) {
  const usage = emptyUsage();
  let steps = 0;
  let tools = 0;
  let first;
  let last;
  let running = false;
  for (const f of folded.values()) {
    steps += f.stats.steps;
    tools += f.stats.tools;
    usage.input += f.stats.usage.input;
    usage.output += f.stats.usage.output;
    usage.cacheRead += f.stats.usage.cacheRead;
    usage.cacheWrite += f.stats.usage.cacheWrite;
    usage.total += f.stats.usage.total;
    if (f.stats.firstTime !== undefined) first = first === undefined ? f.stats.firstTime : Math.min(first, f.stats.firstTime);
    if (f.stats.lastTime !== undefined) last = last === undefined ? f.stats.lastTime : Math.max(last, f.stats.lastTime);
    running ||= f.stats.running;
  }
  return { sessions: folded.size, steps, tools, usage, first, last, running };
}

/**
 * Load the session tree through a reader.
 * @param reader - { events(address, signal), projections(sessionId, signal) }
 * @param root - { id, address, title }
 */
async function loadTree(reader, root, signal, maxDepth = 8) {
  const folded = new Map();
  const visit = async (meta, address, depth) => {
    const session = { ...meta, depth, events: [], projections: {} };
    // Reserve DFS position now so lanes keep catalog order.
    folded.set(meta.id, null);
    if (meta.mode !== 'external') {
      try {
        const [projections, events] = await Promise.all([
          reader.projections(meta.id, signal).catch(() => ({})),
          reader.events(address, signal),
        ]);
        session.projections = projections ?? {};
        session.events = ownEvents(events);
        if (!session.title && typeof session.projections.title === 'string') session.title = session.projections.title;
      } catch (error) {
        if (signal?.aborted) throw error;
        session.error = error?.message ?? String(error);
      }
    }
    const f = foldSession(session);
    folded.set(meta.id, f);
    if (depth >= maxDepth) return;
    const catalog = Array.isArray(session.projections.subagentCatalog) ? session.projections.subagentCatalog : [];
    // Pre-reserve children in catalog order, then load them concurrently.
    const kids = catalog.filter((e) => e && e.id && !folded.has(e.id));
    await Promise.all(kids.map((entry) => {
      const mode = entry.mode;
      const addr = {
        kind: 'subagent',
        parentSessionId: meta.id,
        childSessionId: entry.id,
        mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown',
      };
      return visitOrdered(entry, addr, depth + 1, meta.id);
    }));
  };
  // Keep DFS order deterministic: reserve children slots under their parent before loading.
  const visitOrdered = (entry, addr, depth, parentId) =>
    visit({ id: entry.id, label: entry.label, mode: entry.mode, createdAt: entry.createdAt, parentId }, addr, depth);

  await visit({ id: root.id, title: root.title, parentId: undefined }, root.address, 0);
  // Reorder into DFS order (children directly after their parent subtree).
  const ordered = new Map();
  const place = (id) => {
    const f = folded.get(id);
    if (!f || ordered.has(id)) return;
    ordered.set(id, f);
    const catalog = Array.isArray(f.session.projections.subagentCatalog) ? f.session.projections.subagentCatalog : [];
    for (const e of catalog) place(e.id);
  };
  place(root.id);
  for (const [id, f] of folded) if (f && !ordered.has(id)) ordered.set(id, f);
  return ordered;
}

function formatDuration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const hh = Math.floor(m / 60);
  return `${hh}h ${m % 60}m`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

//#endregion

//#region src/styles.js
// Styles use the shell's design tokens with fallbacks so both themes work.
const STYLES = `
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

//#endregion

//#region src/ui.js
// React UI. Uses the shell's shared `react` module; no JSX so the bundle needs no compiler.
const React = require('react');
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

function LineageGraph({ api, root, highlightSession }) {
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
function LineageTab(props) {
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
function LineagePage(props) {
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

function LineageIcon({ size = 20 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 3, y: 3, width: 6, height: 5, rx: 1.5 }),
    h('rect', { x: 15, y: 9.5, width: 6, height: 5, rx: 1.5 }),
    h('rect', { x: 15, y: 16, width: 6, height: 5, rx: 1.5 }),
    h('path', { d: 'M6 8v10.5h9M6 12h9' }),
  );
}

//#endregion

//#region src/plugin.js
// Client plugin entry: registers the Lineage conversation tab, the sidebar panel
// button (next to Automation tasks) and its main page.


const NS = 'lineage';
const en = { 'view.lineage': 'Lineage', panel: 'Lineage' };
const dictionaries = {
  zh: { 'view.lineage': '谱系', panel: '谱系' },
  en,
  ja: en,
  de: en,
  es: { 'view.lineage': 'Linaje', panel: 'Linaje' },
  fr: { 'view.lineage': 'Lignée', panel: 'Lignée' },
  pt: { 'view.lineage': 'Linhagem', panel: 'Linhagem' },
  ru: en,
};

const inject = ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace'];

function unwrap(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) {
      const e = result.error;
      throw e instanceof Error ? e : new Error(e?.message ?? e?.code ?? 'request failed');
    }
    return result.value;
  }
  return result;
}

function createApi(ctx) {
  const session = () => ctx.remote.session;
  const listAll = async (signal) => {
    const value = unwrap(await session().list({}, signal));
    return value?.items ?? [];
  };
  const api = {
    reader: {
      async events(address, signal) {
        const value = unwrap(await session().page({ address, maxMessages: 1000000 }, signal));
        return (value?.records ?? []).map((r) => r.event);
      },
      async projections(sessionId, signal) {
        const value = unwrap(await session().projections({ sessionId }, signal));
        return value?.values ?? {};
      },
    },
    async listSessions(signal) {
      const items = await listAll(signal);
      return items
        .filter((it) => !it.blank && it.origin !== 'subagent')
        .map((it) => ({
          sessionId: it.sessionId,
          title: typeof it.projections?.values?.title === 'string' ? it.projections.values.title : undefined,
          updatedAt: it.updatedAt,
          running: it.running,
          subagents: Array.isArray(it.projections?.values?.subagentCatalog) ? it.projections.values.subagentCatalog.length : 0,
        }))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    async resolveRoot(sessionId) {
      let items = [];
      try {
        items = await listAll();
      } catch {
        // Fall back to treating the session as a root.
      }
      const byId = new Map(items.map((it) => [it.sessionId, it]));
      let id = sessionId;
      for (let guard = 0; guard < 32; guard++) {
        const it = byId.get(id);
        if (!it || it.origin !== 'subagent' || !it.parentSessionId) break;
        id = it.parentSessionId;
      }
      const it = byId.get(id);
      return {
        id,
        title: typeof it?.projections?.values?.title === 'string' ? it.projections.values.title : undefined,
        address: { kind: 'session', sessionId: id },
      };
    },
    openSession(ses) {
      if (!ses.parentId) {
        ctx.uiWorkspace.openSession(ses.id);
        return;
      }
      const mode = ses.mode === 'one-shot' || ses.mode === 'continuable' ? ses.mode : 'unknown';
      ctx.uiWorkspace.openSession({ parentSessionId: ses.parentId, childSessionId: ses.id, mode });
    },
  };
  return api;
}

function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.dshPlugin = 'dsh-lineage';
    tag.textContent = STYLES;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, 'lineage: styles');
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'lineage: dictionaries');
  const t = ctx.locale.bind(NS);
  const api = createApi(ctx);

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'lineage',
    order: 45,
    locale: NS,
    label: () => t('view.lineage'),
    inject: (sessionId) => ({
      api,
      sessionId,
      cancel: () => {},
      loadOlder: async () => 'exhausted',
    }),
  }, LineageTab));

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'lineage',
    locale: NS,
    inject: () => ({ api }),
  }, LineagePage));

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'lineage',
    order: 11,
    locale: NS,
    label: () => t('panel'),
  }, LineageIcon));
}

//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
