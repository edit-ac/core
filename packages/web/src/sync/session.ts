import type { DocumentIdentity, EngineHandle } from "@edit-ac/core";
import type { JournalEntry } from "../storage/journal.js";
import type { OutboxCursor, UpdateOutbox } from "../storage/outbox.js";
import { DirectSyncAdapter } from "./protocol.js";

/** send is synchronous: true means a copied frame was accepted, not acknowledged.
 * false means retry later. The host owns socket events, authorization and closure. */
export interface SyncTransport { send(frame: Uint8Array): boolean }
export interface SyncSessionOptions {
  maxFrameBytes?: number; maxQueuedFrames?: number; maxQueuedBytes?: number;
  maxWorkPerPump?: number; retryBaseMs?: number; retryMaxMs?: number; maxRetries?: number;
}
export class SyncSessionError extends Error {
  constructor(readonly code: "queue-limit" | "retry-exhausted" | "unauthorized" | "detached" | "disposed", message: string) {
    super(message); this.name = "SyncSessionError";
  }
}
const localOrigin = (origin: string) => origin.startsWith("editac:local:") || origin.startsWith("local:")
  || origin === "history:undo" || origin === "history:redo";

/** Internal host-driven session. No engine recreation, timers, storage writes or
 * receipt claims. Call localCommitted only after the journal transaction commits.
 * Outbox pages bound replay memory independently of the persisted backlog.
 * Remote/restore/replay journal entries never become outbound update messages. */
export class SyncSession {
  private transport: SyncTransport | null = null;
  private adapter: DirectSyncAdapter | null = null;
  private generation = 0;
  private disposed = false;
  private incoming: Uint8Array[] = [];
  // Strict Rust admission leaves the live replica untouched when causal structs
  // are missing. Retain those frames within the same receive budget, retrying
  // only after the replica revision changes (never on an idle timer).
  private incomplete: { frame: Uint8Array; revision: number }[] = [];
  private outgoing: Uint8Array[] = [];
  private incomingBytes = 0;
  private outgoingBytes = 0;
  private replay: JournalEntry[] | null = null;
  private replayIndex = 0;
  private cursor: OutboxCursor | null = null;
  private replayDone = false;
  private replayDirty = true;
  private retries = 0;
  private retryAt: number | null = null;
  private running: Promise<void> | null = null;
  private phase: "detached" | "attached" | "unauthorized" | "error" | "disposed" = "detached";
  private failure: unknown = null;
  private readonly limits: Required<SyncSessionOptions>;
  constructor(private readonly engine: EngineHandle, private readonly outbox: Pick<UpdateOutbox, "pendingPage">,
    options: SyncSessionOptions = {}) {
    this.limits = { maxFrameBytes: 16 * 1024 * 1024, maxQueuedFrames: 32, maxQueuedBytes: 32 * 1024 * 1024,
      maxWorkPerPump: 32, retryBaseMs: 100, retryMaxMs: 10_000, maxRetries: 8, ...options };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid session limit");
    if (this.limits.maxFrameBytes < 3 || this.limits.maxFrameBytes > 16 * 1024 * 1024
      || this.limits.maxQueuedBytes < this.limits.maxFrameBytes || this.limits.retryMaxMs < this.limits.retryBaseMs) throw new RangeError("Inconsistent session limits");
  }
  get state() {
    return { phase: this.phase, error: this.failure, incomingFrames: this.incoming.length + this.incomplete.length,
      incompleteFrames: this.incomplete.length,
      outgoingFrames: this.outgoing.length, incomingBytes: this.incomingBytes, outgoingBytes: this.outgoingBytes,
      retryAt: this.retryAt, retries: this.retries, replayPending: this.replayDirty || !this.replayDone || this.replay !== null };
  }
  private alive(): void { if (this.disposed) throw new SyncSessionError("disposed", "Session disposed"); }
  /** Each attachment is a new explicitly authorized connection and replay pass. */
  attach(transport: SyncTransport, peerIdentity: DocumentIdentity, authorized: boolean): void {
    this.alive();
    // Validate metadata before changing the existing connection or queues.
    const adapter = new DirectSyncAdapter(this.engine, peerIdentity, { maxFrameBytes: this.limits.maxFrameBytes });
    const handshake = adapter.step1();
    if (!transport || typeof transport.send !== "function") throw new TypeError("Transport send required");
    this.detach();
    if (authorized !== true) { this.phase = "unauthorized"; return; }
    this.adapter = adapter; this.transport = transport; this.phase = "attached";
    this.enqueue(handshake);
  }
  detach(): void {
    this.alive(); this.generation++; this.transport = null; this.adapter = null;
    this.incoming = []; this.incomplete = []; this.outgoing = []; this.incomingBytes = this.outgoingBytes = 0;
    this.replay = null; this.replayIndex = 0; this.replayDirty = true;
    this.cursor = null; this.replayDone = false;
    this.retryAt = null; this.retries = 0; this.failure = null; this.phase = "detached";
  }
  dispose(): void { if (this.disposed) return; this.detach(); this.disposed = true; this.phase = "disposed"; }
  localCommitted(origin: string): void {
    this.alive(); if (localOrigin(origin)) this.replayDirty = true;
  }
  /** Admission copies bytes. Overflow ends this connection so its handshake can
   * recover missing remote frames; local bytes remain in the durable outbox. */
  receive(frame: Uint8Array): void {
    this.alive();
    if (!this.transport) throw new SyncSessionError(this.phase === "unauthorized" ? "unauthorized" : "detached", "No authorized transport");
    if (!(frame instanceof Uint8Array) || !frame.length) throw new TypeError("Nonempty binary frame required");
    if (frame.length > this.limits.maxFrameBytes || this.incoming.length + this.incomplete.length >= this.limits.maxQueuedFrames
      || this.incomingBytes + frame.length > this.limits.maxQueuedBytes) {
      const error = new SyncSessionError("queue-limit", "Receive queue/frame limit exceeded"); this.stop(error); throw error;
    }
    this.incoming.push(new Uint8Array(frame)); this.incomingBytes += frame.length;
  }
  private enqueue(frame: Uint8Array): void {
    if (this.outgoing.length >= this.limits.maxQueuedFrames || this.outgoingBytes + frame.length > this.limits.maxQueuedBytes) {
      throw new SyncSessionError("queue-limit", "Send queue limit exceeded");
    }
    this.outgoing.push(frame); this.outgoingBytes += frame.length;
  }
  private stop(error: unknown): void { this.detach(); this.phase = "error"; this.failure = error; }
  /** Drive on socket events, completed local commits and the reported retryAt
   * deadline. Bounded work per invocation; idle sessions schedule nothing.
   * Concurrent pumps share one operation; attachment generations fence awaits. */
  pump(now: number): Promise<void> {
    this.alive();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Monotonic millisecond time required");
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this.run(now, generation).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(now: number, generation: number): Promise<void> {
    try {
      for (let work = 0; work < this.limits.maxWorkPerPump; work++) {
        if (generation !== this.generation || !this.transport || !this.adapter) return;
        if (this.retryAt !== null && now < this.retryAt) return;
        if (this.outgoing.length) {
          // A refusing transport must not be allowed to mutate the retained retry.
          const accepted = this.transport.send(new Uint8Array(this.outgoing[0]!));
          // The host may detach/replace this connection synchronously in send.
          if (generation !== this.generation) return;
          if (!accepted) {
            if (++this.retries > this.limits.maxRetries) throw new SyncSessionError("retry-exhausted", "Explicit reconnect required after bounded retries");
            this.retryAt = now + Math.min(this.limits.retryMaxMs, this.limits.retryBaseMs * 2 ** (this.retries - 1)); return;
          }
          this.outgoingBytes -= this.outgoing.shift()!.length; this.retries = 0; this.retryAt = null;
        } else if (this.incoming.length) {
          const frame = this.incoming.shift()!;
          const admitted = this.admit(frame);
          if (generation !== this.generation) return;
          if (!admitted) this.incomplete.push({ frame, revision: this.engine.read().revision });
        } else {
          const revision = this.incomplete.length ? this.engine.read().revision : 0;
          const index = this.incomplete.findIndex(entry => entry.revision !== revision);
          if (index >= 0) {
            const entry = this.incomplete[index]!;
            const admitted = this.admit(entry.frame);
            if (generation !== this.generation) return;
            if (admitted) this.incomplete.splice(index, 1);
            else entry.revision = revision;
            continue;
          }
          if (!this.replay && (this.replayDirty || !this.replayDone)) {
            if (this.replayDone || this.cursor === null) { this.cursor = null; this.replayDone = false; this.replayDirty = false; }
            const page = await this.outbox.pendingPage({ ...this.adapter.identity }, this.cursor,
              this.limits.maxQueuedFrames, this.limits.maxQueuedBytes);
            if (generation !== this.generation) return;
            this.replay = page.entries; this.replayIndex = 0; this.cursor = page.after; this.replayDone = page.done;
          }
          if (!this.replay) return;
          const entry = this.replay[this.replayIndex++];
          if (!entry) { this.replay = null; this.replayIndex = 0; continue; }
          if (localOrigin(entry.origin)) this.enqueue(this.adapter.update({ identity: entry.identity, bytes: entry.bytes }));
        }
      }
    } catch (error) {
      if (generation === this.generation) this.stop(error);
      throw error;
    }
  }
  /** Only the exact atomic missing-dependency rejection is recoverable here.
   * Invalid binary/schema/metadata and resource failures still end attachment. */
  private admit(frame: Uint8Array): boolean {
    const generation = this.generation;
    let result;
    try { result = this.adapter!.receive(frame); }
    catch (error) {
      // Keep this adapter directly loadable by browser hosts that supply the
      // engine themselves; no new runtime package import is needed for its
      // existing tagged error envelope.
      if (error instanceof Error && error.name === "EngineError"
        && "code" in error && error.code === "EngineRejected"
        && "operation" in error && error.operation === "applyUpdate"
        && error.message === "IncompleteRestore") return false;
      throw error;
    }
    // Remote patch observers may synchronously detach/replace the connection.
    if (generation !== this.generation) return true;
    this.incomingBytes -= frame.length;
    if (result.reply) this.enqueue(result.reply);
    return true;
  }
}
