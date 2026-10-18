import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(program,args,name,cwd=process.cwd()){
 const start=performance.now();const r=spawnSync(program,args,{cwd,env:process.env,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,cwd,exit:r.status,signal:r.signal,hostEndToEndMs:performance.now()-start},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,`see ${name}.log`);return r.stdout;
}
test('exact preflight packages local sources, notices and compiled production/probe targets',()=>{
 // Preparation may be reused only when every exact source/fixture/notice/binary
 // pin still matches. A missing retained fixture fails before feature execution.
 const path=resolve(output,'prepared.json');
 if(!existsSync(path))run('python3',['tests/formats/consumers/native/prepare.py'],'prepare');
 const p=JSON.parse(readFileSync(path));
 assert.equal(hash(p.archive),p.archiveSha256);
 for(const [name,pin]of Object.entries(p.sourcePins)){
   assert.equal(hash(resolve(name)),pin.sha256,`current source changed: ${name}`);
   assert.equal(hash(resolve(p.consumer,name)),pin.sha256,`immutable member: ${name}`);
 }
 for(const [path,pin]of Object.entries(p.noticePins))assert.equal(hash(path),pin);
 assert.equal(hash(resolve(output,'THIRD-PARTY-NOTICES.txt')),p.noticesSha256);
 assert.ok(p.dependencies.length>50);
 assert.ok(!p.dependencies.some(d=>/krilla|rustybuzz|image|reqwest/.test(d.name)));
 assert.ok(p.dependencies.some(d=>d.name==='zip'));
 for(const b of Object.values(p.binaries))assert.equal(hash(b.path),b.sha256);
 for(const [path,pin]of Object.entries(p.fixtures))assert.equal(hash(resolve(path)),pin);
});
for(const name of ['supported','oracle','loss','media','invalid','atomic','limits','cancel','frozen','completion','authority']){
 test(`actual isolated native ODT import prerequisite: ${name}`,()=>{
  const raw=run('python3',['tests/formats/consumers/native/odt-import-case.py',name],'odt-import-'+name);
  assert.equal(JSON.parse(raw).passed,true);
 });
}
test('default editor graph excludes native converter, codecs and fonts',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'disabled-graph');
 assert.equal(graph.trim().split('\n').length,1);
 const native=run('cargo',['tree','--manifest-path','crates/editac-formats-native/Cargo.toml','--locked','--offline','-e','normal'],'native-graph');
 assert.match(native,/editac-session/);assert.ok(!/krilla|docx-rs|rustybuzz|zip v|image v/.test(native));
 const base=JSON.parse(readFileSync('packages/core/package.json'));assert.ok(!JSON.stringify(base.dependencies??{}).includes('formats'));
});

test('optional native ODT import graph includes only admitted container dependencies',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats-native/Cargo.toml','--locked','--offline','--features','odt-import','-e','normal'],'odt-import-enabled-graph');
 assert.match(graph,/zip v8\.6\.0/);assert.match(graph,/quick-xml v0\.41\.0/);
 assert.ok(!/docx-rs|krilla|rustybuzz|reqwest|image v/.test(graph));
});


test('native ODT export remains functional with optional import enabled',()=>{
 assert.equal(JSON.parse(run('python3',['tests/formats/consumers/native/odt-export-case.py','supported'],'odt-export-regression')).passed,true);
});
