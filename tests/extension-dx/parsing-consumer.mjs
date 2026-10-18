import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMatchingConsumer } from './matching-consumer.mjs';
export async function prepareParsingConsumer(consumer, context) {
  const staged = await prepareMatchingConsumer(consumer, context);
  context.facts.recipes = [];
  for (const name of ['parsing', 'url-insert']) {
    const source = `examples/extensions/${name}/${name}.ts`;
    await copyFile(resolve(source), join(consumer, `${name}.ts`));
    await context.run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--declaration', '--outDir', staged, join(consumer, `${name}.ts`)], `installed-${name}-typecheck.log`);
    context.facts.recipes.push({ path: source, sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
      compiledAgainstInstalledPublicPackages: true, privateImports: false });
    await writeFile(join(context.output, `${name}.d.ts`), await readFile(join(staged, `${name}.d.ts`)));
  }
  for (const name of ['index.html', 'session.mjs'])
    await copyFile(resolve('tests/extension-dx/parsing-consumer', name), join(staged, name));
  return staged;
}
