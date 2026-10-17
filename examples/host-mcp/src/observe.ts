import type { HostAgentAccess, HostAgentResult } from '@edit-ac/web/host';

type Context = unknown;
type Scope = Readonly<HostAgentAccess>;
interface Options {
  host: { call(operation: string, request: unknown, context: Context): Promise<HostAgentResult> };
  /** The same live host authorization used by the tool facade. */
  authorize(context: Context, documentId: string): Promise<Scope | null>;
  context: Context;
  negotiated: { resources: boolean; subscriptions: boolean };
  /** Dispatch on this authenticated connection. Only an invalidation URI is sent. */
  notify(method: 'notifications/resources/updated', params: { uri: string }): Promise<void>;
  now?: () => number;
  maxDocuments?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
}
interface Entry {
  scope: string;
  expires: number;
  nextRead: number;
  pending: boolean;
  subscribed: boolean;
  hinted: string | null;
  notifying: boolean;
}
const error = (code: string) => ({ status: 'error' as const, code });
const uriFor = (id: string) => `editac://document/${encodeURIComponent(id)}/revision`;
const scopeKey = (a: Scope) => JSON.stringify([a.actorId, a.documentId, a.epoch]);
function bounded(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid observation limit');
  return value;
}

/** One facade per authenticated MCP connection. No timers, content, patches,
 * durable acknowledgements or event replay. Hosts call invalidate after an edit;
 * missed/coalesced hints always recover through bounded poll/current reads. */
export function registerHostObservation(appMcp: {
  registerResourceProvider(provider: unknown): void;
}, options: Options) {
  const now = options.now ?? Date.now;
  const maximum = bounded(options.maxDocuments ?? 16, 1, 128);
  const interval = bounded(options.pollIntervalMs ?? 1000, 100, 60_000);
  const lease = bounded(options.leaseMs ?? 60_000, interval, 300_000);
  const resources = options.negotiated.resources;
  const subscriptions = resources && options.negotiated.subscriptions;
  const entries = new Map<string, Entry>();
  let activeReads = 0;
  let activeInvalidations = 0;
  let disposed = false;
  const prune = () => { for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id); };
  const authorized = async (id: string): Promise<Scope | null> => {
    try {
      const access = await options.authorize(options.context, id);
      return !disposed && access?.documentId === id && access.actorId && access.epoch
        && access.permissions.includes('read') && access.permissions.includes('observe') ? access : null;
    } catch { return null; }
  };
  const read = async (id: string, cursor?: string, subscribe = false) => {
    if (disposed) return error('closed');
    if (typeof id !== 'string' || !id.length || id.length > 512
      || (cursor !== undefined && (typeof cursor !== 'string' || !cursor.length || cursor.length > 512))) return error('invalid-request');
    prune();
    let entry = entries.get(id);
    if (entry?.pending) return error('busy');
    if (entry && now() < entry.nextRead) return { ...error('rate-limited'), pollAfterMs: entry.nextRead - now() };
    if (!entry && entries.size >= maximum) return error('limit');
    if (activeReads >= maximum) return error('busy');
    if (!entry) {
      entry = { scope: '', expires: now() + lease, nextRead: 0, pending: false, subscribed: false, hinted: null, notifying: false };
      entries.set(id, entry);
    }
    const current = entry;
    current.pending = true;
    activeReads++;
    current.nextRead = now() + interval;
    try {
      const access = await authorized(id);
      if (!access || (current.scope && current.scope !== scopeKey(access))) {
        entries.delete(id); return error('denied');
      }
      current.scope = scopeKey(access);
      const result = await options.host.call('observe', { version: 1, documentId: id,
        ...(cursor === undefined ? {} : { cursor }) }, options.context);
      const after = await authorized(id);
      if (!after || scopeKey(after) !== current.scope || entries.get(id) !== current || current.expires <= now()) {
        entries.delete(id); return error('denied');
      }
      if (result.status !== 'ok') { entries.delete(id); return result; }
      const data = result.data as Record<string, unknown>;
      if (!data || typeof data.revision !== 'string' || !data.revision.length || data.revision.length > 512) {
        entries.delete(id); return error('unavailable');
      }
      current.expires = now() + lease;
      current.subscribed ||= subscribe;
      if (subscribe) current.hinted = data.revision;
      // Whitelist metadata even if an embedding owner's response has extra fields.
      return { status: 'ok' as const, data: { revision: data.revision, cursor: data.revision,
        changed: cursor !== data.revision, resyncRequired: cursor !== data.revision,
        dataChannel: 'collaboration', durability: 'not-reported', pollAfterMs: interval } };
    } catch { entries.delete(id); return error('unavailable'); }
    finally { current.pending = false; activeReads--; }
  };
  const documentFromUri = (uri: string) => {
    const match = /^editac:\/\/document\/([^/]+)\/revision$/.exec(uri);
    if (!match) return null;
    try { const id = decodeURIComponent(match[1]!); return uriFor(id) === uri ? id : null; } catch { return null; }
  };
  const facade = {
    capabilities: Object.freeze({ resources, subscriptions, pollAfterMs: interval, leaseMs: lease, maxDocuments: maximum }),
    poll: (id: string, cursor?: string) => read(id, cursor),
    async subscribe(id: string) { return subscriptions ? read(id, undefined, true) : error('unsupported'); },
    unsubscribe(id: string) { entries.delete(id); },
    async invalidate(id: string) {
      prune();
      const entry = entries.get(id);
      if (!entry?.subscribed || disposed || entry.notifying || activeInvalidations >= maximum) return;
      entry.notifying = true;
      activeInvalidations++;
      try {
      const result = await read(id);
      if (result.status !== 'ok' || !('data' in result)) return;
      if (entries.get(id) !== entry || !entry.subscribed || entry.hinted === result.data.revision) return;
      const access = await authorized(id);
      if (!access || scopeKey(access) !== entry.scope || entries.get(id) !== entry || entry.expires <= now()) {
        entries.delete(id); return;
      }
      entry.hinted = result.data.revision;
      try { await options.notify('notifications/resources/updated', { uri: uriFor(id) }); }
      catch { /* A dropped hint is recovered by polling, never by replaying edits. */ }
      } finally { entry.notifying = false; activeInvalidations--; }
    },
    dispose() { disposed = true; entries.clear(); },
    get retainedDocuments() { prune(); return entries.size; },
  };
  if (resources) appMcp.registerResourceProvider({
    // Resource discovery is explicit per authorized document, never a global document listing.
    async list(documentId: string) {
      return await authorized(documentId) ? [{ uri: uriFor(documentId), mimeType: 'application/json', name: 'Current edit.ac revision' }] : [];
    },
    async read(uri: string, cursor?: string) {
      const id = documentFromUri(uri);
      return id === null ? error('invalid-request') : read(id, cursor);
    },
    ...(subscriptions ? { subscribe: async (uri: string) => {
      const id = documentFromUri(uri);
      return id === null ? error('invalid-request') : facade.subscribe(id);
    }, unsubscribe: (uri: string) => { const id = documentFromUri(uri); if (id !== null) facade.unsubscribe(id); } } : {}),
  });
  return Object.freeze(facade);
}
