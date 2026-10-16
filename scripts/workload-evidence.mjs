import { spawnSync } from 'node:child_process';
import { workload, expectedWorkload, canonicalWorkload } from '../benchmarks/workloads.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { digest, validateBaselinePolicy } from './architecture-budgets.mjs';
import { inspectTableAccessibility, tableInputScope } from './table-workload-accessibility.mjs';
export function workloadInputs(root, profilePath) {
  const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'fixtures/schema-v5', 'Cargo.lock', 'Cargo.toml', 'package-lock.json', 'package.json', 'scripts/build-wasm.mjs'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0) throw Error('Cannot pin workload source closure');
  return [...new Set([...tracked.stdout.trim().split('\n'), profilePath, 'benchmarks/profiles/fitness-v1.json', 'benchmarks/config.json', 'scripts/architecture-budgets.mjs', 'benchmarks/workload-client.mjs', 'benchmarks/workloads.mjs', 'benchmarks/workload-image.png',
  'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'scripts/workload-evidence.mjs', 'scripts/table-workload-accessibility.mjs', 'scripts/bench-workloads.mjs', 'scripts/optional-loading-evidence.mjs', 'scripts/build-wasm-notices.mjs', 'scripts/share-wasm-glue.mjs', 'scripts/test-toolchain.mjs', 'rust-toolchain.toml', '.node-version', 'tsconfig.base.json'])].sort();
}
export function workloadBuildProof(optional, receiptHash) {
  return { version: 1, source: 'optional-loading-v3', receiptHash, startedAt: optional.startedAt,
    outputs: optional.buildOutputs,
    commands: optional.commands.slice(0, 3).map(c => ({ label: c.label, command: c.command, exit: c.exit, log: c.log, sha256: c.sha256 })) };
}
export function inspectWorkloadBuild(record, optional) {
  const proof = record.buildProvenance;
  require(proof?.version === 1 && proof.source === 'optional-loading-v3' && pin(proof.receiptHash), 'Missing workload source build');
  require(proof.receiptHash === record.metadata?.optionalLoading?.receiptHash && record.artifacts?.['inputs/optional-loading.json'] === proof.receiptHash, 'Workload build receipt mismatch');
  require(Number.isFinite(Date.parse(proof.startedAt)) && Date.parse(proof.startedAt) < Date.parse(record.metadata.startedAt), 'Workload source build must precede execution');
  const files = ['packages/core/dist/wasm/editac_wasm_bg.wasm', 'packages/core/dist/wasm/editac_wasm.js', 'packages/core/dist/wasm/editac_runtime.js',
    'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm', 'packages/markdown/dist/wasm/editac_markdown_wasm.js'];
  require(JSON.stringify(Object.keys(proof.outputs ?? {}).sort()) === JSON.stringify(files.sort()) && files.every(f => pin(proof.outputs[f])), 'Incomplete workload source build outputs');
  require(proof.commands?.length === 3, 'Missing workload source build commands');
  for (const [i, label, args] of [[0, 'build-engine-wasm', ['scripts/build-wasm.mjs']], [1, 'build-markdown-wasm', ['scripts/build-wasm.mjs', '--markdown']], [2, 'build-packages', ['run', 'build']]]) {
    const c = proof.commands[i];
    require(c.label === label && c.exit === 0 && c.command?.length === args.length + 1 && JSON.stringify(c.command.slice(1)) === JSON.stringify(args) && (i === 2 ? c.command[0] === 'npm' : c.command[0] === record.metadata.command[0]) && pin(c.sha256) && typeof c.log === 'string' && record.artifacts[`source-build/${c.log}`] === c.sha256, 'Failed/wrong workload source build');
  }
  for (const file of files) require(record.artifacts[`source-build/${file}`] === proof.outputs[file], 'Retained workload build output mismatch');
  for (const file of files.filter(f => f.startsWith('packages/core/'))) {
    const asset = file.split('/wasm/')[1];
    require(record.artifacts[`harness/wasm/${asset}`] === proof.outputs[file], 'Executed workload WASM/glue differs from source build');
  }
  if (optional) {
    require(JSON.stringify(proof) === JSON.stringify(workloadBuildProof(optional, proof.receiptHash)), 'Retained workload source build mismatch');
    for (const [file, hash] of Object.entries(optional.sourceInputs)) if (Object.hasOwn(record.sourceInputs, file)) require(hash === record.sourceInputs[file], `Workload build source mismatch: ${file}`);
  }
}
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
