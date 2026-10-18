import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {initializePreparedAssets, preparedAssetCases} from './browser/prepared-asset-cases.mjs';
// Actual production Engine/WASM + LocalStorageLifecycle + IndexedDB. PMS-1.2
// integration, distinct from PMS-1.3 immutable packed three-browser qualification.
const descriptor=JSON.parse(await readFile('fixtures/rich-content/asset-descriptors.json','utf8')).descriptors[0];
const output=process.env.EDITAC_PREPARED_ASSET_OUTPUT;
const facts={boundary:'production WASM + storage prepared insertion',cases:[],processes:[]};
let controller,browser,context,page,sequence=0;
before(async()=>{
 if(output)await mkdir(output,{recursive:true});
 controller=await chromium.launchServer({headless:true});facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'PMS-1.2 actual prepared insertion storage proof'});
 browser=await chromium.connect(controller.wsEndpoint());facts.browser=browser.version();context=await browser.newContext();
 await context.route('https://prepared-adoption.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Prepared insertion</title><script type="importmap">{"imports":{"@edit-ac/core":"/core/index.js","@edit-ac/core/extensions":"/core/extensions/index.js"}}</script>'});
  if(path.includes('..')||!/^\/(core|web)\//.test(path))return route.abort();
  return route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(new URL((path.startsWith('/core/')?'../packages/core/dist/':'../packages/web/dist/')+path.replace(/^\/(core|web)\//,''),import.meta.url))});
 });
 page=await context.newPage();await page.goto('https://prepared-adoption.test/');await initializePreparedAssets(page, descriptor);
});
after(async()=>{try{await context?.close();}finally{try{await browser?.close();}finally{await controller?.close();}}if(output)await writeFile(output+'/browser-adoption-facts.json',JSON.stringify(facts,null,2)+'\n');});
function check(name,fn){test(name,async()=>{const fact={name,passed:false};facts.cases.push(fact);await page.evaluate(n=>window.setup(n),++sequence);try{await fn(page,fact);fact.passed=true;}catch(error){fact.error=error.stack;throw error;}finally{try{await page.evaluate(()=>window.fixture.close());}catch(error){fact.cleanupError=error.stack;if(fact.passed)throw error;}}});}
preparedAssetCases(check, descriptor);
