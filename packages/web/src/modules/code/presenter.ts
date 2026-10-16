import type { ProjectedNode } from '@edit-ac/core';
import type { DOMRenderer } from '../../dom/render.js';
import { HIGHLIGHT_BACKEND, HighlightScheduler, sameHighlightInput, validHighlightProjection, type HighlightInput, type HighlightResult, type HighlightSchedulerOptions } from './scheduler.js';

export interface CodeHighlightOptions extends Omit<HighlightSchedulerOptions, 'apply'> {
  enabled?: boolean;
  theme?: string;
}
export type CodeHighlightFactory = (renderer: DOMRenderer) => CodeHighlightPresenter;
/** Optional factory for EditorOptions/EditorSurfaceOptions.codeHighlight. */
export function codeHighlighting(options: CodeHighlightOptions): CodeHighlightFactory {
  return renderer => new CodeHighlightPresenter(renderer, options);
}
const colors = { comment: '#687568', string: '#a13c19', keyword: '#7040a0', number: '#176b7a', other: '#245ba0' };
type Kind = keyof typeof colors;
interface Block { input: HighlightInput; element: HTMLElement; ranges: { kind: Kind; range: Range }[]; refresh?: boolean }
let serial = 0;
/** CSS range decorations preserve canonical runs, offset maps, native selection,
 * and input mutation ownership. No text wrappers or collaborative marks. */
export class CodeHighlightPresenter {
  readonly scheduler: HighlightScheduler;
  private readonly blocks = new Map<string, Block>();
  private readonly highlights = new Map<Kind, Highlight>();
  private readonly names = new Map<Kind, string>();
  private readonly style: HTMLStyleElement | undefined;
  private readonly registry: HighlightRegistry | undefined;
  private disposed = false;
  private theme: string;
  private enabled: boolean;
  constructor(private readonly renderer: DOMRenderer, options: CodeHighlightOptions) {
    this.theme = options.theme ?? 'light-v1'; this.enabled = options.enabled ?? true;
    const doc = renderer.root.ownerDocument, view = doc.defaultView;
    this.registry = view?.Highlight ? view.CSS?.highlights : undefined;
    if (this.registry && view?.Highlight) {
      const prefix = `editac-code-${++serial}`;
      this.style = doc.createElement('style');
      this.style.textContent = (Object.keys(colors) as Kind[]).map(kind => {
        const name = `${prefix}-${kind}`, highlight = new view.Highlight();
        this.names.set(kind, name); this.highlights.set(kind, highlight); this.registry!.set(name, highlight);
        return `::highlight(${name}) { color: var(--editac-code-${kind}, ${colors[kind]}); }`;
      }).join('\n');
      (doc.head ?? doc.documentElement).append(this.style);
    }
    this.scheduler = new HighlightScheduler({ ...options, apply: result => this.apply(result) });
  }
  /** Theme identities invalidate in-flight work even when host colors use CSS vars. */
  configure(options: { theme?: string; enabled?: boolean }): void {
    if (this.disposed) return;
    this.theme = options.theme ?? this.theme; this.enabled = options.enabled ?? this.enabled;
    for (const block of this.blocks.values()) this.request(block, { ...block.input, theme: this.theme, enabled: this.enabled });
  }
  update(node: ProjectedNode, revision: number): void {
    if (this.disposed) return;
    const element = this.renderer.getBlock(node.id);
    if (!element || this.renderer.isHeld(node.id)) return;
    const attributes = Array.isArray(node.blockAttributes) ? node.blockAttributes : [];
    const input: HighlightInput = { block: node.id, revision, source: node.runs.map(run => run.text).join(''),
      language: typeof attributes[1] === 'string' && attributes[1] ? attributes[1] : 'plain',
      grammar: HIGHLIGHT_BACKEND, query: 'scopes-v1', theme: this.theme, enabled: this.enabled };
    let block = this.blocks.get(node.id);
    if (block && block.element === element && !block.refresh && sameHighlightInput(block.input, input)) return;
    if (block) this.clear(block);
    block = { element, input, ranges: [] }; this.blocks.set(node.id, block); this.request(block, input);
  }
  private request(block: Block, input: HighlightInput): void {
    this.clear(block); block.input = input; block.refresh = true;
    if (this.renderer.isHeld(input.block)) return;
    block.element.dataset.codeLanguage = input.language;
    block.element.dataset.highlightState = this.registry ? 'loading' : 'unsupported-browser';
    block.refresh = false;
    if (this.registry) void this.scheduler.request(input);
  }
  private clear(block: Block): void {
    for (const { kind, range } of block.ranges) this.highlights.get(kind)?.delete(range);
    block.ranges = [];
  }
  private apply(result: HighlightResult): void {
    const block = this.blocks.get(result.input.block);
    if (this.disposed || !block || this.renderer.isHeld(result.input.block)
      || block.element !== this.renderer.getBlock(result.input.block) || !sameHighlightInput(block.input, result.input)
      || block.element.textContent !== result.input.source || !(validHighlightProjection(result.input, result) || (['timeout', 'queue-full'].includes(result.status) && result.spans.length === 0))) return;
    this.clear(block);
    const positions = this.renderer.positions(result.input.block);
    const point = (offset: number) => positions.find(p => p.node.nodeType === 3 && offset >= p.start && offset <= p.start + p.length);
    // Build every range before publishing any decoration. A broken mapping falls
    // back to the already visible source, never a partial recoloring.
    const ranges: Block['ranges'] = [];
    for (const span of result.spans) {
      const start = point(span.start), end = point(span.end);
      if (!start || !end) { block.element.dataset.highlightState = 'invalid-mapping'; return; }
      const range = block.element.ownerDocument.createRange();
      range.setStart(start.node, span.start - start.start); range.setEnd(end.node, span.end - end.start);
      const scopes = span.scopes.join(' ');
      const kind: Kind = scopes.includes('comment') ? 'comment' : scopes.includes('string') ? 'string'
        : /keyword|storage/.test(scopes) ? 'keyword' : scopes.includes('numeric') ? 'number' : 'other';
      ranges.push({ kind, range });
    }
    block.ranges = ranges;
    for (const { kind, range } of ranges) this.highlights.get(kind)?.add(range);
    block.element.dataset.highlightState = result.status;
  }
  hold(id: string): void { const block = this.blocks.get(id); if (block) { this.clear(block); block.refresh = true; this.scheduler.cancel(id); } }
  remove(id: string): void {
    const block = this.blocks.get(id); if (!block) return;
    this.clear(block); delete block.element.dataset.highlightState; delete block.element.dataset.codeLanguage;
    this.blocks.delete(id); this.scheduler.cancel(id);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.scheduler.dispose(); for (const id of this.blocks.keys()) this.remove(id);
    for (const name of this.names.values()) this.registry?.delete(name);
    this.highlights.clear(); this.style?.remove();
  }
}
