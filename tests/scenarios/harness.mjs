import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { root } from './run.mjs';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareProductHarness(output, facts, scenario) {
  const build = join(output, 'build'), consumer = join(output, 'consumer');
  await mkdir(build, { recursive: true }); await mkdir(consumer);
  async function run(command, args, cwd, label, env = {}) {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    await writeFile(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    facts.commands.push({ command: [command, ...args], cwd, exit: result.status, error: result.error?.message, log: label + '.log' });
    assert.ifError(result.error); assert.equal(result.status, 0, label + ': see log');
    return result.stdout;
  }
  facts.sourceRevision = (await run('git', ['rev-parse', 'HEAD'], root, 'source-revision')).trim();
  facts.sourceTree = (await run('git', ['rev-parse', 'HEAD^{tree}'], root, 'source-tree')).trim();
  const reusePath = process.env.EDITAC_PRODUCT_PACK_RECEIPT;
  if (reusePath) {
    const bytes = await readFile(resolve(reusePath)), prior = JSON.parse(bytes);
    const sdkPaths = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.node-version', 'crates', 'packages', 'scripts', 'fixtures', 'licenses', 'LICENSE', 'README.md'];
    const packageRevision = prior.packageSourceRevision ?? prior.sourceRevision;
    // Product fixtures are captured separately; they do not enter SDK compilation.
    const sdkPathspec = [...sdkPaths, ':(exclude)fixtures/product-scenarios'];
    await run('git', ['diff', '--exit-code', packageRevision, facts.sourceRevision, '--', ...sdkPathspec], root, 'reuse-sdk-committed-inputs');
    facts.packageSourceRevision = packageRevision;
    assert.equal(prior.toolchains.node, process.versions.node);
    assert.deepEqual(prior.packs.map(pack => pack.name), ['core', 'web']);
    facts.toolchains = prior.toolchains;
    facts.packs = prior.packs;
    facts.reusedPackageReceipt = { path: resolve(reusePath), sha256: sha(bytes), scope: 'SDK build/install inputs only; no failed browser case reused' };
    for (const pack of facts.packs) {
      const path = resolve(reusePath, '..', pack.file);
      assert.equal(sha(await readFile(path)), pack.sha256, 'Reused tarball changed');
      await cp(path, join(output, pack.file));
    }
  } else {
  await run('git', ['archive', '--format=tar', '--output=' + join(output, 'sdk-source.tar'), facts.sourceRevision, 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.node-version', 'crates', 'packages', 'scripts', 'fixtures', 'licenses', 'LICENSE', 'README.md'], root, 'source-archive');
  await run('tar', ['-xf', join(output, 'sdk-source.tar'), '-C', build], root, 'source-extract');
  facts.toolchains = { node: process.versions.node, npm: (await run('npm', ['--version'], root, 'npm-version')).trim(), rust: (await run('rustc', ['--version'], build, 'rust-version')).trim() };
  assert.equal(facts.toolchains.npm, '11.17.0'); assert.match(facts.toolchains.rust, /^rustc 1\.97\.1 /);
  await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], build, 'build-install');
  await run(process.execPath, ['scripts/build-wasm.mjs'], build, 'build-wasm', { CARGO_TARGET_DIR: join(build, 'target') });
  await run('npm', ['run', 'build', '--workspace=@edit-ac/web'], build, 'build-web');
  facts.packs = [];
  for (const name of ['core', 'web']) {
    const [pack] = JSON.parse(await run('npm', ['pack', '--workspace=@edit-ac/' + name, '--pack-destination=' + output, '--json'], build, 'pack-' + name));
    facts.packs.push({ name, file: pack.filename, sha256: sha(await readFile(join(output, pack.filename))) });
  }
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: Object.fromEntries(facts.packs.map(p => ['@edit-ac/' + p.name, 'file:' + join(output, p.file)])) }));
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, 'consumer-install');
  for (const pack of facts.packs) assert.equal(await realpath(join(consumer, 'node_modules/@edit-ac', pack.name)), join(consumer, 'node_modules/@edit-ac', pack.name));
  if (scenario.packages?.includes('react')) {
    // Build the actual public React wrapper from an immutable committed archive,
    // using the same installed core/web declarations and pinned lock/toolchain.
    if (reusePath) {
      await run('git', ['archive', '--format=tar', '--output=' + join(output, 'react-source.tar'), facts.sourceRevision, 'package.json', 'package-lock.json', 'tsconfig.base.json', 'packages', 'licenses', 'LICENSE', 'README.md'], root, 'react-source-archive');
      await run('tar', ['-xf', join(output, 'react-source.tar'), '-C', build], root, 'react-source-extract');
      await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], build, 'react-build-install');
      for (const name of ['core','web']) await cp(join(consumer,'node_modules/@edit-ac',name,'dist'),join(build,'packages',name,'dist'),{recursive:true});
    }
    await run('npm', ['run','build','--workspace=@edit-ac/react'], build, 'build-react');
    const [pack]=JSON.parse(await run('npm',['pack','--workspace=@edit-ac/react','--pack-destination='+output,'--json'],build,'pack-react'));
    facts.packs.push({name:'react',file:pack.filename,sha256:sha(await readFile(join(output,pack.filename)))});
    await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{...Object.fromEntries(facts.packs.map(p=>['@edit-ac/'+p.name,'file:'+join(output,p.file)])),react:'19.3.0','react-dom':'19.3.0',esbuild:'0.25.12'}}));
    await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund'],consumer,'react-consumer-install');
    for(const name of ['core','web','react']) assert.equal(await realpath(join(consumer,'node_modules/@edit-ac',name)),join(consumer,'node_modules/@edit-ac',name));
  }
  const site = join(output, 'site'); await mkdir(site);
  facts.sources = [];
  for (const path of [...scenario.fixtures, ...(scenario.supportingSources??[]), 'fixtures/product-scenarios/web/manifest.json', 'tests/scenarios/run.mjs', 'tests/scenarios/harness.mjs', scenario.command[1], 'tests/browser/fixture-server.mjs']) {
    const bytes = await readFile(join(root, path)); facts.sources.push({ path, sha256: sha(bytes) });
    if (scenario.fixtures.includes(path)) { await mkdir(join(site, 'fixture'), { recursive: true }); await writeFile(join(site, 'fixture', path.split('/').at(-1)), bytes); }
  }
  for (const pack of facts.packs) await cp(join(consumer, 'node_modules/@edit-ac', pack.name, 'dist'), join(site, pack.name), { recursive: true });
  if(scenario.packages?.includes('react')) {
    const source=join(consumer,'product');await cp(join(site,'fixture'),source,{recursive:true});
    await run(process.execPath,[join(consumer,'node_modules/esbuild/bin/esbuild'),'product/react.mjs','product/react-lifecycle.mjs','--bundle','--format=esm','--splitting','--outdir='+join(site,'fixture'),'--entry-names=[name]-built','--out-extension:.js=.mjs','--chunk-names=chunks/[name]-[hash]','--external:@edit-ac/markdown','--external:@edit-ac/markdown/web','--metafile='+join(output,'react-graph.json')],consumer,'bundle-react');
    facts.reactGraphSha256=sha(await readFile(join(output,'react-graph.json')));
    facts.sources.push({path:'packages/react/src/index.ts',sha256:sha(await readFile(join(build,'packages/react/src/index.ts')))});
  }
  facts.artifacts = [];
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else { const bytes = await readFile(path); facts.artifacts.push({ path: path.slice(output.length + 1), bytes: bytes.length, sha256: sha(bytes) }); }
    }
  }
  await inventory(site);
  facts.packageLockSha256 = sha(await readFile(join(consumer, 'package-lock.json')));
  return { site, build, consumer };
}
