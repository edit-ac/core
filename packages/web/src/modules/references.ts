import type { FragmentBlock, PrepareRequest } from '@edit-ac/core';
import type { RetainedSelection } from '../dom/selection.js';
import type { SlashContext } from './slash.js';

export interface ReferenceTarget { targetId: string; label: string }
export interface ReferenceQuery { query: string; requestId: number; signal: AbortSignal }
/** Only explicit user search calls this host port. Mount/render never resolve IDs. */
export type ReferenceResolver = (request: Readonly<ReferenceQuery>) => readonly ReferenceTarget[] | Promise<readonly ReferenceTarget[]>;
/** Host authorization is transient and independent of stored reference data.
 * revision changes on any policy/catalog/principal replacement. */
export interface ReferencePermissionV1 { revision: string; lookup: boolean; insert: boolean }
export interface ReferenceCatalogResultV1 {
  status: 'local' | 'cached' | 'hosted' | 'locked' | 'unavailable' | 'unauthorized' | 'incompatible';
  /** Exact admitted identifier, from the shared catalog, never a source path/token. */
  targetId: string;
}
export interface ReferenceHostV1 {
  version: 1;
  permission(): Readonly<ReferencePermissionV1>;
  /** Read-only local catalog port. Parse/allowlist ac/app links with the shared
   * client catalog; this port must not fetch, create or grant authority. */
  catalog(targetId: string): Readonly<ReferenceCatalogResultV1>;
  resolve: ReferenceResolver;
  /** Notify on revocation, principal/catalog replacement or lease expiry. */
  subscribe(listener: () => void): { dispose(): void };
}

/** Bounded host search admission, reusable by headless/native presenters.
 * Constructing, reading stored atoms and disposal never call resolve/catalog. */
export class ReferenceLookupSession {
  private pending: AbortController | undefined;
  private accepted: string | undefined;
  private targets: readonly Readonly<ReferenceTarget>[] = [];
  private disposed = false;
  private readonly subscription: { dispose(): void };
  constructor(private readonly host: ReferenceHostV1, invalidate: () => void = () => {}) {
    if (host.version !== 1 || ['permission', 'catalog', 'resolve', 'subscribe'].some(k => typeof host[k as keyof ReferenceHostV1] !== 'function')) throw Error('Invalid reference host');
    this.subscription = host.subscribe(() => { if (this.disposed) return; this.cancel(); invalidate(); });
    if (!this.subscription || typeof this.subscription.dispose !== 'function') throw Error('Invalid reference subscription');
  }
  cancel(): void { this.pending?.abort(); this.pending = undefined; this.accepted = undefined; this.targets = []; }
  private permission(): Readonly<ReferencePermissionV1> {
    const value = this.host.permission();
    if (!valid(value.revision) || typeof value.lookup !== 'boolean' || typeof value.insert !== 'boolean') throw Error('Invalid reference permission');
    return { revision: value.revision, lookup: value.lookup, insert: value.insert };
  }
  private target(target: ReferenceTarget): Readonly<ReferenceTarget> {
    // Reject accessors/extra fields without evaluating them or copying secrets.
    if (!target || Object.getPrototypeOf(target) !== Object.prototype || Reflect.ownKeys(target).length !== 2) throw Error('Invalid reference target');
    const id = Object.getOwnPropertyDescriptor(target, 'targetId'), label = Object.getOwnPropertyDescriptor(target, 'label');
    if (!id || !label || !('value' in id) || !('value' in label)) throw Error('Invalid reference target');
    const value = { targetId: id.value, label: label.value };
    referenceBlock(value);
    const entry = this.host.catalog(value.targetId);
    if (!entry || entry.targetId !== value.targetId || !['local', 'cached', 'hosted'].includes(entry.status)) throw Error('Reference target unavailable');
    return Object.freeze(value);
  }
  async search(request: Readonly<ReferenceQuery>): Promise<readonly Readonly<ReferenceTarget>[]> {
    this.cancel();
    if (this.disposed || request.signal.aborted) return [];
    if (typeof request.query !== 'string' || request.query.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(request.query) || !Number.isSafeInteger(request.requestId) || request.requestId < 0) throw Error('Invalid reference query');
    const permission = this.permission();
    if (!permission.lookup) return [];
    const controller = new AbortController(); this.pending = controller;
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    const current = () => { if (this.disposed || controller.signal.aborted || this.pending !== controller) return false; const now = this.permission(); return now.lookup && now.revision === permission.revision; };
    try {
      const response = await this.host.resolve(Object.freeze({ query: request.query, requestId: request.requestId, signal: controller.signal }));
      if (!current()) return [];
      if (!Array.isArray(response) || response.length > 64) throw Error('Reference response exceeds limits');
      const ids = new Set<string>();
      const targets = response.map(target => { const value = this.target(target); if (ids.has(value.targetId)) throw Error('Duplicate reference target'); ids.add(value.targetId); return value; });
      // Host callbacks may re-enter policy/catalog replacement.
      if (!current()) return [];
      this.accepted = permission.revision; this.targets = Object.freeze(targets);
      return this.targets;
    } finally {
      request.signal.removeEventListener('abort', abort);
      if (this.pending === controller) this.pending = undefined;
    }
  }
  admit(target: ReferenceTarget): Readonly<ReferenceTarget> | undefined {
    if (this.disposed) return undefined;
    try {
      const before = this.permission();
      if (this.disposed || this.accepted === undefined || before.revision !== this.accepted || !before.lookup || !before.insert) return undefined;
      if (!this.targets.some(value => value.targetId === target.targetId && value.label === target.label)) return undefined;
      const value = this.target(target), after = this.permission();
      return !this.disposed && after.revision === this.accepted && after.lookup && after.insert ? value : undefined;
    } catch { return undefined; }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.cancel(); try { this.subscription.dispose(); } catch { /* teardown cannot reactivate a disposed lookup */ } }
}
export type ReferenceFactory = (context: SlashContext) => ReferencePresenter;
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function referenceBlock(target: ReferenceTarget): FragmentBlock {
  if (!valid(target.targetId) || !valid(target.label)) throw Error('Invalid reference target');
  return { attributes: { type: 'content', tuple: ['module:editac.reference', 1, { targetId: target.targetId, label: target.label }] }, runs: [{ text: target.label, marks: [] }] };
}
export function referenceSuggestions(resolve: ReferenceResolver | ReferenceHostV1): ReferenceFactory {
  if (typeof resolve !== 'function' && (!resolve || resolve.version !== 1)) throw Error('Invalid reference resolver');
  return context => new ReferencePresenter(context, resolve);
}
interface Session { target: RetainedSelection; node: string; subscription: { dispose(): void } }
let sequence = 0;
/** A transient host search UI. Only the engine commits the chosen inert atom. */
export class ReferencePresenter {
  readonly menu: HTMLElement;
  readonly search: HTMLInputElement;
  readonly control: HTMLButtonElement;
  private readonly items: HTMLElement;
  private readonly status: HTMLElement;
  private session: Session | undefined;
  private captured: RetainedSelection | undefined;
  private pending: AbortController | undefined;
  private requestId = 0;
  private lastQuery: string | undefined;
  private composing = false;
  private results: readonly Readonly<ReferenceTarget>[] = [];
  private active = -1;
  private readOnly = false;
  private disposed = false;
  private committing = false;
  private readonly lookup: ReferenceLookupSession | undefined;
  private readonly resolve: ReferenceResolver;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  constructor(private readonly context: SlashContext, resolve: ReferenceResolver | ReferenceHostV1) {
    const doc = context.root.ownerDocument;
    this.menu = doc.createElement('div'); this.menu.id = `editac-references-${++sequence}`; this.menu.hidden = true;
    this.menu.setAttribute('role', 'dialog'); this.menu.setAttribute('aria-label', 'Reference suggestions');
    this.search = doc.createElement('input'); this.search.type = 'search'; this.search.maxLength = 128;
    this.search.setAttribute('aria-label', 'Search references'); this.search.setAttribute('autocomplete', 'off');
    this.items = doc.createElement('div'); this.items.setAttribute('role', 'menu'); this.items.setAttribute('aria-label', 'Reference results');
    this.status = doc.createElement('div'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.control = doc.createElement('button'); this.control.type = 'button'; this.control.tabIndex = 0; this.control.textContent = 'Insert reference';
    this.control.setAttribute('aria-haspopup', 'dialog'); this.control.setAttribute('aria-controls', this.menu.id); this.control.setAttribute('aria-expanded', 'false');
    this.menu.append(this.search, this.items, this.status); context.root.after(this.control, this.menu);
    this.listen(this.control, 'pointerdown', event => { this.capture(); event.preventDefault(); });
    this.listen(this.control, 'click', () => this.openExplicit());
    this.listen(this.menu, 'keydown', event => this.handle(event));
    this.listen(this.search, 'input', event => { if (!(event as InputEvent).isComposing) void this.query(); });
    this.listen(this.search, 'compositionstart', () => { this.composing = true; this.invalidate(); });
    this.listen(this.search, 'compositionend', () => { this.composing = false; void this.query(); });
    this.listen(this.items, 'click', event => {
      const item = (event.target as Element).closest<HTMLElement>('[data-reference]');
      if (item) this.activate(Number(item.dataset.reference));
    });
    this.listen(this.items, 'focusin', event => { const index = Number((event.target as HTMLElement).dataset.reference); if (Number.isInteger(index)) this.active = index; });
    this.listen(doc, 'focusin', () => { if (!this.inside(doc.activeElement)) { this.clearCapture(); this.dismiss(); } });
    this.listen(doc, 'selectionchange', () => { if (this.session && !this.menu.contains(doc.activeElement)) this.dismiss(); });
    try { this.lookup = typeof resolve === 'function' ? undefined : new ReferenceLookupSession(resolve, () => this.dismiss()); }
    catch { this.dispose(); throw Error('Reference host unavailable'); }
    this.resolve = this.lookup ? request => this.lookup!.search(request) : resolve as ReferenceResolver;
  }
  private listen(target: EventTarget, type: string, listener: EventListener): void { target.addEventListener(type, listener); this.listeners.push([target, type, listener]); }
  private inside(element: Element | null): boolean { return !!element && (this.context.root.contains(element) || this.menu.contains(element) || element === this.control); }
  get open(): boolean { return !!this.session; }
  private clearCapture(): void { this.captured?.dispose(); this.captured = undefined; }
  private capture(): void { this.clearCapture(); this.captured = this.context.selection.retain(); }
  openExplicit(): void {
    if (this.disposed || this.readOnly || this.session) return;
    const target = this.captured ?? this.context.selection.retain(); this.captured = undefined;
    if (!target) return;
    const a = this.context.engine.resolve(target.range.anchor), b = this.context.engine.resolve(target.range.focus);
    if (a.type !== 'position' || b.type !== 'position' || a.node !== b.node) { target.dispose(); return; }
    const subscription = this.context.engine.subscribe({ type: 'nodes', ids: [a.node] }, () => { if (!this.committing) this.dismiss(); });
    this.session = { target, node: a.node, subscription };
    this.search.value = ''; this.menu.hidden = false; this.control.setAttribute('aria-expanded', 'true'); this.search.focus();
    void this.query();
  }
  private invalidate(): void {
    this.lookup?.cancel(); this.pending?.abort(); this.pending = undefined; this.requestId++; this.lastQuery = undefined; this.results = []; this.active = -1; this.items.replaceChildren(); this.menu.setAttribute('aria-busy', 'false');
  }
  private async query(): Promise<void> {
    const session = this.session; if (!session || this.readOnly || this.disposed || this.composing) return;
    const query = this.search.value;
    // Some native search controls emit duplicate input notifications. A query
    // owns one request until the value or session actually changes.
    if (this.lastQuery === query) return;
    this.invalidate(); this.lastQuery = query;
    if (query.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) { this.status.textContent = 'Reference query exceeds limits.'; return; }
    const requestId = this.requestId, controller = new AbortController(); this.pending = controller;
    this.menu.setAttribute('aria-busy', 'true'); this.status.textContent = 'Searching references';
    try {
      const response = await this.resolve(Object.freeze({ query, requestId, signal: controller.signal }));
      if (controller.signal.aborted || this.session !== session || requestId !== this.requestId || query !== this.search.value) return;
      if (!Array.isArray(response) || response.length > 64) throw Error('Reference response exceeds limits');
      const ids = new Set<string>();
      const results = response.map(target => {
        referenceBlock(target); if (ids.has(target.targetId)) throw Error('Duplicate reference target'); ids.add(target.targetId);
        return Object.freeze({ targetId: target.targetId, label: target.label });
      });
      this.results = results; this.active = results.length ? 0 : -1;
      this.items.replaceChildren(...results.map((target, index) => {
        const item = this.menu.ownerDocument.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = target.label;
        item.dataset.reference = String(index); item.tabIndex = index === this.active ? 0 : -1; return item;
      }));
      this.status.textContent = results.length ? `${results.length} reference suggestions` : 'No reference suggestions';
    } catch { if (!controller.signal.aborted && this.session === session && requestId === this.requestId) this.status.textContent = 'Reference search failed. Source retained.'; }
    finally { if (this.pending === controller) { this.pending = undefined; this.menu.setAttribute('aria-busy', 'false'); } }
  }
  activate(index: number): void {
    const session = this.session, target = this.results[index];
    if (!session || !target || this.pending || this.disposed || this.readOnly) return;
    try {
      const admitted = this.lookup ? this.lookup.admit(target) : target;
      if (!admitted || this.session !== session || this.readOnly || this.disposed) { this.dismiss(); return; }
      const a = this.context.engine.resolve(session.target.range.anchor), b = this.context.engine.resolve(session.target.range.focus);
      if (a.type !== 'position' || b.type !== 'position' || a.node !== session.node || b.node !== session.node) { this.dismiss(); return; }
      const request: PrepareRequest = { kind: 'fragment', origin: 'reference:insert', range: session.target.range, blocks: [referenceBlock(admitted)] };
      if (!this.context.engine.can(request)) { this.status.textContent = 'Reference insertion unavailable. Source retained.'; return; }
      const authorized = !this.lookup || !!this.lookup.admit(admitted);
      if (!authorized || this.session !== session || this.readOnly || this.disposed) { this.dismiss(); return; }
      const currentA = this.context.engine.resolve(session.target.range.anchor), currentB = this.context.engine.resolve(session.target.range.focus);
      if (currentA.type !== 'position' || currentB.type !== 'position' || currentA.node !== session.node || currentB.node !== session.node) { this.dismiss(); return; }
      this.committing = true;
      this.context.engine.history({ type: 'boundary' }); this.context.engine.history({ type: 'explicit' });
      let result;
      try { result = this.context.commit(request); } finally { this.context.engine.history({ type: 'boundary' }); }
      this.dismiss(); this.context.root.focus();
      if (result.caret) {
        try { const point = this.context.engine.resolve(result.caret); if (point.type === 'position') { const dom = this.context.selection.toDOM(point); if (dom) this.context.root.ownerDocument.getSelection()?.setBaseAndExtent(dom.node, dom.offset, dom.node, dom.offset); } }
        finally { this.context.engine.releaseAnchor(result.caret); }
      }
      this.context.selection.capture();
    } catch { if (this.session === session) this.status.textContent = 'Reference insertion failed. Source retained.'; }
    finally { this.committing = false; }
  }
  handle(event: Event): boolean {
    if (event.type === 'compositionstart' || event.type === 'paste' || event.type === 'cut' || event.type === 'beforeinput') { this.clearCapture(); this.dismiss(); return false; }
    if (event.type !== 'keydown') return false;
    const key = event as KeyboardEvent;
    if (!this.session) { if (key.key === 'Tab') this.capture(); else this.clearCapture(); return false; }
    if (this.composing || key.isComposing || ['Process', 'Dead'].includes(key.key) || key.ctrlKey || key.metaKey || key.altKey) return false;
    if (key.key === 'Tab') { this.dismiss(true); return false; }
    if (key.key === 'Escape') { this.dismiss(true); event.preventDefault(); return true; }
    if (key.key === 'Enter') { event.preventDefault(); if (this.active >= 0) this.activate(this.active); return true; }
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key.key) && this.results.length) {
      event.preventDefault(); this.active = key.key === 'Home' ? 0 : key.key === 'End' ? this.results.length - 1 : (this.active + (key.key === 'ArrowUp' ? -1 : 1) + this.results.length) % this.results.length;
      [...this.items.children].forEach((item, index) => { (item as HTMLElement).tabIndex = index === this.active ? 0 : -1; });
      (this.items.children[this.active] as HTMLElement).focus(); return true;
    }
    return false;
  }
  dismiss(restore = false): void {
    const session = this.session; this.session = undefined; this.composing = false; this.invalidate();
    if (restore && session) {
      this.context.root.focus(); const point = this.context.engine.resolve(session.target.range.focus);
      if (point.type === 'position') { const dom = this.context.selection.toDOM(point); if (dom) this.context.root.ownerDocument.getSelection()?.setBaseAndExtent(dom.node, dom.offset, dom.node, dom.offset); }
      this.context.selection.capture();
    }
    session?.subscription.dispose(); session?.target.dispose(); this.menu.hidden = true; this.status.textContent = ''; this.control.setAttribute('aria-expanded', 'false');
  }
  setReadOnly(value: boolean): void { this.readOnly = value; this.control.disabled = value; if (value) { this.clearCapture(); this.dismiss(); } }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.clearCapture(); this.dismiss(); this.lookup?.dispose(); for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener); this.listeners.length = 0; this.control.remove(); this.menu.remove(); }
}
