import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareMatchingConsumer } from './matching-consumer.mjs';
import { validateManifest, sha } from '../../scripts/extension-documentation-manifest.mjs';
export async function prepareDocumentationConsumer(consumer, context) {
  const staged = await prepareMatchingConsumer(consumer, context);
  const manifest = JSON.parse(await readFile('docs/extensions/recipe-manifest.json','utf8'));
  const recipes = validateManifest(manifest, undefined, name => JSON.parse(requireRead(join(consumer,'node_modules',name,'package.json'))).version);
  context.facts.documentedRecipes = recipes.map(({text,...recipe}) => recipe);
  context.facts.documentationManifest = sha(await readFile('docs/extensions/recipe-manifest.json'));
  for (const recipe of recipes) await writeFile(join(consumer,recipe.output),recipe.text);
  await context.run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', '--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--declaration','--outDir',staged,...recipes.map(r=>join(consumer,r.output))], 'installed-documented-ranges.log');
  // Deliberately wrong current options must fail against installed declarations.
  const invalid = [
    `import { Emphasis } from './behavior.js'; Emphasis.configure({enabled:'yes'});`,
    `import { Spelling } from '@edit-ac/web'; Spelling.configure({mode:'automatic'});`,
    `import { createTaskLinks } from './task-links.js'; import { preparedTaskCatalog } from './catalog.js'; createTaskLinks(preparedTaskCatalog).configure({paste:'yes'});`,
    `import { createEditor } from '@edit-ac/web'; createEditor(document.body, {extensions:[], platform:{spellcheck:'forced'}});`,
  ];
  context.facts.invalidOptions=[];
  for (const [index,source] of invalid.entries()) {
    const file=join(consumer,`invalid-${index}.ts`);await writeFile(file,source);
    const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',file],{encoding:'utf8'});
    await writeFile(join(context.output,`invalid-options-${index}.log`),result.stdout+result.stderr);
    assert.ok([1,2].includes(result.status));assert.equal(result.signal,null);assert.match(result.stdout,/error TS(2322|2345)/);context.facts.invalidOptions.push({index,rejected:true});
  }
  for(const name of ['index.html','session.mjs']) await copyFile(resolve('tests/extension-dx/documentation-consumer',name),join(staged,name));
  return staged;
}
import { readFileSync as requireRead } from 'node:fs';
