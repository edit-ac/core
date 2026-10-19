import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Execute existing interaction and spelling contracts against one authenticated
// installed SDK. Never replace the real middleware, WASM or durable storage.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_EDITING_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_EDITING_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const prior = resolve(process.env.EDITAC_WEB_EDITING_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-7');
const runtime = json(join(prior, 'runtime-source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const suites = ['breaks', 'break-tables', 'formatting', 'deletion', 'navigation', 'keyboard',
  'keyboard-tables', 'replacement', 'whitespace', 'paste', 'paste-tables', 'parsing', 'history'];
const paths = [...Object.keys(runtime), ...suites.map(s => `tests/browser/interactions/${s}.spec.ts`),
  ...walk('fixtures/browser-input'), ...walk('fixtures/browser-content-modules'),
  ...walk('tests/extension-dx'), ...walk('tests/interaction-fixtures'),
  'examples/extensions/spellcheck/spellcheck.ts', 'examples/extensions/spellcheck/README.md',
  'tests/browser/browser-harness.ts', 'tests/browser/interaction-harness.ts',
  'tests/browser/editing-packed-cache.mjs', 'tests/browser/fixture-server.mjs',
  'scripts/run-web-editing-boundary.mjs', 'scripts/test-browser.mjs', 'scripts/test-interactions.mjs',
  'scripts/test-extension-dx.mjs', 'scripts/test-parsing-vectors.mjs', 'scripts/editing-coverage.mjs',
  'crates/editac-markdown/tests/parser_profile.rs', 'crates/editac-markdown/tests/commonmark.rs',
  'crates/editac-markdown/tests/gfm.rs', 'crates/editac-markdown/tests/roundtrip.rs',
  'crates/editac-core/tests/blocks.rs', 'crates/editac-core/tests/history.rs',
  'crates/editac-core/tests/stable_editor_profile.rs', 'crates/editac-core/tests/support/editor_cases.rs',
  ...walk('fixtures/schema-v4'), ...walk('fixtures/schema-v5'),
  'fixtures/markdown/commonmark-0.31.2.json', 'fixtures/markdown/gfm-required.json'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
// Pack authenticated current runtime members for every original suite.
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
const resumeDirectory = process.env.EDITAC_WEB_EDITING_RESUME && resolve(process.env.EDITAC_WEB_EDITING_RESUME);
const resumed = resumeDirectory && json(join(resumeDirectory, 'execution.json'));
const execution = { task: 'WFE-3.1-C4g', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [], failures: [] };
const acceptedReceipts = [];
const zero = () => ({ executed: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 });
const valid = counts => {
  assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key] ?? 0, 0);
};
function browserReceipts(directory) {
  return walk(directory).filter(path => path.endsWith('/receipt.json')).filter(path => json(path).suite).map(path => {
    const receipt = json(path); verifyPins(receipt.sources); assert.equal(receipt.sourcesUnchanged, true);
    valid(receipt.counts);
    if (receipt.suite === 'spellcheck') {
      assert.equal(receipt.runtimeProvenance?.mode, 'canonical-current-packed-sdk');
      assert.equal(receipt.runtimeProvenance.postAssemblyMutation, false);
      assert.equal(receipt.runtimeProvenance.packageSha256, packages.core.sha256);
      // The recipe repacks before installation. Compare every executed member,
      // not just the input tgz or a claimed source hash.
      const archive = path => {
        const result = spawnSync('python3', ['-c',
          'import tarfile,hashlib,json,sys; t=tarfile.open(sys.argv[1]); print(json.dumps({m.name:hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile()},sort_keys=True))', path],
          { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
        assert.equal(result.status, 0); return JSON.parse(result.stdout);
      };
      assert.equal(receipt.testedPackages.length, 2);
      for (const pack of receipt.testedPackages) {
        assert.equal(hash(readFileSync(pack.path)), pack.sha256);
        assert.deepEqual(archive(pack.path), archive(packages[pack.name].path), `Executed ${pack.name} differs from current SDK`);
        assert.equal(pack.postInstallMutation, false);
      }
    }
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
    for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
    return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine,
      counts: receipt.counts, cases: receipt.cases.map(c => c.name) };
  });
}
for (const name of [...suites.filter(s => s !== 'paste-tables').map(s => `interaction-${s}`), 'spellcheck', 'parsing-vectors', 'editing-primitives']) {
  const program = name === 'editing-primitives' ? resolve(process.env.HOME, '.cargo/bin/cargo') : process.execPath;
  const args = name === 'editing-primitives' ? ['+1.97.1', 'test', '-p', 'editac-core', '--test', 'blocks', '--test', 'history', '--test', 'stable_editor_profile', '--locked', '--offline'] : name === 'spellcheck' ? ['scripts/test-extension-dx.mjs', '--group', 'spellcheck']
    : name === 'parsing-vectors' ? ['scripts/test-parsing-vectors.mjs'] : ['scripts/test-browser.mjs', name];
  if (name === 'interaction-paste' && process.env.EDITAC_WEB_EDITING_TABLE_REPAIR) {
    assert.ok(resumed);
    const prior = resumed.commands.find(c => c.name === name && c.exit === 0);
    assert.ok(prior);
    const log = resolve(resumeDirectory, prior.log);
    assert.equal(hash(readFileSync(log)), prior.sha256);
    assert.deepEqual(tapCounts(readFileSync(log,'utf8')), prior.counts);
    const cells = resumed.receipts.filter(r => r.suite === 'interaction-paste');
    assert.equal(cells.length, 3);
    const reused = cells.flatMap(r => {
      assert.equal(hash(readFileSync(r.path)), r.sha256);
      return browserReceipts(resolve(r.path, '..'));
    });
    assert.deepEqual(reused.map(r => `${r.suite}/${r.engine}`).sort(),
      ['chromium','firefox','webkit'].map(e => `interaction-paste/${e}`).sort());
    assert.equal(reused.reduce((n,r)=>n+r.counts.executed,0),282);
    acceptedReceipts.push(...reused);
    execution.commands.push({ ...prior, log, name: 'interaction-paste-prose', mode: 'exact-input-reuse',
      counts: { ...zero(), executed: 282, passed: 282 },
      originalCombinedCounts: prior.counts, originalExecution: join(resumeDirectory, 'execution.json') });
    for (const engine of ['chromium','firefox','webkit']) {
      const log = `interaction-paste-tables-${engine}.log`, directory = join(output,'interaction-paste-tables',engine);
      const args = ['--test','--test-reporter=tap','tests/browser/interactions/paste-tables.spec.ts'];
      const fd = openSync(join(output,log),'wx'); let result;
      try { result = spawnSync(process.execPath,args,{stdio:['ignore',fd,fd],env:{...process.env,
        EDITAC_EDITING_PACKS:join(output,'packages.json'),EDITAC_EDITING_ALL_OUTPUT:output,
        EDITAC_INTERACTION_PASTE_TABLES_BROWSER:engine,EDITAC_INTERACTION_PASTE_TABLES_OUTPUT:directory}}); }
      finally { closeSync(fd); }
      const entry = {name:`interaction-paste-tables-${engine}`,program:process.execPath,args,log,
        exit:result.status,signal:result.signal,error:result.error?.message,sha256:hash(readFileSync(join(output,log))),
        counts:tapCounts(readFileSync(join(output,log),'utf8'))};
      execution.commands.push(entry);save('execution.json',execution);
      assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);valid(entry.counts);
      const fresh=browserReceipts(directory);assert.equal(fresh.length,1);assert.equal(fresh[0].counts.executed,8);
      assert.equal(new Set(fresh[0].cases).size,8);acceptedReceipts.push(...fresh);
    }
    save('execution.json',execution);continue;
  }
  const old = resumed?.commands.find(c => c.name === name && c.exit === 0 && (!c.invalid || (name === 'interaction-paste' && process.env.EDITAC_WEB_EDITING_RECOVERED_PASTE && c.invalid.includes('282 !== 306'))));
  if (old) {
    // A repaired sibling cannot invalidate unrelated successes, but every input
    // to this particular command and its installed packages must still match.
    const oldSources = json(join(resumeDirectory, 'source-pins.json'));
    let previousReceipts = [], reusable = true;
    try {
      if (!['parsing-vectors','editing-primitives'].includes(name)) {
        const expected = name === 'interaction-paste' ? ['interaction-paste','interaction-paste-tables'] : [name];
        const records = resumed.receipts?.filter(r => expected.includes(r.suite)) ?? [];
        previousReceipts = records.length ? records.flatMap(record => {
          assert.equal(hash(readFileSync(record.path)), record.sha256);
          const cells = browserReceipts(resolve(record.path,'..')).filter(r => r.path === record.path);
          assert.equal(cells.length,1);return cells;
        }) : browserReceipts(join(resumeDirectory,name));
      }
      if (name === 'interaction-paste' && process.env.EDITAC_WEB_EDITING_RECOVERED_PASTE) {
        const recovered = resolve(process.env.EDITAC_WEB_EDITING_RECOVERED_PASTE);
        const manifest = json(join(recovered, 'recovery.json'));
        const cells = browserReceipts(recovered);
        assert.equal(cells.length, 3);
        for (const cell of cells) assert.ok(manifest.receipts.some(r => r.path === cell.path && r.sha256 === cell.sha256));
        previousReceipts.push(...cells);
      }
      if (!['parsing-vectors','editing-primitives'].includes(name)) {
        const expected = name === 'interaction-paste' ? ['interaction-paste', 'interaction-paste-tables'] : [name];
        assert.deepEqual(previousReceipts.map(r => `${r.suite}/${r.engine}`).sort(),
          expected.flatMap(s => ['chromium','firefox','webkit'].map(e => `${s}/${e}`)).sort());
        assert.equal(previousReceipts.reduce((n,r) => n+r.counts.executed,0), old.counts.executed);
      }
    }
    catch (error) {
      reusable = false;
      (execution.reuseRejections ??= []).push({ name, reason: error.message, originalExecution: join(resumeDirectory, 'execution.json') });
    }
    const relevant = new Set([...Object.keys(runtime), ...previousReceipts.flatMap(r => Object.keys(json(r.path).sources))]);
    if (['parsing-vectors','editing-primitives'].includes(name)) for (const p of Object.keys(json(resolve(resolve(resumeDirectory,old.log),'..',name,'receipt.json')).sources)) relevant.add(p);
    const log = resolve(resumeDirectory, old.log);
    if (reusable && [...relevant].every(p => sources[p] === oldSources[p]) && hash(readFileSync(log)) === old.sha256) {
      valid(old.counts); acceptedReceipts.push(...previousReceipts);
      execution.commands.push({ ...old, invalid: undefined, log, mode: 'exact-input-reuse',
        ...(old.invalid ? { originalAccountingFailure: old.invalid, recoveredReceipts: resolve(process.env.EDITAC_WEB_EDITING_RECOVERED_PASTE) } : {}),
        originalExecution: join(resumeDirectory, 'execution.json') });
      save('execution.json', execution); continue;
    }
  }
  const directory = join(output, name), log = name + '.log';
  const fd = openSync(join(output, log), 'wx'); let result;
  try {
    result = spawnSync(program, args, { stdio: ['ignore', fd, fd], env: {
      ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output,
      ['EDITAC_' + name.toUpperCase().replaceAll('-', '_') + '_OUTPUT']: directory,
      ...(name === 'spellcheck' ? { EDITAC_EXTENSION_DX_OUTPUT: directory } : {}),
      ...(name === 'interaction-paste' ? { EDITAC_INTERACTION_PASTE_TABLES_OUTPUT: join(directory, 'tables') } : {}),
      ...(name === 'parsing-vectors' ? { EDITAC_PARSING_VECTORS_OUTPUT: directory } : {}),
      ...(name === 'editing-primitives' ? {
        CARGO_TARGET_DIR: resolve('target'), EDITAC_BLOCK_COMMAND_EXCHANGE: join(directory, 'block-command-exchange'),
        EDITAC_STABLE_JOIN_EXCHANGE: join(directory, 'stable-join-exchange'),
        EDITAC_HISTORY_EXCHANGE: join(directory, 'history-exchange'),
        EDITAC_STABLE_EDITOR_EXCHANGE: join(directory, 'stable-editor-exchange'),
      } : {}),
    } });
  } finally { closeSync(fd); }
  const entry = { name, program, args, log, exit: result.status,
    signal: result.signal, error: result.error?.message, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(entry); save('execution.json', execution);
  try {
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
    if (name === 'spellcheck') {
      const dispatch = json(join(directory, 'dispatch-receipt.json'));
      assert.equal(dispatch.runs.length, 3);
      entry.counts = dispatch.runs.reduce((n, r) => {
        assert.equal(r.status, 0); valid(r.counts);
        for (const k of Object.keys(n)) n[k] += r.counts[k] ?? 0; return n;
      }, zero());
    } else if (name === 'editing-primitives') {
      const text = readFileSync(join(output, log), 'utf8');
      const rows = [...text.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
      assert.equal(rows.length, 3);
      entry.counts = rows.reduce((n,r) => { n.passed += Number(r[2]); n.failed += Number(r[3]); n.skipped += Number(r[4]); n.executed += Number(r[2])+Number(r[3])+Number(r[4]); return n; }, zero());
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ program, args, exit: result.status, counts: entry.counts, sources }, null, 2)+'\n');
    } else if (name === 'parsing-vectors') {
      const vectors = json(join(directory, 'receipt.json')); verifyPins(vectors.sources);
      assert.equal(vectors.exit, 0);
      entry.counts = { ...zero(), ...vectors.counts, executed: vectors.counts.passed + vectors.counts.failed + vectors.counts.skipped };
    } else entry.counts = tapCounts(readFileSync(join(output, log), 'utf8'));
    valid(entry.counts);
    if (!['parsing-vectors','editing-primitives'].includes(name)) {
      const cells = browserReceipts(directory);
      const expected = name === 'interaction-paste' ? ['interaction-paste', 'interaction-paste-tables'] : [name];
      assert.deepEqual(cells.map(r => `${r.suite}/${r.engine}`).sort(),
        expected.flatMap(s => ['chromium','firefox','webkit'].map(e => `${s}/${e}`)).sort());
      assert.equal(cells.reduce((n, r) => n + r.counts.executed, 0), entry.counts.executed);
      acceptedReceipts.push(...cells);
    }
  } catch (error) {
    entry.invalid = error.message; execution.failures.push(name);
    if (!entry.counts && name !== 'spellcheck' && !['parsing-vectors','editing-primitives'].includes(name)) {
      try { entry.counts = tapCounts(readFileSync(join(output, log), 'utf8')); } catch { /* Preserve setup failure. */ }
    }
  }
  save('execution.json', execution);
}
assert.deepEqual(sourcePins(), sources, 'Sources changed during execution'); verifyPins(members);
execution.receipts = acceptedReceipts;
const sum = commands => commands.reduce((n, c) => { for (const key of Object.keys(n)) n[key] += c.counts?.[key] ?? 0; return n; }, zero());
execution.counts = sum(execution.commands); execution.freshCounts = sum(execution.commands.filter(c => !c.mode));
execution.reusedCounts = sum(execution.commands.filter(c => c.mode));
Object.assign(execution, { finished: new Date().toISOString(), sourcesUnchanged: true });
save('execution.json', execution);
assert.deepEqual(execution.failures, [], 'Repair failed original boundaries before binding');
console.log(JSON.stringify({ counts: execution.counts, receipts: acceptedReceipts.length, sourcePins: Object.keys(sources).length }));
