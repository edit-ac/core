import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
function run(program,args,name){const start=performance.now();const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,exit:r.status,signal:r.signal,durationMs:performance.now()-start},null,2)+'\n');assert.ifError(r.error);assert.equal(r.status,0,'see '+name+'.log');return r;}
test('independent ZIP/XML semantic and diagnostic oracle with negative sensitivity',()=>{run('python3',['tests/formats/inspect-docx-export.py',output],'independent-export');});
test('actual optional exporter compiles for WASM',()=>{run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','docx-codecs,jobs','--example','docx_export','--target','wasm32-unknown-unknown'],'export-wasm');const p=resolve(process.env.CARGO_TARGET_DIR,'wasm32-unknown-unknown/debug/examples/docx_export.wasm');assert.ok(statSync(p).size>8);assert.deepEqual([...readFileSync(p).subarray(0,4)],[0,97,115,109]);});
// Declared OS reader fixture: macOS textutil's AppKit DOCX consumer. This is
// native semantic reader evidence, not Word pagination or broad viewer support.
test('macOS declared reader opens Unicode, marks and tables without writer reader',()=>{
 for(const name of ['supported','unicode','lists']){const p=resolve(output,name+'.html');run('/usr/bin/textutil',['-convert','html','-output',p,resolve(output,name+'.docx')],'viewer-'+name);const h=readFileSync(p,'utf8');assert.ok(h.includes('<html'));if(name==='unicode'){assert.match(h,/A &amp; B/);assert.match(h,/العربية/);assert.match(h,/<b>|font-weight: bold/);assert.match(h,/<i>|font-style: italic/);}if(name==='supported'){assert.match(h,/<table/);assert.match(h,/nested/);}}
});
