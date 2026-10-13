/** Browser storage only: engine semantics and replay remain owned by Rust. */
export interface JournalIdentity {
  profile: string;
  schema: string;
  documentId: string;
  epoch: string;
  protocolVersion: number;
  updateEncoding: number;
  offsets: "utf16";
}

export interface JournalUpdate {
  identity: JournalIdentity;
  writerId: number;
  sequence: number;
  origin: string;
  bytes: Uint8Array;
}

export interface JournalEntry extends JournalUpdate {
  checksum: string;
  /** Stable pending-receipt identity; checkpoints must not erase it. */
  updateId: string;
}

export interface LocalCommit {
  state: "localCommitted";
  updateId: string;
  durability: IDBTransactionDurability | "unknown";
}

export class JournalIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "JournalIntegrityError"; }
}

const storeName = "updates";
const keyPath = ["identity.documentId", "identity.epoch", "identity.schema", "writerId", "sequence"];
const identityFields = ["profile", "schema", "documentId", "epoch", "protocolVersion", "updateEncoding", "offsets"] as const;

export function identityKey(identity: JournalIdentity): string {
  return JSON.stringify(identityFields.map(field => identity[field]));
}

export function ownIdentity(identity: JournalIdentity): JournalIdentity {
  if (!identity || [identity.profile, identity.schema, identity.documentId, identity.epoch].some(v => typeof v !== "string" || v.length === 0)
    || identity.offsets !== "utf16" || identity.protocolVersion !== 1 || identity.updateEncoding !== 1) {
    throw new JournalIntegrityError("Missing or unsupported document identity/schema/encoding");
  }
  return { profile: identity.profile, schema: identity.schema, documentId: identity.documentId, epoch: identity.epoch,
    protocolVersion: identity.protocolVersion, updateEncoding: identity.updateEncoding, offsets: identity.offsets };
}

function ownUpdate(update: JournalUpdate): JournalUpdate {
  const identity = ownIdentity(update.identity);
  if (!Number.isSafeInteger(update.writerId) || update.writerId <= 0 || !Number.isSafeInteger(update.sequence) || update.sequence <= 0
    || typeof update.origin !== "string" || !update.origin || !(update.bytes instanceof Uint8Array) || update.bytes.length === 0) {
    throw new JournalIntegrityError("Invalid writer/sequence/origin/update bytes");
  }
  return { identity, writerId: update.writerId, sequence: update.sequence, origin: update.origin, bytes: new Uint8Array(update.bytes) };
}

export async function checksum(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

function updateId(update: JournalUpdate, hash: string): string {
  return JSON.stringify([identityKey(update.identity), update.writerId, update.sequence, hash]);
}

function equalEntry(a: JournalEntry, b: JournalEntry): boolean {
  return identityKey(a.identity) === identityKey(b.identity) && a.writerId === b.writerId && a.sequence === b.sequence
    && a.origin === b.origin && a.checksum === b.checksum && a.updateId === b.updateId
    && a.bytes instanceof Uint8Array && a.bytes.length === b.bytes.length && a.bytes.every((v, i) => v === b.bytes[i]);
}

/** Internal adapter, not yet a published editor API. No unload handler or enqueue acknowledgment. */
export class UpdateJournal {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(factory: IDBFactory, name = "editac-local-storage"): Promise<UpdateJournal> {
    return new UpdateJournal(await openStorageDatabase(factory, name));
  }

  close(): void { this.database.close(); }

  /** Captures owned input before the first await. Repeated identity is a no-op; collisions abort. */
  async append(input: JournalUpdate): Promise<LocalCommit> {
    const update = ownUpdate(input);
    const hash = await checksum(update.bytes);
    const entry: JournalEntry = { ...update, checksum: hash, updateId: updateId(update, hash) };
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction(storeName, "readwrite", { durability: "strict" });
    } catch (error) {
      // Only unsupported options permit a fallback. Quota, permission and closed-DB errors remain errors.
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "NotSupportedError")) throw error;
      transaction = this.database.transaction(storeName, "readwrite");
    }
    return new Promise((resolve, reject) => {
      let failure: unknown;
      transaction.oncomplete = () => resolve({ state: "localCommitted", updateId: entry.updateId, durability: transaction.durability ?? "unknown" });
      transaction.onabort = () => reject(failure ?? transaction.error ?? new DOMException("Journal transaction aborted", "AbortError"));
      transaction.onerror = () => { failure ??= transaction.error; };
      const abort = (error: unknown) => {
        failure = error;
        try { transaction.abort(); } catch { reject(error); }
      };
      try {
        const store = transaction.objectStore(storeName);
        const request = store.get([entry.identity.documentId, entry.identity.epoch, entry.identity.schema, entry.writerId, entry.sequence]);
        request.onerror = () => { failure = request.error; };
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              if (!equalEntry(request.result as JournalEntry, entry)) throw new JournalIntegrityError("Journal key collision or corrupt existing update");
            } else {
              const write = store.add(entry);
              write.onerror = () => { failure = write.error; };
            }
          } catch (error) { abort(error); }
        };
      } catch (error) { abort(error); }
    });
  }

  /** Returns detached, verified entries for one trusted document/epoch/schema. */
  async read(identity: JournalIdentity): Promise<JournalEntry[]> {
    const expected = ownIdentity(identity);
    const entries = await new Promise<JournalEntry[]>((resolve, reject) => {
      const transaction = this.database.transaction(storeName, "readonly");
      let result: JournalEntry[] = [];
      let failure: unknown;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new DOMException("Journal read aborted", "AbortError"));
      transaction.onerror = () => { failure ??= transaction.error; };
      const request = transaction.objectStore(storeName).index("documentEpochSchema").getAll([expected.documentId, expected.epoch, expected.schema]);
      request.onerror = () => { failure = request.error; };
      request.onsuccess = () => { result = request.result as JournalEntry[]; };
    });
    return verifyEntries(entries, expected);
  }
}

/** Shared schema upgrade for journal, checkpoint and receipt adapters. */
export function openStorageDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, 3);
      let rejected = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          const store = request.result.createObjectStore(storeName, { keyPath });
          store.createIndex("documentEpochSchema", ["identity.documentId", "identity.epoch", "identity.schema"]);
        }
        if (!request.result.objectStoreNames.contains("checkpoints")) request.result.createObjectStore("checkpoints");
        if (!request.result.objectStoreNames.contains("receipts")) request.result.createObjectStore("receipts");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { rejected = true; reject(new Error("Journal database upgrade blocked")); };
      request.onsuccess = () => {
        const database = request.result;
        if (rejected) { database.close(); return; }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
}

export async function verifyEntries(entries: JournalEntry[], expected: JournalIdentity): Promise<JournalEntry[]> {
  return Promise.all(entries.map(async entry => {
      const update = ownUpdate(entry);
      if (identityKey(update.identity) !== identityKey(expected)) throw new JournalIntegrityError("Stored identity does not match trusted document");
      const hash = await checksum(update.bytes);
      if (hash !== entry.checksum || entry.updateId !== updateId(update, hash)) throw new JournalIntegrityError("Corrupt journal checksum or receipt identity");
      return { ...update, checksum: hash, updateId: entry.updateId };
    }));
}
