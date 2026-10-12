// Diagnostic evidence only: current qualified v4 replay conflicts with metadata-only conversion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {construct, roots, profile, join, project, snapshot} from './mapping.mjs';
const dir=process.env.EDITAC_BLOCK_CONTRACT_PROBE;
assert.ok(dir,'isolated contract-probe evidence directory required');fs.mkdirSync(dir,{recursive:true});
for(const [name,tuple] of [['paragraph',['paragraph']],['language',['code','js']]]) {
 test(`diagnose joined-code ${name} metadata change invalidating qualified replay`,()=>{
  const d=construct();const attrs=roots(d)[profile.roots[4]];
  d.transact(()=>{attrs.set('n:11:1',['code','rs']);attrs.set('n:11:2',['code','rs']);});join(d,'o:11:1','n:11:1','n:11:2');
  const before=project(d);assert.equal(before.outcomes['o:11:1'],'applied');assert.equal(before.owners.find(o=>o.id==='n:11:1').spans.length,2);assert.ok(!before.owners.some(o=>o.id==='n:11:2'));
  fs.writeFileSync(path.join(dir,`${name}-before.json`),JSON.stringify(snapshot(d)));
  d.transact(()=>attrs.set('n:11:1',tuple));const after=project(d);assert.equal(after.outcomes['o:11:1'],'losing');assert.equal(after.owners.find(o=>o.id==='n:11:1').spans.length,1);assert.ok(after.owners.some(o=>o.id==='n:11:2'));
  fs.writeFileSync(path.join(dir,`${name}-after.json`),JSON.stringify(snapshot(d)));d.destroy();
 });
}
