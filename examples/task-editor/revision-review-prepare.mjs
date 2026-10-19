import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from '../../tests/scenarios/run.mjs';
import { sha } from '../../tests/scenarios/harness.mjs';

/** Compose fresh owned fixtures with authenticated, unchanged installed SDK bytes.
 * This receipt records preparation only; every browser assertion executes afresh. */
export async function prepareInstalledRevisionSite(output, scenario, priorPath) {
  const priorBytes = await readFile(resolve(priorPath)), prior = JSON.parse(priorBytes);
  assert.equal(prior.prepared, true); assert.equal(prior.toolchains.node, process.versions.node);
  const sdkPaths = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.node-version', 'crates', 'packages', 'scripts', 'fixtures', 'licenses', 'LICENSE', 'README.md'];
  const proofOnly = new Set(['scripts/run-web-assistance-ai-refresh-boundary.mjs', 'scripts/run-web-assistance-current-inputs-boundary.mjs', 'scripts/run-web-conversion-current-inputs-boundary.mjs', 'scripts/run-web-editing-media-table-refresh-boundary.mjs', 'scripts/run-web-markdown-touch-conversion-refresh-boundary.mjs']);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const sourceRevision = git('rev-parse', 'HEAD');
  const packageSourceRevision = prior.packageSourceRevision ?? prior.sourceRevision;
  const differences = git('diff', '--name-only', packageSourceRevision, sourceRevision, '--', ...sdkPaths).split('\n').filter(Boolean);
  assert.ok(differences.every(p => p.startsWith('fixtures/product-scenarios/') || proofOnly.has(p)), 'SDK compilation inputs changed; prepare new packages');
  for (const artifact of prior.artifacts) assert.equal(sha(await readFile(join(prior.output, artifact.path))), artifact.sha256, 'Installed source artifact changed: ' + artifact.path);
  const packs = prior.packs.filter(p => ['core', 'web'].includes(p.name));
  assert.deepEqual(packs.map(p => p.name), ['core', 'web']);
  for (const pack of packs) {
    assert.equal(sha(await readFile(join(prior.output, pack.file))), pack.sha256);
    const installed = join(prior.output, 'consumer/node_modules/@edit-ac', pack.name);
    assert.equal(await realpath(installed), installed, 'Installed package must not be a source alias');
    await cp(join(prior.output, pack.file), join(output, pack.file));
  }
  const site = join(output, 'site'); await mkdir(site);
  for (const name of ['core', 'web']) await cp(join(prior.output, 'site', name), join(site, name), { recursive: true });
  const sources = [];
  for (const path of new Set([...scenario.fixtures, ...(scenario.supportingSources ?? []), 'fixtures/product-scenarios/web/manifest.json', 'tests/scenarios/run.mjs', 'tests/scenarios/harness.mjs', scenario.command[1], 'tests/browser/fixture-server.mjs'])) {
    const bytes = await readFile(join(root, path)); sources.push({ path, sha256: sha(bytes) });
    if (scenario.fixtures.includes(path)) { await mkdir(join(site, 'fixture'), { recursive: true }); await writeFile(join(site, 'fixture', path.split('/').at(-1)), bytes); }
  }
  const artifacts = [];
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else artifacts.push({ path: path.slice(output.length + 1), sha256: sha(await readFile(path)) });
    }
  }
  await inventory(site);
  const receipt = { output, prepared: true, sourceRevision, sourceTree: git('rev-parse', 'HEAD^{tree}'), packageSourceRevision, toolchains: prior.toolchains,
    packs, sources, artifacts, packageLockSha256: prior.packageLockSha256,
    installedSDK: { receipt: resolve(priorPath), sha256: sha(priorBytes), differences,
      applicability: 'Same compiled packages/crates/toolchains/build inputs. Product fixtures and listed standalone PRIMARY proof scripts do not enter SDK compilation. Reused package/installed bytes retain original hashes and source revision; current owned fixture bytes are new. No old runtime outcome reused. Unrelated working-tree changes are not qualified.' } };
  const path = join(output, 'installed-site.json'); await writeFile(path, JSON.stringify(receipt, null, 2)); return path;
}
