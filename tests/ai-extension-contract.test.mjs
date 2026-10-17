import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { AiHost, AI_CAPABILITIES } from '../packages/core/dist/extensions/ai.js';
const corpus = JSON.parse(await readFile(new URL('../fixtures/extensions/ai/contract-v1.json', import.meta.url)));
const base = corpus.cases[0];
const clone = v => structuredClone(v);
const finish = r => ({ version: 1, requestId: r.requestId, sequence: 0, type: 'finish', usage: null });
const collect = async iterable => { const result = []; for await (const e of iterable) result.push(e); return result; };
for (const c of corpus.cases) test(`prepared shared contract: ${c.id}`, async () => {
  let calls = 0;
  const transport = { async *send(r) { calls++; yield finish(r); } };
  const run = async () => {
    const host = new AiHost(c.descriptor ?? undefined, c.transport ? transport : undefined, () => c.policy, () => true);
    for (let i = 0; i < c.prior; i++) await collect(host.send(c.request, new AbortController().signal));
    calls = 0;
    const controller = new AbortController(); if (c.canceled) controller.abort();
    await collect(host.send(c.request, controller.signal));
  };
  if (c.expected === 'ok') await run(); else await assert.rejects(run, e => e.code === c.expected);
  assert.equal(calls, c.expected === 'ok' ? 1 : 0);
});
const host = (transport, d = base.descriptor, reserve = () => true) => new AiHost(d, transport, () => base.policy, reserve);
test('registration declares every initial operation', () => assert.deepEqual(AI_CAPABILITIES, ['ask','fill','continue','rewrite','completion']));
test('host quota absent or denied sends zero requests', async () => {
  let calls = 0; const transport = { async *send(r) { calls++; yield finish(r); } };
  await assert.rejects(collect(host(transport, base.descriptor, () => false).send(base.request, new AbortController().signal)), { code: 'quota' });
  await assert.rejects(collect(new AiHost(base.descriptor, transport, () => base.policy).send(base.request, new AbortController().signal)), { code: 'quota' });
  assert.equal(calls, 0);
});
test('configuration/request are immutable snapshots and extra secret fields reject', async () => {
  const d = clone(base.descriptor); const h = host({ async *send(r) { assert(Object.isFrozen(r)); yield finish(r); } }, d);
  d.limits.requests = 0; d.enabled = false;
  await collect(h.send(base.request, new AbortController().signal));
  await assert.rejects(collect(h.send({ ...base.request, credentials: 'forbidden' }, new AbortController().signal)), { code: 'invalid-request' });
});
test('getters are rejected without execution', () => {
  let called = 0; const d = clone(base.descriptor); Object.defineProperty(d, 'enabled', { enumerable: true, get() { called++; return true; } });
  assert.throws(() => host({}, d)); assert.equal(called, 0);
});
for (const [name, event] of [
  ['wrong version', { ...finish(base.request), version: 2 }],
  ['wrong request', { ...finish(base.request), requestId: 'late' }],
  ['out of order', { ...finish(base.request), sequence: 1 }],
  ['oversized output', { version: 1, requestId: base.request.requestId, sequence: 0, type: 'delta', text: '🧪'.repeat(26) }],
  ['unsafe payload', { ...finish(base.request), script: 'execute' }],
  ['invalid usage', { ...finish(base.request), usage: { inputTokens: -1, outputTokens: 2 } }],
]) test(`rejects ${name}`, async () => {
  await assert.rejects(collect(host({ async *send() { yield event; } }).send(base.request, new AbortController().signal)), { code: 'invalid-response' });
});
test('bounded ordered stream and usage remain ephemeral portable data', async () => {
  const transport = { async *send(r) { yield { version: 1, requestId: r.requestId, sequence: 0, type: 'delta', text: 'שלום 🧪' }; yield { ...finish(r), sequence: 1, usage: { inputTokens: 12, outputTokens: null } }; } };
  const events = await collect(host(transport).send(base.request, new AbortController().signal));
  assert.equal(events.length, 2); assert.equal(events[1].usage.outputTokens, null); assert.equal('cost' in events[1].usage, false);
});
test('caller cancellation reaches transport and settles a stalled request without refund', async () => {
  let signal; const controller = new AbortController();
  const h = host({ send(r, s) { signal = s; return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }; } });
  const result = collect(h.send(base.request, controller.signal));
  controller.abort(); await assert.rejects(result, { code: 'canceled' });
  assert.equal(signal.aborted, true); assert.equal(h.used, 1);
});
test('timeout aborts stalled transport', async () => {
  let signal; const d = clone(base.descriptor); d.limits.timeoutMs = 5;
  const h = host({ send(r, s) { signal = s; return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }; } }, d);
  await assert.rejects(collect(h.send(base.request, new AbortController().signal)), { code: 'timeout' });
  assert.equal(signal.aborted, true);
});
test('host errors are sanitized; no retry; failure keeps reservation', async () => {
  let calls = 0; const h = host({ send() { calls++; throw new Error('private provider data'); } });
  await assert.rejects(collect(h.send(base.request, new AbortController().signal)), e => e.code === 'transport' && !e.message.includes('private'));
  assert.equal(calls, 1); assert.equal(h.used, 1);
});
test('stream requires terminal response; early consumer disposal aborts host', async () => {
  await assert.rejects(collect(host({ async *send() {} }).send(base.request, new AbortController().signal)), { code: 'invalid-response' });
  let signal; const h = host({ async *send(r, s) { signal = s; yield { version: 1, requestId: r.requestId, sequence: 0, type: 'delta', text: 'prepared' }; yield { ...finish(r), sequence: 1 }; } });
  for await (const e of h.send(base.request, new AbortController().signal)) { assert.equal(e.type, 'delta'); break; }
  assert.equal(signal.aborted, true);
});

test('cumulative stream bound and duplicate chunks reject and abort', async () => {
  for (const duplicate of [false, true]) {
    let signal;
    const transport = { async *send(r, s) {
      signal = s;
      yield { version: 1, requestId: r.requestId, sequence: 0, type: 'delta', text: 'a'.repeat(60) };
      yield { version: 1, requestId: r.requestId, sequence: duplicate ? 0 : 1, type: 'delta', text: 'b'.repeat(60) };
    } };
    await assert.rejects(collect(host(transport).send(base.request, new AbortController().signal)), { code: 'invalid-response' });
    assert.equal(signal.aborted, true);
  }
});
test('maximum admitted context/instruction do not exceed descriptor copier budget', async () => {
  const d = clone(base.descriptor); d.limits.contextBytes = 32768; d.limits.instructionBytes = 16384;
  const r = { ...base.request, context: 'a'.repeat(32768), instruction: 'b'.repeat(16384) };
  await collect(host({ async *send(request) { yield finish(request); } }, d).send(r, new AbortController().signal));
});
