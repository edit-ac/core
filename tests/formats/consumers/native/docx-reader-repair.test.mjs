import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const out=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
test('repaired immutable oracle package and unchanged tested binaries match current inputs',()=>{
 const p=JSON.parse(readFileSync(resolve(out,'prepared.json')));
 assert.equal(hash(p.archive),p.archiveSha256);
 for(const [name,pin] of Object.entries(p.sourcePins)) {
  assert.equal(hash(resolve(name)),pin.sha256,name);
  assert.equal(hash(resolve(p.consumer,name)),pin.sha256,name);
 }
 for(const [path,pin] of Object.entries(p.noticePins))assert.equal(hash(path),pin);
 for(const b of Object.values(p.binaries))assert.equal(hash(b.path),b.sha256);
 const reuse=JSON.parse(readFileSync(resolve(out,'reuse.json')));
 assert.deepEqual(reuse.changedMembers,['tests/formats/consumers/native/docx-oracle.py']);
 assert.ok(reuse.unchangedCompiledInputs>300);
});
test('repaired independent package/textutil oracle rejects semantic mutations',()=>{
 const p=JSON.parse(readFileSync(resolve(out,'prepared.json')));
 const args=[resolve(p.consumer,'tests/formats/consumers/native/docx-oracle.py'),out];
 const r=spawnSync('python3',args,{cwd:p.consumer,encoding:'utf8',timeout:30000});
 writeFileSync(resolve(out,'reader.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(out,'reader-command.json'),JSON.stringify({program:'python3',args,cwd:p.consumer,exit:r.status,signal:r.signal},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,'see reader.log');
 const result=JSON.parse(r.stdout);assert.equal(result.passed,15);assert.equal(result.failed,0);assert.equal(result.skipped,0);
});
