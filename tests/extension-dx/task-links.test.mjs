import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareTaskLinksConsumer } from './task-links-consumer.mjs';
const output = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_TASK_LINKS_OUTPUT = join(output, 'browser');
const { probe } = browserHarness('task-links', resolve('tests/extension-dx/task-links-consumer'), {
  autoMount: false, markdown: false, prepareConsumer: prepareTaskLinksConsumer,
  testFile: 'tests/extension-dx/task-links.test.mjs', assertSourcesUnchanged: true,
  sourcePaths: ['examples/extensions/task-links/task-links.ts', 'examples/extensions/task-links/README.md',
    'tests/extension-dx/task-links-consumer.mjs', 'tests/extension-dx/matching-consumer.mjs',
    'tests/extension-dx/task-links-consumer/session.mjs', 'tests/extension-dx/task-links-consumer/index.html',
    'packages/web/src/extensions/matching.ts', 'packages/web/src/extensions/authoring.ts',
    'packages/web/src/services/lifecycle.ts', 'packages/web/src/editor.ts', 'packages/web/src/surface.ts',
    'packages/web/src/index.ts', 'scripts/test-extension-dx.mjs'],
  cleanup: page => page.evaluate(() => window.taskLinksFixture?.close()),
});
const href = 'https://tasks.example.test/issues/design-123';
const docHref = 'https://tasks.example.test/issues/documentation-7';
function check(name, run) {
  test(name, () => probe(name.replace(/[^a-zA-Z0-9-]/g, '-'), async page => {
    await page.waitForFunction(() => !!window.taskLinksFixture); await run(page);
  }));
}
async function trigger(page, options = {}) {
  await page.evaluate(async options => {
    const f = window.taskLinksFixture, m = await f.start(options);
    f.insert(m.editor, ' '); await f.flush();
  }, options);
}
check('DXC-10 trusted full issue typing retains literal source while pending then links fixed catalog URL', async p => {
  await p.evaluate(async () => { const f = window.taskLinksFixture, m = await f.start({ text: 'Prefix ' }); f.select(m.editor.root, 7); });
  await p.keyboard.type('ASD-123 ');
  const pending = await p.evaluate(async () => { const f = window.taskLinksFixture; await f.flush(); return { text: f.content(window.task.editor), calls: window.task.calls.length, runs: f.runs(), status: window.task.statusElement.textContent }; });
  assert.equal(pending.text, 'Prefix ASD-123 '); assert.equal(pending.calls, 1); assert.equal(pending.status, 'pending');
  assert.ok(pending.runs.every(r => !r.attributes.link));
  const applied = await p.evaluate(async () => { const f = window.taskLinksFixture; await window.task.calls[0].release(); await f.flush(); return { text: f.content(window.task.editor), links: f.runs().filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]), statuses: window.task.statuses }; });
  assert.deepEqual(applied, { text: 'Prefix ASD-123 ', links: [['ASD-123', href]], statuses: ['pending', 'applied'] });
});
check('DXC-14 open inspection and copy export have zero task requests', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, m = await f.start(); m.editor.read();
    f.select(m.editor.root, 0, 7);
    const data = new DataTransfer(); m.editor.root.dispatchEvent(window.preparedClipboardEvent('copy', data));
    const exported = data.getData('text/plain');
    await f.flush(); return { calls: m.calls.length, exported, text: f.content(m.editor) };
  });
  assert.equal(r.calls, 0); assert.equal(r.text, 'ASD-123'); assert.equal(r.exported, 'ASD-123');
});
check('DXC-10 adjacent formatting and backward selection survive one generated history action', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, m = await f.start({ text: 'X ASD-123 Y' });
    f.mark(m.editor, 'italic', 0, 2); f.mark(m.editor, 'bold', 2, 9); f.mark(m.editor, 'italic', 9, 11);
    f.insert(m.editor, ' ', 9); await f.flush(); f.select(m.editor.root, 8, 3);
    const selection = f.selection(); await m.calls[0].release(); await f.flush();
    const applied = f.runs(), afterSelection = f.selection();
    f.history('undo'); const undone = f.runs(), undoText = f.content(m.editor);
    f.history('redo'); await f.flush(); return { selection, afterSelection, applied, undone, redone: f.runs(), undoText, calls: m.calls.length };
  });
  assert.deepEqual(r.selection, [8, 3]); assert.deepEqual(r.afterSelection, [8, 3]);
  assert.equal(r.applied.find(r => r.attributes.link).text, 'ASD-123');
  assert.equal(r.applied.find(r => r.attributes.link).attributes.bold, true);
  assert.equal(r.applied[0].attributes.italic, true); assert.equal(r.applied.at(-1).attributes.italic, true);
  assert.ok(r.undone.every(r => !r.attributes.link)); assert.equal(r.undoText, 'X ASD-123  Y');
  const undoneCharacters = r.undone.flatMap(run => Array.from(run.text, () => run.attributes));
  assert.ok(undoneCharacters.slice(2, 9).every(attributes => attributes.bold === true));
  assert.equal(r.redone.find(r => r.attributes.link).attributes.link, href); assert.equal(r.calls, 1);
});
for (const status of ['missing', 'forbidden', 'unavailable', 'failed', 'deadline', 'invalid']) {
  check(`DXC-11 ${status} preserves authored bytes marks selection and history`, async p => {
    await trigger(p, { options: { timeoutMs: status === 'deadline' ? 30 : 5000 } });
    const r = await p.evaluate(async status => {
      const f = window.taskLinksFixture, m = window.task;
      f.select(m.editor.root, 2, 5); const before = JSON.stringify(m.editor.read().visible), selection = f.selection();
      if (status === 'failed') m.calls[0].reject(Error('private credential not for UI'));
      else if (status === 'invalid') m.calls[0].resolve({ status: 'available', href: 'javascript:alert(1)' });
      else if (status !== 'deadline') m.calls[0].resolve({ status });
      else await new Promise(r => setTimeout(r, 70));
      await f.flush(); const same = before === JSON.stringify(m.editor.read().visible), afterSelection = f.selection();
      const final = m.statuses.at(-1), ui = m.statusElement.textContent;
      if (status === 'deadline') { await m.calls[0].release(); await f.flush(); }
      const linked = f.runs().some(r => r.attributes.link); f.history('undo');
      return { same, selection, afterSelection, final, ui, linked, undoText: f.content(m.editor), calls: m.calls.length };
    }, status);
    assert.equal(r.same, true); assert.deepEqual(r.afterSelection, r.selection); assert.equal(r.final, status);
    assert.equal(r.ui, status); assert.equal(r.linked, false); assert.equal(r.undoText, 'ASD-123'); assert.equal(r.calls, 1);
  });
}
check('DXC-11 unknown catalog code is missing without synthesized URL', async p => {
  await trigger(p, { text: 'ASD-999' });
  const r = await p.evaluate(async () => { const f = window.taskLinksFixture, m = window.task; await m.calls[0].release(); await f.flush(); return { text: f.content(m.editor), status: m.statuses.at(-1), links: f.runs().filter(r => r.attributes.link), calls: m.calls.map(c => c.text) }; });
  assert.deepEqual(r, { text: 'ASD-999 ', status: 'missing', links: [], calls: ['ASD-999'] });
});
for (const text of ['ASD-123', 'xASD-123 ', 'éASD-123 ', '_ASD-123 ', 'X-ASD-123 ', 'ASD-1234567 ', 'asd-123 ']) {
  check(`declared grammar excludes ${JSON.stringify(text)}`, async p => {
    const r = await p.evaluate(async text => { const f = window.taskLinksFixture, m = await f.start({ text: '' }); f.insert(m.editor, text, 0); await f.flush(); return { calls: m.calls.length, text: f.content(m.editor) }; }, text);
    assert.equal(r.calls, 0); assert.equal(r.text, text);
  });
}
check('declared punctuation delimiter accepts a bounded issue code', async p => {
  const r = await p.evaluate(async () => { const f = window.taskLinksFixture, m = await f.start({ text: ' ' }); f.insert(m.editor, '(DOC-7).', 0); await f.flush(); await m.calls[0].release(); await f.flush(); return { text: f.content(m.editor), links: f.runs().filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]) }; });
  assert.deepEqual(r, { text: '(DOC-7). ', links: [['DOC-7', docHref]] });
});
for (const paste of [false, true]) check(`explicit paste=${paste} uses prepared browser clipboard and configured policy`, async p => {
  const r = await p.evaluate(async paste => {
    const f = window.taskLinksFixture, m = await f.start({ text: 'plain', options: { paste } }); f.select(m.editor.root, 0, 5);
    const data = new DataTransfer(); data.setData('text/plain', 'ASD-123 ');
    const event = window.preparedClipboardEvent('paste', data); m.editor.root.dispatchEvent(event); await f.flush();
    if (paste) { await m.calls[0].release(); await f.flush(); }
    return { prevented: event.defaultPrevented, text: f.content(m.editor), calls: m.calls.length, links: f.runs().filter(r => r.attributes.link).map(r => r.attributes.link) };
  }, paste);
  assert.deepEqual(r, { prevented: true, text: 'ASD-123 ', calls: paste ? 1 : 0, links: paste ? [href] : [] });
});
for (const policy of ['literal', 'code', 'link', 'composition']) check(`${policy} exclusion makes zero task requests`, async p => {
  const r = await p.evaluate(async policy => {
    const f = window.taskLinksFixture, m = await f.start();
    if (policy === 'code' || policy === 'link') f.mark(m.editor, policy, 0, 7);
    if (policy === 'composition') m.editor.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    f.insert(m.editor, ' ', undefined, policy === 'literal' ? 'text-input:literal' : 'text-input:prepared'); await f.flush();
    if (policy === 'composition') m.editor.root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await f.flush(); return { calls: m.calls.length, text: f.content(m.editor) };
  }, policy);
  assert.deepEqual(r, { calls: 0, text: 'ASD-123 ' });
});
for (const invalidation of ['edit', 'delete', 'undo', 'readonly', 'policy', 'manual-link', 'dispose']) {
  check(`DXC-12 ${invalidation} rejects delayed catalog completion`, async p => {
    await trigger(p);
    const r = await p.evaluate(async invalidation => {
      const f = window.taskLinksFixture, m = window.task;
      if (invalidation === 'edit') f.insert(m.editor, 'X', 3, 'local:edit');
      if (invalidation === 'delete') f.remove(m.editor, 0, 7);
      if (invalidation === 'undo') f.history('undo');
      if (invalidation === 'readonly') { m.editor.setReadOnly(true); m.editor.setReadOnly(false); }
      if (invalidation === 'policy') { m.permission = { ...m.permission, revision: 'catalog-2' }; m.invalidate(); }
      if (invalidation === 'manual-link') f.mark(m.editor, 'link', 0, 7);
      if (invalidation === 'dispose') await m.editor.destroy({ policy: 'report' });
      const before = invalidation === 'dispose' ? null : JSON.stringify(m.editor.read().visible);
      await m.calls[0].release(); if (invalidation !== 'dispose') await f.flush(); else await new Promise(r => setTimeout(r, 0));
      return { same: invalidation === 'dispose' || before === JSON.stringify(m.editor.read().visible), aborted: m.calls[0].signal.aborted,
        applied: m.statuses.includes('applied'), subscriptions: m.subscriptions, pending: m.controller.state.pending };
    }, invalidation);
    assert.equal(r.same, true); assert.equal(r.applied, false); assert.equal(r.pending, 0);
    if (invalidation !== 'manual-link') assert.equal(r.aborted, true);
    assert.equal(r.subscriptions, invalidation === 'dispose' ? 0 : 1);
  });
}
check('DXC-12 unrelated edit rebases the issue target and retains exact source', async p => {
  await trigger(p);
  const r = await p.evaluate(async () => { const f = window.taskLinksFixture, m = window.task; f.insert(m.editor, 'Prefix ', 0, 'local:other'); await m.calls[0].release(); await f.flush(); return { text: f.content(m.editor), links: f.runs().filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]), calls: m.calls.length }; });
  assert.deepEqual(r, { text: 'Prefix ASD-123 ', links: [['ASD-123', href]], calls: 1 });
});
check('DXC-13 deduplication and out-of-order catalog completions use bounded shared controller', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, m = await f.start({ text: ' ' }); f.insert(m.editor, 'ASD-123 DOC-7 ', 0); await f.flush();
    f.insert(m.editor, ' ', 7); await f.flush(); const before = { requests: m.calls.length, active: m.controller.state.active };
    await m.calls[1].release(); await f.flush(); await m.calls[0].release(); await f.flush();
    return { before, links: f.runs().filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]), pending: m.controller.state.pending, requests: m.calls.length };
  });
  assert.deepEqual(r.before, { requests: 2, active: 2 }); assert.deepEqual(r.links, [['ASD-123', href], ['DOC-7', docHref]]);
  assert.equal(r.requests, 2); assert.equal(r.pending, 0);
});
check('DXC-13 independent principals and replacement attachments cannot share cached intent', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, a = await f.start(); f.insert(a.editor, ' '); await f.flush();
    const b = await f.start(); b.permission = { ...b.permission, principal: 'bob' }; f.insert(b.editor, ' '); await f.flush();
    await a.calls[0].release(); await f.flush(); const intermediate = f.runs(b.editor).some(r => r.attributes.link);
    await a.editor.destroy({ policy: 'report' }); const c = await f.start(); await a.calls[0].release(); await f.flush();
    return { intermediate, aPrincipal: a.calls[0].principal, bPrincipal: b.calls[0].principal, cCalls: c.calls.length,
      cLinked: f.runs(c.editor).some(r => r.attributes.link), bCalls: b.calls.length };
  });
  assert.deepEqual(r, { intermediate: false, aPrincipal: 'alice', bPrincipal: 'bob', cCalls: 0, cLinked: false, bCalls: 1 });
});
check('DXC-12 replacement configuration for the same document rejects the old pending result', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, checkpoint = f.engine('ASD-123').checkpoint();
    const old = await f.start({ checkpoint }); f.insert(old.editor, ' '); await f.flush();
    await old.editor.destroy({ policy: 'report' });
    const current = await f.start({ checkpoint, options: { paste: true } });
    const before = JSON.stringify(current.editor.read().visible);
    await old.calls[0].release(); await f.flush();
    return { oldAborted: old.calls[0].signal.aborted, oldSubscriptions: old.subscriptions,
      oldPending: old.controller.state.pending, calls: current.calls.length,
      unchanged: before === JSON.stringify(current.editor.read().visible), text: f.content(current.editor) };
  });
  assert.deepEqual(r, { oldAborted: true, oldSubscriptions: 0, oldPending: 0, calls: 0, unchanged: true, text: 'ASD-123' });
});
check('DXC-14 remote replay is inert while generated link undo redo converge over real peer updates', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, m = await f.start({ direct: true }), a = m.engine, checkpoint = a.checkpoint();
    const b = f.runtime.restoreEngine(checkpoint.identity, checkpoint); let result;
    try {
      f.insert(b, ' ', 7); a.applyUpdate(b.encodeUpdate()); await new Promise(r => setTimeout(r, 0)); const remoteCalls = m.calls.length;
      f.insert(a, ' ', 7); await new Promise(r => setTimeout(r, 0)); await m.calls[0].release(); await new Promise(r => setTimeout(r, 0));
      b.applyUpdate(a.encodeUpdate()); const applied = [a, b].map(e => f.runs(e).filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]));
      for (const action of ['undo', 'redo']) {
        const h = a.history({ type: action });
        if (h.selection) { a.releaseAnchor(h.selection.anchor); a.releaseAnchor(h.selection.focus); }
        b.applyUpdate(a.encodeUpdate());
        if (action === 'undo') m.undone = [a, b].map(e => f.runs(e).some(r => r.attributes.link));
      }
      const undone = m.undone; await new Promise(r => setTimeout(r, 0));
      const reopened = await f.start({ checkpoint: a.checkpoint() }); await f.flush();
      result = { remoteCalls, calls: m.calls.length, applied, undone,
        redone: [a, b].map(e => f.runs(e).filter(r => r.attributes.link).map(r => [r.text, r.attributes.link])),
        texts: [a, b].map(f.content), reopenedCalls: reopened.calls.length, reopenedLinks: f.runs(reopened.editor).filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]) };
    } finally { b.dispose(); }
    return result;
  });
  assert.equal(r.remoteCalls, 0); assert.equal(r.calls, 1); assert.deepEqual(r.applied, [[['ASD-123', href]], [['ASD-123', href]]]);
  assert.deepEqual(r.undone, [false, false]); assert.deepEqual(r.redone, r.applied); assert.deepEqual(r.texts, ['ASD-123  ', 'ASD-123  ']);
  assert.equal(r.reopenedCalls, 0); assert.deepEqual(r.reopenedLinks, [['ASD-123', href]]);
});
check('host policy revocation cancels bounded work then next explicit input uses changed catalog revision', async p => {
  await trigger(p);
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, m = window.task; m.permission = { ...m.permission, lookup: false }; m.invalidate();
    f.insert(m.editor, ' ', 7); await f.flush(); const deniedCalls = m.calls.length;
    m.permission = { ...m.permission, lookup: true, revision: 'catalog-2' }; m.invalidate(); f.insert(m.editor, ' ', 7); await f.flush();
    await m.calls[0].release(); await m.calls[1].release(); await f.flush(); return { deniedCalls, calls: m.calls.length, aborted: m.calls[0].signal.aborted, links: f.runs().filter(r => r.attributes.link).map(r => r.attributes.link) };
  });
  assert.deepEqual(r, { deniedCalls: 1, calls: 2, aborted: true, links: [href] });
});
check('invalid recipe options fail before attachment and prepared catalog rejects prototype keys', async p => {
  const r = await p.evaluate(async () => {
    const f = window.taskLinksFixture, s = f.hostState(), factory = f.createTaskLinks(s.host); let rejected = 0;
    for (const option of [{ paste: 'yes' }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { extra: true }]) try { factory.configure(option); } catch { rejected++; }
    const result = await f.preparedTaskResolver({ text: 'toString', signal: new AbortController().signal });
    return { rejected, result, calls: s.calls.length, subscriptions: s.subscriptions };
  });
  assert.deepEqual(r, { rejected: 4, result: { status: 'missing' }, calls: 0, subscriptions: 0 });
});
