import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Current immutable inputs, full original prepared AI boundary, no provider.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_AI_REFRESH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_AI_REFRESH_OUTPUT);
mkdirSync(output);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const admitted = admitImmutableSdk(resolve(process.env.EDITAC_PRODUCT_SDK_ADMISSION ??
  '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c9-4/admission.json'));
const sources = { ...admitted.sources };
for (const path of ['scripts/run-web-ai-boundary.mjs', 'scripts/run-web-ai-refresh-boundary.mjs'])
  sources[path] = hash(readFileSync(path));
const admission = join(output, 'admission');
mkdirSync(admission); mkdirSync(join(admission, 'run-1'));
save(join(admission, 'runtime-source-pins.json'), sources);
save(join(admission, 'package-runtime-pins.json'), admitted.runtime);
save(join(admission, 'run-1/packages.json'), admitted.packages);
const execution = { task: 'WFE-3.1-C9-6', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), sdkAdmission: admitted.receipt, commands: [], failures: [], providerCalls: 0 };
try {
  const log = join(output, 'ai.log'), fd = openSync(log, 'wx');
  const env = { EDITAC_WEB_AI_OUTPUT: join(output, 'ai'), EDITAC_WEB_AI_BUILD: admission };
  let result;
  try { result = spawnSync(process.execPath, ['scripts/run-web-ai-boundary.mjs'], {
    stdio: ['ignore', fd, fd], env: { ...process.env, ...env } }); } finally { closeSync(fd); }
  execution.commands.push({ program: process.execPath, args: ['scripts/run-web-ai-boundary.mjs'],
    env, log, sha256: hash(readFileSync(log)), exit: result.status, signal: result.signal, error: result.error?.message });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
  const receipt = JSON.parse(readFileSync(join(output, 'ai/execution.json'), 'utf8'));
  assert.equal(receipt.exit, 0); assert.deepEqual(receipt.failures, []);
  for (const pins of [sources, admitted.runtime]) for (const [path, expected] of Object.entries(pins))
    assert.equal(hash(readFileSync(path)), expected, 'Input changed during dispatch: ' + path);
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failures.push(error.stack); execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save(join(output, 'execution.json'), execution);
  console.log(JSON.stringify({ output, exit: execution.exit, failures: execution.failures.map(e => e.split('\n')[0]) })); }
