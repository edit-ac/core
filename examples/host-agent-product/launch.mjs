import { prepareBaseline } from './baseline-setup.mjs';
import { prepareWorkspace } from './installed-setup.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareHuman } from './human-setup.mjs';
import { prepareRead } from './read-setup.mjs';
import { prepareCapabilities } from './capabilities-setup.mjs';
import { prepareBridge } from './bridge-setup.mjs';
import { prepareShell, defaultReceipt, root } from './setup.mjs';
const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !['--baseline','--bridge','--capabilities','--read','--human','--workspace'].includes(mode))) throw Error('Expected optional --bridge, --capabilities or --read or --human or --workspace');
const baseline = mode === '--baseline';
const workspace = mode === '--workspace';
const human = mode === '--human';
const bridge = !!mode, capabilities = mode === '--capabilities', read = mode === '--read';
const output = resolve(root, `../architecture/evidence/host-agent-product-20261019/host-workspace/${baseline ? '../proposal-workflow/D24X-2.1' : workspace ? 'D24X-1.6' : human ? 'D24X-1.5' : read ? 'D24X-1.4' : capabilities ? 'D24X-1.3' : bridge ? 'D24X-1.2' : 'D24X-1.1'}`, `preview-${Date.now()}`);
await mkdir(output, { recursive: true });
const facts = { purpose: bridge ? 'Actual prepared Session/SQLite bridge' : 'Opt-in prepared workspace shell', processes: [] };
let server;
async function close() {
  if (server) { await server.close(); facts.listenerStopped = !server.listening; }
  await writeFile(resolve(output, 'preview.json'), JSON.stringify(facts, null, 2));
}
try {
  server = await (baseline ? prepareBaseline : workspace ? prepareWorkspace : human ? prepareHuman : read ? prepareRead : capabilities ? prepareCapabilities : bridge ? prepareBridge : prepareShell)(output, facts, process.env.EDITAC_HOST_PRODUCT_SDK_RECEIPT ?? defaultReceipt);
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: facts.purpose, log: resolve(output,'preview.json') });
  await writeFile(resolve(output,'preview.json'), JSON.stringify(facts, null, 2));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  console.log(`Local prepared workspace: ${server.url}\nStop with Ctrl+C. Evidence: ${output}`);
} catch (error) { facts.failure = error.stack; await close(); throw error; }
