import type { DocumentIdentity } from '@edit-ac/core';
import type { LocalCommit } from './storage/journal.js';

export interface EditorState {
  phase: 'visible' | 'ready' | 'failed' | 'closing' | 'destroyed';
  visible: boolean;
  ready: boolean;
  readOnly: boolean;
  preview: 'none' | 'matched' | 'replaced';
  localCommitted: LocalCommit | null;
  error: unknown;
}
export interface PreviewTag { identity: DocumentIdentity; revision: number }
/** Preview visibility never confers input authority. All observer notifications
 * are scoped to this editor and occur after their corresponding state transition. */
export class BrowserLifecycle {
  #value: EditorState;
  readonly #listeners = new Set<(state: EditorState) => void>();
  readonly observerErrors: unknown[] = [];
  constructor(visible: boolean, readOnly: boolean) {
    this.#value = { phase: 'visible', visible, ready: false, readOnly, preview: 'none', localCommitted: null, error: null };
  }
  get state(): EditorState { return { ...this.#value, localCommitted: this.#value.localCommitted ? { ...this.#value.localCommitted } : null }; }
  subscribe(listener: (state: EditorState) => void): () => void {
    if (this.#value.phase === 'destroyed') throw Error('Editor destroyed');
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  update(change: Partial<EditorState>): void {
    this.#value = { ...this.#value, ...change };
    for (const listener of [...this.#listeners]) {
      try { listener(this.state); } catch (error) { this.observerErrors.push(error); if (this.observerErrors.length > 32) this.observerErrors.shift(); }
    }
  }
  dispose(): void { this.update({ phase: 'destroyed', ready: false }); this.#listeners.clear(); }
}
export function previewMatches(preview: PreviewTag | undefined, identity: DocumentIdentity, revision: number): boolean {
  return !!preview && Number.isSafeInteger(preview.revision) && preview.revision === revision
    && (Object.keys(identity) as (keyof DocumentIdentity)[]).every(key => preview.identity[key] === identity[key]);
}

/** A page lease only suspends disposable adapters. The existing Session/storage
 * remains the durability owner; no unload flush or BFCache guarantee is made. */
export class PageLifecycle {
  #hidden = false;
  #away = false;
  #suspended = false;
  #disposed = false;
  readonly #document: Document;
  readonly #window: Window;
  constructor(root: HTMLElement, private readonly change: (suspended: boolean) => void) {
    this.#document = root.ownerDocument; this.#window = this.#document.defaultView!;
    this.#window.addEventListener('pagehide', this.#hide);
    this.#window.addEventListener('pageshow', this.#show);
    this.#document.addEventListener('visibilitychange', this.#visibility);
    this.#visibility();
  }
  readonly #hide = () => { this.#away = true; this.#update(); };
  readonly #show = () => { this.#away = false; this.#hidden = this.#document.visibilityState === 'hidden'; this.#update(); };
  readonly #visibility = () => { this.#hidden = this.#document.visibilityState === 'hidden'; this.#update(); };
  #update(): void {
    if (this.#disposed) return;
    const suspended = this.#away || this.#hidden;
    if (suspended === this.#suspended) return;
    this.#suspended = suspended; this.change(suspended);
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    this.#window.removeEventListener('pagehide', this.#hide);
    this.#window.removeEventListener('pageshow', this.#show);
    this.#document.removeEventListener('visibilitychange', this.#visibility);
  }
}
