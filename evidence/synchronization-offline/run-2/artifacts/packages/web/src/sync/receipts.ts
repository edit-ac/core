import type { DocumentIdentity, EngineHandle } from "@edit-ac/core";
import { identityKey, ownIdentity, type JournalEntry } from "../storage/journal.js";
import { durableReceiptProtocol, type DurableReceipt, type ReceiptResult, type UpdateOutbox,
  type OutboxCursor } from "../storage/outbox.js";
import { SyncSession, type SyncTransport } from "./session.js";

export type Authorization = "detached" | "authorized" | "denied" | "revoked";
export interface ReceiptNegotiation {
  identity: DocumentIdentity;
  receiptProtocol: typeof durableReceiptProtocol | null;
}
export type DurableDelivery = { receipt: DurableReceipt | null }
  | { authorization: "denied" | "revoked" };
/** Separate application transport; baseline Yjs messages never enter this port.
 * The host authenticates the negotiation and response on the same connection.
 * Resolving upload without a receipt says nothing about remote durability. */
export interface DurableTransport { upload(entry: JournalEntry): Promise<DurableDelivery> }

/** Internal, event-driven client boundary. No timers, engine replacement or
 * journal deletion. The receipt-capable outbox is only used after negotiation.
 * A receipt already admitted to its local transaction may finish on revocation;
 * late network responses from an old attachment are never admitted. */
export class ReceiptSession {
  private generation = 0;
  private authorization: Authorization = "detached";
  private capability: typeof durableReceiptProtocol | null = null;
  private transport: DurableTransport | null = null;
  private cursor: OutboxCursor | null = null;
  private done = false;
  private replayRevision = 0;
  private running: Promise<ReceiptResult[]> | null = null;
  private committed: string | null = null;
  private readonly identity: DocumentIdentity;
  constructor(private readonly engine: EngineHandle, readonly sync: SyncSession,
    private readonly outbox: Pick<UpdateOutbox, "pendingPage" | "accept" | "receiptProtocol">) {
    this.identity = ownIdentity(engine.checkpoint().identity) as DocumentIdentity;
  }
  get state() {
    return { authorization: this.authorization, receiptProtocol: this.capability,
      remoteDurability: this.committed === null ? "unknown" as const : "durable" as const,
      remoteCommitted: this.committed, replayPending: !this.done };
  }
  attach(baseline: SyncTransport, negotiation: ReceiptNegotiation,
    durable: DurableTransport | null, authorized: boolean): void {
    const identity = ownIdentity(negotiation.identity);
    if (identityKey(identity) !== identityKey(this.identity)) throw new TypeError("Receipt peer identity mismatch");
    const protocol = negotiation.receiptProtocol;
    if (protocol !== null && protocol !== durableReceiptProtocol) throw new TypeError("Unsupported receipt capability");
    if (protocol !== null && (this.outbox.receiptProtocol !== protocol || !durable || typeof durable.upload !== "function")) {
      throw new TypeError("Negotiated receipt transport and outbox required");
    }
    this.sync.attach(baseline, negotiation.identity, authorized);
    this.generation++; this.cursor = null; this.done = false; this.committed = null;
    this.authorization = authorized === true ? "authorized" : "denied";
    this.capability = authorized === true ? protocol : null;
    this.transport = authorized === true ? durable : null;
  }
  detach(): void { this.sync.detach(); this.clear("detached"); }
  deny(reason: "denied" | "revoked"): void { this.sync.detach(); this.clear(reason); }
  private clear(authorization: Authorization): void {
    this.generation++; this.authorization = authorization; this.capability = null;
    this.transport = null; this.cursor = null; this.done = false; this.committed = null;
  }
  /** Call only after local journal commit, alongside the normal session signal. */
  localCommitted(origin: string): void {
    this.sync.localCommitted(origin); this.replayRevision++; this.cursor = null; this.done = false;
  }
  /** CRDT recovery export remains available offline and after authorization loss. */
  recoveryExport(): ReturnType<EngineHandle["checkpoint"]> { return this.engine.checkpoint(); }
  async receiveReceipt(receipt: DurableReceipt): Promise<ReceiptResult> {
    if (this.authorization !== "authorized" || this.capability === null) {
      return { state: "ignored", updateId: receipt.updateId, reason: "capability-unavailable" };
    }
    if (identityKey(ownIdentity(receipt.identity)) !== identityKey(this.identity)) {
      return { state: "ignored", updateId: receipt.updateId, reason: "identity-mismatch" };
    }
    const generation = this.generation;
    const result = await this.outbox.accept(receipt);
    if (generation === this.generation && result.state === "remoteCommitted") this.committed = result.updateId;
    return result;
  }
  /** One bounded outbox page per host event. Retry failed uploads on the next
   * event; never infer an acknowledgment from baseline sync or socket delivery. */
  pump(now: number): Promise<ReceiptResult[]> {
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this.run(now, generation).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(now: number, generation: number): Promise<ReceiptResult[]> {
    await this.sync.pump(now);
    if (generation !== this.generation || this.authorization !== "authorized"
      || this.capability === null || !this.transport || this.done) return [];
    const cursor = this.cursor;
    const revision = this.replayRevision;
    const page = await this.outbox.pendingPage(this.identity, cursor, 32, 1024 * 1024);
    const results: ReceiptResult[] = [];
    for (const entry of page.entries) {
      if (generation !== this.generation || !this.transport) return results;
      if (!(entry.origin.startsWith("editac:local:") || entry.origin.startsWith("local:")
        || entry.origin === "history:undo" || entry.origin === "history:redo")) continue;
      // Transport receives owned bytes/metadata; it cannot mutate stored identity.
      const delivery = await this.transport.upload({ ...entry, identity: { ...entry.identity }, bytes: new Uint8Array(entry.bytes) });
      if (generation !== this.generation) return results;
      if ("authorization" in delivery) { this.deny(delivery.authorization); return results; }
      if (delivery.receipt !== null) results.push(await this.receiveReceipt(delivery.receipt));
    }
    if (generation === this.generation && this.replayRevision === revision) { this.cursor = page.after; this.done = page.done; }
    return results;
  }
}
