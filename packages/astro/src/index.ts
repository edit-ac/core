import { createEditor } from '@edit-ac/web';
import type { BrowserEditor, DestroyResult, EditorOptions } from '@edit-ac/web';

export interface EditorEvents {
  onReady?: (editor: BrowserEditor, host: HTMLElement) => void;
  onError?: (error: unknown, editor: BrowserEditor | null, host: HTMLElement) => void;
  /** Called even after removal. Unsaved reports contain recoverable content. */
  onDispose?: (result: DestroyResult, host: HTMLElement) => void;
}
export interface EditorHostHandle {
  readonly ready: Promise<BrowserEditor | null>;
  readonly editor: BrowserEditor | null;
  setReadOnly(value: boolean): void;
  dispose(): Promise<DestroyResult | null>;
}
const roots = new WeakMap<HTMLElement, EditorHostHandle>();
const documents = new Map<string, Promise<unknown>>();
const resolved = Promise.resolve();
function key(options: EditorOptions): string {
  return JSON.stringify([options.databaseName, options.identity]);
}

/** Browser-only mounting; importing this module on the server initializes nothing.
 * Options retain the web SDK's explicit identity, asset, recovery and host ports. */
export function mountEditorHost(host: HTMLElement, options: EditorOptions, events: EditorEvents = {}): EditorHostHandle {
  const existing = roots.get(host);
  if (existing) return existing;
  const root = host.querySelector<HTMLElement>('[data-editor-surface]');
  if (!root) throw Error('Astro editor host requires a data-editor-surface child');
  let editor: BrowserEditor | null = null;
  let canceled = false;
  let readOnly = options.readOnly ?? host.dataset.readOnly === 'true';
  let closing: Promise<DestroyResult | null> | undefined;
  const documentKey = key(options);
  const reportError = (error: unknown): void => {
    if (events.onError) events.onError(error, editor, host);
    else host.dispatchEvent(new CustomEvent('editac:error', { detail: { error, editor }, bubbles: true }));
  };
  const ready = (documents.get(documentKey) ?? resolved).then(async () => {
    if (canceled) return null;
    editor = createEditor(root, { ...options, readOnly });
    await editor.ready;
    if (!canceled) events.onReady?.(editor, host);
    return canceled ? null : editor;
  });
  // Observe rejection without changing the public ready promise.
  void ready.catch(reportError);
  const handle: EditorHostHandle = {
    ready,
    get editor() { return editor; },
    setReadOnly(value) { readOnly = value; if (editor && !canceled) editor.setReadOnly(value); },
    dispose() {
      if (closing) return closing;
      canceled = true;
      closing = ready.catch(() => null).then(async () => {
        if (!editor) return null;
        let result: DestroyResult;
        try { result = await editor.destroy({ policy: 'flush' }); }
        catch (error) {
          // Retain an explicit unsaved recovery report while releasing listeners.
          try { reportError(error); } finally { result = await editor.destroy({ policy: 'report' }); }
        }
        if (events.onDispose) events.onDispose(result, host);
        else host.ownerDocument.dispatchEvent(new CustomEvent('editac:dispose', { detail: { result, host } }));
        return result;
      }).finally(() => {
        roots.delete(host);
        if (documents.get(documentKey) === closing) documents.delete(documentKey);
      });
      documents.set(documentKey, closing);
      return closing;
    },
  };
  roots.set(host, handle);
  return handle;
}

export type EditorOptionsResolver = (name: string, host: HTMLElement) => EditorOptions | Promise<EditorOptions>;
interface Installation { connect(host: HTMLElement): void; disconnect(host: HTMLElement): void }
const installations = new WeakMap<Document, Installation>();

/** Define once, only in a browser. The component has no server-side globals. */
export function defineEditorHost(): void {
  if (customElements.get('edit-ac-editor')) return;
  customElements.define('edit-ac-editor', class extends HTMLElement {
    connectedCallback(): void { installations.get(this.ownerDocument)?.connect(this); }
    disconnectedCallback(): void { installations.get(this.ownerDocument)?.disconnect(this); }
  });
}

/** Install one options resolver for an Astro document. Custom-element connection
 * handles initial render and ClientRouter swaps, including scripts run only once.
 * Navigation waits for disposal before swapping. A failed save emits an error
 * and an explicit recovery report before navigation proceeds. */
export function installEditorHosts(document: Document, resolveOptions: EditorOptionsResolver, events: EditorEvents = {}): () => Promise<void> {
  if (installations.has(document)) throw Error('Astro editor hosts already installed');
  const hosts = new Map<HTMLElement, { canceled: boolean; handle?: EditorHostHandle; task: Promise<void> }>();
  const error = (cause: unknown, host: HTMLElement, editor: BrowserEditor | null = null): void => {
    if (events.onError) events.onError(cause, editor, host);
    else host.dispatchEvent(new CustomEvent('editac:error', { detail: { error: cause, editor }, bubbles: true }));
  };
  const installation: Installation = {
    connect(host) {
      if (hosts.has(host)) return;
      const state: { canceled: boolean; handle?: EditorHostHandle; task: Promise<void> } = { canceled: false, task: resolved };
      hosts.set(host, state);
      state.task = Promise.resolve().then(() => resolveOptions(host.dataset.editorName ?? '', host)).then(async options => {
        if (state.canceled) return;
        state.handle = mountEditorHost(host, options, events);
        await state.handle.ready.catch(() => null);
      }).catch(cause => error(cause, host));
    },
    disconnect(host) {
      const state = hosts.get(host);
      if (!state) return;
      state.canceled = true;
      // Start disposal immediately so another host for the same document waits.
      const disposed = state.handle?.dispose();
      void state.task.then(() => disposed ?? state.handle?.dispose()).catch(cause => error(cause, host)).finally(() => {
        if (hosts.get(host) === state) hosts.delete(host);
        // A node reinserted during async disposal gets a fresh binding.
        if (host.isConnected && installations.get(document) === installation) installation.connect(host);
      });
    },
  };
  installations.set(document, installation);
  defineEditorHost();
  document.querySelectorAll<HTMLElement>('edit-ac-editor').forEach(host => installation.connect(host));
  interface PreparationEvent extends Event { loader: () => Promise<void>; signal: AbortSignal }
  const beforePreparation = (raw: Event): void => {
    const event = raw as PreparationEvent;
    const loader = event.loader;
    event.loader = async () => {
      await loader();
      if (event.signal.aborted) return;
      // The new page is prepared; disable input and flush before the synchronous
      // swap. preventDefault delegates to full navigation in Astro 7, so save
      // failures use the SDK's observable recovery/report policy instead.
      await Promise.all([...hosts].map(async ([host, state]) => {
        state.canceled = true;
        const disposed = state.handle?.dispose();
        await state.task;
        try { await (disposed ?? state.handle?.dispose()); } catch (cause) { error(cause, host); }
      }));
    };
  };
  document.addEventListener('astro:before-preparation', beforePreparation);
  return async () => {
    installations.delete(document);
    document.removeEventListener('astro:before-preparation', beforePreparation);
    const pending = [...hosts].map(async ([host, state]) => {
      state.canceled = true;
      const disposed = state.handle?.dispose();
      await state.task;
      try { await (disposed ?? state.handle?.dispose()); } catch (cause) { error(cause, host); }
    });
    await Promise.all(pending); hosts.clear();
  };
}
