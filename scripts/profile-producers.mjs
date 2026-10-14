import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { validateProfile, verifyProfileInputs, sha256 } from './capability-contract.mjs';

const demand = (value, message) => { if (!value) throw Error(message); };
const digest = value => /^[a-f0-9]{64}$/.test(value);
const unique = (values, label) => demand(new Set(values).size === values.length, `duplicate ${label}`);
const object = (value, keys, label) => {
  demand(value && typeof value === 'object' && !Array.isArray(value), `invalid ${label}`);
  demand(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), `invalid ${label} fields`);
};
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const identityHash = profile => sha256(canonical({ implementation: profile.implementation, versions: profile.versions, platform: profile.platform, inputs: profile.inputs }));

/** Only repository-controlled references enter this build-time boundary. */
export function readArtifact(ref, roots, limit = 1024 * 1024) {
  object(ref, ['repository', 'path', 'sha256'], 'artifact reference');
  demand(Object.hasOwn(roots, ref.repository) && digest(ref.sha256), 'unknown repository or artifact digest');
  demand(typeof ref.path === 'string' && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(ref.path) && !ref.path.split('/').some(p => ['.', '..'].includes(p)), 'invalid artifact path');
  const base = realpathSync(roots[ref.repository]), full = realpathSync(resolve(base, ref.path)), local = relative(base, full);
  demand(local !== '..' && !local.startsWith('../') && !isAbsolute(local), 'artifact escapes repository');
  const bytes = readFileSync(full);
  demand(bytes.length <= limit && sha256(bytes) === ref.sha256, `artifact size/hash mismatch: ${ref.path}`);
  return bytes;
}

function counts(count) {
  object(count, ['executed', 'passed', 'failed', 'skipped'], 'counts');
  demand(Object.values(count).every(n => Number.isSafeInteger(n) && n >= 0), 'invalid counts');
  return count.executed > 0 && count.executed === count.passed && count.failed === 0 && count.skipped === 0;
}

/** Preserve old preparation results; they cannot become a current SDK proof. */
export function adaptPreparation(raw, adapter, profile, { source, coreRoot }) {
  let observed, runtime, status, scope;
  if (adapter === 'nat-ios-preparation-v1') {
    demand(raw.gate === 'NAT-1.5', 'wrong iOS preparation producer');
    observed = raw.counts;
    runtime = { kind: 'simulator', target: raw.simulator?.type, os: raw.simulator?.runtime };
    status = raw.state === 'locally verified on iOS Simulator, not deployed';
    scope = raw.scope;
  } else {
    demand(adapter === 'nat-android-preparation-v1' && raw.gate === 'NAT-1.6', 'wrong Android preparation producer');
    const groups = ['android-narrow', 'android-control'].map(k => raw[k]?.counts);
    groups.forEach(counts);
    observed = Object.fromEntries(['executed', 'passed', 'failed', 'skipped'].map(k => [k, groups.reduce((n, c) => n + c[k], 0)]));
    runtime = { kind: 'emulator', target: raw.emulator?.image, os: `Android API ${raw.toolchain?.api}` };
    status = raw.status === 'PASS';
    scope = raw.qualification;
  }
  demand(typeof runtime.target === 'string' && runtime.target.length > 0 && typeof runtime.os === 'string' && runtime.os.length > 0, 'missing preparation runtime');
  demand(typeof scope === 'string' && scope.length > 0, 'missing preparation scope');
  const passed = counts(observed) && status;
  const inputs = raw.inputs;
  demand(inputs && Object.keys(inputs).length > 0, 'missing preparation input identities');
  const inputDrift = [];
  for (const [path, hash] of Object.entries(inputs)) {
    demand(digest(hash), 'invalid preparation input digest');
    // Generated binaries are historical artifacts, not current source inputs.
    if (path.startsWith('target/') || path.startsWith('crates/editac-ffi/generated/')) continue;
    try { readArtifact({ repository: 'core', path, sha256: hash }, { core: coreRoot }); }
    catch { inputDrift.push(path); }
  }
  return { producer: adapter, profileId: profile.id, source, evidenceRevision: source.sha256,
    testedImplementationRevision: raw.coreRevision ?? null, testedInputs: inputs,
    roadmapRevision: raw.sourceRevision ?? raw.source_revision ?? null,
    scope, runtime, counts: observed, passed, inputDrift: inputDrift.sort(),
    qualification: 'preparation-only', supportedNative: false };
}

/** A reviewed owner policy is required independently of a producer's assertion. */
export function qualifyNative(profile, receipt, policy, receiptHash) {
  validateProfile(profile);
  object(policy, ['version', 'owner', 'platform', 'identity', 'runtime', 'requirements', 'artifacts', 'packageArtifact'], 'qualification policy');
  object(receipt, ['version', 'owner', 'platform', 'identity', 'scope', 'runtime', 'counts', 'cases', 'artifacts', 'deferredPhysicalObservations'], 'qualification receipt');
  demand(policy.version === 1 && receipt.version === 1, 'unsupported qualification version');
  const owner = { 'swift-ios': '16-ios-sdk', 'kotlin-android': '17-android-sdk', desktop: '18-desktop-native' }[profile.platform];
  demand(owner && policy.owner === owner && receipt.owner === owner, 'wrong owning platform');
  demand(policy.platform === profile.platform && receipt.platform === profile.platform, 'qualification platform mismatch');
  demand(policy.identity === identityHash(profile) && receipt.identity === policy.identity, 'qualification implementation/version/input mismatch');
  demand(receipt.scope === 'native.sdk', 'wrong qualification scope');
  object(receipt.runtime, ['kind', 'target', 'os'], 'runtime');
  demand(canonical(policy.runtime) === canonical(receipt.runtime), 'reviewed runtime mismatch');
  const kinds = { 'swift-ios': ['physical-device', 'simulator'], 'kotlin-android': ['physical-device', 'emulator'], desktop: ['physical-device', 'vm', 'os-host'] }[profile.platform];
  demand(kinds.includes(receipt.runtime.kind) && [receipt.runtime.target, receipt.runtime.os].every(s => typeof s === 'string' && s.trim().length > 0), 'missing or wrong target runtime');
  demand(Array.isArray(receipt.deferredPhysicalObservations) && receipt.deferredPhysicalObservations.every(s => typeof s === 'string' && s.trim()), 'invalid deferred physical observations');
  demand(counts(receipt.counts), 'qualification failed, zero or skipped cases');
  demand(Array.isArray(policy.requirements) && policy.requirements.length > 0, 'missing required capability cases');
  demand(Array.isArray(policy.artifacts) && policy.artifacts.length > 0, 'missing packaged artifacts');
  unique(policy.artifacts.map(a => `${a.repository}/${a.path}`), 'packaged artifact');
  demand(policy.artifacts.some(a => canonical(a) === canonical(policy.packageArtifact)), 'missing packaged library identity');
  demand(canonical(receipt.artifacts) === canonical(policy.artifacts), 'packaged artifact identity mismatch');
  demand(Array.isArray(receipt.cases) && receipt.cases.length === receipt.counts.executed, 'case/count mismatch');
  unique(receipt.cases.map(c => c.id), 'case');
  unique(policy.requirements.map(r => r.capability), 'required capability');
  const required = [];
  for (const requirement of policy.requirements) {
    object(requirement, ['capability', 'cases'], 'requirement');
    demand(Array.isArray(requirement.cases) && requirement.cases.length > 0 && requirement.cases.every(id => typeof id === 'string' && /^[a-z][a-z0-9.-]*$/.test(id)), 'missing required cases');
    const capability = profile.capabilities.find(c => c.id === requirement.capability);
    demand(capability?.state.available && capability.state.qualified, 'required capability is unqualified');
    const proofs = capability.evidence.map(id => profile.evidence.find(e => e.id === id));
    demand(proofs.some(e => e.sha256 === receiptHash && e.scopes.includes('native.sdk') && e.provenance === (receipt.runtime.kind === 'physical-device' ? 'target-runtime-physical' : 'target-runtime-virtual')), 'missing exact runtime qualification evidence');
    required.push(...requirement.cases);
  }
  demand(['editor.read', 'editor.write'].every(id => policy.requirements.some(r => r.capability === id)), 'SDK read/write qualification missing');
  unique(required, 'required case');
  demand(canonical([...required].sort()) === canonical(receipt.cases.map(c => c.id).sort()), 'required case coverage mismatch');
  for (const item of receipt.cases) {
    object(item, ['id', 'status', 'mode', 'evidence'], 'case');
    demand(item.status === 'passed' && ['direct', 'virtual-equivalent'].includes(item.mode), 'failed or missing runtime observation');
    demand(item.mode !== 'virtual-equivalent' || receipt.runtime.kind !== 'physical-device', 'virtual equivalent requires a virtual runtime');
    demand(policy.artifacts.some(a => canonical(a) === canonical(item.evidence)), 'missing executed case evidence artifact');
  }
  unique(receipt.deferredPhysicalObservations, 'deferred observation');
  demand(receipt.deferredPhysicalObservations.every(id => receipt.cases.some(c => c.id === id && c.mode === 'virtual-equivalent')), 'deferred observation lacks tested equivalent');
  return { state: 'supported', scope: 'native.sdk', owner, runtime: receipt.runtime, evidenceRevision: receiptHash };
}

export function produceRelease(manifest, roots) {
  object(manifest, ['version', 'producers'], 'producer manifest');
  demand(manifest.version === 1 && Array.isArray(manifest.producers) && manifest.producers.length > 0 && manifest.producers.length <= 64, 'unknown or empty producer manifest');
  const profiles = manifest.producers.map(entry => {
    object(entry, ['profile', 'observation', 'qualification'], 'producer');
    const bytes = readArtifact(entry.profile, roots, 65536), profile = JSON.parse(bytes);
    demand(entry.profile.repository === 'core', 'profile must belong to core');
    const inputs = verifyProfileInputs(profile, roots.core);
    let observation = null;
    if (entry.observation !== null) {
      object(entry.observation, ['adapter', 'source'], 'preparation producer');
      observation = adaptPreparation(JSON.parse(readArtifact(entry.observation.source, roots)), entry.observation.adapter, profile, { source: entry.observation.source, coreRoot: roots.core });
      demand((profile.platform === 'swift-ios' && entry.observation.adapter === 'nat-ios-preparation-v1') || (profile.platform === 'kotlin-android' && entry.observation.adapter === 'nat-android-preparation-v1'), 'preparation platform mismatch');
    }
    let support = { state: 'pending', scope: profile.platform === 'portable' ? 'portable.inventory' : 'native.sdk', reason: 'owning-qualification-missing' };
    if (entry.qualification !== null) {
      object(entry.qualification, ['policy', 'receipt'], 'qualification references');
      const policy = JSON.parse(readArtifact(entry.qualification.policy, roots));
      const receipt = JSON.parse(readArtifact(entry.qualification.receipt, roots));
      support = qualifyNative(profile, receipt, policy, entry.qualification.receipt.sha256);
      // Check the policy's raw artifacts as well as all shared profile inputs/proofs.
      for (const artifact of policy.artifacts) readArtifact(artifact, roots, 64 * 1024 * 1024);
      for (const item of receipt.cases) {
        const proof = JSON.parse(readArtifact(item.evidence, roots));
        object(proof, ['version', 'kind', 'caseId', 'identity', 'runtime', 'mode', 'counts', 'observation', 'fallback'], 'runtime case artifact');
        demand(proof.version === 1 && proof.kind === 'target-runtime-case' && proof.caseId === item.id && proof.identity === policy.identity && canonical(proof.runtime) === canonical(receipt.runtime) && proof.mode === item.mode, 'runtime case identity mismatch');
        demand(counts(proof.counts), 'runtime case failed, zero or skipped');
        demand(typeof proof.observation === 'string' && proof.observation.trim().length > 0, 'missing runtime observation');
        demand(proof.mode !== 'virtual-equivalent' || (typeof proof.fallback === 'string' && proof.fallback.trim().length > 0), 'missing tested equivalent/fallback');
      }
    } else if (profile.platform !== 'portable') {
      demand(!profile.capabilities.some(c => c.state.qualified) && !profile.resources.qualified, 'native qualification requires owning policy');
    }
    return { profile, profileSource: entry.profile, identity: identityHash(profile), inputHashes: inputs, observation, support };
  });
  unique(profiles.map(p => p.profile.id), 'profile');
  const producerImplementation = Object.fromEntries(['profile-producers.mjs', 'release-profile.mjs', 'capability-contract.mjs', 'contract-schema.mjs'].map(path => [path, sha256(readFileSync(new URL(path, import.meta.url)))]));
  producerImplementation['capabilities.schema.json'] = sha256(readFileSync(new URL('../contracts/capabilities.schema.json', import.meta.url)));
  const payload = { kind: 'editac.release-profiles', contractVersion: 1, producerImplementation, producerManifestHash: sha256(canonical(manifest)), profiles };
  return { ...payload, contentRevision: sha256(canonical(payload)) };
}

/** Distribution pins are trusted configuration, never taken from the record itself. */
export function consumeRelease(bytes, expectedHash) {
  demand((typeof bytes === 'string' || bytes instanceof Uint8Array) && Buffer.byteLength(bytes) <= 4 * 1024 * 1024, 'release byte limit');
  demand(digest(expectedHash) && sha256(bytes) === expectedHash, 'reviewed release digest required');
  const record = JSON.parse(bytes);
  object(record, ['kind', 'contractVersion', 'producerImplementation', 'producerManifestHash', 'profiles', 'contentRevision'], 'release record');
  const { contentRevision, ...payload } = record;
  demand(record.kind === 'editac.release-profiles' && record.contractVersion === 1 && contentRevision === sha256(canonical(payload)), 'unknown or changed release record');
  demand(Array.isArray(record.profiles) && record.profiles.length > 0 && record.profiles.length <= 64, 'empty or oversized release');
  unique(record.profiles.map(p => p.profile.id), 'consumer profile');
  return record.profiles.flatMap(({ profile, identity, support, profileSource, observation }) => {
    validateProfile(profile);
    demand(identity === identityHash(profile) && ['pending', 'supported'].includes(support.state), 'invalid consumer profile');
    return profile.capabilities.map(c => ({ profileId: profile.id, platform: profile.platform, capability: c.id,
      implementation: profile.implementation, versions: profile.versions, identity, profileRevision: profileSource.sha256,
      state: { ...c.state }, support, evidence: c.evidence.map(id => profile.evidence.find(e => e.id === id)),
      preparation: observation ? { evidenceRevision: observation.evidenceRevision, qualification: observation.qualification, inputDrift: observation.inputDrift } : null }));
  });
}
