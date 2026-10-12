// Actual production v5 witnessed ownership and retained-source presentation.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica,bytes,snapshot,project,profile} from './mapping.mjs';
const dir=process.env.EDITAC_STABLE_JOIN_EXCHANGE;
assert.ok(dir,'isolated joined exchange directory required');
const read=n=>fs.readFileSync(path.join(dir,n));
const restore=(n,w)=>{const d=replica(w);Y.applyUpdate(d,read(n));return d;};
const A='n:11:1',B='n:11:2';
test('exact pinned Node Yjs protocol versions for production v5 join exchange',()=>{
 const require=createRequire(import.meta.url);assert.equal(process.version,'v24.19.0');assert.equal(require('yjs/package.json').version,profile.yjs);assert.equal(require('y-protocols/package.json').version,profile.yProtocols);assert.equal(profile.yrs,'0.28.0');
});
for(const presentation of ['language','paragraph']) test(`Rust established joined-owner ${presentation} survives presentation-before/after duplicates and checkpoint`,()=>{
 for(const order of [['joined.bin',`${presentation}.bin`],[`${presentation}.bin`,'joined.bin']]){
  const d=replica(2401);for(const file of order){Y.applyUpdate(d,read(file));Y.applyUpdate(d,read(file));}
  assert.deepEqual(snapshot(d),JSON.parse(read(`${presentation}.json`)));const v=project(d);assert.ok(!v.owners.some(o=>o.id===B));assert.equal(v.owners.find(o=>o.id===A).spans.length,2);
  const restored=replica(2402);Y.applyUpdate(restored,bytes(d));assert.deepEqual(snapshot(restored),snapshot(d));restored.destroy();d.destroy();
 }
});
test('Yjs later language paragraph opaque and dormant marks retain Rust join witnesses and return exact bytes',()=>{
 const d=restore('paragraph.bin',2403);const ops=JSON.stringify([...d.getMap(profile.roots[5])]);const attrs=d.getMap(profile.roots[4]);
 for(const tuple of [['code','future-lang'],['ext:future',{retained:true}],['paragraph']]){d.transact(()=>attrs.set(A,tuple),'local:js');assert.ok(!project(d).owners.some(o=>o.id===B));assert.equal(JSON.stringify([...d.getMap(profile.roots[5])]),ops);}
 const x=d.getMap(profile.roots[1]).get(B);d.transact(()=>x.insert(x.length,'YJS\n\n',{}),'local:js');assert.ok(x.toDelta().some(r=>r.attributes?.bold));
 fs.writeFileSync(path.join(dir,'yjs-final.bin'),bytes(d));fs.writeFileSync(path.join(dir,'yjs-final.json'),JSON.stringify(snapshot(d)));d.destroy();
});
