import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { cargoLock, npmLock, checkInventory, validateInventory, checkAdvisories, families } from '../../../scripts/dependency-inventory.mjs';
import { selectSuite } from '../../../scripts/check-architecture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let inventory, policy;
before(async () => {
  assert(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'Canonical output required');
  policy = JSON.parse(await readFile(join(root, 'licenses/policy.json')));
  inventory = await checkInventory(root);
  await writeFile(join(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT), 'dependencies-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
});
test('complete current lock/archive/distribution/notice inventory matches reviewed identities', () => {
  validateInventory(inventory, policy);
  assert(inventory.cargo.length > 100 && inventory.npm.length > 300 && inventory.gradle.length > 0);
  assert(inventory.noticeCount > 100);
});
test('Cargo lock parser retains duplicate-version identity and exact checksums', () => {
  const lock = cargoLock('version = 4\n[[package]]\nname = "same"\nversion = "1.0.0"\nsource = "registry+x"\nchecksum = "aaa"\n[[package]]\nname = "same"\nversion = "2.0.0"\nsource = "registry+x"\nchecksum = "bbb"');
  assert.equal(lock.length, 2); assert.equal(lock[0].checksum, 'aaa'); assert.equal(lock[1].version, '2.0.0');
});
test('npm adapter excludes workspace aliases but retains optional platform packages', () => {
  const records = npmLock({ lockfileVersion: 3, packages: { '': {}, 'node_modules/local': { link: true }, 'node_modules/@vendor/optional': { version: '1.2.3', resolved: 'https://registry.invalid/archive', integrity: 'sha512-aA==', license: 'MIT', optional: true } } });
  assert.equal(records.length, 1); assert.equal(records[0].name, '@vendor/optional'); assert.equal(records[0].optional, true);
});
for (const field of ['version', 'resolved', 'integrity', 'license']) test(`npm missing ${field} fails closed`, () => {
  const p = { version: '1.0.0', resolved: 'https://registry.invalid/archive', integrity: 'sha512-aA==', license: 'MIT' }; delete p[field];
  assert.throws(() => npmLock({ lockfileVersion: 3, packages: { 'node_modules/test': p } }), /Incomplete npm/);
});
test('unknown lock version fails', () => assert.throws(() => npmLock({ lockfileVersion: 99, packages: {} }), /Unsupported/));
const fixtures = JSON.parse(await readFile(new URL('./fixtures/missing-notice.json', import.meta.url)));
for (const fixture of fixtures.cases) test(`negative fixture: ${fixture.ecosystem}/${fixture.name}/${fixture.change}`, () => {
  const bad = structuredClone(inventory), component = bad[fixture.ecosystem].find(p => p.name === fixture.name);
  assert(component?.redistributed, 'Negative must hit a real distribution component');
  if (fixture.change === 'remove-text') component.notices = [];
  else { component.noticeState = 'unavailable'; component.notices = []; component.reason = 'upstream license unavailable'; }
  assert.throws(() => validateInventory(bad, policy), /Missing/);
});
for (const family of families) test(`omitted optional ${family} inventory rejects`, () => {
  const bad = structuredClone(inventory); delete bad.families[family];
  assert.throws(() => validateInventory(bad, policy), /Optional family omitted/);
});
test('artifact hash mismatch rejects', () => {
  const bad = structuredClone(inventory); bad.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateInventory(bad, policy), /Artifact identity differs/);
});
test('omitted packed distribution rejects', () => {
  const bad = structuredClone(inventory); bad.artifacts.pop();
  assert.throws(() => validateInventory(bad, policy), /Artifact inventory differs/);
});
test('omitted measured artifact inventory rejects', () => {
  const bad = structuredClone(inventory); bad.measuredArtifacts = [];
  assert.throws(() => validateInventory(bad, policy), /Missing measured artifact inventory/);
});
test('missing native checksum rejects', () => {
  const bad = structuredClone(inventory); bad.cargo[0].checksum = null;
  assert.throws(() => validateInventory(bad, policy), /Missing Cargo checksum/);
});
test('missing embedded SQLite notice rejects', () => {
  const bad = structuredClone(inventory); bad.embedded[0].notices = [];
  assert.throws(() => validateInventory(bad, policy), /Missing embedded/);
});
test('changed embedded SQLite revision rejects', () => {
  const bad = structuredClone(inventory); bad.embedded[0].revision = 'unreviewed';
  assert.throws(() => validateInventory(bad, policy), /Embedded component identity differs/);
});
test('pending grammar/media/font families cannot become supported claims', () => {
  const bad = structuredClone(inventory); bad.families.grammar.state = 'included';
  assert.throws(() => validateInventory(bad, policy), /Reviewed family scope differs/);
});
test('update ownership is required', () => {
  const bad = structuredClone(inventory); bad.npm[0].owner = null;
  assert.throws(() => validateInventory(bad, policy), /Missing component/);
});
test('explicit unavailable advisory source remains an honest maintenance result', () => {
  checkAdvisories(inventory.advisories, inventory.advisories.locks);
  assert.equal(inventory.advisories.sources.cargo.state, 'unavailable');
  assert.equal(inventory.advisories.sources.gradle.state, 'unavailable');
  assert.equal(inventory.advisories.sources.npm.findings, 0);
});
test('advisory lock drift rejects', () => {
  assert.throws(() => checkAdvisories(inventory.advisories, { cargo: 'changed', npm: inventory.advisories.locks.npm }), /Advisory input drift/);
});
test('advisory findings cannot be laundered into zero findings', () => {
  const bad = structuredClone(inventory.advisories); bad.sources.npm.findings = 1;
  assert.throws(() => checkAdvisories(bad, bad.locks), /Advisory findings/);
});
test('unavailable advisory needs a concrete release action', () => {
  const bad = structuredClone(inventory.advisories); delete bad.sources.cargo.releaseAction;
  assert.throws(() => checkAdvisories(bad, bad.locks), /release action/);
});
test('tooling/host peers with missing notices remain unqualified for bundling', () => {
  const unavailable = inventory.npm.filter(p => p.noticeState === 'unavailable');
  assert(unavailable.length > 0); assert(unavailable.every(p => !p.redistributed && p.reason));
  const bad = structuredClone(inventory); bad.npm.find(p => p.noticeState === 'unavailable').redistributed = true;
  assert.throws(() => validateInventory(bad, policy), /Missing notice/);
});
test('dispatcher registers this nonzero suite and rejects unknown/empty selections', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'contracts/layers.json')));
  assert.equal(selectSuite(manifest, ['--suite', 'dependencies']).tests.length, 1);
  assert.throws(() => selectSuite(manifest, ['--suite', 'not-a-suite']), /registered/);
  assert.throws(() => selectSuite({ suites: { empty: { tests: [] } } }, ['--suite', 'empty']), /Zero/);
});
