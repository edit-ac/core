import type { Checkpoint } from "@edit-ac/core";
import { checksum, identityKey, ownIdentity, openStorageDatabase, verifyEntries, JournalIntegrityError,
  type JournalIdentity, type JournalEntry } from "./journal.js";

export interface StoredCheckpoint {
  version: 1;
  checkpoint: Checkpoint;
  /** Exact immutable journal identities included in the engine state. */
  coverage: string[];
  checksum: string;
  manifestHash: string;
}
interface Publication { latest?: StoredCheckpoint; previous?: StoredCheckpoint; revision?: string }
export class CheckpointConflictError extends Error {
  constructor() { super("Concurrent checkpoint publication; retry from current storage"); this.name = "CheckpointConflictError"; }
}
const publicationVersion = (p: Publication) => JSON.stringify([p.revision, p.latest?.manifestHash, p.previous?.manifestHash]);
export interface RecoveryState {
  checkpoint: Checkpoint;
  tail: JournalEntry[];
  source: "latest" | "previous";
  rejected: string[];
}
const scope = (identity: JournalIdentity) => [identity.documentId, identity.epoch, identity.schema];
const key = (identity: JournalIdentity) => JSON.stringify(scope(identity));
function ownCheckpoint(input: Checkpoint): Checkpoint {
  const identity = ownIdentity(input.identity);
  if (input.initialized !== true || !Number.isSafeInteger(input.writerId) || input.writerId <= 0
    || !(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new JournalIntegrityError("Invalid CRDT checkpoint");
  return { identity, initialized: true, writerId: input.writerId, bytes: new Uint8Array(input.bytes) };
}
async function manifest(record: Omit<StoredCheckpoint, "manifestHash">): Promise<string> {
  return checksum(new TextEncoder().encode(JSON.stringify([record.version, identityKey(record.checkpoint.identity),
    record.checkpoint.initialized, record.checkpoint.writerId, record.checksum, record.coverage])));
}
async function validate(record: StoredCheckpoint, expected: JournalIdentity): Promise<StoredCheckpoint> {
  if (record.version !== 1 || !Array.isArray(record.coverage) || record.coverage.some(id => typeof id !== "string")
    || new Set(record.coverage).size !== record.coverage.length) throw new JournalIntegrityError("Unsupported checkpoint version/coverage");
  const checkpoint = ownCheckpoint(record.checkpoint);
  if (identityKey(checkpoint.identity) !== identityKey(expected)) throw new JournalIntegrityError("Checkpoint identity mismatch");
  if (await checksum(checkpoint.bytes) !== record.checksum || await manifest(record) !== record.manifestHash)
    throw new JournalIntegrityError("Corrupt checkpoint bytes or coverage");
  return { ...record, checkpoint, coverage: [...record.coverage] };
}

/** Internal browser adapter. Retains all journal/outbox bytes; compaction requires later receipt policy. */
export class CheckpointStorage {
  private constructor(private readonly database: IDBDatabase) {}
  static async open(factory: IDBFactory, name = "editac-local-storage"): Promise<CheckpointStorage> {
    return new CheckpointStorage(await openStorageDatabase(factory, name));
  }
  close(): void { this.database.close(); }

  private readRaw(identity: JournalIdentity): Promise<{ publication: Publication; entries: JournalEntry[] }> {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction(["checkpoints", "updates"], "readonly");
      let publication: Publication = {}, entries: JournalEntry[] = [];
      tx.oncomplete = () => resolve({ publication, entries });
      tx.onabort = () => reject(tx.error ?? new DOMException("Checkpoint read aborted", "AbortError"));
      const point = tx.objectStore("checkpoints").get(key(identity));
      point.onsuccess = () => { publication = point.result ?? {}; };
      const tail = tx.objectStore("updates").index("documentEpochSchema").getAll(scope(identity));
      tail.onsuccess = () => { entries = tail.result; };
    });
  }

  /** The host captures coverage from the same engine state as bytes. Publication acknowledges only completion. */
  async publish(input: Checkpoint, coveredUpdateIds: readonly string[]): Promise<{ state: "checkpointCommitted"; durability: IDBTransactionDurability | "unknown" }> {
    const checkpoint = ownCheckpoint(input);
    const coverage = [...coveredUpdateIds];
    if (coverage.some(id => typeof id !== "string") || new Set(coverage).size !== coverage.length)
      throw new JournalIntegrityError("Invalid checkpoint coverage");
    const raw = await this.readRaw(checkpoint.identity);
    const entries = await verifyEntries(raw.entries, checkpoint.identity);
    const ids = new Set(entries.map(e => e.updateId));
    if (coverage.some(id => !ids.has(id))) throw new JournalIntegrityError("Checkpoint covers an uncommitted or foreign update");
    // Validate retained fallback before starting the write transaction (no async work inside IDB transaction).
    let previous: StoredCheckpoint | undefined;
    for (const candidate of [raw.publication.latest, raw.publication.previous]) {
      if (!candidate) continue;
      try { previous = await validate(candidate, checkpoint.identity); break; } catch { /* keep searching */ }
    }
    const base = { version: 1 as const, checkpoint, coverage, checksum: await checksum(checkpoint.bytes) };
    const latest: StoredCheckpoint = { ...base, manifestHash: await manifest(base) };
    let tx: IDBTransaction;
    try { tx = this.database.transaction("checkpoints", "readwrite", { durability: "strict" }); }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "NotSupportedError")) throw error;
      tx = this.database.transaction("checkpoints", "readwrite");
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ state: "checkpointCommitted", durability: tx.durability ?? "unknown" });
      tx.onabort = () => reject(tx.error ?? new DOMException("Checkpoint publication aborted", "AbortError"));
      let failure: unknown;
      tx.onabort = () => reject(failure ?? tx.error ?? new DOMException("Checkpoint publication aborted", "AbortError"));
      const abort = (error: unknown) => { failure = error; tx.abort(); };
      try {
        const store = tx.objectStore("checkpoints");
        const current = store.get(key(checkpoint.identity));
        current.onsuccess = () => {
          try {
            // IndexedDB serializes overlapping readwrite transactions. Never replace
            // a publication whose fallback was validated from a stale read snapshot.
            if (publicationVersion(current.result ?? {}) !== publicationVersion(raw.publication))
              throw new CheckpointConflictError();
            store.put({ latest, previous, revision: globalThis.crypto.randomUUID() }, key(checkpoint.identity));
          } catch (error) { abort(error); }
        };
      } catch (error) { abort(error); }
    });
  }

  /** Rust callback validates semantic checkpoint bytes and replays the retained tail before exposing a document. */
  async restore<T>(expectedInput: JournalIdentity, restore: (state: RecoveryState) => T): Promise<{ value: T; recovery: RecoveryState }> {
    const expected = ownIdentity(expectedInput);
    const raw = await this.readRaw(expected);
    const entries = await verifyEntries(raw.entries, expected);
    const rejected: string[] = [];
    for (const source of ["latest", "previous"] as const) {
      const candidate = raw.publication[source];
      if (!candidate) continue;
      try {
        const valid = await validate(candidate, expected);
        // Retain and replay even covered updates: CRDT replay is idempotent, and this avoids trusting coverage to omit bytes.
        const recovery: RecoveryState = { checkpoint: valid.checkpoint, tail: entries, source, rejected: [...rejected] };
        return { value: restore(recovery), recovery };
      } catch (error) { rejected.push(`${source}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new JournalIntegrityError(`No valid recovery checkpoint: ${rejected.join("; ") || "missing checkpoint"}`);
  }
}
