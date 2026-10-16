import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium, firefox, webkit } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
await requireTestNode();
const engineName = process.env.EDITAC_CODE_HIGHLIGHT_BROWSER ?? 'chromium';
const output = resolve(process.env.EDITAC_CODE_HIGHLIGHT_OUTPUT ?? '../architecture/evidence/code-highlight/browser', engineName);
const facts = { cases: [], browser: {}, ownership: {}, cleanup: {}, sources: {} };
const sources = ['packages/web/src/modules/code/presenter.ts', 'packages/web/src/dom/render.ts', 'packages/web/src/modules/code/scheduler.ts', 'packages/web/dist/modules/code/backend/editac_highlighting_bg.wasm', 'packages/core/dist/wasm/editac_wasm_bg.wasm', 'fixtures/browser-input/session.mjs', 'tests/browser/code-highlight.spec.ts'];
let server, controller, browser;
before(async () => {
  await mkdir(output, { recursive: true });
  for (const path of sources) facts.sources[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  server = await startFixtureServer({ fixtureDirectory: 'fixtures/browser-input' });
  controller = await ({ chromium, firefox, webkit }[engineName]).launchServer({ headless: true });
  browser = await ({ chromium, firefox, webkit }[engineName]).connect(controller.wsEndpoint());
  facts.browser = { name: engineName, version: browser.version(), node: process.version, platform: process.platform, arch: process.arch };
  facts.ownership = { pid: process.pid, browserPid: controller.process().pid, port: server.port, workspace: process.cwd(), launcher: 'npm run test:browser -- code-highlight', purpose: 'RCH-1.5 real input/renderer/worker/cache', log: output };
});
after(async () => {
  try { await browser?.close(); } finally {
    try { await controller?.close(); facts.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null; } finally {
      await server?.close();
      if (server) facts.cleanup.listenerRemoved = await new Promise(resolve => { const s = createConnection(server.port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', e => resolve(e.code === 'ECONNREFUSED')); });
      facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.passed).length, failed: facts.cases.filter(c => !c.passed).length, skipped: 0 };
      await writeFile(resolve(output, 'facts.json'), JSON.stringify(facts, null, 2));
      assert.equal(facts.cleanup.browserExited, true); assert.equal(facts.cleanup.listenerRemoved, true);
    }
  }
});
async function probe(name, action, options = {}) {
  const context = await browser.newContext(); const page = await context.newPage();
  const fact = { name, passed: false, errors: [] }; facts.cases.push(fact);
  page.on('pageerror', error => fact.errors.push(String(error)));
  try {
    await page.goto(server.url); await page.waitForFunction(() => !!window.inputFixture);
    await page.evaluate(async options => {
      const { codeHighlighting } = await import('/web/modules/index.js');
      const { createHighlightWorker } = await import('/web/modules/code/worker.js');
      const control = window.highlightControl = { paused: !!options.paused, replies: [], workers: 0, stopped: 0, applied: 0,
        release() { this.paused = false; for (const fn of this.replies.splice(0)) fn(); } };
      if (options.unsupported) Object.defineProperty(window, 'Highlight', { value: undefined, configurable: true });
      const factory = codeHighlighting({ timeoutMs: options.timeoutMs ?? 10000, enabled: options.enabled ?? true,
        createWorker() {
          control.workers++;
          const actual = createHighlightWorker(new URL('/web/modules/code/worker-entry.js', location.href), new URL('/web/modules/code/backend/editac_highlighting.js', location.href));
          const port = { onmessage: null, onerror: null, postMessage: value => actual.postMessage(value), terminate() { control.stopped++; actual.terminate(); } };
          actual.onmessage = event => { const deliver = () => { control.applied++; port.onmessage?.(event); }; if (control.paused && event.data.type !== 'ready') control.replies.push(deliver); else deliver(); };
          actual.onerror = event => port.onerror?.(event);
          return port;
        } });
      window.codeHighlightFactory = renderer => window.highlighter = factory(renderer);
      const f = window.inputFixture; await f.mount(options.source ?? 'const message = "😀אב";\n// comment');
      f.engine.commit(f.engine.prepare({ kind: 'editor', origin: 'fixture-code', commands: [{ type: 'setCode', owner: f.ids[0], language: options.language ?? 'typescript' }] }));
      await f.settle(); f.engine.history({ type: 'clear' });
      const code = f.renderer.getBlock(f.ids[0]); const other = f.renderer.getBlock(f.ids[1]);
      window.highlightSaved = { code, text: f.renderer.positions(f.ids[0])[0].node, other, otherText: f.renderer.positions(f.ids[1])[0].node, checkpoint: Array.from(f.engine.checkpoint().bytes), history: f.engine.history({ type: 'state' }) };
      window.highlightSnapshot = () => {
        const f = window.inputFixture, code = f.renderer.getBlock(f.ids[0]), saved = window.highlightSaved, selection = getSelection();
        return { text: code.textContent, source: f.engine.read().visible[0].runs.map(r => r.text).join(''), state: code.dataset.highlightState, language: code.dataset.codeLanguage,
          sameCode: code === saved.code, sameText: f.renderer.positions(f.ids[0])[0].node === saved.text, sameOther: f.renderer.getBlock(f.ids[1]) === saved.other && f.renderer.positions(f.ids[1])[0].node === saved.otherText,
          ranges: [...CSS.highlights.values()].flatMap(h => [...h].map(r => ({ text: r.toString(), start: f.renderer.getNodeId(r.startContainer), end: f.renderer.getNodeId(r.endContainer) }))),
          checkpoint: Array.from(f.engine.checkpoint().bytes), history: f.engine.history({ type: 'state' }), selection: { anchor: selection.anchorOffset, focus: selection.focusOffset, sameText: selection.anchorNode === saved.text && selection.focusNode === saved.text },
          workers: window.highlightControl.workers, stopped: window.highlightControl.stopped, recovery: f.protocol.recovery, errors: f.engine.takeObserverErrors(), editable: f.root.contentEditable };
      };
    }, options);
    await action(page, fact);
    assert.deepEqual(fact.errors, []); fact.passed = true;
  } finally { try { await page.evaluate(() => window.inputFixture.destroy()); } finally { await context.close(); } }
}
const painted = page => page.waitForFunction(() => document.querySelector('pre')?.dataset.highlightState === 'highlighted');
const snap = page => page.evaluate(() => window.highlightSnapshot());

test('real worker recoloring preserves canonical text nodes, backward Unicode selection, document and history', () => probe('selection-effects', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture, t = window.highlightSaved.text; f.root.focus(); getSelection().setBaseAndExtent(t, 21, t, 5); });
  const before = await snap(page);
  await page.evaluate(() => window.highlightControl.release()); await painted(page);
  const after = await snap(page); fact.observation = after;
  assert.equal(after.sameCode && after.sameText && after.sameOther, true); assert.equal(after.text, before.text);
  assert.deepEqual(after.selection, before.selection); assert.equal(after.selection.sameText, true);
  assert.deepEqual(after.checkpoint, before.checkpoint); assert.deepEqual(after.history, before.history);
  assert.ok(after.ranges.length > 3); assert.ok(after.ranges.every(r => r.start === r.end));
  assert.deepEqual(after.recovery, []); assert.deepEqual(after.errors, []);
  await page.screenshot({ path: resolve(output, 'tokens.png') });
}, { paused: true }));

test('trusted keyboard edits are accepted while real token work is unresolved', () => probe('immediate-input', async (page, fact) => {
  await page.evaluate(() => { const f = window.inputFixture, t = window.highlightSaved.text; f.root.focus(); getSelection().setBaseAndExtent(t, 0, t, 0); });
  await page.keyboard.type('x'); await page.evaluate(() => window.inputFixture.settle());
  const pending = await snap(page); assert.ok(pending.source.startsWith('xconst')); assert.equal(pending.text, pending.source); assert.equal(pending.editable, 'true');
  await page.evaluate(() => window.highlightControl.release()); await painted(page);
  const after = await snap(page); assert.equal(after.source, pending.source); assert.equal(after.sameOther, true); assert.deepEqual(after.recovery, []); fact.observation = after;
}, { paused: true }));

test('actual remote patch and language/theme churn reject older worker colors without full rerender', () => probe('remote-churn', async (page, fact) => {
  await page.evaluate(async () => { const f = window.inputFixture; await f.remote(0, '// remote\n');
    f.engine.commit(f.engine.prepare({ kind: 'editor', origin: 'fixture-language', commands: [{ type: 'setCode', owner: f.ids[0], language: 'rust' }] }));
    window.highlighter.configure({ theme: 'dark-v2' }); window.highlightControl.release(); await f.settle(); });
  await painted(page); const after = await snap(page); fact.observation = after;
  assert.ok(after.source.startsWith('// remote\n')); assert.equal(after.source, after.text); assert.equal(after.language, 'rust');
  assert.equal(after.sameCode && after.sameOther, true); assert.ok(after.ranges.some(r => r.text === ' remote\n')); assert.deepEqual(after.recovery, []);
}, { paused: true }));

test('composition holds native subtree through remote updates and resumes only the latest source', () => probe('composition-remote', async (page, fact) => {
  await painted(page);
  await page.evaluate(() => { const f = window.inputFixture, t = window.highlightSaved.text; f.root.focus(); getSelection().setBaseAndExtent(t, 0, t, 0); f.event('compositionstart', { data: '' }); });
  const held = await page.evaluate(() => ({ held: window.inputFixture.renderer.isHeld(window.inputFixture.ids[0]), html: document.querySelector('pre').innerHTML, rangeCount: [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0) }));
  assert.equal(held.held, true); assert.equal(held.rangeCount, 0);
  await page.evaluate(async () => { await window.inputFixture.remote(0, '// peer\n'); window.highlighter.configure({ theme: 'composition-theme' }); });
  assert.equal(await page.locator('pre').innerHTML(), held.html);
  await page.evaluate(async () => { const f = window.inputFixture; f.event('compositionend', { data: '' }); await f.settle(); });
  await painted(page); const after = await snap(page); fact.observation = { ...after, compositionProvenance: 'prepared real composition events through production TextInput; no OS IME claim' };
  assert.equal(after.text, after.source); assert.ok(after.source.startsWith('// peer\n')); assert.equal(after.sameOther, true); assert.deepEqual(after.recovery, []);
}));

test('readonly still renders source and syntax while input is refused', () => probe('readonly', async (page, fact) => {
  await painted(page); await page.evaluate(() => { const f = window.inputFixture; f.protocol.setReadOnly(true); f.root.focus(); });
  const before = await snap(page); await page.keyboard.type('forbidden'); const after = await snap(page); fact.observation = after;
  assert.equal(after.editable, 'false'); assert.equal(after.source, before.source); assert.deepEqual(after.checkpoint, before.checkpoint); assert.equal(after.state, 'highlighted');
}));

test('unknown language preserves label, source and editing with explicit fallback', () => probe('unknown-language', async (page, fact) => {
  await page.waitForFunction(() => document.querySelector('pre')?.dataset.highlightState === 'unknown-language');
  const after = await snap(page); fact.observation = after;
  assert.equal(after.language, 'host-unknown'); assert.equal(after.source, after.text); assert.equal(after.ranges.length, 0); assert.equal(after.editable, 'true');
}, { language: 'host-unknown' }));

test('timeout is explicit plain-source fallback and teardown releases registry, styles and workers', () => probe('timeout-dispose', async (page, fact) => {
  await page.waitForFunction(() => document.querySelector('pre')?.dataset.highlightState === 'timeout');
  const fallback = await snap(page); assert.equal(fallback.ranges.length, 0); assert.equal(fallback.text, fallback.source); assert.equal(fallback.stopped, 1);
  const cleanup = await page.evaluate(async () => { const f = window.inputFixture; await f.destroy(); window.highlightControl.release(); await new Promise(r => setTimeout(r, 20)); return { highlights: CSS.highlights.size, styles: [...document.querySelectorAll('style')].filter(s => s.textContent.includes('editac-code-')).length, scheduler: window.highlighter.scheduler.state, stopped: window.highlightControl.stopped }; });
  fact.observation = { fallback, cleanup }; assert.equal(cleanup.highlights, 0); assert.equal(cleanup.styles, 0); assert.equal(cleanup.scheduler.disposed, true); assert.equal(cleanup.scheduler.workers, 0);
}, { paused: true, timeoutMs: 200 }));

test('disabled presenter starts no worker and re-enable requests the current source', () => probe('disable-enable', async (page, fact) => {
  const disabled = await snap(page); assert.equal(disabled.state, 'disabled'); assert.equal(disabled.workers, 0);
  await page.evaluate(() => window.highlighter.configure({ enabled: true })); await painted(page);
  const enabled = await snap(page); fact.observation = enabled; assert.equal(enabled.workers, 1); assert.equal(enabled.sameText, true);
}, { enabled: false }));

test('unchanged composition resumes colors and conversion to prose removes only owned decorations', () => probe('resume-and-convert', async (page, fact) => {
  await painted(page);
  const held = await page.evaluate(() => { const f = window.inputFixture; f.renderer.hold(f.ids[0]); return [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0); });
  assert.equal(held, 0);
  await page.evaluate(() => { const f = window.inputFixture; f.renderer.resume(f.ids[0]); }); await painted(page);
  assert.ok((await snap(page)).ranges.length > 0);
  const after = await page.evaluate(async () => { const f = window.inputFixture; CSS.highlights.set('host-owned', new Highlight());
    f.engine.commit(f.engine.prepare({ kind: 'format', origin: 'fixture-prose', marks: [], blocks: [{ targets: [f.ids[0]], attributes: { type: 'paragraph' }, action: 'apply' }] })); await f.settle();
    const block = f.renderer.getBlock(f.ids[0]); const result = { tag: block.tagName, state: block.dataset.highlightState ?? null, ranges: [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0), text: block.textContent };
    await f.destroy(); result.hostOwnedPreserved = CSS.highlights.has('host-owned'); CSS.highlights.delete('host-owned'); return result; });
  fact.observation = after; assert.equal(after.tag, 'P'); assert.equal(after.state, null); assert.equal(after.ranges, 0); assert.equal(after.hostOwnedPreserved, true);
}));


test('missing custom-highlight capability stays editable without starting optional work', () => probe('unsupported-browser', async (page, fact) => {
  const after = await snap(page); fact.observation = after;
  assert.equal(after.state, 'unsupported-browser'); assert.equal(after.workers, 0);
  assert.equal(after.source, after.text); assert.equal(after.editable, 'true'); assert.equal(after.ranges.length, 0);
}, { unsupported: true }));

test('disposing a pending real worker cannot recolor or recreate a detached presenter', () => probe('pending-disposal', async (page, fact) => {
  await page.waitForFunction(() => window.highlightControl.replies.length > 0);
  const after = await page.evaluate(async () => { const f = window.inputFixture, code = window.highlightSaved.code, before = code.textContent;
    await f.destroy(); window.highlightControl.release(); await new Promise(r => setTimeout(r, 20));
    return { before, after: code.textContent, state: code.dataset.highlightState ?? null, highlights: CSS.highlights.size, workers: window.highlighter.scheduler.state.workers, stopped: window.highlightControl.stopped }; });
  fact.observation = after; assert.equal(after.after, after.before); assert.equal(after.state, null); assert.equal(after.highlights, 0); assert.equal(after.workers, 0); assert.equal(after.stopped, 1);
}, { paused: true }));
