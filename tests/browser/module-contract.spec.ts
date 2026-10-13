import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const corpus = JSON.parse(await readFile(new URL('../../fixtures/modules/registration.json', import.meta.url), 'utf8'));
const directory = process.env.EDITAC_MODULE_REGISTRY_FIXTURES;
if (!directory) throw Error('EDITAC_MODULE_REGISTRY_FIXTURES must point to the executed Rust fixture output');
const identity = JSON.parse(await readFile(`${directory}/identity.json`, 'utf8'));
const bytes = [...await readFile(`${directory}/custom-checkpoint.bin`)];
const invalidBytes = [...await readFile(`${directory}/invalid-checkpoint.bin`)];
const { probe } = browserHarness('module-contract');
for (const mode of ['enabled', 'absent-renderers', 'disabled']) {
  test(`${mode}: packed public mount preserves generic mark/atom data and renders text safely`, () => probe(mode, async (page, fact) => {
    const result = await page.evaluate(async ({ corpus, bytes, identity, mode }) => {
      const { init } = await import('@edit-ac/core');
      const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
      const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
      const engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
      const root = document.createElement('div'); document.body.append(root);
      const r = new ModuleRegistry();
      if (mode !== 'disabled') for (const d of corpus.definitions) r.register(d, mode === 'enabled' ? { tag: d.kind === 'mark' ? 'mark' : 'code' } : undefined);
      let surface, restored;
      try {
        const before = [...engine.checkpoint().bytes];
        const initial = engine.read().visible.find(n => n.id === 'n:11:1');
        surface = mountEditorSurface(root, engine, { modules: r, readOnly: true });
        const wrappers = [...root.querySelectorAll('[data-module-type]')].map(e => ({ type: e.dataset.moduleType, tag: e.tagName, fallback: e.dataset.moduleFallback ?? null, editable: e.contentEditable, text: e.textContent }));
        const output = root.querySelector('[data-node-id="n:11:1"]').textContent;
        const unchanged = JSON.stringify(before) === JSON.stringify([...engine.checkpoint().bytes]);
        let frozenRejection = false; try { r.register({ ...corpus.definitions[0], type: 'later.definition' }); } catch { frozenRejection = true; }
        restored = runtime.restoreEngine(identity, engine.checkpoint());
        return { initial, output, wrappers, unchanged, frozen: r.frozen, frozenRejection,
          executable: root.querySelectorAll('img,script,iframe,a').length,
          restored: restored.read().visible.find(n => n.id === 'n:11:1') };
      } finally { restored?.dispose(); surface?.dispose(); engine.dispose(); root.remove(); }
    }, { corpus, bytes, identity, mode });
    fact.snapshots.push(result);
    assert.deepEqual(result.initial.runs, corpus.runs);
    assert.equal(result.output, corpus.runs.map(r => r.text).join(''));
    assert.equal(result.executable, 0); assert.equal(result.unchanged, true);
    assert.equal(result.frozen, true); assert.equal(result.frozenRejection, true);
    assert.deepEqual(result.restored, result.initial);
    assert.equal(result.wrappers.length, 4);
    if (mode === 'enabled') {
      assert.equal(result.wrappers[0].tag, 'MARK'); assert.equal(result.wrappers[1].tag, 'CODE');
      assert.equal(result.wrappers[1].editable, 'false');
      assert.deepEqual(result.wrappers.map(w => w.fallback), [null, null, 'text', 'text']);
    } else assert.ok(result.wrappers.every(w => w.fallback === 'text' && w.tag === 'SPAN'));
  }));
}
test('known malformed attributes reject before mount touches DOM or document', () => probe('invalid-mount', async (page, fact) => {
  const result = await page.evaluate(async ({ corpus, bytes, identity }) => {
    const { init } = await import('@edit-ac/core');
    const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
    const engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); root.textContent = 'Original preview'; document.body.append(root);
    const r = new ModuleRegistry(); for (const d of corpus.definitions) r.register(d);
    let surface;
    try {
      const before = [...engine.checkpoint().bytes]; let error;
      try { surface = mountEditorSurface(root, engine, { modules: r }); } catch (e) { error = e.code; }
      const afterFailure = root.textContent;
      // A failed mount releases surface ownership; disabling interpretation can recover it.
      surface = mountEditorSurface(root, engine, { readOnly: true });
      return { error, afterFailure, unchanged: JSON.stringify(before) === JSON.stringify([...engine.checkpoint().bytes]), recovered: root.textContent };
    } finally { surface?.dispose(); engine.dispose(); root.remove(); }
  }, { corpus, bytes: invalidBytes, identity });
  fact.snapshots.push(result); assert.equal(result.error, 'invalid-content');
  assert.equal(result.afterFailure, 'Original preview'); assert.equal(result.unchanged, true);
  assert.ok(result.recovered.includes(corpus.runs[1].text));
}));
test('real engine edits retain custom attributes and disabled remount retains the changed label', () => probe('patch-roundtrip', async (page, fact) => {
  const result = await page.evaluate(async ({ corpus, bytes, identity }) => {
    const { init } = await import('@edit-ac/core');
    const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
    const engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root); let surface, restored;
    try {
      const r = new ModuleRegistry(); for (const d of corpus.definitions) r.register(d, { tag: d.kind === 'mark' ? 'mark' : 'code' });
      surface = mountEditorSurface(root, engine, { modules: r });
      const original = engine.read().visible.find(n => n.id === 'n:11:1');
      const atom = root.querySelector('[data-module-type="demo.badge"]');
      const request = { kind: 'text', origin: 'module:explicit', command: { type: 'insert', at: engine.anchor(original.id, 1, 'right'), text: '!' } };
      const beforeRevision = engine.read().revision;
      const commit = engine.commit(engine.prepare(request));
      const changed = engine.read().visible.find(n => n.id === original.id);
      const atomRetained = atom === root.querySelector('[data-module-type="demo.badge"]');
      const dom = root.querySelector('[data-node-id="n:11:1"]').textContent;
      surface.dispose(); restored = runtime.restoreEngine(identity, engine.checkpoint());
      surface = mountEditorSurface(root, restored, { readOnly: true });
      return { commit, beforeRevision, original, changed, atomRetained, dom, disabled: root.querySelector('[data-node-id="n:11:1"]').textContent,
        restored: restored.read().visible.find(n => n.id === original.id) };
    } finally { surface?.dispose(); restored?.dispose(); engine.dispose(); root.remove(); }
  }, { corpus, bytes, identity });
  fact.snapshots.push(result); assert.equal(result.commit.revision, result.beforeRevision + 1);
  assert.deepEqual(result.changed.spans.map(s => [s.source, s.identity]), result.original.spans.map(s => [s.source, s.identity]));
  assert.deepEqual(result.changed.runs.map(r => r.attributes), corpus.runs.map(r => r.attributes));
  assert.equal(result.changed.runs[0].text, 'M!arked 😀');
  assert.equal(result.atomRetained, true); assert.equal(result.dom, 'M!arked 😀' + corpus.runs.slice(1).map(r => r.text).join(''));
  assert.equal(result.disabled, result.dom); assert.deepEqual(result.restored, result.changed);
}));
