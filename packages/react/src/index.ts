import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { HTMLAttributes, ReactElement, RefObject } from 'react';
import { createEditor } from '@edit-ac/web';
import type { BrowserEditor, DestroyResult, EditorOptions, EditorState } from '@edit-ac/web';

export interface EditorEvents {
  onReady?: (editor: BrowserEditor) => void;
  /** Also called after unmount if flushing fails. The replica remains available
   * during this callback; onDispose receives its explicit recovery report. */
  onError?: (error: unknown, editor: BrowserEditor | null) => void;
  onDispose?: (result: DestroyResult) => void;
}
const roots = new WeakMap<HTMLElement, Promise<void>>();
const documents = new Map<string, Promise<void>>();
const resolved = Promise.resolve();
function documentKey(options: EditorOptions): string {
  const id = options.identity;
  return JSON.stringify([options.databaseName, id.documentId, id.epoch, id.schema, id.offsets, id.profile, id.protocolVersion, id.updateEncoding]);
}
function notifyError(events: EditorEvents, error: unknown, editor: BrowserEditor | null): void {
  if (events.onError) events.onError(error, editor);
  else console.error('edit.ac React lifecycle failure', error);
}

/** Bind an empty host to the imperative SDK. Memoize options: replacing them is
 * an explicit session replacement, never a React-controlled document update.
 * Cleanup flushes, then releases the replica. Failed saves produce an observable
 * error and recovery report rather than silently dropping local edits. */
export function useEditor(rootRef: RefObject<HTMLElement | null>, options: EditorOptions, events: EditorEvents = {}, readOnly?: boolean): BrowserEditor | null {
  const authority = useRef(readOnly);
  useEffect(() => { authority.current = readOnly; }, [readOnly]);
  const latest = useRef(events);
  useEffect(() => { latest.current = events; });
  const [editor, setEditor] = useState<BrowserEditor | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const key = documentKey(options);
    let canceled = false;
    let instance: BrowserEditor | null = null;
    setEditor(null);
    // React cleanup is synchronous; SDK teardown is asynchronous. Await both
    // same-surface replacement and pending same-document teardown on a new host.
    const start = Promise.all([roots.get(root) ?? resolved, documents.get(key) ?? resolved]).then(() => {
      if (canceled) return;
      instance = createEditor(root, { ...options, readOnly: authority.current ?? options.readOnly ?? false });
      const current = instance;
      setEditor(current);
      void current.ready.then(() => {
        if (!canceled) latest.current.onReady?.(current);
      }).catch(error => { if (!canceled) notifyError(latest.current, error, current); });
    });
    void start.catch(error => { if (!canceled) notifyError(latest.current, error, instance); });
    return () => {
      canceled = true;
      const closing = start.then(async () => {
        if (!instance) return;
        let report: DestroyResult;
        try { report = await instance.destroy({ policy: 'flush' }); }
        catch (error) {
          // Export/report cleanup is the web SDK's explicit unsaved policy.
          // Finish cleanup even if a host error handler itself throws.
          try { notifyError(latest.current, error, instance); }
          finally { report = await instance.destroy({ policy: 'report' }); }
        }
        latest.current.onDispose?.(report);
      });
      roots.set(root, closing); documents.set(key, closing);
      void closing.then(() => {
        if (roots.get(root) === closing) roots.delete(root);
        if (documents.get(key) === closing) documents.delete(key);
      }, error => { notifyError(latest.current, error, instance); });
    };
  }, [rootRef, options]);
  useEffect(() => {
    if (editor && editor.state.phase !== 'closing' && editor.state.phase !== 'destroyed') {
      editor.setReadOnly(readOnly ?? options.readOnly ?? false);
    }
  }, [editor, readOnly, options.readOnly]);
  return editor;
}

/** Optional status subscription for toolbars. The host does not subscribe to
 * document patches or put content/selection in React state. */
export function useEditorState(editor: BrowserEditor | null): EditorState | null {
  const store = useMemo(() => {
    let snapshot = editor?.state ?? null;
    return {
      getSnapshot: () => snapshot,
      subscribe: (notify: () => void) => {
        if (!editor || editor.state.phase === 'destroyed') return () => {};
        const unsubscribe = editor.subscribe(state => { snapshot = state; notify(); });
        snapshot = editor.state; notify();
        return unsubscribe;
      },
    };
  }, [editor]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
}

export interface EditorHostProps extends EditorEvents {
  options: EditorOptions;
  /** Changes only input authority; does not replace the document. */
  readOnly?: boolean;
  /** Host attributes only. React must never render editable children here. */
  attributes?: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'dangerouslySetInnerHTML' | 'contentEditable' | 'suppressContentEditableWarning'>;
}
export function EditorHost({ options, readOnly, attributes, ...events }: EditorHostProps): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useEditor(root, options, events, readOnly);
  return createElement('div', { ...attributes, ref: root });
}
