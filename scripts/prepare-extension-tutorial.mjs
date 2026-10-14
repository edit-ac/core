import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loggedRun, sha256 } from './extension-bundles.mjs';

/** A new private consumer directory, populated only from local package archives. */
export async function prepareTutorial(destination) {
  const requested = resolve(destination);
  await mkdir(requested, { recursive: true });
  const directory = await realpath(requested);
  if ((await readdir(directory)).length) throw Error('Tutorial destination must be empty');
  const output = join(directory, 'qualification'); await mkdir(output);
  const facts = { schema: 1, gate: 'EXT-1.10', node: process.version, packs: [], inputs: {}, commands: [], wasmExports: [] };
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  for (const name of ['core', 'web', 'markdown']) {
    const command = await loggedRun(output, 'pack-' + name, 'npm', ['pack', '--workspace=@edit-ac/' + name, '--json', '--pack-destination', output]);
    facts.commands.push({ ...command, stdout: undefined });
    const [pack] = JSON.parse(command.stdout), archive = join(output, pack.filename);
    facts.packs.push({ name, filename: pack.filename, integrity: pack.integrity, sha256: sha256(await readFile(archive)) });
    const target = join(directory, 'node_modules/@edit-ac', name); await mkdir(target, { recursive: true });
    await loggedRun(output, 'extract-' + name, 'tar', ['-xzf', archive, '-C', target, '--strip-components=1']);
    if (await realpath(target) !== target) throw Error('Packed consumer aliases workspace');
  }
  for (const name of ['tutorial.mjs', 'definitions.json', 'conformance.mjs', 'app.mjs', 'index.html', 'serve.mjs'])
    await copyFile(resolve('examples/extensions', name), join(directory, name));
  await mkdir(join(directory, 'fixtures'));
  for (const name of ['custom-checkpoint.bin', 'identity.json', 'conformance.json'])
    await copyFile(resolve('fixtures/extensions/consumers/tutorial', name), join(directory, 'fixtures', name));
  for (const [name, source] of [['engine.wasm', 'core/dist/wasm/editac_wasm_bg.wasm'], ['markdown.wasm', 'markdown/dist/wasm/editac_markdown_wasm_bg.wasm']]) {
    await copyFile(join(directory, 'node_modules/@edit-ac', source), join(directory, name));
    facts.inputs[name] = sha256(await readFile(join(directory, name)));
  }
  facts.wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(await readFile(join(directory, 'engine.wasm')))).map(e => e.name);
  if (facts.wasmExports.some(e => /fixture/.test(e))) throw Error('Production WASM required');
  // Both entry points compile exclusively against extracted public packages.
  for (const [entry, name] of [['app.mjs', 'app.js'], ['tutorial.mjs', 'tutorial.js']]) {
    const result = await build({ absWorkingDir: directory, entryPoints: [entry], outfile: join(directory, name), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', metafile: true });
    for (const path of Object.keys(result.metafile.inputs)) {
      if (!['app.mjs', 'tutorial.mjs'].includes(path) && !path.startsWith('node_modules/@edit-ac/')) throw Error('Unpacked/private input: ' + path);
      facts.inputs[path] = sha256(await readFile(join(directory, path)));
    }
    await writeFile(join(output, name + '-metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
  }
  for (const name of ['tutorial.mjs', 'definitions.json', 'conformance.mjs', 'app.mjs', 'index.html', 'serve.mjs', 'app.js', 'tutorial.js', 'fixtures/custom-checkpoint.bin', 'fixtures/identity.json', 'fixtures/conformance.json'])
    facts.inputs[name] = sha256(await readFile(join(directory, name)));
  await writeFile(join(output, 'consumer.json'), JSON.stringify(facts, null, 2) + '\n');
  return facts;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/prepare-extension-tutorial.mjs <empty-directory>');
  const facts = await prepareTutorial(process.argv[2]);
  console.log(JSON.stringify({ directory: resolve(process.argv[2]), packs: facts.packs.length, inputs: Object.keys(facts.inputs).length }));
}
