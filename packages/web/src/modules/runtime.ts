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
  onError?: (error: ModuleRuntimeError) => void;
}
const operations = ['Text', 'Format', 'Structure', 'Editor', 'Remote', 'Undo', 'Redo', 'Selection'] as const;
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
  private readonly upstream: PatchSubscription;
  private readonly listeners = new Set<Listener>();
  private readonly byKind = new Map<Patch['operation'], Set<Listener>>();
  private readonly bySource = new Map<string, Set<Listener>>();
  private readonly anySource = new Set<Listener>();
  private readonly selection = new Set<Listener>();
  private readonly views = new Set<ModuleView>();
  private readonly renderers: Readonly<Record<string, ModuleRenderer>>;
  private readonly onError: ModuleRuntimeOptions['onError'];
  private readonly errors: ModuleRuntimeError[] = [];
  private sequence = 0;
  private disposed = false;
  private selectionKey = 'null';
  constructor(engine: EngineHandle, options: ModuleRuntimeOptions = {}) {
    this.renderers = Object.freeze(Object.fromEntries(Object.entries(options.renderers ?? {}).map(([type, r]) => [type, { mount: r.mount.bind(r) }])));
    this.onError = options.onError;
    this.upstream = engine.subscribe({ type: 'all' }, patch => this.dispatch(patch));
  }
  get active(): boolean { return !this.disposed && this.upstream.active; }
  takeErrors(): ModuleRuntimeError[] { return this.errors.splice(0); }
  private report(phase: ModuleRuntimeError['phase'], error: unknown): void {
    // Error conversion and diagnostics must not let a hostile thrown object or
    // throwing reporter escape into the engine's observer queue.
    let message = 'Module callback failed';
    try { message = String(error instanceof Error ? error.message : error).slice(0, 512); } catch { /* keep bounded default */ }
    const item = Object.freeze({ phase, message });
    if (this.errors.length === 64) this.errors.shift();
    this.errors.push(item);
    try { this.onError?.(item); } catch { /* diagnostics are isolated too */ }
  }
  subscribe(input: ModuleScope, callback: (event: ModuleEvent) => void): PatchSubscription {
    if (!this.active) throw Error('Module runtime is disposed');
    if (typeof callback !== 'function') throw Error('Invalid module callback');
    const kinds = [...new Set(input.kinds ?? operations.filter(k => k !== 'Selection'))];
    if (kinds.some(k => !operations.includes(k))) throw Error('Invalid module operation');
    const range = input.range ? { ...input.range } : undefined;
    if (range && (!range.source || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) throw Error('Invalid module UTF-16 range');
    const listener: Listener = { id: ++this.sequence, scope: { kinds, ...(range ? { range } : {}), selection: input.selection === true }, callback, active: true, selected: false };
    this.listeners.add(listener);
    for (const k of kinds) { const set = this.byKind.get(k) ?? new Set(); set.add(listener); this.byKind.set(k, set); }
    if (range) { const set = this.bySource.get(range.source) ?? new Set(); set.add(listener); this.bySource.set(range.source, set); }
    else this.anySource.add(listener);
    if (listener.scope.selection) this.selection.add(listener);
    const runtime = this;
    return {
      get active() { return listener.active && runtime.active; },
      dispose() {
        if (!listener.active) return;
        listener.active = false; runtime.listeners.delete(listener); runtime.anySource.delete(listener); runtime.selection.delete(listener);
        for (const k of kinds) { const set = runtime.byKind.get(k); set?.delete(listener); if (!set?.size) runtime.byKind.delete(k); }
        if (range) { const set = runtime.bySource.get(range.source); set?.delete(listener); if (!set?.size) runtime.bySource.delete(range.source); }
      },
    };
  }
  private dispatch(patch: Patch): void {
    if (!this.active) return;
    const candidates = new Set<Listener>();
    const kinds = this.byKind.get(patch.operation);
    if (patch.operation !== 'Selection' || patch.nodes.length || patch.update) {
      for (const l of this.anySource) if (kinds?.has(l)) candidates.add(l);
      for (const r of patch.touchedRanges) for (const l of this.bySource.get(r.source) ?? [])
        if (kinds?.has(l) && overlap(Math.min(r.start, r.newStart), Math.max(r.oldEnd, r.newEnd), l.scope.range!)) candidates.add(l);
      // Structural/format changes can lack text deltas. Test only changed nodes'
      // source spans; never use a whole-document snapshot as a fallback.
      for (const change of patch.nodes) if (change.type !== 'removed') for (const span of change.node.spans)
        if (!patch.touchedRanges.some(r => r.source === span.source)) for (const l of this.bySource.get(span.source) ?? [])
          if (kinds?.has(l) && overlap(span.start, span.end, l.scope.range!)) candidates.add(l);
    }
    for (const source of patch.changedSources) if (!patch.touchedRanges.some(r => r.source === source) &&
        !patch.nodes.some(c => c.type !== 'removed' && c.node.spans.some(s => s.source === source)))
      for (const l of this.bySource.get(source) ?? []) if (kinds?.has(l)) candidates.add(l);
    if (patch.selectionChanged) this.selectionCandidates(patch.selection, candidates);
    this.deliver(candidates, { type: 'patch', patch });
  }
  private selectionCandidates(selection: Patch['selection'], candidates: Set<Listener>): void {
    for (const l of this.selection) {
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
  private deliver(candidates: Set<Listener>, event: ModuleEvent): void {
    for (const l of [...candidates].sort((a, b) => a.id - b.id)) {
      if (!this.active) break;
      if (l.active) try { l.callback(event); } catch (error) { this.report('subscription', error); }
    }
  }
  /** Native caret/navigation is ephemeral adapter state, not an engine commit.
   * Deduplicate repeated captures; notify previously selected scopes on departure. */
  setSelection(selection: Patch['selection']): void {
    if (!this.active) return;
    const key = JSON.stringify(selection);
    if (key === this.selectionKey) return;
    this.selectionKey = key;
    const candidates = new Set<Listener>(); this.selectionCandidates(selection, candidates);
    this.deliver(candidates, { type: 'selection', selection: structuredClone(selection) });
  }
  /** Adapter-owned stable view. Failed views are disposed once and the adapter
   * removes their decoration, leaving canonical source text as fallback. */
  mountView(element: HTMLElement, content: ModuleViewContent, fallback: () => void): ModuleView | undefined {
    if (!this.active) return undefined;
    const renderer = Object.hasOwn(this.renderers, content.type) ? this.renderers[content.type] : undefined;
    if (!renderer) return undefined;
    let view: ModuleView;
    try {
      view = renderer.mount(element, immutable(content));
      if (view && typeof (view as unknown as { then?: unknown }).then === 'function') {
        // Invalid async hooks must not leave an unhandled rejection or leak a
        // late resource after their decoration has already fallen back.
        void Promise.resolve(view).then(late => {
          try { if (late && typeof late.dispose === 'function') late.dispose(); }
          catch (error) { this.report('dispose', error); }
        }, error => this.report('mount', error));
      }
      if (!view || typeof view.update !== 'function' || typeof view.dispose !== 'function') throw Error('Module mount must return synchronous update/dispose hooks');
    }
    catch (error) { this.report('mount', error); fallback(); return undefined; }
    let live = true;
    const runtime = this;
    const owned: ModuleView = {
      update(next) {
        if (!live || !runtime.active) return;
        try { view.update(immutable(next)); }
        catch (error) { runtime.report('update', error); owned.dispose(); fallback(); }
      },
      dispose() {
        if (!live) return; live = false; runtime.views.delete(owned);
        try { view.dispose(); } catch (error) { runtime.report('dispose', error); }
        finally { element.remove(); }
      },
    };
    this.views.add(owned); return owned;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.upstream.dispose();
    for (const l of this.listeners) l.active = false;
    this.listeners.clear(); this.byKind.clear(); this.bySource.clear(); this.anySource.clear(); this.selection.clear();
    for (const view of [...this.views]) view.dispose();
  }
}
