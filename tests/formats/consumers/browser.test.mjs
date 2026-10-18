import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const packed=JSON.parse(readFileSync(resolve(output,'packed-artifacts.json')));
const root=resolve(packed.consumer,'node_modules');
const docxFixture=JSON.parse(readFileSync('tests/formats/consumers/docx-fixture.json'));
let server,controller,browser,url;
function sampleMemory(){
 if(!controller)return null;
 const r=spawnSync('/bin/ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'});if(r.status!==0)return null;
 const rows=r.stdout.trim().split('\n').map(l=>{const [pid,ppid,kib]=l.trim().split(/\s+/).map(Number);return {pid,ppid,bytes:kib*1024};});
 const ids=new Set([controller.process().pid]);let more=true;while(more){more=false;for(const p of rows)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);more=true;}}
 const processes=rows.filter(p=>ids.has(p.pid));return {time:Date.now(),sumRssBytes:processes.reduce((n,p)=>n+p.bytes,0),processes};
}
const evidence={cases:[],processes:[],resources:[],remoteRequests:[],workers:0,cleanup:{},scope:'CNV-1.18-C1 RTF/CSV/TSV actual packed Chromium worker; original parent remains open for other directions and targets'};
const save=()=>writeFileSync(resolve(output,'browser-receipt.json'),JSON.stringify(evidence,null,2)+'\n');
before(async()=>{
 server=createServer((req,res)=>{
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(name==='/'||name==='/disabled/'){const prefix=name==='/disabled/'?'/disabled':'';res.setHeader('Content-Type','text/html');res.end(`<script type="importmap">{"imports":{"@edit-ac/core":"${prefix}/@edit-ac/core/dist/index.js","@edit-ac/formats":"${prefix}/@edit-ac/formats/dist/index.js","@edit-ac/web/assets":"${prefix}/@edit-ac/web/dist/sync/assets.js"}}</script><body>Local packed format consumer</body>`);return;}
  const directory=name.startsWith('/disabled/')?resolve(packed.disabled,'node_modules'):root;if(name.startsWith('/disabled/'))name=name.slice('/disabled'.length);
  const file=resolve(directory,'.'+name);if(!file.startsWith(directory+sep)){res.writeHead(403).end();return;}
  try{const b=readFileSync(file);res.setHeader('Content-Type',extname(file)==='.wasm'?'application/wasm':extname(file)==='.js'?'text/javascript':'application/octet-stream');
   if(name.endsWith('/worker.js'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'");
   res.end(b);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
 evidence.server={pid:process.pid,port:server.address().port,workspace:process.cwd(),purpose:'immutable installed optional-format consumer',log:output};
 controller=await chromium.launchServer({headless:true,args:['--enable-precise-memory-info']});
 evidence.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'CNV1.18 C1 packed browser proof',log:output});
 browser=await chromium.connect(controller.wsEndpoint());evidence.browser={engine:'chromium',version:browser.version()};save();
});
after(async()=>{
 try{await browser?.close();}finally{try{await controller?.close();evidence.cleanup.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;}finally{
  const port=server?.address()?.port;await new Promise(r=>server?server.close(r):r());
  evidence.cleanup.listenerGone=await new Promise(r=>{if(!port)return r(true);const s=createConnection(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(false);});s.once('error',e=>r(e.code==='ECONNREFUSED'));});evidence.runtimeExecutions=evidence.cases.length+(evidence.disabled?1:0);evidence.acceptanceCounts='Authoritative Node TAP summaries include assertions after runtime callbacks; runtimeCompleted is not an acceptance pass.';save();
 }}
});
async function check(name,body){const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(url))evidence.remoteRequests.push(r.url());});page.on('worker',()=>evidence.workers++);
 const fact={name,runtimeCompleted:false};evidence.cases.push(fact);
 const memorySamples=[sampleMemory()];const sampler=setInterval(()=>memorySamples.push(sampleMemory()),50);
 try{await page.goto(url);await page.evaluate(async()=>{
   const {init}=await import('@edit-ac/core');const {createFormatClient}=await import('@edit-ac/formats');
   window.runtime=await init(new URL('/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm',location.href).href);
   window.nextFixture=1;window.make=()=>{const engine=runtime.createEngine({profile:'v5',documentId:'27000000-0000-4000-8000-'+String(window.nextFixture++).padStart(12,'0'),epoch:'27000000-0000-4000-8000-000000000000',nodes:[{text:'base'}]});const node=engine.read().visible[0].id;const a=engine.anchor(node,0,'right');const z=engine.anchor(node,4,'left');return {engine,client:createFormatClient(),range:{anchor:a,focus:z}};};
   window.text=e=>e.read().visible.map(n=>n.runs.map(r=>r.text).join('')).join('\n');window.enc=s=>new TextEncoder().encode(s);window.dec=b=>new TextDecoder().decode(b);
 });const value=await body(page);assert.deepEqual(errors,[]);assert.deepEqual(evidence.remoteRequests,[]);fact.runtimeCompleted=true;fact.result=value;return value;
 }finally{clearInterval(sampler);memorySamples.push(sampleMemory());fact.memory={method:'50ms ps RSS samples of controller browser tree; shared RSS may double count; includes startup/session/conversion/transfer/commit/reopen; sampled peak, not allocator hard limit',samples:memorySamples.filter(Boolean)};await context.close();save();}}
test('packed RTF actual worker/Session -> live fragment one undo group -> checkpoint reopen and independent RTF output',async()=>{
 const result=await check('rtf-semantic-lifecycle',page=>page.evaluate(async()=>{
  const {engine,client,range}=make();const before=text(engine);const revision=engine.read().revision;
  const p=await client.prepareImport(engine,{format:'rtf',source:enc('{\\rtf1\\ansi Hello \\b bold\\b0 \\u-10179?\\u-8638?}'),range});
  const unchanged=text(engine)===before&&engine.read().revision===revision;p.commit();const imported=text(engine);const history=engine.history({type:'state'});
  const cp=engine.checkpoint();const reopened=runtime.restoreEngine(cp.identity,cp);const reopenedText=text(reopened);reopened.dispose();
  const output=await client.export(engine,{format:'rtf'});const encoded=Array.from(output.bytes);engine.history({type:'undo'});const undo=text(engine);engine.history({type:'redo'});const redo=text(engine);
  client.dispose();engine.dispose();return {unchanged,imported,history,reopenedText,undo,redo,profile:p.profile,committed:p.sessionCommitted,blocks:p.blocks,encoded,metrics:p.metrics,exportMetrics:output.metrics};
 }));assert.equal(result.unchanged,true);assert.equal(result.committed,true);assert.match(result.imported,/Hello bold.*🙂/);assert.equal(result.history.undoGroups,1);assert.equal(result.reopenedText,result.imported);assert.equal(result.undo,'base');assert.equal(result.redo,result.imported);assert.ok(result.blocks[0].runs.some(r=>r.marks.some(m=>m.mark==='bold')));
 writeFileSync(resolve(output,'browser-supported.rtf'),Buffer.from(result.encoded));
});
test('CSV and TSV explicit dialects use shared tables; exact/safe selected export and non-table diagnostics',async()=>{
 const results=await check('table-exact-safe',page=>page.evaluate(async()=>{
  const all=[];for(const format of ['csv','tsv']){const {engine,client,range}=make();const separator=format==='csv'?',':'\t';const source=`"name"${separator}"value"\r\n"=1+1"${separator}"🙂,\"\"line\"\"\nnext"\r\n`;
   const p=await client.prepareImport(engine,{format,source:enc(source),range,newline:'crlf',header:true});const before=text(engine);p.commit();const table=engine.read().visible.find(n=>Array.isArray(n.blockAttributes)&&n.blockAttributes[0]==='module:editac.table');
   let headerLoss;try{await client.export(engine,{format,selected:table.id,newline:'crlf'});}catch(e){headerLoss=e.report.diagnostics;}
   const exact=await client.export(engine,{format,selected:table.id,newline:'crlf',approveLoss:true});const safe=await client.export(engine,{format,selected:table.id,newline:'crlf',safe:true,approveLoss:true});
   let ambiguous;try{await client.export(engine,{format,newline:'crlf'});}catch(e){ambiguous=e.code;}
   all.push({format,before,blocks:p.blocks,exact:dec(exact.bytes),safe:dec(safe.bytes),safeProfile:safe.profile,diagnostics:safe.diagnostics,headerLoss,ambiguous,metrics:p.metrics});client.dispose();engine.dispose();}
  return all;
 }));for(const r of results){assert.equal(r.before,'base');assert.match(r.exact,/"=1\+1"/);assert.match(r.safe,/"'=1\+1"/);assert.match(r.safeProfile,/spreadsheet-safe/);assert.ok(r.diagnostics.length);assert.ok(r.headerLoss.some(d=>d.code==='HEADER_FLAG_LOST_ROW_RETAINED'));assert.equal(r.ambiguous,'ConversionRejected');writeFileSync(resolve(output,`browser-exact.${r.format}`),r.exact);writeFileSync(resolve(output,`browser-safe.${r.format}`),r.safe);}
});
test('unsupported RTF retains structured diagnostics and bytes; explicit loss approval only; PDF magic rejects',async()=>{
 const r=await check('recovery-and-loss',page=>page.evaluate(async()=>{
  const {engine,client,range}=make();const source=enc('{\\rtf1 hi {\\*\\unknown private}}');const p=await client.prepareImport(engine,{format:'rtf',source,range});let refused;try{p.commit();}catch(e){refused=e.code;}
  const unchanged=text(engine);const approved=await client.prepareImport(engine,{format:'rtf',source,range,approveLoss:true});approved.commit();let pdf;
  try{await client.prepareImport(engine,{format:'rtf',source:enc('%PDF-1.7 fake'),range});}catch(e){pdf={code:e.code,original:dec(e.original)};}
  const image={runs:[{text:'fallback',marks:[]}],attributes:{type:'code',language:'js'}};
  const n=engine.read().visible[0];const ca=engine.anchor(n.id,0,'right'),cz=engine.anchor(n.id,n.runs.map(r=>r.text).join('').length,'left');
  engine.commit(engine.prepare({kind:'fragment',origin:'unsupported-export',range:{anchor:ca,focus:cz},blocks:[image]}));let exportedLoss;
  try{await client.export(engine,{format:'rtf'});}catch(e){exportedLoss={code:e.code,diagnostics:e.report.diagnostics};}
  const pdfHints=[];for(const hint of [{source:enc('prefix %PDF-1.7')},{filename:'misleading.PDF ',source:enc('not PDF')},{mediaType:'application/pdf; charset=utf-8',source:enc('not PDF')}]){try{await client.prepareImport(engine,{format:'rtf',range,...hint});}catch(e){pdfHints.push(e.code);}}
  const result={pdfHints,diagnostics:p.diagnostics,original:dec(p.original),refused,unchanged,imported:approved.blocks.map(b=>b.runs.map(r=>r.text).join('')).join(''),pdf,exportedLoss};client.dispose();engine.dispose();return result;
 }));assert.equal(r.refused,'LossApprovalRequired');assert.equal(r.unchanged,'base');assert.ok(r.diagnostics.length);assert.match(r.original,/private/);assert.match(r.imported,/hi/);assert.equal(r.pdf.code,'FORMAT_EXPORT_ONLY');assert.equal(r.pdf.original,'%PDF-1.7 fake');assert.equal(r.exportedLoss.code,'ConversionRejected');assert.ok(r.exportedLoss.diagnostics.length);assert.deepEqual(r.pdfHints,['FORMAT_EXPORT_ONLY','FORMAT_EXPORT_ONLY','FORMAT_EXPORT_ONLY']);
});
test('fixed export excludes later edits; late import rejects stale target without mutation',async()=>{
 const r=await check('revision-fences',page=>page.evaluate(async()=>{
  const {engine,client,range}=make();const p=await client.prepareImport(engine,{format:'rtf',source:enc('{\\rtf1 replace}'),range});
  const pending=client.export(engine,{format:'rtf'});const at=range.anchor;engine.commit(engine.prepare({kind:'editor',origin:'later',commands:[{type:'insert',at,text:'later'}]}));
  const before=text(engine);let stale;try{p.commit();}catch(e){stale=e.code;}
  const artifact=await pending;const recovered=runtime.restoreEngine(artifact.recovery.identity,artifact.recovery);const recoveredText=text(recovered);recovered.dispose();const out={stale,unchanged:before===text(engine),artifact:dec(artifact.bytes),recoveredText,oldRevision:artifact.revision,newRevision:engine.read().revision};client.dispose();engine.dispose();return out;
 }));assert.equal(r.stale,'StaleTarget');assert.equal(r.unchanged,true);assert.ok(!r.artifact.includes('later'));assert.ok(r.newRevision>r.oldRevision);assert.equal(r.recoveredText,'base');
});
test('cancel/busy/timeout/dispose and byte/parser exhaustion leave live state recoverable',async()=>{
 const r=await check('resource-and-cancellation',page=>page.evaluate(async()=>{
  const {engine,client,range}=make();const source=enc('{\\rtf1 data}');const outcomes={};const opts={format:'rtf',source,range};
  const abort=new AbortController();abort.abort();try{await client.prepareImport(engine,{...opts,signal:abort.signal});}catch(e){outcomes.pre=e.code;}
  const pending=client.prepareImport(engine,opts);try{await client.prepareImport(engine,opts);}catch(e){outcomes.busy=e.code;}const {createFormatClient}=await import('@edit-ac/formats');const second=createFormatClient(),third=createFormatClient();const secondPending=second.prepareImport(engine,opts);try{await third.prepareImport(engine,opts);}catch(e){outcomes.crossBusy=e.code;}second.cancel();try{await secondPending;}catch{}second.dispose();third.dispose();
  client.cancel();try{await pending;}catch(e){outcomes.cancel=e.code;outcomes.original=dec(e.original);}
  try{await client.prepareImport(engine,{...opts,source:new Uint8Array(1048577)});}catch(e){outcomes.bytes=e.code;}
  try{await client.prepareImport(engine,{...opts,source:enc('{\\rtf1 '+'{'.repeat(65)+'x'+'}'.repeat(66))});}catch(e){outcomes.depth=e.code;outcomes.detail=e.report.reason;}
  // Hold only this bundled asset: the real watchdog terminates a waiting worker.
  const other=(await import('@edit-ac/formats')).createFormatClient();const saved=window.fetch;window.fetch=(...args)=>String(args[0]).includes('editac_formats_wasm_bg.wasm')?new Promise(()=>{}):saved(...args);
  try{await other.prepareImport(engine,{...opts,timeoutMs:20});}catch(e){outcomes.timeout=e.code;}finally{window.fetch=saved;other.dispose();}
  const prepared=await client.prepareImport(engine,opts);client.cancel();try{prepared.commit();}catch(e){outcomes.preparedCancel=e.code;}
  client.dispose();try{await client.prepareImport(engine,opts);}catch(e){outcomes.disposed=e.code;}outcomes.current=text(engine);engine.dispose();return outcomes;
 }));assert.deepEqual([r.pre,r.busy,r.cancel,r.bytes,r.depth,r.timeout,r.disposed],['Cancelled','Busy','Cancelled','ResourceLimit','ConversionRejected','Timeout','Disposed']);assert.match(r.detail,/DEPTH|depth/i);assert.equal(r.current,'base');assert.match(r.original,/data/);assert.equal(r.preparedCancel,'Cancelled');assert.equal(r.crossBusy,'Busy');
});
test('complete cold/warm import+commit+reopen and export costs; maximum WASM memory is enforced',async()=>{
 const r=await check('complete-costs',page=>page.evaluate(async()=>{
  const {engine,client,range}=make();const measurements=[];
  for(const phase of ['cold','warm']){const {engine:e,range:r}=make();const start=performance.now();const before=performance.memory.usedJSHeapSize;
   const p=await client.prepareImport(e,{format:'rtf',source:enc('{\\rtf1 measured \\b bold\\b0}'),range:r});p.commit();const c=e.checkpoint();const reopen=runtime.restoreEngine(c.identity,c);const semantics=text(reopen);reopen.dispose();const out=await client.export(e,{format:'rtf'});
   measurements.push({phase,completeMs:performance.now()-start,heapBefore:before,heapAfter:performance.memory.usedJSHeapSize,import:p.metrics,export:out.metrics,outputBytes:out.bytes.length,semantics});e.dispose();}
  const {default:init}=await import('/@edit-ac/formats/dist/runtime/editac_formats_wasm.js');const wasm=await init({module_or_path:new URL('/@edit-ac/formats/dist/runtime/editac_formats_wasm_bg.wasm',location.href)});let bounded=false;try{wasm.memory.grow(1025);}catch(e){bounded=e instanceof RangeError;}client.dispose();engine.dispose();return {measurements,bounded};
 }));assert.equal(r.bounded,true);for(const m of r.measurements){assert.ok(m.completeMs>0);assert.ok(m.heapAfter>0);assert.ok(m.import.wasmLinearBytes<=67108864);assert.match(m.semantics,/measured bold/);assert.ok(m.outputBytes>0);}evidence.resources=r.measurements;save();
});

test('packed disabled consumer executes the SDK without format workers, runtime assets or package',async()=>{
 const context=await browser.newContext();const page=await context.newPage();const requests=[];let workers=0;page.on('request',r=>requests.push(r.url()));page.on('worker',()=>workers++);
 try{await page.goto(url+'/disabled/');const value=await page.evaluate(async()=>{const {init}=await import('@edit-ac/core');const r=await init(new URL('/disabled/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm',location.href).href);const e=r.createEngine({profile:'v5',documentId:'27000000-0000-4000-8000-000000000099',epoch:'27000000-0000-4000-8000-000000000000',nodes:[{text:'disabled'}]});const v=e.read().visible[0].runs[0].text;e.dispose();return v;});assert.equal(value,'disabled');assert.equal(workers,0);assert.ok(!requests.some(r=>/formats|\.(?:ttf|otf)$/.test(r)));evidence.disabled={requests,workers,passed:true};}
 finally{await context.close();save();}
});


test('packed DOCX export uses captured rich semantics and AssetSession-authorized exact originals',async()=>{
 const r=await check('docx-export-assets',page=>page.evaluate(async f=>{
  const {engine,client,range}=make();
  engine.commit(engine.prepare({kind:'fragment',origin:'docx-fixture',range,blocks:f.blocks}));
  const image=engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.asset');
  const {AssetSession}=await import('@edit-ac/web/assets');
  const databaseName='docx-'+crypto.randomUUID();const session=await AssetSession.open(engine,indexedDB,databaseName);
  const grant={identity:f.descriptor.identity,actions:['ingest','read']};
  const request={version:1,operationId:'retain_docx_original',identity:f.descriptor.identity,action:'ingest',byteLimit:f.pixel.length};
  const receipt=await session.enqueue(image.id,request,grant,Uint8Array.from(f.pixel));
  const bytes=await session.retainedSource(image.id,{identity:f.descriptor.identity,actions:['read']});
  let deniedRead=false;try{await session.retainedSource(image.id,{identity:f.descriptor.identity,actions:[]});}catch{deniedRead=true;}
  const start=performance.now();const originalAssets=[{identity:f.descriptor.identity,actions:['read'],bytes}];
  const pending=client.export(engine,{format:'docx',approveLoss:true,originalAssets});
  bytes.fill(0);originalAssets[0].identity={host:'changed',key:'changed'};
  const node=engine.read().visible[0].id;const a=engine.anchor(node,0,'right');engine.commit(engine.prepare({kind:'editor',origin:'later',commands:[{type:'insert',at:a,text:'LATER'}]}));engine.releaseAnchor(a);
  const result=await pending;const reopened=runtime.restoreEngine(result.recovery.identity,result.recovery);const captured=text(reopened);reopened.dispose();
  const value={bytes:Array.from(result.bytes),diagnostics:result.diagnostics,metrics:result.metrics,completeMs:performance.now()-start,deniedRead,receipt,captured,current:text(engine),oldRevision:result.revision,newRevision:engine.read().revision,linearBytes:result.metrics.wasmLinearBytes,assetCount:result.assetCount,originalAssetBytes:result.originalAssetBytes};
  await session.dispose('suspend');const recovered=await AssetSession.open(engine,indexedDB,databaseName);value.retainedAfterSuspend=Array.from(await recovered.retainedSource(image.id,{identity:f.descriptor.identity,actions:['read']}));value.recoveredIntents=(await recovered.inspect()).intents;await recovered.dispose('retire');client.dispose();engine.dispose();return value;
 },docxFixture));
 assert.deepEqual(r.retainedAfterSuspend,docxFixture.pixel);assert.ok(r.recoveredIntents.every(i=>i.status==='Pending'));assert.equal(r.deniedRead,true);assert.equal(r.receipt.kind,'assetOperation');assert.ok(r.current.includes('LATER'));assert.ok(!r.captured.includes('LATER'));assert.ok(r.newRevision>r.oldRevision);assert.equal(r.assetCount,1);assert.equal(r.originalAssetBytes,docxFixture.pixel.length);assert.ok(r.linearBytes<=67108864);assert.ok(r.diagnostics.some(d=>d.code==='PACKAGE_REGENERATED'));assert.deepEqual(r.diagnostics.filter(d=>d.lossy).map(d=>d.code).sort(),['IMAGE_ALT','IMAGE_CAPTION']);
 writeFileSync(resolve(output,'browser-supported.docx'),Buffer.from(r.bytes));
});
test('DOCX missing/denied/corrupt assets, loss reports and cancelled work retain the captured source',async()=>{
 const r=await check('docx-export-failures',page=>page.evaluate(async f=>{
  const {engine,client,range}=make();engine.commit(engine.prepare({kind:'fragment',origin:'docx-fixture',range,blocks:f.blocks}));
  const before=text(engine),revision=engine.read().revision,results=[];
  for(const mode of ['missing','denied','corrupt','foreign','excess']){
   let assets=mode==='missing'?[]:[{identity:mode==='foreign'?{host:'fixture-host',key:'foreign'}:f.descriptor.identity,actions:mode==='denied'?[]:['read'],bytes:mode==='excess'?new Uint8Array(1048577):mode==='corrupt'?new Uint8Array(f.pixel.length):Uint8Array.from(f.pixel)}];
   try{await client.export(engine,{format:'docx',approveLoss:true,originalAssets:assets});results.push({mode,unexpected:true});}catch(e){results.push({mode,code:e.code,reason:e.report.reason,recoverable:!!e.recovery});}
  }
  const abort=new AbortController();const pending=client.export(engine,{format:'docx',approveLoss:true,signal:abort.signal,originalAssets:[{identity:f.descriptor.identity,actions:['read'],bytes:Uint8Array.from(f.pixel)}]});abort.abort();let cancel;try{await pending;}catch(e){cancel={code:e.code,recoverable:!!e.recovery};}
  const unchanged=before===text(engine)&&revision===engine.read().revision;
  client.dispose();engine.dispose();
  const plain=make();const node=plain.engine.read().visible[0].id;const a=plain.engine.anchor(node,0,'right'),z=plain.engine.anchor(node,4,'left');
  plain.engine.commit(plain.engine.prepare({kind:'format',origin:'unsupported-mark',marks:[{mark:'code',action:'apply',range:{anchor:a,focus:z}}],blocks:[]}));
  let loss;try{await plain.client.export(plain.engine,{format:'docx'});}catch(e){loss={code:e.code,diagnostics:e.report.diagnostics,recoverable:!!e.recovery};}
  const approved=await plain.client.export(plain.engine,{format:'docx',approveLoss:true});plain.client.dispose();plain.engine.dispose();
  const rich=make();const table=await rich.client.prepareImport(rich.engine,{format:'csv',source:enc('A,B\n'),range:rich.range,newline:'lf',header:false});table.commit();let richLoss;try{await rich.client.export(rich.engine,{format:'docx'});}catch(e){richLoss={diagnostics:e.report.diagnostics,recoverable:!!e.recovery};}rich.client.dispose();rich.engine.dispose();
  return {results,cancel,unchanged,loss,richLoss,approvedDiagnostics:approved.diagnostics};
 },docxFixture));
 assert.equal(r.unchanged,true);assert.deepEqual(r.results.map(x=>x.code),['ConversionRejected','ConversionRejected','ConversionRejected','ConversionRejected','ResourceLimit']);assert.ok(r.results.every(x=>x.recoverable));assert.equal(r.cancel.code,'Cancelled');assert.equal(r.cancel.recoverable,true);assert.ok(r.loss.diagnostics.some(d=>d.lossy));assert.ok(r.approvedDiagnostics.some(d=>d.lossy));assert.equal(r.richLoss.recoverable,true);assert.ok(r.richLoss.diagnostics.some(d=>d.code==='UNSUPPORTED_CONTENT'&&d.lossy));
});
test('DOCX complete cold/warm snapshot/worker/artifact/reopen costs include original assets',async()=>{
 const r=await check('docx-export-costs',page=>page.evaluate(async f=>{
  const values=[];const {engine,client,range}=make();engine.commit(engine.prepare({kind:'fragment',origin:'docx-fixture',range,blocks:f.blocks}));
  const {AssetSession}=await import('@edit-ac/web/assets');const databaseName='docx-cost-'+crypto.randomUUID();const image=engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.asset');
  const initial=await AssetSession.open(engine,indexedDB,databaseName);await initial.enqueue(image.id,{version:1,operationId:'retain_cost_original',identity:f.descriptor.identity,action:'ingest',byteLimit:f.pixel.length},{identity:f.descriptor.identity,actions:['ingest']},Uint8Array.from(f.pixel));await initial.dispose('suspend');
  for(const phase of ['cold','warm']){const start=performance.now(),heapBefore=performance.memory.usedJSHeapSize;const assets=await AssetSession.open(engine,indexedDB,databaseName);const bytes=await assets.retainedSource(image.id,{identity:f.descriptor.identity,actions:['read']});const p=await client.export(engine,{format:'docx',approveLoss:true,originalAssets:[{identity:f.descriptor.identity,actions:['read'],bytes}]});const reopened=runtime.restoreEngine(p.recovery.identity,p.recovery);const captured=text(reopened);reopened.dispose();await assets.dispose('suspend');values.push({phase,completeMs:performance.now()-start,heapBefore,heapAfter:performance.memory.usedJSHeapSize,metrics:p.metrics,artifactBytes:p.bytes.length,captured,scope:'AssetSession open/reconcile/read authorization + retained byte read + immutable source capture + worker bootstrap/Session/writer/package/transfer + checkpoint reopen + service suspension; excludes preexisting document/asset authoring and independent validation'});}
  client.dispose();engine.dispose();return values;
 },docxFixture));for(const m of r){assert.ok(m.completeMs>0);assert.ok(m.artifactBytes>0);assert.match(m.captured,/DOCX 🙂 heading/);assert.ok(m.metrics.wasmLinearBytes<=67108864);}evidence.docxResources=r;save();
});
