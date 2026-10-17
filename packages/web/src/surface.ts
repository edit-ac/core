import type { LinkEnrichment, LinkEnrichmentFactory } from './modules/links/enrichment.js';
import type { CommitResult, EngineHandle, PrepareRequest } from '@edit-ac/core';
import { DOMRenderer } from './dom/render.js';
import { DOMSelection } from './dom/selection.js';
import { TextInput } from './input/text.js';
import type { ModuleRuntime, ModuleRuntimeOptions } from './modules/runtime.js';
import type { ClipboardCodec } from './clipboard/fragment.js';

export interface EditorSurfaceOptions {
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
  preset?: 'task' | 'minimal';
  plainTextPolicy?: 'markdown' | 'literal';
  contentCodecs?: import('@edit-ac/core').MarkdownOptions;
  /** Host persistence/command port; defaults to committing to the borrowed engine. */
  commit?: (request: PrepareRequest) => CommitResult;
}
export interface EditorSurface {
  readonly pointerSelection: import('./selection/pointer.js').PointerSelection;
  readonly codeCommands: import('./extensions/code.js').CodeCommandsPresenter | undefined;
  readonly search: import('./modules/search.js').DocumentSearchPresenter | undefined;
  readonly reorder: import('./modules/reorder.js').ReorderPresenter | undefined;
  readonly references: import('./modules/references.js').ReferencePresenter | undefined;
  readonly slash: import('./modules/slash.js').SlashPresenter | undefined;
  readonly moduleRuntime: ModuleRuntime | undefined;
  readonly recovery: readonly { text: string; reason: string }[];
  captureToolbar(): import('./commands/formatting.js').ToolbarTarget | undefined;
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
export function bindEditorSurface(root: HTMLElement, engine: EngineHandle, options: EditorSurfaceOptions = {}) {
  const commit = options.commit ?? ((request: PrepareRequest) => engine.commit(engine.prepare(request)));
  const renderer = new DOMRenderer(root, engine, { ...options, readOnly: true });
  let selection: DOMSelection | undefined, input: TextInput | undefined;
  let links: LinkEnrichment | undefined;
  let markdown: import('@edit-ac/core').PatchSubscription | undefined;
  const disposeAdapters = (): void => {
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
    if (options.codeCommands) input.attachCodeCommands(options.codeCommands);
    if (options.search) input.attachSearch(options.search);
    if (options.reorder) input.attachReorder(options.reorder);
    if (options.references) input.attachReferences(options.references);
    if (options.slash) input.attachSlash(options.slash);
    if (options.markdown) input.shortcuts = options.markdown.createShortcuts(engine, commit);
    input.shortcuts.enabled=options.typingShortcuts??true;
    input.clipboard.plainTextPolicy = options.plainTextPolicy ?? (options.preset === 'minimal' || !engine.markdownAvailable ? 'literal' : 'markdown');
    input.clipboard.contentCodecs = options.contentCodecs ?? {};
    input.setReadOnly(options.readOnly ?? false);
    root.setAttribute('aria-readonly', String(options.readOnly ?? false));
    const boundInput = input, boundSelection = selection;
    let disposed = false;
    return { renderer, selection: boundSelection, input: boundInput, pointerSelection: boundSelection.pointer,
      dispose(): void {
        if (disposed) return; disposed = true;
        root.contentEditable = 'false'; root.setAttribute('aria-readonly', 'true');
        disposeAdapters();
      } };
  } catch (error) {
    disposeAdapters();
    root.contentEditable = 'false'; throw error;
  }
}

/** Mount a synchronous view over a host-owned engine, without a storage service. */
export function mountEditorSurface(root: HTMLElement, engine: EngineHandle, options: EditorSurfaceOptions = {}): EditorSurface {
  const release = reserveEditorSurface(root);
  try {
    const binding = bindEditorSurface(root, engine, options);
    let disposed = false;
    const requireLive = () => { if (disposed) throw Error('Editor surface is disposed'); };
    return {
      get pointerSelection() { return binding.pointerSelection; },
      get codeCommands() { return binding.input.codeCommands; },
      get search() { return binding.input.search; },
      get reorder() { return binding.input.reorder; },
      get references() { return binding.input.references; },
      get slash() { return binding.input.slash; },
      get moduleRuntime() { return binding.renderer.moduleRuntime; },
      get recovery() { return binding.input.recovery.map(({ text, reason }) => ({ text, reason })); },
      captureToolbar() { requireLive(); return binding.input.keyboard.captureToolbar(); },
      settle() { requireLive(); return binding.input.settle(); },
      setReadOnly(value) { requireLive(); binding.input.setReadOnly(value); root.setAttribute('aria-readonly', String(value)); },
      dispose() { if (disposed) return; disposed = true; try { binding.dispose(); } finally { release(); } },
    };
  } catch (error) { release(); throw error; }
}
