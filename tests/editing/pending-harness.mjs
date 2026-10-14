import assert from 'node:assert/strict';

// Shared independent oracle for the two existing C10 sequences. Neither caller
// supplies expected snapshots; the immutable vector checkpoints remain authority.
export async function assertPendingSequence(d, committed, publications, v, fact, facts, afterStep = async () => {}) {
  const engine = d.engine;
  const initial = d.frozen(), identities = new Map();
  const capture = alias => {
    const node = engine.read().visible.find(n => n.id === d.ids.get(alias)); assert.ok(node);
    return { owner: node.id, spans: node.spans.map(s => ({ source: s.source, identity: s.identity })) };
  };
  for (const b of v.initial.blocks) identities.set(b.id, capture(b.id));
  let count = 0;
  for (const step of v.steps) {
    const before = d.frozen(), priorCount = count, priorResultCount = committed().length;
    const actual = d.act(step.action), delta = step.expect.effects.localCommits; count += delta;
    const expected = { ...step.expect, revision: initial.snapshot.revision + count };
    assert.deepEqual(actual, expected); fact.checkpoints++;
    if (step.action.type === 'insertParagraph') {
      const last = committed().at(-1); assert.ok(last.caret); assert.equal(last.caret.node, d.ids.get(step.action.newBlockId));
      assert.ok(![...identities.values()].some(i => i.owner === last.caret.node));
      const retained = identities.get(step.action.newBlockId === 'p2' ? 'p1' : 'missing');
      const splitOwner = capture('p1');
      assert.equal(splitOwner.owner, retained.owner);
      assert.equal(splitOwner.spans.length, retained.spans.length + 2, 'paragraph split retains source plus two structural spans');
      assert.deepEqual(splitOwner.spans.slice(0, retained.spans.length), retained.spans);
      assert.equal(new Set(splitOwner.spans.map(s => s.identity)).size, splitOwner.spans.length);
      identities.set('p1', splitOwner); // Bind new structural identities at their creating operation.
      identities.set(step.action.newBlockId, capture(step.action.newBlockId)); fact.checkpoints++;
    }
    const observation = () => ({
      identities: expected.state.blocks.map(b => capture(b.id)),
      revision: engine.read().revision, commits: committed().length, publications: [...publications()],
      undo: engine.history({ type: 'state' }).undoGroups, redo: engine.history({ type: 'state' }).redoGroups,
    });
    const expectedObservation = { identities: expected.state.blocks.map(b => identities.get(b.id)), revision: expected.revision, commits: count, publications: Array(count).fill('Editor'), undo: count, redo: 0 };
    assert.deepEqual(observation(), expectedObservation); fact.checkpoints++;
    if (!delta) {
      const frozen = d.frozen();
      // Only the adapter's selection/pending fields can differ.
      assert.deepEqual({ ...frozen, state: before.state }, before); fact.checkpoints++;
      assert.equal(committed().length, priorResultCount); assert.equal(publications().length, priorCount);
    } else {
      assert.notDeepEqual(Buffer.from(engine.stateVector()), before.vector);
      assert.notDeepEqual(Buffer.from(engine.checkpoint().bytes), before.checkpoint); fact.checkpoints++;
      const result = committed().at(-1), s = expected.state.selection;
      const points = [s.anchor, s.focus].map(p => ({ node: d.ids.get(p.block), offset: p.offset, bias: s.affinity === 'backward' ? 'left' : 'right' }));
      if (step.native.type === 'split') {
        assert.deepEqual(result.caret, points[0]); assert.deepEqual(s.anchor, s.focus);
        assert.equal(result.endpoints, null); // Fragment contract returns a caret, not a range.
      } else assert.deepEqual(result.endpoints, points);
      fact.checkpoints++;
    }
    const falsify = (name, value, observe, corrupt) => {
      const wrong = structuredClone(value); corrupt(wrong);
      assert.throws(() => assert.deepEqual(observe(), wrong), assert.AssertionError);
      facts.negativeControls.push(`${v.id}/${step.id}/${name}`); fact.controls++; fact.checkpoints++;
    };
    for (const [name, corrupt] of [
      ['content', e => e.state.blocks[0].text += '!'], ['marks', e => e.state.blocks[0].marks = [{ from: 0, to: 1, type: 'italic' }]],
      ['pending', e => e.state.pendingMarks = e.state.pendingMarks === null ? [] : null],
      ['anchor', e => e.state.selection.anchor.offset++], ['focus', e => e.state.selection.focus.offset++],
      ['affinity', e => e.state.selection.affinity = e.state.selection.affinity === 'forward' ? 'backward' : 'forward'],
      ['effects', e => e.effects.localCommits++], ['revision', e => e.revision++],
    ]) falsify(name, expected, () => actual, corrupt);
    for (const [name, corrupt] of [
      ['owner', e => e.identities[0].owner = 'missing'], ['source', e => e.identities[0].spans[0].source = 'missing'],
      ['identity', e => e.identities[0].spans[0].identity = 'missing'], ['commit', e => e.commits++],
      ['publication', e => e.publications.push('Editor')], ['undo', e => e.undo++], ['redo', e => e.redo++],
    ]) falsify(name, expectedObservation, observation, corrupt);
    if (!delta) for (const [name, corrupt] of [['vector', e => e.vector[0] ^= 1], ['checkpoint', e => e.checkpoint[0] ^= 1], ['history', e => e.history.undoGroups++]]) {
      const frozen = d.frozen(); falsify(`zero-${name}`, frozen, () => d.frozen(), corrupt);
    }
    else {
      const result = committed().at(-1);
      falsify('prepared-offset', result, () => committed().at(-1), e => (e.endpoints?.[1] ?? e.caret).offset++);
      falsify('prepared-bias', result, () => committed().at(-1), e => { const p = e.endpoints?.[0] ?? e.caret; p.bias = p.bias === 'left' ? 'right' : 'left'; });
    }
    await afterStep({ step, before, actual, expected, count });
    fact.steps.push({ id: step.id, outcome: actual.outcome, revision: actual.revision, effects: actual.effects, native: step.native ? step.native.type === 'split' ? 'fragment split caret' : 'ordered replace/mark + final selectionAt' : 'editor-local only; no native pending claim' });
  }
}
