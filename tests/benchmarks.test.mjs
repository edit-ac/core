import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, fixtureText, fixtureSizes, supportedFixtures, expectedSemantics, projectedSemantics } from '../benchmarks/fixtures.mjs';
import { summarize, percentile } from '../benchmarks/statistics.mjs';
import { aggregate, compatible, scenarioCounts } from '../benchmarks/report.mjs';
import { options } from '../benchmarks/options.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopOwnedProcess } from '../scripts/owned-processes.mjs';

const config = JSON.parse(await readFile(new URL('../benchmarks/config.json', import.meta.url), 'utf8'));
test('interrupted scenario evidence exposes unexecuted work and never passes partial output', () => {
  assert.deepEqual(scenarioCounts([
    { correctness: 'passed', errors: [] }, { correctness: 'passed', errors: ['page failed'] },
    { metrics: { typing: [1] }, errors: [] },
  ], 8), { executed: 3, passed: 1, failed: 2, skipped: 5 });
  assert.deepEqual(scenarioCounts([], 8), { executed: 0, passed: 0, failed: 0, skipped: 8 });
  assert.throws(() => scenarioCounts([], 0));
  assert.throws(() => scenarioCounts([{}], 0));
});
function observation(samples = [1, 2, 3]) {
  return { version: 1, bundleVersion: 1, errors: [], signature: { platform: 'fixture' },
    plan: { runs: 1, metrics: ['typing.large.start'], sampleCounts: { 'typing.large.start': 3 } },
    cases: [{ measured: false, metrics: { 'typing.large.start': [999] } }, { measured: true, metrics: { 'typing.large.start': samples } }],
    bundles: { full: { brotliBytes: 40000 }, minimal: { brotliBytes: 20000 } } };
}
for (const [name, size] of Object.entries(fixtureSizes)) {
  test(`versioned ${name} fixture is deterministic, exact UTF-16 size and mixed structure`, () => {
    const document = fixture(name);
    if (supportedFixtures[name]) {
      assert.equal(Buffer.byteLength(fixtureText(document)), size);
      assert.equal(document.blocks.length, supportedFixtures[name].blocks);
      assert.equal(document.seed, supportedFixtures[name].seed);
      assert.equal(fixtureText(document).length, document.chars);
    } else assert.equal(fixtureText(document).length, size);
    assert.deepEqual(document, fixture(name));
    assert.ok(document.blocks.some(block => block.attributes.type === 'heading'));
    assert.ok(document.blocks.some(block => block.attributes.type === 'code'));
    assert.ok(document.blocks.some(block => block.containers?.length));
    assert.ok(document.blocks.every(block => block.runs.every(run => run.text.isWellFormed())));
  });
}
test('unknown fixtures and misspelled flags fail instead of running zero scenarios', () => {
  assert.throws(() => fixture('missing'));
  for (const args of [['--quik'], ['--fixtures', 'missing'], ['--fixtures', 'small,small'], ['--presets', 'missing'], ['--presets', 'baseline,baseline'], ['--presets'], ['--baseline'], ['--output', '--quick']]) assert.throws(() => options(args));
  assert.throws(() => options(['--quick', '--save-baseline', '/tmp/baseline.json']));
  assert.throws(() => options(['--fixtures', 'small', '--save-baseline', '/tmp/baseline.json']));
});
test('p95 uses nearest rank and does not dilute spikes with averages', () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(samples, 0.95), 95); assert.equal(percentile(samples, 0.5), 50);
  assert.deepEqual(samples, Array.from({ length: 100 }, (_, index) => index + 1));
  const summary = summarize([[1, 2, 3], [10, 20, 30], [100, 200, 300]]);
  assert.equal(summary.p50, 20); assert.equal(summary.p95, 30); assert.equal(summary.max, 300);
});
test('missing, nonfinite, negative and incomplete measurements cannot pass', () => {
  for (const samples of [[], [1, NaN, 3], [1, Infinity, 3], [1, -1, 3], [1, 2]]) assert.throws(() => aggregate(observation(samples), config));
  const missing = observation(); missing.cases = missing.cases.slice(0, 1); assert.throws(() => aggregate(missing, config));
  const failed = observation(); failed.errors.push('lost edit'); assert.throws(() => aggregate(failed, config));
});
test('warmup spikes are discarded and typing positions inherit their fixture budget', () => {
  const report = aggregate(observation([8, 9, 20]), config);
  assert.equal(report.metrics['typing.large.start'].p95, 20);
  assert.equal(report.findings.length, 1); assert.equal(report.findings[0].limit, 16);
  const hard = aggregate(observation([20, 26, 30]), config);
  assert.ok(hard.findings.some(finding => finding.severity === 'hard' && finding.limit === 25));
});
test('incompatible timing baselines suppress deltas but comparable bundle growth is still visible', () => {
  const current = observation();
  const baseline = { version: 1, bundleVersion: 1, signature: { platform: 'different' },
    metrics: { 'typing.large.start': { p95: 1 } }, bundles: { full: { brotliBytes: 30000 }, minimal: { brotliBytes: 20000 } } };
  assert.equal(compatible(current, baseline), false);
  const report = aggregate(current, config, baseline);
  assert.equal(report.metrics['typing.large.start'].deltaPercent, null);
  assert.ok(report.findings.some(finding => finding.name === 'bundle.full' && finding.severity === 'regression'));
  baseline.signature = current.signature;
  const matching = aggregate(current, config, baseline);
  assert.equal(matching.metrics['typing.large.start'].deltaPercent, 200);
  assert.ok(matching.findings.some(finding => finding.name === 'typing.large.start' && finding.severity === 'regression'));
});
test('zero baselines never generate infinite or fabricated improvements', () => {
  const baseline = { ...observation(), metrics: { 'typing.large.start': { p95: 0 } } };
  assert.equal(aggregate(observation(), config, baseline).metrics['typing.large.start'].deltaPercent, null);
});
test('zero metric plans cannot claim a passing benchmark', () => {
  const empty = observation(); empty.plan.metrics = [];
  assert.throws(() => aggregate(empty, config));
});
test('interrupt cleanup stops only the verified launcher and its temporary server', async () => {
  const serverCode = 'const http=require("node:http");const server=http.createServer((q,r)=>r.end("fixture"));server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));';
  const launcherCode = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(serverCode)}],{stdio:["ignore","pipe","inherit"]});child.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const launcher = spawn(process.execPath, ['-e', launcherCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(launcher, 'exit');
  try {
    const [data] = await once(launcher.stdout, 'data');
    const server = JSON.parse(data.toString());
    assert.equal((await fetch(`http://127.0.0.1:${server.port}`)).status, 200);
    const owned = stopOwnedProcess(launcher);
    assert.ok(owned.some(item => item.pid === launcher.pid));
    assert.ok(owned.some(item => item.pid === server.pid));
    assert.ok(!owned.some(item => item.pid === process.pid));
    await exit;
    await new Promise(resolve => setTimeout(resolve, 1750));
    await assert.rejects(fetch(`http://127.0.0.1:${server.port}`));
    assert.throws(() => process.kill(server.pid, 0), { code: 'ESRCH' });
  } finally { if (launcher.exitCode === null && launcher.signalCode === null) stopOwnedProcess(launcher); }
});

for (const name of ['Task', 'Long']) test(`committed ${name} semantic oracle matches seed and detects input drift`, async () => {
  const expected = JSON.parse(await readFile(new URL(`../benchmarks/expected/${name}.json`, import.meta.url)));
  assert.deepEqual(expectedSemantics(fixture(name)), expected);
  const changed = fixture(name); changed.blocks[0].runs[0].text = 'lost text';
  assert.notDeepEqual(expectedSemantics(changed), expected);
  assert.deepEqual(options(['--fitness', '--fixtures', name, '--presets', 'baseline,task']).presets, ['baseline', 'task']);
});

test('semantic oracle reads list metadata from containers and preserves marks', () => {
  const block = { id: 'b', kind: 'block', parent: 'c', runs: [{ attributes: {}, text: 'text' }], blockAttributes: ['paragraph'], editor: { containerAttributes: null } };
  const container = { id: 'c', kind: 'container', editor: { containerAttributes: ['unordered'] } };
  assert.deepEqual(projectedSemantics({ visible: [container, block] }), [{ text: 'text', runs: block.runs, attributes: ['paragraph'], container: { group: 0, style: ['unordered'] } }]);
  assert.equal(JSON.stringify(projectedSemantics({ visible: [container, block] })[0].runs), JSON.stringify([{ text: 'text', attributes: {} }]));
  block.runs[0].attributes.bold = true;
  assert.equal(projectedSemantics({ visible: [container, block] })[0].runs[0].attributes.bold, true);
});

test('retained native seeds require exact producer inputs and independently checked semantics', async () => {
  const { admitSeed, seedHash } = await import('../benchmarks/seeds.mjs');
  const document = fixture('Task'), executable = Buffer.from('prepared-native-test-executable');
  const inputs = { 'crates/editac-ffi/examples/fitness-seed.rs': 'a'.repeat(64), 'Cargo.lock': 'b'.repeat(64) };
  const prior = { sourceInputs: inputs, metadata: { seedProducer: { sha256: seedHash(executable) } }, status: 'failed' };
  const visible = [], groups = new Map();
  for (const [index, block] of expectedSemantics(document).entries()) {
    let parent = null;
    if (block.container) {
      parent = `list-${block.container.group}`;
      if (!groups.has(parent)) { visible.push({ id: parent, kind: 'container', editor: { containerAttributes: block.container.style } }); groups.set(parent, true); }
    }
    visible.push({ id: `block-${index}`, kind: 'block', parent, runs: block.runs, blockAttributes: block.attributes });
  }
  const identity = { documentId: '00000000-0000-4000-8000-00005441534b', epoch: '00000000-0000-4000-9000-00005441534b' };
  const artifacts = { fixture: Buffer.from(JSON.stringify(document)), snapshot: Buffer.from(JSON.stringify({ visible })),
    checkpoint: Buffer.from(JSON.stringify({ identity, checkpoint: { identity, initialized: true, bytes: [1, 2, 3] } })),
    log: Buffer.from('seed: 1/1 fixture prepared; 0 failures/skips') };
  const admit = (a = artifacts, p = prior, i = inputs, e = executable) => admitSeed('Task', p, i, e, a);
  assert.equal(admit().frozen.checkpoint.bytes.length, 3);
  assert.throws(() => admit(artifacts, prior, { ...inputs, 'Cargo.lock': 'c'.repeat(64) }), /source identity/);
  assert.throws(() => admit(artifacts, prior, inputs, Buffer.from('other executable')), /executable identity/);
  assert.throws(() => admit({ ...artifacts, fixture: Buffer.from('{}') }), /fixture identity/);
  assert.throws(() => admit({ ...artifacts, log: Buffer.from('seed: started') }), /Incomplete/);
  const corrupt = structuredClone({ visible }); corrupt.visible[0].runs[0].text += 'drift';
  assert.throws(() => admit({ ...artifacts, snapshot: Buffer.from(JSON.stringify(corrupt)) }), /semantic oracle/);
  assert.throws(() => admit({ ...artifacts, checkpoint: Buffer.from(JSON.stringify({ identity, checkpoint: { identity, initialized: true, bytes: [256] } })) }), /envelope/);
  const other = { ...identity, epoch: 'other' };
  assert.throws(() => admit({ ...artifacts, checkpoint: Buffer.from(JSON.stringify({ identity: other, checkpoint: { identity: other, initialized: true, bytes: [1] } })) }), /identity drift/);
  assert.equal(options(['--seed-directory', 'prepared']).seedDirectory, 'prepared');
  assert.throws(() => options(['--seed-directory']), /Missing value/);
});

test('fixed-size overwrite replay selects ASCII without splitting Unicode and restores exact bytes', async () => {
  const { overwriteTarget } = await import('../benchmarks/fixtures.mjs');
  for (const name of ['Task', 'Long']) for (const position of ['start', 'middle', 'end']) {
    const document = fixture(name);
    for (const block of [document.blocks[0], document.blocks[Math.floor(document.blocks.length / 2)], document.blocks.at(-1)]) {
      const before = block.runs[0].text, { at, original } = overwriteTarget(before, position);
      assert.match(original, /^[A-Za-z]$/);
      const changed = before.slice(0, at) + 'x' + before.slice(at + 1);
      assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
      assert.equal(changed.slice(0, at) + original + changed.slice(at + 1), before);
    }
  }
  assert.throws(() => overwriteTarget('😀日本語', 'middle'), /ASCII/);
});
