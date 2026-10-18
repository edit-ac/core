import type { AssetGrant, AssetIdentity, AssetIntent, AssetPublication, AssetRequest, AssetWorkAction, AssetWorkResult, EngineHandle, PatchSubscription } from '@edit-ac/core';
import { identityKey, openStorageDatabase } from '../storage/journal.js';
import { completeTransaction, strictTransaction } from '../storage/transaction.js';

export interface AssetHostTransport {
  /** Fresh explicit authority. The host also enforces this at effect time. */
  authorize(request: Readonly<AssetRequest>, signal: AbortSignal): Promise<AssetGrant>;
  /** Idempotent by operationId; cancel acknowledgement fences outstanding effects.
   * release-reference releases this document/reference, never a global binary. */
  execute(reference: string, request: Readonly<AssetRequest>, bytes: Uint8Array | null,
    signal: AbortSignal): Promise<AssetPublication | null>;
}
export interface AssetOperationReceipt { kind: 'assetOperation'; operationId: string; durability: IDBTransactionDurability | 'unknown' }
interface Source { identity: AssetIdentity; bytes: Uint8Array }
interface RecordState { journal: string | null; sources: {reference:string;source:Source}[] }
const clone = <T>(value:T):T => structuredClone(value);
const same = (a:AssetIdentity,b:AssetIdentity) => a.host===b.host && a.key===b.key;
// The shared asset owner accepts bounded opaque keys, while engine node IDs
// contain colons. This reversible encoding is a binding, not lifecycle state.
const referenceKey=(owner:string)=>'node_'+Array.from(new TextEncoder().encode(owner),b=>b.toString(16).padStart(2,'0')).join('');
const referenceOwner=(reference:string)=>{
  if(!/^node_(?:[0-9a-f]{2})+$/.test(reference))throw Error('Invalid browser asset reference');
  return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(reference.slice(5).match(/../g)!,h=>parseInt(h,16)));
};
const maxBytes=64*1024*1024;
/** Optional browser Session companion. Rust AssetWork is the only lifecycle owner;
 * IndexedDB stores its opaque journal and host-retained bytes in one transaction.
 * Construction/recovery never contacts a host or dispatches recovered work. */
export class AssetSession {
  #closed=false; #closing=false; #disposing:Promise<void>|null=null; #generation=0; #pending=new Map<string,{controller:AbortController;reference:string}>();
  #subscription:PatchSubscription; #reconcile:Promise<void>=Promise.resolve(); #failure:unknown=null;
  private constructor(readonly engine:EngineHandle,readonly database:IDBDatabase,readonly key:string) {
    this.#subscription=engine.subscribe({type:'all'},()=>{
      this.#reconcile=this.#reconcile.then(()=>this.reconcile()).catch(error=>{this.#failure=error;});
    });
  }
  static async open(engine:EngineHandle,factory:IDBFactory,databaseName:string):Promise<AssetSession> {
    const db=await openStorageDatabase(factory,databaseName);
    const session=new AssetSession(engine,db,identityKey(engine.checkpoint().identity));
    try {await session.reconcile();return session;}catch(error){session.#subscription.dispose();db.close();throw error;}
  }
  #alive():void {if(this.#closed)throw Error('Asset Session disposed');if(this.#failure)throw this.#failure;}
  #accepting():void {this.#alive();if(this.#closing)throw Error('Asset Session is closing');}
  #live(reference:string,identity:AssetIdentity):boolean {
    const node=this.engine.read().visible.find(node=>node.id===referenceOwner(reference));
    const tuple=node?.blockAttributes;
    if(!Array.isArray(tuple)||tuple[0]!=='module:editac.asset'||tuple[1]!==1)return false;
    const descriptor=tuple[2] as unknown as {identity:AssetIdentity};
    return !!descriptor?.identity && same(descriptor.identity,identity);
  }
  #transaction(action:(state:RecordState)=>AssetWorkAction, extra?:(state:RecordState,result:AssetWorkResult)=>void):Promise<AssetWorkResult> {
    const tx=strictTransaction(this.database,'assets');let result:AssetWorkResult;
    return completeTransaction(tx,'Asset transaction aborted',()=>result,({watch})=>{
      const store=tx.objectStore('assets');watch(store.get(this.key),(stored:RecordState|undefined)=>{
        const state=stored??{journal:null,sources:[]};
        result=this.engine.assetWork(state.journal,action(state));
        extra?.(state,result);state.journal=result.journal;watch(store.put(state,this.key));
      });
    });
  }
  async inspect():Promise<AssetWorkResult> {this.#alive();return this.#transaction(()=>({type:'inspect'}));}
  /** Retain approved original bytes before a descriptor exists. No host dispatch
   * or document mutation. Job/reference/operation IDs are immutable and scoped. */
  async stageOriginal(job:string,reference:string,request:AssetRequest,grant:AssetGrant,bytes:Uint8Array):Promise<AssetOperationReceipt> {
    this.#accepting();
    if(!(bytes instanceof Uint8Array))throw TypeError('Uint8Array source required');
    if(reference.startsWith('node_'))throw Error('Prepared reference uses reserved live-node namespace');
    if(bytes.length===0||bytes.length>maxBytes||bytes.length>request.byteLimit)throw RangeError('Bounded retained ingest bytes required');
    const retained=Array.from(bytes),ownedRequest=clone(request),ownedGrant=clone(grant);
    const result=await this.#transaction(()=>{
      this.#accepting();
      return {type:'stageOriginal',job,reference,request:ownedRequest,grant:ownedGrant,bytes:retained};
    });
    return {kind:'assetOperation',operationId:(result.result as {operationId:string}).operationId,durability:'unknown'};
  }
  /** Fresh read authority; available after cancellation for source recovery. */
  async preparedSource(job:string,reference:string,grant:AssetGrant):Promise<Uint8Array> {
    this.#alive();const ownedGrant=clone(grant);
    const result=await this.#transaction(()=>{this.#alive();return {type:'preparedSource',job,reference,grant:ownedGrant};});
    return Uint8Array.from(result.result as readonly number[]);
  }
  /** The Rust tombstone also fences an empty job and callbacks from older sessions.
   * Source survives; cleanup effects still require explicit runOne authority. */
  async fenceJob(job:string):Promise<void> {
    this.#alive();
    const result=await this.#transaction(()=>{this.#alive();return {type:'fenceJob',job};});
    const references=new Set(result.prepared.filter(p=>p.job===job&&!p.active).map(p=>p.reference));
    for(const [id,pending] of this.#pending){const intent=result.intents.find(i=>i.request.operationId===id);if(references.has(pending.reference)&&intent&&!['cancel','release-reference'].includes(intent.request.action)){pending.controller.abort();this.#pending.delete(id);}}
  }
  async enqueue(reference:string,request:AssetRequest,grant:AssetGrant,bytes?:Uint8Array):Promise<AssetOperationReceipt> {
    this.#accepting();reference=referenceKey(reference);if(bytes!==undefined&&!(bytes instanceof Uint8Array))throw TypeError("Uint8Array source required");request=clone(request);grant=clone(grant);const retained=bytes===undefined?undefined:new Uint8Array(bytes);
    if(request.action==='ingest'&&(!retained||retained.length===0||retained.length>request.byteLimit))throw Error('Bounded retained ingest bytes required');
    if(retained&&request.action!=='ingest')throw Error('Only ingest accepts local bytes');
    const result=await this.#transaction(state=>{
      this.#accepting();if(!this.#live(reference,request.identity))throw Error('Asset target missing or replaced');
      return {type:'enqueue',reference,request,grant};
    },state=>{
      if(!retained)return;
      const old=state.sources.find(s=>s.reference===reference);
      if(old&&(!same(old.source.identity,request.identity)||old.source.bytes.length!==retained.length||old.source.bytes.some((b,i)=>b!==retained[i])))throw Error('Retained source conflict');
      if(!old)state.sources.push({reference,source:{identity:request.identity,bytes:retained}});
      if(state.sources.reduce((sum,s)=>sum+s.source.bytes.length,0)>maxBytes)throw Error('Retained byte limit');
    });
    return {kind:'assetOperation',operationId:(result.result as {operationId:string}).operationId,durability:'unknown'};
  }
  async retainedSource(reference:string,grant:AssetGrant):Promise<Uint8Array|null> {
    this.#alive();reference=referenceKey(reference);grant=clone(grant);let bytes:Uint8Array|null=null;
    await this.#transaction(()=>({type:'inspect'}),state=>{
      const source=state.sources.find(s=>s.reference===reference)?.source;
      if(source){this.engine.assetWork(state.journal,{type:'validate',request:{version:1,operationId:'read_source',identity:source.identity,action:'read',byteLimit:Math.max(1,source.bytes.length)},grant});bytes=new Uint8Array(source.bytes);}
    });return bytes;
  }
  async retire(reference:string,identity:AssetIdentity,prefix:string):Promise<void> {
    this.#alive();reference=referenceKey(reference);identity=clone(identity);
    await this.#transaction(()=>({type:'retire',reference,identity,prefix}));
    for(const [id,pending] of this.#pending) {if(pending.reference===reference){pending.controller.abort();this.#pending.delete(id);}}
  }
  async reconcile():Promise<void> {
    this.#alive();const {intents,prepared}=await this.inspect();
    const seen=new Set<string>();
    for(const intent of intents){if(prepared.some(p=>p.active&&p.reference===intent.reference))continue;if(seen.has(intent.reference))continue;seen.add(intent.reference);
      if(!intents.some(i=>i.reference===intent.reference&&i.request.action==='cancel')&&!this.#live(intent.reference,intent.request.identity))await this.retire(referenceOwner(intent.reference),intent.request.identity,`retire_${intent.reference}`);
    }
  }
  /** One explicit host attempt. No timers, startup dispatch or automatic retries. */
  async runOne(operation:string,online:boolean,host:AssetHostTransport):Promise<boolean> {
    this.#accepting();if(!host||typeof host.authorize!=="function"||typeof host.execute!=="function")throw Error("Asset host unsupported");
    await this.#reconcile;await this.reconcile();this.#accepting();
    if(this.#pending.has(operation))throw Error('Asset operation already running');
    const intent=(await this.inspect()).intents.find(i=>i.request.operationId===operation);
    if(!intent)throw Error('Unknown asset operation');if(intent.status!=='Pending')return false;
    if(!['cancel','release-reference'].includes(intent.request.action)&&(await this.inspect()).prepared.some(p=>p.reference===intent.reference))throw Error('Prepared original requires atomic adoption before host dispatch');
    this.#accepting();
    const controller=new AbortController(),generation=this.#generation;this.#pending.set(operation,{controller,reference:intent.reference});
    try {
      const grant=clone(await host.authorize(clone(intent.request),controller.signal));
      if(generation!==this.#generation||controller.signal.aborted)throw Error('Asset operation canceled');
      // Reconcile again after asynchronous permission resolution.
      await this.reconcile();if(controller.signal.aborted)throw Error('Asset operation canceled');
      const begun=await this.#transaction(state=>{
        if(intent.request.action==='ingest'){const source=state.sources.find(s=>s.reference===intent.reference)?.source;if(!source||!same(source.identity,intent.request.identity)||source.bytes.length>intent.request.byteLimit)throw Error('Retained source missing or incompatible');}
        if(!['cancel','release-reference'].includes(intent.request.action)&&!this.#live(intent.reference,intent.request.identity))return {type:'retire',reference:intent.reference,identity:intent.request.identity,prefix:`retire_${intent.reference}`};
        return {type:'begin',operation,online,grant};
      });
      const captured=begun.result as AssetIntent|null;if(!captured)return false;
      let bytes:Uint8Array|null=null;
      await this.#transaction(()=>({type:'inspect'}),state=>{const source=state.sources.find(s=>s.reference===captured.reference)?.source;bytes=source?new Uint8Array(source.bytes):null;});
      if(controller.signal.aborted||generation!==this.#generation)throw Error('Asset operation canceled');
      if(!['cancel','release-reference'].includes(captured.request.action)&&!this.#live(captured.reference,captured.request.identity)){await this.retire(referenceOwner(captured.reference),captured.request.identity,`retire_${captured.reference}`);return false;}
      const receipt=await host.execute(captured.reference,clone(captured.request),bytes,controller.signal);
      if(generation!==this.#generation)return false;
      const completionGrant=clone(await host.authorize(clone(captured.request),controller.signal));
      if(generation!==this.#generation)return false;
      await this.reconcile();
      await this.#transaction(()=>{
        if(!['cancel','release-reference'].includes(captured.request.action)&&!this.#live(captured.reference,captured.request.identity))return {type:'retire',reference:captured.reference,identity:captured.request.identity,prefix:`retire_${captured.reference}`};
        return {type:'complete',operation,receipt:clone(receipt),grant:completionGrant};
      },state=>{
        if(captured.request.action==='release-reference')state.sources=state.sources.filter(s=>s.reference!==captured.reference);
      });return true;
    } finally {this.#pending.delete(operation);}
  }
  /** suspend retains recovery work; retire fences all references before closure.
   * Host cancellation/release still requires explicit runOne before suspension. */
  async dispose(policy:'suspend'|'retire'):Promise<void> {
    if(this.#closed)return;if(policy!=="suspend"&&policy!=="retire")throw Error("Explicit asset disposal policy required");if(this.#disposing)return this.#disposing;this.#alive();this.#closing=true;this.#generation++;for(const p of this.#pending.values())p.controller.abort();this.#pending.clear();
    this.#disposing=(async()=>{
      try {if(policy==='retire'){const {intents,prepared}=await this.inspect();for(const job of new Set(prepared.map(p=>p.job)))await this.fenceJob(job);for(const i of intents){if(prepared.some(p=>p.reference===i.reference))continue;await this.retire(referenceOwner(i.reference),i.request.identity,`dispose_${i.reference}`);}}}
      finally {this.#closed=true;this.#subscription.dispose();this.database.close();}
    })();
    return this.#disposing;
  }
}
