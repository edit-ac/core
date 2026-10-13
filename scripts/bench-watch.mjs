import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopOwnedProcess } from './owned-processes.mjs';
import { requireTestNode } from './test-toolchain.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await requireTestNode();
let child, timer, queued = false, stopping = false;
function run() {
  if (stopping) return;
  if (child) { queued = true; return; }
  queued = false;
  const args = process.argv.slice(2);
  child = spawn(process.execPath, ['scripts/bench.mjs', '--quick', ...(args.includes('--fixtures') ? [] : ['--fixtures', 'small,medium']), ...args], { stdio: 'inherit' });
  child.once('close', code => { child = undefined; if (stopping) return; console.log(`Benchmark run exited ${code}; watching for source changes.`); if (queued) run(); });
}
const watchers = ['packages', 'crates', 'benchmarks', 'scripts'].map(directory => watch(directory, { recursive: true }, (_, path) => {
  if (!path || /(^|[/\\])(dist|target|node_modules)([/\\]|$)/.test(path)) return;
  clearTimeout(timer); timer = setTimeout(run, 750);
}));
function stop(signal) {
  stopping = true; clearTimeout(timer); for (const watcher of watchers) watcher.close();
  stopOwnedProcess(child);
}
process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
console.log('Watching editor source; runs are serialized and changes during a run queue one follow-up. Ctrl-C tears down the benchmark.');
run();
