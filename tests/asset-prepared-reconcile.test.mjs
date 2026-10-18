import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetSession } from '../packages/web/dist/sync/assets.js';

// Unit boundary only: real adapter reconciliation, prepared EngineHandle replies.
// Rust/SQLite tests prove ownership and recovery; packed browser adoption is PMS-1.3.
const identity = { host: 'fixture', key: 'shared_original' };
const intent = reference => ({ reference, request: { identity, action: 'ingest' } });
const missing = 'node_' + Buffer.from('missing-live-node').toString('hex');
function harness(state) {
  const retired = [], reads = [];
  const engine = { subscribe: () => ({ dispose() {} }), read() { reads.push(true); return { visible: [] }; } };
  // The TS constructor is internal; bypassing IndexedDB isolates the selection rule.
  const session = new AssetSession(engine, { close() {} }, 'prepared-reconcile-unit');
  session.inspect = async () => structuredClone(state);
  session.retire = async (...args) => { retired.push(args); };
  return { session, retired, reads };
}
test('non-live prepared original survives reconcile while deleted live sibling retires', async () => {
  const h = harness({ intents: [intent('prepared_a'), intent(missing)], prepared: [{ reference: 'prepared_a', active: true }] });
  try {
    await h.session.reconcile();
    assert.deepEqual(h.retired, [['missing-live-node', identity, `retire_${missing}`]]);
    assert.equal(h.reads.length, 1);
  } finally { await h.session.dispose('suspend'); }
});
test('retirement fence stays effective for prepared originals without decoding them as node IDs', async () => {
  const reference = 'prepared_a';
  const h = harness({ intents: [intent(reference), { reference, request: { identity, action: 'cancel' } }], prepared: [{ reference, active: false }] });
  try {
    await h.session.reconcile();
    assert.deepEqual(h.retired, []);
    assert.deepEqual(h.reads, []);
  } finally { await h.session.dispose('suspend'); }
});
test('same asset identity without prepared ownership cannot protect a deleted live reference', async () => {
  const h = harness({ intents: [intent(missing)], prepared: [] });
  try {
    await h.session.reconcile();
    assert.deepEqual(h.retired, [['missing-live-node', identity, `retire_${missing}`]]);
  } finally { await h.session.dispose('suspend'); }
});
