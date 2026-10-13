import type { CommitResult, PrepareRequest, Snapshot } from '@edit-ac/core';
import { recoverLocalDocument } from './entry.js';
import type { DOMRenderer } from './dom/render.js';
import type { DOMSelection } from './dom/selection.js';
import type { TextInput } from './input/text.js';
import { bindEditorSurface, reserveEditorSurface } from './surface.js';
import { BrowserLifecycle, previewMatches, type PreviewTag } from './lifecycle.js';
import type { RecoveryExport } from './storage/index.js';
import type { ClipboardData, ClipboardOutcome, ClipboardCodec } from './clipboard/fragment.js';
import type { RetainedSelection } from './dom/selection.js';

type LocalSession = Awaited<ReturnType<typeof recoverLocalDocument>>;
type RecoveryOptions = Parameters<typeof recoverLocalDocument>[0];
export interface EditorOptions extends RecoveryOptions {
  content?: import('./modules/content.js').ContentFactory;
  reorder?: import('./modules/reorder.js').ReorderFactory;
  references?: import('./modules/references.js').ReferenceFactory;
  slash?: import('./modules/slash.js').SlashFactory;
  moduleRuntime?: import('./modules/runtime.js').ModuleRuntimeOptions;
  modules?: import('./modules/registry.js').ModuleRegistry;
  clipboardCodecs?: readonly ClipboardCodec[];
  typingShortcuts?: boolean;
  preset?: 'task'|'minimal';
  plainTextPolicy?: 'markdown'|'literal';
  contentCodecs?: import('@edit-ac/core').MarkdownOptions;
  plainPasteControl?: boolean;
  readOnly?: boolean;
  label?: string;
  preview?: PreviewTag;
  /** Host recovery port; defaults to the local WASM/IndexedDB adapter. */
  recover?: typeof recoverLocalDocument;
}
export interface DestroyResult { unsaved: boolean; recovery: RecoveryExport | null; provisional: readonly { text?: string; reason: string }[]; clipboard: readonly { mime: string; raw: string; reason: string }[] }
const mounts = new WeakMap<HTMLElement, BrowserEditor>();
let editorSequence = 0;

/** Browser input owner. All editing begins after authoritative local recovery.
 * Hosts call destroy with flush policy before discarding their last replica. */
export class BrowserEditor {
  readonly ready: Promise<void>;
  readonly lifecycle: BrowserLifecycle;
  private readonly status: HTMLElement;
  private readonly plainButton: HTMLButtonElement | undefined;
  private plainTarget: RetainedSelection | undefined;
  private readonly capturePlainTarget = (event: Event): void => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Tab') return;
    this.plainTarget?.dispose(); this.plainTarget = this.selection?.retain();
    if (event.type === 'pointerdown') event.preventDefault();
  };
  private readonly plainClick = (): void => {
    const target = this.plainTarget; this.plainTarget = undefined;
    void this.plainPaste(undefined, target).catch(() => {});
  };
  private session: LocalSession | undefined;
  private renderer: DOMRenderer | undefined;
  private selection: DOMSelection | undefined;
  private input: TextInput | undefined;
  private surface: ReturnType<typeof bindEditorSurface> | undefined;
  private readonly releaseSurface: () => void;
  private unsubscribe: (() => void) | undefined;
  private closing = false;
  private destroyed = false;
  private destroyPromise: Promise<DestroyResult> | undefined;
  private result: DestroyResult | undefined;
  private cancelActivation: (() => void) | undefined;
  private readOnly: boolean;
  constructor(readonly root: HTMLElement, options: EditorOptions) {
    if (mounts.has(root)) throw Error('Editor already mounted on this surface');
    options.modules?.freeze();
    this.releaseSurface = reserveEditorSurface(root);
    mounts.set(root, this);
    const captured: EditorOptions = { ...options, identity: { ...options.identity },
      ...(options.preview ? { preview: { identity: { ...options.preview.identity }, revision: options.preview.revision } } : {}) };
    this.readOnly = options.readOnly ?? false;
    this.lifecycle = new BrowserLifecycle(!!root.childNodes.length, this.readOnly);
    root.contentEditable = 'false'; root.setAttribute('role', 'textbox'); root.setAttribute('aria-multiline', 'true');
    root.setAttribute('aria-label', options.label ?? root.getAttribute('aria-label') ?? 'Document editor');
    root.setAttribute('aria-readonly', 'true'); root.setAttribute('aria-busy', 'true');
    if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
    this.status = root.ownerDocument.createElement('p'); this.status.setAttribute('role', 'status');
    this.status.id = `editac-status-${++editorSequence}`;
    root.setAttribute('aria-describedby', [root.getAttribute('aria-describedby'), this.status.id].filter(Boolean).join(' '));
    this.status.textContent = 'Loading local document'; root.after(this.status);
    if (options.plainPasteControl !== false) {
      this.plainButton = root.ownerDocument.createElement('button'); this.plainButton.type = 'button';
      this.plainButton.textContent = 'Paste without formatting'; this.plainButton.disabled = true; this.status.after(this.plainButton);
      this.plainButton.addEventListener('pointerdown', this.capturePlainTarget); this.plainButton.addEventListener('click', this.plainClick);
      root.addEventListener('keydown', this.capturePlainTarget);
    }
    this.ready = this.activate(captured); void this.ready.catch(() => {});
  }
  get state() { return this.lifecycle.state; }
  get clipboardRecovery() { return this.input?.clipboard.recovery.map(record => ({ ...record })) ?? []; }
  subscribe(listener: Parameters<BrowserLifecycle['subscribe']>[0]): () => void { return this.lifecycle.subscribe(listener); }
  private async activate(options: EditorOptions): Promise<void> {
    try {
      const cancellation = new Promise<never>((_, reject) => { this.cancelActivation = () => reject(Error('Editor initialization canceled')); });
      const recovery = (options.recover ?? recoverLocalDocument)(options).then(async session => {
        // A shared runtime/host recovery operation may not be abortable. It can
        // never attach a canceled surface; release any late replica immediately.
        if (this.closing || this.destroyed) { await session.storage.destroy({ policy: 'report' }); throw Error('Editor initialization canceled'); }
        return session;
      });
      const session = await Promise.race([recovery, cancellation]);
      this.cancelActivation = undefined;
      if (this.closing || this.destroyed) { await session.storage.destroy({ policy: 'report' }); throw Error('Editor initialization canceled'); }
      this.session = session;
      const snapshot = session.writer.engine.read();
      const preview = options.preview ? previewMatches(options.preview, snapshot.identity, snapshot.revision) ? 'matched' : 'replaced' : 'none';
      // Always bind fresh canonical mappings, including matching preview content.
      // Raw host DOM is never reused as an authoritative editable projection.
      this.surface = bindEditorSurface(this.root, session.writer.engine, { readOnly: true,
        ...(options.content ? { content: options.content } : {}),
        ...(options.reorder ? { reorder: options.reorder } : {}),
        ...(options.references ? { references: options.references } : {}),
        ...(options.slash ? { slash: options.slash } : {}),
        ...(options.modules ? { modules: options.modules } : {}),
        ...(options.moduleRuntime ? { moduleRuntime: options.moduleRuntime } : {}),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.clipboardCodecs === undefined ? {} : { clipboardCodecs: options.clipboardCodecs }),
        commit: request => this.commit(request) });
      this.renderer = this.surface.renderer; this.selection = this.surface.selection; this.input = this.surface.input;
      this.input.shortcuts.enabled=options.typingShortcuts??true;
      this.input.clipboard.plainTextPolicy=options.plainTextPolicy??(options.preset==='minimal'?'literal':'markdown');
      this.input.clipboard.contentCodecs=options.contentCodecs??{};
      this.unsubscribe = session.storage.subscribe(state => {
        if (this.destroyed) return;
        this.lifecycle.update({ localCommitted: state.localCommitted, error: state.error });
        if (state.phase === 'error') this.status.textContent = 'Local save failed. Export recovery content before closing.';
      });
      this.input.setReadOnly(this.readOnly);
      this.root.setAttribute('aria-readonly', String(this.readOnly)); this.root.setAttribute('aria-busy', 'false');
      this.status.textContent = 'Document ready';
      if (this.plainButton) this.plainButton.disabled = this.readOnly;
      this.lifecycle.update({ phase: 'ready', ready: true, visible: true, preview });
    } catch (error) {
      if (!this.closing && !this.destroyed) {
        this.root.contentEditable = 'false'; this.root.setAttribute('aria-busy', 'false'); this.root.setAttribute('aria-readonly', 'true');
        this.status.setAttribute('role', 'alert'); this.status.textContent = 'Unable to open local document. Recovery content remains read-only.';
        this.lifecycle.update({ phase: 'failed', ready: false, readOnly: true, error });
      }
      throw error;
    } finally {
      this.cancelActivation = undefined;
    }
  }
  private requireReady(): LocalSession {
    if (this.closing || this.destroyed || !this.state.ready || !this.session) throw Error('Editor is not ready'); return this.session;
  }
  get reorder(): import('./modules/reorder.js').ReorderPresenter | undefined { return this.input?.reorder; }
  get references(): import('./modules/references.js').ReferencePresenter | undefined { return this.input?.references; }
  get slash(): import('./modules/slash.js').SlashPresenter | undefined { return this.input?.slash; }
  get moduleRuntime(): import('./modules/runtime.js').ModuleRuntime | undefined { return this.renderer?.moduleRuntime; }
  read(): Snapshot { return this.requireReady().writer.engine.read(); }
  commit(request: PrepareRequest): CommitResult {
    const session = this.requireReady(); if (this.readOnly) throw Error('Editor is read-only'); return session.storage.commit(request);
  }
  setReadOnly(value: boolean): void {
    if (this.closing || this.destroyed) throw Error('Editor is closing');
    this.readOnly = value; this.input?.setReadOnly(value); this.root.setAttribute('aria-readonly', String(value || !this.state.ready));
    if (value) { this.plainTarget?.dispose(); this.plainTarget = undefined; }
    if (this.plainButton) this.plainButton.disabled = value || !this.state.ready;
    this.lifecycle.update({ readOnly: value });
  }
  paste(data: Pick<ClipboardData, 'getData'>, options: { literal?: boolean } = {}): ClipboardOutcome {
    this.requireReady(); return this.input!.clipboard.paste(data, options);
  }
  pasteDeferred(data: Pick<ClipboardData, 'getData'>, options: {literal?:boolean; schedule?:()=>Promise<void>} = {}): import('./clipboard/pending.js').PendingPaste {
    this.requireReady(); return this.input!.clipboard.pasteDeferred(data,options);
  }
  pastePlainText(read?: () => Promise<string>): Promise<ClipboardOutcome> {
    this.plainTarget?.dispose(); this.plainTarget = undefined;
    return this.plainPaste(read);
  }
  private plainPaste(read?: () => Promise<string>, target?: RetainedSelection): Promise<ClipboardOutcome> {
    this.requireReady();
    return this.input!.clipboard.pastePlainText(read ?? (() => {
      const clipboard = this.root.ownerDocument.defaultView?.navigator.clipboard;
      return clipboard?.readText ? clipboard.readText() : Promise.reject(Error('Script clipboard unavailable; use native paste'));
    }), target).then(result => {
      if (result.disposition === 'rejected' && !this.closing && !this.destroyed) this.status.textContent = 'Plain paste unavailable. Use native Paste or allow clipboard access.';
      return result;
    });
  }
  flush(options: { target: 'local' }): Promise<void> { return this.requireReady().storage.flush(options); }
  recoveryExport(): RecoveryExport { if (!this.session || this.destroyed) throw Error('No live recovery replica'); return this.session.storage.recoveryExport(); }
  destroy(options: { policy: 'flush' | 'report' } = { policy: 'flush' }): Promise<DestroyResult> {
    if (this.result) return Promise.resolve(this.result);
    if (this.destroyPromise) return this.destroyPromise;
    if (options.policy !== 'flush' && options.policy !== 'report') return Promise.reject(Error('Explicit destroy policy required'));
    this.closing = true;
    this.root.contentEditable = 'false'; this.root.setAttribute('aria-readonly', 'true');
    // Publish the shared teardown promise before notifying reentrant subscribers.
    this.destroyPromise = Promise.resolve().then(async () => {
      try {
        this.lifecycle.update({ phase: 'closing', ready: false, readOnly: true });
        this.cancelActivation?.(); this.cancelActivation = undefined;
        this.plainTarget?.dispose(); this.plainTarget = undefined;
        if (this.plainButton) { this.plainButton.disabled = true; this.plainButton.removeEventListener('pointerdown', this.capturePlainTarget); this.plainButton.removeEventListener('click', this.plainClick); }
        this.root.removeEventListener('keydown', this.capturePlainTarget);
        this.surface?.dispose(); this.unsubscribe?.();
        const provisional = this.input?.recovery.map(r => ({ text: r.text, reason: r.reason })) ?? [];
        const clipboard = this.clipboardRecovery;
        await this.ready.catch(() => {});
        const report = this.session ? await this.session.storage.destroy(options) : { unsaved: false, recovery: null };
        this.destroyed = true; this.status.remove(); this.plainButton?.remove(); this.root.setAttribute('aria-busy', 'false'); mounts.delete(this.root); this.releaseSurface();
        const description = this.root.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== this.status.id).join(' ');
        if (description) this.root.setAttribute('aria-describedby', description); else this.root.removeAttribute('aria-describedby');
        this.result = { ...report, provisional, clipboard }; this.lifecycle.dispose(); return this.result;
      } catch (error) {
        this.status.setAttribute('role', 'alert'); this.status.textContent = 'Local save failed. Export recovery content before closing.';
        this.lifecycle.update({ phase: 'failed', ready: false, readOnly: true, error });
        this.destroyPromise = undefined; throw error;
      }
    });
    return this.destroyPromise;
  }
}
export function mountEditor(root: HTMLElement, options: EditorOptions): BrowserEditor { return new BrowserEditor(root, options); }
