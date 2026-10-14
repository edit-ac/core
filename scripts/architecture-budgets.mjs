import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { percentile } from '../benchmarks/statistics.mjs';
import { budgets } from './browser-size-contract.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const require = (condition, message) => { if (!condition) throw Error(message); };
export const requiredCases = Object.freeze(['PRF-01', 'PRF-02', 'PRF-03', 'PRF-04', 'PRF-05', 'PRF-06', 'PRF-07']);

export function validateFitnessProfile(profile, configBytes, specBytes) {
  require(profile?.version === 1 && profile.id === 'fitness-v1', 'Unknown fitness profile version');
  require(Number.isFinite(Date.parse(profile.reviewedAt)), 'Missing preregistration timestamp');
  require(profile.preserveBenchmarkConfig === true && digest(configBytes) === profile.benchmarkConfigHash, 'Benchmark budget/config drift');
  require(digest(specBytes) === profile.verificationSpecHash, 'Verification policy drift');
  require(profile.minimumTailSamples >= 100 && positiveInt(profile.minimumTailSamples), 'Unrepresentative tail policy');
  require(JSON.stringify(profile.requiredSizes) === JSON.stringify(['Task', 'Long']), 'Required size scope drift');
  require(JSON.stringify(Object.keys(profile.requiredCases)) === JSON.stringify(requiredCases), 'Missing/unknown PRF case');
  for (const [id, components] of Object.entries(profile.requiredCases)) require(Array.isArray(components) && components.length && new Set(components).size === components.length && components.every(present), `Invalid ${id} components`);
  require(JSON.stringify(profile.requiredAccessibility) === JSON.stringify(['keyboard', 'touch', 'screen-reader', 'non-drag-pointer']), 'Accessibility scope drift');
  const metricRows = { 'core-edit': 'Core ordinary edit', 'input-visible': 'Input to visible update, controlled 60 Hz',
    'Task-warm': 'Warm task activation', 'Long-warm': 'Warm long actual editability', 'Large-warm': 'Warm large actual editability',
    preview: 'Matching preview first viewport', 'paste-10KiB': '10 KiB Markdown paste to formatted frame', 'paste-100KiB': '100 KiB Markdown paste to formatted frame' };
  const rows = specBytes.toString().split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').map(cell => cell.trim()));
  for (const [metric, label] of Object.entries(metricRows)) {
    const row = rows.find(cells => cells[1] === label);
    require(row && profile.limits.desktop[metric] === Number(row[2].replaceAll(',', '').match(/^[\d.]+/)?.[0])
      && profile.limits.phone[metric] === Number(row[3].replaceAll(',', '').match(/^[\d.]+/)?.[0]), `Existing latency limits changed: ${metric}`);
  }
  require(profile.unreviewedLimits.length > 0, 'Missing explicit resource/frame review gaps');
  return { profileHash: digest(JSON.stringify(profile)), hardGzipCaps: budgets, scope: 'Admission contract only; no support claim' };
}

export function rawSummary(samples, minimumTailSamples = 100) {
  require(positiveInt(minimumTailSamples) && minimumTailSamples >= 100, 'Invalid tail sampling policy');
  require(Array.isArray(samples) && samples.length && samples.every(nonnegative), 'Missing/invalid raw samples');
  const tail = samples.length >= minimumTailSamples;
  return { count: samples.length, p50: percentile(samples, 0.5), p95: tail ? percentile(samples, 0.95) : null,
    p99: tail ? percentile(samples, 0.99) : null, max: Math.max(...samples), status: tail ? 'measured' : 'inconclusive' };
}

export function comparable(a, b) {
  const keys = ['hardware', 'runtime', 'fixtureHash', 'featureSet', 'size', 'toolchain', 'warmups', 'sampleMethod'];
  require(pin(a.implementationHash) && pin(b.implementationHash), 'Missing distinct implementation identities');
  return keys.every(key => a[key] !== undefined && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

// An observation's green status cannot manufacture missing raw samples, artifacts,
// actual target-runtime execution or reviewed feature-specific thresholds.
export function evaluateFitnessEvidence(profile, record, artifacts = {}) {
  const gaps = [], summaries = {};
  const missing = (condition, message) => { if (!condition) gaps.push(message); };
  missing(record?.version === 1, 'Unknown evidence version');
  missing(record?.profileHash === digest(JSON.stringify(profile)), 'Profile identity mismatch');
  missing(pin(record?.implementationHash), 'Implementation identity missing');
  missing(record?.kind === 'target-runtime', 'Prepared/diagnostic evidence cannot qualify a runtime');
  missing(record?.hardware && ['cpu', 'memoryBytes', 'hostOS', 'provenance'].every(key => record.hardware[key]), 'Hardware/provenance missing');
  missing(record?.runtime && ['platform', 'version', 'input', 'accessibility', 'thermal'].every(key => present(record.runtime[key])), 'Runtime/input/accessibility/thermal missing');
  missing(Date.parse(record?.startedAt) > Date.parse(profile.reviewedAt), 'Limits not fixed before measurement');
  missing(Array.isArray(record?.featureSet) && record.featureSet.length && record.featureSet.every(present), 'Feature set missing');
  missing(profile.requiredSizes.every(size => record?.sizes?.includes(size)), 'Task/Long required size evidence missing');
  for (const id of requiredCases) {
    const item = record?.cases?.[id];
    if (!item) { gaps.push(`${id}: missing`); continue; }
    missing(item.status === 'passed' && positiveInt(item.executed) && item.passed === item.executed && ['failed', 'skipped', 'cancelled'].every(key => item[key] === 0), `${id}: incomplete/failed/skipped counts`);
    missing(item.provenance === 'target-runtime' && present(item.runtime) && pin(item.artifactHash) && artifacts[item.artifact] === item.artifactHash, `${id}: runtime/artifact proof missing`);
    for (const component of profile.requiredCases[id]) {
      const observation = item.observations?.[component];
      if (!observation) { gaps.push(`${id}/${component}: missing`); continue; }
      missing(observation.status === 'passed' && observation.scope === 'target-runtime' && pin(observation.fixtureHash) && record.sizes?.includes(observation.size), `${id}/${component}: missing current fixture/runtime/size`);
      try {
        const summary = rawSummary(observation.samples, profile.minimumTailSamples);
        summaries[`${id}/${component}`] = summary;
        const limit = profile.limits[record.runtime?.class]?.[component] ?? profile.reviewedMetricLimits?.[component];
        missing(summary.status === 'measured', `${id}/${component}: insufficient tail samples`);
        missing(nonnegative(limit) && Date.parse(profile.reviewedAt) < Date.parse(record.startedAt), `${id}/${component}: no prereviewed limit`);
        missing(summary.p95 !== null && summary.p95 <= limit, `${id}/${component}: limit exceeded or inconclusive`);
      } catch (error) { gaps.push(`${id}/${component}: ${error.message}`); }
    }
  }
  for (const mode of profile.requiredAccessibility) {
    const item = record?.accessibility?.[mode];
    missing(item?.status === 'passed' && item.scope === 'target-runtime' && positiveInt(item.executed) && item.passed === item.executed && item.failed === 0 && item.skipped === 0 && pin(item.artifactHash) && artifacts[item.artifact] === item.artifactHash, `accessibility/${mode}: missing executed proof`);
  }
  // Limits must themselves be part of the pinned observation record; callers pin
  // the entire record through their reviewed channel. No change raises a limit.
  return { status: gaps.length ? 'unqualified' : 'qualified', gaps, summaries };
}

export async function verifyPins(root, pins) {
  require(pins && Object.keys(pins).length, 'Missing artifact/source pins');
  const base = await realpath(root);
  for (const [file, expected] of Object.entries(pins)) {
    require(!isAbsolute(file) && !file.split('/').includes('..') && pin(expected), `Invalid pin ${file}`);
    const path = await realpath(resolve(base, file));
    require(!relative(base, path).startsWith('..') && !isAbsolute(relative(base, path)), `Escaping pin ${file}`);
    require(digest(await readFile(path)) === expected, `Changed pinned file ${file}`);
  }
  return Object.keys(pins).length;
}

export function inspectBaseline(profile, result) {
  require(result?.version === 1 && result.signature?.fitness === true, 'Missing fitness-mode observation');
  require(result.errors?.length === 0 && result.counts?.failed === 0 && result.counts.skipped === 0 && result.counts.executed > 0 && result.counts.passed === result.counts.executed, 'Incomplete owning benchmark');
  require(result.cleanup?.browserExited && result.cleanup.serverClosed && result.cleanup.temporaryRemoved, 'Runtime cleanup incomplete');
  require(result.metadata?.cpu && result.metadata.browser && result.metadata.osRelease && result.metadata.totalMemoryBytes > 0, 'Hardware/runtime missing');
  require(Date.parse(result.metadata.timestamp) > Date.parse(profile.reviewedAt), 'Measurement precedes fixed limits');
  require(result.profileInputs?.['benchmarks/profiles/fitness-v1.json'] && result.profileInputs['benchmarks/config.json'] === profile.benchmarkConfigHash, 'Unpinned measurement limits');
  const measured = result.cases.filter(item => item.measured);
  require(measured.length === result.signature.fixtures.length * result.plan.runs, 'Missing measured fixture runs');
  require(result.counts.executed === result.cases.length && result.cases.every(item => item.correctness === 'passed' && item.errors?.length === 0), 'Forged scenario counts');
  for (const fixture of result.signature.fixtures) {
    const runs = measured.filter(item => item.fixture === fixture);
    require(runs.length === result.plan.runs && new Set(runs.map(item => item.iteration)).size === runs.length, 'Duplicate/missing measured fixture');
  }
  const observations = measured.map(item => {
    const trace = item.fitness;
    require(item.correctness === 'passed' && trace?.version === 1 && trace.provenance === 'browser-synthetic-input' && trace.endpoint === result.signature.endpoint && trace.preset === 'minimal', 'Wrong baseline trace provenance');
    require(item.chars === result.fixtures.find(f => f.name === item.fixture)?.chars, 'Size/fixture mismatch');
    require(trace.input.length === result.plan.samples * 3 && trace.changedRegion.length === trace.input.length, 'Missing input/changed-region samples');
    const sampleKeys = trace.input.map(sample => `${sample.position}/${sample.sample}`);
    require(new Set(sampleKeys).size === sampleKeys.length && trace.input.every(sample => ['start', 'middle', 'end'].includes(sample.position)
      && Number.isSafeInteger(sample.sample) && sample.sample >= 0 && sample.sample < result.plan.samples), 'Duplicate/invalid input sample');
    require(trace.changedRegion.every((region, index) => `${region.position}/${region.sample}` === sampleKeys[index]), 'Changed-region attribution mismatch');
    for (const sample of trace.input) require(['dispatchMs', 'layoutMs', 'firstFrameMs', 'secondFrameMs'].every(key => nonnegative(sample[key])) && sample.firstFrameMs >= sample.dispatchMs + sample.layoutMs - 0.01 && sample.secondFrameMs >= sample.firstFrameMs, 'Invalid attribution samples');
    for (const region of trace.changedRegion) require(positiveInt(region.documentBlocks) && positiveInt(region.mutationCount) && region.touched.includes(region.target) && new Set(region.touched).size === region.touched.length && region.touched.length <= region.documentBlocks, 'Invalid DOM changed-region sample');
    require(trace.disposal.length === result.signature.mountCycles + 1 && trace.disposal[0].phase === 'loaded', 'Missing repeated-disposal samples');
    for (const [index, sample] of trace.disposal.entries()) {
      require(sample.heap && nonnegative(sample.heap.usedSize) && nonnegative(sample.heap.backingStorageSize), 'Missing raw heap samples');
      if (index) require(sample.phase === 'disposed' && sample.cycle === index - 1 && sample.childNodes === 0 && sample.contentEditable === 'false', 'Disposed editor retained surface');
    }
    require(['observed', 'unavailable'].includes(trace.longTaskStatus) && trace.longTasks.every(sample => nonnegative(sample.startTime) && nonnegative(sample.duration)), 'Missing long-task trace status');
    return { fixture: item.fixture, chars: item.chars, input: rawSummary(trace.input.map(s => s.secondFrameMs), profile.minimumTailSamples),
      changedRegion: trace.changedRegion, disposal: trace.disposal, longTasks: trace.longTasks, longTaskStatus: trace.longTaskStatus };
  });
  return { status: 'diagnostic', observations, qualification: 'unqualified', gaps: ['Baseline synthetic DOM/animation-frame observations do not prove compositor paint or OS input',
    'Task/Long identity, official presets and comparable full tail sample sets required', 'PRF-02 continuous input, PRF-03 optional queues, PRF-04 rich workloads, PRF-05 full resource plateau, PRF-06 packed startup and PRF-07 target text-service/accessibility proofs remain required',
    'No reviewed absolute memory/frame budget; prepared or missing runtime evidence cannot qualify'] };
}
