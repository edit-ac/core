import type { Checkpoint, DocumentIdentity, EngineHandle, EngineRuntime, ReplayUpdate } from "@edit-ac/core";
import { identityKey } from "./journal.js";

/** An engine replica plus an origin-wide lease. Persisted writer IDs are never reused. */
export class StorageWriter {
  private disposed = false;
  private constructor(readonly engine: EngineHandle, readonly writerId: number, private readonly release: () => void) {}

  /** Web Locks protects against rare random-ID collisions across separate WASM/tab realms. */
  static async restore(runtime: EngineRuntime, locks: LockManager, expected: DocumentIdentity,
    checkpoint: Checkpoint, tail: readonly ReplayUpdate[] = []): Promise<StorageWriter> {
    if (!locks?.request) throw new Error("Multi-tab writer isolation requires Web Locks");
    for (let attempt = 0; attempt < 128; attempt++) {
      const engine = runtime.restoreEngine(expected, checkpoint, tail);
      let writerId: number;
      try { writerId = engine.checkpoint().writerId; } catch (error) { engine.dispose(); throw error; }
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let decide!: (acquired: boolean) => void;
      let fail!: (error: unknown) => void;
      const acquired = new Promise<boolean>((resolve, reject) => { decide = resolve; fail = reject; });
      let lease: Promise<void>;
      try { lease = locks.request(`editac-writer:${identityKey(expected)}:${writerId}`, { ifAvailable: true }, async lock => {
        decide(lock !== null);
        if (lock) await held;
      }); } catch (error) { engine.dispose(); throw error; }
      void lease.catch(fail);
      try {
        if (await acquired) return new StorageWriter(engine, writerId, release);
      } catch (error) { engine.dispose(); throw error; }
      engine.dispose();
    }
    throw new Error("No distinct live storage writer available");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.engine.dispose(); } finally { this.release(); }
  }
}
