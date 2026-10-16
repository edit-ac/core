import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectAppendFocus } from '../../../scripts/native-input-evidence.mjs';

// Prepared admission controls only. Actual keyboard/composition remains XCTest.
const valid = () => ({ focusReadiness: {
  requestedAt: 10, keyboardDidShowAt: 12, selectionInstalledAt: 11, readyAt: 13,
  applicationActive: true, sceneActive: true, keyWindow: true,
  inputMode: 'zh-Hans', selectionUtf16: [6, 0],
} });
test('prepared current native focus clocks admit the declared session', () => {
  inspectAppendFocus(valid(), 'zh-Hans', 6);
});
for (const [name, mutate] of [
  ['stale keyboard notification', r => r.keyboardDidShowAt = 9],
  ['stale selection acknowledgment', r => r.selectionInstalledAt = 9],
  ['missing request clock', r => delete r.requestedAt],
  ['inactive application', r => r.applicationActive = false],
  ['inactive scene', r => r.sceneActive = false],
  ['wrong selected input mode', r => r.inputMode = 'en-US'],
]) test('prepared native focus rejects ' + name, () => {
  const value = valid(); mutate(value.focusReadiness);
  assert.throws(() => inspectAppendFocus(value, 'zh-Hans', 6));
});
