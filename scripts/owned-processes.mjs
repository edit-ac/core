import { spawnSync } from 'node:child_process';

function snapshot() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot verify task process ownership');
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: `${match[3]} ${match[4]}`.replaceAll(/\s+/g, ' ').trim() }] : [];
  });
}
function signalVerified(record, signal) {
  const current = spawnSync('ps', ['-p', String(record.pid), '-o', 'lstart=,comm='], { encoding: 'utf8' });
  if (current.status !== 0 || current.stdout.replaceAll(/\s+/g, ' ').trim() !== record.identity) return;
  try { process.kill(record.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Capture descendants before their launcher exits; revalidate birth/command
 * identity before each exact-PID signal. Never kill by process name or group. */
export function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return [];
  const processes = snapshot(), root = processes.find(item => item.pid === child.pid && item.parent === process.pid);
  if (!root) throw Error(`Cannot verify ownership of launcher ${child.pid}`);
  const owned = [root];
  for (let index = 0; index < owned.length; index++) owned.push(...processes.filter(item => item.parent === owned[index].pid));
  signalVerified(root, 'SIGTERM');
  // Give the runner's finally blocks time to close browsers/storage normally.
  setTimeout(() => { for (const record of [...owned].reverse()) signalVerified(record, 'SIGTERM'); }, 1500);
  setTimeout(() => { for (const record of [...owned].reverse()) signalVerified(record, 'SIGKILL'); }, 3500);
  return owned;
}
