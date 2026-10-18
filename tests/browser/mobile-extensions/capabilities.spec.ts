import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installExtensionCounters } from './resources.mjs';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-mobile-extensions', {
  autoMount: false, testFile: 'tests/browser/mobile-extensions/capabilities.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  serverOptions: { recordRequests: true }, beforeNavigate: async page => { await page.addInitScript(installResourceCounters); await page.addInitScript(installExtensionCounters); },
  sourcePaths: [...browserInputSources, 'fixtures/browser-mobile-extensions/session.mjs', 'fixtures/browser-mobile-extensions/index.html',
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs', 'tests/browser/mobile-extensions/resources.mjs', 'scripts/test-mobile-extensions.mjs', 'packages/web/package.json',
    '../architecture/tests/mobile-extension-cases.md', '../architecture/specs/mobile-web.md',
    ...['editor', 'surface', 'extensions/configuration', 'extensions/contract', 'platform/viewport'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = { gate: 'MEX-1.1', ids: ['MWX-C01', 'MWX-C02', 'MWX-C03', 'MWX-C04'],
  scope: 'capability harness prerequisites; full catalog rows remain open until all advertised commands and graph absence pass',
  platform: 'desktop Chromium with prepared mobile viewport/events; original MWX-1.8 pending',
  limits: { disabledResources: 0, disabledAssetRequests: 0, registrationTransactions: 0 },
  profile: 'FIT extension configuration v1; production BrowserEditor/Session/WASM/IndexedDB' };
async function frame(page) { await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); }
async function mount(page, options = {}) {
  await page.waitForFunction(() => !!(window as any).inputFixture);
  const baseline = await page.evaluate(() => (window as any).mobileResources());
  await page.evaluate(async options => { const f = (window as any).inputFixture; await f.mount({ text: 'alpha', ...options }); f.select(f.ids[0], 2); await f.settle(); }, options);
  await frame(page); return baseline;
}
async function snapshot(page) {
  return page.evaluate(async () => { const f = (window as any).inputFixture, s = await f.state();
    return { nodes: s.nodes, history: s.history, patches: s.patches, journal: s.journal, checkpoint: Array.from(f.engine.checkpoint().bytes), errors: s.errors, storage: s.storage }; });
}
async function finish(page, baseline, fact) {
  fact.activeResources = await page.evaluate(() => (window as any).mobileResources());
  const changes = await page.evaluate(async () => { const f = (window as any).inputFixture, updates = [];
    const sub = f.engine.subscribe({type:'all'}, patch => { if(patch.update)updates.push(patch.origin); });
    try { await f.destroy(); } finally { sub.dispose(); } return updates; });
  assert.deepEqual(changes, [], 'teardown emits no semantic transactions'); fact.teardownUpdates = changes; await frame(page);
  const after = await page.evaluate(() => (window as any).mobileResources());
  fact.resources = { baseline, after }; assert.deepEqual(after, baseline, 'all mounted resource ownership released');
}
for (const feature of ['search', 'reorder', 'images', 'tables', 'references', 'slash', 'math', 'markdown'])
test(`MWX-C02 current configured ${feature} mounts only the selected profile`, () => probe(`MWX-C02-facade-${feature}`, async (page, fact) => {
  const baseline = await mount(page, { facade: feature }), before = await snapshot(page);
  const profile = await page.evaluate(() => { const f = (window as any).inputFixture;
    return { selected: f.surface.extensionConfiguration.extensions.map(e => e.feature.id), status: f.surface.extensionStatus,
      owned: (window as any).mobileExtensionResources() }; });
  assert.deepEqual(profile.selected, [`editac.${feature}`]);
  assert.equal(before.history.undoGroups, 0); assert.equal(before.journal.length, 0); assert.equal(before.patches.length, 0);
  await frame(page); assert.deepEqual(await snapshot(page), before);
  fact.capability = { feature, available: true, enabled: true, authorized: 'local fixture only; no remote authority', qualified: false, profile };
  await finish(page, baseline, fact);
}));
test('MWX-C02 unsupported and missing-capability profiles fail before mutation', () => probe('MWX-C02-rejected-profiles', async (page, fact) => {
  const baseline = await mount(page, { facade: 'disabled' }), before = await snapshot(page);
  const codes = await page.evaluate(async () => {
    const { prepareSurfaceConfiguration, References } = await import('/web/extensions/configuration.js');
    const { defineExtensionContract } = await import('/web/extensions/contract.js');
    const { FIRST_PARTY_FEATURES } = await import('@edit-ac/core/extensions');
    const unknown = { ...FIRST_PARTY_FEATURES.find(f => f.id === 'editac.search'), id: 'fixture.unknown', capabilities: [] };
    const errors = [];
    for (const extension of [
      References.configure({ host: async () => [] }),
      defineExtensionContract({ apiVersion: 1, feature: unknown, semantics: { kind: 'behavior' }, defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [] }).configure(),
    ]) {
      try { prepareSurfaceConfiguration({ extensions: [extension], extensionEnvironment: { schema: 'editac.registry.editor.v5', capabilities: [] } }, 'editac.registry.editor.v5'); errors.push('accepted'); }
      catch (error) { errors.push(error.code); }
    }
    return errors;
  });
  assert.deepEqual(codes, ['missing-capability', 'missing-adapter']);
  assert.deepEqual(await snapshot(page), before); fact.rejections = codes; await finish(page, baseline, fact);
}));
test('MWX-C01 disabled extensions preserve baseline typing, selection and native scrolling', () => probe('MWX-C01-baseline', async (page, fact) => {
  const baseline = await mount(page, { facade: 'disabled' });
  const optional = await page.evaluate(() => (window as any).mobileExtensionResources());
  assert.deepEqual(optional, { listeners: 0, allocations: [] }); fact.disabledResources = optional;
  await page.keyboard.type('Z');
  const s = await page.evaluate(() => (window as any).inputFixture.state());
  assert.equal(s.dom, 'alZpha'); assert.equal(s.selection.focus.offset, 3);
  assert.equal(s.history.undoGroups, 1); assert.equal(s.journal.length, 1); assert.deepEqual(s.errors, []);
  const native = await page.evaluate(() => { const root = (window as any).inputFixture.root, e = new Event('touchstart', { bubbles: true, cancelable: true }); root.dispatchEvent(e); const scroll = root.parentElement; scroll.scrollTop = 40; return { prevented: e.defaultPrevented, scroll: scroll.scrollTop, select: getComputedStyle(root).userSelect, action: getComputedStyle(root).touchAction }; });
  assert.equal(native.prevented, false); assert.equal(native.scroll, 40); assert.notEqual(native.select, 'none'); assert.equal(native.action, 'auto');
  assert.deepEqual(await page.evaluate(() => (window as any).mobileExtensionResources()), { listeners: 0, allocations: [] });
  fact.native = native; fact.snapshots.push(s); await finish(page, baseline, fact);
}));
for (const [feature, options, source] of [
  ['slash', { baselineModules: true }, '/modules/slash.js'],
  ['references', { references: true }, '/modules/references.js'],
  ['code', { codeTools: true }, '/extensions/code.js'],
  ['reorder', { reorder: true }, '/modules/reorder.js'],
  ['table', { table: true }, '/modules/content.js'],
] as const) test(`MWX-C02 ${feature} registration and disposal are nonmutating`, () => probe(`MWX-C02-${feature}`, async (page, fact) => {
  const baseline = await mount(page, options), before = await snapshot(page);
  assert.deepEqual(before.errors, []); assert.equal(before.storage, 'localCommitted');
  assert.equal(before.history.undoGroups, 0); assert.equal(before.journal.length, 0); assert.equal(before.patches.length, 0);
  await frame(page); assert.deepEqual(await snapshot(page), before);
  assert.ok(fact.requests.some(url => url.includes(source)), `enabled ${feature} uses its owning implementation`);
  fact.capability = { feature, available: true, enabled: true, authorized: true, qualified: false, qualification: 'portable prerequisite only; platform pending' };
  await finish(page, baseline, fact);
}));
for (const mode of ['absent', 'rejected']) test(`MWX-C02 ${mode} optional API retains native input fallback`, () => probe(`MWX-C02-${mode}`, async (page, fact) => {
  const baseline = await mount(page), before = await snapshot(page);
  const result = await page.evaluate(async mode => { const f = (window as any).inputFixture; const prepared = mode === 'absent' ? {} : { share: async () => { throw Error('prepared denied'); } }; return { capability: f.capability(prepared, 'share'), result: await f.requestCapability(prepared, 'share') }; }, mode);
  assert.equal(result.capability.available, mode !== 'absent'); assert.equal(result.result.outcome, mode === 'absent' ? 'unavailable' : 'denied'); assert.equal(result.result.fallback, 'native-contenteditable');
  assert.deepEqual(await snapshot(page), before); fact.preparedApi = result;
  await page.keyboard.type('x'); assert.equal((await page.evaluate(() => (window as any).inputFixture.state())).dom, 'alxpha');
  await finish(page, baseline, fact);
}));
for (const [mode, options, allowed] of [ ['editable', {}, true], ['readonly', { readOnly: true }, false], ['denied', { deniedCommands: ['bold'] }, false] ] as const)
test(`MWX-C03 shared command applicability ${mode}`, () => probe(`MWX-C03-${mode}`, async (page, fact) => {
  const baseline = await mount(page, { commandControls: true, ...options }), before = await snapshot(page);
  const commands = await page.evaluate(() => { const f = (window as any).inputFixture, token = f.surface.captureCommand('bold'), unknown = f.surface.captureCommand('unknown-mobile-command'); const result = { bold: !!token, unknown: !!unknown }; token?.dispose(); unknown?.dispose(); return result; });
  assert.equal(commands.bold, allowed); assert.equal(commands.unknown, false);
  assert.deepEqual(await snapshot(page), before); fact.applicability = commands;
  await finish(page, baseline, fact);
}));
for (const feature of ['slash', 'references', 'search']) test(`MWX-C03 ${feature} remote updates never open controls or mutate history`, () => probe(`MWX-C03-remote-${feature}`, async (page, fact) => {
  const baseline = await mount(page, { facade: feature }), before = await snapshot(page);
  await page.evaluate(async () => { const f = (window as any).inputFixture; await f.remote(0, 0, 'remote '); });
  await frame(page);
  const panels = await page.evaluate(feature => { const f = (window as any).inputFixture;
    const element = feature === 'search' ? f.surface.search.panel : f.surface[feature].menu;
    return { hidden: element.hidden, text: f.root.textContent }; }, feature);
  assert.equal(panels.hidden, true); assert.equal(panels.text, 'remote alpha');
  const after = await snapshot(page); assert.equal(after.history.undoGroups, before.history.undoGroups);
  assert.equal(after.patches.filter(p => p.update).length, 1); assert.equal(after.journal.length, 1);
  fact.remote = panels; fact.snapshots.push(after); await finish(page, baseline, fact);
}));
for (const feature of ['slash', 'references']) test(`MWX-C03 read-only ${feature} cannot activate a write`, () => probe(`MWX-C03-readonly-${feature}`, async (page, fact) => {
  const baseline = await mount(page, { facade: feature, readOnly: true }), before = await snapshot(page);
  const result = await page.evaluate(feature => { const f = (window as any).inputFixture, presenter = f.surface[feature];
    const disabled = presenter.control.disabled; presenter.control.click();
    return { disabled, hidden: presenter.menu.hidden }; }, feature);
  assert.deepEqual(result, { disabled: true, hidden: true }); assert.deepEqual(await snapshot(page), before);
  fact.applicability = result; await finish(page, baseline, fact);
}));
test('MWX-C04 empty registration, viewport updates and popup geometry emit zero transactions', () => probe('MWX-C04-derived', async (page, fact) => {
  const baseline = await mount(page, { viewport: true, baselineModules: true }), before = await snapshot(page);
  const profile = await page.evaluate(async () => { const f = (window as any).inputFixture;
    const { prepareEditorExtensionConfiguration } = await import('/web/extensions/contract.js');
    const configured = prepareEditorExtensionConfiguration({ apiVersion: 1, extensions: [] }, { schema: 'editac.registry.editor.v5', capabilities: ['commands', 'source-fallback'] });
    f.surface.slash.control.click();
    (window as any).mobileGeometry = { visual: { left: 0, top: 0, width: 390, height: 360 }, scale: 1 };
    window.dispatchEvent(new Event('resize')); return { enabled: configured.extensions.length, ready: configured.requiredReady.length };
  });
  await frame(page); assert.deepEqual(profile, { enabled: 0, ready: 0 }); assert.deepEqual(await snapshot(page), before);
  await page.evaluate(() => (window as any).inputFixture.surface.slash.dismiss()); await frame(page);
  assert.deepEqual(await snapshot(page), before); fact.snapshots.push(before); await finish(page, baseline, fact);
}));
