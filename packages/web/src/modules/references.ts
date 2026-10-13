import type { FragmentBlock, PrepareRequest } from '@edit-ac/core';
import type { RetainedSelection } from '../dom/selection.js';
import type { SlashContext } from './slash.js';

export interface ReferenceTarget { targetId: string; label: string }
export interface ReferenceQuery { query: string; requestId: number; signal: AbortSignal }
/** Only explicit user search calls this host port. Mount/render never resolve IDs. */
export type ReferenceResolver = (request: Readonly<ReferenceQuery>) => readonly ReferenceTarget[] | Promise<readonly ReferenceTarget[]>;
export type ReferenceFactory = (context: SlashContext) => ReferencePresenter;
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function referenceBlock(target: ReferenceTarget): FragmentBlock {
  if (!valid(target.targetId) || !valid(target.label)) throw Error('Invalid reference target');
  return { attributes: { type: 'content', tuple: ['module:editac.reference', 1, { targetId: target.targetId, label: target.label }] }, runs: [{ text: target.label, marks: [] }] };
}
export function referenceSuggestions(resolve: ReferenceResolver): ReferenceFactory {
  if (typeof resolve !== 'function') throw Error('Invalid reference resolver');
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
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  constructor(private readonly context: SlashContext, private readonly resolve: ReferenceResolver) {
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
    this.pending?.abort(); this.pending = undefined; this.requestId++; this.lastQuery = undefined; this.results = []; this.active = -1; this.items.replaceChildren(); this.menu.setAttribute('aria-busy', 'false');
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
    const request: PrepareRequest = { kind: 'fragment', origin: 'reference:insert', range: session.target.range, blocks: [referenceBlock(target)] };
    try {
      if (!this.context.engine.can(request)) { this.status.textContent = 'Reference insertion unavailable. Source retained.'; return; }
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
  dispose(): void { if (this.disposed) return; this.disposed = true; this.clearCapture(); this.dismiss(); for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener); this.listeners.length = 0; this.control.remove(); this.menu.remove(); }
}
