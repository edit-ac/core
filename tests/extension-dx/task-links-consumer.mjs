import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMatchingConsumer } from './matching-consumer.mjs';

export async function prepareTaskLinksConsumer(consumer, context) {
  // Reuse the authenticated production WASM + packed installation/SSR harness.
  const staged = await prepareMatchingConsumer(consumer, context);
  const source = resolve('examples/extensions/task-links/task-links.ts');
  await copyFile(source, join(consumer, 'task-links.ts'));
  await context.run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--declaration', '--outDir', staged, join(consumer, 'task-links.ts')], 'installed-recipe-typecheck.log');
  for (const name of ['index.html', 'session.mjs'])
    await copyFile(resolve('tests/extension-dx/task-links-consumer', name), join(staged, name));
  context.facts.recipe = { path: 'examples/extensions/task-links/task-links.ts',
    sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    compiledAgainstInstalledPublicPackages: true, privateImports: false };
  await writeFile(join(context.output, 'task-links.d.ts'), await readFile(join(staged, 'task-links.d.ts')));
  return staged;
}
