import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
// Public package export, compiled declarations/runtime; no private source import.
import { AssistiveRegistration, ASSISTIVE_VERSION, ASSISTIVE_PROFILE, ASSISTIVE_CAPABILITIES } from '@edit-ac/core/extensions';
const corpus = JSON.parse(await readFile(new URL('../fixtures/extensions/assistive-input/contract-v1.json',import.meta.url)));
const base = corpus.cases[0].descriptor;
for (const c of corpus.cases) test(`prepared shared assistive contract: ${c.id}`, () => {
  const before = structuredClone(c); const r = new AssistiveRegistration();
  const action = () => {
    if (c.descriptor !== null) r.register(c.descriptor);
    if (c.dispose) r.dispose();
    if (c.operation === 'status') r.validateStatus(c.value);
    else if (c.operation === 'commands') r.validateCommands(c.value);
    else if (c.operation === 'result') r.validateResult(c.value);
    else if (c.operation === 'start') r.validateStart(c.value);
    else assert.equal(c.operation,'register');
  };
  if (c.accepted) action(); else assert.throws(action);
  assert.deepEqual(c,before); r.dispose(); assert(r.signal.aborted);
});
test('public v1 identity is fixed and unknown capabilities stay unsupported', () => {
  assert.equal(ASSISTIVE_VERSION,1); assert.equal(ASSISTIVE_PROFILE,corpus.profile);
  assert.deepEqual(ASSISTIVE_CAPABILITIES,['commands','status','host-transport']);
  const r = new AssistiveRegistration(); assert(!r.supports('status')); r.register(base);
  assert(!r.supports('speech-service')); assert(r.supports('status')); r.dispose(); assert(!r.supports('status'));
});
test('registration snapshots are deeply immutable and failed attempts are atomic', () => {
  const input = structuredClone(base), r = new AssistiveRegistration(); r.register(input);
  const accepted = r.descriptor; input.enabled = false; input.limits.textBytes = 0; input.transport.locality = 'remote';
  assert(r.supports('status')); assert.equal(accepted.limits.textBytes,64); assert.equal(accepted.transport.locality,'unknown');
  for (const v of [accepted,accepted.limits,accepted.capabilities,accepted.transport]) assert(Object.isFrozen(v));
  assert.throws(() => r.register({...base,version:2}),{code:'version'});
  assert.throws(() => r.register(base),{code:'duplicate'}); assert.equal(r.descriptor,accepted);
});
test('executable accessors, functions and nonplain inputs never execute', () => {
  let calls = 0; const r = new AssistiveRegistration(), d = structuredClone(base);
  Object.defineProperty(d,'enabled',{enumerable:true,get() { calls++; return true; }});
  assert.throws(() => r.register(d)); assert.equal(calls,0); assert.equal(r.descriptor,undefined);
  assert.throws(() => r.register({...base,transport:()=>{ calls++; }})); assert.equal(calls,0);
  assert.throws(() => r.register(new Date()));
});
test('disposal aborts once, rejects re-registration and late envelopes', () => {
  const r = new AssistiveRegistration(); r.register(base); let aborted = 0;
  r.signal.addEventListener('abort',()=>aborted++); r.dispose(); r.dispose();
  assert.equal(aborted,1); assert.equal(r.descriptor,undefined);
  assert.throws(() => r.register(base),{code:'disposed'});
  assert.throws(() => r.validateResult(corpus.cases.find(c=>c.id==='valid_final').value),{code:'disposed'});
});
test('status and result snapshots retain only bounded plain data', () => {
  const r = new AssistiveRegistration(); r.register(base);
  const status = r.validateStatus(corpus.cases.find(c=>c.id==='valid_status').value);
  const result = r.validateResult(corpus.cases.find(c=>c.id==='valid_final').value);
  assert(Object.isFrozen(status)); assert(Object.isFrozen(status.session));
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.session));
});
