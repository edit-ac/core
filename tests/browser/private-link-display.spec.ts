import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('private-link-display', 'fixtures/browser-private-link-display', { sourcePaths: [
  'packages/web/src/modules/references/display.ts', 'packages/web/src/modules/references.ts', 'packages/web/src/modules/links/contract.ts',
  'packages/web/src/modules/content.ts', 'packages/web/src/dom/render.ts', 'packages/web/src/surface.ts',
  'packages/web/src/index.ts', 'packages/web/src/modules/index.ts',
  'fixtures/browser-private-link-display/session.mjs', 'fixtures/browser-private-link-display/index.html'
] });
async function state(page, fact) {
  const value = await page.evaluate(() => window.inputFixture.state());
  // Keep durable diagnostics bounded; actual checkpoint equality is asserted below.
  fact.snapshots.push({ ...value, viewers: Object.fromEntries(Object.entries(value.viewers).map(([k, v]) => [k, { ...v, checkpoint: { bytes: v.checkpoint.length } }])) });
  assert.ok(fact.requests.every(url => new URL(url).hostname === '127.0.0.1' || url.startsWith('blob:http://127.0.0.1:')));
  for (const v of Object.values(value.viewers)) assert.deepEqual(v.errors, []);
  return value;
}
const empty = v => { assert.ok(v.titles.every(t => t === '')); assert.ok(v.previews.every(t => t === '')); assert.deepEqual(v.icons, []); assert.ok(!v.text.includes('Secret')); };
const unchanged = (before, after) => {
  for (const name of ['alice', 'bob']) {
    assert.deepEqual(after.viewers[name].nodes, before.viewers[name].nodes);
    assert.deepEqual(after.viewers[name].checkpoint, before.viewers[name].checkpoint);
    // Applying even an empty remote update advances the engine history revision.
    for (const field of ['undoGroups', 'redoGroups', 'retainedUpdateBytes']) assert.equal(after.viewers[name].history[field], before.viewers[name].history[field]);
    assert.deepEqual(after.viewers[name].commands, []);
    assert.ok(!new TextDecoder().decode(Uint8Array.from(after.viewers[name].checkpoint)).includes('Secret'));
  }
};
test('concurrent authorized and unauthorized replicas isolate display without shared writes or network lookup', () => probe('concurrent-isolation', async (page, fact) => {
  const before = await state(page, fact), a = before.viewers.alice, b = before.viewers.bob;
  assert.deepEqual(a.nodes, b.nodes); assert.deepEqual(a.titles, ['Secret Alice title']); empty(b);
  assert.deepEqual(a.labels, ['User-authored shared label']); assert.deepEqual(b.labels, a.labels);
  assert.equal(a.icons.length, 1); assert.ok(a.icons[0].startsWith('blob:'));
  assert.equal(a.pending.length + b.pending.length, 0);
  assert.match(await page.locator('#alice [data-private-reference]').getAttribute('aria-label'), /User-authored shared label.*Secret Alice title/);
  assert.equal(await page.locator('#alice [role=status]').getAttribute('aria-live'), 'polite');
  await page.evaluate(() => window.inputFixture.sync()); unchanged(before, await state(page, fact));
}));
test('two authorized principals render distinct scoped titles and icons over the same shared identity', () => probe('two-authorized', async (page, fact) => {
  const s = await state(page, fact); assert.deepEqual(s.viewers.alice.titles, ['Secret Alice title']); assert.deepEqual(s.viewers.bob.titles, ['Secret Bob title']);
  assert.notEqual(s.viewers.alice.icons[0], s.viewers.bob.icons[0]); assert.deepEqual(s.viewers.alice.nodes, s.viewers.bob.nodes);
}, { bobAuthorized: true }));
for (const action of ['principal', 'tenant', 'authority', 'permission', 'policy', 'revoke', 'logout', 'lock', 'title', 'icon', 'preview', 'context-error'])
  test(`${action} removes previously visible private fields and releases assets`, () => probe(`display-${action}`, async (page, fact) => {
    const before = await state(page, fact); await page.evaluate(action => window.inputFixture.change('alice', action), action);
    const after = await state(page, fact); empty(after.viewers.alice); empty(after.viewers.bob); unchanged(before, after);
    assert.deepEqual(after.viewers.alice.labels, ['User-authored shared label']); assert.ok(after.revoked.includes(before.viewers.alice.icons[0]));
  }));
for (const status of ['unavailable', 'forbidden', 'missing', 'locked', 'unsupported', 'canceled', 'stale'])
  test(`${status} uses accessible non-disclosing fallback`, () => probe(`fallback-${status}`, async (page, fact) => {
    const s = await state(page, fact); empty(s.viewers.alice); assert.deepEqual(s.viewers.alice.states, [['forbidden', 'missing'].includes(status) ? 'unavailable' : status]);
    assert.deepEqual(s.viewers.alice.labels, ['User-authored shared label']); assert.equal(s.viewers.alice.pending.length, 0);
    assert.ok(!(await page.locator('#alice [role=status]').textContent()).includes('Secret'));
  }, { status }));
test('explicit refresh is the only lookup origin, validates private outcome and preserves readonly document/history', () => probe('refresh-readonly', async (page, fact) => {
  const before = await state(page, fact); await page.evaluate(() => { window.inputFixture.readonly('alice'); window.inputFixture.refresh('alice'); });
  let s = await state(page, fact); assert.equal(s.viewers.alice.pending.length, 1); assert.equal(s.viewers.alice.pending[0].origin, 'explicit-refresh'); assert.equal(s.viewers.alice.pending[0].host.readonly, true);
  await page.evaluate(() => window.inputFixture.respond('alice')); await page.waitForFunction(() => !window.inputFixture.state().viewers.alice.busy);
  s = await state(page, fact); assert.deepEqual(s.viewers.alice.titles, ['Secret Alice title']); unchanged(before, s);
  assert.equal(await page.locator('#alice button').evaluate(e => e === document.activeElement || !e.disabled), true);
}, { cache: false }));
test('unauthorized explicit refresh performs zero outbound calls', () => probe('denied-refresh', async (page, fact) => {
  await page.evaluate(() => window.inputFixture.refresh('bob')); const s = await state(page, fact); empty(s.viewers.bob); assert.deepEqual(s.viewers.bob.pending, []);
}));
for (const action of ['principal', 'tenant', 'authority', 'session', 'permission', 'policy', 'revoke', 'lock', 'context-error'])
  test(`${action} cancels pending refresh and rejects an abort-ignoring result`, () => probe(`late-${action}`, async (page, fact) => {
    await page.evaluate(() => window.inputFixture.refresh('alice')); const before = await state(page, fact);
    await page.evaluate(action => { window.inputFixture.change('alice', action); window.inputFixture.respond('alice'); }, action);
    await page.waitForTimeout(0); const s = await state(page, fact); empty(s.viewers.alice); assert.deepEqual(s.viewers.alice.aborted, [true]); assert.equal(s.viewers.alice.busy, false); unchanged(before, s);
  }, { cache: false }));
test('silent authority drift at completion is rechecked even without a subscription notification', () => probe('silent-switch', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.change('alice', 'principal', false); f.respond('alice'); });
  await page.waitForFunction(() => !window.inputFixture.state().viewers.alice.busy); empty((await state(page, fact)).viewers.alice);
}, { cache: false }));
test('a malicious cache cannot reuse another viewer request envelope', () => probe('wrong-cache-envelope', async (page, fact) => {
  await page.evaluate(() => { window.inputFixture.refresh('alice'); window.inputFixture.badCache('bob'); }); empty((await state(page, fact)).viewers.bob);
}));
test('offline cached capability is visible only until its finite lease expires', () => probe('offline-lease', async (page, fact) => {
  const before = await state(page, fact); assert.deepEqual(before.viewers.alice.titles, ['Secret Alice title']);
  await page.waitForFunction(() => window.inputFixture.state().viewers.alice.titles.every(t => t === ''));
  const after = await state(page, fact); empty(after.viewers.alice); assert.deepEqual(after.viewers.alice.states, ['stale']); assert.deepEqual(after.viewers.alice.pending, []); unchanged(before, after);
}, { lease: 1200 }));
for (const icon of ['svg', 'huge', 'none']) test(`${icon} icon never creates a browser asset request`, () => probe(`asset-${icon}`, async (page, fact) => {
  const s = await state(page, fact); assert.deepEqual(s.viewers.alice.titles, ['Secret Alice title']); assert.deepEqual(s.assets, []); assert.deepEqual(s.viewers.alice.icons, []);
}, { icon }));
test('reentrant asset callback revocation cannot resurrect stale display', () => probe('reentrant-revoke', async (page, fact) => {
  const before = await state(page, fact); await page.evaluate(() => window.inputFixture.reentrant('alice')); const s = await state(page, fact); empty(s.viewers.alice); assert.equal(s.assets.length, before.assets.length); assert.deepEqual(s.revoked, s.assets);
}));
test('literal unsafe-looking title is inert and remote icon handles are rejected', () => probe('inert-metadata', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.respond('alice', 'available', { metadata: { kind: 'private', targetId: f.viewers.alice.pending[0].request.target.targetId, display: { title: '<img src=https://evil.invalid onerror=alert(1)>' } } }); });
  await page.waitForFunction(() => !window.inputFixture.state().viewers.alice.busy);
  assert.equal(await page.locator('#alice [data-private-title] img, #alice script').count(), 0); assert.ok((await state(page, fact)).viewers.alice.titles[0].startsWith('<img'));
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.respond('alice', 'available', { metadata: { kind: 'private', targetId: f.viewers.alice.pending.at(-1).request.target.targetId, display: { title: 'Secret', iconAsset: 'https://evil.invalid/icon' } } }); });
  await page.waitForFunction(() => !window.inputFixture.state().viewers.alice.busy); empty((await state(page, fact)).viewers.alice);
}, { cache: false }));
test('user reference replacement sync preserves authored text/target and cancels old result', () => probe('shared-edit', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.replace('alice', 'Edited shared label', 'ac://team-1/23456789-2345-4234-8234-23456789abcd'); f.sync(); f.respond('alice'); });
  await page.waitForTimeout(0); const s = await state(page, fact); assert.deepEqual(s.viewers.alice.nodes, s.viewers.bob.nodes);
  assert.ok(s.viewers.alice.labels.includes('Edited shared label')); assert.ok(s.viewers.bob.labels.includes('Edited shared label')); empty(s.viewers.bob);
  assert.deepEqual(s.viewers.alice.aborted, [true]); assert.ok(!s.viewers.alice.text.includes('Secret'));
}, { cache: false }));
test('long valid user-authored labels survive request bookkeeping', () => probe('long-label', async (page, fact) => {
  const s = await state(page, fact); assert.deepEqual(s.viewers.alice.titles, ['Secret Alice title']); assert.deepEqual(s.viewers.alice.labels, ['x'.repeat(512)]);
}, { label: 'x'.repeat(512) }));
test('explicit cancel clears busy/display and rejects a late result', () => probe('cancel', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.cancel('alice'); f.respond('alice'); }); await page.waitForTimeout(0);
  const s = await state(page, fact); empty(s.viewers.alice); assert.deepEqual(s.viewers.alice.aborted, [true]); assert.equal(s.viewers.alice.busy, false);
}));
test('disposal removes subscriptions/assets and late completion cannot revive viewer', () => probe('dispose', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.refresh('alice'); f.dispose('alice'); f.dispose('alice'); f.respond('alice'); }); await page.waitForTimeout(0);
  const s = await state(page, fact); empty(s.viewers.alice); assert.equal(s.viewers.alice.listeners, 0); assert.equal(s.viewers.alice.released, 1); assert.deepEqual(s.viewers.alice.aborted, [true]); assert.equal(s.viewers.bob.listeners, 1); assert.deepEqual(s.revoked, s.assets);
}));
test('recovery replay and ordinary remote editing never initiate lookup', () => probe('no-call-replay-remote', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture; f.replay('alice'); f.replace('bob'); f.sync('bob', 'alice'); });
  const s = await state(page, fact); assert.deepEqual(s.viewers.alice.pending, []); assert.deepEqual(s.viewers.bob.pending, []); assert.deepEqual(s.viewers.alice.nodes, s.viewers.bob.nodes);
}));
for (const status of ['reject', 'locked', 'forbidden', 'missing', 'unsupported']) test(`refresh ${status} completes with safe fallback`, () => probe(`refresh-${status}`, async (page, fact) => {
  await page.evaluate(status => { const f = window.inputFixture; f.refresh('alice'); f.respond('alice', status); }, status);
  await page.waitForFunction(() => !window.inputFixture.state().viewers.alice.busy); empty((await state(page, fact)).viewers.alice);
}, { cache: false }));
test('pending refresh times out and aborts the host without stealing focus', () => probe('refresh-timeout', async (page, fact) => {
  await page.evaluate(() => window.inputFixture.refresh('alice'));
  await page.locator('#alice button').focus(); assert.equal(await page.locator('#alice button').evaluate(e => e === document.activeElement), true);
  await page.waitForFunction(() => window.inputFixture.state().viewers.alice.aborted[0] === true, { timeout: 15000 });
  const s = await state(page, fact); empty(s.viewers.alice); assert.equal(s.viewers.alice.busy, false); assert.deepEqual(s.viewers.alice.commands, []);
  assert.equal(await page.locator('#alice button').evaluate(e => e === document.activeElement), true);
}, { cache: false }));
