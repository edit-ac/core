import { HistoryRestorer } from '@edit-ac/web';

// Consumer lifetime only. Semantic admission, single-use previews and recovery
// snapshots remain the public restorer's responsibility.
export class RevisionRestorer extends HistoryRestorer {
  #active = true;
  #preview;
  #current;
  #reason = 'stale';
  constructor(store, host, access, report) {
    super(store, host, access);
    this.report = report;
    this.#current = host.engine.read();
  }
  #retired(preview) {
    return { kind: 'conflict', reason: this.#reason, base: preview?.base ?? null,
      current: this.#current, proposed: preview?.proposed ?? null };
  }
  preview(handle) {
    if (!this.#active) return this.#retired();
    const result = super.preview(handle);
    this.#preview = 'kind' in result ? undefined : result;
    this.report(result);
    return result;
  }
  apply(preview) {
    if (!this.#active) return this.#retired(preview);
    const result = super.apply(preview);
    this.#preview = undefined;
    this.report(result);
    return result;
  }
  retire(reason = 'stale') {
    if (!this.#active) return;
    // Capture before owner disposal; retained detached callbacks never read a
    // disposed engine, commit, or become writable after a permission round trip.
    this.#current = this.host.engine.read();
    this.#reason = reason;
    this.#active = false;
    if (this.#preview) this.report(this.#retired(this.#preview));
    this.#preview = undefined;
  }
}
