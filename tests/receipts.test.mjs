import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startReferenceRelay, receiptProtocol } from '../examples/sync-server/relay.mjs';

const output = process.env.EDITAC_RECEIPTS_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-receipts-evidence-'));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'editac-receipts-databases-'));
const grants = JSON.parse(await readFile(new URL('./fixtures/relay-grants.json', import.meta.url)));
const grant = grants[0];
const facts = { boundary: 'Actual Chromium IndexedDB / Rust WASM client and peer / loopback HTTP / SQLite FULL WAL; prepared grants; no production auth', cases: [], processes: [], cleanup: [] };
let controller, browser, serial = 0;
before(async () => {
  controller = await chromium.launchServer({ headless: true });
  browser = await chromium.connect(controller.wsEndpoint());
  facts.browser = browser.version();
  facts.processes.push({ pid: controller.process().pid, launcher: controller.process().spawnfile,
    workspace: process.cwd(), port: Number(new URL(controller.wsEndpoint()).port), purpose: 'SYN-1.6 Chromium integration', log: 'feature.log' });
});
after(async () => {
  try { if (browser) await browser.close(); } finally { if (controller) await controller.close(); }
  facts.cleanup.push({ browserStopped: !controller || controller.process().exitCode !== null, scratchRemoved: scratch });
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2));
});
function check(name, fn) {
  test(name, async () => {
    const fact = { name, passed: false }; facts.cases.push(fact);
    const context = await browser.newContext();
    const relay = await startReferenceRelay({ databasePath: join(scratch, `${serial++}.sqlite`), grants });
    const port = Number(new URL(relay.url).port);
    facts.processes.push({ pid: process.pid, launcher: 'node --test tests/receipts.test.mjs', workspace: process.cwd(), port, purpose: name, log: 'feature.log' });
    let session, requests = 0;
    async function post(path, body) {
      requests++;
      const response = await fetch(relay.url + path, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + grant.token,
        ...(session ? { 'x-editac-session': session } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const value = await response.json();
      if (path === '/session' && response.ok) session = value.session;
      return { status: response.status, value };
    }
    try {
      await context.exposeBinding('relayCall', (_source, path, body) => post(path, body));
      await context.exposeBinding('relayRevoke', () => relay.revoke(grant.token));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, 'https://receipts.test', 'no external request');
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Receipt integration</title>' });
        assert.match(url.pathname, /^\/(core|web)\/[\w/.-]+$/);
        assert.ok(!url.pathname.includes('..'));
        const prefix = url.pathname.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
        await route.fulfill({ contentType: url.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          body: await readFile(new URL(prefix + url.pathname.replace(/^\/(core|web)\//, ''), import.meta.url)) });
      });
      const page = await context.newPage(); await page.goto('https://receipts.test/');
      await page.evaluate(async identity => {
        const { init } = await import('/core/index.js');
        const { UpdateJournal } = await import('/web/storage/journal.js');
        const { UpdateOutbox, durableReceiptProtocol } = await import('/web/storage/outbox.js');
        const { SyncSession } = await import('/web/sync/session.js');
        const { DirectSyncAdapter } = await import('/web/sync/protocol.js');
        const { ReceiptSession } = await import('/web/sync/receipts.js');
        const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
        const engine = runtime.createEngine({ profile: 'v5', documentId: identity.documentId, epoch: identity.epoch, nodes: [{ text: 'a😀b' }] });
        const initial = engine.checkpoint(), peer = runtime.restoreEngine(identity, initial);
        const journal = await UpdateJournal.open(indexedDB, 'receipts'), outbox = await UpdateOutbox.open(indexedDB, 'receipts', durableReceiptProtocol);
        const sync = new SyncSession(engine, outbox), client = new ReceiptSession(engine, sync, outbox);
        const adapter = new DirectSyncAdapter(peer, identity), frames = [];
        const baseline = { send(frame) { frames.push(Array.from(frame)); const response = adapter.receive(frame); if (response.reply) sync.receive(response.reply); return true; } };
        const durable = { async upload(entry) {
          const { status, value } = await window.relayCall('/updates', { ...entry, bytes: btoa(String.fromCharCode(...entry.bytes)) });
          if (status === 401 || status === 403) return { authorization: 'revoked' };
          if (status !== 200) throw new Error(value.error);
          return { receipt: value.receipt };
        } };
        const updates = []; const sub = engine.subscribe({ type: 'updates' }, p => { if (p.update) updates.push({ identity: p.identity, writerId: p.writerId, sequence: p.sequence, origin: p.origin, bytes: p.update.bytes }); });
        async function edit(text = 'Z') {
          const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
          try { engine.commit(engine.prepare({ kind: 'text', origin: 'local:receipt-fixture', command: { type: 'insert', at, text } })); } finally { engine.releaseAnchor(at); }
          await journal.append(updates.at(-1)); client.localCommitted(updates.at(-1).origin);
        }
        async function attach(protocol = durableReceiptProtocol, authorized = true, transport = durable) {
          const response = await window.relayCall('/session', { identity, receiptProtocol: protocol });
          if (response.status !== 200) throw new Error(response.value.error);
          client.attach(baseline, response.value, transport, authorized);
        }
        async function pending() { return outbox.pending(identity); }
        async function receipt() {
          const entry = (await pending())[0]; return { protocol: durableReceiptProtocol, state: 'durable', identity: { ...identity }, writerId: entry.writerId, sequence: entry.sequence, checksum: entry.checksum, updateId: entry.updateId };
        }
        function text(handle = engine) { return handle.read().visible[0].runs.map(r => r.text).join(''); }
        function recovered() { const checkpoint = client.recoveryExport(), restored = runtime.restoreEngine(identity, checkpoint); try { return text(restored); } finally { restored.dispose(); } }
        window.h = { identity, runtime, engine, peer, journal, outbox, sync, client, baseline, durable, frames, edit, attach, pending, receipt, text, recovered,
          close() { client.detach(); sync.dispose(); sub.dispose(); journal.close(); outbox.close(); engine.dispose(); peer.dispose(); } };
      }, grant.identity);
      fact.result = await fn(page, { post, relay });
      fact.requests = requests; fact.passed = true;
    } finally {
      try { await context.pages()[0]?.evaluate(() => window.h?.close()); } finally { await context.close(); await relay.close(); }
      await assert.rejects(fetch(relay.url + '/session', { signal: AbortSignal.timeout(1000) }));
      facts.cleanup.push({ port, relayStopped: true });
    }
  });
}

check('ordinary Rust sync handshake and absent capability leave remote durability unknown and outbox pending', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach(null); await h.client.pump(0);
    return { state: h.client.state, pending: (await h.pending()).length, frames: h.frames.map(frame => frame[0]), peer: h.text(h.peer), local: h.text() }; });
  assert.equal(result.state.remoteDurability, 'unknown'); assert.equal(result.state.remoteCommitted, null);
  assert.equal(result.pending, 1); assert.deepEqual(result.frames, [0, 2]); assert.equal(result.peer, result.local); return result;
});
check('negotiated actual relay commit prunes only pending membership and preserves recovery journal', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); const receipt = await h.receipt(); await h.attach();
    const acknowledgments = await h.client.pump(0); const duplicate = await h.client.receiveReceipt(receipt);
    return { acknowledgments, duplicate, state: h.client.state, pending: (await h.pending()).length, journal: (await h.journal.read(h.identity)).length, recovered: h.recovered(), text: h.text() }; });
  assert.equal(result.acknowledgments.length, 1); assert.equal(result.acknowledgments[0].state, 'remoteCommitted');
  assert.equal(result.duplicate.state, 'remoteCommitted'); assert.equal(result.state.remoteCommitted, result.acknowledgments[0].updateId);
  assert.equal(result.pending, 0); assert.equal(result.journal, 1); assert.equal(result.recovered, result.text); return result;
});
for (const field of ['documentId', 'epoch', 'schema', 'writerId', 'sequence', 'checksum', 'updateId']) {
  check(`receipt ${field} mismatch cannot prune or claim remoteCommitted`, async page => {
    const result = await page.evaluate(async field => { const h = window.h; await h.edit(); await h.attach(); const r = await h.receipt();
      if (field === 'documentId' || field === 'epoch') r.identity[field] = '99999999-9999-4999-8999-999999999999';
      else if (field === 'schema') r.identity.schema += '-wrong';
      else if (field === 'writerId' || field === 'sequence') r[field]++;
      else if (field === 'checksum') r.checksum = '0'.repeat(64); else r.updateId += '-wrong';
      return { result: await h.client.receiveReceipt(r), pending: (await h.pending()).length, state: h.client.state }; }, field);
    assert.equal(result.result.state, 'ignored'); assert.equal(result.pending, 1); assert.equal(result.state.remoteCommitted, null); return result;
  });
}
check('denied authorization keeps offline commands editable and recovery export available without upload', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach('editac-durable-receipt-v1', false);
    await h.client.pump(0); await h.edit('D');
    return { state: h.client.state, pending: (await h.pending()).length, frames: h.frames.length, recovered: h.recovered(), text: h.text(), receipt: await h.client.receiveReceipt(await h.receipt()) }; });
  assert.equal(result.state.authorization, 'denied'); assert.equal(result.pending, 2); assert.equal(result.frames, 0);
  assert.equal(result.receipt.state, 'ignored'); assert.equal(result.recovered, result.text); return result;
});
check('service revocation stops upload and baseline traffic while retaining edits for authorized reconnect', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach(); await window.relayRevoke();
    await h.client.pump(0); const frames = h.frames.length; await h.edit('R'); await h.client.pump(1);
    return { state: h.client.state, pending: (await h.pending()).length, framesAfter: h.frames.length, frames, recovered: h.recovered(), text: h.text() }; });
  assert.equal(result.state.authorization, 'revoked'); assert.equal(result.pending, 2); assert.equal(result.framesAfter, result.frames);
  assert.equal(result.state.remoteCommitted, null); assert.equal(result.recovered, result.text); return result;
});
check('late committed response after revocation is fenced; reconnect resends idempotently', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); let release, arrived;
    const ready = new Promise(resolve => { arrived = resolve; });
    const transport = { async upload(entry) { const response = await h.durable.upload(entry); arrived(); await new Promise(resolve => { release = resolve; }); return response; } };
    await h.attach('editac-durable-receipt-v1', true, transport); const pumping = h.client.pump(0); await ready;
    h.client.deny('revoked'); release(); await pumping;
    const retained = (await h.pending()).length, revoked = h.client.state;
    await h.attach(); const acknowledgments = await h.client.pump(1);
    return { retained, revoked, acknowledgments, pending: (await h.pending()).length }; });
  assert.equal(result.retained, 1); assert.equal(result.revoked.remoteCommitted, null);
  assert.equal(result.acknowledgments[0].state, 'remoteCommitted'); assert.equal(result.pending, 0); return result;
});
check('receipt transaction abort cannot publish remoteCommitted or prune', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach();
    const native = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { const result = native.apply(this, args); if (this.name === 'receipts') this.transaction.abort(); return result; };
    let error;
    try { await h.client.pump(0); } catch (e) { error = e.name; } finally { IDBObjectStore.prototype.put = native; }
    const state = h.client.state, pending = (await h.pending()).length;
    const repaired = await h.client.pump(1); return { error, state, pending, repaired, remaining: (await h.pending()).length }; });
  assert.equal(result.error, 'AbortError'); assert.equal(result.pending, 1); assert.equal(result.state.remoteCommitted, null);
  assert.equal(result.repaired[0].state, 'remoteCommitted'); assert.equal(result.remaining, 0); return result;
});
check('new local commit during durable upload restarts the bounded replay cursor', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); let once = false;
    const transport = { async upload(entry) { if (!once) { once = true; await h.edit('N'); } return h.durable.upload(entry); } };
    await h.attach('editac-durable-receipt-v1', true, transport); await h.client.pump(0);
    const retained = (await h.pending()).length; await h.client.pump(1);
    return { retained, pending: (await h.pending()).length, journal: (await h.journal.read(h.identity)).length }; });
  assert.equal(result.retained, 1); assert.equal(result.pending, 0); assert.equal(result.journal, 2); return result;
});
check('unsupported negotiation and wrong peer identity fail before replacing an authorized connection', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach(); const errors = [];
    for (const negotiation of [{ identity: h.identity, receiptProtocol: 'unknown-v2' }, { identity: { ...h.identity, epoch: '99999999-9999-4999-8999-999999999999' }, receiptProtocol: null }]) {
      try { h.client.attach(h.baseline, negotiation, h.durable, true); } catch (e) { errors.push(e.message); }
    }
    const state = h.client.state; const acknowledgments = await h.client.pump(0); return { errors, state, acknowledgments }; });
  assert.equal(result.errors.length, 2); assert.equal(result.state.authorization, 'authorized');
  assert.equal(result.acknowledgments[0].state, 'remoteCommitted'); return result;
});

check('malformed non-durable receipts fail admission and capability absence ignores even a valid receipt', async page => {
  const result = await page.evaluate(async () => { const h = window.h; await h.edit(); await h.attach(); const r = await h.receipt(), errors = [];
    for (const malformed of [{ ...r, state: 'synced' }, { ...r, protocol: 'sync' }, { ...r, checksum: 'not-a-hash' }]) {
      try { await h.client.receiveReceipt(malformed); } catch (e) { errors.push(e.message); }
    }
    await h.attach(null); const ignored = await h.client.receiveReceipt(r);
    return { errors, ignored, pending: (await h.pending()).length, state: h.client.state }; });
  assert.equal(result.errors.length, 3); assert.equal(result.ignored.reason, 'capability-unavailable');
  assert.equal(result.pending, 1); assert.equal(result.state.remoteCommitted, null); return result;
});
check('durable replay is bounded to one page per event without dropping the remaining local backlog', async page => {
  const result = await page.evaluate(async () => { const h = window.h;
    for (let i = 0; i < 35; i++) await h.edit('P');
    await h.attach(); const first = await h.client.pump(0), retained = (await h.pending()).length;
    const second = await h.client.pump(1);
    return { first: first.length, retained, second: second.length, pending: (await h.pending()).length, journal: (await h.journal.read(h.identity)).length }; });
  assert.equal(result.first, 32); assert.equal(result.retained, 3); assert.equal(result.second, 3);
  assert.equal(result.pending, 0); assert.equal(result.journal, 35); return result;
});
