import type { EngineHandle } from '@edit-ac/core';
import { EXTENSION_TRANSFER_MIME, importExtensionTransfer, type ExtensionTransferRegistry } from '@edit-ac/core/extensions';
import type { ClipboardCodec } from '../clipboard/fragment.js';
import type { ContentFactory, ContentContext } from './content.js';
import { inlineTags } from '../dom/marks.js';
import { safeLink } from '../dom/links.js';

/** Present already admitted atom fallback runs without interpreting their data.
 * Descriptor metadata and unknown module attributes stay inert. */
export function renderContentRuns(element: HTMLElement, node: ContentContext['node']): void {
  const doc = element.ownerDocument;
  element.replaceChildren();
  for (const run of node.runs) {
    const span = doc.createElement('span'); let target: HTMLElement = span;
    for (const [mark, tag] of Object.entries(inlineTags)) if (run.attributes[mark] === true) {
      const wrapper = doc.createElement(tag); target.append(wrapper); target = wrapper;
    }
    const href = safeLink(run.attributes.link, doc.baseURI);
    if (href) { const link = doc.createElement('a'); link.href = href; link.rel = 'noopener noreferrer'; target.append(link); target = link; }
    target.textContent = run.text; element.append(span);
  }
}

/** Trusted codecs prepare data only. ClipboardInput retains selection, authority,
 * atomic commit and persistence ownership, including after deferred preparation. */
export function extensionClipboardCodec(registry: ExtensionTransferRegistry, engine: EngineHandle): ClipboardCodec {
  return { mime: EXTENSION_TRANSFER_MIME, prepare(raw) {
    return registry.prepare(engine, importExtensionTransfer(raw)).blocks;
  } };
}

/** Unknown/disabled extension envelopes are readable without running their codec.
 * The complete recovery envelope stays in the owning engine content tuple. */
export const extensionSourcePresenter: ContentFactory = context => {
  const sourceOf = (node: ContentContext['node']): string | undefined => {
    const tuple = node.blockAttributes;
    if (!Array.isArray(tuple) || tuple[0] !== 'module:editac.inert-extension' || tuple[1] !== 1) return;
    const data = tuple[2];
    return data && typeof data === 'object' && !Array.isArray(data) && typeof data.source === 'string' ? data.source : undefined;
  };
  const source = sourceOf(context.node); if (source === undefined) return;
  const doc = context.element.ownerDocument, element = doc.createElement('section');
  element.dataset.contentModule = 'extension-source'; element.contentEditable = 'false';
  const status = doc.createElement('p'), input = doc.createElement('textarea');
  status.setAttribute('role', 'status'); status.textContent = 'Extension codec unavailable or unsupported; source and complete data preserved.';
  input.readOnly = true; input.setAttribute('aria-label', 'Unsupported extension source'); input.value = source;
  element.append(status, input);
  const events = ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','copy','cut','paste','pointerdown','pointerup'];
  const stop = (event: Event) => event.stopPropagation();
  const copy = (event: Event) => { const e = event as ClipboardEvent; if (e.clipboardData) { e.clipboardData.setData('text/plain', input.value.slice(input.selectionStart, input.selectionEnd)); e.preventDefault(); } };
  for (const event of events) element.addEventListener(event, stop);
  input.addEventListener('copy', copy);
  let disposed = false;
  return { element, update(node) { const value = sourceOf(node); if (disposed || value === undefined) return false; input.value = value; return true; },
    setReadOnly() { input.readOnly = true; }, dispose() { if (disposed) return; disposed = true; for (const event of events) element.removeEventListener(event, stop); input.removeEventListener('copy', copy); } };
};
