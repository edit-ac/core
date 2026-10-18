import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { cases } from '../tests/extension-dx/structural-callout-cases.mjs';
assert.equal(process.versions.node,'24.19.0');
const output=resolve(process.argv[2] ?? '../architecture/evidence/local-consumer-return/20261018/callout/checks/run-1');
await mkdir(output,{recursive:false});
const sha=data=>createHash('sha256').update(data).digest('hex');
const facts={scope:'local-only',published:false,releaseQualified:false,cases:[],packs:[],sources:[],cleanup:{},node:process.versions.node};
const run=(command,args,cwd,log)=>{const r=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env}});return writeFile(join(output,log),(r.stdout??'')+'\n'+(r.stderr??'')).then(()=>{assert.equal(r.status,0,log);return r.stdout;});};
async function inventory(root,base=root){const out={};for(const item of await readdir(root,{withFileTypes:true})){const p=join(root,item.name);if(item.isDirectory())Object.assign(out,await inventory(p,base));else if(item.isFile())out[relative(base,p)]=sha(await readFile(p));else throw Error('Nonregular installed member');}return out;}
const temporary=await mkdtemp(join(output,'consumer-'));let server,controller,browser;
try {
 const manifest=JSON.parse(await readFile('../architecture/evidence/local-consumer-return/20261018/local-candidates-v3.json','utf8'));
 const sdk=manifest.candidates.find(c=>c.id==='sdk-framework-v1');
 const engineManifest=JSON.parse(await readFile(resolve(process.argv[3]),'utf8'));facts.engineBuild=engineManifest;
 for(const pin of engineManifest.sources)assert.equal(sha(await readFile(pin.path)),pin.sha256,'Engine build source changed');
 const generated=[];
 for(const name of ['core','web','markdown']){
  const stage=join(temporary,'stage',name);await mkdir(stage,{recursive:true});
  for(const file of ['package.json','README.md','LICENSE','dist'])await cp(resolve('packages',name,file),join(stage,file),{recursive:true});
  if(name==='web')await cp(resolve('packages',name,'NOTICE'),join(stage,'NOTICE'));
  if(name!=='web')await cp(resolve('packages',name,'THIRD-PARTY-NOTICES.txt'),join(stage,'THIRD-PARTY-NOTICES.txt'));
  // Authenticate and reuse generated production bindings/WASM, never foreign mutable dist.
  const owner=sdk.packages.find(p=>p.name==='@edit-ac/'+name);
  if(name==='core'){for(const pin of engineManifest.files){const data=await readFile(resolve(engineManifest.directory,pin.name));assert.equal(sha(data),pin.sha256);await writeFile(join(stage,'dist/wasm',pin.name),data);generated.push({package:'@edit-ac/core',member:'package/dist/wasm/'+pin.name,sha256:pin.sha256,provenance:'current-production-build'});}}
  for(const member of Object.keys(owner.members).filter(m=>name!=='core'&&m.includes('/dist/wasm/'))){
   const archive=resolve('../architecture/evidence/local-consumer-return/20261018',owner.path),r=spawnSync('tar',['-xOf',archive,member],{maxBuffer:16*1024*1024});assert.equal(r.status,0);assert.equal(sha(r.stdout),owner.members[member]);const dest=join(stage,member.replace('package/',''));await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,r.stdout);generated.push({package:'@edit-ac/'+name,member,sha256:sha(r.stdout),ownerArchive:owner.sha256});
  }
  const dir=join(output,'packages',name);await mkdir(dir,{recursive:true});
  const packed=JSON.parse(await run('npm',['pack','--ignore-scripts','--json','--pack-destination',dir],stage,'pack-'+name+'.log'))[0],path=join(dir,packed.filename);
  facts.packs.push({name:'@edit-ac/'+name,version:packed.version,path,sha256:sha(await readFile(path)),members:await inventory(stage)});
 }
 facts.generated=generated;
 await writeFile(join(temporary,'package.json'),' {"private":true,"type":"module"}');
 await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',...facts.packs.map(p=>p.path)],temporary,'installed.log');
 for(const pack of facts.packs){const installed=await inventory(join(temporary,'node_modules',pack.name));const r=spawnSync('tar',['-tzf',pack.path],{encoding:'utf8'});assert.equal(r.status,0);const members=r.stdout.trim().split('\n').filter(n=>!n.endsWith('/'));const actual={};for(const member of members){const x=spawnSync('tar',['-xOf',pack.path,member],{maxBuffer:16*1024*1024});assert.equal(x.status,0);actual[member.replace('package/','')]=sha(x.stdout);}assert.deepEqual(installed,actual);pack.members=Object.fromEntries(Object.entries(actual).map(([n,h])=>['package/'+n,h]));}
 facts.installedMembersMatch=true;
 const fixture=join(temporary,'fixture');await mkdir(fixture);for(const name of ['session.mjs','index.html'])await cp(resolve('tests/extension-dx/structural-callout-consumer',name),join(fixture,name));await cp(resolve('examples/extensions/structural-callout/recipe.mjs'),join(fixture,'recipe.mjs'));
 const publicDir=join(temporary,'public');await mkdir(publicDir);await cp(join(fixture,'index.html'),join(publicDir,'index.html'));
 const bundled=await build({entryPoints:[join(fixture,'session.mjs')],outfile:join(publicDir,'session.js'),bundle:true,format:'esm',platform:'browser',metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(bundled.metafile.inputs).filter(p=>p.includes('packages/')).length===0,'No workspace aliases');await writeFile(join(output,'bundle-metafile.json'),JSON.stringify(bundled.metafile,null,2));
 await mkdir(join(publicDir,'wasm'));for(const name of ['core','markdown']){const from=join(temporary,'node_modules/@edit-ac',name,'dist/wasm');await cp(from,join(publicDir,'wasm'),{recursive:true});const wasm=name==='core'?'editac_wasm_bg.wasm':'editac_markdown_wasm_bg.wasm';await cp(join(from,wasm),join(publicDir,name==='core'?'engine.wasm':'markdown.wasm'));}
 for(const path of ['examples/extensions/structural-callout/recipe.mjs','tests/extension-dx/structural-callout-cases.mjs','tests/extension-dx/structural-callout-consumer/session.mjs','scripts/test-structural-callout.mjs']){const data=await readFile(path);facts.sources.push({path,sha256:sha(data)});await mkdir(join(output,'frozen-sources',resolve(path,'..').replace(process.cwd()+'/','')),{recursive:true});await writeFile(join(output,'frozen-sources',path),data);}
 facts.requests=[];
 server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;assert.ok(!path.includes('..'));const file=join(publicDir,path==='/'?'index.html':path);const body=await readFile(file);res.setHeader('Content-Type',extname(file)==='.wasm'?'application/wasm':extname(file)==='.html'?'text/html':'text/javascript');res.end(body);}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));facts.server={pid:process.pid,port:server.address().port,workspace:process.cwd(),purpose:'LCR-1.2 installed structural callout',log:output};
 controller=await chromium.launchServer({headless:true});facts.browser={pid:controller.process().pid};browser=await chromium.connect(controller.wsEndpoint());facts.browser.version=browser.version();
 for(const test of cases){const context=await browser.newContext(),page=await context.newPage(),record={name:test.name,passed:false,errors:[]};facts.cases.push(record);page.setDefaultTimeout(10000);page.on('pageerror',e=>record.errors.push(e.message));await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1')return route.abort();facts.requests.push(u.pathname);return route.continue();});
  try{await page.goto(`http://127.0.0.1:${facts.server.port}`);await page.waitForFunction(()=>!!window.callout,{timeout:15000});record.observed=await test.run(page);assert.deepEqual(record.errors,[]);record.passed=true;}catch(error){record.error=String(error.stack??error);record.failureState=await page.evaluate(()=>window.callout?.owned.filter(e=>e.state.ready).map(e=>e.read())).catch(()=>[]);await page.screenshot({path:join(output,`failure-${facts.cases.length}.png`)}).catch(()=>{});}finally{try{await page.evaluate(()=>window.callout?.close());}catch(error){record.cleanupError=String(error);record.passed=false;}await context.close();}
 }
} catch(error){facts.setupError=String(error.stack??error);} finally {
 await browser?.close();await controller?.close();facts.cleanup.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;
 if(server)await new Promise(r=>server.close(r));facts.cleanup.serverClosed=true;await rm(temporary,{recursive:true,force:true});facts.cleanup.temporaryConsumerRemoved=true;
 facts.counts={executed:facts.cases.length,passed:facts.cases.filter(c=>c.passed).length,failed:facts.cases.filter(c=>!c.passed).length,skipped:0,omitted:cases.length-facts.cases.length};
 await writeFile(join(output,'receipt.json'),JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify({counts:facts.counts,setupError:facts.setupError,failures:facts.cases.filter(c=>!c.passed).map(c=>({name:c.name,error:c.error,cleanupError:c.cleanupError})),cleanup:facts.cleanup}));
}
if(facts.setupError||facts.counts.executed!==cases.length||facts.counts.failed||facts.counts.skipped||facts.counts.omitted)process.exitCode=1;
