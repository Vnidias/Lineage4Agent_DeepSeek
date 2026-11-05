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

export const LAYOUT = {
  nodeW: 248,
  nodeH: 66,
  laneGap: 72,
  rowGap: 26,
  pad: 28,
};

/** Join the text parts of a message content array. */
export function contentText(content) {
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

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * Keep only the session's own events: drop fork-seeded history that precedes
 * the last `session/end-seed` marker.
 */
export function ownEvents(events) {
  let cut = -1;
  for (let i = 0; i < events.length; i++) if (events[i].type === 'session/end-seed') cut = i;
  return cut < 0 ? events : events.slice(cut + 1);
}

/**
 * Fold one session's events into lane nodes.
 * @param session - { id, label, mode, createdAt, events, projections, depth, parentId }
 */
export function foldSession(session) {
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
export function buildGraph(folded, rootId, turnFilter = 'all', collapsed = new Set()) {
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
export function totals(folded) {
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
export async function loadTree(reader, root, signal, maxDepth = 8) {
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

export function formatDuration(ms) {
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

export function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
