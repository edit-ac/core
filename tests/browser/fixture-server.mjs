import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

export async function startFixtureServer(options = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const mounts = { fixture: options.fixtureDirectory ?? 'fixtures/crash-boundaries',
    markdown: options.markdownDirectory ?? 'packages/markdown/dist',
    core: options.coreDirectory ?? 'packages/core/dist', web: options.webDirectory ?? 'packages/web/dist' };
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === '/') path = '/fixture/index.html';
      const [, mount, ...parts] = path.split('/');
      if (!mounts[mount]) { response.writeHead(404).end(); return; }
      const directory = resolve(root, mounts[mount]), target = resolve(directory, ...parts);
      if (!target.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(target);
      const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
      const cache = options.cacheAssets && /\.(?:js|mjs|wasm|css)$/.test(target);
      const status = cache && request.headers['if-none-match'] === etag ? 304 : 200;
      if (options.recordRequests) requests.push({ url: request.url, status, bodyBytes: status === 304 ? 0 : body.length, etag, cacheControl: cache ? 'public, max-age=0, must-revalidate' : 'no-store', ifNoneMatch: request.headers['if-none-match'] ?? null, sha256: createHash('sha256').update(body).digest('hex') });
      response.writeHead(status, { 'Content-Type': target.endsWith('.wasm') ? 'application/wasm' :
        target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': cache ? 'public, max-age=0, must-revalidate' : 'no-store', 'ETag': etag });
      response.end(status === 304 ? undefined : body);
    } catch { if (options.recordRequests) requests.push({ url: request.url, status: 404, bodyBytes: 0 }); response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { requests, url: `http://127.0.0.1:${address.port}`, pid: process.pid, port: address.port, workspace: root,
    close: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
