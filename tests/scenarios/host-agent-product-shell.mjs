import assert from 'node:assert/strict';
import { createTranscript } from '../../examples/host-agent-product/model.mjs';
export async function modelCases(check) {
  await check('retention', () => {
    const t = createTranscript(); for (let i = 0; i < 100; i++) t.append('prose', String(i));
    const s = t.snapshot(); assert.equal(s.entries.length, 64); assert.equal(s.dropped, 36);
    assert.deepEqual(s.entries.map(e => e.text), Array.from({ length: 64 }, (_,i) => String(i + 36)));
  });
  await check('text-bound', () => {
    const t = createTranscript(); t.append('result', 'x'.repeat(9000));
    assert.equal(t.snapshot().entries[0].text, 'x'.repeat(4096)); assert.equal(t.snapshot().entries[0].truncated, true);
  });
  await check('detached-snapshot', () => {
    const t = createTranscript(); t.append('request','one'); const s = t.snapshot(); t.append('result','two');
    assert.equal(s.entries.length, 1); assert.throws(() => s.entries.pop(), TypeError); assert.throws(() => { s.entries[0].text = 'forged'; }, TypeError);
  });
  await check('invalid-input', () => {
    const t = createTranscript(); for (const args of [['apply','text'],['result',{}],['notice',null]]) assert.throws(() => t.append(...args), TypeError);
    assert.equal(t.snapshot().entries.length, 0);
  });
  await check('clear', () => {
    const t = createTranscript(); const first = t.append('notice','before'); t.clear();
    assert.deepEqual(t.snapshot(), { entries: [], dropped: 0 }); assert.ok(t.append('notice','after') > first);
  });
}
export async function browserCases({ page, server, check, fixture, facts }) {
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== server.url) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(server.url); await page.getByText('No authorized tools available (no services installed).', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const { init } = await import('/core/index.js'); const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
    window.shellSentinel = runtime.createEngine({ profile: 'v5', documentId: '81000000-0000-4000-8000-000000000014', epoch: '82000000-0000-4000-8000-000000000014', nodes: [{ text: 'Independent sentinel 😀' }] });
  });
  // Public read carries consumable changedNodes; drain initial construction notification.
  await page.evaluate(() => window.shellSentinel.read());
  const oracle = () => page.evaluate(async () => ({ checkpoint: window.shellSentinel.checkpoint(), semantic: window.shellSentinel.read(), databases: (await indexedDB.databases()).map(d => d.name).sort() }));
  const before = await oracle();
  await check('regions-and-identity', async () => {
    assert.equal(await page.getByRole('region').count(), 4);
    for (const name of ['Host authority','Document identity','Tool requests and results','Human document view']) assert.equal(await page.getByRole('region', { name }).count(), 1);
    assert.equal(await page.locator('#actor').textContent(), fixture.actorId); assert.equal(await page.locator('#document').textContent(), fixture.documentId); assert.equal(await page.locator('#epoch').textContent(), fixture.epoch);
    assert.match(await page.locator('#connection').textContent(), /Not connected/); assert.match(await page.locator('#human-state').textContent(), /Unavailable/);
    assert.equal(await page.locator('[contenteditable]').count(), 0);
  });
  await check('inert-prose', async () => {
    assert.equal(await page.locator('#prose').textContent(), fixture.prose);
    assert.equal(await page.locator('#prose img, #prose a, #transcript img, #transcript a, #transcript svg').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined); assert.deepEqual(external, []);
    assert.match(await page.locator('#transcript').textContent(), /not an owner receipt/);
  });
  await check('unavailable-public-facade', async () => {
    await page.getByRole('button', { name: 'Check read availability', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#transcript li:last-child .kind')?.textContent.startsWith('result'));
    const entries = await page.locator('#transcript li pre').allTextContents();
    assert.deepEqual(JSON.parse(entries.at(-1)), { version: 1, status: 'error', code: 'unavailable' });
    assert.deepEqual(JSON.parse(entries.at(-2)), { operation:'read', version:1, documentId:fixture.documentId, representation:'markdown' });
    assert.equal(await page.getByRole('button', { name: 'Apply unavailable', exact: true }).isDisabled(), true);
  });
  await check('bounded-transcript', async () => {
    // Real UI requests, never a privileged test append port.
    for (let i = 0; i < 40; i++) { await page.locator('#read').click(); await page.waitForFunction(() => !document.querySelector('#read').disabled); }
    assert.equal(await page.locator('#transcript li').count(), 64);
    assert.match(await page.locator('#retention').textContent(), /64\/64 entries retained · 21 older entries discarded/);
    const bodies = await page.locator('#transcript li pre').allTextContents();
    for (let i = 0; i < 64; i += 2) { assert.equal(JSON.parse(bodies[i]).operation, 'read'); assert.equal(JSON.parse(bodies[i+1]).code, 'unavailable'); }
  });
  await check('keyboard-and-clear', async () => {
    await page.locator('#clear').focus(); assert.equal(await page.locator('#clear').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Enter'); assert.equal(await page.locator('#transcript li').count(), 0);
    assert.match(await page.locator('#retention').textContent(), /0\/64 entries retained · 0 older entries discarded/);
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.getByRole('region', { name: 'Human document view', exact: true }).isVisible(), true);
  });
  await check('independent-no-mutation', async () => {
    const after = await oracle();
    facts.oracles = { before, after, errors, external, applicability: 'Real independent WASM checkpoint (including history/identity), semantic state and IndexedDB inventory unchanged. No connected Session/SQLite or mounted editor is claimed.' };
    assert.deepEqual(after, before); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
  await page.evaluate(() => window.shellSentinel.dispose());
}
