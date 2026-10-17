import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const output = resolve(process.env.EDITAC_FORMATS_OUTPUT ?? '.artifacts/formats/docx-dependencies');
mkdirSync(output, { recursive: true });
const manifest = 'crates/editac-formats/Cargo.toml';
const record = JSON.parse(readFileSync('fixtures/formats/docx/probe/dependencies.json'));
const receipts = [];
function run(program, args, name) {
  const start = performance.now();
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(resolve(output, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  receipts.push({ program, args, exit: result.status, signal: result.signal, durationMs: performance.now() - start, log: name + '.log' });
  writeFileSync(resolve(output, 'target-commands.json'), JSON.stringify(receipts, null, 2) + '\n');
  assert.ifError(result.error);
  assert.equal(result.status, 0, name + ': see complete log');
  return result.stdout;
}
function metadata(features) {
  return JSON.parse(run('cargo', ['metadata', '--manifest-path', manifest, '--locked', '--offline', '--format-version', '1', ...features], features.length ? 'enabled-metadata' : 'default-metadata'));
}

test('reviewed exact optional graph excludes image decoding and native codecs', () => {
  const m = metadata(['--features', 'docx-codecs']);
  const nodes = new Map(m.resolve.nodes.map(n => [n.id, n]));
  for (const [name, selected] of Object.entries(record.stack)) {
    const packages = m.packages.filter(p => p.name === name);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].version, selected.version);
    assert.equal(packages[0].license, selected.license);
    const features = nodes.get(packages[0].id).features;
    for (const feature of selected.requiredFeatures) assert.ok(features.includes(feature), name + ':' + feature);
    for (const feature of selected.forbiddenFeatures) assert.ok(!features.includes(feature), name + ':' + feature);
  }
  for (const name of record.forbiddenPackages) assert.ok(!m.packages.some(p => p.name === name), name);
  assert.equal(record.productionAvailable, false);
});

test('disabled registry and minimum editor do not acquire converter packages', () => {
  const m = metadata([]);
  const root = m.resolve.nodes.find(n => n.id === m.resolve.root);
  assert.equal(root.deps.filter(d => d.dep_kinds.some(k => k.kind !== 'dev')).length, 0);
  for (const name of Object.keys(record.stack)) assert.ok(!m.packages.some(p => p.name === name));
  const minimum = JSON.parse(run('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'], 'minimum-editor-metadata'));
  assert.ok(!minimum.packages.some(p => p.name === 'editac-formats'));
  for (const p of minimum.packages) assert.ok(!p.dependencies.some(d => Object.hasOwn(record.stack, d.name) || d.name === 'editac-formats'), p.name);
  const lock = readFileSync('Cargo.lock', 'utf8');
  for (const name of Object.keys(record.stack)) assert.ok(!lock.includes(`name = "${name}"`));
});

test('same read write media ZIP XML probe compiles for claimed WASM target', () => {
  run('cargo', ['build', '--manifest-path', manifest, '--locked', '--offline', '--features', 'docx-codecs', '--example', 'docx_probe', '--target', 'wasm32-unknown-unknown'], 'wasm-compile');
  const target = resolve(process.env.CARGO_TARGET_DIR ?? 'crates/editac-formats/target');
  const artifact = resolve(target, 'wasm32-unknown-unknown/debug/examples/docx_probe.wasm');
  assert.ok(statSync(artifact).size > 8);
  assert.deepEqual([...readFileSync(artifact).subarray(0, 4)], [0, 97, 115, 109]);
  receipts.push({ artifact, bytes: statSync(artifact).size, claim: 'debug compile probe only; not runtime, packed size or converter performance' });
  writeFileSync(resolve(output, 'target-commands.json'), JSON.stringify(receipts, null, 2) + '\n');
});

test('independent Python ZIP/XML reader verifies actual native writer output', () => {
  const artifact = resolve(output, 'writer.docx');
  assert.ok(statSync(artifact).size > 0, 'native candidate suite must produce artifact first');
  run('python3', ['tests/formats/inspect-docx.py', artifact, 'fixtures/formats/docx/probe/pixel.png'], 'independent-package-reader');
});
