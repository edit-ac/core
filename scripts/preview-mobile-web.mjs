import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === '--check')) throw Error('Expected no arguments or --check');
const directory = await mkdtemp(join(tmpdir(), 'editac-mobile-preview-'));
let server, browser, closing;
async function close() {
  if (closing) return closing;
  closing = (async () => { try { await browser?.close(); } finally { try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } })();
  return closing;
}
try {
  for (const name of ['core', 'web']) {
    const target = join(directory, name); await mkdir(target);
    const pack = spawnSync('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', target], { encoding: 'utf8' });
    await writeFile(join(target, 'pack.log'), `${pack.stdout}\n${pack.stderr}`);
    if (pack.error || pack.status !== 0) throw Error(`Cannot pack ${name}`);
    const file = JSON.parse(pack.stdout)[0].filename;
    const unpack = spawnSync('tar', ['-xzf', join(target, file), '-C', target], { encoding: 'utf8' });
    if (unpack.error || unpack.status !== 0) throw Error(`Cannot unpack ${name}`);
  }
  const fixture = join(directory, 'fixture'); await mkdir(fixture);
  await writeFile(join(fixture, 'session.mjs'), await readFile('fixtures/browser-mobile-web/session.mjs'));
  let html = await readFile('fixtures/browser-mobile-web/index.html', 'utf8');
  html = html.replace('Portable mobile mechanics harness', 'Portable editor preview').replace('<button id="host-control"', '<h1>Portable editor preview</h1><p>Try text selection, visible formatting and command search, undo/redo, and block actions. This local desktop browser preview does not establish mobile keyboard or device support.</p><button id="host-control"');
  html = html.replace('<script type="module" src="/fixture/session.mjs"></script>', `<script type="module">import '/fixture/session.mjs'; await window.inputFixture.mount({text:'Try selecting this text, then use the visible commands.',commandControls:true,viewport:true,baselineModules:true,reorder:true,inputHints:{profile:'prose'}}); document.documentElement.dataset.ready='true';</script>`);
  await writeFile(join(fixture, 'index.html'), html);
  server = await startFixtureServer({ fixtureDirectory: fixture, coreDirectory: join(directory, 'core/package/dist'), webDirectory: join(directory, 'web/package/dist') });
  console.log(JSON.stringify({ url: server.url, pid: process.pid, port: server.port, workspace: process.cwd(), purpose: 'requested-on-demand packed mobile portable preview', temporaryDirectory: directory }));
  if (args[0] === '--check') {
    const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.url); await page.waitForSelector('html[data-ready=true]');
    await page.evaluate(() => { const f = window.inputFixture; f.select(f.ids[0], 3, 0); });
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    const state = await page.evaluate(() => window.inputFixture.state());
    if (errors.length || state.history.undoGroups !== 1 || state.journal.length !== 1 || !state.nodes[0].runs.some(r => r.attributes.bold === true)) throw Error('Packed preview did not apply and persist its visible command');
    await page.evaluate(() => window.inputFixture.destroy());
    await close(); console.log(JSON.stringify({ executed: 1, passed: 1, failed: 0, skipped: 0, cleanup: 'browser/server/temporary packed preview removed' }));
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); });
  }
} catch (error) { await close(); throw error; }
