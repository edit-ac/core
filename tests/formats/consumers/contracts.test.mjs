import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const packed=JSON.parse(readFileSync(resolve(output,'packed-artifacts.json')));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(p,args,name,cwd=process.cwd()){const r=spawnSync(p,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program:p,args,cwd,exit:r.status,signal:r.signal},null,2)+'\n');assert.ifError(r.error);assert.equal(r.status,0,`see ${name}.log`);return r.stdout;}
test('packed archives, installed members and source/runtime pins are immutable and exact',()=>{
 const members={};for(const a of packed.archives){assert.equal(hash(a.path),a.sha256);for(const f of a.files){const p=resolve(packed.consumer,'node_modules/@edit-ac',a.name,f.path);assert.equal(statSync(p).size,f.size);members[`@edit-ac/${a.name}/${f.path}`]={bytes:f.size,sha256:hash(p)};}}
 const build=JSON.parse(readFileSync(resolve(packed.consumer,'node_modules/@edit-ac/formats/dist/build-receipt.json')));
 assert.ok(Object.keys(build.sourcePins).length>100);for(const [p,h]of Object.entries(build.sourcePins))assert.equal(hash(p),h,p);
 for(const [p,record]of Object.entries(build.assets)){const file=resolve(packed.consumer,'node_modules/@edit-ac/formats/dist/runtime',p);assert.equal(hash(file),record.sha256);assert.equal(statSync(file).size,record.bytes);}
 writeFileSync(resolve(output,'installed-member-hashes.json'),JSON.stringify({members,build},null,2)+'\n');
});
test('default Rust graph and packed base editor omit optional converters and fonts',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats/Cargo.toml','--locked','--offline','-e','normal'],'disabled-rust-graph');assert.equal(graph.trim().split('\n').length,1);
 assert.equal(existsSync(resolve(packed.disabled,'node_modules/@edit-ac/formats')),false);assert.equal(existsSync(resolve(packed.disabled,'node_modules/@edit-ac/core/dist/index.js')),true);
 const base=packed.archives.find(a=>a.name==='core');assert.ok(base.files.length>0);assert.ok(!base.files.some(f=>/formats|\.ttf$|\.otf$|krilla|docx|epub|csv-core/i.test(f.path)));
 const enabled=run('cargo',['tree','--manifest-path','crates/editac-formats-wasm/Cargo.toml','--locked','--offline','-e','normal'],'enabled-text-graph');assert.match(enabled,/csv-core v0.1.13/);assert.match(enabled,/docx-rs v0.4.22/);assert.match(enabled,/zip v8.6.0/);assert.ok(!/krilla|reqwest|tokio|image v/.test(enabled));
 const notices=readFileSync(resolve(packed.consumer,'node_modules/@edit-ac/formats/THIRD-PARTY-NOTICES.txt'),'utf8');assert.match(notices,/csv-core 0.1.13/);assert.match(notices,/docx-rs 0.4.22/);assert.match(notices,/MIT|Permission is hereby granted/);assert.match(notices,/Apache/);
 writeFileSync(resolve(output,'size-receipt.json'),JSON.stringify({baseArchive:base.bytes,baseUnpacked:base.unpackedSize,formatsArchive:packed.archives.find(a=>a.name==='formats').bytes,formatsUnpacked:packed.archives.find(a=>a.name==='formats').unpackedSize,disabledScope:'packed core package + no-feature Rust format graph; format package is not a base dependency'},null,2)+'\n');
});
test('installed public declarations typecheck against the packed SDK',()=>{
 const path=resolve(packed.consumer,'consumer.ts');writeFileSync(path,`import {createFormatClient, type Options} from '@edit-ac/formats';\nimport type {EngineHandle, StableRange} from '@edit-ac/core';\ndeclare const e:EngineHandle;declare const range:StableRange;const o:Options={format:'csv',newline:'lf',header:true};\nconst client=createFormatClient();const p=await client.prepareImport(e,{...o,range,source:new Uint8Array()});p.commit();const exported=await client.export(e,{format:'rtf'});exported.bytes.byteLength;const docx=await client.export(e,{format:'docx',originalAssets:[{identity:{host:'local',key:'image'},actions:['read'],bytes:new Uint8Array(70)}]});docx.bytes.byteLength;client.dispose();\n`);
 run(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','nodenext','--moduleResolution','nodenext','--target','es2022','--lib','es2022,dom',path],'consumer-types');
});
test('independent readers inspect actual browser-produced RTF and exact/safe CSV/TSV artifacts',()=>{
 // Cocoa/textutil is a validation oracle for our generated artifact only.
 const rtf=run('/usr/bin/textutil',['-convert','txt','-stdout',resolve(output,'browser-supported.rtf')],'browser-rtf-independent');assert.match(rtf,/Hello bold.*🙂/);
 run('python3',['tests/formats/consumers/inspect.py',output],'browser-table-independent');
});

test('independent DOCX package/semantic oracle rejects text/mark/table/link/media perturbations',()=>{const text=run('/usr/bin/textutil',['-convert','txt','-stdout',resolve(output,'browser-supported.docx')],'browser-docx-reader');assert.match(text,/DOCX 🙂 heading/);assert.match(text,/First item/);assert.match(text,/Cell A/);assert.match(text,/Cell 🙂/);run('python3',['tests/formats/consumers/inspect-docx.py',output],'browser-docx-independent');});
