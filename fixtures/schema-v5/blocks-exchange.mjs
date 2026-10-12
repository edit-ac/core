// ENG-1.23 actual production block commands exchanged with pinned Yjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica, bytes, snapshot, project, profile} from './mapping.mjs';
const dir=process.env.EDITAC_BLOCK_COMMAND_EXCHANGE;
assert.ok(dir,'isolated block command exchange directory required');
const read=n=>fs.readFileSync(path.join(dir,n));
const restore=(n,w)=>{const d=replica(w);Y.applyUpdate(d,read(n));return d;};
const A='n:11:1',D='n:11:4';
test('exact Node Yjs protocol pins for production block commands',()=>{
 const require=createRequire(import.meta.url);assert.equal(process.version,'v24.19.0');assert.equal(require('yjs/package.json').version,profile.yjs);assert.equal(require('y-protocols/package.json').version,profile.yProtocols);assert.equal(profile.yrs,'0.28.0');
});
test('Rust literal code whitespace and separator identity survive duplicate binary replay and restore',()=>{
 const d=restore('rust-seed.bin',1601);Y.applyUpdate(d,read('rust-final.bin'));Y.applyUpdate(d,read('rust-final.bin'));
 assert.deepEqual(snapshot(d),JSON.parse(read('rust-final.json')));const view=project(d);assert.deepEqual(view.owners.find(o=>o.id===A).attrs,['code','unknown.lang+v_1']);assert.deepEqual(view.owners.find(o=>o.id===D).attrs,['separator']);
 const x=d.getMap(profile.roots[1]).get(A);assert.equal(x.toDelta().map(r=>r.insert).join(''),'a \t\n\n 😀b');const runs=x.toDelta();assert.ok(runs.filter(r=>r.insert.includes('\n')).every(r=>!r.attributes||Object.keys(r.attributes).length===0));assert.ok(runs.filter(r=>r.insert.includes('a')||r.insert.includes('b')).every(r=>r.attributes.bold&&r.attributes['ext:future']));
 const restored=replica(1602);Y.applyUpdate(restored,bytes(d));assert.deepEqual(snapshot(restored),snapshot(d));restored.destroy();d.destroy();
});
test('Yjs literal LF text, dormant marks, paragraph conversion and opaque state return to production Rust',()=>{
 const d=restore('rust-final.bin',1603);const texts=d.getMap(profile.roots[1]);const attrs=d.getMap(profile.roots[4]);
 d.transact(()=>{const x=texts.get(A);x.insert(x.length,'YJS\n\n',{});attrs.set(A,['paragraph']);attrs.set(D,['ext:future-separator',{retained:true}]);},'local:blocks-js');
 fs.writeFileSync(path.join(dir,'yjs-final.bin'),bytes(d));fs.writeFileSync(path.join(dir,'yjs-final.json'),JSON.stringify(snapshot(d)));assert.equal(texts.get(A).toDelta().map(r=>r.insert).join(''),'a \t\n\n 😀bYJS\n\n');d.destroy();
});
