import { init } from '@edit-ac/core';
import { createEditor, CheckpointStorage, DocumentSearch, BlockReorder } from '@edit-ac/web';
import { createHostAgent, createHostApply } from '@edit-ac/web/host';

// Only host transport is prepared. Document, admission, history, sync and stores
// are the installed production owners; no fixture writes expected state.
const assetUrl = new URL('/core/wasm/editac_wasm_bg.wasm', location.href).href;
const runtime = await init(assetUrl);
const rpc = async input => { const r = await window.hostRpc(input); if (r.error) throw Error(r.error); return r.ok; };
const views = [];
let local, closed = false, clock = 0;
function texts(editor) { return editor.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')); }
async function seed(checkpoint, databaseName) {
  const store = await CheckpointStorage.open(indexedDB, databaseName);
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  return { assetUrl, identity: checkpoint.identity, databaseName, indexedDB, locks: navigator.locks };
}
function select(editor, index, start, end = start) {
  const id = editor.read().visible.filter(n => n.kind === 'block')[index].id;
  const block = editor.root.querySelector(`[data-node-id="${id}"]`);
  function point(offset) { const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let n; while (n = walker.nextNode()) { if (offset <= n.length) return [n, offset]; offset -= n.length; } return [block, 0]; }
  editor.root.focus(); document.getSelection().setBaseAndExtent(...point(start), ...point(end));
  document.dispatchEvent(new Event('selectionchange'));
}
function configuration(collaborative) {
  return { extensions: collaborative ? [DocumentSearch.configure(), BlockReorder.configure()] : [], commandControls: true,
    formatting: collaborative ? {} : { marks: { italic: { commands: false, shortcuts: false, controls: false } } },
    platform: { spellcheck: collaborative ? 'platform' : 'off', autocorrection: 'inherit' } };
}
async function open(root, storage, collaborative) {
  const view = { root, storage, collaborative, patches: [], frames: [], options: configuration(collaborative) };
  if (collaborative) view.options.collaboration = { connect: () => ({ peerIdentity: storage.identity, authorized: true,
    transport: { send(frame) { view.frames.push([...frame]); return true; } } }) };
  view.editor = createEditor(root, { ...storage, ...view.options });
  await view.editor.ready;
  if (collaborative) await view.editor.connectCollaboration();
  view.subscription = view.editor.subscribe({ type: 'all' }, p => view.patches.push({ origin: p.origin, update: !!p.update }));
  views.push(view); return view;
}
async function pump() {
  for (let i = 0; i < 5; i++) for (const v of views.filter(v => v.collaborative && !v.disposed)) {
    await v.editor.flush({ target: 'local' });
    await v.editor.syncAttachment.pump(++clock);
    while (v.frames.length) {
      const response = await window.hostFrame(v.frames.shift(), v.editor.recoveryExport().checkpoint.writerId);
      if (response) v.editor.syncAttachment.receive(new Uint8Array(response));
    }
  }
  for (const v of views.filter(v => !v.disposed)) { await v.editor.settle(); await v.editor.flush({ target: 'local' }); }
}
async function pull() {
  // Flush every sender before asking any receiver for the host's new vector.
  await pump();
  // Reconnect asks the existing SyncSession for a fresh state-vector handshake.
  for (const v of views.filter(v => v.collaborative && !v.disposed)) await v.editor.connectCollaboration();
  await pump();
}
async function mount() {
  const checkpoint = await rpc({ op: 'seed' }); checkpoint.bytes = new Uint8Array(checkpoint.bytes);
  for (const id of ['one', 'two']) await open(document.getElementById(id), await seed(checkpoint, `primary-flow-${id}`), true);
  const e = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: 'Local note' }] });
  try { local = await open(document.getElementById('local'), await seed(e.checkpoint(), 'primary-flow-local'), false); } finally { e.dispose(); }
  await pump();
}
const access = () => ({ actorId: 'agent-a', documentId: views[0].storage.identity.documentId, epoch: views[0].storage.identity.epoch, permissions: ['apply', 'receipt'], readOnly: false });
const agent = createHostAgent({ authorize: async (context, id) => context === 'authenticated' && id === access().documentId ? access() : null,
  services: createHostApply({ available: () => true, apply: request => rpc({ op: 'apply', ...request }), receipt: request => rpc({ op: 'receipt', ...request }) }) });
async function agentEdit(text = 'Agent ', requestId = 'combined-agent') {
  await pump();
  const proposal = await rpc({ op: 'prepare', text, index: 0 });
  const request = { version: 1, documentId: access().documentId, ...proposal, requestId };
  const first = await agent.call('apply', request, 'authenticated');
  const retry = await agent.call('apply', request, 'authenticated');
  await pull(); return { first, retry };
}
async function history(view = views[0], redo = false) {
  const h = view.editor.captureHistory(); try { return h.execute(redo ? 'redo' : 'undo'); } finally { h.dispose(); }
}
async function snapshot() {
  await pump();
  return views.filter(v => !v.disposed).map(v => ({ id: v.root.id, texts: texts(v.editor), nodes: v.editor.read().visible,
    
    patches: v.patches, storage: v.editor.state, collaboration: v.editor.collaborationStatus.state,
    search: !!v.editor.search, reorder: !!v.editor.reorder, identity: v.editor.read().identity,
    unsaved: v.editor.recoveryExport().unsavedUpdates.length }));
}
async function dispose(v) { if (v.disposed) return; v.subscription(); await v.editor.destroy({ policy: 'flush' }); v.disposed = true; }
async function reopen() {
  const active = views.filter(v => !v.disposed).map(v => ({ root: v.root, storage: v.storage, collaborative: v.collaborative }));
  for (const v of views) await dispose(v);
  for (const v of active) { const opened = await open(v.root, v.storage, v.collaborative); if (!v.collaborative) local = opened; }
  await pump(); return snapshot();
}
async function close() { if (closed) return; for (const v of views) await dispose(v); closed = true; window.fixtureDisposed = true; }
window.productFlow = { mount, pump, pull, snapshot, reopen, close, agentEdit, history, select, dispose,
  get views() { return views.filter(v => !v.disposed); }, get local() { return local; } };
