import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import * as Y from 'yjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = 'a😀b e\u0301👩\u200d💻🇭🇺אב';
const evidence = process.env.EDITAC_WASM_OUTPUT;
let temp, server, browser, browserController, base, packed;
const requests = [];
const facts = { processes: [], cases: [] };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
before(async () => {
  if (evidence) await mkdir(evidence, { recursive: true });
  temp = await mkdtemp(path.join(tmpdir(), 'editac-wasm-load-'));
  await mkdir(path.join(temp, 'consumer'));
  const metadata = JSON.parse(run('npm', ['pack', '--workspace', '@edit-ac/core', '--pack-destination', temp, '--json'], root))[0];
  const consumer = path.join(temp, 'consumer');
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', path.join(temp, metadata.filename)], consumer);
  packed = path.join(consumer, 'node_modules/@edit-ac/core');
  const wasm = await readFile(path.join(packed, 'dist/wasm/editac_wasm_bg.wasm'));
  assert.deepEqual(wasm, await readFile(path.join(root, 'packages/core/dist/wasm/editac_wasm_bg.wasm')));
  facts.pack = { filename: metadata.filename, integrity: metadata.integrity, files: metadata.files.map(f => f.path), bytes: metadata.size };
  facts.temp = temp;
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    try {
      if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>WASM fixture harness</title>'); return; }
      if (pathname === '/assets/supplied.wasm') { res.setHeader('Content-Type', 'application/wasm'); res.end(wasm); return; }
      const prefix = pathname.startsWith('/built/') ? '/built/' : '/packed/';
      const directory = prefix === '/built/' ? path.join(root, 'packages/core/dist') : path.join(packed, 'dist');
      const relative = pathname.slice(prefix.length);
      if (!pathname.startsWith(prefix) || relative.includes('..')) throw new Error('not found');
      res.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(await readFile(path.join(directory, relative)));
    } catch { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  facts.processes.push({ pid: process.pid, launcher: 'node --test tests/wasm-load.test.mjs', workspace: root, port: server.address().port, purpose: 'task-owned fixture assets', log: 'wasm-load.log' });
  browserController = await chromium.launchServer({ headless: true });
  const child = browserController.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: root, purpose: 'task-owned Chromium WASM checks', log: 'wasm-load.log' });
  browser = await chromium.connect(browserController.wsEndpoint());
  facts.browser = { version: browser.version(), playwright: JSON.parse(await readFile(path.join(root, 'node_modules/playwright/package.json'))).version };
}, { timeout: 120_000 });
after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (browserController) await browserController.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    facts.requests = requests;
    facts.teardown = { browserClosed: !browser?.isConnected(), serverClosed: !server?.listening, browserProcessExited: !browserController || browserController.process().exitCode !== null };
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'harness.json'), JSON.stringify(facts, null, 2) + '\n'); }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
});

test('built and packed SSR imports perform no browser access, fetch or WASM initialization', async () => {
  for (const mode of ['built', 'packed']) {
    const consumer = path.join(temp, 'consumer');
    const script = `
      import assert from 'node:assert/strict';
      const forbidden = () => { throw new Error('SSR import side effect'); };
      for (const key of ['window', 'document']) Object.defineProperty(globalThis, key, { get: forbidden });
      globalThis.fetch = forbidden;
      globalThis.WebAssembly = new Proxy(WebAssembly, { get: forbidden });
      const runtime = await import(${JSON.stringify(mode === 'built' ? new URL('../packages/core/dist/index.js', import.meta.url).href : '@edit-ac/core')});
      assert.deepEqual(Object.keys(runtime), ['init']);
      await assert.rejects(runtime.init(''), /nonempty/);
      ${mode === 'packed' ? "assert.ok(import.meta.resolve('@edit-ac/core/wasm').endsWith('/dist/wasm/editac_wasm_bg.wasm'));" : ''}
    `;
    const scriptPath = path.join(consumer, 'ssr.mjs');
    await writeFile(scriptPath, script);
    run(process.execPath, [scriptPath], consumer);
  }
});

async function loadFixture(mode, asset) {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    return await page.evaluate(async ({ mode, asset }) => {
      const { init } = await import(`/${mode}/index.js`);
      const first = init(asset);
      const samePromise = first === init(asset);
      const runtime = await first;
      const before = runtime.createdDocumentCount();
      const fixture = runtime.createFixture();
      try {
        const result = { samePromise, before, after: runtime.createdDocumentCount(), text: fixture.text(), length: fixture.utf16_length(), update: Array.from(fixture.update_v1()) };
        try { await init('/different.wasm'); result.differentUrlRejected = false; }
        catch { result.differentUrlRejected = true; }
        return result;
      } finally { fixture.free(); }
    }, { mode, asset });
  } finally { await page.close(); }
}

for (const [mode, asset] of [['built', '/assets/supplied.wasm'], ['packed', '/packed/wasm/editac_wasm_bg.wasm']]) {
  test(`${mode} browser consumer loads actual compiled WASM at the explicit asset URL`, async () => {
    const start = requests.length;
    const result = await loadFixture(mode, asset);
    assert.equal(result.samePromise, true);
    assert.equal(result.before, 0);
    assert.equal(result.after, 1);
    assert.equal(result.text, input);
    assert.equal(result.length, input.length);
    assert.equal(result.differentUrlRejected, true);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Uint8Array.from(result.update));
      const element = doc.getXmlFragment('interop').get(0);
      assert.equal(element.nodeName, 'p');
      assert.equal(element.getAttribute('id'), 'fixture-block');
      assert.deepEqual(element.get(0).toDelta(), [{ insert: 'a' }, { insert: '😀', attributes: { bold: true } }, { insert: input.slice(3) }]);
    } finally { doc.destroy(); }
    const assetRequests = requests.slice(start).filter(url => url.endsWith('.wasm'));
    assert.deepEqual(assetRequests, [asset]);
    facts.cases.push({ mode, asset, before: result.before, after: result.after, utf16Length: result.length, updateBytes: result.update.length });
    if (evidence) await writeFile(path.join(evidence, `${mode}-fixture-v1.bin`), Uint8Array.from(result.update));
  });
}

test('failed asset initialization is observable and retry creates no document until requested', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { init } = await import('/built/index.js');
      let failed = false;
      try { await init('/missing.wasm'); } catch { failed = true; }
      const runtime = await init('/assets/supplied.wasm');
      return { failed, created: runtime.createdDocumentCount() };
    });
    assert.deepEqual(result, { failed: true, created: 0 });
  } finally { await page.close(); }
});

test('compiled bridge applies JS-authored marked Unicode v1 updates and rejects malformed bytes', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const initial = await page.evaluate(async () => {
      const runtime = await (await import('/built/index.js')).init('/assets/supplied.wasm');
      globalThis.fixture = runtime.createFixture();
      return Array.from(globalThis.fixture.update_v1());
    });
    const doc = new Y.Doc();
    let update;
    try {
      Y.applyUpdate(doc, Uint8Array.from(initial));
      const vector = Y.encodeStateVector(doc);
      const text = doc.getXmlFragment('interop').get(0).get(0);
      text.insert(3, '!', { italic: true });
      update = Y.encodeStateAsUpdate(doc, vector);
    } finally { doc.destroy(); }
    const result = await page.evaluate(bytes => {
      const fixture = globalThis.fixture;
      try {
        fixture.apply_v1(Uint8Array.from(bytes));
        fixture.apply_v1(Uint8Array.from(bytes));
        const before = Array.from(fixture.update_v1());
        let rejected = false;
        try { fixture.apply_v1(new Uint8Array([255])); } catch { rejected = true; }
        return { rejected, before, after: Array.from(fixture.update_v1()), text: fixture.text(), length: fixture.utf16_length() };
      } finally { fixture.free(); }
    }, Array.from(update));
    assert.equal(result.rejected, true);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.text, input.slice(0, 3) + '!' + input.slice(3));
    assert.equal(result.length, input.length + 1);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Uint8Array.from(result.after));
      assert.equal(restored.getXmlFragment('interop').get(0).get(0).toDelta()[2].attributes.italic, true);
    } finally { restored.destroy(); }
    if (evidence) await writeFile(path.join(evidence, 'js-edited-fixture-v1.bin'), Uint8Array.from(result.after));
  } finally { await page.close(); }
});

test('packed binary and glue bytes are measured and generated output does not replace package metadata', async () => {
  const manifest = JSON.parse(await readFile(path.join(packed, 'package.json')));
  assert.equal(manifest.name, '@edit-ac/core');
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'Apache-2.0');
  for (const name of ['editac_wasm_bg.wasm', 'editac_wasm.js']) {
    const bytes = (await stat(path.join(packed, 'dist/wasm', name))).size;
    assert.ok(bytes > 0);
    (facts.artifacts ??= []).push({ name, bytes });
  }
  assert.ok(facts.pack.files.includes('dist/index.d.ts'));
  assert.ok(facts.pack.files.includes('dist/wasm/editac_wasm_bg.wasm'));
  assert.ok(!facts.pack.files.includes('dist/wasm/package.json'));
});
