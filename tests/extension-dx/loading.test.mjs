import { installExtensionCounters } from '../browser/mobile-extensions/resources.mjs';
import { installResourceCounters } from '../mobile-web/resources.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { browserHarness } from '../browser/browser-harness.ts';
import { prepareLoadingConsumer, assertLightweight, assertOneEngine } from './loading-consumer.mjs';

const sourcePaths=['tests/extension-dx/configuration-consumer/minimal.mjs','tests/consumers/mobile-extensions/graph.mjs','tests/browser/mobile-extensions/resources.mjs','tests/mobile-web/resources.mjs','scripts/build-extension-runtime.mjs','packages/web/src/modules/presenter-sequence.ts','packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts','packages/web/package.json','packages/web/src/editor.ts','packages/web/src/surface.ts','packages/web/src/index.ts','packages/web/src/extensions/configuration.ts','packages/web/src/extensions/resource.ts','packages/web/src/extensions/markdown-resource.ts','packages/web/src/extensions/math.ts','packages/web/src/extensions/assets.ts','packages/web/src/extensions/highlighting.ts','packages/web/src/modules/math.ts','packages/web/src/modules/math-definition.ts','packages/web/src/modules/code/presenter.ts','packages/web/src/dom/render.ts','packages/web/src/sync/configured.ts','packages/web/src/sync/attachment.ts','packages/web/src/sync/presence.ts','packages/web/package.json','scripts/test-extension-dx.mjs','tests/extension-dx/loading-consumer.mjs','tests/extension-dx/configuration-consumer/session.mjs'];
const {probe,facts}=browserHarness('loading',resolve('tests/extension-dx/configuration-consumer'),{
  markdown:true,autoMount:false,prepareConsumer:prepareLoadingConsumer,testFile:'tests/extension-dx/loading.test.mjs',sourcePaths,assertSourcesUnchanged:true,
  serverOptions:{recordRequests:true,cacheAssets:true},
  beforeNavigate:async(page,fact)=>{
    fact.serverRequestStart=facts.serverRequests.length;
    const syncFiles=['/sync/',...Object.entries(facts.graph.features).filter(([path])=>path.includes('/sync/')).flatMap(([,files])=>files.map(file=>file.split('/').at(-1)))];
    await page.addInitScript(syncFiles=>{
      const observations=window.loadingObservations={wasm:[],streaming:0,workers:0,terminated:0,syncTimers:[]};
      const fetch=window.fetch,stream=WebAssembly.instantiateStreaming,NativeWorker=window.Worker;
      window.fetch=function(input,...args){const url=String(input instanceof Request?input.url:input);if(url.includes('.wasm'))observations.wasm.push(url);return fetch.call(this,input,...args);};
      WebAssembly.instantiateStreaming=function(...args){observations.streaming++;return stream.apply(this,args);};
      window.Worker=class extends NativeWorker{constructor(...args){super(...args);observations.workers++;}terminate(){observations.terminated++;return super.terminate();}};
      for(const name of ['setTimeout','setInterval']){const original=window[name];window[name]=function(...args){const stack=new Error().stack??'';if(syncFiles.some(file=>stack.includes(file)))observations.syncTimers.push({name,stack});return original.apply(this,args);};}
    },syncFiles);
  },
  cleanup:page=>page.evaluate(async()=>{await window.configurationFixture?.close();await window.minimalFixture?.close();}),
});
const requests=fact=>facts.serverRequests.slice(fact.serverRequestStart);
function featureRequests(fact,pattern) {
  const outputs=Object.entries(facts.graph.features).filter(([path])=>pattern.test(path)).flatMap(([,outputs])=>outputs).map(path=>path.slice(path.indexOf('/bundle/')+1));
  return requests(fact).filter(r=>pattern.test(r.url)||outputs.some(path=>r.url.split('?')[0].endsWith('/'+path)));
}
function browserCase(name,action){test(name,()=>probe(name,async(page,fact)=>{await page.waitForFunction(()=>!!window.configurationFixture);await action(page,fact);}));}
function featureChunk(pattern){const entry=Object.entries(facts.graph.features).find(([path])=>pattern.test(path));assert.ok(entry);return entry[1][0].split('/').at(-1);}

test('SDK-1.12 installed native and bundler eager graphs exclude optional implementations; real eager control rejected',()=>{
  assertLightweight(facts.graph.eager);assertLightweight(facts.nativeGraph.eager);
  assert.equal(facts.graph.omittedOptionalInstallation,true);assert.equal(facts.controls.realEagerBundleRejected,true);
  assert.ok(Object.keys(facts.graph.features).length>=5);assert.equal(facts.graph.externalFeatures.length,4);assert.equal(facts.converters.length,2);
  assert.ok(facts.converters.every(cell=>cell.state==='unavailable'));
});

browserCase('provider-free two-mount typing and one history owner; disabled code and assets absent',async(page,fact)=>{
  const result=await page.evaluate(async()=>{
    const f=window.configurationFixture,a=await f.open({extensions:[]}),b=f.surface({extensions:[]});await b.surface.ready;
    f.replace(a,'Saved ');f.replace({...b.engine,anchor:(id,offset)=>b.engine.anchor(id,offset,'right'),commit:request=>b.engine.commit(b.engine.prepare(request))},'Borrowed ');
    f.select(a.root,0);const h=a.captureHistory();h.execute('undo');h.dispose();const undo=f.content(a),redo=a.captureHistory();redo.execute('redo');redo.dispose();
    return {text:[f.content(a),f.content(b.engine)],undo,local:a.collaborationStatus.state,borrowed:b.surface.collaborationStatus.state,observation:window.loadingObservations};
  });fact.snapshots.push(result);
  assert.deepEqual(result.text,['Saved Alpha beta','Borrowed Alpha beta']);assert.equal(result.undo,'Alpha beta');
  assert.equal(result.local,'idle');assert.equal(result.borrowed,'idle');assert.equal(result.observation.streaming,1);assert.equal(result.observation.workers,0);
  assert.equal(featureRequests(fact,/\/sync\/|\/modules\/math(?:-renderer)?\.js|\/modules\/code\/|katex|\/markdown\//).length,0);
  assert.equal(assertOneEngine(requests(fact)),facts.assets.engineSha256);
});

browserCase('compatible editor instances share exactly one engine initialization',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture;const [a,b]=await Promise.all([f.open({extensions:[]}),f.open({extensions:[]})]);return{same:await f.init(f.assetUrl)===f.runtime,ids:[a.read().identity.documentId,b.read().identity.documentId],observation:window.loadingObservations};});
  assert.equal(result.same,true);assert.notEqual(...result.ids);assert.equal(result.observation.streaming,1);assertOneEngine(requests(fact));fact.snapshots.push(result);
});

browserCase('incompatible engine identity rejected before a second asset request',async(page,fact)=>{
  const result=await page.evaluate(async()=>{try{await window.configurationFixture.init(window.configurationFixture.assetUrl+'?incompatible');return false;}catch{return true;}});
  assert.equal(result,true);assertOneEngine(requests(fact));
});

browserCase('duplicate-engine request negative control is rejected by asset identity oracle',async(page,fact)=>{
  await page.evaluate(()=>fetch(window.configurationFixture.assetUrl+'?duplicate-control').then(r=>r.arrayBuffer()));
  assert.throws(()=>assertOneEngine(requests(fact)),/duplicate engine/);fact.snapshots.push({negativeControl:'actual second engine asset fetch rejected',requests:requests(fact).filter(r=>r.url.includes('editac_wasm_bg.wasm'))});
});

browserCase('required Markdown both mounts share one pending codec then parse with real undo',async(page,fact)=>{
  let release;const gate=new Promise(r=>{release=r;});let count=0;
  await page.route('**/editac_markdown_wasm_bg.wasm',async route=>{count++;await gate;await route.continue();});
  try {
    await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();window.a=f.createEditor(f.root(),{...record,...f.options({extensions:[f.Markdown.configure()]})});f.editors.push(window.a);window.b=f.surface(f.options({extensions:[f.Markdown.configure()]}));});
    await page.waitForFunction(()=>window.a.extensionStatus['editac.markdown'].state==='loading'&&window.b.surface.extensionStatus['editac.markdown'].state==='loading');
    const pending=await page.evaluate(()=>[window.a.state.ready,window.a.root.contentEditable,window.b.host.contentEditable]);assert.deepEqual(pending,[false,'false','false']);
    await page.waitForFunction(()=>window.loadingObservations.wasm.some(url=>url.includes('editac_markdown')));release();
    const result=await page.evaluate(async()=>{const f=window.configurationFixture;await Promise.all([window.a.ready,window.b.surface.ready]);await f.paste(window.a,window.a.root,'**Parsed**');const before=window.a.read().visible.find(n=>n.kind==='block').runs;f.select(window.a.root,0);const h=window.a.captureHistory();h.execute('undo');h.dispose();const undo=f.content(window.a),r=window.a.captureHistory();r.execute('redo');r.dispose();return{before,undo,redo:f.content(window.a),streaming:window.loadingObservations.streaming};});
    assert.equal(result.before[0].text,'Parsed');assert.deepEqual(result.before[0].attributes,{bold:true});assert.equal(result.undo,'Alpha beta');assert.equal(result.redo,'Parsed');assert.equal(result.streaming,2);assert.equal(count,1);fact.snapshots.push(result);
  } finally {release();}
});

browserCase('command-lazy exporter permits typing before an explicit export',async(page,fact)=>{
  const before=await page.evaluate(async()=>{const f=window.configurationFixture;window.a=await f.open(f.options({extensions:[f.Markdown.configure({input:false})]}));f.replace(window.a,'Live ');return{state:window.a.extensionStatus['editac.markdown'].state,text:f.content(window.a),wasm:window.loadingObservations.wasm};});
  assert.equal(before.state,'idle');assert.equal(before.text,'Live Alpha beta');assert.equal(before.wasm.some(url=>url.includes('editac_markdown')),false);
  const after=await page.evaluate(async()=>{const result=await window.a.exportMarkdown([{attributes:{type:'paragraph'},runs:[{text:'Export',marks:[{mark:'bold'}]}]}]);return{markdown:result.markdown.trim(),state:window.a.extensionStatus['editac.markdown'].state,text:window.configurationFixture.content(window.a)};});
  assert.deepEqual(after,{markdown:'**Export**',state:'ready',text:'Live Alpha beta'});fact.snapshots.push({before,after});
});

browserCase('failed parser retains source and retries only after repaired asset delivery',async(page,fact)=>{
  let denied=true;await page.route('**/editac_markdown_wasm_bg.wasm',route=>denied?route.fulfill({status:503,body:'prepared asset denial'}):route.continue());
  const failure=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();window.a=f.createEditor(f.root(),{...record,...f.options({extensions:[f.Markdown.configure()]})});f.editors.push(window.a);let error;try{await window.a.ready;}catch(e){error=e.message;}return{error,text:window.a.root.textContent,state:window.a.extensionStatus['editac.markdown']};});
  assert.match(failure.error,/source retained/);assert.equal(failure.text,'Alpha beta');assert.equal(failure.state.state,'failed');
  denied=false;const result=await page.evaluate(async()=>{await window.a.loadExtension('editac.markdown');return{ready:window.a.state.ready,state:window.a.extensionStatus['editac.markdown'],text:window.configurationFixture.content(window.a)};});
  assert.equal(result.ready,true);assert.equal(result.state.generation,2);assert.equal(result.text,'Alpha beta');fact.snapshots.push({failure,result});
});

browserCase('three attempts bound failed parser retries without changing document or history',async(page,fact)=>{
  let count=0;await page.route('**/editac_markdown_wasm_bg.wasm',route=>{count++;return route.fulfill({status:503,body:'prepared permanent denial'});});
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();const a=f.createEditor(f.root(),{...record,...f.options({extensions:[f.Markdown.configure()]})});f.editors.push(a);try{await a.ready;}catch{}for(let i=0;i<2;i++){try{await a.loadExtension('editac.markdown');}catch{}}let error;try{await a.loadExtension('editac.markdown');}catch(e){error=e.message;}return{error,state:a.extensionStatus['editac.markdown'],text:a.root.textContent};});
  assert.match(result.error,/retry limit/);assert.equal(result.state.generation,3);assert.equal(result.state.retryable,false);assert.equal(result.text,'Alpha beta');assert.equal(count,3);fact.snapshots.push(result);
});

browserCase('disposing one pending parser does not cancel a compatible sibling',async(page,fact)=>{
  let release;const gate=new Promise(r=>{release=r;});let count=0;
  await page.route('**/editac_markdown_wasm_bg.wasm',async route=>{count++;await gate;await route.continue();});
  try {
    await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();window.a=f.createEditor(f.root(),{...record,...f.options({extensions:[f.Markdown.configure()]})});f.editors.push(window.a);window.b=f.surface(f.options({extensions:[f.Markdown.configure()]}));window.a.ready.catch(()=>{});});
    await page.waitForFunction(()=>window.loadingObservations.wasm.some(url=>url.includes('editac_markdown')));
    await page.evaluate(()=>window.a.destroy({policy:'report'}));release();
    const result=await page.evaluate(async()=>{await window.b.surface.ready;return{dead:window.a.extensionStatus['editac.markdown'].state,live:window.b.surface.extensionStatus['editac.markdown'].state,editable:window.b.host.contentEditable,text:window.configurationFixture.content(window.b.engine)};});
    assert.deepEqual(result,{dead:'cancelled',live:'ready',editable:'true',text:'Alpha beta'});assert.equal(count,1);fact.snapshots.push(result);
  } finally {release();}
});

for(const failure of ['MIME','CSP','CORS']) browserCase(`direct host ${failure} failure is explicit and retains original parser input`,async(page,fact)=>{
  if(failure==='MIME')await page.route('**/bad-codec.js',route=>route.fulfill({status:200,contentType:'text/plain',body:'export function loadMarkdownAdapter() {}'}));
  const result=await page.evaluate(async failure=>{
    const f=window.configurationFixture,record=await f.seed();
    let url=new URL('/fixture/bad-codec.js',location.href).href;
    if(failure==='CSP'){const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content="script-src 'none'";document.head.append(meta);}
    if(failure==='CORS'){const other=new URL(window.loadingPaths.markdown+'/web.js',location.href);other.hostname='localhost';url=other.href;}
    const a=f.createEditor(f.root(),{...record,extensions:[f.Markdown.configure()],assets:{manifest:{markdownModule:url}}});f.editors.push(a);let error;try{await a.ready;}catch(e){error=e.message;}
    return{error,text:a.root.textContent,status:a.extensionStatus['editac.markdown'].state,readOnly:a.root.contentEditable};
  },failure);
  assert.match(result.error,/MIME\/CSP\/CORS/);assert.equal(result.text,'Alpha beta');assert.equal(result.status,'failed');assert.equal(result.readOnly,'false');fact.snapshots.push(result);
});

browserCase('collaboration lazy load preserves local typing and denied-and-retried attachment history',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let allowed=false,calls=0,sends=0;const a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{connect:()=>{calls++;return{authorized:allowed,peerIdentity:record.identity,transport:{send:()=>{sends++;return true;}}};}}});f.editors.push(a);await a.ready;window.a=a;window.allow=()=>{allowed=true;};window.counters=()=>({calls,sends});f.replace(a,'Local ');return{text:f.content(a),ready:a.state.ready};});assert.equal(result.ready,true);assert.equal(result.text,'Local Alpha beta');
  await page.waitForFunction(()=>window.a.collaborationStatus.state==='failed');
  const after=await page.evaluate(async()=>{window.allow();await window.a.connectCollaboration();const f=window.configurationFixture;f.select(window.a.root,0);const h=window.a.captureHistory();h.execute('undo');h.dispose();const undo=f.content(window.a),r=window.a.captureHistory();r.execute('redo');r.dispose();await window.a.flush({target:'local'});return{undo,text:f.content(window.a),identity:window.a.read().identity,status:window.a.collaborationStatus.state,...window.counters()};});
  assert.equal(after.status,'ready');assert.equal(after.calls,2);assert.equal(after.undo,'Alpha beta');assert.equal(after.text,'Local Alpha beta');assert.ok(featureRequests(fact,/\/sync\/configured\.js/).length>=1);fact.snapshots.push(after);
});

browserCase('collaborative sibling creates no local-field provider, subscriptions, listeners or worker work',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('Local'),root=f.root();let subscriptions=0,listeners=0;
    const observe={...e,subscribe(...args){subscriptions++;return e.subscribe(...args);}};const add=root.addEventListener.bind(root);root.addEventListener=(...args)=>{listeners++;return add(...args);};
    const local=f.mountEditorSurface(root,observe,{extensions:[]});f.surfaces.push(local);await local.ready;const baseline={subscriptions,listeners};
    const record=await f.seed();let providers=0,sends=0;const remote=f.createEditor(f.root(),{...record,extensions:[],collaboration:{connect:()=>{providers++;return{authorized:true,peerIdentity:record.identity,transport:{send:()=>{sends++;return true;}}};}}});f.editors.push(remote);await remote.ready;await remote.connectCollaboration();
    f.replace({...e,anchor:(id,offset)=>e.anchor(id,offset,'right'),commit:request=>e.commit(e.prepare(request))},'Saved ');await local.settle();return{baseline,after:{subscriptions,listeners},localProvider:local.collaborationStatus.state,providers,sends,localText:f.content(e),workers:window.loadingObservations.workers,syncTimers:window.loadingObservations.syncTimers};});
  assert.deepEqual(result.after,result.baseline);assert.ok(result.baseline.subscriptions>0);assert.equal(result.localProvider,'idle');assert.equal(result.localText,'Saved Local');assert.equal(result.workers,0);assert.deepEqual(result.syncTimers,[]);assert.ok(result.providers>=1);fact.snapshots.push({ ...result,implementation:'SyncSession/presence are explicitly host-pumped; disabled local field has no connector or sync attachment' });
});

for(const boundary of ['configured','attachment']) browserCase(`dispose during pending ${boundary} import rejects stale provider work`,async(page,fact)=>{
  let release;const gate=new Promise(r=>{release=r;});let reached=false;
  const suffix=process.env.EDITAC_LOADING_HOST==='bundler'?featureChunk(new RegExp('/sync/'+boundary+'\\.js$')):boundary+'.js';
  await page.route('**/'+suffix,async route=>{reached=true;await gate;await route.continue();});
  try{
    await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let providers=0,sends=0;window.a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{connect:()=>{providers++;return{authorized:true,peerIdentity:record.identity,transport:{send:()=>{sends++;return true;}}};}}});f.editors.push(window.a);window.counters=()=>({providers,sends});await window.a.ready;});
    await page.waitForFunction(()=>window.a.collaborationStatus.state==='loading');
    for(let i=0;i<100&&!reached;i++)await new Promise(r=>setTimeout(r,10));assert.equal(reached,true);
    await page.evaluate(()=>window.a.destroy({policy:'report'}));release();await page.waitForTimeout(50);
    const result=await page.evaluate(()=>({...window.counters(),state:window.a.collaborationStatus.state,attachment:!!window.a.syncAttachment}));
    assert.equal(result.sends,0);assert.equal(result.attachment,false);assert.equal(result.state,'cancelled');assert.equal(result.providers,boundary==='configured'?0:1);fact.snapshots.push(result);
  }finally{release();}
});

browserCase('legacy attachSync and same-owner borrowed attachment preserve original replica',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed(),a=await f.open({extensions:[]});const identity=a.read().identity,first=await a.attachSync({authorized:true,peerIdentity:identity,transport:{send:()=>true}});first.detach();
    const owner=await f.openEditorStorage(record);f.storageOwners.push(owner);const host=f.root(),surface=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner});f.surfaces.push(surface);await surface.ready;
    const before=owner.engine.read().identity,attachment=await surface.attachSync({authorized:true,peerIdentity:before,transport:{send:()=>true}});f.replace({...owner.engine,anchor:(id,offset)=>owner.engine.anchor(id,offset,'right'),commit:request=>owner.commit(request)},'Borrowed ');attachment.detach();surface.dispose();const again=f.mountEditorSurface(host,owner.engine,{extensions:[],storageOwner:owner});f.surfaces.push(again);await again.ready;
    return{same:JSON.stringify(identity)===JSON.stringify(a.read().identity),borrowedSame:JSON.stringify(before)===JSON.stringify(owner.engine.read().identity),text:f.content(owner.engine),ready:a.state.ready};});
  assert.deepEqual(result,{same:true,borrowedSame:true,text:'Borrowed Alpha beta',ready:true});assertOneEngine(requests(fact));fact.snapshots.push(result);
});

browserCase('presence assets remain absent with awareness off and load only for the explicit sibling',async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();window.a=f.createEditor(f.root(),{...record,extensions:[],collaboration:{presence:{awareness:false,peerCarets:false},connect:()=>({authorized:true,peerIdentity:record.identity,transport:{send:()=>true}})}});f.editors.push(window.a);await window.a.ready;await window.a.connectCollaboration();});
  assert.equal(featureRequests(fact,/\/sync\/presence\.js$/).length,0);
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,record=await f.seed();let frames=0;const b=f.createEditor(f.root(),{...record,extensions:[],collaboration:{presence:{awareness:true,peerCarets:true},connect:()=>({authorized:true,peerIdentity:record.identity,transport:{send:()=>true},presence:{clientId:7,transport:{send:()=>{frames++;return true;}}}})}});f.editors.push(b);await b.ready;await b.connectCollaboration();const attached=!!b.syncAttachment.presence;await b.syncAttachment.pump(0);b.disconnectCollaboration();return{attached,frames,state:b.collaborationStatus.state,localState:window.a.collaborationStatus.state};});
  assert.equal(result.attached,true);assert.equal(result.state,'cancelled');assert.equal(result.localState,'ready');assert.ok(featureRequests(fact,/\/sync\/presence\.js$/).length>=1);fact.snapshots.push(result);
});

browserCase('configured presenter asset manifest loads each selected owner without host work or content changes', async (page, fact) => {
  const results = await page.evaluate(async () => {
    const f = window.configurationFixture;
    let calls = 0;
    const selected = [f.DocumentSearch.configure(), f.BlockReorder.configure(), f.Images.configure(), f.Tables.configure(),
      f.SlashCommands.configure({ commands: [{ id: 'safe', label: 'Safe', prepare() { calls++; return undefined; } }] }),
      f.References.configure({ host() { calls++; return []; } })];
    const results = [];
    for (const extension of selected) {
      const editor = await f.open(f.options({ extensions: [extension] }));
      const feature = extension.feature.id.split('.').at(-1);
      results.push({ feature, state: editor.extensionStatus[extension.feature.id].state,
        text: f.content(editor), presenter: ['search', 'reorder', 'slash', 'references'].includes(feature) ? !!editor[feature] : true });
      await editor.destroy({ policy: 'report' });
    }
    return { results, calls };
  });
  assert.equal(results.calls, 0, 'opening presenters never calls optional hosts');
  assert.deepEqual(results.results.map(row => row.feature), ['search','reorder','images','tables','slash','references']);
  for (const row of results.results) assert.deepEqual(row, { feature: row.feature, state: 'ready', text: 'Alpha beta', presenter: true });
  fact.presenterAssets = results;
});

browserCase('mixed bundled legacy and asset-loaded presenters have distinct accessible IDs', async (page, fact) => {
  const result = await page.evaluate(async () => {
    const f = window.configurationFixture, host = () => [], commands = [{ id: 'safe', label: 'Safe', prepare: () => undefined }];
    const legacy = f.surface({ search: f.documentSearch(), slash: f.slashCommands(commands), references: f.referenceSuggestions(host) });
    const managed = f.surface(f.options({ extensions: [f.DocumentSearch.configure(), f.SlashCommands.configure({ commands }), f.References.configure({ host })] }));
    await Promise.all([legacy.surface.ready, managed.surface.ready]);
    return { ids: [legacy.surface.slash.menu.id, legacy.surface.references.menu.id, managed.surface.slash.menu.id, managed.surface.references.menu.id],
      texts: [f.content(legacy.engine), f.content(managed.engine)], distinct: legacy.surface.search !== managed.surface.search };
  });
  assert.equal(new Set(result.ids).size, 4);
  assert.deepEqual(result.texts, ['Alpha beta', 'Alpha beta']); assert.equal(result.distinct, true);
  fact.mixedPresenterIds = result;
});

browserCase('math implementation and KaTeX load on first selected presentation with source unchanged',async(page,fact)=>{
  assert.equal(featureRequests(fact,/\/modules\/math(?:-renderer)?\.js|katex/).length,0);
  await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('');f.fill(e,[{attributes:{type:'paragraph'},runs:[{text:'LaTeX source: x^2',marks:[],attributes:{'module:editac.math':[1,{latex:'x^2',display:false}]}}]}]);window.mathSource=JSON.stringify(e.read().visible);window.mathEngine=e;window.b=f.mountEditorSurface(f.root(),e,f.options({extensions:[f.MathNotation.configure()]}));f.surfaces.push(window.b);await window.b.ready;});
  await page.waitForFunction(()=>document.querySelector('[data-math-state="rendered"] math'));
  const result=await page.evaluate(()=>({same:window.mathSource===JSON.stringify(window.mathEngine.read().visible),text:window.configurationFixture.content(window.mathEngine),errors:window.b.moduleRuntime.takeErrors()}));assert.equal(result.same,true);assert.equal(result.text,'LaTeX source: x^2');assert.deepEqual(result.errors,[]);assert.ok(featureRequests(fact,/\/modules\/math-renderer\.js|katex/).length>=1);fact.snapshots.push(result);
});

browserCase('math host override failure retains semantic source without renderer work',async(page,fact)=>{
  await page.route('**/bad-math.js',route=>route.fulfill({status:404,body:'prepared missing renderer'}));
  await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('');f.fill(e,[{attributes:{type:'paragraph'},runs:[{text:'LaTeX source: x',marks:[],attributes:{'module:editac.math':[1,{latex:'x',display:false}]}}]}]);window.mathEngine=e;window.b=f.mountEditorSurface(f.root(),e,{extensions:[f.MathNotation.configure()],assets:{manifest:{mathModule:new URL('/fixture/bad-math.js',location.href).href}}});f.surfaces.push(window.b);await window.b.ready;});
  await page.waitForFunction(()=>document.querySelector('[data-math-state="source"]'));
  assert.equal(await page.evaluate(()=>window.configurationFixture.content(window.mathEngine)),'LaTeX source: x');assert.equal(featureRequests(fact,/katex|\/modules\/math-renderer\.js/).length,0);
});

browserCase('explicitly disabled managed highlighting creates no presenter, backend or worker request',async(page,fact)=>{
  const result=await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('const disabled = 1;'),id=e.read().visible.find(n=>n.kind==='block').id;e.commit(e.prepare({kind:'editor',origin:'local:fixture',commands:[{type:'setCode',owner:id,language:'typescript'}]}));const factory=f.managedCodeHighlighting({enabled:false});let handle;const surface=f.mountEditorSurface(f.root(),e,{codeHighlight:renderer=>(handle=factory(renderer))});f.surfaces.push(surface);await surface.ready;return{state:handle.status.state,text:f.content(e),workers:window.loadingObservations.workers};});
  assert.deepEqual(result,{state:'idle',text:'const disabled = 1;',workers:0});assert.equal(featureRequests(fact,/\/modules\/code\//).length,0);fact.snapshots.push(result);
});

browserCase('managed highlighting uses qualified independent worker/backend and tears down owned resources',async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('const value = 42;'),id=e.read().visible.find(n=>n.kind==='block').id;e.commit(e.prepare({kind:'editor',origin:'local:fixture',commands:[{type:'setCode',owner:id,language:'typescript'}]}));const paths=window.loadingPaths;
    const factory=f.managedCodeHighlighting({assets:window.loadingManifest});
    window.b=f.mountEditorSurface(f.root(),e,{codeHighlight:renderer=>(window.highlight=factory(renderer))});f.surfaces.push(window.b);window.codeEngine=e;await window.b.ready;});
  await page.waitForFunction(()=>{const state=document.querySelector('pre')?.dataset.highlightState;return state&&state!=='loading';});
  const before=await page.evaluate(()=>({state:document.querySelector('pre').dataset.highlightState,text:window.configurationFixture.content(window.codeEngine),observation:{...window.loadingObservations}}));
  assert.ok(['highlighted','unsupported-browser'].includes(before.state));assert.equal(before.text,'const value = 42;');
  const after=await page.evaluate(()=>{window.b.dispose();return{status:window.highlight.status.state,observation:window.loadingObservations,styles:document.querySelectorAll('style').length};});
  assert.equal(after.status,'cancelled');assert.equal(after.styles,0);assert.equal(after.observation.workers,after.observation.terminated);
  if(before.state==='highlighted')assert.ok(requests(fact).some(r=>r.url.includes('editac_highlighting_bg.wasm')&&r.sha256===facts.highlighting.backendSha256));
  fact.snapshots.push({before,after});
});

browserCase('disposing a pending highlighting presenter creates no worker or late style',async(page,fact)=>{
  let release;const gate=new Promise(r=>{release=r;});let reached=false;
  const suffix='presenter.js';
  await page.route('**/'+suffix,async route=>{reached=true;await gate;await route.continue();});
  try{
    await page.evaluate(async()=>{const f=window.configurationFixture,e=f.engine('const late = 1;'),id=e.read().visible.find(n=>n.kind==='block').id;e.commit(e.prepare({kind:'editor',origin:'local:fixture',commands:[{type:'setCode',owner:id,language:'typescript'}]}));const factory=f.managedCodeHighlighting({assets:window.loadingManifest});window.b=f.mountEditorSurface(f.root(),e,{codeHighlight:renderer=>(window.highlight=factory(renderer))});f.surfaces.push(window.b);await window.b.ready;});
    for(let i=0;i<100&&!reached;i++)await new Promise(r=>setTimeout(r,10));assert.equal(reached,true);await page.evaluate(()=>window.b.dispose());release();await page.waitForTimeout(50);
    const result=await page.evaluate(()=>({state:window.highlight.status.state,workers:window.loadingObservations.workers,styles:document.querySelectorAll('style').length}));assert.deepEqual(result,{state:'cancelled',workers:0,styles:0});fact.snapshots.push(result);
  }finally{release();}
});

browserCase('bundled-public-default-has-zero-optional-work-requests-and-retains-real-storage-history', async (page, fact) => {
  await page.evaluate(() => window.configurationFixture.close());
  await page.addInitScript(installExtensionCounters); await page.addInitScript(installResourceCounters);
  const start = fact.requests.length;
  await page.goto(new URL(facts.minimalGraph.url, fact.origin).href);
  await page.waitForFunction(() => !!window.minimalFixture);
  const baseline = await page.evaluate(() => window.mobileResources());
  await page.evaluate(async () => { await window.minimalFixture.mount(); window.minimalFixture.select(); });
  // One browser insertText event is one history operation; word-by-word typing
  // deliberately has the existing whitespace history boundaries.
  await page.keyboard.insertText('Saved ');
  const edited = await page.evaluate(async () => {
    const f = window.minimalFixture; await f.editor.settle(); const typed = f.text();
    const undo = f.editor.captureHistory(); undo.execute('undo'); undo.dispose(); const undone = f.text();
    const redo = f.editor.captureHistory(); redo.execute('redo'); redo.dispose();
    await f.editor.flush({ target: 'local' }); const redone = f.text(); await f.close(); await f.mount();
    return { typed, undone, redone, reopened: f.text(), status: f.editor.extensionStatus, optional: window.mobileExtensionResources() };
  });
  assert.deepEqual(edited, { typed: 'Saved Alpha beta', undone: 'Alpha beta', redone: 'Saved Alpha beta', reopened: 'Saved Alpha beta', status: {}, optional: { listeners: 0, allocations: [] } });
  await page.evaluate(async () => { await window.minimalFixture.close(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const after = await page.evaluate(() => ({ resources: window.mobileResources(), optional: window.mobileExtensionResources() }));
  assert.deepEqual(after, { resources: baseline, optional: { listeners: 0, allocations: [] } });
  const requests = fact.requests.slice(start);
  assert.equal(requests.filter(url => facts.minimalGraph.optionalOutputs.some(path => url.split('?')[0].endsWith('/' + path))).length, 0, 'disabled optional chunk requested');
  assert.equal(requests.filter(url => /\/extensions\/runtime\/|dictionary|highlight|katex/.test(url)).length, 0);
  fact.minimalDefault = { edited, baseline, after, requests, graph: facts.minimalGraph };
});
