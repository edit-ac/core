// Public installed SDK/WASM; failure injection changes only the real IDB port.
import { init } from '@edit-ac/core';
import { CheckpointStorage, openEditorStorage } from '@edit-ac/web';
const assetUrl = '/core/wasm/editac_wasm_bg.wasm', databaseName = 'public-storage-retry';
const runtime = await init(assetUrl);
let owner, live, options, denied = false, attempts = 0, patches = [], subscription;
const native = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
  if (this.name === databaseName && stores === 'updates' && mode === 'readwrite') {
    attempts++;
    if (denied) throw new DOMException('Prepared append denial for public-storage-retry', 'NotAllowedError');
  }
  return native.call(this, stores, mode, ...rest);
};
const own = value => JSON.parse(JSON.stringify(value, (_key, v) => v instanceof Uint8Array ? [...v] : v));
const state = engine => { const { changedNodes, touchedRanges, ...s } = engine.read(); return s; };
const texts = engine => engine.read().visible.map(n => n.runs.map(r => r.text).join(''));
async function disk() {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(databaseName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    const names = [...db.objectStoreNames].sort(), tx = db.transaction(names, 'readonly');
    return own(Object.fromEntries(await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve([name, r.result]); r.onerror = () => reject(r.error);
    })))));
  } finally { db.close(); }
}
window.retryFixture = {
  async mount() {
    const seed = runtime.createEngine({ profile: 'v5', documentId: '99100000-0000-4000-8000-000000000001', epoch: '99100000-0000-4000-8000-000000000002', nodes: [{ text: 'before 😀' }, { text: 'neighbor' }] });
    const point = seed.checkpoint(); seed.dispose();
    const storage = await CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish(point, []); } finally { storage.close(); }
    options = { assetUrl, databaseName, identity: point.identity, indexedDB, locks: navigator.locks };
    owner = await openEditorStorage(options); live = owner.engine;
    live.history({ type: 'clear' });
    subscription = live.subscribe({ type: 'updates' }, patch => patches.push(own(patch)));
  },
  deny(value) { denied = value; },
  edit(value) {
    owner.commit({ kind: 'editor', origin: 'public-retry-fixture', commands: [
      { type: 'replaceAt', owner: owner.engine.read().visible[0].id, from: 0, to: texts(owner.engine)[0].length, text: value },
    ] });
  },
  async flush(retryFailed = false, concurrent = false) {
    try {
      const first = owner.flush({ target: 'local', retryFailed });
      await (concurrent ? Promise.all([first, owner.flush({ target: 'local', retryFailed })]) : first);
      return { ok: true };
    } catch (error) { return { ok: false, name: error.name, message: error.message }; }
  },
  async oracle() {
    return own({ sameReplica: owner.engine === live, snapshot: state(owner.engine), checkpoint: owner.engine.checkpoint(),
      history: owner.engine.history({ type: 'state' }), vector: owner.engine.stateVector(), encoded: owner.engine.encodeUpdate(),
      texts: texts(owner.engine), recovery: owner.recoveryExport(), patches, attempts, disk: await disk() });
  },
  history(type) { return owner.engine.history({ type }); },
  async reopen() {
    subscription.dispose(); await owner.destroy({ policy: 'flush' });
    owner = await openEditorStorage(options);
    return own({ snapshot: state(owner.engine), texts: texts(owner.engine), recovery: owner.recoveryExport(), disk: await disk() });
  },
  async dispose() {
    subscription?.dispose();
    try { await owner?.destroy({ policy: 'report' }); }
    finally { IDBDatabase.prototype.transaction = native; window.fixtureDisposed = true; }
  },
};
window.addEventListener('pagehide', () => { IDBDatabase.prototype.transaction = native; });
