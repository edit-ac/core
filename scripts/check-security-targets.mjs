import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const manifest = JSON.parse(readFileSync(new URL('./security-targets.json', import.meta.url)));

export function validateManifest(value) {
  if (value.version !== 1 || value.toolchain !== '1.97.1' ||
      value.package !== 'editac-security' || value.feature !== 'protocol-probe' ||
      !Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error('Invalid or empty security target manifest');
  }
  const ids = new Set();
  for (const target of value.targets) {
    if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(target.id) ||
        typeof target.platform !== 'string' || !target.platform.trim() || ids.has(target.id)) {
      throw new Error('Invalid or duplicate security target');
    }
    ids.add(target.id);
  }
  return value;
}

export function parseArgs(args, value = manifest) {
  validateManifest(value);
  const selected = [];
  let all = false;
  let evidence;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') {
      if (all) throw new Error('Duplicate --all');
      all = true;
    } else if (args[i] === '--target') {
      const id = args[++i];
      if (!value.targets.some(target => target.id === id) || selected.includes(id)) {
        throw new Error(`Unknown or duplicate target: ${id}`);
      }
      selected.push(id);
    } else if (args[i] === '--evidence') {
      const dir = args[++i];
      if (evidence || !dir || dir.startsWith('--')) throw new Error('Invalid --evidence');
      evidence = path.resolve(dir);
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if ((all && selected.length) || (!all && selected.length === 0)) {
    throw new Error('Select --all or a nonempty set of --target TARGET arguments');
  }
  return { targets: all ? value.targets.map(target => target.id) : selected, evidence };
}

// Injection is for deterministic dispatcher tests; CLI always uses actual rustup/Cargo.
export function runProbes(value, targets, installed, compile) {
  validateManifest(value);
  if (!targets.length || new Set(targets).size !== targets.length ||
      targets.some(id => !value.targets.some(target => target.id === id))) {
    throw new Error('Unknown, duplicate or empty target selection');
  }
  const results = targets.map(target => {
    if (!installed.has(target)) return { target, state: 'unavailable', qualified: false };
    const result = compile(target);
    const qualified = result.status === 0 && !result.error && !result.signal;
    return { target, state: qualified ? 'qualified' : 'failed', qualified,
      exit: result.status, signal: result.signal ?? null,
      error: result.error?.message ?? null };
  });
  const counts = { selected: results.length, executed: 0, passed: 0, failed: 0, unavailable: 0, skipped: 0 };
  for (const result of results) {
    if (result.state === 'unavailable') counts.unavailable++;
    else { counts.executed++; counts[result.qualified ? 'passed' : 'failed']++; }
  }
  return { results, counts, exit: counts.failed || counts.unavailable ? 1 : 0 };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = options.evidence ?? path.join(root, '.artifacts', 'security-targets', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(dir, { recursive: true });
  const rustup = process.env.RUSTUP ?? 'rustup';
  const installedRun = spawnSync(rustup, ['target', 'list', '--installed', '--toolchain', manifest.toolchain],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  writeFileSync(path.join(dir, 'installed-targets.log'), `${installedRun.stdout ?? ''}\n${installedRun.stderr ?? ''}\n${installedRun.error?.message ?? ''}`);
  const installed = new Set(installedRun.status === 0 ? installedRun.stdout.trim().split(/\s+/) : []);
  const commands = [];
  const report = runProbes(manifest, options.targets, installed, target => {
    const args = ['run', manifest.toolchain, 'cargo', 'build', '--locked', '--package', manifest.package,
      '--lib', '--no-default-features', '--features', manifest.feature, '--target', target,
      '--target-dir', path.join(root, 'target', 'security-probes')];
    commands.push({ command: rustup, args });
    const fd = openSync(path.join(dir, `${target}.log`), 'w');
    try { return spawnSync(rustup, args, { cwd: root, stdio: ['ignore', fd, fd], timeout: 300000 }); }
    finally { closeSync(fd); }
  });
  const hash = name => createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex');
  report.scope = 'Compile-only rlib probes; no link/runtime/platform/security-review qualification';
  report.toolchain = manifest.toolchain;
  report.commands = commands;
  report.hashes = Object.fromEntries(['Cargo.lock', 'Cargo.toml', 'scripts/security-targets.json',
    'scripts/check-security-targets.mjs', 'crates/editac-security/Cargo.toml',
    'crates/editac-security/src/lib.rs', 'crates/editac-security/src/probe.rs'].map(name => [name, hash(name)]));
  writeFileSync(path.join(dir, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report.counts, exit: report.exit, receipt: path.join(dir, 'receipt.json') }));
  process.exitCode = report.exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
