import { openEditorStorage, mountEditorSurface, WebHistoryStore, HistoryReview, prepareReview, ChangeReview } from '@edit-ac/web';
import { localOptions } from './document.mjs';
import { RevisionRestorer } from './revision-review-restorer.mjs';
import { reviewControls } from './revision-review-controls.mjs';

export const limits = Object.freeze({ maxRevisions: 3, maxBytes: 96 * 1024, maxRevisionBytes: 48 * 1024 });
export let workspace;
export const instances = {};
let pageDisposed = false, disposing = false, disposal;
const opening = new Set();
const pageListeners = [];
const taskRoot = document.querySelector('.workspace');
const commentRoot = taskRoot.cloneNode(true);
for (const node of commentRoot.querySelectorAll('[id]')) node.id = `comment-${node.id}`;
for (const node of commentRoot.querySelectorAll('[for], [aria-labelledby]')) {
  for (const attr of ['for', 'aria-labelledby']) if (node.hasAttribute(attr)) node.setAttribute(attr, `comment-${node.getAttribute(attr)}`);
}
commentRoot.querySelector('h2').textContent = 'Live comment';
taskRoot.before(Object.assign(document.createElement('h2'), { textContent: 'Task' }));
taskRoot.after(Object.assign(document.createElement('h2'), { textContent: 'Comment' }), commentRoot);
const stylesReady = (async () => {
  // The unchanged fixture server uses a JS MIME fallback for CSS.
  const response = await fetch(new URL('./revision-review.css', import.meta.url));
  if (!response.ok) throw Error('Unable to load revision review styles');
  const style = document.createElement('style'); style.textContent = await response.text(); document.head.append(style);
})();
async function mountInstance(name, root, prefix) {
  let workspace;
  const element = id => root.querySelector(`#${prefix}${id}`);
  const saveStatus = element('revision-save-status');
  const captureStatus = element('revision-capture-status');
  const controls = ['revision-save', 'revision-name', 'revision-capture'].map(element);
  let closed = false, closing = false, pending = false, comparison, restorer, recovery, saveFailure, retainedRecovery;
  let saving, capturing, closeWork, focus;
  function failedSave(error) {
    saveFailure = error;
    retainedRecovery = workspace.owner.recoveryExport();
    status(saveStatus, `Local save failed: ${error.message}. Keep this page open. Retry Save locally or export recovery before leaving. Nothing has been saved remotely.`, 'error');
  }
  function exportRecovery() {
    if (closed || closing) throw Error('Reopen this review before exporting recovery');
    // Preserve binary fields explicitly; JSON's default typed-array representation loses the byte contract.
    const recovery = workspace.owner.recoveryExport();
    const json = JSON.stringify(recovery, (_key, value) => value instanceof Uint8Array ? { encoding: 'bytes', data: [...value] } : value);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `revision-review-${name}-recovery.json`;
    document.body.append(link);
    try { link.click(); retainedRecovery = recovery; } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    status(element('revision-recovery-status'), 'Recovery exported for this document only. Store it safely; it includes document content. Export does not confirm a local save or remote durability.');
    return recovery;
  }
  const beforeSelect = element('revision-before'), afterSelect = element('revision-after');
  const compareStatus = element('revision-compare-status');
  function clearComparison(message, state = 'ready') {
    comparison?.destroy(); comparison = undefined;
    element('revision-close-compare').hidden = true;
    status(compareStatus, message, state);
  }
  function compare(before = beforeSelect.value, after = afterSelect.value) {
    if (closed || closing) throw Error('This review is closed; reopen and capture two states');
    clearComparison('Preparing semantic comparison…');
    try {
      if (!before || !after) throw Error('Select a before and after capture');
      for (const [label, handle] of [['Before', before], ['After', after]]) {
        const read = workspace.store.read(handle, workspace.access());
        if (read.kind !== 'available') throw Error(`${label} capture is ${read.reason}. Capture again or select an available capture`);
      }
      const model = workspace.store.compare(workspace.owner.engine, before, after, workspace.access());
      const input = { representation: 'semantic', model };
      prepareReview(input);
      comparison = new ChangeReview(element('revision-comparison'), input, { mode: 'history', layout: 'unified', limits: { pageSize: 100, maxValueChars: 1024 } });
      status(compareStatus, 'Showing semantic differences. Provenance unknown / unverified. Live document unchanged.');
      focus?.openComparison();
      return model;
    } catch (error) {
      clearComparison(`Comparison unavailable: ${error.message}. Live document unchanged.`, 'error');
      return null;
    }
  }
  function comparisonAvailability() {
    element('revision-compare').disabled = closed || closing || ![beforeSelect.value, afterSelect.value].every(handle => handle && workspace.store.read(handle, workspace.access()).kind === 'available');
  }
  function refreshComparisonChoices() {
    const list = workspace.store.list(workspace.access());
    for (const select of [beforeSelect, afterSelect]) {
      const selected = select.value;
      select.replaceChildren(new Option('Select a capture', ''));
      for (const item of list) select.add(new Option(item.label, item.handle));
      if (selected && !list.some(item => item.handle === selected)) select.add(new Option('Unavailable capture (pruned or missing)', selected));
      select.value = selected; select.disabled = list.length === 0;
    }
    comparisonAvailability();
    if (comparison && [beforeSelect.value, afterSelect.value].some(handle => workspace.store.read(handle, workspace.access()).kind !== 'available')) {
      clearComparison('A selected capture is unavailable (pruned). Select an available capture or capture again. Live document unchanged.', 'error');
    }
  }
  let resetReview;
  const listeners = [];
  function listen(target, type, handler) { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)); }
  function status(target, message, state = 'ready') {
    if (closed) return;
    // Do not turn arbitrary errors/capture names into unbounded live announcements.
    target.textContent = message.length > 640 ? message.slice(0, 640) + '…' : message; target.dataset.state = state;
  }
  function usage() {
    const { revisions, bytes } = workspace.store.usage;
    element('revision-usage').textContent = `${revisions} / ${limits.maxRevisions} captures · ${bytes} / ${limits.maxBytes} encoded bytes`;
  }
  async function save() {
    if (closed || closing) throw Error('This review is closed or closing; reopen it before saving');
    // Only an explicit Save action retries retained failed writes. Capture and
    // close retain their ordinary flush semantics and never initiate retries.
    return persist({ retryFailed: Boolean(saveFailure) });
  }
  async function persist({ retryFailed = false } = {}) {
    if (saving) return saving;
    saving = (async () => {
      try {
        await workspace.surface.settle();
        await workspace.owner.flush({ target: 'local', ...(retryFailed ? { retryFailed: true } : {}) });
        saveFailure = undefined; retainedRecovery = undefined;
        status(saveStatus, 'Live document saved locally in this browser. Temporary captures are not saved. No remote save is claimed.');
      } catch (error) { failedSave(error); throw error; }
    })();
    try { await saving; } finally { saving = undefined; }
  }
  async function capture(label) {
    if (closed || closing || pending) throw Error('Capture workspace is unavailable or busy');
    const name = label.trim();
    if (!name || name.length > 80) throw Error('Enter a capture name of 1–80 characters');
    pending = true; element('revision-capture').disabled = true;
    capturing = (async () => {
      try {
        await workspace.surface.settle();
        if (closed || closing) return;
        const handle = await workspace.store.capture(workspace.owner.engine, workspace.access(), name);
        if (closed || closing) return;
        workspace.review.refresh(); workspace.review.inspect(handle); usage(); refreshComparisonChoices();
        status(captureStatus, `Captured “${name}” in memory. Older captures may have been pruned.`);
        focus?.captured(handle);
        return handle;
      } finally { pending = false; if (!closed && !closing) element('revision-capture').disabled = false; }
    })();
    try { return await capturing; } finally { capturing = undefined; }
  }
  async function close() {
    if (closed) return;
    if (closeWork) return closeWork;
    closing = true;
    closeWork = (async () => {
      const enabled = [...root.querySelectorAll('input,button,select')].filter(control => !control.disabled);
      enabled.forEach(control => { control.disabled = true; });
      restorer.retire();
      workspace.surface.setReadOnly(true);
      let viewDisposed = false;
      try {
        await capturing?.catch(() => {});
        await persist();
        // Release view-owned anchors while its borrowed engine is still live.
        await workspace.surface.dispose(); viewDisposed = true;
        await workspace.owner.destroy({ policy: 'flush' });
      } catch (error) {
        // A rejected destroy keeps the same owner alive; restore its borrowed view.
        if (viewDisposed) {
          element('revision-editor').replaceChildren();
          workspace.surface = mountEditorSurface(element('revision-editor'), workspace.owner.engine, {
            ...workspace.options, storageOwner: workspace.owner, readOnly: workspace.readonly,
            label: `Live ${name} revision document`,
          });
          await workspace.surface.ready;
        }
        closing = false; enabled.forEach(control => { control.disabled = false; });
        workspace.surface.setReadOnly(workspace.readonly); resetReview(); focus?.restoreClosed();
        throw error;
      }
      root.dataset.lifecycle = 'closing';
      focus?.dispose();
      for (const remove of listeners.splice(0)) remove();
      root.querySelectorAll('input,button,select').forEach(control => { control.disabled = true; });
      status(saveStatus, 'Review closed. Reopen to recover saved live content; captures are memory only.');
      clearComparison('Review closed. Reopen and capture two states to compare.');
      workspace.review.destroy();
      closed = true; root.dataset.lifecycle = 'closed';
      element('revision-reopen').disabled = pageDisposed || disposing;
      if (!pageDisposed && !disposing) element('revision-reopen').focus();
    })();
    try { await closeWork; } finally { closeWork = undefined; }
  }
  return await (async () => {
    let owner, surface, review;
    try {
      await stylesReady;
      const options = await localOptions(name === 'task' ? 'revision-review' : 'revision-review-comment', undefined, { text: name === 'task' ? 'Write the next version here.' : 'Write a comment here.' });
      owner = await openEditorStorage(options);
      surface = mountEditorSurface(element('revision-editor'), owner.engine, { ...options, storageOwner: owner, label: `Live ${name} revision document` });
      await surface.ready;
      const access = () => ({ scope: { identity: options.identity, moduleProfile: `revision-review-${name}-v1` } });
      const store = new WebHistoryStore(limits);
      let readonly = false;
      function reportRestore(result) {
        if (closed || closing) return;
        const target = element('revision-restore-status');
        if (!('kind' in result)) {
          recovery = undefined; element('revision-restore-recovery').replaceChildren();
          status(target, 'Preview ready. Current content is unchanged. Confirm explicitly or cancel.');
        } else if (result.kind === 'conflict') {
          recovery = result;
          const message = result.reason === 'rejected'
            ? 'The host rejected the restore. Its current post-call state is shown below; a change may already have occurred. Check the live document and save status before retrying.'
            : `Restore conflict: ${result.reason}. Current content is retained. Inspect an available capture and preview again.`;
          status(target, message, 'error');
          // textContent preserves supplied context without interpreting source as HTML.
          element('revision-restore-recovery').textContent = JSON.stringify({ base: result.base, current: result.current, proposed: result.proposed }, null, 2);
        } else {
          recovery = undefined; element('revision-restore-recovery').replaceChildren();
          status(target, result.kind === 'applied' ? 'Restore applied as a new edit. Use Save locally to confirm local durability.' : 'No changes to restore.');
        }
      }
      function createReview() {
        restorer = new RevisionRestorer(store, {
          engine: owner.engine,
          commit: owner.commitPrepared,
          writable: () => !closed && !closing && !readonly,
        }, access, reportRestore);
        return new HistoryReview(element('revision-history'), store, access, { pageSize: 3, maxValueChars: 4096, restorer });
      }
      resetReview = () => {
        workspace.review.destroy();
        workspace.review = review = createReview();
      };
      review = createReview();
      listen(element('revision-cancel-restore'), 'click', () => {
        restorer.retire(); resetReview(); focus.restoreClosed();
        status(element('revision-restore-status'), 'Restore preview canceled. Current content is unchanged; inspect a capture to preview again.');
      });
      const updates = owner.engine.subscribe({ type: 'updates' }, () => {
        if (!saveFailure) status(saveStatus, 'Live changes are being journaled locally. Use Save locally to confirm.');
      });
      listeners.push(() => updates.dispose());
      workspace = { owner, surface, review, store, access, options, save, capture, compare, close, exportRecovery, resetReview: () => { if (!closed && !closing) resetReview(); }, get retainedRecovery() { return retainedRecovery; }, get restorer() { return restorer; }, get restoreRecovery() { return recovery; }, get closed() { return closed; }, get readonly() { return readonly; } };
      focus = reviewControls(root, prefix, () => workspace, listen, () => clearComparison('Comparison closed. Live document unchanged.'));
      beforeSelect.replaceChildren(); afterSelect.replaceChildren();
      clearComparison('Capture two states to compare them.'); refreshComparisonChoices();
      listen(element('revision-compare-form'), 'submit', event => { event.preventDefault(); compare(); });
      for (const select of [beforeSelect, afterSelect]) listen(select, 'change', () => { clearComparison('Selection changed. Choose Compare captures to inspect these states.'); comparisonAvailability(); });
      const readOnlyControl = element('revision-readonly');
      listen(readOnlyControl, 'change', () => {
        readonly = readOnlyControl.checked;
        workspace.surface.setReadOnly(readonly);
        restorer.retire('readonly'); resetReview(); focus.restoreClosed(false);
        if (!recovery) status(element('revision-restore-status'), readonly ? 'Readonly: restore is unavailable. Return to writable mode and preview again.' : 'Writable again. Inspect a capture and create a new preview.');
      });
      listen(element('revision-save'), 'click', () => { void save().catch(() => {}); });
      element('revision-export-recovery').disabled = false;
      status(element('revision-recovery-status'), 'Export recovery if local saving fails. Captures are temporary and are not included.');
      listen(element('revision-export-recovery'), 'click', () => {
        try { exportRecovery(); } catch (error) { status(element('revision-recovery-status'), `Recovery export failed: ${error.message}. Keep this page open and retry; source data is retained.`, 'error'); }
      });
      listen(element('revision-capture-form'), 'submit', event => {
        event.preventDefault();
        void capture(element('revision-name').value).catch(error => status(captureStatus, `Capture failed: ${error.message}. Live content is unchanged; shorten the document or name and try again.`, 'error'));
      });
      listen(element('revision-editor'), 'input', () => status(saveStatus, 'Live changes are being journaled locally. Use Save locally to confirm.'));
      controls.forEach(control => { control.disabled = false; });
      element('revision-name').value = '';
      status(captureStatus, 'No captures retained in this review. Reload and close lose memory-only captures. Saved live content reopens without reseeding. Capture the current state explicitly.');
      usage(); status(saveStatus, 'Local document ready. Use Save locally to confirm saved edits.');
      listen(element('revision-close'), 'click', () => { void close().catch(error => status(saveStatus, `Close failed: ${error.message}. This review is still open. Keep it open and export recovery; Retry Save locally when possible.`, 'error')); });
      return workspace;
    } catch (error) {
      review?.destroy(); await surface?.dispose(); await owner?.destroy({ policy: 'report' });
      status(saveStatus, `Unable to open revision review: ${error.message}. Reload to retry; existing local data is retained.`, 'error');
      throw error;
    }
  })();
}
export async function remount(name) {
  if (pageDisposed || disposing) throw Error('This page is disposed');
  if (!['task', 'comment'].includes(name)) throw Error('Unknown review instance');
  const old = instances[name];
  if (old && !old.closed) throw Error('Close this instance before reopening');
  const root = name === 'task' ? taskRoot : commentRoot;
  const prefix = name === 'task' ? '' : 'comment-';
  if (root.dataset.lifecycle === 'opening') throw Error('This review is already opening');
  root.dataset.lifecycle = 'opening';
  root.querySelector(`#${prefix}revision-editor`).replaceChildren();
  root.querySelector(`#${prefix}revision-readonly`).checked = false;
  root.querySelector(`#${prefix}revision-readonly`).disabled = true;
  root.querySelector(`#${prefix}revision-close`).disabled = true;
  root.querySelector(`#${prefix}revision-reopen`).disabled = true;
  const mount = mountInstance(name, root, prefix); opening.add(mount);
  try { instances[name] = await mount; }
  catch (error) { root.dataset.lifecycle = 'failed'; root.querySelector(`#${prefix}revision-reopen`).disabled = disposing || pageDisposed; throw error; }
  finally { opening.delete(mount); }
  root.querySelector(`#${prefix}revision-readonly`).disabled = false;
  root.querySelector(`#${prefix}revision-close`).disabled = false;
  root.querySelector(`#${prefix}revision-name`).focus();
  instances[name].owner.engine.read(); // Advertise readiness only while the public owner is live.
  root.dataset.lifecycle = 'ready';
  if (name === 'task') workspace = instances[name];
  return instances[name];
}
for (const [name, root, prefix] of [['task', taskRoot, ''], ['comment', commentRoot, 'comment-']]) {
  const reopen = root.querySelector(`#${prefix}revision-reopen`);
  const handler = () => { void remount(name).catch(error => {
    if (!pageDisposed) root.querySelector(`#${prefix}revision-save-status`).textContent = `Reopen failed: ${error.message.slice(0, 500)}. Retry.`;
  }); };
  reopen.addEventListener('click', handler);
  pageListeners.push(() => reopen.removeEventListener('click', handler));
}
export async function dispose() {
  if (pageDisposed) return;
  if (disposal) return disposal;
  disposing = true;
  disposal = (async () => {
    try {
      await ready.catch(() => {});
      await Promise.allSettled([...opening]);
      // A failed flush keeps recovery and listeners usable; never discard it.
      await close();
      pageDisposed = true;
      for (const remove of pageListeners.splice(0)) remove();
      for (const root of [taskRoot, commentRoot]) root.querySelectorAll('input,button,select').forEach(control => { control.disabled = true; });
    } finally {
      disposing = false;
      if (!pageDisposed) for (const [name, root, prefix] of [['task', taskRoot, ''], ['comment', commentRoot, 'comment-']]) {
        if (instances[name]?.closed) root.querySelector(`#${prefix}revision-reopen`).disabled = false;
      }
    }
  })();
  try { await disposal; } finally { disposal = undefined; }
}
export const save = () => instances.task.save();
export const capture = label => instances.task.capture(label);
export const close = async () => { for (const instance of Object.values(instances)) await instance.close(); };
export const ready = Promise.all([remount('task'), remount('comment')]).then(() => workspace);
// Report initialization through the visible status without an unhandled rejection.
void ready.catch(() => {});
