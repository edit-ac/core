import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Private per-suite server; cleanup also covers failed public artifact initialization. */
export async function packedRuntime(pack) {
  assert.equal(process.version, 'v24.19.0', 'use the repository pinned Node runtime');
  assert.ok(pack, 'EDITAC_EDITING_PACK_TARBALL must identify an immutable qualified core package');
  const facts = { pack: { path: resolve(pack), sha256: sha256(await readFile(pack)) }, node: process.version, unicode: process.versions.unicode, icu: process.versions.icu };
  const directory = await mkdtemp(join(tmpdir(), 'rgs-semantic-pack-')); let server;
  const close = async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    facts.serverClosed = !server?.listening; await rm(directory, { recursive: true, force: true }); facts.temporaryPackageRemoved = true;
  };
  try {
    const result = spawnSync('tar', ['-xzf', resolve(pack), '-C', directory], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(join(directory, 'package/dist/wasm/editac_wasm_bg.wasm')); facts.wasmSha256 = sha256(bytes);
    server = createServer((request, response) => {
      if (request.url !== '/engine.wasm') { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', 'application/wasm'); response.end(bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    facts.process = { pid: process.pid, port: server.address().port, launcher: 'node --test tests/editing/semantic.test.mjs', workspace: resolve('.'), purpose: 'RGS-1.2 packed semantic WASM asset' };
    const { init } = await import(pathToFileURL(join(directory, 'package/dist/index.js')));
    const runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
    return { runtime, facts, close };
  } catch (error) { await close(); throw error; }
}
