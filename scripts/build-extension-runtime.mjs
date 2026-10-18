import { build } from 'esbuild';
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = resolve(root, 'packages/web/dist/extensions/runtime');
await mkdir(outdir, { recursive: true });
// Only stale reproducible chunks produced by this builder; declarations remain tsc-owned.
for (const file of await readdir(outdir)) if (/^shared-[A-Z0-9]+\.js$/.test(file)) await rm(resolve(outdir, file));
const features = ['search', 'reorder', 'slash', 'references', 'content'];
// Bundle the optional view closure independently. A direct re-export plus import()
// of the same module lets esbuild hoist it through the legacy compatibility barrel.
// Core/Session/registry/dispatch remain the original owners, never bundled copies.
const result = await build({ absWorkingDir: root,
  entryPoints: Object.fromEntries(features.map(name => [name, `packages/web/src/extensions/runtime/${name}.ts`])),
  outdir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  chunkNames: 'shared-[hash]', metafile: true, external: ['@edit-ac/core', '@edit-ac/core/*'],
  plugins: [{ name: 'shared-presenter-ids', setup(builder) {
    builder.onResolve({ filter: /presenter-sequence\.js$/ }, () => ({ path: '../../modules/presenter-sequence.js', external: true }));
  } }],
});
const inputs = Object.keys(result.metafile.inputs);
const duplicatedOwners = inputs.filter(path => /packages\/core\/|packages\/web\/src\/(?:storage\/|sync\/|editor\.ts|surface\.ts|modules\/runtime\.ts)/.test(path));
if (duplicatedOwners.length) throw Error('Optional bundles contain a duplicated owner: ' + duplicatedOwners.join(', '));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const outputs = await Promise.all(Object.entries(result.metafile.outputs).map(async ([path, output]) => {
  const bytes = await readFile(resolve(root, path));
  return { path: relative(outdir, resolve(root, path)), bytes: bytes.length, sha256: sha(bytes),
    inputs: output.inputs, imports: output.imports };
}));
await writeFile(resolve(outdir, 'manifest.json'), JSON.stringify({ features, inputs, outputs,
  externalOwners: ['@edit-ac/core', '@edit-ac/core/extensions', '../../modules/presenter-sequence.js'],
  duplicatedOwners }, null, 2) + '\n');
