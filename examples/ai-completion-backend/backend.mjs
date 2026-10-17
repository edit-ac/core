import { generateText } from 'ai';
const bytes = text => new TextEncoder().encode(text).length;
const bound = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
/** Optional server-side portable transport. Model/authority are supplied explicitly by the host.
 * No credentials, automatic provider selection, retries, tools or streaming ghost text. */
export function completionBackend({model, requests, contextBytes, outputBytes, maxOutputTokens, timeoutMs, admit}) {
  if (!model || typeof model !== 'object' || typeof model.doGenerate !== 'function' ||
      !bound(requests,10000) || !bound(contextBytes,32768) || !bound(outputBytes,1024) ||
      !bound(maxOutputTokens,256) || !bound(timeoutMs,120000) || typeof admit !== 'function') throw Error('Invalid backend configuration');
  let used=0;
  return {async *send(request, signal) {
    // This recipe accepts only the qualified completion/plain-text envelope.
    if (signal.aborted) throw Error('canceled');
    if (request.version!==1 || request.operation!=='completion' || request.scope!=='passage' || request.format!=='plain-text' ||
        typeof request.context!=='string' || bytes(request.context)>contextBytes || typeof request.instruction!=='string' ||
        !request.instruction.length || bytes(request.instruction)>1024 || !bound(request.outputBytes,outputBytes) ||
        typeof request.requestId!=='string' || !/^[\w:-]{1,128}$/.test(request.requestId)) throw Error('invalid-request');
    if (used>=requests) throw Error('quota');
    ++used; // every attempt consumes a reservation, including failed admission/abort
    if (!admit(request)) throw Error('forbidden');
    const controller=new AbortController(), abort=()=>controller.abort(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(Error('timeout')),timeoutMs);
    try {
      const result=await generateText({model,system:request.instruction,prompt:request.context,
        maxOutputTokens,maxRetries:0,abortSignal:controller.signal,experimental_telemetry:{isEnabled:false}});
      if(controller.signal.aborted)throw Error('canceled');
      if(!['stop','length'].includes(result.finishReason) || result.content.some(part=>part.type!=='text') ||
          !result.text.length || bytes(result.text)>request.outputBytes)throw Error('invalid-response');
      yield {version:1,requestId:request.requestId,sequence:0,type:'delta',text:result.text};
      yield {version:1,requestId:request.requestId,sequence:1,type:'finish',usage:{inputTokens:result.usage.inputTokens??null,outputTokens:result.usage.outputTokens??null}};
    } finally { clearTimeout(timer);signal.removeEventListener('abort',abort); }
  }};
}
