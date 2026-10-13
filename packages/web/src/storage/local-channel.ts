import type { EngineRuntime } from "@edit-ac/core";
import { identityKey } from "./journal.js";
import { LocalStorageLifecycle } from "./index.js";
import { StorageWriter } from "./writer.js";

export interface LocalNotificationPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** Bounded hints wake verified journal replay. Shared storage alone never updates a live replica. */
export class LocalChannel {
  private closed = false;
  private dirty = false;
  private running: Promise<number> | null = null;
  private failure: unknown = null;
  private readonly unsubscribe: () => void;
  private readonly scope: string;
  private readonly receive = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (Object.keys(message).length !== 3 || message.type !== "editac-local-v1" || message.scope !== this.scope
      || !Number.isSafeInteger(message.writer) || (message.writer as number) <= 0
      || (message.writer as number) > 0xffffffff || message.writer === this.writer.writerId) return;
    void this.catchUp().catch(error => { this.failure = error; });
  };
  constructor(private readonly runtime: EngineRuntime, private readonly writer: StorageWriter,
    private readonly lifecycle: LocalStorageLifecycle, private readonly port: LocalNotificationPort) {
    this.scope = identityKey(writer.engine.checkpoint().identity);
    port.addEventListener("message", this.receive);
    this.unsubscribe = lifecycle.subscribeCommitted(update => {
      // Remote replay is excluded by the lifecycle; observers only see successful transactions.
      try { port.postMessage({ type: "editac-local-v1", scope: this.scope, writer: update.writerId }); }
      catch (error) { this.failure = error; }
    });
  }
  get error(): unknown { return this.failure; }
  /** Explicit startup/reconnect catch-up; coalesces concurrent hints into one serialized owner. */
  catchUp(): Promise<number> {
    if (this.closed) return Promise.reject(new Error("Local channel closed"));
    this.dirty = true;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        let applied = 0;
        while (this.dirty && !this.closed) {
          this.dirty = false;
          applied += await this.lifecycle.catchUpLocal(this.runtime, () => !this.closed);
        }
        this.failure = null;
        return applied;
      }).finally(() => { this.running = null; });
    }
    return this.running;
  }
  /** Retry publication after a queue error; this never removes pending journal work. */
  notify(): void {
    if (this.closed) throw new Error("Local channel closed");
    this.port.postMessage({ type: "editac-local-v1", scope: this.scope, writer: this.writer.writerId });
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.dirty = false;
    this.unsubscribe(); this.port.removeEventListener("message", this.receive); this.port.close();
  }
}
