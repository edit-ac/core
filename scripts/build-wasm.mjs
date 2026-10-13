import { spawnSync } from 'node:child_process';
import { mkdir, rm, rename, stat, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { shareEngineStringAdapters } from './share-wasm-glue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = process.argv.includes('--fixture');
const markdown = process.argv.includes('--markdown');
if (fixture && markdown) throw new Error('fixture and markdown profiles are independent');
const crate = markdown ? 'editac-markdown-wasm' : 'editac-wasm';
const stem = markdown ? 'editac_markdown_wasm' : 'editac_wasm';
const packageName = markdown ? '@edit-ac/markdown' : '@edit-ac/core';
const cli = process.env.WASM_BINDGEN || 'wasm-bindgen';
const toolchain = (await readFile(path.join(root, 'rust-toolchain.toml'), 'utf8')).match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
if (!toolchain) throw new Error('rust-toolchain.toml must declare the engine build toolchain');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
  return result.stdout.trim();
}
if (run(cli, ['--version']) !== 'wasm-bindgen 0.2.129') {
  throw new Error('Install wasm-bindgen-cli exactly 0.2.129 (matching the locked Rust crate)');
}
// Resolve both tools: a pinned Cargo can still find a different rustc on PATH.
const cargo = run('rustup', ['which', '--toolchain', toolchain, 'cargo']);
const rustc = run('rustup', ['which', '--toolchain', toolchain, 'rustc']);
run(cargo, ['build', '-p', crate, '--profile', 'browser', ...(fixture ? ['--features', 'foundation-fixture'] : []), '--target', 'wasm32-unknown-unknown', '--locked', '--offline'], { ...process.env, RUSTC: rustc });
// Cargo reuses the crate's output path across feature configurations. Retain
// each exact bindgen input so fixture builds cannot replace production parity
// inputs. These reproducible build intermediates are never packed or loaded.
const inputDir = path.join(root, 'target/browser-inputs', markdown ? 'markdown' : fixture ? 'fixture' : 'production');
await mkdir(inputDir, { recursive: true });
const input = path.join(inputDir, `${stem}.wasm`);
await copyFile(path.join(root, 'target/wasm32-unknown-unknown/browser', `${stem}.wasm`), input);
const artifactDir = fixture ? 'wasm-fixture' : 'wasm';
const dist = path.join(root, markdown ? 'packages/markdown/dist' : 'packages/core/dist');
const staging = path.join(dist, `.wasm-${process.pid}`);
await mkdir(staging, { recursive: true });
try {
  run(cli, [input, '--target', 'web', '--out-dir', staging, '--out-name', stem]);
  const glue = path.join(staging, `${stem}.js`);
  if (!markdown) {
    await writeFile(glue, shareEngineStringAdapters(await readFile(glue, 'utf8')));
    // Narrow the async SDK graph; the raw entry retains its initSync API.
    if (!fixture) await writeFile(path.join(staging, 'editac_runtime.js'), "export { initRuntime as default, Engine } from './editac_wasm.js';\n");
  }
  await rm(path.join(dist, artifactDir), { recursive: true, force: true });
  await rename(staging, path.join(dist, artifactDir));
  run('npm', ['run', 'build', '--workspace', packageName]);
  await import('./build-wasm-notices.mjs');
  for (const name of [`${stem}_bg.wasm`, `${stem}.js`]) {
    const file = path.join(dist, artifactDir, name);
    console.log(JSON.stringify({ artifact: name, bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }));
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
