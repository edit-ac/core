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
  private value: EditorState;
  private readonly listeners = new Set<(state: EditorState) => void>();
  readonly observerErrors: unknown[] = [];
  constructor(visible: boolean, readOnly: boolean) {
    this.value = { phase: 'visible', visible, ready: false, readOnly, preview: 'none', localCommitted: null, error: null };
  }
  get state(): EditorState { return { ...this.value, localCommitted: this.value.localCommitted ? { ...this.value.localCommitted } : null }; }
  subscribe(listener: (state: EditorState) => void): () => void {
    if (this.value.phase === 'destroyed') throw Error('Editor destroyed');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  update(change: Partial<EditorState>): void {
    this.value = { ...this.value, ...change };
    for (const listener of [...this.listeners]) {
      try { listener(this.state); } catch (error) { this.observerErrors.push(error); if (this.observerErrors.length > 32) this.observerErrors.shift(); }
    }
  }
  dispose(): void { this.update({ phase: 'destroyed', ready: false }); this.listeners.clear(); }
}
export function previewMatches(preview: PreviewTag | undefined, identity: DocumentIdentity, revision: number): boolean {
  return !!preview && Number.isSafeInteger(preview.revision) && preview.revision === revision
    && (Object.keys(identity) as (keyof DocumentIdentity)[]).every(key => preview.identity[key] === identity[key]);
}
