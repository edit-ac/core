import { openEditorStorage, mountEditorSurface, WebHistoryStore, HistoryReview } from '@edit-ac/web';
import { localOptions } from './document.mjs';

export const limits = Object.freeze({ maxRevisions: 3, maxBytes: 24 * 1024, maxRevisionBytes: 12 * 1024 });
export let workspace;
const element = id => document.getElementById(id);
const saveStatus = element('revision-save-status');
const captureStatus = element('revision-capture-status');
const controls = ['revision-save', 'revision-name', 'revision-capture'].map(element);
let closed = false, pending = false;
const listeners = [];
function listen(target, type, handler) { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)); }
function status(target, message, state = 'ready') { target.textContent = message; target.dataset.state = state; }
function usage() {
  const { revisions, bytes } = workspace.store.usage;
  element('revision-usage').textContent = `${revisions} / ${limits.maxRevisions} captures · ${bytes} / ${limits.maxBytes} encoded bytes`;
}
export async function save() {
  await workspace.surface.settle();
  await workspace.owner.flush({ target: 'local' });
  status(saveStatus, 'Live document saved locally. Temporary captures are not saved.');
}
export async function capture(label) {
  if (closed || pending) throw Error('Capture workspace is unavailable or busy');
  const name = label.trim();
  if (!name || name.length > 80) throw Error('Enter a capture name of 1–80 characters');
  pending = true; element('revision-capture').disabled = true;
  try {
    await workspace.surface.settle();
    const handle = await workspace.store.capture(workspace.owner.engine, workspace.access(), name);
    if (closed) return;
    workspace.review.refresh(); workspace.review.inspect(handle); usage();
    status(captureStatus, `Captured “${name}” in memory. Older captures may have been pruned.`);
    return handle;
  } finally { pending = false; if (!closed) element('revision-capture').disabled = false; }
}
export async function close() {
  if (closed) return;
  // A failed flush leaves the owner and view available for retry rather than dropping edits.
  await save();
  closed = true;
  for (const remove of listeners.splice(0)) remove();
  controls.forEach(control => { control.disabled = true; });
  workspace.review.destroy(); await workspace.surface.dispose();
  await workspace.owner.destroy({ policy: 'flush' });
}
export const ready = (async () => {
  let owner, surface, review;
  try {
    // Fetch the owned stylesheet as text: the reused fixture server serves static
    // files with a JS MIME fallback, and is intentionally left unchanged.
    const response = await fetch(new URL('./revision-review.css', import.meta.url));
    if (!response.ok) throw Error('Unable to load revision review styles');
    const style = document.createElement('style'); style.textContent = await response.text(); document.head.append(style);
    const options = await localOptions('revision-review', undefined, { text: 'Write the next version here.' });
    owner = await openEditorStorage(options);
    surface = mountEditorSurface(element('revision-editor'), owner.engine, { ...options, storageOwner: owner, label: 'Live revision document' });
    await surface.ready;
    const access = () => ({ scope: { identity: options.identity, moduleProfile: 'revision-review-task-v1' } });
    const store = new WebHistoryStore(limits);
    review = new HistoryReview(element('revision-history'), store, access, { pageSize: 3, maxValueChars: 4096 });
    workspace = { owner, surface, review, store, access, options };
    listen(element('revision-save'), 'click', () => { void save().catch(error => status(saveStatus, `Save failed: ${error.message}. Keep this page open and retry.`, 'error')); });
    listen(element('revision-capture-form'), 'submit', event => {
      event.preventDefault();
      void capture(element('revision-name').value).catch(error => status(captureStatus, `Capture failed: ${error.message}. Live content is unchanged; shorten the document or name and try again.`, 'error'));
    });
    listen(element('revision-editor'), 'input', () => status(saveStatus, 'Live changes are being journaled locally. Use Save locally to confirm.'));
    controls.forEach(control => { control.disabled = false; });
    usage(); status(saveStatus, 'Local document ready. Use Save locally to confirm saved edits.');
    return workspace;
  } catch (error) {
    review?.destroy(); await surface?.dispose(); await owner?.destroy({ policy: 'report' });
    status(saveStatus, `Unable to open revision review: ${error.message}. Reload to retry; existing local data is retained.`, 'error');
    throw error;
  }
})();
// Report initialization through the visible status without an unhandled rejection.
void ready.catch(() => {});
