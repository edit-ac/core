import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInstalledRevisionSite, prepareOwnerRevisionSite } from './revision-review-prepare.mjs';
import { prepareProductHarness } from '../../tests/scenarios/harness.mjs';
import { loadScenario, root } from '../../tests/scenarios/run.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../../tests/browser/fixture-server.mjs';

export const manifestPath = resolve(root, 'fixtures/product-scenarios/revision-review/manifest.json');
export async function prepareRevisionProduct(output, facts, group = 'capture') {
  const { scenario } = await loadScenario(group, manifestPath);
  await mkdir(output, { recursive: true });
  const previous = process.env.EDITAC_PRODUCT_SITE_RECEIPT;
  if (process.env.EDITAC_REVISION_SDK_RECEIPT && !previous) {
    process.env.EDITAC_PRODUCT_SITE_RECEIPT = await prepareInstalledRevisionSite(output, scenario, process.env.EDITAC_REVISION_SDK_RECEIPT);
  }
  if (process.env.EDITAC_REVISION_OWNER_INPUTS && !previous) {
    process.env.EDITAC_PRODUCT_SITE_RECEIPT = await prepareOwnerRevisionSite(output, scenario, process.env.EDITAC_REVISION_OWNER_INPUTS);
  }
  let paths;
  try { paths = await prepareProductHarness(output, facts, scenario); }
  finally {
    if (previous === undefined) delete process.env.EDITAC_PRODUCT_SITE_RECEIPT;
    else process.env.EDITAC_PRODUCT_SITE_RECEIPT = previous;
  }
  facts.prepared = true;
  await writeFile(join(output, 'prepared.json'), JSON.stringify(facts, null, 2));
  return paths;
}
async function preview() {
  await requireTestNode();
  const output = resolve(root, '.artifacts/revision-review-preview', new Date().toISOString().replace(/[:.]/g, '-'));
  const facts = { output, commands: [], purpose: 'Opt-in local installed-SDK revision review' };
  let server, preparation, stopping = false;
  const close = async () => {
    stopping = true;
    await preparation?.catch(() => {});
    if (server) { await server.close(); facts.listenerStopped = !server.listening; server = undefined; }
    await writeFile(join(output, 'preview.json'), JSON.stringify({ ...facts, stopped: true }, null, 2));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  try {
    preparation = prepareRevisionProduct(output, facts);
    const { site } = await preparation;
    if (stopping) return;
    server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'), webDirectory: join(site, 'web') });
    facts.process = { pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: facts.purpose, log: join(output, 'preview.json') };
    await writeFile(join(output, 'preview.json'), JSON.stringify(facts, null, 2));
    console.log(`Revision review: ${server.url}/fixture/revision-review.html\nStop: Ctrl+C (PID ${process.pid}, port ${server.port})\nArtifacts: ${output}`);
  } catch (error) { facts.failure = error.stack; await close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preview();
