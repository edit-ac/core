import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ModuleRegistry, ModuleContractError } from '../packages/web/dist/index.js';
const corpus = JSON.parse(await readFile(new URL('../fixtures/modules/registration.json', import.meta.url)));
const registry = () => { const r = new ModuleRegistry(); for (const d of corpus.definitions) r.register(d); return r; };
const code = expected => e => e instanceof ModuleContractError && e.code === expected;
test('shared descriptor corpus rejects invalid registration atomically', () => {
  const r = registry();
  for (const { definition, name } of corpus.invalidDefinitions) assert.throws(() => r.register(definition), code('invalid-definition'), name);
  assert.equal(r.size, 2);
});
test('duplicate and incompatible definitions reject without replacing a registration', () => {
  const r = registry();
  assert.throws(() => r.register(corpus.definitions[0]), code('duplicate'));
  assert.throws(() => r.register({ ...corpus.definitions[0], version: 2 }), code('incompatible'));
  assert.throws(() => r.register({ ...corpus.definitions[0], kind: 'inline-atom' }), code('incompatible'));
  r.freeze();
  assert.equal(r.resolve('module:demo.highlight', [1, { label: 'original' }], 'x').definition.version, 1);
  assert.equal(r.size, 2);
});
test('registration snapshots data and freezes recursively before mount', () => {
  const input = structuredClone(corpus.definitions[0]); const presentation = { tag: 'mark' };
  const r = new ModuleRegistry().register(input, presentation).freeze();
  input.attributes.label.type = 'number'; presentation.tag = 'script';
  const resolved = r.resolve('module:demo.highlight', [1, { label: 'original' }], 'x');
  assert.equal(resolved.presentation.tag, 'mark');
  assert.equal(resolved.definition.attributes.label.type, 'string');
  assert.throws(() => { resolved.definition.attributes.label.type = 'number'; }, TypeError);
  assert.throws(() => r.register(corpus.definitions[1]), code('frozen'));
  assert.throws(() => new ModuleRegistry().validate([]), code('frozen'));
});
test('getters, functions, cyclic descriptors and unsafe presentation never register', () => {
  const r = new ModuleRegistry(); let invoked = 0;
  const getter = { ...corpus.definitions[0], get execute() { invoked++; return 'script'; } };
  const cyclic = { ...corpus.definitions[0] }; cyclic.fallback = cyclic;
  for (const d of [getter, cyclic, { ...corpus.definitions[0], execute: () => invoked++ }]) assert.throws(() => r.register(d));
  assert.throws(() => r.register(corpus.definitions[0], { tag: 'script' }));
  assert.equal(invoked, 0); assert.equal(r.size, 0);
});
test('known attribute and UTF-16 content bounds reject without changing input', () => {
  const r = registry().freeze();
  for (const run of corpus.invalidRuns) {
    const before = structuredClone(run);
    assert.throws(() => r.validate([{ runs: [run] }]), code('invalid-content'));
    assert.deepEqual(run, before);
  }
  assert.ok(r.resolve('module:demo.badge', [1, { label: '😀'.repeat(64) }], '😀'.repeat(64)));
});
test('unknown, future, disabled and missing renderer retain original envelopes', () => {
  const r = registry().freeze(); const before = structuredClone(corpus.runs);
  r.validate([{ runs: corpus.runs }]); new ModuleRegistry().freeze().validate([{ runs: corpus.runs }]);
  for (const [i, run] of corpus.runs.entries()) for (const [key, value] of Object.entries(run.attributes)) {
    const known = r.resolve(key, value, run.text);
    if (i < 2) { assert.equal(known.definition.kind, i === 0 ? 'mark' : 'inline-atom'); assert.equal(known.presentation, undefined); }
    else assert.equal(known, undefined);
  }
  assert.deepEqual(corpus.runs, before);
});
test('registry has a bounded module count with deterministic overflow rejection', () => {
  const r = new ModuleRegistry();
  for (let i = 0; i < 256; i++) r.register({ ...corpus.definitions[0], type: `many.m${i}` });
  assert.throws(() => r.register({ ...corpus.definitions[0], type: 'many.overflow' }), code('resource-limit'));
  assert.equal(r.size, 256);
});
