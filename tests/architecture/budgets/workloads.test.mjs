import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { inspectWorkloads } from '../../../scripts/workload-evidence.mjs';
import { workload, expectedWorkload } from '../../../benchmarks/workloads.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url)), read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/workloads-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/workload-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const resultBytes = await read(`${index.directory}/results.json`), record = JSON.parse(resultBytes);
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-04 actual editor/content-module workload diagnostics; no performance/peak qualification', artifacts: {}, observations: null };
test('owning workload matrix pins actual runtime, independent full workload oracles, preset checkpoints and raw heap/replay samples', async () => {
  assert.equal(record.status, 'diagnostic'); assert.deepEqual(record.errors, []);
  assert.equal(index.resultsHash, digest(resultBytes)); assert.equal(record.profileHash, digest(profileBytes));
  assert.equal(profile.warmupPolicy, 'WASM initialized before each mount timer; twelve sequential replays, no discarded warmup samples');
  assert.equal(profile.seedContext, 'Isolated preparation context closed before both fresh preset contexts');
  assert.equal(profile.semanticPolicy, 'Preserve exact text, attributes, arrays and all distinct mark boundaries; canonical object keys and merge only adjacent runs with identical complete mark maps; retain raw initial run segments');
  for (const field of ['warmupPolicy', 'seedContext', 'semanticPolicy']) assert.equal(record.metadata[field], profile[field]);
  const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'fixtures/schema-v5', 'Cargo.lock', 'Cargo.toml', 'package-lock.json', 'package.json', 'scripts/build-wasm.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0);
  const inputs = [...new Set([...tracked.stdout.trim().split('\n'), 'benchmarks/profiles/workloads-v1.json', 'benchmarks/workload-client.mjs', 'benchmarks/workloads.mjs', 'benchmarks/workload-image.png', 'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'scripts/workload-evidence.mjs', 'scripts/table-workload-accessibility.mjs', 'scripts/bench-workloads.mjs'])];
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), inputs.sort()); await verifyPins(root, record.sourceInputs);
  await verifyPins(resolve(root, index.directory), record.artifacts);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), record.artifacts[`harness/wasm/${file}`]);
  assert.equal(digest(await read('benchmarks/workload-image.png')), record.artifacts['harness/workload-image.png']);
  for (const item of record.cases) {
    const key = `${item.scale}-${item.kind}`, bytes = await read(`${index.directory}/fixtures/${key}.json`);
    const document = workload(profile, item.scale, item.kind);
    assert.equal(bytes.toString(), JSON.stringify(document));
    const expected = expectedWorkload(document);
    assert.equal(item.initialRunSegments.length, expected.length);
    for (const [i, runs] of item.initialRunSegments.entries()) {
      assert.equal(runs.reduce((sum, r) => sum + r.units, 0), expected[i].text.length);
      assert(runs.every(r => Object.keys(r.attributes).length === 0));
    }
    assert.equal(item.fixtureHash, digest(bytes)); assert.equal(item.checkpointHash, record.artifacts[`fixtures/${key}.checkpoint.json`]);
  }
  evidence.observations = inspectWorkloads(profile, record);
  evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});
const mutate = fn => { const r = structuredClone(record); fn(r); return r; };
const item = (r, kind = 'long-line') => r.cases.find(c => c.kind === kind);
for (const [name, change] of [
  ['skipped case', r => r.counts.skipped++], ['failed case', r => r.counts.failed++], ['zero cases', r => r.counts.executed = 0],
  ['missing matrix case', r => r.cases.pop()], ['duplicate preset', r => r.cases[1].preset = r.cases[0].preset], ['missing hardware', r => delete r.metadata.cpu],
  ['unreviewed measurement', r => r.metadata.startedAt = profile.reviewedAt], ['fake qualification', r => r.qualification = 'qualified'],
  ['browser leak', r => r.cleanup.browserExited = false], ['server leak', r => r.cleanup.serverClosed = false],
  ['missing source identity', r => delete item(r).checkpointHash], ['incomparable preset', r => r.cases[1].checkpointHash = '0'.repeat(64)],
  ['changed fixture', r => item(r).fixtureHash = '0'.repeat(64)], ['silently shortened workload', r => item(r).dimensions.textUnits--],
  ['semantic loss', r => item(r).finalSemanticHash = '0'.repeat(64)], ['invented expected semantics', r => item(r).expectedSemanticHash = '0'.repeat(64)],
  ['missing features', r => item(r).features.pop()], ['runtime error', r => item(r).errors.push('failure')], ['external image', r => item(r, 'images').requests[0].sameOrigin = false],
  ['unsupported memory scope', r => item(r).memoryScope = 'total process peak'], ['unsupported input claim', r => item(r).inputScope = 'OS input'],
  ['missing sample', r => item(r).samples.pop()], ['negative replay', r => item(r).samples[0].replayMs = -1], ['missing raw attribution', r => delete item(r).samples[0].startTime],
  ['missing writer timings', r => delete item(r).samples[0].commandRestoreMs], ['missing frames', r => item(r).samples[0].frames.pop()],
  ['unrestored semantics', r => item(r).samples[0].semanticRestored = false], ['missing native endpoint', r => item(r).samples[0].selection.focusNode = false],
  ['partial native range', r => item(r).samples[0].selection.units--], ['partial table selection', r => item(r, 'table-selection').samples[0].selection.cells--],
  ['wrong table control endpoint', r => item(r, 'table-selection').samples[0].selection.end--], ['lost table text', r => item(r, 'table-selection').samples[0].selection.lastValue = 'short'],
  ['missing long-task trace', r => delete item(r).longTasks], ['invalid long task', r => item(r).longTasks.push({ startTime: 0, duration: -1 })],
  ['missing memory boundary', r => item(r).memory.pop()], ['missing backing observation', r => delete item(r).memory[0].backingStorageSize],
  ['impossible heap', r => item(r).memory[0].usedSize = item(r).memory[0].totalSize + 1], ['missing production views', r => item(r, 'images').dom.views--],
  ['partial table controls', r => item(r, 'table-selection').dom.controls--], ['undecoded image', r => item(r, 'images').dom.images[0].complete = false],
  ['changed image dimensions', r => item(r, 'images').dom.images[0].width--], ['missing host admission', r => item(r, 'images').dom.imagePolicyCalls--],
  ['live content view', r => item(r).cleanup.activeViews++], ['live image source', r => item(r, 'images').cleanup.activeImageSources++],
  ['live editor', r => item(r).cleanup.editorReady = true], ['unsaved work', r => item(r).cleanup.unsaved = true], ['database leak', r => item(r).cleanup.databaseDeleted = false],
]) test(`workload admission rejects ${name}`, () => assert.throws(() => inspectWorkloads(profile, mutate(change))));
test('profile rejects workload reductions, sample drift and invented release limits', () => {
  for (const change of [p => p.samples--, p => p.limits.tableRows.Long--, p => p.limits.textBytes.Long--, p => p.limits.images.Long--, p => p.workloads.pop(), p => p.performanceLimits = { latencyMs: 999 }]) {
    const p = structuredClone(profile); change(p); assert.throws(() => inspectWorkloads(p, record));
  }
});
after(async () => { assert(process.env.EDITAC_ARCHITECTURE_OUTPUT); await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'workloads-inventory.json'), JSON.stringify(evidence, null, 2) + '\n'); });
