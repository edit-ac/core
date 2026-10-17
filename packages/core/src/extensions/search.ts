import type { AnchorToken, CommitResult, EditorCommand, EngineHandle, PrepareRequest, Snapshot, StableRange } from '../engine.js';

/** Literal UTF-16 text profile. Module payloads/atoms and structural queries are absent. */
export const DOCUMENT_SEARCH_PROFILE = Object.freeze({
  id: 'editac.document-search.literal.v1', version: 1, caseSensitive: true,
  normalization: 'none', regex: false, structural: false, modulePayloads: false, crossBlock: false, crossAtom: false, crossCell: false,
  destinationMarks: 'engine-inherited', protectedRanges: 'reject-all',
} as const);
export const DOCUMENT_SEARCH_LIMITS = Object.freeze({ queryUnits: 256, documentUnits: 1_048_576, blocks: 10_000, matches: 256, replacementBytes: 1_048_576, sliceBlocks: 32 });
export interface DocumentSearchMatch { readonly owner: string; readonly from: number; readonly to: number }
export interface DocumentSearchResult {
  readonly profile: typeof DOCUMENT_SEARCH_PROFILE.id; readonly revision: number;
  readonly status: 'empty' | 'ready' | 'canceled' | 'stale' | 'limit' | 'unsupported';
  readonly matches: readonly DocumentSearchMatch[];
  readonly blocks: number; readonly units: number;
}
export class DocumentSearchError extends Error {}
interface OwnedMatch { match: DocumentSearchMatch; range: StableRange }
const textOf = (node: Snapshot['visible'][number]) => node.runs.map(r => r.text).join('');
const supported = (node: Snapshot['visible'][number]) => node.kind !== 'list' && node.kind !== 'quote' &&
  !(Array.isArray(node.blockAttributes) && (String(node.blockAttributes[0]).startsWith('module:') || node.blockAttributes[0] === 'separator'));
const scalarBoundary = (text: string, at: number) => !(at > 0 && at < text.length && /[\uD800-\uDBFF]/u.test(text[at - 1]!) && /[\uDC00-\uDFFF]/u.test(text[at]!));

/** Optional, viewer-local provider over the existing engine. Owns every captured anchor.
 * Search never selects or mutates. The commit callback must be synchronous and enforce
 * current host permission; no prepared request is retained across an async boundary.
 */
export class DocumentSearchSession {
  #epoch = 0; #disposed = false; #matches: OwnedMatch[] = []; #scope: StableRange | undefined; #bookmark: StableRange | undefined;
  #result: DocumentSearchResult; #query = ''; #index = -1;
  readonly #subscription;
  constructor(readonly engine: EngineHandle, readonly changed: () => void = () => {}) {
    this.#result = this.#empty('empty');
    this.#subscription = engine.subscribe({ type: 'updates' }, () => this.invalidate());
  }
  get result(): DocumentSearchResult { return this.#result; }
  get current(): DocumentSearchMatch | undefined { return this.#matches[this.#index]?.match; }
  get index(): number { return this.#index; }
  #empty(status: DocumentSearchResult['status'], revision = -1, blocks = 0, units = 0): DocumentSearchResult {
    return Object.freeze({ profile: DOCUMENT_SEARCH_PROFILE.id, revision, status, matches: Object.freeze([]), blocks, units });
  }
  #release(range?: StableRange): void { if (range) { this.engine.releaseAnchor(range.anchor); this.engine.releaseAnchor(range.focus); } }
  #clearMatches(): void { for (const value of this.#matches) this.#release(value.range); this.#matches = []; this.#index = -1; }
  #clone(range: StableRange): StableRange {
    const a = this.engine.resolve(range.anchor), f = this.engine.resolve(range.focus);
    if (a.type !== 'position' || f.type !== 'position') throw new DocumentSearchError('Selection unavailable');
    const snapshot = this.engine.read(), order = new Map(snapshot.visible.map((n, i) => [n.id, i]));
    if (!order.has(a.node) || !order.has(f.node)) throw new DocumentSearchError('Selection unavailable');
    const forward = order.get(a.node)! < order.get(f.node)! || (a.node === f.node && a.offset <= f.offset);
    const anchor = this.engine.anchor(a.node, a.offset, forward ? 'right' : 'left');
    try { return { anchor, focus: this.engine.anchor(f.node, f.offset, forward ? 'left' : 'right') }; }
    catch (error) { this.engine.releaseAnchor(anchor); throw error; }
  }
  /** Capture before focusing the query field. Later query/native selections cannot retarget it. */
  capture(range?: StableRange, selectionScope = false): void {
    if (this.#disposed) throw new DocumentSearchError('Search disposed');
    this.cancel(); this.#release(this.#scope); this.#release(this.#bookmark); this.#scope = undefined; this.#bookmark = undefined;
    if (range) {
      this.#bookmark = this.#clone(range);
      if (selectionScope) this.#scope = this.#clone(range);
    } else if (selectionScope) throw new DocumentSearchError('Selection scope requires a captured range');
  }
  seed(): string {
    if (!this.#bookmark) return '';
    const a = this.engine.resolve(this.#bookmark.anchor), f = this.engine.resolve(this.#bookmark.focus);
    if (a.type !== 'position' || f.type !== 'position' || a.node !== f.node) return '';
    const n = this.engine.read().visible.find(n => n.id === a.node);
    if (!n || !supported(n) || n.runs.some(r => Object.keys(r.attributes).some(k => k.startsWith('module:')))) return '';
    const value = textOf(n).slice(Math.min(a.offset, f.offset), Math.max(a.offset, f.offset));
    return value.length <= DOCUMENT_SEARCH_LIMITS.queryUnits ? value : '';
  }
  invalidate(): void {
    if (this.#disposed) return;
    this.#epoch++; this.#clearMatches(); this.#result = this.#empty('stale'); this.changed();
  }
  cancel(): void {
    if (this.#disposed) return;
    this.#epoch++; this.#clearMatches(); this.#result = this.#empty('canceled'); this.changed();
  }
  async search(query: string, options: { signal?: AbortSignal; mode?: 'literal'; yield?: () => Promise<void> } = {}): Promise<DocumentSearchResult> {
    if (this.#disposed) throw new DocumentSearchError('Search disposed');
    this.cancel(); const epoch = this.#epoch; this.#query = query;
    const snapshot = this.engine.read(); let blocks = 0, units = 0;
    const live = () => !this.#disposed && epoch === this.#epoch && !options.signal?.aborted;
    const finish = (status: DocumentSearchResult['status']) => {
      const result = this.#empty(status, snapshot.revision, blocks, units);
      if (live()) { this.#result = result; this.changed(); }
      return result;
    };
    if (typeof query !== 'string') return finish('unsupported');
    if (!query) return finish('empty');
    if (options.mode !== undefined && options.mode !== 'literal') return finish('unsupported');
    if (query.length > DOCUMENT_SEARCH_LIMITS.queryUnits) return finish('limit');
    if (!scalarBoundary(query, 0) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(query)) return finish('unsupported');
    if (snapshot.visible.length > DOCUMENT_SEARCH_LIMITS.blocks) return finish('limit');
    const order = new Map(snapshot.visible.map((n, i) => [n.id, i]));
    let start = { index: 0, offset: 0 }, end = { index: snapshot.visible.length - 1, offset: Infinity };
    if (this.#scope) {
      const a = this.engine.resolve(this.#scope.anchor), f = this.engine.resolve(this.#scope.focus);
      if (a.type !== 'position' || f.type !== 'position' || !order.has(a.node) || !order.has(f.node)) return finish('stale');
      const x = { index: order.get(a.node)!, offset: a.offset }, y = { index: order.get(f.node)!, offset: f.offset };
      [start, end] = x.index < y.index || (x.index === y.index && x.offset <= y.offset) ? [x, y] : [y, x];
    }
    const found: DocumentSearchMatch[] = [];
    for (let i = start.index; i <= end.index; i++) {
      if (!live()) return this.#empty('canceled', snapshot.revision, blocks, units);
      if (blocks && blocks % DOCUMENT_SEARCH_LIMITS.sliceBlocks === 0) await (options.yield?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
      if (!live()) return this.#empty('canceled', snapshot.revision, blocks, units);
      const node = snapshot.visible[i]!; blocks++;
      const length = node.runs.reduce((n, r) => n + r.text.length, 0); units += length;
      if (units > DOCUMENT_SEARCH_LIMITS.documentUnits) return finish('limit');
      if (!supported(node)) continue;
      const lo = i === start.index ? start.offset : 0, hi = Math.min(length, i === end.index ? end.offset : length);
      // Ordinary marks are transparent; unknown module envelopes are hard boundaries.
      let offset = 0, segment = '', base = 0;
      const scan = () => {
        let at = Math.max(0, lo - base);
        while (at <= segment.length - query.length) {
          at = segment.indexOf(query, at); if (at < 0 || base + at + query.length > hi) break;
          if (scalarBoundary(segment, at) && scalarBoundary(segment, at + query.length)) found.push(Object.freeze({ owner: node.id, from: base + at, to: base + at + query.length }));
          if (found.length > DOCUMENT_SEARCH_LIMITS.matches) return false;
          at += query.length;
        }
        return true;
      };
      for (const run of node.runs) {
        if (Object.keys(run.attributes).some(k => k.startsWith('module:'))) {
          if (!scan()) return finish('limit'); segment = ''; base = offset + run.text.length;
        } else segment += run.text;
        offset += run.text.length;
      }
      if (!scan()) return finish('limit');
    }
    if (!live()) return this.#empty('canceled', snapshot.revision, blocks, units);
    if (this.engine.read().revision !== snapshot.revision) return finish('stale');
    try {
      for (const match of found) {
        const anchor = this.engine.anchor(match.owner, match.from, 'right');
        let focus: AnchorToken;
        try { focus = this.engine.anchor(match.owner, match.to, 'left'); }
        catch (error) { this.engine.releaseAnchor(anchor); throw error; }
        this.#matches.push({ match, range: { anchor, focus } });
      }
    } catch (error) { this.#clearMatches(); throw error; }
    this.#index = found.length ? 0 : -1;
    this.#result = Object.freeze({ profile: DOCUMENT_SEARCH_PROFILE.id, revision: snapshot.revision, status: 'ready', matches: Object.freeze(found), blocks, units });
    this.changed(); return this.#result;
  }
  navigate(backward = false): { match?: DocumentSearchMatch; index: number; wrapped: boolean } {
    const count = this.#matches.length; if (!count) return { index: -1, wrapped: false };
    const next = this.#index + (backward ? -1 : 1), wrapped = next < 0 || next >= count;
    this.#index = (next + count) % count; return { match: this.current!, index: this.#index, wrapped };
  }
  /** One captured revision, descending coordinates, one existing prepared engine batch. */
  replace(text: string, all: boolean, commit: (request: PrepareRequest) => CommitResult,
    authorize: (targets: readonly DocumentSearchMatch[]) => boolean = () => true): CommitResult {
    if (this.#disposed || this.#result.status !== 'ready' || !this.#matches.length) throw new DocumentSearchError('No current results');
    const revision = this.#result.revision, targets = all ? this.#matches : [this.#matches[this.#index]!];
    if (typeof text !== 'string' || text.length > DOCUMENT_SEARCH_LIMITS.replacementBytes || new TextEncoder().encode(text).length * targets.length > DOCUMENT_SEARCH_LIMITS.replacementBytes) throw new DocumentSearchError('Replacement limit; narrow scope');
    const snapshot = this.engine.read();
    if (snapshot.revision !== revision || !authorize(Object.freeze(targets.map(v => v.match))) || this.engine.read().revision !== revision) throw new DocumentSearchError('Stale or protected results; search again');
    for (const { match, range } of targets) {
      const a = this.engine.resolve(range.anchor), f = this.engine.resolve(range.focus);
      const node = snapshot.visible.find(n => n.id === match.owner);
      if (!node || a.type !== 'position' || f.type !== 'position' || a.node !== match.owner || f.node !== match.owner || a.offset !== match.from || f.offset !== match.to || textOf(node).slice(a.offset, f.offset) !== this.#query) throw new DocumentSearchError('Stale match');
    }
    const first = targets[0]!.match;
    const commands: EditorCommand[] = [];
    if (this.#bookmark) {
      const a = this.engine.resolve(this.#bookmark.anchor), f = this.engine.resolve(this.#bookmark.focus);
      if (a.type !== 'position' || f.type !== 'position') throw new DocumentSearchError('Selection unavailable');
      commands.push({ type: 'historySelectionAt', anchor: { owner: a.node, offset: a.offset, bias: a.bias }, focus: { owner: f.node, offset: f.offset, bias: f.bias } });
    }
    commands.push(...targets.slice().reverse().map(({ match }) => ({ type: 'replaceAt' as const, ...match, text })));
    const caret = { owner: first.owner, offset: first.from + text.length, bias: 'right' as const };
    commands.push({ type: 'selectionAt', anchor: caret, focus: caret });
    const request: PrepareRequest = { kind: 'editor', origin: all ? 'search:replace-all' : 'search:replace-current', commands };
    if (!this.engine.can(request) || this.engine.read().revision !== revision) throw new DocumentSearchError('Replacement unavailable');
    this.engine.history({ type: 'boundary' }); this.engine.history({ type: 'explicit' });
    try { return commit(request); } finally { this.engine.history({ type: 'boundary' }); this.invalidate(); }
  }
  close(): void { if (this.#disposed) return; this.cancel(); this.#release(this.#scope); this.#release(this.#bookmark); this.#scope = undefined; this.#bookmark = undefined; }
  dispose(): void { if (this.#disposed) return; this.close(); this.#subscription.dispose(); this.#disposed = true; }
}
