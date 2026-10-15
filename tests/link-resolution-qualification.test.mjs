import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, platform, release, arch, cpus } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.env.EDITAC_LINK_QUALIFICATION_OUTPUT??mkdtempSync(join(tmpdir(),'editac-link-qualification-'));
mkdirSync(output,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const facts={task:'LNK-1.12',revision:git('rev-parse','HEAD'),host:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0].model,node:process.version},provenance:'portable prepared transport and headless packed browser integration; no deployed/native/TUI/OS input claim',checks:[],sources:[],compiled:[],timings:{},limits:{public:{concurrency:4,queue:32,pending:128,cacheEntries:64,positiveMs:300000,negativeMs:5000,queueMs:5000},egress:{connectMs:2000,totalMs:5000,idleMs:1000,bodyBytes:262144,headerBytes:16384,dnsAddresses:16,chunks:1024,redirects:0,compression:'identity only'},metadata:{htmlBytes:262144,tagBytes:8192,tags:2048,mediaBytes:65536},private:{cacheEntries:64,offlineLeaseMs:0,maxOfflineLeaseMs:300000},browser:{pending:16,deadlineMs:15000,rasterBytes:32768}}};
const sourcePaths=git('ls-files','--','crates/editac-session/src/links','crates/editac-session/tests','packages/core/src','packages/web/src','fixtures/links','fixtures/link-presenters','fixtures/browser-link-enrichment','fixtures/browser-private-link-display','fixtures/browser-link-activation','tests/browser/browser-harness.ts','tests/browser/link-enrichment.spec.ts','tests/browser/private-link-display.spec.ts','tests/browser/link-activation.spec.ts','tests/link-contract.test.mjs','tests/link-public-exports.test.mjs','tests/link-activation.test.mjs','package-lock.json','Cargo.lock').split('\n');
sourcePaths.push('tests/link-resolution-qualification.test.mjs');
for(const path of new Set(sourcePaths.filter(Boolean)))facts.sources.push({path,sha256:hash(readFileSync(join(root,path)))});
function walk(directory){for(const entry of readdirSync(join(root,directory),{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else facts.compiled.push({path,sha256:hash(readFileSync(join(root,path)))});}}
walk('packages/core/dist');walk('packages/web/dist');
function run(label,command,args,env={},kind='node'){
 if(kind==='node')args=args.flatMap(a=>a==='--test'?[a,'--test-reporter=tap']:[a]);
 const childEnv={...process.env,...env};delete childEnv.NODE_TEST_CONTEXT;
 const result=spawnSync(command,args,{cwd:root,env:childEnv,encoding:'utf8',timeout:360000,maxBuffer:16*1024*1024});
 const log=(result.stdout??'')+(result.stderr??'');writeFileSync(join(output,label+'.log'),log);
 let counts;
 if(kind==='rust'){
  const rows=[...log.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g)].map(m=>m.slice(1).map(Number));
  counts={tests:rows.reduce((n,r)=>n+r[0]+r[1]+r[2],0),pass:rows.reduce((n,r)=>n+r[0],0),fail:rows.reduce((n,r)=>n+r[1],0),skipped:rows.reduce((n,r)=>n+r[2],0),filtered:rows.reduce((n,r)=>n+r[4],0),binaries:rows.length,perBinary:rows.map(r=>({passed:r[0],failed:r[1],skipped:r[2],filtered:r[4]}))};
 }else counts=Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
 facts.checks.push({label,command,args,env,exit:result.status,error:result.error?.message,counts,log:label+'.log',sha256:hash(log),bytes:Buffer.byteLength(log)});
 assert.equal(result.error,undefined,`${label}: ${result.error?.message}`);assert.equal(result.status,0,`${label}: see ${join(output,label+'.log')}`);
 assert.ok(counts.tests>0,`${label}: zero/missing tests`);assert.equal(counts.pass,counts.tests,label);for(const key of ['fail','skipped','cancelled','filtered','todo'])assert.equal(counts[key]??0,0,`${label}: ${key}`);
 return log;
}
const summary=values=>{assert.ok(values.length>=100);assert.ok(values.every(v=>Number.isFinite(v)&&v>=0));const s=[...values].sort((a,b)=>a-b);return {samples:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s[Math.ceil(s.length*.99)-1],min:s[0],max:s.at(-1)};};
after(()=>{
 facts.sourcesUnchanged=facts.sources.every(({path,sha256})=>hash(readFileSync(join(root,path)))===sha256);
 writeFileSync(join(output,'qualification.json'),JSON.stringify(facts,null,2)+'\n');
 assert.equal(facts.sourcesUnchanged,true,'qualification source changed during execution');
});
test('canonical portable URL, actual-address egress, inert page/icon parsing, scheduling and private auth/cache proofs',()=>{
 const suites=['link_contract','public_url','link_egress','link_metadata','link_public_lifecycle','private_link_auth','private_link_cache'];
 run('portable','cargo',['test','-p','editac-session','--locked','--offline',...suites.flatMap(s=>['--test',s]),'--','--test-threads=1'],{EDITAC_LINK_TIMING_OUTPUT:join(output,'portable-timing.json')},'rust');
 assert.equal(facts.checks.at(-1).counts.binaries,suites.length);assert.ok(facts.checks.at(-1).counts.perBinary.every(c=>c.passed>0));
 const raw=JSON.parse(readFileSync(join(output,'portable-timing.json'),'utf8'));
 assert.equal(raw.samples,120);assert.equal(raw.denied_gets,0);assert.equal(raw.warm_gets,0);assert.equal(raw.cold_gets_including_warmup,130);assert.equal(raw.cache_probe_gets,96);assert.equal(raw.cache_entries_peak,64);assert.equal(raw.cache_entries_after_dispose,0);for(const key of ['whole_process_rss_before_bytes','whole_process_rss_cache64_bytes','whole_process_rss_disposed_bytes'])assert.ok(raw[key]>0);
 facts.timings.portable={...raw,summary:Object.fromEntries(Object.entries(raw).filter(([k])=>k.endsWith('_ns')).map(([k,v])=>[k,summary(v)]))};
});
test('shared browser policy corpus and real engine no-call/no-write contract',()=>run('contract',process.execPath,['--test','tests/link-contract.test.mjs']));
for(const engine of ['chromium','firefox','webkit']){
 test(`${engine}: actual editor local paste, no-call origins, canceled edits, checkpoint restore and focus timing`,()=>{
  const directory=join(output,'enrichment-'+engine);
  run('enrichment-'+engine,process.execPath,['--test','tests/browser/link-enrichment.spec.ts'],{EDITAC_LINK_ENRICHMENT_BROWSER:engine,EDITAC_LINK_ENRICHMENT_OUTPUT:directory});
  const browser=JSON.parse(readFileSync(join(directory,'receipt.json'),'utf8'));
  const timing=browser.cases.find(c=>c.name==='qualification-input-timing');assert.ok(timing?.passed);assert.equal(timing.timings.attempted,130);assert.equal(timing.timings.aborted,130);assert.equal(browser.cleanup.serverClosed,true);assert.equal(browser.cleanup.browserExited,true);
  facts.timings[engine]={browser:browser.browser,...timing.timings,summary:Object.fromEntries(Object.entries(timing.timings.samples).map(([k,v])=>[k,summary(v)]))};
 });
 test(`${engine}: two-viewer private display secrecy, authority changes and teardown`,()=>run('private-'+engine,process.execPath,['--test','tests/browser/private-link-display.spec.ts'],{EDITAC_PRIVATE_LINK_DISPLAY_BROWSER:engine,EDITAC_PRIVATE_LINK_DISPLAY_OUTPUT:join(output,'private-'+engine)}));
 test(`${engine}: current activation/copy authority and no stale target or shell dispatch`,()=>run('activation-'+engine,process.execPath,['--test','tests/link-activation.test.mjs'],{EDITAC_LINK_ACTIVATION_BROWSER:engine,EDITAC_LINK_ACTIVATION_OUTPUT:join(output,'activation-'+engine)}));
}
test('public-only packed portable presenter consumers preserve all states and readonly/cancellation semantics',()=>run('exports',process.execPath,['--test','tests/link-public-exports.test.mjs'],{EDITAC_LINK_EXPORTS_OUTPUT:join(output,'exports')}));
