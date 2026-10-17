import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';

const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
  autoMount: false, markdown: true, testFile: 'tests/mobile-web/product.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  beforeNavigate: async page => page.addInitScript(installResourceCounters),
  sourcePaths: [...browserInputSources, ...['editor','surface','lifecycle','input/text','ui/commands','platform/viewport','platform/keyboard','platform/capabilities','clipboard/fragment','clipboard/pending','modules/reorder','extensions/code'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`]),
    'fixtures/browser-mobile-web/session.mjs', 'fixtures/browser-mobile-web/index.html', 'tests/mobile-web/product.spec.ts',
    'tests/mobile-web/portable-cases.json', 'tests/mobile-web/catalog.mjs', 'scripts/test-mobile-web.mjs', '../architecture/specs/mobile-web.md', '../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate: 'PIC-1.2', children: ['PIC-1.2-I1','PIC-1.2-V1'],
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

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const blocks = s => s.nodes.filter(n => n.kind === 'block');
const semantics = s => s.nodes.map(n => ({kind:n.kind, runs:n.runs, blockAttributes:n.blockAttributes, editor:n.editor}));
async function select(page, a, b = a) {
  await page.evaluate(({a,b}) => { const f = (window as any).inputFixture; f.select(f.engine.read().visible.find(n => n.kind === 'block').id,a,b); }, {a,b});
}
async function history(page, redo = false) {
  await page.keyboard.press(`${mod}+${redo ? 'Shift+' : ''}z`);
  await page.evaluate(() => (window as any).inputFixture.settle());
}
async function reopen(page, fact, expected) {
  await page.evaluate(async () => { const f = (window as any).inputFixture; await f.destroy(); await f.recover(); });
  const restored = await state(page, fact);
  assert.deepEqual(semantics(restored),semantics(expected),'durable semantic recovery');
  assert.equal(restored.history.undoGroups,0,'recovered history has no new local intent');
  assert.equal(restored.journal.length,expected.journal.length);
}

for (const [marker,start] of [['0.',0],['3)',3]] as const) test(`PIC-1.2 ${marker} typing, formatting, remote anchors, clipboard and durable history`, () => probe(`PIC-list-${start}`, async (page,fact) => {
  const baseline = await mount(page,{text:'',triggers:true},0,0);
  await page.keyboard.type(marker); await page.keyboard.press('Space'); await page.keyboard.type('zero');
  let s = await state(page,fact);
  assert.deepEqual(s.nodes.filter(n => n.kind === 'list').map(n => n.editor.containerAttributes),[['ordered',start]]);
  assert.deepEqual(text(s),['zero']);
  await select(page,4,1); await command(page,'bold');
  s = await state(page,fact); assert.deepEqual(blocks(s)[0].runs.map(r => [r.text,!!r.attributes.bold]),[['z',false],['ero',true]]);
  const groups=s.history.undoGroups, local=updates(s).length;
  await page.evaluate(() => (window as any).inputFixture.remote(0,0,'R'));
  s=await state(page,fact); assert.deepEqual(text(s),['Rzero']);
  assert.equal(s.selection.anchor.offset,5); assert.equal(s.selection.focus.offset,2);
  assert.equal(s.history.undoGroups,groups); assert.equal(updates(s).length,local+1);
  await page.evaluate(() => (window as any).inputFixture.surface.pastePlainText(async () => 'X😀'));
  s=await state(page,fact); assert.deepEqual(text(s),['RzX😀']);
  assert.equal(s.history.undoGroups,groups+1); assert.equal(s.journal.length,local+2);
  const pasted=s;
  await history(page); s=await state(page,fact); assert.deepEqual(text(s),['Rzero']);
  assert.deepEqual(blocks(s)[0].runs.map(r => [r.text,!!r.attributes.bold]),[['Rz',false],['ero',true]]);
  await history(page,true); s=await state(page,fact); assert.deepEqual(semantics(s),semantics(pasted));
  await reopen(page,fact,s); await finish(page,baseline,fact);
}));

test('PIC-1.2 disabled formatting retains existing marks through remote selection, Unicode clipboard, undo and recovery', () => probe('PIC-disabled-formatting',async(page,fact) => {
  const baseline=await mount(page,{marks:[{from:1,to:4,type:'bold'}],deniedCommands:['bold']});
  const before=await state(page,fact); await command(page,'bold');
  unchanged(before,await state(page,fact));
  await page.evaluate(() => (window as any).inputFixture.remote(0,0,'R'));
  let s=await state(page,fact); assert.deepEqual(text(s),['Ralpha']);
  assert.equal(s.selection.anchor.offset,5); assert.equal(s.selection.focus.offset,2);
  await page.evaluate(() => (window as any).inputFixture.surface.pastePlainText(async () => 'é😀'));
  s=await state(page,fact); assert.deepEqual(text(s),['Raé😀a']); effects(s,1,1,1);
  await history(page); s=await state(page,fact); assert.deepEqual(text(s),['Ralpha']);
  assert.deepEqual(blocks(s)[0].runs.map(r => [r.text,!!r.attributes.bold]),[['Ra',false],['lph',true],['a',false]]);
  await history(page,true); s=await state(page,fact); assert.deepEqual(text(s),['Raé😀a']);
  await reopen(page,fact,s); await finish(page,baseline,fact);
}));

test('PIC-1.2 code extension cancels late clipboard on pagehide then resumes one history owner and recovers', () => probe('PIC-code-lifecycle',async(page,fact) => {
  const baseline=await mount(page,{text:'a\nb',code:true,codeTools:true},3,0);
  await page.evaluate(() => { const w=window as any; w.pending=w.inputFixture.surface.pastePlainText(() => new Promise(r => {w.resolvePaste=r;})); });
  const before=await state(page,fact);
  await page.evaluate(async () => { const w=window as any; window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); w.resolvePaste('late'); await w.pending; window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); });
  await frames(page); unchanged(before,await state(page,fact));
  await select(page,3,0); await page.getByRole('button',{name:'Indent code lines',exact:true}).click();
  let s=await state(page,fact); assert.deepEqual(text(s),['  a\n  b']); effects(s,1);
  await history(page); s=await state(page,fact); assert.deepEqual(text(s),['a\nb']);
  await history(page,true); s=await state(page,fact); assert.deepEqual(text(s),['  a\n  b']);
  await reopen(page,fact,s); await finish(page,baseline,fact);
}));
