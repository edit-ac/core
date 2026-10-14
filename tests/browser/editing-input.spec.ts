import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { browserHarness } from './browser-harness.ts';
import { BrowserEditingDriver, browserInputSources } from '../editing/browser-driver.ts';
import { assertCheckpoint } from '../editing/driver.ts';
import { loadSuite, groupIds } from '../editing/fixture-loader.ts';

const corpus = loadSuite();
const binding = { ...corpus, recipes: corpus.recipes.filter(r => groupIds('input').includes(r.id)) };
const { probe, facts } = browserHarness('editing-input', 'fixtures/browser-input', {
  autoMount: false, sourcePaths: browserInputSources,
});
facts.binding = { group: 'input', recipes: binding.recipes.map(r => r.id), fixtureHashes: binding.hashes,
  guards: ['G01', 'G05', 'G09'], cases: ['REG-14', 'REG-16'],
  profile: 'v5 / real TextInput + renderer + selection + recovered storage / plain paragraph',
  clock: 'Date.now fixed at 42000; production explicit input history boundaries',
  scheduler: 'actual MutationObserver/microtasks and MessageChannel boundary; no fixed sleeps',
  evidenceLimits: 'Prepared real-DOM replay except explicitly named trusted WebDriver keyboard case; no OS IME/device qualification' };
facts.binding.profileSha256 = createHash('sha256').update(JSON.stringify(facts.binding)).digest('hex');
const initial = text => ({ blocks: [{ id: 'p1', kind: 'paragraph', text, hardBreaks: [], marks: [] }],
  selection: { anchor: { block: 'p1', offset: text.length }, focus: { block: 'p1', offset: text.length }, affinity: 'forward' }, pendingMarks: null });
async function mount(page, text = '') {
  await page.addInitScript(() => { Date.now = () => 42000; });
  // addInitScript applies on navigation; pin this already loaded fixture too.
  await page.evaluate(() => { Date.now = () => 42000; });
  const driver = new BrowserEditingDriver(page); await driver.mount(initial(text)); return driver;
}
async function observe(page, fact) {
  const s = await page.evaluate(async () => {
    const f = window.inputFixture; await f.settle();
    const state = await f.state(), native = getSelection();
    return { ...state, identity: f.engine.read().identity,
      anchor: native?.anchorNode ? f.selection.toModel(native.anchorNode, native.anchorOffset) : null,
      focus: native?.focusNode ? f.selection.toModel(native.focusNode, native.focusOffset) : null };
  });
  fact.snapshots.push(s); return s;
}
function assertInput(s, e) {
  assert.deepEqual(s.text, e.text, 'independent complete document');
  assert.deepEqual(s.dom, e.text, 'actual DOM projection');
  assert.deepEqual([s.anchor?.node, s.anchor?.offset, s.focus?.node, s.focus?.offset],
    [s.blocks[e.owner ?? 0], e.at, s.blocks[e.owner ?? 0], e.at], 'both mapped DOM caret endpoints');
  assert.equal(s.blocks[0], s.ids[0], 'original semantic identity retained');
  const local = s.patches.filter(p => p.update && p.origin.startsWith('editac:local:'));
  const remote = s.patches.filter(p => p.update && !p.origin.startsWith('editac:local:'));
  assert.equal(local.length, e.local, 'actual local commits/updates');
  assert.equal(remote.length, e.remote ?? 0, 'actual independent remote updates');
  assert.equal(s.journal.length, e.local + (e.remote ?? 0), 'actual durable journal records');
  assert.equal(s.history.undoGroups, e.local, 'native semantic undo groups');
  assert.equal(s.intents.filter(i => i.disposition === 'committed').length, e.local, 'committed owners');
  assert.equal(new Set(local.map(p => p.origin)).size, e.local, 'one update per distinct intent');
  assert.deepEqual(s.intents.filter(i => i.disposition === 'committed').map(i => i.origin), e.origins, 'actual intent origins');
  for (const p of local) {
    assert.ok(p.bytes > 0); assert.ok(s.journal.some(j => j.origin === p.origin && j.bytes > 0), 'persist same real update owner');
    assert.ok(s.intents.some(i => i.disposition === 'committed' && p.origin.endsWith(i.id)), 'update tied to terminal owner');
  }
  for (const i of s.intents) {
    assert.ok(i.id.startsWith(`${s.identity.documentId}/${s.identity.epoch}/`), 'document/epoch scoped identity');
    assert.ok(Number.isSafeInteger(i.generation) && i.generation > 0);
    assert.notEqual(i.disposition, 'native-pending', 'terminal owner after settling');
  }
  if (e.echo) assert.ok(s.trace.some(t => t.type === 'renderer-echo' && t.count > 0 && t.generation > 0), 'identified generation/renderer boundary');
  assert.deepEqual(s.errors, []); assert.equal(s.storage, 'localCommitted'); assert.equal(s.selectionSuspended, false);
}
function checkpoint(s, e, fact) {
  assertInput(s, e); fact.checkpoints = (fact.checkpoints ?? 0) + 1;
  for (const [name, corrupt] of [
    ['content', x => { x.text[0] += '?'; }], ['caret', x => { x.at++; }],
    ['duplicate-commit', x => { x.local++; }], ['remote-attribution', x => { x.remote = (x.remote ?? 0) + 1; }],
    ['intent-origin', x => { x.origins[0] = 'renderer'; }],
  ]) {
    const wrong = structuredClone(e); corrupt(wrong);
    assert.throws(() => assertInput(s, wrong), assert.AssertionError, `negative control ${name}`);
    fact.negativeControls = (fact.negativeControls ?? 0) + 1;
  }
}

test('SEQ-10: source recipe native fallback and identical next intent through shared driver', () => probe('SEQ-10', async (page, fact) => {
  await page.evaluate(() => { Date.now = () => 42000; });
  const driver = new BrowserEditingDriver(page), recipe = binding.recipes.find(r => r.id === 'SEQ-10');
  const results = await driver.replay(recipe);
  fact.provenance = 'prepared source recipe: real DOM mutation + actual input handlers/MutationObserver';
  fact.recipeHashes = binding.hashes;
  for (const [i, actual] of results.entries()) {
    fact.snapshots.push(actual); fact.checkpoints = (fact.checkpoints ?? 0) + 1;
    const expected = recipe.steps[i].expect;
    for (const corrupt of [e => { e.state.blocks[0].text += '?'; }, e => { e.state.selection.focus.offset++; },
      e => { e.effects.localCommits++; }, e => { e.state.blocks[0].id = 'wrong-owner'; }]) {
      const wrong = structuredClone(expected); corrupt(wrong);
      assert.throws(() => assertCheckpoint(actual.result, wrong), assert.AssertionError);
      fact.negativeControls = (fact.negativeControls ?? 0) + 1;
    }
  }
  assert.equal(results.length, 2);
  await assert.rejects(driver.replay({ ...recipe, requires: ['unsupported-native-profile'] }), /Unsupported browser capability/);
  await assert.rejects(driver.nativeInsert({ type: 'fabricated-engine-insert' }), /Unsupported browser action/);
}));

for (const beforeinput of ['missing', 'noncancelable']) for (const order of ['input-first', 'observer-first', 'observer-only']) {
  test(`REG-16/G01 ${beforeinput}/${order}: duplicate then deliberate identical native edit`, () => probe(`REG-16-${beforeinput}-${order}`, async (page, fact) => {
    const d = await mount(page);
    for (let i = 0; i < 2; i++) {
      await d.nativeInsert({ type: 'nativeInsert', text: 'a', range: initial('a'.repeat(i)).selection,
        beforeinput, notifications: order === 'observer-only' ? ['observer', 'observer'] : order === 'observer-first' ? ['observer', 'input', 'input'] : ['input', 'input', 'observer', 'observer'] });
      const expected = { text: ['a'.repeat(i + 1)], at: i + 1, local: i + 1,
        origins: Array(i + 1).fill(beforeinput === 'missing' ? 'native' : 'beforeinput') };
      checkpoint(await observe(page, fact), expected, fact);
      // Notifications without another DOM mutation must add no action.
      await page.evaluate(() => { const f = window.inputFixture; f.event('input', { inputType: 'insertText', data: 'a' }); f.event('input', { inputType: 'insertText', data: 'a' }); });
      checkpoint(await observe(page, fact), expected, fact);
    }
    fact.provenance = 'prepared missing/noncancelable notifications + real DOM mutation and observer delivery';
  }));
}

for (const order of ['end-before-key', 'key-before-end']) {
  test(`REG-14/G05 ${order}: composition commit Enter then deliberate browser Enter`, () => probe(`REG-14-${order}`, async (page, fact) => {
    await mount(page, 'alpha');
    await page.evaluate(() => {
      const f = window.inputFixture; f.event('compositionstart'); f.mutate('alpha字');
      f.event('compositionupdate', { data: '字' }); f.event('input', { inputType: 'insertCompositionText', data: '字', isComposing: true });
    });
    const buffered = await observe(page, fact);
    assert.deepEqual(buffered.text, ['alpha']); assert.deepEqual(buffered.dom, ['alpha字']);
    assert.equal(buffered.patches.filter(p => p.update).length, 0); assert.equal(buffered.journal.length, 0);
    assert.equal(buffered.history.undoGroups, 0); assert.equal(buffered.selectionSuspended, true);
    const prevented = await page.evaluate(order => {
      const f = window.inputFixture; let key;
      if (order === 'key-before-end') key = f.event('keydown', { key: 'Enter', isComposing: true });
      f.event('compositionend', { data: '字' }); f.event('input', { inputType: 'insertCompositionText', data: '字' });
      if (order === 'end-before-key') key = f.event('keydown', { key: 'Enter', isComposing: false });
      const before = f.event('beforeinput', { inputType: 'insertParagraph', cancelable: true });
      f.event('input', { inputType: 'insertParagraph' }); f.event('compositionend', { data: '字' });
      return { key: key.defaultPrevented, before: before.defaultPrevented };
    }, order);
    assert.deepEqual(prevented, { key: true, before: true });
    checkpoint(await observe(page, fact), { text: ['alpha字'], at: 6, local: 1, origins: ['composition'] }, fact);
    await page.evaluate(() => window.inputFixture.event('keyup', { key: 'Enter' }));
    await page.keyboard.press('Enter');
    checkpoint(await observe(page, fact), { text: ['alpha字', ''], owner: 1, at: 0, local: 2, origins: ['composition', 'key'] }, fact);
    await page.keyboard.type('a');
    checkpoint(await observe(page, fact), { text: ['alpha字', 'a'], owner: 1, at: 1, local: 3, origins: ['composition', 'key', 'key'] }, fact);
    fact.provenance = 'prepared composition/commit key; actual trusted WebDriver deliberate Enter and typed sentinel';
  }));
}

test('G05: no-keyup composition owner expires at dispatcher boundary', () => probe('G05-dispatcher-expiry', async (page, fact) => {
  await mount(page);
  await page.evaluate(() => {
    const f = window.inputFixture; f.event('compositionstart'); f.mutate('字'); f.event('compositionend', { data: '字' });
    const event = f.event('beforeinput', { inputType: 'insertParagraph', cancelable: true });
    if (!event.defaultPrevented) throw Error('Composition commit key escaped');
  });
  checkpoint(await observe(page, fact), { text: ['字'], at: 1, local: 1, origins: ['composition'] }, fact);
  await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null);
  }));
  await page.keyboard.press('Enter');
  checkpoint(await observe(page, fact), { text: ['字', ''], owner: 1, at: 0, local: 2, origins: ['composition', 'key'] }, fact);
  fact.provenance = 'prepared composition + actual MessageChannel lifetime boundary + trusted browser Enter';
}));

for (const order of ['native-before-echo', 'echo-before-native']) {
  test(`G09 ${order}: suppress only identified renderer records`, () => probe(`G09-${order}`, async (page, fact) => {
    await page.evaluate(() => { Date.now = () => 42000; });
    await page.waitForFunction(() => !!window.inputFixture);
    await page.evaluate(() => window.inputFixture.mount('', 'independent'));
    await page.evaluate(async order => {
      const f = window.inputFixture;
      const mutate = () => { f.mutate('a'); f.event('input', { inputType: 'insertText', data: 'a' }); };
      if (order === 'native-before-echo') { f.mutate('a'); } // record queued before renderer boundary
      // Actual peer update crosses the production renderer boundary synchronously.
      const remote = f.remote(0, 'R', f.ids[1]);
      if (order === 'echo-before-native') mutate();
      else f.event('input', { inputType: 'insertText', data: 'a' });
      await remote;
    }, order);
    const e = { text: ['a', 'Rindependent'], at: 1, local: 1, remote: 1, origins: ['native'], echo: true };
    checkpoint(await observe(page, fact), e, fact);
    await page.evaluate(() => { const f = window.inputFixture; f.event('input', { inputType: 'insertText', data: 'a' }); f.mutate('aa'); f.event('input', { inputType: 'insertText', data: 'a' }); });
    checkpoint(await observe(page, fact), { ...e, text: ['aa', 'Rindependent'], at: 2, local: 2, origins: ['native', 'native'] }, fact);
    fact.provenance = 'prepared native mutation mixed in same dispatcher turn with real external engine commit/renderer patch';
  }));
}

test('G01 trusted browser typing: two identical key cycles own two edits', () => probe('native-identical-keycycles', async (page, fact) => {
  await mount(page); await page.keyboard.type('a');
  checkpoint(await observe(page, fact), { text: ['a'], at: 1, local: 1, origins: ['key'] }, fact);
  await page.keyboard.type('a');
  const s = await observe(page, fact); checkpoint(s, { text: ['aa'], at: 2, local: 2, origins: ['key', 'key'] }, fact);
  assert.ok(s.trace.some(t => t.trusted && t.type === 'keydown'));
  fact.provenance = 'actual trusted WebDriver keyboard; browser mechanics, no native OS IME';
}));

test('G05: disposed composition generation drains without a late commit', () => probe('G05-disposed-generation', async (page, fact) => {
  const d = await mount(page, 'alpha');
  await page.evaluate(() => {
    const f = window.inputFixture;
    f.event('compositionstart'); f.mutate('alpha字');
    f.event('input', { inputType: 'insertCompositionText', data: '字', isComposing: true });
    f.protocol.dispose();
    f.event('compositionend', { data: '字' }); f.event('input', { inputType: 'insertCompositionText', data: '字' });
  });
  const settlement = await d.settle(), s = await observe(page, fact);
  assert.deepEqual(settlement.pending, []); assert.deepEqual(s.text, ['alpha']); assert.deepEqual(s.dom, ['alpha']);
  assert.equal(s.history.undoGroups, 0); assert.equal(s.journal.length, 0);
  assert.equal(s.patches.filter(p => p.update).length, 0); assert.equal(s.editable, 'false');
  assert.ok(s.intents.every(i => ['canceled', 'disposed'].includes(i.disposition)));
  assert.ok(s.intents.some(i => i.text === '字' && i.generation === 1 && i.disposition === 'disposed'));
  fact.checkpoints = 1; fact.provenance = 'prepared composition disposal with actual production generation/job cancellation';
}));
