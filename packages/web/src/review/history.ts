import type { EngineHandle, Snapshot, CommitResult, EditorCommand, AnchorToken, PlanToken } from '@edit-ac/core';

export interface HistoryScope { identity: Snapshot['identity']; moduleProfile: string }
export interface RevisionProvenance {
  origin: 'human' | 'agent' | 'import' | 'replay' | 'unknown';
  /** Only a trusted host may supply this evidence; capture labels never authenticate an author. */
  authenticatedAuthor?: string;
}
export interface HistoricalRevision {
  handle: string; label: string; hash: string; representation: 'semantic';
  profile: 'editac-web-history-v1'; scope: HistoryScope; snapshot: Snapshot;
  provenance: RevisionProvenance; keyProfile: string | null;
}
export type HistoryRead = { kind: 'available'; revision: HistoricalRevision }
  | { kind: 'unavailable'; reason: 'missing' | 'pruned' | 'incompatible' | 'key-unavailable' };
export interface HistoryAccess { scope: HistoryScope; keyProfile?: string | null }
export interface HistoryLimits { maxRevisions: number; maxBytes: number; maxRevisionBytes: number }
const defaults: HistoryLimits = { maxRevisions: 32, maxBytes: 8 * 1024 * 1024, maxRevisionBytes: 1024 * 1024 };
const encode = (value: unknown): string => JSON.stringify(value);
const size = (value: unknown): number => new TextEncoder().encode(encode(value)).length;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const clone = <T>(value: T): T => freeze(structuredClone(value));
/** A local observed generation plus all semantic data, including deletions/recovery.
 * Neither a state vector nor a local generation is treated as a cross-replica order. */
function state(snapshot: Snapshot): string {
  return encode([snapshot.identity, snapshot.revision, snapshot.visible, snapshot.recovery, snapshot.retainedStructure]);
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(encode(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Host-owned bounded semantic snapshots. Capture is explicit, never a typing subscription.
 * This decrypted memory store is neither archival persistence nor an authorization boundary. */
export class WebHistoryStore {
  readonly #prefix = `${crypto.randomUUID()}:`;
  readonly #entries = new Map<string, { revision: HistoricalRevision; bytes: number }>();
  readonly #limits: HistoryLimits;
  #sequence = 0; #bytes = 0;
  constructor(limits: Partial<HistoryLimits> = {}) {
    this.#limits = { ...defaults, ...limits };
    for (const limit of Object.values(this.#limits)) if (!Number.isSafeInteger(limit) || limit < 1) throw Error('Invalid history limit');
  }
  async capture(engine: EngineHandle, access: HistoryAccess, label: string, provenance: RevisionProvenance = { origin: 'unknown' }): Promise<string> {
    const snapshot = clone(engine.read());
    if (encode(snapshot.identity) !== encode(access.scope.identity) || !access.scope.moduleProfile) throw Error('Incompatible history scope');
    if (typeof label !== 'string' || !['human','agent','import','replay','unknown'].includes(provenance.origin)
      || (provenance.authenticatedAuthor !== undefined && (typeof provenance.authenticatedAuthor !== 'string' || !provenance.authenticatedAuthor))) throw Error('Invalid history metadata');
    const body = clone({ label, representation: 'semantic' as const, profile: 'editac-web-history-v1' as const,
      scope: access.scope, snapshot, provenance, keyProfile: access.keyProfile ?? null });
    // Reserve the handle only after hashing; the snapshot was detached before the async boundary.
    if (size(body) + 256 > this.#limits.maxRevisionBytes || size(body) + 256 > this.#limits.maxBytes) throw Error('History revision exceeds byte limit');
    const hash = await sha256(body);
    const handle = `${this.#prefix}${++this.#sequence}`;
    const revision = freeze({ ...body, hash, handle }); const bytes = size(revision);
    while (this.#entries.size >= this.#limits.maxRevisions || this.#bytes + bytes > this.#limits.maxBytes) {
      const oldest = this.#entries.keys().next().value!; this.#bytes -= this.#entries.get(oldest)!.bytes; this.#entries.delete(oldest);
    }
    this.#entries.set(handle, { revision, bytes }); this.#bytes += bytes; return handle;
  }
  read(handle: string, access: HistoryAccess): HistoryRead {
    const entry = this.#entries.get(handle);
    if (!entry) {
      const seq = handle.startsWith(this.#prefix) ? handle.slice(this.#prefix.length) : '';
      return { kind: 'unavailable', reason: /^[1-9]\d*$/.test(seq) && Number(seq) <= this.#sequence ? 'pruned' : 'missing' };
    }
    if (encode(access.scope) !== encode(entry.revision.scope)) return { kind: 'unavailable', reason: 'incompatible' };
    if (entry.revision.keyProfile !== (access.keyProfile ?? null)) return { kind: 'unavailable', reason: 'key-unavailable' };
    return { kind: 'available', revision: clone(entry.revision) };
  }
  list(access: HistoryAccess): readonly { handle: string; label: string; availability: HistoryRead['kind'] }[] {
    return [...this.#entries].map(([handle, entry]) => ({ handle, label: entry.revision.label, availability: encode(access.scope) === encode(entry.revision.scope) && (access.keyProfile ?? null) === entry.revision.keyProfile ? 'available' : 'unavailable' }));
  }
  get usage(): Readonly<{ revisions: number; bytes: number }> { return { revisions: this.#entries.size, bytes: this.#bytes }; }
}
export interface HistoryHost {
  engine: EngineHandle;
  /** Must route synchronously through the host's ordinary authorized semantic/storage lifecycle. */
  commit(plan: PlanToken): CommitResult;
  writable(): boolean;
}
export type RestoreResult = { kind: 'applied'; revision: number } | { kind: 'unchanged' }
  | { kind: 'conflict'; reason: 'stale' | 'readonly' | 'unsupported' | 'unavailable' | 'rejected';
      base: Snapshot | null; current: Snapshot; proposed: Snapshot | null };
export interface RestorePreview { handle: string; base: Snapshot; proposed: Snapshot; changes: readonly { id: string; before: string; after: string }[] }
/** Conservative identity-preserving text restoration. Unsupported structure/marks/opaque
 * mappings return a visible conflict; they are never normalized or reimported. */
export class HistoryRestorer {
  readonly #previews = new WeakMap<RestorePreview, string>();
  constructor(readonly store: WebHistoryStore, readonly host: HistoryHost, readonly access: () => HistoryAccess) {}
  preview(handle: string): RestorePreview | RestoreResult {
    const read = this.store.read(handle, this.access()); const current = this.host.engine.read();
    if (read.kind !== 'available') return this.conflict('unavailable', null, current, null);
    const target = read.revision.snapshot;
    if (!this.host.writable()) return this.conflict('readonly', current, current, target);
    const changes = this.changes(current, target);
    if (!changes) return this.conflict('unsupported', current, current, target);
    const preview = clone({ handle, base: current, proposed: target, changes });
    this.#previews.set(preview, state(current)); return preview;
  }
  apply(preview: RestorePreview): RestoreResult {
    const expected = this.#previews.get(preview); this.#previews.delete(preview);
    const current = this.host.engine.read();
    if (!expected || state(current) !== expected) return this.conflict('stale', preview.base, current, preview.proposed);
    if (!this.host.writable()) return this.conflict('readonly', preview.base, current, preview.proposed);
    const read = this.store.read(preview.handle, this.access());
    if (read.kind !== 'available') return this.conflict('unavailable', preview.base, current, preview.proposed);
    const changes = this.changes(current, read.revision.snapshot);
    if (!changes) return this.conflict('unsupported', preview.base, current, preview.proposed);
    if (!changes.length) return { kind: 'unchanged' };
    const anchors: AnchorToken[] = [];
    try {
      const commands: EditorCommand[] = changes.map(change => {
        const anchor = this.host.engine.anchor(change.id, 0, 'right'); anchors.push(anchor);
        const focus = this.host.engine.anchor(change.id, change.before.length, 'left'); anchors.push(focus);
        return { type: 'replace', range: { anchor, focus }, text: change.after };
      });
      // Synchronous admission uses the existing revision-bound Rust prepare/commit path.
      if (state(this.host.engine.read()) !== expected) return this.conflict('stale', preview.base, this.host.engine.read(), preview.proposed);
      this.host.engine.history({ type: 'boundary' });
      const plan = this.host.engine.prepare({ kind: 'editor', origin: 'history-restore', commands });
      let result: CommitResult;
      try { result = this.host.commit(plan); } finally { this.host.engine.releasePlan(plan); }
      this.host.engine.history({ type: 'boundary' });
      return { kind: 'applied', revision: result.revision };
    } catch { return this.conflict('rejected', preview.base, this.host.engine.read(), preview.proposed); }
    finally { for (const anchor of anchors) this.host.engine.releaseAnchor(anchor); }
  }
  private conflict(reason: Extract<RestoreResult, { kind: 'conflict' }>['reason'], base: Snapshot | null, current: Snapshot, proposed: Snapshot | null): RestoreResult {
    return clone({ kind: 'conflict', reason, base, current, proposed });
  }
  private changes(current: Snapshot, target: Snapshot): RestorePreview['changes'] | null {
    if (encode(current.identity) !== encode(target.identity)
      || encode(current.recovery) !== encode(target.recovery) || current.visible.length !== target.visible.length) return null;
    const changes: { id: string; before: string; after: string }[] = [];
    for (let i = 0; i < current.visible.length; i++) {
      const a = current.visible[i]!, b = target.visible[i]!;
      // Source offsets grow with text; source identity must stay exactly bound.
      const shape = (n: typeof a) => [n.id, n.kind, n.parent, n.order, n.blockAttributes, n.editor, n.spans.map(s => [s.source, s.identity])];
      if (encode(shape(a)) !== encode(shape(b))) return null;
      const before = a.runs.map(r => r.text).join(''), after = b.runs.map(r => r.text).join('');
      if (encode(a.runs) === encode(b.runs)) continue;
      // Reject a mark-only or mixed marked/text edit rather than hiding marks or losing them.
      if (a.runs.some(r => Object.keys(r.attributes).length) || b.runs.some(r => Object.keys(r.attributes).length)) return null;
      if (before !== after) {
        if (a.kind !== 'block' || !Array.isArray(a.blockAttributes) || !['paragraph', 'heading', 'code'].includes(String(a.blockAttributes[0]))) return null;
        changes.push({ id: a.id, before, after });
      }
    }
    // Retained structure includes text in both source and owner records. Permit
    // only proved full-source text/span replacements; compare every other field.
    if (!this.sameRetainedStructure(current, target, changes)) return null;
    return changes;
  }
  private sameRetainedStructure(current: Snapshot, target: Snapshot, changes: RestorePreview['changes']): boolean {
    if (!changes.length) return encode(current.retainedStructure) === encode(target.retainedStructure);
    type Record = { [key: string]: any };
    const normalized = structuredClone(current.retainedStructure) as Record | null;
    const expected = target.retainedStructure as Record | null;
    if (!normalized?.sources || !expected?.sources || !Array.isArray(normalized.visible) || !Array.isArray(expected.visible)) return false;
    for (const change of changes) {
      const a = current.visible.find(n => n.id === change.id)!, b = target.visible.find(n => n.id === change.id)!;
      const span = a.spans[0], oldSpan = b.spans[0];
      if (a.spans.length !== 1 || b.spans.length !== 1 || !span || !oldSpan || span.start !== 0 || oldSpan.start !== 0
        || span.end !== change.before.length || oldSpan.end !== change.after.length
        || current.visible.some(n => n.id !== a.id && n.spans.some(s => s.source === span.source))) return false;
      const source = normalized.sources[span.source], oldSource = expected.sources[oldSpan.source];
      const node = normalized.visible.find((n: Record) => n.id === a.id), oldNode = expected.visible.find((n: Record) => n.id === b.id);
      const runs = (text: string) => text ? [{ attributes: {}, insert: text }] : [];
      if (!source || !oldSource || !node || !oldNode || encode(source.runs) !== encode(runs(change.before))
        || encode(oldSource.runs) !== encode(runs(change.after)) || encode(node.runs) !== encode(source.runs)
        || encode(oldNode.runs) !== encode(oldSource.runs)) return false;
      source.runs = structuredClone(oldSource.runs); node.runs = structuredClone(oldNode.runs); node.spans = structuredClone(oldNode.spans);
    }
    return encode(normalized) === encode(expected);
  }
}
export interface HistoryReviewOptions { pageSize?: number; maxValueChars?: number; restorer?: HistoryRestorer }
/** Immutable historical display has no editing controls. Restore preview lives in a
 * separate writable current-state section, never an engine checkout. */
export class HistoryReview {
  readonly #root: HTMLElement; readonly #details: HTMLElement; readonly #status: HTMLElement;
  readonly #list: HTMLElement; readonly #restore: HTMLElement;
  #page = 0; #preview: RestorePreview | null = null; #disposed = false;
  readonly #pageSize: number; readonly #maxChars: number;
  constructor(host: HTMLElement, readonly store: WebHistoryStore, readonly access: () => HistoryAccess, readonly options: HistoryReviewOptions = {}) {
    this.#pageSize = options.pageSize ?? 20; this.#maxChars = options.maxValueChars ?? 4096;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 100
      || !Number.isSafeInteger(this.#maxChars) || this.#maxChars < 1 || this.#maxChars > 65536) throw Error('Invalid history display limit');
    this.#root = host.ownerDocument.createElement('section'); this.#root.setAttribute('aria-label', 'Revision history');
    this.#root.style.overflowWrap = 'anywhere';
    this.#list = this.element('div'); this.#details = this.element('section'); this.#details.setAttribute('aria-label', 'Readonly historical inspection');
    this.#status = this.element('p'); this.#status.setAttribute('role', 'status');
    this.#restore = this.element('section'); this.#restore.setAttribute('aria-label', 'Restore as new edit');
    this.#root.append(this.element('h2', 'Revision history'), this.#list, this.#details, this.#restore, this.#status); host.append(this.#root); this.refresh();
  }
  private element(tag: string, text?: string): HTMLElement {
    const el = this.#root.ownerDocument.createElement(tag);
    if (text !== undefined) el.textContent = text.length > this.#maxChars ? text.slice(0, this.#maxChars) + ' [Display truncated]' : text;
    return el;
  }
  private button(text: string, action: () => void): HTMLButtonElement {
    const button = this.element('button', text) as HTMLButtonElement; button.type = 'button'; button.addEventListener('click', action); return button;
  }
  refresh(): void {
    if (this.#disposed) return;
    const items = this.store.list(this.access()); const pages = Math.max(1, Math.ceil(items.length / this.#pageSize)); this.#page = Math.min(this.#page, pages - 1);
    this.#list.replaceChildren(this.element('p', `Page ${this.#page + 1} of ${pages}; ${items.length} retained revisions`));
    for (const item of items.slice(this.#page * this.#pageSize, (this.#page + 1) * this.#pageSize)) {
      this.#list.append(this.button(`Inspect ${item.label}`, () => this.inspect(item.handle)));
    }
    const previous = this.button('Previous revisions', () => { this.#page--; this.refresh(); }); previous.disabled = this.#page === 0;
    const next = this.button('Next revisions', () => { this.#page++; this.refresh(); }); next.disabled = this.#page + 1 === pages; this.#list.append(previous, next);
  }
  inspect(handle: string): void {
    if (this.#disposed) return;
    this.#restore.replaceChildren(); this.#preview = null; const read = this.store.read(handle, this.access()); this.#details.replaceChildren();
    if (read.kind === 'unavailable') { this.#status.textContent = `History unavailable: ${read.reason}`; return; }
    const r = read.revision;
    const attribution = r.provenance.authenticatedAuthor ? `Authenticated host attribution: ${r.provenance.authenticatedAuthor}` : 'Unknown / unverified attribution';
    this.#details.append(this.element('h3', r.label), this.element('p', 'Readonly historical semantic projection; original source spelling is not retained.'),
      this.element('p', `${r.profile}; SHA-256 ${r.hash}`), this.element('p', `${attribution}; origin ${r.provenance.origin}; local generation ${r.snapshot.revision} (not a global order)`),
      this.element('pre', encode({ identity: r.snapshot.identity, visible: r.snapshot.visible, recovery: r.snapshot.recovery, retainedStructure: r.snapshot.retainedStructure })));
    this.#status.textContent = 'Historical inspection leaves the live document unchanged.';
    if (this.options.restorer?.host.writable()) this.#restore.append(this.button('Preview restore as new edit', () => this.preview(handle)));
  }
  private preview(handle: string): void {
    const result = this.options.restorer!.preview(handle); this.#restore.replaceChildren();
    if ('kind' in result) { this.result(result); return; }
    this.#preview = result;
    this.#restore.append(this.element('p', 'Proposed new semantic edit against the current revision. No historical checkout.'),
      this.element('pre', encode(result.changes)), this.button('Apply restore as new edit', () => {
        if (!this.#preview) return; const value = this.options.restorer!.apply(this.#preview); this.#preview = null; this.#restore.replaceChildren(); this.result(value);
      }));
    this.#status.textContent = 'Restore preview ready; live revision will be revalidated on application.';
  }
  private result(result: RestoreResult): void {
    this.#status.textContent = result.kind === 'conflict' ? `Restore conflict: ${result.reason}. Refresh and preview again.`
      : result.kind === 'unchanged' ? 'No changes to restore.' : `Restored as a new edit at local generation ${result.revision}.`;
    if (result.kind === 'conflict') this.#restore.append(this.element('pre', encode({ base: result.base, current: result.current, proposed: result.proposed })));
  }
  destroy(): void { this.#disposed = true; this.#preview = null; this.#root.remove(); }
}
