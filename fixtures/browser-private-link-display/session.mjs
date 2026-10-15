import { init } from '@edit-ac/core';
import { mountEditorSurface, privateReferenceDisplay, referenceBlock } from '/web/index.js';
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const documentId = '45678901-4567-4567-8567-45678901abcd', epoch = '56789012-5678-4678-8678-56789012abcd';
const targetId = 'ac://team-1/12345678-1234-4234-8234-123456789abc';
const label = 'User-authored shared label';
const viewers = {}, assets = [], revoked = [];
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = create(blob); assets.push(url); return url; };
URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
const icon = () => new Blob([Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0))], { type: 'image/gif' });
function host(principal, authorized) {
  return { principal, tenant: 'tenant1', authority: 'team-1',
    scope: { document: documentId, session: principal + '-session', revision: 'policy:1', permission: 'permission1', authorized },
    policyRevision: '1', readonly: false,
    capabilities: { publicMetadata: false, privateLookup: authorized, title: authorized, icon: authorized, preview: authorized, activate: authorized, publishMetadata: false } };
}
function outcome(request, status = 'available', title = 'Secret Alice title', expiresAt = Date.now() + 60000) {
  return status === 'available' ? { status, metadata: { kind: 'private', targetId: request.target.targetId,
    display: { title, description: title + ' preview', iconAsset: 'host_icon' } },
    freshness: { fetchedAt: Date.now() - 1, expiresAt, policyRevision: request.host.policyRevision } } : { status };
}
// Prepared host adapter: envelope-scoped local cache, no network or credentials.
// Its output remains untrusted by the real presenter/validator.
function cache(v, request) {
  v.cacheReads++;
  if (v.badCache) return { request: v.badCache, outcome: outcome(v.badCache) };
  if (!v.cacheEnabled) return;
  const grant = v.grant;
  if (!grant || !['principal', 'tenant', 'authority', 'policyRevision'].every(k => request.host[k] === grant[k]) ||
      request.host.scope.permission !== grant.scope.permission || !request.host.scope.authorized) return;
  return { request, outcome: outcome(request, v.status, v.secret, v.expiresAt) };
}
function bind(v) {
  const factory = privateReferenceDisplay({ context: () => { if (v.contextError) throw Error('Prepared host unavailable'); return v.host; },
    target: id => v.noTarget ? undefined : { targetId: id, authority: v.targetAuthority ?? 'team-1' },
    cached: request => cache(v, request),
    subscribe: callback => { v.listeners.add(callback); return () => { v.listeners.delete(callback); v.released++; }; },
    ports: { privateCatalog: (request, signal) => new Promise((resolve, reject) => v.pending.push({ request, signal, resolve, reject })) },
    iconAsset: () => {
      if (v.reentrant) { v.reentrant = false; change(v.name, 'revoke'); }
      return v.iconMode === 'svg' ? new Blob(['<svg/>'], { type: 'image/svg+xml' }) :
        v.iconMode === 'huge' ? new Blob([new Uint8Array(32769)], { type: 'image/png' }) :
        v.iconMode === 'none' ? null : icon();
    }
  });
  v.surface = mountEditorSurface(v.root, v.engine, { content: context => {
    const view = factory(context); if (view) v.views.push(view); return view;
  }, commit: request => { v.commands.push(request); return v.engine.commit(v.engine.prepare(request)); } });
}
function mount(config = {}) {
  if (typeof config !== 'object') config = {};
  const seed = runtime.createEngine({ profile: 'v5', documentId, epoch, nodes: [{ text: '' }, { text: 'Independent editable text' }] });
  const id = seed.read().visible[0].id, at = seed.anchor(id, 0, 'right');
  seed.commit(seed.prepare({ kind: 'fragment', origin: 'prepared-reference', range: { anchor: at, focus: at },
    blocks: [referenceBlock({ targetId, label: config.label ?? label })] }));
  seed.releaseAnchor(at); seed.history({ type: 'clear' }); const checkpoint = seed.checkpoint(); seed.dispose();
  for (const name of ['alice', 'bob']) {
    const engine = runtime.restoreEngine(checkpoint.identity, checkpoint);
    const v = viewers[name] = { name, engine, root: document.querySelector('#' + name), host: host(name, name === 'alice' || config.bobAuthorized),
      listeners: new Set(), pending: [], commands: [], views: [], released: 0, cacheReads: 0, cacheEnabled: config.cache !== false,
      status: config.status ?? 'available', secret: name === 'alice' ? 'Secret Alice title' : 'Secret Bob title',
      expiresAt: Date.now() + (config.lease ?? 60000), iconMode: config.icon ?? 'safe' };
    v.grant = structuredClone(v.host); engine.history({ type: 'clear' }); bind(v);
  }
}
function notify(v) { for (const callback of [...v.listeners]) callback(); }
function change(name, action, notifyChange = true) {
  const v = viewers[name], h = v.host;
  if (action === 'principal') v.host = { ...h, principal: 'charlie' };
  if (action === 'tenant') v.host = { ...h, tenant: 'tenant2' };
  if (action === 'authority') v.host = { ...h, authority: 'other-team' };
  if (action === 'session') v.host = { ...h, scope: { ...h.scope, session: 'new-session' } };
  if (action === 'permission') v.host = { ...h, scope: { ...h.scope, permission: 'permission2' } };
  if (action === 'policy') v.host = { ...h, policyRevision: '2' };
  if (action === 'revoke' || action === 'logout') v.host = { ...h, scope: { ...h.scope, authorized: false } };
  if (action === 'lock') { v.cacheEnabled = false; v.status = 'locked'; }
  if (action === 'title') v.host = { ...h, capabilities: { ...h.capabilities, title: false } };
  if (action === 'icon') v.host = { ...h, capabilities: { ...h.capabilities, icon: false } };
  if (action === 'preview') v.host = { ...h, capabilities: { ...h.capabilities, preview: false } };
  if (action === 'offline') v.cacheEnabled = false;
  if (action === 'context-error') v.contextError = true;
  if (notifyChange) notify(v);
}
function refresh(name) { viewers[name].root.querySelector('button').click(); }
function respond(name, status = 'available', overrides = {}) {
  const v = viewers[name], p = v.pending.at(-1);
  if (status === 'reject') { p.reject(Error('Prepared offline')); return; }
  const result = outcome(p.request, status, v.secret, v.expiresAt);
  Object.assign(result, overrides); p.resolve(result);
}
function replace(name, nextLabel = 'Edited shared label', nextTarget = targetId) {
  const v = viewers[name], e = v.engine, node = e.read().visible.find(n => n.blockAttributes?.[0] === 'module:editac.reference');
  // Opaque atoms are replaced through editable cuts around them, not text offsets inside them.
  const nodes = e.read().visible, index = nodes.findIndex(n => n.id === node.id), before = nodes[index - 1], after = nodes[index + 1];
  const start = e.anchor(before.id, before.runs.map(r => r.text).join('').length, 'right'), end = e.anchor(after.id, 0, 'left');
  try { e.commit(e.prepare({ kind: 'fragment', origin: 'user-replace-reference', range: { anchor: start, focus: end },
    blocks: [referenceBlock({ targetId: nextTarget, label: nextLabel })] })); }
  finally { e.releaseAnchor(start); e.releaseAnchor(end); }
}
function sync(from = 'alice', to = 'bob') {
  const a = viewers[from].engine, b = viewers[to].engine;
  b.applyUpdate(a.encodeUpdate(b.stateVector())); a.applyUpdate(b.encodeUpdate(a.stateVector()));
}
function state() {
  return { assets, revoked, viewers: Object.fromEntries(Object.entries(viewers).map(([name, v]) => [name, {
    nodes: v.engine.read().visible, history: v.engine.history({ type: 'state' }), checkpoint: Array.from(v.engine.checkpoint().bytes),
    commands: v.commands, pending: v.pending.map(p => p.request), aborted: v.pending.map(p => p.signal.aborted),
    listeners: v.listeners.size, released: v.released, cacheReads: v.cacheReads,
    text: v.root.textContent, titles: [...v.root.querySelectorAll('[data-private-title]')].map(e => e.textContent),
    previews: [...v.root.querySelectorAll('[data-private-preview]')].map(e => e.textContent),
    states: [...v.root.querySelectorAll('[data-private-reference]')].map(e => e.dataset.state),
    labels: [...v.root.querySelectorAll('[data-reference-label]')].map(e => e.textContent),
    icons: [...v.root.querySelectorAll('img')].map(e => e.src), busy: v.root.querySelector('[aria-busy]') !== null,
    errors: v.engine.takeObserverErrors()
  }])) };
}
function destroy() { for (const v of Object.values(viewers)) { v.surface.dispose(); v.engine.dispose(); } window.fixtureDisposed = true; }
window.inputFixture = { mount, state, change, refresh, respond, replace, sync, destroy, viewers, notify, outcome,
  dispose: name => viewers[name].surface.dispose(),
  cancel: name => viewers[name].views.at(-1).cancel(),
  readonly: name => viewers[name].surface.setReadOnly(true),
  badCache: name => { const v = viewers[name]; v.badCache = viewers.alice.pending[0].request; notify(v); },
  reentrant: name => { const v = viewers[name]; v.reentrant = true; notify(v); },
  replay: name => { const v = viewers[name], cp = v.engine.checkpoint(); v.surface.dispose(); v.engine.dispose(); v.engine = runtime.restoreEngine(cp.identity, cp); bind(v); }
};
