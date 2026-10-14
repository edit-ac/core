import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stateVectorEntries } from './replica-state.mjs';

test('state vector compares every client clock independent of entry order', () => {
  const expected = [{ client: '1', clock: '2' }, { client: '128', clock: '16384' }];
  assert.deepEqual(stateVectorEntries(Uint8Array.from([2, 1, 2, 128, 1, 128, 128, 1])), expected);
  assert.deepEqual(stateVectorEntries(Uint8Array.from([2, 128, 1, 128, 128, 1, 1, 2])), expected);
  for (const bytes of [[2, 1, 3, 128, 1, 128, 128, 1], [2, 2, 2, 128, 1, 128, 128, 1], [1, 1, 2]])
    assert.notDeepEqual(stateVectorEntries(Uint8Array.from(bytes)), expected);
});

test('state vector retains client IDs above the Number precision limit', () => {
  assert.deepEqual(stateVectorEntries(Uint8Array.from([1, 129, 128, 128, 128, 128, 128, 128, 16, 1])), [{ client: '9007199254740993', clock: '1' }]);
});

test('malformed state vectors cannot qualify replay equality', () => {
  for (const bytes of [[], [1], [1, 1], [0, 1], [2, 1, 1, 1, 2], [1, ...Array(10).fill(128)]])
    assert.throws(() => stateVectorEntries(Uint8Array.from(bytes)));
  assert.deepEqual(stateVectorEntries(Uint8Array.from([0])), []);
});
