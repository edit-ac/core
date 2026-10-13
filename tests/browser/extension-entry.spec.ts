import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { selectAll, state } from './format-helpers.ts';

const corpus = JSON.parse(await readFile(new URL('../../fixtures/modules/entry.json', import.meta.url), 'utf8'));
const evidence = process.env.EDITAC_EXTENSION_ENTRY_FIXTURES;
if (!evidence) throw Error('Run the Rust entry fixtures first; EDITAC_EXTENSION_ENTRY_FIXTURES is required');
const bytes = [...await readFile(`${evidence}/unknown-checkpoint.bin`)];
const identity = JSON.parse(await readFile(`${evidence}/unknown-identity.json`, 'utf8'));
const { probe } = browserHarness('extension-entry');

for (const fixture of corpus.known) {
  test(`${fixture.name}: shared tuple crosses the real clipboard command, patch and fallback`, () => probe(fixture.name, async (page, fact) => {
    await selectAll(page);
    const disabled = await page.evaluate(fixture => {
      const f = window.inputFixture;
      const disabled = f.engine.importMarkdown(fixture.source);
      f.protocol.clipboard.contentCodecs = fixture.options;
      f.protocol.clipboard.paste({ getData: mime => mime === 'text/markdown' ? fixture.source : '' });
      return disabled;
    }, fixture);
    assert.equal(disabled.source, fixture.source);
    assert.ok(disabled.blocks.every(b => b.attributes?.type !== 'content'));
    assert.equal(disabled.blocks.map(b => b.runs.map(r => r.text).join('')).join('\n'), fixture.disabledText);
    if (fixture.disabledContainer) assert.ok(disabled.blocks.every(b => b.containers.some(c => c.style.type === fixture.disabledContainer)));
    fact.snapshots.push({ disabled });
    const s = await state(page, fact);
    assert.equal(s.result.disposition, 'committed');
    assert.equal(s.journal.length, 1);
    assert.equal(s.history.undoGroups, 1);
    const node = s.nodes.find(n => n.blockAttributes?.[0] === fixture.tuple[0]);
    assert.ok(node);
    assert.deepEqual(node.blockAttributes, fixture.tuple);
    const dom = s.dom[s.nodes.findIndex(n => n.id === node.id)];
    assert.equal(dom, fixture.fallbackText);
    assert.equal(dom, node.runs.map(r => r.text).join(''));
    assert.ok(s.patches.some(p => p.operation === 'Editor' && p.update));
    await page.evaluate(() => window.inputFixture.engine.history({ type: 'undo' }));
    await page.evaluate(() => window.inputFixture.engine.history({ type: 'redo' }));
    const restored = await state(page, fact);
    assert.deepEqual(restored.nodes.find(n => n.blockAttributes?.[0] === fixture.tuple[0]).blockAttributes, fixture.tuple);
  }));
}

test('future tuple and mark from Rust remain inert in DOM and restored WASM', () => probe('unknown', async (page, fact) => {
  const result = await page.evaluate(async ({ bytes, identity }) => {
    const { init } = await import('@edit-ac/core');
    const { DOMRenderer } = await import('/web/dom/render.js');
    const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
    const engine = runtime.restoreEngine(identity, { identity, initialized: true, writerId: 11, bytes: new Uint8Array(bytes) });
    const root = document.createElement('div'); document.body.append(root);
    let renderer, restored;
    try {
      renderer = new DOMRenderer(root, engine);
      const node = engine.read().visible.find(n => n.id === 'n:11:1');
      const before = [...engine.checkpoint().bytes];
      const at = engine.anchor(node.id, 0, 'right');
      const request = { kind: 'text', origin: 'extension:probe', command: { type: 'insert', at, text: 'forbidden' } };
      const canEdit = engine.can(request);
      let rejected = false;
      try { engine.prepare(request); } catch { rejected = true; }
      const unchanged = JSON.stringify(before) === JSON.stringify([...engine.checkpoint().bytes]);
      const checkpoint = engine.checkpoint();
      restored = runtime.restoreEngine(identity, checkpoint);
      return { node, dom: renderer.getBlock(node.id).textContent, executable: root.querySelectorAll('img,script,iframe').length,
        canEdit, rejected, unchanged, restored: restored.read().visible.find(n => n.id === node.id) };
    } finally { restored?.dispose(); renderer?.dispose(); engine.dispose(); root.remove(); }
  }, { bytes, identity });
  fact.snapshots.push(result);
  assert.deepEqual(result.node.blockAttributes, corpus.unknown.tuple);
  assert.deepEqual(result.node.runs[0].attributes[corpus.unknown.mark], corpus.unknown.attributes);
  assert.equal(result.dom, corpus.unknown.text);
  assert.equal(result.executable, 0);
  assert.equal(result.canEdit, false);
  assert.equal(result.rejected, true);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.restored, result.node);
}));

test('invalid or executable descriptor input rejects before mutation', () => probe('invalid', async (page, fact) => {
  const result = await page.evaluate(tuples => {
    const f = window.inputFixture, node = f.engine.read().visible[0];
    const at = f.engine.anchor(node.id, 0, 'right');
    const before = [...f.engine.checkpoint().bytes];
    const results = tuples.map(tuple => {
      try {
        const plan = f.engine.prepare({ kind: 'fragment', origin: 'extension:invalid', range: { anchor: at, focus: at },
          blocks: [{ attributes: { type: 'content', tuple }, runs: [{ text: 'fallback', marks: [] }] }] });
        f.engine.releasePlan(plan); return false;
      } catch { return true; }
    });
    // Functions are host behavior; the public JSON boundary must reject them.
    try {
      f.engine.prepare({ kind: 'fragment', origin: 'extension:callback', range: { anchor: at, focus: at },
        blocks: [{ attributes: { type: 'content', tuple: ['module:example.badge', 1, { render: () => 'bad' }] }, runs: [] }] });
      results.push(false);
    } catch { results.push(true); }
    return { results, unchanged: JSON.stringify(before) === JSON.stringify([...f.engine.checkpoint().bytes]) };
  }, corpus.invalid);
  fact.snapshots.push(result);
  assert.deepEqual(result.results, [true, true, true, true]);
  assert.equal(result.unchanged, true);
  const s = await state(page, fact);
  assert.equal(s.journal.length, 0);
  assert.equal(s.history.undoGroups, 0);
}));
