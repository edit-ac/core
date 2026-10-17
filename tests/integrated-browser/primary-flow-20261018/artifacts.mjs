import assert from 'node:assert/strict';
import { readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export const fixture = resolve('tests/integrated-browser/primary-flow-20261018');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareConsumer(consumer, { facts, run }) {
  const packs = ['core','web'].map(name => join(consumer, name, facts.packs.find(p => p.name === name).file));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',...packs], 'install.log');
  // Reuse only immutable authenticated generated members, never live PARALLEL dist.
  const pins = JSON.parse(await readFile('../architecture/evidence/integrated-browser/primary-flow-20261018/pin-1.2-inputs.json', 'utf8'));
  facts.authenticatedRuntime = [];
  for (const pin of pins.authenticatedRuntime) {
    const pack = resolve('../architecture', pin.packPath);
    assert.equal(hash(await readFile(pack)), pin.packSha256);
    const extraction = spawnSync('tar', ['-xOf', pack, pin.member], { maxBuffer: 16*1024*1024 });
    assert.equal(extraction.status, 0); assert.equal(hash(extraction.stdout), pin.sha256);
    const relative = pin.member.replace('package/', '');
    for (const directory of [join(consumer, 'core/package'), join(consumer, 'node_modules/@edit-ac/core')]) await writeFile(join(directory, relative), extraction.stdout);
    facts.authenticatedRuntime.push({ pack, member: pin.member, sha256: pin.sha256 });
  }
  // Browser maps point at installed packages, not source or mutable workspace dist.
  facts.installedConsumer = { install: 'offline tarballs; scripts disabled', imports: ['@edit-ac/core','@edit-ac/web','@edit-ac/web/host'], servedDirectories: {} };
  for (const name of ['core','web']) {
    const extracted = join(consumer, name, 'package/dist');
    const installed = join(consumer, 'node_modules/@edit-ac', name, 'dist');
    await rm(extracted, { recursive: true });
    await symlink(installed, extracted, 'dir');
    assert.equal(await realpath(extracted), await realpath(installed));
    facts.installedConsumer.servedDirectories[name] = await realpath(extracted);
  }
  facts.hostExecutableSha256 = hash(await readFile('target/debug/examples/host-realtime-owner'));
  await writeFile(join(consumer, 'smoke.mjs'), `import {createEditor, DocumentSearch, BlockReorder} from '@edit-ac/web';import {createHostAgent} from '@edit-ac/web/host';if(!createEditor||!DocumentSearch||!BlockReorder||!createHostAgent)throw Error('public imports');`);
  await run(process.execPath, [join(consumer,'smoke.mjs')], 'installed-imports.log');
  // Existing server mount layout reuses the installed public package bytes.
  return fixture;
}
