import { prepareReview, reviewLimits } from './model.js';
import type { ReviewInput, ReviewLayout, ReviewMode, ReviewModel, ReviewLimits } from './model.js';
export interface ReviewSelection { beforeHash: string; afterHash: string; representation: 'exact-source' | 'projected-markdown'; hunkIndexes: number[] }
export interface ChangeReviewOptions {
  mode?: ReviewMode; layout?: ReviewLayout; limits?: Partial<ReviewLimits>;
  /** Requests review admission; the host must use revision-checked session application. */
  onAccept?: (selection: ReviewSelection) => void;
}
interface Row { label: string; before: string; after: string; kind: string; hunk?: number }
const facetLabels: Record<string, string> = { Insert:'Insertion', Delete:'Deletion', Placement:'Move / placement', Text:'Content', Formatting:'Formatting / marks', References:'Link targets / references', UnknownModule:'Opaque / unknown module', Attributes:'Attributes', Table:'Table structure', Sources:'Source identities', Visibility:'Visibility', Kind:'Block kind' };
const facetFields: Record<string, string[]> = { Placement:['parent','order'], Text:['runs'], Formatting:['runs','editor'], References:['runs','attributes','opaque'], Attributes:['attributes'], UnknownModule:['opaque','runs'], Table:['opaque','attributes'], Sources:['spans'], Visibility:['visible'], Kind:['kind'] };
function facetValue(node: unknown, facet: string): string {
  if (node === null || node === undefined) return '(absent)';
  const fields = facetFields[facet];
  if (!fields) return JSON.stringify(node);
  const value = node as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(fields.filter(f => f in value).map(f => [f, value[f]])));
}
/** Optional DOM presenter. No engine, typing observer, history checkout or transport mutation. */
export class ChangeReview {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly limits: ReviewLimits;
  private readonly onAccept: ChangeReviewOptions['onAccept'];
  private model: ReviewModel;
  private mode: ReviewMode;
  private layout: ReviewLayout;
  private whitespace = false;
  private page = 0;
  private selected = new Set<number>();
  private rows: Row[] = [];
  private destroyed = false;
  constructor(host: HTMLElement, input: ReviewInput, options: ChangeReviewOptions = {}) {
    this.host = host; this.limits = reviewLimits(options.limits);
    this.model = prepareReview(input, this.limits);
    this.mode = options.mode ?? 'readonly'; this.layout = options.layout ?? 'unified';
    this.validateMode(); this.onAccept = options.onAccept;
    this.root = host.ownerDocument.createElement('section');
    this.root.style.overflowWrap='anywhere'; this.root.style.minWidth='0'; this.root.style.fontFamily='system-ui, sans-serif'; this.root.style.lineHeight='1.5';
    this.root.setAttribute('aria-label', 'Change review'); this.root.className = 'editac-change-review';
    host.append(this.root); this.rebuild();
  }
  private validateMode(): void {
    if (!['writable','readonly','history'].includes(this.mode) || !['unified','inline','side-by-side'].includes(this.layout)) throw Error('Invalid review mode or layout');
  }
  update(input: ReviewInput): void {
    if (this.destroyed) throw Error('Review disposed');
    const next = prepareReview(input, this.limits);
    if (next.key !== this.model.key || JSON.stringify(next.hunks) !== JSON.stringify(this.model.hunks)) { this.selected.clear(); this.page = 0; }
    this.model = next; this.rebuild();
  }
  setMode(mode: ReviewMode): void {
    if (!['writable','readonly','history'].includes(mode)) throw Error('Invalid review mode');
    this.mode = mode; if (mode !== 'writable') this.selected.clear(); this.render();
  }
  destroy(): void { this.destroyed = true; this.selected.clear(); this.rows = []; this.root.remove(); }
  private rebuild(): void {
    this.rows = this.model.representation === 'semantic' ? this.model.changes.flatMap(c => c.facets.map(f => ({ label: `${c.id}: ${facetLabels[f] ?? f}`, before: facetValue(c.before, f), after: facetValue(c.after, f), kind: f }))) : this.model.hunks.flatMap((h, hi) => {
      let oldLine = h.oldStart, newLine = h.newStart;
      return h.lines.map(l => {
        const label = `Hunk ${hi + 1}, ${l.kind === 'Context' ? 'Context' : l.kind === 'Delete' ? 'Removed' : 'Added'}; before ${l.kind === 'Insert' ? '—' : oldLine++}, after ${l.kind === 'Delete' ? '—' : newLine++}`;
        return { label, before: l.kind === 'Insert' ? '' : l.text, after: l.kind === 'Delete' ? '' : l.text, kind: l.kind, hunk: hi };
      });
    });
    if (this.model.retainedStructure !== null && this.model.retainedStructure !== undefined) {
      const pair = this.model.retainedStructure as unknown[];
      this.rows.push({ label:'Retained document structure', kind:'Structure', before:JSON.stringify(pair[0]), after:JSON.stringify(pair[1]) });
    }
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.rows.length / this.limits.pageSize) - 1));
    this.render();
  }
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const element = this.host.ownerDocument.createElement(tag); if (text !== undefined) element.textContent = text.length > this.limits.maxValueChars ? text.slice(0, this.limits.maxValueChars) + ' [Label truncated]' : text; return element;
  }
  private button(text: string, key: string, action: () => void): HTMLButtonElement {
    const button = this.el('button', text); button.type = 'button'; button.dataset.key = key;
    button.addEventListener('click', action); return button;
  }
  private value(text: string): HTMLElement {
    const box = this.el('span'); box.style.whiteSpace = 'pre-wrap'; box.style.overflowWrap = 'anywhere';
    // Clip before adding whitespace markers, retaining an honest visible limit notice.
    let clipped = text.slice(0, this.limits.maxValueChars);
    if (this.whitespace) clipped = clipped.replaceAll(' ', '·').replaceAll('\t', '⇥').replaceAll('\r', '␍').replaceAll('\n', '␊\n');
    box.append(this.el('span', clipped));
    if (text.length > this.limits.maxValueChars) box.append(this.el('strong', ` [Display truncated: ${text.length} UTF-16 units; limit ${this.limits.maxValueChars}]`));
    if (text && !text.endsWith('\n') && this.model.representation !== 'semantic') box.append(this.el('em',' [No final newline]'));
    return box;
  }
  private render(): void {
    if (this.destroyed) return;
    const focusKey = (this.host.ownerDocument.activeElement as HTMLElement | null)?.dataset.key;
    this.root.replaceChildren(); this.root.dataset.layout = this.layout; this.root.dataset.mode = this.mode;
    this.root.append(this.el('h2', this.model.label), this.el('p',this.model.explanation), this.el('p', `${this.mode === 'history' ? 'Readonly historical' : this.mode === 'readonly' ? 'Readonly current' : 'Writable live'} review. Attribution: ${this.model.attribution}.`), this.el('p',`Before SHA-256: ${this.model.beforeHash}; after SHA-256: ${this.model.afterHash}`));
    const toolbar = this.el('div'); toolbar.style.display='flex';toolbar.style.flexWrap='wrap';toolbar.style.gap='0.5rem';toolbar.setAttribute('role','group'); toolbar.setAttribute('aria-label','Review display controls');
    for (const layout of ['unified','inline','side-by-side'] as const) {
      const button = this.button(`${layout} view`,layout,()=>{this.layout=layout;this.render();}); button.setAttribute('aria-pressed',String(this.layout===layout)); toolbar.append(button);
    }
    const whitespace = this.button('Show whitespace','whitespace',()=>{this.whitespace=!this.whitespace;this.render();}); whitespace.setAttribute('aria-pressed',String(this.whitespace)); toolbar.append(whitespace); this.root.append(toolbar);
    const pages = Math.max(1,Math.ceil(this.rows.length / this.limits.pageSize));
    const status = this.el('p',`Page ${this.page+1} of ${pages}; ${this.rows.length} difference rows. At most ${this.limits.pageSize} rows displayed; values limited to ${this.limits.maxValueChars} UTF-16 units.`); status.setAttribute('role','status'); this.root.append(status);
    const prev = this.button('Previous page','prev',()=>{this.page--;this.render();}); prev.disabled=this.page===0;
    const next = this.button('Next page','next',()=>{this.page++;this.render();}); next.disabled=this.page+1>=pages; this.root.append(prev,next);
    const visible = this.rows.slice(this.page*this.limits.pageSize,(this.page+1)*this.limits.pageSize);
    if (this.mode === 'writable' && this.onAccept && this.model.representation !== 'semantic') {
      const controls=this.el('fieldset'); controls.append(this.el('legend','Select source hunks for revision-checked acceptance'));
      for (const index of new Set(visible.flatMap(row=>row.hunk===undefined?[]:[row.hunk]))) {
        const label=this.el('label'), checkbox=this.el('input'); checkbox.type='checkbox'; checkbox.dataset.key=`hunk-${index}`; checkbox.checked=this.selected.has(index);
        checkbox.addEventListener('change',()=>{if(checkbox.checked)this.selected.add(index);else this.selected.delete(index);this.render();});
        label.append(checkbox,`Select hunk ${index+1}`); controls.append(label);
      }
      const accept=this.button('Accept selected hunks','accept',()=>{
        if(this.mode!=='writable'||!this.onAccept||this.model.representation==='semantic'||!this.selected.size)return;
        this.onAccept({beforeHash:this.model.beforeHash,afterHash:this.model.afterHash,representation:this.model.representation,hunkIndexes:[...this.selected].sort((a,b)=>a-b)});
      }); accept.disabled=this.selected.size===0; controls.append(accept,this.el('p',`${this.selected.size} hunks selected. Host revalidation is required.`)); this.root.append(controls);
    }
    if (!visible.length) this.root.append(this.el('p','No differences in this representation.'));
    const table=this.el('table'); table.style.width='100%'; table.style.tableLayout='fixed'; table.style.borderCollapse='collapse'; table.style.overflowWrap='anywhere'; table.append(this.el('caption',`${this.model.label}: ${this.layout} view`));
    const head=this.el('thead'), header=this.el('tr');
    for(const label of this.layout==='side-by-side'?['Change','Before','After']:['Change','Difference']) {const th=this.el('th',label);th.scope='col';if(label==='Change')th.style.width=this.layout==='side-by-side'?'25%':'30%';header.append(th);} head.append(header);table.append(head);
    const body=this.el('tbody');
    for(const row of visible) {
      const tr=this.el('tr'); tr.dataset.kind=row.kind;
      const label=this.el('th',row.label);label.scope='row';label.style.textAlign='left';label.style.verticalAlign='top';tr.style.borderBottom='1px solid';tr.append(label);
      if(this.layout==='side-by-side') for(const [side,text] of [['Before',row.before],['After',row.after]]) {const td=this.el('td');td.setAttribute('aria-label',`${row.label}; ${side}`);td.append(this.value(text!));tr.append(td);}
      else {
        const td=this.el('td');
        if(row.kind==='Context') td.append(this.el('span','Context: '),this.value(row.before));
        else {
          if(row.before) { const line=this.el('div'), before=this.el(this.layout==='inline'?'del':'span');before.append(this.value(row.before));line.append(this.el('span','Before / removed: '),before);td.append(line); }
          if(row.after) { const line=this.el('div'), after=this.el(this.layout==='inline'?'ins':'span');after.append(this.value(row.after));line.append(this.el('span','After / added: '),after);td.append(line); }
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);this.root.append(table);
    if(focusKey) for(const element of this.root.querySelectorAll<HTMLElement>('[data-key]')) if(element.dataset.key===focusKey){element.focus();break;}
  }
}
