import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { createHash } from 'node:crypto';

// Executes the exact minified resources inventoried by check:browser-size.
// This proves runtime viability, not byte admission or physical-device parity.
const output = resolve(process.env.EDITAC_BROWSER_SIZE_OUTPUT || '../architecture/evidence/browser-size-optimization/current');
for (const [engine, browserType] of Object.entries({chromium, firefox, webkit})) test(`${engine}: measured packed Task resources edit and recover without source fallbacks`, async () => {
 const manifest = JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
 const resources = new Map();
 for(const asset of manifest.assets) {
  const bytes=await readFile(join(output,'artifacts',asset.name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  resources.set('/'+asset.name, {bytes,kind:asset.kind});
 }
 const requests=[], facts={engine,processes:[],requests};let server,controller,browser;
 try {
  server=createServer((req,res)=>{
   requests.push(req.url);
   if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/task.css"><div id="editor" aria-label="Task"></div>');return;}
   const asset=resources.get(req.url);
   if(!asset){res.statusCode=404;res.end();return;}
   res.setHeader('Content-Type',{js:'text/javascript',wasm:'application/wasm',css:'text/css'}[asset.kind]||'application/octet-stream');res.end(asset.bytes);
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  facts.processes.push({pid:process.pid,workspace:process.cwd(),port:server.address().port,purpose:'measured packed Task resources',log:output});
  controller=await browserType.launchServer({headless:true});browser=await browserType.connect(controller.wsEndpoint());
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'measured Task '+engine,log:output});facts.version=browser.version();
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  const seeded=await page.evaluate(async()=>{
   const sdk=await import('/task.js');window.measuredSDK=sdk;
   const runtime=await sdk.init('/wasm/editac_wasm_bg.wasm');
   const doc=runtime.createEngine({profile:'v5',documentId:'81000000-0000-4000-8000-000000000001',epoch:'82000000-0000-4000-8000-000000000001',nodes:[{text:'A😀B'}]});
   const identity=doc.read().identity;const store=await sdk.CheckpointStorage.open(indexedDB,'measured-task');
   try{await store.publish(doc.checkpoint(),[]);}finally{store.close();doc.dispose();}
   const options={identity,assetUrl:'/wasm/editac_wasm_bg.wasm',databaseName:'measured-task',indexedDB,locks:navigator.locks,...sdk.taskPreset({plainPasteControl:false})};
   window.measuredOptions=options;window.editor=sdk.createEditor(document.querySelector('#editor'),options);await window.editor.ready;
   return {text:window.editor.read().visible.map(n=>n.runs.map(r=>r.text).join('')).join(''),fixtureAbsent:runtime.createFixture===undefined};
  });
  assert.deepEqual(seeded,{text:'A😀B',fixtureAbsent:true});
  await page.locator('[contenteditable="true"]').first().click();await page.keyboard.press('End');await page.keyboard.type('!');
  const recovered=await page.evaluate(async()=>{
   const text=e=>e.read().visible.map(n=>n.runs.map(r=>r.text).join('')).join('');
   const before=text(window.editor),identity=window.editor.read().identity;
   await window.editor.flush({target:'local'});await window.editor.destroy({policy:'flush'});
   window.editor=window.measuredSDK.createEditor(document.querySelector('#editor'),window.measuredOptions);await window.editor.ready;
   const after=text(window.editor),sameIdentity=JSON.stringify(identity)===JSON.stringify(window.editor.read().identity);
   const result=await window.editor.destroy({policy:'flush'});return {before,after,sameIdentity,status:result.status};
  });
  assert.equal(recovered.before,'A😀B!');assert.equal(recovered.after,recovered.before);assert.equal(recovered.sameIdentity,true);assert.deepEqual(errors,[]);
  if(manifest.required.some(a=>a.name==='wasm/editac_wasm.js')) assert.ok(requests.includes('/wasm/editac_wasm.js'));assert.ok(requests.includes('/wasm/editac_wasm_bg.wasm'));assert.ok(requests.every(p=>p==='/'||resources.has(p)||p==='/favicon.ico'));
  facts.result=recovered;facts.passed=true;
 } finally {
  try{await browser?.close();}finally{await controller?.close();}
  if(server){server.closeAllConnections();await new Promise((done,reject)=>server.close(e=>e?reject(e):done()));}
  facts.teardown={browserExited:!controller||controller.process().exitCode!==null||controller.process().signalCode!==null,serverClosed:!server?.listening};
  await writeFile(join(output,`consumer-${engine}.json`),JSON.stringify(facts,null,2)+'\n');
 }
});
