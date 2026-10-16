import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const processMemoryPolicy = Object.freeze({
  version: 2, method: 'macos-proc-pid-rusage-v4-browser-tree-confirmed-v2',
  intervalMs: 20, maximumGapMs: 250,
  counterReads: 'current-and-reported-peak/confirm-reported-peak-v1',
  scheduling: 'user-initiated',
  scope: 'Browser tree sampled resident/physical-footprint bytes; OS-maintained per-process lifetime maximum physical footprint. Not a simultaneous tree peak, cycle-local peak, JS allocation peak or plateau qualification.',
});

export async function prepareProcessMemory(directory) {
  if (process.platform !== 'darwin') throw Error('Process-memory method requires macOS proc_pid_rusage; no substitute/skip');
  const binary = join(directory, 'process-memory');
  const compile = spawnSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', 'scripts/process-memory.c', '-o', binary], { encoding: 'utf8' });
  if (compile.status !== 0) throw Error(`Process-memory helper compile failed: ${compile.stderr}`);
  const version = spawnSync('xcrun', ['clang', '--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw Error('Missing process-memory compiler identity');
  const control = spawnSync(binary, ['--allocation-control'], { encoding: 'utf8' });
  if (control.status !== 0) throw Error('Process-memory allocation control failed');
  const tree = spawnSync(binary, ['--tree-control'], { encoding: 'utf8', timeout: 10000 });
  if (tree.status !== 0) throw Error('Process-memory child-tree control failed');
  const [treeControl, sample] = tree.stdout.trim().split('\n').map(line => JSON.parse(line));
  const metadata = { policy: processMemoryPolicy, compiler: version.stdout.trim(),
    binaryHash: createHash('sha256').update(await readFile(binary)).digest('hex'), control: JSON.parse(control.stdout), treeControl: { ...treeControl, sample } };
  return { binary, metadata };
}

export async function startProcessMemory(binary, browserPid) {
  const child = spawn(binary, [String(browserPid), String(processMemoryPolicy.intervalMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', stderr = '', stopped, failure;
  const samples = [];
  let firstResolve, firstReject;
  const first = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr += value; });
  child.stdout.on('data', value => {
    pending += value;
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.stopped) stopped = value.stopped;
        else { samples.push(value); firstResolve(); }
      } catch (error) { failure = error; firstReject(error); child.stdin.end('q'); }
    }
  });
  child.on('error', error => { failure = error; firstReject(error); });
  child.stdin.on('error', error => { failure = error; });
  const completion = once(child, 'close').then(([code, signal]) => {
    if (!samples.length) firstReject(Error(`Process-memory helper exited before sampling: ${code}/${signal}`));
    return { code, signal };
  });
  // Observe rejection immediately even if the helper cannot launch.
  void completion.catch(firstReject);
  await first;
  let result;
  return { pid: child.pid, async stop() {
    if (result) return result;
    if (child.exitCode === null && !child.stdin.destroyed) child.stdin.end('q');
    const exit = await completion;
    if (failure || pending || stderr || exit.code !== 0 || stopped !== 'requested') throw Error(`Incomplete process-memory stream: ${failure ?? stderr ?? exit.code}`);
    result = { browserPid, samplerPid: child.pid, exit, stopped, samples, summary: summarizeProcessMemory(samples) };
    return result;
  } };
}

export function summarizeProcessMemory(samples) {
  const perProcess = new Map();
  for (const sample of samples) for (const p of sample.processes) {
    if (p.error !== undefined) continue;
    const key = `${p.pid}/${p.startIdentity}`, previous = perProcess.get(key);
    perProcess.set(key, { pid: p.pid, startIdentity: p.startIdentity,
      sampledMaxFootprintBytes: Math.max(previous?.sampledMaxFootprintBytes ?? 0, p.footprintBytes),
      lifetimePeakFootprintBytes: Math.max(previous?.lifetimePeakFootprintBytes ?? 0, p.lifetimePeakFootprintBytes, p.confirmedLifetimePeakFootprintBytes) });
  }
  return { sampleCount: samples.length,
    durationMs: samples.at(-1).endMs - samples[0].atMs,
    maximumGapMs: Math.max(0, ...samples.slice(1).map((s, i) => s.atMs - samples[i].atMs)),
    sampledTreeHighWaterBytes: Math.max(...samples.map(s => s.processes.reduce((sum, p) => sum + (p.footprintBytes ?? 0), 0))),
    initialCounterLagSamples: samples.reduce((sum, s) => sum + s.processes.filter(p => p.lifetimePeakFootprintBytes < p.footprintBytes).length, 0),
    perProcess: [...perProcess.values()] };
}
