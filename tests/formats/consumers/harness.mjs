import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,statSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
export const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
export const packed=JSON.parse(readFileSync(resolve(output,'packed-artifacts.json')));
const root=resolve(packed.consumer,'node_modules');
export const docxFixture=JSON.parse(readFileSync('tests/formats/consumers/docx-fixture.json'));
export const epubFixture=JSON.parse(readFileSync('tests/formats/consumers/epub-fixture.json'));
export const odtFixture=JSON.parse(readFileSync('tests/formats/consumers/odt-fixture.json'));
export const pdfFixtures=JSON.parse(readFileSync('tests/formats/consumers/pdf-fixtures.json'));
export let server,controller,browser,url,publicationProbeRequests=0;
function sampleMemory(){
 if(!controller)return null;
 const r=spawnSync('/bin/ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'});if(r.status!==0)return null;
 const rows=r.stdout.trim().split('\n').map(l=>{const [pid,ppid,kib]=l.trim().split(/\s+/).map(Number);return {pid,ppid,bytes:kib*1024};});
 const ids=new Set([controller.process().pid]);let more=true;while(more){more=false;for(const p of rows)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);more=true;}}
 const processes=rows.filter(p=>ids.has(p.pid));return {time:Date.now(),sumRssBytes:processes.reduce((n,p)=>n+p.bytes,0),processes};
}
export const evidence={cases:[],processes:[],resources:[],remoteRequests:[],workers:0,cleanup:{},scope:'CNV-1.18 C1/DI-T/DX/OX/EX/PX actual packed Chromium workers and live shared Session/AssetSession; original parent remains open for missing directions and targets'};
export const save=()=>writeFileSync(resolve(output,process.env.EDITAC_FORMATS_BROWSER_RECEIPT ?? 'browser-receipt.json'),JSON.stringify(evidence,null,2)+'\n');
before(async()=>{
 server=createServer((req,res)=>{
  let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(name==='/forbidden-publication-resource'){publicationProbeRequests++;res.writeHead(403).end();return;}
  if(name==='/'||name==='/disabled/'){const prefix=name==='/disabled/'?'/disabled':'';res.setHeader('Content-Type','text/html');res.end(`<script type="importmap">{"imports":{"@edit-ac/core":"${prefix}/@edit-ac/core/dist/index.js","@edit-ac/formats":"${prefix}/@edit-ac/formats/dist/index.js","@edit-ac/web":"${prefix}/@edit-ac/web/dist/index.js","@edit-ac/core/extensions":"${prefix}/@edit-ac/core/dist/extensions/index.js","@edit-ac/web/assets":"${prefix}/@edit-ac/web/dist/sync/assets.js"}}</script><body>Local packed format consumer</body>`);return;}
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
export async function check(name,body){const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(url))evidence.remoteRequests.push(r.url());});page.on('worker',()=>evidence.workers++);
 const fact={name,runtimeCompleted:false};evidence.cases.push(fact);
 const memorySamples=[sampleMemory()];const sampler=setInterval(()=>memorySamples.push(sampleMemory()),50);
 try{await page.goto(url);await page.evaluate(async()=>{
   const {init}=await import('@edit-ac/core');const {createFormatClient}=await import('@edit-ac/formats');
   window.runtime=await init(new URL('/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm',location.href).href);
   window.nextFixture=1;window.make=()=>{const engine=runtime.createEngine({profile:'v5',documentId:'27000000-0000-4000-8000-'+String(window.nextFixture++).padStart(12,'0'),epoch:'27000000-0000-4000-8000-000000000000',nodes:[{text:'base'}]});const node=engine.read().visible[0].id;const a=engine.anchor(node,0,'right');const z=engine.anchor(node,4,'left');return {engine,client:createFormatClient(),range:{anchor:a,focus:z}};};
   window.text=e=>e.read().visible.map(n=>n.runs.map(r=>r.text).join('')).join('\n');window.enc=s=>new TextEncoder().encode(s);window.dec=b=>new TextDecoder().decode(b);
 });const value=await body(page);assert.deepEqual(errors,[]);assert.deepEqual(evidence.remoteRequests,[]);fact.runtimeCompleted=true;fact.result=value;return value;
 }finally{clearInterval(sampler);memorySamples.push(sampleMemory());fact.memory={method:'50ms ps RSS samples of controller browser tree; shared RSS may double count; includes startup/session/conversion/transfer/commit/reopen; sampled peak, not allocator hard limit',samples:memorySamples.filter(Boolean)};await context.close();save();}}
