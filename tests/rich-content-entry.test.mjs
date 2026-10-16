import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workspace = new URL('../../', import.meta.url);
const bytes = path => readFile(new URL(path, workspace));
const json = async path => JSON.parse(await bytes(path));
const hash = value => createHash('sha256').update(value).digest('hex');
const map = await json('core/fixtures/rich-content/entry-map.json');
const prerequisites = await json('core/fixtures/rich-content/prerequisites.json');
const features = ['code', 'tables', 'assets', 'images', 'files', 'embeds', 'slash', 'references', 'reorder', 'search', 'formatting'];

function validateMap(value) {
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.parent, 'RCH-1.1');
  assert.deepEqual(value.features.map(feature => feature.id), features);
  const parents = new Set(value.commonContracts.handoffParents);
  for (const feature of value.features) {
    for (const field of ['owners', 'reuse', 'publicPorts', 'gaps', 'optionalDependencies']) {
      assert.ok(feature[field].length > 0, `${feature.id}: ${field}`);
    }
    assert.match(feature.platformOwner, /roadmaps31–36/);
    for (const owner of feature.owners) {
      assert.ok(value.sourceHashes[owner.path], `hashed owner ${owner.path}`);
      assert.match(owner.symbol, /^[A-Za-z][A-Za-z0-9_]*$/u);
    }
    for (const port of feature.publicPorts) {
      assert.ok(['@edit-ac/core', '@edit-ac/web'].includes(port.package));
      assert.ok(['existing', 'planned'].includes(port.status));
      assert.match(port.export, /^\.\/(extensions|modules|math|links)$/u);
      assert.ok(port.symbol.length > 0);
    }
    for (const gap of feature.gaps) {
      assert.match(gap.parent, /^RCH-1\.(?:[2-9]|1[0-9]|2[0-3])$/u);
      assert.ok(gap.behavior.length > 20, `${feature.id}: concrete missing behavior`);
      parents.add(gap.parent);
    }
  }
  assert.deepEqual([...parents].sort(), Array.from({ length: 22 }, (_, i) => `RCH-1.${i + 2}`).sort());
  for (const path of Object.keys(value.sourceHashes)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), path);
  }
}

test('RCH-1.1 maps every rich-content feature and remaining parent to its owning boundary', () => {
  validateMap(map);
  assert.match(map.scope, /not rich-feature runtime or release qualification/);
  assert.match(map.commonContracts.sharedApis, /PRIMARY owns/);
});

for (const feature of map.features) test(`${feature.id}: existing symbols and public ports resolve without private consumer paths`, async () => {
  for (const owner of feature.owners) {
    const source = (await bytes(`core/${owner.path}`)).toString();
    assert.match(source, new RegExp(`\\b(?:struct|enum|class|interface|type|function|const)\\s+${owner.symbol}\\b`), owner.path);
  }
  for (const port of feature.publicPorts.filter(port => port.status === 'existing')) {
    const pkg = port.package.split('/')[1];
    const manifest = await json(`core/packages/${pkg}/package.json`);
    assert.ok(manifest.exports[port.export], `${port.package}${port.export.slice(1)}`);
    const file = port.export === './math' ? 'packages/web/src/modules/math.ts'
      : port.export === './links' ? 'packages/web/src/modules/links/index.ts'
      : `packages/${pkg}/src/${pkg === 'core' ? 'extensions' : 'modules'}/index.ts`;
    assert.match((await bytes(`core/${file}`)).toString(), new RegExp(`\\b${port.symbol}\\b`), port.symbol);
  }
});

test('source and contract identities freeze this map without qualifying historical built output', async () => {
  for (const [prefix, entries] of [['core', map.sourceHashes], ['architecture', map.contracts]]) {
    assert.ok(Object.keys(entries).length > 0);
    for (const [path, digest] of Object.entries(entries)) assert.equal(hash(await bytes(`${prefix}/${path}`)), digest, path);
  }
});

test('optional processing remains outside the semantic engine and minimum presenter path', async () => {
  const engine = (await bytes('core/crates/editac-core/Cargo.toml')).toString();
  assert.doesNotMatch(engine, /(?:tree-sitter|editac-highlighting|katex)/u);
  const index = (await bytes('core/packages/web/src/modules/index.ts')).toString();
  assert.doesNotMatch(index, /from ['"](?:katex|.*math-renderer).*['"]/u);
  const web = await json('core/packages/web/package.json');
  assert.equal(web.devDependencies.katex, '0.19.0');
  assert.ok(map.features.find(feature => feature.id === 'code').optionalDependencies.some(text => text.includes('independent companion')));
  assert.ok(map.features.find(feature => feature.id === 'assets').optionalDependencies.some(text => text.includes('Host owns')));
});

function measuredCounts(text) {
  const count = key => [...text.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, 'gmu'))].reduce((sum, match) => sum + Number(match[1]), 0);
  if (/^(?:#|ℹ) tests \d+$/mu.test(text)) {
    return { executed: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
  }
  const rows = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gu)];
  assert.ok(rows.length, 'historical log must contain executed-case counts');
  const sum = index => rows.reduce((total, row) => total + Number(row[index]), 0);
  return { executed: sum(1) + sum(2) + sum(3), passed: sum(1), failed: sum(2), skipped: sum(3) };
}

test('five upstream owners retain hashed nonzero passing semantic receipts with explicit reuse limits', async () => {
  assert.deepEqual(prerequisites.entries.map(entry => entry.roadmap), ['05', '07', '12', '13', '21']);
  for (const entry of prerequisites.entries) {
    assert.match(entry.reuse, /historical.*no full current platform\/release claim/u);
    assert.equal(hash(await bytes(entry.receipt)), entry.sha256, entry.receipt);
    assert.ok(entry.checks.length > 0);
    for (const check of entry.checks) {
      const log = await bytes(check.log);
      assert.equal(hash(log), check.sha256, check.log);
      const observed = measuredCounts(log.toString());
      assert.ok(observed.executed > 0);
      assert.equal(observed.passed, observed.executed);
      assert.equal(observed.failed, 0);
      assert.equal(observed.skipped, 0);
      for (const key of Object.keys(observed)) assert.equal(observed[key], check[key], `${check.log}: ${key}`);
    }
  }
  assert.ok(prerequisites.limits.some(text => text.includes('EXT-1.13')));
});

test('mapping guards reject omitted features, unowned symbols, missing gaps and claimed private ports', () => {
  for (const mutate of [
    value => value.features.pop(),
    value => value.features[0].owners.push({ path: 'unowned.ts', symbol: 'Unknown' }),
    value => { value.features[0].gaps = []; },
    value => { value.features[0].optionalDependencies = []; },
    value => { value.features[0].publicPorts[0].export = './src/private'; },
    value => { value.features[0].gaps[0].parent = 'RCH-2.1'; },
    value => { value.features[0].platformOwner = 'already qualified everywhere'; },
  ]) {
    const invalid = structuredClone(map);
    mutate(invalid);
    assert.throws(() => validateMap(invalid));
  }
});
