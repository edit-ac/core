/** Deterministic test-only provider. Never import into a live backend. */
import {MockLanguageModelV4} from 'ai/test';
import {completionBackend} from './backend.mjs';
export function preparedCompletionBackend(onCall) {
 const model=new MockLanguageModelV4({doGenerate:async options=>{onCall(options);return {
  content:[{type:'text',text:'Prepared שלום 🧪'}],finishReason:{unified:'stop',raw:undefined},
  usage:{inputTokens:{total:undefined,noCache:undefined,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:undefined,text:undefined,reasoning:undefined}},warnings:[],
 };}});
 return completionBackend({model,requests:3,contextBytes:4096,outputBytes:1024,maxOutputTokens:128,timeoutMs:5000,admit:()=>true});
}
