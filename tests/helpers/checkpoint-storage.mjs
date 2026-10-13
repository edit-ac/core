/** Deterministic IndexedDB transaction boundary; publication stays staged until complete. */
export class CheckpointIndexedDB {
  stores = { checkpoints: new Map(), updates: new Map() };
  objectStoreNames = { contains: name => name in this.stores };
  activeWrite = null; queuedWrites = []; transactions = []; waiters = []; writes = []; closed = false; strictSupported = true; creationError = null;
  open() { const r = {}; queueMicrotask(() => { r.result = this; r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; }
  createObjectStore(name) { this.stores[name] = new Map(); return { createIndex() {} }; }
  close() { this.closed = true; }
  transaction(names, mode, options) {
    if (this.creationError) throw this.creationError;
    if (mode === 'readwrite' && this.writeCreationError) throw this.writeCreationError;
    if (options && !this.strictSupported) throw new TypeError('Unsupported strict durability');
    const tx = new Transaction(this, mode, options ? 'strict' : 'default'); this.transactions.push(tx);
    if (mode === 'readwrite') { if (this.activeWrite) this.queuedWrites.push(tx); else this.activeWrite = tx; this.writes.push(tx); this.waiters.shift()?.(tx); }
    return tx;
  }
  nextWrite() { return this.writes.length ? Promise.resolve(this.writes.shift()) : new Promise(resolve => this.waiters.push(tx => { this.writes.shift(); resolve(tx); })); }
}
class Transaction {
  deferred = []; pending = 0; staged = []; error = null; aborted = false;
  constructor(db, mode, durability) { Object.assign(this, { db, mode, durability }); }
  schedule(fn) { if (this.mode === 'readwrite' && this.db.activeWrite !== this) this.deferred.push(fn); else queueMicrotask(fn); }
  release() { if (this.db.activeWrite === this) { this.db.activeWrite = this.db.queuedWrites.shift() ?? null; for (const fn of this.db.activeWrite?.deferred.splice(0) ?? []) queueMicrotask(fn); } else this.db.queuedWrites = this.db.queuedWrites.filter(tx => tx !== this); }
  objectStore(name) {
    const read = (fn) => {
      const r = {}; this.pending++;
      this.schedule(() => { if (this.aborted) return; r.result = structuredClone(fn()); r.onsuccess?.(); if (--this.pending === 0 && this.mode === 'readonly') this.complete(); });
      return r;
    };
    return {
      get: key => read(() => this.db.stores[name].get(JSON.stringify(key))),
      index: () => ({
        getAll: scope => read(() => [...this.db.stores[name].values()].filter(e => [e.identity.documentId, e.identity.epoch, e.identity.schema].every((v,i) => v === scope[i]))),
        openCursor: scope => {
          const values = [...this.db.stores[name].values()].filter(e => [e.identity.documentId, e.identity.epoch, e.identity.schema].every((v,i) => v === scope[i]))
            .sort((a,b) => a.writerId - b.writerId || a.sequence - b.sequence);
          const request = {}; let position = 0;
          const next = () => {
            this.pending++;
            this.schedule(() => {
              if (this.aborted) return;
              const value = values[position++];
              request.result = value ? { value: structuredClone(value), continue: next,
                continuePrimaryKey: (key, primary) => {
                  position = values.findIndex(e => e.writerId > primary[3] || (e.writerId === primary[3] && e.sequence >= primary[4]));
                  if (position < 0) position = values.length;
                  next();
                } } : null;
              request.onsuccess?.();
              if (--this.pending === 0 && this.mode === 'readonly' && !this.aborted) this.complete();
            });
          };
          next(); return request;
        },
      }),
      put: (value, key) => { if (this.db.putError) throw this.db.putError; this.staged.push([name, JSON.stringify(key), structuredClone(value)]); return {}; },
      add: value => { const key = [value.identity.documentId, value.identity.epoch, value.identity.schema, value.writerId, value.sequence]; this.staged.push([name, JSON.stringify(key), structuredClone(value)]); return {}; },
    };
  }
  requestSuccess() { this.requestSucceeded = true; }
  abort(error = new DOMException('Injected abort', 'AbortError')) { this.error = error; this.aborted = true; this.staged = []; this.release(); queueMicrotask(() => this.onabort?.()); }
  complete() { if (this.aborted) throw Error('Aborted transaction'); if (this.pending) throw Error('Pending requests'); for (const [name,key,value] of this.staged) this.db.stores[name].set(key,value); this.oncomplete?.(); this.release(); }
}
