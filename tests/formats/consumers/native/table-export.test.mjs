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
for(const name of ['dialects','frozen-input','selection','loss','captured','invalid','limits','cancel','completion','oracle-negatives','authority']){
 test(`actual isolated native selected-table export: ${name}`,()=>{
  const raw=run('python3',['tests/formats/consumers/native/table-export-case.py',name],'table-export-'+name);
  assert.equal(JSON.parse(raw).passed,true);
 });
}
