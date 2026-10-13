import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { browserHarness } from './browser-harness.ts';
const directory = new URL('../../../architecture/evidence/modules-registration/', import.meta.url);
const identity = JSON.parse(await readFile(new URL('identity.json', directory), 'utf8'));
const bytes = [...await readFile(new URL('custom-checkpoint.bin', directory))];
const corpus = JSON.parse(await readFile(new URL('../../fixtures/modules/registration.json', import.meta.url), 'utf8'));
const { probe } = browserHarness('module-runtime');
test('packed real engine scopes local/remote edits and native selection while retaining stable atom views', () => probe('scope-stability-disposal', async (page, fact) => {
  const result = await page.evaluate(async ({ identity, bytes, corpus }) => {
    const { init } = await import('@edit-ac/core'); const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const wasm = await init('/core/wasm/editac_wasm_bg.wasm');
    const engine = wasm.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const peer = wasm.restoreEngine(identity, { identity, initialized: true, writerId: 12, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root);
    const counts = { mount: 0, update: 0, dispose: 0, resources: 0, scoped: 0, selection: 0, good: 0, ownedEvents: 0 };
    const elements = []; let surface;
    const insert = (e, id, offset, text) => { const a = e.anchor(id, offset, 'right'); try { e.commit(e.prepare({ kind: 'text', origin: 'module-runtime:fixture', command: { type: 'insert', at: a, text } })); } finally { e.releaseAnchor(a); } };
    try {
      const registry = new ModuleRegistry(); for (const d of corpus.definitions) registry.register(d, { tag: d.kind === 'mark' ? 'mark' : 'code' });
      surface = mountEditorSurface(root, engine, { modules: registry, moduleRuntime: { renderers: { 'demo.badge': { mount(element, content) {
        counts.mount++; counts.resources++; elements.push(element); element.title = content.text;
        const callback = () => counts.ownedEvents++; element.addEventListener('probe', callback);
        const timer = setInterval(() => {}, 60000);
        return { update(next) { counts.update++; element.title = next.text; if (!Object.isFrozen(next.attributes)) throw Error('mutable content'); }, dispose() { counts.dispose++; counts.resources--; clearInterval(timer); element.removeEventListener('probe', callback); } };
      } } } } });
      const moduleRuntime = surface.moduleRuntime;
      const original = engine.read().visible.find(n => n.id === 'n:11:1');
      const atom = root.querySelector('[data-module-type="demo.badge"]'); const projectedText = root.querySelector('[data-node-id="n:11:1"]').textContent;
      const scoped = moduleRuntime.subscribe({ kinds: ['Text', 'Remote'], range: { source: original.spans[0].source, start: original.spans[0].start, end: original.spans[0].end } }, () => counts.scoped++);
      const select = moduleRuntime.subscribe({ kinds: [], selection: true }, () => counts.selection++);
      moduleRuntime.subscribe({ kinds: ['Text'] }, () => { throw Error('one module failed'); });
      moduleRuntime.subscribe({ kinds: ['Text'] }, () => counts.good++);
      insert(engine, 'n:11:2', 1, 'local');
      insert(peer, 'n:11:2', 1, 'remote'); engine.applyUpdate(peer.encodeUpdate(engine.stateVector()));
      const afterUnrelated = { ...counts };
      // Exercise the real DOMSelection bridge, not a prepared selection patch.
      const text = root.querySelector('[data-module-type="demo.highlight"]').lastChild;
      root.focus(); document.getSelection().setBaseAndExtent(text, 1, text, 1); document.dispatchEvent(new Event('selectionchange'));
      document.getSelection().setBaseAndExtent(text, 2, text, 2); document.dispatchEvent(new Event('selectionchange'));
      const afterSelection = { ...counts }; const retainedSelection = atom === root.querySelector('[data-module-type="demo.badge"]');
      const atomOffset = original.runs[0].text.length + 1;
      insert(engine, original.id, atomOffset, '!');
      const changed = engine.read().visible.find(n => n.id === original.id);
      const afterEdit = { ...counts }; const retainedEdit = atom === root.querySelector('[data-module-type="demo.badge"]');
      const dom = root.querySelector('[data-node-id="n:11:1"]').textContent;
      const errors = moduleRuntime.takeErrors(); const engineErrors = engine.takeObserverErrors();
      select.dispose(); scoped.dispose(); surface.dispose(); surface.dispose();
      for (const element of elements) element.dispatchEvent(new Event('probe'));
      const afterDispose = { ...counts };
      insert(engine, 'n:11:2', 0, 'after');
      return { decorationReleased: elements.every(e => !e.isConnected), original, changed, projectedText, dom, afterUnrelated, afterSelection, afterEdit, afterDispose, afterLaterCommit: { ...counts }, retainedSelection, retainedEdit, errors, engineErrors, active: moduleRuntime.active };
    } finally { surface?.dispose(); peer.dispose(); engine.dispose(); root.remove(); }
  }, { identity, bytes, corpus });
  fact.snapshots.push(result);
  assert.equal(result.afterUnrelated.scoped, 0); assert.equal(result.afterUnrelated.update, 0); assert.equal(result.afterUnrelated.mount, 1);
  assert.equal(result.afterSelection.selection, 2); assert.equal(result.afterSelection.update, 0); assert.equal(result.retainedSelection, true);
  assert.equal(result.afterEdit.scoped, 1); assert.equal(result.afterEdit.update, 1); assert.equal(result.afterEdit.mount, 1); assert.equal(result.retainedEdit, true);
  assert.equal(result.afterEdit.good, 2); assert.equal(result.errors.length, 2); assert.ok(result.errors.every(e => e.phase === 'subscription'));
  assert.deepEqual(result.engineErrors, []); assert.equal(result.dom, result.changed.runs.map(r => r.text).join(''));
  assert.deepEqual(result.changed.runs.map(r => r.attributes), corpus.runs.map(r => r.attributes));
  assert.equal(result.changed.runs[1].text, corpus.runs[1].text.slice(0, 1) + '!' + corpus.runs[1].text.slice(1));
  assert.equal(result.decorationReleased, true); assert.equal(result.afterDispose.dispose, 1); assert.equal(result.afterDispose.resources, 0); assert.equal(result.afterDispose.ownedEvents, 0);
  assert.deepEqual(result.afterLaterCommit, result.afterDispose); assert.equal(result.active, false);
}));
for (const failure of ['mount', 'update']) test(`${failure} failures remove host decoration and retain source fallback without blocking healthy views`, () => probe(`failure-${failure}`, async (page, fact) => {
  const result = await page.evaluate(async ({ identity, bytes, corpus, failure }) => {
    const { init } = await import('@edit-ac/core'); const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const wasm = await init('/core/wasm/editac_wasm_bg.wasm'); const engine = wasm.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root); let surface; const counts = { badDispose: 0, goodUpdate: 0, goodDispose: 0 };
    try {
      const registry = new ModuleRegistry(); for (const d of corpus.definitions) registry.register(d, { tag: d.kind === 'mark' ? 'mark' : 'code' });
      surface = mountEditorSurface(root, engine, { modules: registry, moduleRuntime: { onError() { throw Error('diagnostic failed'); }, renderers: {
        'demo.badge': { mount(element) { element.textContent = 'discard decoration'; if (failure === 'mount') throw Error('bad mount'); return { update() { element.textContent = 'bad update'; throw Error('bad update'); }, dispose() { counts.badDispose++; throw Error('bad cleanup'); } }; } },
        'demo.highlight': { mount() { return { update() { counts.goodUpdate++; }, dispose() { counts.goodDispose++; } }; } },
      } } });
      const original = engine.read().visible.find(n => n.id === 'n:11:1');
      for (const offset of [original.runs[0].text.length + 1, 1]) {
        const a = engine.anchor(original.id, offset, 'right'); try { engine.commit(engine.prepare({ kind: 'text', origin: 'module-runtime:failure', command: { type: 'insert', at: a, text: '!' } })); } finally { engine.releaseAnchor(a); }
      }
      const changed = engine.read().visible.find(n => n.id === original.id); const atom = root.querySelector('[data-module-type="demo.badge"]');
      const fallback = atom.dataset.moduleFallback; const decorationGone = !atom.querySelector('[data-module-view]'); const dom = root.querySelector('[data-node-id="n:11:1"]').textContent;
      const errors = surface.moduleRuntime.takeErrors(); const engineErrors = engine.takeObserverErrors(); surface.dispose();
      return { counts, dom, changed, fallback, decorationGone, errors, engineErrors };
    } finally { surface?.dispose(); engine.dispose(); root.remove(); }
  }, { identity, bytes, corpus, failure });
  fact.snapshots.push(result); assert.equal(result.fallback, 'text'); assert.equal(result.decorationGone, true);
  assert.equal(result.dom, result.changed.runs.map(r => r.text).join('')); assert.equal(result.counts.goodUpdate, 1); assert.equal(result.counts.goodDispose, 1);
  assert.equal(result.counts.badDispose, failure === 'mount' ? 0 : 1);
  assert.deepEqual(result.errors.map(e => e.phase), failure === 'mount' ? ['mount'] : ['update', 'dispose']); assert.deepEqual(result.engineErrors, []);
}));
test('removed/replaced runs and repeated mount/dispose release each host view once', () => probe('replace-remount', async (page, fact) => {
  const result = await page.evaluate(async ({ identity, bytes, corpus }) => {
    const { init } = await import('@edit-ac/core'); const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const wasm = await init('/core/wasm/editac_wasm_bg.wasm'); const engine = wasm.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root); let surface; const counts = { mount: 0, dispose: 0 };
    const registry = new ModuleRegistry(); for (const d of corpus.definitions) registry.register(d, { tag: 'span' });
    const options = { modules: registry, moduleRuntime: { renderers: { 'demo.badge': { mount() { counts.mount++; return { update() {}, dispose() { counts.dispose++; } }; } } } } };
    try {
      surface = mountEditorSurface(root, engine, options);
      const original = engine.read().visible.find(n => n.id === 'n:11:1');
      engine.commit(engine.prepare({ kind: 'format', origin: 'module-runtime:rewrap', marks: [], blocks: [{ targets: [original.id], attributes: { type: 'paragraph' }, action: 'apply' }] }));
      const replaced = { ...counts };
      surface.dispose();
      for (let i = 0; i < 3; i++) { surface = mountEditorSurface(root, engine, options); surface.dispose(); }
      surface = mountEditorSurface(root, engine, options);
      const a = engine.anchor(original.id, original.runs[0].text.length, 'left'), f = engine.anchor(original.id, original.runs[0].text.length + original.runs[1].text.length, 'right');
      try { engine.commit(engine.prepare({ kind: 'text', origin: 'module-runtime:remove', command: { type: 'delete', range: { anchor: a, focus: f } } })); } finally { engine.releaseAnchor(a); engine.releaseAnchor(f); }
      const removed = { ...counts }; surface.dispose();
      for (let i = 0; i < 3; i++) { surface = mountEditorSurface(root, engine, options); surface.dispose(); }
      return { replaced, removed, final: counts, knownAtomAbsent: !root.querySelector('[data-module-type="demo.badge"][contenteditable="false"]'), remainingKnownRuns: engine.read().visible.find(n => n.id === original.id).runs.filter(r => r.attributes['module:demo.badge']?.[0] === 1).length };
    } finally { surface?.dispose(); engine.dispose(); root.remove(); }
  }, { identity, bytes, corpus });
  fact.snapshots.push(result); assert.deepEqual(result.replaced, { mount: 2, dispose: 1 }); assert.deepEqual(result.removed, { mount: 6, dispose: 6 });
  assert.deepEqual(result.final, { mount: 6, dispose: 6 }); assert.equal(result.knownAtomAbsent, true); assert.equal(result.remainingKnownRuns, 0);
}));

test('Yjs attribute-only remote patches update the same atom view and skip a disjoint range', () => probe('attribute-only-remote', async (page, fact) => {
  const remote = new Y.Doc({ gc: false }); Y.applyUpdate(remote, new Uint8Array(bytes));
  remote.clientID = 73; // Fixed prepared remote writer; no fixture recording.
  const vector = Y.encodeStateVector(remote);
  const start = corpus.runs[0].text.length, end = start + corpus.runs[1].text.length;
  const nextEnvelope = structuredClone(corpus.runs[1].attributes['module:demo.badge']); nextEnvelope[1].label = 'Changed attribute only';
  remote.getMap('registry-texts').get('n:11:1').format(start, end - start, { 'module:demo.badge': nextEnvelope });
  const update = [...Y.encodeStateAsUpdate(remote, vector)]; remote.destroy();
  const result = await page.evaluate(async ({ identity, bytes, corpus, update, start, end }) => {
    const { init } = await import('@edit-ac/core'); const { ModuleRegistry, mountEditorSurface } = await import('/web/index.js');
    const wasm = await init('/core/wasm/editac_wasm_bg.wasm'); const engine = wasm.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root); let surface;
    const counts = { mount: 0, update: 0, dispose: 0, atomRange: 0, disjoint: 0 }; let content;
    try {
      const registry = new ModuleRegistry(); for (const d of corpus.definitions) registry.register(d, { tag: 'span' });
      surface = mountEditorSurface(root, engine, { modules: registry, moduleRuntime: { renderers: { 'demo.badge': { mount(element, initial) {
        counts.mount++; content = initial; return { update(next) { counts.update++; content = next; }, dispose() { counts.dispose++; } };
      } } } } });
      const original = engine.read().visible.find(n => n.id === 'n:11:1'), source = original.spans[0].source;
      surface.moduleRuntime.subscribe({ kinds: ['Remote'], range: { source, start, end } }, () => counts.atomRange++);
      surface.moduleRuntime.subscribe({ kinds: ['Remote'], range: { source, start: 0, end: 2 } }, () => counts.disjoint++);
      const atom = root.querySelector('[data-module-type="demo.badge"]');
      engine.applyUpdate({ identity, bytes: new Uint8Array(update) });
      const changed = engine.read().visible.find(n => n.id === original.id);
      const retained = atom === root.querySelector('[data-module-type="demo.badge"]'), dom = root.querySelector('[data-node-id="n:11:1"]').textContent;
      surface.dispose(); return { original, changed, retained, dom, counts, content };
    } finally { surface?.dispose(); engine.dispose(); root.remove(); }
  }, { identity, bytes, corpus, update, start, end });
  fact.snapshots.push(result);
  assert.equal(result.retained, true); assert.deepEqual(result.counts, { mount: 1, update: 1, dispose: 1, atomRange: 1, disjoint: 0 });
  assert.equal(result.content.attributes.label, 'Changed attribute only'); assert.equal(result.content.text, corpus.runs[1].text);
  assert.deepEqual(result.changed.runs.map(r => r.text), corpus.runs.map(r => r.text));
  assert.deepEqual(result.changed.runs[1].attributes['module:demo.badge'], nextEnvelope); assert.equal(result.dom, corpus.runs.map(r => r.text).join(''));
}));
