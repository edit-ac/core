import assert from 'node:assert/strict';
import { assertCheckpoint } from './driver.ts';
import { checkedCheckpoint } from './checkpoint-oracle.mjs';
const selection = (block, offset, affinity) => ({ anchor: { block, offset }, focus: { block, offset }, affinity });
const block = (id, text, kind = 'paragraph', marks = []) => ({ id, text, kind, marks, hardBreaks: [] });
const bold = (from, to) => [{ from, to, type: 'bold' }];
const expected = (blocks, caret, pendingMarks, outcome = 'applied', localCommits = 1) => ({ outcome, state: { blocks, selection: caret, pendingMarks }, effects: { localCommits, remoteCommits: 0 } });
/** Original source-authored REG-05 variants; no engine output supplies expectations. */
export function registerAlignmentPendingCases(caseTest, driver, facts) {
  for (const affinity of ['forward', 'backward']) caseTest(`REG-05 atomic separator/text/mark/${affinity}`, fact => {
    const initial = [block('rule', '', 'separator'), block('p1', 'a', 'paragraph', bold(0, 1))];
    const at = selection('p1', 0, affinity), result = selection('p1', 1, affinity);
    return driver({ blocks: initial, selection: at, pendingMarks: null }, d => {
      const check = (actual, wanted) => checkedCheckpoint(actual, wanted, `${fact.id}/${fact.checkpoints}`, fact, facts);
      const original = d.engine.read().visible.map(n => ({ id: n.id, sources: n.spans.map(s => s.source) }));
      check(d.act({ type: 'applyBatch', operations: [{ type: 'deleteSeparator', block: 'rule' }, { type: 'setAlignment', block: 'p1', alignment: 'left' }, { type: 'insertText', block: 'p1', offset: 0, text: 'X' }, { type: 'applyMark', block: 'p1', from: 0, to: 1, mark: 'bold' }], resultSelection: result }), expected([block('p1', 'Xa', 'paragraph', bold(0, 2))], result, null));
      assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1); fact.checkpoints++;
      check(d.act({ type: 'undo' }), expected(initial, at, null));
      assert.deepEqual(d.engine.read().visible.map(n => ({ id: n.id, sources: n.spans.map(s => s.source) })), original); fact.checkpoints++;
      check(d.act({ type: 'redo' }), expected([block('p1', 'Xa', 'paragraph', bold(0, 2))], result, null));
      check(d.act({ type: 'insertText', text: 'S' }), expected([block('p1', 'XSa', 'paragraph', bold(0, 3))], selection('p1', 2, affinity), null));
    });
  });
  for (const affinity of ['forward', 'backward']) for (const pending of [null, [], ['bold']]) for (const atom of [false, true]) {
    const initialBlocks = [...(atom ? [block('rule', '', 'separator')] : []), block('p1', 'a', 'paragraph', bold(0, 1)), block('p2', '')];
    const at = selection('p1', 0, affinity), name = pending === null ? 'derived' : pending.length ? 'bold' : 'empty';
    caseTest(`REG-05 ${atom ? 'preceding-separator' : 'align-left'}/${name}/${affinity}`, fact => driver({ blocks: initialBlocks, selection: at, pendingMarks: null }, d => {
      const check = (actual, wanted) => checkedCheckpoint(actual, wanted, `${fact.id}/${fact.checkpoints}`, fact, facts);
      if (pending !== null) {
        const beforeToggle = d.frozen();
        check(d.act({ type: 'toggleMark', mark: 'bold' }), expected(initialBlocks, at, [], 'selection-only', 0));
        if (pending.length) check(d.act({ type: 'toggleMark', mark: 'bold' }), expected(initialBlocks, at, ['bold'], 'selection-only', 0));
        const afterToggle = d.frozen();
        for (const key of ['snapshot', 'vector', 'checkpoint', 'history']) assert.deepEqual(afterToggle[key], beforeToggle[key]);
        fact.checkpoints++;
      }
      const entry = d.engine.read().visible.find(n => n.id === d.ids.get('p1'));
      const before = d.frozen();
      const kept = initialBlocks.filter(b => b.id !== 'rule');
      check(d.act(atom ? { type: 'deleteSeparator', block: 'rule' } : { type: 'setAlignment', alignment: 'left' }), expected(kept, at, pending, atom ? 'applied' : 'no-op', atom ? 1 : 0));
      if (!atom) { assert.deepEqual(d.frozen(), before, 'already-left is a true zero-effect action'); fact.checkpoints++; }
      const allowed = pending === null || pending.length > 0;
      const typedBlocks = [block('p1', 'Xa', 'paragraph', bold(allowed ? 0 : 1, 2)), block('p2', '')];
      const result = selection('p1', 1, affinity);
      const typedExpected = expected(typedBlocks, result, pending);
      const typed = check(d.act({ type: 'insertText', text: 'X' }), typedExpected);
      const owner = d.engine.read().visible.find(n => n.id === entry.id);
      assert.deepEqual(owner.spans.map(s => s.source), entry.spans.map(s => s.source)); fact.checkpoints++;
      check(d.act({ type: 'undo' }), expected(kept, at, null));
      if (atom) {
        check(d.act({ type: 'undo' }), expected(initialBlocks, at, null));
        check(d.act({ type: 'redo' }), expected(kept, at, null));
      }
      check(d.act({ type: 'redo' }), expected(typedBlocks, result, null));
      const sentinelBold = allowed || affinity === 'forward';
      check(d.act({ type: 'insertText', text: 'S' }), expected([block('p1', 'XSa', 'paragraph', bold(allowed ? 0 : sentinelBold ? 1 : 2, 3)), block('p2', '')], selection('p1', 2, affinity), null));
      // Independent corruption controls establish G02/G03/G04 sensitivity.
      for (const [guard, corrupt] of [['G04', e => e.state.pendingMarks = ['italic']], ['G03', e => e.state.selection.focus.offset = 0], ['G02', e => e.effects.localCommits = 2], ['marks', e => e.state.blocks[0].marks = []]]) {
        const wrong = structuredClone(typedExpected); corrupt(wrong); assert.throws(() => assertCheckpoint(typed, wrong), assert.AssertionError); facts.negativeControls.push(`${guard}/${name}/${affinity}/${atom}`); fact.checkpoints++;
      }
    }));
  }
  for (const atom of [false, true]) caseTest(`REG-05 ${atom ? 'separator' : 'alignment'} move-away/back context and atomic rejection`, fact => driver({ blocks: [...(atom ? [block('rule', '', 'separator')] : []), block('p1', 'a', 'paragraph', bold(0, 1)), block('p2', '')], selection: selection('p1', 0, 'forward'), pendingMarks: [] }, d => {
    const check = (actual, wanted) => checkedCheckpoint(actual, wanted, `${fact.id}/${fact.checkpoints}`, fact, facts);
    const before = d.frozen();
    const bad = { type: 'applyBatch', operations: [{ type: 'insertText', block: 'p1', offset: 0, text: 'BAD' }, ...(atom ? [{ type: 'deleteSeparator', block: 'rule' }] : []), { type: 'setAlignment', block: 'missing', alignment: 'left' }] };
    assert.equal(d.act(bad).outcome, 'rejected'); assert.deepEqual(d.frozen(), before); fact.checkpoints++;
    for (const alignment of ['center', 'right', 'justify']) { assert.equal(d.act({ type: 'setAlignment', alignment }).outcome, 'rejected'); assert.deepEqual(d.frozen(), before); fact.checkpoints++; }
    if (atom) { assert.equal(d.act({ type: 'setAlignment', block: 'rule', alignment: 'left' }).outcome, 'rejected'); assert.deepEqual(d.frozen(), before); fact.checkpoints++; }
    const kept = before.state.blocks.filter(b => b.id !== 'rule');
    check(d.act(atom ? { type: 'deleteSeparator', block: 'rule' } : { type: 'setAlignment', alignment: 'left' }), expected(kept, selection('p1', 0, 'forward'), [], atom ? 'applied' : 'no-op', atom ? 1 : 0));
    check(d.act({ type: 'setSelection', selection: selection('p2', 0, 'forward') }), expected(kept, selection('p2', 0, 'forward'), null, 'selection-only', 0));
    check(d.act({ type: 'insertText', text: '!' }), expected([kept[0], block('p2', '!')], selection('p2', 1, 'forward'), null));
    check(d.act({ type: 'setSelection', selection: selection('p1', 0, 'forward') }), expected([kept[0], block('p2', '!')], selection('p1', 0, 'forward'), null, 'selection-only', 0));
    check(d.act({ type: 'insertText', text: 'X' }), expected([block('p1', 'Xa', 'paragraph', bold(0, 2)), block('p2', '!')], selection('p1', 1, 'forward'), null));
  }));
}
