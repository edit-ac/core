import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestNode } from '../scripts/test-toolchain.mjs';
import { startAstroConsumer } from './astro-harness.mjs';
const output=process.env.EDITAC_ASTRO_OUTPUT ?? '../evidence/sdk-astro/iteration1';
async function run(args, name, env={}) {
  const result=spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',timeout:120000});
  await mkdir(output,{recursive:true}); await writeFile(join(output,name+'.log'),`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error,undefined, name);assert.equal(result.status,0,`${name}; see ${output}/${name}.log`);
}
test('Astro peer pin and optional dependency graph have no React runtime',async()=>{
  await requireTestNode();
  const pkg=JSON.parse(await readFile('packages/astro/package.json','utf8'));
  assert.equal(pkg.peerDependencies.astro,'7.3.x'); assert.deepEqual(pkg.dependencies,{'@edit-ac/web':'0.0.0'});
  for(const name of ['core','web','astro']) {
    const p=JSON.parse(await readFile(`packages/${name}/package.json`,'utf8'));
    assert.ok(!Object.keys({...p.dependencies,...p.peerDependencies}).some(n=>/react|astro/.test(n) && (name!=='astro'||n!=='astro')));
  }
  const astro=JSON.parse(await readFile('node_modules/astro/package.json','utf8')); assert.equal(astro.version,'7.3.8');
});
test('server import needs neither browser globals nor WASM initialization',async()=>{
  const imports=await import('../packages/astro/dist/index.js'); assert.equal(typeof imports.mountEditorHost,'function');
  assert.equal(globalThis.window,undefined); assert.equal(globalThis.document,undefined);
});
test('compiled Astro host typechecks and builds real static and standalone SSR consumers',async()=>{
  await mkdir('examples/astro/public',{recursive:true});
  await copyFile('packages/core/dist/wasm/editac_wasm_bg.wasm','examples/astro/public/engine.wasm');
  await run(['node_modules/astro/bin/astro.mjs','sync','--root','examples/astro'],'astro-sync');
  await run(['scripts/check-astro-types.mjs'],'astro-types');
  for(const mode of ['static','ssr']) {
    await run(['node_modules/astro/bin/astro.mjs','build','--root','examples/astro'],`astro-${mode}`,{EDITAC_ASTRO_MODE:mode,PUBLIC_EDITAC_ASTRO_FIXTURE:'1'});
    const consumer=await startAstroConsumer(mode);
    try {
      const response=await fetch(consumer.url); assert.equal(response.status,200);
      const html=await response.text(); assert.equal((html.match(/<edit-ac-editor/g)||[]).length,2);
      assert.ok(html.includes('data-editor-surface')); assert.ok(!html.includes('contenteditable="true"'));
      const asset=await fetch(consumer.url+'/engine.wasm');assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),'application/wasm');
    }finally{await consumer.close();}
  }
  const assets=await readdir('examples/astro/dist-static/_astro');assert.ok(assets.some(x=>x.endsWith('.js')));
});
