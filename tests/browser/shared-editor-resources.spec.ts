import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { sharedResourceSources } from '../../scripts/shared-resource-sources.mjs';

const sources = [...sharedResourceSources(), 'scripts/shared-resource-sources.mjs', 'tests/consumers/shared-resources/index.html', 'tests/consumers/shared-resources/session.mjs',
  'packages/core/src/index.ts', 'packages/markdown/src/index.ts', 'packages/web/src/editor.ts',
  'packages/web/src/entry.ts', 'packages/web/src/modules/math.ts', 'packages/web/src/modules/math-renderer.ts',
  'tests/browser/fixture-server.mjs', 'scripts/shared-resource-contract.mjs'];
const { probe } = browserHarness('shared-resources', 'tests/consumers/shared-resources', {
  markdown: true, autoMount: false, testFile: 'tests/browser/shared-editor-resources.spec.ts', assertSourcesUnchanged: true, sourcePaths: sources, serverOptions: { recordRequests: true },
  beforeNavigate: page => page.addInitScript(() => {
    window.runtimeObservations = { streaming: 0, buffered: 0, wasmFetches: [] };
    const stream = WebAssembly.instantiateStreaming, buffer = WebAssembly.instantiate, fetch = window.fetch;
    WebAssembly.instantiateStreaming = function (...args) { window.runtimeObservations.streaming++; return stream.apply(this, args); };
    WebAssembly.instantiate = function (...args) { window.runtimeObservations.buffered++; return buffer.apply(this, args); };
    window.fetch = function (input, ...args) { const url = String(input instanceof Request ? input.url : input); if (url.includes('.wasm')) window.runtimeObservations.wasmFetches.push(url); return fetch.call(this, input, ...args); };
  }),
  cleanup: page => page.evaluate(() => window.shared?.cleanup()),
});
async function fresh(page) {
  await page.waitForFunction(() => !!window.shared);
  await page.evaluate(() => window.shared.seed());
  await page.reload(); await page.waitForFunction(() => !!window.shared);
}
async function ready(page, keys) { await page.evaluate(keys => Promise.all(keys.map(key => window.shared.ready(key))), keys); }
async function counts(page) { return page.evaluate(() => ({ ...window.runtimeObservations, sessions: window.shared.state() })); }
function oneCore(result) {
  assert.equal(result.wasmFetches.filter(url => url.includes('editac_wasm_bg.wasm')).length, 1);
  assert.equal(result.streaming, 1 + result.wasmFetches.filter(url => url.includes('markdown')).length);
  assert.equal(result.buffered, 0);
}

for (const order of [['description', 'comment'], ['comment', 'description']]) {
  test(`SHR-01 concurrent equal task mounts isolate edit/history/save/destroy (${order.join('/')})`, () => probe(`SHR-01-${order[0]}`, async (page, fact) => {
    fact.requirement = 'SHR-01'; await fresh(page);
    const keys = await page.evaluate(order => order.map(name => window.shared.mount(name)), order); await ready(page, keys);
    const before = await page.evaluate(keys => keys.map(key => ({ identity: window.shared.get(key).read().identity, text: window.shared.text(key), callbacks: window.shared.observations.callbacks[key] })), keys);
    assert.notEqual(before[0].identity.documentId, before[1].identity.documentId);
    await page.evaluate(key => window.shared.append(key, ' private 😀'), keys[0]);
    assert.equal(await page.evaluate(key => window.shared.text(key), keys[1]), order[1]);
    await page.locator(`#${keys[0]}`).click(); await page.keyboard.press('ControlOrMeta+z');
    assert.equal(await page.evaluate(key => window.shared.text(key), keys[0]), order[0]);
    await page.evaluate(key => window.shared.append(key, ' saved'), keys[0]);
    const destroyed = await page.evaluate(key => window.shared.destroy(key), keys[0]); assert.equal(destroyed.unsaved, false);
    assert.equal(await page.evaluate(key => window.shared.observations.callbacks[key], keys[1]), before[1].callbacks, 'A sibling must not receive another document save/destroy callback');
    await page.evaluate(key => { window.shared.get(key).setReadOnly(true); }, keys[1]);
    await assert.rejects(page.evaluate(key => window.shared.append(key, ' forbidden'), keys[1]), /read-only/);
    const reopened = await page.evaluate(name => window.shared.mount(name), order[0]); await ready(page, [reopened]);
    assert.equal(await page.evaluate(key => window.shared.text(key), reopened), `${order[0]} saved`);
    assert.equal(await page.evaluate(key => window.shared.text(key), keys[1]), order[1]);
    await page.evaluate(key => { window.shared.get(key).setReadOnly(false); window.shared.append(key, ' survivor'); }, keys[1]);
    await page.evaluate(() => window.shared.cleanup());
    const result = await counts(page); oneCore(result); assert.equal(result.sessions.recovered, 3); assert.equal(result.sessions.released, 3);
    assert.equal(result.sessions.nativeHandles.live, 0); assert.equal(result.sessions.nativeHandles.restored, result.sessions.nativeHandles.freed);
    assert.deepEqual(result.sessions.live, []); assert.equal(result.sessions.roots, 0); assert.deepEqual(result.sessions.late, []);
    assert.equal(result.wasmFetches.some(url => url.includes('markdown')), false);
    assert(!fact.requests.some(url => /\/markdown\/|math-renderer|katex/.test(url)), 'Disabled-only imports/requests must omit optional assets'); fact.snapshots.push({ before, destroyed, result });
  }));
}
for (const order of [['description', 'comment'], ['comment', 'description']]) {
  test(`SHR-02 mixed optional/plain configs remain scoped (${order.join('/')})`, () => probe(`SHR-02-${order[0]}`, async (page, fact) => {
    fact.requirement = 'SHR-02'; await fresh(page);
    const keys = await page.evaluate(async order => { const optional = await window.shared.markdown(); return order.map(name => window.shared.mount(name, name === 'description' ? { optional } : { preset: 'minimal' })); }, order); await ready(page, keys);
    for (const [index, key] of keys.entries()) {
      await page.locator(`#${key}`).click(); await page.keyboard.press('ControlOrMeta+End');
      const result = await page.evaluate(key => { const e = window.shared.get(key); return { outcome: e.paste({ getData: mime => mime === 'text/plain' ? '**private**' : '' }), snapshot: e.read() }; }, key);
      assert.equal(result.outcome.disposition, 'committed');
      const runs = result.snapshot.visible.filter(n => n.kind === 'block').flatMap(n => n.runs);
      if (order[index] === 'description') assert(runs.some(run => run.text.includes('private') && run.attributes.bold === true));
      else { assert(runs.some(run => run.text.includes('**private**'))); assert(!runs.some(run => run.attributes.bold)); }
      fact.snapshots.push(result);
    }
    const comment = keys[order.indexOf('comment')], description = keys[order.indexOf('description')];
    await page.evaluate(key => window.shared.get(key).setReadOnly(true), comment);
    await assert.rejects(page.evaluate(key => window.shared.append(key, 'forbidden'), comment), /read-only/);
    await page.evaluate(key => window.shared.append(key, ' authorized'), description);
    const result = await counts(page); oneCore(result); assert.equal(result.wasmFetches.filter(url => url.includes('markdown')).length, 1);
    fact.snapshots.push(result);
  }));
}
test('SHR-02 two enabled optional consumers coalesce code and parser initialization', () => probe('SHR-02-two-optional', async (page, fact) => {
  fact.requirement = 'SHR-02'; await fresh(page);
  const keys = await page.evaluate(async () => { const [a, b] = await Promise.all([window.shared.markdown(), window.shared.markdown()]); return [window.shared.mount('description', { optional: a }), window.shared.mount('comment', { optional: b })]; });
  await ready(page, keys); await page.evaluate(key => window.shared.destroy(key), keys[0]);
  await page.evaluate(key => window.shared.append(key, ' survivor'), keys[1]); await page.evaluate(key => window.shared.flush(key), keys[1]);
  const result = await counts(page); oneCore(result); assert.equal(result.wasmFetches.filter(url => url.includes('markdown')).length, 1); assert.equal(result.sessions.recovered - result.sessions.released, 1); fact.snapshots.push(result);
}));

test('SHR-03 disposed initialization waiter releases its late real session without poisoning survivor', () => probe('SHR-03-disposed-waiter', async (page, fact) => {
  fact.requirement = 'SHR-03'; await fresh(page);
  let resume; const gate = new Promise(resolve => { resume = resolve; }); let requested; const seen = new Promise(resolve => { requested = resolve; });
  await page.route('**/core/wasm/editac_wasm_bg.wasm', async route => { requested(); await gate; await route.continue(); });
  const keys = await page.evaluate(() => ['description', 'comment'].map(name => window.shared.mount(name)));
  await seen;
  const destroyed = await page.evaluate(key => window.shared.destroy(key, 'report'), keys[0]); assert.equal(destroyed.unsaved, false);
  resume(); await ready(page, [keys[1]]);
  await page.waitForFunction(() => window.shared.observations.released === 1);
  await page.evaluate(key => window.shared.append(key, ' survivor'), keys[1]); await page.evaluate(key => window.shared.flush(key), keys[1]);
  await page.evaluate(() => window.shared.cleanup()); const result = await counts(page); oneCore(result);
  assert.equal(result.sessions.recovered, 2); assert.equal(result.sessions.released, 2); assert.equal(result.sessions.nativeHandles.live, 0); assert.equal(result.sessions.nativeHandles.restored, result.sessions.nativeHandles.freed); assert.deepEqual(result.sessions.late, []); assert.equal(result.sessions.roots, 0); fact.snapshots.push({ destroyed, result });
}));

test('SHR-03 shared runtime failure settles both editors and explicit remount retries', () => probe('SHR-03-failure-retry', async (page, fact) => {
  fact.requirement = 'SHR-03'; await fresh(page); let attempts = 0;
  await page.route('**/core/wasm/editac_wasm_bg.wasm', route => ++attempts === 1 ? route.fulfill({ status: 503, body: 'prepared local failure' }) : route.continue());
  const failed = await page.evaluate(async () => { const keys = ['description', 'comment'].map(name => window.shared.mount(name)); const outcomes = await Promise.allSettled(keys.map(key => window.shared.ready(key))); const states = keys.map(key => window.shared.get(key).state.phase); await window.shared.cleanup(); return { outcomes: outcomes.map(o => o.status), states }; });
  assert.deepEqual(failed.outcomes, ['rejected', 'rejected']); assert.deepEqual(failed.states, ['failed', 'failed']); assert.equal(attempts, 1);
  const keys = await page.evaluate(() => ['description', 'comment'].map(name => window.shared.mount(name))); await ready(page, keys);
  await page.evaluate(key => window.shared.append(key, ' retry'), keys[1]); await page.evaluate(() => window.shared.cleanup());
  const result = await counts(page); assert.equal(attempts, 2); assert.equal(result.sessions.recovered, 2); assert.equal(result.sessions.released, 2); assert.deepEqual(result.sessions.late, []); fact.snapshots.push({ failed, result, attempts });
}));

test('SHR-03 repeated destroy/remount preserves flushed content with bounded live sessions', () => probe('SHR-03-remount', async (page, fact) => {
  fact.requirement = 'SHR-03'; await fresh(page);
  const survivor = await page.evaluate(() => window.shared.mount('comment')); await ready(page, [survivor]);
  const baseline = (await counts(page)).sessions;
  assert.equal(baseline.roots, 1); assert.equal(baseline.nativeHandles.live, 1);
  const samples = await page.evaluate(async () => { const f = window.shared, samples = []; for (let i = 0; i < 6; i++) { const key = f.mount('description'); await f.ready(key); f.append(key, String(i)); const report = await f.destroy(key, 'flush'); samples.push({ ...f.state(), unsaved: report.unsaved }); } return samples; });
  fact.snapshots.push({ baseline, samples });
  // Current input controllers may own additional accessible sibling controls.
  // Remount must return to the exact surviving editor footprint, then to zero.
  assert(samples.every(s => s.recovered - s.released === 1 && s.roots === 1 && s.domNodes === baseline.domNodes && s.nativeHandles.live === 1 && !s.unsaved));
  const key = await page.evaluate(() => window.shared.mount('description')); await ready(page, [key]); assert.equal(await page.evaluate(key => window.shared.text(key), key), 'description012345');
  await page.evaluate(key => window.shared.append(key, ' still live'), survivor); await page.evaluate(() => window.shared.cleanup()); const result = await counts(page); oneCore(result); assert.equal(result.sessions.recovered, result.sessions.released); assert.equal(result.sessions.nativeHandles.live, 0); assert.equal(result.sessions.domNodes, 0); assert.equal(result.sessions.nativeHandles.restored, result.sessions.nativeHandles.freed); fact.snapshots.push({ samples, result });
}));

test('SHR-07 one generated owner rejects conflicting explicit core and Markdown URLs', () => probe('SHR-07-urls', async (page, fact) => {
  fact.requirement = 'SHR-07'; await fresh(page);
  const result = await page.evaluate(async () => {
    const { init } = await import('@edit-ac/core'); const { initMarkdown } = await import('@edit-ac/markdown');
    const a = init('/core/wasm/editac_wasm_bg.wasm'), b = init('/core/wasm/editac_wasm_bg.wasm');
    const c = initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'), d = initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm');
    const same = [a === b, c === d]; await Promise.all([a, b, c, d]);
    const rejected = await Promise.allSettled([init('/core/wasm/editac_wasm_bg.wasm?other-build'), initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm?other-build')]);
    return { same, rejected: rejected.map(r => r.status) };
  });
  assert.deepEqual(result, { same: [true, true], rejected: ['rejected', 'rejected'] }); oneCore(await counts(page)); fact.snapshots.push(result);
}));

for (const disposedFirst of [true, false]) test(`SHR-08 concurrent optional rendering isolates private results and teardown (${disposedFirst})`, () => probe(`SHR-08-${disposedFirst}`, async (page, fact) => {
  fact.requirement = 'SHR-08';
  const result = await page.evaluate(async disposedFirst => {
    const { mathRenderer, mathAtom } = await import('/web/modules/math.js');
    const content = value => { const atom = mathAtom(value); return { type: 'editac.math', version: 1, kind: 'inline-atom', text: atom.text, attributes: atom.attributes['module:editac.math'][1] }; };
    const a = document.createElement('span'), b = document.createElement('span'); document.body.append(a, b);
    const first = mathRenderer().mount(a, content('privateA')), second = mathRenderer().mount(b, content('privateB'));
    if (disposedFirst) first.dispose(); else first.update(content(String.raw`\href{https://private.invalid}{secret}`));
    await import('/web/modules/math-renderer.js'); await new Promise(resolve => requestAnimationFrame(resolve));
    const before = { a: a.textContent, b: b.textContent, aMath: a.querySelectorAll('math').length, bMath: b.querySelectorAll('math').length };
    // Macro definitions/options must not persist into another call/renderer.
    first.dispose(); second.update(content(String.raw`\gdef\privateMacro{secret}`)); await Promise.resolve();
    const denied = b.dataset.mathState;
    second.update(content('survivor')); await new Promise(resolve => requestAnimationFrame(resolve));
    const survivor = { text: b.textContent, math: b.querySelectorAll('math').length };
    second.dispose(); const empty = [a.childNodes.length, b.childNodes.length]; a.remove(); b.remove();
    return { before, denied, survivor, empty, styles: document.querySelectorAll('link[rel=stylesheet],style').length };
  }, disposedFirst);
  assert.equal(result.before.aMath, 0); assert.equal(result.before.bMath, 1); assert(!result.before.b.includes('privateA')); assert(!result.before.a.includes('privateB'));
  assert.equal(result.denied, 'source'); assert.equal(result.survivor.math, 1); assert.deepEqual(result.empty, [0, 0]); assert.equal(result.styles, 0);
  assert.equal(fact.requests.filter(url => url.endsWith('/modules/vendor/katex.mjs')).length, 1); fact.snapshots.push(result);
}));


test('SHR-03 pending failed save is reported while the sibling remains durable and editable', () => probe('SHR-03-pending-save', async (page, fact) => {
  fact.requirement = 'SHR-03'; await fresh(page);
  const keys = await page.evaluate(() => ['description', 'comment'].map(name => window.shared.mount(name))); await ready(page, keys);
  const result = await page.evaluate(async keys => {
    const f = window.shared, add = IDBObjectStore.prototype.add, failedDatabase = f.records.get('description').databaseName;
    IDBObjectStore.prototype.add = function (...args) { if (this.name === 'updates' && this.transaction.db.name === failedDatabase) throw new DOMException('prepared scoped save failure', 'QuotaExceededError'); return add.apply(this, args); };
    try {
      f.append(keys[0], ' unacknowledged'); let failure;
      try { await f.flush(keys[0]); } catch (error) { failure = error.message; }
      const report = await f.destroy(keys[0], 'report');
      f.append(keys[1], ' durable survivor'); await f.flush(keys[1]);
      const siblingText = f.text(keys[1]), siblingPhase = f.get(keys[1]).state.phase;
      return { failure, unsaved: report.unsaved, pendingUpdates: report.recovery.unsavedUpdates.length, checkpointBytes: report.recovery.checkpoint.bytes.length, siblingText, siblingPhase };
    } finally { IDBObjectStore.prototype.add = add; }
  }, keys);
  fact.snapshots.push(result); assert(result.failure); assert.equal(result.unsaved, true); assert(result.pendingUpdates > 0 && result.checkpointBytes > 0);
  assert.equal(result.siblingText, 'comment durable survivor'); assert.equal(result.siblingPhase, 'ready');
  await page.evaluate(key => window.shared.destroy(key), keys[1]);
  const reopened = await page.evaluate(() => window.shared.mount('comment')); await ready(page, [reopened]); assert.equal(await page.evaluate(key => window.shared.text(key), reopened), 'comment durable survivor');
}));

test('SHR-03 shared optional failure settles both waiters and retries without another core owner', () => probe('SHR-03-optional-retry', async (page, fact) => {
  fact.requirement = 'SHR-03'; await fresh(page); let attempts = 0;
  await page.route('**/markdown/wasm/editac_markdown_wasm_bg.wasm', route => ++attempts === 1 ? route.fulfill({ status: 503, body: 'prepared optional failure' }) : route.continue());
  const failed = await page.evaluate(async () => (await Promise.allSettled([window.shared.markdown(), window.shared.markdown()])).map(result => result.status));
  assert.deepEqual(failed, ['rejected', 'rejected']); assert.equal(attempts, 1);
  const keys = await page.evaluate(async () => { const [a, b] = await Promise.all([window.shared.markdown(), window.shared.markdown()]); return [window.shared.mount('description', { optional: a }), window.shared.mount('comment', { optional: b })]; }); await ready(page, keys);
  await page.evaluate(key => window.shared.destroy(key), keys[0]); await page.evaluate(key => window.shared.append(key, ' retry survivor'), keys[1]); await page.evaluate(() => window.shared.cleanup());
  const result = await counts(page); assert.equal(attempts, 2); assert.equal(result.streaming, 2); assert.equal(result.wasmFetches.filter(url => url.includes('editac_wasm_bg.wasm')).length, 1); assert.equal(result.sessions.recovered, result.sessions.released); fact.snapshots.push({ failed, attempts, result });
}));
