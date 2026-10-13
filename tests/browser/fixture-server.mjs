import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

export async function startFixtureServer(options = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const mounts = { fixture: options.fixtureDirectory ?? 'fixtures/crash-boundaries',
    core: options.coreDirectory ?? 'packages/core/dist', web: options.webDirectory ?? 'packages/web/dist' };
  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === '/') path = '/fixture/index.html';
      const [, mount, ...parts] = path.split('/');
      if (!mounts[mount]) { response.writeHead(404).end(); return; }
      const directory = resolve(root, mounts[mount]), target = resolve(directory, ...parts);
      if (!target.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(target);
      response.writeHead(200, { 'Content-Type': target.endsWith('.wasm') ? 'application/wasm' :
        target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, pid: process.pid, port: address.port, workspace: root,
    close: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
