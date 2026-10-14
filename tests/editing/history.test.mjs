import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSuite, groupIds, capabilityBinding } from './fixture-loader.ts';
import { HistoryDriver, historyProfile } from './history-driver.ts';
import { checkedCheckpoint } from './checkpoint-oracle.mjs';
import { packedRuntime, sha256 } from './packed-runtime.mjs';

const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { group: 'history', profile: historyProfile, fixtureHashes: suite.hashes, cases: [], recipes: [], negativeControls: [], bindings: groupIds('history').map(id => capabilityBinding(suite.recipes.find(r => r.id === id), new Set(historyProfile.capabilities), new Set(historyProfile.actions))), provenance: 'packed production WASM with real native history and two-replica prepared transport; no provider, device, persistence or deployment claim' };
let pack, runtime;
before(async () => { assert.ok(output); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/history-driver.ts', 'tests/editing/history.test.mjs', 'tests/editing/driver.ts', 'tests/editing/semantic-adapter.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/checkpoint-oracle.mjs', 'scripts/editing-suites.mjs', 'scripts/test-editing.mjs', 'crates/editac-core/src/history.rs', 'crates/editac-core/src/commands/text.rs', 'crates/editac-core/src/commands/editor.rs', 'crates/editac-core/tests/history.rs', 'packages/core/src/engine.ts', 'packages/web/src/input/keyboard.ts', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
const selection = (a, f = a, affinity = 'forward') => ({ anchor: { block: 'p1', offset: a }, focus: { block: 'p1', offset: f }, affinity });
const state = (text, a, f = a, affinity = 'forward', marks = []) => ({ blocks: [{ id: 'p1', kind: 'paragraph', text, marks, hardBreaks: [] }], selection: selection(a, f, affinity), pendingMarks: null });
function caseTest(id, run) {
  test(id, () => { const fact = { id, status: 'running', checkpoints: 0, trace: [] }; facts.cases.push(fact); try { run(fact); fact.status = 'passed'; } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; } });
}
function driver(initial, run) { const d = new HistoryDriver(runtime, initial); try { run(d); } finally { d.dispose(); } }
function step(d, action, expected, fact, id, effects = { localCommits: 1, remoteCommits: 0 }) {
  const actual = d.act(action); fact.trace.push({ id, action, actual });
  return checkedCheckpoint(actual, { outcome: action.type === 'setSelection' ? 'selection-only' : 'applied', state: expected, effects }, `${fact.id}/${id}`, fact, facts);
}
for (const id of groupIds('history')) {
  const recipe = suite.recipes.find(r => r.id === id);
  caseTest(id, fact => driver(recipe.initial, d => {
    const receipt = { id, checkpoints: [], status: 'running' }; facts.recipes.push(receipt);
    for (const s of recipe.steps) {
      const actual = checkedCheckpoint(d.act(s.action), s.expect, `${id}/${s.id}`, fact, facts);
      receipt.checkpoints.push({ id: s.id, action: s.action, actual });
    }
    receipt.status = 'passed';
  }));
}
caseTest('REG-01/outer-entry-before-temporary-selection', fact => driver(state('abc', 3), d => {
  const original = d.engine.read().visible;
  step(d, { type: 'outerBold' }, state('abc', 3, 3, 'forward', [{ from: 0, to: 3, type: 'bold' }]), fact, 'nested-bold');
  step(d, { type: 'setSelection', selection: selection(0) }, state('abc', 0, 0, 'forward', [{ from: 0, to: 3, type: 'bold' }]), fact, 'later-navigation', { localCommits: 0, remoteCommits: 0 });
  step(d, { type: 'undo' }, state('abc', 3), fact, 'undo-entry');
  assert.deepEqual(d.engine.read().visible, original);
  step(d, { type: 'redo' }, state('abc', 3, 3, 'forward', [{ from: 0, to: 3, type: 'bold' }]), fact, 'redo-result');
  assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
}));
for (const cut of [false, true]) caseTest(`REG-0${cut ? '3' : '2'}/fixed-zero-clock-typing-${cut ? 'cut' : 'paste'}-typing`, fact => driver(state('', 0), d => {
  step(d, { type: 'insertText', text: 'a', clockMs: 0 }, state('a', 1), fact, 'type-a');
  step(d, { type: 'insertText', text: 'b', clockMs: 0 }, state('ab', 2), fact, 'type-b');
  assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1, 'same-origin typing actually coalesces');
  if (cut) step(d, { type: 'setSelection', selection: selection(1, 2) }, state('ab', 1, 2), fact, 'cut-range', { localCommits: 0, remoteCommits: 0 });
  step(d, { type: cut ? 'cut' : 'pasteText', text: 'X', clockMs: 0 }, state(cut ? 'a' : 'abX', cut ? 1 : 3), fact, 'explicit-boundary');
  step(d, { type: 'insertText', text: 'd', clockMs: 0 }, state(cut ? 'ad' : 'abXd', cut ? 2 : 4), fact, 'type-d');
  assert.equal(d.engine.history({ type: 'state' }).undoGroups, 3);
  for (const [text, a, f] of cut ? [['a', 1, 1], ['ab', 1, 2], ['', 0, 0]] : [['abX', 3, 3], ['ab', 2, 2], ['', 0, 0]]) step(d, { type: 'undo' }, state(text, a, f), fact, `undo-${text}`);
  for (const [text, at] of cut ? [['ab', 2], ['a', 1], ['ad', 2]] : [['ab', 2], ['abX', 3], ['abXd', 4]]) step(d, { type: 'redo' }, state(text, at), fact, `redo-${text}`);
}));
caseTest('G07/actual-merged-paste-fault-is-detected', fact => driver(state('', 0), d => {
  d.act({ type: 'insertText', text: 'a', clockMs: 0 });
  // Deliberate transport fault: paste is wrongly admitted as same-session typing.
  d.act({ type: 'insertText', text: 'X', clockMs: 0 });
  d.act({ type: 'insertText', text: 'd', clockMs: 0 });
  assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
  const actual = d.act({ type: 'undo' });
  assert.throws(() => assert.deepEqual(actual.state, state('aX', 2)), assert.AssertionError);
  assert.deepEqual(actual.state, state('', 0));
  facts.negativeControls.push('G07/actual-merged-paste-group'); fact.checkpoints += 3;
}));
for (const affinity of ['forward', 'backward']) for (const reparent of [false, true]) caseTest(`REG-04/pinned-pending-inverse-reapplied/${affinity}/${reparent ? 'reparent' : 'text'}`, fact => driver(state('123456789ABCD', 12, 5, affinity), d => {
  const original = d.engine.read().visible[0], owner = original.id;
  const remote = runtime.restoreEngine(d.engine.read().identity, d.engine.checkpoint()); let delta;
  try {
    const sub = remote.subscribe({ type: 'updates' }, patch => { if (patch.update) delta = patch.update; });
    step(d, { type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: 5, to: 12, text: '' }], resultSelection: selection(5, 5, affinity) }, state('12345D', 5, 5, affinity), fact, 'pending-local-delete');
    const at = remote.anchor(owner, 13, 'right');
    try { const plan = remote.prepare({ kind: 'text', origin: 'rgs:remote', command: { type: 'insert', at, text: 'E' } }); try { remote.commit(plan); } finally { remote.releasePlan(plan); } } finally { remote.releaseAnchor(at); }
    assert.ok(delta); let remoteEvents = 0; const localSub = d.engine.subscribe({ type: 'updates' }, patch => { assert.equal(patch.operation, 'Remote'); remoteEvents++; });
    try { d.engine.applyUpdate(delta); } finally { localSub.dispose(); }
    assert.equal(remoteEvents, 1); assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
    if (reparent) {
      const plan = remote.prepare({ kind: 'editor', origin: 'rgs:remote-reparent', commands: [{ type: 'wrap', targets: [owner], style: { type: 'unordered' } }] });
      try { remote.commit(plan); } finally { remote.releasePlan(plan); }
      d.engine.applyUpdate(delta);
      const parent = d.engine.read().visible.find(n => n.id === owner).parent;
      assert.equal(d.engine.read().visible.find(n => n.id === parent).kind, 'list');
      fact.remoteParent = parent;
    }
    sub.dispose();
    assert.equal(d.engine.read().visible.find(n => n.id === owner).runs.map(r => r.text).join(''), '12345DE');
    for (let cycle = 0; cycle < 2; cycle++) {
      step(d, { type: 'undo' }, state('123456789ABCDE', 12, 5, affinity), fact, `inverse-${cycle}`);
      step(d, { type: 'redo' }, state('12345DE', 5, 5, affinity), fact, `reapplied-${cycle}`);
      const node = d.engine.read().visible.find(n => n.id === owner);
      assert.equal(node.spans[0].source, original.spans[0].source); assert.equal(node.spans[0].identity, original.spans[0].identity);
      if (reparent) assert.equal(node.parent, fact.remoteParent);
    }
    fact.translation = { upstream: 'prosemirror-history 9bdb3774203d21e3ec14e621eb444524c629b7a3', paragraph: '123456789ABCD', upstreamRange: [6, 13], utf16Range: [5, 12], upstreamInsert: 14, utf16Insert: 13, policy: 'real CRDT pending local deletion; independent remote E; native inverse Undo/reapplied Redo mappings, no ProseMirror numeric offsets in engine' };
  } finally { remote.dispose(); }
}));

caseTest('G07/typing-timeout-origin-session-boundaries', fact => driver(state('', 0), d => {
  const sequence = [
    [{ type: 'insertText', text: 'a', clockMs: 0 }, 'a', 1, 1],
    [{ type: 'insertText', text: 'b', clockMs: 500 }, 'ab', 2, 1],
    [{ type: 'insertText', text: 'c', clockMs: 1001 }, 'abc', 3, 2],
    [{ type: 'insertText', text: 'd', clockMs: 1001, origin: 'rgs:other-origin' }, 'abcd', 4, 3],
    [{ type: 'insertText', text: 'e', clockMs: 1001, origin: 'rgs:other-origin', session: 2 }, 'abcde', 5, 4],
  ];
  for (const [action, text, at, groups] of sequence) {
    step(d, action, state(text, at), fact, text);
    assert.equal(d.engine.history({ type: 'state' }).undoGroups, groups);
  }
  for (const [text, at] of [['abcd', 4], ['abc', 3], ['ab', 2], ['', 0]]) step(d, { type: 'undo' }, state(text, at), fact, `undo-${text}`);
  for (const [text, at] of [['ab', 2], ['abc', 3], ['abcd', 4], ['abcde', 5]]) step(d, { type: 'redo' }, state(text, at), fact, `redo-${text}`);
}));

for (const direction of ['forward', 'backward']) for (const affinity of ['forward', 'backward']) caseTest(`REG-03/production-cut-fragment/${direction}/${affinity}`, fact => driver(state('a', 1), d => {
  const [anchor, focus] = direction === 'forward' ? [1, 2] : [2, 1];
  step(d, { type: 'insertText', text: 'b' }, state('ab', 2), fact, 'type-b');
  step(d, { type: 'setSelection', selection: selection(anchor, focus, affinity) }, state('ab', anchor, focus, affinity), fact, 'range', { localCommits: 0, remoteCommits: 0 });
  step(d, { type: 'pasteFragment', blocks: [{ runs: [], attributes: null }] }, state('a', 1), fact, 'cut-fragment');
  step(d, { type: 'insertText', text: 'd' }, state('ad', 2), fact, 'type-d');
  assert.equal(d.engine.history({ type: 'state' }).undoGroups, 3, 'production fragment cut is an explicit boundary');
  step(d, { type: 'undo' }, state('a', 1), fact, 'undo-d');
  step(d, { type: 'undo' }, state('ab', anchor, focus, affinity), fact, 'undo-cut-entry');
  step(d, { type: 'undo' }, state('a', 1), fact, 'undo-b');
  for (const [text, at] of [['ab', 2], ['a', 1], ['ad', 2]]) step(d, { type: 'redo' }, state(text, at), fact, `redo-${text}`);
}));
