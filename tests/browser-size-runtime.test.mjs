import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

const root = resolve(process.env.EDITAC_SIZE_RUNTIME_ARTIFACTS || 'missing-size-runtime-artifacts');
const resultsRoot = resolve(process.env.EDITAC_SIZE_RUNTIME_RESULTS || root);
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
// Peer transport is test host code from the very same packed web archive.
const peerAdapter = execFileSync('tar', ['-xOf', join(root, 'edit-ac-web-0.0.0.tgz'), 'package/dist/sync/protocol.js']);
assert(!/\bimport\s/.test(peerAdapter.toString()), 'peer adapter must be self-contained');
for (const asset of manifest.assets) {
  const bytes = await readFile(join(root, 'artifacts', asset.name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
}
const facts = { profile: manifest.profile, artifacts: manifest.assets.map(a => ({ name: a.name, sha256: a.sha256 })), cases: [] };
after(async () => { await writeFile(join(resultsRoot, 'runtime-harness.json'), JSON.stringify(facts, null, 2) + '\n'); });
for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: exact minified packed ${manifest.profile} edits, rejects atomically and recovers`, { timeout: 60000 }, async () => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="editor"></div></body></html>'); return; }
        if (req.url === '/peer.js') { res.setHeader('content-type', 'text/javascript'); res.end(peerAdapter); return; }
        const path = decodeURIComponent(req.url.slice(1));
        assert(manifest.required.some(asset => asset.name === path));
        res.setHeader('content-type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(await readFile(join(root, 'artifacts', path)));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const fact = { engine: name, pid: process.pid, port: server.address().port, purpose: 'packed Task parity', workspace: process.cwd(), log: root, passed: false }; facts.cases.push(fact);
    let browser, controller;
    try {
      controller = await launcher.launchServer({ headless: true });
      fact.browser = { pid: controller.process().pid, launcher: controller.process().spawnfile };
      browser = await launcher.connect(controller.wsEndpoint());
      const page = await browser.newPage(); const requests = [], errors = [];
      fact.requests = requests; fact.errors = errors;
      page.on('request', req => requests.push(req.url())); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const evaluation = page.evaluate(async enabled => {
        const sdk = await import('/task.js');
        const assetUrl = '/wasm/editac_wasm_bg.wasm';
        const runtime = await sdk.init(assetUrl);
        const seed = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: 'alpha 😀' }, { text: 'image' }, { text: 'table' }] });
        // Prepared stored optional content must survive a default mount/recovery
        // without importing its presenter or a Markdown parser into the graph.
        const optional = [
          ['module:editac.image', 1, { url: 'https://example.com/image.png', alt: 'stored 😀', title: '', source: '![stored 😀](https://example.com/image.png)' }],
          ['module:editac.table', 1, { alignments: ['left'], rows: [[[['cell 😀', [['bold']]]]]], source: '| cell 😀 |\n| :--- |' }]
        ];
        const owners = seed.read().visible.slice(1).map(n => n.id);
        for (let index = 0; index < optional.length; index++) {
          const node = seed.read().visible.find(n => n.id === owners[index]), anchor = seed.anchor(node.id, 0, 'right'), focus = seed.anchor(node.id, node.runs[0].text.length, 'left');
          try { const plan = seed.prepare({ kind: 'fragment', origin: 'prepared-stored-content', range: { anchor, focus }, blocks: [{ attributes: { type: 'content', tuple: optional[index] }, runs: [{ text: optional[index][2].source, marks: [] }] }] }); try { seed.commit(plan); } finally { seed.releasePlan(plan); } }
          finally { seed.releaseAnchor(anchor); seed.releaseAnchor(focus); }
        }
        const stored = seed.read().visible.filter(n => String(n.blockAttributes[0]).startsWith('module:')).map(n => n.blockAttributes);
        // Exercise retained engine boundaries on this exact packed artifact before mounting.
        const first = seed.read().visible[0], atEnd = seed.anchor(first.id, 8, 'right');
        const commit = request => { const plan = seed.prepare(request); try { return seed.commit(plan); } finally { seed.releasePlan(plan); } };
        seed.history({ type: 'clear' }); seed.history({ type: 'explicit' });
        commit({ kind: 'editor', origin: 'local:packed-unicode', commands: [{ type: 'insert', at: atEnd, text: ' 👩‍💻 é العربية' }] });
        const unicode = seed.read().visible[0].runs.map(r => r.text).join(''), resolved = seed.resolve(atEnd);
        seed.history({ type: 'undo' }); const undone = seed.read().visible[0].runs.map(r => r.text).join('');
        seed.history({ type: 'redo' }); const redone = seed.read().visible[0].runs.map(r => r.text).join('');
        seed.history({ type: 'undo' }); seed.releaseAnchor(atEnd);
        const splitAt = seed.anchor(first.id, 6, 'right');
        commit({ kind: 'editor', origin: 'local:packed-split', commands: [{ type: 'split', owner: first.id, at: splitAt }] });
        seed.releaseAnchor(splitAt); const split = seed.read().visible.filter(n => n.kind === 'block');
        commit({ kind: 'editor', origin: 'local:packed-join', commands: [{ type: 'join', first: split[0].id, second: split[1].id }] });
        const joined = seed.read().visible[0].runs.map(r => r.text).join('');
        const identity = seed.read().identity, store = await sdk.CheckpointStorage.open(indexedDB, 'minified-task');
        await store.publish(seed.checkpoint(), []); store.close(); seed.dispose();
        const extra = enabled ? { markdown: sdk.markdownExtension(await sdk.initMarkdown('/wasm/editac_markdown_wasm_bg.wasm')) } : {};
        const options = { identity, assetUrl, databaseName: 'minified-task', indexedDB, locks: navigator.locks, ...sdk.taskPreset({ plainPasteControl: false }), ...extra };
        const host = document.querySelector('#editor'); let editor = sdk.createEditor(host, options); await editor.ready;
        const phases = [];
        const capture = async stage => {
          const projection = editor.read();
          const native = document.getSelection(), element = native?.anchorNode?.nodeType === Node.ELEMENT_NODE ? native.anchorNode : native?.anchorNode?.parentElement;
          const selection = { owner: element?.closest('[data-node-id]')?.dataset.nodeId, offset: native?.anchorOffset };
          await editor.flush({ target: 'local' });
          const checkpoint = editor.recoveryExport().checkpoint;
          phases.push({ stage, projection, selection, checkpoint: { ...checkpoint, bytes: Array.from(checkpoint.bytes) } });
        };
        const node = editor.read().visible[0], at = editor.anchor(node.id, 0);
        const invalid = editor.chain().command({ type: 'insert', at, text: 'BAD' }).command({ type: 'setParagraph', owner: 'absent-node' });
        const rejected = !invalid.can(), unchanged = editor.read().visible[0].runs.map(r => r.text).join('');
        editor.chain().command({ type: 'insert', at, text: 'prefix ' }).run(); editor.releaseAnchor(at);
        const editable = host.matches('[contenteditable="true"]') ? host : host.querySelector('[contenteditable="true"]');
        const walk = document.createTreeWalker(editable.querySelector(`[data-node-id="${node.id}"]`), NodeFilter.SHOW_TEXT); let textNode, next;
        while ((next = walk.nextNode())) textNode = next;
        document.getSelection().setBaseAndExtent(textNode, textNode.length, textNode, textNode.length);
        const data = new DataTransfer(); data.setData('text/plain', '**literal**');
        if (enabled) data.setData('text/markdown', '**literal**');
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: data }); editable.dispatchEvent(paste);
        editable.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste' }));
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        await editor.flush({ target: 'local' });
        const literal = editor.read();
        await capture('literal-paste');
        const html = '<b>B</b><i>I</i><s>S</s><u>U</u><code>C</code><a href="https://例え.テスト/道">L</a><a href="javascript:window.pwned=1">G</a><script>window.pwned=1</script>';
        const htmlOutcome = editor.paste({ getData: mime => mime === 'text/html' ? html : '' });
        const rich = editor.read().visible[0];
        await capture('html-paste');
        // Copy and replace the first rich paragraph through the real internal codec.
        const firstBlock = editable.querySelector(`[data-node-id="${rich.id}"]`), texts = [];
        const richWalk = document.createTreeWalker(firstBlock, NodeFilter.SHOW_TEXT);
        for (let n = richWalk.nextNode(); n; n = richWalk.nextNode()) texts.push(n);
        document.getSelection().setBaseAndExtent(texts[0], 0, texts.at(-1), texts.at(-1).length);
        const copied = new DataTransfer(), copy = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copy, 'clipboardData', { value: copied }); editable.dispatchEvent(copy);
        const internal = copied.getData('application/x-edit-ac-fragment+json');
        const internalOutcome = editor.paste(copied);
        const pasted = editor.read(), pwned = window.pwned ?? null;
        await capture('internal-replacement');
        // Empty-run and zero-run placeholders must retain structural caret ownership.
        editable.focus();
        const endWalk = document.createTreeWalker(editable.querySelector(`[data-node-id="${pasted.visible[0].id}"]`), NodeFilter.SHOW_TEXT);
        let end; for (let n = endWalk.nextNode(); n; n = endWalk.nextNode()) end = n;
        document.getSelection().setBaseAndExtent(end, end.length, end, end.length);
        await capture('before-enter');
        window.packedKeyboardReady = 1;
        await new Promise(resolve => { window.resumePackedKeyboard = resolve; });
        const splitState = editor.read(), selection = document.getSelection();
        const selectedElement = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode.parentElement;
        const splitCaret = selectedElement.closest('[data-node-id]')?.dataset.nodeId;
        const emptyOwner = splitState.visible.filter(n => n.kind === 'block')[1];
        const splitEmpty = emptyOwner.runs.every(r => r.text === '') && splitCaret === emptyOwner.id && selection.anchorOffset === 0;
        await capture('after-enter');
        window.packedKeyboardReady = 2;
        await new Promise(resolve => { window.resumePackedKeyboard = resolve; });
        await editor.flush({ target: 'local' });
        await capture('after-backspace');
        // A real direct protocol peer attaches to the existing durable replica.
        const { DirectSyncAdapter } = await import('/peer.js');
        const peer = runtime.restoreEngine(identity, editor.recoveryExport().checkpoint);
        await capture('before-peer');
        const adapter = new DirectSyncAdapter(peer, identity), replies = [];
        const peerNode = peer.read().visible[0], peerAt = peer.anchor(peerNode.id, 0, 'right');
        const plan = peer.prepare({ kind: 'editor', origin: 'local:prepared-peer', commands: [{ type: 'insert', at: peerAt, text: 'remote ' }] });
        try { peer.commit(plan); } finally { peer.releasePlan(plan); peer.releaseAnchor(peerAt); }
        const attachment = await editor.attachSync({ authorized: true, peerIdentity: identity, transport: { send(frame) { const result = adapter.receive(frame); if (result.reply) replies.push(result.reply); return true; } } });
        attachment.receive(adapter.step1());
        for (let i = 0; i < 12; i++) { await attachment.pump(i); while (replies.length) attachment.receive(replies.shift()); }
        await editor.flush({ target: 'local' });
        const localAt = editor.anchor(editor.read().visible[0].id, 0);
        try { editor.chain().command({ type: 'insert', at: localAt, text: 'local ' }).run(); } finally { editor.releaseAnchor(localAt); }
        await editor.flush({ target: 'local' });
        for (let i = 12; i < 24; i++) { await attachment.pump(i); while (replies.length) attachment.receive(replies.shift()); }
        await editor.flush({ target: 'local' });
        const remote = peer.read(); attachment.detach(); peer.dispose();
        const before = editor.read(), close = await editor.destroy({ policy: 'flush' });
        editor = sdk.createEditor(host, options); await editor.ready; const recovered = editor.read();
        let parser;
        if (enabled) { const codec = await sdk.initMarkdown('/wasm/editac_markdown_wasm_bg.wasm'); const prepared = codec.importMarkdown('**bold 😀**'); parser = codec.exportMarkdown(prepared.blocks).markdown; }
        await editor.destroy({ policy: 'flush' });
        return { rejected, unchanged, stored, unicode, resolved, undone, redone, joined, literal, htmlOutcome, rich, internal, internalOutcome, pwned, splitEmpty, pasted, remote, before, recovered, close, parser, phases };
      }, manifest.profile === 'markdown-enabled-task');
      for (const [stage, key] of [[1, 'Enter'], [2, 'Backspace']]) {
        await Promise.race([page.waitForFunction(stage => window.packedKeyboardReady === stage, stage), evaluation.then(() => { throw Error('Fixture finished before keyboard stage'); })]);
        await page.keyboard.press(key); await page.evaluate(() => window.resumePackedKeyboard());
      }
      const result = await evaluation;
      await writeFile(join(resultsRoot, `${name}-runtime-result.json`), JSON.stringify(result, null, 2));
      assert.equal(result.rejected, true); assert.equal(result.unchanged, 'alpha 😀');
      assert.equal(result.literal.visible[0].runs.map(r => r.text).join(''), manifest.profile === 'default-task' ? 'prefix alpha 😀**literal**' : 'prefix alpha 😀literal');
      if (manifest.profile !== 'default-task') assert(result.literal.visible[0].runs.some(run => run.attributes.bold === true));
      assert.equal(result.unicode, 'alpha 😀 👩‍💻 é العربية'); assert.equal(result.undone, 'alpha 😀'); assert.equal(result.redone, result.unicode);
      assert.equal(result.resolved.type, 'position'); assert.equal(result.resolved.offset, result.unicode.length); assert.equal(result.joined, 'alpha 😀');
      assert.equal(result.splitEmpty, true, 'Enter must place its caret on the new empty block');
      assert.equal(result.htmlOutcome.disposition, 'committed'); assert.equal(result.internalOutcome.disposition, 'committed');
      assert(JSON.parse(result.internal).blocks.length > 0); assert.equal(result.pwned, null);
      for (const mark of ['bold', 'italic', 'strike', 'underline', 'code']) assert(result.rich.runs.some(r => r.attributes[mark] === true));
      assert(result.rich.runs.some(r => String(r.attributes.link).startsWith('https://xn--')));
      assert(!result.rich.runs.some(r => String(r.attributes.link).includes('javascript:')));
      // CRDT source boundaries may coalesce when internal semantic fragments are replaced.
      const semanticRuns = runs => runs.reduce((out, run) => {
        const prior = out.at(-1);
        if (prior && JSON.stringify(prior.attributes) === JSON.stringify(run.attributes)) prior.text += run.text;
        else out.push({ text: run.text, attributes: run.attributes });
        return out;
      }, []);
      assert.deepEqual(semanticRuns(result.pasted.visible[0].runs), semanticRuns(result.rich.runs));
      const expectedBody = (manifest.profile === 'default-task' ? 'prefix alpha 😀**literal**' : 'prefix alpha 😀literal') + 'BISUCLG';
      assert.equal(result.rich.runs.map(r => r.text).join(''), expectedBody, 'HTML paste must retain the complete preceding Markdown/literal body');
      for (const stage of ['after-enter', 'after-backspace', 'before-peer']) {
        const phase = result.phases.find(phase => phase.stage === stage);
        assert.equal(phase.projection.visible[0].runs.map(r => r.text).join(''), expectedBody, `${stage} must preserve rich body order`);
        assert.deepEqual(semanticRuns(phase.projection.visible[0].runs), semanticRuns(result.pasted.visible[0].runs));
      }
      assert.deepEqual(result.before.visible, result.remote.visible);
      assert.equal(result.before.visible[0].runs.map(r => r.text).join(''), 'local remote ' + result.pasted.visible[0].runs.map(r => r.text).join(''));
      assert.deepEqual(result.recovered.visible.filter(n => String(n.blockAttributes[0]).startsWith('module:')).map(n => n.blockAttributes), result.stored);
      assert.equal(result.stored.length, 2);
      assert(!requests.some(url => url.includes('example.com/image.png')), 'disabled stored image must never fetch');
      assert.deepEqual(result.recovered.visible.filter(node => String(node.blockAttributes[0]).startsWith('module:')).map(node => node.blockAttributes[0]), ['module:editac.image', 'module:editac.table']);
      assert.deepEqual(result.before.visible, result.recovered.visible); assert.deepEqual(result.before.identity, result.recovered.identity);
      assert.equal(result.close.unsaved, false); assert.deepEqual(errors, []);
      if (manifest.profile === 'default-task') assert(!requests.some(url => url.includes('markdown')));
      else assert.match(result.parser, /bold 😀/);
      fact.requests = requests; fact.passed = true;
    } finally {
      try { await browser?.close(); } finally { try { await controller?.close(); } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fact.cleanup = { browserExited: !controller || controller.process().exitCode !== null || controller.process().signalCode !== null, serverClosed: !server.listening };
        assert.equal(fact.cleanup.browserExited, true); assert.equal(fact.cleanup.serverClosed, true);
      } }
    }
  });
}
