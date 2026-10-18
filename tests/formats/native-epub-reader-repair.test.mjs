import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
test('native EPUB generated artifact oracle uses the pinned independent reader environment',()=>{
 const r=spawnSync('python3',['tests/formats/consumers/native/epub-export-case.py','reader'],{env:process.env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 writeFileSync(resolve(process.env.EDITAC_FORMATS_OUTPUT,'epub-reader-repair.log'),(r.stdout??'')+(r.stderr??''));
 assert.ifError(r.error);assert.equal(r.status,0,'see epub-reader-repair.log');assert.equal(JSON.parse(r.stdout).passed,true);
});
