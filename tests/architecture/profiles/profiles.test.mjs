import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { admitProfile, validateProfile, verifyProfileInputs, resolveCapability, extensionCapabilityState, sha256, MAX_PROFILE_BYTES } from '../../../scripts/capability-contract.mjs';
import { validateSchema } from '../../../scripts/contract-schema.mjs';
import { loadMatrix, validateCapabilities } from '../../../scripts/check-extension-capabilities.mjs';
import { selectSuite } from '../../../scripts/check-architecture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const json = path => JSON.parse(readFileSync(resolve(root, path)));
const registryPath = 'contracts/profiles/portable-editor-v5.json';
const registry = json(registryPath), fixture = json('tests/architecture/profiles/fixtures/profile.json');
const fresh = () => structuredClone(fixture);
const bytes = value => Buffer.from(JSON.stringify(value));
const host = { principal: 'fixture-user', available: true, enabled: true, permissions: [] };

// Actual inventory sources, not native/release producers or runtime qualification.
test('registry pins actual semantic/sync/API/ABI/descriptor inputs at an immutable implementation', () => {
  const hashes = verifyProfileInputs(registry, root);
  assert.equal(Object.keys(hashes).length, 5);
  const schemaProfile = json('fixtures/schema-v5/profile.json');
  assert.equal(registry.versions.semanticSchema, schemaProfile.schema);
  assert.equal(registry.versions.updateSync, schemaProfile.profile);
  assert.equal(registry.versions.updateEncoding, schemaProfile.updateEncoding);
  assert.equal(registry.implementation.package, json('packages/core/package.json').name);
  assert.equal(registry.implementation.version, json('packages/core/package.json').version);
  assert.match(readFileSync(resolve(root, 'crates/editac-ffi/src/lib.rs'), 'utf8'), /abi_version: 1,/);
  assert.match(readFileSync(resolve(root, 'packages/core/src/extensions/profiles.ts'), 'utf8'), /apiVersion: 1;/);
  assert.deepEqual(registry.resources.limits, schemaProfile.bounds);
  assert.equal(registry.resources.qualified, false);
  assert.ok(registry.capabilities.every(c => !c.state.qualified && !c.state.enabled && c.state.authorized === null));
});

test('prepared fixture references content-addressed proof and exact implementation inputs', () => {
  assert.equal(Object.keys(verifyProfileInputs(fixture, root)).length, 6);
  assert.equal(validateProfile(fixture), fixture);
});

test('existing 210-cell extension inventory consumes shared states and retains scoped proof checks', () => {
  const matrix = loadMatrix(), result = validateCapabilities(matrix);
  assert.equal(result.cells, 210);
  const states = matrix.cells.map(extensionCapabilityState);
  assert.equal(states.length, 210);
  assert.ok(states.every(s => !s.enabled && s.authorized === null));
  assert.ok(states.some(s => s.qualified));
  assert.ok(states.some(s => !s.available && !s.qualified));
  const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'profiles-inventory.json'), JSON.stringify({
      registry: registryPath, implementationRevision: registry.implementation.revision,
      sourceHashes: verifyProfileInputs(registry, root),
      preparedProofHashes: verifyProfileInputs(fixture, root),
      extensionCells: result.cells, qualifiedScopedCells: states.filter(s => s.qualified).length,
      pendingCells: states.filter(s => !s.qualified).length,
      retainedHistoricalFailures: result.retainedPriorFailures,
      qualification: 'contract validation only; native/runtime/resource claims remain pending',
    }, null, 2) + '\n');
  }
});

const negatives = [
  ['contract version', p => p.contractVersion = 2, /const/],
  ['semantic schema', p => p.versions.semanticSchema = '', /empty string/],
  ['sync identity', p => p.versions.updateSync = 'contains spaces', /pattern/],
  ['encoding', p => p.versions.updateEncoding = 0, /minimum/],
  ['descriptor', p => p.versions.extensionDescriptor = 1.5, /integer/],
  ['API', p => p.versions.publicApi = 4294967296, /maximum/],
  ['ABI', p => delete p.versions.nativeAbi, /missing nativeAbi/],
  ['dialect', p => p.versions.sourceDialect = '', /empty string/],
  ['unversioned package', p => p.implementation.version = 'latest', /pattern/],
  ['converter version', p => p.converters[0].version = 0, /minimum/],
  ['implementation revision', p => p.implementation.revision = 'main', /pattern/],
  ['proof implementation identity', p => p.evidence[0].implementationRevision = 'b'.repeat(40), /implementation mismatch/],
  ['proof content identity', p => p.evidence[0].revision = 'b'.repeat(64), /content revision mismatch/],
  ['proof digest', p => p.evidence[0].sha256 = 'latest', /pattern/],
  ['evidence scope', p => p.evidence[0].scopes = ['editor.write'], /wrong-scope/],
  ['missing evidence', p => p.evidence = [], /wrong-scope/],
  ['qualified without evidence', p => p.capabilities[0].evidence = [], /lacks evidence/],
  ['duplicate evidence', p => p.evidence.push({ ...p.evidence[0], path: 'other.json' }), /duplicate evidence/],
  ['duplicate capability', p => p.capabilities.push({ ...p.capabilities[0], permissions: ['other'] }), /duplicate capability/],
  ['unavailable enabled', p => p.capabilities[0].state.available = false, /enabled capability is unavailable/],
  ['unavailable qualified', p => { p.capabilities[0].state.available = false; p.capabilities[0].state.enabled = false; }, /qualified capability is unavailable/],
  ['imported authorization true', p => p.capabilities[0].state.authorized = true, /type null/],
  ['imported authorization false', p => p.capabilities[0].state.authorized = false, /type null/],
  ['extra principal', p => p.principal = 'admin', /unexpected principal/],
  ['extra permission grant', p => p.capabilities[0].grants = ['admin'], /unexpected grants/],
  ['empty resource limits', p => p.resources.limits = {}, /minProperties/],
  ['negative limit', p => p.resources.limits.bytes = -1, /minimum/],
  ['resource qualification without proof', p => p.resources.qualified = true, /lacks evidence/],
  ['unknown platform', p => p.platform = 'everything', /enum/],
  ['prepared proof as platform qualification', p => p.platform = 'swift-ios', /cannot qualify a platform/],
  ['unknown converter direction', p => p.converters[0].direction = 'both', /enum/],
  ['reversed export direction', p => p.converters[0].direction = 'import', /contradicts source dialect/],
  ['same converter dialect', p => p.converters[0].to = 'editac.internal', /cross dialects/],
  ['unknown converter fidelity', p => p.converters[0].fidelity = 'perfect', /enum/],
  ['unknown converter capability', p => p.converters[0].capability = 'cloud.upload', /unknown capability/],
  ['unproven qualified converter', p => p.converters[0].evidence = [], /lacks evidence/],
  ['duplicate converter', p => p.converters.push({ ...p.converters[0], fidelity: 'lossy' }), /duplicate converter/],
  ['extra version', p => p.versions.future = 2, /unexpected future/],
];
for (const [name, mutate, error] of negatives) test(`reject ${name}`, () => { const p = fresh(); mutate(p); assert.throws(() => validateProfile(p), error); });

test('both directed converters are explicit; fidelity stays a reviewed record', () => {
  const p = fresh(); p.converters.push({ ...p.converters[0], from: 'markdown.source', to: 'editac.internal', direction: 'import', fidelity: 'lossy' });
  assert.equal(validateProfile(p).converters.length, 2);
});

for (const mode of ['read', 'copy', 'export']) test(`unknown contract preserves exact inert bytes for ${mode}`, () => {
  const input = Buffer.from('{ "contractVersion": 2, "provider": "must-not-install", "authorized": true, "unknown": {"nested": [1,"😀"]} }\n');
  const result = admitProfile(input, { mode, supported: [fixture] });
  assert.equal(result.kind, 'preserved'); assert.equal(result.writable, false);
  assert.equal(result.reason, 'unsupported-contract-version'); assert.deepEqual(result.bytes, input);
  assert.equal(result.profile, undefined); result.bytes[0] = 0; assert.equal(input[0], 123);
});

test('unknown contract rejects write without evaluating privileged claims', () => {
  assert.throws(() => admitProfile('{"contractVersion":2,"authorized":true}', { mode: 'write' }), /unsupported contract version/);
});

for (const field of Object.keys(fixture.versions)) test(`unknown ${field} version is preserved for reads and rejected for writes`, () => {
  const p = fresh(); p.versions[field] = typeof p.versions[field] === 'number' ? p.versions[field] + 1 : `${p.versions[field]}.future`;
  if (field === 'sourceDialect') p.converters[0].from = p.versions.sourceDialect;
  const input = bytes(p), result = admitProfile(input, { supported: [fixture] });
  assert.equal(result.kind, 'preserved'); assert.deepEqual(result.bytes, input); assert.equal(result.writable, false);
  assert.throws(() => admitProfile(input, { mode: 'write', supported: [fixture] }), /unsupported version tuple/);
});

test('known exact tuple admits profile data without activation or permission side effects', () => {
  for (const mode of ['read', 'write']) {
    const result = admitProfile(bytes(fixture), { mode, supported: [fixture] });
    assert.equal(result.kind, 'known'); assert.equal(result.writable, mode === 'write');
    assert.equal(result.profile.capabilities[0].state.authorized, null);
  }
});

for (const [name, input, error] of [
  ['oversized bytes', Buffer.alloc(MAX_PROFILE_BYTES + 1), /byte limit/],
  ['depth limit', '{"contractVersion":2,"x":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}', /structure limit/],
  ['node limit', JSON.stringify({contractVersion:2,x:Array(8193).fill(0)}), /structure limit/],
  ['malformed JSON', '{', /JSON/],
  ['invalid UTF8', Buffer.from([0xff]), /encoded data/],
  ['invalid version', '{"contractVersion":"2"}', /invalid contract version/],
  ['object instead of bytes', {contractVersion:2}, /serialized data/],
]) test(`bounded inert admission rejects ${name}`, () => assert.throws(() => admitProfile(input), error));

test('permission is distinct from availability, activation and qualification', () => {
  const p = fresh(), capability = p.capabilities[1];
  capability.state.enabled = true;
  capability.state.qualified = true; capability.evidence = ['prepared.read']; p.evidence[0].scopes.push('editor.write');
  const denied = resolveCapability(p, 'editor.write', host);
  assert.deepEqual(denied, {available:true, enabled:true, authorized:false, qualified:true, usable:false});
  const allowed = resolveCapability(p, 'editor.write', {...host, permissions:['document.write']});
  assert.equal(allowed.usable, true);
  assert.equal(resolveCapability(p, 'editor.write', {...host, available:false, permissions:['document.write']}).usable, false);
  assert.equal(resolveCapability(p, 'editor.write', {...host, enabled:false, permissions:['document.write']}).enabled, false);
  capability.state.qualified = false;
  assert.equal(resolveCapability(p, 'editor.write', {...host, permissions:['document.write']}).usable, false);
  capability.state.enabled = false;
  assert.equal(resolveCapability(p, 'editor.write', {...host, permissions:['document.write']}).enabled, false);
  assert.throws(() => resolveCapability(p, 'cloud.upload', {...host, permissions:['cloud.upload']}), /unknown capability/);
});

test('missing or anonymous runtime host answers cannot authorize', () => {
  for (const answer of [undefined, {}, {...host,principal:''}, {...host,permissions:true}]) assert.throws(() => resolveCapability(fixture, 'editor.read', answer), /host answer required/);
});

test('granting document.write cannot supply missing capability availability', () => {
  const p = fresh(); p.capabilities[1].state.available = false;
  const result = resolveCapability(p, 'editor.write', {...host,permissions:['document.write']});
  assert.equal(result.authorized, true); assert.equal(result.available, false); assert.equal(result.usable, false);
});

test('artifact mutation, revision mismatch, traversal and symlinks fail admission', () => {
  const p = fresh(); p.inputs[0].sha256 = 'f'.repeat(64);
  assert.throws(() => verifyProfileInputs(p, root), /artifact hash mismatch/);
  p.inputs = fresh().inputs; p.implementation.revision = 'f'.repeat(40); p.evidence = []; p.capabilities[0].state.qualified = false; p.capabilities[0].evidence = []; p.converters = [];
  assert.throws(() => verifyProfileInputs(p, root), /revision input mismatch/);
  for (const path of ['../outside.json','/absolute.json','fixtures/../outside.json','fixtures\\outside.json']) {
    const bad = fresh(); bad.evidence[0].path = path;
    assert.throws(() => verifyProfileInputs(bad, root), /pattern|invalid profile artifact path/);
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'fit-profile-'));
  try {
    const bad = fresh(); bad.inputs = []; const target = resolve(directory, 'proof.json');
    writeFileSync(target, readFileSync(resolve(root, bad.evidence[0].path)));
    symlinkSync(root, resolve(directory, 'core'));
    // Canonical root does not contain a symlink escaping to external fixtures.
    const link = resolve(directory, 'escape'); symlinkSync(root, link);
    bad.inputs = [{path:'escape/contracts/profiles/portable-editor-v5.json',sha256:sha256(readFileSync(resolve(root,registryPath)))}];
    assert.throws(() => verifyProfileInputs(bad, directory), /escapes repository/);
  } finally { rmSync(directory, {recursive:true,force:true}); }
});

test('unknown/zero suites and unsupported schema keywords remain fail closed', () => {
  const manifest = json('contracts/layers.json');
  assert.equal(selectSuite(manifest, ['--suite','profiles']).tests.length, 2);
  assert.throws(() => selectSuite(manifest, ['--suite','missing']), /registered/);
  assert.throws(() => selectSuite({suites:{profiles:{tests:[]}}}, ['--suite','profiles']), /Zero/);
  assert.throws(() => validateSchema({}, {type:'object',futureKeyword:true}), /unsupported schema keyword/);
});

for (const key of ['__proto__', 'constructor', 'toString']) test(`inherited schema property ${key} cannot bypass extra-field rejection`, () => {
  const p = fresh(); Object.defineProperty(p, key, {value: {}, enumerable:true});
  assert.throws(() => admitProfile(bytes(p), {supported:[fixture]}), /unexpected/);
});
