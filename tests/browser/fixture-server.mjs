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
  let phase = 'online';
  const transport = [];
  const server = createServer(async (request, response) => {
    const trace = { url: request.url, status: null, receivedAt: new Date().toISOString(), phase, destination: request.headers['sec-fetch-dest'] ?? null, serviceWorker: request.headers['service-worker'] ?? null };
    if (options.recordRequests) requests.push(trace);
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === '/') path = '/fixture/index.html';
      const [, mount, ...parts] = path.split('/');
      if (!mounts[mount]) { trace.status = 404; response.writeHead(404).end(); return; }
      const directory = resolve(root, mounts[mount]), target = resolve(directory, ...parts);
      if (!target.startsWith(directory + sep)) { trace.status = 403; response.writeHead(403).end(); return; }
      const body = await readFile(target);
      const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
      const cache = options.cacheAssets && /\.(?:js|mjs|wasm|css)$/.test(target);
      const status = cache && request.headers['if-none-match'] === etag ? 304 : 200;
      Object.assign(trace, { status, bodyBytes: status === 304 ? 0 : body.length, etag, cacheControl: cache ? 'public, max-age=0, must-revalidate' : 'no-store', ifNoneMatch: request.headers['if-none-match'] ?? null, sha256: createHash('sha256').update(body).digest('hex') });
      response.writeHead(status, { 'Content-Type': target.endsWith('.wasm') ? 'application/wasm' :
        target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': cache ? 'public, max-age=0, must-revalidate' : 'no-store', 'ETag': etag });
      response.end(status === 304 ? undefined : body);
    } catch { Object.assign(trace, { status: 404, bodyBytes: 0 }); response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const stop = async () => {
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  };
  return { requests, transport, get listening() { return server.listening; },
    // A closed TCP listener models actual transport loss for browser-owned
    // worker update checks too. No URL filtering or successful HTTP is possible.
    suspendTransport: async () => {
      await stop();
      transport.push({ state: 'unavailable', at: new Date().toISOString(), port: address.port });
    },
    resumeTransport: async () => {
      if (!server.listening) await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      transport.push({ state: 'available', at: new Date().toISOString(), port: address.port });
    },
    setPhase: value => { phase = value; }, url: `http://127.0.0.1:${address.port}`, pid: process.pid, port: address.port, workspace: root,
    close: stop };
}
