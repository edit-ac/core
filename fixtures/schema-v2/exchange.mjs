import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { seed, profile, roots, admit, tuple, ownerTuple } from './mapping.mjs';
const dir=process.env.EDITAC_BLOCK_EXCHANGE;
const write=(name,doc)=>fs.writeFileSync(path.join(dir,name),Y.encodeStateAsUpdate(doc));
const read=name=>new Uint8Array(fs.readFileSync(path.join(dir,name)));
function restore(name,client){const d=new Y.Doc();d.clientID=client;roots(d);Y.applyUpdate(d,read(name),'restore');Y.applyUpdate(d,read(name),'remote');return d;}
const plain=text=>text.toDelta().map(x=>x.insert).join('');
test('exact protocol runtime and dependency pins',()=>{
 assert.equal(process.version,'v24.19.0');
 const require=createRequire(import.meta.url);
 assert.equal(require('yjs/package.json').version,profile.yjs);
 assert.equal(require('y-protocols/package.json').version,profile.yProtocols);
 assert.equal(profile.yrs,'0.28.0');assert.equal(profile.updateEncoding,1);assert.equal(profile.offsets,'utf16');
});
test('Rust seed reconstructs all six typed roots, exact tuples and original marks',()=>{
 const d=restore('rust-seed.bin',31);const m=roots(d);assert.equal(Object.keys(profile.roots).length,6);for(const map of Object.values(m))assert.ok(map instanceof Y.Map);
 for(const node of seed.nodes){assert.equal(m['registry-parents'].get(node.id),node.kind);const x=m['registry-texts'].get(node.id);assert.ok(x instanceof Y.XmlText);assert.equal(plain(x),node.text);assert.deepEqual(ownerTuple(m,node.id),node.attributes);if(node.marks)assert.deepEqual(x.toDelta(),[{insert:node.text,attributes:node.marks}]);}
 const anchor=Y.decodeRelativePosition(read('rust-anchor.bin'));const position=Y.createAbsolutePositionFromRelativePosition(anchor,d);assert.equal(position.index,3);assert.equal(position.type,m['registry-texts'].get('block-1'));d.destroy();
});
test('Rust split override resolves the same retained text and binary anchor in Yjs',()=>{
 const d=restore('rust-split.bin',32);const m=roots(d);const descriptor=m['probe-split-join'].get('pair');assert.equal(descriptor[0],'split');const relative=Y.decodeRelativePosition(descriptor[1]);assert.equal(relative.assoc,-1);const pos=Y.createAbsolutePositionFromRelativePosition(relative,d);assert.equal(pos.index,3);assert.equal(pos.type,m['registry-texts'].get('block-1'));assert.deepEqual(ownerTuple(m,'block-split'),['heading',6]);assert.equal(m['registry-texts'].has('block-split'),false);d.destroy();
});
test('Yjs emits split, join and stable source anchor from the sole shared initializer for Rust',()=>{
 const d=restore('rust-seed.bin',31);const m=roots(d);const first=m['registry-texts'].get('block-1');write('js-seed.bin',d);const relative=Y.createRelativePositionFromTypeIndex(first,3,-1);fs.writeFileSync(path.join(dir,'js-anchor.bin'),Y.encodeRelativePosition(relative));
 d.transact(()=>{m['probe-split-join'].set('pair',['split',Y.encodeRelativePosition(relative)]);m['registry-block-attributes'].set('block-split',['heading',6]);},'fixture:split');write('js-split.bin',d);
 d.transact(()=>m['probe-split-join'].set('pair',['join']),'fixture:join');write('js-join.bin',d);assert.deepEqual(ownerTuple(m,'block-2'),['paragraph']);d.destroy();
});
test('Yjs whole-tuple concurrent conflicts and independent owner writes reorder/duplicate',()=>{
 const d=restore('js-seed.bin',41);const baseline=Y.encodeStateVector(d);const e=restore('js-seed.bin',42);const a=roots(d)['registry-block-attributes'];const b=roots(e)['registry-block-attributes'];d.transact(()=>{a.set('block-1',['heading',6]);a.set('block-2',['heading',6]);},'local:metadata');e.transact(()=>b.set('block-1',['paragraph']),'local:metadata');const x=Y.encodeStateAsUpdate(d,baseline);const y=Y.encodeStateAsUpdate(e,baseline);fs.writeFileSync(path.join(dir,'js-conflict-a.bin'),x);fs.writeFileSync(path.join(dir,'js-conflict-b.bin'),y);
 for(const updates of [[x,y],[y,x],[x,y,x],[y,x,y]]){const r=restore('js-seed.bin',43);for(const u of updates)Y.applyUpdate(r,u,'remote');const m=roots(r);assert.deepEqual(ownerTuple(m,'block-1'),['paragraph']);assert.deepEqual(ownerTuple(m,'block-2'),['heading',6]);assert.equal(plain(m['registry-texts'].get('block-1')),'a😀b');r.destroy();}d.destroy();e.destroy();
});
test('exact envelope and invalid tuple policy reject before applying live bytes',()=>{
 assert.equal(admit(seed.envelope,seed.envelope),'accepted');
 for(const key of [...Object.keys(seed.envelope)]){const missing={...seed.envelope};delete missing[key];assert.equal(admit(seed.envelope,missing),'invalid-metadata');}
 for(const offered of [null,[],{...seed.envelope,protocolVersion:'1'},{...seed.envelope,documentId:1}])assert.equal(admit(seed.envelope,offered),'invalid-metadata');for(const key of ['profile','schema','epoch','documentId','updateEncoding']){const changed={...seed.envelope,[key]:key==='epoch'||key==='documentId'?'77777777-7777-4777-8777-777777777777':key==='updateEncoding'?2:'unknown'};assert.notEqual(admit(seed.envelope,changed),'accepted');}
 for(const v of [null,{},[],['paragraph',1],['heading'],['heading',0],['heading',7],['heading',1.5],['heading','1']])assert.throws(()=>tuple(v));for(let n=1;n<=6;n++)assert.deepEqual(tuple(['heading',n]),['heading',n]);assert.deepEqual(tuple(['ext:future',{retained:true}]),['ext:future',{retained:true}]);
 const d=restore('js-seed.bin',51);const m=roots(d);m['registry-block-attributes'].set('block-1',new Y.Array());m['registry-block-attributes'].get('block-1').push(['heading',6]);write('js-invalid-shared-tuple.bin',d);d.destroy();const e=restore('js-seed.bin',52);const maps=roots(e);e.transact(()=>{maps['registry-block-attributes'].set('block-1',['heading',7]);maps['registry-texts'].get('block-1').insert(0,'reject atomically');},'fixture:invalid');write('js-invalid-tuple.bin',e);e.destroy();const invalid=new Y.Doc();invalid.clientID=53;invalid.getArray('registry-block-attributes').push(['paragraph']);write('js-invalid-root.bin',invalid);invalid.destroy();
});
