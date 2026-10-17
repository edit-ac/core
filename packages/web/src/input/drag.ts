import { dropPoint } from '../dom/drop-point.js';
import type { EngineHandle, PrepareRequest, CommitResult, StableRange, PatchSubscription } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection, ModelPoint } from '../dom/selection.js';
import { selectionFragment, FRAGMENT_MIME } from '../clipboard/fragment.js';
import { exportHTML } from '../clipboard/html.js';
import { errorMessage } from '../errors.js';

export interface TextTransferTarget {
  /** Explicit keyboard/menu alternative: the current collapsed selection is the destination. */
  dropAtSelection(copy?: boolean): boolean;
  dispose(): void;
}
interface Source { owner: TextDrag; target: RetainedSelection; raw: string; plain: string; nonce: string; native: boolean; invalid: boolean; regions: {source:string;start:number;end:number}[]; done: boolean }
// Engine object identity is the actual shared-session boundary. Equal document
// IDs in independent replicas never grant source deletion authority.
const active = new WeakMap<EngineHandle, Source>();
const views = new WeakMap<EngineHandle, Set<TextDrag>>();
let sequence = 0;

/** View-local drag state; the existing prepared fragment operation owns semantics. */
export class TextDrag {
  last: { disposition: 'idle' | 'committed' | 'handled' | 'rejected'; reason?: string } = {disposition:'idle'};
  #source: Source | undefined;
  #subscription: PatchSubscription;
  #guarded: string[] = [];
  #disposed = false;
  #hover: {key:string; allowed:boolean} | undefined;
  #listeners: [string, EventListener][] = [];
  constructor(readonly renderer: DOMRenderer, readonly selection: DOMSelection, readonly engine: EngineHandle,
    readonly commit: (r: PrepareRequest) => CommitResult, readonly blocked: () => boolean) {
    this.#subscription=engine.subscribe({type:'all'},patch=>{
      const source=this.#source;if(!source||source.done)return;
      for(const change of patch.touchedRanges)for(const r of source.regions)if(change.source===r.source &&
        (change.oldEnd>change.start ? change.start<r.end&&change.oldEnd>r.start : change.start>r.start&&change.start<r.end))source.invalid=true;
      if(!source.invalid)try{source.regions=this.#regions(source.target.range);}catch{source.invalid=true;}
    });
    let set=views.get(engine);if(!set)views.set(engine,set=new Set());set.add(this);
    for (const type of ['dragstart','dragover','dragend','dragleave','pointercancel','pointerdown']) {
      const listener: EventListener = e => {
        const node=e.target as Element;
        if (node.closest?.('input,textarea,select,button,[data-content-module]')) return;
        const editable=node.closest?.('[contenteditable]');
        if (editable && editable!==renderer.root) return;
        this.handle(e);
      };
      renderer.root.addEventListener(type,listener); this.#listeners.push([type,listener]);
    }
  }
  get capabilities() { return {sameSessionMove:true, crossDocumentMove:false, externalMove:false, externalCopy:true} as const; }
  get ownsMutations(): boolean { return this.#guarded.length > 0; }
  get state() { return {active:!!this.#source, guarded:this.#guarded.length, listeners:this.#listeners.length, indicator:this.renderer.root.dataset.textDropEffect}; }
  #finishEcho(): void { for (const id of this.#guarded.splice(0)) this.renderer.resume(id); }
  #guard(): void { this.#finishEcho(); this.#guarded=this.renderer.textBlockIds(); }
  #clearIndicator(): void { delete this.renderer.root.dataset.textDropEffect; }
  cancel(): void {
    const source=this.#source;
    if(source) {source.done=true;source.target.dispose();if(active.get(this.engine)===source){active.delete(this.engine);for(const view of views.get(this.engine)??[]){view.#clearIndicator();view.#hover=undefined;view.#finishEcho();}}}
    this.#finishEcho();
    this.#source=undefined; this.#hover=undefined; this.#clearIndicator();
  }
  capture(): TextTransferTarget | undefined {
    this.cancel(); this.#finishEcho();
    if(this.#disposed||this.blocked())return;
    const target=this.selection.retain(); if(!target)return;
    try {
      const value=selectionFragment(this.engine,target.range);if(!value){target.dispose();return;}
      const {raw}=value.encode();
      const source:Source={owner:this,target,raw,plain:value.plain,nonce:crypto.randomUUID(),native:false,invalid:false,regions:this.#regions(target.range),done:false};
      const previous=active.get(this.engine);previous?.owner.cancel();
      this.#source=source;active.set(this.engine,source);
      return {dropAtSelection:(copy=false)=>{
        const native=this.renderer.root.ownerDocument.getSelection();
        const view=[...(views.get(this.engine)??[])].find(v=>native?.focusNode&&v.renderer.root.contains(native.focusNode));
        const destination=view?.selection.retain();if(!destination||!view)return false;
        try{return view.#drop(source,destination.range,copy);}finally{destination.dispose();}
      },dispose:()=>{if(this.#source===source)this.cancel();}};
    }catch(error){target.dispose();this.last={disposition:'rejected',reason:errorMessage(error)};return;}
  }
  #regions(range:StableRange): {source:string;start:number;end:number}[] {
    const a=this.engine.resolve(range.anchor),b=this.engine.resolve(range.focus);
    if(a.type!=='position'||b.type!=='position')throw Error('drag-source');
    const nodes=this.engine.read().visible.filter(n=>n.kind==='block'),ai=nodes.findIndex(n=>n.id===a.node),bi=nodes.findIndex(n=>n.id===b.node);
    const forward=ai<bi||ai===bi&&a.offset<=b.offset;
    const [first,last,from,to]=forward?[ai,bi,a.offset,b.offset]:[bi,ai,b.offset,a.offset];
    const regions:{source:string;start:number;end:number}[]=[];
    for(let i=first;i<=last;i++) {let offset=0;for(const span of nodes[i]!.spans){const length=span.end-span.start,left=Math.max(i===first?from:0,offset),right=Math.min(i===last?to:Infinity,offset+length);if(left<right)regions.push({source:span.source,start:span.start+left-offset,end:span.start+right-offset});offset+=length;}}
    return regions;
  }
  #inside(source: Source, destination: StableRange): boolean {
    const nodes=this.engine.read().visible.filter(n=>n.kind==='block');
    const point=(a:StableRange['anchor'])=>{const p=this.engine.resolve(a);if(p.type!=='position')throw Error('drag-target');return [nodes.findIndex(n=>n.id===p.node),p.offset] as const;};
    const a=point(source.target.range.anchor),b=point(source.target.range.focus),d=point(destination.anchor),f=point(destination.focus);
    const cmp=(a:readonly number[],b:readonly number[])=>a[0]!-b[0]!||a[1]!-b[1]!;
    if(cmp(d,f)!==0)throw Error('drag-destination-not-collapsed');
    const [l,r]=cmp(a,b)<=0?[a,b]:[b,a];return cmp(l,d)<=0&&cmp(d,r)<=0;
  }
  #drop(source: Source, destination: StableRange, copy: boolean): boolean {
    try {
      if(this.#disposed||this.blocked()||source.owner.blocked()||source.owner.#disposed||source.done||!source.target.active)throw Error('drag-unavailable');
      const current=selectionFragment(this.engine,source.target.range)?.encode().raw;
      if(source.invalid||current!==source.raw)throw Error('drag-source-changed');
      if(this.#inside(source,destination)&&!copy){this.last={disposition:'handled'};return true;}
      const request:PrepareRequest={kind:'fragmentTransfer',origin:`text-drag:${++sequence}`,source:source.target.range,destination,copy};
      if(!this.engine.can(request))throw Error('drag-target');
      // Capability is advisory. The host final preparation can still reject;
      // no source deletion or DOM fallback occurs before that boundary.
      source.done=true;
      this.engine.history({type:'explicit'});
      let result:CommitResult;
      try { result=this.commit(request); } finally { this.engine.history({type:'boundary'}); }
      this.#finishEcho();
      if(result.selection)try{this.selection.restoreRange(result.selection);}finally{this.engine.releaseAnchor(result.selection.anchor);this.engine.releaseAnchor(result.selection.focus);}
      if(result.caret)this.engine.releaseAnchor(result.caret);
      this.renderer.root.focus();this.last={disposition:'committed'};return true;
    }catch(error){this.last={disposition:'rejected',reason:errorMessage(error)};return false;}
    finally { if(source.owner.#source===source)source.owner.cancel();this.#clearIndicator(); }
  }
  #point(e:DragEvent):ModelPoint|undefined {
    return dropPoint(this.renderer,this.selection,e);
  }
  /** Independent input may arrive without beforeinput. Release correlation
   * before TextInput drains its observer, retaining the newly authored DOM.
   * Echo guards never suspend rendering of subsequent remote patches. */
  beforeEvent(event:Event):void {
    if(event.type==='input'&&!['insertFromDrop','deleteByDrag'].includes((event as InputEvent).inputType))this.#guarded=[];
  }
  handle(event:Event):boolean {
    if(this.#disposed)return false;
    const e=event as DragEvent;
    if(event.type==='pointerdown'){this.#finishEcho();return false;}
    if(['paste','cut','copy'].includes(event.type) || (['beforeinput','input'].includes(event.type)&&!['insertFromDrop','deleteByDrag'].includes((event as InputEvent).inputType)))this.#finishEcho();
    if(event.type==='keydown') {this.#finishEcho();if((event as KeyboardEvent).key==='Escape'){active.get(this.engine)?.owner.cancel();this.cancel();}return false;}
    if(event.type==='compositionstart'){this.cancel();this.#finishEcho();return false;}
    // HTML drag initiation emits a trusted pointercancel after dragstart. Its
    // terminal owner is dragend; an explicit pointer gesture cancellation still cancels.
    if(event.type==='pointercancel' && event.isTrusted && this.#source?.native)return true;
    if(event.type==='dragend'||event.type==='pointercancel'){active.get(this.engine)?.owner.cancel();this.cancel();for(const view of views.get(this.engine)??[]){view.#finishEcho();view.#clearIndicator();}return true;}
    if(event.type==='dragleave'){this.#clearIndicator();return false;}
    if(event.type==='dragstart'){
      if(event.defaultPrevented||!e.dataTransfer||!this.capture()){event.preventDefault();return true;}
      try{const source=this.#source!;source.native=event.isTrusted;const fragment=JSON.parse(source.raw);e.dataTransfer.setData('application/x-edit-ac-drag-session',source.nonce);e.dataTransfer.setData(FRAGMENT_MIME,source.raw);e.dataTransfer.setData('text/plain',source.plain);e.dataTransfer.setData('text/html',exportHTML(fragment.blocks));e.dataTransfer.effectAllowed='copy';}
      catch(error){event.preventDefault();this.cancel();this.last={disposition:'rejected',reason:errorMessage(error)};}
      return true;
    }
    const source=active.get(this.engine);
    if(event.type==='dragover'&&source){
      const point=this.#point(e),copy=e.altKey||e.ctrlKey;
      let allowed=false;
      if(!this.blocked()&&!source.owner.blocked()&&point&&!source.done&&!source.invalid){
        const key=`${source.nonce}/${this.engine.read().revision}/${point.node}/${point.offset}/${copy}`;
        if(this.#hover?.key===key)allowed=this.#hover.allowed;
        else {
          const at=this.engine.anchor(point.node,point.offset,point.bias);
          try {const destination={anchor:at,focus:at};allowed=!copy&&this.#inside(source,destination)||this.engine.can({kind:'fragmentTransfer',origin:'text-drag:hover',source:source.target.range,destination,copy});}
          catch {allowed=false;}finally{this.engine.releaseAnchor(at);}
          this.#hover={key,allowed};
        }
      }
      // Native transfer is copy-only even for a local semantic move: only the
      // shared prepared command can remove source content. OS effects never do.
      if(allowed){event.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';this.renderer.root.dataset.textDropEffect=copy?'copy':'move';}
      else{if(e.dataTransfer)e.dataTransfer.dropEffect='none';this.#clearIndicator();}return true;
    }
    // A foreign document has no deletion authority. Negotiate only copy and
    // leave import/validation to the existing clipboard boundary.
    if(event.type==='dragover'&&!source){
      const point=this.#point(e);
      const available=!this.blocked()&&!!point&&!!e.dataTransfer&&
        e.dataTransfer.files.length===0&&Array.from(e.dataTransfer.types).some(t=>['text/plain','text/html',FRAGMENT_MIME].includes(t));
      if(available){event.preventDefault();e.dataTransfer!.dropEffect='copy';this.renderer.root.dataset.textDropEffect='copy';}
      else{if(e.dataTransfer)e.dataTransfer.dropEffect='none';this.#clearIndicator();}
      return true;
    }
    if(event.type==='drop'&&source){
      event.preventDefault();this.#guard();
      if(!event.cancelable || e.dataTransfer?.getData('application/x-edit-ac-drag-session')!==source.nonce){source.owner.cancel();this.last={disposition:'rejected',reason:!event.cancelable?'drop-not-cancelable':'drag-session-mismatch'};return true;}
      const p=this.#point(e);if(!p){source.owner.cancel();this.last={disposition:'rejected',reason:'drag-target'};return true;}
      const at=this.engine.anchor(p.node,p.offset,p.bias);
      try{this.#drop(source,{anchor:at,focus:at},e.altKey||e.ctrlKey);}finally{this.engine.releaseAnchor(at);this.#guard();}return true;
    }
    const type=(event as InputEvent).inputType;
    if((event.type==='beforeinput'||event.type==='input')&&['insertFromDrop','deleteByDrag'].includes(type)){
      if(source||this.ownsMutations){event.preventDefault();this.#guard();if(event.type==='input')this.#finishEcho();return true;}
      // A foreign drag acknowledgement cannot delete this session's selection.
      if(type==='deleteByDrag'){event.preventDefault();this.#guard();if(event.type==='input')this.#finishEcho();return true;}
    }
    return false;
  }
  dispose():void {if(this.#disposed)return;this.cancel();this.#finishEcho();this.#disposed=true;this.#subscription.dispose();views.get(this.engine)?.delete(this);for(const [type,l]of this.#listeners.splice(0))this.renderer.root.removeEventListener(type,l);}
}
