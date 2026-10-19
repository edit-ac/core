import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareProductSite } from '../examples/task-editor/product.mjs';
import { hash } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// One installed product site and the original real-middleware collaboration
// boundary. Admission composes existing behavioral oracles, never replaces them.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const build = json(join(base, 'c7-2/current-build/runtime-source-pins.json'));
const runtime = json(join(base, 'c7-2/current-build/package-runtime-pins.json'));
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
const execution = { task: 'WFE-3.1-C7-1', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), commands: [], receipts: [], buildAdmission: build,
  runtimeMembers: runtime, runner: pin('scripts/run-web-workflow-collaboration-refresh-boundary.mjs'),
  qualifiedReturn: pin(requestPath), landedReturn: landed };
try {
  const prepared = { output: join(output, 'prepared'), commands: [], purpose: 'Current original workflow refresh' };
  if (process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_SITE) {
    execution.prepared = pin(resolve(process.env.EDITAC_WEB_WORKFLOW_COLLABORATION_SITE));
  } else {
    await prepareProductSite(prepared.output, prepared);
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
      EDITAC_COLLABORATION_REUSE: join(base, 'c4n-collaboration/run-2'),
    }],
  ]) {
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
