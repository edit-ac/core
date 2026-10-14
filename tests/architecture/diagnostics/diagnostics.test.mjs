import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { hash } from '../../../scripts/architecture-layers.mjs';
import { selectSuite, testCounts } from '../../../scripts/check-architecture.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
assert(output, 'canonical isolated architecture output required');
mkdirSync(output, { recursive: true });
const bundle = resolve(output, 'diagnostics-adapters.mjs');
await build({ absWorkingDir: root, stdin: { contents: "export * from './packages/web/src/services/diagnostics'; export * from './packages/web/src/services/lifecycle'; export { ReferenceLookupSession } from './packages/web/src/modules/references';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const { SupportDiagnostics, serviceDiagnostic, runWithDiagnostics, ServiceLifecycle, ReferenceLookupSession } = await import(pathToFileURL(bundle));
const seeds = ['PRIVATE_DOC_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'https://private-user:PRIVATE_TOKEN_SENTINEL@example.test/file?key=PRIVATE_KEY_SENTINEL', 'PRIVATE_TOKEN_SENTINEL', 'PRIVATE_KEY_SENTINEL'];
const privatePayload = { document: seeds[0], title: seeds[1], url: seeds[2], token: seeds[3], key: seeds[4] };
const noPrivate = report => { for (const seed of seeds) assert(!report.includes(seed), 'support export exposed private seed'); };
const scope = () => ({ document: seeds[0], session: seeds[1], revision: seeds[3], permission: seeds[4], authorized: true });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(source) {
  let current = scope(), now = 0;
  const timers = new Set(), log = new SupportDiagnostics();
  const clock = { now: () => now, schedule(fn, delay) { const timer = { fn, at: now + delay }; timers.add(timer); return () => timers.delete(timer); } };
  const service = new ServiceLifecycle(() => current, { concurrency: 1, queue: 0, bytes: 2048, items: 1, deadlineMs: 100 }, clock);
  const run = provider => runWithDiagnostics(log, source, service, { scope: { ...current }, bytes: 512, items: 1, deadline: now + 100, signal: new AbortController().signal }, provider, clock.now);
  return { service, log, run, timers, clock, change: patch => current = { ...current, ...patch }, tick(time) { now = time; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } } };
}
const reports = [];
for (const source of ['resolver', 'converter', 'host']) {
  test(`${source}: provider rejection has safe taxonomy and bounded recovery`, async () => {
    const f = fixture(source);
    const result = await f.run(() => { throw Object.assign(new Error(seeds.join(' ')), privatePayload, { toJSON() { throw Error('must not serialize provider error'); } }); });
    assert.deepEqual(result, { status: 'provider-failed' });
    const report = f.log.export(); noPrivate(report);
    assert.deepEqual(JSON.parse(report).events[0], { operation: 1, source, error: 'provider-failed', recovery: 'retry-bounded', elapsedMs: 0, active: 0, queued: 0, disposed: false });
    assert.equal(f.timers.size, 0); reports.push(JSON.parse(report)); f.service.dispose();
  });
  test(`${source}: successful private derived value stays out of support`, async () => {
    const f = fixture(source); const result = await f.run(() => privatePayload);
    assert.equal(result.status, 'ready'); assert.equal(result.value, privatePayload);
    noPrivate(f.log.export()); assert.equal(JSON.parse(f.log.export()).events[0].error, 'none');
    assert(!f.log.export().includes('durability')); assert.equal(f.timers.size, 0); f.service.dispose();
  });
}
for (const [patch, status, recovery] of [[{ authorized: false }, 'permission-loss', 'reauthorize'], [{ revision: 'new' }, 'stale-revision', 'refresh-derived'], [{ session: 'new' }, 'replaced-session', 'reopen-session']]) {
  test(`actual lifecycle ${status} recovery cannot revive a private preview`, async () => {
    const f = fixture('converter'), d = deferred(), pending = f.run(() => d.promise);
    f.change(patch); d.resolve(privatePayload);
    assert.equal((await pending).status, status);
    const report = JSON.parse(f.log.export()); assert.equal(report.events[0].recovery, recovery); noPrivate(f.log.export());
    assert.equal(f.timers.size, 0); f.service.dispose();
  });
}
test('queue saturation and disposal retain bounded occupied-slot evidence', async () => {
  const f = fixture('host'), d = deferred(), pending = f.run(() => d.promise);
  assert.equal((await f.run(() => { throw Error('saturated work must not start'); })).status, 'saturated');
  f.service.dispose(); assert.equal((await pending).status, 'disposed');
  const events = JSON.parse(f.log.export()).events;
  assert.deepEqual(events.map(e => e.recovery), ['wait-capacity', 'stop']); assert.equal(events[1].active, 1); assert.equal(events[1].disposed, true);
  d.resolve(privatePayload); await Promise.resolve(); assert.equal(f.service.state.active, 0); assert.equal(f.timers.size, 0); noPrivate(f.log.export());
});
test('deadline records elapsed cost and terminates caller without leaking late provider output', async () => {
  const f = fixture('converter'), d = deferred(), pending = f.run(() => d.promise); f.tick(100);
  assert.equal((await pending).status, 'deadline'); assert.equal(JSON.parse(f.log.export()).events[0].elapsedMs, 100);
  d.resolve(privatePayload); await Promise.resolve(); noPrivate(f.log.export()); assert.equal(f.timers.size, 0); f.service.dispose();
});
test('real reference lookup uses typed host-failure and permission recovery without query/title leaks', async () => {
  const log = new SupportDiagnostics(), f = fixture('resolver');
  let permission = { revision: seeds[4], lookup: true, insert: true }, disposed = 0;
  const listeners = new Set();
  const host = { version: 1, permission: () => permission, catalog: targetId => ({ targetId, status: 'cached', title: seeds[1] }), resolve(request) { assert.equal(request.query, seeds[0]); throw Object.assign(new Error(seeds[2]), privatePayload); }, subscribe(fn) { listeners.add(fn); return { dispose() { disposed++; listeners.delete(fn); } }; } };
  const lookup = new ReferenceLookupSession(host, () => {}, { context: scope, clock: f.clock });
  await assert.rejects(lookup.search({ query: seeds[0], requestId: 0, signal: new AbortController().signal }), error => { noPrivate(error.message); return error.message === 'Reference resolver failed'; });
  assert.equal(lookup.lastOutcome, 'provider-failed'); log.record('resolver', lookup.lastOutcome, 7);
  permission = { ...permission, revision: 'revoked', lookup: false }; for (const fn of listeners) fn();
  assert.deepEqual(await lookup.search({ query: seeds[0], requestId: 1, signal: new AbortController().signal }), []);
  assert.equal(lookup.lastOutcome, 'permission-loss'); log.record('resolver', lookup.lastOutcome, 1);
  noPrivate(log.export()); assert.deepEqual(JSON.parse(log.export()).events.map(e => e.recovery), ['retry-bounded', 'reauthorize']);
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await lookup.search({ query: seeds[0], requestId: 2, signal: aborted.signal }), []); assert.equal(lookup.lastOutcome, 'cancelled');
  await assert.rejects(lookup.search({ query: seeds[0].repeat(20), requestId: 3, signal: new AbortController().signal }), /Invalid reference query/); assert.equal(lookup.lastOutcome, 'invalid');
  reports.push(JSON.parse(log.export())); lookup.dispose();
  assert.deepEqual(await lookup.search({ query: seeds[0], requestId: 4, signal: new AbortController().signal }), []); assert.equal(lookup.lastOutcome, 'disposed');
  assert.equal(disposed, 1); assert.equal(listeners.size, 0); assert.equal(f.timers.size, 0); f.service.dispose();
});
test('untyped status/source/metrics are allowlisted; flood export is bounded', () => {
  const log = new SupportDiagnostics();
  for (let i = 0; i < 1000; i++) log.record(seeds[1], seeds[2], Number.MAX_VALUE, { active: Number.MAX_VALUE, queued: -1, disposed: seeds[3], extra: privatePayload });
  const report = log.export(); noPrivate(report); assert(Buffer.byteLength(report) < 32 * 1024);
  const parsed = JSON.parse(report); assert.equal(parsed.events.length, 64); assert.equal(parsed.dropped, 936);
  assert.deepEqual(parsed.events[0], { operation: 937, source: 'host', error: 'provider-failed', recovery: 'retry-bounded', elapsedMs: 86400000, active: 4096, queued: 0, disposed: false });
  for (const bad of [NaN, Infinity, -Infinity, seeds[4], undefined]) { log.record('host', '__proto__', bad, { active: bad, queued: bad, disposed: false }); }
  const final = JSON.parse(log.export()); assert.equal(final.events.at(-1).elapsedMs, 0); reports.push(final);
});
test('portable and web service taxonomy consume the exact shared vectors', () => {
  const codes = { Ready: 'ready', Invalid: 'invalid', ResourceLimit: 'resource-limit', Saturated: 'saturated', Cancelled: 'cancelled', Disposed: 'disposed', Deadline: 'deadline', StaleRevision: 'stale-revision', ReplacedSession: 'replaced-session', PermissionLoss: 'permission-loss', ProviderFailed: 'provider-failed' };
  const rows = readFileSync(resolve(root, 'tests/architecture/diagnostics/failures.tsv'), 'utf8').trim().split('\n').filter(row => row.startsWith('service '));
  assert.equal(rows.length, Object.keys(codes).length);
  for (const row of rows) { const [, name, code, recovery] = row.split(/\s+/); assert.deepEqual(serviceDiagnostic(codes[name]), { code, recovery }); }
});
test('canonical registration rejects unknown/zero suites and skipped counts', () => {
  const policy = JSON.parse(readFileSync(resolve(root, 'contracts/layers.json')));
  assert.equal(selectSuite(policy, ['--suite', 'diagnostics']).tests.length, 1);
  assert.throws(() => selectSuite(policy, ['--suite', 'unknown'])); assert.throws(() => selectSuite({ suites: { diagnostics: { tests: [] } } }, ['--suite', 'diagnostics']));
  assert.throws(() => testCounts('# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0'));
  assert.throws(() => testCounts('# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0'));
});
test('actual Rust store/session and portable export proof execute without skips', () => {
  const args = ['test', '-p', 'editac-session', '--test', 'diagnostics', '--locked', '--offline'];
  const run = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 240000 });
  const log = (run.stdout ?? '') + (run.stderr ?? ''); writeFileSync(resolve(output, 'rust-diagnostics.log'), log);
  const match = log.match(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out/);
  const receipt = { command: ['cargo', ...args], exit: run.status, error: run.error?.message ?? null, counts: match ? { passed: +match[1], failed: +match[2], skipped: +match[3], filtered: +match[4] } : null, logHash: hash(log) };
  writeFileSync(resolve(output, 'rust-diagnostics.json'), JSON.stringify(receipt, null, 2) + '\n');
  assert.equal(run.status, 0, 'see rust-diagnostics.log'); assert(receipt.counts?.passed > 0); assert.deepEqual([receipt.counts.failed, receipt.counts.skipped, receipt.counts.filtered], [0, 0, 0]);
  for (const name of ['store-support.json', 'locator-support.json', 'bounded-support.json', 'derived-support.json', 'session-bounded-support.json']) {
    const raw = readFileSync(resolve(output, name), 'utf8'); noPrivate(raw); const artifact = JSON.parse(raw);
    assert.equal(artifact.version, 1); assert(artifact.events.length > 0 && artifact.events.length <= 64); assert(Buffer.byteLength(raw) < 32 * 1024);
    for (const event of artifact.events) { assert(Number.isSafeInteger(event.operation) && event.operation > 0); assert(event.elapsedMs <= 86400000); assert(event.active <= 4096 && event.queued <= 4096); }
  }
  const store = JSON.parse(readFileSync(resolve(output, 'store-support.json')));
  assert.equal(store.events.length, 6); assert.deepEqual(store.events.filter(e => e.state.local === 'unsaved').map(e => e.error), ['quota', 'quota', 'commit-unknown']);
  assert(store.events.filter(e => e.state.local !== 'unsaved').every(e => e.state.durability === 'volatile'), 'prepared memory cannot claim crash durability');
});
after(() => {
  writeFileSync(resolve(output, 'web-support.json'), JSON.stringify(reports, null, 2) + '\n');
  const inputs = ['crates/editac-session/src/diagnostics.rs', 'crates/editac-session/src/lib.rs', 'crates/editac-session/src/session.rs', 'crates/editac-session/src/ports.rs', 'crates/editac-session/src/ports/memory.rs', 'crates/editac-session/src/locator.rs', 'crates/editac-session/src/service_lifecycle.rs', 'crates/editac-session/tests/diagnostics.rs', 'packages/web/src/services/diagnostics.ts', 'packages/web/src/services/lifecycle.ts', 'packages/web/src/modules/references.ts', 'packages/web/src/modules/index.ts', 'tests/architecture/diagnostics/failures.tsv', 'tests/architecture/diagnostics/diagnostics.test.mjs', 'contracts/services.json', 'Cargo.lock', 'package-lock.json', '../architecture/specs/ecosystem-maintainability.md'];
  writeFileSync(resolve(output, 'diagnostics-inputs.json'), JSON.stringify({ version: 1, implementation: Object.fromEntries(inputs.map(path => [path, hash(readFileSync(resolve(root, path)))])), bundleHash: hash(readFileSync(bundle)), scope: 'Actual portable session/fault-injected memory store, production reference lookup and web lifecycle; prepared converter/host providers. No native crash durability, optional-provider qualification, publication or live-provider calls.' }, null, 2) + '\n');
});
