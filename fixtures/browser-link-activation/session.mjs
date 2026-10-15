import { init } from '/core/index.js';
import { mountEditorSurface, referenceBlock, privateReferenceDisplay } from '/web/index.js';
import { LinkActivation, bindLinkActivation } from '/web/modules/links/activation.js';
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const targetId = 'ac://team/71000000-0000-4000-8000-000000000008', url = 'https://example.test/original?q=intentional#part';
let engine, surface, activation, binding, host, calls, results, catalogs, resolves, saved, kind, nodeId, status, deepLocator;
const root = document.querySelector('#editor');
function context() { return { ...host, scope: { ...host.scope, revision: String(engine.read().revision) } }; }
function request(node, requestId = 'click', cancellationToken = 'cancel') {
  if (!node) return;
  const tuple = node.blockAttributes;
  const target = tuple?.[0] === 'module:editac.reference' ? { kind: 'private', targetId: tuple[2].targetId, authority: 'team' }
    : node.runs.find(r => r.attributes.link) ? { kind: 'public', url: node.runs.find(r => r.attributes.link).attributes.link } : undefined;
  if (!target) return;
  return { requestId, cancellationToken, node: node.id, epoch: engine.read().identity.epoch, labelRevision: 'authored-label', host: context(), target, policy: 'disabled', origin: 'open' };
}
function dispose() { binding?.dispose(); activation?.dispose(); surface?.dispose(); engine?.dispose(); binding = activation = surface = engine = undefined; }
function mount() {
  dispose(); kind = 'public'; calls = []; results = []; catalogs = resolves = 0; status = 'hosted'; deepLocator = targetId;
  engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: '' }, { text: 'Independent editable text' }] });
  host = { principal: 'alice', tenant: 'tenant1', authority: 'team', scope: { document: engine.read().identity.documentId, session: 'session1', revision: '1', permission: 'permission1', authorized: true }, policyRevision: 'policy1', readonly: false,
    capabilities: { publicMetadata: true, privateLookup: true, title: true, icon: true, preview: true, activate: true, publishMetadata: false } };
  const at = engine.anchor(engine.read().visible[0].id, 0, 'right');
  engine.commit(engine.prepare({ kind: 'fragment', origin: 'prepared-links', range: { anchor: at, focus: at }, blocks: [
    { attributes: { type: 'paragraph' }, runs: [{ text: 'Original public link', marks: [{ mark: 'link', href: url }] }] }, referenceBlock({ targetId, label: 'Authored reference' })] })); engine.releaseAnchor(at);
  const factory = privateReferenceDisplay({ context, target: id => ({ targetId: id, authority: 'team' }), subscribe: () => () => {}, ports: { privateCatalog: async () => { resolves++; throw Error('Unexpected lookup'); } },
    cached: r => ({ request: r, outcome: { status: 'available', metadata: { kind: 'private', targetId, display: { title: 'Prepared private title' } }, freshness: { fetchedAt: Date.now() - 1, expiresAt: Date.now() + 60000, policyRevision: host.policyRevision } } }) });
  surface = mountEditorSurface(root, engine, { content: factory });
  activation = new LinkActivation({ context, current: r => request(engine.read().visible.find(n => n.id === r.node), r.requestId, r.cancellationToken),
    catalog: { catalog: id => { catalogs++; return { targetId: id, status }; } }, privateLocator: () => deepLocator, dispatch: action => { calls.push(action); return 'available'; } });
  binding = bindLinkActivation(root, activation, event => {
    if (event.target.closest('button') || !event.target.closest('a,[data-private-reference]')) return;
    const element = event.target.closest('[data-node-id]'); if (!element) return;
    return request(engine.read().visible.find(n => n.id === element.dataset.nodeId)) ?? null;
  }, state => results.push(state));
}
function state() { return { calls, results, catalogs, resolves, bytes: Array.from(engine.checkpoint().bytes), text: root.textContent, href: root.querySelector('a')?.href }; }
function change(action) {
  if (action === 'readonly') { host.readonly = true; surface.setReadOnly(true); }
  if (action === 'revoke') host.capabilities.activate = false;
  if (action === 'locked') status = 'locked';
  if (action === 'deep') deepLocator = 'myapp://team/document-1';
  if (action === 'credentials') deepLocator = 'myapp://user:secret@team/document-1';
  if (action === 'metadata') { root.querySelector('a').href = 'https://attacker.test/stale-canonical'; }
  if (action === 'capture') saved = request(engine.read().visible.find(n => n.blockAttributes?.[0] === 'module:editac.reference'));
  if (action === 'copy') results.push(activation.copy(request(engine.read().visible.find(n => n.blockAttributes?.[0] === 'module:editac.reference'))));
  if (action === 'edit') { const owner = engine.read().visible.find(n => n.runs.some(r => r.text === 'Independent editable text')).id; engine.commit(engine.prepare({ kind: 'editor', origin: 'user-edit', commands: [{ type: 'replaceAt', owner, from: 0, to: 0, text: 'Edited' }] })); }
  if (action === 'old-click') results.push(activation.perform({ kind: 'activate', request: saved }));
  if (action === 'dispose') { binding.dispose(); activation.dispose(); }
}
window.inputFixture = { mount, state, change, dispose, destroy: dispose };
