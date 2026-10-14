// Explicit deterministic preparation only. Validation never records/replaces fixtures.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import * as v4 from '../fixtures/schema-v4/mapping.mjs';
import * as v5 from '../fixtures/schema-v5/mapping.mjs';
import { hash } from './architecture-layers.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'fixtures/compatibility');
if (process.argv[2] !== '--prepare' || process.argv.length !== 3) throw Error('Explicit --prepare required');
mkdirSync(dir, { recursive: true });
function freezeFile(file, bytes) {
  const path = resolve(dir, file);
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== hash(bytes)) throw Error(`Refusing to replace frozen fixture: ${file}; review a new fixture identity instead`);
  } else writeFileSync(path, bytes);
}
const revisions = { previous: '8f1eec24a4c3863a31cc00e6d91384b23f2c2355', current: 'f25b08ab6cca6b967f9c0109030952f71a3778a4' };
function git(args) { const r = spawnSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }); if (r.status !== 0) throw Error(r.stderr.toString()); return r.stdout; }
// Complete portable execution closure, not just selected public signatures.
const roots = ['Cargo.toml', 'Cargo.lock', 'crates/editac-core', 'crates/editac-ffi', 'crates/editac-wasm', 'crates/editac-markdown', 'crates/editac-diff', 'packages/core', 'fixtures/schema-v4', 'fixtures/schema-v5', '.node-version', 'rust-toolchain.toml', 'tsconfig.base.json', 'scripts/build-wasm.mjs', 'scripts/share-wasm-glue.mjs', 'scripts/build-wasm-notices.mjs', 'scripts/licenses/yrs-0.28.0.LICENSE', 'fixtures/modules/registration.json'];
const files = git(['ls-tree', '-r', '--name-only', revisions.previous, '--', ...roots]).toString().trim().split('\n').filter(p => !p.includes('/tests/') && !p.includes('/benches/') && !p.endsWith('/README.md'));
const closure = {};
for (const path of files) {
  const previous = hash(git(['show', `${revisions.previous}:${path}`]));
  const current = hash(git(['show', `${revisions.current}:${path}`]));
  if (previous !== current || hash(readFileSync(resolve(root, path))) !== current) throw Error(`Executable closure changed: ${path}`);
  closure[path] = current;
}
const versions = { semanticSchema: v5.profile.schema, updateSync: v5.profile.profile, protocolVersion: 1, updateEncoding: 1, offsets: 'utf16', extensionDescriptor: 1, publicApi: 1, nativeAbi: 1 };
const locks = Object.fromEntries(Object.entries(revisions).map(([id, revision]) => [id, hash(git(['show', `${revision}:package-lock.json`]))]));
const packageClosure = revision => {
  const packages = JSON.parse(git(['show', `${revision}:package-lock.json`])).packages;
  delete packages['']; // Workspace dev-tool declaration added Babel; resolved packages are unchanged.
  return hash(JSON.stringify(packages));
};
if (packageClosure(revisions.previous) !== packageClosure(revisions.current)) throw Error('Resolved JS dependencies changed');
const fixtures = {};
for (const [name, mapper] of [['v4', v4], ['v5', v5]]) {
  const doc = mapper.construct();
  // Persist a real structural version-specific operation, not only a version label.
  mapper.split(doc, 'o:11:90', 'n:11:1', 0, 1);
  const unknownSource = mapper.roots(doc)['registry-texts'].get('n:11:2');
  unknownSource.format(0, unknownSource.length, { 'module:future.unknown': [37, { nested: ['keep', { value: 9 }] }] });
  const base = Y.encodeStateAsUpdate(doc);
  const vector = Y.encodeStateVector(doc);
  const source = mapper.roots(doc)['registry-texts'].get('n:11:2');
  source.insert(0, 'journal:');
  const journal = Y.encodeStateAsUpdate(doc, vector);
  const projection = mapper.snapshot(doc);
  const metadata = { identity: mapper.seed.envelope, initialized: true, writerId: mapper.seed.writer };
  const manifest = { ...metadata, journal: { identity: metadata.identity }, expectedTexts: projection.visible.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.insert).join('')), unknown: { key: 'ext:future', value: { retained: true } } };
  for (const [file, bytes] of [[`${name}.bin`, base], [`${name}-journal.bin`, journal], [`${name}.json`, JSON.stringify(manifest, null, 2) + '\n']]) {
    freezeFile(file, bytes); fixtures[file] = hash(bytes);
  }
  doc.destroy();
}
const definition = JSON.parse(readFileSync(resolve(root, 'fixtures/modules/registration.json'))).definitions[0];
freezeFile('descriptor.json', JSON.stringify({ definition, future: [2, { futureField: 'opaque-retained' }], unknown: [37, { nested: ['keep', { value: 9 }] }] }, null, 2) + '\n');
fixtures['descriptor.json'] = hash(readFileSync(resolve(dir, 'descriptor.json')));
const policy = { version: 1, scope: 'Only these reviewed source revisions; unpublished portable preparation, not all historical versions or native SDK qualification', endpoints: Object.fromEntries(Object.entries(revisions).map(([id, revision]) => [id, { revision, versions }])), closure,
  locks, resolvedPackagesHash: packageClosure(revisions.current), fixtures, legacy: { semanticSchema: v4.profile.schema, updateSync: v4.profile.profile, migration: 'unqualified; matching-v4-reader-or-export-before-explicit-new-epoch', runtime: 'Rust Document + qualified Yjs mapper only; public SDK/FFI reject v4' } };
freezeFile('policy.json', JSON.stringify(policy, null, 2) + '\n');
console.log(JSON.stringify({ fixtures: Object.keys(fixtures).length, closure: Object.keys(closure).length, endpoints: revisions }));
