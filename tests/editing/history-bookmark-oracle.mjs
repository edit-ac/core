import assert from 'node:assert/strict';
import { checkedCheckpoint } from './checkpoint-oracle.mjs';

/** Separate fixtures preserve redo proof while testing typing into the undo range. */
export function registerUndoSentinelCases(caseTest, driver, suite, facts) {
  for (const id of ['SEQ-03', 'SEQ-13', 'SEQ-14']) for (const affinity of ['forward', 'backward']) {
    const recipe = suite.recipes.find(r => r.id === id);
    caseTest(`${id}/native-undo-range-sentinel/${affinity}`, fact => {
      const initial = structuredClone(recipe.initial);
      initial.selection.affinity = affinity;
      driver(initial, d => {
        const original = d.engine.read().visible;
        for (const step of recipe.steps) {
          const expected = structuredClone(step.expect);
          // The selected input/result range of Bold and the undo entry use input
          // affinity. Fragment result carets and the explicit move stay right-biased.
          if (step.action.type === 'toggleMark' || step.action.type === 'undo') expected.state.selection.affinity = affinity;
          checkedCheckpoint(d.act(step.action), expected, `${fact.id}/${step.id}`, fact, facts);
          if (step.action.type === 'undo') break;
        }
        assert.deepEqual(d.engine.read().visible, original, 'undo restores complete source/owner identities');
        const expected = {
          outcome: 'applied', effects: { localCommits: 1, remoteCommits: 0 },
          state: {
            blocks: [{ id: 'p1', kind: 'paragraph', text: 'a!d', marks: [], hardBreaks: [] }],
            selection: { anchor: { block: 'p1', offset: 2 }, focus: { block: 'p1', offset: 2 }, affinity },
            pendingMarks: null,
          },
        };
        checkedCheckpoint(d.act({ type: 'insertText', text: '!' }), expected, `${fact.id}/sentinel`, fact, facts);
        assert.equal(d.engine.history({ type: 'state' }).redoGroups, 0, 'new typing consumes the restored range and clears redo');
        assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
        fact.checkpoints += 3;
      });
    });
  }
}
