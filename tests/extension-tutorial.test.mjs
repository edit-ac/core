import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { loggedRun, sha256 } from '../scripts/extension-bundles.mjs';
const output = resolve(process.env.EDITAC_EXTENSION_TUTORIAL_OUTPUT ?? '../architecture/evidence/extension-tutorial/current');
const upstream = JSON.parse(await readFile('../architecture/evidence/extension-exports/receipt.json'));
const codecsReceipt = JSON.parse(await readFile('../architecture/evidence/extension-codecs/receipt.json'));
const commandsReceipt = JSON.parse(await readFile('../architecture/evidence/extension-commands/receipt.json'));
const unchanged = Object.fromEntries(Object.entries({ ...codecsReceipt.packageHashes, ...commandsReceipt.artifactHashes }).filter(([path]) => /\/wasm\//.test(path)));
const nativePins = { ...upstream.sourceHashes, ...codecsReceipt.sourceHashes };
const facts = { gate:'EXT-1.10', checks:[], browsers:[], unchangedArtifacts:unchanged, upstreamReceipts:Object.fromEntries(await Promise.all(['extension-exports','extension-codecs','extension-commands'].map(async name=>[name,sha256(await readFile('../architecture/evidence/'+name+'/receipt.json'))]))), cleanup:{} };
let consumer, manifest, server, url, stdout = '', stderr = '';
const counts = text => Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(key => [key, Number(text.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1] ?? -1)]));
before(async () => {
  await mkdir(output,{recursive:true});
  consumer = await mkdtemp(join(tmpdir(),'editac-extension-tutorial-'));
  // Execute the authoring instructions verbatim; this command packs, never compiles Rust/WASM/native.
  const prepared = await loggedRun(output,'prepare',process.execPath,['scripts/prepare-extension-tutorial.mjs',consumer]);
  facts.checks.push({...prepared,stdout:undefined});
  consumer = await realpath(consumer);
  manifest = JSON.parse(await readFile(join(consumer,'qualification/consumer.json')));
  for(const name of ['consumer.json','app.js-metafile.json','tutorial.js-metafile.json',...manifest.packs.map(p=>p.filename)])
    await copyFile(join(consumer,'qualification',name),join(output,name));
  for(const name of ['app.js','tutorial.js','engine.wasm','markdown.wasm']) await copyFile(join(consumer,name),join(output,name));
  const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
  server=spawn(process.execPath,['serve.mjs','--port=0'],{cwd:consumer,env:environment,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>stdout+=chunk);server.stderr.on('data',chunk=>stderr+=chunk);
  await new Promise((done,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Tutorial server start timeout')),10000);
    server.once('error',error=>{clearTimeout(timeout);reject(error);});
    server.once('exit',code=>{if(!url){clearTimeout(timeout);reject(Error('Tutorial server exited '+code+stderr));}});
    server.stdout.on('data',()=>{if(!url&&stdout.includes('\n')){try{url=JSON.parse(stdout.split('\n')[0]).url;clearTimeout(timeout);done();}catch(error){clearTimeout(timeout);reject(error);}}});
  });
  facts.server={pid:server.pid,url,workspace:consumer,launcher:process.execPath,purpose:'EXT-1.10 documented consumer',log:join(output,'serve.log')};
});
after(async()=>{
  try {
    if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(Error('Server teardown timeout')),10000);server.once('exit',()=>{clearTimeout(timeout);done();});});}
    facts.cleanup.serverExited=!server||server.exitCode!==null||server.signalCode!==null;
    await writeFile(join(output,'serve.log'),stdout+stderr);
    if(consumer){await rm(consumer,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;}
  } finally {await writeFile(join(output,'results.json'),JSON.stringify(facts,null,2)+'\n');}
});
test('documented command passes every shared fixture in a clean packed consumer',async()=>{
  const result=await loggedRun(output,'conformance',process.execPath,['--test','--test-reporter=tap','conformance.mjs'],{cwd:consumer});
  const actual=counts(result.stdout);facts.checks.push({...result,stdout:undefined,counts:actual});
  assert.deepEqual(actual,{tests:48,pass:48,fail:0,skipped:0,cancelled:0});
});
test('unchanged production engine/codec and qualified native checkpoint are pinned',async()=>{
  for(const [path,hash] of Object.entries(unchanged))assert.equal(sha256(await readFile(path)),hash,path);
  assert.equal(manifest.inputs['engine.wasm'],unchanged['packages/core/dist/wasm/editac_wasm_bg.wasm']);
  assert.equal(manifest.inputs['markdown.wasm'],unchanged['packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm']);
  for(const name of ['custom-checkpoint.bin','identity.json'])assert.equal(manifest.inputs['fixtures/'+name],upstream.artifactHashes['registry/'+name]);
  assert.equal(manifest.inputs['fixtures/conformance.json'],sha256(await readFile('fixtures/extensions/conformance.json')));
  assert(manifest.wasmExports.includes('engine_restore'));assert(!manifest.wasmExports.some(name=>/fixture/.test(name)));
  facts.nativeSourcePins={};
  for(const [path,hash] of Object.entries(nativePins).filter(([path])=>path.startsWith('crates/'))){assert.equal(sha256(await readFile(path)),hash,path);facts.nativeSourcePins[path]=hash;}
  assert(Object.keys(facts.nativeSourcePins).length>0);
});
test('tutorial imports and bundle graph use only documented packed entry points',async()=>{
  for(const name of ['core','web','markdown'])assert.equal(await realpath(join(consumer,'node_modules/@edit-ac',name)),join(consumer,'node_modules/@edit-ac',name));
  for(const name of ['tutorial.mjs','app.mjs','conformance.mjs']){
    const source=await readFile(join(consumer,name),'utf8');
    const imports=[...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]);
    assert(imports.every(p=>p.startsWith('node:')||p.startsWith('./')||['@edit-ac/core','@edit-ac/core/extensions','@edit-ac/web','@edit-ac/web/modules','@edit-ac/markdown'].includes(p)),name);
  }
  for(const pack of manifest.packs)assert.equal(sha256(await readFile(join(output,pack.filename))),pack.sha256);
  assert(Object.keys(manifest.inputs).filter(p=>p.startsWith('node_modules/')).every(p=>p.startsWith('node_modules/@edit-ac/')));
});
for(const [name,launcher] of Object.entries({chromium,firefox,webkit}))test(name+': executable tutorial source/opaque preservation, capabilities and teardown',{timeout:120000},async()=>{
  const fact={host:name,passed:false,requests:[],errors:[]};facts.browsers.push(fact);
  let controller,browser;
  try {
    controller=await launcher.launchServer({headless:true});browser=await launcher.connect(controller.wsEndpoint());
    fact.process={pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'EXT-1.10 '+name,log:output};fact.version=browser.version();
    const page=await browser.newPage();page.on('request',request=>fact.requests.push(request.url()));page.on('pageerror',error=>fact.errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
    await page.goto(url);await page.waitForFunction(()=>typeof window.tutorial==='function');
    fact.result=await page.evaluate(async()=>{
      const {openTutorial}=await import('/tutorial.js');
      const initial=window.tutorial(), project=t=>t.editor.read().visible.find(n=>n.id==='n:11:1').runs;
      const expected=project(initial), enabledVisible=[...document.querySelectorAll('[data-module-view]')].map(e=>e.textContent);
      if(document.querySelector('img'))throw Error('Inert source executed as markup');
      const other=initial.editor.read().visible.find(n=>n.kind==='block'&&n.id!=='n:11:1').id;
      initial.editor.setReadOnly(true);
      const before=initial.editor.read();
      const blocked=await initial.commands.run(()=>({kind:'editor',origin:'local:tutorial',commands:[{type:'replaceAt',owner:other,from:0,to:0,text:'denied'}]}));
      const readOnlyUnchanged=JSON.stringify(initial.editor.read())===JSON.stringify(before);
      initial.editor.setReadOnly(false);
      // Execute the documented app action with the real codec, command and storage boundary.
      document.querySelector('#note').click();
      const deadline=performance.now()+10000;
      while(document.querySelector('#status').textContent!=='committed'&&performance.now()<deadline)await new Promise(r=>setTimeout(r,10));
      if(document.querySelector('#status').textContent!=='committed')throw Error('Note command failed');
      const afterSource=project(initial), stats=initial.stats, subscription=initial.subscription, runtime=initial.editor.moduleRuntime;
      await initial.dispose();await initial.dispose();
      const teardown={mounted:stats.mounted,disposed:stats.disposed,observed:stats.observed,subscriptionInactive:!subscription.active,runtimeInactive:!runtime.active,commandsInactive:!initial.commands.active};
      const definitions=await(await fetch('/definitions.json')).json(),identity=await(await fetch('/fixtures/identity.json')).json();
      const options={definitions,identity,databaseName:'extension-tutorial',assetUrl:'/engine.wasm',indexedDB,locks:navigator.locks};
      const fallback=await openTutorial(document.querySelector('#editor'),options);
      const recovered=project(fallback),heading=fallback.editor.read().visible.some(n=>n.blockAttributes?.[0]==='heading'&&n.runs.some(r=>r.text==='Hello 😀'));
      const fallbackVisible=document.querySelector('[data-node-id="n:11:1"]').textContent;
      await fallback.dispose();
      const absent=await openTutorial(document.querySelector('#editor'),{...options,enabled:false});
      const withoutRegistration=project(absent),noPresenters=absent.stats.mounted===0,registryEmpty=absent.registry.size===0;
      await absent.dispose();await absent.dispose();
      return {expected,afterSource,recovered,withoutRegistration,enabledVisible,blocked:blocked.status,readOnlyUnchanged,heading,fallbackVisible,noPresenters,registryEmpty,teardown};
    });
    const r=fact.result;
    for(const key of ['afterSource','recovered','withoutRegistration'])assert.deepEqual(r[key],r.expected,key);
    assert.deepEqual(r.enabledVisible,['important','badge']);assert.equal(r.blocked,'unavailable');assert(r.readOnlyUnchanged);assert(r.heading);
    for(const run of r.expected)assert(r.fallbackVisible.includes(run.text),run.text);
    assert(r.noPresenters&&r.registryEmpty);assert.equal(r.teardown.mounted,2);assert.equal(r.teardown.disposed,2);assert(r.teardown.observed>0);
    assert(r.teardown.subscriptionInactive&&r.teardown.runtimeInactive&&r.teardown.commandsInactive);assert.deepEqual(fact.errors,[]);
    assert(fact.requests.every(request=>new URL(request).origin===url));fact.passed=true;
  } finally {
    try{await browser?.close();}finally{await controller?.close();fact.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;await writeFile(join(output,'browser-'+name+'.json'),JSON.stringify(fact,null,2)+'\n');}
  }
});
test('all required browsers ran and closed without skips',()=>{
  assert.equal(facts.browsers.length,3);assert(facts.browsers.every(b=>b.passed&&b.browserExited));
});
