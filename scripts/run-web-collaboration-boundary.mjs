import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireTestNode } from './test-toolchain.mjs';
import { tapFacts } from './check-web-feature-ledger.mjs';
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_COLLABORATION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_COLLABORATION_OUTPUT); mkdirSync(output);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: sha(readFileSync(path)) });
const verify = sources => { for (const [path, digest] of Object.entries(sources)) assert.equal(sha(readFileSync(path)), digest, path); };
const execution = { task: 'WFE-3.1-C4n', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'], node: process.version,
  started: new Date().toISOString(), commands: [], receipts: [], reusedCommands: [] };
const walk = path => readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(path,e.name)):[join(path,e.name)]);
try {
  const packs=[];
  for(const name of ['core','web','markdown']) {
    const result=spawnSync('npm',['pack','--workspace','@edit-ac/'+name,'--ignore-scripts','--json','--pack-destination',output],{encoding:'utf8'});
    writeFileSync(join(output,'pack-'+name+'.log'),(result.stdout??'')+(result.stderr??''));assert.equal(result.status,0);
    const p=JSON.parse(result.stdout)[0];packs.push({name,file:resolve(output,p.filename),sha256:sha(readFileSync(join(output,p.filename)))});
  }
  save('packages.json',packs);
  const historical=json('../architecture/evidence/extension-dx/contract-20261017/generated-artifacts.json');
  const generated=historical.map(p=>{
    const pack=packs.find(v=>v.name===(p.member.includes('editac_markdown')?'markdown':'core'));
    const extract=spawnSync('tar',['-xOf',pack.file,p.member],{maxBuffer:16*1024*1024});assert.equal(extract.status,0);
    const current=p.member.replace('package/',''),name=pack.name;
    assert.equal(sha(extract.stdout),sha(readFileSync('packages/'+name+'/'+current)));
    return {pack:pack.file,member:p.member,authenticatedSha256:sha(extract.stdout)};
  });
  save('current-generated-artifacts.json',generated);

  // Admission checks every packed dist member against the actual runtime used by
  // direct Node adapters. Browser harnesses separately install their own packs.
  const archive=spawnSync('python3',['-c',`import sys,json,tarfile,pathlib,hashlib
members={}
for p in json.load(sys.stdin):
 with tarfile.open(p['file']) as t:
  for m in t.getmembers():
   if m.isfile() and m.name.startswith('package/dist/'):
    path='packages/'+p['name']+'/'+m.name.removeprefix('package/')
    h=hashlib.sha256(t.extractfile(m).read()).hexdigest()
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==h,path
    members[path]=h
print(json.dumps(members))`],{input:JSON.stringify(packs),encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(join(output,'archive-preflight.log'),archive.stderr);assert.equal(archive.status,0);
  const members=JSON.parse(archive.stdout);save('package-runtime-pins.json',members);
  const listed=spawnSync('git',['ls-files','crates','packages','tests/helpers','tests/fixtures','fixtures/schema-v5','fixtures/interop','tests/browser/fixtures/offline-collaboration',
    'tests/extension-dx/configuration-consumer','tests/extension-dx/configuration.test.mjs','tests/browser/browser-harness.ts','tests/browser/fixture-server.mjs','tests/browser/packed-cache.mjs',
    'tests/browser/sdk.spec.ts','tests/browser/offline-collaboration.spec.ts','tests/awareness.test.mjs','tests/outbox.test.mjs','tests/interop.test.mjs','tests/reconnect.test.mjs','tests/sync-protocol.test.mjs',
    'scripts/test-browser.mjs','Cargo.toml','Cargo.lock','package.json','package-lock.json','.node-version'],{encoding:'utf8'});assert.equal(listed.status,0);
  const paths=[...new Set([...listed.stdout.trim().split('\n'),'scripts/run-web-collaboration-boundary.mjs','tests/browser/web-collaboration.spec.ts'])].filter(p=>/\.(?:rs|ts|mjs|js|json|toml|lock|html)$/.test(p)||p==='.node-version');
  const sources=Object.fromEntries(paths.map(p=>[p,sha(readFileSync(p))]));Object.assign(sources,members);verify(sources);save('source-pins.json',sources);
  // Reuse only unchanged lower-level execution. These suites do not import the
  // edited DOM facades, so their exact dependency closure is independently pinned.
  const lower=Object.fromEntries(Object.entries(sources).filter(([p])=>p.startsWith('crates/')||(p.startsWith('packages/core/src/')||/^packages\/core\/dist\/(?:index\.js|engine\.js|wasm\/)/.test(p))||/^packages\/web\/(?:src|dist)\/(?:sync|storage)\//.test(p)||p.startsWith('fixtures/')||p.startsWith('tests/helpers/')||p.startsWith('tests/fixtures/')||/^(?:Cargo|package)[.-]/.test(p)||/tests\/(?:browser\/)?(?:awareness|outbox|interop|reconnect|sync-protocol|offline-collaboration)\./.test(p)||p.startsWith('tests/browser/fixtures/offline-collaboration/')));
  const prior=process.env.EDITAC_COLLABORATION_REUSE;assert.ok(prior,'Name unchanged accepted direct boundary execution');
  const priorExecution=json(join(prior,'execution.json')),priorSources=json(join(prior,'source-pins.json'));
  for(const [p,h] of Object.entries(lower)) assert.equal(priorSources[p],h,'Changed direct proof input: '+p);
  for(const name of ['transport','offline']) {
    const command=priorExecution.commands.find(c=>c.log===name+'.tap');assert.equal(command.exit,0);assert.equal(command.signal,null);
    const raw=readFileSync(join(prior,command.log),'utf8');assert.equal(sha(raw),command.sha256);
    const facts=tapFacts(raw);save(name+'-receipt.json',{...facts,sources:lower,packs,engine:name,sourcesUnchanged:true,
      evidenceMode:'exact-input direct WASM/adapters reuse; packed runtime member equality; not a fresh installed browser execution',originalLog:pin(join(prior,command.log)),originalExecution:pin(join(prior,'execution.json'))});
    execution.reusedCommands.push({name,...command,originalLog:pin(join(prior,command.log))});execution.receipts.push({name,...pin(join(output,name+'-receipt.json'))});
  }
  for(const engine of ['chromium','firefox','webkit']) for(const suite of ['sdk','configuration','web-collaboration']) {
    const name=suite+'-'+engine,dir=join(output,name),log=name+'.tap';
    let reusedBrowser=false;
    for(const cached of (process.env.EDITAC_COLLABORATION_BROWSER_REUSE??'').split(':').filter(Boolean)) {
      const old=json(join(cached,'execution.json')),command=old.commands.find(c=>c.log===log&&c.exit===0);
      if(!command)continue;
      const receiptPath=join(cached,name,suite==='configuration'?'browser/receipt.json':'receipt.json'),receipt=json(receiptPath);
      if(!Object.entries(receipt.sources).every(([p,h])=>sha(readFileSync(p))===h))continue;
      const raw=readFileSync(join(cached,log),'utf8');assert.equal(sha(raw),command.sha256);const facts=tapFacts(raw);
      for(const p of receipt.packs)assert.equal(p.sha256,packs.find(p2=>p2.name===p.name).sha256);
      for(const key of ['browserExited','serverClosed','consumerRemoved'])assert.equal(receipt.cleanup[key],true);
      execution.reusedCommands.push({name,...command,counts:facts.counts,originalLog:pin(join(cached,log))});
      execution.receipts.push({name,...pin(receiptPath)});reusedBrowser=true;break;
    }
    if(reusedBrowser)continue;
    const fd=openSync(join(output,log),'wx');let result;
    const file=suite==='configuration'?'tests/extension-dx/configuration.test.mjs':'tests/browser/'+suite+'.spec.ts';
    const env={...process.env,[`EDITAC_${suite.toUpperCase().replaceAll('-','_')}_OUTPUT`]:dir,[`EDITAC_${suite.toUpperCase().replaceAll('-','_')}_BROWSER`]:engine,EDITAC_EXTENSION_DX_OUTPUT:dir,EDITAC_CONFIGURATION_RUNTIME_PINS:join(output,'current-generated-artifacts.json')};
    const args=['--test','--test-reporter=tap',file];
    try { result=spawnSync(process.execPath,args,{env,stdio:['ignore',fd,fd]}); } finally {closeSync(fd);}
    const command={program:process.execPath,args,log,exit:result.status,signal:result.signal,...(result.error?{error:result.error.message}:{}),sha256:sha(readFileSync(join(output,log)))};
    execution.commands.push(command);save('execution.json',execution);
    assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,'See '+log);
    command.counts=tapFacts(readFileSync(join(output,log),'utf8')).counts;
    const receiptPath=join(dir,suite==='configuration'?'browser/receipt.json':'receipt.json'),receipt=json(receiptPath);
    assert.equal(receipt.engine,engine);assert.notEqual(receipt.sourcesUnchanged,false);verify(receipt.sources);
    for(const key of ['browserExited','serverClosed','consumerRemoved'])assert.equal(receipt.cleanup[key],true);
    for(const pack of receipt.packs)assert.equal(pack.sha256,packs.find(p=>p.name===pack.name).sha256,'Installed current package');
    for(const c of receipt.cases)assert.equal(c.passed,true);
    execution.receipts.push({name,...pin(receiptPath)});verify(sources);save('execution.json',execution);
  }
  execution.counts=[...execution.commands,...execution.reusedCommands].reduce((a,c)=>{for(const [k,v]of Object.entries(c.counts))a[k]=(a[k]??0)+v;return a;},{});
  execution.freshExecuted=execution.commands.reduce((n,c)=>n+c.counts.executed,0);execution.reusedExecuted=execution.counts.executed-execution.freshExecuted;execution.exit=0;
} catch(error){execution.exit=1;execution.failure=error.stack;process.exitCode=1;}
finally{execution.finished=new Date().toISOString();save('execution.json',execution);console.log(JSON.stringify({exit:execution.exit,counts:execution.counts,failure:execution.failure}));}
