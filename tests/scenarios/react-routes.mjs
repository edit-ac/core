import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import {auditSharedGraph,auditSharedAssets} from '../../scripts/shared-resource-contract.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { loadScenario, validateScenario, root } from './run.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
await requireTestNode();
const { manifest, scenario } = await loadScenario('web-react-routes');
const output = resolve(root, '../architecture/evidence/browser-product-workflows-20261018/pwe-1.3', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-react-routes', command: ['node', 'tests/scenarios/run.mjs', 'web-react-routes'], output, profile: manifest.profile, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
let server, controller, browser, activePage;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], ['Chromium controller', controller], ['fixture listener', server]]) {
    if (!resource) continue;
    try { await resource.close(); facts.teardown.push(name + ' closed'); }
    catch (error) { facts.teardown.push(name + ': ' + error.message); process.exitCode = 1; }
  }
  browser = controller = server = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void teardown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
async function check(id, run) {
  try { await run(); facts.cases.push({ id, status: 'passed' }); }
  catch (error) { facts.cases.push({ id, status: 'failed', error: error.stack }); throw error; }
}
const text = (page,name='task')=>page.evaluate(async name=>{
  const slot=(await import('/fixture/react-built.mjs')).slots.get(name);
  return slot.editor.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join('');
},name);
const moduleCall=(page,fn,arg)=>page.evaluate(async({source,arg})=>{
  const m=await import('/fixture/react-built.mjs');return (0,eval)('('+source+')')(m,arg);
},{source:fn.toString(),arg});
async function input(page,name,value){await page.locator(`[data-slot="${name}"] [data-node-id]`).first().click();await page.keyboard.press('End');await page.keyboard.type(value);await moduleCall(page,async(m,name)=>m.slots.get(name).editor.settle(),name);}
try {
  await check('dispatcher-rejects-invalid-inputs', async()=>{
    assert.throws(()=>validateScenario(manifest,'unknown-task'), /Unknown scenario/);
    for(const patch of [{command:[]},{cases:[]},{fixtures:[]}]) assert.throws(()=>validateScenario({scenarios:{broken:{...scenario,...patch}}},'broken'));
    const file=join(output,'missing-fixture.json');
    await writeFile(file,JSON.stringify({scenarios:{broken:{...scenario,fixtures:['fixtures/product-scenarios/web/absent.json']}}}));
    await assert.rejects(loadScenario('broken',file),/ENOENT/);
    await writeFile(file,JSON.stringify({scenarios:{broken:{...scenario,command:['node','tests/scenarios/absent.mjs']}}}));
    await assert.rejects(loadScenario('broken',file),/ENOENT/);
  });
  const {site}=await prepareProductHarness(output,facts,scenario);
  server=await startFixtureServer({fixtureDirectory:join(site,'fixture'),coreDirectory:join(site,'core'),webDirectory:join(site,'web'),recordRequests:true,cacheAssets:true});
  facts.processes.push({pid:process.pid,launcher:process.execPath,workspace:root,port:server.port,purpose:'PWE-1.3 installed React fixture',log:join(output,'receipt.json')});
  controller=await chromium.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:root,purpose:'PWE-1.3 Chromium',log:join(output,'receipt.json')});
  browser=await chromium.connect(controller.wsEndpoint());facts.browserVersion=browser.version();
  const errors=[];
  const open=async(query='')=>{const context=await browser.newContext();const page=activePage=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.goto(server.url+'/fixture/react.html'+query);await page.evaluate(async()=>{await(await import('/fixture/react-built.mjs')).ready;});return {page,context};};
  for(const profiles of ['mixed','equal'])for(const order of ['task-first','comment-first'])await check(profiles+'-'+order,async()=>{
    const {page,context}=await open('?profiles='+profiles+'&order='+order);
    assert.equal(await page.locator('[contenteditable="true"]').count(),2);
    const initial=await moduleCall(page,m=>[...m.slots.values()].map(s=>({name:s.name,id:s.options.identity.documentId,db:s.options.databaseName,rich:s.permission.rich,ready:s.events.ready,error:s.events.error})));
    assert.deepEqual(initial.map(s=>s.name),order==='task-first'?['task','comment']:['comment','task']);
    assert.equal(initial.find(s=>s.name==='task').db,'example-react');assert.notEqual(initial[0].id,initial[1].id);assert.notEqual(initial[0].db,initial[1].db);assert.ok(initial.every(s=>s.ready===1&&s.error.length===0));
    assert.equal(initial.find(s=>s.name==='comment').rich,profiles==='equal');
    const taskBefore=await text(page),commentBefore=await text(page,'comment');
    await input(page,'task','T');const changedTask=await text(page);assert.notEqual(changedTask,taskBefore);assert.equal(await text(page,'comment'),commentBefore);
    await input(page,'comment','C');assert.equal(await text(page),changedTask);
    await page.keyboard.press('Meta+z');await moduleCall(page,async m=>m.slots.get('comment').editor.settle());assert.equal(await text(page,'comment'),commentBefore);assert.equal(await text(page),changedTask);
    await page.locator('[data-slot="task"] [data-node-id]').first().click();await page.keyboard.press('Meta+z');await moduleCall(page,async m=>m.slots.get('task').editor.settle());assert.equal(await text(page),taskBefore);
    const receipts=await moduleCall(page,async m=>{await m.save('task');await m.save('comment');return [...m.slots.values()].map(s=>({id:s.options.identity.documentId,save:s.events.save,error:s.events.error}));});
    receipts.forEach(s=>{assert.equal(s.save.length,1);assert.equal(s.save[0].documentId,s.id);assert.equal(s.save[0].localCommitted.state,'localCommitted');assert.deepEqual(s.error,[]);});
    if(profiles==='mixed'){
      await input(page,'comment',' /table @Prepared');
      assert.equal(await page.locator('[data-slot="comment"] [role="menu"]').count(),0);
      assert.equal(await page.locator('[data-slot="comment"] [role="listbox"]').count(),0);
      assert.equal(await page.locator('[data-slot="comment"] [role="toolbar"]').count(),0);
      assert.equal(await moduleCall(page,m=>m.referenceCalls.length),0);
      const denied=await moduleCall(page,m=>{const e=m.slots.get('comment').editor;return {bold:e.captureCommand('bold')?.execute(),table:!!m.slots.get('comment').options.content,reference:!!m.slots.get('comment').options.references};});
      assert.ok(!denied.bold||denied.bold.disposition==='rejected');assert.equal(denied.table,false);assert.equal(denied.reference,false);
    }
    await page.screenshot({path:join(output,profiles+'-'+order+'.png'),fullPage:true});
    await moduleCall(page,m=>m.close());await context.close();
  });
  const {page,context}=await open();
  await check('strictmode-route-restore',async()=>{
    await input(page,'task',' retained task');await input(page,'comment',' retained comment');
    const before={task:await text(page),comment:await text(page,'comment')};
    const ids=await moduleCall(page,m=>[...m.slots.values()].map(s=>s.options.identity.documentId));
    await page.getByRole('link',{name:'Document body',exact:true}).click();await page.waitForSelector('[data-slot="document"] [contenteditable="true"]');
    await moduleCall(page,async m=>m.slots.get('document').ready.promise);assert.match(page.url(),/route=document/);
    await input(page,'document',' retained body');const body=await text(page,'document');
    await page.screenshot({path:join(output,'document-body.png'),fullPage:true});
    const documentId=await moduleCall(page,m=>m.slots.get('document').options.identity.documentId);assert.ok(!ids.includes(documentId));
    await moduleCall(page,m=>m.navigate('tasks'));assert.equal(await text(page),before.task);assert.equal(await text(page,'comment'),before.comment);
    assert.deepEqual(await moduleCall(page,m=>['task','comment'].map(n=>m.slots.get(n).options.identity.documentId)),ids);
    await page.goBack();await page.waitForSelector('[data-slot="document"] [contenteditable="true"]');await moduleCall(page,async m=>m.slots.get('document').ready.promise);assert.equal(await text(page,'document'),body);
    await moduleCall(page,m=>m.navigate('tasks'));facts.routeLifecycle=await moduleCall(page,m=>m.lifecycle);
    assert.ok(facts.routeLifecycle.filter(e=>e.event==='disposed').length>=5);
    assert.equal(await page.locator('[contenteditable="true"]').count(),2);
    for(const name of ['task','comment'])assert.match(await page.locator('#'+name+'-status').innerText(),/Ready locally|Saved locally/);
    await page.screenshot({path:join(output,'route-restored.png'),fullPage:true});
  });
  await check('readonly-authority',async()=>{
    const before=await text(page,'comment');await page.locator('[data-slot="comment"] [data-node-id]').first().click();
    await moduleCall(page,async m=>{window.pendingCommand=m.slots.get('comment').editor.captureCommand('replace');await m.setReadOnly('comment',true);});
    const denied=await page.evaluate(()=>{const result=window.pendingCommand?.execute('DENIED');window.pendingCommand?.dispose();return result;});assert.equal(denied?.disposition,'rejected');
    await page.keyboard.type('DENIED');assert.equal(await text(page,'comment'),before);assert.equal(await moduleCall(page,m=>m.slots.get('task').editor.state.readOnly),false);
    await moduleCall(page,m=>m.setReadOnly('comment',false));await input(page,'comment',' allowed');
    const readonly=await open('?readonly');assert.equal(await readonly.page.locator('[contenteditable="true"]').count(),0);assert.ok(await moduleCall(readonly.page,m=>[...m.slots.values()].every(s=>s.editor.state.readOnly)));
    await moduleCall(readonly.page,m=>m.close());await readonly.context.close();activePage=page;
  });
  await check('sibling-survives-disposal',async()=>{
    await moduleCall(page,m=>m.dispose('task'));assert.equal(await page.locator('[data-slot="task"]').count(),0);
    await input(page,'comment',' survivor');const saved=await moduleCall(page,m=>m.save('comment'));assert.equal(saved.localCommitted.state,'localCommitted');assert.match(await text(page,'comment'),/survivor/);
  });
  await check('dispose-during-loading',async()=>{
    const result=await page.evaluate(async()=>{return (await import('/fixture/react-lifecycle-built.mjs')).loadingDisposal();});
    facts.loadingDisposal=result;assert.ok(result.started>0);assert.equal(result.ready,0);assert.equal(result.disposed,1);assert.equal(result.siblingReady,true);assert.deepEqual(result.errors,[]);
  });
  await check('scoped-recovery-error',async()=>{
    await moduleCall(page,m=>m.navigate('tasks'));const siblingBefore=await text(page,'comment');
    await page.evaluate(async()=>{const m=await import('/fixture/react-built.mjs');window.transactionOriginal=IDBDatabase.prototype.transaction;const database=m.slots.get('task').options.databaseName;
      IDBDatabase.prototype.transaction=function(...args){if(this.name===database&&args[1]==='readwrite')throw new DOMException('Prepared local write denial','QuotaExceededError');return window.transactionOriginal.apply(this,args);};});
    await input(page,'task',' UNSAVED TASK');
    const result=await moduleCall(page,async m=>{let failed=false;try{await m.save('task');}catch{failed=true;}return {failed,taskErrors:m.slots.get('task').events.error.length,commentErrors:m.slots.get('comment').events.error.length,recovery:JSON.stringify(m.recoveryFor('task'))};});
    assert.equal(result.failed,true);assert.ok(result.taskErrors>0);assert.equal(result.commentErrors,0);assert.equal(await text(page,'comment'),siblingBefore);assert.ok(!result.recovery.includes(siblingBefore));
    await moduleCall(page,m=>m.dispose('task'));const reports=await moduleCall(page,m=>m.slots.get('task').recovery.map(r=>({unsaved:r.unsaved,hasRecovery:!!r.recovery})));assert.ok(reports.some(r=>r.unsaved));
    await page.evaluate(()=>{IDBDatabase.prototype.transaction=window.transactionOriginal;});await input(page,'comment',' after error');await moduleCall(page,m=>m.save('comment'));facts.recoveryReports=reports;assert.match(await page.locator('#message').innerText(),/Unsaved task content retained/);
  });
  await check('installed-common-resources',async()=>{
    const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.wasm')).map(e=>({url:e.name,transferSize:e.transferSize})));
    assert.equal(resources.length,1);assert.match(resources[0].url,/\/core\/wasm\/editac_wasm_bg.wasm$/);
    const graph=JSON.parse(await readFile(join(output,'react-graph.json'),'utf8'));
    facts.graphAudit=auditSharedGraph(graph,{defaultOnly:true});
    const emitted=facts.artifacts.filter(a=>Object.keys(graph.outputs).some(p=>p.endsWith(a.path.replace(/^site\//,'')))) .map(a=>({...a,url:'/'+a.path.replace(/^site\//,''),role:'common-runtime',build:facts.packs[0].sha256}));
    const wasm=facts.artifacts.find(a=>a.path==='site/core/wasm/editac_wasm_bg.wasm');
    facts.assetAudit=auditSharedAssets([...emitted,{...wasm,url:'/core/wasm/editac_wasm_bg.wasm',role:'core-wasm',build:facts.packs[0].sha256}],{defaultOnly:true});
    const coreInputs=Object.keys(graph.inputs).filter(p=>/node_modules\/@edit-ac\/core\/dist\/index.js$/.test(p));assert.equal(coreInputs.length,1);
    assert.equal(Object.keys(graph.inputs).filter(p=>/node_modules\/@edit-ac\/web\/dist\/index.js$/.test(p)).length,1);
    assert.equal(Object.keys(graph.inputs).filter(p=>/node_modules\/@edit-ac\/react\/dist\/index.js$/.test(p)).length,1);
    assert.equal(server.requests.filter(r=>r.url.includes('markdown')).length,0);
    const cache=await open();const requestStart=server.requests.length;
    await moduleCall(cache.page,m=>m.close());await cache.page.reload();await cache.page.evaluate(async()=>{await(await import('/fixture/react-built.mjs')).ready;});
    const warm=server.requests.slice(requestStart).filter(r=>r.url.endsWith('.wasm'));assert.equal(warm.length,1);assert.equal(warm[0].status,304);assert.equal(warm[0].bodyBytes,0);
    await moduleCall(cache.page,m=>m.close());await cache.context.close();activePage=page;facts.warmNavigation=warm;
    facts.resourceReuse={resources,coreInputs,graphSha256:facts.reactGraphSha256,scope:'Exact product graph/client routes; no universal size or platform claim'};
  });
  await moduleCall(page,m=>m.close());await context.close();activePage=undefined;
  assert.deepEqual(errors,[]);assert.deepEqual(new Set(facts.cases.map(c=>c.id)),new Set(scenario.cases));
} catch (error) {
  facts.failure = error.stack; process.exitCode = 1;
  if (activePage) {
    try { facts.failureState = await activePage.evaluate(async () => ({ message: document.querySelector('#message')?.textContent, state: (await import('/fixture/react-built.mjs')).editor?.state })); await activePage.screenshot({ path: join(output, 'failure.png'), fullPage: true }); }
    catch (diagnostic) { facts.diagnosticError = diagnostic.message; }
  }
}
finally {
  if (server) facts.requests = server.requests;
  await teardown();
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: Math.max(0, scenario.cases.length - facts.cases.length), required: scenario.cases.length };
  if (facts.failure && facts.counts.failed === 0) facts.setupFailure = true;
  if (facts.counts.executed !== facts.counts.required) process.exitCode = 1;
  facts.exit = process.exitCode ?? 0;
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, resolved: { sourceRevision: facts.sourceRevision, sourceTree: facts.sourceTree, sources: facts.sources, packs: facts.packs, browserVersion: facts.browserVersion, artifacts: facts.artifacts } }, null, 2));
  facts.manifestSha256 = sha(await readFile(join(output, 'manifest.json')));
  await writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ output, counts: facts.counts, exit: facts.exit, failure: facts.failure?.split('\n').slice(0,3) }));
}
