// ENG-1.8: production command bytes, deterministic pinned peer, no provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica, bytes, snapshot, project, place, split, join, profile} from './mapping.mjs';
const dir=process.env.EDITAC_LIST_EXCHANGE;
assert.ok(dir,'isolated list exchange required');
const read=n=>fs.readFileSync(path.join(dir,n));
const A='n:11:1',B='n:11:2',C='n:11:3',E='n:11:4';
const ids=JSON.parse(read('ids.json'));
const restore=writer=>{const d=replica(writer);Y.applyUpdate(d,read('rust-seed.bin'));Y.applyUpdate(d,read('rust-final.bin'));return d;};
test('exact protocol runtime and dependency pins',()=>{
 const require=createRequire(import.meta.url);assert.equal(process.version,'v24.19.0');
 assert.equal(require('yjs/package.json').version,profile.yjs);assert.equal(require('y-protocols/package.json').version,profile.yProtocols);
 assert.equal(profile.yrs,'0.28.0');assert.equal(profile.updateEncoding,1);assert.equal(profile.offsets,'utf16');
});
test('production list quote enter indent empty exit bytes preserve tree checks marks and source identity',()=>{
 const d=restore(1301);Y.applyUpdate(d,read('rust-final.bin'));
 assert.deepEqual(snapshot(d),JSON.parse(read('rust-final.json')));const v=project(d);const owner=id=>v.owners.find(o=>o.id===id);
 assert.equal(owner(A).parent,ids.list);assert.equal(owner(C).parent,ids.quote);assert.equal(owner(E).parent,'@root');
 assert.notEqual(owner(B).parent,ids.list);assert.equal(owner(owner(B).parent).parent,ids.list);
 assert.deepEqual(d.getMap(profile.roots[8]).get(A),['check',true]);
 assert.equal(d.getMap(profile.roots[1]).get(A).toDelta().map(r=>r.insert).join(''),'a😀ב');
 assert.ok(d.getMap(profile.roots[1]).get(A).toDelta().every(run=>run.attributes.bold===true&&run.attributes['ext:future']==='kept'));
 const right=v.owners.find(o=>o.id.startsWith('o:')&&o.parent===ids.list&&o.spans.length&&o.spans[0].source===A);
 assert.ok(right);assert.equal(d.getMap(profile.roots[8]).has(right.id),false);
 const checkpoint=replica(1302);Y.applyUpdate(checkpoint,bytes(d));assert.deepEqual(snapshot(checkpoint),snapshot(d));checkpoint.destroy();d.destroy();
});
test('Yjs list tuple check placement split join and remote marked text return to production Rust',()=>{
 const d=restore(1303);d.transact(()=>{
   d.getMap(profile.roots[7]).set(ids.list,['ordered',17]);
   d.getMap(profile.roots[8]).set(B,['check',true]);
   d.getMap(profile.roots[1]).get(B).insert(1,'YJS😀',{italic:true});
 },'lists:peer');
 place(d,'o:1303:1',B,ids.quote,C);split(d,'o:1303:2',C,0,2);join(d,'o:1303:3',C,'o:1303:2');
 assert.equal(project(d).owners.find(o=>o.id===B).parent,ids.quote);
 fs.writeFileSync(path.join(dir,'yjs-final.bin'),bytes(d));fs.writeFileSync(path.join(dir,'yjs-final.json'),JSON.stringify(snapshot(d)));d.destroy();
});
