import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, identityHash, readArtifact, adaptPreparation, qualifyNative, produceRelease, consumeRelease } from '../../../scripts/profile-producers.mjs';
import { releaseProfile } from '../../../scripts/release-profile.mjs';
import { sha256, resolveCapability } from '../../../scripts/capability-contract.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const roots = { core: root, architecture: resolve(root, '../architecture') };
const base = 'tests/architecture/profile-producers/fixtures/';
const json = path => JSON.parse(readFileSync(resolve(root, path)));
const fixture = name => json(base + name + '.json');
const manifest = json('contracts/profiles/producers.json');
const fresh = () => ({ p: fixture('profile'), r: fixture('receipt'), q: fixture('policy') });
const receiptHash = sha256(readFileSync(resolve(root, base + 'receipt.json')));
const ref = path => ({ repository: 'core', path: relative(root, path), sha256: sha256(readFileSync(path)) });
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;

test('actual portable and native producers produce one deterministic, scoped release record', () => {
  const record = releaseProfile(root);
  assert.equal(record.profiles.length, 4);
  assert.equal(record.profiles.filter(p => p.support.state === 'supported').length, 0);
  assert.equal(record.contentRevision, releaseProfile(root).contentRevision);
  for (const entry of record.profiles) {
    assert.equal(entry.identity, identityHash(entry.profile));
    assert.ok(entry.profile.capabilities.every(c => c.state.authorized === null));
    assert.equal(entry.support.state, 'pending');
  }
  const native = record.profiles.filter(p => p.observation !== null);
  assert.deepEqual(native.map(p => p.observation.counts.executed), [7, 8]);
  assert.deepEqual(native.map(p => p.observation.runtime.kind), ['simulator', 'emulator']);
  assert.ok(native.every(p => p.observation.passed && p.observation.inputDrift.length > 0 && !p.observation.supportedNative));
  assert.ok(native.every(p => p.profile.capabilities.every(c => !c.state.qualified)));
  const desktop = record.profiles.find(p => p.profile.platform === 'desktop');
  assert.equal(desktop.observation, null);
  assert.ok(desktop.profile.capabilities.every(c => !c.state.available && !c.state.qualified));
  if (output) {
    mkdirSync(output, { recursive: true });
    write(resolve(output, 'profile-producers-inventory.json'), { record, qualification: 'producer contract and actual historical receipt adaptation; no new platform/SDK/release execution' });
  }
});

test('docs/demo/cloud share pinned rows, exact versions and inert authorization', () => {
  const bytes = canonical(releaseProfile(root)) + '\n';
  const rows = consumeRelease(bytes, sha256(bytes));
  assert.equal(rows.length, 10);
  assert.ok(rows.every(r => r.state.authorized === null && r.support.state === 'pending' && /^[a-f0-9]{64}$/.test(r.profileRevision)));
  for (const row of rows) assert.equal(Object.keys(row.versions).length, 7);
  assert.equal(rows.filter(r => r.preparation).length, 6);
  const p = releaseProfile(root).profiles[1].profile;
  assert.equal(resolveCapability(p, 'editor.write', { principal: 'fixture', available: true, enabled: true, permissions: ['document.write'] }).usable, false);
  assert.throws(() => consumeRelease(bytes), /digest/);
  assert.throws(() => consumeRelease(bytes + ' ', sha256(bytes)), /digest/);
});

test('consumer rejects unknown format and changed inner record even with a matching distribution digest', () => {
  const record = releaseProfile(root);
  record.contractVersion = 2;
  let bytes = canonical(record);
  assert.throws(() => consumeRelease(bytes, sha256(bytes)), /unknown or changed/);
  record.contractVersion = 1;
  record.profiles[0].support.state = 'supported';
  bytes = canonical(record);
  assert.throws(() => consumeRelease(bytes, sha256(bytes)), /unknown or changed/);
});

test('canonical CLI writes the same reviewed record and refuses overwrites and unknown flags', () => {
  const dir = output ?? mkdtempSync(resolve(root, 'architecture-results/fit-1.3-cli-'));
  const path = resolve(dir, 'release-profile.json');
  try {
    const run = spawnSync(process.execPath, ['scripts/release-profile.mjs', '--output', path], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout), bytes = readFileSync(path);
    assert.equal(receipt.sha256, sha256(bytes));
    assert.equal(receipt.supportedNative, 0);
    assert.equal(consumeRelease(bytes, receipt.sha256).length, 10);
    assert.equal(bytes.toString(), canonical(releaseProfile(root)) + '\n');
    const before = sha256(bytes);
    assert.equal(spawnSync(process.execPath, ['scripts/release-profile.mjs', '--output', path], { cwd: root }).status, 1);
    assert.equal(sha256(readFileSync(path)), before);
    assert.equal(spawnSync(process.execPath, ['scripts/release-profile.mjs', '--live'], { cwd: root }).status, 1);
  } finally { if (!output) rmSync(dir, { recursive: true }); }
});

test('prepared fixture exercises admission structure without qualifying a real platform', () => {
  const result = produceRelease(fixture('manifest'), roots);
  assert.equal(result.profiles[0].support.state, 'supported');
  assert.match(result.profiles[0].support.runtime.target, /CONTRACT FIXTURE ONLY/);
  assert.equal(result.profiles[0].profile.id, 'fixture.native.ios.contract-only');
  assert.ok(manifest.producers.every(e => !e.profile.path.startsWith(base)));
  assert.equal(releaseProfile(root).profiles.filter(p => p.support.state === 'supported').length, 0);
});

const negatives = [
  ['unknown owner policy', ({ q }) => q.version = 2, /version/],
  ['unknown receipt version', ({ r }) => r.version = 2, /version/],
  ['missing owner policy', ({ q }) => delete q.owner, /fields/],
  ['wrong owner', ({ q }) => q.owner = '09-native-preparation', /owning/],
  ['wrong receipt owner', ({ r }) => r.owner = '17-android-sdk', /owning/],
  ['wrong policy platform', ({ q }) => q.platform = 'kotlin-android', /platform/],
  ['wrong receipt platform', ({ r }) => r.platform = 'desktop', /platform/],
  ['stale implementation', ({ r }) => r.identity = 'b'.repeat(64), /implementation/],
  ['stale policy', ({ q }) => q.identity = 'b'.repeat(64), /implementation/],
  ['changed version tuple', ({ p }) => p.versions.nativeAbi = 2, /implementation/],
  ['changed package version', ({ p }) => p.implementation.version = '1.0.0', /implementation/],
  ['preparation scope', ({ r }) => r.scope = 'native.control.preparation', /scope/],
  ['headless runtime', ({ r, q }) => { r.runtime.kind = 'os-host'; q.runtime.kind = 'os-host'; }, /target runtime/],
  ['prepared runtime', ({ r, q }) => { r.runtime.kind = 'prepared'; q.runtime.kind = 'prepared'; }, /target runtime/],
  ['missing named runtime', ({ r, q }) => { r.runtime.target = ''; q.runtime.target = ''; }, /target runtime/],
  ['unreviewed runtime', ({ r }) => r.runtime.os = 'another version', /reviewed runtime/],
  ['skipped qualification', ({ r }) => r.counts.skipped = 1, /skipped/],
  ['failed qualification', ({ r }) => r.counts.failed = 1, /failed/],
  ['zero qualification', ({ r }) => { r.counts.executed = 0; r.counts.passed = 0; }, /zero/],
  ['invalid count', ({ r }) => r.counts.executed = 2.5, /counts/],
  ['missing counts', ({ r }) => delete r.counts.skipped, /fields/],
  ['missing required cases', ({ q }) => q.requirements = [], /required/],
  ['missing capability cases', ({ q }) => q.requirements[0].cases = [], /required cases/],
  ['duplicate required cases', ({ q }) => q.requirements[1].cases = ['native-read'], /duplicate/],
  ['duplicate capabilities', ({ q }) => q.requirements[1].capability = 'editor.read', /duplicate/],
  ['missing SDK writes', ({ q }) => q.requirements.pop(), /read\/write/],
  ['unqualified capability', ({ p }) => p.capabilities[0].state.qualified = false, /unqualified/],
  ['prepared evidence', ({ p }) => p.evidence[0].provenance = 'prepared', /cannot qualify/],
  ['wrong evidence provenance', ({ p }) => p.evidence[0].provenance = 'target-runtime-physical', /exact runtime/],
  ['stale proof content', ({ p }) => { p.evidence[0].sha256 = p.evidence[0].revision = 'b'.repeat(64); }, /exact runtime/],
  ['missing SDK evidence scope', ({ p }) => p.evidence[0].scopes = ['editor.read', 'editor.write'], /exact runtime/],
  ['missing artifacts', ({ q }) => q.artifacts = [], /artifacts/],
  ['missing library identity', ({ q }) => q.packageArtifact.sha256 = 'b'.repeat(64), /library/],
  ['changed artifact', ({ r }) => r.artifacts[0].sha256 = 'b'.repeat(64), /artifact identity/],
  ['duplicate artifact', ({ q }) => q.artifacts.push(structuredClone(q.artifacts[0])), /duplicate/],
  ['missing case result', ({ r }) => r.cases.pop(), /count/],
  ['extra case', ({ r }) => r.cases.push({ ...r.cases[0], id: 'extra' }), /count/],
  ['duplicate case', ({ r }) => r.cases[1].id = r.cases[0].id, /duplicate/],
  ['wrong required case', ({ q }) => q.requirements[0].cases = ['missing'], /coverage/],
  ['failed case', ({ r }) => r.cases[0].status = 'failed', /failed/],
  ['missing observation mode', ({ r }) => r.cases[0].mode = 'prepared', /observation/],
  ['missing case evidence', ({ r }) => r.cases[0].evidence.sha256 = 'b'.repeat(64), /case evidence/],
  ['untested physical deferral', ({ r }) => r.deferredPhysicalObservations = ['native-read'], /tested equivalent/],
  ['duplicate physical deferral', ({ r }) => r.deferredPhysicalObservations.push('native-write'), /duplicate/],
  ['imported permission', ({ p }) => p.capabilities[0].state.authorized = true, /type null/],
];
for (const [name, change, error] of negatives) test(`native admission rejects ${name}`, () => {
  const context = fresh(); change(context);
  assert.throws(() => qualifyNative(context.p, context.r, context.q, receiptHash), error);
});

for (const [platform, owner, kind, provenance] of [
  ['swift-ios', '16-ios-sdk', 'simulator', 'target-runtime-virtual'],
  ['swift-ios', '16-ios-sdk', 'physical-device', 'target-runtime-physical'],
  ['kotlin-android', '17-android-sdk', 'emulator', 'target-runtime-virtual'],
  ['kotlin-android', '17-android-sdk', 'physical-device', 'target-runtime-physical'],
  ['desktop', '18-desktop-native', 'vm', 'target-runtime-virtual'],
  ['desktop', '18-desktop-native', 'os-host', 'target-runtime-virtual'],
]) test(`admission contract accepts named ${platform}/${kind} provenance only for exact reviewed inputs`, () => {
  const { p, r, q } = fresh();
  p.platform = r.platform = q.platform = platform;
  r.owner = q.owner = owner; r.runtime.kind = q.runtime.kind = kind;
  p.evidence[0].provenance = provenance;
  r.identity = q.identity = identityHash(p);
  if (kind === 'physical-device') { r.cases[1].mode = 'direct'; r.deferredPhysicalObservations = []; }
  assert.equal(qualifyNative(p, r, q, receiptHash).state, 'supported');
});

// Real filesystem integration over prepared owner artifacts; never a target-runtime run.
function integratedFixture(t, mutate) {
  mkdirSync(resolve(root, 'architecture-results'), { recursive: true });
  const dir = mkdtempSync(resolve(root, 'architecture-results/fit-1.3-contract-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const context = fresh();
  context.proofs = [fixture('native-read'), fixture('native-write')];
  mutate(context);
  const artifacts = [fixture('package'), ...context.proofs].map((value, i) => {
    const path = resolve(dir, `artifact-${i}.json`); write(path, value); return ref(path);
  });
  context.q.artifacts = artifacts; context.q.packageArtifact = artifacts[0];
  context.r.artifacts = artifacts;
  context.r.cases.forEach((c, i) => c.evidence = artifacts[i + 1]);
  const receiptPath = resolve(dir, 'receipt.json'), policyPath = resolve(dir, 'policy.json'), profilePath = resolve(dir, 'profile.json');
  write(receiptPath, context.r); write(policyPath, context.q);
  const receiptRef = ref(receiptPath), proof = context.p.evidence[0];
  proof.path = receiptRef.path; proof.sha256 = proof.revision = receiptRef.sha256;
  write(profilePath, context.p);
  return { version: 1, producers: [{ profile: ref(profilePath), observation: null, qualification: { policy: ref(policyPath), receipt: receiptRef } }] };
}

test('full filesystem adapter admits an exact prepared contract and keeps activation independent', t => {
  const m = integratedFixture(t, () => {}), result = produceRelease(m, roots);
  const bytes = canonical(result), rows = consumeRelease(bytes, sha256(bytes));
  assert.ok(rows.every(row => row.support.state === 'supported' && row.state.authorized === null && !row.state.enabled));
});
for (const [name, mutate, error] of [
  ['failed equivalent', ({ proofs }) => proofs[1].counts.failed = 1, /runtime case failed/],
  ['skipped equivalent', ({ proofs }) => proofs[1].counts.skipped = 1, /runtime case failed/],
  ['zero equivalent', ({ proofs }) => { proofs[1].counts.executed = proofs[1].counts.passed = 0; }, /runtime case failed/],
  ['prepared equivalent artifact', ({ proofs }) => proofs[1].kind = 'prepared-case', /case identity/],
  ['wrong artifact implementation', ({ proofs }) => proofs[1].identity = 'b'.repeat(64), /case identity/],
  ['wrong artifact runtime', ({ proofs }) => proofs[1].runtime.os = 'different', /case identity/],
  ['wrong artifact case', ({ proofs }) => proofs[1].caseId = 'different', /case identity/],
  ['missing actual observation', ({ proofs }) => proofs[1].observation = '', /runtime observation/],
  ['untested fallback', ({ proofs }) => proofs[1].fallback = '', /tested equivalent/],
]) test(`filesystem admission rejects ${name}`, t => {
  const m = integratedFixture(t, mutate);
  assert.throws(() => produceRelease(m, roots), error);
});

test('native producer cannot omit owning policy while advertising qualification', t => {
  const m = integratedFixture(t, () => {}); m.producers[0].qualification = null;
  assert.throws(() => produceRelease(m, roots), /owning policy/);
});
test('producer verifies artifact content rather than accepting hashes as labels', t => {
  const m = integratedFixture(t, () => {});
  writeFileSync(resolve(root, m.producers[0].qualification.receipt.path), '{}');
  assert.throws(() => produceRelease(m, roots), /hash mismatch/);
});
test('producer verifies owning packaged artifacts, not just receipt status', t => {
  const m = integratedFixture(t, () => {});
  const q = JSON.parse(readArtifact(m.producers[0].qualification.policy, roots));
  writeFileSync(resolve(root, q.packageArtifact.path), '{}');
  assert.throws(() => produceRelease(m, roots), /hash mismatch/);
});

for (const [name, change, error] of [
  ['empty producers', m => m.producers = [], /empty/],
  ['unknown manifest', m => m.version = 2, /unknown/],
  ['duplicate profiles', m => m.producers.push(structuredClone(m.producers[0])), /duplicate profile/],
  ['profile digest drift', m => m.producers[0].profile.sha256 = 'b'.repeat(64), /hash mismatch/],
  ['receipt digest drift', m => m.producers[1].observation.source.sha256 = 'b'.repeat(64), /hash mismatch/],
  ['unknown adapter', m => m.producers[1].observation.adapter = 'headless', /wrong Android/],
  ['unknown repository', m => m.producers[0].profile.repository = 'untrusted', /repository/],
  ['traversal', m => m.producers[0].profile.path = '../architecture/README.md', /path/],
  ['absolute path', m => m.producers[0].profile.path = '/etc/passwd', /path/],
]) test(`actual producer rejects ${name}`, () => {
  const m = structuredClone(manifest); change(m);
  assert.throws(() => produceRelease(m, roots), error);
});

test('artifact reader rejects symlink escapes', t => {
  const dir = mkdtempSync(resolve(root, 'architecture-results/fit-1.3-links-'));
  t.after(() => rmSync(dir, { recursive: true }));
  symlinkSync(resolve(roots.architecture, 'README.md'), resolve(dir, 'escape'));
  assert.throws(() => readArtifact({ repository: 'core', path: relative(root, resolve(dir, 'escape')), sha256: 'a'.repeat(64) }, roots), /escapes/);
});

test('failed preparation stays failed and pending, and headless evidence is rejected', () => {
  const entry = manifest.producers[1], raw = JSON.parse(readArtifact(entry.observation.source, roots));
  const profile = json(entry.profile.path);
  raw.counts.failed = 1;
  const observation = adaptPreparation(raw, entry.observation.adapter, profile, { source: entry.observation.source, coreRoot: root });
  assert.equal(observation.passed, false); assert.equal(observation.supportedNative, false);
  raw.gate = 'NAT-1.3';
  assert.throws(() => adaptPreparation(raw, entry.observation.adapter, profile, { source: entry.observation.source, coreRoot: root }), /wrong iOS/);
});
