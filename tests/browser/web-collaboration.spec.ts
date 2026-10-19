import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('web-collaboration', 'tests/extension-dx/configuration-consumer', {
  autoMount: false, markdown: true, assertSourcesUnchanged: true,
  sourcePaths: ['tests/browser/web-collaboration.spec.ts', 'tests/extension-dx/configuration-consumer/session.mjs',
    'packages/web/src/editor.ts', 'packages/web/src/surface.ts', 'packages/web/src/sync/attachment.ts'],
  cleanup: page => page.evaluate(async () => { await window.configurationFixture?.close(); }),
});

// The original SDK case covers the owned editor. This missing borrowed-owner
// case protects the same public atomicity contract, including rejected sends.
test('borrowed sync rejects replacement atomically and remains usable until explicit detach', () => probe('borrowed-atomic-replacement', async (page, fact) => {
  await page.waitForFunction(() => !!window.configurationFixture);
  const result = await page.evaluate(async () => {
    const f = window.configurationFixture, record = await f.seed(), owner = await f.openEditorStorage(record);
    f.storageOwners.push(owner);
    const surface = f.mountEditorSurface(f.root(), owner.engine, { extensions: [], storageOwner: owner });
    f.surfaces.push(surface); await surface.ready;
    const frames = [], options = { authorized: true, peerIdentity: record.identity,
      transport: { send(bytes) { frames.push([...bytes]); return true; } } };
    const first = await surface.attachSync(options), before = owner.engine.read(), errors = [];
    for (const change of [{ peerIdentity: { ...record.identity, epoch: crypto.randomUUID() } }, { transport: {} }]) {
      try { await surface.attachSync({ ...options, ...change }); errors.push('accepted'); }
      catch (error) { errors.push(error.code ?? error.name); }
    }
    const retained = surface.syncAttachment === first, phase = first.state.phase;
    await first.pump(1);
    const unchanged = owner.engine.read(), sent = frames.length;
    const next = await surface.attachSync(options), replaced = first.state.phase;
    surface.disconnectCollaboration();
    return { errors, retained, phase, before, unchanged, sent, replaced,
      detached: next.state.phase, cleared: !surface.syncAttachment };
  });
  fact.snapshots.push(result);
  assert.deepEqual(result.errors, ['wrong-epoch', 'TypeError']);
  assert.equal(result.retained, true); assert.equal(result.phase, 'attached');
  assert.deepEqual(result.before, result.unchanged); assert.ok(result.sent > 0);
  assert.equal(result.replaced, 'disposed'); assert.equal(result.detached, 'disposed'); assert.equal(result.cleared, true);
}));
