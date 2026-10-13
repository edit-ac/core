import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startAstroConsumer } from '../astro-harness.mjs';
const engine=process.env.EDITAC_ASTRO_BROWSER ?? 'chromium';
const output=process.env.EDITAC_ASTRO_OUTPUT ?? '../evidence/sdk-astro/iteration1/browser/'+engine;
const facts={suite:'astro',engine,cases:[],processes:[],cleanup:{}};
let browser,controller,servers;
before(async()=>{
  await requireTestNode();await mkdir(output,{recursive:true});
  servers={};
  for(const mode of ['static','ssr']){servers[mode]=await startAstroConsumer(mode);facts.processes.push({mode,pid:servers[mode].pid,port:servers[mode].port,workspace:process.cwd(),launcher:servers[mode].launcher??'in-process HTTP',purpose:'Astro compiled consumer',log:output});}
  controller=await {chromium,firefox,webkit}[engine].launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,purpose:'Astro browser lifecycle',workspace:process.cwd(),log:output});
  browser=await {chromium,firefox,webkit}[engine].connect(controller.wsEndpoint());
  facts.browser={version:browser.version(),node:process.version};
});
after(async()=>{
  try{await browser?.close();}finally{
    try{await controller?.close();facts.cleanup.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;}finally{
      for(const s of Object.values(servers??{}))await s.close();facts.cleanup.serversClosed=true;
      facts.counts={executed:facts.cases.length,passed:facts.cases.filter(c=>c.passed).length,failed:facts.cases.filter(c=>!c.passed).length,skipped:0};
      await writeFile(join(output,'receipt.json'),JSON.stringify(facts,null,2));
    }
  }
});
async function ready(page,count=2){await page.waitForFunction(count=>window.astroFixture && (window.astroFixture.facts.ready>=count || window.astroFixture.facts.errors.length),count);
  const startup=await page.evaluate(()=>({...window.astroFixture.facts}));assert.ok(startup.ready>=count,JSON.stringify(startup));}
async function probe(mode,name,action){
  const context=await browser.newContext();const page=await context.newPage();
  const fact={mode,name,passed:false,errors:[],snapshots:[],provenance:'Compiled Astro 7 consumer; real WASM/web editing and IndexedDB; prepared local failure/delay ports; no device qualification'};facts.cases.push(fact);
  page.on('pageerror',e=>fact.errors.push(e.message));
  try{await page.goto(servers[mode].url);await ready(page);await action(page,fact);assert.deepEqual(fact.errors,[]);fact.passed=true;}
  catch(error){fact.failure={message:error.message,stack:error.stack};await writeFile(join(output,`${mode}-${name}-failure.json`),JSON.stringify(fact,null,2));throw error;}
  finally{try{await page.evaluate(async()=>{window.astroFixture?.releaseSave();window.astroFixture?.releaseRecovery();await window.astroFixture?.stop();});}finally{await context.close();}}
}
for(const mode of ['static','ssr']) {
  test(`${mode}: real typing, selection and multiple hosts retain document/DOM ownership`,()=>probe(mode,'input',async(page,fact)=>{
    await page.evaluate(()=>{window.original=document.querySelector('[data-editor-surface]').firstChild;window.astroFixture.select(5);});
    await page.keyboard.type('!');
    const result=await page.evaluate(async()=>{const f=window.astroFixture;f.select(1,4);await f.editor().flush({target:'local'});return {text:f.text(),notes:f.text('notes'),selected:document.getSelection().toString(),sameDOM:window.original===document.querySelector('[data-editor-surface]').firstChild,duplicate:f.duplicate(),facts:{...f.facts}};});
    assert.deepEqual(result.text,['alpha!']);assert.deepEqual(result.notes,['beta']);assert.equal(result.selected,'lph');assert.equal(result.sameDOM,true);assert.equal(result.duplicate,true);assert.equal(result.facts.live,2);assert.equal(result.facts.peak,2);fact.snapshots.push(result);
  }));
  test(`${mode}: read-only changes authority without replacing the replica`,()=>probe(mode,'read-only',async(page)=>{
    assert.equal(await page.locator('[data-editor-name="notes"] [data-editor-surface]').getAttribute('contenteditable'),'false');
    await page.evaluate(()=>{const f=window.astroFixture;window.originalEditor=f.editor();f.setReadOnly(true);});
    assert.equal(await page.locator('[data-editor-name="task"] [data-editor-surface]').getAttribute('contenteditable'),'false');
    await page.evaluate(()=>{window.astroFixture.setReadOnly(false);window.astroFixture.select(5);});await page.keyboard.type('!');
    assert.deepEqual(await page.evaluate(()=>window.astroFixture.text()),['alpha!']);assert.equal(await page.evaluate(()=>window.originalEditor===window.astroFixture.editor()),true);
  }));
  test(`${mode}: ClientRouter waits for pending save and remounts without duplicate handles`,()=>probe(mode,'navigation-save',async(page,fact)=>{
    await page.evaluate(()=>{window.astroFixture.slowSave();window.astroFixture.select(5);});await page.keyboard.type(' saved');
    await page.evaluate(()=>{document.querySelector('a[href="/away"]').click();});
    await page.waitForFunction(()=>window.astroFixture.editor().state.phase==='closing');
    assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.evaluate(()=>window.astroFixture.facts.live),1);
    await page.evaluate(()=>window.astroFixture.releaseSave());await page.waitForURL('**/away');
    await page.waitForFunction(()=>window.astroFixture.facts.live===0);
    await page.click('a[href="/"]');await ready(page,4);
    const result=await page.evaluate(()=>({text:window.astroFixture.text(),facts:{...window.astroFixture.facts},statuses:document.querySelectorAll('edit-ac-editor [role="status"]').length}));
    assert.deepEqual(result.text,['alpha saved']);assert.equal(result.facts.live,2);assert.equal(result.facts.peak,2);assert.equal(result.facts.disposed,2);assert.deepEqual(result.facts.errors,[]);assert.equal(result.statuses,2);fact.snapshots.push(result);
  }));
  test(`${mode}: removal and immediate remount serialize pending teardown`,()=>probe(mode,'remount',async(page)=>{
    await page.evaluate(()=>{window.astroFixture.slowSave();window.astroFixture.select(5);});await page.keyboard.type(' saved');
    await page.evaluate(async()=>{const f=window.astroFixture;f.remove();await f.add('task');});
    await page.waitForFunction(()=>window.astroFixture.editor().state.phase==='closing');
    assert.equal(await page.evaluate(()=>window.astroFixture.facts.recoveries),2);
    await page.evaluate(()=>window.astroFixture.releaseSave());await ready(page,3);
    assert.deepEqual(await page.evaluate(()=>window.astroFixture.text()),['alpha saved']);assert.equal(await page.evaluate(()=>window.astroFixture.facts.peak),2);
  }));
  test(`${mode}: failed navigation save exposes an unsaved recovery report`,()=>probe(mode,'save-failure',async(page,fact)=>{
    await page.evaluate(()=>{window.astroFixture.slowSave();window.astroFixture.select(5);});await page.keyboard.type(' recover');
    await page.evaluate(()=>{window.astroFixture.failSave();window.astroFixture.releaseSave();});
    await page.click('a[href="/away"]');await page.waitForURL('**/away');
    const result=await page.evaluate(()=>({...window.astroFixture.facts}));assert.equal(result.live,0);assert.equal(result.disposed,2);assert.equal(result.errors.length,1);assert.ok(result.errors.every(e=>e==='prepared save failure'));assert.equal(result.reports.length,2);assert.ok(result.reports.every(r=>r.recovery&&r.bytes>0));assert.ok(result.reports.some(r=>r.unsaved&&r.text.join('')==='alpha recover'));assert.ok(result.reports.some(r=>!r.unsaved&&r.text.join('')==='beta'));fact.snapshots.push(result);
  }));
  test(`${mode}: prepared load failure is observable and releases the failed host`,()=>probe(mode,'load-failure',async(page,fact)=>{
    await page.evaluate(async()=>{const f=window.astroFixture;f.failLoad();await f.add('failed');});
    await page.waitForFunction(()=>window.astroFixture.facts.errors.length===1);
    assert.equal(await page.locator('[data-editor-name="failed"] [role="alert"]').count(),1);
    await page.evaluate(()=>window.astroFixture.remove('failed'));await page.waitForFunction(()=>!document.querySelector('[data-editor-name="failed"]'));
    const result=await page.evaluate(()=>({...window.astroFixture.facts}));assert.equal(result.live,2);assert.deepEqual(result.errors,['prepared load failure']);fact.snapshots.push(result);
  }));
  test(`${mode}: removal during asynchronous recovery cancels readiness and frees the replica`,()=>probe(mode,'cancel-recovery',async(page)=>{
    await page.evaluate(async()=>{const f=window.astroFixture;f.slowRecovery();await f.add('cancel');});
    await page.waitForFunction(()=>window.astroFixture.facts.recoveries===3);
    await page.evaluate(()=>{window.astroFixture.remove('cancel');window.astroFixture.releaseRecovery();});
    await page.waitForFunction(()=>window.astroFixture.facts.disposed===1);
    assert.equal(await page.evaluate(()=>window.astroFixture.facts.live),2);assert.equal(await page.evaluate(()=>window.astroFixture.facts.ready),2);
  }));
}
