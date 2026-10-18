import init, { convert } from './runtime/editac_formats_wasm.js';
// Only bundled code executes. There is no document-selected URL/font/code path.
// Hosts must serve this worker with connect-src 'none',
// or an equivalent worker network policy; platform sandbox claims stay separate.
self.onmessage = async ({data}) => {
  if(data?.kind !== 'convert') return;
  const started=performance.now();
  try {
    if(typeof data.request!=='string' || data.request.length>16384 || !(data.source instanceof Uint8Array) || data.source.length>1048576 || !(data.checkpoint instanceof Uint8Array) || data.checkpoint.length>1048576) throw Error('ResourceLimit');
    if(!(data.module instanceof WebAssembly.Module))throw Error('IsolationUnavailable');
    const wasm = await init({module_or_path: data.module});
    const boot=performance.now();
    // The launcher supplies a compiled bundled module; worker needs no fetch.
    const denied=()=>{throw Error('NetworkUnavailable');};
    self.fetch=denied;self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.EventSource=undefined;self.importScripts=denied;
    const json=convert(data.request,data.source,data.checkpoint);
    const metrics={bootstrapMs:boot-started,sessionConversionMs:performance.now()-boot,wasmLinearBytes:wasm.memory.buffer.byteLength,wasmMaximumBytes:67108864,
      heapBytes:self.performance.memory?.usedJSHeapSize ?? null};
    self.postMessage({kind:'result',json,metrics});
  } catch(e) {
    self.postMessage({kind:'result',json:JSON.stringify({ok:false,code:e instanceof WebAssembly.RuntimeError?'ResourceLimit':'WorkerFailed',action:'Keep original input; conversion did not mutate the live document.'})});
  }
};
