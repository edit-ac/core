import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoGraph, jsGraph, imports, validatePolicy, checkLayers, hash } from '../../../scripts/architecture-layers.mjs';
import { selectSuite, testCounts } from '../../../scripts/check-architecture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/production-graph.json', import.meta.url)));
const fresh = () => structuredClone(fixture);
const edge = (pkg, kind = null) => ({ pkg, name: 'renamed_dependency', dep_kinds: [{ kind, target: null }] });

test('Cargo: explicit engine, SDK and companion graph passes', () => {
  const { metadata, policy } = fresh(), graph = cargoGraph(metadata, policy);
  assert.equal(graph.members, 3);
  assert.deepEqual(graph.closures.engine.map(p => p.name), ['engine', 'primitive']);
  assert.equal(graph.edges.length, 3);
});

test('Cargo: seeded forbidden-layer fixture rejects a renamed runtime dependency', async () => {
  const { metadata, policy } = fresh();
  const negative = JSON.parse(await readFile(new URL('./fixtures/forbidden-layer.json', import.meta.url)));
  metadata.resolve.nodes.find(n => n.id === negative.fromPackage).deps.push(edge(negative.toPackage, negative.kind));
  assert.throws(() => cargoGraph(metadata, policy), /Forbidden layer edge engine -> companion/);
});

for (const kind of [null, 'build']) test(`Cargo: transitive forbidden runtime through ${kind ?? 'normal'} edge fails`, () => {
  const { metadata, policy } = fresh();
  metadata.packages.push({ id: 'http', name: 'http-runtime', version: '1', source: 'registry+fixture' });
  metadata.resolve.nodes.push({ id: 'http', deps: [] });
  metadata.resolve.nodes.find(n => n.id === 'primitive').deps.push(edge('http', kind));
  assert.throws(() => cargoGraph(metadata, policy), /Unreviewed minimum Cargo dependency engine -> http-runtime/);
});

test('Cargo: dev-only companion fixture does not contaminate production closure', () => {
  const { metadata, policy } = fresh(); metadata.resolve.nodes[0].deps.push(edge('companion', 'dev'));
  const graph = cargoGraph(metadata, policy);
  assert.equal(graph.devEdges.length, 1);
  assert.equal(graph.closures.engine.length, 2);
});

for (const [name, mutate, error] of [
  ['build dependency', m => m.resolve.nodes[0].deps.push(edge('companion', 'build')), /Forbidden layer/],
  ['unowned workspace member', m => m.workspace_members.push('primitive'), /Unowned Cargo/],
  ['missing owner', m => m.workspace_members.pop(), /Missing Cargo owner/],
  ['unknown kind', m => m.resolve.nodes[0].deps[0].dep_kinds[0].kind = 'mystery', /Unknown Cargo dependency kind/],
  ['missing resolved node', m => m.resolve.nodes.pop(), /Incomplete Cargo closure/],
  ['empty metadata', m => m.packages = [], /Empty Cargo/],
  ['unowned path dependency', m => m.packages.at(-1).source = null, /Unowned Cargo path/],
  ['wrong manifest owner', m => m.packages[0].manifest_path = '/fixture/wrong/Cargo.toml', /owner path mismatch/],
  ['disabled optional dependency', m => m.packages[0].dependencies.push({ name: 'cloud-sdk', kind: null, optional: true }), /Forbidden layer/],
]) test(`Cargo: ${name} fails closed`, () => {
  const { metadata, policy } = fresh(); mutate(metadata);
  assert.throws(() => cargoGraph(metadata, policy), error);
});

for (const [name, mutate, error] of [
  ['unknown version', p => p.version++, /Unknown layer manifest/],
  ['duplicate ownership', p => p.components.push(p.components[0]), /Duplicate/],
  ['unknown companion', p => p.components[0].allowedInternal.push('missing'), /Unknown companion/],
  ['unknown minimum root', p => p.minimumCargoRoots.push('missing'), /Unknown minimum root/],
  ['zero ownership', p => p.components = [], /Empty layer ownership/],
]) test(`Manifest: ${name} fails closed`, () => {
  const { policy } = fresh(); mutate(policy); assert.throws(() => validatePolicy(policy), error);
});

async function jsFixture(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'editac-fit-layers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { policy } = fresh();
  const put = async (path, text) => { await mkdir(resolve(dir, path, '..'), { recursive: true }); await writeFile(resolve(dir, path), typeof text === 'string' ? text : JSON.stringify(text)); };
  await put('package.json', { workspaces: ['packages/core', 'packages/web'] });
  await put('packages/core/package.json', { name: '@fixture/core' });
  await put('packages/web/package.json', { name: '@fixture/web', dependencies: { '@fixture/core': '1' } });
  await put('packages/core/src/index.ts', 'export const engine = 1;');
  await put('packages/web/src/index.ts', 'import {engine} from "@fixture/core"; export {engine};');
  return { dir, policy, put };
}

test('JS: real source and manifest declarations share explicit owners', async t => {
  const { dir, policy } = await jsFixture(t); const graph = await jsGraph(dir, policy);
  assert.equal(graph.members, 2); assert.equal(graph.files, 2); assert.equal(graph.edges.length, 2);
});

for (const source of [
  'import x from "@fixture/web";', 'import "@fixture/web";', 'export * from "@fixture/web";',
  'import type {X} from "@fixture/web";', 'type X = import("@fixture/web").X;',
  'void import("@fixture/web" as string);', 'void import(("@fixture/web"));',
  'const x = require("@fixture/web");', 'import x = require("@fixture/web");',
]) test(`JS: forbidden source edge (${source}) fails`, async t => {
  const { dir, policy, put } = await jsFixture(t); await put('packages/core/src/index.ts', source);
  await assert.rejects(jsGraph(dir, policy), /Forbidden layer edge @fixture\/core -> @fixture\/web/);
});

test('JS: import strings in comments and ordinary text create no false edge', () => {
  assert.deepEqual(imports('// import "cloud-sdk";\nconst s = "require(\\"http\\")";', 'source.ts'), []);
});

test('JS: uniquely bound const import.meta URL alias is statically bounded', () => {
  assert.deepEqual(imports('const glue = new URL("./runtime.js", import.meta.url).href; void import(glue);', 'fixture.ts'), [{ specifier: './runtime.js', kind: 'dynamic' }]);
});
for (const suffix of ['function shadow(glue) { return import(glue); }', 'glue = userInput;', 'function f(URL) { return import(glue); }']) test(`JS: ambiguous URL alias rejects (${suffix})`, () => {
  assert.throws(() => imports(`const glue = new URL("./runtime.js", import.meta.url).href; void import(glue); ${suffix}`, 'fixture.ts'), /Unbounded/);
});

test('JS: Astro frontmatter and script imports both enter the graph', () => {
  assert.equal(imports('---\nimport "a";\n---\n<p>x</p><script>import "b";</script>', 'Editor.astro').length, 2);
});

for (const source of ['void import(target);', 'require(target);', 'void import(`cloud-${name}`);']) test(`JS: computed imports cannot evade ownership (${source})`, async t => {
  const { dir, policy, put } = await jsFixture(t); await put('packages/core/src/index.ts', source);
  await assert.rejects(jsGraph(dir, policy), /Unbounded dynamic import/);
});

for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) test(`JS: forbidden ${kind} rejected without source imports`, async t => {
  const { dir, policy, put } = await jsFixture(t); await put('packages/core/package.json', { name: '@fixture/core', [kind]: { 'cloud-sdk': '1' } });
  await assert.rejects(jsGraph(dir, policy), /Forbidden layer/);
});

test('JS: dev-only package is not authorized as a runtime import', async t => {
  const { dir, policy, put } = await jsFixture(t); policy.components.find(c => c.name === '@fixture/core').allowedExternal.push('tool');
  await put('packages/core/package.json', { name: '@fixture/core', devDependencies: { tool: '1' } });
  await put('packages/core/src/index.ts', 'import "tool";');
  await assert.rejects(jsGraph(dir, policy), /Undeclared JS import/);
});

for (const [name, path, content, error] of [
  ['unresolved relative import', 'packages/core/src/index.ts', 'import "./missing.js";', /Unresolved JS/],
  ['network builtin', 'packages/core/src/index.ts', 'import "node:https";', /Forbidden layer/],
  ['remote module', 'packages/core/src/index.ts', 'import "https:\/\/example.test/module.js";', /Forbidden layer/],
  ['private cross-package source', 'packages/web/src/index.ts', 'import "../../core/src/index.js";', /Private workspace source/],
  ['unowned workspace', 'package.json', { workspaces: ['packages/core', 'packages/web', 'packages/cloud'] }, /Unowned JS workspace/],
  ['globbed workspace', 'package.json', { workspaces: ['packages/*'] }, /Unsupported JS workspace/],
  ['wrong package identity', 'packages/core/package.json', { name: 'imposter' }, /owner path mismatch/],
]) test(`JS: ${name} fails closed`, async t => {
  const { dir, policy, put } = await jsFixture(t); await put(path, content); await assert.rejects(jsGraph(dir, policy), error);
});

test('JS: source symlink cannot bypass owner checks', async t => {
  const { dir, policy } = await jsFixture(t); await symlink(resolve(dir, 'packages/web/src/index.ts'), resolve(dir, 'packages/core/src/hidden.ts'));
  await assert.rejects(jsGraph(dir, policy), /Source symlink/);
});

test('JS: explicit generated WASM binding maps to its Cargo producer', async t => {
  const { dir, policy, put } = await jsFixture(t); await put('packages/core/src/runtime.ts', 'void import("./wasm/runtime.js" as string);');
  assert.ok((await jsGraph(dir, policy)).edges.some(e => e.kind === 'generated-binding' && e.to === 'sdk'));
});

test('JS: relative imports resolve .js to owned .ts source', async t => {
  const { dir, policy, put } = await jsFixture(t); await put('packages/core/src/runtime.ts', 'export * from "./index.js";');
  assert.ok((await jsGraph(dir, policy)).edges.some(e => e.target === 'packages/core/src/index.ts'));
});

async function vendorFixture(t) {
  const f = await jsFixture(t), source = 'export default function render() {}';
  f.policy.components.find(c => c.name === '@fixture/web').allowedExternal.push('renderer');
  f.policy.generatedVendors = [{ importer: 'packages/web/src/index.ts', specifier: './vendor/renderer.mjs', package: 'renderer', version: '1.0.0', source: 'node_modules/renderer/index.js', sha256: hash(source), builder: 'scripts/build-renderer.mjs' }];
  await f.put('packages/web/src/index.ts', 'import render from "./vendor/renderer.mjs";');
  await f.put('packages/web/package.json', { name: '@fixture/web', devDependencies: { renderer: '1.0.0' } });
  await f.put('node_modules/renderer/package.json', { name: 'renderer', version: '1.0.0' });
  await f.put('node_modules/renderer/index.js', source);
  await f.put('scripts/build-renderer.mjs', '// Owner build recipe');
  return f;
}
test('JS: generated vendor is explicit even when installed as a build dependency', async t => {
  const { dir, policy } = await vendorFixture(t);
  assert.ok((await jsGraph(dir, policy)).edges.some(e => e.to === 'renderer' && e.kind === 'generated-vendor'));
});
test('JS: changed generated vendor bytes reject', async t => {
  const { dir, policy, put } = await vendorFixture(t); await put('node_modules/renderer/index.js', 'export const changed = true;');
  await assert.rejects(jsGraph(dir, policy), /Unverified generated vendor/);
});
test('JS: unpinned generated vendor rejects', async t => {
  const { dir, policy, put } = await vendorFixture(t); await put('packages/web/package.json', { name: '@fixture/web', devDependencies: { renderer: '^1' } });
  await assert.rejects(jsGraph(dir, policy), /Unpinned generated vendor/);
});
test('JS: generated vendor acquiring dependencies needs an explicit graph review', async t => {
  const { dir, policy, put } = await vendorFixture(t), source = 'import "network-runtime";';
  policy.generatedVendors[0].sha256 = hash(source); await put('node_modules/renderer/index.js', source);
  await assert.rejects(jsGraph(dir, policy), /acquired module imports/);
});
test('JS: generated web vendor cannot enter minimum SDK', async t => {
  const { dir, policy, put } = await vendorFixture(t);
  policy.generatedVendors[0].importer = 'packages/core/src/index.ts';
  await put('packages/core/src/index.ts', 'import render from "./vendor/renderer.mjs";');
  await assert.rejects(jsGraph(dir, policy), /Forbidden layer edge @fixture\/core -> renderer/);
});

test('Dispatcher: registered nonempty suite selected', () => assert.equal(selectSuite({ suites: { layers: { tests: ['tests/architecture/layers/layers.test.mjs'] } } }, ['--suite', 'layers']).tests.length, 1));
for (const args of [[], ['--suite', 'missing'], ['--suite', 'layers', '--ignored']]) test(`Dispatcher: unknown arguments ${JSON.stringify(args)} reject`, () => assert.throws(() => selectSuite({ suites: {} }, args), /registered/));
test('Dispatcher: empty suite rejects', () => assert.throws(() => selectSuite({ suites: { empty: { tests: [] } } }, ['--suite', 'empty']), /Zero/));
test('Dispatcher: CLI rejects an unknown suite with a nonzero exit', () => {
  const result = spawnSync(process.execPath, ['scripts/check-architecture.mjs', '--suite', 'not-a-suite'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /registered architecture suite/);
});
test('Dispatcher: traversal in suite paths rejects', () => assert.throws(() => selectSuite({ suites: { bad: { tests: ['tests/architecture/../bad.test.mjs'] } } }, ['--suite', 'bad']), /Invalid/));
const tap = counts => Object.entries({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...counts }).map(([k, v]) => `# ${k} ${v}`).join('\n');
test('Dispatcher: nonzero complete execution accepted', () => assert.equal(testCounts(tap({})).pass, 1));
for (const counts of [{ tests: 0, pass: 0 }, { skipped: 1 }, { fail: 1, pass: 0 }, { cancelled: 1 }, { todo: 1 }]) test(`Dispatcher: incomplete counts ${JSON.stringify(counts)} reject`, () => assert.throws(() => testCounts(tap(counts)), /Incomplete/));
test('Dispatcher: absent counts reject', () => assert.throws(() => testCounts(''), /Incomplete/));

test('Repository: locked/offline Cargo and actual JS production graphs satisfy layer ownership', async () => {
  const policy = JSON.parse(await readFile(resolve(root, 'contracts/layers.json')));
  const result = await checkLayers(root, policy);
  assert.equal(result.cargo.members, 7); assert.equal(result.js.members, 5);
  assert.ok(result.js.files > 0); assert.ok(result.cargo.edges.length > 0); assert.ok(result.js.edges.length > 0);
  assert.ok(result.cargo.devEdges.some(e => e.from === 'editac-core' && e.to === 'editac-markdown'));
  const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
  if (output) await writeFile(resolve(output, 'layers-graph.json'), JSON.stringify(result, null, 2) + '\n');
});
