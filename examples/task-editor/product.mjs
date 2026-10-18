import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario, root } from '../../tests/scenarios/run.mjs';
import { prepareProductHarness } from '../../tests/scenarios/harness.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../../tests/browser/fixture-server.mjs';

export async function prepareProductSite(output, facts) {
  const { scenario } = await loadScenario('web-product-checkpoint');
  await mkdir(output, { recursive: true });
  const paths = await prepareProductHarness(output, facts, scenario);
  // This authenticates build inputs only. Browser outcomes require separate cases.
  facts.prepared = true;
  await writeFile(join(output, 'prepared.json'), JSON.stringify(facts, null, 2));
  return paths;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await requireTestNode();
  const output = resolve(root, '.artifacts/browser-product-preview', new Date().toISOString().replace(/[:.]/g, '-'));
  const facts = { output, commands: [], purpose: 'Local installed-SDK product preview' };
  let server;
  const close = async () => {
    if (server) { await server.close(); server = undefined; }
    await writeFile(join(output, 'preview.json'), JSON.stringify({ ...facts, stopped: true }, null, 2));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  try {
    const { site } = await prepareProductSite(output, facts);
    server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'), webDirectory: join(site, 'web'), cacheAssets: true });
    facts.process = { pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: facts.purpose, log: join(output, 'preview.json') };
    await writeFile(join(output, 'preview.json'), JSON.stringify(facts, null, 2));
    console.log(`Task/comment: ${server.url}/fixture/index.html\nReact tasks: ${server.url}/fixture/react.html?route=tasks\nDocument body: ${server.url}/fixture/react.html?route=document\nReadonly: ${server.url}/fixture/index.html?readonly\nStop: Ctrl+C (PID ${process.pid}, port ${server.port})\nArtifacts: ${output}`);
  } catch (error) { facts.failure = error.stack; await close(); throw error; }
}
