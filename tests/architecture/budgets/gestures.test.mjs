import { build } from 'esbuild';
import { gestureInstrumentation } from '../../../scripts/gesture-instrumentation.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { digest, verifyPins, validateFitnessProfile } from '../../../scripts/architecture-budgets.mjs';
import { inspectGestures, validateGesturePolicy } from '../../../scripts/gesture-evidence.mjs';
import { fixture } from '../../../benchmarks/fixtures.mjs';
import { presets } from '../../../benchmarks/presets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/gestures-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/gesture-evidence.json'));
const resultBytes = await read(`${index.directory}/results.json`), record = JSON.parse(resultBytes);
const fitnessPolicy = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-02 browser diagnostics only', artifacts: {}, observations: null };
test('owning trusted-input gesture matrix has current source/artifact/fixture identities and exact runtime counts', async () => {
  assert.equal(index.resultsHash, digest(resultBytes)); assert.equal(record.profileHash, digest(profileBytes));
  validateFitnessProfile(fitnessPolicy, await read('benchmarks/config.json'), await read('../architecture/specs/verification.md'));
  validateGesturePolicy(fitnessPolicy, record);
  for (const path of ['benchmarks/profiles/fitness-v1.json', 'benchmarks/config.json', 'scripts/architecture-budgets.mjs']) assert(record.sourceInputs[path], `Missing policy source ${path}`);
  await verifyPins(root, record.sourceInputs);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), record.artifacts[`harness/wasm/${file}`]);
  const rebuilt = await build({ plugins: [gestureInstrumentation()], stdin: { contents: 'export {createEditor,taskPreset,CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core";', resolveDir: root }, outfile: resolve(root, 'architecture-results/reuse-sdk.js'), write: false, bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  assert.equal(digest(rebuilt.outputFiles[0].contents), record.artifacts['harness/sdk.js'], 'Changed gesture executable; historical trace cannot be reused'); await verifyPins(resolve(root, index.directory), record.artifacts);
  for (const item of record.cases) {
    assert.equal(item.fixtureHash, digest(JSON.stringify(fixture(item.fixture))));
    assert.equal(item.chars, fixture(item.fixture).chars); assert.equal(item.blocks, fixture(item.fixture).blocks.length);
    assert.deepEqual(item.features, presets[item.preset].featureSet);
    assert.equal(item.checkpointHash, record.artifacts[`fixtures/${item.fixture}.checkpoint.json`]);
    for (const trace of item.gestures) {
      assert.equal(trace.setup.initialSelection.collapsed, trace.kind !== 'drag');
      for (const point of [trace.setup.start, trace.setup.end]) {
        assert(point.glyphWidth > 0 && Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.equal(point.nativeOffset, point.offset);
        assert(Number.isInteger(point.x) && Number.isInteger(point.y));
        assert(point.endpoint && Array.isArray(point.endpoint.path));
      }
      assert(trace.replayControl.afterDown.lastMouse.trusted);
      assert.equal(trace.replayControl.afterDown.lastMouse.type, 'mousedown');
      assert.equal(trace.replayControl.afterDown.lastMouse.x, Math.floor(trace.replayControl.requested.x));
      assert.equal(trace.replayControl.afterDown.lastMouse.y, Math.floor(trace.replayControl.requested.y));
      assert.deepEqual(trace.replayControl.afterDown.lastMouse.hit, trace.replayControl.requested.dispatchedHit);
      if (trace.kind !== 'drag') assert(trace.frames.some(f => f.positions > 0));
    }
  }
  for (const name of profile.fixtures) {
    const pair = record.cases.filter(c => c.fixture === name); assert.equal(pair.length, 2);
    assert.equal(pair[0].checkpointHash, pair[1].checkpointHash); assert.equal(pair[0].semanticHash, pair[1].semanticHash);
  }
  evidence.observations = inspectGestures(profile, record); assert.equal(evidence.observations.qualification, 'unqualified');
  evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});
const change = mutate => { const r = structuredClone(record); mutate(r); return r; };
for (const [name, mutate] of [
  ['native endpoint overflow', r => r.cases[0].gestures[0].endpointDropped++],
  ['missing endpoints', r => delete r.cases[0].gestures[0].nativeEndpoints],
  ['dispatched coordinate mismatch', r => r.cases[0].gestures[0].nativeEndpoints.find(e => e.type === 'mousedown').x++],
  ['native caret mismatch', r => r.cases[0].gestures[0].nativeEndpoints.find(e => e.type === 'mousedown').hit.offset++],
  ['wrong anchor', r => r.cases[0].gestures[0].afterDown.anchorMatches = false],
  ['wrong final focus', r => r.cases[0].gestures[0].endpointOracle.focusMatches = false],
  ['wrong independent range', r => r.cases[0].gestures[0].endpointOracle.expectedLength++],
  ['missing code autoscroll', r => r.cases[0].gestures.pop()],
  ['skipped runtime', r => r.counts.skipped++], ['failed runtime', r => r.counts.failed++], ['zero cases', r => r.counts.executed = 0],
  ['duplicate preset', r => r.cases[1].preset = r.cases[0].preset], ['unknown fixture', r => r.cases[0].fixture = 'small'],
  ['missing hardware', r => delete r.metadata.cpu], ['missing refresh', r => r.cases[0].refreshTimestamps = []],
  ['missing cancellation', r => r.cases[0].gestures[0].cancel.escape = false], ['collector leak', r => r.cases[0].gestures[0].collectorActive = true],
  ['continued scrolling', r => r.cases[0].gestures[2].afterCancel.scroll.inner++], ['mutation', r => r.cases[0].gestures[1].unchanged = false],
  ['full-document fallback', r => r.cases[0].gestures[0].frames[0].fullScan++], ['trailing full-document fallback', r => r.cases[0].gestures[0].trailingWork.fullScan++],
  ['invalid callback clock', r => r.cases[0].gestures[0].frames[0].callbackTime = 0], ['missing inner autoscroll', r => r.cases[0].gestures[2].endState.scroll.inner = 0], ['missing outer autoscroll', r => r.cases[0].gestures[2].endState.scroll.outer = 0],
  ['missing raw frames', r => r.cases[0].gestures[0].frames = []], ['invalid geometry', r => r.cases[0].gestures[0].frames[0].geometry = -1],
  ['missing scroll samples', r => delete r.cases[0].gestures[2].frames[0].scroll], ['overflow', r => r.cases[0].gestures[0].dropped++],
  ['synthetic input', r => r.cases[0].gestures[0].events[0].trusted = false], ['missing drag', r => r.cases[0].gestures[1].events = r.cases[0].gestures[1].events.filter(e => e.type !== 'dragstart')],
  ['uncanceled drop', r => r.cases[0].gestures[1].events.push({ type: 'drop', trusted: true, timestamp: 1 })],
  ['missing long tasks', r => delete r.cases[0].gestures[0].longTasks], ['browser leak', r => r.cleanup.browserExited = false],
  ['invented qualification', r => r.qualification = 'qualified'], ['missing teardown', r => delete r.cases[0].teardown],
]) test(`gesture admission rejects ${name}`, () => assert.throws(() => inspectGestures(profile, change(mutate))));
test('gesture-specific limits remain explicitly unreviewed', () => {
  const p = structuredClone(profile); p.performanceLimits = { frameMs: 999 }; assert.throws(() => inspectGestures(p, record));
});
test('changing native modifier or replay matrix invalidates the diagnostic profile', () => {
  for (const mutate of [p => p.autoscrollModifiers = ['Shift'], p => p.fixtures = ['Task'], p => p.pointerSteps = 5]) {
    const p = structuredClone(profile); mutate(p); assert.throws(() => inspectGestures(p, record));
  }
});
after(async () => {
  assert(process.env.EDITAC_ARCHITECTURE_OUTPUT); await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'gestures-inventory.json'), JSON.stringify(evidence, null, 2) + '\n');
});

for (const [name, mutate] of [
  ['missing policy', r => delete r.metadata.verificationPolicy],
  ['stale policy', r => r.metadata.verificationPolicy.sha256 = '0'.repeat(64)],
  ['wrong policy source', r => r.metadata.verificationPolicy.source = 'prepared'],
  ['missing retained policy', r => delete r.artifacts['policy/verification.md']],
  ['changed retained policy', r => r.artifacts['policy/verification.md'] = '0'.repeat(64)],
  ['stale policy review', r => r.metadata.verificationPolicy.reviewedAt = '2000-01-01T00:00:00.000Z'],
  ['measurement before review', r => r.metadata.startedAt = fitnessPolicy.reviewedAt],
]) test(`gesture policy rejects ${name}`, () => assert.throws(() => validateGesturePolicy(fitnessPolicy, change(mutate))));
