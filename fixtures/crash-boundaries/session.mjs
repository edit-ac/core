import { init } from '/core/index.js';
import { StorageWriter } from '/web/storage/writer.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { LocalStorageLifecycle } from '/web/storage/index.js';

const identity = {
  documentId: '45678901-4567-4567-8567-45678901abcd',
  epoch: '56789012-5678-4678-8678-56789012abcd', schema: 'editac.registry.editor.v5',
  offsets: 'utf16', profile: 'editac.yrs-yjs.editor.v5', protocolVersion: 1, updateEncoding: 1,
};
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const checkpoints = await CheckpointStorage.open(indexedDB, 'recovery');
const journal = await UpdateJournal.open(indexedDB, 'recovery');
let writer, lifecycle;
const text = () => writer.engine.read().visible[0].runs.map(run => run.text).join('');
const serial = value => JSON.parse(JSON.stringify(value, (_, v) => v instanceof Uint8Array ? Array.from(v) : v));
const state = () => serial(lifecycle.state);
const entries = () => journal.read(identity);

async function seed() {
  const engine = runtime.createEngine({ profile: 'v5', documentId: identity.documentId, epoch: identity.epoch, nodes: [{ text: 'a😀b' }] });
  const point = engine.checkpoint();
  // Use the actual engine's versioned identity, never relabel checkpoint bytes.
  Object.assign(identity, point.identity);
  engine.dispose();
  await checkpoints.publish(point, []);
  return restore();
}
async function restore() {
  const result = await checkpoints.restore(identity, recovery => StorageWriter.restore(runtime, navigator.locks,
    identity, recovery.checkpoint, recovery.tail.map(e => ({ identity: e.identity, bytes: e.bytes }))));
  writer = await result.value;
  lifecycle = new LocalStorageLifecycle(writer, journal);
  return { text: text(), writerId: writer.writerId, source: result.recovery.source, rejected: result.recovery.rejected,
    entries: serial(await entries()), checkpoint: serial(result.recovery.checkpoint) };
}
function edit(word) {
  const at = writer.engine.anchor(writer.engine.read().visible[0].id, text().length, 'right');
  try { lifecycle.commit({ kind: 'text', origin: 'recovery:browser', command: { type: 'insert', at, text: word } }); }
  finally { writer.engine.releaseAnchor(at); }
}
async function commit(words) {
  const acknowledgments = [];
  for (const word of words) {
    edit(word);
    await lifecycle.flush({ target: 'local' });
    acknowledgments.push(state());
  }
  return { text: text(), acknowledgments, entries: serial(await entries()) };
}
async function publish() {
  const tail = await entries();
  return { acknowledgment: await checkpoints.publish(writer.engine.checkpoint(), tail.map(e => e.updateId)), coverage: tail.map(e => e.updateId) };
}
function holdBeforeCompletion(word) {
  // Hold the *native* transaction active after request success. Request success
  // is not acknowledgment; termination must roll back this uncommitted write.
  const add = IDBObjectStore.prototype.add;
  window.preAck = { requestSucceeded: false };
  IDBObjectStore.prototype.add = function(...args) {
    const request = add.apply(this, args);
    if (this.name === 'updates') {
      const store = this;
      request.addEventListener('success', () => {
        window.preAck = { requestSucceeded: true, text: text(), state: state(), entry: serial(args[0]),
          guarantee: 'outside localCommitted guarantee until transaction completion' };
        const keepAlive = () => { store.get(args[0].updateId).onsuccess = keepAlive; };
        keepAlive();
      });
    }
    return request;
  };
  edit(word);
}
window.recovery = { seed, restore, commit, publish, holdBeforeCompletion, state };
