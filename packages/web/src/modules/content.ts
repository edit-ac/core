import { decodeTableClipboard, encodeTableClipboard } from './tables/clipboard.js';
import type { EditorCommand, CommitResult, EngineHandle, Json, PrepareRequest, ProjectedNode } from '@edit-ac/core';

export interface ImageMetadata { url: string; alt: string; title: string; source: string }
export interface ContentOptions {
  /** Synchronous host asset policy. No URL is loaded when this port is absent. */
  imageUrl?: (metadata: Readonly<ImageMetadata>) => string | null;
  /** Host policy captured for each table action; coordinates are relative to the exact descriptor. */
  tableProtectedCells?: (node: ProjectedNode) => readonly (readonly [number, number])[];
}
export interface ContentContext { element: HTMLElement; node: ProjectedNode; engine: EngineHandle; commit: (request: PrepareRequest) => CommitResult; readOnly: boolean }
export interface ContentView { element: HTMLElement; update(node: ProjectedNode): boolean; setReadOnly(value: boolean): void; dispose(): void }
export type ContentFactory = (context: ContentContext) => ContentView | undefined;
type Run = [string, [string, ...string[]][]];
interface Table { alignments: string[]; rows: Run[][][]; source: string }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
function parse(node: ProjectedNode): ImageMetadata | Table | undefined {
  const t = node.blockAttributes;
  if (!Array.isArray(t) || t.length !== 3 || t[1] !== 1 || !object(t[2])) return;
  const d = t[2];
  if (t[0] === 'module:editac.image' && exact(d,['url','alt','title','source']) &&
      ['url','alt','title','source'].every(k => typeof d[k] === 'string') &&
      String(d.url).length <= 4096 && String(d.alt).length <= 8192 && String(d.title).length <= 8192 && new TextEncoder().encode(String(d.source)).length <= 1048576) return d as unknown as ImageMetadata;
  if (t[0] !== 'module:editac.table' || !exact(d,['alignments','rows','source']) || !Array.isArray(d.alignments) || !d.alignments.length || d.alignments.length > 32 ||
      !d.alignments.every(a=>['none','left','center','right'].includes(String(a))) || !Array.isArray(d.rows) || !d.rows.length || d.rows.length > 128 || typeof d.source !== 'string') return;
  let runs = 0, bytes = new TextEncoder().encode(d.source).length;
  for (const row of d.rows) {
    if (!Array.isArray(row) || row.length !== d.alignments.length) return;
    for (const cell of row) {
      if (!Array.isArray(cell)) return;
      for (const r of cell) {
        if (++runs > 1024 || !Array.isArray(r) || r.length !== 2 || typeof r[0] !== 'string' || /[\r\n]/u.test(r[0]) || !Array.isArray(r[1]) || r[1].length > 6) return;
        bytes += new TextEncoder().encode(r[0]).length;
        if (bytes > 2097152) return;
        for (const mark of r[1]) if (!Array.isArray(mark) || !['bold','italic','strike','underline','code','link'].includes(String(mark[0])) ||
          (mark[0] === 'link' ? mark.length !== 2 || !safeUrl(mark[1], true) : mark.length !== 1)) return;
      }
    }
  }
  if (new TextEncoder().encode(d.source).length > 1048576 || bytes-new TextEncoder().encode(d.source).length > 1048576) return;
  return d as unknown as Table;
}
function safeUrl(value: unknown, link = false): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return null;
  try { const url = new URL(value); return (link ? ['https:','http:','mailto:'] : ['https:','http:']).includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const cellText = (runs: Run[]) => runs.map(r=>r[0]).join('');
/** Optional source-preserving presenters. The host supplies assets; Rust owns edits. */
export function contentModules(options: ContentOptions = {}): ContentFactory {
  const imageUrl = options.imageUrl;
  if (imageUrl !== undefined && typeof imageUrl !== 'function') throw Error('Invalid image policy');
  return context => {
    const descriptor = parse(context.node);
    if (!descriptor) return;
    return new BasicContentView(context, descriptor, imageUrl, options.tableProtectedCells);
  };
}
class BasicContentView implements ContentView {
  readonly element: HTMLElement;
  private node: ProjectedNode;
  private readonly kind: 'image' | 'table';
  private readOnly: boolean;
  private disposed = false;
  private readonly controls: HTMLTextAreaElement[] = [];
  private readonly previews: HTMLElement[] = [];
  private readonly listeners: [EventTarget,string,EventListener][] = [];
  private readonly compositions = new Map<HTMLTextAreaElement, Json>();
  private readonly status: HTMLElement;
  private image: HTMLImageElement | undefined;
  private description: HTMLElement | undefined;
  private imageKey = '';
  private cells: { row: number; column: number; rows: number; columns: number; expected: Json } | undefined;
  private firstCell: { row: number; column: number } | undefined;
  private focusCell: { row: number; column: number } | undefined;
  private readonly cellButtons: HTMLButtonElement[] = [];
  private readonly actions: HTMLButtonElement[] = [];
  constructor(private readonly context: ContentContext, descriptor: ImageMetadata | Table, private readonly imageUrl: ContentOptions['imageUrl'], private readonly protectedCells: ContentOptions['tableProtectedCells']) {
    this.node=context.node; this.readOnly=context.readOnly; this.kind='url' in descriptor ? 'image' : 'table';
    const doc=context.element.ownerDocument; this.element=doc.createElement('section'); this.element.dataset.contentModule=this.kind; this.element.contentEditable='false';
    this.status=doc.createElement('span'); this.status.setAttribute('role','status'); this.status.setAttribute('aria-live','polite');
    if (this.kind === 'image') {
      this.image=doc.createElement('img'); this.description=doc.createElement('p'); this.element.append(this.image,this.description);
      const source=doc.createElement('textarea'); source.readOnly=true; source.setAttribute('aria-label','Image source'); this.controls.push(source); this.element.append(source);
    } else {
      this.element.tabIndex=0;
      this.element.setAttribute('aria-label','Table cell selection');
      const toolbar=doc.createElement('div'); toolbar.setAttribute('role','group'); toolbar.setAttribute('aria-label','Table structure'); this.element.append(toolbar);
      for(const [label,action,after] of [
        ['Insert row before','insertRow',false],['Insert row after','insertRow',true],['Remove rows','deleteRow',false],
        ['Insert column before','insertColumn',false],['Insert column after','insertColumn',true],['Remove columns','deleteColumn',false],
      ] as const){const button=doc.createElement('button');button.type='button';button.textContent=label;this.actions.push(button);toolbar.append(button);this.listen(button,'click',()=>this.structure(action,after));}
      this.listen(this.element,'keydown',event=>{
        const e=event as KeyboardEvent;if(e.target!==this.element||e.isComposing)return;
        if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(!this.readOnly)this.context.engine.history({type:e.shiftKey?'redo':'undo'});return;}
        if(!this.cells)return;
        if(this.navigateCells(e))return;
        if(e.key==='Escape'){e.preventDefault();this.leaveCells();return;}
        if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();this.rectangle(null);return;}
        if(e.key==='Enter'||(e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey)){
          e.preventDefault();const input=this.selectedInput();this.leaveCells();input?.focus();
          if(e.key!=='Enter'&&input&&!this.readOnly){input.value=e.key;this.edit(input);input.setSelectionRange(input.value.length,input.value.length);}
        }
      });
      for(const type of ['copy','cut','paste'])this.listen(this.element,type,event=>{
        const e=event as ClipboardEvent;if(e.target!==this.element||!this.cells||!e.clipboardData)return;
        e.preventDefault();if(type==='paste'){this.pasteCells(e.clipboardData);return;}
        const current=parse(this.node);if(!current||!('rows'in current))return;
        const {row,column,rows,columns}=this.cells;
        const matrix=current.rows.slice(row,row+rows).map(r=>r.slice(column,column+columns).map(cellText));
        try{for(const [type,value] of Object.entries(encodeTableClipboard(doc,matrix)))e.clipboardData.setData(type,value);}
        catch{this.status.textContent='Cell clipboard exceeds the literal profile; current data preserved.';return;}
        this.status.textContent='Literal cells copied; formatting is not included.';
        if(type==='cut')this.rectangle(null);
      });
      const table=doc.createElement('table'); table.setAttribute('aria-label','Simple table'); const body=doc.createElement('tbody'); table.append(body); this.element.append(table);
      const selectionControls=doc.createElement('div');selectionControls.setAttribute('role','group');selectionControls.setAttribute('aria-label','Select table cells');this.element.append(selectionControls);
      const data=descriptor as Table;
      data.rows.forEach((row,r)=>{const tr=doc.createElement('tr'); body.append(tr); row.forEach((_,c)=>{
        const td=doc.createElement(r===0?'th':'td'); if(r===0)td.setAttribute('scope','col'); td.style.textAlign=data.alignments[c]==='none'?'':data.alignments[c]!; tr.append(td);
        const select=doc.createElement('button');select.type='button';select.textContent=`Select row ${r+1} column ${c+1}`;select.setAttribute('aria-label',`Select cell row ${r+1} column ${c+1}`);select.setAttribute('aria-pressed','false');this.cellButtons.push(select);selectionControls.append(select);
        this.listen(select,'click',event=>this.selectCells(r,c,(event as MouseEvent).shiftKey));
        const preview=doc.createElement('div'); this.previews.push(preview); td.append(preview);
        const input=doc.createElement('textarea'); input.rows=1; input.setAttribute('aria-label',`Table row ${r+1} column ${c+1}`); input.dataset.row=String(r); input.dataset.column=String(c); this.controls.push(input); td.append(input);
        this.listen(input,'focus',()=>this.leaveCells());
        this.listen(input,'compositionstart',()=>{this.compositions.set(input,this.node.blockAttributes);});
        this.listen(input,'compositionend',()=>{const expected=this.compositions.get(input);this.compositions.delete(input);this.edit(input,expected);});
        this.listen(input,'input',event=>{if(!(event as InputEvent).isComposing&&!this.compositions.has(input))this.edit(input);});
        this.listen(input,'keydown',event=>{const e=event as KeyboardEvent;if(e.isComposing||this.compositions.has(input))return;
          if(e.altKey&&!e.ctrlKey&&!e.metaKey&&e.key==='Enter'){e.preventDefault();this.selectCells(r,c,false);return;}
          if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(!this.readOnly){context.engine.history({type:e.shiftKey?'redo':'undo'});} }
        });
      });});
    }
    for (const input of this.controls) this.listen(input,'copy',event=>{const e=event as ClipboardEvent;if(e.clipboardData){e.clipboardData.setData('text/plain',input.value.slice(input.selectionStart,input.selectionEnd));e.preventDefault();}});
    // Native controls own temporary text, selection, composition and clipboard.
    for (const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','copy','cut','paste','pointerdown','pointermove','pointerup','pointercancel','dragstart','dragover','drop','dragend']) this.listen(this.element,type,event=>event.stopPropagation());
    this.element.append(this.status); this.update(context.node);
  }
  private listen(target: EventTarget,type: string,listener: EventListener): void {target.addEventListener(type,listener);this.listeners.push([target,type,listener]);}
  update(node: ProjectedNode): boolean {
    if(this.disposed)return false;
    const data=parse(node);if(!data||('url' in data)!==(this.kind==='image'))return false;
    if('rows' in data&&(data.rows.length*(data.alignments.length)!==this.controls.length||data.alignments.length!==Number(this.controls.at(-1)?.dataset.column)+1))return false;
    if(this.cells&&JSON.stringify(this.cells.expected)!==JSON.stringify(node.blockAttributes))this.leaveCells();
    this.node=node;
    if('url' in data){
      this.image!.alt=data.alt; this.image!.title=data.title; this.description!.textContent=data.alt;
      if(this.controls[0]!.value!==data.source)this.controls[0]!.value=data.source;
      const key=JSON.stringify(data);if(key!==this.imageKey){this.imageKey=key;let url:string|null=null;try{url=safeUrl(this.imageUrl?.(Object.freeze({...data})));}catch{this.status.textContent='Image policy failed; source preserved.';}
        if(url){this.image!.src=url;this.image!.hidden=false;}else{this.image!.removeAttribute('src');this.image!.hidden=true;}}
    }else data.rows.forEach((row,r)=>row.forEach((runs,c)=>{
      const at=r*data.alignments.length+c,input=this.controls[at]!,preview=this.previews[at]!;
      const value=cellText(runs); if(!this.compositions.has(input)&&input.value!==value){const start=input.selectionStart,end=input.selectionEnd;input.value=value;input.setSelectionRange(Math.min(start,value.length),Math.min(end,value.length));}
      preview.replaceChildren();for(const [text,marks] of runs){let target:HTMLElement=preview;for(const [mark,href] of marks){const tag={bold:'strong',italic:'em',strike:'s',underline:'u',code:'code',link:'a'}[mark];if(!tag)continue;const el=preview.ownerDocument.createElement(tag);if(mark==='link'&&safeUrl(href, true)){(el as HTMLAnchorElement).href=href!;(el as HTMLAnchorElement).rel='noopener noreferrer';}target.append(el);target=el;}target.append(preview.ownerDocument.createTextNode(text));}
    }));
    this.setReadOnly(this.readOnly);return true;
  }
  private policy(): readonly (readonly [number,number])[] { return this.protectedCells?.(this.node) ?? []; }
  private selectedInput(): HTMLTextAreaElement | undefined {return this.controls.find(i=>Number(i.dataset.row)===this.cells?.row&&Number(i.dataset.column)===this.cells?.column);}
  private selectCells(row:number,column:number,extend:boolean):void {
    if(this.disposed||this.compositions.size)return;
    const data=parse(this.node);if(!data||!('rows'in data)||!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=data.rows.length||column>=data.alignments.length)return;
    const first=extend&&this.firstCell?this.firstCell:{row,column};
    const rows=Math.abs(first.row-row)+1,columns=Math.abs(first.column-column)+1;
    if(rows*columns>128){this.status.textContent='Selection limit is 128 cells; current selection preserved.';return;}
    this.firstCell=first;this.focusCell={row,column};
    this.cells={row:Math.min(first.row,row),column:Math.min(first.column,column),rows,columns,expected:this.node.blockAttributes};
    this.paintCells();this.element.focus();this.status.textContent=`${rows} rows by ${columns} columns selected. Arrows move; Shift extends; Enter edits; Tab uses native focus order. Delete clears contents; use Remove rows or columns to change structure.`;
  }
  private navigateCells(event:KeyboardEvent):boolean {
    const data=parse(this.node),focus=this.focusCell;
    if(!focus||!data||!('rows'in data)||event.altKey||event.metaKey)return false;
    let {row,column}=focus;
    switch(event.key){
      case 'ArrowLeft':if(event.ctrlKey)return false;column--;break;
      case 'ArrowRight':if(event.ctrlKey)return false;column++;break;
      case 'ArrowUp':if(event.ctrlKey)return false;row--;break;
      case 'ArrowDown':if(event.ctrlKey)return false;row++;break;
      case 'Home':column=0;if(event.ctrlKey)row=0;break;
      case 'End':column=data.alignments.length-1;if(event.ctrlKey)row=data.rows.length-1;break;
      default:return false;
    }
    event.preventDefault();
    row=Math.max(0,Math.min(row,data.rows.length-1));column=Math.max(0,Math.min(column,data.alignments.length-1));
    if(row===focus.row&&column===focus.column){this.status.textContent='Table edge; no row or column added. Tab uses native focus order.';return true;}
    this.selectCells(row,column,event.shiftKey);return true;
  }
  private paintCells():void {if(this.kind!=='table')return;const s=this.cells;for(let at=0;at<this.controls.length;at++){const input=this.controls[at]!,r=Number(input.dataset.row),c=Number(input.dataset.column);const selected=!!s&&r>=s.row&&r<s.row+s.rows&&c>=s.column&&c<s.column+s.columns;this.cellButtons[at]!.setAttribute('aria-pressed',String(selected));const td=input.closest('td,th') as HTMLElement;td.toggleAttribute('data-cell-selected',selected);td.style.outline=selected?'2px solid Highlight':'';}for(const button of this.actions)button.disabled=this.readOnly||!s;}
  private leaveCells():void {this.cells=undefined;this.firstCell=undefined;this.focusCell=undefined;this.paintCells();}
  private commitTable(command:EditorCommand):boolean {
    if(this.readOnly||this.disposed)return false;
    try{this.context.engine.history({type:'explicit'});const result=this.context.commit({kind:'editor',origin:'module-table-command',commands:[command]});if(result.caret)this.context.engine.releaseAnchor(result.caret);this.status.textContent='Table updated.';return true;}
    catch{this.status.textContent='Table action rejected; current data preserved.';return false;}
  }
  private rectangle(cells:readonly (readonly string[])[]|null):void {
    const s=this.cells;if(!s)return;
    try{this.commitTable({type:'tableRectangle',owner:this.node.id,...s,cells,protected:this.policy()});}
    catch{this.status.textContent='Table policy rejected; current data preserved.';}
  }
  private structure(action:'insertRow'|'deleteRow'|'insertColumn'|'deleteColumn',after:boolean):void {
    const s=this.cells;if(!s)return;
    // Multi-row/column removal is explicit and atomic; the source descriptor
    // for each stage belongs to Rust, so this UI currently admits one axis item.
    if((action==='deleteRow'&&s.rows!==1)||(action==='deleteColumn'&&s.columns!==1)){this.status.textContent='Select one row or column for structural removal.';return;}
    try{if(this.policy().length){this.status.textContent='Protected table structure cannot change.';return;}}
    catch{this.status.textContent='Table policy rejected; current data preserved.';return;}
    const row=action.endsWith('Row'),index=(row?s.row:s.column)+(after?(row?s.rows:s.columns):0);
    this.commitTable({type:'tableStructure',owner:this.node.id,expected:s.expected,action,index});
  }
  private pasteCells(data:DataTransfer):void {
    try{this.rectangle(decodeTableClipboard(this.element.ownerDocument,data));}
    catch{this.status.textContent='Unsupported table clipboard; dimensions and simple unmerged literal cells are required.';}
  }
  private edit(input: HTMLTextAreaElement, expected: Json = this.node.blockAttributes): void {
    if(this.disposed)return;
    if(this.readOnly){const data=parse(this.node);if(data&&'rows' in data)input.value=cellText(data.rows[Number(input.dataset.row)]![Number(input.dataset.column)]!);return;}
    const node=this.context.engine.read().visible.find(n=>n.id===this.node.id),data=node&&parse(node);
    if(data&&'rows' in data&&JSON.stringify(expected)===JSON.stringify(node!.blockAttributes)&&cellText(data.rows[Number(input.dataset.row)]![Number(input.dataset.column)]!)===input.value)return;
    try{
      if(this.policy().some(([r,c])=>r===Number(input.dataset.row)&&c===Number(input.dataset.column)))throw Error('Protected cell');
      this.context.engine.history({type:'explicit'});
      const result=this.context.commit({kind:'editor',origin:'module-table-cell',commands:[{type:'tableCell',owner:this.node.id,expected,row:Number(input.dataset.row),column:Number(input.dataset.column),text:input.value}]});
      if(result.caret)this.context.engine.releaseAnchor(result.caret);this.status.textContent='Cell updated.';
    }catch{this.status.textContent='Cell edit rejected; current data preserved.';if(node)this.update(node);}
  }
  setReadOnly(value: boolean): void {this.readOnly=value;if(value){this.compositions.clear();const data=parse(this.node);if(data&&'rows' in data)for(const input of this.controls)input.value=cellText(data.rows[Number(input.dataset.row)]![Number(input.dataset.column)]!);}for(const input of this.controls)input.readOnly=value||this.kind==='image';this.paintCells();}
  dispose(): void {if(this.disposed)return;this.disposed=true;for(const [target,type,listener]of this.listeners)target.removeEventListener(type,listener);this.compositions.clear();for(const input of this.controls)input.readOnly=true;this.image?.removeAttribute('src');}
}
