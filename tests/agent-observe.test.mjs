import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostObserve } from '@edit-ac/web/host';
import { fixture, held } from './helpers/agent-observe.mjs';

test('AGT-OBS-01 real shared revision read is bounded metadata through the prepared app MCP', async t => {
  const f = await fixture(t), before = await f.send({ op: 'state' });
  const r = await f.call('observe');
  assert.equal(r.status, 'ok'); assert.equal(r.data.revision, before.revision);
  assert.deepEqual(Object.keys(r.data).sort(), ['changed', 'cursor', 'dataChannel', 'durability', 'resyncRequired', 'revision']);
  assert.equal(r.data.dataChannel, 'collaboration'); assert.equal(r.data.durability, 'not-reported');
  assert.equal((await f.call('observe', { cursor: r.data.cursor })).data.changed, false);
  assert.deepEqual(await f.send({ op: 'state' }), before);
});

test('AGT-OBS-02 subscription negotiation advertises only supported resource operations', async t => {
  const f = await fixture(t);
  const poll = f.connect({ negotiated: { resources: false, subscriptions: true } });
  assert.equal(poll.capabilities.subscriptions, false); assert.equal(f.providers.length, 0);
  assert.equal((await poll.subscribe(f.documentId)).code, 'unsupported');
  assert.equal((await poll.poll(f.documentId)).status, 'ok');
  const readOnlyResources = f.connect({ negotiated: { resources: true, subscriptions: false } });
  assert.equal(f.providers.length, 1); assert.equal(f.providers[0].subscribe, undefined);
  assert.equal((await readOnlyResources.subscribe(f.documentId)).code, 'unsupported');
  const live = f.connect(); assert.equal(live.capabilities.subscriptions, true);
  assert.equal(typeof f.providers[1].subscribe, 'function');
});

test('AGT-OBS-03 shared edit invalidates a resource; notifications contain no content, patch or receipt', async t => {
  const f = await fixture(t), connection = f.connect();
  const initial = await connection.subscribe(f.documentId);
  const receipt = await f.edit(); assert.equal(receipt.data.localDurability, 'durable'); assert.equal(receipt.data.remoteDurability, 'pending');
  f.advance(); await connection.invalidate(f.documentId);
  assert.deepEqual(f.notifications, [{ method: 'notifications/resources/updated', params: { uri: `editac://document/${f.documentId}/revision` } }]);
  f.advance(); const current = await connection.poll(f.documentId, initial.data.cursor);
  assert.equal(current.data.changed, true); assert.equal(current.data.revision, receipt.data.revision);
  assert.equal(current.data.durability, 'not-reported');
  assert.equal((await f.call('receipt', { requestId: 'request-a' })).data.remoteDurability, 'pending');
});

test('AGT-OBS-04 dropped notifications and disconnected clients recover the current revision without replay', async t => {
  const f = await fixture(t), old = f.connect({ notify: async () => { throw Error('dropped'); } });
  const initial = await old.subscribe(f.documentId), vector = await f.send({ op: 'vector' });
  await f.edit('A'); f.advance(); await old.invalidate(f.documentId); old.dispose();
  await f.edit('B', 'request-b');
  const current = await f.connect().poll(f.documentId, initial.data.cursor);
  assert.equal(current.data.changed, true); assert.equal(current.data.resyncRequired, true);
  assert.equal(current.data.revision, (await f.send({ op: 'state' })).revision);
  assert.deepEqual((await f.send({ op: 'state' })).texts, ['BAbase', 'other']);
  const update = await f.send({ op: 'sync', vector }); assert.ok(update.bytes.length > 0);
  assert.equal(current.data.bytes, undefined); assert.equal(current.data.source, undefined);
});

test('AGT-OBS-05 duplicate and reordered hints cannot mutate content, history or promote remote durability', async t => {
  const f = await fixture(t), connection = f.connect(); await connection.subscribe(f.documentId);
  await f.edit(); f.advance(); await connection.invalidate(f.documentId);
  const hint = f.notifications[0], before = await f.send({ op: 'state' });
  f.notifications.push(hint, hint); f.advance(); await connection.invalidate(f.documentId);
  assert.equal(f.notifications.length, 3); assert.deepEqual(await f.send({ op: 'state' }), before);
  assert.equal((await f.call('receipt', { requestId: 'request-a' })).data.remoteDurability, 'pending');
  // An old opaque cursor has no ordering authority: read the owner's current token.
  f.advance(); assert.equal((await connection.poll(f.documentId, 'old-token')).data.revision, before.revision);
});

test('AGT-OBS-06 readonly observes current source while writes remain denied', async t => {
  const f = await fixture(t); await f.policy({ writable: false });
  assert.equal((await f.call('observe')).status, 'ok');
  assert.equal((await f.call('read', { representation: 'source' })).status, 'ok');
  assert.equal((await f.call('apply', { expectedRevision: 'r', proposalId: 'p', requestId: 'id' })).code, 'denied');
});

test('AGT-OBS-07 revocation denies resources, tools and source; subscription is evicted', async t => {
  const f = await fixture(t), c = f.connect(); await c.subscribe(f.documentId);
  await f.policy({ readable: false }); f.advance(); await c.invalidate(f.documentId);
  assert.equal(f.notifications.length, 0); assert.equal(c.retainedDocuments, 0);
  assert.equal((await f.call('observe')).code, 'denied');
  assert.equal((await f.call('read', { representation: 'source' })).code, 'denied');
  assert.deepEqual(await f.providers[0].list(f.documentId), []);
  assert.equal((await c.poll(f.documentId)).code, 'denied');
});

test('AGT-OBS-08 revocation during the real revision read withholds its result and queued notification', async t => {
  const gate = held(), f = await fixture(t, { wrapRevision: gate.wrap }), c = f.connect();
  const pending = c.subscribe(f.documentId); await gate.started;
  await f.policy({ readable: false }); gate.release();
  assert.notEqual((await pending).status, 'ok'); assert.equal(c.retainedDocuments, 0);
  assert.equal(f.notifications.length, 0);
});

test('AGT-OBS-09 actor and epoch changes cannot inherit a prior connection subscription', async t => {
  for (const change of [{ actorId: 'another-actor' }, { epoch: 'another-epoch' }]) {
    const f = await fixture(t), c = f.connect(); await c.subscribe(f.documentId);
    f.identity(change); f.advance(); await c.invalidate(f.documentId);
    assert.equal(f.notifications.length, 0); assert.equal(c.retainedDocuments, 0);
  }
});

test('AGT-OBS-10 host reauthorizes actor and permission changes after an asynchronous observe call', async t => {
  const gate = held(), f = await fixture(t, { wrapRevision: gate.wrap });
  const result = f.call('observe'); await gate.started;
  f.identity({ permissions: ['read'] }); gate.release();
  assert.equal((await result).code, 'denied');
});

test('AGT-OBS-11 fixed-clock polling and notification bursts do bounded work without queues', async t => {
  const f = await fixture(t), c = f.connect(); await c.subscribe(f.documentId);
  const calls = f.revisionCalls;
  const results = await Promise.all(Array.from({ length: 100 }, () => c.poll(f.documentId)));
  assert.ok(results.every(r => r.code === 'rate-limited')); assert.equal(f.revisionCalls, calls);
  await f.edit(); f.advance();
  await Promise.all(Array.from({ length: 100 }, () => c.invalidate(f.documentId)));
  assert.equal(f.revisionCalls, calls + 1); assert.equal(f.notifications.length, 1);
  assert.equal(c.retainedDocuments, 1);
});

test('AGT-OBS-12 expiry, unsubscribe and disposal release retained observation without timers', async t => {
  const f = await fixture(t), c = f.connect({ leaseMs: 1000 });
  await c.subscribe(f.documentId); f.advance(); await c.invalidate(f.documentId);
  assert.equal(c.retainedDocuments, 0); assert.equal(f.notifications.length, 0);
  await c.subscribe(f.documentId); c.unsubscribe(f.documentId); assert.equal(c.retainedDocuments, 0);
  await c.subscribe(f.documentId); c.dispose(); f.advance(); await c.invalidate(f.documentId);
  assert.equal(c.retainedDocuments, 0); assert.equal((await c.poll(f.documentId)).code, 'closed');
  assert.deepEqual(await f.providers[0].list(f.documentId), []);
});

test('AGT-OBS-13 invalid cursors, forged authority and malformed resource paths fail without owner work', async t => {
  const f = await fixture(t), c = f.connect(), before = f.revisionCalls;
  assert.equal((await f.call('observe', { actorId: 'agent-a' })).code, 'invalid-request');
  assert.equal((await f.call('observe', { cursor: 'x'.repeat(513) })).code, 'invalid-request');
  assert.equal((await f.call('observe', {}, 'attacker')).code, 'denied');
  for (const path of ['https://attacker/source', 'editac://document/%ZZ/revision', 'editac://document/a/source']) {
    assert.equal((await f.providers[0].read(path)).code, 'invalid-request');
  }
  assert.equal((await c.poll(f.documentId, '')).code, 'invalid-request');
  assert.equal((await c.poll('other')).code, 'denied'); assert.equal(f.revisionCalls, before);
});

test('AGT-OBS-14 serialized host owner independently rejects forged scope and missing read authority', async t => {
  const f = await fixture(t), before = await f.send({ op: 'state' });
  for (const extra of [{ actorId: 'forged' }, { documentId: 'other' }, { epoch: 'other' }, { permissions: ['observe'] }]) {
    await assert.rejects(f.send({ op: 'observe', access: { ...f.access(), ...extra } }), /Unauthorized/);
  }
  assert.deepEqual(await f.send({ op: 'state' }), before);
});

test('AGT-OBS-15 persistence failure blocks revision reads and sync until ordered recovery', async t => {
  const f = await fixture(t), c = f.connect(); const initial = await c.poll(f.documentId);
  await f.send({ op: 'fail' }); const applied = await f.edit(); assert.equal(applied.data.outcome, 'pending');
  f.advance(); const pending = await c.poll(f.documentId, initial.data.cursor);
  assert.equal(pending.code, 'unavailable');
  await assert.rejects(f.send({ op: 'sync', vector: [] }), /Recovery|Store|Unavailable|Pending/);
  assert.equal((await f.call('receipt', { requestId: 'request-a' })).data.outcome, 'pending');
  await f.send({ op: 'recover' });
  const recovered = await c.poll(f.documentId, initial.data.cursor);
  assert.equal(recovered.data.changed, true); assert.equal(recovered.data.durability, 'not-reported');
  assert.equal((await f.call('receipt', { requestId: 'request-a' })).data.outcome, 'committed');
  assert.equal((await f.call('receipt', { requestId: 'request-a' })).data.remoteDurability, 'pending');
});

test('AGT-OBS-16 adapter rejects oversized or malformed owner revisions without exposing extras', async () => {
  const a = { actorId: 'a', documentId: 'd', epoch: 'e', permissions: ['read', 'observe'], readOnly: true };
  for (const revision of ['', 'x'.repeat(513), { source: 'secret' }]) {
    const service = createHostObserve({ available: () => true, revision: async () => revision });
    await assert.rejects(service.execute({ version: 1, documentId: 'd' }, a), /Invalid shared revision/);
  }
});

test('AGT-OBS-17 per-connection capacity and active reads stay bounded even across lease expiry', async t => {
  const f = await fixture(t), gate = held();
  const c = f.connect({ maxDocuments: 1, leaseMs: 1000,
    authorize: async (_context, id) => ({ ...f.access(), documentId: id }),
    host: { call: async () => gate.wrap(async () => ({ version: 1, status: 'ok', data: { revision: 'r', source: 'must not leak' } })) },
  });
  const first = c.poll('one'); await gate.started;
  assert.equal((await c.poll('two')).code, 'limit');
  f.advance(); assert.equal((await c.poll('two')).code, 'busy');
  gate.release(); assert.equal((await first).code, 'denied');
  const fresh = await c.poll('two'); assert.equal(fresh.status, 'ok'); assert.equal(fresh.data.source, undefined);
  assert.equal(c.retainedDocuments, 1);
});

test('AGT-OBS-18 resource URIs and subscription removal use the negotiated connection boundary', async t => {
  const f = await fixture(t); const c = f.connect(), provider = f.providers[0];
  const [resource] = await provider.list(f.documentId);
  assert.equal((await provider.subscribe(resource.uri)).status, 'ok');
  await f.edit(); f.advance(); await c.invalidate(f.documentId); assert.equal(f.notifications.length, 1);
  provider.unsubscribe(resource.uri); f.advance(); await c.invalidate(f.documentId);
  assert.equal(f.notifications.length, 1); assert.equal(c.retainedDocuments, 0);
  const read = await provider.read(resource.uri); assert.equal(read.data.revision, (await f.send({ op: 'state' })).revision);
});

test('AGT-OBS-19 a stalled notification transport cannot accumulate invalidation work', async t => {
  const f = await fixture(t), gate = held(); let sends = 0;
  const c = f.connect({ notify: async () => { sends++; await gate.wrap(async () => undefined); } });
  await c.subscribe(f.documentId); await f.edit(); f.advance();
  const sending = c.invalidate(f.documentId); await gate.started;
  const reads = f.revisionCalls;
  for (let i = 0; i < 10; i++) { f.advance(); await c.invalidate(f.documentId); }
  assert.equal(sends, 1); assert.equal(f.revisionCalls, reads);
  gate.release(); await sending; c.dispose(); assert.equal(c.retainedDocuments, 0);
});
