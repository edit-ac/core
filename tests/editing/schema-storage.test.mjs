import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { storageHarness, tick } from './storage-harness.mjs';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/schema-rejection-vectors.json', 'utf8'));
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C13', layer: 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB', fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [], profile: { engine: 'v5', policy: 'reject incompatible code/marked paragraph crossing atomically', clock: 'no timed actions; profile seeded and history cleared before storage attachment', persistence: 'actual journal enqueue and local completion; prepared IndexedDB delivery', selection: 'real input tokens, both endpoints, direction and left/right bias' }, exclusions: ['No accepted cross-owner policy', 'No history bookmarks or real-browser/device proof'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.cases.length, 12); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); pack.facts.process.launcher = 'node --test tests/editing/schema-storage.test.mjs'; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/schema-storage.test.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'fixtures/editing-failures/schema-rejection-vectors.json', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'schema-storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
const frozen = e => { const { changedNodes, touchedRanges, ...snapshot } = e.read(); return { snapshot, vector: [...e.stateVector()], checkpoint: [...e.checkpoint().bytes], history: e.history({ type: 'state' }) }; };
for (const [i, v] of vectors.cases.entries()) test(`packed/storage:${v.id}`, async () => {
  const fact = { id: v.id, status: 'running', checkpoints: 0 }; facts.cases.push(fact);
  const initial = {
    blocks: vectors.initial.map((n, index) => ({ id: `p${index + 1}`, kind: n.kind, text: n.text, hardBreaks: [], marks: n.marks.map(([from, to, type]) => ({ from, to, type })) })),
    selection: { anchor: { block: `p${v.endpoints[0] + 1}`, offset: vectors.offset }, focus: { block: `p${v.endpoints[1] + 1}`, offset: vectors.offset }, affinity: v.bias === 'left' ? 'backward' : 'forward' }, pendingMarks: null,
  };
  const storage = await storageHarness(pack.runtime, initial, { attachDriver: false });
  const { engine, lifecycle, publications, db } = storage;
  const tokens = [];
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    facts.negativeControls.push(`${v.id}/${name}`); fact.checkpoints++;
  };
  try {
    const originals = engine.read().visible; const owners = originals.map(n => n.id);
    tokens.push(...v.endpoints.map(index => engine.anchor(owners[index], vectors.offset, v.bias)));
    const before = frozen(engine);
    const semantic = () => engine.read().visible.map(n => ({ owner: n.id, kind: n.blockAttributes[0], text: n.runs.map(r => r.text).join(''), marks: n.runs.map(r => r.attributes), spans: n.spans.map(s => ({ source: s.source, identity: s.identity })) }));
    const expectedSemantic = owners.map((owner, index) => ({ owner, kind: vectors.initial[index].kind, text: vectors.initial[index].text, marks: [index === 1 ? { bold: true } : {}], spans: originals[index].spans.map(s => ({ source: s.source, identity: s.identity })) }));
    const endpoints = () => tokens.map(t => engine.resolve(t));
    const expectedEndpoints = v.endpoints.map(index => ({ type: 'position', node: owners[index], offset: 1, source: originals[index].spans[0].source, sourceOffset: 1, bias: v.bias }));
    const observed = () => ({ semantic: semantic(), endpoints: endpoints(), frozen: frozen(engine), events: publications.map(p => p.operation) });
    const expected = { semantic: expectedSemantic, endpoints: expectedEndpoints, frozen: before, events: [] };
    assert.deepEqual(observed(), expected); fact.checkpoints++;
    const range = { anchor: tokens[0], focus: tokens[1] };
    const request = v.kind === 'format' ? { kind: 'format', origin: 'local:rgs:schema', marks: [{ range, mark: 'bold', action: 'apply' }], blocks: [] } : { kind: 'fragment', origin: 'local:rgs:schema', range, blocks: [{ attributes: null, runs: [{ text: v.kind === 'delete' ? '' : 'X', marks: [] }] }] };
    assert.equal(engine.can(request), false); assert.deepEqual(observed(), expected); fact.checkpoints++;
    // Enter through the production host, which must fail at preparation before
    // any engine commit or journal subscription can observe an update.
    assert.throws(() => lifecycle.commit(request)); assert.deepEqual(observed(), expected); fact.checkpoints++;
    await tick(); await tick();
    check(storage.effects(), zero);
    check(storage.commitCalls, 0); check(storage.resolvedResults, []);
    check(lifecycle.recoveryExport().unsavedUpdates, []);
    check([...lifecycle.recoveryExport().checkpoint.bytes], before.checkpoint);
    await lifecycle.flush({ target: 'local' }); await tick();
    check(storage.effects(), zero); check(observed(), expected);
    fact.rejectedEffects = storage.effects();
    for (const key of ['publications', 'appends', 'transactions', 'records', 'completions', 'pending']) control(`rejection-${key}`, storage.effects(), zero, e => e[key]++);
    control('rejection-local-completion', storage.effects(), zero, e => e.localCommitted = { state: 'localCommitted' });
    control('recovery-update', lifecycle.recoveryExport().unsavedUpdates, [], e => e.push({ bytes: [1] }));
    for (const [name, corrupt] of [
      ['schema', e => e.semantic[0].kind = 'paragraph'], ['suffix', e => e.semantic[1].text = 'c'], ['bold', e => e.semantic[1].marks = [{}]],
      ['owner', e => e.semantic[1].owner = owners[0]], ['source', e => e.semantic[1].spans[0].source = originals[0].spans[0].source],
      ['identity', e => e.semantic[1].spans[0].identity = originals[0].spans[0].identity],
      ['anchor', e => e.endpoints[0].offset++], ['focus', e => e.endpoints[1].offset++],
      ['direction', e => e.endpoints.reverse()], ['bias', e => e.endpoints[0].bias = v.bias === 'left' ? 'right' : 'left'],
      ['source-offset', e => e.endpoints[1].sourceOffset++], ['revision', e => e.frozen.snapshot.revision++],
      ['vector', e => e.frozen.vector.push(255)], ['checkpoint', e => e.frozen.checkpoint.push(255)],
      ['history', e => e.frozen.history.undoGroups++], ['publication', e => e.events.push('Editor')],
    ]) { const wrong = structuredClone(expected); corrupt(wrong); assert.throws(() => assert.deepEqual(observed(), wrong), assert.AssertionError); facts.negativeControls.push(`${v.id}/${name}`); fact.checkpoints++; }
    // A supported same-owner mark change proves this cell's attached storage
    // observations are live. This is a wiring probe, not accepted cross-owner
    // behavior or a substitute for the native rejection matrix.
    const plan = engine.prepare({ kind: 'editor', origin: 'local:rgs:schema-storage-probe', commands: [{ type: 'markAt', owner: owners[1], from: 0, to: 1, mark: 'bold', action: 'remove' }] });
    let result;
    try { result = storage.commit(plan); } finally { engine.releasePlan(plan); }
    for (const token of [result.caret, result.selection?.anchor, result.selection?.focus].filter(Boolean)) engine.releaseAnchor(token);
    const probeSemantic = structuredClone(expectedSemantic); probeSemantic[1].marks = [{}, { bold: true }];
    check(semantic(), probeSemantic);
    check(engine.read().visible[1].runs, [{ text: 'c', attributes: {} }, { text: 'd', attributes: { bold: true } }]);
    check(storage.commitCalls, 1); check(publications.length, 1);
    check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
    const tx = await storage.nextTransaction();
    const staged = { ...zero, publications: 1, appends: 1, transactions: 1, pending: 1 };
    check(storage.effects(), staged);
    tx.lookupSuccess(); tx.writeSuccess(); await tick(); check(storage.effects(), staged);
    let flushed = false;
    const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    await tick(); check(flushed, false);
    control('premature-completion', storage.effects(), staged, e => e.completions++);
    tx.complete(); await barrier;
    const completed = { ...zero, publications: 1, appends: 1, transactions: 1, records: 1, completions: 1, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(storage.effects(), completed); check(semantic(), probeSemantic);
    check(tx.entry.bytes, publications[0].update.bytes); check(tx.entry.checksum, sha256(publications[0].update.bytes));
    check(storage.completions[0].update.bytes, tx.entry.bytes); check(storage.completions[0].commit, completed.localCommitted);
    check([...db.records.values()], [tx.entry]); check(lifecycle.recoveryExport().unsavedUpdates, []);
    const restored = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, [{ identity: tx.entry.identity, bytes: tx.entry.bytes }]);
    try { check(restored.read().visible, engine.read().visible); check(Buffer.from(restored.stateVector()), Buffer.from(engine.stateVector())); }
    finally { restored.dispose(); }
    for (const key of ['appends', 'transactions', 'records', 'completions']) control(`completed-${key}`, storage.effects(), completed, e => e[key]++);
    control('journal-bytes', tx.entry, tx.entry, e => e.bytes[0] ^= 1);
    fact.probeEffects = completed;
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { for (const t of tokens) engine.releaseAnchor(t); fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
});
