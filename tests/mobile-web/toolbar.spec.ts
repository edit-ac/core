import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';

const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
  autoMount: false, testFile: 'tests/mobile-web/toolbar.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  beforeNavigate: async page => page.addInitScript(installResourceCounters),
  sourcePaths: [...browserInputSources, ...['editor','surface','lifecycle','input/text','ui/commands','platform/viewport','platform/keyboard','platform/capabilities','clipboard/fragment','clipboard/pending','modules/reorder'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`]),
    'fixtures/browser-mobile-web/session.mjs', 'fixtures/browser-mobile-web/index.html', 'tests/mobile-web/toolbar.spec.ts',
    'tests/mobile-web/portable-cases.json', 'tests/mobile-web/catalog.mjs', 'scripts/test-mobile-web.mjs', '../architecture/specs/mobile-web.md', '../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate: 'WFE-2.2', children: ['WFE-2.2-I1', 'WFE-2.2-V1'], originalParent: 'MWB-1.5/1.6',
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

async function beginRead(page, id, name) {
  await command(page, id, false);
  await page.evaluate(({ id, name }) => {
    const w = window as any, controls = w.inputFixture.surface.commandControls;
    w[name] = {};
    w[name].done = controls.activate(id, () => new Promise((resolve, reject) => {
      w[name].resolve = resolve; w[name].reject = reject;
    }));
  }, { id, name });
  await page.waitForFunction(name => !!(window as any)[name].resolve, name);
  assert.equal(await page.getByRole('group', { name: 'Editing commands' }).getAttribute('aria-busy'), 'true');
  const cancel = page.getByRole('button', { name: 'Cancel paste', exact: true });
  assert.equal(await cancel.isVisible(), true);
  const bounds = await cancel.boundingBox(); assert.ok(bounds.width >= 44 && bounds.height >= 44);
}
async function resolveRead(page, name, rejected = false) {
  await page.evaluate(async ({ name, rejected }) => {
    const job = (window as any)[name];
    if (rejected) job.reject(Error('prepared late denial')); else job.resolve('late');
    await job.done;
  }, { name, rejected });
}

for (const id of ['paste', 'paste-formatted']) for (const transition of ['cancel', 'readonly', 'pagehide', 'hidden'])
for (const late of ['resolve', 'reject']) test(`WFE-2.2 ${id} ${transition}: fresh intent survives late ${late}, undo and reopen`, () => probe(`${id}-${transition}-${late}`, async (page, fact) => {
  const baseline = await mount(page);
  const before = await state(page, fact);
  await beginRead(page, id, 'abandoned');
  if (transition === 'cancel') {
    const cancel = page.getByRole('button', { name: 'Cancel paste', exact: true });
    await cancel.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(id => (window as any).inputFixture.surface.commandControls.element.querySelector(`[data-command="${id}"]`) === document.activeElement, id), true);
  } else await page.evaluate(transition => {
    const f = (window as any).inputFixture;
    if (transition === 'readonly') f.surface.setReadOnly(true);
    if (transition === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    if (transition === 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  }, transition);
  // Cancellation settles the control even though its prepared reader is unresolved.
  await page.evaluate(() => (window as any).abandoned.done);
  unchanged(before, await state(page, fact));
  assert.equal(await page.getByRole('button', { name: 'Cancel paste', exact: true }).isVisible(), false);
  await page.evaluate(transition => {
    const f = (window as any).inputFixture;
    if (transition === 'readonly') f.surface.setReadOnly(false);
    if (transition === 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
    if (transition === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    f.select(f.ids[0], 4, 1);
  }, transition);
  await beginRead(page, id, 'fresh');
  await resolveRead(page, 'abandoned', late === 'reject');
  await frames(page);
  unchanged(before, await state(page, fact));
  // The abandoned completion cannot clear the newer pending UI or release its target.
  assert.equal(await page.getByRole('button', { name: 'Cancel paste', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('group', { name: 'Editing commands' }).getAttribute('aria-busy'), 'true');
  await page.evaluate(async () => { const w = window as any; w.fresh.resolve('X😀'); await w.fresh.done; });
  let s = await state(page, fact); assert.deepEqual(text(s), ['aX😀a']); effects(s, 1);
  assert.equal(await page.getByRole('button', { name: 'Cancel paste', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('group', { name: 'Editing commands' }).getAttribute('aria-busy'), null);
  // Keyboard/tap history alternatives retain the single semantic paste transaction.
  await page.evaluate(() => { const f = (window as any).inputFixture; f.select(f.ids[0], 4, 4); });
  await command(page, 'undo'); s = await state(page, fact); assert.deepEqual(text(s), ['alpha']);
  assert.equal(s.history.undoGroups, 0); assert.equal(s.history.redoGroups, 1);
  await command(page, 'redo'); s = await state(page, fact); assert.deepEqual(text(s), ['aX😀a']);
  assert.equal(s.history.undoGroups, 1);
  await page.evaluate(async () => { const f = (window as any).inputFixture; await f.destroy(); await f.recover(); });
  const recovered = await state(page, fact); assert.deepEqual(text(recovered), ['aX😀a']);
  assert.equal(recovered.history.undoGroups, 0); assert.equal(recovered.journal.length, s.journal.length);
  await finish(page, baseline, fact);
}));

for (const id of ['paste', 'paste-formatted']) test(`WFE-2.2 ${id} disposal settles unresolved control and isolates replacement session`, () => probe(`${id}-dispose`, async (page, fact) => {
  const baseline = await mount(page); await beginRead(page, id, 'abandoned');
  await page.evaluate(async () => { const w = window as any; await w.inputFixture.destroy(); await w.abandoned.done; await w.inputFixture.recover(); });
  const before = await state(page, fact);
  await resolveRead(page, 'abandoned'); unchanged(before, await state(page, fact));
  assert.deepEqual(text(before), ['alpha']); effects(before, 0);
  await finish(page, baseline, fact);
}));

