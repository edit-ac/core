import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';

const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
  autoMount: false, testFile: 'tests/mobile-web/checkpoint.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  beforeNavigate: async page => page.addInitScript(installResourceCounters),
  sourcePaths: [...browserInputSources, ...['editor','surface','lifecycle','input/text','ui/commands','platform/viewport','platform/keyboard','platform/capabilities','clipboard/fragment','clipboard/pending','modules/reorder'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`]),
    'fixtures/browser-mobile-web/session.mjs', 'fixtures/browser-mobile-web/index.html', 'tests/mobile-web/checkpoint.spec.ts',
    'tests/mobile-web/portable-cases.json', 'tests/mobile-web/catalog.mjs', 'scripts/test-mobile-web.mjs', '../architecture/specs/mobile-web.md', '../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate: 'MWF-1.9', originalParent: 'MWB-1.10',
  provenance: 'prepared platform event/geometry/clipboard delivery through packed production BrowserEditor/recovered Session/Rust-WASM/IndexedDB; desktop Chromium/WebKit, no native/device/IME/AT/performance/release qualification' };
const text = s => s.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join(''));
const updates = s => s.patches.filter(p => p.update);
async function frames(page) { await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); }
async function mount(page, options: any = {}, a = 4, b = 1) {
  await page.waitForFunction(() => !!(window as any).inputFixture);
  const baseline = await page.evaluate(() => (window as any).mobileResources());
  await page.evaluate(async ({ options, a, b }) => {
    const w = window as any, f = w.inputFixture;
    w.mobileGeometry = { visual: { left: 0, top: 0, width: 390, height: 740 }, scale: 1 };
    await f.mount({ text: 'alpha', commandControls: true, viewport: true, inputHints: { profile: 'prose' }, ...options });
    f.root.style.minHeight = '60px'; f.select(f.ids[0], a, b); await f.settle();
  }, { options, a, b });
  await frames(page); return baseline;
}
async function state(page, fact) {
  const s = await page.evaluate(() => (window as any).inputFixture.state());
  assert.deepEqual(s.errors, []); assert.equal(s.storage, 'localCommitted'); fact.snapshots.push(s); return s;
}
function unchanged(before, after, selection = true) {
  for (const key of ['nodes', 'history', 'patches', 'journal']) assert.deepEqual(after[key], before[key], key);
  if (selection) assert.deepEqual(after.selection, before.selection, 'directional selection');
}
function effects(s, local, remote = 0, undo = local) {
  assert.equal(updates(s).filter(p => p.origin.startsWith('editac:local:')).length, local, 'local effects');
  assert.equal(updates(s).filter(p => !p.origin.startsWith('editac:local:')).length, remote, 'remote effects');
  assert.equal(s.journal.length, local + remote, 'durable updates'); assert.equal(s.history.undoGroups, undo, 'history');
}
async function finish(page, baseline, fact) {
  await page.mouse.up();
  await page.evaluate(async () => { const w = window as any; await w.second?.dispose(); await w.inputFixture.destroy(); });
  await frames(page);
  const after = await page.evaluate(() => (window as any).mobileResources());
  fact.resources = { baseline, after }; assert.deepEqual(after, baseline, 'all editor ownership restored');
}
async function command(page, id, click = true) {
  await page.evaluate(({ id, click }) => {
    const b = (window as any).inputFixture.surface.commandControls.element.querySelector(`[data-command="${id}"]`);
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 97 }));
    if (click) b.click();
  }, { id, click });
}

test('MWF-1.9 composition plus toolbar preserves literal Unicode, stable selection and separate semantic boundaries', () => probe('MWF-composition-toolbar', async (page, fact) => {
  const baseline = await mount(page, {}, 5, 5);
  await page.evaluate(() => { const f = (window as any).inputFixture; f.deliver('compositionstart'); f.mutate('alpha😀'); f.deliver('input', { inputType: 'insertCompositionText', data: '😀', isComposing: true }); });
  await command(page, 'bold');
  const provisional = await state(page, fact); assert.deepEqual(text(provisional), ['alpha']); effects(provisional, 0);
  await page.evaluate(() => { const f = (window as any).inputFixture; f.deliver('compositionend', { data: '😀' }); });
  const composed = await state(page, fact); assert.deepEqual(text(composed), ['alpha😀']); effects(composed, 1);
  assert.equal(composed.selection.anchor.offset, 7); assert.equal(composed.selection.focus.offset, 7);
  await page.evaluate(() => { const f = (window as any).inputFixture; f.select(f.ids[0], 4, 1); });
  await command(page, 'bold');
  const marked = await state(page, fact); assert.deepEqual(text(marked), ['alpha😀']); effects(marked, 2);
  assert.deepEqual(marked.nodes[0].runs.map(r => [r.text, r.attributes.bold === true]), [['a', false], ['lph', true], ['a😀', false]]);
  assert.equal(marked.selection.anchor.offset, 4); assert.equal(marked.selection.focus.offset, 1); assert.equal(marked.focus, true);
  await finish(page, baseline, fact);
}));

for (const mode of ['resizes-visual', 'overlays-content']) test(`MWF-1.9 keyboard geometry plus rotation ${mode} preserves input, bounded controls and host focus`, () => probe('MWF-keyboard-rotation-' + mode, async (page, fact) => {
  const baseline = await mount(page, { requestedMode: mode }); const before = await state(page, fact);
  await page.locator('#host-control').focus();
  await page.setViewportSize({ width: 740, height: 390 });
  await page.evaluate(() => { const w = window as any; w.mobileGeometry = { visual: { left: 12, top: 8, width: 700, height: 330 }, scale: 1, occlusions: [{ left: 12, top: 230, width: 700, height: 108 }], safeArea: { top: 4, right: 0, bottom: 6, left: 0 } }; for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('resize')); });
  await frames(page); const after = await state(page, fact); unchanged(before, after, false); effects(after, 0);
  assert.equal(await page.evaluate(() => document.activeElement!.id), 'host-control');
  fact.viewport = await page.evaluate(() => { const f = (window as any).inputFixture, c = f.surface.commandControls.element; return { state: f.surface.viewport.state, maxHeight: c.style.maxHeight, overflow: getComputedStyle(c).overflowY }; });
  assert.equal(fact.viewport.overflow, 'auto'); assert.ok(parseFloat(fact.viewport.maxHeight) > 0 && parseFloat(fact.viewport.maxHeight) <= 222);
  assert.deepEqual(fact.viewport.state.observed.visual, { left: 12, top: 8, width: 700, height: 330 });
  await page.evaluate(() => { const f = (window as any).inputFixture; f.select(f.ids[0], 4, 1); }); await command(page, 'bold');
  const edited = await state(page, fact); assert.deepEqual(text(edited), ['alpha']); effects(edited, 1); assert.equal(edited.selection.anchor.offset, 4); assert.equal(edited.selection.focus.offset, 1);
  await finish(page, baseline, fact);
}));

test('MWF-1.9 remote update rebases directional selection without local history or mark loss', () => probe('MWF-remote-selection', async (page, fact) => {
  const baseline = await mount(page, { marks: [{ from: 1, to: 4, type: 'bold' }] });
  await page.evaluate(() => (window as any).inputFixture.remote(0, 0, 'R'));
  const remote = await state(page, fact); assert.deepEqual(text(remote), ['Ralpha']); effects(remote, 0, 1, 0);
  assert.equal(remote.selection.anchor.offset, 5); assert.equal(remote.selection.focus.offset, 2); assert.equal(remote.focus, true);
  assert.deepEqual(remote.nodes[0].runs.map(r => [r.text, r.attributes.bold === true]), [['Ra', false], ['lph', true], ['a', false]]);
  await command(page, 'italic'); const edited = await state(page, fact); effects(edited, 1, 1, 1); assert.equal(edited.selection.anchor.offset, 5); assert.equal(edited.selection.focus.offset, 2);
  assert.equal(edited.nodes[0].runs.find(r => r.text === 'lph').attributes.italic, true);
  await finish(page, baseline, fact);
}));

test('MWF-1.9 active pointer cancellation plus pagehide releases capture and resumes one owner without mutation', () => probe('MWF-pointer-pagehide', async (page, fact) => {
  const baseline = await mount(page, { nodes: [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }], reorder: true });
  await page.evaluate(() => { const f = (window as any).inputFixture; f.surface.reorder.controls.style.cssText = 'position:fixed;bottom:4px;left:4px'; });
  const before = await state(page, fact), grip = page.getByRole('button', { name: 'Drag selected block', exact: true }), box = await grip.boundingBox(); assert.ok(box);
  await grip.evaluate(g => g.addEventListener('pointerdown', e => { (window as any).trackedPointer = (e as PointerEvent).pointerId; }, { once: true, capture: true }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  assert.equal(await page.evaluate(() => (window as any).inputFixture.pointer.captured), true);
  await page.evaluate(() => { const f = (window as any).inputFixture, p = f.pointer; f.root.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: (window as any).trackedPointer, pointerType: 'mouse' })); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
  await page.mouse.up(); await frames(page);
  assert.equal(await page.evaluate(() => (window as any).inputFixture.pointer.captured), false);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }); await frames(page);
  unchanged(before, await state(page, fact));
  await command(page, 'bold'); const resumed = await state(page, fact); effects(resumed, 1); assert.deepEqual(text(resumed), ['alpha', 'beta', 'gamma']);
  await finish(page, baseline, fact);
}));

for (const terminal of ['pagehide', 'read-only', 'dispose', 'other-editor']) test(`MWF-1.9 delayed paste plus ${terminal} rejects late mutation and focus theft`, () => probe('MWF-paste-' + terminal, async (page, fact) => {
  const baseline = await mount(page); await command(page, 'paste', false);
  await page.evaluate(() => { const w = window as any; w.pending = w.inputFixture.surface.commandControls.activate('paste', () => new Promise(r => { w.resolvePaste = r; })); });
  if (terminal === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  if (terminal === 'read-only') await page.evaluate(() => (window as any).inputFixture.surface.setReadOnly(true));
  if (terminal === 'other-editor') await page.evaluate(async () => { const w = window as any; w.second = await w.inputFixture.sibling(); w.second.root.focus(); });
  if (terminal === 'dispose') await page.evaluate(() => (window as any).inputFixture.destroy());
  const before = terminal === 'dispose' ? null : await state(page, fact);
  await page.evaluate(async () => { const w = window as any; w.resolvePaste('late secret payload'); w.pasteResult = await w.pending; });
  if (terminal === 'dispose') {
    await page.evaluate(() => (window as any).inputFixture.recover()); const recovered = await state(page, fact); assert.deepEqual(text(recovered), ['alpha']); effects(recovered, 0);
  } else {
    unchanged(before, await state(page, fact), terminal !== 'other-editor');
    if (terminal === 'other-editor') assert.equal(await page.evaluate(() => document.activeElement === (window as any).second.root), true);
    if (terminal === 'pagehide') { await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await frames(page); unchanged(before, await state(page, fact)); }
  }
  await finish(page, baseline, fact);
}));

test('MWF-1.9 two editors isolate commands and survive teardown of the first viewport owner', () => probe('MWF-two-editors', async (page, fact) => {
  const baseline = await mount(page); await page.evaluate(async () => { const w = window as any; w.second = await w.inputFixture.sibling(); });
  const secondBefore = await page.evaluate(() => (window as any).second.editor.read());
  await page.evaluate(() => { const f = (window as any).inputFixture; f.select(f.ids[0], 4, 1); }); await command(page, 'bold');
  const first = await state(page, fact); effects(first, 1); assert.deepEqual(await page.evaluate(() => (window as any).second.editor.read()), secondBefore);
  await page.evaluate(async () => { const w = window as any; await w.inputFixture.destroy(); w.second.root.focus(); const n = w.second.root.querySelector('[data-node-id]'), t = document.createTreeWalker(n, NodeFilter.SHOW_TEXT).nextNode(); getSelection()!.setBaseAndExtent(t, 1, t, 1); const c = w.second.editor.captureCommand('bold'); try { c?.execute(); } finally { c?.dispose(); } await w.second.editor.settle(); });
  const remaining = await page.evaluate(() => { const w = window as any; return { read: w.second.editor.read(), viewport: w.second.editor.viewport.state, focus: document.activeElement === w.second.root }; });
  assert.equal(remaining.focus, true); assert.ok(remaining.viewport.consumers > 0); assert.deepEqual(remaining.read.visible.map(n => n.runs.map(r => r.text).join('')), ['alpha']);
  await finish(page, baseline, fact);
}));
