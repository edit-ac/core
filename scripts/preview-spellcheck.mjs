import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireTestNode } from './test-toolchain.mjs';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { prepareSpellingConsumer } from '../tests/extension-dx/spellcheck-consumer.mjs';
await requireTestNode();
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === '--check')) throw Error('Expected no arguments or --check');
const check = args[0] === '--check';
const output = resolve(process.env.EDITAC_SPELLCHECK_PREVIEW_OUTPUT ?? `.artifacts/spellcheck-preview-${Date.now()}`);
await mkdir(output, { recursive:true });
const directory = await mkdtemp(join(tmpdir(), 'editac-spellcheck-preview-'));
const facts = { purpose:'INT-1.14 exact packed browser/OS observation fixture', output, consumer:directory, processes:[], sources:{}, checks:[], cleanup:{} };
let server, browser, controller, closing;
async function run(command, argv, log) {
  const result = spawnSync(command, argv, {encoding:'utf8', maxBuffer:16*1024*1024});
  await writeFile(join(output,log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if(result.error || result.status !== 0) throw Error(`${log} failed; retained in ${output}`);
  return result.stdout;
}
async function close() {
  if (closing) return closing;
  closing = (async()=>{
    try { await browser?.close(); await controller?.close(); facts.cleanup.browserClosed = true; facts.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null; }
    finally { try { await server?.close(); facts.cleanup.serverClosed = true; }
      finally { await rm(directory,{recursive:true,force:true}); facts.cleanup.consumerRemoved=true;
        facts.counts={executed:facts.checks.length,passed:facts.checks.filter(c=>c.passed).length,failed:facts.failure?1:0,skipped:0};
        await writeFile(join(output,'receipt.json'),JSON.stringify(facts,null,2)); } }
  })();
  return closing;
}
try {
  for(const path of ['scripts/preview-spellcheck.mjs','tests/extension-dx/spellcheck-consumer/manual.html','tests/extension-dx/spellcheck-consumer/session.mjs','examples/extensions/spellcheck/spellcheck.ts'])
    facts.sources[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  for(const name of ['core','web']) {
    const target=join(directory,name);await mkdir(target);
    const pack=JSON.parse(await run('npm',['pack','--workspace',`@edit-ac/${name}`,'--json','--pack-destination',target],`pack-${name}.log`))[0];
    await run('tar',['-xzf',join(target,pack.filename),'-C',target],`unpack-${name}.log`);
  }
  const fixture=await prepareSpellingConsumer(directory,{output,facts,run});
  await copyFile('tests/extension-dx/spellcheck-consumer/manual.html',join(fixture,'index.html'));
  server=await startFixtureServer({fixtureDirectory:fixture,coreDirectory:join(directory,'core/package/dist'),webDirectory:join(directory,'web/package/dist'),recordRequests:true});
  facts.server={pid:process.pid,port:server.port,url:server.url,workspace:process.cwd(),log:output,purpose:facts.purpose};
  facts.requests=server.requests;
  console.log(JSON.stringify(facts.server));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
  if(check) {
    const {chromium}=await import('playwright');controller=await chromium.launchServer({headless:true});facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'spellcheck preview --check',log:output});browser=await chromium.connect(controller.wsEndpoint());
    const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url);await page.waitForFunction(()=>document.documentElement.dataset.previewReady==='true');
    assert.equal(await page.getByRole('textbox',{name:'platform spelling editor'}).count(),1);
    assert.equal(await page.evaluate(()=>window.spelling.loads),0);facts.checks.push({id:'platform-ready',passed:true});
    await page.locator('#mode').selectOption('custom');await page.getByRole('button',{name:'Add editor',exact:true}).click();
    assert.match(await page.locator('#diagnostics').textContent(),/explicit overlap choice/);
    assert.equal(await page.getByRole('textbox',{name:'custom spelling editor'}).count(),0);facts.checks.push({id:'overlap-admission',passed:true});
    await page.locator('#overlap').check();await page.getByRole('button',{name:'Add editor',exact:true}).click();
    await page.getByRole('textbox',{name:'custom spelling editor'}).waitFor();
    await page.evaluate(()=>window.spellingFixture.select(window.spelling.editor.root,3));await page.keyboard.type(' ');
    await page.getByRole('button',{name:'Replace teh with the',exact:true}).click();
    await page.waitForFunction(()=>window.spelling.statuses.includes('applied'));
    assert.equal(await page.evaluate(()=>window.spellingFixture.content(window.spelling.editor)),'the ');assert.deepEqual(errors,[]);
    facts.checks.push({id:'prepared-custom-correction',passed:true});
    await page.evaluate(()=>window.spellingFixture.close());await close();console.log(JSON.stringify({counts:facts.counts,output}));
  } else {
    console.log('Open the printed loopback URL in the actual browser/OS profile. Ctrl+C closes this temporary host. No OS observation is inferred.');
    await new Promise(()=>{});
  }
} catch(error) { facts.failure={message:error.message};await close();throw error; }
