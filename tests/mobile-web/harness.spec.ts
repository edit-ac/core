import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { MobileHarness } from './harness.ts';
import { installResourceCounters } from './resources.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./harness.json', import.meta.url), 'utf8'));
const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
 autoMount: false, testFile: 'tests/mobile-web/harness.spec.ts', assertSourcesUnchanged: true,
 contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
 beforeNavigate: async page => { await page.addInitScript(installResourceCounters); },
 sourcePaths: [...browserInputSources, 'packages/web/src/editor.ts', 'packages/web/src/surface.ts',
  'packages/web/src/lifecycle.ts', 'fixtures/browser-mobile-web/index.html', 'fixtures/browser-mobile-web/session.mjs',
  'tests/mobile-web/harness.ts', 'tests/mobile-web/harness.json', 'tests/mobile-web/resources.mjs',
  'tests/mobile-web/case-index.json', 'tests/mobile-web/catalog.mjs', 'tests/mobile-web/catalog.test.mjs', 'scripts/test-mobile-web.mjs'],
});
facts.binding = { gate: 'MWF-1.1', profile: '390x740 CSS pixels; desktop Chromium touch emulation; production BrowserEditor/recovered Session/WASM/IndexedDB',
 provenance: 'prepared native event/geometry/API delivery; all 64 registrations remain unexecuted feature cases; original MWB device/performance admission deferred' };
async function resources(page) { return page.evaluate(() => (window as any).mobileResources()); }
async function teardown(page, baseline, fact) {
 await page.evaluate(() => (window as any).inputFixture.destroy());
 await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
 const after = await resources(page); assert.deepEqual(after, baseline, 'disposal restores listeners/observers/timers/frames/capture');
 fact.resources = { baseline, after };
}
for (const fixture of fixtures) test(`MWF-1.1 ${fixture.id} real semantic/selection/effect/history oracle`, () => probe(fixture.id, async (page, fact) => {
 await page.waitForFunction(() => !!(window as any).inputFixture); const baseline = await resources(page);
 const h = new MobileHarness(page); await h.mount(fixture.initial); await h.nativeInsert(fixture.action);
 fact.snapshots.push(await h.checkpoint(fixture.expected, 1));
 fact.negativeControls = [];
 for (const [name, mutate] of [
  ['semantic', e => e.state.blocks[0].text += '?'], ['marks', e => e.state.blocks[0].marks.push({ from: 0, to: 1, type: 'bold' })],
  ['selection', e => e.state.selection.focus.offset++], ['effect', e => e.effects.localCommits++],
 ]) { const wrong = structuredClone(fixture.expected); mutate(wrong); await assert.rejects(h.checkpoint(wrong, 1), assert.AssertionError); fact.negativeControls.push(name); }
 await assert.rejects(h.checkpoint(fixture.expected, 2), /semantic history/); fact.negativeControls.push('history');
 await h.select(fixture.navigation); const directional = structuredClone(fixture.expected); directional.state.selection = fixture.navigation;
 fact.snapshots.push(await h.checkpoint(directional, 1));
 const wrongDirection = structuredClone(directional); wrongDirection.state.selection.affinity = 'forward';
 await assert.rejects(h.checkpoint(wrongDirection, 1), assert.AssertionError); fact.negativeControls.push('direction');
 assert.equal(await page.evaluate(() => (window as any).inputFixture.host().focus), true);
 await teardown(page, baseline, fact);
}));
test('MWF-1.1 absent real engine rejects', () => probe('MWF-missing-engine', async (page, fact) => {
 await page.waitForFunction(() => !!(window as any).inputFixture); const baseline = await resources(page);
 const h = new MobileHarness(page); await h.mount(fixtures[0].initial);
 await page.evaluate(() => { (window as any).savedFixture = (window as any).inputFixture; (window as any).inputFixture = undefined; });
 try { await assert.rejects(h.requireEngine(), /requires a mounted real engine/); }
 finally { await page.evaluate(() => { (window as any).inputFixture = (window as any).savedFixture; delete (window as any).savedFixture; }); }
 fact.negativeControls = ['absent-real-engine']; await teardown(page, baseline, fact);
}));
test('MWF-1.1 mobile geometry/cancel delivery preserves content, selection, focus and resources', () => probe('MWF-geometry-cancel', async (page, fact) => {
 await page.waitForFunction(() => !!(window as any).inputFixture); const baseline = await resources(page), h = new MobileHarness(page);
 await h.mount(fixtures[2].initial); const expected = { outcome: 'applied', state: fixtures[2].initial, effects: { localCommits: 0, remoteCommits: 0 } };
 const before = await h.checkpoint(expected, 0); const host = await page.evaluate(() => (window as any).inputFixture.host());
 assert.equal(host.ownerWindow, true); assert.equal(host.scrollRoot, 'scroll-root');
 await page.setViewportSize({ width: 740, height: 390 });
 fact.trace = await page.evaluate(() => {
  const f = (window as any).inputFixture, events = [];
  for (const type of ['pointercancel', 'lostpointercapture']) { const e = new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch' }); f.root.dispatchEvent(e); events.push({ type, prepared: true }); }
  f.root.addEventListener('beforeinput', e => e.preventDefault(), { once: true, capture: true });
  const canceled = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'canceled' });
  f.root.dispatchEvent(canceled); events.push({ type: 'beforeinput', canceled: canceled.defaultPrevented });
  window.dispatchEvent(new Event('resize')); f.root.parentElement.dispatchEvent(new Event('scroll'));
  return events;
 });
 assert.equal(fact.trace.at(-1).canceled, true); fact.snapshots.push(before, await h.checkpoint(expected, 0));
 const after = await page.evaluate(() => (window as any).inputFixture.host());
 assert.equal(after.observed.layout.width, 740); assert.equal(after.focus, true); assert.equal(after.viewportMeta, host.viewportMeta);
 fact.host = { before: host, after };
 await teardown(page, baseline, fact);
}));
test('MWF-1.1 guarded capability/fallback fixtures do not authorize APIs or take host focus', () => probe('MWF-capability-contract', async (page, fact) => {
 await page.waitForFunction(() => !!(window as any).inputFixture); const baseline = await resources(page), h = new MobileHarness(page);
 await h.mount(fixtures[0].initial);
 fact.capabilities = await page.evaluate(async () => {
  const f = (window as any).inputFixture; let calls = 0;
  const denied = { api: async () => { calls++; throw Error('denied'); } }, throwing = Object.defineProperty({}, 'api', { get() { throw Error('restricted'); } }), changing = { api: undefined };
  const values = [{ name: 'absent', ...f.capability({}, 'api') }, { name: 'denied-unrequested', ...f.capability(denied, 'api') }, { name: 'throwing', ...f.capability(throwing, 'api') }, { name: 'changing-absent', ...f.capability(changing, 'api') }];
  changing.api = () => {}; values.push({ name: 'changing-present', ...f.capability(changing, 'api') });
  document.querySelector<HTMLButtonElement>('#host-control')!.focus();
  window.dispatchEvent(new Event('resize')); const eagerCalls=calls; const requests=[];for(const platform of [{},denied,throwing,{api:async()=>{}}])requests.push(await f.requestCapability(platform,'api'));
  return { values, calls, eagerCalls, requests, focus: document.activeElement!.id, meta: f.host().viewportMeta, runtime: { secureContext:window.isSecureContext, touchPoints:navigator.maxTouchPoints, visualViewport:!!window.visualViewport, clipboard:!!navigator.clipboard } };
 });
 assert.deepEqual(fact.capabilities.values.map(v => v.available), [false, true, false, false, true]);
 assert.equal(fact.capabilities.eagerCalls, 0); assert.equal(fact.capabilities.calls, 1);
 assert.deepEqual(fact.capabilities.requests.map(v=>v.outcome), ['unavailable','denied','denied','prepared-success']); assert.equal(fact.capabilities.focus, 'host-control');
 assert.ok(fact.capabilities.values.every(v => v.fallback === 'native-contenteditable'));
 await h.select(fixtures[0].initial.selection); fact.snapshots.push(await h.checkpoint({ outcome: 'applied', state: fixtures[0].initial, effects: { localCommits: 0, remoteCommits: 0 } }, 0));
 await teardown(page, baseline, fact);
}));
