import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
export async function prepareMatchingConsumer(consumer, { output, facts, run }) {
  const fixture=resolve('tests/extension-dx/matching-consumer');
  facts.authenticatedRuntime=[];
  if (process.env.EDITAC_EDITING_PACKS) {
    // The canonical feature harness supplies authenticated CURRENT packages.
    // Preserve their WASM; an archived contract runtime would hide source drift.
    const catalog=JSON.parse(await readFile(process.env.EDITAC_EDITING_PACKS,'utf8'));
    const current=catalog.core;
    assert.equal(sha(await readFile(current.path)),current.sha256);
    assert.equal(facts.packs.find(pack=>pack.name==='core').sha256,current.sha256);
    for (const member of ['package/dist/wasm/editac_wasm.js','package/dist/wasm/editac_wasm_bg.wasm']) {
      const extracted=spawnSync('tar',['-xOf',current.path,member],{maxBuffer:16*1024*1024});
      assert.equal(extracted.status,0);
      const digest=sha(extracted.stdout);
      assert.equal(sha(await readFile(join(consumer,'core/package',member.replace('package/','')))),digest);
      facts.authenticatedRuntime.push({member,sha256:digest,unchanged:true,assembledBeforeInstallation:true});
    }
    facts.runtimeProvenance={mode:'canonical-current-packed-sdk',packageSha256:current.sha256,postAssemblyMutation:false};
  } else {
    // Retain historical standalone contract reproduction, explicitly labelled.
    const pins=JSON.parse(await readFile('../architecture/evidence/extension-dx/contract-20261017/generated-artifacts.json','utf8'));
    for(const pin of pins.filter(pin=>!pin.member.includes('editac_markdown'))) {
      const extracted=spawnSync('tar',['-xOf',pin.pack,pin.member],{maxBuffer:16*1024*1024});
      assert.equal(extracted.status,0);assert.equal(sha(extracted.stdout),pin.authenticatedSha256);
      await writeFile(join(consumer,'core/package',pin.member.replace('package/','')),extracted.stdout);
      facts.authenticatedRuntime.push({member:pin.member,sha256:pin.authenticatedSha256,unchanged:true,assembledBeforeInstallation:true});
    }
    facts.runtimeProvenance={mode:'historical-contract-runtime',postAssemblyMutation:true};
  }
  facts.testedPackages=[];
  for(const name of ['core','web']) {
    const directory=join(output,'tested-packages',name);await mkdir(directory,{recursive:true});
    const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:join(consumer,name,'package'),encoding:'utf8',maxBuffer:4*1024*1024});
    await writeFile(join(output,`authenticated-pack-${name}.log`),packed.stdout+'\n'+packed.stderr);assert.equal(packed.status,0);
    const manifest=JSON.parse(packed.stdout)[0],path=join(directory,manifest.filename);
    facts.testedPackages.push({name,path,sha256:sha(await readFile(path)),version:manifest.version,postInstallMutation:false});
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  await run('npm',['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',...facts.testedPackages.map(pack=>pack.path)],'installed.log');
  for(const pin of facts.authenticatedRuntime) assert.equal(sha(await readFile(join(consumer,'node_modules/@edit-ac/core',pin.member.replace('package/','')))),pin.sha256);
  await copyFile(join(fixture,'public-smoke.ts'),join(consumer,'public-smoke.ts'));
  await run(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',join(consumer,'public-smoke.ts')],'installed-typecheck.log');
  await run(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('SSR fetch')};for(const name of ['document','window','indexedDB'])Object.defineProperty(globalThis,name,{get(){throw Error(name)}});const m=await import(${JSON.stringify(join(consumer,'node_modules/@edit-ac/web/dist/index.js'))});if(typeof m.Extension.create!=='function')throw Error('No authoring export');`],'installed-ssr.log');
  const staged=join(consumer,'fixture');await mkdir(staged);
  for(const name of ['index.html','session.mjs'])await copyFile(join(fixture,name),join(staged,name));
  await copyFile(resolve('examples/extensions/authoring/recipes.mjs'),join(staged,'recipes.mjs'));
  facts.installedConsumer={typecheck:true,ssr:true,typeRejections:8,privateImports:false};
  return staged;
}
