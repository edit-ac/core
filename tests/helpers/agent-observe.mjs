import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHostAgent, createHostApply, createHostObserve } from '@edit-ac/web/host';
import { registerHostAgent } from '../../examples/host-mcp/register.mjs';
import { registerHostObservation } from '../../examples/host-mcp/src/observe.ts';

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(process.env.EDITAC_AGENT_OBSERVE_OUTPUT ?? tmpdir(), 'observe-'));
  const child = spawn(resolve('target/debug/examples/host-realtime-owner'), [join(directory, 'host.sqlite3')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const pending = [], transcript = [];
  let dead = false, stderr = '', time = 0, readable = true, writable = true;
  let actorId = 'agent-a', epoch = '23456789-2345-4345-8345-23456789abcd', permissions = ['read', 'prepare', 'apply', 'receipt', 'observe'];
  const documentId = '12345678-1234-4234-8234-123456789abc';
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-8192); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const p = pending.shift();
    try { const result = JSON.parse(line); transcript.push({ result }); p?.resolve(result); } catch (e) { p?.reject(e); }
  });
  const fail = error => { dead = true; for (const p of pending.splice(0)) p.reject(error); };
  child.on('error', fail); child.on('exit', code => fail(Error(`owner exit ${code}: ${stderr}`)));
  const send = async input => {
    if (dead) throw Error('owner unavailable');
    transcript.push({ input });
    const result = await new Promise((resolve, reject) => {
      pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(input) + '\n');
    });
    if (result.error) throw Error(result.error);
    return result.ok;
  };
  const access = () => ({ actorId, documentId, epoch, permissions: [...permissions], readOnly: !writable });
  const authorize = async (context, id) => context === 'trusted' && readable && id === documentId ? access() : null;
  const available = a => readable && a.actorId === actorId && a.epoch === epoch && a.documentId === documentId;
  let revisionCalls = 0;
  const revision = async a => { revisionCalls++; return (await send({ op: 'observe', access: a })).revision; };
  const observe = createHostObserve({ available, revision: options.wrapRevision ? a => options.wrapRevision(() => revision(a)) : revision });
  const services = { observe,
    read: { available, async execute(_r, a) { const state = await send({ op: 'state' }); if (!available(a)) throw Error('revoked'); return state; } },
    prepare: { available: a => available(a) && writable, execute: request => send({ op: 'prepare', text: request.candidateMarkdown }) },
    ...createHostApply({ available: (a, op) => available(a) && (op === 'receipt' || writable),
      apply: request => send({ op: 'apply', ...request }), receipt: request => send({ op: 'receipt', ...request }) }) };
  const host = createHostAgent({ authorize, services });
  let tools;
  registerHostAgent({ registerToolProvider(value) { tools = value; } }, host);
  const call = async (op, input = {}, context = 'trusted') => JSON.parse(JSON.stringify((await tools.call(`editac_v1_${op}`,
    { version: 1, documentId, ...input }, context)).structuredContent));
  const notifications = [], providers = [], facades = [];
  const connect = (overrides = {}) => {
    const facade = registerHostObservation({ registerResourceProvider(p) { providers.push(p); } }, {
      host, authorize, context: 'trusted', negotiated: { resources: true, subscriptions: true }, now: () => time,
      notify: async (method, params) => { notifications.push(JSON.parse(JSON.stringify({ method, params }))); }, ...overrides,
    });
    facades.push(facade); return facade;
  };
  t.after(async () => {
    facades.forEach(f => f.dispose());
    try {
      if (!dead) { child.stdin.end(); await exited; }
      await writeFile(join(directory, 'transcript.json'), JSON.stringify({ pid: child.pid, exited: dead, stderr, transcript, notifications }, null, 2));
    } finally { lines.close(); if (!dead) { child.kill('SIGTERM'); await exited; } }
  });
  return { host, call, send, access, authorize, connect, documentId, notifications, providers, observe, directory,
    get revisionCalls() { return revisionCalls; },
    advance(ms = 1000) { time += ms; },
    identity(value) { if (value.actorId) actorId = value.actorId; if (value.epoch) epoch = value.epoch; if (value.permissions) permissions = value.permissions; },
    async policy(value) { readable = value.readable ?? readable; writable = value.writable ?? writable; await send({ op: 'policy', readable, writable }); },
    async edit(text = 'A', requestId = 'request-a') {
      const p = await send({ op: 'prepare', text });
      return call('apply', { ...p, requestId });
    },
  };
}

export function held() {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { started, release: () => release(), wrap: async action => { const result = await action(); entered(); await wait; return result; } };
}
