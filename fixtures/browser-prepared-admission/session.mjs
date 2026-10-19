// Installed public entrypoints only; the owner admits all semantic edits.
import { init } from '@edit-ac/core';
import { WebHistoryStore, HistoryRestorer, CheckpointStorage, openEditorStorage } from '@edit-ac/web';
const assetUrl = '/core/wasm/editac_wasm_bg.wasm';
const runtime = await init(assetUrl), databaseName = 'public-prepared-restore';
let owner, live, store, access, restorer, old, subscription, patches = [], releases = 0;
let writable = true, recoveryRequired = false, serial = 0;
const documentState = engine => { const { changedNodes, touchedRanges, ...state } = engine.read(); return state; };
const text = engine => engine.read().visible.map(n => n.runs.map(r => r.text).join(''));
const request = (engine, value) => ({ kind: 'editor', origin: 'public-restore-fixture', commands: [
  { type: 'replaceAt', owner: engine.read().visible[0].id, from: 0, to: text(engine)[0].length, text: value },
] });
async function disk() {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(databaseName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    const names = [...db.objectStoreNames].sort(), tx = db.transaction(names, 'readonly');
    return Object.fromEntries(await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve([name, r.result]); r.onerror = () => reject(r.error);
    }))));
  } finally { db.close(); }
}
async function destroy() {
  subscription?.dispose(); subscription = null;
  if (owner) { await owner.destroy({ policy: 'flush' }); owner = null; }
  window.fixtureDisposed = true;
}
function attachRestorer() {
  restorer = new HistoryRestorer(store, {
    engine: { ...owner.engine, releasePlan: plan => { releases++; owner.engine.releasePlan(plan); } },
    commit: owner.commitPrepared, writable: () => writable && !recoveryRequired,
  }, () => access);
}
window.restoreFixture = {
  async mount() {
    await destroy();
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(databaseName); r.onsuccess = resolve; r.onerror = () => reject(r.error); r.onblocked = () => reject(Error('Database still owned')); });
    const seed = runtime.createEngine({ profile: 'v5', documentId: '97000000-0000-4000-8000-000000000001',
      epoch: `98000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, nodes: [{ text: 'before 😀' }, { text: 'neighbor' }] });
    const checkpoint = seed.checkpoint(); seed.dispose();
    const storage = await CheckpointStorage.open(indexedDB, databaseName);
    try { await storage.publish(checkpoint, []); } finally { storage.close(); }
    owner = await openEditorStorage({ assetUrl, databaseName, identity: checkpoint.identity, indexedDB, locks: navigator.locks });
    live = owner.engine; patches = []; releases = 0; writable = true; recoveryRequired = false;
    subscription = live.subscribe({ type: 'all' }, patch => patches.push(patch)); live.history({ type: 'clear' });
    access = { scope: { identity: live.read().identity, moduleProfile: 'builtin-v5' }, keyProfile: null };
    store = new WebHistoryStore(); attachRestorer(); old = await store.capture(live, access, 'Before');
    window.fixtureDisposed = false;
  },
  async edit(value = 'current β') { owner.commit(request(owner.engine, value)); await owner.flush({ target: 'local' }); },
  async oracle() {
    await owner.flush({ target: 'local' }); const e = owner.engine;
    return { snapshot: documentState(e), checkpoint: e.checkpoint(), vector: e.stateVector(), update: e.encodeUpdate(),
      history: e.history({ type: 'state' }), generation: e.captureSemantic('builtin-v5').comparison.observedToken,
      patches: structuredClone(patches), disk: await disk(), sameReplica: e === live, releases, texts: text(e) };
  },
  deny(reason) { if (reason === 'recovery') recoveryRequired = true; else writable = false; },
  async unsupported(kind) {
    const e = owner.engine, id = e.read().visible[0].id;
    if (kind === 'opaque') {
      const anchor = e.anchor(id, 0, 'right'), focus = e.anchor(id, text(e)[0].length, 'left');
      try {
        owner.commit({ kind: 'fragment', origin: 'unsupported-fixture', range: { anchor, focus }, blocks: [
          { attributes: { type: 'paragraph' }, runs: [{ text: text(e)[0], marks: [],
            opaqueMarks: [{ key: 'module:vendor-style', value: [1, { tone: 'red' }] }] }] },
        ] });
      } finally { e.releaseAnchor(anchor); e.releaseAnchor(focus); }
      await owner.flush({ target: 'local' }); return;
    }
    const commands = kind === 'structure' ? [{ type: 'setCode', owner: id, language: 'rust' }]
      : [{ type: 'markAt', owner: id, from: 0, to: 1, mark: 'bold', action: 'apply' }];
    owner.commit({ kind: 'editor', origin: 'unsupported-fixture', commands }); await owner.flush({ target: 'local' });
  },
  async reopen() {
    const identity = owner.engine.read().identity; await destroy();
    owner = await openEditorStorage({ assetUrl, databaseName, identity, indexedDB, locks: navigator.locks });
    window.fixtureDisposed = false; return { snapshot: documentState(owner.engine), texts: text(owner.engine) };
  },
  // All adversarial plans are real Rust capabilities, released by their creator.
  async rejectTokens() {
    const e = owner.engine, stale = e.prepare(request(e, 'stale'));
    await this.edit('newer'); let before = await this.oracle(), errors = [];
    const attempt = (label, plan) => { try { owner.commitPrepared(plan); errors.push([label, 'unexpected-success']); } catch (error) { errors.push([label, error.message]); } };
    attempt('stale', stale); e.releasePlan(stale);
    const other = runtime.createEngine({ profile: 'v5', documentId: '99000000-0000-4000-8000-000000000001', epoch: '99000000-0000-4000-8000-000000000002', nodes: [{ text: 'foreign' }] });
    const foreign = other.prepare(request(other, 'foreign edit'));
    try { attempt('foreign', foreign); } finally { other.releasePlan(foreign); other.dispose(); }
    const released = e.prepare(request(e, 'released')); e.releasePlan(released); attempt('released', released);
    const rejected = await this.oracle();
    const plan = e.prepare(request(e, 'accepted')); let admitted, replayBefore, replayAfter;
    try { const admit = owner.commitPrepared; admitted = admit(plan); await owner.flush({ target: 'local' }); replayBefore = await this.oracle(); attempt('replay', plan); replayAfter = await this.oracle(); }
    finally { e.releasePlan(plan); }
    return { before, rejected, errors, admitted, replayBefore, replayAfter };
  },
  async disposedAdmission() {
    const e = owner.engine, plan = e.prepare(request(e, 'forbidden')), admit = owner.commitPrepared;
    e.releasePlan(plan); const before = await disk(); await destroy(); let error;
    try { admit(plan); error = 'unexpected-success'; } catch (e) { error = e.message; }
    return { before, after: await disk(), error };
  },
  get engine() { return owner.engine; }, get owner() { return owner; }, get restorer() { return restorer; }, get old() { return old; },
  get store() { return store; }, get access() { return access; }, destroy,
};
window.inputFixture = { destroy };
