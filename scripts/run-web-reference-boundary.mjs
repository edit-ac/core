import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Compose the original host-catalog/presenter and link browser contracts using
// one authenticated installed SDK. Every host response is deterministic.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_REFERENCE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_REFERENCE_OUTPUT);
mkdirSync(output); // Preserve failed and successful evidence.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const prior = resolve(process.env.EDITAC_WEB_REFERENCE_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-6');
const evidence = resolve('../architecture/evidence');
const originals = {
  'references': engine => join(evidence, 'link-resolution/lnk-1.9-20261015/references', engine, 'receipt.json'),
  'reference-presenters': engine => join(evidence, 'editor-interactions/ifc-1.1-20261017/runtime/reference-presenters', engine, 'receipt.json'),
  'link-enrichment': engine => join(evidence, 'link-resolution/lnk-1.12-20261015/repaired', `enrichment-${engine}`, 'receipt.json'),
  'private-link-display': engine => join(evidence, 'editor-interactions/ifc-1.1-20261017/runtime/private-link-display', engine, 'receipt.json'),
};
const suites = Object.keys(originals);
const repairPath = join(evidence, 'web-feature-first-20261018/wfe-3.1/c4f-references/oracle-repair.json');
assert.equal(hash(readFileSync(repairPath)), '9a70bb2765bcd3fb02879dfea4e968d1391a8bdd0fbc5888ea4d8558e26832da');
const repairs = json(repairPath).files;
const resumed = process.env.EDITAC_WEB_REFERENCE_RESUME ? json(resolve(process.env.EDITAC_WEB_REFERENCE_RESUME, 'execution.json')) : undefined;
const reusedReceipts = [];
const runtime = json(join(prior, 'runtime-source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const assertions = suites.flatMap(suite => [`tests/browser/${suite}.spec.ts`, ...walk(`fixtures/browser-${suite}`)]);
for (const suite of suites) {
  const old = json(originals[suite]('chromium'));
  for (const path of assertions.filter(path => path === `tests/browser/${suite}.spec.ts` || path.startsWith(`fixtures/browser-${suite}/`))) {
    const repair = repairs[path];
    if (repair) assert.equal(repair.originalSha256, old.sources[path], `Repair must retain exact original: ${path}`);
    assert.equal(hash(readFileSync(path)), repair?.repairedSha256 ?? old.sources[path], `Original assertions/fixture changed: ${path}`);
  }
}
const paths = [...Object.keys(runtime), ...assertions, 'scripts/run-web-reference-boundary.mjs',
  'tests/browser/browser-harness.ts', 'tests/browser/fixture-server.mjs',
  'tests/browser/editing-packed-cache.mjs', 'scripts/test-browser.mjs', 'scripts/editing-coverage.mjs'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
const packages = {};
for (const name of ['core', 'web', 'markdown']) {
  const packed = spawnSync('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', output], { encoding: 'utf8' });
  writeFileSync(join(output, `pack-${name}.log`), (packed.stdout ?? '') + (packed.stderr ?? ''));
  assert.equal(packed.status, 0, `Pack ${name}`); assert.equal(packed.error, undefined);
  const [manifest] = JSON.parse(packed.stdout), path = join(output, manifest.filename);
  packages[name] = { path, manifest, sha256: hash(readFileSync(path)) };
}
verifyPins(members);
save('packages.json', packages);
const execution = { task: 'WFE-3.1-C4f-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  buildAdmission: { path: prior, sourcePins: Object.keys(runtime).length, runtimeMembers: Object.keys(members).length },
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
const failures = [];
for (const suite of suites) {
  const previous = resumed?.commands.find(c => c.args.at(-1) === suite && c.exit === 0);
  if (previous) {
    const oldOutput = resolve(process.env.EDITAC_WEB_REFERENCE_RESUME);
    const logPath = join(oldOutput, previous.log);
    assert.equal(hash(readFileSync(logPath)), previous.sha256);
    const cells = walk(join(oldOutput, suite)).filter(path => path.endsWith('/receipt.json'));
    assert.equal(cells.length, 3);
    for (const path of cells) {
      const cell = json(path); verifyPins(cell.sources);
      assert.notEqual(cell.sourcesUnchanged, false);
      assert.equal(cell.counts.executed, cell.counts.passed);
      assert.equal(cell.counts.failed + cell.counts.skipped, 0);
      reusedReceipts.push(path);
    }
    assert.deepEqual(tapCounts(readFileSync(logPath, 'utf8')), previous.counts);
    execution.commands.push({ ...previous, log: logPath, mode: 'exact-input-reuse', originalExecution: join(oldOutput, 'execution.json') });
    save('execution.json', execution); continue;
  }
  const log = `${suite}.log`, fd = openSync(join(output, log), 'wx'); let result;
  try {
    result = spawnSync('npm', ['run', 'test:browser', '--', suite], {
      stdio: ['ignore', fd, fd], env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'),
        EDITAC_EDITING_ALL_OUTPUT: output, ['EDITAC_' + suite.toUpperCase().replaceAll('-', '_') + '_OUTPUT']: join(output, suite) },
    });
  } finally { closeSync(fd); }
  const command = { program: 'npm', args: ['run', 'test:browser', '--', suite], log,
    exit: result.status, signal: result.signal, error: result.error?.message, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(command); save('execution.json', execution);
  if (result.error || result.signal || result.status !== 0) { failures.push(suite); continue; }
  command.counts = tapCounts(readFileSync(join(output, log), 'utf8'));
  assert.ok(command.counts.executed > 0); assert.equal(command.counts.executed, command.counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(command.counts[key], 0);
  save('execution.json', execution);
}
execution.failures = failures; save('execution.json', execution);
assert.deepEqual(failures, [], 'Repair failed original suites before binding');
const receipts = [...reusedReceipts, ...walk(output).filter(path => path.endsWith('/receipt.json'))].map(path => {
  const receipt = json(path);
  assert.ok(suites.includes(receipt.suite)); verifyPins(receipt.sources);
  assert.notEqual(receipt.sourcesUnchanged, false);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  const originalPath = originals[receipt.suite](receipt.engine), previous = json(originalPath);
  assert.deepEqual(receipt.cases.map(c => c.name), previous.cases.map(c => c.name), 'Original case coverage changed');
  assert.equal(receipt.counts.executed, previous.counts.executed);
  return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine, counts: receipt.counts,
    cases: receipt.cases.map(c => c.name), original: { path: originalPath, sha256: hash(readFileSync(originalPath)) } };
});
assert.deepEqual(receipts.map(r => `${r.engine}/${r.suite}`).sort(),
  ['chromium', 'firefox', 'webkit'].flatMap(engine => suites.map(suite => `${engine}/${suite}`)).sort());
const counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.reduce((n, c) => n + c.counts[key], 0)]));
assert.equal(receipts.reduce((n, r) => n + r.counts.executed, 0), counts.executed);
assert.deepEqual(sourcePins(), sources, 'Sources changed during proof'); verifyPins(members);
const freshCounts = Object.fromEntries(Object.keys(counts).map(key => [key, execution.commands.filter(c => !c.mode).reduce((n, c) => n + c.counts[key], 0)]));
const reusedCounts = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - freshCounts[key]]));
Object.assign(execution, { freshCounts, reusedCounts, finished: new Date().toISOString(), counts, receipts, sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts, receipts: receipts.length, sourcePins: Object.keys(sources).length }));
