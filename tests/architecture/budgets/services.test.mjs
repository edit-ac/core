import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { verifyBrowserSources } from '../../../scripts/browser-source-reuse.mjs';
import { inspectServices } from '../../../scripts/service-evidence.mjs';
import { fixture } from '../../../benchmarks/fixtures.mjs';
import { presets } from '../../../benchmarks/presets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/services-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/service-evidence.json'));
const resultBytes = await read(`${index.directory}/results.json`), record = JSON.parse(resultBytes);
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-03 browser diagnostics with prepared host responses; no optional runtime/performance qualification', artifacts: {}, observations: null };
test('owning actual editor/lifecycle/resolver/sync matrix retains exact sources, runtime, corpus and raw observations', async () => {
  assert.equal(record.status, 'diagnostic'); assert.deepEqual(record.errors, []);
  assert.equal(index.resultsHash, digest(resultBytes)); assert.equal(record.profileHash, digest(profileBytes));
  await verifyPins(root, record.sourceInputs); await verifyPins(resolve(root, index.directory), record.artifacts);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), record.artifacts[`harness/wasm/${file}`]);
  const servicePolicy = JSON.parse(await read('contracts/services.json'));
  assert.equal(servicePolicy.families.find(f => f.id === 'resolver').registration, 'implemented');
  assert.equal(servicePolicy.families.find(f => f.id === 'highlight').registration, 'pending');
  assert.equal(profile.resolverLimits.concurrency, servicePolicy.resolverLimits.concurrency); assert.equal(profile.resolverLimits.queue, servicePolicy.resolverLimits.queue);
  for (const item of record.cases) {
    assert.equal(item.fixtureHash, digest(JSON.stringify(fixture(item.fixture))));
    assert.equal(item.chars, fixture(item.fixture).chars); assert.equal(item.blocks, fixture(item.fixture).blocks.length);
    assert.deepEqual(item.features, presets[item.preset].featureSet);
    assert.equal(item.checkpointHash, record.artifacts[`fixtures/${item.fixture}.checkpoint.json`]);
  }
  for (const name of profile.fixtures) {
    const pair = record.cases.filter(c => c.fixture === name); assert.equal(pair.length, 2);
    assert.equal(pair[0].checkpointHash, pair[1].checkpointHash); assert.equal(pair[0].semanticHash, pair[1].semanticHash);
  }
  evidence.observations = inspectServices(profile, record);
  evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});
const mutate = fn => { const r = structuredClone(record); fn(r); return r; };
const observation = (r, kind) => r.cases[0].observations.find(o => o.kind === kind);
for (const [name, change] of [
  ['skipped case', r => r.counts.skipped++], ['failed case', r => r.counts.failed++], ['zero cases', r => r.counts.executed = 0],
  ['duplicate preset', r => r.cases[1].preset = r.cases[0].preset], ['missing hardware', r => delete r.metadata.cpu], ['missing review order', r => r.metadata.startedAt = profile.reviewedAt],
  ['browser leak', r => r.cleanup.browserExited = false], ['timer leak', r => r.cases[0].cleanup.timers++], ['listener leak', r => r.cases[0].cleanup.hostListeners++],
  ['occupied provider after disposal', r => r.cases[0].cleanup.service.active++], ['database leak', r => r.cases[0].cleanup.databaseDeleted = false], ['unsaved work', r => r.cases[0].cleanup.unsaved = true],
  ['fake qualification', r => r.qualification = 'qualified'], ['fake highlighting runtime', r => r.cases[0].providers.highlight = 'implemented'],
  ['missing observation', r => r.cases[0].observations.pop()], ['missing fixture identity', r => delete r.cases[0].checkpointHash], ['changed corpus size', r => r.cases[0].finalChars--],
  ['lost semantic edit', r => r.cases[0].finalText.selected = r.cases[0].finalText.initialSelected],
  ['excess queue', r => observation(r, 'queue').states[0].queued = 3], ['excess active providers', r => observation(r, 'queue').states[0].active = 2],
  ['missing terminal result', r => observation(r, 'queue').outcomes.pop()], ['incorrect terminal result', r => observation(r, 'queue').outcomes[2].status = 'saturated'],
  ['missing abort', r => observation(r, 'queue').aborts[0] = false], ['negative raw duration', r => observation(r, 'queue').outcomes[0].elapsedMs = -1],
  ['replacement stampede', r => observation(r, 'resolver-storm').peak++], ['stale resolver result', r => observation(r, 'resolver-storm').outcomes[0].results++],
  ['failed resolver recovery', r => observation(r, 'resolver-storm').recovered.results = 0],
  ['unrelated edit invalidates queue', r => observation(r, 'edit-invalidation').afterUnrelated.queued = 0],
  ['queued stale work starts', r => observation(r, 'edit-invalidation').providerCallsDuringInvalidation++],
  ['stale service ready', r => observation(r, 'edit-invalidation').outcomes[0].status = 'ready'],
  ['unrelated node patch', r => observation(r, 'edit-invalidation').localPatches[0].changedNodes.push(r.cases[0].unrelated)],
  ['unrelated DOM mutation', r => observation(r, 'edit-invalidation').localMutations.push(r.cases[0].unrelated)],
  ['lost edit commits', r => observation(r, 'edit-invalidation').localPatches.pop()],
  ['missing sync frames', r => observation(r, 'collaboration').frameBytes.pop()], ['sync queue overflow', r => observation(r, 'collaboration').pumps[0].incomingFrames = 33],
  ['undrained sync queue', r => observation(r, 'collaboration').pumps.at(-1).incomingFrames++],
  ['lost remote commit', r => observation(r, 'collaboration').remotePatches.pop()], ['remote diverged', r => observation(r, 'collaboration').converged = false],
  ['remote stale result admitted', r => observation(r, 'collaboration').staleOutcome.results++], ['remote unrelated DOM mutation', r => observation(r, 'collaboration').mutations.push(r.cases[0].unrelated)],
]) test(`service admission rejects ${name}`, () => assert.throws(() => inspectServices(profile, mutate(change))));
test('resource/matrix/method drift and unreviewed performance qualification fail admission', () => {
  for (const change of [p => p.limits.queue++, p => p.fixtures.pop(), p => p.burst--, p => p.editMethod = 'truncate', p => p.performanceLimits = { latencyMs: 999 }]) {
    const p = structuredClone(profile); change(p); assert.throws(() => inspectServices(p, record));
  }
});
test('browser source reuse rejects additional source paths and unreviewed revisions', async () => {
  const policy = JSON.parse(await read('benchmarks/profiles/browser-source-reuse.json'));
  for (const change of [p => p.changes['crates/editac-core/Cargo.toml'] = {}, p => p.afterRevision = '0'.repeat(40), p => p.changes['Cargo.lock'].after = '0'.repeat(64)]) {
    const p = structuredClone(policy); change(p); await assert.rejects(verifyBrowserSources(root, record.sourceInputs, p));
  }
});
after(async () => {
  assert(process.env.EDITAC_ARCHITECTURE_OUTPUT); await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'services-inventory.json'), JSON.stringify(evidence, null, 2) + '\n');
});
