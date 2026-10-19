import assert from 'node:assert/strict';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareShell, root, sha } from './setup.mjs';
import { connectOwner, startBridgeServer } from './bridge.mjs';
export const defaultOwnerReceipt = resolve(root,'../architecture/evidence/host-agent-product-20261019/host-workspace/D24X-1.2/build/owner.json');
export async function prepareBridge(output, facts, receipt, configuration = {}) {
  const pin = JSON.parse(await readFile(process.env.EDITAC_HOST_PRODUCT_OWNER_RECEIPT ?? defaultOwnerReceipt));
  assert.equal(sha(await readFile(pin.executable)),pin.sha256);
  for (const input of pin.sources) {
    const current = spawnSync('git',['show',`main:${input.path}`],{ cwd:root });
    assert.equal(current.status,0); assert.equal(sha(current.stdout),input.sha256,`owner main applicability ${input.path}`);
  }
  let owner;
  try {
    const server = await prepareShell(output,facts,receipt,{ sources:[...(configuration.sources ?? []),'examples/host-agent-product/bridge.mjs','examples/host-agent-product/bridge-setup.mjs','examples/host-agent-product/bridge-workspace.mjs','tests/scenarios/host-agent-product-bridge.mjs'],
      serverFactory:async options => {
        const html = await readFile(join(options.fixtureDirectory,'index.html'),'utf8');
        await writeFile(join(options.fixtureDirectory,'index.html'),html.replace('\"@edit-ac/web/host\":',configuration.human ? '\"@edit-ac/core\":\"/core/index.js\",\"@edit-ac/core/extensions\":\"/core/extensions/index.js\",\"@edit-ac/core/links\":\"/core/links/index.js\",\"@edit-ac/web/host\":' : '\"@edit-ac/web/host\":').replace('/fixture/workspace.mjs',`/fixture/${configuration.workspace ?? 'bridge-workspace.mjs'}`));
        await cp(join(root,'examples/host-agent-product/bridge-workspace.mjs'),join(options.fixtureDirectory,'bridge-workspace.mjs'));
        if (configuration.capabilities) await cp(join(root,'examples/host-agent-product/probes.mjs'),join(options.fixtureDirectory,'probes.mjs'));
        for (const file of configuration.files ?? []) await cp(join(root,'examples/host-agent-product',file),join(options.fixtureDirectory,file));
        if (configuration.workspace) await cp(join(root,'examples/host-agent-product',configuration.workspace),join(options.fixtureDirectory,configuration.workspace));
        owner = await connectOwner({ executable:pin.executable, database:join(output,'host.sqlite3'),sdk:options.webDirectory,facts,capabilities:configuration.capabilities === true,read:configuration.read === true,human:configuration.human === true });
        return startBridgeServer(options,owner,facts);
      } });
    facts.inputs.nativeBinary = pin;
    facts.inputs.applicability = 'Authenticated installed SDK; unchanged actual owner built offline from pinned local-main committed source, excluding foreign dirty Cargo. Consumer is new; source read, mounted human and mutation acceptance remain open.';
    await writeFile(join(output,'inputs.json'),JSON.stringify(facts.inputs,null,2));
    facts.processes.push({ pid:facts.owner.pid, launcher:pin.executable,workspace:root,purpose:'Actual prepared Session/SQLite owner',log:join(output,'receipt.json') });
    server.owner = owner; return server;
  } catch (e) { await owner?.close(); throw e; }
}
