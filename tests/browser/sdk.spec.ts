import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('sdk', 'examples/task-editor', { autoMount: false });
async function openExample(page) {
  await page.evaluate(async () => {
    window.task = await import('/fixture/editor.mjs');
    await window.task.ready; window.activeEditor = window.task.editor;
  });
}
const content = snapshot => snapshot.visible.filter(node => node.kind === 'block').map(node => ({ id: node.id, runs: node.runs, attributes: node.blockAttributes }));

test('standalone task edits, pastes Markdown and recovers its exact offline document', () => probe('task-offline', async (page, fact) => {
  await openExample(page);
  await page.locator('#editor').click(); await page.keyboard.press('End'); await page.keyboard.type(' edited');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    window.taskPaste = window.task.editor.paste({ getData: mime => mime === 'text/plain' ? '# Offline heading\n\n**Saved**' : '' });
  });
  await page.locator('#save').click();
  await page.waitForFunction(() => window.task.editor.state.localCommitted !== null);
  const before = await page.evaluate(() => window.task.editor.read());
  const paste = await page.evaluate(() => window.taskPaste);
  fact.snapshots.push({ pasted: before, paste });
  assert.equal(paste.disposition, 'committed', JSON.stringify(paste));
  assert.equal(content(before)[0].runs.map(run => run.text).join(''), 'Plan the task edited');
  assert.ok(content(before).some(node => JSON.stringify(node.attributes) === JSON.stringify(['heading', 1])));
  assert.ok(content(before).some(node => node.runs.some(run => run.text === 'Saved' && run.attributes.bold === true)));
  assert.equal(await page.locator('#editor h1').first().textContent(), 'Offline heading');
  assert.equal(await page.locator('#editor strong').first().textContent(), 'Saved');
  await page.evaluate(async () => { window.activeEditor = await window.task.reopenOffline(); });
  const after = await page.evaluate(() => window.task.editor.read());
  assert.deepEqual(content(after), content(before)); assert.deepEqual(after.identity, before.identity);
  // A full reload proves IndexedDB recovery, rather than retained in-memory state.
  await page.evaluate(() => window.task.close()); await page.reload(); await openExample(page);
  const reloaded = await page.evaluate(() => window.task.editor.read());
  assert.deepEqual(content(reloaded), content(before)); assert.deepEqual(reloaded.identity, before.identity);
  fact.snapshots.push({ before, after, reloaded });
}));

test('chains validate atomically and scoped subscribers observe only committed changes', () => probe('atomic-chains', async (page, fact) => {
  await openExample(page);
  const result = await page.evaluate(async () => {
    const e = window.task.editor, initial = e.read(), id = initial.visible.find(node => node.kind === 'block').id;
    const at = e.anchor(id, 0), end = e.anchor(id, 13);
    const counts = { updates: 0, matching: 0, other: 0, stopped: 0 };
    const stop = e.subscribe({ type: 'updates' }, () => counts.updates++);
    e.subscribe({ type: 'nodes', ids: [id] }, () => counts.matching++);
    e.subscribe({ type: 'nodes', ids: ['absent-node'] }, () => counts.other++);
    const off = e.subscribe({ type: 'updates' }, () => counts.stopped++); off(); off();
    const bad = e.chain().command({ type: 'insert', at, text: 'MUST NOT APPEAR' }).command({ type: 'setParagraph', owner: 'absent-node' });
    const canBad = bad.can(); let rejection;
    try { bad.run(); } catch (error) { rejection = error.message; }
    const afterBad = e.read(), countsAfterBad = { ...counts };
    const command = { type: 'insert', at, text: 'Start ' };
    const good = e.chain().command(command).command({ type: 'insert', at: end, text: ' done' });
    command.text = 'HOST MUTATED';
    const canGood = good.can(), afterCan = e.read(); good.run();
    let consumed; try { good.run(); } catch (error) { consumed = error.message; }
    await e.flush({ target: 'local' });
    const committed = e.read(); stop();
    e.setReadOnly(true); const canReadOnly = e.chain().command({ type: 'insert', at, text: 'bad' }).can();
    let readOnly; try { e.chain().command({ type: 'insert', at, text: 'bad' }).run(); } catch (error) { readOnly = error.message; }
    e.releaseAnchor(at); e.releaseAnchor(end);
    return { initial, canBad, rejection, afterBad, countsAfterBad, canGood, afterCan, committed, consumed, counts, canReadOnly, readOnly };
  });
  assert.equal(result.canBad, false); assert.ok(result.rejection);
  assert.deepEqual(result.afterBad, result.initial); assert.deepEqual(result.afterCan, result.initial);
  assert.deepEqual(result.countsAfterBad, { updates: 0, matching: 0, other: 0, stopped: 0 });
  assert.equal(result.canGood, true); assert.equal(result.committed.revision, result.initial.revision + 1);
  assert.equal(content(result.committed)[0].runs.map(run => run.text).join(''), 'Start Plan the task done');
  assert.deepEqual(result.counts, { updates: 1, matching: 1, other: 0, stopped: 0 });
  assert.equal(result.consumed, 'Command chain consumed'); assert.equal(result.canReadOnly, false); assert.equal(result.readOnly, 'Editor is read-only');
  fact.snapshots.push(result);
}));

test('authorized binary sync attaches to the existing replica and persists converged content', () => probe('attach-existing-sync', async (page, fact) => {
  await openExample(page);
  const result = await page.evaluate(async () => {
    const { init } = await import('/core/index.js');
    const { DirectSyncAdapter } = await import('/web/sync/protocol.js');
    const runtime = await init('/core/wasm/editac_wasm_bg.wasm'), e = window.task.editor;
    const before = e.read(), checkpoint = e.recoveryExport().checkpoint;
    const peer = runtime.restoreEngine(before.identity, checkpoint), adapter = new DirectSyncAdapter(peer, before.identity);
    let attachment; const replies = [], sent = [];
    try {
      const id = before.visible.find(node => node.kind === 'block').id, remoteAt = peer.anchor(id, 13, 'right');
      try { const plan = peer.prepare({ kind: 'editor', origin: 'local:prepared-peer', commands: [{ type: 'insert', at: remoteAt, text: ' remote' }] }); try { peer.commit(plan); } finally { peer.releasePlan(plan); } }
      finally { peer.releaseAnchor(remoteAt); }
      const transport = { send(frame) { sent.push([...frame]); const result = adapter.receive(frame); if (result.reply) replies.push(result.reply); return true; } };
      const checkpointBefore = e.recoveryExport().checkpoint;
      attachment = await window.task.attachTaskSync({ transport, peerIdentity: before.identity, authorized: true });
      const checkpointAfter = e.recoveryExport().checkpoint, sameHandle = e === window.task.editor, immediatelyAfter = e.read();
      let wrongEpoch; try { await e.attachSync({ transport, peerIdentity: { ...before.identity, epoch: 'd8769012-3456-4789-8123-456789abcdef' }, authorized: true }); } catch (error) { wrongEpoch = error.code; }
      const preservedAttachment = attachment.state.phase;
      attachment.receive(adapter.step1());
      for (let i = 0; i < 12; i++) { await attachment.pump(i); while (replies.length) attachment.receive(replies.shift()); }
      await e.flush({ target: 'local' });
      // A local edit after attachment must invalidate the durable replay cursor.
      const at = e.anchor(id, 0); try { e.chain().command({ type: 'insert', at, text: 'local ' }).run(); } finally { e.releaseAnchor(at); }
      await e.flush({ target: 'local' });
      for (let i = 12; i < 24; i++) { await attachment.pump(i); while (replies.length) attachment.receive(replies.shift()); }
      await e.flush({ target: 'local' });
      const converged = e.read(), remote = peer.read(), state = attachment.state;
      window.activeEditor = await window.task.reopenOffline();
      return { before, immediatelyAfter, checkpointBefore, checkpointAfter, sameHandle, wrongEpoch, preservedAttachment, converged, remote, state, sent: sent.length, disposed: attachment.state.phase, recovered: window.task.editor.read() };
    } finally { attachment?.detach(); peer.dispose(); }
  });
  assert.equal(result.sameHandle, true); assert.deepEqual(result.checkpointAfter, result.checkpointBefore); assert.deepEqual(result.immediatelyAfter, result.before);
  assert.equal(result.wrongEpoch, 'wrong-epoch'); assert.equal(result.preservedAttachment, 'attached');
  assert.equal(content(result.converged)[0].runs.map(run => run.text).join(''), 'local Plan the task remote');
  assert.deepEqual(content(result.converged), content(result.remote)); assert.deepEqual(content(result.recovered), content(result.converged));
  assert.equal(result.disposed, 'disposed'); assert.ok(result.sent > 0); assert.equal(result.state.incomingFrames, 0); assert.equal(result.state.outgoingFrames, 0);
  fact.snapshots.push(result);
}));

test('attachment authorization, replacement and teardown fence pending IndexedDB work', () => probe('attachment-lifecycle', async (page, fact) => {
  await openExample(page);
  const result = await page.evaluate(async () => {
    const e = window.task.editor, identity = e.read().identity; let sends = 0;
    const options = { transport: { send() { sends++; return true; } }, peerIdentity: identity, authorized: false };
    const denied = await e.attachSync(options); await denied.pump(0);
    const deniedPhase = denied.state.phase, deniedSends = sends;
    const first = await e.attachSync({ ...options, authorized: true });
    const second = await e.attachSync({ ...options, authorized: true });
    const replaced = first.state.phase;
    const pending = e.attachSync({ ...options, authorized: true });
    const closing = e.destroy({ policy: 'flush' });
    let canceled; try { await pending; } catch (error) { canceled = error.message; }
    await closing; const sameReport = await e.destroy({ policy: 'report' });
    let afterDestroy; try { e.chain(); } catch (error) { afterDestroy = error.message; }
    return { deniedPhase, deniedSends, deniedDisposed: denied.state.phase, replaced, final: second.state.phase, canceled, afterDestroy, state: e.state, sameReport };
  });
  assert.equal(result.deniedPhase, 'unauthorized'); assert.equal(result.deniedSends, 0); assert.equal(result.deniedDisposed, 'disposed');
  assert.equal(result.replaced, 'disposed'); assert.equal(result.final, 'disposed'); assert.ok(result.canceled);
  assert.equal(result.state.phase, 'destroyed'); assert.equal(result.afterDestroy, 'Editor is not ready'); assert.equal(result.sameReport.unsaved, false);
  fact.snapshots.push(result);
}));
