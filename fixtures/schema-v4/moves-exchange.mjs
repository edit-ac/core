// ENG-1.10: actual production command bytes and independent pinned Yjs peer.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica, bytes, snapshot, project, place, profile} from './mapping.mjs';
const dir=process.env.EDITAC_MOVE_EXCHANGE;
assert.ok(dir,'isolated move exchange required');
const read=n=>fs.readFileSync(path.join(dir,n));
const A='n:11:1',B='n:11:2',C='n:11:3',D='n:11:4',L='c:11:1',Q='c:11:2',K='c:11:3',W='c:11:4';
const restore=(name,writer)=>{const d=replica(writer);Y.applyUpdate(d,read(name));return d;};
const ids=d=>project(d).owners.filter(o=>!o.deleted).map(o=>o.id);
test('exact runtime dependency and v4 descriptor pins',()=>{
 const require=createRequire(import.meta.url);assert.equal(process.version,'v24.19.0');
 assert.equal(require('yjs/package.json').version,profile.yjs);assert.equal(require('y-protocols/package.json').version,profile.yProtocols);
 assert.equal(profile.yrs,'0.28.0');assert.equal(profile.updateEncoding,1);assert.equal(profile.offsets,'utf16');
});
test('Rust leaf and container moves preserve nested order original identities rich marks and checkpoint',()=>{
 const d=restore('rust-seed.bin',1401),texts=d.getMap(profile.roots[1]);
 const originals=new Map([...texts]);const source=snapshot(d).sources;
 Y.applyUpdate(d,read('rust-final.bin'));Y.applyUpdate(d,read('rust-final.bin'));
 assert.deepEqual(snapshot(d),JSON.parse(read('rust-final.json')));assert.deepEqual(ids(d),[L,B,W,Q,K,A,C,D]);
 assert.deepEqual(snapshot(d).sources,source);for(const [id,text] of originals)assert.equal(texts.get(id),text);
 assert.ok(texts.get(A).toDelta().every(r=>r.attributes.bold===true&&r.attributes['ext:future'].retained===true));
 const x=replica(1402);Y.applyUpdate(x,bytes(d));assert.deepEqual(snapshot(x),snapshot(d));x.destroy();d.destroy();
});
for(const name of ['same-target','disjoint','cycle','parent-version','before-version','disabled-destination','deleted-destination'])test(`production ${name} bytes converge under six duplicate reordered schedules`,()=>{
 const expected=JSON.parse(read(`${name}-final.json`));
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  const d=restore('rust-seed.bin',1404);for(const i of order){Y.applyUpdate(d,read(`${name}-${i}.bin`));Y.applyUpdate(d,read(`${name}-${i}.bin`));}
  assert.deepEqual(snapshot(d),expected);const v=project(d),parent=id=>v.owners.find(o=>o.id===id).parent;
  const text=id=>d.getMap(profile.roots[1]).get(id).toDelta().map(r=>r.insert).join('');
  if(name==='same-target'){assert.equal(parent(A),K);assert.equal(text(A),'aREMOTE😀😀b');}
  if(name==='disjoint'){assert.equal(parent(A),K);assert.equal(parent(Q),W);assert.equal(text(C),'eREMOTÉZ');}
  if(name==='cycle'){assert.equal(parent(L),W);assert.equal(parent(W),'@root');assert.equal(text(A),'aR😀b');assert.equal(Object.values(v.outcomes).filter(s=>s==='losing').length,1);}
  if(name==='parent-version'){assert.equal(parent(K),W);assert.equal(parent(A),L);assert.equal(text(C),'eŔZ');}
  if(name==='before-version'){assert.equal(parent(A),L);assert.equal(parent(C),K);assert.equal(text(A),'aR😀b');}
  if(name==='disabled-destination'||name==='deleted-destination'){assert.equal(parent(A),L);assert.equal(parent(C),'@root');assert.equal(text(C),name==='deleted-destination'?'eŔZ':'éZ');}
  const x=replica(1405);Y.applyUpdate(x,bytes(d));assert.deepEqual(snapshot(x),expected);x.destroy();d.destroy();
 }
});
test('three independent Yjs move move edit writers generate ranked replay and checkpoint for Rust',()=>{
 const a=restore('rust-final.bin',1501),b=restore('rust-final.bin',1502),c=restore('rust-final.bin',1503);
 place(a,'o:1501:1',Q,'@root',L);place(b,'o:1502:1',Q,L);
 c.transact(()=>c.getMap(profile.roots[1]).get(C).insert(1,'PEER😀',{italic:true}),'move:peer-race');
 const updates=[bytes(a),bytes(b),bytes(c)];for(const [i,u] of updates.entries())fs.writeFileSync(path.join(dir,`yjs-race-${i}.bin`),u);
 let expected;
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  const d=restore('rust-final.bin',1504);for(const i of order){Y.applyUpdate(d,updates[i]);Y.applyUpdate(d,updates[i]);}
  const actual=snapshot(d);if(expected)assert.deepEqual(actual,expected);else expected=actual;
  assert.equal(project(d).owners.find(o=>o.id===Q).parent,'@root');
  assert.equal(d.getMap(profile.roots[1]).get(C).toDelta().map(r=>r.insert).join(''),'ePEER😀́Z');
  const checkpoint=replica(1505);Y.applyUpdate(checkpoint,bytes(d));assert.deepEqual(snapshot(checkpoint),expected);checkpoint.destroy();d.destroy();
 }
 fs.writeFileSync(path.join(dir,'yjs-race-final.json'),JSON.stringify(expected));a.destroy();b.destroy();c.destroy();
});
test('Yjs container and leaf moves plus marked edit return to production Rust without source replacement',()=>{
 const d=restore('rust-final.bin',1403),texts=d.getMap(profile.roots[1]);const originals=new Map([...texts]);const before=snapshot(d).sources;
 place(d,'o:1403:1',Q,'@root',L);place(d,'o:1403:2',A,L,B);
 assert.deepEqual(snapshot(d).sources,before);for(const [id,text] of originals)assert.equal(texts.get(id),text);
 d.transact(()=>texts.get(B).insert(1,'YJS😀',{italic:true}),'move:peer');
 assert.deepEqual(ids(d),[Q,K,C,D,L,A,B,W]);
 fs.writeFileSync(path.join(dir,'yjs-final.bin'),bytes(d));fs.writeFileSync(path.join(dir,'yjs-final.json'),JSON.stringify(snapshot(d)));d.destroy();
});
