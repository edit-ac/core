import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { HighlightScheduler, HIGHLIGHT_BACKEND, validHighlightProjection } from '../packages/web/dist/modules/code/scheduler.js';
import { HighlightScheduler as PublicScheduler } from '@edit-ac/web/modules';
import { installHighlightWorker } from '../packages/web/dist/modules/code/worker.js';
import { requireTestNode } from '../scripts/test-toolchain.mjs';
await requireTestNode();
const input = (patch = {}) => ({ block: 'a', revision: 1, language: 'json', grammar: HIGHLIGHT_BACKEND, query: 'scopes-v1', theme: 'light-v1', enabled: true, source: '42', ...patch });
const projection = { status: 'highlighted', spans: [{ start: 0, end: 2, scopes: ['constant.numeric'] }] };
function harness(options = {}) {
  let time = 0, serial = 0;
  const timers = new Map(), workers = [], applied = [];
  const clock = { now: () => time, setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: time + ms }); return serial; }, clearTimeout: id => timers.delete(id) };
  const scheduler = new HighlightScheduler({ clock, timeoutMs: 100, maxPending: 3, apply: r => { applied.push(r); time += 2; },
    createWorker: () => { const worker = { onmessage: null, onerror: null, sent: [], stopped: 0,
      postMessage(value) { this.sent.push(value); }, terminate() { this.stopped++; } }; workers.push(worker); return worker; }, ...options });
  return { scheduler, workers, applied, timers, clock,
    advance(ms) { time += ms; for (const [id, t] of [...timers]) if (t.at <= time) { timers.delete(id); t.fn(); } },
    reply(worker = workers.at(-1), change = {}) { const sent = worker.sent.at(-1); worker.onmessage?.({ data: { ...sent, projection, timing: { startup: 3, work: 5 }, ...change } }); },
  };
}

test('disabled/import/invalid requests initialize no optional worker and retain source', async () => {
  assert.equal(PublicScheduler, HighlightScheduler);
  const h = harness(); assert.equal(h.workers.length, 0);
  const disabled = await h.scheduler.request(input({ enabled: false }));
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.input.source, '42');
  const large = await h.scheduler.request(input({ source: '🦀'.repeat(26000) }));
  assert.equal(large.status, 'over-budget'); assert.deepEqual(large.spans, []);
  assert.equal(h.workers.length, 0); h.scheduler.dispose();
});

test('rapid edit/language/theme changes coalesce and only newest immutable input applies', async () => {
  const h = harness(), outcomes = [];
  outcomes.push(h.scheduler.request(input()));
  for (let i = 2; i <= 100; i++) outcomes.push(h.scheduler.request(input({ revision: i, source: i % 2 ? '43' : '44', language: i % 2 ? 'rust' : 'json', theme: `theme-${i}` })));
  assert.equal(h.workers[0].sent.length, 1); assert.equal(h.scheduler.state.pending, 1);
  h.reply(); assert.equal(h.applied.length, 0); assert.equal(h.workers[0].sent.length, 2);
  h.advance(20); h.reply();
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(x => x.status === 'superseded').length, 99);
  assert.equal(h.applied.length, 1); assert.equal(h.applied[0].input.revision, 100);
  assert.equal(h.applied[0].input.theme, 'theme-100'); assert.equal(h.applied[0].timing.application, 2);
  assert.ok(Object.isFrozen(h.applied[0].input)); h.scheduler.dispose();
});

test('caller mutation cannot change captured input or completion admission', async () => {
  const h = harness(), source = { ...input(), hostHandle: { private: true } }; const pending = h.scheduler.request(source);
  assert.equal('hostHandle' in h.workers[0].sent[0].input, false);
  source.source = 'changed'; h.reply(); assert.equal((await pending).input.source, '42'); h.scheduler.dispose();
});

test('queue and outstanding requests stay bounded across unrelated blocks', async () => {
  const h = harness(), promises = [];
  for (let i = 0; i < 40; i++) {
    promises.push(h.scheduler.request(input({ block: `block-${i}` })));
    assert.ok(h.scheduler.state.pending <= 3); assert.equal(h.scheduler.state.active, 1);
  }
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].sent.length, 1);
  for (let i = 0; i < 4; i++) h.reply();
  const results = await Promise.all(promises);
  assert.equal(results.filter(x => x.status === 'queue-full').length, 36);
  assert.equal(results.filter(x => x.status === 'highlighted').length, 4);
  assert.equal(h.scheduler.state.pending, 0); h.scheduler.dispose();
});

test('timeout preserves plain source, terminates hung worker and rejects late completion', async () => {
  const h = harness(), first = h.scheduler.request(input());
  const old = h.workers[0], late = old.onmessage, sent = old.sent[0];
  const second = h.scheduler.request(input({ block: 'b' }));
  h.advance(100); const fallback = await first;
  assert.equal(fallback.status, 'timeout'); assert.equal(fallback.input.source, '42'); assert.deepEqual(fallback.spans, []);
  assert.equal(old.stopped, 1); assert.equal(h.workers.length, 2);
  late({ data: { ...sent, projection, timing: { startup: 0, work: 0 } } });
  assert.equal(h.applied.length, 1); h.reply(); assert.equal((await second).status, 'highlighted');
  h.scheduler.dispose(); assert.equal(h.timers.size, 0);
});

test('foreign, stale and duplicate completion IDs cannot publish or release current job', async () => {
  const h = harness(), first = h.scheduler.request(input());
  h.reply(undefined, { id: -1 }); assert.equal(h.applied.length, 0); assert.equal(h.scheduler.state.active, 1);
  h.reply(); await first;
  const second = h.scheduler.request(input({ revision: 2 }));
  h.reply(undefined, { id: 1 }); assert.equal(h.applied.length, 1);
  h.reply(); await second; h.reply(); assert.equal(h.applied.length, 2); h.scheduler.dispose();
});

test('wrong identities and malformed UTF-16/token spans return plain fallback', async () => {
  for (const change of [ { input: input({ theme: 'foreign' }) }, { projection: { status: 'highlighted', spans: [{ start: 0, end: 999, scopes: [] }] } }, { timing: { startup: NaN, work: 1 } } ]) {
    const h = harness(), pending = h.scheduler.request(input()); h.reply(undefined, change);
    assert.equal((await pending).status, 'backend-error'); assert.deepEqual(h.applied[0].spans, []); h.scheduler.dispose();
  }
  assert.equal(validHighlightProjection(input({ source: '🦀' }), { status: 'highlighted', spans: [{ start: 0, end: 1, scopes: [] }] }), false);
  assert.equal(validHighlightProjection(input(), { status: 'disabled', spans: projection.spans }), false);
});

test('disable or cancel invalidates active and queued state without applying old tokens', async () => {
  const h = harness(), old = h.scheduler.request(input());
  const disabled = await h.scheduler.request(input({ enabled: false, revision: 2 }));
  h.reply(); assert.equal((await old).status, 'superseded'); assert.equal(disabled.status, 'disabled');
  assert.equal(h.applied.length, 1); assert.equal(h.applied[0].status, 'disabled');
  const active = h.scheduler.request(input()), queued = h.scheduler.request(input({ block: 'b' }));
  h.scheduler.cancel('b'); h.scheduler.cancel('a'); h.reply();
  assert.equal((await queued).status, 'superseded'); assert.equal((await active).status, 'superseded'); h.scheduler.dispose();
});

test('disposal clears owned worker/timers/requests and remains idempotent', async () => {
  const h = harness(), a = h.scheduler.request(input()), b = h.scheduler.request(input({ block: 'b' }));
  const late = h.workers[0].onmessage; h.scheduler.dispose(); h.scheduler.dispose();
  assert.equal((await a).status, 'disposed'); assert.equal((await b).status, 'disposed');
  assert.deepEqual(h.scheduler.state, { pending: 0, active: 0, workers: 0, disposed: true });
  late({ data: { id: 1, input: input(), projection, timing: { startup: 0, work: 0 } } });
  assert.equal(h.applied.length, 0); assert.equal(h.workers[0].stopped, 1); assert.equal(h.timers.size, 0);
  assert.equal((await h.scheduler.request(input())).status, 'disposed');
});

test('worker creation/post/error failures yield source fallback and next requests recover', async () => {
  for (const createWorker of [() => { throw Error('unavailable'); }, () => ({ postMessage() { throw Error('clone'); }, terminate() {}, onmessage: null, onerror: null })]) {
    const h = harness({ createWorker }); assert.equal((await h.scheduler.request(input())).status, 'backend-error'); h.scheduler.dispose();
  }
  const h = harness(), first = h.scheduler.request(input()); h.workers[0].onerror({});
  assert.equal((await first).status, 'backend-error'); const next = h.scheduler.request(input({ revision: 2 }));
  h.reply(); assert.equal((await next).status, 'highlighted'); h.scheduler.dispose();
});

test('startup, transfer, work and application timing remain separate', async () => {
  const h = harness(), pending = h.scheduler.request(input());
  h.advance(4); h.workers[0].onmessage({ data: { type: 'ready' } }); h.advance(16); h.reply();
  assert.deepEqual((await pending).timing, { startup: 7, transfer: 8, work: 5, application: 2 }); h.scheduler.dispose();
});

test('worker adapter initializes once lazily, rejects invalid backend output and frees late startup', async () => {
  let loads = 0, frees = 0, drops = 0, tick = 0; const messages = [], scope = { onmessage: null, postMessage: x => { if (x.type !== 'ready') messages.push(x); } };
  const backend = { project: text => JSON.stringify({ input: JSON.parse(text), projection }), dispose: () => drops++, free: () => frees++ };
  const stop = installHighlightWorker(scope, async () => { loads++; return backend; }, () => ++tick);
  assert.equal(loads, 0); scope.onmessage({ data: { type: 'configure', moduleUrl: 'fixture' } }); assert.equal(loads, 0);
  scope.onmessage({ data: { type: 'highlight', id: 1, input: input() } }); await new Promise(setImmediate);
  scope.onmessage({ data: { type: 'highlight', id: 2, input: input() } }); await new Promise(setImmediate);
  assert.equal(loads, 1); assert.equal(messages.length, 2); assert.equal(messages[1].timing.startup, 0);
  backend.project = () => JSON.stringify({ input: input({ block: 'wrong' }), projection });
  scope.onmessage({ data: { type: 'highlight', id: 3, input: input() } }); await new Promise(setImmediate);
  assert.equal(messages[2].projection.status, 'backend-error'); stop(); assert.equal(drops, 1); assert.equal(frees, 1);
  let resolve; const pendingScope = { onmessage: null, postMessage(x) { if (x.type !== 'ready') assert.fail('disposed startup emitted'); } };
  const stopPending = installHighlightWorker(pendingScope, () => new Promise(r => { resolve = r; }));
  pendingScope.onmessage({ data: { type: 'configure', moduleUrl: 'fixture' } });
  pendingScope.onmessage({ data: { type: 'highlight', id: 4, input: input() } }); stopPending(); resolve(backend); await new Promise(setImmediate);
  assert.equal(drops, 2); assert.equal(frees, 2);
});

test('real Chromium module worker runs pinned WASM/cache languages, churn, fallback and teardown', { timeout: 60000 }, async () => {
  const corpus = JSON.parse(await readFile(new URL('../fixtures/highlighting/corpus.json', import.meta.url)));
  const root = new URL('../packages/web/dist/', import.meta.url);
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Highlight worker fixture</title>'); return; }
      if (pathname.includes('..')) throw Error('path');
      const url = new URL(`.${pathname}`, root);
      if (!url.href.startsWith(root.href)) throw Error('path');
      res.setHeader('content-type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(await readFile(url));
    } catch { res.statusCode = 404; res.end(); }
  });
  let browser, report; const errors = [];
  const ownership = { launcher: process.pid, workspace: new URL('../', import.meta.url).pathname, serverPort: null, browserPids: [], cleanup: null };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    ownership.serverPort = server.address().port;
    browser = await chromium.launch({ headless: true });
    const cdp = await browser.newBrowserCDPSession();
    ownership.browserPids = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.map(p => p.id);
    await cdp.detach();
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    report = await page.evaluate(async ({ corpus, template }) => {
      const { HighlightScheduler } = await import('/modules/code/scheduler.js');
      const { createHighlightWorker } = await import('/modules/code/worker.js');
      let started = 0, terminated = 0; const applied = [], requests = [];
      const scheduler = new HighlightScheduler({ timeoutMs: 15000, maxPending: 3, apply: r => applied.push(r.input.revision), createWorker: () => {
        started++; const worker = createHighlightWorker(new URL('/modules/code/worker-entry.js', location.href), new URL('/modules/code/backend/editac_highlighting.js', location.href));
        const terminate = worker.terminate.bind(worker); worker.terminate = () => { terminated++; terminate(); }; return worker;
      } });
      const before = { ...scheduler.state, started };
      const cases = [];
      for (const fixture of corpus.cases) {
        const result = await scheduler.request({ ...template, block: fixture.id, source: fixture.source, language: fixture.language });
        const warm = await scheduler.request(result.input);
        cases.push({ ...result, warmEqual: JSON.stringify(result.spans) === JSON.stringify(warm.spans) });
      }
      for (let i = 2; i <= 50; i++) requests.push(scheduler.request({ ...template, revision: i, language: i % 2 ? 'rust' : 'json', theme: `theme-${i}` }));
      const churn = await Promise.all(requests);
      const unsupported = await scheduler.request({ ...template, language: 'unknown' });
      const grammar = await scheduler.request({ ...template, grammar: 'unknown-grammar' });
      const disabled = await scheduler.request({ ...template, enabled: false });
      scheduler.dispose();
      // A real worker that never replies must be terminated by the same timeout path.
      const hangUrl = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], { type: 'text/javascript' }));
      let hangStopped = 0;
      const timeoutScheduler = new HighlightScheduler({ timeoutMs: 20, createWorker: () => {
        const worker = new Worker(hangUrl); const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { hangStopped++; terminate(); }; return worker;
      } });
      const timeout = await timeoutScheduler.request(template); timeoutScheduler.dispose(); URL.revokeObjectURL(hangUrl);
      return { userAgent: navigator.userAgent, before, started, terminated, cases, applied, churn: churn.map(r => r.status), unsupported, grammar, disabled, timeout, hangStopped, after: scheduler.state };
    }, { corpus, template: input() });
    assert.deepEqual(errors, []); assert.equal(report.before.started, 0);
    assert.equal(report.started, 1); assert.equal(report.terminated, 1);
    for (let i = 0; i < corpus.cases.length; i++) {
      const fixture = corpus.cases[i], result = report.cases[i];
      assert.equal(result.status, 'highlighted'); assert.equal(result.input.source, fixture.source); assert.equal(result.warmEqual, true);
      for (const expected of fixture.expected) {
        const at = fixture.source.indexOf(expected.text);
        assert.ok(result.spans.some(span => span.start <= at && span.end >= at + expected.text.length && span.scopes.some(scope => scope.startsWith(expected.scope))), `${fixture.id} ${expected.text}`);
      }
      for (const stage of ['startup', 'transfer', 'work', 'application']) assert.ok(Number.isFinite(result.timing[stage]) && result.timing[stage] >= 0);
    }
    assert.equal(report.churn.filter(x => x === 'superseded').length, 48);
    assert.equal(report.churn.at(-1), 'highlighted'); assert.ok(!report.applied.some(r => r >= 2 && r < 50));
    assert.equal(report.unsupported.status, 'unknown-language'); assert.equal(report.grammar.status, 'unsupported-grammar'); assert.equal(report.disabled.status, 'disabled');
    assert.equal(report.timeout.status, 'timeout'); assert.equal(report.timeout.input.source, '42'); assert.deepEqual(report.timeout.spans, []); assert.equal(report.hangStopped, 1);
    assert.deepEqual(report.after, { pending: 0, active: 0, workers: 0, disposed: true });
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    ownership.cleanup = { browserClosed: !browser?.isConnected(), serverListening: server.listening };
    const output = new URL('../.artifacts/highlight-scheduler/', import.meta.url); await mkdir(output, { recursive: true });
    await writeFile(new URL('browser-observations.json', output), JSON.stringify({ ...report, ownership }, null, 2) + '\n');
  }
});
