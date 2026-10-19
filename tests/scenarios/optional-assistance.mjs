import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
const engine = process.env.EDITAC_PRODUCT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert.ok(browserType, 'Unknown browser profile: ' + engine);
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { loadScenario, root } from './run.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
await requireTestNode();
const { manifest, scenario } = await loadScenario('web-optional-assistance');
const output = process.env.EDITAC_PRODUCT_CASE_OUTPUT ?? resolve(root, '../architecture/evidence/web-feature-first-20261018/wex-3.1/runtime', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-optional-assistance', command: ['node', 'tests/scenarios/run.mjs', 'web-optional-assistance'], output, profile: { ...manifest.profile, engine }, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
let server, controller, browser, activePage;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], [engine+' controller', controller], ['fixture listener', server]]) {
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
const text = (page, name='task') => page.evaluate(async name => {
  const slot = (await import('/fixture/editor.mjs'))[name];
  return slot.editor.read().visible.flatMap(n=>n.runs?.map(r=>r.text)??[]).join('');
}, name);
try {
  const {site}=await prepareProductHarness(output,facts,scenario);
  server=await startFixtureServer({fixtureDirectory:join(site,'fixture'),coreDirectory:join(site,'core'),webDirectory:join(site,'web'),recordRequests:true});
  facts.processes.push({pid:process.pid,launcher:process.execPath,workspace:root,port:server.port,purpose:'WEX-3.1 installed optional product',log:join(output,'receipt.json')});
  controller=await browserType.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:root,purpose:'WEX-3.1 '+engine,log:join(output,'receipt.json')});
  browser=await browserType.connect(controller.wsEndpoint());facts.browserVersion=browser.version();
  const page=activePage=await browser.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===server.url ? route.continue() : route.abort('blockedbyclient'));
  const ready=async(query='')=>{await page.goto(server.url+'/fixture/index.html'+query);await page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).ready;});};
  const settle=()=>page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).editor.settle();});
  const select=async()=>{await page.locator('#editor [data-node-id]').first().click();await page.keyboard.press('Meta+a');};
  const assistant=()=>page.locator('#task-panel [data-assistive-input]');
  const show=async()=>{await select();await assistant().getByRole('button',{name:'Editing assistance',exact:true}).click();};
  const command=name=>assistant().getByRole('button',{name,exact:true}).click();
  const marked=()=>page.evaluate(async()=>(await import('/fixture/editor.mjs')).editor.read().visible.some(n=>n.runs?.some(r=>r.attributes.bold===true)));
  await check('disabled-default',async()=>{await ready();assert.equal(await page.locator('[data-assistive-input]').count(),0);});
  await check('task-command-history-and-isolation',async()=>{
    await ready('?assistance');assert.equal(await page.locator('[data-assistive-input]').count(),1);
    const sibling=await text(page,'comment');await show();await command('Bold');await settle();assert.equal(await marked(),true);
    assert.equal(await text(page),'Plan the task');assert.equal(await text(page,'comment'),sibling);
    await show();await command('Undo');await settle();assert.equal(await marked(),false);
    await show();await command('Redo');await settle();assert.equal(await marked(),true);
    assert.equal(await text(page,'comment'),sibling);assert.equal(await assistant().getByRole('button',{name:'Start assistance',exact:true}).count(),0);
    assert.ok(await page.evaluate(()=>performance.getEntriesByType('resource').some(e=>e.name.endsWith('.wasm'))));
  });
  await check('durable-reopen',async()=>{
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.saveLocally();await m.reopenOffline();});
    assert.equal(await marked(),true);assert.equal(await text(page),'Plan the task');assert.equal(await assistant().count(),1);
  });
  await check('readonly-denial',async()=>{
    await show();await page.evaluate(async()=>{(await import('/fixture/editor.mjs')).revokeEditing('task');});
    assert.equal(await assistant().getByRole('button',{name:'Bold',exact:true}).isDisabled(),true);
    const denied=await page.evaluate(async()=>{const {editor}=await import('/fixture/editor.mjs');const before=editor.read();editor.assistive.activate('bold');await editor.settle();return {before,after:editor.read()};});
    assert.deepEqual(denied.after,denied.before,'captured assistance cannot mutate after permission revocation');
    assert.equal(await marked(),true);assert.equal(await text(page,'comment'),'Add a comment');
  });
  await check('dispose-and-remount',async()=>{
    await page.evaluate(async()=>{await(await import('/fixture/editor.mjs')).task.close();});
    assert.equal(await assistant().count(),0);assert.equal(await page.locator('#comment [contenteditable="true"]').count()+await page.locator('#comment[contenteditable="true"]').count(),1);
    await ready('?assistance');assert.equal(await assistant().count(),1);assert.equal(await marked(),true);
  });
  await check('narrow-command-controls',async()=>{
    await page.setViewportSize({width:390,height:740});await show();
    const boxes=await assistant().locator('button').evaluateAll(buttons=>buttons.filter(b=>b.getClientRects().length).map(b=>{const r=b.getBoundingClientRect();return {label:b.textContent,width:r.width,height:r.height};}));
    assert.ok(boxes.length>=5);for(const b of boxes)assert.ok(b.width>=44&&b.height>=44,JSON.stringify(b));
    await assistant().getByRole('button',{name:'Close assistance',exact:true}).click();
    await page.evaluate(async()=>{const m=await import('/fixture/editor.mjs');await m.task.close();await m.comment.close();});
    assert.equal(await page.locator('[data-assistive-input]').count(),0);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(facts.cases.map(c=>c.id),scenario.cases);

} catch (error) {
  facts.failure = error.stack; process.exitCode = 1;
  if (activePage) {
    try { facts.failureState = await activePage.evaluate(async () => ({ message: document.querySelector('#message')?.textContent, state: (await import('/fixture/editor.mjs')).editor?.state })); await activePage.screenshot({ path: join(output, 'failure.png'), fullPage: true }); }
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
