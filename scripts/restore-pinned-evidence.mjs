import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, verifyPins } from './architecture-budgets.mjs';

async function rejectLinks(root, file) {
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw Error(`Symlink evidence destination: ${file}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Restore historical bytes, never retarget their source/profile pins or claim
// that they qualify a newer executable. All inputs are checked before writes.
export async function restorePinnedEvidence(source, destination, pins) {
  const sourceRoot = await realpath(source), target = resolve(destination);
  if (!pins || !Object.keys(pins).length) throw Error('Missing evidence pins');
  for (const file of Object.keys(pins)) {
    if (isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..') || file.includes('\\')) throw Error(`Invalid evidence path: ${file}`);
  }
  await verifyPins(sourceRoot, pins);
  const overlaps = (a, b) => { const path = relative(a, b); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
  if (overlaps(sourceRoot, target) || overlaps(target, sourceRoot)) throw Error('Evidence destination overlaps source');
  // Check existing destination ancestry too; never write through a link.
  await rejectLinks('/', target.slice(1));
  for (const [file, expected] of Object.entries(pins)) {
    await rejectLinks(target, file);
    try {
      if (digest(await readFile(join(target, file))) !== expected) throw Error(`Conflicting evidence destination: ${file}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const staging = await mkdtemp(join(tmpdir(), 'editac-pinned-evidence-'));
  let copied = 0, reused = 0;
  try {
    for (const file of Object.keys(pins)) {
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await copyFile(join(sourceRoot, file), join(staging, file));
    }
    await verifyPins(staging, pins);
    await mkdir(target, { recursive: true });
    for (const [file, expected] of Object.entries(pins)) {
      await rejectLinks(target, file);
      await mkdir(dirname(join(target, file)), { recursive: true });
      try { await copyFile(join(staging, file), join(target, file), constants.COPYFILE_EXCL); copied++; }
      catch (error) {
        if (error.code !== 'EEXIST' || digest(await readFile(join(target, file))) !== expected) throw error;
        reused++;
      }
    }
    await verifyPins(target, pins);
    return { copied, reused, verified: Object.keys(pins).length, pinsHash: digest(JSON.stringify(pins)), qualification: 'historical-bytes-only' };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
