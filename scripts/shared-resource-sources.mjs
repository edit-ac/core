import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Both packed harnesses authenticate the same production source closure. A
// hand-maintained list of entry points misses changes below those entry points.
export function sharedResourceSources(root = process.cwd()) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(path =>
    /^packages\/(?:core|web|react|astro|markdown)\/(?:src\/|package\.json$)/.test(path) ||
    /^crates\/[^/]+\/(?:src\/|Cargo\.toml$)/.test(path) ||
    /^(?:Cargo\.(?:toml|lock)|package(?:-lock)?\.json|rust-toolchain\.toml|scripts\/(?:build[^/]*|shared-resource-sources)\.mjs)$/.test(path));
  assert(paths.some(path => path === 'packages/core/src/index.ts'));
  assert(paths.some(path => path === 'crates/editac-wasm/src/bridge.rs'));
  return paths.sort();
}
