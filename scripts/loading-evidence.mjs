import { spawnSync } from 'node:child_process';
import { fixture } from '../benchmarks/fixtures.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { evaluateBudget, assertBudget } from './browser-size-contract.mjs';
const check = (ok, message) => { if (!ok) throw Error(message); };
const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json'], { encoding: 'utf8' });
if (tracked.status !== 0) throw Error('Cannot inventory runtime closure');
export const loadingInputs = [...new Set([...tracked.stdout.trim().split('\n'),
  'benchmarks/config.json', 'benchmarks/presets.mjs', 'benchmarks/profiles/loading-v1.json', 'benchmarks/loading-client.mjs', 'benchmarks/fixtures.mjs',
  'scripts/loading-evidence.mjs', 'scripts/bench-loading.mjs', 'scripts/check-browser-size.mjs', 'scripts/consumers-loading.mjs', 'scripts/browser-size-contract.mjs', 'scripts/minify-task.mjs', 'scripts/architecture-budgets.mjs', 'scripts/test-toolchain.mjs', '.node-version', 'examples/task-editor/index.html'])];
const finite = v => Number.isFinite(v) && v >= 0;
const phaseNames = ['module','wasmInit','editorCreate','editorReady','firstFrame','initialRead','initialProjection','initialHash','expectedFixture','expectedHash','targetRead','targetSelect','editAnchors','editCommand','editRelease','editVerify','restoreAnchors','restoreCommand','restoreRelease','finalRead','finalProjection','finalHash','flush'];
const coldPhases = ['checkpointFetch','checkpointDecode','checkpointOpen','checkpointPublish','checkpointClose'];
const oracleBeforeEdit = ['initialRead','initialProjection','initialHash','expectedFixture','expectedHash','targetRead','targetSelect'];
export function inspectStartupPhases(raw, mode) {
  const names = [...phaseNames]; if (mode === 'cold') names.splice(2, 0, ...coldPhases);
  check(raw.phaseAttribution === 'navigation-phases-v1', 'Missing startup phase identity');
  check(JSON.stringify(raw.phases?.map(p => p.name)) === JSON.stringify(names), 'Missing/reordered startup phases');
  let end = 0;
  for (const p of raw.phases) {
    check(finite(p.startMs) && finite(p.endMs) && finite(p.durationMs) && p.startMs === end && p.endMs >= p.startMs && Math.abs(p.durationMs - (p.endMs - p.startMs)) < 1e-6, 'Gapped/overlapping/invalid startup phase');
    end = p.endMs;
  }
  const at = name => raw.phases.find(p => p.name === name);
  check(Math.abs(at('module').endMs - raw.samples.moduleMs) < 1, 'Module phase disagrees with navigation metric');
  for (const [phase, sample] of [['editorReady','readyMs'],['firstFrame','firstFrameMs'],['editRelease','acceptedEditMs']]) {
    check(Math.abs(at(phase).endMs - raw.samples[sample]) < 1, 'Phase disagrees with preserved startup metric');
  }
  return raw.phases;
}
export function inspectLoading(profile, record, item, kind) {
  check(profile.version === 1 && profile.id === 'loading-v1' && profile.samplePairs === 12 && profile.minimumTailSamples === 100, 'Unreviewed loading policy');
  check(profile.legacyColdLimitMs === 300 && profile.warmLimitsMs.Task === 50 && profile.warmLimitsMs.Long === 200, 'Changed preserved limits');
  check(profile.phaseAttribution === 'navigation-phases-v1', 'Unreviewed phase attribution');
  check(record.qualification === 'unqualified', 'Diagnostics cannot qualify runtime');
  check(profile.requiredObservations.includes(kind), 'Unknown loading observation');
  check(profile.fixtures.includes(item.fixture) && profile.presets.includes(item.preset), 'Unknown fixture/preset');
  check(item.errors?.length === 0 && item.pairs?.length === profile.samplePairs, 'Missing/failed loading replays');
  check(JSON.stringify(item.features) === JSON.stringify(presets[item.preset].featureSet) && item.textBytes === fixture(item.fixture).textBytes, 'Feature set or text allocation changed');
  check(JSON.stringify(profile.fixtures) === '["Task","Long"]' && JSON.stringify(profile.presets) === '["baseline","task"]' && JSON.stringify(profile.requiredObservations) === '["packed-baseline","packed-presets","cold","warm","disabled-imports","gzip-caps"]', 'Reduced loading matrix');
  const allowed = new Set(['/fixture/assets/wasm/editac_wasm_bg.wasm','/fixture/assets/task.js', '/fixture/assets/wasm/editac_wasm.js', '/fixture/harness/loading-client.mjs', '/fixture/harness/fixtures.mjs']);
  for (const [index, pair] of item.pairs.entries()) {
    check(pair.index === index && pair.databaseDeleted, 'Missing/reordered replay or leaked database');
    for (const mode of ['cold','warm']) {
      const raw = pair[mode];
      check(raw?.sourcePreserved && raw.persisted && raw.initialHash === raw.finalHash && /^[0-9a-f]{64}$/.test(raw.initialHash), 'Lost source or acknowledgment');
      check(pair.cold.initialHash === pair.warm.initialHash, 'Warm persisted source differs');
      if (kind === mode) {
        const s = raw.samples;
        check(['moduleMs','initMs','restoreMs','readyMs','firstFrameMs','acceptedEditMs','commandRestoreMs'].every(k => finite(s?.[k])), 'Missing startup samples');
        check(s.moduleMs <= s.readyMs && s.readyMs <= s.firstFrameMs && s.firstFrameMs <= s.acceptedEditMs, 'Impossible startup attribution');
        inspectStartupPhases(raw, mode);
        check(mode === 'cold' ? finite(s.documentTransferMs) : !Object.hasOwn(s, 'documentTransferMs'), 'Incorrect cold/warm transfer scope');
        check(raw.resourceTimings?.some(r => r.name === '/fixture/assets/wasm/editac_wasm_bg.wasm' && r.decodedBodySize > 0), 'Missing WASM transfer/cache trace');
        check(raw.resourceTimings.some(r => r.name === '/fixture/assets/task.js' && r.decodedBodySize > 0), 'Missing packed module trace');
        if (mode === 'cold') check(raw.resourceTimings.some(r => r.name === '/fixture/assets/task.js' && r.transferSize > 0), 'Cold module was cached');
        if (mode === 'warm') check(raw.resourceTimings.some(r => r.name === '/fixture/assets/task.js' && r.transferSize === 0), 'Warm module cache was not observed');
      }
      if (kind === 'disabled-imports') {
        check(raw.scripts?.some(s => s.url === '/fixture/assets/task.js') && raw.scripts.every(s => allowed.has(s.url) && s.hash), 'Unexpected/missing evaluated scripts');
        check(raw.coverage?.some(s => s.url === '/fixture/assets/task.js' && s.functions.some(f => f.ranges.some(r => r.count > 0))), 'Missing actual packed evaluation coverage');
        check(raw.coverage.every(s => allowed.has(s.url)), 'Uninventoried evaluated script');
        check(raw.requests?.every(r => r.url === '/' || allowed.has(r.url) || ['/fixture/assets/task.css','/fixture/assets/wasm/editac_wasm_bg.wasm',`/fixture/corpus/${item.fixture}.checkpoint.json`].includes(r.url)), 'Unexpected optional resource');
      }
    }
  }
  if (['packed-baseline','packed-presets','gzip-caps'].includes(kind)) {
    check(record.consumer?.profile === 'default-task' && record.consumer.packs?.length === 2, 'Missing clean packed consumer');
    const result = evaluateBudget(record.consumer.assets, record.consumer.assets.map(a => ({ name: a.name, kind: a.kind })));
    assertBudget(result); check(JSON.stringify(result) === JSON.stringify(record.consumer.result), 'Changed gzip accounting');
  }
  return { fixture: item.fixture, preset: item.preset, kind, status: 'observed' };
}
export function inspectLoadings(profile, record) {
  check(record.metadata && ['cpu','cores','memoryBytes','hostOS','provenance','node','browser','replay','cacheScope','timingScope','coverageMethod','warmupPolicy','sampleOrder','phaseAttribution','phaseScope'].every(k => record.metadata[k]), 'Missing runtime/hardware/sampling identities');
  check(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt), 'Post-hoc profile');
  check(record.metadata.phaseAttribution === profile.phaseAttribution && record.metadata.phaseScope === profile.phaseScope, 'Incomparable phase attribution');
  check(record.metadata.replay === profile.replay && record.metadata.cacheScope === profile.cacheScope && record.metadata.timingScope === profile.timingScope && record.metadata.coverageMethod === profile.coverageMethod && record.metadata.warmupPolicy === profile.warmupPolicy && record.metadata.sampleOrder === profile.sampleOrder, 'Incomparable sampling identity');
  check(record.counts?.executed === 24 && record.counts.passed === 24 && record.counts.failed === 0 && record.counts.skipped === 0 && record.errors?.length === 0, 'Incomplete loading counts');
  check(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked owning processes');
  check(record.cases?.length === 4 && new Set(record.cases.map(i => `${i.fixture}/${i.preset}`)).size === 4, 'Missing/duplicate loading matrix');
  return record.cases.flatMap(i => profile.requiredObservations.map(k => inspectLoading(profile, record, i, k)));
}

export function summarizeLoading(profile, record) {
  const stats = values => {
    const sorted = [...values].sort((a,b) => a-b);
    if (!sorted.length || !sorted.every(finite)) return { count: sorted.length, status: 'inconclusive' };
    const at = p => sorted[Math.ceil(p * sorted.length) - 1];
    return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1), tailStatus: sorted.length < profile.minimumTailSamples ? 'inconclusive: fewer than 100 samples' : 'descriptive; correlated same-process pairs do not qualify release tails' };
  };
  return { qualification: 'unqualified', features: Object.fromEntries(Object.entries(presets).map(([k,v]) => [k,v.featureSet])),
    budget: record.consumer?.result, cases: record.cases.map(item => ({ fixture: item.fixture, preset: item.preset,
      modes: Object.fromEntries(['cold','warm'].map(mode => {
        const rows = item.pairs.map(p => p[mode]).filter(Boolean), limit = mode === 'cold' ? profile.legacyColdLimitMs : profile.warmLimitsMs[item.fixture];
        const ready = stats(rows.map(r => r.samples.readyMs)), accepted = stats(rows.map(r => r.samples.acceptedEditMs));
        const phases = Object.fromEntries((rows[0]?.phases ?? []).map(p => [p.name, stats(rows.map(r => r.phases.find(v => v.name === p.name)?.durationMs))]));
        return [mode, { readyMs: ready, firstFrameMs: stats(rows.map(r => r.samples.firstFrameMs)), acceptedEditMs: accepted, preservedTargetMs: limit,
          phaseAttribution: profile.phaseAttribution, phases,
          oracleBeforeAcceptedMs: stats(rows.map(r => r.phases?.filter(p => oracleBeforeEdit.includes(p.name)).reduce((total, p) => total + p.durationMs, 0))),
          publicEditMs: stats(rows.map(r => r.phases?.filter(p => ['editAnchors','editCommand','editRelease'].includes(p.name)).reduce((total, p) => total + p.durationMs, 0))),
          attributionScope: 'Contiguous navigation clock including oracle and harness work; no subtraction from preserved targets. editorReady combines recovery/surface binding; firstFrame is a double RAF, not compositor proof. WASM init combines fetch/compile/instantiate.',
          targetStatus: accepted.count !== profile.samplePairs ? 'inconclusive' : accepted.p95 > limit ? 'missed' : 'observed-within-target; unqualified' }];
      })) })) };
}
