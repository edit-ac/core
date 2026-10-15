import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('link-activation', 'fixtures/browser-link-activation', { sourcePaths: [
  'packages/web/src/modules/links/activation.ts', 'packages/web/src/modules/links/contract.ts', 'packages/web/src/modules/references/display.ts', 'packages/web/src/dom/render.ts', 'packages/web/src/surface.ts',
  'tests/link-activation.test.mjs', 'fixtures/browser-link-activation/session.mjs', 'fixtures/browser-link-activation/index.html'
] });
async function state(page, fact) { const s = await page.evaluate(() => window.inputFixture.state()); fact.snapshots.push({ ...s, bytes: s.bytes.length }); assert.equal(s.resolves, 0); assert.ok(fact.requests.every(u => new URL(u).hostname === '127.0.0.1')); return s; }
const change = (page, action) => page.evaluate(action => window.inputFixture.change(action), action);
test('real renderer click ignores stale displayed href and preserves intended public URL', () => probe('stored-public-identity', async (page, fact) => {
  const before = await state(page, fact); await change(page, 'metadata'); await page.locator('#editor a').click(); const after = await state(page, fact);
  assert.equal(after.calls[0].locator, 'https://example.test/original?q=intentional#part'); assert.deepEqual(after.results, ['available']); assert.deepEqual(after.bytes, before.bytes);
}));
test('real readonly surface permits authorized private deep navigation and safe copy', () => probe('readonly-private-deep-copy', async (page, fact) => {
  const before = await state(page, fact); await change(page, 'readonly'); await change(page, 'deep'); await page.locator('[data-private-title]').click(); await change(page, 'copy'); const after = await state(page, fact);
  assert.deepEqual(after.calls.map(c => c.kind), ['open-private', 'copy-locator']); assert.ok(after.calls.every(c => c.locator === 'myapp://team/document-1')); assert.deepEqual(after.bytes, before.bytes);
}));
for (const [action, expected] of [['revoke','forbidden'], ['locked','locked'], ['credentials','unsupported']]) test(`real private presenter ${action} denies click`, () => probe('private-' + action, async (page, fact) => {
  const before = await state(page, fact); await change(page, action); await page.locator('[data-private-title]').click(); const after = await state(page, fact);
  assert.deepEqual(after.results, [expected]); assert.deepEqual(after.calls, []); assert.deepEqual(after.bytes, before.bytes);
}));
test('real engine edit makes a previously captured private click stale', () => probe('captured-edit', async (page, fact) => {
  await change(page, 'capture'); await change(page, 'edit'); const before = await state(page, fact); await change(page, 'old-click'); const after = await state(page, fact);
  assert.deepEqual(after.results, ['stale']); assert.deepEqual(after.calls, []); assert.deepEqual(after.bytes, before.bytes);
}));
test('disposed click binding releases the listener', () => probe('disposed-binding', async (page, fact) => {
  await change(page, 'dispose'); await page.locator('[data-private-title]').click(); const after = await state(page, fact); assert.deepEqual(after.calls, []); assert.deepEqual(after.results, []);
}));
