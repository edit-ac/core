import { configuredSurfaceOptions, prepareSurfaceConfiguration, type EditorFacadeOptionsV1 } from './extensions/configuration.js';
import type { PreparedEditorConfigurationV1, PlatformObservationV1 } from './extensions/contract.js';
import { ExtensionConfigurationError } from './extensions/contract.js';
import { markdownResource } from './extensions/markdown-resource.js';
import { configuredResource } from './extensions/resource.js';
import { literalShortcuts } from './input/shortcuts.js';
import { editorStoragePorts, type EditorStorageOwner } from './storage/owner.js';
import { attachStoredSync, type AttachSyncOptions, type SyncAttachment } from './sync/attachment.js';
import { connectConfiguredCollaboration } from './sync/configured.js';
import { PlatformPreferenceController } from './platform/preferences.js';
import { PageLifecycle } from './lifecycle.js';
import { EditorViewport, type ViewportOptions } from './platform/viewport.js';
import type { LinkEnrichment, LinkEnrichmentFactory } from './modules/links/enrichment.js';
import type { CommitResult, EngineHandle, PrepareRequest } from '@edit-ac/core';
import { DOMRenderer } from './dom/render.js';
import { accessiblePresentation } from './dom/presentation.js';
import { DOMSelection } from './dom/selection.js';
import { TextInput } from './input/text.js';
import type { ModuleRuntime, ModuleRuntimeOptions } from './modules/runtime.js';
import type { ClipboardCodec } from './clipboard/fragment.js';

export interface EditorSurfaceOptions extends Partial<EditorFacadeOptionsV1> {
  /** Advanced borrowed mount: the same existing local storage owner supplies commit/sync. */
  storageOwner?: EditorStorageOwner;
  viewport?: ViewportOptions;
  shortcutProfile?: import('./commands/catalog.js').ShortcutProfile;
  commandAllowed?: (command: import('./commands/catalog.js').PortableCommand) => boolean;
  selectionViewport?: import('./selection/pointer.js').PointerSelectionViewport;
  codeCommands?: import('./extensions/code.js').CodeCommandsFactory;
  search?: import('./modules/search.js').DocumentSearchFactory;
  markdown?: import('./input/shortcuts.js').MarkdownAdapter;
  codeHighlight?: import("./modules/code/presenter.js").CodeHighlightFactory;
  content?: import('./modules/content.js').ContentFactory;
  reorder?: import('./modules/reorder.js').ReorderFactory;
  links?: LinkEnrichmentFactory;
  references?: import('./modules/references.js').ReferenceFactory;
  slash?: import('./modules/slash.js').SlashFactory;
  moduleRuntime?: ModuleRuntimeOptions;
  modules?: import('./modules/registry.js').ModuleRegistry;
  readOnly?: boolean;
  label?: string;
  clipboardCodecs?: readonly ClipboardCodec[];
  typingShortcuts?: boolean;
  preset?: 'task' | 'minimal' | 'default' | 'document';
  plainTextPolicy?: 'markdown' | 'literal';
  contentCodecs?: import('@edit-ac/core').MarkdownOptions;
  /** Host persistence/command port; defaults to committing to the borrowed engine. */
  commit?: (request: PrepareRequest) => CommitResult;
}
export interface EditorSurface {
  readonly ready: Promise<void>;
  readonly extensionStatus: Readonly<Record<string, import('./extensions/contract.js').ExtensionStatusV1>>;
  readonly extensionConfiguration: PreparedEditorConfigurationV1 | undefined;
  /** Explicitly load or retry an optional adapter; command-lazy codecs never gate input. */
  loadExtension(id: string): Promise<void>;
  exportMarkdown(blocks: readonly import('@edit-ac/core').FragmentBlock[]): Promise<import('@edit-ac/core').MarkdownExport>;
  readonly collaborationStatus: import('./extensions/contract.js').ExtensionStatusV1;
  readonly syncAttachment: SyncAttachment | undefined;
  attachSync(options: AttachSyncOptions): Promise<SyncAttachment>;
  connectCollaboration(): Promise<void>;
  disconnectCollaboration(): void;
  readonly platformPreferences: PlatformObservationV1;
  readonly viewport: EditorViewport;
  readonly pointerSelection: import('./selection/pointer.js').PointerSelection;
  readonly codeCommands: import('./extensions/code.js').CodeCommandsPresenter | undefined;
  readonly search: import('./modules/search.js').DocumentSearchPresenter | undefined;
  readonly reorder: import('./modules/reorder.js').ReorderPresenter | undefined;
  readonly references: import('./modules/references.js').ReferencePresenter | undefined;
  readonly slash: import('./modules/slash.js').SlashPresenter | undefined;
  readonly moduleRuntime: ModuleRuntime | undefined;
  readonly recovery: readonly { text: string; reason: string }[];
  captureTextTransfer(): import('./input/drag.js').TextTransferTarget | undefined;
  captureToolbar(): import('./commands/formatting.js').ToolbarTarget | undefined;
  readonly commands: typeof import('./commands/catalog.js').commandCatalog;
  captureCommand(name: string, supplied?: import('@edit-ac/core').StableRange): import('./commands/catalog.js').CapturedCommand | undefined;
  captureHistory(): import('./input/keyboard.js').HistoryTarget | undefined;
  settle(): Promise<void>;
  setReadOnly(value: boolean): void;
  /** Detach the view and input handlers. The host still owns the engine. */
  dispose(): void;
}
const mounted = new WeakSet<HTMLElement>();

/** Reserve before asynchronous recovery so both mount paths share ownership. */
export function reserveEditorSurface(root: HTMLElement): () => void {
  if (mounted.has(root)) throw Error('Editor already mounted on this surface');
  mounted.add(root);
  let released = false;
  return () => { if (!released) { released = true; mounted.delete(root); } };
}

/** Shared adapter assembly for recovered documents and host-owned replicas. */
export function bindEditorSurface(root: HTMLElement, engine: EngineHandle, options: EditorSurfaceOptions & { onSuspend?: () => void } = {}, prepared?: PreparedEditorConfigurationV1) {
  options = configuredSurfaceOptions(options, prepared);
  let viewport: EditorViewport | undefined;
  let page: PageLifecycle | undefined;
  const baseCommit = options.commit ?? ((request: PrepareRequest) => engine.commit(engine.prepare(request)));
  const commit = (request: PrepareRequest): CommitResult => { const result=baseCommit(request);viewport?.requestCaret();return result; };
  const renderer = new DOMRenderer(root, engine, { ...options, readOnly: true });
  const disposePresentation = accessiblePresentation(root);
  const preferences = new PlatformPreferenceController(root, prepared?.configuration.platform);
  let selection: DOMSelection | undefined, input: TextInput | undefined;
  let links: LinkEnrichment | undefined;
  let markdown: import('@edit-ac/core').PatchSubscription | undefined;
  const resource = markdownResource(prepared, (adapter, enableInput) => {
    if (!input) throw Error('Input is not attached');
    const registration = engine.registerMarkdown(adapter.codec);
    try {
      if (enableInput) {
        input.shortcuts = adapter.createShortcuts(engine, commit);
        input.clipboard.plainTextPolicy = 'markdown';
      }
    } catch (error) {
      registration.dispose(); input.shortcuts = literalShortcuts(); throw error;
    }
    return () => {
      registration.dispose();
      if (input && enableInput) { input.shortcuts = literalShortcuts(); input.clipboard.plainTextPolicy = 'literal'; }
    };
  });
  const contentFactories = new Map<string, import('./modules/content.js').ContentFactory>();
  const contentResources = ['editac.images', 'editac.tables'].map(id => configuredResource(prepared, id, async signal => {
    const { contentModules } = await import('./modules/content.js');
    if (signal.aborted) return { dispose() {} };
    const factory = contentModules();
    contentFactories.set(id, context => {
      const tuple = context.node.blockAttributes;
      const type = Array.isArray(tuple) ? tuple[0] : undefined;
      const metadata = Array.isArray(tuple) ? tuple[2] : undefined;
      const imageAsset = type === 'module:editac.asset' && metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.kind === 'image';
      const enabled = id === 'editac.tables' ? type === 'module:editac.table' : type === 'module:editac.image' || imageAsset;
      return enabled ? factory(context) : undefined;
    });
    renderer.setContentFactory(context => {
      for (const selected of contentFactories.values()) { const view = selected(context); if (view) return view; }
      return undefined;
    });
    return { dispose() { contentFactories.delete(id); } };
  }));
  const resources = [resource, ...contentResources];
  const disposeAdapters = (): void => {
    for (const owned of resources) owned.dispose();
    page?.dispose(); viewport?.dispose();
    try { links?.dispose(); } finally { try { input?.dispose(); } finally { try { selection?.dispose(); } finally { try { renderer.dispose(); } finally { markdown?.dispose(); } } } }
  };
  try {
    if (options.markdown) markdown = engine.registerMarkdown(options.markdown.codec);
    root.setAttribute('role', 'textbox'); root.setAttribute('aria-multiline', 'true');
    root.setAttribute('aria-label', options.label ?? root.getAttribute('aria-label') ?? 'Document editor');
    if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
    selection = new DOMSelection(renderer, engine);
    selection.pointer.viewport = options.selectionViewport;
    links = options.links?.(root, engine, commit);
    input = new TextInput(renderer, selection, engine,
      links?.commit ?? commit, options.clipboardCodecs ?? []);
    input.keyboard.configureCommands(options.shortcutProfile, options.commandAllowed);
    if (options.codeCommands) input.attachCodeCommands(options.codeCommands);
    if (options.search) input.attachSearch(options.search);
    if (options.reorder) input.attachReorder(options.reorder);
    if (options.references) input.attachReferences(options.references);
    if (options.slash) input.attachSlash(options.slash);
    if (options.markdown) input.shortcuts = options.markdown.createShortcuts(engine, commit);
    input.shortcuts.enabled=options.typingShortcuts??true;
    input.clipboard.plainTextPolicy = options.plainTextPolicy ?? (options.preset === 'minimal' || !engine.markdownAvailable ? 'literal' : 'markdown');
    input.clipboard.contentCodecs = options.contentCodecs ?? {};
    let requestedReadOnly = options.readOnly ?? false;
    let requiredReady = !resources.some(owned => owned.required);
    const setReadOnly = (value: boolean) => {
      requestedReadOnly = value;
      input!.setReadOnly(value || !requiredReady);
      root.setAttribute('aria-readonly', String(value || !requiredReady));
    };
    setReadOnly(requestedReadOnly);
    const boundInput = input, boundSelection = selection;
    viewport = new EditorViewport(root, options.viewport, recoverable => {
      if (!recoverable) boundSelection.pointer.cancel();
      boundInput.reorder?.refreshGeometry(recoverable);
    });
    if(input.reorder) viewport.addControls(input.reorder.controls);
    if(input.slash) { viewport.addControls(input.slash.control); viewport.addControls(input.slash.menu); }
    if(input.references) { viewport.addControls(input.references.control); viewport.addControls(input.references.menu); }
    if(input.codeCommands) viewport.addControls(input.codeCommands.element);
    const boundViewport = viewport;
    page = new PageLifecycle(root, suspended => {
      if (suspended) { boundInput.suspend(); boundViewport.suspend(); options.onSuspend?.(); }
      else { boundInput.resume(); boundViewport.resume(); }
    });
    let disposed = false;
    const loadExtension = async (id: string) => {
      const owned = resources.find(candidate => candidate.id === id && candidate.configured);
      if (!owned) throw Error('No configured asynchronous adapter: ' + id);
      await owned.load();
      if (disposed) throw Error('Editor surface is disposed');
      requiredReady = resources.every(candidate => !candidate.required || candidate.status.state === 'ready'); setReadOnly(requestedReadOnly);
    };
    const ready = Promise.all(resources.filter(owned => owned.required).map(owned => loadExtension(owned.id))).then(() => {});
    void ready.catch(() => {});
    return { ready, loadExtension, setReadOnly,
      get extensionStatus() { return Object.freeze(Object.fromEntries((prepared?.extensions ?? []).map(e => [e.feature.id,
        resources.find(owned => owned.id === e.feature.id)?.status ?? Object.freeze({ state: disposed ? 'cancelled' as const : 'ready' as const, generation: 1 })]))); },
      async exportMarkdown(blocks: readonly import('@edit-ac/core').FragmentBlock[]) {
        const captured = structuredClone(blocks);
        await loadExtension('editac.markdown');
        return resource.adapter!.codec.exportMarkdown(captured);
      },
      platformPreferences: preferences.observation, viewport: boundViewport, renderer, selection: boundSelection, input: boundInput, pointerSelection: boundSelection.pointer,
      dispose(): void {
        if (disposed) return; disposed = true;
        root.contentEditable = 'false'; root.setAttribute('aria-readonly', 'true');
        try { disposeAdapters(); } finally { preferences.dispose(); disposePresentation(); }
      } };
  } catch (error) {
    try { disposeAdapters(); } finally { preferences.dispose(); disposePresentation(); }
    root.contentEditable = 'false'; throw error;
  }
}

/** Mount a view over a host-owned replica; an explicit storage owner enables managed sync. */
export function mountEditorSurface(root: HTMLElement, engine: EngineHandle, options: EditorSurfaceOptions = {}): EditorSurface {
  const prepared = prepareSurfaceConfiguration(options, engine.read().identity.schema);
  const policy = prepared?.configuration.collaboration;
  let ports: ReturnType<typeof editorStoragePorts> | undefined;
  if (options.storageOwner) {
    try { ports = editorStoragePorts(options.storageOwner); } catch {
      throw new ExtensionConfigurationError('invalid-storage-owner', 'editor', 'storageOwner', 'Use openEditorStorage for this exact replica');
    }
    if (ports.writer.engine !== engine) throw new ExtensionConfigurationError('incompatible-storage-owner', 'editor', 'storageOwner', 'Mount the engine belonging to this storage owner');
    if (options.commit) throw new ExtensionConfigurationError('legacy-conflict', 'editor', 'commit', 'The explicit storage owner supplies the only commit port');
  }
  if (policy && !ports) throw new ExtensionConfigurationError('requires-storage-owner', 'editor', 'collaboration', 'Supply openEditorStorage for managed borrowed sync');
  const release = reserveEditorSurface(root);
  let disposed = false, generation = 0;
  let controller: AbortController | undefined, attachment: SyncAttachment | undefined;
  let collaborationStatus: import('./extensions/contract.js').ExtensionStatusV1 = Object.freeze({ state: 'idle', generation: 0 });
  let requestedReadOnly = options.readOnly ?? false;
  let localReady = !prepared?.requiredReady.some(id => ['editac.markdown','editac.images','editac.tables'].includes(id));
  let isReady = localReady && (!policy || policy.readiness !== 'remote');
  const requireLive = () => { if (disposed) throw Error('Editor surface is disposed'); };
  const requireReady = () => { requireLive(); if (!isReady) throw Error('Editor surface is not ready'); };
  const disconnect = () => {
    controller?.abort(); controller = undefined; generation++; attachment?.detach();
    collaborationStatus = Object.freeze({ state: 'cancelled', generation });
  };
  try {
    const owner = ports;
    const binding = bindEditorSurface(root, engine, { ...options, readOnly: requestedReadOnly || !isReady,
      ...(owner ? { commit: request => { requireReady(); if (requestedReadOnly) throw Error('Editor surface is read-only'); return owner.storage.commit(request); } } : {}) }, prepared);
    const attach = async (syncOptions: AttachSyncOptions): Promise<SyncAttachment> => {
      requireLive(); if (!localReady || !owner) throw Error('Managed sync requires a ready local storage owner');
      const currentGeneration = ++generation;
      const next = await attachStoredSync({ root, selection: binding.selection, engine, storage: owner.storage,
        indexedDB: owner.indexedDB, databaseName: owner.databaseName,
        current: () => !disposed && generation === currentGeneration,
        onDetach: detached => {
          if (attachment === detached) { attachment = undefined; controller?.abort(); controller = undefined;
            collaborationStatus = Object.freeze({ state: 'cancelled', generation: ++generation }); }
        } }, syncOptions);
      const previous = attachment; attachment = next; previous?.detach(); return next;
    };
    const connect = async () => {
      requireLive(); if (!localReady || !policy) throw Error('Collaboration is not configured or locally ready');
      disconnect(); const currentController = new AbortController(); controller = currentController;
      const currentGeneration = generation;
      const current = () => !disposed && !currentController.signal.aborted && controller === currentController;
      collaborationStatus = Object.freeze({ state: 'loading', generation: currentGeneration });
      try {
        await connectConfiguredCollaboration(policy, { signal: currentController.signal, generation: currentGeneration, current, attach });
        collaborationStatus = Object.freeze({ state: 'ready', generation: currentGeneration });
        if (!isReady && policy.readiness === 'remote') { isReady = true; binding.setReadOnly(requestedReadOnly); }
      } catch (error) {
        if (current()) collaborationStatus = Object.freeze({ state: 'failed', generation: currentGeneration, code: 'attachment-failed', retryable: true });
        throw error;
      }
    };
    const finish = async (adaptersReady = false) => {
      if (!adaptersReady) await binding.ready; requireLive(); localReady = true;
      if (policy && policy.readiness === 'remote') await connect();
      else { isReady = true; binding.setReadOnly(requestedReadOnly); if (policy) void connect().catch(() => {}); }
    };
    const ready = finish(); void ready.catch(() => {});
    return {
      ready,
      async loadExtension(id) {
        requireLive(); await binding.loadExtension(id);
        if (!isReady && prepared?.requiredReady.every(name => binding.extensionStatus[name]?.state === 'ready')) await finish(true);
      },
      exportMarkdown(blocks) { requireReady(); return binding.exportMarkdown(blocks); },
      get collaborationStatus() { return collaborationStatus; },
      get syncAttachment() { return attachment; },
      async attachSync(syncOptions) { requireReady(); disconnect(); return attach(syncOptions); },
      connectCollaboration: connect,
      disconnectCollaboration: disconnect,
      get extensionStatus() { return binding.extensionStatus; },
      extensionConfiguration: prepared,
      platformPreferences: binding.platformPreferences,
      get viewport() { return binding.viewport; },
      get pointerSelection() { return binding.pointerSelection; },
      get codeCommands() { return binding.input.codeCommands; },
      get search() { return binding.input.search; },
      get reorder() { return binding.input.reorder; },
      get references() { return binding.input.references; },
      get slash() { return binding.input.slash; },
      get moduleRuntime() { return binding.renderer.moduleRuntime; },
      get recovery() { return binding.input.recovery.map(({ text, reason }) => ({ text, reason })); },
      captureTextTransfer() { requireReady(); return binding.input.textDrag.capture(); },
      captureToolbar() { requireReady(); return binding.input.keyboard.captureToolbar(); },
      get commands() { return binding.input.keyboard.commands; },
      captureCommand(name, supplied) { requireReady(); return binding.input.keyboard.captureCommand(name, supplied); },
      captureHistory() { requireReady(); return binding.input.keyboard.captureHistory(); },
      settle() { requireReady(); return binding.input.settle(); },
      setReadOnly(value) { requireLive(); requestedReadOnly = value; binding.setReadOnly(value || !isReady); },
      dispose() { if (disposed) return; disposed = true; disconnect(); try { binding.dispose(); } finally { release(); } },
    };
  } catch (error) { disposed = true; disconnect(); release(); throw error; }
}
