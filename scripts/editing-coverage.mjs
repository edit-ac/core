import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSuite } from '../tests/editing/fixture-loader.ts';
import { runtimeGroups } from './editing-suites.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function walk(path) {
  return readdirSync(path).sort().flatMap(name => {
    const p = join(path, name); return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
export function sourcePins(root) {
  const files = ['Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json', '.node-version',
    ...['scripts', '.github/workflows', 'tests/editing', 'tests/browser', 'fixtures', 'examples'].flatMap(p => walk(join(root, p)).map(f => relative(root, f))),
    ...readdirSync(join(root, 'crates')).flatMap(p => walk(join(root, 'crates', p)).filter(f => !f.includes('/target/')).map(f => relative(root, f))),
    ...readdirSync(join(root, 'packages')).flatMap(p => walk(join(root, 'packages', p, 'src')).map(f => relative(root, f)))];
  return Object.fromEntries([...new Set(files)].sort().map(p => [p, hash(readFileSync(join(root, p)))]));
}
export const requiredStages = [...runtimeGroups, 'history-selection', 'baseline', 'integrity'];
export function tapCounts(text) {
  const summaries = [...text.matchAll(/^# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)/gm)];
  assert.ok(summaries.length, 'missing executed test summary');
  return summaries.reduce((a, m) => {
    for (const [i, key] of ['executed','passed','failed','cancelled','skipped','todo'].entries()) a[key] += Number(m[i + 1]);
    return a;
  }, { executed: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
}
function localArtifact(directory,path) {
  assert.equal(typeof path,'string'); const target=resolve(directory,path);
  assert.ok(relative(directory,target)&&!relative(directory,target).startsWith('..')&&!path.startsWith('/'),'artifact escapes evidence directory');
  return target;
}
const positive = n => Number.isSafeInteger(n) && n > 0;
function rows(report) { return report.cases ?? []; }
const passed = c => c.status === 'passed' || c.passed === true;
const observed = c => c.assertions !== 0 && (positive(c.checkpoints) || positive(c.assertions) || positive(c.negativeControls) || c.snapshots?.length > 0);
function controls(report) {
  return (report.negativeControls?.length ?? 0) + rows(report).reduce((n,c) => n + (typeof c.negativeControls === 'number' ? c.negativeControls : c.negativeControls?.length ?? 0), 0);
}
// Bind to owning executed cells, never to recipe covers or catalog metadata.
const binding = (stage, pattern, negative = false) => ({ stage, pattern, negative });
export const mandatoryBindings = {
  'REG-01': [binding('history', '^REG-01/'), binding('history-selection', '^heading-end-history-selection$')],
  'REG-02': [binding('history', '^REG-02/')], 'REG-03': [binding('history', '^REG-03/')], 'REG-04': [binding('history', '^REG-04/')],
  'REG-05': [binding('semantic', 'REG-05')], 'REG-06': [binding('semantic', 'REG-06')], 'REG-07': [binding('semantic', 'REG-07')],
  'REG-08': [binding('properties', '^native/editac-core$')],
  'REG-09': [binding('presenters', '^(tag-|custom-)')], 'REG-10': [binding('presenters', '^nested-')],
  'REG-11': [binding('presenters', 'drop')], 'REG-12': [binding('failures', '^REG-12-')],
  'REG-13': [binding('semantic', 'REG-13')], 'REG-14': [binding('input', '^REG-14-')],
  'REG-15': [binding('failures', '^(disposed-adapters|new-session)$')], 'REG-16': [binding('input', '^REG-16-')],
  'REG-17': [binding('presenters', '^atom-')],
  G01: [binding('input', '^REG-16-', true)], G02: [binding('semantic', '^G02/G03/G04/G06 independent', true)],
  G03: [binding('semantic', '^G02/G03/G04/G06 independent', true)], G04: [binding('semantic', '^G02/G03/G04/G06 independent', true)],
  G05: [binding('input', '^G05-dispatcher', true)], G06: [binding('semantic', '^G02/G03/G04/G06 independent', true)],
  G07: [binding('history', '^G07/actual-merged-paste', true)], G08: [binding('failures', '^REG-12-', true)],
  G09: [binding('input', '^G09-', true)], G10: [binding('properties', '^native/editac-core$')],
  G11: [binding('failures', '^G11-', true)], G12: [binding('presenters', '^profile-', true), binding('presenters', '^nested-', true), binding('presenters', 'drop', true)],
  G13: [binding('presenters', '^tag-', true), binding('presenters', '^custom-', true)], G14: [binding('integrity', '^G14')],
};
// Explicit dependency proof for a local resume. Fixture/engine/adapter/profile
// changes never reuse execution. Only the all-run orchestrator/receipt consumer
// and the independent example page may differ for these eight owning stages.
export function reusableStage(name, origin, current) {
  if(!['fixtures','semantic','history','properties','failures','input','presenters','history-selection','baseline'].includes(name))return false;
  if(JSON.stringify(origin.fixturePins)!==JSON.stringify(current.fixturePins)||JSON.stringify(origin.artifactPins)!==JSON.stringify(current.artifactPins)||origin.node!==current.node||origin.playwright!==current.playwright)return false;
  const allowed=new Set(['scripts/run-editing-all.mjs','scripts/editing-coverage.mjs','scripts/check-editing-coverage.mjs','tests/editing/coverage.test.mjs','tests/editing/README.md','examples/web/index.html']);
  if(name==='baseline') allowed.delete('examples/web/index.html');
  return [...new Set([...Object.keys(origin.sourcePins),...Object.keys(current.sourcePins)])].every(path=>origin.sourcePins[path]===current.sourcePins[path]||allowed.has(path));
}
export function verifyCoverage(receipt, { root, directory, suite = loadSuite() }) {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.profile, 'infrastructure');
  assert.equal(receipt.node, 'v24.19.0'); assert.equal(process.version,receipt.node);
  assert.equal(receipt.playwright,json(resolve(root,'node_modules/playwright/package.json')).version);
  const installed=json(resolve(root,'node_modules/playwright-core/browsers.json')).browsers;
  for(const engine of ['chromium','firefox','webkit']) assert.equal(receipt.browserVersions[engine],installed.find(b=>b.name===engine).browserVersion,'incorrect platform revision'); assert.equal(receipt.deployed, false);
  assert.deepEqual(receipt.sourcePins, sourcePins(root), 'stale or fabricated implementation revision');
  assert.deepEqual(receipt.fixturePins, suite.hashes, 'stale fixture/profile/expected state');
  assert.equal(receipt.builds.length,2,'missing current-source build');
  for(const name of ['build-wasm','build']) {const build=receipt.builds.find(b=>b.name===name);assert.ok(build);assert.equal(build.exit,0);assert.equal(hash(readFileSync(localArtifact(directory,build.log))),build.logSha256);}
  assert.equal(receipt.packBuild.exit,0);assert.equal(hash(readFileSync(localArtifact(directory,receipt.packBuild.log))),receipt.packBuild.logSha256);
  assert.equal(hash(readFileSync(localArtifact(directory,receipt.pack.path))),receipt.pack.sha256,'fabricated executed package');
  assert.equal(receipt.stages.length, requiredStages.length, 'missing/duplicate stage');
  if(receipt.sharedPackages) {
    const path=localArtifact(directory,receipt.sharedPackages.path);assert.equal(hash(readFileSync(path)),receipt.sharedPackages.sha256);
    const packages=json(path);
    for(const name of ['core','web','markdown']) {assert.equal(packages[name].manifest.name,`@edit-ac/${name}`);assert.equal(hash(readFileSync(packages[name].path)),packages[name].sha256);}
  }
  const reports = new Map();
  let origin;
  if(receipt.reuse) {const bytes=readFileSync(receipt.reuse.path);assert.equal(hash(bytes),receipt.reuse.sha256,'fabricated resume origin');origin=JSON.parse(bytes);}
  for (const name of requiredStages) {
    const stage = receipt.stages.find(s => s.name === name); assert.ok(stage, `missing ${name}`);
    assert.equal(stage.exit, 0, `${name} failed`);
    if(stage.reused) {assert.ok(origin);assert.ok(reusableStage(name,origin,receipt),'stale execution cannot be rebound');
      const old=origin.stages.find(s=>s.name===name);assert.ok(old);assert.equal(old.exit,0);assert.equal(stage.logSha256,old.logSha256);assert.deepEqual(stage.reports,old.reports);assert.deepEqual(stage.counts,old.counts);}
    const log = readFileSync(localArtifact(directory, stage.log)); assert.equal(hash(log), stage.logSha256, 'fabricated log');
    const counts = tapCounts(log.toString()); assert.deepEqual(stage.counts, counts, 'fabricated counts');
    assert.ok(positive(counts.executed)); assert.equal(counts.passed, counts.executed);
    for (const k of ['failed','skipped','cancelled','todo']) assert.equal(counts[k], 0, `mandatory ${name} ${k}`);
    const data = [];
    for (const artifact of stage.reports) {
      const bytes = readFileSync(localArtifact(directory, artifact.path)); assert.equal(hash(bytes), artifact.sha256, 'fabricated report');
      const r = JSON.parse(bytes); if (!r.cases) continue;
      if (name === 'baseline') {
        assert.ok(r.browser, 'missing baseline platform');
        assert.equal(r.browser.version, receipt.browserVersions[r.browser.engine], 'incorrect baseline platform revision');
        if (r.browser.node) assert.equal(r.browser.node, receipt.node);
        if (r.browser.playwright) assert.equal(r.browser.playwright, receipt.playwright);
        for (const [p,h] of Object.entries(r.sources ?? {})) assert.equal(hash(readFileSync(resolve(root,p))),h, `stale baseline ${p}`);
        if(r.counts) {assert.equal(r.counts.executed,r.cases.length);assert.equal(r.counts.passed,r.cases.length);assert.equal(r.counts.failed,0);assert.equal(r.counts.skipped,0);}
        assert.ok(r.cases.length > 0); assert.ok(r.cases.every(passed), 'failed baseline case');
        assert.equal(r.cleanup.browserExited,true); assert.equal(r.cleanup.listenerRemoved,true);
        if (r.packed) assert.equal(hash(readFileSync(resolve(directory,artifact.path,'..',r.packed.filename))),r.packed.sha256);
        data.push(r); continue;
      }
      if (!r.counts) continue;
      assert.equal(r.counts.executed, r.cases.length); assert.ok(positive(r.counts.executed));
      assert.equal(r.counts.passed, r.cases.filter(passed).length); assert.equal(r.counts.passed, r.counts.executed);
      assert.equal(r.counts.failed, 0); assert.equal(r.counts.skipped, 0);
      for (const c of r.cases) assert.ok(observed(c), `${name}/${c.id ?? c.name} has zero assertions/observations`);
      for (const [p,h] of Object.entries(r.sources ?? r.sourceHashes ?? {})) assert.equal(hash(readFileSync(resolve(root,p))),h, `stale ${p}`);
      if (r.fixtureHashes ?? r.binding?.fixtureHashes) assert.deepEqual(r.fixtureHashes ?? r.binding.fixtureHashes,suite.hashes);
      if (r.profileSha256 && typeof r.profile === 'object') assert.ok(/^[a-f0-9]{64}$/.test(r.profileSha256));
      if (r.runtime) { assert.equal(r.runtime.pack.sha256,receipt.pack.sha256,'wrong executed package'); assert.equal(r.runtime.serverClosed,true); assert.equal(r.runtime.temporaryPackageRemoved,true); }
      if (r.browser) {
        assert.equal(r.browser.node, receipt.node); assert.equal(r.browser.engine,r.engine);
        assert.equal(r.browser.playwright, receipt.playwright); assert.equal(r.browser.version,receipt.browserVersions[r.engine]);
        for (const key of ['browserExited','serverClosed','consumerRemoved']) assert.equal(r.cleanup[key], true);
        for (const p of r.packs) assert.equal(hash(readFileSync(resolve(directory,artifact.path,'..',p.file))),p.sha256);
      }
      data.push(r);
    }
    reports.set(name,data);
    if (!['fixtures','baseline','integrity'].includes(name)) assert.equal(data.reduce((n,r)=>n+r.cases.length,0)+(name==='semantic'?3:0),counts.executed,'missing/fabricated case report');
    if (name === 'baseline') {
      assert.equal(data.length,9,'missing baseline renderer/keyboard/example report');
      assert.equal(data.reduce((n,r)=>n+r.cases.length,0),counts.executed,'missing/fabricated baseline case report');
      for (const engine of ['chromium','firefox','webkit']) assert.equal(data.filter(r=>r.browser.engine===engine).length,3);
    }
    if (['input','presenters','history-selection'].includes(name)) assert.deepEqual(data.map(r=>r.engine).sort(),['chromium','firefox','webkit']);
  }
  for (const [p,h] of Object.entries(receipt.artifactPins)) assert.equal(hash(readFileSync(resolve(root,p))),h,'stale built artifact');
  assert.ok(Object.keys(receipt.artifactPins).some(p=>p.endsWith('.wasm')),'missing executed WASM');
  const matched = (id,b) => {
    const data = reports.get(b.stage); const re = new RegExp(b.pattern);
    const matches = data.flatMap(r => rows(r).filter(c => re.test(c.id ?? c.name)).map(c=>({r,c})));
    if (b.stage === 'integrity') {
      const stage = receipt.stages.find(s=>s.name==='integrity');
      const log = readFileSync(localArtifact(directory,stage.log),'utf8');
      assert.ok([...log.matchAll(/^ok \d+ - G14 rejects /gm)].length >= 11,'missing executed G14 rejection controls');
      assert.match(log,/^ok \d+ - G14 wrong independent expected state/m); return;
    }
    assert.ok(matches.length, `missing actual ${id} cell`);
    if (b.negative) assert.ok(matches.some(({r,c}) => controls(r)>0 || /fault/.test(c.id)),`missing negative control ${id}`);
    if (b.stage === 'properties' && ['REG-08','G10'].includes(id)) assert.ok(matches.some(({c}) => c.trace?.some(t => t.case?.includes(id))),`missing native ${id} trace`);
  };
  const evidence = {};
  for (const [id,bindings] of Object.entries(mandatoryBindings)) {
    for (const b of bindings) matched(id,b);
    evidence[id] = bindings.map(b=>({stage:b.stage,layer:b.stage==='integrity'?'receipt-integrity': ['input','presenters','history-selection'].includes(b.stage)?'browser-mechanics':'packed/native',
      cells:(reports.get(b.stage)??[]).flatMap(r=>r.cases.filter(c=>new RegExp(b.pattern).test(c.id??c.name)).map(c=>({id:c.id??c.name,engine:r.engine??null,checkpoints:c.checkpoints??null,assertions:c.assertions??null,snapshots:c.snapshots?.length??0,negativeControls:typeof c.negativeControls==='number'?c.negativeControls:c.negativeControls?.length??null,nativeCounts:c.counts??null}))) }));
  }
  const integrity=receipt.stages.find(s=>s.name==='integrity');
  evidence.G14[0].cells=[...readFileSync(localArtifact(directory,integrity.log),'utf8').matchAll(/^ok \d+ - (G14[^\n]*)/gm)].map(m=>({id:m[1],executed:1,passed:1,layer:'prepared receipt integrity',assertions:null}));
  const propertyCases=(reports.get('properties')??[]).flatMap(r=>r.cases);
  assert.ok(propertyCases.some(c=>c.trace?.some(t=>/G10.*(negative-controls|oscillation-control)/.test(t.case))),'missing normalization negative control');
  for (const recipe of suite.recipes) {
    const stage = recipe.id === 'SEQ-08' ? 'history' : recipe.id === 'SEQ-09' ? 'failures' : recipe.id === 'SEQ-10' ? 'input' : 'semantic';
    matched(recipe.id,binding(stage,`^${recipe.id}$`));
  }
  // Do not manufacture source-clause/device completeness from representative traces.
  return { evidence, profile: 'infrastructure', state: 'passed', recipes: suite.recipes.map(r=>r.id),
    regressions: Object.keys(mandatoryBindings).filter(id=>id.startsWith('REG-')), guards: suite.manifest.guards.map(g=>g.id),
    catalogs: suite.catalogs.map(row=>({...row,status:'planned',layer: row.path.includes('mobile-web')?'browser/platform':row.path.includes('mobile-extension')?'extension/platform':row.path.includes('desktop')||row.path.includes('native')?'native/platform':row.path.includes('regression')?'owning-regression':'editor/adapters',commonSuiteEvidence: row.id.startsWith('REG-') ? 'passed' : 'unexecuted',variantCompleteness:'unqualified',physicalObservations:0,virtualPlatformObservations:0})),
    counts: receipt.stages.map(({name,counts,reused})=>({name,...counts,reused:reused===true})), releaseQualified:false,
    limits:'Actual common-driver infrastructure evidence; source-clause, platform, preset, performance and release qualification remain with their owners.' };
}
