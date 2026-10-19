import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts } from './editing-coverage.mjs';
import { portableGroups, catalogRows, portableCases, assertCounts } from '../tests/mobile-web/catalog.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Original portable assertions, current packed SDK, and exact unaffected-input
// reuse. No substitute presenter, transport, storage, or semantic implementation.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_TOUCH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_TOUCH_OUTPUT); mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = sources => { assert.ok(Object.keys(sources).length); for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, 'Changed source: ' + path); };
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const originalProof = json('fixtures/product-scenarios/web/features.json').proofs.find(p => p.id === 'wfe-2.2');
const mapping = json('tests/mobile-web/portable-cases.json');
const execution = { task: 'WFE-3.1-C4j', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  feature: 'WEB-TOUCH', started: new Date().toISOString(), node: process.version, commands: [], receipts: [], failures: [] };
const affected = ['input', 'lifecycle', 'modules'];
const expectedDifferences = ['dist/extensions/runtime/content.js', 'dist/extensions/runtime/manifest.json',
  'dist/modules/content.js', 'dist/modules/formats.js', 'dist/modules/transfer.d.ts', 'dist/modules/transfer.js'];
try {
  const runtime = json(join(base, 'c2c-tables/runtime-source-pins.json'));
  const members = json(join(base, 'c4i-markdown/package-runtime-pins.json'));
  verify(runtime); verify(members);
  const packages = json(join(base, 'c4i-markdown/run-5/packages.json'));
  for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
  save('packages.json', packages); save('package-runtime-pins.json', members);
  const original = originalProof.receipts.map(p => {
    assert.equal(hash(readFileSync(p.path)), p.sha256);
    const r = json(p.path), testFile = Object.keys(r.sources).find(s => /^tests\/mobile-web\/.*\.spec\.ts$/.test(s));
    const group = testFile.split('/').pop().replace('.spec.ts', '');
    assert.ok(portableGroups.includes(group)); assertCounts(r.counts);
    assert.equal(r.sourcesUnchanged, true);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(r.cleanup[key], true);
    const dispatch = json(join(dirname(p.path), 'dispatch-receipt.json'));
    assertCounts(dispatch.counts); assert.equal(dispatch.browserReceiptSha256, p.sha256);
    assert.deepEqual(dispatch.browserCounts, r.counts);
    const tap = join(dirname(p.path), 'tests.tap');
    const counts = tapCounts(readFileSync(tap, 'utf8'));
    for (const key of ['executed', 'passed', 'failed', 'skipped', 'cancelled']) assert.equal(counts[key], dispatch.counts[key]);
    for (const pack of r.packs) assert.equal(hash(readFileSync(join(dirname(p.path), pack.file))), pack.sha256);
    return { ...p, ...pin(p.path), engine: r.engine, group, receipt: r, dispatch, tap: pin(tap) };
  });
  assert.equal(original.length, portableGroups.length * 3);
  assert.equal(new Set(original.map(r => r.engine + '/' + r.group)).size, original.length);
  const sources = { ...runtime, ...members };
  for (const entry of original) for (const path of Object.keys(entry.receipt.sources)) sources[path] = hash(readFileSync(path));
  for (const path of ['scripts/run-web-touch-boundary.mjs', 'tests/mobile-web/portable-cases.json']) sources[path] = hash(readFileSync(path));
  save('source-pins.json', sources);
  // The fixture dynamically loads content only for table:true, and Markdown
  // only for triggers/palette. The seven reused groups enable none of these.
  // Authenticate every old package member, including transitive runtime chunks;
  // allow only the six known, unselected optional-content/format members.
  const reused = original.filter(r => !affected.includes(r.group));
  const fixture = readFileSync('fixtures/browser-mobile-web/session.mjs', 'utf8');
  assert.ok(fixture.includes("if(options.table&&!options.presentersDisabled){const {contentModules}=await import('/web/modules/content.js')"));
  assert.ok(fixture.includes('if(options.triggers||options.palette)'));
  for (const entry of reused) {
    verify(entry.receipt.sources);
    const testFile = `tests/mobile-web/${entry.group}.spec.ts`, text = readFileSync(testFile, 'utf8');
    assert.ok(!/\b(table|triggers|palette)\s*:/.test(text), 'Optional dependency enabled by reused group');
    assert.ok(!/configureExtensions|configuration\s*:|formatControls\s*:/.test(text), 'Configured optional runtime enabled');
    assert.deepEqual(entry.receipt.packs.map(p => p.name).sort(), ['core', 'web']);
  }
  const archivePaths = [...new Set(reused.flatMap(r => r.receipt.packs.map(p => join(dirname(r.path), p.file))))];
  const compare = spawnSync('python3', ['-c', `import sys,json,tarfile,pathlib,hashlib
paths=json.load(sys.stdin); result=[]
for path in paths:
 name='core' if 'edit-ac-core-' in path else 'web'; unchanged={}; changed=[]
 with tarfile.open(path) as tar:
  for member in tar.getmembers():
   if not member.isfile() or not member.name.startswith('package/dist/'): continue
   relative=member.name.removeprefix('package/'); current=pathlib.Path('packages')/name/relative
   old=hashlib.sha256(tar.extractfile(member).read()).hexdigest(); new=hashlib.sha256(current.read_bytes()).hexdigest()
   if old==new: unchanged[str(current)]=new
   else: changed.append({'path':relative,'prior':old,'current':new})
 result.append({'path':path,'unchanged':unchanged,'changed':changed})
print(json.dumps(result))`], { input: JSON.stringify(archivePaths), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(compare.status, 0, compare.stderr);
  const applicability = JSON.parse(compare.stdout);
  for (const entry of applicability) {
    assert.ok(Object.keys(entry.unchanged).length >= 55);
    assert.deepEqual(entry.changed.map(p => p.path).sort(), entry.path.includes('edit-ac-core-') ? [] : expectedDifferences);
  }
  save('unaffected-runtime-applicability.json', { scope: 'Seven groups: unchanged original assertions, fixtures, public inputs and all reachable packed runtime members. Changed content/format optional members are not selected; parser is not installed.',
    groups: portableGroups.filter(g => !affected.includes(g)), archives: applicability });
  const resume = process.env.EDITAC_WEB_TOUCH_RESUME && json(join(resolve(process.env.EDITAC_WEB_TOUCH_RESUME), 'execution.json'));
  for (const entry of original) {
    const { group, engine } = entry;
    if (!affected.includes(group)) {
      execution.receipts.push({ ...pin(entry.path), group, engine, reused: true, counts: entry.receipt.counts,
        dispatcherCounts: entry.dispatch.counts, original: pin(entry.path), tap: entry.tap });
      continue;
    }
    let accepted = resume?.receipts.find(r => r.group === group && r.engine === engine);
    if (accepted) {
      assert.equal(hash(readFileSync(accepted.path)), accepted.sha256);
      const receipt = json(accepted.path); verify(receipt.sources);
      for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
      assertCounts(receipt.counts); assert.deepEqual(receipt.cases.map(c => c.name), entry.receipt.cases.map(c => c.name));
      execution.receipts.push({ ...accepted, reused: true }); continue;
    }
    const child = join(output, engine, group), log = `${engine}-${group}.log`, fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, ['scripts/test-mobile-web.mjs', '--group', group], {
      stdio: ['ignore', fd, fd], timeout: 180000, env: { ...process.env,
        EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_MOBILE_HARNESS_OUTPUT: child, EDITAC_MOBILE_HARNESS_BROWSER: engine },
    }); } finally { closeSync(fd); }
    const command = { program: process.execPath, args: ['scripts/test-mobile-web.mjs', '--group', group], engine,
      exit: result.status, signal: result.signal, error: result.error?.message, log, sha256: hash(readFileSync(join(output, log))) };
    execution.commands.push(command); save('execution.json', execution);
    try {
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
      const path = join(child, 'receipt.json'), receipt = json(path), dispatch = json(join(child, 'dispatch-receipt.json'));
      assertCounts(receipt.counts); assertCounts(dispatch.counts); verify(receipt.sources);
      assert.equal(receipt.sourcesUnchanged, true);
      for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
      for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
      assert.deepEqual(receipt.cases.map(c => c.name), entry.receipt.cases.map(c => c.name), 'Original portable case coverage changed');
      execution.receipts.push({ ...pin(path), group, engine, reused: false, counts: receipt.counts,
        dispatcherCounts: dispatch.counts, original: pin(entry.path), tap: pin(join(child, 'tests.tap')) });
    } catch (error) { execution.failures.push({ group, engine, error: error.stack }); }
    save('execution.json', execution);
  }
  assert.equal(execution.failures.length, 0, 'Retained affected-group failures');
  assert.equal(execution.receipts.length, original.length);
  const caseMapping = {};
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    caseMapping[engine] = portableGroups.flatMap(group => {
      const r = execution.receipts.find(r => r.engine === engine && r.group === group);
      return portableCases(catalogRows().filter(row => row.group === group), mapping, json(r.path).cases);
    });
    assert.equal(caseMapping[engine].length, 54);
  }
  save('case-mapping.json', caseMapping);
  const totals = entries => entries.reduce((sum, r) => {
    for (const key of ['executed', 'passed', 'failed', 'skipped']) sum[key] += r.counts[key]; return sum;
  }, { executed: 0, passed: 0, failed: 0, skipped: 0 });
  execution.counts = totals(execution.receipts); assert.equal(execution.counts.executed, 726); assertCounts(execution.counts);
  execution.freshCounts = totals(execution.receipts.filter(r => !r.reused));
  execution.reusedCounts = totals(execution.receipts.filter(r => r.reused));
  execution.dispatcherCounts = totals(execution.receipts.map(r => ({ counts: r.dispatcherCounts })));
  assert.equal(execution.dispatcherCounts.executed, 759); assertCounts(execution.dispatcherCounts);
  verify(sources); verify(members); execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, counts: execution.counts, fresh: execution.freshCounts, reused: execution.reusedCounts,
    exit: execution.exit, failure: execution.failure?.split('\n').slice(0, 3) })); }
