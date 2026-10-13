// Static files only: no document API, persistence service, or provider transport.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const mounts = { example: 'examples/web', core: 'packages/core/dist', web: 'packages/web/dist' };
const contentTypes = { '.wasm': 'application/wasm', '.html': 'text/html;charset=utf-8', '.css': 'text/css;charset=utf-8' };
export async function startExampleServer(port = 4173) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const [, mount, ...parts] = (pathname === '/' ? '/example/index.html' : pathname).split('/');
      if (!mounts[mount]) { response.writeHead(404).end(); return; }
      const directory = resolve(workspace, mounts[mount]), target = resolve(directory, ...parts);
      if (!target.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(target);
      const extension = target.slice(target.lastIndexOf('.'));
      response.writeHead(200, { 'Content-Type': contentTypes[extension] ?? 'text/javascript;charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await startExampleServer(Number(process.env.PORT ?? 4173));
  console.log(`edit.ac web examples: ${preview.url}\nStatic preview, PID ${process.pid}. Ctrl+C to stop.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
