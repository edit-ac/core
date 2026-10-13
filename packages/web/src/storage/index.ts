import type { Checkpoint, CommitResult, EngineRuntime, PatchSubscription, PrepareRequest } from "@edit-ac/core";
import type { JournalUpdate, LocalCommit } from "./journal.js";
import { UpdateJournal } from "./journal.js";
import { StorageWriter } from "./writer.js";

export interface StorageState {
  phase: "pending" | "localCommitted" | "error";
  pending: number;
  localCommitted: LocalCommit | null;
  error: unknown;
  saved: boolean;
  /** Conservative, observed transaction capability; unknown before the first commit. */
  strictDurability: "unknown" | "supported" | "unavailable";
}

export interface RecoveryExport {
  checkpoint: Checkpoint;
  unsavedUpdates: JournalUpdate[];
}

interface PendingUpdate {
  update: JournalUpdate;
  completion: Promise<LocalCommit>;
  failed: boolean;
}

/** Internal host adapter. Takes ownership of writer/journal; hosts edit through commit().
 * Rust remains the only semantic replica. There are no unload handlers or timers.
 */
export class LocalStorageLifecycle {
  readonly #listeners = new Set<(state: StorageState) => void>();
  readonly observerErrors: unknown[] = [];
  readonly #updates = new Set<PendingUpdate>();
  readonly #subscription: PatchSubscription;
  #replayingLocal = false;
  readonly #committedListeners = new Set<(update: JournalUpdate, commit: LocalCommit) => void>();
  #latest: LocalCommit | null = null;
  #failure: unknown = null;
  #capability: StorageState["strictDurability"] = "unknown";
  #observedUnknownDurability = false;
  #closing = false;
  #destroyed = false;

  readonly #writer: StorageWriter;
  readonly #journal: UpdateJournal;
  readonly #policy: { afterStorageFailure: "continue" | "reject" };
  constructor(writer: StorageWriter, journal: UpdateJournal,
    policy: { afterStorageFailure: "continue" | "reject" } = { afterStorageFailure: "continue" }) {
    this.#writer = writer;
    this.#journal = journal;
    this.#policy = policy;
    // Capture policy by value so host mutation cannot silently change it.
    this.#policy = { ...policy };
    this.#subscription = writer.engine.subscribe({ type: "updates" }, patch => {
      if (!patch.update || this.#replayingLocal) return;
      const update: JournalUpdate = { identity: { ...patch.identity }, writerId: patch.writerId,
        sequence: patch.sequence, origin: patch.origin, bytes: new Uint8Array(patch.update.bytes) };
      const record: PendingUpdate = { update, completion: Promise.resolve().then(() => this.#journal.append(update)), failed: false };
      this.#updates.add(record);
      record.completion = record.completion.then(commit => {
        this.#updates.delete(record);
        this.#latest = { ...commit };
        if (commit.durability === "unknown") {
          this.#observedUnknownDurability = true;
          if (this.#capability !== "unavailable") this.#capability = "unknown";
        } else if (commit.durability !== "strict") this.#capability = "unavailable";
        else if (this.#capability === "unknown" && !this.#observedUnknownDurability) this.#capability = "supported";
        this.#notify();
        for (const listener of [...this.#committedListeners]) {
          try { listener({ ...update, identity: { ...update.identity }, bytes: new Uint8Array(update.bytes) }, { ...commit }); }
          catch (error) { this.observerErrors.push(error); if (this.observerErrors.length > 32) this.observerErrors.shift(); }
        }
        return commit;
      }, error => {
        record.failed = true;
        this.#failure = error;
        this.#notify();
        throw error;
      });
      // Edits are synchronous; storage errors are exposed by state/flush, not unhandled rejections.
      void record.completion.catch(() => {});
      this.#notify();
    });
  }

  /** Committed-only hook: local notifications cannot precede transaction completion. */
  subscribeCommitted(listener: (update: JournalUpdate, commit: LocalCommit) => void): () => void {
    this.#requireLive(); this.#committedListeners.add(listener);
    return () => { this.#committedListeners.delete(listener); };
  }

  /** Explicit shared-journal catch-up; replay creates neither local journal records nor echoes. */
  async catchUpLocal(runtime: EngineRuntime, active: () => boolean = () => true): Promise<number> {
    this.#requireLive();
    const expected = this.#writer.engine.checkpoint().identity;
    const entries = await this.#journal.read(expected);
    if (!active()) return 0;
    this.#requireLive();
    const updates = entries.map(entry => ({ identity: entry.identity, bytes: entry.bytes }));
    const candidate = runtime.restoreEngine(expected, this.#writer.engine.checkpoint(), updates);
    candidate.dispose();
    const before = this.#writer.engine.read().revision;
    this.#replayingLocal = true;
    try { for (const update of updates) this.#writer.engine.applyUpdate(update); }
    finally { this.#replayingLocal = false; }
    return this.#writer.engine.read().revision - before;
  }

  get state(): StorageState {
    const failed = [...this.#updates].some(record => record.failed);
    return { phase: failed ? "error" : this.#updates.size ? "pending" : "localCommitted",
      pending: [...this.#updates].filter(record => !record.failed).length,
      localCommitted: this.#latest ? { ...this.#latest } : null, error: this.#failure,
      saved: this.#latest !== null && this.#updates.size === 0,
      strictDurability: this.#capability };
  }
  subscribe(listener: (state: StorageState) => void): () => void {
    this.#requireLive(); this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(this.state); } catch (error) { this.observerErrors.push(error); if (this.observerErrors.length > 32) this.observerErrors.shift(); }
    }
  }

  /** Policy is checked before preparing or mutating the Rust document. */
  commit(request: PrepareRequest): CommitResult {
    this.#requireLive();
    if (this.#closing) throw new Error("Storage lifecycle is closing");
    if (this.#policy.afterStorageFailure === "reject" && [...this.#updates].some(record => record.failed)) {
      throw new Error("Host policy rejects edits after storage failure", { cause: this.#failure });
    }
    const plan = this.#writer.engine.prepare(request);
    try { return this.#writer.engine.commit(plan); } finally { this.#writer.engine.releasePlan(plan); }
  }

  /** Captures synchronously. Later updates cannot extend this barrier. Failed updates remain included. */
  flush(options: { target: "local" }): Promise<void> {
    this.#requireLive();
    if (options.target !== "local") return Promise.reject(new Error("Unsupported flush target"));
    return Promise.all([...this.#updates].map(record => record.completion)).then(() => {});
  }

  recoveryExport(): RecoveryExport {
    this.#requireLive();
    return { checkpoint: this.#writer.engine.checkpoint(), unsavedUpdates: [...this.#updates].map(({ update }) =>
      ({ ...update, identity: { ...update.identity }, bytes: new Uint8Array(update.bytes) })) };
  }

  /** Flush failure keeps the live replica available. Report mode exports before releasing it. */
  async destroy(options: { policy: "flush" | "report" }): Promise<{ unsaved: boolean; recovery: RecoveryExport }> {
    this.#requireLive();
    if (this.#closing) throw new Error("Storage lifecycle is already closing");
    if (options.policy !== "flush" && options.policy !== "report") throw new Error("Explicit destroy policy required");
    this.#closing = true;
    try {
      if (options.policy === "flush") await this.flush({ target: "local" });
      const recovery = this.recoveryExport();
      const unsaved = this.#updates.size !== 0;
      this.#subscription.dispose();
      this.#writer.dispose();
      this.#journal.close();
      this.#destroyed = true;
      this.#listeners.clear();
      this.#committedListeners.clear();
      return { unsaved, recovery };
    } finally { this.#closing = false; }
  }

  #requireLive(): void { if (this.#destroyed) throw new Error("Storage lifecycle destroyed"); }
}
