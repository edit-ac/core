import assert from 'node:assert/strict';
import { assertCheckpoint } from './driver.ts';
import { checkedCheckpoint } from './checkpoint-oracle.mjs';

const select = (offset, block = 'p1') => ({ anchor: { block, offset }, focus: { block, offset }, affinity: 'forward' });
const block = (id, text, kind = 'paragraph') => ({ id, text, kind, hardBreaks: kind === 'paragraph' ? [...text.matchAll(/\n/g)].map(m => m.index) : [], marks: [] });
// The original REG-07 collapsed cases, shared by semantic and storage proofs.
// Expectations are authored here, never taken from the engine's result.
export const collapsedPreCases = [
  { id: 'code', kind: 'code', text: 'xy', offset: 1, texts: ['xA', '\n', 'By'] },
  { id: 'empty-root', kind: 'paragraph', text: '', offset: 0, texts: ['A', '\n', 'B'] },
];
export const collapsedPreInitial = v => ({ blocks: [block('p1', v.text, v.kind)], selection: select(v.offset), pendingMarks: null });

function check(fact, actual, expected) { assert.deepEqual(actual, expected); fact.checkpoints++; }
function control(fact, facts, name, actual, expected, corrupt) {
  const wrong = structuredClone(expected); corrupt(wrong);
  assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
  fact.checkpoints++; fact.controls = (fact.controls ?? 0) + 1;
  facts.negativeControls.push(`${fact.id}/${name}`);
}
export function pasteCollapsedPre(d, v, fact, facts) {
  const original = d.engine.read().visible[0];
  const before = d.frozen();
  const fragment = [
    { attributes: { type: 'code', language: '' }, runs: [{ text: 'A', marks: [] }] },
    { attributes: { type: 'paragraph' }, runs: [{ text: '\n', marks: [] }] },
    { attributes: { type: 'code', language: '' }, runs: [{ text: 'B', marks: [] }] },
  ];
  const actual = d.act({ type: 'pasteFragment', blocks: fragment, newBlockIds: ['p2', 'p3'] });
  const wanted = { outcome: 'applied', effects: { localCommits: 1, remoteCommits: 0 }, state: { blocks: [block('p1', v.texts[0], 'code'), block('p2', '\n'), block('p3', v.texts[2], 'code')], selection: select(1, 'p3'), pendingMarks: null } };
  assertCheckpoint(actual, wanted); fact.checkpoints++;
  check(fact, actual.revision, before.snapshot.revision + 1);
  check(fact, d.engine.history({ type: 'state' }).undoGroups, 1);
  const node = d.engine.read().visible[0];
  for (const [name, observed, expected] of [['owner', node.id, original.id], ['source', node.spans[0].source, original.spans[0].source], ['identity', node.spans[0].identity, original.spans[0].identity]]) {
    check(fact, observed, expected);
    control(fact, facts, `paste-${name}`, { value: observed }, { value: expected }, e => e.value = 'missing');
  }
  for (const [name, corrupt] of [
    ['prefix', e => e.state.blocks[0].text += '!'],
    ['intermediate-whitespace', e => { e.state.blocks[1].text = ''; e.state.blocks[1].hardBreaks = []; }],
    ['suffix', e => e.state.blocks[2].text += '!'],
    ['marks', e => e.state.blocks[0].marks = [{ from: 0, to: 1, type: 'bold' }]],
    ['kind', e => e.state.blocks[2].kind = 'paragraph'],
    ['anchor', e => e.state.selection.anchor.offset = 0],
    ['focus', e => e.state.selection.focus.offset = 0],
    ['affinity', e => e.state.selection.affinity = 'backward'],
    ['pending', e => e.state.pendingMarks = []],
    ['commits', e => e.effects.localCommits = 2],
  ]) {
    const wrong = structuredClone(wanted); corrupt(wrong);
    assert.throws(() => assertCheckpoint(actual, wrong), assert.AssertionError);
    fact.checkpoints++; fact.controls = (fact.controls ?? 0) + 1; facts.negativeControls.push(`${fact.id}/paste-${name}`);
  }
  return { original, before, wanted };
}

// Restore content and selection from the real native entry bookmark.
export function undoCollapsedPre(d, v, fact, facts, { original }) {
  const beforeRevision = d.engine.read().revision;
  checkedCheckpoint(d.act({ type: 'undo' }), { outcome: 'applied', effects: { localCommits: 1, remoteCommits: 0 }, state: collapsedPreInitial(v) }, `${fact.id}/${v.id}/undo-entry`, fact, facts);
  const snapshot = d.engine.read(), restored = snapshot.visible;
  check(fact, restored.length, 1);
  check(fact, restored[0].id, original.id);
  check(fact, restored[0].blockAttributes, original.blockAttributes);
  check(fact, restored[0].runs, original.runs);
  check(fact, restored[0].runs.map(r => r.text).join(''), v.text);
  check(fact, restored[0].spans[0].source, original.spans[0].source);
  check(fact, restored[0].spans[0].identity, original.spans[0].identity);
  check(fact, snapshot.revision, beforeRevision + 1);
  check(fact, d.engine.history({ type: 'state' }).undoGroups, 0);
  check(fact, d.engine.history({ type: 'state' }).redoGroups, 1);
  const content = { count: restored.length, id: restored[0].id, kind: restored[0].blockAttributes, text: v.text, runs: restored[0].runs, source: restored[0].spans[0].source, identity: restored[0].spans[0].identity };
  for (const [name, corrupt] of [
    ['count', e => e.count++], ['owner', e => e.id = 'missing'], ['text', e => e.text += '!'],
    ['kind', e => e.kind = ['invalid']], ['runs', e => e.runs = [{ text: 'missing', attributes: {} }]],
    ['source', e => e.source = 'missing'], ['identity', e => e.identity = 'missing'],
  ]) control(fact, facts, `undo-${name}`, content, content, corrupt);
}
