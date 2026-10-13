/** Controllable IndexedDB-shaped boundary. Only complete publishes staged writes. */
export class PreparedIndexedDB {
  records = new Map();
  transactions = [];
  strictSupported = true;
  durability = 'strict';
  creationError = null;
  waiters = [];
  consumed = 0;
  closed = false;
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = this;
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
  objectStoreNames = { contains: () => false };
  createObjectStore() { return { createIndex() {} }; }
  close() { this.closed = true; }
  transaction(store, mode, options) {
    if (this.creationError) throw this.creationError;
    if (this.closed) throw new DOMException('Closed', 'InvalidStateError');
    if (options && !this.strictSupported) throw new TypeError('Unsupported durability options');
    const tx = new PreparedTransaction(this, mode, options ? this.durability : 'default');
    this.transactions.push(tx);
    this.waiters.shift()?.(tx);
    return tx;
  }
  nextTransaction() {
    const tx = this.transactions[this.consumed++];
    return tx ? Promise.resolve(tx) : new Promise(resolve => this.waiters.push(resolve));
  }
}

class PreparedTransaction {
  staged = new Map();
  error = null;
  request = null;
  write = null;
  constructor(database, mode, durability) { Object.assign(this, { database, mode, durability }); }
  objectStore() { return this; }
  index() { return this; }
  get(key) { this.key = JSON.stringify(key); return this.request = {}; }
  getAll(scope) { this.scope = scope; return this.request = {}; }
  add(entry) { this.entry = structuredClone(entry); return this.write = {}; }
  lookupSuccess() {
    this.request.result = this.scope
      ? [...this.database.records.values()].filter(e => [e.identity.documentId, e.identity.epoch, e.identity.schema].every((v, i) => v === this.scope[i])).map(e => structuredClone(e))
      : structuredClone(this.database.records.get(this.key));
    this.request.onsuccess?.();
  }
  writeSuccess() { this.staged.set(this.key, this.entry); this.write.onsuccess?.(); }
  requestFailure(error, write = true) {
    const request = write ? this.write : this.request;
    request.error = error;
    request.onerror?.();
    this.error = error;
    this.onerror?.();
    this.abort();
  }
  abort() { this.staged.clear(); this.aborted = true; queueMicrotask(() => this.onabort?.()); }
  complete() {
    if (this.aborted) throw new Error('Cannot complete aborted transaction');
    for (const [key, value] of this.staged) this.database.records.set(key, structuredClone(value));
    this.oncomplete?.();
  }
}
