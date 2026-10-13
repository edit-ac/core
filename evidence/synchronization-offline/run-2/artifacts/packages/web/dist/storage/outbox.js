import { identityKey, ownIdentity, openStorageDatabase, verifyEntries, JournalIntegrityError } from "./journal.js";
/** Host-negotiated application protocol, not a Yjs sync event or state vector. */
export const durableReceiptProtocol = "editac-durable-receipt-v1";
function ownReceipt(input) {
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
function matches(receipt, entry) {
    return receipt.updateId === entry.updateId && receipt.checksum === entry.checksum
        && receipt.writerId === entry.writerId && receipt.sequence === entry.sequence
        && identityKey(receipt.identity) === identityKey(entry.identity);
}
/** Internal adapter. Receipts prune pending membership, never the journal's recovery tail.
 * The host passes only receipts from its negotiated durable application transport.
 * Existing v1/v2 journals are pending by default; upgrading does not infer acknowledgments.
 */
export class UpdateOutbox {
    database;
    receiptProtocol;
    constructor(database, receiptProtocol) {
        this.database = database;
        this.receiptProtocol = receiptProtocol;
    }
    static async open(factory, name = "editac-local-storage", receiptProtocol = null) {
        if (receiptProtocol !== null && receiptProtocol !== durableReceiptProtocol)
            throw new JournalIntegrityError("Unsupported receipt capability");
        return new UpdateOutbox(await openStorageDatabase(factory, name), receiptProtocol);
    }
    close() { this.database.close(); }
    /** Bounded cursor page for reconnect. The index's equal keys are ordered by
     * primary key (document/epoch/schema/writer/sequence). Receipted entries count
     * toward work limits too, so a long acknowledged prefix cannot monopolize a
     * single transaction. A caller restarts its cursor after new local commits. */
    async pendingPage(identity, after, maxEntries, maxBytes) {
        const expected = ownIdentity(identity);
        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
            || (after && (!Number.isSafeInteger(after.writerId) || after.writerId <= 0 || !Number.isSafeInteger(after.sequence) || after.sequence <= 0))) {
            throw new JournalIntegrityError("Invalid outbox page bounds/cursor");
        }
        const page = await new Promise((resolve, reject) => {
            const tx = this.database.transaction(["updates", "receipts"], "readonly");
            const entries = [], receipts = new Map();
            let last = after ? { ...after } : null, bytes = 0, done = false, failure;
            tx.oncomplete = () => resolve({ entries, receipts, after: last, done });
            tx.onabort = () => reject(failure ?? tx.error ?? new DOMException("Outbox page aborted", "AbortError"));
            const abort = (error) => { failure = error; tx.abort(); };
            const request = tx.objectStore("updates").index("documentEpochSchema").openCursor([expected.documentId, expected.epoch, expected.schema]);
            request.onerror = () => { failure = request.error; };
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (!cursor) {
                        done = true;
                        return;
                    }
                    const entry = cursor.value;
                    if (after && (entry.writerId < after.writerId || (entry.writerId === after.writerId && entry.sequence <= after.sequence))) {
                        // Seek directly to the next primary key rather than scan the prefix.
                        cursor.continuePrimaryKey([expected.documentId, expected.epoch, expected.schema], [expected.documentId, expected.epoch, expected.schema, after.writerId, after.sequence + 1]);
                        return;
                    }
                    if (!(entry.bytes instanceof Uint8Array) || entry.bytes.length > maxBytes)
                        throw new JournalIntegrityError("Pending update exceeds replay page byte limit");
                    if (entries.length >= maxEntries || bytes + entry.bytes.length > maxBytes)
                        return;
                    entries.push(entry);
                    bytes += entry.bytes.length;
                    last = { writerId: entry.writerId, sequence: entry.sequence };
                    const receipt = tx.objectStore("receipts").get(entry.updateId);
                    receipt.onsuccess = () => { if (receipt.result !== undefined)
                        receipts.set(entry.updateId, receipt.result); };
                    cursor.continue();
                }
                catch (error) {
                    abort(error);
                }
            };
        });
        const verified = await verifyEntries(page.entries, expected);
        return { after: page.after, done: page.done, entries: verified.filter(entry => {
                const marker = page.receipts.get(entry.updateId);
                if (!marker)
                    return true;
                if (!matches(ownReceipt(marker), entry))
                    throw new JournalIntegrityError("Stored receipt identity mismatch");
                return false;
            }) };
    }
    /** One snapshot of committed bytes and durable receipt markers, independent of checkpoints. */
    async pending(identity) {
        const expected = ownIdentity(identity);
        const raw = await new Promise((resolve, reject) => {
            const tx = this.database.transaction(["updates", "receipts"], "readonly");
            let entries = [];
            const receipts = new Map();
            tx.oncomplete = () => resolve({ entries, receipts });
            tx.onabort = () => reject(tx.error ?? new DOMException("Outbox read aborted", "AbortError"));
            const request = tx.objectStore("updates").index("documentEpochSchema").getAll([expected.documentId, expected.epoch, expected.schema]);
            request.onsuccess = () => {
                entries = request.result;
                for (const entry of entries) {
                    const receipt = tx.objectStore("receipts").get(entry.updateId);
                    receipt.onsuccess = () => { if (receipt.result !== undefined)
                        receipts.set(entry.updateId, receipt.result); };
                }
            };
        });
        const entries = await verifyEntries(raw.entries, expected);
        return entries.filter(entry => {
            const marker = raw.receipts.get(entry.updateId);
            if (!marker)
                return true;
            const receipt = ownReceipt(marker);
            if (!matches(receipt, entry))
                throw new JournalIntegrityError("Stored receipt identity mismatch");
            return false;
        });
    }
    /** Remote acknowledgment becomes visible only after the local receipt transaction completes. */
    async accept(input) {
        const receipt = ownReceipt(input);
        if (this.receiptProtocol === null)
            return { state: "ignored", updateId: receipt.updateId, reason: "capability-unavailable" };
        let tx;
        try {
            tx = this.database.transaction(["updates", "receipts"], "readwrite", { durability: "strict" });
        }
        catch (error) {
            if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "NotSupportedError"))
                throw error;
            tx = this.database.transaction(["updates", "receipts"], "readwrite");
        }
        return new Promise((resolve, reject) => {
            let failure;
            let result = { state: "ignored", updateId: receipt.updateId, reason: "unknown-update" };
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(failure ?? tx.error ?? new DOMException("Receipt transaction aborted", "AbortError"));
            tx.onerror = () => { failure ??= tx.error; };
            const abort = (error) => { failure = error; try {
                tx.abort();
            }
            catch {
                reject(error);
            } };
            try {
                const request = tx.objectStore("updates").get([receipt.identity.documentId, receipt.identity.epoch,
                    receipt.identity.schema, receipt.writerId, receipt.sequence]);
                request.onerror = () => { failure = request.error; };
                request.onsuccess = () => {
                    try {
                        const entry = request.result;
                        if (entry === undefined)
                            return;
                        if (!matches(receipt, entry)) {
                            result.reason = "identity-mismatch";
                            return;
                        }
                        const write = tx.objectStore("receipts").put(receipt, receipt.updateId);
                        write.onerror = () => { failure = write.error; };
                        result = { state: "remoteCommitted", updateId: receipt.updateId };
                    }
                    catch (error) {
                        abort(error);
                    }
                };
            }
            catch (error) {
                abort(error);
            }
        });
    }
}
