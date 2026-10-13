import type { AnchorToken, EngineHandle, PrepareRequest, PatchSubscription } from '@edit-ac/core';
import type { DOMRenderer } from '../dom/render.js';
import type { DOMSelection, RetainedSelection } from '../dom/selection.js';

let nextEditor = 0;
export type Disposition = 'native-pending' | 'committed' | 'canceled' | 'rejected' | 'disposed' | 'handled';
export interface Intent { id: string; generation: number; origin: string; disposition: Disposition; reason?: string; text?: string }
interface ProtocolTrace { type: string; trusted: boolean; generation: number; intent?: string; count?: number; owners?: string[]; inputType?: string | undefined; composing?: boolean | undefined; key?: string | undefined; data?: string | null | undefined; cancelable?: boolean; origin?: string }
interface Composition { intent: Intent; target: RetainedSelection; node: string; before: string; start: number; end: number; selected: string }
/** Qualification protocol, not the production text/composition router. Correlation
 * is rooted in physical key cycles, event objects, mutation batches and sessions.
 * A payload or elapsed-time window is never an intent identifier. */
export class InputProtocol {
  readonly intents: Intent[] = [];
  readonly trace: ProtocolTrace[] = [];
  private readonly editor = ++nextEditor;
  private readonly content = new Map<string,string>();
  private readonly documentScope: string;
  private readonly subscription: PatchSubscription;
  private sequence = 0;
  private generation = 1;
  private disposed = false;
  private readOnly = false;
  private readonly events = new WeakMap<Event, Intent>();
  private pending: Intent | undefined;
  private key: Intent | undefined;
  private composition: Composition | undefined;
  private readonly observer: MutationObserver;
  private queued = false;
  private readonly jobs: { intent: Intent; node: string; before: string; after: string; a: AnchorToken; b: AnchorToken; text: string }[] = [];
  private commitKey = false;
  private commitKeyOwner: Intent | undefined;
  private commitKeyTurn = 0;
  private rendering = false;
  private readonly listeners: [string, EventListener][] = [];
  constructor(private readonly renderer: DOMRenderer, private readonly selection: DOMSelection,
    private readonly engine: EngineHandle, private readonly commit: (request: PrepareRequest) => unknown) {
    const snapshot=this.engine.read();
    this.documentScope=`${snapshot.identity.documentId}/${snapshot.identity.epoch}`;
    for(const node of snapshot.visible)this.content.set(node.id,node.runs.map(run=>run.text).join(''));
    this.subscription=this.engine.subscribe({type:'all'},patch=>{
      for(const change of patch.nodes) {
        if(change.type==='visible')this.content.set(change.node.id,change.node.runs.map(run=>run.text).join(''));
        else this.content.delete(change.type==='removed'?change.id:change.node.id);
      }
    });
    this.observer = new MutationObserver(records => this.mutations(records));
    this.observer.observe(renderer.root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    renderer.patchBoundary = {
      before: () => { this.mutations(this.observer.takeRecords()); this.rendering = true; },
      after: () => { const records = this.observer.takeRecords(); if (records.length) this.trace.push({type:'renderer-echo',trusted:false,count:records.length,generation:this.generation,origin:'renderer',owners:[...new Set(records.map(record=>this.renderer.getNodeId(record.target)).filter((id):id is string=>!!id))]}); this.rendering = false; }
    };
    for (const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','blur']) {
      const listener: EventListener = event => this.handle(event);
      this.listeners.push([type, listener]); renderer.root.addEventListener(type, listener);
    }
  }
  private create(origin: string): Intent {
    const intent: Intent = { id: `${this.documentScope}/${this.editor}/${this.generation}/${++this.sequence}`, generation:this.generation,origin,disposition:'native-pending' };
    this.intents.push(intent); return intent;
  }
  private text(id: string): string { return this.content.get(id) ?? ''; }
  private correlate(event: Event,intent: Intent): void {
    this.events.set(event,intent);
    const record=[...this.trace].reverse().find(record=>record.type===event.type&&!record.intent);
    if(record)record.intent=intent.id;
  }
  private handle(event: Event): void {
    if (this.disposed) return;
    const input = event as InputEvent, keyboard = event as KeyboardEvent;
    this.trace.push({type:event.type,trusted:event.isTrusted,generation:this.generation,inputType:input.inputType,composing:input.isComposing,key:keyboard.key,data:input.data??(event as CompositionEvent).data,cancelable:event.cancelable});
    const existing=this.events.get(event);if(existing){this.correlate(event,existing);return;}
    if (event.type === 'keyup') {
      this.mutations(this.observer.takeRecords());
      const intent=this.key??this.commitKeyOwner;
      if(intent){this.correlate(event,intent);if(intent.disposition==='native-pending'&&!this.composition&&!this.jobs.some(job=>job.intent===intent))intent.disposition='handled';}
      this.key = undefined; this.commitKey = false;this.commitKeyOwner=undefined;return;
    }
    if (event.type === 'keydown') {
      if (keyboard.key === 'Enter' && (this.composition || this.commitKey || keyboard.isComposing)) {
        event.preventDefault(); this.commitKey = true;this.commitKeyOwner=this.composition?.intent??this.commitKeyOwner;if(this.commitKeyOwner)this.correlate(event,this.commitKeyOwner);return;
      }
      if(keyboard.key.length!==1&&!['Enter','Backspace','Delete','Dead','Process','Unidentified'].includes(keyboard.key))return;
      this.key = this.create('key'); this.correlate(event, this.key);
      if (keyboard.key === 'Enter' && !this.readOnly) {
        const target=this.selection.retain();
        if(target) try {
          const point=this.engine.resolve(target.range.anchor);
          if(point.type==='position') {
            event.preventDefault();this.engine.history({type:'explicit'});
            this.commit({kind:'editor',origin:`input-policy:${this.key.id}`,commands:[{type:'split',owner:point.node,at:target.range.anchor}]});
            this.key.disposition='committed';
          }
        } catch(error) {this.key.disposition='rejected';this.key.reason=error instanceof Error?error.message:String(error);}
        finally {target.dispose();}
      }
      return;
    }
    if (event.type === 'compositionstart') { this.start();const intent=this.intents.at(-1);if(intent)this.correlate(event,intent);return; }
    if (event.type === 'compositionupdate') {if(this.composition)this.correlate(event,this.composition.intent);return;}
    if (event.type === 'compositionend') {
      const owner=this.composition?.intent??this.commitKeyOwner;if(owner){this.correlate(event,owner);this.commitKeyOwner=owner;}
      this.finish((event as CompositionEvent).data === '' ? 'cancel' : 'final');
      this.commitKey = true;
      const turn = ++this.commitKeyTurn;
      // A late commit-key continuation is confined to this dispatcher turn or
      // key cycle. A later independent Enter is never indefinitely suppressed.
      void new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null); }).then(()=>{if(turn===this.commitKeyTurn&&!this.key){this.commitKey=false;this.commitKeyOwner=undefined;}});
      return;
    }
    if (event.type === 'blur') { this.finish('blur'); return; }
    if (this.composition || input.isComposing) { const owner=this.composition?.intent??this.key??this.pending;if(owner)this.correlate(event,owner);return; }
    if (event.type === 'beforeinput') {
      if (this.commitKey && ['insertParagraph','insertLineBreak'].includes(input.inputType)) { if(event.cancelable)event.preventDefault();if(this.commitKeyOwner)this.correlate(event,this.commitKeyOwner);return; }
      const intent = this.key ?? this.create('beforeinput'); this.correlate(event,intent); this.pending=intent;
      if (intent.disposition !== 'native-pending') { if(event.cancelable)event.preventDefault();if(this.commitKeyOwner)this.correlate(event,this.commitKeyOwner);return; }
      if (this.readOnly) { if(event.cancelable)event.preventDefault(); intent.disposition='rejected';intent.reason='read-only';return; }
      if (!event.cancelable || input.inputType !== 'insertText' || input.data === null) return;
      const target = this.selection.retain();
      if (!target) { intent.disposition='rejected';intent.reason='unmapped-selection';return; }
      event.preventDefault();
      try { this.apply(intent,target.range.anchor,target.range.focus,input.data); }
      finally { target.dispose(); }
    } else if (event.type === 'input') {
      this.mutations(this.observer.takeRecords());
      const intent=this.pending;
      if(intent)this.correlate(event,intent);
      this.schedule();
    }
  }
  private mutations(records: MutationRecord[]): void {
    if (!records.length || this.disposed || this.rendering) return;
    const trace: ProtocolTrace={type:'native-mutations',trusted:false,count:records.length,generation:this.generation,origin:'native'};this.trace.push(trace);
    if (this.composition) {trace.intent=this.composition.intent.id;return;}
    const owners = new Set(records.map(record=>this.renderer.getNodeId(record.target)).filter((id):id is string=>!!id));
    trace.owners=[...owners];
    if (owners.size !== 1) { const intent=this.create('mutation');intent.disposition='rejected';intent.reason='unsupported-mutation-scope';return; }
    const node = [...owners][0]!, block=this.renderer.getBlock(node);
    if (!block) return;
    const before=this.text(node), after=block.textContent ?? '';
    // No mutation effect is not a new semantic edit. Correlation has already
    // assigned ownership using records/events, independent of their text data.
    if (before === after) return;
    const intent=this.pending?.disposition==='native-pending'?this.pending:this.create('mutation');this.pending=intent;trace.intent=intent.id;
    if(this.readOnly){intent.disposition='rejected';intent.reason='read-only';this.renderer.resume(node);return;}
    let start=0,end=before.length,tail=after.length;
    while(start<end&&start<tail&&before[start]===after[start])start++;
    while(end>start&&tail>start&&before[end-1]===after[tail-1]){end--;tail--;}
    // Prefix/suffix boundaries may not split UTF-16 surrogate pairs.
    if(start>0 && /[\uDC00-\uDFFF]/.test(before[start]??after[start]??''))start--;
    if(end<before.length && /[\uDC00-\uDFFF]/.test(before[end]??'')){end++;tail++;}
    const a=this.engine.anchor(node,start,'right'),b=this.engine.anchor(node,end,'left');
    this.jobs.push({intent,node,before,after,a,b,text:after.slice(start,tail)});this.schedule();
  }
  private schedule(): void {
    if(this.queued)return;this.queued=true;const generation=this.generation;
    queueMicrotask(()=>{this.queued=false;if(generation!==this.generation)return;this.drain();});
  }
  private drain(): void {
    for(const job of this.jobs.splice(0)) {
      try { if(job.intent.disposition==='native-pending')this.apply(job.intent,job.a,job.b,job.text); }
      finally { this.engine.releaseAnchor(job.a);this.engine.releaseAnchor(job.b); }
    }
  }
  private apply(intent: Intent, a: AnchorToken, b: AnchorToken, text: string): void {
    if(this.disposed||intent.generation!==this.generation){intent.disposition='disposed';return;}
    if(this.readOnly){intent.disposition='rejected';intent.reason='read-only';return;}
    const start=this.engine.resolve(a),end=this.engine.resolve(b);
    if(start.type!=='position'||end.type!=='position'){intent.disposition='rejected';intent.reason='stale-target';intent.text=text;return;}
    let caret: AnchorToken | undefined;
    try {
      this.engine.history({type:'explicit'});
      this.commit({kind:'text',origin:`input-policy:${intent.id}`,command:{type:'replace',range:{anchor:a,focus:b},text}});
      intent.disposition='committed';intent.text=text;
      const resolved=this.engine.resolve(a);
      if(resolved.type==='position') {
        // Right affinity follows the admitted replacement's end, including a
        // remote prefix. Resolve the anchor rather than adding stale offsets.
        caret=this.engine.anchor(resolved.node,resolved.offset,'right');
        const point=this.selection.toDOM({...resolved,bias:'right'});
        if(point)this.renderer.root.ownerDocument.getSelection()?.setBaseAndExtent(point.node,point.offset,point.node,point.offset);
      }
    } catch(error) {intent.disposition='rejected';intent.reason=error instanceof Error?error.message:String(error);intent.text=text;}
    finally {if(caret)this.engine.releaseAnchor(caret);}
  }
  private start(): void {
    this.mutations(this.observer.takeRecords());this.drain();
    if(this.composition)this.finish('cancel');
    const intent=this.key?.disposition==='native-pending'?this.key:this.pending?.disposition==='native-pending'?this.pending:this.create('composition');intent.origin='composition';this.pending=intent;
    const target=this.selection.retain();
    if(this.readOnly||!target){intent.disposition='rejected';intent.reason=this.readOnly?'read-only':'unmapped-selection';target?.dispose();return;}
    const a=this.engine.resolve(target.range.anchor),b=this.engine.resolve(target.range.focus);
    if(a.type!=='position'||b.type!=='position'||a.node!==b.node){intent.disposition='rejected';intent.reason='unsupported-composition-range';target.dispose();return;}
    const start=Math.min(a.offset,b.offset),end=Math.max(a.offset,b.offset),before=this.text(a.node);
    this.composition={intent,target,node:a.node,before,start,end,selected:before.slice(start,end)};
    this.selection.suspended=true;this.renderer.hold(a.node);
  }
  private finish(mode: 'final'|'cancel'|'blur'|'readonly'|'dispose'): void {
    const session=this.composition;if(!session)return;
    const after=this.renderer.getBlock(session.node)?.textContent??'';
    const prefix=session.before.slice(0,session.start),suffix=session.before.slice(session.end);
    const valid=after.startsWith(prefix)&&after.endsWith(suffix)&&after.length>=prefix.length+suffix.length;
    const text=valid?after.slice(prefix.length,after.length-suffix.length):after;
    session.intent.text=text;
    // Drain native records while ownership still belongs to this composition.
    this.observer.takeRecords();this.composition=undefined;
    try {
      if(mode==='dispose'){session.intent.disposition='disposed';return;}
      if(mode==='cancel'||mode==='readonly'){session.intent.disposition='canceled';return;}
      if(!valid){session.intent.disposition='rejected';session.intent.reason='unsupported-composition-shape';return;}
      const a=this.engine.resolve(session.target.range.anchor),b=this.engine.resolve(session.target.range.focus);
      if(a.type!=='position'||b.type!=='position'||a.node!==b.node){session.intent.disposition='rejected';session.intent.reason='stale-target';return;}
      if(this.text(a.node).slice(Math.min(a.offset,b.offset),Math.max(a.offset,b.offset))!==session.selected){session.intent.disposition='rejected';session.intent.reason='remote-overlap';return;}
      if(text===session.selected){session.intent.disposition='canceled';return;}
      // Project deferred remote state before the prepared local commit, keeping
      // the native subtree held until the finalization boundary.
      this.renderer.resume(session.node);this.selection.suspended=false;
      this.apply(session.intent,session.target.range.anchor,session.target.range.focus,text);
    } finally {
      this.renderer.resume(session.node);this.selection.suspended=false;session.target.dispose();
      if(session.intent.disposition==='rejected') {
        this.renderer.root.ownerDocument.getSelection()?.removeAllRanges();this.selection.clear();
      }
    }
  }
  setReadOnly(value:boolean):void {if(value)this.finish('readonly');this.readOnly=value;this.renderer.setReadOnly(value);}
  async settle():Promise<void> {
    const generation=this.generation;
    for(let turn=0;turn<8;turn++) {
      if(generation!==this.generation)return;
      this.mutations(this.observer.takeRecords());this.drain();await Promise.resolve();
      if(!this.queued&&!this.jobs.length){await Promise.resolve();if(!this.queued&&!this.jobs.length)return;}
    }
    throw new Error('Input protocol did not settle in eight dispatcher turns');
  }
  dispose():void {
    if(this.disposed)return;this.finish('dispose');this.disposed=true;this.generation++;
    for(const job of this.jobs)this.renderer.resume(job.node);
    this.renderer.setReadOnly(true);this.subscription.dispose();this.content.clear();this.observer.disconnect();this.renderer.patchBoundary=undefined;
    for(const [type,listener] of this.listeners)this.renderer.root.removeEventListener(type,listener);
    for(const job of this.jobs.splice(0)){job.intent.disposition='disposed';this.engine.releaseAnchor(job.a);this.engine.releaseAnchor(job.b);}
    for(const intent of this.intents)if(intent.disposition==='native-pending')intent.disposition='disposed';
  }
}
