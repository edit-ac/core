import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import {replica,bytes,snapshot,split,join,roots,profile} from './mapping.mjs';
const dir=process.env.EDITAC_GENERAL_EXCHANGE;
const read=()=>new Uint8Array(fs.readFileSync(path.join(dir,'rust-production.bin')));
const expected=JSON.parse(fs.readFileSync(path.join(dir,'rust-production.json'),'utf8'));
function restore(client){const d=replica(client);Y.applyUpdate(d,read(),'restore');return d;}
test('pinned Yjs reconstructs production repeated multisource commands and exact recovery',()=>{
 const require=createRequire(import.meta.url);assert.equal(process.version,'v24.19.0');assert.equal(require('yjs/package.json').version,profile.yjs);
 const d=restore(291);assert.deepEqual(snapshot(d),expected);assert.equal(d.share.size,7);d.destroy();
});
test('Yjs duplicate reordered production checkpoint preserves original identities and retained intentions',()=>{
 const d=restore(292);Y.applyUpdate(d,read(),'remote');Y.applyUpdate(d,read(),'remote');assert.deepEqual(snapshot(d),expected);d.destroy();
});
test('Yjs returns actual further joins splits source edits heading override and checkpoint to production Rust',()=>{
 const d=restore(293);const owners=snapshot(d).visible;join(d,'o:293:1',owners[0].id,owners[1].id);split(d,'o:293:2',owners[0].id,3,2);
 roots(d)[profile.roots[1]].get('n:11:2').insert(2,'!');roots(d)[profile.roots[4]].set('o:293:2',['heading',4]);
 const s=snapshot(d);assert.deepEqual(s.sources['n:11:1'].identity,expected.sources['n:11:1'].identity);
 fs.writeFileSync(path.join(dir,'js-production.bin'),bytes(d));fs.writeFileSync(path.join(dir,'js-production.json'),JSON.stringify(s));d.destroy();
});
test('Yjs next visible adjacency crosses a tombstoned owner and preserves recovery content',()=>{
 const d=restore(294);const r=roots(d),owners=snapshot(d).visible;r[profile.roots[3]].set(owners[1].id,true);
 join(d,'o:294:1',owners[0].id,owners[2].id);const s=snapshot(d);assert.equal(s.outcomes['o:294:1'],'applied');assert.equal(s.deleted[0].id,owners[1].id);
 fs.writeFileSync(path.join(dir,'js-deleted-gap.bin'),bytes(d));fs.writeFileSync(path.join(dir,'js-deleted-gap.json'),JSON.stringify(s));d.destroy();
});
