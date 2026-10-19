import assert from 'node:assert/strict';
import { readFile, writeFile, cp, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareProductSite } from './product.mjs';
import { sha } from '../../tests/scenarios/harness.mjs';

// Optional composition of the same installed product, never a second editor or
// codec implementation. The default launcher does not build or serve a parser.
export async function prepareMarkdownProductSite(output, facts) {
  const paths = await prepareProductSite(output, facts);
  async function run(program, args, cwd, label, env = {}) {
    const result = spawnSync(program, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    await writeFile(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    facts.commands.push({ command: [program, ...args], cwd, exit: result.status, error: result.error?.message, log: label + '.log' });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, label + ': see saved log');
    return result.stdout;
  }
  let optional;
  if (process.env.EDITAC_MARKDOWN_PACK_RECEIPT) {
    const { resolve, dirname } = await import('node:path');
    const receiptPath = resolve(process.env.EDITAC_MARKDOWN_PACK_RECEIPT);
    const bytes = await readFile(receiptPath), prior = JSON.parse(bytes);
    assert.equal(prior.prepared, true); assert.equal(prior.optionalMarkdown.installed, true);
    assert.deepEqual(prior.toolchains, facts.toolchains);
    const revision = prior.packageSourceRevision ?? prior.sourceRevision;
    await run('git', ['diff', '--exit-code', revision, facts.packageSourceRevision ?? facts.sourceRevision, '--',
      'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.node-version', 'crates', 'packages', 'scripts'],
      process.cwd(), 'reuse-markdown-committed-inputs');
    optional = prior.packs.find(p => p.name === 'markdown'); assert.ok(optional);
    assert.equal(sha(await readFile(join(dirname(receiptPath), optional.file))), optional.sha256);
    await cp(join(dirname(receiptPath), optional.file), join(output, optional.file));
    await cp(join(dirname(receiptPath), 'pack-markdown.log'), join(output, 'pack-markdown.log'));
    facts.reusedMarkdownPackage = { path: receiptPath, sha256: sha(bytes), packageSourceRevision: revision,
      scope: 'Exact committed SDK/compiler inputs and optional tarball; browser cases are separate evidence' };
  } else {
    await run(process.execPath, ['scripts/build-wasm.mjs', '--markdown'], paths.build, 'build-markdown-wasm', { CARGO_TARGET_DIR: join(paths.build, 'target') });
    const [pack] = JSON.parse(await run('npm', ['pack', '--workspace=@edit-ac/markdown', '--pack-destination=' + output, '--json'], paths.build, 'pack-markdown'));
    optional = { name: 'markdown', file: pack.filename, sha256: sha(await readFile(join(output, pack.filename))) };
  }
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(output, optional.file)], paths.consumer, 'consumer-markdown-install');
  assert.equal(await realpath(join(paths.consumer, 'node_modules/@edit-ac/markdown')), join(paths.consumer, 'node_modules/@edit-ac/markdown'));
  await cp(join(paths.consumer, 'node_modules/@edit-ac/markdown/dist'), join(paths.site, 'markdown'), { recursive: true });
  facts.packs.push(optional);
  facts.optionalMarkdown = { installed: true, enabledBy: '?markdown', defaultEnabled: false };
  for (const path of ['examples/task-editor/product.mjs', 'examples/task-editor/product-markdown.mjs']) {
    const pin = { path, sha256: sha(await readFile(path)) };
    const existing = facts.sources.find(p => p.path === path);
    if (existing) assert.equal(existing.sha256, pin.sha256, 'Source changed during preparation: ' + path);
    else facts.sources.push(pin);
  }
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else { const bytes = await readFile(path); facts.artifacts.push({ path: path.slice(output.length + 1), bytes: bytes.length, sha256: sha(bytes) }); }
    }
  }
  await inventory(join(paths.site, 'markdown'));
  facts.packageLockSha256 = sha(await readFile(join(paths.consumer, 'package-lock.json')));
  await writeFile(join(output, 'prepared.json'), JSON.stringify(facts, null, 2) + '\n');
  return paths;
}
