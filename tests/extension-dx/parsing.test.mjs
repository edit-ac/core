import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareParsingConsumer } from './parsing-consumer.mjs';
const output = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT);
process.env.EDITAC_PARSING_OUTPUT = join(output, 'browser');
const { probe } = browserHarness('parsing', resolve('tests/extension-dx/parsing-consumer'), {
  autoMount: false, markdown: false, prepareConsumer: prepareParsingConsumer,
  testFile: 'tests/extension-dx/parsing.test.mjs', assertSourcesUnchanged: true,
  sourcePaths: ['scripts/build-extension-runtime.mjs','packages/web/src/modules/presenter-sequence.ts','packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts','packages/web/package.json','examples/extensions/parsing/parsing.ts', 'examples/extensions/parsing/README.md',
    'examples/extensions/url-insert/url-insert.ts', 'examples/extensions/url-insert/README.md',
    'tests/extension-dx/parsing-consumer.mjs', 'tests/extension-dx/matching-consumer.mjs',
    'tests/extension-dx/parsing-consumer/session.mjs', 'tests/extension-dx/parsing-consumer/index.html',
    'examples/extensions/authoring/recipes.mjs', 'packages/web/src/extensions/matching.ts',
    'packages/web/src/extensions/authoring.ts', 'packages/web/src/services/lifecycle.ts',
    'packages/web/src/editor.ts', 'packages/web/src/surface.ts', 'packages/web/src/index.ts', 'scripts/test-extension-dx.mjs'],
  cleanup: p => p.evaluate(() => window.parsingFixture?.close()),
});
function check(name, run) { test(name, () => probe(name.replace(/[^a-zA-Z0-9-]/g, '-'), async p => {
  await p.waitForFunction(() => !!window.parsingFixture); await run(p);
})); }
const source = 'note/1\np:First\nh2:Title\nb:Strong';
const url = 'https://notes.example.test/one', href = 'https://docs.example.test/notes/one';
async function paste(p, flavors, options = {}) {
  return p.evaluate(async ({ flavors, options }) => {
    const f = window.parsingFixture, m = await f.start({ urls: false });
    f.select(m.editor.root, 0, 6);
    const result = m.editor.paste({ getData: type => flavors[type] ?? '' }, options);
    await f.flush(); return { result, text: f.content(m.editor), nodes: m.editor.read().visible.filter(n => n.kind === 'block'), recovery: m.editor.clipboardRecovery };
  }, { flavors, options });
}
check('DXC-17 tiny grammar prepares all blocks before one production fragment commit and shared undo redo', async p => {
  const r = await paste(p, { 'application/x-example-note': source, 'text/plain': source });
  assert.equal(r.result.disposition, 'committed'); assert.equal(r.text, 'First\nTitle\nStrong');
  assert.equal(r.nodes[1].blockAttributes[0], 'heading'); assert.equal(r.nodes[1].blockAttributes[1], 2);
  assert.deepEqual(r.nodes[2].runs.map(r => [r.text, r.attributes.bold]), [['Strong', true]]);
  assert.deepEqual(r.recovery, []);
  const h = await p.evaluate(async () => { const f = window.parsingFixture; f.history('undo'); const undone = f.content(window.task.editor); f.history('redo'); await f.flush(); return { undone, redone: f.content(window.task.editor) }; });
  assert.deepEqual(h, { undone: 'Target', redone: 'First\nTitle\nStrong' });
});
check('DXC-17 plain text is literal even when it looks like the custom grammar', async p => {
  const r = await paste(p, { 'text/plain': source }); assert.equal(r.text, source); assert.ok(r.nodes.every(n => n.runs.every(r => !r.attributes.bold)));
});
check('DXC-17 explicit literal bypass ignores even valid custom and internal rich flavors', async p => {
  const r = await paste(p, { 'application/x-example-note': source, 'text/plain': source }, { literal: true });
  assert.equal(r.text, source); assert.deepEqual(r.recovery, []);
});
for (const [name, raw, reason] of [
  ['unsupported version', 'note/2\np:Keep me', 'note-version'],
  ['invalid later line', 'note/1\np:Good\nx:Unchanged source', 'note-line'],
  ['empty document', 'note/1', 'note-lines'],
  ['empty text', 'note/1\np:', 'note-line'],
  ['line count', 'note/1\n' + Array(9).fill('p:One').join('\n'), 'note-lines'],
  ['line length', 'note/1\np:' + 'a'.repeat(129), 'note-line'],
  ['oversized UTF8 input', 'note/1\np:' + '😀'.repeat(600), 'note-size'],
  ['control characters', 'note/1\np:Tab\tvalue', 'note-line'],
]) check(`DXC-17 ${name} retains exact recoverable source and safe literal fallback without partial conversion`, async p => {
  const r = await paste(p, { 'application/x-example-note': raw, 'text/plain': 'Recovery copy' });
  assert.equal(r.result.disposition, 'committed'); assert.equal(r.text, 'Recovery copy');
  assert.deepEqual(r.recovery, [{ mime: 'application/x-example-note', raw, reason }]);
  const h = await p.evaluate(() => { const f = window.parsingFixture; f.history('undo'); return f.content(window.task.editor); }); assert.equal(h, 'Target');
});
check('DXC-17 rejected custom data without a fallback leaves original content and history untouched', async p => {
  const r = await paste(p, { 'application/x-example-note': 'note/9\np:Recover' });
  assert.equal(r.result.disposition, 'rejected'); assert.equal(r.text, 'Target'); assert.equal(r.recovery[0].raw, 'note/9\np:Recover');
});
check('DXC-17 internal admitted fragment wins before custom MIME', async p => {
  const r = await paste(p, { 'application/x-edit-ac-fragment+json': JSON.stringify({ version: 1, schema: 'editac.registry.editor.v5', blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text: 'Internal wins', marks: [] }] }] }), 'application/x-example-note': source, 'text/plain': 'Plain' });
  assert.equal(r.text, 'Internal wins'); assert.deepEqual(r.recovery, []);
});
check('DXC-17 malformed internal data retains its source and falls through to the custom codec', async p => {
  const r = await paste(p, { 'application/x-edit-ac-fragment+json': '{bad', 'application/x-example-note': 'note/1\nb:Custom wins', 'text/plain': 'Plain' });
  assert.equal(r.text, 'Custom wins'); assert.equal(r.nodes[0].runs[0].attributes.bold, true); assert.equal(r.recovery[0].raw, '{bad');
});
check('DXC-17 sanitized HTML precedes the custom MIME according to existing clipboard policy', async p => {
  const r = await paste(p, { 'text/html': '<p><strong>HTML wins</strong></p>', 'application/x-example-note': source, 'text/plain': 'Plain' });
  assert.equal(r.text, 'HTML wins'); assert.equal(r.nodes[0].runs[0].attributes.bold, true);
});
check('DXC-17 Unicode text stays literal inside declared fields with no markup interpretation', async p => {
  const r = await paste(p, { 'application/x-example-note': 'note/1\np:Árvíz 😀 é <script> **literal**', 'text/plain': 'fallback' });
  assert.equal(r.text, 'Árvíz 😀 é <script> **literal**'); assert.ok(r.nodes[0].runs.every(r => !r.attributes.bold));
  assert.equal(await p.locator('script:not([type])').count(), 0);
});
check('DXC-17 actual paste event uses the configured public codec and semantic history', async p => {
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = await f.start({ urls: false }); f.select(m.editor.root, 0, 6); const d = new DataTransfer(); d.setData(f.NOTE_MIME, 'note/1\nb:Event'); d.setData('text/plain', 'fallback'); const e = window.preparedClipboardEvent('paste', d); m.editor.root.dispatchEvent(e); await f.flush(); return { text: f.content(m.editor), bold: f.runs()[0].attributes.bold, prevented: e.defaultPrevented }; });
  assert.deepEqual(r, { text: 'Event', bold: true, prevented: true });
});
check('DXC-17 canceled deferred preparation retains source without mutation', async p => {
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = await f.start({ urls: false }); f.select(m.editor.root, 0, 6); let resume; const job = m.editor.pasteDeferred({ getData: type => type === f.NOTE_MIME ? 'note/1\nb:Later' : '' }, { schedule: () => new Promise(r => resume = r) }); await Promise.resolve(); job.cancel(); const result = await job.result; resume?.(); await f.flush(); return { result, text: f.content(m.editor), raw: job.source[f.NOTE_MIME] }; });
  assert.equal(r.result.disposition, 'rejected'); assert.equal(r.text, 'Target'); assert.equal(r.raw, 'note/1\nb:Later');
});
check('DXC-17 deferred stale reparented target cannot redirect a fragment', async p => {
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = await f.start({ urls: false }); f.select(m.editor.root, 0, 6); let resume; const job = m.editor.pasteDeferred({ getData: type => type === f.NOTE_MIME ? 'note/1\nb:Later' : '' }, { schedule: () => new Promise(r => resume = r) }); await Promise.resolve(); const node = m.editor.read().visible.find(n => n.kind === 'block'); m.editor.commit({ kind: 'editor', origin: 'local:fixture-move', commands: [{ type: 'wrap', targets: [node.id], style: { type: 'quote' } }] }); resume(); const result = await job.result; await f.flush(); return { result, text: f.content(m.editor), source: job.source[f.NOTE_MIME] }; });
  assert.equal(r.result.disposition, 'rejected'); assert.equal(r.text, 'Target'); assert.equal(r.source, 'note/1\nb:Later');
});
check('DXC-17 readonly paste cannot invoke a commit or change content', async p => {
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = await f.start({ urls: false }); f.select(m.editor.root, 0, 6); m.editor.setReadOnly(true); const result = m.editor.paste({ getData: type => type === f.NOTE_MIME ? 'note/1\nb:Forbidden' : '' }); return { result, text: f.content(m.editor) }; });
  assert.equal(r.result.disposition, 'rejected'); assert.equal(r.text, 'Target');
});
async function trigger(p, options = {}) {
  await p.evaluate(async ({ url, options }) => { const f = window.parsingFixture, m = await f.start({ text: url, ...options }); f.insert(m.editor, ' '); await f.flush(); }, { url, options });
}
check('DXC-18 host authorized URL adds one standard link over unchanged source and supports atomic undo redo', async p => {
  await trigger(p); const r = await p.evaluate(async () => { const f = window.parsingFixture, m = window.task; const pending = f.content(m.editor); await m.calls[0].release(); await f.flush(); const links = f.runs().filter(r => r.attributes.link).map(r => [r.text, r.attributes.link]); f.history('undo'); const undone = f.runs().some(r => r.attributes.link); f.history('redo'); await f.flush(); return { pending, text: f.content(m.editor), links, undone, redone: f.runs().some(r => r.attributes.link), requests: m.calls.length }; });
  assert.deepEqual(r, { pending: url + ' ', text: url + ' ', links: [[url, href]], undone: false, redone: true, requests: 1 });
});
for (const [status, result] of [['missing', { status: 'missing' }], ['forbidden', { status: 'forbidden' }], ['unavailable', { status: 'unavailable' }], ['invalid', { status: 'available', href: 'javascript:alert(1)' }], ['credential URL', { status: 'available', href: 'https://user:secret@example.test/' }]]) {
  check(`DXC-18 ${status} result preserves bytes formatting and history`, async p => {
    await trigger(p); const r = await p.evaluate(async result => { const f = window.parsingFixture, m = window.task; const before = JSON.stringify(m.editor.read().visible); m.calls[0].resolve(result); await f.flush(); const same = before === JSON.stringify(m.editor.read().visible); f.history('undo'); return { same, text: f.content(m.editor), requests: m.calls.length, status: m.statuses.at(-1) }; }, result);
    assert.equal(r.same, true); assert.equal(r.text, url); assert.equal(r.requests, 1); assert.equal(r.status, status === 'credential URL' ? 'invalid' : status);
  });
}
for (const action of ['edit', 'readonly', 'policy', 'dispose']) check(`DXC-18 ${action} invalidation cancels late resolution at the original target`, async p => {
  await trigger(p); const r = await p.evaluate(async action => { const f = window.parsingFixture, m = window.task;
    if (action === 'edit') f.remove(m.editor, 0, 5);
    if (action === 'readonly') { m.editor.setReadOnly(true); m.editor.setReadOnly(false); }
    if (action === 'policy') { m.permission = { ...m.permission, revision: 'new-policy', apply: false }; m.invalidate(); }
    if (action === 'dispose') await m.editor.destroy({ policy: 'report' });
    const before = action === 'dispose' ? null : f.content(m.editor); await m.calls[0].release(); if (action === 'dispose') await new Promise(r => setTimeout(r, 0)); else await f.flush();
    return { aborted: m.calls[0].signal.aborted, before, after: action === 'dispose' ? null : f.content(m.editor), linked: action === 'dispose' ? false : f.runs().some(r => r.attributes.link), subscriptions: m.subscriptions };
  }, action);
  assert.equal(r.aborted, true); assert.equal(r.after, r.before); assert.equal(r.linked, false); if (action === 'dispose') assert.equal(r.subscriptions, 0);
});
check('DXC-18 explicit paste uses configured URL resolver while literal and disabled paste do not', async p => {
  const r = await p.evaluate(async url => { const f = window.parsingFixture, results = [];
    for (const mode of ['normal', 'literal', 'disabled']) { const m = await f.start({ options: { paste: mode !== 'disabled' } }); f.select(m.editor.root, 0, 6); m.editor.paste({ getData: t => t === 'text/plain' ? url : '' }, { literal: mode === 'literal' }); await f.flush(); if (m.calls.length) { await m.calls[0].release(); await f.flush(); } results.push({ text: f.content(m.editor), requests: m.calls.length, linked: f.runs().some(r => r.attributes.link) }); } return results;
  }, url);
  assert.deepEqual(r, [{ text: url, requests: 1, linked: true }, { text: url, requests: 0, linked: false }, { text: url, requests: 0, linked: false }]);
});
check('DXC-18 URL without prepared allowlist match is missing and never interpolated or fetched', async p => {
  await trigger(p, { text: 'https://unknown.example.test/two' }); const r = await p.evaluate(async () => { const f = window.parsingFixture, m = window.task; await m.calls[0].release(); await f.flush(); return { text: f.content(m.editor), status: m.statuses.at(-1), linked: f.runs().some(r => r.attributes.link) }; });
  assert.deepEqual(r, { text: 'https://unknown.example.test/two ', status: 'missing', linked: false });
});
check('DXC-18 no lookup on open and unrelated editors keep authority and resource isolation', async p => {
  const r = await p.evaluate(async url => { const f = window.parsingFixture, a = await f.start({ text: url }), b = await f.start({ text: url }); const initial = [a.calls.length, b.calls.length]; f.insert(a.editor, ' '); await f.flush(); await a.calls[0].release(); await f.flush(); return { initial, requests: [a.calls.length, b.calls.length], a: f.runs(a.editor).some(r => r.attributes.link), b: f.runs(b.editor).some(r => r.attributes.link) }; }, url);
  assert.deepEqual(r, { initial: [0, 0], requests: [1, 0], a: true, b: false });
});
check('DXC-18 exact URL reference retains source and href without a presenter on reopen and clipboard', async p => {
  await trigger(p, { representation: 'reference' });
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = window.task;
    await m.calls[0].release(); await f.flush();
    const cp = m.editor.recoveryExport().checkpoint, b = await f.open([], '', cp);
    f.select(b.root, 0, 30); const data = new DataTransfer(); b.root.dispatchEvent(window.preparedClipboardEvent('copy', data));
    const c = await f.open([], 'Target'); f.select(c.root, 0, 6); const outcome = c.paste(data);
    f.history('undo', m.editor); const undone = f.runs(m.editor).every(r => !r.attributes['module:example.url-reference']);
    f.history('redo', m.editor);
    return { outcome, original: f.content(m.editor), reopened: f.content(b), dom: b.root.textContent,
      copied: f.content(c), data: f.runs(c)[0].attributes['module:example.url-reference'], undone, calls: m.calls.length };
  });
  assert.equal(r.outcome.disposition, 'committed'); assert.equal(r.original, url + ' ');
  assert.equal(r.reopened, url + ' '); assert.equal(r.dom, url + ' '); assert.equal(r.copied, url);
  assert.deepEqual(r.data, [1, { href, label: url }]); assert.equal(r.undone, true); assert.equal(r.calls, 1);
});
check('DXC-18 delayed URL result preserves backward selection adjacent formatting and rebases unrelated text', async p => {
  await p.evaluate(async url => { const f = window.parsingFixture, m = await f.start({ text: 'X ' + url + ' Y' }); f.mark(m.editor, 'italic', 0, 2); f.mark(m.editor, 'bold', 2, 2 + url.length); f.insert(m.editor, ' ', 2 + url.length); await f.flush(); f.insert(m.editor, 'prefix ', 0, 'local:unrelated'); f.select(m.editor.root, 12, 9); }, url);
  const r = await p.evaluate(async () => { const f = window.parsingFixture, m = window.task, selection = f.selection(); await m.calls[0].release(); await f.flush(); return { selection, after: f.selection(), linked: f.runs().filter(r => r.attributes.link), text: f.content(m.editor), calls: m.calls.length }; });
  assert.deepEqual(r.after, r.selection); assert.equal(r.text, 'prefix X ' + url + '  Y'); assert.equal(r.calls, 1);
  assert.deepEqual(r.linked.map(r => [r.text, r.attributes.link, r.attributes.bold]), [[url, href, true]]);
});
check('DXC-18 denied lookup capability makes zero resolver calls and keeps local editing', async p => {
  const r = await p.evaluate(async url => { const f = window.parsingFixture, m = await f.start({ text: url }); m.permission = { ...m.permission, lookup: false }; m.invalidate(); f.insert(m.editor, ' '); await f.flush(); return { text: f.content(m.editor), requests: m.calls.length, linked: f.runs().some(r => r.attributes.link) }; }, url);
  assert.deepEqual(r, { text: url + ' ', requests: 0, linked: false });
});
for (const mode of ['failed', 'deadline']) check(`DXC-18 resolver ${mode} exposes bounded status and leaves literal URL without history`, async p => {
  await trigger(p, { options: { timeoutMs: mode === 'deadline' ? 30 : 5000 } });
  const r = await p.evaluate(async mode => { const f = window.parsingFixture, m = window.task; if (mode === 'failed') m.calls[0].reject(Error('private host failure')); else await new Promise(r => setTimeout(r, 70)); await f.flush(); const status = m.statuses.at(-1), linked = f.runs().some(r => r.attributes.link); f.history('undo'); return { status, linked, text: f.content(m.editor) }; }, mode);
  assert.deepEqual(r, { status: mode, linked: false, text: url });
});
check('DXC-17 inclusive grammar limits accept eight lines of 128 UTF16 units', async p => {
  const line = 'p:' + 'é'.repeat(128), raw = 'note/1\n' + Array(8).fill(line).join('\n');
  // This payload exceeds the independent UTF8 cap even though line limits fit.
  const rejected = await paste(p, { 'application/x-example-note': raw, 'text/plain': 'Retained' });
  assert.equal(rejected.recovery[0].reason, 'note-size');
  const ascii = 'note/1\n' + Array(8).fill('p:' + 'a'.repeat(128)).join('\n');
  const r = await paste(p, { 'application/x-example-note': ascii, 'text/plain': ascii });
  assert.equal(r.nodes.length, 8); assert.equal(r.text, Array(8).fill('a'.repeat(128)).join('\n')); assert.deepEqual(r.recovery, []);
});
check('DXC-17 inline code target bypasses a custom MIME and retains literal source', async p => {
  const r = await p.evaluate(async source => { const f = window.parsingFixture, m = await f.start({ urls: false }); f.mark(m.editor, 'code', 0, 6); f.select(m.editor.root, 1, 5); const result = m.editor.paste({ getData: t => t === f.NOTE_MIME || t === 'text/plain' ? source : '' }); await f.flush(); return { result, text: f.content(m.editor), recovery: m.editor.clipboardRecovery }; }, 'note/1\nb:Literal');
  assert.equal(r.result.disposition, 'committed'); assert.equal(r.text, 'Tnote/1\nb:Literalt'); assert.deepEqual(r.recovery, []);
});
check('DXC-18 unsafe and oversized authored sources are outside the declared URL recognition grammar', async p => {
  const r = await p.evaluate(async () => { const f = window.parsingFixture, out = []; for (const text of ['javascript:alert(1)', 'https://' + 'a'.repeat(241)]) { const m = await f.start({ text }); f.insert(m.editor, ' '); await f.flush(); out.push({ calls: m.calls.length, text: f.content(m.editor) }); } return out; });
  assert.deepEqual(r, ['javascript:alert(1)', 'https://' + 'a'.repeat(241)].map(text => ({ calls: 0, text: text + ' ' })));
});
for (const mode of ['deferred-literal', 'plain-command', 'keyboard-literal']) check(`DXC-18 ${mode} retains explicit literal intent through the real clipboard owner without lookup`, async p => {
  const r = await p.evaluate(async ({ mode, url }) => { const f = window.parsingFixture, m = await f.start(); f.select(m.editor.root, 0, 6);
    const data = { getData: type => type === 'text/plain' ? url : '' };
    if (mode === 'deferred-literal') await m.editor.pasteDeferred(data, { literal: true }).result;
    if (mode === 'plain-command') await m.editor.pastePlainText(async () => url);
    if (mode === 'keyboard-literal') { const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), shiftKey: true, bubbles: true, cancelable: true }); m.editor.root.dispatchEvent(event); const d = new DataTransfer(); d.setData('text/plain', url); m.editor.root.dispatchEvent(window.preparedClipboardEvent('paste', d)); }
    await f.flush(); return { text: f.content(m.editor), requests: m.calls.length, linked: f.runs().some(r => r.attributes.link) };
  }, { mode, url });
  assert.deepEqual(r, { text: url, requests: 0, linked: false });
});
check('DXC-18 optional reference never admits opaque data for an unsafe resolver result', async p => {
  await trigger(p, { representation: 'reference' }); const r = await p.evaluate(async () => { const f = window.parsingFixture, m = window.task; m.calls[0].resolve({ status: 'available', href: 'data:text/html,<script>bad</script>' }); await f.flush(); return { text: f.content(m.editor), status: m.statuses.at(-1), data: f.runs().some(r => r.attributes['module:example.url-reference']) }; });
  assert.deepEqual(r, { text: url + ' ', status: 'invalid', data: false });
});
