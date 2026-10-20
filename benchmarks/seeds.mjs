import { createHash } from 'node:crypto';
import { fixture, expectedSemantics, projectedSemantics } from './fixtures.mjs';

export const seedHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Failed browser measurements may still contain complete prepared seeds. Admit
// preparation independently; never inherit their scenario/qualification status.
export function admitSeed(name, prior, currentInputs, executable, artifacts) {
  const require = (condition, message) => { if (!condition) throw Error(message); };
  const nativeInputs = Object.entries(currentInputs).filter(([path]) =>
    path.startsWith('crates/') || path.startsWith('fixtures/schema-v5/') || /^(Cargo\.(lock|toml)|rust-toolchain.toml)$/.test(path));
  require(nativeInputs.length > 0 && nativeInputs.every(([path, hash]) => prior.sourceInputs?.[path] === hash), 'Seed native source identity drift');
  require(prior.metadata?.seedProducer?.sha256 === seedHash(executable), 'Seed executable identity drift');
  const document = fixture(name);
  const paths = { checkpoint: `fixtures/${name}.native-checkpoint.json`,
    snapshot: `fixtures/${name}.native-snapshot.json`, log: `seed-${name}.log` };
  require(prior.fixtures?.find(item => item.name === name)?.sha256 === seedHash(artifacts.fixture), 'Seed fixture receipt identity drift');
  require(prior.artifactInputs?.['harness/fitness-seed'] === seedHash(executable), 'Seed executable receipt identity drift');
  for (const [key, path] of Object.entries(paths)) {
    require(prior.artifactInputs?.[path] === seedHash(artifacts[key]), `Seed ${key} receipt identity drift`);
  }
  require(artifacts.fixture.toString() === JSON.stringify(document), 'Seed fixture identity drift');
  require(artifacts.log.toString().includes('seed: 1/1 fixture prepared; 0 failures/skips'), 'Incomplete seed preparation');
  const snapshot = JSON.parse(artifacts.snapshot), frozen = JSON.parse(artifacts.checkpoint);
  require(JSON.stringify(projectedSemantics(snapshot)) === JSON.stringify(expectedSemantics(document)), 'Seed semantic oracle mismatch');
  require(frozen.checkpoint?.initialized === true && JSON.stringify(frozen.identity) === JSON.stringify(frozen.checkpoint.identity)
    && Array.isArray(frozen.checkpoint.bytes) && frozen.checkpoint.bytes.length > 0
    && frozen.checkpoint.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Invalid seed checkpoint envelope');
  require(frozen.identity.documentId === `00000000-0000-4000-8000-${document.seed.toString(16).padStart(12, '0')}`
    && frozen.identity.epoch === `00000000-0000-4000-9000-${document.seed.toString(16).padStart(12, '0')}`, 'Seed checkpoint identity drift');
  return { frozen, receipt: { scope: 'Reused public-native preparation only; browser semantics independently checked',
    nativeInputs: Object.fromEntries(nativeInputs), executableHash: seedHash(executable),
    hashes: Object.fromEntries(Object.entries(artifacts).map(([key, bytes]) => [key, seedHash(bytes)])) } };
}
