import assert from 'node:assert/strict';
import { assertRestoredReplica } from './replica-state.mjs';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import { LocalStorageLifecycle } from '../../packages/web/dist/storage/index.js';
import { StorageWriter } from '../../packages/web/dist/storage/writer.js';
import { UpdateJournal } from '../../packages/web/dist/storage/journal.js';
import { PreparedIndexedDB } from '../helpers/journal-storage.mjs';
const all = JSON.parse(await readFile('fixtures/editing-failures/semantic-vectors.json', 'utf8')).atomic;
const vectors = all.filter(v => v.id.startsWith('REG-13-text-mark-structure-'));
const output = process.env.EDITAC_EDITING_OUTPUT, suite = loadSuite();
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C11', guards: ['G02', 'G03', 'G04'], layer: 'packed engine + production storage lifecycle/writer/journal + prepared IndexedDB transport', fixtureHashes: suite.hashes, profile: { ...semanticProfile, persistence: 'production lifecycle, prepared transaction delivery', history: 'default isolated groups; fresh cleared history', clock: 'fixed driver 0' }, cases: [], negativeControls: [], exclusions: ['No real browser storage/device or native gesture evidence', 'No native editor-local pending state', 'No history selection bookmark or unsupported profile qualification'] };
let pack;
const tick = () => new Promise(resolve => setImmediate(resolve));
class Locks {
  held = new Set();
  async request(name, options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
before(async () => { assert.ok(output); assert.equal(vectors.length, 2); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); pack.facts.process.launcher = 'node --test tests/editing/storage-atomicity.test.mjs'; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/storage-atomicity.test.mjs', 'tests/editing/replica-state.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/helpers/journal-storage.mjs', 'tests/editing/packed-runtime.mjs', 'scripts/editing-suites.mjs', 'scripts/test-editing.mjs', 'fixtures/editing-failures/semantic-vectors.json', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`])]) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const pending of [null, [], ['italic']]) test(`REG-13 paired storage rejection/retry pending=${JSON.stringify(pending)}`, async () => {
  const fact = { id: `structure/${JSON.stringify(pending)}`, vectors: vectors.map(v => v.id), status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
  const initial = { blocks: [{ id: 'p1', kind: 'paragraph', text: 'abc', marks: [], hardBreaks: [] }], selection: { anchor: { block: 'p1', offset: 0 }, focus: { block: 'p1', offset: 0 }, affinity: 'forward' }, pendingMarks: pending };
  const seed = new SemanticDriver(pack.runtime, initial), checkpoint = seed.engine.checkpoint(); seed.dispose();
  const locks = new Locks(), db = new PreparedIndexedDB();
  const writer = await StorageWriter.restore(pack.runtime, locks, checkpoint.identity, checkpoint);
  const journal = await UpdateJournal.open(db);
  // Observe the real public append boundary, while retaining its implementation.
  let appends = 0;
  const append = journal.append.bind(journal); journal.append = update => { appends++; return append(update); };
  const lifecycle = new LocalStorageLifecycle(writer, journal);
  const d = new SemanticDriver({ ...pack.runtime, createEngine: () => writer.engine }, initial), engine = writer.engine;
  const publications = [], completions = [];
  const sub = engine.subscribe({ type: 'updates' }, patch => publications.push(patch));
  const stop = lifecycle.subscribeCommitted((update, commit) => completions.push({ update, commit }));
  let result;
  try {
    const before = d.frozen(), original = engine.read().visible[0], owner = original.id;
    const request = v => ({ kind: 'editor', origin: 'local:rgs:structure-storage', commands: v.commands.map(c => c.type === 'insertSeparator' ? { type: c.type, beside: owner, side: c.side } : c.type === 'selectionAt' ? { type: c.type, anchor: { owner, offset: c.anchor, bias: 'left' }, focus: { owner, offset: c.focus, bias: 'right' } } : { ...c, owner, ...(c.type === 'markAt' ? { action: 'apply' } : {}) }) });
    const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
    const falsify = (name, actual, expected, corrupt) => {
      const wrong = structuredClone(expected); corrupt(wrong);
      assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
      fact.controls++; fact.checkpoints++; facts.negativeControls.push(`${fact.id}/${name}`);
    };
    const effects = () => ({ publications: publications.length, appends, transactions: db.transactions.length, records: db.records.size, completions: completions.length, pending: lifecycle.state.pending, saved: lifecycle.state.saved, localCommitted: lifecycle.state.localCommitted });
    const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
    check(effects(), zero);
    assert.equal(engine.can(request(vectors[0])), false);
    assert.throws(() => lifecycle.commit(request(vectors[0])));
    await tick(); // Drain the lifecycle's microtask enqueue window; no fixed sleep.
    check(d.frozen(), before); check(effects(), zero);
    for (const key of Object.keys(zero).filter(k => typeof zero[k] === 'number')) falsify(`rejection-${key}`, effects(), zero, e => e[key]++);
    falsify('rejection-vector', d.frozen(), before, e => e.vector[0] ^= 1);
    falsify('rejection-history', d.frozen(), before, e => e.history.undoGroups++);
    falsify('rejection-pending', d.frozen(), before, e => e.state.pendingMarks = pending === null ? [] : null);
    const valid = request(vectors[1]), plan = engine.prepare(valid);
    try { check(d.frozen(), before); check(effects(), zero); result = lifecycle.commitPrepared(plan); }
    finally { engine.releasePlan(plan); }
    const visible = engine.read().visible, separator = visible[1];
    const separatorIdentity = separator.spans.map(s => ({ source: s.source, identity: s.identity }));
    const projection = () => {
      const current = engine.read().visible, node = current[0], separator = current[1];
      assert.equal(current.length, 2);
      return ({ text: node.runs.map(r => r.text).join(''), runs: node.runs, kinds: current.map(n => n.blockAttributes[0]), identities: node.spans.map(s => ({ source: s.source, identity: s.identity })), owner: node.id, separator: { id: separator.id, kind: separator.kind, runs: separator.runs, identities: separator.spans.map(s => ({ source: s.source, identity: s.identity })) }, revision: engine.read().revision, history: { undoGroups: engine.history({ type: 'state' }).undoGroups, redoGroups: engine.history({ type: 'state' }).redoGroups, revision: engine.history({ type: 'state' }).revision }, endpoints: [result.selection.anchor, result.selection.focus].map(t => { const p = engine.resolve(t); assert.equal(p.type, 'position'); return { node: p.node, offset: p.offset, bias: p.bias }; }), pending: d.pendingMarks }); };
    assert.equal(visible.length, 2); assert.notEqual(separator.id, owner);
    const expected = { text: 'aXbc', runs: [{ text: 'a', attributes: {} }, { text: 'X', attributes: { bold: true } }, { text: 'bc', attributes: {} }], kinds: ['paragraph', 'separator'], identities: original.spans.map(s => ({ source: s.source, identity: s.identity })), owner, separator: { id: separator.id, kind: 'block', runs: [], identities: separatorIdentity }, revision: before.snapshot.revision + 1, history: { undoGroups: 1, redoGroups: 0, revision: before.snapshot.revision + 1 }, endpoints: [{ node: owner, offset: 2, bias: 'left' }, { node: owner, offset: 2, bias: 'right' }], pending };
    check(projection(), expected);
    assert.ok(engine.history({ type: 'state' }).retainedUpdateBytes > 0); fact.checkpoints++;
    assert.notDeepEqual(Buffer.from(engine.stateVector()), before.vector); assert.notDeepEqual(Buffer.from(engine.checkpoint().bytes), before.checkpoint); fact.checkpoints += 2;
    for (const [key, corrupt] of [['text', e => e.text += '!'], ['marks', e => e.runs[1].attributes = {}], ['structure', e => e.kinds.pop()], ['owner', e => e.owner = 'wrong'], ['source', e => e.identities[0].source = 'wrong'], ['identity', e => e.identities[0].identity = 'wrong'], ['anchor', e => e.endpoints[0].offset++], ['focus', e => e.endpoints[1].offset++], ['bias', e => e.endpoints[0].bias = 'right'], ['pending', e => e.pending = pending === null ? [] : null], ['revision', e => e.revision++], ['history', e => e.history.undoGroups++]]) falsify(`retry-${key}`, projection(), expected, corrupt);
    check(publications.map(p => p.operation), ['Editor']);
    const recovery = lifecycle.recoveryExport(); check(recovery.unsavedUpdates.length, 1);
    check(recovery.unsavedUpdates[0].bytes, publications[0].update.bytes);
    // Wait for hashing/transaction creation with a bounded event-driven deadline.
    let deadline;
    const tx = await Promise.race([db.nextTransaction(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('journal transaction deadline')), 5000); })]).finally(() => clearTimeout(deadline));
    check(effects(), { ...zero, publications: 1, appends: 1, transactions: 1, pending: 1 });
    tx.lookupSuccess(); tx.writeSuccess(); await tick();
    const staged = { ...zero, publications: 1, appends: 1, transactions: 1, pending: 1 };
    check(effects(), staged); check(projection(), expected);
    check(lifecycle.state.strictDurability, 'unknown'); // Request success is not transaction completion.
    let flushed = false; const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; }); await tick(); check(flushed, false);
    falsify('staged-records', effects(), staged, e => e.records = 1);
    falsify('staged-completion', effects(), staged, e => e.completions = 1);
    falsify('staged-saved', effects(), staged, e => e.saved = true);
    falsify('separator-identity', projection(), expected, e => e.separator.identities[0].identity = 'wrong');
    tx.complete(); await barrier;
    const committed = { ...zero, publications: 1, appends: 1, transactions: 1, records: 1, completions: 1, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(effects(), committed); check(projection(), expected);
    check(lifecycle.state.strictDurability, 'supported');
    check(tx.entry.checksum, sha256(publications[0].update.bytes));
    check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: publications[0].identity, writerId: publications[0].writerId, sequence: publications[0].sequence, origin: publications[0].origin });
    check(completions[0].commit, committed.localCommitted);
    check(completions[0].update.bytes, publications[0].update.bytes); check(tx.entry.bytes, publications[0].update.bytes);
    check(lifecycle.recoveryExport().unsavedUpdates, []);
    const restored = pack.runtime.restoreEngine(checkpoint.identity, checkpoint, [{ identity: tx.entry.identity, bytes: tx.entry.bytes }]);
    try { const { changedNodes, touchedRanges, ...snapshot } = restored.read(); check(snapshot.visible, engine.read().visible); assertRestoredReplica(restored, engine); fact.checkpoints++; }
    finally { restored.dispose(); }
    for (const key of ['appends', 'transactions', 'records', 'completions', 'pending']) falsify(`complete-${key}`, effects(), committed, e => e[key]++);
    fact.effects = { rejected: zero, staged, committed }; fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally {
    if (result?.selection) for (const token of [result.selection.anchor, result.selection.focus]) engine.releaseAnchor(token);
    stop(); sub.dispose(); const teardown = await lifecycle.destroy({ policy: 'report' }); await tick();
    assert.equal(locks.held.size, 0); assert.equal(db.closed, true); fact.teardown = { unsaved: teardown.unsaved, locks: locks.held.size, journalClosed: db.closed };
  }
});
