import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const output=process.env.EDITAC_MATH_BUNDLES;
if(!output)throw Error('EDITAC_MATH_BUNDLES must name a durable evidence directory');
test('production minimal graph omits renderer assets; enabled graph keeps pinned KaTeX lazy',async()=>{
 await mkdir(output,{recursive:true});const results={};
 for(const profile of ['minimal','enabled']){
  const result=await build({stdin:{contents:profile==='minimal'?"export { mountEditorSurface } from './packages/web/dist/index.js';":"export { mountEditorSurface } from './packages/web/dist/index.js'; export { mathRenderer, mathAtom, mathModuleDefinition } from './packages/web/dist/modules/math.js';",resolveDir:process.cwd(),sourcefile:profile+'.mjs'},bundle:true,format:'esm',splitting:true,minify:true,platform:'browser',outdir:`${output}/${profile}`,metafile:true,external:['@edit-ac/core']});
  await writeFile(`${output}/${profile}-manifest.json`,JSON.stringify(result.metafile,null,2));
  const inputs=Object.keys(result.metafile.inputs);const renderer=inputs.filter(x=>/math-renderer|vendor\/katex/.test(x));
  if(profile==='minimal')assert.deepEqual(renderer,[]);else{assert.equal(renderer.length,2);const entry=Object.values(result.metafile.outputs).find(x=>x.entryPoint===profile+'.mjs');assert.ok(entry.imports.some(x=>x.kind==='dynamic-import'));}
  results[profile]=Object.fromEntries(await Promise.all(Object.entries(result.metafile.outputs).map(async([path,info])=>[path,{bytes:info.bytes,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}])));
 }
 const renderer=await readFile('packages/web/dist/modules/vendor/katex.mjs');assert.equal(createHash('sha256').update(renderer).digest('hex'),'e5bc26598084ad869939ecaa262673814f26ed586312a409b5f8427c01e4f681');
 await writeFile(`${output}/profiles.json`,JSON.stringify(results,null,2));
});
