import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.EDITAC_LINK_EXPORTS_OUTPUT;
const facts = { qualification:'packed-headless-contract-only', packs:[], checks:[], artifacts:[], platforms:[] };
let temp, consumer;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function run(label, command, args, cwd = consumer, env = process.env) {
  const childEnv = { ...env };
  // Node propagates test-runner context; a nested --test process must be independent.
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command,args,{cwd,env:childEnv,encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024});
  const log = result.stdout + result.stderr;
  const counts = Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
  facts.checks.push({label,command,args,exit:result.status,counts});
  if(output) await writeFile(join(output,label+'.log'),log);
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.status,0,`${label}: ${output ? join(output,label+'.log') : log.slice(-3000)}`);
  return {stdout:result.stdout,counts};
}
before(async()=>{
  if(output)await mkdir(output,{recursive:true});
  temp=await realpath(await mkdtemp(join(tmpdir(),'editac-link-public-exports-')));consumer=join(temp,'consumer');await mkdir(consumer);
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  for(const name of ['core','web']){
    const result=await run('pack-'+name,'npm',['pack','--workspace','@edit-ac/'+name,'--pack-destination',temp,'--json'],root);
    const pack=JSON.parse(result.stdout)[0];facts.packs.push({name,filename:pack.filename,integrity:pack.integrity,files:pack.files.map(f=>f.path)});
    if(output)await copyFile(join(temp,pack.filename),join(output,pack.filename));
  }
  await run('install','npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',...facts.packs.map(p=>join(temp,p.filename))]);
  for(const name of ['core','web']){const path=join(consumer,'node_modules/@edit-ac',name);assert.equal(await realpath(path),path,'consumer must not alias workspace source');}
  for(const file of ['platforms.json','consumer.mjs','consumer.ts']){
    const from=join(root,'fixtures/link-presenters',file);await copyFile(from,join(consumer,file));if(output)await copyFile(from,join(output,file));
    facts.artifacts.push({path:'fixtures/link-presenters/'+file,sha256:hash(await readFile(from))});
  }
});
after(async()=>{
  try{if(output)await writeFile(join(output,'consumer-receipt.json'),JSON.stringify(facts,null,2)+'\n');}
  finally{if(temp)await rm(temp,{recursive:true,force:true});}
});
test('clean packed declarations compile all supported link port, policy, presenter and action records',async()=>{
  await run('declarations',process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts']);
});
test('public imports are inert, preserve ownership and reject internal package paths',async()=>{
  const source=`import assert from 'node:assert/strict';
const forbidden=()=>{throw Error('implicit IO or browser activation');};
for(const key of ['window','document','navigator','indexedDB'])Object.defineProperty(globalThis,key,{get:forbidden});
globalThis.fetch=forbidden;globalThis.WebSocket=forbidden;globalThis.setTimeout=forbidden;globalThis.WebAssembly=new Proxy(WebAssembly,{get:forbidden});
const core=await import('@edit-ac/core/links');const web=await import('@edit-ac/web/links');const root=await import('@edit-ac/core');
assert.equal(root.LinkActivation,core.LinkActivation);assert.equal(root.LinkPresenterSession,core.LinkPresenterSession);
assert.equal(web.LinkActivation,core.LinkActivation);assert.equal(web.LinkPresenterSession,core.LinkPresenterSession);
for(const name of ['LinkActivation','LinkPresenterSession','validLinkRequest','validateLinkResult','captureLinkRequest','validPublicLinkCachePolicy'])assert.equal(typeof core[name],'function');
for(const path of ['@edit-ac/core/dist/links/index.js','@edit-ac/core/src/links/contract.js','@edit-ac/web/dist/modules/links/contract.js'])await assert.rejects(import(path),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
`;
  await writeFile(join(consumer,'inert.mjs'),source);if(output)await writeFile(join(output,'inert.mjs'),source);
  await run('inert-imports',process.execPath,['inert.mjs']);
});
for(const id of ['ios','android','macos','windows','linux','tui'])test(`packed ${id} consumer: all result states, authority, cancellation, readonly and real shared engine`,async()=>{
  const {counts}=await run('platform-'+id,process.execPath,['--test','--test-reporter=tap','consumer.mjs'],consumer,{...process.env,EDITAC_LINK_PLATFORM:id});
  assert.ok(counts.tests===58,'all platform cases must execute');assert.equal(counts.pass,counts.tests);
  for(const field of ['fail','cancelled','skipped','todo'])assert.equal(counts[field],0);
  facts.platforms.push({id,...counts});
});
