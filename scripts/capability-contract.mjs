import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateSchema } from './contract-schema.mjs';

export const PROFILE_VERSION = 1;
export const MAX_PROFILE_BYTES = 65536;
const schema = JSON.parse(readFileSync(new URL('../contracts/capabilities.schema.json', import.meta.url)));
const demand = (ok, message) => { if (!ok) throw Error(message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unique = (items, label) => demand(new Set(items).size === items.length, `duplicate ${label}`);

/** Adapt the existing scoped extension inventory; never infer activation or permission. */
export function extensionCapabilityState(cell) {
  const statuses = ['portable-qualified', 'browser-mechanics-qualified', 'pending-platform', 'fallback-only', 'document-behavior'];
  demand(statuses.includes(cell.status), 'unknown extension qualification status');
  const qualified = ['portable-qualified', 'browser-mechanics-qualified'].includes(cell.status);
  demand(!qualified || cell.evidence.length > 0, 'qualified capability lacks evidence');
  return { available: qualified, enabled: false, authorized: null, qualified };
}

export function validateProfile(profile) {
  validateSchema(profile, schema);
  unique(profile.capabilities.map(c => c.id), 'capability');
  unique(profile.evidence.map(e => e.id), 'evidence');
  unique(profile.inputs.map(i => i.path), 'input');
  const evidence = new Map(profile.evidence.map(e => [e.id, e]));
  for (const proof of profile.evidence) {
    demand(proof.implementationRevision === profile.implementation.revision, 'evidence implementation mismatch');
    demand(proof.revision === proof.sha256, 'evidence content revision mismatch');
    unique(proof.scopes, 'evidence scope');
  }
  const checkEvidence = (refs, scope, qualified) => {
    unique(refs, 'evidence reference');
    demand(!qualified || refs.length > 0, `qualified ${scope} lacks evidence`);
    for (const id of refs) {
      const proof = evidence.get(id);
      demand(!qualified || profile.platform === 'portable' || proof?.provenance !== 'prepared', 'prepared evidence cannot qualify a platform');
      demand(proof && proof.scopes.includes(scope), `missing or wrong-scope evidence: ${scope}/${id}`);
    }
  };
  for (const capability of profile.capabilities) {
    demand(!capability.state.enabled || capability.state.available, 'enabled capability is unavailable');
    demand(!capability.state.qualified || capability.state.available, 'qualified capability is unavailable');
    checkEvidence(capability.evidence, capability.id, capability.state.qualified);
  }
  checkEvidence(profile.resources.evidence, 'resources', profile.resources.qualified);
  unique(profile.converters.map(c => `${c.from}/${c.to}/${c.direction}`), 'converter');
  for (const converter of profile.converters) {
    demand(converter.from !== converter.to, 'converter must cross dialects');
    const capability = profile.capabilities.find(c => c.id === converter.capability);
    demand(capability, 'converter references unknown capability');
    demand(converter.direction === 'import' ? converter.to === profile.versions.sourceDialect : converter.from === profile.versions.sourceDialect, 'converter direction contradicts source dialect');
    checkEvidence(converter.evidence, converter.capability, capability.state.qualified);
  }
  return profile;
}

/** Repository-controlled inventories only: resolve symlinks and pin every input/proof. */
export function verifyProfileInputs(profile, root) {
  validateProfile(profile);
  const base = realpathSync(root), hashes = {};
  for (const input of [...profile.inputs, ...profile.evidence]) {
    demand(!isAbsolute(input.path) && !input.path.includes('\\') && !input.path.split('/').some(p => ['', '.', '..'].includes(p)), 'invalid profile artifact path');
    const full = realpathSync(resolve(base, input.path)), local = relative(base, full);
    demand(local !== '..' && !local.startsWith('../') && !isAbsolute(local), 'profile artifact escapes repository');
    const digest = sha256(readFileSync(full));
    demand(digest === input.sha256, `profile artifact hash mismatch: ${input.path}`);
    if (profile.inputs.includes(input)) {
      const pinned = spawnSync('git', ['show', `${profile.implementation.revision}:${input.path}`], { cwd: base, maxBuffer: 1024 * 1024 });
      demand(pinned.status === 0 && sha256(pinned.stdout) === digest, `implementation revision input mismatch: ${input.path}`);
    }
    hashes[input.path] = digest;
  }
  return hashes;
}

/** Exact version tuple support; this is admission, not a migration/rollback promise. */
export function versionIdentity(profile) { return JSON.stringify(Object.entries(profile.versions).sort(([a], [b]) => a.localeCompare(b))); }

function boundedJSON(bytes) {
  demand(bytes.byteLength <= MAX_PROFILE_BYTES, 'profile byte limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
  const stack = [[value, 0]]; let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    demand(depth <= 32 && ++nodes <= 8192, 'profile structure limit');
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  demand(value && typeof value === 'object' && !Array.isArray(value) && Number.isSafeInteger(value.contractVersion) && value.contractVersion > 0, 'invalid contract version');
  return value;
}

/** Unknown versions remain exact inert bytes for read/copy/export; writes fail closed. */
export function admitProfile(input, { mode = 'read', supported = [] } = {}) {
  demand(['read', 'copy', 'export', 'write'].includes(mode), 'unknown profile operation');
  demand(typeof input === 'string' || input instanceof Uint8Array, 'profile must be serialized data');
  const bytes = Buffer.from(input), raw = boundedJSON(bytes);
  if (raw.contractVersion !== PROFILE_VERSION) {
    demand(mode !== 'write', 'unsupported contract version: preserve/export with a compatible reader');
    return { kind: 'preserved', reason: 'unsupported-contract-version', bytes, writable: false };
  }
  validateProfile(raw);
  const known = supported.some(p => { validateProfile(p); return versionIdentity(p) === versionIdentity(raw); });
  if (!known) {
    demand(mode !== 'write', 'unsupported version tuple: preserve/export with a compatible reader');
    return { kind: 'preserved', reason: 'unsupported-version-tuple', bytes, writable: false };
  }
  // Imported state is informational. Even a known tuple does not activate providers.
  return { kind: 'known', profile: raw, bytes, writable: mode === 'write' };
}

/** A caller supplies current principal-specific host answers; imported authorization is never used. */
export function resolveCapability(profile, id, host) {
  validateProfile(profile);
  const capability = profile.capabilities.find(c => c.id === id);
  demand(capability, 'unknown capability');
  demand(host && typeof host.principal === 'string' && host.principal.length > 0 &&
    typeof host.available === 'boolean' && typeof host.enabled === 'boolean' &&
    Array.isArray(host.permissions) && host.permissions.every(p => typeof p === 'string'), 'current host answer required');
  const available = capability.state.available && host.available;
  const enabled = available && capability.state.enabled && host.enabled;
  const authorized = capability.permissions.every(p => host.permissions.includes(p));
  return { available, enabled, authorized, qualified: capability.state.qualified,
    usable: available && enabled && authorized && capability.state.qualified };
}
