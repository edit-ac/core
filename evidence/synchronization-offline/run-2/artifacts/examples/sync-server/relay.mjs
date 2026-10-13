/** Test-only durable byte relay. No production authorization or schema-validation claim. */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export const receiptProtocol = 'editac-durable-receipt-v1';
const fields = ['profile', 'schema', 'documentId', 'epoch', 'protocolVersion', 'updateEncoding', 'offsets'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = identity => JSON.stringify(fields.map(field => identity[field]));
class RelayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function fail(status, code) { throw new RelayError(status, code); }
function ownIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => value[field] === undefined)
    || !uuid.test(value.documentId) || !uuid.test(value.epoch)
    || typeof value.profile !== 'string' || !value.profile || value.profile.length > 128
    || typeof value.schema !== 'string' || !value.schema || value.schema.length > 128
    || value.protocolVersion !== 1 || value.updateEncoding !== 1 || value.offsets !== 'utf16') fail(400, 'invalid-metadata');
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
function sameIdentity(expected, offered) {
  for (const field of fields) if (expected[field] !== offered[field]) {
    fail(409, field === 'documentId' ? 'wrong-document' : field === 'epoch' ? 'wrong-epoch' : 'unsupported-profile');
  }
}
function positive(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function admit(input, identity, maxBytes) {
  sameIdentity(identity, ownIdentity(input?.identity));
  if (!positive(input.writerId, 0xffffffff) || !positive(input.sequence)
    || typeof input.origin !== 'string' || input.origin.length > 256
    || typeof input.bytes !== 'string' || input.bytes.length > Math.ceil(maxBytes / 3) * 4) fail(400, 'invalid-update');
  const bytes = Buffer.from(input.bytes, 'base64');
  if (!bytes.length || bytes.toString('base64') !== input.bytes) fail(400, 'invalid-update');
  if (bytes.length > maxBytes) fail(413, 'update-limit');
  const checksum = hash(bytes);
  const updateId = JSON.stringify([key(identity), input.writerId, input.sequence, checksum]);
  if (input.checksum !== checksum || input.updateId !== updateId) fail(400, 'content-identity-mismatch');
  return { identity, writerId: input.writerId, sequence: input.sequence, origin: input.origin, bytes, checksum, updateId };
}
function wire(row) {
  const bytes = Buffer.from(row.bytes);
  const identity = ownIdentity(JSON.parse(row.identity));
  if (hash(bytes) !== row.checksum || row.update_id !== JSON.stringify([key(identity), row.writer, row.sequence, row.checksum])) {
    fail(500, 'corrupt-storage');
  }
  return { cursor: row.id, identity, writerId: row.writer, sequence: row.sequence, origin: row.origin,
    bytes: bytes.toString('base64'), checksum: row.checksum, updateId: row.update_id };
}
async function body(request, limit) {
  if (request.headers['content-type'] !== 'application/json') fail(415, 'json-required');
  if (Number(request.headers['content-length']) > limit) fail(413, 'body-limit');
  const parts = []; let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) fail(413, 'body-limit');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { fail(400, 'invalid-json'); }
}

/** Each fixture grants one token access to one complete immutable identity.
 * fault(boundary, entry) is harness-only injection, never a network control.
 */
export async function startReferenceRelay({ databasePath, grants, host = '127.0.0.1', port = 0,
  maxUpdateBytes = 1024 * 1024, maxReplayBytes = 1024 * 1024, maxQueue = 32, maxSessions = 64,
  fault = async () => {} }) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Reference relay must bind loopback');
  if (!databasePath || databasePath === ':memory:' || !Array.isArray(grants) || !grants.length
    || [maxUpdateBytes, maxReplayBytes, maxQueue, maxSessions].some(v => !positive(v))
    || maxUpdateBytes > 16 * 1024 * 1024 || maxReplayBytes > 16 * 1024 * 1024 || maxReplayBytes < maxUpdateBytes) {
    throw new Error('Persistent database, prepared grants and bounded limits required');
  }
  const prepared = new Map();
  for (const grant of grants) {
    if (typeof grant.token !== 'string' || !grant.token || grant.token.length > 256 || prepared.has(grant.token)) throw new Error('Invalid prepared grant');
    prepared.set(grant.token, ownIdentity(grant.identity));
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS documents (document TEXT, epoch TEXT, identity TEXT NOT NULL, PRIMARY KEY(document,epoch)) STRICT;
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL, epoch TEXT NOT NULL,
        writer INTEGER NOT NULL, sequence INTEGER NOT NULL, identity TEXT NOT NULL, origin TEXT NOT NULL,
        bytes BLOB NOT NULL, checksum TEXT NOT NULL, update_id TEXT NOT NULL,
        UNIQUE(document,epoch,writer,sequence)) STRICT;`);
    // Persist metadata authority: a restart cannot reinterpret stored bytes under another profile.
    db.exec('BEGIN IMMEDIATE');
    for (const identity of prepared.values()) {
      const row = db.prepare('SELECT identity FROM documents WHERE document=? AND epoch=?').get(identity.documentId, identity.epoch);
      if (row) sameIdentity(ownIdentity(JSON.parse(row.identity)), identity);
      else db.prepare('INSERT INTO documents VALUES (?,?,?)').run(identity.documentId, identity.epoch, JSON.stringify(identity));
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  let tail = Promise.resolve(), queued = 0, closing = false;
  const sessions = new Map();
  function serial(work) {
    if (closing) fail(503, 'closing');
    if (queued >= maxQueue) fail(429, 'queue-limit');
    queued++;
    const result = tail.then(work);
    tail = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }
  async function commit(entry) {
    const args = [entry.identity.documentId, entry.identity.epoch, entry.writerId, entry.sequence];
    const existing = db.prepare('SELECT * FROM updates WHERE document=? AND epoch=? AND writer=? AND sequence=?').get(...args);
    if (existing) {
      const saved = wire(existing);
      if (saved.updateId !== entry.updateId || saved.bytes !== entry.bytes.toString('base64') || key(saved.identity) !== key(entry.identity)) fail(409, 'sequence-conflict');
      return { cursor: existing.id, duplicate: true };
    }
    await fault('before-transaction', entry);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const result = db.prepare('INSERT INTO updates(document,epoch,writer,sequence,identity,origin,bytes,checksum,update_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(...args, JSON.stringify(entry.identity), entry.origin, entry.bytes, entry.checksum, entry.updateId);
      await fault('before-commit', entry);
      db.exec('COMMIT'); transaction = false;
      await fault('after-commit', entry);
      return { cursor: Number(result.lastInsertRowid), duplicate: false };
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function authorize(request) {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const identity = prepared.get(token);
    if (!identity) fail(403, 'denied');
    return { token, identity };
  }
  function session(request, auth) {
    const id = request.headers['x-editac-session'], value = sessions.get(id);
    if (!value || value.token !== auth.token || Date.now() - value.created > 60 * 60 * 1000) {
      if (value && Date.now() - value.created > 60 * 60 * 1000) sessions.delete(id);
      fail(403, 'session-required');
    }
    return value;
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(value));
      }
    };
    try {
      if (request.method !== 'POST' || !['/session', '/updates', '/replay'].includes(request.url)) fail(404, 'not-found');
      const auth = authorize(request);
      if (request.url === '/session') {
        const input = await body(request, 2048);
        sameIdentity(auth.identity, ownIdentity(input.identity));
        if (input.receiptProtocol !== undefined && input.receiptProtocol !== null && input.receiptProtocol !== receiptProtocol) fail(400, 'unsupported-receipt-protocol');
        for (const [id, value] of sessions) if (Date.now() - value.created > 60 * 60 * 1000) sessions.delete(id);
        if (sessions.size >= maxSessions) fail(429, 'session-limit');
        const id = randomUUID(), protocol = input.receiptProtocol === receiptProtocol ? receiptProtocol : null;
        sessions.set(id, { token: auth.token, created: Date.now(), protocol });
        send(200, { session: id, identity: auth.identity, receiptProtocol: protocol, testOnly: true });
        return;
      }
      const active = session(request, auth);
      if (request.url === '/updates') {
        const input = await body(request, Math.ceil(maxUpdateBytes / 3) * 4 + 4096);
        const entry = admit(input, auth.identity, maxUpdateBytes);
        const result = await serial(async () => {
          // Recheck authorization after queueing; revocation must prevent uncommitted uploads.
          if (!prepared.has(auth.token)) fail(403, 'revoked');
          const committed = await commit(entry);
          await fault('before-receipt', entry);
          return committed;
        });
        const receipt = active.protocol === receiptProtocol ? { protocol: receiptProtocol, state: 'durable', identity: entry.identity,
          writerId: entry.writerId, sequence: entry.sequence, checksum: entry.checksum, updateId: entry.updateId } : null;
        send(200, { ...result, receipt, remoteDurability: receipt ? 'durable' : 'unknown' });
      } else {
        const input = await body(request, 1024);
        const after = input.after ?? 0, limit = input.limit ?? 64;
        if (!Number.isSafeInteger(after) || after < 0 || !positive(limit, 256)) fail(400, 'invalid-cursor');
        const result = await serial(() => {
          const rows = db.prepare('SELECT * FROM updates WHERE document=? AND epoch=? AND id>? ORDER BY id LIMIT ?')
            .all(auth.identity.documentId, auth.identity.epoch, after, limit + 1);
          const entries = []; let size = 0;
          for (const row of rows.slice(0, limit)) {
            if (size + row.bytes.length > maxReplayBytes) break;
            size += row.bytes.length; entries.push(wire(row));
          }
          return { entries, after: entries.at(-1)?.cursor ?? after, done: entries.length === rows.length };
        });
        send(200, result);
      }
    } catch (error) { send(error.status ?? 500, { error: error.code ?? 'storage-failure' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { db.close(); throw error; }
  const address = server.address();
  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    revoke(token) { prepared.delete(token); for (const [id, value] of sessions) if (value.token === token) sessions.delete(id); },
    async close() {
      closing = true;
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      await tail; db.close();
    },
  };
}
