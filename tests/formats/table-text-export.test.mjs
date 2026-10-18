import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
function run(program,args,name){const start=performance.now();const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});writeFileSync(resolve(output,`${name}.log`),(r.stdout??'')+(r.stderr??''));writeFileSync(resolve(output,`${name}-command.json`),JSON.stringify({program,args,exit:r.status,signal:r.signal,durationMs:performance.now()-start},null,2)+'\n');assert.ifError(r.error);assert.equal(r.status,0,`see ${name}.log`);return r.stdout;}
test('actual selected-table writer and Session job compile to WASM with export alone',()=>{
 run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','table-text-export','--example','table_text_export','--target','wasm32-unknown-unknown'],'table-export-wasm');
 const artifact=resolve(process.env.CARGO_TARGET_DIR??'crates/editac-formats/target','wasm32-unknown-unknown/debug/examples/table_text_export.wasm');assert.ok(statSync(artifact).size>8);assert.deepEqual([...readFileSync(artifact).subarray(0,4)],[0,97,115,109]);
});
test('export-only graph omits parser, network, archive, renderer and fonts; disabled graph stays empty',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','table-text-export','-e','normal'],'table-export-graph');
 for(const forbidden of ['csv-core','docx-rs','krilla','rustybuzz','reqwest','tokio','image v','zip v','quick-xml','flate2'])assert.ok(!graph.includes(forbidden),forbidden);
 const base=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'table-export-default-graph');assert.equal(base.trim().split('\n').length,1);
});
test('fresh native processes measure complete capture, CSV/TSV output, determinism and reopen',()=>{
 const raw=run('cargo',['test','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','table-text-export,table-text-import','--test','table_text_export','--no-run','--message-format=json'],'table-export-native-binary');
 const artifact=raw.trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.reason==='compiler-artifact'&&row.target.name==='table_text_export'&&row.executable)?.executable;assert.ok(artifact);const measurements=[];
 for(const phase of ['cold','warm']){const name=`table-export-${phase}`;const stdout=run('/usr/bin/time',['-l',artifact,'--exact','selected_v2_exact_csv_tsv_unicode_multiline_quotes_empty_formula_and_no_mutation','--nocapture','--test-threads=1'],name);assert.match(stdout,/test result: ok\. 1 passed; 0 failed; 0 ignored/);const log=readFileSync(resolve(output,`${name}.log`),'utf8');const rss=log.match(/(\d+)\s+maximum resident set size/);assert.ok(rss);const command=JSON.parse(readFileSync(resolve(output,`${name}-command.json`),'utf8'));measurements.push({phase,wallMs:command.durationMs,maximumResidentBytes:Number(rss[1]),executed:1,passed:1,failed:0,skipped:0});}
 writeFileSync(resolve(output,'table-export-resources.json'),JSON.stringify({claim:'fresh native processes, first invocation and OS cache reuse; fixture setup/import, immutable capture, exact CSV/TSV serialization, determinism, live checkpoint and reopen; prepared execution transport, no platform isolation or hard allocation-time memory proof',measurements},null,2)+'\n');
});
test('independent Python csv reader/writer verifies all generated cells, dialect bytes and 24 mutations',()=>{run('python3',['tests/formats/table-text-export-reference.py',output],'table-export-reference');});
