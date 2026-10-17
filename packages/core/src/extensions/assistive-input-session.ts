import type { CommitResult, EngineHandle, Patch, PrepareRequest, StableRange } from '../engine.js';
import { AssistiveError, type AssistiveRegistration, type AssistiveOutcome, type AssistivePresenterStatus, type AssistiveSessionIdentity, type AssistiveTransport, type AssistiveTransportEvent, type AssistiveTransportSession } from './assistive-input.js';

let nextSession = 0;
const admitted = new WeakMap<AssistiveRegistration, Set<AssistiveInputSession>>();

export interface AssistiveSessionTarget {
  valid(): boolean;
  accept(text: string): void;
  dispose(): void;
}
/** One explicitly requested, final-result session. No provider construction or OS
 * event ownership. Hosts invalidate on input-route, document and permission changes. */
export class AssistiveInputSession {
  #generation = 0;
  readonly #sessionId = `assistive:${++nextSession}`;
  #identity: AssistiveSessionIdentity | null = null;
  #status: AssistivePresenterStatus = {version:1,state:'idle',session:null,reason:null,message:'Assistance ready.',provisional:''};
  #controller: AbortController | undefined;
  #handle: AssistiveTransportSession | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #target: AssistiveSessionTarget | undefined;
  #sequence = -1;
  #recovery = '';
  #disposed = false;
  #accepting = false;
  #finishing = false;
  readonly #abort = () => this.dispose();
  constructor(readonly registration: AssistiveRegistration, readonly transport: AssistiveTransport,
    readonly changed: (status: Readonly<AssistivePresenterStatus>) => void = () => {}) {
    registration.signal.addEventListener('abort', this.#abort, {once:true});
  }
  get status(): Readonly<AssistivePresenterStatus> { return this.#status; }
  get active(): boolean { return !this.#disposed && ['starting','active','preparing'].includes(this.#status.state); }
  #publish(state: AssistivePresenterStatus['state'], reason: AssistiveOutcome | null = null, provisional = '', notify = true): void {
    const message = state === 'failed' ? `Assistance unavailable: ${reason}.` : `Assistance ${state}.`;
    const cap = this.registration.descriptor?.limits.statusBytes ?? 0;
    let bounded = ''; for (const c of message) { if (new TextEncoder().encode(bounded+c).length > cap) break; bounded += c; }
    this.#status = Object.freeze({version:1,state,session:this.#identity,reason,message:bounded,provisional});
    // An optional presentation observer must never change a committed outcome.
    try { if(notify)this.changed(this.#status); } catch { /* detached presenter */ }
  }
  #release(): void {
    admitted.get(this.registration)?.delete(this);
    const controller=this.#controller, handle=this.#handle, target=this.#target;
    this.#controller=undefined;this.#handle=undefined;this.#target=undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer=undefined;
    // Acceptance is revoked by the caller before any reentrant host cleanup.
    controller?.abort();
    for (const cleanup of [() => handle?.cancel(), () => handle?.dispose(), () => target?.dispose()]) {
      try { cleanup(); } catch { /* release all resources even if the host fails */ }
    }
  }
  #end(state: AssistivePresenterStatus['state'], reason: AssistiveOutcome | null = null): void {
    this.#finishing=true;this.#publish(state,reason,'',false);this.#release();this.#finishing=false;
    try {this.changed(this.#status);}catch{/* detached presenter */}
  }
  start(target: AssistiveSessionTarget): void {
    if (this.#accepting || this.#finishing) { target.dispose();return; }
    if (this.#disposed || !this.registration.supports('host-transport')) { target.dispose(); if (!this.#disposed) this.#publish('failed','unsupported'); return; }
    if (this.active) {target.dispose();return;} // explicit cancellation before a new generation
    const live=admitted.get(this.registration) ?? new Set<AssistiveInputSession>();
    if (live.size>=this.registration.descriptor!.limits.sessions || this.#generation>=0xffff_ffff) {target.dispose();this.#publish('failed','unavailable');return;}
    live.add(this);admitted.set(this.registration,live);
    this.#recovery='';this.#sequence=-1;
    this.#identity=Object.freeze({sessionId:this.#sessionId,generation:++this.#generation});
    this.#target=target;
    if (!target.valid()) { this.#end('stale','stale');return; }
    const controller=new AbortController(); this.#controller=controller;
    this.#publish('starting');
    if(!this.active || this.#controller!==controller)return;
    const identity=this.#identity;
    this.#timer=setTimeout(() => { if (this.active && this.#identity===identity) this.#end('failed','timeout'); },this.registration.descriptor!.limits.timeoutMs);
    try {
      const request=this.registration.validateStart({version:1,session:identity});
      const handle=this.transport.start(request,controller.signal,event => this.#receive(event,identity));
      // start is allowed to emit synchronously, including a terminal result.
      if (!this.active || this.#identity!==identity || controller.signal.aborted) { try { handle.cancel(); } finally { handle.dispose(); } }
      else { this.#handle=handle;this.#publish('active'); }
    } catch { if (this.active && this.#identity===identity) this.#end('failed','disconnected'); }
  }
  #receive(event: AssistiveTransportEvent, identity: AssistiveSessionIdentity): void {
    if (this.#accepting || !this.active || this.#identity!==identity || this.#controller?.signal.aborted) return;
    try {
      if (event.type==='error') {
        if (event.session.sessionId!==identity.sessionId || event.session.generation!==identity.generation) return;
        // Reuse the typed outcome validator before changing state.
        this.registration.validateStatus({version:1,state:'failed',session:identity,reason:event.reason,message:'',provisional:''});
        this.#end('failed',event.reason); return;
      }
      if (event.type!=='result') throw new Error('malformed');
      const r=this.registration.validateResult(event.result);
      if (r.session.sessionId!==identity.sessionId || r.session.generation!==identity.generation || r.sequence<=this.#sequence) return;
      this.#sequence=r.sequence;
      if (!this.#target?.valid()) { this.#recovery=r.text;this.#end('stale','stale');return; }
      if (r.kind==='provisional') { this.#publish('active',null,r.text); return; }
      const target=this.#target;this.#accepting=true;this.#publish('preparing');
      if(!this.active || this.#identity!==identity){this.#accepting=false;return;}
      // Reentrant callbacks cannot accept again, even if storage fails after commit.
      try { target.accept(r.text);this.#publish('completed'); }
      catch { this.#recovery=r.text;this.#publish('stale','stale'); }
      finally { this.#release();this.#accepting=false; }
    } catch (error) { this.#end('failed',error instanceof AssistiveError && error.code==='limits' ? 'oversized':'malformed'); }
  }
  stop(): void {
    if (!this.active) return;
    if (!this.registration.descriptor?.transport?.canStop) { this.#end('failed','unsupported');return; }
    try { this.#handle?.stop(); } catch { this.#end('failed','disconnected'); }
  }
  cancel(): void { if (this.active) this.#end('cancelled','canceled'); }
  invalidate(reason: AssistiveOutcome = 'stale'): void { if (this.active) this.#end('stale',reason); }
  /** Explicit user recovery only; never automatically applies to a new selection. */
  recoveryText(): string { return this.#recovery; }
  reset(): void { if (!this.#disposed && !this.active) { this.#recovery='';this.#publish('idle'); } }
  dispose(): void { if (this.#disposed) return; this.#disposed=true;this.#end('cancelled','canceled');this.#recovery='';this.registration.signal.removeEventListener('abort',this.#abort); }
}

/** Stable engine anchors with the existing prepared replacement/history commands.
 * The commit port MUST be the captured engine's production Session storage port. */
export function captureAssistiveTarget(engine: EngineHandle, range: StableRange,
  commit: (request: PrepareRequest) => CommitResult, writable: () => boolean,
  applied: (result: CommitResult) => void = () => {}): AssistiveSessionTarget {
  const identity=JSON.stringify(engine.read().identity);
  const initialA=engine.resolve(range.anchor),initialB=engine.resolve(range.focus);
  if (initialA.type!=='position' || initialB.type!=='position') throw Error('unsupported-target');
  const anchor=engine.importAnchor(engine.exportAnchor(range.anchor));let focus;
  try { focus=engine.importAnchor(engine.exportAnchor(range.focus)); } catch (error) {engine.releaseAnchor(anchor);throw error;}
  const owned={anchor,focus};let active=true;
  const valid=() => {
    if (!active) return false;
    try {
      if (!writable() || JSON.stringify(engine.read().identity)!==identity || ![initialA.node,initialB.node].every(id=>engine.read().visible.some(n=>n.id===id && n.kind==='block'))) return false;
      const a=engine.resolve(anchor),b=engine.resolve(focus);
      return a.type==='position' && b.type==='position' && a.node===initialA.node && b.node===initialB.node &&
        (initialA.node===initialB.node && initialA.offset===initialB.offset || a.node!==b.node || a.offset!==b.offset);
    } catch {return false;}
  };
  const dispose=() => {if(!active)return;active=false;for(const token of [anchor,focus])try{engine.releaseAnchor(token);}catch{/* engine disposed */}};
  return {valid,dispose,accept(text) {
    if(!valid())throw Error('stale');
    const a=engine.resolve(anchor),b=engine.resolve(focus);if(a.type!=='position'||b.type!=='position')throw Error('stale');
    const point={owner:a.node,offset:Math.min(a.offset,b.offset)+text.length,bias:'right' as const};
    const request:PrepareRequest=a.node!==b.node ? {kind:'fragment',origin:'assistive:final',range:owned,blocks:[{attributes:{type:'paragraph'},runs:[{text,marks:[]}]}]} : {kind:'editor',origin:'assistive:final',commands:[
      {type:'historySelectionAt',anchor:{owner:a.node,offset:a.offset,bias:a.bias},focus:{owner:b.node,offset:b.offset,bias:b.bias}},
      {type:'replace',range:owned,text}, {type:'selectionAt',anchor:point,focus:point}]};
    if(!engine.can(request)||!valid())throw Error('stale');
    const before=engine.read().revision;
    engine.history({type:'explicit'});
    const observation: {selection: Patch['selection']} = {selection:null};
    const subscription=engine.subscribe({type:'all'},patch=>{if(patch.update && patch.origin==='editac:local:assistive:final')observation.selection=patch.selection;});
    try {
      let result:CommitResult;
      try {result=commit(request);} catch(error) {
        if(engine.read().revision===before)throw error;
        // Recover only the authoritative committed selection, never replay the edit.
        result={revision:engine.read().revision};
        const observed=observation.selection;
        if(observed && !('error' in observed) && observed.anchor.type==='position' && observed.focus.type==='position') {
          const a=observed.anchor,b=observed.focus;
          const anchor=engine.anchor(a.node,a.offset,a.bias);
          try {result={...result,selection:{anchor,focus:engine.anchor(b.node,b.offset,b.bias)}};}
          catch {engine.releaseAnchor(anchor);}
        }
      }
      try {applied(result);} catch {/* post-commit presentation failure cannot replay text */}
      finally {if(result.selection){engine.releaseAnchor(result.selection.anchor);engine.releaseAnchor(result.selection.focus);}if(result.caret)engine.releaseAnchor(result.caret);}
    } finally {subscription.dispose();try{engine.history({type:'boundary'});}catch{/* post-commit teardown */}}
  }};
}
