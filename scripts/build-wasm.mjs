import { spawnSync } from 'node:child_process';
import { mkdir, rm, rename, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
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
run(cargo, ['build', '-p', 'editac-wasm', '--release', '--target', 'wasm32-unknown-unknown', '--locked', '--offline'], { ...process.env, RUSTC: rustc });
const dist = path.join(root, 'packages/core/dist');
const staging = path.join(dist, `.wasm-${process.pid}`);
await mkdir(staging, { recursive: true });
try {
  run(cli, ['target/wasm32-unknown-unknown/release/editac_wasm.wasm', '--target', 'web', '--out-dir', staging, '--out-name', 'editac_wasm']);
  await rm(path.join(dist, 'wasm'), { recursive: true, force: true });
  await rename(staging, path.join(dist, 'wasm'));
  run('npm', ['run', 'build', '--workspace', '@edit-ac/core']);
  for (const name of ['editac_wasm_bg.wasm', 'editac_wasm.js']) {
    const file = path.join(dist, 'wasm', name);
    console.log(JSON.stringify({ artifact: name, bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }));
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
