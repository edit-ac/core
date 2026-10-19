import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareBridge } from './bridge-setup.mjs';
import { prepareShell, defaultReceipt, root } from './setup.mjs';
const bridge = process.argv[2] === '--bridge';
if (process.argv.length > (bridge ? 3 : 2)) throw Error('Expected optional --bridge');
const output = resolve(root, `../architecture/evidence/host-agent-product-20261019/host-workspace/${bridge ? 'D24X-1.2' : 'D24X-1.1'}`, `preview-${Date.now()}`);
await mkdir(output, { recursive: true });
const facts = { purpose: bridge ? 'Actual prepared Session/SQLite bridge' : 'Opt-in prepared workspace shell', processes: [] };
let server;
async function close() {
  if (server) { await server.close(); facts.listenerStopped = !server.listening; }
  await writeFile(resolve(output, 'preview.json'), JSON.stringify(facts, null, 2));
}
try {
  server = await (bridge ? prepareBridge : prepareShell)(output, facts, process.env.EDITAC_HOST_PRODUCT_SDK_RECEIPT ?? defaultReceipt);
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: facts.purpose, log: resolve(output,'preview.json') });
  await writeFile(resolve(output,'preview.json'), JSON.stringify(facts, null, 2));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  console.log(`Local prepared shell: ${server.url}\nStop with Ctrl+C. Evidence: ${output}`);
} catch (error) { facts.failure = error.stack; await close(); throw error; }
