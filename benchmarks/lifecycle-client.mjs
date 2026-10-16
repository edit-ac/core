import { fixture, expectedSemantics, projectedSemantics } from './fixtures.mjs';
import { presetOptions } from './presets.mjs';
import { resourceProbe } from './resource-probe.mjs';
import * as sdk from './sdk.js';
const { createEditor, taskPreset, CheckpointStorage, init, ReferenceLookupSession } = sdk;
const assetUrl = new URL('./wasm/editac_wasm_bg.wasm', import.meta.url).href;
const check = (ok, message) => { if (!ok) throw Error(message); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
let probe, frozen, name, preset, profile, optional, markdown;
export async function setup(options) {
  ({ frozen, name, preset, profile, optional } = options);
  const initialization = { optional, before: await window.lifecycleHeap() };
  await init(assetUrl);
  if (optional === 'markdown') markdown = sdk.markdownExtension(await sdk.initMarkdown(new URL('./wasm/editac_markdown_wasm_bg.wasm', import.meta.url).href));
  initialization.after = await window.lifecycleHeap();
  initialization.enabled = !!markdown;
  probe = resourceProbe();
  const before = probe.snapshot(), target = new EventTarget(), fn = () => {};
  target.addEventListener('probe', fn);
  const observer = new MutationObserver(() => {}); observer.observe(document.body, { childList: true });
  const url = URL.createObjectURL(new Blob(['onmessage=()=>{}'], { type: 'text/javascript' }));
  const worker = new Worker(url), timer = setInterval(() => {}, 5), frame = requestAnimationFrame(() => {});
  const active = probe.snapshot(); cancelAnimationFrame(frame); await probe.wait(30);
  const polling = probe.snapshot(); clearInterval(timer); worker.terminate(); URL.revokeObjectURL(url); observer.disconnect(); target.removeEventListener('probe', fn);
  return { before, active, polling, drained: probe.snapshot(), initialization };
}
export async function cycle(index) {
  const root = document.querySelector('#editor'), databaseName = `prf05-${crypto.randomUUID()}`;
  root.replaceChildren();
  const storage = await CheckpointStorage.open(indexedDB, databaseName);
  try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); } finally { storage.close(); }
  let editor, lookup, job; const transfer = deferred(), hostJob = deferred(), hostListeners = new Set();
  const result = { index, samples: {}, phases: [], liveMemory: [] };
  // Host CDP snapshots do not collect garbage here. Await outside measured
  // mount/cancel/dispose spans; these are phase samples, not true peaks.
  const heap = async phase => result.liveMemory.push({ phase, ...await window.lifecycleHeap() });
  const sample = phase => result.phases.push({ phase, at: performance.now(), ...probe.snapshot(), hostListeners: hostListeners.size });
  try {
    await heap('before-mount'); const start = performance.now();
    editor = createEditor(root, { databaseName, identity: frozen.identity, indexedDB, locks: navigator.locks,
      assetUrl, ...presetOptions(preset, { taskPreset }), ...(markdown ? { markdown } : {}) });
    await editor.ready; result.samples.mountMs = performance.now() - start;
    await heap('mounted');
    const initial = JSON.stringify(projectedSemantics(editor.read()));
    check(initial === JSON.stringify(expectedSemantics(fixture(name))), 'Full initial corpus mismatch');
    result.initialPreserved = true;
    // A positive clipboard control proves the canceled job has a real live target.
    function select() {
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let text;
      while ((text = walker.nextNode())) if (text.parentElement.closest('[data-node-id]') && text.length && /[A-Za-z]/.test(text.data) && !text.parentElement.closest('[contenteditable=false]')) break;
      check(text, 'No live DOM paste target'); const range = document.createRange(); const offset = text.data.search(/[A-Za-z]/); range.setStart(text, offset); range.setEnd(text, offset + 1);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    }
    select(); const control = editor.pasteDeferred({ getData: mime => mime === 'text/plain' ? 'Z' : '' }, { literal: true, schedule: () => Promise.resolve() });
    const positive = await control.result; check(positive.disposition === 'committed', `Clipboard positive control: ${JSON.stringify(positive)}`);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }));
    check(JSON.stringify(projectedSemantics(editor.read())) === initial, 'Clipboard control undo changed corpus');
    if (markdown) {
      // Exercise the installed parser through the actual editor clipboard port,
      // then restore the complete corpus before cancellation/disposal.
      // Replace one ASCII byte: the full Long corpus already meets its limit.
      select();
      const rich = await editor.pasteDeferred({ getData: mime => mime === 'text/markdown' || mime === 'text/plain' ? '**Z**' : '' }, { schedule: () => Promise.resolve() }).result;
      check(rich.disposition === 'committed', 'Enabled Markdown paste did not commit');
      const blocks = projectedSemantics(editor.read());
      const bold = blocks.some(block => block.runs.some(run => run.text.includes('Z') && run.attributes.bold === true));
      check(bold, 'Enabled Markdown rich parser was bypassed');
      result.markdown = { committed: true, bold: true, export: markdown.codec.exportMarkdown(markdown.codec.importMarkdown('**PRF05 😀**').blocks).markdown };
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }));
      check(JSON.stringify(projectedSemantics(editor.read())) === initial, 'Markdown undo changed corpus');
      result.markdown.restored = true;
    }
    await editor.flush({ target: 'local' }); select();
    const source = `PRF05 canceled source ${index}`;
    job = editor.pasteDeferred({ getData: mime => mime === 'text/plain' ? source : '' }, { literal: true, schedule: () => transfer.promise });
    const host = { version: 1, permission: () => ({ revision: 'p1', lookup: true, insert: true }), catalog: targetId => ({ targetId, status: 'cached' }),
      subscribe(fn) { hostListeners.add(fn); return { dispose() { hostListeners.delete(fn); } }; },
      resolve(request) { result.requestAborted = () => request.signal.aborted; return hostJob.promise; } };
    lookup = new ReferenceLookupSession(host, () => {}, { context: () => ({ document: 'prf05', session: databaseName, revision: '1', permission: 'p1', authorized: true }) });
    const search = lookup.search({ query: 'prepared', requestId: index, signal: new AbortController().signal });
    await Promise.resolve(); sample('active-transfer'); await heap('active-transfer');
    const cancelStart = performance.now(); job.cancel(); const canceled = await job.result; lookup.dispose();
    const stopped = await search; result.samples.cancelMs = performance.now() - cancelStart;
    result.cancellation = { state: job.state, reason: canceled.reason, disposition: canceled.disposition, results: stopped.length, aborted: result.requestAborted(), source: job.source['text/plain'] === source,
      recovery: editor.clipboardRecovery.some(r => r.mime === 'text/plain' && r.raw === source && r.reason === 'clipboard-canceled'), control: positive.disposition };
    delete result.requestAborted; sample('feature-unloaded'); await heap('feature-unloaded');
    const disposeStart = performance.now(), closed = await editor.destroy({ policy: 'flush' }); result.samples.disposeMs = performance.now() - disposeStart;
    result.unsaved = closed.unsaved; result.destroyRecovery = closed.clipboard.some(r => r.raw === source); sample('disposed'); await heap('disposed');
    const before = root.innerHTML; transfer.resolve(); hostJob.resolve([{ targetId: 'late', label: 'late result' }]);
    for (let i = 0; i < 16; i++) await Promise.resolve(); await probe.frame(); await probe.frame();
    result.noLateDOMMutation = before === root.innerHTML;
    // Reopen acknowledged storage to reject late semantic mutation after teardown.
    editor = createEditor(root, { databaseName, identity: frozen.identity, indexedDB, locks: navigator.locks,
      assetUrl, ...presetOptions(preset, { taskPreset }), ...(markdown ? { markdown } : {}) });
    await editor.ready; result.reopenedPreserved = JSON.stringify(projectedSemantics(editor.read())) === initial;
    await heap('reopened');
    const reopenedClose = await editor.destroy({ policy: 'flush' }); result.unsaved ||= reopenedClose.unsaved;
  } finally {
    job?.cancel(); lookup?.dispose(); transfer.resolve(); hostJob.resolve([]);
    if (editor) await editor.destroy({ policy: 'flush' });
    document.getSelection()?.removeAllRanges(); root.replaceChildren();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Database deletion blocked')); });
    result.databaseDeleted = true;
  }
  await probe.frame(); await probe.frame(); sample('drained'); await heap('drained');
  const beforeIdle = probe.snapshot(); await probe.wait(profile.idleMs); const afterIdle = probe.snapshot();
  result.idle = { durationMs: profile.idleMs, before: beforeIdle, after: afterIdle };
  return result;
}
export function resources() { return probe.snapshot(); }
