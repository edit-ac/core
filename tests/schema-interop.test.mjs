import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { before, after } from 'node:test';
import { cases } from '../fixtures/schema-v1/exchange.mjs';
let dir;
before(() => {
  dir = process.env.EDITAC_SCHEMA_INTEROP_OUTPUT ?? mkdtempSync(join(tmpdir(),'editac-schema-node-'));
  const result=spawnSync('cargo',['test','-p','editac-core','--test','schema_interop','--locked','--offline'],{
    cwd:new URL('../',import.meta.url),env:{...process.env,EDITAC_SCHEMA_INTEROP_OUTPUT:dir},encoding:'utf8',timeout:120_000,
  });
  assert.equal(result.status,0,`real Rust/JS frozen-schema exchange failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/);
});
after(() => { if (dir && !process.env.EDITAC_SCHEMA_INTEROP_OUTPUT) rmSync(dir,{recursive:true,force:true}); });
for (const name of cases) test(`frozen schema ${name}: both initializers, real bidirectional updates, anchors and retained identities`,() => {
  for (const init of ['rust','js']) {
    const read = side => JSON.parse(readFileSync(join(dir,`${init}-${name}-${side}.json`)));
    const scenario=name.startsWith('js-') ? name.slice(3) : name;
    const actual=read('rust'); assert.deepEqual(actual,read('js'));
    assert.equal(actual.identities.length,2); assert.equal(actual.anchors.length,4);
    const expectedIndices=scenario === 'edit-edit' ? [3,5,5,1] : scenario === 'move-move' || scenario === 'split-join' ? [3,3,4,1] : [3,4,5,1];
    assert.deepEqual(actual.anchors.map(a=>a.index),expectedIndices);
    assert.deepEqual(actual.anchors.map(a=>a.assoc),[-1,0,0,0]);
    if (scenario === 'join-edit') assert.deepEqual(actual.anchors[3].owner,['block-1',6]);
    if (scenario === 'split-edit') assert.deepEqual(actual.anchors.slice(0,3).map(a=>a.owner),[['block-1',3],['block-split',1],['block-split',2]]);
    if (scenario === 'split-join') assert.deepEqual(actual.anchors[3].owner,['block-1',5]);
    assert.deepEqual(actual.anchors.map(a=>a.hidden),scenario === 'delete-edit' ? [true,true,true,false] : [false,false,false,false]);
  }
});
