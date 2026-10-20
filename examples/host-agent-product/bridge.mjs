import { baselineOwner } from './baseline-owner.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { sha, root } from './setup.mjs';
export const DOCUMENT = '12345678-1234-4234-8234-123456789abc';
export const EPOCH = '23456789-2345-4345-8345-23456789abcd';
export const LIMITS = Object.freeze({ message: 8192, response: 1048576, pending: 8, timeout: 5000 });

// Fixed executable + argument vector. No caller-supplied command, operation or path.
export async function connectOwner({ executable, database, sdk, facts, capabilities = false, read = false, human = false, baseline = false }) {
  const sdkURL = pathToFileURL(join(sdk, 'host/index.js')).href;
  const { createHostAgent, createHostObserve, createHostMarkdown, createHostPrepare } = await import(sdkURL);
  // Preserve the existing registration module verbatim, resolving its one bare import
  // to the authenticated installed public SDK instead of the lane's node_modules.
  const registerSource = await readFile(join(root,'examples/host-mcp/register.mjs'), 'utf8');
  facts.registerSha256 = sha(registerSource);
  const { registerHostAgent } = await import('data:text/javascript;base64,' + Buffer.from(registerSource.replace("'@edit-ac/web/host'", JSON.stringify(sdkURL))).toString('base64'));
  const executableHash = sha(await readFile(executable));
  const child = spawn(executable, [database], { stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin' } });
  const exit = once(child, 'exit').catch(() => []);
  facts.owner = { pid: child.pid, executable, sha256: executableHash, database, stderr: '', closed: false };
  const queue = []; let dead = false, buffer = '';
  function fail(error) { dead = true; for (const p of queue.splice(0)) { clearTimeout(p.timer); p.reject(error); } }
  child.on('error', fail); child.on('exit', (code,signal) => { facts.owner.exit = {code,signal}; facts.owner.closed = true; fail(Error('Owner disconnected; outcome unknown')); });
  child.stderr.on('data', bytes => { facts.owner.stderr = (facts.owner.stderr + bytes).slice(-8192); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => {
    buffer += bytes.toString();
    if (Buffer.byteLength(buffer) > LIMITS.response) { fail(Error('Owner response limit')); child.kill('SIGTERM'); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const p = queue.shift();
      if (!p) { fail(Error('Unsolicited owner response')); child.kill('SIGTERM'); return; }
      clearTimeout(p.timer);
      try { const result = JSON.parse(line); if (result.error) throw Error(result.error); p.resolve(result.ok); } catch (e) { p.reject(e); }
    }
  });
  const send = input => new Promise((resolve_, reject) => {
    const line = JSON.stringify(input) + '\n';
    if (dead || child.exitCode !== null) return reject(Error('Owner unavailable'));
    if (Buffer.byteLength(line) > LIMITS.message || queue.length >= LIMITS.pending) return reject(Error('Owner request limit'));
    const p = { resolve: resolve_, reject, timer: setTimeout(() => { fail(Error('Owner timeout; outcome unknown')); child.kill('SIGTERM'); }, LIMITS.timeout) };
    queue.push(p); child.stdin.write(line, error => { if (error) fail(error); });
  });
  const context = Object.freeze({ prepared: true });
  let mode = 'authorized';
  const access = { actorId:'agent-a', documentId:DOCUMENT, epoch:EPOCH, permissions:baseline ? ['read','observe','prepare'] : ['read','observe'], readOnly:!baseline };
  const currentAccess = (c,id) => c === context && id === DOCUMENT && !dead && mode !== 'revoked'
    ? { ...access, readOnly:mode === 'readonly' || access.readOnly, permissions: mode === 'readonly' ? ['read','observe','prepare','apply','receipt'] : mode === 'no-read' ? ['observe'] : access.permissions } : null;
  const available = a => !dead && mode !== 'unavailable' && mode !== 'revoked' && mode !== 'no-read'
    && a.documentId === DOCUMENT && a.actorId === access.actorId && a.epoch === EPOCH && a.permissions.includes('read');
  const markdown = read ? createHostMarkdown({
    available,
    async capture(a) {
      if (!available(a)) throw Error('Read unavailable');
      // Prepared fault only; never substitutes for an accepted owner capture.
      if (mode === 'private-error') throw Error('PRIVATE_OWNER_DETAIL: base\n\nother\n');
      return send({ op:'capture' });
    },
    prepare() { throw Error('Preparation unavailable'); },
    release(target) { void send({ op:'release',target }).catch(() => {}); },
  }, { limits:{ maxSourceBytes:16384,maxBaselines:8 } }) : null;
  const lifecycle = baseline ? baselineOwner({createHostPrepare,send,available,onPrepare:()=>{facts.uploadPrepareCalls=(facts.uploadPrepareCalls ?? 0)+1;},onCapture:target=>{ facts.baselineTargets ??= []; facts.baselineTargets.push(target); if(facts.baselineTargets.length>32)facts.baselineTargets.shift(); },access:()=>currentAccess(context,DOCUMENT)}) : null;
  const host = createHostAgent({ authorize: currentAccess,
    services: { ...(lifecycle ? lifecycle.services : markdown ? {read:markdown.services.read} : {}), observe: createHostObserve({ available: a => !dead && mode !== 'unavailable' && a.documentId === DOCUMENT && a.actorId === access.actorId && a.epoch === EPOCH,
      revision: async a => (await send({ op:'observe', access:a })).revision }) } });
  let tools; registerHostAgent({ registerToolProvider(p) { tools = p; } }, host);
  return { send, host, context, tools, database, lifecycle, get prepareCount() { return facts.uploadPrepareCalls ?? 0; },
    ...(lifecycle ? { async baseline(input) {
      if (!input || Array.isArray(input)) throw Error('Invalid baseline action');
      if (input.action === 'capture' && Object.keys(input).length === 2) {
        const generation = lifecycle.generation;
        if (input.generation !== generation) return {status:'rejected',code:'expired'};
        const result = (await tools.call('editac_v1_read',{version:1,documentId:DOCUMENT,representation:'source'},context)).structuredContent;
        const a = currentAccess(context,DOCUMENT);
        return result.status === 'ok' && typeof result.data?.source === 'string' && a && generation === lifecycle.generation
          ? {status:'captured',baseline:{...result.data,actorId:a.actorId,documentId:a.documentId,epoch:a.epoch,generation}}
          : {status:'rejected',code:result.data?.code ?? result.code ?? 'expired'};
      }
      if (typeof input.action === 'string' && input.action.startsWith('upload-')) return lifecycle.upload(input);
      if (input.action === 'check' && Object.keys(input).length === 2) return lifecycle.check(input.baseline);
      if (input.action === 'release' && Object.keys(input).length === 1) { await lifecycle.reset(); return {status:'released',generation:lifecycle.generation}; }
      if (input.action === 'expire' && Object.keys(input).length === 1) { lifecycle.expire(); return {status:'expired'}; }
      throw Error('Invalid baseline action');
    } } : {}),
    ...(human ? { async human(input) {
      if (!input || Array.isArray(input) || input.documentId !== DOCUMENT || input.epoch !== EPOCH || !available(access)) throw Error('Human scope unavailable');
      const keys = Object.keys(input).sort().join(',');
      if (input.action === 'seed' && keys === 'action,documentId,epoch') return send({op:'seed'});
      if (input.action === 'vector' && keys === 'action,documentId,epoch') return send({op:'vector'});
      const validBytes = b => Array.isArray(b) && b.length <= 4096 && b.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
      if (input.action === 'sync' && keys === 'action,documentId,epoch,vector' && validBytes(input.vector)) return send({op:'sync',vector:input.vector});
      if (input.action === 'peer' && keys === 'action,bytes,documentId,epoch,writerId' && validBytes(input.bytes) && Number.isInteger(input.writerId) && input.writerId > 0 && input.writerId <= 4294967295) return send({op:'peer',writerId:input.writerId,bytes:input.bytes});
      throw Error('Invalid human channel request');
    } } : {}),
    ...(capabilities ? {
      async configure(value) {
        if (!['authorized','readonly','revoked','no-read','unavailable',...(read ? ['private-error'] : [])].includes(value)) throw Error('Unknown prepared policy');
        mode = value;
        if (lifecycle) await lifecycle.reset();
      },
      async inventory() {
        const a = currentAccess(context,DOCUMENT);
        return { prepared:true, mode, scope:a ? { actorId:a.actorId,documentId:a.documentId,epoch:a.epoch,readOnly:a.readOnly,permissions:a.permissions } : null,
          tools:await tools.list(context,DOCUMENT) };
      },
      probe(operation,input) { return tools.call(`editac_v1_${operation}`,input,context); },
    } : {}), async close() {
    if (!facts.owner.closed) {
      if (lifecycle) await lifecycle.reset(true);
      if (markdown) await markdown.dispose();
      child.stdin.end(); const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
      await exit; clearTimeout(timer);
    }
    facts.owner.closed = true;
  }, call: input => tools.call('editac_v1_observe', input, context) };
}

export async function startBridgeServer(options, owner, facts) {
  const mounts = { fixture: resolve(options.fixtureDirectory), core: resolve(options.coreDirectory), web: resolve(options.webDirectory) };
  const token = randomBytes(32).toString('hex'); let origin, active = 0; const requests = [];
  const server = createServer(async (req,res) => {
    const reply = (status, value) => { if (!res.destroyed) res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }).end(JSON.stringify(value)); };
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ path, method:req.method }); if (requests.length > 128) requests.shift();
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return reply(403,{ error:'Local origin required' });
    if (path === '/bridge.json' && req.method === 'GET') return reply(200,{ token, documentId:DOCUMENT, epoch:EPOCH });
    if ((owner.baseline && path === '/bridge/baseline') || (owner.human && path === '/human/channel') || path === '/bridge/observe' || (owner.inventory && ['/bridge/inventory','/bridge/fixture','/bridge/probe'].includes(path))) {
      if (req.method !== 'POST') return reply(405,{ error:'POST required' });
      if (req.headers.origin !== origin || req.headers['x-host-fixture'] !== token || req.headers['content-type'] !== 'application/json') return reply(403,{ error:'Fixture context required' });
      if (active >= LIMITS.pending) return reply(429,{ error:'Pending limit' });
      const timeout = setTimeout(() => req.destroy(), LIMITS.timeout);
      active++; let cancelled = false; res.on('close', () => { if (!res.writableEnded) { cancelled = true; facts.cancelled = (facts.cancelled ?? 0) + 1; } });
      try {
        let body = ''; for await (const bytes of req) { body += bytes.toString(); if (Buffer.byteLength(body) > LIMITS.message) { reply(413,{ error:'Message limit' }); return; } }
        const input = JSON.parse(body);
        if (path === '/bridge/baseline' && owner.baseline) return reply(200,await owner.baseline(input));
        if (path === '/human/channel' && owner.human) return reply(200,await owner.human(input));
        if (owner.inventory && path !== '/bridge/observe') {
          if (!input || Array.isArray(input)) return reply(400,{error:'Invalid fixture request'});
          if (path === '/bridge/inventory') {
            if (Object.keys(input).length) return reply(400,{error:'Inventory takes no arguments'});
            return reply(200,await owner.inventory());
          }
          if (path === '/bridge/fixture') {
            if (Object.keys(input).length !== 1 || typeof input.mode !== 'string') return reply(400,{error:'Expected prepared policy'});
            await owner.configure(input.mode); return reply(200,await owner.inventory());
          }
          if (Object.keys(input).length !== 2 || !Object.hasOwn(input,'arguments') || !['read','prepare','apply','receipt','observe','unknown'].includes(input.operation)) return reply(400,{error:'Invalid probe'});
          const result = await owner.probe(input.operation,input.arguments);
          if (!cancelled) reply(200,result.structuredContent);
          return;
        }
        if (!input || Array.isArray(input) || Object.keys(input).some(k => !['version','documentId','cursor'].includes(k)) || input.version !== 1 || input.documentId !== DOCUMENT || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 512))) return reply(400,{ error:'Invalid observation request' });
        const result = await owner.call(input); if (!cancelled) reply(200,result.structuredContent);
      } catch { reply(400,{ error:'Request failed; outcome unknown' }); }
      finally { clearTimeout(timeout); active--; }
      return;
    }
    if (req.method !== 'GET') return reply(405,{ error:'GET required' });
    try {
      const [,mount,...parts] = (path === '/' ? '/fixture/index.html' : decodeURIComponent(path)).split('/');
      if (!mounts[mount]) return reply(404,{ error:'Not found' });
      const target = resolve(mounts[mount], ...parts); if (!target.startsWith(mounts[mount] + sep)) return reply(403,{ error:'Path denied' });
      const bytes = await readFile(target);
      res.writeHead(200,{ 'Content-Type':target.endsWith('.wasm') ? 'application/wasm' : target.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control':'no-store' }).end(bytes);
    } catch { reply(404,{ error:'Not found' }); }
  });
  server.maxConnections = 16; server.requestTimeout = LIMITS.timeout; server.headersTimeout = LIMITS.timeout;
  await new Promise((yes,no) => { server.once('error',no); server.listen(0,'127.0.0.1',yes); });
  const port = server.address().port; origin = `http://127.0.0.1:${port}`;
  return { port, url:origin, requests, get listening() { return server.listening; }, async close() {
    await new Promise((yes,no) => { server.close(e => e ? no(e) : yes()); server.closeAllConnections(); }); await owner.close();
  } };
}
