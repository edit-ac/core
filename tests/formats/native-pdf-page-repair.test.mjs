import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
test('final source package, compiled binaries, fixture and notice pins are intact',()=>{
 const p=JSON.parse(readFileSync(resolve(output,'prepared.json')));
 assert.equal(hash(p.archive),p.archiveSha256);
 for(const [name,pin]of Object.entries(p.sourcePins)){
  assert.equal(hash(resolve(name)),pin.sha256,name);assert.equal(hash(resolve(p.consumer,name)),pin.sha256,name);
 }
 for(const [path,pin]of Object.entries(p.noticePins))assert.equal(hash(path),pin);
 for(const b of Object.values(p.binaries))assert.equal(hash(b.path),b.sha256);
 assert.equal(hash(resolve(output,'THIRD-PARTY-NOTICES.txt')),p.noticesSha256);
});
test('actual native PDF rejects one admitted paragraph exceeding the page limit',()=>{
 const r=spawnSync('python3',['tests/formats/consumers/native/pdf-export-case.py','limits'],{env:process.env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 writeFileSync(resolve(output,'pdf-page-repair.log'),(r.stdout??'')+(r.stderr??''));
 assert.ifError(r.error);assert.equal(r.status,0,'see pdf-page-repair.log');assert.equal(JSON.parse(r.stdout).passed,true);
});
