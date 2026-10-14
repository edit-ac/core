import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { init } from '@edit-ac/core';
import { initMarkdown } from '@edit-ac/markdown';
import { runDescriptorFixture, canonicalSemanticJson, projectExtensionNodes } from '@edit-ac/web/modules';
import { registerTutorial, prepareNote, noteCodec, exportFallback } from './tutorial.mjs';
const load = name => readFile(new URL(name, import.meta.url));
const definitions = JSON.parse(await load('definitions.json'));
const corpus = JSON.parse(await load('fixtures/conformance.json'));
const identity = JSON.parse(await load('fixtures/identity.json'));
let runtime, engine, codec;
before(async () => {
  runtime = await init('data:application/wasm;base64,' + (await readFile(new URL(import.meta.resolve('@edit-ac/core/wasm')))).toString('base64'));
  codec = await initMarkdown('data:application/wasm;base64,' + (await readFile(new URL(import.meta.resolve('@edit-ac/markdown/wasm')))).toString('base64'));
  engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(await load('fixtures/custom-checkpoint.bin')) });
});
after(() => { engine?.dispose(); engine?.dispose(); });
for (const fixture of corpus.cases) test('shared descriptor fixture: ' + fixture.id, () => {
  const before = canonicalSemanticJson(fixture);
  assert.equal(runDescriptorFixture(corpus.definitions, fixture).outcome, fixture.expected);
  assert.equal(canonicalSemanticJson(fixture), before);
});
test('tutorial descriptors are the qualified mark and atom', () => {
  assert.deepEqual(definitions, corpus.definitions.filter(d => d.type.startsWith('demo.')));
  const registry = registerTutorial(definitions), before = engine.checkpoint();
  const runs = engine.read().visible.find(n => n.id === 'n:11:1').runs;
  for (const [index, kind] of ['mark', 'inline-atom'].entries()) {
    const key = Object.keys(runs[index].attributes)[0];
    assert.equal(registry.resolve(key, runs[index].attributes[key], runs[index].text).definition.kind, kind);
  }
  assert.deepEqual(engine.checkpoint(), before);
});
test('absent registration/presenters preserves bounded opaque and future data', () => {
  const nodes = engine.read().visible, before = engine.checkpoint();
  assert.deepEqual(projectExtensionNodes(registerTutorial(definitions), nodes), projectExtensionNodes(registerTutorial(definitions, { enabled: false }), nodes));
  const recovery = exportFallback(engine);
  assert.match(recovery.source, /Future version/); assert.match(recovery.source, /<img/);
  assert.equal(recovery.diagnostics[0].code, 'module-markdown-unrepresentable');
  assert.deepEqual(engine.checkpoint(), before);
  const restored = runtime.restoreEngine(identity, recovery.recovery);
  try { assert.deepEqual(restored.read().visible, nodes); } finally { restored.dispose(); }
});
test('source codec is lossless for admitted syntax; literal bypass calls no hook', () => {
  const source = '[note] é😀', parsed = prepareNote(codec, source);
  assert.equal(codec.exportMarkdown(parsed.blocks, { extensions: [noteCodec] }).markdown, source);
  assert.deepEqual(codec.exportMarkdown(parsed.blocks, { extensions: [noteCodec] }).recovery, []);
  const literal = prepareNote(codec, source, true);
  assert.equal(literal.blocks[0].attributes.type, 'paragraph');
  assert.equal(literal.blocks[0].runs[0].text, source);
  assert.throws(() => prepareNote(codec, 'x'.repeat(1048577)), RangeError);
});
test('documented shared corpus is nonempty and complete', () => {
  assert.equal(corpus.cases.length, 44); assert.equal(new Set(corpus.cases.map(c => c.id)).size, 44);
  assert.equal(runtime.createFixture, undefined, 'unchanged production engine');
});
