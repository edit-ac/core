import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
test('original media independently matches ZIP XML PNG and rejects altered runtime facts',()=>{
 const r=spawnSync('python3',['tests/formats/consumers/inspect-epub-media.py',output],{encoding:'utf8',timeout:30000});
 writeFileSync(resolve(output,'browser-epub-media-independent.log'),r.stdout+r.stderr);
 assert.ifError(r.error);assert.equal(r.status,0,'see browser-epub-media-independent.log');
 const v=JSON.parse(readFileSync(resolve(output,'epub-media-independent.json')));assert.equal(v.failed,0);assert.equal(v.skipped,0);assert.equal(v.negativeMutations.length,20);
});
test('packed EPUB import profile and atomic media consumer declarations are public and exact',()=>{
 const packed=JSON.parse(readFileSync(resolve(output,'packed-artifacts.json'))),root=resolve(packed.consumer,'node_modules/@edit-ac/formats');
 const manifest=JSON.parse(readFileSync(resolve(root,'capabilities.json'))),d=manifest.directions.find(d=>d.format==='epub'&&d.direction==='import');assert.equal(d.profile,'edit-ac-epub-v1');assert.equal(d.fidelity,'epub33-reflowable-semantic-v1');assert.equal(d.complete,true);assert.ok(!manifest.unavailable.includes('epub-import'));
 const file=resolve(packed.consumer,'epub-media-types.mts');writeFileSync(file,`import {createFormatClient} from '@edit-ac/formats';import type {StableRange,AssetGrant} from '@edit-ac/core';import type {EditorStorageOwner} from '@edit-ac/web';import type {AssetHostTransport} from '@edit-ac/web/assets';declare const owner:EditorStorageOwner,host:AssetHostTransport,grant:AssetGrant,range:StableRange,source:Uint8Array,sha256:number[];const c=createFormatClient();const p=await c.prepareImport(owner.engine,{format:'epub',source,range,importGrants:[{sha256,identity:grant.identity,actions:grant.actions}]});const r=await p.commitAssets(owner,'immutable_job',host,grant);r.localCommit; c.dispose();\n`);
 const r=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','nodenext','--moduleResolution','nodenext','--target','es2022','--lib','es2022,dom',file],{encoding:'utf8',timeout:30000});writeFileSync(resolve(output,'epub-media-types.log'),r.stdout+r.stderr);assert.ifError(r.error);assert.equal(r.status,0,'see epub-media-types.log');
});
