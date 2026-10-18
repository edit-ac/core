import type { EngineHandle, Json, Patch, PatchSubscription } from '@edit-ac/core';

/** Kinds filter committed operations. Selection is an independent opt-in channel;
 * kinds: [] requests selection only. Ranges are source-local UTF-16 intervals,
 * including their boundary insertions. Hosts replace scopes when their ranges move. */
export interface ModuleScope {
  kinds?: readonly Patch['operation'][];
  range?: { source: string; start: number; end: number };
  selection?: boolean;
}
export type ModuleEvent = { type: 'patch'; patch: Patch } | { type: 'selection'; selection: Patch['selection'] };
export interface ModuleRuntimeError { phase: 'subscription' | 'mount' | 'update' | 'dispose'; message: string }
export interface ModuleViewContent {
  readonly type: string; readonly version: number; readonly kind: 'mark' | 'inline-atom';
  readonly text: string; readonly attributes: Readonly<Record<string, Json>>;
}
export interface ModuleView {
  update(content: ModuleViewContent): void;
  dispose(): void;
}
/** Trusted host behavior, never persisted. The element owns decoration only;
 * canonical content, engine commands and DOM text mappings remain adapter-owned.
 * Allocate resources exception-safely: a throwing mount has no returned disposer. */
export interface ModuleRenderer { mount(element: HTMLElement, content: ModuleViewContent): ModuleView }
export interface ModuleRuntimeOptions {
  renderers?: Readonly<Record<string, ModuleRenderer>>;
  /** Host view hints for already-admitted data; never registers or changes a definition. */
  presentations?: Readonly<Record<string, { readonly tag: 'span' | 'mark' | 'code' }>>;
  onError?: (error: ModuleRuntimeError) => void;
}
const operations = ['Text', 'Format', 'Structure', 'Editor', 'Remote', 'Undo', 'Redo', 'Selection'] as const;
export interface ModuleDispatchWork { patches: number; examined: number; callbacks: number; registryScans: number; documentReads: number }
interface Listener { id: number; scope: ModuleScope; callback: (event: ModuleEvent) => void; active: boolean; selected: boolean }
const overlap = (start: number, end: number, range: NonNullable<ModuleScope['range']>) => start <= range.end && end >= range.start;
function immutable(content: ModuleViewContent): ModuleViewContent {
  const result = structuredClone(content);
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  };
  freeze(result); return result;
}

/** One engine observer, indexed by operation and source. Dispatch examines patch
 * deltas only; it never calls read() or scans projected document content. */
export class ModuleRuntime {
  readonly #upstream: PatchSubscription;
  readonly #listeners = new Set<Listener>();
  readonly #byKind = new Map<Patch['operation'], { any: Set<Listener>; sources: Map<string, Set<Listener>> }>();
  readonly #work: ModuleDispatchWork = { patches: 0, examined: 0, callbacks: 0, registryScans: 0, documentReads: 0 };
  readonly #selection = new Set<Listener>();
  readonly #views = new Set<ModuleView>();
  readonly #renderers: Readonly<Record<string, ModuleRenderer>>;
  readonly #presentations: NonNullable<ModuleRuntimeOptions['presentations']>;
  readonly #onError: ModuleRuntimeOptions['onError'];
  readonly #errors: ModuleRuntimeError[] = [];
  #sequence = 0;
  #disposed = false;
  #selectionKey = 'null';
  constructor(engine: EngineHandle, options: ModuleRuntimeOptions = {}) {
    const presentations = Object.entries(options.presentations ?? {}).map(([type, value]) => {
      if (!value || !['span','mark','code'].includes(value.tag) || Object.keys(value).length !== 1) throw Error('Invalid module presentation');
      return [type, Object.freeze({ tag: value.tag })] as const;
    });
    this.#presentations = Object.freeze(Object.fromEntries(presentations));
    this.#renderers = Object.freeze(Object.fromEntries(Object.entries(options.renderers ?? {}).map(([type, r]) => [type, { mount: r.mount.bind(r) }])));
    this.#onError = options.onError;
    this.#upstream = engine.subscribe({ type: 'all' }, patch => this.#dispatch(patch));
  }
  takeWork(): ModuleDispatchWork { const work = { ...this.#work }; for (const key of Object.keys(this.#work) as (keyof ModuleDispatchWork)[]) this.#work[key] = 0; return work; }
  get active(): boolean { return !this.#disposed && this.#upstream.active; }
  presentation(type: string) { return this.#presentations[type]; }
  takeErrors(): ModuleRuntimeError[] { return this.#errors.splice(0); }
  #report(phase: ModuleRuntimeError['phase'], error: unknown): void {
    // Error conversion and diagnostics must not let a hostile thrown object or
    // throwing reporter escape into the engine's observer queue.
    let message = 'Module callback failed';
    try { message = String(error instanceof Error ? error.message : error).slice(0, 512); } catch { /* keep bounded default */ }
    const item = Object.freeze({ phase, message });
    if (this.#errors.length === 64) this.#errors.shift();
    this.#errors.push(item);
    try { this.#onError?.(item); } catch { /* diagnostics are isolated too */ }
  }
  subscribe(input: ModuleScope, callback: (event: ModuleEvent) => void): PatchSubscription {
    if (!this.active) throw Error('Module runtime is disposed');
    if (typeof callback !== 'function') throw Error('Invalid module callback');
    const kinds = [...new Set(input.kinds ?? operations.filter(k => k !== 'Selection'))];
    if (kinds.some(k => !operations.includes(k))) throw Error('Invalid module operation');
    const range = input.range ? { ...input.range } : undefined;
    if (range && (!range.source || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) throw Error('Invalid module UTF-16 range');
    const listener: Listener = { id: ++this.#sequence, scope: { kinds, ...(range ? { range } : {}), selection: input.selection === true }, callback, active: true, selected: false };
    this.#listeners.add(listener);
    for (const k of kinds) {
      const index = this.#byKind.get(k) ?? { any: new Set<Listener>(), sources: new Map<string, Set<Listener>>() };
      this.#byKind.set(k, index);
      if (range) { const set = index.sources.get(range.source) ?? new Set<Listener>(); set.add(listener); index.sources.set(range.source, set); }
      else index.any.add(listener);
    }
    if (listener.scope.selection) this.#selection.add(listener);
    const runtime = this;
    return {
      get active() { return listener.active && runtime.active; },
      dispose() {
        if (!listener.active) return;
        listener.active = false; runtime.#listeners.delete(listener); runtime.#selection.delete(listener);
        for (const k of kinds) {
          const index = runtime.#byKind.get(k); if (!index) continue;
          if (range) { const set = index.sources.get(range.source); set?.delete(listener); if (!set?.size) index.sources.delete(range.source); }
          else index.any.delete(listener);
          if (!index.any.size && !index.sources.size) runtime.#byKind.delete(k);
        }
      },
    };
  }
  #dispatch(patch: Patch): void {
    if (!this.active) return;
    this.#work.patches++;
    const candidates = new Set<Listener>();
    const kinds = this.#byKind.get(patch.operation);
    if (patch.operation !== 'Selection' || patch.nodes.length || patch.update) {
      for (const l of kinds?.any ?? []) { this.#work.examined++; candidates.add(l); }
      for (const r of patch.touchedRanges) for (const l of kinds?.sources.get(r.source) ?? [])
        { this.#work.examined++; if (overlap(Math.min(r.start, r.newStart), Math.max(r.oldEnd, r.newEnd), l.scope.range!)) candidates.add(l); }
      // Structural/format changes can lack text deltas. Test only changed nodes'
      // source spans; never use a whole-document snapshot as a fallback.
      for (const change of patch.nodes) if (change.type !== 'removed') for (const span of change.node.spans)
        if (!patch.touchedRanges.some(r => r.source === span.source)) for (const l of kinds?.sources.get(span.source) ?? [])
          { this.#work.examined++; if (overlap(span.start, span.end, l.scope.range!)) candidates.add(l); }
    }
    for (const source of patch.changedSources) if (!patch.touchedRanges.some(r => r.source === source) &&
        !patch.nodes.some(c => c.type !== 'removed' && c.node.spans.some(s => s.source === source)))
      for (const l of kinds?.sources.get(source) ?? []) { this.#work.examined++; candidates.add(l); }
    if (patch.selectionChanged) this.#selectionCandidates(patch.selection, candidates);
    this.#deliver(candidates, { type: 'patch', patch });
  }
  #selectionCandidates(selection: Patch['selection'], candidates: Set<Listener>): void {
    for (const l of this.#selection) {
      this.#work.examined++;
      const r = l.scope.range;
      let selected = !r;
      if (r && selection && !('error' in selection)) {
        const a = selection.anchor, f = selection.focus;
        selected = [a, f].some(p => p.type === 'position' && p.source === r.source && overlap(p.sourceOffset, p.sourceOffset, r));
        if (a.type === 'position' && f.type === 'position' && a.source === r.source && f.source === r.source)
          selected ||= overlap(Math.min(a.sourceOffset, f.sourceOffset), Math.max(a.sourceOffset, f.sourceOffset), r);
      }
      if (selected || l.selected) candidates.add(l);
      l.selected = selected;
    }
  }
  #deliver(candidates: Set<Listener>, event: ModuleEvent): void {
    for (const l of [...candidates].sort((a, b) => a.id - b.id)) {
      if (!this.active) break;
      if (l.active) try { this.#work.callbacks++; l.callback(event); } catch (error) { this.#report('subscription', error); }
    }
  }
  /** Native caret/navigation is ephemeral adapter state, not an engine commit.
   * Deduplicate repeated captures; notify previously selected scopes on departure. */
  setSelection(selection: Patch['selection']): void {
    if (!this.active) return;
    const key = JSON.stringify(selection);
    if (key === this.#selectionKey) return;
    this.#selectionKey = key;
    const candidates = new Set<Listener>(); this.#selectionCandidates(selection, candidates);
    this.#deliver(candidates, { type: 'selection', selection: structuredClone(selection) });
  }
  /** Adapter-owned stable view. Failed views are disposed once and the adapter
   * removes their decoration, leaving canonical source text as fallback. */
  mountView(element: HTMLElement, content: ModuleViewContent, fallback: () => void): ModuleView | undefined {
    if (!this.active) return undefined;
    const renderer = Object.hasOwn(this.#renderers, content.type) ? this.#renderers[content.type] : undefined;
    if (!renderer) return undefined;
    let view: ModuleView;
    try {
      view = renderer.mount(element, immutable(content));
      if (view && typeof (view as unknown as { then?: unknown }).then === 'function') {
        // Invalid async hooks must not leave an unhandled rejection or leak a
        // late resource after their decoration has already fallen back.
        void Promise.resolve(view).then(late => {
          try { if (late && typeof late.dispose === 'function') late.dispose(); }
          catch (error) { this.#report('dispose', error); }
        }, error => this.#report('mount', error));
      }
      if (!view || typeof view.update !== 'function' || typeof view.dispose !== 'function') throw Error('Module mount must return synchronous update/dispose hooks');
    }
    catch (error) { this.#report('mount', error); fallback(); return undefined; }
    let live = true;
    const runtime = this;
    const owned: ModuleView = {
      update(next) {
        if (!live || !runtime.active) return;
        try { view.update(immutable(next)); }
        catch (error) { runtime.#report('update', error); owned.dispose(); fallback(); }
      },
      dispose() {
        if (!live) return; live = false; runtime.#views.delete(owned);
        try { view.dispose(); } catch (error) { runtime.#report('dispose', error); }
        finally { element.remove(); }
      },
    };
    this.#views.add(owned); return owned;
  }
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true;
    this.#upstream.dispose();
    for (const l of this.#listeners) l.active = false;
    this.#listeners.clear(); this.#byKind.clear(); this.#selection.clear();
    for (const view of [...this.#views]) view.dispose();
  }
}
