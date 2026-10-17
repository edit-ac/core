import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
function run(program,args,name){
 const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,exit:r.status,signal:r.signal},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,'see '+name+'.log');return r;
}
test('WCF-13/14 independent logical text and visible glyph/layout oracles reject five corruptions',()=>{
 run(process.env.EDITAC_PDF_PYTHON,['tests/formats/inspect-pdf-export.py',output,'fixtures/formats/pdf/export/text.json'],'independent');
 const r=JSON.parse(readFileSync(resolve(output,'independent-inspection.json')));
 assert.equal(r.logical.paragraphs,49);assert.ok(r.logical.pages>=4);
 assert.equal(r.rejectedMutations.length,5);assert.ok(r.visual.visibleSpans>=49);
});
test('optional captured-job writer and layout compile for WASM; no runtime isolation claim',()=>{
 run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','pdf-export','--target','wasm32-unknown-unknown'],'pdf-export-wasm');
 const path=resolve(process.env.CARGO_TARGET_DIR,'wasm32-unknown-unknown/debug/editac_formats.wasm');
 // rlib is the declared portable library target; no standalone executable or ABI is advertised.
 const rlib=path.replace('editac_formats.wasm','libeditac_formats.rlib');
 assert.ok(readFileSync(rlib).length>100);copyFileSync(rlib,resolve(output,'libeditac_formats-wasm.rlib'));
});
test('minimum registry still excludes optional converter and font dependencies',()=>{
 const r=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'pdf-export-disabled');
 assert.equal(r.stdout.trim(),'editac-formats v0.0.0 ('+resolve('crates/editac-formats')+')');
});
