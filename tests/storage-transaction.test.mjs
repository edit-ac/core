import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeTransaction, strictTransaction } from '../packages/web/dist/storage/transaction.js';

for (const error of [new TypeError('unsupported'), new DOMException('unsupported', 'NotSupportedError')]) {
  test(`strict durability falls back only for ${error.name}`, () => {
    const calls = [], tx = {};
    const database = { transaction(...args) { calls.push(args); if (calls.length === 1) throw error; return tx; } };
    assert.equal(strictTransaction(database, ['updates', 'receipts']), tx);
    assert.deepEqual(calls, [[['updates', 'receipts'], 'readwrite', { durability: 'strict' }], [['updates', 'receipts'], 'readwrite']]);
  });
}
for (const name of ['QuotaExceededError', 'InvalidStateError', 'SecurityError']) {
  test(`${name} never causes durability fallback`, () => {
    const error = new DOMException('failure', name); let calls = 0;
    assert.throws(() => strictTransaction({ transaction() { calls++; throw error; } }, 'updates'), error);
    assert.equal(calls, 1);
  });
}
test('request success alone does not acknowledge a transaction', async () => {
  const tx = {}, request = { result: 'stored' }; let settled = false, value;
  const pending = completeTransaction(tx, 'aborted', () => value, ({ watch }) => watch(request, result => { value = result; })).then(value => { settled = true; return value; });
  request.onsuccess(); await Promise.resolve(); assert.equal(settled, false);
  tx.oncomplete(); assert.equal(await pending, 'stored');
});
test('request failure survives a later generic transaction error', async () => {
  const requestError = new DOMException('request failed', 'QuotaExceededError');
  const tx = { error: new DOMException('transaction failed', 'AbortError') }, request = { error: requestError };
  const pending = completeTransaction(tx, 'aborted', () => 'false success', ({ watch }) => watch(request));
  request.onerror(); tx.onerror(); tx.onabort(); await assert.rejects(pending, error => error === requestError);
});
test('callback failure aborts and preserves the original error', async () => {
  const error = new Error('collision'), request = { result: 'existing' }; let aborted = false;
  const tx = { abort() { aborted = true; tx.onabort(); } };
  const pending = completeTransaction(tx, 'aborted', () => 'false success', ({ watch }) => watch(request, () => { throw error; }));
  request.onsuccess(); await assert.rejects(pending, error); assert.equal(aborted, true);
});
test('setup failure remains primary even when abort throws', async () => {
  const error = new Error('setup failed'), tx = { abort() { throw new Error('already closed'); } };
  await assert.rejects(completeTransaction(tx, 'aborted', () => 'false success', () => { throw error; }), error);
});
test('missing transaction error produces the adapter AbortError', async () => {
  const tx = {}, pending = completeTransaction(tx, 'Journal read aborted', () => 'false success', () => {});
  tx.onabort(); await assert.rejects(pending, { name: 'AbortError', message: 'Journal read aborted' });
});
