/** Prepared host only: no provider, permission probing, capture or network. */
export function mockAssetHost(identity) {
 const state={calls:[],effects:new Map(),denied:false,paused:false,waiting:[],signals:[]};
 return {state,release(){for(const resolve of state.waiting.splice(0))resolve();},
  async authorize(request,signal){state.signals.push(signal);state.calls.push(['authorize',structuredClone(request)]);return {identity,actions:state.denied?[]:['ingest','publish','read','cache','cancel','release-reference']};},
  async execute(reference,request,bytes,signal){state.signals.push(signal);state.calls.push(['execute',reference,structuredClone(request),bytes?Array.from(bytes):null]);
   if(state.paused)await new Promise(resolve=>state.waiting.push(resolve));
   // A canceled effect may still return a late receipt; shared retirement must fence it.
   if(!state.effects.has(request.operationId))state.effects.set(request.operationId,bytes?Array.from(bytes):null);
   return request.action==='publish'?{operationId:request.operationId,identity}:null;
  }};
}
