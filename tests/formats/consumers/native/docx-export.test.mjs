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
for(const name of ['supported','reader','captured','frozen-input','loss','assets','invalid','limits','cancel','completion','authority']){
 test(`actual isolated native DOCX semantic export: ${name}`,()=>{
  const raw=run('python3',['tests/formats/consumers/native/docx-export-case.py',name],'docx-export-'+name);
  assert.equal(JSON.parse(raw).passed,true);
 });
}

test('native DOCX build enables only the admitted optional container stack',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats-native/Cargo.toml','--locked','--offline','--features','docx-export','-e','normal'],'docx-enabled-graph');
 assert.match(graph,/zip v8\.6\.0/);assert.match(graph,/quick-xml v0\.41\.0/);
 assert.match(graph,/docx-rs v0\.4\.22/);
 assert.ok(!/krilla|rustybuzz|image v|reqwest/.test(graph));
});

for (const name of ['supported','assets','cancel','completion']) {
 test(`ODT regression for shared native approved-original transport: ${name}`,()=> {
  const raw=run('python3',['tests/formats/consumers/native/odt-export-case.py',name],'odt-shared-'+name);
  assert.equal(JSON.parse(raw).passed,true);
 });
}
