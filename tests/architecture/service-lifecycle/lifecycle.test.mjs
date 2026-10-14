import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { hash } from '../../../scripts/architecture-layers.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
assert(output, 'canonical isolated architecture output required');
mkdirSync(output, { recursive: true });
const bundle = resolve(output, 'service-adapters.mjs');
await build({ absWorkingDir: root, entryPoints: ['packages/web/src/modules/references.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const lifecycleBundle = resolve(output, 'lifecycle.mjs');
await build({ absWorkingDir: root, entryPoints: ['packages/web/src/services/lifecycle.ts'], bundle: true, platform: 'node', format: 'esm', outfile: lifecycleBundle, logLevel: 'silent' });
const { ServiceLifecycle, serviceScopeFailure } = await import(pathToFileURL(lifecycleBundle));
const { ReferenceLookupSession } = await import(pathToFileURL(bundle));
const scope = () => ({ document: 'd', session: 's', revision: 'r', permission: 'p', authorized: true });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(limits = {}) {
  let current = scope(), now = 0;
  const timers = new Set(), pending = [];
  const clock = { now: () => now, schedule(fn, ms) { const timer = { fn, at: now + ms }; timers.add(timer); return () => timers.delete(timer); } };
  const service = new ServiceLifecycle(() => current, { concurrency: 1, queue: 1, bytes: 8, items: 2, deadlineMs: 100, ...limits }, clock);
  const controllers = [];
  const run = (patch = {}, value = 'derived') => {
    const controller = new AbortController(); controllers.push(controller);
    const result = service.run({ scope: { ...current }, bytes: 8, items: 2, deadline: now + 100, signal: controller.signal, ...patch }, signal => { const d = deferred(); pending.push({ ...d, signal, value }); return d.promise; });
    return result;
  };
  return { service, run, pending, controllers, timers, clock, change: patch => current = { ...current, ...patch }, tick: time => { now = time; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } } };
}
const registryPath = 'contracts/services.json';
const registry = JSON.parse(readFileSync(resolve(root, registryPath)));
const samples = { highlight: [{ start: 0, end: 4, kind: 'keyword' }], asset: { contentHash: 'fixture', bytes: 4 }, resolver: [{ targetId: 'opaque', label: 'Label' }], conversion: { preview: 'bounded preview', fidelity: 'fixture-only' } };
const executedFamilies = [];
for (const family of registry.families) {
  test(`${family.id}: exact common scope vectors`, () => {
    for (const line of readFileSync(resolve(root, 'tests/architecture/service-lifecycle/scopes.tsv'), 'utf8').trim().split('\n').filter(l => !l.startsWith('#'))) {
      const [id, document, session, revision, permission, authorized, status] = line.split(/\s+/);
      assert.equal(serviceScopeFailure(scope(), { document: document === '-' ? '' : document, session, revision, permission, authorized: authorized === 'true' }) ?? 'ready', status, id);
    }
  });
  test(`${family.id}: bounded FIFO rejects excess without losing accepted work`, async () => {
    const f = fixture(), a = f.run(), b = f.run(), rejected = f.run();
    assert.equal((await rejected).status, 'saturated'); assert.equal(f.pending.length, 1);
    const value = samples[family.id]; f.pending[0].resolve(value); assert.deepEqual((await a).value, value);
    await flush(); assert.equal(f.pending.length, 2); f.pending[1].resolve(value); assert.deepEqual((await b).value, value);
    assert.deepEqual(f.service.state, { active: 0, queued: 0, disposed: false }); assert.equal(f.timers.size, 0); executedFamilies.push(family.id);
  });
  test(`${family.id}: noncooperative cancellation settles once and retains slot`, async () => {
    const f = fixture(), a = f.run(); f.controllers[0].abort(); assert.equal((await a).status, 'cancelled');
    assert(f.pending[0].signal.aborted); const b = f.run(); assert.equal((await f.run()).status, 'saturated'); assert.equal(f.pending.length, 1);
    f.pending[0].reject(new Error('late failure')); await flush(); assert.equal(f.pending.length, 2);
    f.pending[1].resolve(samples[family.id]); assert.equal((await b).status, 'ready'); assert.equal((await a).status, 'cancelled');
  });
  test(`${family.id}: queued cancellation never starts provider`, async () => {
    const f = fixture(), a = f.run(), b = f.run(); f.controllers[1].abort(); assert.equal((await b).status, 'cancelled'); assert.equal(f.service.state.queued, 0);
    f.pending[0].resolve('ready'); await a; await flush(); assert.equal(f.pending.length, 1); assert.equal(f.timers.size, 0);
  });
  for (const [patch, status] of [[{ revision: 'r2' }, 'stale-revision'], [{ session: 's2' }, 'replaced-session'], [{ authorized: false }, 'permission-loss'], [{ permission: 'p2' }, 'permission-loss']]) {
    test(`${family.id}: silent ${status} invalidates completed work`, async () => {
      const f = fixture(), a = f.run(); f.change(patch); f.pending[0].resolve(samples[family.id]); assert.equal((await a).status, status); assert.equal(f.timers.size, 0);
    });
  }
  test(`${family.id}: notified permission loss settles active and queue`, async () => {
    const f = fixture(), a = f.run(), b = f.run(); f.change({ authorized: false }); f.service.revalidate();
    assert.equal((await a).status, 'permission-loss'); assert.equal((await b).status, 'permission-loss'); assert(f.pending[0].signal.aborted); assert.equal(f.timers.size, 0);
    f.pending[0].resolve('late'); await flush(); assert.equal(f.pending.length, 1); assert.equal(f.service.state.active, 0);
  });
  test(`${family.id}: disposal settles active and queue and cleans timers`, async () => {
    const f = fixture(), a = f.run(), b = f.run(); f.service.dispose(); f.service.dispose();
    assert.equal((await a).status, 'disposed'); assert.equal((await b).status, 'disposed'); assert.equal((await f.run()).status, 'disposed');
    assert.equal(f.timers.size, 0); assert(f.pending[0].signal.aborted); f.pending[0].resolve('late'); await flush(); assert.equal(f.service.state.active, 0);
  });
  test(`${family.id}: deadline settles stuck provider and queued work`, async () => {
    const f = fixture(), a = f.run(), b = f.run(); f.tick(100);
    assert.equal((await a).status, 'deadline'); assert.equal((await b).status, 'deadline'); assert.equal(f.service.state.active, 1); assert.equal(f.service.state.queued, 0);
    f.pending[0].resolve('late'); await flush(); assert.equal(f.timers.size, 0);
  });
  test(`${family.id}: scope is revalidated before queued provider starts`, async () => {
    const f = fixture(), a = f.run(), b = f.run(); f.change({ revision: 'r2' }); f.pending[0].resolve('old');
    assert.equal((await a).status, 'stale-revision'); assert.equal((await b).status, 'stale-revision'); assert.equal(f.pending.length, 1);
  });
  test(`${family.id}: ready result still requires apply-time scope revalidation`, async () => {
    const f = fixture(), a = f.run(); f.pending[0].resolve(samples[family.id]); const result = await a;
    assert.equal(result.status, 'ready'); assert.equal(f.service.check(result.scope), undefined); f.change({ revision: 'r2' }); assert.equal(f.service.check(result.scope), 'stale-revision');
  });
}
for (const [patch, status] of [[{ bytes: 9 }, 'resource-limit'], [{ items: 3 }, 'resource-limit'], [{ bytes: -1 }, 'invalid'], [{ items: 1.5 }, 'invalid'], [{ deadline: Infinity }, 'invalid'], [{ deadline: 101 }, 'invalid'], [{ deadline: 0 }, 'deadline'], [{ scope: { ...scope(), document: '' } }, 'invalid']]) {
  test(`admission rejects ${JSON.stringify(patch)}`, async () => { const f = fixture(); assert.equal((await f.run(patch)).status, status); assert.equal(f.pending.length, 0); assert.equal(f.timers.size, 0); });
}
test('provider errors have bounded typed outcomes and drain queue', async () => { const f = fixture(), a = f.run(), b = f.run(); f.pending[0].reject({ token: 'PRIVATE' }); assert.deepEqual(await a, { status: 'provider-failed' }); await flush(); f.pending[1].resolve('next'); assert.equal((await b).status, 'ready'); });
test('limits are owned and invalid limits rejected', () => { const limits = { concurrency: 1, queue: 0, bytes: 8, items: 2, deadlineMs: 100 }; const l = new ServiceLifecycle(scope, limits); limits.concurrency = 999; assert.equal(l.limits.concurrency, 1); for (const patch of [{ concurrency: 0 }, { concurrency: 65 }, { queue: -1 }, { bytes: 0 }, { deadlineMs: 0 }]) assert.throws(() => new ServiceLifecycle(scope, { ...limits, ...patch })); });
function lookupFixture() {
  let permission = { revision: 'p', lookup: true, insert: true }, context = { document: 'd', session: 's', revision: 'r' }, disposed = 0;
  const callbacks = new Set(), pending = [], f = fixture();
  const target = { targetId: 'opaque', label: 'Label' };
  const host = { version: 1, permission: () => permission, catalog: targetId => ({ targetId, status: 'cached' }), resolve(request) { const d = deferred(); pending.push({ ...d, request }); return d.promise; }, subscribe(fn) { callbacks.add(fn); return { dispose() { disposed++; callbacks.delete(fn); } }; } };
  const lookup = new ReferenceLookupSession(host, () => {}, { context: () => context, clock: f.clock });
  return { lookup, pending, target, query: () => lookup.search({ query: 'text', requestId: pending.length, signal: new AbortController().signal }), change: patch => context = { ...context, ...patch }, revoke: () => { permission = { ...permission, lookup: false, revision: 'p2' }; for (const fn of callbacks) fn(); }, tick: f.tick, stats: () => ({ disposed, listeners: callbacks.size }) };
}
test('real resolver bounds repeated supersession of stuck host providers', async () => {
  const f = lookupFixture(), a = f.query(), b = f.query(), c = f.query();
  assert.deepEqual(await a, []); assert.deepEqual(await b, []); assert.deepEqual(await c, []); assert.equal(f.lookup.lastOutcome, 'saturated'); assert.equal(f.pending.length, 2);
  f.pending[0].resolve([f.target]); f.pending[1].resolve([f.target]); await flush();
  const d = f.query(); f.pending[2].resolve([f.target]); assert.deepEqual(await d, [f.target]); assert.deepEqual(f.lookup.admit(f.target), f.target); f.lookup.dispose();
});
for (const patch of [{ revision: 'r2' }, { session: 's2' }, { document: 'd2' }]) test(`real resolver rejects changed scope ${JSON.stringify(patch)}`, async () => { const f = lookupFixture(), a = f.query(); f.change(patch); f.pending[0].resolve([f.target]); assert.deepEqual(await a, []); assert.equal(f.lookup.admit(f.target), undefined); f.lookup.dispose(); });
test('real resolver revalidates ready data at insertion', async () => { const f = lookupFixture(), a = f.query(); f.pending[0].resolve([f.target]); await a; f.change({ revision: 'r2' }); assert.equal(f.lookup.admit(f.target), undefined); f.lookup.dispose(); });
test('real resolver settles revocation without waiting for host response', async () => { const f = lookupFixture(), a = f.query(); f.revoke(); assert.deepEqual(await a, []); assert.equal(f.lookup.lastOutcome, 'permission-loss'); assert(f.pending[0].request.signal.aborted); f.lookup.dispose(); f.lookup.dispose(); assert.deepEqual(f.stats(), { disposed: 1, listeners: 0 }); });
test('real resolver deadline and disposal promptly settle uncooperative providers', async () => { for (const action of ['deadline', 'dispose']) { const f = lookupFixture(), a = f.query(); if (action === 'deadline') f.tick(10000); else f.lookup.dispose(); assert.deepEqual(await a, []); assert.equal(f.lookup.lastOutcome, action === 'dispose' ? 'disposed' : 'deadline'); assert(f.pending[0].request.signal.aborted); f.lookup.dispose(); } });
test('separate real resolver instances retain stable default session identities', async () => { const f = lookupFixture(); const host = { version: 1, permission: () => ({ revision: 'p', lookup: true, insert: true }), catalog: targetId => ({ targetId, status: 'cached' }), resolve: () => [f.target], subscribe: () => ({ dispose() {} }) }; const a = new ReferenceLookupSession(host), b = new ReferenceLookupSession(host); const results = await a.search({ query: '', requestId: 0, signal: new AbortController().signal }); assert.deepEqual(results, [f.target]); a.dispose(); b.dispose(); f.lookup.dispose(); });
test('reentrant host disposal rejects work before provider invocation', async () => { let service; service = new ServiceLifecycle(() => { service.dispose(); return scope(); }, { concurrency: 1, queue: 0, bytes: 8, items: 2, deadlineMs: 100 }); let calls = 0; const result = await service.run({ scope: scope(), bytes: 1, items: 1, deadline: performance.now() + 50, signal: new AbortController().signal }, () => { calls++; }); assert.equal(result.status, 'disposed'); assert.equal(calls, 0); });
test('portable Rust lifecycle and real durable-session proof execute with no skips', () => {
  const args = ['test', '-p', 'editac-session', '--test', 'service_lifecycle', '--locked', '--offline'];
  const run = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const log = (run.stdout ?? '') + (run.stderr ?? ''); writeFileSync(resolve(output, 'rust-lifecycle.log'), log);
  const match = log.match(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out/);
  const receipt = { command: ['cargo', ...args], exit: run.status, counts: match ? { passed: +match[1], failed: +match[2], skipped: +match[3], filtered: +match[4] } : null, logHash: hash(log) };
  writeFileSync(resolve(output, 'rust-lifecycle.json'), JSON.stringify(receipt, null, 2) + '\n');
  assert.equal(run.status, 0, 'see rust-lifecycle.log'); assert(receipt.counts?.passed > 0); assert.deepEqual([receipt.counts.failed, receipt.counts.skipped, receipt.counts.filtered], [0, 0, 0]);
});
after(() => { writeFileSync(resolve(output, 'service-lifecycle-inventory.json'), JSON.stringify({ version: 1, registryHash: hash(readFileSync(resolve(root, registryPath))), families: registry.families, executedFamilies, bundles: { 'service-adapters.mjs': hash(readFileSync(bundle)), 'lifecycle.mjs': hash(readFileSync(lifecycleBundle)) }, scope: 'current production resolver and portable admission; other providers prepared only; no native or optional-feature runtime claim' }, null, 2) + '\n'); });
