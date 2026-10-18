import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {output,evidence,save,check} from './harness.mjs';
process.env.EDITAC_FORMATS_BROWSER_RECEIPT='browser-odt-media-receipt.json';
const source=Array.from(readFileSync(resolve(output,'odt-import-fixtures/media.odt')));
const pixel=Array.from(readFileSync('fixtures/formats/docx/probe/pixel.png'));
const hash=Array.from(createHash('sha256').update(Uint8Array.from(pixel)).digest());
const lossSource=Array.from(readFileSync(resolve(output,'odt-import-fixtures/media-loss.odt')));
const fixtures=Object.fromEntries(['supported','remote','encrypted','corrupt','hostile','nodes'].map(n=>[n,Array.from(readFileSync(resolve(output,'odt-import-fixtures/'+n+'.odt')))]));
const input={source,pixel,hash,lossSource,fixtures};
async function setup(page){await page.evaluate(async input=>{
 const {openEditorStorage}=await import('@edit-ac/web');
 const {CheckpointStorage}=await import('/@edit-ac/web/dist/storage/checkpoint.js');
 const {UpdateJournal}=await import('/@edit-ac/web/dist/storage/journal.js');
 const {createFormatClient}=await import('@edit-ac/formats');
 window.mediaSetup=async(reused)=>{
  const {engine:initial}=make(),checkpoint=initial.checkpoint();initial.dispose();
  const databaseName='odt-media-'+crypto.randomUUID();const db=await CheckpointStorage.open(indexedDB,databaseName);await db.publish(checkpoint,[]);db.close();
  const options={identity:checkpoint.identity,databaseName,indexedDB,locks:navigator.locks,assetUrl:new URL('/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm',location.href).href};
  const owner=await openEditorStorage(options),engine=owner.engine,assets=await owner.enableAssets();
  const at=engine.anchor(engine.read().visible[0].id,0,'right'),end=engine.anchor(engine.read().visible[0].id,4,'left');
  const grant={identity:{host:'fixture-host',key:'odt-original-png'},actions:['ingest','read','cancel','release-reference']};
  const importGrant={...grant,sha256:input.hash};
  const sourceGrant={identity:{host:'local-recovery',key:'complete-odt-package'},actions:['ingest','read','cancel','release-reference']};
  const client=reused??createFormatClient(),job='odt_'+crypto.randomUUID();let calls=[];
  const prepare=extra=>client.prepareImport(engine,{format:'odt',source:Uint8Array.from(input.source),range:{anchor:at,focus:end},approveLoss:true,importGrants:[importGrant],...extra});
  const snapshot=()=>({visible:engine.read().visible,revision:engine.read().revision,history:engine.history({type:'state'}),bytes:Array.from(engine.checkpoint().bytes)});
  const entries=async()=>{const j=await UpdateJournal.open(indexedDB,databaseName);try{return await j.read(options.identity);}finally{j.close();}};
  const host={authorize:async r=>{calls.push(['authorize',r.operationId]);return {identity:r.identity,actions:grant.actions};},execute:async(ref,r,bytes)=>{calls.push(['execute',r.operationId,ref,bytes?Array.from(bytes):null]);return null;}};
  const close=async(preserve=false)=>{if(!preserve)client.dispose();await owner.destroy({policy:'flush',assetPolicy:'suspend'});};
  return {owner,engine,assets,grant,sourceGrant,importGrant,client,job,prepare,snapshot,entries,options,calls,host,close};
 };
 window.mediaInput=input;
},input);}
function mediaTest(name,body){test(name,async()=>check(name,async page=>{await setup(page);return body(page);}));}
mediaTest('ODT media real packed worker, atomic owner adoption, one history event and exact originals survive reopen',async page=>{
 const r=await page.evaluate(async()=>{
  const f=await mediaSetup(),before=f.snapshot();const sibling={...f.grant,identity:{host:'fixture-host',key:'sibling'}};
  await f.assets.stageOriginal('sibling_job','sibling_original',{version:1,operationId:'sibling_ingest',identity:sibling.identity,action:'ingest',byteLimit:mediaInput.pixel.length},sibling,Uint8Array.from(mediaInput.pixel));
  const siblingBefore=(await f.assets.inspect()).prepared.find(p=>p.job==='sibling_job');
  const p=await f.prepare();const preparedUnchanged=JSON.stringify(before)===JSON.stringify(f.snapshot());
  let updates=0;const sub=f.engine.subscribe({type:'updates'},()=>updates++);const completion=await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);sub.dispose();
  const after=f.snapshot(),journal=await f.assets.inspect(),entries=await f.entries();const live=after.visible.find(n=>n.blockAttributes?.[0]==='module:editac.asset');
  const retained=Array.from(await f.assets.preparedSource(f.job,f.job+'_original_0',f.grant));
  const retainedPackage=Array.from(await f.assets.preparedSource(f.job,f.job+'_source',f.sourceGrant));
  const effectsBefore=0;
  f.engine.history({type:'undo'});const undone=text(f.engine);f.engine.history({type:'redo'});const redone=f.snapshot();await f.owner.flush({target:'local'});
  await f.assets.fenceJob(f.job);const afterFence=await f.assets.inspect();
  const siblingAfter=afterFence.prepared.find(p=>p.job==='sibling_job');
  await f.close();const {openEditorStorage}=await import('@edit-ac/web');const reopened=await openEditorStorage(f.options),assets=await reopened.enableAssets();
  const result={before,preparedUnchanged,completion,after,updates,journal,entries,retained,retainedPackage,live,effectsBefore,calls:f.calls,undone,redone,siblingBefore,siblingAfter,reopened:reopened.engine.read().visible,reopenedPackage:Array.from(await assets.preparedSource(f.job,f.job+'_source',f.sourceGrant)),reopenedOriginal:Array.from(await assets.preparedSource(f.job,f.job+'_original_0',f.grant)),original:Array.from(p.original),blocks:p.blocks,diagnostics:p.diagnostics,metrics:p.metrics,afterFence};
  await reopened.destroy({policy:'flush',assetPolicy:'suspend'});return result;
 });
 assert.equal(r.preparedUnchanged,true);assert.equal(r.completion.localCommit.state,'localCommitted');assert.equal(r.updates,1);assert.equal(r.after.history.undoGroups,1);assert.equal(r.effectsBefore,0);assert.deepEqual(r.retained,pixel);assert.deepEqual(r.reopenedOriginal,pixel);assert.deepEqual(r.original,source);assert.deepEqual(r.retainedPackage,source);assert.deepEqual(r.reopenedPackage,source);assert.deepEqual(r.reopened,r.redone.visible);assert.equal(r.undone,'base');assert.deepEqual(r.redone.visible,r.after.visible);assert.deepEqual(r.siblingAfter,r.siblingBefore);assert.equal(r.live.blockAttributes[2].identity.key,'odt-original-png');assert.deepEqual(r.calls[1].slice(0,2),['execute',r.calls[0][1]]);assert.deepEqual(r.calls[1][3],pixel);
 writeFileSync(resolve(output,'browser-odt-media-projection.json'),JSON.stringify(r,null,2)+'\n');
 return r;
});
mediaTest('ODT media hash and grant denials retain exact package and do not stage or mutate',async page=>{
 const r=await page.evaluate(async()=>{const f=await mediaSetup(),before=f.snapshot(),out=[];for(const kind of ['missing','wrong-hash','denied','duplicate']){
  const grants=kind==='missing'?[]:kind==='wrong-hash'?[{...f.importGrant,sha256:Array(32).fill(0)}]:kind==='denied'?[{...f.importGrant,actions:['read']}]:[f.importGrant,f.importGrant];
  try{await f.prepare({importGrants:grants});out.push({kind,unexpected:true});}catch(e){out.push({kind,code:e.code,original:Array.from(e.original),recovery:!!e.recovery});}
 }const unchanged=JSON.stringify(before)===JSON.stringify(f.snapshot()),journal=await f.assets.inspect();await f.close();return {out,unchanged,journal};});
 assert.equal(r.unchanged,true);assert.equal(r.journal.prepared.length,0);for(const v of r.out){assert.ok(v.code);assert.ok(v.recovery);assert.deepEqual(v.original,source);assert.equal(v.unexpected,undefined);}
 return r;
});
mediaTest('ODT media stale target fences only its job without live or sibling mutation',async page=>{
 const r=await page.evaluate(async()=>{const f=await mediaSetup(),p=await f.prepare();const n=f.engine.read().visible[0],at=f.engine.anchor(n.id,0,'right');f.engine.commit(f.engine.prepare({kind:'editor',origin:'later',commands:[{type:'insert',at,text:'later'}]}));const before=f.snapshot();let code;try{await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);}catch(e){code=e.code;}const after=f.snapshot(),journal=await f.assets.inspect();await f.close();return {code,before,after,journal};});
 assert.equal(r.code,'StaleTarget');assert.deepEqual(r.before,r.after);assert.equal(r.journal.prepared.length,0);assert.ok(r.journal.fencedJobs.length);
 return r;
});
mediaTest('ODT media early and active client cancellation durably fence retained jobs',async page=>{
 const rows=await page.evaluate(async()=>{const rows=[];for(const phase of ['early','staged','commit']){const f=await mediaSetup(),p=await f.prepare(),before=f.snapshot();let trapped=0,restore;
  if(phase==='early')f.client.cancel();
  if(phase==='staged'){const old=f.assets.stageOriginal.bind(f.assets);f.assets.stageOriginal=async(...args)=>{const r=await old(...args);if(args[1].endsWith('_original_0')){trapped++;f.client.cancel();}return r;};}
  if(phase==='commit'){const old=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){const r=old.apply(this,args);if(this.name==='updates'){trapped++;f.client.cancel();}return r;};restore=()=>{IDBObjectStore.prototype.add=old;};}
  let error;try{await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);}catch(e){error={code:e.code,recovery:!!e.recovery,original:Array.from(e.original)};}finally{restore?.();}
  const after=f.snapshot(),journal=await f.assets.inspect();let retained=null;if(journal.prepared.some(p=>p.reference===f.job+'_original_0'))retained=Array.from(await f.assets.preparedSource(f.job,f.job+'_original_0',f.grant));rows.push({phase,error,before,after,journal,retained,trapped});await f.close();}return rows;});
 for(const r of rows){assert.ok(r.error);assert.ok(r.error.recovery);assert.deepEqual(r.error.original,source);assert.deepEqual(r.before,r.after);assert.ok(r.journal.fencedJobs.length);if(r.phase!=='early'){assert.ok(r.trapped);assert.deepEqual(r.retained,pixel);}}
 return rows;
});
mediaTest('ODT media stage and combined storage failures roll back content and retain recoverable input',async page=>{
 const rows=await page.evaluate(async()=>{const rows=[];for(const phase of ['stage','commit']){const f=await mediaSetup(),p=await f.prepare(),before=f.snapshot();const method=phase==='stage'?'put':'add',old=IDBObjectStore.prototype[method];let trapped=0;
  IDBObjectStore.prototype[method]=function(...args){if(!trapped&&this.name===(phase==='stage'?'assets':'updates')){trapped++;throw new DOMException('fixture write failure','QuotaExceededError');}return old.apply(this,args);};
  let error;try{await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);}catch(e){error={code:e.code,report:e.report,recovery:!!e.recovery,original:Array.from(e.original)};}finally{IDBObjectStore.prototype[method]=old;}
  const after=f.snapshot(),journal=await f.assets.inspect();let retained=null;if(journal.prepared.some(p=>p.reference===f.job+'_original_0'))retained=Array.from(await f.assets.preparedSource(f.job,f.job+'_original_0',f.grant));rows.push({phase,error,trapped,before,after,journal,retained});await f.close();}return rows;});
 for(const r of rows){assert.equal(r.trapped,1);assert.ok(r.error);assert.ok(r.error.recovery);assert.deepEqual(r.error.original,source);assert.deepEqual(r.before,r.after);if(r.phase==='commit')assert.deepEqual(r.retained,pixel);else assert.equal(r.journal.prepared.length,0);}
 return rows;
});
mediaTest('ODT media requires async owner adoption, captures immutable grants and rejects duplicate completion',async page=>{
 const r=await page.evaluate(async()=>{const f=await mediaSetup(),grants=[structuredClone(f.importGrant)],promise=f.prepare({importGrants:grants});grants[0].actions.length=0;grants[0].identity.key='tampered';const p=await promise;p.original.fill(0);p.blocks.length=0;p.mediaCandidates.length=0;const completion=await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);const retainedPackage=Array.from(await f.assets.preparedSource(f.job,f.job+'_source',f.sourceGrant));let duplicate;try{await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);}catch(e){duplicate=e.code;}const g=await mediaSetup(),q=await g.prepare();let sync;try{q.commit();}catch(e){sync=e.code;}await g.close();await f.close();return {sync,completion,duplicate,retainedPackage};});
 assert.deepEqual(r.retainedPackage,source);assert.equal(r.sync,'AssetOwnerRequired');assert.equal(r.duplicate,'Finished');assert.equal(r.completion.localCommit.state,'localCommitted');
 return r;
});
mediaTest('ODT media complete cold and warm costs include storage stage adoption source read and reopen',async page=>{
 const rows=await page.evaluate(async()=>{const {createFormatClient}=await import('@edit-ac/formats');const client=createFormatClient(),rows=[];for(const phase of ['cold','warm']){const start=performance.now(),heapBefore=performance.memory.usedJSHeapSize;const f=await mediaSetup(client),p=await f.prepare(),completion=await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);await f.owner.flush({target:'local'});const journal=await f.assets.inspect();await f.close(true);const {openEditorStorage}=await import('@edit-ac/web');const owner=await openEditorStorage(f.options),assets=await owner.enableAssets(),retained=await assets.preparedSource(f.job,f.job+'_original_0',f.grant),retainedPackage=await assets.preparedSource(f.job,f.job+'_source',f.sourceGrant),visible=owner.engine.read().visible;await owner.destroy({policy:'flush',assetPolicy:'suspend'});rows.push({phase,completeMs:performance.now()-start,heapBefore,heapAfter:performance.memory.usedJSHeapSize,metrics:p.metrics,sourceBytes:p.original.length,reopenedSourceBytes:retainedPackage.length,originalBytes:retained.length,journalBytes:JSON.stringify(journal).length,completion,visible,scope:'storage bootstrap + worker decode/map + durable original stage + real shared atomic content/adoption + flush + close + reopen + exact original read + explicit mock ingest; warm reuses the compiled optional module'});}client.dispose();return rows;});
 for(const r of rows){assert.ok(r.completeMs>0);assert.equal(r.sourceBytes,source.length);assert.equal(r.reopenedSourceBytes,source.length);assert.equal(r.originalBytes,pixel.length);assert.ok(r.metrics.wasmLinearBytes<=67108864);}evidence.odtMediaResources=rows;save();
 return rows;
});
mediaTest('ODT media explicit denied failed and interrupted ingest never reaches live content',async page=>{
 const rows=await page.evaluate(async()=>{const rows=[];for(const phase of ['deny','host-failure','cancel-authorize','cancel-execute','timeout-authorize']){const f=await mediaSetup(),p=await f.prepare({timeoutMs:2000}),before=f.snapshot();let attempted=0;
  const host={authorize:async(r,signal)=>{attempted++;if(phase==='timeout-authorize')await new Promise(resolve=>signal.aborted?resolve():signal.addEventListener('abort',resolve,{once:true}));if(phase==='deny')return {identity:r.identity,actions:['read']};if(phase==='cancel-authorize')f.client.cancel();return {identity:r.identity,actions:f.grant.actions};},execute:async(ref,r,bytes,signal)=>{attempted++;if(phase==='host-failure')throw Error('prepared host failure');if(phase==='cancel-execute'){f.client.cancel();await new Promise(resolve=>signal.aborted?resolve():signal.addEventListener('abort',resolve,{once:true}));}return null;}};
  let error;try{await p.commitAssets(f.owner,f.job,host,f.sourceGrant);}catch(e){error={code:e.code,recovery:!!e.recovery,original:Array.from(e.original)};}
  const after=f.snapshot(),journal=await f.assets.inspect(),retained=Array.from(await f.assets.preparedSource(f.job,f.job+'_original_0',f.grant));rows.push({phase,error,attempted,before,after,journal,retained});await f.close();}return rows;});
 for(const r of rows){assert.ok(r.error);assert.ok(r.attempted);assert.deepEqual(r.before,r.after);assert.deepEqual(r.retained,pixel);assert.deepEqual(r.error.original,source);assert.ok(r.error.recovery);assert.ok(r.journal.fencedJobs.length);}
 return rows;
});

mediaTest('ODT media immutable complete unsupported report cannot bypass loss approval',async page=>{
 const r=await page.evaluate(async()=>{const f=await mediaSetup(),before=f.snapshot();const p=await f.prepare({source:Uint8Array.from(mediaInput.lossSource),approveLoss:false}),diagnostics=structuredClone(p.diagnostics);p.diagnostics.length=0;let error;try{await p.commitAssets(f.owner,f.job,f.host,f.sourceGrant);}catch(e){error={code:e.code,original:Array.from(e.original),recovery:!!e.recovery};}const after=f.snapshot(),journal=await f.assets.inspect();await f.close();return {before,after,diagnostics,error,journal};});
 assert.ok(r.diagnostics.some(d=>d.lossy));assert.equal(r.error.code,'LossApprovalRequired');assert.deepEqual(r.error.original,lossSource);assert.ok(r.error.recovery);assert.deepEqual(r.before,r.after);assert.equal(r.journal.prepared.length,0);return r;
});

mediaTest('ODT text-only path and remote image diagnostics use the same real worker without ambient authority',async page=>{
 const rows=await page.evaluate(async()=>{const rows=[];for(const name of ['supported','remote']){const f=await mediaSetup(),before=f.snapshot(),p=await f.prepare({source:Uint8Array.from(mediaInput.fixtures[name]),importGrants:[]});const preparedUnchanged=JSON.stringify(before)===JSON.stringify(f.snapshot());const completion=p.commit(),visible=f.engine.read().visible;const recovered=runtime.restoreEngine(p.recovery.identity,p.recovery);rows.push({name,preparedUnchanged,completion,visible,diagnostics:p.diagnostics,original:Array.from(p.original),recovered:text(recovered),calls:f.calls});recovered.dispose();await f.close();}return rows;});
 for(const r of rows){assert.ok(r.preparedUnchanged);assert.deepEqual(r.original,fixtures[r.name]);assert.equal(r.recovered,'base');assert.equal(r.calls.length,0);assert.ok(r.visible.some(n=>n.blockAttributes?.[0]==='module:editac.table'));assert.ok(!r.visible.some(n=>n.blockAttributes?.[0]==='module:editac.asset'));if(r.name==='remote')assert.ok(r.diagnostics.some(d=>d.code==='EXTERNAL_OR_UNSUPPORTED_IMAGE_INERT'));}return rows;
});
mediaTest('ODT encrypted corrupt hostile excessive nodes and worker cancellation preserve complete input and live state',async page=>{
 const rows=await page.evaluate(async()=>{const f=await mediaSetup(),before=f.snapshot(),rows=[];for(const name of ['encrypted','corrupt','hostile','nodes']){try{await f.prepare({source:Uint8Array.from(mediaInput.fixtures[name])});rows.push({name,unexpected:true});}catch(e){rows.push({name,code:e.code,report:e.report,original:Array.from(e.original),recovery:!!e.recovery});}}
 for(const name of ['early','active','timeout']){const c=new AbortController();if(name==='early')c.abort();const pending=f.prepare({signal:c.signal,timeoutMs:name==='timeout'?1:10000});if(name==='active')c.abort();try{await pending;rows.push({name,unexpected:true});}catch(e){rows.push({name,code:e.code,original:Array.from(e.original),recovery:!!e.recovery});}}
 const after=f.snapshot();await f.close();return {rows,before,after};});
 writeFileSync(resolve(output,'browser-odt-failure-projection.json'),JSON.stringify(rows,null,2)+'\n');
 assert.deepEqual(rows.before,rows.after);for(const r of rows.rows){assert.ok(r.code,r.name);if(r.name!=='early')assert.ok(r.recovery);else assert.equal(r.recovery,false); assert.deepEqual(r.original,fixtures[r.name]??source);if(r.name==='encrypted')assert.equal(r.report.reason,'ODF_ENCRYPTED');}return rows;
});
mediaTest('ODT packed worker denies ambient fetch and rebuilt WASM enforces linear ceiling and input byte cap',async page=>{
 const waiting=page.waitForEvent('worker');await page.evaluate(()=>{window.probe=new Worker('/@edit-ac/formats/dist/worker.js',{type:'module'});});const worker=await waiting;
 const denied=await worker.evaluate(async()=>{try{await fetch('/forbidden-publication-resource');return false;}catch{return true;}});await page.evaluate(()=>probe.terminate());assert.ok(denied);
 const r=await page.evaluate(async()=>{const {default:init}=await import('/@edit-ac/formats/dist/runtime/editac_formats_wasm.js');const wasm=await init({module_or_path:new URL('/@edit-ac/formats/dist/runtime/editac_formats_wasm_bg.wasm',location.href)}),before=wasm.memory.buffer.byteLength;let refused=false;try{wasm.memory.grow(1025-before/65536);}catch{refused=true;}const after=wasm.memory.buffer.byteLength;
 const f=await mediaSetup(),snapshot=f.snapshot();let error;try{await f.prepare({source:new Uint8Array(1048577)});}catch(e){error={code:e.code,bytes:e.original.length};}const unchanged=JSON.stringify(snapshot)===JSON.stringify(f.snapshot());await f.close();return {before,after,refused,error,unchanged};});
 assert.ok(r.refused);assert.equal(r.before,r.after);assert.ok(r.after<=67108864);assert.equal(r.error.code,'ResourceLimit');assert.equal(r.error.bytes,1048577);assert.ok(r.unchanged);return {denied,...r};
});
