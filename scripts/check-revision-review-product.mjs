import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const groups = Object.freeze(['capture', 'compare', 'scope', 'restore', 'conflicts', 'reopen', 'keyboard', 'integrated']);
const engines = ['chromium', 'firefox', 'webkit'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => assert.match(value, /^[a-f0-9]{64}$/);
const unique = (values, label) => assert.equal(new Set(values).size, values.length, `Duplicate ${label}`);

/** Exact case identities, rather than a summary or a nonzero exit alone. */
export function checkCoverage(receipt, scenario, group) {
  assert.equal(receipt.group, group); assert.equal(receipt.parent, scenario.parent);
  assert.deepEqual(receipt.command, ['node', 'tests/scenarios/revision-review-product.mjs', group]);
  assert.equal(receipt.exit, 0, `${group}: unsuccessful receipt`); assert.equal(receipt.failure, undefined);
  assert.equal(receipt.prepared, true); assert.equal(receipt.listenerStopped, true);
  const expected = engines.flatMap(engine => scenario.cases.map(id => `${engine}:${id}`)).sort();
  assert.ok(expected.length > 0); unique(scenario.cases, 'manifest cases');
  const actual = receipt.cases.map(c => { assert.equal(c.status, 'passed', `${group}: ${c.id}`); return `${c.engine}:${c.id}`; }).sort();
  unique(actual, 'case results'); assert.deepEqual(actual, expected, `${group}: incomplete original case coverage`);
  assert.equal(receipt.expected, expected.length);
  assert.deepEqual(receipt.counts, { executed: expected.length, passed: expected.length, failed: 0, skipped: 0 });
  if (receipt.selection) {
    assert.deepEqual(receipt.selection.engines, engines); assert.deepEqual(receipt.selection.notSelectedEngines, []);
    assert.deepEqual(receipt.selection.selectedCases, scenario.cases); assert.deepEqual(receipt.selection.notSelected, []);
    assert.equal(receipt.selection.fromCase, null); assert.equal(receipt.selection.throughCase, null);
  }
  unique(receipt.browsers.map(b => b.engine), 'browser records');
  assert.deepEqual(receipt.browsers.map(b => b.engine).sort(), [...engines].sort());
  for (const browser of receipt.browsers) {
    assert.equal(browser.closed, true); assert.equal(browser.failure, undefined); assert.deepEqual(browser.errors, []);
    assert.ok(browser.version); assert.ok(Object.keys(browser.oracles ?? {}).length > 0, 'Missing independent browser oracles');
  }
  for (const command of receipt.commands) assert.equal(command.exit, 0, 'Failed setup command');
}
const normalizePreparation = value => value.replace("'scripts/check-revision-review-product.mjs', ", '').replace("'scripts/run-web-command-reference-refresh-boundary.mjs', ", '');
const normalizeDispatcher = value => value
  .replace(/^import \{ integratedCases \} from '\.\/revision-review-integrated\.mjs';\n/m, '')
  .replace(', integrated: integratedCases', '');

/** Authenticate durable files, current committed main, compiled sources and exact
 * group behavior. Evidence reuse is only for unchanged group code/runtime bytes. */
export async function checkDelivery(deliveryPath, mainRoot) {
  const path = resolve(deliveryPath), base = dirname(path);
  const d = JSON.parse(await readFile(path));
  assert.equal(d.version, 'revision-review-product-delivery-v1');
  assert.ok(['complete', 'incomplete'].includes(d.state), 'Unknown delivery state');
  const git = (...args) => execFileSync('git', ['-C', resolve(mainRoot), ...args]);
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), d.main.coreCommit, 'Actual main HEAD changed');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim(), 'main', 'Expected the actual main checkout');
  const committed = p => git('show', `${d.main.coreCommit}:${p}`);
  const manifest = JSON.parse(committed('fixtures/product-scenarios/revision-review/manifest.json'));
  assert.deepEqual(Object.keys(manifest.scenarios).sort(), [...groups].sort(), 'All eight named groups required');
  const pinned = new Map();
  assert.ok(d.pins.core.length > 0); unique(d.pins.core.map(p => p.path), 'main pins');
  for (const pin of d.pins.core) {
    hash(pin.sha256); assert.equal(sha(committed(pin.path)), pin.sha256, `Committed main pin: ${pin.path}`);
    assert.equal(sha(await readFile(join(mainRoot, pin.path))), pin.sha256, `Dirty main pin: ${pin.path}`); pinned.set(pin.path, pin.sha256);
  }
  const load = async reference => {
    hash(reference.sha256); const p = resolve(base, reference.path), bytes = await readFile(p);
    assert.equal(sha(bytes), reference.sha256, `Evidence changed: ${reference.path}`); return { p, value: JSON.parse(bytes) };
  };
  const { value: canonical } = await load(d.installed);
  assert.equal(canonical.prepared, true); assert.equal(canonical.group, 'integrated');
  const artifactMap = new Map(canonical.artifacts.map(p => [p.path, p.sha256]));
  const packMap = Object.fromEntries(canonical.packs.map(p => [p.name, p.sha256]));
  assert.deepEqual(Object.keys(packMap).sort(), ['core', 'web']);
  assert.ok(canonical.artifacts.some(p => p.path.endsWith('/editac_wasm_bg.wasm')));
  for (const [path, digest] of canonical.sources.map(p => [p.path, p.sha256])) assert.equal(pinned.get(path), digest, `Missing final source pin: ${path}`);
  const { value: owner } = await load(d.ownerInputs);
  assert.ok(Object.keys(owner.sources).length > 0); assert.ok(Object.keys(owner.members).length > 0);
  for (const [path, digest] of Object.entries(owner.sources)) {
    if (path.startsWith('core/')) assert.equal(pinned.get(path.slice(5)), digest, `Compiled source not pinned: ${path}`);
    else {
      assert.ok(path.startsWith('architecture/')); const relative = path.slice(13);
      const bytes = execFileSync('git', ['-C', resolve(mainRoot, '../architecture'), 'show', `${d.main.architectureCommit}:${relative}`]);
      assert.equal(sha(bytes), digest, `Architecture source changed: ${path}`);
      assert.equal(sha(await readFile(resolve(mainRoot, '..', path))), digest, `Dirty architecture source: ${path}`);
    }
  }
  for (const name of ['core', 'web']) assert.equal(packMap[name], owner.archives[name].sha256);
  assert.equal(artifactMap.get('site/core/wasm/editac_wasm_bg.wasm'), owner.wasmSha256);
  unique(canonical.artifacts.map(p => p.path), 'runtime artifacts');
  for (const [member, pin] of Object.entries(owner.members)) {
    const [name, ...parts] = member.split('/');
    if (parts[0] === 'dist') assert.equal(artifactMap.get(`site/${name}/${parts.slice(1).join('/')}`), pin.sha256, `Owner runtime member: ${member}`);
  }
  for (const path of manifest.scenarios.integrated.fixtures) {
    assert.equal(artifactMap.get('site/fixture/' + path.split('/').at(-1)), pinned.get(path), `Fixture differs from committed source: ${path}`);
  }
  unique(d.groups.map(p => p.group), 'delivery groups'); assert.deepEqual(d.groups.map(p => p.group).sort(), [...groups].sort());
  const results = [];
  for (const ref of d.groups) {
    const { value: r } = await load(ref); const scenario = manifest.scenarios[ref.group]; checkCoverage(r, scenario, ref.group);
    assert.deepEqual(Object.fromEntries(r.packs.map(p => [p.name, p.sha256])), packMap, 'SDK archive drift');
    const site = r.sharedSite ? JSON.parse(await readFile(resolve(r.sharedSite.path))) : r;
    if (r.sharedSite) assert.equal(sha(await readFile(r.sharedSite.path)), r.sharedSite.sha256);
    for (const pack of r.packs) assert.equal(sha(await readFile(join(site.output, pack.file))), pack.sha256);
    for (const artifact of r.artifacts) {
      assert.equal(sha(await readFile(join(site.output, artifact.path))), artifact.sha256, `Runtime evidence changed: ${artifact.path}`);
      if (artifact.path === 'site/fixture/manifest.json') {
        const old = JSON.parse(await readFile(join(site.output, artifact.path)));
        assert.deepEqual(old.scenarios[ref.group], scenario, 'Original case/fixture definition changed');
      } else if (artifactMap.has(artifact.path)) assert.equal(artifact.sha256, artifactMap.get(artifact.path), `Served byte drift: ${artifact.path}`);
    }
    for (const artifact of canonical.artifacts.filter(a => a.path !== 'site/fixture/manifest.json'))
      assert.ok(r.artifacts.some(a => a.path === artifact.path && a.sha256 === artifact.sha256), `Missing final runtime member: ${artifact.path}`);
    for (const source of r.sources) {
      if (source.path === 'fixtures/product-scenarios/revision-review/manifest.json') continue; // Per-group exact definition above.
      if (/^tests\/scenarios\/revision-review-(capture|compare|scope|restore|conflicts|reopen|keyboard|integrated)\.mjs$/.test(source.path) && source.path !== `tests/scenarios/revision-review-${ref.group}.mjs`) continue;
      if (source.path === 'tests/scenarios/revision-review-product.mjs' && source.sha256 !== pinned.get(source.path)) {
        const old = git('show', `${r.sourceRevision}:${source.path}`);
        assert.equal(sha(old), source.sha256); assert.equal(normalizeDispatcher(old.toString()), normalizeDispatcher(committed(source.path).toString()), 'Dispatcher behavior changed');
      } else if (source.path === 'examples/task-editor/revision-review-prepare.mjs' && source.sha256 !== pinned.get(source.path)) {
        const old = git('show', `${r.sourceRevision}:${source.path}`);
        assert.equal(sha(old), source.sha256); assert.equal(normalizePreparation(old.toString()), normalizePreparation(committed(source.path).toString()), 'Preparation changed beyond the two noncompilation proof-script exemptions');
      } else assert.equal(source.sha256, pinned.get(source.path), `Affected source changed: ${source.path}`);
    }
    assert.ok(r.sources.some(s => s.path === `tests/scenarios/revision-review-${ref.group}.mjs`), 'Missing group source');
    const publicPaths = ['packages/core/src/index.ts', 'packages/core/src/engine.ts', 'packages/web/src/index.ts', 'packages/web/src/storage/owner.ts', 'packages/web/src/surface.ts', 'packages/web/src/review/history.ts', 'packages/web/src/review/model.ts', 'packages/web/src/review/view.ts', 'examples/task-editor/document.mjs'];
    assert.deepEqual(r.entry.publicInputs.map(p => p.path), publicPaths, 'Incomplete public recipe authentication');
    for (const p of r.entry.publicInputs) assert.equal(pinned.get(p.path), p.sha256, 'Public recipe drift');
    results.push({ group: ref.group, counts: r.counts, reuse: ref.group !== 'integrated' ? 'Evidence-only exact affected-input reuse' : 'Fresh integrated browser execution' });
  }
  const { value: integration } = await load(d.integration);
  assert.equal(integration.main, d.main.coreCommit); assert.equal(integration.exit, 0);
  assert.equal(integration.unrelatedBytesModesAndIndexPreserved, true);
  assert.equal(integration.primaryUntouched, true); assert.equal(integration.integrationLockHeld, true);
  const handoffBytes = await readFile(resolve(base, d.handoff.path)); assert.equal(sha(handoffBytes), d.handoff.sha256);
  assert.ok(handoffBytes.length > 0);
  assert.equal(d.state, 'complete', 'Delivery remains incomplete; prerequisites cannot be waived');
  return { state: 'complete', coreMain: d.main.coreCommit, groups: results, counts: results.reduce((a, r) => {
    for (const key of Object.keys(a)) a[key] += r.counts[key]; return a;
  }, { executed: 0, passed: 0, failed: 0, skipped: 0 }), scope: 'Local browser consumer only; no whole-alpha, native, provider, release or deployment claim' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, 'Usage: node scripts/check-revision-review-product.mjs DELIVERY_JSON ACTUAL_MAIN_CORE OUTPUT_JSON');
  let result;
  try { result = { exit: 0, ...await checkDelivery(process.argv[2], process.argv[3]) }; }
  catch (error) { result = { exit: 1, state: 'incomplete', error: error.message }; process.exitCode = 1; }
  await writeFile(resolve(process.argv[4]), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
}
