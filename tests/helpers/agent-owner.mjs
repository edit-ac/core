import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHostAgent, createHostPrepare } from '@edit-ac/web/host';
import { registerHostAgent } from '../../examples/host-mcp/register.mjs';

export const access = (extra = {}) => ({ actorId: 'actor', documentId: 'fixture-document', epoch: 'epoch',
  permissions: ['read', 'prepare'], readOnly: false, ...extra });
export const base = value => ({ expectedRevision: value.revision, sourceHash: value.sourceHash });
export const text = snapshot => snapshot.visible.filter(n => n.kind === 'block').flatMap(n => n.runs.map(r => r.text)).join('');

export async function fixture(t, options = {}) {
  const child = spawn(process.env.EDITAC_AGENT_OWNER ?? fileURLToPath(new URL('../../target/debug/examples/host-markdown-owner', import.meta.url)), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', dead = false, enabled = true, readOnly = false;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const pending = [], lines = createInterface({ input: child.stdout });
  const fail = error => { for (const p of pending.splice(0)) p.reject(error); };
  lines.on('line', line => {
    const waiter = pending.shift();
    try { waiter?.resolve(JSON.parse(line)); } catch (error) { waiter?.reject(error); }
  });
  child.on('error', error => { dead = true; fail(error); });
  child.on('exit', code => { dead = true; fail(new Error(`owner exited ${code}: ${stderr}`)); });
  const send = input => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(`owner unavailable: ${stderr}`));
    pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(input) + '\n');
  });
  const owner = {
    available: () => enabled,
    capture: () => send({ op: 'capture' }),
    prepare: (target, candidate, a) => enabled
      ? send({ op: 'prepare_v1', target, candidate, access: a })
      : Promise.resolve({ status: 'rejected', code: 'denied' }),
    release: target => { void send({ op: 'release', target }); },
  };
  const service = createHostPrepare(options.wrap ? options.wrap(owner) : owner, options);
  const host = createHostAgent({ authorize: async (context, documentId) =>
    context?.session === 'trusted' && enabled && documentId === 'fixture-document' ? access({ readOnly }) : null,
  services: service.services });
  let provider;
  registerHostAgent({ registerToolProvider(value) { provider = value; } }, host);
  const call = async (op, input = {}, context = { session: 'trusted' }) => {
    const result = await provider.call(`editac_v1_${op}`, JSON.parse(JSON.stringify({ version: 1, documentId: 'fixture-document', ...input })), context);
    return JSON.parse(JSON.stringify(result.structuredContent));
  };
  t.after(async () => {
    try {
      if (!dead) { await service.dispose(); await send({ op: 'state' }); child.stdin.end(); await once(child, 'exit'); }
    } finally { lines.close(); if (!dead) child.kill('SIGTERM'); }
  });
  return { service, owner, call, send, host,
    revoke: () => { enabled = false; }, readonly: () => { readOnly = true; } };
}
