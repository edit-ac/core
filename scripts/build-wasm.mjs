import { spawnSync } from 'node:child_process';
import { mkdir, rm, rename, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.WASM_BINDGEN || 'wasm-bindgen';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
  return result.stdout.trim();
}
if (run(cli, ['--version']) !== 'wasm-bindgen 0.2.129') {
  throw new Error('Install wasm-bindgen-cli exactly 0.2.129 (matching the locked Rust crate)');
}
run('cargo', ['build', '-p', 'editac-wasm', '--release', '--target', 'wasm32-unknown-unknown', '--locked', '--offline']);
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
