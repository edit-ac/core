import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MockLanguageModelV4} from 'ai/test';
import {completionBackend} from './backend.mjs';
// Any accidental network/proxy/provider fallback fails before traffic.
globalThis.fetch=()=>{throw Error('Network forbidden in prepared tests');};
const result=text=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:undefined,noCache:undefined,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:undefined,text:undefined,reasoning:undefined}},warnings:[]});
const request={version:1,requestId:'prepared-1',operation:'completion',scope:'passage',instruction:'Short continuation',context:'Prepared paragraph',format:'plain-text',outputBytes:128};
const make=(model,overrides={})=>completionBackend({model,requests:2,contextBytes:512,outputBytes:128,maxOutputTokens:32,timeoutMs:1000,admit:()=>true,...overrides});
const collect=async(backend,r=request,signal=new AbortController().signal)=>{const out=[];for await(const event of backend.send(r,signal))out.push(event);return out;};
test('real pinned SDK generateText emits one complete bounded response and unknown usage',async()=>{
 const model=new MockLanguageModelV4({doGenerate:result('Prepared continuation')});const out=await collect(make(model));assert.deepEqual(out.map(e=>e.type),['delta','finish']);assert.equal(out[0].text,'Prepared continuation');assert.deepEqual(out[1].usage,{inputTokens:null,outputTokens:null});assert.equal(model.doGenerateCalls.length,1);assert.equal(model.doGenerateCalls[0].maxOutputTokens,32);assert.equal(model.doGenerateCalls[0].tools,undefined);
});
test('SDK transport failure is attempted exactly once without retries',async()=>{
 let calls=0;const model=new MockLanguageModelV4({doGenerate:async()=>{calls++;throw Error('Prepared failure');}});await assert.rejects(collect(make(model)),/Prepared failure/);assert.equal(calls,1);
});
test('client cancellation reaches SDK model and late output is rejected',async()=>{
 const controller=new AbortController();let seen=false;
 const model=new MockLanguageModelV4({doGenerate:async options=>{assert.equal(options.abortSignal.aborted,false);controller.abort();seen=options.abortSignal.aborted;return result('late');}});
 await assert.rejects(collect(make(model),request,controller.signal));assert.equal(seen,true);assert.equal(model.doGenerateCalls.length,1);
});
test('missing quota/context/output/token configuration rejects before model dispatch',()=>{
 const model=new MockLanguageModelV4({doGenerate:result('x')});for(const overrides of [{requests:undefined},{contextBytes:undefined},{maxOutputTokens:0},{outputBytes:1025},{model:'ambient-provider'}])assert.throws(()=>make(model,overrides));assert.equal(model.doGenerateCalls.length,0);
});
test('admission denial, pre-abort and context limits issue no SDK call',async()=>{
 const model=new MockLanguageModelV4({doGenerate:result('x')});await assert.rejects(collect(make(model,{admit:()=>false})),/forbidden/);await assert.rejects(collect(make(model),{...request,context:'x'.repeat(513)}),/invalid-request/);await assert.rejects(collect(make(model),request,AbortSignal.abort()));assert.equal(model.doGenerateCalls.length,0);
});
test('oversized, empty and tool-call outputs cannot become suggestions',async()=>{
 for(const prepared of [result('x'.repeat(129)),result(''),{...result(''),content:[{type:'tool-call',toolCallId:'unsafe',toolName:'unsafe',input:'{}'}],finishReason:{unified:'tool-calls',raw:undefined}}]){
 const model=new MockLanguageModelV4({doGenerate:prepared});await assert.rejects(collect(make(model)));assert.equal(model.doGenerateCalls.length,1);
 }
});
test('hard request cap includes failed attempts and no implicit regeneration',async()=>{
 const model=new MockLanguageModelV4({doGenerate:result('x')});const backend=make(model,{requests:1});await collect(backend);await assert.rejects(collect(backend),/quota/);assert.equal(model.doGenerateCalls.length,1);
});
test('backend deadline aborts the actual SDK signal and releases pending work',async()=>{
 let aborted=false;const model=new MockLanguageModelV4({doGenerate:options=>new Promise((resolve,reject)=>{options.abortSignal.addEventListener('abort',()=>{aborted=true;reject(Error('Prepared timeout'));},{once:true});})});await assert.rejects(collect(make(model,{timeoutMs:10})));assert.equal(aborted,true);assert.equal(model.doGenerateCalls.length,1);
});
