// Client plugin entry: registers the Lineage conversation tab, the sidebar panel
// button (next to Automation tasks) and its main page.
import { LineageTab, LineagePage, LineageIcon } from './ui.js';
import { STYLES } from './styles.js';

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

export const inject = ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace'];

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

export function apply(ctx) {
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
