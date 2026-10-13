import { strictTransaction, completeTransaction } from "./transaction.js";
import { identityKey, ownIdentity, openStorageDatabase, verifyEntries, JournalIntegrityError,
  type JournalIdentity, type JournalEntry } from "./journal.js";

/** Host-negotiated application protocol, not a Yjs sync event or state vector. */
export const durableReceiptProtocol = "editac-durable-receipt-v1";
export interface DurableReceipt {
  protocol: typeof durableReceiptProtocol;
  state: "durable";
  identity: JournalIdentity;
  writerId: number;
  sequence: number;
  checksum: string;
  updateId: string;
}
export interface ReceiptResult {
  state: "remoteCommitted" | "ignored";
  updateId: string;
  reason?: "capability-unavailable" | "unknown-update" | "identity-mismatch";
}
export interface OutboxCursor { writerId: number; sequence: number }
export interface OutboxPage { entries: JournalEntry[]; after: OutboxCursor | null; done: boolean }

function ownReceipt(input: DurableReceipt): DurableReceipt {
  const identity = ownIdentity(input?.identity);
  if (input.protocol !== durableReceiptProtocol || input.state !== "durable"
    || !Number.isSafeInteger(input.writerId) || input.writerId <= 0
    || !Number.isSafeInteger(input.sequence) || input.sequence <= 0
    || typeof input.updateId !== "string" || !input.updateId
    || typeof input.checksum !== "string" || !/^[a-f0-9]{64}$/.test(input.checksum)) {
    throw new JournalIntegrityError("Invalid durable application receipt");
  }
  return { protocol: input.protocol, state: input.state, identity, writerId: input.writerId,
    sequence: input.sequence, checksum: input.checksum, updateId: input.updateId };
}
function matches(receipt: DurableReceipt, entry: JournalEntry): boolean {
  return receipt.updateId === entry.updateId && receipt.checksum === entry.checksum
    && receipt.writerId === entry.writerId && receipt.sequence === entry.sequence
    && identityKey(receipt.identity) === identityKey(entry.identity);
}

function unreceipted(entries: JournalEntry[], receipts: Map<string, DurableReceipt>): JournalEntry[] {
  return entries.filter(entry => {
    const marker = receipts.get(entry.updateId);
    if (!marker) return true;
    if (!matches(ownReceipt(marker), entry)) throw new JournalIntegrityError("Stored receipt identity mismatch");
    return false;
  });
}

/** Internal adapter. Receipts prune pending membership, never the journal's recovery tail.
 * The host passes only receipts from its negotiated durable application transport.
 * Existing v1/v2 journals are pending by default; upgrading does not infer acknowledgments.
 */
export class UpdateOutbox {
  readonly #database: IDBDatabase;
  private constructor(database: IDBDatabase, readonly receiptProtocol: typeof durableReceiptProtocol | null) {
    this.#database = database;}
  static async open(factory: IDBFactory, name = "editac-local-storage",
    receiptProtocol: typeof durableReceiptProtocol | null = null): Promise<UpdateOutbox> {
    if (receiptProtocol !== null && receiptProtocol !== durableReceiptProtocol) throw new JournalIntegrityError("Unsupported receipt capability");
    return new UpdateOutbox(await openStorageDatabase(factory, name), receiptProtocol);
  }
  close(): void { this.#database.close(); }

  /** Bounded cursor page for reconnect. The index's equal keys are ordered by
   * primary key (document/epoch/schema/writer/sequence). Receipted entries count
   * toward work limits too, so a long acknowledged prefix cannot monopolize a
   * single transaction. A caller restarts its cursor after new local commits. */
  async pendingPage(identity: JournalIdentity, after: OutboxCursor | null,
    maxEntries: number, maxBytes: number): Promise<OutboxPage> {
    const expected = ownIdentity(identity);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
      || (after && (!Number.isSafeInteger(after.writerId) || after.writerId <= 0 || !Number.isSafeInteger(after.sequence) || after.sequence <= 0))) {
      throw new JournalIntegrityError("Invalid outbox page bounds/cursor");
    }
    const tx = this.#database.transaction(["updates", "receipts"], "readonly");
    const entries: JournalEntry[] = [], receipts = new Map<string, DurableReceipt>();
    let last = after ? { ...after } : null, bytes = 0, done = false;
    const page = await completeTransaction(tx, "Outbox page aborted", () => ({ entries, receipts, after: last, done }), ({ watch }) => {
      const request = tx.objectStore("updates").index("documentEpochSchema").openCursor([expected.documentId, expected.epoch, expected.schema]);
      watch(request, cursor => {
        if (!cursor) { done = true; return; }
        const entry = cursor.value as JournalEntry;
        if (after && (entry.writerId < after.writerId || (entry.writerId === after.writerId && entry.sequence <= after.sequence))) {
          cursor.continuePrimaryKey([expected.documentId, expected.epoch, expected.schema],
            [expected.documentId, expected.epoch, expected.schema, after.writerId, after.sequence + 1]); return;
        }
        if (!(entry.bytes instanceof Uint8Array) || entry.bytes.length > maxBytes) throw new JournalIntegrityError("Pending update exceeds replay page byte limit");
        if (entries.length >= maxEntries || bytes + entry.bytes.length > maxBytes) return;
        entries.push(entry); bytes += entry.bytes.length; last = { writerId: entry.writerId, sequence: entry.sequence };
        watch(tx.objectStore("receipts").get(entry.updateId), receipt => { if (receipt !== undefined) receipts.set(entry.updateId, receipt); });
        cursor.continue();
      });
    });
    const verified = await verifyEntries(page.entries, expected);
    return { after: page.after, done: page.done, entries: unreceipted(verified, page.receipts) };
  }

  /** One snapshot of committed bytes and durable receipt markers, independent of checkpoints. */
  async pending(identity: JournalIdentity): Promise<JournalEntry[]> {
    const expected = ownIdentity(identity);
    const tx = this.#database.transaction(["updates", "receipts"], "readonly");
    let stored: JournalEntry[] = [];
    const receipts = new Map<string, DurableReceipt>();
    const raw = await completeTransaction(tx, "Outbox read aborted", () => ({ entries: stored, receipts }), ({ watch }) => {
      watch(tx.objectStore("updates").index("documentEpochSchema").getAll([expected.documentId, expected.epoch, expected.schema]), entries => {
        stored = entries;
        for (const entry of entries) watch(tx.objectStore("receipts").get(entry.updateId), receipt => {
          if (receipt !== undefined) receipts.set(entry.updateId, receipt);
        });
      });
    });
    const entries = await verifyEntries(raw.entries, expected);
    return unreceipted(entries, raw.receipts);
  }

  /** Remote acknowledgment becomes visible only after the local receipt transaction completes. */
  async accept(input: DurableReceipt): Promise<ReceiptResult> {
    const receipt = ownReceipt(input);
    if (this.receiptProtocol === null) return { state: "ignored", updateId: receipt.updateId, reason: "capability-unavailable" };
    const tx = strictTransaction(this.#database, ["updates", "receipts"]);
    let result: ReceiptResult = { state: "ignored", updateId: receipt.updateId, reason: "unknown-update" };
    return completeTransaction(tx, "Receipt transaction aborted", () => result, ({ watch }) => {
      watch(tx.objectStore("updates").get([receipt.identity.documentId, receipt.identity.epoch,
        receipt.identity.schema, receipt.writerId, receipt.sequence]), entry => {
        if (entry === undefined) return;
        if (!matches(receipt, entry)) { result.reason = "identity-mismatch"; return; }
        watch(tx.objectStore("receipts").put(receipt, receipt.updateId));
        result = { state: "remoteCommitted", updateId: receipt.updateId };
      });
    });
  }
}
