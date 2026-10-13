import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

export function browserHarness(suite, fixtureDirectory = 'fixtures/browser-input', options = {}) {
  const markdownEnabled = options.markdown ?? ['markdown-paste','markdown-extensions','markdown-collaboration','shortcuts','content-modules','extension-entry','sdk'].includes(suite);
  const key = suite.toUpperCase().replaceAll('-', '_');
  const engine = process.env[`EDITAC_${key}_BROWSER`] ?? 'chromium';
  const browserType = { chromium, firefox, webkit }[engine];
  if (!browserType) throw Error(`Unknown browser ${engine}`);
  const facts = { suite, engine, cases: [], processes: [], packs: [], cleanup: {} };
  let output, consumer, server, browser, controller;
  async function run(command, args, log) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
    await writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.equal(result.error, undefined, log); assert.equal(result.status, 0, log); return result.stdout;
  }
  before(async () => {
    output = process.env[`EDITAC_${key}_OUTPUT`] ?? await mkdtemp(join(tmpdir(), `editac-${suite}-evidence-`));
    await mkdir(output, { recursive: true });
    facts.revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const paths = ['packages/web/src/clipboard/fragment.ts', 'packages/web/src/clipboard/html.ts', 'packages/markdown/src/web.ts', 'packages/markdown/src/shortcuts.ts', 'packages/web/src/clipboard/pending.ts', 'tests/browser/format-helpers.ts', 'crates/editac-markdown/src/extensions.rs', 'crates/editac-markdown/src/optional.rs', 'crates/editac-core/src/modules/content.rs', 'packages/web/src/input/text.ts', 'packages/web/src/input/shortcuts.ts', 'packages/core/src/engine.ts', 'crates/editac-core/src/commands/editor.rs', 'crates/editac-wasm/src/bridge.rs', 'scripts/test-browser.mjs', `tests/browser/${suite}.spec.ts`, 'tests/browser/browser-harness.ts', 'package-lock.json'];
    if (suite === 'sdk') paths.push('packages/web/src/sdk.ts', 'packages/web/src/editor.ts', 'packages/web/src/index.ts', 'examples/task-editor/editor.mjs', 'examples/task-editor/index.html');
    if (suite === 'math') paths.push('packages/web/src/modules/math.ts', 'packages/web/src/modules/math-renderer.ts', 'packages/web/src/dom/render.ts', 'packages/web/src/input/text.ts', 'scripts/build-math-assets.mjs', 'fixtures/modules/math.json', 'fixtures/browser-math/session.mjs', 'fixtures/browser-math/index.html', 'crates/editac-core/tests/math_atom.rs', 'packages/web/package.json');
    if (suite === 'content-modules') paths.push('packages/web/src/modules/content.ts', 'packages/web/src/dom/render.ts', 'packages/web/src/surface.ts', 'packages/web/src/editor.ts', 'packages/web/src/index.ts', 'fixtures/browser-content-modules/session.mjs', 'fixtures/browser-content-modules/index.html', 'crates/editac-core/tests/table_cells.rs');
    if (suite === 'reorder') paths.push('packages/web/src/modules/reorder.ts', 'packages/web/src/dom/selection.ts', 'packages/web/src/surface.ts', 'packages/web/src/editor.ts', 'packages/web/src/index.ts', 'fixtures/browser-reorder/session.mjs', 'fixtures/browser-reorder/index.html');
    if (suite === 'slash') paths.push('packages/web/src/modules/slash.ts', 'packages/web/src/surface.ts', 'packages/web/src/editor.ts', 'packages/web/src/index.ts', 'fixtures/browser-slash/session.mjs', 'fixtures/browser-slash/index.html');
    if (suite === 'references') paths.push('packages/web/src/modules/references.ts', 'crates/editac-core/src/modules/content.rs', 'crates/editac-markdown/src/export.rs', 'crates/editac-markdown/src/optional.rs', 'packages/web/src/surface.ts', 'packages/web/src/editor.ts', 'packages/web/src/index.ts', 'fixtures/browser-references/session.mjs', 'fixtures/browser-references/index.html');
    if (suite === 'react') paths.push('packages/react/src/index.ts', 'packages/react/package.json', 'fixtures/browser-react/client.mjs', 'fixtures/browser-react/index.html', 'tests/react-ssr.test.mjs');
    if (suite === 'review') paths.push('packages/web/src/review/model.ts', 'packages/web/src/review/view.ts', 'packages/web/src/index.ts', 'fixtures/browser-review/index.html', 'fixtures/browser-review/session.mjs', 'fixtures/browser-review/model.json', 'crates/editac-diff/tests/web_review_fixture.rs');
    if (suite === 'history-review') paths.push('packages/web/src/review/history.ts', 'packages/web/src/index.ts', 'packages/web/src/storage/index.ts', 'packages/web/src/entry.ts', 'packages/web/src/sync/session.ts', 'packages/web/src/sync/protocol.ts', 'fixtures/browser-history-review/session.mjs', 'fixtures/browser-history-review/index.html');
    if (suite === 'review-concurrent') paths.push('packages/web/src/review/model.ts', 'packages/web/src/review/view.ts', 'packages/web/src/review/history.ts', 'packages/web/src/index.ts', 'packages/web/src/storage/index.ts', 'packages/web/src/sync/session.ts', 'packages/web/src/sync/protocol.ts', 'fixtures/browser-review-concurrent/session.mjs', 'fixtures/browser-review-concurrent/index.html', 'fixtures/browser-review-concurrent/models.json', 'fixtures/browser-review-concurrent/concurrent.json', 'crates/editac-diff/src/portable.rs', 'crates/editac-diff/tests/portable.rs');
    facts.sources = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
    consumer = await mkdtemp(join(tmpdir(), `editac-${suite}-consumer-`));
    for (const name of [...new Set([...(options.packages ?? ['core', 'web']), ...(markdownEnabled ? ['markdown'] : [])])]) {
      const directory = join(consumer, name); await mkdir(directory);
      const pack = JSON.parse(await run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', directory], `pack-${name}.log`))[0];
      const bytes = await readFile(join(directory, pack.filename));
      await writeFile(join(output, pack.filename), bytes);
      facts.packs.push({ name, file: pack.filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      if (name === 'core') assert.ok(pack.files.some(f => f.path === 'dist/wasm/editac_wasm_bg.wasm'));
      await run('tar', ['-xzf', join(directory, pack.filename), '-C', directory], `unpack-${name}.log`);
    }
    const preparedFixture = options.prepareConsumer ? await options.prepareConsumer(consumer) : fixtureDirectory;
    server = await startFixtureServer({ fixtureDirectory: preparedFixture, coreDirectory: join(consumer, 'core/package/dist'), webDirectory: join(consumer, 'web/package/dist'), ...(markdownEnabled ? {markdownDirectory: join(consumer, 'markdown/package/dist')} : {}) });
    facts.server = { pid: process.pid, port: server.port, workspace: process.cwd(), purpose: suite, log: output };
    controller = await browserType.launchServer({ headless: true });
    facts.processes.push({ pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: process.cwd(), purpose: suite, log: output });
    browser = await browserType.connect(controller.wsEndpoint());
    facts.browser = { version: browser.version(), engine, playwright: '1.64.0', node: process.version };
  });
  after(async () => {
    try { await browser?.close(); } finally {
      try { await controller?.close(); facts.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null; }
      finally { try { await server?.close(); facts.cleanup.serverClosed = true; } finally {
        if (consumer) await rm(consumer, { recursive: true, force: true }); facts.cleanup.consumerRemoved = true;
        facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.passed).length, failed: facts.cases.filter(c => !c.passed).length, skipped: 0 };
        if (output) await writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2));
      } }
    }
  });
  async function probe(name, action, text = 'alpha') {
    const context = await browser.newContext();
    const fact = { name, passed: false, provenance: 'deterministic browser fixture; no physical device or OS clipboard claim', snapshots: [], errors: [], requests: [] };
    facts.cases.push(fact);
    const page = await context.newPage(); if (['history-review','review-concurrent'].includes(suite)) page.setDefaultTimeout(5000); page.on('pageerror', e => fact.errors.push(e.message)); page.on('request', r=>fact.requests.push(r.url()));
    try {
      await page.addInitScript(enabled => { window.markdownEnabled = enabled; }, markdownEnabled);
      await page.goto(server.url);
      if (options.autoMount !== false) {
        await page.waitForFunction(() => !!window.inputFixture);
        await page.evaluate(text => window.inputFixture.mount(text), text);
      }
      await page.evaluate(() => {
        // Firefox intentionally discards DataTransfer in constructed ClipboardEvents.
        // Supply the prepared payload explicitly; this is never OS clipboard evidence.
        window.preparedClipboardEvent = (type, data) => {
          const event = new ClipboardEvent(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data }); return event;
        };
      });
      await action(page, fact); assert.deepEqual(fact.errors, []); fact.passed = true;
    } catch (error) {
      fact.failure = { message: error.message, stack: error.stack };
      await writeFile(join(output, `${name}-failure.json`), JSON.stringify(fact, null, 2));
      throw error;
    } finally {
      try { await page.evaluate(async () => { if (window.activeEditor) await window.activeEditor.destroy({policy:'report'}); if (!window.fixtureDisposed) await window.inputFixture?.destroy(); }); } finally { await context.close(); }
    }
  }
  return { probe, facts };
}
