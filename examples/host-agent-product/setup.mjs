import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startFixtureServer } from '../../tests/browser/fixture-server.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
export async function prepareShell(output, facts, receiptPath) {
  assert.equal(process.versions.node, (await readFile(join(root, '.node-version'), 'utf8')).trim());
  const path = resolve(receiptPath), bytes = await readFile(path), prior = JSON.parse(bytes);
  assert.equal(prior.prepared, true); assert.equal(prior.toolchains.node, process.versions.node);
  assert.equal(prior.ownerInputs.offlineInstallExit, 0);
  assert.equal(sha(await readFile(prior.ownerInputs.path)), prior.ownerInputs.sha256);
  for (const pack of prior.packs) assert.equal(sha(await readFile(join(prior.output, pack.file))), pack.sha256, pack.file);
  const sdkArtifacts = prior.artifacts.filter(a => /^site\/(core|web)\//.test(a.path));
  assert.ok(sdkArtifacts.length > 100);
  for (const artifact of sdkArtifacts) assert.equal(sha(await readFile(join(prior.output, artifact.path))), artifact.sha256, artifact.path);
  // Compare exact affected public host sources; unrelated dirty Cargo is excluded, never qualified.
  const hostSources = prior.ownerInputs.sources.filter(s => s.path.startsWith('core/packages/web/src/host/'));
  assert.ok(hostSources.length > 0);
  for (const source of hostSources) {
    const relative = source.path.slice(5), current = await readFile(join(root, relative));
    assert.equal(sha(current), source.sha256, relative);
    const main = spawnSync('git', ['show', `main:${relative}`], { cwd: root });
    assert.equal(main.status, 0); assert.equal(sha(main.stdout), sha(current), `main applicability ${relative}`);
  }
  const fixture = join(output, 'fixture'); await mkdir(fixture, { recursive: true });
  const sources = ['examples/host-agent-product/index.html','examples/host-agent-product/workspace.mjs','examples/host-agent-product/model.mjs','examples/host-agent-product/setup.mjs','examples/host-agent-product/launch.mjs','examples/host-agent-product/README.md','fixtures/product-scenarios/host-agent-product/shell.json','fixtures/product-scenarios/host-agent-product/manifest.json','tests/scenarios/host-agent-product.mjs','tests/scenarios/host-agent-product-shell.mjs','tests/browser/fixture-server.mjs'];
  facts.sources = [];
  for (const source of sources) {
    const content = await readFile(join(root, source)); facts.sources.push({ path: source, sha256: sha(content) });
    if (['index.html','workspace.mjs','model.mjs','shell.json'].includes(source.split('/').at(-1))) await cp(join(root, source), join(fixture, source.split('/').at(-1)));
  }
  facts.inputs = { receipt: path, receiptSha256: sha(bytes), sourceRevision: git('rev-parse','HEAD'), main: git('rev-parse','main'), packs: prior.packs, sdkArtifacts, hostSources,
    wasmSha256: prior.ownerInputs.wasmSha256, nativeBinary: { used: false, reason: 'Shell gate has no Session connection; no native assertions claimed' },
    applicability: 'Exact installed core/web artifacts and affected host sources authenticated; host sources equal local main. Current owned consumer is new. Dirty Cargo and unrelated semantics are outside this shell proof.' };
  await writeFile(join(output, 'inputs.json'), JSON.stringify(facts.inputs, null, 2));
  return startFixtureServer({ fixtureDirectory: fixture, coreDirectory: join(prior.output,'site/core'), webDirectory: join(prior.output,'site/web'), recordRequests: true });
}
export const defaultReceipt = resolve(root, '../architecture/evidence/revision-review-product-20261019/rvp-3.2/final-integrated-1/installed-site.json');
