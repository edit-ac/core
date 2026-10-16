import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = fileURLToPath(new URL('../packages/web/dist/modules/code/backend/', import.meta.url));
mkdirSync(out, { recursive: true });
for (const [cmd, args] of [
  ['cargo', ['build', '-p', 'editac-highlighting', '--release', '--target', 'wasm32-unknown-unknown', '--features', 'browser-wasm', '--locked']],
  ['wasm-bindgen', [new URL('../target/wasm32-unknown-unknown/release/editac_highlighting.wasm', import.meta.url).pathname, '--target', 'web', '--out-dir', out]],
]) {
  const run = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
