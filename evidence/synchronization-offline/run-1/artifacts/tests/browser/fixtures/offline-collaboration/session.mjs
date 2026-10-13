import { init } from '/core/index.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { UpdateOutbox, durableReceiptProtocol } from '/web/storage/outbox.js';
import { SyncSession } from '/web/sync/session.js';
import { ReceiptSession } from '/web/sync/receipts.js';

// No editor, timers, unload flush, credentials or external transport. The host
// drives actual adapters and provides only prepared loopback relay requests.
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
window.start = async initial => {
  const identity = initial.identity;
  const engine = runtime.restoreEngine(identity, { ...initial, bytes: new Uint8Array(initial.bytes) });
  const journal = await UpdateJournal.open(indexedDB, 'offline-collaboration');
  const outbox = await UpdateOutbox.open(indexedDB, 'offline-collaboration', durableReceiptProtocol);
  const restored = await journal.read(identity);
  for (const entry of restored) engine.applyUpdate({ identity, bytes: entry.bytes });
  const sync = new SyncSession(engine, outbox), client = new ReceiptSession(engine, sync, outbox);
  let committed = Promise.resolve(), receiptFailure = null;
  const outgoing = [], acknowledgments = [], events = [];
  const sub = engine.subscribe({ type: 'updates' }, patch => {
    if (!patch.update) return;
    const update = { identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence,
      origin: patch.origin, bytes: patch.update.bytes };
    events.push({ writerId: update.writerId, sequence: update.sequence, origin: update.origin });
    committed = committed.then(async () => {
      const result = await journal.append(update);
      acknowledgments.push(result); client.localCommitted(update.origin);
    });
  });
  const baseline = { send(frame) { outgoing.push(Array.from(frame)); return true; } };
  const durable = { async upload(entry) {
    const { status, body } = await window.relayCall('/updates', {
      ...entry, bytes: btoa(String.fromCharCode(...entry.bytes)) });
    if (status !== 200) throw Error(body.error);
    return { receipt: body.receipt };
  } };
  async function attach(receipts = false) {
    await committed;
    if (receipts) {
      const response = await window.relayCall('/session', { identity, receiptProtocol: durableReceiptProtocol });
      if (response.status !== 200) throw Error(response.body.error);
      client.attach(baseline, response.body, durable, true);
    } else client.attach(baseline, { identity, receiptProtocol: null }, null, true);
  }
  async function edit(text, offset = 3) {
    const at = engine.anchor(engine.read().visible[0].id, offset, 'right');
    try { engine.commit(engine.prepare({ kind: 'text', origin: 'local:offline-fixture', command: { type: 'insert', at, text } })); }
    finally { engine.releaseAnchor(at); }
    await committed;
    return acknowledgments.at(-1);
  }
  function semantic() { return engine.read().visible.map(n => ({ id: n.id, parent: n.parent,
    kind: n.kind, attributes: n.blockAttributes, runs: n.runs, spans: n.spans })); }
  async function state() {
    await committed;
    return { semantic: semantic(), text: semantic().map(n => n.runs.map(r => r.text).join('')),
      vector: Array.from(engine.stateVector()), bytes: Array.from(engine.encodeUpdate().bytes),
      pending: (await outbox.pending(identity)).map(e => ({ ...e, bytes: Array.from(e.bytes) })),
      journal: (await journal.read(identity)).map(e => ({ updateId: e.updateId, writerId: e.writerId,
        sequence: e.sequence, origin: e.origin, checksum: e.checksum })),
      receipt: client.state, sync: sync.state, events, acknowledgments,
      restored: restored.map(e => e.updateId), receiptFailure };
  }
  window.h = { engine, sync, client, journal, outbox, edit, attach, state,
    detach() { client.detach(); outgoing.length = 0; },
    receive(frame) { sync.receive(new Uint8Array(frame)); },
    async drain(now) { await committed; await sync.pump(now); await committed; return outgoing.splice(0); },
    // Keep a faulted upload observable without turning it into a receipt.
    upload(now) { receiptFailure = null; window.uploadDone = false;
      window.uploadPromise = client.pump(now).catch(error => { receiptFailure = error.message; }).finally(() => { window.uploadDone = true; }); },
    async replay() {
      const response = await window.relayCall('/replay', { after: 0, limit: 64 });
      if (response.status !== 200 || !response.body.done) throw Error('Unexpected bounded replay');
      for (const entry of response.body.entries) engine.applyUpdate({ identity, bytes: Uint8Array.from(atob(entry.bytes), c => c.charCodeAt(0)) });
      await committed; return response.body;
    },
    async close() { await committed; client.detach(); sync.dispose(); sub.dispose(); journal.close(); outbox.close(); engine.dispose(); }
  };
  return state();
};
