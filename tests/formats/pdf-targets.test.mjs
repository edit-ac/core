import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const target=resolve(process.env.CARGO_TARGET_DIR);
const python=process.env.EDITAC_PDF_PYTHON;
const fonts=resolve('fixtures/formats/fonts');
const binary=resolve(target,'debug/examples/pdf_probe');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(program,args,name){
 const start=performance.now();const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,exit:r.status,signal:r.signal,durationMs:performance.now()-start},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,'see '+name+'.log');return r;
}
function job(name,changes={}){
 const root=resolve(output,name);mkdirSync(root,{recursive:true});
 const config={root,binary,binarySha256:hash(binary),fonts,fontManifest:resolve(fonts,'provenance.json'),mode:'generate',...changes};
 const path=resolve(root,'config.json');writeFileSync(path,JSON.stringify(config,null,2)+'\n');
 run(python,['tests/formats/pdf-process.py',path],name+'-launcher');
 const r=JSON.parse(readFileSync(resolve(root,'process.json'),'utf8'));
 assert.equal(r.childExited,true);return r;
}
test('build exact optional krilla native candidate and retain executable',()=>{
 run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','pdf-probe','--example','pdf_probe'],'pdf-native');
 copyFileSync(binary,resolve(output,'pdf_probe-native'));assert.ok(statSync(binary).size>8);
});
test('same selected writer and shaping APIs compile for WASM; runtime unavailable',()=>{
 run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','pdf-probe','--example','pdf_probe','--target','wasm32-unknown-unknown'],'pdf-wasm');
 const p=resolve(target,'wasm32-unknown-unknown/debug/examples/pdf_probe.wasm');
 assert.deepEqual([...readFileSync(p).subarray(0,4)],[0,97,115,109]);copyFileSync(p,resolve(output,'pdf_probe.wasm'));
});
test('selected dependency graph has no PDF reader, raster decoder or native font/network backend',()=>{
 const r=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','pdf-probe','-e','normal'],'pdf-graph');
 assert.match(r.stdout,/krilla v0\.8\.2/);assert.match(r.stdout,/rustybuzz v0\.20\.1/);
 assert.doesNotMatch(r.stdout,/hayro|mupdf|poppler|pdfium|reqwest|ureq|native-tls|fontconfig|core-text|image v|zune-jpeg|png v/);
});
test('default optional registry remains free of converters and fonts',()=>{
 const r=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'pdf-disabled-graph');
 assert.equal(r.stdout.trim(),'editac-formats v0.0.0 ('+resolve('crates/editac-formats')+')');
});
test('locked font bytes, OFL permissions and selected dependency notice coverage',()=>{
 const manifest=JSON.parse(readFileSync(resolve(fonts,'provenance.json')));
 for(const [name,r] of Object.entries(manifest.files))assert.equal(hash(resolve(fonts,name)),r.sha256);
 assert.match(readFileSync(resolve(fonts,'OFL.txt'),'utf8'),/SIL OPEN FONT LICENSE/);
 const notices=JSON.parse(readFileSync(process.env.EDITAC_PDF_NOTICES));
 assert.ok(notices.packages.length>20);assert.ok(notices.packages.every(x=>x.license&&x.notices.length&&!x.error));
});
test('WCF-12 real native cold and warm output use only pinned fonts',()=>{
 for(const name of ['cold','warm']){
  const r=job(name);assert.equal(r.state,'passed',JSON.stringify(r));assert.equal(r.executed,1);assert.ok(r.outputBytes>1000);
  assert.ok(r.peakObservedRssBytes>0);assert.ok(r.peakObservedRssBytes<=512*1024*1024);
  assert.deepEqual(r.environmentKeys,['HOME','LANG','PATH','TMPDIR']);
 }
});
test('WCF-12 missing required face refuses output even with host fonts present',()=>{
 const p=resolve(output,'one-font');mkdirSync(p);copyFileSync(resolve(fonts,'NotoSans-Regular.ttf'),resolve(p,'NotoSans-Regular.ttf'));
 const r=job('missing-font',{fonts:p});assert.equal(r.code,'PDF_FONT_UNAVAILABLE');assert.equal(r.executed,0);assert.equal(r.outputExists,false);
});
test('WCF-12 changed face bytes refuse substitution before execution',()=>{
 const p=resolve(output,'wrong-font');mkdirSync(p);
 for(const name of ['NotoSans-Regular.ttf','NotoNaskhArabic-Regular.ttf'])copyFileSync(resolve(fonts,'NotoSans-Regular.ttf'),resolve(p,name));
 const r=job('substituted-font',{fonts:p});assert.equal(r.code,'PDF_FONT_UNAVAILABLE');assert.equal(r.executed,0);
});
test('sandbox blocks ambient file reads outside approved job and font root',()=>{
 const secret=resolve(output,'ambient.txt');writeFileSync(secret,'prepared deterministic canary');
 const r=job('read-denied',{mode:'read',attemptPath:secret});assert.equal(r.exit,2);
 assert.match(readFileSync(resolve(output,'read-denied/stderr.log'),'utf8'),/PDF_READ_DENIED/);
});
test('sandbox blocks writes outside the exact output destination',()=>{
 const p=resolve(output,'forbidden-write.txt');const r=job('write-denied',{mode:'write',attemptPath:p});assert.equal(r.exit,2);assert.equal(existsSync(p),false);
});
test('sandbox denies network with PermissionDenied rather than connection failure',()=>{
 const r=job('network-denied',{mode:'network'});assert.equal(r.exit,2);
 assert.match(readFileSync(resolve(output,'network-denied/stderr.log'),'utf8'),/PDF_NETWORK_DENIED:PermissionDenied/);
});
test('sandbox denies child execution under the exact native converter policy',()=>{
 const r=job('child-denied',{mode:'child'});assert.equal(r.exit,2);
 assert.match(readFileSync(resolve(output,'child-denied/stderr.log'),'utf8'),/PDF_CHILD_DENIED/);
});
test('deadline terminates active work and removes incomplete output',()=>{
 const r=job('deadline',{mode:'spin',limits:{wallMs:150}});assert.equal(r.code,'PDF_DEADLINE');assert.equal(r.outputExists,false);assert.ok(r.durationMs<1500);
});
test('cancellation terminates active work and leaves no successful artifact',()=>{
 const r=job('cancel',{mode:'spin',cancelAfterMs:100});assert.equal(r.code,'PDF_CANCELLED');assert.equal(r.outputExists,false);
});
test('RSS watchdog kills measured allocation work and records sampling interval',()=>{
 const r=job('memory',{mode:'allocate',limits:{rssBytes:48*1024*1024}});assert.equal(r.code,'PDF_MEMORY_LIMIT');assert.ok(r.peakObservedRssBytes>48*1024*1024);assert.ok(r.rssSamples>1);assert.ok(r.maxSampleIntervalMs>0);assert.equal(r.outputExists,false);
});
test('OS file size limit refuses oversized writes and deletes partial artifact',()=>{
 const r=job('output-limit',{mode:'output',limits:{outputBytes:32768}});assert.equal(r.code,'PDF_OUTPUT_LIMIT');assert.notEqual(r.exit,0);assert.equal(r.outputExists,false);
});
test('an occupied output target is preserved before process launch',()=>{
 const p=resolve(output,'occupied');mkdirSync(p);writeFileSync(resolve(p,'output.pdf'),'prepared existing artifact');
 const r=job('occupied');assert.equal(r.code,'PDF_OUTPUT_TARGET_OCCUPIED');assert.equal(r.executed,0);
 assert.equal(readFileSync(resolve(p,'output.pdf'),'utf8'),'prepared existing artifact');
});
test('missing isolation and invalid engine pin are typed unavailable with zero execution',()=>{
 for(const [name,c,code] of [['isolation-unavailable',{isolation:false},'PDF_ISOLATION_UNAVAILABLE'],['engine-unavailable',{binarySha256:'bad'},'PDF_ENGINE_UNAVAILABLE']]){
  const r=job(name,c);assert.equal(r.code,code);assert.equal(r.executed,0);assert.equal(r.outputExists,false);
 }
});
test('independent generated PDF structure, embedded fonts, text and rendered-page inspection',()=>{
 run(python,['tests/formats/inspect-pdf-probe.py',output,fonts],'pdf-independent');
});
