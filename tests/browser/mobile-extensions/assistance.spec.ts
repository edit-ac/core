import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const engine = process.env.EDITAC_MOBILE_EXTENSIONS_BROWSER ?? 'chromium';
const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-assistive-dictation', {
  autoMount: false, markdown: true, testFile: 'tests/browser/mobile-extensions/assistance.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: engine !== 'firefox' },
  sourcePaths: [...browserInputSources,
    'packages/core/src/extensions/assistive-input.ts', 'packages/core/src/extensions/assistive-input-session.ts',
    'packages/core/dist/extensions/assistive-input-session.js',
    ...['modules/assistive-input', 'modules/touch-controls', 'dom/selection', 'input/keyboard', 'editor', 'surface', 'storage/checkpoint', 'storage/journal'].flatMap(p => [`packages/web/src/${p}.ts`, `packages/web/dist/${p}.js`]),
    'fixtures/browser-assistive-dictation/index.html', 'fixtures/browser-assistive-dictation/session.mjs', 'fixtures/browser-assistive-dictation/mock-transport.mjs',
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json', 'tests/mobile-web/resources.mjs',
    '../architecture/specs/assistive-input.md', '../architecture/tests/mobile-extension-cases.md',
    'contracts/assistive-input-v1.md', 'packages/core/dist/wasm/editac_wasm_bg.wasm', 'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm',
  ],
  beforeNavigate: async (page, fact) => {
    page.setDefaultTimeout(5000);
    fact.unexpectedRequests = [];
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== new URL(fact.origin).origin) { fact.unexpectedRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(installResourceCounters);
    await page.addInitScript(() => {
      window.assistanceListenerAdds = [];
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(...args) {
        const stack = new Error().stack ?? '';
        if (/\/(web\/modules|core\/extensions)\/assistive-input/.test(stack)) window.assistanceListenerAdds.push(args[0]);
        return add.apply(this, args);
      };
      window.authorityCalls = { permission: 0, capture: 0 };
      if (navigator.permissions) navigator.permissions.query = () => { window.authorityCalls.permission++; throw Error('Prepared assistance cannot request permissions'); };
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { window.authorityCalls.capture++; throw Error('Prepared assistance cannot capture media'); };
    });
  },
});
facts.binding = { gate: 'WEX-2.3/I1/V1', original: 'MWX-1.7/MWX-C25–28',
  semantics: 'Installed BrowserEditor/Session/production WASM/IndexedDB with prepared hostile transport callbacks',
  input: engine === 'firefox' ? 'narrow desktop Firefox pointer/keyboard replay; no mobile emulation' : 'browser touch emulation and keyboard',
  qualification: 'portable browser mechanics only; device/OS/IME/AT/provider/performance/release pending elsewhere' };

async function mount(page, options = {}) {
  await page.waitForFunction(() => !!window.inputFixture);
  const baseline = await page.evaluate(() => window.mobileResources());
  await page.evaluate(async options => { await window.inputFixture.mount({ text: 'alpha', ...options }); window.inputFixture.root.parentElement.style.width = '260px'; }, options);
  return baseline;
}
async function select(page, from = 1, to = 4) { await page.evaluate(({ from, to }) => { const f = window.inputFixture; f.select(f.ids[0], from, to); }, { from, to }); }
async function state(page, fact) { const s = await page.evaluate(() => window.inputFixture.state()); fact.snapshots.push(s); assert.deepEqual(s.errors, []); return s; }
async function press(page, name) {
  const control = page.getByRole('button', { name, exact: true });
  if (engine === 'firefox') await control.click(); else await control.tap();
}
async function start(page) { await select(page); await press(page, 'Editing assistance'); await press(page, 'Start assistance'); }
async function emit(page, text = 'X', sequence = 0, kind = 'final', index = undefined) { await page.evaluate(({ text, sequence, kind, index }) => window.mockTransport.result(text, sequence, kind, index), { text, sequence, kind, index }); }
function unchanged(before, after) { for (const key of ['nodes', 'revision', 'history', 'journal', 'commands', 'patches']) assert.deepEqual(after[key], before[key], key); }
function released(s) { for (const t of s.transport) { assert.equal(t.aborted, true); assert.equal(t.cancelled, 1); assert.equal(t.disposed, 1); } }
async function finish(page, baseline, fact, alreadyDestroyed = false) {
  assert.deepEqual(fact.unexpectedRequests, []);
  assert.deepEqual(await page.evaluate(() => window.authorityCalls), { permission: 0, capture: 0 });
  if (!alreadyDestroyed) await page.evaluate(() => window.inputFixture.destroy());
  const after = await page.evaluate(() => window.mobileResources()); fact.resources = { baseline, after };
  assert.deepEqual(after, baseline, 'all assistance/editor resource ownership released');
}

for (const width of [260, 195]) test(`MWX-C25 narrow ${width}px controls and private recovery remain reachable`, () => probe(`narrow-${width}`, async (page, fact) => {
  const baseline = await mount(page); await page.evaluate(width => { document.body.style.width = width + 'px'; }, width);
  await start(page); await emit(page, 'R'.repeat(900), 0, 'provisional');
  const before = await state(page, fact); assert.equal(before.lifecycle.state, 'active');
  await page.setViewportSize({ width: 390, height: 360 });
  unchanged(before, await state(page, fact));
  const geometry = await page.evaluate(() => {
    const p = window.editor.assistive;
    return { panel: { width: p.panel.clientWidth, scroll: p.panel.scrollWidth, height: p.panel.clientHeight, scrollHeight: p.panel.scrollHeight },
      controls: [...p.element.querySelectorAll('button,input')].filter(e => !e.hidden).map(e => { const r = e.getBoundingClientRect(); return { name: e.textContent || e.getAttribute('type'), width: r.width, height: r.height, left: r.left, right: r.right }; }),
      status: p.status.textContent, previewLive: p.preview.getAttribute('aria-live') };
  });
  fact.geometry = geometry; assert.ok(geometry.panel.width <= width); assert.ok(geometry.panel.scroll <= geometry.panel.width + 1); assert.ok(geometry.panel.scrollHeight > geometry.panel.height, 'real scrollable narrow panel');
  for (const c of geometry.controls) { assert.ok(c.width >= 44 && c.height >= 44, c.name); assert.ok(c.right <= width + 8 + 1, c.name + ' fits'); }
  assert.equal(geometry.previewLive, 'off'); assert.ok(!geometry.status.includes('RRR'));
  await press(page, 'Cancel assistance'); const cancelled = await state(page, fact); unchanged(before, cancelled); released(cancelled);
  await press(page, 'Recover assistance');
  assert.equal(await page.locator('[data-assistive-preview]').textContent(), '', 'cancel discards provisional text');
  await press(page, 'Close assistance'); await start(page);
  await page.evaluate(() => window.commandPermission = false); await emit(page, 'R'.repeat(900), 0);
  const rejected = await state(page, fact); unchanged(cancelled, rejected); assert.equal(rejected.recoveryText, 'R'.repeat(900)); released(rejected);
  await press(page, 'Recover assistance');
  assert.equal(await page.locator('[data-assistive-preview]').textContent(), 'Uncommitted recovery text: ' + 'R'.repeat(900));
  assert.equal(await page.locator('[data-assistive-preview]').evaluate(e => getComputedStyle(e).userSelect), 'text');
  assert.equal(await page.locator('[data-assistive-input] section').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
  await emit(page, 'late', 1); unchanged(cancelled, await state(page, fact)); await finish(page, baseline, fact);
}));

test('MWX-C25 keyboard discovery and command search use shared semantic history', () => probe('keyboard-command', async (page, fact) => {
  const baseline = await mount(page); await select(page); const before = await state(page, fact);
  await page.keyboard.press('Escape');
  const entry = page.getByRole('button', { name: 'Editing assistance', exact: true });
  for (let i = 0; i < 25 && !await entry.evaluate(e => e === document.activeElement); i++) await page.keyboard.press(i > 0 && engine === 'webkit' ? 'Alt+Tab' : 'Tab');
  assert.equal(await entry.evaluate(e => e === document.activeElement), true); await page.keyboard.press('Enter');
  await page.getByRole('searchbox', { name: 'Search assistance commands', exact: true }).fill('Bold');
  assert.equal(await page.getByRole('button', { name: 'Italic', exact: true }).count(), 0); await page.keyboard.press('Enter');
  const s = await state(page, fact); assert.deepEqual(s.nodes[0].runs, [{ attributes: {}, text: 'a' }, { attributes: { bold: true }, text: 'lph' }, { attributes: {}, text: 'a' }]); assert.equal(s.history.undoGroups, before.history.undoGroups + 1);
  assert.equal(s.transport.length, 0); await page.keyboard.press('ControlOrMeta+z'); assert.equal((await state(page, fact)).text[0], 'alpha');
  await finish(page, baseline, fact);
}));

test('MWX-C26 touch stop waits for one final at the captured selection with undo/redo and save/reopen', () => probe('stop-final-durable', async (page, fact) => {
  const baseline = await mount(page); await start(page); const before = await state(page, fact);
  await emit(page, 'private partial', 0, 'provisional'); unchanged(before, await state(page, fact));
  await press(page, 'Stop assistance'); let s = await state(page, fact); unchanged(before, s); assert.equal(s.transport[0].stopped, 1); assert.equal(s.transport[0].aborted, false);
  // A newer caret cannot redirect the retained replacement target.
  await select(page, 5, 5); await emit(page, 'X', 1); await emit(page, 'DUPLICATE', 2);
  s = await state(page, fact); assert.equal(s.text[0], 'aXa'); assert.equal(s.history.undoGroups, 1); assert.equal(s.commands.filter(c => c.origin === 'assistive:final').length, 1);
  assert.equal(s.journal.filter(o => o === 'editac:local:assistive:final').length, 1); assert.equal(s.patches.filter(p => p.origin === 'editac:local:assistive:final' && p.update).length, 1); assert.equal(s.selection.focus.offset, 2); released(s);
  await page.keyboard.press('ControlOrMeta+z'); assert.equal((await state(page, fact)).text[0], 'alpha');
  await page.keyboard.press('ControlOrMeta+Shift+z'); assert.equal((await state(page, fact)).text[0], 'aXa');
  const reopened = await page.evaluate(() => window.inputFixture.reopen()); fact.reopened = reopened; assert.equal(reopened[0].runs.map(r => r.text).join(''), 'aXa');
  await finish(page, baseline, fact, true);
}));

for (const mode of ['cancel', 'readonly', 'permission', 'dispose', 'registration', 'foreign-focus', 'escape', 'hidden']) test(`MWX-C26/28 ${mode} fences partial and final results`, () => probe('fence-' + mode, async (page, fact) => {
  const baseline = await mount(page); await start(page); await emit(page, 'private partial', 0, 'provisional'); const before = await state(page, fact);
  if (mode === 'cancel') await press(page, 'Cancel assistance');
  else if (mode === 'escape') { await page.getByRole('button', { name: 'Stop assistance', exact: true }).focus(); await page.keyboard.press('Escape'); }
  else await page.evaluate(async mode => {
    if (mode === 'readonly') window.editor.setReadOnly(true);
    if (mode === 'permission') window.commandPermission = false;
    if (mode === 'dispose') await window.inputFixture.destroy();
    if (mode === 'registration') window.assistiveRegistration.dispose();
    if (mode === 'foreign-focus') { const input = document.createElement('input'); input.setAttribute('aria-label', 'Other work'); document.body.append(input); input.focus(); }
    if (mode === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
  }, mode);
  await emit(page, 'late partial', 1, 'provisional'); await emit(page, 'late final', 2);
  if (mode === 'dispose') { assert.deepEqual(await page.evaluate(() => window.inputFixture.audit()), { commands: before.commands.length, updates: before.patches.filter(p => p.update).length, hostActions: [] }); }
  else { const after = await state(page, fact); unchanged(before, after); released(after); if (mode === 'foreign-focus') assert.equal(await page.getByRole('textbox', { name: 'Other work' }).evaluate(e => e === document.activeElement), true); }
  await finish(page, baseline, fact, mode === 'dispose');
}));

for (const mode of ['permission-denied', 'unavailable', 'disconnected', 'reject', 'deleted-target']) test(`MWX-C26 ${mode} is nonmutating with explicit bounded recovery`, () => probe('failure-' + mode, async (page, fact) => {
  const baseline = await mount(page);
  if (mode === 'deleted-target') { await page.evaluate(() => { const f = window.inputFixture; f.select(f.ids[1], 0, 4); }); await press(page, 'Editing assistance'); await press(page, 'Start assistance'); }
  else await start(page);
  if (mode === 'reject') await page.evaluate(() => window.rejectCommand = true);
  if (mode === 'deleted-target') await page.evaluate(() => { const f = window.inputFixture; f.session.storage.commit({ kind: 'editor', origin: 'prepared-delete-target', commands: [{ type: 'join', first: f.ids[0], second: f.ids[1] }] }); });
  const before = await state(page, fact);
  if (mode === 'reject' || mode === 'deleted-target') await emit(page, 'recover me'); else await page.evaluate(reason => window.mockTransport.error(reason), mode);
  const after = await state(page, fact);
  // Rejected commit attempts are audited but never produce committed document/history/journal effects.
  for (const key of ['nodes', 'revision', 'history', 'journal', 'patches']) assert.deepEqual(after[key], before[key], key);
  assert.ok(['failed', 'stale'].includes(after.lifecycle.state)); released(after);
  if (mode === 'reject' || mode === 'deleted-target') assert.equal(after.recoveryText, 'recover me');
  await press(page, 'Recover assistance'); const recovered = await state(page, fact);
  for (const key of ['nodes', 'revision', 'history', 'journal', 'patches']) assert.deepEqual(recovered[key], before[key], key);
  await emit(page, 'late', 1); unchanged(recovered, await state(page, fact)); await finish(page, baseline, fact);
}));

for (const mode of ['absent', 'disabled', 'noHost', 'permissionDenied', 'noStop']) test(`MWX-C27/28 ${mode} keeps explicit baseline input fallback`, () => probe('fallback-' + mode, async (page, fact) => {
  const baseline = await mount(page, { [mode]: true }); await select(page, 5, 5); const before = await state(page, fact);
  if (mode === 'absent' || mode === 'disabled') {
    assert.equal(await page.locator('[data-assistive-input]').count(), 0); assert.equal(before.assistance, null); assert.deepEqual(await page.evaluate(() => window.assistanceListenerAdds), []);
  } else {
    await press(page, 'Editing assistance');
    if (mode === 'noHost') { assert.equal(await page.getByRole('button', { name: 'Start assistance', exact: true }).count(), 0); assert.match(await page.locator('[data-assistive-input]').textContent(), /Host assistance is unavailable.*Ordinary text input/); }
    else { const button = page.getByRole('button', { name: mode === 'noStop' ? 'Stop assistance' : 'Start assistance', exact: true }); assert.equal(await button.isDisabled(), true); const reason = await button.getAttribute('aria-describedby'); assert.match(await page.locator('#' + reason).textContent(), mode === 'noStop' ? /cannot stop.*Cancel assistance/ : /permission is unavailable.*ordinary text input/); }
    await press(page, 'Close assistance');
  }
  unchanged(before, await state(page, fact)); await select(page, 5, 5); await page.keyboard.type('!');
  const after = await state(page, fact); assert.equal(after.text[0], 'alpha!'); assert.equal(after.history.undoGroups, 1); assert.equal(after.transport.length, 0);
  await finish(page, baseline, fact);
}));

// The production session publishes starting before the prepared host is entered.
test('MWX-C26 pending start cancellation revokes callbacks before a returned handle exists', () => probe('pending-start', async (page, fact) => {
  const baseline = await mount(page);
  await page.evaluate(() => {
    const transport = window.mockTransport, original = transport.start.bind(transport);
    transport.start = (...args) => {
      window.stateAtHostStart = window.editor.assistive.session.status.state;
      const handle = original(...args); window.editor.assistive.session.cancel(); return handle;
    };
  });
  await start(page); assert.equal(await page.evaluate(() => window.stateAtHostStart), 'starting');
  const before = await state(page, fact); assert.equal(before.lifecycle.state, 'cancelled'); released(before);
  await emit(page, 'late partial', 0, 'provisional'); await emit(page, 'late final', 1); unchanged(before, await state(page, fact));
  assert.equal(before.history.undoGroups, 0); assert.equal(before.journal.length, 0); await finish(page, baseline, fact);
}));
