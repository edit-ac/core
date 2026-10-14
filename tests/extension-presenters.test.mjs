import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { presenterHost } from './helpers/extension-presenter-host.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.env.EDITAC_EXTENSION_PRESENTERS_OUTPUT;
assert(output,'unique absolute worktree-owned EDITAC_EXTENSION_PRESENTERS_OUTPUT required');
const manifest=JSON.parse(await readFile(new URL('../fixtures/extensions/presenters/conformance.json',import.meta.url)));
const facts={qualification:'headless-protocol-only',node:process.version,packs:[],checks:[],coverage:[],artifacts:{}};
let temp, consumer, api, runtime, seed;
const hash=b=>createHash('sha256').update(b).digest('hex');
const text=e=>e.read().visible[0].runs.map(r=>r.text).join('');
function run(command,args,cwd,label){
 const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:120000});
 facts.checks.push({label,command,args,exit:r.status});
 return writeFile(join(output,label+'.log'),r.stdout+r.stderr).then(()=>{assert.equal(r.error,undefined);assert.equal(r.status,0,label);return r.stdout;});
}
function adapter(host){
 let current,disposed=0,cancelled=0,preedit='';const trace=[];
 return {host,trace,get current(){return current;},get disposed(){return disposed;},get cancelled(){return cancelled;},get preedit(){return preedit;},
 update(value){current=value.input;trace.push(value);},focus(value){trace.push({focus:value});},
 input(value){preedit=value.text;trace.push({input:value});},
 accessibility(){return {label:current.content.text,actions:current.readOnly?[]:['replace'],readOnly:current.readOnly};},
 representation(mime){return {mime,text:current.content.text,fallback:true};},
 cancel(){cancelled++;preedit='';},dispose(){disposed++;},
 };
}
before(async()=>{
 await mkdir(output,{recursive:true});temp=await realpath(await mkdtemp(join(tmpdir(),'editac-extension-presenters-')));
 consumer=join(temp,'consumer');await mkdir(consumer);await writeFile(join(consumer,'package.json'),'{"type":"module","private":true}');
 for(const name of ['core','web']){
  const pack=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/'+name,'--pack-destination',temp,'--json'],root,'pack-'+name))[0];
  facts.packs.push({name,filename:pack.filename,integrity:pack.integrity});await copyFile(join(temp,pack.filename),join(output,pack.filename));
 }
 await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',...facts.packs.map(p=>join(temp,p.filename))],consumer,'install');
 const require=createRequire(join(consumer,'package.json'));
 api=await import(require.resolve('@edit-ac/web/modules'));
 const core=await import(require.resolve('@edit-ac/core'));
 for(const name of ['core','web'])assert.equal(await realpath(join(consumer,'node_modules/@edit-ac',name)),join(consumer,'node_modules/@edit-ac',name));
 const wasm=await readFile(join(consumer,'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm'));
 facts.artifacts.wasm=hash(wasm);runtime=await core.init('data:application/wasm;base64,'+wasm.toString('base64'));
 const e=runtime.createEngine({profile:'v5',documentId:'71000000-0000-4000-8000-000000000006',epoch:'72000000-0000-4000-8000-000000000006',nodes:[{text:'a😀b'}]});seed=e.checkpoint();e.dispose();
});
after(async()=>{try{await writeFile(join(output,'results.json'),JSON.stringify(facts,null,2)+'\n');
 const passed=new Set(facts.coverage);for(const h of manifest.hosts)for(const id of h.fixtures)assert(passed.has(id),'missing required fixture: '+id);
 }finally{if(temp)await rm(temp,{recursive:true,force:true});}});
async function harness(host){
 const h=await presenterHost(runtime,seed,api),a=adapter(host);const node=h.engine.read().visible[0];let selection=null;
 const snapshot=()=>({version:1,nodeId:node.id,sourceId:node.spans[0].source,content:{type:'fixture:mark',version:1,kind:'mark',text:text(h.engine),attributes:{}},selection,readOnly:h.state.state.readOnly,theme:'fixture-dark',capabilities:api.PRESENTER_CAPABILITIES[host]});
 // Source-local subscriptions use the actual owning projected source identity.
 assert.equal(typeof node.spans[0].source,'string');
 const session=new api.ExtensionPresenterSession(h.modules,a,snapshot,h.host,{range:{source:node.spans[0].source,start:0,end:100},selection:true});
 return {...h,a,session,snapshot,node,select(value){selection=value;h.modules.setSelection(value);},async close(){session.dispose();await h.close();}};
}
const obligations={
 'focus':async h=>{const before=h.engine.checkpoint();h.session.focus({owner:'nested-control',restore:false});h.session.focus({owner:'editor',restore:true});assert.deepEqual(h.a.trace.at(-1).focus,{owner:'editor',restore:true});assert.deepEqual(h.engine.checkpoint(),before);},
 'input-composition':async h=>{const before=h.engine.checkpoint();h.session.input({type:'composition-start',text:''});h.session.input({type:'composition-update',text:'仮😀'});assert.equal(h.a.preedit,'仮😀');assert.equal((await h.session.run(()=>h.request())).status,'cancelled');assert.deepEqual(h.engine.checkpoint(),before);h.session.input({type:'composition-end',text:'確定'});assert.equal((await h.session.run(()=>h.request('確定'))).status,'committed');assert.equal(h.engine.history({type:'state'}).undoGroups,1);},
 'selection':async h=>{const anchor=h.engine.anchor(h.node.id,1,'left'),focus=h.engine.anchor(h.node.id,3,'right');try{h.select({anchor:h.engine.resolve(anchor),focus:h.engine.resolve(focus)});}finally{h.engine.releaseAnchor(anchor);h.engine.releaseAnchor(focus);}assert.equal(h.a.trace.at(-1).event.type,'selection');assert.equal(h.a.current.selection.focus.offset,3);const input=h.snapshot();h.session.update();assert.equal(h.a.current.nodeId,input.nodeId);assert.equal(h.a.current.sourceId,input.sourceId);assert.deepEqual(h.a.current.selection,input.selection);assert(Object.isFrozen(h.a.current));assert.throws(()=>{h.a.current.content.text='shadow';},TypeError);await h.session.run(()=>h.request('X',1,3));assert.equal(h.a.current.nodeId,input.nodeId);assert.equal(text(h.engine),'aXb');},
 'accessibility':async h=>{assert.equal(h.session.accessibility().label,'a😀b');assert.deepEqual(h.session.accessibility().actions,['replace']);h.state.update({readOnly:true});h.session.update();assert.equal(h.session.accessibility().readOnly,true);assert.deepEqual(h.session.accessibility().actions,[]);},
 'clipboard-source':async h=>{const before=h.engine.checkpoint();for(const mime of ['text/plain','text/markdown'])assert.deepEqual(h.session.representation(mime),{mime,text:'a😀b',fallback:true});assert.deepEqual(h.engine.checkpoint(),before);},
 'patch':async h=>{const initial=h.a.trace.length;let irrelevant=0;const irrelevantSession=new api.ExtensionPresenterSession(h.modules,adapter(h.a.host),h.snapshot,h.host,{range:{source:'absent-source',start:0,end:100}});const unrelated=h.modules.subscribe({range:{source:'absent-source',start:0,end:100}},()=>irrelevant++);const observer=h.modules.subscribe({},()=>{assert.doesNotThrow(()=>h.engine.read());});await h.session.run(()=>h.request('X'));assert.equal(h.a.trace.length,initial+1);assert.equal(h.a.trace.at(-1).event.type,'patch');assert.equal(h.a.current.content.text,'X😀b');await h.settle();assert.notEqual(h.storage.state.phase,'error');assert.equal(h.storage.state.pending,0);assert.equal(irrelevant,0);unrelated.dispose();irrelevantSession.dispose();observer.dispose();},
 'cancel-stale':async h=>{let resolve,signal;const pending=h.session.run(s=>{signal=s;return new Promise(r=>resolve=r);});h.session.cancel();assert(signal.aborted);resolve(h.request('late'));assert.equal((await pending).status,'cancelled');assert.equal(h.commits(),0);
 let resolve2;const stale=h.session.run(()=>new Promise(r=>resolve2=r));await h.commands.run(()=>h.request('fresh'));resolve2(h.request('stale'));assert.equal((await stale).status,'stale');assert.equal(text(h.engine),'fresh😀b');},
 'dispose':async h=>{let resolve;const pending=h.session.run(()=>new Promise(r=>resolve=r));const count=h.a.trace.length;h.session.dispose();h.session.dispose();assert.equal(h.a.disposed,1);assert.equal(h.a.cancelled,1);assert.equal(h.session.active,false);resolve(h.request());assert.equal((await pending).status,'cancelled');await h.commands.run(()=>h.request());assert.equal(h.a.trace.length,count);assert.throws(()=>h.session.update(),/disposed/);},
 'capability-readonly':async h=>{h.state.update({readOnly:true});h.session.update();assert.equal((await h.session.run(()=>h.request())).status,'unavailable');assert.equal(h.commits(),0);h.state.update({readOnly:false});let resolve;const pending=h.session.run(()=>new Promise(r=>resolve=r));h.state.update({readOnly:true});resolve(h.request());assert.equal((await pending).status,'unavailable');assert.equal(h.commits(),0);},
 'theme-fallback':async h=>{assert.equal(h.a.current.theme,'fixture-dark');assert.equal(h.a.current.capabilities.host,h.a.host);assert.equal(h.session.representation('text/markdown').fallback,true);assert.equal((await h.session.run(()=>h.request('new'))).status,'committed');const id=h.a.current.nodeId;h.engine.history({type:'undo'});assert.equal(text(h.engine),'a😀b');assert.equal(h.a.current.nodeId,id);},
};
for(const host of manifest.hosts)for(const obligation of manifest.obligations)test('PRES-'+host.id+'-'+obligation,async()=>{
 const id='PRES-'+host.id+'-'+obligation,h=await harness(host.id);
 try{await obligations[obligation](h);facts.coverage.push(id);}finally{await h.close();}
});
test('complete adapter manifest rejects missing duplicate invalid and zero coverage',()=>{
 assert.equal(api.PRESENTER_API_VERSION,1);assert.deepEqual(api.PRESENTER_HOSTS,manifest.hosts.map(h=>h.id));
 const adapters=manifest.hosts.map(h=>adapter(h.id));api.validatePresenterAdapters(adapters);
 assert.throws(()=>api.validatePresenterAdapters([]),/Missing/);assert.throws(()=>api.validatePresenterAdapters(adapters.slice(1)),/Missing/);
 assert.throws(()=>api.validatePresenterAdapters([...adapters,adapters[0]]),/duplicate/);
 assert.throws(()=>api.validatePresenterAdapters([{...adapters[0],input:null},...adapters.slice(1)]),/method/);
 assert(manifest.hosts.every(h=>h.owner&&h.actualPlatformEvidence==='pending-downstream'));
 assert.deepEqual(Object.keys(obligations),manifest.obligations);
});
test('throwing update/cancel/dispose isolates callbacks and releases resources',async()=>{
 const h=await harness('browser');try{
  h.a.update=()=>{throw Error('renderer failed');};h.a.cancel=()=>{throw Error('cancel failed');};h.a.dispose=()=>{throw Error('dispose failed');};
  assert.equal((await h.session.run(()=>h.request())).status,'committed');assert.equal(text(h.engine),'X😀b');
  assert.equal(h.session.active,false);assert.equal(h.modules.takeErrors()[0].phase,'subscription');
  await h.commands.run(()=>h.request('Y'));assert.equal(text(h.engine),'Y😀b');
 }finally{await h.close();}
});
test('invalid capability and oversized input fail before attachment and detach adapter',async()=>{
 const h=await harness('browser');try{h.session.dispose();
  for(const input of [{...h.snapshot(),capabilities:api.PRESENTER_CAPABILITIES.terminal},{...h.snapshot(),theme:'x'.repeat(1048577)}]){
   const a=adapter('browser');assert.throws(()=>new api.ExtensionPresenterSession(h.modules,a,()=>input,h.host,{}));assert.equal(a.disposed,1);
  }
 }finally{await h.close();}
});
test('packed presenter declarations are consumable without private source imports',async()=>{
 const source=`import {ExtensionPresenterSession,PRESENTER_CAPABILITIES,type PresenterAdapterV1,type PresenterInputV1,type PresenterUpdateV1,type PresenterFocusV1,type PresenterInputEventV1,type PresenterAccessibilityV1,type PresenterRepresentationV1,type PresenterCapabilitiesV1} from '@edit-ac/web/modules';
const capabilities: PresenterCapabilitiesV1 = PRESENTER_CAPABILITIES['swift-ios'];
declare const adapter: PresenterAdapterV1; declare const session: ExtensionPresenterSession;
const result: PresenterAccessibilityV1 = adapter.accessibility(); session.focus({owner:'editor',restore:true});\n`;
 await writeFile(join(consumer,'types.ts'),source);await copyFile(join(consumer,'types.ts'),join(output,'types.ts'));
 await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM','types.ts'],consumer,'packed-types');
});

test('public imports are inert without browser globals or transports',async()=>{
 await writeFile(join(consumer,'inert.mjs'),`const forbidden=()=>{throw Error('implicit presenter activity');};for(const key of ['window','document','navigator','indexedDB'])Object.defineProperty(globalThis,key,{get:forbidden});globalThis.fetch=forbidden;globalThis.WebAssembly=new Proxy(WebAssembly,{get:forbidden});const api=await import('@edit-ac/web/modules');if(api.PRESENTER_HOSTS.length!==5)throw Error('missing hosts');`);
 await run(process.execPath,['inert.mjs'],consumer,'inert-import');
});
test('invalid focus/input/accessibility/representation cannot escape bounded protocol',async()=>{
 for(const mode of ['focus','input','accessibility','representation']){const h=await harness('browser');try{
 if(mode==='focus')assert.throws(()=>h.session.focus({owner:'unknown',restore:true}),/focus/);
 else if(mode==='accessibility'){h.a.accessibility=()=>({label:'ok',actions:Array(65).fill('x'),readOnly:false});assert.throws(()=>h.session.accessibility(),/bounded/);}
 else if(mode==='input')assert.throws(()=>h.session.input({type:'composition-update',text:'x'.repeat(65537)}),/bounded/);
 else{h.a.representation=()=>({mime:'text/plain',text:'x'.repeat(1048577),fallback:true});assert.throws(()=>h.session.representation('text/plain'),/bounded/);}
 assert.equal(h.session.active,false);assert.equal(h.a.disposed,1);assert.equal(h.commits(),0);
 }finally{await h.close();}}
});

test('runtime disposal and changing stable target suppress pending preparations',async()=>{
 for(const mode of ['runtime-dispose','target-change']){const h=await harness('browser');try{
 let resolve;const pending=h.session.run(()=>new Promise(r=>resolve=r));
 if(mode==='runtime-dispose')h.modules.dispose();else{const snapshot=h.snapshot;h.session.dispose();const a=adapter('browser');let changed=false;const s=new api.ExtensionPresenterSession(h.modules,a,()=>({...snapshot(),nodeId:changed?'different':h.node.id}),h.host,{});
 let next;const targetPending=s.run(()=>new Promise(r=>next=r));changed=true;next(h.request());assert.equal((await targetPending).status,'stale');s.dispose();}
 resolve(h.request());assert.equal((await pending).status,'cancelled');assert.equal(h.commits(),0);
 }finally{await h.close();}}
});
