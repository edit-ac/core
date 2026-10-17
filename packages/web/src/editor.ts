import type { AnchorToken, Bias, CommitResult, DocumentIdentity, EditorCommand, Patch, PatchScope, PrepareRequest, Snapshot } from '@edit-ac/core';
import { SyncSession, type SyncSessionOptions, type SyncTransport } from './sync/session.js';
import { UpdateOutbox } from './storage/outbox.js';
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
  selectionViewport?: import('./selection/pointer.js').PointerSelectionViewport;
  codeCommands?: import('./extensions/code.js').CodeCommandsFactory;
  search?: import('./modules/search.js').DocumentSearchFactory;
  markdown?: import('./input/shortcuts.js').MarkdownAdapter;
  codeHighlight?: import("./modules/code/presenter.js").CodeHighlightFactory;
  content?: import('./modules/content.js').ContentFactory;
  reorder?: import('./modules/reorder.js').ReorderFactory;
  links?: import('./modules/links/enrichment.js').LinkEnrichmentFactory;
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
export interface SyncAttachment {
  readonly state: SyncSession['state'];
  receive(frame: Uint8Array): void;
  pump(now: number): Promise<void>;
  detach(): void;
}
export interface AttachSyncOptions extends SyncSessionOptions {
  transport: SyncTransport;
  peerIdentity: DocumentIdentity;
  authorized: boolean;
}
/** A chain is one Rust prepare/commit, never a loop of partially applied commands. */
export class CommandChain {
  readonly #commands: EditorCommand[] = [];
  #consumed = false;
  readonly #editor: BrowserEditor;
  readonly #origin: string;
  constructor(editor: BrowserEditor, origin: string) {
    this.#editor = editor;
    this.#origin = origin;}
  command(command: EditorCommand): this {
    if (this.#consumed) throw Error('Command chain consumed');
    this.#commands.push(structuredClone(command)); return this;
  }
  #request(): PrepareRequest {
    if (this.#consumed) throw Error('Command chain consumed');
    return { kind: 'editor', origin: this.#origin, commands: structuredClone(this.#commands) };
  }
  can(): boolean { return this.#editor.can(this.#request()); }
  /** A returned caret token is caller-owned; release it after applying selection. */
  run(): CommitResult {
    const request = this.#request(); this.#consumed = true;
    return this.#editor.commit(request);
  }
}
let editorSequence = 0;

/** Browser input owner. All editing begins after authoritative local recovery.
 * Hosts call destroy with flush policy before discarding their last replica. */
export class BrowserEditor {
  readonly ready: Promise<void>;
  readonly lifecycle: BrowserLifecycle;
  readonly #status: HTMLElement;
  readonly #plainButton: HTMLButtonElement | undefined;
  #plainTarget: RetainedSelection | undefined;
  readonly #capturePlainTarget = (event: Event): void => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Tab') return;
    this.#plainTarget?.dispose(); this.#plainTarget = this.#selection?.retain();
    if (event.type === 'pointerdown') event.preventDefault();
  };
  readonly #plainClick = (): void => {
    const target = this.#plainTarget; this.#plainTarget = undefined;
    void this.#plainPaste(undefined, target).catch(() => {});
  };
  #session: LocalSession | undefined;
  readonly #recoveryOptions: RecoveryOptions;
  #sync: SyncAttachment | undefined;
  #syncGeneration = 0;
  readonly #patchObservers = new Set<() => void>();
  #renderer: DOMRenderer | undefined;
  #selection: DOMSelection | undefined;
  #input: TextInput | undefined;
  #surface: ReturnType<typeof bindEditorSurface> | undefined;
  readonly #releaseSurface: () => void;
  #unsubscribe: (() => void) | undefined;
  #closing = false;
  #destroyed = false;
  #destroyPromise: Promise<DestroyResult> | undefined;
  #result: DestroyResult | undefined;
  #cancelActivation: (() => void) | undefined;
  #readOnly: boolean;
  constructor(readonly root: HTMLElement, options: EditorOptions) {
    options.modules?.freeze();
    this.#releaseSurface = reserveEditorSurface(root);
    const captured: EditorOptions = { ...options, identity: { ...options.identity },
      ...(options.preview ? { preview: { identity: { ...options.preview.identity }, revision: options.preview.revision } } : {}) };
    this.#recoveryOptions = captured;
    this.#readOnly = options.readOnly ?? false;
    this.lifecycle = new BrowserLifecycle(!!root.childNodes.length, this.#readOnly);
    root.contentEditable = 'false'; root.setAttribute('role', 'textbox'); root.setAttribute('aria-multiline', 'true');
    root.setAttribute('aria-label', options.label ?? root.getAttribute('aria-label') ?? 'Document editor');
    root.setAttribute('aria-readonly', 'true'); root.setAttribute('aria-busy', 'true');
    if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
    this.#status = root.ownerDocument.createElement('p'); this.#status.setAttribute('role', 'status');
    this.#status.id = `editac-status-${++editorSequence}`;
    root.setAttribute('aria-describedby', [root.getAttribute('aria-describedby'), this.#status.id].filter(Boolean).join(' '));
    this.#status.textContent = 'Loading local document'; root.after(this.#status);
    if (options.plainPasteControl !== false) {
      this.#plainButton = root.ownerDocument.createElement('button'); this.#plainButton.type = 'button';
      this.#plainButton.textContent = 'Paste without formatting'; this.#plainButton.disabled = true; this.#status.after(this.#plainButton);
      this.#plainButton.addEventListener('pointerdown', this.#capturePlainTarget); this.#plainButton.addEventListener('click', this.#plainClick);
      root.addEventListener('keydown', this.#capturePlainTarget);
    }
    this.ready = this.#activate(captured); void this.ready.catch(() => {});
  }
  get state() { return this.lifecycle.state; }
  get clipboardRecovery() { return this.#input?.clipboard.recovery.map(record => ({ ...record })) ?? []; }
  subscribe(listener: Parameters<BrowserLifecycle['subscribe']>[0]): () => void;
  subscribe(scope: PatchScope, listener: (patch: Patch) => void): () => void;
  subscribe(scope: PatchScope | Parameters<BrowserLifecycle['subscribe']>[0], listener?: (patch: Patch) => void): () => void {
    if (typeof scope === 'function') return this.lifecycle.subscribe(scope);
    if (!listener) throw TypeError('Patch listener required');
    const subscription = this.#requireReady().writer.engine.subscribe(scope, listener);
    const dispose = () => { subscription.dispose(); this.#patchObservers.delete(dispose); };
    this.#patchObservers.add(dispose); return dispose;
  }
  async #activate(options: EditorOptions): Promise<void> {
    try {
      const cancellation = new Promise<never>((_, reject) => { this.#cancelActivation = () => reject(Error('Editor initialization canceled')); });
      const recovery = (options.recover ?? recoverLocalDocument)(options).then(async session => {
        // A shared runtime/host recovery operation may not be abortable. It can
        // never attach a canceled surface; release any late replica immediately.
        if (this.#closing || this.#destroyed) { await session.storage.destroy({ policy: 'report' }); throw Error('Editor initialization canceled'); }
        return session;
      });
      const session = await Promise.race([recovery, cancellation]);
      this.#cancelActivation = undefined;
      if (this.#closing || this.#destroyed) { await session.storage.destroy({ policy: 'report' }); throw Error('Editor initialization canceled'); }
      this.#session = session;
      const snapshot = session.writer.engine.read();
      const preview = options.preview ? previewMatches(options.preview, snapshot.identity, snapshot.revision) ? 'matched' : 'replaced' : 'none';
      // Always bind fresh canonical mappings, including matching preview content.
      // Raw host DOM is never reused as an authoritative editable projection.
      this.#surface = bindEditorSurface(this.root, session.writer.engine, {
        ...options, readOnly: true, commit: request => this.commit(request) });
      this.#renderer = this.#surface.renderer; this.#selection = this.#surface.selection; this.#input = this.#surface.input;
      this.#unsubscribe = session.storage.subscribe(state => {
        if (this.#destroyed) return;
        this.lifecycle.update({ localCommitted: state.localCommitted, error: state.error });
        if (state.phase === 'error') this.#status.textContent = 'Local save failed. Export recovery content before closing.';
      });
      this.#input.setReadOnly(this.#readOnly);
      this.root.setAttribute('aria-readonly', String(this.#readOnly)); this.root.setAttribute('aria-busy', 'false');
      this.#status.textContent = 'Document ready';
      if (this.#plainButton) this.#plainButton.disabled = this.#readOnly;
      this.lifecycle.update({ phase: 'ready', ready: true, visible: true, preview });
    } catch (error) {
      if (!this.#closing && !this.#destroyed) {
        this.root.contentEditable = 'false'; this.root.setAttribute('aria-busy', 'false'); this.root.setAttribute('aria-readonly', 'true');
        this.#status.setAttribute('role', 'alert'); this.#status.textContent = 'Unable to open local document. Recovery content remains read-only.';
        this.lifecycle.update({ phase: 'failed', ready: false, readOnly: true, error });
      }
      throw error;
    } finally {
      this.#cancelActivation = undefined;
    }
  }
  #requireReady(): LocalSession {
    if (this.#closing || this.#destroyed || !this.state.ready || !this.#session) throw Error('Editor is not ready'); return this.#session;
  }
  get codeCommands(): import('./extensions/code.js').CodeCommandsPresenter | undefined { return this.#input?.codeCommands; }
  get search(): import('./modules/search.js').DocumentSearchPresenter | undefined { return this.#input?.search; }
  get reorder(): import('./modules/reorder.js').ReorderPresenter | undefined { return this.#input?.reorder; }
  get references(): import('./modules/references.js').ReferencePresenter | undefined { return this.#input?.references; }
  get slash(): import('./modules/slash.js').SlashPresenter | undefined { return this.#input?.slash; }
  get moduleRuntime(): import('./modules/runtime.js').ModuleRuntime | undefined { return this.#renderer?.moduleRuntime; }
  read(): Snapshot { return this.#requireReady().writer.engine.read(); }
  anchor(node: string, offset: number, bias: Bias = 'right'): AnchorToken { return this.#requireReady().writer.engine.anchor(node, offset, bias); }
  releaseAnchor(anchor: AnchorToken): void { this.#requireReady().writer.engine.releaseAnchor(anchor); }
  can(request: PrepareRequest): boolean {
    const session = this.#requireReady();
    return !this.#readOnly && session.storage.state.phase !== 'error' && session.writer.engine.can(request);
  }
  chain(origin = 'local:sdk'): CommandChain { this.#requireReady(); return new CommandChain(this, origin); }
  /** Capture before moving focus into a formatting control. Release on dismissal. */
  captureTextTransfer(): import('./input/drag.js').TextTransferTarget | undefined {
    this.#requireReady(); return this.#input?.textDrag.capture();
  }
  captureToolbar(): import('./commands/formatting.js').ToolbarTarget | undefined {
    this.#requireReady(); return this.#input?.keyboard.captureToolbar();
  }
  /** Host drives receive/pump on transport events and retry deadlines. Sending
   * frames establishes no durable remote-save claim. Attachment never restores a replica. */
  async attachSync(options: AttachSyncOptions): Promise<SyncAttachment> {
    const session = this.#requireReady(), generation = ++this.#syncGeneration;
    const { transport, authorized, peerIdentity, ...limits } = options;
    const identity = { ...peerIdentity };
    const outbox = await UpdateOutbox.open(this.#recoveryOptions.indexedDB, this.#recoveryOptions.databaseName);
    let sync: SyncSession | undefined;
    try {
      if (this.#requireReady() !== session || generation !== this.#syncGeneration) throw Error('Sync attachment superseded');
      sync = new SyncSession(session.writer.engine, outbox, limits);
      sync.attach(transport, identity, authorized);
      const owned = sync;
      let latest = session.storage.state.localCommitted?.updateId, detached = false;
      const unsubscribe = session.storage.subscribe(state => {
        if (state.localCommitted && state.localCommitted.updateId !== latest) {
          latest = state.localCommitted.updateId;
          // Re-read the durable outbox; SyncSession filters remote/restore origins.
          owned.localCommitted('local:sdk');
        }
      });
      const attachment: SyncAttachment = {
        get state() { return owned.state; },
        receive: frame => owned.receive(frame), pump: now => owned.pump(now),
        detach: () => {
          if (detached) return; detached = true;
          unsubscribe(); owned.dispose(); outbox.close();
          if (this.#sync === attachment) this.#sync = undefined;
        }
      };
      this.#sync?.detach(); this.#sync = attachment; return attachment;
    } catch (error) { sync?.dispose(); outbox.close(); throw error; }
  }
  commit(request: PrepareRequest): CommitResult {
    const session = this.#requireReady(); if (this.#readOnly) throw Error('Editor is read-only'); return session.storage.commit(request);
  }
  setReadOnly(value: boolean): void {
    if (this.#closing || this.#destroyed) throw Error('Editor is closing');
    this.#readOnly = value; this.#input?.setReadOnly(value); this.root.setAttribute('aria-readonly', String(value || !this.state.ready));
    if (value) { this.#plainTarget?.dispose(); this.#plainTarget = undefined; }
    if (this.#plainButton) this.#plainButton.disabled = value || !this.state.ready;
    this.lifecycle.update({ readOnly: value });
  }
  paste(data: Pick<ClipboardData, 'getData'>, options: { literal?: boolean } = {}): ClipboardOutcome {
    this.#requireReady(); return this.#input!.clipboard.paste(data, options);
  }
  pasteDeferred(data: Pick<ClipboardData, 'getData'>, options: {literal?:boolean; schedule?:()=>Promise<void>} = {}): import('./clipboard/pending.js').PendingPaste {
    this.#requireReady(); return this.#input!.clipboard.pasteDeferred(data,options);
  }
  pastePlainText(read?: () => Promise<string>): Promise<ClipboardOutcome> {
    this.#plainTarget?.dispose(); this.#plainTarget = undefined;
    return this.#plainPaste(read);
  }
  #plainPaste(read?: () => Promise<string>, target?: RetainedSelection): Promise<ClipboardOutcome> {
    this.#requireReady();
    return this.#input!.clipboard.pastePlainText(read ?? (() => {
      const clipboard = this.root.ownerDocument.defaultView?.navigator.clipboard;
      return clipboard?.readText ? clipboard.readText() : Promise.reject(Error('Script clipboard unavailable; use native paste'));
    }), target).then(result => {
      if (result.disposition === 'rejected' && !this.#closing && !this.#destroyed) this.#status.textContent = 'Plain paste unavailable. Use native Paste or allow clipboard access.';
      return result;
    });
  }
  flush(options: { target: 'local' }): Promise<void> { return this.#requireReady().storage.flush(options); }
  recoveryExport(): RecoveryExport { if (!this.#session || this.#destroyed) throw Error('No live recovery replica'); return this.#session.storage.recoveryExport(); }
  destroy(options: { policy: 'flush' | 'report' } = { policy: 'flush' }): Promise<DestroyResult> {
    if (this.#result) return Promise.resolve(this.#result);
    if (this.#destroyPromise) return this.#destroyPromise;
    if (options.policy !== 'flush' && options.policy !== 'report') return Promise.reject(Error('Explicit destroy policy required'));
    this.#closing = true;
    this.#syncGeneration++; this.#sync?.detach();
    for (const dispose of this.#patchObservers) dispose();
    this.root.contentEditable = 'false'; this.root.setAttribute('aria-readonly', 'true');
    // Publish the shared teardown promise before notifying reentrant subscribers.
    this.#destroyPromise = Promise.resolve().then(async () => {
      try {
        this.lifecycle.update({ phase: 'closing', ready: false, readOnly: true });
        this.#cancelActivation?.(); this.#cancelActivation = undefined;
        this.#plainTarget?.dispose(); this.#plainTarget = undefined;
        if (this.#plainButton) { this.#plainButton.disabled = true; this.#plainButton.removeEventListener('pointerdown', this.#capturePlainTarget); this.#plainButton.removeEventListener('click', this.#plainClick); }
        this.root.removeEventListener('keydown', this.#capturePlainTarget);
        this.#surface?.dispose(); this.#unsubscribe?.();
        const provisional = this.#input?.recovery.map(r => ({ text: r.text, reason: r.reason })) ?? [];
        const clipboard = this.clipboardRecovery;
        await this.ready.catch(() => {});
        const report = this.#session ? await this.#session.storage.destroy(options) : { unsaved: false, recovery: null };
        this.#destroyed = true; this.#status.remove(); this.#plainButton?.remove(); this.root.setAttribute('aria-busy', 'false'); this.#releaseSurface();
        const description = this.root.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== this.#status.id).join(' ');
        if (description) this.root.setAttribute('aria-describedby', description); else this.root.removeAttribute('aria-describedby');
        this.#result = { ...report, provisional, clipboard }; this.lifecycle.dispose(); return this.#result;
      } catch (error) {
        this.#status.setAttribute('role', 'alert'); this.#status.textContent = 'Local save failed. Export recovery content before closing.';
        this.lifecycle.update({ phase: 'failed', ready: false, readOnly: true, error });
        this.#destroyPromise = undefined; throw error;
      }
    });
    return this.#destroyPromise;
  }
}
export function mountEditor(root: HTMLElement, options: EditorOptions): BrowserEditor { return new BrowserEditor(root, options); }
