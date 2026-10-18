import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMatchingConsumer } from './matching-consumer.mjs';

export async function prepareSpellingConsumer(consumer, context) {
  // Reuse the authenticated production WASM + packed installation/SSR harness.
  const staged = await prepareMatchingConsumer(consumer, context);
  const source = resolve('examples/extensions/spellcheck/spellcheck.ts');
  await copyFile(source, join(consumer, 'spellcheck.ts'));
  await copyFile(resolve('tests/extension-dx/spellcheck-consumer/public-smoke.ts'), join(consumer, 'spelling-smoke.ts'));
  await context.run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--declaration', '--outDir', staged, join(consumer, 'spellcheck.ts'), join(consumer, 'spelling-smoke.ts')], 'installed-recipe-typecheck.log');
  for (const name of ['index.html', 'session.mjs'])
    await copyFile(resolve('tests/extension-dx/spellcheck-consumer', name), join(staged, name));
  context.facts.recipe = { path: 'examples/extensions/spellcheck/spellcheck.ts',
    sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    compiledAgainstInstalledPublicPackages: true, privateImports: false };
  await writeFile(join(context.output, 'spellcheck.d.ts'), await readFile(join(staged, 'spellcheck.d.ts')));
  await context.run(process.execPath, ['--input-type=module', '-e', `globalThis.fetch=()=>{throw Error('SSR network')}; for(const key of ['window','document','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw Error(key)}}); const {Spelling}=await import(${JSON.stringify(join(consumer,'node_modules/@edit-ac/web/dist/index.js'))}); for(const mode of ['platform','off'])if(Spelling.configure({mode}).extensions.length)throw Error('Unexpected checker');`], 'spelling-ssr.log');
  context.facts.spellingTypes = { positive: 3, negative: 4, ssr: true };
  return staged;
}
