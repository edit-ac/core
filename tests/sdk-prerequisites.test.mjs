import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init, EngineError } from '@edit-ac/core';
import {initMarkdown} from '@edit-ac/markdown';
import * as web from '@edit-ac/web';

// Production WASM, deterministic content, no provider/network or recording port.
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const asset = 'data:application/wasm;base64,' + wasm.toString('base64');
const runtime = await init(asset);
const parserBytes=await readFile(new URL('../packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm',import.meta.url));
const codec=await initMarkdown('data:application/wasm;base64,'+parserBytes.toString('base64'));
let sequence = 0;
const create = () => runtime.createEngine({ profile: 'v5', documentId: `81000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, epoch: '82000000-0000-4000-8000-000000000001', nodes: [{ text: 'A😀B' }] });
const text = engine => engine.read().visible.map(n => n.runs.map(r => r.text).join('')).join('\n');
const rejects = (code, operation) => error => error instanceof EngineError && error.code === code && (!operation || error.operation === operation);

test('public SSR imports allocate nothing and reject empty asset URLs without I/O', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const forbidden = () => { throw Error('unexpected initialization'); };
    for (const key of ['window', 'document', 'navigator', 'indexedDB']) Object.defineProperty(globalThis, key, { get: forbidden, configurable: true });
    globalThis.fetch = forbidden;
    globalThis.WebAssembly = new Proxy(WebAssembly, { get: forbidden });
    const core = await import('@edit-ac/core');
    await import('@edit-ac/web'); await import('@edit-ac/web/math');
    await assert.rejects(core.init(''), /nonempty/);
  `], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('public web exports resolve implemented entrypoints and explicit task defaults', () => {
  assert.deepEqual(Object.keys(web).sort(), [
    'BrowserEditor', 'CommandChain', 'CheckpointStorage', 'ModuleContractError', 'ModuleRegistry', 'ModuleRuntime',
    'ReferencePresenter', 'ReorderPresenter', 'SlashPresenter', 'contentModules',
    'mountEditor', 'mountEditorSurface', 'referenceBlock', 'referenceSuggestions',
    'reorderControls', 'slashCommands', 'createEditor', 'taskPreset',
    'ChangeReview', 'DEFAULT_REVIEW_LIMITS', 'HistoryRestorer', 'HistoryReview',
    'PrivateReferenceView', 'ReferenceLookupSession', 'WebHistoryStore',
    'exportChangeModel', 'importChangeModel', 'linkEnrichment', 'prepareReview', 'privateReferenceDisplay',
  ].sort());
  for (const [name, value] of Object.entries(web)) {
    assert.equal(typeof value, name === 'DEFAULT_REVIEW_LIMITS' ? 'object' : 'function', name);
  }
  assert.equal(Object.isFrozen(web.DEFAULT_REVIEW_LIMITS), true);
  for (const name of ['can', 'chain', 'attachSync', 'subscribe', 'flush', 'destroy']) {
    assert.equal(typeof web.BrowserEditor.prototype[name], 'function', name);
  }
  assert.deepEqual(web.taskPreset(), {
    preset: 'task', typingShortcuts: true, plainPasteControl: true,
  });
  assert.equal(web.taskPreset({ plainTextPolicy: 'literal' }).plainTextPolicy, 'literal');
});

test('the core README example executes against the public production runtime', async () => {
  const readme = await readFile(new URL('../packages/core/README.md', import.meta.url), 'utf8');
  const snippets = [...readme.matchAll(/```js\n([\s\S]*?)```/g)];
  assert.equal(snippets.length, 1);
  const code = snippets[0][1].replace("import { init } from '@edit-ac/core';", '')
    .replace("'/assets/editac_wasm_bg.wasm'", 'asset');
  const output = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('init', 'asset', 'console', code)(init, asset, { log: value => output.push(value) });
  assert.deepEqual(output, ['Hello world']);
});

test('unsupported commands and invalid JSON reject before mutation, including a mixed batch', () => {
  const engine = create();
  try {
    const at = engine.anchor(engine.read().visible[0].id, 1, 'right');
    const before = engine.checkpoint();
    const invalid = { kind: 'editor', origin: 'local:sdk', commands: [
      { type: 'insert', at, text: 'must not appear' }, { type: 'unsupported' },
    ] };
    assert.equal(engine.can(invalid), false);
    assert.throws(() => engine.prepare(invalid), rejects('InvalidInput', 'prepare'));
    assert.throws(() => engine.anchor(engine.read().visible[0].id, NaN, 'right'), rejects('InvalidInput', 'anchor'));
    assert.deepEqual(engine.checkpoint(), before);
    assert.equal(text(engine), 'A😀B');
    engine.releaseAnchor(at);
    assert.throws(() => runtime.createEngine({ profile: 'unsupported', documentId: 'x', epoch: 'one', nodes: [] }), rejects('InvalidInput', 'create'));
  } finally { engine.dispose(); }
});

test('patch observers retain independent payloads through reentrant history and observer errors', () => {
  const engine = create(), expected = [], received = [], order = [];
  let nested = false;
  try {
    const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
    engine.subscribe({ type: 'all' }, patch => {
      order.push('first');
      expected.push(structuredClone(patch));
      patch.identity.documentId = 'corrupted';
      patch.changedNodes.length = 0;
      patch.nodes[0].node.runs[0].text = 'corrupted';
      patch.update.bytes.fill(0);
      if (!nested) { nested = true; engine.history({ type: 'undo' }); }
    });
    engine.subscribe({ type: 'all' }, () => { order.push('throw'); throw Error('isolated'); });
    engine.subscribe({ type: 'updates' }, patch => { order.push('last'); received.push(patch); });
    engine.subscribe({ type: 'nodes', ids: ['absent'] }, () => assert.fail('unmatched observer'));
    const plan = engine.prepare({ kind: 'text', origin: 'local:sdk', command: { type: 'insert', at, text: '!' } });
    engine.commit(plan); engine.releasePlan(plan);
    assert.equal(text(engine), 'A😀B');
    assert.deepEqual(order, ['first', 'throw', 'last', 'first', 'throw', 'last']);
    assert.deepEqual(received, expected);
    assert.equal(received[0].nodes[0].node.runs[0].text, 'A😀!B');
    assert.equal(received[1].nodes[0].node.runs[0].text, 'A😀B');
    assert.notStrictEqual(received[0].update.bytes, received[1].update.bytes);
    assert.deepEqual(engine.takeObserverErrors().map(error => error.message), ['isolated', 'isolated']);
    engine.releaseAnchor(at);
  } finally { engine.dispose(); }
});

test('queued observers honor unsubscription, newly registered callbacks and disposal', () => {
  const engine = create(), calls = [];
  try {
    const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
    let nested = false, removed;
    engine.subscribe({ type: 'all' }, () => {
      calls.push('first');
      if (!nested) {
        nested = true; removed.dispose();
        engine.subscribe({ type: 'all' }, () => { calls.push('new'); engine.dispose(); });
        engine.history({ type: 'undo' });
      }
    });
    removed = engine.subscribe({ type: 'all' }, () => assert.fail('unsubscribed observer'));
    const last = engine.subscribe({ type: 'all' }, () => calls.push('last'));
    const plan = engine.prepare({ kind: 'text', origin: 'local:sdk', command: { type: 'insert', at, text: '!' } });
    engine.commit(plan);
    assert.deepEqual(calls, ['first', 'last', 'first', 'last', 'new']);
    assert.equal(last.active, false);
  } finally { engine.dispose(); }
});

test('UTF-16 commands, stable anchors, scoped patches and history use one live replica', () => {
  const engine = create();
  try {
    const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
    const updates = [], absent = [];
    const scoped = engine.subscribe({ type: 'updates' }, patch => updates.push(patch));
    const other = engine.subscribe({ type: 'nodes', ids: ['missing'] }, patch => absent.push(patch));
    const request = { kind: 'text', origin: 'local:sdk', command: { type: 'insert', at, text: '!' } };
    assert.equal(engine.can(request), true);
    assert.equal(text(engine), 'A😀B');
    const plan = engine.prepare(request);
    const result = engine.commit(plan);
    assert.ok(result.revision > 0);
    assert.equal(text(engine), 'A😀!B');
    assert.equal(engine.resolve(at).offset, 4);
    assert.equal(updates.length, 1); assert.equal(absent.length, 0);
    assert.ok(updates[0].update.bytes instanceof Uint8Array);
    assert.throws(() => engine.commit(plan), rejects('InvalidHandle', 'commit'));
    engine.releasePlan(plan);
    engine.history({ type: 'undo' }); assert.equal(text(engine), 'A😀B');
    engine.history({ type: 'redo' }); assert.equal(text(engine), 'A😀!B');
    scoped.dispose(); other.dispose(); assert.equal(scoped.active, false);
    assert.deepEqual(engine.takeObserverErrors(), []);
    engine.releaseAnchor(at);
  } finally { engine.dispose(); }
});

test('checkpoint recovery and real peer updates preserve identity and reject another epoch', () => {
  const engine = create();
  let restored;
  try {
    const checkpoint = engine.checkpoint();
    restored = runtime.restoreEngine(checkpoint.identity, checkpoint);
    const vector = restored.stateVector();
    const at = engine.anchor(engine.read().visible[0].id, 4, 'right');
    engine.commit(engine.prepare({ kind: 'text', origin: 'local:sdk', command: { type: 'insert', at, text: ' peer' } }));
    engine.releaseAnchor(at);
    const update = engine.encodeUpdate(vector);
    restored.applyUpdate(update);
    assert.equal(text(restored), 'A😀B peer');
    const before = restored.checkpoint();
    assert.throws(() => restored.applyUpdate({ identity: { ...update.identity, epoch: '82000000-0000-4000-8000-000000000999' }, bytes: update.bytes }), rejects('EngineRejected', 'applyUpdate'));
    assert.deepEqual(restored.checkpoint(), before);
    assert.throws(() => runtime.restoreEngine({ ...checkpoint.identity, epoch: '82000000-0000-4000-8000-000000000999' }, checkpoint), rejects('EngineRejected', 'restore'));
  } finally { restored?.dispose(); engine.dispose(); }
});

test('Markdown preparation and export report actual content without editing the document', () => {
  const engine = create();
  try {
    const before = engine.checkpoint();
    engine.registerMarkdown(codec);
    const prepared = engine.importMarkdown('# Task\n\n**bold** and `code`\n');
    assert.equal(prepared.blocks[0].attributes.type, 'heading');
    assert.ok(prepared.blocks[1].runs.some(r => r.marks.some(m => m.mark === 'bold')));
    const exported = engine.exportMarkdown(prepared.blocks);
    assert.match(exported.markdown, /# Task/); assert.match(exported.markdown, /\*\*bold\*\*/);
    assert.deepEqual(exported.diagnostics, []);
    assert.deepEqual(engine.checkpoint(), before);
  } finally { engine.dispose(); }
});

test('implemented error variants remain visible and disposed methods cannot report success', () => {
  const engine = create();
  try {
    const node = engine.read().visible[0].id;
    assert.throws(() => engine.anchor(node, 2, 'right'), rejects('EngineRejected', 'anchor'));
    assert.throws(() => engine.resolve('missing'), rejects('InvalidHandle'));
    assert.equal(engine.markdownAvailable,false);
    assert.throws(() => engine.importMarkdown('x'), rejects('CapabilityUnavailable','importMarkdown'));
    const subscription = engine.subscribe({ type: 'all' }, () => {});
    engine.dispose(); engine.dispose();
    assert.equal(subscription.active, false);
    for (const action of [() => engine.read(), () => engine.can({ kind: 'editor', origin: 'local:sdk', commands: [] }), () => engine.checkpoint()]) {
      assert.throws(action, rejects('Disposed'));
    }
    subscription.dispose();
  } finally { engine.dispose(); }
});

test('README examples and public error/command types compile against built declarations', async () => {
  // Place beside workspace node_modules so this uses normal package exports, not source aliases.
  const directory = await mkdtemp(new URL('../.sdk-types-', import.meta.url));
  try {
    const readme = await readFile(new URL('../packages/web/README.md', import.meta.url), 'utf8');
    const examples = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)];
    assert.equal(examples.length, 2);
    await writeFile(`${directory}/examples.mts`, `
      import type { DocumentIdentity, EngineErrorCode, EngineHandle } from '@edit-ac/core';
      import type { AttachSyncOptions, SyncAttachment } from '@edit-ac/web';
      declare const root: HTMLElement, assetUrl: string, databaseName: string, identity: DocumentIdentity;
      ${examples[0][1]}
      declare const engine: EngineHandle;
      const code: EngineErrorCode = 'Disposed';
      // @ts-expect-error unsupported public command
      engine.prepare({ kind: 'editor', origin: 'local:type', commands: [{ type: 'unsupported' }] });
      // @ts-expect-error remote settlement is not implemented by local flush
      editor.flush({ target: 'remote' });
      declare const syncOptions: AttachSyncOptions;
      const attachment: Promise<SyncAttachment> = editor.attachSync(syncOptions);
      // @ts-expect-error sync attachment requires transport, identity and authorization
      editor.attachSync({});
    `);
    await writeFile(`${directory}/history.mts`, `
      import type { EngineHandle, PlanToken, CommitResult } from '@edit-ac/core';
      declare const engine: EngineHandle, moduleProfile: string, hostWritable: boolean, container: HTMLElement;
      declare const storage: { commitPrepared(plan: PlanToken): CommitResult };
      ${examples[1][1]}
    `);
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2022,DOM', `${directory}/examples.mts`, `${directory}/history.mts`], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
