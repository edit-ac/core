import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
const boundary = root.endsWith(sep) ? root : root + sep;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(boundary) || path.includes('node_modules')) { response.writeHead(403).end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
const portArg = process.argv.find(arg => arg.startsWith('--port='));
server.listen(portArg ? Number(portArg.slice(7)) : 4173, '127.0.0.1', () =>
  console.log(JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, purpose: 'EXT-1.10 prepared tutorial', workspace: root })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
