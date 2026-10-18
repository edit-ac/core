import { configuredEngineAsset, prepareSurfaceConfiguration, type EditorFacadeOptionsV1 } from './extensions/configuration.js';
import type { PreparedEditorConfigurationV1, PlatformObservationV1, ExtensionStatusV1 } from './extensions/contract.js';
import { CommandControls } from './ui/commands.js';
import { InputHintController, type InputHints } from './input/hints.js';
import type { AnchorToken, Bias, Checkpoint, CommitResult, DocumentIdentity, EditorCommand, MarkdownOptions, Patch, PatchScope, PlanToken, PrepareRequest, Snapshot, SourceBaseline } from '@edit-ac/core';
import type { AttachSyncOptions, SyncAttachment } from './sync/attachment.js';
export type { AttachSyncOptions, SyncAttachment } from './sync/attachment.js';
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
export interface EditorOptions extends RecoveryOptions, Partial<EditorFacadeOptionsV1> {
  commandControls?: boolean;
  inputHints?: InputHints;
  viewport?: import('./platform/viewport.js').ViewportOptions;
  shortcutProfile?: import('./commands/catalog.js').ShortcutProfile;
  commandAllowed?: (command: import('./commands/catalog.js').PortableCommand) => boolean;
  selectionViewport?: import('./selection/pointer.js').PointerSelectionViewport;
  codeCommands?: import('./extensions/code.js').CodeCommandsFactory;
  assistive?: import('./modules/assistive-input.js').AssistivePresenterFactory;
  search?: import('./modules/search.js').DocumentSearchFactory;
  markdown?: import('./input/shortcuts.js').MarkdownAdapter;
  codeHighlight?: import("./modules/code/presenter.js").CodeHighlightFactory | import('./extensions/highlighting.js').ManagedCodeHighlightFactory;
  content?: import('./modules/content.js').ContentFactory;
  reorder?: import('./modules/reorder.js').ReorderFactory;
  links?: import('./modules/links/enrichment.js').LinkEnrichmentFactory;
  references?: import('./modules/references.js').ReferenceFactory;
  slash?: import('./modules/slash.js').SlashFactory;
  moduleRuntime?: import('./modules/runtime.js').ModuleRuntimeOptions;
  modules?: import('./modules/registry.js').ModuleRegistry;
  clipboardCodecs?: readonly ClipboardCodec[];
  typingShortcuts?: boolean;
  preset?: 'task'|'minimal'|'default'|'document';
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
  readonly extensionConfiguration: PreparedEditorConfigurationV1 | undefined;
  #collaborationController: AbortController | undefined;
  #collaborationStatus: ExtensionStatusV1 = Object.freeze({ state: 'idle', generation: 0 });
  get extensionStatus(): Readonly<Record<string, ExtensionStatusV1>> {
    if (this.#surface) return this.#surface.extensionStatus;
    const state = this.#closing || this.#destroyed ? 'cancelled' : this.state.phase === 'failed' ? 'failed' : 'loading';
    return Object.freeze(Object.fromEntries((this.extensionConfiguration?.extensions ?? []).map(e => [e.feature.id,
      Object.freeze(state === 'failed' ? { state, generation: 1, code: 'attachment-failed', retryable: false } : { state, generation: 1 })])));
  }
  get collaborationStatus(): ExtensionStatusV1 { return this.#collaborationStatus; }
  get syncAttachment(): SyncAttachment | undefined { return this.#sync; }
  get platformPreferences(): PlatformObservationV1 { return this.#surface?.platformPreferences ?? Object.freeze({ requested: this.extensionConfiguration?.configuration.platform ?? {}, observed: 'unknown' }); }
  readonly lifecycle: BrowserLifecycle;
  readonly #status: HTMLElement;
  #controls: CommandControls | undefined;
  readonly #pasteTargets = new Set<() => void>();
  #hints: InputHintController | undefined;
  #capabilities: Promise<import('./platform/capabilities.js').BrowserCapabilities> | undefined;
  #formats: import('./modules/formats.js').FormatControls | undefined;
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
  readonly #options: EditorOptions;
  #resuming: Promise<void> | undefined;
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
    this.extensionConfiguration = prepareSurfaceConfiguration(options, options.identity.schema);
    options.modules?.freeze();
    this.#releaseSurface = reserveEditorSurface(root);
    const captured: EditorOptions = { ...options, assetUrl: configuredEngineAsset(options.assetUrl, this.extensionConfiguration), identity: { ...options.identity },
      ...(options.preview ? { preview: { identity: { ...options.preview.identity }, revision: options.preview.revision } } : {}) };
    this.#recoveryOptions = captured; this.#options = captured;
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
    if (options.plainPasteControl !== false && !options.commandControls) {
      this.#plainButton = root.ownerDocument.createElement('button'); this.#plainButton.type = 'button';
      this.#plainButton.textContent = 'Paste without formatting'; this.#plainButton.disabled = true; this.#status.after(this.#plainButton);
      this.#plainButton.addEventListener('pointerdown', this.#capturePlainTarget); this.#plainButton.addEventListener('click', this.#plainClick);
      root.addEventListener('keydown', this.#capturePlainTarget);
    }
    this.ready = this.#activate(captured); void this.ready.catch(() => {});
  }
  get state() { return this.lifecycle.state; }
  get clipboardRecovery() { return this.#input?.clipboard.recovery.map(record => ({ ...record })) ?? []; }
  /** Bounded rejected/interrupted input text for host recovery, never document state. */
  get inputRecovery() { return this.#input?.recovery.map(({ text, reason }) => ({ text, reason })) ?? []; }
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
      // Always bind fresh canonical mappings, including matching preview content.
      // Raw host DOM is never reused as an authoritative editable projection.
      this.#surface = bindEditorSurface(this.root, session.writer.engine, {
        ...options, readOnly: true, commit: request => this.commit(request),
        onSuspend: () => {
          this.#plainTarget?.dispose(); this.#plainTarget = undefined;
          for (const dispose of this.#pasteTargets) dispose();
        } }, this.extensionConfiguration);
      this.#renderer = this.#surface.renderer; this.#selection = this.#surface.selection; this.#input = this.#surface.input;
      this.#unsubscribe = session.storage.subscribe(state => {
        if (this.#destroyed) return;
        this.lifecycle.update({ localCommitted: state.localCommitted, error: state.error });
        if (state.phase === 'error') this.#status.textContent = 'Local save failed. Export recovery content before closing.';
      });
      await this.#surface.ready;
      if (this.#closing || this.#destroyed) throw Error('Editor initialization canceled');
      await this.#finishAttachment(options);
    } catch (error) {
      if (!this.#closing && !this.#destroyed && !this.state.ready) {
        this.#surface?.setReadOnly(true);
        this.root.contentEditable = 'false'; this.root.setAttribute('aria-busy', 'false'); this.root.setAttribute('aria-readonly', 'true');
        this.#status.setAttribute('role', 'alert'); this.#status.textContent = 'Unable to open local document. Recovery content remains read-only.';
        this.lifecycle.update({ phase: 'failed', ready: false, readOnly: true, error });
      }
      throw error;
    } finally {
      this.#cancelActivation = undefined;
    }
  }
  async #finishAttachment(options: EditorOptions): Promise<void> {
    this.#status.setAttribute('role', 'status');
    const snapshot = this.#session!.writer.engine.read();
    const preview = options.preview ? previewMatches(options.preview, snapshot.identity, snapshot.revision) ? 'matched' : 'replaced' : 'none';
      const collaboration = this.extensionConfiguration?.configuration.collaboration;
      const remoteGate = !!collaboration && collaboration.readiness === 'remote';
      this.#surface!.setReadOnly(this.#readOnly || remoteGate);
      this.root.setAttribute('aria-readonly', String(this.#readOnly || remoteGate)); this.root.setAttribute('aria-busy', String(remoteGate));
      this.#status.textContent = remoteGate ? 'Waiting for configured collaboration' : 'Document ready';
      if (this.#plainButton) this.#plainButton.disabled = this.#readOnly || remoteGate;
      this.lifecycle.update({ phase: remoteGate ? 'visible' : 'ready', ready: !remoteGate, readOnly: this.#readOnly || remoteGate, visible: true, preview });
      this.#hints ??= new InputHintController(this.root);
      if (options.inputHints) this.setInputHints(options.inputHints);
      if (options.commandControls) this.#controls ??= new CommandControls(this);
      const assistive = this.#input?.assistive;
      if (assistive) this.root.after(assistive.element);
      if (collaboration) {
        const pending = this.#connectConfiguredSync();
        if (remoteGate) {
          await pending;
          if (this.#closing || this.#destroyed) throw Error('Editor initialization canceled');
          this.#surface!.setReadOnly(this.#readOnly);
          this.root.setAttribute('aria-readonly', String(this.#readOnly)); this.root.setAttribute('aria-busy', 'false');
          this.#status.textContent = 'Document ready';
          if (this.#plainButton) this.#plainButton.disabled = this.#readOnly;
          this.lifecycle.update({ phase: 'ready', ready: true, readOnly: this.#readOnly });
        }
        else void pending.catch(() => {});
      }
  }
  /** Explicit retry after a required adapter failure resumes the same local replica/history. */
  async loadExtension(id: string): Promise<void> {
    if (this.#closing || this.#destroyed || !this.#surface) throw Error('Editor is not locally attached');
    await this.#surface.loadExtension(id);
    if (this.state.phase === 'failed' && this.extensionConfiguration?.requiredReady.every(name => this.extensionStatus[name]?.state === 'ready')) {
      this.#resuming ??= this.#finishAttachment(this.#options).finally(() => { this.#resuming = undefined; });
      await this.#resuming;
    }
  }
  async exportMarkdown(blocks: readonly import('@edit-ac/core').FragmentBlock[]): Promise<import('@edit-ac/core').MarkdownExport> {
    this.#requireReady();
    if (!this.#surface) throw Error('Editor is not attached');
    return this.#surface.exportMarkdown(blocks);
  }
  /** Explicitly imported optional factory. The host mounts its element; the
   * editor owns teardown. No disabled format module enters the default graph. */
  enableFormatControls(factory: import('./modules/formats.js').FormatControlsFactory): import('./modules/formats.js').FormatControls {
    const session = this.#requireReady();
    if (this.#formats && !this.#formats.disposed) return this.#formats;
    const controls = factory({ root: this.root, engine: session.writer.engine, selection: this.#selection!,
      commit: request => this.commit(request), blocked: () => this.#closing || this.#destroyed || !this.state.ready,
      ...(this.#options.contentCodecs ? { contentCodecs: this.#options.contentCodecs } : {}), viewport: this.#surface!.viewport });
    controls.setReadOnly(this.#readOnly); this.#formats = controls; return controls;
  }
  #requireReady(): LocalSession {
    if (this.#closing || this.#destroyed || !this.state.ready || !this.#session) throw Error('Editor is not ready'); return this.#session;
  }
  /** Explicit opt-in; optional platform code is absent from the ordinary editor import graph. */
  enableBrowserCapabilities(): Promise<import('./platform/capabilities.js').BrowserCapabilities> {
    this.#requireReady();
    return this.#capabilities ??= import('./platform/capabilities.js').then(({ BrowserCapabilities }) => {
      this.#requireReady();
      return new BrowserCapabilities(this.root, this.viewport);
    });
  }
  get commandControls(): CommandControls | undefined { return this.#controls; }
  setInputHints(hints: InputHints): void {
    this.#requireReady();
    if (this.extensionConfiguration) throw Error('Legacy inputHints conflicts with facade platform preferences');
    (this.#hints ??= new InputHintController(this.root)).set(hints);
  }
  get codeCommands(): import('./extensions/code.js').CodeCommandsPresenter | undefined { return this.#input?.codeCommands; }
  get assistive(): import('./modules/assistive-input.js').AssistiveInputPresenter | undefined { return this.#input?.assistive; }
  get search(): import('./modules/search.js').DocumentSearchPresenter | undefined { return this.#input?.search; }
  get viewport(): import('./platform/viewport.js').EditorViewport | undefined { return this.#surface?.viewport; }
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
  /** External and cross-document moves have no qualified receipt contract. */
  get textTransferCapabilities() { this.#requireReady();return this.#input!.textDrag.capabilities; }
  /** Capture before moving focus into a host control. Release on dismissal. */
  captureTextTransfer(): import('./input/drag.js').TextTransferTarget | undefined {
    this.#requireReady(); return this.#input?.textDrag.capture();
  }
  get commands() { this.#requireReady(); return this.#input!.keyboard.commands; }
  captureCommand(name: string, supplied?: import('@edit-ac/core').StableRange, focusOwner?: HTMLElement): import('./commands/catalog.js').CapturedCommand | undefined {
    this.#requireReady(); return this.#input?.keyboard.captureCommand(name, supplied, focusOwner);
  }
  takeExtensionErrors(): readonly import('./extensions/authoring.js').ExtensionDiagnosticV1[] { return this.#surface?.takeExtensionErrors() ?? []; }
  runExtensionCommand(id: string, name: string, argument?: import('@edit-ac/core').Json): CommitResult | undefined {
    this.#requireReady(); return this.#surface!.runExtensionCommand(id, name, argument);
  }
  settle(): Promise<void> { this.#requireReady(); return this.#input!.settle(); }
  captureHistory(): import('./input/keyboard.js').HistoryTarget | undefined { this.#requireReady(); return this.#input?.keyboard.captureHistory(); }
  captureToolbar(): import('./commands/formatting.js').ToolbarTarget | undefined {
    this.#requireReady(); return this.#input?.keyboard.captureToolbar();
  }
  /** Host drives receive/pump on transport events and retry deadlines. Sending
   * frames establishes no durable remote-save claim. Attachment never restores a replica. */
  async attachSync(options: AttachSyncOptions): Promise<SyncAttachment> {
    this.disconnectCollaboration();
    return this.#attachSync(options);
  }
  async #attachSync(options: AttachSyncOptions, localGate = false): Promise<SyncAttachment> {
    const requireSession = () => {
      if (!localGate) return this.#requireReady();
      if (this.#closing || this.#destroyed || !this.#session) throw Error('Editor is not locally recovered');
      return this.#session;
    };
    const session = requireSession(), generation = ++this.#syncGeneration;
    const { attachStoredSync } = await import('./sync/attachment.js');
    requireSession();
    if (generation !== this.#syncGeneration) throw Error('Sync attachment superseded');
    const attachment = await attachStoredSync({ root: this.root, selection: this.#selection!, engine: session.writer.engine,
      storage: session.storage, indexedDB: this.#recoveryOptions.indexedDB, databaseName: this.#recoveryOptions.databaseName,
      current: () => requireSession() === session && generation === this.#syncGeneration,
      onDetach: detached => {
        if (this.#sync === detached) {
          this.#sync = undefined; this.#collaborationController?.abort(); this.#collaborationController = undefined;
          this.#collaborationStatus = Object.freeze({ state: 'cancelled', generation: ++this.#syncGeneration });
        }
      } }, options);
    const previous = this.#sync; this.#sync = attachment; previous?.detach(); return attachment;
  }

  /** Cancel pending facade work and detach without replacing the local replica/history. */
  disconnectCollaboration(): void {
    this.#collaborationController?.abort(); this.#collaborationController = undefined;
    this.#syncGeneration++; this.#sync?.detach();
    this.#collaborationStatus = Object.freeze({ state: 'cancelled', generation: this.#syncGeneration });
  }
  async connectCollaboration(): Promise<void> {
    const remoteGate = this.extensionConfiguration?.configuration.collaboration;
    if (!this.state.ready) {
      if (this.#closing || this.#destroyed || !this.#surface || !this.#session || !remoteGate || remoteGate.readiness !== 'remote' ||
          !this.extensionConfiguration?.requiredReady.every(name => this.extensionStatus[name]?.state === 'ready')) throw Error('Editor is not locally ready');
    } else this.#requireReady();
    await this.#connectConfiguredSync();
    if (!this.state.ready && remoteGate && remoteGate.readiness === 'remote') {
      this.#surface!.setReadOnly(this.#readOnly);
      this.root.setAttribute('aria-readonly', String(this.#readOnly)); this.root.setAttribute('aria-busy', 'false');
      this.#status.setAttribute('role', 'status'); this.#status.textContent = 'Document ready';
      if (this.#plainButton) this.#plainButton.disabled = this.#readOnly;
      this.lifecycle.update({ phase: 'ready', ready: true, readOnly: this.#readOnly });
    }
  }
  async #connectConfiguredSync(): Promise<void> {
    const policy = this.extensionConfiguration?.configuration.collaboration;
    if (!policy) throw Error('Collaboration was not configured');
    this.disconnectCollaboration();
    const controller = new AbortController(), generation = this.#syncGeneration;
    this.#collaborationController = controller;
    this.#collaborationStatus = Object.freeze({ state: 'loading', generation });
    const current = () => !controller.signal.aborted && this.#collaborationController === controller && !this.#closing && !this.#destroyed;
    try {
      const { connectConfiguredCollaboration } = await import('./sync/configured.js');
      if (!current()) throw Error('Collaboration superseded');
      await connectConfiguredCollaboration(policy, { signal: controller.signal, generation, current,
        attach: options => this.#attachSync(options, true) });
      this.#collaborationStatus = Object.freeze({ state: 'ready', generation });
    } catch (error) {
      if (!current()) throw error;
      this.#collaborationStatus = Object.freeze({ state: 'failed', generation, code: 'attachment-failed', retryable: true });
      throw error;
    }
  }
  /** Read-only source capture. Commit returned plans through commitPrepared so
   * current readonly, composition and storage policy is checked again. */
  captureSourceBaseline(source: string, owners: readonly string[], options?: Pick<MarkdownOptions, 'images' | 'tables' | 'callouts'>, opening?: Checkpoint): SourceBaseline {
    return this.#requireReady().writer.engine.captureSourceBaseline(source, owners, options, opening);
  }
  releasePlan(plan: PlanToken): void { this.#requireReady().writer.engine.releasePlan(plan); }
  commitPrepared(plan: PlanToken): CommitResult {
    const session = this.#requireReady(); if (this.#readOnly) throw Error('Editor is read-only');
    if (this.#input?.suspended) throw Error('Editor is suspended');
    return session.storage.commitPrepared(plan);
  }
  commit(request: PrepareRequest): CommitResult {
    const session = this.#requireReady(); if (this.#readOnly) throw Error('Editor is read-only');
    if (this.#input?.suspended) throw Error('Editor is suspended');
    return session.storage.commit(request);
  }
  setReadOnly(value: boolean): void {
    if (this.#closing || this.#destroyed) throw Error('Editor is closing');
    this.#readOnly = value; this.#surface?.setReadOnly(value || !this.state.ready); this.root.setAttribute('aria-readonly', String(value || !this.state.ready));
    this.#formats?.setReadOnly(value);
    if (value) { this.#plainTarget?.dispose(); this.#plainTarget = undefined; }
    if (this.#plainButton) this.#plainButton.disabled = value || !this.state.ready;
    this.lifecycle.update({ readOnly: value });
  }
  paste(data: Pick<ClipboardData, 'getData'>, options: { literal?: boolean } = {}): ClipboardOutcome {
    this.#requireReady(); return this.#input!.clipboard.paste(data, options);
  }
  /** Copy-only external provider fallback at a hit-tested client position. */
  dropPlainText(read: () => Promise<string>, position: {clientX: number; clientY: number}): Promise<ClipboardOutcome> {
    this.#requireReady();return this.#input!.clipboard.dropPlainText(read,position);
  }
  pasteDeferred(data: Pick<ClipboardData, 'getData'>, options: {literal?:boolean; schedule?:()=>Promise<void>} = {}): import('./clipboard/pending.js').PendingPaste {
    this.#requireReady(); return this.#input!.clipboard.pasteDeferred(data,options);
  }
  /** Capture an explicit literal-paste intent before its owning control focuses.
   * The existing clipboard owner supplies limits, diagnostics and cancellation. */
  capturePlainPaste(focusOwner?: HTMLElement) {
    this.#requireReady();
    const guard = this.captureCommand('replace', undefined, focusOwner);
    if (!guard) return undefined; // composition/read-only must not map provisional DOM
    const target = this.#selection?.retain();
    if (!target) { guard.dispose(); return undefined; }
    let consumed = false, disposed = false;
    const active = () => !disposed && !consumed && guard.active && target.active;
    const dispose = () => { if (disposed) return; disposed = true; guard.dispose(); target.dispose(); this.#pasteTargets.delete(dispose); };
    this.#pasteTargets.add(dispose);
    return {
      get active() { return active(); }, dispose,
      paste: (read?: () => Promise<string>): Promise<ClipboardOutcome> => {
        if (!active()) { dispose(); return Promise.resolve({ disposition: 'rejected', reason: 'stale-paste-intent' }); }
        consumed = true;
        return this.#plainPaste(async () => {
          const clipboard = this.root.ownerDocument.defaultView?.navigator.clipboard;
          const text = await (read ? read() : clipboard?.readText ? clipboard.readText() : Promise.reject(Error('Use native Paste')));
          if (disposed || !guard.active) throw Error('stale-paste-intent');
          return text;
        }, target).finally(dispose);
      },
    };
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
    this.disconnectCollaboration();
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
        this.#controls?.dispose(); this.#hints?.dispose();
        this.#formats?.dispose();
        await this.#capabilities?.then(c => c.dispose(), () => {});
        for (const dispose of this.#pasteTargets) dispose();
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
