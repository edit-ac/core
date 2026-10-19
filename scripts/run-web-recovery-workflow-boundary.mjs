import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadScenario } from '../tests/scenarios/run.mjs';
import { sha } from '../tests/scenarios/harness.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Bind original product permission/identity assertions. The shared installed
// site is setup, never proof; only authenticated original executed cases count.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_READONLY_OUTPUT, 'Name a new evidence directory');
assert.ok(process.env.EDITAC_PRODUCT_SITE_RECEIPT, 'Name the installed product site');
const output = resolve(process.env.EDITAC_WEB_READONLY_OUTPUT); await mkdir(output);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const pin = async path => ({ path: resolve(path), sha256: sha(await readFile(path)) });
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const countsOK = c => {
  assert.ok(c.executed > 0); assert.equal(c.executed, c.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(c[key] ?? 0, 0, key);
};
const execution = { task: 'WFE-3.1-C4o-1', features: ['WEB-ROUTES', 'WEB-READONLY', 'WEB-LOCAL'], originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [], receipts: [] };
try {
  const preparedPath = resolve(process.env.EDITAC_PRODUCT_SITE_RECEIPT), prepared = await json(preparedPath);
  assert.equal(prepared.prepared, true); assert.equal(prepared.toolchains.node, process.versions.node);
  const sources = Object.fromEntries(prepared.sources.map(p => [p.path, p.sha256]));
  const runtime = await json('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c2c-tables/runtime-source-pins.json');
  // The historical manifest defines runtime coverage, not current digests.
  // Hash current inputs before execution; never restamp historical receipts.
  for (const path of Object.keys(runtime)) {
    const digest = sha(await readFile(path));
    if (path in sources) assert.equal(sources[path], digest, 'Prepared/current input conflict: ' + path);
    sources[path] = digest;
  }
  sources['scripts/run-web-recovery-workflow-boundary.mjs'] = sha(await readFile('scripts/run-web-recovery-workflow-boundary.mjs'));
  const verifySources = async () => {
    for (const [path, digest] of Object.entries(sources)) assert.equal(sha(await readFile(path)), digest, 'Changed current source: ' + path);
  };
  await verifySources(); await save('source-pins.json', sources);
  for (const p of prepared.artifacts) assert.equal(sha(await readFile(join(prepared.output, p.path))), p.sha256, 'Changed installed artifact: ' + p.path);
  for (const p of prepared.packs) assert.equal(sha(await readFile(join(prepared.output, p.file))), p.sha256, 'Changed packed archive');
  execution.prepared = await pin(preparedPath);
  const ledger = await json('fixtures/product-scenarios/web/features.json');
  const original = ledger.proofs.find(p => p.id === 'pwe-1.5'); assert.ok(original);
  const qualified = new Map();
  // The integrated product added optional controls and stronger touch assertions
  // after the original recovery return. Authenticate those exact committed inputs;
  // still execute every original workflow case against the current SDK.
  const productRevision = '376408f3a7fa729ae447fee57e3c4c595fbd76ab';
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', productRevision, 'HEAD']).status, 0);
  const productInputs = new Set(['examples/task-editor/index.html', 'examples/task-editor/markdown.mjs',
    'examples/task-editor/workspace.mjs', 'tests/scenarios/workspace.mjs', 'fixtures/product-scenarios/web/manifest.json']);
  for (const path of productInputs) {
    const committed = spawnSync('git', ['show', productRevision + ':' + path]);
    assert.equal(committed.status, 0); assert.equal(sources[path], sha(committed.stdout), 'Changed integrated product input: ' + path);
    qualified.set(path, sources[path]);
  }
  execution.productInputAdmission = { revision: productRevision, sources: Object.fromEntries(qualified),
    scope: 'Integrated optional product controls and additional touch assertions; original case arrays and assertions retained' };
  if (process.env.EDITAC_WEB_RECOVERY_RETURN) {
    const request = await json(resolve(process.env.EDITAC_WEB_RECOVERY_RETURN));
    assert.equal(request.task, 'RPR-1.1');
    for (const evidence of Object.values(request.proof))
      assert.equal(sha(await readFile(evidence.path)), evidence.sha256, 'Changed owner proof');
    const applicability = await json(request.proof['applicability.json'].path);
    assert.deepEqual(request.sources, applicability.sources, 'Owner source pins differ from qualified proof');
    assert.equal(applicability.originalCaseIdsPreserved, 12);
    assert.equal(applicability.originalAssertionLinesPreserved, 45);
    countsOK(applicability.counts); assert.equal(applicability.counts.executed, 36);
    for (const source of request.sources) {
      if (source.path === 'tests/scenarios/harness.mjs') continue; // Setup is freshly authenticated above, never reused behavioral evidence.
      assert.equal(sources[source.path], qualified.get(source.path) ?? source.sha256, 'Qualified recovery input changed: ' + source.path);
    }
    // Only these two proof/transport inputs changed in the qualified return.
    // Every original case and all remaining assertions/fixtures still bind below.
    for (const path of ['tests/scenarios/local-recovery.mjs', 'tests/browser/fixture-server.mjs']) {
      const source = request.sources.find(p => p.path === path); assert.ok(source);
      qualified.set(path, source.sha256);
    }
    execution.qualifiedRecoveryReturn = await pin(resolve(process.env.EDITAC_WEB_RECOVERY_RETURN));
  }
  const suites = ['web-task-workspace', 'web-react-routes', 'web-local-recovery'];
  const originals = [];
  // Admission of every original case, fixture, source and package precedes any
  // feature execution. Retain old runtime pins without claiming applicability.
  for (const suite of suites) {
    const { scenario } = await loadScenario(suite);
    for (const engine of ['chromium', 'firefox', 'webkit']) {
      const oldPin = original.receipts.find(p => p.path.includes('/' + engine + '/' + suite + '/'));
      assert.ok(oldPin); assert.equal(sha(await readFile(oldPin.path)), oldPin.sha256);
      const old = await json(oldPin.path); countsOK(old.counts); assert.equal(old.exit, 0);
      assert.deepEqual(old.cases.map(c => c.id), scenario.cases); assert.ok(old.cases.every(c => c.status === 'passed'));
      for (const path of [...scenario.fixtures, ...(scenario.supportingSources ?? []), scenario.command[1]]) {
        assert.equal(sources[path], qualified.get(path) ?? old.sources.find(p => p.path === path)?.sha256, 'Original assertions/fixture changed: ' + path);
      }
      if (suite === 'web-task-workspace') {
        const old = spawnSync('git', ['show', 'e50c5344744757a9a562b3b57bb570e0d0ca8a26:tests/scenarios/workspace.mjs']);
        assert.equal(old.status, 0);
        const current = await readFile('tests/scenarios/workspace.mjs', 'utf8');
        for (const line of old.stdout.toString().split('\n').filter(line => /\bassert\./.test(line)))
          assert.ok(current.includes(line), 'Removed original workspace assertion: ' + line);
      }
      for (const p of old.packs) assert.equal(sha(await readFile(join(oldPin.packageDirectory, p.file))), p.sha256);
      originals.push({ suite, engine, original: oldPin, cases: old.cases });
    }
  }
  // Shared facade/runtime changed: execute all original suites against this site.
  await save('execution.json', execution);
  const priorOutput = process.env.EDITAC_WEB_READONLY_RESUME && resolve(process.env.EDITAC_WEB_READONLY_RESUME);
  const prior = priorOutput && await json(join(priorOutput, 'execution.json'));
  for (const cell of originals) {
    const { suite, engine } = cell;
    const accepted = prior?.receipts.find(r => r.suite === suite && r.engine === engine && r.counts.failed === 0);
    if (accepted) {
      const previousSources = await json(join(priorOutput, 'source-pins.json')); assert.deepEqual(previousSources, sources);
      assert.equal(sha(await readFile(accepted.path)), accepted.sha256);
      const receipt = await json(accepted.path); countsOK(receipt.counts); assert.deepEqual(receipt.cases, cell.cases);
      assert.deepEqual(receipt.artifacts, prepared.artifacts); assert.deepEqual(receipt.packs, prepared.packs);
      execution.receipts.push({ ...accepted, mode: 'exact-input-reuse' }); continue;
    }
    const child = join(output, suite + '-' + engine), log = suite + '-' + engine + '.log';
    const fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, ['tests/scenarios/run.mjs', suite], {
      stdio: ['ignore', fd, fd], timeout: 180000,
      env: { ...process.env, EDITAC_PRODUCT_BROWSER: engine, EDITAC_PRODUCT_CASE_OUTPUT: child },
    }); } finally { closeSync(fd); }
    execution.commands.push({ program: process.execPath, args: ['tests/scenarios/run.mjs', suite], suite, engine,
      exit: result.status, signal: result.signal, error: result.error?.message, log, sha256: sha(await readFile(join(output, log))) });
    await save('execution.json', execution);
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
    const path = join(child, 'receipt.json'), r = await json(path); countsOK(r.counts); assert.equal(r.exit, 0);
    assert.deepEqual(r.cases, cell.cases); assert.deepEqual(r.packs, prepared.packs); assert.deepEqual(r.artifacts, prepared.artifacts);
    assert.equal(r.profile.engine, engine); assert.ok(r.teardown.includes('fixture listener closed'));
    execution.receipts.push({ suite, engine, original: cell.original, ...await pin(path), counts: r.counts,
      mode: 'fresh', packageDirectory: dirname(preparedPath) });
    await save('execution.json', execution); console.log(JSON.stringify({ suite, engine, ...r.counts }));
  }
  await verifySources(); assert.equal(sha(await readFile(preparedPath)), execution.prepared.sha256);
  assert.equal(execution.receipts.length, 9);
  execution.counts = { executed: execution.receipts.reduce((n, r) => n + r.counts.executed, 0),
    passed: execution.receipts.reduce((n, r) => n + r.counts.passed, 0), failed: 0, skipped: 0 };
  execution.freshExecuted = execution.receipts.filter(r => r.mode === 'fresh').reduce((n, r) => n + r.counts.executed, 0);
  execution.reusedExecuted = execution.counts.executed - execution.freshExecuted; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1;
} finally {
  execution.finished = new Date().toISOString(); await save('execution.json', execution);
  console.log(JSON.stringify({ output, counts: execution.counts, freshExecuted: execution.freshExecuted,
    reusedExecuted: execution.reusedExecuted, exit: execution.exit, failure: execution.failure?.split('\n').slice(0, 3) }));
}
