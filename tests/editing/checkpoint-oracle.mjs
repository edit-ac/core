import assert from 'node:assert/strict';
import { assertCheckpoint } from './driver.ts';

/** Falsify source-authored expectations, never snapshots obtained from the engine. */
export function checkedCheckpoint(actual, expected, id, fact, facts) {
  assertCheckpoint(actual, expected);
  fact.checkpoints++;
  const controls = [
    ['content', e => { e.state.blocks[0].text += '?'; }],
    ['identity', e => { e.state.blocks[0].id = 'unbound-corrupt-owner'; }],
    ['marks', e => { e.state.blocks[0].marks.push({ from: 0, to: 1, type: 'italic' }); }],
    ['anchor', e => { e.state.selection.anchor.offset++; }],
    ['focus', e => { e.state.selection.focus.offset++; }],
    ['affinity', e => { e.state.selection.affinity = e.state.selection.affinity === 'forward' ? 'backward' : 'forward'; }],
    ['pending', e => { e.state.pendingMarks = e.state.pendingMarks === null ? [] : null; }],
    ['publication', e => { e.effects.localCommits++; }],
    ['remote', e => { e.effects.remoteCommits++; }],
    ['outcome', e => { e.outcome = 'corrupted'; }],
  ];
  const { anchor, focus } = expected.state.selection;
  if (anchor.block !== focus.block || anchor.offset !== focus.offset) {
    controls.push(['direction', e => { const s = e.state.selection; [s.anchor, s.focus] = [s.focus, s.anchor]; }]);
  }
  for (const [name, corrupt] of controls) {
    const wrong = structuredClone(expected);
    corrupt(wrong);
    assert.throws(() => assertCheckpoint(actual, wrong), assert.AssertionError, `${id}/${name}`);
    facts.negativeControls.push(`${id}/${name}`);
    fact.checkpoints++;
  }
  return actual;
}
