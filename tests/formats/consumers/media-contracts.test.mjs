import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
test('original media independently matches ZIP XML PNG and rejects altered runtime facts',()=>{
 const r=spawnSync('python3',['tests/formats/consumers/inspect-docx-media.py',output],{encoding:'utf8',timeout:30000});
 writeFileSync(resolve(output,'browser-docx-media-independent.log'),r.stdout+r.stderr);
 assert.ifError(r.error);assert.equal(r.status,0,'see browser-docx-media-independent.log');
 const v=JSON.parse(readFileSync(resolve(output,'docx-media-independent.json')));assert.equal(v.failed,0);assert.equal(v.skipped,0);assert.equal(v.negativeMutations.length,13);
});
