import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const atomicVectors = JSON.parse(await readFile(new URL('../../fixtures/editing-failures/semantic-vectors.json', import.meta.url))).atomic;
export const storageVectorIds = ['REG-13-invalid-final-selection', 'REG-13-invalid-mark-policy', 'REG-13-staged-offsets', 'G06-astral-staged-utf16', 'G06-invalid-first-surrogate'];
export const atomicInitial = v => ({ blocks: [{ id: 'p1', kind: 'paragraph', text: v.text, marks: [], hardBreaks: [] }], selection: { anchor: { block: 'p1', offset: 0 }, focus: { block: 'p1', offset: 0 }, affinity: 'forward' }, pendingMarks: null });
// A separately authored live observer probe, not a successful retry of invalid policy.
export const atomicProbe = v => ({ id: `${v.id}/live-probe`, text: v.text, commands: [{ type: 'replaceAt', from: 0, to: 0, text: '!' }, { type: 'selectionAt', anchor: 1, focus: 1 }], expectedText: `!${v.text}`, expectedMarks: [], selection: [1, 1], rejected: false });

export function runAtomicVector(d, v, fact, facts) {
  const engine = d.engine, original = engine.read().visible[0], owner = original.id;
  const commands = v.commands.map(c => c.type === 'insertSeparator' ? { type: c.type, beside: owner, side: c.side } : c.type === 'selectionAt'
    ? { type: c.type, anchor: { owner, offset: c.anchor, bias: 'left' }, focus: { owner, offset: c.focus, bias: 'right' } }
    : { ...c, owner: c.owner ?? owner, ...(c.type === 'markAt' ? { action: 'apply' } : {}) });
  const request = { kind: 'editor', origin: 'local:rgs:vector', commands };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    fact.checkpoints++; fact.controls = (fact.controls ?? 0) + 1; facts.negativeControls.push(`${v.id}/${name}`);
  };
  const before = d.frozen(); let events = 0;
  const subscription = engine.subscribe({ type: 'updates' }, () => events++);
  try {
    check(engine.can(request), !v.rejected);
    if (v.rejected) {
      assert.throws(() => engine.prepare(request)); fact.checkpoints++;
      const frozen = d.frozen(); check(frozen, before); check(events, 0);
      for (const [name, corrupt] of [
        ['text', e => e.state.blocks[0].text += '!'], ['marks', e => e.state.blocks[0].marks.push({ from: 0, to: 1, type: 'bold' })],
        ['owner', e => e.snapshot.visible[0].id = 'missing'], ['source', e => e.snapshot.visible[0].spans[0].source = 'missing'],
        ['identity', e => e.snapshot.visible[0].spans[0].identity = 'missing'], ['revision', e => e.snapshot.revision++],
        ['vector', e => e.vector[0] ^= 1], ['checkpoint', e => e.checkpoint[0] ^= 1], ['history', e => e.history.undoGroups++],
        ['anchor', e => e.state.selection.anchor.offset++], ['focus', e => e.state.selection.focus.offset++],
        ['affinity', e => e.state.selection.affinity = 'backward'], ['pending', e => e.state.pendingMarks = []],
      ]) control(`rejection-${name}`, frozen, before, corrupt);
      control('rejection-publications', { events }, { events: 0 }, e => e.events++);
      return;
    }
    const plan = engine.prepare(request);
    try {
      check(d.frozen(), before); check(events, 0);
      const result = engine.commit(plan);
      try {
        check(events, 1); check(result.revision, before.snapshot.revision + 1);
        const history = engine.history({ type: 'state' });
        check({ undoGroups: history.undoGroups, redoGroups: history.redoGroups }, { undoGroups: 1, redoGroups: 0 });
        assert.notDeepEqual([...engine.stateVector()], [...before.vector]); fact.checkpoints++;
        assert.notDeepEqual([...engine.checkpoint().bytes], [...before.checkpoint]); fact.checkpoints++;
        const nodes = engine.read().visible, node = nodes[0];
        check(nodes.length, v.visibleKinds?.length ?? 1);
        check(node.kind, original.kind); check(node.blockAttributes, original.blockAttributes);
        const content = { text: node.runs.map(r => r.text).join(''), units: node.runs.flatMap(r => Array.from({ length: r.text.length }, () => r.attributes)), owner: node.id, source: node.spans[0].source, identity: node.spans[0].identity };
        const expected = { text: v.expectedText, units: Array.from({ length: v.expectedText.length }, (_, offset) => Object.fromEntries(v.expectedMarks.filter(([from, to]) => from <= offset && offset < to).map(([, , type]) => [type, true]))), owner, source: original.spans[0].source, identity: original.spans[0].identity };
        check(content, expected);
        if (v.visibleKinds) check(nodes.map(n => n.blockAttributes[0]), v.visibleKinds);
        for (const [name, corrupt] of [['text', e => e.text += '!'], ['marks', e => e.units[0] = { bold: true }], ['owner', e => e.owner = 'missing'], ['source', e => e.source = 'missing'], ['identity', e => e.identity = 'missing']]) control(name, content, expected, corrupt);
        const endpoints = [result.selection.anchor, result.selection.focus].map(token => engine.resolve(token));
        const wanted = v.selection.map((offset, i) => ({ type: 'position', node: owner, offset, source: original.spans[0].source, sourceOffset: offset, bias: i ? 'right' : 'left' }));
        check(endpoints, wanted);
        for (const i of [0, 1]) {
          control(`endpoint-${i}`, endpoints, wanted, e => e[i].offset++);
          control(`bias-${i}`, endpoints, wanted, e => e[i].bias = i ? 'left' : 'right');
        }
        control('publication', { events }, { events: 1 }, e => e.events++);
        control('revision', { revision: result.revision }, { revision: before.snapshot.revision + 1 }, e => e.revision++);
        control('history', { undoGroups: history.undoGroups, redoGroups: history.redoGroups }, { undoGroups: 1, redoGroups: 0 }, e => e.undoGroups++);
        check(d.snapshot().pendingMarks, null);
        fact.resultEndpoints = endpoints;
      } finally { for (const token of [result.selection?.anchor, result.selection?.focus, result.caret].filter(Boolean)) engine.releaseAnchor(token); }
    } finally { engine.releasePlan(plan); }
  } finally { subscription.dispose(); }
}
