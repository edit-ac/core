import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hash } from '../../../scripts/architecture-layers.mjs';
import { compatibilityDecision, withCompatibleContract } from '../../../scripts/compatibility-policy.mjs';
import * as v4 from '../../../fixtures/schema-v4/mapping.mjs';
import * as v5 from '../../../fixtures/schema-v5/mapping.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
assert(output, 'canonical isolated output required'); mkdirSync(output, { recursive: true });
const read = path => readFileSync(resolve(root, path));
const json = path => JSON.parse(read(path));
const policy = json('fixtures/compatibility/policy.json');
const descriptor = json('fixtures/compatibility/descriptor.json');
const facts = { version: 1, qualification: 'exact portable source contracts; no native SDK/release/provider qualification', endpoints: policy.endpoints, commands: [], executables: {}, files: {}, cases: [] };
function command(label, executable, args, expectedTests) {
  const r = spawnSync(executable, args, { cwd: root, env: { ...process.env, EDITAC_COMPATIBILITY_OUTPUT: output }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(resolve(output, label + '.log'), text);
  const counts = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)].map(m => ({ passed: +m[1], failed: +m[2], skipped: +m[3] }));
  for (const match of text.matchAll(/Running .* \((target\/[^)]+)\)/g)) facts.executables[match[1]] = hash(read(match[1]));
  facts.commands.push({ label, command: [executable, ...args], exit: r.status, error: r.error?.message ?? null, counts, log: label + '.log', sha256: hash(text) });
  writeFileSync(resolve(output, 'compatibility-inventory.json'), JSON.stringify(facts, null, 2) + '\n');
  assert.equal(r.error, undefined, `${label}: see log`); assert.equal(r.status, 0, `${label}: see ${output}/${label}.log`);
  if (expectedTests) { assert.equal(counts.length, 1); assert.deepEqual(counts[0], { passed: expectedTests, failed: 0, skipped: 0 }); }
  return r.stdout;
}
function verifyEndpoint(endpoint, record) {
  for (const [path, expected] of Object.entries(policy.closure)) {
    const r = spawnSync('git', ['show', `${record.revision}:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.status, 0, path); assert.equal(hash(r.stdout), expected, `${endpoint}:${path}`); assert.equal(hash(read(path)), expected, `working tree:${path}`);
  }
  const inventory = spawnSync('git', ['ls-tree', '-r', '--name-only', record.revision, '--', 'crates/editac-core', 'crates/editac-ffi', 'crates/editac-wasm', 'crates/editac-markdown', 'crates/editac-diff', 'packages/core'], { cwd: root, encoding: 'utf8' });
  assert.equal(inventory.status, 0);
  for (const path of inventory.stdout.trim().split('\n').filter(p => !p.includes('/tests/') && !p.includes('/benches/') && !p.endsWith('/README.md'))) assert(Object.hasOwn(policy.closure, path), `missing executable pin:${path}`);
  const lock = spawnSync('git', ['show', `${record.revision}:package-lock.json`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(lock.status, 0); assert.equal(hash(lock.stdout), policy.locks[endpoint]);
  const packages = JSON.parse(lock.stdout).packages; delete packages['']; assert.equal(hash(JSON.stringify(packages)), policy.resolvedPackagesHash);
  const installed = JSON.parse(read('package-lock.json')).packages; delete installed['']; assert.equal(hash(JSON.stringify(installed)), policy.resolvedPackagesHash);
}
let runtime, modules;
before(async () => {
  command('rust-toolchain', 'rustc', ['--version']);
  assert.match(facts.commands.at(-1).exit === 0 ? readFileSync(resolve(output, 'rust-toolchain.log'), 'utf8') : '', /^rustc 1\.97\.1 /);
  facts.toolchain = { node: process.version, rust: readFileSync(resolve(output, 'rust-toolchain.log'), 'utf8').trim() };
  // Refuse drift before invoking any build or persisted recovery.
  for (const [endpoint, record] of Object.entries(policy.endpoints)) verifyEndpoint(endpoint, record);
  for (const [path, expected] of Object.entries(policy.fixtures)) assert.equal(hash(read('fixtures/compatibility/' + path)), expected, path);
  command('rust-compatibility', 'cargo', ['test', '-p', 'editac-ffi', '--test', 'architecture_compatibility', '--locked', '--offline', '--', '--skip', 'public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data'], 10);
  command('generated-abi', 'cargo', ['test', '-p', 'editac-ffi', '--lib', 'abi_wire_tests', '--locked', '--offline'], 2);
  command('build-wasm', process.execPath, ['scripts/build-wasm.mjs']);
  command('build-public-api', 'npm', ['run', 'build', '--workspace', '@edit-ac/core']);
  const sdk = await import(pathToFileURL(resolve(root, 'packages/core/dist/index.js')));
  modules = await import(pathToFileURL(resolve(root, 'packages/core/dist/extensions/index.js')));
  const wasm = read('packages/core/dist/wasm/editac_wasm_bg.wasm');
  runtime = await sdk.init('data:application/wasm;base64,' + wasm.toString('base64'));
});
after(() => {
  if (existsSync(resolve(output, 'public-js.json'))) command('js-return-to-native', 'cargo', ['test', '-p', 'editac-ffi', '--test', 'architecture_compatibility', '--locked', '--offline', 'public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data'], 1);
  for (const path of Object.keys(policy.closure).concat(Object.keys(policy.fixtures).map(p => 'fixtures/compatibility/' + p),
    ['fixtures/compatibility/policy.json', 'packages/core/dist/index.js', 'packages/core/dist/engine.js', 'packages/core/dist/index.d.ts', 'packages/core/dist/engine.d.ts', 'packages/core/dist/wasm/editac_runtime.js', 'packages/core/dist/wasm/editac_wasm.js', 'packages/core/dist/wasm/editac_wasm_bg.wasm'])) facts.files[path] = hash(read(path));
  for (const path of ['native.bin', 'native.json', 'native-visible.json', 'public-js.bin', 'public-js.json', 'public-js-visible.json']) {
    try { facts.files[path] = hash(readFileSync(resolve(output, path))); } catch { /* A failed test cannot manufacture its output. */ }
  }
  writeFileSync(resolve(output, 'compatibility-inventory.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const [endpoint, record] of Object.entries(policy.endpoints)) test(`${endpoint}: exact immutable executable closure and dependency pins`, () => verifyEndpoint(endpoint, record));
test('all immutable fixture bytes match recorded content addresses', () => {
  assert.equal(Object.keys(policy.fixtures).length, 7);
  for (const [path, expected] of Object.entries(policy.fixtures)) assert.equal(hash(read('fixtures/compatibility/' + path)), expected, path);
});
for (const reader of ['previous', 'current']) for (const offered of ['previous', 'current']) test(`${offered} → ${reader}: exact supported public JS restore, journal, retained identities and export`, () => {
  const decision = compatibilityDecision(policy, reader, policy.endpoints[offered]); assert.equal(decision.outcome, 'recover'); assert.equal(decision.migration, 'none');
  const m = json('fixtures/compatibility/v5.json');
  const c = { identity: m.identity, initialized: true, writerId: m.writerId, bytes: new Uint8Array(read('fixtures/compatibility/v5.bin')) };
  const original = c.bytes.slice();
  const journal = [{ identity: m.identity, bytes: new Uint8Array(read('fixtures/compatibility/v5-journal.bin')) }];
  const engine = runtime.restoreEngine(m.identity, c, journal);
  try {
    const snapshot = engine.read(); assert.deepEqual(snapshot.identity, m.identity);
    assert.deepEqual(snapshot.visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')), m.expectedTexts);
    const runs = snapshot.visible.flatMap(n => n.runs);
    assert(runs.some(r => JSON.stringify(r.attributes['ext:future']) === JSON.stringify({ retained: true })));
    assert(runs.some(r => JSON.stringify(r.attributes['module:future.unknown']) === JSON.stringify(descriptor.unknown)));
    const saved = engine.checkpoint(); const reopened = runtime.restoreEngine(m.identity, saved);
    try { assert.deepEqual(reopened.read().visible, snapshot.visible); } finally { reopened.dispose(); }
    engine.applyUpdate(journal[0]); assert.deepEqual(engine.read().visible, snapshot.visible); // Idempotent acknowledged update.
    assert.deepEqual(c.bytes, original);
    writeFileSync(resolve(output, 'public-js.bin'), saved.bytes);
    writeFileSync(resolve(output, 'public-js.json'), JSON.stringify({ identity: saved.identity, initialized: saved.initialized, writerId: saved.writerId }));
    writeFileSync(resolve(output, 'public-js-visible.json'), JSON.stringify(snapshot.visible));
    facts.cases.push({ reader, offered, outcome: decision.outcome, migration: decision.migration });
  } finally { engine.dispose(); }
});
for (const reader of ['previous', 'current']) for (const field of ['semanticSchema', 'updateSync', 'protocolVersion', 'updateEncoding', 'offsets', 'extensionDescriptor', 'publicApi', 'nativeAbi']) test(`${reader}: unsupported ${field} has explicit recovery/export and never dispatches`, () => {
  let invoked = 0;
  const v = { ...policy.endpoints[reader].versions, [field]: typeof policy.endpoints[reader].versions[field] === 'number' ? 2 : 'future' };
  const result = withCompatibleContract(policy, reader, { revision: policy.endpoints[reader].revision, versions: v }, () => ++invoked);
  assert.equal(invoked, 0); assert.equal(result.decision.outcome, 'reject'); assert.deepEqual(result.decision.differences, [field]);
  assert.equal(result.decision.migration, 'unqualified-do-not-relabel'); assert.match(result.decision.export, /preserve-original.*matching-reader.*export-before-new-epoch/);
  facts.cases.push({ reader, field, ...result.decision });
});
for (const reader of ['previous', 'current']) test(`${reader}: identical version labels cannot admit an unreviewed implementation`, () => {
  let invoked = 0;
  const offered = { revision: '0'.repeat(40), versions: policy.endpoints[reader].versions };
  const result = withCompatibleContract(policy, reader, offered, () => ++invoked);
  assert.equal(invoked, 0); assert.equal(result.decision.outcome, 'reject');
  assert.deepEqual(result.decision.differences, ['implementationRevision']);
  assert.match(result.decision.export, /preserve-original.*matching-reader.*export-before-new-epoch/);
  facts.cases.push({ reader, offered, ...result.decision });
});
for (const [name, mapper] of [['v4', v4], ['v5', v5]]) test(`${name}: actual qualified Yjs reader recovers frozen bytes and rejects the other persisted schema`, () => {
  const m = json(`fixtures/compatibility/${name}.json`), base = read(`fixtures/compatibility/${name}.bin`);
  const d = mapper.restoreCheckpoint(m.identity, true, base, 600);
  try {
    mapper.admit(d, m.identity, read(`fixtures/compatibility/${name}-journal.bin`));
    const view = mapper.snapshot(d);
    assert.deepEqual(view.visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.insert).join('')), m.expectedTexts);
    assert(view.visible.flatMap(n => n.runs).some(r => JSON.stringify(r.attributes['module:future.unknown']) === JSON.stringify(descriptor.unknown)));
    const other = name === 'v4' ? 'v5' : 'v4';
    assert.throws(() => mapper.restoreCheckpoint(json(`fixtures/compatibility/${other}.json`).identity, true, read(`fixtures/compatibility/${other}.bin`), 601), /unsupported-profile/);
  } finally { d.destroy(); }
});
test('persisted newer-schema rollback and metadata relabeling cannot mutate recovery bytes', () => {
  const m = json('fixtures/compatibility/v5.json'); const bytes = new Uint8Array(read('fixtures/compatibility/v5.bin')); const original = bytes.slice();
  const legacy = json('fixtures/compatibility/v4.json').identity;
  assert.throws(() => runtime.restoreEngine(legacy, { identity: m.identity, initialized: true, writerId: 11, bytes }), /unsupported identity envelope/);
  assert.throws(() => runtime.restoreEngine(m.identity, { identity: legacy, initialized: true, writerId: 11, bytes: new Uint8Array(read('fixtures/compatibility/v4.bin')) }), /UnsupportedProfile/);
  assert.throws(() => v4.restoreCheckpoint(legacy, true, bytes, 602));
  assert.deepEqual(bytes, original);
  const reopened = runtime.restoreEngine(m.identity, { identity: m.identity, initialized: true, writerId: 11, bytes }); reopened.dispose();
});
for (const field of ['protocolVersion', 'updateEncoding', 'offsets', 'schema', 'profile']) test(`actual public JS wire rejects ${field} before update and preserves accepted checkpoint`, () => {
  const m = json('fixtures/compatibility/v5.json'); const e = runtime.restoreEngine(m.identity, { identity: m.identity, initialized: true, writerId: m.writerId, bytes: new Uint8Array(read('fixtures/compatibility/v5.bin')) });
  try {
    const before = e.checkpoint().bytes; const vector = e.stateVector();
    const wrong = { ...m.identity, [field]: typeof m.identity[field] === 'number' ? 2 : 'future' };
    assert.throws(() => e.applyUpdate({ identity: wrong, bytes: new Uint8Array(read('fixtures/compatibility/v5-journal.bin')) }));
    assert.deepEqual(e.checkpoint().bytes, before); assert.deepEqual(e.stateVector(), vector);
  } finally { e.dispose(); }
});
test('real native ABI checkpoint restores through public JS SDK with exact projection', () => {
  const metadata = JSON.parse(readFileSync(resolve(output, 'native.json')));
  const e = runtime.restoreEngine(metadata.identity, { ...metadata, bytes: new Uint8Array(readFileSync(resolve(output, 'native.bin'))) });
  try { assert.deepEqual(e.read().visible, JSON.parse(readFileSync(resolve(output, 'native-visible.json')))); } finally { e.dispose(); }
});
test('exported descriptor API admits exact version and preserves unknown future envelopes', () => {
  assert.equal(modules.EXTENSION_API_VERSION, policy.endpoints.current.versions.publicApi);
  const r = new modules.ModuleRegistry().register(descriptor.definition);
  assert.throws(() => r.register({ ...descriptor.definition, version: 2 }), e => e.code === 'incompatible'); r.freeze();
  const key = 'module:' + descriptor.definition.type;
  assert.equal(r.resolve(key, descriptor.future, 'label'), undefined);
  const before = JSON.stringify(descriptor.unknown);
  assert.equal(r.resolve('module:future.unknown', descriptor.unknown, 'label'), undefined);
  assert.equal(JSON.stringify(descriptor.unknown), before);
});
test('declared descriptor migration is a candidate only; absent rollback edge rejects without callback', () => {
  const d = descriptor.definition, evolution = { reads: [d, { ...d, version: 2 }], transitions: [{ from: 1, to: 2 }] };
  const source = [1, { label: 'preserved' }], before = JSON.stringify(source); let calls = 0;
  const candidate = modules.prepareModuleMigration(evolution, source, 'label', 2, data => { calls++; return data; });
  assert.equal(calls, 1); assert.equal(JSON.stringify(candidate.candidate), JSON.stringify([2, { label: 'preserved' }])); assert(Object.isFrozen(candidate.candidate)); assert(Object.isFrozen(candidate.candidate[1]));
  assert.equal(candidate.admission, 'host-prepared-edit-or-explicit-new-epoch'); assert.equal(JSON.stringify(source), before);
  assert.throws(() => modules.prepareModuleMigration(evolution, candidate.candidate, 'label', 1, () => { calls++; return {}; }), e => e.code === 'unsupported-transition'); assert.equal(calls, 1);
});
