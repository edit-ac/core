import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireTestNode } from '../../../scripts/test-toolchain.mjs';

const output = process.env.EDITAC_FORMAT_CONSUMER_OUTPUT;
assert.ok(output, 'Set an absolute worktree-owned output directory');
let consumer;
const receipt = { packages: [], checks: [], cleanup: {} };
function run(command, args, log, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  return writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`).then(() => {
    assert.equal(result.error, undefined, log); assert.equal(result.status, 0, log); return result;
  });
}
before(async () => {
  await requireTestNode(); await mkdir(output, { recursive: true });
  consumer = await mkdtemp(join(tmpdir(), 'editac-mobile-format-consumer-'));
  receipt.consumer = consumer; receipt.node = process.version;
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const archives = [];
  for (const name of ['core', 'web']) {
    const packed = await run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', output], `pack-${name}.log`, process.cwd());
    const manifest = JSON.parse(packed.stdout)[0], path = resolve(output, manifest.filename), bytes = await readFile(path);
    archives.push(path); receipt.packages.push({ name, filename: manifest.filename, sha256: createHash('sha256').update(bytes).digest('hex'), members: manifest.files.length });
  }
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...archives], 'install.log');
});
after(async () => {
  if (consumer) { await rm(consumer, { recursive: true, force: true }); receipt.cleanup.consumerRemoved = true; }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
});
test('public installed format entry and factory do not read browser globals', async () => {
  await writeFile(join(consumer, 'ssr.mjs'), `
for(const key of ['document','window','navigator','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw Error('import '+key)}});
const {formatControls,FormatControls}=await import('@edit-ac/web/formats');
if(typeof formatControls()!=='function'||typeof FormatControls!=='function')throw Error('public format entry missing');
const {BrowserEditor}=await import('@edit-ac/web/editor');
if(typeof BrowserEditor.prototype.enableFormatControls!=='function')throw Error('public owner attachment missing');
`);
  await run(process.execPath, ['ssr.mjs'], 'ssr.log'); receipt.checks.push({ id: 'public-ssr', passed: true });
});
test('installed declarations support the public owning recipe and reject invalid actions/options', async () => {
  await writeFile(join(consumer, 'recipe.ts'), `
import {BrowserEditor} from '@edit-ac/web/editor';
import {formatControls,type FormatControls} from '@edit-ac/web/formats';
declare const editor:BrowserEditor, toolbar:HTMLElement;
const controls:FormatControls=editor.enableFormatControls(formatControls({maxBytes:4096}));
toolbar.append(controls.element);
void controls.artifact?.bytes; void controls.busy; void controls.deliver('manual');
// @ts-expect-error An explicit factory is required; no default optional bundle.
editor.enableFormatControls({maxBytes:4096});
// @ts-expect-error No arbitrary transport or provider actions.
void controls.deliver('upload');
// @ts-expect-error Byte limits are bounded numeric configuration.
formatControls({maxBytes:'unbounded'});
`);
  await run(resolve('node_modules/.bin/tsc'), ['recipe.ts', '--noEmit', '--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM'], 'types.log');
  receipt.checks.push({ id: 'public-types-and-three-invalid-options', passed: true });
});
