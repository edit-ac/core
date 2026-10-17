import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT,'isolated');
mkdirSync(output,{recursive:true});
const binary=resolve(process.env.CARGO_TARGET_DIR,'release/examples/pdf_document');
const python=process.env.EDITAC_PDF_PYTHON;
const fonts=resolve('fixtures/formats/fonts');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(program,args,name){
 const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,exit:r.status,signal:r.signal},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,'see '+name+'.log');return r;
}
function job(name,changes={}){
 const root=resolve(output,name);mkdirSync(root,{recursive:true});
 const config={root,binary,binarySha256:hash(binary),fonts,fontManifest:resolve(fonts,'provenance.json'),mode:'document',document:'text',...changes};
 const path=resolve(root,'config.json');writeFileSync(path,JSON.stringify(config,null,2)+'\n');
 run(python,['tests/formats/pdf-process.py',path],name+'-launcher');
 const r=JSON.parse(readFileSync(resolve(root,'process.json')));assert.equal(r.childExited,true);return r;
}
test('build and retain exact semantic Session/job executable; fonts and fixtures are pinned embedded assets',()=>{
 run('cargo',['build','--release','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','pdf-export','--example','pdf_document'],'build');
 copyFileSync(binary,resolve(output,'pdf_document-native'));
 for(const file of ['provenance.json','rich-provenance.json']){
  const m=JSON.parse(readFileSync(resolve(fonts,file)));for(const [name,info] of Object.entries(m.files))assert.equal(hash(resolve(fonts,name)),info.sha256);
 }
});
for(const kind of ['text','rich','structure'])test('isolated captured '+kind+' cold/warm artifacts and independent WCF-13/14 negatives',()=>{
 const receipts=[];
 for(const phase of ['cold','warm']){
  const name=kind+'-'+phase;const r=job(name,{document:kind});receipts.push(r);
  assert.equal(r.state,'passed',JSON.stringify(r));assert.equal(r.executed,1);assert.equal(r.exit,0);
  assert.ok(r.peakObservedRssBytes>0);assert.ok(r.peakObservedRssBytes<=512*1024*1024);
  assert.deepEqual(r.environmentKeys,['HOME','LANG','PATH','TMPDIR']);
  const d=r.documentSummary;assert.equal(d.kind,kind);assert.equal(d.laterEditUnchanged,true);assert.equal(d.ownedAssetCleanup,true);
  assert.ok(d.pages>1);assert.ok(d.shapedBytes>0);assert.ok(d.fontBytesEmbedded>1000000);
  assert.equal(d.originalReads,kind==='structure'?1:0);assert.equal(d.pixels,kind==='structure'?7200:0);
  const root=resolve(output,name);copyFileSync(resolve(root,'output.pdf'),resolve(root,kind+'-publication.pdf'));
  const args=['tests/formats/inspect-pdf-'+(kind==='text'?'export':kind)+'.py',root,'fixtures/formats/pdf/export/'+kind+'.json'];
  if(kind==='structure')args.push('fixtures/formats/pdf/export/panels.png');
  run(python,args,name+'-oracle');
  if(kind==='text')run(python,['tests/formats/inspect-pdf-arabic.py',root,'fixtures/formats/pdf/export/arabic-glyphs.json'],name+'-arabic-oracle');
  const inspected=JSON.parse(readFileSync(resolve(root,kind==='text'?'independent-inspection.json':kind+'-inspection.json')));
  assert.equal(inspected.rejectedMutations.length,kind==='text'?5:kind==='rich'?4:6);
 }
 assert.equal(receipts[0].outputSha256,receipts[1].outputSha256,'fixed fixture output stable across process launches');
 writeFileSync(resolve(output,kind+'-resources.json'),JSON.stringify({binaryBytes:statSync(binary).size,definition:'cold/warm are sequential fresh isolated processes; OS cache uncontrolled, no warm-process or browser claim',receipts},null,2)+'\n');
});
test('semantic executable is denied ambient read/write/network/child authority by actual sandbox',()=>{
 const secret=resolve(output,'outside-secret.txt');writeFileSync(secret,'deterministic private fixture');
 const denied=resolve(output,'outside-write.txt');
 for(const [mode,attemptPath] of [['read',secret],['write',denied],['network',undefined],['child',undefined]]){
  const r=job('denied-'+mode,{mode,attemptPath});assert.equal(r.state,'rejected');assert.equal(r.exit,2);
  assert.match(readFileSync(resolve(output,'denied-'+mode,'stderr.log'),'utf8'),/PDF_AUTHORITY_DENIED:PermissionDenied/);
  assert.equal(r.outputExists,false);
 }
 assert.equal(existsSync(denied),false);assert.equal(readFileSync(secret,'utf8'),'deterministic private fixture');
});
test('actual document cancellation, deadline, sampled memory and output limits remove job-owned partial artifact',()=>{
 for(const [name,changes,code] of [
  ['cancel',{cancelAfterMs:0},'PDF_CANCELLED'],
  ['deadline',{limits:{wallMs:1}},'PDF_DEADLINE'],
  ['memory',{limits:{rssBytes:1}},'PDF_MEMORY_LIMIT'],
  ['output',{limits:{outputBytes:1024}},null],
 ]){
  const r=job('limit-'+name,changes);assert.equal(r.state,'rejected',JSON.stringify(r));assert.equal(r.executed,1);assert.equal(r.outputExists,false);
  if(code)assert.equal(r.code,code);else assert.notEqual(r.exit,0);
 }
});
test('unavailable isolation and occupied output refuse before document execution',()=>{
 const r=job('unavailable',{isolation:false});assert.equal(r.code,'PDF_ISOLATION_UNAVAILABLE');assert.equal(r.executed,0);
 const root=resolve(output,'occupied');mkdirSync(root);writeFileSync(resolve(root,'output.pdf'),'existing recoverable artifact');
 const occupied=job('occupied');assert.equal(occupied.code,'PDF_OUTPUT_TARGET_OCCUPIED');assert.equal(occupied.executed,0);
 assert.equal(readFileSync(resolve(root,'output.pdf'),'utf8'),'existing recoverable artifact');
});
