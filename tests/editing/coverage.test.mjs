import { editingPackedCache } from '../browser/editing-packed-cache.mjs';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourcePins, hash, requiredStages, verifyCoverage, reusableStage } from '../../scripts/editing-coverage.mjs';
import { assertCheckpoint } from './driver.ts';
const root=mkdtempSync(join(tmpdir(),'rgs-g14-'));after(()=>rmSync(root,{recursive:true,force:true}));
for(const p of ['scripts','.github/workflows','tests/editing','tests/browser','fixtures','examples','crates','packages','evidence'])mkdirSync(join(root,p),{recursive:true});
for(const p of ['Cargo.toml','Cargo.lock','package.json','package-lock.json','.node-version'])writeFileSync(join(root,p),'prepared integrity fixture');
writeFileSync(join(root,'engine.wasm'),'prepared unit fixture, never runtime evidence');
mkdirSync(join(root,'node_modules/playwright'),{recursive:true});mkdirSync(join(root,'node_modules/playwright-core'),{recursive:true});
writeFileSync(join(root,'node_modules/playwright/package.json'),JSON.stringify({version:'1.64.0'}));
writeFileSync(join(root,'node_modules/playwright-core/browsers.json'),JSON.stringify({browsers:['chromium','firefox','webkit'].map(name=>({name,browserVersion:'prepared'}))}));
const directory=join(root,'evidence');
const cases={semantic:['G02/G03/G04/G06 independent checkpoint negative controls','REG-05','REG-06','REG-07','REG-13',...Array.from({length:14},(_,i)=>`SEQ-${String(i+1).padStart(2,'0')}`)],history:['REG-01/a','REG-02/a','REG-03/a','REG-04/a','G07/actual-merged-paste-fault-is-detected','SEQ-08'],properties:['native/editac-core'],failures:['REG-12-throw','G11-cancel','disposed-adapters','new-session','SEQ-09'],input:['REG-14-end','REG-16-missing','G05-dispatcher-expiry','G09-native','SEQ-10'],presenters:['tag-forward','custom-false','nested-false','profile-false','external-drop','atom-only-delete'],'history-selection':['heading-end-history-selection'],baseline:['baseline'],fixtures:['binding']};
const summary=n=>`# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
const suite={hashes:{fixture:hash('independent expected')},recipes:Array.from({length:14},(_,i)=>({id:`SEQ-${String(i+1).padStart(2,'0')}`})),manifest:{guards:Array.from({length:14},(_,i)=>({id:`G${String(i+1).padStart(2,'0')}`}))},catalogs:[{id:'OLD-01',path:'tests/editor-interaction-cases.md',status:'planned',variants:[{id:'OLD-01:source-1',status:'planned'}]},{id:'REG-01',path:'tests/editor-regression-cases.md',status:'planned',variants:[]}]};
function prepared(){
 const builds=['build-wasm','build'].map(name=>{writeFileSync(join(directory,name+'.log'),'prepared build');return {name,exit:0,log:name+'.log',logSha256:hash('prepared build')};});
 writeFileSync(join(directory,'pack.log'),'prepared pack');writeFileSync(join(directory,'pack.tgz'),'prepared unit package');
 const r={builds,packBuild:{exit:0,log:'pack.log',logSha256:hash('prepared pack')},pack:{path:'pack.tgz',sha256:hash('prepared unit package')},schemaVersion:1,profile:'infrastructure',node:'v24.19.0',deployed:false,playwright:'1.64.0',sourcePins:sourcePins(root),fixturePins:suite.hashes,artifactPins:{'engine.wasm':hash(readFileSync(join(root,'engine.wasm')))},browserVersions:{chromium:'prepared',firefox:'prepared',webkit:'prepared'},stages:[]};
 for(const name of requiredStages){
  const n=name==='integrity'?13:name==='baseline'?9:(cases[name].length*(['input','presenters','history-selection'].includes(name)?3:1)+(name==='semantic'?3:0));
  const text=name==='integrity'?Array.from({length:11},(_,i)=>`ok ${i+1} - G14 rejects prepared corruption ${i}`).join('\n')+'\nok 12 - G14 wrong independent expected state\n'+summary(n):summary(n);
  writeFileSync(join(directory,`${name}.log`),text);
  const s={name,exit:0,log:`${name}.log`,logSha256:hash(text),counts:{executed:n,passed:n,failed:0,cancelled:0,skipped:0,todo:0},reports:[]};r.stages.push(s);
  if(name==='integrity')continue;
  for(const label of name==='baseline'?['chromium-render','chromium-keyboard','chromium-example','firefox-render','firefox-keyboard','firefox-example','webkit-render','webkit-keyboard','webkit-example']:['input','presenters','history-selection'].includes(name)?['chromium','firefox','webkit']:[null]){
   const engine=label?.split('-')[0];
   const rows=cases[name].map(id=>({id,status:'passed',assertions:1,trace:id==='native/editac-core'?[{case:'REG-08/G10/fixed-point',passed:true},{case:'G10/negative-controls',passed:true}]:[]}));
   const data={cases:rows,counts:{executed:rows.length,passed:rows.length,failed:0,skipped:0},negativeControls:['prepared-control'],fixtureHashes:suite.hashes};
   if(engine)Object.assign(data,{engine,browser:{engine,node:r.node,playwright:r.playwright,version:'prepared'},cleanup:{browserExited:true,serverClosed:true,consumerRemoved:true,listenerRemoved:true},packs:[]});
   const path=`${name}-${label??'packed'}.json`;writeFileSync(join(directory,path),JSON.stringify(data));s.reports.push({path,sha256:hash(readFileSync(join(directory,path)))});
  }
 }
 return r;
}
const check=r=>verifyCoverage(r,{root,directory,suite});
test('G14 valid prepared receipt keeps catalog variants and release unqualified',()=>{const r=check(prepared());assert.equal(r.releaseQualified,false);assert.equal(r.catalogs[0].status,'planned');assert.equal(r.catalogs[1].variantCompleteness,'unqualified');});
for(const [name,mutate] of [
 ['missing group',r=>r.stages.pop()],['failed execution',r=>r.stages[0].exit=1],['zero assertions',r=>{const a=r.stages.find(s=>s.name==='semantic').reports[0],p=join(directory,a.path),d=JSON.parse(readFileSync(p));d.cases[0].assertions=0;d.cases[0].negativeControls=3;writeFileSync(p,JSON.stringify(d));a.sha256=hash(readFileSync(p));}],
 ['missing case',r=>{const a=r.stages.find(s=>s.name==='history').reports[0],p=join(directory,a.path),d=JSON.parse(readFileSync(p));d.cases=d.cases.filter(c=>!c.id.startsWith('REG-04'));d.counts.executed=d.counts.passed=d.cases.length;writeFileSync(p,JSON.stringify(d));a.sha256=hash(readFileSync(p));}],
 ['fabricated count',r=>r.stages[0].counts.executed=99],['skipped mandatory check',r=>{const s=r.stages[0],text=summary(1).replace('# pass 1','# pass 0').replace('# skipped 0','# skipped 1');writeFileSync(join(directory,s.log),text);s.logSha256=hash(text);s.counts.passed=0;s.counts.skipped=1;}],
 ['stale implementation',r=>r.sourcePins['Cargo.lock']=hash('different')],['stale expected fixture',r=>r.fixturePins.fixture=hash('different')],['wrong platform revision',r=>r.browserVersions.webkit='wrong'],['fabricated raw report',r=>r.stages[1].reports[0].sha256=hash('invented')],['stale WASM',r=>r.artifactPins['engine.wasm']=hash('different')],
])test(`G14 rejects ${name}`,()=>{const r=prepared();mutate(r);assert.throws(()=>check(r),assert.AssertionError);});
for (const [name,mutate] of [
 ['baseline platform revision',d=>d.browser.version='incorrect'],
 ['baseline source revision',d=>d.sources={'Cargo.lock':hash('incorrect')}],
 ['baseline case total',d=>{d.cases=[];d.counts.executed=d.counts.passed=0;}],
]) test(`G14 rejects ${name}`,()=>{
 const r=prepared(),a=r.stages.find(s=>s.name==='baseline').reports[0],p=join(directory,a.path),d=JSON.parse(readFileSync(p));
 mutate(d);writeFileSync(p,JSON.stringify(d));a.sha256=hash(readFileSync(p));assert.throws(()=>check(r),assert.AssertionError);
});
test('G14 wrong independent expected state fails instead of updating golden',()=>{
 const state={blocks:[{id:'p1',kind:'paragraph',text:'abc',marks:[],hardBreaks:[]}],selection:{anchor:{block:'p1',offset:3},focus:{block:'p1',offset:3},affinity:'forward'},pendingMarks:null};
 const actual={outcome:'applied',state,revision:1,effects:{localCommits:1,remoteCommits:0}};
 const expected={outcome:'applied',state:structuredClone(state),effects:{localCommits:1,remoteCommits:0}};assertCheckpoint(actual,expected);expected.state.blocks[0].text='abd';assert.throws(()=>assertCheckpoint(actual,expected),assert.AssertionError);assert.equal(actual.state.blocks[0].text,'abc');
 expected.state.blocks[0].text='abc';expected.state.selection.focus.offset=2;assert.throws(()=>assertCheckpoint(actual,expected),assert.AssertionError);
 expected.state.selection.focus.offset=3;expected.effects.localCommits=0;assert.throws(()=>assertCheckpoint(actual,expected),assert.AssertionError);
});

test('G14 shared cached package rejects stale bytes before creating a consumer', async()=>{
 const cache=join(directory,'cache.json'),destination=join(directory,'consumer');mkdirSync(destination,{recursive:true});
 const path=join(directory,'prepared.tgz');writeFileSync(path,'prepared package unit fixture');
 const entry={path,sha256:hash('prepared package unit fixture'),manifest:{name:'@edit-ac/core',filename:'prepared.tgz'}};
 const prior=process.env.EDITAC_EDITING_PACKS;process.env.EDITAC_EDITING_PACKS=cache;
 try{
  writeFileSync(cache,JSON.stringify({core:{...entry,sha256:hash('corrupt')}}));
  await assert.rejects(editingPackedCache('core',destination),assert.AssertionError);
  assert.throws(()=>readFileSync(join(destination,'prepared.tgz')),/ENOENT/);
  writeFileSync(cache,JSON.stringify({core:entry}));const packed=await editingPackedCache('core',destination);
  assert.equal(packed.name,'@edit-ac/core');assert.equal(hash(readFileSync(join(destination,'prepared.tgz'))),entry.sha256);
  await assert.rejects(editingPackedCache('web',destination),assert.AssertionError);
 }finally{if(prior===undefined)delete process.env.EDITAC_EDITING_PACKS;else process.env.EDITAC_EDITING_PACKS=prior;}
});

test('G14 resume reuses only unchanged owning dependencies',()=>{
 const origin=prepared(),current=structuredClone(origin);current.sourcePins['examples/web/index.html']=hash('import-map repair');
 assert.equal(reusableStage('semantic',origin,current),true);assert.equal(reusableStage('baseline',origin,current),false);const consumer=structuredClone(origin);consumer.sourcePins['scripts/editing-coverage.mjs']=hash('consumer repair');assert.equal(reusableStage('baseline',origin,consumer),true);
 for(const path of ['packages/core/src/engine.ts','tests/editing/driver.ts','fixtures/browser-input/session.mjs']){const wrong=structuredClone(current);wrong.sourcePins[path]=hash('changed');assert.equal(reusableStage('semantic',origin,wrong),false);}
 const wrong=structuredClone(current);wrong.artifactPins['engine.wasm']=hash('changed');assert.equal(reusableStage('semantic',origin,wrong),false);
 wrong.artifactPins=current.artifactPins;wrong.fixturePins.fixture=hash('changed');assert.equal(reusableStage('history',origin,wrong),false);
});
