import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {replica, snapshot, bytes, project, profile} from '../fixtures/schema-v5/mapping.mjs';
const dir=process.env.EDITAC_HISTORY_EXCHANGE;
assert.ok(dir);
const read=n=>fs.readFileSync(path.join(dir,n));
const load=n=>{const d=replica(process.env.HISTORY_PHASE==='final'?1306:1301);Y.applyUpdate(d,read(`${n}.bin`));return d;};
test('pinned runtime and dependency versions',()=>{
 const require=createRequire(import.meta.url);
 assert.equal(process.version,'v24.19.0');assert.equal(require('yjs/package.json').version,'13.6.33');assert.equal(require('y-protocols/package.json').version,'1.0.7');assert.equal(profile.yrs,'0.28.0');
});
if(process.env.HISTORY_PHASE==='setup') {
 test('actual Rust undo redo checkpoints agree with Yjs semantic projection and restore',()=>{
  for(const name of ['seed','insert','undo','redo']) {const d=load(name);assert.deepEqual(snapshot(d),JSON.parse(read(`${name}.json`)));const restored=replica(1302);Y.applyUpdate(restored,bytes(d));assert.deepEqual(snapshot(restored),snapshot(d));restored.destroy();d.destroy();}
 });
 test('real Yjs remote Unicode update returned to Rust',()=>{
  const d=load('redo');const sv=Y.encodeStateVector(d);const text=d.getMap('registry-texts').get('n:11:1');d.transact(()=>text.insert(text.length,'YJS😀'),'remote:js');fs.writeFileSync(path.join(dir,'yjs-remote.bin'),Y.encodeStateAsUpdate(d,sv));d.destroy();
 });
} else {
 test('Rust selective undo preserves Yjs bytes and exact source identity after duplicate remote replay',()=>{
  const d=load('final');Y.applyUpdate(d,read('yjs-remote.bin'));assert.deepEqual(snapshot(d),JSON.parse(read('final.json')));assert.equal(d.getMap('registry-texts').get('n:11:1').toDelta().map(d=>d.insert).join(''),'a😀bYJS😀');d.destroy();
 });
}
