import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadScenario } from '../tests/scenarios/run.mjs';
import { prepareProductHarness } from '../tests/scenarios/harness.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { hash } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// One installed product site and the original real-middleware collaboration
// boundary. Admission composes existing behavioral oracles, never replaces them.
await requireTestNode();
// Rust/JS transport interoperability invokes cargo; fail before installing the
// product or executing browsers when the child process cannot resolve it.
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
assert.ifError(cargo.error); assert.equal(cargo.status, 0, cargo.stderr);
assert.ok(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const admissionPath = resolve(process.env.EDITAC_PRODUCT_SDK_ADMISSION ?? join(base, 'c9-4/admission.json'));
const admitted = admitImmutableSdk(admissionPath);
const build = admitted.sources;
const runtime = admitted.runtime;
const verify = pins => {
  for (const [path, digest] of Object.entries(pins))
    assert.equal(hash(readFileSync(path)), digest, 'Changed current input: ' + path);
};
verify(build); verify(runtime);
const requestPath = resolve('../.roadmap-coordination/requests/parallel-offline-recovery-rpr-1.1-20261019.json');
const landed = json('../.roadmap-coordination/requests/parallel-offline-recovery-rpr-1.2-20261019.json');
assert.equal(landed.task, 'RPR-1.2');
for (const cwd of [process.cwd(), '/Users/bpstr/Github/edit-ac/core'])
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', landed.mainCore, 'HEAD'], { cwd }).status, 0);
const execution = { task: 'WFE-3.1-C9-1', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), cargo: cargo.stdout.trim(), commands: [], receipts: [], buildAdmission: build,
  runtimeMembers: runtime, runner: pin('scripts/run-web-workflow-collaboration-refresh-boundary.mjs'),
  qualifiedReturn: pin(requestPath), landedReturn: landed, sdkAdmission: admitted.receipt };
try {
  // Consume the qualified consumer return without treating its narrower product
  // cases as this boundary's original workflow/collaboration acceptance.
  const returnPath = resolve('../.roadmap-coordination/requests/revision-review-rvp-3.2-product-handoff-20261019.json');
  const returned = json(returnPath);
  assert.equal(returned.task, 'RVP-3.2');
  for (const name of ['delivery', 'handoff'])
    assert.equal(hash(readFileSync(returned[name])), returned[name + 'Sha256'], 'Changed qualified return: ' + name);
  const delivery = json(returned.delivery), directory = dirname(returned.delivery);
  assert.equal(delivery.parent, 'RVP-3.2'); assert.equal(delivery.state, 'complete');
  assert.equal(delivery.main.coreCommit, returned.coreMain);
  for (const cwd of [process.cwd(), '/Users/bpstr/Github/edit-ac/core']) {
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', returned.coreMain, 'HEAD'], { cwd }).status, 0);
    for (const source of delivery.pins.core)
      assert.equal(hash(readFileSync(join(cwd, source.path))), source.sha256, 'Changed returned consumer input: ' + source.path);
  }
  const evidencePins = [delivery.installed, delivery.ownerInputs, ...delivery.groups];
  for (const receipt of evidencePins)
    assert.equal(hash(readFileSync(join(directory, receipt.path))), receipt.sha256, 'Changed returned receipt: ' + receipt.path);
  const owner = json(join(directory, delivery.ownerInputs.path));
  for (const [name, pack] of Object.entries(owner.archives))
    assert.equal(pack.sha256, admitted.packages[name].sha256, 'Consumer/owner SDK archives differ: ' + name);
  let consumerAssertions = 0;
  for (const group of delivery.groups) {
    const receipt = json(join(directory, group.path));
    assert.equal(receipt.exit, 0); assert.ok(receipt.counts.executed > 0);
    assert.equal(receipt.counts.executed, receipt.counts.passed);
    for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(receipt.counts[key] ?? 0, 0);
    consumerAssertions += receipt.counts.executed;
  }
  assert.equal(consumerAssertions, returned.guard.counts.executed);
  execution.qualifiedConsumerReturn = { ...pin(returnPath), delivery: pin(returned.delivery),
    sourcePinsMatched: delivery.pins.core.length, archiveFamiliesMatched: Object.keys(owner.archives),
    consumerAssertionsAuthenticated: consumerAssertions,
    scope: 'Qualified return prerequisite only; original workflow/collaboration assertions execute below' };
  save('qualified-consumer-return.json', execution.qualifiedConsumerReturn);
  const prepared = { output: join(output, 'prepared'), commands: [], purpose: 'Current original workflow refresh' };
  if (process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_SITE) {
    execution.prepared = pin(resolve(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_SITE));
  } else {
    // Compose only this boundary's original suites, with one real installed site.
    // The full alpha checkpoint (including optional formats) remains a later gate.
    const suites = await Promise.all(['web-task-workspace', 'web-react-routes', 'web-local-recovery'].map(id => loadScenario(id)));
    const scenario = { packages: ['react'], command: ['node', 'tests/scenarios/product-checkpoint.mjs'],
      fixtures: [...new Set(suites.flatMap(s => s.scenario.fixtures))],
      supportingSources: [...new Set(suites.flatMap(s => [...(s.scenario.supportingSources ?? []), s.scenario.command[1]]))] };
    // Use the unchanged product harness's existing package-composition entry.
    // This receipt authenticates setup on the current source; it carries no tests.
    const catalog = join(output, 'admitted-sdk'); mkdirSync(catalog);
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    for (const [path, digest] of Object.entries(build).filter(([path]) => /^(crates\/|packages\/(core|web)\/src\/)/.test(path))) {
      const committed = spawnSync('git', ['show', revision + ':' + path]);
      assert.equal(committed.status, 0); assert.equal(hash(committed.stdout), digest, 'Uncommitted SDK input: ' + path);
    }
    const packs = ['core', 'web'].map(name => {
      const pack = admitted.packages[name], file = pack.manifest.filename;
      copyFileSync(pack.path, join(catalog, file)); return { name, file, sha256: pack.sha256 };
    });
    const setup = { sourceRevision: revision, packageSourceRevision: revision, sdkAdmission: admitted.receipt,
      scope: 'Exact current committed SDK source equality and immutable qualified archives; setup only, no behavioral receipt',
      packs, toolchains: { node: process.versions.node, npm: '11.17.0', rust: 'rustc 1.97.1' } };
    writeFileSync(join(catalog, 'setup.json'), JSON.stringify(setup, null, 2) + '\n');
    process.env.EDITAC_PRODUCT_PACK_RECEIPT = join(catalog, 'setup.json');
    await prepareProductHarness(prepared.output, prepared, scenario);
    prepared.prepared = true;
    writeFileSync(join(prepared.output, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n');
    execution.prepared = pin(join(prepared.output, 'prepared.json'));
  }
  for (const [name, script, env] of [
    ['workflow', 'scripts/run-web-recovery-workflow-boundary.mjs', {
      EDITAC_WEB_READONLY_OUTPUT: join(output, 'workflow'),
      EDITAC_PRODUCT_SITE_RECEIPT: execution.prepared.path,
      EDITAC_WEB_RECOVERY_RETURN: requestPath,
    }],
    ['collaboration', 'scripts/run-web-collaboration-boundary.mjs', {
      EDITAC_WEB_COLLABORATION_OUTPUT: join(output, 'collaboration'),
      EDITAC_COLLABORATION_ADMISSION: admissionPath,
    }],
  ]) {
    if (name === 'collaboration' && process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_REUSE) {
      const priorPath = resolve(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_REUSE), prior = json(priorPath);
      assert.equal(prior.exit, 0); verify(json(resolve(priorPath, '../source-pins.json')));
      verify(json(resolve(priorPath, '../package-runtime-pins.json')));
      for (const pack of json(resolve(priorPath, '../packages.json')))
        assert.equal(pack.sha256, admitted.packages[pack.name].sha256);
      for (const receipt of prior.receipts) {
        assert.equal(hash(readFileSync(receipt.path)), receipt.sha256);
        const r = json(receipt.path); verify(r.sources);
        for (const pack of r.packs) assert.equal(hash(readFileSync(resolve(priorPath, '..', pack.file))), pack.sha256);
      }
      for (const command of prior.commands) {
        assert.equal(command.exit, 0); assert.equal(command.signal, null);
        assert.equal(hash(readFileSync(resolve(priorPath, '..', command.log))), command.sha256);
      }
      execution.commands.push({ program: process.execPath, args: [script], mode: 'exact-input-reuse',
        originalExecution: pin(priorPath), exit: 0, counts: prior.counts, freshExecuted: 0, reusedExecuted: prior.counts.executed });
      execution.receipts.push({ name, ...pin(priorPath) }); continue;
    }
    const log = join(output, name + '.log'), fd = openSync(log, 'wx'); let result;
    try { result = spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    const command = { program: process.execPath, args: [script], env, exit: result.status,
      signal: result.signal, error: result.error?.message, log: pin(log) };
    execution.commands.push(command); save('execution.json', execution);
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
    const path = join(output, name, 'execution.json'), child = json(path);
    assert.equal(child.exit, 0); assert.ok(child.counts.executed > 0);
    assert.equal(child.counts.executed, child.counts.passed);
    for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(child.counts[key] ?? 0, 0);
    command.counts = child.counts; command.freshExecuted = child.freshExecuted;
    command.reusedExecuted = child.reusedExecuted;
    execution.receipts.push({ name, ...pin(path) });
  }
  verify(build); verify(runtime);
  execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo']
    .map(key => [key, execution.commands.reduce((sum, c) => sum + (c.counts[key] ?? 0), 0)]));
  execution.freshExecuted = execution.commands.reduce((sum, c) => sum + c.freshExecuted, 0);
  execution.reusedExecuted = execution.commands.reduce((sum, c) => sum + c.reusedExecuted, 0);
  execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution); }
console.log(JSON.stringify({ exit: execution.exit, counts: execution.counts, failure: execution.failure }));
