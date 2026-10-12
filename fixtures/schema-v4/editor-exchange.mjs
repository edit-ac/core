// ENG-1.21: real production Rust updates consumed by pinned Yjs, and vice versa.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica, bytes, snapshot, project, place, split, join, profile} from './mapping.mjs';
const dir=process.env.EDITAC_EDITOR_EXCHANGE;
assert.ok(dir,'isolated production exchange directory required');
const A='n:11:1', B='n:11:2', C='n:11:3', K='c:11:3';
const read=n=>fs.readFileSync(path.join(dir,n));
const restore=(name,writer)=>{const d=replica(writer);Y.applyUpdate(d,read(name));return d;};
const maps=d=>profile.roots.map(r=>d.getMap(r));
const set=(d,root,key,value)=>d.transact(()=>maps(d)[root].set(key,value),'local:js');
test('exact protocol runtime and dependency pins',()=>{
 const require=createRequire(import.meta.url);
 assert.equal(process.version,'v24.19.0');
 assert.equal(require('yjs/package.json').version,profile.yjs);
 assert.equal(require('y-protocols/package.json').version,profile.yProtocols);
 assert.equal(profile.yrs,'0.28.0');assert.equal(profile.updateEncoding,1);assert.equal(profile.offsets,'utf16');
});
test('production Rust nested commands, code literal marks, identities and checkpoint match exact Yjs projection',()=>{
 const d=restore('rust-seed.bin',1201);Y.applyUpdate(d,read('rust-final.bin'));Y.applyUpdate(d,read('rust-final.bin'));
 assert.deepEqual(snapshot(d),JSON.parse(read('rust-final.json')));
 const v=project(d);assert.equal(v.owners.find(o=>o.id===B).parent,K);
 assert.deepEqual(v.owners.find(o=>o.id===A).attrs,['code','rust']);
 const x=replica(1202);Y.applyUpdate(x,bytes(d));assert.deepEqual(snapshot(x),snapshot(d));x.destroy();d.destroy();
});
test('real Yjs place, split join, unknown metadata, hidden-parent recovery and text bytes return to production Rust',()=>{
 const d=restore('rust-final.bin',1203);
 place(d,'o:1203:1',B,'@root');split(d,'o:1203:2',C,0,2);join(d,'o:1203:3',C,'o:1203:2');
 const [,texts]=maps(d);d.transact(()=>texts.get(B).insert(1,'YJS😀',{italic:true}),'local:js');
 set(d,4,B,['ext:future-block',{opaque:'retained'}]);set(d,9,K,['enabled',false]);set(d,9,'n:404:1',['enabled',false]);
 fs.writeFileSync(path.join(dir,'yjs-final.bin'),bytes(d));fs.writeFileSync(path.join(dir,'yjs-final.json'),JSON.stringify(snapshot(d)));
 assert.equal(project(d).owners.find(o=>o.id===C).parent,'@root');d.destroy();
});
