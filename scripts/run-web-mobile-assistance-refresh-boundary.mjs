import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Reuse the qualified baseline, execute only its missing mobile composition.
// All behavior assertions remain in the original public SDK browser scenarios.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_MOBILE_ASSISTANCE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MOBILE_ASSISTANCE_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = sources => { for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, 'Changed input: ' + path); };
const good = c => {
  assert.ok(c.executed > 0); assert.equal(c.executed, c.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(c[key] ?? 0, 0, key);
};
const execution = { task: 'WFE-3.1-C6a', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), commands: [], receipts: [], failures: [], providerCalls: 0 };
try {
  const admission = join(base, 'c8/run-3/admission');
  const sources = json(join(admission, 'runtime-source-pins.json'));
  const members = json(join(admission, 'package-runtime-pins.json'));
  const catalog = json(join(admission, 'run-1/packages.json'));
  const packages = Object.fromEntries(['core', 'web', 'markdown'].map(name => [name, catalog[name]]));
  verify(sources); verify(members);
  for (const p of Object.values(packages)) assert.equal(hash(readFileSync(p.path)), p.sha256);
  // Authenticate archive contents against the installed runtime, not only labels.
  const preflight = spawnSync('python3', ['-c', `import json,sys,tarfile,hashlib,pathlib
packs,members=json.load(sys.stdin);actual={}
for name,p in packs.items():
 with tarfile.open(p['path']) as t:
  for m in t.getmembers():
   if m.isfile() and m.name.startswith('package/dist/'):
    path='packages/'+name+'/'+m.name.removeprefix('package/');h=hashlib.sha256(t.extractfile(m).read()).hexdigest()
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==h,path
    actual[path]=h
assert actual==members
print(json.dumps({'archives':len(packs),'runtimeMembers':len(actual)}))`],
    { input: JSON.stringify([packages, members]), encoding: 'utf8' });
  writeFileSync(join(output, 'archive-preflight.log'), preflight.stdout + preflight.stderr);
  assert.equal(preflight.status, 0, 'Archive preflight');
  const oldExecution = json(join(base, 'c6-mobile/run-1/execution.json'));
  const original = oldExecution.receipts.filter(p => p.group === 'assistance');
  assert.equal(original.length, 3);
  const oldReceipts = original.map(p => {
    assert.equal(hash(readFileSync(p.path)), p.sha256); const r = json(p.path); good(r.counts);
    // Neither semantic assertions nor fixtures are weakened to restore admission.
    verify(r.sources); Object.assign(sources, r.sources); return r;
  });
  const baselinePath = join(base, 'c8/run-3/assistance/execution.json');
  const baseline = json(baselinePath); assert.equal(baseline.exit, 0); assert.deepEqual(baseline.failures, []);
  assert.equal(baseline.receipts.length, 6);
  const expectedCounts = { 'assistive-dictation': 55, 'assistive-presenter': 16 };
  for (const p of baseline.receipts) {
    assert.equal(hash(readFileSync(p.path)), p.sha256); const r = json(p.path);
    assert.ok(r.engine === p.engine && r.suite === p.suite); good(r.counts);
    assert.equal(r.counts.executed, expectedCounts[r.suite]); verify(r.sources);
    assert.equal(r.sourcesUnchanged, true); assert.ok(Object.values(r.cleanup).every(Boolean));
    assert.ok(r.cases.every(c => c.passed));
    for (const pack of r.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
    Object.assign(sources, r.sources);
    execution.receipts.push({ ...p, mode: 'exact-input-reuse', cases: r.cases.map(c => c.name) });
  }
  assert.deepEqual(json(join(base, 'c8/run-3/assistance/packages.json')), packages);
  sources['scripts/run-web-mobile-assistance-refresh-boundary.mjs'] = hash(readFileSync('scripts/run-web-mobile-assistance-refresh-boundary.mjs'));
  save('packages.json', packages); save('source-pins.json', sources); save('package-runtime-pins.json', members);
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const child = join(output, engine), log = engine + '.log';
    const env = { EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_MOBILE_EXTENSIONS_OUTPUT: child, EDITAC_MOBILE_EXTENSIONS_BROWSER: engine };
    const args = ['scripts/test-mobile-extensions.mjs', '--group', 'assistance'];
    const fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 240000, env: { ...process.env, ...env } }); }
    finally { closeSync(fd); }
    const command = { program: process.execPath, args, cwd: process.cwd(), env, log, exit: result.status, signal: result.signal, error: result.error?.message };
    execution.commands.push(command); save('execution.json', execution);
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
    const path = join(child, 'receipt.json'), r = json(path), old = oldReceipts.find(r => r.engine === engine);
    good(r.counts); assert.equal(r.counts.executed, 23); assert.equal(r.sourcesUnchanged, true); verify(r.sources);
    assert.deepEqual(r.cases.map(c => c.name), old.cases.map(c => c.name)); assert.ok(r.cases.every(c => c.passed));
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(r.cleanup[key], true);
    for (const pack of r.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
    Object.assign(sources, r.sources);
    command.counts = tapCounts(readFileSync(join(child, 'tests.tap'), 'utf8')); good(command.counts);
    execution.receipts.push({ ...pin(path), engine, suite: 'mobile-assistance', mode: 'fresh', counts: r.counts, cases: r.cases.map(c => c.name), original: original.find(p => p.engine === engine) });
  }
  verify(sources); verify(members); save('source-pins.json', sources);
  execution.counts = { executed: 282, passed: 282, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  execution.freshAssertions = 69; execution.exactInputReusedAssertions = 213;
  assert.equal(execution.receipts.reduce((n, p) => n + p.counts.executed, 0), 282);
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failures.push(error.stack); execution.exit = 1; process.exitCode = 1; }
finally {
  execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, exit: execution.exit, counts: execution.counts, failures: execution.failures.map(e => e.split('\n')[0]) }));
}
