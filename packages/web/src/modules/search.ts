import { touchTarget, touchPanel } from './touch-controls.js';
import { nextPresenterSequence } from './presenter-sequence.js';
import { DocumentSearchSession } from '@edit-ac/core/extensions';
import type { DocumentSearchMatch } from '@edit-ac/core/extensions';
import type { CommitResult, EngineHandle, PrepareRequest } from '@edit-ac/core';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

export interface DocumentSearchContext {
  root: HTMLElement; engine: EngineHandle; selection: DOMSelection;
  commit(request: PrepareRequest): CommitResult; blocked?(): boolean;
}
export interface DocumentSearchOptions {
  /** Rechecked synchronously for the entire captured set; false rejects all. */
  authorize?(targets: readonly DocumentSearchMatch[]): boolean;
  /** Optional host virtualization port. Search itself always reads logical content. */
  reveal?(match: DocumentSearchMatch): void;
}
export type DocumentSearchFactory = (context: DocumentSearchContext) => DocumentSearchPresenter;
export function documentSearch(options: DocumentSearchOptions = {}): DocumentSearchFactory {
  const captured: DocumentSearchOptions = { ...(options.authorize ? { authorize: options.authorize } : {}), ...(options.reveal ? { reveal: options.reveal } : {}) };
  return context => new DocumentSearchPresenter(context, captured);
}
interface HighlightRegistry { delete(key: string): void; set(key: string, value: unknown): void }
/** Explicit opt-in UI; deliberately leaves native Ctrl/Cmd+F ownership untouched. */
export class DocumentSearchPresenter {
  readonly element: HTMLElement; readonly button: HTMLButtonElement; readonly panel: HTMLElement;
  readonly query: HTMLInputElement; readonly replacement: HTMLInputElement; readonly status: HTMLElement;
  readonly session: DocumentSearchSession;
  readonly #listeners: [EventTarget, string, EventListener][] = [];
  readonly #replace: HTMLButtonElement; readonly #replaceAll: HTMLButtonElement;
  #pointerTarget: RetainedSelection | undefined;
  #captured: RetainedSelection | undefined; #latest: RetainedSelection | undefined; #disposed = false; #open = false; #readOnly = false; #deliberate = false; #generation = 0;
  #highlight = `editac-find-${nextPresenterSequence()}`;
  constructor(readonly context: DocumentSearchContext, readonly options: DocumentSearchOptions = {}) {
    const doc = context.root.ownerDocument;
    this.element = doc.createElement('div'); this.element.contentEditable = 'false';
    this.element.dataset.documentSearch = '';
    const button = (name: string, action: () => void) => {
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = name; touchTarget(b);
      this.#listen(b, 'click', () => action()); return b;
    };
    this.button = button('Find in document', () => this.show()); this.element.append(this.button);
    const scoped = button('Find in selection', () => this.show(true)); this.element.append(scoped);
    this.#capturePointer(scoped);
    const style = doc.createElement('style'); style.textContent = `::highlight(${this.#highlight}) { background-color: #ffe082; color: #111; }`; this.element.append(style);
    this.#capturePointer(this.button);
    this.panel = doc.createElement('section'); this.panel.setAttribute('role', 'search'); this.panel.setAttribute('aria-label', 'Document find and replace'); this.panel.hidden = true; touchPanel(this.panel);
    const input = (label: string) => { const i = doc.createElement('input'); i.type = 'text'; i.setAttribute('aria-label', label); touchTarget(i); i.style.maxWidth='100%'; this.panel.append(i); return i; };
    this.query = input('Find text'); this.query.maxLength = 257;
    this.replacement = input('Replacement text');
    this.panel.append(button('Previous match', () => this.navigate(true)), button('Next match', () => this.navigate()));
    this.#replace = button('Replace current', () => this.replace(false)); this.#replaceAll = button('Replace all', () => this.replace(true));
    this.panel.append(this.#replace, this.#replaceAll, button('Close find', () => this.close()));
    this.status = doc.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); this.panel.append(this.status);
    this.element.append(this.panel); context.root.after(this.element);
    this.session = new DocumentSearchSession(context.engine, () => { if (this.#open) this.#render(); });
    this.#listen(this.query, 'input', () => { void this.scan(); });
    this.#listen(this.panel, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.isComposing) return;
      if (key.key === 'Escape') { key.preventDefault(); this.close(); }
      else if (key.key === 'Enter' && key.target === this.query) { key.preventDefault(); this.navigate(key.shiftKey); }
    });
    this.#listen(context.root,'pointerdown',()=>{this.#pointerTarget?.dispose();this.#pointerTarget=undefined;});
    for (const type of ['pointerdown', 'keydown', 'focusin']) this.#listen(context.root, type, () => { if (this.#open) this.#deliberate = true; });
    for (const type of ['focusout', 'pointerup', 'keyup']) this.#listen(context.root, type, () => {
      if (!this.#open || !this.#deliberate) return;
      const latest = context.selection.retain();
      if (latest) { this.#latest?.dispose(); this.#latest = latest; }
    });
    this.#listen(context.root, 'compositionstart', () => { this.close(false); });
  }
  get open(): boolean { return this.#open; }
  #listen(target: EventTarget, type: string, listener: EventListener): void { target.addEventListener(type, listener); this.#listeners.push([target, type, listener]); }
  #capturePointer(button: HTMLButtonElement): void {
    this.#listen(button,'pointerdown',event=>{
      this.#pointerTarget?.dispose();this.#pointerTarget=undefined;
      if(this.#disposed||this.context.blocked?.()){event.preventDefault();return;}
      this.#pointerTarget=this.context.selection.retain();
      if((event as PointerEvent).pointerType==='touch')button.focus({preventScroll:true});else event.preventDefault();
    });
    this.#listen(button,'pointercancel',()=>{this.#pointerTarget?.dispose();this.#pointerTarget=undefined;});
  }
  show(selectionScope = false): void {
    if (this.#disposed || this.context.blocked?.()) {this.#pointerTarget?.dispose();this.#pointerTarget=undefined;return;}
    const target=this.#pointerTarget;this.#pointerTarget=undefined;
    this.close(false); this.#captured = target??this.context.selection.retain();
    try { this.session.capture(this.#captured?.range, selectionScope); }
    catch { this.#captured?.dispose(); this.#captured = undefined; return; }
    this.#open = true; this.#deliberate = false; this.panel.hidden = false;
    this.query.value = this.session.seed(); this.query.focus(); this.query.select(); void this.scan();
  }
  async scan(): Promise<void> {
    if (!this.#open || this.#disposed) return;
    const generation = ++this.#generation;
    try { await this.session.search(this.query.value); }
    catch { if (generation === this.#generation && this.#open) this.status.textContent = 'Search unavailable'; return; }
    if (generation === this.#generation && this.#open) this.#render();
  }
  #registry(): HighlightRegistry | undefined {
    return (this.context.root.ownerDocument.defaultView as unknown as { CSS?: { highlights?: HighlightRegistry } })?.CSS?.highlights;
  }
  #render(): void {
    this.#registry()?.delete(this.#highlight);
    const result = this.session.result;
    const count = result.matches.length;
    this.status.textContent = result.status === 'ready' ? `${count ? this.session.index + 1 : 0} of ${count} matches` :
      result.status === 'limit' ? 'Search limit exceeded; narrow the scope' : result.status === 'stale' ? 'Document changed; search again' : result.status === 'unsupported' ? 'Unsupported query profile' : 'No matches';
    this.#replace.disabled = this.#replaceAll.disabled = this.#readOnly || result.status !== 'ready' || !count;
    const view = this.context.root.ownerDocument.defaultView as unknown as { Highlight?: new (...ranges: Range[]) => unknown };
    if (!view?.Highlight || !this.#registry()) return;
    const ranges: Range[] = [];
    for (const match of result.matches) {
      const a = this.context.selection.toDOM({ node: match.owner, offset: match.from, bias: 'right' });
      const f = this.context.selection.toDOM({ node: match.owner, offset: match.to, bias: 'left' });
      if (!a || !f) continue;
      const range = this.context.root.ownerDocument.createRange(); range.setStart(a.node, a.offset); range.setEnd(f.node, f.offset); ranges.push(range);
    }
    this.#registry()?.set(this.#highlight, new view.Highlight(...ranges));
  }
  navigate(backward = false): void {
    if (!this.#open) return;
    const next = this.session.navigate(backward); this.#render();
    if (!next.match) return;
    this.options.reveal?.(next.match);
    const current = this.session.current;
    if (!current || this.session.result.status !== 'ready') return;
    // Result navigation may reveal a document range, but an Enter in a Find
    // field must not hand the next undo/cut/Select All to the outer editor.
    const active = this.context.root.ownerDocument.activeElement;
    this.context.selection.place({ node: current.owner, offset: current.from, bias: 'right' }, { node: current.owner, offset: current.to, bias: 'left' });
    if (active instanceof HTMLElement && this.element.contains(active)) active.focus({ preventScroll: true });
    if (next.wrapped) this.status.textContent += '; wrapped';
  }
  replace(all: boolean): void {
    if (!this.#open || this.#readOnly || this.context.blocked?.()) return;
    try {
      const result = this.session.replace(this.replacement.value, all, request => this.context.commit(request), targets =>
        !this.#readOnly && !this.context.blocked?.() && (this.options.authorize?.(targets) ?? true));
      try { if (result.selection) this.context.selection.restoreRange(result.selection); }
      finally {
        if (result.caret) this.context.engine.releaseAnchor(result.caret);
        if (result.selection) { this.context.engine.releaseAnchor(result.selection.anchor); this.context.engine.releaseAnchor(result.selection.focus); }
      }
      void this.scan();
    } catch { this.status.textContent = 'Replacement rejected; search again or narrow scope'; }
  }
  setReadOnly(value: boolean): void { if (this.#disposed) return; this.#readOnly = value; this.session.invalidate(); if (this.#open) this.#render(); }
  close(restore = true): void {
    if (this.#disposed) return;
    this.#pointerTarget?.dispose();this.#pointerTarget=undefined;
    const focused = this.element.contains(this.context.root.ownerDocument.activeElement);
    this.#generation++; this.#open = false; this.panel.hidden = true; this.#registry()?.delete(this.#highlight);
    if (restore && focused) {
      if (this.#deliberate && this.#latest?.active) this.context.selection.restoreRange(this.#latest.range);
      else if (!this.#deliberate && this.#captured?.active) { this.context.root.focus(); this.context.selection.restoreRange(this.#captured.range); }
    }
    this.session.close(); this.#captured?.dispose(); this.#captured = undefined; this.#latest?.dispose(); this.#latest = undefined;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#pointerTarget?.dispose();this.#pointerTarget=undefined;this.close(false); this.#disposed = true; this.session.dispose();
    for (const [target, type, listener] of this.#listeners) target.removeEventListener(type, listener);
    this.element.remove();
  }
}
