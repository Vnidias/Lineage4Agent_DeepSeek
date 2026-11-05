// Offline check: fold real session logs from ~/.dsh/sessions and lay them out.
// Usage: node scripts/test-offline.mjs <rootSessionId> [childId...]
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadTree, buildGraph, totals } from '../src/model.js';

const base = join(homedir(), '.dsh', 'sessions');
const dirs = readdirSync(base).map((d) => join(base, d));
function read(id) {
  for (const d of dirs) {
    const f = join(d, id, 'session.v4.jsonl.zstd');
    if (existsSync(f)) {
      const text = execFileSync('zstd', ['-dc', f], { maxBuffer: 1 << 30 }).toString();
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
  }
  throw new Error(`no session ${id}`);
}
const [rootId, ...forcedChildren] = process.argv.slice(2);
const reader = {
  async events(address) {
    const id = address.kind === 'session' ? address.sessionId : address.childSessionId;
    return read(id).filter((e) => e.type !== 'session');
  },
  async projections(id) {
    const evs = read(id);
    const catalog = evs.filter((e) => e.type === 'subagent/catalog').map((e) => ({ id: e.data.childId, createdAt: e.data.childCreatedAt, mode: e.data.mode, label: e.data.label }));
    if (id === rootId) for (const c of forcedChildren) {
      const h = read(c)[0];
      catalog.push({ id: c, createdAt: h.createdAt, mode: 'continuable', label: 'forced child' });
    }
    const title = evs.filter((e) => e.type === 'session/title').at(-1)?.data.title ?? null;
    return { subagentCatalog: catalog, title };
  },
};
const folded = await loadTree(reader, { id: rootId, address: { kind: 'session', sessionId: rootId } });
for (const f of folded.values()) {
  console.log(`# ${f.id} depth=${f.session.depth} nodes=${f.nodes.length} steps=${f.stats.steps} tools=${f.stats.tools} running=${f.stats.running}`);
}
const g = buildGraph(folded, rootId);
console.log('lanes', g.lanes.length, 'size', g.width, 'x', g.height, 'edges', g.edges.length);
for (const n of g.nodes.sort((a, b) => a.row - b.row || a.lane - b.lane).slice(0, 60)) {
  console.log(String(n.row).padStart(3), 'L' + n.lane, n.kind.padEnd(8), n.title.padEnd(20), '|', n.subtitle.slice(0, 70));
}
console.log(g.edges.filter((e) => e.kind !== 'seq'));
console.log(totals(folded));
