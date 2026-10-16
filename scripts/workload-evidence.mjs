import { workload, expectedWorkload, canonicalWorkload } from '../benchmarks/workloads.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { digest, validateBaselinePolicy } from './architecture-budgets.mjs';
import { inspectTableAccessibility, tableInputScope } from './table-workload-accessibility.mjs';
export function validateWorkloadPolicy(profile, record) {
  validateBaselinePolicy(profile, {
    metadata: { ...record.metadata, timestamp: record.metadata?.startedAt },
    artifactInputs: record.artifacts,
  });
}

const require = (value, message) => { if (!value) throw Error(message); };
const finite = n => Number.isFinite(n) && n >= 0;
const pin = value => /^[a-f0-9]{64}$/.test(value ?? '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function inspectWorkloadProfile(profile) {
  require(profile?.version === 1 && profile.id === 'workloads-v1' && profile.parent === 'FIT-1.8-I1-B' && profile.case === 'PRF-04' && profile.performanceLimits === null, 'Unknown/unreviewed workload profile');
  require(same(profile.scales, ['Task', 'Long']) && same(profile.presets, ['baseline', 'task']) && same(profile.workloads, ['long-line', 'bidi', 'table-selection', 'images']) && profile.samples === 12, 'Workload matrix/sample drift');
  require(same(profile.limits, { textBytes: { Task: 10240, Long: 1048576 }, bidiBlocks: 8, tableRows: { Task: 16, Long: 128 }, tableColumns: 8, cellUnits: 64, images: { Task: 4, Long: 32 }, imageWidth: 1024, imageHeight: 1024 }), 'Workload size policy drift');
  require(profile.memoryScope === 'CDP Runtime.getHeapUsage without forced GC at explicit replay boundaries; observed JS/backing-storage maxima, not native decoder/process peaks' && profile.inputScope === 'Public atomic commands and programmatic native DOM/control selections; no trusted input/compositor/OS accessibility claim', 'Unsupported measurement scope');
  require(Number.isFinite(Date.parse(profile.reviewedAt)), 'Missing preregistered policy');
  require(profile.tableInputScope === undefined || profile.tableInputScope === tableInputScope, 'Missing preregistered table input scope');
}
export function inspectWorkload(profile, item) {
  inspectWorkloadProfile(profile);
  require(profile.scales.includes(item?.scale) && profile.workloads.includes(item.kind) && profile.presets.includes(item.preset), 'Unknown workload case');
  const document = workload(profile, item.scale, item.kind), expectedHash = digest(canonicalWorkload(expectedWorkload(document)));
  require(pin(item.checkpointHash) && item.fixtureHash === digest(JSON.stringify(document)) && item.expectedSemanticHash === expectedHash && item.semanticHash === expectedHash && item.finalSemanticHash === expectedHash && item.correctness === 'observed' && !item.failure, 'Missing or mutated full workload');
  require(same(item.dimensions, document.dimensions), 'Silent workload truncation');
  require(same(item.features, [...presets[item.preset].featureSet, ...(item.kind === 'images' || item.kind === 'table-selection' ? ['content-modules'] : [])]), 'Feature attribution drift');
  require(item.errors?.length === 0 && item.requests?.length > 0 && item.requests.every(r => r.sameOrigin === true), 'Runtime failure or external asset request');
  require(item.memoryScope === profile.memoryScope && item.inputScope === profile.inputScope, 'Invented memory/input qualification');
  require(finite(item.mountMs) && item.mountMs > 0 && item.samples?.length === profile.samples, 'Missing workload timings');
  require(item.longTasks?.every(e => finite(e.startTime) && finite(e.duration) && e.duration >= 50), 'Missing/invalid separate long tasks');
  require(item.memory?.length === profile.samples + 3 && item.memory[0].phase === 'before-mount' && item.memory[1].phase === 'mounted' && item.memory.at(-1).phase === 'disposed', 'Missing memory boundaries');
  for (const [i, m] of item.memory.entries()) {
    require(finite(m.at) && finite(m.usedSize) && finite(m.totalSize) && m.usedSize > 0 && m.totalSize >= m.usedSize && finite(m.embedderHeapUsedSize) && finite(m.backingStorageSize), 'Invalid CDP heap observation');
    if (i >= 2 && i < item.memory.length - 1) require(m.phase === `sample-${i - 2}`, 'Missing raw replay memory');
    if (i > 0) require(m.at > item.memory[i - 1].at, 'Nonmonotonic memory sample');
  }
  require(item.cleanup?.unsaved === false && item.cleanup.editorReady === false && item.cleanup.activeViews === 0 && item.cleanup.activeImageSources === 0 && item.cleanup.databaseDeleted === true, 'Leaked workload resources');
  const d = document.dimensions;
  require(item.dom?.blocks === expectedWorkload(document).length && item.dom.views === (item.kind === 'images' ? d.images : item.kind === 'table-selection' ? 1 : 0), 'Missing production renderer/module views');
  require(item.dom.controls === (item.kind === 'table-selection' ? d.cells : item.kind === 'images' ? d.images : 0), 'Missing whole table controls');
  require(item.dom.images?.length === (item.kind === 'images' ? d.images : 0) && item.dom.imagePolicyCalls === (item.kind === 'images' ? d.images : 0), 'Missing host image admission');
  if (item.kind === 'images') require(item.dom.sourceControls?.length === d.images && item.dom.sourceControls.every((c, i) => c.readOnly && c.value === document.blocks[i].attributes.tuple[2].source), 'Image source control loss');
  if (item.kind === 'images') require(item.dom.images.every(i => i.complete && i.width === d.width && i.height === d.height), 'Incomplete decoded image workload');
  if (profile.tableInputScope && item.kind === 'table-selection') inspectTableAccessibility(profile, item, document.blocks[0].attributes.tuple[2].rows);
  for (const [index, sample] of item.samples.entries()) {
    require(sample.index === index && sample.semanticRestored === true && finite(sample.selectionLayoutMs) && finite(sample.replayMs) && sample.replayMs >= sample.selectionLayoutMs && sample.frames?.length === 2 && sample.frames.every(finite) && sample.frames[1] >= sample.frames[0], 'Missing/incomparable replay samples');
    require(finite(sample.startTime) && finite(sample.endTime) && sample.endTime >= sample.startTime && Math.abs(sample.endTime - sample.startTime - sample.replayMs) < 0.01, 'Missing raw replay attribution');
    const selection = sample.selection;
    if (item.kind === 'long-line' || item.kind === 'bidi') require(selection?.units === d.textUnits && selection.anchorNode === true && selection.anchorOffset === 0 && selection.focusNode === true && Number.isSafeInteger(selection.focusOffset) && selection.focusOffset > 0 && finite(selection.displayUnits), 'Native full-text range incomplete');
    else if (item.kind === 'table-selection') {
      const rows = document.blocks[0].attributes.tuple[2].rows;
      require(selection?.units === d.textUnits && selection.cells === d.cells && selection.start === 0 && selection.end === d.cellUnits && selection.valueUnits === d.cellUnits && selection.firstValue === rows[0][0][0][0] && selection.lastValue === rows.at(-1).at(-1)[0][0], 'Native full-table/control selection incomplete');
    } else require(selection?.image === index % d.images && selection.width > 0 && selection.height > 0 && selection.naturalWidth === d.width && selection.naturalHeight === d.height && sample.commandRestoreMs === undefined, 'Missing image layout observations');
    if (item.kind !== 'images') require(finite(sample.commandRestoreMs) && sample.commandRestoreMs > 0 && sample.replayMs >= sample.commandRestoreMs, 'Missing real writer replay');
  }
  const sorted = item.samples.map(s => s.replayMs).sort((a, b) => a - b);
  return { scale: item.scale, kind: item.kind, preset: item.preset, status: 'diagnostic', samples: sorted.length,
    orderStatisticsMs: { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], p99: sorted[Math.ceil(sorted.length * .99) - 1] }, tailStatus: 'inconclusive: twelve deterministic replay samples, no reviewed limits',
    observedHeapMaxBytes: Math.max(...item.memory.map(m => m.usedSize)), observedBackingMaxBytes: Math.max(...item.memory.map(m => m.backingStorageSize)), peakStatus: 'observed boundaries only; harness allocations included; native decoder/process peak unobserved' };
}
export function inspectWorkloads(profile, record) {
  inspectWorkloadProfile(profile);
  require(record?.version === 1 && record.qualification === 'unqualified', 'Unsupported workload qualification');
  require(record.metadata?.cpu && record.metadata.memoryBytes > 0 && record.metadata.browser && record.metadata.hostOS && record.metadata.provenance === 'headless-browser-on-host', 'Missing runtime/hardware provenance');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt), 'Policy not fixed before measurement');
  require(record.counts?.executed === 16 && record.counts.passed === 16 && record.counts.failed === 0 && record.counts.skipped === 0 && record.cases?.length === 16, 'Incomplete workload matrix');
  require(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked workload runtime');
  const keys = new Set(), pairs = new Map(), summaries = [];
  for (const item of record.cases) {
    const key = `${item.scale}/${item.kind}/${item.preset}`; require(!keys.has(key), 'Duplicate workload'); keys.add(key);
    const pairKey = `${item.scale}/${item.kind}`;
    if (pairs.has(pairKey)) require(item.checkpointHash === pairs.get(pairKey), 'Incomparable preset checkpoint'); else pairs.set(pairKey, item.checkpointHash);
    summaries.push(inspectWorkload(profile, item));
  }
  return { status: 'diagnostic', qualification: 'unqualified', summaries, gaps: ['Unreviewed workload tail/memory release thresholds', 'Programmatic native selection/public-command replay excludes trusted input and compositor attribution', 'Observed heap boundaries include harness allocations; native decoder/process peaks remain unobserved', 'Remaining PRF/accessibility/target-platform criteria remain required'] };
}
