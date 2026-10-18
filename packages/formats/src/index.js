/** Importing this entry allocates no worker, converter, font, or document. */
export class FormatError extends Error {
  constructor(code, detail, original = new Uint8Array()) {
    super(detail?.action ?? code); this.name = 'FormatError'; this.code = code;
    this.report = detail; this.original = original;
  }
}
const MAX_INPUT = 1048576;
// Includes the reviewed publication renderer and six pinned font faces.
const MAX_MODULE = 16 * 1048576;
let workerPermits=0;const MAX_WORKERS=2;
const MAX_OUTPUT = 8 * 1048576;
/** A client owns at most one conversion worker; caller retains live Engine/anchors. */
export function createFormatClient() {
  let active = null, disposed = false, compiledModule = null, generation = 0;
  const reject = (code, original, detail = {}) => new FormatError(code, {code, ...detail}, original);
  async function run(engine, options, direction) {
    if (disposed) throw reject('Disposed');
    if (active) throw reject('Busy');
    const source = options.source ?? new Uint8Array();
    if(workerPermits>=MAX_WORKERS)throw reject('Busy',source);
    if (!(source instanceof Uint8Array)) throw reject('InvalidInput');
    if (source.byteLength > MAX_INPUT) throw reject('ResourceLimit',source);
    const original = source.slice();
    const signal = options.signal;
    if(signal!==undefined && !(signal instanceof AbortSignal))throw reject('InvalidInput',original);
    if (signal?.aborted) throw reject('Cancelled', original);
    if (!['rtf','csv','tsv','pdf','docx','odt','epub'].includes(options.format)) throw reject('FORMAT_UNAVAILABLE',original);
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10000)) throw reject('InvalidTimeout',original);
    if (direction === 'import' && !options.range) throw reject('MissingTarget',original);
    const start=performance.now();
    const revision=engine.read().revision;
    const checkpoint=engine.checkpoint();
    const failure=(code,detail)=>{const e=reject(code,original,detail);e.recovery=checkpoint;return e;};
    if (checkpoint.bytes.byteLength > MAX_INPUT) throw failure('ResourceLimit');
    // Copy the entire capability at capture time. Descriptors alone grant no read.
    const supplied=options.originalAssets ?? [];
    if(!Array.isArray(supplied)||supplied.length>64)throw failure('InvalidAssets');
    const assets=[];const chunks=[];let assetLength=0;
    for(const a of supplied){
      if(!a || !(a.bytes instanceof Uint8Array) || a.bytes.length===0 || !a.identity || typeof a.identity.host!=='string' || typeof a.identity.key!=='string' || !Array.isArray(a.actions) || a.actions.length>10 || a.actions.some(action=>action!=='read') || a.actions.length!==new Set(a.actions).size)throw failure('InvalidAssets');
      if(assetLength+a.bytes.length>MAX_INPUT)throw failure('ResourceLimit');
      assets.push({identity:{host:a.identity.host,key:a.identity.key},actions:[...a.actions],offset:assetLength,length:a.bytes.length});
      chunks.push(a.bytes.slice());assetLength+=a.bytes.length;
    }
    const assetBytes=new Uint8Array(assetLength);let assetOffset=0;for(const chunk of chunks){assetBytes.set(chunk,assetOffset);assetOffset+=chunk.length;}
    const request={assets,direction,format:options.format,identity:checkpoint.identity,initialized:checkpoint.initialized,writerId:checkpoint.writerId,
      selected:options.selected ?? null,filename:options.filename ?? null,mediaType:options.mediaType ?? null,newline:options.newline ?? null,header:options.header ?? null,safe:options.safe ?? false,approveLoss:options.approveLoss ?? false};
    if (JSON.stringify(request).length > 16384) throw failure('ResourceLimit');
    let worker;
    try { worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module',name:'edit-ac-local-formats'}); }
    catch { throw failure('IsolationUnavailable'); }
    workerPermits++;
    let stop;
    const value=await new Promise((resolve,rejectPromise)=>{
      let settled=false;const bootstrap=new AbortController();
      const finish=(error,result)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        bootstrap.abort();worker.terminate();workerPermits--;active=null;
        if(error)rejectPromise(error);else resolve(result);
      };
      const cancel=()=>finish(failure('Cancelled'));
      stop=cancel;active={stop};
      const timer=setTimeout(()=>finish(failure('Timeout')),options.timeoutMs ?? 10000);
      signal?.addEventListener('abort',cancel,{once:true});
      worker.onerror=()=>finish(failure('WorkerFailed'));
      worker.onmessage=({data})=>{
        if(data?.kind!=='result' || typeof data.json!=='string' || data.json.length>MAX_OUTPUT) return finish(failure('InvalidWorkerResult'));
        try { const result=JSON.parse(data.json); if(!result.ok)return finish(failure(result.code,result));
          finish(null,{...result,metrics:data.metrics});
        }catch{finish(failure('InvalidWorkerResult'));}
      };
      void (async()=>{
        if(!compiledModule){
          const response=await fetch(new URL('./runtime/editac_formats_wasm_bg.wasm',import.meta.url),{signal:bootstrap.signal,credentials:'omit'});
          if(!response.ok)throw Error('UnavailableAsset');
          if(Number(response.headers.get('content-length'))>MAX_MODULE)throw Error('ResourceLimit');
          const reader=response.body?.getReader();if(!reader)throw Error('UnavailableAsset');
          const chunks=[];let length=0;
          try {for(;;){const {done,value}=await reader.read();if(done)break;if(length+value.length>MAX_MODULE){await reader.cancel();throw Error('ResourceLimit');}length+=value.length;chunks.push(value);}}
          finally{reader.releaseLock();}
          const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
          const module=await WebAssembly.compile(bytes);if(settled)return;compiledModule=module;
        }
        if(!settled)worker.postMessage({kind:'convert',module:compiledModule,request:JSON.stringify(request),source:original.slice(),checkpoint:checkpoint.bytes,assets:assetBytes});
      })().catch(()=>finish(failure('IsolationUnavailable')));
      // An abort between the initial check and handler registration is fenced.
      if(signal?.aborted)cancel();
    });
    value.recovery=checkpoint;value.original=original;value.revision=revision;value.metrics.totalPrepareMs=performance.now()-start;
    value.bytes=value.bytes ? Uint8Array.from(value.bytes) : undefined;
    return value;
  }
  return {
    async prepareImport(engine, options) {
      const range={anchor:options.range?.anchor,focus:options.range?.focus};
      const ticket=generation;const signal=options.signal;const result=await run(engine,options,'import');let used=false;const blocks=structuredClone(result.blocks);
      const failure=(code,detail=result)=>{const e=reject(code,result.original,detail);e.recovery=result.recovery;return e;};
      return {...result,commit(){
        if(used)throw failure('Finished');used=true;
        if(disposed)throw failure('Disposed');
        if(generation!==ticket||signal?.aborted)throw failure('Cancelled');
        if(engine.read().revision!==result.revision)throw failure('StaleTarget');
        if(!result.sessionCommitted)throw failure(result.diagnostics.some(d=>d.lossy)?'LossApprovalRequired':'NoChange');
        try {
          const plan=engine.prepare({kind:'fragment',origin:'format-import',range,blocks});
          return engine.commit(plan);
        } catch(error) { throw failure('CommitRejected',{...result,cause:String(error),action:'Retain original input and checkpoint; the shared import commit was rejected.'}); }
      }};
    },
    export(engine,options){return run(engine,options,'export');},
    cancel(){generation++;active?.stop();},
    dispose(){disposed=true;generation++;active?.stop();compiledModule=null;}
  };
}
