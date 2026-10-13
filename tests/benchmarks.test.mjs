import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, fixtureText, fixtureSizes } from '../benchmarks/fixtures.mjs';
import { summarize, percentile } from '../benchmarks/statistics.mjs';
import { aggregate, compatible } from '../benchmarks/report.mjs';
import { options } from '../benchmarks/options.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopOwnedProcess } from '../scripts/owned-processes.mjs';

const config = JSON.parse(await readFile(new URL('../benchmarks/config.json', import.meta.url), 'utf8'));
function observation(samples = [1, 2, 3]) {
  return { version: 1, bundleVersion: 1, errors: [], signature: { platform: 'fixture' },
    plan: { runs: 1, metrics: ['typing.large.start'], sampleCounts: { 'typing.large.start': 3 } },
    cases: [{ measured: false, metrics: { 'typing.large.start': [999] } }, { measured: true, metrics: { 'typing.large.start': samples } }],
    bundles: { full: { brotliBytes: 40000 }, minimal: { brotliBytes: 20000 } } };
}
for (const [name, size] of Object.entries(fixtureSizes)) {
  test(`versioned ${name} fixture is deterministic, exact UTF-16 size and mixed structure`, () => {
    const document = fixture(name);
    assert.equal(fixtureText(document).length, size);
    assert.deepEqual(document, fixture(name));
    assert.ok(document.blocks.some(block => block.attributes.type === 'heading'));
    assert.ok(document.blocks.some(block => block.attributes.type === 'code'));
    assert.ok(document.blocks.some(block => block.containers?.length));
    assert.ok(document.blocks.every(block => block.runs.every(run => run.text.isWellFormed())));
  });
}
test('unknown fixtures and misspelled flags fail instead of running zero scenarios', () => {
  assert.throws(() => fixture('missing'));
  for (const args of [['--quik'], ['--fixtures', 'missing'], ['--fixtures', 'small,small'], ['--baseline'], ['--output', '--quick']]) assert.throws(() => options(args));
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
