import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { produceRelease, canonical } from './profile-producers.mjs';
import { sha256 } from './capability-contract.mjs';

export function releaseProfile(root = fileURLToPath(new URL('../', import.meta.url))) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'contracts/profiles/producers.json')));
  return produceRelease(manifest, { core: root, architecture: resolve(root, '../architecture') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw Error('Expected --output FILE');
    const record = releaseProfile(), bytes = canonical(record) + '\n';
    writeFileSync(resolve(args[1]), bytes, { flag: 'wx' });
    console.log(JSON.stringify({ output: resolve(args[1]), sha256: sha256(bytes), contentRevision: record.contentRevision,
      profiles: record.profiles.length, supportedNative: record.profiles.filter(p => p.support.state === 'supported').length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
