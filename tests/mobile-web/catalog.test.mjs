import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertIndex, catalogRows, selectGroup, assertCounts } from './catalog.mjs';
const index=JSON.parse(readFileSync(new URL('./case-index.json',import.meta.url),'utf8'));
test('MWF-1.1 all 64 IDs preserve original ownership and unexecuted/device provenance',()=>{
 assertIndex(index);for(let n=8;n<=12;n++){const row=index.cases.find(r=>r.id===`MBC-${String(n).padStart(2,'0')}`);assert.equal(row.originalParent,'MWB-1.6');assert.equal(row.projectedParent,'MWF-1.6');}
});
for(const kind of ['missing','duplicate','stale','owner','provenance'])test(`MWF-1.1 catalog rejects ${kind}`,()=>{
 const bad=structuredClone(index);
 if(kind==='missing')bad.cases.pop();if(kind==='duplicate')bad.cases.push(bad.cases[0]);if(kind==='stale')bad.cases[0].sourceSha256='stale';if(kind==='owner')bad.cases[0].originalParent='MWB-1.3';if(kind==='provenance')bad.cases[0].provenance.device='passed';
 assert.throws(()=>assertIndex(bad),assert.AssertionError);
});
test('MWF-1.1 changed source contract invalidates frozen registration',()=>{
 const rows=catalogRows();rows[0].expected+=' changed';assert.throws(()=>assertIndex(index,rows));
});
test('MWF-1.1 strict groups reject invalid, unimplemented and empty dispatch',()=>{
 assert.equal(selectGroup(['--group','harness']).length,2);assert.equal(selectGroup(['--group','touch']).length,1);
 for(const args of [[],['--group','all'],['--group','capabilities'],['--group','unknown'],['--group','harness','extra']])assert.throws(()=>selectGroup(args));
 assert.throws(()=>selectGroup(['--group','empty'],{empty:[]}),/Empty/);
 for(const group of ['unknown','capabilities','all']){const r=spawnSync(process.execPath,['scripts/test-mobile-web.mjs','--group',group],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Unknown or unimplemented/);}
});
test('MWF-1.1 zero, failed, skipped or cancelled required checks cannot qualify',()=>{
 const valid={executed:3,passed:3,failed:0,skipped:0,cancelled:0};assertCounts(valid);
 for(const bad of [{executed:0,passed:0},{passed:2},{failed:1},{skipped:1},{cancelled:1}])assert.throws(()=>assertCounts({...valid,...bad}));
});
