import type { RetainedSelection } from '../dom/selection.js';
import { touchTarget, touchPanel } from '../modules/touch-controls.js';
import { CODE_PAIRS, codeContext, commitCodeEdit, executeCodeCommand } from '@edit-ac/core/extensions';
import type { CodeAction, CodeEdit } from '@edit-ac/core/extensions';
import type { CommitResult, PatchSubscription } from '@edit-ac/core';
import type { DocumentSearchContext } from '../modules/search.js';
export interface CodeBinding { action: CodeAction; key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }
export interface CodeCommandsOptions { autoPair?: boolean; bindings?: readonly CodeBinding[] }
export type CodeCommandsFactory = (context: DocumentSearchContext) => CodeCommandsPresenter;
export function codeCommands(options: CodeCommandsOptions = {}): CodeCommandsFactory {
  const profile: CodeCommandsOptions = {...options, ...(options.bindings ? {bindings:options.bindings.map(b=>({...b}))} : {})};
  if ((profile.bindings?.length ?? 0) > 32 || profile.bindings?.some(b=>['Tab','Escape','Enter'].includes(b.key) || !(b.ctrl || b.meta || b.alt))) throw Error('Use at most 32 modified code bindings; native focus/commit keys are reserved');
  return context => new CodeCommandsPresenter(context,profile);
}
const actions: readonly [CodeAction,string][] = [['moveUp','Move code lines up'],['moveDown','Move code lines down'],['duplicate','Duplicate code lines'],['indent','Indent code lines'],['outdent','Outdent code lines'],['surround','Surround code selection'],['comment','Toggle code comments']];
/** Browser policy only. All text and history effects go through prepared semantics. */
export class CodeCommandsPresenter {
  readonly element: HTMLElement; readonly status: HTMLElement;
  // Capture the existing semantic anchors before a touch moves native focus.
  #target: RetainedSelection | undefined;
  #readOnly = false; #disposed = false; #direct: string | undefined;
  #pair: {owner: string; offset: number; open: string; close: string; revision: number} | undefined;
  readonly #subscription: PatchSubscription;
  readonly #listeners: [EventTarget,string,EventListener][] = [];
  constructor(readonly context: DocumentSearchContext, readonly options: CodeCommandsOptions) {
    const doc=context.root.ownerDocument;
    this.element=doc.createElement('div');this.element.contentEditable='false';this.element.dataset.codeCommands='';this.element.setAttribute('role','group');this.element.setAttribute('aria-label','Code editing commands');
    touchPanel(this.element);this.element.style.display='flex';this.element.style.flexWrap='wrap';this.element.style.gap='4px';
    for(const [action,label] of actions){const b=doc.createElement('button');b.type='button';b.textContent=label;touchTarget(b);
      this.#listen(b,'pointerdown',e=>{this.#target?.dispose();this.#target=undefined;if(this.#blocked()){e.preventDefault();return;}this.#target=context.selection.retain();if((e as PointerEvent).pointerType==='touch')b.focus({preventScroll:true});else e.preventDefault();});this.#listen(b,'pointercancel',()=>{this.#target?.dispose();this.#target=undefined;});this.#listen(b,'click',()=>this.execute(action));this.element.append(b);}
    this.status=doc.createElement('span');this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');this.element.append(this.status);context.root.after(this.element);
    this.#listen(context.root,'pointerdown',()=>{this.#pair=undefined;this.#direct=undefined;this.#target?.dispose();this.#target=undefined;});
    this.#subscription=context.engine.subscribe({type:'all'},patch=>{if(patch.update || patch.operation==='Remote'){this.#target?.dispose();this.#target=undefined;this.#pair=undefined;this.#direct=undefined;}});
  }
  #listen(target:EventTarget,type:string,fn:EventListener){target.addEventListener(type,fn);this.#listeners.push([target,type,fn]);}
  #blocked(){return this.#readOnly || this.#disposed || !!this.context.blocked?.();}
  #apply(result:CommitResult | undefined){if(!result)return;try{this.context.root.focus();if(result.selection)this.context.selection.restoreRange(result.selection);}finally{if(result.caret)this.context.engine.releaseAnchor(result.caret);if(result.selection){this.context.engine.releaseAnchor(result.selection.anchor);this.context.engine.releaseAnchor(result.selection.focus);}}}
  execute(action:CodeAction):boolean {
    if(this.#blocked()){this.#target?.dispose();this.#target=undefined;return false;}
    const retained=this.#target??this.context.selection.retain();this.#target=undefined;if(!retained){this.status.textContent='Select code first';return false;}
    try{const result=executeCodeCommand(this.context.engine,retained.range,action,r=>this.context.commit(r));if(result)this.#apply(result);else{this.context.root.focus();this.context.selection.restoreRange(retained.range);}this.status.textContent=result?'Code command applied':'Code boundary; unchanged';return true;}
    catch(error){this.status.textContent=error instanceof Error?error.message:'Code command unavailable';return false;}finally{retained.dispose();}
  }
  /** Only the input owner calls this after composition admission, before key dispatch. */
  handle(event:Event):boolean {
    const key=event as KeyboardEvent,input=event as InputEvent;
    if(['paste','cut','drop','compositionstart','compositionend','blur'].includes(event.type)){this.#direct=undefined;this.#pair=undefined;return false;}
    if(event.type==='keyup'){this.#direct=undefined;return false;}
    if(event.type==='keydown') {
      this.#direct=undefined;
      if(['Shift','Control','Meta','Alt'].includes(key.key))return false;
      if(this.#blocked() || key.isComposing || key.defaultPrevented || key.getModifierState('AltGraph') || ['Dead','Process'].includes(key.key))return false;
      const binding=this.options.bindings?.find(b=>key.key===b.key&&key.ctrlKey===!!b.ctrl&&key.metaKey===!!b.meta&&key.altKey===!!b.alt&&key.shiftKey===!!b.shift);
      if(binding){if(this.execute(binding.action)){event.preventDefault();return true;}return false;}
      if(key.ctrlKey || key.metaKey || key.altKey){this.#pair=undefined;return false;}
      if(this.options.autoPair && event.isTrusted && !key.ctrlKey&&!key.metaKey&&!key.altKey) {
        if(key.key==='Backspace' && this.#pair && this.#pairEdit(true)){event.preventDefault();return true;}
        if(key.key.length===1)this.#direct=key.key;
        else this.#pair=undefined;
      }
      return false;
    }
    if(event.type!=='beforeinput')return false;
    const direct=this.#direct;this.#direct=undefined;
    if(!this.options.autoPair || this.#blocked() || !event.isTrusted || !input.cancelable || input.isComposing || input.inputType!=='insertText' || !direct || direct!==input.data){this.#pair=undefined;return false;}
    if(this.#pair?.close===direct && this.#pairEdit(false)){event.preventDefault();return true;}
    const close=CODE_PAIRS[direct];if(!close){this.#pair=undefined;return false;}
    const retained=this.context.selection.retain();if(!retained)return false;
    try {
      const c=codeContext(this.context.engine,retained.range);
      // Pair only collapsed direct typing before whitespace/EOF/a closing delimiter.
      if(c.anchor!==c.focus || c.text[c.anchor] && !/[\s)\]}]/u.test(c.text[c.anchor]!))return false;
      const at=c.anchor,edit={text:c.text.slice(0,at)+direct+close+c.text.slice(at),anchor:at+1,focus:at+1};
      this.#apply(commitCodeEdit(this.context.engine,c,edit,'code:pair',r=>this.context.commit(r)));
      this.#pair={owner:c.owner,offset:at,open:direct,close,revision:this.context.engine.read().revision};event.preventDefault();return true;
    } catch {return false;}finally{retained.dispose();}
  }
  #pairEdit(backspace:boolean):boolean {
    const pair=this.#pair;this.#pair=undefined;if(!pair)return false;
    const retained=this.context.selection.retain();if(!retained)return false;
    try{const c=codeContext(this.context.engine,retained.range);
      if(c.owner!==pair.owner||c.revision!==pair.revision||c.anchor!==c.focus||c.anchor!==pair.offset+1||c.text.slice(pair.offset,pair.offset+2)!==pair.open+pair.close)return false;
      if(!backspace){
        // Overtype is transient navigation, never a storage/history transaction.
        this.context.root.focus();
        const placed=this.context.selection.place({node:c.owner,offset:c.anchor+1,bias:'right'});
        if(placed)this.context.selection.capture();
        return placed;
      }
      const edit:CodeEdit={text:c.text.slice(0,pair.offset)+c.text.slice(pair.offset+2),anchor:pair.offset,focus:pair.offset};
      this.#apply(commitCodeEdit(this.context.engine,c,edit,'code:pair-backspace',r=>this.context.commit(r)));return true;
    }catch{return false;}finally{retained.dispose();}
  }
  setReadOnly(value:boolean){this.#target?.dispose();this.#target=undefined;this.#readOnly=value;this.#pair=undefined;this.#direct=undefined;for(const b of this.element.querySelectorAll('button'))b.disabled=value;}
  dispose(){if(this.#disposed)return;this.#disposed=true;this.#target?.dispose();this.#target=undefined;this.#subscription.dispose();this.#pair=undefined;this.#direct=undefined;for(const [t,k,f]of this.#listeners)t.removeEventListener(k,f);this.element.remove();}
}
