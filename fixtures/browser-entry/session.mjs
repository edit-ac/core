import { init } from '@edit-ac/core';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';

const identity = {
  documentId: '45678901-4567-4567-8567-45678901abcd',
  epoch: '56789012-5678-4678-8678-56789012abcd', schema: 'editac.registry.editor.v5',
  offsets: 'utf16', profile: 'editac.yrs-yjs.editor.v5', protocolVersion: 1, updateEncoding: 1,
};
let session;
const state = { phase: 'idle', error: null, source: null };
const events = [];
const root = document.querySelector('#projection');
const status = document.querySelector('#status');
const text = () => session.writer.engine.read().visible[0].runs.map(run => run.text).join('');
function project() { root.textContent = text(); }
function view() { return { ...state, text: root.textContent, editable: root.isContentEditable, events: [...events] }; }
async function activate({ assetUrl = '/core/wasm/editac_wasm_bg.wasm', missingLocks = false } = {}) {
  if (session || state.phase === 'recovering') throw Error('Entry already active');
  state.phase = 'recovering'; state.error = null; status.textContent = 'Recovering local document';
  root.contentEditable = 'false';
  try {
    session = await recoverLocalDocument({ assetUrl, databaseName: 'browser-entry', identity,
      indexedDB, locks: missingLocks ? undefined : navigator.locks });
    events.push('engine-recovered', 'persistence-attached');
    state.source = session.source;
    project();
    // This fixture accepts only explicit semantic test commands. Full DOM input
    // readiness remains WEB-1.2–WEB-1.10 work.
    state.phase = 'ready'; events.push('ready'); status.textContent = 'Local engine ready';
  } catch (error) {
    state.phase = 'failed'; state.error = error.message;
    status.textContent = `Recovery failed: ${error.message}`;
  }
  return view();
}
async function seed() {
  const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
  const engine = runtime.createEngine({ profile: 'v5', documentId: identity.documentId, epoch: identity.epoch,
    nodes: [{ text: 'a😀b' }] });
  const checkpoint = engine.checkpoint(); engine.dispose();
  const store = await CheckpointStorage.open(indexedDB, 'browser-entry');
  try { await store.publish(checkpoint, []); } finally { store.close(); }
  await activate();
  await edit(' tail');
  await destroy();
  return view();
}
async function edit(value) {
  if (state.phase !== 'ready') throw Error('Authoritative recovery and persistence are required');
  const engine = session.writer.engine;
  const node = engine.read().visible[0].id;
  const at = engine.anchor(node, text().length, 'right');
  const patches = [];
  const subscription = engine.subscribe({ type: 'nodes', ids: [node] }, patch => patches.push(patch));
  try {
    const result = session.storage.commit({ kind: 'text', origin: 'browser-entry',
      command: { type: 'insert', at, text: value } });
    const resolved = engine.resolve(at);
    const beforeFlush = session.storage.state;
    await session.storage.flush({ target: 'local' });
    project();
    return { result, resolved, patches, beforeFlush, afterFlush: session.storage.state, text: text() };
  } finally { subscription.dispose(); engine.releaseAnchor(at); }
}
async function destroy() {
  if (session) { await session.storage.destroy({ policy: 'flush' }); session = undefined; }
  state.phase = 'closed';
}
window.entry = { seed, activate, edit, view, destroy };
