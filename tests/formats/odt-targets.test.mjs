import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
function run(program,args,name){const start=performance.now();const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});writeFileSync(resolve(output,`${name}.log`),(r.stdout??'')+(r.stderr??''));writeFileSync(resolve(output,`${name}-command.json`),JSON.stringify({program,args,exit:r.status,signal:r.signal,durationMs:performance.now()-start},null,2)+'\n');assert.ifError(r.error);assert.equal(r.status,0,`see ${name}.log`);return r.stdout;}
test('actual ODT mapper compiles to WASM without DOCX or PDF runtime dependencies',()=>{run('cargo',['build','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','odt-import','--example','odt_import','--target','wasm32-unknown-unknown'],'odt-wasm');const artifact=resolve(process.env.CARGO_TARGET_DIR??'crates/editac-formats/target','wasm32-unknown-unknown/debug/examples/odt_import.wasm');assert.ok(statSync(artifact).size>8);assert.deepEqual([...readFileSync(artifact).subarray(0,4)],[0,97,115,109]);});
test('ODT optional graph excludes DOCX PDF and ambient networking; default has no normal dependencies',()=>{const graph=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','odt-import','-e','normal'],'odt-graph');for(const forbidden of ['docx-rs','krilla','rustybuzz','reqwest','tokio','image v'])assert.ok(!graph.includes(forbidden),forbidden);const base=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'default-graph');assert.equal(base.trim().split('\n').length,1);});
test('cold and warm fresh native processes measure the complete guarded import Session history and reopen path',()=>{
  const raw=run('cargo',['test','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','--features','odt-import','--test','odt_import','--no-run','--message-format=json'],'odt-native-binary');
  const artifact=raw.trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.reason==='compiler-artifact'&&row.target.name==='odt_import'&&row.executable)?.executable;
  assert.ok(artifact);const measurements=[];
  for(const phase of ['cold','warm']){
    const name=`odt-${phase}`;const stdout=run('/usr/bin/time',['-l',artifact,'--exact','one_prepared_session_commit_undo_redo_reopen_and_original_recovery','--nocapture','--test-threads=1'],name);
    assert.match(stdout,/test result: ok\. 1 passed; 0 failed; 0 ignored/);
    const log=readFileSync(resolve(output,`${name}.log`),'utf8');const rss=log.match(/(\d+)\s+maximum resident set size/);assert.ok(rss);
    const command=JSON.parse(readFileSync(resolve(output,`${name}-command.json`),'utf8'));measurements.push({phase,wallMs:command.durationMs,maximumResidentBytes:Number(rss[1]),executed:1,passed:1,failed:0,skipped:0});
  }
  writeFileSync(resolve(output,'odt-resources.json'),JSON.stringify({claim:'fresh native processes; cold/warm means first invocation/OS cache reuse only; includes package construction, guarded inflate/XML/map/original media staging, Session commit/undo/redo/reopen; prepared execution and asset transports, not a platform sandbox or allocation-time memory proof',measurements},null,2)+'\n');
});
test('independent ZIP/XML inspection verifies actual admitted package fixture and semantic projection',()=>{const summary=run('python3',['tests/formats/inspect-odt-import.py',output],'odt-independent');const r=JSON.parse(summary);assert.equal(r.state,'passed');assert.equal(r.images,1);assert.equal(r.rows,2);assert.equal(r.negativeMutations,3);});
