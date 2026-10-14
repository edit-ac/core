import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SemanticDriver } from './semantic-adapter.ts';
import { loadSuite } from './fixture-loader.ts';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { stateVectorEntries, assertRestoredReplica } from './replica-state.mjs';
import { boundaries, commandTrace, validTrace, shrink } from './generators/bounded.mjs';

const profilePath = 'fixtures/editing-failures/property-profile.json';
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { gate: 'RGS-1.5', profile, fixtureHashes: loadSuite().hashes, cases: [], provenance: 'packed production WASM and native Rust; prepared deterministic schedules; no browser/device/provider or exhaustive catalog claim' };
let pack, runtime;
before(async () => {
  assert.ok(output, 'EDITAC_EDITING_OUTPUT is required'); await mkdir(output, { recursive: true });
  pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime;
  assert.equal(process.versions.unicode, profile.unicodeVersion); assert.equal(process.version, profile.node);
});
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of [profilePath, 'tests/editing/properties.test.mjs', 'tests/editing/generators/bounded.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/packed-runtime.mjs', 'tests/editing/replica-state.mjs', 'scripts/editing-suites.mjs', 'scripts/test-editing.mjs', 'crates/editac-core/tests/editing_properties.rs', 'crates/editac-core/src/import/tiptap.rs', 'crates/editac-core/src/commands/editor.rs', 'crates/editac-core/src/commands/fragment.rs', 'crates/editac-core/src/commands/text.rs', 'crates/editac-core/src/commands/format.rs', 'crates/editac-core/src/anchors.rs', 'crates/editac-core/src/projection.rs', 'crates/editac-core/src/history.rs', 'crates/editac-core/src/document.rs', 'crates/editac-markdown/tests/editing_properties.rs', 'crates/editac-markdown/src/import.rs', 'crates/editac-markdown/src/export.rs', 'packages/core/src/engine.ts', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.profileSha256 = sha256(await readFile(profilePath));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0, assertions: facts.cases.reduce((n, c) => n + c.assertions, 0) };
  await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
function caseTest(id, run) {
  test(id, async () => {
    const fact = { id, status: 'running', assertions: 0, trace: [] }; facts.cases.push(fact);
    try { await run(fact); fact.status = 'passed'; } catch (error) { fact.status = 'failed'; fact.error = error.stack; throw error; }
    finally { await writeFile(join(output, `${id.replaceAll('/', '-')}.json`), JSON.stringify(fact, null, 2) + '\n'); }
  });
}
const eq = (f, actual, expected, reason) => { f.assertions++; assert.deepEqual(actual, expected, reason); };
const ok = (f, value, reason) => { f.assertions++; assert.ok(value, reason); };
const selection = (a, b = a, backward = false) => ({ anchor: { block: 'p1', offset: a }, focus: { block: 'p1', offset: b }, affinity: backward ? 'backward' : 'forward' });
const initial = () => ({ blocks: [{ id: 'p1', kind: 'paragraph', text: '', marks: [], hardBreaks: [] }], selection: selection(0), pendingMarks: null });
function withDriver(run) { const d = new SemanticDriver(runtime, initial()); try { return run(d); } finally { d.dispose(); } }
function resultRelease(engine, result) { for (const a of new Set([result.caret, result.selection?.anchor, result.selection?.focus].filter(Boolean))) engine.releaseAnchor(a); }
// Reads drain patch-dirty metadata. Freeze semantic/replica/history state, not
// changedNodes/touchedRanges from the preceding read, matching the shared driver.
function frozenEngine(engine, publications) {
  const { changedNodes, touchedRanges, ...snapshot } = engine.read();
  return { snapshot, vector: [...engine.stateVector()], checkpoint: [...engine.checkpoint().bytes], history: engine.history({ type: 'state' }), publications };
}
function commit(engine, commands, origin = 'rgs:property') {
  const before = frozenEngine(engine), plan = engine.prepare({ kind: 'editor', origin, commands });
  assert.deepEqual(frozenEngine(engine), before, 'prepare does not publish');
  try { const r = engine.commit(plan); resultRelease(engine, r); return r; } finally { engine.releasePlan(plan); }
}
function checkAnchors(f, engine, owner, text) {
  for (const offset of boundaries(text)) for (const bias of ['left', 'right']) {
    const a = engine.anchor(owner, offset, bias);
    try { const resolved = engine.resolve(a); eq(f, resolved.type, 'position'); eq(f, [resolved.node, resolved.offset, resolved.bias], [owner, offset, bias]); }
    finally { engine.releaseAnchor(a); }
  }
}
function runCommands(trace, f) { return withDriver(d => {
  const owner = d.ids.get('p1'), original = d.engine.read().visible[0];
  let text = ''; f.samples = trace.length; f.maxUtf16Length = 0;
  for (const [index, op] of trace.entries()) {
    const expected = text.slice(0, op.from) + op.text + text.slice(op.to);
    const endpoints = op.backward ? [expected.length, 0] : [0, expected.length];
    const action = { type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: op.from, to: op.to, text: op.text }, { type: 'applyMark', block: 'p1', from: 0, to: expected.length, mark: 'bold' }], resultSelection: selection(...endpoints, op.backward) };
    const actual = d.act(action); f.trace.push({ index, op, actual });
    eq(f, actual.state, { blocks: [{ id: 'p1', kind: 'paragraph', text: expected, marks: expected.length ? [{ from: 0, to: expected.length, type: 'bold' }] : [], hardBreaks: [] }], selection: action.resultSelection, pendingMarks: null });
    ok(f, ['applied', 'no-op'].includes(actual.outcome)); eq(f, actual.effects.localCommits, actual.outcome === 'applied' ? 1 : 0);
    eq(f, [d.engine.read().visible[0].id, d.engine.read().visible[0].spans.map(s => [s.source, s.identity])], [original.id, original.spans.map(s => [s.source, s.identity])]);
    checkAnchors(f, d.engine, owner, expected);
    const before = d.frozen(); let publications = 0;
    const sub = d.engine.subscribe({ type: 'updates' }, () => publications++);
    try {
      // The valid first edit must not escape final-operation rejection.
      const rejected = d.act({ type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: 0, to: 0, text: 'lost' }, { type: 'applyMark', block: 'p1', from: 0, to: expected.length + 100, mark: 'bold' }] });
      eq(f, rejected.outcome, 'rejected'); eq(f, d.frozen(), before); eq(f, publications, 0);
    } finally { sub.dispose(); }
    const restored = runtime.restoreEngine(d.engine.read().identity, d.engine.checkpoint());
    try { assertRestoredReplica(restored, d.engine); f.assertions += 2; checkAnchors(f, restored, owner, expected); } finally { restored.dispose(); }
    text = expected; f.maxUtf16Length = Math.max(f.maxUtf16Length, text.length);
  }
}); }
for (const seed of profile.seeds) caseTest(`commands/seed-${seed}`, f => {
  const trace = commandTrace(seed, profile); f.seed = seed;
  try { runCommands(trace, f); } catch (error) {
    const fails = candidate => { try { runCommands(candidate, { assertions: 0, trace: [] }); return false; } catch { return true; } };
    try { f.minimized = shrink(trace, fails); } catch (e) { f.shrinkError = e.message; }
    throw error;
  }
});

function textOf(engine) { return engine.read().visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')).join(''); }
const multiset = text => [...text].sort();
for (const seed of profile.seeds) caseTest(`replicas/seed-${seed}`, f => withDriver(d => {
  const owner = d.ids.get('p1'); const checkpoint = d.engine.checkpoint(), identity = d.engine.read().identity;
  const peers = [runtime.restoreEngine(identity, checkpoint), runtime.restoreEngine(identity, checkpoint)], updates = [];
  const retained = peers[0].anchor(owner, 0, 'left');
  const pieces = [profile.vectors[seed % profile.vectors.length], 'L', profile.vectors[(seed + 1) % profile.vectors.length], 'R'];
  try {
    for (const [i, peer] of peers.entries()) {
      const sub = peer.subscribe({ type: 'updates' }, p => { if (p.update) updates.push(p.update); });
      try { for (const piece of pieces.slice(i * 2, i * 2 + 2)) commit(peer, [{ type: 'replaceAt', owner, from: textOf(peer).length, to: textOf(peer).length, text: piece }]); }
      finally { sub.dispose(); }
    }
    eq(f, updates.length, 4); let canonical;
    for (const order of profile.schedules) {
      const receiver = runtime.restoreEngine(identity, checkpoint); const queue = new Set(); let deliveries = 0, deferred = 0;
      let publications = 0; const sub = receiver.subscribe({ type: 'updates' }, () => publications++);
      try {
        for (const index of order) for (let duplicate = 0; duplicate < profile.duplicateFactor; duplicate++) {
          queue.add(index); deliveries++;
          // Production restore merges the durable pending journal before schema
          // admission. Apply its merged delta through the real remote-update port.
          const before = frozenEngine(receiver, publications);
          let staged;
          try {
            if (queue.size === 1) receiver.applyUpdate(updates[index]);
            else {
              staged = runtime.restoreEngine(identity, receiver.checkpoint(), [...queue].map(i => updates[i]));
              receiver.applyUpdate(staged.encodeUpdate(receiver.stateVector()));
            }
            queue.clear();
          } catch (error) {
            ok(f, /IncompleteRestore|UnsupportedSchema/i.test(error.message), error.message);
            eq(f, frozenEngine(receiver, publications), before); deferred++;
          } finally { staged?.dispose(); }

        }
        eq(f, queue.size, 0); eq(f, multiset(textOf(receiver)), multiset(pieces.join('')));
        const actual = { visible: receiver.read().visible, vector: stateVectorEntries(receiver.stateVector()) };
        if (canonical) eq(f, actual, canonical); else canonical = actual;
        checkAnchors(f, receiver, owner, textOf(receiver));
        const restored = runtime.restoreEngine(identity, receiver.checkpoint());
        try { assertRestoredReplica(restored, receiver); f.assertions += 2; } finally { restored.dispose(); }
        // Redelivering every already admitted update is a strict no-op.
        const before = frozenEngine(receiver, publications);
        for (const update of updates) receiver.applyUpdate(update);
        eq(f, frozenEngine(receiver, publications), before);
        f.trace.push({ order, deliveries, deferred, publications, visible: actual.visible });
      } finally { sub.dispose(); receiver.dispose(); }
    }
    // Independent remote content survives undo of local edits; retained anchor resolves.
    const localBefore = textOf(peers[0]);
    for (const update of updates.slice(2)) peers[0].applyUpdate(update);
    eq(f, peers[0].resolve(retained).type, 'position');
    eq(f, peers[0].history({ type: 'state' }).undoGroups, 2);
    for (let i = 0; i < 2; i++) {
      const undo = peers[0].history({ type: 'undo' });
      for (const token of new Set([undo.selection?.anchor, undo.selection?.focus].filter(Boolean))) peers[0].releaseAnchor(token);
    }
    eq(f, multiset(textOf(peers[0])), multiset(pieces.slice(2).join('')));
    eq(f, peers[0].resolve(retained).offset, 0);
    f.samples = profile.schedules.length; f.maxUtf16Length = pieces.join('').length; f.localBefore = localBefore;
  } finally { peers[0].releaseAnchor(retained); peers.forEach(p => p.dispose()); }
}));

function replayFault(trace, corrupt) {
  return withDriver(d => {
    let expected = '';
    for (const op of trace) {
      expected = expected.slice(0, op.from) + op.text + expected.slice(op.to);
      const actual = d.act({ type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: op.from, to: op.to, text: op.text + (corrupt ? '!' : '') }], resultSelection: selection(op.from + op.text.length) });
      assert.equal(actual.state.blocks[0].text, expected, 'injected request corruption must fail independent oracle');
    }
  });
}
caseTest('shrinking/request-corruption', f => {
  const trace = commandTrace(profile.seeds[0], profile);
  const fails = candidate => { try { replayFault(candidate, true); return false; } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; return true; } };
  const minimized = shrink(trace, fails), repeated = shrink(trace, fails);
  eq(f, minimized, repeated); eq(f, minimized.trace.length, 1); eq(f, minimized.trace[0].text, ''); ok(f, validTrace(minimized.trace));
  replayFault(minimized.trace, false); f.assertions++;
  assert.throws(() => replayFault(minimized.trace, true), assert.AssertionError); f.assertions++;
  f.trace = trace; f.minimized = minimized; f.seed = profile.seeds[0];
});
caseTest('sensitivity/content-selection-marks-counts', f => withDriver(d => {
  const actual = d.act({ type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: 0, to: 0, text: '😀' }, { type: 'applyMark', block: 'p1', from: 0, to: 2, mark: 'bold' }], resultSelection: selection(2, 0, true) });
  for (const mutate of [r => r.state.blocks[0].text = 'x', r => r.state.selection.affinity = 'forward', r => r.state.blocks[0].marks = [], r => r.effects.localCommits = 0, r => r.state.pendingMarks = []]) {
    const wrong = structuredClone(actual); mutate(wrong); assert.throws(() => eq(f, actual, wrong), assert.AssertionError); f.assertions++;
  }
  const before = d.frozen();
  const rejected = d.act({ type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: 1, to: 1, text: 'x' }] });
  eq(f, rejected.outcome, 'rejected'); eq(f, d.frozen(), before);
}));
for (const crate of ['editac-core', 'editac-markdown']) caseTest(`native/${crate}`, async f => {
  const args = ['test', '-p', crate, '--test', 'editing_properties', '--locked', '--offline', '--', '--nocapture'];
  const r = spawnSync('cargo', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(output, `native-${crate}.log`), (r.stdout ?? '') + (r.stderr ?? ''));
  f.command = `cargo ${args.join(' ')}`; f.exit = r.status; f.errorCode = r.error?.code;
  eq(f, r.status, 0, `native check failed; inspect native-${crate}.log`);
  const summary = /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(r.stdout);
  ok(f, summary); ok(f, Number(summary[1]) > 0); eq(f, [Number(summary[2]), Number(summary[3])], [0, 0]);
  f.counts = { executed: Number(summary[1]), passed: Number(summary[1]), failed: 0, skipped: 0 };
  f.trace = r.stdout.split('\n').filter(line => line.startsWith('RGS_PROPERTY ')).map(line => JSON.parse(line.slice(13)));
  ok(f, f.trace.length > 0);
});
